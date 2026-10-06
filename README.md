# hyde-db

A Prisma generator that gives any reader, whether an AI tool or a person, read access to a Prisma-managed PostgreSQL database, limited to the columns your schema's annotations allow. <!-- Intent, D53, D3 -->

You mark fields `/// @hyde.visible` or `/// @hyde.hidden`. `prisma generate` then writes three files: <!-- D54 -->

| File | What it does |
|---|---|
| `redacted-views.sql` | Creates schema `redacted` with one view per model that holds only the visible columns, and a role `redacted_reader` that can `SELECT` from those views. A final check inside the same transaction aborts the script if the role holds any access the final check refuses; [what it guarantees](#what-it-guarantees-and-what-it-does-not) says what that covers. |
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
hyde-db: 2 views, 5 visible columns and 1 hidden column → prisma/redacted
```

Then commit `prisma/redacted/` and [deploy](#deploy): the steps before the first deploy, the three steps of every deploy, and the reader's login after the first one.

## Supported versions

- **Prisma:** the Prisma 6 and 7 CLIs; the end-to-end tests run Prisma 6.19.3 and 7.10.0. Prisma 8 has no generator step, so hyde-db cannot run there; whether to read Prisma 8's contract IR instead is an open question. <!-- D30, A19, A18, Q5 -->
- **PostgreSQL:** 14 to 18. The attack suite in the CI workflow runs on PostgreSQL 14 and 18, the oldest and newest of these majors. <!-- A11, D21, D38 -->
- **MySQL:** not in 1.0. MySQL 8.4 and 9.7 are planned for 1.1.0. Until then a datasource with `provider = "mysql"` (or any provider other than `postgresql`) fails `prisma generate` with `HYDE_UNSUPPORTED_PROVIDER`. <!-- D87, D94, D86 -->
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
| `provider` | required | exactly `"hyde-db"` | Prisma runs the provider as a command. Any extra word, such as `"hyde-db --help"`, reaches hyde-db as an argument: it exits with status 2, so `prisma generate` fails and writes no files. |
| `output` | `"./redacted"` | a directory | Where the three files go, relative to `schema.prisma`. |
| `strict` | `"true"` | `"true"`, `"false"` | `"true"`: every scalar and enum field needs `@hyde.visible` or `@hyde.hidden`, and `@hyde.default` is an error. |
| `default` | `"hidden"` | `"hidden"`, `"visible"` | Visibility of unannotated fields; takes effect only with `strict = "false"`. |
| `schema` | `"redacted"` | `[a-z_][a-z0-9_]*`, at most 63 characters | Schema that holds the views; the scripts drop and recreate it. |
| `role` | `"redacted_reader"` | `[a-z_][a-z0-9_]*`, at most 63 characters | Role that may read the views. |
| `sourceSchema` | `"public"` | `[a-z_][a-z0-9_]*`, at most 63 characters | Schema of models without `@@schema`. |
| `statementTimeout` | `"15s"` | digits with an optional `ms`, `s` or `min` (bare digits are milliseconds), at most 2147483647 ms | The reader role's default statement timeout; a zero value turns it off and warns. |

<!-- D66, D25, D59, A42 -->

- With an extra word in `provider`, the failure message is: <!-- D66 -->

  ```text
  hyde-db: Prisma passed arguments (--help); the generator block must read provider = "hyde-db" with nothing after it.
  ```

- Without `output`, Prisma 6 and 7 write to `./redacted` next to `schema.prisma`. hyde-db ignores the generator block's name. <!-- A42 -->
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

Deploying takes three parts: [before the first deploy](#before-the-first-deploy) once, [every deploy](#every-deploy), and [after the first deploy](#after-the-first-deploy) once.

### Before the first deploy

**1. On PostgreSQL 14 and older**, and on clusters upgraded from them, `PUBLIC` holds `CREATE` on schema `public`. The apply script refuses to finish while `redacted_reader` can create objects in any schema. So run this once, in the application's database (each database has its own schema `public`), as the owner of schema `public` or a superuser: <!-- A15, D24, A95 -->

```sql
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
```

On these versions schema `public` belongs to the bootstrap superuser. Run by any other role, the statement prints `WARNING:  no privileges could be revoked for "public"`, exits 0 and changes nothing, and the apply keeps refusing. On a managed service, use the provider's admin role. hyde-db has not verified which role owns `public` on any provider. <!-- A95, A33 -->

**2. Other databases in the cluster.** `redacted_reader` may, by default, connect to every other database in the same cluster, where none of these checks run. For each of them, revoke that. Roles that need such a database then need their own `GRANT CONNECT`: <!-- D15, A14 -->

```sql
REVOKE CONNECT ON DATABASE other_database FROM PUBLIC;
```

### Every deploy

**In CI**, regenerate and fail when the committed files are stale, so every pull request shows what the reader gains or loses:

```sh
npx prisma generate
git diff --exit-code prisma/redacted
```

**Against the database**, run three steps in this order: drop the views, migrate, apply. A migration cannot alter a column that a view uses, so the views go first and come back after. Each block chains its lines with `&&`, so a refused step stops the rest. Paste each block whole. <!-- D43, D136 -->

With `psql`:

Note: psql does not read .env. Export DATABASE_URL in your shell first, as a plain libpq URL without Prisma-only parameters such as ?schema=public.

```sh
psql "${DATABASE_URL:?export DATABASE_URL first}" -v ON_ERROR_STOP=1 -f prisma/redacted/redacted-views-drop.sql &&
npx prisma migrate deploy &&
psql "${DATABASE_URL:?export DATABASE_URL first}" -v ON_ERROR_STOP=1 -f prisma/redacted/redacted-views.sql
```

- This path needs `DATABASE_URL` to be a plain libpq URL. If the database URL Prisma uses carries parameters such as `?schema=`, deploy with `prisma db execute` instead, as below. Do not strip the parameters for psql: `prisma migrate deploy` would then run against the stripped URL, which can point at another schema. <!-- D136 -->
- While `DATABASE_URL` is unset or empty, the shell stops each `psql` line with `DATABASE_URL: export DATABASE_URL first` and runs nothing. Without that guard, psql would connect to whatever database its defaults point at. <!-- D68, A49 -->
- Keep `-v ON_ERROR_STOP=1`. Without it, psql exits 0 even when a script is refused: the database stays unchanged, but the deploy does not notice. <!-- D58, A43 -->

With Prisma 7 (the database URL comes from `prisma.config.ts`):

```sh
npx prisma db execute --file prisma/redacted/redacted-views-drop.sql &&
npx prisma migrate deploy &&
npx prisma db execute --file prisma/redacted/redacted-views.sql
```

With Prisma 6 (the database URL comes from the datasource's `url`):

```sh
npx prisma db execute --file prisma/redacted/redacted-views-drop.sql --schema prisma/schema.prisma &&
npx prisma migrate deploy &&
npx prisma db execute --file prisma/redacted/redacted-views.sql --schema prisma/schema.prisma
```

<!-- D43, A30, D136 -->

The paths assume `prisma/schema.prisma` and `output = "./redacted"`. Who may run the scripts is in [deploy permissions](#deploy-permissions).

### After the first deploy

**1. Let the reader log in.** The apply script creates `redacted_reader` without login. Open an interactive psql session: <!-- D66, D68 -->

```sh
psql "${DATABASE_URL:?export DATABASE_URL first}"
```

In it, run `\password redacted_reader` first. It prompts for the password, so the password lands neither in your shell history nor in `ps` output, and psql sends it hashed. Then allow the login with `ALTER ROLE redacted_reader LOGIN;`. Setting the password first means the role never accepts logins without one.

Without an interactive session, export `READER_PASSWORD` from your secret store (never commit it) and run the following. The password must not contain a single quote. Its cost: the expanded password is part of psql's command line, so it shows in `ps` output while psql runs. A server that logs DDL statements (`log_statement` set to `ddl` or `all`) records it. A password typed into the export lands in your shell history.

```sh
psql "${DATABASE_URL:?export DATABASE_URL first}" -c "ALTER ROLE redacted_reader LOGIN PASSWORD '${READER_PASSWORD:?set READER_PASSWORD first}'"
```

The shell runs nothing while `READER_PASSWORD` or `DATABASE_URL` is unset or empty. Later deploys keep the login and the password. <!-- A41 -->

**2. Connect the reader** (an AI tool, a PostgreSQL MCP server or a person's SQL client) as `redacted_reader`, preferably to a read replica, and give it `redacted-schema.md`. The role's `search_path` is `redacted`, so unqualified view names work.

### Transactions, timeouts and the schema marker

- Each script is one transaction. A refused drop or apply changes nothing, under any client. <!-- D58 -->
- If your own code runs the scripts over a pooled connection, send `ROLLBACK` after an error, before the connection is reused. <!-- A43 -->
- Both scripts set `SET LOCAL client_min_messages = warning` and `SET LOCAL lock_timeout = '60s'`, and the apply script also sets `SET LOCAL jit = off`. These settings end with the script's transaction, so none stays with the connection. <!-- D110, D129, A84, A93, D131 -->
- A reader that holds a transaction open on a view makes a deploy fail after 60 seconds with `canceling statement due to lock timeout`, and the deploy rolls back. End the reader's session or transaction, then deploy again. <!-- D110, D93, A72 -->
- The scripts drop schema `redacted` only when its comment is the hyde-db marker: `Generated by hyde-db`, alone or followed by `.` and more text. Any other schema of that name stops them; see row 0 of [what the apply script refuses](#what-the-apply-script-refuses). <!-- D11, D58 -->

### Deploy permissions

The scripts run as a superuser, or as a non-superuser with `CREATEROLE`, the option where you have no superuser, for example on a managed service. The deploy user must be able to create schemas in the database and to read the source tables, because the views run with their owner's privileges. On a first deploy it creates `redacted_reader`. <!-- D49, A31, A33 -->

- hyde-db never revokes anything on source tables. A grant to `redacted_reader` (or to `PUBLIC`) on a source table is refused by the final check, with the statement that removes it. So a deploy user that owns, or can read, only the tables the views use can deploy. <!-- D69, A50 -->
- The apply script never changes the reader's role attributes. It refuses a reader that has any of them, with the `ALTER ROLE` that removes them. <!-- D49 -->

A reader role that already exists as a superuser, or (PostgreSQL 16 and later) was created by another role, stops a non-superuser's apply at the first `ALTER ROLE "redacted_reader" SET …` line with a permission error. That happens before the final check, and nothing changes. An administrator fixes the role, then you deploy again: <!-- A39 -->

```sql
ALTER ROLE redacted_reader NOSUPERUSER;
GRANT redacted_reader TO <deploy-user> WITH ADMIN OPTION;
```

The first statement is for a superuser reader role and needs a superuser. The second, on PostgreSQL 16 and later, lets the deploy user manage a role it did not create; replace `<deploy-user>` with its name.

## What it guarantees and what it does not

The guarantee is the privilege setup, scoped to table data: `redacted_reader` can read no table data outside the generated views. The apply script proves that against the live database before it commits. It holds as of each successful apply: a grant made later is not prevented, and the next apply refuses it. <!-- D93, D1, D14, D132 -->

The role's read-only default and statement timeout are session defaults, not guarantees: `redacted_reader` can turn both off with `SET`. With read-only off it still cannot write to any table, because it holds no write privileges, but it can create temporary tables unless `TEMPORARY` on the database is revoked from `PUBLIC`, which affects every role. <!-- D14, A2, D50, A32 -->

| Not covered | Why | What to do |
|---|---|---|
| Catalog metadata | The reader can read the names of every schema, table and column, hidden columns included, view and function definitions, and row counts from the statistics. | Do not put secrets in names, comments or definitions. |
| Large objects the reader owns, including ones an administrator transfers to it | After `SET`, the reader can create large objects through `PUBLIC`'s default `EXECUTE` on `lo_create`, `lo_creat` and `lo_from_bytea`, and owns them. | Optionally run `REVOKE EXECUTE ON FUNCTION lo_create(oid), lo_creat(integer), lo_from_bytea(oid, bytea) FROM PUBLIC;` in the application's database, which affects every role. Never transfer a large object to the reader. |
| Data an administrator publishes through channels the database cannot attribute | A trigger that sends row data with `NOTIFY` reaches any role that runs `LISTEN`, which needs no privilege. | Do not publish row data through `NOTIFY` in a database the reader can connect to. |
| A server-level `lo_compat_privileges = on` hidden by a deployer-scoped `off` | When the deploy user's own role setting or connection options set it `off`, the apply session cannot see that the server has it `on` for the reader. | Do not set `lo_compat_privileges` for the deploy user or in its connection options. |
| Rows | Every row of a visible model is visible. | Expose only models whose every row the reader may see; `@hyde.exclude` the others. |
| Content of visible columns | hyde-db judges names, not contents. A free-text column such as `description` can contain personal data. | Mark such a column `@hyde.hidden` unless you are sure. |
| Load | The timeout limits single statements, and the reader can lift it. | Connect the reader to a read replica. |
| Other databases in the cluster | The checks see one database. | Run the `REVOKE CONNECT` step [before the first deploy](#before-the-first-deploy). |

<!-- D93, A47, A48, A64, A66, A70, A71, D34, D14, D15 -->

## What the apply script refuses

The apply script aborts at the first of these checks that fails, in this order, and the whole transaction rolls back, so nothing changes. Row 0 runs before the old views are dropped. Rows 1 to 13 are the final check, which runs after the new views and grants. <!-- D1, D11, D13, D24, D49, D76, D80, D81, D82, D91, D108, D109, D111 -->

Every error starts with `hyde-db: `. The third column is the text that follows, up to the list of objects. Every final-check error ends with `Fix: ` and the statements to paste; the examples use made-up object names. Before pasting a fix, check who must run it: [running fixes without a superuser](#running-fixes-without-a-superuser).

| # | Refused when | Error after `hyde-db: ` | Printed fix |
|---|---|---|---|
| 0 | schema `redacted` exists and its comment is not the hyde-db marker | `schema redacted exists but was not created by hyde-db (its comment lacks the "Generated by hyde-db" marker)` | none: rename or drop that schema yourself, or set `schema` to an unused name |
| 1 | `redacted_reader` has `SUPERUSER`, `CREATEDB`, `CREATEROLE`, `REPLICATION` or `BYPASSRLS` | `role redacted_reader has attributes it must not have:` | `ALTER ROLE redacted_reader NOCREATEROLE NOBYPASSRLS;`, naming every attribute it has |
| 2 | it owns any object in this database other than its own temporary objects and large objects, or owns any database | `role redacted_reader owns objects it must not own:` | `REASSIGN OWNED BY redacted_reader TO CURRENT_USER; -- run as an administrator` |
| 3 | it is a member of another role, such as `pg_read_all_data` | `role redacted_reader must not be a member of other roles:` | `REVOKE pg_read_all_data FROM redacted_reader GRANTED BY admin CASCADE;`, one per membership; `GRANTED BY` only on PostgreSQL 16 and later |
| 4 | it can create schemas in this database, directly or through `PUBLIC` | `role redacted_reader can create schemas in database` | `REVOKE CREATE ON DATABASE app FROM PUBLIC, redacted_reader CASCADE;` |
| 5 | it or `PUBLIC` holds a privilege beyond the initial ones on a schema, relation, column or function in `pg_catalog`, `information_schema` or `pg_toast` | `role redacted_reader has privileges on system catalog objects beyond their initial privileges:` | `REVOKE SELECT ON TABLE pg_catalog.pg_statistic FROM PUBLIC CASCADE;`, or the `ROUTINE`, `SCHEMA` or column form such as `SELECT (rolpassword)` |
| 6 | it holds any privilege on a table, partitioned table, view, materialized view or foreign table outside `redacted`: `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER` or any column privilege, through `PUBLIC` or directly; source tables included | `role redacted_reader can read relations outside schema redacted:` | `REVOKE ALL ON public.users FROM PUBLIC, redacted_reader CASCADE;` |
| 7 | it can use a foreign server | `role redacted_reader can use foreign servers:` | `REVOKE USAGE ON FOREIGN SERVER loop FROM PUBLIC CASCADE;` |
| 8 | it can execute a `SECURITY DEFINER` function in a non-system schema it can use | `role redacted_reader can execute SECURITY DEFINER functions:` | `REVOKE EXECUTE ON ROUTINE public.peek(n integer) FROM PUBLIC CASCADE;` |
| 9 | it can use a sequence (`SELECT`, `USAGE`, `UPDATE`, or a column grant); temporary sequences excepted, so its own cannot block a deploy | `role redacted_reader can read sequences:` | `REVOKE ALL ON SEQUENCE public.users_id_seq FROM PUBLIC CASCADE;` |
| 10 | another role's default privileges grant it anything, or grant `PUBLIC` privileges on tables, sequences, schemas or (PostgreSQL 18) large objects; its own default privileges excepted | `role redacted_reader gets privileges on objects created later (default privileges):` | `ALTER DEFAULT PRIVILEGES FOR ROLE admin IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;` |
| 11 | it can create objects in any schema, including another session's `pg_temp_N`; the applying session's own temporary schema excepted | `role redacted_reader can create objects in schemas:` | `REVOKE CREATE ON SCHEMA public FROM PUBLIC CASCADE;` |
| 12 | `lo_compat_privileges` is on for its sessions: in the server configuration file or on the server command line, for the database, for its role, for all roles, or for its role in this database | `lo_compat_privileges is on, which turns off privilege checks on large objects for role redacted_reader:` | depends on where it is set; see [large-object settings](#large-object-settings) |
| 13 | it or `PUBLIC` has an ACL entry on a large object it does not own | `role redacted_reader can read large objects it does not own:` | `REVOKE ALL ON LARGE OBJECT 16401 FROM PUBLIC CASCADE;` |

- On PostgreSQL 14 and older, `PUBLIC` holds `CREATE` on schema `public` by default, and row 11 refuses it; the step [before the first deploy](#before-the-first-deploy) removes it. <!-- A15, D24 -->
- A `CREATE` grant on another session's temporary schema outlives that session, because PostgreSQL reuses the schema. Row 11 refuses it; the printed `REVOKE`, run by a superuser, removes it. <!-- A45, D24, A95 -->
- The check reports one kind of problem per run. After pasting a fix, run the apply script again; repeat until it passes.

### How a printed fix is built

- A fix of one statement is printed bare. A fix of several statements is printed as one transaction, `BEGIN; … COMMIT;`, so it applies completely or not at all. <!-- D108, A82 -->
- A fix names whoever holds the privilege: `PUBLIC`, `redacted_reader`, or both. It names the reader only when the reader holds a grant or owns the object, so a fix also works after a failed first deploy rolled back the creation of the role. <!-- D108, A81 -->
- Grants made by the object's owner are revoked in one statement with `CASCADE`, which also removes what the reader passed on from them in the same ACL. <!-- D108, A54 -->
- A grant made by any other role, a third-party grantor, is revoked as that grantor: `SET ROLE <grantor>; REVOKE … CASCADE; RESET ROLE;`. Each grantor revokes exactly the privileges it granted, never `ALL`. <!-- D108, D127, A56, A87 -->
- Column privileges the reader passed on to others are revoked as the reader first, before its own grant goes, for example `SET ROLE redacted_reader; REVOKE SELECT (secret) ON public.api_keys FROM PUBLIC CASCADE; RESET ROLE;`. <!-- D108, A69 -->
- When a grantor no longer holds the grant option behind something it passed on, the fix lends it that exact option for its revoke and takes it back afterwards: `GRANT … WITH GRANT OPTION;` before, and `REVOKE GRANT OPTION FOR … CASCADE;` or `REVOKE … CASCADE;` after. The option comes from a role the grantor belongs to that still holds it and is not a superuser, run as that role with `SET ROLE`, or else from the owner. A superuser never lends, because its `GRANT` and `REVOKE` act as the owner. <!-- D127, A90, A91, D130, A92 -->
- A fix that contains `SET ROLE` ends with `-- run as a superuser`, and so does every fix for row 12. The fix for row 2 ends with `-- run as an administrator`. Both are SQL comments, so they paste harmlessly. <!-- D108, D109 -->
- A fix that revokes as an object's owner ends with `-- run as <owner> or a superuser`, naming the owner, when the apply ran as a role that is not that owner, not a member of the owner role and not a superuser. On PostgreSQL 14 and older that owner is the bootstrap superuser for schema `public`; on every version it is for catalog objects and `pg_temp_N` schemas. A fix that revokes as several owners, not all of which that role acts as, ends with `-- run as a superuser`. Run by any other role, such a `REVOKE` changes nothing; see [running fixes without a superuser](#running-fixes-without-a-superuser). <!-- D134, A95 -->
- The `ALTER SYSTEM` fix of row 12 is printed without `BEGIN; … COMMIT;`, because PostgreSQL refuses `ALTER SYSTEM` inside a transaction. <!-- D109 -->

A fix as an apply prints it, after `Fix: ` (one line):

```text
BEGIN; SET ROLE redacted_reader; REVOKE SELECT (secret) ON public.api_keys FROM PUBLIC CASCADE; RESET ROLE; REVOKE ALL ON public.api_keys FROM redacted_reader CASCADE; COMMIT; -- run as a superuser
```

### What a pasted fix changes

A pasted fix removes the grants that give `redacted_reader` or `PUBLIC` the refused access, and leaves every other grant exactly as it was, with the exceptions below. The integration tests paste each printed fix and re-apply; the fix tests also compare ACL entries before and after the paste. <!-- D135 -->

- **The reader's own pass-ons.** Grants that `redacted_reader` itself passed on to other roles go with it. <!-- D135 -->
- **Orphaned pass-ons.** When a grantor no longer holds the grant option behind column grants it passed on, the fix that revokes them also removes the same orphaned grants that grantor made to other roles. Such grants are never backed by a grant option. <!-- D125 -->
- **Owner-lent options.** When only the owner can lend the grantor the option, a grant that the grantor passed on from its own owner-granted column option can cascade away with the fix. The fix grants the grantor's own column grants back, but not what it passed on from them. <!-- D130, A92 -->

### Large-object settings

Row 12's fix depends on where `lo_compat_privileges` is on. Every one ends with `-- run as a superuser`; several sources together print one `BEGIN; … COMMIT;`. <!-- D109, D123, A61, A70, A81, A89 -->

| Where it is on | Printed fix |
|---|---|
| server configuration file | `ALTER SYSTEM SET lo_compat_privileges = off; SELECT pg_reload_conf();` (no transaction) |
| server command line (`postgres -c …`) | SQL cannot change it, so the fix turns it off for the reader's role: `ALTER ROLE redacted_reader SET lo_compat_privileges = off;` |
| server command line, on a first deploy | The failed apply rolled back the role it created, so the fix creates it first: `BEGIN; CREATE ROLE redacted_reader NOLOGIN; ALTER ROLE redacted_reader SET lo_compat_privileges = off; COMMIT;`. When the deploy user is not a superuser, the fix also gives it `ADMIN OPTION` on the role, `GRANT redacted_reader TO admin WITH ADMIN OPTION, INHERIT FALSE, SET FALSE;` (without `, INHERIT FALSE, SET FALSE` before PostgreSQL 16), so its next apply can set the role's settings. |
| the database | `ALTER DATABASE app RESET lo_compat_privileges;` |
| the reader's role, all roles, the reader's role in this database | `ALTER ROLE redacted_reader RESET lo_compat_privileges;`, `ALTER ROLE ALL RESET lo_compat_privileges;`, `ALTER ROLE redacted_reader IN DATABASE app RESET lo_compat_privileges;` |

### Running fixes without a superuser

A printed `REVOKE` outside `SET ROLE` removes grants that the object's owner made, so it works only when the owner or a superuser runs it. PostgreSQL revokes only grants made by the role that runs the statement. Run by a role that neither owns the object nor holds the grant option, the statement prints a warning such as `WARNING:  no privileges could be revoked for "public"`, psql exits 0, and nothing changes. Run by any other role that is not the owner, it changes nothing either, with or without that warning. Either way, the next apply refuses the same object again: run it as the owner or a superuser. <!-- A95 -->

Where the deploy user is a non-superuser with `CREATEROLE`, for example on a managed service without superuser access, this is what it can run, as probed: <!-- D125, A94, A39, A82, A95 -->

| Fix | Run by a non-superuser deploy user with `CREATEROLE` |
|---|---|
| A `REVOKE` without `SET ROLE` | Works when the deploy user owns the object: it revokes as the owner. Otherwise it exits 0 and changes nothing (see above), and the fix ends with `-- run as <owner> or a superuser`. On PostgreSQL 14 and older, schema `public` belongs to the bootstrap superuser; catalog objects and `pg_temp_N` schemas need their owner or a superuser too. |
| Contains `SET ROLE <role>` (`-- run as a superuser`) | Fails with `permission denied to set role`. Works after `GRANT <role> TO CURRENT_USER;` for each role the fix names after `SET ROLE`; afterwards run `REVOKE <role> FROM CURRENT_USER;`. On PostgreSQL 16 and later that grant needs `ADMIN OPTION` on the role, which the deploy user holds on roles it created, `redacted_reader` included. For a role someone else created, the grant fails with `Only roles with the ADMIN option on role … may grant this role`, and only a role with that option can run the fix. On 14, `CREATEROLE` is enough for any role that is not a superuser. |
| `REASSIGN OWNED BY redacted_reader TO CURRENT_USER;` (row 2) | Fails with `permission denied to reassign objects`. Works after `GRANT redacted_reader TO CURRENT_USER;`; afterwards run `REVOKE redacted_reader FROM CURRENT_USER;`. |
| `ALTER ROLE redacted_reader NO…;` (row 1) | `NOCREATEROLE` works. `NOCREATEDB` works on 14, and on 16 and later only when the deploy user has `CREATEDB` itself. `NOREPLICATION` and `NOBYPASSRLS` need a superuser on 14, and on 16 and later a role that has that attribute itself. `NOSUPERUSER` needs a superuser. |
| Row 12, large-object settings | Fails on 14, 16 and 18, for example with `permission denied to set parameter "lo_compat_privileges"`: a superuser must run it. Where nobody is a superuser, change the setting through the provider's mechanism for server parameters, such as a parameter group or database flags. hyde-db has not verified this for any provider. |

For example, for a fix that runs `SET ROLE redacted_reader`, do this in one psql session as the deploy user:

1. Run `GRANT redacted_reader TO CURRENT_USER;`.
2. Paste the printed fix.
3. Run `REVOKE redacted_reader FROM CURRENT_USER;`.
4. Run the apply script again.

The probe used PostgreSQL 14.24, 16.14 and 18.6 in Docker, with a deploy user that has `LOGIN CREATEROLE CREATEDB`, is not a superuser, owns the database, its schema `public` and the source tables, and created `redacted_reader` by deploying. It did not run on any provider's service, did not test provider-specific admin roles, and did not test the fixes of rows 3, 5 and 10 (memberships, catalog privileges and default privileges).

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
| `HYDE_UNSUPPORTED_PROVIDER` | error | The datasource provider is not `postgresql`, for example `mysql`. | Use hyde-db 1.0 only with PostgreSQL. |
| `HYDE_NO_OUTPUT` | error | Prisma passed no output directory. | Set `output = "./redacted"`. |
| `HYDE_RELATION_ANNOTATED` | warning | A relation field carries `@hyde.visible` or `@hyde.hidden`, which has no effect. | Annotate the scalar foreign-key fields instead. |
| `HYDE_SENSITIVE_EXPLICIT` | warning | A sensitive-looking name is explicitly `@hyde.visible`. | Make sure the column is safe to show. |
| `HYDE_TIMEOUT_DISABLED` | warning | `statementTimeout` is zero, which turns the reader role's statement timeout off. | Use a positive value such as `"15s"`, or remove the key. |
| `HYDE_LEGACY_ANNOTATION` | warning | A doc comment holds an `@ai.*` annotation from prisma-ai-views, which has no effect. | Rename it to `@hyde.*`. |

<!-- D51, D25, D26, D57, D59, D60, D87 -->

## Command line

Run outside `prisma generate`, the `hyde-db` binary prints its usage: what it does, the generator block with every default, the annotations, the output files and the deploy commands. <!-- D66, D55 -->

```sh
npx hyde-db --help
```

- `help` and `-h` do the same; `--version`, `-v` and `version` print the version. <!-- D66 -->
- Outside Prisma the binary never reads standard input. An unknown argument exits with status 2 and `hyde-db: unknown argument "--bogus"`. <!-- D66 -->
- Prisma starts the binary with `PRISMA_GENERATOR_INVOCATION=true`. With no argument it then speaks the generator protocol; with any argument it exits with status 2 and the provider message shown under [generator block](#generator-block). <!-- D66, A34 -->

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
4. Do the steps [before the first deploy](#before-the-first-deploy), deploy, then the steps [after the first deploy](#after-the-first-deploy) for `redacted_reader`.
5. The old schema `ai` and role `ai_reader` stay untouched: the scripts never drop a schema without the hyde-db marker, so even with `schema = "ai"` they refuse to touch it. Until you drop the old schema, its views still block migrations that change the columns they use. Once the new views work, run as an admin: <!-- D11, A44 -->

```sql
DROP SCHEMA ai CASCADE;
DROP ROLE ai_reader;
```

## Programmatic use

The package exports `build`, `analyze` and their types, nothing else. Both take the DMMF datamodel exactly as Prisma passes it to a generator (`options.dmmf.datamodel`) plus the generator config, and never throw on config input: every config problem becomes a diagnostic. <!-- D9, D47 -->

```ts
import { analyze, build } from 'hyde-db'

const { config, views, diagnostics, counts, files } = build(datamodel, { strict: 'true' })
```

- `analyze` returns `config`, `views`, `diagnostics` and `counts` (visible and hidden columns) without rendering files. <!-- D48 -->
- `build` adds `files`, the three file contents keyed by file name, or `null` when any diagnostic is an error.
- `config` is a `ResolvedConfig`, a union discriminated on `dialect`. In 1.0 its only member is `PostgresqlConfig`, with `dialect: 'postgresql'`. <!-- D112 -->
- `View.sourceSchema` is `string | null`. It is never `null` on PostgreSQL; `null` is for databases without schemas. <!-- D112 -->
- Union types in the public API may gain members in minor releases. Switch on `dialect` and handle `null` instead of assuming one shape. <!-- D112 -->
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

Releases: every user-facing change adds a changeset (`pnpm changeset`). Changesets opens a version pull request on `main`. After it merges, a maintainer pushes the tag `v<version>`, and the release workflow on GitHub Actions checks, builds and publishes that tag with provenance. It publishes only a commit on which CI passed; branch and pull-request CI never publish. [RELEASING.md](RELEASING.md) gives the steps. <!-- D63, D62, D126 -->

## Security

Report vulnerabilities privately; [SECURITY.md](SECURITY.md) says how, and repeats the guarantee, its limits and a hardening checklist. <!-- D41 -->

## License

MIT

---

View on LEDGER.md, 2026-10-06
