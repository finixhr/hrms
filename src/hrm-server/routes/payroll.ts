// ============ Payroll routes (spec §9) — compensation & payroll engine ============
import { db } from "@/lib/db"
import { route } from "./registry"
import { Deny, assertEmployeeVisible, scopedEmployeeWhere , applyEmployeeSearch } from "../rbac"
import { audit, notify } from "../audit"
import { calculateRun, submitRunForApproval, payRun, createAdjustmentRun } from "../payroll"
import { dueInstallmentsFor } from "../loan-math"
import { getSettings } from "../settings"
import { j, monthName, today, withinDuplicateWindow, EMPLOYEE_REF_SELECT } from "../utils"
import { safePayload } from "../security"
import { S, id } from "../validation"
import { z } from "zod"
import { isoDate } from "../utils"
import { structurePaisa } from "../money"
import { callerFieldAccess } from "../field-permissions"

// ---------- Salary structures ----------
route("salaryStructures.list", {
  perm: ["payroll", "view"],
  handler: async (ctx, p) => {
    // PAY-05 (R5) — the list honors the manager's branch/department scope like
    // every sibling list (a BRANCH_MANAGER with payroll.view used to read
    // every salary in the tenant).
    const where: any = { vendorId: ctx.vendorId, ...await scopedEmployeeWhere(ctx, p) }
    if (p?.currentOnly) where.status = "ACTIVE"
    else if (!p?.all) {
      // latest per employee by default handled client-side; return all ordered
    }
    const list = await db.salaryStructure.findMany({ where, orderBy: [{ employeeId: "asc" }, { effectiveFrom: "desc" }] })
    const employees = await db.employee.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, fullName: true, code: true } })
    return list.map((s) => ({
      ...s,
      employeeName: employees.find((e) => e.id === s.employeeId)?.fullName || "—",
      employeeCode: employees.find((e) => e.id === s.employeeId)?.code,
      components: j(s.componentsJson, []),
    }))
  },
})

route("salaryStructures.save", {
  perm: ["payroll", "edit"],
  handler: async (ctx, p) => {
    // FLD-103 (Wave R3-5) — the salary field group's write surface: a role
    // whose field rules hide the salary group (Settings → Field Permissions)
    // cannot rewrite structures even with payroll.edit (field layer can only
    // NARROW what the route permission granted).
    if (callerFieldAccess(await getSettings(ctx.vendorId), ctx.role).salary === "none") {
      throw new Deny("Your role's field permissions do not allow editing salary structures", 403)
    }
    const emp = await assertEmployeeVisible(ctx, p.employeeId)
    const fields = ["basic", "houseRent", "medical", "conveyance", "food", "mobileAllow", "internetAllow", "attendanceAllow", "otherAllowance"]
    const data: any = { employeeId: p.employeeId, effectiveFrom: p.effectiveFrom || today(), createdBy: ctx.userId }
    let gross = 0
    for (const f of fields) {
      const v = Number(p[f] || 0)
      data[f] = v
      gross += v
    }
    const extras = (p.components || []).map((c: any) => ({ label: c.label, amount: Number(c.amount || 0) }))
    gross += extras.reduce((s: number, c: any) => s + c.amount, 0)
    data.gross = Math.round(gross)
    data.componentsJson = JSON.stringify(extras)
    // H-8 — paisa dual-write via the shared helper (this path previously wrote
    // Float-only rows: NULL paisa columns broke the lossless representation)
    Object.assign(data, structurePaisa(data))

    if (p.id) {
      const existing = await db.salaryStructure.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
      if (!existing) throw new Deny("Structure not found", 404)
      if (existing.status === "SUPERSEDED") throw new Deny("Cannot edit a superseded (historical) structure")
      const rec = await db.salaryStructure.update({ where: { id: p.id }, data })
      await audit(ctx, "salaryStructures.update", "SalaryStructure", p.id, `Updated structure for ${emp.fullName} (gross ৳${data.gross})`, { oldValue: existing, newValue: data })
      return rec
    }
    // create new → supersede current (history preserved)
    const current = await db.salaryStructure.findFirst({ where: { employeeId: p.employeeId, status: "ACTIVE" } })
    if (current) {
      const d = new Date(data.effectiveFrom + "T00:00:00")
      d.setDate(d.getDate() - 1)
      await db.salaryStructure.update({ where: { id: current.id }, data: { status: "SUPERSEDED", effectiveTo: d.toISOString().slice(0, 10) } })
    }
    const rec = await db.salaryStructure.create({ data: { ...data, vendorId: ctx.vendorId, status: "ACTIVE" } })
    if (current) {
      await db.salaryRevision.create({
        data: {
          vendorId: ctx.vendorId, employeeId: p.employeeId,
          previousSalary: current.gross, newSalary: data.gross,
          increaseAmount: data.gross - current.gross,
          increasePercent: current.gross > 0 ? Math.round(((data.gross - current.gross) / current.gross) * 1000) / 10 : 0,
          effectiveDate: data.effectiveFrom, reason: "Direct structure edit", type: "STRUCTURE_CHANGE", status: "APPROVED", approvedBy: ctx.userId,
        },
      })
    }
    await audit(ctx, "salaryStructures.create", "SalaryStructure", rec.id, `New structure for ${emp.fullName} (gross ৳${data.gross})`)
    return rec
  },
})

// ---------- Payroll runs ----------
route("payroll.runs.list", {
  perm: ["payroll", "view"],
  handler: async (ctx) => {
    return db.payrollRun.findMany({ where: { vendorId: ctx.vendorId }, orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }] })
  },
})

route("payroll.runs.create", {
  schema: S.payrollCreate,
  perm: ["payroll", "create"],
  handler: async (ctx, p) => {
    const month = Number(p.periodMonth), year = Number(p.periodYear)
    if (!Number.isInteger(month) || month < 1 || month > 12) throw new Deny("Invalid month", 400)
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Deny("Invalid year", 400)
    const periodWeek = p.periodWeek ? Number(p.periodWeek) : 0 // ISO week for WEEKLY frequency runs
    if (!Number.isInteger(periodWeek) || periodWeek < 0 || periodWeek > 53) throw new Deny("Invalid ISO week", 400)
    // PAY-002 (R3-1) — only REGULAR runs are user-creatable. The zod schema
    // (validation.ts payrollCreate) already restricts runType to "REGULAR";
    // this handler guard is the belt-and-braces layer for callers that bypass
    // schema validation. ADJUSTMENT runs are minted exclusively by
    // payroll.adjustmentCreate (which enforces PAID-source + delta semantics);
    // the schema's historical BONUS / FINAL_SETTLEMENT runTypes were never
    // implemented by the calculation engine — the engine pays a full second
    // month for them, so creating one was a double-disbursement primitive.
    // Bonuses ride REGULAR runs (Payroll → Bonuses); final settlements are
    // calculated in Exit Management.
    if (p.runType && p.runType !== "REGULAR") {
      throw new Deny(
        `runType ${p.runType} cannot be created directly — adjustments come from "Create Adjustment Run" on a paid run, bonuses are attached to the regular monthly run, and final settlements are calculated in Exit Management`,
        400,
      )
    }
    // R1 (2026-10-12) — CANCELLED runs no longer occupy the period: a cancelled
    // month's run is tombstoned (negative adjustSeq) out of the DB unique slot
    // at cancel time, so the check below only considers ACTIVE runs. A brand-new
    // REGULAR run (adjustSeq=0) then takes the freed slot cleanly.
    const exists = await db.payrollRun.findFirst({ where: { vendorId: ctx.vendorId, periodMonth: month, periodYear: year, periodWeek, runType: "REGULAR", status: { not: "CANCELLED" } } })
    if (exists) throw new Deny(`A REGULAR run${periodWeek ? ` for week ${periodWeek}` : ""} of ${monthName(month)} ${year} already exists`)
    const settings = await getSettings(ctx.vendorId)
    const cutoff = `${year}-${String(month).padStart(2, "0")}-${String(Math.min(settings.payroll.cutoffDay, 28)).padStart(2, "0")}`
    try {
      const run = await db.payrollRun.create({
        data: { vendorId: ctx.vendorId, periodMonth: month, periodYear: year, periodWeek, frequency: p.frequency || settings.payroll.frequency, runType: "REGULAR", cutoffDate: p.cutoffDate || cutoff, status: "DRAFT", createdBy: ctx.userId },
      })
      await audit(ctx, "payroll.runs.create", "PayrollRun", run.id, `Created run ${monthName(month)} ${year}${periodWeek ? ` week ${periodWeek}` : ""}`)
      return run
    } catch (e: any) {
      // M-22 — a concurrent create wins the unique constraint race: friendly Deny
      if (String(e?.code) === "P2002") {
        throw new Deny(`A REGULAR run${periodWeek ? ` for week ${periodWeek}` : ""} of ${monthName(month)} ${year} was just created by someone else — refresh the list`)
      }
      throw e
    }
  },
})

