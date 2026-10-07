import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readRepoFile, repoRoot } from '../helpers/files.ts'
import { startServer } from '../integration/helpers/server.ts'

const INTEGRATION_DIRS = ['integration', 'integration-mysql'] as const

function integrationFiles(dir: string | undefined = undefined): string[] {
  if (dir === undefined)
    return INTEGRATION_DIRS.flatMap((name) => integrationFiles(join(repoRoot, 'test', name)))
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? integrationFiles(join(dir, entry.name)) : [join(dir, entry.name)],
  )
}

/** testcontainers 12's message when a container's ports are not bound within its fixed 10 seconds. */
const PORTS_NOT_BOUND =
  'Timed out after 10000ms while waiting for container ports to be bound to the host'

/** A container factory whose starts settle as given, in order, and that counts them. */
function containers(...outcomes: readonly (string | Error)[]): {
  readonly factory: () => { start(): Promise<string> }
  readonly starts: () => number
} {
  let started = 0
  return {
    factory: () => ({
      start: async () => {
        const outcome = outcomes[started++]
        if (outcome instanceof Error) throw outcome
        return outcome ?? 'unexpected start'
      },
    }),
    starts: () => started,
  }
}

describe('integration policy', () => {
  it('D22: the integration suite has no skip paths and the container start is not caught', () => {
    for (const file of integrationFiles()) {
      const source = readRepoFile(file.slice(repoRoot.length + 1))
      expect(source, file).not.toMatch(/\.(skip|skipIf|runIf|todo)\b|\bctx\.skip\(/)
      // Every server starts through startServer, which retries only a port-binding timeout.
      if (!file.endsWith(join('helpers', 'server.ts')))
        expect(source, file).not.toMatch(/\.start\(\)/)
    }
    for (const name of INTEGRATION_DIRS) {
      const globalSetup = readRepoFile('test', name, 'global-setup.ts')
      expect(globalSetup, name).not.toMatch(/\btry\s*\{|\.catch\s*\(/)
      expect(globalSetup, name).toContain('await startServer(')
    }
  })

  it('D22: startServer starts a container once more only when testcontainers timed out binding its ports', async () => {
    const retried = containers(new Error(PORTS_NOT_BOUND), 'second')
    await expect(startServer(retried.factory)).resolves.toBe('second')
    expect(retried.starts()).toBe(2)

    const other = new Error('Could not find a working container runtime strategy')
    const failing = containers(other, 'never')
    await expect(startServer(failing.factory)).rejects.toBe(other)
    expect(failing.starts()).toBe(1)

    const twice = new Error(PORTS_NOT_BOUND)
    const failingTwice = containers(new Error(PORTS_NOT_BOUND), twice, 'never')
    await expect(startServer(failingTwice.factory)).rejects.toBe(twice)
    expect(failingTwice.starts()).toBe(2)
  })

  it("D22: a hook outlasts testcontainers' 120-second startup timeout, so a slow start fails as itself", () => {
    expect(readRepoFile('vitest.config.ts').match(/hookTimeout: 180_000,/g)).toHaveLength(2)
  })
})
