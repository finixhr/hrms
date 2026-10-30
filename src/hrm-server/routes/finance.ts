// ============ Financial HR routes (spec §10): Loans, Advances, Expenses ============
// All connected to accounting journals and payroll deduction.
import { db } from "@/lib/db"
import { route } from "./registry"
import { Deny, assertEmployeeVisible, scopedEmployeeWhere, applyEmployeeSearch } from "../rbac"
import { audit, notify } from "../audit"
import { notifyChannels } from "../delivery"
import { postJournal } from "../accounting"
import { addMonthsIso, today, withinDuplicateWindow } from "../utils"
import { getSettings } from "../settings"
import { S } from "../validation"
import { requireFeature } from "../saas/entitlements"

// ================= LOANS =================
route("loans.list", {
  perm: ["loans", "view"],
  handler: async (ctx, p) => {
    // H-04/H-05 — manager-facing list: scope-limited by default; explicit
    // employeeId must be inside the caller's branch/department scope.
    // P6 WS-B — the scope-only where feeds the paged `summary` block (the KPI
    // strip shows the caller's cohort truth, independent of table filters).
    const scopeWhere: any = { vendorId: ctx.vendorId, ...await scopedEmployeeWhere(ctx, p) }
    const where: any = { ...scopeWhere }
    if (p?.status) where.status = p.status
    // P6 WS-B — server-side search (q matches employee name/code, intersected
    // with the caller's scope — the SCL-10 discipline)
    await applyEmployeeSearch(ctx.vendorId, where, p?.q)
    // M-11 follow-up (P6 WS-B) — optional server-side pagination (the MOD-16
    // contract): paged callers (page/pageSize) get { items, total, page,
    // pageSize, summary } bounded at 500; legacy callers keep the full-array
    // contract. The old handler shipped the tenant's ENTIRE loan book, joined
    // the FULL employee directory per request, and ran one installments query
    // PER LOAN (N+1) — at 10K loans that was 10K round-trips before the first
    // render.
    const paged = p?.page != null || p?.pageSize != null
    const pageSize = Math.min(500, Math.max(1, Number(p?.pageSize) || 200))
    const page = Math.max(1, Number(p?.page) || 1)
    const [loans, total, byStatus] = paged
      ? await Promise.all([
          db.loan.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: (page - 1) * pageSize, take: pageSize }),
          db.loan.count({ where }),
          db.loan.groupBy({ by: ["status"], where: scopeWhere, _count: { _all: true }, _sum: { outstanding: true } }),
        ])
      : [await db.loan.findMany({ where, orderBy: { createdAt: "desc" } }), null, null]
    // decoration from the PAGE's ids via ONE whereIn (was: the whole tenant
    // directory per request); installments batched per page (was: N+1)
    const empIds = [...new Set(loans.flatMap((l) => [l.employeeId, l.guarantorId].filter((x): x is string => !!x)))]
    const employees = empIds.length
      ? await db.employee.findMany({ where: { vendorId: ctx.vendorId, id: { in: empIds } }, select: { id: true, fullName: true, code: true } })
      : []
    const loanIds = loans.map((l) => l.id)
    const installments = loanIds.length
      ? await db.loanInstallment.findMany({ where: { loanId: { in: loanIds } }, orderBy: { no: "asc" } })
      : []
    const empById = new Map(employees.map((e) => [e.id, e]))
    const installmentsByLoan = new Map<string, typeof installments>()
    for (const i of installments) {
      const list = installmentsByLoan.get(i.loanId) || []
      list.push(i)
      installmentsByLoan.set(i.loanId, list)
    }
    const items = loans.map((l) => {
      const plan = installmentsByLoan.get(l.id) || []
      return {
        ...l,
        employeeName: empById.get(l.employeeId)?.fullName || "—",
        employeeCode: empById.get(l.employeeId)?.code,
        guarantorName: l.guarantorId ? empById.get(l.guarantorId)?.fullName || "—" : null,
        installments: plan,
        nextDue: plan.find((i) => i.status !== "PAID")?.dueDate || null,
      }
    })
    if (!paged) return items
    // summary — the KPI strip's cohort truth from ONE grouped query (status
    // mix + the ACTIVE outstanding sum), fleet-size independent
    const statusCount = new Map((byStatus || []).map((g) => [g.status, g._count._all]))
    const summary = {
      total: [...statusCount.values()].reduce((s, n) => s + n, 0),
      active: statusCount.get("ACTIVE") || 0,
      pending: statusCount.get("PENDING") || 0,
      closed: statusCount.get("CLOSED") || 0,
      outstandingActive: Number((byStatus || []).find((g) => g.status === "ACTIVE")?._sum.outstanding) || 0,
    }
    return { items, total, page, pageSize, summary }
  },
})

/** Resolve the loan requester: ESS submits carry no employeeId — the logged-in
 *  employee profile is the requester (works for every role with a linked profile). */
function resolveRequester(ctx: any, p: any): string {
  const employeeId = p.employeeId || ctx.employeeId
  if (!employeeId) {
    throw new Deny("No employee profile is linked to your account — link one or select the employee", 400)
  }
  if (ctx.role === "EMPLOYEE" && p.employeeId && p.employeeId !== ctx.employeeId) {
    throw new Deny("You can only submit requests for yourself")
  }
  return employeeId
}

/** L-7 — paisa-exact loan installment plan.
 *  The old code stored `installmentAmount = ceil(principal / n)` and derived
 *  the final row as `principal − installmentAmount × (n−1)`, which can produce
 *  a ZERO (৳0.04 over 3 → 0.02/0.02/0.00) or even NEGATIVE (৳0.01 over 3)
 *  final installment. The plan instead distributes the paisa total evenly:
 *  the first `remainder` installments carry one extra paisa, every amount is
 *  ≥ ৳0.01, and the amounts sum to EXACTLY the principal (H-8 paisa
 *  discipline — no float drift between rows). */
export function planInstallments(principal: number, installments: number):
  { ok: true; amounts: number[] } | { ok: false; maxInstallments: number } {
  const totalPaisa = Math.round((Number(principal) || 0) * 100)
  const n = Math.floor(Number(installments) || 0)
  if (!(totalPaisa > 0) || !(n >= 1)) return { ok: false, maxInstallments: 0 }
  if (n > totalPaisa) return { ok: false, maxInstallments: totalPaisa } // each row needs ≥ 1 paisa
  const base = Math.floor(totalPaisa / n)
  const rem = totalPaisa - base * n
  const amounts: number[] = []
  for (let i = 1; i <= n; i++) {
    const paisa = i <= rem ? base + 1 : base
    amounts.push(paisa / 100)
  }
  // exactness guard — the sum must equal the principal to the paisa
  const sum = Math.round(amounts.reduce((s, a) => s + Math.round(a * 100), 0))
  if (sum !== totalPaisa) return { ok: false, maxInstallments: totalPaisa }
  return { ok: true, amounts }
}

