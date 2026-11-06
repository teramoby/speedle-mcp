// Differential test: the TypeScript SPDL port in src/manage/spdl.ts against the
// real Go parser (teramoby/speedle-plus pkg/pdl), via the golden file that
// test/fixtures/spdl/golden.go writes. See test/fixtures/spdl/README.md.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  parsePolicy,
  parseRolePolicy,
  renderPolicy,
  renderRolePolicy,
  SPDL_SPEEDLE_PLUS_COMMIT,
  SpdlError,
} from "../src/manage/spdl.js";

interface GoResult {
  ok: boolean;
  body?: Record<string, unknown>;
  reason?: string;
  position: number | null;
  condition?: boolean;
}
interface GoldenEntry {
  source: string;
  spdl: string;
  policy: GoResult;
  rolePolicy: GoResult;
}

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../test/fixtures/spdl/${name}`, import.meta.url), "utf8"));
const corpus = fixture("corpus.json") as { speedlePlus: string; entries: { source: string; spdl: string }[] };
const golden = fixture("golden.json") as { speedlePlus: string; entries: GoldenEntry[] };

const KINDS = [
  { kind: "policy", parse: parsePolicy, render: renderPolicy, go: (e: GoldenEntry) => e.policy },
  {
    kind: "rolePolicy",
    parse: parseRolePolicy,
    render: (b: unknown) => renderRolePolicy(b as Parameters<typeof renderRolePolicy>[0]),
    go: (e: GoldenEntry) => e.rolePolicy,
  },
] as const;

const bytes = (s: string): number => Buffer.byteLength(s, "utf8");
const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

/** Compares one TypeScript parse with the Go result; returns a mismatch description or undefined. */
function compare(spdl: string, parse: (s: string, n: string) => unknown, go: GoResult): string | undefined {
  let body: unknown;
  let error: unknown;
  try {
    body = parse(spdl, "n");
  } catch (err) {
    error = err;
  }
  if (go.ok) {
    if (error !== undefined) return `Go accepts, port rejects: ${String(error)}`;
    try {
      assert.deepEqual(plain(body), go.body);
    } catch {
      return `bodies differ: port ${JSON.stringify(body)} Go ${JSON.stringify(go.body)}`;
    }
    return undefined;
  }
  if (go.condition) {
    // The port leaves conditions to PMS (which runs the same condition.Check on create).
    // It must still accept the statement around the condition and pass the condition text on.
    if (error !== undefined) return `Go rejects only the condition, port rejects the statement: ${String(error)}`;
    const condition = (body as { condition?: string }).condition;
    if (!condition) return "Go rejects the condition, port found no condition";
    const start = spdl.lastIndexOf(condition);
    if (start < 0 || (go.position !== null && go.position < bytes(spdl.slice(0, start)))) {
      return `condition ${JSON.stringify(condition)} does not contain Go's error position ${go.position}`;
    }
    return undefined;
  }
  if (!(error instanceof SpdlError)) return `Go rejects (${go.reason}), port ${error ? String(error) : "accepts"}`;
  if (error.reason !== go.reason) return `reason: port ${JSON.stringify(error.reason)} Go ${JSON.stringify(go.reason)}`;
  if (go.position !== null && bytes(spdl.slice(0, error.position)) !== go.position) {
    return `position: port ${bytes(spdl.slice(0, error.position))} Go ${go.position}`;
  }
  return undefined;
}

test("spdl golden: golden.json is current for corpus.json and the commit the port names", () => {
  assert.equal(golden.speedlePlus, corpus.speedlePlus);
  assert.equal(SPDL_SPEEDLE_PLUS_COMMIT, golden.speedlePlus);
  assert.deepEqual(
    golden.entries.map((e) => e.spdl),
    corpus.entries.map((e) => e.spdl),
  );
  assert.ok(golden.entries.length >= 100, `corpus has ${golden.entries.length} statements`);
});

test("spdl golden: the port agrees with speedle-plus pkg/pdl on every corpus statement", () => {
  const mismatches: string[] = [];
  for (const entry of golden.entries) {
    for (const k of KINDS) {
      const why = compare(entry.spdl, k.parse, k.go(entry));
      if (why) mismatches.push(`${k.kind} ${JSON.stringify(entry.spdl)} (${entry.source}): ${why}`);
    }
  }
  assert.deepEqual(mismatches, []);
});

test("spdl golden: rendered SPDL is in the corpus and Go parses it back to the same body", () => {
  const bySpdl = new Map(golden.entries.map((e) => [e.spdl, e]));
  const problems: string[] = [];
  for (const entry of golden.entries) {
    for (const k of KINDS) {
      const go = k.go(entry);
      if (!go.ok) continue;
      const rendered = k.render(k.parse(entry.spdl, "n"));
      if (rendered === undefined) continue;
      const back = bySpdl.get(rendered);
      if (!back) problems.push(`${k.kind} ${JSON.stringify(rendered)} is not in the corpus; regenerate it`);
      else if (!k.go(back).ok) problems.push(`${k.kind} ${JSON.stringify(rendered)}: Go rejects it`);
      else {
        try {
          assert.deepEqual(k.go(back).body, go.body);
        } catch {
          problems.push(`${k.kind} ${JSON.stringify(rendered)}: Go reads a different body`);
        }
      }
    }
  }
  assert.deepEqual(problems, []);
});
