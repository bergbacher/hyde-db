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

describe('D142, D159: build and analyze never throw on any options or provider value', () => {
  const dm = () => datamodel(model('User', [scalar('id', '@hyde.visible', { isId: true })]))
  const revoked = (() => {
    const { proxy, revoke } = Proxy.revocable({}, {})
    revoke()
    return proxy
  })()
  const throwingToString = {
    toString() {
      throw new Error('toString')
    },
  }
  const providers: [string, unknown][] = [
    ['a Symbol', Symbol('x')],
    ['a null-prototype object', Object.create(null)],
    ['an object whose toString throws', throwingToString],
    ['a revoked Proxy', revoked],
    ['a number', 7],
    ['a function', () => 'mysql'],
  ]

  it.each(providers)(
    '%s as provider is one diagnostic and no files, never a throw',
    (_n, provider) => {
      const r = build(dm(), {}, { provider } as never)
      expect(r.diagnostics.map((d) => d.code)).toEqual(['HYDE_UNSUPPORTED_PROVIDER'])
      expect(r.diagnostics[0]?.message).toContain('only postgresql and mysql are supported')
      expect(r.diagnostics[0]?.message).toContain(`not a string (${typeof provider})`)
      expect(r.files).toBeNull()
      expect(analyze(dm(), {}, { provider } as never).diagnostics).toHaveLength(1)
    },
  )

  const options: [string, unknown][] = [
    ['a Symbol', Symbol('x')],
    ['a null-prototype object', Object.create(null)],
    ['an object whose toString throws', throwingToString],
    ['a revoked Proxy', revoked],
  ]

  it.each(options)('%s as options never throws', (_n, opts) => {
    expect(() => build(dm(), {}, opts as never)).not.toThrow()
    expect(() => analyze(dm(), {}, opts as never)).not.toThrow()
  })

  it('a revoked Proxy as options is an unreadable provider: the diagnostic, no files', () => {
    const r = build(dm(), {}, revoked as never)
    expect(r.diagnostics.map((d) => d.code)).toEqual(['HYDE_UNSUPPORTED_PROVIDER'])
    expect(r.files).toBeNull()
  })

  it('a string provider is still quoted in the message', () => {
    const r = build(dm(), {}, { provider: 'oracle' } as never)
    expect(r.diagnostics[0]?.message).toContain('(datasource provider is "oracle")')
  })
})

describe('the MySQL dialect (Task 11)', () => {
  const user = () => model('User', [scalar('id', '@hyde.visible', { isId: true })])

  it('D113: on MySQL, views carry sourceSchema null and the config is the mysql member', () => {
    const r = analyze(datamodel(user()), {}, { provider: 'mysql' })
    expect(r.config.dialect).toBe('mysql')
    expect(r.views[0]?.sourceSchema).toBeNull()
  })

  it('D114, D117: MySQL has no generate-time schema-equals-source rule', () => {
    expect(analyze(datamodel(), { schema: 'redacted' }, { provider: 'mysql' }).diagnostics).toEqual(
      [],
    )
  })

  it('D167: a model whose table is hyde_db_abort, in any case, collides with the abort table, which holds the name first', () => {
    for (const dbName of ['hyde_db_abort', 'Hyde_DB_Abort']) {
      const found = analyze(
        datamodel({ ...user(), dbName }),
        {},
        { provider: 'mysql' },
      ).diagnostics.filter((d) => d.code === 'HYDE_VIEW_NAME_COLLISION')
      expect(found).toHaveLength(1)
      expect(found[0]?.message).toContain('the hyde-db abort table and ')
    }
  })

  it('D115, D157: a model whose table is hyde_db_marker collides with the marker view, which holds the name first', () => {
    const dm = datamodel(
      model('Marker', [scalar('id', '@hyde.visible', { isId: true })], {
        dbName: 'hyde_db_marker',
      }),
    )
    const found = analyze(dm, {}, { provider: 'mysql' }).diagnostics.filter(
      (d) => d.code === 'HYDE_VIEW_NAME_COLLISION',
    )
    expect(found).toHaveLength(1)
    expect(found[0]?.message).toContain('the hyde-db marker view and hyde_db_marker')
  })

  it('D157, D152: the marker-name collision ignores case, as servers with lower_case_table_names do', () => {
    const dm = datamodel(
      model('Marker', [scalar('id', '@hyde.visible', { isId: true })], {
        dbName: 'Hyde_Db_Marker',
      }),
    )
    const found = analyze(dm, {}, { provider: 'mysql' }).diagnostics.filter(
      (d) => d.code === 'HYDE_VIEW_NAME_COLLISION',
    )
    expect(found).toHaveLength(1)
    expect(found[0]?.message).toContain('Hyde_Db_Marker')
  })

  it('D115: the marker-name rule is MySQL only; PostgreSQL accepts that table name', () => {
    const dm = datamodel(
      model('Marker', [scalar('id', '@hyde.visible', { isId: true })], {
        dbName: 'hyde_db_marker',
      }),
    )
    expect(analyze(dm).diagnostics).toEqual([])
  })

  it('A80: @@map and @map give views over the mapped table and column names on MySQL', () => {
    const dm = datamodel(
      model('User', [scalar('id', '@hyde.visible', { isId: true, dbName: 'user_id' })], {
        dbName: 'users',
      }),
    )
    const r = build(dm, {}, { provider: 'mysql' })
    expect(r.views[0]?.name).toBe('users')
    expect(r.views[0]?.columns[0]?.column).toBe('user_id')
    expect(r.files?.['redacted-views.sql']).toContain('`users`')
    expect(r.files?.['redacted-views.sql']).toContain('`user_id`')
  })

  it('D107: build with provider mysql renders the three MySQL files', () => {
    const r = build(datamodel(user()), {}, { provider: 'mysql' })
    expect(r.files?.['redacted-views.sql']).toContain('hyde_db_marker')
    expect(r.files?.['redacted-views-drop.sql']).toContain('DROP DATABASE IF EXISTS')
    expect(r.files?.['redacted-schema.md']).toContain('MySQL')
  })

  it('D97: sourceSchema on MySQL makes build return no files', () => {
    expect(build(datamodel(), { sourceSchema: 'app' }, { provider: 'mysql' }).files).toBeNull()
  })

  it('D104: mysql is registered, sourceSchemaOf is null and configRules is empty (D113, D114)', () => {
    const d = dialectFor('mysql')
    expect(d?.provider).toBe('mysql')
    expect(Object.keys(DIALECTS)).toContain('mysql')
    const config = analyze(datamodel(), {}, { provider: 'mysql' }).config
    const models = toDatamodel(datamodel(user())).models
    expect(d?.sourceSchemaOf(models[0] as never, config as never)).toBeNull()
    expect(d?.configRules(config as never, models)).toEqual([])
  })
})
