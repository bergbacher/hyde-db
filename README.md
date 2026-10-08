# hyde-db

A Prisma generator that gives any reader, whether an AI tool or a person, read access to a Prisma-managed PostgreSQL or MySQL database, limited to the columns your schema's annotations allow. The sections below describe PostgreSQL; [MySQL](#mysql) has its own section. <!-- Intent, D53, D170, D86, D107 -->

You mark fields `/// @hyde.visible` or `/// @hyde.hidden`. `prisma generate` then writes three files: <!-- D54 -->

| File | What it does |
|---|---|
| `redacted-views.sql` | Creates schema `redacted` with one view per model that holds only the visible columns, and a role `redacted_reader` that can `SELECT` from those views. A final check inside the same transaction aborts the script if the role holds any access the final check refuses; [what it guarantees](#what-it-guarantees-and-what-it-does-not) says what that covers. |
| `redacted-views-drop.sql` | Drops schema `redacted`, so migrations can change the columns the views use. |
| `redacted-schema.md` | Tables, columns and joins of the views, for whoever queries them. |

Hidden columns do not exist in the views, so every query that names one, such as `left(email, 1)` or `WHERE email LIKE …`, fails because the column does not exist. The database's privileges enforce this; no result filter is involved. <!-- D1 -->

## Quick start

Install the package:

```sh
npm install --save-dev hyde-db
```

Add a generator block to `prisma/schema.prisma`: <!-- D170, D54 -->

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

If it cannot write a file, generate fails with `hyde-db: could not write <path>: <reason>`. Each file is written under a temporary name in a staging directory inside the output directory and renamed into place, so each file is either old or new, but the three files are not replaced as one unit: after a failure, some may be new and some old, so run `prisma generate` again. Removing the staging directory is best-effort and never replaces an earlier error. <!-- D147 -->

Then commit `prisma/redacted/` and [deploy](#deploy): the steps before the first deploy, the three steps of every deploy, and the reader's login after the first one.

## Supported versions

- **Prisma:** the Prisma 6 and 7 CLIs; the end-to-end tests run Prisma 6.19.3 and 7.10.0. Prisma 8 has no generator step, so hyde-db cannot run there; whether to read Prisma 8's contract IR instead is an open question. <!-- D30, A19, A18, Q5 -->
- **PostgreSQL:** 14 to 18. The attack suite in the CI workflow runs on PostgreSQL 14 and 18, the oldest and newest of these majors. <!-- A11, D21, D38 -->
- **MySQL:** 8.4 and 9.7. The attack suite runs on both. MySQL 8.0, innovation releases (26.x) and MariaDB are out of scope. [MySQL](#mysql) has the details. <!-- D94, A73, D148 -->
- **Datasource providers:** `postgresql` and `mysql`. A datasource with any other provider fails `prisma generate` with `HYDE_UNSUPPORTED_PROVIDER`: the provider is other than `postgresql` or `mysql`. <!-- D159, D107 -->
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
| `role` | `"redacted_reader"` | `[a-z_][a-z0-9_]*`, at most 63 characters | Role that may read the views. Roles belong to the whole cluster, not to one database: give each database, and each generator block, its own `role`. |
| `sourceSchema` | `"public"` | `[a-z_][a-z0-9_]*`, at most 63 characters | Schema of models without `@@schema`. hyde-db never reads the database URL: when the URL Prisma uses selects a schema with `?schema=<name>`, set `sourceSchema` to that name. |
| `statementTimeout` | `"15s"` | digits with an optional `ms`, `s` or `min` (bare digits are milliseconds), at most 2147483647 ms | The reader role's default statement timeout; a zero value turns it off and warns. |

<!-- D66, D25, D59, A42, D140, A99, D137 -->

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

Deploying takes three parts: [before the first deploy](#before-the-first-deploy) once, [every deploy](#every-deploy), and [after the first deploy](#after-the-first-deploy) once. These steps are for PostgreSQL; the [MySQL](#mysql) section has the MySQL deploy. <!-- D107 -->

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

A role belongs to the whole cluster, not to one database. With the default `role`, every database you deploy to in one cluster shares one `redacted_reader` and one password, and that reader reads the views of each of them. `REVOKE CONNECT` cannot separate them, because the shared role needs `CONNECT` on each. So give each database, and each generator block, its own `role`. <!-- D140, A99 -->

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

**During development**, the views block `prisma migrate dev` and `prisma db push` the same way when they change a column a view uses: run the drop script before them and the apply script after.

### After the first deploy

**1. Let the reader log in.** The apply script creates `redacted_reader` without login. Open an interactive psql session: <!-- D66, D68 -->

```sh
psql "${DATABASE_URL:?export DATABASE_URL first}"
```

This step needs psql, so `DATABASE_URL` must be a libpq URL of the same database without Prisma parameters such as `?schema=`. If the URL Prisma uses carries them, export the URL without them for this step only, in a shell where you run no Prisma command. <!-- D137 -->

In it, run `\password redacted_reader` first. It prompts for the password, so the password lands neither in your shell history nor in `ps` output, and psql sends it hashed. Then allow the login with `ALTER ROLE redacted_reader LOGIN;`. Setting the password first means the role never accepts logins without one.

Without an interactive session, export `READER_PASSWORD` from your secret store (never commit it) and run the following. The password must not contain a single quote. Its cost: the expanded password is part of psql's command line, so it shows in `ps` output while psql runs. A server that logs DDL statements (`log_statement` set to `ddl` or `all`) records it. A password typed into the export lands in your shell history.

```sh
psql "${DATABASE_URL:?export DATABASE_URL first}" -c "ALTER ROLE redacted_reader LOGIN PASSWORD '${READER_PASSWORD:?set READER_PASSWORD first}'"
```

The shell runs nothing while `READER_PASSWORD` or `DATABASE_URL` is unset or empty. Later deploys keep the login and the password. <!-- A41 -->

**2. Connect the reader** (an AI tool, a PostgreSQL MCP server or a person's SQL client) as `redacted_reader`, preferably to a read replica, and give it `redacted-schema.md`. The role's `search_path` is `redacted`, so unqualified view names work. `redacted-schema.md` writes each name as SQL needs it: a name that is not all lower case or is a reserved word appears in double quotes, such as `"User"` for a model without `@@map`. A name in double quotes is case-sensitive and works only with its quotes. The type column shows Prisma type names, not SQL types. A view named like a `pg_catalog` relation, or like a temporary table the reader creates, is shadowed in unqualified queries: qualify it with the schema. <!-- D146, A98 -->

### Transactions, timeouts and the schema marker

- Each script is one transaction. A refused drop or apply changes nothing, under any client. <!-- D58 -->
- If your own code runs the scripts over a pooled connection, send `ROLLBACK` after an error, before the connection is reused. <!-- A43 -->
- Both scripts set `SET LOCAL client_min_messages = warning`, `SET LOCAL lock_timeout = '60s'` and `SET LOCAL jit = off`. These settings end with the script's transaction, so none stays with the connection. <!-- D110, D129, A84, A93, D131 -->
- A reader that holds a transaction open on a view makes a deploy fail after 60 seconds with `canceling statement due to lock timeout`, and the deploy rolls back. End the reader's session or transaction, then deploy again. <!-- D110, D93, A72 -->
- The scripts drop schema `redacted` only when its comment is the hyde-db marker: `Generated by hyde-db`, alone or followed by `.` and more text. Any other schema of that name stops them; see row 0 of [what the apply script refuses](#what-the-apply-script-refuses). <!-- D11, D58 -->
- Dropping schema `redacted` would also drop every object outside it that depends on its views, such as a view in another schema. While one exists, both scripts stop, name it, and change nothing; see row 1. Drop such objects before the deploy and create them again after it. Temporary objects, and objects that depend on a temporary object, are the exception, so a reader's own cannot block a deploy. Both go anyway when the session that created the temporary object ends. Until then, the drop removes the parts of them that depend on the views: a view or function goes, together with any permanent object that depends on it, and a temporary table loses only its column of a view's row type. <!-- D141, A97, D144 -->

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

The apply script aborts at the first of these checks that fails, in this order, and the whole transaction rolls back, so nothing changes. Rows 0 and 1 run before the old views are dropped, and the drop script runs them too. Rows 2 to 15 are the final check, which runs after the new views and grants. <!-- D1, D11, D13, D24, D49, D76, D80, D81, D82, D91, D108, D109, D111, D138, D141 -->

Every error starts with `hyde-db: `. The third column is the text that follows, up to the list of objects. Every final-check error ends with `Fix: ` and the statements to paste; the examples use made-up object names. Before pasting a fix, check who must run it: [running fixes without a superuser](#running-fixes-without-a-superuser).

| # | Refused when | Error after `hyde-db: ` | Printed fix |
|---|---|---|---|
| 0 | schema `redacted` exists and its comment is not the hyde-db marker | `schema redacted exists but was not created by hyde-db (its comment lacks the "Generated by hyde-db" marker)` | none: rename or drop that schema yourself, or set `schema` to an unused name |
| 1 | objects outside schema `redacted` depend on its views, such as a view, a function, a table column or a policy in another schema; temporary objects and objects that depend on a temporary object excepted, so a reader's own cannot block a deploy | `objects outside schema redacted depend on its views:` | none: drop them before the deploy, and create them again after it |
| 2 | `redacted_reader` has `SUPERUSER`, `CREATEDB`, `CREATEROLE`, `REPLICATION` or `BYPASSRLS` | `role redacted_reader has attributes it must not have:` | `ALTER ROLE redacted_reader NOCREATEROLE NOBYPASSRLS;`, naming every attribute it has |
| 3 | it owns any object in this database other than its own temporary objects and large objects, or owns any database | `role redacted_reader owns objects it must not own:` | `REASSIGN OWNED BY redacted_reader TO CURRENT_USER; -- run as an administrator` |
| 4 | it is a member of another role, such as `pg_read_all_data` | `role redacted_reader must not be a member of other roles:` | `REVOKE pg_read_all_data FROM redacted_reader GRANTED BY admin CASCADE;`, one per membership; `GRANTED BY` only on PostgreSQL 16 and later |
| 5 | it can create schemas in this database, directly or through `PUBLIC` | `role redacted_reader can create schemas in database` | `REVOKE CREATE ON DATABASE app FROM PUBLIC, redacted_reader CASCADE;` |
| 6 | it or `PUBLIC` holds a privilege beyond the initial ones on a schema, relation, column or function in `pg_catalog`, `information_schema` or `pg_toast` | `role redacted_reader has privileges on system catalog objects beyond their initial privileges:` | `REVOKE SELECT ON TABLE pg_catalog.pg_statistic FROM PUBLIC CASCADE;`, or the `ROUTINE`, `SCHEMA` or column form such as `SELECT (rolpassword)` |
| 7 | it holds any privilege on a table, partitioned table, view, materialized view or foreign table outside `redacted`: `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER` or any column privilege, through `PUBLIC` or directly; source tables included | `role redacted_reader can read relations outside schema redacted:` | `REVOKE ALL ON public.users FROM PUBLIC, redacted_reader CASCADE;` |
| 8 | it can use a foreign server | `role redacted_reader can use foreign servers:` | `REVOKE USAGE ON FOREIGN SERVER loop FROM PUBLIC CASCADE;` |
| 9 | it can execute a `SECURITY DEFINER` function in a non-system schema it can use | `role redacted_reader can execute SECURITY DEFINER functions:` | `REVOKE EXECUTE ON ROUTINE public.peek(n integer) FROM PUBLIC CASCADE;` |
| 10 | it can use a sequence (`SELECT`, `USAGE`, `UPDATE`, or a column grant); temporary sequences excepted, so its own cannot block a deploy | `role redacted_reader can read sequences:` | `REVOKE ALL ON SEQUENCE public.users_id_seq FROM PUBLIC CASCADE;` |
| 11 | another role's default privileges grant it anything, or grant `PUBLIC` privileges on tables, sequences, schemas or (PostgreSQL 18) large objects; its own default privileges excepted | `role redacted_reader gets privileges on objects created later (default privileges):` | `ALTER DEFAULT PRIVILEGES FOR ROLE admin IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;` |
| 12 | it can create objects in any schema, including another session's `pg_temp_N`; the applying session's own temporary schema excepted | `role redacted_reader can create objects in schemas:` | `REVOKE CREATE ON SCHEMA public FROM PUBLIC CASCADE;` |
| 13 | `lo_compat_privileges` is on for its sessions: in the server configuration file or on the server command line, for the database, for its role, for all roles, or for its role in this database | `lo_compat_privileges is on, which turns off privilege checks on large objects for role redacted_reader:` | depends on where it is set; see [large-object settings](#large-object-settings) |
| 14 | it or `PUBLIC` has an ACL entry on a large object it does not own | `role redacted_reader can read large objects it does not own:` | `REVOKE ALL ON LARGE OBJECT 16401 FROM PUBLIC CASCADE;` |
| 15 | it or `PUBLIC` holds `SET` or `ALTER SYSTEM` on a configuration parameter; PostgreSQL 15 and later, as PostgreSQL 14 has no parameter privileges | `role redacted_reader has privileges on configuration parameters:` | `REVOKE SET ON PARAMETER lo_compat_privileges FROM PUBLIC CASCADE; -- run as a superuser` |

- On PostgreSQL 14 and older, `PUBLIC` holds `CREATE` on schema `public` by default, and row 12 refuses it; the step [before the first deploy](#before-the-first-deploy) removes it. <!-- A15, D24 -->
- A `CREATE` grant on another session's temporary schema outlives that session, because PostgreSQL reuses the schema. Row 12 refuses it; the printed `REVOKE`, run by a superuser, removes it. <!-- A45, D24, A95 -->
- The check reports one kind of problem per run. After pasting a fix, run the apply script again; repeat until it passes.

### How a printed fix is built

- A fix of one statement is printed bare. A fix of several statements is printed as one transaction, `BEGIN; … COMMIT;`, so it applies completely or not at all. <!-- D108, A82 -->
- A fix names whoever holds the privilege: `PUBLIC`, `redacted_reader`, or both. It names the reader only when the reader holds a grant or owns the object, so a fix also works after a failed first deploy rolled back the creation of the role. <!-- D108, A81 -->
- Grants made by the object's owner are revoked in one statement with `CASCADE`, which also removes what the reader passed on from them in the same ACL. <!-- D108, A54 -->
- A grant made by any other role, a third-party grantor, is revoked as that grantor: `SET ROLE <grantor>; REVOKE … CASCADE; RESET ROLE;`. Each grantor revokes exactly the privileges it granted, never `ALL`. <!-- D108, D127, A56, A87 -->
- Column privileges the reader passed on to others are revoked as the reader first, before its own grant goes, for example `SET ROLE redacted_reader; REVOKE SELECT (secret) ON public.api_keys FROM PUBLIC CASCADE; RESET ROLE;`. <!-- D108, A69 -->
- When a grantor no longer holds the grant option behind something it passed on, the fix lends it that exact option for its revoke and takes it back afterwards: `GRANT … WITH GRANT OPTION;` before, and `REVOKE GRANT OPTION FOR … CASCADE;` or `REVOKE … CASCADE;` after. The option comes from a role the grantor belongs to that still holds it and is not a superuser, run as that role with `SET ROLE`, or else from the owner. A superuser never lends, because its `GRANT` and `REVOKE` act as the owner. <!-- D127, A90, A91, D130, A92 -->
- A fix that contains `SET ROLE` ends with `-- run as a superuser`, and so does every fix for rows 13 and 15. The fix for row 3 ends with `-- run as an administrator`. Both are SQL comments, so they paste harmlessly. <!-- D108, D109, D138 -->
- A fix that revokes as an object's owner ends with `-- run as <owner> or a superuser`, naming the owner, when the apply ran as a role that is not that owner, does not inherit the owner role's privileges, and is not a superuser. On PostgreSQL 14 and older that owner is the bootstrap superuser for schema `public`; on every version it is for catalog objects and `pg_temp_N` schemas. In a database created on PostgreSQL 15 or later, schema `public` belongs to `pg_database_owner`, a role nobody can log in as that stands for the database's owner, so its fix names the database's owner instead; a cluster upgraded from 14 keeps the bootstrap superuser as the owner. A fix that revokes as several owners, not all of which that role acts as, ends with `-- run as a superuser`. Run by any other role, such a `REVOKE` changes nothing; see [running fixes without a superuser](#running-fixes-without-a-superuser). <!-- D134, A95, A101 -->
- The `ALTER SYSTEM` fix of row 13 is printed without `BEGIN; … COMMIT;`, because PostgreSQL refuses `ALTER SYSTEM` inside a transaction. <!-- D109 -->

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

Row 13's fix depends on where `lo_compat_privileges` is on. Every one ends with `-- run as a superuser`; several sources together print one `BEGIN; … COMMIT;`. <!-- D109, D123, A61, A70, A81, A89 -->

| Where it is on | Printed fix |
|---|---|
| server configuration file | `ALTER SYSTEM SET lo_compat_privileges = off; SELECT pg_reload_conf();` (no transaction) |
| server command line (`postgres -c …`) | SQL cannot change it, so the fix turns it off for the reader's role: `ALTER ROLE redacted_reader SET lo_compat_privileges = off;` |
| server command line, on a first deploy | The failed apply rolled back the role it created, so the fix creates it first: `BEGIN; CREATE ROLE redacted_reader NOLOGIN; ALTER ROLE redacted_reader SET lo_compat_privileges = off; COMMIT;`. When the deploy user is not a superuser, the fix also gives it `ADMIN OPTION` on the role, `GRANT redacted_reader TO admin WITH ADMIN OPTION, INHERIT FALSE, SET FALSE;` (without `, INHERIT FALSE, SET FALSE` before PostgreSQL 16), so its next apply can set the role's settings. |
| the database | `ALTER DATABASE app RESET lo_compat_privileges;` |
| the reader's role, all roles, the reader's role in this database | `ALTER ROLE redacted_reader RESET lo_compat_privileges;`, `ALTER ROLE ALL RESET lo_compat_privileges;`, `ALTER ROLE redacted_reader IN DATABASE app RESET lo_compat_privileges;` |

### Running fixes without a superuser

A printed `REVOKE` outside `SET ROLE` removes grants that the object's owner made, so it works only when the owner, a role that inherits the owner role's privileges, or a superuser runs it. Membership alone is not enough: on PostgreSQL 16 and later, a `CREATEROLE` deploy user is by default a member of each role it creates without inheriting its privileges. PostgreSQL runs a `GRANT` or `REVOKE` by a role that inherits the owner role's privileges, or by a superuser, as the owner; any other role revokes only grants it made itself. Run by a role that neither owns the object nor holds the grant option, the statement prints a warning such as `WARNING:  no privileges could be revoked for "public"`, psql exits 0, and nothing changes. Run by any other role that holds the grant option, it changes nothing either, and prints no warning. Either way, the next apply refuses the same object again: run it as the owner, a role that inherits the owner role's privileges, or a superuser. A deploy user that is none of these can run `GRANT <owner> TO CURRENT_USER;` first, which makes it inherit them, where it may grant that role (see the `SET ROLE` row below), and `REVOKE <owner> FROM CURRENT_USER;` after. <!-- A95, A100, A101, D134, D144 -->

Where the deploy user is a non-superuser with `CREATEROLE`, for example on a managed service without superuser access, this is what it can run, as probed: <!-- D125, A94, A39, A82, A95 -->

| Fix | Run by a non-superuser deploy user with `CREATEROLE` |
|---|---|
| A `REVOKE` without `SET ROLE` | Works when the deploy user owns the object or inherits the owner role's privileges: it revokes as the owner. Otherwise it exits 0 and changes nothing (see above), and the fix ends with `-- run as <owner> or a superuser`, or with `-- run as a superuser` when it revokes as several owners. On PostgreSQL 14 and older, schema `public` belongs to the bootstrap superuser; catalog objects and `pg_temp_N` schemas need their owner or a superuser too. |
| Contains `SET ROLE <role>` (`-- run as a superuser`) | Fails with `permission denied to set role`. Works after `GRANT <role> TO CURRENT_USER;` for each role the fix names after `SET ROLE`; afterwards run `REVOKE <role> FROM CURRENT_USER;`. On PostgreSQL 16 and later that grant needs `ADMIN OPTION` on the role, which the deploy user holds on roles it created, `redacted_reader` included. For a role someone else created, the grant fails with `Only roles with the ADMIN option on role … may grant this role`, and only a role with that option can run the fix. On 14, `CREATEROLE` is enough for any role that is not a superuser. |
| `REASSIGN OWNED BY redacted_reader TO CURRENT_USER;` (row 3) | Fails with `permission denied to reassign objects`. Works after `GRANT redacted_reader TO CURRENT_USER;`; afterwards run `REVOKE redacted_reader FROM CURRENT_USER;`. |
| `ALTER ROLE redacted_reader NO…;` (row 2) | `NOCREATEROLE` works. `NOCREATEDB` works on 14, and on 16 and later only when the deploy user has `CREATEDB` itself. `NOREPLICATION` and `NOBYPASSRLS` need a superuser on 14, and on 16 and later a role that has that attribute itself. `NOSUPERUSER` needs a superuser. |
| Row 13, large-object settings | Fails on 14, 16 and 18, for example with `permission denied to set parameter "lo_compat_privileges"`: a superuser must run it. Where nobody is a superuser, change the setting through the provider's mechanism for server parameters, such as a parameter group or database flags. hyde-db has not verified this for any provider. |

For example, for a fix that runs `SET ROLE redacted_reader`, do this in one psql session as the deploy user:

1. Run `GRANT redacted_reader TO CURRENT_USER;`.
2. Paste the printed fix.
3. Run `REVOKE redacted_reader FROM CURRENT_USER;`.
4. Run the apply script again.

The probe used PostgreSQL 14.24, 16.14 and 18.6 in Docker, with a deploy user that has `LOGIN CREATEROLE CREATEDB`, is not a superuser, owns the database, its schema `public` and the source tables, and created `redacted_reader` by deploying. It did not run on any provider's service, did not test provider-specific admin roles, and did not test the fixes of rows 4, 6 and 11 (memberships, catalog privileges and default privileges).

## MySQL

hyde-db writes the same three files for MySQL as for PostgreSQL, from the same annotations, and the deploy runs the same three steps: drop, migrate, apply. The scripts run with the `mysql` client or with `prisma db execute`; nothing is installed at runtime. MySQL cannot roll back DDL or grants, so the apply script does not rely on a transaction: it checks first, builds the views, grants last, checks again, and revokes and aborts when that check fails. <!-- D86, D95, A74 -->

The generator block is the one above, with `provider = "hyde-db"`: the datasource `provider`, `postgresql` or `mysql`, selects the dialect, and `prisma generate` passes it on. <!-- D107, A80 -->

| File | What it does on MySQL |
|---|---|
| `redacted-views.sql` | Recreates database `redacted` with a marker view (a second column `source` records the source database) and one view per model that holds only the visible columns, creates the account `redacted_reader` locked and without a password when it is missing, and grants it `SELECT` on exactly those views. |
| `redacted-views-drop.sql` | Revokes the reader's grants and drops database `redacted`, so migrations can change the columns the views use. |
| `redacted-schema.md` | The views' tables, columns and joins, with names written in backticks. |

<!-- D95, D100, D115, D117, D116, D165 -->

### Config on MySQL

A MySQL generator block, every key at its default:

```prisma
generator redacted {
  provider   = "hyde-db"
  output     = "./redacted"
  strict     = "true"
  default    = "hidden"
  schema     = "redacted"
  role       = "redacted_reader"
  readerHost = "%"
}
```

| Key | Default | Accepts | Effect |
|---|---|---|---|
| `schema` | `"redacted"` | `[a-z_][a-z0-9_]*`, at most 64 characters | The views database; the scripts drop and recreate it. |
| `role` | `"redacted_reader"` | `[a-z_][a-z0-9_]*`, at most 32 characters | The user name of the reader account. |
| `readerHost` | `"%"` | `[A-Za-z0-9._%:/-]`, 1 to 60 characters | The host part of the reader account, `'redacted_reader'@'%'` by default. |
| `default` | `"hidden"` | `"hidden"`, `"visible"` | As on PostgreSQL. |
| `strict` | `"true"` | `"true"`, `"false"` | As on PostgreSQL. |

<!-- D97, D25, D149 -->

- `role` names the reader account's user name, and `readerHost` its host. It is not a MySQL `ROLE`. <!-- D120 -->
- On one MySQL server, give each source database, and each generator block, its own `schema` and `role`: both belong to the whole server, not to one database. The marker view records its source database, and the apply and drop scripts refuse a views database whose marker names another source database, so a second source database that uses the same `schema` is refused, but a shared `role` is not detected and lets one reader read the views of both. <!-- D164, A105, D165, D140 -->
- The reader account must serve only as the hyde-db reader: every apply and drop first revokes all its privileges, and MySQL cannot roll that back. Do not point `role` and `readerHost` at an account that has another job. <!-- D164, D119, A74 -->
- `hyde_db_marker` and `hyde_db_abort` are reserved table names: a model mapped to either fails `prisma generate` with `HYDE_VIEW_NAME_COLLISION`, because the first is the marker view in the views database and the second the script's temporary abort table, which would shadow the source table. <!-- D157, D167 -->
- `sourceSchema` and `statementTimeout` do not exist on MySQL. Setting either fails `prisma generate` with `HYDE_CONFIG_KEY_UNSUPPORTED` and a hint: MySQL has no schemas, because the views read from the connection's database, and no per-account statement timeout. <!-- D97, D156, A78, A80 -->
- A server with a non-empty `mandatory_roles` is unsupported: the apply script refuses it, because every login would inherit those roles. The printed fix is `SET PERSIST mandatory_roles = '';`. <!-- D120, D153 -->
- The source database is not a key: it is the connection's default database, which the apply script checks when it runs. It must differ from `schema`, also in upper and lower case. <!-- A80, D117, D152 -->

### Deploy on MySQL

Run the drop, migrate and apply steps in this order, as under [every deploy](#every-deploy), connected to the source database as the default database. Without a default database the apply script refuses, before it changes anything. With the `mysql` client use `-D`; with `prisma db execute`, the database name belongs in the URL Prisma uses. The `prisma db execute` blocks under [every deploy](#every-deploy) work unchanged. <!-- D160, D95, D43 -->

The reader account must serve only as the hyde-db reader, because every apply and drop first revokes all its privileges, and MySQL cannot roll that back. <!-- D164, D119, A74 -->

Run the scripts without `--force`: the gate on the statements from the database drop on protects only after a refusal. Since a check that fails to run refuses, only a statement that changes state can slip through: a statement that fails, such as a lock timeout on `DROP DATABASE`, can leave the previous views granted. Likewise, an account with `CREATE VIEW` or `DROP` on the views database can replace a view, and the reader grant stays attached to it. The same account can also swap the marker view between the marker check and its read. <!-- D164, D155, D166, A74, D169 -->

With the `mysql` client, export `MYSQL_HOST`, `MYSQL_USER`, `MYSQL_DATABASE` (the source database) and `MYSQL_PWD` from your secret store (never commit it). While one of the first three is unset or empty, the shell stops each `mysql` line and runs nothing. Each block chains its lines with `&&`, so a refused step stops the rest: <!-- D43, D68, D136, D163 -->

```sh
mysql -h "${MYSQL_HOST:?export MYSQL_HOST first}" -u "${MYSQL_USER:?export MYSQL_USER first}" -D "${MYSQL_DATABASE:?export MYSQL_DATABASE first}" < prisma/redacted/redacted-views-drop.sql &&
npx prisma migrate deploy &&
mysql -h "${MYSQL_HOST:?export MYSQL_HOST first}" -u "${MYSQL_USER:?export MYSQL_USER first}" -D "${MYSQL_DATABASE:?export MYSQL_DATABASE first}" < prisma/redacted/redacted-views.sql
```

With `prisma db execute`, the source database is in the URL Prisma uses (the `prisma/schema.prisma` datasource on Prisma 6, `prisma.config.ts` on Prisma 7). With Prisma 7: <!-- D160, D43 -->

```sh
npx prisma db execute --file prisma/redacted/redacted-views-drop.sql &&
npx prisma migrate deploy &&
npx prisma db execute --file prisma/redacted/redacted-views.sql
```

With Prisma 6:

```sh
npx prisma db execute --file prisma/redacted/redacted-views-drop.sql --schema prisma/schema.prisma &&
npx prisma migrate deploy &&
npx prisma db execute --file prisma/redacted/redacted-views.sql --schema prisma/schema.prisma
```

The deploying user needs these privileges: <!-- A75, A77, A102, D160, D164 -->

- `CREATE`, `DROP` and `CREATE VIEW` on the views database, `SELECT` on the source tables, `GRANT OPTION` on the views and `CREATE USER`. <!-- A75 -->
- `SELECT` on the views database, because `GRANT SELECT` on a view fails unless the granting account holds it. `SHOW VIEW` is not needed: the marker check reads the marker through the view. <!-- D164, A106, D165 -->
- `SELECT` on `mysql.*`, because the script reads the grant tables to see what the reader can reach; without it `information_schema` shows nothing. <!-- A77, D117 -->
- `CREATE TEMPORARY TABLES` on the source database, because the script reports its refusals through a temporary table. <!-- A102, D160, D99 -->

The views are created with `DEFINER = CURRENT_USER`, so they run with the deploying user's privileges. <!-- A75 -->

### What the MySQL apply script does

The apply script runs these steps in this order. Everything from the drop of the views database on runs only while no step has refused: a refusal is reported by a failing insert into a temporary table, so it leaves no routine and nothing left behind, and a client that runs past errors, such as `mysql --force`, cannot grant the reader access after one. Each run reports one problem and a short fix. Every check first sets its message to a "could not run" refusal and only then evaluates, so a check whose query fails refuses instead of passing silently. <!-- D117, D99, D155, D166 -->

1. It pins `sql_mode` and sets `lock_wait_timeout` to 60. <!-- D117 -->
2. It refuses a connection with no default database, and a default database equal to the views database. <!-- D117, D160, D152 -->
3. It refuses an existing views database without the marker view `hyde_db_marker`, and one whose marker names another source database (the marker's second column `source`). It reads the marker only from a view created `SQL SECURITY DEFINER`, so a view that would run with the deploying user's rights is never selected from, and it reports a marker it cannot read, such as one whose definer account was dropped, by naming that definer. A run with `mysql --force` shows this refusal; without it the failed read is the first error. <!-- D115, D117, D165, D169 -->
4. It refuses when the deploying user cannot read the grant tables under `mysql.*`. <!-- A77, D117 -->
5. It resets the reader with `REVOKE ALL PRIVILEGES, GRANT OPTION`, with `IGNORE UNKNOWN USER` because the account may not exist yet, and refuses when any grant is left; it reads the reader's static global privileges from the `*_priv` columns of `mysql.user`. <!-- D117, D119, A86, D168 -->
6. It refuses a reader that holds roles or default roles, a server with a non-empty `mandatory_roles`, proxy grants of the reader, and other accounts a reader login could match. <!-- D117, D120, A77 -->
7. It drops and recreates the views database, with the marker view and the views (`DEFINER = CURRENT_USER`). <!-- D117, D115, A75 -->
8. It creates the account when it is missing, locked and without a password. <!-- D117, D116 -->
9. It grants `SELECT` on each view last. <!-- D117 -->
10. It checks everything again and, when a check fails, revokes the view grants and aborts. <!-- D117, D119 -->

### What the MySQL drop script does

The drop script refuses a views database without the marker view or whose marker names another source database, revokes the reader's grants with `IGNORE UNKNOWN USER`, and drops the views database. It succeeds when the views database is already gone, and it revokes the grants either way, because grants survive the drop of the database and would attach to the next one of that name. <!-- D100, D121, D119, A74, D165 -->

### Let the reader log in

The apply script creates the account locked and without a password, and never changes an existing account's lock state or password; it does revoke all the account's privileges on every apply and drop, so the account must serve only as the hyde-db reader. Once, after the first deploy, an administrator sets the password and unlocks it. Export `READER_PASSWORD` from your secret store (never commit it) and run: <!-- D116, A85, D164, D119 -->

```sh
mysql -h "${MYSQL_HOST:?export MYSQL_HOST first}" -u "${MYSQL_USER:?export MYSQL_USER first}" -e "ALTER USER 'redacted_reader'@'%' IDENTIFIED BY '${READER_PASSWORD:?set READER_PASSWORD first}' ACCOUNT UNLOCK;"
```

The user and host in the statement are the `role` and `readerHost` of your generator block. The password must not contain a single quote or a backslash, which MySQL reads as an escape. Its cost: the expanded password is part of the client's command line, so it shows in `ps` output while the client runs, and a password typed into the export lands in your shell history. The shell runs nothing while `READER_PASSWORD`, `MYSQL_HOST` or `MYSQL_USER` is unset or empty. The unlock survives every re-apply. <!-- D116, D68, D104, D163 -->

### What it guarantees on MySQL

The guarantee is the privilege setup, scoped to table data: `redacted_reader` can read no table data outside the generated views. <!-- D101 -->

- A refused deploy never grants the reader more than it had before, but it may leave the views rebuilt without the reader grant: MySQL commits each statement as it runs, so a deploy cannot be rolled back. <!-- D101, A74 -->
- `mysql --force` protects only after a refusal: a statement that fails, such as a lock timeout, can leave the previous views granted, so run the scripts without it. An account with `CREATE VIEW` or `DROP` on the views database can replace a view, and the reader grant stays attached. <!-- D164, D155, A74 -->
- Access the reader already has through a path the reset does not remove stays until the printed fix is applied: roles, default roles, `mandatory_roles`, an account with its user name on a more specific host (such as `localhost`), and an anonymous account that matches its login. With `partial_revokes` on, a wildcard database grant is read literally and grants nothing. <!-- A104, A77 -->
- The reader sees no other database names or columns: in `information_schema` it sees only its views, which is stricter than PostgreSQL, where the reader can read catalog metadata. `SHOW DATABASES` lists `information_schema` and `performance_schema` and the databases the reader has grants in. <!-- D101, A78, A103, D93 -->
- In `performance_schema` the reader sees server status and variables, its own session and its own connection attributes; it sees no statement history and no other session's query text. <!-- A103 -->
- MySQL has no per-account statement timeout or read-only default, only session-overridable globals. Only per-account resource limits stick. <!-- D101, A78 -->
- Rows, the content of visible columns and load are not covered, as on PostgreSQL: expose only models whose every row the reader may see, hide free-text columns, and connect the reader to a replica. <!-- D34, D93 -->

Every message the apply script can print is in [what the MySQL apply script refuses](#what-the-mysql-apply-script-refuses).

### Supported services

RDS and Aurora are supported, per the providers' documentation. Cloud SQL is expected to work, but the deployer's read access to the `mysql.*` grant tables is unconfirmed; without it the apply script refuses before any change with the `GRANT SELECT ON mysql.*` fix. Azure Flexible works because the deployer is always the view definer. PlanetScale is unsupported. None is tested end to end by hyde-db. <!-- D118, A79 -->

### What the MySQL apply script refuses

Every refusal is `hyde-db: <problem> Fix: <fix>`, at most 128 characters. When a name makes it longer, the problem is shortened and the fix kept whole. When a fix would not fit, it falls back to the reader-wide `REVOKE ALL PRIVILEGES, GRANT OPTION FROM <reader>;` where revoking the reader's grants resolves the refusal, and to a short instruction only when even that does not fit, which happens only with near-maximum `role` and `readerHost` lengths, or with a long deploying account in the `mysql.*` fix. With the default `role` and `readerHost`, and a deploying account short enough for its `GRANT`, every printed fix is a statement that works when pasted. An administrator pastes it, then you run the apply script again; repeat until it passes. The table lists the problems in the order the script checks them; the examples use the default names. <!-- D151, D161, D99, D108 -->

| Refused when | Problem after `hyde-db: ` | Printed fix |
|---|---|---|
| the connection selected no database | `no default database; the connection must select the source database.` | add the database name to the connection URL |
| the default database is the views database, in any case | `the default database is the views database.` | connect to the source database, not `redacted` |
| the views database exists without the marker view | `database redacted has no hyde-db marker view.` | drop or rename it, or set "schema" to an unused name |
| the marker view exists but cannot be read, for example because its definer was dropped | `the marker view of redacted cannot be read.` | re-create its definer `'user'@'host'` or drop database `redacted` |
| the views database belongs to another source database | `database redacted belongs to source database app.` | set "schema" to an unused name |
| the deploying user cannot read the grant tables | `the deploying user cannot read the MySQL grant tables.` | `GRANT SELECT ON mysql.* TO 'deployer'@'%';` |
| the reader holds a global privilege | `the reader has a global privilege.` | `REVOKE <privilege> ON *.* FROM 'redacted_reader'@'%';` |
| the reader holds a dynamic global privilege | `the reader has a dynamic global privilege.` | `REVOKE <privilege> ON *.* FROM 'redacted_reader'@'%';` |
| the reader holds a grant on a database | `the reader has a grant on a database.` | ``REVOKE ALL ON `app`.* FROM 'redacted_reader'@'%';`` |
| the reader holds a table grant other than `SELECT` on its views | `the reader has an unexpected table grant.` | ``REVOKE ALL ON `app`.`users` FROM 'redacted_reader'@'%';`` |
| the reader holds a column grant | `the reader has a column grant.` | ``REVOKE SELECT (`email`) ON `app`.`users` FROM 'redacted_reader'@'%';`` |
| the reader holds a routine grant | `the reader has a routine grant.` | ``REVOKE ALL ON PROCEDURE `app`.`peek` FROM 'redacted_reader'@'%';`` |
| a role is granted to the reader | `the reader has a role.` | `REVOKE 'analyst'@'%' FROM 'redacted_reader'@'%';` |
| the reader has a default role | `the reader has a default role.` | `ALTER USER 'redacted_reader'@'%' DEFAULT ROLE NONE;` |
| `mandatory_roles` is not empty | `mandatory_roles is set; that is unsupported.` | `SET PERSIST mandatory_roles = '';` |
| the reader takes part in a proxy grant | `the reader takes part in a proxy grant.` | `REVOKE PROXY ON 'boss'@'%' FROM 'redacted_reader'@'%';` |
| another account could match a reader login, such as `redacted_reader` on `localhost` or an anonymous account | `another account could match a reader login.` | `DROP USER 'redacted_reader'@'localhost';` |
| a check could not run, as when its query fails under `--force` | `check <id> could not run.` | run without `--force` and read the first error |

<!-- D117, D120, D153, D154, D161, A77, A104, D165, D166, A105 -->

The last row can come from any check, so it has no place in the order. `<id>` is the check's name, such as `marker-guard`.

The grant, role, proxy and account checks run before the views database is dropped, and again after the grants. Where the second run finds a row, the script revokes the view grants and aborts: the views stay rebuilt, without the reader grant. <!-- D117, D101, A74 -->

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
| `HYDE_CONFIG_KEY_UNSUPPORTED` | error | A config key exists only on another database, such as `sourceSchema` or `statementTimeout` on MySQL. | Remove the key; the message says what to do instead. |
| `HYDE_SCHEMA_CONFLICT` | error | `schema` equals `sourceSchema`, or a model's `@@schema` equals `schema`. | Point `schema` at a schema no model uses, or move the model. |
| `HYDE_ANNOTATION_UNKNOWN` | error | A `@hyde.*` annotation does not exist. | Use the suggested annotation. |
| `HYDE_ANNOTATION_MISPLACED` | error | `@hyde.visible` or `@hyde.hidden` on a model, or `@hyde.exclude` or `@hyde.default` on a field. | Move it; on a model, use `@hyde.default(…)`. |
| `HYDE_ANNOTATION_INVALID_ARGUMENT` | error | `@hyde.default` without `(visible)` or `(hidden)`. | Write `@hyde.default(visible)` or `@hyde.default(hidden)`. |
| `HYDE_ANNOTATION_CONFLICT` | error | A field has both `@hyde.visible` and `@hyde.hidden`. | Keep one. |
| `HYDE_STRICT_UNANNOTATED` | error | Strict mode and a scalar or enum field without `@hyde.visible` or `@hyde.hidden`. | Add `/// @hyde.hidden`, or `/// @hyde.visible` if the reader may see it. |
| `HYDE_STRICT_MODEL_DEFAULT` | error | `@hyde.default` in strict mode. | Annotate each field, or set `strict = "false"`. |
| `HYDE_SENSITIVE_IMPLICIT` | error | A sensitive-looking name would become visible through a default. | Add `@hyde.hidden`, or `@hyde.visible` if it is safe. |
| `HYDE_VIEW_NAME_COLLISION` | error | Two models map to the same view name; on MySQL also a model mapped to `hyde_db_marker` or `hyde_db_abort`. | Exclude one with `@hyde.exclude`. |
| `HYDE_UNSUPPORTED_PROVIDER` | error | The datasource provider is not `postgresql` or `mysql`. | Use hyde-db only with a datasource whose provider is `postgresql` or `mysql`. |
| `HYDE_NO_OUTPUT` | error | Prisma passed no output directory. | Set `output = "./redacted"`. |
| `HYDE_RELATION_ANNOTATED` | warning | A relation field carries `@hyde.visible` or `@hyde.hidden`, which has no effect. | Annotate the scalar foreign-key fields instead. |
| `HYDE_SENSITIVE_EXPLICIT` | warning | A sensitive-looking name is explicitly `@hyde.visible`. | Make sure the column is safe to show. |
| `HYDE_TIMEOUT_DISABLED` | warning | `statementTimeout` is zero, which turns the reader role's statement timeout off. | Use a positive value such as `"15s"`, or remove the key. |
| `HYDE_LEGACY_ANNOTATION` | warning | A doc comment holds an `@ai.*` annotation from prisma-ai-views, which has no effect. | Rename it to `@hyde.*`. |

<!-- D51, D25, D26, D57, D59, D60, D156, D159 -->

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

<!-- D54, D170 -->

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

The package exports `build`, `analyze` and their types, nothing else. Both take the DMMF datamodel exactly as Prisma passes it to a generator (`options.dmmf.datamodel`) plus the generator config, and never throw on config input: every config problem becomes a diagnostic. <!-- D9, D142, D47 -->

```ts
import { analyze, build } from 'hyde-db'

const { config, views, diagnostics, counts, files } = build(datamodel, { strict: 'true' })
```

- `analyze` returns `config`, `views`, `diagnostics` and `counts` (visible and hidden columns) without rendering files. <!-- D48 -->
- `build` adds `files`, the three file contents keyed by file name, or `null` when any diagnostic is an error.
- `build` and `analyze` take an optional third argument, `{ provider: 'postgresql' | 'mysql' }`, which defaults to `postgresql`; the generator passes the datasource's provider. Code written for 1.0 keeps working. A provider value that is neither returns `HYDE_UNSUPPORTED_PROVIDER` and no files. <!-- D107, D159, D142 -->
- `config` is a `ResolvedConfig`, a union discriminated on `dialect`. Its members are `PostgresqlConfig`, with `dialect: 'postgresql'`, and `MysqlConfig`, with `dialect: 'mysql'`, which carries `readerHost` and has no `sourceSchema` or `statementTimeout`. <!-- D112, D113 -->
- `View.sourceSchema` is `string | null`. It is never `null` on PostgreSQL; it is `null` on MySQL, where the views read unqualified names from the connection's database. <!-- D112, D113 -->
- Union types in the public API may gain members in minor releases. Switch on `dialect` and handle `null` instead of assuming one shape. <!-- D112 -->
- `HYDE_NO_OUTPUT` comes only from `prisma generate`. `HYDE_UNSUPPORTED_PROVIDER` comes from `prisma generate`, and from `build` or `analyze` when a JavaScript caller passes another provider. <!-- D159 -->
- The package is ESM-only; CommonJS code can `require('hyde-db')` on every supported Node.js version. <!-- D5, A12, D31 -->

## Development

Needs Node.js 22.22 or later, pnpm 10 and Docker. `LEDGER.md` is the single source of truth for decisions; this README is a view of it, and test names start with the record they verify. Module layout, the final-check pipeline and the test layers are in [docs/architecture.md](docs/architecture.md). <!-- D37, D36, D19, D46, D20 -->

| Command | What it runs |
|---|---|
| `pnpm install` | Installs the development dependencies. |
| `pnpm lint` | Biome format and lint check; `pnpm lint:fix` applies fixes. |
| `pnpm typecheck` | TypeScript type check. |
| `pnpm build` | tsdown build with publint and attw checks. |
| `pnpm test` | Unit, characterization, DMMF contract and generator tests. |
| `pnpm test:coverage` | The same with the coverage gate: at least 95% of lines and branches in `src/`, generator entry excluded. |
| `pnpm test:integration` | Attack suite on a real PostgreSQL in Docker (`postgres:18-alpine`, or `PG_IMAGE`). Fails, never skips, without Docker. |
| `pnpm test:integration:mysql` | Attack suite on a real MySQL in Docker (`mysql:9.7`, or `MYSQL_IMAGE`), with the `mysql` client inside the container. Fails, never skips, without Docker. |
| `pnpm test:e2e` | Builds and packs the package, then runs real `prisma generate` and `prisma db execute` on Prisma 6.19.3 and 7.10.0, for PostgreSQL and for MySQL, plus a CommonJS `require` check. Needs both `E2E_DATABASE_URL` and `E2E_MYSQL_DATABASE_URL`. |
| `pnpm golden` | Rewrites the golden files under `example/redacted/` and `test/fixtures/characterization/loose/redacted/`. Run it only after an output change that a ledger decision requires. |

<!-- D20, D22, D23, D6, D43, D148, D103 -->

Attack suite on PostgreSQL 14:

```sh
PG_IMAGE=postgres:14-alpine pnpm test:integration
```

Attack suite on MySQL 8.4 (`MYSQL_IMAGE` defaults to `mysql:9.7`):

```sh
MYSQL_IMAGE=mysql:8.4 pnpm test:integration:mysql
```

**Warning: the end-to-end suite runs destructive SQL.** It drops the tables `users`, `orders` and `api_keys`, the type `Plan` and the schema `redacted`, revokes `CREATE` on schema `public` from `PUBLIC`, and creates the cluster-wide role `redacted_reader`. On MySQL it creates and drops its own databases and the reader account on the server `E2E_MYSQL_DATABASE_URL` names. Point `E2E_DATABASE_URL` and `E2E_MYSQL_DATABASE_URL` only at disposable servers, the second with the source database in its path, for example:

```sh
docker run -d --rm --name hyde-e2e -e POSTGRES_PASSWORD=pg -p 55432:5432 postgres:18-alpine
docker run -d --rm --name hyde-e2e-mysql -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=app -p 53306:3306 mysql:9.7
E2E_DATABASE_URL=postgresql://postgres:pg@localhost:55432/postgres E2E_MYSQL_DATABASE_URL=mysql://root:root@localhost:53306/app pnpm test:e2e
```

`E2E_PRISMA_VERSIONS` (default `6.19.3,7.10.0`) narrows the Prisma versions; `E2E_TARBALL` points `node --test test/e2e/*.test.mjs` at an existing `.tgz` instead of the one `pnpm test:e2e` packs.

Releases: every user-facing change adds a changeset (`pnpm changeset`). Changesets opens a version pull request on `main`. After it merges, a maintainer pushes the tag `v<version>`, and the release workflow on GitHub Actions checks, builds and publishes that tag with provenance. It publishes only a commit on which CI passed; branch and pull-request CI never publish. [RELEASING.md](RELEASING.md) gives the steps. <!-- D63, D62, D126 -->

## Security

Report vulnerabilities privately; [SECURITY.md](SECURITY.md) says how, and repeats the guarantee, its limits and a hardening checklist. <!-- D41 -->

## License

MIT

---

View on LEDGER.md, 2026-10-06
