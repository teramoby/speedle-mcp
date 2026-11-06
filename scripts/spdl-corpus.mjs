#!/usr/bin/env node
// Builds test/fixtures/spdl/corpus.json: SPDL statements extracted from a
// teramoby/speedle-plus checkout (parser tests, CLI and store tests, .spdl
// files, docs, home page) and a teramoby/speedle-sdk checkout
// (e2e/policies.json), plus generated invalid variants and the SPDL that
// renderPolicy / renderRolePolicy produce for every statement the port parses.
//
// Usage (after `npm run build:test`, which the rendered entries need):
//   node scripts/spdl-corpus.mjs <speedle-plus-dir> <speedle-sdk-dir> > test/fixtures/spdl/corpus.json
// Then regenerate golden.json with test/fixtures/spdl/golden.go (see its README).
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const [plusDir, sdkDir] = process.argv.slice(2);
if (!plusDir || !sdkDir) {
  console.error("usage: node scripts/spdl-corpus.mjs <speedle-plus-dir> <speedle-sdk-dir>");
  process.exit(2);
}

const entries = [];
const seen = new Set();
function add(source, spdl) {
  if (typeof spdl !== "string" || seen.has(spdl)) return;
  seen.add(spdl);
  entries.push({ source, spdl });
}

const STATEMENT = /^\s*(grant|deny)\s/iu;

function walk(dir, filter) {
  const out = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (d.name === "node_modules" || d.name === ".git") continue;
    const p = join(dir, d.name);
    if (d.isDirectory()) out.push(...walk(p, filter));
    else if (filter(p)) out.push(p);
  }
  return out.sort();
}

/** Decodes a Go interpreted string literal body. */
function goUnquote(body) {
  return body.replace(/\\(U[0-9a-fA-F]{8}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[0-7]{3}|.)/gu, (_, e) => {
    if (e[0] === "U" || e[0] === "u") return String.fromCodePoint(parseInt(e.slice(1), 16));
    if (e[0] === "x") return String.fromCharCode(parseInt(e.slice(1), 16));
    if (/^[0-7]{3}$/u.test(e)) return String.fromCharCode(parseInt(e, 8));
    return { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" }[e] ?? e;
  });
}

function goStrings(file) {
  const src = readFileSync(file, "utf8");
  const out = [];
  const re = /"((?:[^"\\\n]|\\.)*)"|`([^`]*)`/gu;
  for (let m; (m = re.exec(src));) out.push(m[1] !== undefined ? goUnquote(m[1]) : m[2]);
  return out;
}