route("payroll.calculate", {
  perm: ["payroll", "calculate"],
  schema: z.object({
    runId: z.string().min(1),
    excludeEmployeeIds: z.array(z.string().min(1)).max(5000).optional(),
    async: z.boolean().optional(),
  }).strict(),
  handler: async (ctx, p) => {
    // WP-A — async execution for full-vendor runs: the client opts in with
    // async: true and receives { jobId } to poll via jobs.get (progress +
    // retry + cancellation through the Job Center). Default stays synchronous.
    if (p?.async === true) {
      const run = await db.payrollRun.findFirst({ where: { id: p.runId, vendorId: ctx.vendorId } })
      if (!run) throw new Deny("Payroll run not found", 404)
      const employees = await db.employee.count({ where: { vendorId: ctx.vendorId, status: { in: ["ACTIVE", "PROBATION", "ON_LEAVE", "SUSPENDED"] } } })
      const { submitJob } = await import("../jobs")
      const jobId = await submitJob(ctx, "PAYROLL_CALCULATE", { runId: p.runId, excludeEmployeeIds: p.excludeEmployeeIds || [] }, { total: employees, priority: 4 })
      await audit(ctx, "payroll.calculate.async", "PayrollRun", p.runId, `Queued async calculation for ${monthName(run.periodMonth)} ${run.periodYear} (job ${jobId})`)
      return { jobId, async: true }
    }
    return calculateRun(ctx, p.runId, undefined, { excludeEmployeeIds: p.excludeEmployeeIds })
  },
})

route("payroll.submitApproval", {
  schema: S.payrollSubmit,
  perm: ["payroll", "process"],
  handler: async (ctx, p) => submitRunForApproval(ctx, p.runId),
})

// ============ 2026-10-14 — Loan & Advance recovery control ============
// Pre-calculation recovery plan for a period: every due loan installment and
// recovering salary advance, WHO pays it this period (the borrower's own
// salary / the agreed guarantor's salary / deferred — borrower has no payable
// salary and no agreed guarantor), and the exact amounts payroll will deduct
// at final approval. Mirrors calculateRun's guarantor fallback rules so the
// control panel can never disagree with the engine.
route("payroll.recoveryPlan", {
  perm: ["payroll", "view"],
  schema: z.object({
    month: z.number().int().min(1).max(12),
    year: z.number().int().min(2000).max(2100),
  }).strict(),
  handler: async (ctx, p) => {
    const month = p.month, year = p.year
    const monthPrefix = `${year}-${String(month).padStart(2, "0")}`
    const periodStart = `${monthPrefix}-01`
    const periodEnd = isoDate(new Date(year, month, 0))
    const settings = await getSettings(ctx.vendorId)
    const capPct = Math.min(100, Math.max(1, Number(settings.payroll.loanGuarantorMaxPct) || 25))

    const [loans, advances, employees, structures, attendance] = await Promise.all([
      db.loan.findMany({ where: { vendorId: ctx.vendorId, status: "ACTIVE" } }),
      db.advance.findMany({ where: { vendorId: ctx.vendorId, status: "RECOVERING", outstanding: { gt: 0 } } }),
      db.employee.findMany({
        where: { vendorId: ctx.vendorId, status: { in: ["ACTIVE", "PROBATION", "ON_LEAVE", "SUSPENDED"] } },
        select: { id: true, code: true, fullName: true, status: true, joiningDate: true },
      }),
      db.salaryStructure.findMany({
        where: { vendorId: ctx.vendorId, effectiveFrom: { lte: periodEnd }, status: { in: ["ACTIVE", "SUPERSEDED"] } },
        orderBy: { effectiveFrom: "desc" }, select: { employeeId: true, gross: true },
      }),
      db.attendance.findMany({
        where: { vendorId: ctx.vendorId, date: { gte: periodStart, lte: periodEnd } },
        select: { employeeId: true, status: true },
      }),
    ])
    const loanIds = loans.map((l) => l.id)
    const installments = loanIds.length
      ? await db.loanInstallment.findMany({ where: { loanId: { in: loanIds }, status: { in: ["PENDING", "OVERDUE", "PARTIAL"] } }, orderBy: { no: "asc" } })
      : []
    const installmentsOf = (loanId: string) => installments.filter((i) => i.loanId === loanId)

    const empById = new Map(employees.map((e) => [e.id, e]))
    const structureOf = (empId: string) => structures.find((s) => s.employeeId === empId)
    // payable presence this period: PRESENT / LATE / EARLY_LEAVE / WFH /
    // BUSINESS_TRIP / HALF_DAY keep salary flowing; LEAVE is paid leave.
    const presenceOf = (empId: string): { payableDays: number; absentDays: number } => {
      let payableDays = 0, absentDays = 0
      for (const a of attendance) {
        if (a.employeeId !== empId) continue
        if (a.status === "HALF_DAY") { payableDays += 0.5; absentDays += 0.5 }
        else if (["PRESENT", "LATE", "EARLY_LEAVE", "WFH", "BUSINESS_TRIP", "LEAVE"].includes(a.status)) payableDays += 1
        else if (a.status === "ABSENT") absentDays += 1
      }
      return { payableDays, absentDays }
    }
    const inRun = (empId: string): boolean => {
      const e = empById.get(empId)
      if (!e) return false
      if (!e.joiningDate || e.joiningDate > periodEnd) return false
      return !!structureOf(empId)
    }
    // same rule as calculateRun's fallback pass
    const borrowerCannotPay = (empId: string): boolean => {
      if (!inRun(empId)) return true
      if (!settings.payroll.absenceProration) return false
      const { payableDays } = presenceOf(empId)
      return payableDays <= 0
    }

    type PlanRow = {
      kind: "LOAN" | "ADVANCE"; borrowerId: string; borrowerCode?: string; borrowerName: string
      refId: string; installmentNo?: number; dueDate?: string; dueAmount: number
      guarantorId?: string; guarantorName?: string; guarantorConsent?: string | null
      source: "EMPLOYEE" | "GUARANTOR" | "DEFERRED"; plannedAmount: number
      presence: string; note?: string
    }
    const rows: PlanRow[] = []
    // guarantorId -> committed amount (mirrors the engine's cumulative cap)
    const capUsed = new Map<string, number>()

    for (const loan of loans) {
      // PAY-13 — the plan budgets the SAME arrears-aware due the engine's
      // LOA-001 rule budgets (current EMI + up to loanArrearsMax missed EMIs,
      // oldest first), not just the current month's installment — the old
      // current-month-only find understated every plan for a borrower in
      // arrears while the actual run deducted the full catch-up.
      const arrearsMax = Math.max(0, Number((settings.payroll as any).loanArrearsMax) || 0)
      const dueInst = dueInstallmentsFor(installmentsOf(loan.id), monthPrefix, arrearsMax)
      const inst = dueInst.length ? dueInst[0] : undefined
      const borrower = empById.get(loan.employeeId)
      const due = dueInst.length
        ? Math.min(dueInst.reduce((s, i) => s + (i.amount - i.paidAmount), 0), loan.outstanding > 0 ? Infinity : 0)
        : 0
      const base: PlanRow = {
        kind: "LOAN", borrowerId: loan.employeeId, borrowerCode: borrower?.code, borrowerName: borrower?.fullName || "—",
        refId: loan.id, installmentNo: inst?.no, dueDate: inst?.dueDate, dueAmount: Math.round(due),
        guarantorId: loan.guarantorId || undefined,
        guarantorName: loan.guarantorId ? empById.get(loan.guarantorId)?.fullName || "—" : undefined,
        guarantorConsent: loan.guarantorStatus || null,
        source: "EMPLOYEE", plannedAmount: 0, presence: "",
      }
      if (!inst || !(due > 0)) { base.source = "DEFERRED"; base.note = "No installment due this month"; rows.push(base); continue }
      if (!borrowerCannotPay(loan.employeeId)) {
        base.source = "EMPLOYEE"; base.plannedAmount = Math.round(due)
        base.presence = `${presenceOf(loan.employeeId).payableDays} payable day(s)`
        rows.push(base); continue
      }
      const presence = presenceOf(loan.employeeId)
      base.presence = inRun(loan.employeeId) ? `absent the whole period (${presence.absentDays} absent day(s))` : "not in the payroll run"
      if (!settings.payroll.loanGuarantorFallback) { base.source = "DEFERRED"; base.note = "Guarantor fallback disabled (Payroll → Loan & Advance Control)"; rows.push(base); continue }
      if (!loan.guarantorId || loan.guarantorStatus !== "AGREED") { base.source = "DEFERRED"; base.note = loan.guarantorId ? `Guarantor has not consented (${loan.guarantorStatus || "PENDING"})` : "No guarantor named on the loan"; rows.push(base); continue }
      if (!inRun(loan.guarantorId) || borrowerCannotPay(loan.guarantorId)) { base.source = "DEFERRED"; base.note = "Guarantor has no payable salary this period either"; rows.push(base); continue }
      const gStruct = structureOf(loan.guarantorId)
      const capTotal = Math.floor(Math.max(0, (gStruct?.gross || 0) * 0.78) * capPct / 100) // net ≈ 78% of gross after AIT/deductions is unknown pre-calculation — the cap shown is an ESTIMATE on gross
      const cap = Math.max(0, capTotal - (capUsed.get(loan.guarantorId) || 0))
      const move = Math.min(Math.round(due), cap)
      if (move <= 0) { base.source = "DEFERRED"; base.note = `Guarantor cap exhausted (est. ${capPct}% of net)`; rows.push(base); continue }
      capUsed.set(loan.guarantorId, (capUsed.get(loan.guarantorId) || 0) + move)
      base.source = "GUARANTOR"; base.plannedAmount = move
      base.note = move < Math.round(due) ? `Capped at ${capPct}% of the guarantor's net — ৳${(Math.round(due) - move).toLocaleString("en-IN")} deferred` : "Deducts from the guarantor's salary at final approval"
      rows.push(base)
    }

    for (const adv of advances) {
      const per = adv.installments > 0 ? adv.amount / adv.installments : adv.amount
      const recoveryMonth = (adv.recoveryDate || adv.requestDate).slice(0, 7)
      const due = recoveryMonth <= monthPrefix ? Math.min(per, adv.outstanding) : 0
      const borrower = empById.get(adv.employeeId)
      const base: PlanRow = {
        kind: "ADVANCE", borrowerId: adv.employeeId, borrowerCode: borrower?.code, borrowerName: borrower?.fullName || "—",
        refId: adv.id, dueDate: adv.recoveryDate || adv.requestDate, dueAmount: Math.round(due),
        guarantorId: adv.guarantorId || undefined,
        guarantorName: adv.guarantorId ? empById.get(adv.guarantorId)?.fullName || "—" : undefined,
        guarantorConsent: adv.guarantorStatus || null,
        source: "EMPLOYEE", plannedAmount: 0, presence: "",
      }
      if (!(due > 0)) { base.source = "DEFERRED"; base.note = recoveryMonth > monthPrefix ? `Recovery starts ${adv.recoveryDate || adv.requestDate}` : "Fully recovered"; rows.push(base); continue }
      if (!borrowerCannotPay(adv.employeeId)) {
        base.source = "EMPLOYEE"; base.plannedAmount = Math.round(due)
        base.presence = `${presenceOf(adv.employeeId).payableDays} payable day(s)`
        rows.push(base); continue
      }
      base.presence = inRun(adv.employeeId) ? "absent the whole period" : "not in the payroll run"
      if (!settings.payroll.loanGuarantorFallback) { base.source = "DEFERRED"; base.note = "Guarantor fallback disabled (Payroll → Loan & Advance Control)"; rows.push(base); continue }
      if (!adv.guarantorId || adv.guarantorStatus !== "AGREED") { base.source = "DEFERRED"; base.note = adv.guarantorId ? `Guarantor not agreed (${adv.guarantorStatus || "PENDING"})` : "No guarantor designated on the advance"; rows.push(base); continue }
      if (!inRun(adv.guarantorId) || borrowerCannotPay(adv.guarantorId)) { base.source = "DEFERRED"; base.note = "Guarantor has no payable salary this period either"; rows.push(base); continue }
      const gStruct = structureOf(adv.guarantorId)
      const capTotal = Math.floor(Math.max(0, (gStruct?.gross || 0) * 0.78) * capPct / 100)
      const cap = Math.max(0, capTotal - (capUsed.get(adv.guarantorId) || 0))
      const move = Math.min(Math.round(due), cap)
      if (move <= 0) { base.source = "DEFERRED"; base.note = `Guarantor cap exhausted (est. ${capPct}% of net)`; rows.push(base); continue }
      capUsed.set(adv.guarantorId, (capUsed.get(adv.guarantorId) || 0) + move)
      base.source = "GUARANTOR"; base.plannedAmount = move
      base.note = move < Math.round(due) ? `Capped at ${capPct}% of the guarantor's net — ৳${(Math.round(due) - move).toLocaleString("en-IN")} deferred` : "Deducts from the guarantor's salary at final approval"
      rows.push(base)
    }

    // per-guarantor exposure summary (active guarantees, agreed or pending)
    const exposure = new Map<string, { guarantorId: string; guarantorName: string; loans: number; advances: number; outstanding: number }>()
    for (const l of loans) {
      if (!l.guarantorId) continue
      const g = empById.get(l.guarantorId)
      const cur = exposure.get(l.guarantorId) || { guarantorId: l.guarantorId, guarantorName: g?.fullName || "—", loans: 0, advances: 0, outstanding: 0 }
      cur.loans += 1; cur.outstanding += l.outstanding
      exposure.set(l.guarantorId, cur)
    }
    for (const a of advances) {
      if (!a.guarantorId) continue
      const g = empById.get(a.guarantorId)
      const cur = exposure.get(a.guarantorId) || { guarantorId: a.guarantorId, guarantorName: g?.fullName || "—", loans: 0, advances: 0, outstanding: 0 }
      cur.advances += 1; cur.outstanding += a.outstanding
      exposure.set(a.guarantorId, cur)
    }

    return {
      period: { month, year },
      settings: {
        loanDeductionEnabled: settings.payroll.loanDeductionEnabled,
        advanceDeductionEnabled: settings.payroll.advanceDeductionEnabled,
        loanGuarantorFallback: settings.payroll.loanGuarantorFallback,
        loanGuarantorMaxPct: capPct,
      },
      totals: {
        rows: rows.length,
        fromEmployee: rows.filter((r) => r.source === "EMPLOYEE").reduce((s, r) => s + r.plannedAmount, 0),
        fromGuarantor: rows.filter((r) => r.source === "GUARANTOR").reduce((s, r) => s + r.plannedAmount, 0),
        deferred: rows.filter((r) => r.source === "DEFERRED").length,
      },
      rows,
      guarantorExposure: [...exposure.values()].sort((a, b) => b.outstanding - a.outstanding),
    }
  },
})

