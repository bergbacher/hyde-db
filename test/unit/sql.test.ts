import { describe, expect, it } from 'vitest'
import {
  mysqlName,
  quoteIdent,
  quoteLiteral,
  quoteMysqlIdent,
  RESERVED_WORDS,
  sqlName,
} from '../../src/sql.ts'

describe('SQL quoting', () => {
  it('quotes identifiers and doubles embedded double quotes', () => {
    expect(quoteIdent('users')).toBe('"users"')
    expect(quoteIdent('Order Items')).toBe('"Order Items"')
    expect(quoteIdent('we"ird')).toBe('"we""ird"')
  })

  it('doubles every embedded double quote, consecutive ones included', () => {
    expect(quoteIdent('a"b"c')).toBe('"a""b""c"')
    expect(quoteIdent('""')).toBe('""""""')
    expect(quoteIdent('"')).toBe('""""')
  })

  it('quotes literals and doubles embedded single quotes', () => {
    expect(quoteLiteral('15s')).toBe("'15s'")
    expect(quoteLiteral("it's")).toBe("'it''s'")
    expect(quoteLiteral("'; DROP TABLE users; --")).toBe("'''; DROP TABLE users; --'")
  })

  it('doubles every embedded single quote, consecutive ones included', () => {
    expect(quoteLiteral("a'b'c")).toBe("'a''b''c'")
    expect(quoteLiteral("''")).toBe("''''''")
    expect(quoteLiteral("'")).toBe("''''")
  })
})

describe('names as SQL needs them (D146)', () => {
  it('D146: leaves a lower-case name that is no reserved word bare', () => {
    for (const name of [
      'users',
      'user_id',
      'created_at',
      '_draft',
      'a1',
      'name',
      'time',
      'value',
    ]) {
      expect(sqlName(name), name).toBe(name)
    }
  })

  it('A98, D146: double-quotes a name that is not all lower case, since it would fold to lower case', () => {
    expect(sqlName('Category')).toBe('"Category"')
    expect(sqlName('supportEmail')).toBe('"supportEmail"')
    expect(sqlName('USERS')).toBe('"USERS"')
    expect(sqlName('Order Items')).toBe('"Order Items"')
    expect(sqlName('1st')).toBe('"1st"')
    expect(sqlName('café')).toBe('"café"')
    expect(sqlName('price$')).toBe('"price$"')
    expect(sqlName('we"ird')).toBe('"we""ird"')
  })

  it('A98, D146: double-quotes reserved words, which fail unquoted as table or column names', () => {
    for (const word of ['user', 'order', 'group', 'select', 'table', 'join', 'left', 'verbose']) {
      expect(sqlName(word), word).toBe(`"${word}"`)
    }
  })

  it("D146: the reserved words are PostgreSQL 14 to 18's reserved and type-or-function-name keywords", () => {
    // pg_get_keywords() catcode R or T on PostgreSQL 18; PostgreSQL 14 lists the same words
    // except system_user, which PostgreSQL 16 added. Unreserved and column-name keywords such as
    // time or value work unquoted as table and column names, so they stay bare.
    expect(RESERVED_WORDS.size).toBe(101)
    expect(RESERVED_WORDS.has('system_user')).toBe(true)
    expect(RESERVED_WORDS.has('authorization')).toBe(true)
    expect(RESERVED_WORDS.has('tablesample')).toBe(true)
    expect(RESERVED_WORDS.has('time')).toBe(false)
    for (const word of RESERVED_WORDS) expect(word, word).toMatch(/^[a-z_]+$/)
  })
})

describe('D104: MySQL quoting', () => {
  it('D104: wraps in backticks and doubles embedded backticks', () => {
    expect(quoteMysqlIdent('users')).toBe('`users`')
    expect(quoteMysqlIdent('we`ird')).toBe('`we``ird`')
    expect(quoteMysqlIdent('a"b')).toBe('`a"b`')
  })
  it('D104: a MySQL literal only doubles single quotes; a backslash stays a backslash', () => {
    expect(quoteLiteral("it's \\ ok")).toBe("'it''s \\ ok'")
  })
  it('D150: mysqlName always quotes', () => {
    expect(mysqlName('order')).toBe('`order`')
    expect(mysqlName('Users')).toBe('`Users`')
  })
})
