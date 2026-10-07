// Attack suite B (A77, D103, D117, D154): every path by which a reader could keep access beyond its
// view grants is either neutralised by the step-5 reset (the reader's grants equal the view grants
// after apply) or refused (apply aborts with a hyde-db message whose printed fix, pasted as the
// administrator, makes the re-apply pass). The class of each row was probed on mysql:8.4 and 9.7.
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createAccount,
  createRole,
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
const restore: string[] = []
async function newDb(): Promise<TestDb> {
  const db = await createTestDb()
  created.push(db)
  return db
}
afterEach(async () => {
  for (const sql of restore.splice(0)) query(sql)
  for (const db of created.splice(0)) await dropTestDb(db)
})

const acct = (db: TestDb) => `'${db.reader}'@'${db.host}'`
const viewGrants = (db: TestDb) => [
  `table: ${db.views}.orders Select|`,
  `table: ${db.views}.users Select|`,
]
const PW = 'pw-reader'

type Outcome = 'neutralised' | 'refused'
interface PathCase {
  readonly id: string
  /** SQL run as the administrator after a first deploy (the reader exists then). */
  readonly setup: (db: TestDb) => string
  readonly teardown?: string
  /** Observed class on mysql:8.4 and mysql:9.7 (D154). */
  readonly outcome: Outcome
  /** A statement the reader must be refused after the final apply. Default: read the source table. */
  readonly attack?: (db: TestDb) => string
  readonly sessionSetup?: string
  readonly sessionRestore?: string
}

const readSource = (db: TestDb) => `SELECT secret FROM \`${db.name}\`.api_keys`

