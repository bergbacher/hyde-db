// Starts one PostgreSQL container for the integration project (D1). There is deliberately
// no error handling: without a container runtime this throws and the run fails (D22, A28).
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import type { TestProject } from 'vitest/node'

declare module 'vitest' {
  export interface ProvidedContext {
    pg: { uri: string; containerId: string; user: string; image: string }
  }
}

let container: StartedPostgreSqlContainer | undefined

export async function setup(project: TestProject): Promise<void> {
  const image = process.env.PG_IMAGE ?? 'postgres:18-alpine'
  container = await new PostgreSqlContainer(image).start()
  project.provide('pg', {
    uri: container.getConnectionUri(),
    containerId: container.getId(),
    user: container.getUsername(),
    image,
  })
}

export async function teardown(): Promise<void> {
  await container?.stop()
}
