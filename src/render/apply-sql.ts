// Renders redacted-views.sql: one transaction that recreates the views schema with column-filtered
// views, grants the reader role SELECT on exactly those views, and aborts with a pasteable fix if
// the role could reach anything else (D11, D13, D24, D49, D70, D71, D72); it revokes nothing
// itself (D69).
import { BRAND, SCHEMA_MARKER } from '../brand.ts'
import { quoteIdent as qi, quoteLiteral as ql } from '../sql.ts'
import type { ResolvedConfig, View } from '../types.ts'
import { renderSchemaGuard } from './schema-guard.ts'

export interface RenderInput {
  readonly config: ResolvedConfig
  readonly views: readonly View[]
}

/**
 * SQL listing who must lose a privilege: PUBLIC when it holds it, and the reader role when it owns
 * the object (an owner holds its privileges with no ACL entry) or holds it directly. The role may
 * not exist yet when the fix is run (a failed first apply rolls back its creation), so it is only
 * named when it owns the object or has a direct grant.
 */
function grantees(
  publicHolds: string,
  owner: string,
  acl: string,
  privileges: readonly string[],
): string {
  const list = privileges.map((p) => `'${p}'`).join(', ')
  return (
    `concat_ws(', ', CASE WHEN ${publicHolds} THEN 'PUBLIC' END, ` +
    `CASE WHEN r.oid = ${owner} OR EXISTS (SELECT 1 FROM aclexplode(${acl}) a WHERE a.grantee = r.oid AND a.privilege_type IN (${list})) ` +
    'THEN quote_ident(r.rolname) END)'
  )
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

/** The relation's user columns (no system or dropped ones) as `att`, for a FROM clause. */
const COLUMNS =
  'pg_attribute att WHERE att.attrelid = c.oid AND att.attnum > 0 AND NOT att.attisdropped'

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

/** The privileges a column grant can carry. */
const COLUMN_PRIVILEGES = 'SELECT, INSERT, UPDATE, REFERENCES'

/** Schemas no check looks into: the catalogs, and pg_toast and pg_temp_N (the role's own temporary objects). */
const NOT_SYSTEM =
  "n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'"

/** The ALTER DEFAULT PRIVILEGES keyword of a pg_default_acl object type; LARGE OBJECTS exist from PostgreSQL 18. */
const DEFAULT_ACL_KIND =
  "CASE d.defaclobjtype WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES' WHEN 'f' THEN 'FUNCTIONS' " +
  "WHEN 'T' THEN 'TYPES' WHEN 'n' THEN 'SCHEMAS' WHEN 'L' THEN 'LARGE OBJECTS' END"

/** The final safety check: every way the role could reach data outside the views aborts the script. */
function renderFinalCheck(config: ResolvedConfig): string[] {
  const role = ql(config.role)
  const routine =
    "format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))"
  const relation = "format('%I.%I', n.nspname, c.relname)"
  const tablePrivileges = TABLE_PRIVILEGES.join(', ')
  // REVOKE ALL also clears the grantees' column grants, and CASCADE what the role passed on with
  // GRANT OPTION (A54), so one statement per relation removes everything that makes it readable.
  const relationGrantees = grantees(
    `(has_table_privilege('public', c.oid, '${tablePrivileges}') OR has_any_column_privilege('public', c.oid, '${COLUMN_PRIVILEGES}'))`,
    'c.relowner',
    `c.relacl || ARRAY(SELECT unnest(att.attacl) FROM ${COLUMNS})`,
    TABLE_PRIVILEGES,
  )
  // PostgreSQL 16+ keeps one membership per grantor and REVOKE removes only the one it names (A54);
  // earlier servers keep one per group, which a plain REVOKE removes whatever its grantor.
  const grantedBy =
    "CASE WHEN current_setting('server_version_num')::int >= 160000 THEN format(' GRANTED BY %s', m.grantor::regrole) END"
  const inSchema = (keyword: string): string =>
    `CASE WHEN d.defaclnamespace <> 0 THEN format(' ${keyword} %I', dn.nspname) END`
  const defaultsOrder = 'ORDER BY o.rolname, dn.nspname NULLS FIRST, d.defaclobjtype'
  return [
    '-- Safety check: abort if the role has SUPERUSER, CREATEDB, CREATEROLE, REPLICATION or',
    '-- BYPASSRLS, owns the database or any schema, relation or function in it, is a member of',
    '-- another role, holds any privilege on a relation outside the views schema, can execute a',
    '-- SECURITY DEFINER function, use a sequence or create objects in any schema, or would gain',
    '-- privileges on objects created later through default privileges. Each abort prints the',
    '-- statements that fix it.',
    'DO $$',
    'DECLARE',
    '  leaks text;',
    '  fixes text;',
    'BEGIN',
    '  -- Attributes first: the privilege tests below cannot see them, and would misreport a superuser.',
    `  SELECT ${heldAttributes(', ', '')},`,
    `         format('ALTER ROLE %I %s;', r.rolname, ${heldAttributes(' ', 'NO')})`,
    '    INTO leaks, fixes',
    '  FROM pg_roles r',
    `  WHERE r.rolname = ${role};`,
    "  IF leaks <> '' THEN",
    `    RAISE EXCEPTION '${BRAND}: role ${config.role} has attributes it must not have: %. Fix: %', leaks, fixes;`,
    '  END IF;',
    '  -- The joins on pg_roles below always find the role: this transaction created it above if missing.',
    '  -- Ownership next: an owner can grant itself access again after any REVOKE, so no REVOKE fixes it.',
    '  SELECT string_agg(owned.name, \', \' ORDER BY owned.kind, owned.name COLLATE "C") INTO leaks',
    '  FROM pg_roles r CROSS JOIN LATERAL (',
    "    SELECT 1, format('database %I', d.datname) FROM pg_database d WHERE d.datname = current_database() AND d.datdba = r.oid",
    `    UNION ALL SELECT 2, format('schema %I', n.nspname) FROM pg_namespace n WHERE n.nspowner = r.oid AND ${NOT_SYSTEM}`,
    "    UNION ALL SELECT 3, format('relation %I.%I', n.nspname, c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace",
    `      WHERE c.relowner = r.oid AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S') AND ${NOT_SYSTEM}`,
    "    UNION ALL SELECT 4, format('function %s', " +
      routine +
      ') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace',
    `      WHERE p.proowner = r.oid AND ${NOT_SYSTEM}`,
    '  ) owned (kind, name)',
    `  WHERE r.rolname = ${role};`,
    '  IF leaks IS NOT NULL THEN',
    `    RAISE EXCEPTION '${BRAND}: role ${config.role} owns objects it must not own: %. Fix: REASSIGN OWNED BY % TO CURRENT_USER;', leaks, quote_ident(${role});`,
    '  END IF;',
    '  -- Membership next: what the role reads through another role has no grant of its own to revoke.',
    "  SELECT string_agg(format('%I', g.rolname), ', ' ORDER BY g.rolname),",
    `         string_agg((SELECT string_agg(format('REVOKE %I FROM %I%s;', g.rolname, r.rolname, ${grantedBy}), ' ' ORDER BY m.grantor) FROM pg_auth_members m WHERE m.roleid = g.oid AND m.member = r.oid), ' ' ORDER BY g.rolname)`,
    '    INTO leaks, fixes',
    '  FROM pg_roles g CROSS JOIN pg_roles r',
    `  WHERE r.rolname = ${role}`,
    '    AND EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = g.oid AND m.member = r.oid);',
    '  IF leaks IS NOT NULL THEN',
    `    RAISE EXCEPTION '${BRAND}: role ${config.role} must not be a member of other roles: %. Fix: %', leaks, fixes;`,
    '  END IF;',
    `  SELECT string_agg(${relation}, ', ' ORDER BY n.nspname, c.relname),`,
    `         string_agg(format('REVOKE ALL ON %s FROM %s CASCADE;', ${relation}, ${relationGrantees}), ' ' ORDER BY n.nspname, c.relname)`,
    '    INTO leaks, fixes',
    '  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN pg_roles r',
    `  WHERE r.rolname = ${role}`,
    `    AND c.relkind IN ('r', 'p', 'v', 'm', 'f')`,
    `    AND n.nspname NOT IN (${ql(config.schema)}, 'pg_catalog', 'information_schema')`,
    `    AND n.nspname NOT LIKE 'pg\\_%'`,
    `    AND (has_table_privilege(r.oid, c.oid, '${tablePrivileges}')`,
    `         OR has_any_column_privilege(r.oid, c.oid, '${COLUMN_PRIVILEGES}'));`,
    '  IF leaks IS NOT NULL THEN',
    `    RAISE EXCEPTION '${BRAND}: role ${config.role} can read relations outside schema ${config.schema}: %. Fix: %', leaks, fixes;`,
    '  END IF;',
    `  SELECT string_agg(${routine}, ', ' ORDER BY n.nspname, p.proname),`,
    `         string_agg(format('REVOKE EXECUTE ON ROUTINE %s FROM %s;', ${routine}, ${grantees("has_function_privilege('public', p.oid, 'EXECUTE')", 'p.proowner', 'p.proacl', ['EXECUTE'])}), ' ' ORDER BY n.nspname, p.proname)`,
    '    INTO leaks, fixes',
    '  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace CROSS JOIN pg_roles r',
    `  WHERE r.rolname = ${role}`,
    '    AND p.prosecdef',
    `    AND n.nspname NOT IN ('pg_catalog', 'information_schema')`,
    `    AND n.nspname NOT LIKE 'pg\\_%'`,
    "    AND has_schema_privilege(r.oid, n.oid, 'USAGE')",
    "    AND has_function_privilege(r.oid, p.oid, 'EXECUTE');",
    '  IF leaks IS NOT NULL THEN',
    `    RAISE EXCEPTION '${BRAND}: role ${config.role} can execute SECURITY DEFINER functions: %. Fix: %', leaks, fixes;`,
    '  END IF;',
    `  SELECT string_agg(${relation}, ', ' ORDER BY n.nspname, c.relname),`,
    `         string_agg(format('REVOKE ALL ON SEQUENCE %s FROM %s;', ${relation}, ${grantees("has_sequence_privilege('public', c.oid, 'SELECT, USAGE, UPDATE')", 'c.relowner', 'c.relacl', ['SELECT', 'USAGE', 'UPDATE'])}), ' ' ORDER BY n.nspname, c.relname)`,
    '    INTO leaks, fixes',
    '  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN pg_roles r',
    `  WHERE r.rolname = ${role}`,
    `    AND c.relkind = 'S'`,
    "    AND CASE WHEN c.relkind = 'S' THEN has_sequence_privilege(r.oid, c.oid, 'SELECT, USAGE, UPDATE') ELSE false END;",
    '  IF leaks IS NOT NULL THEN',
    `    RAISE EXCEPTION '${BRAND}: role ${config.role} can read sequences: %. Fix: %', leaks, fixes;`,
    '  END IF;',
    "  SELECT string_agg(format('%I', n.nspname), ', ' ORDER BY n.nspname),",
    `         string_agg(format('REVOKE CREATE ON SCHEMA %I FROM %s;', n.nspname, ${grantees("has_schema_privilege('public', n.oid, 'CREATE')", 'n.nspowner', 'n.nspacl', ['CREATE'])}), ' ' ORDER BY n.nspname)`,
    '    INTO leaks, fixes',
    '  FROM pg_namespace n CROSS JOIN pg_roles r',
    `  WHERE r.rolname = ${role}`,
    // The applying session's own temp schema grants CREATE to every role with TEMP on the
    // database; that is not a leak, and REVOKE on it would do nothing. Other sessions' temp
    // schemas are checked: a CREATE grant on one is real (0 when this session has none).
    '    AND n.oid <> pg_my_temp_schema()',
    "    AND has_schema_privilege(r.oid, n.oid, 'CREATE');",
    '  IF leaks IS NOT NULL THEN',
    `    RAISE EXCEPTION '${BRAND}: role ${config.role} can create objects in schemas: %. Fix: %', leaks, fixes;`,
    '  END IF;',
    '  -- Default privileges last: they make objects created later readable until the next apply (A53).',
    `  SELECT string_agg(format('%s created by %I%s', lower(${DEFAULT_ACL_KIND}), o.rolname, ${inSchema('in schema')}), ', ' ${defaultsOrder}),`,
    `         string_agg(format('ALTER DEFAULT PRIVILEGES FOR ROLE %I%s REVOKE ALL ON %s FROM %s;', o.rolname, ${inSchema('IN SCHEMA')}, ${DEFAULT_ACL_KIND}, concat_ws(', ', CASE WHEN d.defaclobjtype IN ('r', 'S') AND EXISTS (SELECT 1 FROM aclexplode(d.defaclacl) a WHERE a.grantee = 0) THEN 'PUBLIC' END, CASE WHEN EXISTS (SELECT 1 FROM aclexplode(d.defaclacl) a WHERE a.grantee = r.oid) THEN quote_ident(r.rolname) END)), ' ' ${defaultsOrder})`,
    '    INTO leaks, fixes',
    '  FROM pg_default_acl d JOIN pg_roles o ON o.oid = d.defaclrole',
    '    LEFT JOIN pg_namespace dn ON dn.oid = d.defaclnamespace CROSS JOIN pg_roles r',
    `  WHERE r.rolname = ${role}`,
    '    AND EXISTS (SELECT 1 FROM aclexplode(d.defaclacl) a',
    "                WHERE a.grantee = r.oid OR (a.grantee = 0 AND d.defaclobjtype IN ('r', 'S')));",
    '  IF leaks IS NOT NULL THEN',
    `    RAISE EXCEPTION '${BRAND}: role ${config.role} gets privileges on objects created later (default privileges): %. Fix: %', leaks, fixes;`,
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
    '',
    'DO $$ BEGIN',
    `  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${ql(config.role)}) THEN`,
    `    CREATE ROLE ${R} NOLOGIN;`,
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