/** Calculate completed service months from joining date or creation date */
export function calculateServiceMonths(joiningDateStr?: string | null, fallbackDate?: Date | null): number {
  const start = joiningDateStr ? new Date(joiningDateStr) : (fallbackDate ? new Date(fallbackDate) : null)
  if (!start || isNaN(start.getTime())) return 0
  const now = new Date()
  const years = now.getFullYear() - start.getFullYear()
  const months = now.getMonth() - start.getMonth()
  const total = years * 12 + months
  return Math.max(0, total)
}

/** Calculate employee's historical loan & advance payout/repayment ratio */
export async function calculateEmployeePayoutRatio(vendorId: string, employeeId: string): Promise<{
  payoutRatio: number
  totalDue: number
  totalPaid: number
  overdueCount: number
  totalLoans: number
  totalAdvances: number
}> {
  const t = today()
  const loans = await db.loan.findMany({ where: { vendorId, employeeId } })
  const advances = await db.advance.findMany({ where: { vendorId, employeeId } })
  const loanIds = loans.map((l) => l.id)

  let totalDue = 0
  let totalPaid = 0
  let overdueCount = 0

  if (loanIds.length > 0) {
    const installments = await db.loanInstallment.findMany({
      where: { loanId: { in: loanIds } },
    })
    for (const inst of installments) {
      if (inst.status === "OVERDUE") overdueCount++
      if (inst.dueDate <= t || inst.status === "PAID" || inst.status === "PARTIAL" || (inst.paidAmount || 0) > 0) {
        totalDue += inst.amount
        totalPaid += (inst.paidAmount || 0)
      }
    }
  }

  for (const adv of advances) {
    if (adv.status === "RECOVERED" || adv.status === "RECOVERING") {
      totalDue += adv.amount
      totalPaid += (adv.deducted || 0)
    }
  }

  const payoutRatio = totalDue > 0
    ? Math.min(100, Math.max(0, Math.round((totalPaid / totalDue) * 100)))
    : 100

  return {
    payoutRatio,
    totalDue: Math.round(totalDue * 100) / 100,
    totalPaid: Math.round(totalPaid * 100) / 100,
    overdueCount,
    totalLoans: loans.length,
    totalAdvances: advances.length,
  }
}

