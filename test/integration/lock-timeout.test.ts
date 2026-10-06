// D92: a reader that holds a lock on a view makes the apply and drop scripts fail at lock_timeout
// instead of waiting for it forever (A72); the failed script changes nothing.
import { afterEach, describe, expect, it } from 'vitest'
import {
  adminQuery,
  apply,
  connectAsReader,
  createTestDatabase,
  dropTestDatabase,
  psql,
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

const LOCK_TIMEOUT = "SET lock_timeout = '60s';"

/** The script as generated, with its lock_timeout shortened so the test waits 1s rather than 60s. */
function withShortLockTimeout(script: string): string {
  expect(script.split('\n')).toContain(LOCK_TIMEOUT)
  return script.replace(LOCK_TIMEOUT, "SET lock_timeout = '1s';")
}

/** The OID of the view redacted.users, which changes whenever the script recreates the schema. */
async function viewOid(db: TestDb): Promise<unknown> {
  const [row] = await adminQuery(db.name, "SELECT 'redacted.users'::regclass::oid AS oid")
  return row?.oid
}

describe('lock_timeout', () => {
  for (const file of ['redacted-views.sql', 'redacted-views-drop.sql'] as const) {
    it(`A72, D92: a reader holding a transaction open on a view makes ${file} fail at lock_timeout, changing nothing`, async () => {
      const db = await freshDb()
      expect(apply(db).status).toBe(0)
      const before = await viewOid(db)
      const reader = await connectAsReader(db)
      try {
        await reader.query('BEGIN')
        await reader.query('SELECT * FROM redacted.users')
        const failed = psql(db.name, withShortLockTimeout(db.files[file]))
        expect(failed.status).toBe(3)
        expect(failed.stderr).toContain('canceling statement due to lock timeout')
        expect(await viewOid(db)).toBe(before)
      } finally {
        await reader.query('ROLLBACK')
        await reader.end()
      }
      // Once the reader's transaction has ended, the script as generated runs.
      const result = psql(db.name, db.files[file])
      expect(result.status, result.stderr).toBe(0)
    })
  }
})
