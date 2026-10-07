import { describe, expect, it } from 'vitest'
import { build } from '../../src/index.ts'
import { OUTPUT_FILES, readRepoFile } from '../helpers/files.ts'
import { parseSchema } from '../helpers/prisma.ts'

const CASES = [
  { name: 'example', dir: 'example' },
  { name: 'loose', dir: 'test/fixtures/characterization/loose' },
  { name: 'example-mysql', dir: 'example-mysql' },
] as const

describe('characterization', () => {
  for (const testCase of CASES) {
    it(`D6: reproduces the golden files of the ${testCase.name} schema`, () => {
      const { datamodel, config, provider } = parseSchema(
        readRepoFile(testCase.dir, 'schema.prisma'),
      )
      const result = build(datamodel, config, { provider })
      expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
      for (const file of OUTPUT_FILES) {
        expect(result.files?.[file], file).toBe(readRepoFile(testCase.dir, 'redacted', file))
      }
    })
  }

  it('D6: the example schema exposes the base views and columns', () => {
    const { datamodel, config } = parseSchema(readRepoFile('example', 'schema.prisma'))
    const result = build(datamodel, config)
    expect(result.views.map((v) => v.name)).toEqual(['users', 'orders'])
    expect(result.views[0]?.columns.map((c) => c.column)).toEqual([
      'id',
      'created_at',
      'country',
      'plan',
    ])
    expect(result.files?.['redacted-views.sql']).not.toContain('email')
    expect(result.files?.['redacted-views.sql']).not.toContain('api_keys')
  })

  it('D6, D103: the MySQL example reproduces its golden files under the mysql provider', () => {
    const { datamodel, config, provider } = parseSchema(
      readRepoFile('example-mysql', 'schema.prisma'),
    )
    expect(provider).toBe('mysql')
    const sql = build(datamodel, config, { provider }).files?.['redacted-views.sql']
    expect(sql).toBe(readRepoFile('example-mysql', 'redacted', 'redacted-views.sql'))
    expect(sql).toContain("SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_BACKSLASH_ESCAPES';")
    expect(sql).toContain('hyde_db_marker')
    expect(sql).not.toContain('DELIMITER')
  })

  it('D103: the MySQL example hides what the PostgreSQL example hides', () => {
    const { datamodel, config, provider } = parseSchema(
      readRepoFile('example-mysql', 'schema.prisma'),
    )
    const result = build(datamodel, config, { provider })
    expect(result.views.map((v) => v.name)).toEqual(['users', 'orders'])
    const sql = result.files?.['redacted-views.sql']
    expect(sql).not.toContain('email')
    expect(sql).not.toContain('api_keys')
  })

  it('D54: without strict = "false" the loose schema fails with strict diagnostics', () => {
    const source = readRepoFile('test/fixtures/characterization/loose', 'schema.prisma').replace(
      '  strict   = "false"\n',
      '',
    )
    const { datamodel, config } = parseSchema(source)
    const result = build(datamodel, config)
    expect(result.files).toBeNull()
    const errors = new Set(
      result.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code),
    )
    expect(errors).toEqual(new Set(['HYDE_STRICT_UNANNOTATED', 'HYDE_STRICT_MODEL_DEFAULT']))
  })
})
