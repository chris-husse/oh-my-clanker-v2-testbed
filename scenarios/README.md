# Scenario patches

Each `scenarios/<id>.patch` is a `git diff` against `main`. `scripts/build-branches.sh` turns `main` plus one
patch into one orphan branch, `scenario <id>`, with no history and no `scenarios/` folder, for the end-to-end
suite to clone. The generator reads the patches from the committed `main`, so commit a patch before generating.

| Id | Branch | Planted state |
|---|---|---|
| `vanilla` (no patch) | `vanilla` | `main` without `.omc-project/`, `scenarios/` and the generator |
| `fault-e2e-red` | `fault/e2e-red` | `balance()` ignores debits; only e2e `02-balance-sums` fails, lint and unit tests stay green |
| `fault-blind-db` | `fault/blind-db` | `post()` stores the account of an entry whose memo starts with `refund` lower-cased; only e2e `05-refund-memo` fails (`expected 1050, got 600`), the cause shows only in the held database (see below) |
| `fault-blind-http` | `fault/blind-http` | `GET /balance` looks the account up with `+` read as a space; only e2e `06-supplier-balance` fails (`expected 100, got 0`), the cause shows only in the held server's `last_request` (see below) |
| `fault-blind-state` | `fault/blind-state` | a post invalidates the cached balance under the lower-cased account; only e2e `06-supplier-balance` fails (`expected 600, got 100`), the cause shows only in the held server's `cache` counters (see below) |
| `fault-two-red` | `fault/two-red` | two independent faults: `report()` sorts descending (unit test `report is sorted by account` red, no e2e scenario touched), and `POST /entries` books an entry whose memo starts with `adjust` under the upper-cased account (only e2e `07-adjustment-memo`, new on this branch, fails, `expected 925, got 800`; the cause shows only in the held database, see below) |
| `fault-many-red` | `fault/many-red` | one helper, `bookedAccount` in `src/ledger.js`, books a `chargeback` entry under its account with `-` read as `_`: twelve e2e scenarios `07-chargeback-aster` to `18-chargeback-larch`, new on this branch, fail with numbers only; the cause shows only in the held (last) scenario's database (see below) |
| `fault-no-evidence` | `fault/no-evidence` | `balance()` converts the summed cents to a dollar amount and truncates it back, so a total like 19.99 loses a cent; only e2e `07-invoice-instalments`, new on this branch, fails (`expected 1999, got 1998`), and nothing of the run shows the cause: only the source does (see below) |
| `scenario-shell-gate` | `scenario/shell-gate` | the overlay's `omc/bin/verify` is a plain POSIX shell script (`sh omc/bin/unit.sh`, `sh omc/bin/e2e.sh`) writing and reading the same `.cache/verify/failed/<step>` records and keeping the same `--failed-only` contract; the project is green |

Names: `fault-<rest>` becomes `fault/<rest>`, any other id `scenario/<id without the scenario- prefix>`.

## Author a patch

    git checkout -b tmp main
    # edit files, including .omc-project/ when the scenario changes the overlay
    git add -A && git diff --cached main > scenarios/<id>.patch
    git reset -q --hard && git checkout main && git branch -D tmp
    git add scenarios/<id>.patch && git commit -m "feat: scenario <id>"

Check it: `scripts/build-branches.sh <id>`, then `git log --stat <branch>`. Generating twice gives the same
commit id. `scripts/build-branches.sh --push [<id>...]` force-pushes the generated branches to `origin`;
`main` is never pushed by it.

## `fault-blind-db`: the evidence is only in the database

The fault, in `src/ledger.js` `post()` (two lines):

    const key = /^refund\b/i.test(memo ?? '') ? account.toLowerCase() : account;
    ...
    .run(key, cents, memo ?? null, new Date().toISOString());

`e2e/scenarios/05-refund-memo.mjs` (on `main`, green there, the last scenario in run order, so it is the one held)
posts 27 entries to the account `Acme-7731`: a deposit of 100, `refund of invoice 7731` of 450 (entry id 2), then 25
daily credits of 20, and expects `GET /balance/Acme-7731` to answer 1050. With the fault, the refund row is stored
under the account **`acme-7731`**, the planted marker: the balance misses it and the scenario fails
`expected 1050, got 600`.

Why it satisfies the rules of the blind faults:

1. Lint (`node --check`) and the unit tests stay green: no unit test posts a memo starting with `refund`.
2. Exactly one e2e scenario fails, `05-refund-memo`, the last one, so it is held. The amounts are all positive, so
   `fault/e2e-red` (debits ignored) still passes it.
