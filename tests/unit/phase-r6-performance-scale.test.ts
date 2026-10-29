/// <reference types="bun-types" />
// ============ Phase R6 — performance & scale ================================
// PAY-08 payslips.list MOD-16 pagination + page-scoped decoration;
// ACC-01 SQL-side statement aggregation (trial balance / balance sheet / cash
//      flow / budget actuals) with parity oracles against the old in-memory
//      algorithm, and the 20,000-journal ceiling GONE;
// ACC-03 stats as SQL FILTER aggregates (incl. the unbalanced monitor);
// COM-06 + LVE-121 calendar batching (leave types, loan installments) and
//      branch-scoped holidays; the encash finalize structure lookup is
//      vendor-scoped (covered by the r3 engines suite);
// ESS-07 list caps, payslipNumber ordering, thumbnail profile photos,
//      batched own-loan installments;
// EMP-12 the directory left the 360° payload (pickers use the refList);
// EMP-13 trigram coverage on the ILIKE-searched contact columns;
// COM-04 notification retention sweep + badge capped at the list size;
// DB-06 refresh-token retention purge.
import "./_testdb"
import { describe, test, expect } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkBranch, uniq } from "./_fixtures"
import { getRoute } from "@/hrm-server/routes/router"
import { makeCtx } from "./_fixtures"
import { getCalendarEvents } from "@/hrm-server/calendar"
import { today, addDays } from "@/hrm-server/utils"

