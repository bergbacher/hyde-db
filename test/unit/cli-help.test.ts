import { describe, expect, it } from 'vitest'
import { DEFAULT_OUTPUT } from '../../src/brand.ts'
import { repositoryUrl, selectCommand, unknownArgumentMessage, usage } from '../../src/cli-help.ts'
import { CONFIG_KEYS, DEFAULT_CONFIG } from '../../src/config.ts'
import { DIAGNOSTIC_CODES } from '../../src/diagnostics.ts'
import { build } from '../../src/index.ts'
import type { ResolvedConfig } from '../../src/types.ts'

describe('selectCommand', () => {
  it('D56: protocol mode needs PRISMA_GENERATOR_INVOCATION=true and no arguments', () => {
    expect(selectCommand([], true)).toEqual({ kind: 'protocol' })
  })

  it('D56: without Prisma, no arguments print the help', () => {
    expect(selectCommand([], false)).toEqual({ kind: 'help' })
  })

  it('D56: arguments win over PRISMA_GENERATOR_INVOCATION', () => {
    expect(selectCommand(['--help'], true)).toEqual({ kind: 'help' })
    expect(selectCommand(['--version'], true)).toEqual({ kind: 'version' })
    expect(selectCommand(['--nope'], true)).toEqual({ kind: 'unknown', argument: '--nope' })
  })

  it('D56: --help and -h print the help, --version and -v the version', () => {
    expect(selectCommand(['--help'], false)).toEqual({ kind: 'help' })
    expect(selectCommand(['-h'], false)).toEqual({ kind: 'help' })
    expect(selectCommand(['--version'], false)).toEqual({ kind: 'version' })
    expect(selectCommand(['-v'], false)).toEqual({ kind: 'version' })
  })

  it('D56: help and version also work as plain words', () => {
    expect(selectCommand(['help'], false)).toEqual({ kind: 'help' })
    expect(selectCommand(['version'], false)).toEqual({ kind: 'version' })
    expect(selectCommand(['help'], true)).toEqual({ kind: 'help' })
  })

  it('D56: order does not matter: a help request anywhere wins, then a version request', () => {
    expect(selectCommand(['--bogus', '--help'], false)).toEqual({ kind: 'help' })
    expect(selectCommand(['--help', '--bogus'], false)).toEqual({ kind: 'help' })
    expect(selectCommand(['--bogus', '-h'], false)).toEqual({ kind: 'help' })
    expect(selectCommand(['--bogus', 'help'], false)).toEqual({ kind: 'help' })
    expect(selectCommand(['--version', '--help'], false)).toEqual({ kind: 'help' })
    expect(selectCommand(['--version', '--bogus'], false)).toEqual({ kind: 'version' })
    expect(selectCommand(['--bogus', '-v'], false)).toEqual({ kind: 'version' })
    expect(selectCommand(['--bogus', 'version'], false)).toEqual({ kind: 'version' })
  })

  it('D56: otherwise the first unknown argument is reported', () => {
    expect(selectCommand(['--bogus'], false)).toEqual({ kind: 'unknown', argument: '--bogus' })
    expect(selectCommand(['--first', '--second'], false)).toEqual({
      kind: 'unknown',
      argument: '--first',
    })
    expect(selectCommand(['Help'], false)).toEqual({ kind: 'unknown', argument: 'Help' })
  })
})

describe('unknownArgumentMessage', () => {
  it('D56: names the argument and points to --help', () => {
    expect(unknownArgumentMessage('--nope')).toBe(
      'hyde-db: unknown argument "--nope"\nRun "hyde-db --help" for usage.',
    )
  })
})

describe('repositoryUrl', () => {
  it('D56: reads a plain URL string or the url of a repository object', () => {
    expect(repositoryUrl('https://github.com/acme/hyde-db')).toBe('https://github.com/acme/hyde-db')
    expect(repositoryUrl({ type: 'git', url: 'https://github.com/acme/hyde-db' })).toBe(
      'https://github.com/acme/hyde-db',
    )
  })

  it('D56: turns a git+ URL with a .git suffix into the browsable address', () => {
    expect(repositoryUrl({ url: 'git+https://github.com/acme/hyde-db.git' })).toBe(
      'https://github.com/acme/hyde-db',
    )
  })

  it('D56: gives nothing for shorthands, missing or malformed values', () => {
    expect(repositoryUrl('acme/hyde-db')).toBeUndefined()
    expect(repositoryUrl('github:acme/hyde-db')).toBeUndefined()
    expect(repositoryUrl({ type: 'git' })).toBeUndefined()
    expect(repositoryUrl({ url: 42 })).toBeUndefined()
    expect(repositoryUrl(undefined)).toBeUndefined()
    expect(repositoryUrl(null)).toBeUndefined()
  })
})

