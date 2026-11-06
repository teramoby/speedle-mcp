# @speedle/mcp

Local stdio [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for [Speedle+](https://github.com/teramoby/speedle-plus) and [Speedle Cloud](https://cloud.speedle.io): authorization checks (`check` mode) and policy management (`manage` mode).

> **Note:** The shared ADS client in `src/core` follows the `teramoby/speedle-sdk` design specification (typed attributes, error model, and retry policy) and will move to `@speedle/sdk` once `@speedle/sdk` is published on npm.

## Security: Why Two Modes in One Package

Authorization checks are read-only queries and are typically wired into an AI agent whose actions Speedle governs. Policy management writes policy. **An agent that holds both tool sets could be prompted into granting itself access.**

To enforce separation of privilege:

- `npx @speedle/mcp check` registers **only** the read-only authorization check tools (`is_allowed`, `diagnose`, `all_granted_roles`, `all_granted_permissions`) and reads **only** ADS configuration.
- `npx @speedle/mcp manage` registers **only** the policy management tools and reads **only** PMS configuration (tracked in [#2](https://github.com/teramoby/speedle-mcp/issues/2)).
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

### `manage` mode — Speedle+ Policy Management ([#2](https://github.com/teramoby/speedle-mcp/issues/2))

> Never wire `manage` mode into an agent whose own actions are governed by these policies.

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

## Development & Testing

```sh
npm ci
npm run lint          # ESLint + Prettier check + TypeScript typecheck
npm test              # Unit and security tests against a mock HTTP server
npm run test:package  # Build, npm pack, and smoke test the packed binary
```

### Running the Local Speedle+ Integration Test

`test/integration.test.ts` builds `speedle-ads` from a local checkout of [`teramoby/speedle-plus`](https://github.com/teramoby/speedle-plus) (requires Go), starts it on a free loopback port against a temporary file store, connects to `speedle-mcp check` over stdio, and exercises all four check tools (`is_allowed`, `diagnose`, `all_granted_roles`, `all_granted_permissions`). When `SPEEDLE_PLUS_DIR` (and `SPEEDLE_ADS_BIN`) is unset, the test is automatically skipped (including in CI).

```sh
SPEEDLE_PLUS_DIR=/path/to/speedle-plus npm run test:integration
```

## License

[UPL-1.0](LICENSE). Copyright (c) 2026 The Speedle Authors.
