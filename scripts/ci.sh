#!/usr/bin/env bash
# ============ Local CI gate (audit M-18 / M-12) ============
# Runs the same stages as .github/workflows/ci.yml — use before every push:
#   1. typecheck   (tsc --noEmit, noImplicitAny ON)
#   2. lint        (eslint)
#   3. unit tests  (bun test tests/unit)  — stderr NOT suppressed (M-12)
#   4. config guard (the sandbox Caddyfile must never leak into deploy/)
#   5. secret scan (SEC-1, Phase 1: known-leaked values + live-looking
#      secrets in tracked files — scripts/scan-secrets.ts)
#   6. scrypt gate (MOD-8/SCL-2, Phase 1: zero scryptSync on request paths
#      outside the three documented definition modules and the seeds)
#   7. destructive-op guard (H-01/H-02: unguarded deleteMany({}) / bare DELETE)
#   8. docs guard (M-11: commands/paths referenced by *.md must exist)
#   9. permission registry lint (M-02: every action gated or annotated)
#  10. dependency audit (H-15: xlsx tarball provenance + production advisories)
#  11. fresh-database migration smoke (audit follow-up 2026-10-03: deploy the
#      full migration chain to a throwaway database — the only stage that
#      actually executes the SQL of migrations the test DB pre-records)
#  12. schema-drift gate (re-audit 2026-10-18: prisma migrate diff the
#      migration chain against schema.prisma — catches "schema edited,
#      migration forgotten" before it reaches any migrate-deploy database)
#  13. perf budget (Phase 4 §11.1: query-count caps per critical action +
#      p95 budgets gated against tests/perf-baseline.json at +15%/+30ms.
#      The NIGHTLY lane additionally runs against the scale fixture:
#        bun run scripts/seed-scale.ts --employees 5000 --vendors 100000
#        HRM_PERF_PROFILE=nightly bun test tests/unit/phase4-perf-budget.test.ts
#      Baseline refresh (deliberate perf changes only):
#        HRM_PERF_BASELINE_UPDATE=1 bun test tests/unit/phase4-perf-budget.test.ts
#  14. E2E lane (TEST-01 R7: HTTP journeys against the REAL app — login, ESS,
#      leave approval, payroll pay — on a scratch database; E2E_SKIP=1 to skip)
set -euo pipefail
cd "$(dirname "$0")/.."

COV_LOG="${COV_LOG:-/tmp/ci-coverage.log}"

echo "── [1/16] typecheck (sharded, FIN-018) ──────────"
# FIN-018 (Phase 2): the sharded lane — three tsc processes (app / server /
# tests) instead of one whole-program check that OOMs below 8GB. The legacy
# single-process check remains as `bun run typecheck:whole` (documented in
# docs/runbooks/type-checking.md).
bash scripts/typecheck.sh

echo "── [2/14] lint ──────────────────────────────────"
bun run lint

echo "── [3/14] unit tests ─────────────────────────────"
# GAP-101/GAP-331 (2026-11-05) — no allowlist: any failing test fails the gate. The
# old list tolerated "exactly two" MFA failures that no longer fail, while the real
# baseline had grown to 258 because the shared fixtures predated the W1 company
# gate. Tests that need more than the suite database take it from the environment:
#   W1_AC07_SCRATCH_URL  a scratch server for w1-ac-07 (.github/workflows/ci.yml sets it)
#   CREATEDB on the test role  for b7-corrective-migrations
bun test tests/unit --coverage --coverage-reporter=text 2>&1 | tee "$COV_LOG"
# OPS-7 (P2 wave, 2026-11-09) — coverage threshold gate: the suite can no
# longer silently decay. scripts/coverage-gate.mjs parses bun's text summary
# (the "_all files" line) and fails below the committed floor.
node scripts/coverage-gate.mjs "$COV_LOG"

echo "── [4/14] config guard ───────────────────────────"
if grep -q "XTransformPort" deploy/Caddyfile 2>/dev/null; then
  echo "FAIL: the sandbox port-forwarding pattern leaked into deploy/Caddyfile"
  exit 1
fi
# M-12 — the git-repo guard must FAIL loudly when the check cannot run, not
# silently pass (e.g. outside a repo / git unavailable).
if ! command -v git >/dev/null 2>&1; then
  echo "FAIL: git is not available — cannot verify tracked files"
  exit 1