route("payroll.pay", {
  perm: ["payroll", "pay"],
  handler: async (ctx, p) => {
    // WP-A — async disbursement for full-vendor runs (payRun is idempotent:
    // conditional APPROVED→PROCESSING claim + journal idempotency key).
    if (p?.async === true) {
      const run = await db.payrollRun.findFirst({ where: { id: p.runId, vendorId: ctx.vendorId } })
      if (!run) throw new Deny("Payroll run not found", 404)
      if (run.status !== "APPROVED") throw new Deny("Run must be APPROVED before payment")
      const { submitJob } = await import("../jobs")
      const jobId = await submitJob(ctx, "PAYROLL_PAY", { runId: p.runId }, { total: run.employeeCount || 0, priority: 3 })
      await audit(ctx, "payroll.pay.async", "PayrollRun", p.runId, `Queued async payment for ${monthName(run.periodMonth)} ${run.periodYear} (job ${jobId})`)
      return { jobId, async: true }
    }
    return payRun(ctx, p.runId)
  },
})

route("payroll.adjustmentCreate", {
  perm: ["payroll", "create"],
  handler: async (ctx, p) => {
    const adjId = await createAdjustmentRun(ctx, p.runId)
    return { adjustmentRunId: adjId }
  },
})

route("payroll.entries", {
  perm: ["payroll", "view"],
  handler: async (ctx, p) => {
    const run = await db.payrollRun.findFirst({ where: { id: p.runId, vendorId: ctx.vendorId } })
    if (!run) throw new Deny("Run not found", 404)
    // PAY-05 (R5) — the entry list honors the manager's branch/department
    // scope like every sibling list (the run is tenant-scoped; the manager's
    // rows are their own cohort).
    const scope = await scopedEmployeeWhere(ctx, p)
    const where: any = { runId: p.runId, ...scope }
    // P6 WS-B — server-side search (q matches employee name/code — the run is
    // already tenant-scoped by the runId lookup above)
    await applyEmployeeSearch(ctx.vendorId, where, p?.q)
    // M-11 follow-up (P6 WS-B) — optional MOD-16 pagination (page/pageSize →
    // { run, items, total, page, pageSize }; legacy callers keep the exact
    // full-array contract with `entries`). The old handler shipped EVERY
    // entry of the run (a 10K-employee run = 10K rows with breakdown JSON)
    // and — far worse — ran employees.find() THREE TIMES PER ROW for
    // branch/department/designation names (O(3N) array scans per page).
    const paged = p?.page != null || p?.pageSize != null
    const pageSize = Math.min(500, Math.max(1, Number(p?.pageSize) || 200))
    const page = Math.max(1, Number(p?.page) || 1)
    const [entries, total] = paged
      ? await Promise.all([
          db.payrollEntry.findMany({ where, orderBy: { net: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
          db.payrollEntry.count({ where }),
        ])
      : [await db.payrollEntry.findMany({ where, orderBy: { net: "desc" } }), null]
    // M-11 — reference select: never haul base64 photo columns for a name join.
    // P6 WS-B — decoration from the PAGE's ids via whereIn + Map lookups (was:
    // the FULL tenant directory + three O(N) .find() scans PER ROW).
    const empIds = [...new Set(entries.map((e) => e.employeeId))]
    const [employees, branches, depts, desigs] = await Promise.all([
      empIds.length
        ? db.employee.findMany({ where: { vendorId: ctx.vendorId, id: { in: empIds } }, select: EMPLOYEE_REF_SELECT })
        : Promise.resolve([]),
      db.branch.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } }),
      db.department.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } }),
      db.designation.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } }),
    ])
    const empById = new Map(employees.map((e) => [e.id, e]))
    const branchById = new Map(branches.map((b) => [b.id, b]))
    const deptById = new Map(depts.map((d) => [d.id, d]))
    const desigById = new Map(desigs.map((d) => [d.id, d]))
    const items = entries.map((e) => {
      const bd = j(e.breakdownJson, {} as Record<string, any>)
      const pfDeduction = Number(bd.pf?.employeeAmount) || 0
      const emp = empById.get(e.employeeId)
      return {
        ...e,
        breakdown: bd,
        pfDeduction,
        employeeName: emp?.fullName || "—",
        employeeCode: emp?.code,
        branchName: emp ? branchById.get((emp as any).branchId)?.name : undefined,
        departmentName: emp ? deptById.get((emp as any).departmentId)?.name : undefined,
        designationName: emp ? desigById.get((emp as any).designationId)?.name : undefined,
      }
    })
    if (!paged) return { run, entries: items }
    // P6 WS-B — run-scoped money sums for the KPI strip (set-based, page
    // independent): loan/advance/guarantor recovery from the REAL columns;
    // the PF employee share from the breakdown JSON (it has no dedicated
    // column) in ONE bounded pass over the run
    const [agg, pfRows] = await Promise.all([
      db.payrollEntry.aggregate({
        where: { runId: p.runId },
        _sum: { loanDeduction: true, advanceDeduction: true, guarantorDeduction: true },
      }),
      db.payrollEntry.findMany({ where: { runId: p.runId }, select: { breakdownJson: true } }),
    ])
    let pfTotal = 0
    for (const row of pfRows) {
      const bd = j(row.breakdownJson, {} as Record<string, any>)
      pfTotal += Number(bd.pf?.employeeAmount) || 0
    }
    const summary = {
      loanRecovery: Number(agg._sum.loanDeduction) || 0,
      advanceRecovery: Number(agg._sum.advanceDeduction) || 0,
      guarantorRecovery: Number(agg._sum.guarantorDeduction) || 0,
      pfEmployee: pfTotal,
    }
    return { run, entries: items, items, total, page, pageSize, summary }
  },
})

