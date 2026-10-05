# Run-brief: hyde-db

Read this brief, then only your own task section in `docs/superpowers/plans/2026-10-05-hyde-db.md`. The spec is `docs/superpowers/specs/2026-10-05-hyde-db-design.md`; its source of truth is `LEDGER.md` (records A1–A30, D1–D48, Q1–Q5). Where they differ, the ledger wins.

## 1. Goal essence

Rebuild `prisma-ai-views` 0.1.0 test-first as the npm package `hyde-db`: a Prisma 6/7 generator that turns `/// @ai.visible`, `@ai.hidden`, `@ai.exclude` and `@ai.default(…)` annotations into three files: `ai-views.sql` (schema `ai` with one column-filtered view per model, a role `ai_reader` with `SELECT` on those views only, and a final check that aborts the transaction if the role could reach anything else), `ai-views-drop.sql`, and `ai-schema.md` (LLM context). Production-ready means every CI job passes on the release commit and the release is published from CI with provenance (D44). First version: 1.0.0, produced via a changeset, not published by this run (D40).

The rewrite first reproduces the base output byte for byte (characterization, D6). Only then do ledger-backed changes land, each driven by a failing test: branding `hyde-db` and `strict` on by default (D17), word-based sensitive-name lint (D16), the `@@schema` conflict rule (D12), the schema-marker guard (D11), and final-check aborts for `SECURITY DEFINER` functions, readable sequences (D13) and `CREATE` privileges (D24). Problems are structured diagnostics with stable `HYDE_*` codes, fix hints and did-you-mean suggestions (D25, D26, D29, D33).

## 2. Constraints & conventions

- **Shell setup, every command:** `export PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH"` (the default `node` is 22.21; local development needs ≥ 22.22, D37) and work in `/Users/rubens/.superset/worktrees/hyde-db/veiled-editor`.
- **Node support:** `engines.node` `^20.19 || ^22.12 || >=24` (D31). CI runs on Node 24; the end-to-end layer also runs on Node 20.
- **pnpm 10** (`pnpm@10.34.1`; `packageManager` lands in Task 29).
- **Pins (devDependencies only):** `typescript ~7.0.2`, `tsdown ~0.23.0`, `vitest 5.0.3`, `@vitest/coverage-v8 5.0.3`, `@biomejs/biome 2.5.15`, `publint 0.3.25`, `@arethetypeswrong/core 0.18.5`, `@testcontainers/postgresql ^12.2.0`, `pg ^8.23.1`, `@types/pg ^8.15.6`, `@types/node ^22.20.5`, `@changesets/cli ^3.0.3`, `prisma-schema-wasm-6@npm:@prisma/prisma-schema-wasm@7.1.1-3.c2990dca591cba766e3b7ef5d9e8a84796e47ab7`, `prisma-schema-wasm-7@npm:@prisma/prisma-schema-wasm@7.10.0-4.0edf323efd1d98336f3f0a68684b56f689b900d3`. End-to-end installs `prisma@6.19.3` and `prisma@7.10.0`.
- **No runtime dependencies** and no `peerDependencies` (D32).
- **ESM-only, strict TypeScript:** `"type": "module"`, single export `./dist/index.mjs`, no `main`; `isolatedDeclarations`, `erasableSyntaxOnly` and `noUncheckedIndexedAccess` on; source imports use explicit `.ts` extensions (Node runs `src/generator.ts` directly in tests via type stripping) (D5, D36).
- **Public API** is exactly `build`, `analyze` and their types from `src/index.ts` (D9); the core imports no Prisma types (D7); `src/generator.ts` is the only module with I/O (D5).
- **Naming:** package, bin and generator provider `hyde-db` (D3). Annotation names, config keys (`schema`, `role`, `sourceSchema`, `default`, `strict`, `statementTimeout`), defaults (`ai`, `ai_reader`, `public`, `hidden`, `15s`) and output file names stay as in the base (D17).
- **Test names carry ledger IDs first** when they verify a record: `it('A2: …')`, `it('D11: …')` (D19). Tests for open assumptions (A2, A3, A12, A14, A15, A30) assert what PostgreSQL or Prisma actually does; if one fails, report the record falsified, never weaken the assertion.
- **Golden files** (`example/ai/*`, `test/fixtures/characterization/loose/ai/*`) change only in Tasks 14, 22, 23, 24, only through `pnpm golden`, and must match the SHA-256 checksums in the task (D6).
- **Integration tests never skip** and the container start has no error handling (D22). Docker must run for Tasks 16, 21–24, 30.
- **Coverage:** ≥ 95% lines and branches in `src/`, generator entry excluded (D23).
- **Do not edit** `LEDGER.md`, the spec or `.gitignore` (it already ignores `node_modules/`, `dist/`, `coverage/`, `*.tgz` and more; the `.e2e/` pack directory only holds a `.tgz`).
- **Done-report:** files changed, test commands with results, ledger records verified or falsified (ID + test name), and — in a parallel wave — the task's exact `git add` / `git commit` commands instead of committing.
- **Commits:** Conventional Commits, one per task, message ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never use bare `git stash`. **Parallel agents within a wave edit disjoint files and do NOT commit — the ESW parent commits each task sequentially after the wave settles.** During a parallel wave run only your own task's tests.
- **Out of scope:** Prisma 8 (Q5 open), row filtering, non-PostgreSQL databases (D34).

