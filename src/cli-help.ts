// Command-line text and argument handling, kept pure so the I/O module stays thin (D5, D56).
// The help is written for an agent that has never seen the package (D55): what it is, how to
// configure it, the annotations, the output files and the deploy order, in that order.
import { BRAND, DEFAULT_OUTPUT } from './brand.ts'
import { CONFIG_KEYS } from './config.ts'
import type { ResolvedConfig } from './types.ts'

export type CliCommand =
  | { readonly kind: 'protocol' }
  | { readonly kind: 'help' }
  | { readonly kind: 'version' }
  | { readonly kind: 'unknown'; readonly argument: string }

const HELP_ARGUMENTS: readonly string[] = ['--help', '-h', 'help']
const VERSION_ARGUMENTS: readonly string[] = ['--version', '-v', 'version']

/**
 * Arguments win over the environment: Prisma passes none (A34), so any argument means a person
 * or an agent is at the keyboard. Order does not matter: a help request anywhere wins, then a
 * version request; otherwise the first argument is the unknown one (D56).
 */
export function selectCommand(args: readonly string[], underPrisma: boolean): CliCommand {
  const [first] = args
  if (first === undefined) return underPrisma ? { kind: 'protocol' } : { kind: 'help' }
  if (args.some((arg) => HELP_ARGUMENTS.includes(arg))) return { kind: 'help' }
  if (args.some((arg) => VERSION_ARGUMENTS.includes(arg))) return { kind: 'version' }
  return { kind: 'unknown', argument: first }
}

export function unknownArgumentMessage(argument: string): string {
  return `${BRAND}: unknown argument "${argument}"\nRun "${BRAND} --help" for usage.`
}

/** The browsable address from package.json's `repository` (string or `{ url }`); shorthands give nothing. */
export function repositoryUrl(repository: unknown): string | undefined {
  const raw =
    typeof repository === 'object' && repository !== null && 'url' in repository
      ? repository.url
      : repository
  if (typeof raw !== 'string') return undefined
  const url = raw.replace(/^git\+/, '').replace(/\.git$/, '')
  return /^https?:\/\//.test(url) ? url : undefined
}

/** What each config key does; the keys themselves come from CONFIG_KEYS, the values from the caller. */
const CONFIG_NOTES: Readonly<Record<keyof ResolvedConfig, string>> = {
  schema: 'schema that holds the views',
  role: 'login-less role that can SELECT only those views',
  sourceSchema: 'schema of your Prisma tables (a model @@schema overrides it)',
  default: '"hidden" or "visible" for unannotated fields; needs strict "false"',
  strict: '"true" fails generate on any unannotated field',
  statementTimeout: 'role statement timeout: "500ms", "15s" or "1min"',
}

function configLines(config: ResolvedConfig): string[] {
  return CONFIG_KEYS.map((name) => {
    const key = name as keyof ResolvedConfig
    const setting = `  ${key} = "${String(config[key])}"`
    return `${setting.padEnd(28)}  ${CONFIG_NOTES[key]}`
  })
}

/** The help text, without a trailing newline. `config` supplies the defaults it prints. */
export function usage(config: ResolvedConfig, repository?: string): string {
  return [
    `${BRAND}: a Prisma generator that turns /// @hyde.* annotations into read-only PostgreSQL views with sensitive columns removed, plus a locked-down reader role.`,
    '',
    `Prisma runs it during \`prisma generate\`. Running ${BRAND} directly only prints this help.`,
    '',
    `Usage: ${BRAND} [-h | --help] [-v | --version]`,
    '',
    'Add a generator block to schema.prisma (env() is not supported there):',
    '',
    '  generator redacted {',
    `    provider = "${BRAND}"`,
    `    output   = "${DEFAULT_OUTPUT}"`,
    '  }',
    '',
    'Optional keys, all strings; an unset key uses the default shown:',
    ...configLines(config),
    '',
    'Annotate fields and models with /// comments in schema.prisma:',
    '  /// @hyde.visible                  field: keep the column in its view',
    '  /// @hyde.hidden                   field: remove the column',
    '  /// @hyde.exclude                  model: no view at all',
    '  /// @hyde.default(visible|hidden)  model: default for its unannotated fields (needs strict "false")',
    '',
    'Output files (commit them):',
    '  redacted-views.sql       creates the views schema, one view per model, and the role',
    '  redacted-views-drop.sql  drops the views schema so migrations can alter columns',
    '  redacted-schema.md       tables, columns and joins of the views, to give whoever queries them',
    '',
    'Deploy in this order (<output> is the generator output directory):',
    '  npx prisma generate  # writes the three files',
    '  # psql does not read .env: export DATABASE_URL in your shell as a plain libpq URL, without Prisma-only parameters such as ?schema=public',
    '  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <output>/redacted-views-drop.sql',
    '  npx prisma migrate deploy',
    '  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <output>/redacted-views.sql',
    `  psql "$DATABASE_URL" -c "ALTER ROLE ${config.role} LOGIN PASSWORD '…'"  # once: gives the role a login`,
    '',
    'Problems are diagnostics with stable HYDE_* codes (for example HYDE_STRICT_UNANNOTATED).',
    'Each error carries a fix hint, and any error fails `prisma generate` before writing files.',
    '',
    repository === undefined
      ? `Full documentation: the README in the ${BRAND} npm package.`
      : `Full documentation: ${repository}#readme`,
  ].join('\n')
}
