import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createAccount,
  createRole,
  createTestDb,
  deploy,
  dropTestDb,
  query,
  readerGrants,
  runScript,
  server,
  splitStatements,
  type TestDb,
  unlockReader,
} from './helpers/db.ts'

const created: TestDb[] = []
async function newDb(options?: Parameters<typeof createTestDb>[0]): Promise<TestDb> {
  const db = await createTestDb(options)
  created.push(db)
  return db
}
afterEach(async () => {
  for (const db of created.splice(0)) await dropTestDb(db)
})

describe('MySQL integration harness', () => {
  it('D22: a MySQL server of the requested image answers', () => {
    expect(query('SELECT @@version').stdout.startsWith(server().image.split(':')[1] ?? '')).toBe(
      true,
    )
  })

  it('D43: the generated apply script runs under the mysql client inside the container', async () => {
    const db = await newDb()
    expect(deploy(db).status).toBe(0)
    expect(readerGrants(db)).toEqual([
      `table: ${db.views}.orders Select|`,
      `table: ${db.views}.users Select|`,
    ])
  })

  it('D43: unique names per test, and the example tables are loaded in the source database', async () => {
    const a = await newDb()
    const b = await newDb()
    expect(new Set([a.name, b.name, a.views, b.views, a.reader, b.reader]).size).toBe(6)
    expect(query('SELECT country FROM users', { database: a.name }).stdout.trim()).toBe('DE')
  })

  it('D43: a failing statement under --force does not stop the script, and without it does', async () => {
    const db = await newDb()
    const stopped = runScript(db, 'SELECT nope; SELECT 22;')
    expect(stopped.status).not.toBe(0)
    expect(stopped.stdout).not.toContain('22')
    const forced = runScript(db, 'SELECT nope; SELECT 22;', { force: true })
    expect(forced.stderr).toContain('ERROR')
    expect(forced.stdout).toContain('22')
  })

  it('D43: an account other than root runs a script with its own credentials', async () => {
    const db = await newDb()
    expect(deploy(db).status).toBe(0)
    unlockReader(db, 'pw-reader')
    const result = query('SELECT CURRENT_USER()', {
      as: { user: db.reader, password: 'pw-reader' },
      database: db.views,
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe(`${db.reader}@${db.host}`)
  })

  it('D43: readerGrants sees a grant of every kind the reader can have, and only those', async () => {
    const db = await newDb()
    expect(deploy(db).status).toBe(0)
    const other = createAccount(db)
    const role = createRole(db)
    const reader = `'${db.reader}'@'${db.host}'`
    const seed = query(
      [
        `CREATE PROCEDURE \`${db.name}\`.p() SELECT 1;`,
        `GRANT PROCESS ON *.* TO ${reader};`,
        `GRANT SYSTEM_VARIABLES_ADMIN ON *.* TO ${reader} WITH GRANT OPTION;`,
        `GRANT SELECT ON \`${db.name}\`.* TO ${reader};`,
        `GRANT INSERT ON \`${db.name}\`.users TO ${reader};`,
        `GRANT SELECT (id) ON \`${db.name}\`.orders TO ${reader};`,
        `GRANT EXECUTE ON PROCEDURE \`${db.name}\`.p TO ${reader};`,
        `GRANT PROXY ON '${other.user}'@'%' TO ${reader};`,
        `GRANT PROXY ON ${reader} TO '${other.user}'@'%';`,
        `GRANT '${role.user}'@'%' TO ${reader};`,
        `SET DEFAULT ROLE '${role.user}'@'%' TO ${reader};`,
        `GRANT '${db.reader}'@'${db.host}' TO '${other.user}'@'%';`,
      ].join('\n'),
    )
    expect(seed.status, seed.stderr).toBe(0)
    const grants = readerGrants(db)
    expect(grants).toEqual([...grants].sort())
    expect(grants).toEqual(
      [
        'global: process_priv',
        'dynamic: SYSTEM_VARIABLES_ADMIN WITH GRANT OPTION',
        `db: ${db.name} select_priv`,
        `table: ${db.views}.orders Select|`,
        `table: ${db.views}.users Select|`,
        `table: ${db.name}.users Insert|`,
        `table: ${db.name}.orders |Select`,
        `column: ${db.name}.orders.id Select`,
        `routine: ${db.name}.p Execute`,
        `proxy: ${db.reader}@${db.host} -> ${other.user}@%`,
        `proxy: ${other.user}@% -> ${db.reader}@${db.host}`,
        `role: ${role.user}@% -> ${db.reader}@${db.host}`,
        `role: ${db.reader}@${db.host} -> ${other.user}@%`,
        `default role: ${role.user}@% -> ${db.reader}@${db.host}`,
      ].sort(),
    )
  })

  it('D43: dropTestDb drops the databases, the reader, extra accounts and roles, and their grants', async () => {
    const db = await createTestDb()
    expect(deploy(db).status).toBe(0)
    const other = createAccount(db, { grants: [`SELECT ON \`${db.name}\`.users`], password: 'pw' })
    const role = createRole(db)
    expect(query(`GRANT '${role.user}'@'%' TO '${other.user}'@'%';`).status).toBe(0)
    const users = [db.reader, other.user, role.user].map((u) => `'${u}'`).join(', ')
    const count = (sql: string) => query(sql).stdout.trim()
    expect(count(`SELECT COUNT(*) FROM mysql.user WHERE User IN (${users})`)).toBe('3')
    await dropTestDb(db)
    expect(count(`SELECT COUNT(*) FROM mysql.user WHERE User IN (${users})`)).toBe('0')
    expect(count(`SELECT COUNT(*) FROM mysql.tables_priv WHERE User IN (${users})`)).toBe('0')
    expect(count(`SELECT COUNT(*) FROM mysql.db WHERE User IN (${users})`)).toBe('0')
    expect(
      count(
        `SELECT COUNT(*) FROM mysql.role_edges WHERE TO_USER IN (${users}) OR FROM_USER IN (${users})`,
      ),
    ).toBe('0')
    expect(
      count(
        `SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME IN ('${db.name}', '${db.views}')`,
      ),
    ).toBe('0')
  })

  it('A76: splitStatements keeps a ; inside a literal and a backtick name in one statement', () => {
    expect(splitStatements("SET @a = 'x;y';\nSELECT `a;b`; -- c;\n")).toEqual([
      "SET @a = 'x;y'",
      'SELECT `a;b`',
    ])
  })

  it('A76: splitStatements drops --, # and /* */ comments, also at the end and outside literals', () => {
    expect(splitStatements("SELECT 1; --\nSELECT 2; # x;\n/* y; */ SELECT '#;--'; -- end")).toEqual(
      ['SELECT 1', 'SELECT 2', "SELECT '#;--'"],
    )
  })

  it('A76: splitStatements keeps a doubled quote inside a literal and returns an unterminated tail', () => {
    expect(splitStatements("SELECT 'it''s;'; SELECT 1")).toEqual(["SELECT 'it''s;'", 'SELECT 1'])
  })

  it.each([
    ['exits 125 (docker daemon error)', 'exit 125', /exit status 125/],
    [
      'reports an error response from the daemon',
      "echo 'Error response from daemon: gone' >&2; exit 1",
      /Error response from daemon: gone/,
    ],
    ['is killed by a signal', 'kill -KILL $$', /signal SIGKILL/],
  ])(
    'D22: a docker anomaly throws instead of returning a result (docker %s)',
    async (_name, body, message) => {
      const db = await newDb()
      const dir = mkdtempSync(join(tmpdir(), 'hyde-fake-docker-'))
      try {
        writeFileSync(join(dir, 'docker'), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
        vi.stubEnv('PATH', dir)
        expect(() => runScript(db, 'SELECT 1')).toThrow(message)
      } finally {
        vi.unstubAllEnvs()
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  it('D22: a missing docker CLI fails loudly with an actionable message', async () => {
    const db = await newDb()
    vi.stubEnv('PATH', '/nonexistent-hyde-db-no-docker')
    try {
      expect(() => runScript(db, 'SELECT 1')).toThrow(/need the docker CLI on PATH/)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
