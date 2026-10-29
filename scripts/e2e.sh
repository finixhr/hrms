#!/usr/bin/env bash
# ============ TEST-01 (R7) — the E2E lane (CI stage 14) =====================
# Boots the REAL Next.js app against a scratch database (migrations applied,
# minimal tenant bootstrapped) and runs the HTTP-level journey tests, then
# tears everything down. Exit 0 = all critical journeys green.
#
#   DATABASE_URL=postgresql://... bash scripts/e2e.sh
#
# The scratch database name is fixed (hrm_e2e) — the script creates, reuses
# and finally DROPS it. Never point DATABASE_URL at anything you love.
set -euo pipefail
cd "$(dirname "$0")/.."

E2E_DB="${E2E_DB:-hrm_e2e}"
E2E_PORT="${E2E_PORT:-3111}"
BASE_URL="http://127.0.0.1:${E2E_PORT}"
SRC_DB_URL="${DATABASE_URL:?DATABASE_URL must point at a PostgreSQL server (the scratch DB name is replaced)}"
E2E_DATABASE_URL=$(DATABASE_URL="$SRC_DB_URL" bun run tests/e2e/_db.ts print-url | tail -1)

echo "[e2e] scratch URL: ${E2E_DATABASE_URL}"

SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    sleep 1
    kill -9 "$SERVER_PID" 2>/dev/null || true
  fi
  DATABASE_URL="$SRC_DB_URL" bun run tests/e2e/_db.ts drop > /dev/null 2>&1 || true
}
trap cleanup EXIT

# 1) fresh scratch database + migrations
DATABASE_URL="$SRC_DB_URL" bun run tests/e2e/_db.ts create
DATABASE_URL="$E2E_DATABASE_URL" bunx prisma migrate deploy 2>&1 | tail -2

# 2) bootstrap the minimal tenant
DATABASE_URL="$E2E_DATABASE_URL" bun run tests/e2e/_bootstrap.ts

# 3) boot the app (dev server — compiles on demand; production builds run the
#    same route handlers). Env carries the fail-closed boot requirements
#    (instrumentation.ts refuses to start without a real MFA key).
echo "[e2e] booting next dev on :${E2E_PORT}"
DATABASE_URL="$E2E_DATABASE_URL" \
  HRM_MFA_KEY="${E2E_MFA_KEY:-$(openssl rand -hex 32)}" \
  HRM_INTERNAL_TOKEN="${E2E_INTERNAL_TOKEN:-e2e-internal-token-$(openssl rand -hex 8)}" \
  HRM_BACKUP_KEY="${E2E_BACKUP_KEY:-$(openssl rand -hex 32)}" \
  bunx next dev -p "$E2E_PORT" > /tmp/e2e-server.log 2>&1 &
SERVER_PID=$!

# 4) wait for the health endpoint (dev-server cold compile can take a while)
for i in $(seq 1 90); do
  if curl -sf "${BASE_URL}/api/health" > /dev/null 2>&1; then
    echo "[e2e] server is up (after ${i}s)"
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "[e2e] server died during boot:"; tail -20 /tmp/e2e-server.log; exit 1
  fi
  sleep 1
done
curl -sf "${BASE_URL}/api/health" > /dev/null || { echo "[e2e] server never became healthy"; tail -20 /tmp/e2e-server.log; exit 1; }

# 5) run the journeys
DATABASE_URL="$E2E_DATABASE_URL" E2E_BASE_URL="$BASE_URL" bun test tests/e2e/journeys.test.ts

echo "[e2e] ALL JOURNEYS GREEN"
