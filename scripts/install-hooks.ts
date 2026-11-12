#!/usr/bin/env bun
// Cross-platform replacement for install-hooks.sh (SEC-1, Phase 1)
// Installs a git pre-commit hook that:
//   1. SEC-1 (P0 audit wave, 2026-11-09) — refuses to commit ANY .env-family
//      file BY NAME (deterministic block).
//   2. Runs scripts/scan-secrets.ts --staged on every commit.
//   3. FORENSIC AUDIT 2026-11-10, FIN-002 (Phase 0) — runs the release
//      manifest validator (scripts/check-release-artifact.mjs --tree .) so
//      a migration merged without its deploy/release-manifest.json entry
//      fails the commit, not CI stage 15/15 and the container entrypoint
//      (V12). The same drift shipped as 9_wave9zzak_…_20261109: declared
//      nowhere, blocked every deploy.
//
//   bun run scripts/install-hooks.ts            # install (idempotent)
//   bun run scripts/install-hooks.ts --optional # same, but a non-git tree only
//                                               # warns instead of failing
//                                               # (used by package.json prepare)

import { spawnSync } from "child_process";
import { writeFileSync, chmodSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const OPTIONAL = process.argv.includes("--optional");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Check if we're inside a git work-tree
const gitCheck = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
  cwd: root,
  encoding: "utf8",
  stdio: "pipe",
});

if (gitCheck.status !== 0) {
  if (OPTIONAL) {
    console.log(
      "install-hooks: not a git repository — pre-commit secret guard NOT installed (extract-only tree)."
    );
    process.exit(0);
  }
  console.error(
    "install-hooks: not a git repository — run inside a clone."
  );
  process.exit(1);
}

// Get hooks directory
const hooksDir = spawnSync("git", ["rev-parse", "--git-path", "hooks"], {
  cwd: root,
  encoding: "utf8",
  stdio: "pipe",
}).stdout.trim();

const hookPath = join(root, hooksDir, "pre-commit");

const hookContent = `#!/usr/bin/env bash
# Installed by scripts/install-hooks.ts (Phase 1, SEC-1) — pre-commit secret guard.
#   1. BLOCKS any .env-family file by name (SEC-1, P0 audit wave 2026-11-09).
#   2. Runs the staged secret scan (known-leaked values, live-looking assignments).
# Manual override for emergencies: git commit --no-verify (never do this for
# real secrets; rotate them instead).
set -euo pipefail

# ---- 1. deterministic .env filename block (SEC-1) --------------------------
# FORENSIC AUDIT 2026-11-10, FIN-001 (Phase 0): the block previously listed
# exact known names (.env, .env.production, …) — a renamed variant such as
# .env.demo or .env.prod-2026 slipped through. The rule is now ANY .env*
# basename EXCEPT .env.example (the documented template).
BLOCKED_ENV=0
while IFS= read -r staged; do
  base="$(basename "$staged")"
  case "$base" in
    .env*)
      if [[ "$base" == ".env.example" ]]; then continue; fi
      echo "pre-commit: REFUSING to commit '$staged' — .env-family files never enter history (SEC-1 / FIN-001)." >&2
      echo "             Only .env.example (placeholders) may be committed; live values live in the (gitignored) .env." >&2
      BLOCKED_ENV=1
      ;;
  esac
done < <(git diff --cached --name-only --diff-filter=ACM 2>/dev/null || true)
if [[ $BLOCKED_ENV -ne 0 ]]; then
  exit 1
fi

# ---- 2. staged secret-value scan --------------------------------------------
bun run scripts/scan-secrets.ts --staged

# ---- 3. release-manifest lockstep (FIN-002, forensic audit 2026-11-10) -----
# The manifest's migration set must equal prisma/migrations exactly at every
# commit. Fast (readdir + JSON parse); fails with the specific V-rule detail
# when a migration directory or manifest entry is staged without its partner.
if [[ -f deploy/release-manifest.json ]]; then
  node scripts/check-release-artifact.mjs --tree . || {
    echo "pre-commit: release manifest and prisma/migrations drifted — add the missing manifest entry (deploy/release-manifest.json) in the SAME commit as the migration (FIN-002)." >&2
    exit 1
  }
fi
`;

writeFileSync(hookPath, hookContent, { encoding: "utf8" });

// chmod +x (no-op on Windows but correct on Unix/WSL)
try {
  chmodSync(hookPath, 0o755);
} catch {
  // Windows — chmod not supported, skip silently
}

console.log(
  `installed: ${hookPath} (blocks .env-family files by name + scan-secrets --staged + release-manifest lockstep on every commit)`
);
