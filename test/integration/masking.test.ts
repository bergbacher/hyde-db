// D127, D128: a grantor whose own grant option is gone while a role it belongs to still holds one
// (A87, A90, A91) is given that exact option for its revoke, borrowed from that role, or from the
// owner when the owner role masks it; the pasted fix leaves every other grant exactly as it was.
import { afterEach, describe, expect, it } from 'vitest'
import {
  AS_SUPERUSER,
  adminQuery,
  apply,
  createTestDatabase,
  dropTestDatabase,
  inOneTransaction,
  pasteFixAndReapply,
  suggestedFix,
  type TestDb,
} from './helpers/db.ts'

const created: TestDb[] = []
const roles: string[] = []
afterEach(async () => {
  for (const db of created.splice(0)) await dropTestDatabase(db)
  for (const role of roles.splice(0).reverse()) await adminQuery('postgres', `DROP ROLE "${role}"`)
})

interface Setup {
  readonly db: TestDb
  /** The third-party grantor. */
  readonly g3: string
  /** The role g3 belongs to, which holds grant options on the same objects. */
  readonly grp: string
  /** An unrelated role g3 legitimately passed column privileges on to. */
  readonly xApp: string
}

/** A deployed database with roles g3 ∈ grp and x_app; `nested` puts a role between g3 and grp. */
async function setUp(nested = false): Promise<Setup> {
  const db = await createTestDatabase()
  created.push(db)
  expect(apply(db).status).toBe(0)
  const [grp, middle, g3, xApp] = [
    `${db.name}_grp`,
    `${db.name}_grp2`,
    `${db.name}_g3`,
    `${db.name}_x_app`,
  ] as const
  for (const role of nested ? [grp, middle, g3, xApp] : [grp, g3, xApp]) {
    roles.push(role)
    await adminQuery('postgres', `CREATE ROLE "${role}" NOLOGIN`)
  }
  await adminQuery(
    'postgres',
    nested
      ? `GRANT "${grp}" TO "${middle}"; GRANT "${middle}" TO "${g3}"`
      : `GRANT "${grp}" TO "${g3}"`,
  )
  return { db, g3, grp, xApp }
}

/** The fix borrowing `privileges` on `object` from grp so that g3 can revoke them from `grantee`. */
function borrowedFix(
  { grp, g3 }: Setup,
  privileges: string,
  object: string,
  revoke: string,
  grantee: string,
): string {
  return `${inOneTransaction(
    `SET ROLE ${grp}; GRANT ${privileges} ON ${object} TO ${g3} WITH GRANT OPTION; RESET ROLE; ` +
      `SET ROLE ${g3}; REVOKE ${privileges} ON ${revoke} FROM ${grantee} CASCADE; RESET ROLE; ` +
      `SET ROLE ${grp}; REVOKE ${privileges} ON ${object} FROM ${g3} CASCADE; RESET ROLE;`,
  )}${AS_SUPERUSER}`
}

