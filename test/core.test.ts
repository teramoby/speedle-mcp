import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  Attr,
  Auth,
  compareCodePoints,
  formatDatetime,
  loadAdsConfig,
  SpeedleClient,
  toWireAttributes,
} from "../src/core/index.js";
import * as E from "../src/core/errors.js";
import type { ClientOptions } from "../src/core/options.js";
import { build, type Reply, startServer, TOKEN } from "./helpers.js";

const allow: Reply = { status: 200, body: { allowed: true, reason: 0 } };
const r503: Reply = { status: 503, body: { error: "snapshot_unavailable" } };

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => assert.fail("expected a rejection"),
    (e: unknown) => e,
  );
}

test("typed factories and JSON RFC 3339 datetime strings map onto JsonAttribute in caller order", () => {
  const wire = toWireAttributes([
    Attr.string("s", "eng"),
    Attr.string("sa", ["a", "b"]),
    Attr.numeric("n", 4.5),
    Attr.numeric("na", []),
    Attr.bool("b", false),
    Attr.bool("ba", [true]),
    Attr.datetime("d", new Date("2026-11-05T03:00:00Z")),
    { name: "dj", type: "datetime", value: ["2026-11-05T05:00:00.250+02:00"] },
  ]);
  assert.deepEqual(wire, [
    { name: "s", type: "string", value: "eng" },
    { name: "sa", type: "string", value: ["a", "b"] },
    { name: "n", type: "numeric", value: 4.5 },
    { name: "na", type: "numeric", value: [] },
    { name: "b", type: "bool", value: false },
    { name: "ba", type: "bool", value: [true] },
    { name: "d", type: "datetime", value: "2026-11-05T03:00:00Z" },
    { name: "dj", type: "datetime", value: ["2026-11-05T03:00:00.250Z"] },
  ]);
  assert.equal(formatDatetime(new Date(Date.UTC(2026, 10, 5, 3))), "2026-11-05T03:00:00Z");
});

test("inferred attributes sort by Unicode code point and keep date-like strings as string", () => {
  const wire = toWireAttributes({
    z: "2026-11-05T03:00:00Z",
    "\u{1F600}": 1,
    "\uFFFF": true,
    a: [1, 2],
    d: new Date("2026-11-05T03:00:00Z"),
  });
  assert.deepEqual(
    wire.map((a) => [a.name, a.type, a.value]),
    [
      ["a", "numeric", [1, 2]],
      ["d", "datetime", "2026-11-05T03:00:00Z"],
      ["z", "string", "2026-11-05T03:00:00Z"],
      ["\uFFFF", "bool", true],
      ["\u{1F600}", "numeric", 1],
    ],
  );
  assert.equal(compareCodePoints("\u{1F600}", "\uFFFF"), 1);
});

const rejectedAttrs: [string, () => unknown][] = [
  ["empty name", () => toWireAttributes([Attr.string("", "x")])],
  ["duplicate name", () => toWireAttributes([Attr.string("a", "x"), Attr.numeric("a", 1)])],
  ["null value", () => toWireAttributes([Attr.string("a", null as unknown as string)])],
  ["null item", () => toWireAttributes([Attr.string("a", ["x", null as unknown as string])])],
  ["NaN", () => toWireAttributes([Attr.numeric("a", Number.NaN)])],
  ["Infinity", () => toWireAttributes([Attr.numeric("a", [1, Number.POSITIVE_INFINITY])])],
  ["invalid Date", () => toWireAttributes([Attr.datetime("a", new Date("nope"))])],
  [
    "naive datetime string without timezone",
    () => toWireAttributes([{ name: "a", type: "datetime", value: "2026-11-05T03:00:00" }]),
  ],
  ["unknown type", () => toWireAttributes([{ name: "a", type: "" as never, value: 1 }])],
  ["inferred null", () => toWireAttributes({ a: null } as never)],
  ["inferred empty array", () => toWireAttributes({ a: [] })],
  ["inferred mixed array", () => toWireAttributes({ a: [1, "x"] } as never)],
  ["inferred nested object", () => toWireAttributes({ a: { b: 1 } } as never)],
];
for (const [name, fn] of rejectedAttrs) {
  test(`attributes: rejects ${name} with InvalidRequestError`, () => {
    assert.throws(fn, E.InvalidRequestError);
  });
}

