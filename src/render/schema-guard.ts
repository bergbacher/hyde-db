import { BRAND, SCHEMA_MARKER } from '../brand.ts'
import { quoteLiteral } from '../sql.ts'
import type { ResolvedConfig } from '../types.ts'

/**
 * A DO block that aborts when the AI schema exists but its comment is neither the marker
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
