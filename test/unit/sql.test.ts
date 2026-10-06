import { describe, expect, it } from 'vitest'
import { quoteIdent, quoteLiteral } from '../../src/sql.ts'

describe('SQL quoting', () => {
  it('quotes identifiers and doubles embedded double quotes', () => {
    expect(quoteIdent('users')).toBe('"users"')
    expect(quoteIdent('Order Items')).toBe('"Order Items"')
    expect(quoteIdent('we"ird')).toBe('"we""ird"')
  })

  it('quotes literals and doubles embedded single quotes', () => {
    expect(quoteLiteral('15s')).toBe("'15s'")
    expect(quoteLiteral("it's")).toBe("'it''s'")
    expect(quoteLiteral("'; DROP TABLE users; --")).toBe("'''; DROP TABLE users; --'")
  })
})
