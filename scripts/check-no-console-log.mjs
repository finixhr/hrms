#!/usr/bin/env node
// ============ FIN-032 (Phase 3) — no-console.log gate (backend plane) ========
// The structured-logging standard (src/hrm-server/log.ts) is enforced here:
// any console.log in src/hrm-server/**, src/app/api/**, the DEVICE PLANE
// (src/app/iclock/**, src/app/ISAPI/** — the ZKTeco ADMS + Hikvision ISAPI
// device endpoints) or src/instrumentation.ts (boot diagnostics) fails CI.
// console.error / console.warn are likewise refused: the logger has
// .error/.warn levels, and leaving a backdoor channel would rebuild the noise
// the audit registered. Tests are out of scope (failures may print); log.ts
// itself speaks process.stdout/stderr, not console.
// Browser-side code (src/hrm/views/**, src/saas/web/**) is NOT scanned — the
// server logger does not exist in the browser; client catches log to the
// browser devtools console only.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
function dirname(p) { return p.slice(0, p.lastIndexOf("/")) }

const SCAN = ["src/hrm-server", "src/app/api", "src/app/iclock", "src/app/ISAPI"]
const SCAN_FILES = ["src/instrumentation.ts"] // boot path — single file, not a tree
const ALLOW = new Set(["log.ts"]) // the standard's own implementation
const BAD = /\bconsole\.(log|error|warn|info|debug)\s*\(/

const hits = []
for (const base of SCAN) {
  walk(join(ROOT, base))
}
for (const f of SCAN_FILES) {
  scanFile(join(ROOT, f))
}
function walk(dir) {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e)
    if (statSync(full).isDirectory()) { walk(full); continue }
    scanFile(full)
  }
}
function scanFile(full) {
  const e = basename(full)
  if (!/\.(ts|tsx)$/.test(e) || /\.test\.[jt]sx?$/.test(e)) return
  if (ALLOW.has(e)) return
  const src = readFileSync(full, "utf8")
  const lines = src.split("\n")
  for (let i = 0; i < lines.length; i++) {
    if (BAD.test(lines[i])) hits.push(`${relative(ROOT, full)}:${i + 1}: ${lines[i].trim().slice(0, 90)}`)
  }
}
function basename(p) { return p.slice(p.lastIndexOf("/") + 1) }

console.log("── no-console gate (FIN-032): backend uses loggerFor(), never console.*")
if (hits.length) {
  for (const h of hits) console.error(`   FAIL: ${h}`)
  console.error(`   ${hits.length} unstructured print site(s) — import { loggerFor } from "@/hrm-server/log" and use log.info/warn/error (see src/hrm-server/log.ts)`)
  process.exit(1)
}
console.log("   OK: zero console.* in src/hrm-server + src/app/api + src/app/iclock + src/app/ISAPI + src/instrumentation.ts")
