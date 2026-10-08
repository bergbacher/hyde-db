# Releasing hyde-db

Only a release tag builds and publishes the package, and only on GitHub Actions. No version is built or published from a laptop.

| Workflow | Runs on | Builds or publishes? |
| --- | --- | --- |
| `ci.yml` | pull requests, branch pushes | Builds and packs only to test the artifact. Never publishes. |
| `version.yml` | push to `main` | Never. Opens or updates the "Version Packages" pull request. |
| `release.yml` | push of a tag `v*.*.*` | Yes: gate, pack, upload the tarball, publish with provenance. |

## Day to day

1. For every user-facing change, add a changeset: `pnpm changeset`, commit the file with the change.
2. Merge to `main`. `version.yml` opens or updates the "Version Packages" pull request.
3. Wait for CI to pass on that pull request, then merge it. Pushes made with `GITHUB_TOKEN` start no workflows, so `version.yml` dispatches `ci.yml` on the `changeset-release/main` branch itself. If CI does not start, close and reopen the pull request, or run the CI workflow manually on that branch.
4. Tag the merge commit and push the tag:

```bash
git checkout main && git pull
git tag v<version> <merge-commit>
git push origin v<version>
```

5. Watch the `Release` workflow. It publishes `hyde-db@<version>` and keeps the `.tgz` as a workflow artifact.

The repository setting "Allow GitHub Actions to create and approve pull requests" must be on, or `version.yml` cannot open the pull request.

Make `ci-ok` the single required status check of `main` (Settings, Branches, the branch protection rule or ruleset for `main`). `ci-ok` passes only when every other CI job passed, so requiring the individual jobs as well adds nothing, and a renamed matrix job would then block every pull request.

## First release

npm trusted publishing cannot create a package, so the first publish authenticates with a token. The owner does these steps in order:

1. On npmjs.com create a granular access token with read and write access to all packages (a package that does not exist yet cannot be selected), "Bypass two-factor authentication" ticked (no one is there to type a one-time code) and the shortest expiry.
2. Add it as the repository secret `NPM_TOKEN` (Settings, Secrets and variables, Actions).
3. Merge the version pull request, then push the tag `v1.0.0` as in "Day to day".
4. Watch `release.yml` publish.
5. On npmjs.com open the package, Settings, Trusted Publisher: repository `bergbacher/hyde-db`, workflow `release.yml`.
6. Delete the `NPM_TOKEN` secret and revoke the token, then set the package to require two-factor authentication and disallow tokens. Trusted publishing keeps working.

From then on `release.yml` authenticates through OIDC and no long-lived npm token exists.

## What `release.yml` checks

| Check | Why |
| --- | --- |
| The tag minus the leading `v` equals `package.json` `version` | A tag that does not match the version would publish the wrong release, so it fails. Fix the version, delete the tag locally and on `origin`, tag again. |
| The tagged commit is an ancestor of `main` | Only reviewed code that passed CI on `main` is released. |
| The `ci-ok` check run on the tagged commit concluded `success` | D64: a release counts only when every CI job passed on the release commit. When `ci-ok` has not finished or has not run on that commit, the job says so. Wait for CI, or start it, then re-run the release. |
| Lint, type check, unit tests with the coverage gate, build with publint and attw | The release job needs no Docker. The attack suite and end-to-end matrices already ran in CI on that commit (D64). |

The publish step runs `npm publish <tarball> --provenance --access public` on Node 24 (npm 11.5.1 or newer) with `id-token: write`.

## Good to know

- The release job rebuilds from the tagged commit and runs its own gate; the published tarball is not byte-copied from CI.
- Prerelease tags such as `v1.0.0-rc.1` match the trigger, but npm then needs `--tag`, and the workflow does not support prereleases. Do not push them.
- Optional hardening: create a GitHub environment `npm` with a required reviewer, put it on the `publish` job and name it in the trusted-publisher entry on npmjs.com; add tag protection for `v*`.
