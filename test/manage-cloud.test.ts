import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Auth, ConfigurationError, loadPmsConfig, withTestingSeams } from "../src/core/index.js";
import { PmsClient } from "../src/manage/client.js";
import { createManageServer, MANAGE_TOOL_NAMES } from "../src/manage/server.js";
import { type RecordedRequest, type Reply, startServer, testCerts, VirtualClock } from "./helpers.js";

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

const READ_TOKEN = "spdl_cloud_read_018bcfe5";
const WRITE_TOKEN = "spdl_cloud_write_018bcfe5";
const ADS_TOKEN = "spdl_ads_018bcfe5";

const POLICY = {
  id: "01HF7YAT000000000000000001",
  name: "readers",
  effect: "grant",
  principals: [["role:reader"]],
  permissions: [{ resource: "/books", actions: ["get", "list"] }],
};
const ROLE_POLICY = {
  id: "01HF7YAT000000000000000002",
  name: "alice-reader",
  effect: "grant",
  principals: ["user:alice"],
  roles: ["reader"],
};
const SERVICE = {
  name: "books",
  type: "application",
  policies: [POLICY],
  rolePolicies: [ROLE_POLICY],
};

/** A Speedle Cloud PMS-compatible API: bearer auth, scopes, and Cloud response shapes. */
function cloudApi(req: RecordedRequest): Reply {
  const authorization = req.headers.authorization ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  if (token === ADS_TOKEN) return { status: 403, body: { error: "insufficient_scope" } };
  if (token !== READ_TOKEN && token !== WRITE_TOKEN) return { status: 401, body: { error: "unauthorized" } };
  if (token === READ_TOKEN && req.method !== "GET") return { status: 403, body: { error: "insufficient_scope" } };

  const path = req.path;
  if (path === "/policy-mgmt/v1/service" && req.method === "GET") return { status: 200, body: [SERVICE] };
  if (path === "/policy-mgmt/v1/service" && req.method === "POST") {
    return { status: 409, body: { error: "service_exists" } };
  }
  if (path === "/policy-mgmt/v1/service/books" && req.method === "GET") return { status: 200, body: SERVICE };
  if (path === "/policy-mgmt/v1/service/books" && req.method === "DELETE") return { status: 204 };
  if (path === "/policy-mgmt/v1/service/books/policy" && req.method === "GET") return { status: 200, body: [POLICY] };
  if (path === "/policy-mgmt/v1/service/books/policy" && req.method === "POST") {
    return { status: 201, body: { id: POLICY.id, ...(JSON.parse(req.body) as object) } };
  }
  if (path === `/policy-mgmt/v1/service/books/policy/${POLICY.id}`) {
    return req.method === "GET" ? { status: 200, body: POLICY } : { status: 204 };
  }
  if (path === "/policy-mgmt/v1/service/books/role-policy" && req.method === "GET")
    return { status: 200, body: [ROLE_POLICY] };
  if (path === "/policy-mgmt/v1/service/books/role-policy" && req.method === "POST") {
    return { status: 201, body: { id: ROLE_POLICY.id, ...(JSON.parse(req.body) as object) } };
  }
  if (path === `/policy-mgmt/v1/service/books/role-policy/${ROLE_POLICY.id}`) {
    return req.method === "GET" ? { status: 200, body: ROLE_POLICY } : { status: 204 };
  }
  // Cloud exposes only the token's own service; the global service is absent.
  return { status: 404, body: { error: "not_found" } };
}

function cloudPms(endpoint: string, token = WRITE_TOKEN): PmsClient {
  return withTestingSeams(
    new VirtualClock(),
    () => 1,
    () =>
      new PmsClient({
        backend: "speedle-cloud",
        endpoint,
        auth: Auth.bearer(token),
        caCert: endpoint.startsWith("https:") ? testCerts().ca : undefined,
      }),
  );
}

