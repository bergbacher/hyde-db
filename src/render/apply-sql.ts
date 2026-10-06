// Renders redacted-views.sql: one transaction that recreates the views schema with column-filtered
// views, grants the reader role SELECT on exactly those views, and aborts with a pasteable fix if
// the role could reach anything else (D11, D13, D24, D49, D76, D80–D82, D91, D108, D109, D111,
// D123, D124, D127, D130, D131, D134, D135, D138, D141); it revokes nothing itself (D69).
import { BRAND, SCHEMA_MARKER } from '../brand.ts'
import { quoteIdent as qi, quoteLiteral as ql } from '../sql.ts'
import type { ResolvedConfig, View } from '../types.ts'
import { renderDependentsGuard, renderSchemaGuard } from './schema-guard.ts'

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

/** SQL for routine `p` in schema `n` as GRANT and REVOKE name it, with its argument types. */
const ROUTINE =
  "format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))"

/** SQL condition: `att` is a user column (no system or dropped one) of relation `c`. */
const USER_COLUMN = 'att.attrelid = c.oid AND att.attnum > 0 AND NOT att.attisdropped'

/** The relation's user columns as `att`, for a FROM clause. */
const COLUMNS = `pg_attribute att WHERE ${USER_COLUMN}`

/**
 * An object a fix revokes on: `object` is SQL for it as GRANT and REVOKE name it (`SEQUENCE <name>`
 * for a sequence), `acl` SQL for its own ACL. A relation or sequence `c` has column grants too,
 * with `columns` the default-ACL kind of `c` (`r` or `s`); PUBLIC holds a routine's EXECUTE by
 * default while its ACL is NULL (`publicByDefault`).
 */
interface FixObject {
  readonly object: string
  readonly acl: string
  readonly columns?: 'r' | 's'
  readonly publicByDefault?: boolean
}

/**
 * SQL condition: role `who` itself holds `privilege` with the grant option in `acl`. Options it
 * inherits from a role it belongs to do not count: REVOKE run as it would act as that role (A87).
 */
function ownOption(acl: string, who: string, privilege: string): string {
  return `EXISTS (SELECT 1 FROM aclexplode(${acl}) h WHERE h.grantee = ${who} AND h.privilege_type = ${privilege} AND h.is_grantable)`
}

/**
 * SQL for the role that lends `who` a grant option for `privilege` it no longer holds itself, as
 * `b.lender`, for a FROM clause: a role other than `who`, the owner and the reader whose privileges
 * `who` has and that holds the option in `acl` (the role that masks the loss, A87), else `owner`.
 * Borrowed from that role and taken back by it, the option leaves every other grant as it was (A90).
 * A superuser never lends: its GRANT and REVOKE act as the owner, so taking the option back would
 * also take what `who` holds from the owner (A92, D130). A column option can only be lent by a role
 * that holds it on the column itself: PostgreSQL checks a column grant option against the column's
 * own ACL, so `acl` is the column ACL there.
 */
function lender(acl: string, who: string, privilege: string, owner: string): string {
  return (
    `CROSS JOIN LATERAL (SELECT coalesce((SELECT min(h.grantee) FROM aclexplode(${acl}) h WHERE h.privilege_type = ${privilege} AND h.is_grantable ` +
    `AND h.grantee NOT IN (0, ${who}, ${owner}, r.oid) AND pg_has_role(${who}, h.grantee, 'USAGE') ` +
    `AND NOT EXISTS (SELECT 1 FROM pg_roles s WHERE s.oid = h.grantee AND s.rolsuper)), ${owner}) AS lender) b`
  )
}

/** SQL condition: `who` already holds `privilege` in `acl` from the lender `b.lender`. */
function heldFromLender(acl: string, who: string, privilege: string): string {
  return `EXISTS (SELECT 1 FROM aclexplode(${acl}) h WHERE h.grantee = ${who} AND h.grantor = b.lender AND h.privilege_type = ${privilege})`
}

/**
 * SQL for the pass-ons to PUBLIC or the reader role `r` that grantor `t.grantor` made on object `o`
 * without itself still holding the grant option behind them (A69, A87, A91), one row per privilege
 * on the object (attnum 0) or on a column of relation or sequence `c`: `item` for GRANT and REVOKE,
 * its `lender`, and whether the grantor `held` that privilege from the lender. The reader is a
 * grantor only of column grants here.
 */
