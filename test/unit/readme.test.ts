// README.md is a view of LEDGER.md. These tests pin its claims to the code so the two cannot
// drift: every diagnostic code with its severity, the config defaults, the generator blocks
// (parsed by Prisma's own schema engine), the quick start's summary line, the deploy commands the
// attack suite and the end-to-end layer run (D43), and the view conventions (IDs in comments,
// footer, only live records cited).
import { describe, expect, it } from 'vitest'
import { build } from '../../src/build.ts'
import { CONFIG_KEYS, DEFAULT_CONFIG, validateConfig } from '../../src/config.ts'
import {
  DIAGNOSTIC_CODES,
  formatDiagnostic,
  formatReport,
  SEVERITY,
  sensitiveExplicit,
  strictUnannotated,
} from '../../src/diagnostics.ts'
import { isSensitiveName } from '../../src/sensitive.ts'
import type { ResolvedConfig } from '../../src/types.ts'
import { readRepoFile } from '../helpers/files.ts'
import { type PrismaMajor, parseSchema } from '../helpers/prisma.ts'

const readme = readRepoFile('README.md')
/** The README without HTML comments, which is where record IDs live. */
const prose = readme.replace(/<!--[\s\S]*?-->/g, '')
const applySql = readRepoFile('example', 'redacted', 'redacted-views.sql')

/** Bodies of the fenced code blocks with the given info string, in order. */
function codeBlocks(text: string, language: string): string[] {
  const fence = new RegExp(`\`\`\`${language}\\n([\\s\\S]*?)\`\`\``, 'g')
  return Array.from(text.matchAll(fence), (match) => match[1] ?? '')
}

/** A `## heading` section, up to the next `## ` heading. */
function section(heading: string): string {
  const start = readme.indexOf(`\n## ${heading}\n`)
  if (start === -1) throw new Error(`README has no "## ${heading}" section`)
  const end = readme.indexOf('\n## ', start + 1)
  return readme.slice(start, end === -1 ? undefined : end)
}

const DATASOURCE = 'datasource db {\n  provider = "postgresql"\n}\n'
const MAJORS: readonly PrismaMajor[] = [6, 7]
const generatorBlocks = codeBlocks(readme, 'prisma').filter((block) =>
  block.startsWith('generator redacted {'),
)

/** Record ID → state, from the records table of LEDGER.md (escaped pipes stay inside a cell). */
function ledgerStates(): Map<string, string> {
  const states = new Map<string, string>()
  for (const line of readRepoFile('LEDGER.md').split('\n')) {
    const cells = line.split(/(?<!\\)\|/).map((cell) => cell.trim())
    const id = cells[1]
    if (id !== undefined && /^[ADCQ]\d+$/.test(id)) states.set(id, cells[3] ?? '')
  }
  return states
}

