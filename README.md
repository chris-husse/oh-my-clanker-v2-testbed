# tally

A tiny dependency-free ledger: a SQLite-backed library, an HTTP server and a CLI.

`node:sqlite` prints an ExperimentalWarning, so run the CLI and the server with
`--disable-warning=ExperimentalWarning` (the `bin/tally` shebang already does).

    bin/tally add <account> <amount> [--memo m]
    bin/tally balance <account>
    bin/tally report [--json]

The database path comes from `TALLY_DB` (default `data/tally.db`).
