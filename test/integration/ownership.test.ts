// D82: the final check refuses a reader role that owns any object (its own temporary objects and
// large objects excepted), because an owner can grant
// itself access again after any REVOKE (A52) or read values through its type (A55); the fix
// reassigns them.
import { afterEach, describe, expect, it } from 'vitest'
import {
  adminQuery,
  apply,
  connectAsReader,
  createTestDatabase,
  dropTestDatabase,
  pasteFixAndReapply,
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
/** The abort and fix for a reader that owns the given objects (D82). */
function ownsObjects(db: TestDb, objects: string): string {
  return `role ${db.role} owns objects it must not own: ${objects}. Fix: REASSIGN OWNED BY ${db.role} TO CURRENT_USER; -- run as an administrator`
}

describe('ownership', () => {
  it('A52, D82: a source table the reader owns aborts apply; after the fix the reader cannot grant itself access', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    await adminQuery(db.name, `ALTER TABLE public.api_keys OWNER TO "${db.role}"`)
    const reader = await connectAsReader(db)
    try {
      await reader.query('SET default_transaction_read_only = off')
      // As the owner it revokes its own access and grants it back (A52).
      await reader.query(`REVOKE ALL ON public.api_keys FROM "${db.role}"`)
      await reader.query(`GRANT SELECT ON public.api_keys TO "${db.role}"`)
      expect((await reader.query('SELECT secret FROM public.api_keys')).rows).toEqual([
        { secret: 'sk_live_example' },
      ])
      const failed = apply(db)
      expect(failed.status).toBe(3)
      expect(failed.stderr).toContain(ownsObjects(db, 'table public.api_keys'))
      pasteFixAndReapply(db, failed)
      await expect(
        reader.query(`GRANT SELECT ON public.api_keys TO "${db.role}"`),
      ).rejects.toMatchObject({ code: '42501' })
      await expect(reader.query('SELECT secret FROM public.api_keys')).rejects.toMatchObject({
        code: '42501',
      })
    } finally {
      await reader.end()
    }
  })

  it('A55, D82: a domain the reader owns, used by a source column, aborts apply; after the fix the reader cannot constrain it', async () => {
    const db = await freshDb()
    await adminQuery(
      db.name,
      'CREATE DOMAIN public.secret_t AS text; ALTER TABLE public.api_keys ALTER COLUMN secret TYPE public.secret_t',
    )
    expect(apply(db).status).toBe(0)
    await adminQuery(db.name, `ALTER DOMAIN public.secret_t OWNER TO "${db.role}"`)
    const reader = await connectAsReader(db)
    try {
      await reader.query('SET default_transaction_read_only = off')
      // Adding a constraint validates the column without a table-privilege check, and the
      // error shows the value (A55).
      await expect(
        reader.query('ALTER DOMAIN public.secret_t ADD CONSTRAINT peek CHECK (VALUE::integer > 0)'),
      ).rejects.toThrow('sk_live_example')
      const failed = apply(db)
      expect(failed.status).toBe(3)
      expect(failed.stderr).toContain(ownsObjects(db, 'type public.secret_t'))
      pasteFixAndReapply(db, failed)
      await expect(
        reader.query('ALTER DOMAIN public.secret_t ADD CONSTRAINT peek CHECK (VALUE::integer > 0)'),
      ).rejects.toMatchObject({ code: '42501' })
    } finally {
      await reader.end()
    }
  })

  it('A64, D82: a large object the reader creates does not block the deploy', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    const reader = await connectAsReader(db)
    try {
      await reader.query('SET default_transaction_read_only = off')
      await reader.query('SELECT lo_creat(-1)')
    } finally {
      await reader.end()
    }
    const result = apply(db)
    expect(result.status, result.stderr).toBe(0)
  })

  it('A52, D82: a reader that owns the database is refused with the same fix, never an empty REVOKE', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    // As database owner the role also gets the privileges of pg_database_owner, which owns
    // schema public on PostgreSQL 15+, without any grant a REVOKE could name.
    await adminQuery('postgres', `ALTER DATABASE ${db.name} OWNER TO "${db.role}"`)
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(failed.stderr).toContain(ownsObjects(db, `database ${db.name}`))
    expect(failed.stderr).not.toContain('FROM ;')
    pasteFixAndReapply(db, failed)
    expect(
      await adminQuery(
        'postgres',
        `SELECT datdba::regrole::text AS owner FROM pg_database WHERE datname = '${db.name}'`,
      ),
    ).not.toEqual([{ owner: db.role }])
  })

  it('D82: every owned object is listed by type and qualified name, in a fixed order', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    // Changing the owner of public.orders moves its serial's sequence public.orders_id_seq too.
    await adminQuery(
      db.name,
      `CREATE SCHEMA scratch; ALTER SCHEMA scratch OWNER TO "${db.role}";
       CREATE SEQUENCE public.tickets_seq; ALTER SEQUENCE public.tickets_seq OWNER TO "${db.role}";
       ALTER TABLE public.orders OWNER TO "${db.role}";
       CREATE FUNCTION public.answer() RETURNS integer LANGUAGE sql AS 'SELECT 42';
       ALTER FUNCTION public.answer() OWNER TO "${db.role}";
       ALTER TYPE public."Plan" OWNER TO "${db.role}"`,
    )
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(failed.stderr).toContain(
      ownsObjects(
        db,
        'function public.answer(), schema scratch, sequence public.orders_id_seq, sequence public.tickets_seq, table public.orders, type public."Plan"',
      ),
    )
    pasteFixAndReapply(db, failed)
  })

  it("D82: the reader's own temporary tables are not refused", async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    const reader = await connectAsReader(db)
    try {
      await reader.query('SET default_transaction_read_only = off')
      await reader.query('CREATE TEMP TABLE scratch (id int)')
      const result = apply(db)
      expect(result.status, result.stderr).toBe(0)
    } finally {
      await reader.end()
    }
  })
})
