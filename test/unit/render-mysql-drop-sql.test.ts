import { describe, expect, it } from 'vitest'
import { renderMysqlDropSql } from '../../src/render/mysql-drop-sql.ts'

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
    expect(sql).toContain('@hyde_refused IS NULL')
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
})
