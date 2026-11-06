import assert from "node:assert/strict";
import { resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CHECK_TOOL_NAMES, createCheckServer } from "../src/check/server.js";
import { runCli } from "../src/cli.js";
import { Auth, loadPmsConfig, withTestingSeams } from "../src/core/index.js";
import { PmsClient } from "../src/manage/client.js";
import {
  createManageServer,
  MANAGE_READ_TOOL_NAMES,
  MANAGE_TOOL_NAMES,
  MANAGE_WRITE_TOOL_NAMES,
} from "../src/manage/server.js";
import { build, type Reply, startServer, testCerts, TOKEN, VirtualClock } from "./helpers.js";

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

function pms(endpoint: string, auth = Auth.none()): PmsClient {
  return withTestingSeams(
    new VirtualClock(),
    () => 1,
    () => new PmsClient({ endpoint, auth, caCert: endpoint.startsWith("https:") ? testCerts().ca : undefined }),
  );
}

async function connect(client: PmsClient, readOnly = false): Promise<{ mcp: Client; close: () => Promise<void> }> {
  const server = createManageServer(client, { readOnly });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcp = new Client({ name: "manage-test", version: "1.0.0" });
  await mcp.connect(clientTransport);
  return {
    mcp,
    close: async () => {
      await mcp.close();
      await server.close();
      await client.close();
    },
  };
}

function text(result: ToolResult): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content;
  assert.ok(Array.isArray(content) && typeof content[0]?.text === "string");
  return content[0].text;
}

function json(result: ToolResult): Record<string, unknown> {
  return JSON.parse(text(result)) as Record<string, unknown>;
}

test("security: manage mode registers only management tools and no check tools", async () => {
  const { mcp, close } = await connect(pms("http://127.0.0.1:6733"));
  after(() => close());
  const { tools } = await mcp.listTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    [...MANAGE_TOOL_NAMES],
  );
  for (const tool of tools) {
    assert.ok(!(CHECK_TOOL_NAMES as readonly string[]).includes(tool.name), `check tool in manage: ${tool.name}`);
  }
});

test("security: check mode registers no management tools", async () => {
  const { client } = build("http://127.0.0.1:6734");
  const server = createCheckServer(client);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const mcp = new Client({ name: "check-test", version: "1.0.0" });
  await mcp.connect(a);
  after(async () => {
    await mcp.close();
    await server.close();
    await client.close();
  });
  const { tools } = await mcp.listTools();
  for (const tool of tools) {
    assert.ok(!(MANAGE_TOOL_NAMES as readonly string[]).includes(tool.name), `manage tool in check: ${tool.name}`);
  }
});

test("security: read-only manage registers only read tools, all annotated read-only", async () => {
  const { mcp, close } = await connect(pms("http://127.0.0.1:6733"), true);
  after(() => close());
  const { tools } = await mcp.listTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    [...MANAGE_READ_TOOL_NAMES],
  );
  for (const tool of tools) {
    assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
    assert.equal(tool.annotations?.destructiveHint, false, tool.name);
  }
});

test("security: --read-only and SPEEDLE_PMS_READ_ONLY register only read tools over stdio", async () => {
  const cliPath = resolve(fileURLToPath(new URL("../src/cli.js", import.meta.url)));
  const runs: { args: string[]; env: Record<string, string>; expected: readonly string[] }[] = [
    { args: ["manage"], env: {}, expected: MANAGE_TOOL_NAMES },
    { args: ["manage", "--read-only"], env: {}, expected: MANAGE_READ_TOOL_NAMES },
    { args: ["manage"], env: { SPEEDLE_PMS_READ_ONLY: "true" }, expected: MANAGE_READ_TOOL_NAMES },
  ];
  for (const run of runs) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath, ...run.args],
      env: { PATH: process.env.PATH ?? "", SPEEDLE_PMS_ENDPOINT: "http://127.0.0.1:6733", ...run.env },
      stderr: "pipe",
    });
    const mcp = new Client({ name: "stdio-test", version: "1.0.0" });
    try {
      await mcp.connect(transport);
      const { tools } = await mcp.listTools();
      assert.deepEqual(
        tools.map((t) => t.name),
        [...run.expected],
        JSON.stringify(run),
      );
    } finally {
      await mcp.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    }
  }
  assert.equal(loadPmsConfig({ SPEEDLE_PMS_ENDPOINT: "http://127.0.0.1:6733" }).readOnly, false);
  assert.equal(
    loadPmsConfig({ SPEEDLE_PMS_ENDPOINT: "http://127.0.0.1:6733", SPEEDLE_PMS_READ_ONLY: "1" }).readOnly,
    true,
  );
  assert.throws(() => loadPmsConfig({ SPEEDLE_PMS_ENDPOINT: "http://127.0.0.1:6733", SPEEDLE_PMS_READ_ONLY: "yes" }));
});