// ---------- PAYROLL approval finalize hook ----------
export async function applyPayrollDecision(ctx: { userId: string; userName: string; vendorId: string }, runId: string, decision: string) {
  // Audit Low — conditional status guard: an APPROVED run can never be approved
  // twice, and only a run under review may move to APPROVED.
  if (decision === "APPROVED") {
    const claimed = await db.payrollRun.updateMany({
      where: { id: runId, vendorId: ctx.vendorId, status: "HR_REVIEW" },
      data: { status: "APPROVED" },
    })
    if (claimed.count === 0) return // already actioned concurrently — no double effect
    const run = await db.payrollRun.findUnique({ where: { id: runId } })
    await notify(ctx.vendorId, { role: "PAYROLL_OFFICER" }, "Payroll Approved",
      `Payroll ${monthName(run?.periodMonth || 1)} ${run?.periodYear} fully approved — ready for payment.`, "PAYROLL", "payroll")
  } else {
    // H-16 — a rejected run returns to CALCULATED with a CLEAN approval state:
    // the stale approvalRequestId is cleared so a resubmission always creates
    // a fresh approval request instead of pointing at the dead one.
    await db.payrollRun.updateMany({
      where: { id: runId, vendorId: ctx.vendorId, status: { in: ["HR_REVIEW", "APPROVED"] } },
      data: { status: "CALCULATED", approvalRequestId: null },
    })
  }
}

// ---------- Tax rule sets (AIT) ----------
route("taxRules.list", {
  perm: ["ait", "view"],
  handler: async (ctx) => {
    const sets = await db.taxRuleSet.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { createdAt: "desc" } })
    const out: any[] = []
    for (const s of sets) {
      const slabs = await db.taxSlab.findMany({ where: { ruleSetId: s.id }, orderBy: { minIncome: "asc" } })
      out.push({ ...s, slabs })
    }
    return out
  },
})
route("taxRules.save", {
  perm: ["ait", "edit"],
  handler: async (ctx, p) => {
    // H-5 — explicit whitelist; vendorId/id/status are server-controlled
    const data = safePayload<any>(p, ["name", "financialYear", "mode", "taxFreeThreshold", "rebatePercent", "directAmount", "percent", "active"],
      { numericFields: ["taxFreeThreshold", "rebatePercent", "directAmount", "percent"], boolFields: ["active"] })
    if (!data.name || !data.financialYear) throw new Deny("Name and financial year are required")
    if (!["DIRECT", "PERCENT", "SLAB"].includes(data.mode || "")) throw new Deny("Mode must be DIRECT, PERCENT or SLAB")
    const slabs = Array.isArray(p.slabs) ? p.slabs : []
    for (const s of slabs) {
      const min = Number(s.minIncome), rate = Number(s.rate)
      if (!Number.isFinite(min) || min < 0 || !Number.isFinite(rate) || rate < 0 || rate > 100) {
        throw new Deny("Tax slabs must have non-negative min income and a rate between 0 and 100")
      }
    }
    let rec
    if (p.id) {
      const existing = await db.taxRuleSet.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
      if (!existing) throw new Deny("Rule set not found", 404)
      rec = await db.taxRuleSet.update({ where: { id: p.id }, data })
      await db.taxSlab.deleteMany({ where: { ruleSetId: p.id } })
      await audit(ctx, "taxRules.update", "TaxRuleSet", p.id, `Updated tax rule set ${rec.name} (FY ${rec.financialYear}, ${rec.mode})`, { oldValue: existing, newValue: data })
    } else {
      rec = await db.taxRuleSet.create({ data: { ...data, vendorId: ctx.vendorId } })
    }
    for (const s of slabs) {
      await db.taxSlab.create({ data: { vendorId: ctx.vendorId, ruleSetId: rec.id, minIncome: Number(s.minIncome), maxIncome: s.maxIncome ? Number(s.maxIncome) : null, rate: Number(s.rate) } })
    }
    // effective-dated: activating one set deactivates others (new FY must not recalc old payroll — spec §9.5)
    if (rec.active) {
      await db.taxRuleSet.updateMany({ where: { vendorId: ctx.vendorId, id: { not: rec.id } }, data: { active: false } })
    }
    await audit(ctx, "taxRules.save", "TaxRuleSet", rec.id, `Saved tax rule set ${rec.name} (FY ${rec.financialYear}, ${rec.mode})`)
    return rec
  },
})
// R2 (2026-10-12) — the duplicate `ait.preview` registration was REMOVED:
// routes/ait.ts:389 registers the same action with a different permission
// (ait.view) and a different payload contract; because router.ts imports
// ./payroll before ./ait, this stale copy silently overwrote the real one in
// the registry (plain-object later-wins). Legacy payroll callers that still
// send {ruleSetId, monthlyIncome, …} are served by ait.ts's alias shim.

// ---------- Bonuses & commissions ----------
route("bonuses.list", {
  perm: ["bonus", "view"],
  handler: async (ctx, p) => {
    // H-04/H-05 — manager-facing list: scope-limited by default; explicit
    // employeeId must be inside the caller's branch/department scope.
    const where: any = { vendorId: ctx.vendorId, ...await scopedEmployeeWhere(ctx, p) }
    if (p?.status) where.status = p.status
    if (p?.type) where.type = p.type
    const list = await db.bonus.findMany({ where, orderBy: { createdAt: "desc" } })
    const employees = await db.employee.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, fullName: true, code: true } })
    // PAY-006 — bonuses currently awaiting the escalated BONUS workflow
    const escalatedReqs = await db.approvalRequest.findMany({
      where: { vendorId: ctx.vendorId, processType: "BONUS", status: "PENDING" },
      select: { entityId: true },
    })
    const escalatedIds = new Set(escalatedReqs.map((r) => r.entityId))
    return list.map((b) => {
      const emp = employees.find((e) => e.id === b.employeeId)
      return {
        ...b,
        employeeName: emp?.fullName || "—",
        employeeCode: emp?.code || "—",
        escalated: b.status === "PENDING" && escalatedIds.has(b.id),
      }
    })
  },
})
route("bonuses.create", {
  perm: ["bonus", "create"],
  handler: async (ctx, p) => {
    const emp = await assertEmployeeVisible(ctx, p.employeeId)
    let amount = Number(p.amount || 0)
    if (p.calcType === "PERCENT") {
      const base = Number(p.baseAmount || 0)
      amount = Math.round((base * Number(p.percent || 0)) / 100)
    }
    if (!(amount > 0)) throw new Deny("Computed bonus amount must be positive")
    if (p.periodMonth != null && (!Number.isInteger(Number(p.periodMonth)) || Number(p.periodMonth) < 1 || Number(p.periodMonth) > 12)) {
      throw new Deny("Invalid period month")
    }
    // M-14 — double-submit guard for identical pending bonuses (90s window)
    const dup = await db.bonus.findFirst({
      where: { vendorId: ctx.vendorId, employeeId: p.employeeId, type: p.type || "FESTIVAL", amount, periodMonth: p.periodMonth ?? null, periodYear: p.periodYear ?? null, status: "PENDING", createdBy: ctx.userId },
      orderBy: { createdAt: "desc" },
    })
    if (dup && withinDuplicateWindow(dup.createdAt)) {
      throw new Deny("An identical bonus was just created and is pending approval (no duplicate created)", 409)
    }
    const rec = await db.bonus.create({
      data: {
        vendorId: ctx.vendorId, employeeId: p.employeeId, type: p.type || "FESTIVAL",
        calcType: p.calcType || "FIXED", amount, percent: p.percent ?? null, baseAmount: p.baseAmount ?? null,
        formula: p.formula || null, periodMonth: p.periodMonth ? Number(p.periodMonth) : null,
        periodYear: p.periodYear ? Number(p.periodYear) : null, label: p.label || null, status: "PENDING",
        createdBy: ctx.userId, // M-6 — SoD anchor: the creator can never approve
      },
    })
    await audit(ctx, "bonuses.create", "Bonus", rec.id, `${p.type} bonus ৳${amount} for ${emp.fullName}`)
    return rec
  },
})
/** PAY-006 (R3-2) — escalation gate shared by single + bulk approval.
 *  Bonuses at/above Settings → Payroll → Bonus Approval → escalationThreshold
 *  do not flip to APPROVED directly: they ride the BONUS approval workflow
 *  (e.g. HR/Finance review → Owner Approval). Returns true when the request was
 *  submitted. When the threshold is off or no BONUS workflow is configured,
 *  the caller proceeds with direct approval (logged). */