fi
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "FAIL: not a git repository — cannot verify tracked files"
  exit 1
fi
if git ls-files 2>/dev/null | grep -qE '\.db$|^\.env$'; then
  echo "FAIL: databases or .env are tracked by git"
  exit 1
fi

echo "── [5/14] secret scan (SEC-1, Phase 1) ─────────"
# Known-leaked values (sha256 blocklist) + secret names assigned live-looking
# values in tracked files. Exit 1 blocks the gate.
bun run scripts/scan-secrets.ts

echo "── [6/14] scrypt request-path gate (MOD-8/SCL-2) ──"
# scryptSync is allowed ONLY in: the three definition modules (each keeps a
# documented sync twin for seeds/tools — the request paths all use the async
# twins), the seed scripts, and tests. Anywhere else in src/ is a violation:
# it means a request path regressed to blocking the event loop.
SCRYPT_BAD=0
while IFS= read -r f; do
  case "$f" in
    src/hrm-server/auth.ts|src/hrm-server/saas/owner-auth.ts|src/hrm-server/zkteco/commkey.ts) continue ;;
    src/hrm-server/seed.ts|src/hrm-server/seed-owner.ts|src/hrm-server/seed-reset.ts) continue ;;
    src/hrm-server/saas/seed-saas.ts) continue ;;
    *) if grep -q "scryptSync" "$f"; then
         echo "  FAIL: $f uses scryptSync — request paths must use the async twins (hashPasswordAsync / hashOwnerPasswordAsync / hashCommKeyAsync / verifyCommKeyAsync / scryptAsync)"
         SCRYPT_BAD=1
       fi ;;
  esac
done < <(find src -type f \( -name '*.ts' -o -name '*.tsx' \) ! -path '*/node_modules/*' 2>/dev/null)
if [[ $SCRYPT_BAD -ne 0 ]]; then
  echo "FAIL: synchronous scrypt on non-request-allowed paths (see above)"
  exit 1
fi
echo "  OK: scryptSync confined to the documented definition modules and seeds"

echo "── [7/14] destructive-op guard (H-01/H-02) ──────"
# Any shipped TS script containing an unscoped deleteMany({}) must either live
# under a guarded module (imports scripts/lib/guard and calls requireConfirmation)
# or be part of the deliberate seed reset (src/hrm-server/seed*.ts).
BAD=0
while IFS= read -r f; do
  if grep -qE 'deleteMany\(\s*\{\s*\}\s*\)' "$f"; then
    # Explicit allowlist: scripts/migrate-sqlite-to-postgres.ts truncates ONLY
    # behind the opt-in --fresh flag AND refuses production-looking
    # DATABASE_URLs without --allow-production (docs/postgresql-cutover.md
    # Step 4). Its own layered guard is stronger and cutover-aware than
    # requireConfirmation (which hard-refuses NODE_ENV=production and would
    # break the approved-cutover flow).
    if [ "$f" = "scripts/migrate-sqlite-to-postgres.ts" ]; then
      continue
    fi
    if ! grep -q 'requireConfirmation' "$f" && ! grep -qE 'reset\(\)|purge|seed' "$f"; then
      echo "  FAIL: $f contains an unguarded deleteMany({})"
      BAD=1
    fi
  fi
done < <(find scripts src -type f \( -name '*.ts' -o -name '*.tsx' \) ! -path '*/node_modules/*' 2>/dev/null)
# Bare SQL DELETE without WHERE inside shipped shell scripts (sqlite3 calls etc.)
while IFS= read -r f; do
  if grep -qE 'DELETE FROM [A-Za-z_"]+(;|\s*$)' "$f" && [[ "$f" != *"e2e-test.sh" && "$f" != *"scripts/ci.sh" ]]; then
    echo "  FAIL: $f contains a bare DELETE FROM without WHERE"
    BAD=1
  fi
done < <(find scripts -type f -name '*.sh' ! -path '*/node_modules/*' 2>/dev/null)
if [[ $BAD -ne 0 ]]; then
  echo "FAIL: unguarded destructive operations found (see above)"
  exit 1
fi
echo "  OK: no unguarded deleteMany({}) / bare DELETE FROM found"

