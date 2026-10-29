/// <reference types="bun-types" />
// ============ M-13 regression: audit PII diff + cursor pagination ============
// Employee-change audit entries store only the CHANGED fields with PII keys
// masked; audit.list pages by cursor instead of a silent 200-row cap.
import "./_testdb" // first — sets DATABASE_URL before db.ts is constructed
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import "@/hrm-server/routes/router" // registers every action (side effect)
import { routes } from "@/hrm-server/routes/registry"
import { audit, auditDiff, auditPIIScrub } from "@/hrm-server/audit"
import { mkVendor, mkUser, mkEmployee, makeCtx, uniq } from "./_fixtures"

let vendor: { id: string }
let owner: { id: string; vendorId: string; role: string }
let emp: { id: string; vendorId: string }

beforeAll(async () => {
  vendor = await mkVendor("M13 Vendor")
  owner = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "Owner" })
  emp = await mkEmployee(vendor.id, { fullName: "M13 Emp" })
})

describe("M-13 auditDiff", () => {
  test("stores only changed fields", () => {
    const before = { fullName: "A", status: "ACTIVE", grade: "G1", weeklyOff: "FRIDAY" }
    const after = { fullName: "A", status: "SUSPENDED", grade: "G1", weeklyOff: "FRIDAY" }
    const d = auditDiff(before, after)!
    expect(Object.keys(d.newValue)).toEqual(["status"])
    expect(d.newValue.status).toBe("SUSPENDED")
  })
  test("PII keys are masked, not copied", () => {
    const before = { fullName: "A", taxTin: "123456", permanentAddress: "old", presentAddress: "old" }
    const after = { fullName: "A", taxTin: "999999", permanentAddress: "new", presentAddress: "new" }
    const d = auditDiff(before, after)!
    expect(d.newValue.taxTin).toBe("[redacted]")
    expect(d.newValue.permanentAddress).toBe("[redacted]")
    expect(JSON.stringify(d)).not.toContain("999999")
    expect(JSON.stringify(d)).not.toContain('"new"')
  })
  test("no changes → null (no useless audit payload)", () => {
    expect(auditDiff({ a: 1, b: "x" }, { a: 1, b: "x" })).toBeNull()
  })
})

describe("M-13 auditPIIScrub — delete snapshots", () => {
  test("PII keys are dropped entirely from delete snapshots", () => {
    const row = { id: "e1", employeeId: "emp1", fullName: "Rahim", taxTin: "123456789012",
      permanentAddress: "House 12, Road 3", fatherName: "Abdul", motherName: "Halima",
      accountNumber: "1234567890123", designationId: "d1" }
    const scrubbed = auditPIIScrub(row)!
    expect(scrubbed.id).toBe("e1")
    expect(scrubbed.fullName).toBe("Rahim")
    expect(scrubbed.designationId).toBe("d1")
    expect(scrubbed.taxTin).toBeUndefined()
    expect(scrubbed.permanentAddress).toBeUndefined()
    expect(scrubbed.fatherName).toBeUndefined()
    expect(scrubbed.motherName).toBeUndefined()
    expect(scrubbed.accountNumber).toBeUndefined()
  })
  test("null row scrubs to null", () => {
    expect(auditPIIScrub(null)).toBeNull()
  })
})

describe("M-13 employees.update audit payload", () => {
  test("audit entry contains a diff, never the full row", async () => {
    const ctx = makeCtx(owner, ["*"])
    const fresh = await mkEmployee(vendor.id, { fullName: "M13 Update Emp", code: uniq("E") })
    await routes["employees.update"]!.handler(ctx, {
      id: fresh.id, fullName: "M13 Renamed Emp", mobile: "SECRET-PHONE-42",
    })
    const entry = await db.auditLog.findFirst({
      where: { vendorId: vendor.id, action: "employees.update", entityId: fresh.id },
      orderBy: { createdAt: "desc" },
    })
    expect(entry).toBeTruthy()
    const payload = JSON.stringify(entry)
    expect(payload).not.toContain("SECRET-PHONE-42")     // PII masked
    expect(entry!.newValue).toContain("M13 Renamed Emp")  // the real change is visible
    expect(payload).not.toContain(`"fullName":"M13 Renamed Emp","mobile"`) // no full-row copy
  })
})

describe("M-13 audit.list cursor pagination", () => {
  test("returns { items, nextCursor } and pages consistently", async () => {
    const ctx = makeCtx(owner, ["*"])
    const marker = uniq("m13")
    for (let i = 0; i < 7; i++) {
      await audit(ctx, "test." + marker, "Employee", emp.id || "x", `${marker} entry ${i}`)
    }
    const page1: any = await routes["audit.list"]!.handler(ctx, { q: marker, limit: 3 })
    expect(page1.items.length).toBe(3)
    expect(page1.nextCursor).toBeTruthy()
    const page2: any = await routes["audit.list"]!.handler(ctx, { q: marker, limit: 3, cursor: page1.nextCursor })
    expect(page2.items.length).toBe(3)
    // pages do not overlap
    const ids1 = new Set(page1.items.map((r: any) => r.id))
    expect(page2.items.some((r: any) => ids1.has(r.id))).toBe(false)
    const page3: any = await routes["audit.list"]!.handler(ctx, { q: marker, limit: 3, cursor: page2.nextCursor })
    expect(page3.items.length).toBe(1)
    expect(page3.nextCursor).toBeNull()
  })
})
