/**
 * SPDL (Speedle policy definition language) helpers for `manage` mode.
 *
 * `parsePolicy` and `parseRolePolicy` are a port of the statement parser in
 * teramoby/speedle-plus `pkg/pdl/pdl.go` (the one `spctl` uses before it calls
 * the PMS REST API). They turn one SPDL statement into the JSON body that
 * `POST /policy-mgmt/v1/service/{serviceName}/policy` (or `/role-policy`)
 * accepts. The condition after `if` is passed through as text: PMS checks its
 * syntax when the policy is created, because the PMS API has no separate
 * validation endpoint.
 *
 * `renderPolicy` and `renderRolePolicy` go the other way, so an agent can read
 * stored policies as SPDL.
 */

export interface Permission {
  resource?: string;
  resourceExpression?: string;
  actions?: string[];
}

export interface PolicyBody {
  name: string;
  effect: "grant" | "deny";
  permissions: Permission[];
  principals: string[][];
  condition?: string;
}

export interface RolePolicyBody {
  name: string;
  effect: "grant" | "deny";
  roles: string[];
  principals: string[];
  resources?: string[];
  resourceExpressions?: string[];
  condition?: string;
}

/** A parse error with the position of the offending input. */
export class SpdlError extends Error {
  readonly position: number;
  constructor(reason: string, cmd: string, position: number) {
    super(`${reason}\n${cmd}\n${" ".repeat(Math.max(0, position))}^`);
    this.name = "SpdlError";
    this.position = position;
  }
}

const PRINCIPAL_TYPES = ["user", "group", "role", "entity"] as const;
const RES_EXPR_PREFIX = "expr:";

function isSpace(ch: string | undefined): boolean {
  return ch !== undefined && /\s/u.test(ch);
}

function skipSpaces(cmd: string, i: number): number {
  while (i < cmd.length && isSpace(cmd[i])) i++;
  return i;
}

/** Recognises a whole keyword (case-insensitive) followed by whitespace or the end. */
function keyword(cmd: string, i: number, word: string): [number, boolean] {
  const end = i + word.length;
  if (end > cmd.length || cmd.slice(i, end).toLowerCase() !== word) return [i, false];
  if (end === cmd.length) return [end, true];
  if (!isSpace(cmd[end])) return [i, false];
  return [end + 1, true];
}

function getToken(cmd: string, i: number): [string, number] {
  i = skipSpaces(cmd, i);
  if (i >= cmd.length) return ["", i];
  const quote = cmd[i];
  if (quote === '"' || quote === "'") {
    let out = "";
    for (i++; i < cmd.length; i++) {
      if (cmd[i] === quote) return [out, i + 1];
      out += cmd[i];
    }
    // A partial quoted name never becomes an ordinary token.
    return ["", i];
  }
  const start = i;
  while (i < cmd.length) {
    const ch = cmd[i];
    if (isSpace(ch) || ch === "," || ch === "(" || ch === ")") break;
    i++;
  }
  return [cmd.slice(start, i), i];
}

function getTokens(cmd: string, i: number, what: string): [string[], number] {
  const tokens: string[] = [];
  let t: string;
  [t, i] = getToken(cmd, i);
  if (t === "") return [tokens, i];
  tokens.push(t);
  i = skipSpaces(cmd, i);
  while (i < cmd.length && cmd[i] === ",") {
    [t, i] = getToken(cmd, i + 1);
    if (t === "") throw new SpdlError(`Not found ${what}`, cmd, i);
    tokens.push(t);
    i = skipSpaces(cmd, i);
  }
  return [tokens, i];
}

function getEffect(cmd: string): ["grant" | "deny", number] {
  const i = skipSpaces(cmd, 0);
  for (const effect of ["grant", "deny"] as const) {
    const [end, ok] = keyword(cmd, i, effect);
    if (ok) return [effect, end];
  }
  throw new SpdlError("Not found valid effect", cmd, i);
}

