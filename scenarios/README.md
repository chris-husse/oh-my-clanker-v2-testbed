# Scenario patches

Each `scenarios/<id>.patch` is a `git diff` against `main`. `scripts/build-branches.sh` turns `main` plus one
patch into one orphan branch, `scenario <id>`, with no history and no `scenarios/` folder, for the end-to-end
suite to clone. The generator reads the patches from the committed `main`, so commit a patch before generating.

| Id | Branch | Planted state |
|---|---|---|
| `vanilla` (no patch) | `vanilla` | `main` without `.omc-project/`, `scenarios/` and the generator |
| `fault-e2e-red` | `fault/e2e-red` | `balance()` ignores debits; only e2e `02-balance-sums` fails, lint and unit tests stay green |

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
