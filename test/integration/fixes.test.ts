// D78: the relation and membership aborts refuse any privilege and print a fix that works when
// pasted by an administrator, also for grants made by a third-party grantor.
import { afterEach, describe, expect, it } from 'vitest'
import {
  adminQuery,
  apply,
  connectAsReader,
  createTestDatabase,
  dropTestDatabase,
  pasteFixAndReapply,
  psql,
  serverVersion,
  suggestedFix,
  type TestDb,
} from './helpers/db.ts'

const created: TestDb[] = []
const roles: string[] = []
afterEach(async () => {
  for (const db of created.splice(0)) await dropTestDatabase(db)
  for (const role of roles.splice(0)) await adminQuery('postgres', `DROP ROLE "${role}"`)
})
async function freshDb(): Promise<TestDb> {
  const db = await createTestDatabase()
  created.push(db)
  return db
}
/** Creates a cluster-wide role; it is dropped after the test's database and reader role. */
async function extraRole(name: string): Promise<string> {
  roles.push(name)
  await adminQuery('postgres', `CREATE ROLE "${name}" NOLOGIN`)
  return name
}

describe('relation fix', () => {
  it('D78: a PUBLIC SELECT grant prints a REVOKE that fixes it, even on a first deploy', async () => {
    const db = await freshDb()
    await adminQuery(db.name, 'GRANT SELECT ON public.users TO PUBLIC')
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(failed.stderr).toContain(
      `role ${db.role} can read relations outside schema redacted: public.users. Fix: REVOKE ALL ON public.users FROM PUBLIC CASCADE;`,
    )
    pasteFixAndReapply(db, failed)
  })

  it('D78: relations the role holds a grant on are listed in schema and relation order, each with its REVOKE', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    await adminQuery(
      db.name,
      `CREATE SCHEMA billing; CREATE TABLE billing.cards (id int, number text);
       GRANT SELECT ON billing.cards, public.orders TO "${db.role}";
       GRANT INSERT ON public.api_keys TO "${db.role}"`,
    )
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(failed.stderr).toContain(
      `role ${db.role} can read relations outside schema redacted: billing.cards, public.api_keys, public.orders. Fix: `,
    )
    expect(suggestedFix(failed)).toBe(
      `REVOKE ALL ON billing.cards FROM ${db.role} CASCADE; REVOKE ALL ON public.api_keys FROM ${db.role} CASCADE; REVOKE ALL ON public.orders FROM ${db.role} CASCADE;`,
    )
    pasteFixAndReapply(db, failed)
  })

  it('D78: column grants are revoked with the whole relation, from PUBLIC and the role', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    await adminQuery(
      db.name,
      `CREATE SCHEMA billing; CREATE TABLE billing.cards (id int, "Card Number" text);
       GRANT USAGE ON SCHEMA billing TO "${db.role}";
       GRANT SELECT ("Card Number") ON billing.cards TO "${db.role}";
       GRANT REFERENCES (id) ON billing.cards TO PUBLIC`,
    )
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(failed.stderr).toContain(
      `role ${db.role} can read relations outside schema redacted: billing.cards. Fix: `,
    )
    expect(suggestedFix(failed)).toBe(
      `REVOKE ALL ON billing.cards FROM PUBLIC, ${db.role} CASCADE;`,
    )
    pasteFixAndReapply(db, failed)
  })

  it('D78: a table grant and column grants on one relation are revoked by one statement', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    await adminQuery(
      db.name,
      `GRANT SELECT ON public.users TO "${db.role}"; GRANT SELECT (email) ON public.users TO PUBLIC`,
    )
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(suggestedFix(failed)).toBe(`REVOKE ALL ON public.users FROM PUBLIC, ${db.role} CASCADE;`)
    pasteFixAndReapply(db, failed)
    const reader = await connectAsReader(db)
    try {
      await expect(reader.query('SELECT email FROM public.users')).rejects.toMatchObject({
        code: '42501',
      })
    } finally {
      await reader.end()
    }
  })

  it('D78: every privilege on the source tables is refused; after the fix the reader can neither insert nor create a trigger', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    await adminQuery(db.name, `GRANT ALL ON ALL TABLES IN SCHEMA public TO "${db.role}"`)
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(suggestedFix(failed)).toBe(
      `REVOKE ALL ON public.api_keys FROM ${db.role} CASCADE; REVOKE ALL ON public.orders FROM ${db.role} CASCADE; REVOKE ALL ON public.users FROM ${db.role} CASCADE;`,
    )
    pasteFixAndReapply(db, failed)
    const reader = await connectAsReader(db)
    try {
      // Out of the read-only default, so the privilege check is what refuses the statements.
      await reader.query('SET default_transaction_read_only = off')
      await expect(
        reader.query(
          "INSERT INTO public.users (email, password_hash, full_name, country, plan) VALUES ('x', 'x', 'x', 'XX', 'FREE')",
        ),
      ).rejects.toMatchObject({ code: '42501' })
      await expect(
        reader.query(
          'CREATE TRIGGER peek BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger()',
        ),
      ).rejects.toMatchObject({ code: '42501' })
    } finally {
      await reader.end()
    }
  })

  it('D78: UPDATE on a column and TRIGGER, without SELECT, abort apply', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    await adminQuery(db.name, `GRANT UPDATE (plan), TRIGGER ON public.users TO "${db.role}"`)
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(failed.stderr).toContain(
      `role ${db.role} can read relations outside schema redacted: public.users. Fix: REVOKE ALL ON public.users FROM ${db.role} CASCADE;`,
    )
    pasteFixAndReapply(db, failed)
  })

  it('A54, D78: a privilege the reader passed on WITH GRANT OPTION needs CASCADE, which the fix includes', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    const other = await extraRole(`${db.name}_other`)
    await adminQuery(
      db.name,
      `GRANT SELECT ON public.orders TO "${db.role}" WITH GRANT OPTION;
       SET ROLE "${db.role}"; GRANT SELECT ON public.orders TO "${other}"; RESET ROLE`,
    )
    const failed = apply(db)
    expect(failed.status).toBe(3)
    const fix = suggestedFix(failed)
    expect(fix).toBe(`REVOKE ALL ON public.orders FROM ${db.role} CASCADE;`)
    const withoutCascade = psql(db.name, fix.replace(' CASCADE;', ';'))
    expect(withoutCascade.status).toBe(3)
    expect(withoutCascade.stderr).toContain('dependent privileges exist')
    pasteFixAndReapply(db, failed)
  })

  it('A56, D78: a grant from a third-party grantor is revoked as that grantor', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    const grantor = await extraRole(`${db.name}_grantor`)
    await adminQuery(
      db.name,
      `GRANT SELECT ON public.api_keys TO "${grantor}" WITH GRANT OPTION;
       SET ROLE "${grantor}"; GRANT SELECT ON public.api_keys TO "${db.role}"; RESET ROLE`,
    )
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(suggestedFix(failed)).toBe(
      `SET ROLE ${grantor}; REVOKE ALL ON public.api_keys FROM ${db.role} CASCADE; RESET ROLE;`,
    )
    // A superuser's own REVOKE acts as the owner and leaves the grantor's grant in place (A56).
    expect(psql(db.name, `REVOKE ALL ON public.api_keys FROM "${db.role}" CASCADE`).status).toBe(0)
    expect(apply(db).status).toBe(3)
    pasteFixAndReapply(db, failed)
  })
})

