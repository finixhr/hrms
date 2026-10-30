/// <reference types="bun-types" />
// ============ R4 + R7 regression: billing receipt + fieldforce null payload ============
// R4: billing.receipt 500'd with 'WinAnsi cannot encode "→"' whenever a PAID
//     invoice's receipt PDF was rendered (the "Billing period X → Y" line).
//     Fix: WinAnsi-safe text pipeline in renderReceiptPdf.
// R7: fieldforce.report / fieldforce.plan.get used .optional() (undefined-only)
//     while the Reports tab default "all" sends employeeId: null → zod 400 on
//     EVERY initial load. Fix: .nullish().
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"

let vendor: { id: string }
let admin: { id: string; token: string }
let invoiceId: string

beforeAll(async () => {
  vendor = await mkVendor("R4R7 Vendor")
  const u = await mkUser(vendor.id, { role: "HR_ADMIN", name: "R4R7 Admin" })
  admin = { id: u.id, token: await mkSession(u.id, "FULL") }
})

describe("R4 — billing receipt PDF renders for PAID invoices", () => {
  test("receipt downloads as base64 PDF (previously 500 WinAnsi encode error)", async () => {
    const inv = await db.saasInvoice.create({
      data: {
        vendorId: vendor.id,
        number: uniq("INV-R4-"),
        periodStart: new Date("2026-10-01T00:00:00Z"),
        periodEnd: new Date("2027-03-25T00:00:00Z"),
        amount: 65000, currency: "BDT", status: "PAID",
        paidAt: new Date(), paymentMethod: "BANK",
      },
    })
    invoiceId = inv.id
    const res = await postHrm("billing.receipt", { invoiceId: inv.id }, { bearer: admin.token })
    expect(res.body.ok).toBe(true) // previously: 500 Unexpected server error
    expect(typeof res.body.data.base64).toBe("string")
    expect(res.body.data.base64.length).toBeGreaterThan(500)
    expect(res.body.data.filename).toContain(".pdf")
  })

  test("unpaid invoices still refuse a receipt with a clean 400", async () => {
    const inv = await db.saasInvoice.create({
      data: {
        vendorId: vendor.id,
        number: uniq("INV-R4P-"),
        periodStart: new Date("2026-10-01T00:00:00Z"), periodEnd: new Date("2027-03-25T00:00:00Z"),
        amount: 1000, currency: "BDT", status: "PENDING",
      },
    })
    const res = await postHrm("billing.receipt", { invoiceId: inv.id }, { bearer: admin.token })
    expect(res.body.ok).toBe(false)
    expect(res.status).toBe(400)
  })
})

describe("R7 — fieldforce report accepts employeeId null (the 'all' filter)", () => {
  test("fieldforce.report with employeeId: null returns a report instead of a 400", async () => {
    // previously: 400 'Invalid payload at "employeeId": Expected string, received null'
    const from = "2026-09-01", to = "2026-10-12"
    const res = await postHrm("fieldforce.report", { from, to, employeeId: null }, { bearer: admin.token })
    expect(res.body.ok).toBe(true)
    expect(res.body.data.rows).toBeDefined()
  })

  test("fieldforce.plan.get with employeeId: null no longer 400s", async () => {
    const res = await postHrm("fieldforce.plan.get", { date: "2026-10-12", employeeId: null }, { bearer: admin.token })
    // an HR admin without a linked employee profile gets a clean 400 "employeeId
    // is required (or sign in with a linked employee profile)" — NOT the zod
    // validation error; with a linked profile it returns the plan.
    if (res.body.ok) {
      expect(res.body.data.date).toBe("2026-10-12")
    } else {
      expect(String(res.body.error)).toContain("linked employee profile")
      expect(String(res.body.error)).not.toContain("Invalid payload")
    }
  })

  test("a scoped employeeId still resolves through the same schema", async () => {
    const emp = await mkEmployee(vendor.id, { fullName: "R7 Emp", code: uniq("R7") })
    const from = "2026-09-01", to = "2026-10-12"
    const res = await postHrm("fieldforce.report", { from, to, employeeId: emp.id }, { bearer: admin.token })
    expect(res.body.ok).toBe(true)
  })
})