async function escalateBonusApproval(ctx: any, bonus: { id: string; amount: number; type: string; employeeId: string; periodMonth?: number | null; periodYear?: number | null }, settings: { bonusApproval?: { escalationThreshold?: number } }): Promise<boolean> {
  const threshold = Math.max(0, Number(settings.bonusApproval?.escalationThreshold) || 0)
  if (!(threshold > 0) || bonus.amount < threshold) return false
  const inflight = await db.approvalRequest.findFirst({
    where: { vendorId: ctx.vendorId, processType: "BONUS", entityId: bonus.id, status: "PENDING" },
  })
  if (inflight) {
    throw new Deny(`This ৳${bonus.amount} bonus is already awaiting escalated approval — act on it in the Approval Queue`, 409)
  }
  const wf = await db.approvalWorkflow.findFirst({ where: { vendorId: ctx.vendorId, processType: "BONUS", active: true } })
  if (!wf) {
    // no workflow configured → direct approval, but the bypass is on the record
    await audit(ctx, "bonuses.escalationBypass", "Bonus", bonus.id,
      `Bonus ৳${bonus.amount} is ≥ the escalation threshold ৳${threshold} but no BONUS approval workflow is configured — approved directly. Configure one in Settings → Approval Workflows.`)
    return false
  }
  const { submitForApproval } = await import("../approval")
  const approvalId = await submitForApproval(ctx, "BONUS", "Bonus", bonus.id,
    `Bonus ৳${bonus.amount} — ${bonus.type.replace("_", " ").toLowerCase()} (escalated approval)`,
    { employeeId: bonus.employeeId, amount: bonus.amount, bonusId: bonus.id, periodMonth: bonus.periodMonth ?? null, periodYear: bonus.periodYear ?? null })
  await audit(ctx, "bonuses.escalate", "Bonus", bonus.id,
    `Bonus ৳${bonus.amount} ≥ escalation threshold ৳${threshold} — routed through the BONUS approval workflow (request ${approvalId})`)
  return true
}

/** PAY-006 — BONUS workflow finalize hook (registered in routes/hooks.ts):
 *  the owner/finance decision lands back on the Bonus row. */
export async function applyBonusDecision(ctx: { userId: string; userName: string; vendorId: string }, bonusId: string, decision: string) {
  const rec = await db.bonus.findFirst({ where: { id: bonusId, vendorId: ctx.vendorId } })
  if (!rec || rec.status !== "PENDING") return
  if (decision === "APPROVED") {
    const claimed = await db.bonus.updateMany({ where: { id: rec.id, status: "PENDING" }, data: { status: "APPROVED", approvedBy: ctx.userId } })
    if (claimed.count === 1) {
      await audit(ctx as any, "bonuses.escalatedApprove", "Bonus", rec.id, `Escalated approval complete — bonus ৳${rec.amount} approved via the BONUS workflow`)
      await notify(ctx.vendorId, { employeeId: rec.employeeId }, "Bonus Approved",
        `A ${rec.type.replace("_", " ").toLowerCase()} of ৳${rec.amount} has been approved for you.`, "PAYROLL", "ess")
    }
  } else {
    const claimed = await db.bonus.updateMany({ where: { id: rec.id, status: "PENDING" }, data: { status: "REJECTED", approvedBy: ctx.userId } })
    if (claimed.count === 1) {
      await audit(ctx as any, "bonuses.escalatedReject", "Bonus", rec.id, `Escalated approval — bonus ৳${rec.amount} rejected via the BONUS workflow`)
    }
  }
}

route("bonuses.approve", {
  perm: ["bonus", "approve"],
  handler: async (ctx, p) => {
    const rec = await db.bonus.findFirst({ where: { id: p.id, vendorId: ctx.vendorId, status: "PENDING" } })
    if (!rec) throw new Deny("Pending bonus not found", 404)
    // M-6 — separation of duties: the creator can never approve their own discretionary bonus
    // Automated sales commissions (rule engine driven) and bulk batch runs are exempt from creator SoD
    if (rec.type !== "SALES_COMMISSION" && !rec.formula?.startsWith("BATCH:") && rec.createdBy && rec.createdBy === ctx.userId) {
      throw new Deny("You cannot approve a bonus you created (separation of duties)")
    }
    // PAY-006 (R3-2) — large bonuses route through the BONUS approval workflow
    if (p.decision === "APPROVE") {
      const settings = await getSettings(ctx.vendorId)
      if (await escalateBonusApproval(ctx, rec, settings)) {
        return { status: "ESCALATED", message: `Bonus ৳${rec.amount} is at/above the escalation threshold — it now awaits the BONUS approval workflow (see the Approval Queue).` }
      }
    }
    const claimed = await db.bonus.updateMany({
      where: { id: rec.id, status: "PENDING" },
      data: { status: p.decision === "APPROVE" ? "APPROVED" : "REJECTED", approvedBy: ctx.userId },
    })
    if (claimed.count === 0) throw new Deny("Bonus was already actioned — refresh the list")
    await audit(ctx, "bonuses.approve", "Bonus", rec.id, `${p.decision} bonus ৳${rec.amount}`)
    if (p.decision === "APPROVE") {
      await notify(ctx.vendorId, { employeeId: rec.employeeId }, "Bonus Approved",
        `A ${rec.type.replace("_", " ").toLowerCase()} of ৳${rec.amount} has been approved for you.`, "PAYROLL", "ess")
    }
    return { status: p.decision === "APPROVE" ? "APPROVED" : "REJECTED" }
  },
})

// ---------- PAY-006 (R3-2) — bulk approval with TOTAL exposure ----------
// The aggregate BDT + per-type breakdown is computed BEFORE anything is
// actioned and returned with the result, so the typed-confirmation dialog in
// the UI shows the money at stake. Creator rows are skipped (M-6 SoD);
// at/above-threshold rows are escalated to the BONUS workflow instead of
// being approved directly.
const bonusApproveBulkSchema = z.object({
  ids: z.array(id).min(1).max(10000),
  decision: z.enum(["APPROVE", "REJECT"]),
}).strict()

route("bonuses.approveBulk", {
  perm: ["bonus", "approve"],
  schema: bonusApproveBulkSchema,
  handler: async (ctx, p) => {
    const v = p as z.infer<typeof bonusApproveBulkSchema>
    const settings = await getSettings(ctx.vendorId)
    const rows = await db.bonus.findMany({ where: { id: { in: v.ids }, vendorId: ctx.vendorId, status: "PENDING" } })
    if (!rows.length) throw new Deny("No pending bonuses found for this selection", 404)

    // aggregate exposure of the batch (the dialog's number)
    const byType: Record<string, { count: number; sum: number }> = {}
    for (const r of rows) {
      const t = byType[r.type] || (byType[r.type] = { count: 0, sum: 0 })
      t.count++
      t.sum += r.amount
    }
    const total = Math.round(rows.reduce((s, r) => s + r.amount, 0))

    const actioned: string[] = []
    const skipped: { id: string; reason: string }[] = []
    const escalated: { id: string; amount: number }[] = []
    const toUpdate: string[] = []

    for (const rec of rows) {
      // M-6 — separation of duties: creator cannot approve their own discretionary bonus
      // Automated sales commissions (rule engine driven) and bulk batch runs are exempt from creator SoD
      if (rec.type !== "SALES_COMMISSION" && !rec.formula?.startsWith("BATCH:") && rec.createdBy && rec.createdBy === ctx.userId) {
        skipped.push({ id: rec.id, reason: "created by you (separation of duties)" })
        continue
      }
      if (v.decision === "APPROVE") {
        let esc: boolean | null = null
        try {
          esc = await escalateBonusApproval(ctx, rec, settings)
        } catch (e: any) {
          skipped.push({ id: rec.id, reason: String(e?.message || e).slice(0, 140) })
          continue
        }
        if (esc) { escalated.push({ id: rec.id, amount: rec.amount }); continue }
      }
      toUpdate.push(rec.id)
    }

    if (toUpdate.length > 0) {
      await db.bonus.updateMany({
        where: { id: { in: toUpdate }, status: "PENDING" },
        data: { status: v.decision === "APPROVE" ? "APPROVED" : "REJECTED", approvedBy: ctx.userId },
      })
      actioned.push(...toUpdate)
      if (v.decision === "APPROVE") {
        Promise.all(toUpdate.map(async (recId) => {
          const rec = rows.find((r) => r.id === recId)
          if (!rec) return
          await notify(ctx.vendorId, { employeeId: rec.employeeId }, "Bonus Approved",
            `A ${rec.type.replace("_", " ").toLowerCase()} of ৳${rec.amount} has been approved for you.`, "PAYROLL", "ess").catch(() => {})
        })).catch(() => {})
      }
    }

    await audit(ctx, "bonuses.approveBulk", "Bonus", null,
      `Bulk ${v.decision}: ${actioned.length}/${rows.length} bonus(es) actioned — aggregate ৳${total}` +
      (escalated.length ? `; ${escalated.length} escalated to the BONUS workflow` : "") +
      (skipped.length ? `; ${skipped.length} skipped` : ""),
      { newValue: { decision: v.decision, requested: rows.length, actioned: actioned.length, escalated: escalated.length, skipped: skipped.length, total } })
    return {
      decision: v.decision,
      actioned: actioned.length,
      escalated,
      skipped,
      aggregate: { count: rows.length, sum: total, byType },
    }
  },
})

