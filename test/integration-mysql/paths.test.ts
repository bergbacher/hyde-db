// Attack suite B (A77, D103, D117, D154): every path by which a reader could keep access beyond its
// view grants is either neutralised by the step-5 reset (the reader's grants equal the view grants
// after apply) or refused (apply aborts with a hyde-db message whose printed fix, pasted as the
// administrator, makes the re-apply pass). The class of each row was probed on mysql:8.4 and 9.7.
import { spawn, spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createAccount,
  createTestDb,
  deploy,
  dropTestDb,
  query,
  readerGrants,
  runScript,
  server,
  splitStatements,
  type TestDb,
  unlockReader,
} from './helpers/db.ts'

const created: TestDb[] = []
/** Undo steps (an administrator statement, or a function), registered before the state they undo is created. */
type Cleanup = string | (() => void)
const restore: Cleanup[] = []
async function newDb(): Promise<TestDb> {
  const db = await createTestDb()
  created.push(db)
  return db
}
// Files run one at a time (vitest `fileParallelism: false` for the integration-mysql project), and
// the tests of this file run in order, so server-wide state (mandatory_roles, partial_revokes,
// anonymous accounts) never overlaps another test.
afterEach(async () => {
  const failures: string[] = []
  try {
    for (const step of restore.splice(0).reverse()) {
      try {
        if (typeof step === 'function') step()
        else {
          const result = query(step)
          if (result.status !== 0) failures.push(`${step}: ${result.stderr}`)
        }
      } catch (error) {
        failures.push(String(error))
      }
    }
  } finally {
    for (const db of created.splice(0)) {
      try {
        await dropTestDb(db)
      } catch (error) {
        failures.push(String(error))
      }
    }
  }
  if (failures.length > 0) throw new Error(`restoring server state failed: ${failures.join('; ')}`)
})

const acct = (db: TestDb) => `'${db.reader}'@'${db.host}'`
const viewGrants = (db: TestDb) => [
  `table: ${db.views}.orders Select|`,
  `table: ${db.views}.users Select|`,
]
const PW = 'pw-reader'
const asReader = (db: TestDb) => ({ user: db.reader, password: PW })
const roleOf = (db: TestDb) => `x_${db.reader}`
const OUT_DIR = '/var/lib/mysql-files/'

type Outcome = 'neutralised' | 'refused'
interface PathCase {
  readonly id: string
  /** Observed class on mysql:8.4 and mysql:9.7 (D154). */
  readonly outcome: Outcome
  /** Administrator SQL that sets the path up after a first deploy (the reader exists then). */
  readonly setup: (db: TestDb) => string
  /** Undo steps, registered before `setup` runs. */
  readonly cleanup?: (db: TestDb) => Cleanup[]
  /** Server-wide setting changed before the test and restored after it. */
  readonly server?: { readonly set: string; readonly unset: string }
  /** Positive control: a reader statement that must succeed while the path is open (default: `attack`). */
  readonly control?: (db: TestDb) => string
  /** The path grants nothing on this server setting (the control is refused, so the row only proves the reset is harmless). */
  readonly inert?: boolean
  /** Run before the control (a precondition of the control). */
  readonly pre?: (db: TestDb) => void
  /** Administrator undo of what the control did. */
  readonly afterControl?: (db: TestDb) => Cleanup[]
  /** A reader statement that must be refused once the path is closed (default: read the source). */
  readonly attack?: (db: TestDb) => string
  /** The refusal the attack must end in. */
  readonly denied?: RegExp
  /** Refused rows: what the printed message must name. */
  readonly mentions?: (db: TestDb) => string[]
  /** Refused rows: the path still gives the reader access after a refused (not fixed) apply. */
  readonly staysOpen?: boolean
}

const readSource = (db: TestDb) => `SELECT secret FROM \`${db.name}\`.api_keys`
const readViaRoles = (db: TestDb) => `SET ROLE ALL; ${readSource(db)}`
const SELECT_DENIED = /SELECT command denied to user/

