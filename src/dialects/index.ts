// The internal dialect registry (D104, D114): one Dialect per database, looked up by the datasource
// provider. postgresql and mysql are registered here; a provider with no entry is a diagnostic, not a throw (D142).
import type { ConfigResult } from '../config.ts'
import type { Model } from '../datamodel.ts'
import type {
  Analysis,
  Diagnostic,
  GeneratorConfig,
  Provider,
  ResolvedConfig,
  View,
} from '../types.ts'
import { mysqlDialect } from './mysql.ts'
import { postgresqlDialect } from './postgresql.ts'

export interface Dialect<C extends ResolvedConfig = ResolvedConfig> {
  readonly provider: Provider
  validate(raw: GeneratorConfig | null | undefined): ConfigResult<C>
  /** D114: analysis rules of this database that need only config and models (PostgreSQL: D12). */
  configRules(config: C, models: readonly Model[]): Diagnostic[]
  /** D114: rules that need the candidate views (MySQL: marker-name collision). */
  viewRules(config: C, views: readonly View[]): Diagnostic[]
  /** The schema a view reads from; null where the database has no schemas (D113). */
  sourceSchemaOf(model: Model, config: C): string | null
  readonly render: {
    apply(analysis: Analysis & { config: C }): string
    drop(analysis: Analysis & { config: C }): string
    markdown(analysis: Analysis & { config: C }): string
  }
}

/** Each entry is typed with its own config member; `dialectFor` widens it again for generic callers. */
export const DIALECTS: {
  readonly [P in Provider]?: Dialect<Extract<ResolvedConfig, { dialect: P }>>
} = {
  postgresql: postgresqlDialect,
  mysql: mysqlDialect,
}

export function dialectFor(provider: string): Dialect | undefined {
  return Object.hasOwn(DIALECTS, provider)
    ? (DIALECTS[provider as Provider] as unknown as Dialect)
    : undefined
}
