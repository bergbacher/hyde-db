import { describe, expect, it } from 'vitest'
import { analyze } from '../../src/analyze.ts'
import { datamodel, model, scalar } from '../helpers/dmmf.ts'
import { readRepoFile } from '../helpers/files.ts'
import { parseSchema } from '../helpers/prisma.ts'

const strict = { strict: 'true' }
const loose = { strict: 'false' }
const codes = (a: ReturnType<typeof analyze>): string[] => a.diagnostics.map((d) => d.code)

describe('analysis rules', () => {
  it('exposes explicitly visible scalar and enum fields with their types', () => {
    const a = analyze(
      datamodel(
        model(
          'User',
          [
            scalar('id', '@hyde.visible', { type: 'Int', isId: true }),
            scalar('plan', '@hyde.visible', { kind: 'enum', type: 'Plan' }),
            scalar('tags', '@hyde.visible', { isList: true }),
            scalar('nick', '@hyde.visible\nShown name', { isRequired: false }),
            scalar('fullName', '@hyde.hidden', { dbName: 'full_name' }),
          ],
          { dbName: 'users', documentation: 'A customer.' },
        ),
      ),
    )
    expect(a.diagnostics).toEqual([])
    expect(a.views).toEqual([
      {
        model: 'User',
        name: 'users',
        sourceSchema: 'public',
        source: 'users',
        doc: 'A customer.',
        relations: [],
        columns: [
          { column: 'id', field: 'id', type: 'Int', nullable: false, isId: true, doc: '' },
          {
            column: 'plan',
            field: 'plan',
            type: 'enum Plan',
            nullable: false,
            isId: false,
            doc: '',
          },
          {
            column: 'tags',
            field: 'tags',
            type: 'String[]',
            nullable: false,
            isId: false,
            doc: '',
          },
          {
            column: 'nick',
            field: 'nick',
            type: 'String',
            nullable: true,
            isId: false,
            doc: 'Shown name',
          },
        ],
      },
    ])
  })

  it('D48: counts visible and hidden scalar/enum columns across all models', () => {
    const { datamodel: dmmf, config } = parseSchema(readRepoFile('example', 'schema.prisma'))
    expect(analyze(dmmf, config).counts).toEqual({ visible: 8, hidden: 6 })
  })

  it('strict mode requires an annotation on every scalar field', () => {
    const a = analyze(
      datamodel(model('User', [scalar('id', '@hyde.visible'), scalar('phone')])),
      strict,
    )
    expect(a.diagnostics).toMatchObject([
      { code: 'HYDE_STRICT_UNANNOTATED', location: 'User.phone' },
    ])
    expect(a.views[0]?.columns.map((c) => c.column)).toEqual(['id'])
  })

  it('D57: analyze never returns a conflicting column as visible', () => {
    for (const doc of ['@hyde.visible\n@hyde.hidden', '@hyde.hidden\n@hyde.visible']) {
      const a = analyze(datamodel(model('User', [scalar('id', '@hyde.visible'), scalar('x', doc)])))
      expect(a.views[0]?.columns.map((c) => c.column)).toEqual(['id'])
      expect(a.diagnostics).toMatchObject([
        { code: 'HYDE_ANNOTATION_CONFLICT', severity: 'error', location: 'User.x' },
      ])
      expect(a.counts).toEqual({ visible: 1, hidden: 1 })
    }
  })

  it('D54: under strict mode an unannotated field stays hidden even with default visible', () => {
    const a = analyze(
      datamodel(model('User', [scalar('id', '@hyde.visible'), scalar('nickname')])),
      { strict: 'true', default: 'visible' },
    )
    expect(a.views[0]?.columns.map((c) => c.column)).toEqual(['id'])
    expect(a.diagnostics).toMatchObject([
      { code: 'HYDE_STRICT_UNANNOTATED', location: 'User.nickname' },
    ])
  })

  it('D54: a field annotated only with the old @ai.visible is unannotated under strict mode', () => {
    const a = analyze(
      datamodel(model('User', [scalar('id', '@hyde.visible'), scalar('phone', '@ai.visible')])),
      strict,
    )
    expect(a.diagnostics).toMatchObject([
      { code: 'HYDE_LEGACY_ANNOTATION', location: 'User.phone' },
      { code: 'HYDE_STRICT_UNANNOTATED', location: 'User.phone' },
    ])
    expect(a.views[0]?.columns.map((c) => c.column)).toEqual(['id'])
  })

  it('D60: under strict mode a leftover @ai.hidden warns and the field is still unannotated', () => {
    const a = analyze(
      datamodel(model('User', [scalar('id', '@hyde.visible'), scalar('phone', '@ai.hidden')])),
      strict,
    )
    expect(a.diagnostics).toMatchObject([
      { code: 'HYDE_LEGACY_ANNOTATION', severity: 'warning', location: 'User.phone' },
      { code: 'HYDE_STRICT_UNANNOTATED', severity: 'error', location: 'User.phone' },
    ])
    expect(a.views[0]?.columns.map((c) => c.column)).toEqual(['id'])
  })

  it('D60: a leftover @ai.hidden does not hide anything; the field stays under @hyde.* and defaults', () => {
    const a = analyze(datamodel(model('Note', [scalar('title', '@ai.hidden')])), {
      ...loose,
      default: 'visible',
    })
    expect(codes(a)).toEqual(['HYDE_LEGACY_ANNOTATION'])
    expect(a.views[0]?.columns.map((c) => c.column)).toEqual(['title'])
  })

  it('D60: a leftover @ai.exclude on a model warns and the model keeps its view', () => {
    const a = analyze(
      datamodel(model('Note', [scalar('id', '@hyde.visible')], { documentation: '@ai.exclude' })),
    )
    expect(a.diagnostics).toMatchObject([
      { code: 'HYDE_LEGACY_ANNOTATION', severity: 'warning', location: 'model Note' },
    ])
    expect(a.views.map((v) => v.model)).toEqual(['Note'])
  })

  it('strict mode rejects @hyde.default on models', () => {
    const a = analyze(
      datamodel(
        model('User', [scalar('id', '@hyde.visible'), scalar('nickname')], {
          documentation: '@hyde.default(visible)',
        }),
      ),
      strict,
    )
    expect(codes(a)).toEqual(['HYDE_STRICT_MODEL_DEFAULT', 'HYDE_STRICT_UNANNOTATED'])
    expect(a.views[0]?.columns.map((c) => c.column)).toEqual(['id'])
  })

  it('non-strict: unannotated fields follow the global default, then the model default', () => {
    const hidden = analyze(
      datamodel(model('M', [scalar('id', '@hyde.visible'), scalar('title')])),
      loose,
    )
    expect(hidden.views[0]?.columns.map((c) => c.column)).toEqual(['id'])
    const visible = analyze(
      datamodel(
        model('M', [scalar('id'), scalar('title')], { documentation: '@hyde.default(visible)' }),
      ),
      loose,
    )
    expect(visible.views[0]?.columns.map((c) => c.column)).toEqual(['id', 'title'])
    const globalVisible = analyze(datamodel(model('M', [scalar('title')])), {
      ...loose,
      default: 'visible',
    })
    expect(globalVisible.views[0]?.columns.map((c) => c.column)).toEqual(['title'])
  })

  it('a sensitive name exposed through a default is an error, naming which default', () => {
    const viaModel = analyze(
      datamodel(model('Gone', [scalar('secret')], { documentation: '@hyde.default(visible)' })),
      loose,
    )
    expect(viaModel.diagnostics).toMatchObject([
      {
        code: 'HYDE_SENSITIVE_IMPLICIT',
        location: 'Gone.secret',
        message: 'name looks sensitive but would be exposed via the model default',
      },
    ])
    expect(viaModel.views).toEqual([])
    const viaGlobal = analyze(datamodel(model('M', [scalar('email')])), {
      ...loose,
      default: 'visible',
    })
    expect(viaGlobal.diagnostics[0]?.message).toContain('via the global default')
  })

  it('the sensitive lint checks the column name as well as the field name', () => {
    const a = analyze(datamodel(model('M', [scalar('contact', undefined, { dbName: 'email' })])), {
      ...loose,
      default: 'visible',
    })
    expect(codes(a)).toEqual(['HYDE_SENSITIVE_IMPLICIT'])
  })

  it('an explicitly visible sensitive name is exposed with a warning', () => {
    const a = analyze(datamodel(model('M', [scalar('email', '@hyde.visible')])))
    expect(a.diagnostics).toMatchObject([
      { code: 'HYDE_SENSITIVE_EXPLICIT', severity: 'warning', location: 'M.email' },
    ])
    expect(a.views[0]?.columns.map((c) => c.column)).toEqual(['email'])
  })

  it('relation fields are never exposed; annotating one is a warning', () => {
    const a = analyze(
      datamodel(
        model('Order', [
          scalar('id', '@hyde.visible'),
          scalar('user', '@hyde.visible', {
            kind: 'object',
            type: 'User',
            relationFromFields: [],
            relationToFields: [],
          }),
        ]),
      ),
    )
    expect(a.diagnostics).toMatchObject([
      { code: 'HYDE_RELATION_ANNOTATED', severity: 'warning', location: 'Order.user' },
    ])
    expect(a.views[0]?.columns.map((c) => c.column)).toEqual(['id'])
  })

  it('fields of other kinds are never exposed', () => {
    const a = analyze(
      datamodel(
        model('M', [
          scalar('id', '@hyde.visible'),
          scalar('geom', '@hyde.visible', { kind: 'unsupported' }),
        ]),
      ),
    )
    expect(a.views[0]?.columns.map((c) => c.column)).toEqual(['id'])
    expect(a.counts).toEqual({ visible: 1, hidden: 0 })
  })

  it('@hyde.exclude drops the model; a model without visible columns gets no view', () => {
    const a = analyze(
      datamodel(
        model('Secret', [scalar('id', '@hyde.visible')], { documentation: '@hyde.exclude' }),
        model('Empty', [scalar('id', '@hyde.hidden')]),
      ),
    )
    expect(a.views).toEqual([])
    expect(a.counts).toEqual({ visible: 0, hidden: 2 })
  })

  it('describes relations whose FK columns are visible and whose target has a view', () => {
    const user = model('User', [scalar('id', '@hyde.visible', { type: 'Int' })], {
      dbName: 'users',
    })
    const relation = (from: string[]) =>
      scalar('user', undefined, {
        kind: 'object',
        type: 'User',
        relationFromFields: from,
        relationToFields: ['id'],
      })
    const order = (fkDoc: string) =>
      model(
        'Order',
        [
          scalar('id', '@hyde.visible'),
          scalar('userId', fkDoc, { dbName: 'user_id' }),
          relation(['userId']),
        ],
        {
          dbName: 'orders',
        },
      )
    expect(analyze(datamodel(user, order('@hyde.visible'))).views[1]?.relations).toEqual([
      { fromCols: ['user_id'], target: 'users', targetModel: 'User', toCols: ['id'] },
    ])
    expect(analyze(datamodel(user, order('@hyde.hidden'))).views[1]?.relations).toEqual([])
    const hiddenTarget = model('User', [scalar('id', '@hyde.hidden')], { dbName: 'users' })
    expect(analyze(datamodel(hiddenTarget, order('@hyde.visible'))).views[0]?.relations).toEqual([])
  })

  it('ignores relations to unknown models and to columns the target view does not show', () => {
    const a = analyze(
      datamodel(
        model('Order', [
          scalar('id', '@hyde.visible'),
          scalar('ghost', undefined, {
            kind: 'object',
            type: 'Nope',
            relationFromFields: ['id'],
            relationToFields: ['id'],
          }),
          scalar('self', undefined, {
            kind: 'object',
            type: 'Order',
            relationFromFields: ['id'],
            relationToFields: ['missing'],
          }),
        ]),
      ),
    )
    // The self relation's target column is no column of the view, so it is not described (D146).
    expect(a.views[0]?.relations).toEqual([])
  })

  it('D146, A98: describes a join only when the target view shows every target column', () => {
    const user = (idDoc: string) =>
      model(
        'User',
        [scalar('id', idDoc, { type: 'Int' }), scalar('code', '@hyde.visible', { type: 'Int' })],
        { dbName: 'users' },
      )
    const order = (to: string[], from: string[] = ['userId']) =>
      model(
        'Order',
        [
          scalar('id', '@hyde.visible'),
          scalar('userId', '@hyde.visible', { dbName: 'user_id' }),
          scalar('user', undefined, {
            kind: 'object',
            type: 'User',
            relationFromFields: from,
            relationToFields: to,
          }),
        ],
        { dbName: 'orders' },
      )
    const join = { fromCols: ['user_id'], target: 'users', targetModel: 'User', toCols: ['id'] }
    expect(analyze(datamodel(user('@hyde.visible'), order(['id']))).views[1]?.relations).toEqual([
      join,
    ])
    // users.id is hidden, so the view users has no column id to join on.
    expect(analyze(datamodel(user('@hyde.hidden'), order(['id']))).views[1]?.relations).toEqual([])
    // A target column without a source column to pair with, as no Prisma schema gives.
    expect(
      analyze(datamodel(user('@hyde.visible'), order(['id', 'code']))).views[1]?.relations,
    ).toEqual([])
  })

  it('reports view name collisions across schemas', () => {
    const a = analyze(
      datamodel(
        model('A', [scalar('id', '@hyde.visible')], { dbName: 'users', schema: 'public' }),
        model('B', [scalar('id', '@hyde.visible')], { dbName: 'users', schema: 'auth' }),
      ),
    )
    expect(a.diagnostics).toMatchObject([
      {
        code: 'HYDE_VIEW_NAME_COLLISION',
        location: 'view users',
        message: 'view name collision "users": public.users and auth.users',
      },
    ])
  })

  it('D29: reports annotation and config problems together', () => {
    const a = analyze(datamodel(model('M', [scalar('id', '@hyde.visable')])), {
      ...strict,
      strickt: 'true',
    })
    expect(codes(a)).toEqual([
      'HYDE_CONFIG_UNKNOWN_KEY',
      'HYDE_ANNOTATION_UNKNOWN',
      'HYDE_STRICT_UNANNOTATED',
    ])
  })

  it('D12: the redacted schema must differ from the source schema', () => {
    const a = analyze(datamodel(), { schema: 'public' })
    expect(a.diagnostics).toMatchObject([
      { code: 'HYDE_SCHEMA_CONFLICT', location: 'config.schema' },
    ])
  })

  it("D12: the redacted schema must differ from every model's @@schema, excluded models included (A13)", () => {
    const a = analyze(
      datamodel(
        model('Audit', [scalar('id', '@hyde.visible')], { schema: 'redacted' }),
        model('Hidden', [scalar('id', '@hyde.visible')], {
          schema: 'redacted',
          documentation: '@hyde.exclude',
        }),
        model('User', [scalar('id', '@hyde.visible')], { schema: 'auth' }),
      ),
    )
    expect(a.diagnostics.map((d) => [d.code, d.location])).toEqual([
      ['HYDE_SCHEMA_CONFLICT', 'model Audit'],
      ['HYDE_SCHEMA_CONFLICT', 'model Hidden'],
    ])
  })

  it('D12: a multiSchema model in the redacted schema fails as Prisma parses it', () => {
    const { datamodel: dmmf, config } = parseSchema(
      'datasource db {\n  provider = "postgresql"\n  schemas  = ["redacted", "public"]\n}\ngenerator redacted {\n  provider = "hyde-db"\n}\nmodel Audit {\n  /// @hyde.visible\n  id Int @id\n  @@schema("redacted")\n}\n',
    )
    expect(analyze(dmmf, config).diagnostics.map((d) => d.code)).toEqual(['HYDE_SCHEMA_CONFLICT'])
  })
})
