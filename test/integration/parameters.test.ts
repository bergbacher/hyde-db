// D138: on PostgreSQL 15+, a SET or ALTER SYSTEM privilege on a configuration parameter lets the
// reader turn off large-object privilege checks or rewrite the server configuration (A96); the
// final check refuses it. On PostgreSQL 14 there are no parameter privileges, and the check is
// inert. Parameter privileges are cluster-wide and would reach the applies of the other test
// files, so these tests get a server of their own, which is thrown away afterwards.
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import {
  AS_SUPERUSER,
  adminQuery,
  apply,
  connectAsReader,
  createTestDatabase,
  dropTestDatabase,
  inOneTransaction,
  pasteFixAndReapply,
  type Server,
  serverVersion,
  suggestedFix,
  type TestDb,
} from './helpers/db.ts'

let container: StartedPostgreSqlContainer | undefined
let server: Server | undefined
beforeAll(async () => {
  container = await new PostgreSqlContainer(inject('pg').image).start()
  server = {
    containerId: container.getId(),
    user: container.getUsername(),
    uri: container.getConnectionUri(),
  }
})
afterAll(async () => {
  await container?.stop()
})

const created: TestDb[] = []
afterEach(async () => {
  for (const db of created.splice(0)) await dropTestDatabase(db)
})
async function freshDb(): Promise<TestDb> {
  const db = await createTestDatabase({ server })
  created.push(db)
  return db
}

const ABORT = 'has privileges on configuration parameters'

/** Whether the server has parameter privileges at all (PostgreSQL 15 and later). */
async function parameterPrivileges(db: TestDb): Promise<boolean> {
  const version = await serverVersion(db.name, db.server)
  const [row] = await adminQuery(
    db.name,
    "SELECT to_regclass('pg_catalog.pg_parameter_acl') IS NOT NULL AS present",
    db.server,
  )
  expect(row?.present).toBe(version >= 150000)
  return version >= 150000
}

describe('parameter privileges', () => {
  it('A96, D138: SET on lo_compat_privileges for PUBLIC aborts apply on PostgreSQL 15+, and after the printed fix the reader cannot set it; on 14 the check is inert', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    if (!(await parameterPrivileges(db))) {
      // The check never reads the catalog that is missing here; every apply on 14 passes it.
      expect(db.files['redacted-views.sql']).toContain('pg_parameter_acl')
      return
    }
    await adminQuery(db.name, 'GRANT SET ON PARAMETER lo_compat_privileges TO PUBLIC', db.server)
    const reader = await connectAsReader(db)
    try {
      // A96: the grant lets the reader turn off privilege checks on large objects.
      await reader.query('SET lo_compat_privileges = on')
      await reader.query('RESET lo_compat_privileges')
      const failed = apply(db)
      expect(failed.status).toBe(3)
      expect(failed.stderr).toContain(`role ${db.role} ${ABORT}: lo_compat_privileges. Fix: `)
      expect(suggestedFix(failed)).toBe(
        `REVOKE SET ON PARAMETER lo_compat_privileges FROM PUBLIC CASCADE;${AS_SUPERUSER}`,
      )
      await pasteFixAndReapply(db, failed)
      await expect(reader.query('SET lo_compat_privileges = on')).rejects.toMatchObject({
        code: '42501',
      })
    } finally {
      await reader.end()
    }
  })

  it('A96, D138: ALTER SYSTEM on log_statement for the reader aborts apply on PostgreSQL 15+, and after the printed fix the reader cannot run it; on 14 the check is inert', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    if (!(await parameterPrivileges(db))) {
      expect(db.files['redacted-views.sql']).toContain('pg_parameter_acl')
      return
    }
    await adminQuery(
      db.name,
      `GRANT ALTER SYSTEM ON PARAMETER log_statement TO "${db.role}"`,
      db.server,
    )
    const reader = await connectAsReader(db)
    try {
      // A96: the grant lets the reader change the server configuration.
      await reader.query('SET default_transaction_read_only = off')
      await reader.query('ALTER SYSTEM SET log_statement = none')
      await adminQuery(db.name, 'ALTER SYSTEM RESET log_statement', db.server)
      const failed = apply(db)
      expect(failed.status).toBe(3)
      expect(failed.stderr).toContain(`role ${db.role} ${ABORT}: log_statement. Fix: `)
      expect(suggestedFix(failed)).toBe(
        `REVOKE ALTER SYSTEM ON PARAMETER log_statement FROM ${db.role} CASCADE;${AS_SUPERUSER}`,
      )
      await pasteFixAndReapply(db, failed)
      await expect(reader.query('ALTER SYSTEM SET log_statement = none')).rejects.toMatchObject({
        code: '42501',
      })
    } finally {
      await reader.end()
    }
  })

  it('A56, D127, D138: a parameter privilege that another grantor passed on is revoked as that grantor', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    if (!(await parameterPrivileges(db))) {
      expect(db.files['redacted-views.sql']).toContain('pg_parameter_acl')
      return
    }
    const grantor = `${db.name}_grantor`
    await adminQuery(
      db.name,
      `CREATE ROLE "${grantor}" NOLOGIN;
       GRANT SET ON PARAMETER lo_compat_privileges TO "${grantor}" WITH GRANT OPTION;
       SET ROLE "${grantor}"; GRANT SET ON PARAMETER lo_compat_privileges TO "${db.role}"; RESET ROLE`,
      db.server,
    )
    try {
      const failed = apply(db)
      expect(failed.status).toBe(3)
      expect(suggestedFix(failed)).toBe(
        `${inOneTransaction(`SET ROLE ${grantor}; REVOKE SET ON PARAMETER lo_compat_privileges FROM ${db.role} CASCADE; RESET ROLE;`)}${AS_SUPERUSER}`,
      )
      await pasteFixAndReapply(db, failed)
    } finally {
      await adminQuery(
        db.name,
        `REVOKE SET ON PARAMETER lo_compat_privileges FROM "${grantor}" CASCADE; DROP ROLE "${grantor}"`,
        db.server,
      )
    }
  })
})