## 3. Architecture decisions

- **Pipeline:** `build(dmmf.datamodel, generator.config)` → `toDatamodel` (adapter, D7/D47) → `validateConfig` (canonical key order; Prisma 6 and 7 deliver keys in different orders) → per model `readModelAnnotations` / per field `readFieldAnnotations` → rules in `analyze` (strict, defaults, sensitive lint on field and column name, relations never exposed, view-name collisions, D12) → `Analysis { config, views, diagnostics, counts }` (D48) → renderers (`renderApplySql`, `renderDropSql`, `renderMarkdown`, sharing `quoteIdent`/`quoteLiteral` and `renderSchemaGuard`). `build` returns `files: null` when any diagnostic is an error.
- **Diagnostics (D33, D26, D25):** `{ code, severity, location, message, hint? }`; locations `config.<key>`, `model <Name>`, `<Model>.<field>`, `view <name>`, `datasource`, `generator`. All factories and the 15 codes live in `src/diagnostics.ts`; every error has a hint; `didYouMean` suggests the closest candidate within Levenshtein distance 2, case-insensitive. Config never throws; invalid values keep safe defaults (D29).
- **Generator protocol (D32, A19, A20):** requests on stdin, responses on **stderr**, one JSON object per line; `getManifest` → `{ manifest: { prettyName, defaultOutput: './ai' } }`; `generate` → `null`, or `{ code: -32000, message: formatReport(all diagnostics) }`. Warnings and the summary `hyde-db: N views, V visible and H hidden columns → <path>` go to **stdout** (Prisma hides stderr on success, D28/D33). Non-PostgreSQL datasources produce `HYDE_UNSUPPORTED_PROVIDER`.
- **Apply SQL:** one transaction: create role if missing → marker guard (abort unless the existing schema's comment starts with `Generated by hyde-db`, D11) → drop/recreate schema → views → grants → session defaults → final check. The final check aborts on readable relations outside the schema, role membership, executable `SECURITY DEFINER` routines in usable schemas, readable sequences (D13) and `CREATE` on any schema (D24). Each new abort prints `Fix: REVOKE … FROM <grantees>;` naming `PUBLIC` when PUBLIC holds the privilege and the role only when it has a direct grant, so the fix runs even after a first deploy rolled back the role. The sequence privilege test is wrapped in `CASE WHEN c.relkind = 'S'` (PostgreSQL otherwise evaluates it on non-sequences).
- **Session settings are defaults, privileges are the guarantee** (D14): the role can `SET` read-only and timeout off; it still cannot write tables, but can create TEMP tables.
- **Test layers (D20):** unit, characterization (golden files from the base core), DMMF contract (Prisma 6 vs 7 schema engines via pinned wasm), attack suite (Testcontainers PostgreSQL 14/18, `psql -v ON_ERROR_STOP=1 -f -` via `docker exec -i` inside the container, fresh database and unique role per test, D43), end-to-end (`node:test`, packed tarball, real `npx --no prisma generate` and `prisma db execute --file`, CommonJS `require`).
- **Release (D39):** Changesets; release workflow split into `changesets/action/{select-mode,version,pack,publish}@v2`; npm trusted publishing (OIDC, provenance) on Node 24; the owner publishes 1.0.0 by hand first.

## 4. File map

- `package.json` — package metadata, scripts, pinned devDependencies (T1; engines, packageManager, repository in T29; version 1.0.0 in T30)
- `pnpm-lock.yaml` — lockfile (T1)
- `tsconfig.json` — strict TS 7, isolatedDeclarations, includes src/test/scripts/configs (T1)
- `tsdown.config.ts` — entries index (dts) + generator (bin), publint, attw esm-only, failOnWarn (T1)
- `vitest.config.ts` — projects unit and integration (globalSetup only in integration), coverage 95% (T1)
- `biome.json` — recommended preset, single quotes, no semicolons, width 100 (T1)
- `.nvmrc` — `24` (T29)
- `src/index.ts` — public API: build, analyze, types (placeholder T1; T13)
- `src/types.ts` — public types (T2)
- `src/brand.ts` — `BRAND`, `SCHEMA_MARKER` (T2; `hyde-db` in T14)
- `src/diagnostics.ts` — codes, severities, factories with hints, did-you-mean, formatting (T2)
- `src/sql.ts` — `quoteIdent`, `quoteLiteral` (T4)
- `src/datamodel.ts` — `toDatamodel` adapter and internal Datamodel (T5)
- `src/config.ts` — `validateConfig`, `DEFAULT_CONFIG`, `CONFIG_KEYS` (T6; strict default T15)
- `src/sensitive.ts` — `isSensitiveName` (base T7; word-based + `splitWords` T17)
- `src/render/markdown.ts` — ai-schema.md (T8)
- `src/annotations.ts` — `parseDoc`, `readModelAnnotations`, `readFieldAnnotations` (T9)
- `src/render/apply-sql.ts` — ai-views.sql (T10; guard T22; D13 T23; D24 T24)
- `src/render/drop-sql.ts` — ai-views-drop.sql (T11; guard T22)
- `src/render/schema-guard.ts` — marker check DO block (T22)
- `src/analyze.ts` — analysis rules, counts (T12; D12 T18)
- `src/build.ts` — `build` (T13)
- `src/generator.ts` — bin, JSON-RPC protocol, file output (placeholder T1; T20)
- `scripts/update-golden.ts` — `pnpm golden` (T13)
- `scripts/pack-e2e.mjs` — build + pack into `.e2e/` (T25)
- `example/schema.prisma`, `example/ai/{ai-views.sql,ai-views-drop.sql,ai-schema.md}` — golden case "example" (T3; T14, T22–T24)
- `test/fixtures/characterization/loose/schema.prisma`, `…/loose/ai/*` — golden case "loose" (T3; T14, T15, T22–T24)
- `test/fixtures/contract/features.prisma` — contract fixture (T19)
- `test/fixtures/sql/example-tables.sql` — example tables for PostgreSQL (T16)
- `test/helpers/files.ts` — `repoRoot`, `OUTPUT_FILES`, `readRepoFile` (T1)
- `test/helpers/dmmf.ts` — `scalar`, `model`, `datamodel` builders (T2)
- `test/helpers/views.ts` — renderer inputs `config`, `users`, `orders` (T2)
- `test/helpers/prisma.ts` — `parseSchema`, `forMajor` via pinned wasm (T3)
- `test/unit/package.test.ts` — package.json claims (T1; T29)
- `test/unit/diagnostics.test.ts` — catalog (T2)
- `test/unit/prisma-helper.test.ts` — helper (T3)
- `test/unit/sql.test.ts` (T4), `datamodel.test.ts` (T5), `config.test.ts` (T6; T15), `sensitive.test.ts` (T7; T17), `render-markdown.test.ts` (T8; T14), `annotations.test.ts` (T9), `render-apply-sql.test.ts` (T10; T14, T22, T23, T24), `render-drop-sql.test.ts` (T11; T14, T22), `analyze.test.ts` (T12; T18), `build.test.ts` (T13), `brand.test.ts` (T14), `integration-policy.test.ts` (T16), `readme.test.ts` (T26), `security-doc.test.ts` (T27), `workflows.test.ts` (T28), `release.test.ts` (T29)
- `test/characterization/characterization.test.ts` — golden comparison (T13; T15)
- `test/contract/dmmf.test.ts` — Prisma 6 vs 7 (T19)
- `test/generator/protocol.test.ts` — generator over stdin/stderr (T20)
- `test/integration/global-setup.ts`, `test/integration/helpers/db.ts`, `test/integration/harness.test.ts` — harness (T16)
- `test/integration/attack.test.ts` (T21), `marker.test.ts` (T22), `definer.test.ts` (T23), `create-privilege.test.ts` (T24)
- `test/e2e/helpers.mjs`, `generate.test.mjs`, `require.test.mjs` — end-to-end (T25)
- `README.md` (T26), `SECURITY.md` (T27), `CHANGELOG.md` (T30)
- `.github/workflows/ci.yml`, `.github/dependabot.yml` (T28); `.github/workflows/release.yml`, `.changeset/config.json`, `.changeset/README.md` (T29)

## 5. Test/lint gate

Per task, before committing (or before handing the commit commands to the parent):

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH"
pnpm lint:fix && pnpm lint      # Biome format + lint (biome ci .)
pnpm typecheck                  # tsc --noEmit (TypeScript 7)
pnpm test:coverage              # unit + characterization + contract + generator; ≥95% lines and branches
```

Plus, where the task says so:

```bash
pnpm build                                            # tsdown + publint + attw (ESM-only)
pnpm test:integration                                 # attack suite, PostgreSQL 18 (Docker)
PG_IMAGE=postgres:14-alpine pnpm test:integration     # attack suite, PostgreSQL 14
pnpm vitest run --project integration test/integration/<file>.test.ts   # one integration file
docker run -d --rm --name hyde-e2e -e POSTGRES_PASSWORD=pg -p 55432:5432 postgres:18-alpine
E2E_DATABASE_URL=postgresql://postgres:pg@localhost:55432/postgres pnpm test:e2e   # end-to-end, Prisma 6 and 7
pnpm golden                                           # only in Tasks 14, 22, 23, 24; then check the checksums
```

Expected end state (Task 30): unit project 220 tests, 100% lines / ≥ 96% branches; integration 32 tests on PostgreSQL 14 and 18; end-to-end 12 tests; publint and attw clean.