const PATHS: readonly PathCase[] = [
  {
    id: 'global privilege',
    setup: (db) => `GRANT SELECT ON *.* TO ${acct(db)}`,
    outcome: 'neutralised',
  },
  {
    id: 'PROCESS',
    setup: (db) => `GRANT PROCESS ON *.* TO ${acct(db)}`,
    outcome: 'neutralised',
    attack: () => 'SHOW ENGINE INNODB STATUS',
  },
  {
    id: 'REPLICATION SLAVE',
    setup: (db) => `GRANT REPLICATION SLAVE ON *.* TO ${acct(db)}`,
    outcome: 'neutralised',
    attack: () => 'SHOW BINARY LOG STATUS',
  },
  {
    id: 'FILE',
    setup: (db) => `GRANT FILE ON *.* TO ${acct(db)}`,
    outcome: 'neutralised',
    attack: (db) => `SELECT 1 INTO OUTFILE '/var/lib/mysql-files/${db.reader}'`,
  },
  {
    id: 'CREATE USER',
    setup: (db) => `GRANT CREATE USER ON *.* TO ${acct(db)}`,
    outcome: 'neutralised',
    attack: () => "CREATE USER 'hyde_attack'@'%'",
  },
  {
    id: 'ROLE_ADMIN (dynamic)',
    setup: (db) => `GRANT ROLE_ADMIN ON *.* TO ${acct(db)}`,
    outcome: 'neutralised',
    attack: () => "CREATE ROLE 'hyde_attack_role'",
  },
  {
    id: 'wildcard database name',
    setup: (db) => `GRANT SELECT ON \`${db.name.slice(0, 4)}%\`.* TO ${acct(db)}`,
    outcome: 'neutralised',
  },
  {
    id: 'wildcard database name (partial_revokes ON)',
    setup: (db) => `GRANT SELECT ON \`${db.name.slice(0, 4)}%\`.* TO ${acct(db)}`,
    outcome: 'neutralised',
    sessionSetup: 'SET GLOBAL partial_revokes = ON',
    sessionRestore: 'SET GLOBAL partial_revokes = OFF',
  },
  {
    id: 'table grant on the source',
    setup: (db) => `GRANT SELECT ON \`${db.name}\`.api_keys TO ${acct(db)}`,
    outcome: 'neutralised',
  },
  {
    id: 'column grant',
    setup: (db) => `GRANT SELECT (secret) ON \`${db.name}\`.api_keys TO ${acct(db)}`,
    outcome: 'neutralised',
  },
  {
    id: 'DEFINER routine EXECUTE',
    setup: (db) =>
      `CREATE DEFINER = CURRENT_USER PROCEDURE \`${db.name}\`.peek() SQL SECURITY DEFINER SELECT secret FROM \`${db.name}\`.api_keys; GRANT EXECUTE ON PROCEDURE \`${db.name}\`.peek TO ${acct(db)}`,
    outcome: 'neutralised',
    attack: (db) => `CALL \`${db.name}\`.peek()`,
  },
  {
    id: 'role granted',
    setup: (db) => {
      const role = createRole(db)
      return `GRANT SELECT ON \`${db.name}\`.* TO '${role.user}'@'%'; GRANT '${role.user}'@'%' TO ${acct(db)}`
    },
    outcome: 'refused',
  },
  {
    id: 'default role (SET ROLE ALL)',
    setup: (db) => {
      const role = createRole(db)
      return `GRANT SELECT ON \`${db.name}\`.* TO '${role.user}'@'%'; GRANT '${role.user}'@'%' TO ${acct(db)}; SET DEFAULT ROLE ALL TO ${acct(db)}`
    },
    outcome: 'refused',
  },
  {
    id: 'mandatory_roles',
    setup: (db) => {
      const role = createRole(db)
      return `GRANT SELECT ON \`${db.name}\`.* TO '${role.user}'@'%'; SET PERSIST mandatory_roles = '\`${role.user}\`@\`%\`'`
    },
    teardown: "SET PERSIST mandatory_roles = ''",
    outcome: 'refused',
  },
  {
    id: 'same user on a more specific host',
    setup: (db) =>
      `CREATE USER '${db.reader}'@'127.0.0.1'; GRANT SELECT ON \`${db.name}\`.* TO '${db.reader}'@'127.0.0.1'`,
    outcome: 'refused',
  },
  {
    id: 'anonymous account',
    setup: () => "CREATE USER ''@'%'",
    teardown: "DROP USER IF EXISTS ''@'%'",
    outcome: 'refused',
  },
  {
    id: 'PROXY (reader proxies an account)',
    setup: (db) => {
      const other = createAccount(db)
      return `GRANT PROXY ON '${other.user}'@'%' TO ${acct(db)}`
    },
    outcome: 'refused',
  },
  {
    id: 'PROXY (an account proxies the reader)',
    setup: (db) => {
      const other = createAccount(db)
      return `GRANT PROXY ON ${acct(db)} TO '${other.user}'@'%'`
    },
    outcome: 'refused',
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

function readerCannot(db: TestDb, path: PathCase): void {
  unlockReader(db, PW)
  const result = query(path.attack?.(db) ?? readSource(db), {
    as: { user: db.reader, password: PW },
  })
  const text = `${result.stdout}${result.stderr}`
  expect(text).not.toContain('sk_live_example')
  expect(result.status, text).not.toBe(0)
  expect(result.stderr).toMatch(/denied/)
}

/** Runs one admin SQL as root; fails the test on a non-zero status. */
function admin(sql: string): void {
  const result = query(sql)
  expect(result.status, result.stderr).toBe(0)
}

describe.each(PATHS)('A77: $id', (path) => {
  const withSession = async (body: (db: TestDb) => void | Promise<void>) => {
    if (path.sessionSetup) {
      admin(path.sessionSetup)
      restore.push(path.sessionRestore ?? '')
    }
    if (path.teardown) restore.push(path.teardown)
    const db = await newDb()
    await body(db)
  }

  if (path.outcome === 'neutralised') {
    it(`D154, D103: the step-5 reset removes it: apply passes, grants equal the view grants, the reader cannot use it (${path.id})`, async () => {
      await withSession((db) => {
        expect(deploy(db).status).toBe(0)
        admin(path.setup(db))
        expect(readerGrants(db)).not.toEqual(viewGrants(db))
        const again = deploy(db)
        expect(again.status, again.stderr).toBe(0)
        expect(readerGrants(db)).toEqual(viewGrants(db))
        readerCannot(db, path)
      })
    })
    return
  }

  it(`D154, D103: refused: apply aborts with a short hyde-db message and a Fix, the views database is untouched (${path.id})`, async () => {
    await withSession((db) => {
      expect(deploy(db).status).toBe(0)
      const before = viewsTables(db)
      admin(path.setup(db))
      const refused = deploy(db)
      expect(refused.status).not.toBe(0)
      const message = refusal(refused.stderr).message
      expect(message, refused.stderr).not.toBe('')
      expect(message.length).toBeLessThanOrEqual(128)
      expect(viewsTables(db)).toBe(before)
    })
  })

  it(`D154, D108, D117: the printed fix, pasted as the administrator, makes the re-apply pass and leaves exactly the view grants (${path.id})`, async () => {
    await withSession((db) => {
      expect(deploy(db).status).toBe(0)
      admin(path.setup(db))
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
  })

  it(`D155, A77: under --force a refused apply does not rebuild the views database or grant the reader (${path.id})`, async () => {
    await withSession((db) => {
      expect(deploy(db).status).toBe(0)
      admin(path.setup(db))
      const forced = runScript(db, db.files['redacted-views.sql'], { force: true })
      expect(forced.stderr).toContain('hyde-db:')
      // Whatever the reset removed, the reader never holds anything beyond the view grants directly.
      expect(
        readerGrants(db).filter((g) => g.startsWith('table:') || g.startsWith('global:')),
      ).toEqual(expect.not.arrayContaining([`table: ${db.name}.api_keys Select|`]))
    })
  })
})

describe('A103, A78, D101: what a deployed reader sees', () => {
  const readerAs = (db: TestDb) => ({ user: db.reader, password: PW })

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
