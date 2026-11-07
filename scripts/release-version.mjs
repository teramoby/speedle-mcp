// Check that a release tag matches the package metadata.
//
// Usage: node scripts/release-version.mjs TAG
//
// TAG is `vX.Y.Z`, for example `v0.1.0`. The script prints `version=X.Y.Z`
// (for $GITHUB_OUTPUT) and exits non-zero when the tag is malformed or any
// version source differs from X.Y.Z. Run it from the repository root.

import { readFileSync } from "node:fs";

const TAG = /^v((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$/;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function regex(path, pattern) {
  const match = pattern.exec(readFileSync(path, "utf8"));
  return match ? match[1] : `<no version found by ${pattern}>`;
}

function sources() {
  const pkg = readJson("package.json");
  const lock = readJson("package-lock.json");
  return {
    "package.json version": pkg.version,
    "package-lock.json version": lock.version,
    'package-lock.json packages[""].version': lock.packages?.[""]?.version,
    "src/version.ts VERSION": regex("src/version.ts", /^export const VERSION = "([^"]+)";$/m),
  };
}

function main(argv) {
  if (argv.length !== 1) {
    console.error("usage: node scripts/release-version.mjs vX.Y.Z");
    return 2;
  }
  const match = TAG.exec(argv[0]);
  if (!match) {
    console.error(`error: tag ${JSON.stringify(argv[0])} is not vX.Y.Z`);
    return 1;
  }
  const version = match[1];
  let mismatches = 0;
  for (const [source, found] of Object.entries(sources())) {
    const ok = found === version;
    if (!ok) mismatches += 1;
    console.error(`${ok ? "ok" : "MISMATCH"}: ${source} = ${found}`);
  }
  if (mismatches > 0) {
    console.error(`error: ${mismatches} version source(s) differ from tag version ${version}`);
    return 1;
  }
  console.log(`version=${version}`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
