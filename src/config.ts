// Config validation (D17, D25, D29): every problem becomes a diagnostic; nothing throws, whatever
// a JavaScript caller passes (D142).
// An invalid value keeps the safe default for its key so analysis can go on.
import {
  configNotAnObject,
  invalidConfigValue,
  timeoutDisabled,
  unknownConfigKey,
  unreadableConfig,
  unreadableConfigValue,
} from './diagnostics.ts'
import type { Diagnostic, GeneratorConfig, ResolvedConfig } from './types.ts'

export const CONFIG_KEYS: readonly string[] = [
  'schema',
  'role',
  'sourceSchema',
  'default',
  'strict',
  'statementTimeout',
]

export const DEFAULT_CONFIG: ResolvedConfig = {
  dialect: 'postgresql',
  schema: 'redacted',
  role: 'redacted_reader',
  sourceSchema: 'public',
  default: 'hidden',
  strict: true,
  statementTimeout: '15s',
}

/** PostgreSQL truncates longer identifiers (NAMEDATALEN - 1). */
const MAX_IDENTIFIER_LENGTH = 63
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

export interface ConfigResult {
  readonly config: ResolvedConfig
  readonly diagnostics: readonly Diagnostic[]
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

export function validateConfig(rawConfig?: GeneratorConfig | null): ConfigResult {
  const config: Mutable<ResolvedConfig> = { ...DEFAULT_CONFIG }
  const diagnostics: Diagnostic[] = []
  if (rawConfig === null || rawConfig === undefined) return { config, diagnostics }
  if (typeof rawConfig !== 'object')
    return { config, diagnostics: [configNotAnObject(typeof rawConfig)] }
  const raw: GeneratorConfig = rawConfig
  // Prisma 6 and 7 deliver config keys in different orders; a canonical order keeps
  // diagnostics identical across majors: known keys first, then unknown keys sorted.
  let keys: string[]
  try {
    // Inside the try: `Array.isArray` throws on a revoked Proxy, as do hostile `ownKeys`/`has` traps.
    if (Array.isArray(raw)) return { config, diagnostics: [configNotAnObject('array')] }
    // The tag, not the prototype, so class instances, prototype-less and cross-realm plain objects
    // stay accepted while boxed primitives, typed arrays, Map, Set, Date, Error, … are refused once.
    const tag = objectTag(raw)
    if (tag !== undefined && tag !== 'Object')
      return { config, diagnostics: [configNotAnObject(tag)] }
    const known = CONFIG_KEYS.filter((key) => key in raw)
    const unknown = Object.keys(raw)
      .filter((key) => !CONFIG_KEYS.includes(key))
      .sort()
    keys = [...known, ...unknown]
  } catch {
    return { config, diagnostics: [unreadableConfig()] }
  }
  for (const key of keys) {
    // An unknown key is reported whatever its value, and its value is never read.
    if (!CONFIG_KEYS.includes(key)) {
      diagnostics.push(unknownConfigKey(key, CONFIG_KEYS))
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
      case 'schema':
      case 'role':
      case 'sourceSchema':
        if (
          typeof value === 'string' &&
          IDENTIFIER.test(value) &&
          value.length <= MAX_IDENTIFIER_LENGTH
        )
          config[key] = value
        else
          diagnostics.push(
            invalidConfigValue(
              key,
              value,
              `a lowercase SQL identifier of at most ${MAX_IDENTIFIER_LENGTH} characters`,
            ),
          )
        break
    }
  }
  // D59: a zero timeout is valid but turns the reader role's statement timeout off.
  if (timeoutMillis(config.statementTimeout) === 0)
    diagnostics.push(timeoutDisabled(config.statementTimeout, config.role))
  return { config, diagnostics }
}
