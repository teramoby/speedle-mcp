// Check that a release tag matches the package metadata.
//
// Usage: node scripts/release-version.mjs TAG
//
// TAG is `vX.Y.Z`, for example `v0.1.0`. The script prints `version=X.Y.Z`
// (for $GITHUB_OUTPUT) and exits non-zero when the tag is malformed, any
// version source differs from X.Y.Z, or package.json mcpName differs from
// server.json name. Run it from the repository root.

import { readFileSync } from "node:fs";

const TAG = /^v((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$/;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function regex(path, pattern) {
  const match = pattern.exec(readFileSync(path, "utf8"));
  return match ? match[1] : `<no version found by ${pattern}>`;
}

function serverSources(server) {
  const found = {
    "server.json version": typeof server.version === "string" ? server.version : "<missing>",
  };
  if (!Array.isArray(server.packages) || server.packages.length === 0) {
    found["server.json packages"] = "<no packages>";
    return found;
  }
  for (const [index, entry] of server.packages.entries()) {
    found[`server.json packages[${index}].version`] =
      entry && typeof entry.version === "string" ? entry.version : "<missing>";
  }
  return found;
}

function sources() {
  const pkg = readJson("package.json");
  const lock = readJson("package-lock.json");
  const server = readJson("server.json");
  return {
    versions: {
      "package.json version": pkg.version,
      "package-lock.json version": lock.version,
      'package-lock.json packages[""].version': lock.packages?.[""]?.version,
      "src/version.ts VERSION": regex("src/version.ts", /^export const VERSION = "([^"]+)";$/m),
      ...serverSources(server),
    },
    mcpName: typeof pkg.mcpName === "string" ? pkg.mcpName : "<missing>",
    serverName: typeof server.name === "string" ? server.name : "<missing>",
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
  const { versions, mcpName, serverName } = sources();
  let mismatches = 0;
  for (const [source, found] of Object.entries(versions)) {
    const ok = found === version;
    if (!ok) mismatches += 1;
    console.error(`${ok ? "ok" : "MISMATCH"}: ${source} = ${found}`);
  }
  const nameOk = mcpName === serverName;
  if (!nameOk) mismatches += 1;
  console.error(`${nameOk ? "ok" : "MISMATCH"}: package.json mcpName = ${mcpName}; server.json name = ${serverName}`);
  if (mismatches > 0) {
    console.error(`error: ${mismatches} release check(s) failed for tag version ${version}`);
    return 1;
  }
  console.log(`version=${version}`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
