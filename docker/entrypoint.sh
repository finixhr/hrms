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

./node_modules/.bin/prisma migrate deploy

echo "[entrypoint] starting Finix HR on :${PORT:-4000}"
exec bun ./server.js