function lostGrants(o: FixObject, owner: string, privileges: readonly string[]): string {
  const objectLevel =
    `SELECT 0 AS attnum, x.privilege_type, x.privilege_type AS item, b.lender, ${heldFromLender(o.acl, 't.grantor', 'x.privilege_type')} AS held ` +
    `FROM aclexplode(${o.acl}) x ${lender(o.acl, 't.grantor', 'x.privilege_type', owner)} ` +
    `WHERE t.grantor <> r.oid AND x.grantor = t.grantor AND x.grantee IN (0, r.oid) AND x.privilege_type IN (${privilegeList(privileges)}) AND NOT ${ownOption(o.acl, 't.grantor', 'x.privilege_type')}`
  if (!o.columns) return objectLevel
  const columnAcl = 'c.relacl || att.attacl'
  return (
    `${objectLevel} UNION SELECT att.attnum, x.privilege_type, format('%s (%I)', x.privilege_type, att.attname), b.lender, ${heldFromLender('att.attacl', 't.grantor', 'x.privilege_type')} ` +
    `FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) x ${lender('att.attacl', 't.grantor', 'x.privilege_type', owner)} ` +
    `WHERE ${USER_COLUMN} AND x.grantor = t.grantor AND x.grantee IN (0, r.oid) AND NOT ${ownOption(columnAcl, 't.grantor', 'x.privilege_type')}`
  )
}

/** SQL for the statements around a grantor's revokes that lend it the options it lost. */
interface Lending {
  /** The exact options, granted by their lenders (as the owner without SET ROLE). */
  readonly borrow: string
  /** The same options taken back, keeping what the grantor held from the lender before. */
  readonly giveBack: string
}

/**
 * SQL lending `grantor` the options listed by `lost` (rows of attnum, privilege_type, item, lender,
 * held) on `target`, owned by `owner`, or NULL when there are none. A table-level REVOKE also
 * strips the grantor's column grants of that privilege from the lender (A90), so for a relation
 * (`relation`, its oid) those are granted again from what its column ACLs hold now.
 */
function lending(
  lost: string,
  grantor: string,
  owner: string,
  target: string,
  relation?: string,
): Lending {
  const asLender = (sql: string): string =>
    `concat(CASE WHEN k.lender <> ${owner} THEN format('SET ROLE %s; ', k.lender::regrole) END, ${sql}, CASE WHEN k.lender <> ${owner} THEN ' RESET ROLE;' END)`
  const items = (filter?: string): string =>
    `string_agg(o.item, ', ' ORDER BY o.attnum, o.privilege_type)${filter ? ` FILTER (WHERE ${filter})` : ''}`
  const columns = (filter: string): string =>
    `string_agg(format('%s (%I)', h.privilege_type, att.attname), ', ' ORDER BY att.attnum, h.privilege_type) FILTER (WHERE ${filter})`
  const restore = relation
    ? `, nullif((SELECT concat_ws(' ', CASE WHEN bool_or(h.is_grantable) THEN format('GRANT %s ON %s TO %s WITH GRANT OPTION;', ${columns('h.is_grantable')}, ${target}, ${grantor}::regrole) END, ` +
      `CASE WHEN bool_or(NOT h.is_grantable) THEN format('GRANT %s ON %s TO %s;', ${columns('NOT h.is_grantable')}, ${target}, ${grantor}::regrole) END) ` +
      `FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) h WHERE att.attrelid = ${relation} AND att.attnum > 0 AND NOT att.attisdropped AND h.grantee = ${grantor} AND h.grantor = k.lender AND h.privilege_type = ANY (k.types)), '')`
    : ''
  const revokes =
    `CASE WHEN k.held IS NOT NULL THEN format('REVOKE GRANT OPTION FOR %s ON %s FROM %s CASCADE;', k.held, ${target}, ${grantor}::regrole) END, ` +
    `CASE WHEN k.unheld IS NOT NULL THEN format('REVOKE %s ON %s FROM %s CASCADE;', k.unheld, ${target}, ${grantor}::regrole) END`
  return {
    borrow: `(SELECT string_agg(${asLender(`format('GRANT %s ON %s TO %s WITH GRANT OPTION;', k.items, ${target}, ${grantor}::regrole)`)}, ' ' ORDER BY k.lender) FROM (SELECT o.lender, ${items()} AS items FROM (${lost}) o GROUP BY o.lender) k)`,
    giveBack:
      `(SELECT string_agg(${asLender(`concat_ws(' ', ${revokes}${restore})`)}, ' ' ORDER BY k.lender) ` +
      `FROM (SELECT o.lender, ${items('o.held')} AS held, ${items('NOT o.held')} AS unheld${relation ? ', array_agg(o.privilege_type) FILTER (WHERE o.attnum = 0) AS types' : ''} FROM (${lost}) o GROUP BY o.lender) k)`,
  }
}

