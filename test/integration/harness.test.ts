import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  apply,
  connectAsReader,
  createTestDatabase,
  dropTestDatabase,
  type TestDb,
} from './helpers/db.ts'

let db: TestDb
beforeEach(async () => {
  db = await createTestDatabase()
})
afterEach(async () => {
  await dropTestDatabase(db)
})

describe('integration harness', () => {
  it('D43: psql -v ON_ERROR_STOP=1 applies the generated script inside the database container', () => {
    const result = apply(db)
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  it('D1: the AI role sees exactly the visible columns of each view', async () => {
    expect(apply(db).status).toBe(0)
    const reader = await connectAsReader(db)
    try {
      const { rows } = await reader.query(
        `SELECT table_name, string_agg(column_name::text, ',' ORDER BY ordinal_position) AS columns
           FROM information_schema.columns WHERE table_schema = 'ai' GROUP BY table_name ORDER BY table_name`,
      )
      expect(rows).toEqual([
        { table_name: 'orders', columns: 'id,user_id,total_cents,placed_at' },
        { table_name: 'users', columns: 'id,created_at,country,plan' },
      ])
      const users = await reader.query('SELECT * FROM users')
      expect(users.rows).toEqual([expect.objectContaining({ id: 1, country: 'DE', plan: 'PRO' })])
      expect(Object.keys(users.rows[0] ?? {})).toEqual(['id', 'created_at', 'country', 'plan'])
    } finally {
      await reader.end()
    }
  })

  it('D22: a missing docker CLI fails loudly with an actionable message, not as a psql failure', () => {
    const path = process.env.PATH
    process.env.PATH = '/nonexistent-hyde-db-no-docker'
    try {
      expect(() => apply(db)).toThrow(
        'integration tests need the docker CLI on PATH (psql runs inside the database container, D43)',
      )
    } finally {
      process.env.PATH = path
    }
  })
})
