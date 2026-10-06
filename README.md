# hyde-db

A Prisma generator that gives any reader, whether an AI tool or a person, read access to a Prisma-managed PostgreSQL database, limited to the columns your schema's annotations allow. <!-- Intent, D53, D3 -->

You mark fields `/// @hyde.visible` or `/// @hyde.hidden`. `prisma generate` then writes three files: <!-- D54 -->

| File | What it does |
|---|---|
| `redacted-views.sql` | Creates schema `redacted` with one view per model that holds only the visible columns, and a role `redacted_reader` that can `SELECT` from those views and nothing else. A final check aborts the script if the role could reach anything more. |
| `redacted-views-drop.sql` | Drops schema `redacted`, so migrations can change the columns the views use. |
| `redacted-schema.md` | Tables, columns and joins of the views, for whoever queries them. |

Hidden columns do not exist in the views, so every query that names one, such as `left(email, 1)` or `WHERE email LIKE …`, fails because the column does not exist. PostgreSQL's privileges enforce this; no result filter is involved. <!-- D1 -->

## Quick start

Install the package:

```sh
npm install --save-dev hyde-db
```

Add a generator block to `prisma/schema.prisma`: <!-- D3, D54 -->

```prisma
generator redacted {
  provider = "hyde-db"
  output   = "./redacted"
}
```

Annotate every scalar and enum field. Every field needs a decision, because strict mode is on by default. Relation fields such as `orders` and `user` need none. <!-- D54 -->

```prisma
/// A customer account.
model User {
  /// @hyde.visible
  id      Int     @id @default(autoincrement())
  /// @hyde.hidden
  email   String  @unique
  /// @hyde.visible
  /// ISO 3166 country code
  country String
  orders  Order[]
}

model Order {
  /// @hyde.visible
  id         Int  @id @default(autoincrement())
  /// @hyde.visible
  userId     Int
  user       User @relation(fields: [userId], references: [id])
  /// @hyde.visible
  /// Total in cents
  totalCents Int
}
```

Generate:

```sh
npx prisma generate
```

On success it prints one line: <!-- D28 -->

```text
hyde-db: 2 views, 5 visible and 1 hidden columns → prisma/redacted
```