/**
 * SQL for the statements that take `privileges` on object `o`, owned by `owner`, away from PUBLIC
 * and the reader role `r`, or NULL when neither holds any. `what` is SQL for the privilege-and-object
 * part of the owner's REVOKE, e.g. `ALL ON public.users`.
 *
 * A superuser's REVOKE acts as the owner and leaves grants made by any other grantor in place (A56),
 * so those are revoked as their grantor, exactly the privileges it granted (D127): REVOKE ALL as a
 * grantor needs options for everything it names, and without them fails or acts as a role the
 * grantor belongs to (A87, A91). A grantor whose own option behind a pass-on is gone borrows it for
 * its revoke (A90). The owner's grants follow in one statement, with CASCADE, which also removes what
 * a grantee passed on in the same ACL (A54); so the reader is a grantor only of column grants on a
 * relation or sequence (A69), and its revokes come first, while it still holds the options they
 * need. The reader is only named when it owns the object or holds a grant, so a fix still runs after
 * a failed first apply rolled back the role's creation.
 */
function revokeFix(
  what: string,
  owner: string,
  privileges: readonly string[],
  o: FixObject,
): string {
  // A NULL ACL stands for the default one; an empty merged ACL would make aclexplode fail (A88).
  const acl = o.columns
    ? `coalesce(${o.acl}, acldefault('${o.columns}', ${owner})) || ARRAY(SELECT unnest(att.attacl) FROM ${COLUMNS})`
    : o.acl
  const held = `FROM aclexplode(${acl}) a WHERE a.privilege_type IN (${privilegeList(privileges)})`
  const loan = lending(
    lostGrants(o, owner, privileges),
    't.grantor',
    owner,
    o.columns ? RELATION : o.object,
    o.columns ? 'c.oid' : undefined,
  )
  const onObject =
    `CASE WHEN t.grantor <> r.oid THEN (SELECT format('REVOKE %s ON %s FROM %s CASCADE;', string_agg(DISTINCT x.privilege_type, ', ' ORDER BY x.privilege_type), ${o.object}, t.grantees) ` +
    `FROM aclexplode(${o.acl}) x WHERE x.grantor = t.grantor AND x.grantee IN (0, r.oid) AND x.privilege_type IN (${privilegeList(privileges)}) HAVING count(*) > 0) END`
  const onColumns =
    `(SELECT format('REVOKE %s ON %s FROM %s CASCADE;', string_agg(o.item, ', ' ORDER BY o.attnum, o.privilege_type), ${RELATION}, t.grantees) ` +
    "FROM (SELECT DISTINCT att.attnum, x.privilege_type, format('%s (%I)', x.privilege_type, att.attname) AS item FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) x " +
    `WHERE ${USER_COLUMN} AND x.grantor = t.grantor AND x.grantee IN (0, r.oid)) o HAVING count(*) > 0)`
  const statements = o.columns ? `concat_ws(' ', ${onObject}, ${onColumns})` : onObject
  const asGrantor = `format('%sSET ROLE %s; %s RESET ROLE;%s', ${loan.borrow} || ' ', t.grantor::regrole, ${statements}, ' ' || ${loan.giveBack})`
  const grantees =
    "FROM (SELECT g.grantor, string_agg(CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(r.rolname) END, ', ' ORDER BY g.grantee) AS grantees "
  const asGrantors = o.columns
    ? `(SELECT string_agg(${asGrantor}, ' ' ORDER BY t.grantor <> r.oid, t.grantor) ${grantees}` +
      `FROM (SELECT a.grantor, a.grantee FROM aclexplode(${o.acl}) a WHERE a.privilege_type IN (${privilegeList(privileges)}) AND a.grantee IN (0, r.oid) AND a.grantor <> ${owner} AND a.grantor <> r.oid ` +
      `UNION SELECT a.grantor, a.grantee FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) a WHERE ${USER_COLUMN} AND a.grantee IN (0, r.oid) AND a.grantor <> ${owner}) g GROUP BY g.grantor) t)`
    : `(SELECT string_agg(${asGrantor}, ' ' ORDER BY t.grantor) ${grantees}` +
      `FROM (SELECT DISTINCT a.grantor, a.grantee FROM aclexplode(${o.acl}) a WHERE a.privilege_type IN (${privilegeList(privileges)}) AND a.grantee IN (0, r.oid) AND a.grantor <> ${owner} AND a.grantor <> r.oid) g GROUP BY g.grantor) t)`
  const asOwner =
    `nullif(concat_ws(', ', CASE WHEN ${o.publicByDefault ? `${acl} IS NULL OR ` : ''}EXISTS (SELECT 1 ${held} AND a.grantee = 0 AND a.grantor = ${owner}) THEN 'PUBLIC' END, ` +
    `CASE WHEN r.oid = ${owner} OR EXISTS (SELECT 1 ${held} AND a.grantee = r.oid AND a.grantor = ${owner}) THEN quote_ident(r.rolname) END), '')`
  return `concat_ws(' ', ${asGrantors}, 'REVOKE ' || ${what} || ' FROM ' || ${asOwner} || ' CASCADE;')`
}

