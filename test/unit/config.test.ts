import { describe, expect, it } from 'vitest'
import { CONFIG_KEYS, DEFAULT_CONFIG, validateConfig } from '../../src/config.ts'
import type { GeneratorConfig } from '../../src/types.ts'

const codes = (raw: Record<string, unknown>): string[] =>
  validateConfig(raw).diagnostics.map((d) => d.code)

describe('config validation', () => {
  it('D54: defaults are schema redacted, role redacted_reader, source public, hidden, strict, 15s', () => {
    expect(DEFAULT_CONFIG).toEqual({
      schema: 'redacted',
      role: 'redacted_reader',
      sourceSchema: 'public',
      default: 'hidden',
      strict: true,
      statementTimeout: '15s',
    })
    expect(validateConfig()).toEqual({ config: DEFAULT_CONFIG, diagnostics: [] })
  })

  it('accepts every valid key as Prisma passes it (strings)', () => {
    const { config, diagnostics } = validateConfig({
      schema: 'safe',
      role: 'safe_reader',
      sourceSchema: 'app',
      default: 'visible',
      strict: 'false',
      statementTimeout: '500ms',
    })
    expect(diagnostics).toEqual([])
    expect(config).toEqual({
      schema: 'safe',
      role: 'safe_reader',
      sourceSchema: 'app',
      default: 'visible',
      strict: false,
      statementTimeout: '500ms',
    })
  })

  it('accepts booleans for strict from programmatic callers and skips null/undefined', () => {
    expect(validateConfig({ strict: false }).config.strict).toBe(false)
    expect(validateConfig({ strict: true }).config.strict).toBe(true)
    expect(validateConfig({ strict: 'true' }).config.strict).toBe(true)
    expect(validateConfig({ schema: undefined, role: null }).diagnostics).toEqual([])
  })

  it('D25: an unknown key is an error that names the closest valid key', () => {
    const [d] = validateConfig({ strickt: 'true' }).diagnostics
    expect(d).toMatchObject({
      code: 'HYDE_CONFIG_UNKNOWN_KEY',
      severity: 'error',
      location: 'config.strickt',
      message: 'unknown config key "strickt" (did you mean "strict"?)',
    })
  })

  it('D25: an unknown key is reported even when its value is null or undefined', () => {
    for (const value of [undefined, null]) {
      expect(validateConfig({ strickt: value }).diagnostics, String(value)).toMatchObject([
        {
          code: 'HYDE_CONFIG_UNKNOWN_KEY',
          severity: 'error',
          location: 'config.strickt',
          message: 'unknown config key "strickt" (did you mean "strict"?)',
        },
      ])
    }
  })

  it('D25: an invalid strict value is an error, not a silent false (A16)', () => {
    const { config, diagnostics } = validateConfig({ strict: 'ture' })
    expect(config.strict).toBe(DEFAULT_CONFIG.strict)
    expect(diagnostics[0]).toMatchObject({
      code: 'HYDE_CONFIG_INVALID_VALUE',
      location: 'config.strict',
      message: 'config "strict" must be "true" or "false", got "ture" (did you mean "true"?)',
    })
    expect(codes({ strict: 'yes' })).toEqual(['HYDE_CONFIG_INVALID_VALUE'])
  })

  it('D25: invalid values for default, identifiers and timeout are errors', () => {
    expect(validateConfig({ default: 'hiden' }).diagnostics[0]?.message).toBe(
      'config "default" must be "hidden" or "visible", got "hiden" (did you mean "hidden"?)',
    )
    expect(codes({ schema: 'REDACTED' })).toEqual(['HYDE_CONFIG_INVALID_VALUE'])
    expect(codes({ role: 'redacted-reader' })).toEqual(['HYDE_CONFIG_INVALID_VALUE'])
    expect(codes({ sourceSchema: '' })).toEqual(['HYDE_CONFIG_INVALID_VALUE'])
    expect(codes({ statementTimeout: '15 hours' })).toEqual(['HYDE_CONFIG_INVALID_VALUE'])
    expect(codes({ statementTimeout: '1min' })).toEqual([])
  })

  it('D25: statementTimeout accepts digits with an optional single plain space before ms, s or min', () => {
    for (const value of ['15', '15s', '15 s', '500ms', '500 ms', '1min', '1 min', '007s'])
      expect(codes({ statementTimeout: value }), value).toEqual([])
  })

  it('D25: statementTimeout rejects whitespace other than one plain space', () => {
    const rejected = [
      '15\n s',
      '15\ts',
      '15\u00a0s',
      '15  s',
      ' 15s',
      '15s ',
      '15s\n',
      '\n15s',
      '15 ',
      '',
      ' ',
      's',
      '15 hours',
    ]
    for (const value of rejected) {
      const { config, diagnostics } = validateConfig({ statementTimeout: value })
      expect(
        diagnostics.map((d) => d.code),
        JSON.stringify(value),
      ).toEqual(['HYDE_CONFIG_INVALID_VALUE'])
      expect(config.statementTimeout).toBe('15s')
    }
  })

  it('D25: identifiers longer than 63 characters are errors (PostgreSQL would truncate them)', () => {
    expect(codes({ role: 'r'.repeat(63) })).toEqual([])
    expect(codes({ role: 'r'.repeat(64) })).toEqual(['HYDE_CONFIG_INVALID_VALUE'])
  })

  it('A22: a list value or an env("X") literal is an invalid value', () => {
    expect(validateConfig({ schema: ['redacted'] }).diagnostics[0]?.message).toBe(
      'config "schema" must be a lowercase SQL identifier of at most 63 characters, got ["redacted"]',
    )
    expect(validateConfig({ schema: 'VIEWS_SCHEMA' }).diagnostics[0]?.hint).toContain(
      'env() is not supported',
    )
  })

  it('D29: one call reports every config problem and keeps safe defaults', () => {
    const { config, diagnostics } = validateConfig({
      strickt: 'true',
      default: 'hiden',
      schema: 'REDACTED',
      statementTimeout: 'soon',
    })
    expect(diagnostics.map((d) => d.location)).toEqual([
      'config.schema',
      'config.default',
      'config.statementTimeout',
      'config.strickt',
    ])
    expect(config).toEqual(DEFAULT_CONFIG)
  })

  it('A19: reports in a canonical order whatever order Prisma delivers the keys in', () => {
    const forward = validateConfig({ zeta: '1', schema: 'REDACTED', alpha: '2', role: 'R' })
    const backward = validateConfig({ role: 'R', alpha: '2', schema: 'REDACTED', zeta: '1' })
    expect(forward).toEqual(backward)
    expect(forward.diagnostics.map((d) => d.location)).toEqual([
      'config.schema',
      'config.role',
      'config.alpha',
      'config.zeta',
    ])
  })
})

