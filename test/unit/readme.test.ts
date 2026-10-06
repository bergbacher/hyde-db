// README.md is a view of LEDGER.md. These tests pin its claims to the code so the two cannot
// drift: every diagnostic code with its severity, the config defaults, the generator blocks
// (parsed by Prisma's own schema engine), the quick start's summary line, the deploy commands the
// attack suite and the end-to-end layer run (D43) with the CLI usage's guards, the refusal table
// against the golden apply script, the supported versions against package.json and the CI matrix,
// and the view conventions (IDs in comments, footer, only live records cited).
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { build } from '../../src/build.ts'
import {
  formatSummary,
  prismaArgumentsMessage,
  unknownArgumentMessage,
  usage,
} from '../../src/cli-help.ts'
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
import { readRepoFile, repoRoot } from '../helpers/files.ts'
import { type PrismaMajor, parseSchema } from '../helpers/prisma.ts'

const readme = readRepoFile('README.md')
/** The README without HTML comments, which is where record IDs live. */
const prose = readme.replace(/<!--[\s\S]*?-->/g, '')
const applySql = readRepoFile('example', 'redacted', 'redacted-views.sql')
const help = usage(DEFAULT_CONFIG)
const helpLines = help.split('\n')

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

/** The cells of a Markdown table row; escaped pipes stay inside a cell. */
function cells(row: string): string[] {
  return row
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((cell) => cell.trim())
}

const DATASOURCE = 'datasource db {\n  provider = "postgresql"\n}\n'
const MAJORS: readonly PrismaMajor[] = [6, 7]
const generatorBlocks = codeBlocks(readme, 'prisma').filter((block) =>
  block.startsWith('generator redacted {'),
)
const shellLines = codeBlocks(readme, 'sh').flatMap((block) => block.trimEnd().split('\n'))
/** The shell expansion that stops a command while DATABASE_URL is unset or empty (D68). */
const DB_URL = `"\${DATABASE_URL:?export DATABASE_URL first}"`

/**
 * Record ID → state, from the records table of LEDGER.md. The state is the third cell from the
 * end, since a statement may hold an unescaped pipe, as in `string | null`.
 */
function ledgerStates(): Map<string, string> {
  const states = new Map<string, string>()
  for (const line of readRepoFile('LEDGER.md').split('\n')) {
    const row = line.split(/(?<!\\)\|/).map((cell) => cell.trim())
    const id = row[1]
    if (id !== undefined && /^[ADCQ]\d+$/.test(id)) states.set(id, row.at(-4) ?? '')
  }
  return states
}

/**
 * The message of every RAISE EXCEPTION in the golden apply script, after `hyde-db: ` and up to its
 * first `%` (where the objects and the fix go) or `;`, in the order the script raises them.
 */