/** Tracks and creates the role of a row, holding SELECT on the source database. */
function createSourceRole(db: TestDb): string {
  db.extras.push({ user: roleOf(db), host: '%' })
  return `CREATE ROLE '${roleOf(db)}'@'%'; GRANT SELECT ON \`${db.name}\`.* TO '${roleOf(db)}'@'%';`
}
const removeOutfile = (db: TestDb) => () => {
  spawnSync('docker', ['exec', server().containerId, 'rm', '-f', `${OUT_DIR}${db.reader}.out`])
}
const outfile = (db: TestDb) => `SELECT 1 INTO OUTFILE '${OUT_DIR}${db.reader}.out'`
const attackUser = (db: TestDb) => `hyde_attack_${db.reader}`

const PATHS: readonly PathCase[] = [
  {
    id: 'global privilege',
    outcome: 'neutralised',
    setup: (db) => `GRANT SELECT ON *.* TO ${acct(db)}`,
    attack: readSource,
    control: readSource,
    denied: SELECT_DENIED,
  },
  {
    id: 'PROCESS',
    outcome: 'neutralised',
    setup: (db) => `GRANT PROCESS ON *.* TO ${acct(db)}`,
    attack: () => 'SHOW ENGINE INNODB STATUS',
    denied: /Access denied; you need .*PROCESS/,
  },
  {
    id: 'REPLICATION SLAVE',
    outcome: 'neutralised',
    setup: (db) => `GRANT REPLICATION SLAVE ON *.* TO ${acct(db)}`,
    attack: () => 'SHOW REPLICAS',
    denied: /Access denied; you need .*REPLICATION SLAVE/,
  },
  {
    id: 'FILE',
    outcome: 'neutralised',
    setup: (db) => `GRANT FILE ON *.* TO ${acct(db)}`,
    pre: () => {
      const dir = query('SELECT @@secure_file_priv').stdout.trim()
      expect(dir).toBe(OUT_DIR)
    },
    attack: outfile,
    afterControl: (db) => [removeOutfile(db)],
    cleanup: (db) => [removeOutfile(db)],
    denied: /Access denied; you need .*FILE/,
  },
  {
    id: 'CREATE USER',
    outcome: 'neutralised',
    setup: (db) => `GRANT CREATE USER ON *.* TO ${acct(db)}`,
    attack: (db) => `CREATE USER '${attackUser(db)}'@'%'`,
    afterControl: (db) => [`DROP USER IF EXISTS '${attackUser(db)}'@'%'`],
    cleanup: (db) => [`DROP USER IF EXISTS '${attackUser(db)}'@'%'`],
    denied: /Access denied; you need .*CREATE USER/,
  },
  {
    id: 'ROLE_ADMIN (dynamic)',
    outcome: 'neutralised',
    setup: (db) => `${createSourceRole(db)} GRANT ROLE_ADMIN ON *.* TO ${acct(db)}`,
    attack: (db) => `GRANT '${roleOf(db)}'@'%' TO ${acct(db)}`,
    afterControl: (db) => [`REVOKE '${roleOf(db)}'@'%' FROM ${acct(db)}`],
    denied: /Access denied; you need .*(ROLE_ADMIN|SUPER)/,
  },
  {
    id: 'wildcard database name',
    outcome: 'neutralised',
    setup: (db) => `GRANT SELECT ON \`${db.name.slice(0, 4)}%\`.* TO ${acct(db)}`,
    control: readSource,
    denied: SELECT_DENIED,
  },
  {
    id: 'wildcard database name (escaped underscore)',
    outcome: 'neutralised',
    setup: (db) => `GRANT SELECT ON \`${db.name.slice(0, 3)}\\_%\`.* TO ${acct(db)}`,
    control: readSource,
    denied: SELECT_DENIED,
  },
  {
    id: 'wildcard database name (partial_revokes ON)',
    outcome: 'neutralised',
    server: { set: 'SET GLOBAL partial_revokes = ON', unset: 'SET GLOBAL partial_revokes = OFF' },
    // Observed: with partial_revokes ON the wildcard is taken literally, so it grants no access.
    inert: true,
    setup: (db) => `GRANT SELECT ON \`${db.name.slice(0, 4)}%\`.* TO ${acct(db)}`,
    control: readSource,
    denied: SELECT_DENIED,
  },
  {
    id: 'table grant on the source',
    outcome: 'neutralised',
    setup: (db) => `GRANT SELECT ON \`${db.name}\`.api_keys TO ${acct(db)}`,
    control: readSource,
    denied: SELECT_DENIED,
  },
  {
    id: 'column grant',
    outcome: 'neutralised',
    setup: (db) => `GRANT SELECT (secret) ON \`${db.name}\`.api_keys TO ${acct(db)}`,
    control: readSource,
    denied: SELECT_DENIED,
  },
  {
    id: 'DEFINER routine EXECUTE',
    outcome: 'neutralised',
    setup: (db) =>
      `CREATE DEFINER = CURRENT_USER PROCEDURE \`${db.name}\`.peek() SQL SECURITY DEFINER SELECT secret FROM \`${db.name}\`.api_keys; GRANT EXECUTE ON PROCEDURE \`${db.name}\`.peek TO ${acct(db)}`,
    attack: (db) => `CALL \`${db.name}\`.peek()`,
    denied: /execute command denied to user/i,
  },
  {
    id: 'role granted',
    outcome: 'refused',
    setup: (db) => `${createSourceRole(db)} GRANT '${roleOf(db)}'@'%' TO ${acct(db)}`,
    control: readViaRoles,
    attack: readViaRoles,
    denied: SELECT_DENIED,
    mentions: (db) => [roleOf(db)],
    staysOpen: true,
  },
  {
    id: 'default role (SET ROLE ALL)',
    outcome: 'refused',
    setup: (db) =>
      `${createSourceRole(db)} GRANT '${roleOf(db)}'@'%' TO ${acct(db)}; SET DEFAULT ROLE ALL TO ${acct(db)}`,
    // A default role is active at login, without SET ROLE.
    control: readSource,
    attack: readViaRoles,
    denied: SELECT_DENIED,
    mentions: (db) => [roleOf(db)],
    staysOpen: true,
  },
  {
    id: 'mandatory_roles',
    outcome: 'refused',
    server: { set: 'DO 0', unset: "SET PERSIST mandatory_roles = ''" },
    setup: (db) =>
      `${createSourceRole(db)} SET PERSIST mandatory_roles = '\`${roleOf(db)}\`@\`%\`'`,
    control: readViaRoles,
    attack: readViaRoles,
    denied: SELECT_DENIED,
    mentions: () => ['mandatory_roles'],
    staysOpen: true,
  },
  {
    id: 'same user on a more specific host that cannot match the login (127.0.0.1)',
    outcome: 'refused',
    setup: (db) => {
      db.extras.push({ user: db.reader, host: '127.0.0.1' })
      return `CREATE USER '${db.reader}'@'127.0.0.1'; GRANT SELECT ON \`${db.name}\`.* TO '${db.reader}'@'127.0.0.1'`
    },
    mentions: (db) => [db.reader, '127.0.0.1'],
  },
  {
    id: 'same user on localhost (matches the login)',
    outcome: 'refused',
    setup: (db) => {
      db.extras.push({ user: db.reader, host: 'localhost' })
      return `CREATE USER '${db.reader}'@'localhost' IDENTIFIED BY '${PW}'; GRANT SELECT ON \`${db.name}\`.* TO '${db.reader}'@'localhost'`
    },
    control: readSource,
    denied: SELECT_DENIED,
    mentions: (db) => [db.reader, 'localhost'],
    staysOpen: true,
  },
  {
    id: 'anonymous account on %',
    outcome: 'refused',
    setup: () => "CREATE USER ''@'%'",
    cleanup: () => ["DROP USER IF EXISTS ''@'%'"],
    mentions: () => ["''@'%'"],
  },
  {
    id: 'anonymous account on localhost (matches the login)',
    outcome: 'refused',
    setup: (db) =>
      `CREATE USER ''@'localhost' IDENTIFIED BY '${PW}'; GRANT SELECT ON \`${db.name}\`.* TO ''@'localhost'`,
    cleanup: () => ["DROP USER IF EXISTS ''@'localhost'"],
    control: readSource,
    denied: SELECT_DENIED,
    mentions: () => ["''@'localhost'"],
    staysOpen: true,
  },
  {
    id: 'PROXY (reader proxies an account)',
    outcome: 'refused',
    setup: (db) => {
      const other = createAccount(db)
      return `GRANT PROXY ON '${other.user}'@'%' TO ${acct(db)}`
    },
    mentions: (db) => ['PROXY', db.extras[0]?.user ?? ''],
  },
  {
    id: 'PROXY (an account proxies the reader)',
    outcome: 'refused',
    setup: (db) => {
      const other = createAccount(db)
      return `GRANT PROXY ON ${acct(db)} TO '${other.user}'@'%'`
    },
    mentions: (db) => ['PROXY', db.extras[0]?.user ?? ''],
  },
]

