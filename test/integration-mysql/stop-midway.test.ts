import { afterEach, describe, expect, it } from 'vitest'
import {
  createAccount,
  createRole,
  createTestDb,
  deploy,
  dropTestDb,
  query,
  readerGrants,
  runScript,
  splitStatements,
  type TestDb,
  unlockReader,
} from './helpers/db.ts'

const created: TestDb[] = []
async function newDb(): Promise<TestDb> {
  const db = await createTestDb()
  created.push(db)
  return db
}
afterEach(async () => {
  for (const db of created.splice(0)) await dropTestDb(db)
})

/** The generated apply script. */
function applyScript(db: TestDb): string {
  return db.files['redacted-views.sql']
}

/** Statements of the real generated script, split by the harness splitter (checked by the first test). */
function statementsOf(db: TestDb): string[] {
  return splitStatements(applyScript(db))
}

const sqlOk = (sql: string, options: { database?: string } = {}) => {
  const result = query(sql, options)
  expect(result.status, result.stderr).toBe(0)
  return result.stdout.trim()
}

/** Every grant line is a SELECT on one table of the views database (and nothing else). */
function viewGrantLines(db: TestDb, lines: string[]): boolean {
  return lines.every((line) => new RegExp(`^table: ${db.views}\\.[a-z_]+ Select\\|$`).test(line))
}

/** Back to "no views database, no reader account" (first deploy). */
function resetToFresh(db: TestDb): void {
  sqlOk(`DROP DATABASE IF EXISTS \`${db.views}\`; DROP USER IF EXISTS '${db.reader}'@'${db.host}';`)
}

/** Back to a completed deployment (re-apply): fresh, then the whole script. */
function resetToDeployed(db: TestDb): void {
  resetToFresh(db)
  const result = deploy(db)
  expect(result.status, result.stderr).toBe(0)
}

describe('D103, A76: the real apply script splits into whole statements', () => {
  it('runs statement by statement to the same deployment as the script run whole', async () => {
    const whole = await newDb()
    const split = await newDb()
    expect(deploy(whole).status).toBe(0)
    const statements = statementsOf(split)
    // Long (pre-checks, gated build, grants, re-check), every one non-empty and free of a bare trailing `;`.
    expect(statements.length).toBeGreaterThan(40)
    for (const statement of statements) expect(statement.endsWith(';')).toBe(false)
    const result = runScript(split, `${statements.join(';\n')};\n`)
    expect(result.status, result.stderr).toBe(0)
    const normalize = (db: TestDb, lines: string[]) =>
      lines.map((line) => line.replaceAll(db.views, 'V').replaceAll(db.reader, 'R'))
    expect(normalize(split, readerGrants(split))).toEqual(normalize(whole, readerGrants(whole)))
    expect(sqlOk(`SHOW TABLES FROM \`${split.views}\``)).toBe(
      sqlOk(`SHOW TABLES FROM \`${whole.views}\``),
    )
    // Statements with a `;` inside a literal (the gated PREPARE strings) stay in one piece.
    expect(statements.some((s) => /'[^']*CREATE DATABASE[^']*;'/.test(s))).toBe(true)
  })
})

describe.each(['first deploy', 're-apply'] as const)(
  'D103: stop after each statement (%s)',
  (mode) => {
    it('never gives the reader more than SELECT on the views of the views database', async () => {
      const db = await newDb()
      const statements = statementsOf(db)
      // The grants of a finished deployment: what the reader may ever hold.
      expect(deploy(db).status).toBe(0)
      const finalGrants = readerGrants(db)
      expect(finalGrants.length).toBeGreaterThan(0)
      expect(viewGrantLines(db, finalGrants)).toBe(true)
      if (mode === 're-apply') {
        resetToDeployed(db)
        // The realistic state: the one-time documented step has given the reader a password.
        unlockReader(db, 'pw-reader')
      } else resetToFresh(db)

      for (let k = 1; k <= statements.length; k++) {
        const prefix = `${statements.slice(0, k).join(';\n')};\n`
        const result = runScript(db, prefix)
        const where = `stopped after statement ${k} of ${statements.length}: ${statements[k - 1]?.slice(0, 160)}`
        expect(result.status, `${where}\n${result.stderr}`).toBe(0)
        const grants = readerGrants(db)
        expect(viewGrantLines(db, grants), where).toBe(true)
        expect(
          grants.filter((grant) => !finalGrants.includes(grant)),
          where,
        ).toEqual([])
        if (mode === 're-apply') {
          resetToDeployed(db)
          unlockReader(db, 'pw-reader')
        } else resetToFresh(db)
      }
    }, 300_000)
  },
)

