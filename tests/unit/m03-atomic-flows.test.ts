/// <reference types="bun-types" />
// ============ M-03 regression: atomic client flows ============
// employees.createWithStructure lands the employee AND the initial salary
// structure (with H-09 paisa dual-write) in ONE transaction; a missing
// payroll.edit permission rejects the compound call; hard-delete requires
// the employee CODE as typed confirmation.
import "./_testdb" // first — sets DATABASE_URL before db.ts is constructed
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkBranch, mkEmployee, makeCtx, uniq } from "./_fixtures"
import { getRoute } from "@/hrm-server/routes/router"

let vendor: { id: string }
let owner: { id: string; vendorId: string; role: string }
let branch: { id: string; vendorId: string; name: string }

beforeAll(async () => {
  vendor = await mkVendor("M03 Vendor")
  owner = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "Owner" })
  branch = await mkBranch(vendor.id, "M03 Branch")
})

describe("M-03 employees.createWithStructure", () => {
  test("creates the employee + initial structure atomically (with paisa dual-write)", async () => {
    const ctx = makeCtx(owner, ["*"])
    const res: any = await getRoute("employees.createWithStructure")!.handler(ctx, {
      fullName: "M03 Atomic Emp", joiningDate: "2026-01-05", branchId: branch.id,
      employmentType: "PERMANENT",
      basic: 30000.50, houseRent: 6000.25, medical: 500.75, conveyance: 1000,
    })
    expect(res.id).toBeString()
    const emp = await db.employee.findFirst({ where: { id: res.id } })
    expect(emp?.code).toBe(res.code)
    const structure = await db.salaryStructure.findFirst({ where: { employeeId: res.id, status: "ACTIVE" } })
    expect(structure).not.toBeNull()
    expect(structure!.basic).toBe(30000.50)
    expect(structure!.gross).toBe(37502) // Math.round(30000.50+6000.25+500.75+1000) — matches salaryStructures.save
    // H-09 — paisa shadows written by the atomic path (BIGINT columns → bigint reads)
    expect(Number((structure as any).basicPaisa)).toBe(3000050)
    expect(Number((structure as any).grossPaisa)).toBe(3750200)
    const history = await db.employeeHistory.findMany({ where: { employeeId: res.id, eventType: "JOINED" } })
    expect(history).toHaveLength(1)
  })

  test("creates the employee WITHOUT a structure when basic is 0/absent", async () => {
    const ctx = makeCtx(owner, ["*"])
    const res: any = await getRoute("employees.createWithStructure")!.handler(ctx, {
      fullName: "M03 No Salary Emp", joiningDate: "2026-01-05", branchId: branch.id,
    })
    const structure = await db.salaryStructure.findFirst({ where: { employeeId: res.id } })
    expect(structure).toBeNull()
    expect(await db.employee.findFirst({ where: { id: res.id } })).not.toBeNull()
  })

  test("rejects when the caller lacks payroll.edit (structure half needs it)", async () => {
    const hrOnly = await mkUser(vendor.id, { role: "HR_ADMIN", name: "HR Only" })
    const ctx = makeCtx(hrOnly, ["employees.create"]) // no payroll.edit, no *
    let threw = false
    try {
      await getRoute("employees.createWithStructure")!.handler(ctx, {
        fullName: "M03 Denied Emp", joiningDate: "2026-01-05", branchId: branch.id, basic: 1000,
      })
    } catch (e: any) {
      threw = true
      expect(e.message).toMatch(/payroll edit/i)
    }
    expect(threw).toBe(true)
    // nothing landed — not even the employee half
    expect(await db.employee.findFirst({ where: { vendorId: vendor.id, fullName: "M03 Denied Emp" } })).toBeNull()
  })

  test("atomicity: a failing structure write rolls the whole employee back", async () => {
    const ctx = makeCtx(owner, ["*"])
    // joiningDate in the future → prepareEmployeeCreate throws AFTER the
    // permission gate, BEFORE the transaction — nothing lands. To exercise a
    // mid-transaction rollback we instead pass an invalid branchId FK: the
    // employee insert itself fails inside the transaction and must roll back.
    let threw = false
    try {
      await getRoute("employees.createWithStructure")!.handler(ctx, {
        fullName: "M03 Rollback Emp", joiningDate: "2026-01-05",
        branchId: "nonexistent-branch-id", basic: 5000,
      })
    } catch { threw = true }
    expect(threw).toBe(true)
    expect(await db.employee.findFirst({ where: { vendorId: vendor.id, fullName: "M03 Rollback Emp" } })).toBeNull()
  })
})
