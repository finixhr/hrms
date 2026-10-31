// ============ Employee Self-Service routes (spec §15) ============
// Exposed AFTER underlying services exist. Employees see only their own data.
import { db } from "@/lib/db"
import { route } from "./registry"
import { Deny } from "../rbac"
import { j, monthName, today } from "../utils"
import { getSettings } from "../settings"
import { audit } from "../audit"
import { spendableDays } from "../leave-math"
import { readPiiText } from "../pii-field"

function requireSelf(ctx: any): string {
  if (!ctx.employeeId) throw new Deny("Your account has no linked employee profile", 400)
  return ctx.employeeId
}

  // INTENTIONALLY_SELF_SCOPED (M-02): ESS self-service: only the caller's own profile
route("ess.profile", {
  handler: async (ctx) => {
    const id = requireSelf(ctx)
    const emp = await db.employee.findFirst({ where: { id, vendorId: ctx.vendorId } })
    if (!emp) throw new Deny("Employee not found", 404)
    const [branch, dept, desig, structure, docs, history, manager] = await Promise.all([
      emp.branchId ? db.branch.findFirst({ where: { id: emp.branchId } }) : null,
      emp.departmentId ? db.department.findFirst({ where: { id: emp.departmentId } }) : null,
      emp.designationId ? db.designation.findFirst({ where: { id: emp.designationId } }) : null,
      db.salaryStructure.findFirst({ where: { employeeId: id, status: "ACTIVE" } }),
      // T-18 audit — documents capped (was unbounded; an employee accumulates
      // one row per uploaded document over their whole tenure)
      db.employeeDocument.findMany({ where: { vendorId: ctx.vendorId, employeeId: id }, orderBy: { createdAt: "desc" }, take: 100 }),
      db.employeeHistory.findMany({ where: { vendorId: ctx.vendorId, employeeId: id }, orderBy: { createdAt: "desc" }, take: 30 }),
      emp.reportingManagerId ? db.employee.findFirst({ where: { id: emp.reportingManagerId }, select: { fullName: true, mobile: true } }) : null,
    ])
    // bank info visible to own employee
    // F28 (P6) — account/MFS numbers are encrypted at rest; the ESS profile
    // is the employee's OWN data surface, so the values decrypt (legacy
    // plaintext rows pass through readPiiText untouched).
    // T-18 audit — own bank accounts capped (was unbounded; realistically 1–3,
    // the cap is belt-and-braces against a runaway writer)
    const banks = (await db.bankAccount.findMany({ where: { employeeId: id }, orderBy: { createdAt: "desc" }, take: 20 })).map((b: any) => ({
      ...b,
      accountNumber: readPiiText(b.accountNumber),
      mfsNumber: readPiiText(b.mfsNumber),
    }))
    // ESS-07 (R6) — ship the 96×96 thumbnail when one exists (the profile card
    // renders a small avatar; the old payload carried the full 512×512 data
    // URL). Pre-thumbnail rows keep their original photoUrl (passthrough).
    const { photoThumb: _photoThumb, ...slimPhoto }: any = emp
    if (_photoThumb) slimPhoto.photoUrl = _photoThumb
    return {
      employee: {
        ...slimPhoto,
        branchName: branch?.name, departmentName: dept?.name, designationName: desig?.name,
        managerName: manager?.fullName,
      },
      grossSalary: structure?.gross,
      docs: docs.map((d) => ({ id: d.id, docType: d.docType, title: d.title, status: d.status, expiryDate: d.expiryDate, verified: d.verified })),
      history, banks,
    }
  },
})

  // INTENTIONALLY_SELF_SCOPED (M-02): ESS self-service: only the caller's own attendance
