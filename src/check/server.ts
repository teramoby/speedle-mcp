import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Attributes } from "../core/attributes.js";
import type { Principal, SpeedleClient, Subject } from "../core/client.js";
import { InvalidRequestError, SpeedleError, TooManyRequestsError } from "../core/errors.js";
import { VERSION } from "../version.js";

export const CHECK_TOOL_NAMES = ["is_allowed", "diagnose", "all_granted_roles", "all_granted_permissions"] as const;

export type CheckToolName = (typeof CHECK_TOOL_NAMES)[number];

const principalSchema = z.object({
  type: z.string().optional().describe('Principal type ("user", "group", "role", or "entity"). Defaults to "user".'),
  name: z.string().describe("Principal name (non-empty)."),
  idd: z.string().optional().describe("Optional identity domain."),
});

const subjectSchema = z
  .union([
    z.string().describe('User principal name (shorthand for [{ type: "user", name }]).'),
    z.array(principalSchema).describe("Non-empty list of principals representing the subject."),
    z.object({
      principals: z.array(principalSchema).describe("Non-empty list of principals representing the subject."),
    }),
  ])
  .describe("Subject to evaluate: a user name string or a non-empty list of principals.");

const typedAttributeSchema = z.object({
  name: z.string().describe("Attribute name (non-empty, unique within the request)."),
  type: z.string().describe('Speedle+ attribute type: "string", "numeric", "bool", or "datetime".'),
  value: z
    .unknown()
    .describe(
      "Single value or array of values matching the attribute type. For datetime, use RFC 3339 strings with a time zone (for example 2026-11-05T03:00:00Z).",
    ),
});

const attributesSchema = z
  .union([z.array(typedAttributeSchema), z.record(z.string(), z.unknown())])
  .optional()
  .describe(
    "Optional request attributes: either an array of typed { name, type, value } items or a plain object whose types are inferred (strings are always string).",
  );

function normalizeSubject(raw: unknown): Subject {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw as Principal[];
  if (raw !== null && typeof raw === "object" && "principals" in raw) {
    const principals = (raw as { principals?: unknown }).principals;
    if (Array.isArray(principals)) return principals as Principal[];
  }
  throw new InvalidRequestError("subject must be a user name or a non-empty list of principals");
}

function formatSuccess(client: SpeedleClient, payload: unknown): CallToolResult {
  const text = client.redact(JSON.stringify(payload));
  return {
    content: [{ type: "text", text }],
  };
}

function formatError(client: SpeedleClient, err: unknown): CallToolResult {
  if (err instanceof SpeedleError) {
    const payload: Record<string, unknown> = {
      error: err.name,
      message: client.redact(err.message),
    };
    if (err.status !== undefined) payload.status = err.status;
    if (err.code !== undefined) payload.code = client.redact(err.code);
    if (err instanceof TooManyRequestsError && err.retryAfter !== undefined) {
      payload.retryAfter = err.retryAfter;
    }
    if (err.quotaDailyRemaining !== undefined) {
      payload.quotaDailyRemaining = err.quotaDailyRemaining;
    }
    return {
      isError: true,
      content: [{ type: "text", text: client.redact(JSON.stringify(payload)) }],
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: client.redact(JSON.stringify({ error: "SpeedleError", message: client.redact(message) })),
      },
    ],
  };
}

/**
 * Creates the MCP server for `check` mode, registering only the four read-only
 * authorization check tools against the configured Speedle ADS client.
 */
export function createCheckServer(client: SpeedleClient): McpServer {
  const server = new McpServer({
    name: "@speedle/mcp",
    version: VERSION,
  });

  const readOnlyAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  } as const;

  server.registerTool(
    "is_allowed",
    {
      title: "Check if Action is Allowed",
      description:
        "Check whether a subject is allowed to perform an action on a resource in the configured Speedle service (/authz-check/v1/is-allowed). This tool only answers authorization questions and does not enforce anything or modify policies.",
      inputSchema: {
        subject: subjectSchema,
        resource: z.string().describe('Resource identifier (for example "/books/123").'),
        action: z.string().describe('Action name (for example "get" or "write").'),
        attributes: attributesSchema,
      },
      annotations: readOnlyAnnotations,
    },
    async (args, extra) => {
      try {
        const subject = normalizeSubject(args.subject);
        const decision = await client.check(
          subject,
          args.action,
          args.resource,
          args.attributes as Attributes | undefined,
          { signal: extra.signal },
        );
        return formatSuccess(client, decision);
      } catch (err) {
        return formatError(client, err);
      }
    },
  );

  server.registerTool(
    "diagnose",
    {
      title: "Diagnose Authorization Decision",
      description:
        "Diagnose why a subject is allowed or denied an action on a resource in the configured Speedle service (/authz-check/v1/diagnose), returning matched policies, role policies, granted roles, and condition evaluations. This tool only answers authorization questions and does not enforce anything or modify policies.",
      inputSchema: {
        subject: subjectSchema,
        resource: z.string().describe('Resource identifier (for example "/books/123").'),
        action: z.string().describe('Action name (for example "get" or "write").'),
        attributes: attributesSchema,
      },
      annotations: readOnlyAnnotations,
    },
    async (args, extra) => {
      try {
        const subject = normalizeSubject(args.subject);
        const result = await client.diagnose(
          subject,
          args.action,
          args.resource,
          args.attributes as Attributes | undefined,
          { signal: extra.signal },
        );
        return formatSuccess(client, result);
      } catch (err) {
        return formatError(client, err);
      }
    },
  );

  server.registerTool(
    "all_granted_roles",
    {
      title: "List All Granted Roles",
      description:
        "List all roles granted to a subject in the configured Speedle service (/authz-check/v1/all-granted-roles). This tool only answers authorization questions and does not enforce anything or modify policies.",
      inputSchema: {
        subject: subjectSchema,
        resource: z.string().optional().describe("Optional resource context for role evaluation."),
        action: z.string().optional().describe("Optional action context for role evaluation."),
        attributes: attributesSchema,
      },
      annotations: readOnlyAnnotations,
    },
    async (args, extra) => {
      try {
        const subject = normalizeSubject(args.subject);
        const roles = await client.allGrantedRoles(subject, args.attributes as Attributes | undefined, {
          resource: args.resource,
          action: args.action,
          signal: extra.signal,
        });
        return formatSuccess(client, roles);
      } catch (err) {
        return formatError(client, err);
      }
    },
  );

  server.registerTool(
    "all_granted_permissions",
    {
      title: "List All Granted Permissions",
      description:
        "List all permissions (resource and actions) granted to a subject in the configured Speedle service (/authz-check/v1/all-granted-permissions). This tool only answers authorization questions and does not enforce anything or modify policies.",
      inputSchema: {
        subject: subjectSchema,
        resource: z.string().optional().describe("Optional resource context for permission evaluation."),
        action: z.string().optional().describe("Optional action context for permission evaluation."),
        attributes: attributesSchema,
      },
      annotations: readOnlyAnnotations,
    },
    async (args, extra) => {
      try {
        const subject = normalizeSubject(args.subject);
        const permissions = await client.allGrantedPermissions(subject, args.attributes as Attributes | undefined, {
          resource: args.resource,
          action: args.action,
          signal: extra.signal,
        });
        return formatSuccess(client, permissions);
      } catch (err) {
        return formatError(client, err);
      }
    },
  );

  return server;
}