/** Comprehensive policy-driven evaluation of employee and guarantor eligibility */
export async function evaluateLoanEligibility(
  ctx: { vendorId: string },
  params: {
    employeeId: string
    guarantorId?: string | null
    principal?: number
    installments?: number
    type?: "LOAN" | "ADVANCE"
  }
) {
  const settings = await getSettings(ctx.vendorId)
  const policy = settings.loanPolicy || {
    eligibleStatuses: ["ACTIVE", "PROBATION"],
    minServiceMonths: 6,
    minPreviousRepaymentPct: 80,
    allowConcurrentLoans: false,
    maxConcurrentLoans: 1,
    minCurrentRepaidPctForNewLoan: 50,
    guarantorRequired: false,
    guarantorMinServiceMonths: 12,
    guarantorAllowActiveLoan: false,
    guarantorMinRepaymentPct: 90,
    guarantorEligibleStatuses: ["ACTIVE"],
  }

  const borrower = await db.employee.findUnique({
    where: { id: params.employeeId },
    include: { department: true, designation: true },
  })
  if (!borrower || borrower.vendorId !== ctx.vendorId) {
    return {
      eligible: false,
      reasons: ["Borrower employee record not found in this organization"],
      warnings: [],
      borrower: null,
      guarantor: null,
      policy,
    }
  }

  const reasons: string[] = []
  const warnings: string[] = []

  // 1. Borrower Status Check
  const allowedStatuses = policy.eligibleStatuses || ["ACTIVE", "PROBATION"]
  const statusEligible = allowedStatuses.includes(borrower.status)
  if (!statusEligible) {
    reasons.push(`Employee status "${borrower.status}" is not eligible for loans/advances (Eligible: ${allowedStatuses.join(", ")})`)
  }

  // 2. Borrower Service Tenure Check
  const serviceMonths = calculateServiceMonths(borrower.joiningDate, borrower.createdAt)
  const serviceEligible = serviceMonths >= (policy.minServiceMonths ?? 0)
  if (!serviceEligible) {
    reasons.push(`Employee service period is ${serviceMonths} month(s); minimum ${policy.minServiceMonths} month(s) required by policy`)
  }

  // 3. Borrower Previous Payout / Repayment Ratio Check
  const borrowerStats = await calculateEmployeePayoutRatio(ctx.vendorId, borrower.id)
  const payoutEligible = borrowerStats.payoutRatio >= (policy.minPreviousRepaymentPct ?? 0)
  if (!payoutEligible) {
    reasons.push(`Previous loan/advance payout ratio is ${borrowerStats.payoutRatio}%; minimum ${policy.minPreviousRepaymentPct}% required`)
  }
  if (borrowerStats.overdueCount > 0) {
    warnings.push(`Employee has ${borrowerStats.overdueCount} overdue installment(s) on previous loan records`)
  }

  // 4. Concurrent Loans & Advances Cross-Credit Check (Unified Borrower Limits)
  const activeLoans = await db.loan.findMany({
    where: { vendorId: ctx.vendorId, employeeId: borrower.id, status: "ACTIVE" },
  })
  const recoveringAdvances = await db.advance.findMany({
    where: { vendorId: ctx.vendorId, employeeId: borrower.id, status: "RECOVERING" },
  })
  const totalActiveCredits = activeLoans.length + recoveringAdvances.length
  let concurrentEligible = true
  let lowestRepaidPct: number | null = null

  if (totalActiveCredits > 0) {
    if (!policy.allowConcurrentLoans) {
      concurrentEligible = false
      const loanDesc = activeLoans.length > 0 ? `${activeLoans.length} active loan(s)` : ""
      const advDesc = recoveringAdvances.length > 0 ? `${recoveringAdvances.length} recovering advance(s)` : ""
      const debtDesc = [loanDesc, advDesc].filter(Boolean).join(" and ")
      reasons.push(`Employee currently has ongoing ${debtDesc}. Concurrent loans & advances are disallowed by HR policy`)
    } else {
      if (totalActiveCredits >= (policy.maxConcurrentLoans || 1)) {
        concurrentEligible = false
        reasons.push(`Maximum concurrent active loans & advances reached (${totalActiveCredits}/${policy.maxConcurrentLoans || 1})`)
      }
      const loanRepaidPcts = activeLoans.map((l) =>
        l.principal > 0 ? Math.round(((l.paidAmount || 0) / l.principal) * 100) : 0
      )
      const advRepaidPcts = recoveringAdvances.map((a) =>
        a.amount > 0 ? Math.round(((a.deducted || 0) / a.amount) * 100) : 0
      )
      const allRepaidPcts = [...loanRepaidPcts, ...advRepaidPcts]
      if (allRepaidPcts.length > 0) {
        lowestRepaidPct = Math.min(...allRepaidPcts)
        if (lowestRepaidPct < (policy.minCurrentRepaidPctForNewLoan || 0)) {
          concurrentEligible = false
          reasons.push(`Ongoing active loan/advance is only ${lowestRepaidPct}% repaid; minimum ${policy.minCurrentRepaidPctForNewLoan}% repayment required before taking another loan or advance`)
        }
      }
    }
  }

  // 5. Salary Structure & Affordability Check
  const salaryStructure = await db.salaryStructure.findFirst({
    where: { employeeId: borrower.id, vendorId: ctx.vendorId, status: "ACTIVE" },
  })
  const monthlyGross = salaryStructure?.gross || null
  if (params.principal && params.installments && monthlyGross && monthlyGross > 0) {
    const monthlyEmi = Math.round(Number(params.principal) / Number(params.installments))
    const emiPctOfGross = Math.round((monthlyEmi / monthlyGross) * 100)
    if (emiPctOfGross > 50) {
      warnings.push(`Monthly installment (৳${monthlyEmi}) represents ${emiPctOfGross}% of monthly gross (৳${monthlyGross}). Ensure employee retains adequate take-home pay.`)
    }
  }

  // 6. Guarantor Evaluation (Unified for Loans & Advances)
  let guarantorSummary = null
  const guarantorReasons: string[] = []

  if (policy.guarantorRequired && !params.guarantorId) {
    reasons.push("A qualified guarantor is mandatory for all loan and advance applications according to HR policy")
  }

  if (params.guarantorId) {
    if (params.guarantorId === borrower.id) {
      guarantorReasons.push("Borrower cannot act as their own guarantor")
    } else {
      const guarantor = await db.employee.findUnique({
        where: { id: params.guarantorId },
        include: { department: true, designation: true },
      })
      if (!guarantor || guarantor.vendorId !== ctx.vendorId) {
        guarantorReasons.push("Guarantor employee not found in this organization")
      } else {
        const guarAllowedStatuses = policy.guarantorEligibleStatuses || ["ACTIVE"]
        const guarStatusEligible = guarAllowedStatuses.includes(guarantor.status)
        if (!guarStatusEligible) {
          guarantorReasons.push(`Guarantor status "${guarantor.status}" is not eligible (Allowed: ${guarAllowedStatuses.join(", ")})`)
        }

        const guarServiceMonths = calculateServiceMonths(guarantor.joiningDate, guarantor.createdAt)
        const guarServiceEligible = guarServiceMonths >= (policy.guarantorMinServiceMonths ?? 0)
        if (!guarServiceEligible) {
          guarantorReasons.push(`Guarantor service period is ${guarServiceMonths} month(s); minimum ${policy.guarantorMinServiceMonths} month(s) required`)
        }

        const guarActiveLoans = await db.loan.count({
          where: { vendorId: ctx.vendorId, employeeId: guarantor.id, status: "ACTIVE" },
        })
        const guarRecoveringAdv = await db.advance.count({
          where: { vendorId: ctx.vendorId, employeeId: guarantor.id, status: "RECOVERING" },
        })
        const guarHasActiveDebt = (guarActiveLoans + guarRecoveringAdv) > 0
        const guarDebtEligible = policy.guarantorAllowActiveLoan ? true : !guarHasActiveDebt
        if (!guarDebtEligible) {
          guarantorReasons.push("Guarantor currently has an ongoing active loan / advance; policy requires guarantors to be debt-free")
        }

        const guarStats = await calculateEmployeePayoutRatio(ctx.vendorId, guarantor.id)
        const guarPayoutEligible = guarStats.payoutRatio >= (policy.guarantorMinRepaymentPct ?? 0)
        if (!guarPayoutEligible) {
          guarantorReasons.push(`Guarantor historical payout ratio is ${guarStats.payoutRatio}%; minimum ${policy.guarantorMinRepaymentPct}% required`)
        }

        guarantorSummary = {
          id: guarantor.id,
          fullName: guarantor.fullName,
          code: guarantor.code,
          department: guarantor.department?.name || null,
          designation: guarantor.designation?.name || null,
          status: guarantor.status,
          statusEligible: guarStatusEligible,
          serviceMonths: guarServiceMonths,
          serviceEligible: guarServiceEligible,
          minServiceMonthsRequired: policy.guarantorMinServiceMonths ?? 0,
          hasActiveDebt: guarHasActiveDebt,
          debtEligible: guarDebtEligible,
          payoutRatio: guarStats.payoutRatio,
          payoutEligible: guarPayoutEligible,
          minPayoutRatioRequired: policy.guarantorMinRepaymentPct ?? 0,
          eligible: guarantorReasons.length === 0,
          reasons: guarantorReasons,
        }

        if (guarantorReasons.length > 0) {
          reasons.push(...guarantorReasons.map((r) => `Guarantor: ${r}`))
        }
      }
    }
  }

  const overallEligible = reasons.length === 0

  return {
    eligible: overallEligible,
    reasons,
    warnings,
    borrower: {
      id: borrower.id,
      fullName: borrower.fullName,
      code: borrower.code,
      status: borrower.status,
      statusEligible,
      department: borrower.department?.name || null,
      designation: borrower.designation?.name || null,
      joiningDate: borrower.joiningDate,
      serviceMonths,
      serviceEligible,
      minServiceMonthsRequired: policy.minServiceMonths ?? 0,
      activeLoansCount: activeLoans.length,
      recoveringAdvancesCount: recoveringAdvances.length,
      totalActiveCredits,
      concurrentEligible,
      lowestActiveRepaidPct: lowestRepaidPct,
      payoutRatio: borrowerStats.payoutRatio,
      payoutEligible,
      minPayoutRatioRequired: policy.minPreviousRepaymentPct ?? 0,
      monthlyGross,
    },
    guarantor: guarantorSummary,
    policy,
  }
}

route("loans.checkEligibility", {
  perm: ["loans", "view"],
  altPerm: ["loans", "create"],
  handler: async (ctx, p) => {
    const employeeId = resolveRequester(ctx, p)
    return await evaluateLoanEligibility(ctx, {
      employeeId,
      guarantorId: p?.guarantorId || null,
      principal: p?.principal ? Number(p.principal) : undefined,
      installments: p?.installments ? Number(p.installments) : undefined,
      type: p?.type || "LOAN",
    })
  },
})

