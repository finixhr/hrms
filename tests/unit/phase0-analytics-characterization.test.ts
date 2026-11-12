/// <reference types="bun-types" />
// ============ FIN-085 (Phase 0) — analytics characterization baseline ============
// Phase 1 corrected the reporting formulas (FIN-077 attrition average
// headcount + lifecycle-only exits, FIN-078 absenteeism scheduled-day
// denominator, FIN-079 OT effective-dated salary + payroll reconciliation).
// This file was the Phase 0 characterization of the OLD behavior; its golden
// (tests/golden/analytics/phase0-baseline.json) was regenerated DELIBERATELY
// when the Phase 1 formulas landed — the golden's git diff across that commit
// is the review artifact for exactly which reported numbers changed, month by
// month. The anchors below pin the CORRECTED behavior.
//
// The corrected semantics:
//   - attrition: exits ÷ AVERAGE headcount ((start+end)÷2), exit months from
//     resignation/lifecycle LWD only (the updatedAt fallback is GONE), and
//     terminal-status employees with no lifecycle record are EXCLUDED from
//     the population and surfaced in meta.unattributedTerminal;
//   - absenteeism: absent employee-days ÷ SCHEDULED working employee-days
//     (weekly-offs + holidays excluded, employment window clipped), with the
//     per-month population derived from joins and exits;
//   - OT cost: effective-dated basic (the structure in force on each day)
//     + a payroll reconciliation column (Payroll OT, variance) with meta
//     warnings beyond 5%.
//
// Regen (deliberate changes only — review the diff like a payslip golden):
//   HRM_ANALYTICS_REGEN=1 bun test tests/unit/phase0-analytics-characterization.test.ts
import "./_testdb"
import * as fs from "fs"
import * as path from "path"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, uniq, defaultCompanyId } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"

const GOLDEN = path.join(import.meta.dir, "..", "golden", "analytics", "phase0-baseline.json")
const REGEN = process.env.HRM_ANALYTICS_REGEN === "1"
const YEAR = 2026, MONTH = 7

/** Deterministic canon: sorted-key JSON so field order never breaks a golden. */
function canon(v: any): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`
  if (v && typeof v === "object") {
    const keys = Object.keys(v).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`
  }
  return JSON.stringify(v)
}

let v: any, token: string
const names = { steady: "FIN-085 Steady", exiter: "FIN-085 Exiter", joiner: "FIN-085 Joiner", terminated: "FIN-085 Terminated" }

