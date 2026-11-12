/// <reference types="bun-types" />
// ============ FIN-003 (Phase 0) — PF auto-enroll failures are never silent ============
// The defect: payroll.ts wrapped the auto-enroll createMany in `.catch(() => {})`
// AND still added every employee to the in-memory enrolled set — a failed
// enrollment produced NO PF lines for the whole cycle with zero trace, while
// the settings page said auto-enroll was ON.
//
// The fix (mirrors the remediation register): skipDuplicates absorbs the
// legitimate unique-key race; a REAL failure leaves the enrolled set
// untouched, surfaces a warning on every affected payslip, lists the failure
// in the run summary (calculateRun return), and writes a dedicated audit row.
// The outage is simulated by patching the pfEnrollment delegate in-process.
import "./_testdb"
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, uniq, defaultCompanyId } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { calculateRun } from "@/hrm-server/payroll"

const NAME = uniq("fin003")

let v: any, u: any, c: any, emp: any, runId: string, token: string
let origCreateMany: any

beforeAll(async () => {
  v = await mkVendor(NAME)
  u = await mkUser(v.id, { role: "VENDOR_OWNER", name: NAME + " Owner" })
  c = { ...makeCtxLite(u), vendorId: v.id }
  token = await mkSession(u.id, "FULL")
  emp = await mkEmployee(v.id, { fullName: "FIN-003 AutoEnroll" })
  // a live salary structure so the employee is calculable
  await db.salaryStructure.create({
    data: { vendorId: v.id, employeeId: emp.id, effectiveFrom: "2026-01-01", status: "ACTIVE", basic: 30000, houseRent: 15000, gross: 45000 },
  })
  const run = await db.payrollRun.create({
    data: { companyId: await defaultCompanyId(v.id), vendorId: v.id, periodMonth: 10, periodYear: 2026, periodWeek: 0, frequency: "MONTHLY", runType: "REGULAR", status: "DRAFT", createdBy: u.id },
  })
  runId = run.id
})

// minimal engine ctx (calculateRun only needs these fields for audit + tenant)
function makeCtxLite(user: any) {
  return {
    userId: user.id, userName: user.name, vendorId: user.vendorId,
    permissions: new Set(["*"]), employeeId: null, ip: "127.0.0.1",
  }
}

describe("FIN-003 — PF auto-enroll failure surfacing (Phase 0)", () => {
  test("a failed createMany leaves the enrolled set untouched and surfaces on payslip + summary + audit", async () => {
    // PF ON with auto-enroll ON (defaults are off) — through the real settings route
    const sv = await postHrm("settings.save", { group: "pf", values: { enabled: true, autoEnroll: true, employeePct: 10, employerPct: 10, basis: "BASIC" } }, { bearer: token })
    expect(sv.status).toBe(200)

    // simulate the enrollment outage
    origCreateMany = (db.pfEnrollment as any).createMany
    ;(db.pfEnrollment as any).createMany = async () => { throw new Error("simulated pfEnrollment outage (FIN-003)") }
    try {
      const res = await calculateRun(c, runId)
      // 1. run summary carries the failure list
      expect((res as any).pfEnrollFailures?.length).toBe(1)
      expect((res as any).pfEnrollFailures[0].reason).toContain("simulated pfEnrollment outage")
      // 2. NO enrollment rows were created (enrolled set untouched)
      const enrollments = await db.pfEnrollment.findMany({ where: { vendorId: v.id } })
      expect(enrollments.length).toBe(0)
      // 3. the payslip carries the warning AND computed without PF lines
      const entry = await db.payrollEntry.findFirst({ where: { runId } })
      expect(entry).toBeTruthy()
      const bd = JSON.parse(entry!.breakdownJson || "{}")
      expect(bd.warnings?.some((w: string) => w.includes("PF auto-enrollment FAILED"))).toBe(true)
      expect(bd.pf).toBeUndefined()
      // 4. a dedicated audit row exists
      const auditRow = await db.auditLog.findFirst({ where: { vendorId: v.id, action: "payroll.pf.autoEnrollFailed" } })
      expect(auditRow?.summary).toContain("simulated pfEnrollment outage")
    } finally {
      ;(db.pfEnrollment as any).createMany = origCreateMany
    }
  })

  test("the retry on the next calculation succeeds and PF lines appear (recovery path)", async () => {
    const res = await calculateRun(c, runId)
    expect((res as any).pfEnrollFailures).toBeUndefined()
    const enrollments = await db.pfEnrollment.findMany({ where: { vendorId: v.id } })
    expect(enrollments.length).toBe(1)
    expect(enrollments[0].employeeId).toBe(emp.id)
    const entry = await db.payrollEntry.findFirst({ where: { runId } })
    const bd = JSON.parse(entry!.breakdownJson || "{}")
    expect(bd.pf?.employeePct).toBe(10)
    expect(bd.deductions?.some((d: any) => d.label.includes("Provident Fund"))).toBe(true)
  })
})

afterAll(async () => {
  if (origCreateMany) (db.pfEnrollment as any).createMany = origCreateMany
})