function getPrincipal(cmd: string, i: number): [string, number] {
  i = skipSpaces(cmd, i);
  let type: string | undefined;
  for (const kind of PRINCIPAL_TYPES) {
    const [end, ok] = keyword(cmd, i, kind);
    if (ok) {
      type = kind;
      i = end;
      break;
    }
  }
  if (type === undefined) throw new SpdlError("Not found principal type (user|group|role|entity)", cmd, i);
  let name: string;
  [name, i] = getToken(cmd, i);
  if (name === "") throw new SpdlError("Not found principal name", cmd, i);
  i = skipSpaces(cmd, i);
  const [end, hasFrom] = keyword(cmd, i, "from");
  if (hasFrom) {
    let idd: string;
    [idd, i] = getToken(cmd, skipSpaces(cmd, end));
    if (idd === "") throw new SpdlError('No idd found after key word "from"', cmd, i);
    return [`idd=${idd}:${type}:${name}`, i];
  }
  return [`${type}:${name}`, i];
}

function expectMore(cmd: string, i: number): void {
  if (i >= cmd.length) throw new SpdlError("Unexpected EOF found", cmd, i);
}

function getAndPrincipals(cmd: string, i: number): [string[], number] {
  i = skipSpaces(cmd, i);
  expectMore(cmd, i);
  if (cmd[i] !== "(") {
    const [p, next] = getPrincipal(cmd, i);
    return [[p], next];
  }
  i = skipSpaces(cmd, i + 1);
  expectMore(cmd, i);
  const principals: string[] = [];
  let p: string;
  [p, i] = getPrincipal(cmd, i);
  principals.push(p);
  i = skipSpaces(cmd, i);
  expectMore(cmd, i);
  while (cmd[i] !== ")") {
    if (cmd[i] !== ",") throw new SpdlError("Principals should be separated by commas", cmd, i);
    i++;
    expectMore(cmd, i);
    [p, i] = getPrincipal(cmd, i);
    principals.push(p);
    i = skipSpaces(cmd, i);
    expectMore(cmd, i);
  }
  return [principals, i + 1];
}

function getOrPrincipals(cmd: string, i: number): [string[][], number] {
  const out: string[][] = [];
  let and: string[];
  [and, i] = getAndPrincipals(cmd, i);
  out.push(and);
  i = skipSpaces(cmd, i);
  expectMore(cmd, i);
  while (cmd[i] === ",") {
    [and, i] = getAndPrincipals(cmd, i + 1);
    out.push(and);
    i = skipSpaces(cmd, i);
    expectMore(cmd, i);
  }
  return [out, i];
}

function getRolePolicyPrincipals(cmd: string, i: number): [string[], number] {
  const out: string[] = [];
  let p: string;
  [p, i] = getPrincipal(cmd, i);
  out.push(p);
  i = skipSpaces(cmd, i);
  expectMore(cmd, i);
  while (cmd[i] === ",") {
    [p, i] = getPrincipal(cmd, i + 1);
    out.push(p);
    i = skipSpaces(cmd, i);
    expectMore(cmd, i);
  }
  return [out, i];
}

function getRoles(cmd: string, i: number): [string[], number] {
  const roles: string[] = [];
  let t: string;
  [t, i] = getToken(cmd, i);
  if (t.toLowerCase() === "role") [t, i] = getToken(cmd, i);
  if (t === "") return [roles, i];
  roles.push(t);
  i = skipSpaces(cmd, i);
  while (i < cmd.length && cmd[i] === ",") {
    [t, i] = getToken(cmd, i + 1);
    if (t.toLowerCase() === "role") [t, i] = getToken(cmd, i);
    if (t === "") throw new SpdlError("Not found role", cmd, i);
    roles.push(t);
    i = skipSpaces(cmd, i);
  }
  return [roles, i];
}

function toPermission(actions: string[], res: string): Permission {
  return res.startsWith(RES_EXPR_PREFIX)
    ? { resourceExpression: res.slice(RES_EXPR_PREFIX.length), actions }
    : { resource: res, actions };
}

function getPermission(cmd: string, i: number): [Permission, number] {
  let actions: string[];
  [actions, i] = getTokens(cmd, i, "action");
  if (actions.length === 0) throw new SpdlError("Not found permission", cmd, i);
  let res: string;
  [res, i] = getToken(cmd, i);
  if (res === "") throw new SpdlError("Not found permission", cmd, i);
  return [toPermission(actions, res), i];
}

