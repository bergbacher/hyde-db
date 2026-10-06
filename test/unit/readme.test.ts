// README.md is a view of LEDGER.md. These tests pin its claims to the code so the two cannot
// drift: every diagnostic code with its severity, the config defaults, the generator blocks
// (parsed by Prisma's own schema engine), the quick start's summary line, the deploy commands the
// attack suite and the end-to-end layer run (D43) with the CLI usage's guards, the refusal table
// against the golden apply script, the supported versions against package.json and the CI matrix,
// and the view conventions (IDs in comments, footer, only live records cited). Statements about
// behaviour the final fix wave changes are pinned both ways, so that change forces an update here.
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
import {
  citedRecords,
  headingAnchors,
  ledgerStatement,
  ledgerStates,
  section as sectionOf,
  withoutComments,
} from '../helpers/docs.ts'
import { readRepoFile, repoRoot } from '../helpers/files.ts'
import { type PrismaMajor, parseSchema } from '../helpers/prisma.ts'

const readme = readRepoFile('README.md')
/** The README without HTML comments, which is where record IDs live. */
const prose = withoutComments(readme)
const applySql = readRepoFile('example', 'redacted', 'redacted-views.sql')
const dropSql = readRepoFile('example', 'redacted', 'redacted-views-drop.sql')
const help = usage(DEFAULT_CONFIG)
const helpLines = help.split('\n')

/** Bodies of the fenced code blocks with the given info string, in order. */
function codeBlocks(text: string, language: string): string[] {
  const fence = new RegExp(`\`\`\`${language}\\n([\\s\\S]*?)\`\`\``, 'g')
  return Array.from(text.matchAll(fence), (match) => match[1] ?? '')
}

