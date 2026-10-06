// SQL quoting shared by the renderers.

/** Quotes an identifier: wraps it in double quotes and doubles embedded double quotes. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/** Quotes a string literal: wraps it in single quotes and doubles embedded single quotes. */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