async function connect(client: PmsClient, readOnly = false): Promise<{ mcp: Client; close: () => Promise<void> }> {
  const server = createManageServer(client, { readOnly });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcp = new Client({ name: "manage-cloud-test", version: "1.0.0" });
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

async function cloudServer(reply: (req: RecordedRequest) => Reply = cloudApi) {
  const server = await startServer(reply, { tls: true });
  return server;
}

test("Cloud: a pms:write token can use every manage tool", async () => {
  const server = await cloudServer();
  after(() => server.close());
  const { mcp, close } = await connect(cloudPms(server.url));
  after(() => close());

  const { tools } = await mcp.listTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    [...MANAGE_TOOL_NAMES],
  );

  assert.deepEqual(json(await mcp.callTool({ name: "list_services", arguments: {} })), [SERVICE]);
  assert.equal(json(await mcp.callTool({ name: "get_service", arguments: { serviceName: "books" } })).name, "books");

  const policies = JSON.parse(
    text(await mcp.callTool({ name: "list_policies", arguments: { serviceName: "books" } })),
  ) as { id: string; spdl: string }[];
  assert.equal(policies[0]?.id, POLICY.id);
  assert.equal(policies[0]?.spdl, "grant role reader get,list /books");

  const policy = json(
    await mcp.callTool({ name: "get_policy", arguments: { serviceName: "books", policyId: POLICY.id } }),
  );
  assert.equal(policy.spdl, "grant role reader get,list /books");

  const rolePolicies = JSON.parse(
    text(await mcp.callTool({ name: "list_role_policies", arguments: { serviceName: "books" } })),
  ) as { spdl: string }[];
  assert.equal(rolePolicies[0]?.spdl, "grant user alice reader");

  const rolePolicy = json(
    await mcp.callTool({
      name: "get_role_policy",
      arguments: { serviceName: "books", rolePolicyId: ROLE_POLICY.id },
    }),
  );
  assert.equal(rolePolicy.spdl, "grant user alice reader");

  const effective = json(await mcp.callTool({ name: "show_effective_policies", arguments: { serviceName: "books" } }));
  assert.deepEqual(effective.counts, { policies: 1, rolePolicies: 1, globalRolePolicies: 0 });
  assert.equal(effective.globalServiceFound, false);

  const createdService = await mcp.callTool({ name: "create_service", arguments: { name: "other" } });
  assert.equal(createdService.isError, true);
  assert.equal(json(createdService).status, 409);
  assert.equal(json(createdService).code, "service_exists");

  const createdPolicy = json(
    await mcp.callTool({
      name: "create_policy",
      arguments: { serviceName: "books", name: "writers", spdl: "grant role writer put /books/*" },
    }),
  );
  assert.equal((createdPolicy.policy as { id: string }).id, POLICY.id);

  const createdRolePolicy = json(
    await mcp.callTool({
      name: "create_role_policy",
      arguments: { serviceName: "books", name: "bob-writer", spdl: "grant user bob writer" },
    }),
  );
  assert.equal((createdRolePolicy.rolePolicy as { id: string }).id, ROLE_POLICY.id);

  const deletedPolicy = json(
    await mcp.callTool({
      name: "delete_policy",
      arguments: { serviceName: "books", policyId: POLICY.id, confirm: POLICY.id },
    }),
  );
  assert.equal(deletedPolicy.changed, "deleted");

  const deletedRolePolicy = json(
    await mcp.callTool({
      name: "delete_role_policy",
      arguments: { serviceName: "books", rolePolicyId: ROLE_POLICY.id, confirm: ROLE_POLICY.id },
    }),
  );
  assert.equal(deletedRolePolicy.changed, "deleted");

  const deletedService = json(
    await mcp.callTool({ name: "delete_service", arguments: { serviceName: "books", confirm: "books" } }),
  );
  assert.deepEqual(
    [deletedService.changed, deletedService.deletedPolicies, deletedService.deletedRolePolicies],
    ["deleted", 1, 1],
  );

  for (const request of server.requests) {
    assert.equal(request.headers.authorization, `Bearer ${WRITE_TOKEN}`, request.path);
    assert.ok(request.path.startsWith("/policy-mgmt/v1/"), request.path);
  }
});

test("Cloud: a pms:read token reads and is refused every write with insufficient_scope", async () => {
  const server = await cloudServer();
  after(() => server.close());
  const { mcp, close } = await connect(cloudPms(server.url, READ_TOKEN));
  after(() => close());

  assert.equal(json(await mcp.callTool({ name: "get_service", arguments: { serviceName: "books" } })).name, "books");
  assert.equal(
    json(await mcp.callTool({ name: "show_effective_policies", arguments: { serviceName: "books" } })).serviceName,
    "books",
  );

  const writes: [string, Record<string, unknown>][] = [
    ["create_service", { name: "other" }],
    ["create_policy", { serviceName: "books", name: "x", spdl: "grant user a get /b" }],
    ["create_role_policy", { serviceName: "books", name: "x", spdl: "grant user a role1" }],
    ["delete_policy", { serviceName: "books", policyId: POLICY.id, confirm: POLICY.id }],
    ["delete_role_policy", { serviceName: "books", rolePolicyId: ROLE_POLICY.id, confirm: ROLE_POLICY.id }],
    ["delete_service", { serviceName: "books", confirm: "books" }],
  ];
  for (const [name, args] of writes) {
    const result = await mcp.callTool({ name, arguments: args });
    assert.equal(result.isError, true, name);
    const payload = json(result);
    assert.equal(payload.status, 403, name);
    assert.equal(payload.code, "insufficient_scope", name);
    assert.equal(payload.error, "ForbiddenError", name);
  }
});