test("loadAdsConfig reads ADS env vars and ignores PMS env vars", () => {
  const cloudCfg = loadAdsConfig({
    SPEEDLE_ENDPOINT: "https://cloud.speedle.io",
    SPEEDLE_SERVICE_NAME: "books",
    SPEEDLE_TOKEN: TOKEN,
    SPEEDLE_PMS_ENDPOINT: "http://invalid-url://",
    SPEEDLE_PMS_TOKEN: "pms_secret",
  });
  assert.equal(cloudCfg.backend, "speedle-cloud");
  assert.equal(cloudCfg.serviceName, "books");
  assert.equal(cloudCfg.auth.kind, "bearer");

  const selfHostedCfg = loadAdsConfig({
    SPEEDLE_ADS_URL: "http://127.0.0.1:6734",
    SPEEDLE_SERVICE: "library",
  });
  assert.equal(selfHostedCfg.backend, "speedle");
  assert.equal(selfHostedCfg.serviceName, "library");
  assert.equal(selfHostedCfg.auth.kind, "none");

  assert.throws(() => loadAdsConfig({ SPEEDLE_SERVICE_NAME: "books" }), E.ConfigurationError);
  assert.throws(() => loadAdsConfig({ SPEEDLE_ENDPOINT: "http://127.0.0.1:6734" }), E.ConfigurationError);
  assert.throws(
    () =>
      loadAdsConfig({
        SPEEDLE_ENDPOINT: "http://127.0.0.1:6734",
        SPEEDLE_SERVICE_NAME: "books",
        SPEEDLE_TOKEN: TOKEN,
      }),
    E.ConfigurationError,
  );
});

test('loadAdsConfig accepts SPEEDLE_BACKEND "speedle" and rejects the old "speedle-plus" value', () => {
  const env = { SPEEDLE_ENDPOINT: "http://127.0.0.1:6734", SPEEDLE_SERVICE_NAME: "books" };
  assert.equal(loadAdsConfig({ ...env, SPEEDLE_BACKEND: "speedle" }).backend, "speedle");
  assert.throws(
    () => loadAdsConfig({ ...env, SPEEDLE_BACKEND: "speedle-plus" }),
    (error: unknown) =>
      error instanceof E.ConfigurationError && error.message === 'SPEEDLE_BACKEND must be "speedle-cloud" or "speedle"',
  );
});

const baseOptions: ClientOptions = {
  backend: "speedle-cloud",
  endpoint: "https://cloud.speedle.io",
  auth: Auth.bearer(TOKEN),
  serviceName: "books",
};

const invalidConfigs: [string, Partial<ClientOptions> | (() => unknown)][] = [
  ["unknown backend", { backend: "x" as never }],
  ["old backend name speedle-plus", { backend: "speedle-plus" as never }],
  ["empty serviceName", { serviceName: "" }],
  ["cloud without bearer", { auth: Auth.none() }],
  ["query string", { endpoint: "https://cloud.speedle.io/?a=1" }],
  ["fragment", { endpoint: "https://cloud.speedle.io/#x" }],
  ["credentials in URL", { endpoint: "https://u:p@cloud.speedle.io" }],
  ["http with bearer", { backend: "speedle", endpoint: "http://127.0.0.1:6734" }],
  ["http to remote host", { backend: "speedle", auth: Auth.none(), endpoint: "http://ads.internal:6734" }],
  ["empty bearer token", () => Auth.bearer("")],
  ["token with whitespace", () => Auth.bearer("spdl_a b")],
];
for (const [name, value] of invalidConfigs) {
  test(`ConfigurationError: ${name}`, () => {
    assert.throws(
      () => (typeof value === "function" ? value() : new SpeedleClient({ ...baseOptions, ...value })),
      E.ConfigurationError,
    );
  });
}

