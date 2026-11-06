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
import { CHECK_TOOL_NAMES } from "../src/check/server.js";

const speedlePlusDir = process.env.SPEEDLE_PLUS_DIR;
const speedleAdsBin = process.env.SPEEDLE_ADS_BIN;

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
      throw new Error(`speedle-ads exited early (code ${proc.exitCode}):\n${getLogs()}`);
    }
    const status = await httpProbe(url);
    if (status !== 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for speedle-ads at ${url}:\n${getLogs()}`);
}

function toolText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content;
  assert.ok(Array.isArray(content) && content.length > 0 && typeof content[0]?.text === "string");
  return content[0].text;
}

test(
  "integration: check mode MCP server over stdio against a real Speedle+ ADS",
  {
    skip:
      !speedlePlusDir && !speedleAdsBin
        ? "set SPEEDLE_PLUS_DIR (or SPEEDLE_ADS_BIN) to run the local Speedle+ integration test"
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
        assert.ok(speedlePlusDir && existsSync(speedlePlusDir), `SPEEDLE_PLUS_DIR does not exist: ${speedlePlusDir}`);
        adsBin = join(workDir, "speedle-ads");
        execFileSync(
          "go",
          ["build", "-C", speedlePlusDir, "-mod=readonly", "-trimpath", "-o", adsBin, "./cmd/speedle-ads"],
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
        [...CHECK_TOOL_NAMES],
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