const abortPrefixes = Array.from(applySql.matchAll(/RAISE EXCEPTION 'hyde-db: ([^%;]*)/g), (m) =>
  (m[1] ?? '').trim(),
)

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

  it('D3, D54: the quick start builds without any diagnostic and shows its summary line as formatSummary prints it (D28)', () => {
    const quickStart = section('Quick start')
    expect(quickStart).toContain('provider = "hyde-db"')
    expect(quickStart).toContain('strict mode is on by default')
    const source = `${DATASOURCE}\n${codeBlocks(quickStart, 'prisma').join('\n')}`
    for (const major of MAJORS) {
      const { datamodel, config } = parseSchema(source, major)
      const result = build(datamodel, config)
      expect(result.diagnostics, `Prisma ${major}`).toEqual([])
      expect(result.files).not.toBeNull()
      const summary = formatSummary(
        { views: result.views.length, ...result.counts },
        'prisma/redacted',
      )
      expect(codeBlocks(quickStart, 'text')).toContain(`${summary}\n`)
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
    expect(prose).toContain('`TEMPORARY` on the database is revoked from `PUBLIC`')
  })

  it('D15: gives the REVOKE CONNECT step for other databases in the cluster', () => {
    expect(prose).toContain('REVOKE CONNECT ON DATABASE other_database FROM PUBLIC;')
  })

  it('D93: scopes the guarantee to table data and lists every non-guarantee', () => {
    expect(prose).toContain('`redacted_reader` can read no table data outside the generated views')
    const guarantees = section('What it guarantees and what it does not')
    for (const phrase of [
      'Catalog metadata',
      'row counts',
      'Large objects the reader owns',
      'including ones an administrator transfers to it',
      'REVOKE EXECUTE ON FUNCTION lo_create(oid), lo_creat(integer), lo_from_bytea(oid, bytea) FROM PUBLIC;',
      'affects every role',
      'channels the database cannot attribute',
      '`NOTIFY`',
      'A server-level `lo_compat_privileges = on` hidden by a deployer-scoped `off`',
    ]) {
      expect(guarantees, phrase).toContain(phrase)
    }
  })

  it('D34: rows and the content of visible columns are not covered', () => {
    const guarantees = section('What it guarantees and what it does not')
    expect(guarantees).toContain('Every row of a visible model is visible.')
    expect(guarantees).toContain('hyde-db judges names, not contents.')
  })

  it('D43: gives the psql and prisma db execute commands the tests run, as drop, migrate, apply', () => {
    const variants = [
      (file: string) => `psql ${DB_URL} -v ON_ERROR_STOP=1 -f prisma/redacted/${file}`,
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

  it('D68: the psql commands are the CLI usage commands for output ./redacted, with the same guards', () => {
    const helpCommands = helpLines
      .filter((line) => line.startsWith('  psql '))
      .map((line) => line.trim().replaceAll('<output>/', 'prisma/redacted/'))
    expect(helpCommands).toHaveLength(3)
    const readmePsql = shellLines.filter((line) => line.startsWith('psql '))
    for (const command of helpCommands) expect(readmePsql).toContain(command)
  })

  it('D68: every shell command that uses DATABASE_URL stops while it is unset or empty, running nothing', () => {
    // E2E_DATABASE_URL is the test suite's own variable, not the deploy database's.
    const withUrl = shellLines.filter((line) => /(^|[^A-Z_])DATABASE_URL\b/.test(line))
    expect(withUrl.length).toBeGreaterThanOrEqual(3)
    expect(readme).not.toContain('"$DATABASE_URL"')
    for (const line of withUrl) {
      expect(line, line).toContain(DB_URL)
      const printed = line.replace(/^psql /, "printf '%s\\n' ")
      for (const env of [{}, { DATABASE_URL: '' }]) {
        const { status, stdout, stderr } = spawnSync('sh', ['-c', printed], {
          env: { PATH: process.env.PATH ?? '', READER_PASSWORD: 'x', ...env },
          encoding: 'utf8',
        })
        expect(status, line).not.toBe(0)
        expect(stdout, line).toBe('')
        expect(stderr, line).toContain('DATABASE_URL: export DATABASE_URL first')
      }
    }
  })

  it('D68: carries the CLI usage notes on psql and the inline password verbatim', () => {
    const notes = helpLines.filter(
      (line) => line.startsWith('Note: psql does not read .env') || line.includes('single quote'),
    )
    expect(notes).toHaveLength(2)
    for (const note of notes) expect(prose).toContain(note)
    expect(prose).toContain('`\\password redacted_reader`')
    expect(prose).toContain('`ALTER ROLE redacted_reader LOGIN;`')
  })

  it('D55: shell blocks paste into any shell: no "#", backtick or command substitution', () => {
    const blocks = codeBlocks(readme, 'sh')
    expect(blocks.length).toBeGreaterThan(0)
    for (const block of blocks) {
      expect(block).not.toContain('#')
      expect(block).not.toContain('`')
      expect(block).not.toContain('$(')
    }
  })

  it('D11, D13, D24, D49, D108: the refusal table lists every abort the apply script raises, in order', () => {
    const rows = section('What the apply script refuses')
      .split('\n')
      .filter((line) => /^\| \d+ \|/.test(line))
      .map(cells)
    expect(rows.map((row) => row[0])).toEqual(rows.map((_, index) => String(index)))
    const errors = rows.map((row) => /`([^`]*)`/.exec(row[2] ?? '')?.[1])
    expect(abortPrefixes.length).toBeGreaterThanOrEqual(14)
    expect(errors).toEqual(abortPrefixes)
  })

  it('D108, D109, D123, D127: the fix shapes it quotes are the ones the apply script prints', () => {
    // README text → the SQL in the golden apply script that prints it.
    const shapes: readonly (readonly [string, string])[] = [
      ['`BEGIN; … COMMIT;`', "'BEGIN; ' || fixes || ' COMMIT;'"],
      ['`-- run as a superuser`', "' -- run as a superuser'"],
      ['contains `SET ROLE`', "fixes LIKE '%SET ROLE %'"],
      ['`ALTER SYSTEM`', "fixes NOT LIKE 'ALTER SYSTEM %'"],
      [
        'REASSIGN OWNED BY redacted_reader TO CURRENT_USER; -- run as an administrator',
        'REASSIGN OWNED BY % TO CURRENT_USER; -- run as an administrator',
      ],
      ['GRANTED BY', "format(' GRANTED BY %s', m.grantor::regrole)"],
      [
        'ALTER SYSTEM SET lo_compat_privileges = off; SELECT pg_reload_conf();',
        "'ALTER SYSTEM SET lo_compat_privileges = off; SELECT pg_reload_conf();'",
      ],
      ['CREATE ROLE redacted_reader NOLOGIN;', "format('CREATE ROLE %I NOLOGIN; %s'"],
      ['WITH ADMIN OPTION, INHERIT FALSE, SET FALSE;', "', INHERIT FALSE, SET FALSE'"],
      [
        'ALTER ROLE redacted_reader SET lo_compat_privileges = off;',
        "'%sALTER ROLE %I SET lo_compat_privileges = off;'",
      ],
      ['RESET lo_compat_privileges;', "'ALTER %s RESET lo_compat_privileges;'"],
      [
        'ALTER DEFAULT PRIVILEGES FOR ROLE',
        "'ALTER DEFAULT PRIVILEGES FOR ROLE %I%s REVOKE ALL ON %s FROM %s;'",
      ],
      ['REVOKE GRANT OPTION FOR', "'REVOKE GRANT OPTION FOR %s ON %s FROM %s CASCADE;'"],
      ['GRANT … WITH GRANT OPTION;', "'GRANT %s ON %s TO %s WITH GRANT OPTION;'"],
      ['SET ROLE redacted_reader; REVOKE SELECT (secret)', "'%sSET ROLE %s; %s RESET ROLE;%s'"],
    ]
    for (const [text, sql] of shapes) {
      expect(prose, text).toContain(text)
      expect(applySql, sql).toContain(sql)
    }
  })

  it('D125, D127, D128, D130: says what a pasted fix changes besides the refused grants', () => {
    const refusals = section('What the apply script refuses')
    for (const phrase of [
      'exactly the privileges it granted, never `ALL`',
      'leaves every other grant exactly as it was',
      'also removes the same orphaned grants that grantor made to other roles',
      'never backed by a grant option',
      'can cascade away with the fix',
    ]) {
      expect(refusals, phrase).toContain(phrase)
    }
  })

  it('D125: says who can run each kind of fix where the deploy user is not a superuser, as probed', () => {
    const managed = section('What the apply script refuses')
    for (const phrase of [
      'GRANT redacted_reader TO CURRENT_USER;',
      'REVOKE redacted_reader FROM CURRENT_USER;',
      'permission denied to set role',
      'permission denied to reassign objects',
      'Only roles with the ADMIN option on role',
      'permission denied to set parameter "lo_compat_privileges"',
      'PostgreSQL 14.24, 16.14 and 18.6',
    ]) {
      expect(managed, phrase).toContain(phrase)
    }
  })

  it('D124, D111, D91, D82, D24: names what each check leaves alone and what it also covers', () => {
    const refusals = section('What the apply script refuses')
    for (const phrase of [
      'temporary sequences excepted',
      'or a column grant',
      'its own default privileges excepted',
      'its own temporary objects and large objects',
      "another session's `pg_temp_N`",
    ]) {
      expect(refusals, phrase).toContain(phrase)
    }
  })

  it('D110, D129: gives the lock timeout the scripts set, and that their settings end with them', () => {
    const seconds = /SET LOCAL lock_timeout = '(\d+)s';/.exec(applySql)?.[1]
    expect(seconds).toBeDefined()
    expect(readRepoFile('example', 'redacted', 'redacted-views-drop.sql')).toContain(
      `SET LOCAL lock_timeout = '${seconds}s';`,
    )
    expect(applySql).toContain('SET LOCAL jit = off;')
    expect(prose).toContain(`\`SET LOCAL lock_timeout = '${seconds}s'\``)
    expect(prose).toContain('`SET LOCAL jit = off`')
    expect(prose).toContain(`after ${seconds} seconds`)
    expect(prose).toContain('end with the script')
  })

  it('A39, A41, A45, D58, D69: states the deploy facts the attack suite pins', () => {
    const facts = [
      'ALTER ROLE redacted_reader NOSUPERUSER;\nGRANT redacted_reader TO <deploy-user> WITH ADMIN OPTION;',
      'Later deploys keep the login and the password.',
      'outlives that session',
      'send `ROLLBACK`',
      'hyde-db never revokes anything on source tables',
    ]
    for (const fact of facts) expect(readme, fact).toContain(fact)
  })

  it('D11, D49, D58: states the marker rule, the CREATEROLE deploy and that a refused script changes nothing', () => {
    expect(prose).toContain('Generated by hyde-db')
    expect(prose).toContain('a non-superuser with `CREATEROLE`')
    expect(prose).toContain('A refused drop or apply changes nothing, under any client.')
  })

  it('D60: the migration section names the renamed annotations and the leftover warning', () => {
    const migration = section('Migrating from prisma-ai-views')
    expect(migration).toContain('HYDE_LEGACY_ANNOTATION')
    expect(migration).toContain('DROP SCHEMA ai CASCADE;')
  })

  it('D53: describes the reader as an AI tool or a person, and names old objects only when migrating', () => {
    expect(prose).toContain('an AI tool or a person')
    const outsideMigration = readme
      .replace(section('Migrating from prisma-ai-views'), '')
      .replace(/<!--[\s\S]*?-->/g, '')
    expect(outsideMigration).not.toMatch(/\bai_reader\b|@ai\.(visible|hidden)/)
  })

  it('D66: shows npx hyde-db --help, never npx --no hyde-db, and the provider rule as the binary prints it', () => {
    expect(prose).toContain('npx hyde-db --help')
    expect(readme).not.toContain('npx --no hyde-db')
    expect(prose).toContain(prismaArgumentsMessage(['--help']))
    expect(prose).toContain(unknownArgumentMessage('--bogus').split('\n')[0])
    expect(prose).toContain('exits with status 2')
  })

  it('D9, D47, D112: programmatic use: never throws on config, the dialect union and a nullable sourceSchema', () => {
    const api = section('Programmatic use')
    expect(api).toContain('never throw on config input')
    expect(api).toContain(`\`dialect: '${DEFAULT_CONFIG.dialect}'\``)
    expect(api).toContain('`View.sourceSchema` is `string | null`')
    expect(api).toContain('may gain members in minor releases')
  })

  it('D30, D31, D21, D38: the supported versions are the ones package.json and the CI matrix name', () => {
    const versions = section('Supported versions')
    const engines = (JSON.parse(readRepoFile('package.json')) as { engines: { node: string } })
      .engines.node
    expect(versions).toContain(`\`${engines}\``)
    const ci = readRepoFile('.github', 'workflows', 'ci.yml')
    const pg = /pg: \[(\d+), (\d+)\]/.exec(ci)
    const prisma = /prisma: \['([\d.]+)', '([\d.]+)'\]/.exec(ci)
    expect(versions).toContain(`PostgreSQL ${pg?.[1]} and ${pg?.[2]}`)
    expect(versions).toContain(`${prisma?.[1]} and ${prisma?.[2]}`)
    // Only what CI runs: no other PostgreSQL major is claimed as tested.
    expect(versions).not.toMatch(/\b1[5-7]\b/)
  })

  it('D87, D94: MySQL is planned for 1.1.0 and refused in 1.0', () => {
    const versions = section('Supported versions')
    expect(versions).toContain('MySQL 8.4 and 9.7 are planned for 1.1.0')
    expect(versions).toContain('`HYDE_UNSUPPORTED_PROVIDER`')
  })

  it('D63, D126: links RELEASING.md and says a release publishes only a commit CI passed', () => {
    const development = section('Development')
    expect(development).toContain('[RELEASING.md](RELEASING.md)')
    expect(development).toContain('only a commit on which CI passed')
  })

  it('every relative link points at a file in the repository', () => {
    const targets = Array.from(prose.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g), (m) => m[1] ?? '')
    const relative = targets.filter((target) => !/^[a-z]+:/.test(target))
    expect(relative).toContain('RELEASING.md')
    expect(relative).toContain('SECURITY.md')
    for (const target of relative) {
      expect(existsSync(join(repoRoot, target)), target).toBe(true)
    }
  })

  it('keeps record IDs in HTML comments, cites only live records, and ends with the view footer', () => {
    expect(prose).not.toMatch(/\b[ADCQ]\d+\b/)
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
