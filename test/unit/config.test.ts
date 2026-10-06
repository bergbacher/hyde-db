import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { CONFIG_KEYS, DEFAULT_CONFIG, validateConfig } from '../../src/config.ts'
import type { GeneratorConfig } from '../../src/types.ts'

const codes = (raw: Record<string, unknown>): string[] =>
  validateConfig(raw).diagnostics.map((d) => d.code)

describe('config validation', () => {
  it('D54: defaults are schema redacted, role redacted_reader, source public, hidden, strict, 15s', () => {
    expect(DEFAULT_CONFIG).toEqual({
      dialect: 'postgresql',
      schema: 'redacted',
      role: 'redacted_reader',
      sourceSchema: 'public',
      default: 'hidden',
      strict: true,
      statementTimeout: '15s',
    })
    expect(validateConfig()).toEqual({ config: DEFAULT_CONFIG, diagnostics: [] })
  })

  it('D54: CONFIG_KEYS names exactly the keys of DEFAULT_CONFIG except the resolved dialect, in the same order', () => {
    expect([...CONFIG_KEYS]).toEqual(Object.keys(DEFAULT_CONFIG).filter((key) => key !== 'dialect'))
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
      dialect: 'postgresql',
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

  it("D25: statementTimeout above PostgreSQL's maximum of 2147483647 ms is an error", () => {
    for (const value of ['2147483647ms', '2147483647', '2147483s', '35791min', '35791 min'])
      expect(codes({ statementTimeout: value }), value).toEqual([])
    for (const value of ['2147483648ms', '2147484s', '35792min', '99999999999s', '9'.repeat(400)]) {
      const { config, diagnostics } = validateConfig({ statementTimeout: value })
      expect(
        diagnostics.map((d) => d.code),
        value,
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
  const boom = (): never => {
    throw new Error('boom')
  }
  const invalidConfig = (message: string) => ({
    code: 'HYDE_CONFIG_INVALID_VALUE',
    severity: 'error',
    location: 'config',
    message,
    hint: 'Pass an object of generator config keys, or omit it.',
  })

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

  it('D9: validateConfig treats a null or undefined config as defaults, without a diagnostic', () => {
    for (const value of [null, undefined]) {
      expect(validateConfig(value as unknown as GeneratorConfig)).toEqual({
        config: DEFAULT_CONFIG,
        diagnostics: [],
      })
    }
  })

  it('D9: validateConfig reports exactly one error for a config that is not an object', () => {
    const notObjects: readonly (readonly [unknown, string])[] = [
      ['strict', 'string'],
      ['', 'string'],
      [5, 'number'],
      [Number.NaN, 'number'],
      [true, 'boolean'],
      [10n, 'bigint'],
      [Symbol('s'), 'symbol'],
      [() => 1, 'function'],
      [[], 'array'],
      [[[['a']], []], 'array'],
      [['strict'], 'array'],
      // Boxed primitives and built-in objects are not a bag of keys (D9): refused once, by tag.
      [Object(1), 'Number'],
      [new String('strict'), 'String'],
      [new Boolean(false), 'Boolean'],
      [Object(10n), 'BigInt'],
      [Object(Symbol('s')), 'Symbol'],
      [new Uint8Array(2), 'Uint8Array'],
      [new Map([['strict', 'false']]), 'Map'],
      [new Set(['strict']), 'Set'],
      [new Date(0), 'Date'],
      [/strict/, 'RegExp'],
      [new Error('strict'), 'Error'],
      [Promise.resolve({ strict: 'false' }), 'Promise'],
    ]
    for (const [value, type] of notObjects) {
      expect(validateConfig(value as GeneratorConfig), type).toEqual({
        config: DEFAULT_CONFIG,
        diagnostics: [
          invalidConfig(`config must be an object of generator config keys, got type ${type}`),
        ],
      })
    }
  })

  it('D9: validateConfig keeps accepting class instances and cross-realm plain objects', () => {
    class Settings {
      strict = 'false'
    }
    for (const value of [new Settings(), runInNewContext('({ strict: "false" })')]) {
      expect(validateConfig(value as GeneratorConfig)).toEqual({
        config: { ...DEFAULT_CONFIG, strict: false },
        diagnostics: [],
      })
    }
  })

  it('D9: validateConfig reads circular and prototype-less objects like any other object', () => {
    for (const value of [circular, bare]) {
      const { config, diagnostics } = validateConfig(value)
      expect(config).toEqual(DEFAULT_CONFIG)
      expect(diagnostics.map((d) => [d.code, d.location])).toEqual([
        ['HYDE_CONFIG_UNKNOWN_KEY', 'config.self'],
      ])
    }
  })

  it('D9: a getter that throws becomes one error for its key; other keys are still read', () => {
    const { config, diagnostics } = validateConfig({
      role: 'safe_reader',
      get strict(): string {
        return boom()
      },
    })
    expect(config.role).toBe('safe_reader')
    expect(config.strict).toBe(DEFAULT_CONFIG.strict)
    expect(diagnostics).toEqual([
      {
        code: 'HYDE_CONFIG_INVALID_VALUE',
        severity: 'error',
        location: 'config.strict',
        message: 'config "strict" could not be read: reading it threw',
        hint: 'Set strict to a plain value in the generator block.',
      },
    ])
  })

  it('D9: an unknown key is reported without reading its value, so a throwing getter is harmless', () => {
    const { diagnostics } = validateConfig({
      get strickt(): string {
        return boom()
      },
    })
    expect(diagnostics.map((d) => [d.code, d.location])).toEqual([
      ['HYDE_CONFIG_UNKNOWN_KEY', 'config.strickt'],
    ])
  })

  it('D9: a Proxy whose get trap throws becomes one error per known key it lists', () => {
    const proxy = new Proxy({ strict: 'true', role: 'safe_reader' }, { get: boom })
    expect(validateConfig(proxy).diagnostics.map((d) => [d.code, d.location])).toEqual([
      ['HYDE_CONFIG_INVALID_VALUE', 'config.role'],
      ['HYDE_CONFIG_INVALID_VALUE', 'config.strict'],
    ])
  })

  it('D9: a config whose keys cannot be listed becomes one error for config', () => {
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    const hostile: readonly (readonly [string, GeneratorConfig])[] = [
      ['ownKeys trap', new Proxy({}, { ownKeys: boom })],
      ['has trap', new Proxy({}, { has: boom })],
      ['revoked proxy', revoked.proxy],
    ]
    for (const [label, value] of hostile) {
      expect(validateConfig(value), label).toEqual({
        config: DEFAULT_CONFIG,
        diagnostics: [invalidConfig('config could not be read: listing its keys threw')],
      })
    }
  })
})
