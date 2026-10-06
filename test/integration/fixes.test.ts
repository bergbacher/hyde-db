// D108: the relation, sequence and membership aborts refuse any privilege and print a fix that works
// when pasted by an administrator, as one transaction, also for grants made by a third-party grantor
// or by the reader, and for grants whose grantor no longer holds the grant option behind them.
import { afterEach, describe, expect, it } from 'vitest'
import {
  AS_SUPERUSER,
  adminQuery,
  apply,
  connectAsReader,
  createTestDatabase,
  dropTestDatabase,
  inOneTransaction,
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
  it('D108: a PUBLIC SELECT grant prints a REVOKE that fixes it, even on a first deploy', async () => {
    const db = await freshDb()
    await adminQuery(db.name, 'GRANT SELECT ON public.users TO PUBLIC')
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(failed.stderr).toContain(
      `role ${db.role} can read relations outside schema redacted: public.users. Fix: REVOKE ALL ON public.users FROM PUBLIC CASCADE;`,
    )
    pasteFixAndReapply(db, failed)
  })

  it('D108: relations the role holds a grant on are listed in schema and relation order, each with its REVOKE', async () => {
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
      inOneTransaction(
        `REVOKE ALL ON billing.cards FROM ${db.role} CASCADE; REVOKE ALL ON public.api_keys FROM ${db.role} CASCADE; REVOKE ALL ON public.orders FROM ${db.role} CASCADE;`,
      ),
    )
    pasteFixAndReapply(db, failed)
  })

  it('D108: column grants are revoked with the whole relation, from PUBLIC and the role', async () => {
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

  it('D108: a table grant and column grants on one relation are revoked by one statement', async () => {
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

  it('D108: every privilege on the source tables is refused; after the fix the reader can neither insert nor create a trigger', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    await adminQuery(db.name, `GRANT ALL ON ALL TABLES IN SCHEMA public TO "${db.role}"`)
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(suggestedFix(failed)).toBe(
      inOneTransaction(
        `REVOKE ALL ON public.api_keys FROM ${db.role} CASCADE; REVOKE ALL ON public.orders FROM ${db.role} CASCADE; REVOKE ALL ON public.users FROM ${db.role} CASCADE;`,
      ),
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

  it('D108: UPDATE on a column and TRIGGER, without SELECT, abort apply', async () => {
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

  it('A54, D108: a privilege the reader passed on WITH GRANT OPTION needs CASCADE, which the fix includes', async () => {
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

  it('A56, D108: a grant from a third-party grantor is revoked as that grantor', async () => {
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
      `${inOneTransaction(`SET ROLE ${grantor}; REVOKE SELECT ON public.api_keys FROM ${db.role} CASCADE; RESET ROLE;`)}${AS_SUPERUSER}`,
    )
    // A superuser's own REVOKE acts as the owner and leaves the grantor's grant in place (A56).
    expect(psql(db.name, `REVOKE ALL ON public.api_keys FROM "${db.role}" CASCADE`).status).toBe(0)
    expect(apply(db).status).toBe(3)
    pasteFixAndReapply(db, failed)
  })

  /** Whether PUBLIC can read public.api_keys.secret. */
  async function publicReadsSecret(db: TestDb): Promise<boolean> {
    const [row] = await adminQuery(
      db.name,
      "SELECT has_column_privilege('public', 'public.api_keys', 'secret', 'SELECT') AS can",
    )
    return row?.can === true
  }

  it('A69, D108: a column grant the reader passed on from a column grant is revoked as the reader, column by column, before its own grant', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    await adminQuery(
      db.name,
      `GRANT SELECT (secret) ON public.api_keys TO "${db.role}" WITH GRANT OPTION;
       SET ROLE "${db.role}"; GRANT SELECT (secret) ON public.api_keys TO PUBLIC; RESET ROLE`,
    )
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(suggestedFix(failed)).toBe(
      `${inOneTransaction(`SET ROLE ${db.role}; REVOKE SELECT (secret) ON public.api_keys FROM PUBLIC CASCADE; RESET ROLE; REVOKE ALL ON public.api_keys FROM ${db.role} CASCADE;`)}${AS_SUPERUSER}`,
    )
    pasteFixAndReapply(db, failed)
    expect(await publicReadsSecret(db)).toBe(false)
  })

  it('A69, D108: a column grant the reader passed on from a table grant is revoked as the reader, column by column, before its own grant', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    await adminQuery(
      db.name,
      `GRANT SELECT ON public.api_keys TO "${db.role}" WITH GRANT OPTION;
       SET ROLE "${db.role}"; GRANT SELECT (secret) ON public.api_keys TO PUBLIC; RESET ROLE`,
    )
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(failed.stderr).toContain(
      `role ${db.role} can read relations outside schema redacted: public.api_keys. Fix: `,
    )
    expect(suggestedFix(failed)).toBe(
      `${inOneTransaction(`SET ROLE ${db.role}; REVOKE SELECT (secret) ON public.api_keys FROM PUBLIC CASCADE; RESET ROLE; REVOKE ALL ON public.api_keys FROM ${db.role} CASCADE;`)}${AS_SUPERUSER}`,
    )
    pasteFixAndReapply(db, failed)
    expect(await publicReadsSecret(db)).toBe(false)
  })

  it("A69, A82, D108: a column grant the reader passed on outlives CASCADE on the reader's table grant; the fix gives the reader back exactly that grant option, and takes it away again", async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    await adminQuery(
      db.name,
      `GRANT SELECT ON public.api_keys TO "${db.role}" WITH GRANT OPTION;
       SET ROLE "${db.role}"; GRANT SELECT (secret) ON public.api_keys TO PUBLIC; RESET ROLE`,
    )
    expect(psql(db.name, `REVOKE ALL ON public.api_keys FROM "${db.role}" CASCADE`).status).toBe(0)
    expect(await publicReadsSecret(db)).toBe(true)
    const failed = apply(db)
    expect(failed.status).toBe(3)
    // Revoking as the reader alone would change nothing: it no longer holds the grant option.
    expect(suggestedFix(failed)).toBe(
      `${inOneTransaction(`GRANT SELECT (secret) ON public.api_keys TO ${db.role} WITH GRANT OPTION; SET ROLE ${db.role}; REVOKE SELECT (secret) ON public.api_keys FROM PUBLIC CASCADE; RESET ROLE; REVOKE SELECT (secret) ON public.api_keys FROM ${db.role} CASCADE;`)}${AS_SUPERUSER}`,
    )
    pasteFixAndReapply(db, failed)
    expect(await publicReadsSecret(db)).toBe(false)
  })

  it('D108: a grantor revokes exactly the table privileges it granted: REVOKE ALL as a grantor of TRIGGER alone fails', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    const grantor = await extraRole(`${db.name}_grantor`)
    await adminQuery(
      db.name,
      `GRANT TRIGGER ON public.api_keys TO "${grantor}" WITH GRANT OPTION;
       SET ROLE "${grantor}"; GRANT TRIGGER ON public.api_keys TO "${db.role}"; RESET ROLE`,
    )
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(suggestedFix(failed)).toBe(
      `${inOneTransaction(`SET ROLE ${grantor}; REVOKE TRIGGER ON public.api_keys FROM ${db.role} CASCADE; RESET ROLE;`)}${AS_SUPERUSER}`,
    )
    const asGrantorWithAll = psql(
      db.name,
      `SET ROLE "${grantor}"; REVOKE ALL ON public.api_keys FROM "${db.role}" CASCADE;`,
    )
    expect(asGrantorWithAll.status).toBe(3)
    expect(asGrantorWithAll.stderr).toContain('permission denied for column')
    pasteFixAndReapply(db, failed)
  })

  /** The table-level and column ACLs of public.api_keys, to show a failed paste changed nothing. */
  async function apiKeysAcls(db: TestDb): Promise<unknown[]> {
    return adminQuery(
      db.name,
      "SELECT attname, attacl::text, (SELECT relacl::text FROM pg_class WHERE oid = 'public.api_keys'::regclass) AS relacl FROM pg_attribute WHERE attrelid = 'public.api_keys'::regclass AND attnum > 0 ORDER BY attnum",
    )
  }

  it('A69, A82, D108: column grants that the reader and a third party passed on outlive their own grants; the fix gives each back exactly its grant option, as one transaction', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    const grantor = await extraRole(`${db.name}_g3`)
    await adminQuery(
      db.name,
      `GRANT SELECT ON public.api_keys TO "${db.role}", "${grantor}" WITH GRANT OPTION;
       SET ROLE "${db.role}"; GRANT SELECT (secret) ON public.api_keys TO PUBLIC; RESET ROLE;
       SET ROLE "${grantor}"; GRANT SELECT (secret) ON public.api_keys TO PUBLIC; RESET ROLE;
       REVOKE ALL ON public.api_keys FROM "${db.role}", "${grantor}" CASCADE;
       GRANT SELECT (secret) ON public.api_keys TO "${grantor}"`,
    )
    expect(await publicReadsSecret(db)).toBe(true)
    const failed = apply(db)
    expect(failed.status).toBe(3)
    // The third party already held SELECT (secret) from the owner, so it keeps that privilege.
    const fix = suggestedFix(failed)
    expect(fix).toBe(
      `${inOneTransaction(
        `GRANT SELECT (secret) ON public.api_keys TO ${db.role} WITH GRANT OPTION; SET ROLE ${db.role}; REVOKE SELECT (secret) ON public.api_keys FROM PUBLIC CASCADE; RESET ROLE; REVOKE SELECT (secret) ON public.api_keys FROM ${db.role} CASCADE; ` +
          `GRANT SELECT (secret) ON public.api_keys TO ${grantor} WITH GRANT OPTION; SET ROLE ${grantor}; REVOKE SELECT (secret) ON public.api_keys FROM PUBLIC CASCADE; RESET ROLE; REVOKE GRANT OPTION FOR SELECT (secret) ON public.api_keys FROM ${grantor} CASCADE;`,
      )}${AS_SUPERUSER}`,
    )
    // A statement that fails halfway through the pasted fix leaves every ACL as it was.
    const before = await apiKeysAcls(db)
    const broken = psql(db.name, fix.replace('RESET ROLE; ', 'RESET ROLE; SELECT 1/0; '))
    expect(broken.status).toBe(3)
    expect(broken.stderr).toContain('division by zero')
    expect(await apiKeysAcls(db)).toEqual(before)
    pasteFixAndReapply(db, failed)
    expect(await publicReadsSecret(db)).toBe(false)
    const [row] = await adminQuery(
      db.name,
      `SELECT has_column_privilege('${grantor}', 'public.api_keys', 'secret', 'SELECT') AS base,
              has_column_privilege('${grantor}', 'public.api_keys', 'secret', 'SELECT WITH GRANT OPTION') AS option`,
    )
    expect(row).toEqual({ base: true, option: false })
  })

  it('A69, D108: a third-party grantor that holds only column privileges revokes column by column', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    const grantor = await extraRole(`${db.name}_g3`)
    await adminQuery(
      db.name,
      `GRANT SELECT (secret) ON public.api_keys TO "${grantor}" WITH GRANT OPTION;
       SET ROLE "${grantor}"; GRANT SELECT (secret) ON public.api_keys TO "${db.role}"; RESET ROLE`,
    )
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(suggestedFix(failed)).toBe(
      `${inOneTransaction(`SET ROLE ${grantor}; REVOKE SELECT (secret) ON public.api_keys FROM ${db.role} CASCADE; RESET ROLE;`)}${AS_SUPERUSER}`,
    )
    pasteFixAndReapply(db, failed)
  })
  /** A third party that belongs to a group holding ALL on public.api_keys WITH GRANT OPTION. */
  async function grantorInGroup(db: TestDb): Promise<{ grantor: string; group: string }> {
    const group = await extraRole(`${db.name}_grp`)
    const grantor = await extraRole(`${db.name}_g3`)
    await adminQuery('postgres', `GRANT "${group}" TO "${grantor}"`)
    await adminQuery(db.name, `GRANT ALL ON public.api_keys TO "${group}" WITH GRANT OPTION`)
    return { grantor, group }
  }
  /** The privileges a role holds on public.api_keys itself, with their grant options. */
  async function tableEntries(db: TestDb, role: string): Promise<unknown[]> {
    return adminQuery(
      db.name,
      `SELECT a.privilege_type, a.is_grantable FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
       WHERE c.oid = 'public.api_keys'::regclass AND a.grantee = '${role}'::regrole ORDER BY 1`,
    )
  }

  it('A87, D122: a column grant passed on by a grantor whose own option is gone, while its group holds one, is revoked after giving the grantor back its own option', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    const { grantor, group } = await grantorInGroup(db)
    await adminQuery(
      db.name,
      `GRANT SELECT ON public.api_keys TO "${grantor}" WITH GRANT OPTION;
       SET ROLE "${grantor}"; GRANT SELECT (secret) ON public.api_keys TO PUBLIC; RESET ROLE;
       REVOKE SELECT ON public.api_keys FROM "${grantor}" CASCADE`,
    )
    // The group's option hides that the grantor lost its own (A87).
    const [row] = await adminQuery(
      db.name,
      `SELECT has_column_privilege('${grantor}', 'public.api_keys', 'secret', 'SELECT WITH GRANT OPTION') AS inherited`,
    )
    expect(row?.inherited).toBe(true)
    expect(await publicReadsSecret(db)).toBe(true)
    const groupBefore = await tableEntries(db, group)
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(suggestedFix(failed)).toBe(
      `${inOneTransaction(`GRANT SELECT (secret) ON public.api_keys TO ${grantor} WITH GRANT OPTION; SET ROLE ${grantor}; REVOKE SELECT (secret) ON public.api_keys FROM PUBLIC CASCADE; RESET ROLE; REVOKE SELECT (secret) ON public.api_keys FROM ${grantor} CASCADE;`)}${AS_SUPERUSER}`,
    )
    pasteFixAndReapply(db, failed)
    expect(await publicReadsSecret(db)).toBe(false)
    expect(await tableEntries(db, group)).toEqual(groupBefore)
  })

  it('A87, D122: a grantor that holds its own option revokes exactly what it passed on, so a group with more options cannot act for it', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    const { grantor } = await grantorInGroup(db)
    await adminQuery(
      db.name,
      `GRANT SELECT (secret) ON public.api_keys TO "${grantor}" WITH GRANT OPTION;
       SET ROLE "${grantor}"; GRANT SELECT (secret) ON public.api_keys TO PUBLIC; RESET ROLE`,
    )
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(suggestedFix(failed)).toBe(
      `${inOneTransaction(`SET ROLE ${grantor}; REVOKE SELECT (secret) ON public.api_keys FROM PUBLIC CASCADE; RESET ROLE;`)}${AS_SUPERUSER}`,
    )
    // REVOKE ALL (secret) needs options the grantor lacks, so it acts as the group and changes nothing (A87).
    const asGroup = psql(
      db.name,
      `SET ROLE "${grantor}"; REVOKE ALL (secret) ON public.api_keys FROM PUBLIC CASCADE;`,
    )
    expect(asGroup.status, asGroup.stderr).toBe(0)
    expect(await publicReadsSecret(db)).toBe(true)
    pasteFixAndReapply(db, failed)
    expect(await publicReadsSecret(db)).toBe(false)
  })

  it('A87, D122: a table grant passed on by a grantor whose own option is gone, while its group holds one, is revoked after giving the grantor back its own option', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    const { grantor, group } = await grantorInGroup(db)
    await adminQuery(
      db.name,
      `GRANT SELECT ON public.api_keys TO "${grantor}" WITH GRANT OPTION;
       SET ROLE "${grantor}"; GRANT SELECT ON public.api_keys TO "${db.role}"; RESET ROLE;
       REVOKE SELECT ON public.api_keys FROM "${grantor}" CASCADE`,
    )
    // CASCADE kept the reader's grant: the group's option counts as the grantor's (A87).
    const groupBefore = await tableEntries(db, group)
    expect(await tableEntries(db, db.role)).toEqual([
      { privilege_type: 'SELECT', is_grantable: false },
    ])
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(suggestedFix(failed)).toBe(
      `${inOneTransaction(`GRANT SELECT ON public.api_keys TO ${grantor} WITH GRANT OPTION; SET ROLE ${grantor}; REVOKE SELECT ON public.api_keys FROM ${db.role} CASCADE; RESET ROLE; REVOKE SELECT ON public.api_keys FROM ${grantor} CASCADE;`)}${AS_SUPERUSER}`,
    )
    pasteFixAndReapply(db, failed)
    expect(await tableEntries(db, db.role)).toEqual([])
    expect(await tableEntries(db, group)).toEqual(groupBefore)
  })
})