route("ess.attendance", {
  handler: async (ctx, p) => {
    const id = requireSelf(ctx)
    const month = p?.month || new Date().getMonth() + 1
    const year = p?.year || new Date().getFullYear()
    const prefix = `${year}-${String(month).padStart(2, "0")}`
    const records = await db.attendance.findMany({ where: { vendorId: ctx.vendorId, employeeId: id, date: { startsWith: prefix } }, orderBy: { date: "desc" } })
    const summary = {
      present: records.filter((r) => ["PRESENT", "LATE", "EARLY_LEAVE", "WFH"].includes(r.status)).length,
      absent: records.filter((r) => r.status === "ABSENT").length,
      late: records.filter((r) => r.status === "LATE").length,
      leave: records.filter((r) => r.status === "LEAVE").length,
      overtimeMinutes: records.reduce((s, r) => s + (r.overtimeMinutes || 0), 0),
      workingMinutes: records.reduce((s, r) => s + (r.workingMinutes || 0), 0),
    }
    const today_ = await db.attendance.findFirst({ where: { vendorId: ctx.vendorId, employeeId: id, date: today() } })
    return { records, summary, today: today_ }
  },
})

  // INTENTIONALLY_SELF_SCOPED (M-02): ESS self-service: only the caller's own leave requests/balances
