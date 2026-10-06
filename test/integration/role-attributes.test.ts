// D49: the final check refuses an AI role with elevated attributes instead of resetting them,
// so a non-superuser owner with CREATEROLE (managed PostgreSQL) can run the script (A31).
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
/** A fresh database whose AI role already exists with the given attributes. */
async function freshDb(attributes?: string): Promise<TestDb> {
  const db = await createTestDatabase()
  created.push(db)
  if (attributes !== undefined)
    await adminQuery('postgres', `CREATE ROLE "${db.role}" NOLOGIN ${attributes}`)
  return db
}

describe('role attributes', () => {
  it('D49: apply aborts when the AI role was given CREATEDB, naming the attribute and the fix', async () => {
    const db = await freshDb('CREATEDB')
    const result = apply(db)
    expect(result.status).toBe(3)
    expect(result.stderr).toContain(
      `role ${db.role} has attributes it must not have: CREATEDB. Fix: ALTER ROLE ${db.role} NOCREATEDB;`,
    )
  })

  it('D49: several attributes are all named, in a fixed order', async () => {
    const db = await freshDb('BYPASSRLS CREATEROLE')
    const result = apply(db)
    expect(result.status).toBe(3)
    expect(result.stderr).toContain(
      `role ${db.role} has attributes it must not have: CREATEROLE, BYPASSRLS. Fix: ALTER ROLE ${db.role} NOCREATEROLE NOBYPASSRLS;`,
    )
  })

  it('D49: a superuser AI role is refused by the attribute check before any other check', async () => {
    const db = await freshDb('SUPERUSER')
    const result = apply(db)
    expect(result.status).toBe(3)
    expect(result.stderr).toContain(
      `role ${db.role} has attributes it must not have: SUPERUSER. Fix: ALTER ROLE ${db.role} NOSUPERUSER;`,
    )
  })

  it('D49: the suggested ALTER ROLE fixes it', async () => {
    const db = await freshDb('CREATEDB CREATEROLE REPLICATION BYPASSRLS')
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(suggestedFix(failed)).toBe(
      `ALTER ROLE ${db.role} NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`,
    )
    expect(psql(db.name, suggestedFix(failed)).status).toBe(0)
    expect(apply(db).status).toBe(0)
  })

  it('D49: an attribute given after a first apply is refused on re-apply', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    await adminQuery('postgres', `ALTER ROLE "${db.role}" BYPASSRLS`)
    const result = apply(db)
    expect(result.status).toBe(3)
    expect(result.stderr).toContain(
      `role ${db.role} has attributes it must not have: BYPASSRLS. Fix: ALTER ROLE ${db.role} NOBYPASSRLS;`,
    )
  })

  it('D49: a role created by the script passes', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
  })
})
