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

  it('D53: describes privacy, not one kind of reader, and stays discoverable', () => {
    expect(pkg.description).toBe(
      'Prisma generator that turns /// @hyde annotations into read-only PostgreSQL views with sensitive columns removed, plus a locked-down reader role',
    )
    expect(pkg.keywords).toEqual(
      expect.arrayContaining([
        'prisma',
        'prisma-generator',
        'postgresql',
        'privacy',
        'pii',
        'redaction',
        'views',
        'read-only',
        'llm',
      ]),
    )
    expect(pkg.keywords).not.toContain('ai')
  })

  it('D31: engines.node is ^20.19 || ^22.12 || >=24', () => {
    expect(pkg.engines).toEqual({ node: '^20.19 || ^22.12 || >=24' })
  })

  it('D36: pins pnpm 10 as the package manager', () => {
    expect(pkg.packageManager).toBe('pnpm@10.34.1')
  })

  it('D63: names the GitHub repository, which npm provenance checks, and publishes publicly with provenance', () => {
    expect(pkg.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/bergbacher/hyde-db.git',
    })
    expect(pkg.homepage).toBe('https://github.com/bergbacher/hyde-db#readme')
    expect(pkg.bugs).toBe('https://github.com/bergbacher/hyde-db/issues')
    expect(pkg.publishConfig).toEqual({ access: 'public', provenance: true })
  })

  it('D55: stays discoverable to agent tooling', () => {
    expect(pkg.keywords).toContain('mcp')
  })
})
