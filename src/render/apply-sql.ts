// Renders redacted-views.sql: one transaction that recreates the views schema with column-filtered
// views, grants the reader role SELECT on exactly those views, and aborts with a pasteable fix if
// the role could reach anything else (D11, D13, D24, D49, D76, D80–D82, D91, D108, D109, D111); it
// revokes nothing itself (D69).
import { BRAND, SCHEMA_MARKER } from '../brand.ts'
import { quoteIdent as qi, quoteLiteral as ql } from '../sql.ts'
import type { ResolvedConfig, View } from '../types.ts'
import { renderSchemaGuard } from './schema-guard.ts'

export interface RenderInput {
  readonly config: ResolvedConfig
  readonly views: readonly View[]
}

/** The privilege names as a SQL list of string literals. */
function privilegeList(privileges: readonly string[]): string {
  return privileges.map((p) => `'${p}'`).join(', ')
}

/** SQL for the qualified name of relation `c` in schema `n`. */
const RELATION = "format('%I.%I', n.nspname, c.relname)"

/** SQL condition: `att` is a user column (no system or dropped one) of relation `c`. */
const USER_COLUMN = 'att.attrelid = c.oid AND att.attnum > 0 AND NOT att.attisdropped'

/** The relation's user columns as `att`, for a FROM clause. */
const COLUMNS = `pg_attribute att WHERE ${USER_COLUMN}`

/**
 * How grants on a relation or sequence `c` are revoked as their grantor: `object` is SQL for the
 * object of a table-level REVOKE, `columnPrivilege` the privilege a column-level REVOKE names (a
 * sequence's columns carry only SELECT).
 */
interface ColumnGrants {
  readonly object: string
  readonly columnPrivilege: 'ALL' | 'SELECT'
}

/**
 * SQL for the column grants of `c` that grantor `t.grantor` made to PUBLIC or the reader role `r`
 * without still holding the grant option behind them (A69), one row per column and privilege:
 * `item` for a GRANT or REVOKE, and `held` when the grantor holds that privilege from the owner.
 */
const LOST_COLUMN_GRANTS =
  "SELECT DISTINCT att.attnum, x.privilege_type, format('%s (%I)', x.privilege_type, att.attname) AS item, " +
  'EXISTS (SELECT 1 FROM aclexplode(att.attacl) h WHERE h.grantee = t.grantor AND h.grantor = c.relowner AND h.privilege_type = x.privilege_type) AS held ' +
  `FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) x WHERE ${USER_COLUMN} AND x.grantor = t.grantor AND x.grantee IN (0, r.oid) ` +
  "AND NOT has_column_privilege(t.grantor, c.oid, att.attnum, x.privilege_type || ' WITH GRANT OPTION')"

/**
 * SQL for what grantor `t.grantor` of relation or sequence `c` runs, wrapped in SET ROLE: it
 * revokes exactly the table privileges it granted to its grantees `t.grantees`, since REVOKE ALL
 * as a grantor also revokes the privileges columns carry and fails when it holds no grant option
 * for any of them (a grantor of TRIGGER, or of a sequence's USAGE, alone); then the column
 * privileges it granted, on those columns. The reader runs only the column part: CASCADE on its own
 * grant removes what it passed on in the same ACL, but not column grants it passed on from a table
 * grant (A69). A grantor whose own grant is gone is first given back exactly the grant options it
 * passed on, and they are taken away right after (A82): a privilege it held from the owner keeps
 * that privilege without the option.
 */
function columnGrantorFix(privileges: readonly string[], columns: ColumnGrants): string {
  const items = "string_agg(o.item, ', ' ORDER BY o.attnum, o.privilege_type)"
  const regrant = `(SELECT format('GRANT %s ON %s TO %s WITH GRANT OPTION; ', ${items}, ${RELATION}, t.grantor::regrole) FROM (${LOST_COLUMN_GRANTS}) o HAVING count(*) > 0)`
  const revokeBack =
    `(SELECT concat(CASE WHEN bool_or(o.held) THEN format(' REVOKE GRANT OPTION FOR %s ON %s FROM %s CASCADE;', ${items} FILTER (WHERE o.held), ${RELATION}, t.grantor::regrole) END, ` +
    `CASE WHEN bool_or(NOT o.held) THEN format(' REVOKE %s ON %s FROM %s CASCADE;', ${items} FILTER (WHERE NOT o.held), ${RELATION}, t.grantor::regrole) END) FROM (${LOST_COLUMN_GRANTS}) o)`
  const onTable =
    `CASE WHEN t.grantor <> r.oid THEN (SELECT format('REVOKE %s ON %s FROM %s CASCADE;', string_agg(DISTINCT x.privilege_type, ', ' ORDER BY x.privilege_type), ${columns.object}, t.grantees) ` +
    `FROM aclexplode(c.relacl) x WHERE x.grantor = t.grantor AND x.grantee IN (0, r.oid) AND x.privilege_type IN (${privilegeList(privileges)}) HAVING count(*) > 0) END`
  const onColumns =
    `(SELECT format('REVOKE ${columns.columnPrivilege} (%s) ON %s FROM %s CASCADE;', string_agg(quote_ident(att.attname), ', ' ORDER BY att.attnum), ${RELATION}, t.grantees) ` +
    `FROM ${COLUMNS} AND EXISTS (SELECT 1 FROM aclexplode(att.attacl) x WHERE x.grantor = t.grantor AND x.grantee IN (0, r.oid)) HAVING count(*) > 0)`
  return `format('%sSET ROLE %s; %s RESET ROLE;%s', ${regrant}, t.grantor::regrole, concat_ws(' ', ${onTable}, ${onColumns}), ${revokeBack})`
}

