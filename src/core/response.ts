import type { IncomingHttpHeaders } from "node:http";
import {
  ForbiddenError,
  HttpError,
  InvalidRequestError,
  QuotaExceededError,
  RateLimitedError,
  redactSecret,
  RequestTooLargeError,
  ServerError,
  ServiceUnavailableError,
  type SpeedleError,
  TooManyRequestsError,
  UnauthorizedError,
  UnexpectedResponseError,
} from "./errors.js";
import type { Backend } from "./options.js";
import type { RawResponse } from "./transport.js";

/** Self-hosted Speedle and Speedle Cloud reason codes (design §3.3). */
export enum Reason {
  GrantPolicyFound = 0,
  DenyPolicyFound = 1,
  ServiceNotFound = 2,
  NoApplicablePolicies = 3,
  ErrorInEvaluation = 4,
  /** `allowed` is true, but this is not a production grant. */
  DiscoverMode = 5,
  ReasonNotAvailable = 6,
}

export interface Decision {
  allowed: boolean;
  /** A {@link Reason}; unknown integers are kept as numbers. */
  reason: Reason | number;
  /** Self-hosted Speedle evaluator error, returned with HTTP 200 and a denial. */
  errorMessage?: string;
  /** Speedle Cloud `X-Quota-Daily-Remaining`. */
  quotaDailyRemaining?: number;
}

export interface GrantedPermission {
  resource: string;
  actions: string[];
}

export interface EvaluatedCondition {
  conditionExpression?: string;
  evaluationResult?: string;
}

export interface DiagnosedPermission {
  resource?: string;
  resourceExpression?: string;
  actions?: string[];
}

export interface DiagnosedPolicy {
  id?: string;
  status?: string;
  name?: string;
  effect?: string;
  permissions?: DiagnosedPermission[];
  principals?: string[][];
  condition?: EvaluatedCondition;
}

export interface DiagnosedRolePolicy {
  id?: string;
  status?: string;
  name?: string;
  effect?: string;
  roles?: string[];
  principals?: string[];
  resources?: string[];
  resourceExpressions?: string[];
  condition?: EvaluatedCondition;
}

export interface DiagnoseResult {
  allowed: boolean;
  reason: string | number;
  requestContext?: Record<string, unknown>;
  attributes?: unknown;
  grantedRoles?: string[];
  rolePolicies?: DiagnosedRolePolicy[];
  policies?: DiagnosedPolicy[];
  quotaDailyRemaining?: number;
}

/** Result of classifying one HTTP response. Internal. */
export type Classified<T> =
  { value: T } | { error: SpeedleError; retryable: boolean; retryAfterSeconds: number | undefined };

const CLOUD_CODES: ReadonlySet<string> = new Set([
  "invalid_request",
  "unsupported_token_assertion",
  "unauthorized",
  "service_mismatch",
  "request_too_large",
  "rate_limited",
  "daily_quota_exceeded",
  "internal_error",
  "quota_unavailable",
  "snapshot_unavailable",
]);

const MAX_MESSAGE_LENGTH = 512;

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function nonNegativeInt(value: string | undefined, positive: boolean): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || (positive && n === 0)) return undefined;
  return n;
}

export function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unexpected<T>(why: string, status: number, quotaDailyRemaining: number | undefined): Classified<T> {
  return {
    error: new UnexpectedResponseError(`unexpected response body: ${why}`, { status, quotaDailyRemaining }),
    retryable: false,
    retryAfterSeconds: undefined,
  };
}

