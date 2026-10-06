// D24, D76: the reader role must not be able to create objects in any schema, or schemas in the
// database (CVE-2018-1058).
import pg from 'pg'
import { afterEach, describe, expect, it } from 'vitest'
import {
  adminQuery,
  apply,
  createTestDatabase,
  dropTestDatabase,
  pasteFixAndReapply,
  psql,
  suggestedFix,
  type TestDb,
  urlFor,
} from './helpers/db.ts'

const created: TestDb[] = []
afterEach(async () => {
  for (const db of created.splice(0)) await dropTestDatabase(db)
})
async function freshDb(hardenPublicSchema: boolean): Promise<TestDb> {
  const db = await createTestDatabase({ hardenPublicSchema })
  created.push(db)
  return db
}

describe('CREATE privilege', () => {
  it('D24: apply aborts when the role can create objects in a schema, naming the REVOKE', async () => {
    const db = await freshDb(true)
    await adminQuery(db.name, 'CREATE SCHEMA scratch; GRANT CREATE ON SCHEMA scratch TO PUBLIC')
    const result = apply(db)
    expect(result.status).toBe(3)
    expect(result.stderr).toContain(
      `role ${db.role} can create objects in schemas: scratch. Fix: REVOKE CREATE ON SCHEMA scratch FROM PUBLIC CASCADE;`,
    )
  })

  it('D24: where PUBLIC holds CREATE on public (the PostgreSQL ≤14 default), apply aborts', async () => {
    const db = await freshDb(false)
    // Granted explicitly so the test does not depend on the server major (A15).
    await adminQuery(db.name, 'GRANT CREATE ON SCHEMA public TO PUBLIC')
    const result = apply(db)
    expect(result.status).toBe(3)
    expect(result.stderr).toContain(`role ${db.role} can create objects in schemas: public. Fix: `)
    expect(suggestedFix(result)).toBe('REVOKE CREATE ON SCHEMA public FROM PUBLIC CASCADE;')
  })

  it('D24: the suggested REVOKE fixes it', async () => {
    const db = await freshDb(false)
    await adminQuery(db.name, 'GRANT CREATE ON SCHEMA public TO PUBLIC')
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(failed.stderr).toContain(`role ${db.role} can create objects in schemas: public. Fix: `)
    expect(psql(db.name, suggestedFix(failed)).status).toBe(0)
    expect(apply(db).status).toBe(0)
  })

  it('D82: a schema the role owns is refused as owned before CREATE is checked', async () => {
    const db = await freshDb(true)
    expect(apply(db).status).toBe(0)
    await adminQuery(db.name, `CREATE SCHEMA scratch; ALTER SCHEMA scratch OWNER TO "${db.role}"`)
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(failed.stderr).toContain(
      `role ${db.role} owns objects it must not own: schema scratch. Fix: REASSIGN OWNED BY ${db.role} TO CURRENT_USER; -- run as an administrator`,
    )
    expect(psql(db.name, suggestedFix(failed)).status).toBe(0)
    expect(apply(db).status).toBe(0)
  })

  it('D24: a direct CREATE grant names the role in the fix', async () => {
    const db = await freshDb(true)
    expect(apply(db).status).toBe(0)
    await adminQuery(
      db.name,
      `CREATE SCHEMA scratch; GRANT CREATE ON SCHEMA scratch TO "${db.role}"`,
    )
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(failed.stderr).toContain(`role ${db.role} can create objects in schemas: scratch. Fix: `)
    expect(suggestedFix(failed)).toBe(`REVOKE CREATE ON SCHEMA scratch FROM ${db.role} CASCADE;`)
    expect(psql(db.name, suggestedFix(failed)).status).toBe(0)
    expect(apply(db).status).toBe(0)
  })

  it("D24: the applying session's own temporary schema is not a leak", async () => {
    const db = await freshDb(true)
    // A TEMP table earlier in the same session gives it a pg_temp_N schema, in which every role
    // with TEMP on the database (PUBLIC by default) counts as holding CREATE.
    const result = psql(
      db.name,
      `CREATE TEMP TABLE scratch (id int);\n${db.files['redacted-views.sql']}`,
    )
    expect(result.status, result.stderr).toBe(0)
  })

  it("D24: a CREATE grant on another session's temporary schema aborts apply", async () => {
    const db = await freshDb(true)
    expect(apply(db).status).toBe(0)
    // Another session creates a temp table and stays connected, so its pg_temp_N schema exists.
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
      const failed = apply(db)
      expect(failed.status).toBe(3)
      expect(failed.stderr).toContain(
        `role ${db.role} can create objects in schemas: ${temp}. Fix: REVOKE CREATE ON SCHEMA ${temp} FROM ${db.role} CASCADE;`,
      )
    } finally {
      await other.end()
    }
  })
})

describe('CREATE on the database', () => {
  it('D76: CREATE on the database for PUBLIC and the reader aborts apply, and the printed REVOKE fixes it', async () => {
    const db = await freshDb(true)
    expect(apply(db).status).toBe(0)
    await adminQuery('postgres', `GRANT CREATE ON DATABASE ${db.name} TO PUBLIC, "${db.role}"`)
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(failed.stderr).toContain(
      `role ${db.role} can create schemas in database ${db.name}. Fix: REVOKE CREATE ON DATABASE ${db.name} FROM PUBLIC, ${db.role} CASCADE;`,
    )
    pasteFixAndReapply(db, failed)
  })
})
