// Config validation (D17, D25, D29): every problem becomes a diagnostic; nothing throws, whatever
// a JavaScript caller passes (D142).
// An invalid value keeps the safe default for its key so analysis can go on.
import {
  configKeyUnsupported,
  configNotAnObject,
  invalidConfigValue,
  timeoutDisabled,
  unknownConfigKey,
  unreadableConfig,
  unreadableConfigValue,
} from './diagnostics.ts'
import type {
  Diagnostic,
  GeneratorConfig,
  MysqlConfig,
  PostgresqlConfig,
  Provider,
  ResolvedConfig,
  Visibility,
} from './types.ts'

export const CONFIG_KEYS: readonly string[] = [
  'schema',
  'role',
  'sourceSchema',
  'default',
  'strict',
  'statementTimeout',
]

export const DEFAULT_CONFIG: PostgresqlConfig = {
  dialect: 'postgresql',
  schema: 'redacted',
  role: 'redacted_reader',
  sourceSchema: 'public',
  default: 'hidden',
  strict: true,
  statementTimeout: '15s',
}

export const MYSQL_CONFIG_KEYS: readonly string[] = [
  'schema',
  'role',
  'readerHost',
  'default',
  'strict',
]

export const DEFAULT_MYSQL_CONFIG: MysqlConfig = {
  dialect: 'mysql',
  schema: 'redacted',
  role: 'redacted_reader',
  readerHost: '%',
  default: 'hidden',
  strict: true,
}

/** Per-dialect rules as data (D113); the one validation loop below reads them. */
interface DialectRules {
  readonly defaults: PostgresqlConfig | MysqlConfig
  readonly keys: readonly string[]
  /** Keys that exist on the other dialect only: key -> fix hint. */
  readonly rejected: Readonly<Record<string, string>>
  /** PostgreSQL truncates longer identifiers (NAMEDATALEN - 1); MySQL allows 64 and 32 (D97). */
  readonly lengths: Readonly<Record<'schema' | 'role', number>>
}

const RULES: Readonly<Record<Provider, DialectRules>> = {
  postgresql: {
    defaults: DEFAULT_CONFIG,
    keys: CONFIG_KEYS,
    rejected: {},
    lengths: { schema: 63, role: 63 },
  },
  mysql: {
    defaults: DEFAULT_MYSQL_CONFIG,
    keys: MYSQL_CONFIG_KEYS,
    rejected: {
      sourceSchema:
        'Remove "sourceSchema": MySQL has no schemas; views read from the connection\'s database (name it in the connection URL).',
      statementTimeout:
        'Remove "statementTimeout": MySQL has no per-account statement timeout; limit load with per-account resource limits instead.',
    },
    lengths: { schema: 64, role: 32 },
  },
}

/** A MySQL host part (D149): letters, digits and the characters of names, addresses and wildcards. */
const READER_HOST = /^[A-Za-z0-9._%:/-]{1,60}$/
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/
/** What PostgreSQL accepts in a role setting: digits, one optional plain space, an optional unit. */
const TIMEOUT = /^(\d+)(?: ?(ms|s|min))?$/
const UNIT_MS = { ms: 1, s: 1000, min: 60_000 } as const
/** PostgreSQL rejects a statement_timeout above INT_MAX milliseconds. */
const MAX_TIMEOUT_MS = 2_147_483_647

/** The duration in milliseconds (a bare number is milliseconds), or undefined if the text is malformed. */
function timeoutMillis(value: string): number | undefined {
  const match = TIMEOUT.exec(value)
  if (match === null) return undefined
  return Number(match[1]) * UNIT_MS[(match[2] ?? 'ms') as keyof typeof UNIT_MS]
}

/**
 * The `[object Tag]` name of a value, or undefined when a hostile `get` trap or `Symbol.toStringTag`
 * getter throws: the keys are then read one by one below, and each unreadable one is reported.
 */
function objectTag(value: object): string | undefined {
  try {
    return Object.prototype.toString.call(value).slice('[object '.length, -1)
  } catch {
    return undefined
  }
}

export interface ConfigResult<C = ResolvedConfig> {
  readonly config: C
  readonly diagnostics: readonly Diagnostic[]
}

interface Working {
  dialect: Provider
  schema: string
  role: string
  sourceSchema?: string
  readerHost?: string
  default: Visibility
  strict: boolean
  statementTimeout?: string
}

