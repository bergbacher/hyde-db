// Renders redacted-views.sql: one transaction that recreates the views schema with column-filtered
// views, grants the reader role SELECT on exactly those views, and aborts with a pasteable fix if
// the role could reach anything else (D11, D13, D24, D49, D65); it revokes nothing itself (D69).
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
 * SQL for the part of a relation-leak fix between `REVOKE SELECT ` and `ON`: '' when the role holds
 * SELECT on the whole relation, else the columns PUBLIC or the role holds SELECT on.
 */
const LEAKED_COLUMNS =
  "CASE WHEN has_table_privilege(r.oid, c.oid, 'SELECT') THEN '' ELSE format('(%s) ', " +
  `(SELECT string_agg(quote_ident(att.attname), ', ' ORDER BY att.attnum) FROM ${COLUMNS} ` +
  "AND EXISTS (SELECT 1 FROM aclexplode(att.attacl) x WHERE x.grantee IN (0, r.oid) AND x.privilege_type = 'SELECT'))) END"

/** The final safety check: every way the role could reach data outside the views aborts the script. */
function renderFinalCheck(config: ResolvedConfig): string[] {
  const role = ql(config.role)
  const routine =
    "format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))"
  const relation = "format('%I.%I', n.nspname, c.relname)"
  // A table-level REVOKE also revokes the grantees' column grants, so one statement per relation
  // removes everything that makes it readable.
  const relationGrantees = grantees(
    "has_any_column_privilege('public', c.oid, 'SELECT')",
    'c.relowner',
    `c.relacl || ARRAY(SELECT unnest(att.attacl) FROM ${COLUMNS})`,
    ['SELECT'],
  )
  return [
    '-- Safety check: abort if the role has SUPERUSER, CREATEDB, CREATEROLE, REPLICATION or',
    '-- BYPASSRLS, is a member of another role, can read any relation outside the views schema',
    '-- (e.g. via PUBLIC, direct or column grants), execute a SECURITY DEFINER function, read a',
    '-- sequence, or create objects in any schema. Each abort prints the statements that fix it.',
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
    '  -- Membership next: what the role reads through another role has no grant of its own to revoke.',
    "  SELECT string_agg(format('%I', g.rolname), ', ' ORDER BY g.rolname),",
    "         string_agg(format('REVOKE %I FROM %I;', g.rolname, r.rolname), ' ' ORDER BY g.rolname)",
    '    INTO leaks, fixes',
    '  FROM pg_roles g CROSS JOIN pg_roles r',
    `  WHERE r.rolname = ${role}`,
    '    AND EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = g.oid AND m.member = r.oid);',
    '  IF leaks IS NOT NULL THEN',
    `    RAISE EXCEPTION '${BRAND}: role ${config.role} must not be a member of other roles: %. Fix: %', leaks, fixes;`,
    '  END IF;',
    `  SELECT string_agg(${relation}, ', ' ORDER BY n.nspname, c.relname),`,
    `         string_agg(format('REVOKE SELECT %sON %s FROM %s;', ${LEAKED_COLUMNS}, ${relation}, ${relationGrantees}), ' ' ORDER BY n.nspname, c.relname)`,
    '    INTO leaks, fixes',
    '  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN pg_roles r',
    `  WHERE r.rolname = ${role}`,
    `    AND c.relkind IN ('r', 'p', 'v', 'm', 'f')`,
    `    AND n.nspname NOT IN (${ql(config.schema)}, 'pg_catalog', 'information_schema')`,
    `    AND n.nspname NOT LIKE 'pg\\_%'`,
    "    AND (has_table_privilege(r.oid, c.oid, 'SELECT')",
    "         OR has_any_column_privilege(r.oid, c.oid, 'SELECT'));",
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
    '-- not revoked here: the final check refuses them and prints the REVOKE that removes them.',
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
