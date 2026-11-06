import { inspect } from "node:util";
import { VERSION } from "../version.js";
import { type Attributes, toWireAttributes } from "./attributes.js";
import { type BreakerOutcome, CircuitBreaker } from "./breaker.js";
import { type Clock, type RandomSource, systemClock, systemRandom } from "./clock.js";
import {
  CircuitOpenError,
  DeadlineExceededError,
  InvalidRequestError,
  NetworkError,
  redactSecret,
  SpeedleError,
  TimeoutError,
  UnexpectedResponseError,
} from "./errors.js";
import {
  ALL_GRANTED_PERMISSIONS_PATH,
  ALL_GRANTED_ROLES_PATH,
  type CallOptions,
  type ClientOptions,
  DIAGNOSE_PATH,
  type GiveUpReason,
  type Hooks,
  IS_ALLOWED_PATH,
  PMS_BASE_PATH,
  type ResolvedOptions,
  resolveOptions,
} from "./options.js";
import {
  type Classified,
  classify,
  classifyDiagnose,
  classifyPermissions,
  classifyRoles,
  type Decision,
  type DiagnoseResult,
  type GrantedPermission,
} from "./response.js";
import { type RawResponse, send, TransportFailure } from "./transport.js";

/** A principal; `type` defaults to "user". */
export interface Principal {
  type?: string;
  name: string;
  idd?: string;
}
/** A user name, or a list of principals. */
export type Subject = string | Principal[];

/** Constants for the Speedle principal types; any string is accepted. */
export const PrincipalType = Object.freeze({
  User: "user",
  Group: "group",
  Role: "role",
  Entity: "entity",
} as const);

export interface GrantQueryOptions extends CallOptions {
  resource?: string;
  action?: string;
}

export type Result<T> = { value: T } | { gaveUp: SpeedleError };

let pendingSeams: { clock: Clock; random: RandomSource } | undefined;

/** Internal test seam (design §11). */
export function withTestingSeams<T>(clock: Clock, random: RandomSource, factory: () => T): T {
  pendingSeams = { clock, random };
  try {
    return factory();
  } finally {
    pendingSeams = undefined;
  }
}

/** Internal test seam (design §11). */
export function createClientForTesting(options: ClientOptions, clock: Clock, random: RandomSource): SpeedleClient {
  return withTestingSeams(clock, random, () => new SpeedleClient(options));
}

function callHook<E>(hook: ((event: E) => void) | undefined, hooks: Hooks, event: E): void {
  if (!hook) return;
  try {
    const result: unknown = hook.call(hooks, event);
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      (result as Promise<unknown>).then(undefined, () => undefined);
    }
  } catch {
    // Hook failures never change the call's result (design §6.7).
  }
}

function buildSubject(subject: Subject): { principals: { type: string; name: string; idd?: string }[] } {
  if (typeof subject === "string") {
    if (subject === "") throw new InvalidRequestError("subject is empty");
    return { principals: [{ type: "user", name: subject }] };
  }
  if (!Array.isArray(subject) || subject.length === 0) {
    throw new InvalidRequestError("subject must be a user name or a non-empty list of principals");
  }
  return {
    principals: subject.map((p: unknown) => {
      if (p === null || typeof p !== "object") throw new InvalidRequestError("principal is not an object");
      const { type, name, idd } = p as { type?: unknown; name?: unknown; idd?: unknown };
      if (typeof name !== "string" || name === "") throw new InvalidRequestError("principal name is empty");
      if (type !== undefined && (typeof type !== "string" || type === "")) {
        throw new InvalidRequestError("principal type must be a non-empty string");
      }
      if (idd !== undefined && typeof idd !== "string") throw new InvalidRequestError("principal idd must be a string");
      const out: { type: string; name: string; idd?: string } = { type: type ?? "user", name };
      if (idd !== undefined && idd !== "") out.idd = idd;
      return out;
    }),
  };
}