describe('a table or sequence grant masked by a group option', () => {
  for (const lost of [true, false]) {
    const how = lost ? 'its grant is gone' : 'only its grant option is gone'
    it(`A90, D127, D128: a table grant that g3 passed on after ${how} is revoked with an option borrowed from the group, and g3's column grants to another application stay`, async () => {
      const s = await setUp()
      const { db, g3, grp, xApp } = s
      await adminQuery(
        db.name,
        `GRANT ALL ON public.api_keys TO "${grp}" WITH GRANT OPTION;
         GRANT SELECT ON public.api_keys TO "${g3}" WITH GRANT OPTION;
         SET ROLE "${g3}"; GRANT SELECT ON public.api_keys TO "${db.role}"; RESET ROLE;
         REVOKE ${lost ? '' : 'GRANT OPTION FOR '}SELECT ON public.api_keys FROM "${g3}" CASCADE;
         GRANT SELECT (id) ON public.api_keys TO "${g3}" WITH GRANT OPTION;
         GRANT INSERT (id), UPDATE (id) ON public.api_keys TO "${g3}";
         SET ROLE "${g3}"; GRANT SELECT (id) ON public.api_keys TO "${xApp}"; RESET ROLE`,
      )
      const failed = apply(db)
      expect(failed.status).toBe(3)
      expect(suggestedFix(failed)).toBe(
        borrowedFix(s, 'SELECT', 'public.api_keys', 'public.api_keys', db.role),
      )
      await pasteFixAndReapply(db, failed)
    })

    it(`A90, D127, D128: a sequence grant that g3 passed on after ${how} is revoked with an option borrowed from the group, and g3's column grants to another application stay`, async () => {
      const s = await setUp()
      const { db, g3, grp, xApp } = s
      await adminQuery(
        db.name,
        `GRANT ALL ON SEQUENCE public.users_id_seq TO "${grp}" WITH GRANT OPTION;
         GRANT USAGE, SELECT ON SEQUENCE public.users_id_seq TO "${g3}" WITH GRANT OPTION;
         SET ROLE "${g3}"; GRANT USAGE, SELECT ON SEQUENCE public.users_id_seq TO "${db.role}"; RESET ROLE;
         REVOKE ${lost ? '' : 'GRANT OPTION FOR '}USAGE, SELECT ON SEQUENCE public.users_id_seq FROM "${g3}" CASCADE;
         GRANT SELECT (last_value) ON public.users_id_seq TO "${g3}" WITH GRANT OPTION;
         SET ROLE "${g3}"; GRANT SELECT (last_value) ON public.users_id_seq TO "${xApp}"; RESET ROLE`,
      )
      const failed = apply(db)
      expect(failed.status).toBe(3)
      expect(suggestedFix(failed)).toBe(
        borrowedFix(
          s,
          'SELECT, USAGE',
          'public.users_id_seq',
          'SEQUENCE public.users_id_seq',
          db.role,
        ),
      )
      await pasteFixAndReapply(db, failed)
    })
  }

  it('A90, D127, D128: the option is borrowed from a group g3 belongs to through another role, for two privileges at once', async () => {
    const s = await setUp(true)
    const { db, g3, grp, xApp } = s
    await adminQuery(
      db.name,
      `GRANT ALL ON public.api_keys TO "${grp}" WITH GRANT OPTION;
       GRANT SELECT, UPDATE ON public.api_keys TO "${g3}" WITH GRANT OPTION;
       SET ROLE "${g3}"; GRANT SELECT, UPDATE ON public.api_keys TO "${db.role}"; RESET ROLE;
       REVOKE SELECT, UPDATE ON public.api_keys FROM "${g3}" CASCADE;
       GRANT SELECT (id), UPDATE (secret) ON public.api_keys TO "${g3}" WITH GRANT OPTION;
       SET ROLE "${g3}"; GRANT SELECT (id), UPDATE (secret) ON public.api_keys TO "${xApp}"; RESET ROLE`,
    )
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(suggestedFix(failed)).toBe(
      borrowedFix(s, 'SELECT, UPDATE', 'public.api_keys', 'public.api_keys', db.role),
    )
    await pasteFixAndReapply(db, failed)
  })

  it("A90, D127, D128: a column grant masked by the group's option on that column is revoked with the option borrowed from the group", async () => {
    const s = await setUp()
    const { db, g3, grp, xApp } = s
    await adminQuery(
      db.name,
      `GRANT SELECT (secret) ON public.api_keys TO "${grp}", "${g3}" WITH GRANT OPTION;
       SET ROLE "${g3}"; GRANT SELECT (secret) ON public.api_keys TO PUBLIC, "${xApp}"; RESET ROLE;
       REVOKE SELECT (secret) ON public.api_keys FROM "${g3}" CASCADE`,
    )
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(suggestedFix(failed)).toBe(
      borrowedFix(s, 'SELECT (secret)', 'public.api_keys', 'public.api_keys', 'PUBLIC'),
    )
    await pasteFixAndReapply(db, failed)
  })

  it("A90, D127, D128: when only membership in the owner role masks it, the option comes from the owner and g3's column grants are given back", async () => {
    const { db, g3, grp, xApp } = await setUp()
    await adminQuery(
      db.name,
      `ALTER TABLE public.api_keys OWNER TO "${grp}";
       SET ROLE "${grp}"; GRANT SELECT ON public.api_keys TO "${g3}" WITH GRANT OPTION; RESET ROLE;
       SET ROLE "${g3}"; GRANT SELECT ON public.api_keys TO "${db.role}"; RESET ROLE;
       SET ROLE "${grp}"; REVOKE SELECT ON public.api_keys FROM "${g3}" CASCADE;
       GRANT SELECT (id) ON public.api_keys TO "${g3}" WITH GRANT OPTION; RESET ROLE;
       SET ROLE "${g3}"; GRANT SELECT (id) ON public.api_keys TO "${xApp}"; RESET ROLE`,
    )
    const failed = apply(db)
    expect(failed.status).toBe(3)
    // The owner's REVOKE also strips g3's column grants of that privilege (A90), so they follow it.
    expect(suggestedFix(failed)).toBe(
      `${inOneTransaction(
        `GRANT SELECT ON public.api_keys TO ${g3} WITH GRANT OPTION; SET ROLE ${g3}; REVOKE SELECT ON public.api_keys FROM ${db.role} CASCADE; RESET ROLE; ` +
          `REVOKE SELECT ON public.api_keys FROM ${g3} CASCADE; GRANT SELECT (id) ON public.api_keys TO ${g3} WITH GRANT OPTION;`,
      )}${AS_SUPERUSER}`,
    )
    await pasteFixAndReapply(db, failed)
  })
})

