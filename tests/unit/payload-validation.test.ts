/// <reference types="bun-types" />
// ============ M-01 regression: schema-level payload validation ============
// Write actions declare Zod schemas in the registry; the dispatcher validates
// + strips before the handler. bulkImport cells are untrusted; verified is
// not client-writable on bank accounts.
import "./_testdb" // first — sets DATABASE_URL before db.ts is constructed
import { describe, test, expect } from "bun:test"
import { db } from "@/lib/db"
import "@/hrm-server/routes/router" // registers every action (side effect)
import { routes } from "@/hrm-server/routes/registry"
import { S, requireValid } from "@/hrm-server/validation"
import { mkVendor, mkUser, mkEmployee, makeCtx, uniq } from "./_fixtures"

const vendor = await mkVendor("M01 Vendor")
const owner = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "Owner" })
const emp = await mkEmployee(vendor.id, { fullName: "M01 Emp" })
const ctx = makeCtx(owner, ["*"])

describe("M-01 registry schema wiring", () => {
  test("declared schemas exist for the audit's required write actions", () => {
    for (const name of [
      "employees.create", "employees.update", "leaveRequests.apply",
      "loans.create", "advances.create", "payroll.runs.create",
      "payroll.submitApproval", "tasks.save", "employees.bulkImport",
    ]) {
      expect(routes[name], `${name} must exist`).toBeTruthy()
      expect(routes[name]!.schema, `${name} must declare a zod schema`).toBeTruthy()
    }
  })
  test("payroll run creation accepts the period fields used by the form and handler", async () => {
    const def = routes["payroll.runs.create"]!
    const payload = def.schema!.parse({ periodMonth: 12, periodYear: 2099 })
    const run: any = await def.handler(ctx, payload)
    expect(run.periodMonth).toBe(12)
    expect(run.periodYear).toBe(2099)
    await db.payrollRun.delete({ where: { id: run.id } })
  })
  test("payroll submit requires only a run id; decisions belong to approvals.act", () => {
    const schema = routes["payroll.submitApproval"]!.schema!
    expect(schema.safeParse({ runId: "run-id" }).success).toBe(true)
    expect(schema.safeParse({ runId: "run-id", decision: "APPROVE" }).success).toBe(false)
    expect(S.payrollCreate.safeParse({ periodMonth: 1, periodYear: 2026, periodWeek: 53 }).success).toBe(true)
    expect(S.payrollCreate.safeParse({ periodMonth: 1, periodYear: 2026, periodWeek: 54 }).success).toBe(false)
  })
  test("employees.create schema rejects server-only smuggle fields (strict whitelist)", () => {
    const bad = S.employeesSave.safeParse({ fullName: "X", createdBy: "attacker", id: undefined })
    expect(bad.success).toBe(false) // strict() rejects unknown keys
  })
  test("employees.create schema rejects a negative salary and bad email", () => {
    expect(S.employeesSave.safeParse({ fullName: "X", basicSalary: -5 }).success).toBe(false)
    expect(S.employeesSave.safeParse({ fullName: "X", email: "not-an-email" }).success).toBe(false)
  })
  test("tasks.save schema blocks createdBy/createdAt/assigneeId client writes", () => {
    const r = S.taskSave.safeParse({ id: "t1", title: "Do", createdBy: "me", createdAt: "now", assigneeId: "victim" })
    expect(r.success).toBe(false)
  })
  test("bank schema has NO writable `verified` field", () => {
    expect("verified" in (S as any).bankSave.shape).toBe(false)
    const r = S.bankSave.safeParse({ employeeId: emp.id, bank: "B", verified: true })
    expect(r.success).toBe(false) // strict schema: verified is rejected
  })
})

describe("M-01 employees.banks.verify gate", () => {
  test("bank verify action exists with bankInfo.verify permission", () => {
    // Fixture repair (re-audit 2026-10-18): RBAC-102 (Wave R3-5) re-gated the
    // banks section onto the bankInfo.* family — employees.banks.verify now
    // rides bankInfo.verify (the old employeeDocs.verify verb was a
    // different module's family and stayed grantable while gating nothing).
    expect(routes["employees.banks.verify"]).toBeTruthy()
    expect(routes["employees.banks.verify"]!.perm).toEqual(["bankInfo", "verify"])
  })
})

describe("M-01 employees.bulkImport hardening", () => {
  test("default employment type is PERMANENT (valid member) — not FULL_TIME", async () => {
    // simulate the import normalization on a missing cell
    const { getRoute } = await import("@/hrm-server/routes/router")
    const res: any = await getRoute("employees.bulkImport")!.handler(ctx, {
      rows: [{ fullName: "Import Default Type " + uniq() }],
    })
    expect(res.created).toBe(1)
    const created = await db.employee.findFirst({ where: { vendorId: vendor.id, fullName: { startsWith: "Import Default Type" } }, orderBy: { createdAt: "desc" } })
    expect(created?.employmentType).toBe("PERMANENT")
  })
  test("invalid employment type cell → row ERROR, never persisted", async () => {
    const { getRoute } = await import("@/hrm-server/routes/router")
    const name = "Import Bad Type " + uniq()
    const res: any = await getRoute("employees.bulkImport")!.handler(ctx, {
      rows: [{ fullName: name, employmentType: "FULL_TIME" }],
    })
    expect(res.created).toBe(0)
    expect(res.results[0].status).toBe("ERROR")
    expect(await db.employee.findFirst({ where: { fullName: name } })).toBeNull()
  })
  test("invalid joiningDate cell → row ERROR", async () => {
    const { getRoute } = await import("@/hrm-server/routes/router")
    const res: any = await getRoute("employees.bulkImport")!.handler(ctx, {
      rows: [{ fullName: "Import Bad Date " + uniq(), joiningDate: "31/12/2024" }],
    })
    expect(res.created).toBe(0)
    expect(res.results[0].status).toBe("ERROR")
    expect(res.results[0].detail).toContain("YYYY-MM-DD")
  })
})

describe("M-01 requireValid helper", () => {
  test("validates and throws 400 Deny with a path on failure", () => {
    expect(requireValid(S.byId, { id: "x" })).toEqual({ id: "x" })
    let err: any = null
    try { requireValid(S.leaveApply, { leaveTypeId: "lt", fromDate: "not-a-date", toDate: "2026-01-01" }) } catch (e) { err = e }
    expect(err).toBeTruthy()
    expect(err.code).toBe(400)
    expect(err.message).toContain("fromDate")
  })
})