test("Cloud: an ads token cannot call the management API", async () => {
  const server = await cloudServer();
  after(() => server.close());
  const { mcp, close } = await connect(cloudPms(server.url, ADS_TOKEN));
  after(() => close());

  const result = await mcp.callTool({ name: "list_services", arguments: {} });
  assert.equal(result.isError, true);
  assert.deepEqual(
    { status: json(result).status, code: json(result).code },
    { status: 403, code: "insufficient_scope" },
  );
});

interface ErrorCase {
  name: string;
  reply: Reply;
  error: string;
  status: number;
  code?: string;
  retryAfter?: number;
  quotaDailyRemaining?: number;
  message?: RegExp;
  requests: number;
}

const errorCases: ErrorCase[] = [
  {
    name: "400 invalid_request",
    reply: { status: 400, body: { error: "invalid_request" } },
    error: "InvalidRequestError",
    status: 400,
    code: "invalid_request",
    requests: 1,
  },
  {
    name: "400 engine parse message",
    reply: { status: 400, body: { error: "SPDL-0004 invalid condition at character 7" } },
    error: "InvalidRequestError",
    status: 400,
    message: /SPDL-0004 invalid condition/,
    requests: 1,
  },
  {
    name: "401 unauthorized",
    reply: { status: 401, body: { error: "unauthorized" } },
    error: "UnauthorizedError",
    status: 401,
    code: "unauthorized",
    requests: 1,
  },
  {
    name: "403 insufficient_scope",
    reply: { status: 403, body: { error: "insufficient_scope" } },
    error: "ForbiddenError",
    status: 403,
    code: "insufficient_scope",
    requests: 1,
  },
  {
    name: "404 not_found",
    reply: { status: 404, body: { error: "not_found" } },
    error: "HttpError",
    status: 404,
    code: "not_found",
    requests: 1,
  },
  {
    name: "409 service_exists",
    reply: { status: 409, body: { error: "service_exists" } },
    error: "ConflictError",
    status: 409,
    code: "service_exists",
    requests: 1,
  },
  {
    name: "409 policy_exists",
    reply: { status: 409, body: { error: "policy_exists" } },
    error: "ConflictError",
    status: 409,
    code: "policy_exists",
    requests: 1,
  },
  {
    name: "409 quota_exceeded with limit",
    reply: { status: 409, body: { error: "quota_exceeded", limit: 200 } },
    error: "ConflictError",
    status: 409,
    code: "quota_exceeded",
    message: /quota_exceeded \(limit 200\)/,
    requests: 1,
  },
  {
    name: "413 request_too_large",
    reply: { status: 413, body: { error: "request_too_large" } },
    error: "RequestTooLargeError",
    status: 413,
    code: "request_too_large",
    requests: 1,
  },
  {
    name: "429 daily_quota_exceeded",
    reply: {
      status: 429,
      headers: { "Retry-After": "3600", "X-Quota-Daily-Remaining": "0" },
      body: { error: "daily_quota_exceeded" },
    },
    error: "QuotaExceededError",
    status: 429,
    code: "daily_quota_exceeded",
    retryAfter: 3600,
    quotaDailyRemaining: 0,
    requests: 1,
  },
  {
    name: "429 rate_limited",
    reply: { status: 429, headers: { "Retry-After": "60" }, body: { error: "rate_limited" } },
    error: "RateLimitedError",
    status: 429,
    code: "rate_limited",
    retryAfter: 60,
    requests: 1,
  },
  {
    name: "500 internal_error",
    reply: { status: 500, body: { error: "internal_error" } },
    error: "ServerError",
    status: 500,
    code: "internal_error",
    requests: 1,
  },
  {
    name: "503 quota_unavailable",
    reply: { status: 503, body: { error: "quota_unavailable" } },
    error: "ServiceUnavailableError",
    status: 503,
    code: "quota_unavailable",
    requests: 3,
  },
];

for (const testCase of errorCases) {
  test(`Cloud errors: ${testCase.name}`, async () => {
    const server = await cloudServer(() => testCase.reply);
    after(() => server.close());
    const { mcp, close } = await connect(cloudPms(server.url));
    after(() => close());

    const payload = json(await mcp.callTool({ name: "get_service", arguments: { serviceName: "books" } }));
    assert.equal(payload.error, testCase.error);
    assert.equal(payload.status, testCase.status);
    assert.equal(payload.code, testCase.code);
    if (testCase.message) assert.match(payload.message as string, testCase.message);
    if (testCase.retryAfter !== undefined) assert.equal(payload.retryAfter, testCase.retryAfter);
    if (testCase.quotaDailyRemaining !== undefined) {
      assert.equal(payload.quotaDailyRemaining, testCase.quotaDailyRemaining);
    }
    assert.equal(server.requests.length, testCase.requests);
  });
}

