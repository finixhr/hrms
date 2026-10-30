/// <reference types="bun-types" />
// ============ Phase 5 P6 WS-B — server-side pagination for full-list UIs =====
// Covers the MOD-16 optional-pagination contract added to the six former
// load-all list actions (M-11 follow-up):
//   loans.list · advances.list · expenses.list · resignations.list ·
//   leaveBalances.list · payroll.entries
//
// The contract (identical shape to leaveRequests.list / attendance.register):
//   · LEGACY callers (no page/pageSize) keep the exact full-array contract.
//   · PAGED callers get { items, total, page, pageSize } (pageSize clamped to
//     500) — and the KPI `summary` block computed set-based over the caller's
//     SCOPE (never the page).
//   · q search matches employee name/code IN SQL (the SCL-10 discipline,
//     intersected with the caller's branch/department scope).
//   · Decoration (employeeName, installments, clearance/settlement) is
//     page-scoped via whereIn — never the full directory.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, makeCtx, uniq } from "./_fixtures"
import { getRoute } from "@/hrm-server/routes/router"

let vendor: any, owner: any, ctx: any

beforeAll(async () => {
  vendor = await mkVendor("P6-PAGE")
  owner = await mkUser(vendor.id)
  ctx = makeCtx(owner)
})

const N = 12 // fixtures per family — pageSize 5 gives 3 pages

describe("P6 WS-B — loans.list pagination + summary + search", () => {
  test("legacy contract intact (bare array), paged contract { items, total, page, pageSize, summary }, pageSize walk without duplicates", async () => {
    const v = await mkVendor("P6-PAGE-LOANS")
    const emp = await mkEmployee(v.id, { fullName: "Loaner One" })
    for (let i = 0; i < N; i++) {
      await db.loan.create({
        data: {
          vendorId: v.id, employeeId: emp.id, type: i % 2 ? "PERSONAL" : "HOUSING",
          principal: 10000 + i, installments: 4, installmentAmount: 2500,
          startDate: "2026-10-01",
          status: i < 3 ? "PENDING" : i < 9 ? "ACTIVE" : "CLOSED",
          outstanding: i < 9 ? 5000 + i : 0,
        } as any,
      })
    }
    const c = makeCtx(await mkUser(v.id), ["loans.view"])
    // legacy: bare array, every row
    const legacy = await getRoute("loans.list")!.handler(c, {}) as any[]
    expect(Array.isArray(legacy)).toBe(true)
    expect(legacy.length).toBe(N)
    // paged: envelope + honest total
    const p1: any = await getRoute("loans.list")!.handler(c, { page: 1, pageSize: 5 })
    expect(Array.isArray(p1)).toBe(false)
    expect(p1.items.length).toBe(5)
    expect(p1.total).toBe(N)
    expect(p1.page).toBe(1)
    expect(p1.pageSize).toBe(5)
    // walk every page — no duplicates, all rows seen
    const seen = new Set<string>()
    for (let page = 1; page <= 3; page++) {
      const p: any = await getRoute("loans.list")!.handler(c, { page, pageSize: 5 })
      for (const l of p.items) expect(seen.has(l.id)).toBe(false), seen.add(l.id)
    }
    expect(seen.size).toBe(N)
    // summary = cohort truth over the SCOPE (status filter must NOT change it)
    expect(p1.summary.total).toBe(N)
    expect(p1.summary.pending).toBe(3)
    expect(p1.summary.active).toBe(6)
    expect(p1.summary.closed).toBe(3)
    expect(p1.summary.outstandingActive).toBe(5003 + 5004 + 5005 + 5006 + 5007 + 5008) // ACTIVE rows i=3..8
    const filtered: any = await getRoute("loans.list")!.handler(c, { page: 1, pageSize: 5, status: "CLOSED" })
    expect(filtered.total).toBe(3)
    expect(filtered.items.every((l: any) => l.status === "CLOSED")).toBe(true)
    expect(filtered.summary.total).toBe(N) // KPI truth unaffected by the table filter
  })

  test("installments arrive batched per page and nextDue rides each row (the N+1 is gone)", async () => {
    const v = await mkVendor("P6-PAGE-LOANS2")
    const emp = await mkEmployee(v.id, { fullName: "Loaner Two" })
    const loan = await db.loan.create({
      data: { vendorId: v.id, employeeId: emp.id, type: "PERSONAL", principal: 4000, installments: 2, installmentAmount: 2000, startDate: "2026-10-01", status: "ACTIVE", outstanding: 4000 } as any,
    })
    await db.loanInstallment.createMany({
      data: [
        { vendorId: loan.vendorId, loanId: loan.id, no: 1, amount: 2000, dueDate: "2026-11-05", status: "UNPAID" },
        { vendorId: loan.vendorId, loanId: loan.id, no: 2, amount: 2000, dueDate: "2026-12-05", status: "UNPAID" },
      ],
    })
    const c = makeCtx(await mkUser(v.id), ["loans.view"])
    const p: any = await getRoute("loans.list")!.handler(c, { page: 1, pageSize: 10 })
    const row = p.items.find((l: any) => l.id === loan.id)
    expect(row.installments.length).toBe(2)
    expect(row.nextDue).toBe("2026-11-05")
    expect(row.employeeName).toBe("Loaner Two")
  })

  test("q searches employee name/code in SQL — beyond the loaded page", async () => {
    const v = await mkVendor("P6-PAGE-LOANS3")
    const needle = await mkEmployee(v.id, { fullName: "Zahin Zaman", code: "ZZ-9001" })
    const other = await mkEmployee(v.id, { fullName: "Other Person", code: "OP-0002" })
    await db.loan.create({ data: { vendorId: v.id, employeeId: needle.id, type: "PERSONAL", principal: 1000, installments: 1, installmentAmount: 1000, startDate: "2026-10-01", status: "ACTIVE", outstanding: 1000 } as any })
    await db.loan.create({ data: { vendorId: v.id, employeeId: other.id, type: "PERSONAL", principal: 1000, installments: 1, installmentAmount: 1000, startDate: "2026-10-01", status: "ACTIVE", outstanding: 1000 } as any })
    const c = makeCtx(await mkUser(v.id), ["loans.view"])
    const byName: any = await getRoute("loans.list")!.handler(c, { page: 1, pageSize: 5, q: "zahin" })
    expect(byName.total).toBe(1)
    expect(byName.items[0].employeeName).toBe("Zahin Zaman")
    const byCode: any = await getRoute("loans.list")!.handler(c, { page: 1, pageSize: 5, q: "ZZ-9001" })
    expect(byCode.total).toBe(1)
    const none: any = await getRoute("loans.list")!.handler(c, { page: 1, pageSize: 5, q: "doesnotexist" })
    expect(none.total).toBe(0)
    expect(none.items).toEqual([])
  })
})