// 1. Parser tests and the shared grammar corpus: every literal that looks like an input.
const rel = (p) => `speedle-plus:${relative(plusDir, p)}`;
for (const file of [
  ...walk(join(plusDir, "pkg/pdl"), (p) => p.endsWith("_test.go")),
  join(plusDir, "testutil/pdltest/corpus.go"),
]) {
  for (const s of goStrings(file)) {
    if (s === "" || (/\s/u.test(s) && !s.includes("%") && !/^[{[]/u.test(s.trim()) && !s.includes("github.com"))) {
      add(rel(file), s);
    }
  }
}

// 2. Other Go tests (CLI, file store, docs checks, playground): statement literals.
for (const file of walk(plusDir, (p) => p.endsWith("_test.go") && !p.includes("/pkg/pdl/"))) {
  for (const s of goStrings(file)) if (STATEMENT.test(s) && !s.includes("\n") && !s.includes("%")) add(rel(file), s);
}

// 3. .spdl files (outside benchmarks/private).
for (const file of walk(plusDir, (p) => p.endsWith(".spdl") && !p.includes("/benchmarks/private/"))) {
  for (const line of readFileSync(file, "utf8").split("\n")) if (STATEMENT.test(line)) add(rel(file), line.trim());
}

// 4. Docs (Markdown code blocks, inline code, `spctl create ... -c "..."`) and doc example JSON.
for (const file of walk(join(plusDir, "docs/hugo/content"), (p) => p.endsWith(".md"))) {
  let inCode = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (/^\s*```/u.test(line)) {
      inCode = !inCode;
      continue;
    }
    for (const m of line.matchAll(/-c\s+(["'])(.*?)\1/gu)) if (STATEMENT.test(m[2])) add(rel(file), m[2]);
    for (const m of line.matchAll(/`([^`]+)`/gu)) if (STATEMENT.test(m[1])) add(rel(file), m[1].trim());
    if (inCode && STATEMENT.test(line)) add(rel(file), line.trim());
  }
}
function jsonStrings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => jsonStrings(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => jsonStrings(v, out));
  return out;
}
for (const file of walk(join(plusDir, "website/tests/examples"), (p) => p.endsWith(".json"))) {
  for (const s of jsonStrings(JSON.parse(readFileSync(file, "utf8")))) {
    for (const line of s.split("\n")) if (STATEMENT.test(line)) add(rel(file), line.trim());
  }
}

// 5. speedle.io home page example.
const entities = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&#39;": "'" };
for (const line of readFileSync(join(plusDir, "docs/hugo/static/index.html"), "utf8").split("\n")) {
  const text = line.replace(/<[^>]*>/gu, "").replace(/&(lt|gt|amp|quot|#39);/gu, (e) => entities[e]);
  if (STATEMENT.test(text)) add("speedle-plus:docs/hugo/static/index.html", text.trim());
}

// 6. speedle-sdk e2e policies.
for (const p of JSON.parse(readFileSync(join(sdkDir, "e2e/policies.json"), "utf8")).policies) {
  add("speedle-sdk:e2e/policies.json", p.spdl);
}

// 7. Generated variants of a few seeds: missing keywords, bad conditions, bad quoting, unicode, trailing garbage.
const policySeeds = [
  "grant user alice read book",
  "grant group employee read,borrow book",
  "deny user bob borrow book if is_card_valid == false",
  "grant (user alice from corp, group devs), role admin get,put /res1, list expr:/docs/.* if a > 1",
];
const roleSeeds = [
  "grant user bob editor",
  "grant user alice, group devs role admin, reader on book, expr:^docs/.* if x > 0",
];
const mutations = [
  ["drop-effect", (s) => s.replace(/^(grant|deny)\s+/iu, "")],
  ["bad-effect", (s) => s.replace(/^(grant|deny)/iu, "allow")],
  ["upper", (s) => s.toUpperCase()],
  ["drop-principal-type", (s) => s.replace(/\b(user|group)\s+/u, "")],
  ["drop-last-token", (s) => s.replace(/\s+\S+$/u, "")],
  ["drop-condition", (s) => s.replace(/\s+if\s.*$/u, " if")],
  ["empty-condition", (s) => s.replace(/\s+if\s.*$/u, "") + " if   "],
  ["trailing-word", (s) => `${s} extra`],
  ["trailing-paren", (s) => `${s})`],
  ["trailing-comma", (s) => `${s},`],
  ["trailing-semicolon", (s) => `${s};`],
  ["trailing-crlf", (s) => `${s}\r\n`],
  ["leading-space", (s) => `  \t${s}`],
  ["nbsp", (s) => s.replace(/ /gu, "\u00a0")],
  ["ideographic-space", (s) => s.replace(/ /u, "\u3000")],
  ["nel", (s) => s.replace(/ /u, "\u0085")],
  ["bom-separator", (s) => s.replace(/ /u, "\ufeff")],
  ["zero-width-space", (s) => s.replace(/ /u, "\u200b")],
  ["line-separator", (s) => s.replace(/ /u, "\u2028")],
  ["cjk-name", (s) => s.replace(/\b(alice|bob)\b/u, "书籍")],
  ["emoji-name", (s) => s.replace(/\b(alice|bob)\b/u, "🦊")],
  ["combining-name", (s) => s.replace(/\b(alice|bob)\b/u, "e\u0301")],
  ["kelvin-keyword", (s) => s.replace(/\buser\b/u, "user\u212a")],
  ["dotted-i-keyword", (s) => s.replace(/\bif\b/u, "\u0130f")],
  ["quoted-name", (s) => s.replace(/\b(alice|bob)\b/u, "'Ann Lee'")],
  ["double-quoted-name", (s) => s.replace(/\b(alice|bob)\b/u, '"Ann Lee"')],
  ["unclosed-quote", (s) => s.replace(/\b(alice|bob)\b/u, "'Ann")],
  ["mixed-quote", (s) => s.replace(/\b(alice|bob)\b/u, "'Ann\"")],
  ["empty-quote", (s) => s.replace(/\b(alice|bob)\b/u, "''")],
  ["quote-in-name", (s) => s.replace(/\b(alice|bob)\b/u, "al'ice")],
  ["missing-idd", (s) => s.replace(/\b(alice|bob)\b/u, "$1 from")],
  ["idd", (s) => s.replace(/\b(alice|bob)\b/u, "$1 from corp")],
  ["double-comma", (s) => s.replace(/,/u, ",,")],
  ["space-comma", (s) => s.replace(/,\s*/u, " , ")],
  ["missing-resource-after-on", (s) => s.replace(/\s+on\s.*$/u, " on")],
  ["paren-principals", (s) => s.replace(/\b(user \w+)/u, "($1, group g)")],
  ["unbalanced-paren", (s) => s.replace(/\b(user \w+)/u, "($1, group g")],
  ["paren-missing-comma", (s) => s.replace(/\b(user \w+)/u, "($1 group g)")],
  ["empty-parens", (s) => s.replace(/\b(user \w+)/u, "()")],
  ["role-keyword-only", (s) => s.replace(/\s+\S+$/u, " role")],
];
const conditions = [
  "x === 1",
  "a >",
  "(a > 1",
  "a > 1)",
  "a > 1 &&",
  "'unterminated",
  '"unterminated',
  "a in (1, 2",
  "a in (1, 2)",
  "s =~ '['",
  "s =~ 'a.*'",
  "f(",
  "f(1, 2)",
  "IsSubSet(a, b)",
  "x == 'a' || y",
  "true",
  "1 + ",
  "[a b] > 1",
  "[unclosed > 1",
  "a ? b : c",
  "a ?? b",
  "x == 'R#D'",
  "名 == 1",
  "a >= 1 garbage word",
  "a == 1.2.3",
  "0x == 1",
  "!a",
  "a !",
  "request_time > '2020-01-01'",
  "a == b == c",
];
for (const seed of policySeeds) {
  for (const [name, fn] of mutations) add(`generated:${name}`, fn(seed));
  for (const c of conditions) add("generated:condition", `${seed.replace(/\s+if\s.*$/u, "")} if ${c}`);
}
for (const seed of roleSeeds) {
  for (const [name, fn] of mutations) add(`generated:${name}`, fn(seed));
  for (const c of conditions.slice(0, 10)) add("generated:condition", `${seed.replace(/\s+if\s.*$/u, "")} if ${c}`);
}

// 8. What the renderer shows agents for every statement the port parses.
const { parsePolicy, parseRolePolicy, renderPolicy, renderRolePolicy } = await import(
  new URL("../build/src/manage/spdl.js", import.meta.url).href
);
for (const { spdl } of [...entries]) {
  for (const [parse, render] of [
    [parsePolicy, renderPolicy],
    [parseRolePolicy, renderRolePolicy],
  ]) {
    try {
      add("rendered", render(parse(spdl, "n")));
    } catch {
      // Not a statement of this kind.
    }
  }
}

const commit = (dir) => execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
process.stdout.write(
  `${JSON.stringify({ speedlePlus: commit(plusDir), speedleSdk: commit(sdkDir), entries }, null, 2)}\n`,
);
