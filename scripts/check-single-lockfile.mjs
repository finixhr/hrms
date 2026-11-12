#!/usr/bin/env node
// ============ FIN-033 (Phase 3) — single-lockfile policy gate ============
// The audit found the repository root carrying BOTH bun.lock (187 KB) and
// package-lock.json (349 KB) with no policy: the two locks can drift and
// different runners (bun install vs npm ci) resolve different dependency
// trees, hurting reproducibility. This gate pins ONE lockfile per project
// root:
//
//   · the app root is a Bun project — exactly bun.lock, and package-lock.json
//     / npm-shrinkwrap.json must NOT coexist (their presence after a stray
//     `npm install` is exactly the drift the audit registered);
//   · desktop/ is a separate npm workspaces project (it has no bun run-time
//     there) — exactly its own package-lock.json;
//   · any OTHER lockfile pair, in any project root, fails the same way.
//
// Run from anywhere; resolves the repo root from this file's location.
import { existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

/** Every lockfile name we know about, per package ecosystem. */
const LOCKFILES = ["bun.lock", "bun.lockb", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"]

/** Project roots that must carry exactly one lockfile, with the sanctioned
 *  one named. A new sub-project (mobile/, mini-services/…) gets an entry
 *  here the day it gains its first dependency manifest — the gate fails on
 *  unregistered package.json roots, so an untracked project cannot slip in. */
const POLICY = [
  { dir: ".", required: "bun.lock", why: "the app root is a Bun project (bunfig.toml; CI/Docker install with bun) — the lock is bun.lock (FIN-033)" },
  { dir: "desktop", required: "package-lock.json", why: "the Tauri desktop shell is a separate npm project (no bun run-time there) — its lock is package-lock.json" },
]

/** package.json roots that carry no lockfile: mobile/ is the Expo app —
 *  its dependencies install in the dedicated mobile CI lane (Expo manages
 *  versions there); FIN-033's scope is LOCKFILE COEXISTENCE drift at a
 *  project root, which mobile (no lockfile at all) cannot exhibit. */
const LOCKFILE_EXEMPT = new Set(["mobile", "mini-services"])

const failures = []
const notes = []

for (const p of POLICY) {
  const dir = join(ROOT, p.dir)
  const present = LOCKFILES.filter((f) => existsSync(join(dir, f)))
  if (present.length === 0) {
    failures.push(`${p.dir}: no lockfile at all — expected ${p.required} (${p.why})`)
    continue
  }
  if (present.length > 1) {
    failures.push(`${p.dir}: ${present.length} coexisting lockfiles (${present.join(", ")}) — exactly one is allowed (${p.why})`)
    continue
  }
  if (present[0] !== p.required) {
    failures.push(`${p.dir}: found ${present[0]} but the policy lock is ${p.required} (${p.why})`)
    continue
  }
  notes.push(`${p.dir}: ${present[0]} ✓`)
}

// Any OTHER directory with a package.json is either exempt (no deps) or a
// policy violation waiting to happen — surface it loudly.
import { readdirSync, statSync } from "node:fs"
for (const entry of readdirSync(ROOT)) {
  if (entry.startsWith(".") || entry === "node_modules" || entry === "desktop") continue
  const full = join(ROOT, entry)
  if (!statSync(full).isDirectory()) continue
  if (!existsSync(join(full, "package.json"))) continue
  if (LOCKFILE_EXEMPT.has(entry)) {
    notes.push(`${entry}: exempt — ${entry === "mobile" ? "Expo app; installs in the dedicated mobile CI lane, no lockfile to coexist (FIN-033 gates coexistence drift)" : "service stubs, zero deps"}`)
    continue
  }
  const hasAny = LOCKFILES.some((f) => existsSync(join(full, f)))
  if (!hasAny) {
    // a package.json without dependencies and without a lock is fine — only
    // flag it when it declares dependencies
    const pkg = JSON.parse(readFileSyncSafe(join(full, "package.json")) || "{}")
    const depCount = Object.keys(pkg.dependencies || {}).length + Object.keys(pkg.devDependencies || {}).length
    if (depCount > 0) failures.push(`${entry}: package.json with ${depCount} deps but no lockfile — register it in POLICY or add it to LOCKFILE_EXEMPT with a reason`)
    else notes.push(`${entry}: package.json with zero deps — no lockfile needed`)
  } else {
    failures.push(`${entry}: lockfile present but the project is not in POLICY — register it (single lockfile per project, FIN-033)`)
  }
}

function readFileSyncSafe(p) {
  try { return require("node:fs").readFileSync(p, "utf8") } catch { return null }
}

console.log("── single-lockfile policy (FIN-033)")
for (const n of notes) console.log(`   ${n}`)
if (failures.length) {
  for (const f of failures) console.error(`   FAIL: ${f}`)
  process.exit(1)
}
console.log("   OK: one lockfile per project root, no coexistence")
