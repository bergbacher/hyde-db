// PostgreSQL-specific analysis rules and the PostgreSQL Dialect (D104, D114).
import { validateConfig } from '../config.ts'
import type { Model } from '../datamodel.ts'
import { modelInViewsSchema, schemaEqualsSource } from '../diagnostics.ts'
import { renderApplySql } from '../render/apply-sql.ts'
import { renderDropSql } from '../render/drop-sql.ts'
import { renderMarkdown } from '../render/markdown.ts'
import type { Diagnostic, PostgresqlConfig } from '../types.ts'
import type { Dialect } from './index.ts'

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

export const postgresqlDialect: Dialect<PostgresqlConfig> = {
  provider: 'postgresql',
  validate: (raw) => validateConfig(raw, 'postgresql'),
  configRules: postgresqlConfigRules,
  viewRules: () => [],
  sourceSchemaOf: (model, config) => model.schema ?? config.sourceSchema,
  render: { apply: renderApplySql, drop: renderDropSql, markdown: renderMarkdown },
}