route("loans.create", {
  schema: S.loanCreate,
  perm: ["loans", "create"],
  handler: async (ctx, p) => {
    const employeeId = resolveRequester(ctx, p)
    const emp = ctx.role === "EMPLOYEE" || !p.employeeId
      ? await db.employee.findFirst({ where: { id: employeeId, vendorId: ctx.vendorId } })
      : await assertEmployeeVisible(ctx, p.employeeId)
    if (!emp) throw new Deny("Employee not found", 404)
    const principal = Number(p.principal)
    const installments = Number(p.installments)
    if (!(principal > 0)) throw new Deny("Principal must be positive")
    if (!(installments >= 1)) throw new Deny("At least one installment required")
    // L-7 — every installment must carry at least 1 paisa: a plan of
    // ৳0.04 over 3 installments is fine (1.34/1.33/1.33), but ৳0.02 over 3
    // would need a zero installment — deny loudly instead of generating a
    // degenerate plan (the old ceil-division could even go NEGATIVE on the
    // final row: ৳0.01 over 3 → 0.01 − 2×0.01).
    const plan = planInstallments(principal, installments)
    if (!plan.ok) throw new Deny(`Each installment must be at least ৳0.01 — reduce the installment count to at most ${plan.maxInstallments} for this principal`, 400)

    // Policy-driven eligibility evaluation
    const eligibility = await evaluateLoanEligibility(ctx, {
      employeeId,
      guarantorId: p.guarantorId || null,
      principal,
      installments,
      type: "LOAN",
    })
    if (!eligibility.eligible) {
      throw new Deny(`Loan eligibility requirement not met: ${eligibility.reasons.join("; ")}`, 400)
    }

    // FIN-03 — the configurable loan policy (Settings → Loans, evaluated
    // above via evaluateLoanEligibility and counting loans + advances
    // JOINTLY) is the single source of truth for concurrent-credit limits.
    // The old hardcoded "max 2" checks here silently overrode a configured
    // maxConcurrentLoans > 2.

    // Optional guarantor (spec §10.1): a named colleague must consent before the
    // loan enters the approval workflow.
    let guarantor: { id: string; fullName: string } | null = null
    if (p.guarantorId) {
      if (p.guarantorId === employeeId) throw new Deny("You cannot name yourself as guarantor")
      guarantor = await db.employee.findFirst({
        where: { id: p.guarantorId, vendorId: ctx.vendorId, status: { in: ["ACTIVE", "PROBATION"] } },
        select: { id: true, fullName: true },
      })
      if (!guarantor) throw new Deny("Guarantor not found or not an active employee of this organization", 404)
    }

    // M-10 — double-submit guard (same pattern as expense claims): an
    // identical pending loan created within 90s is the same submission.
    const loanDup = await db.loan.findFirst({
      where: { vendorId: ctx.vendorId, employeeId, principal, installments, status: "PENDING" },
      orderBy: { createdAt: "desc" },
    })
    if (loanDup && withinDuplicateWindow(loanDup.createdAt)) {
      throw new Deny("This loan request was just submitted — it is awaiting processing (no duplicate created)", 409)
    }

    // L-7 — installmentAmount stores the nominal FIRST amount of the
    // paisa-exact plan validated above (no zero/negative installment can be
    // generated; the approval finalize hook recomputes the same plan).
    const installmentAmount = plan.amounts[0]
    const loan = await db.loan.create({
      data: {
        vendorId: ctx.vendorId, employeeId, type: p.type || "PERSONAL",
        // L-7 — interestRate is RECORDED metadata only: it is displayed on the
        // loan ledger but never added to installment amounts (the create form
        // does not collect it; charging interest would be a business decision
        // requiring a spec — see REMEDIATION-TRACKER L-7).
        principal, interestRate: Number(p.interestRate || 0),
        installmentAmount, installments, startDate: p.startDate || today(),
        outstanding: principal, status: "PENDING", purpose: p.purpose || null,
        guarantorId: guarantor?.id || null,
        guarantorStatus: guarantor ? "PENDING" : null,
      },
    })

    if (guarantor) {
      // Hold the workflow until the guarantor consents in their ESS portal.
      await audit(ctx, "loans.create", "Loan", loan.id,
        `Loan request ৳${principal} (${installments} installments) for ${emp.fullName} — awaiting guarantor consent from ${guarantor.fullName}`)
      await notify(ctx.vendorId, { employeeId: guarantor.id }, "Guarantor Consent Needed",
        `${emp.fullName} named you as guarantor for a loan of ৳${principal} (${installments} installments). Open My Self-Service → My Loans to accept or decline.`,
        "LOAN", "ess")
      await notifyChannels(ctx.vendorId, { employeeId }, "Loan Request Submitted",
        `Your loan request of ৳${principal} was submitted. It will go for approval once ${guarantor.fullName} (guarantor) consents.`, "LOAN", "ess",
        { email: true }, "loan_request",
        { amount: principal, installments: p.installments, guarantor: guarantor.fullName })
      return loan
    }

    // M-10 — compensation: if approval submission or the backlink fails, the
    // loan row is removed again — no orphaned PENDING loan stuck outside the
    // workflow (create / submit / backlink are otherwise separate awaits).
    const { submitForApproval } = await import("../approval")
    try {
      const approvalId = await submitForApproval(ctx, "LOAN", "Loan", loan.id,
        `Loan ৳${principal} — ${emp.fullName}`, { employeeId, amount: principal, loanId: loan.id })
      const linked = await db.loan.update({ where: { id: loan.id }, data: { approvalRequestId: approvalId } })
      await audit(ctx, "loans.create", "Loan", loan.id, `Loan request ৳${principal} (${installments} installments) for ${emp.fullName}`)
      return linked
    } catch (e) {
      await db.loan.delete({ where: { id: loan.id } }).catch(() => {})
      throw e
    }
  },
})

/** Guarantor consent (spec §10.1): agree → loan enters the approval workflow; decline → rejected. */
  // INTENTIONALLY_SELF_SCOPED (M-02): capability-token flow: only the named guarantor's unique token can act