route("ess.leave", {
  handler: async (ctx, p) => {
    const id = requireSelf(ctx)
    const year = new Date().getFullYear()
    const balances = await db.leaveBalance.findMany({ where: { employeeId: id, year } })
    // T-18 audit — the tenant's active leave-type catalog capped at 100 (the
    // apply form's type picker; realistic tenants carry < 15)
    const types = await db.leaveType.findMany({ where: { vendorId: ctx.vendorId, active: true }, orderBy: { name: "asc" }, take: 100 })
    // T-18 (2026-10-31) — the request history was UNBOUNDED (every leave
    // request the employee ever filed, newest first, no cap). Long-tenure
    // employees with frequent absences made this the one remaining unbounded
    // ESS read after ESS-07 capped the siblings at 200. Now capped at the
    // 200 most recent requests (same bound as ess.expenses/ess.tasks), with
    // an OPTIONAL month filter on the leave START date (fromDate prefix,
    // mirroring ess.attendance's month/year params) so a future consumer can
    // page through history without loading it all at once. Balances are
    // year-scoped (≤ #leave types) and types are the tenant's active list —
    // both naturally bounded.
    const month = p?.month ? String(Number(p.month)).padStart(2, "0") : null
    const filterYear = p?.year ? String(Number(p.year)) : null
    const prefix = month && filterYear ? `${filterYear}-${month}` : null
    const requests = await db.leaveRequest.findMany({
      where: {
        vendorId: ctx.vendorId, employeeId: id,
        ...(prefix ? { fromDate: { startsWith: prefix } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    })
    // Substitute queue: PENDING-only by design, but still capped — an
    // adversarial tenant could otherwise name one employee as substitute on
    // thousands of rows and blow up THEIR payload.
    const substitutes = await db.leaveRequest.findMany({
      where: { vendorId: ctx.vendorId, substituteEmployeeId: id, substituteStatus: "PENDING" },
      orderBy: { createdAt: "desc" },
      take: 200,
    })
    return {
      balances: balances.map((b) => ({
        ...b, typeName: types.find((t) => t.id === b.leaveTypeId)?.name,
        // LVE-002 (R3-4) — canonical spendable formula (carried-forward days
        // spendable at apply/encash time too)
        remaining: spendableDays(b),
      })),
      // R3 — attachment BYTES never ride with the list (payload slimming +
      // access control); only the file NAME is exposed. Bytes are fetched
      // on demand through the audited leaveRequests.attachment route.
      types, requests: requests.map((r) => {
        const { attachmentData: _attachmentData, ...rest } = r as any
        return { ...rest, typeName: types.find((t) => t.id === r.leaveTypeId)?.name, attachment: r.attachmentName ? { name: r.attachmentName } : null }
      }),
      // R3 — substitute rows are leave requests too: strip the attachment
      // bytes (they may name YOU as substitute on someone else's request).
      substituteRequests: substitutes.map((s) => {
        const { attachmentData: _subAttachmentData, ...rest } = s as any
        return rest
      }),
    }
  },
})

  // INTENTIONALLY_SELF_SCOPED (M-02): ESS self-service: only the caller's own payslips
route("ess.payroll", {
  handler: async (ctx) => {
    const id = requireSelf(ctx)
    // ESS-07 (R6) — capped at the 60 most recent payslips, ordered by payslip
    // number (the old net-desc ordering was nonsensical); runs resolve from
    // the page's ids only (was: the tenant's ENTIRE run history every visit).
    const entries = await db.payrollEntry.findMany({
      where: { vendorId: ctx.vendorId, employeeId: id, payslipNumber: { not: null } },
      orderBy: { payslipNumber: "desc" },
      take: 60,
    })
    const runs = entries.length
      ? await db.payrollRun.findMany({ where: { vendorId: ctx.vendorId, id: { in: [...new Set(entries.map((e) => e.runId))] } } })
      : []
    const _settings = await getSettings(ctx.vendorId)
    const _ait = entries.length ? entries[0].ait : 0
    return {
      payslips: entries.map((e) => {
        const r = runs.find((x) => x.id === e.runId)
        return {
          entryId: e.id, payslipNumber: e.payslipNumber,
          period: r ? `${monthName(r.periodMonth)} ${r.periodYear}` : "—",
          paidOn: r?.paymentDate, gross: e.gross, net: e.net, ait: e.ait,
          breakdown: j(e.breakdownJson, {}),
        }
      }),
      totalAit: entries.reduce((s, e) => s + e.ait, 0),
    }
  },
})

  // INTENTIONALLY_SELF_SCOPED (M-02 / PAY-007 R3-2): ESS payslip view/download —
  // the caller's OWN payslip only. payslips.html requires payslip.download (a
  // manager permission the EMPLOYEE role does not carry), which made
  // "View/Print" on My Payslips 403 out of the box; the only workaround
  // (granting payslip.download to the EMPLOYEE role) exposed every tenant
  // payslip to every employee. This route is the ESS mirror of ess.payroll.
// INTENTIONALLY_SELF_SCOPED (M-02): PAY-007 — the caller's OWN payslip HTML only (requireSelf + employeeId-scoped lookup below).
route("ess.payroll.html", {
  handler: async (ctx, p) => {
    const id = requireSelf(ctx)
    const entry = await db.payrollEntry.findFirst({
      where: { id: p.entryId, vendorId: ctx.vendorId, employeeId: id, payslipNumber: { not: null } },
    })
    if (!entry) throw new Deny("Payslip not found", 404)
    const { buildPayslipHtml } = await import("../payslip")
    const html = await buildPayslipHtml(ctx.vendorId, entry.id)
    if (!html) throw new Deny("Payslip not found", 404)
    await audit(ctx, "ess.payslip.download", "PayrollEntry", entry.id, `Employee downloaded their own payslip ${entry.payslipNumber}`)
    return { html }
  },
})

route("ess.colleagues", {
  // Colleague directory for ESS pickers (guarantor, substitute…):
  // names + org context only — no sensitive employee data.
  perm: ["ess", "view"],
  handler: async (ctx) => {
    const id = requireSelf(ctx)
    const me = await db.employee.findFirst({ where: { id, vendorId: ctx.vendorId } })
    const [list, desigs, depts, branches] = await Promise.all([
      // ESS-07 (R6) — bounded picker directory (guarantor/substitute pickers
      // only need names + org context; 1000 covers every realistic BD SME
      // tenant while the payload stays in the tens of KB).
      db.employee.findMany({
        where: { vendorId: ctx.vendorId, status: { in: ["ACTIVE", "PROBATION"] }, id: { not: id } },
        select: { id: true, fullName: true, code: true, designationId: true, departmentId: true, branchId: true, employmentType: true },
        orderBy: { fullName: "asc" },
        take: 1000,
      }),
      // T-18 audit — org catalogs capped (name decoration for the bounded
      // employee list; graceful degradation if a tenant exceeds the cap)
      db.designation.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 200 }),
      db.department.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 200 }),
      db.branch.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 200 }),
    ])
    return list.map((e) => ({
      id: e.id, fullName: e.fullName, code: e.code,
      designationName: desigs.find((d) => d.id === e.designationId)?.name,
      departmentName: depts.find((d) => d.id === e.departmentId)?.name,
      branchName: branches.find((b) => b.id === e.branchId)?.name,
      sameBranch: !!me?.branchId && me.branchId === e.branchId,
      sameDepartment: !!me?.departmentId && me.departmentId === e.departmentId,
    }))
  },
})

