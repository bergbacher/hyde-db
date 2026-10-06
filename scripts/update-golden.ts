// Rewrites the golden files of every characterization case from the current build.
// Only for intentional, ledger-backed output changes (D6); review the diff before committing.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { build } from '../src/build.ts'
import { parseSchema } from '../test/helpers/prisma.ts'

const CASES = ['example', 'test/fixtures/characterization/loose']

for (const dir of CASES) {
  const { datamodel, config } = parseSchema(readFileSync(join(dir, 'schema.prisma'), 'utf8'))
  const result = build(datamodel, config)
  if (result.files === null)
    throw new Error(`${dir}: ${JSON.stringify(result.diagnostics, null, 2)}`)
  mkdirSync(join(dir, 'ai'), { recursive: true })
  for (const [name, content] of Object.entries(result.files)) {
    writeFileSync(join(dir, 'ai', name), content)
  }
  console.log(`updated ${dir}/ai`)
}