function getPermissions(cmd: string, i: number): [Permission[], number] {
  const perms: Permission[] = [];
  let p: Permission;
  [p, i] = getPermission(cmd, i);
  perms.push(p);
  i = skipSpaces(cmd, i);
  while (i < cmd.length && cmd[i] === ",") {
    [p, i] = getPermission(cmd, i + 1);
    perms.push(p);
    i = skipSpaces(cmd, i);
  }
  return [perms, i];
}

function getResources(cmd: string, i: number): [string[], string[], number] {
  i = skipSpaces(cmd, i);
  const [end, ok] = keyword(cmd, i, "on");
  if (!ok) return [[], [], i];
  let tokens: string[];
  [tokens, i] = getTokens(cmd, end, "resource");
  if (tokens.length === 0) throw new SpdlError("Not found resource", cmd, i);
  const resources: string[] = [];
  const expressions: string[] = [];
  for (const t of tokens) {
    if (t.startsWith(RES_EXPR_PREFIX)) expressions.push(t.slice(RES_EXPR_PREFIX.length));
    else resources.push(t);
  }
  return [resources, expressions, i];
}

function getCondition(cmd: string, i: number): [string, number] {
  i = skipSpaces(cmd, i);
  const [end, ok] = keyword(cmd, i, "if");
  if (!ok) return ["", i];
  i = skipSpaces(cmd, end);
  expectMore(cmd, i);
  return [cmd.slice(i).trimEnd(), cmd.length];
}

function checkEnd(cmd: string, i: number): void {
  if (skipSpaces(cmd, i) !== cmd.length) throw new SpdlError("Unexpected trailing input", cmd, i);
}

/** Parses one SPDL policy statement, for example `grant user alice get,write /books/123 if clearance >= 2`. */
export function parsePolicy(cmd: string, name: string): PolicyBody {
  const [effect, i1] = getEffect(cmd);
  const [principals, i2] = getOrPrincipals(cmd, i1);
  const [permissions, i3] = getPermissions(cmd, i2);
  const [condition, i4] = getCondition(cmd, i3);
  checkEnd(cmd, i4);
  const body: PolicyBody = { name, effect, permissions, principals };
  if (condition !== "") body.condition = condition;
  return body;
}

/** Parses one SPDL role policy statement, for example `grant user alice librarian on /books if clearance >= 2`. */
export function parseRolePolicy(cmd: string, name: string): RolePolicyBody {
  const [effect, i1] = getEffect(cmd);
  const [principals, i2] = getRolePolicyPrincipals(cmd, i1);
  const [roles, i3] = getRoles(cmd, i2);
  if (roles.length === 0) throw new SpdlError("No role found", cmd, i3);
  const [resources, resourceExpressions, i4] = getResources(cmd, i3);
  const [condition, i5] = getCondition(cmd, i4);
  checkEnd(cmd, i5);
  const body: RolePolicyBody = { name, effect, roles, principals };
  if (resources.length > 0) body.resources = resources;
  if (resourceExpressions.length > 0) body.resourceExpressions = resourceExpressions;
  if (condition !== "") body.condition = condition;
  return body;
}

const KEYWORDS = new Set(["grant", "deny", "user", "group", "role", "entity", "from", "on", "if"]);

/** Quotes a token so that `getToken` reads it back unchanged, or returns undefined if that is impossible. */
function quote(token: string): string | undefined {
  if (
    token !== "" &&
    !/[\s,()]/u.test(token) &&
    token[0] !== '"' &&
    token[0] !== "'" &&
    !KEYWORDS.has(token.toLowerCase())
  )
    return token;
  if (!token.includes('"')) return `"${token}"`;
  if (!token.includes("'")) return `'${token}'`;
  return undefined;
}

