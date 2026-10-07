// MySQL apply checks A (D117 steps 2, 4, 5; D119; A77, A86): the default database is not the views
// database, the deployer can read the grant tables, and the reader account is reset and verified.
// Printed fixes are pasted by an administrator in the default sql_mode, so computed fixes use
// QUOTE() and backtick doubling inside the SQL, not the script's own literal rule (D99). A computed
// fix can outgrow FIX_LIMIT with long names, so each one falls back to a short literal (D142, D151).
import { BRAND } from '../brand.ts'
import { quoteMysqlIdent as qi, quoteLiteral as ql } from '../sql.ts'
import type { MysqlConfig } from '../types.ts'
import {
  ABORT_TABLE,
  abortIf,
  abortWhenFound,
  account,
  FIX_LIMIT,
  type MysqlCheck,
} from './mysql-guards.ts'

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

/** A `<QUOTE(user)>@<QUOTE(host)>` SQL expression over two grant-table columns. */
function quotedAccount(userCol: string, hostCol: string): string {
  return `CONCAT(QUOTE(${userCol}), '@', QUOTE(${hostCol}))`
}

/** A computed fix of the pre-checks: the statement when it fits FIX_LIMIT, else `prose` (D161). */
function preFix(full: string, prose: string): string {
  return fitted(full, ql(prose))
}

// The sources of the pre-checks (D117 step 6, A77, D120): SELECTs of (problem, fix, `rank`), ranks
// continuing after leftoverGrants' 1-6 so the re-check can union all of them in one stable order.
function rolesSource(config: MysqlConfig): string {
  const u = ql(config.role)
  const h = ql(config.readerHost)
  const acct = accountFix(config)
  return [
    `SELECT 'the reader has a role.' AS problem, ${preFix(`CONCAT('REVOKE ', ${quotedAccount('FROM_USER', 'FROM_HOST')}, ' FROM ', ${acct}, ';')`, 'revoke the roles granted to the reader')} AS fix, 7 AS \`rank\``,
    `  FROM mysql.role_edges WHERE TO_USER = ${u} AND TO_HOST = ${h}`,
    'UNION ALL',
    `SELECT 'the reader has a default role.', ${preFix(`CONCAT('ALTER USER ', ${acct}, ' DEFAULT ROLE NONE;')`, "set the reader's default role to NONE")}, 8`,
    `  FROM mysql.default_roles WHERE USER = ${u} AND HOST = ${h}`,
  ].join('\n')
}

function mandatoryRolesSource(): string {
  return [
    `SELECT ${ql('mandatory_roles is set; that is unsupported.')} AS problem, ${ql("SET PERSIST mandatory_roles = '';")} AS fix, 9 AS \`rank\``,
    "  FROM DUAL WHERE @@GLOBAL.mandatory_roles <> ''",
  ].join('\n')
}

function proxiesSource(config: MysqlConfig): string {
  const u = ql(config.role)
  const h = ql(config.readerHost)
  return [
    `SELECT 'the reader takes part in a proxy grant.' AS problem, ${preFix(`CONCAT('REVOKE PROXY ON ', ${quotedAccount('Proxied_user', 'Proxied_host')}, ' FROM ', ${quotedAccount('User', 'Host')}, ';')`, 'revoke the proxy grants of the reader')} AS fix, 10 AS \`rank\``,
    `  FROM mysql.proxies_priv WHERE (User = ${u} AND Host = ${h}) OR (Proxied_user = ${u} AND Proxied_host = ${h})`,
  ].join('\n')
}

function otherAccountsSource(config: MysqlConfig): string {
  const u = ql(config.role)
  const h = ql(config.readerHost)
  return [
    `SELECT 'another account could match a reader login.' AS problem, ${preFix(`CONCAT('DROP USER ', ${quotedAccount('User', 'Host')}, ';')`, 'drop the other accounts of that user name')} AS fix, 11 AS \`rank\``,
    `  FROM mysql.user WHERE (User = ${u} OR User = '') AND NOT (User = ${u} AND Host = ${h})`,
  ].join('\n')
}

const sources: readonly { id: string; source: (config: MysqlConfig) => string }[] = [
  { id: 'roles', source: rolesSource },
  { id: 'mandatory-roles', source: mandatoryRolesSource },
  { id: 'proxies', source: proxiesSource },
  { id: 'other-accounts', source: otherAccountsSource },
]

/** D117 step 6 (A77, D120): roles, mandatory_roles, proxies, other accounts; each reports its first offender. */
export const preChecks: readonly MysqlCheck[] = sources.map(({ id, source }) => ({
  id,
  render: (config) => abortWhenFound(`${source(config)}\nORDER BY \`rank\` LIMIT 1`),
}))

/**
 * D117 step 9: after the view grants, re-runs every refusal source; when one finds a row the reader's
 * grants are revoked through a prepared statement before the script aborts (D119, D155). The three
 * statements of the abort are composed here because Task 5 exports only `abortWhenFound`.
 */
export function renderRecheck(config: MysqlConfig, views: readonly string[]): string[] {
  const union = [leftoverGrants(config, views), ...sources.map((s) => s.source(config))].join(
    '\nUNION ALL\n',
  )
  const revoke = `REVOKE ALL PRIVILEGES, GRANT OPTION FROM ${account(config)} IGNORE UNKNOWN USER`
  return [
    `SET @hyde_message = (SELECT CONCAT('${BRAND}: ', LEFT(f.problem, GREATEST(0, ${FIX_LIMIT} - CHAR_LENGTH(f.fix))), ' Fix: ', f.fix) FROM (${union}\nORDER BY \`rank\` LIMIT 1) f);`,
    `SET @hyde_sql = IF(@hyde_message IS NULL, 'DO 0', ${ql(revoke)});`,
    'PREPARE hyde_stmt FROM @hyde_sql;',
    'EXECUTE hyde_stmt;',
    'DEALLOCATE PREPARE hyde_stmt;',
    'SET @hyde_refused = COALESCE(@hyde_refused, @hyde_message);',
    `INSERT INTO ${qi(ABORT_TABLE)} (${qi('problem')}) SELECT @hyde_message FROM DUAL WHERE @hyde_message IS NOT NULL;`,
  ]
}
