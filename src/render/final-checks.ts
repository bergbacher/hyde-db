// The final safety check of redacted-views.sql as an ordered list of check records, one per README
// refusal-table row 2 to 15 (D143). Each record renders the `IF leaks ... END IF` block of one way
// the reader role could reach data outside the views; the order is the order of the aborts (D49,
// D69, D81, D127, D130, D134). Moved verbatim out of apply-sql.ts: the emitted SQL is unchanged.
import { BRAND } from '../brand.ts'
import { quoteLiteral as ql } from '../sql.ts'
import type { PostgresqlConfig, ResolvedConfig } from '../types.ts'
import {
  COLUMN_PRIVILEGES,
  catalogEntries,
  DEFAULT_ACL_KIND,
  heldAttributes,
  heldFromLender,
  lender,
  lending,
  ownOption,
  PARAMETER_OWNER,
  PARAMETER_PRIVILEGES,
  PUBLIC_DEFAULT_KINDS,
  printedFix,
  RELATION,
  ROUTINE,
  revokeFix,
  runAs,
  SEQUENCE_PRIVILEGES,
  TABLE_PRIVILEGES,
} from './acl-helpers.ts'

export interface CheckContext {
  readonly config: PostgresqlConfig
  /** The reader role as a SQL literal. */
  readonly role: string
  readonly abort: (message: string, ...values: string[]) => string
  /** An abort whose fix revokes as the owners of the objects found, which the deployer may not be. */
  readonly ownersAbort: (message: string) => string
}

export interface FinalCheck {
  /** The README refusal-table row this check implements, 2 to 15. */
  readonly row: number
  readonly id: string
  render(ctx: CheckContext): string[]
}

export const FINAL_CHECKS: readonly FinalCheck[] = [
  {
    row: 2,
    id: 'role-attributes',
    render: ({ config, role, abort }) => {
      return [
        `  SELECT ${heldAttributes(', ', '')},`,
        `         format('ALTER ROLE %I %s;', r.rolname, ${heldAttributes(' ', 'NO')})`,
        '    INTO leaks, fixes',
        '  FROM pg_roles r',
        `  WHERE r.rolname = ${role};`,
        "  IF leaks <> '' THEN",
        abort(`role ${config.role} has attributes it must not have: %. Fix: %`, 'leaks', 'fixes'),
        '  END IF;',
      ]
    },
  },
  {
    row: 3,
    id: 'ownership',
    render: ({ config, role, abort }) => {
      return [
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
      ]
    },
  },
  {
    row: 4,
    id: 'memberships',
    render: ({ config, role, abort }) => {
      // PostgreSQL 16+ keeps one membership per grantor and REVOKE removes only the one it names (A54);
      // earlier servers keep one per group, which a plain REVOKE removes whatever its grantor.
      const grantedBy =
        "CASE WHEN current_setting('server_version_num')::int >= 160000 THEN format(' GRANTED BY %s', m.grantor::regrole) END"
      return [
        "  SELECT string_agg(format('%I', g.rolname), ', ' ORDER BY g.rolname),",
        `         string_agg((SELECT string_agg(format('REVOKE %I FROM %I%s CASCADE;', g.rolname, r.rolname, ${grantedBy}), ' ' ORDER BY m.grantor) FROM pg_auth_members m WHERE m.roleid = g.oid AND m.member = r.oid), ' ' ORDER BY g.rolname)`,
        '    INTO leaks, fixes',
        '  FROM pg_roles g CROSS JOIN pg_roles r',
        `  WHERE r.rolname = ${role}`,
        '    AND EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = g.oid AND m.member = r.oid);',
        '  IF leaks IS NOT NULL THEN',
        abort(
          `role ${config.role} must not be a member of other roles: %. Fix: %`,
          'leaks',
          'fixes',
        ),
        '  END IF;',
      ]
    },
  },
  {
    row: 5,
    id: 'schema-creation',
    render: ({ config, role, ownersAbort }) => {
      return [
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
      ]
    },
  },
  {
    row: 6,
    id: 'catalog-privileges',
    render: ({ config, role, ownersAbort }) => {
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
      return [
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
      ]
    },
  },
  {
    row: 7,
    id: 'relations',
    render: ({ config, role, ownersAbort }) => {
      const relation = RELATION
      return [
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
      ]
    },
  },
  {
    row: 8,
    id: 'foreign-servers',
    render: ({ config, role, ownersAbort }) => {
      return [
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
      ]
    },
  },
  {
    row: 9,
    id: 'security-definer',
    render: ({ config, role, ownersAbort }) => {
      const routine = ROUTINE
      return [
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
      ]
    },
  },
  {
    row: 10,
    id: 'sequences',
    render: ({ config, role, ownersAbort }) => {
      const relation = RELATION
      return [
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
      ]
    },
  },
  {
    row: 11,
    id: 'default-privileges',
    render: ({ config, role, abort }) => {
      const inSchema = (keyword: string): string =>
        `CASE WHEN d.defaclnamespace <> 0 THEN format(' ${keyword} %I', dn.nspname) END`
      const defaultsOrder = 'ORDER BY o.rolname, dn.nspname NULLS FIRST, d.defaclobjtype'
      return [
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
      ]
    },
  },
  {
    row: 12,
    id: 'create-in-schemas',
    render: ({ config, role, ownersAbort }) => {
      return [
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
      ]
    },
  },
  {
    row: 13,
    id: 'lo-compat-privileges',
    render: ({ config, role, abort }) => {
      // Settings in pg_db_role_setting that reach the reader's sessions in this database.
      const readerSetting = (alias: string): string =>
        `${alias}.setrole IN (0, r.oid) AND ${alias}.setdatabase IN (0, (SELECT d.oid FROM pg_database d WHERE d.datname = current_database()))`
      // Where a pg_db_role_setting row applies: to all roles, the reader's role, the database, or the
      // reader's role in the database; as text for the abort and as the target of ALTER … RESET.
      const settingScope = (all: string, role: string, database: string, both: string): string =>
        `CASE WHEN s.setdatabase = 0 AND s.setrole = 0 THEN ${all} WHEN s.setdatabase = 0 THEN ${role} WHEN s.setrole = 0 THEN ${database} ELSE ${both} END`
      return [
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
      ]
    },
  },
  {
    row: 14,
    id: 'large-object-acls',
    render: ({ config, role, ownersAbort }) => {
      return [
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
      ]
    },
  },
  {
    row: 15,
    id: 'parameters',
    render: ({ config, role, abort }) => {
      return [
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
      ]
    },
  },
]

/** The context every check renders with, built from the resolved configuration. */
export function checkContext(config: ResolvedConfig): CheckContext {
  const role = ql(config.role)
  const abort = (message: string, ...values: string[]): string =>
    `    RAISE EXCEPTION '${BRAND}: ${message}', ${values.map((v) => (v === 'fixes' ? printedFix(v) : v)).join(', ')};`
  // An abort whose fix revokes as the owners of the objects found, which the deployer may not be.
  const ownersAbort = (message: string): string =>
    `    RAISE EXCEPTION '${BRAND}: ${message}', leaks, ${printedFix('fixes', false, 'runner')};`
  return { config, role, abort, ownersAbort }
}

/** The final safety check: every way the role could reach data outside the views aborts the script. */
export function renderFinalCheck(config: ResolvedConfig): string[] {
  const ctx = checkContext(config)
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
    ...FINAL_CHECKS.flatMap((check) => check.render(ctx)),
    'END $$;',
  ]
}
