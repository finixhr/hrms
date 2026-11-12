#!/usr/bin/env bash
# ============ Container entrypoint (Wave 4 A2, 2026-10-08) ============
# 1. wait for DATABASE_URL host:port to accept TCP connections
# 2. prisma migrate deploy  (additive-only chain — safe on every boot)
# 3. exec the standalone Next server as PID 1
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set (see docker-compose.yml)}"

echo "[entrypoint] waiting for the database…"
timeout=60
elapsed=0
probe() {
  bun -e "
const u = new URL(process.env.DATABASE_URL);
const s = await Bun.connect({ hostname: u.hostname, port: Number(u.port || 5432), socket: { data() {}, close() {}, error() {} } });
s.end(); process.exit(0);
" >/dev/null 2>&1
}
while ! probe; do
  elapsed=$((elapsed + 2))
  if [ "$elapsed" -ge "$timeout" ]; then
    echo "[entrypoint] FAIL: database not reachable after ${timeout}s" >&2
    exit 1
  fi
  sleep 2
done
echo "[entrypoint] database reachable — applying migrations…"

# ---- V12 (R-30, W1) — boot-time artifact assertion, BEFORE any migration ----
# The bundled deploy/release-manifest.json must match the bundled
# prisma/migrations EXACTLY (V6 rule) and the whole manifest contract
# (V1–V6, V8–V10) must hold — a mis-built image refuses to run migrations
# and exits non-zero with the database UNTOUCHED (recovery: redeploy the
# last known-good image; see deployment strategy §5.7 — never
# `prisma migrate resolve` for this failure class).
if [ ! -f ./deploy/release-manifest.json ]; then
  echo "[entrypoint] FAIL V12: /app/deploy/release-manifest.json is missing from the image" >&2
  exit 1
fi
node scripts/check-release-artifact.mjs --image /app || {
  echo "[entrypoint] FAIL V12: the image's migration tree does not match its release manifest — refusing to apply migrations (database untouched)" >&2
  exit 1
}

echo "[entrypoint] V12 artifact assertion passed — applying migrations…"
./node_modules/.bin/prisma migrate deploy

echo "[entrypoint] starting Finix HR on :${PORT:-4000}"
exec bun ./server.js