export function validateConfig(
  rawConfig: GeneratorConfig | null | undefined,
  dialect: 'postgresql',
): ConfigResult<PostgresqlConfig>
export function validateConfig(
  rawConfig: GeneratorConfig | null | undefined,
  dialect: 'mysql',
): ConfigResult<MysqlConfig>
export function validateConfig(
  rawConfig: GeneratorConfig | null | undefined,
  dialect: Provider,
): ConfigResult<PostgresqlConfig | MysqlConfig> {
  const rules = RULES[dialect]
  const validKeys = rules.keys
  // One working record for both dialects; keys of the other dialect stay at their defaults, unset.
  const config: Working = { ...rules.defaults }
  const diagnostics: Diagnostic[] = []
  const result = (found: readonly Diagnostic[]): ConfigResult<PostgresqlConfig | MysqlConfig> => ({
    config: config as PostgresqlConfig | MysqlConfig,
    diagnostics: found,
  })
  if (rawConfig === null || rawConfig === undefined) return result(diagnostics)
  if (typeof rawConfig !== 'object') return result([configNotAnObject(typeof rawConfig)])
  const raw: GeneratorConfig = rawConfig
  // Prisma 6 and 7 deliver config keys in different orders; a canonical order keeps
  // diagnostics identical across majors: known keys first, then unknown keys sorted.
  let keys: string[]
  try {
    // Inside the try: `Array.isArray` throws on a revoked Proxy, as do hostile `ownKeys`/`has` traps.
    if (Array.isArray(raw)) return result([configNotAnObject('array')])
    // The tag, not the prototype, so class instances, prototype-less and cross-realm plain objects
    // stay accepted while boxed primitives, typed arrays, Map, Set, Date, Error, … are refused once.
    const tag = objectTag(raw)
    if (tag !== undefined && tag !== 'Object') return result([configNotAnObject(tag)])
    const known = validKeys.filter((key) => key in raw)
    const unknown = Object.keys(raw)
      .filter((key) => !validKeys.includes(key))
      .sort()
    keys = [...known, ...unknown]
  } catch {
    return result([unreadableConfig()])
  }
  for (const key of keys) {
    // An unknown key is reported whatever its value, and its value is never read.
    const unsupportedHint = Object.hasOwn(rules.rejected, key) ? rules.rejected[key] : undefined
    if (unsupportedHint !== undefined) {
      diagnostics.push(configKeyUnsupported(key, dialect, unsupportedHint))
      continue
    }
    if (!validKeys.includes(key)) {
      diagnostics.push(unknownConfigKey(key, validKeys))
      continue
    }
    let value: unknown
    try {
      value = raw[key]
    } catch {
      diagnostics.push(unreadableConfigValue(key))
      continue
    }
    // An unset known key keeps its default.
    if (value === undefined || value === null) continue
    switch (key) {
      case 'strict':
        if (value === true || value === 'true') config.strict = true
        else if (value === false || value === 'false') config.strict = false
        else
          diagnostics.push(invalidConfigValue(key, value, '"true" or "false"', ['true', 'false']))
        break
      case 'default':
        if (value === 'hidden' || value === 'visible') config.default = value
        else
          diagnostics.push(
            invalidConfigValue(key, value, '"hidden" or "visible"', ['hidden', 'visible']),
          )
        break
      case 'statementTimeout':
        if (typeof value === 'string' && (timeoutMillis(value) ?? Infinity) <= MAX_TIMEOUT_MS)
          config.statementTimeout = value
        else
          diagnostics.push(
            invalidConfigValue(
              key,
              value,
              `a duration like "15s", "500ms" or "1min" of at most ${MAX_TIMEOUT_MS} ms`,
            ),
          )
        break
      case 'readerHost':
        if (typeof value === 'string' && READER_HOST.test(value)) config.readerHost = value
        else
          diagnostics.push(
            invalidConfigValue(
              key,
              value,
              'a host name, address or wildcard pattern of 1 to 60 characters (letters, digits and . _ % : / -)',
            ),
          )
        break
      case 'schema':
      case 'role':
      case 'sourceSchema': {
        const limit = key === 'role' ? rules.lengths.role : rules.lengths.schema
        if (typeof value === 'string' && IDENTIFIER.test(value) && value.length <= limit)
          config[key] = value
        else
          diagnostics.push(
            invalidConfigValue(
              key,
              value,
              `a lowercase SQL identifier of at most ${limit} characters`,
            ),
          )
        break
      }
    }
  }
  // D59: a zero timeout is valid but turns the reader role's statement timeout off.
  if (config.statementTimeout !== undefined && timeoutMillis(config.statementTimeout) === 0)
    diagnostics.push(timeoutDisabled(config.statementTimeout, config.role))
  return result(diagnostics)
}
