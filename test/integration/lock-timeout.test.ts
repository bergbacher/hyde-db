// D110: a reader that holds a lock on a view makes the apply and drop scripts fail at lock_timeout
// instead of waiting for it forever (A72); the failed script changes nothing, and the setting does
// not outlive the script (A84). D131: no setting the scripts make outlives them.
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

const LOCK_TIMEOUT = "SET LOCAL lock_timeout = '60s';"

/** The script as generated, with its lock_timeout shortened so the test waits 1s rather than 60s. */
function withShortLockTimeout(script: string): string {
  expect(script.split('\n')).toContain(LOCK_TIMEOUT)
  return script.replace(LOCK_TIMEOUT, "SET LOCAL lock_timeout = '1s';")
}

/** The OID of the view redacted.users, which changes whenever the script recreates the schema. */
async function viewOid(db: TestDb): Promise<unknown> {
  const [row] = await adminQuery(db.name, "SELECT 'redacted.users'::regclass::oid AS oid")
  return row?.oid
}

describe('lock_timeout', () => {
  for (const file of ['redacted-views.sql', 'redacted-views-drop.sql'] as const) {
    it(`A72, D110: a reader holding a transaction open on a view makes ${file} fail at lock_timeout, changing nothing`, async () => {
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
      // Once the reader's transaction has ended, the script as generated runs, and its
      // lock_timeout ends with its transaction instead of staying with the session (A84).
      const result = psql(
        db.name,
        `${db.files[file]}\nSELECT 'after=' || current_setting('lock_timeout');`,
      )
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain('after=0')
    })
  }
})

describe('session settings', () => {
  for (const file of ['redacted-views.sql', 'redacted-views-drop.sql'] as const) {
    it(`D131: ${file} sets client_min_messages for its own transaction only, and no notice leaks before it`, async () => {
      const db = await freshDb()
      const [server] = await adminQuery(
        db.name,
        "SELECT reset_val FROM pg_settings WHERE name = 'client_min_messages'",
      )
      // Run twice in one session: without the views schema (DROP SCHEMA IF EXISTS notices that it
      // skips) and with it (DROP SCHEMA … CASCADE notices what it drops); the drop script runs
      // after an apply, so it meets the schema first.
      const show = (label: string): string =>
        `SELECT '${label}=' || current_setting('client_min_messages');`
      const runs =
        file === 'redacted-views.sql'
          ? [db.files[file], db.files[file]]
          : [db.files['redacted-views.sql'], db.files[file], db.files[file]]
      const result = psql(
        db.name,
        runs.map((script, index) => `${script}\n${show(`after${index}`)}`).join('\n'),
      )
      expect(result.status, result.stderr).toBe(0)
      for (const index of runs.keys())
        expect(result.stdout).toContain(`after${index}=${server?.reset_val}`)
      expect(server?.reset_val).toBe('notice')
      expect(result.stderr).not.toContain('NOTICE')
    })
  }
})