3. The failure message is numbers only, `expected 1050, got 600` (`e2e/lib/expect.mjs`).
4. The marker `acme-7731` is in the held database only: `output.txt` shows the requests with `Acme-7731`, and
   `state.json` keeps the last 20 entries (ids 8 to 27, the daily credits), never entry 2. `GET /state` and
   `state.json`'s counters show 27 entries, 2 accounts and 1050 total cents: that something is booked elsewhere, not
   where or why. `db_query` on `tally_05_refund_memo` (`SELECT * FROM entries WHERE memo LIKE 'refund%'`, or a
   `GROUP BY account`) shows the row `2 | acme-7731 | 450 | refund of invoice 7731`, and `http_get`
   `/balance/acme-7731` answers 450.
5. The fault is a two-line change in `src/ledger.js`; the fix stores `account` again (the file as on `main`).

`test/protocol/branches.test.js` (`fault/blind-db: …`) proves all five on the generated branch, through
`tally-local` on the held run.

## The server's in-memory view: `fault-blind-http` and `fault-blind-state`

`GET /state` answers the database's counters and what the server keeps in memory only (`src/server.js`, `View`):
`cache` (`hits`, `misses`, `invalidations` of its balance cache) and `last_request` (the last request it handled,
`GET /state` left out, with the `account` it used). No run file holds them: `state.json` is the database's
`state()` and its last 20 entries. Both faults fail `e2e/scenarios/06-supplier-balance.mjs` (on `main`, green there,
the last scenario in run order): it posts a deposit of 100 to `Kestrel+Sons`, reads the balance (expects 100), posts
25 daily credits of 20 and reads it again (expects 600).

`fault-blind-http`, in `getBalance` (three lines): the lookup key is `decodeURIComponent(segment.replace(/\+/g, ' '))`,
the response still echoes the account as given. The first read fails `expected 100, got 0`.

1. Lint and the unit tests stay green: the unit tests send accounts URI-encoded (`A%2BB`), never a bare `+`.
2. Only `06-supplier-balance` fails; it is the only scenario with a `+` in an account.
3. The message is numbers only.
4. The marker **`Kestrel Sons`** is in the held server's `last_request.account` only (`http_get /state`). The
   database holds one row, `Kestrel+Sons | 100`; `output.txt` shows `< 200 {"account":"Kestrel+Sons","cents":0}`;
   `http_get /balance/Kestrel+Sons` answers the same. Database and service disagree, the database shows no cause.
5. The fix looks the account up as decoded (the file as on `main`).

`fault-blind-state`, in `View.posted` (one line): the cached balance is deleted under `account.toLowerCase()`, so a
mixed-case account's cached balance is never invalidated. The second read fails `expected 600, got 100`.

1. Lint and the unit tests stay green: the unit tests' cache case uses a lower-case account.
2. Only `06-supplier-balance` reads a balance between posts to a mixed-case account.
3. The message is numbers only.
4. The marker **`"invalidations":0`** is in the held server's `cache` counters only (`http_get /state`:
   `{"hits":1,"misses":1,"invalidations":0}` after 25 posts to a cached account). The database holds the 26 rows,
   600 cents in all, exactly as posted; no run file names the cache.
5. The fix deletes the cached balance under the account as given (the file as on `main`).

`test/protocol/branches.test.js` (`fault/blind-http: …`, `fault/blind-state: …`) proves all five on the generated
branches through `tally-local` on the held run, including that a `db_query` of the held database shows no marker.

## `fault-two-red`: a unit red and a held e2e red, each with its own cause

Two faults, in two files, neither visible from the other's failure. The verify gate stops at its first failing step,
so the first attempt is red at `unit` only; once that is fixed, the next full attempt is red at `e2e` and holds.