function renderPrincipal(encoded: string): string | undefined {
  const types = PRINCIPAL_TYPES.join("|");
  const idd = new RegExp(`^idd=(.+):(${types}):(.+)$`, "su").exec(encoded);
  const plain = new RegExp(`^(${types}):(.+)$`, "su").exec(encoded);
  const m = idd ?? plain;
  if (!m) return undefined;
  const type = idd ? m[2] : m[1];
  const name = quote(idd ? (m[3] as string) : (m[2] as string));
  if (name === undefined) return undefined;
  if (!idd) return `${type} ${name}`;
  const from = quote(m[1] as string);
  return from === undefined ? undefined : `${type} ${name} from ${from}`;
}

function renderList(
  items: readonly string[] | undefined,
  render: (s: string) => string | undefined,
): string[] | undefined {
  const out: string[] = [];
  for (const item of items ?? []) {
    const r = render(item);
    if (r === undefined) return undefined;
    out.push(r);
  }
  return out;
}

interface StoredPolicy {
  effect?: unknown;
  permissions?: unknown;
  principals?: unknown;
  condition?: unknown;
}

interface StoredRolePolicy {
  effect?: unknown;
  roles?: unknown;
  principals?: unknown;
  resources?: unknown;
  resourceExpressions?: unknown;
  condition?: unknown;
}

function strings(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) && value.every((v): v is string => typeof v === "string") ? value : undefined;
}

function effectOf(value: unknown): string | undefined {
  return value === "grant" || value === "deny" ? value : undefined;
}

function conditionSuffix(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return "";
  return typeof value === "string" && !value.includes("\n") ? ` if ${value}` : undefined;
}

/** Renders a stored policy as one SPDL statement, or undefined if SPDL cannot express it. */
export function renderPolicy(policy: StoredPolicy): string | undefined {
  const effect = effectOf(policy.effect);
  const cond = conditionSuffix(policy.condition);
  if (effect === undefined || cond === undefined) return undefined;
  if (!Array.isArray(policy.principals) || policy.principals.length === 0) return undefined;
  const groups: string[] = [];
  for (const group of policy.principals as unknown[]) {
    const members = renderList(strings(group), renderPrincipal);
    if (!members || members.length === 0) return undefined;
    groups.push(members.length === 1 ? (members[0] as string) : `(${members.join(", ")})`);
  }
  if (!Array.isArray(policy.permissions) || policy.permissions.length === 0) return undefined;
  const perms: string[] = [];
  for (const raw of policy.permissions as unknown[]) {
    if (typeof raw !== "object" || raw === null) return undefined;
    const p = raw as Permission;
    const actions = renderList(strings(p.actions), quote);
    if (!actions || actions.length === 0) return undefined;
    const res =
      typeof p.resourceExpression === "string" && p.resourceExpression !== ""
        ? quote(RES_EXPR_PREFIX + p.resourceExpression)
        : typeof p.resource === "string" && !p.resource.startsWith(RES_EXPR_PREFIX)
          ? quote(p.resource)
          : undefined;
    if (res === undefined) return undefined;
    perms.push(`${actions.join(",")} ${res}`);
  }
  return `${effect} ${groups.join(", ")} ${perms.join(", ")}${cond}`;
}

/** Renders a stored role policy as one SPDL statement, or undefined if SPDL cannot express it. */
export function renderRolePolicy(policy: StoredRolePolicy): string | undefined {
  const effect = effectOf(policy.effect);
  const cond = conditionSuffix(policy.condition);
  if (effect === undefined || cond === undefined) return undefined;
  const principals = renderList(strings(policy.principals), renderPrincipal);
  if (!principals || principals.length === 0) return undefined;
  const roleNames = strings(policy.roles);
  if (!roleNames || roleNames.length === 0 || roleNames.some((r) => r.toLowerCase() === "role")) return undefined;
  const roles = renderList(roleNames, quote);
  const resources = renderList(strings(policy.resources), (r) =>
    r.startsWith(RES_EXPR_PREFIX) ? undefined : quote(r),
  );
  const exprs = renderList(strings(policy.resourceExpressions), (e) => quote(RES_EXPR_PREFIX + e));
  if (!roles || !resources || !exprs) return undefined;
  const on = [...resources, ...exprs];
  return `${effect} ${principals.join(", ")} ${roles.join(", ")}${on.length > 0 ? ` on ${on.join(", ")}` : ""}${cond}`;
}
