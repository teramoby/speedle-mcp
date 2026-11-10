# Releasing

`@speedle/mcp` is published only by `.github/workflows/release.yml`, from a tag
on a commit of `main`, with `npm publish --provenance --access public` through
npm trusted publishing. The same workflow then publishes `server.json` to the
MCP Registry. Never upload the package, or the registry entry, by hand.

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
4. **publish**: runs in the GitHub environment `release`. It downloads the
   tarball built in step 3 and publishes it with
   `npm publish --provenance --access public`. This is the only job with
   `id-token: write`. npm authenticates that job through GitHub OIDC (trusted
   publishing). The job does not use an npm token.

   Before it publishes, the job fails if the `release` environment has
   `NPM_STAGE_TOKEN` or `NPM_BOOTSTRAP_TOKEN` set. Those secrets stay unset so
   a token cannot replace trusted publishing.

   After the npm publish succeeds, the same job checks out `server.json` and
   publishes it to the MCP Registry. It installs `mcp-publisher` v1.8.1,
   verifies the release archive with cosign, then runs
   `mcp-publisher login github-oidc` and `mcp-publisher publish`. GitHub OIDC
   grants this repository `io.github.teramoby/*`, so the server name is
   `io.github.teramoby/speedle-mcp`. No registry secret and no DNS change are
   required. If that version is already on npm, the npm publish is skipped and
   the registry publish still runs, so a failed registry step can be retried
   with "Re-run failed jobs". The published `@speedle/mcp@0.2.1` package has
   no `mcpName`, and the registry rejects an npm package without it, so
   `0.2.1` is not registered. The first tag that contains `mcpName` registers
   that tag's version.

The `release` environment has no required reviewers. A pushed tag runs the
checks and publishes the version. The version is installable when the publish
job succeeds.

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
   | `server.json` `version`                    | edit by hand                                                                              |
   | `server.json` `packages[].version`         | edit by hand; every package entry                                                         |

   `package.json` `mcpName` must equal `server.json` `name`
   (`io.github.teramoby/speedle-mcp`). The release check fails if they differ.

   To check locally: `node scripts/release-version.mjs vX.Y.Z`.

2. **Merge** the PR and wait until the `ci` workflow is green on `main`.
3. **Tag** the merge commit and push only that tag:

   ```sh
   git fetch origin
   git tag -a vX.Y.Z -m "X.Y.Z" <merge-commit-sha>
   git push origin vX.Y.Z
   ```

4. **Watch** the run (Actions → release). The publish job starts after the
   checks pass. Confirm that:
   - the run is for the requested tag and the expected `main` commit;
   - `preflight` passed, `verify` printed `... is on main` and an `ok:` line for
     every version source, and `build` is green;
   - `publish` reports the tarball it published, with provenance, then publishes
     `io.github.teramoby/speedle-mcp` to the MCP Registry.
5. **Check** the registry. The npm page is linked from the `release`
   environment in the run. From any machine that can reach the registry:

   ```sh
   npm view @speedle/mcp@X.Y.Z version dist.integrity dist.attestations
   ```

   `version` is `X.Y.Z`. `dist.integrity` is the tarball integrity.
   `dist.attestations` is present when provenance was published.

   The MCP Registry entry for that version:

   ```sh
   curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.teramoby/speedle-mcp"
   ```

If the publish job fails before the version is on npm, fix the cause and use
"Re-run failed jobs". If it fails after the version is on npm, re-run the
failed publish job: npm publish is skipped for a version already on npm, and
the MCP Registry publish runs again. Never move or reuse a tag that was
created. Once published, npm does not allow a version to be replaced: to fix a
bad release, release the next patch version and deprecate the bad one with
`npm deprecate @speedle/mcp@X.Y.Z "..."`.

## Owner setup on GitHub

Repository `teramoby/speedle-mcp`, Settings:

1. **Environment** (Environments → New environment), name **`release`**:
   - Do not configure required reviewers. A pushed tag publishes with no GitHub
     reviewer.
   - Clear "Allow administrators to bypass configured protection rules".
   - Deployment branches and tags: "Selected branches and tags", with one rule
     of type **Tag**: `v*`.
   - No npm token secrets. The workflow fails if either secret below is set.

     | Secret                | Environment | State                                  |
     | --------------------- | ----------- | -------------------------------------- |
     | `NPM_STAGE_TOKEN`     | `release`   | unset; the workflow fails if it is set |
     | `NPM_BOOTSTRAP_TOKEN` | `release`   | unset; the workflow fails if it is set |

     If either secret is still present:

     ```sh
     gh secret delete NPM_STAGE_TOKEN --env release --repo teramoby/speedle-mcp
     gh secret delete NPM_BOOTSTRAP_TOKEN --env release --repo teramoby/speedle-mcp
     ```

2. **Tag ruleset** (Rules → Rulesets → New tag ruleset), enforcement Active,
   bypass list Repository admin, name `release tags`:
   - Target `v*`.
   - Enable Restrict creations, Restrict updates and Restrict deletions.

The workflow's `preflight` job queries
`GET /repos/teramoby/speedle-mcp/environments/release` with `actions: read` and
fails before verification if the environment is absent or unreadable. It does
not prove the deployment-ref or tag-ruleset settings, so complete the setup
above before cutting a release.

## npm: `@speedle/mcp`

The publish job authenticates with trusted publishing. npm accepts the job's
GitHub OIDC token for the workflow file `release.yml` in
`teramoby/speedle-mcp`, environment `release`. The workflow publishes with:

```sh
npm publish --provenance --access public
```

It passes those flags on the packed tarball
(`./dist/speedle-mcp-$VERSION.tgz`), plus `--ignore-scripts` and
`--registry https://registry.npmjs.org/`. It does not run `npm stage publish`,
and it does not read an npm token. `--provenance` asks npm to attach a
provenance attestation. `--access public` keeps the scoped package public.

Trusted publishing needs npm CLI 11.5.1 or later and Node.js 22.14.0 or later
([npm: trusted publishers](https://docs.npmjs.com/trusted-publishers)). The
workflow uses Node 24 and fails if `npm --version` is older than 11.5.1.

Create or recreate the trusted publisher with:

```sh
npm trust github @speedle/mcp --file release.yml \
  --repo teramoby/speedle-mcp --env release \
  --allow-publish --allow-stage-publish
```

`--allow-publish` is what this workflow uses. `--allow-stage-publish` is part
of the same publisher record; the workflow does not call `npm stage publish`.

A new trusted-publisher configuration expires if a publish does not validate it
within 48 hours of creation. Changing the repository or the workflow identity
starts a new window; ordinary edits do not. If the configuration expires,
recreate it with the command above before cutting the release.

After the publish job succeeds, verify the release:

```sh
npm view @speedle/mcp@X.Y.Z version dist.integrity dist.attestations
```

On the package, set Publishing access to "Require two-factor authentication
and disallow tokens" (npmjs.com → `@speedle/mcp` → Settings → Publishing
access). Granular access tokens then cannot publish. The workflow still fails
the release if `NPM_STAGE_TOKEN` or `NPM_BOOTSTRAP_TOKEN` is set.
