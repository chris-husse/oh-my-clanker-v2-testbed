# verify: a held e2e run

Read this when the gate log's last line is `OMC_HOLD <run-dir>`. The run is held on purpose, not stuck: an e2e
scenario failed and `--keep-alive-on-failure` keeps the last failed scenario's server and database alive so you can look
at the state the failure left behind. The gate stops at its first failing step, and one scenario is held per attempt; a
scenario fixed in this attempt lets another failing scenario be held in the next one. A held run keeps one verify slot
until it is released. Never kill the run. You end the hold with `just release` (step 6), and no turn ends before that.
`just release` stops only the held e2e runner (it signals only the pid in `<run-dir>/harness.pid`, and only when that is
`node scripts/e2e.mjs`): it is the intended end of the hold, not a kill of the gate. The gate run then ends red; after
the release, continue with your loop (step 5 of the terminal: rerun what the fixes fixed, then a fresh full run from
its step 1). Never rerun the gate while the run is held.

The investigation is `/investigate local`. Its WHERE (the `tally-local` namespace, the parameters and the files they
come from, the read-only and no-fallback rules, the `BLOCKED:`, `UNRESOLVED:` and `HOLD_ENDED:` results, the report
shape) is `omc/hook/investigation/investigation-context.local.md`; this note holds only the lifecycle around it. The
investigation's own folder is `investigations/` beside the primary checkout (in the parent of the primary checkout's
directory, not in the worktree), is never committed and is created only when something is written to it.

## 1. The hold's clock and run dir

1. `<run-dir>` is the directory the marker names (`target/e2e-runs` unless a `--report-dir` was given). Quote it in
   every shell command: `"<run-dir>"`.
2. `test -f "<run-dir>/harness.pid"` must succeed: the runner deletes the file when the hold ends. If it is missing
   before any investigation started, there is nothing live to investigate: BLOCKED, step 5. If it is missing later, the
   hold is over: step 4.
3. The hold's start is the modification time of that file: `stat -c %Y -- "<run-dir>/harness.pid"` (Linux) or
   `stat -f %m -- "<run-dir>/harness.pid"` (macOS). Elapsed time is `date +%s` minus it. The runner ends the hold on its
   own at 1800 seconds. New investigations start only while the elapsed time is under 1200 seconds (20 minutes).

## 2. Find the failing scenarios

Read `"<run-dir>/summary.md"`: the `FAIL` rows. Each row names a scenario id and links its folder
`<run-dir>/scenarios/<NN-name>/` (`output.txt`, `state.json`). If `summary.md` is missing, read `<run-dir>/junit.xml`
for the failing scenarios (each `<testcase>` with a `<failure>`; its `name` is the scenario id and the folder is
`<run-dir>/scenarios/<id>/`), and say so in the report.

The held scenario is the one whose `output.txt` has the line `database <TALLY_DB_PATH>`, with `TALLY_DB_PATH` from
`<run-dir>/stack.env`: only it has a live server and database. Investigate it first.

Up to 10 failing scenarios: investigate each in turn. More than 10: the held scenario and a sample of 2 to 4 more, taken
from different scenario files; the rest listed as not investigated, each on its own line by its scenario id and title
(`<NN-name>: <title>`, from `summary.md`), never as a range or a count.

## 3. Investigate, one scenario per call

Before each call, check step 1.2 and that the elapsed time (step 1.3) is under 1200 seconds. If the file is gone, or the
time limit is reached, stop starting investigations: step 4 (BLOCKED, step 5, when the file was gone before the first
investigation started).

Run `/investigate local <prompt>`, one scenario per call. The prompt names:

- `<run-dir>` and the absolute path of the scenario folder `<run-dir>/scenarios/<NN-name>/`;
- the held-run facts: the run is held on purpose, the held scenario's server keeps running, its database and its
  server are the live evidence, and `tally-local` is the only route to them; whether this scenario is the held one
  (step 2), since only the held scenario's live state is its own;
- where the parameters live: `<run-dir>/stack.env` (`TALLY_DATABASE`, `TALLY_DB_PATH`) and `<run-dir>/ports.env`
  (`TALLY_PORT`);
- the question: why did this scenario fail.

The result starts with one label, or is a diagnosis:

- a diagnosis: quote it in the report; only a diagnosis counts as a completed investigation;
- `UNRESOLVED: <what is unknown>`: a dead end with its quotes, listed in the report; not completed, never fixed;
- `HOLD_ENDED: <what was gathered>`: the hold ended during the investigation; interrupted, not completed, never fixed:
  step 4;
- `BLOCKED: <cause>`: a tooling or access failure, a missing lead or missing input: step 5.

`/investigate local` runs inline, in this turn: its result returns to you. Go on with step 4 or 5 and the release
(step 6) at once, in the same turn; the result is never the end of the turn.

If `/investigate local` cannot be run (the skill is missing, the Skill tool is unavailable), refuses, prints its usage,
or returns `BLOCKED:`, that is BLOCKED: step 5. Never investigate in place of `/investigate local` a scenario the note
told you to investigate, and never fix such a scenario from the logs alone.

