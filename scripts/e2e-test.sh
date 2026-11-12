#!/bin/bash
# ============ DEPRECATED legacy curl E2E — now a wrapper (OPS-5, P2 wave) ====
# The historical lane logged in with admin/hr/payroll/branch/employee@finixhr
# com (accounts the current seed no longer creates) against a hardcoded
# localhost:3000 server, so `npm run test:e2e` failed everywhere. The
# maintained lane is scripts/e2e.sh: scratch database + bootstrap tenant +
# journeys + the Playwright UI smoke, with E2E_BUILD=prod for the standalone
# production build. This wrapper keeps the old entry point working.
set -euo pipefail
echo "[e2e-test.sh] deprecated — delegating to scripts/e2e.sh (the maintained lane)"
echo "[e2e-test.sh] set E2E_BUILD=prod for the standalone production build, E2E_UI=0 to skip the browser smoke"
exec bash "$(dirname "$0")/e2e.sh" "$@"
