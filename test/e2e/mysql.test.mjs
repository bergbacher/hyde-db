// The packed tarball under real `prisma generate` and `prisma db execute` with provider = "mysql"
// on Prisma 6 and 7 (D20, D30, D43, D103).
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
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

/** Quotes a string for a SQL literal (single quotes doubled). */
const lit = (value) => `'${value.replaceAll("'", "''")}'`

/**
 * Assertions as SQL (A76: \`prisma db execute\` drops result sets, so only an error can report a
 * mismatch). Each check is a temporary table whose one NOT NULL column carries the check's name;
 * the INSERT ... SELECT yields NULL, and so fails under strict mode, exactly when the condition
 * is not true (the D99 technique). \`checks\` maps a name to a SQL condition.
 */
function assertionSql(checks) {
  const lines = ["SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_BACKSLASH_ESCAPES';"]
  for (const [name, condition] of Object.entries(checks)) {
    lines.push(
      'DROP TEMPORARY TABLE IF EXISTS `e2e_check`;',
      `CREATE TEMPORARY TABLE \`e2e_check\` (\`${name}\` INT NOT NULL);`,
      `INSERT INTO \`e2e_check\` SELECT NULL FROM DUAL WHERE NOT COALESCE((${condition}), 0);`,
    )
  }
  lines.push('DROP TEMPORARY TABLE IF EXISTS `e2e_check`;')
  return lines.join('\n')
}

/** Conditions on what the reader holds, as the mysql.* grant tables see it. */
function noGrants(reader) {
  const r = lit(reader)
  return {
    reader_has_no_table_grants: `(SELECT COUNT(*) FROM mysql.tables_priv WHERE User = ${r}) = 0`,
    reader_has_no_column_grants: `(SELECT COUNT(*) FROM mysql.columns_priv WHERE User = ${r}) = 0`,
    reader_has_no_db_grants: `(SELECT COUNT(*) FROM mysql.db WHERE User = ${r}) = 0`,
    reader_has_no_global_grants: `(SELECT COUNT(*) FROM mysql.global_grants WHERE USER = ${r}) = 0
      AND (SELECT COUNT(*) FROM information_schema.USER_PRIVILEGES
           WHERE GRANTEE = CONCAT(QUOTE(${r}), '@', QUOTE('%')) AND PRIVILEGE_TYPE <> 'USAGE') = 0`,
  }
}

for (const version of PRISMA_VERSIONS) {
  describe(`MySQL, Prisma ${version}`, () => {
    // Everything the version touches is its own, so the Prisma 6 and 7 runs can share one server:
    // the views database, the reader account and a source database holding the example tables.
    const major = version.split('.')[0]
    const views = `v${major}_e2e`
    const reader = `e2e_reader_v${major}`
    const source = `v${major}_e2e_src`
    const url = mysqlDatabaseUrl
    /** The configured URL with the per-version source database as its default database (D160). */
    const sourceUrl = () => {
      const u = new URL(url())
      u.pathname = `/${source}`
      return u.toString()
    }
    let dir
    const execAt = (target, opts) => dbExecute(dir, version, { ...opts, url: target })
    const exec = (opts) => execAt(sourceUrl(), opts)
    const generate = (source, extra = {}) => {
      writeSchema(dir, version, source)
      return prisma(dir, ['generate'], { url: url(), ...extra })
    }
    const named = () => example.replace(CONFIG_LINE, `schema = "${views}"\n  role   = "${reader}"`)
    const apply = () => join('prisma', 'redacted', 'redacted-views.sql')
    const drop = () => join('prisma', 'redacted', 'redacted-views-drop.sql')

    before(() => {
      url() // fail before the slow install, not after
      dir = createProject(`m${major}`, [`prisma@${version}`])
      writeSchema(dir, version, example) // Prisma 6 db execute reads the datasource from the schema
      const created = execAt(url(), { stdin: `CREATE DATABASE IF NOT EXISTS \`${source}\`;` })
      assert.equal(created.status, 0, created.output)
    })

    after(() => {
      // Best effort and idempotent (D121): drop script, the reader account, the source database.
      if (!dir) return
      if (existsSync(join(dir, drop()))) exec({ file: drop() })
      execAt(url(), {
        stdin: `DROP USER IF EXISTS ${lit(reader)}@'%';\nDROP DATABASE IF EXISTS \`${views}\`;\nDROP DATABASE IF EXISTS \`${source}\`;`,
      })
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

      // Exit codes alone prove little: check what the apply left behind, as SQL that aborts on a mismatch.
      const v = lit(views)
      const r = lit(reader)
      const verify = exec({
        stdin: assertionSql({
          views_are_exactly_the_expected_ones: `(SELECT GROUP_CONCAT(TABLE_NAME ORDER BY TABLE_NAME) FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ${v}) = 'hyde_db_marker,orders,users'`,
          users_view_has_exactly_the_visible_columns: `(SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY ORDINAL_POSITION) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ${v} AND TABLE_NAME = 'users') = 'id,created_at,country,plan'`,
          orders_view_has_exactly_the_visible_columns: `(SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY ORDINAL_POSITION) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ${v} AND TABLE_NAME = 'orders') = 'id,user_id,total_cents,placed_at'`,
          no_hidden_column_in_any_view: `(SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ${v} AND COLUMN_NAME IN ('email', 'password_hash', 'full_name', 'shipping_address', 'secret')) = 0`,
          reader_has_select_on_each_view_and_nothing_else_in_tables_priv: `(SELECT GROUP_CONCAT(CONCAT(Db, '.', Table_name, ':', Table_priv, ':', Column_priv) ORDER BY Table_name) FROM mysql.tables_priv WHERE User = ${r}) = CONCAT(${v}, '.orders:Select:,', ${v}, '.users:Select:')`,
          reader_has_no_column_grants: `(SELECT COUNT(*) FROM mysql.columns_priv WHERE User = ${r}) = 0`,
          reader_has_no_db_grants: `(SELECT COUNT(*) FROM mysql.db WHERE User = ${r}) = 0`,
          reader_has_no_global_grants: noGrants(reader).reader_has_no_global_grants,
          reader_exists: `(SELECT COUNT(*) FROM mysql.user WHERE User = ${r}) = 1`,
        }),
      })
      assert.equal(verify.status, 0, `the apply left the wrong state: ${verify.output}`)

      // Negative control: a false assertion must fail, or the checks above could pass vacuously.
      const control = exec({ stdin: assertionSql({ control_that_must_fail: '1 = 0' }) })
      assert.notEqual(control.status, 0, 'db execute swallowed a failing assertion')
      assert.match(control.output, /control_that_must_fail/)
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
      const bare = exec({
        stdin: assertionSql({
          views_database_is_gone: `(SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ${lit(views)}) = 0`,
          ...noGrants(reader),
        }),
      })
      assert.equal(bare.status, 0, `the drop left the reader with grants: ${bare.output}`)
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
