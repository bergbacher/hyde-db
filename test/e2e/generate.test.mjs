// The packed tarball under real `prisma generate`, `prisma db execute` and the bin outside Prisma
// (D20, D30, D43, D56, D66).
import assert from 'node:assert/strict'
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { before, describe, it } from 'node:test'
import {
  createProject,
  databaseUrl,
  dbExecute,
  hydeDb,
  PRISMA_VERSIONS,
  packedVersion,
  prisma,
  readRepoFile,
  writeSchema,
} from './helpers.mjs'

const OUTPUT_FILES = ['redacted-views.sql', 'redacted-views-drop.sql', 'redacted-schema.md']
const APPLY = 'prisma/redacted/redacted-views.sql'
const DROP = 'prisma/redacted/redacted-views-drop.sql'
const example = readRepoFile('example', 'schema.prisma')

const COLUMNS_CHECK = `DO $$ BEGIN
  IF (SELECT string_agg(column_name::text, ',' ORDER BY ordinal_position) FROM information_schema.columns
      WHERE table_schema = 'redacted' AND table_name = 'users') IS DISTINCT FROM 'id,created_at,country,plan' THEN
    RAISE EXCEPTION 'redacted.users does not have exactly the visible columns';
  END IF;
END $$;`

/** Raises unless the views schema exists (`present`) or is gone (`!present`). */
const schemaCheck = (present) => `DO $$ BEGIN
  IF ${present ? 'NOT ' : ''}EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'redacted') THEN
    RAISE EXCEPTION 'schema redacted is ${present ? 'missing' : 'still there'}';
  END IF;
END $$;`

function generateExample(dir, version) {
  writeSchema(dir, version, example)
  const result = prisma(dir, ['generate'])
  assert.equal(result.status, 0, result.output)
  return result
}

/** The example tables, as `prisma migrate deploy` would leave them, with the PostgreSQL 14 hardening applied. */
function loadTables(dir, version) {
  const tables = `${readRepoFile('test', 'fixtures', 'sql', 'example-tables.sql')}\nREVOKE CREATE ON SCHEMA public FROM PUBLIC;\n`
  const result = dbExecute(dir, version, { stdin: tables })
  assert.equal(result.status, 0, result.output)
}

