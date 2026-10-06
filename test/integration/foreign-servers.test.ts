// D80: USAGE on a foreign server lets the reader reach source tables through a temporary foreign
// table and the server's user mapping (A62); the final check refuses it.
import { afterEach, describe, expect, it } from 'vitest'
import {
  adminQuery,
  apply,
  connectAsReader,
  createTestDatabase,
  dropTestDatabase,
  pasteFixAndReapply,
  type TestDb,
} from './helpers/db.ts'

const created: TestDb[] = []
afterEach(async () => {
  for (const db of created.splice(0)) await dropTestDatabase(db)
})
async function freshDb(): Promise<TestDb> {
  const db = await createTestDatabase()
  created.push(db)
  return db
}

const FOREIGN_TABLE =
  "CREATE FOREIGN TABLE pg_temp.k (id integer, secret text) SERVER loop OPTIONS (schema_name 'public', table_name 'api_keys')"

describe('foreign servers', () => {
  it('A62, D80: USAGE on a foreign server for PUBLIC aborts apply; after the fix the reader cannot create a foreign table on it', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    await adminQuery(
      db.name,
      `CREATE EXTENSION postgres_fdw;
       CREATE SERVER loop FOREIGN DATA WRAPPER postgres_fdw OPTIONS (dbname '${db.name}');
       GRANT USAGE ON FOREIGN SERVER loop TO PUBLIC;
       CREATE USER MAPPING FOR PUBLIC SERVER loop OPTIONS (user 'nobody', password 'secret')`,
    )
    const reader = await connectAsReader(db)
    try {
      await reader.query('SET default_transaction_read_only = off')
      // With USAGE the reader can define a foreign table over a source table (A62).
      await reader.query(FOREIGN_TABLE)
      await reader.query('DROP FOREIGN TABLE pg_temp.k')
      const failed = apply(db)
      expect(failed.status).toBe(3)
      expect(failed.stderr).toContain(
        `role ${db.role} can use foreign servers: loop. Fix: REVOKE USAGE ON FOREIGN SERVER loop FROM PUBLIC CASCADE;`,
      )
      pasteFixAndReapply(db, failed)
      await expect(reader.query(FOREIGN_TABLE)).rejects.toMatchObject({ code: '42501' })
    } finally {
      await reader.end()
    }
  })
})
