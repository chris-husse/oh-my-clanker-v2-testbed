# The unit step of omc/bin/verify: every unit test, its spec output to stdout and its TAP log to
# .cache/verify/unit.tap (the gate reads the failing names from it). Extra arguments go to `node --test` before the
# test files (`--test-name-pattern <regex>`).
#
#   sh omc/bin/unit.sh [node --test arguments…]
exec node --disable-warning=ExperimentalWarning --test \
  --test-reporter=spec --test-reporter-destination=stdout \
  --test-reporter=tap --test-reporter-destination=.cache/verify/unit.tap \
  "$@" 'test/unit/*.test.js'
