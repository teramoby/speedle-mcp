import { inspect } from "node:util";
import { HttpEngine, type Result } from "../core/client.js";
import { InvalidRequestError, UnexpectedResponseError } from "../core/errors.js";
import { type CallOptions, PMS_BASE_PATH, type PmsClientOptions, resolvePmsOptions } from "../core/options.js";
import { type Classified, classifyError, parseJson } from "../core/response.js";
import type { RawResponse } from "../core/transport.js";
import type { PolicyBody, RolePolicyBody } from "./spdl.js";

export interface ServiceBody {
  name: string;
  type?: string;
}

function classifyPms(backend: "speedle-cloud" | "speedle-plus", res: RawResponse, token?: string): Classified<unknown> {
  const parsed = parseJson(res.body);
  if (res.status === 204) return { value: null };
  if (res.status === 200 || res.status === 201) {
    if (parsed === undefined) {
      const error = new UnexpectedResponseError("unexpected response body: not JSON", { status: res.status });
      return { error, retryable: false, retryAfterSeconds: undefined };
    }
    return { value: parsed };
  }
  return classifyError(backend, res, parsed, undefined, token);
}

/** Validates a path segment: PMS splits the decoded URL path on "/", so a name must not contain one. */
function segment(value: string, what: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new InvalidRequestError(`${what} must be a non-empty string`);
  if (value.includes("/")) throw new InvalidRequestError(`${what} must not contain "/"`);
  return encodeURIComponent(value);
}

/**
 * A client for the Speedle+ Policy Management Service REST API
 * (`/policy-mgmt/v1`, teramoby/speedle-plus `api/swagger/policy-manage.yaml`).
 * Reads are retried like ADS calls; creates are sent at most once.
 */
export class PmsClient {
  readonly #engine: HttpEngine;

  constructor(options: PmsClientOptions) {
    this.#engine = new HttpEngine(resolvePmsOptions(options));
  }

  /** Redacts the configured bearer token or client key, if any, from `text`. */
  redact(text: string): string {
    return this.#engine.redact(text);
  }

  async #call(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    options?: CallOptions,
  ): Promise<unknown> {
    const result: Result<unknown> = await this.#engine.request(
      method,
      PMS_BASE_PATH + path,
      body === undefined ? undefined : JSON.stringify(body),
      options,
      classifyPms,
      undefined,
      method !== "POST",
    );
    if ("value" in result) return result.value;
    throw result.gaveUp;
  }

  listServices(options?: CallOptions): Promise<unknown> {
    return this.#call("GET", "/service", undefined, options);
  }

  getService(serviceName: string, options?: CallOptions): Promise<unknown> {
    return this.#call("GET", `/service/${segment(serviceName, "serviceName")}`, undefined, options);
  }

  createService(service: ServiceBody, options?: CallOptions): Promise<unknown> {
    segment(service.name, "name");
    return this.#call("POST", "/service", service, options);
  }

  async deleteService(serviceName: string, options?: CallOptions): Promise<void> {
    await this.#call("DELETE", `/service/${segment(serviceName, "serviceName")}`, undefined, options);
  }

  listPolicies(serviceName: string, options?: CallOptions): Promise<unknown> {
    return this.#call("GET", `/service/${segment(serviceName, "serviceName")}/policy`, undefined, options);
  }

  getPolicy(serviceName: string, policyId: string, options?: CallOptions): Promise<unknown> {
    const path = `/service/${segment(serviceName, "serviceName")}/policy/${segment(policyId, "policyId")}`;
    return this.#call("GET", path, undefined, options);
  }

  createPolicy(serviceName: string, policy: PolicyBody, options?: CallOptions): Promise<unknown> {
    return this.#call("POST", `/service/${segment(serviceName, "serviceName")}/policy`, policy, options);
  }

  async deletePolicy(serviceName: string, policyId: string, options?: CallOptions): Promise<void> {
    const path = `/service/${segment(serviceName, "serviceName")}/policy/${segment(policyId, "policyId")}`;
    await this.#call("DELETE", path, undefined, options);
  }

  listRolePolicies(serviceName: string, options?: CallOptions): Promise<unknown> {
    return this.#call("GET", `/service/${segment(serviceName, "serviceName")}/role-policy`, undefined, options);
  }

  getRolePolicy(serviceName: string, rolePolicyId: string, options?: CallOptions): Promise<unknown> {
    const path = `/service/${segment(serviceName, "serviceName")}/role-policy/${segment(rolePolicyId, "rolePolicyId")}`;
    return this.#call("GET", path, undefined, options);
  }

  createRolePolicy(serviceName: string, rolePolicy: RolePolicyBody, options?: CallOptions): Promise<unknown> {
    return this.#call("POST", `/service/${segment(serviceName, "serviceName")}/role-policy`, rolePolicy, options);
  }

  async deleteRolePolicy(serviceName: string, rolePolicyId: string, options?: CallOptions): Promise<void> {
    const path = `/service/${segment(serviceName, "serviceName")}/role-policy/${segment(rolePolicyId, "rolePolicyId")}`;
    await this.#call("DELETE", path, undefined, options);
  }

  /** Releases the connection pool. The client must not be used afterwards. */
  close(): Promise<void> {
    return this.#engine.close();
  }

  toString(): string {
    return `PmsClient(${this.#engine.opts.baseUrl.origin})`;
  }

  [inspect.custom](): string {
    return this.toString();
  }
}
