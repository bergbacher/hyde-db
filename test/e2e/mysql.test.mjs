// The packed tarball under real `prisma generate` and `prisma db execute` with provider = "mysql"
// on Prisma 6 and 7 (D20, D30, D43, D103).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { before, describe, it } from 'node:test'
import {
  createProject,
  dbExecute,
  mysqlDatabaseUrl,
  PRISMA_VERSIONS,
  prisma,
  readRepoFile,
  writeSchema,
} from './helpers.mjs'

const OUTPUT_FILES = ['redacted-views.sql', 'redacted-views-drop.sql', 'redacted-schema.md']
const example = readRepoFile('example-mysql', 'schema.prisma')
const CONFIG_LINE = '// role = "redacted_reader"   schema = "redacted"   statementTimeout = "15s"'

/** The example tables, as `prisma migrate deploy` would leave them on MySQL, plus one row each. */
const TABLES = `DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS api_keys;
CREATE TABLE users (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  email VARCHAR(191) NOT NULL UNIQUE,
  password_hash VARCHAR(191) NOT NULL,
  full_name VARCHAR(191) NOT NULL,
  country VARCHAR(191) NOT NULL,
  plan ENUM('FREE', 'PRO') NOT NULL
);
CREATE TABLE orders (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  total_cents INT NOT NULL,
  placed_at DATETIME(3) NOT NULL,
  shipping_address VARCHAR(191) NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id)
);
CREATE TABLE api_keys (id INT NOT NULL PRIMARY KEY, secret VARCHAR(191) NOT NULL);
INSERT INTO users (email, password_hash, full_name, country, plan)
  VALUES ('ann@example.com', 'x', 'Ann Example', 'DE', 'PRO');
INSERT INTO orders (user_id, total_cents, placed_at, shipping_address)
  VALUES (1, 1200, '2026-10-05 12:00:00', 'Example Street 1');
INSERT INTO api_keys (id, secret) VALUES (1, 'sk_live_example');
`

for (const version of PRISMA_VERSIONS) {
  describe(`MySQL, Prisma ${version}`, () => {
    // One views database per Prisma version, so two jobs on one server do not collide.
    const views = `v${version.split('.')[0]}_e2e`
    const url = mysqlDatabaseUrl
    let dir
    const exec = (opts) => dbExecute(dir, version, { ...opts, url: url() })
    const generate = (source, extra = {}) => {
      writeSchema(dir, version, source)
      return prisma(dir, ['generate'], { url: url(), ...extra })
    }
    const named = () => example.replace(CONFIG_LINE, `schema = "${views}"`)
    const apply = () => join('prisma', 'redacted', 'redacted-views.sql')
    const drop = () => join('prisma', 'redacted', 'redacted-views-drop.sql')

    before(() => {
      url() // fail before the slow install, not after
      dir = createProject(`m${version.split('.')[0]}`, [`prisma@${version}`])
    })

    it(`D103: prisma generate with provider "mysql" writes files identical to example-mysql/redacted (Prisma ${version})`, () => {
      const result = generate(example)
      assert.equal(result.status, 0, result.output)
      for (const file of OUTPUT_FILES) {
        assert.equal(
          readFileSync(join(dir, 'prisma', 'redacted', file), 'utf8'),
          readRepoFile('example-mysql', 'redacted', file),
          file,
        )
      }
    })

    it(`D103: prisma db execute --file applies the MySQL apply script, twice (a re-apply passes) (Prisma ${version})`, () => {
      const generated = generate(named())
      assert.equal(generated.status, 0, generated.output)
      const loaded = exec({ stdin: TABLES })
      assert.equal(loaded.status, 0, loaded.output)
      const first = exec({ file: apply() })
      assert.equal(first.status, 0, first.output)
      const again = exec({ file: apply() })
      assert.equal(again.status, 0, `re-apply: ${again.output}`)
    })

    it(`D103, D117: the apply refuses a database without the marker and prints the hyde-db message (Prisma ${version})`, () => {
      const generated = generate(named())
      assert.equal(generated.status, 0, generated.output)
      const loaded = exec({ stdin: TABLES })
      assert.equal(loaded.status, 0, loaded.output)
      const dropped = exec({ file: drop() })
      assert.equal(dropped.status, 0, dropped.output)
      const created = exec({ stdin: `CREATE DATABASE \`${views}\`;` })
      assert.equal(created.status, 0, created.output)
      try {
        const refused = exec({ file: apply() })
        assert.notEqual(refused.status, 0, 'the apply touched a database it did not create')
        assert.match(refused.output, /hyde-db: .*marker.* Fix: /)
      } finally {
        const cleaned = exec({ stdin: `DROP DATABASE IF EXISTS \`${views}\`;` })
        assert.equal(cleaned.status, 0, cleaned.output)
      }
    })

    it(`D100, D121: prisma db execute applies the drop script, and a second drop also succeeds (Prisma ${version})`, () => {
      const generated = generate(named())
      assert.equal(generated.status, 0, generated.output)
      const loaded = exec({ stdin: TABLES })
      assert.equal(loaded.status, 0, loaded.output)
      const applied = exec({ file: apply() })
      assert.equal(applied.status, 0, applied.output)
      const dropped = exec({ file: drop() })
      assert.equal(dropped.status, 0, dropped.output)
      const again = exec({ file: drop() })
      assert.equal(again.status, 0, `second drop: ${again.output}`)
      const created = exec({ stdin: `CREATE DATABASE \`${views}\`;` })
      assert.equal(created.status, 0, `the views database was not dropped: ${created.output}`)
      const cleaned = exec({ stdin: `DROP DATABASE \`${views}\`;` })
      assert.equal(cleaned.status, 0, cleaned.output)
    })

    it(`D97: a MySQL generator block with sourceSchema fails prisma generate naming HYDE_CONFIG_KEY_UNSUPPORTED (Prisma ${version})`, () => {
      const result = generate(example.replace(CONFIG_LINE, 'sourceSchema = "public"'))
      assert.notEqual(result.status, 0, result.output)
      assert.match(result.output, /HYDE_CONFIG_KEY_UNSUPPORTED/)
    })
  })
}
