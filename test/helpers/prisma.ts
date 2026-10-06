// Parses a Prisma schema with the schema engine of a given Prisma major, returning exactly
// what `prisma generate` hands a generator: the DMMF datamodel and the config of the
// generator block named "redacted" (A19, A22).
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
    config: {
      generators: {
        name: string
        provider: { value: string | null }
        config: Record<string, unknown>
      }[]
    }
  }
  const { generators } = loaded.config
  const generator = generators.find((g) => g.name === 'redacted')
  if (generator === undefined) {
    // A schema with a hyde-db generator under another name would silently get the default
    // config; fail instead. Schemas with no hyde-db generator at all have no config.
    const others = generators.filter((g) => g.provider.value === 'hyde-db').map((g) => g.name)
    if (others.length > 0)
      throw new Error(
        `schema declares a generator with provider "hyde-db" but none is named "redacted" (found: ${others.join(', ')})`,
      )
  }
  return { datamodel: dmmf.datamodel, config: generator?.config ?? {} }
}
