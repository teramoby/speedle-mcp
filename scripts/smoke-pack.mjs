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

  const listTools = async (args, env) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [binPath, ...args],
      env: { PATH: process.env.PATH ?? "", ...env },
      stderr: "pipe",
    });
    const client = new Client({ name: "smoke-pack", version: "1.0.0" });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      return tools.map((t) => t.name);
    } finally {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    }
  };

  // 2. check mode over stdio: only is_allowed by default; all tools require explicit opt-ins.
  const checkEnv = { SPEEDLE_ENDPOINT: "http://127.0.0.1:6734", SPEEDLE_SERVICE_NAME: "books" };
  const allCheckTools = ["is_allowed", "diagnose", "all_granted_roles", "all_granted_permissions"];
  assert.deepEqual(await listTools(["check"], checkEnv), ["is_allowed"]);
  assert.deepEqual(
    await listTools(
      ["check", "--expose-diagnose", "--expose-all-granted-roles", "--expose-all-granted-permissions"],
      checkEnv,
    ),
    allCheckTools,
  );
  assert.deepEqual(
    await listTools(["check"], {
      ...checkEnv,
      SPEEDLE_EXPOSE_DIAGNOSE: "true",
      SPEEDLE_EXPOSE_ALL_GRANTED_ROLES: "true",
      SPEEDLE_EXPOSE_ALL_GRANTED_PERMISSIONS: "true",
    }),
    allCheckTools,
  );

  const cloudDiagnose = spawnSync(process.execPath, [binPath, "check", "--expose-diagnose"], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      SPEEDLE_ENDPOINT: "https://cloud.speedle.io",
      SPEEDLE_SERVICE_NAME: "books",
      SPEEDLE_TOKEN: "spdl_smoke_test_token",
      SPEEDLE_BACKEND: "speedle-cloud",
    },
  });
  assert.notEqual(cloudDiagnose.status, 0, "expected cloud diagnose configuration to be refused");
  assert.match(cloudDiagnose.stderr, /diagnose is not available with backend "speedle-cloud"/);

  // 3. manage mode over stdio: lists exactly the management tools; --read-only lists only the read tools.
  const readTools = [
    "list_services",
    "get_service",
    "list_policies",
    "get_policy",
    "list_role_policies",
    "get_role_policy",
    "show_effective_policies",
  ];
  const writeTools = [
    "create_service",
    "create_policy",
    "create_role_policy",
    "delete_service",
    "delete_policy",
    "delete_role_policy",
  ];
  const manageEnv = { SPEEDLE_PMS_ENDPOINT: "http://127.0.0.1:6733" };
  assert.deepEqual(await listTools(["manage"], manageEnv), [...readTools, ...writeTools]);
  assert.deepEqual(await listTools(["manage", "--read-only"], manageEnv), readTools);
  assert.deepEqual(await listTools(["manage"], { ...manageEnv, SPEEDLE_PMS_READ_ONLY: "true" }), readTools);

  console.log(
    `pack smoke ok: no-mode exited non-zero with usage; check listed only is_allowed by default and all 4 tools with flags or environment opt-ins; cloud diagnose was refused; manage listed the ${readTools.length + writeTools.length} management tools; manage --read-only and SPEEDLE_PMS_READ_ONLY listed only the ${readTools.length} read tools`,
  );
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
