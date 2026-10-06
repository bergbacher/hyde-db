// docs/architecture.md is a view of LEDGER.md that captures the module layout,
// the final-check pipeline and the test layers for contributors and AI agents.
// These tests pin its view conventions so it cannot drift from the ledger or reference
// paths that no longer exist.
import { existsSync } from 'node:fs'
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
})