route("ess.loans", {
  perm: ["ess", "view"],
  handler: async (ctx) => {
    const id = requireSelf(ctx)
    // T-18 audit — every list read here is capped (was unbounded): own
    // loans/advances at the 100 most recent; the PENDING guarantee queue
    // at 100 (an adversarial tenant can otherwise name anyone guarantor on
    // thousands of rows). Installments are fetched only for the returned
    // loans (bounded transitively).
    const loans = await db.loan.findMany({ where: { vendorId: ctx.vendorId, employeeId: id }, orderBy: { createdAt: "desc" }, take: 100 })
    const advances = await db.advance.findMany({ where: { vendorId: ctx.vendorId, employeeId: id }, orderBy: { createdAt: "desc" }, take: 100 })
    // Loans where I am the named guarantor and my consent is still pending
    const guarantees = await db.loan.findMany({
      where: { vendorId: ctx.vendorId, guarantorId: id, guarantorStatus: "PENDING" },
      orderBy: { createdAt: "desc" },
      take: 100,
    })
    // ESS-07 (R6) — own-scope decoration: the caller's + guarantor names and
    // the guarantee requesters only (was: the FULL tenant directory), and the
    // installments batched in one query (was: one query per own loan).
    const empIds = [...new Set([...loans.flatMap((l) => [l.employeeId, l.guarantorId].filter((x): x is string => !!x)), ...guarantees.flatMap((g) => [g.employeeId])])]
    const employees = empIds.length
      ? await db.employee.findMany({ where: { vendorId: ctx.vendorId, id: { in: empIds } }, select: { id: true, fullName: true, code: true } })
      : []
    const loanIds = [...new Set(loans.map((l) => l.id))]
    const allInstallments = loanIds.length
      ? await db.loanInstallment.findMany({ where: { vendorId: ctx.vendorId, loanId: { in: loanIds } }, orderBy: { no: "asc" } })
      : []
    const instByLoan = new Map<string, typeof allInstallments>()
    for (const i of allInstallments) {
      const list = instByLoan.get(i.loanId) || []
      list.push(i)
      instByLoan.set(i.loanId, list)
    }
    const out: any[] = []
    for (const l of loans) {
      out.push({
        ...l,
        guarantorName: l.guarantorId ? employees.find((e) => e.id === l.guarantorId)?.fullName || "—" : null,
        installments: instByLoan.get(l.id) || [],
      })
    }
    const guaranteeRequests = guarantees.map((g) => ({
      ...g,
      requesterName: employees.find((e) => e.id === g.employeeId)?.fullName || "—",
      requesterCode: employees.find((e) => e.id === g.employeeId)?.code,
    }))
    return { loans: out, advances, guaranteeRequests }
  },
})

  // INTENTIONALLY_SELF_SCOPED (M-02): ESS self-service: only the caller's own expense claims
route("ess.expenses", {
  handler: async (ctx) => {
    const id = requireSelf(ctx)
    // ESS-07 (R6) — capped at the 200 most recent claims (was unbounded)
    return db.expenseClaim.findMany({ where: { vendorId: ctx.vendorId, employeeId: id }, orderBy: { createdAt: "desc" }, take: 200 })
  },
})

  // INTENTIONALLY_SELF_SCOPED (M-02): ESS self-service: only the caller's own tasks
