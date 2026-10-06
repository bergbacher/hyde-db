#!/usr/bin/env node
// Generator entry: the only module with I/O (D5). Under Prisma (PRISMA_GENERATOR_INVOCATION=true,
// no arguments, A34; any argument fails, D66) it speaks the line-delimited JSON-RPC protocol itself (D32): requests arrive
// on stdin, responses go to stderr, one JSON object per line (A19). Warnings and the success line
// go to stdout, which Prisma shows (D51, D28, A20). Anywhere else it prints help or the version
// and exits without touching stdin (D56).
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createInterface } from 'node:readline'
import { BRAND, DEFAULT_OUTPUT } from './brand.ts'
import { build } from './build.ts'
import {
  formatSummary,
  prismaArgumentsMessage,
  repositoryUrl,
  selectCommand,
  unknownArgumentMessage,
  usage,
} from './cli-help.ts'
import { DEFAULT_CONFIG } from './config.ts'
import {
  formatDiagnostic,
  formatReport,
  hasErrors,
  noOutputDirectory,
  unsupportedProvider,
} from './diagnostics.ts'
import type { Diagnostic, DmmfDatamodel, GeneratorConfig, OutputFiles } from './types.ts'

interface GenerateParams {
  readonly generator: {
    readonly output?: { readonly value?: string | null } | null
    readonly config?: GeneratorConfig
  }
  readonly dmmf: { readonly datamodel: DmmfDatamodel }
  readonly datasources?: readonly { readonly provider?: string; readonly activeProvider?: string }[]
}

interface Request {
  /** Undefined only in a JSON-RPC notification, which gets no response; `null` is an id. */
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

/** Runs one file-system step; a failure names the path it was for and the reason. */
function attempt<T>(path: string, step: () => T): T {
  try {
    return step()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`${BRAND}: could not write ${path}: ${reason}`)
  }
}

/**
 * Writes every file under a temporary name in a directory inside `outDir`, then renames each into
 * place, so no output file is ever half-written; the temporary directory goes in any case.
 */
function writeOutput(outDir: string, files: OutputFiles): void {
  attempt(outDir, () => mkdirSync(outDir, { recursive: true }))
  const staging = attempt(outDir, () => mkdtempSync(join(outDir, `.${BRAND}-`)))
  const names = Object.keys(files) as (keyof OutputFiles)[]
  try {
    for (const name of names) {
      attempt(join(outDir, name), () => writeFileSync(join(staging, name), files[name]))
    }
    for (const name of names) {
      attempt(join(outDir, name), () => renameSync(join(staging, name), join(outDir, name)))
    }
  } finally {
    attempt(staging, () => rmSync(staging, { recursive: true, force: true }))
  }
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

  writeOutput(outDir, result.files)
  for (const warning of diagnostics)
    process.stdout.write(`${BRAND}: ${formatDiagnostic(warning)}\n`)
  const where = relative(process.cwd(), outDir) || '.'
  process.stdout.write(
    `${formatSummary({ views: result.views.length, ...result.counts }, where)}\n`,
  )
}

function dispatch(request: Request): Reply {
  try {
    if (request.method === 'getManifest') {
      return {
        result: {
          manifest: { prettyName: 'Redacted read-only views', defaultOutput: DEFAULT_OUTPUT },
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
      if (id !== undefined) send({ id, ...reply })
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
} else if (command.kind === 'prisma-arguments') {
  process.stderr.write(`${prismaArgumentsMessage(command.arguments)}\n`)
  process.exitCode = 2
} else {
  process.stderr.write(`${unknownArgumentMessage(command.argument)}\n`)
  process.exitCode = 2
}
