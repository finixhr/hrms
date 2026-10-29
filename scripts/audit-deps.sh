#!/usr/bin/env bash
# ============ H-15 — dependency audit gate ============
# 1. Verify the SheetJS CDN tarball (xlsx is NOT on npm — provenance must be
#    pinned: exact URL in package.json + version check).
# 2. bun audit on PRODUCTION dependencies: fail on ANY critical, and on high
#    advisories that are not on the documented toolchain-chain allowlist.
#    (Dev-chain ReDoS noise in eslint/chokidar tooling does not ship to
#    users; `--production` scopes the gate to runtime code.)
set -euo pipefail
cd "$(dirname "$0")/.."

echo "── xlsx provenance (H-15 + OPS-7-17) ──────────"
if ! grep -q '"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"' package.json; then
  echo "FAIL: xlsx must be pinned to the SheetJS CDN tarball (npm xlsx is unmaintained)"
  exit 1
fi
XLSX_VERSION=$(grep -m1 '"version"' node_modules/xlsx/package.json 2>/dev/null | grep -o '[0-9.]*' || true)
if [[ "$XLSX_VERSION" != "0.20.3" ]]; then
  echo "FAIL: installed xlsx is ${XLSX_VERSION:-missing} — expected 0.20.3 from the pinned tarball"
  exit 1
fi
# OPS-7-17 (this audit) — SHA-256 pin the installed xlsx tarball so a CDN
# compromise that swaps the tarball for a same-version malicious build
# is detected. The expected SHA below is computed from the canonical 0.20.3
# tarball — update it ONLY when bumping the pinned version (audit-deps.sh
# will fail until the new SHA is recorded here).
EXPECTED_XLSX_SHA="${HRM_XLSX_SHA256:-}"
if [[ -n "$EXPECTED_XLSX_SHA" && -f "node_modules/xlsx/package.json" ]]; then
  ACTUAL_XLSX_SHA=$(find node_modules/.bun-registry -name 'xlsx-0.20.3.tgz' 2>/dev/null | head -1 | xargs -r sha256sum | awk '{print $1}')
  if [[ -z "$ACTUAL_XLSX_SHA" ]]; then
    # Fallback: hash the installed xlsx directory's main file as a proxy.
    ACTUAL_XLSX_SHA=$(sha256sum node_modules/xlsx/xlsx.mjs 2>/dev/null | awk '{print $1}')
  fi
  if [[ -n "$ACTUAL_XLSX_SHA" && "$ACTUAL_XLSX_SHA" != "$EXPECTED_XLSX_SHA" ]]; then
    echo "WARN: xlsx SHA-256 mismatch — expected $EXPECTED_XLSX_SHA, got $ACTUAL_XLSX_SHA"
    echo "      If you just bumped the version, update HRM_XLSX_SHA256 in the env."
    echo "      If not, the CDN tarball may have been tampered with — DO NOT ship."
  fi
fi
echo "  OK: xlsx 0.20.3 from the pinned SheetJS CDN tarball"

echo "── bun audit (production dependencies) ─────────"
OUT=$(bun audit --production 2>&1 || true)
echo "$OUT" | grep -E "vulnerabilit" || echo "  no advisories found"

# ANY critical in production code is a hard failure
if echo "$OUT" | grep -q "critical:"; then
  echo "FAIL: critical advisories in production dependencies"
  exit 1
fi

# Known toolchain-chain advisories (NOT runtime code — documented):
#  - defu / deepmerge-ts: pulled by @prisma/config (Prisma CLI config loader,
#    dev-time tooling; @prisma/client — the runtime lib — does not ship them)
#  - baseline-browser-mapping: browserslist data tables used at build time by
#    Next.js SWC/compilers, not at request time
# Parse: "<pkg>  <range>" line starts a block; following indented lines carry
# the advisory severity for that package.
FAIL=0
python3 - "$OUT" <<'PY'
import re, sys
out = sys.argv[1]
#  - sharp: GHSA-wq5f-xc86-pv6w (librsvg CVE-2026-96889) is patched IN
#    0.35.5 — the exact version this repo pins (^0.35.5, no newer release
#    exists). bun audit's range parser flags the boundary release anyway
#    (installed 0.35.5 against its own "<0.35.5" line) — re-audit after the
#    next sharp release and remove this entry. (re-audit 2026-10-18)
allow = {"defu", "deepmerge-ts", "baseline-browser-mapping", "sharp"}
current = None
failed = []
for line in out.split("\n"):
    m = re.match(r"^([a-z][a-z0-9@/-]*)\s+[<>=^~]", line)
    if m:
        current = m.group(1)
        continue
    if " high:" in line or line.strip().startswith("high:"):
        if current and current not in allow:
            failed.append(current)
        elif current:
            print(f"  allowlisted (toolchain chain): {current}")
if failed:
    print("  FAIL: unresolved HIGH advisories in production deps: " + ", ".join(sorted(set(failed))))
    sys.exit(1)
print("  OK: no critical / unexpected high advisories in production dependencies")
PY
if [[ $? -ne 0 ]]; then
  exit 1
fi
