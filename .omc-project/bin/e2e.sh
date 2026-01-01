# The e2e step of omc/bin/verify: the scenarios of e2e/scenarios/, a failure held (--keep-alive-on-failure, the
# OMC_HOLD protocol of scripts/e2e.mjs). Extra arguments go to the runner (`--only <id,id>`).
#
#   sh omc/bin/e2e.sh [scripts/e2e.mjs arguments…]
exec node --disable-warning=ExperimentalWarning scripts/e2e.mjs --keep-alive-on-failure "$@"
