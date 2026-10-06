// D109: the reader must not read other roles' large objects, through their ACL or because
// lo_compat_privileges turns the checks off, from whichever source sets it (A58, A61, A70, A81).
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import { readRepoFile } from '../helpers/files.ts'
import {
  AS_SUPERUSER,
  adminQuery,
  apply,
  buildFiles,
  createTestDatabase,
  dropTestDatabase,
  inOneTransaction,
  type PsqlResult,
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
const SUPERUSER = ' -- run as a superuser'

describe('large objects', () => {
  it("D109: an ACL entry for the reader or PUBLIC on another role's large object aborts apply, and the printed REVOKEs fix it", async () => {
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
      inOneTransaction(
        `REVOKE ALL ON LARGE OBJECT ${first?.oid} FROM PUBLIC CASCADE; REVOKE ALL ON LARGE OBJECT ${second?.oid} FROM ${db.role} CASCADE;`,
      ),
    )
    pasteFixAndReapply(db, failed)
  })

  it('D109: lo_compat_privileges set for the database aborts apply, and the printed fix resets it', async () => {
    const db = await freshDb()
    await adminQuery('postgres', `ALTER DATABASE ${db.name} SET lo_compat_privileges = on`)
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(failed.stderr).toContain(
      `${COMPAT} for role ${db.role}: database ${db.name}. Fix: ALTER DATABASE ${db.name} RESET lo_compat_privileges;${SUPERUSER}`,
    )
    pasteFixAndReapply(db, failed)
  })

  it("A61, D109: lo_compat_privileges set for the reader's role, also in this database, aborts apply though the applying session does not see it", async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    await adminQuery(
      'postgres',
      `ALTER ROLE "${db.role}" SET lo_compat_privileges = on;
       ALTER ROLE "${db.role}" IN DATABASE ${db.name} SET lo_compat_privileges = true`,
    )
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(failed.stderr).toContain(
      `${COMPAT} for role ${db.role}: role ${db.role}, role ${db.role} in database ${db.name}. Fix: ${inOneTransaction(`ALTER ROLE ${db.role} RESET lo_compat_privileges; ALTER ROLE ${db.role} IN DATABASE ${db.name} RESET lo_compat_privileges;`)}${AS_SUPERUSER}`,
    )
    pasteFixAndReapply(db, failed)
  })
})

describe('lo_compat_privileges for the whole server', () => {
  // Server-wide and all-role settings would reach the applies of the other test files, so these
  // tests get a server of their own, which is thrown away afterwards.
  let container: StartedPostgreSqlContainer | undefined
  let run: (script: string) => PsqlResult = () => {
    throw new Error('the server has not started')
  }
  const role = 'hyde_compat_reader'
  let script = ''
  /** Waits until a new session sees the setting (pg_reload_conf only signals the server). */
  async function settled(value: string): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const shown = run("SELECT 'setting=' || current_setting('lo_compat_privileges');")
      if (shown.stdout.includes(`setting=${value}`)) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`lo_compat_privileges did not become ${value}`)
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(inject('pg').image).start()
    const server = { containerId: container.getId(), user: container.getUsername() }
    const database = container.getDatabase()
    run = (sql: string) => psql(database, sql, { server })
    script = buildFiles(role)['redacted-views.sql']
    const tables = readRepoFile('test', 'fixtures', 'sql', 'example-tables.sql')
    expect(run(`${tables}\nREVOKE CREATE ON SCHEMA public FROM PUBLIC;`).status).toBe(0)
  })
  afterAll(async () => {
    await container?.stop()
  })

  it('D109: lo_compat_privileges turned on with ALTER SYSTEM aborts apply, and the printed ALTER SYSTEM fixes it', async () => {
    expect(
      run('ALTER SYSTEM SET lo_compat_privileges = on;\nSELECT pg_reload_conf();').status,
    ).toBe(0)
    await settled('on')
    const failed = run(script)
    expect(failed.status).toBe(3)
    expect(failed.stderr).toContain(
      `${COMPAT} for role ${role}: the server configuration. Fix: ALTER SYSTEM SET lo_compat_privileges = off; SELECT pg_reload_conf();${SUPERUSER}`,
    )
    expect(run(suggestedFix(failed)).status).toBe(0)
    await settled('off')
    const reapplied = run(script)
    expect(reapplied.status, reapplied.stderr).toBe(0)
  })

  it('A61, D109: lo_compat_privileges set for all roles aborts apply, and the printed fix resets it for all roles', async () => {
    expect(run('ALTER ROLE ALL SET lo_compat_privileges = on;').status).toBe(0)
    const failed = run(script)
    expect(failed.status).toBe(3)
    expect(failed.stderr).toContain(
      `${COMPAT} for role ${role}: all roles. Fix: ALTER ROLE ALL RESET lo_compat_privileges;${SUPERUSER}`,
    )
    expect(run(suggestedFix(failed)).status).toBe(0)
    const reapplied = run(script)
    expect(reapplied.status, reapplied.stderr).toBe(0)
  })
})