// ---------- 2026-10 §18 — single / all-employees / custom-multiple bonus ----------
// One audited batch route. Per-employee isolation: a skip (duplicate-window
// guard, no salary basis, invisible employee) or an error NEVER aborts the
// batch — the summary reports every outcome. PERCENT mode resolves each
// employee's own ACTIVE salary structure (BASIC or GROSS basis) so the
// computed amount matches the payroll engine's basis, and the per-employee
// base is stored for the audit trail.
route("bonuses.createBulk", {
  perm: ["bonus", "create"],
  handler: async (ctx, p) => {
    const mode = String(p.mode || "SINGLE").toUpperCase()
    if (!["SINGLE", "ALL", "CUSTOM"].includes(mode)) throw new Deny("Invalid bonus mode")
    if (p.calcType !== "FIXED" && p.calcType !== "PERCENT") throw new Deny("Bulk bonuses support FIXED or PERCENT calculation only")
    if (p.periodMonth != null && (!Number.isInteger(Number(p.periodMonth)) || Number(p.periodMonth) < 1 || Number(p.periodMonth) > 12)) {
      throw new Deny("Invalid period month")
    }
    if (p.calcType === "FIXED" && !(Number(p.amount) > 0)) throw new Deny("A positive fixed amount is required")
    if (p.calcType === "PERCENT") {
      if (!(Number(p.percent) > 0)) throw new Deny("A positive percent is required")
      if (!["BASIC", "GROSS", "CUSTOM"].includes(String(p.base || "").toUpperCase())) {
        throw new Deny("Percent bonuses need a base: BASIC salary, GROSS salary or a custom amount")
      }
      if (String(p.base).toUpperCase() === "CUSTOM" && !(Number(p.baseAmount) > 0)) {
        throw new Deny("A positive custom base amount is required")
      }
    }

    // ---- resolve the target employee set (always tenant-scoped; ALL mode
    // additionally honors the caller's branch/department scope) ----
    let targets: { id: string; fullName: string; code: string }[] = []
    if (mode === "SINGLE") {
      const emp = await assertEmployeeVisible(ctx, p.employeeId)
      targets = [emp]
    } else if (mode === "CUSTOM") {
      const ids: string[] = Array.isArray(p.employeeIds) ? p.employeeIds.map(String) : []
      if (ids.length === 0) throw new Deny("Select at least one employee")
      // scope-check every requested employee (assertEmployeeVisible per row)
      const emps = await db.employee.findMany({ where: { vendorId: ctx.vendorId, id: { in: ids } } })
      const byId = new Map(emps.map((e: any) => [e.id, e]))
      for (const id of ids) {
        const emp = byId.get(id)
        if (!emp) throw new Deny(`Employee ${id} not found in your organization`, 404)
        await assertEmployeeVisible(ctx, id) // M-11 scope, not just tenant
        targets.push(emp)
      }
    } else {
      // ALL — every ACTIVE / PROBATION employee inside the caller's scope
      const scope = await scopedEmployeeWhere(ctx, {})
      const emps = await db.employee.findMany({
        where: { vendorId: ctx.vendorId, ...scope, status: { in: ["ACTIVE", "PROBATION"] } },
        select: { id: true, fullName: true, code: true },
      })
      targets = emps
    }
    if (targets.length === 0) throw new Deny("No eligible employees found for this bonus")

    // ---- resolve per-employee amounts ----
    let structures: any[] = []
    if (p.calcType === "PERCENT" && String(p.base).toUpperCase() !== "CUSTOM") {
      structures = await db.salaryStructure.findMany({
        where: { vendorId: ctx.vendorId, employeeId: { in: targets.map((t) => t.id) }, status: "ACTIVE" },
      })
    }
    const byEmp = new Map<string, any>()
    for (const s of structures) {
      const prev = byEmp.get(s.employeeId)
      if (!prev || s.effectiveFrom > prev.effectiveFrom) byEmp.set(s.employeeId, s)
    }

    const percent = Number(p.percent || 0)
    const baseKind = String(p.base || "").toUpperCase()
    const batchId = "bb_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7)
    const results: { employeeId: string; employeeName: string; status: "CREATED" | "SKIPPED" | "ERROR"; amount?: number; detail: string }[] = []
    let created = 0
    for (const emp of targets) {
      try {
        let amount = 0
        let perBase: number | null = null
        if (p.calcType === "FIXED") {
          amount = Math.round(Number(p.amount))
        } else if (baseKind === "CUSTOM") {
          perBase = Math.round(Number(p.baseAmount))
          amount = Math.round((perBase * percent) / 100)
        } else {
          const st = byEmp.get(emp.id)
          if (!st) {
            results.push({ employeeId: emp.id, employeeName: emp.fullName, status: "SKIPPED", detail: "no active salary structure to compute the percent from" })
            continue
          }
          perBase = baseKind === "BASIC" ? Number(st.basic || 0) : Number(st.gross || 0)
          if (!(perBase > 0)) {
            results.push({ employeeId: emp.id, employeeName: emp.fullName, status: "SKIPPED", detail: `active structure has no ${baseKind.toLowerCase()} salary to compute from` })
            continue
          }
          amount = Math.round((perBase * percent) / 100)
        }
        if (!(amount > 0)) {
          results.push({ employeeId: emp.id, employeeName: emp.fullName, status: "SKIPPED", detail: "computed bonus amount is not positive" })
          continue
        }
        // same 90s duplicate-window guard as the single-employee create
        const dup = await db.bonus.findFirst({
          where: { vendorId: ctx.vendorId, employeeId: emp.id, type: p.type || "FESTIVAL", amount, periodMonth: p.periodMonth ?? null, periodYear: p.periodYear ?? null, status: "PENDING", createdBy: ctx.userId },
          orderBy: { createdAt: "desc" },
        })
        if (dup && withinDuplicateWindow(dup.createdAt)) {
          results.push({ employeeId: emp.id, employeeName: emp.fullName, status: "SKIPPED", amount, detail: "an identical bonus is already pending approval (no duplicate created)" })
          continue
        }
        const rec = await db.bonus.create({
          data: {
            vendorId: ctx.vendorId, employeeId: emp.id, type: p.type || "FESTIVAL",
            calcType: p.calcType, amount,
            percent: p.calcType === "PERCENT" ? percent : null,
            baseAmount: perBase ?? (p.calcType === "FIXED" ? null : p.baseAmount ?? null),
            formula: `BATCH:${batchId}`,
            periodMonth: p.periodMonth ? Number(p.periodMonth) : null,
            periodYear: p.periodYear ? Number(p.periodYear) : null,
            label: p.label || null, status: "PENDING",
            createdBy: ctx.userId, // M-6 SoD anchor — creator can never approve
          },
        })
        results.push({ employeeId: emp.id, employeeName: emp.fullName, status: "CREATED", amount, detail: `৳${amount}${perBase ? ` (${percent}% of ${baseKind === "CUSTOM" ? "custom" : baseKind.toLowerCase()} ৳${perBase})` : ""} — ${rec.id.slice(0, 8)}` })
        created++
      } catch (err: any) {
        results.push({ employeeId: emp.id, employeeName: emp.fullName, status: "ERROR", detail: String(err?.message || err).slice(0, 160) })
      }
    }
    await audit(ctx, "bonuses.createBulk", "Bonus", null,
      `Bulk bonus (${mode.toLowerCase()}): ${created}/${targets.length} created — ${p.calcType === "PERCENT" ? `PERCENT ${percent}% of ${baseKind.toLowerCase()}` : `FIXED ৳${Number(p.amount)}`}${p.label ? ` (${p.label})` : ""}`,
      { newValue: { mode, type: p.type, calcType: p.calcType, percent, base: baseKind, amount: Number(p.amount || 0), label: p.label || null, requested: targets.length, created, skipped: results.filter((r) => r.status === "SKIPPED").length, errors: results.filter((r) => r.status === "ERROR").length } })
    return {
      mode, requested: targets.length, created,
      skipped: results.filter((r) => r.status === "SKIPPED").length,
      errors: results.filter((r) => r.status === "ERROR").length,
      batchId,
      results,
    }
  },
})

