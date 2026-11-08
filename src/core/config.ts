import { Auth } from "./auth.js";
import { ConfigurationError } from "./errors.js";
import {
  type Backend,
  type ClientOptions,
  type PmsClientOptions,
  resolveOptions,
  resolvePmsOptions,
} from "./options.js";

export interface AdsConfig extends ClientOptions {
  /** Register the detailed policy evaluation tool. Self-hosted Speedle only. */
  exposeDiagnose: boolean;
  /** Register the granted-role enumeration tool. */
  exposeAllGrantedRoles: boolean;
  /** Register the granted-permission enumeration tool. */
  exposeAllGrantedPermissions: boolean;
}

export interface PmsConfig extends PmsClientOptions {
  backend: Backend;
  /** When true, `manage` mode registers only read-only tools. */
  readOnly: boolean;
}

function readBoolean(raw: string | undefined, name: string): boolean {
  const value = raw?.trim().toLowerCase();
  if (value === "true" || value === "1") return true;
  if (value === undefined || value === "" || value === "false" || value === "0") return false;
  throw new ConfigurationError(`${name} must be "true", "false", "1", or "0"`);
}

/**
 * Reads ADS configuration from environment variables for `check` mode.
 *
 * Supported variables:
 * - `SPEEDLE_ENDPOINT` (or `SPEEDLE_ADS_ENDPOINT` / `SPEEDLE_ADS_URL`): ADS base URL (required)
 * - `SPEEDLE_SERVICE_NAME` (or `SPEEDLE_SERVICE`): service name (required)
 * - `SPEEDLE_TOKEN` (or `SPEEDLE_ADS_TOKEN`): optional bearer token (`spdl_…`)
 * - `SPEEDLE_BACKEND`: optional `"speedle-cloud"` or `"speedle"` (defaults to `"speedle-cloud"` when a token is set and `"speedle"` otherwise)
 * - `SPEEDLE_ALLOW_INSECURE_HTTP`: optional `"true"` or `"1"` to permit non-loopback `http://` on backend `"speedle"` without a token
 * - `SPEEDLE_CA_CERT`: optional PEM trust anchor for self-hosted HTTPS endpoints
 * - `SPEEDLE_EXPOSE_DIAGNOSE`: optional boolean to register `diagnose` (self-hosted Speedle only)
 * - `SPEEDLE_EXPOSE_ALL_GRANTED_ROLES`: optional boolean to register `all_granted_roles`
 * - `SPEEDLE_EXPOSE_ALL_GRANTED_PERMISSIONS`: optional boolean to register `all_granted_permissions`
 *
 * PMS configuration variables (`SPEEDLE_PMS_*`) are never read in `check` mode.
 */
export function loadAdsConfig(env: NodeJS.ProcessEnv = process.env): AdsConfig {
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
    backend = auth.kind === "bearer" ? "speedle-cloud" : "speedle";
  } else if (rawBackend === "speedle-cloud" || rawBackend === "speedle") {
    backend = rawBackend;
  } else {
    throw new ConfigurationError('SPEEDLE_BACKEND must be "speedle-cloud" or "speedle"');
  }

  const allowInsecureRaw = env.SPEEDLE_ALLOW_INSECURE_HTTP?.trim().toLowerCase();
  const allowInsecureHttp = allowInsecureRaw === "true" || allowInsecureRaw === "1";

  const caCert = env.SPEEDLE_CA_CERT !== undefined && env.SPEEDLE_CA_CERT !== "" ? env.SPEEDLE_CA_CERT : undefined;

  const options: AdsConfig = {
    backend,
    endpoint,
    auth,
    serviceName,
    allowInsecureHttp,
    caCert,
    userAgentSuffix: "speedle-mcp",
    exposeDiagnose: readBoolean(env.SPEEDLE_EXPOSE_DIAGNOSE, "SPEEDLE_EXPOSE_DIAGNOSE"),
    exposeAllGrantedRoles: readBoolean(env.SPEEDLE_EXPOSE_ALL_GRANTED_ROLES, "SPEEDLE_EXPOSE_ALL_GRANTED_ROLES"),
    exposeAllGrantedPermissions: readBoolean(
      env.SPEEDLE_EXPOSE_ALL_GRANTED_PERMISSIONS,
      "SPEEDLE_EXPOSE_ALL_GRANTED_PERMISSIONS",
    ),
  };

  // Validate options immediately and close the temporary agent created during validation.
  const resolved = resolveOptions(options);
  resolved.agent.destroy();

  return options;
}

