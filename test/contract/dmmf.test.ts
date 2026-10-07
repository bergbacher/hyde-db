// DMMF contract: Prisma 6's and Prisma 7's schema engines must yield identical results (D20, D30).
import { describe, expect, it } from 'vitest'
import { build } from '../../src/index.ts'
import { readRepoFile } from '../helpers/files.ts'
import { type PrismaMajor, parseSchema } from '../helpers/prisma.ts'

const FIXTURES = {
  example: readRepoFile('example', 'schema.prisma'),
  loose: readRepoFile('test/fixtures/characterization/loose', 'schema.prisma'),
  features: readRepoFile('test/fixtures/contract', 'features.prisma'),
  mysqlFeatures: readRepoFile('test/fixtures/contract', 'mysql-features.prisma'),
} as const

const MAJORS: readonly PrismaMajor[] = [6, 7]

describe('DMMF contract', () => {
  for (const [name, source] of Object.entries(FIXTURES)) {
    it(`A19: Prisma 6 and 7 engines yield identical build results for ${name}`, () => {
      const [six, seven] = MAJORS.map((major) => {
        const { datamodel, config } = parseSchema(source, major)
        return build(datamodel, config)
      })
      expect(six).toEqual(seven)
      expect(seven?.files).not.toBeNull()
    })
  }

  it('A80, D103: the MySQL fixture yields identical views and diagnostics on Prisma 6 and 7', () => {
    const [six, seven] = MAJORS.map((major) => {
      const { datamodel, config, provider } = parseSchema(FIXTURES.mysqlFeatures, major)
      expect(provider).toBe('mysql')
      return build(datamodel, config, { provider })
    })
    expect(six?.views).toEqual(seven?.views)
    expect(six?.diagnostics).toEqual(seven?.diagnostics)
    expect(seven?.files).not.toBeNull()
  })

  it.each(MAJORS)(
    'A80: @map and @@map arrive as dbName, a view block as a model, no schema on MySQL models (Prisma %i)',
    (major) => {
      const { datamodel, config, provider } = parseSchema(FIXTURES.mysqlFeatures, major)
      const user = datamodel.models.find((m) => m.name === 'User')
      expect(user?.dbName).toBe('users')
      expect(user?.fields.find((f) => f.name === 'email')?.dbName).toBe('email_address')
      expect(user?.fields.find((f) => f.name === 'role')?.kind).toBe('enum')
      expect(datamodel.models.map((m) => m.name)).toContain('UserInfo')
      expect(datamodel.models.every((m) => !('schema' in m) || m.schema == null)).toBe(true)
      const result = build(datamodel, config, { provider })
      expect(result.diagnostics).toEqual([])
      expect(result.views.find((v) => v.model === 'UserInfo')?.sourceSchema).toBeNull()
    },
  )

  it.each(MAJORS)(
    'A21: @ignore fields, @@ignore models and Unsupported fields never reach the core (Prisma %i)',
    (major) => {
      const { datamodel, config } = parseSchema(FIXTURES.features, major)
      const user = datamodel.models.find((m) => m.name === 'User')
      expect(user?.fields.map((f) => f.name)).toEqual(['id', 'email', 'posts', 'role', 'tags'])
      expect(datamodel.models.map((m) => m.name)).not.toContain('Legacy')
      const result = build(datamodel, config)
      expect(result.diagnostics).toEqual([])
      expect(result.files?.['redacted-views.sql']).not.toMatch(/geom|secret|Legacy/)
    },
  )

  it.each(MAJORS)('D34: a Prisma view block is processed as a model (Prisma %i)', (major) => {
    const { datamodel, config } = parseSchema(FIXTURES.features, major)
    const view = build(datamodel, config).views.find((v) => v.model === 'UserInfo')
    expect(view).toMatchObject({
      name: 'UserInfo',
      sourceSchema: 'public',
      doc: 'A read-only report',
    })
    expect(view?.columns.map((c) => c.column)).toEqual(['id'])
  })

  it.each(MAJORS)(
    'A22: config values arrive as strings and env("X") as the literal "X" (Prisma %i)',
    (major) => {
      const source = FIXTURES.example.replace(
        'strict   = "true"',
        'strict   = "true"\n  role     = env("READER_ROLE")\n  schema   = ["redacted"]',
      )
      const { datamodel, config } = parseSchema(source, major)
      expect(config).toEqual({ strict: 'true', role: 'READER_ROLE', schema: ['redacted'] })
      const locations = build(datamodel, config).diagnostics.map((d) => [d.code, d.location])
      expect(locations).toEqual([
        ['HYDE_CONFIG_INVALID_VALUE', 'config.schema'],
        ['HYDE_CONFIG_INVALID_VALUE', 'config.role'],
      ])
    },
  )

  it('A19: a multi-key config yields identical diagnostics on Prisma 6 and 7', () => {
    const source = FIXTURES.example.replace(
      'strict   = "true"',
      'strict   = "ture"\n  zeta     = "1"\n  schema   = "REDACTED"\n  alpha    = "2"\n  role     = "R"',
    )
    const [six, seven] = MAJORS.map((major) => {
      const { datamodel, config } = parseSchema(source, major)
      return build(datamodel, config).diagnostics
    })
    expect(six).toEqual(seven)
    expect(six?.map((d) => d.location)).toEqual([
      'config.schema',
      'config.role',
      'config.strict',
      'config.alpha',
      'config.zeta',
    ])
  })
})