route("ess.tasks", {
  handler: async (ctx) => {
    const id = requireSelf(ctx)
    // ESS-07 (R6) — capped at the 200 most urgent tasks (was unbounded)
    const tasks = await db.task.findMany({ where: { vendorId: ctx.vendorId, assigneeId: id }, orderBy: [{ status: "asc" }, { dueDate: "asc" }], take: 200 })
    return tasks.map((t) => ({ ...t, checklist: j(t.checklistJson, []), comments: j(t.commentsJson, []) }))
  },
})

  // INTENTIONALLY_SELF_SCOPED (M-02): ESS self-service: only the caller's own reviews
route("ess.performance", {
  handler: async (ctx) => {
    const id = requireSelf(ctx)
    // ESS-03 — DRAFT reviews (ratings, manager comments, strengths, goals)
    // must never be visible to the employee before the manager submits:
    // only SUBMITTED / ACKNOWLEDGED / FINAL reviews are the employee's to
    // see. ESS-05 (R7) widened the set from FINAL-only: the employee now
    // sees the SUBMITTED review so they can acknowledge it (and their
    // ACKNOWLEDGED review while it awaits finalization).
    const reviews = await db.performanceReview.findMany({ where: { vendorId: ctx.vendorId, employeeId: id, status: { in: ["SUBMITTED", "ACKNOWLEDGED", "FINAL"] } }, orderBy: { createdAt: "desc" }, take: 100 })
    // T-18 audit — reviews/kpis capped at the 100 most recent (was
    // unbounded); cycles is the tenant's cycle catalog used only to decorate
    // the returned rows — capped at 100 in step.
    const kpis = await db.kpiAssignment.findMany({ where: { vendorId: ctx.vendorId, employeeId: id }, orderBy: { createdAt: "desc" }, take: 100 })
    const cycles = await db.reviewCycle.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { createdAt: "desc" }, take: 100 })
    return {
      reviews: reviews.map((r) => ({ ...r, ratings: j(r.ratingsJson, {}), inputs: j((r as any).inputsJson, {}), cycleName: cycles.find((c) => c.id === r.cycleId)?.name })),
      kpis: kpis.map((k) => ({ ...k, results: j(k.resultsJson, []) })),
    }
  },
})

  // INTENTIONALLY_SELF_SCOPED (M-02): ESS self-service: only the caller's own documents
route("ess.documents", {
  handler: async (ctx) => {
    const id = requireSelf(ctx)
    // T-18 audit — documents/letters capped at the 100 most recent (was
    // unbounded; both accumulate over an employee's whole tenure)
    const docs = await db.employeeDocument.findMany({ where: { vendorId: ctx.vendorId, employeeId: id }, orderBy: { createdAt: "desc" }, take: 100 })
    const letters = await db.hrLetter.findMany({
      where: { vendorId: ctx.vendorId, employeeId: id, status: "ISSUED" },
      orderBy: { issuedAt: "desc" },
      take: 100,
    })
    return {
      docs: docs.map((d) => ({ id: d.id, docType: d.docType, title: d.title, status: d.status, verified: d.verified, expiryDate: d.expiryDate })),
      letters,
    }
  },
})

  // INTENTIONALLY_SELF_SCOPED (M-02): ESS self-service: only the caller's own resignation
route("ess.resignation", {
  handler: async (ctx) => {
    const id = requireSelf(ctx)
    const res = await db.resignation.findFirst({ where: { vendorId: ctx.vendorId, employeeId: id }, orderBy: { createdAt: "desc" } })
    if (!res) return null
    const clearance = await db.exitClearance.findFirst({ where: { resignationId: res.id } })
    const settlement = await db.finalSettlement.findFirst({ where: { resignationId: res.id } })
    return {
      resignation: res,
      clearance: clearance ? { ...clearance, checklist: j(clearance.checklistJson, []) } : null,
      settlement: settlement ? { ...settlement, computation: j(settlement.computationJson, {}) } : null,
    }
  },
})

  // INTENTIONALLY_SELF_SCOPED (M-02): ESS self-service: caller's own birthday/anniversary events
