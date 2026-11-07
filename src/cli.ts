#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { assertCheckServerOptions, type CheckServerOptions, createCheckServer } from "./check/server.js";
import { SpeedleClient } from "./core/client.js";
import { loadAdsConfig, loadPmsConfig } from "./core/config.js";
import { redactSecret } from "./core/errors.js";
import { PmsClient } from "./manage/client.js";
import { createManageServer } from "./manage/server.js";

export const USAGE = `Usage: speedle-mcp <mode> [options]

Modes:
  check [options]      Start the read-only authorization check MCP server (ADS);
                       only is_allowed is registered by default
  manage [--read-only] Start the policy management MCP server (PMS);
                       --read-only registers only the read tools

Check options:
  --expose-diagnose                 Also register diagnose (self-hosted Speedle only)
  --expose-all-granted-roles        Also register all_granted_roles
  --expose-all-granted-permissions  Also register all_granted_permissions

There is no default mode that exposes both tool sets.

Environment variables (check mode):
  SPEEDLE_ENDPOINT                         ADS base URL (e.g. https://cloud.speedle.io or http://127.0.0.1:6734)
  SPEEDLE_SERVICE_NAME                     Service name to evaluate against
  SPEEDLE_TOKEN                            Optional bearer token (spdl_... for Speedle Cloud; requires https://)
  SPEEDLE_BACKEND                          Optional "speedle-cloud" or "speedle"
  SPEEDLE_ALLOW_INSECURE_HTTP              Optional "true" to allow non-loopback http:// on backend "speedle"
  SPEEDLE_CA_CERT                          Optional extra PEM CA certificate for https://
  SPEEDLE_EXPOSE_DIAGNOSE                  Optional "true" to register diagnose (self-hosted Speedle only)
  SPEEDLE_EXPOSE_ALL_GRANTED_ROLES         Optional "true" to register all_granted_roles
  SPEEDLE_EXPOSE_ALL_GRANTED_PERMISSIONS   Optional "true" to register all_granted_permissions

Environment variables (manage mode):
  SPEEDLE_PMS_ENDPOINT              PMS base URL (e.g. http://127.0.0.1:6733)
  SPEEDLE_PMS_TOKEN                 Optional bearer token (requires https://)
  SPEEDLE_PMS_CERT, SPEEDLE_PMS_KEY Optional PEM client certificate and key for mutual TLS
  SPEEDLE_PMS_ALLOW_INSECURE_HTTP   Optional "true" to allow non-loopback http://
  SPEEDLE_PMS_CA_CERT               Optional extra PEM CA certificate for https://
  SPEEDLE_PMS_READ_ONLY             Optional "true" to register only the read tools
`;

function redactEnvToken(text: string, env: NodeJS.ProcessEnv): string {
  let out = text;
  for (const candidate of [env.SPEEDLE_TOKEN, env.SPEEDLE_ADS_TOKEN, env.SPEEDLE_PMS_TOKEN, env.SPEEDLE_PMS_KEY]) {
    out = redactSecret(out, candidate);
  }
  return out;
}

export async function runCli(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  writeStderr: (text: string) => void = (t) => {
    process.stderr.write(t);
  },
): Promise<number> {
  const [mode, ...flags] = argv;
  const readOnlyFlag = mode === "manage" && flags.length === 1 && flags[0] === "--read-only";
  const checkFlags: Required<CheckServerOptions> = {
    exposeDiagnose: false,
    exposeAllGrantedRoles: false,
    exposeAllGrantedPermissions: false,
  };
  let validFlags = true;
  if (mode === "check") {
    for (const flag of flags) {
      if (flag === "--expose-diagnose") checkFlags.exposeDiagnose = true;
      else if (flag === "--expose-all-granted-roles") checkFlags.exposeAllGrantedRoles = true;
      else if (flag === "--expose-all-granted-permissions") checkFlags.exposeAllGrantedPermissions = true;
      else validFlags = false;
    }
  } else if (mode === "manage" && flags.length > 0 && !readOnlyFlag) {
    validFlags = false;
  }
  if ((mode !== "check" && mode !== "manage") || !validFlags) {
    writeStderr(USAGE);
    return 1;
  }

  let client: SpeedleClient | PmsClient;
  let server: McpServer;
  try {
    if (mode === "check") {
      const { exposeDiagnose, exposeAllGrantedRoles, exposeAllGrantedPermissions, ...clientOptions } =
        loadAdsConfig(env);
      const checkOptions: CheckServerOptions = {
        exposeDiagnose: exposeDiagnose || checkFlags.exposeDiagnose,
        exposeAllGrantedRoles: exposeAllGrantedRoles || checkFlags.exposeAllGrantedRoles,
        exposeAllGrantedPermissions: exposeAllGrantedPermissions || checkFlags.exposeAllGrantedPermissions,
      };
      assertCheckServerOptions(clientOptions.backend, checkOptions);
      const speedle = new SpeedleClient(clientOptions);
      client = speedle;
      server = createCheckServer(speedle, checkOptions);
    } else {
      const { readOnly, ...options } = loadPmsConfig(env);
      const pms = new PmsClient(options);
      client = pms;
      server = createManageServer(pms, { readOnly: readOnly || readOnlyFlag });
    }
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    writeStderr(`speedle-mcp: ${redactEnvToken(raw, env)}\n`);
    return 1;
  }

  const transport = new StdioServerTransport();

  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    await server.close().catch(() => undefined);
    await client.close().catch(() => undefined);
  };

  process.once("SIGINT", () => {
    void cleanup().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void cleanup().finally(() => process.exit(0));
  });

  try {
    await server.connect(transport);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    writeStderr(`speedle-mcp: ${client.redact(redactEnvToken(raw, env))}\n`);
    await cleanup();
    return 1;
  }

  return 0;
}

function isEntrypoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return argv1.endsWith("/cli.js") || argv1.endsWith("\\cli.js") || argv1.endsWith("/speedle-mcp");
  }
}

if (isEntrypoint()) {
  runCli().then(
    (code) => {
      if (code !== 0) process.exit(code);
    },
    (err: unknown) => {
      const raw = err instanceof Error ? err.message : String(err);
      process.stderr.write(`speedle-mcp: ${redactEnvToken(raw, process.env)}\n`);
      process.exit(1);
    },
  );
}
