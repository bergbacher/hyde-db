// A12: CommonJS code can require() the ESM-only package on every supported Node version.
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createProject, run } from './helpers.mjs'

describe('module formats', () => {
  it(`A12: CommonJS code can require("@hyde/db") on Node ${process.version}`, () => {
    const dir = createProject('cjs', [])
    writeFileSync(
      join(dir, 'check.cjs'),
      "const api = require('@hyde/db')\nif (typeof api.build !== 'function' || typeof api.analyze !== 'function') process.exit(1)\n",
    )
    const result = run(process.execPath, ['check.cjs'], { cwd: dir })
    assert.equal(result.status, 0, result.output)
  })

  it('D5: ESM code can import build and analyze', () => {
    const dir = createProject('esm', [])
    writeFileSync(
      join(dir, 'check.mjs'),
      "import { analyze, build } from '@hyde/db'\nif (typeof build !== 'function' || typeof analyze !== 'function') process.exit(1)\n",
    )
    const result = run(process.execPath, ['check.mjs'], { cwd: dir })
    assert.equal(result.status, 0, result.output)
  })
})
