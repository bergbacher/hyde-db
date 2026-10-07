import { describe, expect, it } from 'vitest'
import {
  defaultDatabaseCheck,
  grantTableAccessCheck,
  leftoverGrants,
  resetReader,
} from '../../src/render/mysql-apply-checks.ts'
import { FIX_LIMIT } from '../../src/render/mysql-guards.ts'

const config = {
  dialect: 'mysql',
  schema: 'redacted',
  role: 'redacted_reader',
  readerHost: '%',
  default: 'hidden',
  strict: true,
} as const

// D149: the longest values the config validation admits.
const maxConfig = {
  ...config,
  schema: 's'.repeat(64),
  role: 'r'.repeat(32),
  readerHost: 'h'.repeat(60),
} as const

/** Every single-quoted SQL string literal in `sql`, unescaped. */
function literals(sql: string): string[] {
  return [...sql.matchAll(/'((?:[^']|'')*)'/g)].map((m) => (m[1] ?? '').replaceAll("''", "'"))
}

describe('mysql apply checks A', () => {
  it('D117, D160, D152: the default-database check refuses the views database, compared case-insensitively, and no longer tests for a missing database', () => {
    const sql = defaultDatabaseCheck.render(config).join('\n')
    expect(sql).toContain("LOWER(DATABASE()) = LOWER('redacted')")
    expect(sql).not.toContain('IS NULL')
    expect(sql).not.toContain('CASE')
    expect(sql).toContain('the default database is the views database.')
  })

  it('D99, D149: the default-database fix fits FIX_LIMIT with a 64-character schema', () => {
    const sql = defaultDatabaseCheck.render(maxConfig).join('\n')
    const fix = literals(sql).find((l) => l.startsWith('connect to the source database'))
    expect(fix).toBe(`connect to the source database, not ${'s'.repeat(64)}`)
    expect(fix?.length).toBeLessThanOrEqual(FIX_LIMIT)
  })

  it('A77: the grant-table check requires every grant table to be visible and prints the GRANT SELECT ON mysql.* fix', () => {
    const sql = grantTableAccessCheck.render(config).join('\n')
    for (const t of [
      'user',
      'global_grants',
      'db',
      'tables_priv',
      'columns_priv',
      'procs_priv',
      'proxies_priv',
      'default_roles',
      'role_edges',
    ])
      expect(sql).toContain(`'${t}'`)
    expect(sql).toContain('< 9')
    expect(sql).toContain('GRANT SELECT ON mysql.* TO ')
    expect(sql).toContain('QUOTE(')
  })

  it('A77, D99: the computed grant-table fix falls back to a literal that fits FIX_LIMIT when the deployer name is long', () => {
    const sql = grantTableAccessCheck.render(config).join('\n')
    expect(sql).toContain(`CHAR_LENGTH(`)
    expect(sql).toContain(`> ${FIX_LIMIT}`)
    const fallback = literals(sql).find((l) => l.startsWith('grant SELECT on mysql.*'))
    expect(fallback).toBeDefined()
    expect((fallback ?? '').length).toBeLessThanOrEqual(FIX_LIMIT)
  })

  it('D119: the reset names the account and carries IGNORE UNKNOWN USER', () => {
    const sql = resetReader.render(config).join('\n')
    expect(sql).toContain(
      "REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'redacted_reader'@'%' IGNORE UNKNOWN USER;",
    )
  })

  it('D117: the verify covers static and dynamic global privileges and the db, tables_priv, columns_priv and procs_priv tables', () => {
    const sql = resetReader.render(config).join('\n')
    for (const t of [
      'information_schema.USER_PRIVILEGES',
      'mysql.global_grants',
      'mysql.db',
      'mysql.tables_priv',
      'mysql.columns_priv',
      'mysql.procs_priv',
    ])
      expect(sql).toContain(t)
    expect(sql).toContain('ORDER BY `rank` LIMIT 1')
  })

  it('D117: the global-privilege query compares GRANTEE with the whole quoted account as one string literal', () => {
    expect(leftoverGrants(config, [])).toContain("GRANTEE = '''redacted_reader''@''%'''")
  })

  it('A77: the leftover query lets only the expected Select grants on the views database through', () => {
    const sql = leftoverGrants(config, ['users', "o'rders"])
    expect(sql).toContain("Table_name IN ('users', 'o''rders')")
    expect(sql).toContain("Table_priv = 'Select'")
    expect(leftoverGrants(config, [])).not.toContain('Table_name IN')
  })

  it('D99: the printed fixes are written for the administrator session: QUOTE() and backtick doubling, not the script literals', () => {
    const sql = leftoverGrants(config, [])
    expect(sql).toContain('REPLACE(')
    expect(sql).toContain('QUOTE(')
  })

  it('D99, D149: every computed fix is guarded by FIX_LIMIT with a literal fallback that fits it, at maximum config lengths', () => {
    const sql = leftoverGrants(maxConfig, ['users'])
    const guards = sql.match(new RegExp(`> ${FIX_LIMIT}, '`, 'g')) ?? []
    // global, global_grants, db, tables_priv, columns_priv, procs_priv
    expect(guards).toHaveLength(6)
    for (const m of sql.matchAll(new RegExp(`> ${FIX_LIMIT}, '((?:[^']|'')*)'`, 'g')))
      expect((m[1] ?? '').length).toBeLessThanOrEqual(FIX_LIMIT)
  })
})
