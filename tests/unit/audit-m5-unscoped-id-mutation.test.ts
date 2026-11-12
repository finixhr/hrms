/// <reference types="bun-types" />
// ============ AUDIT M-5 (2026-11-07) — unscoped id-mutation source-scan ratchet ============
// The 2026-11-07 security audit (finding M-5) found ~60 Prisma mutations of
// the form `update/delete({ where: { id: p.id } })` whose TENANT SAFETY
// depends entirely on an earlier hand-written `findFirst({ where: { id,
// vendorId } })` in the same handler — a scoped read that a future edit can
// silently delete or reorder without any test noticing. This file turns that
// systemic pattern into a ratchet: it lexically scans every
// src/hrm-server/routes/*.ts for DIRECT-ID MUTATIONS and pins the per-file
// count to the BASELINE below.
//
// WHAT THE HEURISTIC FLAGS (be precise — false negatives are the risk):
//   1. a Prisma mutation call `.update(` / `.updateMany(` / `.delete(` /
//      `.deleteMany(` whose argument object contains a `where: { … }` key
//      (searched in the 320 chars after the call — `where` is Prisma's first
//      conventional argument; a `where` that only appears after a 300+ char
//      `data:` payload is invisible to the heuristic, an accepted gap);
//   2. the `where` object's FIRST key must be the bare record `id` (the
//      direct-id shape; `where: { vendorId, id }`, compound uniques like
//      `vendorId_employeeId_date` and `where: { userId: … }` are NOT flagged);
//   3. the where object (brace-matched, string-literal-aware) must contain
//      NO tenant-scoping key — `vendorId`, `companyId`, `runId` — and no
//      spread of the repo's scoped-where helpers (`notifScope(`), which
//      inject vendorId + userId at runtime;
//   ⇒ flagged = "this mutation's tenant safety lives in code elsewhere
//      (a preceding scoped read), not in the where-clause itself".
//
// WHAT THE BASELINE MEANS: 348 such mutations exist as of 2026-11-07. A
// sample was re-read during curation and every one followed the audited
// shape — a scoped findFirst/findMany (or an identity-inherent ctx.userId /
// ctx.employeeId value) precedes the direct-id write. E.g.:
//   payroll.ts:86      salaryStructures.update — scoped read at :64 + assertEmployeeVisible
//   leave.ts:917       tx.attendance.delete     — row from a vendor-scoped findMany in the same tx
//   admin.ts:1319      session.deleteMany       — ids from `user: { vendorId }` scoped findMany (:1311)
//   roadmap.ts:801     designation.update       — scoped findFirst at :793
//   attendance.ts:1720 employeeDevice.update    — row matched (id, vendorId, ctx.employeeId) at :1718
//   auth.ts:819/856    user.update              — where id IS ctx.userId (identity-inherent)
// Mutations inside `$transaction` blocks are counted too — they are exactly
// the pattern under watch (see leave.ts:917); the baseline is the guard, not
// a judgment. The count is a SUPERSET of the audit's ~60 (which counted only
// the literal `where: { id: p.id }` payload-id shape); this scan also counts
// `id: rec.id` / `id: existing.id` after scoped reads.
//
// THE RATCHET: current per-file counts must equal the BASELINE exactly.
//   • a NEW unscoped id-mutation → count rises → FAIL until the author scopes
//     the where-clause (preferred: add vendorId/companyId to the mutation, or
//     use a compound unique) or consciously bumps the baseline with a
//     justification comment;
//   • an existing one gets scoped → count drops → also FAILs (stale baseline
//     entry) so the baseline is consciously updated DOWN. Both directions
//     require a human; that is the point.
import { describe, test, expect } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const ROUTES_DIR = join(import.meta.dir, "..", "..", "src", "hrm-server", "routes")
const MUTATION_CALL = /\.(update|updateMany|delete|deleteMany)\s*\(/g
const WHERE_KEY = /\bwhere\s*:\s*\{/
const WINDOW_AFTER_CALL = 320

/** Brace-match the object that starts at `openIdx` (index of "{"),
 * skipping over '…'/"…"/`…` string bodies so braces inside text literals
 * (audit messages, remarks) do not disturb the depth count. Returns the
 * index of the matching "}" or -1 when unbalanced (never happens on files
 * that compile, but a malformed span must skip rather than throw). */
function matchObject(src: string, openIdx: number): number {
  let depth = 0
  let i = openIdx
  while (i < src.length) {
    const c = src[i]
    if (c === "'" || c === '"' || c === "`") {
      const quote = c
      i++
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") i++
        i++
      }
      i++
      continue
    }
    if (c === "{") depth++
    else if (c === "}") {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return -1
}

/** A textual where-object is considered TENANT-SCOPED when it carries one of
 * the tenant keys or spreads a scoped-where helper (notifScope injects
 * vendorId + userId/own-employeeId at runtime — communication.ts). */
const SCOPED_IN_WHERE = /vendorId|companyId|runId|\.\.\.\s*notifScope\(/

interface Hit {
  file: string
  line: number
  call: string
  whereText: string
}

function scan(): Hit[] {
  const hits: Hit[] = []
  for (const file of readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".ts")).sort()) {
    const src = readFileSync(join(ROUTES_DIR, file), "utf8")
    MUTATION_CALL.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = MUTATION_CALL.exec(src))) {
      const after = src.slice(m.index + m[0].length, m.index + m[0].length + WINDOW_AFTER_CALL)
      const w = WHERE_KEY.exec(after)
      if (!w) continue // no inline `where: {` in the window → not the direct-id shape
      const openBrace = m.index + m[0].length + w.index + w[0].length - 1
      const closeBrace = matchObject(src, openBrace)
      if (closeBrace < 0) continue
      const whereText = src.slice(openBrace, closeBrace + 1)
      // first key must be the bare record id (`id: …`, `id,` or shorthand `id }`)
      if (!/^\{\s*id\s*(?::|,|\})/.test(whereText)) continue
      if (SCOPED_IN_WHERE.test(whereText)) continue
      hits.push({
        file,
        line: src.slice(0, m.index).split("\n").length,
        call: m[1],
        whereText: whereText.replace(/\s+/g, " ").slice(0, 90),
      })
    }
  }
  return hits
}

