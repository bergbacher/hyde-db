import { describe, expect, it } from 'vitest'
import { readRepoFile } from '../helpers/files.ts'

const pkg = JSON.parse(readRepoFile('package.json')) as Record<string, unknown>

describe('package.json', () => {
  it('D3: is named hyde-db and installs a hyde-db bin', () => {
    expect(pkg.name).toBe('hyde-db')
    expect(pkg.bin).toEqual({ 'hyde-db': './dist/generator.mjs' })
  })

  it('D5: is ESM-only and publishes only dist', () => {
    expect(pkg.type).toBe('module')
    expect(pkg.exports).toEqual({ '.': './dist/index.mjs', './package.json': './package.json' })
    expect(pkg.main).toBeUndefined()
    expect(pkg.files).toEqual(['dist'])
  })

  it('D32: has no runtime dependencies', () => {
    expect(pkg.dependencies).toBeUndefined()
    expect(pkg.peerDependencies).toBeUndefined()
  })
})
