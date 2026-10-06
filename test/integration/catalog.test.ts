// D81: privileges on pg_catalog, information_schema and pg_toast objects beyond their initial ones
// let the reader read table data, password hashes or large objects (A57, A63); the final check
// refuses them.
import { afterEach, describe, expect, it } from 'vitest'
import {
  AS_SUPERUSER,
  adminQuery,
  apply,
  createTestDatabase,
  dropTestDatabase,
  inOneTransaction,
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
const ABORT = 'has privileges on system catalog objects beyond their initial privileges'

/** Gives the reader SELECT on pg_authid WITH GRANT OPTION, which it passes on to PUBLIC for one column. */
async function readerPassesOnPassword(db: TestDb): Promise<void> {
  await adminQuery(
    db.name,
    `GRANT SELECT ON pg_catalog.pg_authid TO "${db.role}" WITH GRANT OPTION;
     SET ROLE "${db.role}"; GRANT SELECT (rolpassword) ON pg_catalog.pg_authid TO PUBLIC; RESET ROLE`,
  )
}
/** Whether PUBLIC can read password hashes in this database. */
async function publicReadsPasswords(db: TestDb): Promise<boolean> {
  const [row] = await adminQuery(
    db.name,
    "SELECT has_column_privilege('public', 'pg_catalog.pg_authid', 'rolpassword', 'SELECT') AS can",
  )
  return row?.can === true
}

describe('catalog privileges', () => {
  it('D81: a stock database has no catalog privileges beyond the initial ones', async () => {
    const db = await freshDb()
    const result = apply(db)
    expect(result.status, result.stderr).toBe(0)
    // Grants that add nothing to what PUBLIC holds initially are not refused either.
    await adminQuery(
      db.name,
      `GRANT SELECT ON pg_catalog.pg_class, information_schema.tables TO "${db.role}";
       GRANT EXECUTE ON FUNCTION pg_catalog.lower(text) TO "${db.role}"`,
    )
    const again = apply(db)
    expect(again.status, again.stderr).toBe(0)
  })

  it('D81: EXECUTE on pg_read_binary_file aborts apply, and the printed REVOKE fixes it', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    await adminQuery(db.name, `GRANT EXECUTE ON FUNCTION pg_read_binary_file(text) TO "${db.role}"`)
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(failed.stderr).toContain(`role ${db.role} ${ABORT}: pg_catalog.pg_read_binary_file(`)
    expect(suggestedFix(failed)).toMatch(
      new RegExp(
        `^REVOKE EXECUTE ON ROUTINE pg_catalog\\.pg_read_binary_file\\([a-z ]*text\\) FROM ${db.role} CASCADE;$`,
      ),
    )
    await pasteFixAndReapply(db, failed)
  })

  it('D81: SELECT on pg_statistic for the reader and PUBLIC aborts apply, and the printed REVOKEs fix it', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    await adminQuery(db.name, `GRANT SELECT ON pg_catalog.pg_statistic TO PUBLIC, "${db.role}"`)
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(failed.stderr).toContain(`role ${db.role} ${ABORT}: pg_catalog.pg_statistic. Fix: `)
    expect(suggestedFix(failed)).toBe(
      inOneTransaction(
        `REVOKE SELECT ON TABLE pg_catalog.pg_statistic FROM PUBLIC CASCADE; REVOKE SELECT ON TABLE pg_catalog.pg_statistic FROM ${db.role} CASCADE;`,
      ),
    )
    await pasteFixAndReapply(db, failed)
  })

  it('D81: column privileges on pg_authid and SELECT on an internal information_schema view abort apply', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    await adminQuery(
      db.name,
      `GRANT SELECT (rolname, rolpassword) ON pg_catalog.pg_authid TO "${db.role}";
       GRANT SELECT ON information_schema._pg_user_mappings TO PUBLIC`,
    )
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(failed.stderr).toContain(
      `role ${db.role} ${ABORT}: information_schema._pg_user_mappings, pg_catalog.pg_authid. Fix: `,
    )
    expect(suggestedFix(failed)).toBe(
      inOneTransaction(
        `REVOKE SELECT ON TABLE information_schema._pg_user_mappings FROM PUBLIC CASCADE; REVOKE SELECT (rolname), SELECT (rolpassword) ON TABLE pg_catalog.pg_authid FROM ${db.role} CASCADE;`,
      ),
    )
    await pasteFixAndReapply(db, failed)
  })

  it('A63, D81: USAGE on pg_toast and SELECT on a toast table abort apply, and the printed REVOKEs fix it', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    const [toast] = await adminQuery(
      db.name,
      "SELECT format('%I.%I', n.nspname, t.relname) AS name FROM pg_class c JOIN pg_class t ON t.oid = c.reltoastrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE c.oid = 'public.users'::regclass",
    )
    await adminQuery(
      db.name,
      `GRANT USAGE ON SCHEMA pg_toast TO "${db.role}"; GRANT SELECT ON ${toast?.name} TO "${db.role}"`,
    )
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(failed.stderr).toContain(`role ${db.role} ${ABORT}: pg_toast, ${toast?.name}. Fix: `)
    expect(suggestedFix(failed)).toBe(
      inOneTransaction(
        `REVOKE USAGE ON SCHEMA pg_toast FROM ${db.role} CASCADE; REVOKE SELECT ON TABLE ${toast?.name} FROM ${db.role} CASCADE;`,
      ),
    )
    await pasteFixAndReapply(db, failed)
  })

  it('A69, D108: a column privilege the reader passed on from its pg_authid grant is revoked as the reader before its own grant', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    await readerPassesOnPassword(db)
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(failed.stderr).toContain(`role ${db.role} ${ABORT}: pg_catalog.pg_authid. Fix: `)
    expect(suggestedFix(failed)).toBe(
      `${inOneTransaction(`SET ROLE ${db.role}; REVOKE SELECT (rolpassword) ON TABLE pg_catalog.pg_authid FROM PUBLIC CASCADE; RESET ROLE; REVOKE SELECT ON TABLE pg_catalog.pg_authid FROM ${db.role} CASCADE;`)}${AS_SUPERUSER}`,
    )
    await pasteFixAndReapply(db, failed)
    expect(await publicReadsPasswords(db)).toBe(false)
  })

  it('A69, D108: a column privilege the reader passed on outlives CASCADE on its pg_authid grant; the fix gives the reader the grant option back to revoke it', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    await readerPassesOnPassword(db)
    expect(
      psql(db.name, `REVOKE SELECT ON pg_catalog.pg_authid FROM "${db.role}" CASCADE`).status,
    ).toBe(0)
    expect(await publicReadsPasswords(db)).toBe(true)
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(suggestedFix(failed)).toBe(
      `${inOneTransaction(`GRANT SELECT (rolpassword) ON TABLE pg_catalog.pg_authid TO ${db.role} WITH GRANT OPTION; SET ROLE ${db.role}; REVOKE SELECT (rolpassword) ON TABLE pg_catalog.pg_authid FROM PUBLIC CASCADE; RESET ROLE; REVOKE SELECT (rolpassword) ON TABLE pg_catalog.pg_authid FROM ${db.role} CASCADE;`)}${AS_SUPERUSER}`,
    )
    await pasteFixAndReapply(db, failed)
    expect(await publicReadsPasswords(db)).toBe(false)
  })
})
