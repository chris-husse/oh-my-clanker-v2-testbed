# investigation-context: local (a held e2e run)

The env briefing for `/investigate local <prompt>`. `local` is a test-run mode: the investigation of one failed
scenario of an e2e run that `omc/bin/verify` holds alive (`--keep-alive-on-failure`; the gate log's last line is
`OMC_HOLD <run-dir>`). The caller is the `/verify` terminal, which owns the run and releases it
(`omc/bin/verify.hold.md`).

## Not a live system

Frame everything as e2e-run artifacts, not a live remote system. The evidence is:

- the run's files on disk (the scenario folder and the run dir);
- the held tally server: the last failed scenario's service, still answering on the run's port, read through
  `http_get`;
- the held scenario's own SQLite database, read through `db_query`.

No Splunk, no Grafana, no metrics source, no docker logs, no other environment. Only the held scenario has a live
server and database; every other failing scenario of the run is investigated from its folder's files alone.

git history and diffs are not evidence: no `git log`, `git diff`, `git show`, `git blame`, `git reflog`, and no
reading of session logs (`.claude/projects`, `*.jsonl`); the evidence is the run dir, the held service and the run's
database.

## Required input, or refuse

The required input is the absolute path of the failing scenario folder under investigation:
`<run-dir>/scenarios/<NN-name>/`. The run dir `<run-dir>` (`target/e2e-runs` unless a `--report-dir` was given) may be
passed in the request or derived as the scenario folder's grandparent. Quote every path in a shell command
(`"<run-dir>"`): a path may contain spaces.

Without a scenario folder path, refuse: query nothing, ask nothing, and answer with this result, its first line being
exactly the first line below:

