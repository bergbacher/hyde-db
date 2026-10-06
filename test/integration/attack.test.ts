// Attack suite (D1): apply the generated script to a real PostgreSQL, then attack the reader role.
import { afterEach, describe, expect, it } from 'vitest'
import {
  adminQuery,
  apply,
  buildFiles,
  connectAsReader,
  createTestDatabase,
  dropTestDatabase,
  psql,
  type TestDb,
} from './helpers/db.ts'

const created: TestDb[] = []
const extraRoles: string[] = []
async function freshDb(options?: Parameters<typeof createTestDatabase>[0]): Promise<TestDb> {
  const db = await createTestDatabase(options)
  created.push(db)
  return db
}
/** Creates a cluster-wide role besides the reader role; it is dropped after the test's database. */
async function extraRole(name: string, attributes: string): Promise<string> {
  extraRoles.push(name)
  await adminQuery('postgres', `CREATE ROLE ${name} ${attributes}`)
  return name
}
afterEach(async () => {
  for (const db of created.splice(0)) await dropTestDatabase(db)
  for (const role of extraRoles.splice(0)) await adminQuery('postgres', `DROP ROLE ${role}`)
})

describe('reading', () => {
  it('D1: hidden columns do not exist in the views', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    const reader = await connectAsReader(db)
    try {
      await expect(reader.query('SELECT email FROM users')).rejects.toMatchObject({ code: '42703' })
      await expect(
        reader.query('SELECT left(shipping_address, 1) FROM orders'),
      ).rejects.toMatchObject({ code: '42703' })
    } finally {
      await reader.end()
    }
  })

  it('D1: the reader role cannot read base tables or excluded models', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    const reader = await connectAsReader(db)
    try {
      await expect(reader.query('SELECT * FROM public.users')).rejects.toMatchObject({
        code: '42501',
      })
      await expect(reader.query('SELECT secret FROM public.api_keys')).rejects.toMatchObject({
        code: '42501',
      })
    } finally {
      await reader.end()
    }
  })
})

describe('session settings', () => {
  it('A2: redacted_reader can SET default_transaction_read_only off but still cannot write', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    const reader = await connectAsReader(db)
    try {
      const insert = "INSERT INTO users (country, plan) VALUES ('XX', 'FREE')"
      await expect(reader.query(insert)).rejects.toMatchObject({ code: '42501' })
      await reader.query('SET default_transaction_read_only = off')
      expect((await reader.query('SHOW default_transaction_read_only')).rows[0]).toEqual({
        default_transaction_read_only: 'off',
      })
      await expect(reader.query(insert)).rejects.toMatchObject({ code: '42501' })
      await expect(reader.query("UPDATE users SET country = 'XX'")).rejects.toMatchObject({
        code: '42501',
      })
      await expect(reader.query('CREATE TABLE redacted.planted (id int)')).rejects.toMatchObject({
        code: '42501',
      })
    } finally {
      await reader.end()
    }
  })

  it('A2: redacted_reader can override its role-level statement_timeout with SET', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    const reader = await connectAsReader(db)
    try {
      expect((await reader.query('SHOW statement_timeout')).rows[0]).toEqual({
        statement_timeout: '15s',
      })
      await reader.query('SET statement_timeout = 0')
      expect((await reader.query('SHOW statement_timeout')).rows[0]).toEqual({
        statement_timeout: '0',
      })
    } finally {
      await reader.end()
    }
  })

  it('A32: after SET default_transaction_read_only off, redacted_reader can create TEMP tables', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    const reader = await connectAsReader(db)
    try {
      await expect(reader.query('CREATE TEMP TABLE scratch (id int)')).rejects.toMatchObject({
        code: '25006',
      })
      await reader.query('SET default_transaction_read_only = off')
      await reader.query('CREATE TEMP TABLE scratch (id int)')
    } finally {
      await reader.end()
    }
  })
})

describe('final check', () => {
  it('D1: a PUBLIC SELECT grant on a source table aborts apply and changes nothing', async () => {
    const db = await freshDb()
    await adminQuery(db.name, 'GRANT SELECT ON public.users TO PUBLIC')
    const result = apply(db)
    expect(result.status).toBe(3)
    expect(result.stderr).toContain(
      `role ${db.role} can read relations outside schema redacted: public.users`,
    )
    expect(
      await adminQuery(db.name, "SELECT 1 FROM pg_namespace WHERE nspname = 'redacted'"),
    ).toEqual([])
  })

  it('D1: apply revokes direct grants on source-schema tables, column grants included', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    await adminQuery(
      db.name,
      `GRANT USAGE ON SCHEMA public TO "${db.role}"; GRANT SELECT (email) ON public.users TO "${db.role}"`,
    )
    expect(apply(db).status).toBe(0)
    const reader = await connectAsReader(db)
    try {
      await expect(reader.query('SELECT email FROM public.users')).rejects.toMatchObject({
        code: '42501',
      })
    } finally {
      await reader.end()
    }
  })

  it('D1: a column grant outside the source schema aborts apply', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    await adminQuery(
      db.name,
      `CREATE SCHEMA billing; CREATE TABLE billing.cards (id int, number text);
       GRANT USAGE ON SCHEMA billing TO "${db.role}"; GRANT SELECT (number) ON billing.cards TO "${db.role}"`,
    )
    const result = apply(db)
    expect(result.status).toBe(3)
    expect(result.stderr).toContain(
      `role ${db.role} can read relations outside schema redacted: billing.cards`,
    )
  })

  it('D1: membership in another role aborts apply', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    const group = await extraRole(`${db.name}_group`, 'NOLOGIN')
    await adminQuery('postgres', `GRANT ${group} TO "${db.role}"`)
    const result = apply(db)
    expect(result.status).toBe(3)
    expect(result.stderr).toContain(`role ${db.role} must not be a member of other roles`)
  })

  it('D1: membership in pg_read_all_data aborts apply', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    await adminQuery('postgres', `GRANT pg_read_all_data TO "${db.role}"`)
    const result = apply(db)
    expect(result.status).toBe(3)
    expect(result.stderr).toContain(`role ${db.role} can read relations outside schema redacted: `)
  })
})