/** Everything about the views database a refusal must not change. */
function viewsState(db: TestDb): string {
  const exists = sqlOk(
    `SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '${db.views}'`,
  )
  const tables = sqlOk(
    `SELECT CONCAT(TABLE_NAME, ' ', TABLE_TYPE) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${db.views}' ORDER BY 1`,
  )
  const sentinel =
    exists === '1' && tables.includes('sentinel')
      ? sqlOk(`SELECT x FROM \`${db.views}\`.sentinel`)
      : ''
  return `${exists}\n${tables}\n${sentinel}`
}

function readerAccounts(db: TestDb): number {
  return Number(
    sqlOk(`SELECT COUNT(*) FROM mysql.user WHERE User = '${db.reader}' AND Host = '${db.host}'`),
  )
}

type Base = 'absent' | 'foreign' | 'deployed'

function prepareBase(db: TestDb, base: Base): void {
  if (base === 'foreign') {
    sqlOk(`CREATE DATABASE \`${db.views}\`; CREATE TABLE \`${db.views}\`.t (a INT);`)
  } else if (base === 'deployed') {
    expect(deploy(db).status).toBe(0)
    // A table only a rebuild would lose: an identical rebuild of the views is otherwise invisible.
    sqlOk(
      `CREATE TABLE \`${db.views}\`.sentinel (x INT); INSERT INTO \`${db.views}\`.sentinel VALUES (7);`,
    )
  }
}

interface Injection {
  readonly name: string
  readonly bases: readonly Base[]
  /** The refusal the run must report (the gate's problem text). */
  readonly expect: string | RegExp
  /** The injection needs the reader account to exist (a role, proxy or grant on it). */
  readonly needsReader?: boolean
  /** Makes the next run refuse; returns the way to undo it and how to run the script. */
  readonly inject: (db: TestDb) => {
    undo?: () => void
    prefix?: string
    as?: { user: string; password?: string }
    connectToViews?: boolean
  }
}

const ALL_BASES: readonly Base[] = ['absent', 'foreign', 'deployed']
const INJECTIONS: readonly Injection[] = [
  {
    // A deployment without a default database: create and select a database, then drop it.
    name: 'no default database (D160)',
    expect: /no default database/,
    bases: ALL_BASES,
    inject: (db) => ({
      prefix: `CREATE DATABASE \`${db.name}_tmp\`; USE \`${db.name}_tmp\`; DROP DATABASE \`${db.name}_tmp\`;\n`,
    }),
  },
  {
    name: 'the default database is the views database (D117)',
    expect: /the default database is the views database/,
    bases: ['deployed'],
    inject: () => ({ connectToViews: true }),
  },
  {
    name: 'a views database without the marker (D115)',
    expect: /has no hyde-db marker view/,
    bases: ['foreign'],
    inject: () => ({}),
  },
  {
    name: 'the deployer cannot read the mysql grant tables (A77)',
    expect: /cannot read the MySQL grant tables/,
    bases: ALL_BASES,
    inject: (db) => {
      const account = createAccount(db, {
        password: 'pw-deployer',
        grants: [
          `ALL PRIVILEGES ON \`${db.name}\`.*`,
          `ALL PRIVILEGES ON \`${db.views}\`.*`,
          'CREATE USER ON *.*',
        ],
      })
      return { as: { user: account.user, password: 'pw-deployer' } }
    },
  },
  {
    name: 'the reader has a role (D119)',
    expect: /the reader has a role/,
    needsReader: true,
    bases: ALL_BASES,
    inject: (db) => {
      const role = createRole(db)
      sqlOk(`GRANT '${role.user}'@'%' TO '${db.reader}'@'${db.host}'`)
      return {}
    },
  },
  {
    name: 'the reader takes part in a proxy grant (D119)',
    expect: /the reader takes part in a proxy grant/,
    needsReader: true,
    bases: ALL_BASES,
    inject: (db) => {
      const other = createAccount(db)
      sqlOk(`GRANT PROXY ON '${other.user}'@'%' TO '${db.reader}'@'${db.host}'`)
      return {}
    },
  },
  {
    name: 'another account could match a reader login (D119)',
    expect: /another account could match a reader login/,
    bases: ALL_BASES,
    inject: (db) => {
      db.extras.push({ user: db.reader, host: '10.9.8.7' })
      sqlOk(`CREATE USER '${db.reader}'@'10.9.8.7'`)
      return {}
    },
  },
  {
    name: 'mandatory_roles is set (D120)',
    expect: /mandatory_roles is set/,
    bases: ALL_BASES,
    inject: (db) => {
      const role = createRole(db)
      sqlOk(`SET GLOBAL mandatory_roles = '${role.user}@%'`)
      return { undo: () => sqlOk(`SET GLOBAL mandatory_roles = ''`) }
    },
  },
]