echo "── [8/14] docs guard (M-11) ──────────────────────"
bash scripts/check-docs.sh

echo "── [9/14] permission registry lint (M-02) ────────"
python3 scripts/audit-perms.py

echo "── [10/14] dependency audit (H-15) ───────────────"
bash scripts/audit-deps.sh

echo "── [11/14] fresh-database migration smoke ────────"
# Audit follow-up 2026-10-03: migration 3 shipped referencing a non-existent
# column and failed (P3009) on every fresh database — the unit-test DB had it
# pre-recorded as applied so no gate run ever executed its SQL. This stage
# deploys the FULL migration chain to a throwaway database from zero.
bun run scripts/migrate-fresh-smoke.ts

echo "── [12/14] schema-drift gate ────────────────────"
# Re-audit 2026-10-18 (P1-2 post-mortem): the inventory-serial schema changes
# shipped with NO migration — every `prisma migrate deploy` database (the
# production shape) was missing 11 columns + 3 tables while the unit-test DB
# (provisioned via `db push`) stayed green. prisma migrate diff closes the
# gap: the migration chain must reproduce schema.prisma EXACTLY.
bun run scripts/check-schema-drift.ts

echo "── [12b/14] money-column schema lint (DBD-1) ────"
# P2 wave 2026-11-09: block NEW Float money columns. The paisa BigInt columns
# are the authoritative money representation (H-09 dual-write + nightly
# reconcileFloatPaisa + the 9_wave9zzaj backfill); the remaining 199 Float
# columns are the grandfathered legacy inventory. Non-money Floats need an
# inline `// float-ok: <reason>` opt-out; deliberate allowlist changes go
# through `node scripts/lint-money-columns.mjs --update` + a justified diff.
node scripts/lint-money-columns.mjs

echo "── [13/14] perf budget (Phase 4 §11.1) ───────────"
# Query-count caps + p95 budgets vs the committed baseline (Phase 4 WS-E).
# Runs in the regular unit-test database; the golden payslips ride the regular
# unit stage (3). HRM_PERF_PROFILE=nightly (raised iteration counts) is the
# nightly lane — pair it with scripts/seed-scale.ts per the header above.
bun test tests/unit/phase4-perf-budget.test.ts

echo "── [14/14] E2E lane (TEST-01 R7) ────────────────"
# HTTP journeys + the Playwright login-to-punch UI smoke against the REAL app
# (scratch database, torn down afterwards). OPS-5 (P2 wave): CI boots the
# STANDALONE PRODUCTION BUILD (E2E_BUILD=prod) — the dev server only compiled
# on demand and never exercised production bundling, hydration chunking or
# the standalone server. Skipped when E2E_SKIP=1 (no PostgreSQL tooling).
if [ "${E2E_SKIP:-}" = "1" ]; then
  echo "  SKIPPED (E2E_SKIP=1)"
else
  E2E_BUILD="${E2E_BUILD:-prod}" bash scripts/e2e.sh
fi

echo "✅ CI gate passed"

# R-30 (W1) — stage 15: release-artifact validation (V1–V7).
# The canonical release manifest must match the working tree EXACTLY at
# every commit (V7 lockstep): deploy/release-manifest.json's migration set
# equals the prisma/migrations directory set — strict JSON, exact schema,
# no placeholders, no duplicates, strict lexicographic order,
# cumulative-equality against the approved contract (V8), M4 containment
# (V9). The CI `migrations` job additionally runs the fresh-install replay
# (V11) and the schema-parity gate.
# FIN-027 (Phase 2, 2026-11-10) — model isolation registry gate. The registry
# (deploy/model-isolation-registry.json) is a REVIEWED artifact, not a mirror:
# this stage re-derives every model's isolation strategy from schema.prisma and
# fails on (G1) unregistered models, (G2) stale entries, (G3) declared-vs-
# derived drift, and (G4) any employee-child-materialized model — the FIN-017
# policy: employeeId without the Employee relation routes scopes through
# materialized id IN-lists, forbidden since the Phase 2 remediation.
echo "── [15/16] model-isolation registry (FIN-027) ────"
bun scripts/check-model-isolation.mjs

echo "── [16/16] release-artifact validation (R-30, V1–V7) ──"
node scripts/check-release-artifact.mjs --tree .