/** The abort message is printed inside the client's error text ("... value: '<message>' for column 'problem' ..."). */
function refusal(stderr: string): { message: string; fix: string } {
  const message = /(hyde-db: .*? Fix: .*?)' for column/s.exec(stderr)?.[1] ?? ''
  return { message, fix: /Fix: (.*)$/s.exec(message)?.[1] ?? '' }
}

function viewsTables(db: TestDb): string {
  return query(
    `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${db.views}' ORDER BY 1`,
  ).stdout
}

const attackOf = (db: TestDb, path: PathCase) => path.attack?.(db) ?? readSource(db)

/** After the path is closed: the attack is refused with the path's specific error and leaks nothing. */
function readerCannot(db: TestDb, path: PathCase): void {
  unlockReader(db, PW)
  const result = query(attackOf(db, path), { as: asReader(db) })
  const text = `${result.stdout}${result.stderr}`
  expect(text).not.toContain('sk_live_example')
  expect(result.status, text).not.toBe(0)
  expect(result.stderr).toMatch(path.denied ?? SELECT_DENIED)
}

/** Runs one administrator SQL; fails the test on a non-zero status. */
function admin(sql: string): void {
  const result = query(sql)
  expect(result.status, result.stderr).toBe(0)
}

function run(step: Cleanup): void {
  if (typeof step === 'function') step()
  else admin(step)
}

