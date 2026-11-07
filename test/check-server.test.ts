import assert from "node:assert/strict";
import { after, test } from "node:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CHECK_TOOL_NAMES,
  type CheckServerOptions,
  createCheckServer,
  DEFAULT_CHECK_TOOL_NAMES,
} from "../src/check/server.js";
import { runCli } from "../src/cli.js";
import { Auth, loadAdsConfig, SpeedleClient } from "../src/core/index.js";
import { build, type Reply, startServer, TOKEN } from "./helpers.js";

const exposeAllTools = {
  exposeDiagnose: true,
  exposeAllGrantedRoles: true,
  exposeAllGrantedPermissions: true,
} as const;

async function connectMcp(
  speedleClient: SpeedleClient,
  options: CheckServerOptions = {},
): Promise<{
  mcpClient: Client;
  close(): Promise<void>;
}> {
  const mcpServer = createCheckServer(speedleClient, options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: "test-client", version: "1.0.0" });
  await mcpServer.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  return {
    mcpClient,
    close: async () => {
      await mcpClient.close();
      await mcpServer.close();
      await speedleClient.close();
    },
  };
}

function toolText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content;
  assert.ok(Array.isArray(content) && content.length > 0 && typeof content[0]?.text === "string");
  return content[0].text;
}

test("security: check mode registers only is_allowed by default", async () => {
  const { client } = build("http://127.0.0.1:6734");
  const { mcpClient, close } = await connectMcp(client);
  after(() => close());

  const { tools } = await mcpClient.listTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    [...DEFAULT_CHECK_TOOL_NAMES],
  );

  for (const tool of tools) {
    assert.ok(
      !/create|delete|update|manage|policy_create|service_create/i.test(tool.name),
      `unexpected management tool name: ${tool.name}`,
    );
    assert.ok(
      tool.description?.includes("answers authorization questions") &&
        tool.description?.includes("does not enforce anything"),
      `tool ${tool.name} description must state it answers questions and does not enforce anything: ${tool.description}`,
    );
    assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} must have readOnlyHint=true`);
    assert.equal(tool.annotations?.destructiveHint, false, `${tool.name} must have destructiveHint=false`);
  }
});

test("check server registers each additional tool only with its explicit opt-in", async () => {
  const cases: { options: CheckServerOptions; expected: readonly string[] }[] = [
    { options: { exposeDiagnose: true }, expected: ["is_allowed", "diagnose"] },
    { options: { exposeAllGrantedRoles: true }, expected: ["is_allowed", "all_granted_roles"] },
    { options: { exposeAllGrantedPermissions: true }, expected: ["is_allowed", "all_granted_permissions"] },
    { options: exposeAllTools, expected: CHECK_TOOL_NAMES },
  ];

  for (const { options, expected } of cases) {
    const { client } = build("http://127.0.0.1:6734");
    const { mcpClient, close } = await connectMcp(client, options);
    try {
      const { tools } = await mcpClient.listTools();
      assert.deepEqual(
        tools.map((tool) => tool.name),
        [...expected],
      );
    } finally {
      await close();
    }
  }
});

test("check server refuses diagnose on speedle-cloud but allows the other opt-ins", async () => {
  const cloud = build("https://cloud.speedle.io");
  try {
    assert.throws(
      () => createCheckServer(cloud.client, { exposeDiagnose: true }),
      /diagnose is not available with backend "speedle-cloud"/,
    );
  } finally {
    await cloud.client.close();
  }

  const otherTools = build("https://cloud.speedle.io");
  const { mcpClient, close } = await connectMcp(otherTools.client, {
    exposeAllGrantedRoles: true,
    exposeAllGrantedPermissions: true,
  });
  try {
    const { tools } = await mcpClient.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["is_allowed", "all_granted_roles", "all_granted_permissions"],
    );
  } finally {
    await close();
  }
});

test("security: serviceName comes from configuration and cannot be overridden by the tool caller", async () => {
  const server = await startServer([
    { status: 200, body: { allowed: true, reason: 0 } },
    { status: 200, body: { allowed: true, reason: "GRANT_POLICY_FOUND" } },
    { status: 200, body: ["admin"] },
    { status: 200, body: [{ resource: "/books", actions: ["get"] }] },
  ]);
  after(() => server.close());

  const { client } = build(server.url, { serviceName: "configured-service" });
  const { mcpClient, close } = await connectMcp(client, exposeAllTools);
  after(() => close());

  const { tools } = await mcpClient.listTools();
  for (const tool of tools) {
    const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    assert.equal("serviceName" in props, false, `${tool.name} must not expose serviceName in inputSchema`);
  }

  // Attempt to override serviceName in every tool call.
  await mcpClient.callTool({
    name: "is_allowed",
    arguments: { subject: "alice", resource: "/books/1", action: "get", serviceName: "attacker-service" },
  });
  await mcpClient.callTool({
    name: "diagnose",
    arguments: { subject: "alice", resource: "/books/1", action: "get", serviceName: "attacker-service" },
  });
  await mcpClient.callTool({
    name: "all_granted_roles",
    arguments: { subject: "alice", serviceName: "attacker-service" },
  });
  await mcpClient.callTool({
    name: "all_granted_permissions",
    arguments: { subject: "alice", serviceName: "attacker-service" },
  });

  assert.equal(server.requests.length, 4);
  for (const req of server.requests) {
    const parsed = JSON.parse(req.body) as { serviceName?: string };
    assert.equal(parsed.serviceName, "configured-service");
  }
});

test("security: the bearer token never appears in tool output, errors, inspect or CLI stderr", async () => {
  const replies: Reply[] = [
    { status: 200, body: { allowed: false, reason: 4, errorMessage: `eval error with ${TOKEN}` } },
    { status: 200, body: { allowed: false, reason: `DENY_${TOKEN}` } },
    { status: 200, body: [`role_${TOKEN}`] },
    { status: 200, body: [{ resource: `/res/${TOKEN}`, actions: [`act_${TOKEN}`] }] },
    { status: 401, body: { error: `rejected bearer ${TOKEN}` } },
    { status: 500, body: { error: `internal crash ${TOKEN}` } },
  ];
  const server = await startServer(replies, { tls: true });
  after(() => server.close());

  const { client, events } = build(server.url, { backend: "speedle", auth: Auth.bearer(TOKEN) });
  const { mcpClient, close } = await connectMcp(client, exposeAllTools);
  after(() => close());

  const auth = Auth.bearer(TOKEN);
  for (const repr of [String(auth), JSON.stringify(auth), inspect(auth), String(client), inspect(client)]) {
    assert.ok(!repr.includes(TOKEN), `token leaked in representation: ${repr}`);
  }

  const r1 = await mcpClient.callTool({
    name: "is_allowed",
    arguments: { subject: "alice", resource: "/r", action: "get" },
  });
  const r2 = await mcpClient.callTool({
    name: "diagnose",
    arguments: { subject: "alice", resource: "/r", action: "get" },
  });
  const r3 = await mcpClient.callTool({
    name: "all_granted_roles",
    arguments: { subject: "alice" },
  });
  const r4 = await mcpClient.callTool({
    name: "all_granted_permissions",
    arguments: { subject: "alice" },
  });
  const r5 = await mcpClient.callTool({
    name: "is_allowed",
    arguments: { subject: "alice", resource: "/r", action: "get" },
  });
  const r6 = await mcpClient.callTool({
    name: "diagnose",
    arguments: { subject: "alice", resource: "/r", action: "get" },
  });

  assert.equal(r5.isError, true);
  assert.equal(r6.isError, true);

  for (const res of [r1, r2, r3, r4, r5, r6]) {
    const text = toolText(res);
    assert.ok(!text.includes(TOKEN), `token leaked in tool output: ${text}`);
    assert.ok(text.includes("<redacted>"));
  }
  assert.ok(!JSON.stringify(events).includes(TOKEN));

  // Also check CLI error output when configuration fails with a token set.
  const stderrChunks: string[] = [];
  const code = await runCli(
    ["check"],
    {
      SPEEDLE_ENDPOINT: `http://127.0.0.1:6734/${TOKEN}`,
      SPEEDLE_SERVICE_NAME: "books",
      SPEEDLE_TOKEN: TOKEN,
    },
    (chunk) => stderrChunks.push(chunk),
  );
  assert.equal(code, 1);
  const stderrText = stderrChunks.join("");
  assert.ok(!stderrText.includes(TOKEN), `token leaked in CLI stderr: ${stderrText}`);
});

