import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { InvalidRequestError, SpeedleError, TooManyRequestsError } from "../core/errors.js";
import { VERSION } from "../version.js";
import type { PmsClient } from "./client.js";
import {
  parsePolicy,
  parseRolePolicy,
  type PolicyBody,
  renderPolicy,
  renderRolePolicy,
  type RolePolicyBody,
  SPDL_SPEEDLE_PLUS_COMMIT,
  SpdlError,
} from "./spdl.js";

export const MANAGE_READ_TOOL_NAMES = [
  "list_services",
  "get_service",
  "list_policies",
  "get_policy",
  "list_role_policies",
  "get_role_policy",
  "show_effective_policies",
] as const;

export const MANAGE_WRITE_TOOL_NAMES = [
  "create_service",
  "create_policy",
  "create_role_policy",
  "delete_service",
  "delete_policy",
  "delete_role_policy",
] as const;

export const MANAGE_TOOL_NAMES = [...MANAGE_READ_TOOL_NAMES, ...MANAGE_WRITE_TOOL_NAMES] as const;

export type ManageToolName = (typeof MANAGE_TOOL_NAMES)[number];

export interface ManageServerOptions {
  /** Register only the read tools. */
  readOnly?: boolean;
}

/** The service whose role policies Speedle also applies to every other service. */
const GLOBAL_SERVICE = "global";

class ConfirmationError extends SpeedleError {}

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const createAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const deleteAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const WRITE_NOTE =
  "This tool changes live authorization policies in the configured Speedle policy management service (a self-hosted PMS or Speedle Cloud).";
const READ_NOTE = "Read-only: this tool does not change any policy.";

const serviceNameSchema = z
  .string()
  .describe(
    'Speedle service name (for example "books"). On Speedle Cloud this must be the service the token was issued for.',
  );
const effectSchema = z.enum(["grant", "deny"]).describe('Policy effect: "grant" or "deny".');
const nameSchema = z.string().describe("Human-readable policy name.");
const spdlSchema = z
  .string()
  .describe(
    `One SPDL statement, converted to the PMS JSON body locally by a port of the teramoby/speedle-plus pkg/pdl parser that is tested against the real parser at commit ${SPDL_SPEEDLE_PLUS_COMMIT.slice(0, 7)}. A statement the parser rejects fails here with its position and nothing is sent. The condition after "if" is checked by PMS when the policy is created; PMS is authoritative and rejects anything it cannot accept.` +
      " Policy: `grant user alice get,write /books/123 if clearance >= 2` (principals: user|group|role|entity NAME [from IDD]; AND principals in parentheses; `expr:REGEX` for resource expressions). Role policy: `grant user alice librarian on /books if clearance >= 2`.",
  );

const policySchema = z
  .object({
    effect: effectSchema,
    permissions: z
      .array(
        z.object({
          resource: z.string().optional().describe("Exact resource."),
          resourceExpression: z.string().optional().describe("Resource regular expression (instead of resource)."),
          actions: z.array(z.string()).describe("Actions."),
        }),
      )
      .describe("Permissions granted or denied."),
    principals: z
      .array(z.array(z.string()))
      .describe('OR-list of AND-lists of encoded principals, for example [["role:librarian"], ["user:bob"]].'),
    condition: z.string().optional().describe("Optional condition expression."),
  })
  .describe("Structured policy body (alternative to spdl).");

const rolePolicySchema = z
  .object({
    effect: effectSchema,
    roles: z.array(z.string()).describe("Roles granted or denied."),
    principals: z.array(z.string()).describe('Encoded principals, for example ["user:alice", "group:staff"].'),
    resources: z.array(z.string()).optional().describe("Optional resources the role applies to."),
    resourceExpressions: z.array(z.string()).optional().describe("Optional resource regular expressions."),
    condition: z.string().optional().describe("Optional condition expression."),
  })
  .describe("Structured role policy body (alternative to spdl).");

function ok(client: PmsClient, payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: client.redact(JSON.stringify(payload)) }] };
}

function fail(client: PmsClient, err: unknown): CallToolResult {
  const payload: Record<string, unknown> = {};
  if (err instanceof SpeedleError) {
    payload.error = err.name;
    payload.message = client.redact(err.message);
    if (err.status !== undefined) payload.status = err.status;
    if (err.code !== undefined) payload.code = client.redact(err.code);
    if (err instanceof TooManyRequestsError && err.retryAfter !== undefined) payload.retryAfter = err.retryAfter;
    if (err.quotaDailyRemaining !== undefined) payload.quotaDailyRemaining = err.quotaDailyRemaining;
  } else if (err instanceof SpdlError) {
    payload.error = err.name;
    payload.message = client.redact(err.message);
  } else {
    payload.error = "SpeedleError";
    payload.message = client.redact(err instanceof Error ? err.message : String(err));
  }
  return { isError: true, content: [{ type: "text", text: client.redact(JSON.stringify(payload)) }] };
}

