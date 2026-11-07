# Repository guidance

speedle-mcp holds the official Model Context Protocol (MCP) server for self-hosted Speedle and Speedle Cloud.

## Spec and Modes

- One package, `@speedle/mcp`, with one binary, `speedle-mcp`, that runs as a local stdio MCP server in one of two explicit modes:
  - `speedle-mcp check` registers only `is_allowed` by default and reads only ADS configuration. `diagnose`, `all_granted_roles`, and `all_granted_permissions` each require an explicit `--expose-*` flag or `SPEEDLE_EXPOSE_*` environment variable; `diagnose` is refused on `speedle-cloud`.
  - `speedle-mcp manage` registers only the policy management tools and reads only PMS configuration.
- Never offer a default mode that exposes both tool sets. Running with no mode prints usage and exits non-zero.
- Shared client code (configuration, HTTP transport, retries, typed attributes, and errors) lives in `src/core` and follows `teramoby/speedle-sdk`'s `docs/design.md` (§3.2.1 typed attributes, §3.4 and §7 errors, §6 retries). Once `@speedle/sdk` is published to npm, `src/core` will move to `@speedle/sdk`.

## Security

- `serviceName` always comes from environment configuration in `check` mode, never from the tool caller.
- Bearer tokens and credentials come only from environment variables and must never appear in tool output, errors, logs, `toString`, `JSON.stringify`, or `util.inspect`.
- Tool descriptions in `check` mode must state plainly that the tools answer authorization questions and do not enforce access control.

## License

- UPL-1.0, copyright line `Copyright (c) 2026 The Speedle Authors`. The package declares SPDX `UPL-1.0` and ships the `LICENSE` file.

## Writing

- English for code, comments, docs, commits, PRs, and reviews.
- Conventional Commits for commit messages and PR titles, for example `feat: package scaffold and check mode`.

## Releases

- Never publish packages by hand.