function breakerOutcome(error: SpeedleError): BreakerOutcome {
  if (error instanceof NetworkError) return "failure";
  if (error.status !== undefined) return error.status >= 500 ? "failure" : "success";
  return "neutral";
}

/**
 * Shared HTTP transport, retry, circuit breaker, and redaction engine used by
 * both `SpeedleClient` (ADS) and `PmsClient` (PMS). Internal.
 */
export class HttpEngine {
  readonly opts: ResolvedOptions;
  readonly #clock: Clock;
  readonly #random: RandomSource;
  readonly #breaker: CircuitBreaker | undefined;
  readonly #userAgent: string;
  #closed = false;

  constructor(opts: ResolvedOptions) {
    this.opts = opts;
    this.#clock = pendingSeams?.clock ?? systemClock;
    this.#random = pendingSeams?.random ?? systemRandom;
    const { breaker, hooks, userAgentSuffix } = this.opts;
    if (breaker) {
      this.#breaker = new CircuitBreaker(breaker.failureThreshold, breaker.coolDownMs, this.#clock, (from, to) =>
        callHook(hooks.onBreakerStateChange, hooks, { from, to }),
      );
    }
    this.#userAgent =
      `speedle-sdk-node/${VERSION} (node/${process.versions.node}; ${process.platform})` +
      (userAgentSuffix ? ` ${userAgentSuffix}` : "");
  }

  redact(text: string): string {
    let out = redactSecret(text, this.opts.token);
    const key = this.opts.secretKey;
    if (key) {
      out = redactSecret(out, key);
      // Also redact each line of a PEM key, so a truncated or JSON-escaped copy never leaks.
      for (const line of key.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.length >= 16 && !trimmed.startsWith("-----")) out = redactSecret(out, trimmed);
      }
    }
    return out;
  }

  close(): Promise<void> {
    this.#closed = true;
    this.opts.agent.destroy();
    return Promise.resolve();
  }

  giveUp<T>(attempts: number, reason: GiveUpReason, error: SpeedleError, ticket?: { trial: boolean }): Result<T> {
    const hooks = this.opts.hooks;
    callHook(hooks.onGiveUp, hooks, { attempts, reason, error });
    if (ticket && this.#breaker) this.#breaker.record(ticket, breakerOutcome(error));
    return { gaveUp: error };
  }

  endpointUrl(path: string, query?: Record<string, string | undefined>): URL {
    const url = new URL(this.opts.baseUrl.href);
    let basePath = url.pathname.replace(/\/+$/, "");
    if (path.startsWith(PMS_BASE_PATH) && basePath.endsWith(PMS_BASE_PATH)) {
      basePath = basePath.slice(0, -PMS_BASE_PATH.length);
    }
    url.pathname = basePath + path;
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== "") url.searchParams.set(k, v);
      }
    }
    return url;
  }

  async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body: string | undefined,
    options: CallOptions | undefined,
    classifier: (backend: ResolvedOptions["backend"], res: RawResponse, token?: string) => Classified<T>,
    query?: Record<string, string | undefined>,
    idempotent = true,
  ): Promise<Result<T>> {
    const signal = options?.signal;
    if (signal?.aborted) throw signal.reason;
    if (this.#closed) throw new SpeedleError("client is closed");
    const opts = this.opts;
    const clock = this.#clock;
    // A non-idempotent request (for example a PMS create) is sent at most once.
    const maxAttempts = idempotent ? opts.maxAttempts : 1;

    let ticket: { trial: boolean } | undefined;
    if (this.#breaker) {
      ticket = this.#breaker.acquire();
      if (!ticket) return this.giveUp(0, "circuit_open", new CircuitOpenError("circuit breaker is open"));
    }

    const url = this.endpointUrl(path, query);
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": this.#userAgent,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.authorization) headers.Authorization = opts.authorization;

    const hooks = opts.hooks;
    const deadlineAt = clock.now() + opts.deadlineMs;
    let attempts = 0;
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const remaining = deadlineAt - clock.now();
        if (remaining <= 0) {
          return this.giveUp(attempts, "deadline", new DeadlineExceededError("deadline exceeded"), ticket);
        }
        attempts = attempt;
        const deadlineBound = remaining <= opts.attemptTimeoutMs;
        const started = clock.now();
        let error: SpeedleError;
        let retryable: boolean;
        let retryAfterSeconds: number | undefined;
        let status: number | undefined;
        let deadlineCut = false;
        try {
          const res = await send({
            url,
            method,
            agent: opts.agent,
            headers,
            body,
            timeoutMs: Math.min(opts.attemptTimeoutMs, remaining),
            signal,
          });
          status = res.status;
          const c = classifier(opts.backend, res, opts.token);
          if ("value" in c) {
            callHook(hooks.onAttempt, hooks, { attempt, durationMs: clock.now() - started, status });
            if (ticket && this.#breaker) this.#breaker.record(ticket, "success");
            return c;
          }
          ({ error, retryable, retryAfterSeconds } = c);
        } catch (err) {
          if (!(err instanceof TransportFailure)) throw err;
          if (err.kind === "aborted") throw signal?.reason ?? err.original;
          retryAfterSeconds = undefined;
          const safeMsg = this.redact(err.message);
          if (err.kind === "timeout") {
            deadlineCut = deadlineBound;
            error = deadlineBound
              ? new DeadlineExceededError("deadline exceeded during the attempt")
              : new TimeoutError(safeMsg);
            retryable = !deadlineBound;
          } else if (err.kind === "too_large") {
            error = new UnexpectedResponseError(safeMsg);
            retryable = false;
          } else {
            error = new NetworkError(safeMsg, { cause: err.original });
            retryable = err.kind === "network";
          }
        }
        callHook(hooks.onAttempt, hooks, {
          attempt,
          durationMs: clock.now() - started,
          status,
          errorType: error.name,
        });
        if (deadlineCut) return this.giveUp(attempts, "deadline", error, ticket);
        if (!retryable) return this.giveUp(attempts, "non_retryable", error, ticket);
        if (attempt === maxAttempts) return this.giveUp(attempts, "attempts_exhausted", error, ticket);
        let delay = this.#random() * Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** (attempt - 1));
        if (retryAfterSeconds !== undefined) delay = Math.max(delay, retryAfterSeconds * 1000);
        if (delay >= deadlineAt - clock.now()) {
          const reason = retryAfterSeconds !== undefined ? "retry_after_exceeds_deadline" : "deadline";
          return this.giveUp(attempts, reason, error, ticket);
        }
        callHook(hooks.onRetry, hooks, { attempt: attempt + 1, delayMs: delay, errorType: error.name });
        await clock.sleep(delay, signal);
      }
    } catch (err) {
      // Caller cancellation: no give-up hook, no breaker count (design §6.3).
      if (ticket && this.#breaker) this.#breaker.record(ticket, "neutral");
      throw err;
    }
    return this.giveUp(attempts, "attempts_exhausted", new SpeedleError("retry loop ended"), ticket);
  }
}

