import { Auth } from "./auth.js";
import { ConfigurationError } from "./errors.js";
import { type Backend, type ClientOptions, resolveOptions } from "./options.js";

/**
 * Reads ADS configuration from environment variables for `check` mode.
 *
 * Supported variables:
 * - `SPEEDLE_ENDPOINT` (or `SPEEDLE_ADS_ENDPOINT` / `SPEEDLE_ADS_URL`): ADS base URL (required)
 * - `SPEEDLE_SERVICE_NAME` (or `SPEEDLE_SERVICE`): service name (required)
 * - `SPEEDLE_TOKEN` (or `SPEEDLE_ADS_TOKEN`): optional bearer token (`spdl_…`)
 * - `SPEEDLE_BACKEND`: optional `"speedle-cloud"` or `"speedle-plus"` (defaults to `"speedle-cloud"` when a token is set and `"speedle-plus"` otherwise)
 * - `SPEEDLE_ALLOW_INSECURE_HTTP`: optional `"true"` or `"1"` to permit non-loopback `http://` on `speedle-plus` without a token
 * - `SPEEDLE_CA_CERT`: optional PEM trust anchor for self-hosted HTTPS endpoints
 *
 * PMS configuration variables (`SPEEDLE_PMS_*`) are never read in `check` mode.
 */
export function loadAdsConfig(env: NodeJS.ProcessEnv = process.env): ClientOptions {
  const endpoint = (env.SPEEDLE_ENDPOINT ?? env.SPEEDLE_ADS_ENDPOINT ?? env.SPEEDLE_ADS_URL ?? "").trim();
  if (endpoint === "") {
    throw new ConfigurationError(
      "SPEEDLE_ENDPOINT is required (for example https://cloud.speedle.io or http://127.0.0.1:6734)",
    );
  }

  const serviceName = (env.SPEEDLE_SERVICE_NAME ?? env.SPEEDLE_SERVICE ?? "").trim();
  if (serviceName === "") {
    throw new ConfigurationError("SPEEDLE_SERVICE_NAME is required");
  }

  const rawToken = env.SPEEDLE_TOKEN ?? env.SPEEDLE_ADS_TOKEN;
  const auth = rawToken !== undefined && rawToken !== "" ? Auth.bearer(rawToken) : Auth.none();

  const rawBackend = env.SPEEDLE_BACKEND?.trim();
  let backend: Backend;
  if (rawBackend === undefined || rawBackend === "") {
    backend = auth.kind === "bearer" ? "speedle-cloud" : "speedle-plus";
  } else if (rawBackend === "speedle-cloud" || rawBackend === "speedle-plus") {
    backend = rawBackend;
  } else {
    throw new ConfigurationError('SPEEDLE_BACKEND must be "speedle-cloud" or "speedle-plus"');
  }

  const allowInsecureRaw = env.SPEEDLE_ALLOW_INSECURE_HTTP?.trim().toLowerCase();
  const allowInsecureHttp = allowInsecureRaw === "true" || allowInsecureRaw === "1";

  const caCert = env.SPEEDLE_CA_CERT !== undefined && env.SPEEDLE_CA_CERT !== "" ? env.SPEEDLE_CA_CERT : undefined;

  const options: ClientOptions = {
    backend,
    endpoint,
    auth,
    serviceName,
    allowInsecureHttp,
    caCert,
    userAgentSuffix: "speedle-mcp",
  };

  // Validate options immediately and close the temporary agent created during validation.
  const resolved = resolveOptions(options);
  resolved.agent.destroy();

  return options;
}