# OPS-4 (2026-11-09 P1 wave) — stage 16: nightly k6 money-path gate.
# The k6 suite has existed since Wave 11 §15 but never ran in CI, and the
# money paths (payroll preflight, payroll run/entry reads, leave approvals)
# had no scenario at all — three new journeys ship in loadtest/k6/ (see the
# README table there). The lane is OPT-IN so the default gate keeps running
# on a checkout with no live server:
#   NIGHTLY=1 HRM_K6_BASE_URL=https://hrm-staging.example.com \
#     HRM_K6_EMAIL=hradmin@staging.example.com HRM_K6_PASSWORD='…' \
#     bash scripts/ci.sh
# Optional sizing/env overrides: HRM_K6_VUS, HRM_K6_DURATION, HRM_K6_ORIGIN
# (Origin header when the allowlisted host differs from the BASE_URL host),
# K6_BIN (path to the k6 executable). Pair with the stage-13 nightly perf
# lane (HRM_PERF_PROFILE=nightly + scripts/seed-scale.ts) for the full
# nightly picture.
# Intended schedule (cron — 00:30 Asia/Dhaka: off-peak, and ahead of the
# 01:05 nightly backup so the load never races the pg_dump):
#   30 18 * * *  NIGHTLY=1 HRM_K6_BASE_URL=… bash scripts/ci.sh
# .github/workflows/ci.yml documents the same schedule for Actions-based
# runners (un-comment its `schedule:` block to enable it there).
# When NIGHTLY=1 is set the prerequisites FAIL LOUDLY (never silently skip —
# a skipped gate was the original OPS-4 finding).
echo "── [16] nightly k6 money-path gate (OPS-4) ────"
if [ "${NIGHTLY:-}" != "1" ]; then
  echo "  SKIPPED (not the nightly lane — set NIGHTLY=1 + HRM_K6_BASE_URL, see the stage-16 comment above)"
else
  if [ -z "${HRM_K6_BASE_URL:-}" ]; then
    echo "FAIL: NIGHTLY=1 requires HRM_K6_BASE_URL (the staging deployment root, e.g. https://hrm-staging.example.com)" >&2
    exit 1
  fi
  K6_BIN="${K6_BIN:-k6}"
  if ! command -v "$K6_BIN" >/dev/null 2>&1; then
    echo "FAIL: k6 not found (K6_BIN='${K6_BIN}') — install k6 (loadtest/README.md §Install) or point K6_BIN at the executable" >&2
    exit 1
  fi
  # k6 -e env passthrough — only non-empty values override the scenario
  # defaults (an empty -e would clobber the built-in fallback)
  K6_ARGS=(run -e BASE_URL="$HRM_K6_BASE_URL")
  [ -n "${HRM_K6_EMAIL:-}" ] && K6_ARGS+=(-e TENANT_EMAIL="$HRM_K6_EMAIL")
  [ -n "${HRM_K6_PASSWORD:-}" ] && K6_ARGS+=(-e TENANT_PASSWORD="$HRM_K6_PASSWORD")
  [ -n "${HRM_K6_ORIGIN:-}" ] && K6_ARGS+=(-e ORIGIN="$HRM_K6_ORIGIN")
  [ -n "${HRM_K6_VUS:-}" ] && K6_ARGS+=(-e VUS="$HRM_K6_VUS")
  [ -n "${HRM_K6_DURATION:-}" ] && K6_ARGS+=(-e DURATION="$HRM_K6_DURATION")
  # each scenario carries its own thresholds — a breach fails `k6 run`
  # (non-zero) and this gate with it (set -e)
  # FIN-036 (Phase 3): every nightly run also EXPORTS its summary so the
  # perf-trend lane can record it (tests/perf-trend.json, capped history) —
  # the static k6 thresholds stay the absolute budget; the trend layer
  # alerts on a slow drift (>PERF_TREND_REGRESSION_PCT vs the rolling
  # median) long before the absolute breach.
  K6_SUMMARIES=()
  for SCENARIO in payroll-preflight payroll-run-payment leave-approval; do
    echo "── k6: loadtest/k6/${SCENARIO}.js"
    "$K6_BIN" "${K6_ARGS[@]}" "loadtest/k6/${SCENARIO}.js" --summary-export="/tmp/k6-${SCENARIO}.json"
    K6_SUMMARIES+=("--scenario" "${SCENARIO}" "--file" "/tmp/k6-${SCENARIO}.json")
  done
  echo "  OK: money-path k6 scenarios green"
  echo "── FIN-036: recording + trend gate"
  node scripts/perf-trend.mjs record --label "nightly-$(date -u +%Y-%m-%d)" "${K6_SUMMARIES[@]}"
  node scripts/perf-trend.mjs check
