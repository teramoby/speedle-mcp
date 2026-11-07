import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CHECK_TOOL_NAMES, DEFAULT_CHECK_TOOL_NAMES } from "../src/check/server.js";
import { MANAGE_TOOL_NAMES } from "../src/manage/server.js";

const speedleDir = process.env.SPEEDLE_DIR;
const speedleAdsBin = process.env.SPEEDLE_ADS_BIN;
const speedlePmsBin = process.env.SPEEDLE_PMS_BIN;

function findFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolvePort(port)));
    });
    srv.on("error", reject);
  });
}

function httpProbe(url: string): Promise<number> {
  return new Promise((resolveStatus) => {
    const req = http.get(url, { timeout: 1000 }, (res) => {
      res.resume();
      resolveStatus(res.statusCode ?? 0);
    });
    req.on("error", () => resolveStatus(0));
    req.on("timeout", () => {
      req.destroy();
      resolveStatus(0);
    });
  });
}

async function waitForServer(url: string, proc: ChildProcess, getLogs: () => string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) {
      throw new Error(`server exited early (code ${proc.exitCode}):\n${getLogs()}`);
    }
    const status = await httpProbe(url);
    if (status !== 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for the server at ${url}:\n${getLogs()}`);
}

function toolText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content;
  assert.ok(Array.isArray(content) && content.length > 0 && typeof content[0]?.text === "string");
  return content[0].text;
}

test(
  "integration: check mode MCP server over stdio against a real Speedle ADS",
  {
    skip:
      !speedleDir && !speedleAdsBin
        ? "set SPEEDLE_DIR (or SPEEDLE_ADS_BIN) to run the local Speedle integration test"
        : false,
  },
  async () => {
    const workDir = mkdtempSync(join(tmpdir(), "speedle-mcp-it-"));
    let adsProc: ChildProcess | undefined;
    let mcpClient: Client | undefined;
    let transport: StdioClientTransport | undefined;

    try {
      let adsBin = speedleAdsBin;
      if (!adsBin) {
        assert.ok(speedleDir && existsSync(speedleDir), `SPEEDLE_DIR does not exist: ${speedleDir}`);
        adsBin = join(workDir, "speedle-ads");
        execFileSync(
          "go",
          ["build", "-C", speedleDir, "-mod=readonly", "-trimpath", "-o", adsBin, "./cmd/speedle-ads"],
          { stdio: "pipe" },
        );
      }

      const storePath = join(workDir, "store.json");
      writeFileSync(
        storePath,
        JSON.stringify(
          {
            services: [
              {
                name: "books",
                type: "application",
                rolePolicies: [
                  {
                    id: "rp1",
                    name: "alice-is-librarian",
                    effect: "grant",
                    roles: ["librarian"],
                    principals: ["user:alice"],
                    condition: "clearance >= 2",
                  },
                ],
                policies: [
                  {
                    id: "p1",
                    name: "librarian-can-read-and-write-books",
                    effect: "grant",
                    permissions: [
                      {
                        resource: "/books/123",
                        actions: ["get", "write"],
                      },
                    ],
                    principals: [["role:librarian"]],
                  },
                ],
              },
            ],
          },
          null,
          2,
        ),
      );

      const port = await findFreePort();
      const adsEndpoint = `http://127.0.0.1:${port}`;
      let adsLogs = "";
      adsProc = spawn(
        adsBin,
        [
          "--store-type",
          "file",
          "--filestore-loc",
          storePath,
          "--endpoint",
          `127.0.0.1:${port}`,
          "--grpc-endpoint",
          "127.0.0.1:0",
          "--insecure=true",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      adsProc.stdout?.on("data", (c: Buffer) => {
        adsLogs += c.toString("utf8");
      });
      adsProc.stderr?.on("data", (c: Buffer) => {
        adsLogs += c.toString("utf8");
      });

      await waitForServer(`${adsEndpoint}/`, adsProc, () => adsLogs);

      const cliPath = resolve(fileURLToPath(new URL("../src/cli.js", import.meta.url)));
      transport = new StdioClientTransport({
        command: process.execPath,
        args: [cliPath, "check"],
        env: {
          PATH: process.env.PATH ?? "",
          SPEEDLE_ENDPOINT: adsEndpoint,
          SPEEDLE_SERVICE_NAME: "books",
        },
        stderr: "pipe",
      });
      mcpClient = new Client({ name: "integration-test", version: "1.0.0" });
      await mcpClient.connect(transport);

      const { tools } = await mcpClient.listTools();
      assert.deepEqual(
        tools.map((t) => t.name),
        [...DEFAULT_CHECK_TOOL_NAMES],
      );

      // 1. is_allowed: allowed when clearance >= 2
      const allowedRes = await mcpClient.callTool({
        name: "is_allowed",
        arguments: {
          subject: "alice",
          resource: "/books/123",
          action: "get",
          attributes: [{ name: "clearance", type: "numeric", value: 3 }],
        },
      });
      assert.deepEqual(JSON.parse(toolText(allowedRes)), { allowed: true, reason: 0 });

      // 2. is_allowed: denied when clearance < 2
      const deniedRes = await mcpClient.callTool({
        name: "is_allowed",
        arguments: {
          subject: "alice",
          resource: "/books/123",
          action: "get",
          attributes: [{ name: "clearance", type: "numeric", value: 1 }],
        },
      });
      assert.deepEqual(JSON.parse(toolText(deniedRes)), { allowed: false, reason: 3 });

      await mcpClient.close();
      await transport.close();

      transport = new StdioClientTransport({
        command: process.execPath,
        args: [cliPath, "check", "--expose-diagnose", "--expose-all-granted-roles", "--expose-all-granted-permissions"],
        env: {
          PATH: process.env.PATH ?? "",
          SPEEDLE_ENDPOINT: adsEndpoint,
          SPEEDLE_SERVICE_NAME: "books",
        },
        stderr: "pipe",
      });
      mcpClient = new Client({ name: "integration-test-opt-in", version: "1.0.0" });
      await mcpClient.connect(transport);
      const optedIn = await mcpClient.listTools();
      assert.deepEqual(
        optedIn.tools.map((tool) => tool.name),
        [...CHECK_TOOL_NAMES],
      );

      // 3. diagnose
      const diagRes = await mcpClient.callTool({
        name: "diagnose",
        arguments: {
          subject: "alice",
          resource: "/books/123",
          action: "write",
          attributes: [{ name: "clearance", type: "numeric", value: 2 }],
        },
      });
      const diag = JSON.parse(toolText(diagRes)) as {
        allowed: boolean;
        reason: string;
        grantedRoles?: string[];
      };
      assert.equal(diag.allowed, true);
      assert.equal(diag.reason, "GRANT_POLICY_FOUND");
      assert.deepEqual(diag.grantedRoles, ["librarian"]);

      // 4. all_granted_roles
      const rolesRes = await mcpClient.callTool({
        name: "all_granted_roles",
        arguments: {
          subject: "alice",
          attributes: [{ name: "clearance", type: "numeric", value: 2 }],
        },
      });
      assert.deepEqual(JSON.parse(toolText(rolesRes)), ["librarian"]);

      // 5. all_granted_permissions
      const permsRes = await mcpClient.callTool({
        name: "all_granted_permissions",
        arguments: {
          subject: "alice",
          attributes: [{ name: "clearance", type: "numeric", value: 2 }],
        },
      });
      assert.deepEqual(JSON.parse(toolText(permsRes)), [{ resource: "/books/123", actions: ["get", "write"] }]);
    } finally {
      if (mcpClient) await mcpClient.close().catch(() => undefined);
      if (transport) await transport.close().catch(() => undefined);
      if (adsProc && adsProc.exitCode === null) {
        adsProc.kill("SIGTERM");
        await new Promise<void>((r) => {
          adsProc?.once("exit", () => r());
          setTimeout(() => {
            adsProc?.kill("SIGKILL");
            r();
          }, 2000);
        });
      }
      rmSync(workDir, { recursive: true, force: true });
    }
  },
);