describe('README (a view of LEDGER.md)', () => {
  it('D51: the diagnostics reference lists every code with its severity, and no other code', () => {
    for (const code of DIAGNOSTIC_CODES) {
      expect(readme).toContain(`| \`${code}\` | ${SEVERITY[code]} |`)
    }
    const mentioned = new Set(readme.match(/\bHYDE_[A-Z_]*[A-Z]\b/g))
    expect([...mentioned].filter((code) => !DIAGNOSTIC_CODES.includes(code as never))).toEqual([])
  })

  it('D51: shows a failed report and a success warning exactly as hyde-db prints them', () => {
    expect(readme).toContain(formatReport([strictUnannotated('User.phone')]))
    expect(readme).toContain(`hyde-db: ${formatDiagnostic(sensitiveExplicit('User.email'))}`)
  })

  it('D54: the config table gives every key with its default from DEFAULT_CONFIG', () => {
    for (const key of CONFIG_KEYS) {
      const value = String(DEFAULT_CONFIG[key as keyof ResolvedConfig])
      expect(readme).toContain(`| \`${key}\` | \`"${value}"\` |`)
    }
  })

  it('D54: every generator block parses under Prisma 6 and 7 and validates without diagnostics', () => {
    expect(generatorBlocks.length).toBeGreaterThanOrEqual(2)
    for (const block of generatorBlocks) {
      for (const major of MAJORS) {
        const { config } = parseSchema(`${DATASOURCE}\n${block}`, major)
        expect(validateConfig(config).diagnostics, `Prisma ${major}:\n${block}`).toEqual([])
      }
    }
  })

  it('D54: the full generator block sets every config key, each to its default', () => {
    const full = generatorBlocks.find((block) => block.includes('statementTimeout'))
    expect(full).toBeDefined()
    for (const major of MAJORS) {
      const { config } = parseSchema(`${DATASOURCE}\n${full}`, major)
      expect(Object.keys(config).sort()).toEqual([...CONFIG_KEYS].sort())
      expect(validateConfig(config).config).toEqual(DEFAULT_CONFIG)
    }
  })

  it('D3, D54: the quick start builds without any diagnostic and shows its summary line (D28)', () => {
    const quickStart = section('Quick start')
    expect(quickStart).toContain('provider = "hyde-db"')
    expect(quickStart).toContain('strict mode is on by default')
    const source = `${DATASOURCE}\n${codeBlocks(quickStart, 'prisma').join('\n')}`
    for (const major of MAJORS) {
      const { datamodel, config } = parseSchema(source, major)
      const result = build(datamodel, config)
      expect(result.diagnostics, `Prisma ${major}`).toEqual([])
      expect(result.files).not.toBeNull()
      expect(quickStart).toContain(
        `hyde-db: ${result.views.length} views, ${result.counts.visible} visible and ` +
          `${result.counts.hidden} hidden columns → prisma/redacted`,
      )
    }
  })

  it('D16: the sensitive-name examples behave as stated', () => {
    const flagged = ['password', 'token', 'email', 'phone', 'iban', 'address', 'birthDate', 'zip']
    const missed = ['passenger', 'discarded', 'flat', 'billingzip']
    for (const name of [...flagged, ...missed]) expect(prose).toContain(`\`${name}\``)
    for (const name of flagged) expect(isSensitiveName(name), name).toBe(true)
    for (const name of missed) expect(isSensitiveName(name), name).toBe(false)
  })

  it('D35: states that env() is not supported in the generator block', () => {
    expect(prose).toContain('`env("…")` is not supported in the generator block')
  })

  it('D14, D50: read-only and timeout are session defaults, privileges are the guarantee', () => {
    expect(prose).toContain('are session defaults, not guarantees')
    expect(prose).toContain('The guarantee is the privilege setup')
    expect(prose).toContain('it can create temporary tables')
  })

  it('D15: gives the REVOKE CONNECT step for other databases in the cluster', () => {
    expect(prose).toContain('REVOKE CONNECT ON DATABASE other_database FROM PUBLIC;')
  })

  it('D43: gives the psql and prisma db execute commands the tests run, as drop, migrate, apply', () => {
    const variants = [
      (file: string) => `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/redacted/${file}`,
      (file: string) => `npx prisma db execute --file prisma/redacted/${file}`,
      (file: string) =>
        `npx prisma db execute --file prisma/redacted/${file} --schema prisma/schema.prisma`,
    ]
    const deployBlocks = codeBlocks(readme, 'sh').filter((block) =>
      block.includes('migrate deploy'),
    )
    expect(deployBlocks.map((block) => block.trimEnd().split('\n'))).toEqual(
      variants.map((command) => [
        command('redacted-views-drop.sql'),
        'npx prisma migrate deploy',
        command('redacted-views.sql'),
      ]),
    )
  })

  it('D13, D24, D49: the final-check and marker messages it quotes are the ones the apply script raises', () => {
    const quoted = [
      'has attributes it must not have: ',
      'can read relations outside schema redacted: ',
      'must not be a member of other roles',
      'can execute SECURITY DEFINER functions: ',
      'can read sequences: ',
      'can create objects in schemas: ',
      'schema redacted exists but was not created by hyde-db',
      'refusing to drop it',
    ]
    for (const text of quoted) {
      expect(prose).toContain(text)
      expect(applySql).toContain(text)
    }
  })

  it('D11, D49, D58: states the marker rule, the CREATEROLE deploy and the rollback rule', () => {
    expect(prose).toContain('Generated by hyde-db')
    expect(prose).toContain('a non-superuser owner with `CREATEROLE`')
    expect(prose).toContain('send `ROLLBACK`')
  })

  it('D60: the migration section names the renamed annotations and the leftover warning', () => {
    const migration = section('Migrating from prisma-ai-views')
    expect(migration).toContain('HYDE_LEGACY_ANNOTATION')
    expect(migration).toContain('DROP SCHEMA ai CASCADE;')
  })

  it('D61: shows npx hyde-db --help and never npx --no hyde-db', () => {
    expect(prose).toContain('npx hyde-db --help')
    expect(readme).not.toContain('npx --no hyde-db')
  })

  it('D55: shell blocks paste into any shell: no "#", which interactive zsh does not treat as a comment', () => {
    const blocks = codeBlocks(readme, 'sh')
    expect(blocks.length).toBeGreaterThan(0)
    for (const block of blocks) expect(block).not.toContain('#')
  })

  it('keeps record IDs in HTML comments, cites only live records, and ends with the view footer', () => {
    expect(prose).not.toMatch(/\b[ADCQ]\d{1,2}\b/)
    const states = ledgerStates()
    const cited = new Set(
      Array.from(readme.matchAll(/<!--[\s\S]*?-->/g), (match) =>
        Array.from(match[0].matchAll(/\b[ADCQ]\d+\b/g), (id) => id[0]),
      ).flat(),
    )
    expect(cited.size).toBeGreaterThan(0)
    for (const id of cited) {
      expect(['active', 'verified', 'open', 'answered'], id).toContain(states.get(id))
    }
    expect(readme.trimEnd()).toMatch(/\n---\n\nView on LEDGER\.md, \d{4}-\d{2}-\d{2}$/)
  })
})
