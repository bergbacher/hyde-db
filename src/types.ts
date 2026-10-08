// Public types of hyde-db (D9). Everything else in src/ is internal.

/** One field of Prisma's DMMF datamodel, as `prisma generate` passes it (D47). Extra properties are allowed. */
export interface DmmfField {
  readonly name: string
  readonly kind: string
  readonly type: string
  readonly dbName?: string | null
  readonly isList?: boolean
  readonly isRequired?: boolean
  readonly isId?: boolean
  readonly documentation?: string
  readonly relationFromFields?: readonly string[]
  readonly relationToFields?: readonly string[]
}

/** One model (or `view` block, D34) of Prisma's DMMF datamodel. */
export interface DmmfModel {
  readonly name: string
  readonly dbName?: string | null
  readonly schema?: string | null
  readonly documentation?: string
  readonly fields: readonly DmmfField[]
}

/** Prisma's DMMF datamodel (`options.dmmf.datamodel`). */
export interface DmmfDatamodel {
  readonly models: readonly DmmfModel[]
}

/** The generator block's config as Prisma passes it: strings or (nested) string arrays (A22). */
export type GeneratorConfig = Readonly<Record<string, unknown>>

export type Visibility = 'visible' | 'hidden'

/** The resolved config of a PostgreSQL database. `dialect` is set by the package, never by the generator block. */
export interface PostgresqlConfig {
  readonly dialect: 'postgresql'
  readonly schema: string
  readonly role: string
  readonly sourceSchema: string
  readonly default: Visibility
  readonly strict: boolean
  readonly statementTimeout: string
}

/** The databases hyde-db can target (D86, D104). */
export type Provider = 'postgresql' | 'mysql'

/** The resolved config of a MySQL database: `role` is the account's user name, `readerHost` its host part (D97, D120). */
export interface MysqlConfig {
  readonly dialect: 'mysql'
  readonly schema: string
  readonly role: string
  readonly readerHost: string
  readonly default: Visibility
  readonly strict: boolean
}

/**
 * The resolved config, a union discriminated on `dialect`. The union may gain members in minor
 * releases, so switch on `dialect` instead of assuming one shape.
 */
export type ResolvedConfig = PostgresqlConfig | MysqlConfig

/** The optional third argument of `build` and `analyze`: the datasource provider, `postgresql` when omitted (D107). */
export interface BuildOptions {
  readonly provider?: Provider
}

export type Severity = 'error' | 'warning'

export type DiagnosticCode =
  | 'HYDE_CONFIG_UNKNOWN_KEY'
  | 'HYDE_CONFIG_INVALID_VALUE'
  | 'HYDE_CONFIG_KEY_UNSUPPORTED'
  | 'HYDE_SCHEMA_CONFLICT'
  | 'HYDE_ANNOTATION_UNKNOWN'
  | 'HYDE_ANNOTATION_MISPLACED'
  | 'HYDE_ANNOTATION_INVALID_ARGUMENT'
  | 'HYDE_ANNOTATION_CONFLICT'
  | 'HYDE_STRICT_UNANNOTATED'
  | 'HYDE_STRICT_MODEL_DEFAULT'
  | 'HYDE_SENSITIVE_IMPLICIT'
  | 'HYDE_VIEW_NAME_COLLISION'
  | 'HYDE_UNSUPPORTED_PROVIDER'
  | 'HYDE_NO_OUTPUT'
  | 'HYDE_RELATION_ANNOTATED'
  | 'HYDE_SENSITIVE_EXPLICIT'
  | 'HYDE_TIMEOUT_DISABLED'
  | 'HYDE_LEGACY_ANNOTATION'

/** A structured problem report (D51). Errors always carry a fix hint (D26). */
export interface Diagnostic {
  readonly code: DiagnosticCode
  readonly severity: Severity
  readonly location: string
  readonly message: string
  readonly hint?: string
}

export interface ViewColumn {
  readonly column: string
  readonly field: string
  readonly type: string
  readonly nullable: boolean
  readonly isId: boolean
  readonly doc: string
}

export interface ViewRelation {
  readonly fromCols: readonly string[]
  readonly target: string
  readonly targetModel: string
  readonly toCols: readonly string[]
}

export interface View {
  readonly model: string
  readonly name: string
  /** The schema the view reads from: never `null` on PostgreSQL, `null` where the database has no schemas. */
  readonly sourceSchema: string | null
  readonly source: string
  readonly columns: readonly ViewColumn[]
  readonly relations: readonly ViewRelation[]
  readonly doc: string
}

/** Scalar and enum columns exposed vs. withheld across the whole datamodel (D48). */
export interface ColumnCounts {
  readonly visible: number
  readonly hidden: number
}

export interface Analysis {
  readonly config: ResolvedConfig
  readonly views: readonly View[]
  readonly diagnostics: readonly Diagnostic[]
  readonly counts: ColumnCounts
}

export interface OutputFiles {
  readonly 'redacted-views.sql': string
  readonly 'redacted-views-drop.sql': string
  readonly 'redacted-schema.md': string
}

export interface BuildResult extends Analysis {
  /** `null` when any diagnostic is an error. */
  readonly files: OutputFiles | null
}
