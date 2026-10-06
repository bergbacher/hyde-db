// Parses a Prisma schema with the schema engine of a given Prisma major, returning exactly
// what `prisma generate` hands a generator: the DMMF datamodel and the config of the
// generator block named "ai" (A19, A22).
import { createRequire } from 'node:module'
import type { DmmfDatamodel } from '../../src/types.ts'

export type PrismaMajor = 6 | 7

interface SchemaWasm {
  get_dmmf(params: string): string
  get_config(params: string): string
}

const require = createRequire(import.meta.url)
const engines: Record<PrismaMajor, SchemaWasm> = {
  6: require('prisma-schema-wasm-6') as SchemaWasm,
  7: require('prisma-schema-wasm-7') as SchemaWasm,
}

export interface ParsedSchema {
  readonly datamodel: DmmfDatamodel
  readonly config: Record<string, unknown>
}

/** Prisma 6 requires `url` in the datasource block; Prisma 7 rejects it (it lives in prisma.config.ts). */
export function forMajor(source: string, major: PrismaMajor): string {
  if (major === 7) return source
  return source.replace(
    /(datasource\s+\w+\s*\{[^}]*?provider\s*=\s*"[^"]*")/,
    '$1\n  url = env("DATABASE_URL")',
  )
}

export function parseSchema(source: string, major: PrismaMajor = 7): ParsedSchema {
  const prismaSchema = forMajor(source, major)
  const engine = engines[major]
  const dmmf = JSON.parse(engine.get_dmmf(JSON.stringify({ prismaSchema, noColor: true }))) as {
    datamodel: DmmfDatamodel
  }
  const loaded = JSON.parse(engine.get_config(JSON.stringify({ prismaSchema }))) as {
    config: { generators: { name: string; config: Record<string, unknown> }[] }
  }
  const generator = loaded.config.generators.find((g) => g.name === 'ai')
  return { datamodel: dmmf.datamodel, config: generator?.config ?? {} }
}
