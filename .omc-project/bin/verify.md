# verify: notes on its reds

- **The steps, in order**: `lint` (`node --check` over `src/**/*.js`, `bin/tally`, `scripts/*.mjs`, `mcp/*.mjs`),
  `unit` (`node --test 'test/unit/*.test.js'`), `e2e` (`node scripts/e2e.mjs --keep-alive-on-failure`, every
  scenario of `e2e/scenarios/`). The script stops at the first failing step and exits with its status.
- **`lint` or `unit` red inside `verify`** passed in `check`, which runs the same commands: explain it and fix it,
  never just rerun it.
- **An e2e scenario's evidence** is its folder `target/e2e-runs/scenarios/<NN-name>/` (`output.txt`: every request
  and response and the failure; `state.json`: the database after it), linked from the `FAIL` rows of
  `target/e2e-runs/summary.md`. Each scenario has its own database `data/tally_<slug>.db` and its own port, so
  scenarios never share state.
- **`--failed-only`** (`just omc gate run verify --failed-only`; to the `/verify` terminal, `args: --failed-only`):
  reruns only what the last attempt recorded under `.cache/verify/failed/`, one file per failed step (`lint`, `unit`,
  `e2e`), one id per line. A recorded `e2e` reruns just its `FAIL` scenarios (`--only <id,id>`); a recorded `unit`
  reruns just its failing test names (`--test-name-pattern`); `lint` reruns whole. A step whose ids cannot be read (no
  `summary.md`, a test file that failed to load) is recorded as the whole step, says so, and reruns whole. A pass
  clears a step's record; with no records the run exits 1 (`nothing recorded to rerun`) before doing anything. A
  `--failed-only` run never gives the verdict: only a fresh full run on a clean tree does.
- **Only the first failed step of an attempt is recorded**: later steps get no new record and run in the next full
  attempt. A stale record of an earlier attempt stays until its step passes, in a full run or a rerun.
- **A held run keeps its `verify` slot.** `e2e` runs with `--keep-alive-on-failure`: on a failure the last failed
  scenario's server and database stay up and the log carries `OMC_HOLD <dir>` until `just release --report-dir
  "<dir>"` (see `omc/bin/verify.hold.md`), or 1800 s. The gate's `silence` limit must stay unset, or an
  investigation looks like a stall.
