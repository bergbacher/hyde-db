---
"@hyde/db": minor
---

MySQL support. With a datasource `provider = "mysql"`, hyde-db generates a portable MySQL apply script, a drop script and a Markdown description of the views, with the same three output files and the same deploy workflow as PostgreSQL; it runs with the `mysql` client and `prisma db execute`. MySQL commits DDL and grants as it runs, so the script checks first, grants last, re-checks, and revokes the reader and aborts if the final check fails. New MySQL config key `readerHost`; `sourceSchema` and `statementTimeout` are errors on MySQL (new diagnostic `HYDE_CONFIG_KEY_UNSUPPORTED`). `build` and `analyze` take an optional third argument `{ provider: 'postgresql' | 'mysql' }` (default `postgresql`); the exported `ResolvedConfig` union gains a `mysql` member and `DiagnosticCode` gains a code, which minor releases may do. Supports MySQL 8.4 and 9.7; MySQL 8.0, innovation releases and MariaDB are not supported.
