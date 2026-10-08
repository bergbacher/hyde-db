// Attack suite A, part 1: the deploy lifecycle against a real MySQL server (A74, A75, A78, A85, A86, D104, D116, D119).
import { describe, expect, it } from 'vitest'
import {
  createAccount,
  deploy,
  query,
  readerGrants,
  refusal,
  runScript,
  type TestDb,
  trackTestDbs,
  unlockReader,
  viewGrants,
} from './helpers/db.ts'

const { newDb, replaceLast } = trackTestDbs()

const PASSWORD = 'pw-reader-1'
const asReader = (db: TestDb) => ({ user: db.reader, password: PASSWORD })
const accountState = (db: TestDb) =>
  query(
    `SELECT account_locked, HEX(authentication_string), plugin FROM mysql.user WHERE User='${db.reader}' AND Host='${db.host}'`,
  ).stdout.trim()

/** Prisma schema with one model mapped to `table` whose visible column is mapped to `column` (names given as Prisma string-literal text). */
const oddSchema = (table: string, column: string, hidden = false) => `
generator redacted {
  provider = "hyde-db"
}
datasource db {
  provider = "mysql"
}
model Odd {
  /// @hyde.${hidden ? 'hidden' : 'visible'}
  id   Int    @id
  /// @hyde.${hidden ? 'hidden' : 'visible'}
  note String @map("${column}")

  @@map("${table}")
}
`

