// MySQL integration helpers: a fresh source database, views database and reader account per test
// (all server-wide names, so unique), and the `mysql` client inside the database container (D43).
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { inject } from 'vitest'
import { build } from '../../../src/index.ts'
import type { OutputFiles } from '../../../src/types.ts'
import { readRepoFile } from '../../helpers/files.ts'
import { parseSchema } from '../../helpers/prisma.ts'

export interface MysqlServer {
  readonly containerId: string
  readonly rootPassword: string
  readonly image: string
}

export interface TestDb {
  /** The source database; unique per test. */
  readonly name: string
  /** The views database (config `schema`); unique per test. */
  readonly views: string
  /** The reader account's user name (config `role`); unique per test. */
  readonly reader: string
  /** The reader account's host part (config `readerHost`, default `%`). */
  readonly host: string
  readonly files: OutputFiles
}

export interface ClientResult {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

export interface Account {
  readonly user: string
  readonly password?: string
}

/** The suite's MySQL server (from the global setup). */
export function server(): MysqlServer {
  return inject('mysql')
}

/** docker exec's own failure statuses: daemon error (125), command not invokable (126), command not found (127). */
const DOCKER_EXEC_FAILURES: ReadonlySet<number> = new Set([125, 126, 127])
const DOCKER_DAEMON_ERROR = /^(Error response from daemon|Cannot connect to the Docker daemon)/

/**
 * Runs `mysql` inside the container with `sql` on stdin. A returned ClientResult always means the
 * mysql client itself ran (a script error is a non-zero status of the client); every way in which
 * docker or the container failed throws, so an attack test cannot pass on a result that never
 * reached the database (D22, D43).
 */
function mysql(
  sql: string,
  options: { as?: Account; database?: string; force?: boolean },
): ClientResult {
  const { containerId, rootPassword } = server()
  const account = options.as ?? { user: 'root', password: rootPassword }
  const result = spawnSync(
    'docker',
    [
      'exec',
      '-i',
      '-e',
      `MYSQL_PWD=${account.password ?? ''}`,
      containerId,
      'mysql',
      `-u${account.user}`,
      ...(options.force ? ['--force'] : []),
      ...(options.database === undefined ? [] : [`-D${options.database}`]),
      '-N',
      '-B',
    ],
    { input: sql, encoding: 'utf8', timeout: 90_000 },
  )
  if (result.error) {
    if ('code' in result.error && result.error.code === 'ENOENT') {
      throw new Error(
        'integration tests need the docker CLI on PATH (mysql runs inside the database container, D43): install Docker or put the docker CLI on PATH',
        { cause: result.error },
      )
    }
    throw result.error
  }
  if (result.status === null) {
    throw new Error(
      `docker exec could not run mysql: it ended without an exit status (signal ${result.signal})`,
    )
  }
  if (DOCKER_EXEC_FAILURES.has(result.status)) {
    throw new Error(
      `docker exec could not run mysql (exit status ${result.status}): ${result.stderr.trim()}`,
    )
  }
  if (DOCKER_DAEMON_ERROR.test(result.stderr)) {
    throw new Error(`docker exec could not run mysql: ${result.stderr.trim()}`)
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** Runs a script with the `mysql` client connected to the source database, as the docs do (D43). */
export function runScript(
  db: TestDb,
  sql: string,
  options: { readonly as?: Account; readonly force?: boolean } = {},
): ClientResult {
  return mysql(sql, { as: options.as, force: options.force, database: db.name })
}

/** Runs SQL as root (or `as`) with tab-separated, header-less output (`-N -B`). */
export function query(
  sql: string,
  options: { readonly as?: Account; readonly database?: string } = {},
): ClientResult {
  return mysql(sql, options)
}

export function deploy(db: TestDb): ClientResult {
  return runScript(db, db.files['redacted-views.sql'])
}

/** MySQL variant of the tables of `example-mysql/schema.prisma`, as `prisma migrate deploy` creates them, plus one row each. */
const EXAMPLE_TABLES = `
CREATE TABLE users (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  email VARCHAR(191) NOT NULL UNIQUE,
  password_hash VARCHAR(191) NOT NULL,
  full_name VARCHAR(191) NOT NULL,
  country VARCHAR(191) NOT NULL,
  plan ENUM('FREE', 'PRO') NOT NULL
);
CREATE TABLE orders (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  total_cents INT NOT NULL,
  placed_at DATETIME(3) NOT NULL,
  shipping_address VARCHAR(191) NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id)
);
CREATE TABLE api_keys (
  id INT NOT NULL PRIMARY KEY,
  secret VARCHAR(191) NOT NULL
);
INSERT INTO users (email, password_hash, full_name, country, plan)
  VALUES ('ann@example.com', 'x', 'Ann Example', 'DE', 'PRO');
INSERT INTO orders (user_id, total_cents, placed_at, shipping_address)
  VALUES (1, 1200, '2026-10-05 12:00:00', 'Example Street 1');
INSERT INTO api_keys (id, secret) VALUES (1, 'sk_live_example');
`

export interface CreateOptions {
  /** Config overrides on top of `{ schema: views, role: reader }`. */
  readonly config?: Record<string, unknown>
  /** A Prisma schema (MySQL datasource) to build from; default `example-mysql/schema.prisma`. */
  readonly schemaSource?: string
}

export async function createTestDb(options: CreateOptions = {}): Promise<TestDb> {
  const id = randomBytes(4).toString('hex')
  const name = `app_${id}`
  const views = `v_${id}`
  const reader = `r_${id}`
  const { datamodel, config } = parseSchema(
    options.schemaSource ?? readRepoFile('example-mysql', 'schema.prisma'),
  )
  const merged: Record<string, unknown> = {
    ...config,
    schema: views,
    role: reader,
    ...options.config,
  }
  const result = build(datamodel, merged, { provider: 'mysql' })
  if (result.files === null) throw new Error(JSON.stringify(result.diagnostics, null, 2))
  const db: TestDb = {
    name,
    views,
    reader,
    host: typeof merged.readerHost === 'string' ? merged.readerHost : '%',
    files: result.files,
  }
  const created = mysql(`CREATE DATABASE \`${name}\`;`, {})
  if (created.status !== 0) {
    throw new Error(
      `test database creation failed (exit status ${created.status}): ${created.stderr}`,
    )
  }
  const setup = runScript(db, EXAMPLE_TABLES)
  if (setup.status !== 0) {
    await dropTestDb(db)
    throw new Error(`test database setup failed (exit status ${setup.status}): ${setup.stderr}`)
  }
  return db
}

/** Drops the source and views databases and the reader account (all server-wide, so they would leak across tests). */
export async function dropTestDb(db: TestDb): Promise<void> {
  const dropped = mysql(
    `DROP DATABASE IF EXISTS \`${db.name}\`; DROP DATABASE IF EXISTS \`${db.views}\`; DROP USER IF EXISTS '${db.reader}'@'${db.host}';`,
    {},
  )
  if (dropped.status !== 0) throw new Error(`test database cleanup failed: ${dropped.stderr}`)
}

/**
 * Every grant row of reader@host in the grant tables, one text line each: global (`user`,
 * `global_grants`), `db`, `tables_priv`, `columns_priv` and `procs_priv`.
 */
export function readerGrants(db: TestDb): string[] {
  const who = (user: string, host: string) => `${user} = '${db.reader}' AND ${host} = '${db.host}'`
  const sql = [
    `SELECT CONCAT('global: ', Select_priv, Insert_priv, Update_priv, Delete_priv, Create_priv, Drop_priv, Grant_priv) FROM mysql.user WHERE ${who('User', 'Host')} AND (Select_priv = 'Y' OR Insert_priv = 'Y' OR Update_priv = 'Y' OR Delete_priv = 'Y' OR Create_priv = 'Y' OR Drop_priv = 'Y' OR Grant_priv = 'Y')`,
    `SELECT CONCAT('dynamic: ', PRIV, ' ', WITH_GRANT_OPTION) FROM mysql.global_grants WHERE ${who('USER', 'HOST')}`,
    `SELECT CONCAT('db: ', Db, ' ', Select_priv) FROM mysql.db WHERE ${who('User', 'Host')}`,
    `SELECT CONCAT('table: ', Db, '.', Table_name, ' ', Table_priv) FROM mysql.tables_priv WHERE ${who('User', 'Host')}`,
    `SELECT CONCAT('column: ', Db, '.', Table_name, '.', Column_name, ' ', Column_priv) FROM mysql.columns_priv WHERE ${who('User', 'Host')}`,
    `SELECT CONCAT('routine: ', Db, '.', Routine_name, ' ', Proc_priv) FROM mysql.procs_priv WHERE ${who('User', 'Host')}`,
  ].join(' UNION ALL ')
  const result = query(`${sql};`)
  if (result.status !== 0) throw new Error(`reading the grant tables failed: ${result.stderr}`)
  return result.stdout.split('\n').filter((line) => line !== '')
}

/** Gives the reader a password and unlocks it (the documented one-time step). */
export function unlockReader(db: TestDb, password: string): void {
  const result = query(
    `ALTER USER '${db.reader}'@'${db.host}' IDENTIFIED BY '${password}' ACCOUNT UNLOCK;`,
  )
  if (result.status !== 0) throw new Error(`unlocking the reader failed: ${result.stderr}`)
}

/** Splits a script into statements at `;`, never inside `'…'`, `` `…` `` or a `--` comment (comments are dropped). */
export function splitStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let quote: string | null = null
  for (let i = 0; i < sql.length; i++) {
    const char = sql.charAt(i)
    if (quote !== null) {
      current += char
      if (char === quote) quote = null
    } else if (char === "'" || char === '`') {
      quote = char
      current += char
    } else if (char === '-' && sql.startsWith('-- ', i)) {
      const end = sql.indexOf('\n', i)
      i = end === -1 ? sql.length : end - 1
    } else if (char === ';') {
      statements.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  if (current.trim() !== '') statements.push(current.trim())
  return statements.filter((statement) => statement !== '')
}