beforeAll(async () => {
  v = await mkVendor(uniq("fin085"))
  const u = await mkUser(v.id, { role: "VENDOR_OWNER", name: "FIN-085 Owner" })
  token = await mkSession(u.id, "FULL")

  // ---- workforce with deterministic lifecycle facts ----
  const steady = await mkEmployee(v.id, { fullName: names.steady })
  await db.employee.update({ where: { id: steady.id }, data: { joiningDate: "2023-01-15", status: "ACTIVE", updatedAt: new Date("2026-01-01T00:00:00Z") } })
  const exiter = await mkEmployee(v.id, { fullName: names.exiter })
  await db.employee.update({ where: { id: exiter.id }, data: { joiningDate: "2023-05-01", status: "RESIGNED", updatedAt: new Date("2026-01-01T00:00:00Z") } })
  // the resignation row supplies the exit month for the exiter
  await db.resignation.create({
    data: { vendorId: v.id, employeeId: exiter.id, status: "ACCEPTED", reason: "FIN-085 fixture", submissionDate: "2026-03-20", resignationDate: "2026-03-21", proposedLwd: "2026-04-08", actualLwd: "2026-04-10" } as any,
  })
  const joiner = await mkEmployee(v.id, { fullName: names.joiner })
  await db.employee.update({ where: { id: joiner.id }, data: { joiningDate: "2026-02-01", status: "ACTIVE", updatedAt: new Date("2026-01-01T00:00:00Z") } })
  // NO resignation row: the terminated employee cannot be attributed to any
  // month — Phase 1 EXCLUDES it from the population and surfaces it in
  // meta.unattributedTerminal instead of inventing a month from updatedAt
  const terminated = await mkEmployee(v.id, { fullName: names.terminated })
  await db.employee.update({ where: { id: terminated.id }, data: { joiningDate: "2024-08-01", status: "TERMINATED", updatedAt: new Date("2026-06-15T00:00:00Z") } })

  // ---- salary for OT pricing (single structure — the effective-dated
  // lookup resolves the same 30000 basic for every July day) ----
  await db.salaryStructure.create({
    data: { vendorId: v.id, employeeId: steady.id, effectiveFrom: "2023-01-15", status: "ACTIVE", basic: 30000, houseRent: 15000, gross: 45000 },
  })

  // ---- attendance: July 2026 (Fridays 3/10/17/24/31 off) ----
  const days: string[] = []
  for (let d = 1; d <= 31; d++) days.push(`2026-07-${String(d).padStart(2, "0")}`)
  const isFriday = (ds: string) => new Date(ds + "T00:00:00Z").getUTCDay() === 5
  // steady: PRESENT every workday except 3 absent days (Mon 6 – Wed 8 July)
  const rows: any[] = []
  for (const d of days) {
    if (isFriday(d)) continue
    const absent = ["2026-07-06", "2026-07-07", "2026-07-08"].includes(d)
    rows.push({ vendorId: v.id, employeeId: steady.id, date: d, status: absent ? "ABSENT" : "PRESENT" })
  }
  // OT minutes across all three day-type tiers: weekday Thu 9 (60m),
  // weekly-off Fri 17 (60m — a punch on the day off, row added explicitly),
  // holiday Thu 16 (90m — holiday declared below)
  const withOt = (row: any, m: number) => ({ ...row, overtimeMinutes: m })
  rows[rows.findIndex((r) => r.date === "2026-07-09")] = withOt(rows.find((r) => r.date === "2026-07-09")!, 60)
  rows[rows.findIndex((r) => r.date === "2026-07-16")] = withOt(rows.find((r) => r.date === "2026-07-16")!, 90)
  rows.push(withOt({ vendorId: v.id, employeeId: steady.id, date: "2026-07-17", status: "PRESENT" }, 60))
  await db.attendance.createMany({ data: rows })
  // joiner: 1 absent day in March (feeds the March absenteeism row)
  await db.attendance.create({ data: { vendorId: v.id, employeeId: joiner.id, date: "2026-03-11", status: "ABSENT" } })
  // tenant-wide holiday on Thu 2026-07-16 → the 90 OT minutes price at the
  // holiday tier AND the day leaves the absenteeism denominator
  await db.holiday.create({ data: { companyId: await defaultCompanyId(v.id), vendorId: v.id, date: "2026-07-16", name: "FIN-085 Holiday", type: "PUBLIC" } })
  // differentiated day-type rates so the characterization exercises the tier
  // branch logic (defaults are all-2× + ROUNDED_UP, which would price every
  // minute identically and hide the branches)
  const sv = await postHrm("settings.save", {
    group: "otRates",
    values: { weekdayRate: 1.5, holidayRate: 2.5, weeklyOffRate: 2, calcBasis: "FIXED", roundToMinutes: 0 },
  }, { bearer: token })
  expect(sv.status).toBe(200)
})