route("ess.wishes", {
  handler: async (ctx) => {
    const settings = await getSettings(ctx.vendorId)
    const date = today()
    const mmdd = date.slice(5)
    // Audit Low — privacy gate: any authenticated user could previously read
    // the whole tenant's birthday/anniversary data. Employees now see only
    // their own entry; users with employees.view keep the full board.
    const canSeeAll = ctx.role !== "EMPLOYEE" && ctx.permissions.has("employees.view")
    const emps = await db.employee.findMany({
      where: canSeeAll
        ? { vendorId: ctx.vendorId, status: { in: ["ACTIVE", "PROBATION"] } }
        : { vendorId: ctx.vendorId, id: ctx.employeeId || "__none__", status: { in: ["ACTIVE", "PROBATION"] } },
    })
    const year = Number(date.slice(0, 4))
    const wishes: { name: string; message: string; kind: string }[] = []
    for (const e of emps) {
      if (e.dob && e.dob.slice(5) === mmdd) {
        wishes.push({ name: e.preferredName || e.fullName, kind: "BIRTHDAY", message: settings.wishes.birthdayTemplate.replace(/{{name}}/g, e.preferredName || e.fullName).replace(/{{company}}/g, settings.general.companyName) })
      }
      if (e.joiningDate && e.joiningDate.slice(5) === mmdd) {
        const years = year - Number(e.joiningDate.slice(0, 4))
        const ordinal = years === 1 ? "st" : years === 2 ? "nd" : years === 3 ? "rd" : "th"
        wishes.push({ name: e.preferredName || e.fullName, kind: "ANNIVERSARY", message: settings.wishes.anniversaryTemplate.replace(/{{name}}/g, e.preferredName || e.fullName).replace(/{{years}}/g, String(years)).replace(/{{ordinal}}/g, ordinal).replace(/{{company}}/g, settings.general.companyName) })
      }
    }
    return { wishes }
  },
})

  // INTENTIONALLY_SELF_SCOPED (M-02): ESS self-service: caller's own dashboard stats
route("ess.dashboard", {
  handler: async (ctx) => {
    const id = requireSelf(ctx)
    const month = new Date().getMonth() + 1
    const year = new Date().getFullYear()
    const prefix = `${year}-${String(month).padStart(2, "0")}`
    const [att, leaveBal, tasks, notifs, loans, advances, expenses] = await Promise.all([
      db.attendance.findMany({ where: { vendorId: ctx.vendorId, employeeId: id, date: { startsWith: prefix } } }),
      db.leaveBalance.findMany({ where: { employeeId: id, year } }),
      db.task.findMany({ where: { vendorId: ctx.vendorId, assigneeId: id, status: { in: ["TODO", "IN_PROGRESS", "ON_HOLD"] } } }),
      // 2026-10-13 — same visibility scope as notifications.list: userless
      // rows addressed to the employee's own profile (e.g. the payslip
      // "Salary Processed" notification) must count in the ESS badge too
      db.notification.count({
        where: {
          vendorId: ctx.vendorId,
          OR: [{ userId: ctx.userId }, { userId: null, employeeId: id }],
          readAt: null,
        },
      }),
      db.loan.findMany({ where: { vendorId: ctx.vendorId, employeeId: id, status: "ACTIVE" } }),
      db.advance.findMany({ where: { vendorId: ctx.vendorId, employeeId: id, status: "RECOVERING" } }),
      db.expenseClaim.count({ where: { vendorId: ctx.vendorId, employeeId: id, status: "PENDING" } }),
    ])
    const types = await db.leaveType.findMany({ where: { vendorId: ctx.vendorId } })
    const cas = leaveBal.find((b) => types.find((t) => t.id === b.leaveTypeId)?.code === "CASUAL")
    return {
      attendance: {
        present: att.filter((a) => ["PRESENT", "LATE", "WFH"].includes(a.status)).length,
        late: att.filter((a) => a.status === "LATE").length,
        absent: att.filter((a) => a.status === "ABSENT").length,
        overtimeMinutes: att.reduce((s, a) => s + (a.overtimeMinutes || 0), 0),
      },
      casualRemaining: cas ? spendableDays(cas) : 0,
      openTasks: tasks.length,
      unreadNotifications: notifs,
      activeLoans: loans.length,
      outstandingLoans: loans.reduce((s, l) => s + l.outstanding, 0),
      outstandingAdvances: advances.reduce((s, a) => s + a.outstanding, 0),
      pendingExpenses: expenses,
    }
  },
})

