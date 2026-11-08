# Releasing

`@speedle/mcp` is uploaded only by `.github/workflows/release.yml`, from a tag
on a commit of `main`, with `npm stage publish`. A maintainer then approves the
staged version on npmjs.com with 2FA, which publishes it. Never upload the
package by hand.

Versions are plain `X.Y.Z` (no pre-release suffix). The first release on npm
is `0.2.0`; `0.1.0` was never published.

## What the workflow does

A pushed `vX.Y.Z` tag starts one run:

1. **preflight**: reads the `release` environment with the workflow token's
   `actions: read` permission and fails if it is missing or unreadable.
2. **verify**: the tag is `vX.Y.Z`, the selected commit is an ancestor of
   `main`, and every version source listed below equals `X.Y.Z`
   (`scripts/release-version.mjs`).
3. **build**: installs from the lockfile, runs the unit tests and the package
   smoke test, and packs the tarball. This job has no secrets and no OIDC
   token, and no caches are used.
4. **publish**: runs in the GitHub environment `release` without waiting for
   approval, downloads the tarball built in step 3 and stages it with
   `npm stage publish --provenance --access public`. This is the only job with
   `id-token: write`.

   How it authenticates depends on whether the package exists on npm yet:

   - **First release**, before `@speedle/mcp` exists and trusted publishing can
     be configured: the stage-only token in the `release` environment secret
     `NPM_STAGE_TOKEN`. The workflow checks the public registry first and fails
     if `@speedle/mcp` already exists while that secret is still set.
   - **Later releases**: trusted publishing (OIDC). The token must be deleted
     after the first release.

   Staging publishes no version content. For a package that does not exist yet,
   npm does create the package and a public placeholder version `0.0.0-stage`.
   A maintainer must approve the staged `X.Y.Z` with 2FA before it goes live;
   the job summary the workflow writes repeats the approve step.

The `release` environment has no required reviewers (owner decision,
2026-11-05): a pushed tag runs the checks and the upload without a GitHub
approval. The 2FA approval of the staged version is a separate, deliberate npm
step.

Only repository admins may push a release tag: the tag ruleset restricts `v*`
tag creation, updates and deletions to admins, and the `release` environment
accepts deployments only from `v*` tags.

The workflow has no pull request or `workflow_run` trigger and runs only on
GitHub-hosted `ubuntu-latest` runners. Every action is pinned by commit SHA,
and the only artifact it stores is the package built for that run.

## Cutting a release

1. **Release PR**, titled `chore: release X.Y.Z`. Set the version in every
   source and change the `CHANGELOG.md` heading from `## X.Y.Z (unreleased)` to
   `## X.Y.Z (YYYY-MM-DD)`.

   | Version source (all must match the tag)    | Helper                                                                                    |
   | ------------------------------------------ | ----------------------------------------------------------------------------------------- |
   | `package.json` `version`                   | `npm version X.Y.Z --no-git-tag-version` updates this and both `package-lock.json` fields |
   | `package-lock.json` `version`              | same                                                                                      |
   | `package-lock.json` `packages[""].version` | same                                                                                      |
   | `src/version.ts` `VERSION`                 | edit by hand                                                                              |

   To check locally: `node scripts/release-version.mjs vX.Y.Z`.

2. **Merge** the PR and wait until the `ci` workflow is green on `main`.
3. **Tag** the merge commit and push only that tag:

   ```sh
   git fetch origin
   git tag -a v0.2.0 -m "0.2.0" <merge-commit-sha>
   git push origin v0.2.0
   ```

4. **Watch** the run (Actions → release). The publish job starts automatically
   after the checks pass. Confirm that:
   - the run is for the requested tag and the expected `main` commit;
   - `preflight` passed, `verify` printed `... is on main` and an `ok:` line for
     every version source, and `build` is green;
   - `publish` reports the tarball it staged, and its summary says the version
     needs approval.
5. **Approve** the staged version with 2FA, as a maintainer on the `speedle`
   organization:
   - npmjs.com → `@speedle/mcp` → **Staged Packages** → approve `X.Y.Z`, or
   - `npm stage approve <stage-id>` from a machine where you can enter the
     one-time password.

   The publish log prints the stage id (`staged with id ...`);
   `npm stage list @speedle/mcp` lists it as well. Staged content is not public
   before approval, and approval cannot be completed without 2FA.

6. **Check** the npm page linked from the `release` environment in the run.

For the first release (`0.2.0`), npm shows the public placeholder
`0.0.0-stage` as soon as the publish job finishes. Do not announce the package
in that window: `npm install @speedle/mcp` may resolve to the placeholder or
fail until `0.2.0` is approved.

If the publish job fails before anything was staged (for example, a missing
secret), fix the cause and use "Re-run failed jobs". Never move or reuse a tag
that was created. A staged version that must not ship can be rejected with
`npm stage reject <stage-id>` before approval. Once approved, npm does not
allow a version to be replaced: to fix a bad release, release the next patch
version and deprecate the bad one with
`npm deprecate @speedle/mcp@X.Y.Z "..."`.

