import { describe, expect, it } from 'vitest'
import { analyze } from '../../src/analyze.ts'
import { build } from '../../src/build.ts'
import { DEFAULT_CONFIG } from '../../src/config.ts'
import { toDatamodel } from '../../src/datamodel.ts'
import { DIALECTS, dialectFor } from '../../src/dialects/index.ts'
import { datamodel, model, scalar } from '../helpers/dmmf.ts'

describe('D104, D114: dialect registry', () => {
  it('D114: postgresql resolves to its dialect; its sourceSchemaOf keeps the model schema over the config', () => {
    const d = dialectFor('postgresql')
    expect(d?.provider).toBe('postgresql')
    expect(DIALECTS.postgresql).toBe(d)
    const { models } = toDatamodel(
      datamodel(model('A', [scalar('id')], { schema: 'auth' }), model('B', [scalar('id')])),
    )
    const a = models.find((m) => m.name === 'A')
    const b = models.find((m) => m.name === 'B')
    if (a === undefined || b === undefined) throw new Error('models missing')
    expect(d?.sourceSchemaOf(a, DEFAULT_CONFIG)).toBe('auth')
    expect(d?.sourceSchemaOf(b, DEFAULT_CONFIG)).toBe('public')
    expect(d?.viewRules(DEFAULT_CONFIG, [])).toEqual([])
  })

  it('D114: the PostgreSQL dialect validates with the postgresql key set and applies the D12 rules', () => {
    const d = dialectFor('postgresql')
    expect(d?.validate({ role: 'r' }).config).toMatchObject({ dialect: 'postgresql', role: 'r' })
    const { models } = toDatamodel(datamodel(model('A', [scalar('id')], { schema: 'redacted' })))
    expect(d?.configRules(DEFAULT_CONFIG, models).map((x) => x.code)).toEqual([
      'HYDE_SCHEMA_CONFLICT',
    ])
  })

  it('D142: dialectFor answers undefined for an unregistered provider, also an inherited key', () => {
    expect(dialectFor('oracle')).toBeUndefined()
    expect(dialectFor('constructor')).toBeUndefined()
  })

  it('D107: omitting the third argument means postgresql, and a 1.0 call gives the 1.0 result', () => {
    const dm = datamodel(model('User', [scalar('id', '@hyde.visible', { isId: true })]))
    expect(build(dm, {})).toEqual(build(dm, {}, { provider: 'postgresql' }))
    expect(analyze(dm)).toEqual(analyze(dm, {}, {}))
  })

  it('D142: a JavaScript caller passing null options gets the postgresql result, never a throw', () => {
    const dm = datamodel(model('User', [scalar('id', '@hyde.visible', { isId: true })]))
    expect(analyze(dm, {}, null as never)).toEqual(analyze(dm))
    expect(build(dm, {}, null as never)).toEqual(build(dm))
  })

  it('D142: an unknown provider never throws; it is one diagnostic and no files', () => {
    const r = build(datamodel(), {}, { provider: 'oracle' as never })
    expect(r.diagnostics.map((d) => d.code)).toEqual(['HYDE_UNSUPPORTED_PROVIDER'])
    expect(r.diagnostics[0]?.message).toContain('only postgresql and mysql are supported')
    expect(r.config.dialect).toBe('postgresql')
    expect(r.files).toBeNull()
  })
})