// ---------- ESS-02 (R7) — self-profile edit (whitelisted fields only) ----------
// Photo, phone, alternate phone, personal email, present address and
// emergency contact are the employee's OWN facts — they may now maintain
// them directly (the 2MB client-side photo pipeline is reused verbatim).
// Employment, org, bank, salary and identity-document fields stay HR-only:
// the whitelist below is the entire editable surface, enforced server-side.
// INTENTIONALLY_SELF_SCOPED (M-02 / ESS-02 R7): whitelisted self-edit of
// the caller's OWN profile — the field whitelist is the entire surface.
route("ess.profile.update", {
  handler: async (ctx, p) => {
    const id = requireSelf(ctx)
    const emp = await db.employee.findFirst({ where: { id, vendorId: ctx.vendorId } })
    if (!emp) throw new Deny("Employee not found", 404)

    const data: Record<string, string | null> = {}
    const str = (v: unknown, max: number, label: string): string | null | undefined => {
      if (v === undefined) return undefined
      if (v === null || v === "") return null
      if (typeof v !== "string") throw new Deny(`${label} must be text`, 400)
      const t = v.trim()
      if (!t) return null
      if (t.length > max) throw new Deny(`${label} is too long (max ${max} characters)`, 400)
      return t
    }
    const fields: Array<[string, number]> = [
      ["preferredName", 80], ["mobile", 20], ["altMobile", 20], ["personalEmail", 120],
      ["presentAddress", 300], ["presentDivision", 80], ["presentDistrict", 80], ["presentCity", 80], ["presentPostCode", 16],
      ["emergencyName", 100], ["emergencyRelation", 40], ["emergencyMobile", 20],
    ]
    for (const [f, max] of fields) {
      const v = str((p as any)[f], max, f.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()))
      if (v !== undefined) data[f] = v
    }
    // BD mobile sanity (matches the employee validators' shape; alt fields
    // may hold other formats so the check is shape-only)
    if (data.mobile != null && !/^[0-9+\-\s]{6,20}$/.test(data.mobile)) throw new Deny("Mobile number format is invalid", 400)
    if (data.emergencyMobile != null && !/^[0-9+\-\s]{6,20}$/.test(data.emergencyMobile)) throw new Deny("Emergency mobile format is invalid", 400)
    if (data.personalEmail != null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.personalEmail)) throw new Deny("Personal email format is invalid", 400)

    // Photo — same caps/scheme rule as employees.updatePhoto (2MB/300KB,
    // data-URL or https), and the storage-quota rollup counts the delta.
    let photoData: Record<string, string> | null = null
    if (p.photoUrl !== undefined) {
      if (typeof p.photoUrl !== "string" || !p.photoUrl) throw new Deny("photoUrl must be an image data URL or an https:// URL", 400)
      if (p.photoUrl.length > 2_000_000) throw new Deny("Photo too large (max 2MB). The client should resize before upload.", 400)
      if (!/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(p.photoUrl) && !/^https:\/\/[^\s"']+$/i.test(p.photoUrl)) {
        throw new Deny("photoUrl must be an image data URL or an https:// URL", 400)
      }
      if (p.photoThumb != null && typeof p.photoThumb !== "string") throw new Deny("photoThumb must be a string", 400)
      if (typeof p.photoThumb === "string" && p.photoThumb.length > 300_000) throw new Deny("Photo thumbnail too large (max 300KB)", 400)
      const { requireCapacity } = await import("../saas/entitlements")
      const extra = (p.photoUrl?.length || 0) + (typeof p.photoThumb === "string" ? p.photoThumb.length : 0)
      const oldBytes = (emp.photoUrl?.length || 0) + (emp.photoThumb?.length || 0)
      await requireCapacity(ctx.vendorId, "STORAGE", 0, { extraUsed: Math.max(0, extra - oldBytes) })
      photoData = { photoUrl: p.photoUrl }
      if (typeof p.photoThumb === "string" && p.photoThumb.length > 0) photoData.photoThumb = p.photoThumb
    }

    if (!Object.keys(data).length && !photoData) throw new Deny("Nothing to update", 400)
    const updated = await db.employee.update({ where: { id }, data: { ...data, ...photoData } })
    if (photoData) {
      const { bumpStorageRollup } = await import("../saas/entitlements")
      const oldBytes = (emp.photoUrl?.length || 0) + (emp.photoThumb?.length || 0)
      const newBytes = (updated.photoUrl?.length || 0) + (updated.photoThumb?.length || 0)
      await bumpStorageRollup(ctx.vendorId, newBytes - oldBytes)
    }
    // Audit — old vs new on every touched field (photo logged as "[updated]")
    const changed = Object.keys(data).filter((k) => (data as any)[k] !== (emp as any)[k])
    await audit(ctx, "ess.profile.update", "Employee", id,
      `Self-service profile update by ${emp.fullName} (${[...changed, ...(photoData ? ["photo"] : [])].join(", ") || "no change"})`,
      { oldValue: Object.fromEntries(changed.map((k) => [k, (emp as any)[k]])), newValue: Object.fromEntries(changed.map((k) => [k, (data as any)[k]])) })
    // HR visibility: profile self-edits land in the HR inbox
    const { notify } = await import("../audit")
    if (changed.length || photoData) {
      await notify(ctx.vendorId, { role: "HR_ADMIN" }, "Employee Profile Self-Update",
        `${emp.fullName} (${emp.code || id}) updated their own profile: ${[...changed, ...(photoData ? ["photo"] : [])].join(", ")}.`, "SYSTEM", "employees")
    }
    return { ok: true, updated: [...changed, ...(photoData ? ["photo"] : [])] }
  },
})