/**
 * SQL for the note naming who must run a fix whose statements outside `SET ROLE` act as the owners
 * `owner` of the objects a check found, aggregated over them (D134): NULL when the deploying role
 * acts as every one of them (it is the owner, a member of the owner role or a superuser);
 * ` -- run as <owner> or a superuser` when the objects have one owner and the role does not act as
 * it; otherwise, for several owners, ` -- run as a superuser`. A REVOKE by any other role changes
 * nothing (A95), without even a warning when that role holds the grant option.
 */
function runAs(owner: string): string {
  return (
    `CASE WHEN bool_and(pg_has_role(${owner}, 'USAGE')) IS NOT FALSE THEN NULL WHEN count(DISTINCT ${owner}) = 1 ` +
    `THEN format(' -- run as %s or a superuser', min(${owner})::regrole) ELSE ' -- run as a superuser' END`
  )
}

/**
 * SQL for the text an abort prints after "Fix: " from the statements in `fixes`: one transaction
 * when there are several, so a pasted fix applies completely or not at all (A82; ALTER SYSTEM
 * cannot run in one), marked to be run as a superuser when it switches roles or `superuser` says
 * so, and otherwise with the note in `runner` (D134).
 */
function printedFix(fixes: string, superuser = false, runner?: string): string {
  const mark = superuser
    ? "' -- run as a superuser'"
    : `CASE WHEN ${fixes} LIKE '%SET ROLE %' THEN ' -- run as a superuser'${runner ? ` ELSE ${runner}` : ''} END`
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

/**
 * Configuration parameter privileges (PostgreSQL 15+): SET, which matters for parameters that only
 * superusers could set otherwise, and ALTER SYSTEM.
 */
const PARAMETER_PRIVILEGES: readonly string[] = ['SET', 'ALTER SYSTEM']

/**
 * The owner of every configuration parameter's ACL: parameters have no owner column, and
 * PostgreSQL treats the bootstrap superuser (OID 10) as their owner, so a superuser's grants on
 * them are recorded as its grants.
 */
const PARAMETER_OWNER = '10::oid'

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
 * target, relation oid (NULL for others), column number (0 for the object itself), privilege
 * type and privilege as GRANT and REVOKE name it, grantee, grantor, owner, whether it is a column
 * privilege, the ACL that holds the grantor's own grant options for it, and the ACL a lender of
 * that option must hold it in (D127). An entry is extra
 * when the initial ACL grants that privilege neither to its grantee nor to PUBLIC. Objects without
 * a pg_init_privs row start from their default ACL; information_schema records none, and initdb
 * grants PUBLIC USAGE on it and SELECT on its views, except on the internal _pg_ views.
 */
function catalogEntries(): string[] {
  const relation = RELATION
  const routine = ROUTINE
  const initial = (classoid: string, objoid: string, objsubid: string): string =>
    `(SELECT ip.initprivs FROM pg_init_privs ip WHERE ip.classoid = '${classoid}'::regclass AND ip.objoid = ${objoid} AND ip.objsubid = ${objsubid})`
  return [
    `    SELECT ${relation} AS object, format('TABLE %s', ${relation}) AS target, c.oid AS relid, x.attnum, x.privilege_type,`,
    "           CASE WHEN x.col IS NULL THEN x.privilege_type ELSE format('%s (%I)', x.privilege_type, x.col) END AS privilege,",
    '           x.grantee, x.grantor, c.relowner AS owner, x.col IS NOT NULL AS on_column, x.own_acl, x.lender_acl',
    '    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN LATERAL (',
    "      SELECT NULL::name AS col, 0 AS attnum, a.grantee, a.grantor, a.privilege_type, '{}'::aclitem[] AS initial,",
    '        c.relacl AS own_acl, c.relacl AS lender_acl FROM aclexplode(c.relacl) a',
    `      UNION ALL SELECT att.attname, att.attnum, a.grantee, a.grantor, a.privilege_type, coalesce(${initial('pg_class', 'c.oid', 'att.attnum')}, '{}'),`,
    `        c.relacl || att.attacl, att.attacl FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) a WHERE ${USER_COLUMN}`,
    '    ) x',
    `    WHERE n.nspname IN ${CATALOG_SCHEMAS} AND x.grantee IN (0, r.oid)`,
    `      AND NOT EXISTS (SELECT 1 FROM aclexplode(x.initial || coalesce(${initial('pg_class', 'c.oid', '0')},`,
    "            CASE WHEN n.nspname = 'information_schema' AND c.relname NOT LIKE '\\_pg\\_%' THEN acldefault('r', c.relowner) || makeaclitem(0, c.relowner, 'SELECT', false) ELSE acldefault('r', c.relowner) END)) b",
    '        WHERE b.grantee IN (x.grantee, 0) AND b.privilege_type = x.privilege_type)',
    `    UNION ALL SELECT ${routine}, format('ROUTINE %s', ${routine}), NULL::oid, 0, a.privilege_type, a.privilege_type, a.grantee, a.grantor, p.proowner, false,`,
    '      p.proacl, p.proacl',
    '    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace CROSS JOIN LATERAL aclexplode(p.proacl) a',
    `    WHERE n.nspname IN ${CATALOG_SCHEMAS} AND a.grantee IN (0, r.oid)`,
    `      AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(${initial('pg_proc', 'p.oid', '0')}, acldefault('f', p.proowner))) b`,
    '        WHERE b.grantee IN (a.grantee, 0) AND b.privilege_type = a.privilege_type)',
    "    UNION ALL SELECT format('%I', n.nspname), format('SCHEMA %I', n.nspname), NULL::oid, 0, a.privilege_type, a.privilege_type, a.grantee, a.grantor, n.nspowner, false,",
    '      n.nspacl, n.nspacl',
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
  // An abort whose fix revokes as the owners of the objects found, which the deployer may not be.
  const ownersAbort = (message: string): string =>
    `    RAISE EXCEPTION '${BRAND}: ${message}', leaks, ${printedFix('fixes', false, 'runner')};`
  const routine = ROUTINE
  const relation = RELATION
  // The catalog entries a grantor's statements revoke: the reader revokes only column privileges.
  const revoked = '(e.grantor <> e.reader OR e.on_column)'
  // A catalog grantor's loans, for the entries of one object and grantor `g`.
  const catalogLoan = lending(
    `SELECT e.attnum, e.privilege_type, e.privilege AS item, e.lender, e.held FROM e WHERE e.object = g.object AND e.grantor = g.grantor AND e.lost AND ${revoked}`,
    'g.grantor',
    'g.owner',
    'g.target',
    'g.relid',
  )
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
    '--   has lo_compat_privileges on, which turns off privilege checks on large objects;',
    '--   can read large objects of other roles;',
    '--   holds SET or ALTER SYSTEM on a configuration parameter (PostgreSQL 15 and later).',
    '-- Each abort prints the statements that fix it, to be run by an administrator, as one',
    '-- transaction when there are several, and says who must run them when the deploying role',
    '-- cannot.',
    'DO $$',
    'DECLARE',
    '  leaks text;',
    '  fixes text;',
    '  runner text;',
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
    // One row at most; aggregated like the other checks for the owner note.
    `  SELECT string_agg(format('%I', d.datname), ', '), string_agg(${revokeFix("format('CREATE ON DATABASE %I', d.datname)", 'd.datdba', ['CREATE'], { object: "format('DATABASE %I', d.datname)", acl: 'd.datacl' })}, ' '),`,
    `         ${runAs('d.datdba')}`,
    '    INTO leaks, fixes, runner',
    '  FROM pg_database d CROSS JOIN pg_roles r',
    `  WHERE r.rolname = ${role} AND d.datname = current_database()`,
    "    AND has_database_privilege(r.oid, d.oid, 'CREATE');",
    '  IF leaks IS NOT NULL THEN',
    ownersAbort(`role ${config.role} can create schemas in database %. Fix: %`),
    '  END IF;',
    // As in revokeFix: each grantor revokes exactly the extra privileges it granted, the reader only
    // column privileges and first, after borrowing the options it lost and before giving them back.
    // Lost options and their lenders are worked out only for the entries found, not every ACL entry.
    '  WITH e AS (SELECT ce.object, ce.target, ce.relid, ce.attnum, ce.privilege_type, ce.privilege, ce.grantee, ce.grantor, ce.owner, ce.on_column,',
    `           ce.grantor <> ce.owner AND NOT ${ownOption('ce.own_acl', 'ce.grantor', 'ce.privilege_type')} AS lost, b.lender,`,
    `           ${heldFromLender('ce.lender_acl', 'ce.grantor', 'ce.privilege_type')} AS held, r.oid AS reader, r.rolname`,
    '    FROM pg_roles r CROSS JOIN LATERAL (',
    ...catalogEntries().map((line) => `  ${line}`),
    `    ) ce ${lender('ce.lender_acl', 'ce.grantor', 'ce.privilege_type', 'ce.owner')}`,
    `    WHERE r.rolname = ${role})`,
    '  SELECT (SELECT string_agg(DISTINCT e.object COLLATE "C", \', \' ORDER BY e.object COLLATE "C") FROM e),',
    `         (SELECT ${runAs('e.owner')} FROM e),`,
    '         (SELECT string_agg(f.fix, \' \' ORDER BY f.object COLLATE "C", f.grantor <> f.reader, f.grantor) FROM (',
    '    SELECT g.object, g.grantor, g.reader,',
    `           concat(${catalogLoan.borrow} || ' ', CASE WHEN g.grantor <> g.owner THEN format('SET ROLE %s; ', g.grantor::regrole) END,`,
    "                  (SELECT string_agg(format('REVOKE %s ON %s FROM %s CASCADE;', q.privileges, g.target, CASE WHEN q.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(g.rolname) END), ' ' ORDER BY q.grantee)",
    `                   FROM (SELECT e.grantee, string_agg(e.privilege, ', ' ORDER BY e.privilege COLLATE "C") AS privileges FROM e WHERE e.object = g.object AND e.grantor = g.grantor AND ${revoked} GROUP BY e.grantee) q),`,
    `                  CASE WHEN g.grantor <> g.owner THEN ' RESET ROLE;' END, ' ' || ${catalogLoan.giveBack}) AS fix`,
    `    FROM (SELECT DISTINCT e.object, e.target, e.relid, e.grantor, e.owner, e.reader, e.rolname FROM e WHERE ${revoked}) g`,
    '  ) f)',
    '    INTO leaks, runner, fixes;',
    '  IF leaks IS NOT NULL THEN',
    ownersAbort(
      `role ${config.role} has privileges on system catalog objects beyond their initial privileges: %. Fix: %`,
    ),
    '  END IF;',
    `  SELECT string_agg(${relation}, ', ' ORDER BY n.nspname, c.relname),`,
    // REVOKE ALL also clears the grantees' column grants.
    `         string_agg(${revokeFix(`format('ALL ON %s', ${relation})`, 'c.relowner', TABLE_PRIVILEGES, { object: relation, acl: 'c.relacl', columns: 'r' })}, ' ' ORDER BY n.nspname, c.relname),`,
    `         ${runAs('c.relowner')}`,
    '    INTO leaks, fixes, runner',
    '  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN pg_roles r',
    `  WHERE r.rolname = ${role}`,
    `    AND c.relkind IN ('r', 'p', 'v', 'm', 'f')`,
    `    AND n.nspname NOT IN (${ql(config.schema)}, 'pg_catalog', 'information_schema')`,
    `    AND n.nspname NOT LIKE 'pg\\_%'`,
    `    AND (has_table_privilege(r.oid, c.oid, '${TABLE_PRIVILEGES.join(', ')}')`,
    `         OR has_any_column_privilege(r.oid, c.oid, '${COLUMN_PRIVILEGES}'));`,
    '  IF leaks IS NOT NULL THEN',
    ownersAbort(
      `role ${config.role} can read relations outside schema ${config.schema}: %. Fix: %`,
    ),
    '  END IF;',
    "  SELECT string_agg(format('%I', fs.srvname), ', ' ORDER BY fs.srvname),",
    `         string_agg(${revokeFix("format('USAGE ON FOREIGN SERVER %I', fs.srvname)", 'fs.srvowner', ['USAGE'], { object: "format('FOREIGN SERVER %I', fs.srvname)", acl: 'fs.srvacl' })}, ' ' ORDER BY fs.srvname),`,
    `         ${runAs('fs.srvowner')}`,
    '    INTO leaks, fixes, runner',
    '  FROM pg_foreign_server fs CROSS JOIN pg_roles r',
    `  WHERE r.rolname = ${role}`,
    "    AND has_server_privilege(r.oid, fs.oid, 'USAGE');",
    '  IF leaks IS NOT NULL THEN',
    ownersAbort(`role ${config.role} can use foreign servers: %. Fix: %`),
    '  END IF;',
    `  SELECT string_agg(${routine}, ', ' ORDER BY n.nspname, p.proname),`,
    `         string_agg(${revokeFix(`format('EXECUTE ON ROUTINE %s', ${routine})`, 'p.proowner', ['EXECUTE'], { object: `format('ROUTINE %s', ${routine})`, acl: 'p.proacl', publicByDefault: true })}, ' ' ORDER BY n.nspname, p.proname),`,
    `         ${runAs('p.proowner')}`,
    '    INTO leaks, fixes, runner',
    '  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace CROSS JOIN pg_roles r',
    `  WHERE r.rolname = ${role}`,
    '    AND p.prosecdef',
    `    AND n.nspname NOT IN ('pg_catalog', 'information_schema')`,
    `    AND n.nspname NOT LIKE 'pg\\_%'`,
    "    AND has_schema_privilege(r.oid, n.oid, 'USAGE')",
    "    AND has_function_privilege(r.oid, p.oid, 'EXECUTE');",
    '  IF leaks IS NOT NULL THEN',
    ownersAbort(`role ${config.role} can execute SECURITY DEFINER functions: %. Fix: %`),
    '  END IF;',
    `  SELECT string_agg(${relation}, ', ' ORDER BY n.nspname, c.relname),`,
    `         string_agg(${revokeFix(`format('ALL ON SEQUENCE %s', ${relation})`, 'c.relowner', SEQUENCE_PRIVILEGES, { object: `format('SEQUENCE %s', ${relation})`, acl: 'c.relacl', columns: 's' })}, ' ' ORDER BY n.nspname, c.relname),`,
    `         ${runAs('c.relowner')}`,
    '    INTO leaks, fixes, runner',
    '  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN pg_roles r',
    `  WHERE r.rolname = ${role}`,
    `    AND c.relkind = 'S'`,
    // A reader's own temporary sequence holds nothing of anyone else's (A88).
    "    AND n.nspname !~ '^pg_(toast_)?temp_'",
    // has_sequence_privilege ignores column grants, which let a role read a sequence too (A83).
    "    AND (CASE WHEN c.relkind = 'S' THEN has_sequence_privilege(r.oid, c.oid, 'SELECT, USAGE, UPDATE') ELSE false END",
    "         OR has_any_column_privilege(r.oid, c.oid, 'SELECT'));",
    '  IF leaks IS NOT NULL THEN',
    ownersAbort(`role ${config.role} can read sequences: %. Fix: %`),
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
    `         string_agg(${revokeFix("format('CREATE ON SCHEMA %I', n.nspname)", 'n.nspowner', ['CREATE'], { object: "format('SCHEMA %I', n.nspname)", acl: 'n.nspacl' })}, ' ' ORDER BY n.nspname),`,
    `         ${runAs('n.nspowner')}`,
    '    INTO leaks, fixes, runner',
    '  FROM pg_namespace n CROSS JOIN pg_roles r',
    `  WHERE r.rolname = ${role}`,
    // The applying session's own temp schema grants CREATE to every role with TEMP on the
    // database; that is not a leak, and REVOKE on it would do nothing. Other sessions' temp
    // schemas are checked: a CREATE grant on one is real (0 when this session has none).
    '    AND n.oid <> pg_my_temp_schema()',
    "    AND has_schema_privilege(r.oid, n.oid, 'CREATE');",
    '  IF leaks IS NOT NULL THEN',
    ownersAbort(`role ${config.role} can create objects in schemas: %. Fix: %`),
    '  END IF;',
    // The applying session sees only the server's setting reliably, and it reaches the reader unless
    // a setting in pg_db_role_setting overrides it there; those settings for the reader's role, all
    // roles or the database are each reset where they are set (A61). A setting on the server
    // command line cannot be reset by SQL, so it is turned off for the reader's role (A70), which
    // the fix creates again when this transaction created it (A81), granting a deployer that is not
    // a superuser ADMIN on it, which its re-apply needs on PostgreSQL 16+ (A89).
    "  SELECT string_agg(c.source, ', ' ORDER BY c.n), string_agg(c.fix, ' ' ORDER BY c.n)",
    '    INTO leaks, fixes',
    '  FROM pg_roles r CROSS JOIN LATERAL (',
    "    SELECT 0 AS n, CASE s.source WHEN 'command line' THEN 'the server command line' ELSE 'the server configuration' END AS source,",
    "           CASE s.source WHEN 'command line' THEN format('%sALTER ROLE %I SET lo_compat_privileges = off;', CASE WHEN current_setting('hyde_db.created_reader', true) = 'on' THEN format('CREATE ROLE %I NOLOGIN; %s', r.rolname, " +
      "CASE WHEN NOT (SELECT u.rolsuper FROM pg_roles u WHERE u.rolname = current_user) THEN format('GRANT %I TO %I WITH ADMIN OPTION%s; ', r.rolname, current_user, " +
      // PostgreSQL 16+ would also let the deployer inherit and SET the reader, unlike CREATEROLE's own grant.
      "CASE WHEN current_setting('server_version_num')::int >= 160000 THEN ', INHERIT FALSE, SET FALSE' END) END) END, r.rolname) " +
      "ELSE 'ALTER SYSTEM SET lo_compat_privileges = off; SELECT pg_reload_conf();' END AS fix",
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
    `         string_agg(${revokeFix("format('ALL ON LARGE OBJECT %s', l.oid)", 'l.lomowner', ['SELECT', 'UPDATE'], { object: "format('LARGE OBJECT %s', l.oid)", acl: 'l.lomacl' })}, ' ' ORDER BY l.oid),`,
    `         ${runAs('l.lomowner')}`,
    '    INTO leaks, fixes, runner',
    '  FROM pg_largeobject_metadata l CROSS JOIN pg_roles r',
    `  WHERE r.rolname = ${role}`,
    '    AND l.lomowner <> r.oid',
    '    AND EXISTS (SELECT 1 FROM aclexplode(l.lomacl) a WHERE a.grantee IN (0, r.oid));',
    '  IF leaks IS NOT NULL THEN',
    ownersAbort(`role ${config.role} can read large objects it does not own: %. Fix: %`),
    '  END IF;',
    // SET on lo_compat_privileges turns the large-object checks off for the reader's own sessions,
    // and ALTER SYSTEM rewrites the server configuration (A96). Parameter privileges exist from
    // PostgreSQL 15 on: the query runs through EXECUTE, so earlier servers, which have no
    // pg_parameter_acl, never parse it. Only a superuser can run the fix.
    "  IF current_setting('server_version_num')::int >= 150000 THEN",
    "    EXECUTE $p$SELECT string_agg(format('%I', pa.parname), ', ' ORDER BY pa.parname),",
    `             string_agg(${revokeFix(`format('%s ON PARAMETER %I', (SELECT string_agg(DISTINCT a.privilege_type, ', ' ORDER BY a.privilege_type) FROM aclexplode(pa.paracl) a WHERE a.grantee IN (0, r.oid) AND a.grantor = ${PARAMETER_OWNER}), pa.parname)`, PARAMETER_OWNER, PARAMETER_PRIVILEGES, { object: "format('PARAMETER %I', pa.parname)", acl: 'pa.paracl' })}, ' ' ORDER BY pa.parname)`,
    '      FROM pg_parameter_acl pa CROSS JOIN pg_roles r',
    `      WHERE r.rolname = ${role}`,
    '        AND EXISTS (SELECT 1 FROM aclexplode(pa.paracl) a WHERE a.grantee IN (0, r.oid))$p$',
    '      INTO leaks, fixes;',
    '    IF leaks IS NOT NULL THEN',
    `  ${abort(
      `role ${config.role} has privileges on configuration parameters: %. Fix: %`,
      'leaks',
      printedFix('fixes', true),
    )}`,
    '    END IF;',
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
    'BEGIN;',
    // Every setting ends with the transaction (A84, D131): the notices DROP … CASCADE prints are
    // noise, a session holding a lock on the views makes the deploy fail instead of wait forever
    // (A72), and JIT would compile the final check (A93).
    'SET LOCAL client_min_messages = warning;',
    "SET LOCAL lock_timeout = '60s';",
    // The final check's catalog query is planned from catalog-wide row estimates; JIT would spend
    // about a second compiling it on every deploy for a few rows of work.
    'SET LOCAL jit = off;',
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
    renderDependentsGuard(config),
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
      `CREATE VIEW ${S}.${qi(view.name)} AS SELECT\n${cols}\nFROM ${qi(view.sourceSchema ?? config.sourceSchema)}.${qi(view.source)};`,
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
