import { describe, expect, it } from 'vitest'
import { analyze } from '../../src/analyze.ts'
import { build } from '../../src/build.ts'
import * as api from '../../src/index.ts'
import type { GeneratorConfig } from '../../src/types.ts'
import { datamodel, model, scalar } from '../helpers/dmmf.ts'

describe('build', () => {
  it('returns the analysis plus the three output files', () => {
    const result = build(
      datamodel(model('User', [scalar('id', '@hyde.visible')], { dbName: 'users' })),
    )
    expect(Object.keys(result.files ?? {})).toEqual([
      'redacted-views.sql',
      'redacted-views-drop.sql',
      'redacted-schema.md',
    ])
    expect(result.views.map((v) => v.name)).toEqual(['users'])
    expect(result.counts).toEqual({ visible: 1, hidden: 0 })
  })

  it('D51: any error returns no files and names its cause; warnings alone still build', () => {
    const failed = build(datamodel(model('User', [scalar('phone')])), { strict: 'true' })
    expect(failed.files).toBeNull()
    expect(failed.diagnostics).toMatchObject([
      { code: 'HYDE_STRICT_UNANNOTATED', severity: 'error', location: 'User.phone' },
    ])
    const warned = build(datamodel(model('User', [scalar('email', '@hyde.visible')])))
    expect(warned.diagnostics.map((d) => [d.code, d.severity])).toEqual([
      ['HYDE_SENSITIVE_EXPLICIT', 'warning'],
    ])
    expect(warned.files).not.toBeNull()
  })

  it('D59: a zero statementTimeout is a warning, not an error; the files are still written', () => {
    const result = build(datamodel(model('User', [scalar('id', '@hyde.visible')])), {
      statementTimeout: '0s',
    })
    expect(result.diagnostics.map((d) => [d.code, d.severity])).toEqual([
      ['HYDE_TIMEOUT_DISABLED', 'warning'],
    ])
    expect(result.files?.['redacted-views.sql']).toContain("SET statement_timeout = '0s'")
  })

  it('D60: a leftover @ai.* annotation is a warning, not an error; the files are still written', () => {
    const result = build(
      datamodel(model('User', [scalar('id', '@hyde.visible'), scalar('name', '@ai.hidden')])),
      { strict: 'false' },
    )
    expect(result.diagnostics.map((d) => [d.code, d.severity])).toEqual([
      ['HYDE_LEGACY_ANNOTATION', 'warning'],
    ])
    expect(result.files).not.toBeNull()
    expect(result.views[0]?.columns.map((c) => c.column)).toEqual(['id'])
  })

  it('builds an empty datamodel into valid, view-less files', () => {
    const result = build(datamodel())
    expect(result.views).toEqual([])
    expect(result.counts).toEqual({ visible: 0, hidden: 0 })
    expect(result.files?.['redacted-views.sql']).toContain('CREATE SCHEMA "redacted";')
  })
})

describe('public API', () => {
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
  ]
  const users = datamodel(model('User', [scalar('id', '@hyde.visible')]))

  it('D9: exports exactly build and analyze at runtime', () => {
    expect(Object.keys(api).sort()).toEqual(['analyze', 'build'])
  })

  it('D9: analyze returns diagnostics instead of throwing for exotic config values', () => {
    for (const [label, value] of exotic) {
      for (const key of ['strict', 'default', 'statementTimeout', 'role', 'schema', 'unknownKey']) {
        const skipped = (value === null || value === undefined) && key !== 'unknownKey'
        const config = { [key]: value }
        expect(analyze(users, config).diagnostics.length > 0, `analyze: ${label} for ${key}`).toBe(
          !skipped,
        )
        expect(build(users, config).files === null, `build: ${label} for ${key}`).toBe(!skipped)
      }
    }
  })

  it('D9: analyze and build accept any value as the whole config', () => {
    const wholes: readonly unknown[] = [...exotic.map(([, v]) => v), 5, 'strict', true]
    for (const value of wholes) {
      expect(() => analyze(users, value as GeneratorConfig), String(typeof value)).not.toThrow()
      expect(() => build(users, value as GeneratorConfig), String(typeof value)).not.toThrow()
    }
    expect(analyze(users, null as unknown as GeneratorConfig).diagnostics).toEqual([])
  })
})
