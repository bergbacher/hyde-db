// Rewrites the golden files of every characterization case from the current build.
// Only for intentional, ledger-backed output changes (D6); review the diff before committing.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { build } from '../src/build.ts'
import { parseSchema } from '../test/helpers/prisma.ts'

const CASES = ['example', 'test/fixtures/characterization/loose', 'example-mysql']

for (const dir of CASES) {
  const { datamodel, config, provider } = parseSchema(
    readFileSync(join(dir, 'schema.prisma'), 'utf8'),
  )
  const result = build(datamodel, config, { provider })
  if (result.files === null)
    throw new Error(`${dir}: ${JSON.stringify(result.diagnostics, null, 2)}`)
  mkdirSync(join(dir, 'redacted'), { recursive: true })
  for (const [name, content] of Object.entries(result.files)) {
    writeFileSync(join(dir, 'redacted', name), content)
  }
  console.log(`updated ${dir}/redacted`)
}