// ---------- ESS-06 (R7) — My Assets ----------
// Employees see the equipment assigned to THEM (name, category, condition,
// assigned/return dates, overdue flag) — previously assets only surfaced
// during exit clearance. Read-only: issue/return stays with asset managers.
// INTENTIONALLY_SELF_SCOPED (M-02 / ESS-06 R7): the caller's OWN asset
// assignments; read-only.
route("ess.myAssets", {
  handler: async (ctx) => {
    const id = requireSelf(ctx)
    // T-18 audit — assignment history capped at the 200 most recent (was
    // unbounded; every issue/return pair over the employee's tenure)
    const assignments = await db.assetAssignment.findMany({
      where: { vendorId: ctx.vendorId, employeeId: id },
      orderBy: { assignedAt: "desc" },
      take: 200,
    })
    const assetIds = [...new Set(assignments.map((a) => a.assetId))]
    const assets = assetIds.length
      ? await db.asset.findMany({ where: { vendorId: ctx.vendorId, id: { in: assetIds } } })
      : []
    const assetById = new Map(assets.map((a) => [a.id, a]))
    const now = Date.now()
    return {
      assignments: assignments.map((a) => {
        const asset = assetById.get(a.assetId)
        return {
          id: a.id,
          assetCode: asset?.code || "—",
          assetName: asset?.name || "—",
          category: asset?.category || "OTHER",
          brandModel: asset?.brandModel,
          conditionOut: a.conditionOut,
          conditionIn: a.conditionIn,
          note: a.note,
          assignedAt: a.assignedAt,
          dueAt: a.dueAt,
          returnedAt: a.returnedAt,
          outstanding: !a.returnedAt,
          overdue: !a.returnedAt && !!a.dueAt && a.dueAt.getTime() < now,
        }
      }),
    }
  },
})
