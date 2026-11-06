import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePolicy, parseRolePolicy, renderPolicy, renderRolePolicy, SpdlError } from "../src/manage/spdl.js";

test("spdl: parses policies the way speedle-plus pkg/pdl does", () => {
  assert.deepEqual(parsePolicy("grant user alice get,write /books/123 if clearance >= 2", "p1"), {
    name: "p1",
    effect: "grant",
    principals: [["user:alice"]],
    permissions: [{ resource: "/books/123", actions: ["get", "write"] }],
    condition: "clearance >= 2",
  });
  assert.deepEqual(
    parsePolicy("DENY (user bob from corp, group staff), role auditor del expr:/books/.*, get /admin", "p2"),
    {
      name: "p2",
      effect: "deny",
      principals: [["idd=corp:user:bob", "group:staff"], ["role:auditor"]],
      permissions: [
        { resourceExpression: "/books/.*", actions: ["del"] },
        { resource: "/admin", actions: ["get"] },
      ],
    },
  );
  assert.deepEqual(parsePolicy("grant user 'Ann Lee' read \"/my docs\"", "p3").permissions, [
    { resource: "/my docs", actions: ["read"] },
  ]);
});

test("spdl: parses role policies the way speedle-plus pkg/pdl does", () => {
  assert.deepEqual(parseRolePolicy("grant user alice librarian on /books if clearance >= 2", "rp1"), {
    name: "rp1",
    effect: "grant",
    principals: ["user:alice"],
    roles: ["librarian"],
    resources: ["/books"],
    condition: "clearance >= 2",
  });
  assert.deepEqual(parseRolePolicy("grant group staff, user bob role reader, writer on expr:/b/.*", "rp2"), {
    name: "rp2",
    effect: "grant",
    principals: ["group:staff", "user:bob"],
    roles: ["reader", "writer"],
    resourceExpressions: ["/b/.*"],
  });
});

test("spdl: reports errors with a position", () => {
  const cases: [() => unknown, RegExp][] = [
    [() => parsePolicy("allow user alice get /b", ""), /Not found valid effect/],
    [() => parsePolicy("grant alice get /b", ""), /Not found principal type/],
    [() => parsePolicy("grant user alice get", ""), /Not found permission/],
    [() => parsePolicy("grant (user a get /b", ""), /sepereated by commas/],
    [() => parsePolicy("grant user alice get /b if", ""), /Unexpected EOF/],
    [() => parsePolicy("grant user alice get /b extra", ""), /Unexpected trailing input/],
    [() => parseRolePolicy("grant user alice", ""), /Unexpected EOF|No role found/],
    [() => parseRolePolicy("grant user alice librarian on", ""), /Not found resource/],
  ];
  for (const [fn, re] of cases) {
    assert.throws(fn, (err: unknown) => err instanceof SpdlError && re.test(err.message) && err.message.includes("^"));
  }
});

test("spdl: render then parse gives back the same body", () => {
  const policies = [
    "grant user alice get,write /books/123 if clearance >= 2",
    "deny (user bob from corp, group staff), role auditor del expr:/books/.*, get /admin",
    "grant user 'Ann Lee' read \"/my docs\"",
    'grant role on get "if"',
  ];
  for (const spdl of policies) {
    const body = parsePolicy(spdl, "x");
    const rendered = renderPolicy(body);
    assert.ok(rendered, `could not render ${spdl}`);
    assert.deepEqual(parsePolicy(rendered, "x"), body, rendered);
  }
  const rolePolicies = [
    "grant user alice librarian on /books if clearance >= 2",
    "deny group staff, user bob from corp reader, writer on /a, expr:/b/.*",
  ];
  for (const spdl of rolePolicies) {
    const body = parseRolePolicy(spdl, "x");
    const rendered = renderRolePolicy(body);
    assert.ok(rendered, `could not render ${spdl}`);
    assert.deepEqual(parseRolePolicy(rendered, "x"), body, rendered);
  }
  assert.equal(renderPolicy({ effect: "grant", principals: [], permissions: [] }), undefined);
  assert.equal(renderRolePolicy({ effect: "grant", principals: ["user:a"], roles: ["role"] }), undefined);
});
