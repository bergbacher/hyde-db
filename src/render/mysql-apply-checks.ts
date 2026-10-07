// MySQL apply checks A (D117 steps 2, 4, 5; D119; A77, A86): the default database is not the views
// database, the deployer can read the grant tables, and the reader account is reset and verified.
// Printed fixes are pasted by an administrator in the default sql_mode, so computed fixes use
// QUOTE() and backtick doubling inside the SQL, not the script's own literal rule (D99). A computed
// fix can outgrow FIX_LIMIT with long names, so each one falls back to a short literal (D142, D151).
import { quoteLiteral as ql } from '../sql.ts'
import type { MysqlConfig } from '../types.ts'
import { abortIf, abortWhenFound, account, FIX_LIMIT, type MysqlCheck } from './mysql-guards.ts'

const GRANT_TABLES = [
  'user',
  'global_grants',
  'db',
  'tables_priv',
  'columns_priv',
  'procs_priv',
  'proxies_priv',
  'default_roles',
  'role_edges',
]

/** `full` (a SQL string expression) when it fits FIX_LIMIT, else `fallback` (an expression or literal). */
function fitted(full: string, fallback: string): string {
  return `IF(CHAR_LENGTH(${full}) > ${FIX_LIMIT}, ${fallback}, ${full})`
}

/**
 * A leftover-grant fix (D161): the per-object revoke, else the reader-wide revoke, else `prose`,
 * the last only when even the reader-wide revoke exceeds FIX_LIMIT.
 */
function leftoverFix(config: MysqlConfig, full: string, prose: string): string {
  const wide = `CONCAT('REVOKE ALL PRIVILEGES, GRANT OPTION FROM ', ${accountFix(config)}, ';')`
  return fitted(full, fitted(wide, ql(prose)))
}

/** The account as a SQL expression quoted for an administrator session. */
function accountFix(config: MysqlConfig): string {
  return `CONCAT(QUOTE(${ql(config.role)}), '@', QUOTE(${ql(config.readerHost)}))`
}

/** D117 step 2 (D160, D152): refuses a default database equal to the views database. */
export const defaultDatabaseCheck: MysqlCheck = {
  id: 'default-database',
  render(config) {
    const v = ql(config.schema)
    return abortIf(
      `LOWER(DATABASE()) = LOWER(${v})`,
      'the default database is the views database.',
      `connect to the source database, not ${config.schema}`,
    )
  },
}

/** D117 step 4 (A77): the deployer must see every grant table in information_schema. */
export const grantTableAccessCheck: MysqlCheck = {
  id: 'grant-table-access',
  render() {
    const deployer =
      "CONCAT(QUOTE(SUBSTRING_INDEX(CURRENT_USER(),'@',1)), '@', QUOTE(SUBSTRING_INDEX(CURRENT_USER(),'@',-1)))"
    const fix = fitted(
      `CONCAT('GRANT SELECT ON mysql.* TO ', ${deployer}, ';')`,
      ql('grant SELECT on mysql.* to the deploying user'),
    )
    return abortWhenFound(
      [
        `SELECT 'the deploying user cannot read the MySQL grant tables.' AS problem, ${fix} AS fix`,
        'FROM DUAL',
        `WHERE (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'mysql' AND TABLE_NAME IN (${GRANT_TABLES.map(ql).join(', ')})) < ${GRANT_TABLES.length}`,
      ].join('\n'),
    )
  },
}

/**
 * A SELECT of (problem, fix, `rank`) over every leftover grant of the reader (D117, D119). `allowed`
 * lists the view names whose Select grant on the views database is expected (empty before the views exist).
 */
export function leftoverGrants(config: MysqlConfig, allowed: readonly string[]): string {
  const a = account(config)
  const who = (cols: string): string =>
    `${cols.split(',')[0]} = ${ql(config.role)} AND ${cols.split(',')[1]} = ${ql(config.readerHost)}`
  const acct = accountFix(config)
  const bt = (col: string): string => `CONCAT('\`', REPLACE(${col}, '\`', '\`\`'), '\`')`
  const expected =
    allowed.length === 0
      ? ''
      : `\n    AND NOT (LOWER(Db) = LOWER(${ql(config.schema)}) AND Table_priv = 'Select' AND Table_name IN (${allowed.map(ql).join(', ')}))`
  const columnFix = `CONCAT('REVOKE ', REPLACE(Column_priv, ',', CONCAT(' (', ${bt('Column_name')}, '), ')), ' (', ${bt('Column_name')}, ') ON ', ${bt('Db')}, '.', ${bt('Table_name')}, ' FROM ', ${acct}, ';')`
  return [
    `SELECT 'the reader has a global privilege.' AS problem, ${leftoverFix(config, `CONCAT(IF(PRIVILEGE_TYPE = 'USAGE', 'REVOKE GRANT OPTION', CONCAT('REVOKE ', PRIVILEGE_TYPE)), ' ON *.* FROM ', ${acct}, ';')`, "revoke the reader's global privileges")} AS fix, 1 AS \`rank\``,
    `  FROM information_schema.USER_PRIVILEGES WHERE GRANTEE = ${ql(a)} AND (PRIVILEGE_TYPE <> 'USAGE' OR IS_GRANTABLE = 'YES')`,
    'UNION ALL',
    `SELECT 'the reader has a dynamic global privilege.', ${leftoverFix(config, `CONCAT('REVOKE ', PRIV, ' ON *.* FROM ', ${acct}, ';')`, "revoke the reader's dynamic privileges")}, 2`,
    `  FROM mysql.global_grants WHERE ${who('USER,HOST')}`,
    'UNION ALL',
    `SELECT 'the reader has a grant on a database.', ${leftoverFix(config, `CONCAT('REVOKE ALL ON ', ${bt('Db')}, '.* FROM ', ${acct}, ';')`, "revoke the reader's database grants")}, 3`,
    `  FROM mysql.db WHERE ${who('User,Host')}`,
    'UNION ALL',
    `SELECT 'the reader has an unexpected table grant.', ${leftoverFix(config, `CONCAT('REVOKE ALL ON ', ${bt('Db')}, '.', ${bt('Table_name')}, ' FROM ', ${acct}, ';')`, "revoke the reader's table grants")}, 4`,
    `  FROM mysql.tables_priv WHERE ${who('User,Host')}${expected}`,
    'UNION ALL',
    `SELECT 'the reader has a column grant.', ${leftoverFix(config, columnFix, "revoke the reader's column grants")}, 5`,
    `  FROM mysql.columns_priv WHERE ${who('User,Host')}`,
    'UNION ALL',
    `SELECT 'the reader has a routine grant.', ${leftoverFix(config, `CONCAT('REVOKE ALL ON ', Routine_type, ' ', ${bt('Db')}, '.', ${bt('Routine_name')}, ' FROM ', ${acct}, ';')`, "revoke the reader's routine grants")}, 6`,
    `  FROM mysql.procs_priv WHERE ${who('User,Host')}`,
  ].join('\n')
}

/** D117 step 5 (D119, A86): revokes everything from the reader, then aborts on any leftover grant. */
export const resetReader: MysqlCheck = {
  id: 'reset-reader',
  render(config) {
    return [
      `REVOKE ALL PRIVILEGES, GRANT OPTION FROM ${account(config)} IGNORE UNKNOWN USER;`,
      ...abortWhenFound(`${leftoverGrants(config, [])}\nORDER BY \`rank\` LIMIT 1`),
    ]
  },
}