test("security: manage reads only PMS configuration", () => {
  assert.throws(
    () => loadPmsConfig({ SPEEDLE_ENDPOINT: "http://127.0.0.1:6734", SPEEDLE_SERVICE_NAME: "books" }),
    /SPEEDLE_PMS_ENDPOINT is required/,
  );
});

test("security: write tools are annotated; deletes are destructive and require confirm", async () => {
  const { mcp, close } = await connect(pms("http://127.0.0.1:6733"));
  after(() => close());
  const { tools } = await mcp.listTools();
  for (const tool of tools) {
    const isWrite = (MANAGE_WRITE_TOOL_NAMES as readonly string[]).includes(tool.name);
    assert.equal(tool.annotations?.readOnlyHint, !isWrite, tool.name);
    const isDelete = tool.name.startsWith("delete_");
    assert.equal(tool.annotations?.destructiveHint, isDelete, tool.name);
    if (isDelete) {
      const schema = tool.inputSchema as { required?: string[] };
      assert.ok(schema.required?.includes("confirm"), `${tool.name} must require confirm`);
    }
    if (isWrite) assert.match(tool.description ?? "", /changes live authorization policies/);
  }
});

test("security: a delete without the matching confirmation makes no HTTP call", async () => {
  const server = await startServer(() => ({ status: 204 }));
  after(() => server.close());
  const { mcp, close } = await connect(pms(server.url));
  after(() => close());

  const calls: [string, Record<string, unknown>][] = [
    ["delete_service", { serviceName: "books", confirm: "book" }],
    ["delete_service", { serviceName: "books", confirm: "BOOKS" }],
    ["delete_service", { serviceName: "books", confirm: "" }],
    ["delete_service", { serviceName: "books" }],
    ["delete_policy", { serviceName: "books", policyId: "p1", confirm: "books" }],
    ["delete_policy", { serviceName: "books", policyId: "p1" }],
    ["delete_role_policy", { serviceName: "books", rolePolicyId: "rp1", confirm: "rp2" }],
    ["delete_role_policy", { serviceName: "books", rolePolicyId: "rp1" }],
  ];
  for (const [name, args] of calls) {
    const res = await mcp.callTool({ name, arguments: args });
    assert.equal(res.isError, true, `${name} ${JSON.stringify(args)} must fail`);
  }
  assert.equal(server.requests.length, 0);
});

test("delete tools with confirmation return what was deleted", async () => {
  const policy = {
    id: "p1",
    name: "readers",
    effect: "grant",
    principals: [["role:reader"]],
    permissions: [{ resource: "/books", actions: ["get"] }],
  };
  const rolePolicy = {
    id: "rp1",
    name: "alice-reader",
    effect: "grant",
    principals: ["user:alice"],
    roles: ["reader"],
  };
  const service = { name: "books", type: "application", policies: [policy], rolePolicies: [rolePolicy] };
  const server = await startServer([
    { status: 200, body: policy },
    { status: 204 },
    { status: 200, body: rolePolicy },
    { status: 204 },
    { status: 200, body: service },
    { status: 204 },
  ]);
  after(() => server.close());
  const { mcp, close } = await connect(pms(server.url));
  after(() => close());

  const p = json(
    await mcp.callTool({
      name: "delete_policy",
      arguments: { serviceName: "books", policyId: "p1", confirm: "p1" },
    }),
  );
  assert.equal(p.changed, "deleted");
  assert.equal((p.policy as { spdl: string }).spdl, "grant role reader get /books");

  const rp = json(
    await mcp.callTool({
      name: "delete_role_policy",
      arguments: { serviceName: "books", rolePolicyId: "rp1", confirm: "rp1" },
    }),
  );
  assert.equal((rp.rolePolicy as { spdl: string }).spdl, "grant user alice reader");

  const s = json(await mcp.callTool({ name: "delete_service", arguments: { serviceName: "books", confirm: "books" } }));
  assert.deepEqual([s.changed, s.deletedPolicies, s.deletedRolePolicies], ["deleted", 1, 1]);

  assert.deepEqual(
    server.requests.map((r) => `${r.method} ${r.path}`),
    [
      "GET /policy-mgmt/v1/service/books/policy/p1",
      "DELETE /policy-mgmt/v1/service/books/policy/p1",
      "GET /policy-mgmt/v1/service/books/role-policy/rp1",
      "DELETE /policy-mgmt/v1/service/books/role-policy/rp1",
      "GET /policy-mgmt/v1/service/books",
      "DELETE /policy-mgmt/v1/service/books",
    ],
  );
});

