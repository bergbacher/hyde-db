import { describe, expect, it } from 'vitest'
import { renderMysqlDropSql } from '../../src/render/mysql-drop-sql.ts'
import { MARKER_FIX } from '../../src/render/mysql-guards.ts'

const config = {
  dialect: 'mysql',
  schema: 'redacted',
  role: 'redacted_reader',
  readerHost: '%',
  default: 'hidden',
  strict: true,
} as const

describe('renderMysqlDropSql', () => {
  it('D100, D121, D119: guard, then revoke with IGNORE UNKNOWN USER, then a gated DROP DATABASE IF EXISTS', () => {
    const sql = renderMysqlDropSql({ config })
    const guard = sql.indexOf('hyde_db_marker')
    const revoke = sql.indexOf(
      "REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'redacted_reader'@'%' IGNORE UNKNOWN USER;",
    )
    const drop = sql.indexOf('DROP DATABASE IF EXISTS `redacted`')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(revoke)
    expect(revoke).toBeLessThan(drop)
    expect(sql).toContain(
      [
        "SET @hyde_sql = IF(@hyde_refused IS NULL, 'DROP DATABASE IF EXISTS `redacted`;', 'DO 0');",
        'PREPARE hyde_stmt FROM @hyde_sql;',
        'EXECUTE hyde_stmt;',
        'DEALLOCATE PREPARE hyde_stmt;',
      ].join('\n'),
    )
    expect(sql).not.toMatch(/^DROP DATABASE/m)
  })

  it('D95, A76: starts with the pinned session settings, contains no DELIMITER, ends by dropping the abort table', () => {
    const sql = renderMysqlDropSql({ config })
    expect(sql).toMatch(/SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_BACKSLASH_ESCAPES';/)
    expect(sql).not.toMatch(/DELIMITER/)
    expect(sql.trimEnd().endsWith('DROP TEMPORARY TABLE IF EXISTS `hyde_db_abort`;')).toBe(true)
  })

  it('D104: a views database name with a backtick-free identifier is quoted with backticks', () => {
    expect(renderMysqlDropSql({ config: { ...config, schema: 'a_b' } })).toContain('`a_b`')
  })

  it('D115, D155: the marker refusal text is in the script and its abort insert precedes the revoke, which precedes the gated drop', () => {
    const sql = renderMysqlDropSql({ config })
    expect(sql).toContain('has no hyde-db marker view.')
    expect(sql).toContain(MARKER_FIX)
    const insert = sql.indexOf('INSERT INTO `hyde_db_abort`')
    const revoke = sql.indexOf('REVOKE ALL PRIVILEGES')
    const drop = sql.indexOf('SET @hyde_sql')
    expect(insert).toBeGreaterThan(-1)
    expect(insert).toBeLessThan(revoke)
    expect(revoke).toBeLessThan(drop)
  })

  it('D104: a backtick in the views database name is doubled inside the gated literal', () => {
    expect(renderMysqlDropSql({ config: { ...config, schema: 'a`b' } })).toContain(
      "'DROP DATABASE IF EXISTS `a``b`;'",
    )
  })

  it('D104, D119: a quote in the role or host is doubled in the REVOKE', () => {
    const sql = renderMysqlDropSql({ config: { ...config, role: "o'r", readerHost: "h'%" } })
    expect(sql).toContain(
      "REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'o''r'@'h''%' IGNORE UNKNOWN USER;",
    )
  })

  it('D119, D155: the REVOKE is a bare statement, not wrapped in a gated prepare', () => {
    expect(renderMysqlDropSql({ config })).toMatch(
      /^REVOKE ALL PRIVILEGES, GRANT OPTION FROM .* IGNORE UNKNOWN USER;$/m,
    )
  })
})