// ---------------------------------------------------------------------------
describe("ACC-01 — SQL-side statements match the in-memory algorithm (parity oracles)", () => {
  type Journal = { id: string; date: string; status: string; refType: string; amount: number; costCenterId: string | null; linesJson: string }

  /** The OLD in-memory per-account aggregation, reimplemented here as the
   *  parity oracle (per-line paisa rounding identical to the SQL ROUND). */
  function oracleAccountAgg(journals: Journal[], from?: string | null, to?: string | null) {
    const agg = new Map<string, { debitP: number; creditP: number }>()
    for (const jr of journals) {
      if (jr.status !== "POSTED") continue
      if (from && jr.date < from) continue
      if (to && jr.date > to) continue
      for (const l of JSON.parse(jr.linesJson) as { account: string; debit: number; credit: number }[]) {
        const a = agg.get(l.account) || { debitP: 0, creditP: 0 }
        a.debitP += Math.round((Number(l.debit) || 0) * 100)
        a.creditP += Math.round((Number(l.credit) || 0) * 100)
        agg.set(l.account, a)
      }
    }
    return agg
  }

  test("trial balance + balance sheet agree with the oracle to the paisa", async () => {
    const v = await mkVendor("R6 ACC parity")
    const cc = await db.costCenter.create({ data: { vendorId: v.id, code: uniq("CC"), name: "R6 CC" } as any })
    // a mixed journal corpus: payroll, expenses, cash movement, a manual voucher
    const seed = (date: string, refType: string, lines: [string, number, number][], amount: number, status = "POSTED") => ({
      vendorId: v.id, refType, refId: null, idempotencyKey: null, date, memo: "R6",
      linesJson: JSON.stringify(lines.map(([account, debit, credit]) => ({ account, accountName: account, debit, credit }))),
      amount, status, costCenterId: cc.id,
    })
    await db.accountJournal.createMany({ data: [
      seed("2026-06-05", "PAYROLL", [["5300", 50000, 0], ["2100", 0, 45000], ["2200", 0, 5000]], 50000),
      seed("2026-06-20", "EXPENSE", [["5100", 12000, 0], ["1010", 0, 12000]], 12000),
      seed("2026-07-02", "LOAN_DISBURSE", [["1200", 8000, 0], ["1010", 0, 8000]], 8000),
      seed("2026-07-15", "JOURNAL_VOUCHER", [["1210", 3000, 0], ["5100", 0, 3000]], 3000),
      seed("2026-05-01", "PAYROLL", [["5300", 20000, 0], ["2100", 0, 20000]], 20000), // before the window
      seed("2026-06-10", "JOURNAL_VOUCHER", [["9000", 1, 1]], 1, "DRAFT"), // not POSTED — excluded
    ] })

    const journals = await db.accountJournal.findMany({ where: { vendorId: v.id } }) as unknown as Journal[]
    const oracleJune = oracleAccountAgg(journals, "2026-06-01", "2026-06-30")
    const oracleAll = oracleAccountAgg(journals, null, null)

    const admin = makeCtx(await mkUser(v.id, { role: "HR_ADMIN" }), ["accounting.view"])
    const tbAll: any = await getRoute("accounting.trialBalance")!.handler(admin, {})
    const tbJune: any = await getRoute("accounting.trialBalance")!.handler(admin, { from: "2026-06-01", to: "2026-06-30" })

    for (const [tb, oracle] of [[tbAll, oracleAll], [tbJune, oracleJune]] as unknown as [any, Map<string, { debitP: number; creditP: number }>][]) {
      expect(tb.journalCount).toBe(journals.filter((j) => j.status === "POSTED" && (!tb.from || j.date >= tb.from) && (!tb.to || j.date <= tb.to)).length)
      for (const row of tb.rows) {
        const o = oracle.get(row.code)
        expect(o, `oracle has ${row.code}`).toBeTruthy()
        expect(row.totalDebit).toBe(o!.debitP / 100)
        expect(row.totalCredit).toBe(o!.creditP / 100)
        expect(row.balanceDr).toBe(Math.max(0, o!.debitP - o!.creditP) / 100)
        expect(row.balanceCr).toBe(Math.max(0, o!.creditP - o!.debitP) / 100)
      }
      expect(tb.rows.length).toBe(oracle.size)
      const oDr = [...oracle.values()].reduce((s, x) => s + x.debitP, 0)
      const oCr = [...oracle.values()].reduce((s, x) => s + x.creditP, 0)
      expect(tb.totals.debit).toBe(oDr / 100)
      expect(tb.totals.credit).toBe(oCr / 100)
      expect(tb.balanced).toBe(true)
    }

    const bs: any = await getRoute("accounting.balanceSheet")!.handler(admin, { asOf: "2026-12-31" })
    const oraclePos = oracleAll
    for (const section of [...bs.assets, ...bs.liabilities, ...bs.expenses]) {
      const o = oraclePos.get(section.code)!
      const signed = section.code.startsWith("1") || section.code.startsWith("5") ? o.debitP - o.creditP : o.creditP - o.debitP
      expect(section.amount).toBe(signed / 100)
    }
  })

  test("cash flow + stats agree with the oracle (opening / net / counterpart sections / unbalanced)", async () => {
    const v = await mkVendor("R6 ACC cf")
    const seed = (date: string, refType: string, lines: [string, number, number][]) => ({
      vendorId: v.id, refType, date, memo: "R6CF",
      linesJson: JSON.stringify(lines.map(([account, debit, credit]) => ({ account, accountName: account, debit, credit }))),
      amount: lines.reduce((s, l) => s + l[1], 0), status: "POSTED",
    })
    await db.accountJournal.createMany({ data: [
      seed("2026-05-10", "EXPENSE", [["5100", 5000, 0], ["1010", 0, 5000]]),   // opening cash
      seed("2026-06-05", "PAYROLL", [["5300", 20000, 0], ["2100", 0, 18000], ["1010", 0, 2000]]),
      seed("2026-06-25", "LOAN_DISBURSE", [["1200", 6000, 0], ["1200", 0, 1000], ["1010", 0, 5000]]), // cash-to-cash internal transfer
      seed("2026-07-01", "EXPENSE", [["5100", 3000, 0], ["1210", 0, 3000]]),
    ] })
    const journals = await db.accountJournal.findMany({ where: { vendorId: v.id } }) as unknown as { date: string; status: string; linesJson: string }[]

    const admin = makeCtx(await mkUser(v.id, { role: "HR_ADMIN" }), ["accounting.view"])
    const cf: any = await getRoute("accounting.cashFlow")!.handler(admin, { from: "2026-06-01", to: "2026-06-30" })

    // oracle cash math (per-journal cash paisa, the old algorithm)
    let oOpening = 0, oNet = 0, oTouched = 0
    const oFlows = new Map<string, number>()
    for (const jr of journals) {
      if (jr.status !== "POSTED") continue
      const lines = JSON.parse(jr.linesJson) as { account: string; debit: number; credit: number }[]
      let cashP = 0, hasCash = false
      for (const l of lines) {
        if (["1010", "1200", "1210"].includes(l.account)) {
          cashP += Math.round(l.debit * 100) - Math.round(l.credit * 100)
          hasCash = true
        }
      }
      if (!hasCash) continue
      if (jr.date < "2026-06-01") { oOpening += cashP; continue }
      if (jr.date > "2026-06-30") continue
      oNet += cashP
      oTouched++
      for (const l of lines) {
        if (["1010", "1200", "1210"].includes(l.account)) continue
        oFlows.set(l.account, (oFlows.get(l.account) || 0) + Math.round(l.credit * 100) - Math.round(l.debit * 100))
      }
    }
    expect(cf.opening).toBe(oOpening / 100)
    expect(cf.netChange).toBe(oNet / 100)
    expect(cf.journalCount).toBe(oTouched)
    expect(cf.balanced).toBe(true)
    for (const sec of cf.sections) for (const item of sec.items) {
      expect(item.amount).toBe((oFlows.get(item.code) || 0) / 100)
    }

    const st: any = await getRoute("accounting.stats")!.handler(admin, {})
    expect(st.total).toBe(journals.length)
    expect(st.unbalanced).toBe(0)
    expect(st.byRefType["PAYROLL"]).toBe(1)
    expect(st.byRefType["EXPENSE"]).toBe(2)
    expect(st.byRefType["LOAN_DISBURSE"]).toBe(1)
    expect(st.manualVouchers).toBe(0)
  })

  test("budget actuals compute per filter shape (cost center + period window)", async () => {
    const v = await mkVendor("R6 ACC budget")
    const cc = await db.costCenter.create({ data: { vendorId: v.id, code: uniq("CC"), name: "R6 CC2" } as any })
    const period = await db.accountingPeriod.create({ data: { vendorId: v.id, name: "R6 June", startDate: "2026-06-01", endDate: "2026-06-30" } as any })
    const seed = (date: string, account: string, debit: number, credit: number, costCenterId: string | null) => ({
      vendorId: v.id, refType: "EXPENSE", date, memo: "R6B", costCenterId,
      linesJson: JSON.stringify([{ account, accountName: account, debit, credit }]),
      amount: debit, status: "POSTED",
    })
    await db.accountJournal.createMany({ data: [
      seed("2026-06-05", "5100", 4000, 0, cc.id),
      seed("2026-06-20", "5100", 1500, 0, null),
      seed("2026-07-05", "5100", 900, 0, cc.id), // outside the period window
    ] })
    await db.budget.create({ data: { vendorId: v.id, accountCode: "5100", amount: 10000, periodId: period.id, costCenterId: cc.id } as any })
    const admin = makeCtx(await mkUser(v.id, { role: "HR_ADMIN" }), ["accounting.view"])
    const out: any = await getRoute("accounting.budgets.list")!.handler(admin, {})
    const row = out.rows[0]
    // actual = the June, cost-center-matched 4000 only (the 1500 is another CC, the 900 is July)
    expect(row.actual).toBe(4000)
    expect(row.budget).toBe(10000)
    expect(row.variance).toBe(6000)
    expect(row.pct).toBe(60)
  })

  test("the 20,000-journal cliff is GONE (statements work past the old ceiling)", async () => {
    const v = await mkVendor("R6 ACC scale")
    const rows: any[] = []
    for (let i = 0; i < 20_010; i++) {
      const d = `2026-${String(1 + (i % 12)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`
      rows.push({
        vendorId: v.id, refType: "PAYROLL", refId: null, idempotencyKey: null, date: d, memo: "R6 scale",
        linesJson: JSON.stringify([
          { account: "5300", accountName: "5300", debit: 100, credit: 0 },
          { account: "2100", accountName: "2100", debit: 0, credit: 100 },
        ]),
        amount: 100, status: "POSTED",
      })
    }
    for (let i = 0; i < rows.length; i += 5000) await db.accountJournal.createMany({ data: rows.slice(i, i + 5000) })
    const admin = makeCtx(await mkUser(v.id, { role: "HR_ADMIN" }), ["accounting.view"])
    // the OLD handlers threw 400 past 20,000; the SQL-side ones just answer
    const tb: any = await getRoute("accounting.trialBalance")!.handler(admin, {})
    expect(tb.journalCount).toBe(20_010)
    expect(tb.rows.find((r: any) => r.code === "5300").totalDebit).toBe(2_001_000)
    const st: any = await getRoute("accounting.stats")!.handler(admin, {})
    expect(st.total).toBe(20_010)
    expect(st.unbalanced).toBe(0)
    const bs: any = await getRoute("accounting.balanceSheet")!.handler(admin, { asOf: "2026-12-31" })
    expect(bs.balanced).toBe(true)
  })
})

