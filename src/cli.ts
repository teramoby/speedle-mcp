#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCheckServer } from "./check/server.js";
import { SpeedleClient } from "./core/client.js";
import { loadAdsConfig } from "./core/config.js";
import { redactSecret } from "./core/errors.js";

export const USAGE = `Usage: speedle-mcp <mode>

Modes:
  check    Start the read-only authorization check MCP server (ADS)
  manage   Start the policy management MCP server (PMS)

There is no default mode that exposes both tool sets.

Environment variables (check mode):
  SPEEDLE_ENDPOINT              ADS base URL (e.g. https://cloud.speedle.io or http://127.0.0.1:6734)
  SPEEDLE_SERVICE_NAME          Service name to evaluate against
  SPEEDLE_TOKEN                 Optional bearer token (spdl_... for Speedle Cloud; requires https://)
  SPEEDLE_BACKEND               Optional "speedle-cloud" or "speedle-plus"
  SPEEDLE_ALLOW_INSECURE_HTTP   Optional "true" to allow non-loopback http:// on speedle-plus
  SPEEDLE_CA_CERT               Optional extra PEM CA certificate for https://
`;

function redactEnvToken(text: string, env: NodeJS.ProcessEnv): string {
  let out = text;
  for (const candidate of [env.SPEEDLE_TOKEN, env.SPEEDLE_ADS_TOKEN]) {
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
  if (argv.length !== 1) {
    writeStderr(USAGE);
    return 1;
  }

  const mode = argv[0];
  if (mode === "manage") {
    writeStderr("speedle-mcp: manage mode is not implemented in this version.\n\n" + USAGE);
    return 1;
  }
  if (mode !== "check") {
    writeStderr(USAGE);
    return 1;
  }

  let client: SpeedleClient;
  try {
    const config = loadAdsConfig(env);
    client = new SpeedleClient(config);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    writeStderr(`speedle-mcp: ${redactEnvToken(raw, env)}\n`);
    return 1;
  }

  const server = createCheckServer(client);
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
