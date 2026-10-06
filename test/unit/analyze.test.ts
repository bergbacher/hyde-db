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
            scalar('id', '@ai.visible', { type: 'Int', isId: true }),
            scalar('plan', '@ai.visible', { kind: 'enum', type: 'Plan' }),
            scalar('tags', '@ai.visible', { isList: true }),
            scalar('nick', '@ai.visible\nShown name', { isRequired: false }),
            scalar('fullName', '@ai.hidden', { dbName: 'full_name' }),
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
      datamodel(model('User', [scalar('id', '@ai.visible'), scalar('phone')])),
      strict,
    )
    expect(a.diagnostics).toMatchObject([
      { code: 'HYDE_STRICT_UNANNOTATED', location: 'User.phone' },
    ])
    expect(a.views[0]?.columns.map((c) => c.column)).toEqual(['id'])
  })

  it('strict mode rejects @ai.default on models', () => {
    const a = analyze(
      datamodel(
        model('User', [scalar('id', '@ai.visible')], { documentation: '@ai.default(visible)' }),
      ),
      strict,
    )
    expect(codes(a)).toEqual(['HYDE_STRICT_MODEL_DEFAULT'])
  })

  it('non-strict: unannotated fields follow the global default, then the model default', () => {
    const hidden = analyze(
      datamodel(model('M', [scalar('id', '@ai.visible'), scalar('title')])),
      loose,
    )
    expect(hidden.views[0]?.columns.map((c) => c.column)).toEqual(['id'])
    const visible = analyze(
      datamodel(
        model('M', [scalar('id'), scalar('title')], { documentation: '@ai.default(visible)' }),
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
      datamodel(model('Gone', [scalar('secret')], { documentation: '@ai.default(visible)' })),
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
    const a = analyze(datamodel(model('M', [scalar('email', '@ai.visible')])))
    expect(a.diagnostics).toMatchObject([
      { code: 'HYDE_SENSITIVE_EXPLICIT', severity: 'warning', location: 'M.email' },
    ])
    expect(a.views[0]?.columns.map((c) => c.column)).toEqual(['email'])
  })

  it('relation fields are never exposed; annotating one is a warning', () => {
    const a = analyze(
      datamodel(
        model('Order', [
          scalar('id', '@ai.visible'),
          scalar('user', '@ai.visible', {
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
          scalar('id', '@ai.visible'),
          scalar('geom', '@ai.visible', { kind: 'unsupported' }),
        ]),
      ),
    )
    expect(a.views[0]?.columns.map((c) => c.column)).toEqual(['id'])
    expect(a.counts).toEqual({ visible: 1, hidden: 0 })
  })

  it('@ai.exclude drops the model; a model without visible columns gets no view', () => {
    const a = analyze(
      datamodel(
        model('Secret', [scalar('id', '@ai.visible')], { documentation: '@ai.exclude' }),
        model('Empty', [scalar('id', '@ai.hidden')]),
      ),
    )
    expect(a.views).toEqual([])
    expect(a.counts).toEqual({ visible: 0, hidden: 2 })
  })

  it('describes relations whose FK columns are visible and whose target has a view', () => {
    const user = model('User', [scalar('id', '@ai.visible', { type: 'Int' })], { dbName: 'users' })
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
          scalar('id', '@ai.visible'),
          scalar('userId', fkDoc, { dbName: 'user_id' }),
          relation(['userId']),
        ],
        {
          dbName: 'orders',
        },
      )
    expect(analyze(datamodel(user, order('@ai.visible'))).views[1]?.relations).toEqual([
      { fromCols: ['user_id'], target: 'users', targetModel: 'User', toCols: ['id'] },
    ])
    expect(analyze(datamodel(user, order('@ai.hidden'))).views[1]?.relations).toEqual([])
    const hiddenTarget = model('User', [scalar('id', '@ai.hidden')], { dbName: 'users' })
    expect(analyze(datamodel(hiddenTarget, order('@ai.visible'))).views[0]?.relations).toEqual([])
  })

  it('ignores relations to unknown models and keeps unknown field names as written', () => {
    const a = analyze(
      datamodel(
        model('Order', [
          scalar('id', '@ai.visible'),
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
    expect(a.views[0]?.relations).toEqual([
      { fromCols: ['id'], target: 'Order', targetModel: 'Order', toCols: ['missing'] },
    ])
  })

  it('reports view name collisions across schemas', () => {
    const a = analyze(
      datamodel(
        model('A', [scalar('id', '@ai.visible')], { dbName: 'users', schema: 'public' }),
        model('B', [scalar('id', '@ai.visible')], { dbName: 'users', schema: 'auth' }),
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
    const a = analyze(datamodel(model('M', [scalar('id', '@ai.visable')])), {
      ...strict,
      strickt: 'true',
    })
    expect(codes(a)).toEqual([
      'HYDE_CONFIG_UNKNOWN_KEY',
      'HYDE_ANNOTATION_UNKNOWN',
      'HYDE_STRICT_UNANNOTATED',
    ])
  })

  it('the AI schema must differ from the source schema', () => {
    const a = analyze(datamodel(), { schema: 'public' })
    expect(a.diagnostics).toMatchObject([
      { code: 'HYDE_SCHEMA_CONFLICT', location: 'config.schema' },
    ])
  })
})
