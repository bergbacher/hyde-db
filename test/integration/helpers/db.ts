// Integration helpers: a fresh database and a unique reader role per test, psql inside the
// database container (D43), and connections as the reader role.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { expect, inject } from 'vitest'
import { build } from '../../../src/index.ts'
import type { OutputFiles } from '../../../src/types.ts'
import { readRepoFile } from '../../helpers/files.ts'
import { parseSchema } from '../../helpers/prisma.ts'

export interface PsqlResult {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

/** A PostgreSQL server in a container: psql runs inside it as `user`; `uri` connects as that user. */
export interface Server {
  readonly containerId: string
  readonly user: string
  readonly uri: string
}

export interface TestDb {
  /** Database name; unique per test. */
  readonly name: string
  /** Reader role name; unique per test because roles are cluster-wide. */
  readonly role: string
  readonly password: string
  readonly files: OutputFiles
  /** The server the database is on; default the suite's shared one. */
  readonly server?: Server
}

/** docker exec's own failure statuses: daemon error (125), command not invokable (126), command not found (127). */
const DOCKER_EXEC_FAILURES: ReadonlySet<number> = new Set([125, 126, 127])
const DOCKER_DAEMON_ERROR = /^(Error response from daemon|Cannot connect to the Docker daemon)/
/**
 * A hyde-db abort whose fix is empty or built from a NULL, which leaves nothing to paste, or that
 * grants ALL, which a failed paste could leave behind (D108).
 */
const NO_FIX = /ERROR:\s+hyde-db: .*Fix:(?:[ \t]*$|.*<NULL>|.*GRANT ALL)/m

export interface PsqlOptions {
  /** Pass `-v ON_ERROR_STOP=1`, as the docs do. Default true; false mimics a client that runs past errors (D58). */
  readonly onErrorStop?: boolean
  /** The database container to run in; default the suite's shared one. */
  readonly server?: { readonly containerId: string; readonly user: string }
}

/**
 * Runs a script with `psql -v ON_ERROR_STOP=1 -f -` inside the database container, as the docs do.
 *
 * A returned PsqlResult always means psql itself ran: status 0 is success and status 3 is a
 * script error under ON_ERROR_STOP (psql's own 1 and 2 are returned as they are; without
 * ON_ERROR_STOP a script error still exits 0). Every way in which docker or the container,
 * not psql, failed throws, so an attack test cannot pass vacuously on a result that never
 * reached the database: a missing docker CLI (D22), a timeout, no exit status (signal),
 * exit 125/126/127, or a docker daemon error. An abort that prints no fix to paste throws too, so
 * every abort any test triggers is checked for one (D89).
 */
export function psql(database: string, script: string, options: PsqlOptions = {}): PsqlResult {
  const { containerId, user } = options.server ?? inject('pg')
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
  if (NO_FIX.test(result.stderr)) {
    throw new Error(`an abort printed no fix to paste: ${result.stderr.trim()}`)
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

export function urlFor(
  database: string,
  user?: string,
  password?: string,
  server: Pick<Server, 'uri'> = inject('pg'),
): string {
  const url = new URL(server.uri)
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
  server?: Server,
): Promise<Record<string, unknown>[]> {
  const client = new pg.Client({ connectionString: urlFor(database, undefined, undefined, server) })
  await client.connect()
  try {
    return (await client.query(sql)).rows as Record<string, unknown>[]
  } finally {
    await client.end()
  }
}

/** Builds the example schema (or a variant of it) for the given reader role. */
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
  /** The server to create the database on; default the suite's shared one. */
  readonly server?: Server
}

export async function createTestDatabase(options: CreateOptions = {}): Promise<TestDb> {
  const id = randomBytes(4).toString('hex')
  const name = `hyde_${id}`
  const role = `hyde_${id}_reader`
  const { server } = options
  await adminQuery('postgres', `CREATE DATABASE ${name}`, server)
  try {
    const harden = options.hardenPublicSchema ?? true
    const setup = psql(
      name,
      `${readRepoFile('test', 'fixtures', 'sql', 'example-tables.sql')}\n${harden ? 'REVOKE CREATE ON SCHEMA public FROM PUBLIC;\n' : ''}`,
      { server },
    )
    if (setup.status !== 0) {
      throw new Error(
        `test database setup failed (psql exit status ${setup.status}): ${setup.stderr}`,
      )
    }
    return { name, role, password: `pw_${id}`, files: buildFiles(role), server }
  } catch (error) {
    // Do not leave a half-built database behind when setup fails.
    await dropDatabaseAndRole(name, role, server)
    throw error
  }
}

/** Drops the database and the reader role (roles are cluster-wide and would leak across tests). */
export async function dropTestDatabase(db: TestDb): Promise<void> {
  await dropDatabaseAndRole(db.name, db.role, db.server)
}

async function dropDatabaseAndRole(name: string, role: string, server?: Server): Promise<void> {
  await adminQuery('postgres', `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`, server)
  await adminQuery('postgres', `DROP ROLE IF EXISTS "${role}"`, server)
}

export function apply(db: TestDb, sql: string = db.files['redacted-views.sql']): PsqlResult {
  return psql(db.name, sql, { server: db.server })
}

/** Gives the reader role a password (the documented one-time step) and connects as it. */
export async function connectAsReader(db: TestDb, database: string = db.name): Promise<pg.Client> {
  await adminQuery('postgres', `ALTER ROLE "${db.role}" LOGIN PASSWORD '${db.password}'`, db.server)
  const client = new pg.Client({
    connectionString: urlFor(database, db.role, db.password, db.server),
  })
  await client.connect()
  return client
}

/** A fix of several statements as the final check prints it: one transaction (D108). */
export function inOneTransaction(statements: string): string {
  return `BEGIN; ${statements} COMMIT;`
}

/** The note after a fix that only a superuser can run (D108, D109). */
export const AS_SUPERUSER = ' -- run as a superuser'

/** The statements an aborted apply suggests after "Fix: " (D13, D24, D49, D108). */
export function suggestedFix(result: PsqlResult): string {
  const match = /Fix: (.*)$/m.exec(result.stderr)
  if (match?.[1] === undefined) throw new Error(`no fix in: ${result.stderr}`)
  return match[1]
}

/**
 * Every privilege in the ACLs the final check reads in a database, one per entry and privilege, as
 * `<object>: <grantee>=<privilege>[*]/<grantor>` (empty grantee for PUBLIC, `*` for the grant
 * option): relations, their columns, routines, schemas, the database, foreign servers, large
 * objects and, from PostgreSQL 15 on, configuration parameters, catalog objects included. A NULL
 * ACL counts as the default ACL it stands for. A parameter has a row only while it has grants
 * beyond its default ACL, which gives its owner, the bootstrap superuser (OID 10), its own
 * privileges; those default entries are left out, as a missing row stands for them.
 */
export async function aclEntries(database: string, server?: Server): Promise<Set<string>> {
  // pg_parameter_acl exists from PostgreSQL 15 on.
  const parameters =
    (await serverVersion(database, server)) >= 150000
      ? "UNION ALL SELECT format('parameter %s', p.parname), p.paracl FROM pg_parameter_acl p"
      : ''
  const acls = `SELECT format('relation %s', c.oid::regclass) AS object, coalesce(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END::"char", c.relowner)) AS acl FROM pg_class c
     UNION ALL SELECT format('column %s.%I', c.oid::regclass, att.attname), att.attacl
       FROM pg_class c JOIN pg_attribute att ON att.attrelid = c.oid WHERE att.attnum > 0 AND NOT att.attisdropped
     UNION ALL SELECT format('routine %s', p.oid::regprocedure), coalesce(p.proacl, acldefault('f', p.proowner)) FROM pg_proc p
     UNION ALL SELECT format('schema %I', n.nspname), coalesce(n.nspacl, acldefault('n', n.nspowner)) FROM pg_namespace n
     UNION ALL SELECT format('database %I', d.datname), coalesce(d.datacl, acldefault('d', d.datdba))
       FROM pg_database d WHERE d.datname = current_database()
     UNION ALL SELECT format('server %I', s.srvname), coalesce(s.srvacl, acldefault('S', s.srvowner)) FROM pg_foreign_server s
     UNION ALL SELECT format('large object %s', l.oid), coalesce(l.lomacl, acldefault('L', l.lomowner)) FROM pg_largeobject_metadata l
     ${parameters}`
  const rows = await adminQuery(
    database,
    `SELECT format('%s: %s=%s%s/%s', o.object, CASE WHEN a.grantee = 0 THEN '' ELSE a.grantee::regrole::text END,
              a.privilege_type, CASE WHEN a.is_grantable THEN '*' ELSE '' END, a.grantor::regrole) AS entry
       FROM (${acls}) o CROSS JOIN LATERAL aclexplode(o.acl) a
       WHERE NOT (o.object LIKE 'parameter %' AND a.grantee = 10 AND a.grantor = 10)`,
    server,
  )
  return new Set(rows.map((row) => String(row.entry)))
}

/** Schemas on which the catalog check refuses every privilege beyond the initial ones (D81). */
const CATALOG_SCHEMAS: ReadonlySet<string> = new Set([
  'pg_catalog',
  'information_schema',
  'pg_toast',
])

/**
 * The privilege types the final check refuses on an object, by its kind as `aclEntries` names it
 * (D130): every type on relations, their columns and sequences; otherwise only the ones it checks.
 */
function refusedTypes(object: string): readonly string[] | 'all' {
  const [, kind = '', name = ''] = /^(large object|\S+) (.*)$/.exec(object) ?? []
  switch (kind) {
    case 'relation':
    case 'column':
      return 'all'
    case 'database':
      return ['CREATE']
    case 'schema':
      return CATALOG_SCHEMAS.has(name) ? ['CREATE', 'USAGE'] : ['CREATE']
    case 'server':
      return ['USAGE']
    case 'routine':
      return ['EXECUTE']
    case 'large object':
      return ['SELECT', 'UPDATE']
    case 'parameter':
      return ['SET', 'ALTER SYSTEM']
    default:
      throw new Error(`no refused privilege types for ${object}`)
  }
}

/**
 * Whether a fix may remove an ACL entry (`<object>: grantee=privilege[*]/grantor`): one of the
 * privilege types the final check refuses on that object, granted to PUBLIC or `role`, or passed
 * on by `role` (D130, D135).
 */
function refused(entry: string, role: string): boolean {
  const split = entry.indexOf(': ')
  const [, grantee, privilege = '', grantor] =
    /^(.*)=([A-Z ]+)\*?\/(.*)$/.exec(entry.slice(split + 2)) ?? []
  const types = refusedTypes(entry.slice(0, split))
  if (types !== 'all' && !types.includes(privilege)) return false
  return grantee === '' || grantee === role || grantor === role
}

export interface PasteOptions {
  /** Entries the fix may also remove: orphaned pass-ons (D125), as `aclEntries` writes them. */
  readonly orphans?: readonly string[]
  /** Skip the ACL comparison, for fixes that change ownership rather than revoke (REASSIGN OWNED). */
  readonly ownership?: boolean
  /** The role that pastes the fix, after `SET ROLE`; default the suite's superuser. */
  readonly role?: string
}

/**
 * Pastes the fix an aborted apply printed, verbatim, and returns psql's result; the paste must
 * succeed. The fix may remove only the refused ACL entries: those that let the reader or PUBLIC
 * in, the grants the reader made itself, and the given orphans; every other entry stays exactly as
 * it was (D135).
 */
export async function pasteFix(
  db: TestDb,
  failed: PsqlResult,
  options: PasteOptions = {},
): Promise<PsqlResult> {
  const before = await aclEntries(db.name, db.server)
  const fix = suggestedFix(failed)
  const pasted = psql(db.name, options.role ? `SET ROLE "${options.role}";\n${fix}` : fix, {
    server: db.server,
  })
  expect(pasted.status, pasted.stderr).toBe(0)
  if (!options.ownership) {
    const after = await aclEntries(db.name, db.server)
    const removed = [...before].filter((entry) => !after.has(entry))
    const added = [...after].filter((entry) => !before.has(entry))
    expect(added, 'the fix added ACL entries').toEqual([])
    const orphans = new Set(options.orphans)
    expect(
      removed.filter((entry) => !refused(entry, db.role) && !orphans.has(entry)),
      'the fix removed ACL entries other than the refused ones',
    ).toEqual([])
  }
  return pasted
}

export interface ReapplyOptions extends PasteOptions {
  /** The script to apply again, such as the apply script after `SET ROLE <deployer>`; default the apply script. */
  readonly script?: string
}

/** `pasteFix`, then applies again; the apply must pass. */
export async function pasteFixAndReapply(
  db: TestDb,
  failed: PsqlResult,
  options: ReapplyOptions = {},
): Promise<void> {
  await pasteFix(db, failed, options)
  const reapplied = apply(db, options.script)
  expect(reapplied.status, reapplied.stderr).toBe(0)
}

/** The server's `server_version_num`, e.g. 140024 or 180006. */
export async function serverVersion(database: string, server?: Server): Promise<number> {
  const [row] = await adminQuery(
    database,
    "SELECT current_setting('server_version_num') AS v",
    server,
  )
  return Number(row?.v)
}
