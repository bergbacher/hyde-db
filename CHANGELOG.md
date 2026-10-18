# hyde-db

## 1.2.0

### Minor Changes

- 22591d2: MySQL 8.0 is supported from 8.0.21, beside 8.4 and 9.7. The generated MySQL scripts no longer use `REVOKE … IGNORE UNKNOWN USER`, which needs MySQL 8.0.30: they look the reader account up in `mysql.user` and revoke only when it exists. The drop script now reads `mysql.user`, which the deploying user already needs `SELECT` on for the apply script. The MySQL attack suite can target a running server through `MYSQL_URL`.

## 1.1.0

### Minor Changes

- 64bbc88: MySQL support. With a datasource `provider = "mysql"`, hyde-db generates a portable MySQL apply script, a drop script and a Markdown description of the views, with the same three output files and the same deploy workflow as PostgreSQL; it runs with the `mysql` client and `prisma db execute`. MySQL commits DDL and grants as it runs, so the script checks first, grants last, re-checks, and revokes the reader and aborts if the final check fails. New MySQL config key `readerHost`; `sourceSchema` and `statementTimeout` are errors on MySQL (new diagnostic `HYDE_CONFIG_KEY_UNSUPPORTED`). `build` and `analyze` take an optional third argument `{ provider: 'postgresql' | 'mysql' }` (default `postgresql`); the exported `ResolvedConfig` union gains a `mysql` member and `DiagnosticCode` gains a code, which minor releases may do. Supports MySQL 8.4 and 9.7; MySQL 8.0, innovation releases and MariaDB are not supported.

## 1.0.0

### Major Changes

- c075465: First release of hyde-db. From `/// @hyde.*` annotations in a Prisma schema it generates read-only PostgreSQL views, a locked-down reader role and a Markdown description of the views for whoever reads them. Columns stay hidden unless annotated visible, and sensitive-looking names are flagged. The apply script runs in one transaction and ends with a final check that refuses every way the reader could reach table data outside the views, printing a fix that works when pasted. Supports Prisma 6 and 7, PostgreSQL 14 to 18 and Node.js 20.19+, 22.12+ and 24+, with no runtime dependencies.
