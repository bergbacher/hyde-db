// The pieces both MySQL scripts share: the session prelude, the abort mechanism, gated statements
// and the marker guard (D99, D104, D115, D117). MySQL has no portable way to stop a script, so an
// abort is a failing insert of the message into a temporary INT column under strict mode (D99);
// the server error then carries the message. Messages are `hyde-db: <problem> Fix: <fix>` within
// MESSAGE_LIMIT characters; the fix is kept whole and the problem is cut to fit (D151).
import { BRAND, SCHEMA_MARKER } from '../brand.ts'
import { quoteMysqlIdent as qi, quoteLiteral as ql } from '../sql.ts'
import type { MysqlConfig } from '../types.ts'

export const ABORT_TABLE = 'hyde_db_abort'
export const MARKER_VIEW = 'hyde_db_marker'
export const MESSAGE_LIMIT = 128
/**
 * The longest fix that keeps a message within MESSAGE_LIMIT with at least an empty problem (113).
 * Callers' fixes must fit it; fixes can embed config values, so this never throws (D142) and the
 * runtime cut in `abortWhenFound` is the backstop. Later tasks test it with max-length names.
 */
export const FIX_LIMIT: number = MESSAGE_LIMIT - `${BRAND}: `.length - ' Fix: '.length

/** Reported before the abort table exists when the connection selected no database (D160, D151). */
export const NO_DATABASE_MESSAGE: string = `${BRAND}: no default database; the connection must select the source database. Fix: add the database name to the connection URL`

/** A check that renders the statements of one refusal for a MySQL config. */
export interface MysqlCheck {
  readonly id: string
  render(config: MysqlConfig): string[]
}

/** The reader account as `'user'@'host'`, both parts literal-quoted. */
export function account(config: Pick<MysqlConfig, 'role' | 'readerHost'>): string {
  return `${ql(config.role)}@${ql(config.readerHost)}`
}

/**
 * Session settings, the refusal flag, the missing-default-database report and the abort table
 * (D117 step 1, D160). The report is a failing SET of `sql_warnings` to the message, so it needs
 * no abort table; when a database is selected the SET restores the current value.
 */
export function renderPrelude(): string[] {
  return [
    "SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_BACKSLASH_ESCAPES';",
    'SET SESSION lock_wait_timeout = 60;',
    'SET @hyde_refused = NULL;',
    `SET @hyde_refused = IF(DATABASE() IS NULL, ${ql(NO_DATABASE_MESSAGE)}, @hyde_refused);`,
    "SET SESSION sql_warnings = IF(@hyde_refused IS NULL, IF(@@SESSION.sql_warnings, 'ON', 'OFF'), @hyde_refused);",
    `DROP TEMPORARY TABLE IF EXISTS ${qi(ABORT_TABLE)};`,
    `CREATE TEMPORARY TABLE ${qi(ABORT_TABLE)} (${qi('problem')} INT NOT NULL);`,
  ]
}

/** `source` is a SELECT returning `problem` and `fix`; the first row, if any, aborts the script (D99). */
export function abortWhenFound(source: string): string[] {
  return [
    `SET @hyde_message = (SELECT CONCAT('${BRAND}: ', LEFT(f.problem, GREATEST(0, ${FIX_LIMIT} - CHAR_LENGTH(f.fix))), ' Fix: ', f.fix) FROM (${source}) f LIMIT 1);`,
    'SET @hyde_refused = COALESCE(@hyde_refused, @hyde_message);',
    `INSERT INTO ${qi(ABORT_TABLE)} (${qi('problem')}) SELECT @hyde_message FROM DUAL WHERE @hyde_message IS NOT NULL;`,
  ]
}

/** `abortWhenFound` for a fixed problem and fix, firing when the SQL expression `condition` is true. */
export function abortIf(condition: string, problem: string, fix: string): string[] {
  return abortWhenFound(
    `SELECT ${ql(problem)} AS problem, ${ql(fix)} AS fix FROM DUAL WHERE ${condition}`,
  )
}

/** One statement that runs only while no check has refused, prepared from a literal (D155). */
export function gated(statement: string): string[] {
  return [
    `SET @hyde_sql = IF(@hyde_refused IS NULL, ${ql(statement)}, 'DO 0');`,
    'PREPARE hyde_stmt FROM @hyde_sql;',
    'EXECUTE hyde_stmt;',
    'DEALLOCATE PREPARE hyde_stmt;',
  ]
}

/** The marker refusal's fix; short enough that the default schema's message prints uncut (D151). */
export const MARKER_FIX: string = 'drop or rename it, or set "schema" to an unused name'

/** Refuses a views database without the marker view (D115); apply step 3 and drop step 1. */
export const markerGuard: MysqlCheck = {
  id: 'marker-guard',
  render(config) {
    const v = ql(config.schema)
    return abortWhenFound(
      [
        `SELECT CONCAT('database ', ${v}, ' has no ${BRAND} marker view.') AS problem,`,
        `       ${ql(MARKER_FIX)} AS fix`,
        'FROM DUAL',
        `WHERE EXISTS (SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ${v})`,
        '  AND NOT EXISTS (SELECT 1 FROM information_schema.VIEWS v JOIN information_schema.COLUMNS c',
        '        ON c.TABLE_SCHEMA = v.TABLE_SCHEMA AND c.TABLE_NAME = v.TABLE_NAME',
        `        WHERE v.TABLE_SCHEMA = ${v} AND v.TABLE_NAME = ${ql(MARKER_VIEW)} AND c.COLUMN_NAME = 'marker'`,
        `          AND v.VIEW_DEFINITION LIKE ${ql(`%${SCHEMA_MARKER}%`)})`,
      ].join('\n'),
    )
  },
}

/** Drops the abort table; the last statement of a successful script. */
export function renderTeardown(): string[] {
  return [`DROP TEMPORARY TABLE IF EXISTS ${qi(ABORT_TABLE)};`]
}