route("loans.guarantorRespond", {
  handler: async (ctx, p) => {
    if (!ctx.employeeId && !["HR_ADMIN", "HR_MANAGER"].includes(ctx.role)) {
      throw new Deny("Your account has no linked employee profile", 400)
    }
    // SUB-108 (Wave R3-5, closed with the SUB-107 class) — the loans module is
    // PAYROLL-gated for every perm-carrying route, but this self-scoped
    // consent flow has no def.perm so the dispatcher gate never applied: on a
    // plan without PAYROLL a guarantor could still decide a guarantee created
    // before the downgrade. In-handler gate, self-path only.
    await requireFeature(ctx.vendorId, "PAYROLL")
    const loan = await db.loan.findFirst({ where: { id: p.loanId, vendorId: ctx.vendorId } })
    if (!loan) throw new Deny("Loan not found", 404)
    if (loan.status !== "PENDING" || loan.guarantorStatus !== "PENDING") {
      throw new Deny("This guarantor request is no longer pending")
    }
    const isGuarantor = !!ctx.employeeId && ctx.employeeId === loan.guarantorId
    const isHr = ["HR_ADMIN", "HR_MANAGER"].includes(ctx.role)
    if (!isGuarantor && !isHr) throw new Deny("Only the selected guarantor can respond to this request")

    const emp = await db.employee.findUnique({ where: { id: loan.employeeId } })
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): convert to an explicit null check
    const guarantor = await db.employee.findUnique({ where: { id: loan.guarantorId! } })
    const note = p.note || null

    if (p.decision === "AGREE") {
      await db.loan.update({
        where: { id: loan.id },
        data: { guarantorStatus: "AGREED", guarantorRespondedAt: new Date(), guarantorNote: note },
      })
      const { submitForApproval } = await import("../approval")
      const approvalId = await submitForApproval(ctx, "LOAN", "Loan", loan.id,
        `Loan ৳${loan.principal} — ${emp?.fullName || ""}`, { employeeId: loan.employeeId, amount: loan.principal, loanId: loan.id })
      await db.loan.update({ where: { id: loan.id }, data: { approvalRequestId: approvalId } })
      await audit(ctx, "loans.guarantor.agree", "Loan", loan.id,
        `${guarantor?.fullName || "Guarantor"} agreed to guarantee the ৳${loan.principal} loan of ${emp?.fullName}`)
      await notify(ctx.vendorId, { employeeId: loan.employeeId }, "Guarantor Agreed",
        `${guarantor?.fullName || "Your guarantor"} agreed to guarantee your loan of ৳${loan.principal}. It is now submitted for approval.`, "LOAN", "ess")
      return { ok: true, status: "AGREED" }
    }

    if (p.decision === "DECLINE") {
      await db.loan.update({
        where: { id: loan.id },
        data: { guarantorStatus: "DECLINED", status: "REJECTED", guarantorRespondedAt: new Date(),
          guarantorNote: note, approvedBy: ctx.userId, actedAt: new Date() },
      })
      await audit(ctx, "loans.guarantor.decline", "Loan", loan.id,
        `${guarantor?.fullName || "Guarantor"} declined to guarantee the ৳${loan.principal} loan of ${emp?.fullName}${note ? ": " + note : ""}`)
      await notify(ctx.vendorId, { employeeId: loan.employeeId }, "Guarantor Declined",
        `${guarantor?.fullName || "Your guarantor"} declined to guarantee your loan of ৳${loan.principal}. The request is rejected — you may re-apply with another guarantor.`, "LOAN", "ess")
      return { ok: true, status: "DECLINED" }
    }
    throw new Deny("Decision must be AGREE or DECLINE")
  },
})

/** LOAN finalize hook — approve activates installments + accounting; reject closes.
 *  M-1 — the status transition is a conditional check-and-set so a double
 *  finalize (concurrent approvals or a retried action) can never double-post
 *  the disbursement journal or duplicate installments. */
export async function applyLoanDecision(ctx: { userId: string; userName: string; vendorId: string; ip?: string }, loanId: string, decision: string) {
  const loan = await db.loan.findFirst({ where: { id: loanId, vendorId: ctx.vendorId } })
  if (!loan) return
  // M-1 — exactly one concurrent decision wins
  const claimed = await db.loan.updateMany({ where: { id: loan.id, status: "PENDING" }, data: { status: decision === "APPROVED" ? "ACTIVE" : "REJECTED", actedAt: new Date(), approvedBy: ctx.userId } })
  if (claimed.count === 0) return
  const emp = await db.employee.findUnique({ where: { id: loan.employeeId } })
  if (decision === "APPROVED") {
    // MON-11 — calendar-month EMIs: installment #i is due exactly i calendar
    // months after the start (end-of-month clamped), so February EMIs stay in
    // February and payroll's month-prefix budgeting always finds them. The
    // legacy addDays(start, i × 30) drifted ~5 days/year into the NEXT month.
    const endDate = addMonthsIso(loan.startDate, loan.installments)
    // L-7 — paisa-exact even plan (recomputed from the stored principal /
    // installment count): every row ≥ ৳0.01, the rows sum to EXACTLY the
    // principal, and no ceil-division zero/negative final installment.
    const plan = planInstallments(loan.principal, loan.installments)
    if (!plan.ok) {
      throw new Deny(`Loan ${loan.id} has a degenerate installment plan (principal ৳${loan.principal} over ${loan.installments} installments) — reject and recreate the loan`, 500)
    }
    for (let i = 1; i <= loan.installments; i++) {
      const due = addMonthsIso(loan.startDate, i)
      const amount = plan.amounts[i - 1]
      // HIGH-9 (this audit) — catch ONLY the unique-constraint violation (P2002)
      // so retried finalize hooks are idempotent. The previous .catch(() => {})
      // swallowed ALL errors (deadlock, check constraint, column missing), which
      // could silently drop installments while still marking the loan ACTIVE.
      try {
        await db.loanInstallment.create({ data: { vendorId: loan.vendorId, loanId: loan.id, no: i, dueDate: due, amount } })
      } catch (e: any) {
        if (String(e?.code) !== "P2002" && !/UNIQUE/i.test(String(e?.message || ""))) {
          throw new Deny(`Loan installment ${i} could not be created: ${e?.message || e}`, 500)
        }
        // else: duplicate (vendorId, loanId, no) from a retried finalize — idempotent, skip
      }
    }
    const journalId = await postJournal(ctx, "LOAN_DISBURSE", loan.id, loan.startDate,
      `Loan disbursement — ${emp?.fullName} (৳${loan.principal})`,
      [
        { account: "1150", accountName: "Employee Loan Receivable", debit: loan.principal },
        { account: "1100", accountName: "Cash / Bank", credit: loan.principal },
      ], loan.principal, { idempotencyKey: `LOAN_DISBURSE:${loan.id}` })
    await db.loan.update({ where: { id: loan.id }, data: { endDate, journalDisburseId: journalId } })
    await db.employeeHistory.create({
      data: { vendorId: ctx.vendorId, employeeId: loan.employeeId, eventType: "LOAN",
        title: `Loan approved ৳${loan.principal}`, description: `${loan.installments} installments, ending ${endDate}`,
        amount: loan.principal, dataJson: JSON.stringify({ loanId: loan.id }) },
    })
    await notifyChannels(ctx.vendorId, { employeeId: loan.employeeId }, "Loan Approved",
      `Your loan of ৳${loan.principal} is approved. ${loan.installments} installments of ~৳${loan.installmentAmount} will be deducted from payroll.`, "LOAN", "ess", {}, "loan_decision",
      { amount: loan.principal, installments: loan.installments, installmentAmount: loan.installmentAmount, decision: "approved" })
  } else {
    await notifyChannels(ctx.vendorId, { employeeId: loan.employeeId }, "Loan Rejected", "Your loan request was rejected.", "LOAN", "ess", {}, "loan_decision",
      { amount: loan.principal, installments: loan.installments, installmentAmount: loan.installmentAmount, decision: "rejected" })
  }
}