for (const version of PRISMA_VERSIONS) {
  describe(`Prisma ${version}`, () => {
    let dir
    before(() => {
      databaseUrl() // fail before the slow install, not after
      dir = createProject(`p${version.split('.')[0]}`, [`prisma@${version}`])
    })

    it(`D30: prisma generate writes files identical to example/redacted (Prisma ${version})`, () => {
      const result = generateExample(dir, version)
      for (const file of OUTPUT_FILES) {
        assert.equal(
          readFileSync(join(dir, 'prisma', 'redacted', file), 'utf8'),
          readRepoFile('example', 'redacted', file),
          file,
        )
      }
      assert.match(
        result.stdout,
        /hyde-db: 2 views, 8 visible columns and 6 hidden columns → prisma[/\\]redacted/,
      )
    })

    it(`A34: Prisma starts the generator with PRISMA_GENERATOR_INVOCATION=true and no arguments (Prisma ${version})`, () => {
      const log = join(dir, 'invocations.jsonl')
      const probe = join(dir, 'probe.cjs')
      writeFileSync(
        probe,
        `if (/(hyde-db|generator\\.mjs)$/.test(process.argv[1] ?? ''))
  require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({
    args: process.argv.slice(2),
    invocation: process.env.PRISMA_GENERATOR_INVOCATION,
  }) + '\\n')
`,
      )
      writeSchema(dir, version, example)
      const result = prisma(dir, ['generate'], { env: { NODE_OPTIONS: `--require ${probe}` } })
      assert.equal(result.status, 0, result.output)
      const seen = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
      assert.ok(seen.length >= 1, 'Prisma did not start the hyde-db binary')
      for (const invocation of seen) assert.deepEqual(invocation, { args: [], invocation: 'true' })
    })

    it(`D51: a schema error fails prisma generate and names its code (Prisma ${version})`, () => {
      writeSchema(
        dir,
        version,
        example.replace('  orders       Order[]', '  phone        String\n  orders       Order[]'),
      )
      const result = prisma(dir, ['generate'])
      assert.notEqual(result.status, 0)
      assert.match(result.output, /HYDE_STRICT_UNANNOTATED at User\.phone/)
    })

    it(`D51: warnings reach the terminal on success (Prisma ${version})`, () => {
      writeSchema(
        dir,
        version,
        example.replace('/// @hyde.hidden\n  email', '/// @hyde.visible\n  email'),
      )
      const result = prisma(dir, ['generate'])
      assert.equal(result.status, 0, result.output)
      assert.match(result.stdout, /warning HYDE_SENSITIVE_EXPLICIT at User\.email/)
    })

    it(`the installed hyde-db bin resolves into the project's node_modules/@hyde/db (Prisma ${version})`, () => {
      const bin = realpathSync(join(dir, 'node_modules', '.bin', 'hyde-db'))
      assert.ok(
        bin.startsWith(join(realpathSync(dir), 'node_modules', '@hyde', 'db', '')),
        `bin resolves to ${bin}`,
      )
    })

    it(`D56: npx hyde-db --help prints the generator block and exits 0 (Prisma ${version})`, () => {
      const result = hydeDb(dir, ['--help'])
      assert.equal(result.status, 0, result.output)
      assert.equal(result.stderr, '')
      assert.match(result.stdout, /generator redacted \{\n {4}provider = "hyde-db"\n/)
    })

    it(`D56: npx hyde-db --version prints the tarball's version (Prisma ${version})`, () => {
      const result = hydeDb(dir, ['--version'])
      assert.equal(result.status, 0, result.output)
      assert.equal(result.stdout.trim(), packedVersion())
    })

    it(`D66: provider = "hyde-db --help" fails prisma generate with the provider rule and writes no files (Prisma ${version})`, () => {
      writeSchema(dir, version, example)
      const schemaPath = join(dir, 'prisma', 'schema.prisma')
      const schema = readFileSync(schemaPath, 'utf8')
      assert.ok(schema.includes('provider = "hyde-db"'), 'example schema has the generator block')
      writeFileSync(
        schemaPath,
        schema.replace('provider = "hyde-db"', 'provider = "hyde-db --help"'),
      )
      rmSync(join(dir, 'prisma', 'redacted'), { recursive: true, force: true })
      const result = prisma(dir, ['generate'])
      assert.notEqual(result.status, 0, result.output)
      assert.match(
        result.output,
        /hyde-db: Prisma passed arguments \(--help\); the generator block must read provider = "hyde-db" with nothing after it\./,
      )
      assert.equal(existsSync(join(dir, 'prisma', 'redacted')), false, 'files were written')
    })

    it(`A30: prisma db execute --file applies the drop and apply scripts unchanged (Prisma ${version})`, () => {
      generateExample(dir, version)
      loadTables(dir, version)
      const failing = dbExecute(dir, version, {
        stdin: "DO $$ BEGIN RAISE EXCEPTION 'control: db execute must report SQL errors'; END $$;",
      })
      assert.notEqual(failing.status, 0, 'db execute swallowed an SQL error')
      assert.match(failing.output, /control: db execute must report SQL errors/)
      const dropped = dbExecute(dir, version, { file: DROP })
      assert.equal(dropped.status, 0, dropped.output)
      const applied = dbExecute(dir, version, { file: APPLY })
      assert.equal(applied.status, 0, applied.output)
      const checked = dbExecute(dir, version, { stdin: COLUMNS_CHECK })
      assert.equal(checked.status, 0, checked.output)
      assert.equal(dbExecute(dir, version, { file: APPLY }).status, 0, 'repeated apply')
    })

    it(`D43: drop → apply round trips with prisma db execute (Prisma ${version})`, () => {
      generateExample(dir, version)
      loadTables(dir, version)
      for (const round of [1, 2]) {
        const dropped = dbExecute(dir, version, { file: DROP })
        assert.equal(dropped.status, 0, `round ${round} drop: ${dropped.output}`)
        const gone = dbExecute(dir, version, { stdin: schemaCheck(false) })
        assert.equal(gone.status, 0, `round ${round} drop left the schema: ${gone.output}`)
        const applied = dbExecute(dir, version, { file: APPLY })
        assert.equal(applied.status, 0, `round ${round} apply: ${applied.output}`)
        const back = dbExecute(dir, version, { stdin: schemaCheck(true) })
        assert.equal(back.status, 0, `round ${round} apply did not create it: ${back.output}`)
      }
    })
  })
}