// ---------- Other deductions ----------
route("deductions.list", {
  perm: ["payroll", "view"],
  handler: async (ctx, p) => {
    const where: any = { vendorId: ctx.vendorId, ...await scopedEmployeeWhere(ctx, p) }
    const list = await db.deduction.findMany({ where, orderBy: { createdAt: "desc" } })
    const employees = await db.employee.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, fullName: true } })
    return list.map((d) => ({ ...d, employeeName: employees.find((e) => e.id === d.employeeId)?.fullName || "—" }))
  },
})
route("deductions.save", {
  perm: ["payroll", "edit"],
  handler: async (ctx, p) => {
    const emp = await assertEmployeeVisible(ctx, p.employeeId)
    // H-5 — explicit whitelist; vendorId/employeeId/status are server-controlled
    const data = safePayload<any>(p, ["type", "label", "amount", "month", "year", "recurring"],
      { numericFields: ["amount", "month", "year"], boolFields: ["recurring"] })
    // M-5 — payroll arithmetic never accepts NaN/negative amounts
    if (!data.label) throw new Deny("A deduction label is required")
    if (!(data.amount > 0)) throw new Deny("Deduction amount must be a positive number")
    if (!Number.isInteger(data.month) || data.month < 1 || data.month > 12) throw new Deny("Invalid month")
    if (!Number.isInteger(data.year) || data.year < 2000 || data.year > 2100) throw new Deny("Invalid year")
    if (!data.type) data.type = "OTHER"
    if (p.id) {
      const existing = await db.deduction.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
      if (!existing) throw new Deny("Not found", 404)
      if (existing.status === "PAID") throw new Deny("Cannot edit a paid deduction")
      if (data.employeeId && data.employeeId !== existing.employeeId) throw new Deny("A deduction cannot be reassigned to another employee")
      const rec = await db.deduction.update({ where: { id: p.id }, data })
      await audit(ctx, "deductions.update", "Deduction", p.id, `Updated deduction for ${emp.fullName}`, { oldValue: existing, newValue: data })
      return rec
    }
    const rec = await db.deduction.create({ data: { ...data, vendorId: ctx.vendorId, employeeId: p.employeeId, status: "ACTIVE" } })
    await audit(ctx, "deductions.create", "Deduction", rec.id, `Deduction ${data.label} ৳${data.amount} for ${emp.fullName}`)
    return rec
  },
})
route("deductions.delete", {
  perm: ["payroll", "edit"],
  handler: async (ctx, p) => {
    const rec = await db.deduction.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!rec) throw new Deny("Not found", 404)
    if (rec.status === "PAID") throw new Deny("Cannot delete a paid deduction")
    await db.deduction.delete({ where: { id: p.id } })
    await audit(ctx, "deductions.delete", "Deduction", p.id, `Deleted deduction ${rec.label}`)
    return { deleted: true }
  },
})

// ---------- Payslips ----------
route("payslips.list", {
  perm: ["payslip", "view"],
  handler: async (ctx, p) => {
    // H-04/H-05 — manager-facing list: scope-limited by default; explicit
    // employeeId must be inside the caller's branch/department scope.
    const where: any = { vendorId: ctx.vendorId, ...await scopedEmployeeWhere(ctx, p) }
    if (p?.runId) where.runId = p.runId
    // PAY-08 (R6) — optional MOD-16 pagination (page/pageSize → { items, total,
    // page, pageSize }; legacy callers keep the full-array contract). The old
    // handler shipped the tenant's ENTIRE payslip history + the FULL employee
    // directory + ALL runs on every tab visit (multi-MB payloads at 500
    // employees); decoration is now scoped to the PAGE's ids via whereIn.
    const paged = p?.page != null || p?.pageSize != null
    const pageSize = Math.min(500, Math.max(1, Number(p?.pageSize) || 200))
    const page = Math.max(1, Number(p?.page) || 1)
    const [entries, total] = paged
      ? await Promise.all([
          db.payrollEntry.findMany({
            where: { ...where, payslipNumber: { not: null } }, orderBy: { payslipNumber: "desc" },
            skip: (page - 1) * pageSize, take: pageSize,
          }),
          db.payrollEntry.count({ where: { ...where, payslipNumber: { not: null } } }),
        ])
      : [await db.payrollEntry.findMany({
          where: { ...where, payslipNumber: { not: null } }, orderBy: { payslipNumber: "desc" },
          take: 1000,
        }), null]
    // M-11 — reference select: never haul base64 photo columns for a name join
    const empIds = [...new Set(entries.map((e) => e.employeeId))]
    const [employees, runs] = await Promise.all([
      empIds.length
        ? db.employee.findMany({ where: { vendorId: ctx.vendorId, id: { in: empIds } }, select: EMPLOYEE_REF_SELECT })
        : Promise.resolve([]),
      entries.length
        ? db.payrollRun.findMany({ where: { vendorId: ctx.vendorId, id: { in: [...new Set(entries.map((e) => e.runId))] } } })
        : Promise.resolve([]),
    ])
    const items = entries.map((e) => {
      const emp = employees.find((x) => x.id === e.employeeId)
      const r = runs.find((r) => r.id === e.runId)
      return {
        id: e.id, payslipNumber: e.payslipNumber, employeeId: e.employeeId,
        employeeName: emp?.fullName || "—",
        employeeCode: emp?.code,
        runId: e.runId,
        period: r ? `${monthName(r.periodMonth)} ${r.periodYear}` : "—",
        status: r?.status,
        gross: e.gross, net: e.net, ait: e.ait, otAmount: e.otAmount, bonus: e.bonus,
      }
    })
    if (!paged) return items
    return { items, total, page, pageSize }
  },
})

route("payslips.html", {
  perm: ["payslip", "download"],
  handler: async (ctx, p) => {
    const entry = await db.payrollEntry.findFirst({ where: { id: p.entryId, vendorId: ctx.vendorId } })
    if (!entry || !entry.payslipNumber) throw new Deny("Payslip not found", 404)
    // PAY-012 (R3-2) — tenant check only, no employee-visibility scope: a
    // scoped manager (or a mis-permissioned role) could fetch ANY employee's
    // payslip by id. ESS self-service uses the separate self-scoped route.
    await assertEmployeeVisible(ctx, entry.employeeId)
    const { buildPayslipHtml } = await import("../payslip")
    const html = await buildPayslipHtml(ctx.vendorId, entry.id)
    if (!html) throw new Deny("Payslip not found", 404)
    await audit(ctx, "payslips.download", "PayrollEntry", entry.id, `Downloaded payslip ${entry.payslipNumber}`)
    return { html }
  },
})

route("payslips.email", {
  // Email one payslip to the employee (spec §9.7 Email output)
  perm: ["payslip", "download"],
  handler: async (ctx, p) => {
    const entry = await db.payrollEntry.findFirst({ where: { id: p.entryId, vendorId: ctx.vendorId, payslipNumber: { not: null } } })
    if (!entry) throw new Deny("Payslip not found", 404)
    // PAY-012 — payslips.email enforced tenant but not employee-visibility
    await assertEmployeeVisible(ctx, entry.employeeId)
    const { emailPayslip } = await import("../delivery")
    const res = await emailPayslip(ctx.vendorId, entry.id, { force: true })
    await audit(ctx, "payslips.email", "PayrollEntry", entry.id, `Emailed payslip ${entry.payslipNumber}: ${res.status}${res.detail ? ` (${res.detail})` : ""}`)
    return res
  },
})

route("payslips.emailAll", {
  // Email every payslip of a PAID run (spec §9.7 bulk Email output)
  perm: ["payslip", "download"],
  handler: async (ctx, p) => {
    const run = await db.payrollRun.findFirst({ where: { id: p.runId, vendorId: ctx.vendorId, status: "PAID" } })
    if (!run) throw new Deny("Paid run not found", 404)
    const entries = await db.payrollEntry.findMany({ where: { runId: run.id, payslipNumber: { not: null } }, select: { id: true } })
    // M-04/M-05 — bulk payslip email is a BACKGROUND JOB: the request returns
    // a jobId immediately; per-entry gateway calls stream progress via jobs.get
    const { submitJob } = await import("../jobs")
    const jobId = await submitJob(ctx, "PAYSLIP_EMAIL_ALL", { runId: run.id }, entries.length)
    return { jobId, runId: run.id, total: entries.length, status: "QUEUED" }
  },
})