/** An object kind without columns: how to create one, a privilege on it, and how fixes name it. */
interface Kind {
  readonly label: string
  readonly create: string
  readonly privilege: string
  /** The object as GRANT names it in the setup. */
  readonly object: (db: TestDb) => string
  /** The object as the printed fix names it. */
  readonly printed: (db: TestDb) => string
}

const LARGE_OBJECT = 424242
const KINDS: readonly Kind[] = [
  {
    label: 'schema CREATE',
    create: 'CREATE SCHEMA scratch',
    privilege: 'CREATE',
    object: () => 'SCHEMA scratch',
    printed: () => 'SCHEMA scratch',
  },
  {
    label: 'database CREATE',
    create: 'SELECT 1',
    privilege: 'CREATE',
    object: (db) => `DATABASE ${db.name}`,
    printed: (db) => `DATABASE ${db.name}`,
  },
  {
    label: 'SECURITY DEFINER routine EXECUTE',
    create:
      "CREATE FUNCTION public.peek() RETURNS int SECURITY DEFINER LANGUAGE sql AS 'SELECT 1'; REVOKE EXECUTE ON FUNCTION public.peek() FROM PUBLIC",
    privilege: 'EXECUTE',
    object: () => 'FUNCTION public.peek()',
    printed: () => 'ROUTINE public.peek()',
  },
  {
    label: 'foreign server USAGE',
    create:
      'CREATE FOREIGN DATA WRAPPER nothing; CREATE SERVER elsewhere FOREIGN DATA WRAPPER nothing',
    privilege: 'USAGE',
    object: () => 'FOREIGN SERVER elsewhere',
    printed: () => 'FOREIGN SERVER elsewhere',
  },
  {
    label: 'large object SELECT',
    create: `SELECT lo_create(${LARGE_OBJECT})`,
    privilege: 'SELECT',
    object: () => `LARGE OBJECT ${LARGE_OBJECT}`,
    printed: () => `LARGE OBJECT ${LARGE_OBJECT}`,
  },
  {
    label: 'catalog routine EXECUTE',
    create: 'SELECT 1',
    privilege: 'EXECUTE',
    object: () => 'FUNCTION pg_catalog.pg_ls_dir(text)',
    printed: () => 'ROUTINE pg_catalog.pg_ls_dir(text)',
  },
  {
    label: 'catalog schema CREATE',
    create: 'SELECT 1',
    privilege: 'CREATE',
    object: () => 'SCHEMA pg_catalog',
    printed: () => 'SCHEMA pg_catalog',
  },
]

describe('an object grant masked by a group option', () => {
  for (const kind of KINDS) {
    it(`A91, D127, D128: ${kind.label} that g3 passed on after its grant is gone is revoked with an option borrowed from the group`, async () => {
      const s = await setUp()
      const { db, g3, grp } = s
      const object = kind.object(db)
      await adminQuery(
        db.name,
        `${kind.create};
         GRANT ${kind.privilege} ON ${object} TO "${grp}", "${g3}" WITH GRANT OPTION;
         SET ROLE "${g3}"; GRANT ${kind.privilege} ON ${object} TO "${db.role}"; RESET ROLE;
         REVOKE ${kind.privilege} ON ${object} FROM "${g3}" CASCADE`,
      )
      const failed = apply(db)
      expect(failed.status).toBe(3)
      const printed = kind.printed(db)
      expect(suggestedFix(failed)).toBe(borrowedFix(s, kind.privilege, printed, printed, db.role))
      await pasteFixAndReapply(db, failed)
    })
  }
})