test("CLI: running with no mode, an unknown mode, or extra check arguments prints usage and exits non-zero", async () => {
  for (const argv of [[], ["unknown"], ["check", "extra"]]) {
    const out: string[] = [];
    const code = await runCli(argv, {}, (t) => out.push(t));
    assert.notEqual(code, 0, `expected non-zero exit for argv=${JSON.stringify(argv)}`);
    assert.match(out.join(""), /Usage: speedle-mcp <mode>/);
  }
});

test("check CLI flags and environment variables independently control tool registration over stdio", async () => {
  const cliPath = resolve(fileURLToPath(new URL("../src/cli.js", import.meta.url)));
  const runs: { args: string[]; env: Record<string, string>; expected: readonly string[] }[] = [
    { args: ["check"], env: {}, expected: DEFAULT_CHECK_TOOL_NAMES },
    { args: ["check", "--expose-diagnose"], env: {}, expected: ["is_allowed", "diagnose"] },
    {
      args: ["check", "--expose-all-granted-roles"],
      env: {},
      expected: ["is_allowed", "all_granted_roles"],
    },
    {
      args: ["check", "--expose-all-granted-permissions"],
      env: {},
      expected: ["is_allowed", "all_granted_permissions"],
    },
    { args: ["check"], env: { SPEEDLE_EXPOSE_DIAGNOSE: "true" }, expected: ["is_allowed", "diagnose"] },
    {
      args: ["check"],
      env: { SPEEDLE_EXPOSE_ALL_GRANTED_ROLES: "1" },
      expected: ["is_allowed", "all_granted_roles"],
    },
    {
      args: ["check"],
      env: { SPEEDLE_EXPOSE_ALL_GRANTED_PERMISSIONS: "true" },
      expected: ["is_allowed", "all_granted_permissions"],
    },
    {
      args: ["check", "--expose-diagnose", "--expose-all-granted-roles", "--expose-all-granted-permissions"],
      env: {},
      expected: CHECK_TOOL_NAMES,
    },
  ];

  for (const run of runs) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath, ...run.args],
      env: {
        PATH: process.env.PATH ?? "",
        SPEEDLE_ENDPOINT: "http://127.0.0.1:6734",
        SPEEDLE_SERVICE_NAME: "books",
        ...run.env,
      },
      stderr: "pipe",
    });
    const mcp = new Client({ name: "check-stdio-test", version: "1.0.0" });
    try {
      await mcp.connect(transport);
      const { tools } = await mcp.listTools();
      assert.deepEqual(
        tools.map((tool) => tool.name),
        [...run.expected],
        JSON.stringify(run),
      );
    } finally {
      await mcp.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    }
  }
});