describe('D155, D95: a client that runs past errors (mysql --force) after a refusal', () => {
  const cases = INJECTIONS.flatMap((injection) =>
    injection.bases.map((base) => [injection.name, base, injection] as const),
  )
  it.each(cases)(
    '%s, views database %s: grants nothing more, builds nothing',
    async (_n, base, injection) => {
      const db = await newDb()
      // The reader as a deployment may already have left it (deployed) or not at all.
      prepareBase(db, base)
      // Injection first: some of them (reader role, proxy) need the reader account to exist.
      if (readerAccounts(db) === 0 && injection.needsReader === true) {
        sqlOk(`CREATE USER '${db.reader}'@'${db.host}' ACCOUNT LOCK`)
      }
      const setup = injection.inject(db)
      try {
        const grantsBefore = readerGrants(db)
        const stateBefore = viewsState(db)
        const accountsBefore = readerAccounts(db)
        const target = setup.connectToViews ? { ...db, name: db.views } : db
        const result = runScript(target, `${setup.prefix ?? ''}${applyScript(db)}`, {
          force: true,
          as: setup.as,
        })
        // The refusal (or the deployer's lack of rights) reached the client; status is not asserted.
        expect(result.stderr).toMatch(injection.expect)
        expect(readerGrants(db).filter((grant) => !grantsBefore.includes(grant))).toEqual([])
        expect(readerAccounts(db)).toBeLessThanOrEqual(accountsBefore)
        expect(viewsState(db)).toBe(stateBefore)
      } finally {
        setup.undo?.()
      }
    },
  )

  it('D115: a views database without the marker keeps its tables and gets no views and no reader grant', async () => {
    const db = await newDb()
    prepareBase(db, 'foreign')
    const result = runScript(db, applyScript(db), { force: true })
    expect(result.stderr).toContain('has no hyde-db marker')
    expect(sqlOk(`SELECT a FROM t`, { database: db.views })).toBe('')
    expect(viewsState(db)).toBe('1\nt BASE TABLE\n')
    expect(readerGrants(db)).toEqual([])
  })
})

describe('A74, D101: a refused re-apply', () => {
  it('leaves the reader no more than before (without --force the script stops at the refusal)', async () => {
    const db = await newDb()
    expect(deploy(db).status).toBe(0)
    const role = createRole(db)
    sqlOk(`GRANT '${role.user}'@'%' TO '${db.reader}'@'${db.host}'`)
    const before = readerGrants(db)
    const stateBefore = viewsState(db)
    const result = deploy(db)
    expect(result.status).not.toBe(0)
    expect(readerGrants(db).filter((grant) => !before.includes(grant))).toEqual([])
    expect(viewsState(db)).toBe(stateBefore)
  })
})