describe('sequence fix', () => {
  it("D13, D108: USAGE on a sequence the reader passed on to PUBLIC goes with CASCADE on the reader's own grant, run by the owner", async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    await adminQuery(
      db.name,
      `GRANT USAGE ON SEQUENCE public.orders_id_seq TO "${db.role}" WITH GRANT OPTION;
       SET ROLE "${db.role}"; GRANT USAGE ON SEQUENCE public.orders_id_seq TO PUBLIC; RESET ROLE`,
    )
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(failed.stderr).toContain(
      `role ${db.role} can read sequences: public.orders_id_seq. Fix: REVOKE ALL ON SEQUENCE public.orders_id_seq FROM ${db.role} CASCADE;\n`,
    )
    pasteFixAndReapply(db, failed)
  })

  it('D13, D108: USAGE on a sequence from a third-party grantor is revoked as that grantor, exactly: REVOKE ALL as it fails', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    const grantor = await extraRole(`${db.name}_grantor`)
    await adminQuery(
      db.name,
      `GRANT USAGE ON SEQUENCE public.orders_id_seq TO "${grantor}" WITH GRANT OPTION;
       SET ROLE "${grantor}"; GRANT USAGE ON SEQUENCE public.orders_id_seq TO "${db.role}"; RESET ROLE`,
    )
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(suggestedFix(failed)).toBe(
      `${inOneTransaction(`SET ROLE ${grantor}; REVOKE USAGE ON SEQUENCE public.orders_id_seq FROM ${db.role} CASCADE; RESET ROLE;`)}${AS_SUPERUSER}`,
    )
    const asGrantorWithAll = psql(
      db.name,
      `SET ROLE "${grantor}"; REVOKE ALL ON SEQUENCE public.orders_id_seq FROM "${db.role}" CASCADE;`,
    )
    expect(asGrantorWithAll.status).toBe(3)
    expect(asGrantorWithAll.stderr).toContain('permission denied for column')
    pasteFixAndReapply(db, failed)
  })

  it('A83, D111: a column grant on a sequence aborts apply, and the printed REVOKE fixes it', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    await adminQuery(db.name, `GRANT SELECT (last_value) ON public.orders_id_seq TO "${db.role}"`)
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(failed.stderr).toContain(
      `role ${db.role} can read sequences: public.orders_id_seq. Fix: REVOKE ALL ON SEQUENCE public.orders_id_seq FROM ${db.role} CASCADE;\n`,
    )
    pasteFixAndReapply(db, failed)
    const [row] = await adminQuery(
      db.name,
      `SELECT has_any_column_privilege('${db.role}', 'public.orders_id_seq', 'SELECT') AS can`,
    )
    expect(row?.can).toBe(false)
  })

  it('A83, D108, D111: a column grant on a sequence that the reader passed on from its sequence grant is revoked as the reader first', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    await adminQuery(
      db.name,
      `GRANT SELECT ON SEQUENCE public.orders_id_seq TO "${db.role}" WITH GRANT OPTION;
       SET ROLE "${db.role}"; GRANT SELECT (last_value) ON public.orders_id_seq TO PUBLIC; RESET ROLE`,
    )
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(suggestedFix(failed)).toBe(
      `${inOneTransaction(`SET ROLE ${db.role}; REVOKE SELECT (last_value) ON public.orders_id_seq FROM PUBLIC CASCADE; RESET ROLE; REVOKE ALL ON SEQUENCE public.orders_id_seq FROM ${db.role} CASCADE;`)}${AS_SUPERUSER}`,
    )
    pasteFixAndReapply(db, failed)
  })
  it('A88, D124: a temporary sequence that the reader holds open does not block the deploy', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    const reader = await connectAsReader(db)
    try {
      await reader.query('SET default_transaction_read_only = off')
      await reader.query('CREATE TEMP SEQUENCE scratch')
      const result = apply(db)
      expect(result.status, result.stderr).toBe(0)
    } finally {
      await reader.end()
    }
  })
})

describe('membership fix', () => {
  it('D108: membership in other roles names each group and prints the REVOKEs that end it', async () => {
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
      inOneTransaction(
        `REVOKE "${upper}" FROM ${db.role}${grantedBy} CASCADE; REVOKE ${lower} FROM ${db.role}${grantedBy} CASCADE;`,
      ),
    )
    pasteFixAndReapply(db, failed)
  })

  it('A54, D108: a membership granted by a non-superuser role with ADMIN is ended by the printed fix', async () => {
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

  it('A56, D108: a membership the reader passed on WITH ADMIN OPTION is ended by the printed fix', async () => {
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