fi

# FIN-033 (Phase 3) — single-lockfile policy. The audit found bun.lock AND
# package-lock.json coexisting at the root with no policy: the two locks can
# drift and different runners resolve different dependency trees. The root
# package-lock.json is deleted (desktop/ keeps its own — separate npm
# project); this gate keeps it deleted and pins ONE lockfile per project
# root, failing loudly on any coexistence or unregistered package.json root.
echo "── [17] single-lockfile policy (FIN-033) ──────"
node scripts/check-single-lockfile.mjs

# FIN-032 (Phase 3) — the structured-logging standard. 106 console.log calls
# (plus 124 console.error/warn) lived in the backend production paths with no
# standard and no lint ban. All migrated to src/hrm-server/log.ts
# (loggerFor(); JSON lines in production, human-pretty in dev/CLI); this gate
# refuses any new console.* in src/hrm-server + src/app/api.
echo "── [18] no-console gate (FIN-032) ────────────"
node scripts/check-no-console-log.mjs

# FIN-031 (Phase 3) — TODO/FIXME/HACK governance. 94 raw hits at audit time
# (most benign numbered audit annotations); the risk was the UN-referenced
# marker rotting with the code. Policy: every comment-context task marker
# carries a reference — an audit ID (TODO(H-20 paydown):), a wave ID, or a
# named workstream (TODO(cam-verification):). String literals ("TODO" task
# statuses) and prose mentions are not markers.
echo "── [19] TODO/FIXME/HACK governance (FIN-031) ─"
node scripts/check-todo-governance.mjs

# FIN-037 (Phase 3) — i18n key coverage. The audit: "localization
# completeness relies on manual sync; no key-coverage check found" — missing
# translations render the key (English) at runtime. The gate fails on any
# statically-used key without a BN entry (20 real gaps found and backfilled
# with the Phase 3 remediation); stale-looking entries are WARNed (they may
# be dynamic-vocabulary: status words, money labels via t(variable)).
echo "── [20] i18n key coverage (FIN-037) ─────────"
node scripts/check-i18n-coverage.mjs

# FIN-035 (Phase 3) — the NIGHTLY e2e lane. The audit: "e2e directories exist
# but CI runs only unit tests and k6 (e2e not in the gate)" — the default
# push gate keeps its E2E_SKIP affordance (dev machines without PostgreSQL
# tooling); the NIGHTLY lane REFUSES to skip: a skipped gate was the original
# OPS-4 finding. It runs the full e2e suite (HTTP journeys + the whole
# Playwright tests/e2e-ui directory, including the FIN-030 desktop two-
# company switch smoke) against the STANDALONE PRODUCTION build.
# Intended schedule (cron — Asia/Dhaka = UTC+6):
#   30 18 * * *  NIGHTLY=1 HRM_K6_BASE_URL=… bash scripts/ci.sh   # 00:30 k6 + gates
#   20 19 * * *  NIGHTLY=1 bash scripts/ci.sh                     # 01:20 nightly e2e
# 01:20 sits after the 01:05 nightly backup so the load never races the
# pg_dump; 00:30 k6 and 01:20 e2e keep the two nightly lanes off each
# other's throat. .github/workflows/ci.yml documents the same schedule.
echo "── [21] nightly e2e lane (FIN-035) ──────────"
if [ "${NIGHTLY:-}" != "1" ]; then
  echo "  SKIPPED (not the nightly lane — set NIGHTLY=1; see the comment above)"
else
  if [ "${E2E_SKIP:-}" = "1" ]; then
    echo "FAIL: the nightly lane refuses E2E_SKIP=1 — a skipped gate was the original OPS-4 finding" >&2
    exit 1
  fi
  E2E_BUILD=prod bash scripts/e2e.sh
fi
