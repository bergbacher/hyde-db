// Analysis rules: decide which columns of which models become views, and collect every
// diagnostic (D29) plus the visible/hidden column counts (D48).
import { readFieldAnnotations, readModelAnnotations } from './annotations.ts'
import { type Model, toDatamodel } from './datamodel.ts'
import {
  relationAnnotated,
  sensitiveExplicit,
  sensitiveImplicit,
  strictModelDefault,
  strictUnannotated,
  unsupportedProvider,
  viewNameCollision,
} from './diagnostics.ts'
import { type Dialect, dialectFor } from './dialects/index.ts'
import { isSensitiveName } from './sensitive.ts'
import type {
  Analysis,
  BuildOptions,
  Diagnostic,
  DmmfDatamodel,
  GeneratorConfig,
  ResolvedConfig,
  View,
  ViewColumn,
  ViewRelation,
  Visibility,
} from './types.ts'

function relationsOf(
  model: Model,
  columns: readonly ViewColumn[],
  modelsByName: ReadonlyMap<string, Model>,
): ViewRelation[] {
  const relations: ViewRelation[] = []
  for (const field of model.fields) {
    if (field.kind !== 'object' || field.relationFromFields.length === 0) continue
    const target = modelsByName.get(field.type)
    if (target === undefined) continue
    const fromCols = field.relationFromFields.map(
      (name) => model.fields.find((f) => f.name === name)?.column ?? name,
    )
    if (!fromCols.every((c) => columns.some((col) => col.column === c))) continue
    const toCols = field.relationToFields.map(
      (name) => target.fields.find((f) => f.name === name)?.column ?? name,
    )
    relations.push({ fromCols, target: target.table, targetModel: target.name, toCols })
  }
  return relations
}

function analyzeModel(
  model: Model,
  config: ResolvedConfig,
  sourceSchema: string | null,
  modelsByName: ReadonlyMap<string, Model>,
  diagnostics: Diagnostic[],
): View | undefined {
  const annotations = readModelAnnotations(model)
  diagnostics.push(...annotations.diagnostics)
  let modelDefault: Visibility = config.default
  let modelDefaultExplicit = false
  for (const value of annotations.defaults) {
    if (config.strict) diagnostics.push(strictModelDefault(model.name))
    else {
      modelDefault = value
      modelDefaultExplicit = true
    }
  }
  if (annotations.excluded) return undefined

  const columns: ViewColumn[] = []
  for (const field of model.fields) {
    const location = `${model.name}.${field.name}`
    const fieldAnnotations = readFieldAnnotations(model.name, field)
    diagnostics.push(...fieldAnnotations.diagnostics)
    const explicit = fieldAnnotations.visibility

    if (field.kind === 'object') {
      if (explicit !== undefined) diagnostics.push(relationAnnotated(location))
      continue
    }
    if (field.kind === 'other') continue

    let visibility = explicit
    if (visibility === undefined) {
      if (config.strict) {
        diagnostics.push(strictUnannotated(location))
        continue
      }
      visibility = modelDefault
    }
    if (visibility !== 'visible') continue

    const sensitive = isSensitiveName(field.name) || isSensitiveName(field.column)
    if (sensitive && explicit === undefined) {
      diagnostics.push(sensitiveImplicit(location, modelDefaultExplicit ? 'model' : 'global'))
      continue
    }
    if (sensitive) diagnostics.push(sensitiveExplicit(location))

    columns.push({
      column: field.column,
      field: field.name,
      type:
        (field.kind === 'enum' ? `enum ${field.type}` : field.type) + (field.isList ? '[]' : ''),
      nullable: !field.isRequired,
      isId: field.isId,
      doc: fieldAnnotations.text,
    })
  }
  if (columns.length === 0) return undefined

  return {
    model: model.name,
    name: model.table,
    sourceSchema,
    source: model.table,
    columns,
    relations: relationsOf(model, columns, modelsByName),
    doc: annotations.text,
  }
}

/** View names share one schema; with multiSchema two tables could collide. */
export function viewCollisions(views: readonly View[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const seen = new Map<string, string>()
  for (const view of views) {
    const where = view.sourceSchema === null ? view.source : `${view.sourceSchema}.${view.source}`
    const first = seen.get(view.name)
    if (first !== undefined) diagnostics.push(viewNameCollision(view.name, first, where))
    seen.set(view.name, where)
  }
  return diagnostics
}

function analyzeWith<C extends ResolvedConfig>(
  dialect: Dialect<C>,
  datamodel: DmmfDatamodel,
  rawConfig: GeneratorConfig | undefined,
  leading: readonly Diagnostic[],
): Analysis & { config: C } {
  const { models } = toDatamodel(datamodel)
  const { config, diagnostics: configDiagnostics } = dialect.validate(rawConfig)
  const diagnostics: Diagnostic[] = [...leading, ...configDiagnostics]

  diagnostics.push(...dialect.configRules(config, models))

  const modelsByName = new Map(models.map((m) => [m.name, m]))
  const candidates: View[] = []
  let columnTotal = 0
  for (const model of models) {
    columnTotal += model.fields.filter((f) => f.kind === 'scalar' || f.kind === 'enum').length
    const view = analyzeModel(
      model,
      config,
      dialect.sourceSchemaOf(model, config),
      modelsByName,
      diagnostics,
    )
    if (view !== undefined) candidates.push(view)
  }

  diagnostics.push(...viewCollisions(candidates), ...dialect.viewRules(config, candidates))

  // A join is worth describing only when the reader can write it: the target has a view, and that
  // view shows every target column, each paired with a source column (D146).
  const shown = new Map(candidates.map((v) => [v.name, new Set(v.columns.map((c) => c.column))]))
  const views = candidates.map((v) => ({
    ...v,
    relations: v.relations.filter((r) => {
      const target = shown.get(r.target)
      return (
        target !== undefined &&
        r.toCols.length === r.fromCols.length &&
        r.toCols.every((column) => target.has(column))
      )
    }),
  }))
  const visible = views.reduce((n, v) => n + v.columns.length, 0)
  return { config, views, diagnostics, counts: { visible, hidden: columnTotal - visible } }
}

/**
 * The provider is `postgresql` when omitted (D107). One that is not registered is a diagnostic,
 * never a throw (D142); the analysis then runs with the PostgreSQL defaults so the counts stay meaningful.
 */
export function analyze(
  datamodel: DmmfDatamodel,
  rawConfig?: GeneratorConfig,
  options: BuildOptions = {},
): Analysis {
  // The provider is read defensively: options and provider come from JavaScript callers (D142, D159).
  let provider: unknown
  try {
    provider = options?.provider ?? 'postgresql'
  } catch {
    provider = undefined
  }
  const dialect = typeof provider === 'string' ? dialectFor(provider) : undefined
  if (dialect !== undefined) return analyzeWith(dialect, datamodel, rawConfig, [])
  // 'postgresql' is always registered, so the fallback is defined.
  return analyzeWith(dialectFor('postgresql') as Dialect, datamodel, rawConfig, [
    unsupportedProvider(provider),
  ])
}