test("check CLI refuses diagnose on speedle-cloud and rejects invalid exposure values", async () => {
  const cloudEnv = {
    SPEEDLE_ENDPOINT: "https://cloud.speedle.io",
    SPEEDLE_SERVICE_NAME: "books",
    SPEEDLE_TOKEN: TOKEN,
    SPEEDLE_BACKEND: "speedle-cloud",
  };
  for (const run of [
    { args: ["check", "--expose-diagnose"], env: cloudEnv },
    { args: ["check"], env: { ...cloudEnv, SPEEDLE_EXPOSE_DIAGNOSE: "true" } },
  ]) {
    const stderr: string[] = [];
    const code = await runCli(run.args, run.env, (text) => stderr.push(text));
    assert.equal(code, 1);
    assert.match(stderr.join(""), /diagnose is not available with backend "speedle-cloud"/);
  }

  for (const name of [
    "SPEEDLE_EXPOSE_DIAGNOSE",
    "SPEEDLE_EXPOSE_ALL_GRANTED_ROLES",
    "SPEEDLE_EXPOSE_ALL_GRANTED_PERMISSIONS",
  ]) {
    assert.throws(
      () =>
        loadAdsConfig({
          SPEEDLE_ENDPOINT: "http://127.0.0.1:6734",
          SPEEDLE_SERVICE_NAME: "books",
          [name]: "yes",
        }),
      new RegExp(`${name} must be`),
    );
  }
});

