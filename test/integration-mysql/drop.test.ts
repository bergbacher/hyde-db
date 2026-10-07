// Attack suite A, part 3: the drop script (A74, D100, D115, D119, D121).
import { describe, expect, it } from 'vitest'
import {
  count,
  deploy,
  query,
  readerGrants,
  refusal,
  runScript,
  schemaExists,
  type TestDb,
  trackTestDbs,
  unlockReader,
  viewGrants,
} from './helpers/db.ts'

const { newDb } = trackTestDbs()

const dropScript = (db: TestDb) => runScript(db, db.files['redacted-views-drop.sql'])

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
    const { message, fix } = refusal(dropScript(db))
    expect(message).toContain('has no hyde-db marker view')
    expect(count(`SELECT id FROM \`${db.views}\`.keep`)).toBe('7')
    expect(readerGrants(db)).toEqual(before)
    // The remedy: drop the foreign database (or choose another "schema"); the drop then runs green.
    expect(fix).toContain('drop or rename it')
    expect(query(`DROP DATABASE \`${db.views}\``).status).toBe(0)
    const again = dropScript(db)
    expect(again.status, again.stderr).toBe(0)
    expect(readerGrants(db)).toEqual([])
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
    expect(readerGrants(db)).toEqual(viewGrants(db))
  })
})
