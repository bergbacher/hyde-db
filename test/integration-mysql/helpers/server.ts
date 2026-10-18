// The server the MySQL integration suite runs against (D148, D173): a Testcontainers container,
// reached with the `mysql` client inside it through `docker exec`, or a running server named by
// MYSQL_URL, reached with the `mysql` client on PATH over TCP.

export interface ContainerServer {
  readonly kind: 'container'
  readonly containerId: string
  readonly rootPassword: string
  /** The image, such as `mysql:8.4`. */
  readonly image: string
}

export interface UrlServer {
  readonly kind: 'url'
  readonly host: string
  readonly port: number
  /** An administrator account (the suite creates and drops accounts, roles and databases). */
  readonly user: string
  readonly password: string
}

export type MysqlServer = ContainerServer | UrlServer

/** Parses `mysql://<user>[:<password>]@<host>[:<port>][/]`; a database path is refused, since the suite creates its own databases. */
export function parseMysqlUrl(url: string): UrlServer {
  const parsed = new URL(url)
  if (parsed.protocol !== 'mysql:')
    throw new Error(`MYSQL_URL must start with mysql://, got ${parsed.protocol}`)
  if (parsed.pathname !== '' && parsed.pathname !== '/')
    throw new Error('MYSQL_URL must not name a database: the suite creates and drops its own')
  if (parsed.username === '') throw new Error('MYSQL_URL must name an administrator user')
  return {
    kind: 'url',
    host: parsed.hostname,
    port: parsed.port === '' ? 3306 : Number(parsed.port),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
  }
}
