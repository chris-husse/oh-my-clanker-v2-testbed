# tally: project instructions for omc sessions

tally is a tiny dependency-free ledger on Node (22.5 or later, `node:sqlite`): a library over one SQLite table, an
HTTP server and a CLI. Amounts are integer cents throughout.

## Layout

| Path | Holds |
|---|---|
| `src/db.js`, `src/ledger.js`, `src/server.js` | the schema (`entries (id, account, cents, memo, at)`), the ledger functions, the HTTP server (`POST /entries`, `GET /balance/<account>`, `GET /state`: the counters, the balance cache, the last request) |
| `bin/tally` | the CLI: `add <account> <amount> [--memo m]`, `balance <account>`, `report [--json]`; database from `TALLY_DB` |
| `test/unit/*.test.js` | unit tests (`node:test`) |
| `e2e/scenarios/NN-name.mjs` | end-to-end scenarios, each on its own server, port and database `data/tally_<slug>.db` |
| `scripts/e2e.mjs`, `scripts/release.mjs` | the e2e runner (reports in `target/e2e-runs`) and the release of a held run |
| `scripts/build.mjs`, `scripts/failed.mjs` | the build (`dist/tally.mjs`) and verify's failed-step records |
| `mcp/tally-mcp.mjs` | `tally-local`, the read-only MCP server for investigating a held run |
| `test/protocol/*.test.js` | tests of the runner, the release, the MCP server and the gates |
| `docs/rules/*.md`, `docs/decision-log.md` | the rules of the ledger and of its report: protected documents, changed only through a decision of the log (`just decisions`, `/apply-decision`) |

## Commands

- Unit tests: `node --test 'test/unit/*.test.js'`; one test: add `--test-name-pattern '<regex>'`.
- All tests: `node --test 'test/unit/*.test.js' 'test/protocol/*.test.js'` (quote the globs; `node --test` does not
  recurse into directories).
- The gates: `omc/bin/check` (every source parses, then the unit tests), `omc/bin/build` (`dist/tally.mjs`),
  `omc/bin/verify [--failed-only]` (lint, unit, e2e; see `omc/bin/verify.md`). Run them through
  `just omc gate run <gate>`.
- E2E: `node scripts/e2e.mjs [--only <id,id>] [--keep-alive-on-failure]`; end a hold with
  `just release --report-dir <dir>`, never with `kill`.

## Conventions

- Node's standard library only: no dependencies, no `package-lock.json`.
- ES modules (`"type": "module"`); `node:sqlite` prints an ExperimentalWarning, so pass
  `--disable-warning=ExperimentalWarning` when running the CLI, the server or the tests.
- A behaviour change comes with its unit test; a new end-to-end flow with its scenario in `e2e/scenarios/`.
- `target/`, `data/`, `dist/` and `.cache/` are generated and never committed.
- `/verify` and `/investigate` read no git history, from their first command on: no `git log`, `git show`,
  `git blame`, `git reflog`, no `git diff` against any revision but `HEAD`, and never one through `--git-dir` or
  `--work-tree`. History is no evidence of a run; the run dir, the held service and its database are
  (`omc/bin/verify.hold.md`). `git status --porcelain` shows the tree and `git rev-parse --short HEAD` the commit.
