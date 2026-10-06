// Starts the PostgreSQL containers the integration suite runs on. testcontainers 12 waits a fixed
// 10 seconds for a container's ports to be bound, which parallel starts on Docker Desktop can
// exceed; that one failure is retried once. Every other failure, and a second one, fails the run,
// so the suite never passes without a database (D22).

/** testcontainers' message when the ports were not bound in time. */
const PORTS_NOT_BOUND = /while waiting for container ports to be bound to the host/

/** Starts the container `container` builds, once more after a port-binding timeout. */
export function startServer<T>(container: () => { start(): Promise<T> }): Promise<T> {
  return container()
    .start()
    .catch((error: unknown) => {
      if (!(error instanceof Error && PORTS_NOT_BOUND.test(error.message))) throw error
      return container().start()
    })
}
