import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, validateConfig } from '../../src/config.ts'

const codes = (raw: Record<string, unknown>): string[] =>
  validateConfig(raw).diagnostics.map((d) => d.code)

describe('config validation', () => {
  it('D54: defaults are schema ai, role ai_reader, source public, hidden, strict, 15s', () => {
    expect(DEFAULT_CONFIG).toEqual({
      schema: 'ai',
      role: 'ai_reader',
      sourceSchema: 'public',
      default: 'hidden',
      strict: true,
      statementTimeout: '15s',
    })
    expect(validateConfig()).toEqual({ config: DEFAULT_CONFIG, diagnostics: [] })
  })

  it('accepts every valid key as Prisma passes it (strings)', () => {
    const { config, diagnostics } = validateConfig({
      schema: 'llm',
      role: 'llm_reader',
      sourceSchema: 'app',
      default: 'visible',
      strict: 'false',
      statementTimeout: '500ms',
    })
    expect(diagnostics).toEqual([])
    expect(config).toEqual({
      schema: 'llm',
      role: 'llm_reader',
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
    expect(codes({ schema: 'AI' })).toEqual(['HYDE_CONFIG_INVALID_VALUE'])
    expect(codes({ role: 'ai-reader' })).toEqual(['HYDE_CONFIG_INVALID_VALUE'])
    expect(codes({ sourceSchema: '' })).toEqual(['HYDE_CONFIG_INVALID_VALUE'])
    expect(codes({ statementTimeout: '15 hours' })).toEqual(['HYDE_CONFIG_INVALID_VALUE'])
    expect(codes({ statementTimeout: '1min' })).toEqual([])
  })

  it('D25: identifiers longer than 63 characters are errors (PostgreSQL would truncate them)', () => {
    expect(codes({ role: 'r'.repeat(63) })).toEqual([])
    expect(codes({ role: 'r'.repeat(64) })).toEqual(['HYDE_CONFIG_INVALID_VALUE'])
  })

  it('A22: a list value or an env("X") literal is an invalid value', () => {
    expect(validateConfig({ schema: ['ai'] }).diagnostics[0]?.message).toBe(
      'config "schema" must be a lowercase SQL identifier of at most 63 characters, got ["ai"]',
    )
    expect(validateConfig({ schema: 'AI_SCHEMA' }).diagnostics[0]?.hint).toContain(
      'env() is not supported',
    )
  })

  it('D29: one call reports every config problem and keeps safe defaults', () => {
    const { config, diagnostics } = validateConfig({
      strickt: 'true',
      default: 'hiden',
      schema: 'AI',
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
    const forward = validateConfig({ zeta: '1', schema: 'AI', alpha: '2', role: 'R' })
    const backward = validateConfig({ role: 'R', alpha: '2', schema: 'AI', zeta: '1' })
    expect(forward).toEqual(backward)
    expect(forward.diagnostics.map((d) => d.location)).toEqual([
      'config.schema',
      'config.role',
      'config.alpha',
      'config.zeta',
    ])
  })
})
