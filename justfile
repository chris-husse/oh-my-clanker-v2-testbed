set positional-arguments

# End a held e2e run: `just release [--report-dir <dir>]`; each argument reaches the script as one word.
release *ARGS:
    node scripts/release.mjs "$@"
