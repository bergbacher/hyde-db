// Starts one MySQL container for the integration-mysql project (D1, D148). There is deliberately
// no error handling: without a container runtime this throws and the run fails (D22, A28).
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql'
import type { TestProject } from 'vitest/node'
import { startServer } from '../integration/helpers/server.ts'

declare module 'vitest' {
  export interface ProvidedContext {
    mysql: { containerId: string; rootPassword: string; image: string }
  }
}

const ROOT_PASSWORD = 'hyde-root'
let container: StartedMySqlContainer | undefined

export async function setup(project: TestProject): Promise<void> {
  const image = process.env.MYSQL_IMAGE ?? 'mysql:9.7'
  container = await startServer(() => new MySqlContainer(image).withRootPassword(ROOT_PASSWORD))
  project.provide('mysql', { containerId: container.getId(), rootPassword: ROOT_PASSWORD, image })
}

export async function teardown(): Promise<void> {
  await container?.stop()
}