test("Cloud: the token is redacted from tool errors", async () => {
  const server = await cloudServer(() => ({ status: 400, body: { error: `rejected ${WRITE_TOKEN}` } }));
  after(() => server.close());
  const { mcp, close } = await connect(cloudPms(server.url));
  after(() => close());

  const output = text(await mcp.callTool({ name: "get_service", arguments: { serviceName: "books" } }));
  assert.ok(!output.includes(WRITE_TOKEN), output);
  assert.match(output, /<redacted>/);
});

test("Cloud: an endpoint with /policy-mgmt/v1 is accepted without doubling the path", async () => {
  const server = await cloudServer();
  after(() => server.close());
  const { mcp, close } = await connect(cloudPms(`${server.url}/policy-mgmt/v1`));
  after(() => close());

  assert.equal(json(await mcp.callTool({ name: "get_service", arguments: { serviceName: "books" } })).name, "books");
  assert.equal(server.requests[0]?.path, "/policy-mgmt/v1/service/books");
});

test("Cloud config: backend selection and validation", () => {
  const cloud = loadPmsConfig({
    SPEEDLE_PMS_ENDPOINT: "https://cloud.speedle.io",
    SPEEDLE_PMS_BACKEND: "speedle-cloud",
    SPEEDLE_PMS_TOKEN: WRITE_TOKEN,
  });
  assert.equal(cloud.backend, "speedle-cloud");
  assert.equal(cloud.auth.kind, "bearer");

  // A token alone never switches an existing self-hosted setup to Cloud.
  const selfHostedWithToken = loadPmsConfig({
    SPEEDLE_PMS_ENDPOINT: "https://pms.example.com:6733",
    SPEEDLE_PMS_TOKEN: WRITE_TOKEN,
  });
  assert.equal(selfHostedWithToken.backend, "speedle");
  assert.equal(
    loadPmsConfig({ SPEEDLE_PMS_ENDPOINT: "http://127.0.0.1:6733", SPEEDLE_PMS_BACKEND: "speedle" }).backend,
    "speedle",
  );

  assert.throws(
    () => loadPmsConfig({ SPEEDLE_PMS_ENDPOINT: "http://127.0.0.1:6733", SPEEDLE_PMS_BACKEND: "speedle-plus" }),
    (error: unknown) =>
      error instanceof ConfigurationError &&
      error.message === 'SPEEDLE_PMS_BACKEND must be "speedle-cloud" or "speedle"',
  );
  assert.throws(
    () => loadPmsConfig({ SPEEDLE_PMS_ENDPOINT: "https://cloud.speedle.io", SPEEDLE_PMS_BACKEND: "speedle-cloud" }),
    (error: unknown) =>
      error instanceof ConfigurationError &&
      error.message === 'SPEEDLE_PMS_TOKEN is required when SPEEDLE_PMS_BACKEND is "speedle-cloud"',
  );
  assert.throws(
    () =>
      loadPmsConfig({
        SPEEDLE_PMS_ENDPOINT: "http://cloud.speedle.io",
        SPEEDLE_PMS_BACKEND: "speedle-cloud",
        SPEEDLE_PMS_TOKEN: WRITE_TOKEN,
      }),
    (error: unknown) =>
      error instanceof ConfigurationError &&
      error.message === 'SPEEDLE_PMS_ENDPOINT must use https:// when SPEEDLE_PMS_BACKEND is "speedle-cloud"',
  );
  // A non-HTTP scheme gets the same Cloud message, and an unparseable URL is
  // still reported by the normal options validation.
  assert.throws(
    () =>
      loadPmsConfig({
        SPEEDLE_PMS_ENDPOINT: "ftp://cloud.speedle.io",
        SPEEDLE_PMS_BACKEND: "speedle-cloud",
        SPEEDLE_PMS_TOKEN: WRITE_TOKEN,
      }),
    (error: unknown) =>
      error instanceof ConfigurationError &&
      error.message === 'SPEEDLE_PMS_ENDPOINT must use https:// when SPEEDLE_PMS_BACKEND is "speedle-cloud"',
  );
  assert.throws(
    () =>
      loadPmsConfig({
        SPEEDLE_PMS_ENDPOINT: "not a url",
        SPEEDLE_PMS_BACKEND: "speedle-cloud",
        SPEEDLE_PMS_TOKEN: WRITE_TOKEN,
      }),
    (error: unknown) => error instanceof ConfigurationError && error.message === "endpoint is not a valid URL",
  );

  // manage mode never reads the check-mode backend selector.
  const withAdsBackend = loadPmsConfig({
    SPEEDLE_PMS_ENDPOINT: "https://cloud.speedle.io",
    SPEEDLE_PMS_BACKEND: "speedle-cloud",
    SPEEDLE_PMS_TOKEN: WRITE_TOKEN,
    SPEEDLE_BACKEND: "speedle",
  });
  assert.equal(withAdsBackend.backend, "speedle-cloud");
});
