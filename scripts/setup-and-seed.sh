#!/bin/bash
# Full setup: install deps → apply migrations → seed → start dev server → verify.
# Run with: bash scripts/setup-and-seed.sh
# C-06 — uses `prisma migrate deploy` (versioned, non-destructive) instead of
# the old `prisma db push --accept-data-loss` workflow.
set -e
cd "$(dirname "$0")/.."

echo "════════════════════════════════════════════════════════════════"
echo "  Finix HR — full setup"
echo "════════════════════════════════════════════════════════════════"

echo
echo "── 1/5 · Installing dependencies ──"
bun install

echo
echo "── 2/5 · Generating Prisma client ──"
bunx prisma generate

echo
echo "── 3/5 · Applying database migrations (PostgreSQL) ──"
# C-06 — versioned migrations only; never db push. The dev database is created
# here if absent (idempotent). To import an existing SQLite database, run:
#   DATABASE_URL="$DATABASE_URL" bun run scripts/migrate-sqlite-to-postgres.ts --fresh
# (see docs/postgresql-migration-report.md).
DEFAULT_DB="postgresql://postgres:postgres@127.0.0.1:5432/hrm_dev"
export DATABASE_URL="${DATABASE_URL:-$DEFAULT_DB}"
DB_NAME="${DATABASE_URL##*/}"; DB_NAME="${DB_NAME%%\?*}"
ADMIN_URL="${DATABASE_URL%/*}/postgres"
if command -v psql >/dev/null 2>&1; then
  psql "$ADMIN_URL" -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 \
    || psql "$ADMIN_URL" -c "CREATE DATABASE \"$DB_NAME\";"
else
  echo "⚠️  psql not found — assuming database '$DB_NAME' already exists (install postgresql-client otherwise)."
fi
bunx prisma migrate deploy

echo
echo "── 4/5 · Seeding database (vendors, branches, employees, users, devices, attendance, payroll, leave, loans, KPIs, letters) ──"
bun run seed 2>&1 | grep -v "^prisma:query" | tail -25
echo "── 4b · Seeding new modules (AIT config, procurement workflows, inventory demo) ──"
bun run scripts/seed-new-modules.ts 2>&1 | tail -25
echo "── 4c · Migrating DB role permission templates (procurement/inventory grants) ──"
bun run scripts/migrate-role-perms.ts 2>&1 | tail -10
echo "── 4d · Seeding any missing approval workflows (all 14 process types) ──"
bun run scripts/seed-approval-workflows.ts 2>&1 | tail -20

echo
echo "── 5/5 · Verifying seeded data ──"
bun run seed:verify 2>&1 | grep -v "^prisma:query\|^2[0-9] |" | tail -40

echo
echo "════════════════════════════════════════════════════════════════"
echo "  ✅ Setup complete"
echo "════════════════════════════════════════════════════════════════"
echo
echo "  Start the dev server:"
echo "    bun run dev            # binds 0.0.0.0:4055"
echo
# M5.1 handover-verification fix: this banner predated the seed rewrite — it
# advertised port 3000 and the old @finixhr.com accounts. The dev server binds
# 0.0.0.0:4055 (package.json "dev"), and the real seeded accounts live at
# @bengaltextworks.example (seed.ts userDefs) + the SaaS owner console.
echo "  Then open http://localhost:4055 and log in with any of:"
echo "    owner@bengaltextworks.example       (Vendor Owner — full access)"
echo "    admin@bengaltextworks.example       (HR Admin)"
echo "    hr@bengaltextworks.example          (HR Manager)"
echo "    payroll@bengaltextworks.example     (Payroll Officer)"
echo "    branch@bengaltextworks.example      (Branch Manager)"
echo "    employee@bengaltextworks.example    (ESS — the phone-testing account)"
echo "    owner@rongintraders.com             (Tenant #2 — isolation demo)"
echo "    owner@finixhr.local / SaasOwner@2026   (SaaS Owner Console — /owner/login)"
echo
echo "  Password for all accounts: Pass@123 (first login forces a password rotation — by design)"
echo
echo "  Smoke-test the ZKTeco Push SDK protocol:"
echo "    bun run test:zkteco"
echo
