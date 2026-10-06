// Drives src/generator.ts the way the Prisma CLI does: PRISMA_GENERATOR_INVOCATION=true (A34),
// JSON-RPC requests on stdin, responses on stderr, one JSON object per line (A19).
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
  readonly stderr: string
  readonly stdout: string
}

/**
 * Every non-empty stderr line must be a JSON-RPC response with a numeric id (A19, A20). Nothing
 * is filtered: a stray line (a Node warning, a debug print) fails the test that provoked it.
 */
function parseResponses(stderr: string): RpcResponse[] {
  return stderr
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const message: unknown = JSON.parse(line)
      expect(message, line).toMatchObject({ jsonrpc: '2.0', id: expect.any(Number) })
      return message as RpcResponse
    })
}

/** Objects are sent as JSON lines; strings are sent verbatim. */
function runGenerator(requests: readonly (object | string)[]): Promise<Session> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join(repoRoot, 'src', 'generator.ts')], {
      cwd: repoRoot,
      env: { ...process.env, PRISMA_GENERATOR_INVOCATION: 'true' },
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
      try {
        resolvePromise({ responses: parseResponses(stderr), stderr, stdout })
      } catch (error) {
        reject(error)
      }
    })
    for (const request of requests) {
      child.stdin.write(`${typeof request === 'string' ? request : JSON.stringify(request)}\n`)
    }
    child.stdin.end()
  })
}

function generateRequest(
  schema: string,
  overrides: { config?: object; provider?: string; output?: string } = {},
) {
  const { datamodel, config } = parseSchema(schema)
  const output = overrides.output ?? mkdtempSync(join(tmpdir(), 'hyde-gen-'))
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
  it('A19: answers getManifest on stderr with the default output ./redacted', async () => {
    const { responses, stdout } = await runGenerator([
      { jsonrpc: '2.0', id: 1, method: 'getManifest', params: {} },
    ])
    expect(responses).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        result: {
          manifest: { prettyName: 'Redacted read-only views', defaultOutput: './redacted' },
        },
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
    const schema = example.replace('/// @hyde.hidden\n  email', '/// @hyde.visible\n  email')
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
    expect(existsSync(join(output, 'redacted-views.sql'))).toBe(false)
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

  it('A19: a request without an id is a notification and gets no response', async () => {
    const { responses, stderr } = await runGenerator([
      { jsonrpc: '2.0', method: 'getManifest', params: {} },
      { jsonrpc: '2.0', id: 7, method: 'getManifest', params: {} },
    ])
    expect(responses.map((response) => response.id)).toEqual([7])
    expect(stderr.split('\n').filter((line) => line !== '')).toHaveLength(1)
  })

  it('A20: stderr carries only JSON-RPC lines, one per request that has an id', async () => {
    const { request } = generateRequest(example)
    const failing = generateRequest(example, { provider: 'mysql' }).request
    const { responses, stderr, stdout } = await runGenerator([
      { jsonrpc: '2.0', id: 1, method: 'getManifest', params: {} },
      'not json',
      request,
      { jsonrpc: '2.0', id: 3, method: 'nope' },
      { ...failing, id: 4 },
    ])
    const lines = stderr.split('\n').filter((line) => line !== '')
    expect(lines).toHaveLength(4)
    for (const line of lines) {
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0', id: expect.any(Number) })
    }
    expect(responses.map((response) => response.id)).toEqual([1, 2, 3, 4])
    expect(stdout).not.toContain('jsonrpc')
  })

  it('D28: writes the three files into a nested output directory that does not exist yet', async () => {
    const output = join(mkdtempSync(join(tmpdir(), 'hyde-gen-')), 'nested', 'redacted')
    expect(existsSync(output)).toBe(false)
    const { request } = generateRequest(example, { output })
    const { responses } = await runGenerator([request])
    expect(responses).toEqual([{ jsonrpc: '2.0', id: 2, result: null }])
    for (const file of OUTPUT_FILES) expect(existsSync(join(output, file)), file).toBe(true)
  })

  it('A19: answers getManifest then generate in one session, in order', async () => {
    const { output, request } = generateRequest(example)
    const { responses, stdout } = await runGenerator([
      { jsonrpc: '2.0', id: 1, method: 'getManifest', params: {} },
      request,
    ])
    expect(responses).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        result: {
          manifest: { prettyName: 'Redacted read-only views', defaultOutput: './redacted' },
        },
      },
      { jsonrpc: '2.0', id: 2, result: null },
    ])
    for (const file of OUTPUT_FILES) expect(existsSync(join(output, file)), file).toBe(true)
    expect(stdout).toContain('hyde-db: 2 views')
  })

  it('A19: an unknown method gets JSON-RPC error -32601', async () => {
    const { responses } = await runGenerator([{ jsonrpc: '2.0', id: 9, method: 'frobnicate' }])
    expect(responses).toEqual([
      {
        jsonrpc: '2.0',
        id: 9,
        error: { code: -32601, message: 'hyde-db: unknown method frobnicate' },
      },
    ])
  })
})