route("loans.recordInstallment", {
  perm: ["loans", "pay"],
  handler: async (ctx, p) => {
    const inst = await db.loanInstallment.findUnique({ where: { id: p.installmentId } })
    if (!inst) throw new Deny("Installment not found", 404)
    const loan = await db.loan.findFirst({ where: { id: inst.loanId, vendorId: ctx.vendorId } })
    if (!loan) throw new Deny("Loan not found", 404)
    if (inst.status === "PAID") throw new Deny("Installment already paid")
    // Audit Low — validate the payment amount (positive, finite, not beyond due)
    const pay = Number(p.amount || inst.amount - inst.paidAmount)
    if (!Number.isFinite(pay) || pay <= 0) throw new Deny("Payment amount must be a positive number")
    const capped = Math.min(pay, inst.amount - inst.paidAmount)
    if (capped <= 0) throw new Deny("Installment is already fully paid")
    // LOA-002 (R3-4) — guarded atomic increments. The old read-then-write
    // absolute updates (paidAmount: inst.paidAmount + capped, loan-level
    // likewise) lost an update whenever a concurrent writer touched the same
    // rows — a payroll recovery landing mid-manual-entry (or two clerks)
    // could double-count or silently drop a payment. The where-guard makes
    // this a conditional claim: 0 rows updated = someone else moved it, and
    // the caller retries on fresh data (409).
    const claimed = await db.loanInstallment.updateMany({
      where: { id: inst.id, paidAmount: inst.paidAmount, status: { not: "PAID" } },
      data: { paidAmount: { increment: capped }, paidAt: new Date() },
    })
    if (claimed.count !== 1) {
      throw new Deny("This installment was just updated by someone else (or by a payroll run) — reload and record the remaining balance", 409)
    }
    const newPaid = inst.paidAmount + capped
    await db.loanInstallment.update({
      where: { id: inst.id },
      data: { status: newPaid >= inst.amount ? "PAID" : "PARTIAL" },
    })
    // loan-level guarded increment (same race class; outstanding floors at 0)
    const loanClaim = await db.loan.updateMany({
      where: { id: loan.id, paidAmount: loan.paidAmount },
      data: { paidAmount: { increment: capped }, outstanding: { decrement: Math.min(capped, loan.outstanding) } },
    })
    if (loanClaim.count !== 1) {
      // a concurrent writer already moved the loan totals — reconcile
      // outstanding from the authoritative installment/loan state instead
      // of writing absolutes from the stale read
      const live = await db.loan.findUnique({ where: { id: loan.id } })
      const liveInst = await db.loanInstallment.findUnique({ where: { id: inst.id } })
      if (live && liveInst) {
        const instPaid = await db.loanInstallment.aggregate({ where: { loanId: loan.id }, _sum: { paidAmount: true } })
        const paid = Math.min(live.principal, Number(instPaid._sum.paidAmount) || 0)
        await db.loan.update({ where: { id: loan.id }, data: { paidAmount: paid, outstanding: Math.max(0, live.principal - paid) } })
      }
    } else {
      const live = await db.loan.findUnique({ where: { id: loan.id } })
      if (live && live.status !== "CLOSED" && live.outstanding <= 0) {
        await db.loan.update({ where: { id: loan.id }, data: { status: "CLOSED" } })
      }
    }
    // LOA-002 — the GL finally relieves the loan receivable for manual
    // (cash/cheque) repayments: the disbursement posts Dr 1150 / Cr 1100,
    // the payroll recovery posts its own journal — but manual entries
    // posted NOTHING, overstating 1150 by every manually-repaid installment.
    // Idempotency-keyed so a retry of the same payment cannot double-post.
    let journalId: string | null = null
    try {
      journalId = await postJournal(ctx, "LOAN_RECOVERY", inst.id, today(),
        `Manual loan repayment — ${loan.type || "loan"} installment #${inst.no}`,
        [
          { account: "1100", accountName: "Cash & Bank", debit: capped },
          { account: "1150", accountName: "Employee Loan Receivable", credit: capped },
        ], capped, { idempotencyKey: `LOAN_RECOVERY:${inst.id}:${Math.round(inst.paidAmount)}:${Math.round(capped)}` })
    } catch (e: any) {
      // ledger discipline: the repayment stands, the posting failure is
      // surfaced to the operator (the ledger reconciliation report will
      // re-derive it) — never silently swallow
      console.error("[loans.recordInstallment] LOAN_RECOVER journal failed", e)
      journalId = null
    }
    await audit(ctx, "loans.recordInstallment", "LoanInstallment", inst.id,
      `Manual installment payment ৳${capped}${journalId ? ` — journal ${journalId}` : " — WARNING: GL journal failed, reconcile account 1150"}`)
    return { ok: true, journalId }
  },
})

// ================= ADVANCES =================
route("advances.list", {
  perm: ["advances", "view"],
  handler: async (ctx, p) => {
    // P6 WS-B — scope-only where feeds the paged `summary` block; the table
    // where layers status + server-side search on top (MOD-16 + SCL-10)
    const scopeWhere: any = { vendorId: ctx.vendorId, ...await scopedEmployeeWhere(ctx, p) }
    const where: any = { ...scopeWhere }
    if (p?.status) where.status = p.status
    await applyEmployeeSearch(ctx.vendorId, where, p?.q)
    const paged = p?.page != null || p?.pageSize != null
    const pageSize = Math.min(500, Math.max(1, Number(p?.pageSize) || 200))
    const page = Math.max(1, Number(p?.page) || 1)
    const [list, total, byStatus] = paged
      ? await Promise.all([
          db.advance.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: (page - 1) * pageSize, take: pageSize }),
          db.advance.count({ where }),
          db.advance.groupBy({ by: ["status"], where: scopeWhere, _count: { _all: true }, _sum: { outstanding: true } }),
        ])
      : [await db.advance.findMany({ where, orderBy: { createdAt: "desc" } }), null, null]
    const empIds = [...new Set(list.flatMap((a) => [a.employeeId, a.guarantorId].filter((x): x is string => !!x)))]
    const employees = empIds.length
      ? await db.employee.findMany({ where: { vendorId: ctx.vendorId, id: { in: empIds } }, select: { id: true, fullName: true, code: true } })
      : []
    const empById = new Map(employees.map((e) => [e.id, e]))
    const items = list.map((a) => ({
      ...a,
      employeeName: empById.get(a.employeeId)?.fullName || "—",
      guarantorName: a.guarantorId ? empById.get(a.guarantorId)?.fullName || "—" : null,
    }))
    if (!paged) return items
    const statusCount = new Map((byStatus || []).map((g) => [g.status, g._count._all]))
    const summary = {
      total: [...statusCount.values()].reduce((s, n) => s + n, 0),
      recovering: statusCount.get("RECOVERING") || 0,
      pending: statusCount.get("PENDING") || 0,
      recovered: statusCount.get("RECOVERED") || 0,
      outstandingRecovering: Number((byStatus || []).find((g) => g.status === "RECOVERING")?._sum.outstanding) || 0,
    }
    return { items, total, page, pageSize, summary }
  },
})