Then commit `prisma/redacted/`, [deploy](#deploy), and do the [one-time setup](#one-time-setup).

## Supported versions

- **Prisma:** the Prisma 6 and 7 CLIs, tested on 6.19.3 and 7.10.0. Prisma 8 has no generator step, so hyde-db cannot run there; whether to read Prisma 8's contract IR instead is an open question. <!-- D30, A19, A18, Q5 -->
- **PostgreSQL:** 14 to 18; the attack suite runs on 14 and 18. No other database is supported. <!-- A11, D21, D34 -->
- **Node.js:** `^20.19 || ^22.12 || >=24`. <!-- D31 -->
- **Runtime dependencies:** none. <!-- D32 -->

## Generator block

This block sets every key to its default; leave out any key you do not change: <!-- D54 -->

```prisma
generator redacted {
  provider         = "hyde-db"
  output           = "./redacted"
  strict           = "true"
  default          = "hidden"
  schema           = "redacted"
  role             = "redacted_reader"
  sourceSchema     = "public"
  statementTimeout = "15s"
}
```

| Key | Default | Accepts | Effect |
|---|---|---|---|
| `provider` | required | exactly `"hyde-db"` | Prisma runs the provider as a command, so any extra word reaches hyde-db as an argument: an unknown one fails `prisma generate` with `hyde-db: unknown argument "…"`, and a help or version argument makes it print that and write nothing while `prisma generate` still exits 0. |
| `output` | `"./redacted"` | a directory | Where the three files go, relative to `schema.prisma`. |
| `strict` | `"true"` | `"true"`, `"false"` | `"true"`: every scalar and enum field needs `@hyde.visible` or `@hyde.hidden`, and `@hyde.default` is an error. |
| `default` | `"hidden"` | `"hidden"`, `"visible"` | Visibility of unannotated fields; takes effect only with `strict = "false"`. |
| `schema` | `"redacted"` | `[a-z_][a-z0-9_]*`, at most 63 characters | Schema that holds the views; the scripts drop and recreate it. |
| `role` | `"redacted_reader"` | `[a-z_][a-z0-9_]*`, at most 63 characters | Role that may read the views. |
| `sourceSchema` | `"public"` | `[a-z_][a-z0-9_]*`, at most 63 characters | Schema of models without `@@schema`. |
| `statementTimeout` | `"15s"` | digits with an optional `ms`, `s` or `min` (bare digits are milliseconds), at most 2147483647 ms | The reader role's default statement timeout; a zero value turns it off and warns. |

<!-- D61, D25, D59 -->

- Values are plain strings. `env("…")` is not supported in the generator block: Prisma passes the variable's name, not its value, so the value is rejected as invalid. <!-- D35, A22 -->
- An unknown key or an invalid value is an error that names the closest valid spelling, for example `unknown config key "strickt" (did you mean "strict"?)`. <!-- D25 -->
- `schema` must differ from `sourceSchema` and from every model's `@@schema`, because the scripts drop and recreate it. <!-- D12 -->

## Annotations

Write annotations in `///` doc comments. Other doc text becomes the comment on the view or column and its description in `redacted-schema.md`. <!-- D54 -->

| Annotation | On | Effect |
|---|---|---|
| `@hyde.visible` | field | The column appears in the view. |
| `@hyde.hidden` | field | The column is left out. |
| `@hyde.exclude` | model | The model gets no view. |
| `@hyde.default(visible)`, `@hyde.default(hidden)` | model | Visibility of the model's unannotated fields; needs `strict = "false"`. |

- Relation fields never become columns. Annotate the scalar foreign-key fields instead; an annotation on a relation field is a warning.
- A field with both `@hyde.visible` and `@hyde.hidden` is an error and counts as hidden. <!-- D57 -->
- A model without visible columns gets no view.
- Prisma `view` blocks are processed like models. <!-- D34, A21 -->
- Fields Prisma does not pass to generators (`@ignore` fields, `@@ignore` models and `Unsupported(...)` fields) never appear. <!-- A21 -->
- A misspelled annotation is an error that names the closest valid one, for example `unknown annotation @hyde.visable (did you mean @hyde.visible?)`. <!-- D25 -->
- The `@ai.*` annotations of prisma-ai-views have no effect and produce a warning. <!-- D60 -->

### Sensitive names

A field whose name or column name looks sensitive (`password`, `token`, `email`, `phone`, `iban`, `address`, `birthDate`, `zip`, …) never becomes visible through a default: that is an error. It needs an explicit `@hyde.visible`, which still produces a warning. <!-- D16 -->

Names are split into words. Long, unambiguous stems such as `password` or `email` match anywhere; short terms such as `zip`, `ip`, `card` or `lat` match only as whole words, plurals included, so `passenger`, `discarded` and `flat` are not flagged. An all-lowercase run-together name like `billingzip` therefore misses short terms; strict mode still forces a decision on it. <!-- D16, A5 -->

## Deploy

**In CI**, regenerate and fail when the committed files are stale, so every pull request shows what the reader gains or loses:

```sh
npx prisma generate
git diff --exit-code prisma/redacted
```

**On every deploy**, run three steps against the database, in this order: drop the views, migrate, apply. A migration cannot alter a column that a view uses, so the views go first and come back after. <!-- D43 -->

With `psql`:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/redacted/redacted-views-drop.sql
npx prisma migrate deploy
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/redacted/redacted-views.sql
```

- psql does not read `.env`. Export `DATABASE_URL` in the shell as a plain libpq URL, without Prisma-only parameters such as `?schema=public`, which psql rejects. <!-- D61 -->
- Keep `-v ON_ERROR_STOP=1`. Without it, psql exits 0 even when a script is refused: the database stays unchanged, but the deploy does not notice. <!-- D58 -->

With Prisma 7 (the database URL comes from `prisma.config.ts`):

```sh
npx prisma db execute --file prisma/redacted/redacted-views-drop.sql
npx prisma migrate deploy
npx prisma db execute --file prisma/redacted/redacted-views.sql
```

With Prisma 6 (the database URL comes from the datasource's `url`):

```sh
npx prisma db execute --file prisma/redacted/redacted-views-drop.sql --schema prisma/schema.prisma
npx prisma migrate deploy
npx prisma db execute --file prisma/redacted/redacted-views.sql --schema prisma/schema.prisma
```

<!-- D43, A30 -->

The paths assume `prisma/schema.prisma` and `output = "./redacted"`. The deploy user can be a superuser or a non-superuser owner with `CREATEROLE`; see [deploy permissions](#deploy-permissions). <!-- D49 -->

### One-time setup

**1. Let the reader log in.** The apply script creates `redacted_reader` without login. Put its password in `READER_PASSWORD` (from your secret store; never commit it), then run once: <!-- D61 -->

```sh
psql "$DATABASE_URL" -c "ALTER ROLE redacted_reader LOGIN PASSWORD '${READER_PASSWORD:?set READER_PASSWORD first}'"
```

The shell runs nothing while `READER_PASSWORD` is unset or empty. The password must not contain a single quote. Later deploys keep the login and the password.

**2. On PostgreSQL 14 and older**, and on clusters upgraded from them, every role may create objects in schema `public`. The apply script refuses to finish while `redacted_reader` can create objects anywhere, so run once: <!-- A15, D24 -->

```sql
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
```

**3. Other databases in the cluster.** `redacted_reader` may by default connect to every other database in the same cluster, where none of these checks run. Revoke that for each of them; roles that need such a database then need their own `GRANT CONNECT`: <!-- D15, A14 -->

```sql
REVOKE CONNECT ON DATABASE other_database FROM PUBLIC;
```

**4. Connect the reader** (an AI tool, a PostgreSQL MCP server or a person's SQL client) as `redacted_reader`, preferably to a read replica, and give it `redacted-schema.md`. The role's `search_path` is `redacted`, so unqualified view names work.

### Deploy permissions

The scripts run as a superuser, or as a non-superuser owner with `CREATEROLE`, the setup managed PostgreSQL services commonly use. The deploy user must be able to create schemas in the database and to read the source tables, because the views run with their owner's privileges. <!-- D49, A31, A33 -->

| Situation | What happens | What to do |
|---|---|---|
| The deploy user does not own the source tables. | Apply prints `WARNING: no privileges could be revoked for "users"` (and one per column) and succeeds. | Nothing: the final check guarantees the result. |
| The final check prints `Fix: ALTER ROLE redacted_reader NO…;`. | A `CREATEROLE` user can run `NOCREATEROLE`, and on PostgreSQL 14 also `NOCREATEDB`; the other attributes need more. | Run the printed fix as the provider's admin role or a superuser. |
| `redacted_reader` already exists as a superuser, or (PostgreSQL 16 and later) was created by another role. | Apply stops at `ALTER ROLE "redacted_reader" SET …` with a permission error, before the final check. Nothing changes. | Fix the role as an admin (below), then deploy again. |

<!-- D49, A31 -->

```sql
ALTER ROLE redacted_reader NOSUPERUSER;
GRANT redacted_reader TO <deploy-user> WITH ADMIN OPTION;
```

The first statement is for a superuser reader role; the second, on PostgreSQL 16 and later, lets the deploy user manage a role it did not create.

### Transactions and the schema marker

- Each script is one transaction. A refused drop or apply changes nothing, under any client. <!-- D58 -->
- If your own code runs the scripts over a pooled connection, send `ROLLBACK` after an error, before the connection is reused.
- The scripts drop schema `redacted` only when its comment is the hyde-db marker: `Generated by hyde-db`, alone or followed by `.` and more text. Any other schema of that name stops them with `schema redacted exists but was not created by hyde-db … refusing to drop it`. Rename or drop that schema yourself, or set `schema` to an unused name. <!-- D11, D58 -->

## What the final check refuses

The apply script ends with a check inside its transaction. It aborts the whole script, so nothing changes, when `redacted_reader` meets any condition below, checked in this order. Each error starts with `hyde-db: role redacted_reader`. <!-- D1, D13, D24, D49 -->

| Refused when `redacted_reader`… | Error, after the role name | Fix |
|---|---|---|
| has `SUPERUSER`, `CREATEDB`, `CREATEROLE`, `REPLICATION` or `BYPASSRLS` | `has attributes it must not have: CREATEDB` | printed: `ALTER ROLE redacted_reader NOCREATEDB;` |
| can read a table, partitioned table, view, materialized view or foreign table outside `redacted`, including through `PUBLIC` grants, column grants or membership in `pg_read_all_data` | `can read relations outside schema redacted: public.users` | not printed: revoke the grant, for example `REVOKE SELECT ON public.users FROM PUBLIC;` |
| is a member of another role | `must not be a member of other roles` | not printed: `REVOKE <other-role> FROM redacted_reader;` |
| can execute a `SECURITY DEFINER` function in a schema it can use | `can execute SECURITY DEFINER functions: public.peek(n integer)` | printed: `REVOKE EXECUTE ON ROUTINE public.peek(n integer) FROM PUBLIC;` |
| can use a sequence (`SELECT`, `USAGE` or `UPDATE`) | `can read sequences: public.users_id_seq` | printed: `REVOKE ALL ON SEQUENCE public.users_id_seq FROM PUBLIC;` |
| can create objects in any schema | `can create objects in schemas: public` | printed: `REVOKE CREATE ON SCHEMA public FROM PUBLIC;` |

- A printed fix names whoever holds the privilege: `PUBLIC`, `redacted_reader` (also when it owns the object), or both. It works when pasted; run it as the object's owner or a superuser (for `ALTER ROLE`, see [deploy permissions](#deploy-permissions)), then deploy again. <!-- D13, D24, D49 -->
- The apply script itself revokes direct grants to `redacted_reader` on tables in `sourceSchema`, column grants included. <!-- D1 -->
- On PostgreSQL 14 and older, the default `CREATE` for `PUBLIC` on schema `public` is refused here; the [one-time setup](#one-time-setup) removes it. <!-- A15, D24 -->
- The check skips the applying session's own temporary schema. A `CREATE` grant on another session's temporary schema (`pg_temp_N`) is refused; such a grant outlives that session, and the printed `REVOKE` removes it. <!-- D24 -->

## What it guarantees and what it does not

The guarantee is the privilege setup: `redacted_reader` can read the generated views and nothing else, and the apply script proves that against the live database before it commits. <!-- D14, D1 -->

The role's read-only default and statement timeout are session defaults, not guarantees: `redacted_reader` can turn both off with `SET`. With read-only off it still cannot write to any table, because it holds no write privileges, but it can create temporary tables unless `TEMPORARY` on the database is revoked from `PUBLIC`, which affects every role. <!-- D14, A2, D50, A32 -->

| Not covered | Why | What to do |
|---|---|---|
| Rows | Every row of a visible model is visible. | Expose only models whose every row the reader may see; `@hyde.exclude` the others. |
| Content of visible columns | hyde-db judges names, not contents. A free-text column such as `description` can contain personal data. | Mark such a column `@hyde.hidden` unless you are sure. |
| Load | The timeout limits single statements, and the reader can lift it. | Connect the reader to a read replica. |
| Other databases in the cluster | The checks see one database. | Run the `REVOKE CONNECT` step of the [one-time setup](#one-time-setup). |

<!-- D34, D14, D15 -->

## Diagnostics

Every problem has a stable code. Any error fails `prisma generate` before it writes files, with one message that lists every problem; each error has a `fix:` line. On success, warnings and the summary line are printed. <!-- D51, D26, D29 -->

A failed run:

```text
hyde-db found 1 problem:
  error HYDE_STRICT_UNANNOTATED at User.phone: strict mode requires /// @hyde.visible or /// @hyde.hidden
    fix: Add /// @hyde.hidden above the field, or /// @hyde.visible if the reader may see it.
```

A warning on success:

```text
hyde-db: warning HYDE_SENSITIVE_EXPLICIT at User.email: explicitly visible although the name looks sensitive — double-check
```

| Code | Severity | When | What to do |
|---|---|---|---|
| `HYDE_CONFIG_UNKNOWN_KEY` | error | The generator block has a key hyde-db does not know. | Rename it to the suggested key, or remove it. |
| `HYDE_CONFIG_INVALID_VALUE` | error | A config value is invalid or not a string, including an `env()` call, which arrives as the variable's name; from `build` or `analyze`, also a config that is not a plain object. | Set the value the message names. |
| `HYDE_SCHEMA_CONFLICT` | error | `schema` equals `sourceSchema`, or a model's `@@schema` equals `schema`. | Point `schema` at a schema no model uses, or move the model. |
| `HYDE_ANNOTATION_UNKNOWN` | error | A `@hyde.*` annotation does not exist. | Use the suggested annotation. |
| `HYDE_ANNOTATION_MISPLACED` | error | `@hyde.visible` or `@hyde.hidden` on a model, or `@hyde.exclude` or `@hyde.default` on a field. | Move it; on a model, use `@hyde.default(…)`. |
| `HYDE_ANNOTATION_INVALID_ARGUMENT` | error | `@hyde.default` without `(visible)` or `(hidden)`. | Write `@hyde.default(visible)` or `@hyde.default(hidden)`. |
| `HYDE_ANNOTATION_CONFLICT` | error | A field has both `@hyde.visible` and `@hyde.hidden`. | Keep one. |
| `HYDE_STRICT_UNANNOTATED` | error | Strict mode and a scalar or enum field without `@hyde.visible` or `@hyde.hidden`. | Add `/// @hyde.hidden`, or `/// @hyde.visible` if the reader may see it. |
| `HYDE_STRICT_MODEL_DEFAULT` | error | `@hyde.default` in strict mode. | Annotate each field, or set `strict = "false"`. |
| `HYDE_SENSITIVE_IMPLICIT` | error | A sensitive-looking name would become visible through a default. | Add `@hyde.hidden`, or `@hyde.visible` if it is safe. |
| `HYDE_VIEW_NAME_COLLISION` | error | Two models map to the same view name. | Exclude one with `@hyde.exclude`. |
| `HYDE_UNSUPPORTED_PROVIDER` | error | The datasource provider is not `postgresql`. | Use hyde-db only with PostgreSQL. |
| `HYDE_NO_OUTPUT` | error | Prisma passed no output directory. | Set `output = "./redacted"`. |
| `HYDE_RELATION_ANNOTATED` | warning | A relation field carries `@hyde.visible` or `@hyde.hidden`, which has no effect. | Annotate the scalar foreign-key fields instead. |
| `HYDE_SENSITIVE_EXPLICIT` | warning | A sensitive-looking name is explicitly `@hyde.visible`. | Make sure the column is safe to show. |
| `HYDE_TIMEOUT_DISABLED` | warning | `statementTimeout` is zero, which turns the reader role's statement timeout off. | Use a positive value such as `"15s"`, or remove the key. |
| `HYDE_LEGACY_ANNOTATION` | warning | A doc comment holds an `@ai.*` annotation from prisma-ai-views, which has no effect. | Rename it to `@hyde.*`. |

<!-- D51, D25, D26, D57, D59, D60 -->

## Command line

Run outside `prisma generate`, the `hyde-db` binary prints its usage: what it does, the generator block with every default, the annotations, the output files and the deploy commands. <!-- D61, D55 -->

```sh
npx hyde-db --help
```

`help` and `-h` do the same; `--version`, `-v` and `version` print the version. Outside Prisma the binary never reads standard input, and an unknown argument exits with status 2. Prisma starts it with `PRISMA_GENERATOR_INVOCATION=true` and no arguments; only then does it speak the generator protocol. <!-- D61, A34 -->

## Migrating from prisma-ai-views

| prisma-ai-views | hyde-db |
|---|---|
| `provider = "prisma-ai-views"` | `provider = "hyde-db"` |
| `generator ai { … }` | `generator redacted { … }` (hyde-db ignores the block's name) |
| `output = "./ai"` | `output = "./redacted"` |
| `@ai.visible`, `@ai.hidden`, `@ai.exclude`, `@ai.default(…)` | `@hyde.visible`, `@hyde.hidden`, `@hyde.exclude`, `@hyde.default(…)` |
| `ai-views.sql`, `ai-views-drop.sql`, `ai-schema.md` | `redacted-views.sql`, `redacted-views-drop.sql`, `redacted-schema.md` |
| schema `ai`, role `ai_reader` | schema `redacted`, role `redacted_reader` |
| `strict` off by default | `strict` on by default |

<!-- D54, D3 -->

1. Replace the package: `npm uninstall prisma-ai-views`, then `npm install --save-dev hyde-db`.
2. Rename every `@ai.*` annotation to `@hyde.*`. A leftover one has no effect and warns with `HYDE_LEGACY_ANNOTATION`; in strict mode its field is also reported as unannotated. <!-- D60, A37 -->
3. Update the generator block, and the file paths in CI and deploy scripts. To keep the old non-strict behavior, set `strict = "false"`.
4. Deploy, then do the [one-time setup](#one-time-setup) for `redacted_reader`.
5. The old schema `ai` and role `ai_reader` stay untouched: the scripts never drop a schema without the hyde-db marker, so even with `schema = "ai"` they refuse to touch it. Until you drop the old schema, its views still block migrations that change the columns they use. Once the new views work, run as an admin: <!-- D11 -->

```sql
DROP SCHEMA ai CASCADE;
DROP ROLE ai_reader;
```

## Programmatic use

The package exports `build`, `analyze` and their types, nothing else. Both take the DMMF datamodel exactly as Prisma passes it to a generator (`options.dmmf.datamodel`) plus the generator config, and never throw on config input: every config problem becomes a diagnostic. <!-- D9, D47 -->

```ts
import { analyze, build } from 'hyde-db'

const { views, diagnostics, counts, files } = build(datamodel, { strict: 'true' })
```

- `analyze` returns `config`, `views`, `diagnostics` and `counts` (visible and hidden columns) without rendering files. <!-- D48 -->
- `build` adds `files`, the three file contents keyed by file name, or `null` when any diagnostic is an error.
- `HYDE_UNSUPPORTED_PROVIDER` and `HYDE_NO_OUTPUT` come only from `prisma generate`.
- The package is ESM-only; CommonJS code can `require('hyde-db')` on every supported Node.js version. <!-- D5, A12, D31 -->

## Development

Needs Node.js 22.22 or later, pnpm 10 and Docker. `LEDGER.md` is the single source of truth for decisions; this README is a view of it, and test names start with the record they verify. <!-- D37, D36, D19 -->

| Command | What it runs |
|---|---|
| `pnpm install` | Installs the development dependencies. |
| `pnpm lint` | Biome format and lint check; `pnpm lint:fix` applies fixes. |
| `pnpm typecheck` | TypeScript type check. |
| `pnpm build` | tsdown build with publint and attw checks. |
| `pnpm test` | Unit, characterization, DMMF contract and generator tests. |
| `pnpm test:coverage` | The same with the coverage gate: at least 95% of lines and branches in `src/`, generator entry excluded. |
| `pnpm test:integration` | Attack suite on a real PostgreSQL in Docker (`postgres:18-alpine`, or `PG_IMAGE`). Fails, never skips, without Docker. |
| `pnpm test:e2e` | Builds and packs the package, then runs real `prisma generate` and `prisma db execute` on Prisma 6.19.3 and 7.10.0, plus a CommonJS `require` check. Needs `E2E_DATABASE_URL`. |
| `pnpm golden` | Rewrites the golden files under `example/redacted/` and `test/fixtures/characterization/loose/redacted/`. Run it only after an output change that a ledger decision requires. |

<!-- D20, D22, D23, D6, D43 -->

Attack suite on PostgreSQL 14:

```sh
PG_IMAGE=postgres:14-alpine pnpm test:integration
```

**Warning: the end-to-end suite runs destructive SQL.** It drops the tables `users`, `orders` and `api_keys`, the type `Plan` and the schema `redacted`, revokes `CREATE` on schema `public` from `PUBLIC`, and creates the cluster-wide role `redacted_reader`. Point `E2E_DATABASE_URL` only at a disposable database, for example:

```sh
docker run -d --rm --name hyde-e2e -e POSTGRES_PASSWORD=pg -p 55432:5432 postgres:18-alpine
E2E_DATABASE_URL=postgresql://postgres:pg@localhost:55432/postgres pnpm test:e2e
```

`E2E_PRISMA_VERSIONS` (default `6.19.3,7.10.0`) narrows the Prisma versions; `E2E_TARBALL` points `node --test test/e2e/*.test.mjs` at an existing `.tgz` instead of the one `pnpm test:e2e` packs.

Releases: every user-facing change adds a changeset (`pnpm changeset`). Changesets opens a version pull request on `main`. After it merges, a maintainer pushes the tag `v<version>`, and GitHub Actions checks, builds and publishes that tag with provenance; branch and pull-request CI never publish. [RELEASING.md](RELEASING.md) gives the steps. <!-- D63, D62 -->

## Security

See [SECURITY.md](SECURITY.md) for how to report a vulnerability. <!-- D41 -->

## License

MIT

---

View on LEDGER.md, 2026-10-06