/**
 * First deploy, a sentinel table in the views database (a refusal must come before the database
 * is dropped), the path set up (its undo registered first), and the positive control: while the
 * path is open the attack works for the reader.
 */
async function armed(path: PathCase): Promise<TestDb> {
  if (path.server) {
    restore.push(path.server.unset)
    admin(path.server.set)
  }
  const db = await newDb()
  expect(deploy(db).status).toBe(0)
  admin(`CREATE TABLE \`${db.views}\`.sentinel (a INT)`)
  restore.push(...(path.cleanup?.(db) ?? []))
  path.pre?.(db)
  admin(path.setup(db))
  const control = path.control ?? path.attack
  if (control !== undefined) {
    unlockReader(db, PW)
    const statement = control?.(db) ?? attackOf(db, path)
    const opened = query(statement, { as: asReader(db) })
    if (path.inert) {
      expect(opened.status).not.toBe(0)
      expect(opened.stderr).toMatch(SELECT_DENIED)
      return db
    }
    expect(opened.status, `positive control: ${statement}: ${opened.stderr}`).toBe(0)
    if (/api_keys|peek/.test(statement)) expect(opened.stdout).toContain('sk_live_example')
    for (const step of path.afterControl?.(db) ?? []) run(step)
  }
  return db
}

describe.each(PATHS)('A77: $id', (path) => {
  if (path.outcome === 'neutralised') {
    it(`D154, D103: the step-5 reset removes it: the attack works before apply, apply passes, grants equal the view grants, the attack is then refused (${path.id})`, async () => {
      const db = await armed(path)
      const again = deploy(db)
      expect(again.status, again.stderr).toBe(0)
      expect(readerGrants(db)).toEqual(viewGrants(db))
      readerCannot(db, path)
    })
    return
  }

  it(`D154, D103: refused: apply aborts with a short hyde-db message naming the offender, before the views database is dropped (${path.id})`, async () => {
    const db = await armed(path)
    const before = viewsTables(db)
    expect(before).toContain('sentinel')
    const refused = deploy(db)
    expect(refused.status).not.toBe(0)
    const message = refusal(refused.stderr).message
    expect(message, refused.stderr).not.toBe('')
    expect(message.length).toBeLessThanOrEqual(128)
    for (const name of path.mentions?.(db) ?? []) expect(message).toContain(name)
    expect(viewsTables(db)).toBe(before)
  })

  it(`D154, D108, D117: the printed fix, pasted as the administrator, makes the re-apply pass and leaves exactly the view grants (${path.id})`, async () => {
    const db = await armed(path)
    const refused = deploy(db)
    expect(refused.status).not.toBe(0)
    const fix = refusal(refused.stderr).fix
    expect(fix, refused.stderr).not.toBe('')
    // Default sql_mode session (the helper's `query` sets none), pasted as printed.
    expect(splitStatements(fix).length).toBeGreaterThanOrEqual(1)
    admin(fix)
    const again = deploy(db)
    expect(again.status, again.stderr).toBe(0)
    expect(readerGrants(db)).toEqual(viewGrants(db))
    readerCannot(db, path)
  })

  it(`D155, A77: under --force a refused apply leaves the views database and the reader's grants as the reset left them (${path.id})`, async () => {
    const db = await armed(path)
    const tables = viewsTables(db)
    const grantsBefore = readerGrants(db)
    const forced = runScript(db, db.files['redacted-views.sql'], { force: true })
    expect(forced.stderr).toContain('hyde-db:')
    expect(viewsTables(db)).toBe(tables)
    // Nothing is granted: no view grant that the reader did not already have, and none on the source.
    const grantsAfter = readerGrants(db)
    for (const grant of grantsAfter) expect(grantsBefore).toContain(grant)
    expect(grantsAfter).toEqual(expect.not.arrayContaining(viewGrants(db)))
    // The abort is the signal: a role, mandatory role or matching account the script cannot remove
    // keeps its own access until the administrator pastes the fix (A77); every other path gives none.
    unlockReader(db, PW)
    const read = query(readViaRoles(db), { as: asReader(db) })
    expect(read.status === 0 && read.stdout.includes('sk_live_example')).toBe(
      path.staysOpen === true,
    )
  })
})

