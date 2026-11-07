# Releasing

`@speedle/mcp` is released only by `.github/workflows/release.yml`, from a tag
on a commit of `main`. Never publish the package by hand.

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
   approval, downloads the tarball built in step 3 and publishes it with
   `npm publish --provenance --access public`. This is the only job with
   `id-token: write`.

Releases require no human approval (owner decision, 2026-11-05). Only
repository admins may push a release tag: the tag ruleset restricts `v*` tag
creation, updates and deletions to admins, and the `release` environment
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
   - `publish` reports the tarball it uploaded.
5. **Check** the npm page linked from the `release` environment in the run.

If the publish job fails before anything was uploaded (for example, a missing
secret), fix the cause and use "Re-run failed jobs". Never move or reuse a tag
that was created. npm does not allow a version to be replaced: to fix a bad
release, release the next patch version and deprecate the bad one with
`npm deprecate @speedle/mcp@X.Y.Z "..."`.

## Owner setup on GitHub

Repository `teramoby/speedle-mcp`, Settings:

1. **Environment** (Environments → New environment), name **`release`**:
   - Do not configure required reviewers. The owner decided on 2026-11-05 that
     releases require no human approval.
   - Clear "Allow administrators to bypass configured protection rules".
   - Deployment branches and tags: "Selected branches and tags", with one rule
     of type **Tag**: `v*`.
   - Environment secret `NPM_BOOTSTRAP_TOKEN` while the first release runs
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
only add a trusted publisher to a package that exists, so the first release
uses a bootstrap token.

1. **First release only.** On npmjs.com, Access Tokens → Generate New Token →
   Granular Access Token, with **Bypass two-factor authentication** checked,
   permission **Read and write** for packages and scopes, limited to the scope
   `@speedle` (organization `speedle`), and the shortest expiry. Store it as
   the `release` environment secret:

   ```sh
   gh secret set NPM_BOOTSTRAP_TOKEN --env release --repo teramoby/speedle-mcp
   ```

   Then cut `v0.2.0`. The workflow still publishes with `--provenance`.
   The `speedle` organization enforces 2FA, so a token without Bypass 2FA
   makes `npm publish` fail with `EOTP` (npm asks for a one-time password,
   which CI cannot give). Regenerate the token with Bypass 2FA and rerun.
   Bypass-2FA tokens are being phased out for direct publishing: per the
   [GitHub Changelog of 2026-07-08](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/),
   "2FA-bypass tokens will no longer publish directly", expected around
   January 2027. From then on such a token can only read private packages and
   stage a publish that goes public after a human 2FA approval, so this
   bootstrap step will no longer work as written. Trusted publishing (step 3)
   is the long-term path.

2. **Right after that release:** delete the `NPM_BOOTSTRAP_TOKEN` secret and
   revoke the token on npmjs.com. The workflow enforces this: when
   `NPM_BOOTSTRAP_TOKEN` is set, the publish job first checks
   `https://registry.npmjs.org/@speedle%2fmcp` (read-only, no token) and fails
   with "delete the bootstrap secret" if the package already exists, or if the
   check gets any answer other than 404. A lingering token therefore blocks
   the release instead of silently replacing trusted publishing.
3. **On the day of the next release** (a new configuration expires if it has no
   successful publish within 2 days), open `@speedle/mcp` → Settings →
   Trusted publishing → GitHub Actions and enter:
   - Organization or user: `teramoby`
   - Repository: `speedle-mcp`
   - Workflow filename: `release.yml`
   - Environment name: `release`
   - Allowed actions: allow **`npm publish`** (the workflow does not use
     `npm stage publish`).
4. **After that release succeeds:** Settings → Publishing access → "Require
   two-factor authentication and disallow tokens".

With trusted publishing, npm authenticates through OIDC and adds provenance
attestations. The workflow itself always passes `--access public`, so the
scoped package is public from its first version.
