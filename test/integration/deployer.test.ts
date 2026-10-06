// D134: a fix whose statements the deploying role cannot run itself is marked with the owner who
// can. A REVOKE revokes only grants made by the role that runs it, or by the owner when that role
// owns the object, belongs to the owner role or is a superuser; run by any other role, even one
// holding the grant option, it changes nothing (A95), and an agent pasting it would loop.
import pg from 'pg'
import { afterEach, describe, expect, it } from 'vitest'
import {
  adminQuery,
  createTestDatabase,
  dropTestDatabase,
  inOneTransaction,
  pasteFix,
  pasteFixAndReapply,
  psql,
  serverVersion,
  suggestedFix,
  type TestDb,
  urlFor,
} from './helpers/db.ts'

const created: TestDb[] = []
const roles: string[] = []
afterEach(async () => {
  for (const db of created.splice(0)) await dropTestDatabase(db)
  for (const role of roles.splice(0).reverse()) await adminQuery('postgres', `DROP ROLE "${role}"`)
})

async function extraRole(name: string, attributes = 'NOLOGIN'): Promise<string> {
  roles.push(name)
  await adminQuery('postgres', `CREATE ROLE "${name}" ${attributes}`)
  return name
}

interface Deployment {
  readonly db: TestDb
  /** A non-superuser LOGIN CREATEROLE role that owns the database and reads the source tables. */
  readonly deployer: string
  /** The apply script as the deployer runs it. */
  readonly script: string
}

/** A database owned by a non-superuser deployer, as on a managed service. */
async function deployment(options: { hardenPublicSchema?: boolean } = {}): Promise<Deployment> {
  const db = await createTestDatabase(options)
  created.push(db)
  const deployer = await extraRole(`${db.name}_deployer`, 'LOGIN CREATEROLE')
  await adminQuery(
    db.name,
    `ALTER DATABASE ${db.name} OWNER TO "${deployer}"; GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${deployer}"`,
  )
  return { db, deployer, script: `SET ROLE "${deployer}";\n${db.files['redacted-views.sql']}` }
}

/** The role `sql` names, as a fix prints it. */
async function roleName(db: TestDb, sql: string): Promise<string> {
  const [row] = await adminQuery(db.name, `SELECT (${sql})::regrole::text AS name`)
  return String(row?.name)
}

