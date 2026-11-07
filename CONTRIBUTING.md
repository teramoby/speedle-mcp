# Contributing to Speedle MCP

We welcome your contributions! There are multiple ways to contribute.

## Issues

If you hit a bug or have an enhancement request then file a
[GitHub issue](https://github.com/teramoby/speedle-mcp/issues).

If you report a bug, please include:

1. The `@speedle/mcp` version, or the commit you ran
2. Issue description
3. Reproducible environment and steps
4. Expected behavior

Never paste a bearer token or any other credential into an issue.

## Security

Do not report a security issue in a public issue. See [SECURITY.md](SECURITY.md)
for the private reporting channels.

## Code

We welcome code contributions.

Contributions to Speedle are made under the Universal Permissive License 1.0
(UPL-1.0). Please sign off your commits to certify that you have the right to
submit your contribution under the Developer Certificate of Origin (DCO) 1.1.
Retain existing copyright and license notices and identify any third-party
material in your pull request.

Sign off each commit with `git commit -s` (see [DCO](DCO) and
[UPL-1.0 LICENSE](LICENSE)), which adds a
`Signed-off-by: Your Name <you@example.com>` trailer using your Git `user.name`
and `user.email`. To add a sign-off to existing commits, run
`git commit --amend -s` for the most recent commit or
`git rebase --signoff origin/main` for a branch of commits.

The process:

1. Sign off each commit with `git commit -s` (see [DCO](DCO) and
   [UPL-1.0 LICENSE](LICENSE))
2. Fork the repo
3. Fix an issue or create an issue and fix it
4. Create a Pull Request that fixes the issue
5. Watch your PR for pipeline results. If there are failures then fix them.
6. We will review your PR and merge as appropriate.

Read [AGENTS.md](AGENTS.md) before changing the server. It records the `check`
and `manage` mode split, the rule that tokens and credentials never appear in
tool output, errors or logs, and the writing and release rules.

Run the checks from the repository root:

```sh
npm ci
npm run lint
npm test
npm run test:package
```

The local integration test needs Go and a checkout of
[teramoby/speedle-plus](https://github.com/teramoby/speedle-plus). It is skipped
when `SPEEDLE_PLUS_DIR` is not set, including in CI:

```sh
SPEEDLE_PLUS_DIR=/path/to/speedle-plus npm run test:integration
```

## Code of Conduct

Follow the [Golden Rule](https://en.wikipedia.org/wiki/Golden_Rule). If you'd
like more specific guidelines see the
[Contributor Covenant Code of Conduct](https://www.contributor-covenant.org/version/1/4/code-of-conduct.html).
