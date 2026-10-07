# Run-brief: hyde-db MySQL backend (1.1.0)

## 1. Goal essence

hyde-db gives any reader, an AI tool or a person, read access to a Prisma-managed PostgreSQL or MySQL database exposing only the columns that annotations allow (Intent). 1.1.0 adds MySQL 8.4 and 9.7 (D86, D87, D94): a portable SQL script with the same workflow and output files as PostgreSQL, runnable with the `mysql` client and `prisma db execute`, no runtime dependency (D95, D32). MySQL cannot roll back DDL or grants (A74), so safety comes from ordering: check, build views, grant last, re-check, revoke and abort on failure.

## 2. Constraints & conventions

- Plan: `docs/superpowers/plans/2026-10-07-hyde-db-mysql.md`; spec: `docs/superpowers/specs/2026-10-06-hyde-db-mysql-design.md`. The ledger wins over both. Never edit `LEDGER.md`; the controller records the plan's `## Proposed ledger records` (P1 to P12).
- Ledger-citation rule: cite record IDs (D.., A..) in test names and doc comments; add no decision of your own.
- TDD: red test first, minimal code, green. Conventional Commits, one commit per task, ending with the attribution line the harness gives. Parallel agents in a wave do not commit; the ESW parent does.
- Biome lint (`pnpm lint`). Strict TypeScript, ESM, core modules pure, only `src/generator.ts` does I/O (D5). Coverage at least 95% lines and branches in `src/` (D23).
- Golden rule: golden files change only via `pnpm golden` after a ledger-backed output change (D6). Existing goldens (`example/`, `test/fixtures/characterization/loose`) must stay byte-identical; only `example-mysql/redacted` is new.
- Integration tests fail, never skip, without Docker (D22). Task 1 (D143) is a pure move, byte-identical, checked by diffing dumped output before and after.

## 3. Architecture decisions

- Shared core plus a `Dialect` per database in an internal registry; `build`/`analyze` take `{ provider: 'postgresql' | 'mysql' }` as optional third argument, default `postgresql` (D104, D107, D114). Unknown provider: diagnostic, never a throw (D142, P12).
- `ResolvedConfig` is a union on `dialect`; the `mysql` member carries `readerHost` without `sourceSchema`/`statementTimeout`; `View.sourceSchema` is `null` on MySQL; `validateConfig(raw, dialect)` holds key sets and limits as data (D112, D113). MySQL keys: `schema` (64), `role` (32, the account user name), `readerHost` (default `%`); `sourceSchema`/`statementTimeout` are errors (D97, D120).
- Quoting: backtick identifiers, only single quotes doubled in literals, under `SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_BACKSLASH_ESCAPES'` (D104).
- Apply order (D117): pin mode and `lock_wait_timeout`; default-database check; marker guard (view `hyde_db_marker`, D115); `mysql.*` read check (A77); `REVOKE ALL PRIVILEGES, GRANT OPTION … IGNORE UNKNOWN USER` then verify (D119, A86); pre-check roles, `mandatory_roles`, proxies, other accounts; drop and recreate the views database, views `DEFINER = CURRENT_USER` (A75); create the account only if missing, `ACCOUNT LOCK`, no password (D116, A85); `GRANT SELECT` per view last; re-check, revoke and abort on failure.
- Aborts: failing temporary-table insert, no routines, no `DELIMITER`, one problem and a fix of at most 128 characters (D99, A76). Statements from the database drop on are gated on a refusal flag (P8). Drop script: marker guard, revoke, `DROP DATABASE IF EXISTS` (D100, D121).
- Non-goals: MySQL 8.0, 26.x, MariaDB, PlanetScale; a deploy CLI; any runtime dependency; end-to-end testing of managed services (D94, D95, D118).
- Docs state: D101 guarantees, D118 services, D120 `role` meaning and `mandatory_roles`, D112 union types may gain members. Release: `minor` changeset (D107); do not merge while the 1.0.0 `major` changeset is still pending.

## 4. File map

- Create: `src/render/acl-helpers.ts`, `src/render/final-checks.ts` (T1)
- Modify: `src/render/apply-sql.ts` (T1, T4), `src/types.ts`, `src/config.ts`, `src/diagnostics.ts` (T2), `src/analyze.ts` (T2, T4), `src/build.ts`, `src/index.ts` (T4)
- Modify: `src/sql.ts` (T3); `src/dialects/postgresql.ts`, `src/render/drop-sql.ts`, `src/render/markdown.ts`, `src/render/schema-guard.ts` (T4)
- Create: `src/dialects/index.ts` (T4), `src/dialects/mysql.ts` (T11)
- Create: `src/render/mysql-guards.ts` (T5), `src/render/mysql-apply-checks.ts` (T6, T7), `src/render/mysql-drop-sql.ts` (T8), `src/render/mysql-markdown.ts` (T9), `src/render/mysql-apply-sql.ts` (T10)
- Modify: `src/generator.ts`, `src/cli-help.ts` (T11, T19)
- Create: `example-mysql/schema.prisma`, `example-mysql/redacted/*` (via `pnpm golden`), `test/fixtures/contract/mysql-features.prisma`; modify `test/helpers/prisma.ts`, `scripts/update-golden.ts`, `test/characterization/characterization.test.ts`, `test/contract/dmmf.test.ts` (T12)
- Modify: `package.json`, `pnpm-lock.yaml`, `vitest.config.ts`, `test/unit/integration-policy.test.ts`; create `test/integration-mysql/{global-setup.ts,helpers/db.ts,harness.test.ts}` (T13)
- Create: `test/integration-mysql/{lifecycle,preconditions,drop}.test.ts` (T14), `paths.test.ts` (T15), `stop-midway.test.ts` (T16)
- Create: `test/e2e/mysql.test.mjs`; modify `test/e2e/helpers.mjs` (T17)
- Modify: `.github/workflows/ci.yml`, `test/unit/workflows.test.ts` (T18)
- Modify: `README.md`, `test/unit/readme.test.ts`, `test/unit/cli-help.test.ts` (T19); `SECURITY.md`, `docs/architecture.md`, `package.json`, `test/unit/security-doc.test.ts`, `test/unit/package.test.ts` (T20)
- Create: `.changeset/hyde-db-mysql.md` (T21)
- Create (unit tests, per task): `test/unit/render-final-checks.test.ts`, `dialects.test.ts`, `render-mysql-guards.test.ts`, `render-mysql-apply-checks.test.ts`, `render-mysql-drop-sql.test.ts`, `render-mysql-markdown.test.ts`, `render-mysql-apply-sql.test.ts`

## 5. Test/lint gate

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test:coverage` (unit, characterization, contract; at least 95% lines and branches)
- `pnpm build`
- `PG_IMAGE=postgres:14-alpine pnpm test:integration` and `PG_IMAGE=postgres:18-alpine pnpm test:integration` (Docker)
- `MYSQL_IMAGE=mysql:8.4 pnpm test:integration:mysql` and `MYSQL_IMAGE=mysql:9.7 pnpm test:integration:mysql` (Docker)
- `pnpm test:e2e` with `E2E_DATABASE_URL` and `E2E_MYSQL_DATABASE_URL` set (Prisma 6.19.3 and 7.10.0)
- Goldens: `pnpm golden`, then `git diff --exit-code main -- example test/fixtures/characterization`
