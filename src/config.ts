// Config validation (D17, D25, D29): every problem becomes a diagnostic; nothing throws, whatever
// a JavaScript caller passes (D9).
// An invalid value keeps the safe default for its key so analysis can go on.
import { invalidConfigValue, timeoutDisabled, unknownConfigKey } from './diagnostics.ts'
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
const TIMEOUT = /^\d+( ?(ms|s|min))?$/

export interface ConfigResult {
  readonly config: ResolvedConfig
  readonly diagnostics: readonly Diagnostic[]
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

export function validateConfig(rawConfig?: GeneratorConfig | null): ConfigResult {
  // `Object()` keeps `null`, `undefined` and primitives from reaching `in`, which would throw.
  const raw: GeneratorConfig = Object(rawConfig ?? {})
  const config: Mutable<ResolvedConfig> = { ...DEFAULT_CONFIG }
  const diagnostics: Diagnostic[] = []
  // Prisma 6 and 7 deliver config keys in different orders; a canonical order keeps
  // diagnostics identical across majors: known keys first, then unknown keys sorted.
  const known = CONFIG_KEYS.filter((key) => key in raw)
  const unknown = Object.keys(raw)
    .filter((key) => !CONFIG_KEYS.includes(key))
    .sort()
  for (const key of [...known, ...unknown]) {
    const value = raw[key]
    // An unset known key keeps its default; an unknown key is reported whatever its value.
    if (CONFIG_KEYS.includes(key) && (value === undefined || value === null)) continue
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
        if (typeof value === 'string' && TIMEOUT.test(value)) config.statementTimeout = value
        else
          diagnostics.push(
            invalidConfigValue(key, value, 'a duration like "15s", "500ms" or "1min"'),
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
      default:
        diagnostics.push(unknownConfigKey(key, CONFIG_KEYS))
    }
  }
  // D59: a zero timeout is valid but turns the reader role's statement timeout off.
  if (Number.parseInt(config.statementTimeout, 10) === 0)
    diagnostics.push(timeoutDisabled(config.statementTimeout, config.role))
  return { config, diagnostics }
}