/**
 * A client for one Speedle ADS endpoint. Create it once and share it; it is
 * safe for concurrent use and owns one keep-alive connection pool.
 */
export class SpeedleClient {
  readonly #engine: HttpEngine;

  constructor(options: ClientOptions) {
    this.#engine = new HttpEngine(resolveOptions(options));
  }

  /** Configured service name (always sent on every request; never overridden by callers). */
  get serviceName(): string {
    return this.#engine.opts.serviceName;
  }

  /** Redacts the configured bearer token, if any, from `text`. */
  redact(text: string): string {
    return this.#engine.redact(text);
  }

  /**
   * Returns the server's `allowed` value. Every other outcome raises a typed
   * error, or returns false with `failureMode: "closed"`.
   */
  async isAllowed(
    subject: Subject,
    action: string,
    resource: string,
    attributes?: Attributes,
    options?: CallOptions,
  ): Promise<boolean> {
    const result = await this.#call(IS_ALLOWED_PATH, subject, action, resource, attributes, options, classify);
    if ("value" in result) return result.value.allowed === true;
    if (this.#engine.opts.failureMode === "closed") return false;
    throw result.gaveUp;
  }

  /** The detailed `is-allowed` form. Always raises on failure, in every failure mode. */
  async check(
    subject: Subject,
    action: string,
    resource: string,
    attributes?: Attributes,
    options?: CallOptions,
  ): Promise<Decision> {
    const result = await this.#call(IS_ALLOWED_PATH, subject, action, resource, attributes, options, classify);
    if ("value" in result) return result.value;
    throw result.gaveUp;
  }

  /** Calls `/authz-check/v1/diagnose` to explain policy evaluation. */
  async diagnose(
    subject: Subject,
    action: string,
    resource: string,
    attributes?: Attributes,
    options?: CallOptions,
  ): Promise<DiagnoseResult> {
    const result = await this.#call(DIAGNOSE_PATH, subject, action, resource, attributes, options, classifyDiagnose);
    if ("value" in result) return result.value;
    throw result.gaveUp;
  }

  /** Calls `/authz-check/v1/all-granted-roles` to list granted roles. */
  async allGrantedRoles(subject: Subject, attributes?: Attributes, options?: GrantQueryOptions): Promise<string[]> {
    const result = await this.#call(
      ALL_GRANTED_ROLES_PATH,
      subject,
      options?.action ?? "",
      options?.resource ?? "",
      attributes,
      options,
      classifyRoles,
    );
    if ("value" in result) return result.value;
    throw result.gaveUp;
  }

