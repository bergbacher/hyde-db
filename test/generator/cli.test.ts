// Drives src/generator.ts as a person or an agent does outside Prisma: arguments instead of
// JSON-RPC, and no PRISMA_GENERATOR_INVOCATION (D56). Unless a test says otherwise, stdin is
// left open: the binary must not wait for it, and each run must end within five seconds.
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_OUTPUT } from '../../src/brand.ts'
import { OUTPUT_FILES, readRepoFile, repoRoot } from '../helpers/files.ts'

const TIME_LIMIT_MS = 5000

interface Run {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly elapsedMs: number
}

interface RunOptions {
  /** Sent on stdin, then stdin is closed. Without it stdin stays open. */
  readonly input?: string
  readonly underPrisma?: boolean
}

function run(args: readonly string[], options: RunOptions = {}): Promise<Run> {
  return new Promise((resolvePromise, reject) => {
    const { PRISMA_GENERATOR_INVOCATION: _inherited, ...inherited } = process.env
    const env = options.underPrisma
      ? { ...inherited, PRISMA_GENERATOR_INVOCATION: 'true' }
      : inherited
    const started = performance.now()
    const child = spawn(process.execPath, [join(repoRoot, 'src', 'generator.ts'), ...args], {
      cwd: repoRoot,
      env,
    })
    const timer = setTimeout(() => {
      child.kill()
      reject(
        new Error(
          `hyde-db ${args.join(' ')} did not exit within ${TIME_LIMIT_MS} ms (is it waiting on stdin?)`,
        ),
      )
    }, TIME_LIMIT_MS)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code, stdout, stderr, elapsedMs: performance.now() - started })
    })
    if (options.input === undefined) return
    child.stdin.write(options.input)
    child.stdin.end()
  })
}

const version = (JSON.parse(readRepoFile('package.json')) as { version: string }).version

// The per-run limit above fires first, with a message that names the cause.
describe('command line outside Prisma', { timeout: 3 * TIME_LIMIT_MS }, () => {
  it('D56: --help prints usage and exits 0 without reading stdin', async () => {
    const { code, stdout, stderr, elapsedMs } = await run(['--help'])
    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(elapsedMs).toBeLessThan(TIME_LIMIT_MS)
    expect(stdout).toContain('generator redacted {')
    expect(stdout).toContain('provider = "hyde-db"')
    for (const key of ['schema', 'role', 'sourceSchema', 'default', 'strict', 'statementTimeout']) {
      expect(stdout).toContain(`  ${key} = "`)
    }
    for (const annotation of [
      '@hyde.visible',
      '@hyde.hidden',
      '@hyde.exclude',
      '@hyde.default(visible|hidden)',
    ]) {
      expect(stdout).toContain(annotation)
    }
    for (const file of OUTPUT_FILES) expect(stdout).toContain(file)
    const deploy = [
      'npx prisma generate',
      'psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <output>/redacted-views-drop.sql',
      'npx prisma migrate deploy',
      'psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <output>/redacted-views.sql',
      `psql "$DATABASE_URL" -c "ALTER ROLE redacted_reader LOGIN PASSWORD '…'"`,
    ]
    const positions = deploy.map((command) => stdout.indexOf(command))
    expect(positions).not.toContain(-1)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(stdout).toContain('(needs strict "false")')
    expect(stdout).toContain(`output   = "${DEFAULT_OUTPUT}"`)
    expect(stdout).toContain('HYDE_')
    expect(stdout.endsWith('\n')).toBe(true)
  })

  it('D56: -h is --help', async () => {
    const help = await run(['--help'])
    const short = await run(['-h'])
    expect(short.code).toBe(0)
    expect(short.stdout).toBe(help.stdout)
  })

  it('D56: no arguments prints the same usage', async () => {
    const help = await run(['--help'])
    const bare = await run([])
    expect(bare.code).toBe(0)
    expect(bare.stderr).toBe('')
    expect(bare.stdout).toBe(help.stdout)
  })

  it('D56: --version prints the package version', async () => {
    const { code, stdout, stderr } = await run(['--version'])
    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(stdout).toBe(`${version}\n`)
    expect((await run(['-v'])).stdout).toBe(`${version}\n`)
  })

  it('D56: help and version also work as plain words', async () => {
    const help = await run(['--help'])
    const word = await run(['help'])
    expect(word.code).toBe(0)
    expect(word.stdout).toBe(help.stdout)
    const version = await run(['version'])
    expect(version.code).toBe(0)
    expect(version.stdout).toBe((await run(['--version'])).stdout)
  })

  it('D56: --help wins over an unknown argument in either order', async () => {
    const help = await run(['--help'])
    for (const args of [
      ['--bogus', '--help'],
      ['--help', '--bogus'],
    ]) {
      const result = await run(args)
      expect(result.code, args.join(' ')).toBe(0)
      expect(result.stderr, args.join(' ')).toBe('')
      expect(result.stdout, args.join(' ')).toBe(help.stdout)
    }
  })

  it('D56: --version wins over an unknown argument, but --help wins over --version', async () => {
    const withBogus = await run(['--version', '--bogus'])
    expect(withBogus.code).toBe(0)
    expect(withBogus.stdout).toBe(`${version}\n`)
    const both = await run(['--version', '--help'])
    expect(both.code).toBe(0)
    expect(both.stdout).toBe((await run(['--help'])).stdout)
  })

  it('D56: an unknown argument exits 2 with a pointer to --help on stderr', async () => {
    const { code, stdout, stderr } = await run(['--frobnicate'])
    expect(code).toBe(2)
    expect(stdout).toBe('')
    expect(stderr).toBe(
      'hyde-db: unknown argument "--frobnicate"\nRun "hyde-db --help" for usage.\n',
    )
  })

  it('D56: with PRISMA_GENERATOR_INVOCATION=true and no arguments it speaks the protocol', async () => {
    const request = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getManifest', params: {} })}\n`
    const { code, stdout, stderr } = await run([], { underPrisma: true, input: request })
    expect(code).toBe(0)
    expect(stdout).toBe('')
    expect(JSON.parse(stderr)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        manifest: { prettyName: 'Redacted read-only views', defaultOutput: DEFAULT_OUTPUT },
      },
    })
  })

  it('D56: with PRISMA_GENERATOR_INVOCATION=true and --help it prints usage (arguments win)', async () => {
    const help = await run(['--help'])
    const underPrisma = await run(['--help'], { underPrisma: true })
    expect(underPrisma.code).toBe(0)
    expect(underPrisma.stderr).toBe('')
    expect(underPrisma.stdout).toBe(help.stdout)
  })

  it('D55: the help text names no AI-only concept', async () => {
    const { stdout } = await run(['--help'])
    expect(stdout).not.toMatch(/\bAI\b/)
    expect(stdout).not.toMatch(/LLM/)
    expect(stdout).not.toContain('ai_reader')
    expect(stdout).not.toContain('@ai.')
  })
})
