// Annotation parsing: reads `@hyde.*` tags out of `///` doc comments and reports unknown,
// misplaced, conflicting or malformed tags (D25: unknown names get a "did you mean").
import type { Field, Model } from './datamodel.ts'
import {
  conflictingAnnotations,
  invalidDefaultArgument,
  legacyAnnotation,
  misplacedFieldAnnotation,
  misplacedModelAnnotation,
  unknownAnnotation,
} from './diagnostics.ts'
import type { Diagnostic, Visibility } from './types.ts'

const ANNOTATION_RE = /@hyde\.([a-zA-Z]+)(?:\(([^)]*)\))?/g
/** The base package's namespace (D60): plain doc text since the rename, but worth a warning. */
const LEGACY_RE = /@ai\.(visible|hidden|exclude|default)\b/g
const FIELD_ANNOTATIONS: readonly string[] = ['visible', 'hidden']
const MODEL_ANNOTATIONS: readonly string[] = ['exclude', 'default']

export interface Tag {
  readonly name: string
  readonly arg: string | undefined
}

export interface ParsedDoc {
  readonly tags: readonly Tag[]
  /** The doc text with every tag removed, lines joined by single spaces. */
  readonly text: string
}

export function parseDoc(doc: string): ParsedDoc {
  const tags: Tag[] = []
  const text: string[] = []
  for (const line of doc.split('\n')) {
    for (const match of line.matchAll(ANNOTATION_RE)) {
      const arg = match[2]?.trim().replace(/^["']|["']$/g, '')
      tags.push({ name: match[1] ?? '', arg })
    }
    const rest = line.replace(ANNOTATION_RE, '').trim()
    if (rest) text.push(rest)
  }
  return { tags, text: text.join(' ') }
}

/** One warning per leftover `@ai.<name>` in a doc comment (D60). */
function legacyDiagnostics(location: string, doc: string): Diagnostic[] {
  return Array.from(doc.matchAll(LEGACY_RE), (match) => legacyAnnotation(location, match[1] ?? ''))
}

export interface ModelAnnotations {
  readonly excluded: boolean
  /** Every valid `@hyde.default(...)` argument, in order. */
  readonly defaults: readonly Visibility[]
  readonly text: string
  readonly diagnostics: readonly Diagnostic[]
}

export function readModelAnnotations(model: Model): ModelAnnotations {
  const { tags, text } = parseDoc(model.documentation)
  const defaults: Visibility[] = []
  const diagnostics: Diagnostic[] = []
  let excluded = false
  for (const tag of tags) {
    if (tag.name === 'exclude') excluded = true
    else if (tag.name === 'default') {
      if (tag.arg === 'visible' || tag.arg === 'hidden') defaults.push(tag.arg)
      else diagnostics.push(invalidDefaultArgument(model.name, tag.arg))
    } else if (tag.name === 'visible' || tag.name === 'hidden')
      diagnostics.push(misplacedModelAnnotation(model.name, tag.name))
    else diagnostics.push(unknownAnnotation(`model ${model.name}`, tag.name, MODEL_ANNOTATIONS))
  }
  diagnostics.push(...legacyDiagnostics(`model ${model.name}`, model.documentation))
  return { excluded, defaults, text, diagnostics }
}

export interface FieldAnnotations {
  /** `hidden` if the field carries `@hyde.hidden` (even together with `@hyde.visible`, D57), else `visible` if it carries `@hyde.visible`. */
  readonly visibility: Visibility | undefined
  readonly text: string
  readonly diagnostics: readonly Diagnostic[]
}

export function readFieldAnnotations(modelName: string, field: Field): FieldAnnotations {
  const location = `${modelName}.${field.name}`
  const { tags, text } = parseDoc(field.documentation)
  const diagnostics: Diagnostic[] = []
  let visibility: Visibility | undefined
  for (const tag of tags) {
    if (tag.name === 'visible' || tag.name === 'hidden') {
      if (visibility !== undefined && visibility !== tag.name)
        diagnostics.push(conflictingAnnotations(location))
      // D57: a conflict fails closed; the conflict itself is still reported as an error.
      visibility = visibility === 'hidden' ? 'hidden' : tag.name
    } else if (tag.name === 'exclude' || tag.name === 'default')
      diagnostics.push(misplacedFieldAnnotation(location, tag.name))
    else diagnostics.push(unknownAnnotation(location, tag.name, FIELD_ANNOTATIONS))
  }
  diagnostics.push(...legacyDiagnostics(location, field.documentation))
  return { visibility, text, diagnostics }
}
