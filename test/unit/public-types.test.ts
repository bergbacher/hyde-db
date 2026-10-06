import { describe, expect, expectTypeOf, it } from 'vitest'
import { analyze, viewCollisions } from '../../src/analyze.ts'
import { CONFIG_KEYS, DEFAULT_CONFIG, validateConfig } from '../../src/config.ts'
import { toDatamodel } from '../../src/datamodel.ts'
import { postgresqlConfigRules } from '../../src/dialects/postgresql.ts'
import type { PostgresqlConfig, ResolvedConfig, View } from '../../src/index.ts'
import { renderApplySql } from '../../src/render/apply-sql.ts'
import { datamodel, model, scalar } from '../helpers/dmmf.ts'
import { config, users } from '../helpers/views.ts'

describe('D112: forward-compatible public types', () => {
  it('D112: View.sourceSchema is nullable; the config is a union discriminated on dialect', () => {
    expectTypeOf<View['sourceSchema']>().toEqualTypeOf<string | null>()
    expectTypeOf<ResolvedConfig['dialect']>().toEqualTypeOf<'postgresql'>()
    expectTypeOf<ResolvedConfig>().toEqualTypeOf<PostgresqlConfig>()
  })

  it('D112: the dialect is resolved, never a generator-block key', () => {
    expect(DEFAULT_CONFIG.dialect).toBe('postgresql')
    expect(analyze(datamodel()).config.dialect).toBe('postgresql')
    expect(CONFIG_KEYS).not.toContain('dialect')
    const { config: resolved, diagnostics } = validateConfig({ dialect: 'mysql' })
    expect(diagnostics.map((d) => [d.code, d.location])).toEqual([
      ['HYDE_CONFIG_UNKNOWN_KEY', 'config.dialect'],
    ])
    expect(resolved.dialect).toBe('postgresql')
    expect(analyze(datamodel(), { dialect: 'mysql' }).config.dialect).toBe('postgresql')
  })

  it('D12: the PostgreSQL dialect rules report both conflicts, views schema first', () => {
    const { models } = toDatamodel(datamodel(model('Audit', [scalar('id')], { schema: 'public' })))
    expect(
      postgresqlConfigRules({ ...DEFAULT_CONFIG, schema: 'public' }, models).map((d) => [
        d.code,
        d.location,
      ]),
    ).toEqual([
      ['HYDE_SCHEMA_CONFLICT', 'config.schema'],
      ['HYDE_SCHEMA_CONFLICT', 'model Audit'],
    ])
    expect(postgresqlConfigRules(DEFAULT_CONFIG, models)).toEqual([])
  })

  it('D112: the apply renderer qualifies a null source schema with config.sourceSchema', () => {
    const sql = renderApplySql({ config, views: [{ ...users, sourceSchema: null }] })
    expect(sql).toContain('FROM "public"."users";')
    expect(sql).not.toContain('"null"')
  })

  it('D112: a collision message with a null source schema has no schema prefix', () => {
    const a = { ...users, sourceSchema: null }
    const b = { ...users, sourceSchema: 'auth' }
    expect(viewCollisions([a, b]).map((d) => d.message)).toEqual([
      'view name collision "users": users and auth.users',
    ])
    expect(viewCollisions([b, a]).map((d) => d.message)).toEqual([
      'view name collision "users": auth.users and users',
    ])
  })
})
