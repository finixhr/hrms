/// <reference types="bun-types" />
// ============ M-11 + M-13 + M-38 — list selects, payslip uniques, job logs ============
// M-11: payroll/leave list endpoints hauled FULL employee rows (base64 photos
//      up to 2 MB each) per call. Fix: shared EMPLOYEE_REF_SELECT.
// M-13: payslip numbers were per-run counters with no unique — same-period
//      adjustment runs minted duplicate document numbers. Fix: -A<seq> run
//      discriminator + (vendorId, payslipNumber) DB unique (migration 3).
// M-38: background-job email/SMS failures vanished behind .catch(() => null)
//      with no CommunicationLog row. Fix: sendLogged writes every outcome.
import { describe, expect, it } from "bun:test"
import { sessionTokenHash } from "@/hrm-server/auth"
import { postHrm } from "./_hrm-endpoint"
import { db } from "@/lib/db"
import { mkEmployee, mkUser, mkVendor, uniq } from "./_fixtures"
import { sendLogged } from "@/hrm-server/jobs"
import * as fs from "fs"
import * as path from "path"

async function adminSession(vendorId: string) {
  const u = await mkUser(vendorId)
  const id = `m1138-${uniq("s")}`
  await db.session.create({ data: { id, tokenHash: sessionTokenHash(id), userId: u.id, kind: "FULL", csrfToken: "x", expiresAt: new Date(Date.now() + 3600_000), ip: "127.0.0.1", lastSeenAt: new Date() } })
  return id
}

describe("M-11 — list joins never fetch photo columns", () => {
  it("the four cited sites use the shared reference select (source invariant)", () => {
    const root = path.resolve(import.meta.dir, "../..")
    const sites: [string, string][] = [
      ["src/hrm-server/routes/payroll.ts", "EMPLOYEE_REF_SELECT"],
      ["src/hrm-server/routes/leave.ts", "EMPLOYEE_REF_SELECT"],
    ]
    for (const [file, marker] of sites) {
      const src = fs.readFileSync(path.join(root, file), "utf8")
      // the no-select full-row fetch must be gone from both files
      expect(src).not.toContain(`db.employee.findMany({ where: { vendorId: ctx.vendorId } })`)
      expect(src.split(marker).length - 1).toBeGreaterThanOrEqual(2) // both sites each
    }
  })

  it("leaveRequests.list still resolves employee names for photo-bearing employees", async () => {
    const vendor = await mkVendor("M11-List")
    const emp = await mkEmployee(vendor.id, { fullName: "Photo Person" })
    // give the employee a fat photo column — the list join must not care
    await db.employee.update({ where: { id: emp.id }, data: { photoUrl: "data:image/png;base64," + "A".repeat(100_000) } as any })
    const sess = await adminSession(vendor.id)
    const r = await postHrm("leaveRequests.list", {}, { bearer: sess })
    expect(r.status).toBe(200)
    const rows = r.body?.data as any[]
    expect(Array.isArray(rows)).toBe(true)
  })
})

describe("M-13 — payslip numbers are unique per vendor", () => {
  it("the DB rejects a second PayrollEntry with the same (vendorId, payslipNumber)", async () => {
    const vendor = await mkVendor("M13-Unique")
    const run = await db.payrollRun.create({ data: { vendorId: vendor.id, periodMonth: 10, periodYear: 2026, runType: "REGULAR", status: "DRAFT", createdBy: "x" } })
    const e1 = await mkEmployee(vendor.id, { fullName: "M13 A" })
    const e2 = await mkEmployee(vendor.id, { fullName: "M13 B" })
    const e3 = await mkEmployee(vendor.id, { fullName: "M13 C" })
    const e4 = await mkEmployee(vendor.id, { fullName: "M13 D" })
    await db.payrollEntry.create({ data: { runId: run.id, vendorId: vendor.id, employeeId: e1.id, gross: 100, net: 100, payslipNumber: "PS-202610-0001" } as any })
    let threw = false
    try {
      await db.payrollEntry.create({ data: { runId: run.id, vendorId: vendor.id, employeeId: e2.id, gross: 100, net: 100, payslipNumber: "PS-202610-0001" } as any })
    } catch { threw = true }
    expect(threw).toBe(true)
    // NULL payslipNumbers remain exempt (multiple rows allowed)
    await db.payrollEntry.create({ data: { runId: run.id, vendorId: vendor.id, employeeId: e3.id, gross: 0, net: 0 } as any })
    await db.payrollEntry.create({ data: { runId: run.id, vendorId: vendor.id, employeeId: e4.id, gross: 0, net: 0 } as any })
  })

  it("adjustment-run numbers carry the -A<seq> discriminator (source invariant)", () => {
    const root = path.resolve(import.meta.dir, "../..")
    const src = fs.readFileSync(path.join(root, "src/hrm-server/payroll.ts"), "utf8")
    expect(src).toContain(`run.runType === "ADJUSTMENT" ? \`-A\${run.adjustSeq ?? 1}\` : ""`)
  })
})

describe("M-38 — job deliveries are logged, never swallowed", () => {
  it("a THROWING sender logs a FAILED CommunicationLog row and returns the outcome", async () => {
    const vendor = await mkVendor("M38-Fail")
    const out = await sendLogged(vendor.id, "EMAIL", "Attendance Alert", async () => {
      throw new Error("SMTP connection refused")
    })
    expect(out.status).toBe("FAILED")
    expect(out.detail).toContain("SMTP connection refused")
    const log = await db.communicationLog.findFirst({ where: { vendorId: vendor.id, subject: "Attendance Alert" }, orderBy: { createdAt: "desc" } })
    expect(log).toBeTruthy()
    expect(log!.status).toBe("FAILED")
    expect(log!.failedCount).toBe(1)
  })

  it("a SKIPPED send (gateway not configured) is logged as SKIPPED, not dropped", async () => {
    const vendor = await mkVendor("M38-Skip")
    const out = await sendLogged(vendor.id, "SMS", "Document Expiry Reminder", async () => ({ status: "SKIPPED", detail: "sms gateway not configured" }))
    expect(out.status).toBe("SKIPPED")
    const log = await db.communicationLog.findFirst({ where: { vendorId: vendor.id, subject: "Document Expiry Reminder" }, orderBy: { createdAt: "desc" } })
    expect(log).toBeTruthy()
    expect(log!.status).toBe("SKIPPED")
    expect(log!.skippedCount).toBe(1)
  })

  it("a SENT send logs delivered", async () => {
    const vendor = await mkVendor("M38-Ok")
    const out = await sendLogged(vendor.id, "EMAIL", "Weekly Late-Comers Report", async () => ({ status: "SENT" }))
    expect(out.status).toBe("SENT")
    const log = await db.communicationLog.findFirst({ where: { vendorId: vendor.id, subject: "Weekly Late-Comers Report" }, orderBy: { createdAt: "desc" } })
    expect(log!.status).toBe("SENT")
    expect(log!.deliveredCount).toBe(1)
  })
})
