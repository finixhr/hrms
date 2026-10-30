#!/usr/bin/env bash
# package-zip.sh — build the complete HRM project archive
# Includes: ALL project files (src, scripts, tests, prisma, docs, deploy,
#           .github CI, examples, root configs)
# M-35 — the dev worklog stays in the REPO (process history) but is excluded
# from the shipped deliverable (audit: dev/sandbox artifact).
# Excludes: node_modules, .next, .git, skills, agent-ctx,
#           tool-results, upload, logs, tsconfig.tsbuildinfo, .env (SECRETS),
#           *.db (C-02 — never ship a database), backups/
#
# C-02 — LEAK GUARD: refuses to package while any .env file or SQLite database
# is present in the tree. Live secrets and live sessions must never ship.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ZIP="${HRM_ZIP_OUT:-$ROOT/download/hrm-complete-implementation.zip}"

cd "$ROOT"
mkdir -p "$(dirname "$ZIP")"
rm -f "$ZIP"

# ---------- C-02 leak guard (fail BEFORE packaging, not after) ----------
if [[ -f "$ROOT/.env" ]]; then
  echo "ERROR: .env is present in the project tree — refusing to package live secrets." >&2
  echo "       Move it out of the tree (only .env.example may ship)." >&2
  exit 1
fi
# hidden .env variants anywhere except node_modules/.next
LEAKED_ENV=$(find "$ROOT" -name ".env" -not -path "*/node_modules/*" -not -path "*/.next/*" 2>/dev/null | head -5 || true)
if [[ -n "$LEAKED_ENV" ]]; then
  echo "ERROR: .env file(s) found — refusing to package live secrets:" >&2
  echo "$LEAKED_ENV" >&2
  exit 1
fi
LEAKED_DB=$(find "$ROOT" -name "*.db" -not -path "*/node_modules/*" -not -path "*/.next/*" 2>/dev/null | head -5 || true)
if [[ -n "$LEAKED_DB" ]]; then
  echo "ERROR: SQLite database file(s) found — refusing to ship live data:" >&2
  echo "$LEAKED_DB" >&2
  echo "       Databases are created by 'bunx prisma migrate deploy && bun run seed'." >&2
  exit 1
fi

zip -r -X "$ZIP" . \
  -x "node_modules/*" \
     ".next/*" \
     ".git/*" \
     "skills/*" \
     "agent-ctx/*" \
     "tool-results/*" \
     "upload/*" \
     "dev.log" \
     "*.log" \
     "tsconfig.tsbuildinfo" \
     ".env" \
     "*.db" \
     "backups/*" \
     "worklog.md" \
     "download/hrm-complete-implementation.zip" \
  > /dev/null

echo "=== ZIP BUILT ==="
ls -la "$ZIP"
echo ""
echo "=== FILE COUNT ==="
unzip -l "$ZIP" | tail -1
echo ""
echo "=== LEAK CHECK (must all be 0) ==="
LEAK_FAIL=0
for pattern in "^\.env$" "\.db$" "node_modules/" "^\.git/" "^\.next/" "^upload/" "^skills/"; do
  n=$(unzip -l "$ZIP" | awk '{print $4}' | grep -c "$pattern" || true)
  echo "  $pattern -> ${n:-0}"
  if [[ "${n:-0}" -gt 0 ]]; then LEAK_FAIL=1; fi
done
if [[ "$LEAK_FAIL" -eq 1 ]]; then
  echo "ERROR: ZIP contains leaked files — aborting. Do not distribute this archive." >&2
  rm -f "$ZIP"
  exit 1  # T2-018: enforce non-zero exit on leak findings
fi
echo ""
echo "=== KEY FILES PRESENT (must all be YES) ==="
for f in ".github/workflows/ci.yml" \
         "prisma/schema.prisma" \
         "prisma/db/.gitkeep" \
         "prisma/migrations/migration_lock.toml" \
         "package.json" \
         "bun.lock" \
         ".env.example" \
         ".gitignore" \
         "worklog.md" \
         "src/hrm-server/seed.ts" \
         "src/hrm-server/routes/registry.ts" \
         "src/hrm/shared/ui-kit.tsx" \
         "tests/unit/session-admin.test.ts" \
         "tests/unit/print-escape.test.ts" \
         "tests/unit/employees-perms.test.ts" \
         "scripts/backup.sh" \
         "scripts/restore-drill.sh" \
         "deploy/Caddyfile" \
         "deploy/backup.service" \
         "deploy/backup.timer"; do
  if unzip -l "$ZIP" | awk '{print $4}' | grep -qx "$f"; then echo "  YES  $f"; else echo "  NO   $f  <-- MISSING!"; fi
done