describe('MySQL deploy lifecycle', () => {
  it('A74, D95: a first deploy creates the locked account and grants it SELECT on the views only', async () => {
    const db = await newDb()
    const result = deploy(db)
    expect(result.status, result.stderr).toBe(0)
    expect(readerGrants(db)).toEqual(viewGrants(db))
    expect(
      query(`SELECT account_locked FROM mysql.user WHERE User='${db.reader}'`).stdout.trim(),
    ).toBe('Y')
    expect(
      query(
        `SELECT COUNT(*) FROM mysql.user WHERE User='${db.reader}' AND plugin <> ''`,
      ).stdout.trim(),
    ).toBe('1')
  })

  it('D116, A85: a login unlocked once survives every re-apply (password and lock state unchanged)', async () => {
    const db = await newDb()
    expect(deploy(db).status).toBe(0)
    unlockReader(db, PASSWORD)
    const before = accountState(db)
    expect(before.startsWith('N\t')).toBe(true)
    for (let i = 0; i < 2; i++) {
      const again = deploy(db)
      expect(again.status, again.stderr).toBe(0)
      expect(accountState(db)).toBe(before)
      const selected = query('SELECT country, plan FROM users', {
        as: asReader(db),
        database: db.views,
      })
      expect(selected.status, selected.stderr).toBe(0)
      expect(selected.stdout.trim()).toBe('DE\tPRO')
    }
    expect(readerGrants(db)).toEqual(viewGrants(db))
  })

  it('A78, D101: the reader sees only the views in information_schema and cannot select outside them', async () => {
    const db = await newDb()
    expect(deploy(db).status).toBe(0)
    unlockReader(db, PASSWORD)
    const as = asReader(db)
    const tables = query(
      "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA NOT IN ('information_schema', 'performance_schema') ORDER BY TABLE_NAME",
      { as },
    )
    expect(tables.status, tables.stderr).toBe(0)
    expect(tables.stdout.trim().split('\n')).toEqual([
      `${db.views}\torders\tVIEW`,
      `${db.views}\tusers\tVIEW`,
    ])
    const columns = query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = '${db.views}' AND TABLE_NAME = 'users' ORDER BY ORDINAL_POSITION`,
      { as },
    )
    expect(columns.stdout.trim().split('\n')).toEqual(['id', 'created_at', 'country', 'plan'])
    const schemata = query(
      "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN ('information_schema', 'performance_schema')",
      { as },
    )
    expect(schemata.stdout.trim()).toBe(db.views)
    for (const sql of [
      `SELECT * FROM \`${db.name}\`.users`,
      `SELECT * FROM \`${db.name}\`.api_keys`,
      `SELECT * FROM \`${db.views}\`.hyde_db_marker`,
      'SELECT email FROM users',
      'SELECT * FROM mysql.user',
    ]) {
      const denied = query(sql, { as, database: db.views })
      expect(denied.status, sql).not.toBe(0)
      expect(denied.stderr, sql).toMatch(/ERROR (1142|1044|1054)/)
      expect(denied.stdout, sql).toBe('')
    }
  })

  it('A75: a view fails closed when its definer breaks', async () => {
    const db = await newDb()
    const deployer = createAccount(db, {
      grants: ['ALL PRIVILEGES ON *.*', 'GRANT OPTION ON *.*'],
      password: 'pw-deployer',
    })
    const run = runScript(db, db.files['redacted-views.sql'], {
      as: { user: deployer.user, password: deployer.password },
    })
    expect(run.status, run.stderr).toBe(0)
    unlockReader(db, PASSWORD)
    const as = asReader(db)
    expect(query('SELECT COUNT(*) FROM users', { as, database: db.views }).stdout.trim()).toBe('1')
    expect(query(`DROP USER '${deployer.user}'@'%'`).status).toBe(0)
    const broken = query('SELECT * FROM users', { as, database: db.views })
    expect(broken.status).not.toBe(0)
    // Recorded on mysql:8.4 (8.4.11) and mysql:9.7 (9.7.2): both answer a view whose definer account is gone with ERROR 1045.
    expect(broken.stderr).toContain(
      `ERROR 1045 (28000) at line 1: Access denied for user '${db.reader}'`,
    )
    expect(query('SELECT 1', { as, database: db.views }).stdout.trim()).toBe('1') // the login itself still works
    expect(broken.stdout).toBe('')
  })

  it('D119, A86: a first deploy (account absent) passes the reset; the apply never errors 1269', async () => {
    const db = await newDb()
    expect(query(`SELECT COUNT(*) FROM mysql.user WHERE User='${db.reader}'`).stdout.trim()).toBe(
      '0',
    )
    for (let i = 0; i < 2; i++) {
      const result = deploy(db)
      expect(result.status, result.stderr).toBe(0)
      expect(result.stderr).not.toContain('1269')
    }
    // The account dropped and the apply repeated: the reset runs against an absent account again.
    expect(query(`DROP USER '${db.reader}'@'${db.host}'`).status).toBe(0)
    const third = deploy(db)
    expect(third.status, third.stderr).toBe(0)
    expect(readerGrants(db)).toEqual(viewGrants(db))
  })

  it('D104, Review Focus 2: a table and column named with a backtick, a quote and a backslash deploy and select correctly', async () => {
    const table = "t`b'q\\x"
    const column = "c`o'l\\y"
    const db = await newDb({
      schemaSource: oddSchema(table.replaceAll('\\', '\\\\'), column.replaceAll('\\', '\\\\')),
    })
    const ident = (name: string) => `\`${name.replaceAll('`', '``')}\``
    const setup = runScript(
      db,
      `CREATE TABLE ${ident(table)} (id INT PRIMARY KEY, ${ident(column)} VARCHAR(20) NOT NULL); INSERT INTO ${ident(table)} VALUES (1, 'it''s \\\\ fine');`,
    )
    expect(setup.status, setup.stderr).toBe(0)
    const result = deploy(db)
    expect(result.status, result.stderr).toBe(0)
    unlockReader(db, PASSWORD)
    const selected = query(`SELECT ${ident(column)} FROM ${ident(table)}`, {
      as: asReader(db),
      database: db.views,
    })
    expect(selected.status, selected.stderr).toBe(0)
    expect(selected.stdout.trim()).toBe("it's \\\\ fine")
    expect(readerGrants(db)).toEqual([
      // the client's batch output escapes a backslash
      `table: ${db.views}.${table.replaceAll('\\', '\\\\')} Select|`,
    ])
  })

  it('Review Focus 5: zero visible views deploys the marker view only and the reader holds no grant', async () => {
    const db = await newDb({ schemaSource: oddSchema('only_hidden', 'note', true) })
    const result = deploy(db)
    expect(result.status, result.stderr).toBe(0)
    expect(readerGrants(db)).toEqual([])
    expect(
      query(
        `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${db.views}'`,
      ).stdout.trim(),
    ).toBe('hyde_db_marker')
    expect(
      query(`SELECT account_locked FROM mysql.user WHERE User='${db.reader}'`).stdout.trim(),
    ).toBe('Y')
  })

  it('Review Focus 5: names at 64 / 32 / 60 characters deploy; every abort message in this suite is at most 128 characters', async () => {
    const pad = (prefix: string, length: number) => prefix.padEnd(length, 'z')
    const unique = Math.random().toString(16).slice(2, 10)
    const views = pad(`v_${unique}_`, 64)
    const role = pad(`r_${unique}_`, 32)
    const host = pad(`h${unique}.`, 60)
    const table = pad('t_', 64)
    const column = pad('c_', 64)
    const made = await newDb({
      schemaSource: oddSchema(table, column),
      config: { schema: views, role, readerHost: host },
    })
    const db: TestDb = { ...made, views, reader: role, host }
    replaceLast(db)
    const setup = runScript(
      db,
      `CREATE TABLE \`${table}\` (id INT PRIMARY KEY, \`${column}\` VARCHAR(20) NOT NULL); INSERT INTO \`${table}\` VALUES (1, 'long');`,
    )
    expect(setup.status, setup.stderr).toBe(0)
    const result = deploy(db)
    expect(result.status, result.stderr).toBe(0)
    expect(readerGrants(db)).toEqual([`table: ${views}.${table} Select|`])
    expect(views).toHaveLength(64)
    // A refusal at maximal lengths: the fix falls back to prose (D161) and still fits.
    const seeded = createAccount(db)
    expect(query(`GRANT PROXY ON '${seeded.user}'@'%' TO '${role}'@'${host}'`).status).toBe(0)
    const refused = deploy(db)
    expect(refused.status).not.toBe(0)
    const { message, fix } = refusal(refused) // at most 128 characters, checked by refusal
    expect(message).toContain('the reader takes part in a proxy grant')
    expect(fix).not.toMatch(/^REVOKE /) // too long to paste at maximal lengths: prose
  })
})
