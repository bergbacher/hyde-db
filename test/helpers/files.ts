import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot: string = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export const OUTPUT_FILES = ['ai-views.sql', 'ai-views-drop.sql', 'ai-schema.md'] as const

export function readRepoFile(...segments: string[]): string {
  return readFileSync(join(repoRoot, ...segments), 'utf8')
}
