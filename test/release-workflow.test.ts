import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Static checks of .github/workflows/release.yml. They keep the release
// boundary that the workflow and RELEASING.md promise: a tag-only trigger, a
// secret-free build, SHA-pinned actions and a single trusted-publishing job.

const root = fileURLToPath(new URL("../..", import.meta.url));
const workflow = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");

function jobBlocks(): Map<string, string> {
  const jobsBody = workflow.slice(workflow.indexOf("\njobs:\n") + "\njobs:\n".length);
  const names = [...jobsBody.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)];
  const blocks = new Map<string, string>();
  for (const [index, match] of names.entries()) {
    const start = (match.index ?? 0) + match[0].length;
    const end = names[index + 1]?.index ?? jobsBody.length;
    blocks.set(match[1], jobsBody.slice(start, end));
  }
  return blocks;
}

test("release workflow runs only on pushed vX.Y.Z tags", () => {
  const trigger = workflow.slice(0, workflow.indexOf("\npermissions:"));
  assert.match(trigger, /^on:$/m);
  assert.match(trigger, /^ {2}push:$/m);
  assert.match(trigger, /^ {4}tags:$/m);
  assert.match(trigger, /^ {6}- ["']?v\[0-9]\+\.\[0-9]\+\.\[0-9\]\+["']?$/m);
  assert.doesNotMatch(trigger, /^ {2}(pull_request|pull_request_target|workflow_run|workflow_dispatch|schedule):/m);
});

test("release workflow has one job per stage in order", () => {
  assert.deepEqual([...jobBlocks().keys()], ["preflight", "verify", "build", "publish"]);
});

test("only the publish job has an OIDC token and the release environment", () => {
  const jobs = jobBlocks();
  for (const [name, block] of jobs) {
    assert.equal(/\bid-token:\s*write\b/.test(block), name === "publish", `${name}: id-token: write`);
    assert.match(block, /^ {4}runs-on: ubuntu-latest$/m, `${name}: runner`);
  }
  const publish = jobs.get("publish") ?? "";
  assert.match(publish, /^ {4}environment:\n {6}name: release$/m);
  assert.match(publish, /--provenance --access public --ignore-scripts/);
  assert.match(publish, /--registry https:\/\/registry\.npmjs\.org\//);
});

test("publish uses trusted publishing and fails if an npm token secret is set", () => {
  const publish = jobBlocks().get("publish") ?? "";
  const secrets = [...workflow.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(secrets)].sort(), ["NPM_BOOTSTRAP_TOKEN", "NPM_STAGE_TOKEN"]);
  assert.match(publish, /NPM_STAGE_TOKEN is set on the release environment/);
  assert.match(publish, /NPM_BOOTSTRAP_TOKEN is set on the release environment/);
  assert.match(publish, /exit "\$failed"/);
  assert.ok(publish.indexOf("Refuse npm token secrets") < publish.indexOf("name: npm publish"));
  assert.match(
    publish,
    /npm publish "\.\/dist\/speedle-mcp-\$VERSION\.tgz" --provenance --access public --ignore-scripts/,
  );
  assert.equal([...publish.matchAll(/npm publish "\.\/dist\/speedle-mcp-\$VERSION\.tgz"/g)].length, 1);
  assert.doesNotMatch(workflow, /npm stage/);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\./);
  assert.doesNotMatch(workflow, /first-release/);
  assert.doesNotMatch(workflow, /staged/i);
  assert.doesNotMatch(workflow, /approval required/i);
});

test("the publish job name and summary record a direct publish", () => {
  const publish = jobBlocks().get("publish") ?? "";
  assert.match(publish, /^ {4}name: Publish @speedle\/mcp on npm$/m);
  assert.match(publish, /GITHUB_STEP_SUMMARY/);
  assert.match(publish, /Published @speedle\/mcp@\$VERSION/);
  assert.match(publish, /npm view @speedle\/mcp@\$VERSION version dist\.integrity dist\.attestations/);
  assert.doesNotMatch(publish, /Staged Packages/);
  assert.doesNotMatch(publish, /npm stage approve/);
  assert.doesNotMatch(publish, /0\.0\.0-stage/);
});

test("publish requires npm 11.5.1 or later for trusted publishing", () => {
  const publish = jobBlocks().get("publish") ?? "";
  assert.match(publish, /npm supports trusted publishing \(11\.5\.1 or later\)/);
  assert.match(publish, /a === 11 && \(b > 5 \|\| \(b === 5 && c >= 1\)\)/);
});

test("release workflow pins every action by commit SHA", () => {
  const uses = [...workflow.matchAll(/^\s*(?:- )?uses:\s*(\S+)/gm)].map((match) => match[1]);
  assert.ok(uses.length >= 6, `expected at least 6 pinned actions, found ${uses.length}`);
  for (const action of uses) {
    assert.match(action, /^[^\s@]+@[0-9a-f]{40}$/, `action ${action} is not pinned by a full commit SHA`);
  }
});

test("release workflow uses GitHub-hosted runners and no caches", () => {
  const runsOn = [...workflow.matchAll(/^\s*runs-on:\s*(.+)$/gm)].map((match) => match[1].trim());
  assert.ok(runsOn.length >= 4);
  assert.deepEqual([...new Set(runsOn)], ["ubuntu-latest"]);
  assert.doesNotMatch(workflow, /actions\/cache@/);
  assert.doesNotMatch(workflow, /^\s*cache:\s*(npm|yarn|pnpm)\s*$/m);
});

test("build runs without secrets and the package is the only artifact", () => {
  const build = jobBlocks().get("build") ?? "";
  assert.doesNotMatch(build, /\$\{\{\s*secrets\./);
  assert.match(build, /^ {6}- run: npm ci$/m);
  assert.match(build, /^ {8}run: npm test$/m);
  assert.match(build, /^ {8}run: npm run test:package$/m);
  assert.match(build, /npm pack --ignore-scripts/);
  assert.equal([...workflow.matchAll(/uses:\s*actions\/upload-artifact@/g)].length, 1);
  assert.equal([...workflow.matchAll(/uses:\s*actions\/download-artifact@/g)].length, 1);
});

test("verify checks the commit is on main and the package metadata", () => {
  const verify = jobBlocks().get("verify") ?? "";
  assert.match(verify, /git merge-base --is-ancestor "\$GITHUB_SHA" refs\/remotes\/origin\/main/);
  assert.match(verify, /scripts\/release-version\.mjs "\$TAG"/);
  assert.match(verify, /^ {4}outputs:\n {6}version: \$\{\{ steps\.tag\.outputs\.version \}\}$/m);
});

function runReleaseVersion(...args: string[]) {
  return spawnSync(process.execPath, [join(root, "scripts", "release-version.mjs"), ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

test("release-version accepts only the current version as a plain vX.Y.Z tag", () => {
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  const accepted = runReleaseVersion(`v${version}`);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.stdout.trim(), `version=${version}`);

  const other = version === "0.0.0" ? "0.0.1" : "0.0.0";
  for (const tag of [version, `v${other}`, `v${version}.0`, `v${version}-rc.1`]) {
    assert.equal(runReleaseVersion(tag).status, 1, `tag ${tag} must be rejected`);
  }
  assert.equal(runReleaseVersion().status, 2);
});