route("advances.create", {
  schema: S.advanceCreate,
  perm: ["advances", "create"],
  handler: async (ctx, p) => {
    const employeeId = resolveRequester(ctx, p)
    const emp = ctx.role === "EMPLOYEE" || !p.employeeId
      ? await db.employee.findFirst({ where: { id: employeeId, vendorId: ctx.vendorId } })
      : await assertEmployeeVisible(ctx, p.employeeId)
    if (!emp) throw new Deny("Employee not found", 404)
    const amount = Number(p.amount)
    if (!(amount > 0)) throw new Deny("Amount must be positive")

    // Policy-driven eligibility evaluation
    const eligibility = await evaluateLoanEligibility(ctx, {
      employeeId,
      guarantorId: p.guarantorId || null,
      principal: amount,
      installments: Number(p.installments || 1),
      type: "ADVANCE",
    })
    if (!eligibility.eligible) {
      throw new Deny(`Advance eligibility requirement not met: ${eligibility.reasons.join("; ")}`, 400)
    }

    // FIN-03 — see loans.create: the configurable policy (already evaluated
    // above) governs concurrent advances; the old hardcoded "max 2" check
    // silently overrode a configured maxConcurrentLoans > 2.
    // ADV-002 (R3-4) — advance-vs-salary cap: an advance may not exceed
    // advanceMaxPctOfMonthlyGross% of the borrower's monthly gross (0 = no
    // cap; default 100). Guards festival-advance overshoots against
    // credit-light employees — nothing previously prevented a 10× salary
    // advance. Enforced only when an ACTIVE salary structure exists; a
    // vendor without structures keeps the legacy behaviour.
    {
      const capPct = Math.max(0, Number((await getSettings(ctx.vendorId)).payroll.advanceMaxPctOfMonthlyGross) || 0)
      if (capPct > 0) {
        const structure = await db.salaryStructure.findFirst({ where: { employeeId, vendorId: ctx.vendorId, status: "ACTIVE" } })
        if (structure && structure.gross > 0) {
          const cap = Math.floor(structure.gross * capPct / 100)
          if (amount > cap) {
            throw new Deny(`Advance ৳${amount.toLocaleString("en-IN")} exceeds ${capPct}% of ${emp.fullName}'s monthly gross (৳${cap.toLocaleString("en-IN")}) — Settings → Payroll → advance cap`)
          }
        }
      }
    }

    // 2026-10-14 — optional guarantor (HR-designated; effective immediately —
    // loans keep the ESS consent gate per spec §10.1). Employees submitting
    // their own ESS request cannot name a guarantor.
    let guarantor: { id: string; fullName: string } | null = null
    if (p.guarantorId && ctx.role !== "EMPLOYEE") {
      if (p.guarantorId === employeeId) throw new Deny("You cannot name the borrower as their own guarantor")
      guarantor = await db.employee.findFirst({
        where: { id: p.guarantorId, vendorId: ctx.vendorId, status: { in: ["ACTIVE", "PROBATION"] } },
        select: { id: true, fullName: true },
      })
      if (!guarantor) throw new Deny("Guarantor not found or not an active employee of this organization", 404)
    }

    // M-10 — double-submit guard + compensation (same pattern as loans).
    const advDup = await db.advance.findFirst({
      where: { vendorId: ctx.vendorId, employeeId, amount, status: "PENDING" },
      orderBy: { createdAt: "desc" },
    })
    if (advDup && withinDuplicateWindow(advDup.createdAt)) {
      throw new Deny("This advance request was just submitted — it is awaiting approval (no duplicate created)", 409)
    }
    const adv = await db.advance.create({
      data: {
        vendorId: ctx.vendorId, employeeId, amount, reason: p.reason || null,
        requestDate: p.requestDate || today(), recoveryDate: p.recoveryDate || null,
        installments: Number(p.installments || 1), outstanding: amount, status: "PENDING",
        guarantorId: guarantor?.id || null, guarantorStatus: guarantor ? "AGREED" : null,
      },
    })
    const { submitForApproval } = await import("../approval")
    try {
      const approvalId = await submitForApproval(ctx, "ADVANCE", "Advance", adv.id,
        `Advance ৳${amount} — ${emp.fullName}`, { employeeId, amount, advanceId: adv.id })
      const linked = await db.advance.update({ where: { id: adv.id }, data: { approvalRequestId: approvalId } })
      await audit(ctx, "advances.create", "Advance", adv.id, `Advance request ৳${amount} for ${emp.fullName}`)
      // advance_request matrix row (Settings → Communication → Automation)
      await notifyChannels(ctx.vendorId, { employeeId }, "Advance Request Submitted",
        `Your salary advance request of ৳${amount} is submitted for approval.`, "LOAN", "ess", {}, "advance_request",
        { amount, installments: p.installments })
      return linked
    } catch (e) {
      await db.advance.delete({ where: { id: adv.id } }).catch(() => {})
      throw e
    }
  },
})

/** ADVANCE finalize hook. M-1 — conditional status claim prevents double effects. */
export async function applyAdvanceDecision(ctx: { userId: string; userName: string; vendorId: string; ip?: string }, advanceId: string, decision: string) {
  const adv = await db.advance.findFirst({ where: { id: advanceId, vendorId: ctx.vendorId } })
  if (!adv) return
  const claimed = await db.advance.updateMany({ where: { id: adv.id, status: "PENDING" }, data: { status: decision === "APPROVED" ? "RECOVERING" : "REJECTED", actedAt: new Date(), approvedBy: ctx.userId } })
  if (claimed.count === 0) return
  const emp = await db.employee.findUnique({ where: { id: adv.employeeId } })
  if (decision === "APPROVED") {
    const journalId = await postJournal(ctx, "ADVANCE_PAY", adv.id, adv.requestDate,
      `Advance payment — ${emp?.fullName} (৳${adv.amount})`,
      [
        { account: "1155", accountName: "Employee Advances", debit: adv.amount },
        { account: "1100", accountName: "Cash / Bank", credit: adv.amount },
      ], adv.amount, { idempotencyKey: `ADVANCE_PAY:${adv.id}` })
    await db.advance.update({ where: { id: adv.id }, data: { journalId } })
    await notifyChannels(ctx.vendorId, { employeeId: adv.employeeId }, "Advance Approved",
      `Your salary advance of ৳${adv.amount} is approved. It will be recovered in ${adv.installments} installment(s).`, "LOAN", "ess", {}, "advance_decision",
      { amount: adv.amount, installments: adv.installments, decision: "approved" })
  } else {
    await notifyChannels(ctx.vendorId, { employeeId: adv.employeeId }, "Advance Rejected", "Your advance request was rejected.", "LOAN", "ess", {}, "advance_decision",
      { amount: adv.amount, installments: adv.installments, decision: "rejected" })
  }
}