/**
 * SQL for the statements that take `privileges` on one object away from PUBLIC and the reader role
 * `r`, or NULL when neither holds any. `what` is SQL for the privilege-and-object part, e.g.
 * `ALL ON public.users`; `acl` holds the object's grants, for a relation or sequence `c` with
 * `columns` its column grants too.
 *
 * A superuser's REVOKE acts as the owner and leaves grants made by any other grantor in place
 * (A56), so those are revoked as their grantor; the owner's grants follow in one statement, with
 * CASCADE, which also removes what a grantee passed on in the same ACL (A54). So the reader is a
 * grantor only of column grants on a relation or sequence (A69), and its revokes come first, while
 * it still holds the grant options they need. The reader is only named when it owns the object or
 * holds a grant, so a fix still runs after a failed first apply rolled back the role's creation.
 */
function revokeFix(
  what: string,
  owner: string,
  acl: string,
  privileges: readonly string[],
  options: { readonly publicByDefault?: boolean; readonly columns?: ColumnGrants } = {},
): string {
  const held = `FROM aclexplode(${acl}) a WHERE a.privilege_type IN (${privilegeList(privileges)})`
  const grantees =
    "FROM (SELECT g.grantor, string_agg(CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(r.rolname) END, ', ' ORDER BY g.grantee) AS grantees "
  const asGrantors = options.columns
    ? `(SELECT string_agg(${columnGrantorFix(privileges, options.columns)}, ' ' ORDER BY t.grantor <> r.oid, t.grantor) ${grantees}` +
      `FROM (SELECT a.grantor, a.grantee FROM aclexplode(c.relacl) a WHERE a.privilege_type IN (${privilegeList(privileges)}) AND a.grantee IN (0, r.oid) AND a.grantor <> ${owner} AND a.grantor <> r.oid ` +
      `UNION SELECT a.grantor, a.grantee FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) a WHERE ${USER_COLUMN} AND a.grantee IN (0, r.oid) AND a.grantor <> ${owner}) g GROUP BY g.grantor) t)`
    : `(SELECT string_agg(format('SET ROLE %s; REVOKE %s FROM %s CASCADE; RESET ROLE;', t.grantor::regrole, ${what}, t.grantees), ' ' ORDER BY t.grantor) ${grantees}` +
      `FROM (SELECT DISTINCT a.grantor, a.grantee ${held} AND a.grantee IN (0, r.oid) AND a.grantor <> ${owner} AND a.grantor <> r.oid) g GROUP BY g.grantor) t)`
  // PUBLIC holds a function's EXECUTE by default while its ACL is NULL.
  const asOwner =
    `nullif(concat_ws(', ', CASE WHEN ${options.publicByDefault ? `${acl} IS NULL OR ` : ''}EXISTS (SELECT 1 ${held} AND a.grantee = 0 AND a.grantor = ${owner}) THEN 'PUBLIC' END, ` +
    `CASE WHEN r.oid = ${owner} OR EXISTS (SELECT 1 ${held} AND a.grantee = r.oid AND a.grantor = ${owner}) THEN quote_ident(r.rolname) END), '')`
  return `concat_ws(' ', ${asGrantors}, 'REVOKE ' || ${what} || ' FROM ' || ${asOwner} || ' CASCADE;')`
}

/**
 * SQL for the text an abort prints after "Fix: " from the statements in `fixes`: one transaction
 * when there are several, so a pasted fix applies completely or not at all (A82; ALTER SYSTEM
 * cannot run in one), marked to be run as a superuser when it switches roles or `superuser` says
 * so.
 */
function printedFix(fixes: string, superuser = false): string {
  const mark = superuser
    ? "' -- run as a superuser'"
    : `CASE WHEN ${fixes} LIKE '%SET ROLE %' THEN ' -- run as a superuser' END`
  return `concat(CASE WHEN ${fixes} LIKE '%; %' AND ${fixes} NOT LIKE 'ALTER SYSTEM %' THEN 'BEGIN; ' || ${fixes} || ' COMMIT;' ELSE ${fixes} END, ${mark})`
}

/** Role attributes the reader role must not have, as pg_roles columns, in the order the abort lists them (D49). */
const ATTRIBUTES: readonly (readonly [column: string, name: string])[] = [
  ['rolsuper', 'SUPERUSER'],
  ['rolcreatedb', 'CREATEDB'],
  ['rolcreaterole', 'CREATEROLE'],
  ['rolreplication', 'REPLICATION'],
  ['rolbypassrls', 'BYPASSRLS'],
]