describe("P6 WS-B — advances.list / expenses.list pagination + summaries", () => {
  test("advances: envelope, totals, and the recovering/pending/recovered summary mix", async () => {
    const v = await mkVendor("P6-PAGE-ADV")
    const emp = await mkEmployee(v.id, { fullName: "Advancer One" })
    for (let i = 0; i < 7; i++) {
      await db.advance.create({
        data: {
          vendorId: v.id, employeeId: emp.id, amount: 1000 + i, requestDate: "2026-10-01", reason: "need",
          status: i < 2 ? "PENDING" : i < 5 ? "RECOVERING" : "RECOVERED",
          outstanding: i >= 2 && i < 5 ? 800 + i : 0,
        } as any,
      })
    }
    const c = makeCtx(await mkUser(v.id), ["advances.view"])
    const p: any = await getRoute("advances.list")!.handler(c, { page: 1, pageSize: 3 })
    expect(p.items.length).toBe(3)
    expect(p.total).toBe(7)
    expect(p.summary.pending).toBe(2)
    expect(p.summary.recovering).toBe(3)
    expect(p.summary.recovered).toBe(2)
    expect(p.summary.outstandingRecovering).toBe(802 + 803 + 804) // i=2,3,4
    const legacy = await getRoute("advances.list")!.handler(c, {}) as any[]
    expect(Array.isArray(legacy) && legacy.length).toBe(7)
  })

  test("expenses: envelope, status narrowing, and the month/claimed money summary", async () => {
    const v = await mkVendor("P6-PAGE-EXP")
    const emp = await mkEmployee(v.id, { fullName: "Spender One" })
    const now = new Date()
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-15`
    for (let i = 0; i < 6; i++) {
      const status = i < 2 ? "PENDING" : i < 4 ? "REIMBURSED" : "REJECTED"
      await db.expenseClaim.create({
        data: {
          vendorId: v.id, employeeId: emp.id, category: "TRAVEL", title: `Trip ${i}`,
          amount: 500 + i, date: "2026-10-01", status,
          ...(status === "REIMBURSED" ? { approvedAmount: 400 + i, reimbursementDate: thisMonth } : {}),
        } as any,
      })
    }
    const c = makeCtx(await mkUser(v.id), ["expenses.view"])
    const p: any = await getRoute("expenses.list")!.handler(c, { page: 2, pageSize: 2 })
    expect(p.total).toBe(6)
    expect(p.page).toBe(2)
    expect(p.items.length).toBe(2)
    expect(p.summary.pending).toBe(2)
    expect(p.summary.reimbursed).toBe(2)
    expect(p.summary.totalClaimed).toBe(500 + 501 + 502 + 503 + 504 + 505)
    expect(p.summary.reimbursedThisMonth).toBe(402 + 403) // approvedAmount of the REIMBURSED rows (i=2,3), this month only
    const narrowed: any = await getRoute("expenses.list")!.handler(c, { page: 1, pageSize: 10, status: "PENDING" })
    expect(narrowed.total).toBe(2)
    expect(narrowed.items.every((e: any) => e.status === "PENDING")).toBe(true)
  })
})

describe("P6 WS-B — resignations.list pagination + page-scoped decoration", () => {
  test("envelope + summary (notice/completed/pendingSettlements) + clearance/settlement only for the page", async () => {
    const v = await mkVendor("P6-PAGE-EXIT")
    const emps = await Promise.all([0, 1, 2, 3, 4].map((i) => mkEmployee(v.id, { fullName: `Exiter ${i}` })))
    for (let i = 0; i < 5; i++) {
      const res = await db.resignation.create({
        data: {
          vendorId: v.id, employeeId: emps[i].id, status: i < 2 ? "NOTICE_PERIOD" : i < 4 ? "COMPLETED" : "WITHDRAWN",
          reason: "moving on", submissionDate: "2026-10-01", resignationDate: "2026-10-02", proposedLwd: "2026-10-30",
        } as any,
      })
      if (i === 2) {
        await db.finalSettlement.create({ data: { vendorId: v.id, resignationId: res.id, status: "CALCULATED", netPayable: 12345 } as any })
      }
    }
    const c = makeCtx(await mkUser(v.id), ["exit.view"])
    const p1: any = await getRoute("resignations.list")!.handler(c, { page: 1, pageSize: 2 })
    expect(p1.total).toBe(5)
    expect(p1.items.length).toBe(2)
    expect(p1.summary.inNotice).toBe(2)
    expect(p1.summary.completed).toBe(2)
    expect(p1.summary.pendingSettlements).toBe(1) // the CALCULATED settlement
    // walk all pages: every row decorated with employeeName
    const names = new Set<string>()
    for (let page = 1; page <= 3; page++) {
      const p: any = await getRoute("resignations.list")!.handler(c, { page, pageSize: 2 })
      for (const r of p.items) {
        expect(r.employeeName).toMatch(/^Exiter \d$/)
        names.add(r.employeeName)
      }
    }
    expect(names.size).toBe(5)
    const legacy = await getRoute("resignations.list")!.handler(c, {}) as any[]
    expect(Array.isArray(legacy) && legacy.length).toBe(5)
  })
})

describe("P6 WS-B — leaveBalances.list pagination + year scoping", () => {
  test("envelope, totals, year filter honored, decoration page-scoped, q search", async () => {
    const v = await mkVendor("P6-PAGE-LV")
    const emps = await Promise.all([0, 1, 2].map((i) => mkEmployee(v.id, { fullName: `Balancer ${i}`, code: `BAL-${i}` })))
    const lt = await db.leaveType.create({ data: { vendorId: v.id, name: "Casual", code: "CL", defaultDays: 10, paid: true } as any })
    for (const e of emps) {
      await db.leaveBalance.create({ data: { vendorId: v.id, employeeId: e.id, leaveTypeId: lt.id, year: 2026, entitled: 10, used: 3, pending: 0, carriedForward: 0 } as any })
    }
    const c = makeCtx(await mkUser(v.id), ["leave.view"])
    const p: any = await getRoute("leaveBalances.list")!.handler(c, { year: 2026, page: 1, pageSize: 2 })
    expect(p.total).toBe(3)
    expect(p.items.length).toBe(2)
    expect(p.items[0].employeeName).toMatch(/^Balancer \d$/)
    expect(p.items[0].typeName).toBe("Casual")
    expect(p.items[0].remaining).toBe(7) // entitled + carried − used − pending
    // next-year page is empty (year scoping is in the WHERE)
    const otherYear: any = await getRoute("leaveBalances.list")!.handler(c, { year: 2027, page: 1, pageSize: 10 })
    expect(otherYear.total).toBe(0)
    // q narrows by employee name IN SQL
    const q: any = await getRoute("leaveBalances.list")!.handler(c, { year: 2026, page: 1, pageSize: 10, q: "Balancer 1" })
    expect(q.total).toBe(1)
    const legacy = await getRoute("leaveBalances.list")!.handler(c, { year: 2026 }) as any[]
    expect(Array.isArray(legacy) && legacy.length).toBe(3)
  })
})

describe("P6 WS-B — payroll.entries pagination + run-scoped money summary", () => {
  test("envelope { run, entries, items, total, summary }, decoration via Map, q search, summary independent of the page", async () => {
    const v = await mkVendor("P6-PAGE-PAY")
    const branch = await db.branch.create({ data: { vendorId: v.id, name: "HQ", code: uniq("B") } })
    const emps = await Promise.all([0, 1, 2, 3].map((i) =>
      db.employee.create({ data: { vendorId: v.id, fullName: `Payee ${i}`, code: `PAY-${i}`, branchId: branch.id, status: "ACTIVE", joiningDate: "2024-01-01" } })))
    const run = await db.payrollRun.create({
      data: { vendorId: v.id, periodMonth: 10, periodYear: 2026, frequency: "MONTHLY", runType: "REGULAR", status: "APPROVED", createdBy: owner.id } as any,
    })
    for (let i = 0; i < 4; i++) {
      await db.payrollEntry.create({
        data: {
          vendorId: v.id, runId: run.id, employeeId: emps[i].id,
          gross: 30000, net: 25000 + i,
          loanDeduction: i === 0 ? 1000 : 0, advanceDeduction: i === 1 ? 500 : 0, guarantorDeduction: 0,
          breakdownJson: JSON.stringify({ pf: { employeeAmount: i === 0 ? 1200 : 0 } }),
        } as any,
      })
    }
    const c = makeCtx(await mkUser(v.id), ["payroll.view"])
    const p: any = await getRoute("payroll.entries")!.handler(c, { runId: run.id, page: 1, pageSize: 2 })
    expect(p.run.id).toBe(run.id)
    expect(p.total).toBe(4)
    expect(p.items.length).toBe(2)
    expect(p.entries).toBe(p.items) // legacy array field kept in sync
    // decoration: names + branch via the page's ids (Map lookups)
    for (const e of p.items) {
      expect(e.employeeName).toMatch(/^Payee \d$/)
      expect(e.branchName).toBe("HQ")
    }
    // newest-net-first ordering preserved
    expect(p.items[0].net).toBeGreaterThanOrEqual(p.items[1].net)
    // summary = RUN truth (not the page): recoveries + PF
    expect(p.summary.loanRecovery).toBe(1000)
    expect(p.summary.advanceRecovery).toBe(500)
    expect(p.summary.pfEmployee).toBe(1200)
    // q search finds the one Payee beyond the loaded page
    const q: any = await getRoute("payroll.entries")!.handler(c, { runId: run.id, page: 1, pageSize: 2, q: "Payee 3" })
    expect(q.total).toBe(1)
    expect(q.items[0].employeeName).toBe("Payee 3")
    // legacy contract: { run, entries } with EVERY entry
    const legacy: any = await getRoute("payroll.entries")!.handler(c, { runId: run.id })
    expect(legacy.entries.length).toBe(4)
    expect(legacy.items).toBeUndefined()
  })
})
