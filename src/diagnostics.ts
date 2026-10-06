// Diagnostics catalog (D51): every problem hyde-db reports has a stable code, a severity,
// a location and a message; every error also carries a fix hint (D26). Unknown names get a
// "did you mean" suggestion when a valid spelling is within edit distance 2 (D25).
import { BRAND } from './brand.ts'
import type { Diagnostic, DiagnosticCode, Severity } from './types.ts'

export const SEVERITY: Readonly<Record<DiagnosticCode, Severity>> = {
  HYDE_CONFIG_UNKNOWN_KEY: 'error',
  HYDE_CONFIG_INVALID_VALUE: 'error',
  HYDE_SCHEMA_CONFLICT: 'error',
  HYDE_ANNOTATION_UNKNOWN: 'error',
  HYDE_ANNOTATION_MISPLACED: 'error',
  HYDE_ANNOTATION_INVALID_ARGUMENT: 'error',
  HYDE_ANNOTATION_CONFLICT: 'error',
  HYDE_STRICT_UNANNOTATED: 'error',
  HYDE_STRICT_MODEL_DEFAULT: 'error',
  HYDE_SENSITIVE_IMPLICIT: 'error',
  HYDE_VIEW_NAME_COLLISION: 'error',
  HYDE_UNSUPPORTED_PROVIDER: 'error',
  HYDE_NO_OUTPUT: 'error',
  HYDE_RELATION_ANNOTATED: 'warning',
  HYDE_SENSITIVE_EXPLICIT: 'warning',
}

export const DIAGNOSTIC_CODES: readonly DiagnosticCode[] = Object.keys(SEVERITY) as DiagnosticCode[]

/** Rows of the distance table are filled before they are read, so every index is in range. */
const cell = (row: readonly number[], index: number): number => row[index] as number

/** Levenshtein distance between two strings. */
export function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      const substitution = cell(previous, j - 1) + (a[i - 1] === b[j - 1] ? 0 : 1)
      current.push(Math.min(cell(previous, j) + 1, cell(current, j - 1) + 1, substitution))
    }
    previous = current
  }
  return cell(previous, b.length)
}

