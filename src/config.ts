// Config validation (D17, D25, D29): every problem becomes a diagnostic; nothing throws.
// An invalid value keeps the safe default for its key so analysis can go on.
import { invalidConfigValue, unknownConfigKey } from './diagnostics.ts'
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
  schema: 'ai',
  role: 'ai_reader',
  sourceSchema: 'public',
  default: 'hidden',
  strict: false,
  statementTimeout: '15s',
}

/** PostgreSQL truncates longer identifiers (NAMEDATALEN - 1). */
const MAX_IDENTIFIER_LENGTH = 63
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/
const TIMEOUT = /^\d+\s*(ms|s|min)?$/

export interface ConfigResult {
  readonly config: ResolvedConfig
  readonly diagnostics: readonly Diagnostic[]
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

export function validateConfig(raw: GeneratorConfig = {}): ConfigResult {
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
  return { config, diagnostics }
}
