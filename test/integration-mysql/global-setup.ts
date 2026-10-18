// Starts one MySQL container for the integration-mysql project (D1, D148), or, with MYSQL_URL set,
// targets that running server instead (D173). There is deliberately no error handling: without a
// container runtime, or with an unreachable MYSQL_URL, this throws and the run fails (D22, A28).
import { spawnSync } from 'node:child_process'
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql'
import type { TestProject } from 'vitest/node'
import { startServer } from '../integration/helpers/server.ts'
import { type MysqlServer, parseMysqlUrl } from './helpers/server.ts'

declare module 'vitest' {
  export interface ProvidedContext {
    mysql: MysqlServer
  }
}

const ROOT_PASSWORD = 'hyde-root'
let container: StartedMySqlContainer | undefined

export async function setup(project: TestProject): Promise<void> {
  const url = process.env.MYSQL_URL
  if (url !== undefined && url !== '') {
    const server = parseMysqlUrl(url)
    // The server must answer before any test runs; the harness test checks its version (D171).
    const ping = spawnSync(
      'mysql',
      [
        '--no-defaults',
        '--protocol=TCP',
        `-h${server.host}`,
        `-P${server.port}`,
        `-u${server.user}`,
        '-N',
        '-B',
        '-e',
        'SELECT 1',
      ],
      { encoding: 'utf8', env: { ...process.env, MYSQL_PWD: server.password }, timeout: 30_000 },
    )
    if (ping.error) throw ping.error
    if (ping.status !== 0)
      throw new Error(
        `MYSQL_URL server did not answer (exit status ${ping.status}): ${ping.stderr.trim()}`,
      )
    project.provide('mysql', server)
    return
  }
  const image = process.env.MYSQL_IMAGE ?? 'mysql:9.7'
  container = await startServer(() => new MySqlContainer(image).withRootPassword(ROOT_PASSWORD))
  project.provide('mysql', {
    kind: 'container',
    containerId: container.getId(),
    rootPassword: ROOT_PASSWORD,
    image,
  })
}

export async function teardown(): Promise<void> {
  await container?.stop()
}
