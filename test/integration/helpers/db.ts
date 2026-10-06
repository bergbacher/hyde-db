// Integration helpers: a fresh database and a unique AI role per test, psql inside the
// database container (D43), and connections as the AI role.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { inject } from 'vitest'
import { build } from '../../../src/index.ts'
import type { OutputFiles } from '../../../src/types.ts'
import { readRepoFile } from '../../helpers/files.ts'
import { parseSchema } from '../../helpers/prisma.ts'

export interface PsqlResult {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

export interface TestDb {
  /** Database name; unique per test. */
  readonly name: string
  /** AI role name; unique per test because roles are cluster-wide. */
  readonly role: string
  readonly password: string
  readonly files: OutputFiles
}

/** docker exec's own failure statuses: daemon error (125), command not invokable (126), command not found (127). */
const DOCKER_EXEC_FAILURES: ReadonlySet<number> = new Set([125, 126, 127])
const DOCKER_DAEMON_ERROR = /^(Error response from daemon|Cannot connect to the Docker daemon)/

export interface PsqlOptions {
  /** Pass `-v ON_ERROR_STOP=1`, as the docs do. Default true; false mimics a client that runs past errors (D58). */
  readonly onErrorStop?: boolean
}

/**
 * Runs a script with `psql -v ON_ERROR_STOP=1 -f -` inside the database container, as the docs do.
 *
 * A returned PsqlResult always means psql itself ran: status 0 is success and status 3 is a
 * script error under ON_ERROR_STOP (psql's own 1 and 2 are returned as they are; without
 * ON_ERROR_STOP a script error still exits 0). Every way in which docker or the container,
 * not psql, failed throws, so an attack test cannot pass vacuously on a result that never
 * reached the database: a missing docker CLI (D22), a timeout, no exit status (signal),
 * exit 125/126/127, or a docker daemon error.
 */
export function psql(database: string, script: string, options: PsqlOptions = {}): PsqlResult {
  const { containerId, user } = inject('pg')
  const onErrorStop = options.onErrorStop ?? true
  const result = spawnSync(
    'docker',
    [
      'exec',
      '-i',
      containerId,
      'psql',
      '-X',
      '-q',
      '-U',
      user,
      '-d',
      database,
      ...(onErrorStop ? ['-v', 'ON_ERROR_STOP=1'] : []),
      '-f',
      '-',
    ],
    { input: script, encoding: 'utf8', timeout: 60_000 },
  )
  if (result.error) {
    // A missing docker CLI must fail loudly and say what to do, never look like a psql failure (D22).
    if ('code' in result.error && result.error.code === 'ENOENT') {
      throw new Error(
        'integration tests need the docker CLI on PATH (psql runs inside the database container, D43): install Docker or put the docker CLI on PATH',
        { cause: result.error },
      )
    }
    throw result.error
  }
  if (result.status === null) {
    throw new Error(
      `docker exec could not run psql: it ended without an exit status (signal ${result.signal})`,
    )
  }
  if (DOCKER_EXEC_FAILURES.has(result.status)) {
    throw new Error(
      `docker exec could not run psql (exit status ${result.status}): ${result.stderr.trim()}`,
    )
  }
  if (DOCKER_DAEMON_ERROR.test(result.stderr)) {
    throw new Error(`docker exec could not run psql: ${result.stderr.trim()}`)
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

export function urlFor(database: string, user?: string, password?: string): string {
  const url = new URL(inject('pg').uri)
  url.pathname = `/${database}`
  if (user !== undefined) {
    url.username = user
    url.password = password ?? ''
  }
  return url.toString()
}

/** Runs one statement as the container's superuser in the given database and returns the rows. */
export async function adminQuery(
  database: string,
  sql: string,
): Promise<Record<string, unknown>[]> {
  const client = new pg.Client({ connectionString: urlFor(database) })
  await client.connect()
  try {
    return (await client.query(sql)).rows as Record<string, unknown>[]
  } finally {
    await client.end()
  }
}

/** Builds the example schema (or a variant of it) for the given AI role. */
export function buildFiles(role: string, schemaSource?: string): OutputFiles {
  const { datamodel, config } = parseSchema(
    schemaSource ?? readRepoFile('example', 'schema.prisma'),
  )
  const result = build(datamodel, { ...config, role })
  if (result.files === null) throw new Error(JSON.stringify(result.diagnostics, null, 2))
  return result.files
}

export interface CreateOptions {
  /** Run the one-time `REVOKE CREATE ON SCHEMA public FROM PUBLIC` the docs give (needed on PostgreSQL ≤14). Default true. */
  readonly hardenPublicSchema?: boolean
}

export async function createTestDatabase(options: CreateOptions = {}): Promise<TestDb> {
  const id = randomBytes(4).toString('hex')
  const name = `hyde_${id}`
  const role = `hyde_${id}_reader`
  await adminQuery('postgres', `CREATE DATABASE ${name}`)
  try {
    const harden = options.hardenPublicSchema ?? true
    const setup = psql(
      name,
      `${readRepoFile('test', 'fixtures', 'sql', 'example-tables.sql')}\n${harden ? 'REVOKE CREATE ON SCHEMA public FROM PUBLIC;\n' : ''}`,
    )
    if (setup.status !== 0) {
      throw new Error(
        `test database setup failed (psql exit status ${setup.status}): ${setup.stderr}`,
      )
    }
    return { name, role, password: `pw_${id}`, files: buildFiles(role) }
  } catch (error) {
    // Do not leave a half-built database behind when setup fails.
    await dropDatabaseAndRole(name, role)
    throw error
  }
}

/** Drops the database and the AI role (roles are cluster-wide and would leak across tests). */
export async function dropTestDatabase(db: TestDb): Promise<void> {
  await dropDatabaseAndRole(db.name, db.role)
}

async function dropDatabaseAndRole(name: string, role: string): Promise<void> {
  await adminQuery('postgres', `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
  await adminQuery('postgres', `DROP ROLE IF EXISTS "${role}"`)
}

export function apply(db: TestDb, sql: string = db.files['ai-views.sql']): PsqlResult {
  return psql(db.name, sql)
}

/** Gives the AI role a password (the documented one-time step) and connects as it. */
export async function connectAsReader(db: TestDb, database: string = db.name): Promise<pg.Client> {
  await adminQuery('postgres', `ALTER ROLE "${db.role}" LOGIN PASSWORD '${db.password}'`)
  const client = new pg.Client({ connectionString: urlFor(database, db.role, db.password) })
  await client.connect()
  return client
}

/** The REVOKE statements an aborted apply suggests after "Fix: " (D13, D24). */
export function suggestedFix(result: PsqlResult): string {
  const match = /Fix: (.*)$/m.exec(result.stderr)
  if (match?.[1] === undefined) throw new Error(`no fix in: ${result.stderr}`)
  return match[1]
}
