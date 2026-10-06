import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readRepoFile, repoRoot } from '../helpers/files.ts'

function integrationFiles(dir = join(repoRoot, 'test', 'integration')): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? integrationFiles(join(dir, entry.name)) : [join(dir, entry.name)],
  )
}

describe('integration policy', () => {
  it('D22: the integration suite has no skip paths and the container start is not caught', () => {
    for (const file of integrationFiles()) {
      const source = readRepoFile(file.slice(repoRoot.length + 1))
      expect(source, file).not.toMatch(/\.(skip|skipIf|runIf|todo)\b|\bctx\.skip\(/)
    }
    expect(readRepoFile('test', 'integration', 'global-setup.ts')).not.toMatch(
      /\btry\s*\{|\.catch\s*\(/,
    )
  })
})