  /** Calls `/authz-check/v1/all-granted-permissions` to list granted permissions. */
  async allGrantedPermissions(
    subject: Subject,
    attributes?: Attributes,
    options?: GrantQueryOptions,
  ): Promise<GrantedPermission[]> {
    const result = await this.#call(
      ALL_GRANTED_PERMISSIONS_PATH,
      subject,
      options?.action ?? "",
      options?.resource ?? "",
      attributes,
      options,
      classifyPermissions,
    );
    if ("value" in result) return result.value;
    throw result.gaveUp;
  }

  /** Releases the connection pool. The client must not be used afterwards. */
  close(): Promise<void> {
    return this.#engine.close();
  }

  toString(): string {
    return `SpeedleClient(${this.#engine.opts.backend}, ${this.#engine.opts.baseUrl.origin})`;
  }

  [inspect.custom](): string {
    return this.toString();
  }

  #body(subject: Subject, action: string, resource: string, attributes: Attributes | undefined): string {
    if (typeof action !== "string") throw new InvalidRequestError("action must be a string");
    if (typeof resource !== "string") throw new InvalidRequestError("resource must be a string");
    const serviceName = this.#engine.opts.serviceName;
    const wire = toWireAttributes(attributes);
    const body: Record<string, unknown> = { subject: buildSubject(subject), serviceName, resource, action };
    if (wire.length > 0) body.attributes = wire;
    return JSON.stringify(body);
  }

  async #call<T>(
    path: string,
    subject: Subject,
    action: string,
    resource: string,
    attributes: Attributes | undefined,
    options: CallOptions | undefined,
    classifier: (backend: ResolvedOptions["backend"], res: RawResponse, token?: string) => Classified<T>,
  ): Promise<Result<T>> {
    const signal = options?.signal;
    if (signal?.aborted) throw signal.reason;
    let body: string;
    try {
      body = this.#body(subject, action, resource, attributes);
    } catch (err) {
      if (err instanceof InvalidRequestError) return this.#engine.giveUp(0, "non_retryable", err);
      throw err;
    }
    return this.#engine.request("POST", path, body, options, classifier);
  }
}
