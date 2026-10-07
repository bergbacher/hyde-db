import { describe, expect, it } from 'vitest'
import {
  defaultDatabaseCheck,
  grantTableAccessCheck,
  leftoverGrants,
  preChecks,
  renderRecheck,
  resetReader,
} from '../../src/render/mysql-apply-checks.ts'
import { couldNotRunMessage, FIX_LIMIT, raiseRefusal } from '../../src/render/mysql-guards.ts'

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
      'mysql.user',
      'mysql.global_grants',
      'mysql.db',
      'mysql.tables_priv',
      'mysql.columns_priv',
      'mysql.procs_priv',
    ])
      expect(sql).toContain(t)
    expect(sql).toContain('ORDER BY `rank` LIMIT 1')
  })

  it('D168: the global-privilege row reads the static privileges from the mysql.user *_priv columns, never information_schema.USER_PRIVILEGES', () => {
    const sql = leftoverGrants(config, [])
    expect(sql).not.toContain('USER_PRIVILEGES')
    expect(sql).toContain("FROM mysql.user WHERE User = 'redacted_reader' AND Host = '%'")
    for (const col of [
      'Select_priv',
      'Super_priv',
      'File_priv',
      'Create_role_priv',
      'Drop_role_priv',
    ])
      expect(sql).toContain(`IF(${col} = 'Y'`)
    expect(sql).toContain("'REVOKE ', privs, ' ON *.* FROM '")
  })

  it('D168: every *_priv column of mysql.user is listed explicitly, once', () => {
    const cols = [...leftoverGrants(config, []).matchAll(/IF\((\w+_priv) = 'Y'/g)].map((m) => m[1])
    expect(cols).toHaveLength(31)
    expect(new Set(cols).size).toBe(31)
  })

  it('D168, D152, A98: expected view grants match the exact name, or the lower-cased one only when lower_case_table_names is not 0', () => {
    // Prisma's default table names are PascalCase; servers with lower_case_table_names = 1 store the grant as `user`.
    expect(leftoverGrants(config, ['User'])).toContain(
      "(Table_name IN ('User') OR (@@lower_case_table_names <> 0 AND LOWER(Table_name) IN ('user')))",
    )
  })

  it('A77: the leftover query lets only the expected Select grants on the views database through', () => {
    const sql = leftoverGrants(config, ['Users', "o'rders"])
    expect(sql).toContain("Table_name IN ('Users', 'o''rders')")
    expect(sql).toContain("LOWER(Table_name) IN ('users', 'o''rders')")
    expect(sql).toContain("Table_priv = 'Select'")
    expect(leftoverGrants(config, [])).not.toContain('Table_name IN')
  })

  it('D99: the printed fixes are written for the administrator session: QUOTE() and backtick doubling, not the script literals', () => {
    const sql = leftoverGrants(config, [])
    expect(sql).toContain('REPLACE(')
    expect(sql).toContain('QUOTE(')
  })

  it('D161, D99, D149: every leftover fix falls back per-object, then to the reader-wide revoke, then to prose that fits FIX_LIMIT', () => {
    const sql = leftoverGrants(maxConfig, ['users'])
    const wide = "CONCAT('REVOKE ALL PRIVILEGES, GRANT OPTION FROM ', CONCAT(QUOTE("
    // global (privileges and grant option), dynamic, db, tables_priv, columns_priv, procs_priv
    const chain = new RegExp(
      `> ${FIX_LIMIT}, IF\\(CHAR_LENGTH\\(CONCAT\\('REVOKE ALL PRIVILEGES, GRANT OPTION FROM `,
      'g',
    )
    expect(sql.match(chain)).toHaveLength(6)
    expect(sql.split(wide)).toHaveLength(6 * 2 + 1)
    for (const m of sql.matchAll(new RegExp(`> ${FIX_LIMIT}, '((?:[^']|'')*)'`, 'g')))
      expect((m[1] ?? '').length).toBeLessThanOrEqual(FIX_LIMIT)
    expect(sql.match(new RegExp(`> ${FIX_LIMIT}, '`, 'g'))).toHaveLength(6)
  })

  it('D161: the reader-wide revoke fits FIX_LIMIT for the default config and for near-max role plus host only up to the budget', () => {
    const wideLength = (c: { role: string; readerHost: string }): number =>
      `REVOKE ALL PRIVILEGES, GRANT OPTION FROM '${c.role}'@'${c.readerHost}';`.length
    expect(wideLength(config)).toBeLessThanOrEqual(FIX_LIMIT)
    expect(wideLength({ role: 'r'.repeat(32), readerHost: 'h'.repeat(60) })).toBeGreaterThan(
      FIX_LIMIT,
    )
    expect(wideLength({ role: 'r'.repeat(32), readerHost: 'h'.repeat(30) })).toBeLessThanOrEqual(
      FIX_LIMIT,
    )
  })

  it('D119, A86: an account holding only GRANT OPTION (USAGE with IS_GRANTABLE) is a leftover and prints REVOKE GRANT OPTION', () => {
    const sql = leftoverGrants(config, [])
    expect(sql).toContain("IF(Grant_priv = 'Y', 'GRANT OPTION', NULL)")
  })

  it('D168: the allowed-grant exclusion compares the database name exactly', () => {
    const sql = leftoverGrants(config, ['users'])
    expect(sql).toContain("Db = 'redacted' AND Table_priv = 'Select'")
    expect(sql).not.toContain('LOWER(Db)')
  })

  it('A77: the pre-checks run in the order roles, mandatory roles, proxies, other accounts', () => {
    expect(preChecks.map((c) => c.id)).toEqual([
      'roles',
      'mandatory-roles',
      'proxies',
      'other-accounts',
    ])
  })

  it('A77: roles looks at role_edges and default_roles for the account and prints REVOKE and ALTER USER fixes', () => {
    const sql = preChecks[0]?.render(config).join('\n') ?? ''
    expect(sql).toContain('mysql.role_edges')
    expect(sql).toContain('mysql.default_roles')
    expect(sql).toContain("TO_USER = 'redacted_reader' AND TO_HOST = '%'")
    expect(sql).toContain("USER = 'redacted_reader' AND HOST = '%'")
    expect(sql).toContain('QUOTE(FROM_USER)')
    expect(sql).toContain('DEFAULT ROLE NONE;')
  })

  it('D120: mandatory_roles refuses a non-empty setting and says it is unsupported', () => {
    const sql = preChecks[1]?.render(config).join('\n') ?? ''
    expect(sql).toContain("@@GLOBAL.mandatory_roles <> ''")
    expect(sql).toContain('unsupported')
    expect(sql).toContain("SET PERSIST mandatory_roles = '''';")
  })

  it('A77: proxies covers the account as holder and as proxied user', () => {
    const sql = preChecks[2]?.render(config).join('\n') ?? ''
    expect(sql).toContain('mysql.proxies_priv')
    expect(sql).toContain('Proxied_user')
    expect(sql).toContain("(User = 'redacted_reader' AND Host = '%')")
    expect(sql).toContain("(Proxied_user = 'redacted_reader' AND Proxied_host = '%')")
    expect(sql).toContain('REVOKE PROXY ON ')
  })

  it('A77: other accounts are the same user name on another host and anonymous accounts', () => {
    const sql = preChecks[3]?.render(config).join('\n') ?? ''
    expect(sql).toContain("User = ''")
    expect(sql).toContain('DROP USER')
    expect(sql).toContain("NOT (User = 'redacted_reader' AND Host = '%')")
  })

  it('A77, D161, D99, D149: every computed pre-check fix is length-guarded and its fallback prose fits FIX_LIMIT', () => {
    for (const check of preChecks) {
      const sql = check.render(maxConfig).join('\n')
      const guarded = [...sql.matchAll(new RegExp(`> ${FIX_LIMIT}, '((?:[^']|'')*)'`, 'g'))]
      if (check.id === 'mandatory-roles') {
        expect(guarded).toHaveLength(0)
        continue
      }
      expect(guarded.length).toBeGreaterThan(0)
      for (const m of guarded) expect((m[1] ?? '').length).toBeLessThanOrEqual(FIX_LIMIT)
    }
  })

  it('D117 step 9: the re-check revokes through a prepared REVOKE … IGNORE UNKNOWN USER before aborting, and allows only the view grants', () => {
    const sql = renderRecheck(config, ['users']).join('\n')
    expect(sql).toContain('PREPARE')
    expect(sql).toContain(
      "'REVOKE ALL PRIVILEGES, GRANT OPTION FROM ''redacted_reader''@''%'' IGNORE UNKNOWN USER'",
    )
    expect(sql.indexOf('PREPARE')).toBeLessThan(sql.lastIndexOf('INSERT INTO'))
    expect(sql).toContain("Table_name IN ('users')")
    for (const t of ['mysql.role_edges', 'mysql.proxies_priv', 'mandatory_roles', 'mysql.user'])
      expect(sql).toContain(t)
  })

  it('D166: the re-check starts from the could-not-run refusal, then the query, then the gated revoke, the flag and the insert', () => {
    const lines = renderRecheck(config, ['users'])
    expect(lines[0]).toBe(`SET @hyde_message = '${couldNotRunMessage('recheck')}';`)
    expect(lines[1]).toMatch(/^SET @hyde_message = \(SELECT CONCAT\(/)
    expect(lines[2]).toMatch(/^SET @hyde_sql = IF\(@hyde_message IS NULL, 'DO 0'/)
    expect(lines.slice(-2)).toEqual(raiseRefusal())
  })

  it('D166: every apply check names itself in its could-not-run refusal', () => {
    for (const c of [defaultDatabaseCheck, grantTableAccessCheck, resetReader, ...preChecks])
      expect(c.render(config)).toContain(`SET @hyde_message = '${couldNotRunMessage(c.id)}';`)
  })

  it('D155, D117: the re-check sets the sticky refusal flag from the message', () => {
    const sql = renderRecheck(config, ['users']).join('\n')
    expect(sql).toContain('SET @hyde_refused = COALESCE(@hyde_refused, @hyde_message);')
  })

  it('Review Focus 5: with no views, the re-check allows no table grant at all', () => {
    expect(renderRecheck(config, []).join('\n')).not.toContain('Table_name IN (')
  })
})