/**
 * Reads PMS configuration from environment variables for `manage` mode.
 *
 * Supported variables:
 * - `SPEEDLE_PMS_ENDPOINT`: PMS or Speedle Cloud base URL (required)
 * - `SPEEDLE_PMS_BACKEND`: optional `"speedle-cloud"` or `"speedle"` (defaults to `"speedle"`)
 * - `SPEEDLE_PMS_TOKEN`: optional bearer token (required for `"speedle-cloud"`; requires `https://`)
 * - `SPEEDLE_PMS_CERT` and `SPEEDLE_PMS_KEY`: optional PEM client certificate and private key for mutual TLS
 * - `SPEEDLE_PMS_ALLOW_INSECURE_HTTP`: optional `"true"` or `"1"` to permit non-loopback `http://` without credentials
 * - `SPEEDLE_PMS_CA_CERT`: optional PEM trust anchor for self-hosted HTTPS endpoints
 * - `SPEEDLE_PMS_READ_ONLY`: optional `"true"` or `"1"` to register only read tools
 *
 * ADS configuration variables (`SPEEDLE_ENDPOINT`, `SPEEDLE_ADS_*`, `SPEEDLE_SERVICE_NAME`, `SPEEDLE_TOKEN`)
 * are never read in `manage` mode.
 *
 * Unlike `check` mode, a token alone never selects `"speedle-cloud"`: a
 * self-hosted PMS with a bearer token is an existing setup, so the backend
 * must be selected explicitly.
 */
export function loadPmsConfig(env: NodeJS.ProcessEnv = process.env): PmsConfig {
  const endpoint = (env.SPEEDLE_PMS_ENDPOINT ?? "").trim();
  if (endpoint === "") {
    throw new ConfigurationError(
      "SPEEDLE_PMS_ENDPOINT is required (for example http://127.0.0.1:6733 or https://pms.example.com:6733)",
    );
  }

  const rawToken = env.SPEEDLE_PMS_TOKEN;
  const rawCert = env.SPEEDLE_PMS_CERT;
  const rawKey = env.SPEEDLE_PMS_KEY;
  const hasToken = rawToken !== undefined && rawToken !== "";
  const hasCert = rawCert !== undefined && rawCert !== "";
  const hasKey = rawKey !== undefined && rawKey !== "";

  if (hasToken && (hasCert || hasKey)) {
    throw new ConfigurationError("SPEEDLE_PMS_TOKEN cannot be combined with SPEEDLE_PMS_CERT/SPEEDLE_PMS_KEY");
  }
  if (hasCert !== hasKey) {
    throw new ConfigurationError("Both SPEEDLE_PMS_CERT and SPEEDLE_PMS_KEY are required for mutual TLS");
  }

  const auth = hasToken
    ? Auth.bearer(rawToken)
    : hasCert && hasKey
      ? Auth.mutualTls({ cert: rawCert, key: rawKey })
      : Auth.none();

  const rawBackend = env.SPEEDLE_PMS_BACKEND?.trim();
  let backend: Backend;
  if (rawBackend === undefined || rawBackend === "") {
    backend = "speedle";
  } else if (rawBackend === "speedle-cloud" || rawBackend === "speedle") {
    backend = rawBackend;
  } else {
    throw new ConfigurationError('SPEEDLE_PMS_BACKEND must be "speedle-cloud" or "speedle"');
  }
  if (backend === "speedle-cloud") {
    if (!hasToken) {
      throw new ConfigurationError('SPEEDLE_PMS_TOKEN is required when SPEEDLE_PMS_BACKEND is "speedle-cloud"');
    }
    let protocol: string | undefined;
    try {
      protocol = new URL(endpoint).protocol;
    } catch {
      // resolvePmsOptions below reports the invalid URL.
    }
    if (protocol !== undefined && protocol !== "https:") {
      throw new ConfigurationError(
        'SPEEDLE_PMS_ENDPOINT must use https:// when SPEEDLE_PMS_BACKEND is "speedle-cloud"',
      );
    }
  }

  const allowInsecureRaw = env.SPEEDLE_PMS_ALLOW_INSECURE_HTTP?.trim().toLowerCase();
  const allowInsecureHttp = allowInsecureRaw === "true" || allowInsecureRaw === "1";

  const caCert =
    env.SPEEDLE_PMS_CA_CERT !== undefined && env.SPEEDLE_PMS_CA_CERT !== "" ? env.SPEEDLE_PMS_CA_CERT : undefined;

  const readOnlyRaw = env.SPEEDLE_PMS_READ_ONLY?.trim().toLowerCase();
  let readOnly = false;
  if (readOnlyRaw === "true" || readOnlyRaw === "1") {
    readOnly = true;
  } else if (readOnlyRaw !== undefined && readOnlyRaw !== "" && readOnlyRaw !== "false" && readOnlyRaw !== "0") {
    throw new ConfigurationError('SPEEDLE_PMS_READ_ONLY must be "true", "false", "1", or "0"');
  }

  const options: PmsConfig = {
    backend,
    endpoint,
    auth,
    allowInsecureHttp,
    caCert,
    userAgentSuffix: "speedle-mcp",
    readOnly,
  };

  // Validate options immediately and close the temporary agent created during validation.
  const resolved = resolvePmsOptions(options);
  resolved.agent.destroy();

  return options;
}
