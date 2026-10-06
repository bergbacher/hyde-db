import { describe, expect, it } from 'vitest'
import { quoteIdent, quoteLiteral } from '../../src/sql.ts'

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