describe('fixes the deployer cannot run itself', () => {
  it('A95, D134: CREATE on schema public is marked with its owner where the database owner cannot revoke it (PostgreSQL 14 and older), and unmarked where it can', async () => {
    const { db, deployer, script } = await deployment({ hardenPublicSchema: false })
    await adminQuery(db.name, 'GRANT CREATE ON SCHEMA public TO PUBLIC')
    const failed = psql(db.name, script)
    expect(failed.status).toBe(3)
    const fix = 'REVOKE CREATE ON SCHEMA public FROM PUBLIC CASCADE;'
    if ((await serverVersion(db.name)) < 150000) {
      // Schema public belongs to the bootstrap superuser here.
      const owner = await roleName(db, "SELECT nspowner FROM pg_namespace WHERE nspname = 'public'")
      expect(suggestedFix(failed)).toBe(`${fix} -- run as ${owner} or a superuser`)
      // Pasted by the deployer, it prints a warning, exits 0 and changes nothing (A95)…
      const own = await pasteFix(db, failed, { role: deployer })
      expect(own.stderr).toContain('WARNING:  no privileges could be revoked for "public"')
      expect(psql(db.name, script).status).toBe(3)
      // …while the role it names fixes it.
      await pasteFixAndReapply(db, failed, { script })
    } else {
      // From PostgreSQL 15 on, public belongs to pg_database_owner, which the deployer acts as.
      expect(suggestedFix(failed)).toBe(fix)
      await pasteFixAndReapply(db, failed, { script, role: deployer })
    }
  })

  it('D134: a catalog fix is marked with the owner of the catalog', async () => {
    const { db, script } = await deployment()
    expect(psql(db.name, script).status).toBe(0)
    await adminQuery(
      db.name,
      `GRANT EXECUTE ON FUNCTION pg_catalog.pg_ls_dir(text) TO "${db.role}"`,
    )
    const failed = psql(db.name, script)
    expect(failed.status).toBe(3)
    const owner = await roleName(
      db,
      "SELECT proowner FROM pg_proc WHERE oid = 'pg_catalog.pg_ls_dir(text)'::regprocedure",
    )
    expect(suggestedFix(failed)).toBe(
      `REVOKE EXECUTE ON ROUTINE pg_catalog.pg_ls_dir(text) FROM ${db.role} CASCADE; -- run as ${owner} or a superuser`,
    )
    await pasteFixAndReapply(db, failed, { script })
  })

  it("D134: a fix for another session's pg_temp_N is marked with the owner of that schema", async () => {
    const { db, script } = await deployment()
    expect(psql(db.name, script).status).toBe(0)
    const other = new pg.Client({ connectionString: urlFor(db.name) })
    await other.connect()
    try {
      await other.query('CREATE TEMP TABLE scratch (id int)')
      const { rows } = await other.query<{ name: string }>(
        'SELECT pg_my_temp_schema()::regnamespace::text AS name',
      )
      const temp = rows[0]?.name ?? ''
      expect(temp).toMatch(/^pg_temp_\d+$/)
      await adminQuery(db.name, `GRANT CREATE ON SCHEMA ${temp} TO "${db.role}"`)
      const failed = psql(db.name, script)
      expect(failed.status).toBe(3)
      const owner = await roleName(
        db,
        `SELECT nspowner FROM pg_namespace WHERE nspname = '${temp}'`,
      )
      expect(suggestedFix(failed)).toBe(
        `REVOKE CREATE ON SCHEMA ${temp} FROM ${db.role} CASCADE; -- run as ${owner} or a superuser`,
      )
      await pasteFixAndReapply(db, failed, { script })
    } finally {
      await other.end()
    }
  })

  it("D134: a deployer that holds the grant option still cannot revoke the owner's grant; the fix names the owner, and the deployer's paste changes nothing, without a warning", async () => {
    const { db, deployer, script } = await deployment()
    const app = await extraRole(`${db.name}_app`)
    await adminQuery(
      db.name,
      `CREATE TABLE public.ledger (id int); ALTER TABLE public.ledger OWNER TO "${app}";
       SET ROLE "${app}"; GRANT SELECT ON public.ledger TO PUBLIC;
       GRANT SELECT ON public.ledger TO "${deployer}" WITH GRANT OPTION; RESET ROLE`,
    )
    const failed = psql(db.name, script)
    expect(failed.status).toBe(3)
    expect(suggestedFix(failed)).toBe(
      `REVOKE ALL ON public.ledger FROM PUBLIC CASCADE; -- run as ${app} or a superuser`,
    )
    const own = await pasteFix(db, failed, { role: deployer })
    expect(own.stderr).toBe('')
    expect(psql(db.name, script).status).toBe(3)
    await pasteFixAndReapply(db, failed, { script })
  })

  it('D134: a deployer that belongs to the owner role revokes as the owner, so its fix is not marked', async () => {
    const { db, deployer, script } = await deployment()
    const app = await extraRole(`${db.name}_app`)
    await adminQuery(
      db.name,
      `CREATE TABLE public.ledger (id int); ALTER TABLE public.ledger OWNER TO "${app}";
       SET ROLE "${app}"; GRANT SELECT ON public.ledger TO PUBLIC; RESET ROLE;
       GRANT "${app}" TO "${deployer}"`,
    )
    const failed = psql(db.name, script)
    expect(failed.status).toBe(3)
    expect(suggestedFix(failed)).toBe('REVOKE ALL ON public.ledger FROM PUBLIC CASCADE;')
    await pasteFixAndReapply(db, failed, { script, role: deployer })
  })

  it('D134: a fix for objects of several owners, one of which the deployer cannot act as, is marked for a superuser', async () => {
    const { db, deployer, script } = await deployment()
    const app = await extraRole(`${db.name}_app`)
    await adminQuery(
      db.name,
      `CREATE TABLE public.ledger (id int); ALTER TABLE public.ledger OWNER TO "${app}";
       CREATE TABLE public.notes (id int); ALTER TABLE public.notes OWNER TO "${deployer}";
       GRANT SELECT ON public.ledger, public.notes TO PUBLIC`,
    )
    const failed = psql(db.name, script)
    expect(failed.status).toBe(3)
    // The deployer alone cannot revoke on ledger, and app alone cannot revoke on notes.
    expect(suggestedFix(failed)).toBe(
      `${inOneTransaction('REVOKE ALL ON public.ledger FROM PUBLIC CASCADE; REVOKE ALL ON public.notes FROM PUBLIC CASCADE;')} -- run as a superuser`,
    )
    await pasteFixAndReapply(db, failed, { script })
  })
})
