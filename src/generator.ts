#!/usr/bin/env node
// Generator entry: the only module with I/O (D5). Speaks Prisma's line-delimited JSON-RPC
// protocol itself (D32): requests arrive on stdin, responses go to stderr, one JSON object
// per line (A19). Warnings and the success line go to stdout, which Prisma shows (D51, D28, A20).
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createInterface } from 'node:readline'
import { BRAND } from './brand.ts'
import { build } from './build.ts'
import {
  formatDiagnostic,
  formatReport,
  hasErrors,
  noOutputDirectory,
  unsupportedProvider,
} from './diagnostics.ts'
import type { Diagnostic, DmmfDatamodel, GeneratorConfig } from './types.ts'

interface GenerateParams {
  readonly generator: {
    readonly output?: { readonly value?: string | null } | null
    readonly config?: GeneratorConfig
  }
  readonly dmmf: { readonly datamodel: DmmfDatamodel }
  readonly datasources?: readonly { readonly provider?: string; readonly activeProvider?: string }[]
}

interface Request {
  readonly id: number
  readonly method: string
  readonly params?: unknown
}

function send(message: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

function generate(params: GenerateParams): void {
  const datasource = params.datasources?.[0]
  const provider = datasource?.activeProvider ?? datasource?.provider
  const outDir = params.generator.output?.value ?? undefined

  const result = build(params.dmmf.datamodel, params.generator.config ?? {})
  const diagnostics: Diagnostic[] = []
  if (provider !== undefined && provider !== 'postgresql')
    diagnostics.push(unsupportedProvider(provider))
  if (outDir === undefined) diagnostics.push(noOutputDirectory())
  diagnostics.push(...result.diagnostics)

  if (hasErrors(diagnostics) || result.files === null || outDir === undefined) {
    throw new Error(formatReport(diagnostics))
  }

  mkdirSync(outDir, { recursive: true })
  for (const [name, content] of Object.entries(result.files)) {
    writeFileSync(join(outDir, name), content)
  }
  for (const warning of diagnostics)
    process.stdout.write(`${BRAND}: ${formatDiagnostic(warning)}\n`)
  const where = relative(process.cwd(), outDir) || '.'
  process.stdout.write(
    `${BRAND}: ${result.views.length} views, ${result.counts.visible} visible and ` +
      `${result.counts.hidden} hidden columns → ${where}\n`,
  )
}

function handle(request: Request): void {
  try {
    if (request.method === 'getManifest') {
      send({
        id: request.id,
        result: { manifest: { prettyName: 'AI read-only views', defaultOutput: './ai' } },
      })
    } else if (request.method === 'generate') {
      generate(request.params as GenerateParams)
      send({ id: request.id, result: null })
    } else {
      send({
        id: request.id,
        error: { code: -32601, message: `${BRAND}: unknown method ${request.method}` },
      })
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    send({
      id: request.id,
      error: { code: -32000, message: err.message, data: { stack: err.stack ?? '' } },
    })
  }
}

createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY }).on(
  'line',
  (line) => {
    let request: unknown
    try {
      request = JSON.parse(line)
    } catch {
      return
    }
    if (typeof request === 'object' && request !== null && 'method' in request) {
      handle(request as Request)
    }
  },
)
