#!/usr/bin/env bash
# package-zip.sh — build the complete HRM project archive
# Includes: ALL project files (src, scripts, tests, prisma, docs, deploy,
#           .github CI, examples, root configs)
# M-35 — the dev worklog stays in the REPO (process history) but is excluded
# from the shipped deliverable (audit: dev/sandbox artifact).
# Excludes: node_modules, .next, .git, skills, agent-ctx, test-results,
#           (FORENSIC AUDIT 2026-11-10, Phase 1 — Playwright run artifacts:
#           screenshots/traces are sandbox-process output, never deliverable)
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

# ---------- FIN-084 (Phase 0) — refuse to package a DIRTY tree ----------
# The 31 October archive shipped uncommitted work (4 modified + 2 new files):
# the deliverable and the repo disagreed about what the product was. A release
# archive may only be cut from a committed (and tagged) tree.
if command -v git >/dev/null 2>&1 && git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
    echo "ERROR: working tree is dirty — commit and tag before packaging (FIN-084)." >&2
    echo "       Uncommitted/changed files (first 10):" >&2
    git -C "$ROOT" status --short | head -10 >&2
    exit 1
  fi
else
  echo "ERROR: not a usable git repository — the release gate requires a committed tree (FIN-084)." >&2
  exit 1
fi

# ---------- FIN-038 (Phase 0) — secret-scan release gate ----------
# The 2026-11-01 reviewed archive shipped a live .env AND the full .git
# history: it was NOT built through this script. The gate below + the C-02
# leak guard above make this lane the only sanctioned packaging path; CI stage
# 5 runs the same scanner.
if command -v bun >/dev/null 2>&1; then
  if ! bun run scripts/scan-secrets.ts; then
    echo "ERROR: scripts/scan-secrets.ts reported violations — refusing to package (FIN-038)." >&2
    echo "       Rotate the secrets (bun run scripts/rotate-secrets.ts) and remove them from history." >&2
    exit 1
  fi
else
  echo "ERROR: bun not found on PATH — the release gate REQUIRES scripts/scan-secrets.ts (FIN-038)." >&2
  exit 1
fi

# SEC-1 (P0 audit wave, 2026-11-09) — the exclusion list gains the operator-local
# env files: the rotation audit record (.env.rotation-log — sha256 hashes only)
# and the per-context key overrides (.env.keys.local). The *.log glob never
# matched them (they end in -log, not .log), so they would have ridden in the
# archive despite being gitignored by policy.
zip -r -X "$ZIP" . \
  -x "node_modules/*" \
     "mobile/node_modules/*" \
     "desktop/node_modules/*" \
     ".next/*" \
     "mobile/.expo/*" \
     "mobile/.dart_tool/*" \
     "desktop/src-tauri/target/*" \
     ".git/*" \
     "skills/*" \
     "agent-ctx/*" \
     "tool-results/*" \
     "upload/*" \
     "test-results/*" \
     "dev.log" \
     "*.log" \
     "tsconfig.tsbuildinfo" \
     ".env" \
     ".env.rotation-log" \
     ".env.keys.local" \
     ".env.orig-backup" \
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

# ---------- FORENSIC AUDIT 2026-11-10, FIN-001 (Phase 0) — verify the ARTIFACT ----------
# The 2026-11-09 release archive was cut OUTSIDE this lane and shipped a live
# .env plus backups/hrm-20261109T125823Z.dump.enc (4.06 MB). Tree-level guards
# never see an archive built elsewhere, so the built ZIP is now verified as an
# ARTIFACT: forbidden content by name, secret-value scan inside the extracted
# tree, and release-manifest lockstep. scripts/verify-release-archive.sh is
# also runnable standalone on ANY archive before distribution.
if ! bash scripts/verify-release-archive.sh "$ZIP"; then
  echo "ERROR: the built archive failed its own verification — aborting. Do not distribute." >&2
  rm -f "$ZIP"
  exit 1
fi
echo ""
echo "=== LEAK CHECK (must all be 0) ==="
LEAK_FAIL=0
# FIN-038 follow-up — nested dependency/build dirs are caught GENERically
# (the 2026-11-01 build leaked mobile/node_modules: the exclusion list only
# covered the root node_modules, and 48k files rode into the archive until
# this check refused it — exactly what it is for).
for pattern in "^\.env$" "\.env\.rotation-log$" "\.env\.keys\.local$" "\.db$" "\.dump" "^backups/" "node_modules/" "^\.git/" "^\.next/" "^upload/" "^skills/" "^tool-results/" "src-tauri/target/"; do
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
# NOTE (2026-11-01, found while cutting the Phase 0 archive): this check used
# `grep -qx` — under `set -o pipefail` the early-exiting -q kills the upstream
# unzip/awk with SIGPIPE (exit 141) and INVERTS the result: present files were
# reported MISSING. Full-stream grep (no -q) is pipefail-safe.
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
  if unzip -l "$ZIP" | awk '{print $4}' | grep -x "$f" >/dev/null; then echo "  YES  $f"; else echo "  NO   $f  <-- MISSING!"; fi
done
