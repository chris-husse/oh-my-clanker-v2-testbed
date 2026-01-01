# Report rules

What `tally report` shows. These pages change only through a decision of the log (`docs/decision-log.md`).

## Rows

- The report has one row per account that has entries, with the account's balance.
- Rows are in ascending order of the account name.

## Output

- The plain output is one line per row: the account, a tab, the balance in dollars with two decimals.
- With `--json` the rows are printed as one line of compact JSON.
