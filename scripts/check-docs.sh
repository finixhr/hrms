#!/usr/bin/env bash
# ============ M-11 docs guard ============
# Verifies that every file path referenced by the shipped *.md files exists in
# the artifact, and that key documented commands resolve (scripts referenced by
# `bash scripts/…` / `bun run …` must exist). Catches documentation drift — the
# audit found references to non-existent screenshots and wrong DB paths.
set -euo pipefail
cd "$(dirname "$0")/.."

FAIL=0

# ---- 1. file paths referenced in markdown (relative to repo root) ----
# Collects `path/like/this.(png|md|ts|tsx|sh|js|py|toml|sql|db|json|svg|yml)` and
# bare `prisma/db/custom.db`-style references, then checks existence.
while IFS= read -r mdfile; do
  # extract candidate repo-relative paths from backticks and plain text
    # 2026-10-18 (re-audit) — the extraction class now includes () and [] so
  #  Next.js route groups (src/app/owner/(console)/…) and dynamic segments
  #  (tenants/[id]/…) are matched as whole paths instead of their tails.
  paths=$(grep -oE '([A-Za-z0-9_.()\[\]-]+/)+[A-Za-z0-9_.@()\[\]-]+' "$mdfile" | sort -u || true)
  while IFS= read -r p; do
    [[ -z "$p" ]] && continue
    # only check paths with a known extension that don't start with http
    # (system prefixes like opt/ srv/ are EXAMPLE paths for other machines;
    #  .db references are intentional — the database is created at setup (C-02))
    case "$p" in
      http*|node_modules/*|.next/*|opt/*|srv/*|etc/*|var/*|usr/*|home/*|tmp/*|backups/*|storage/*) continue ;;
      *.png|*.md|*.ts|*.tsx|*.sh|*.js|*.py|*.toml|*.sql|*.json|*.svg|*.yml|*.yaml|*.txt|*.lock|*.mjs|*.service|*.timer)
        if [[ ! -e "$p" ]]; then
          echo "  FAIL: $mdfile references missing path: $p"
          FAIL=1
        fi ;;
    esac
  done <<< "$paths"
done < <(find . -maxdepth 3 -name '*.md' ! -path './node_modules/*' ! -path './.next/*' ! -name 'worklog.md' 2>/dev/null)

# ---- 2. scripts referenced via `bash scripts/...` / `bun run scripts/...` ----
while IFS= read -r ref; do
  [[ -z "$ref" ]] && continue
  if [[ ! -e "$ref" ]]; then
    echo "  FAIL: documented script does not exist: $ref"
    FAIL=1
  fi
done < <(find . -maxdepth 3 -name '*.md' ! -path './node_modules/*' ! -path './.next/*' -exec grep -hoE '(bash|bun run) (scripts/[A-Za-z0-9_./-]+\.(sh|ts))' {} + 2>/dev/null | awk '{print $NF}' | sort -u || true)

# ---- 3. known-good invariants from the audit ----
for f in "prisma/schema.prisma" "prisma/db/.gitkeep" "prisma/migrations/migration_lock.toml" \
         "scripts/backup.sh" "scripts/restore-drill.sh" "deploy/Caddyfile" ".env.example"; do
  if [[ ! -e "$f" ]]; then
    echo "  FAIL: required artifact missing: $f"
    FAIL=1
  fi
done

# C-02 (updated 2026-09-30 for the PostgreSQL migration): prisma/db/custom.db is
# no longer the runtime database — it is the READ-ONLY SQLite SOURCE for
# scripts/migrate-sqlite-to-postgres.ts. It may exist in a distribution (the
# migration needs the data) but must never enter git history: verify it is
# ignored. The runtime database is PostgreSQL (DATABASE_URL).
if [[ -e "prisma/db/custom.db" ]]; then
  if git check-ignore -q "prisma/db/custom.db" 2>/dev/null; then
    echo "  OK: prisma/db/custom.db present as migration source and gitignored (C-02)"
  else
    echo "  FAIL: prisma/db/custom.db exists but is NOT gitignored (C-02 — the SQLite migration source must never be committed)"
    FAIL=1
  fi
fi

if [[ $FAIL -ne 0 ]]; then
  echo "FAIL: documentation drift detected (see above)"
  exit 1
fi
echo "  OK: all markdown-referenced paths and scripts exist"