## Owner setup on GitHub

Repository `teramoby/speedle-mcp`, Settings:

1. **Environment** (Environments → New environment), name **`release`**:
   - Do not configure required reviewers. The owner decided on 2026-11-05 that
     releases require no human approval in GitHub.
   - Clear "Allow administrators to bypass configured protection rules".
   - Deployment branches and tags: "Selected branches and tags", with one rule
     of type **Tag**: `v*`.
   - Environment secret `NPM_STAGE_TOKEN` while the first release runs
     (below).
2. **Tag ruleset** (Rules → Rulesets → New tag ruleset), enforcement Active,
   bypass list Repository admin, name `release tags`:
   - Target `v*`.
   - Enable Restrict creations, Restrict updates and Restrict deletions.

The workflow's `preflight` job queries
`GET /repos/teramoby/speedle-mcp/environments/release` with `actions: read` and
fails before verification if the environment is absent or unreadable. It does
not prove the deployment-ref or tag-ruleset settings, so the owner must
complete the setup above before the first release.

## npm: `@speedle/mcp`

Prerequisite: the npm organization `speedle` on an account with 2FA. npm can
only configure a trusted publisher for a package that already exists, so the
first release uses a stage-only granular access token. That token may create
the package and stage its first version, but it cannot publish directly and
does not need to bypass 2FA.

1. **First release only: create the stage-only token.** On npmjs.com, Access
   Tokens → Generate New Token → Granular Access Token:
   - **Packages and scopes**: **All Packages**, or the `@speedle` scope. An
     organization-only permission does not allow publishing.
   - Permission: **Read and write (stage only)**.
   - Do **not** check **Bypass two-factor authentication**. Staging never asks
     for a one-time password, so the token does not need it.
   - Use the shortest expiry.

   Store it as the `release` environment secret:

   ```sh
   gh secret set NPM_STAGE_TOKEN --env release --repo teramoby/speedle-mcp
   ```

   Then cut `v0.2.0`. The workflow stages it, and the package does not exist on
   npm until that run succeeds.

2. **Approve the staged version with 2FA.** Follow the approve step above
   ("Cutting a release", step 5). This is the first successful publish, and it
   creates the package and the real `0.2.0` version.

3. **Right after the first version is approved (within 48 hours), configure
   trusted publishing and delete the token.**

   ```sh
   npm trust github @speedle/mcp --file release.yml \
     --repo teramoby/speedle-mcp --env release --allow-stage-publish
   gh secret delete NPM_STAGE_TOKEN --env release --repo teramoby/speedle-mcp
   ```

   `--allow-stage-publish` grants only `npm stage publish`; it does not allow a
   direct `npm publish`. `--env release` ties the trust configuration to the
   workflow's `release` environment.

   A new trusted publisher configuration is unvalidated and stops authorizing
   publishing 48 hours after creation unless a publish through it succeeds.
   Changing the repository or workflow identity starts a new window; ordinary
   edits do not. Plan the next release inside that window; if the configuration
   expires, recreate it before cutting the release.

   The workflow enforces the token deletion: while `NPM_STAGE_TOKEN` is set,
   the publish job checks `https://registry.npmjs.org/@speedle%2fmcp`
   (read-only, no token) and fails if the package already exists, or if the
   check gets any answer other than 404. A lingering token therefore blocks
   the release instead of silently replacing trusted publishing.

4. **Later releases** use trusted publishing. npm authenticates through OIDC,
   the workflow stages with `npm stage publish`, and a maintainer still approves
   with 2FA, so every release keeps a human check before it goes live.

5. **To switch later releases to direct `npm publish`** (no staging, no 2FA
   approval), add the direct publish permission to the trusted publisher:
   npmjs.com → `@speedle/mcp` → Settings → Trusted publishing → edit the GitHub
   Actions configuration → allow **`npm publish`** as well as staged
   publishing. For a fresh configuration, the CLI equivalent is
   `npm trust github ... --allow-publish --allow-stage-publish`.

   Then change the trusted-publishing step from `npm stage publish` to a direct
   `npm publish` in `.github/workflows/release.yml`. Without the direct publish
   permission, npm rejects an OIDC `npm publish`. The first-release token step
   is not affected, since the token is deleted before any later release. This
   removes the human approval from the release path, so it is a policy change,
   not a routine one.

6. **After the first trusted-publishing release succeeds:** Settings →
   Publishing access → "Require two-factor authentication and disallow tokens".
   Stage-only tokens are then no longer usable, which is the intended end
   state.

With trusted publishing, npm authenticates through OIDC and adds provenance
attestations. The workflow always passes `--access public`, so the scoped
package is public from its first version.

Staged publishing needs npm 11.15.0 or later (the workflow checks this; Node 24
bundles a recent npm) and Node 22.14.0 or later (the workflow uses Node 24).