// ----------------------------------------------------------------------------
// BASELINE (2026-11-07, TASK 4-e curation) — per-file counts of unscoped
// id-first mutations in src/hrm-server/routes/*.ts. Line numbers drift, so
// counts are pinned per file instead. TOTAL = 348. Files with zero hits are
// absent on purpose — any hit in a new/renamed file is a baseline violation.
// Every file's hits were spot-checked during curation: all follow the
// audited "scoped read first, direct-id write after" shape (see header).
// ----------------------------------------------------------------------------
const BASELINE: Record<string, number> = {
  "accounting.ts": 11,
  "admin.ts": 10,
  "ait.ts": 4,
  "assets.ts": 4,
  "ats.ts": 10,
  "attendance.ts": 16,
  "auth.ts": 22, // session/MFA rows — where ids are session-scoped or ctx.userId
  "billing.ts": 2,
  "commissions.ts": 11,
  "communication.ts": 1, // notifications.read — the spread ...notifScope(ctx) is exempted
  "companies.ts": 7,
  "company-transfer.ts": 2,
  "devices.ts": 8,
  "employees.ts": 25,
  "ess.ts": 1, // ess.profile.update — requireSelf scoped read at :457
  "exit.ts": 19,
  "fieldforce.ts": 6,
  "finance.ts": 19,
  "integrations.ts": 3,
  "inventory.ts": 18,
  "leave.ts": 27,
  "letters.ts": 9,
  "lifecycle.ts": 10,
  "onboarding.ts": 1,
  "organization.ts": 9,
  "passkeys.ts": 2,
  "payout.ts": 10,
  "payroll.ts": 9,
  "performance.ts": 11,
  "pf.ts": 2,
  "procurement.ts": 29,
  "recruitment.ts": 3,
  "reports.ts": 2,
  "roadmap.ts": 13,
  "support.ts": 5,
  "tracking.ts": 7,
}

const current = scan()
const counts = new Map<string, number>()
for (const h of current) counts.set(h.file, (counts.get(h.file) || 0) + 1)

describe("AUDIT M-5 — unscoped id-mutation scan ratchet", () => {
  test("the scan actually finds the audited pattern (parse sanity)", () => {
    expect(current.length).toBeGreaterThan(200) // 348 on 2026-11-07
    expect(Object.keys(BASELINE).length).toBeGreaterThan(30)
  })

  test("total matches the recorded baseline (conscious drift only)", () => {
    const baselineTotal = Object.values(BASELINE).reduce((s, n) => s + n, 0)
    console.log(`[M-5 id-mutations] current=${current.length} baseline=${baselineTotal}`)
    if (current.length !== baselineTotal) {
      const drifted = [...counts.entries()]
        .filter(([f, n]) => (BASELINE[f] ?? 0) !== n)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([f, n]) => `  - ${f}: now ${n}, baseline ${BASELINE[f] ?? 0}`)
      expect(
        `Unscoped id-mutation count drifted (AUDIT M-5 ratchet): now ${current.length}, baseline ${baselineTotal}.\n` +
        `Scope the new where-clause (add vendorId/companyId, or a compound unique) — preferred —\n` +
        `or update the BASELINE with a justification. Drifted files:\n${drifted.join("\n")}\n`,
      ).toBe("")
    }
    expect(current.length).toBe(baselineTotal)
  })

  test("per-file counts equal the baseline exactly (both directions)", () => {
    const files = new Set([...Object.keys(BASELINE), ...counts.keys()])
    const drift: string[] = []
    for (const f of [...files].sort()) {
      const now = counts.get(f) ?? 0
      const was = BASELINE[f] ?? 0
      if (now !== was) {
        const hits = current.filter((h) => h.file === f).map((h) => `      :${h.line} .${h.call} ${h.whereText}`)
        drift.push(`  - ${f}: now ${now}, baseline ${was}\n${hits.join("\n")}`)
      }
    }
    const msg = drift.length
      ? `Unscoped id-mutation per-file drift (AUDIT M-5 ratchet) — resolve by scoping the where-clause\n` +
        `or consciously updating the BASELINE entry with a justification comment:\n${drift.join("\n")}\n`
      : ""
    expect(msg).toBe("")
  })
})
