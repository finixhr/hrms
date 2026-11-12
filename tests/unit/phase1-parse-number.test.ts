/// <reference types="bun-types" />
// ============ FIN-083 (Phase 1) — the shared parseNumber contract ============
// Empty/absent/invalid → the caller's default; a legitimate numeric ZERO
// survives; negatives survive (call sites clamp where the domain forbids
// them). This is the antidote to `Number(x) || default` — the shape behind
// the 31-Oct incident (0 months tenure became 6; a 0% festival rate became
// 100). The second half of this file is the LINT COMPANION: it scans the
// money/policy hotspot files for any NEW `Number(x) || <nonzero-default>`
// coercion and fails when one appears — the old pattern cannot quietly
// return. (Pagination/limit clamps where 0 is intentionally rewritten are
// allowlisted below.)
import "./_testdb"
import * as fs from "fs"
import * as path from "path"
import { describe, test, expect } from "bun:test"
import { parseNumber, parseNumberOptional } from "@/hrm-server/utils"

describe("FIN-083 — parseNumber contract", () => {
  test("empty, absent and invalid fall back; zero survives", () => {
    expect(parseNumber("", 6)).toBe(6)
    expect(parseNumber(null, 6)).toBe(6)
    expect(parseNumber(undefined, 6)).toBe(6)
    expect(parseNumber("abc", 6)).toBe(6)
    expect(parseNumber("nonsense123", 6)).toBe(6)
    expect(parseNumber(Number.NaN, 6)).toBe(6)
    // THE incident: a real zero is a real zero
    expect(parseNumber(0, 6)).toBe(0)
    expect(parseNumber("0", 6)).toBe(0)
    expect(parseNumber(0, 100)).toBe(0)
    // ordinary numbers parse
    expect(parseNumber("42", 6)).toBe(42)
    expect(parseNumber(3.5, 0)).toBe(3.5)
    // negatives survive — parsing and validation stay separate concerns
    expect(parseNumber(-5, 6)).toBe(-5)
  })

  test("parseNumberOptional keeps 'not configured' distinguishable from 'configured as 0'", () => {
    expect(parseNumberOptional(null)).toBeNull()
    expect(parseNumberOptional("")).toBeNull()
    expect(parseNumberOptional("x")).toBeNull()
    expect(parseNumberOptional(0)).toBe(0)
    expect(parseNumberOptional("7")).toBe(7)
  })

  test("the hotspots: settings-driven policy fields keep configured zeroes", async () => {
    const { getSettings, saveSettingsGroup } = await import("@/hrm-server/settings")
    const { mkVendor, uniq } = await import("./_fixtures")
    const v = await mkVendor(uniq("p1num"))
    // late policy: threshold 0 = every late day counts; deduct 0 = minimum
    await saveSettingsGroup(v.id, "attendance", { lateDaysThreshold: 0, deductDays: 0 } as any)
    const s = await getSettings(v.id, { noCache: true })
    // the settings STORE keeps the zero (the save path never rewrote it —
    // the rewrites happened at read sites, which now use parseNumber)
    expect((s.attendance as any).lateDaysThreshold).toBe(0)
    expect((s.attendance as any).deductDays).toBe(0)
    // and the reader preserves it too (was: Number(x) || 3 / || 1)
    const { parseNumber: pn } = await import("@/hrm-server/utils")
    expect(pn((s.attendance as any).lateDaysThreshold, 3)).toBe(0)
    expect(pn((s.attendance as any).deductDays, 1)).toBe(0)
  })
})

// ============================================================================
// The lint companion — blocks NEW `Number(x) || <nonzero>` in the hotspots.
// ============================================================================
/** Lines where the || default is an INTENTIONAL clamp (pagination etc.):
 *  0 is deliberately rewritten because the domain starts at 1. */
const ALLOWLIST = [
  /pageSize|Number\(p\?\.page\)|Number\(p\?\.limit\)|Number\(p\?\.staleMinutes\)|p\?\.withinDays|HRM_JOBS_TICK_MS/,
  // loanGuarantorMaxPct: the Math.max(1, …) clamp forbids a 0% guarantor cap
  // by policy — the || 25 only fills ABSENT config, never a configured 0.
  /loanGuarantorMaxPct/,
]

const HOTSPOTS = [
  "src/hrm-server/routes/exit.ts",
  "src/hrm-server/payroll.ts",
  "src/hrm-server/leave-math.ts",
  "src/hrm-server/routes/accounting.ts",
  "src/hrm-server/routes/finance.ts",
  "src/hrm-server/ait-engine.ts",
  "src/hrm-server/routes/reports.ts",
  "src/hrm-server/routes/admin.ts",
  "src/hrm-server/routes/payroll.ts",
  "src/hrm-server/settings.ts",
]

describe("FIN-083 — lint companion: no new zero-rewriting coercions in the hotspots", () => {
  test("every Number(x) || <nonzero> in a hotspot file is allowlisted or converted", () => {
    const offenders: string[] = []
    for (const rel of HOTSPOTS) {
      const file = path.join(import.meta.dir, "..", "..", rel)
      if (!fs.existsSync(file)) continue
      const lines = fs.readFileSync(file, "utf8").split("\n")
      lines.forEach((line, i) => {
        const trimmed = line.trim()
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return // comments
        // Number(...) || <fallback> or parseFloat(...) || <fallback>
        const m = /(Number|parseFloat)\([^)]*\)\s*\|\|\s*([^,;)&\s][^,;)&\s]*)/.exec(line)
        if (!m) return
        const fallbackRaw = m[2].replace(/[}\]`"']/g, "")
        // a numeric zero fallback never rewrites anything (whatever follows it)
        const num = /^-?\d+(\.\d+)?/.exec(fallbackRaw)
        if (num && Number(num[0]) === 0) return
        // intentional clamps (pagination, limits, tick env, guarantor floor)
        if (ALLOWLIST.some((re) => re.test(line))) return
        offenders.push(`${rel}:${i + 1}: ${trimmed.slice(0, 140)}`)
      })
    }
    expect(`Zero-rewriting coercions found (convert to parseNumber or allowlist deliberately):\n${offenders.join("\n")}`).toBe(
      `Zero-rewriting coercions found (convert to parseNumber or allowlist deliberately):\n`,
    )
  })

  test("the shared utility exists and is imported by every converted hotspot", () => {
    const src = fs.readFileSync(path.join(import.meta.dir, "..", "..", "src/hrm-server/utils.ts"), "utf8")
    expect(src).toContain("export function parseNumber(")
    for (const rel of ["src/hrm-server/routes/exit.ts", "src/hrm-server/payroll.ts", "src/hrm-server/ait-engine.ts", "src/hrm-server/routes/payroll.ts"]) {
      const file = fs.readFileSync(path.join(import.meta.dir, "..", "..", rel), "utf8")
      expect(file).toContain("parseNumber")
    }
  })
})
