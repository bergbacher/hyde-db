// Attack suite (D1): apply the generated script to a real PostgreSQL, then attack the reader role.
import pg from 'pg'
import { afterEach, describe, expect, it } from 'vitest'
import {
  adminQuery,
  apply,
  buildFiles,
  connectAsReader,
  createTestDatabase,
  dropTestDatabase,
  psql,
  suggestedFix,
  type TestDb,
  urlFor,
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
/** Waits until a closed client's server process has exited (it does so asynchronously). */
async function backendExited(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const rows = await adminQuery('postgres', `SELECT 1 FROM pg_stat_activity WHERE pid = ${pid}`)
    if (rows.length === 0) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`server process ${pid} did not exit`)
}

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

  it('D69, D89: a direct column grant on a source table aborts apply, and the printed REVOKE fixes it', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    await adminQuery(
      db.name,
      `GRANT USAGE ON SCHEMA public TO "${db.role}"; GRANT SELECT (email) ON public.users TO "${db.role}"`,
    )
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(failed.stderr).toContain(
      `role ${db.role} can read relations outside schema redacted: public.users. Fix: REVOKE ALL ON public.users FROM ${db.role} CASCADE;`,
    )
    expect(psql(db.name, suggestedFix(failed)).status).toBe(0)
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

  it('D1, D89: membership in pg_read_all_data aborts apply, and the printed REVOKE fixes it', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    await adminQuery('postgres', `GRANT pg_read_all_data TO "${db.role}"`)
    const result = apply(db)
    expect(result.status).toBe(3)
    expect(result.stderr).toContain(
      `role ${db.role} must not be a member of other roles: pg_read_all_data. Fix: REVOKE pg_read_all_data FROM ${db.role}`,
    )
    expect(psql(db.name, suggestedFix(result)).status).toBe(0)
    expect(apply(db).status).toBe(0)
  })

  it("A45: a CREATE grant on an ended session's pg_temp_N still aborts apply", async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    // Another session creates a temp table and ends; its pg_temp_N schema stays behind.
    const other = new pg.Client({ connectionString: urlFor(db.name) })
    await other.connect()
    let session: { name: string; pid: number } | undefined
    try {
      await other.query('CREATE TEMP TABLE scratch (id int)')
      const { rows } = await other.query<{ name: string; pid: number }>(
        'SELECT pg_my_temp_schema()::regnamespace::text AS name, pg_backend_pid() AS pid',
      )
      session = rows[0]
    } finally {
      await other.end()
    }
    const temp = session?.name ?? ''
    expect(temp).toMatch(/^pg_temp_\d+$/)
    await backendExited(Number(session?.pid))
    expect(
      await adminQuery(db.name, `SELECT nspname FROM pg_namespace WHERE nspname = '${temp}'`),
    ).toEqual([{ nspname: temp }])
    await adminQuery(db.name, `GRANT CREATE ON SCHEMA ${temp} TO "${db.role}"`)
    const failed = apply(db)
    expect(failed.status).toBe(3)
    expect(failed.stderr).toContain(
      `role ${db.role} can create objects in schemas: ${temp}. Fix: REVOKE CREATE ON SCHEMA ${temp} FROM ${db.role} CASCADE;`,
    )
    expect(psql(db.name, suggestedFix(failed)).status).toBe(0)
    expect(apply(db).status).toBe(0)
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

  it('A41: a login given once survives a re-apply', async () => {
    const db = await freshDb()
    expect(apply(db).status).toBe(0)
    await adminQuery('postgres', `ALTER ROLE "${db.role}" LOGIN PASSWORD '${db.password}'`)
    expect(apply(db).status).toBe(0)
    const reader = new pg.Client({ connectionString: urlFor(db.name, db.role, db.password) })
    await reader.connect()
    try {
      expect((await reader.query('SELECT current_user AS who')).rows[0]).toEqual({ who: db.role })
    } finally {
      await reader.end()
    }
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

  /**
   * A non-superuser deploy owner as on managed PostgreSQL: CREATEROLE, owns public, and holds the
   * given table privileges (by default all of them).
   */
  async function managedOwner(
    db: TestDb,
    tablePrivileges = 'ALL ON ALL TABLES IN SCHEMA public',
  ): Promise<string> {
    const owner = await extraRole(`${db.name}_owner`, "LOGIN CREATEROLE PASSWORD 'owner'")
    await adminQuery(
      db.name,
      `ALTER SCHEMA public OWNER TO ${owner}; GRANT ${tablePrivileges} TO ${owner}; GRANT CREATE ON DATABASE ${db.name} TO ${owner}`,
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

  it('D69: a deployer that owns no unrelated source table can still apply', async () => {
    const db = await freshDb()
    // SELECT on the tables the views read, nothing on api_keys.
    const owner = await managedOwner(db, 'SELECT ON public.users, public.orders')
    const result = psql(db.name, `SET ROLE ${owner};\n${db.files['redacted-views.sql']}`)
    expect(result.status, result.stderr).toBe(0)
    const reader = await connectAsReader(db)
    try {
      expect((await reader.query('SELECT id, country FROM users')).rows).toEqual([
        { id: 1, country: 'DE' },
      ])
      for (const table of ['public.users', 'public.orders', 'public.api_keys']) {
        await expect(reader.query(`SELECT * FROM ${table}`)).rejects.toMatchObject({
          code: '42501',
        })
      }
    } finally {
      await reader.end()
    }
  })

  it("A39: a reader role that already exists as SUPERUSER stops the owner's apply before any change", async () => {
    const db = await freshDb()
    const owner = await managedOwner(db)
    await adminQuery('postgres', `CREATE ROLE "${db.role}" NOLOGIN SUPERUSER`)
    const script = `SET ROLE ${owner};\n${db.files['redacted-views.sql']}`
    const failed = psql(db.name, script)
    expect(failed.status).toBe(3)
    // The first ALTER ROLE … SET stops it, before the attribute check of the final check (D49).
    const line =
      script.split('\n').findIndex((l) => l.startsWith(`ALTER ROLE "${db.role}" SET `)) + 1
    const [server] = await adminQuery(
      db.name,
      "SELECT current_setting('server_version_num')::int AS version",
    )
    // PostgreSQL 16 reworded the permission error (observed: 14 vs 16 and 18).
    const permissionError =
      Number(server?.version) >= 160000
        ? 'ERROR:  permission denied to alter role'
        : 'ERROR:  must be superuser to alter superusers'
    expect(failed.stderr).toContain(`psql:<stdin>:${line}: ${permissionError}`)
    expect(
      await adminQuery(db.name, "SELECT 1 FROM pg_namespace WHERE nspname = 'redacted'"),
    ).toEqual([])
    // The documented admin fix; PostgreSQL 14 accepts the WITH ADMIN OPTION grant as well.
    const fixed = psql(
      db.name,
      `ALTER ROLE "${db.role}" NOSUPERUSER;\nGRANT "${db.role}" TO ${owner} WITH ADMIN OPTION;`,
    )
    expect(fixed.status, fixed.stderr).toBe(0)
    const result = psql(db.name, script)
    expect(result.status, result.stderr).toBe(0)
  })
})
