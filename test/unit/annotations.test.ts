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
    expect(parseDoc('@ai.visible\nISO 3166 country code')).toEqual({
      tags: [{ name: 'visible', arg: undefined }],
      text: 'ISO 3166 country code',
    })
    expect(parseDoc('')).toEqual({ tags: [], text: '' })
  })

  it('reads arguments, trims them and strips surrounding quotes', () => {
    expect(parseDoc('@ai.default( "visible" )').tags).toEqual([{ name: 'default', arg: 'visible' }])
    expect(parseDoc("@ai.default('hidden')").tags).toEqual([{ name: 'default', arg: 'hidden' }])
    expect(parseDoc('@ai.default()').tags).toEqual([{ name: 'default', arg: '' }])
  })

  it('keeps text around tags on the same line and handles several tags per line', () => {
    expect(parseDoc('Total in cents @ai.visible').text).toBe('Total in cents')
    expect(parseDoc('@ai.visible @ai.hidden').tags.map((t) => t.name)).toEqual([
      'visible',
      'hidden',
    ])
  })

  it('treats CRLF line endings like LF', () => {
    expect(parseDoc('@ai.visible\r\nISO code\r\n')).toEqual(parseDoc('@ai.visible\nISO code\n'))
  })
})

describe('model annotations', () => {
  it('reads @ai.exclude and valid @ai.default arguments', () => {
    expect(readModelAnnotations(modelWithDoc('Internal only.\n@ai.exclude'))).toEqual({
      excluded: true,
      defaults: [],
      text: 'Internal only.',
      diagnostics: [],
    })
    expect(readModelAnnotations(modelWithDoc('@ai.default(visible)')).defaults).toEqual(['visible'])
  })

  it('D25: an unknown model annotation names the closest model annotation', () => {
    const [d] = readModelAnnotations(modelWithDoc('@ai.exlude')).diagnostics
    expect(d).toMatchObject({
      code: 'HYDE_ANNOTATION_UNKNOWN',
      location: 'model User',
      message: 'unknown annotation @ai.exlude (did you mean @ai.exclude?)',
    })
  })

  it('reports an invalid @ai.default argument and field annotations on a model', () => {
    const { diagnostics, defaults } = readModelAnnotations(
      modelWithDoc('@ai.default(maybe)\n@ai.visible'),
    )
    expect(defaults).toEqual([])
    expect(diagnostics.map((d) => d.code)).toEqual([
      'HYDE_ANNOTATION_INVALID_ARGUMENT',
      'HYDE_ANNOTATION_MISPLACED',
    ])
    expect(diagnostics[1]?.message).toBe(
      'use @ai.default(visible) on models; @ai.visible is for fields',
    )
  })
})

describe('field annotations', () => {
  it('reads visibility and doc text', () => {
    expect(readFieldAnnotations('User', fieldWithDoc('@ai.hidden\nLogin address'))).toEqual({
      visibility: 'hidden',
      text: 'Login address',
      diagnostics: [],
    })
    expect(readFieldAnnotations('User', fieldWithDoc('')).visibility).toBeUndefined()
  })

  it('reports both @ai.visible and @ai.hidden; the last one wins', () => {
    const result = readFieldAnnotations('User', fieldWithDoc('@ai.visible\n@ai.hidden'))
    expect(result.visibility).toBe('hidden')
    expect(result.diagnostics.map((d) => d.code)).toEqual(['HYDE_ANNOTATION_CONFLICT'])
    expect(result.diagnostics[0]?.location).toBe('User.email')
  })

  it('D25: an unknown field annotation names the closest field annotation', () => {
    const [d] = readFieldAnnotations('User', fieldWithDoc('@ai.visable')).diagnostics
    expect(d?.message).toBe('unknown annotation @ai.visable (did you mean @ai.visible?)')
    const [far] = readFieldAnnotations('User', fieldWithDoc('@ai.public')).diagnostics
    expect(far?.message).toBe('unknown annotation @ai.public')
  })

  it('reports model annotations written on a field', () => {
    const { diagnostics } = readFieldAnnotations(
      'User',
      fieldWithDoc('@ai.exclude\n@ai.default(hidden)'),
    )
    expect(diagnostics.map((d) => [d.code, d.message])).toEqual([
      ['HYDE_ANNOTATION_MISPLACED', '@ai.exclude is a model annotation'],
      ['HYDE_ANNOTATION_MISPLACED', '@ai.default is a model annotation'],
    ])
  })
})
