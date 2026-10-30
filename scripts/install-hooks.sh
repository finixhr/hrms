#!/usr/bin/env bash
# ============ SEC-1 (Phase 1) — install the pre-commit secret scan ============
# Installs a git pre-commit hook that runs scripts/scan-secrets.ts --staged
# (the staged-index variant of the CI stage-5 scanner). The hook is a pure
# guard: it never modifies files, it only blocks a commit whose staged content
# carries known-leaked values or live-looking secrets.
#
#   bash scripts/install-hooks.sh          # install (idempotent)
#   git rev-parse --git-path hooks         # verify: pre-commit exists
set -euo pipefail
cd "$(dirname "$0")/.."

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "install-hooks: not a git repository — run inside a clone." >&2
  exit 1
fi

HOOK="$(git rev-parse --git-path hooks)/pre-commit"
cat > "$HOOK" <<'EOF'
#!/usr/bin/env bash
# Installed by scripts/install-hooks.sh (Phase 1, SEC-1) — pre-commit secret scan.
# Manual override for emergencies: git commit --no-verify (never do this for
# real secrets; rotate them instead).
set -euo pipefail
bun run scripts/scan-secrets.ts --staged
EOF
chmod +x "$HOOK"
echo "installed: $HOOK (runs bun run scripts/scan-secrets.ts --staged on every commit)"
