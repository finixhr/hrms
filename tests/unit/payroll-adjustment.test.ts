/// <reference types="bun-types" />
// ============ H-16 regression: payroll adjustment unique key + rejection state ============
// adjustSeq widens the (vendor, period, runType) unique key so MULTIPLE
// adjustment runs can coexist in one period; adjusting non-PAID runs is
// rejected; a rejected run clears its approvalRequestId.
import "./_testdb" // first — sets DATABASE_URL before db.ts is constructed
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, makeCtx, uniq } from "./_fixtures"
import { createAdjustmentRun } from "@/hrm-server/payroll"
import { applyPayrollDecision } from "@/hrm-server/routes/payroll"

let vendor: { id: string }
let owner: { id: string; vendorId: string; role: string }
let ctx: any

async function mkRun(over: { runType?: string; status?: string; month?: number } = {}) {
  return db.payrollRun.create({
    data: {
      vendorId: vendor.id,
      periodMonth: over.month ?? 9,
      periodYear: 2026,
      periodWeek: 0,
      frequency: "MONTHLY",
      runType: over.runType || "REGULAR",
      status: over.status || "DRAFT",
      adjustRunId: null,
      adjustSeq: 0,
      createdBy: owner.id,
    },
  })
}

beforeAll(async () => {
  vendor = await mkVendor("H16 Vendor")
  owner = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "Owner" })
  ctx = makeCtx(owner, ["*"])
})

describe("H-16 createAdjustmentRun sequencing", () => {
  test("two adjustments for different source runs in the same month BOTH succeed", async () => {
    const srcA = await mkRun({ status: "PAID" })
    const srcB = await mkRun({ status: "PAID", runType: "BONUS" })
    const adj1 = await createAdjustmentRun(ctx, srcA.id)
    const adj2 = await createAdjustmentRun(ctx, srcB.id)
    expect(adj1).not.toBe(adj2)
    const rows = await db.payrollRun.findMany({ where: { vendorId: vendor.id, runType: "ADJUSTMENT" }, orderBy: { adjustSeq: "asc" } })
    expect(rows.map((r) => r.adjustSeq)).toEqual([1, 2])
  })
  test("a second adjustment of the SAME source run also gets a fresh sequence", async () => {
    const src = await mkRun({ status: "PAID", month: 10 })
    const a = await createAdjustmentRun(ctx, src.id)
    const b = await createAdjustmentRun(ctx, src.id)
    expect(a).not.toBe(b)
  })
  test("adjusting a non-PAID run is rejected", async () => {
    const src = await mkRun({ status: "CALCULATED", month: 11 })
    let msg = ""
    try { await createAdjustmentRun(ctx, src.id) } catch (e: any) { msg = e.message }
    expect(msg).toContain("PAID")
    const srcDraft = await mkRun({ status: "DRAFT", month: 12 })
    let msg2 = ""
    try { await createAdjustmentRun(ctx, srcDraft.id) } catch (e: any) { msg2 = e.message }
    expect(msg2).toContain("PAID")
  })
  test("a duplicate REGULAR run for the same period still fails (adjustSeq=0 uniqueness)", async () => {
    const month = 8
    await mkRun({ month })
    // same vendor+period+runType+adjustSeq(0) → unique violation
    await expect(mkRun({ month })).rejects.toThrow()
  })
})

describe("H-16 rejection clears the stale approval request", () => {
  test("a rejected run returns to CALCULATED with approvalRequestId=null", async () => {
    const run = await mkRun({ status: "HR_REVIEW", month: 7 })
    // simulate a live approval request id on the run
    await db.payrollRun.update({ where: { id: run.id }, data: { approvalRequestId: uniq("appr") } })
    await applyPayrollDecision({ userId: owner.id, userName: "Owner", vendorId: vendor.id }, run.id, "REJECTED")
    const after = await db.payrollRun.findUnique({ where: { id: run.id } })
    expect(after!.status).toBe("CALCULATED")
    expect(after!.approvalRequestId).toBeNull()
  })
  test("resubmission attaches a FRESH approval request id", async () => {
    const run = await mkRun({ status: "CALCULATED", month: 6 })
    const staleId = uniq("appr")
    await db.payrollRun.update({ where: { id: run.id }, data: { approvalRequestId: staleId } })
    const fresh = uniq("appr")
    // resubmit (mirrors submitRunForApproval's write)
    await db.payrollRun.update({ where: { id: run.id }, data: { status: "HR_REVIEW", approvalRequestId: fresh } })
    const after = await db.payrollRun.findUnique({ where: { id: run.id } })
    expect(after!.approvalRequestId).toBe(fresh)
    expect(after!.approvalRequestId).not.toBe(staleId)
  })
})
