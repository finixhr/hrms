#!/usr/bin/env node
// ============ FIN-031 (Phase 3) — TODO/FIXME/HACK governance gate ============
// The audit registered 94 TODO/FIXME/HACK hits in src/ with no marker-cleanup
// SLA and no issue-tracker linkage. Most are numbered audit annotations
// (TODO(H-3) …) which are traceable; the residual risk is the UN-REFERENCED
// marker that rots with the code. Policy enforced here:
//
//   1. a marker is TODO/FIXME/HACK in COMMENT CONTEXT only — text after `//`
//      on the line, or a `*`-prefixed block-comment line. String literals
//      ("TODO" task-status enums, UI object keys) and prose mentions ("see
//      TODO below") are not markers;
//   2. within comment context, a marker followed by `:` (a task statement)
//      or `(` (a referenced statement) MUST carry a reference:
//      TODO(H-3): … / TODO(FIN-020): … / TODO(crypto-unification): … —
//      the reference is an audit ID, a wave ID or a named workstream;
//   3. markers without `:` or `(` right after (prose: "NOT a TODO",
//      "emits a // TODO comment") pass — they state facts, not tasks.
//
// Scope: src/**/*.{ts,tsx} excluding *.test.* (tests may carry scratch notes).
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
function dirname(p) { return p.slice(0, p.lastIndexOf("/")) }

const MARKER = /\b(TODO|FIXME|HACK)\b\s*(\(|:)?\s*(\(([^()]{3,})\))?/
const failures = []
let markers = 0
let referenced = 0

walk(join(ROOT, "src"))
function walk(dir) {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e)
    if (statSync(full).isDirectory()) { walk(full); continue }
    if (!/\.(ts|tsx)$/.test(e) || /\.test\.[jt]sx?$/.test(e)) continue
    const lines = readFileSync(full, "utf8").split("\n")
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]
      // comment context: after // on the line, or a block-comment * line
      let text = null
      const idx = raw.indexOf("//")
      if (idx >= 0) text = raw.slice(idx + 2)
      else if (/^\s*\*/.test(raw)) text = raw.replace(/^\s*\*/, "")
      if (text == null) continue
      const m = MARKER.exec(text)
      if (!m) continue
      // prose pass (rule 3): no `:` or `(` immediately after the keyword
      const after = text.slice(m.index + m[0].length)
      const keyword = m[1]
      const tail = text.slice(m.index)
      const immediate = new RegExp(`\\b${keyword}\\b\\s*(\\(|:)`).test(tail)
      if (!immediate) continue // prose mention, not a task marker
      markers++
      // referenced = a parenthetical of >=3 non-paren chars right after the
      // keyword: TODO(H-3) / TODO(H-20 paydown): … / TODO(crypto-unification): …
      const hasRef = new RegExp(`\\b${keyword}\\b\\s*\\(([^()]{3,})\\)`).test(tail)
      if (hasRef) { referenced++; continue }
      failures.push(`${relative(ROOT, full)}:${i + 1}: un-referenced marker — ${raw.trim().slice(0, 90)}`)
    }
  }
}

console.log("── TODO/FIXME/HACK governance (FIN-031)")
console.log(`   comment-context task markers: ${markers} (referenced: ${referenced})`)
if (failures.length) {
  for (const f of failures) console.error(`   FAIL: ${f}`)
  console.error("   every task marker must carry a reference: TODO(H-3): … / TODO(FIN-020): … / TODO(<workstream>): …")
  process.exit(1)
}
console.log("   OK: every task marker is referenced (audit ID, wave ID or named workstream)")