describe('a zero statementTimeout (D59)', () => {
  it('D59: a zero statementTimeout is a warning, not an error', () => {
    for (const value of ['0', '0s', '0 ms', '000min']) {
      const { config, diagnostics } = validateConfig({
        role: 'safe_reader',
        statementTimeout: value,
      })
      expect(config.statementTimeout, value).toBe(value)
      expect(diagnostics, value).toEqual([
        {
          code: 'HYDE_TIMEOUT_DISABLED',
          severity: 'warning',
          location: 'generator config',
          message: `statementTimeout "${value}" disables the statement timeout for role safe_reader`,
          hint: 'Use a positive value such as "15s", or remove statementTimeout to use the default.',
        },
      ])
    }
  })

  it('D59: a positive statementTimeout does not warn, however many zeros lead it', () => {
    for (const value of ['1s', '10', '100ms', '007s', '0100 min'])
      expect(codes({ statementTimeout: value }), value).toEqual([])
  })

  it('D59: the warning names the role that applies, the default when the role is invalid', () => {
    const { diagnostics } = validateConfig({ role: 'NOT VALID', statementTimeout: '0' })
    expect(diagnostics.map((d) => [d.code, d.severity])).toEqual([
      ['HYDE_CONFIG_INVALID_VALUE', 'error'],
      ['HYDE_TIMEOUT_DISABLED', 'warning'],
    ])
    expect(diagnostics[1]?.message).toContain('for role redacted_reader')
  })
})

describe('exotic input (D9)', () => {
  const circular: Record<string, unknown> = {}
  circular.self = circular
  const bare = Object.create(null) as Record<string, unknown>
  bare.self = bare
  const exotic: readonly (readonly [string, unknown])[] = [
    ['null', null],
    ['undefined', undefined],
    ['a bigint', 10n],
    ['a circular object', circular],
    ['a circular object without a prototype', bare],
    ['a function', () => 1],
    ['a symbol', Symbol('s')],
    ['a nested array', [[['a']], []]],
    ['NaN', Number.NaN],
    ['an empty string', ''],
  ]

  it('D9: validateConfig never throws for an exotic value of any key', () => {
    for (const [label, value] of exotic) {
      for (const key of [...CONFIG_KEYS, 'unknownKey']) {
        const { diagnostics } = validateConfig({ [key]: value })
        const skipped = (value === null || value === undefined) && key !== 'unknownKey'
        expect(
          diagnostics.map((d) => d.code),
          `${label} for ${key}`,
        ).toEqual(
          skipped
            ? []
            : [key === 'unknownKey' ? 'HYDE_CONFIG_UNKNOWN_KEY' : 'HYDE_CONFIG_INVALID_VALUE'],
        )
      }
    }
  })

  it('D9: validateConfig treats a null, undefined or non-object config as defaults', () => {
    for (const value of [null, undefined]) {
      expect(validateConfig(value as unknown as GeneratorConfig)).toEqual({
        config: DEFAULT_CONFIG,
        diagnostics: [],
      })
    }
    for (const [label, value] of exotic.filter(([, v]) => v !== null && v !== undefined)) {
      const { config } = validateConfig(value as GeneratorConfig)
      expect(config, label).toEqual(DEFAULT_CONFIG)
    }
  })
})