test("create tools send the PMS body, return what changed, and are not retried", async () => {
  const server = await startServer((req, i) => {
    if (i === 0) return { status: 201, body: { name: "books", type: "application" } };
    if (i === 1) return { status: 201, body: { id: "p9", ...(JSON.parse(req.body) as object) } };
    if (i === 2) return { status: 201, body: { id: "rp9", ...(JSON.parse(req.body) as object) } };
    return { status: 503, body: { error: "unavailable" } };
  });
  after(() => server.close());
  const { mcp, close } = await connect(pms(server.url));
  after(() => close());

  const s = json(await mcp.callTool({ name: "create_service", arguments: { name: "books" } }));
  assert.deepEqual(s, { changed: "created", kind: "service", service: { name: "books", type: "application" } });

  const p = json(
    await mcp.callTool({
      name: "create_policy",
      arguments: { serviceName: "books", name: "readers", spdl: "grant role reader get /books/* if hour < 18" },
    }),
  );
  assert.equal(p.changed, "created");
  assert.equal((p.policy as { id: string }).id, "p9");
  assert.equal((p.policy as { spdl: string }).spdl, "grant role reader get /books/* if hour < 18");

  const rp = json(
    await mcp.callTool({
      name: "create_role_policy",
      arguments: {
        serviceName: "books",
        name: "alice-reader",
        rolePolicy: { effect: "grant", principals: ["user:alice"], roles: ["reader"] },
      },
    }),
  );
  assert.equal((rp.rolePolicy as { id: string }).id, "rp9");

  const failed = await mcp.callTool({
    name: "create_policy",
    arguments: { serviceName: "books", name: "x", spdl: "grant user a get /b" },
  });
  assert.equal(failed.isError, true);
  assert.equal(json(failed).status, 503);

  const both = await mcp.callTool({
    name: "create_policy",
    arguments: {
      serviceName: "books",
      name: "x",
      spdl: "grant user a get /b",
      policy: { effect: "grant", principals: [["user:a"]], permissions: [{ resource: "/b", actions: ["get"] }] },
    },
  });
  assert.equal(both.isError, true);
  const badSpdl = await mcp.callTool({
    name: "create_policy",
    arguments: { serviceName: "books", name: "x", spdl: "grant a get /b" },
  });
  assert.equal(badSpdl.isError, true);
  assert.match(json(badSpdl).message as string, /principal type/);

  assert.deepEqual(
    server.requests.map((r) => `${r.method} ${r.path}`),
    [
      "POST /policy-mgmt/v1/service",
      "POST /policy-mgmt/v1/service/books/policy",
      "POST /policy-mgmt/v1/service/books/role-policy",
      "POST /policy-mgmt/v1/service/books/policy",
    ],
  );
  assert.deepEqual(JSON.parse(server.requests[1]?.body ?? ""), {
    name: "readers",
    effect: "grant",
    principals: [["role:reader"]],
    permissions: [{ resource: "/books/*", actions: ["get"] }],
    condition: "hour < 18",
  });
});

