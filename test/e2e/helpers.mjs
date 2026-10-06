// End-to-end helpers (D20, D37). Plain ESM on node:test with no dependencies, so the layer
// runs on every Node version in engines, including 20.
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Prisma versions to test; CI sets one per job. Anything but a 6.x.y or 7.x.y fails loudly. */
export const PRISMA_VERSIONS = (process.env.E2E_PRISMA_VERSIONS ?? '6.19.3,7.10.0')
  .split(',')
  .map((version) => version.trim())
for (const version of PRISMA_VERSIONS) {
  if (!/^[67]\.\d+\.\d+$/.test(version))
    throw new Error(
      `E2E_PRISMA_VERSIONS must list exact Prisma 6 or 7 versions such as 6.19.3,7.10.0; got "${version}".`,
    )
}

export function tarballPath() {
  if (process.env.E2E_TARBALL) return resolve(process.env.E2E_TARBALL)
  const dir = join(repoRoot, '.e2e')
  const tarballs = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.tgz')) : []
  if (tarballs.length !== 1)
    throw new Error(`expected exactly one .tgz in ${dir}; run "pnpm test:e2e"`)
  return join(dir, tarballs[0])
}

/** The version in the tarball's own package.json, which is what the installed bin must report. */
export function packedVersion() {
  const tar = run('tar', ['-xzOf', tarballPath(), 'package/package.json'])
  if (tar.status !== 0) throw new Error(tar.output)
  return JSON.parse(tar.stdout).version
}

/** Fails, never skips, without a database (the same rule as D22). */
export function databaseUrl() {
  const url = process.env.E2E_DATABASE_URL
  if (!url)
    throw new Error(
      'E2E_DATABASE_URL is not set; start PostgreSQL and export its URL (see README "Development").',
    )
  return url
}

/** Ten minutes: long enough for an npm install of Prisma, short enough that a hang fails the run. */
const DEFAULT_TIMEOUT_MS = 600_000

// An empty npm user config, so a developer's ~/.npmrc cannot change what the children print.
const emptyNpmrc = join(mkdtempSync(join(tmpdir(), 'hyde-e2e-npmrc-')), 'npmrc')
writeFileSync(emptyNpmrc, '')
process.on('exit', () => rmSync(dirname(emptyNpmrc), { recursive: true, force: true }))

/** Hermetic npm: no update notice, funding or audit lines, so `stderr === ''` assertions hold. */
const NPM_ENV = {
  npm_config_update_notifier: 'false',
  npm_config_fund: 'false',
  npm_config_audit: 'false',
  npm_config_userconfig: emptyNpmrc,
}

export function run(command, args, { cwd, env = {}, input, timeout = DEFAULT_TIMEOUT_MS } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    input,
    timeout,
    encoding: 'utf8',
    env: {
      ...process.env,
      PRISMA_HIDE_UPDATE_MESSAGE: '1',
      CHECKPOINT_DISABLE: '1',
      ...NPM_ENV,
      ...env,
    },
  })
  if (result.error?.code === 'ETIMEDOUT')
    throw new Error(
      `${command} ${args.join(' ')} did not finish within ${timeout} ms and was killed (${result.signal ?? 'no signal'})`,
    )
  if (result.error) throw result.error
  if (result.status === null)
    throw new Error(
      `${command} ${args.join(' ')} ended without an exit status (signal ${result.signal ?? 'unknown'}):\n${result.stdout}\n${result.stderr}`,
    )
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    output: `${result.stdout}\n${result.stderr}`,
  }
}

export function readRepoFile(...segments) {
  return readFileSync(join(repoRoot, ...segments), 'utf8')
}

const projects = []
// A Prisma install is 100 to 250 MB, so a project does not outlive the process that made it.
process.on('exit', () => {
  for (const dir of projects) rmSync(dir, { recursive: true, force: true })
})

/** A temp project with the packed hyde-db and the given packages installed from npm. */
export function createProject(prefix, packages) {
  const dir = mkdtempSync(join(tmpdir(), `hyde-e2e-${prefix}-`))
  projects.push(dir)
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'e2e', private: true, version: '0.0.0' }),
  )
  const install = run(
    'npm',
    ['install', '--no-audit', '--no-fund', '--loglevel=error', ...packages, tarballPath()],
    { cwd: dir },
  )
  if (install.status !== 0) throw new Error(install.output)
  return dir
}

/**
 * Writes prisma/schema.prisma (and prisma.config.ts on Prisma 7) the way the README tells
 * users to: Prisma 6 reads the URL from the schema, Prisma 7 from prisma.config.ts.
 */
export function writeSchema(dir, prismaVersion, source) {
  const major = Number(prismaVersion.split('.')[0])
  let schema = source.replace(/generator client \{[^}]*\}\n*/, '')
  if (major === 6)
    schema = schema.replace(
      /(datasource db \{\n\s*provider = "postgresql")/,
      '$1\n  url      = env("DATABASE_URL")',
    )
  mkdirSync(join(dir, 'prisma'), { recursive: true })
  writeFileSync(join(dir, 'prisma', 'schema.prisma'), schema)
  if (major === 7) {
    writeFileSync(
      join(dir, 'prisma.config.ts'),
      "import { defineConfig, env } from 'prisma/config'\n\nexport default defineConfig({\n  schema: 'prisma/schema.prisma',\n  datasource: { url: env('DATABASE_URL') },\n})\n",
    )
  }
}

/** Runs the Prisma CLI through npx, as the README does; npx puts node_modules/.bin on PATH, where Prisma finds the hyde-db provider. */
export function prisma(dir, args, { input, env } = {}) {
  return run('npx', ['--no', 'prisma', ...args], {
    cwd: dir,
    input,
    env: { ...env, DATABASE_URL: databaseUrl() },
  })
}

/**
 * Runs the installed hyde-db bin outside Prisma, as `npx hyde-db --help` does for a person or an
 * agent (D56). The flag is `--no-install`, not `--no`: npm's npx treats `--no` as an option that
 * takes a value and then answers `--help`/`--version` itself (observed on npm 10.9.4).
 */
export function hydeDb(dir, args) {
  return run('npx', ['--no-install', 'hyde-db', ...args], { cwd: dir, timeout: 60_000 })
}

/** The deploy command from the README: `prisma db execute --file` (D43). */
export function dbExecute(dir, prismaVersion, { file, stdin }) {
  const source = file === undefined ? ['--stdin'] : ['--file', file]
  const datasource = prismaVersion.startsWith('6.') ? ['--schema', 'prisma/schema.prisma'] : []
  return prisma(dir, ['db', 'execute', ...source, ...datasource], { input: stdin })
}
