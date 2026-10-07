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

/** The fix of a check that could not run (D166): true for every check, and short enough for every id. */
const COULD_NOT_RUN_FIX = 'run without --force and read the first error'

/** What a check reports when its query fails under `mysql --force` (D166); `id` names the check. */
export function couldNotRunMessage(id: string): string {
  return `${BRAND}: check ${id} could not run. Fix: ${COULD_NOT_RUN_FIX}`
}

/**
 * Sets the abort message from `source`, a SELECT returning `problem` and `fix`: the first row's
 * message, or NULL when there is none. Shared by every check and the re-check (D99, D166).
 */
export function refusalMessage(source: string): string {
  return `SET @hyde_message = (SELECT CONCAT('${BRAND}: ', LEFT(f.problem, GREATEST(0, ${FIX_LIMIT} - CHAR_LENGTH(f.fix))), ' Fix: ', f.fix) FROM (${source}) f LIMIT 1);`
}

/** Records the message as the first refusal and aborts when there is one (D155, D99). */
export function raiseRefusal(): string[] {
  return [
    'SET @hyde_refused = COALESCE(@hyde_refused, @hyde_message);',
    `INSERT INTO ${qi(ABORT_TABLE)} (${qi('problem')}) SELECT @hyde_message FROM DUAL WHERE @hyde_message IS NOT NULL;`,
  ]
}

/**
 * `source` is a SELECT returning `problem` and `fix`; the first row, if any, aborts the script (D99).
 * The message is first set to the could-not-run refusal of check `id`, so a query that fails under
 * `--force` leaves the refusal in place (D166).
 */
export function abortWhenFound(id: string, source: string): string[] {
  return [
    `SET @hyde_message = ${ql(couldNotRunMessage(id))};`,
    refusalMessage(source),
    ...raiseRefusal(),
  ]
}

/** `abortWhenFound` for a fixed problem and fix, firing when the SQL expression `condition` is true. */
export function abortIf(id: string, condition: string, problem: string, fix: string): string[] {
  return abortWhenFound(
    id,
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

/** The refusal for a marker that names another source database; the fix is kept whole (D165, D151). */
export const SOURCE_FIX = 'set "schema" to an unused name'

/**
 * Creates the marker view (D115, D165) behind the refusal flag (D155). The statement is built when
 * the script runs because it records `DATABASE()`; that is quoted with quote doubling only, as the
 * session runs under NO_BACKSLASH_ESCAPES (D104), where `QUOTE()`'s backslash escapes would not parse.
 */
export function markerViewSql(config: Pick<MysqlConfig, 'schema'>): string[] {
  const head = `CREATE DEFINER = CURRENT_USER SQL SECURITY DEFINER VIEW ${qi(config.schema)}.${qi(MARKER_VIEW)} AS SELECT ${ql(SCHEMA_MARKER)} AS ${qi('marker')}, `
  const source = "CONCAT('''', REPLACE(DATABASE(), '''', ''''''), '''')"
  return [
    `SET @hyde_sql = IF(@hyde_refused IS NULL, CONCAT(${ql(head)}, ${source}, ${ql(` AS ${qi('source')};`)}), 'DO 0');`,
    'PREPARE hyde_stmt FROM @hyde_sql;',
    'EXECUTE hyde_stmt;',
    'DEALLOCATE PREPARE hyde_stmt;',
  ]
}

/**
 * Refuses a views database without a hyde-db marker view, or whose marker names another source
 * database (D115, D165); apply step 3 and drop step 1.
 *
 * The marker is read by selecting from the view, prepared only when `information_schema` shows the
 * view with both columns. `VIEW_DEFINITION` is empty for a deployer that is not the definer and
 * lacks SHOW VIEW (A106), which would refuse a legitimate marker; the deployer must hold SELECT on
 * the views database anyway to grant on its views. A marker that cannot be read leaves the
 * variables NULL, which is refused as a missing marker.
 */
export const markerGuard: MysqlCheck = {
  id: 'marker-guard',
  render(config) {
    const v = ql(config.schema)
    const m = ql(MARKER_VIEW)
    const read = `SELECT ${qi('marker')}, ${qi('source')} INTO @hyde_marker, @hyde_source FROM ${qi(config.schema)}.${qi(MARKER_VIEW)}`
    const columns = (name: string): string =>
      `EXISTS (SELECT 1 FROM information_schema.COLUMNS c WHERE c.TABLE_SCHEMA = ${v} AND c.TABLE_NAME = ${m} AND c.COLUMN_NAME = '${name}')`
    const notOurs = `(@hyde_marker IS NULL OR @hyde_marker <> ${ql(SCHEMA_MARKER)} OR @hyde_source IS NULL)`
    return [
      'SET @hyde_marker = NULL;',
      'SET @hyde_source = NULL;',
      `SET @hyde_sql = IF(EXISTS (SELECT 1 FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ${v} AND TABLE_NAME = ${m}) AND ${columns('marker')} AND ${columns('source')}, ${ql(read)}, 'DO 0');`,
      'PREPARE hyde_stmt FROM @hyde_sql;',
      'EXECUTE hyde_stmt;',
      'DEALLOCATE PREPARE hyde_stmt;',
      ...abortWhenFound(
        'marker-guard',
        [
          `SELECT CONCAT('database ', ${v}, ' has no ${BRAND} marker view.') AS problem,`,
          `       ${ql(MARKER_FIX)} AS fix`,
          'FROM DUAL',
          `WHERE EXISTS (SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ${v})`,
          `  AND ${notOurs}`,
          'UNION ALL',
          `SELECT CONCAT('database ', ${v}, ' belongs to source database ', @hyde_source, '.'),`,
          `       ${ql(SOURCE_FIX)}`,
          'FROM DUAL',
          `WHERE NOT ${notOurs} AND BINARY @hyde_source <> BINARY DATABASE()`,
        ].join('\n'),
      ),
    ]
  },
}

/** Drops the abort table; the last statement of a successful script. */
export function renderTeardown(): string[] {
  return [`DROP TEMPORARY TABLE IF EXISTS ${qi(ABORT_TABLE)};`]
}