// ================= EXPENSES =================
route("expenses.list", {
  perm: ["expenses", "view"],
  handler: async (ctx, p) => {
    // P6 WS-B — scope-only where feeds the paged `summary` block; the table
    // where layers status + server-side search on top (MOD-16 + SCL-10)
    const scopeWhere: any = { vendorId: ctx.vendorId, ...await scopedEmployeeWhere(ctx, p) }
    const where: any = { ...scopeWhere }
    if (p?.status) where.status = p.status
    await applyEmployeeSearch(ctx.vendorId, where, p?.q)
    const paged = p?.page != null || p?.pageSize != null
    const pageSize = Math.min(500, Math.max(1, Number(p?.pageSize) || 200))
    const page = Math.max(1, Number(p?.page) || 1)
    const now = new Date()
    const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
    // V1-001 — exclude base64 receiptData from list queries; fetch only on the detail view
    const listSelect = {
      id: true, vendorId: true, employeeId: true, category: true, title: true, amount: true,
      approvedAmount: true, date: true, description: true, branchId: true, projectRef: true,
      receiptName: true, paymentMethod: true, status: true, reimbursementDate: true,
      approvalRequestId: true, approvedBy: true, actedAt: true, journalId: true, createdAt: true,
    } as const
    const [list, total, byStatus] = paged
      ? await Promise.all([
          db.expenseClaim.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: (page - 1) * pageSize, take: pageSize, select: listSelect }),
          db.expenseClaim.count({ where }),
          db.expenseClaim.groupBy({ by: ["status"], where: scopeWhere, _count: { _all: true }, _sum: { amount: true } }),
        ])
      : [await db.expenseClaim.findMany({ where, orderBy: { createdAt: "desc" }, select: listSelect }), null, null]
    const empIds = [...new Set(list.map((e) => e.employeeId))]
    const employees = empIds.length
      ? await db.employee.findMany({ where: { vendorId: ctx.vendorId, id: { in: empIds } }, select: { id: true, fullName: true, code: true } })
      : []
    const empById = new Map(employees.map((e) => [e.id, e]))
    const items = list.map((e) => ({ ...e, employeeName: empById.get(e.employeeId)?.fullName || "—" }))
    if (!paged) return items
    // summary — the KPI strip's cohort truth: status mix + this-month
    // reimbursed sum + the total-claimed sum, all set-based
    const [monthAgg, totalAgg] = await Promise.all([
      db.expenseClaim.aggregate({
        where: { ...scopeWhere, status: "REIMBURSED", reimbursementDate: { startsWith: monthPrefix } },
        _sum: { approvedAmount: true, amount: true },
      }),
      db.expenseClaim.aggregate({ where: scopeWhere, _sum: { amount: true } }),
    ])
    const statusCount = new Map((byStatus || []).map((g) => [g.status, g._count._all]))
    const summary = {
      total: [...statusCount.values()].reduce((s, n) => s + n, 0),
      pending: statusCount.get("PENDING") || 0,
      reimbursed: statusCount.get("REIMBURSED") || 0,
      rejected: statusCount.get("REJECTED") || 0,
      reimbursedThisMonth: Number(monthAgg._sum.approvedAmount ?? monthAgg._sum.amount) || 0,
      totalClaimed: Number(totalAgg._sum.amount) || 0,
    }
    return { items, total, page, pageSize, summary }
  },
})

route("expenses.create", {
  perm: ["expenses", "create"],
  handler: async (ctx, p) => {
    const employeeId = resolveRequester(ctx, p)
    const emp = ctx.role === "EMPLOYEE" || !p.employeeId
      ? await db.employee.findFirst({ where: { id: employeeId, vendorId: ctx.vendorId } })
      : await assertEmployeeVisible(ctx, p.employeeId)
    if (!emp) throw new Deny("Employee not found", 404)
    const amount = Number(p.amount)
    if (!(amount > 0)) throw new Deny("Amount must be positive")
    if (p.date > today()) throw new Deny("Expense date cannot be in the future")
    // M-14 — double-submit guard: an identical pending claim created by this
    // employee within 90s is treated as the same submission.
    const dup = await db.expenseClaim.findFirst({
      where: { vendorId: ctx.vendorId, employeeId, title: p.title, amount, date: p.date, status: "PENDING" },
      orderBy: { createdAt: "desc" },
    })
    if (dup && withinDuplicateWindow(dup.createdAt)) {
      throw new Deny("This expense claim was just submitted — it is awaiting approval (no duplicate created)", 409)
    }

    const claim = await db.expenseClaim.create({
      data: {
        vendorId: ctx.vendorId, employeeId, category: p.category || "OTHER", title: p.title,
        amount, date: p.date, description: p.description || null,
        branchId: p.branchId || emp.branchId, projectRef: p.projectRef || null,
        receiptName: p.receiptName || null, receiptData: p.receiptData || null,
        paymentMethod: p.paymentMethod || "BANK", status: "PENDING",
      },
    })
    // M-10 — compensation: a failed submission/link removes the claim again
    // (create / submit / backlink were previously bare separate awaits).
    const { submitForApproval } = await import("../approval")
    let approvalId: string
    try {
      approvalId = await submitForApproval(ctx, "EXPENSE", "ExpenseClaim", claim.id,
        `${p.title} ৳${amount} — ${emp.fullName}`, { employeeId, amount, claimId: claim.id })
      await db.expenseClaim.update({ where: { id: claim.id }, data: { approvalRequestId: approvalId } })
    } catch (e) {
      await db.expenseClaim.delete({ where: { id: claim.id } }).catch(() => {})
      throw e
    }
    await audit(ctx, "expenses.create", "ExpenseClaim", claim.id, `Expense claim ৳${amount} (${p.category}) for ${emp.fullName}`)
    await notifyChannels(ctx.vendorId, { employeeId }, "Expense Claim Submitted",
      `Your expense claim "${p.title}" (৳${amount}) was submitted for approval.`, "EXPENSE", "ess",
      { email: true }, "expense_request",
      { title: p.title, amount })
    return claim
  },
})

/** EXPENSE finalize hook → reimbursement + accounting. M-1 — conditional claim. */
export async function applyExpenseDecision(ctx: { userId: string; userName: string; vendorId: string; ip?: string }, claimId: string, decision: string) {
  const claim = await db.expenseClaim.findFirst({ where: { id: claimId, vendorId: ctx.vendorId } })
  if (!claim) return
  // FIN-02 — ONE reimbursement model: approval sets APPROVED (the register's
  // pending bucket) and posts NO journal. The payout — and its cash journal
  // — happens once, in reimbursements.mark, when finance actually reimburses.
  // The old path wrote REIMBURSED + an accrual journal (Dr 5300 / Cr 2100)
  // here, so the register's pending bucket was permanently empty, its cash
  // journal was unreachable, and the 2100 payable grew without a discharge.
  const claimed = await db.expenseClaim.updateMany({
    where: { id: claim.id, status: "PENDING" },
    data: decision === "APPROVED"
      ? { status: "APPROVED", approvedAmount: claim.amount, approvedBy: ctx.userId, actedAt: new Date() }
      : { status: "REJECTED", approvedBy: ctx.userId, actedAt: new Date() },
  })
  if (claimed.count === 0) return
  if (decision === "APPROVED") {
    await notifyChannels(ctx.vendorId, { employeeId: claim.employeeId }, "Expense Approved",
      `Your expense "${claim.title}" of ৳${claim.amount} is approved and queued for reimbursement.`, "DOC", "ess", {}, "expense_decision",
      { title: claim.title, amount: claim.amount, decision: "approved" })
  } else {
    await notifyChannels(ctx.vendorId, { employeeId: claim.employeeId }, "Expense Rejected", `Your expense "${claim.title}" was rejected.`, "DOC", "ess", {}, "expense_decision",
      { title: claim.title, amount: claim.amount, decision: "rejected" })
  }
}