> BLOCKED: no scenario folder given. Local has no Splunk and no live system to query. Point me at a scenario folder
> under `target/e2e-runs/scenarios/<NN-name>/` (the failed scenario's own directory) and I'll investigate that run.

A request with a run dir but no scenario folder is refused the same way, and so is a folder that does not exist or has
no `output.txt`.

## Namespace

- MCP namespace: `mcp__tally-local__*` only (`server_info`, `db_query`, `http_get`), all read-only.
- The tools are deferred in a subagent session: load them before the first call with one `ToolSearch` query using
  `select:` and the exact names:
  `select:mcp__tally-local__server_info,mcp__tally-local__db_query,mcp__tally-local__http_get`.
- Call `server_info` first and quote `database.user` from its answer. It must be `readonly`; any other value is a
  `tally-local` failure (see "When `tally-local` fails"). `server_info` may list databases: never take a database from
  that list.
- No other MCP namespace, and no other route to the same data.

## Parameters: only from the run's files

Never guess a value and never use a default. Read these files and quote the values you use:

| Value | File | Key |
|---|---|---|
| Database name (`tally_<slug>`) | `<run-dir>/stack.env` | `TALLY_DATABASE` |
| Database file, relative to the project root | `<run-dir>/stack.env` | `TALLY_DB_PATH` |
| Held server's port | `<run-dir>/ports.env` | `TALLY_PORT` |

The lines read `KEY=value`. A missing file or key is a `tally-local` failure.

- The scenario is the held one when its `output.txt` has the line `database <TALLY_DB_PATH>`. Only then do
  `db_query` and `http_get` describe it; for any other scenario make no `tally-local` call but `server_info`, and work
  from its folder.
- Every `mcp__tally-local__db_query` call passes `database` (the database name, `TALLY_DATABASE`) and one `SELECT`.
  The schema is one table, `entries (id, account, cents, memo, at)`, amounts in integer cents.
- Every `mcp__tally-local__http_get` call passes `port` (`TALLY_PORT`) and a `path`: `/state` or
  `/balance/<account>`. The server answers `GET` only; `http_get` never writes.
- Never use the `base` port or database printed in another scenario's `output.txt`, a port or database of another
  checkout or run, or a database named by `server_info`.

## Logs: files only

The lead's logs are in the scenario folder. Read in this order, only as far as you need:

1. In the scenario folder: `output.txt` (the scenario id and title, its `base` URL and `database`, then every request
   `> METHOD path body` and response `< status body` in order, and last `PASS` or `FAIL <error and stack>`), then
   `state.json` (the database after the scenario: `state` and the last 20 `entries`).
2. Only when the folder does not explain the failure, the run dir: `summary.md`, `junit.xml` (the failure message of
   each scenario), and the sibling `scenarios/<other>/` folders.
3. If `summary.md` is missing, read `junit.xml` for the failing scenarios, and say in the report that `summary.md` was
   missing.
4. Then, for the held scenario only, the live state through `tally-local`: the entries and accounts the scenario
   names, found from the requests in `output.txt`.

Use file reads and read-only `grep` or `tail`; never `git log`, `git diff`, `git show`, `git blame`, `git reflog`
or a session log (`.claude/projects`, `*.jsonl`). The scenario's code under `e2e/scenarios/` and the code under `src/`
may be read to understand what was expected; they are not evidence of what happened.

tally's server has no background work: nothing advances the held database after the scenario ends, so the held state
is the state the failure left, unless a request of the scenario is still in flight; say so when a finding depends on
it.

## Lead: the failed scenario

The lead is the failed scenario: its id and the `FAIL` line of `output.txt`, and every account, amount and entry id
named in its requests and responses. Every claim quotes its source: the file and line (or field), or the `tally-local`
call (tool, `database` or `port`, `sql` or `path`) that returned the rows or response. A claim with no quote is a
guess; leave it out or say it is unknown.

## When `tally-local` fails, stop

`BLOCKED` is for tooling and access failures only, and there is no files-only fallback for the held scenario. These are
such failures: a missing or failed tool, an error from any `tally-local` call (a database that does not exist, a port
whose request failed), a `server_info` whose `database.user` is not `readonly`, a missing file or key in the parameters
table, a missing lead or missing input, and a hold that has already ended when the investigation starts
(`<run-dir>/harness.pid` gone). Database calls that still answer do not prove the hold is alive: when the runner exits
only the server dies, and the database file keeps answering.

On any of them: stop at once and end with a result whose first line is `BLOCKED: <cause>`, followed by the exact error
text. The caller decides what happens next. Never substitute another route: no other port, no other database, no
`sqlite3` or `node` against `data/`, no `curl` to the port, no other environment's MCP namespace. Every tooling or
access failure is `BLOCKED:`, never `UNRESOLVED:`: a failed `tally-local` call is not a dead end.

The two non-blocked results, each starting the result with its label:

- `UNRESOLVED: <what is unknown>`: a dead end or an inconclusive scenario whose reads and queries ran, followed by
  every quote gathered and what was ruled out; never the label of a tooling or access failure;
- `HOLD_ENDED: <what was gathered>`: the hold ended while the investigation ran (the hold guard below), followed by
  the quotes gathered so far.

A result carries exactly one label, or is a diagnosis with none.

## Hold guard

The hold ends on its own 1800 seconds (30 minutes) after it began. The hold's start is the modification time of
`<run-dir>/harness.pid`, written once when the hold begins: `stat -c %Y -- "<run-dir>/harness.pid"` (Linux) or
`stat -f %m -- "<run-dir>/harness.pid"` (macOS). Compute it yourself; the request may pass the same value. Elapsed
time is `date +%s` minus it. Before each batch of `tally-local` calls, and at least every 5 minutes, check both:

- `test -f "<run-dir>/harness.pid"` succeeds (the runner deletes the file when the hold ends);
- the elapsed time is under 1500 seconds (25 minutes), which keeps a margin before the runner's own 1800.

If either check fails once the investigation has started, end with `HOLD_ENDED: <what was gathered so far>`, with the
quotes. (A file already gone at the start is `BLOCKED:`, above.) Otherwise stop querying as soon as the evidence for
the failure under investigation is in hand.

## Read-only; the caller releases the run

Modify nothing: not the database, the server, the run dir or the project's files; `db_query` takes a single `SELECT`
and `http_get` only reads, and no route around that exists. Never run `just release` or `node scripts/release.mjs`,
never stop the server and never kill a process: the caller owns the release.

## Execution model: a focused leaf, unattended

Run as a focused leaf, not a worker pool: no worker dispatch, no subagents. Do the file reads and the `tally-local`
queries directly in the thread. The confidence rules, the halting rules, the investigation folder and the reporting of
the skill still apply; the worker-mission constraints (read-only, no cross-environment, no speculation) are the
constraints you operate under.

This briefing makes the run unattended: it runs inside a terminal nobody watches and never asks anyone. No
`AskUserQuestion`, no clarifying question, no pause for the user. Every point where the skill would ask, pause or halt
as blocked ends the investigation with a result instead:

- a tooling or access failure, or a missing lead or input: `BLOCKED: <cause>`;
- a dead end, conflicting evidence or an inconclusive scenario: `UNRESOLVED: <what is unknown>`, with the quotes
  gathered;
- the hold ending mid-investigation: `HOLD_ENDED: <what was gathered>`.

The skill's other pause rows map the same way: with "two plausible next directions" follow the lead's direction (the
failed scenario's own `FAIL` line and the requests before it), and when no direction is predictable, or the result of a
next query that would run fine cannot be predicted, end `UNRESOLVED:`. A failing call is never that: it is `BLOCKED:`.

Skip the `/explain` pre-flight. Run `/explain` inline on a load-bearing finding (one whose weight rests on how the code
behaves) only when the question and its answer fit the hold guard's time budget. A finding `/explain` did not validate
is reported as a hypothesis, said so in the result, not as a cause.

## Env-lock echo (local shape)

Name the test-run mode, the scenario folder, the namespace and the folder:

> Running against **local** (e2e-run artifacts, not a live system) · scenario `<run-dir>/scenarios/<NN-name>/` ·
> server/DB via `mcp__tally-local__*` · folder `<folder>`

## Reporting

Chat only: the narrative is the report, and every finding is quoted as it lands. Any file the investigation writes (a
download, a scratch file) goes in the investigation `<folder>` of the skill, never `/tmp`.

The result states, in this order:

1. The values used, quoted from the files: `TALLY_DATABASE`, `TALLY_DB_PATH`, `TALLY_PORT`, whether the scenario is
   the held one, and `server_info` `database.user`.
2. Each `tally-local` call made: tool, `database` or `port`, `sql` or `path`; one line each.
3. The finding: the cause, with the quoted lines, rows or responses that showed it and the file or call that returned
   them, and the file and function under `src/` where the cause lies when the code shows it.
4. For a result that is not a diagnosis, the first line of the whole result instead, one label only:
   `BLOCKED: <cause>` with the exact error (tooling or access), `UNRESOLVED: <what is unknown>` with the quotes
   gathered (dead end), or `HOLD_ENDED: <what was gathered>` (the hold ended mid-investigation).