The unit fault, in `src/ledger.js` `report()` (one line): `ORDER BY account DESC`. Only the unit test
`report is sorted by account` fails (`node:test`'s deep-equal diff of the two rows); no e2e scenario reads the report.
The fix sorts ascending again (the file as on `main`).

The e2e fault, in `src/server.js` `postEntry` (two lines), in the style of `fault-blind-db`:

    const booked = /^adjust/i.test(memo ?? '') ? account.toUpperCase() : account;
    const created = post(db, { account: booked, cents, memo });

`e2e/scenarios/07-adjustment-memo.mjs`, added by the patch (the base suite stays 01 to 06), is the last scenario, so
it is the one held. It posts 27 entries to `Birch-Lane`: a deposit of 300, `adjustment for the March statement` of 125
(entry id 2), then 25 daily credits of 20, and expects `GET /balance/Birch-Lane` to answer 925. With the fault it fails
`expected 925, got 800`.

1. Lint stays green; exactly one unit test fails, and its message names no account, memo or e2e scenario. The unit
   tests post no memo starting with `adjust`.
2. Exactly one e2e scenario fails, `07-adjustment-memo`, the last one. Its message is numbers only and names nothing of
   the report.
3. The marker **`BIRCH-LANE`** is in the held database only: `output.txt` shows the requests with `Birch-Lane`,
   `state.json` keeps the last 20 entries (ids 8 to 27), `GET /state`'s `last_request` holds the account as posted.
   `db_query` on `tally_07_adjustment_memo` shows the row `2 | BIRCH-LANE | 125 | adjustment for the March statement`.
4. Each fix is one or two lines (the files as on `main`); either fix alone leaves the other failure as it was.

## `fault-many-red`: twelve failures, one cause

The fault, a helper in `src/ledger.js` that `post()` books every entry through:

    function bookedAccount(account, memo) {
      return /^chargeback\b/i.test(memo ?? '') ? account.replace(/-/g, '_') : account;
    }

The patch adds twelve e2e scenarios, `07-chargeback-aster` to `18-chargeback-larch` (the base suite stays 01 to 06),
one file each, each its own account (`Aster-0107` to `Larch-0118`): a deposit, a `chargeback of <what> <n>` debit
(entry id 2), then 25 daily credits, and the expected balance. With the fault each fails with numbers only
(`expected 855, got 930` for 18). More than ten scenarios fail, so the hold note's sample rule applies (the held
scenario and 2 to 4 more); only the last, `18-chargeback-larch`, is held.

1. Lint and the unit tests stay green: no unit test posts a `chargeback` memo.
2. Exactly the twelve new scenarios fail, each `expected <n>, got <m>`; 01 to 06 pass.
3. The marker, the account with `_` (**`Larch_0118`** for the held scenario), is in the held database only: no run
   file (summary, junit, any `output.txt` or `state.json`, which keeps the last 20 entries, ids 8 to 27) and no
   runner output holds an `<Name>_01<nn>` account. `db_query` on `tally_18_chargeback_larch` shows the row
   `2 | Larch_0118 | -75 | chargeback of order 7018`.
4. The fix is the helper (the file as on `main`); it fixes all twelve.

`test/protocol/branches.test.js` (`fault/two-red: …`, `fault/many-red: …`) proves all of this on the generated
branches, through `tally-local` on the held run, then fixes and reruns them green.

## `fault-no-evidence`: no live trace

The fault, in `src/ledger.js` `balance()` (two lines): the sum is taken as a dollar amount and turned back into cents
with a truncation,

    .prepare('SELECT COALESCE(SUM(cents), 0) / 100.0 AS amount FROM entries WHERE account = ?')
    ...
    return Math.trunc(row.amount * 100);

so a total whose dollar amount is not exact in floating point loses a cent (`19.99 * 100` is `1998.9999999999998`).
`e2e/scenarios/07-invoice-instalments.mjs`, added by the patch (the base suite stays 01 to 06), is the last scenario,
so it is the one held. It posts 1500 and 499 to `Fir-0729` (`invoice 0729, first instalment` and `second
instalment`) and expects `GET /balance/Fir-0729` to answer 1999; with the fault it fails `expected 1999, got 1998`.

1. Lint and the unit tests stay green: every total they read is exact in dollars (1050, 7, 25, 100, 120).
2. Exactly one e2e scenario fails, `07-invoice-instalments`, the last one; its message is numbers only. The base
   scenarios' totals (1000, 7, 1050, 1075, 100, 600) are exact, so they pass.
3. Nothing of the run shows the cause, though it implicates the read path by elimination. The held database holds exactly the two posted rows, 1999 cents in all;
   `GET /state` answers 2 entries, 1 account, 1999 total cents, one cache miss and the last request as sent;
   `output.txt` and `state.json` are those of a correct server but the balance response, `1998`, which only restates
   the failure; `http_get /balance/Fir-0729` answers the same 1998. The dollar amount is never stored and never
   served: none of the rows, `/state`, the responses or the run's files shows the cause, which is visible only in the
   source. The read path is implicated by elimination (the rows and `/state.total_cents` show 1999 while `/balance`
   answers 1998 from the same rows), but nothing of the run shows what in it went wrong: by the notes' evidence bar
   (a held red is fixed only when the run's own evidence shows the cause) the investigation ends `UNRESOLVED:` with
   the code-only cause.
4. The fix is `balance()` as on `main`.

`test/protocol/branches.test.js` (`fault/no-evidence: …`) proves all four on the generated branch through
`tally-local` on the held run, then fixes it and compares the fixed run's `output.txt` and `state.json` with the
held run's: they differ in the failing number only.