export function classifyError<T>(
  backend: Backend,
  res: RawResponse,
  parsed: unknown,
  quotaDailyRemaining: number | undefined,
  token?: string,
): Classified<T> {
  const status = res.status;
  const rawText = isObject(parsed) && typeof parsed.error === "string" ? parsed.error : undefined;
  const text = rawText === undefined ? undefined : redactSecret(rawText, token);
  let code: string | undefined;
  let detail: string | undefined;
  if (text !== undefined) {
    if (backend === "speedle-cloud" && CLOUD_CODES.has(text)) code = text;
    else detail = text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH)}...` : text;
  }
  const message = `HTTP ${status}${code ? `: ${code}` : detail ? `: ${detail}` : ""}`;
  const fields = { status, code, quotaDailyRemaining };
  const retryAfter = nonNegativeInt(header(res.headers, "retry-after"), true);
  const final = (error: SpeedleError): Classified<T> => ({ error, retryable: false, retryAfterSeconds: undefined });
  const retry = (error: SpeedleError): Classified<T> => ({ error, retryable: true, retryAfterSeconds: retryAfter });

  switch (status) {
    case 400:
      return final(new InvalidRequestError(message, fields));
    case 401:
      return final(new UnauthorizedError(message, fields));
    case 403:
      return final(new ForbiddenError(message, fields));
    case 413:
      return final(new RequestTooLargeError(message, fields));
    case 429: {
      const f = { ...fields, retryAfter };
      if (backend === "speedle-plus" || code === "rate_limited") {
        const error = new RateLimitedError(message, f);
        // A burst 429 is retried only with a usable Retry-After (design §6.3).
        return retryAfter === undefined ? final(error) : retry(error);
      }
      if (code === "daily_quota_exceeded") return final(new QuotaExceededError(message, f));
      return final(new TooManyRequestsError(message, f));
    }
    case 500:
      return final(new ServerError(message, fields));
    case 502:
    case 504:
      return retry(new ServerError(message, fields));
    case 503:
      return retry(new ServiceUnavailableError(message, fields));
    default:
      if (status >= 500 && status <= 599) return final(new ServerError(message, fields));
      return final(new HttpError(message, fields));
  }
}

export function classify(backend: Backend, res: RawResponse, token?: string): Classified<Decision> {
  const quotaDailyRemaining = nonNegativeInt(header(res.headers, "x-quota-daily-remaining"), false);
  const status = res.status;
  const parsed = parseJson(res.body);

  if (status === 200) {
    if (!isObject(parsed)) return unexpected("not a JSON object", status, quotaDailyRemaining);
    if (typeof parsed.allowed !== "boolean")
      return unexpected('"allowed" is not a boolean', status, quotaDailyRemaining);
    if (typeof parsed.reason !== "number" || !Number.isInteger(parsed.reason)) {
      return unexpected('"reason" is not an integer', status, quotaDailyRemaining);
    }
    const decision: Decision = { allowed: parsed.allowed, reason: parsed.reason };
    if (typeof parsed.errorMessage === "string" && parsed.errorMessage !== "") {
      decision.errorMessage = redactSecret(parsed.errorMessage, token);
    }
    if (quotaDailyRemaining !== undefined) decision.quotaDailyRemaining = quotaDailyRemaining;
    return { value: decision };
  }

  return classifyError(backend, res, parsed, quotaDailyRemaining, token);
}

export function classifyDiagnose(backend: Backend, res: RawResponse, token?: string): Classified<DiagnoseResult> {
  const quotaDailyRemaining = nonNegativeInt(header(res.headers, "x-quota-daily-remaining"), false);
  const status = res.status;
  const parsed = parseJson(res.body);

  if (status === 200) {
    if (!isObject(parsed)) return unexpected("not a JSON object", status, quotaDailyRemaining);
    if (typeof parsed.allowed !== "boolean")
      return unexpected('"allowed" is not a boolean', status, quotaDailyRemaining);
    if (typeof parsed.reason !== "string" && (typeof parsed.reason !== "number" || !Number.isInteger(parsed.reason))) {
      return unexpected('"reason" is not a string or integer', status, quotaDailyRemaining);
    }
    const out: DiagnoseResult = {
      allowed: parsed.allowed,
      reason: typeof parsed.reason === "string" ? redactSecret(parsed.reason, token) : parsed.reason,
    };
    if (isObject(parsed.requestContext)) out.requestContext = parsed.requestContext;
    if (parsed.attributes !== undefined) out.attributes = parsed.attributes;
    if (Array.isArray(parsed.grantedRoles)) {
      out.grantedRoles = parsed.grantedRoles.filter((r): r is string => typeof r === "string");
    }
    if (Array.isArray(parsed.rolePolicies)) out.rolePolicies = parsed.rolePolicies as DiagnosedRolePolicy[];
    if (Array.isArray(parsed.policies)) out.policies = parsed.policies as DiagnosedPolicy[];
    if (quotaDailyRemaining !== undefined) out.quotaDailyRemaining = quotaDailyRemaining;
    return { value: out };
  }

  return classifyError(backend, res, parsed, quotaDailyRemaining, token);
}

export function classifyRoles(backend: Backend, res: RawResponse, token?: string): Classified<string[]> {
  const quotaDailyRemaining = nonNegativeInt(header(res.headers, "x-quota-daily-remaining"), false);
  const status = res.status;
  const parsed = parseJson(res.body);

  if (status === 200) {
    if (!Array.isArray(parsed) || !parsed.every((item): item is string => typeof item === "string")) {
      return unexpected("expected a JSON array of role strings", status, quotaDailyRemaining);
    }
    return { value: parsed.map((item) => redactSecret(item, token)) };
  }

  return classifyError(backend, res, parsed, quotaDailyRemaining, token);
}

export function classifyPermissions(
  backend: Backend,
  res: RawResponse,
  token?: string,
): Classified<GrantedPermission[]> {
  const quotaDailyRemaining = nonNegativeInt(header(res.headers, "x-quota-daily-remaining"), false);
  const status = res.status;
  const parsed = parseJson(res.body);

  if (status === 200) {
    if (!Array.isArray(parsed)) {
      return unexpected("expected a JSON array of permissions", status, quotaDailyRemaining);
    }
    const permissions: GrantedPermission[] = [];
    for (const item of parsed) {
      if (!isObject(item) || typeof item.resource !== "string") {
        return unexpected("permission item is missing a string resource", status, quotaDailyRemaining);
      }
      const rawActions = item.actions ?? [];
      if (!Array.isArray(rawActions) || !rawActions.every((a): a is string => typeof a === "string")) {
        return unexpected("permission item actions must be an array of strings", status, quotaDailyRemaining);
      }
      permissions.push({
        resource: redactSecret(item.resource, token),
        actions: rawActions.map((a) => redactSecret(a, token)),
      });
    }
    return { value: permissions };
  }

  return classifyError(backend, res, parsed, quotaDailyRemaining, token);
}
