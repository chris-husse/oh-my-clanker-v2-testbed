# Scenario patches

Each `scenarios/<id>.patch` is a `git diff` against `main`. `scripts/build-branches.sh` turns `main` plus one
patch into one orphan branch, `scenario <id>`, with no history and no `scenarios/` folder, for the end-to-end
suite to clone. The generator reads the patches from the committed `main`, so commit a patch before generating.

| Id | Branch | Planted state |
|---|---|---|
| `vanilla` (no patch) | `vanilla` | `main` without `.omc-project/`, `scenarios/` and the generator |
| `fault-e2e-red` | `fault/e2e-red` | `balance()` ignores debits; only e2e `02-balance-sums` fails, lint and unit tests stay green |
| `fault-blind-db` | `fault/blind-db` | `post()` stores the account of an entry whose memo starts with `refund` lower-cased; only e2e `05-refund-memo` fails (`expected 1050, got 600`), the cause shows only in the held database (see below) |
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
