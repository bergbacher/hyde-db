// D75: the reader must not read other roles' large objects, through their ACL or because
// lo_compat_privileges turns the checks off (A58).
import { PostgreSqlContainer } from '@testcontainers/postgresql'
import { afterEach, describe, expect, inject, it } from 'vitest'
import { readRepoFile } from '../helpers/files.ts'
import {
  adminQuery,
  apply,
  buildFiles,
  createTestDatabase,
  dropTestDatabase,
  pasteFixAndReapply,
  psql,
  suggestedFix,
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
const COMPAT = 'lo_compat_privileges is on, which turns off privilege checks on large objects'

describe('large objects', () => {
  it("D75: an ACL entry for the reader or PUBLIC on another role's large object aborts apply, and the printed REVOKEs fix it", async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    const [first, second] = await adminQuery(
      db.name,
      "SELECT lo_from_bytea(0, 'one') AS oid UNION ALL SELECT lo_from_bytea(0, 'two') ORDER BY 1",
    )
    await adminQuery(
      db.name,
      `GRANT SELECT ON LARGE OBJECT ${first?.oid} TO PUBLIC;
       GRANT SELECT, UPDATE ON LARGE OBJECT ${second?.oid} TO "${db.role}"`,
    )
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(failed.stderr).toContain(
      `role ${db.role} can read large objects it does not own: ${first?.oid}, ${second?.oid}. Fix: `,
    )
    expect(suggestedFix(failed)).toBe(
      `REVOKE ALL ON LARGE OBJECT ${first?.oid} FROM PUBLIC CASCADE; REVOKE ALL ON LARGE OBJECT ${second?.oid} FROM ${db.role} CASCADE;`,
    )
    pasteFixAndReapply(db, failed)
  })

  it('D75: lo_compat_privileges set for the database aborts apply, and the printed fix resets it', async () => {
    const db = await freshDb()
    await adminQuery('postgres', `ALTER DATABASE ${db.name} SET lo_compat_privileges = on`)
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(failed.stderr).toContain(
      `${COMPAT} for role ${db.role}. Fix: ALTER DATABASE ${db.name} RESET lo_compat_privileges; -- run as a superuser`,
    )
    pasteFixAndReapply(db, failed)
  })

  it('D75: lo_compat_privileges turned on server-wide aborts apply, and the printed ALTER SYSTEM fixes it', async () => {
    // A server-wide setting would reach the applies of the other test files, so this test gets
    // a server of its own, which it throws away afterwards.
    const container = await new PostgreSqlContainer(inject('pg').image).start()
    try {
      const server = { containerId: container.getId(), user: container.getUsername() }
      const database = container.getDatabase()
      const run = (script: string) => psql(database, script, { server })
      /** Waits until a new session sees the setting (pg_reload_conf only signals the server). */
      const settled = async (value: string): Promise<void> => {
        for (let attempt = 0; attempt < 50; attempt++) {
          const shown = run("SELECT 'setting=' || current_setting('lo_compat_privileges');")
          if (shown.stdout.includes(`setting=${value}`)) return
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        throw new Error(`lo_compat_privileges did not become ${value}`)
      }
      const role = 'hyde_compat_reader'
      const script = buildFiles(role)['redacted-views.sql']
      const tables = readRepoFile('test', 'fixtures', 'sql', 'example-tables.sql')
      expect(run(`${tables}\nREVOKE CREATE ON SCHEMA public FROM PUBLIC;`).status).toBe(0)
      expect(
        run('ALTER SYSTEM SET lo_compat_privileges = on;\nSELECT pg_reload_conf();').status,
      ).toBe(0)
      await settled('on')
      const failed = run(script)
      expect(failed.status).toBe(3)
      expect(failed.stderr).toContain(
        `${COMPAT} for role ${role}. Fix: ALTER SYSTEM SET lo_compat_privileges = off; SELECT pg_reload_conf(); -- run as a superuser`,
      )
      expect(run(suggestedFix(failed)).status).toBe(0)
      await settled('off')
      const reapplied = run(script)
      expect(reapplied.status, reapplied.stderr).toBe(0)
    } finally {
      await container.stop()
    }
  })
})
