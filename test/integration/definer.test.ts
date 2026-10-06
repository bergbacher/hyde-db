// A3 / D13: SECURITY DEFINER functions and sequences the AI role could reach.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

let db: TestDb
beforeEach(async () => {
  db = await createTestDatabase()
})
afterEach(async () => {
  await dropTestDatabase(db)
})

const PEEK = `CREATE FUNCTION public.peek(n integer) RETURNS text LANGUAGE sql SECURITY DEFINER
  AS 'SELECT email FROM public.users ORDER BY id LIMIT n'`

describe('SECURITY DEFINER functions', () => {
  it('A3: ai_reader can execute a SECURITY DEFINER function in public through PUBLIC defaults', async () => {
    expect(apply(db).status).toBe(0)
    await adminQuery(db.name, PEEK)
    const reader = await connectAsReader(db)
    try {
      const { rows } = await reader.query('SELECT public.peek(1) AS leaked')
      expect(rows[0]).toEqual({ leaked: 'ann@example.com' })
    } finally {
      await reader.end()
    }
  })

  it('D13: apply aborts when the role can execute a SECURITY DEFINER function, naming it and its REVOKE', async () => {
    await adminQuery(db.name, PEEK)
    const result = apply(db)
    expect(result.status).toBe(3)
    expect(result.stderr).toContain(
      `role ${db.role} can execute SECURITY DEFINER functions: public.peek(n integer). Fix: REVOKE EXECUTE ON ROUTINE public.peek(n integer) FROM PUBLIC;`,
    )
  })

  it('D13: the suggested REVOKE fixes it, even on a first deploy', async () => {
    await adminQuery(db.name, PEEK)
    const failed = apply(db)
    expect(psql(db.name, suggestedFix(failed)).status).toBe(0)
    expect(apply(db).status).toBe(0)
  })

  it('D13: a direct grant to the role is named in the fix', async () => {
    expect(apply(db).status).toBe(0)
    await adminQuery(
      db.name,
      `${PEEK}; GRANT EXECUTE ON FUNCTION public.peek(integer) TO "${db.role}"`,
    )
    const failed = apply(db)
    expect(suggestedFix(failed)).toBe(
      `REVOKE EXECUTE ON ROUTINE public.peek(n integer) FROM PUBLIC, ${db.role};`,
    )
    expect(psql(db.name, suggestedFix(failed)).status).toBe(0)
    expect(apply(db).status).toBe(0)
  })

  it('D13: definer functions in schemas the role cannot use, and invoker functions, are allowed', async () => {
    await adminQuery(db.name, 'CREATE SCHEMA private; REVOKE ALL ON SCHEMA private FROM PUBLIC')
    await adminQuery(db.name, PEEK.replace('public.peek', 'private.peek'))
    await adminQuery(
      db.name,
      "CREATE FUNCTION public.answer() RETURNS integer LANGUAGE sql AS 'SELECT 42'",
    )
    expect(apply(db).status).toBe(0)
  })
})

describe('sequences', () => {
  it('D13: apply aborts when the role can read a sequence, naming it and its REVOKE', async () => {
    await adminQuery(db.name, 'GRANT SELECT ON SEQUENCE public.users_id_seq TO PUBLIC')
    const result = apply(db)
    expect(result.status).toBe(3)
    expect(result.stderr).toContain(
      `role ${db.role} can read sequences: public.users_id_seq. Fix: REVOKE ALL ON SEQUENCE public.users_id_seq FROM PUBLIC;`,
    )
  })

  it('D13: the suggested REVOKE fixes a readable sequence', async () => {
    await adminQuery(db.name, 'GRANT USAGE ON SEQUENCE public.orders_id_seq TO PUBLIC')
    const failed = apply(db)
    expect(psql(db.name, suggestedFix(failed)).status).toBe(0)
    expect(apply(db).status).toBe(0)
  })
})