## 4. The time limit, and continuing

The time limit is: the elapsed time reaches 1200 seconds, the hold ends (`<run-dir>/harness.pid` is gone) after an
investigation started, or an investigation returns `HOLD_ENDED:`. Stop starting new investigations and release the run
(step 6).

After the release (the time limit reached, or every scenario you chose investigated), decide from the results. Only an
investigation that returned a diagnosis is completed.

- At least one diagnosis: continue with the normal fix loop from the diagnoses (the released run's server is gone).
  `UNRESOLVED:` and interrupted (`HOLD_ENDED:`) scenarios are never fixed from the logs. Only a scenario NOT
  investigated (more than 10, or past the 1200-second start limit) may be fixed from its folder's files, and the report
  says so. git history and diffs are not evidence: no `git log`, `git diff`, `git show`, `git blame`, `git reflog`,
  and no reading of session logs (`.claude/projects`, `*.jsonl`); the evidence is the run dir, the held service and
  the run's database.
- No diagnosis (none completed, or every investigation `UNRESOLVED:` or interrupted): return `needs_user` listing the
  `UNRESOLVED:` and interrupted scenarios, with the fix "rerun `/verify`" or "give the fixer more evidence: the
  scenario artifacts are in `<run-dir>`", and do not fix.

The report lists the failing scenarios not investigated, the `UNRESOLVED` ones and the interrupted ones. Never change
code while the run is held.

## 5. BLOCKED

BLOCKED means a tooling or access failure, and it always ends without a fix: an `/investigate local` that cannot be run
or returns `BLOCKED:`, an error from any `tally-local` call, a missing run file or key, or `<run-dir>/harness.pid` gone
before any investigation started.

Stop investigating at once, release the run (step 6), and return `needs_user` with the exact error text and the fix that
matches the cause:

- a `tally-local` failure (a failed call, a missing tool, a `database.user` other than `readonly`): restart the
  `tally-local` MCP server (`node mcp/tally-mcp.mjs`, run from the root of the checkout that holds the run, whose
  `data/` folder has the run's databases), then reconnect the MCP client (`/mcp` in Claude Code), and rerun `/verify`;
- a missing run file or key (`summary.md` and `junit.xml` both, `stack.env`, `ports.env`; the runner writes them into
  the run dir), or a hold already gone before any investigation started: rerun `/verify`;
- `/investigate` refused at its Step 0 because `omc/hook/investigation/investigation-context.local.md` is missing:
  restore `omc/hook/investigation/investigation-context.local.md`;
- the `/investigate` skill missing or unavailable: reinstall omc (`just install`) and restore the skill link;
- a prompt error (the scenario folder missing from the request): correct the prompt and rerun `/verify`.

After a BLOCKED you do not fix: no code change is made on this path. A `BLOCKED:` whose cause is "hold already gone"
ends the same way, even after earlier investigations completed: the live state is gone and the evidence is partial, so
it fails closed by intent.

## 6. Always release, even when the investigation errors

Do this on every path out of the investigation: done, time limit, `HOLD_ENDED:`, BLOCKED or error. Release as soon as
you have the evidence; do not wait for more.

1. Run `just release --report-dir "<run-dir>"` (it runs `node scripts/release.mjs --report-dir "<run-dir>"`). It
   signals the held runner, waits up to 120 seconds for it to exit, and prints `RELEASED` only when it is gone and the
   held port is free; without `harness.pid` it prints `RELEASED` once the port is free, so a second release succeeds
   too. If the output is not `RELEASED`, or the exit status is 1, the run is still held: run it again once. If it still
   fails, report the stderr verbatim as `needs_user`, naming the pid in `<run-dir>/harness.pid`. Do not kill processes
   by hand.
2. `RELEASED` already includes the port check; look a second time. With `TALLY_PORT` from `<run-dir>/ports.env`:
   `ss -ltnH "sport = :<port>"` (Linux) or `lsof -nP -iTCP:<port> -sTCP:LISTEN` (macOS) prints nothing when the port
   is free. Output means something still listens: `needs_user`, quoting it. When `ports.env` is unreadable, skip this
   look: the `RELEASED` already includes the check.
3. If you came here from step 5, or 6.1 or 6.2 failed: stop. Return `needs_user` with the exact error and the fix, and
   do not fix code. Otherwise decide as step 4 says.

Never end a turn with a run held. Never stop a server, delete a database under `data/` or remove a file of
`<run-dir>` by hand: only `just release` ends the hold.

## Report

State, in this order:

1. Each `/investigate local` call: the scenario folder and its result, quoted: the values used, the `tally-local` calls
   (tool, `database`, `port`, `path` or `sql`), the quoted rows or responses, and the cause.
2. The `UNRESOLVED` investigations, the interrupted ones (`HOLD_ENDED:`) and the failing scenarios not investigated
   (more than 10, or the time limit), each on its own line by scenario id and title, never as a range or a count; and
   which of those you fixed from the files.
3. The `just release` output (`RELEASED`) and the port check result.