describe('usage', () => {
  const text = usage(DEFAULT_CONFIG)
  const lines = text.split('\n')

  it('D56: starts with one line saying what hyde-db is', () => {
    expect(lines[0]).toMatch(/^hyde-db: a Prisma generator that turns \/\/\/ @hyde\.\* annotations/)
    expect(lines[0]).toContain('read-only PostgreSQL views')
    expect(lines[0]).toContain('sensitive columns removed')
    expect(lines[0]).toContain('locked-down reader role')
  })

  it('D56: says Prisma runs it and that running it directly only prints the help', () => {
    expect(text).toContain('Prisma runs it during `prisma generate`')
    expect(text).toContain('Running hyde-db directly only prints this help.')
  })

  it('D56: shows the minimal generator block and says env() is not supported (D35)', () => {
    expect(text).toContain(
      [
        'generator redacted {',
        '  provider = "hyde-db"',
        `  output   = "${DEFAULT_OUTPUT}"`,
        '}',
      ].join('\n  '),
    )
    expect(text).toContain('env() is not supported')
  })

  it('D56: the defaults it prints equal DEFAULT_CONFIG, key by key', () => {
    const printed = new Map<string, string>()
    for (const line of lines) {
      const match = /^ {2}(\w+) = "([^"]*)" /.exec(line)
      if (match?.[1] !== undefined && match[2] !== undefined) printed.set(match[1], match[2])
    }
    expect([...printed.keys()]).toEqual([...CONFIG_KEYS])
    for (const key of CONFIG_KEYS) {
      expect(printed.get(key), key).toBe(String(DEFAULT_CONFIG[key as keyof ResolvedConfig]))
    }
  })

  it('D56: prints the defaults it is given, not constants', () => {
    const custom: ResolvedConfig = {
      schema: 'masked',
      role: 'masked_reader',
      sourceSchema: 'app',
      default: 'visible',
      strict: false,
      statementTimeout: '2min',
    }
    const customText = usage(custom)
    expect(customText).toContain('  schema = "masked" ')
    expect(customText).toContain('  role = "masked_reader" ')
    expect(customText).toContain('  sourceSchema = "app" ')
    expect(customText).toContain('  default = "visible" ')
    expect(customText).toContain('  strict = "false" ')
    expect(customText).toContain('  statementTimeout = "2min" ')
  })

  it('D56: names every annotation', () => {
    for (const annotation of [
      '@hyde.visible',
      '@hyde.hidden',
      '@hyde.exclude',
      '@hyde.default(visible|hidden)',
    ]) {
      expect(text).toContain(annotation)
    }
  })

  it('D56: says @hyde.default needs strict "false"', () => {
    const line = lines.find((l) => l.includes('@hyde.default('))
    expect(line).toContain('(needs strict "false")')
  })

  it('D56: names exactly the files build() writes', () => {
    const files = build({ models: [] }).files
    expect(files).not.toBeNull()
    const named = new Set(text.match(/redacted-[a-z-]+\.(?:sql|md)/g))
    expect([...named].sort()).toEqual(Object.keys(files ?? {}).sort())
  })

  /** The command lines of the deploy block, without their trailing `# …` comments. */
  const commandsIn = (usageText: string): string[] =>
    usageText
      .split('\n')
      .filter((line) => /^ {2}(psql|npx) /.test(line))
      .map((line) => line.trim().replace(/ +#.*$/, ''))

  it('D56: gives the deploy order as copy-pasteable commands, starting with prisma generate', () => {
    expect(commandsIn(text)).toEqual([
      'npx prisma generate',
      'psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <output>/redacted-views-drop.sql',
      'npx prisma migrate deploy',
      'psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <output>/redacted-views.sql',
      `psql "$DATABASE_URL" -c "ALTER ROLE redacted_reader LOGIN PASSWORD '…'"`,
    ])
  })

  it('D56: says prisma generate writes the three files and the login step runs once', () => {
    expect(lines.find((l) => l.includes('npx prisma generate'))).toMatch(
      /# writes the three files$/,
    )
    expect(lines.find((l) => l.includes('ALTER ROLE'))).toMatch(/# once: .*login/)
  })

  it('D56: warns that psql needs DATABASE_URL exported as a plain libpq URL', () => {
    const caveats = lines.filter((l) => l.includes('DATABASE_URL') && !/^ {2}psql /.test(l))
    expect(caveats).toHaveLength(1)
    expect(caveats[0]).toContain('export')
    expect(caveats[0]).toContain('.env')
    expect(caveats[0]).toContain('libpq')
    expect(caveats[0]).toContain('?schema=public')
  })

  it('D56: names the role from the config it is given in the login step', () => {
    const custom = { ...DEFAULT_CONFIG, role: 'masked_reader' }
    expect(commandsIn(usage(custom)).at(-1)).toBe(
      `psql "$DATABASE_URL" -c "ALTER ROLE masked_reader LOGIN PASSWORD '…'"`,
    )
  })

  it('D56: mentions the stable HYDE_* codes with fix hints, using a code that exists', () => {
    expect(text).toContain('HYDE_*')
    expect(text).toContain('fix hint')
    const example = /\(for example (HYDE_[A-Z_]+)\)/.exec(text)?.[1]
    expect(DIAGNOSTIC_CODES).toContain(example)
  })

  it('D56: points to the package README, or the repository when it is known', () => {
    expect(text).toContain('Full documentation: the README in the hyde-db npm package.')
    expect(usage(DEFAULT_CONFIG, 'https://github.com/acme/hyde-db')).toContain(
      'Full documentation: https://github.com/acme/hyde-db#readme',
    )
  })

  it('D56: is plain, deterministic text of at most 60 lines', () => {
    expect(lines.length).toBeLessThanOrEqual(60)
    expect(text).not.toContain('\u001b')
    expect(usage(DEFAULT_CONFIG)).toBe(text)
    expect(text.endsWith('\n')).toBe(false)
  })

  it('D55: names no AI-only concept', () => {
    expect(text).not.toMatch(/\bAI\b/)
    expect(text).not.toMatch(/LLM/)
    expect(text).not.toContain('ai_reader')
    expect(text).not.toContain('@ai.')
  })
})
