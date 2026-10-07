// docs/architecture.md is a view of LEDGER.md that captures the module layout,
// the final-check pipeline and the test layers for contributors and AI agents.
// These tests pin its view conventions so it cannot drift from the ledger or reference
// paths that no longer exist.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { citedRecords, headingAnchors, ledgerStates, withoutComments } from '../helpers/docs.ts'
import { readRepoFile, repoRoot } from '../helpers/files.ts'

const architecture = readRepoFile('docs', 'architecture.md')
const prose = withoutComments(architecture)

describe('docs/architecture.md (a view of LEDGER.md)', () => {
  it('keeps record IDs in HTML comments only, cites only live records, and ends with the view footer', () => {
    expect(prose).not.toMatch(/\b[ADCQ]\d+\b/)
    const states = ledgerStates()
    const cited = citedRecords(architecture)
    expect(cited.size).toBeGreaterThan(0)
    for (const id of cited) {
      expect(['active', 'verified', 'open', 'answered'], id).toContain(states.get(id))
    }
    expect(architecture.trimEnd()).toMatch(/\n---\n\nView on LEDGER\.md, \d{4}-\d{2}-\d{2}$/)
  })

  it('every Markdown link points at a file that exists, and anchors resolve to a heading', () => {
    const links = Array.from(prose.matchAll(/\]\(([^)]+)\)/g), (m) => m[1] ?? '').filter(
      (target) => !/^[a-z]+:/.test(target),
    )
    for (const link of links) {
      const [path = '', fragment] = link.split('#')
      const file = path === '' ? 'docs/architecture.md' : path
      expect(existsSync(join(repoRoot, file)), link).toBe(true)
      if (fragment !== undefined)
        expect(headingAnchors(readRepoFile(file)), link).toContain(fragment)
    }
  })

  it('every backtick path it names exists in the repository', () => {
    // Extract paths rooted in a known top-level directory that have a file extension.
    const paths = Array.from(
      prose.matchAll(/`((?:src|test|example|docs|scripts)\/[^`]+\.[a-zA-Z]+)`/g),
      (m) => m[1] ?? '',
    )
    expect(paths.length).toBeGreaterThan(0)
    for (const p of paths) {
      expect(existsSync(join(repoRoot, p)), p).toBe(true)
    }
  })

  it('README.md links to docs/architecture.md from the Development section', () => {
    const readme = readRepoFile('README.md')
    expect(withoutComments(readme)).toContain('[docs/architecture.md](docs/architecture.md)')
  })

  it('D158: names every module file under src/ in a backtick path', () => {
    const files = (dir: string): string[] =>
      readdirSync(join(repoRoot, dir), { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? files(`${dir}/${entry.name}`)
          : entry.name.endsWith('.ts')
            ? [`${dir}/${entry.name}`]
            : [],
      )
    for (const file of files('src')) {
      expect(prose, file).toContain(`\`${file}\``)
    }
  })

  it('D103: the test-layer table names the MySQL attack suite and end to end', () => {
    expect(prose).toContain('pnpm test:integration:mysql')
    expect(prose).toContain('MYSQL_IMAGE')
    expect(prose).toContain('E2E_MYSQL_DATABASE_URL')
  })

  it('D104, D114, D142: analyze.ts and build.ts are described as dialect dispatch, not as owning the rules', () => {
    const row = (file: string): string =>
      architecture.split('\n').find((line) => line.startsWith(`| \`${file}\` |`)) ?? ''
    expect(row('src/analyze.ts')).toContain('annotation parsing')
    expect(row('src/analyze.ts')).toContain('through the dialect')
    expect(row('src/analyze.ts')).not.toContain('schema-conflict checks')
    expect(row('src/build.ts')).toContain('the dialect')
    expect(row('src/build.ts')).not.toContain('the three renderers')
    expect(row('src/build.ts')).toContain('unknown provider')
  })

  it('D165, D166, D168, D155: the MySQL apply section describes the marker source, could-not-run refusals and grant-table reads', () => {
    const apply = architecture.slice(architecture.indexOf('## The MySQL apply script'))
    for (const phrase of [
      'marker view records the source database',
      'names another source database',
      'sets the abort message to a "could not run" refusal',
      '`*_priv` columns of `mysql.user`',
      'a failing state-changing statement',
      '`--force`',
    ]) {
      expect(apply, phrase).toContain(phrase)
    }
    const cited = citedRecords(architecture)
    for (const id of ['D165', 'D166', 'D168', 'D167']) expect(cited.has(id), id).toBe(true)
  })

  it('D143: the final-check section names FINAL_CHECKS in src/render/final-checks.ts', () => {
    expect(prose).toContain('`FINAL_CHECKS`')
    expect(prose).not.toContain('renderFinalCheck()` in `src/render/apply-sql.ts`')
  })
})
