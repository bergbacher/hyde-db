import { describe, expect, it } from 'vitest'
import { parseDoc, readFieldAnnotations, readModelAnnotations } from '../../src/annotations.ts'
import { toDatamodel } from '../../src/datamodel.ts'
import { datamodel, model, scalar } from '../helpers/dmmf.ts'

function modelWithDoc(documentation: string) {
  const m = toDatamodel(datamodel(model('User', [], { documentation }))).models[0]
  if (m === undefined) throw new Error('unreachable')
  return m
}

function fieldWithDoc(documentation: string) {
  const f = toDatamodel(datamodel(model('User', [scalar('email', documentation)]))).models[0]
    ?.fields[0]
  if (f === undefined) throw new Error('unreachable')
  return f
}

describe('parseDoc', () => {
  it('separates tags from doc text, line by line', () => {
    expect(parseDoc('@hyde.visible\nISO 3166 country code')).toEqual({
      tags: [{ name: 'visible', arg: undefined }],
      text: 'ISO 3166 country code',
    })
    expect(parseDoc('')).toEqual({ tags: [], text: '' })
  })

  it('reads arguments, trims them and strips surrounding quotes', () => {
    expect(parseDoc('@hyde.default( "visible" )').tags).toEqual([
      { name: 'default', arg: 'visible' },
    ])
    expect(parseDoc("@hyde.default('hidden')").tags).toEqual([{ name: 'default', arg: 'hidden' }])
    expect(parseDoc('@hyde.default()').tags).toEqual([{ name: 'default', arg: '' }])
  })

  it('keeps text around tags on the same line and handles several tags per line', () => {
    expect(parseDoc('Total in cents @hyde.visible').text).toBe('Total in cents')
    expect(parseDoc('@hyde.visible @hyde.hidden').tags.map((t) => t.name)).toEqual([
      'visible',
      'hidden',
    ])
  })

  it('D54: the old @ai. namespace is not an annotation', () => {
    expect(parseDoc('@ai.visible')).toEqual({ tags: [], text: '@ai.visible' })
    expect(parseDoc('@ai.default(visible)\n@ai.exclude').tags).toEqual([])
    expect(readFieldAnnotations('User', fieldWithDoc('@ai.hidden')).visibility).toBeUndefined()
  })

  it('treats CRLF line endings like LF', () => {
    expect(parseDoc('@hyde.visible\r\nISO code\r\n')).toEqual(parseDoc('@hyde.visible\nISO code\n'))
  })
})

describe('model annotations', () => {
  it('reads @hyde.exclude and valid @hyde.default arguments', () => {
    expect(readModelAnnotations(modelWithDoc('Internal only.\n@hyde.exclude'))).toEqual({
      excluded: true,
      defaults: [],
      text: 'Internal only.',
      diagnostics: [],
    })
    expect(readModelAnnotations(modelWithDoc('@hyde.default(visible)')).defaults).toEqual([
      'visible',
    ])
  })

  it('D25: an unknown model annotation names the closest model annotation', () => {
    const [d] = readModelAnnotations(modelWithDoc('@hyde.exlude')).diagnostics
    expect(d).toMatchObject({
      code: 'HYDE_ANNOTATION_UNKNOWN',
      location: 'model User',
      message: 'unknown annotation @hyde.exlude (did you mean @hyde.exclude?)',
    })
  })

  it('reports an invalid @hyde.default argument and field annotations on a model', () => {
    const { diagnostics, defaults } = readModelAnnotations(
      modelWithDoc('@hyde.default(maybe)\n@hyde.visible'),
    )
    expect(defaults).toEqual([])
    expect(diagnostics.map((d) => d.code)).toEqual([
      'HYDE_ANNOTATION_INVALID_ARGUMENT',
      'HYDE_ANNOTATION_MISPLACED',
    ])
    expect(diagnostics[1]?.message).toBe(
      'use @hyde.default(visible) on models; @hyde.visible is for fields',
    )
  })
})

describe('field annotations', () => {
  it('reads visibility and doc text', () => {
    expect(readFieldAnnotations('User', fieldWithDoc('@hyde.hidden\nLogin address'))).toEqual({
      visibility: 'hidden',
      text: 'Login address',
      diagnostics: [],
    })
    expect(readFieldAnnotations('User', fieldWithDoc('')).visibility).toBeUndefined()
  })

  it('reports both @hyde.visible and @hyde.hidden; the last one wins', () => {
    const result = readFieldAnnotations('User', fieldWithDoc('@hyde.visible\n@hyde.hidden'))
    expect(result.visibility).toBe('hidden')
    expect(result.diagnostics.map((d) => d.code)).toEqual(['HYDE_ANNOTATION_CONFLICT'])
    expect(result.diagnostics[0]?.location).toBe('User.email')
  })

  it('D25: an unknown field annotation names the closest field annotation', () => {
    const [d] = readFieldAnnotations('User', fieldWithDoc('@hyde.visable')).diagnostics
    expect(d?.message).toBe('unknown annotation @hyde.visable (did you mean @hyde.visible?)')
    const [far] = readFieldAnnotations('User', fieldWithDoc('@hyde.public')).diagnostics
    expect(far?.message).toBe('unknown annotation @hyde.public')
  })

  it('reports model annotations written on a field', () => {
    const { diagnostics } = readFieldAnnotations(
      'User',
      fieldWithDoc('@hyde.exclude\n@hyde.default(hidden)'),
    )
    expect(diagnostics.map((d) => [d.code, d.message])).toEqual([
      ['HYDE_ANNOTATION_MISPLACED', '@hyde.exclude is a model annotation'],
      ['HYDE_ANNOTATION_MISPLACED', '@hyde.default is a model annotation'],
    ])
  })
})
