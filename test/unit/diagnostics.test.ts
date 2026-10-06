import { describe, expect, it } from 'vitest'
import { BRAND } from '../../src/brand.ts'
import { build } from '../../src/build.ts'
import {
  conflictingAnnotations,
  DIAGNOSTIC_CODES,
  didYouMean,
  formatDiagnostic,
  formatReport,
  hasErrors,
  invalidConfigValue,
  invalidDefaultArgument,
  levenshtein,
  misplacedFieldAnnotation,
  misplacedModelAnnotation,
  modelInViewsSchema,
  noOutputDirectory,
  relationAnnotated,
  schemaEqualsSource,
  sensitiveExplicit,
  sensitiveImplicit,
  strictModelDefault,
  strictUnannotated,
  unknownAnnotation,
  unknownConfigKey,
  unsupportedProvider,
  viewNameCollision,
} from '../../src/diagnostics.ts'
import type { Diagnostic } from '../../src/types.ts'
import { OUTPUT_FILES, readRepoFile } from '../helpers/files.ts'
import { parseSchema } from '../helpers/prisma.ts'

const ALL: Diagnostic[] = [
  unknownConfigKey('strickt', ['strict']),
  unknownConfigKey('zzz', ['strict']),
  invalidConfigValue('default', 'hiden', '"hidden" or "visible"', ['hidden', 'visible']),
  invalidConfigValue('schema', 'VIEWS_SCHEMA', 'a lowercase SQL identifier'),
  schemaEqualsSource('public'),
  modelInViewsSchema('User', 'redacted'),
  unknownAnnotation('User.id', 'visable', ['visible', 'hidden']),
  unknownAnnotation('User.id', 'zzz', ['visible', 'hidden']),
  misplacedModelAnnotation('User', 'visible'),
  misplacedFieldAnnotation('User.id', 'exclude'),
  invalidDefaultArgument('User', 'visble'),
  invalidDefaultArgument('User', undefined),
  conflictingAnnotations('User.id'),
  strictUnannotated('User.id'),
  strictModelDefault('User'),
  sensitiveImplicit('User.email', 'global'),
  viewNameCollision('users', 'public.users', 'auth.users'),
  unsupportedProvider('mysql'),
  noOutputDirectory(),
  relationAnnotated('Order.user'),
  sensitiveExplicit('User.email'),
]

describe('diagnostics catalog', () => {
  it('D51: codes are stable, unique HYDE_* identifiers and every one has a factory', () => {
    expect(new Set(DIAGNOSTIC_CODES).size).toBe(DIAGNOSTIC_CODES.length)
    for (const code of DIAGNOSTIC_CODES) expect(code).toMatch(/^HYDE_[A-Z_]+$/)
    expect(new Set(ALL.map((d) => d.code))).toEqual(new Set(DIAGNOSTIC_CODES))
  })

  it('D26: every error diagnostic carries a non-empty fix hint', () => {
    for (const d of ALL.filter((x) => x.severity === 'error')) {
      expect(d.hint, d.code).toMatch(/\S/)
    }
  })

  it('D51: relation and explicit-sensitive findings are warnings, everything else is an error', () => {
    const warnings = ALL.filter((d) => d.severity === 'warning').map((d) => d.code)
    expect(new Set(warnings)).toEqual(
      new Set(['HYDE_RELATION_ANNOTATED', 'HYDE_SENSITIVE_EXPLICIT']),
    )
  })

  it('keeps the base per-field message texts', () => {
    expect(strictUnannotated('User.phone')).toEqual({
      code: 'HYDE_STRICT_UNANNOTATED',
      severity: 'error',
      location: 'User.phone',
      message: 'strict mode requires /// @hyde.visible or /// @hyde.hidden',
      hint: 'Add /// @hyde.hidden above the field, or /// @hyde.visible if the reader may see it.',
    })
    expect(relationAnnotated('Order.user').message).toBe(
      'annotation on a relation field has no effect; annotate the scalar FK field(s) instead',
    )
    expect(sensitiveImplicit('Gone.secret', 'model').message).toBe(
      'name looks sensitive but would be exposed via the model default',
    )
  })
})

