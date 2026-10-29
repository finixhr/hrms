#!/usr/bin/env bash
# db-push.sh — C-06 guarded wrapper around `prisma db push`.
# db push bypasses the migration history and can silently destroy production
# data (--accept-data-loss). It is now REFUSED in production-ish environments;
# use `bunx prisma migrate deploy` (see UPGRADE_GUIDE.md) instead.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "${NODE_ENV:-}" == "production" ]]; then
  echo "ERROR: prisma db push is disabled in production (NODE_ENV=production)." >&2
  echo "       Use: bunx prisma migrate deploy" >&2
  exit 1
fi

DB_URL="${DATABASE_URL:-}"
if [[ -z "$DB_URL" ]]; then
  echo "ERROR: DATABASE_URL is not set — refusing to guess a database target." >&2
  echo "       Set DATABASE_URL (or copy .env.example to .env) and try again." >&2
  exit 1
fi

# Refuse non-test paths unless explicitly overridden with HRM_DB_PUSH_CONFIRM.
if [[ "$DB_URL" != *"test"* && "${HRM_DB_PUSH_CONFIRM:-}" != "I-KNOW-DB-PUSH-DESTROYS-DATA" ]]; then
  echo "ERROR: DATABASE_URL does not look like a test database:" >&2
  echo "       $DB_URL" >&2
  echo "       prisma db push can silently drop columns/tables (--accept-data-loss)." >&2
  echo "       For production upgrades use: bunx prisma migrate deploy" >&2
  echo "       To override for a scratch/dev DB you accept to lose:" >&2
  echo "       HRM_DB_PUSH_CONFIRM=I-KNOW-DB-PUSH-DESTROYS-DATA bun run db:push" >&2
  exit 1
fi

exec bunx prisma db push --accept-data-loss
