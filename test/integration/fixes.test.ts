// D65: the relation-leak and membership aborts print a fix that works when pasted.
import { afterEach, describe, expect, it } from 'vitest'
import {
  adminQuery,
  apply,
  connectAsReader,
  createTestDatabase,
  dropTestDatabase,
  psql,
  suggestedFix,
  type TestDb,
} from './helpers/db.ts'

const created: TestDb[] = []
const groups: string[] = []
afterEach(async () => {
  for (const db of created.splice(0)) await dropTestDatabase(db)
  for (const group of groups.splice(0)) await adminQuery('postgres', `DROP ROLE "${group}"`)
})
async function freshDb(): Promise<TestDb> {
  const db = await createTestDatabase()
  created.push(db)
  return db
}

/** Pastes the printed fix verbatim, then re-applies; both must succeed. */
function pasteFixAndReapply(db: TestDb, fix: string): void {
  const pasted = psql(db.name, fix)
  expect(pasted.status, pasted.stderr).toBe(0)
  const reapplied = apply(db)
  expect(reapplied.status, reapplied.stderr).toBe(0)
}

describe('relation-leak fix', () => {
  it('D65: a PUBLIC SELECT grant prints a REVOKE that fixes it, even on a first deploy', async () => {
    const db = await freshDb()
    await adminQuery(db.name, 'GRANT SELECT ON public.users TO PUBLIC')
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(failed.stderr).toContain(
      `role ${db.role} can read relations outside schema redacted: public.users. Fix: REVOKE SELECT ON public.users FROM PUBLIC;`,
    )
    pasteFixAndReapply(db, suggestedFix(failed))
  })

  it('D65: relations the role owns or holds a grant on are listed in schema and relation order, each with its REVOKE', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    await adminQuery(
      db.name,
      `CREATE SCHEMA billing; CREATE TABLE billing.cards (id int, number text);
       GRANT SELECT ON billing.cards, public.orders TO "${db.role}";
       ALTER TABLE public.api_keys OWNER TO "${db.role}"`,
    )
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(failed.stderr).toContain(
      `role ${db.role} can read relations outside schema redacted: billing.cards, public.api_keys, public.orders. Fix: `,
    )
    expect(suggestedFix(failed)).toBe(
      `REVOKE SELECT ON billing.cards FROM ${db.role}; REVOKE SELECT ON public.api_keys FROM ${db.role}; REVOKE SELECT ON public.orders FROM ${db.role};`,
    )
    pasteFixAndReapply(db, suggestedFix(failed))
  })

  it('D65: column grants alone are revoked column by column, from PUBLIC and the role', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    await adminQuery(
      db.name,
      `CREATE SCHEMA billing; CREATE TABLE billing.cards (id int, "Card Number" text, cvc text);
       ALTER TABLE billing.cards DROP COLUMN cvc;
       GRANT USAGE ON SCHEMA billing TO "${db.role}";
       GRANT SELECT ("Card Number") ON billing.cards TO "${db.role}";
       GRANT SELECT (id) ON billing.cards TO PUBLIC`,
    )
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(failed.stderr).toContain(
      `role ${db.role} can read relations outside schema redacted: billing.cards. Fix: `,
    )
    expect(suggestedFix(failed)).toBe(
      `REVOKE SELECT (id, "Card Number") ON billing.cards FROM PUBLIC, ${db.role};`,
    )
    pasteFixAndReapply(db, suggestedFix(failed))
  })

  it('D65: a table grant and column grants on one relation are revoked by one statement', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    await adminQuery(
      db.name,
      `GRANT SELECT ON public.users TO "${db.role}"; GRANT SELECT (email) ON public.users TO PUBLIC`,
    )
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(suggestedFix(failed)).toBe(`REVOKE SELECT ON public.users FROM PUBLIC, ${db.role};`)
    pasteFixAndReapply(db, suggestedFix(failed))
    const reader = await connectAsReader(db)
    try {
      await expect(reader.query('SELECT email FROM public.users')).rejects.toMatchObject({
        code: '42501',
      })
    } finally {
      await reader.end()
    }
  })
})

describe('membership fix', () => {
  it('D65: membership in other roles names each group and prints the REVOKEs that end it', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    // A mixed-case name shows the fix quotes identifiers.
    const [upper, lower] = [`${db.name}_Group`, `${db.name}_group`]
    for (const group of [lower, upper]) {
      groups.push(group)
      await adminQuery(
        'postgres',
        `CREATE ROLE "${group}" NOLOGIN; GRANT "${group}" TO "${db.role}"`,
      )
    }
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(failed.stderr).toContain(
      `role ${db.role} must not be a member of other roles: "${upper}", ${lower}. Fix: `,
    )
    expect(suggestedFix(failed)).toBe(
      `REVOKE "${upper}" FROM ${db.role}; REVOKE ${lower} FROM ${db.role};`,
    )
    pasteFixAndReapply(db, suggestedFix(failed))
  })
})
