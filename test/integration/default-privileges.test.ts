// D91: the final check refuses default privileges of other roles that would make objects created
// later readable to the reader role (A53, A59, A65), and prints the ALTER DEFAULT PRIVILEGES that
// removes them; the reader's own defaults are ignored (A71).
import { afterEach, describe, expect, inject, it } from 'vitest'
import {
  adminQuery,
  apply,
  connectAsReader,
  createTestDatabase,
  dropTestDatabase,
  inOneTransaction,
  pasteFixAndReapply,
  serverVersion,
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
/** The container's superuser, who runs the ALTER DEFAULT PRIVILEGES below and so owns the defaults. */
const admin = inject('pg').user

/** Whether the reader role holds any privilege on a table created after the defaults were set. */
async function readerCanUseNewTable(db: TestDb): Promise<boolean> {
  await adminQuery(db.name, 'CREATE TABLE public.later (id int)')
  const [row] = await adminQuery(
    db.name,
    `SELECT has_table_privilege('${db.role}', 'public.later', 'SELECT, INSERT, UPDATE, DELETE') AS can`,
  )
  return row?.can === true
}

describe('default privileges', () => {
  it('D91: default privileges granting the reader SELECT on future tables abort apply, and the printed fix works', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    await adminQuery(
      db.name,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO "${db.role}"`,
    )
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(failed.stderr).toContain(
      `role ${db.role} gets privileges on objects created later (default privileges): tables created by ${admin} in schema public. Fix: ALTER DEFAULT PRIVILEGES FOR ROLE ${admin} IN SCHEMA public REVOKE ALL ON TABLES FROM ${db.role};`,
    )
    await pasteFixAndReapply(db, failed)
    expect(await readerCanUseNewTable(db)).toBe(false)
  })

  it('D91: default privileges granting PUBLIC SELECT on future tables abort apply, and the printed fix works', async () => {
    const db = await freshDb()
    await adminQuery(
      db.name,
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO PUBLIC',
    )
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(suggestedFix(failed)).toBe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${admin} IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;`,
    )
    await pasteFixAndReapply(db, failed)
    expect(await readerCanUseNewTable(db)).toBe(false)
  })

  it('D91: database-wide defaults are fixed without IN SCHEMA, for sequences to PUBLIC and functions to the reader', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    await adminQuery(
      db.name,
      `ALTER DEFAULT PRIVILEGES GRANT USAGE ON SEQUENCES TO PUBLIC;
       ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO "${db.role}"`,
    )
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(failed.stderr).toContain(
      `(default privileges): sequences created by ${admin}, functions created by ${admin}. Fix: `,
    )
    expect(suggestedFix(failed)).toBe(
      inOneTransaction(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${admin} REVOKE ALL ON SEQUENCES FROM PUBLIC; ALTER DEFAULT PRIVILEGES FOR ROLE ${admin} REVOKE ALL ON FUNCTIONS FROM ${db.role};`,
      ),
    )
    await pasteFixAndReapply(db, failed)
  })

  it('D91: default privileges granting PUBLIC CREATE on future schemas abort apply, and the printed fix works', async () => {
    const db = await freshDb()
    await adminQuery(db.name, 'ALTER DEFAULT PRIVILEGES GRANT CREATE ON SCHEMAS TO PUBLIC')
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(failed.stderr).toContain(
      `(default privileges): schemas created by ${admin}. Fix: ALTER DEFAULT PRIVILEGES FOR ROLE ${admin} REVOKE ALL ON SCHEMAS FROM PUBLIC;`,
    )
    await pasteFixAndReapply(db, failed)
  })

  it('A65, D91: PUBLIC default privileges on large objects abort apply on PostgreSQL 18; earlier servers have none and pass', async () => {
    const db = await freshDb()
    if ((await serverVersion(db.name)) >= 180000) {
      await adminQuery(db.name, 'ALTER DEFAULT PRIVILEGES GRANT SELECT ON LARGE OBJECTS TO PUBLIC')
      const failed = apply(db)
      expect(failed.status).toBe(3)
      expect(failed.stderr).toContain(
        `(default privileges): large objects created by ${admin}. Fix: ALTER DEFAULT PRIVILEGES FOR ROLE ${admin} REVOKE ALL ON LARGE OBJECTS FROM PUBLIC;`,
      )
      await pasteFixAndReapply(db, failed)
    } else {
      const result = apply(db)
      expect(result.status, result.stderr).toBe(0)
    }
  })

  it("D91: PUBLIC's defaults on functions and types are not refused", async () => {
    const db = await freshDb()
    await adminQuery(
      db.name,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
       ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON TYPES TO PUBLIC`,
    )
    const result = apply(db)
    expect(result.status, result.stderr).toBe(0)
  })

  it("A71, D91: the reader's own default privileges do not block the deploy", async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    const reader = await connectAsReader(db)
    try {
      await reader.query('SET default_transaction_read_only = off')
      await reader.query('ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC')
    } finally {
      await reader.end()
    }
    const [row] = await adminQuery(
      db.name,
      `SELECT count(*)::int AS n FROM pg_default_acl WHERE defaclrole = '${db.role}'::regrole`,
    )
    expect(row?.n).toBe(1)
    const result = apply(db)
    expect(result.status, result.stderr).toBe(0)
  })
})
