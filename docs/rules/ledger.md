# Ledger rules

What the ledger guarantees. These pages change only through a decision of the log (`docs/decision-log.md`).

## Entries

- An entry has an account, a non-zero whole number of cents and an optional memo.
- An entry is never changed or deleted once booked; a mistake is corrected by a reversing entry.

## Balances

- The balance of an account is the sum of its entries; an account without entries has balance 0.
- A balance may go negative: `tally add` of a negative amount larger than the balance books it, never refuses it.
