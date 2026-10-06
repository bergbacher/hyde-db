#!/usr/bin/env node
// Generator entry: the only module with I/O (D5). Under Prisma (PRISMA_GENERATOR_INVOCATION=true,
// no arguments, A34) it speaks the line-delimited JSON-RPC protocol itself (D32): requests arrive
// on stdin, responses go to stderr, one JSON object per line (A19). Warnings and the success line
// go to stdout, which Prisma shows (D51, D28, A20). Anywhere else it prints help or the version
// and exits without touching stdin (D56).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createInterface } from 'node:readline'
import { BRAND } from './brand.ts'
import { build } from './build.ts'
import { repositoryUrl, selectCommand, unknownArgumentMessage, usage } from './cli-help.ts'
import { DEFAULT_CONFIG } from './config.ts'
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
  /** Absent in a JSON-RPC notification, which gets no response. */
  readonly id?: unknown
  readonly method: string
  readonly params?: unknown
}

type Reply =
  | { readonly result: unknown }
  | { readonly error: { readonly code: number; readonly message: string; readonly data?: unknown } }

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

function dispatch(request: Request): Reply {
  try {
    if (request.method === 'getManifest') {
      return {
        result: {
          manifest: { prettyName: 'Redacted read-only views', defaultOutput: './redacted' },
        },
      }
    }
    if (request.method === 'generate') {
      generate(request.params as GenerateParams)
      return { result: null }
    }
    return { error: { code: -32601, message: `${BRAND}: unknown method ${request.method}` } }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    return { error: { code: -32000, message: err.message, data: { stack: err.stack ?? '' } } }
  }
}

function serve(): void {
  createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY }).on(
    'line',
    (line) => {
      let request: unknown
      try {
        request = JSON.parse(line)
      } catch {
        return
      }
      if (typeof request !== 'object' || request === null || !('method' in request)) return
      const { id } = request as Request
      const reply = dispatch(request as Request)
      if (typeof id === 'number' || typeof id === 'string') send({ id, ...reply })
    },
  )
}

/** package.json sits one level above both src/ and dist/, so the same URL works from either. */
function readPackage(): { readonly version?: unknown; readonly repository?: unknown } {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
}

const command = selectCommand(
  process.argv.slice(2),
  process.env.PRISMA_GENERATOR_INVOCATION === 'true',
)
if (command.kind === 'protocol') {
  serve()
} else if (command.kind === 'help') {
  const text = usage(DEFAULT_CONFIG, repositoryUrl(readPackage().repository))
  process.stdout.write(`${text}\n`)
} else if (command.kind === 'version') {
  process.stdout.write(`${String(readPackage().version)}\n`)
} else {
  process.stderr.write(`${unknownArgumentMessage(command.argument)}\n`)
  process.exitCode = 2
}
