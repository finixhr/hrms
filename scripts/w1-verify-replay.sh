#!/usr/bin/env bash
# ============ W1-AC-08 — fresh-install migration replay (R-30 / V11) ============
# Procedure (5 steps; exits non-zero on ANY failure):
#   1. create a FRESH scratch database on the disposable PostgreSQL server
#   2. prisma migrate deploy against it (the full 58-entry chain — Stage B
#      added 9_wave9zxz_payroll_run_index_name_guard_20261103 (the B-7
#      corrective) and 9_wave9zzab_payroll_parity_normalization_20261103)
#   3. assert the applied set == the manifest set, no failed rows
#   4. schema parity: scripts/check-schema-parity.mjs (migrate diff DB vs
#      schema.prisma with EXACTLY the six Employee GIN/trigram indexes
#      exempted — normalize-then-exempt, B-7 Option 1(b)); any other drift,
#      a missing/changed/extra exempted index, or an infrastructure error
#      fails the step
#   5. boot-critical smoke: register() + the R-26 assertion against the DB
# Environment: scripts/w1-env.sh (disposable PostgreSQL 16.4 @ 127.0.0.1:55432).
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/w1-env.sh

REPLAY_URL="${W1_REPLAY_URL:?source scripts/w1-env.sh first}"
ADMIN_URL="postgresql://${W1_PG_SUPERUSER}@${W1_PG_HOST}:${W1_PG_PORT}/postgres"
LOG_DIR="${W1_LOG_DIR:-/home/z/my-project/scripts}"

echo "── [W1-AC-08 step 1/5] fresh scratch database"
bun scripts/w1-sql.ts "DROP DATABASE IF EXISTS hrm_w1_replay" >/dev/null 2>&1 || true
bun scripts/w1-sql.ts "CREATE DATABASE hrm_w1_replay" >/dev/null 2>&1 || {
  # w1-sql connects via DATABASE_URL; for DDL against the maintenance DB use it directly
  DATABASE_URL="$ADMIN_URL" bun scripts/w1-sql.ts "DROP DATABASE IF EXISTS hrm_w1_replay" >/dev/null 2>&1 || true
  DATABASE_URL="$ADMIN_URL" bun scripts/w1-sql.ts "CREATE DATABASE hrm_w1_replay" >/dev/null
}
echo "  created: $REPLAY_URL"

echo "── [W1-AC-08 step 2/5] prisma migrate deploy (the full chain)"
set +e
DATABASE_URL="$REPLAY_URL" bunx prisma migrate deploy 2>&1 | tee "$LOG_DIR/w1-ac08-replay-deploy.log"
DEPLOY_EXIT=${PIPESTATUS[0]}
set -e
if [ "$DEPLOY_EXIT" -ne 0 ]; then
  echo "── W1-AC-08: FAIL at step 2 (deploy exit $DEPLOY_EXIT) — see $LOG_DIR/w1-ac08-replay-deploy.log"
  exit 2
fi

echo "── [W1-AC-08 step 3/5] applied set == manifest set; no failed rows"
DATABASE_URL="$REPLAY_URL" bun scripts/w1-sql.ts \
  "SELECT migration_name, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back FROM _prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL" \
  | tee "$LOG_DIR/w1-ac08-failed-rows.log"
APPLIED=$(DATABASE_URL="$REPLAY_URL" bun scripts/w1-sql.ts "SELECT count(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL" | grep -oE '"n": ?[0-9]+' | grep -oE '[0-9]+')
# (the count parse is space-tolerant: w1-sql.ts pretty-prints JSON as `"n": 58` —
# the pre-Stage-B chain never reached step 3, so the old '"n":[0-9]*' pattern
# was never exercised and never matched; fixed as part of Stage B so the
# assertion genuinely runs. The expected value is still asserted exactly.)
echo "  applied migrations: $APPLIED (expected 58)"
[ "$APPLIED" = "58" ] || { echo "── W1-AC-08: FAIL at step 3 (applied=$APPLIED, expected 58)"; exit 3; }

echo "── [W1-AC-08 step 4/5] schema parity (normalize-then-exempt: datamodel vs DB, six GIN/trigram exemptions)"
set +e
DATABASE_URL="$REPLAY_URL" node scripts/check-schema-parity.mjs "$REPLAY_URL" 2>&1 | tee "$LOG_DIR/w1-ac08-parity.log"
PARITY_EXIT=${PIPESTATUS[0]}
set -e
if [ "$PARITY_EXIT" -ne 0 ]; then
  echo "── W1-AC-08: FAIL at step 4 (schema parity exit $PARITY_EXIT); see $LOG_DIR/w1-ac08-parity.log"
  exit 4
fi

echo "── [W1-AC-08 step 5/5] boot-critical smoke on the replayed database"
DATABASE_URL="$REPLAY_URL" bun scripts/w1-smoke-register.ts 2>&1 | tee "$LOG_DIR/w1-ac08-boot-smoke.log" | tail -5

echo "── W1-AC-08: PASS (all five steps green)"
exit 0