/** The closest candidate within edit distance 2 (case-insensitive); ties go to the earlier candidate. */
export function didYouMean(input: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined
  let bestDistance = 3
  for (const candidate of candidates) {
    const distance = levenshtein(input.toLowerCase(), candidate.toLowerCase())
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

function make(code: DiagnosticCode, location: string, message: string, hint?: string): Diagnostic {
  const severity = SEVERITY[code]
  return hint === undefined
    ? { code, severity, location, message }
    : { code, severity, location, message, hint }
}

const quoted = (suggestion: string | undefined): string =>
  suggestion === undefined ? '' : ` (did you mean "${suggestion}"?)`

const shown = (value: unknown): string =>
  typeof value === 'string' ? `"${value}"` : JSON.stringify(value)

export function unknownConfigKey(key: string, validKeys: readonly string[]): Diagnostic {
  const suggestion = didYouMean(key, validKeys)
  return make(
    'HYDE_CONFIG_UNKNOWN_KEY',
    `config.${key}`,
    `unknown config key "${key}"${quoted(suggestion)}`,
    suggestion === undefined
      ? `Remove "${key}" from the generator block. Valid keys: ${validKeys.join(', ')}.`
      : `Rename "${key}" to "${suggestion}" in the generator block.`,
  )
}

export function invalidConfigValue(
  key: string,
  value: unknown,
  expected: string,
  candidates: readonly string[] = [],
): Diagnostic {
  const suggestion = typeof value === 'string' ? didYouMean(value, candidates) : undefined
  return make(
    'HYDE_CONFIG_INVALID_VALUE',
    `config.${key}`,
    `config "${key}" must be ${expected}, got ${shown(value)}${quoted(suggestion)}`,
    suggestion === undefined
      ? `Set ${key} to ${expected} in the generator block (env() is not supported there).`
      : `Set ${key} = "${suggestion}" in the generator block.`,
  )
}

export function schemaEqualsSource(schema: string): Diagnostic {
  return make(
    'HYDE_SCHEMA_CONFLICT',
    'config.schema',
    `config "schema" (${schema}) must differ from the source schema; it is dropped and recreated on every apply.`,
    'Point "schema" at a dedicated schema that no model uses (the default is "ai").',
  )
}

export function modelInAiSchema(model: string, schema: string): Diagnostic {
  return make(
    'HYDE_SCHEMA_CONFLICT',
    `model ${model}`,
    `model ${model} lives in schema "${schema}", the AI schema, which is dropped and recreated on every apply.`,
    'Point "schema" in the generator block at a schema no model uses, or move the model with @@schema.',
  )
}

export function unknownAnnotation(
  location: string,
  name: string,
  candidates: readonly string[],
): Diagnostic {
  const suggestion = didYouMean(name, candidates)
  return make(
    'HYDE_ANNOTATION_UNKNOWN',
    location,
    `unknown annotation @ai.${name}${suggestion === undefined ? '' : ` (did you mean @ai.${suggestion}?)`}`,
    suggestion === undefined
      ? 'Use @ai.visible or @ai.hidden on fields, and @ai.exclude or @ai.default(visible|hidden) on models.'
      : `Replace @ai.${name} with @ai.${suggestion}.`,
  )
}

export function misplacedModelAnnotation(model: string, name: 'visible' | 'hidden'): Diagnostic {
  return make(
    'HYDE_ANNOTATION_MISPLACED',
    `model ${model}`,
    `use @ai.default(${name}) on models; @ai.${name} is for fields`,
    `Move @ai.${name} into the comments of the fields, or write @ai.default(${name}) on the model.`,
  )
}

export function misplacedFieldAnnotation(
  location: string,
  name: 'exclude' | 'default',
): Diagnostic {
  return make(
    'HYDE_ANNOTATION_MISPLACED',
    location,
    `@ai.${name} is a model annotation`,
    `Move @ai.${name} into the /// comment above the model.`,
  )
}

export function invalidDefaultArgument(model: string, arg: string | undefined): Diagnostic {
  const suggestion = arg === undefined ? undefined : didYouMean(arg, ['visible', 'hidden'])
  return make(
    'HYDE_ANNOTATION_INVALID_ARGUMENT',
    `model ${model}`,
    `@ai.default needs (visible) or (hidden), got (${arg ?? ''})${quoted(suggestion)}`,
    suggestion === undefined
      ? 'Write @ai.default(visible) or @ai.default(hidden).'
      : `Write @ai.default(${suggestion}).`,
  )
}

export function conflictingAnnotations(location: string): Diagnostic {
  return make(
    'HYDE_ANNOTATION_CONFLICT',
    location,
    'both @ai.visible and @ai.hidden',
    'Keep exactly one of @ai.visible and @ai.hidden.',
  )
}

export function strictUnannotated(location: string): Diagnostic {
  return make(
    'HYDE_STRICT_UNANNOTATED',
    location,
    'strict mode requires /// @ai.visible or /// @ai.hidden',
    'Add /// @ai.hidden above the field, or /// @ai.visible if the AI may see it.',
  )
}

export function strictModelDefault(model: string): Diagnostic {
  return make(
    'HYDE_STRICT_MODEL_DEFAULT',
    `model ${model}`,
    '@ai.default is not allowed in strict mode; annotate each field',
    'Remove @ai.default and annotate each field, or set strict = "false" in the generator block.',
  )
}

export function sensitiveImplicit(location: string, via: 'model' | 'global'): Diagnostic {
  return make(
    'HYDE_SENSITIVE_IMPLICIT',
    location,
    `name looks sensitive but would be exposed via the ${via} default`,
    'Add /// @ai.hidden, or /// @ai.visible if it really is safe.',
  )
}

export function viewNameCollision(name: string, first: string, second: string): Diagnostic {
  return make(
    'HYDE_VIEW_NAME_COLLISION',
    `view ${name}`,
    `view name collision "${name}": ${first} and ${second}`,
    'Exclude one of the two models with /// @ai.exclude.',
  )
}

export function unsupportedProvider(provider: string): Diagnostic {
  return make(
    'HYDE_UNSUPPORTED_PROVIDER',
    'datasource',
    `only postgresql is supported (datasource provider is "${provider}")`,
    `Use ${BRAND} only with a datasource whose provider is "postgresql".`,
  )
}

export function noOutputDirectory(): Diagnostic {
  return make(
    'HYDE_NO_OUTPUT',
    'generator',
    'no output directory',
    'Set output = "./ai" in the generator block.',
  )
}

export function relationAnnotated(location: string): Diagnostic {
  return make(
    'HYDE_RELATION_ANNOTATED',
    location,
    'annotation on a relation field has no effect; annotate the scalar FK field(s) instead',
  )
}

export function sensitiveExplicit(location: string): Diagnostic {
  return make(
    'HYDE_SENSITIVE_EXPLICIT',
    location,
    'explicitly visible although the name looks sensitive — double-check',
  )
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'error')
}

/** One diagnostic as text: `error CODE at location: message` plus an indented fix line. */
export function formatDiagnostic(d: Diagnostic): string {
  const line = `${d.severity} ${d.code} at ${d.location}: ${d.message}`
  return d.hint === undefined ? line : `${line}\n    fix: ${d.hint}`
}

/** The message of a failed `prisma generate`: every diagnostic, errors and warnings (D51). */
export function formatReport(diagnostics: readonly Diagnostic[]): string {
  const count = diagnostics.length
  const lines = diagnostics.map((d) => `  ${formatDiagnostic(d)}`)
  return [`${BRAND} found ${count} problem${count === 1 ? '' : 's'}:`, ...lines].join('\n')
}
