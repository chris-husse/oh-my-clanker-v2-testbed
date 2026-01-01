# check: notes on its reds

- **The steps, in order**: every source file parses (`node --check` over `src/**/*.js`, `bin/tally`, `scripts/*.mjs`,
  `mcp/*.mjs`), then the unit tests (`node --test 'test/unit/*.test.js'`). A file that does not parse stops the gate
  before the tests.
- **`flaky clock`** (`test/unit/clock.test.js`) is a known flaky test: it fails on the first run in a fresh worktree
  (a cold start: `the 20 ms timer overshot by … ms`) and passes on every run after it. Rerun, do not fix: a red of
  `flaky clock` is handled by running the gate again, with no edit of the test or of the code under it. Red on two
  runs in a row, it is a real failure: fix it then.
- **Any other red unit test** is a real failure: fix the code under test, never the test.