describe('privacy naming (D53, D54)', () => {
  it('D54: hints name the @hyde.* annotations and the ./redacted output directory', () => {
    expect(unknownAnnotation('User.id', 'zzz', ['visible', 'hidden']).hint).toBe(
      'Use @hyde.visible or @hyde.hidden on fields, and @hyde.exclude or @hyde.default(visible|hidden) on models.',
    )
    expect(unknownAnnotation('User', 'zzz', ['exclude', 'default']).hint).toContain('@hyde.')
    expect(unknownAnnotation('User.id', 'visable', ['visible', 'hidden']).hint).toBe(
      'Replace @hyde.visable with @hyde.visible.',
    )
    expect(noOutputDirectory().hint).toBe('Set output = "./redacted" in the generator block.')
    expect(schemaEqualsSource('public').hint).toContain('(the default is "redacted")')
  })

  it('D53: no AI-centric names remain in generated output or diagnostics', () => {
    const aiCentric = /\bai\b|ai_reader|@ai\.|\bAI\b|LLM/
    const { datamodel, config } = parseSchema(readRepoFile('example', 'schema.prisma'))
    const { files, diagnostics } = build(datamodel, config)
    for (const name of OUTPUT_FILES) expect(files?.[name], name).not.toMatch(aiCentric)
    for (const d of [...ALL, ...diagnostics]) {
      expect(d.message, d.code).not.toMatch(aiCentric)
      expect(d.hint ?? '', d.code).not.toMatch(aiCentric)
    }
  })
})

describe('did you mean (D25)', () => {
  it('computes Levenshtein distances', () => {
    expect(levenshtein('', '')).toBe(0)
    expect(levenshtein('strict', 'strict')).toBe(0)
    expect(levenshtein('strickt', 'strict')).toBe(1)
    expect(levenshtein('ture', 'true')).toBe(2)
    expect(levenshtein('abc', '')).toBe(3)
  })

  it('D25: suggests the closest candidate within edit distance 2, case-insensitively', () => {
    expect(didYouMean('strickt', ['schema', 'strict'])).toBe('strict')
    expect(didYouMean('Strict', ['strict'])).toBe('strict')
    expect(didYouMean('ture', ['true', 'false'])).toBe('true')
    expect(didYouMean('visable', ['visible', 'hidden'])).toBe('visible')
  })

  it('D25: suggests nothing beyond edit distance 2', () => {
    expect(didYouMean('xyz', ['strict', 'schema'])).toBeUndefined()
    expect(didYouMean('vsbl', ['visible'])).toBeUndefined()
  })

  it('D25: names the suggestion in message and hint', () => {
    const d = unknownConfigKey('strickt', ['schema', 'strict'])
    expect(d.message).toBe('unknown config key "strickt" (did you mean "strict"?)')
    expect(d.hint).toBe('Rename "strickt" to "strict" in the generator block.')
    expect(unknownConfigKey('zzz', ['schema']).hint).toBe(
      'Remove "zzz" from the generator block. Valid keys: schema.',
    )
    expect(unknownAnnotation('User.id', 'visable', ['visible', 'hidden']).message).toBe(
      'unknown annotation @hyde.visable (did you mean @hyde.visible?)',
    )
    expect(invalidDefaultArgument('User', 'visble').message).toBe(
      '@hyde.default needs (visible) or (hidden), got (visble) (did you mean "visible"?)',
    )
    expect(invalidConfigValue('strict', ['true'], '"true" or "false"', ['true']).message).toBe(
      'config "strict" must be "true" or "false", got ["true"]',
    )
  })
})

describe('formatting', () => {
  it('formats one diagnostic with its fix line', () => {
    expect(formatDiagnostic(strictUnannotated('User.phone'))).toBe(
      'error HYDE_STRICT_UNANNOTATED at User.phone: strict mode requires /// @hyde.visible or /// @hyde.hidden\n' +
        '    fix: Add /// @hyde.hidden above the field, or /// @hyde.visible if the reader may see it.',
    )
    expect(formatDiagnostic(sensitiveExplicit('User.email'))).toBe(
      'warning HYDE_SENSITIVE_EXPLICIT at User.email: explicitly visible although the name looks sensitive — double-check',
    )
  })

  it('D51: the report lists every diagnostic, warnings included', () => {
    const report = formatReport([strictUnannotated('User.phone'), sensitiveExplicit('User.email')])
    expect(report.split('\n')[0]).toBe(`${BRAND} found 2 problems:`)
    expect(report).toContain('  error HYDE_STRICT_UNANNOTATED at User.phone')
    expect(report).toContain('  warning HYDE_SENSITIVE_EXPLICIT at User.email')
    expect(formatReport([noOutputDirectory()]).split('\n')[0]).toBe(`${BRAND} found 1 problem:`)
  })

  it('detects errors', () => {
    expect(hasErrors([sensitiveExplicit('a.b')])).toBe(false)
    expect(hasErrors([sensitiveExplicit('a.b'), noOutputDirectory()])).toBe(true)
  })
})