function confirm(expected: string, given: string, what: string): void {
  if (given !== expected) {
    throw new ConfirmationError(
      `confirmation failed: set "confirm" to the exact ${what} ("${expected}") to delete it; nothing was changed`,
    );
  }
}

function withPolicySpdl(item: unknown): unknown {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
  return { ...item, spdl: renderPolicy(item) ?? null };
}

function withRolePolicySpdl(item: unknown): unknown {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
  return { ...item, spdl: renderRolePolicy(item) ?? null };
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function summary(item: unknown, render: (i: object) => string | undefined): unknown {
  if (typeof item !== "object" || item === null) return item;
  const { id, name } = item as { id?: unknown; name?: unknown };
  return { id, name, spdl: render(item) ?? null };
}

function policyBody(
  name: string,
  spdl: string | undefined,
  policy: z.infer<typeof policySchema> | undefined,
): PolicyBody {
  if ((spdl === undefined) === (policy === undefined)) {
    throw new InvalidRequestError('provide exactly one of "spdl" or "policy"');
  }
  if (spdl !== undefined) return parsePolicy(spdl, name);
  const body: PolicyBody = { name, ...(policy as z.infer<typeof policySchema>) };
  if (body.condition === "") delete body.condition;
  return body;
}

function rolePolicyBody(
  name: string,
  spdl: string | undefined,
  rolePolicy: z.infer<typeof rolePolicySchema> | undefined,
): RolePolicyBody {
  if ((spdl === undefined) === (rolePolicy === undefined)) {
    throw new InvalidRequestError('provide exactly one of "spdl" or "rolePolicy"');
  }
  if (spdl !== undefined) return parseRolePolicy(spdl, name);
  const body: RolePolicyBody = { name, ...(rolePolicy as z.infer<typeof rolePolicySchema>) };
  if (body.condition === "") delete body.condition;
  return body;
}

/**
 * Creates the MCP server for `manage` mode. It registers only Speedle policy
 * management tools (no authorization check tools), for a self-hosted PMS or
 * Speedle Cloud; with `readOnly`, it registers only the read tools.
 */
export function createManageServer(client: PmsClient, options: ManageServerOptions = {}): McpServer {
  const server = new McpServer({ name: "@speedle/mcp", version: VERSION });

  server.registerTool(
    "list_services",
    {
      title: "List Services",
      description: `List all Speedle services with their policies and role policies (GET /service). ${READ_NOTE}`,
      inputSchema: {},
      annotations: readAnnotations,
    },
    async (_args, extra) => {
      try {
        return ok(client, await client.listServices({ signal: extra.signal }));
      } catch (err) {
        return fail(client, err);
      }
    },
  );

  server.registerTool(
    "get_service",
    {
      title: "Get Service",
      description: `Get one Speedle service with its policies and role policies (GET /service/{serviceName}). ${READ_NOTE}`,
      inputSchema: { serviceName: serviceNameSchema },
      annotations: readAnnotations,
    },
    async (args, extra) => {
      try {
        return ok(client, await client.getService(args.serviceName, { signal: extra.signal }));
      } catch (err) {
        return fail(client, err);
      }
    },
  );

  server.registerTool(
    "list_policies",
    {
      title: "List Policies",
      description: `List the policies of a service, each with an SPDL rendering (GET /service/{serviceName}/policy). ${READ_NOTE}`,
      inputSchema: { serviceName: serviceNameSchema },
      annotations: readAnnotations,
    },
    async (args, extra) => {
      try {
        const items = await client.listPolicies(args.serviceName, { signal: extra.signal });
        return ok(client, list(items).map(withPolicySpdl));
      } catch (err) {
        return fail(client, err);
      }
    },
  );

  server.registerTool(
    "get_policy",
    {
      title: "Get Policy",
      description: `Get one policy with an SPDL rendering (GET /service/{serviceName}/policy/{policyId}). ${READ_NOTE}`,
      inputSchema: { serviceName: serviceNameSchema, policyId: z.string().describe("Policy ID.") },
      annotations: readAnnotations,
    },
    async (args, extra) => {
      try {
        const item = await client.getPolicy(args.serviceName, args.policyId, { signal: extra.signal });
        return ok(client, withPolicySpdl(item));
      } catch (err) {
        return fail(client, err);
      }
    },
  );

  server.registerTool(
    "list_role_policies",
    {
      title: "List Role Policies",
      description: `List the role policies of a service, each with an SPDL rendering (GET /service/{serviceName}/role-policy). ${READ_NOTE}`,
      inputSchema: { serviceName: serviceNameSchema },
      annotations: readAnnotations,
    },
    async (args, extra) => {
      try {
        const items = await client.listRolePolicies(args.serviceName, { signal: extra.signal });
        return ok(client, list(items).map(withRolePolicySpdl));
      } catch (err) {
        return fail(client, err);
      }
    },
  );

  server.registerTool(
    "get_role_policy",
    {
      title: "Get Role Policy",
      description: `Get one role policy with an SPDL rendering (GET /service/{serviceName}/role-policy/{rolePolicyId}). ${READ_NOTE}`,
      inputSchema: { serviceName: serviceNameSchema, rolePolicyId: z.string().describe("Role policy ID.") },
      annotations: readAnnotations,
    },
    async (args, extra) => {
      try {
        const item = await client.getRolePolicy(args.serviceName, args.rolePolicyId, { signal: extra.signal });
        return ok(client, withRolePolicySpdl(item));
      } catch (err) {
        return fail(client, err);
      }
    },
  );

  server.registerTool(
    "show_effective_policies",
    {
      title: "Show Effective Policies",
      description: `Show every policy and role policy Speedle evaluates for a service, as SPDL: the service's own policies and role policies plus the role policies of the "global" service, which apply to every service. Built from GET /service/{serviceName} and GET /service/global. On Speedle Cloud only the token's own service is visible, so the global service is reported as not found. ${READ_NOTE}`,
      inputSchema: { serviceName: serviceNameSchema },
      annotations: readAnnotations,
    },
    async (args, extra) => {
      try {
        const service = (await client.getService(args.serviceName, { signal: extra.signal })) as Record<
          string,
          unknown
        >;
        let globalRolePolicies: unknown[] = [];
        let globalServiceFound = false;
        if (args.serviceName !== GLOBAL_SERVICE) {
          try {
            const global = (await client.getService(GLOBAL_SERVICE, { signal: extra.signal })) as Record<
              string,
              unknown
            >;
            globalServiceFound = true;
            globalRolePolicies = list(global?.rolePolicies).map((p) => summary(p, renderRolePolicy));
          } catch (err) {
            if (!(err instanceof SpeedleError && err.status === 404)) throw err;
          }
        }
        const policies = list(service?.policies).map((p) => summary(p, renderPolicy));
        const rolePolicies = list(service?.rolePolicies).map((p) => summary(p, renderRolePolicy));
        return ok(client, {
          serviceName: service?.name ?? args.serviceName,
          type: service?.type,
          counts: {
            policies: policies.length,
            rolePolicies: rolePolicies.length,
            globalRolePolicies: globalRolePolicies.length,
          },
          policies,
          rolePolicies,
          globalServiceFound,
          globalRolePolicies,
          notes: [
            "A deny policy overrides a grant policy for the same request.",
            "Role policies grant roles; policies whose principals include role:NAME then apply to holders of that role.",
            'Role policies in the "global" service apply to every service.',
          ],
        });
      } catch (err) {
        return fail(client, err);
      }
    },
  );

  if (options.readOnly) return server;

  server.registerTool(
    "create_service",
    {
      title: "Create Service",
      description: `Create a Speedle service (POST /service) and return the created service. On Speedle Cloud a token is bound to one service, and this returns 409 service_exists when the service already exists or the account has reached its service limit. ${WRITE_NOTE}`,
      inputSchema: {
        name: serviceNameSchema,
        type: z
          .enum(["application", "k8s-cluster"])
          .optional()
          .describe('Service type: "application" (default) or "k8s-cluster".'),
      },
      annotations: createAnnotations,
    },
    async (args, extra) => {
      try {
        const created = await client.createService(
          { name: args.name, type: args.type ?? "application" },
          { signal: extra.signal },
        );
        return ok(client, { changed: "created", kind: "service", service: created });
      } catch (err) {
        return fail(client, err);
      }
    },
  );

  server.registerTool(
    "create_policy",
    {
      title: "Create Policy",
      description: `Create a policy in a service from one SPDL statement or a structured body (POST /service/{serviceName}/policy) and return the created policy with its ID. ${WRITE_NOTE}`,
      inputSchema: {
        serviceName: serviceNameSchema,
        name: nameSchema,
        spdl: spdlSchema.optional(),
        policy: policySchema.optional(),
      },
      annotations: createAnnotations,
    },
    async (args, extra) => {
      try {
        const body = policyBody(args.name, args.spdl, args.policy);
        const created = await client.createPolicy(args.serviceName, body, { signal: extra.signal });
        return ok(client, {
          changed: "created",
          kind: "policy",
          serviceName: args.serviceName,
          policy: withPolicySpdl(created),
        });
      } catch (err) {
        return fail(client, err);
      }
    },
  );

  server.registerTool(
    "create_role_policy",
    {
      title: "Create Role Policy",
      description: `Create a role policy in a service from one SPDL statement or a structured body (POST /service/{serviceName}/role-policy) and return the created role policy with its ID. ${WRITE_NOTE}`,
      inputSchema: {
        serviceName: serviceNameSchema,
        name: nameSchema,
        spdl: spdlSchema.optional(),
        rolePolicy: rolePolicySchema.optional(),
      },
      annotations: createAnnotations,
    },
    async (args, extra) => {
      try {
        const body = rolePolicyBody(args.name, args.spdl, args.rolePolicy);
        const created = await client.createRolePolicy(args.serviceName, body, { signal: extra.signal });
        return ok(client, {
          changed: "created",
          kind: "role_policy",
          serviceName: args.serviceName,
          rolePolicy: withRolePolicySpdl(created),
        });
      } catch (err) {
        return fail(client, err);
      }
    },
  );

  server.registerTool(
    "delete_service",
    {
      title: "Delete Service",
      description: `Delete a service and all of its policies and role policies (DELETE /service/{serviceName}). On Speedle Cloud this also revokes the service's tokens, including the one in use. Destructive: "confirm" must equal serviceName, otherwise nothing is sent. Returns the deleted service as it was. ${WRITE_NOTE}`,
      inputSchema: {
        serviceName: serviceNameSchema,
        confirm: z.string().describe("Must be exactly the serviceName being deleted."),
      },
      annotations: deleteAnnotations,
    },
    async (args, extra) => {
      try {
        confirm(args.serviceName, args.confirm, "serviceName");
        const before = (await client.getService(args.serviceName, { signal: extra.signal })) as Record<string, unknown>;
        await client.deleteService(args.serviceName, { signal: extra.signal });
        return ok(client, {
          changed: "deleted",
          kind: "service",
          serviceName: args.serviceName,
          deletedPolicies: list(before?.policies).length,
          deletedRolePolicies: list(before?.rolePolicies).length,
          service: before,
        });
      } catch (err) {
        return fail(client, err);
      }
    },
  );

  server.registerTool(
    "delete_policy",
    {
      title: "Delete Policy",
      description: `Delete one policy (DELETE /service/{serviceName}/policy/{policyId}). Destructive: "confirm" must equal policyId, otherwise nothing is sent. Returns the deleted policy as it was. ${WRITE_NOTE}`,
      inputSchema: {
        serviceName: serviceNameSchema,
        policyId: z.string().describe("Policy ID."),
        confirm: z.string().describe("Must be exactly the policyId being deleted."),
      },
      annotations: deleteAnnotations,
    },
    async (args, extra) => {
      try {
        confirm(args.policyId, args.confirm, "policyId");
        const before = await client.getPolicy(args.serviceName, args.policyId, { signal: extra.signal });
        await client.deletePolicy(args.serviceName, args.policyId, { signal: extra.signal });
        return ok(client, {
          changed: "deleted",
          kind: "policy",
          serviceName: args.serviceName,
          policy: withPolicySpdl(before),
        });
      } catch (err) {
        return fail(client, err);
      }
    },
  );

  server.registerTool(
    "delete_role_policy",
    {
      title: "Delete Role Policy",
      description: `Delete one role policy (DELETE /service/{serviceName}/role-policy/{rolePolicyId}). Destructive: "confirm" must equal rolePolicyId, otherwise nothing is sent. Returns the deleted role policy as it was. ${WRITE_NOTE}`,
      inputSchema: {
        serviceName: serviceNameSchema,
        rolePolicyId: z.string().describe("Role policy ID."),
        confirm: z.string().describe("Must be exactly the rolePolicyId being deleted."),
      },
      annotations: deleteAnnotations,
    },
    async (args, extra) => {
      try {
        confirm(args.rolePolicyId, args.confirm, "rolePolicyId");
        const before = await client.getRolePolicy(args.serviceName, args.rolePolicyId, { signal: extra.signal });
        await client.deleteRolePolicy(args.serviceName, args.rolePolicyId, { signal: extra.signal });
        return ok(client, {
          changed: "deleted",
          kind: "role_policy",
          serviceName: args.serviceName,
          rolePolicy: withRolePolicySpdl(before),
        });
      } catch (err) {
        return fail(client, err);
      }
    },
  );

  return server;
}
