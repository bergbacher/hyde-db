import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
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
async function newDb(options?: Parameters<typeof createTestDb>[0]): Promise<TestDb> {
  const db = await createTestDb(options)
  created.push(db)
  return db
}
afterEach(async () => {
  for (const db of created.splice(0)) await dropTestDb(db)
})

describe('MySQL integration harness', () => {
  it('D22: a MySQL server of the requested image answers', () => {
    expect(query('SELECT @@version').stdout).toMatch(new RegExp(`^${server().image.split(':')[1]}`))
  })

  it('D43: the generated apply script runs under the mysql client inside the container', async () => {
    const db = await newDb()
    expect(deploy(db).status).toBe(0)
    expect(readerGrants(db).length).toBeGreaterThan(0)
  })

  it('D43: unique names per test, and the example tables are loaded in the source database', async () => {
    const a = await newDb()
    const b = await newDb()
    expect(new Set([a.name, b.name, a.views, b.views, a.reader, b.reader]).size).toBe(6)
    expect(query('SELECT country FROM users', { database: a.name }).stdout.trim()).toBe('DE')
  })

  it('D43: a failing statement under --force does not stop the script, and without it does', async () => {
    const db = await newDb()
    const stopped = runScript(db, 'SELECT nope; SELECT 22;')
    expect(stopped.status).not.toBe(0)
    expect(stopped.stdout).not.toContain('22')
    const forced = runScript(db, 'SELECT nope; SELECT 22;', { force: true })
    expect(forced.stderr).toContain('ERROR')
    expect(forced.stdout).toContain('22')
  })

  it('D43: an account other than root runs a script with its own credentials', async () => {
    const db = await newDb()
    expect(deploy(db).status).toBe(0)
    unlockReader(db, 'pw-reader')
    const result = query('SELECT CURRENT_USER()', {
      as: { user: db.reader, password: 'pw-reader' },
      database: db.views,
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe(`${db.reader}@${db.host}`)
  })

  it('A76: splitStatements keeps a ; inside a literal and a backtick name in one statement', () => {
    expect(splitStatements("SET @a = 'x;y';\nSELECT `a;b`; -- c;\n")).toEqual([
      "SET @a = 'x;y'",
      'SELECT `a;b`',
    ])
  })

  it('A76: splitStatements keeps a doubled quote inside a literal and returns an unterminated tail', () => {
    expect(splitStatements("SELECT 'it''s;'; SELECT 1")).toEqual(["SELECT 'it''s;'", 'SELECT 1'])
  })

  it.each([
    ['exits 125 (docker daemon error)', 'exit 125', /exit status 125/],
    [
      'reports an error response from the daemon',
      "echo 'Error response from daemon: gone' >&2; exit 1",
      /Error response from daemon: gone/,
    ],
    ['is killed by a signal', 'kill -KILL $$', /signal SIGKILL/],
  ])(
    'D22: a docker anomaly throws instead of returning a result (docker %s)',
    async (_name, body, message) => {
      const db = await newDb()
      const dir = mkdtempSync(join(tmpdir(), 'hyde-fake-docker-'))
      try {
        writeFileSync(join(dir, 'docker'), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
        vi.stubEnv('PATH', dir)
        expect(() => runScript(db, 'SELECT 1')).toThrow(message)
      } finally {
        vi.unstubAllEnvs()
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  it('D22: a missing docker CLI fails loudly with an actionable message', async () => {
    const db = await newDb()
    vi.stubEnv('PATH', '/nonexistent-hyde-db-no-docker')
    try {
      expect(() => runScript(db, 'SELECT 1')).toThrow(/need the docker CLI on PATH/)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