/** SQL listing the attributes role `r` holds, each with the given prefix; '' when it holds none. */
function heldAttributes(separator: string, prefix: string): string {
  const cases = ATTRIBUTES.map(
    ([column, name]) => `CASE WHEN r.${column} THEN '${prefix}${name}' END`,
  )
  return `concat_ws('${separator}', ${cases.join(', ')})`
}

/**
 * Table privileges, any of which lets a role read rows (A51). MAINTAIN (PostgreSQL 17+) is left
 * out: it reads no rows, and earlier servers reject its name.
 */
const TABLE_PRIVILEGES: readonly string[] = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
]

/** Sequence privileges, any of which lets a role read a sequence (D13). */
const SEQUENCE_PRIVILEGES: readonly string[] = ['SELECT', 'USAGE', 'UPDATE']

/** The privileges a column grant can carry. */
const COLUMN_PRIVILEGES = 'SELECT, INSERT, UPDATE, REFERENCES'

/** The ALTER DEFAULT PRIVILEGES keyword of a pg_default_acl object type; LARGE OBJECTS exist from PostgreSQL 18. */
const DEFAULT_ACL_KIND =
  "CASE d.defaclobjtype WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES' WHEN 'f' THEN 'FUNCTIONS' " +
  "WHEN 'T' THEN 'TYPES' WHEN 'n' THEN 'SCHEMAS' WHEN 'L' THEN 'LARGE OBJECTS' END"

/**
 * Object types whose default privileges for PUBLIC let the reader in (A53, A59, A65). Large
 * objects ('L') have default privileges from PostgreSQL 18; earlier servers simply have no such rows.
 */
const PUBLIC_DEFAULT_KINDS = "('r', 'S', 'n', 'L')"

/** Schemas whose objects start with initial privileges that the reader must not exceed (D81). */
const CATALOG_SCHEMAS = "('pg_catalog', 'information_schema', 'pg_toast')"

/**
 * SQL for the privileges of PUBLIC and the reader role `r` on the catalog schemas and their
 * relations and functions beyond the initial ones (D81), one row per privilege: object, REVOKE
 * target, privilege, grantee, grantor, owner, whether it is a column privilege, whether the grantor
 * no longer holds the grant option behind it (only a column grant can outlive it, A69), and whether
 * the grantor holds that column privilege from the owner. An entry is extra
 * when the initial ACL grants that privilege neither to its grantee nor to PUBLIC. Objects without
 * a pg_init_privs row start from their default ACL; information_schema records none, and initdb
 * grants PUBLIC USAGE on it and SELECT on its views, except on the internal _pg_ views.
 */
function catalogEntries(): string[] {
  const relation = RELATION
  const routine =
    "format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))"
  const initial = (classoid: string, objoid: string, objsubid: string): string =>
    `(SELECT ip.initprivs FROM pg_init_privs ip WHERE ip.classoid = '${classoid}'::regclass AND ip.objoid = ${objoid} AND ip.objsubid = ${objsubid})`
  return [
    `    SELECT ${relation} AS object, format('TABLE %s', ${relation}) AS target,`,
    "           CASE WHEN x.col IS NULL THEN x.privilege_type ELSE format('%s (%I)', x.privilege_type, x.col) END AS privilege,",
    '           x.grantee, x.grantor, c.relowner AS owner,',
    "           x.col IS NOT NULL AS on_column, x.col IS NOT NULL AND NOT has_column_privilege(x.grantor, c.oid, x.col, x.privilege_type || ' WITH GRANT OPTION') AS lost, x.held",
    '    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN LATERAL (',
    "      SELECT NULL::name AS col, a.grantee, a.grantor, a.privilege_type, '{}'::aclitem[] AS initial, false AS held FROM aclexplode(c.relacl) a",
    `      UNION ALL SELECT att.attname, a.grantee, a.grantor, a.privilege_type, coalesce(${initial('pg_class', 'c.oid', 'att.attnum')}, '{}'),`,
    '        EXISTS (SELECT 1 FROM aclexplode(att.attacl) h WHERE h.grantee = a.grantor AND h.grantor = c.relowner AND h.privilege_type = a.privilege_type)',
    `      FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) a WHERE ${USER_COLUMN}`,
    '    ) x',
    `    WHERE n.nspname IN ${CATALOG_SCHEMAS} AND x.grantee IN (0, r.oid)`,
    `      AND NOT EXISTS (SELECT 1 FROM aclexplode(x.initial || coalesce(${initial('pg_class', 'c.oid', '0')},`,
    "            CASE WHEN n.nspname = 'information_schema' AND c.relname NOT LIKE '\\_pg\\_%' THEN acldefault('r', c.relowner) || makeaclitem(0, c.relowner, 'SELECT', false) ELSE acldefault('r', c.relowner) END)) b",
    '        WHERE b.grantee IN (x.grantee, 0) AND b.privilege_type = x.privilege_type)',
    `    UNION ALL SELECT ${routine}, format('ROUTINE %s', ${routine}), a.privilege_type, a.grantee, a.grantor, p.proowner, false, false, false`,
    '    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace CROSS JOIN LATERAL aclexplode(p.proacl) a',
    `    WHERE n.nspname IN ${CATALOG_SCHEMAS} AND a.grantee IN (0, r.oid)`,
    `      AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(${initial('pg_proc', 'p.oid', '0')}, acldefault('f', p.proowner))) b`,
    '        WHERE b.grantee IN (a.grantee, 0) AND b.privilege_type = a.privilege_type)',
    "    UNION ALL SELECT format('%I', n.nspname), format('SCHEMA %I', n.nspname), a.privilege_type, a.grantee, a.grantor, n.nspowner, false, false, false",
    '    FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a',
    `    WHERE n.nspname IN ${CATALOG_SCHEMAS} AND a.grantee IN (0, r.oid)`,
    `      AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(${initial('pg_namespace', 'n.oid', '0')},`,
    "            CASE WHEN n.nspname = 'information_schema' THEN acldefault('n', n.nspowner) || makeaclitem(0, n.nspowner, 'USAGE', false) ELSE acldefault('n', n.nspowner) END)) b",
    '        WHERE b.grantee IN (a.grantee, 0) AND b.privilege_type = a.privilege_type)',
  ]
}