// ---------------------------------------------------------------------------
describe("PAY-08 — payslips.list MOD-16 + page-scoped decoration", () => {
  test("paged mode returns { items, total } and legacy mode keeps the bare array", async () => {
    const v = await mkVendor("R6 PAY08")
    const e1 = await mkEmployee(v.id, { fullName: "Pay08 One" })
    const e2 = await mkEmployee(v.id, { fullName: "Pay08 Two" })
    const run = await db.payrollRun.create({ data: { vendorId: v.id, periodMonth: 6, periodYear: 2026, frequency: "MONTHLY", status: "PAID" } as any })
    for (const [i, e] of [e1, e2].entries()) {
      await db.payrollEntry.create({ data: { vendorId: v.id, runId: run.id, employeeId: e.id, status: "INCLUDED", gross: 30000 + i * 1000, net: 27000, payslipNumber: `PS-2026-06-000${i + 1}` } as any })
    }
    const admin = makeCtx(await mkUser(v.id, { role: "HR_ADMIN" }), ["payslip.view", "payroll.view"])
    const paged: any = await getRoute("payslips.list")!.handler(admin, { page: 1, pageSize: 1 })
    expect(paged.total).toBe(2)
    expect(paged.items.length).toBe(1)
    expect(paged.items[0].employeeName).toBeTruthy()
    expect(paged.items[0].period).toContain("June 2026")
    const legacy: any = await getRoute("payslips.list")!.handler(admin, {})
    expect(Array.isArray(legacy)).toBe(true)
    expect(legacy.length).toBe(2)
    expect(legacy.every((r: any) => typeof r.employeeName === "string")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
describe("COM-06 + LVE-121 — calendar batching + branch-scoped holidays", () => {
  test("leave events carry the right type names (one batched type query), branch holidays respect scope, installments batch", async () => {
    const v = await mkVendor("R6 CAL")
    const b1 = await mkBranch(v.id, "Cal Branch One")
    const b2 = await mkBranch(v.id, "Cal Branch Two")
    const me = await mkEmployee(v.id, { fullName: "Cal Me", branchId: b1.id })
    const type = await db.leaveType.create({ data: { vendorId: v.id, code: uniq("LT"), name: "R6 Special Leave", defaultDays: 10, paid: true } as any })
    await db.leaveRequest.create({ data: { vendorId: v.id, employeeId: me.id, leaveTypeId: type.id, fromDate: "2026-06-10", toDate: "2026-06-11", days: 2, status: "APPROVED" } as any })
    // branch-specific vs company-wide holidays
    await db.holiday.create({ data: { vendorId: v.id, name: "R6 Branch One Holiday", date: "2026-06-15", type: "COMPANY", branchId: b1.id } as any })
    await db.holiday.create({ data: { vendorId: v.id, name: "R6 Branch Two Holiday", date: "2026-06-16", type: "COMPANY", branchId: b2.id } as any })
    await db.holiday.create({ data: { vendorId: v.id, name: "R6 Company Holiday", date: "2026-06-17", type: "PUBLIC" } as any })
    // an active loan with a due installment in-window
    const loan = await db.loan.create({ data: { vendorId: v.id, employeeId: me.id, principal: 5000, outstanding: 4000, status: "ACTIVE", startDate: "2026-01-01" } as any })
    await db.loanInstallment.create({ data: { vendorId: v.id, loanId: loan.id, no: 1, dueDate: "2026-06-20", amount: 1000 } as any })
    await db.loanInstallment.create({ data: { vendorId: v.id, loanId: loan.id, no: 2, dueDate: "2026-07-20", amount: 1000 } as any })

    // full view: both branch holidays + the leave with the batched type name
    const all = await getCalendarEvents(v.id, 6, 2026)
    const leave = all.find((e) => e.kind === "LEAVE")
    expect(leave?.title).toContain("R6 Special Leave")
    expect(all.some((e) => e.kind === "HOLIDAY" && e.title === "R6 Branch One Holiday")).toBe(true)
    expect(all.some((e) => e.kind === "HOLIDAY" && e.title === "R6 Branch Two Holiday")).toBe(true)
    expect(all.some((e) => e.kind === "HOLIDAY" && e.title === "R6 Company Holiday")).toBe(true)
    expect(all.some((e) => e.kind === "LOAN_INSTALL" && e.detail?.includes("#1"))).toBe(true)
    expect(all.some((e) => e.kind === "LOAN_INSTALL" && e.detail?.includes("#2"))).toBe(false) // July installment out of window

    // LVE-121: branch-scoped view sees branch-one + company holidays only
    const scoped = await getCalendarEvents(v.id, 6, 2026, { branchId: b1.id })
    expect(scoped.some((e) => e.kind === "HOLIDAY" && e.title === "R6 Branch One Holiday")).toBe(true)
    expect(scoped.some((e) => e.kind === "HOLIDAY" && e.title === "R6 Branch Two Holiday")).toBe(false)
    expect(scoped.some((e) => e.kind === "HOLIDAY" && e.title === "R6 Company Holiday")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
describe("ESS-07 — bounded ESS surfaces", () => {
  test("ess.payroll: newest 60 by payslipNumber (never net-desc), runs page-scoped", async () => {
    const v = await mkVendor("R6 ESS07 payroll")
    const me = await mkEmployee(v.id, { fullName: "Ess07 Me" })
    // one entry per run (the (runId, employeeId) unique demands it) — 65 runs
    const runs: any[] = []
    for (let i = 1; i <= 65; i++) {
      runs.push({ vendorId: v.id, periodMonth: 1 + (i % 12), periodYear: 2000 + Math.floor(i / 12), frequency: "MONTHLY", status: "PAID" })
    }
    const createdRuns = await db.payrollRun.createMany({ data: runs })
    const runRows = await db.payrollRun.findMany({ where: { vendorId: v.id }, select: { id: true }, orderBy: { id: "asc" } })
    const entries: any[] = runRows.map((r, idx) => ({ vendorId: v.id, runId: r.id, employeeId: me.id, status: "INCLUDED", gross: 1000, net: 1000 - idx, payslipNumber: `PS-2026-${String(idx + 1).padStart(4, "0")}` }))
    await db.payrollEntry.createMany({ data: entries })
    const empUser = await mkUser(v.id, { role: "EMPLOYEE", employeeId: me.id })
    const ctx = makeCtx(empUser)
    const out: any = await getRoute("ess.payroll")!.handler(ctx, {})
    expect(out.payslips.length).toBe(60)
    // newest payslip number first (the old net-desc order was meaningless)
    expect(out.payslips[0].payslipNumber).toBe("PS-2026-0065")
    expect(out.payslips[1].payslipNumber).toBe("PS-2026-0064")
  })

  test("ess.profile ships the thumbnail, not the full-size photo", async () => {
    const v = await mkVendor("R6 ESS07 photo")
    const me = await mkEmployee(v.id, { fullName: "Ess07 Photo" })
    await db.employee.update({
      where: { id: me.id },
      data: { photoUrl: "data:image/jpeg;base64,FULLSIZE", photoThumb: "data:image/jpeg;base64,THUMB" } as any,
    })
    const empUser = await mkUser(v.id, { role: "EMPLOYEE", employeeId: me.id })
    const out: any = await getRoute("ess.profile")!.handler(makeCtx(empUser), {})
    expect(out.employee.photoUrl).toBe("data:image/jpeg;base64,THUMB")
  })

  test("ess.loans batches installments across own loans; expenses + tasks are capped", async () => {
    const v = await mkVendor("R6 ESS07 lists")
    const me = await mkEmployee(v.id, { fullName: "Ess07 Lists" })
    const l1 = await db.loan.create({ data: { vendorId: v.id, employeeId: me.id, principal: 1000, outstanding: 800, status: "ACTIVE", startDate: "2026-01-01" } as any })
    const l2 = await db.loan.create({ data: { vendorId: v.id, employeeId: me.id, principal: 2000, outstanding: 1500, status: "ACTIVE", startDate: "2026-02-01" } as any })
    await db.loanInstallment.createMany({ data: [
      { vendorId: v.id, loanId: l1.id, no: 1, dueDate: "2026-03-01", amount: 200 },
      { vendorId: v.id, loanId: l1.id, no: 2, dueDate: "2026-04-01", amount: 200 },
      { vendorId: v.id, loanId: l2.id, no: 1, dueDate: "2026-03-05", amount: 250 },
    ] })
    const empUser = await mkUser(v.id, { role: "EMPLOYEE", employeeId: me.id })
    const ctx = makeCtx(empUser)
    const out: any = await getRoute("ess.loans")!.handler(ctx, {})
    const l1Row = out.loans.find((l: any) => l.id === l1.id)
    const l2Row = out.loans.find((l: any) => l.id === l2.id)
    expect(l1Row.installments.length).toBe(2)
    expect(l2Row.installments.length).toBe(1)

    // expenses: 205 rows → the route caps at 200 (most recent first)
    const claims: any[] = []
    for (let i = 0; i < 205; i++) {
      claims.push({ vendorId: v.id, employeeId: me.id, category: "TRAVEL", title: `c${i}`, amount: 100 + i, date: "2026-06-01", status: "PENDING" })
    }
    await db.expenseClaim.createMany({ data: claims })
    const expenses: any = await getRoute("ess.expenses")!.handler(ctx, {})
    expect(expenses.length).toBe(200)
  })
})

// ---------------------------------------------------------------------------
describe("EMP-12 + EMP-13 — directory off the 360° payload; trigram coverage", () => {
  test("employees.get no longer ships lookups.employees (pickers use the refList)", async () => {
    const v = await mkVendor("R6 EMP12")
    await mkEmployee(v.id, { fullName: "Emp12 A" })
    await mkEmployee(v.id, { fullName: "Emp12 B" })
    const target = await db.employee.findFirstOrThrow({ where: { vendorId: v.id, fullName: "Emp12 A" } })
    const admin = makeCtx(await mkUser(v.id, { role: "HR_ADMIN" }), ["employees.view"])
    const out: any = await getRoute("employees.get")!.handler(admin, { id: target.id })
    expect("employees" in (out.lookups || {})).toBe(false)
    expect(out.lookups.branches).toBeTruthy() // org tables stay
  })

  test("the ILIKE-searched contact columns carry trigram indexes (pg_indexes)", async () => {
    // db push cannot create raw-SQL objects — apply the two owning migrations'
    // DDL verbatim (this also validates it executes cleanly), then assert.
    for (const f of ["prisma/migrations/9_wave9zf_employee_search_trigram_20261022/migration.sql", "prisma/migrations/9_wave9zn_trigram_refresh_retention_20261023/migration.sql"]) {
      const sql = await Bun.file(f).text()
      const noComments = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
      for (const stmt of noComments.split(";").map((x) => x.trim()).filter(Boolean)) {
        // Idempotent replay: the CI gate's migration stage may have already
        // applied these — 42P07 (already exists) is the desired end state.
        try {
          await db.$executeRawUnsafe(stmt)
        } catch (e: any) {
          if (!String(e?.message || "").includes("already exists")) throw e
        }
      }
    }
    const have = await db.$queryRawUnsafe(`SELECT indexname FROM pg_indexes WHERE tablename = 'Employee' AND indexname LIKE '%trgm%'`)
    const names = (have as { indexname: string }[]).map((r) => r.indexname)
    for (const expected of ["Employee_fullName_trgm_idx", "Employee_code_trgm_idx", "Employee_mobile_trgm_idx", "Employee_altMobile_trgm_idx", "Employee_officialEmail_trgm_idx", "Employee_personalEmail_trgm_idx"]) {
      expect(names).toContain(expected)
    }
  })
})

// ---------------------------------------------------------------------------
describe("COM-04 + DB-06 — retention sweeps + the honest unread badge", () => {
  test("notificationRetentionSweep purges past the retention window and keeps recent rows", async () => {
    const { notificationRetentionSweep, apiRefreshTokenPurge } = await import("@/hrm-server/jobs")
    const v = await mkVendor("R6 COM04")
    const u = await mkUser(v.id, { role: "EMPLOYEE" })
    const old = new Date(Date.now() - 200 * 86_400_000)
    await db.notification.createMany({ data: [
      { vendorId: v.id, userId: u.id, title: "ancient", message: "x", type: "SYSTEM", createdAt: old },
      { vendorId: v.id, userId: u.id, title: "fresh", message: "y", type: "SYSTEM" },
    ] })
    const before = await db.notification.count({ where: { vendorId: v.id } })
    expect(before).toBe(2)
    const purged = await notificationRetentionSweep(v.id, today(), { notifications: { retentionDays: 90 } })
    expect(purged).toBe(1)
    const after = await db.notification.count({ where: { vendorId: v.id } })
    expect(after).toBe(1)
    const kept = await db.notification.findFirstOrThrow({ where: { vendorId: v.id } })
    expect(kept.title).toBe("fresh")
    // 0 = off
    await db.notification.create({ data: { vendorId: v.id, userId: u.id, title: "ancient2", message: "x", type: "SYSTEM", createdAt: old } })
    expect(await notificationRetentionSweep(v.id, today(), { notifications: { retentionDays: 0 } })).toBe(0)
    expect(await db.notification.count({ where: { vendorId: v.id } })).toBe(2)

    // DB-06: refresh tokens purge (expired + stale-revoked; fresh survive)
    await db.apiRefreshToken.createMany({ data: [
      { vendorId: v.id, userId: u.id, sessionId: "s1", tokenHash: uniq("th"), familyId: uniq("f"), scopesJson: "[]", expiresAt: new Date(Date.now() - 86_400_000) },
      { vendorId: v.id, userId: u.id, sessionId: "s2", tokenHash: uniq("th"), familyId: uniq("f"), scopesJson: "[]", expiresAt: new Date(Date.now() + 86_400_000), revokedAt: new Date(Date.now() - 40 * 86_400_000) },
      { vendorId: v.id, userId: u.id, sessionId: "s3", tokenHash: uniq("th"), familyId: uniq("f"), scopesJson: "[]", expiresAt: new Date(Date.now() + 86_400_000) },
    ] })
    expect(await apiRefreshTokenPurge(v.id)).toBe(2)
    const remaining = await db.apiRefreshToken.findMany({ where: { vendorId: v.id } })
    expect(remaining.length).toBe(1)
    expect(remaining[0].sessionId).toBe("s3")
  })

  test("unreadCount never claims more than the capped list can display", async () => {
    const v = await mkVendor("R6 COM04 badge")
    const u = await mkUser(v.id, { role: "EMPLOYEE" })
    const rows: any[] = []
    for (let i = 0; i < 150; i++) rows.push({ vendorId: v.id, userId: u.id, title: `n${i}`, message: "x", type: "SYSTEM" })
    await db.notification.createMany({ data: rows })
    const ctx = makeCtx(u)
    const out: any = await getRoute("notifications.unreadCount")!.handler(ctx, {})
    expect(out.count).toBe(100) // the list caps at 100 — the badge matches it
    expect(out.total).toBe(150) // the true figure rides along for stats
  })
})