test("check tools execute against mock ADS with typed and inferred attributes and report errors", async () => {
  const server = await startServer([
    { status: 200, body: { allowed: true, reason: 0 } },
    {
      status: 200,
      body: {
        allowed: true,
        reason: "GRANT_POLICY_FOUND",
        grantedRoles: ["admin"],
        policies: [{ id: "p1", name: "admin-policy", effect: "grant" }],
      },
    },
    { status: 200, body: ["admin"] },
    { status: 200, body: [{ resource: "/books/1", actions: ["get", "write"] }] },
  ]);
  after(() => server.close());

  const { client } = build(server.url);
  const { mcpClient, close } = await connectMcp(client, exposeAllTools);
  after(() => close());

  const allowedRes = await mcpClient.callTool({
    name: "is_allowed",
    arguments: {
      subject: [
        { type: "user", name: "alice", idd: "corp" },
        { type: "group", name: "eng" },
      ],
      resource: "/books/1",
      action: "get",
      attributes: [
        { name: "clearance", type: "numeric", value: 4 },
        { name: "issuedAt", type: "datetime", value: "2026-11-05T03:00:00Z" },
      ],
    },
  });
  assert.equal(allowedRes.isError, undefined);
  assert.deepEqual(JSON.parse(toolText(allowedRes)), { allowed: true, reason: 0 });
  assert.deepEqual(JSON.parse(server.requests[0]?.body ?? ""), {
    subject: {
      principals: [
        { type: "user", name: "alice", idd: "corp" },
        { type: "group", name: "eng" },
      ],
    },
    serviceName: "books",
    resource: "/books/1",
    action: "get",
    attributes: [
      { name: "clearance", type: "numeric", value: 4 },
      { name: "issuedAt", type: "datetime", value: "2026-11-05T03:00:00Z" },
    ],
  });

  const diagRes = await mcpClient.callTool({
    name: "diagnose",
    arguments: {
      subject: "alice",
      resource: "/books/1",
      action: "get",
      attributes: { level: 3, active: true },
    },
  });
  assert.equal(diagRes.isError, undefined);
  const diagParsed = JSON.parse(toolText(diagRes)) as { allowed: boolean; grantedRoles: string[] };
  assert.equal(diagParsed.allowed, true);
  assert.deepEqual(diagParsed.grantedRoles, ["admin"]);

  const rolesRes = await mcpClient.callTool({
    name: "all_granted_roles",
    arguments: { subject: "alice" },
  });
  assert.deepEqual(JSON.parse(toolText(rolesRes)), ["admin"]);

  const permsRes = await mcpClient.callTool({
    name: "all_granted_permissions",
    arguments: { subject: "alice" },
  });
  assert.deepEqual(JSON.parse(toolText(permsRes)), [{ resource: "/books/1", actions: ["get", "write"] }]);

  // Client-side InvalidRequestError returns isError=true without sending an HTTP request.
  const badRes = await mcpClient.callTool({
    name: "is_allowed",
    arguments: {
      subject: "alice",
      resource: "/books/1",
      action: "get",
      attributes: [{ name: "when", type: "datetime", value: "not-a-date" }],
    },
  });
  assert.equal(badRes.isError, true);
  assert.equal(JSON.parse(toolText(badRes)).error, "InvalidRequestError");
  assert.equal(server.requests.length, 4);
});
