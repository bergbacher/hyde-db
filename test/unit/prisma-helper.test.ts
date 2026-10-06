import { describe, expect, it } from 'vitest'
import { readRepoFile } from '../helpers/files.ts'
import { forMajor, parseSchema } from '../helpers/prisma.ts'

const example = readRepoFile('example', 'schema.prisma')

const schemaWith = (generators: string): string =>
  `datasource db {\n  provider = "postgresql"\n}\n${generators}\nmodel A {\n  id Int @id\n}\n`

describe('Prisma schema helper', () => {
  it('A22: returns the config of the generator named "redacted" exactly as Prisma passes it', () => {
    expect(parseSchema(example).config).toEqual({ strict: 'true' })
  })

  it('fails loudly when a hyde-db generator is not named "redacted"', () => {
    expect(() => parseSchema(schemaWith('generator views {\n  provider = "hyde-db"\n}'))).toThrow(
      'declares a generator with provider "hyde-db" but none is named "redacted" (found: views)',
    )
    expect(
      parseSchema(schemaWith('generator redacted {\n  provider = "hyde-db"\n  strict = "false"\n}'))
        .config,
    ).toEqual({ strict: 'false' })
  })

  it('returns an empty config only for a schema without any hyde-db generator', () => {
    expect(parseSchema(schemaWith('')).config).toEqual({})
    expect(
      parseSchema(schemaWith('generator client {\n  provider = "prisma-client-js"\n}')).config,
    ).toEqual({})
  })

  it('adds the datasource url that only Prisma 6 requires', () => {
    expect(forMajor(example, 7)).toBe(example)
    expect(forMajor(example, 6)).toContain('provider = "postgresql"\n  url = env("DATABASE_URL")')
  })

  it('A19: Prisma 6 and 7 engines return the same datamodel for the example schema', () => {
    expect(parseSchema(example, 6).datamodel).toEqual(parseSchema(example, 7).datamodel)
    expect(parseSchema(example).datamodel.models.map((m) => m.name)).toEqual([
      'User',
      'Order',
      'ApiKey',
    ])
  })
})