test("all four ADS endpoints send JsonContext and parse their responses", async () => {
  const server = await startServer(
    [
      { status: 200, headers: { "X-Quota-Daily-Remaining": "9999" }, body: { allowed: true, reason: 0 } },
      {
        status: 200,
        body: {
          allowed: false,
          reason: "NO_APPLICABLE_POLICIES",
          grantedRoles: ["reader"],
          policies: [{ id: "p1", name: "allow-read", effect: "grant" }],
        },
      },
      { status: 200, body: ["admin", "editor"] },
      { status: 200, body: [{ resource: "/books", actions: ["get", "list"] }] },
    ],
    { tls: true },
  );
  after(() => server.close());
  const { client } = build(`${server.url}/prefix/`);

  const decision = await client.check("alice", "get", "/books/1", [Attr.string("team", "eng")]);
  assert.deepEqual(decision, { allowed: true, reason: 0, quotaDailyRemaining: 9999 });

  const diag = await client.diagnose([{ type: "user", name: "alice", idd: "corp" }], "delete", "/books/1");
  assert.equal(diag.allowed, false);
  assert.equal(diag.reason, "NO_APPLICABLE_POLICIES");
  assert.deepEqual(diag.grantedRoles, ["reader"]);

  const roles = await client.allGrantedRoles("alice", { level: 2 });
  assert.deepEqual(roles, ["admin", "editor"]);

  const perms = await client.allGrantedPermissions("alice");
  assert.deepEqual(perms, [{ resource: "/books", actions: ["get", "list"] }]);

  assert.deepEqual(
    server.requests.map((r) => r.path),
    [
      "/prefix/authz-check/v1/is-allowed",
      "/prefix/authz-check/v1/diagnose",
      "/prefix/authz-check/v1/all-granted-roles",
      "/prefix/authz-check/v1/all-granted-permissions",
    ],
  );
  assert.equal(server.requests[0]?.headers.authorization, `Bearer ${TOKEN}`);
  await client.close();
});

test("error classification and retry policy follow speedle-sdk design §3.4, §6, §7", async () => {
  const server = await startServer(
    [
      r503,
      { status: 502 },
      allow,
      { status: 403, headers: { "X-Quota-Daily-Remaining": "9998" }, body: { error: "service_mismatch" } },
      { status: 429, headers: { "Retry-After": "3600" }, body: { error: "daily_quota_exceeded" } },
      { status: 429, headers: { "Retry-After": "6" }, body: { error: "rate_limited" } },
    ],
    { tls: true },
  );
  after(() => server.close());
  const { client, clock } = build(server.url, { retry: { maxAttempts: 3 } }, 0.5);

  assert.equal(await client.isAllowed("alice", "get", "/books/1"), true);
  assert.deepEqual(clock.sleeps, [50, 100]);

  const forbidden = await rejection(client.isAllowed("alice", "get", "/books/1"));
  assert.ok(forbidden instanceof E.ForbiddenError);
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.code, "service_mismatch");
  assert.equal(forbidden.quotaDailyRemaining, 9998);

  const quota = await rejection(client.isAllowed("alice", "get", "/books/1"));
  assert.ok(quota instanceof E.QuotaExceededError);
  assert.equal(quota.retryAfter, 3600);

  const rateLimited = await rejection(client.isAllowed("alice", "get", "/books/1"));
  assert.ok(rateLimited instanceof E.RateLimitedError);
  assert.equal(rateLimited.retryAfter, 6);

  await client.close();
});

test("circuit breaker opens after consecutive failures and recovers after cool-down", async () => {
  const server = await startServer([r503, r503, allow]);
  after(() => server.close());
  const { client, clock } = build(server.url, {
    retry: { maxAttempts: 1 },
    circuitBreaker: { failureThreshold: 2, coolDownMs: 30000 },
  });

  assert.ok((await rejection(client.isAllowed("alice", "get", "/r"))) instanceof E.ServiceUnavailableError);
  assert.ok((await rejection(client.isAllowed("alice", "get", "/r"))) instanceof E.ServiceUnavailableError);
  assert.ok((await rejection(client.isAllowed("alice", "get", "/r"))) instanceof E.CircuitOpenError);
  assert.equal(server.requests.length, 2);

  clock.advance(30000);
  assert.equal(await client.isAllowed("alice", "get", "/r"), true);
  assert.equal(server.requests.length, 3);
  await client.close();
});