/** A section of the README, from its heading up to the next `## ` heading. */
function section(heading: string, level = '##'): string {
  return sectionOf(readme, heading, level)
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
/** Every line of every `sh` block, without the ` &&` that chains it to the next one (D136). */
const shellLines = codeBlocks(readme, 'sh').flatMap((block) =>
  block
    .trimEnd()
    .split('\n')
    .map((line) => line.replace(/ &&$/, '')),
)
/** The `sh` blocks that deploy: drop, migrate, apply. */
const deployBlocks = codeBlocks(readme, 'sh').filter((block) => block.includes('migrate deploy'))
/** The shell expansion that stops a command while DATABASE_URL is unset or empty (D68). */
const DB_URL = `"\${DATABASE_URL:?export DATABASE_URL first}"`

/**
 * The message of every RAISE EXCEPTION in the golden apply script, after `hyde-db: ` and up to its
 * first `%` (where the objects and the fix go) or `;`, in the order the script raises them.
 */
const abortPrefixes = Array.from(applySql.matchAll(/RAISE EXCEPTION 'hyde-db: ([^%;]*)/g), (m) =>
  (m[1] ?? '').trim(),
)

/**
 * Asserts that the README states `sentence` exactly when `stated` is true. These pins are two-way
 * on purpose: a golden change that flips them names the README sentence to add or remove.
 */
function expectSentence(sentence: string, stated: boolean): void {
  const action = stated ? 'add to' : 'remove from'
  expect(prose.includes(sentence), `${action} README.md: "${sentence}"`).toBe(stated)
}

/** D134: fixes the deploy user cannot run itself are not marked yet. */
const UNMARKED = "Today a fix that needs the object's owner carries no mark."
/** D134: they carry the owner's name. */
const MARKED = 'ends with `-- run as <owner> or a superuser`'
/** D131: the scripts set client_min_messages for the session. */
const OUTLIVES =
  '`SET client_min_messages = warning` runs before `BEGIN` and stays with the connection'
/** D131: they set it for their transaction only. */
const ENDS = '`SET LOCAL client_min_messages = warning`'
/** A92: a superuser can still lend a grant option. */
const SUPERUSER_LENDER = '**A superuser as lender.**'
/** D130: it cannot. */
const NO_SUPERUSER_LENDER = 'that still holds it and is not a superuser'

/** The rows of the refusal table, as cells. */
const refusalRows = section('What the apply script refuses')
  .split('\n')
  .filter((line) => /^\| \d+ \|/.test(line))
  .map(cells)

/** The grantees a printed REVOKE names: PUBLIC, the reader, or both (D108). */
const GRANTEES = '(PUBLIC|redacted_reader)(, redacted_reader)?'

/** A word list in the golden script, such as `'SELECT, USAGE, UPDATE'` after the given SQL. */
function goldenList(pattern: RegExp): string[] {
  const list = pattern.exec(applySql)?.[1]
  if (list === undefined) throw new Error(`the golden apply script has no match for ${pattern}`)
  return list.split(', ')
}

/** The role attributes the attribute check refuses, from the `NO…` fixes it prints. */
const ATTRIBUTES = Array.from(
  new Set(Array.from(applySql.matchAll(/THEN 'NO([A-Z]+)' END/g), (match) => match[1] ?? '')),
)

/** The kinds `ALTER DEFAULT PRIVILEGES … REVOKE ALL ON <kind>` takes, from the script's CASE. */
const DEFAULT_KINDS = Array.from(
  applySql.matchAll(/WHEN '[a-zA-Z]' THEN '([A-Z ]+)'/g),
  (match) => match[1] ?? '',
)

/**
 * Per refusal row: the shape of its example fix, the golden SQL that prints that shape, and words
 * its condition must name, each taken from the golden script where it lists them.
 */
const ROW_PINS: Readonly<
  Record<number, { fix: RegExp; golden: readonly string[]; condition: readonly string[] }>
> = {
  2: {
    fix: new RegExp(`^ALTER ROLE redacted_reader( NO(${ATTRIBUTES.join('|')}))+;$`),
    golden: ["format('ALTER ROLE %I %s;'"],
    condition: ATTRIBUTES.map((attribute) => `\`${attribute}\``),
  },
  3: {
    fix: /^REASSIGN OWNED BY redacted_reader TO CURRENT_USER; -- run as an administrator$/,
    golden: ['Fix: REASSIGN OWNED BY % TO CURRENT_USER; -- run as an administrator'],
    condition: ['temporary objects and large objects', 'owns any database'],
  },
  4: {
    fix: /^REVOKE \S+ FROM redacted_reader( GRANTED BY \S+)? CASCADE;$/,
    golden: ["format('REVOKE %I FROM %I%s CASCADE;'", "format(' GRANTED BY %s'"],
    condition: ['member of another role'],
  },
  5: {
    fix: new RegExp(`^REVOKE CREATE ON DATABASE \\S+ FROM ${GRANTEES} CASCADE;$`),
    golden: ["format('CREATE ON DATABASE %I'", "has_database_privilege(r.oid, d.oid, 'CREATE')"],
    condition: ['create schemas in this database'],
  },
  6: {
    fix: new RegExp(`^REVOKE [A-Z]+( \\(\\w+\\))? ON TABLE \\S+ FROM ${GRANTEES} CASCADE;$`),
    golden: ["format('TABLE %s'", "format('REVOKE %s ON %s FROM %s CASCADE;', q.privileges"],
    condition: goldenList(/WHERE n\.nspname IN \(([^)]*)\) AND x\.grantee/).map(
      (schema) => `\`${schema.replaceAll("'", '')}\``,
    ),
  },
  7: {
    fix: new RegExp(`^REVOKE ALL ON \\S+ FROM ${GRANTEES} CASCADE;$`),
    golden: [
      "format('ALL ON %s', format('%I.%I', n.nspname, c.relname))",
      "c.relkind IN ('r', 'p', 'v', 'm', 'f')",
    ],
    condition: [
      'table, partitioned table, view, materialized view or foreign table',
      ...goldenList(/has_table_privilege\(r\.oid, c\.oid, '([^']*)'\)/).map((p) => `\`${p}\``),
      'any column privilege',
    ],
  },
  8: {
    fix: new RegExp(`^REVOKE USAGE ON FOREIGN SERVER \\S+ FROM ${GRANTEES} CASCADE;$`),
    golden: ["format('USAGE ON FOREIGN SERVER %I'", "has_server_privilege(r.oid, fs.oid, 'USAGE')"],
    condition: ['foreign server'],
  },
  9: {
    fix: new RegExp(`^REVOKE EXECUTE ON ROUTINE \\S+\\(.*\\) FROM ${GRANTEES} CASCADE;$`),
    golden: ["format('EXECUTE ON ROUTINE %s'", 'p.prosecdef'],
    condition: ['`SECURITY DEFINER`'],
  },
  10: {
    fix: new RegExp(`^REVOKE ALL ON SEQUENCE \\S+ FROM ${GRANTEES} CASCADE;$`),
    golden: ["format('ALL ON SEQUENCE %s'"],
    condition: [
      ...goldenList(/has_sequence_privilege\(r\.oid, c\.oid, '([^']*)'\)/).map((p) => `\`${p}\``),
      'column grant',
    ],
  },
  11: {
    fix: new RegExp(
      `^ALTER DEFAULT PRIVILEGES FOR ROLE \\S+( IN SCHEMA \\S+)? REVOKE ALL ON (${DEFAULT_KINDS.join('|')}) FROM ${GRANTEES};$`,
    ),
    golden: [
      "format('ALTER DEFAULT PRIVILEGES FOR ROLE %I%s REVOKE ALL ON %s FROM %s;'",
      "d.defaclobjtype IN ('r', 'S', 'n', 'L')",
    ],
    condition: ['tables, sequences, schemas or (PostgreSQL 18) large objects'],
  },
  12: {
    fix: new RegExp(`^REVOKE CREATE ON SCHEMA \\S+ FROM ${GRANTEES} CASCADE;$`),
    golden: ["format('CREATE ON SCHEMA %I'", 'n.oid <> pg_my_temp_schema()'],
    condition: ["another session's `pg_temp_N`", "the applying session's own temporary schema"],
  },
  14: {
    fix: new RegExp(`^REVOKE ALL ON LARGE OBJECT \\d+ FROM ${GRANTEES} CASCADE;$`),
    golden: ["format('ALL ON LARGE OBJECT %s'", 'l.lomowner <> r.oid'],
    condition: ['a large object it does not own'],
  },
  15: {
    fix: new RegExp(
      `^REVOKE (ALTER SYSTEM|SET|ALTER SYSTEM, SET) ON PARAMETER \\S+ FROM ${GRANTEES} CASCADE; -- run as a superuser$`,
    ),
    golden: [
      "format('%s ON PARAMETER %I'",
      "x.privilege_type IN ('SET', 'ALTER SYSTEM')",
      'FROM pg_parameter_acl pa',
      "IF current_setting('server_version_num')::int >= 150000 THEN",
    ],
    condition: ['`SET`', '`ALTER SYSTEM`', 'configuration parameter', 'PostgreSQL 15 and later'],
  },
}

/** README prose with inline-code backticks removed, to compare with the plain ASCII usage (D66). */
const plainProse = prose.replaceAll('`', '')

describe('the CLI usage and the README agree', () => {
  it('A41, D66: the login step comes in the same order: \\password, then ALTER ROLE … LOGIN;, then the READER_PASSWORD one-liner', () => {
    const order = (text: string): number[] =>
      ['\\password redacted_reader', 'ALTER ROLE redacted_reader LOGIN;', 'READER_PASSWORD'].map(
        (phrase) => text.indexOf(phrase),
      )
    for (const [name, text] of [
      ['usage', help],
      ['README', section('After the first deploy', '###')],
    ] as const) {
      const [password = -1, login = -1, fallback = -1] = order(text)
      expect(password, name).toBeGreaterThan(-1)
      expect(login, name).toBeGreaterThan(password)
      expect(fallback, name).toBeGreaterThan(login)
    }
  })

  it('A15, A95, D24: the PostgreSQL 14 step: the same statement, run once before the first apply by the owner of public or a superuser', () => {
    const step = helpLines.find((line) => line.startsWith('On PostgreSQL 14 and older')) ?? ''
    const before = withoutComments(section('Before the first deploy', '###')).replaceAll('`', '')
    for (const phrase of [
      'REVOKE CREATE ON SCHEMA public FROM PUBLIC',
      'as the owner of schema public or a superuser',
    ]) {
      expect(step, phrase).toContain(phrase)
      expect(before, phrase).toContain(phrase)
    }
  })

  it('D108: the recovery line points at the README section on who runs a fix, and both say to apply again until it passes', () => {
    const recovery = helpLines.find((line) => line.startsWith('If apply aborts')) ?? ''
    const heading = /\(README: ([^)]+)\)/.exec(recovery)?.[1] ?? ''
    expect(readme).toContain(`\n### ${heading}\n`)
    expect(recovery).toContain('until it passes')
    expect(prose).toContain('run the apply script again; repeat until it passes')
  })

  it('D136, D137: both send a Prisma URL with parameters to prisma db execute, keep the parameters for Prisma, and set sourceSchema to its schema', () => {
    expect(help).toContain('deploy with npx prisma db execute --file instead')
    expect(shellLines).toContain('npx prisma db execute --file prisma/redacted/redacted-views.sql')
    const keep =
      'Do not strip the parameters for psql: prisma migrate deploy would then run against the stripped URL, which can point at another schema.'
    expect(help).toContain(keep)
    expect(plainProse).toContain(keep)
    expect(help).toContain('set sourceSchema to its ?schema= name')
    expect(plainProse).toContain('?schema=<name>, set sourceSchema to that name')
    for (const phrase of [
      'a libpq URL of the same database without Prisma parameters',
      'in a shell where you run no Prisma command',
    ]) {
      expect(help, phrase).toContain(phrase)
      expect(plainProse, phrase).toContain(phrase)
    }
  })

  it('A99, D140: both say a role belongs to the whole cluster and give each database and generator block its own role', () => {
    const sentence = 'give each database, and each generator block, its own role'
    expect(help).toContain(sentence)
    expect(plainProse).toContain(sentence)
    expect(help).toContain('Roles belong to the whole cluster, not to one database')
    expect(plainProse).toContain('Roles belong to the whole cluster, not to one database')
  })
})

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

  it('D93: the opening table claims only what the final check refuses', () => {
    const intro = prose.slice(0, prose.indexOf('\n## '))
    expect(intro).toContain(
      'aborts the script if the role holds any access the final check refuses',
    )
    expect(intro).toContain('[what it guarantees](#what-it-guarantees-and-what-it-does-not)')
    expect(prose).not.toMatch(/could reach anything/)
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

  it('D132: states the time scope of the guarantee', () => {
    expect(section('What it guarantees and what it does not')).toContain(
      'It holds as of each successful apply: a grant made later is not prevented, and the next apply refuses it.',
    )
  })

  it('D34: rows and the content of visible columns are not covered', () => {
    const guarantees = section('What it guarantees and what it does not')
    expect(guarantees).toContain('Every row of a visible model is visible.')
    expect(guarantees).toContain('hyde-db judges names, not contents.')
  })

  it('D93: puts what it guarantees before the reference of what the apply script refuses', () => {
    expect(readme.indexOf('\n## What it guarantees and what it does not\n')).toBeLessThan(
      readme.indexOf('\n## What the apply script refuses\n'),
    )
  })

  it('D43: gives the psql and prisma db execute commands the tests run, as drop, migrate, apply', () => {
    const variants = [
      (file: string) => `psql ${DB_URL} -v ON_ERROR_STOP=1 -f prisma/redacted/${file}`,
      (file: string) => `npx prisma db execute --file prisma/redacted/${file}`,
      (file: string) =>
        `npx prisma db execute --file prisma/redacted/${file} --schema prisma/schema.prisma`,
    ]
    expect(
      deployBlocks.map((block) =>
        block
          .trimEnd()
          .split('\n')
          .map((line) => line.replace(/ &&$/, '')),
      ),
    ).toEqual(
      variants.map((command) => [
        command('redacted-views-drop.sql'),
        'npx prisma migrate deploy',
        command('redacted-views.sql'),
      ]),
    )
  })

  it('D136: chains each deploy block with &&, so a refused step stops the rest', () => {
    expect(deployBlocks).toHaveLength(3)
    for (const block of deployBlocks) {
      const lines = block.trimEnd().split('\n')
      expect(
        lines.slice(0, -1).every((line) => line.endsWith(' &&')),
        block,
      ).toBe(true)
      expect(lines.at(-1)?.endsWith('&&'), block).toBe(false)
      // A first step that fails, as a refused drop script does, must stop the block.
      const stubs = 'psql() { echo psql; return 3; }; npx() { echo npx; return 1; }'
      const { stdout } = spawnSync('sh', ['-c', `${stubs}\n${block}`], {
        env: { PATH: process.env.PATH ?? '', DATABASE_URL: 'postgresql://db' },
        encoding: 'utf8',
      })
      expect(stdout.trim().split('\n'), block).toHaveLength(1)
    }
  })

  it('D137: sourceSchema follows the schema the Prisma URL selects, and the login step needs a libpq URL', () => {
    const row = readme.split('\n').find((line) => line.startsWith('| `sourceSchema` |')) ?? ''
    expect(row).toContain('hyde-db never reads the database URL')
    expect(row).toContain('`?schema=<name>`, set `sourceSchema` to that name')
    const after = section('After the first deploy', '###')
    expect(after).toContain('a libpq URL of the same database without Prisma parameters')
    expect(after).toContain('in a shell where you run no Prisma command')
  })

  it('A99, D140: says roles are cluster-wide, in the role row and the deploy text', () => {
    const sentence = 'give each database, and each generator block, its own `role`'
    const row = readme.split('\n').find((line) => line.startsWith('| `role` |')) ?? ''
    expect(row).toContain('Roles belong to the whole cluster')
    expect(row).toContain(sentence)
    const before = section('Before the first deploy', '###')
    expect(before).toContain('A role belongs to the whole cluster')
    expect(before).toContain('cannot separate them')
    expect(before).toContain(sentence)
  })

  it('says the views block prisma migrate dev and db push the same way, so development drops and applies too', () => {
    const deploy = section('Every deploy', '###')
    expect(deploy).toContain('`prisma migrate dev` and `prisma db push`')
    expect(deploy).toContain('run the drop script before them and the apply script after')
  })

  it('D136: sends a Prisma URL with parameters to the prisma db execute path', () => {
    const deploy = section('Every deploy', '###')
    expect(deploy).toContain('a plain libpq URL')
    expect(deploy).toContain(
      'If the database URL Prisma uses carries parameters such as `?schema=`, deploy with `prisma db execute` instead',
    )
    expect(deploy).toContain('`prisma migrate deploy` would then run against the stripped URL')
  })

  it('D68, D136: the CLI usage deploy block is the README psql block for output ./redacted, chained the same way, with the same guards', () => {
    const start = helpLines.findIndex((line) => line.includes('<output>/redacted-views-drop.sql'))
    const helpBlock = helpLines
      .slice(start, start + 3)
      .map((line) => line.trim().replaceAll('<output>/', 'prisma/redacted/'))
      .join('\n')
    expect(deployBlocks.find((block) => block.startsWith('psql '))).toBe(`${helpBlock}\n`)
    const helpLogin = helpLines.find((line) => line.includes('LOGIN PASSWORD'))?.trim()
    expect(shellLines).toContain(helpLogin)
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

  it('D68: carries the CLI usage note on psql verbatim', () => {
    const note = helpLines.filter((line) => line.startsWith('Note: psql does not read .env'))
    expect(note).toHaveLength(1)
    expect(prose).toContain(note[0])
  })

  it('A41, D66: the login step sets the password with \\password before LOGIN, and states the cost of the one-liner', () => {
    const after = section('After the first deploy', '###')
    const password = after.indexOf('\\password redacted_reader')
    const login = after.indexOf('ALTER ROLE redacted_reader LOGIN;')
    expect(password).toBeGreaterThan(-1)
    expect(login).toBeGreaterThan(password)
    for (const phrase of [
      'single quote',
      '`ps` output',
      'logs DDL statements',
      'shell history',
      'Later deploys keep the login and the password.',
    ]) {
      expect(after, phrase).toContain(phrase)
    }
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

  it('A15, A95, D24: the PostgreSQL 14 step runs in the application database, as the owner of public or a superuser, before the first apply', () => {
    const before = section('Before the first deploy', '###')
    expect(before).toContain('REVOKE CREATE ON SCHEMA public FROM PUBLIC;')
    expect(before).toContain("in the application's database")
    expect(before).toContain('the owner of schema `public` or a superuser')
    expect(prose.indexOf('REVOKE CREATE ON SCHEMA public FROM PUBLIC;')).toBeLessThan(
      prose.indexOf('-f prisma/redacted/redacted-views.sql'),
    )
  })

  it('A95: says a REVOKE by a role that neither owns the object nor holds the grant option does nothing, with the warning PostgreSQL prints', () => {
    const warning = /`WARNING: ([^`]*)`/.exec(ledgerStatement('A95'))?.[1]
    expect(warning).toBe('no privileges could be revoked')
    // psql prints two spaces after the severity.
    expect(prose).toContain(`\`WARNING:  ${warning} for "public"\``)
    const withoutSuperuser = section('Running fixes without a superuser', '###')
    for (const phrase of [
      'exits 0 and changes nothing',
      'schema `public` belongs to the bootstrap superuser',
      'catalog objects and `pg_temp_N` schemas',
      "run it as the owner, a role that inherits the owner role's privileges, or a superuser",
    ]) {
      expect(withoutSuperuser, phrase).toContain(phrase)
    }
  })

  it("A95, D134, D144: a role that inherits the owner role's privileges revokes as the owner, and a deploy user can become one", () => {
    const withoutSuperuser = section('Running fixes without a superuser', '###')
    for (const phrase of [
      "it works only when the owner, a role that inherits the owner role's privileges, or a superuser runs it",
      "owns the object or inherits the owner role's privileges",
      'a `CREATEROLE` deploy user is by default a member of each role it creates without inheriting its privileges',
      'GRANT <owner> TO CURRENT_USER;',
      'REVOKE <owner> FROM CURRENT_USER;',
    ]) {
      expect(withoutSuperuser, phrase).toContain(phrase)
    }
    // The marker follows pg_has_role(owner, 'USAGE'): membership alone, as a creator's ADMIN
    // without INHERIT on PostgreSQL 16 and later, does not count.
    expect(section('How a printed fix is built', '###')).toContain(
      "is not that owner, does not inherit the owner role's privileges, and is not a superuser",
    )
    expect(applySql).toMatch(/bool_and\(pg_has_role\(.+?, 'USAGE'\)\)/)
    expect(applySql).not.toMatch(/pg_has_role\(.+?, 'MEMBER'\)/)
    expect(prose).not.toContain('member of the owner role')
  })

  it("D134: says that schema public's fix names the database's owner where pg_database_owner owns it", () => {
    expect(applySql).toContain(
      "= to_regrole('pg_database_owner')::oid THEN (SELECT dbo.datdba FROM pg_database dbo",
    )
    expect(section('How a printed fix is built', '###')).toContain(
      "From PostgreSQL 15 on, schema `public` belongs to `pg_database_owner`, a role nobody can log in as that stands for the database's owner, so its fix names the database's owner instead.",
    )
  })

  it('D134, D144: the managed-service row gives both marker forms, the owner and the several-owners one', () => {
    const row =
      section('Running fixes without a superuser', '###')
        .split('\n')
        .find((line) => line.startsWith('| A `REVOKE` without `SET ROLE` |')) ?? ''
    expect(row).toContain('the fix ends with `-- run as <owner> or a superuser`')
    expect(row).toContain('or with `-- run as a superuser` when it revokes as several owners')
    expect(applySql).toContain("' -- run as %s or a superuser'")
    expect(applySql).toContain("' -- run as a superuser'")
  })

  it('D134: says, both ways, whether a fix that needs the owner is marked', () => {
    // Any way of building the marker leaves this phrase in the golden script, also one that
    // splits it around a quote_ident(…) call.
    const marked = applySql.includes('or a superuser')
    expectSentence(UNMARKED, !marked)
    expectSentence(MARKED, marked)
  })

  it('D131: says, both ways, whether client_min_messages outlives the scripts', () => {
    const goldens = [applySql, dropSql]
    const sessionLevel = goldens.some((sql) => /^SET client_min_messages/m.test(sql))
    expectSentence(OUTLIVES, sessionLevel)
    expectSentence(ENDS, !sessionLevel)
  })

  it('A98, D146: says the schema doc writes names as SQL needs them, as the generated doc does', () => {
    const md = readRepoFile('example', 'redacted', 'redacted-schema.md')
    expect(md).toContain('a name in double quotes is case-sensitive and works only with its quotes')
    const after = section('After the first deploy', '###')
    expect(after).toContain('`redacted-schema.md` writes each name as SQL needs it')
    expect(after).toContain('is case-sensitive and works only with its quotes')
    expect(after).toContain('unqualified view names work')
  })

  it('D146: says what the schema doc adds: Prisma type names in the type column, and the shadowing of views for unqualified queries', () => {
    const md = readRepoFile('example', 'redacted', 'redacted-schema.md')
    expect(md).toContain('| column | Prisma type | notes |')
    expect(md).toContain('is shadowed in unqualified queries: qualify it with the schema')
    const after = section('After the first deploy', '###')
    expect(after).toContain('The type column shows Prisma type names, not SQL types.')
    expect(after).toContain(
      'A view named like a `pg_catalog` relation, or like a temporary table the reader creates, is shadowed in unqualified queries: qualify it with the schema.',
    )
  })

  it('D147: says what a failed write reports and that the three files may be replaced in part', () => {
    const quick = section('Quick start')
    expect(quick).toContain('hyde-db: could not write <path>: <reason>')
    expect(quick).toContain('the three files are not replaced as one unit')
    expect(quick).toContain('some may be new and some old')
    expect(quick).toContain('never replaces an earlier error')
  })

  it('D11, D13, D24, D49, D108: the refusal table lists every abort the apply script raises, in order', () => {
    expect(refusalRows.map((row) => row[0])).toEqual(refusalRows.map((_, index) => String(index)))
    const errors = refusalRows.map((row) => /`([^`]*)`/.exec(row[2] ?? '')?.[1])
    expect(abortPrefixes.length).toBeGreaterThanOrEqual(14)
    expect(errors).toEqual(abortPrefixes)
  })

  it('A97, D141: row 1 and the deploy notes say both scripts refuse to drop objects outside the views schema that depend on its views', () => {
    const row = refusalRows[1] ?? []
    expect(row[1]).toContain(
      'temporary objects and objects that depend on a temporary object excepted',
    )
    expect(row[3]).toBe('none: drop them before the deploy, and create them again after it')
    expect(dropSql).toContain(
      "RAISE EXCEPTION 'hyde-db: objects outside schema redacted depend on its views: %;",
    )
    const notes = section('Transactions, timeouts and the schema marker', '###')
    for (const phrase of [
      'both scripts stop, name it, and change nothing',
      "a reader's own cannot block a deploy",
      'Temporary objects, and objects that depend on a temporary object, are the exception',
      'Both go anyway when the session that created the temporary object ends.',
      "a temporary table loses only its column of a view's row type",
      'a view or function goes',
    ]) {
      expect(notes, phrase).toContain(phrase)
    }
    expect(notes).not.toContain('they go with the schema')
    expect(notes).not.toContain('a temporary view or function goes')
  })

  it('D13, D24, D49, D76, D80, D81, D82, D91, D108, D109, D111, D138: each row gives a fix of the shape the apply script prints, and names what the script checks', () => {
    const pinned = Object.keys(ROW_PINS).map(Number)
    expect(pinned).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15])
    for (const index of pinned) {
      const pin = ROW_PINS[index]
      const row = refusalRows[index] ?? []
      const fix = /`([^`]*)`/.exec(row[3] ?? '')?.[1] ?? ''
      expect(fix, `row ${index}`).toMatch(pin?.fix ?? /$^/)
      for (const sql of pin?.golden ?? []) expect(applySql, `row ${index}`).toContain(sql)
      expect(pin?.condition.length, `row ${index}`).toBeGreaterThan(0)
      for (const word of pin?.condition ?? []) expect(row[1], `row ${index}`).toContain(word)
    }
  })

  it('D108, D109, D123, D127: the fix shapes it quotes are the ones the apply script prints', () => {
    // README text → the SQL in the golden apply script that prints it.
    const shapes: readonly (readonly [string, string])[] = [
      ['`BEGIN; … COMMIT;`', "'BEGIN; ' || fixes || ' COMMIT;'"],
      ['`-- run as a superuser`', "' -- run as a superuser'"],
      ['`-- run as <owner> or a superuser`', "' -- run as %s or a superuser'"],
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

  it('D125, D127, D130, D135: says what a pasted fix changes besides the refused grants', () => {
    const refusals = section('What the apply script refuses')
    for (const phrase of [
      'exactly the privileges it granted, never `ALL`',
      'leaves every other grant exactly as it was',
      'Grants that `redacted_reader` itself passed on to other roles go with it',
      'also removes the same orphaned grants that grantor made to other roles',
      'never backed by a grant option',
      'can cascade away with the fix',
    ]) {
      expect(refusals, phrase).toContain(phrase)
    }
  })

  it('D135: states only what the tests show about pasted fixes', () => {
    const evidence =
      'The integration tests paste each printed fix and re-apply; the fix tests also compare ACL entries before and after the paste.'
    expect(section('What a pasted fix changes', '###')).toContain(evidence)
    expect(prose).not.toMatch(/compares? the ACL entries before and after each pasted fix/)
  })

  it('A92, D130: lists the superuser-lender limit exactly while the lender choice still admits superusers', () => {
    const lenderChoices = Array.from(
      applySql.matchAll(/SELECT coalesce\(\(SELECT min\(h\.grantee\)[\s\S]*?AS lender/g),
      (match) => match[0],
    )
    expect(lenderChoices.length).toBeGreaterThan(0)
    const superusersExcluded = lenderChoices.every((choice) => choice.includes('rolsuper'))
    expectSentence(SUPERUSER_LENDER, !superusersExcluded)
    expectSentence(NO_SUPERUSER_LENDER, superusersExcluded)
  })

  it('D125, A94: says who can run each kind of fix where the deploy user is not a superuser, as probed', () => {
    const managed = section('Running fixes without a superuser', '###')
    for (const phrase of [
      'GRANT redacted_reader TO CURRENT_USER;',
      'REVOKE redacted_reader FROM CURRENT_USER;',
      'permission denied to set role',
      'permission denied to reassign objects',
      'Only roles with the ADMIN option on role',
      'permission denied to set parameter "lo_compat_privileges"',
      'PostgreSQL 14.24, 16.14 and 18.6',
      "the provider's mechanism for server parameters",
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

  it('D110, D129, D131: gives the settings both scripts make, and that they end with them', () => {
    const seconds = /SET LOCAL lock_timeout = '(\d+)s';/.exec(applySql)?.[1]
    expect(seconds).toBeDefined()
    expect(readRepoFile('example', 'redacted', 'redacted-views-drop.sql')).toContain(
      `SET LOCAL lock_timeout = '${seconds}s';`,
    )
    // Both scripts turn JIT off, the drop script for its dependents guard (A93).
    expect(applySql).toContain('SET LOCAL jit = off;')
    expect(dropSql).toContain('SET LOCAL jit = off;')
    expect(prose).toContain(
      `Both scripts set \`SET LOCAL client_min_messages = warning\`, \`SET LOCAL lock_timeout = '${seconds}s'\` and \`SET LOCAL jit = off\`.`,
    )
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
    const outsideMigration = withoutComments(
      readme.replace(section('Migrating from prisma-ai-views'), ''),
    )
    expect(outsideMigration).not.toMatch(/\bai_reader\b|@ai\.(visible|hidden)/)
  })

  it('D66: shows npx hyde-db --help, never npx --no hyde-db, and the provider rule as the binary prints it', () => {
    expect(prose).toContain('npx hyde-db --help')
    expect(readme).not.toContain('npx --no hyde-db')
    expect(prose).toContain(prismaArgumentsMessage(['--help']))
    expect(prose).toContain(unknownArgumentMessage('--bogus').split('\n')[0])
    expect(prose).toContain('exits with status 2')
  })

  it('D9, D142, D47, D112: programmatic use: never throws on config, the dialect union and a nullable sourceSchema', () => {
    const api = section('Programmatic use')
    expect(api).toContain('never throw on config input')
    expect(citedRecords(api)).toContain('D142')
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

  it('every link into the repository points at a file and, with an anchor, at a heading of it', () => {
    const links = Array.from(prose.matchAll(/\]\(([^)]+)\)/g), (m) => m[1] ?? '').filter(
      (target) => !/^[a-z]+:/.test(target),
    )
    expect(links).toContain('RELEASING.md')
    expect(links).toContain('SECURITY.md')
    expect(links.filter((link) => link.startsWith('#')).length).toBeGreaterThan(5)
    for (const link of links) {
      // A bare `#anchor` points into the README itself.
      const [path = '', fragment] = link.split('#')
      const file = path === '' ? 'README.md' : path
      expect(existsSync(join(repoRoot, file)), link).toBe(true)
      if (fragment !== undefined)
        expect(headingAnchors(readRepoFile(file)), link).toContain(fragment)
    }
  })

  it('keeps record IDs in HTML comments, cites only live records, and ends with the view footer', () => {
    expect(prose).not.toMatch(/\b[ADCQ]\d+\b/)
    const states = ledgerStates()
    const cited = citedRecords(readme)
    expect(cited.size).toBeGreaterThan(0)
    for (const id of cited) {
      expect(['active', 'verified', 'open', 'answered'], id).toContain(states.get(id))
    }
    expect(readme.trimEnd()).toMatch(/\n---\n\nView on LEDGER\.md, \d{4}-\d{2}-\d{2}$/)
  })
})
