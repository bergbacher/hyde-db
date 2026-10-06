// Dependency-free checks of the workflow files (no YAML parser): the text is the contract.
import { describe, expect, it } from 'vitest'
import { readRepoFile } from '../helpers/files.ts'

const ci = readRepoFile('.github', 'workflows', 'ci.yml')
const release = readRepoFile('.github', 'workflows', 'release.yml')
const version = readRepoFile('.github', 'workflows', 'version.yml')
const dependabot = readRepoFile('.github', 'dependabot.yml')

/** The text of one top-level job, from its key to the next job or the end. */
function job(workflow: string, name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`)
  if (start < 0) throw new Error(`no job ${name}`)
  const rest = workflow.slice(start + 1)
  const next = rest.slice(1).search(/\n {2}[a-z0-9-]+:\n/)
  return next < 0 ? rest : rest.slice(0, next + 1)
}

describe('CI workflow', () => {
  it('D38, D62: runs on pull requests and branch pushes, never on tags, with read-only permissions', () => {
    expect(ci).toContain("on:\n  pull_request:\n  push:\n    branches: ['**']\n")
    expect(ci).not.toMatch(/^\s+tags:/m)
    expect(ci).toContain('permissions:\n  contents: read\n')
  })

  it('D63: never publishes and holds no publishing credentials', () => {
    expect(ci).not.toMatch(
      /npm publish|pnpm publish|--provenance|id-token|NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./,
    )
  })

  it('D38: lint, type check, build, tests with coverage, attack suite and end-to-end all run', () => {
    for (const command of [
      'pnpm lint',
      'pnpm typecheck',
      'node scripts/pack-e2e.mjs',
      'pnpm test:coverage',
      'pnpm test:integration',
      'node --test --test-timeout=600000 test/e2e/*.test.mjs',
    ]) {
      expect(ci).toContain(command)
    }
  })

  it('D38: unit, characterization and contract tests run on Node 22 and 24', () => {
    expect(job(ci, 'test')).toContain('node: [22, 24]')
  })

  it('D21, D22: the attack suite runs on PostgreSQL 14 and 18 on a runner with Docker', () => {
    const attack = job(ci, 'attack')
    expect(attack).toContain('pg: [14, 18]')
    expect(attack).toMatch(/PG_IMAGE: postgres:\$\{\{ matrix\.pg \}\}-alpine/)
    expect(attack).toContain('runs-on: ubuntu-latest')
  })

  it('D30, D37: end-to-end runs on Prisma 6 and 7 under Node 20 and 24 against postgres:18-alpine', () => {
    const e2e = job(ci, 'e2e')
    expect(e2e).toContain("prisma: ['6.19.3', '7.10.0']")
    expect(e2e).toContain('node: [20, 24]')
    expect(e2e).toContain('image: postgres:18-alpine')
    expect(e2e).toContain('E2E_DATABASE_URL: postgresql://')
    expect(e2e).toContain('E2E_TARBALL=')
    expect(e2e).toContain('timeout-minutes:')
  })

  it('D37: Node 20 never builds; the tarball is built and packed once on Node 24', () => {
    const e2e = job(ci, 'e2e')
    expect(e2e).not.toMatch(/pnpm |pack-e2e|node-version: 24/)
    expect(e2e).toContain('actions/download-artifact@')
    const build = job(ci, 'build')
    expect(build).toContain('node-version: 24')
    expect(build).toContain('actions/upload-artifact@')
    expect(build).toContain('node scripts/pack-e2e.mjs')
    expect(ci).toContain('needs: build')
  })

  it('D38: every job runs on Node 24 unless it is a version matrix', () => {
    for (const name of ['lint', 'typecheck', 'build', 'attack']) {
      expect(job(ci, name)).toContain('node-version: 24')
    }
  })

  it('D38: one aggregate job fails unless every other job succeeded', () => {
    expect(ci).toContain('needs: [lint, typecheck, build, test, attack, e2e]')
    expect(ci).toContain("contains(needs.*.result, 'failure')")
    expect(ci).toContain("contains(needs.*.result, 'skipped')")
    const declared = [...ci.slice(ci.indexOf('\njobs:\n')).matchAll(/^ {2}([a-z0-9-]+):\n/gm)].map(
      (m) => m[1],
    )
    expect(declared.filter((n) => n !== 'ci-ok').sort()).toEqual([
      'attack',
      'build',
      'e2e',
      'lint',
      'test',
      'typecheck',
    ])
  })
})

describe('Dependabot', () => {
  it('D42: opens weekly updates for npm and GitHub Actions', () => {
    expect(dependabot).toContain('package-ecosystem: npm')
    expect(dependabot).toContain('package-ecosystem: github-actions')
    expect(dependabot.match(/interval: weekly/g)).toHaveLength(2)
  })
})

describe('release workflow', () => {
  it('D62, D63: triggers only on a push of a v*.*.* tag', () => {
    expect(release).toContain("on:\n  push:\n    tags: ['v*.*.*']\n")
    for (const trigger of [
      'branches:',
      'pull_request',
      'workflow_dispatch',
      'schedule:',
      'workflow_run',
    ]) {
      expect(release).not.toContain(trigger)
    }
  })

  it('D63: fails unless the tag equals the package version and the commit is on main', () => {
    expect(release).toContain(`\${GITHUB_REF_NAME#v}`)
    expect(release).toContain("require('./package.json').version")
    expect(release).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/main')
    expect(release).toContain('fetch-depth: 0')
  })

  it('D63: runs the gate that needs no Docker, then packs and publishes the tarball with provenance', () => {
    for (const command of [
      'pnpm lint',
      'pnpm typecheck',
      'pnpm test:coverage',
      'pnpm build',
      'pnpm pack',
    ]) {
      expect(release).toContain(`- run: ${command}`)
    }
    expect(release).not.toMatch(/test:integration|test:e2e|docker/)
    expect(release).toContain('actions/upload-artifact@')
    expect(release).toContain('--provenance --access public')
    expect(release).not.toContain('continue-on-error')
  })

  it('D63, A27: publishes through OIDC on Node 24 with the token only on the publish step', () => {
    expect(release).toContain('id-token: write')
    expect(release.match(/id-token: write/g)).toHaveLength(1)
    expect(release).toContain('node-version: 24')
    expect(release).toContain(`NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}`)
    expect(release.match(/secrets\./g)).toHaveLength(1)
    expect(release.slice(0, release.indexOf('  publish:\n'))).not.toContain('NPM_TOKEN')
  })
})

describe('version workflow', () => {
  it('D63: opens the version pull request on main and never builds, packs or publishes', () => {
    expect(version).toContain('on:\n  push:\n    branches: [main]\n')
    expect(version).toContain('uses: changesets/action/version@v2')
    expect(version).toContain('contents: write')
    expect(version).toContain('pull-requests: write')
    expect(version.replace(/#.*$/gm, '')).not.toMatch(
      /publish|pack|build|id-token|NPM_TOKEN|provenance/,
    )
  })
})