/** The final safety check: every way the role could reach data outside the views aborts the script. */
function renderFinalCheck(config: ResolvedConfig): string[] {
  const role = ql(config.role)
  const abort = (message: string, ...values: string[]): string =>
    `    RAISE EXCEPTION '${BRAND}: ${message}', ${values.map((v) => (v === 'fixes' ? printedFix(v) : v)).join(', ')};`
  const routine =
    "format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))"
  const relation = RELATION
  // A relation's or sequence's grants, column grants included.
  const relationAcl = `c.relacl || ARRAY(SELECT unnest(att.attacl) FROM ${COLUMNS})`
  // The catalog privileges of one grantor to one grantee that meet `condition`, as a list.
  const privileges = (condition: string): string =>
    `string_agg(e.privilege, ', ' ORDER BY e.privilege COLLATE "C") FILTER (WHERE ${condition})`
  // Settings in pg_db_role_setting that reach the reader's sessions in this database.
  const readerSetting = (alias: string): string =>
    `${alias}.setrole IN (0, r.oid) AND ${alias}.setdatabase IN (0, (SELECT d.oid FROM pg_database d WHERE d.datname = current_database()))`
  // Where a pg_db_role_setting row applies: to all roles, the reader's role, the database, or the
  // reader's role in the database; as text for the abort and as the target of ALTER … RESET.
  const settingScope = (all: string, role: string, database: string, both: string): string =>
    `CASE WHEN s.setdatabase = 0 AND s.setrole = 0 THEN ${all} WHEN s.setdatabase = 0 THEN ${role} WHEN s.setrole = 0 THEN ${database} ELSE ${both} END`
  const inSchema = (keyword: string): string =>
    `CASE WHEN d.defaclnamespace <> 0 THEN format(' ${keyword} %I', dn.nspname) END`
  const defaultsOrder = 'ORDER BY o.rolname, dn.nspname NULLS FIRST, d.defaclobjtype'
  // PostgreSQL 16+ keeps one membership per grantor and REVOKE removes only the one it names (A54);
  // earlier servers keep one per group, which a plain REVOKE removes whatever its grantor.
  const grantedBy =
    "CASE WHEN current_setting('server_version_num')::int >= 160000 THEN format(' GRANTED BY %s', m.grantor::regrole) END"
  return [
    '-- Safety check, in this order: abort if the role',
    '--   has SUPERUSER, CREATEDB, CREATEROLE, REPLICATION or BYPASSRLS (first: a superuser passes',
    '--     every privilege test below);',
    '--   owns any object in this database other than its own temporary objects and large objects, or',
    '--     any database (an owner can grant itself access again, so no REVOKE can fix it);',
    '--   is a member of another role (inherited privileges have no grant of their own to revoke);',
    '--   can create schemas in this database;',
    '--   holds privileges on pg_catalog, information_schema or pg_toast objects beyond their initial',
    '--     ones;',
    '--   holds any privilege on a relation outside the views schema, or can use a foreign server;',
    '--   can execute a SECURITY DEFINER function or use a sequence;',
    "--   gains privileges on objects created later through other roles' default privileges (before",
    '--     the schema check: this script creates the views schema under them);',
    '--   can create objects in any schema;',
    '--   can read large objects of other roles, or lo_compat_privileges turns their checks off.',
    '-- Each abort prints the statements that fix it, to be run by an administrator, as one',
    '-- transaction when there are several.',
    'DO $$',
    'DECLARE',
    '  leaks text;',
    '  fixes text;',
    'BEGIN',
    `  SELECT ${heldAttributes(', ', '')},`,
    `         format('ALTER ROLE %I %s;', r.rolname, ${heldAttributes(' ', 'NO')})`,
    '    INTO leaks, fixes',
    '  FROM pg_roles r',
    `  WHERE r.rolname = ${role};`,
    "  IF leaks <> '' THEN",
    abort(`role ${config.role} has attributes it must not have: %. Fix: %`, 'leaks', 'fixes'),
    '  END IF;',
    '  -- The joins on pg_roles below always find the role: this transaction created it above if missing.',
    '  SELECT string_agg(format(\'%s %s\', i.type, i.identity), \', \' ORDER BY i.type COLLATE "C", i.identity COLLATE "C") INTO leaks',
    '  FROM pg_roles r',
    "    JOIN pg_shdepend s ON s.refclassid = 'pg_authid'::regclass AND s.refobjid = r.oid AND s.deptype = 'o'",
    '      AND s.dbid IN (0, (SELECT d.oid FROM pg_database d WHERE d.datname = current_database()))',
    '    CROSS JOIN LATERAL pg_identify_object(s.classid, s.objid, s.objsubid) i',
    `  WHERE r.rolname = ${role}`,
    // The reader's own large objects hold only its own content, and refusing them would let it
    // block every deploy (A64); REASSIGN OWNED leaves default privileges and user mappings alone.
    "    AND s.classid NOT IN ('pg_largeobject'::regclass, 'pg_default_acl'::regclass, 'pg_user_mapping'::regclass)",
    "    AND coalesce(i.schema, '') !~ '^pg_(toast_)?temp_';",
    '  IF leaks IS NOT NULL THEN',
    abort(
      `role ${config.role} owns objects it must not own: %. Fix: REASSIGN OWNED BY % TO CURRENT_USER; -- run as an administrator`,
      'leaks',
      `quote_ident(${role})`,
    ),
    '  END IF;',
    "  SELECT string_agg(format('%I', g.rolname), ', ' ORDER BY g.rolname),",
    `         string_agg((SELECT string_agg(format('REVOKE %I FROM %I%s CASCADE;', g.rolname, r.rolname, ${grantedBy}), ' ' ORDER BY m.grantor) FROM pg_auth_members m WHERE m.roleid = g.oid AND m.member = r.oid), ' ' ORDER BY g.rolname)`,
    '    INTO leaks, fixes',
    '  FROM pg_roles g CROSS JOIN pg_roles r',
    `  WHERE r.rolname = ${role}`,
    '    AND EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = g.oid AND m.member = r.oid);',
    '  IF leaks IS NOT NULL THEN',
    abort(`role ${config.role} must not be a member of other roles: %. Fix: %`, 'leaks', 'fixes'),
    '  END IF;',
    `  SELECT format('%I', d.datname), ${revokeFix("format('CREATE ON DATABASE %I', d.datname)", 'd.datdba', 'd.datacl', ['CREATE'])}`,
    '    INTO leaks, fixes',
    '  FROM pg_database d CROSS JOIN pg_roles r',
    `  WHERE r.rolname = ${role} AND d.datname = current_database()`,
    "    AND has_database_privilege(r.oid, d.oid, 'CREATE');",
    '  IF leaks IS NOT NULL THEN',
    abort(`role ${config.role} can create schemas in database %. Fix: %`, 'leaks', 'fixes'),
    '  END IF;',
    '  SELECT string_agg(o.object, \', \' ORDER BY o.object COLLATE "C"), string_agg(o.fix, \' \' ORDER BY o.object COLLATE "C")',
    '    INTO leaks, fixes',
    '  FROM (',
    // As in revokeFix: the reader is a grantor only of column privileges and revokes first; a
    // grantor that lost a grant option gets back exactly that one, and loses it right after.
    "    SELECT f.object, string_agg(f.fix, ' ' ORDER BY f.grantor <> f.reader, f.grantee, f.grantor) AS fix",
    '    FROM (',
    '      SELECT p.object, p.grantee, p.grantor, p.reader,',
    '             CASE WHEN p.privileges IS NOT NULL THEN concat(',
    "               CASE WHEN p.lost IS NOT NULL THEN format('GRANT %s ON %s TO %s WITH GRANT OPTION; ', p.lost, p.target, p.grantor::regrole) END,",
    "               CASE WHEN p.grantor <> p.owner THEN format('SET ROLE %s; ', p.grantor::regrole) END,",
    "               format('REVOKE %s ON %s FROM %s CASCADE;', p.privileges, p.target, CASE WHEN p.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(p.rolname) END),",
    "               CASE WHEN p.grantor <> p.owner THEN ' RESET ROLE;' END,",
    "               CASE WHEN p.held IS NOT NULL THEN format(' REVOKE GRANT OPTION FOR %s ON %s FROM %s CASCADE;', p.held, p.target, p.grantor::regrole) END,",
    "               CASE WHEN p.unheld IS NOT NULL THEN format(' REVOKE %s ON %s FROM %s CASCADE;', p.unheld, p.target, p.grantor::regrole) END) END AS fix",
    '      FROM (',
    '        SELECT e.object, e.target, e.grantee, e.grantor, e.owner, r.oid AS reader, r.rolname,',
    `               ${privileges('e.grantor <> r.oid OR e.on_column')} AS privileges,`,
    `               ${privileges('e.lost')} AS lost, ${privileges('e.lost AND e.held')} AS held,`,
    `               ${privileges('e.lost AND NOT e.held')} AS unheld`,
    '        FROM pg_roles r CROSS JOIN LATERAL (',
    ...catalogEntries().map((line) => `      ${line}`),
    '        ) e',
    `        WHERE r.rolname = ${role}`,
    '        GROUP BY e.object, e.target, e.grantee, e.grantor, e.owner, r.oid, r.rolname',
    '      ) p',
    '    ) f GROUP BY f.object',
    '  ) o;',
    '  IF leaks IS NOT NULL THEN',
    abort(
      `role ${config.role} has privileges on system catalog objects beyond their initial privileges: %. Fix: %`,
      'leaks',
      'fixes',
    ),
    '  END IF;',
    `  SELECT string_agg(${relation}, ', ' ORDER BY n.nspname, c.relname),`,
    // REVOKE ALL also clears the grantees' column grants.
    `         string_agg(${revokeFix(`format('ALL ON %s', ${relation})`, 'c.relowner', relationAcl, TABLE_PRIVILEGES, { columns: { object: relation, columnPrivilege: 'ALL' } })}, ' ' ORDER BY n.nspname, c.relname)`,
    '    INTO leaks, fixes',
    '  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN pg_roles r',
    `  WHERE r.rolname = ${role}`,
    `    AND c.relkind IN ('r', 'p', 'v', 'm', 'f')`,
    `    AND n.nspname NOT IN (${ql(config.schema)}, 'pg_catalog', 'information_schema')`,
    `    AND n.nspname NOT LIKE 'pg\\_%'`,
    `    AND (has_table_privilege(r.oid, c.oid, '${TABLE_PRIVILEGES.join(', ')}')`,
    `         OR has_any_column_privilege(r.oid, c.oid, '${COLUMN_PRIVILEGES}'));`,
    '  IF leaks IS NOT NULL THEN',
    abort(
      `role ${config.role} can read relations outside schema ${config.schema}: %. Fix: %`,
      'leaks',
      'fixes',
    ),
    '  END IF;',
    "  SELECT string_agg(format('%I', fs.srvname), ', ' ORDER BY fs.srvname),",
    `         string_agg(${revokeFix("format('USAGE ON FOREIGN SERVER %I', fs.srvname)", 'fs.srvowner', 'fs.srvacl', ['USAGE'])}, ' ' ORDER BY fs.srvname)`,
    '    INTO leaks, fixes',
    '  FROM pg_foreign_server fs CROSS JOIN pg_roles r',
    `  WHERE r.rolname = ${role}`,
    "    AND has_server_privilege(r.oid, fs.oid, 'USAGE');",
    '  IF leaks IS NOT NULL THEN',
    abort(`role ${config.role} can use foreign servers: %. Fix: %`, 'leaks', 'fixes'),
    '  END IF;',
    `  SELECT string_agg(${routine}, ', ' ORDER BY n.nspname, p.proname),`,
    `         string_agg(${revokeFix(`format('EXECUTE ON ROUTINE %s', ${routine})`, 'p.proowner', 'p.proacl', ['EXECUTE'], { publicByDefault: true })}, ' ' ORDER BY n.nspname, p.proname)`,
    '    INTO leaks, fixes',
    '  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace CROSS JOIN pg_roles r',
    `  WHERE r.rolname = ${role}`,
    '    AND p.prosecdef',
    `    AND n.nspname NOT IN ('pg_catalog', 'information_schema')`,
    `    AND n.nspname NOT LIKE 'pg\\_%'`,
    "    AND has_schema_privilege(r.oid, n.oid, 'USAGE')",
    "    AND has_function_privilege(r.oid, p.oid, 'EXECUTE');",
    '  IF leaks IS NOT NULL THEN',
    abort(
      `role ${config.role} can execute SECURITY DEFINER functions: %. Fix: %`,
      'leaks',
      'fixes',
    ),
    '  END IF;',
    `  SELECT string_agg(${relation}, ', ' ORDER BY n.nspname, c.relname),`,
    `         string_agg(${revokeFix(`format('ALL ON SEQUENCE %s', ${relation})`, 'c.relowner', relationAcl, SEQUENCE_PRIVILEGES, { columns: { object: `format('SEQUENCE %s', ${relation})`, columnPrivilege: 'SELECT' } })}, ' ' ORDER BY n.nspname, c.relname)`,
    '    INTO leaks, fixes',
    '  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN pg_roles r',
    `  WHERE r.rolname = ${role}`,
    `    AND c.relkind = 'S'`,
    // has_sequence_privilege ignores column grants, which let a role read a sequence too (A83).
    "    AND (CASE WHEN c.relkind = 'S' THEN has_sequence_privilege(r.oid, c.oid, 'SELECT, USAGE, UPDATE') ELSE false END",
    "         OR has_any_column_privilege(r.oid, c.oid, 'SELECT'));",
    '  IF leaks IS NOT NULL THEN',
    abort(`role ${config.role} can read sequences: %. Fix: %`, 'leaks', 'fixes'),
    '  END IF;',
    `  SELECT string_agg(format('%s created by %I%s', lower(${DEFAULT_ACL_KIND}), o.rolname, ${inSchema('in schema')}), ', ' ${defaultsOrder}),`,
    `         string_agg(format('ALTER DEFAULT PRIVILEGES FOR ROLE %I%s REVOKE ALL ON %s FROM %s;', o.rolname, ${inSchema('IN SCHEMA')}, ${DEFAULT_ACL_KIND}, concat_ws(', ', CASE WHEN d.defaclobjtype IN ${PUBLIC_DEFAULT_KINDS} AND EXISTS (SELECT 1 FROM aclexplode(d.defaclacl) a WHERE a.grantee = 0) THEN 'PUBLIC' END, CASE WHEN EXISTS (SELECT 1 FROM aclexplode(d.defaclacl) a WHERE a.grantee = r.oid) THEN quote_ident(r.rolname) END)), ' ' ${defaultsOrder})`,
    '    INTO leaks, fixes',
    '  FROM pg_default_acl d JOIN pg_roles o ON o.oid = d.defaclrole',
    '    LEFT JOIN pg_namespace dn ON dn.oid = d.defaclnamespace CROSS JOIN pg_roles r',
    // The reader's own defaults reach only objects it creates itself, and refusing them would let
    // it block every deploy (A71).
    `  WHERE r.rolname = ${role} AND d.defaclrole <> r.oid`,
    '    AND EXISTS (SELECT 1 FROM aclexplode(d.defaclacl) a',
    `                WHERE a.grantee = r.oid OR (a.grantee = 0 AND d.defaclobjtype IN ${PUBLIC_DEFAULT_KINDS}));`,
    '  IF leaks IS NOT NULL THEN',
    abort(
      `role ${config.role} gets privileges on objects created later (default privileges): %. Fix: %`,
      'leaks',
      'fixes',
    ),
    '  END IF;',
    "  SELECT string_agg(format('%I', n.nspname), ', ' ORDER BY n.nspname),",
    `         string_agg(${revokeFix("format('CREATE ON SCHEMA %I', n.nspname)", 'n.nspowner', 'n.nspacl', ['CREATE'])}, ' ' ORDER BY n.nspname)`,
    '    INTO leaks, fixes',
    '  FROM pg_namespace n CROSS JOIN pg_roles r',
    `  WHERE r.rolname = ${role}`,
    // The applying session's own temp schema grants CREATE to every role with TEMP on the
    // database; that is not a leak, and REVOKE on it would do nothing. Other sessions' temp
    // schemas are checked: a CREATE grant on one is real (0 when this session has none).
    '    AND n.oid <> pg_my_temp_schema()',
    "    AND has_schema_privilege(r.oid, n.oid, 'CREATE');",
    '  IF leaks IS NOT NULL THEN',
    abort(`role ${config.role} can create objects in schemas: %. Fix: %`, 'leaks', 'fixes'),
    '  END IF;',
    // The applying session sees only the server's setting reliably, and it reaches the reader unless
    // a setting in pg_db_role_setting overrides it there; those settings for the reader's role, all
    // roles or the database are each reset where they are set (A61). A setting on the server
    // command line cannot be reset by SQL, so it is turned off for the reader's role (A70), which
    // the fix creates again when this transaction created it (A81).
    "  SELECT string_agg(c.source, ', ' ORDER BY c.n), string_agg(c.fix, ' ' ORDER BY c.n)",
    '    INTO leaks, fixes',
    '  FROM pg_roles r CROSS JOIN LATERAL (',
    "    SELECT 0 AS n, CASE s.source WHEN 'command line' THEN 'the server command line' ELSE 'the server configuration' END AS source,",
    "           CASE s.source WHEN 'command line' THEN format('%sALTER ROLE %I SET lo_compat_privileges = off;', CASE WHEN current_setting('hyde_db.created_reader', true) = 'on' THEN format('CREATE ROLE %I NOLOGIN; ', r.rolname) END, r.rolname) ELSE 'ALTER SYSTEM SET lo_compat_privileges = off; SELECT pg_reload_conf();' END AS fix",
    "    FROM pg_settings s WHERE s.name = 'lo_compat_privileges' AND s.setting = 'on' AND s.source IN ('configuration file', 'command line')",
    `      AND NOT EXISTS (SELECT 1 FROM pg_db_role_setting o CROSS JOIN LATERAL unnest(o.setconfig) cfg WHERE ${readerSetting('o')} AND cfg ~* '^lo_compat_privileges=')`,
    '    UNION ALL SELECT row_number() OVER (ORDER BY s.setdatabase, s.setrole),',
    `           ${settingScope("'all roles'", "format('role %I', r.rolname)", "format('database %I', current_database())", "format('role %I in database %I', r.rolname, current_database())")},`,
    `           format('ALTER %s RESET lo_compat_privileges;', ${settingScope("'ROLE ALL'", "format('ROLE %I', r.rolname)", "format('DATABASE %I', current_database())", "format('ROLE %I IN DATABASE %I', r.rolname, current_database())")})`,
    '    FROM pg_db_role_setting s',
    `    WHERE ${readerSetting('s')}`,
    "      AND EXISTS (SELECT 1 FROM unnest(s.setconfig) cfg WHERE cfg ~* '^lo_compat_privileges=(on|t|tr|tru|true|y|ye|yes|1)$')",
    '  ) c',
    `  WHERE r.rolname = ${role};`,
    '  IF leaks IS NOT NULL THEN',
    abort(
      `lo_compat_privileges is on, which turns off privilege checks on large objects for role ${config.role}: %. Fix: %`,
      'leaks',
      printedFix('fixes', true),
    ),
    '  END IF;',
    "  SELECT string_agg(l.oid::text, ', ' ORDER BY l.oid),",
    `         string_agg(${revokeFix("format('ALL ON LARGE OBJECT %s', l.oid)", 'l.lomowner', 'l.lomacl', ['SELECT', 'UPDATE'])}, ' ' ORDER BY l.oid)`,
    '    INTO leaks, fixes',
    '  FROM pg_largeobject_metadata l CROSS JOIN pg_roles r',
    `  WHERE r.rolname = ${role}`,
    '    AND l.lomowner <> r.oid',
    '    AND EXISTS (SELECT 1 FROM aclexplode(l.lomacl) a WHERE a.grantee IN (0, r.oid));',
    '  IF leaks IS NOT NULL THEN',
    abort(
      `role ${config.role} can read large objects it does not own: %. Fix: %`,
      'leaks',
      'fixes',
    ),
    '  END IF;',
    'END $$;',
  ]
}