describe("FIN-085 — analytics characterization baseline (Phase 1 corrected formulas)", () => {
  test("attritionRate — exits ÷ average headcount, lifecycle exits only, per month of 2026", async () => {
    const r = await postHrm("reports.attritionRate", { year: YEAR }, { bearer: token })
    expect(r.status).toBe(200)
    // Hand-verified anchors — the CORRECTED behaviour (FIN-077):
    //   population = steady + exiter + joiner (the TERMINATED employee has no
    //   lifecycle record → excluded + surfaced in meta.unattributedTerminal).
    //   APRIL: start 3 (steady+exiter+joiner), end 2 (exiter's LWD 2026-04-10
    //   leaves during the month) → avg 2.5; exits 1 → 1×12÷2.5 = 480%.
    //     (Phase 0 pinned: [4, 0, "0%"] — the resignation exit never
    //     registered in its month and the rate divided by month-end.)
    //   JUNE: the terminated employee no longer manufactures an exit from its
    //     updatedAt timestamp — 2/2/2 with 0 exits. (Phase 0 pinned 600%.)
    const april = r.body.data.rows.find((x: any[]) => x[0] === "April 2026")
    expect(april).toEqual(["April 2026", 3, 2, 2.5, 1, "480%"])
    const may = r.body.data.rows.find((x: any[]) => x[0] === "May 2026")
    expect(may).toEqual(["May 2026", 2, 2, 2, 0, "0%"])
    const june = r.body.data.rows.find((x: any[]) => x[0] === "June 2026")
    expect(june).toEqual(["June 2026", 2, 2, 2, 0, "0%"])
    // the unattributed terminal employee is surfaced, not silently counted
    expect(r.body.data.meta.unattributedTerminal.length).toBe(1)
    expect(r.body.data.meta.unattributedTerminal[0].name).toBe(names.terminated)
    checkGolden("attritionRate", r.body.data)
  })

  test("absenteeismTrend — absent ÷ scheduled working employee-days, per month of 2026", async () => {
    const r = await postHrm("reports.absenteeismTrend", { year: YEAR }, { bearer: token })
    expect(r.status).toBe(200)
    // hand-verified anchors (FIN-078): July population = steady + joiner
    // (exiter left April 10; terminated unattributed). Scheduled days per
    // employee = 31 − 5 Fridays − 1 holiday = 25 → 50 scheduled employee-days;
    // 3 absent → 6.0%. March: the exiter is STILL employed (LWD 2026-04-10),
    // so the population is 3 × 27 = 81 scheduled employee-days; 1 absent →
    // 1.2%. (Phase 0 pinned 4.8% and 1.6% — the denominator was
    // active-headcount × CALENDAR days with a single-snapshot population.)
    const july = r.body.data.rows.find((x: any[]) => x[0] === "July 2026")
    expect(july).toEqual(["July 2026", 3, 50, "6%"])
    const march = r.body.data.rows.find((x: any[]) => x[0] === "March 2026")
    expect(march).toEqual(["March 2026", 1, 81, "1.2%"])
    checkGolden("absenteeismTrend", r.body.data)
  })

  test("otCost — effective-dated basic ÷ 208h with day-type tiers + payroll reconciliation, July 2026", async () => {
    const r = await postHrm("reports.otCost", { month: MONTH, year: YEAR }, { bearer: token })
    expect(r.status).toBe(200)
    // hand-verified anchor with the differentiated fixture rates
    // (weekday 1.5×, weekly-off 2×, holiday 2.5×): basic 30000 → hour rate
    // 144.2307…;  60m×1.5 + 60m×2 + 90m×2.5 = 435 min-equivalents = 7.25h
    // → 7.25 × 144.2307 = 1045.67 → row 1046 (rounded), formatted keeps the paisa
    //   (same estimate as Phase 0 — the single structure predates July, so
    //   effective dating resolves the same basic; the reconciliation columns
    //   and meta are new)
    const row = r.body.data.rows[0]
    expect(row[0]).toBe(names.steady)
    expect(row[1]).toBe(3.5) // 210 minutes → 3.5 hours
    expect(row[2]).toBe(1046)
    expect(row[3]).toBe(0) // no payroll run for July 2026 in this vendor
    expect(row[4]).toBe(1046) // variance vs absent run
    expect(row[5]).toBe("৳1045.67")
    expect(r.body.data.meta.totalCost).toBe(1046)
    expect(r.body.data.meta.payrollOtTotal).toBe(0)
    expect(r.body.data.meta.reconciliation.runs).toBe(0)
    expect(r.body.data.meta.reconciliation.noRun).toContain("no calculated payroll run")
    checkGolden("otCost", r.body.data)
  })
})

/** Pin (or regenerate) the full report body in the phase0 analytics golden. */
function checkGolden(key: string, data: any) {
  let snap: any = {}
  if (fs.existsSync(GOLDEN)) snap = JSON.parse(fs.readFileSync(GOLDEN, "utf8"))
  snap[key] = data
  if (REGEN) {
    fs.mkdirSync(path.dirname(GOLDEN), { recursive: true })
    fs.writeFileSync(GOLDEN, JSON.stringify(snap, null, 1) + "\n")
    console.log(`[FIN-085] regenerated ${path.relative(process.cwd(), GOLDEN)} :: ${key} — REVIEW THE DIFF`)
    return
  }
  if (!fs.existsSync(GOLDEN)) throw new Error(`golden missing: ${GOLDEN} — run with HRM_ANALYTICS_REGEN=1 once`)
  const pinned = JSON.parse(fs.readFileSync(GOLDEN, "utf8"))
  if (!pinned[key]) throw new Error(`golden has no "${key}" entry — run with HRM_ANALYTICS_REGEN=1 once`)
  expect(canon(data)).toBe(canon(pinned[key]))
}
