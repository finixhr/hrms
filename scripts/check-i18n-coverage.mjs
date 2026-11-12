#!/usr/bin/env node
// ============ FIN-037 (Phase 3) — i18n key-coverage gate =====================
// The audit: "Mobile/desktop localization completeness relies on manual
// sync; no key-coverage check found" — missing translations render the key
// (English) at runtime. The web app's dictionary (src/hrm/i18n.tsx, BN map:
// English key → Bangla value) was maintained by hand. This gate pins BOTH
// directions of the sync on every commit:
//
//   G1 missing: a key used statically — tr("…") anywhere, or t("…") in a
//        file that binds `const { t } = useI18n()` — with NO BN entry;
//        renders English for bn users at runtime;
//   G2 stale:  a BN entry covered by NEITHER a static call NOR one of the
//        three cited DATA-DRIVEN label sources (src/hrm/nav.ts `label:"…"`
//        values, src/hrm/module-map.ts, src/hrm/shared/ui-kit.tsx status
//        vocabulary) — dictionary rot the next translator still pays for.
//
// Dynamic calls (tr(variable), template literals) are counted and reported,
// not failed — they cannot be statically resolved; the nav tables and status
// badges flow through them, which is exactly why their label sources are
// enumerated above.
// Mobile (Expo) and desktop (Tauri launcher) are English-only surfaces by
// design — reported, not gated (they carry no translation dictionary).
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
function dirname(p) { return p.slice(0, p.lastIndexOf("/")) }

// ---- 1) the BN dictionary (src/hrm/i18n.tsx) ----
const I18N = join(ROOT, "src", "hrm", "i18n.tsx")
const i18nSrc = readFileSync(I18N, "utf8")
const bnStart = i18nSrc.indexOf("BN: Record<string, string> = {")
if (bnStart < 0) { console.error("FAIL: cannot locate the BN dictionary in src/hrm/i18n.tsx"); process.exit(1) }
const bnBody = i18nSrc.slice(bnStart, i18nSrc.indexOf("\n}", bnStart))
const BN = new Map()
for (const m of bnBody.matchAll(/^[ \t]*"((?:[^"\\]|\\.)*)"[ \t]*:/gm)) BN.set(m[1], true)

// ---- 2) static usage ----
const used = new Map() // key -> [file:line]
const dynamic = []
walk(join(ROOT, "src"))
function walk(dir) {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e)
    if (statSync(full).isDirectory()) { walk(full); continue }
    if (!/\.(ts|tsx)$/.test(e) || /\.test\.[jt]sx?$/.test(e)) continue
    if (full === I18N) continue
    const rel = relative(ROOT, full)
    const src = readFileSync(full, "utf8")
    const lines = src.split("\n")
    const bindsT = /const\s*\{\s*t\s*\}\s*=\s*useI18n\(\)/.test(src)
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i]
      // tr("literal") anywhere
      for (const m of ln.matchAll(/\btr\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)/g)) add(m[1], `${rel}:${i + 1} tr()`)
      // t("literal") only in files that destructure useI18n().t
      if (bindsT) {
        for (const m of ln.matchAll(/(?<![.\w$])t\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)/g)) add(m[1], `${rel}:${i + 1} t()`)
      }
    }
  }
}
function add(q, where) {
  if (q.startsWith("`")) { dynamic.push(where + " template literal"); return }
  const key = q.slice(1, -1).replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\`/g, "`")
  used.set(key, (used.get(key) || []).concat(where))
}

// ---- 3) data-driven label sources (cited by the dictionary's own header) ----
const DRIVEN = new Set()
function harvest(path, props) {
  const full = join(ROOT, path)
  let src
  try { src = readFileSync(full, "utf8") } catch { return }
  for (const p of props) {
    const re = new RegExp(p + "\\s*:\\s*[\"']([^\"']*)[\"']", "g")
    for (const m of src.matchAll(re)) DRIVEN.add(m[1])
  }
  // ui-kit status maps: bare object keys like  PENDING: "bg-amber-…"
  if (path.endsWith("ui-kit.tsx")) {
    for (const m of src.matchAll(/^[ \t]{2}([A-Z_]{3,})[ \t]*:/gm)) DRIVEN.add(m[1])
  }
}
harvest("src/hrm/nav.ts", ["label", "title"])
harvest("src/hrm/module-map.ts", ["label", "title", "name"])
harvest("src/hrm/shared/ui-kit.tsx", [])

// ---- 4) verdicts ----
const missing = [...used.keys()].filter((k) => !BN.has(k)).sort()
const stale = [...BN.keys()].filter((k) => !used.has(k) && !DRIVEN.has(k)).sort()

console.log("── i18n key coverage (FIN-037)")
console.log(`   dictionary: ${BN.size} BN entries · static keys: ${used.size} · data-driven label sources: ${DRIVEN.size} · dynamic calls: ${dynamic.length} (reported, not failed)`)
console.log(`   mobile (Expo) + desktop (Tauri launcher): English-only by design — no dictionary to gate`)
for (const d of dynamic.slice(0, 6)) console.log(`   dynamic: ${d}`)
if (missing.length) for (const k of missing) console.error(`   FAIL (missing BN entry): ${JSON.stringify(k)} — used at ${used.get(k).slice(0, 3).join(", ")}`)
if (stale.length) {
  // WARNING, not failure: a stale-looking entry may be dynamic-vocabulary
  // (status words, money labels translated via t(variable) at render time) —
  // removing those would UN-TRANSLATE dynamic statuses. The gate keeps them
  // visible every run so rot is reviewable; only MISSING fails the gate.
  console.warn(`   WARN (not covered statically, review for rot): ${stale.length} entries`)
  for (const k of stale.slice(0, 15)) console.warn(`     · ${JSON.stringify(k)}`)
  if (stale.length > 15) console.warn(`     … and ${stale.length - 15} more (dynamic-vocabulary candidates: status words, money labels)`)
}
if (missing.length) {
  console.error(`   ${missing.length} missing — add the translations (BN) or remove dead entries`)
  process.exit(1)
}
console.log("   OK: every statically-used key has a BN entry")
