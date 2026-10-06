// PostgreSQL-specific analysis rules (D114 prep). The place a Dialect will hang from in 1.1.0.
import type { Model } from '../datamodel.ts'
import { modelInViewsSchema, schemaEqualsSource } from '../diagnostics.ts'
import type { Diagnostic, PostgresqlConfig } from '../types.ts'

/** D12: the views schema must differ from `sourceSchema` and from every model's `@@schema` (A13). */
export function postgresqlConfigRules(
  config: PostgresqlConfig,
  models: readonly Model[],
): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  if (config.schema === config.sourceSchema) diagnostics.push(schemaEqualsSource(config.schema))
  for (const model of models) {
    if (model.schema === config.schema)
      diagnostics.push(modelInViewsSchema(model.name, config.schema))
  }
  return diagnostics
}
