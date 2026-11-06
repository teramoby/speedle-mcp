import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const workDir = mkdtempSync(join(tmpdir(), "speedle-mcp-pack-"));

try {
  const packOut = execFileSync("npm", ["pack", "--quiet", "--pack-destination", workDir], {
    encoding: "utf8",
  }).trim();
  const tarball = join(workDir, packOut.split(/\r?\n/).at(-1) ?? "");
  execFileSync("tar", ["-xzf", tarball, "-C", workDir]);
  symlinkSync(resolve("node_modules"), join(workDir, "package", "node_modules"), "dir");

  const binPath = join(workDir, "package", "dist", "cli.js");

  // 1. Smoke run with no mode: prints usage and exits non-zero.
  const noMode = spawnSync(process.execPath, [binPath], { encoding: "utf8" });
  assert.notEqual(noMode.status, 0, "expected non-zero exit when invoked with no mode");
  assert.match(noMode.stderr, /Usage: speedle-mcp <mode>/);

  // 2. Smoke run in check mode over stdio: lists the exact four check tools.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [binPath, "check"],
    env: {
      PATH: process.env.PATH ?? "",
      SPEEDLE_ENDPOINT: "http://127.0.0.1:6734",
      SPEEDLE_SERVICE_NAME: "books",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "smoke-pack", version: "1.0.0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      ["is_allowed", "diagnose", "all_granted_roles", "all_granted_permissions"],
    );
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }

  console.log("pack smoke ok: no-mode exited non-zero with usage; check mode listed the 4 check tools");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
