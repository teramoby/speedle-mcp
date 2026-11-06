# @speedle/mcp

Local stdio [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for [Speedle+](https://github.com/teramoby/speedle-plus) and [Speedle Cloud](https://cloud.speedle.io): authorization checks (`check` mode) and policy management (`manage` mode).

> **Note:** The shared HTTP client in `src/core` (used by both modes) follows the `teramoby/speedle-sdk` design specification (typed attributes, error model, and retry policy) and will move to `@speedle/sdk` once `@speedle/sdk` is published on npm.

## Security: Why Two Modes in One Package

Authorization checks are read-only queries and are typically wired into an AI agent whose actions Speedle governs. Policy management writes policy. **An agent that holds both tool sets could be prompted into granting itself access.**

To enforce separation of privilege:

- `npx @speedle/mcp check` registers **only** the read-only authorization check tools (`is_allowed`, `diagnose`, `all_granted_roles`, `all_granted_permissions`) and reads **only** ADS configuration.
- `npx @speedle/mcp manage` registers **only** the policy management tools and reads **only** PMS configuration. `manage --read-only` registers only its read tools.
- **There is no default mode that exposes both.** Running `speedle-mcp` without a mode prints usage and exits with a non-zero status.
- Never grant `manage` mode to an agent that is itself governed by the policies in that Speedle service.
- Check tools only answer authorization questions; they do not enforce access control on their own.

## Requirements & Install

Requires **Node.js >= 22**.

```sh
npm install @speedle/mcp
```

Or run directly with `npx`:

```sh
npx @speedle/mcp check
```

## MCP Client Configuration

### `check` mode — Speedle Cloud (HTTPS + Bearer token)

```json
{
  "mcpServers": {
    "speedle-check": {
      "command": "npx",
      "args": ["-y", "@speedle/mcp", "check"],
      "env": {
        "SPEEDLE_ENDPOINT": "https://cloud.speedle.io",
        "SPEEDLE_SERVICE_NAME": "books",
        "SPEEDLE_TOKEN": "spdl_..."
      }
    }
  }
}
```

### `check` mode — Self-hosted Speedle+ (loopback or internal ADS)

```json
{
  "mcpServers": {
    "speedle-check": {
      "command": "npx",
      "args": ["-y", "@speedle/mcp", "check"],
      "env": {
        "SPEEDLE_ENDPOINT": "http://127.0.0.1:6734",
        "SPEEDLE_SERVICE_NAME": "books"
      }
    }
  }
}
```

### `manage` mode — Speedle+ Policy Management (PMS)

> **Security:** never give `manage` mode to an agent that is itself governed by the policies in this Speedle+ instance. Such an agent could be prompted into granting itself access. Run `manage` only for a human-supervised policy author, and prefer `--read-only` when the agent only needs to read policies.

```json
{
  "mcpServers": {
    "speedle-manage": {
      "command": "npx",
      "args": ["-y", "@speedle/mcp", "manage"],
      "env": {
        "SPEEDLE_PMS_ENDPOINT": "http://127.0.0.1:6733"
      }
    }
  }
}
```

For a read-only policy reviewer, use `"args": ["-y", "@speedle/mcp", "manage", "--read-only"]` or set `SPEEDLE_PMS_READ_ONLY` to `"true"`.

## Environment Variables (`check` mode)

| Variable                                                           | Required      | Description                                                                                                                            |
| ------------------------------------------------------------------ | ------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `SPEEDLE_ENDPOINT` (or `SPEEDLE_ADS_ENDPOINT` / `SPEEDLE_ADS_URL`) | Yes           | ADS base URL, e.g. `https://cloud.speedle.io` or `http://127.0.0.1:6734`.                                                              |
| `SPEEDLE_SERVICE_NAME` (or `SPEEDLE_SERVICE`)                      | Yes           | Service name sent on every check request. Cannot be overridden by tool callers.                                                        |
| `SPEEDLE_TOKEN` (or `SPEEDLE_ADS_TOKEN`)                           | Speedle Cloud | Optional bearer token (`spdl_…`). Requires `https://`. Never logged or echoed in tool output or errors.                                |
| `SPEEDLE_BACKEND`                                                  | No            | `"speedle-cloud"` or `"speedle-plus"`. Defaults to `"speedle-cloud"` when a bearer token is configured and `"speedle-plus"` otherwise. |
| `SPEEDLE_ALLOW_INSECURE_HTTP`                                      | No            | Set to `"true"` to allow plaintext `http://` to non-loopback hosts on `speedle-plus` without a token.                                  |
| `SPEEDLE_CA_CERT`                                                  | No            | Extra PEM CA certificate for self-hosted `https://` servers.                                                                           |

## Tools (`check` mode)

All four tools query `/authz-check/v1/*` on the configured ADS endpoint using `serviceName` from environment configuration:

- **`is_allowed`** (`POST /authz-check/v1/is-allowed`): Returns `{ allowed, reason, errorMessage?, quotaDailyRemaining? }`.
- **`diagnose`** (`POST /authz-check/v1/diagnose`): Returns `{ allowed, reason, requestContext?, attributes?, grantedRoles?, rolePolicies?, policies? }`.
- **`all_granted_roles`** (`POST /authz-check/v1/all-granted-roles`): Returns the `string[]` array of granted role names.
- **`all_granted_permissions`** (`POST /authz-check/v1/all-granted-permissions`): Returns `[{ resource, actions }]`.

### Tool Inputs

- `subject`: A user name string (e.g. `"alice"`, shorthand for `[{ type: "user", name: "alice" }]`) or a non-empty list of principals `{ type?: "user" | "group" | "role" | "entity", name: string, idd?: string }`.
- `resource`: Resource string (required for `is_allowed` and `diagnose`; optional for `all_granted_roles` and `all_granted_permissions`).
- `action`: Action string (required for `is_allowed` and `diagnose`; optional for `all_granted_roles` and `all_granted_permissions`).
- `attributes`: Optional request attributes in either:
  - **Typed array form**: `[{ name, type: "string" | "numeric" | "bool" | "datetime", value }]`, where `value` is a single value or array of that type (`datetime` values are RFC 3339 strings with an explicit time zone, such as `"2026-11-05T03:00:00Z"`).
  - **Inferred object form**: `{ [name]: value }` where strings become `string` (even if they look like dates), numbers become `numeric`, booleans become `bool`, and non-empty homogeneous arrays use the corresponding type, sorted by Unicode code point.

## Environment Variables (`manage` mode)

`manage` mode reads only these variables. It never reads `SPEEDLE_ENDPOINT`, `SPEEDLE_SERVICE_NAME`, `SPEEDLE_TOKEN` or any other ADS variable.

| Variable                               | Required | Description                                                                               |
| -------------------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| `SPEEDLE_PMS_ENDPOINT`                 | Yes      | PMS base URL, e.g. `http://127.0.0.1:6733`. A trailing `/policy-mgmt/v1` is accepted.     |
| `SPEEDLE_PMS_TOKEN`                    | No       | Bearer token. Requires `https://`. Never logged or echoed in tool output or errors.       |
| `SPEEDLE_PMS_CERT` / `SPEEDLE_PMS_KEY` | No       | PEM client certificate and private key for mutual TLS. The key is never logged or echoed. |
| `SPEEDLE_PMS_ALLOW_INSECURE_HTTP`      | No       | Set to `"true"` to allow plaintext `http://` to non-loopback hosts without credentials.   |
| `SPEEDLE_PMS_CA_CERT`                  | No       | Extra PEM CA certificate for self-hosted `https://` servers.                              |
| `SPEEDLE_PMS_READ_ONLY`                | No       | Set to `"true"` to register only the read tools (same as `--read-only`).                  |

## Tools (`manage` mode)

All tools call the Speedle+ PMS REST API (`/policy-mgmt/v1`, see `api/swagger/policy-manage.yaml` in teramoby/speedle-plus). Policies and role policies are returned with an `spdl` field that renders them as one SPDL statement (or `null` when SPDL cannot express them).

Read tools (registered in every `manage` run):

- **`list_services`**, **`get_service`**: `GET /service`, `GET /service/{serviceName}`.
- **`list_policies`**, **`get_policy`**: `GET /service/{serviceName}/policy[/{policyId}]`.
- **`list_role_policies`**, **`get_role_policy`**: `GET /service/{serviceName}/role-policy[/{rolePolicyId}]`.
- **`show_effective_policies`**: every policy and role policy Speedle+ evaluates for a service, as SPDL: the service's own policies and role policies plus the role policies of the `global` service, which apply to every service.
- **`validate_spdl`**: parses one SPDL policy or role policy statement locally (no PMS call) and returns the JSON body a create would send, or the parse error with its position. PMS has no validation endpoint, so the condition after `if` is checked by PMS when the policy is created.

Write tools (not registered with `--read-only`); each returns what changed:

- **`create_service`**: `POST /service`; returns the created service.
- **`create_policy`**, **`create_role_policy`**: `POST /service/{serviceName}/policy` or `/role-policy` from one SPDL statement (`spdl`) or a structured body; returns the created policy with its ID. Creates are sent once and never retried.
- **`delete_service`**, **`delete_policy`**, **`delete_role_policy`**: carry the MCP `destructiveHint` annotation and require `confirm` to equal the target's `serviceName`, `policyId` or `rolePolicyId`. A missing or different `confirm` fails without sending any request. They return the deleted object as it was before the delete.

The PMS bulk deletes (`DELETE /service`, `DELETE /service/{serviceName}/policy`, `/role-policy`), functions and discover requests are not exposed.

### Policy-Design Walkthrough

This session was run against a local Speedle+ PMS built from source (`speedle-pms --store-type file --insecure=true`) through `speedle-mcp manage`. Responses are shortened.

1. `create_service {"name":"books"}` returns `{"changed":"created","kind":"service","service":{"name":"books","type":"application",...}}`.
2. `validate_spdl {"kind":"policy","spdl":"grant librarian get /books/*"}` returns `{"valid":false,"error":"Not found principal type (user|group|role|entity)\ngrant librarian get /books/*\n      ^","position":6}`. The principal needs a type.
3. `validate_spdl {"kind":"policy","spdl":"grant role librarian get,write /books/* if hour < 18"}` returns `{"valid":true,"body":{"effect":"grant","permissions":[{"resource":"/books/*","actions":["get","write"]}],"principals":[["role:librarian"]],"condition":"hour < 18"},...}`.
4. `create_policy {"serviceName":"books","name":"librarians-edit-books","spdl":"grant role librarian get,write /books/* if hour < 18"}` returns `{"changed":"created","kind":"policy","policy":{"id":"mxfusc3jrvguv3y7q7nd",...,"spdl":"grant role librarian get,write /books/* if hour < 18"}}`.
5. `create_role_policy {"serviceName":"books","name":"alice-is-librarian","spdl":"grant user alice librarian"}` returns the role policy with its ID.
6. `show_effective_policies {"serviceName":"books"}` returns `{"counts":{"policies":1,"rolePolicies":1,"globalRolePolicies":0},"policies":[{"id":"mxfusc3jrvguv3y7q7nd","name":"librarians-edit-books","spdl":"grant role librarian get,write /books/* if hour < 18"}],"rolePolicies":[{"name":"alice-is-librarian","spdl":"grant user alice librarian",...}],...}`.
7. `delete_policy {"serviceName":"books","policyId":"mxfusc3jrvguv3y7q7nd","confirm":"books"}` fails with `ConfirmationError` and sends nothing. With `"confirm":"mxfusc3jrvguv3y7q7nd"` it returns `{"changed":"deleted","kind":"policy","policy":{...}}`.
8. `delete_service {"serviceName":"books","confirm":"books"}` returns `{"changed":"deleted","deletedPolicies":0,"deletedRolePolicies":1,"service":{...}}`.

## Development & Testing

```sh
npm ci
npm run lint          # ESLint + Prettier check + TypeScript typecheck
npm test              # Unit and security tests against a mock HTTP server
npm run test:package  # Build, npm pack, and smoke test the packed binary
```

### Running the Local Speedle+ Integration Test

`test/integration.test.ts` builds `speedle-ads` and `speedle-pms` from a local checkout of [`teramoby/speedle-plus`](https://github.com/teramoby/speedle-plus) (requires Go) and starts each on a free loopback port against a temporary file store. The `check` test exercises all four check tools over stdio. The `manage` test creates a service, validates and creates a policy and a role policy, lists them, shows the effective policies, refuses a delete with the wrong confirmation, deletes with the right one, and deletes the service. When `SPEEDLE_PLUS_DIR` is unset (and `SPEEDLE_ADS_BIN` / `SPEEDLE_PMS_BIN` are unset), the tests are skipped, including in CI.

```sh
SPEEDLE_PLUS_DIR=/path/to/speedle-plus npm run test:integration
```

## License

[UPL-1.0](LICENSE). Copyright (c) 2026 The Speedle Authors.
