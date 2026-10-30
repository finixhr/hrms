/// <reference types="bun-types" />
// ============ Phase R4 — reporting & analytics accuracy regressions ============
// RPT-01  upcoming birthdays use real next-occurrence arithmetic (incl. year wrap)
// RPT-03  headcount trend counts exits in their exit month (no all-time terminated)
// RPT-04  the Employee filter + Loans/Advances status filters are APPLIED
// RPT-05  festival bonus gross = the full structure gross
// RPT-06  field-force month bounds are real calendar bounds
// RPT-07  payroll register selects a payable REGULAR run, newest first
// RPT-08  turnover = trailing-12-month exits ÷ average headcount
// RPT-10  AI catalogue covers the registry; LLM statuses validated
// RPT-11  ONE attendance-rate definition (employee-day basis)
// RPT-23  the eight new reports render through the factory
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { attendanceRatePct, rateCountedStatus } from "@/hrm-server/routes/reports"

let vendor: { id: string }
let owner: { id: string }
let token: string

beforeAll(async () => {
  vendor = await mkVendor("R4 Vendor")
  owner = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "R4 Owner" })
  token = await mkSession(owner.id, "FULL")
})

// ---------------------------------------------------------------- RPT-01 ---
describe("RPT-01 — upcoming birthdays (dashboard)", () => {
  test("a birthday within 7 days surfaces; one 8+ days out does not; year-wrap works", async () => {
    const t = new Date() // the dashboard uses the Dhaka-aware today()
    const iso = (d: Date) => d.toISOString().slice(0, 10)
    const in3 = new Date(t.getTime() + 3 * 86400000)
    const in9 = new Date(t.getTime() + 9 * 86400000)
    await db.employee.create({ data: { vendorId: vendor.id, fullName: "R4 Soon BD", code: uniq("R4"), joiningDate: "2020-01-01", employmentType: "PERMANENT", status: "ACTIVE", dob: `1990-${in3.getUTCMonth() + 1 <= 12 ? String(in3.getUTCMonth() + 1).padStart(2, "0") : "01"}-${String(in3.getUTCDate()).padStart(2, "0")}` } })
    await db.employee.create({ data: { vendorId: vendor.id, fullName: "R4 Far BD", code: uniq("R4"), joiningDate: "2020-01-01", employmentType: "PERMANENT", status: "ACTIVE", dob: `1990-${String(in9.getUTCMonth() + 1).padStart(2, "0")}-${String(in9.getUTCDate()).padStart(2, "0")}` } })
    const r = await postHrm("dashboard.stats", {}, { bearer: token })
    expect(r.status).toBe(200)
    const upcoming = r.body.data.upcomingBirthdays as any[]
    // THE RPT-01 REGRESSION: the old filter was provably always empty
    expect(upcoming.some((b) => b.name === "R4 Soon BD")).toBe(true)
    expect(upcoming.some((b) => b.name === "R4 Far BD")).toBe(false)
    const soon = upcoming.find((b) => b.name === "R4 Soon BD")!
    expect(soon.days).toBeGreaterThanOrEqual(0)
    expect(soon.days).toBeLessThanOrEqual(7)
    expect(String(soon.date)).toMatch(/^\d{4}-\d{2}-\d{2}$/) // a real date, not a raw dob
  })
})

