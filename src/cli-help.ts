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
  | { readonly kind: 'prisma-arguments'; readonly arguments: readonly string[] }

const HELP_ARGUMENTS: readonly string[] = ['--help', '-h', 'help']
const VERSION_ARGUMENTS: readonly string[] = ['--version', '-v', 'version']

/**
 * Under Prisma (PRISMA_GENERATOR_INVOCATION=true) any argument is a configuration mistake such as
 * `provider = "hyde-db --help"`: Prisma would report a successful generate that wrote nothing,
 * so it is refused (D66, A46). Outside Prisma a help request anywhere wins, then a version
 * request; otherwise the first argument is the unknown one (D56).
 */
export function selectCommand(args: readonly string[], underPrisma: boolean): CliCommand {
  const [first] = args
  if (underPrisma) {
    return first === undefined
      ? { kind: 'protocol' }
      : { kind: 'prisma-arguments', arguments: args }
  }
  if (first === undefined) return { kind: 'help' }
  if (args.some((arg) => HELP_ARGUMENTS.includes(arg))) return { kind: 'help' }
  if (args.some((arg) => VERSION_ARGUMENTS.includes(arg))) return { kind: 'version' }
  return { kind: 'unknown', argument: first }
}

export function prismaArgumentsMessage(args: readonly string[]): string {
  return `${BRAND}: Prisma passed arguments (${args.join(' ')}); the generator block must read provider = "${BRAND}" with nothing after it.`
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

/** The success line (D28), with each noun agreeing with its own count. */
export function formatSummary(
  counts: { readonly views: number; readonly visible: number; readonly hidden: number },
  where: string,
): string {
  return (
    `${BRAND}: ${plural(counts.views, 'view')}, ${plural(counts.visible, 'visible column')} ` +
    `and ${plural(counts.hidden, 'hidden column')} → ${where}`
  )
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

/** The shell expansion that stops a command while DATABASE_URL is unset or empty, never falling back to libpq defaults (D68, A49). */
const DB_URL = `\${DATABASE_URL:?export DATABASE_URL first}`

/** The help text, without a trailing newline. `config` supplies the defaults it prints. */
export function usage(config: ResolvedConfig, repository?: string): string {
  return [
    `${BRAND}: a Prisma generator that turns /// @hyde.* annotations into read-only PostgreSQL views with sensitive columns removed, plus a locked-down reader role.`,
    '',
    `Prisma runs it during prisma generate. Running ${BRAND} directly only prints this help.`,
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
    `Deploy in this order. <output> = the generator's output directory, relative to schema.prisma (default ${DEFAULT_OUTPUT}):`,
    'Write the three files:',
    '  npx prisma generate',
    'Note: psql does not read .env. Export DATABASE_URL in your shell first, as a plain libpq URL without Prisma-only parameters such as ?schema=public.',
    'Drop the views schema:',
    `  psql "${DB_URL}" -v ON_ERROR_STOP=1 -f <output>/redacted-views-drop.sql`,
    'Migrate:',
    '  npx prisma migrate deploy',
    'Create the views and the role:',
    `  psql "${DB_URL}" -v ON_ERROR_STOP=1 -f <output>/redacted-views.sql`,
    'Give the reader role a login password, once. First export READER_PASSWORD=... in your shell;',
    'the password must not contain a single quote. Typed inline, it lands in your shell history and',
    `in ps output. To avoid that, run \\password ${config.role} in an interactive psql instead.`,
    'Otherwise run:',
    // The shell aborts, running nothing, when READER_PASSWORD is unset or empty: no placeholder to paste.
    `  psql "${DB_URL}" -c "ALTER ROLE ${config.role} LOGIN PASSWORD '\${READER_PASSWORD:?set READER_PASSWORD first}'"`,
    '',
    'Problems are diagnostics with stable HYDE_* codes (for example HYDE_STRICT_UNANNOTATED).',
    'Each error carries a fix hint, and any error fails prisma generate before writing files.',
    '',
    repository === undefined
      ? `Full documentation: the README in the ${BRAND} npm package.`
      : `Full documentation: ${repository}#readme`,
  ].join('\n')
}