describe('membership fix', () => {
  it('D78: membership in other roles names each group and prints the REVOKEs that end it', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    // A mixed-case name shows the fix quotes identifiers.
    const [upper, lower] = [`${db.name}_Group`, `${db.name}_group`]
    for (const group of [lower, upper]) {
      await extraRole(group)
      await adminQuery('postgres', `GRANT "${group}" TO "${db.role}"`)
    }
    const [admin] = await adminQuery('postgres', 'SELECT current_user AS name')
    // PostgreSQL 16+ records a grantor per membership and needs it named (A54).
    const grantedBy = (await serverVersion(db.name)) >= 160000 ? ` GRANTED BY ${admin?.name}` : ''
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(failed.stderr).toContain(
      `role ${db.role} must not be a member of other roles: "${upper}", ${lower}. Fix: `,
    )
    expect(suggestedFix(failed)).toBe(
      `REVOKE "${upper}" FROM ${db.role}${grantedBy} CASCADE; REVOKE ${lower} FROM ${db.role}${grantedBy} CASCADE;`,
    )
    pasteFixAndReapply(db, failed)
  })

  it('A54, D78: a membership granted by a non-superuser role with ADMIN is ended by the printed fix', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    const group = await extraRole(`${db.name}_group`)
    const admin = await extraRole(`${db.name}_admin`)
    await adminQuery(
      'postgres',
      `GRANT "${group}" TO "${admin}" WITH ADMIN OPTION;
       SET ROLE "${admin}"; GRANT "${group}" TO "${db.role}"; RESET ROLE`,
    )
    const failed = apply(db)
    expect(failed.status).toBe(3)
    // PostgreSQL 14 keeps one membership row whatever the grantor, and a plain REVOKE ends it.
    const grantedBy = (await serverVersion(db.name)) >= 160000 ? ` GRANTED BY ${admin}` : ''
    expect(suggestedFix(failed)).toBe(`REVOKE ${group} FROM ${db.role}${grantedBy} CASCADE;`)
    pasteFixAndReapply(db, failed)
  })

  it('A56, D78: a membership the reader passed on WITH ADMIN OPTION is ended by the printed fix', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    const group = await extraRole(`${db.name}_group`)
    const other = await extraRole(`${db.name}_other`)
    await adminQuery(
      'postgres',
      `GRANT "${group}" TO "${db.role}" WITH ADMIN OPTION;
       SET ROLE "${db.role}"; GRANT "${group}" TO "${other}"; RESET ROLE`,
    )
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(suggestedFix(failed)).toMatch(/ CASCADE;$/)
    pasteFixAndReapply(db, failed)
  })
})