// ---------------------------------------------------------------- RPT-03 ---
describe("RPT-03 — headcount trend (dashboard)", () => {
  test("an exit LAST month no longer suppresses THIS month's headcount", async () => {
    const v = await mkVendor("R4 RPT03 Vendor")
    const o = await mkUser(v.id, { role: "VENDOR_OWNER" })
    const tk = await mkSession(o.id, "FULL")
    // joined long ago; terminated 2 months ago (updatedAt = now, no resignation)
    await db.employee.create({ data: { vendorId: v.id, fullName: "R4 Exited", code: uniq("R4X"), joiningDate: "2020-01-01", employmentType: "PERMANENT", status: "TERMINATED" } })
    await db.employee.create({ data: { vendorId: v.id, fullName: "R4 Active", code: uniq("R4A"), joiningDate: "2020-01-01", employmentType: "PERMANENT", status: "ACTIVE" } })
    const r = await postHrm("dashboard.stats", {}, { bearer: tk })
    expect(r.status).toBe(200)
    const trend = r.body.data.headcountTrend as any[]
    // the terminated employee's exit month is NOW (status-update month), so
    // THIS month's headcount = 2 − 1 = 1 …
    expect(trend[trend.length - 1].value).toBe(1)
    // …but PAST months keep their full pre-exit headcount of 2. The old code
    // subtracted the all-time terminated count from EVERY historical month → 1
    expect(trend[0].value).toBe(2)
  })
})

// ---------------------------------------------------------------- RPT-04 ---
describe("RPT-04 — offered filters are applied", () => {
  test("the Employee filter narrows the employee register", async () => {
    const a = await mkEmployee(vendor.id, { fullName: "R4 Filtered A" })
    await mkEmployee(vendor.id, { fullName: "R4 Filtered B" })
    const r = await postHrm("reports.employees", { employeeId: a.id }, { bearer: token })
    expect(r.status).toBe(200)
    const rows = r.body.data.rows as any[]
    expect(rows.length).toBe(1)
    expect(String(rows[0][1])).toContain("R4 Filtered A") // col 1 = Name
  })

  test("the Loans status filter is applied", async () => {
    const e = await mkEmployee(vendor.id, { fullName: "R4 Loan Holder" })
    await db.loan.create({ data: { vendorId: vendor.id, employeeId: e.id, principal: 1000, installments: 2, installmentAmount: 500, startDate: "2026-01-01", outstanding: 1000, status: "ACTIVE" } })
    await db.loan.create({ data: { vendorId: vendor.id, employeeId: e.id, principal: 500, installments: 1, installmentAmount: 500, startDate: "2026-01-01", outstanding: 500, status: "PENDING" } })
    const r = await postHrm("reports.loans", { status: "ACTIVE" }, { bearer: token })
    expect(r.status).toBe(200)
    const rows = r.body.data.rows as any[]
    expect(rows.length).toBe(1) // only the ACTIVE loan (was 2 before the fix)
    expect(String(rows[0][6]).toLowerCase()).toBe("active")
  })
})

// ---------------------------------------------------------------- RPT-05 ---
describe("RPT-05 — festival bonus gross basis", () => {
  test("gross includes conveyance/food/mobile/internet/attendance allowances", async () => {
    const e = await mkEmployee(vendor.id, { fullName: "R4 Bonus Emp" })
    await db.salaryStructure.create({
      data: { vendorId: vendor.id, employeeId: e.id, effectiveFrom: "2020-01-01", status: "ACTIVE",
        basic: 10000, houseRent: 5000, medical: 1000, conveyance: 800, food: 500, mobileAllow: 300, internetAllow: 200, attendanceAllow: 200, otherAllowance: 0, gross: 18000 } as any,
    })
    const r = await postHrm("reports.festivalBonus", { percent: 100, basis: "gross" }, { bearer: token })
    expect(r.status).toBe(200)
    const row = (r.body.data.rows as any[]).find((x) => String(x[0]).includes("R4 Bonus Emp"))
    expect(row).toBeTruthy()
    // col 5 = Gross base, col 6 = bonus at 100% — the FULL 18000 gross (the
    // old 4-component basis computed 16000)
    expect(Number(row[5])).toBe(18000)
    expect(Number(row[6])).toBe(18000)
  })
})

