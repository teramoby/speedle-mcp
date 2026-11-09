# Changelog

## 0.2.0 (2026-11-10)

- `manage` mode supports Speedle Cloud through `SPEEDLE_PMS_BACKEND="speedle-cloud"` and a `pms:read` or `pms:write` token. The backend defaults to `"speedle"`, so existing self-hosted setups do not change.
- On Speedle Cloud, `create_service` returns `409 service_exists` when the service already exists or the account has reached its service limit.
- PMS errors get typed handling for HTTP 409 (`ConflictError`), Cloud error codes and `quotaDailyRemaining`.
- Breaking: the self-hosted backend value `"speedle-plus"` is now `"speedle"`, in `SPEEDLE_BACKEND` and in the `Backend` type. There is no alias for the old name.
- The local integration test reads the Speedle checkout from `SPEEDLE_DIR` instead of `SPEEDLE_PLUS_DIR`.
- First release on npm.

## 0.1.0 (not published)

- First version: one `speedle-mcp` binary with `check` mode (`is_allowed` by default; `diagnose`, `all_granted_roles` and `all_granted_permissions` behind explicit opt-ins) and `manage` mode (policy management through the PMS REST API, with SPDL input and output).