test("read tools: list, get and effective policies", async () => {
  const policy = {
    id: "p1",
    name: "readers",
    effect: "grant",
    principals: [["role:reader"]],
    permissions: [{ resource: "/books", actions: ["get"] }],
  };
  const server = await startServer((req) => {
    if (req.path === "/policy-mgmt/v1/service") return { status: 200, body: [{ name: "books" }] };
    if (req.path === "/policy-mgmt/v1/service/books/policy") return { status: 200, body: [policy] };
    if (req.path === "/policy-mgmt/v1/service/books/role-policy") return { status: 200, body: [] };
    if (req.path === "/policy-mgmt/v1/service/books") {
      return { status: 200, body: { name: "books", type: "application", policies: [policy] } };
    }
    if (req.path === "/policy-mgmt/v1/service/global") return { status: 404, body: { error: "not found" } };
    return { status: 404, body: { error: "no such route" } };
  });
  after(() => server.close());
  const { mcp, close } = await connect(pms(server.url));
  after(() => close());

  assert.deepEqual(JSON.parse(text(await mcp.callTool({ name: "list_services", arguments: {} }))), [{ name: "books" }]);
  const listed = JSON.parse(
    text(await mcp.callTool({ name: "list_policies", arguments: { serviceName: "books" } })),
  ) as { spdl: string }[];
  assert.equal(listed[0]?.spdl, "grant role reader get /books");

  const eff = json(await mcp.callTool({ name: "show_effective_policies", arguments: { serviceName: "books" } }));
  assert.deepEqual(eff.counts, { policies: 1, rolePolicies: 0, globalRolePolicies: 0 });
  assert.equal(eff.globalServiceFound, false);

  const missing = await mcp.callTool({ name: "get_service", arguments: { serviceName: "nope" } });
  assert.equal(missing.isError, true);
  assert.equal(json(missing).status, 404);

  const before = server.requests.length;
  const bad = await mcp.callTool({ name: "get_service", arguments: { serviceName: "a/b" } });
  assert.equal(bad.isError, true);
  assert.equal(server.requests.length, before);
});

test("security: PMS credentials never appear in tool output, errors, inspect or CLI stderr", async () => {
  const replies: Reply[] = [
    { status: 200, body: [{ name: `svc-${TOKEN}` }] },
    { status: 401, body: { error: `rejected bearer ${TOKEN}` } },
    { status: 500, body: { error: `crash ${TOKEN}` } },
    { status: 400, body: { error: `bad ${TOKEN}` } },
  ];
  const server = await startServer(replies, { tls: true });
  after(() => server.close());
  const client = pms(server.url, Auth.bearer(TOKEN));
  const { mcp, close } = await connect(client);
  after(() => close());

  for (const repr of [String(client), inspect(client), JSON.stringify(client)]) {
    assert.ok(!repr.includes(TOKEN), repr);
  }
  const results = [
    await mcp.callTool({ name: "list_services", arguments: {} }),
    await mcp.callTool({ name: "get_service", arguments: { serviceName: "books" } }),
    await mcp.callTool({ name: "list_policies", arguments: { serviceName: "books" } }),
    await mcp.callTool({ name: "create_service", arguments: { name: "x" } }),
  ];
  for (const res of results) {
    const t = text(res);
    assert.ok(!t.includes(TOKEN), `token leaked: ${t}`);
    assert.ok(t.includes("<redacted>"), t);
  }
  assert.equal(server.requests[0]?.headers.authorization, `Bearer ${TOKEN}`);

  // Mutual TLS: the private key never appears either.
  const key = testCerts().clientKey;
  const mtlsServer = await startServer([{ status: 500, body: { error: `leak ${key}` } }], {
    tls: true,
    requestCert: true,
  });
  after(() => mtlsServer.close());
  const mtls = pms(mtlsServer.url, Auth.mutualTls({ cert: testCerts().clientCert, key }));
  const m = await connect(mtls);
  after(() => m.close());
  const leaked = text(await m.mcp.callTool({ name: "list_services", arguments: {} }));
  assert.ok(!leaked.includes(key) && !leaked.includes(key.split("\n")[1] ?? "x"), leaked);

  const stderr: string[] = [];
  const code = await runCli(
    ["manage"],
    { SPEEDLE_PMS_ENDPOINT: `http://127.0.0.1:6733/${TOKEN}`, SPEEDLE_PMS_TOKEN: TOKEN },
    (t) => stderr.push(t),
  );
  assert.equal(code, 1);
  assert.ok(stderr.join("").length > 0 && !stderr.join("").includes(TOKEN), stderr.join(""));
});

test("CLI: manage rejects unknown flags and check rejects --read-only", async () => {
  for (const argv of [
    ["manage", "--write"],
    ["manage", "--read-only", "x"],
    ["check", "--read-only"],
  ]) {
    const out: string[] = [];
    const code = await runCli(argv, {}, (t) => out.push(t));
    assert.notEqual(code, 0);
    assert.match(out.join(""), /Usage: speedle-mcp <mode>/);
  }
});
