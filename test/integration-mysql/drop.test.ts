// Attack suite A, part 3: the drop script (A74, D100, D115, D119, D121).
import { afterEach, describe, expect, it } from 'vitest'
import {
  createTestDb,
  deploy,
  dropTestDb,
  query,
  readerGrants,
  runScript,
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

const dropScript = (db: TestDb) => runScript(db, db.files['redacted-views-drop.sql'])
const count = (sql: string) => query(sql).stdout.trim()
const schemaExists = (name: string) =>
  count(`SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '${name}'`) === '1'

describe('MySQL drop script', () => {
  it("D100, A74: drop removes the views database and the reader's view grants, so a re-created view name is not re-granted", async () => {
    const db = await newDb()
    expect(deploy(db).status).toBe(0)
    unlockReader(db, 'pw-reader-1')
    expect(readerGrants(db)).toHaveLength(2)
    const result = dropScript(db)
    expect(result.status, result.stderr).toBe(0)
    expect(schemaExists(db.views)).toBe(false)
    expect(readerGrants(db)).toEqual([])
    // Someone re-creates a view of the same name in a new database of the same name: no grant comes back.
    expect(
      query(
        `CREATE DATABASE \`${db.views}\`; CREATE VIEW \`${db.views}\`.users AS SELECT id, email FROM \`${db.name}\`.users;`,
      ).status,
    ).toBe(0)
    const denied = query('SELECT * FROM users', {
      as: { user: db.reader, password: 'pw-reader-1' },
      database: db.views,
    })
    expect(denied.status).not.toBe(0)
    expect(denied.stdout).toBe('')
    expect(count(`SELECT COUNT(*) FROM mysql.tables_priv WHERE User = '${db.reader}'`)).toBe('0')
  })

  it('D121: drop succeeds when the views database is already gone and still revokes the grants', async () => {
    const db = await newDb()
    expect(deploy(db).status).toBe(0)
    expect(query(`DROP DATABASE \`${db.views}\``).status).toBe(0)
    expect(readerGrants(db)).toHaveLength(2) // the grants outlive the database
    const result = dropScript(db)
    expect(result.status, result.stderr).toBe(0)
    expect(readerGrants(db)).toEqual([])
    const second = dropScript(db)
    expect(second.status, second.stderr).toBe(0)
  })

  it('D115: drop refuses a views database without the marker, changing nothing', async () => {
    const db = await newDb()
    expect(deploy(db).status).toBe(0)
    // Replace the views database with a foreign one of the same name, keeping a reader grant on it.
    expect(
      query(
        `DROP DATABASE \`${db.views}\`; CREATE DATABASE \`${db.views}\`; CREATE TABLE \`${db.views}\`.keep (id INT); INSERT INTO \`${db.views}\`.keep VALUES (7);`,
      ).status,
    ).toBe(0)
    const before = readerGrants(db)
    expect(before).toHaveLength(2)
    const result = dropScript(db)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('ERROR 1366')
    expect(result.stderr).toContain('hyde-db:')
    expect(result.stderr).toContain('Fix:')
    const message = /'(hyde-db: .*? Fix: .*?)'(?: for column|$)/m.exec(result.stderr)?.[1] ?? ''
    expect(message.length).toBeGreaterThan(0)
    expect(message.length).toBeLessThanOrEqual(128)
    expect(count(`SELECT id FROM \`${db.views}\`.keep`)).toBe('7')
    expect(readerGrants(db)).toEqual(before)
  })

  it('D119: drop succeeds when the reader account does not exist', async () => {
    const db = await newDb()
    expect(deploy(db).status).toBe(0)
    expect(query(`DROP USER '${db.reader}'@'${db.host}'`).status).toBe(0)
    const result = dropScript(db)
    expect(result.status, result.stderr).toBe(0)
    expect(schemaExists(db.views)).toBe(false)
    const never = await newDb()
    const fresh = dropScript(never)
    expect(fresh.status, fresh.stderr).toBe(0)
  })

  it('D100: after a drop a deploy rebuilds everything and the reader is granted again', async () => {
    const db = await newDb()
    expect(deploy(db).status).toBe(0)
    expect(dropScript(db).status).toBe(0)
    const result = deploy(db)
    expect(result.status, result.stderr).toBe(0)
    expect(readerGrants(db)).toEqual([
      `table: ${db.views}.orders Select|`,
      `table: ${db.views}.users Select|`,
    ])
  })
})
