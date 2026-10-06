// SQL quoting shared by the renderers.

/** Quotes an identifier: wraps it in double quotes and doubles embedded double quotes. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/** Quotes a string literal: wraps it in single quotes and doubles embedded single quotes. */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * The keywords that fail unquoted as a table or column name: `pg_get_keywords()` with catcode R
 * (reserved) or T (reserved, can be function or type) on PostgreSQL 18. PostgreSQL 14 lists the
 * same words except `system_user`, which PostgreSQL 16 added; probed on both, the other keywords
 * worked unquoted in FROM, the select list, WHERE, ORDER BY, GROUP BY and qualified names (A98).
 */
export const RESERVED_WORDS: ReadonlySet<string> = new Set(
  (
    'all analyse analyze and any array as asc asymmetric authorization binary both case cast ' +
    'check collate collation column concurrently constraint create cross current_catalog ' +
    'current_date current_role current_schema current_time current_timestamp current_user ' +
    'default deferrable desc distinct do else end except false fetch for foreign freeze from ' +
    'full grant group having ilike in initially inner intersect into is isnull join lateral ' +
    'leading left like limit localtime localtimestamp natural not notnull null offset on only or ' +
    'order outer overlaps placing primary references returning right select session_user ' +
    'similar some symmetric system_user table tablesample then to trailing true union unique ' +
    'user using variadic verbose when where window with'
  ).split(' '),
)

/**
 * A name as a reader must write it in SQL (D139): bare when it is lower-case letters, digits and
 * underscores and no reserved word, which PostgreSQL reads as written; double-quoted otherwise,
 * because PostgreSQL folds an unquoted name to lower case and refuses reserved words.
 */
export function sqlName(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) && !RESERVED_WORDS.has(name) ? name : quoteIdent(name)
}