// ================= WP-G (2026-10-08) — Payroll Preflight =================
// Preview BEFORE generation: per-employee classification composed from the
// existing §78 foundation (resolveSalaryPayout + validatePayout) and the
// exact inclusion rules calculateRun applies. Defense in depth: preflight can
// never mark READY something generate/pay would block — the classifications
// mirror the generate-time exclusions (status/joining/structure) and the
// pay-time payout validation (validatePayout errors).
route("payroll.preflight", {
  perm: ["payroll", "view"],
  schema: z.object({
    periodMonth: z.number().int().min(1).max(12),
    periodYear: z.number().int().min(2000).max(2100),
    periodWeek: z.number().int().min(0).max(53).optional(),
    frequency: z.enum(["MONTHLY", "WEEKLY"]).optional(),
  }).strict(),
  handler: async (ctx, p) => {
    const month = p.periodMonth, year = p.periodYear, week = p.periodWeek || 0
    const periodEnd = isoDate(new Date(year, month, 0))
    const isWeekly = week > 0 || p.frequency === "WEEKLY"

    // Same payable-status set as calculateRun — anything outside it is BLOCKED
    const PAYABLE = ["ACTIVE", "PROBATION", "ON_LEAVE", "SUSPENDED"]
    const [employees, structures, settingsRaw] = await Promise.all([
      db.employee.findMany({
        where: { vendorId: ctx.vendorId, status: { notIn: ["DUMMY"] } },
        select: { id: true, code: true, fullName: true, status: true, joiningDate: true, branchId: true, designationId: true, weeklyOff: true, shiftId: true, salaryPayoutMethod: true, salaryPayoutAccountId: true, taxTin: true, taxCategory: true },
      }),
      db.salaryStructure.findMany({
        where: { vendorId: ctx.vendorId, effectiveFrom: { lte: periodEnd }, status: { in: ["ACTIVE", "SUPERSEDED"] } },
        orderBy: { effectiveFrom: "desc" },
        select: { employeeId: true, gross: true, status: true, effectiveFrom: true },
      }),
      getSettings(ctx.vendorId),
    ])
    const structureOf = (empId: string) => structures.find((s) => s.employeeId === empId)
    const { payoutSettings, resolveSalaryPayout, validatePayout } = await import("../payout")
    const pSettings = payoutSettings(settingsRaw)

    // tax-profile documents (NID presence check)
    const nidDocs = await db.employeeDocument.findMany({
      where: { vendorId: ctx.vendorId, docType: "NID" },
      select: { employeeId: true },
    })
    const hasNid = new Set(nidDocs.map((d) => d.employeeId))

    type Row = {
      employeeId: string; code: string; name: string; branchId: string | null; designationId: string | null
      classification: "READY" | "WARNING" | "BLOCKED"
      reasons: string[]; warnings: string[]
    }
    const rows: Row[] = []
    for (const e of employees) {
      const reasons: string[] = [] // BLOCKED reasons
      const warnings: string[] = [] // WARNING reasons

      // ---- BLOCKED: exact generate/pay blockers ----
      if (!PAYABLE.includes(e.status)) reasons.push(`Employee status is ${e.status} — not in the payroll set (active/probation/on-leave/suspended)`)
      if (!e.joiningDate) reasons.push("Joining date is missing on the employee record")
      else if (e.joiningDate > periodEnd) reasons.push(`Joins ${e.joiningDate}, after the period ends ${periodEnd}`)
      const structure = structureOf(e.id)
      if (!structure) reasons.push("No active salary structure effective for this period")
      else {
        // pay-time payout validation (payRun blocks the whole payment on the
        // first violation — surface it per employee HERE instead)
        const payout = await resolveSalaryPayout(e.id)
        const basis = pSettings.thresholdBasis === "NET" ? structure.gross : structure.gross
        const v = validatePayout(payout, basis, pSettings)
        if (!v.ok) reasons.push(...v.reasons.map((r) => `Payout: ${r}`))
        else warnings.push(...v.warnings.map((w) => `Payout: ${w}`))
      }

      // ---- WARNING: included but worth fixing before generation ----
      if (!e.taxTin) warnings.push("No e-TIN on file (AIT computation falls back to the general profile)")
      if (!e.taxCategory) warnings.push("No taxpayer category set (general thresholds are used)")
      if (!hasNid.has(e.id)) warnings.push("No NID document uploaded")
      if (!e.designationId) warnings.push("No designation assigned")
      if (!e.branchId) warnings.push("No branch assigned")

      // incomplete attendance for a CLOSED period (past periods only — a
      // future/current period legitimately has no punches yet)
      if (e.joiningDate && e.joiningDate <= periodEnd && periodEnd < today()) {
        const att = await db.attendance.count({ where: { vendorId: ctx.vendorId, employeeId: e.id, date: { gte: `${year}-${String(month).padStart(2, "0")}-01`, lte: periodEnd } } })
        if (att === 0) warnings.push(`No attendance records found for ${year}-${String(month).padStart(2, "0")} — payroll will count every working day as absent`)
      }

      const classification: Row["classification"] = reasons.length ? "BLOCKED" : warnings.length ? "WARNING" : "READY"
      rows.push({ employeeId: e.id, code: e.code, name: e.fullName, branchId: e.branchId, designationId: e.designationId, classification, reasons, warnings })
    }

    const counts = {
      total: rows.length,
      ready: rows.filter((r) => r.classification === "READY").length,
      warning: rows.filter((r) => r.classification === "WARNING").length,
      blocked: rows.filter((r) => r.classification === "BLOCKED").length,
    }

    // ---- PAY-005 (R3-2) — bonus & commission exposure riding the period ----
    // The operator sees BEFORE generating: how much APPROVED bonus/commission
    // money the run will include (by type), which PENDING bonuses will be
    // MISSED (the engine includes APPROVED only), festival bonuses already
    // paid this fiscal year, and the exposure ratio against the payroll
    // baseline (warn past Settings → Payroll → Bonus Approval → exposure %).
    const periodBonuses = await db.bonus.findMany({
      where: { vendorId: ctx.vendorId, periodMonth: month, periodYear: year, status: { in: ["PENDING", "APPROVED", "IN_PAYROLL"] } },
    })
    const nameOf = (id: string) => employees.find((e) => e.id === id)?.fullName || "—"
    const approvedBonuses = periodBonuses.filter((b) => b.status === "APPROVED" || b.status === "IN_PAYROLL")
    const pendingBonusRows = periodBonuses.filter((b) => b.status === "PENDING")
    const approvedByType: Record<string, { count: number; sum: number }> = {}
    for (const b of approvedBonuses) {
      const t = approvedByType[b.type] || (approvedByType[b.type] = { count: 0, sum: 0 })
      t.count++
      t.sum += b.amount
    }
    const commissionTotal = (approvedByType.SALES_COMMISSION?.sum || 0) + (approvedByType.TARGET?.sum || 0)
    // festival bonuses already PAID this fiscal year (1 Jul – 30 Jun window
    // containing the period) — the double-festival guard
    const fyStartYear = month >= 7 ? year : year - 1
    const fyEndYear = month >= 7 ? year + 1 : year
    const festivalPaidRows = await db.bonus.findMany({
      where: {
        vendorId: ctx.vendorId, type: "FESTIVAL", status: "PAID",
        OR: [
          { periodYear: fyStartYear, periodMonth: { gte: 7 } },
          { periodYear: fyEndYear, periodMonth: { lte: 6 } },
        ],
      },
      select: { employeeId: true, amount: true },
    })
    const festivalByEmp = new Map<string, number>()
    for (const f of festivalPaidRows) festivalByEmp.set(f.employeeId, (festivalByEmp.get(f.employeeId) || 0) + f.amount)
    // payroll baseline: latest structure gross of the non-blocked employees
    let payrollGross = 0
    for (const r of rows) {
      if (r.classification === "BLOCKED") continue
      payrollGross += structureOf(r.employeeId)?.gross || 0
    }
    const approvedSum = Math.round(approvedBonuses.reduce((s, b) => s + b.amount, 0))
    const exposurePct = payrollGross > 0 ? Math.round((approvedSum / payrollGross) * 1000) / 10 : null
    const warnPct = Math.max(0, Number(settingsRaw.bonusApproval?.exposureWarnPct) || 0)
    const bonusExposure = {
      approved: { count: approvedBonuses.length, sum: approvedSum, byType: approvedByType },
      pending: {
        count: pendingBonusRows.length,
        sum: Math.round(pendingBonusRows.reduce((s, b) => s + b.amount, 0)),
        items: pendingBonusRows.slice(0, 10).map((b) => ({
          employeeName: nameOf(b.employeeId), type: b.type, amount: b.amount,
          label: b.label || null, periodMonth: b.periodMonth, periodYear: b.periodYear,
        })),
      },
      commissionTotal: Math.round(commissionTotal),
      festivalPaidThisFy: [...festivalByEmp.entries()].map(([employeeId, sum]) => ({
        employeeId, employeeName: nameOf(employeeId), sum: Math.round(sum),
      })),
      payrollGross: Math.round(payrollGross),
      exposurePct,
      exposureWarning: warnPct > 0 && exposurePct != null && exposurePct > warnPct,
      exposureWarnPct: warnPct,
    }

    return {
      period: { month, year, week, frequency: isWeekly ? "WEEKLY" : "MONTHLY" },
      counts,
      ready: rows.filter((r) => r.classification === "READY"),
      warning: rows.filter((r) => r.classification === "WARNING"),
      blocked: rows.filter((r) => r.classification === "BLOCKED"),
      bonusExposure,
    }
  },
})
