/// <reference types="bun-types" />
// ============ M-6 + M-7 — bulk-import integrity & atomic code allocation ============
// M-6 regression: the bulk importer created employee+history as two separate
// awaits (non-atomic pair), silently imported unknown branch/department/
// designation names as null, and had no DB unique backing the dedup.
// M-7 regression: the interactive employee-code generator scanned for a free
// number then created (two concurrent creates collided into a raw P2002 500);
// the payroll adjustment-run sequence had the same read-then-write race.
import { describe, expect, it } from "bun:test"
import { sessionTokenHash } from "@/hrm-server/auth"
import { postHrm } from "./_hrm-endpoint"
import { db } from "@/lib/db"
import { mkBranch, mkEmployee, mkUser, mkVendor, uniq } from "./_fixtures"
import { makeCtx } from "./_fixtures"
import { createAdjustmentRun } from "@/hrm-server/payroll"

async function adminSession(vendorId: string) {
  const u = await mkUser(vendorId)
  const id = `m67-${uniq("s")}`
  await db.session.create({ data: { id, tokenHash: sessionTokenHash(id), userId: u.id, kind: "FULL", csrfToken: "x", expiresAt: new Date(Date.now() + 3600_000), ip: "127.0.0.1", lastSeenAt: new Date() } })
  return id
}

describe("M-6 — bulk import integrity", () => {
  it("an unrecognized branch name fails the row LOUDLY — no silent null import", async () => {
    const vendor = await mkVendor("M6-Loud")
    const sess = await adminSession(vendor.id)
    const r = await postHrm("employees.bulkImport", {
      rows: [{ "Full Name": "Loud Fail", "Branch": "NoSuchBranch" }],
    }, { bearer: sess })
    expect(r.status).toBe(200)
    const row = r.body?.data?.results?.[0]
    expect(row?.status).toBe("ERROR")
    expect(row?.detail).toContain("unknown branch")
    expect(row?.detail).toContain("NoSuchBranch")
    const count = await db.employee.count({ where: { vendorId: vendor.id, fullName: "Loud Fail" } })
    expect(count).toBe(0)
  })

  it("a valid row lands employee AND import-history together (atomic pair)", async () => {
    const vendor = await mkVendor("M6-Atomic")
    const b = await mkBranch(vendor.id, "Main HQ")
    const sess = await adminSession(vendor.id)
    const r = await postHrm("employees.bulkImport", {
      rows: [{ "Full Name": "Atomic Import", "Branch": "Main HQ" }],
    }, { bearer: sess })
    expect(r.status).toBe(200)
    expect(r.body?.data?.results?.[0]?.status).toBe("CREATED")
    const emp = await db.employee.findFirst({ where: { vendorId: vendor.id, fullName: "Atomic Import" } })
    expect(emp).toBeTruthy()
    expect(emp!.branchId).toBe(b.id) // the lookup RESOLVED, not null
    const hist = await db.employeeHistory.findFirst({ where: { employeeId: emp!.id, eventType: "JOINED" } })
    expect(hist).toBeTruthy()
  })

  it("the DB now enforces (vendorId, mobile) and (vendorId, officialEmail) uniques", async () => {
    const vendor = await mkVendor("M6-Unique")
    const a = await mkEmployee(vendor.id, { fullName: "A" })
    const b = await mkEmployee(vendor.id, { fullName: "B" })
    await db.employee.update({ where: { id: a.id }, data: { mobile: "01700000001" } })
    let threw = false
    try {
      await db.employee.update({ where: { id: b.id }, data: { mobile: "01700000001" } })
    } catch { threw = true }
    expect(threw).toBe(true)
    // NULLs are exempt (employees without a mobile)
    const c = await mkEmployee(vendor.id, { fullName: "C" })
    const nulled = await db.employee.update({ where: { id: c.id }, data: { mobile: null } })
    expect(nulled).toBeTruthy()
  })
})

describe("M-7 — atomic code allocation", () => {
  it("two CONCURRENT employees.create calls both succeed with DISTINCT codes", async () => {
    const vendor = await mkVendor("M7-Concurrent")
    const sess = await adminSession(vendor.id)
    const [a, b, c] = await Promise.all([
      postHrm("employees.create", { fullName: "Concurrent One" }, { bearer: sess }),
      postHrm("employees.create", { fullName: "Concurrent Two" }, { bearer: sess }),
      postHrm("employees.create", { fullName: "Concurrent Three" }, { bearer: sess }),
    ])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(c.status).toBe(200)
    const codes = [a.body?.data?.code, b.body?.data?.code, c.body?.data?.code]
    expect(new Set(codes).size).toBe(3)
    for (const code of codes) expect(String(code)).toMatch(/^EMP-\d+$/)
  })

  it("the generated sequence resumes past pre-existing manual codes (counter may lag)", async () => {
    const vendor = await mkVendor("M7-Lag")
    const sess = await adminSession(vendor.id)
    // a manual code far ahead of the (fresh) counter
    await postHrm("employees.create", { fullName: "Manual Code", code: "EMP-9001" }, { bearer: sess })
    const r = await postHrm("employees.create", { fullName: "Generated After" }, { bearer: sess })
    expect(r.status).toBe(200)
    const code = String(r.body?.data?.code)
    expect(code).not.toBe("EMP-9001") // advances past the legacy collision
    const dupe = await db.employee.count({ where: { vendorId: vendor.id, code } })
    expect(dupe).toBe(1)
  })

  it("concurrent adjustment-run creation allocates DISTINCT adjustSeq values (no P2002)", async () => {
    const vendor = await mkVendor("M7-Adjust")
    const ctx = makeCtx({ id: "u1", vendorId: vendor.id, role: "VENDOR_OWNER" } as any)
    const run = await db.payrollRun.create({
      data: { vendorId: vendor.id, periodMonth: 10, periodYear: 2026, runType: "REGULAR", status: "PAID", createdBy: "u1" },
    })
    const [r1, r2, r3] = await Promise.allSettled([
      createAdjustmentRun(ctx, run.id),
      createAdjustmentRun(ctx, run.id),
      createAdjustmentRun(ctx, run.id),
    ])
    expect(r1.status).toBe("fulfilled")
    expect(r2.status).toBe("fulfilled")
    expect(r3.status).toBe("fulfilled")
    const runs = await db.payrollRun.findMany({ where: { vendorId: vendor.id, runType: "ADJUSTMENT" } })
    expect(runs.length).toBe(3)
    const seqs = runs.map((x: any) => x.adjustSeq).sort((a: any, b: any) => a - b)
    expect(new Set(seqs).size).toBe(3)
  })
})