export function renderApplySql({ config, views }: RenderInput): string {
  const S = qi(config.schema)
  const R = qi(config.role)
  const out: string[] = []
  out.push(
    `-- GENERATED by ${BRAND} from schema.prisma. Do not edit by hand.`,
    `-- Recreates schema ${config.schema} with column-filtered views and grants role ${config.role}`,
    '-- read access to exactly those views. Run AFTER `prisma migrate deploy`.',
    '-- The whole script is one transaction; the final check aborts it if the role',
    '-- could read anything outside the views.',
    '',
    'SET client_min_messages = warning;',
    'BEGIN;',
    // A session holding a lock on the views makes the deploy fail instead of wait forever (A72),
    // and the setting ends with the transaction (A84).
    "SET LOCAL lock_timeout = '60s';",
    '',
    'DO $$ BEGIN',
    `  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${ql(config.role)}) THEN`,
    `    CREATE ROLE ${R} NOLOGIN;`,
    // An abort rolls the creation back; a fix that names the role must create it again (A81).
    "    PERFORM set_config('hyde_db.created_reader', 'on', true);",
    '  END IF;',
    'END $$;',
    '',
    renderSchemaGuard(config),
    '',
    `DROP SCHEMA IF EXISTS ${S} CASCADE;`,
    `CREATE SCHEMA ${S};`,
    `COMMENT ON SCHEMA ${S} IS ${ql(`${SCHEMA_MARKER}. Read-only views with sensitive columns removed. Recreated on every deploy.`)};`,
    '',
  )

  for (const view of views) {
    const cols = view.columns.map((c) => `  ${qi(c.column)}`).join(',\n')
    // Views run with the owner's privileges (no security_invoker), so the reader
    // role needs no rights on the underlying tables at all.
    out.push(
      `CREATE VIEW ${S}.${qi(view.name)} AS SELECT\n${cols}\nFROM ${qi(view.sourceSchema)}.${qi(view.source)};`,
    )
    if (view.doc) out.push(`COMMENT ON VIEW ${S}.${qi(view.name)} IS ${ql(view.doc)};`)
    for (const c of view.columns) {
      if (c.doc)
        out.push(`COMMENT ON COLUMN ${S}.${qi(view.name)}.${qi(c.column)} IS ${ql(c.doc)};`)
    }
    out.push('')
  }

  out.push(
    `-- Privileges: nothing but SELECT on the views in ${config.schema}. Privileges elsewhere are`,
    '-- not revoked here: the final check refuses them and prints the statements that remove them.',
    `GRANT USAGE ON SCHEMA ${S} TO ${R};`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA ${S} TO ${R};`,
    '',
    '-- Defence in depth for the session itself.',
    `ALTER ROLE ${R} SET default_transaction_read_only = on;`,
    `ALTER ROLE ${R} SET statement_timeout = ${ql(config.statementTimeout)};`,
    `ALTER ROLE ${R} SET search_path = ${S};`,
    '',
    ...renderFinalCheck(config),
    '',
    'COMMIT;',
    '',
  )
  return out.join('\n')
}
