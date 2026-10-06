import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest'
import {
  adminQuery,
  apply,
  connectAsReader,
  createTestDatabase,
  dropTestDatabase,
  psql,
  type TestDb,
} from './helpers/db.ts'

let db: TestDb
let ready = false
let fakeDockerDir: string | undefined
beforeEach(async () => {
  ready = false
  db = await createTestDatabase()
  ready = true
})
afterEach(async () => {
  vi.unstubAllEnvs()
  if (fakeDockerDir !== undefined) rmSync(fakeDockerDir, { recursive: true, force: true })
  fakeDockerDir = undefined
  if (ready) await dropTestDatabase(db)
})

/**
 * Makes a fake `docker` the only one on PATH so docker anomalies can be produced without
 * breaking the real one. The fake drains stdin, records its arguments (returned path), then runs `body`.
 */
function fakeDocker(body: string): string {
  fakeDockerDir = mkdtempSync(join(tmpdir(), 'hyde-fake-docker-'))
  const file = join(fakeDockerDir, 'docker')
  writeFileSync(
    file,
    `#!/bin/sh\nwhile IFS= read -r _line; do :; done\nprintf '%s\\n' "$@" > "$0.args"\n${body}\n`,
    { mode: 0o755 },
  )
  vi.stubEnv('PATH', fakeDockerDir)
  return `${file}.args`
}

describe('integration harness', () => {
  it('D43: psql -v ON_ERROR_STOP=1 applies the generated script inside the database container', () => {
    const result = apply(db)
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  it('D43: a failing statement stops the script (exit 3, later statements do not run)', async () => {
    const result = psql(db.name, 'CREATE TABLE t1(); SELECT 1/0; CREATE TABLE t2();')
    expect(result.status).toBe(3)
    expect(result.stderr).toContain('division by zero')
    const tables = await adminQuery(
      db.name,
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('t1', 't2') ORDER BY table_name`,
    )
    expect(tables).toEqual([{ table_name: 't1' }])
  })

  it('D43: psql runs inside the database container, not on the host', () => {
    const result = psql(db.name, '\\! hostname\n')
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe(inject('pg').containerId.slice(0, 12))
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
    vi.stubEnv('PATH', '/nonexistent-hyde-db-no-docker')
    expect(() => apply(db)).toThrow(
      'integration tests need the docker CLI on PATH (psql runs inside the database container, D43): install Docker or put the docker CLI on PATH',
    )
  })

  it.each([
    ['exits 125 (docker daemon error)', 'exit 125', /could not run psql \(exit status 125\)/],
    ['exits 126 (command not invokable)', 'exit 126', /could not run psql \(exit status 126\)/],
    ['exits 127 (command not found)', 'exit 127', /could not run psql \(exit status 127\)/],
    [
      'reports an error response from the daemon',
      "echo 'Error response from daemon: No such container: gone' >&2; exit 1",
      /could not run psql: Error response from daemon: No such container: gone/,
    ],
    [
      'cannot reach the daemon',
      "echo 'Cannot connect to the Docker daemon at unix:///x.sock. Is it running?' >&2; exit 1",
      /could not run psql: Cannot connect to the Docker daemon/,
    ],
    ['is killed by a signal', 'kill -KILL $$', /could not run psql: .*signal SIGKILL/],
  ])(
    'D43: a docker anomaly throws instead of returning a result (docker %s)',
    (_name, body, message) => {
      fakeDocker(body)
      expect(() => apply(db)).toThrow(message)
    },
  )

  it('D43: a returned result means psql ran: any exit other than the docker ones is returned', () => {
    fakeDocker("echo 'psql: error: connection failed' >&2; exit 2")
    expect(apply(db)).toEqual({ status: 2, stdout: '', stderr: 'psql: error: connection failed\n' })
  })

  it('D43: dropTestDatabase drops the database and the AI role created by the apply script', async () => {
    expect(apply(db).status).toBe(0)
    const roles = `SELECT rolname FROM pg_roles WHERE rolname = '${db.role}'`
    const databases = `SELECT datname FROM pg_database WHERE datname = '${db.name}'`
    expect(await adminQuery('postgres', roles)).toHaveLength(1)
    await dropTestDatabase(db)
    expect(await adminQuery('postgres', roles)).toEqual([])
    expect(await adminQuery('postgres', databases)).toEqual([])
  })

  it('D43: a failed database setup reports the exit status and leaves no database behind', async () => {
    const argsFile = fakeDocker("echo 'boom' >&2; exit 3")
    await expect(createTestDatabase()).rejects.toThrow(
      /test database setup failed \(psql exit status 3\): boom/,
    )
    const args = readFileSync(argsFile, 'utf8').split('\n')
    const name = args[args.indexOf('-d') + 1]
    expect(name).toMatch(/^hyde_[0-9a-f]{8}$/)
    expect(
      await adminQuery('postgres', `SELECT datname FROM pg_database WHERE datname = '${name}'`),
    ).toEqual([])
  })
})
