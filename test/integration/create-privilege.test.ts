// D24: the AI role must not be able to create objects in any schema (CVE-2018-1058).
import { afterEach, describe, expect, it } from 'vitest'
import {
  adminQuery,
  apply,
  createTestDatabase,
  dropTestDatabase,
  psql,
  suggestedFix,
  type TestDb,
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
      `role ${db.role} can create objects in schemas: scratch. Fix: REVOKE CREATE ON SCHEMA scratch FROM PUBLIC;`,
    )
  })

  it('D24: where PUBLIC holds CREATE on public (the PostgreSQL ≤14 default), apply aborts', async () => {
    const db = await freshDb(false)
    // Granted explicitly so the test does not depend on the server major (A15).
    await adminQuery(db.name, 'GRANT CREATE ON SCHEMA public TO PUBLIC')
    const result = apply(db)
    expect(result.status).toBe(3)
    expect(result.stderr).toContain(`role ${db.role} can create objects in schemas: public. Fix: `)
    expect(suggestedFix(result)).toBe('REVOKE CREATE ON SCHEMA public FROM PUBLIC;')
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

  it('D24: a schema the role owns names the role in the fix', async () => {
    const db = await freshDb(true)
    expect(apply(db).status).toBe(0)
    await adminQuery(db.name, `CREATE SCHEMA scratch; ALTER SCHEMA scratch OWNER TO "${db.role}"`)
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(failed.stderr).toContain(`role ${db.role} can create objects in schemas: scratch. Fix: `)
    expect(suggestedFix(failed)).toBe(`REVOKE CREATE ON SCHEMA scratch FROM ${db.role};`)
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
    expect(suggestedFix(failed)).toBe(`REVOKE CREATE ON SCHEMA scratch FROM ${db.role};`)
    expect(psql(db.name, suggestedFix(failed)).status).toBe(0)
    expect(apply(db).status).toBe(0)
  })

  it("D24: the applying session's own temporary schema is not a leak", async () => {
    const db = await freshDb(true)
    // A TEMP table earlier in the same session gives it a pg_temp_N schema, in which every role
    // with TEMP on the database (PUBLIC by default) counts as holding CREATE.
    const result = psql(db.name, `CREATE TEMP TABLE scratch (id int);\n${db.files['ai-views.sql']}`)
    expect(result.status, result.stderr).toBe(0)
  })
})
