import { describe, expect, it } from 'vitest'
import { BRAND, DEFAULT_OUTPUT } from '../../src/brand.ts'
import { build } from '../../src/build.ts'
import {
  configNotAnObject,
  conflictingAnnotations,
  DIAGNOSTIC_CODES,
  didYouMean,
  formatDiagnostic,
  formatReport,
  hasErrors,
  invalidConfigValue,
  invalidDefaultArgument,
  legacyAnnotation,
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
  timeoutDisabled,
  unknownAnnotation,
  unknownConfigKey,
  unreadableConfig,
  unreadableConfigValue,
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
  configNotAnObject('string'),
  unreadableConfig(),
  unreadableConfigValue('strict'),
  timeoutDisabled('0s', 'redacted_reader'),
  legacyAnnotation('User.id', 'hidden'),
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

  it('D51: the diagnostic codes are exactly the published list', () => {
    expect([...DIAGNOSTIC_CODES].sort()).toEqual([
      'HYDE_ANNOTATION_CONFLICT',
      'HYDE_ANNOTATION_INVALID_ARGUMENT',
      'HYDE_ANNOTATION_MISPLACED',
      'HYDE_ANNOTATION_UNKNOWN',
      'HYDE_CONFIG_INVALID_VALUE',
      'HYDE_CONFIG_UNKNOWN_KEY',
      'HYDE_LEGACY_ANNOTATION',
      'HYDE_NO_OUTPUT',
      'HYDE_RELATION_ANNOTATED',
      'HYDE_SCHEMA_CONFLICT',
      'HYDE_SENSITIVE_EXPLICIT',
      'HYDE_SENSITIVE_IMPLICIT',
      'HYDE_STRICT_MODEL_DEFAULT',
      'HYDE_STRICT_UNANNOTATED',
      'HYDE_TIMEOUT_DISABLED',
      'HYDE_UNSUPPORTED_PROVIDER',
      'HYDE_VIEW_NAME_COLLISION',
    ])
    expect(DIAGNOSTIC_CODES).toHaveLength(17)
  })

  it('D51: relation, explicit-sensitive, disabled-timeout and legacy-annotation findings are warnings, everything else is an error', () => {
    const warnings = ALL.filter((d) => d.severity === 'warning').map((d) => d.code)
    expect(new Set(warnings)).toEqual(
      new Set([
        'HYDE_RELATION_ANNOTATED',
        'HYDE_SENSITIVE_EXPLICIT',
        'HYDE_TIMEOUT_DISABLED',
        'HYDE_LEGACY_ANNOTATION',
      ]),
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

describe('value formatting (D9)', () => {
  const got = (value: unknown): string =>
    invalidConfigValue('role', value, 'a name').message.replace(/^.*, got /, '')
  const circular: Record<string, unknown> = {}
  circular.self = circular
  const bare = Object.create(null) as Record<string, unknown>
  bare.self = bare

  it('D9: shows any value without throwing', () => {
    expect(got('x')).toBe('"x"')
    expect(got(['a'])).toBe('["a"]')
    expect(got({ a: 1 })).toBe('{"a":1}')
    expect(got(10n)).toBe('10')
    expect(got(Number.NaN)).toBe('NaN')
    expect(got(Number.POSITIVE_INFINITY)).toBe('Infinity')
    expect(got(true)).toBe('true')
    expect(got(Symbol('s'))).toBe('Symbol(s)')
    expect(got(circular)).toBe('[object Object]')
    expect(got(bare)).toBe('object')
    expect(got(() => 1)).toBe('function')
    expect(got(function named() {})).toBe('function')
    expect(got(undefined)).toBe('undefined')
    expect(got(null)).toBe('null')
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
    expect(noOutputDirectory().hint).toBe(
      `Set output = "${DEFAULT_OUTPUT}" in the generator block.`,
    )
    expect(schemaEqualsSource('public').hint).toContain('(the default is "redacted")')
  })

  it('D53: no AI-centric names remain in generated output or diagnostics', () => {
    const aiCentric = /\bai\b|ai_reader|@ai\.|\bAI\b|LLM/
    const { datamodel, config } = parseSchema(readRepoFile('example', 'schema.prisma'))
    const { files, diagnostics } = build(datamodel, config)
    for (const name of OUTPUT_FILES) expect(files?.[name], name).not.toMatch(aiCentric)
    // The legacy-annotation warning names the old tag and package on purpose (D60); only those
    // two tokens are removed from its message before the scan. Its hint is scanned unchanged.
    const intended = (d: Diagnostic): string =>
      d.code === 'HYDE_LEGACY_ANNOTATION'
        ? d.message
            .replace(/@ai\.(visible|hidden|exclude|default)/, '')
            .replace('prisma-ai-views', '')
        : d.message
    for (const d of [...ALL, ...diagnostics]) {
      expect(intended(d), d.code).not.toMatch(aiCentric)
      expect(d.hint ?? '', d.code).not.toMatch(aiCentric)
    }
  })
})

describe('warnings', () => {
  it('D59: a disabled timeout names the value and the role, and how to fix it', () => {
    expect(timeoutDisabled('0 ms', 'safe_reader')).toEqual({
      code: 'HYDE_TIMEOUT_DISABLED',
      severity: 'warning',
      location: 'generator config',
      message: 'statementTimeout "0 ms" disables the statement timeout for role safe_reader',
      hint: 'Use a positive value such as "15s", or remove statementTimeout to use the default.',
    })
  })

  it('D60: a legacy annotation names the old tag and its @hyde replacement', () => {
    expect(legacyAnnotation('model User', 'exclude')).toEqual({
      code: 'HYDE_LEGACY_ANNOTATION',
      severity: 'warning',
      location: 'model User',
      message: '@ai.exclude is the old prisma-ai-views annotation and has no effect',
      hint: 'Rename it to @hyde.exclude.',
    })
  })
})

describe('config shape errors (D9)', () => {
  it('D9: a config that is not an object names the received type', () => {
    expect(configNotAnObject('array')).toEqual({
      code: 'HYDE_CONFIG_INVALID_VALUE',
      severity: 'error',
      location: 'config',
      message: 'config must be an object of generator config keys, got type array',
      hint: 'Pass an object of generator config keys, or omit it.',
    })
  })

  it('D9: an unreadable config or config value is an invalid-value error with a fix hint', () => {
    expect(unreadableConfig()).toMatchObject({
      code: 'HYDE_CONFIG_INVALID_VALUE',
      location: 'config',
      message: 'config could not be read: listing its keys threw',
      hint: 'Pass an object of generator config keys, or omit it.',
    })
    expect(unreadableConfigValue('role')).toMatchObject({
      code: 'HYDE_CONFIG_INVALID_VALUE',
      location: 'config.role',
      message: 'config "role" could not be read: reading it threw',
      hint: 'Set role to a plain value in the generator block.',
    })
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
