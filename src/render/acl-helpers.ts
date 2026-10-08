// ACL SQL helpers shared by the PostgreSQL final checks: the catalog queries and the statements that
// revoke what the reader role must not hold, printed as the fix of an abort (A51–A100, D81, D127,
// D130, D134). Moved verbatim out of apply-sql.ts (D143).

/** The privilege names as a SQL list of string literals. */
function privilegeList(privileges: readonly string[]): string {
  return privileges.map((p) => `'${p}'`).join(', ')
}

/** SQL for the qualified name of relation `c` in schema `n`. */
export const RELATION: string = "format('%I.%I', n.nspname, c.relname)"

/** SQL for routine `p` in schema `n` as GRANT and REVOKE name it, with its argument types. */
export const ROUTINE: string =
  "format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))"

/** SQL condition: `att` is a user column (no system or dropped one) of relation `c`. */
const USER_COLUMN: string = 'att.attrelid = c.oid AND att.attnum > 0 AND NOT att.attisdropped'

/** The relation's user columns as `att`, for a FROM clause. */
const COLUMNS: string = `pg_attribute att WHERE ${USER_COLUMN}`

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
export function ownOption(acl: string, who: string, privilege: string): string {
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
export function lender(acl: string, who: string, privilege: string, owner: string): string {
  return (
    `CROSS JOIN LATERAL (SELECT coalesce((SELECT min(h.grantee) FROM aclexplode(${acl}) h WHERE h.privilege_type = ${privilege} AND h.is_grantable ` +
    `AND h.grantee NOT IN (0, ${who}, ${owner}, r.oid) AND pg_has_role(${who}, h.grantee, 'USAGE') ` +
    `AND NOT EXISTS (SELECT 1 FROM pg_roles s WHERE s.oid = h.grantee AND s.rolsuper)), ${owner}) AS lender) b`
  )
}

/** SQL condition: `who` already holds `privilege` in `acl` from the lender `b.lender`. */
export function heldFromLender(acl: string, who: string, privilege: string): string {
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
export function lending(
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
export function revokeFix(
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
 * acts as every one of them (it is the owner, inherits the owner role's privileges or is a
 * superuser); ` -- run as <owner> or a superuser` when the objects have one owner and the role does
 * not act as it; otherwise, for several owners, ` -- run as a superuser`. A REVOKE by any other role
 * changes nothing (A95), without even a warning when that role holds the grant option (A100). An
 * owner `pg_database_owner` (schema public from PostgreSQL 15 on) counts as the database's owner,
 * which acts as it and, unlike it, can log in.
 */
export function runAs(owner: string): string {
  const acting = `CASE WHEN ${owner} = to_regrole('pg_database_owner')::oid THEN (SELECT dbo.datdba FROM pg_database dbo WHERE dbo.datname = current_database()) ELSE ${owner} END`
  return (
    `CASE WHEN bool_and(pg_has_role(${acting}, 'USAGE')) IS NOT FALSE THEN NULL WHEN count(DISTINCT ${acting}) = 1 ` +
    `THEN format(' -- run as %s or a superuser', min(${acting})::regrole) ELSE ' -- run as a superuser' END`
  )
}

/**
 * SQL for the text an abort prints after "Fix: " from the statements in `fixes`: one transaction
 * when there are several, so a pasted fix applies completely or not at all (A82; ALTER SYSTEM
 * cannot run in one), marked to be run as a superuser when it switches roles or `superuser` says
 * so, and otherwise with the note in `runner` (D134).
 */
export function printedFix(fixes: string, superuser = false, runner?: string): string {
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
export function heldAttributes(separator: string, prefix: string): string {
  const cases = ATTRIBUTES.map(
    ([column, name]) => `CASE WHEN r.${column} THEN '${prefix}${name}' END`,
  )
  return `concat_ws('${separator}', ${cases.join(', ')})`
}

/**
 * Table privileges, any of which lets a role read rows (A51). MAINTAIN (PostgreSQL 17+) is left
 * out: it reads no rows, and earlier servers reject its name.
 */
export const TABLE_PRIVILEGES: readonly string[] = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
]

/** Sequence privileges, any of which lets a role read a sequence (D13). */
export const SEQUENCE_PRIVILEGES: readonly string[] = ['SELECT', 'USAGE', 'UPDATE']

/** The privileges a column grant can carry. */
export const COLUMN_PRIVILEGES: string = 'SELECT, INSERT, UPDATE, REFERENCES'

/**
 * Configuration parameter privileges (PostgreSQL 15+): SET, which matters for parameters that only
 * superusers could set otherwise, and ALTER SYSTEM.
 */
export const PARAMETER_PRIVILEGES: readonly string[] = ['SET', 'ALTER SYSTEM']

/**
 * The owner of every configuration parameter's ACL: parameters have no owner column, and
 * PostgreSQL treats the bootstrap superuser (OID 10) as their owner, so a superuser's grants on
 * them are recorded as its grants.
 */
export const PARAMETER_OWNER: string = '10::oid'

/** The ALTER DEFAULT PRIVILEGES keyword of a pg_default_acl object type; LARGE OBJECTS exist from PostgreSQL 18. */
export const DEFAULT_ACL_KIND: string =
  "CASE d.defaclobjtype WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES' WHEN 'f' THEN 'FUNCTIONS' " +
  "WHEN 'T' THEN 'TYPES' WHEN 'n' THEN 'SCHEMAS' WHEN 'L' THEN 'LARGE OBJECTS' END"

/**
 * Object types whose default privileges for PUBLIC let the reader in (A53, A59, A65). Large
 * objects ('L') have default privileges from PostgreSQL 18; earlier servers simply have no such rows.
 */
export const PUBLIC_DEFAULT_KINDS: string = "('r', 'S', 'n', 'L')"

/** Schemas whose objects start with initial privileges that the reader must not exceed (D81). */
const CATALOG_SCHEMAS: string = "('pg_catalog', 'information_schema', 'pg_toast')"

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
export function catalogEntries(): string[] {
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