describe('deploy workflow', () => {
  it('D1: repeated apply is idempotent', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    expect(apply(db).status).toBe(0)
    const views = await adminQuery(
      db.name,
      "SELECT viewname FROM pg_views WHERE schemaname = 'redacted' ORDER BY 1",
    )
    expect(views).toEqual([{ viewname: 'orders' }, { viewname: 'users' }])
  })

  it('D43: drop → migrate → apply lets a migration change a column the views use', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    const migration = 'ALTER TABLE public.orders ALTER COLUMN total_cents TYPE bigint;'
    const blocked = psql(db.name, migration)
    expect(blocked.status).toBe(3)
    expect(blocked.stderr).toContain('cannot alter type of a column used by a view or rule')
    expect(psql(db.name, db.files['redacted-views-drop.sql']).status).toBe(0)
    expect(psql(db.name, migration).status).toBe(0)
    expect(apply(db).status).toBe(0)
  })

  it('an empty build applies cleanly', async () => {
    const db = await freshDb()
    const empty = buildFiles(
      db.role,
      'datasource db {\n  provider = "postgresql"\n}\ngenerator redacted {\n  provider = "hyde-db"\n}\n',
    )
    expect(apply(db, empty['redacted-views.sql']).status).toBe(0)
  })
})

describe('cluster', () => {
  it('A14: redacted_reader can connect to another database in the cluster through PUBLIC CONNECT', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    const other = `${db.name}_other`
    await adminQuery('postgres', `CREATE DATABASE ${other}`)
    try {
      const reader = await connectAsReader(db, other)
      try {
        expect((await reader.query('SELECT current_database() AS db')).rows[0]).toEqual({
          db: other,
        })
      } finally {
        await reader.end()
      }
      await adminQuery('postgres', `REVOKE CONNECT ON DATABASE ${other} FROM PUBLIC`)
      await expect(connectAsReader(db, other)).rejects.toMatchObject({ code: '42501' })
    } finally {
      // Dropped before the reader role, so the role holds nothing in another database when the
      // harness drops it.
      await adminQuery('postgres', `DROP DATABASE IF EXISTS ${other} WITH (FORCE)`)
    }
  })

  it('A15: PUBLIC holds CREATE on schema public exactly on PostgreSQL ≤14', async () => {
    const db = await freshDb({ hardenPublicSchema: false })
    const [row] = await adminQuery(
      db.name,
      `SELECT current_setting('server_version_num')::int AS version,
              EXISTS (SELECT 1 FROM pg_namespace n, aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
                      WHERE n.nspname = 'public' AND a.grantee = 0 AND a.privilege_type = 'CREATE') AS public_create`,
    )
    expect(row?.public_create).toBe(Number(row?.version) < 150000)
  })

  /** A non-superuser deploy owner as on managed PostgreSQL: CREATEROLE, owns public and its tables' rights. */
  async function managedOwner(db: TestDb): Promise<string> {
    const owner = await extraRole(`${db.name}_owner`, "LOGIN CREATEROLE PASSWORD 'owner'")
    await adminQuery(
      db.name,
      `ALTER SCHEMA public OWNER TO ${owner}; GRANT ALL ON ALL TABLES IN SCHEMA public TO ${owner}; GRANT CREATE ON DATABASE ${db.name} TO ${owner}`,
    )
    return owner
  }

  it('A31: a non-superuser owner with CREATEROLE cannot reset role attributes', async () => {
    const db = await freshDb()
    const owner = await managedOwner(db)
    // The owner creates the reader role, as the script does on its first deploy.
    expect(psql(db.name, `SET ROLE ${owner};\nCREATE ROLE "${db.role}" NOLOGIN;`).status).toBe(0)
    const result = psql(
      db.name,
      `SET ROLE ${owner};\nALTER ROLE "${db.role}" NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`,
    )
    expect(result.status).toBe(3)
    expect(result.stderr).toMatch(/superuser|permission denied/)
  })

  it('D49: a non-superuser owner with CREATEROLE can apply the script', async () => {
    const db = await freshDb()
    const owner = await managedOwner(db)
    const result = psql(db.name, `SET ROLE ${owner};\n${db.files['redacted-views.sql']}`)
    expect(result.status, result.stderr).toBe(0)
    const reader = await connectAsReader(db)
    try {
      expect((await reader.query('SELECT id, country FROM users')).rows).toEqual([
        { id: 1, country: 'DE' },
      ])
      await expect(reader.query('SELECT * FROM public.users')).rejects.toMatchObject({
        code: '42501',
      })
    } finally {
      await reader.end()
    }
  })
})
