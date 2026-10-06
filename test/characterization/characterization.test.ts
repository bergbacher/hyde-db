import { describe, expect, it } from 'vitest'
import { build } from '../../src/index.ts'
import { OUTPUT_FILES, readRepoFile } from '../helpers/files.ts'
import { parseSchema } from '../helpers/prisma.ts'

const CASES = [
  { name: 'example', dir: 'example' },
  { name: 'loose', dir: 'test/fixtures/characterization/loose' },
] as const

describe('characterization', () => {
  for (const testCase of CASES) {
    it(`D6: reproduces the golden files of the ${testCase.name} schema`, () => {
      const { datamodel, config } = parseSchema(readRepoFile(testCase.dir, 'schema.prisma'))
      const result = build(datamodel, config)
      expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
      for (const file of OUTPUT_FILES) {
        expect(result.files?.[file], file).toBe(readRepoFile(testCase.dir, 'ai', file))
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
    expect(result.files?.['ai-views.sql']).not.toContain('email')
    expect(result.files?.['ai-views.sql']).not.toContain('api_keys')
  })
})
