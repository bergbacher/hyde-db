---
status: Approved
autonomy: hands-off
defer_to_issues: false
track_token_usage: off
worktree: in-place
---

# hyde-db — MySQL backend design (1.1.0)

*View on `LEDGER.md`, 2026-10-06. Every statement cites the ledger record it comes from; where this view and the ledger differ, the ledger wins.*

## Goal

hyde-db gives any reader — an AI tool or a person — read access to a Prisma-managed PostgreSQL or MySQL database exposing only the columns that annotations in the Prisma schema allow (Intent). MySQL support is required (D86) and ships in 1.1.0, after the PostgreSQL-only 1.0.0 (D87). It targets the MySQL LTS lines 8.4 and 9.7; MySQL 8.0, innovation releases (26.x) and MariaDB are out of scope (D94, A73).

## Approach

A portable SQL script with the same workflow and output files as PostgreSQL, runnable with the `mysql` client and `prisma db execute`, with no runtime dependency (D95, D32). MySQL commits DDL and grants implicitly, so a deploy cannot be rolled back (A74); safety comes from ordering instead: check → build the views → grant last → re-check → revoke and abort on failure (D95).

## Architecture

- One shared core — annotations, config validation, analysis — and a dialect per datasource provider (`postgresql`, `mysql`) that renders the apply SQL, the drop SQL and the Markdown wording. The generator accepts both providers (D96, A80).
- Prisma with `provider = "mysql"`: `activeProvider` is `"mysql"`, multi-schema is unsupported, the source database is the connection's default database, enums are inline column types, `@map`/`@@map` arrive as `dbName`, `view` blocks arrive in `models` (A80).

## Config on MySQL

| Key | Meaning on MySQL | Records |
|---|---|---|
| `schema` | the views database; default `redacted`; at most 64 characters | D97 |
| `role` | the account user name; default `redacted_reader`; at most 32 characters | D97 |
| `readerHost` | MySQL only: the account host; default `%` | D97 |
| `sourceSchema` | error on MySQL (no schemas; the source database is the connection's) | D97, A80 |
| `statementTimeout` | error on MySQL (no per-account timeout) | D97, A78 |

Errors carry fix hints like every other diagnostic (D25, D26).

## Apply script (D98)

1. Strict SQL mode and `lock_wait_timeout = 60`.
2. Abort if the views database exists without hyde-db's marker view (the marker, since MySQL databases carry no comment) — nothing is dropped.
3. Abort with the `GRANT SELECT ON mysql.* …` fix if the deployer cannot read the grant tables; without that access `information_schema` would silently show nothing (A77).
4. `REVOKE ALL PRIVILEGES, GRANT OPTION FROM <reader>` — strips every direct grant, including stale view grants, which MySQL re-attaches to re-created names (A74, A77).
5. Pre-check, before any build step, refusing what the reset cannot fix: roles or default roles on the reader, a non-empty `mandatory_roles`, proxy grants, and other accounts a login could match (same name on another host, anonymous accounts) (A77).
6. Drop and recreate the views database with the marker view and the views, created with `DEFINER = CURRENT_USER` so they expose only their columns and fail closed if the definer breaks (A75).
7. Create the account if missing with `ACCOUNT LOCK`; grant `SELECT` on each view last.
8. Re-check; on failure revoke the view grants and abort.

Aborts use a failing temporary-table insert — no `CREATE ROUTINE`, nothing left behind — and report one problem with a fix of at most 128 characters per run (D99, A76). The script uses no `DELIMITER`, so the same file runs under both clients (A76).

## Drop script

Checks the marker, drops the views database and revokes the reader's view grants, which would otherwise survive and re-attach (D100, A74).

## Guarantee on MySQL (docs, D101)

- The reader can read no table data outside the views.
- A refused deploy never grants the reader more than before, but it may leave the views rebuilt without the reader grant (A74).
- The reader sees no other database names or columns (A78) — stricter than PostgreSQL.
- Only per-account resource limits stick; read-only and timeout are session settings the reader can change (A78).

## Supported services (D102, A79)

RDS, Aurora and Cloud SQL are supported. Azure Flexible works because the deployer is always the view definer. PlanetScale (Vitess) is documented as unsupported.

## Testing (D103)

| Layer | Proves |
|---|---|
| Unit + characterization | the MySQL renderer and its golden files |
| Attack suite on MySQL 8.4 and 9.7 | every path in A77 is refused, each with a fix that works when pasted |
| Stop-midway proof | stopping the script after each statement never gives the reader more than its view grants |
| End-to-end | `prisma db execute` with `provider = "mysql"` on Prisma 6 and 7 |

Implementation starts after 1.0.0 ships (D87); its plan passes the design review gate first (D103).