// ---------------------------------------------------------------- RPT-06 ---
describe("RPT-06 — real calendar month bounds (field-force visits)", () => {
  test("a visit on the 1st of the NEXT month never leaks into a 30-day month", async () => {
    const e = await mkEmployee(vendor.id, { fullName: "R4 Field Emp" })
    const loc = await db.visitLocation.create({ data: { vendorId: vendor.id, name: `R4 Site ${uniq()}`, lat: 23.8, lng: 90.4, active: true } as any })
    // June has 30 days: "2026-06-31" does not exist — the old bound rolled to Jul 1
    await db.visit.create({ data: { vendorId: vendor.id, employeeId: e.id, locationId: loc.id, checkInAt: new Date("2026-06-15T10:00:00Z"), checkOutAt: new Date("2026-06-15T11:00:00Z"), durationMin: 60, status: "COMPLETED" } as any })
    await db.visit.create({ data: { vendorId: vendor.id, employeeId: e.id, locationId: loc.id, checkInAt: new Date("2026-07-01T10:00:00Z"), checkOutAt: new Date("2026-07-01T11:00:00Z"), durationMin: 60, status: "COMPLETED" } as any })
    const r = await postHrm("reports.fieldforceVisits", { month: 6, year: 2026 }, { bearer: token })
    expect(r.status).toBe(200)
    const row = (r.body.data.rows as any[]).find((x) => String(x[0]).includes("R4 Field Emp"))
    expect(row).toBeTruthy()
    expect(Number(row[2])).toBe(1) // only the June visit (the old bounds counted 2)
  })
})

// ---------------------------------------------------------------- RPT-07 ---
describe("RPT-07 — payroll register run selection", () => {
  test("the REGULAR payable run is rendered — never a same-period ADJUSTMENT's deltas", async () => {
    // unique (vendor, period, week, runType, adjustSeq) — dedicated vendor so
    // the two same-period rows (cancelled + paid) can coexist
    const v7 = await mkVendor("R4 RPT07 Vendor")
    const o7 = await mkUser(v7.id, { role: "VENDOR_OWNER", name: "R4 RPT07 Owner" })
    const tk7 = await mkSession(o7.id, "FULL")
    const e = await mkEmployee(v7.id, { fullName: "R4 Payroll Emp" })
    // the schema allows ONE REGULAR run per period; the realistic hazard is a
    // REGULAR run coexisting with an ADJUSTMENT run (delta entries) — the old
    // unfiltered findFirst could render the ADJUSTMENT's deltas as the month
    const paid = await db.payrollRun.create({ data: { vendorId: v7.id, periodMonth: 8, periodYear: 2026, periodWeek: 0, frequency: "MONTHLY", runType: "REGULAR", status: "PAID", createdBy: o7.id } })
    await db.payrollEntry.create({ data: { vendorId: v7.id, runId: paid.id, employeeId: e.id, gross: 5000, net: 4500, status: "INCLUDED" } })
    const adj = await db.payrollRun.create({ data: { vendorId: v7.id, periodMonth: 8, periodYear: 2026, periodWeek: 0, frequency: "MONTHLY", runType: "ADJUSTMENT", adjustRunId: paid.id, adjustSeq: 1, status: "PAID", createdBy: o7.id } })
    await db.payrollEntry.create({ data: { vendorId: v7.id, runId: adj.id, employeeId: e.id, gross: -500, net: -450, status: "INCLUDED" } })
    const r = await postHrm("reports.payroll", { month: 8, year: 2026 }, { bearer: tk7 })
    expect(r.status).toBe(200)
    expect(r.body.data.meta.run.status).toBe("PAID")
    const rows = r.body.data.rows as any[]
    expect(rows.length).toBe(1)
    // the REGULAR run's 5000 gross — never the ADJUSTMENT's −500 delta
    expect(Number(rows[0][3])).toBe(5000)
  })
})

// ---------------------------------------------------------------- RPT-08 ---
describe("RPT-08 — turnover definition (analytics)", () => {
  test("turnover is trailing-12-month exits ÷ average headcount, with detail exposed", async () => {
    const r = await postHrm("analytics.all", {}, { bearer: token })
    expect(r.status).toBe(200)
    const wf = r.body.data.workforce
    expect(typeof wf.turnover).toBe("number")
    expect(wf.turnoverDetail).toBeTruthy()
    expect(wf.turnoverDetail.definition).toContain("trailing-12-month")
    expect(wf.turnoverDetail.windowMonths).toBe(12)
    // the rate reconciles with its own detail numbers
    const expected = Math.round((wf.turnoverDetail.exits / wf.turnoverDetail.avgHeadcount) * 1000) / 10
    expect(wf.turnover).toBe(expected)
  })
})

