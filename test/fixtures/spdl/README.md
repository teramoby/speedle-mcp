# SPDL differential test fixtures

`test/spdl-golden.test.ts` checks the TypeScript SPDL port in `src/manage/spdl.ts` against the real Go parser, teramoby/speedle-plus `pkg/pdl` (`ParsePolicy` and `ParseRolePolicy`). CI runs it without Go, from the committed files here:

- `corpus.json`: the input statements, each with its source. It holds every SPDL string extracted from the speedle-plus parser tests and grammar corpus (`pkg/pdl/*_test.go`, `testutil/pdltest`), other Go tests, `.spdl` files, the docs and the speedle.io home page, the speedle-sdk `e2e/policies.json` policies, generated variants (missing keywords, bad conditions, bad quoting, Unicode spaces and names, trailing garbage), and the SPDL that `renderPolicy` / `renderRolePolicy` produce for the statements that parse.
- `golden.json`: what the Go parser returns for each statement, both as a policy and as a role policy: the JSON body, or the error reason and byte position.
- `golden.go`: the Go program that writes `golden.json`.

For every statement and both kinds, the test requires:

- Go accepts: the port accepts and builds the same JSON body.
- Go rejects the statement: the port throws `SpdlError` with the same reason and, where Go reports one, the same position (in UTF-8 bytes).
- Go rejects only the condition (`condition.Check`): the port accepts the statement and passes the condition on; PMS runs the same check when the policy is created and rejects it there. This is why `manage` mode has no local validation tool.

It also requires that the SPDL the port renders for each accepted statement is in the corpus and that Go parses it back to the same body.

## Regenerating

Do this whenever the speedle-plus parser changes or `src/manage/spdl.ts` changes. You need Node.js, Go, and checkouts of teramoby/speedle-plus and teramoby/speedle-sdk.

```sh
npm run build:test
node scripts/spdl-corpus.mjs /path/to/speedle-plus /path/to/speedle-sdk > test/fixtures/spdl/corpus.json
(cd /path/to/speedle-plus && go run "$OLDPWD/test/fixtures/spdl/golden.go" \
  < "$OLDPWD/test/fixtures/spdl/corpus.json" > "$OLDPWD/test/fixtures/spdl/golden.json")
```

Then set `SPDL_SPEEDLE_PLUS_COMMIT` in `src/manage/spdl.ts` to the speedle-plus commit recorded in `golden.json` and run `npm test`.
