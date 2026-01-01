# tally

A tiny dependency-free ledger: a SQLite-backed library, an HTTP server and a CLI.

`node:sqlite` prints an ExperimentalWarning, so run the CLI and the server with
`--disable-warning=ExperimentalWarning` (the `bin/tally` shebang already does).

    bin/tally add <account> <amount> [--memo m]
    bin/tally balance <account>
    bin/tally report [--json]

The database path comes from `TALLY_DB` (default `data/tally.db`).

## End-to-end runs

    node scripts/e2e.mjs [--features <glob>] [--keep-alive-on-failure] [--report-dir <dir>] [--only <id,id>]
    just release [--report-dir <dir>]

Scenarios live in `e2e/scenarios/`; each gets its own database `data/tally_<slug>.db` and
port. Reports land in `target/e2e-runs` (`summary.md`, `junit.xml`, `stack.env`, `ports.env`,
`scenarios/<id>/`). With `--keep-alive-on-failure`, a failed run keeps the last failed
scenario's server and database alive, writes `harness.pid` and `harness.holding`, and prints
`OMC_HOLD <run dir>` every `TALLY_HOLD_BEAT` seconds (default 30) until `just release`, a
signal, or `TALLY_HOLD_TIMEOUT` seconds (default 1800). `TALLY_BACKDATE_HOLD=<seconds>`
backdates `harness.pid`, whose mtime is the hold's start.

## The omc project overlay

`.omc-project/` is what this project owns inside `omc/` once oh-my-clanker v2 is installed: the gates
`bin/check`, `bin/build` (`dist/tally.mjs`, via `scripts/build.mjs`) and `bin/verify [--failed-only]` (lint, unit,
e2e; failed steps recorded under `.cache/verify/failed/` by `scripts/failed.mjs`), their notes `bin/verify.md` and
`bin/verify.hold.md`, the briefing `hook/investigation/investigation-context.local.md`, `config.yaml` and
`AGENTS.md`. Copied into `omc/`, the gates run from `omc/bin/`.