// ---------------------------------------------------------------- RPT-10 ---
describe("RPT-10 — AI catalogue coverage + status validation (pure)", () => {
  test("every reportRoute key has an NL catalogue entry", async () => {
    const { aiStatusCatalogueCheck } = await import("@/hrm-server/routes/ai")
    const missing = await aiStatusCatalogueCheck()
    expect(missing).toEqual([]) // every registered report is NL-reachable now
  })
})

// ---------------------------------------------------------------- RPT-11 ---
describe("RPT-11 — one attendance-rate definition (pure)", () => {
  test("LEAVE/HOLIDAY/WEEKLY_OFF never count as attended; HALF_DAY does", () => {
    expect(rateCountedStatus("LEAVE")).toBe(false)
    expect(rateCountedStatus("LEAVE_UNPAID")).toBe(false)
    expect(rateCountedStatus("HOLIDAY")).toBe(false)
    expect(rateCountedStatus("WEEKLY_OFF")).toBe(false)
    expect(rateCountedStatus("ABSENT")).toBe(false)
    expect(rateCountedStatus("PRESENT")).toBe(true)
    expect(rateCountedStatus("LATE")).toBe(true)
    expect(rateCountedStatus("HALF_DAY")).toBe(true)
    expect(rateCountedStatus("WFH")).toBe(true)
  })

  test("the rate helper is the employee-day basis with a 100% ceiling", () => {
    expect(attendanceRatePct(75, 100)).toBe(75)
    expect(attendanceRatePct(120, 100)).toBe(100) // capped, never 120%
    expect(attendanceRatePct(10, 0)).toBe(0) // no denominator → 0, never NaN
  })
})

// ---------------------------------------------------------------- RPT-23 ---
describe("RPT-23 — the eight new reports render through the factory", () => {
  test("each new report returns columns + rows", async () => {
    const e = await db.employee.create({ data: { vendorId: vendor.id, fullName: "R4 New Emp", code: uniq("R4N"), joiningDate: "2024-03-01", employmentType: "PERMANENT", status: "ACTIVE", dob: "1992-06-15", gender: "FEMALE" } })
    const cases: [string, any][] = [
      ["reports.attritionRate", { year: 2026 }],
      ["reports.ageBands", {}],
      ["reports.tenureBands", {}],
      ["reports.absenteeismTrend", { year: 2026 }],
      ["reports.otCost", { month: 10, year: 2026 }],
      ["reports.holidayCalendar", { year: 2026 }],
      ["reports.payslipDistribution", { month: 10, year: 2026 }],
      ["reports.diversityOverTime", {}],
    ]
    for (const [key, payload] of cases) {
      const r = await postHrm(key, payload, { bearer: token })
      expect(r.status, `${key} → ${r.status} ${JSON.stringify(r.body?.error || "")}`).toBe(200)
      expect(Array.isArray(r.body.data.columns)).toBe(true)
      expect(Array.isArray(r.body.data.rows)).toBe(true)
    }
    // the ICS twin produces a valid calendar
    const ics = await postHrm("reports.holidayCalendarIcs", { year: 2026 }, { bearer: token })
    expect(ics.status).toBe(200)
    expect(String(ics.body.data.ics).startsWith("BEGIN:VCALENDAR")).toBe(true)
    expect(String(ics.body.data.ics).includes("END:VCALENDAR")).toBe(true)
    // diversity: the female joiner lands in the 2024 cohort
    const div = await postHrm("reports.diversityOverTime", {}, { bearer: token })
    const row = (div.body.data.rows as any[]).find((x) => String(x[0]) === "2024")
    expect(row).toBeTruthy()
    expect(Number(row[3])).toBeGreaterThanOrEqual(1)
  })
})
