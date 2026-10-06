// The guards both scripts run before they drop the views schema: they refuse a schema hyde-db did
// not create (D11, D58), and objects outside it that its drop would take along (D141).
import { BRAND, SCHEMA_MARKER } from '../brand.ts'
import { quoteLiteral } from '../sql.ts'
import type { ResolvedConfig } from '../types.ts'

/**
 * A DO block that aborts when the views schema exists but its comment is neither the marker
 * nor the marker followed by `.` (D11, D58), so a look-alike such as `hyde-dbx` is refused.
 */
export function renderSchemaGuard(config: Pick<ResolvedConfig, 'schema'>): string {
  const message =
    `${BRAND}: schema ${config.schema} exists but was not created by ${BRAND} ` +
    `(its comment lacks the "${SCHEMA_MARKER}" marker); refusing to drop it. ` +
    'Rename or drop that schema yourself, or set the generator config "schema" to an unused name.'
  const comment = "coalesce(obj_description(oid, 'pg_namespace'), '')"
  return [
    `-- Refuse to drop a schema that ${BRAND} did not create.`,
    'DO $$ BEGIN',
    `  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = ${quoteLiteral(config.schema)}`,
    `             AND NOT (${comment} = ${quoteLiteral(SCHEMA_MARKER)}`,
    `                      OR starts_with(${comment}, ${quoteLiteral(`${SCHEMA_MARKER}.`)}))) THEN`,
    `    RAISE EXCEPTION ${quoteLiteral(message)};`,
    '  END IF;',
    'END $$;',
  ].join('\n')
}

/**
 * A DO block that aborts, naming them, when objects outside the views schema depend on a relation
 * or type in it: `DROP SCHEMA … CASCADE` would drop them silently (A97, D141). A view's rule is
 * named as the view; rules, triggers, policies and column defaults count in the schema of their
 * relation. Temporary objects, and objects that depend on one, go with the session anyway and are
 * left to the drop, so a reader's own cannot block a deploy.
 */
export function renderDependentsGuard(config: Pick<ResolvedConfig, 'schema'>): string {
  const schema = quoteLiteral(config.schema)
  const message =
    `${BRAND}: objects outside schema ${config.schema} depend on its views: %; refusing to drop them with the schema. ` +
    'Drop them before the deploy, and create them again after it if you still need them.'
  const temporary = "'^pg_(toast_)?temp_'"
  const named = 'format(\'%s %s\', i.type, i.identity) COLLATE "C"'
  return [
    `-- Refuse to drop objects outside schema ${config.schema} that depend on its views.`,
    'DO $$',
    'DECLARE',
    '  dependents text;',
    'BEGIN',
    `  SELECT string_agg(DISTINCT ${named}, ', ' ORDER BY ${named}) INTO dependents`,
    '  FROM pg_namespace s',
    '    JOIN pg_depend d',
    "      ON d.refclassid = 'pg_class'::regclass AND d.refobjid IN (SELECT c.oid FROM pg_class c WHERE c.relnamespace = s.oid)",
    "      OR d.refclassid = 'pg_type'::regclass AND d.refobjid IN (SELECT t.oid FROM pg_type t WHERE t.typnamespace = s.oid)",
    "    LEFT JOIN pg_rewrite w ON d.classid = 'pg_rewrite'::regclass AND w.oid = d.objid",
    "    LEFT JOIN pg_trigger tg ON d.classid = 'pg_trigger'::regclass AND tg.oid = d.objid",
    "    LEFT JOIN pg_policy po ON d.classid = 'pg_policy'::regclass AND po.oid = d.objid",
    "    LEFT JOIN pg_attrdef ad ON d.classid = 'pg_attrdef'::regclass AND ad.oid = d.objid",
    "    CROSS JOIN LATERAL pg_identify_object(CASE WHEN w.oid IS NULL THEN d.classid ELSE 'pg_class'::regclass END, coalesce(w.ev_class, d.objid), CASE WHEN w.oid IS NULL THEN d.objsubid ELSE 0 END) i",
    '    CROSS JOIN LATERAL (SELECT coalesce((SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace',
    '      WHERE c.oid = coalesce(w.ev_class, tg.tgrelid, po.polrelid, ad.adrelid)), i.schema) AS schema) h',
    `  WHERE s.nspname = ${schema}`,
    "    AND d.deptype IN ('n', 'a')",
    `    AND h.schema IS DISTINCT FROM ${schema}`,
    `    AND coalesce(h.schema, '') !~ ${temporary}`,
    `    AND NOT EXISTS (SELECT 1 FROM pg_depend o CROSS JOIN LATERAL pg_identify_object(o.refclassid, o.refobjid, 0) oi WHERE o.classid = d.classid AND o.objid = d.objid AND oi.schema ~ ${temporary});`,
    '  IF dependents IS NOT NULL THEN',
    `    RAISE EXCEPTION ${quoteLiteral(message)}, dependents;`,
    '  END IF;',
    'END $$;',
  ].join('\n')
}
