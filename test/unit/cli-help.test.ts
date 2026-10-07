import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { BRAND, DEFAULT_OUTPUT } from '../../src/brand.ts'
import {
  formatSummary,
  prismaArgumentsMessage,
  repositoryUrl,
  selectCommand,
  unknownArgumentMessage,
  usage,
} from '../../src/cli-help.ts'
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

  it('D66: under Prisma any argument is refused, --help and --version included', () => {
    for (const args of [
      ['--help'],
      ['--version'],
      ['help'],
      ['version'],
      ['--nope'],
      ['-h', 'x'],
    ]) {
      expect(selectCommand(args, true), args.join(' ')).toEqual({
        kind: 'prisma-arguments',
        arguments: args,
      })
    }
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

describe('prismaArgumentsMessage', () => {
  it('D66: names the arguments and the provider rule', () => {
    expect(prismaArgumentsMessage(['--help'])).toBe(
      'hyde-db: Prisma passed arguments (--help); the generator block must read provider = "hyde-db" with nothing after it.',
    )
    expect(prismaArgumentsMessage(['a', 'b'])).toContain('arguments (a b);')
  })
})

describe('formatSummary', () => {
  const where = 'prisma/redacted'
  it('D28: counts with singular and plural nouns', () => {
    expect(formatSummary({ views: 2, visible: 8, hidden: 6 }, where)).toBe(
      'hyde-db: 2 views, 8 visible columns and 6 hidden columns → prisma/redacted',
    )
    expect(formatSummary({ views: 1, visible: 1, hidden: 1 }, where)).toBe(
      'hyde-db: 1 view, 1 visible column and 1 hidden column → prisma/redacted',
    )
  })

  it('D28: zero is plural, and each noun follows its own count', () => {
    expect(formatSummary({ views: 0, visible: 0, hidden: 0 }, where)).toBe(
      'hyde-db: 0 views, 0 visible columns and 0 hidden columns → prisma/redacted',
    )
    expect(formatSummary({ views: 1, visible: 3, hidden: 1 }, where)).toBe(
      'hyde-db: 1 view, 3 visible columns and 1 hidden column → prisma/redacted',
    )
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

/** The password argument of the login step: the shell aborts when READER_PASSWORD is unset or empty. */
const DB_URL = `\${DATABASE_URL:?export DATABASE_URL first}`
const LOGIN_PASSWORD = `'\${READER_PASSWORD:?set READER_PASSWORD first}'`

describe('usage', () => {
  const text = usage(DEFAULT_CONFIG)
  const lines = text.split('\n')

  it('D112, D120: mentions MySQL, readerHost, and that sourceSchema and statementTimeout are PostgreSQL only', () => {
    const line = lines.find((l) => l.includes('MySQL') && l.includes('readerHost'))
    expect(line).toBeDefined()
    expect(line).toContain('sourceSchema')
    expect(line).toContain('statementTimeout')
    expect(line).toContain('PostgreSQL only')
  })

  it('D56: starts with one line saying what hyde-db is', () => {
    expect(lines[0]).toMatch(/^hyde-db: a Prisma generator that turns \/\/\/ @hyde\.\* annotations/)
    expect(lines[0]).toContain('read-only PostgreSQL views')
    expect(lines[0]).toContain('sensitive columns removed')
    expect(lines[0]).toContain('locked-down reader role')
  })

  it('D56: says Prisma runs it and that running it directly only prints the help', () => {
    expect(text).toContain('During prisma generate, Prisma runs it.')
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
      dialect: 'postgresql',
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

  /** A command line: two spaces, then psql or npx (D68: no trailing comment, so each pastes as is). */
  const isCommand = (line: string): boolean => /^ {2}(psql|npx) /.test(line)
  /** The command lines as printed, ` &&` included. */
  const commandLines = (usageText: string): string[] =>
    usageText
      .split('\n')
      .filter(isCommand)
      .map((line) => line.trim())
  /** Each command on its own, without the ` &&` that chains it to the next (D136). */
  const commandsIn = (usageText: string): string[] =>
    commandLines(usageText).map((line) => line.replace(/ &&$/, ''))

  it('D56, D136: gives the deploy order as copy-pasteable commands, starting with prisma generate', () => {
    expect(commandLines(text)).toEqual([
      'npx prisma generate',
      `psql "${DB_URL}" -v ON_ERROR_STOP=1 -f <output>/redacted-views-drop.sql &&`,
      'npx prisma migrate deploy &&',
      `psql "${DB_URL}" -v ON_ERROR_STOP=1 -f <output>/redacted-views.sql`,
      `psql "${DB_URL}" -c "ALTER ROLE redacted_reader LOGIN PASSWORD ${LOGIN_PASSWORD}"`,
    ])
  })

  it('D136: chains drop, migrate and apply with &&, so a refused step stops the rest', () => {
    const start = lines.findIndex((l) => l.includes('<output>/redacted-views-drop.sql'))
    const block = lines.slice(start, start + 3).join('\n')
    expect(block).toContain('migrate deploy')
    expect(block).toContain('<output>/redacted-views.sql')
    // A refused drop script must stop the block: only the first stub runs. <output> stands for
    // the directory, as the note says; pasted as is, the shell refuses it as a redirection (D66).
    const stubs = 'psql() { echo psql; return 3; }; npx() { echo npx; return 1; }'
    const pasted = block.replaceAll('<output>/', 'prisma/redacted/')
    const { stdout } = spawnSync('sh', ['-c', `${stubs}\n${pasted}`], {
      env: { PATH: process.env.PATH ?? '', DATABASE_URL: 'postgresql://db' },
      encoding: 'utf8',
    })
    expect(stdout.trim().split('\n')).toEqual(['psql'])
    // The note before the block names the steps and says a refusal stops the rest.
    expect(lines[start - 1]).toMatch(/^Drop the views schema, migrate, then create the views/)
    expect(lines[start - 1]).toContain('A refused step stops the rest')
  })

  it('D68: every command that uses the database URL stops while DATABASE_URL is unset', () => {
    const withUrl = commandsIn(text).filter((c) => c.startsWith('psql '))
    expect(withUrl).toHaveLength(3)
    for (const command of withUrl) expect(command, command).toContain(`"${DB_URL}"`)
    expect(text).not.toContain('"$DATABASE_URL"')
  })

  it('D68: an unset or empty DATABASE_URL aborts the command in a shell, running nothing', () => {
    for (const command of commandsIn(text).filter((c) => c.startsWith('psql '))) {
      const printed = command.replace(/^psql /, "printf '%s\\n' ")
      for (const env of [{}, { DATABASE_URL: '' }]) {
        const { status, stdout, stderr } = spawnSync('sh', ['-c', printed], {
          env: { PATH: process.env.PATH ?? '', READER_PASSWORD: 'x', ...env },
          encoding: 'utf8',
        })
        expect(status, command).not.toBe(0)
        expect(stdout, command).toBe('')
        expect(stderr, command).toContain('DATABASE_URL: export DATABASE_URL first')
      }
    }
  })

  it('A49: paste-safe: no command line carries a trailing comment, and no line starts with #', () => {
    for (const line of lines) expect(line.trimStart(), line).not.toMatch(/^#/)
    for (const command of commandsIn(text)) expect(command, command).not.toContain(' #')
    expect(commandsIn(text)).toHaveLength(5)
  })

  it('A49, D136: a prose note ending with a colon comes before each command block, and only commands chain', () => {
    const commandIndexes = lines.flatMap((l, i) => (isCommand(l) ? [i] : []))
    expect(commandIndexes).toHaveLength(5)
    for (const index of commandIndexes) {
      const before = lines[index - 1] ?? ''
      if (isCommand(before)) expect(before, lines[index]).toMatch(/ &&$/)
      else expect(before, lines[index]).toMatch(/^[A-Za-z].*:$/)
      // A chained line is followed by its next command, never by prose.
      if (lines[index]?.endsWith(' &&')) expect(isCommand(lines[index + 1] ?? '')).toBe(true)
    }
  })

  it('D56: says prisma generate writes the three files and the login step runs once, after the first deploy', () => {
    expect(lines[lines.findIndex((l) => l.includes('npx prisma generate')) - 1]).toContain(
      'three files',
    )
    expect(text).toContain('Once, after the first deploy, let the reader log in.')
  })

  it('A41, D66: the login step sets the password with \\password first, then LOGIN, and the one-liner is the fallback with its costs', () => {
    const login = lines.findIndex((l) => l.includes('LOGIN PASSWORD'))
    const note = lines.slice(
      lines.findIndex((l) => l.startsWith('Once, after the first deploy')),
      login,
    )
    const prose = note.join('\n')
    const password = prose.indexOf('\\password redacted_reader')
    const allow = prose.indexOf('ALTER ROLE redacted_reader LOGIN, ending')
    const fallback = prose.indexOf('export READER_PASSWORD=...')
    expect(password).toBeGreaterThan(-1)
    expect(allow).toBeGreaterThan(password)
    expect(fallback).toBeGreaterThan(allow)
    expect(prose).toContain('In an interactive psql')
    expect(prose).toMatch(/shell history/)
    expect(prose).toMatch(/\bps\b/)
    expect(prose).toContain('single quote')
    expect(commandsIn(text).filter((c) => c.includes('READER_PASSWORD='))).toEqual([])
    // The interactive session is prose, not a command: pasted, it would read the lines after it.
    expect(commandsIn(text).filter((c) => /^psql "[^"]*"$/.test(c))).toEqual([])
  })

  it('D68: pasting the whole help runs only the indented commands: every prose line starts with an allowed prose word and holds no quote, angle bracket or backtick', () => {
    // A case-insensitive file system runs `Write` as /usr/bin/write, so an uppercase start proves
    // nothing. Every unindented line starts with one of these words, none of them a command.
    const proseStarts = new Set([
      'Usage:',
      'Add',
      'Optional',
      'Roles',
      'To',
      'Output',
      'Deploy',
      'First,',
      'Note:',
      'If',
      'Do',
      'On',
      'Drop',
      'Once,',
      'In',
      'Without',
      'Typed',
      'Problems',
      'Each',
      'Full',
      'During',
      'Running',
    ])
    for (const line of lines) {
      expect(line, line).not.toContain('`')
      expect(line, line).not.toContain('$(')
      if (line.startsWith(' ')) continue
      if (line === lines[0]) expect(line.startsWith(`${BRAND}: `)).toBe(true)
      else if (line !== '') {
        expect(proseStarts.has(line.split(' ')[0] ?? ''), line).toBe(true)
        // A quote, redirection or equals sign in prose would swallow or create something when pasted.
        expect(line, line).not.toMatch(/['<>]/)
        // A semicolon, pipe or ampersand in prose would end the command or chain the next one.
        expect(line, line).not.toMatch(/[;|&]/)
        expect(line, line).not.toMatch(/^\S+=/)
      }
    }
  })

  it('D56: the login step takes the password from READER_PASSWORD, with no <placeholder> to paste', () => {
    const login = lines.find((l) => l.includes('LOGIN PASSWORD')) ?? ''
    expect(login).toContain('${READER_PASSWORD:?')
    expect(login).not.toMatch(/<[^>]*>/)
    expect(login).not.toContain('…')
  })

  describe('the login command in a shell', () => {
    // The command as printed, with psql swapped for printf so the arguments it would get are shown.
    const command =
      commandsIn(text)
        .at(-1)
        ?.replace(/^psql /, "printf '%s\\n' ") ?? ''
    const shell = (env: Record<string, string>) =>
      spawnSync('sh', ['-c', command], {
        env: { PATH: process.env.PATH ?? '', DATABASE_URL: 'postgresql://db', ...env },
        encoding: 'utf8',
      })

    it('D56: aborts with a message, running nothing, while READER_PASSWORD is unset or empty', () => {
      const unset: Record<string, string>[] = [{}, { READER_PASSWORD: '' }]
      for (const env of unset) {
        const { status, stdout, stderr } = shell(env)
        expect(status, JSON.stringify(env)).not.toBe(0)
        expect(stdout, JSON.stringify(env)).toBe('')
        expect(stderr, JSON.stringify(env)).toContain('READER_PASSWORD: set READER_PASSWORD first')
      }
    })

    it('D56: passes the password from READER_PASSWORD into the statement once it is set', () => {
      const { status, stdout, stderr } = shell({ READER_PASSWORD: 'S3cr$t value' })
      expect(status).toBe(0)
      expect(stderr).toBe('')
      expect(stdout.split('\n')).toContain(
        "ALTER ROLE redacted_reader LOGIN PASSWORD 'S3cr$t value'",
      )
    })
  })

  it('D56: the help is pure ASCII, so a pasted command carries no look-alike character', () => {
    expect(text).toMatch(/^[\x20-\x7e\n]*$/)
    expect(usage(DEFAULT_CONFIG, 'https://github.com/acme/hyde-db')).toMatch(/^[\x20-\x7e\n]*$/)
  })

  it('D56: says what the placeholder in the paths is: the generator output directory, relative to schema.prisma', () => {
    const definitions = lines.filter((l) => l.startsWith('Deploy in this order.'))
    expect(definitions).toHaveLength(1)
    expect(definitions[0]).toContain(
      'replace the placeholder with the output directory of the generator',
    )
    expect(definitions[0]).toMatch(/:$/)
    expect(definitions[0]).toContain('relative to schema.prisma')
    expect(definitions[0]).toContain(`(default ${DEFAULT_OUTPUT})`)
    expect(lines.indexOf(definitions[0] ?? '')).toBeLessThan(
      lines.findIndex((l) => l.includes('<output>/redacted-views-drop.sql')),
    )
  })

  it('A15, A95, D24: says the PostgreSQL 14 step runs once before the first apply, in the application database, as the owner of public or a superuser', () => {
    const step = lines.filter((l) => l.includes('REVOKE CREATE ON SCHEMA public FROM PUBLIC'))
    expect(step).toHaveLength(1)
    expect(step[0]).toMatch(
      /^On PostgreSQL 14 and older, and clusters upgraded from them, once before the first apply/,
    )
    expect(step[0]).toContain('in the application database')
    expect(step[0]).toContain('as the owner of schema public or a superuser')
    expect(lines.indexOf(step[0] ?? '')).toBeLessThan(
      lines.findIndex((l) => l.includes('<output>/redacted-views.sql')),
    )
  })

  it('D108, A95: says how to recover when apply aborts: an administrator pastes the printed fix and runs apply again until it passes', () => {
    const recovery = lines.filter((l) => l.startsWith('If apply aborts'))
    expect(recovery).toHaveLength(1)
    expect(recovery[0]).toContain('an administrator pastes the statements printed after Fix:')
    expect(recovery[0]).toContain('runs apply again, until it passes')
    expect(recovery[0]).toContain('(README: Running fixes without a superuser)')
    expect(lines.indexOf(recovery[0] ?? '')).toBeGreaterThan(
      lines.findIndex((l) => l.includes('<output>/redacted-views.sql')),
    )
  })

  it('D136, D137: sends a Prisma URL with parameters to prisma db execute, with sourceSchema set to its schema, and the login step to a libpq URL', () => {
    const route = lines.filter((l) => l.includes('npx prisma db execute --file'))
    expect(route).toHaveLength(1)
    expect(route[0]).toMatch(/^If the URL Prisma uses carries such parameters/)
    expect(route[0]).toContain('set sourceSchema to its ?schema= name')
    expect(text).toContain(
      'Do not strip the parameters for psql: prisma migrate deploy would then run against the stripped URL',
    )
    const login = lines.find((l) => l.startsWith('Once, after the first deploy')) ?? ''
    expect(login).toContain('a libpq URL of the same database without Prisma parameters')
    expect(login).toContain('in a shell where you run no Prisma command')
  })

  it('A99, D140: says roles are cluster-wide, so each database and generator block gets its own role', () => {
    expect(text).toContain(
      'Roles belong to the whole cluster, not to one database: give each database, and each generator block, its own role.',
    )
  })

  it('D56: warns that psql needs DATABASE_URL exported as a plain libpq URL', () => {
    const caveats = lines.filter((l) => l.includes('DATABASE_URL') && !/^ {2}psql /.test(l))
    expect(caveats).toHaveLength(1)
    expect(caveats[0]).toContain('Export DATABASE_URL')
    expect(caveats[0]).toContain('.env')
    expect(caveats[0]).toContain('libpq')
    expect(caveats[0]).toContain('?schema=public')
  })

  it('D56: names the role from the config it is given in the login step', () => {
    const custom = { ...DEFAULT_CONFIG, role: 'masked_reader' }
    expect(commandsIn(usage(custom)).at(-1)).toBe(
      `psql "${DB_URL}" -c "ALTER ROLE masked_reader LOGIN PASSWORD ${LOGIN_PASSWORD}"`,
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