test(
  "integration: manage mode MCP server over stdio against a real Speedle PMS",
  {
    skip:
      !speedleDir && !speedlePmsBin
        ? "set SPEEDLE_DIR (or SPEEDLE_PMS_BIN) to run the local Speedle integration test"
        : false,
  },
  async () => {
    const workDir = mkdtempSync(join(tmpdir(), "speedle-mcp-it-pms-"));
    let pmsProc: ChildProcess | undefined;
    let mcpClient: Client | undefined;
    let transport: StdioClientTransport | undefined;

    try {
      let pmsBin = speedlePmsBin;
      if (!pmsBin) {
        assert.ok(speedleDir && existsSync(speedleDir), `SPEEDLE_DIR does not exist: ${speedleDir}`);
        pmsBin = join(workDir, "speedle-pms");
        execFileSync(
          "go",
          ["build", "-C", speedleDir, "-mod=readonly", "-trimpath", "-o", pmsBin, "./cmd/speedle-pms"],
          { stdio: "pipe" },
        );
      }

      const storePath = join(workDir, "store.json");
      writeFileSync(storePath, JSON.stringify({ services: [] }));
      const port = await findFreePort();
      const pmsEndpoint = `http://127.0.0.1:${port}`;
      let pmsLogs = "";
      pmsProc = spawn(
        pmsBin,
        ["--store-type", "file", "--filestore-loc", storePath, "--endpoint", `127.0.0.1:${port}`, "--insecure=true"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      pmsProc.stdout?.on("data", (c: Buffer) => {
        pmsLogs += c.toString("utf8");
      });
      pmsProc.stderr?.on("data", (c: Buffer) => {
        pmsLogs += c.toString("utf8");
      });
      await waitForServer(`${pmsEndpoint}/policy-mgmt/v1/service`, pmsProc, () => pmsLogs);

      const cliPath = resolve(fileURLToPath(new URL("../src/cli.js", import.meta.url)));
      transport = new StdioClientTransport({
        command: process.execPath,
        args: [cliPath, "manage"],
        env: { PATH: process.env.PATH ?? "", SPEEDLE_PMS_ENDPOINT: pmsEndpoint },
        stderr: "pipe",
      });
      mcpClient = new Client({ name: "integration-test", version: "1.0.0" });
      await mcpClient.connect(transport);
      const mcp = mcpClient;
      const call = async (name: string, args: Record<string, unknown>) => {
        const res = await mcp.callTool({ name, arguments: args });
        return { isError: res.isError === true, body: JSON.parse(toolText(res)) as Record<string, unknown> };
      };

      const { tools } = await mcp.listTools();
      assert.deepEqual(
        tools.map((t) => t.name),
        [...MANAGE_TOOL_NAMES],
      );

      // 1. Create a service.
      const svc = await call("create_service", { name: "books" });
      assert.equal(svc.isError, false, JSON.stringify(svc.body));
      assert.equal(svc.body.changed, "created");

      // 2. Create a policy from SPDL and a role policy.
      const spdl = "grant role librarian get,write /books/123";
      const created = await call("create_policy", { serviceName: "books", name: "librarians", spdl });
      assert.equal(created.isError, false, JSON.stringify(created.body));
      const policy = created.body.policy as { id: string; spdl: string };
      assert.ok(typeof policy.id === "string" && policy.id !== "");
      assert.equal(policy.spdl, spdl);
      const role = await call("create_role_policy", {
        serviceName: "books",
        name: "alice-is-librarian",
        spdl: "grant user alice librarian if clearance >= 2",
      });
      assert.equal(role.isError, false, JSON.stringify(role.body));

      // PMS rejects an invalid condition at create time.
      const badCond = await call("create_policy", {
        serviceName: "books",
        name: "bad",
        spdl: "grant user bob get /x if clearance >>= 2",
      });
      assert.equal(badCond.isError, true);
      assert.equal(badCond.body.status, 400);

      // 3. List and show effective policies.
      const listed = await call("list_policies", { serviceName: "books" });
      assert.ok(Array.isArray(listed.body));
      assert.deepEqual(
        (listed.body as unknown as { id: string }[]).map((p) => p.id),
        [policy.id],
      );
      const eff = await call("show_effective_policies", { serviceName: "books" });
      assert.deepEqual(eff.body.counts, { policies: 1, rolePolicies: 1, globalRolePolicies: 0 });

      // 4. Delete with a wrong confirmation changes nothing; with the right one it deletes.
      const refused = await call("delete_policy", { serviceName: "books", policyId: policy.id, confirm: "books" });
      assert.equal(refused.isError, true);
      assert.equal(((await call("list_policies", { serviceName: "books" })).body as unknown as unknown[]).length, 1);
      const deleted = await call("delete_policy", { serviceName: "books", policyId: policy.id, confirm: policy.id });
      assert.equal(deleted.isError, false, JSON.stringify(deleted.body));
      assert.equal(deleted.body.changed, "deleted");
      assert.equal(((await call("list_policies", { serviceName: "books" })).body as unknown as unknown[]).length, 0);

      const svcDeleted = await call("delete_service", { serviceName: "books", confirm: "books" });
      assert.equal(svcDeleted.isError, false, JSON.stringify(svcDeleted.body));
      assert.equal(svcDeleted.body.deletedRolePolicies, 1);
      const gone = await call("get_service", { serviceName: "books" });
      assert.equal(gone.isError, true);
      assert.equal(gone.body.status, 404);
    } finally {
      if (mcpClient) await mcpClient.close().catch(() => undefined);
      if (transport) await transport.close().catch(() => undefined);
      if (pmsProc && pmsProc.exitCode === null) {
        pmsProc.kill("SIGTERM");
        await new Promise<void>((r) => {
          pmsProc?.once("exit", () => r());
          setTimeout(() => {
            pmsProc?.kill("SIGKILL");
            r();
          }, 2000);
        });
      }
      rmSync(workDir, { recursive: true, force: true });
    }
  },
);
