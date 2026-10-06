// Drives src/generator.ts the way the Prisma CLI does: JSON-RPC requests on stdin,
// responses on stderr, one JSON object per line (A19).
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { build } from '../../src/index.ts'
import { OUTPUT_FILES, readRepoFile, repoRoot } from '../helpers/files.ts'
import { parseSchema } from '../helpers/prisma.ts'

interface RpcResponse {
  readonly id: number
  readonly result?: unknown
  readonly error?: { readonly code: number; readonly message: string }
}

interface Session {
  readonly responses: RpcResponse[]
  readonly stdout: string
}

/** Objects are sent as JSON lines; strings are sent verbatim. */
function runGenerator(requests: readonly (object | string)[]): Promise<Session> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join(repoRoot, 'src', 'generator.ts')], {
      cwd: repoRoot,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', () => {
      const responses = stderr
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line) as RpcResponse)
      resolvePromise({ responses, stdout })
    })
    for (const request of requests) {
      child.stdin.write(`${typeof request === 'string' ? request : JSON.stringify(request)}\n`)
    }
    child.stdin.end()
  })
}

function generateRequest(schema: string, overrides: { config?: object; provider?: string } = {}) {
  const { datamodel, config } = parseSchema(schema)
  const output = mkdtempSync(join(tmpdir(), 'hyde-gen-'))
  const provider = overrides.provider ?? 'postgresql'
  return {
    output,
    request: {
      jsonrpc: '2.0',
      id: 2,
      method: 'generate',
      params: {
        generator: {
          output: { value: output, fromEnvVar: null },
          config: overrides.config ?? config,
        },
        dmmf: { datamodel },
        datasources: [{ name: 'db', provider, activeProvider: provider }],
      },
    },
  }
}

const example = readRepoFile('example', 'schema.prisma')

describe('generator protocol', () => {
  it('A19: answers getManifest on stderr with the default output ./ai', async () => {
    const { responses, stdout } = await runGenerator([
      { jsonrpc: '2.0', id: 1, method: 'getManifest', params: {} },
    ])
    expect(responses).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        result: { manifest: { prettyName: 'AI read-only views', defaultOutput: './ai' } },
      },
    ])
    expect(stdout).toBe('')
  })

  it('D28: generate writes the three files and prints one summary line on stdout', async () => {
    const { output, request } = generateRequest(example)
    const { responses, stdout } = await runGenerator([request])
    expect(responses).toEqual([{ jsonrpc: '2.0', id: 2, result: null }])
    const { datamodel, config } = parseSchema(example)
    const expected = build(datamodel, config).files
    for (const file of OUTPUT_FILES) {
      expect(readFileSync(join(output, file), 'utf8')).toBe(expected?.[file])
    }
    expect(stdout).toBe(
      `hyde-db: 2 views, 8 visible and 6 hidden columns → ${relative(repoRoot, output)}\n`,
    )
  })

  it('D51: warnings go to stdout before the summary on success', async () => {
    const schema = example.replace('/// @ai.hidden\n  email', '/// @ai.visible\n  email')
    const { request } = generateRequest(schema)
    const { responses, stdout } = await runGenerator([request])
    expect(responses[0]?.result).toBeNull()
    expect(stdout.split('\n')[0]).toBe(
      'hyde-db: warning HYDE_SENSITIVE_EXPLICIT at User.email: explicitly visible although the name looks sensitive — double-check',
    )
  })

  it('D51: any error fails generate with one message listing every diagnostic, and writes nothing', async () => {
    const { output, request } = generateRequest(example, {
      config: { strickt: 'true', default: 'hiden' },
    })
    const { responses, stdout } = await runGenerator([request])
    expect(responses[0]?.error?.code).toBe(-32000)
    const message = responses[0]?.error?.message ?? ''
    expect(message.split('\n')[0]).toBe('hyde-db found 2 problems:')
    expect(message).toContain(
      'error HYDE_CONFIG_UNKNOWN_KEY at config.strickt: unknown config key "strickt" (did you mean "strict"?)',
    )
    expect(message).toContain('error HYDE_CONFIG_INVALID_VALUE at config.default')
    expect(message).toContain('    fix: ')
    expect(existsSync(join(output, 'ai-views.sql'))).toBe(false)
    expect(stdout).toBe('')
  })

  it('a non-PostgreSQL datasource fails with HYDE_UNSUPPORTED_PROVIDER', async () => {
    const { request } = generateRequest(example, { provider: 'mysql' })
    const { responses } = await runGenerator([request])
    expect(responses[0]?.error?.message).toContain('error HYDE_UNSUPPORTED_PROVIDER at datasource')
  })

  it('A20: never writes JSON-RPC messages to stdout and ignores malformed lines', async () => {
    const { request } = generateRequest(example)
    const child = await runGenerator(['not json', '"a string"', '', request])
    expect(child.responses).toHaveLength(1)
    expect(child.stdout).not.toContain('jsonrpc')
  })
})
