import { describe, expect, it } from 'vitest'
import { build } from '../../src/build.ts'
import * as api from '../../src/index.ts'
import { datamodel, model, scalar } from '../helpers/dmmf.ts'

describe('build', () => {
  it('returns the analysis plus the three output files', () => {
    const result = build(
      datamodel(model('User', [scalar('id', '@ai.visible')], { dbName: 'users' })),
    )
    expect(Object.keys(result.files ?? {})).toEqual([
      'ai-views.sql',
      'ai-views-drop.sql',
      'ai-schema.md',
    ])
    expect(result.views.map((v) => v.name)).toEqual(['users'])
    expect(result.counts).toEqual({ visible: 1, hidden: 0 })
  })

  it('returns no files when any diagnostic is an error, but keeps warnings-only builds', () => {
    expect(build(datamodel(model('User', [scalar('phone')])), { strict: 'true' }).files).toBeNull()
    expect(build(datamodel(model('User', [scalar('email', '@ai.visible')]))).files).not.toBeNull()
  })

  it('builds an empty datamodel into valid, view-less files', () => {
    const result = build(datamodel())
    expect(result.views).toEqual([])
    expect(result.counts).toEqual({ visible: 0, hidden: 0 })
    expect(result.files?.['ai-views.sql']).toContain('CREATE SCHEMA "ai";')
  })
})

describe('public API', () => {
  it('D9: exports exactly build and analyze at runtime', () => {
    expect(Object.keys(api).sort()).toEqual(['analyze', 'build'])
  })
})