describe('A103, A78, D101: what a deployed reader sees', () => {
  const readerAs = asReader

  it('A103: the reader cannot read statement history or digests in performance_schema', async () => {
    const db = await newDb()
    expect(deploy(db).status).toBe(0)
    unlockReader(db, PW)
    for (const table of ['events_statements_history', 'events_statements_summary_by_digest']) {
      const result = query(`SELECT COUNT(*) FROM performance_schema.${table}`, { as: readerAs(db) })
      expect(result.status, table).not.toBe(0)
      expect(result.stderr, table).toMatch(/denied/)
    }
  })

  it('A103: the reader sees only its own rows in performance_schema.processlist while an admin runs a query with a secret literal', async () => {
    const db = await newDb()
    expect(deploy(db).status).toBe(0)
    unlockReader(db, PW)
    const { containerId, rootPassword } = server()
    const secret = `secret_literal_${db.name}`
    const admin = spawn(
      'docker',
      ['exec', '-i', '-e', `MYSQL_PWD=${rootPassword}`, containerId, 'mysql', '-uroot', '-N', '-B'],
      { stdio: ['pipe', 'ignore', 'ignore'] },
    )
    try {
      admin.stdin.write(`SELECT SLEEP(20), '${secret}';\n`)
      admin.stdin.end()
      let running = false
      for (let i = 0; i < 50 && !running; i++) {
        running = query(
          `SELECT COUNT(*) FROM performance_schema.processlist WHERE INFO LIKE '%${secret}%' AND INFO NOT LIKE '%processlist%'`,
        ).stdout.startsWith('1')
        if (!running) await new Promise((resolve) => setTimeout(resolve, 200))
      }
      expect(running, 'the administrator query never appeared in the processlist').toBe(true)
      const seen = query("SELECT USER, IFNULL(INFO, '') FROM performance_schema.processlist", {
        as: readerAs(db),
      })
      expect(seen.status, seen.stderr).toBe(0)
      const rows = seen.stdout.split('\n').filter((l) => l !== '')
      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) expect(row.split('\t')[0]).toBe(db.reader)
      expect(seen.stdout).not.toContain(secret)
    } finally {
      admin.kill()
      const ids = query(
        `SELECT ID FROM performance_schema.processlist WHERE INFO LIKE '%${secret}%' AND INFO NOT LIKE '%processlist%'`,
      )
        .stdout.split('\n')
        .filter((l) => /^\d+$/.test(l))
      for (const id of ids) query(`KILL ${id}`)
    }
  })

  it('A78, A103, D101: SHOW DATABASES lists only information_schema, performance_schema and the views database', async () => {
    const db = await newDb()
    expect(deploy(db).status).toBe(0)
    unlockReader(db, PW)
    const result = query('SHOW DATABASES', { as: readerAs(db) })
    expect(result.status, result.stderr).toBe(0)
    expect(
      result.stdout
        .split('\n')
        .filter((l) => l !== '')
        .sort(),
    ).toEqual(['information_schema', 'performance_schema', db.views].sort())
  })
})
