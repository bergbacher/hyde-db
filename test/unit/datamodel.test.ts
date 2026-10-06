import { describe, expect, it } from 'vitest'
import { toDatamodel } from '../../src/datamodel.ts'
import { datamodel, model, scalar } from '../helpers/dmmf.ts'

describe('datamodel adapter', () => {
  it('D7: resolves table and column names and fills defaults', () => {
    const dm = toDatamodel(
      datamodel(
        model(
          'User',
          [
            scalar('id', '@ai.visible', { isId: true }),
            scalar('fullName', undefined, { dbName: 'full_name' }),
          ],
          {
            dbName: 'users',
            documentation: 'A customer.',
          },
        ),
        model('Plain', [scalar('id')]),
      ),
    )
    expect(dm.models[0]).toEqual({
      name: 'User',
      table: 'users',
      schema: null,
      documentation: 'A customer.',
      fields: [
        {
          name: 'id',
          column: 'id',
          kind: 'scalar',
          type: 'String',
          isList: false,
          isRequired: true,
          isId: true,
          documentation: '@ai.visible',
          relationFromFields: [],
          relationToFields: [],
        },
        {
          name: 'fullName',
          column: 'full_name',
          kind: 'scalar',
          type: 'String',
          isList: false,
          isRequired: true,
          isId: false,
          documentation: '',
          relationFromFields: [],
          relationToFields: [],
        },
      ],
    })
    expect(dm.models[1]).toMatchObject({ table: 'Plain', schema: null, documentation: '' })
  })

  it('D7: keeps scalar, enum and object kinds and folds every other kind into "other"', () => {
    const dm = toDatamodel(
      datamodel(
        model(
          'M',
          [
            scalar('a'),
            scalar('b', undefined, { kind: 'enum', type: 'Plan' }),
            scalar('c', undefined, {
              kind: 'object',
              type: 'Other',
              relationFromFields: ['a'],
              relationToFields: ['id'],
            }),
            scalar('d', undefined, { kind: 'unsupported' }),
          ],
          { schema: 'auth' },
        ),
      ),
    )
    expect(dm.models[0]?.schema).toBe('auth')
    expect(dm.models[0]?.fields.map((f) => f.kind)).toEqual(['scalar', 'enum', 'object', 'other'])
    expect(dm.models[0]?.fields[2]).toMatchObject({
      relationFromFields: ['a'],
      relationToFields: ['id'],
    })
  })

  it('D47: accepts the DMMF datamodel exactly as Prisma provides it', async () => {
    const { parseSchema } = await import('../helpers/prisma.ts')
    const { datamodel: dmmf } = parseSchema(
      'datasource db {\n  provider = "postgresql"\n}\nmodel A {\n  id Int @id\n  @@map("a_table")\n}\n',
    )
    expect(toDatamodel(dmmf).models[0]).toMatchObject({ name: 'A', table: 'a_table', schema: null })
  })
})