describe('lo_compat_privileges on the server command line', () => {
  // A server started with `-c lo_compat_privileges=on` would make the other files' applies abort,
  // so this test gets a server of its own, which is thrown away afterwards.
  let container: StartedPostgreSqlContainer | undefined
  let run: (script: string, user?: string) => PsqlResult = () => {
    throw new Error('the server has not started')
  }
  const role = 'hyde_cmdline_reader'
  let script = ''

  beforeAll(async () => {
    container = await new PostgreSqlContainer(inject('pg').image)
      .withCommand(['postgres', '-c', 'lo_compat_privileges=on'])
      .start()
    const containerId = container.getId()
    const admin = container.getUsername()
    const database = container.getDatabase()
    run = (sql: string, user = admin) => psql(database, sql, { server: { containerId, user } })
    script = buildFiles(role)['redacted-views.sql']
    const tables = readRepoFile('test', 'fixtures', 'sql', 'example-tables.sql')
    // The reader logs in through the container's local socket to show what its sessions get.
    expect(
      run(`${tables}\nREVOKE CREATE ON SCHEMA public FROM PUBLIC;\nCREATE ROLE ${role} LOGIN;`)
        .status,
    ).toBe(0)
  })
  afterAll(async () => {
    await container?.stop()
  })

  /** lo_compat_privileges as a new session of the reader sees it. */
  function readerSetting(): string {
    const shown = run('\\t\n\\a\nSHOW lo_compat_privileges;', role)
    expect(shown.status, shown.stderr).toBe(0)
    return shown.stdout.trim()
  }

  it('A70, D109: lo_compat_privileges set on the server command line reaches the reader and aborts apply; the printed setting for the reader turns it off', () => {
    expect(readerSetting()).toBe('on')
    const failed = run(script)
    expect(failed.status).toBe(3)
    expect(failed.stderr).toContain(
      `${COMPAT} for role ${role}: the server command line. Fix: ALTER ROLE ${role} SET lo_compat_privileges = off;${SUPERUSER}`,
    )
    expect(run(suggestedFix(failed)).status).toBe(0)
    const reapplied = run(script)
    expect(reapplied.status, reapplied.stderr).toBe(0)
    expect(readerSetting()).toBe('off')
  })

  it('A81, D109: on a first deploy the fix creates the reader the failed apply rolled back, then turns lo_compat_privileges off for it', () => {
    const newRole = 'hyde_cmdline_new_reader'
    const exists = `SELECT 'exists=' || count(*) FROM pg_roles WHERE rolname = '${newRole}';`
    expect(run(exists).stdout).toContain('exists=0')
    const newScript = buildFiles(newRole)['redacted-views.sql']
    const failed = run(newScript)
    expect(failed.status).toBe(3)
    expect(failed.stderr).toContain(
      `${COMPAT} for role ${newRole}: the server command line. Fix: ${inOneTransaction(`CREATE ROLE ${newRole} NOLOGIN; ALTER ROLE ${newRole} SET lo_compat_privileges = off;`)}${AS_SUPERUSER}`,
    )
    // The apply created the role in its transaction, so the abort rolled the creation back (A81).
    expect(run(exists).stdout).toContain('exists=0')
    expect(run(suggestedFix(failed)).status).toBe(0)
    const reapplied = run(newScript)
    expect(reapplied.status, reapplied.stderr).toBe(0)
    const shown = run(
      `SELECT 'config=' || array_to_string(setconfig, ',') FROM pg_db_role_setting WHERE setrole = '${newRole}'::regrole AND setdatabase = 0;`,
    )
    expect(shown.stdout).toContain('config=lo_compat_privileges=off')
  })
})
