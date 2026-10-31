// ============ Roadmap routes (PDF: HRM-013/014/015/016/4-6/7/8/017 + P2 quick wins) ============
// Tax exemptions CRUD, salary structure templates, overtime management,
// reimbursements, org chart, lifecycle list views, exit document packets,
// commission rule engine, shift auto-roster, payroll reversal register,
// audit-retention cleanup, backup export and employee bulk import.
import { db } from "@/lib/db"
import { route, alias } from "./registry"
import {Deny, employeeScopeFilter} from "../rbac"
import { audit, notify } from "../audit"
import { getSettings } from "../settings"
import {cleanForm, isoDate, today, titleCase, addDays, nextFormattedSeq, resolveWeeklyOffDays, resolveShiftAssignmentForDate} from "../utils"
import { S } from "../validation"
import { z } from "zod"
import { provisionEmployeeUser } from "../employee-provisioning"
import { nextEmployeeCode } from "../employee-code"
import { requireCapacity } from "../saas/entitlements"
import { structurePaisa } from "../money"

// ================= HRM-013 — tax exemptions (rebates / deductions) =================
route("taxExemptions.list", {
  perm: ["ait", "view"],
  handler: async (ctx) => db.taxExemption.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { createdAt: "desc" } }),
})
route("taxExemptions.save", {
  perm: ["ait", "edit"],
  handler: async (ctx, p) => {
    const allowed = ["name", "type", "maxAmount", "percent", "active"]
    const data: any = {}
    for (const k of allowed) if (p[k] !== undefined) data[k] = p[k]
    if (!data.name) throw new Deny("Name is required")
    if (!["REBATE", "DEDUCTION", "FIXED"].includes(data.type || "")) throw new Deny("Type must be REBATE, DEDUCTION or FIXED")
    if (p.id) {
      const existing = await db.taxExemption.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
      if (!existing) throw new Deny("Not found", 404)
      const rec = await db.taxExemption.update({ where: { id: p.id }, data })
      await audit(ctx, "taxExemptions.update", "TaxExemption", p.id, `Updated tax exemption ${rec.name}`, { oldValue: existing, newValue: data })
      return rec
    }
    const rec = await db.taxExemption.create({ data: { vendorId: ctx.vendorId, ...data } })
    await audit(ctx, "taxExemptions.create", "TaxExemption", rec.id, `Created tax exemption ${rec.name}`)
    return rec
  },
})
route("taxExemptions.delete", {
  perm: ["ait", "edit"],
  handler: async (ctx, p) => {
    const existing = await db.taxExemption.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!existing) throw new Deny("Not found", 404)
    await db.taxExemption.delete({ where: { id: p.id } })
    await audit(ctx, "taxExemptions.delete", "TaxExemption", p.id, `Deleted tax exemption ${existing.name}`)
    return { deleted: true }
  },
})

// ================= P1 — salary structure templates =================
route("salaryTemplates.list", {
  perm: ["payroll", "view"],
  handler: async (ctx) => {
    const list = await db.salaryTemplate.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { createdAt: "desc" } })
    const withGross = (t: any) => ({
      ...t,
      gross: ["basic", "houseRent", "medical", "conveyance", "food", "mobileAllow", "internetAllow", "attendanceAllow", "otherAllowance"]
        .reduce((s: number, k: string) => s + Number(t[k] || 0), 0),
    })
    return list.map(withGross)
  },
})
route("salaryTemplates.save", {
  perm: ["payroll", "edit"],
  handler: async (ctx, p) => {
    const fields = ["name", "description", "basic", "houseRent", "medical", "conveyance", "food", "mobileAllow", "internetAllow", "attendanceAllow", "otherAllowance", "componentsJson", "active"]
    const cleaned = cleanForm(p)
    const data: any = {}
    for (const k of fields) if (cleaned[k] !== undefined) data[k] = cleaned[k]
    if (!data.name) throw new Deny("Template name is required")
    // gross is derived (basic + allowances) — the model stores components only
    delete data.gross
    if (typeof data.componentsJson !== "string") data.componentsJson = JSON.stringify(data.componentsJson || [])
    if (p.id) {
      const existing = await db.salaryTemplate.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
      if (!existing) throw new Deny("Not found", 404)
      const rec = await db.salaryTemplate.update({ where: { id: p.id }, data })
      await audit(ctx, "salaryTemplates.update", "SalaryTemplate", p.id, `Updated salary template ${rec.name}`, { oldValue: existing, newValue: data })
      return rec
    }
    const rec = await db.salaryTemplate.create({ data: { vendorId: ctx.vendorId, ...data } })
    await audit(ctx, "salaryTemplates.create", "SalaryTemplate", rec.id, `Created salary template ${rec.name} (gross ৳${data.gross})`)
    return rec
  },
})
route("salaryTemplates.delete", {
  perm: ["payroll", "edit"],
  handler: async (ctx, p) => {
    const existing = await db.salaryTemplate.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!existing) throw new Deny("Not found", 404)
    await db.salaryTemplate.delete({ where: { id: p.id } })
    await audit(ctx, "salaryTemplates.delete", "SalaryTemplate", p.id, `Deleted salary template ${existing.name}`)
    return { deleted: true }
  },
})
/** Apply a template to an employee: supersedes the current structure as of the given date. */
route("salaryTemplates.apply", {
  perm: ["payroll", "edit"],
  handler: async (ctx, p) => {
    const tpl = await db.salaryTemplate.findFirst({ where: { id: p.templateId, vendorId: ctx.vendorId } })
    if (!tpl) throw new Deny("Template not found", 404)
    const emp = await db.employee.findFirst({ where: { id: p.employeeId, vendorId: ctx.vendorId } })
    if (!emp) throw new Deny("Employee not found", 404)
    const effectiveFrom = p.effectiveFrom || today()
    // M-14 — the old structure ends the day BEFORE the new one starts (the
    // previous code set effectiveTo = effectiveFrom, leaving the final day of
    // the old structure double-covered by both rows).
    const effectiveTo = addDays(effectiveFrom, -1)
    const current = await db.salaryStructure.findFirst({ where: { vendorId: ctx.vendorId, employeeId: emp.id, status: "ACTIVE", effectiveTo: null } })
    await db.salaryStructure.updateMany({
      where: { vendorId: ctx.vendorId, employeeId: emp.id, status: "ACTIVE", effectiveTo: null },
      data: { status: "SUPERSEDED", effectiveTo },
    })
    // PAY-03 — gross must include the template's CUSTOM components (the payslip
    // earnings render them, so a gross without them broke the H-8 line-sum
    // parity: lines summed above gross), and the write carries the paisa
    // dual-write via the shared helper — same convention as
    // salaryStructures.save (this path previously wrote Float-only rows).
    const comps = ["basic", "houseRent", "medical", "conveyance", "food", "mobileAllow", "internetAllow", "attendanceAllow", "otherAllowance"] as const
    const data: Record<string, number | string> = {}
    let gross = 0
    for (const f of comps) {
      const v = Number((tpl as any)[f] || 0)
      data[f] = v
      gross += v
    }
    const extras: { label: string; amount: number }[] = (() => { try { return JSON.parse(tpl.componentsJson || "[]") } catch { return [] } })()
    gross += extras.reduce((s, c) => s + Number(c.amount || 0), 0)
    data.gross = Math.round(gross)
    data.componentsJson = JSON.stringify(extras)
    Object.assign(data, structurePaisa(data as any))
    const rec = await db.salaryStructure.create({
      data: {
        vendorId: ctx.vendorId, employeeId: emp.id, effectiveFrom,
        ...data, status: "ACTIVE", createdBy: ctx.userId,
      } as any,
    })
    // PAY-03 — the template path records the same salary-revision history row
    // the direct-edit path does (the 360° profile's Salary Revisions card and
    // the audit trail stay complete on every structure change).
    if (current) {
      await db.salaryRevision.create({
        data: {
          vendorId: ctx.vendorId, employeeId: emp.id,
          previousSalary: current.gross, newSalary: Number(data.gross),
          increaseAmount: Number(data.gross) - current.gross,
          increasePercent: current.gross > 0 ? Math.round(((Number(data.gross) - current.gross) / current.gross) * 1000) / 10 : 0,
          effectiveDate: effectiveFrom, reason: `Template applied: ${tpl.name}`, type: "STRUCTURE_CHANGE", status: "APPROVED", approvedBy: ctx.userId,
        },
      })
    }
    await db.employeeHistory.create({
      data: { vendorId: ctx.vendorId, employeeId: emp.id, eventType: "SALARY_REVISION",
        title: "Salary structure set from template",
        description: `Applied template "${tpl.name}" (gross ৳${rec.gross})`, effectiveDate: effectiveFrom, createdBy: ctx.userId },
    })
    await audit(ctx, "salaryTemplates.apply", "SalaryStructure", rec.id, `Applied template "${tpl.name}" to ${emp.fullName} (${emp.code}) effective ${effectiveFrom}`)
    return rec
  },
})

// ================= HRM-014 — Overtime Management =================
/** OT register for a period with day-type tiers, cost preview and approval state. */
route("overtime.list", {
  perm: ["attendance", "view"],
  handler: async (ctx, p) => {
    const month = p?.month || today().slice(0, 7)
    const from = `${month}-01`, to = `${month}-31`
    const where: any = { vendorId: ctx.vendorId, date: { gte: from, lte: to }, overtimeMinutes: { gt: 0 } }
    if (p?.employeeId) where.employeeId = p.employeeId
    else {
      const scope = employeeScopeFilter(ctx)
      where.employeeId = { in: (await db.employee.findMany({ where: scope, select: { id: true } })).map((e) => e.id) }
    }
    const recs = await db.attendance.findMany({ where, orderBy: { date: "asc" } })
    const employees = await db.employee.findMany({ where: { vendorId: ctx.vendorId } })
    const settings = await getSettings(ctx.vendorId)
    // 2026-10-13 — canonical weekly-off precedence (employee > shift > global
    // policy): batched shift lookup for the tier resolution below
    const shiftRows = await db.shift.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, weeklyOff: true, otHolidayMultiplier: true, otWeeklyOffMultiplier: true, otMultiplier: true } })
    const otRates = settings.otRates || { weekdayRate: 1.5, holidayRate: 2, weeklyOffRate: 2 } as any
    const holidays = await db.holiday.findMany({ where: { vendorId: ctx.vendorId, date: { gte: from, lte: to } } })
    // ATT-009 — branch-aware holiday set: branchId null = tenant-wide,
    // otherwise only that branch's employees see the holiday tier (parity
    // with the payroll engine's holidaysOf(branchId))
    const holidayFor = (branchId: string | null, date: string) =>
      holidays.some((h) => h.date === date && (!h.branchId || h.branchId === branchId))
    // ATT-008 — per-date shift assignments for rotating employees
    const assignments = await db.shiftAssignment.findMany({
      where: { vendorId: ctx.vendorId, fromDate: { lte: to }, OR: [{ toDate: null }, { toDate: { gte: from } }] },
      orderBy: { fromDate: "desc" },
    })
    const assignmentsByEmp = new Map<string, typeof assignments>()
    for (const a of assignments) {
      const list = assignmentsByEmp.get(a.employeeId)
      if (list) list.push(a); else assignmentsByEmp.set(a.employeeId, [a])
    }
    const wd = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"]
    const out = recs.map((r) => {
      const emp = employees.find((e) => e.id === r.employeeId)
      const dow = wd[new Date(`${r.date}T00:00:00Z`).getUTCDay()]
      // ATT-008 — the shift THE EMPLOYEE WORKED THAT DATE (assignment
      // covering the date, falling back to the default shift), not always
      // the default shift
      const dayShiftId = resolveShiftAssignmentForDate(assignmentsByEmp.get(r.employeeId), emp?.shiftId, r.date)
      const dayShift = shiftRows.find((s) => s.id === dayShiftId)
      const empOffs = resolveWeeklyOffDays(emp?.weeklyOff, dayShift?.weeklyOff, settings.general.weeklyHoliday)
      const tier = holidayFor(emp?.branchId || null, r.date) ? "holiday" : empOffs.includes(dow) ? "weekly-off" : "weekday"
      const multiplier = tier === "holiday" ? (dayShift?.otHolidayMultiplier ?? otRates.holidayRate) : tier === "weekly-off" ? (dayShift?.otWeeklyOffMultiplier ?? otRates.weeklyOffRate) : (dayShift?.otMultiplier ?? otRates.weekdayRate)
      const hourRate = (p?.basicByEmployee?.[r.employeeId] || 0) / 208
      const cost = Math.round((r.overtimeMinutes / 60) * hourRate * multiplier)
      return {
        id: r.id, date: r.date, employeeId: r.employeeId,
        employeeName: emp?.fullName || "—", employeeCode: emp?.code,
        branchId: emp?.branchId || null, departmentId: emp?.departmentId || null,
        shiftId: r.shiftId, checkIn: r.checkIn, checkOut: r.checkOut,
        overtimeMinutes: r.overtimeMinutes, otApproved: r.otApproved,
        status: r.status, tier, multiplier, estCost: cost, source: r.source,
      }
    })
    const totalMinutes = out.reduce((s, r) => s + r.overtimeMinutes, 0)
    const pendingCount = out.filter((r) => r.otApproved === false).length
    return { month, rows: out, totalMinutes, pendingCount, otApprovalRequired: settings.shift.otApprovalRequired, maxOtHoursPerMonth: settings.shift.maxOtHoursPerMonth, otRates }
  },
})
/** Submit one or more OT days through the approval engine (process type OVERTIME). */
route("overtime.submit", {
  perm: ["attendance", "edit"],
  handler: async (ctx, p) => {
    const ids: string[] = p.ids || (p.id ? [p.id] : [])
    if (!ids.length) throw new Deny("No overtime records selected")
    const recs = await db.attendance.findMany({ where: { id: { in: ids }, vendorId: ctx.vendorId } })
    if (!recs.length) throw new Deny("Records not found", 404)
    // ATT-010 — one approval, one employee: a mixed-employee id set used to
    // submit under the FIRST employee's name while the decision flipped
    // otApproved on EVERY selected row (approving person A silently approved
    // person B's OT). Refuse loudly instead.
    const distinctEmployees = new Set(recs.map((r) => r.employeeId))
    if (distinctEmployees.size > 1) {
      throw new Deny(`Selected overtime records span ${distinctEmployees.size} employees — submit each employee's overtime separately (one approval per employee)`)
    }
    const totalOt = recs.reduce((s, r) => s + (r.overtimeMinutes || 0), 0)
    const emp = await db.employee.findFirst({ where: { id: recs[0].employeeId, vendorId: ctx.vendorId } })
    const { submitForApproval } = await import("../approval")
    const approvalId = await submitForApproval(ctx, "OVERTIME", "Attendance", recs[0].id,
      `Overtime — ${emp?.fullName || ""} (${(totalOt / 60).toFixed(1)}h, ${recs.length} day(s))`,
      { employeeId: recs[0].employeeId, amount: totalOt / 60, attendanceIds: ids })
    await db.attendance.updateMany({ where: { id: { in: ids }, vendorId: ctx.vendorId }, data: { otApproved: false } })
    await audit(ctx, "overtime.submit", "Attendance", recs[0].id, `Submitted ${(totalOt / 60).toFixed(1)}h overtime for approval (${ids.length} day(s))`)
    return { approvalId, submitted: ids.length }
  },
})
/** OVERTIME finalize hook — approved OT becomes payroll-payable. */
export async function applyOvertimeDecision(ctx: { userId: string; userName: string; vendorId: string }, approvalRequestId: string, decision: string, attendanceIds: string[]) {
  const approved = decision === "APPROVED"
  await db.attendance.updateMany({ where: { id: { in: attendanceIds }, vendorId: ctx.vendorId }, data: { otApproved: approved } })
  const recs = await db.attendance.findMany({ where: { id: { in: attendanceIds }, vendorId: ctx.vendorId } })
  const totalOt = recs.reduce((s, r) => s + (r.overtimeMinutes || 0), 0)
  if (recs.length) {
    await notify(ctx.vendorId, { employeeId: recs[0].employeeId }, approved ? "Overtime Approved" : "Overtime Rejected",
      `${(totalOt / 60).toFixed(1)} hour(s) of overtime were ${approved ? "approved" : "rejected"}.`, "ATTENDANCE", "attendance")
  }
  await audit(ctx as any, "overtime.decision", "Attendance", recs[0]?.id || approvalRequestId,
    `Overtime ${decision} (${(totalOt / 60).toFixed(1)}h across ${recs.length} day(s))`)
}

// ================= HRM-015 — Reimbursements =================
route("reimbursements.list", {
  perm: ["expenses", "view"],
  handler: async (ctx, p) => {
    const where: any = { vendorId: ctx.vendorId, status: { in: ["APPROVED", "REIMBURSED"] } }
    if (p?.status === "PENDING") {
      where.status = "APPROVED"
      where.reimbursementDate = null
    }
    if (p?.status === "REIMBURSED") where.reimbursementDate = { not: null }
    if (p?.employeeId) where.employeeId = p.employeeId
    else {
      const scope = employeeScopeFilter(ctx)
      where.employeeId = { in: (await db.employee.findMany({ where: scope, select: { id: true } })).map((e) => e.id) }
    }
    if (p?.month) where.date = { gte: `${p.month}-01`, lte: `${p.month}-31` }
    // V1-002 — exclude large receiptData bytes from list payloads.
    // T-10 (2026-10-30): this handler used to return the { items, total, … }
    // envelope UNCONDITIONALLY, which broke every legacy caller — the web
    // reimbursements register renders `rows.filter(...)` off the raw result
    // and crashed ("rows.filter is not a function"), and FIN-02 failed the
    // same way. Restored the MOD-16 dual-mode convention used by every other
    // paginated list: explicit page/pageSize → paged envelope; absent → the
    // legacy full-array contract (still without receiptData bytes).
    const paged = p?.page != null || p?.pageSize != null
    const pageSize = Math.min(200, Math.max(1, Number(p?.pageSize) || 100))
    const page = Math.max(1, Number(p?.page) || 1)
    const listSelect = {
      id: true, vendorId: true, employeeId: true, category: true, title: true,
      amount: true, approvedAmount: true, date: true, description: true,
      branchId: true, projectRef: true, receiptName: true, paymentMethod: true,
      status: true, reimbursementDate: true, approvalRequestId: true,
      approvedBy: true, actedAt: true, journalId: true, createdAt: true,
    } as const
    const [list, total] = await Promise.all([
      paged
        ? db.expenseClaim.findMany({ where, orderBy: [{ date: "desc" }, { id: "asc" }], skip: (page - 1) * pageSize, take: pageSize, select: listSelect })
        : db.expenseClaim.findMany({ where, orderBy: { date: "desc" }, select: listSelect }),
      paged ? db.expenseClaim.count({ where }) : Promise.resolve(null as unknown as number),
    ])
    const empIds = [...new Set(list.map((c) => c.employeeId))]
    const employees = empIds.length
      ? await db.employee.findMany({ where: { vendorId: ctx.vendorId, id: { in: empIds } }, select: { id: true, fullName: true, code: true } })
      : []
    const empById = new Map(employees.map((e) => [e.id, e]))
    const items = list.map((c) => ({
      ...c,
      employeeName: empById.get(c.employeeId)?.fullName || "—",
      employeeCode: empById.get(c.employeeId)?.code,
      reimbursementStatus: c.reimbursementDate ? "REIMBURSED" : "APPROVED",
    }))
    return paged ? { items, total, page, pageSize } : items
  },
})
/** Mark an approved claim reimbursed: stamps the date, posts the cash journal. */
route("reimbursements.mark", {
  // FIN-02 — this is the PAYOUT action of the one-model reimbursement flow;
  // it was gated on expenses.edit, a verb NO role template carries (the
  // action was permission-orphaned). The payout verb is expenses.pay
  // (HR_ADMIN/VENDOR_OWNER/PAYROLL_OFFICER carry it; approvers without it
  // cannot move money).
  perm: ["expenses", "pay"],
  handler: async (ctx, p) => {
    // R2b-002 — idempotency / double-click guard: use atomic updateMany with
    // a status filter so the second concurrent request finds 0 rows updated and
    // throws 404 instead of posting a duplicate journal entry.
    const date = p.reimbursementDate || today()
    const claimed = await db.expenseClaim.updateMany({
      where: { id: p.id, vendorId: ctx.vendorId, status: "APPROVED", reimbursementDate: null },
      data: { status: "REIMBURSED", reimbursementDate: date },
    })
    if (claimed.count === 0) throw new Deny("Approved expense claim not found or already reimbursed", 404)
    const claim = await db.expenseClaim.findUnique({ where: { id: p.id } })
    if (!claim) throw new Deny("Expense claim not found", 404)
    const amount = claim.approvedAmount ?? claim.amount
    const { postJournal } = await import("../accounting")
    // FIN-02 — the payout journal is the ONLY journal in the reimbursement
    // model (approval posts nothing): expense recognized and cash leaves in
    // one balanced entry, on the chart's real accounts (5300 expense /
    // 1010 cash — the old 6300/1100 codes existed in no chart).
    const journalId = await postJournal(ctx, "EXPENSE_REIMBURSEMENT", claim.id, date,
      `Reimbursement — ${claim.title}`,
      [
        { account: "5300", accountName: "Employee Expense / Reimbursement", debit: amount },
        { account: "1010", accountName: "Cash on Hand", credit: amount },
      ], amount)
    const rec = await db.expenseClaim.update({
      where: { id: claim.id },
      data: { journalId },
    })
    await audit(ctx, "reimbursements.mark", "ExpenseClaim", claim.id, `Reimbursed "${claim.title}" ৳${amount} (journal ${journalId})`)
    await notify(ctx.vendorId, { employeeId: claim.employeeId }, "Expense Reimbursed",
      `Your expense "${claim.title}" (৳${amount}) was reimbursed on ${date}.`, "EXPENSE", "ess")
    return rec
  },
})

// ================= HRM-016 — Org Chart =================
route("orgChart.data", {
  perm: ["employees", "view"],
  handler: async (ctx) => {
    const where: any = employeeScopeFilter(ctx)
    where.status = { in: ["ACTIVE", "PROBATION", "ON_LEAVE", "SUSPENDED", "NOTICE_PERIOD"] }
    const employees = await db.employee.findMany({
      where,
      select: {
        id: true, code: true, fullName: true, designationId: true, departmentId: true, branchId: true,
        reportingManagerId: true, status: true, photoUrl: true, photoThumb: true, employmentType: true, joiningDate: true,
      },
    })
    const [designations, departments, branches, jobOpenings] = await Promise.all([
      db.designation.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { name: "asc" } }),
      db.department.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { name: "asc" } }),
      db.branch.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { name: "asc" } }),
      db.jobOpening.findMany({ where: { vendorId: ctx.vendorId, status: "OPEN" }, orderBy: { createdAt: "desc" } }),
    ])
    const nodes = employees.map((e) => ({
      id: e.id, code: e.code, name: e.fullName,
      designation: designations.find((d) => d.id === e.designationId)?.name || "—",
      designationId: e.designationId || null,
      department: departments.find((d) => d.id === e.departmentId)?.name || null,
      departmentId: e.departmentId || null,
      branch: branches.find((b) => b.id === e.branchId)?.name || null,
      branchId: e.branchId || null,
      managerId: e.reportingManagerId || null, status: e.status,
      photoUrl: e.photoThumb || e.photoUrl || null, employmentType: e.employmentType, joiningDate: e.joiningDate,
    }))
    // orphan guard: any manager reference not present in scope renders at the roots
    const ids = new Set(nodes.map((n) => n.id))
    const roots = nodes.filter((n) => !n.managerId || !ids.has(n.managerId)).map((n) => n.id)

    // Calculate depth and span of control
    const reportsMap = new Map<string, string[]>()
    nodes.forEach((n) => {
      if (n.managerId && ids.has(n.managerId)) {
        const arr = reportsMap.get(n.managerId) || []
        arr.push(n.id)
        reportsMap.set(n.managerId, arr)
      }
    })

    const managerCount = reportsMap.size
    const totalReports = Array.from(reportsMap.values()).reduce((sum, arr) => sum + arr.length, 0)
    const avgSpanOfControl = managerCount > 0 ? Number((totalReports / managerCount).toFixed(1)) : 0

    const memoDepth = new Map<string, number>()
    const getDepth = (id: string, visited: Set<string>): number => {
      if (visited.has(id)) return 1
      if (memoDepth.has(id)) return memoDepth.get(id) ?? 1
      visited.add(id)
      const children = reportsMap.get(id) || []
      if (children.length === 0) {
        memoDepth.set(id, 1)
        return 1
      }
      let maxChild = 0
      for (const ch of children) {
        maxChild = Math.max(maxChild, getDepth(ch, new Set(visited)))
      }
      const d = 1 + maxChild
      memoDepth.set(id, d)
      return d
    }

    let maxDepth = 1
    for (const r of roots) {
      maxDepth = Math.max(maxDepth, getDepth(r, new Set()))
    }

    const orphanCount = nodes.filter((n) => !n.managerId && !roots.includes(n.id)).length
    const vacanciesCount = jobOpenings.reduce((sum, j) => sum + (j.openings || 1), 0)

    // Load saved layout positions for all modes
    const layoutSettings = await db.hrSetting.findMany({
      where: {
        vendorId: ctx.vendorId,
        group: "organogram",
        key: { in: ["reporting-layout", "department-layout", "designation-layout", "branch-layout"] },
      },
    })
    const layouts: Record<string, Record<string, { x: number; y: number }>> = {}
    for (const row of layoutSettings) {
      try {
        const parsed = JSON.parse(row.value)
        const modeKey = row.key.replace("-layout", "")
        if (parsed && typeof parsed === "object" && parsed.positions) {
          layouts[modeKey] = parsed.positions
        } else {
          layouts[modeKey] = parsed
        }
      } catch {}
    }

    return {
      nodes,
      roots,
      stats: {
        total: nodes.length,
        roots: roots.length,
        maxDepth,
        avgSpanOfControl,
        orphanCount,
        vacanciesCount,
        departmentsCount: departments.length,
        designationsCount: designations.length,
      },
      departments,
      designations,
      branches,
      jobOpenings,
      layout: layouts.department || layouts.reporting || null,
      layouts,
    }
  },
})

// ================= Organogram — designation-based hierarchy =================
route("orgChart.organogram", {
  perm: ["employees", "view"],
  handler: async (ctx) => {
    const [designations, departments, employees, branches] = await Promise.all([
      db.designation.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { name: "asc" } }),
      db.department.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { createdAt: "asc" } }),
      db.employee.findMany({
        where: { ...employeeScopeFilter(ctx), status: { in: ["ACTIVE", "PROBATION", "ON_LEAVE", "SUSPENDED", "NOTICE_PERIOD"] } },
        select: { id: true, fullName: true, code: true, designationId: true, departmentId: true, status: true },
      }),
      db.branch.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { name: "asc" } }),
    ])
    // designation usage inside the CALLER's visibility scope only
    const holderCount = new Map<string, number>()
    const holdersByDesig = new Map<string, { id: string; name: string; code: string; status: string }[]>()
    for (const e of employees) {
      if (e.designationId) {
        holderCount.set(e.designationId, (holderCount.get(e.designationId) || 0) + 1)
        const list = holdersByDesig.get(e.designationId) || []
        list.push({ id: e.id, name: e.fullName, code: e.code, status: e.status })
        holdersByDesig.set(e.designationId, list)
      }
    }
    const departmentIds = new Set(departments.map((d) => d.id))

    const layoutRow = await db.hrSetting.findFirst({
      where: { vendorId: ctx.vendorId, group: "organogram", key: "structure-layout" },
    })
    let layout: Record<string, { x: number; y: number }> | null = null
    if (layoutRow?.value) {
      try { layout = JSON.parse(layoutRow.value) } catch {}
    }

    return {
      departments: departments.map((d) => ({
        id: d.id, name: d.name, code: d.code, status: d.status, headId: d.headId,
        designations: designations
          .filter((x) => x.departmentId === d.id)
          .map((x) => ({
            id: x.id, name: x.name, code: x.code, grade: x.grade || null,
            holders: holderCount.get(x.id) || 0,
            employees: holdersByDesig.get(x.id) || [],
          })),
      })),
      unassigned: designations
        .filter((x) => !x.departmentId || !departmentIds.has(x.departmentId))
        .map((x) => ({
          id: x.id, name: x.name, code: x.code, grade: x.grade || null,
          holders: holderCount.get(x.id) || 0,
          employees: holdersByDesig.get(x.id) || [],
        })),
      allDesignations: designations,
      allDepartments: departments,
      allBranches: branches,
      layout,
    }
  },
})

// ================= Organogram Visual Editor Backend APIs =================
route("orgChart.saveLayout", {
  perm: ["employees", "edit"],
  altPerm: ["organization", "edit"],
  handler: async (ctx, p) => {
    const mode = p?.mode || "reporting"
    const key = `${mode}-layout`
    const layout = p?.layout || {}
    const edges = p?.edges || []
    const isPublish = !!p?.isPublish
    const payload = {
      positions: layout,
      edges,
      published: isPublish,
      publishedAt: isPublish ? new Date().toISOString() : undefined,
      updatedAt: new Date().toISOString(),
    }
    const existing = await db.hrSetting.findFirst({
      where: { vendorId: ctx.vendorId, group: "organogram", key },
    })
    if (existing) {
      await db.hrSetting.update({ where: { id: existing.id }, data: { value: JSON.stringify(payload) } })
    } else {
      await db.hrSetting.create({
        data: { vendorId: ctx.vendorId, group: "organogram", key, value: JSON.stringify(payload) },
      })
    }
    await audit(ctx, "orgChart.saveLayout", "HrSetting", null, `${isPublish ? "Published" : "Saved"} organogram layout (${mode})`)
    return { ok: true, published: isPublish }
  },
})

route("orgChart.batchSetReporting", {
  perm: ["employees", "edit"],
  altPerm: ["organization", "edit"],
  handler: async (ctx, p) => {
    const updates: { employeeId: string; managerId: string | null }[] = p?.updates || []
    if (!Array.isArray(updates) || updates.length === 0) {
      throw new Deny("No hierarchy updates provided", 400)
    }

    const results: any[] = []
    for (const item of updates) {
      const { employeeId, managerId } = item
      if (!employeeId) continue
      const emp = await db.employee.findFirst({ where: { id: employeeId, vendorId: ctx.vendorId } })
      if (!emp) continue

      if (managerId) {
        if (managerId === employeeId) continue
        const mgr = await db.employee.findFirst({ where: { id: managerId, vendorId: ctx.vendorId } })
        if (!mgr) continue

        // Cycle detection: ensure employeeId is not in the ancestor chain of managerId
        let current: string | null = managerId
        const visited = new Set<string>([employeeId])
        let hasCycle = false
        while (current) {
          if (visited.has(current)) {
            hasCycle = true
            break
          }
          visited.add(current)
          const parentEmp: { reportingManagerId: string | null } | null = await db.employee.findUnique({
            where: { id: current },
            select: { reportingManagerId: true },
          })
          current = parentEmp?.reportingManagerId || null
        }
        if (hasCycle) continue
      }

      await db.employee.update({
        where: { id: employeeId },
        data: { reportingManagerId: managerId || null },
      })
      results.push({ employeeId, managerId })
    }

    await audit(ctx, "orgChart.batchSetReporting", "Employee", null, `Batch updated reporting hierarchy for ${results.length} employees`)
    return { ok: true, updatedCount: results.length }
  },
})

route("orgChart.setReportingManager", {
  perm: ["employees", "edit"],
  altPerm: ["organization", "edit"],
  handler: async (ctx, p) => {
    const { employeeId, managerId } = p
    if (!employeeId) throw new Deny("Employee ID is required", 400)
    const emp = await db.employee.findFirst({ where: { id: employeeId, vendorId: ctx.vendorId } })
    if (!emp) throw new Deny("Employee not found", 404)

    if (managerId) {
      if (managerId === employeeId) throw new Deny("An employee cannot report to themselves", 400)
      const mgr = await db.employee.findFirst({ where: { id: managerId, vendorId: ctx.vendorId } })
      if (!mgr) throw new Deny("Manager not found", 404)

      // Cycle detection: ensure employeeId is not in the ancestor chain of managerId
      let current: string | null = managerId
      const visited = new Set<string>([employeeId])
      while (current) {
        if (visited.has(current)) {
          throw new Deny(`Cannot set ${mgr.fullName} as manager: it would create a circular reporting loop`, 400)
        }
        visited.add(current)
        const parentEmp: { reportingManagerId: string | null } | null = await db.employee.findUnique({
          where: { id: current },
          select: { reportingManagerId: true },
        })
        current = parentEmp?.reportingManagerId || null
      }
    }

    const oldManager = emp.reportingManagerId
      ? await db.employee.findUnique({ where: { id: emp.reportingManagerId }, select: { fullName: true } })
      : null
    const newManager = managerId
      ? await db.employee.findUnique({ where: { id: managerId }, select: { fullName: true } })
      : null

    const updated = await db.employee.update({
      where: { id: employeeId },
      data: { reportingManagerId: managerId || null },
    })

    const note = managerId
      ? `Changed manager of ${emp.fullName} from ${oldManager?.fullName || "None"} to ${newManager?.fullName || managerId}`
      : `Removed reporting manager from ${emp.fullName} (now a chart root)`

    await db.employeeHistory.create({
      data: {
        vendorId: ctx.vendorId,
        employeeId: emp.id,
        eventType: "GENERAL_UPDATE",
        title: "Reporting Line Updated",
        description: note,
        effectiveDate: today(),
        createdBy: ctx.userId,
      },
    })
    await audit(ctx, "orgChart.setReportingManager", "Employee", emp.id, note)
    return { ok: true, employee: updated }
  },
})

route("orgChart.reassignEmployee", {
  perm: ["employees", "edit"],
  altPerm: ["organization", "edit"],
  handler: async (ctx, p) => {
    const { employeeId, departmentId, designationId, branchId, reportingManagerId } = p
    if (!employeeId) throw new Deny("Employee ID is required", 400)
    const emp = await db.employee.findFirst({ where: { id: employeeId, vendorId: ctx.vendorId } })
    if (!emp) throw new Deny("Employee not found", 404)

    if (departmentId) {
      const d = await db.department.findFirst({ where: { id: departmentId, vendorId: ctx.vendorId } })
      if (!d) throw new Deny("Department not found", 404)
    }
    if (designationId) {
      const d = await db.designation.findFirst({ where: { id: designationId, vendorId: ctx.vendorId } })
      if (!d) throw new Deny("Designation not found", 404)
    }
    if (branchId) {
      const b = await db.branch.findFirst({ where: { id: branchId, vendorId: ctx.vendorId } })
      if (!b) throw new Deny("Branch not found", 404)
    }

    if (reportingManagerId !== undefined && reportingManagerId !== null) {
      if (reportingManagerId === employeeId) throw new Deny("An employee cannot report to themselves", 400)
      let current: string | null = reportingManagerId
      const visited = new Set<string>([employeeId])
      while (current) {
        if (visited.has(current)) {
          throw new Deny("Circular reporting loop detected", 400)
        }
        visited.add(current)
        const parent = await db.employee.findUnique({
          where: { id: current },
          select: { reportingManagerId: true },
        })
        current = parent?.reportingManagerId || null
      }
    }

    const data: any = {}
    if (departmentId !== undefined) data.departmentId = departmentId || null
    if (designationId !== undefined) data.designationId = designationId || null
    if (branchId !== undefined) data.branchId = branchId || null
    if (reportingManagerId !== undefined) data.reportingManagerId = reportingManagerId || null

    const updated = await db.employee.update({
      where: { id: employeeId },
      data,
    })

    await audit(ctx, "orgChart.reassignEmployee", "Employee", emp.id, `Reassigned employee ${emp.fullName} via Organogram Designer`)
    return { ok: true, employee: updated }
  },
})

route("orgChart.assignDesignationDepartment", {
  perm: ["organization", "edit"],
  altPerm: ["employees", "edit"],
  handler: async (ctx, p) => {
    const { designationId, departmentId } = p
    if (!designationId) throw new Deny("Designation ID is required", 400)
    const desig = await db.designation.findFirst({ where: { id: designationId, vendorId: ctx.vendorId } })
    if (!desig) throw new Deny("Designation not found", 404)

    if (departmentId) {
      const dept = await db.department.findFirst({ where: { id: departmentId, vendorId: ctx.vendorId } })
      if (!dept) throw new Deny("Department not found", 404)
    }

    const updated = await db.designation.update({
      where: { id: designationId },
      data: { departmentId: departmentId || null },
    })

    await audit(ctx, "orgChart.assignDesignationDepartment", "Designation", desig.id,
      `Assigned designation ${desig.name} to department ${departmentId || "None"} via Organogram Designer`)
    return { ok: true, designation: updated }
  },
})

// ================= Designation-Only Organogram =================
route("orgChart.desigChart.data", {
  perm: ["employees", "view"],
  handler: async (ctx) => {
    const [designations, departments, empCounts, hierarchyRow] = await Promise.all([
      db.designation.findMany({
        where: { vendorId: ctx.vendorId, status: "ACTIVE" },
        orderBy: { name: "asc" },
      }),
      db.department.findMany({
        where: { vendorId: ctx.vendorId },
        select: { id: true, name: true, code: true },
        orderBy: { name: "asc" },
      }),
      db.employee.groupBy({
        by: ["designationId"],
        where: {
          vendorId: ctx.vendorId,
          status: { in: ["ACTIVE", "PROBATION"] },
          designationId: { not: null },
        },
        _count: { id: true },
      }),
      db.hrSetting.findFirst({
        where: { vendorId: ctx.vendorId, group: "organogram", key: "designation-hierarchy" },
      }),
    ])

    const deptMap = new Map(departments.map((d) => [d.id, d]))
    const countMap = new Map<string, number>()
    for (const row of empCounts) {
      if (row.designationId) countMap.set(row.designationId, row._count.id)
    }

    let hierarchy: { nodes: string[]; edges: { from: string; to: string }[] } = { nodes: [], edges: [] }
    if (hierarchyRow?.value) {
      try {
        hierarchy = JSON.parse(hierarchyRow.value)
      } catch {}
    }

    const desigNodes = designations.map((d) => ({
      id: d.id,
      code: d.code,
      name: d.name,
      grade: d.grade ?? null,
      departmentId: d.departmentId ?? null,
      department: d.departmentId ? (deptMap.get(d.departmentId)?.name ?? null) : null,
      employeeCount: countMap.get(d.id) ?? 0,
    }))

    return {
      designations: desigNodes,
      departments: departments.map((d) => ({ id: d.id, name: d.name, code: d.code })),
      hierarchy,
    }
  },
})

route("orgChart.desigChart.saveHierarchy", {
  perm: ["employees", "edit"],
  altPerm: ["organization", "edit"],
  handler: async (ctx, p) => {
    const nodes: string[] = Array.isArray(p?.nodes) ? p.nodes : []
    const edges: { from: string; to: string }[] = Array.isArray(p?.edges) ? p.edges : []
    const payload = JSON.stringify({ nodes, edges })

    const existing = await db.hrSetting.findFirst({
      where: { vendorId: ctx.vendorId, group: "organogram", key: "designation-hierarchy" },
    })
    if (existing) {
      await db.hrSetting.update({ where: { id: existing.id }, data: { value: payload } })
    } else {
      await db.hrSetting.create({
        data: { vendorId: ctx.vendorId, group: "organogram", key: "designation-hierarchy", value: payload },
      })
    }

    await audit(ctx, "orgChart.desigChart.saveHierarchy", "HrSetting", null, "Saved designation organogram hierarchy")
    return { ok: true }
  },
})

// ================= 4-6/4-7/4-8 — Lifecycle list views =================
route("promotions.list", {
  perm: ["employees", "view"],
  handler: async (ctx, p) => {
    const scope = employeeScopeFilter(ctx)
    const empIds = p?.employeeId ? [p.employeeId] : (await db.employee.findMany({ where: scope, select: { id: true } })).map((e) => e.id)
    const list = await db.promotion.findMany({ where: { vendorId: ctx.vendorId, employeeId: { in: empIds } }, orderBy: { effectiveDate: "desc" } })
    const employees = await db.employee.findMany({ where: { vendorId: ctx.vendorId } })
    const designations = await db.designation.findMany({ where: { vendorId: ctx.vendorId } })
    return list.map((x) => ({
      ...x,
      employeeName: employees.find((e) => e.id === x.employeeId)?.fullName || "—",
      employeeCode: employees.find((e) => e.id === x.employeeId)?.code,
      fromTitle: designations.find((d) => d.id === x.oldDesignationId)?.name,
      toTitle: designations.find((d) => d.id === x.newDesignationId)?.name,
    }))
  },
})
route("transfers.list", {
  perm: ["employees", "view"],
  handler: async (ctx, p) => {
    const scope = employeeScopeFilter(ctx)
    const empIds = p?.employeeId ? [p.employeeId] : (await db.employee.findMany({ where: scope, select: { id: true } })).map((e) => e.id)
    const list = await db.transfer.findMany({ where: { vendorId: ctx.vendorId, employeeId: { in: empIds } }, orderBy: { effectiveDate: "desc" } })
    const employees = await db.employee.findMany({ where: { vendorId: ctx.vendorId } })
    const branches = await db.branch.findMany({ where: { vendorId: ctx.vendorId } })
    const departments = await db.department.findMany({ where: { vendorId: ctx.vendorId } })
    const branchName = (id: string | null) => branches.find((b) => b.id === id)?.name
    const deptName = (id: string | null) => departments.find((d) => d.id === id)?.name
    return list.map((x) => ({
      ...x,
      employeeName: employees.find((e) => e.id === x.employeeId)?.fullName || "—",
      employeeCode: employees.find((e) => e.id === x.employeeId)?.code,
      fromBranch: branchName(x.fromBranchId), toBranch: branchName(x.toBranchId),
      fromDept: deptName(x.fromDepartmentId), toDept: deptName(x.toDepartmentId),
    }))
  },
})
route("salaryRevisions.list", {
  perm: ["payroll", "view"],
  handler: async (ctx, p) => {
    const scope = employeeScopeFilter(ctx)
    const empIds = p?.employeeId ? [p.employeeId] : (await db.employee.findMany({ where: scope, select: { id: true } })).map((e) => e.id)
    const list = await db.salaryRevision.findMany({ where: { vendorId: ctx.vendorId, employeeId: { in: empIds } }, orderBy: { effectiveDate: "desc" } })
    const employees = await db.employee.findMany({ where: { vendorId: ctx.vendorId } })
    return list.map((x) => ({
      ...x,
      employeeName: employees.find((e) => e.id === x.employeeId)?.fullName || "—",
      employeeCode: employees.find((e) => e.id === x.employeeId)?.code,
    }))
  },
})

// ================= HRM-017 — Exit documents packet =================
/** Bundle Experience Certificate + Relieving Letter + NOC into one printable packet. */
route("exitPacket.generate", {
  perm: ["letters", "generate"],
  handler: async (ctx, p) => {
    const res = await db.resignation.findFirst({ where: { id: p.resignationId, vendorId: ctx.vendorId } })
    if (!res) throw new Deny("Resignation not found", 404)
    if (!["ACCEPTED", "NOTICE_PERIOD", "COMPLETED"].includes(res.status)) throw new Deny("Packet available after the resignation is accepted")
    const emp = await db.employee.findUnique({ where: { id: res.employeeId } })
    if (!emp) throw new Deny("Employee not found", 404)
    const templates = await db.letterTemplate.findMany({ where: { vendorId: ctx.vendorId, active: true } })
    // EXT-04 (R7) — the wanted types now match the LETTER_TYPES vocabulary
    // (the old "EXPERIENCE_CERTIFICATE"/"RELIEVING_LETTER" strings matched
    // NO seeded template, so the packet minted empty-content letters under
    // type strings no other surface recognized).
    const wanted = ["EXPERIENCE", "RELIEVING", "NOC"]
    // EXT-04 — sensible default bodies when the tenant has no active
    // template for a type (previously an empty string — a blank page).
    const DEFAULT_BODIES: Record<string, string> = {
      EXPERIENCE: `<p>This is to certify that <b>{{employee_name}}</b> (Employee Code: {{employee_code}}) served {{company_name}} as {{designation}} from {{joining_date}} to {{last_working_day}}.</p><p>During the period of service with us, {{employee_name}} was found to be sincere, hardworking and dedicated to assigned responsibilities. This certificate is issued upon request for whatever lawful purpose it may serve.</p>`,
      RELIEVING: `<p>This is to certify that <b>{{employee_name}}</b> (Employee Code: {{employee_code}}), {{designation}} at {{company_name}}, has been relieved from all duties and responsibilities with effect from <b>{{last_working_day}}</b>, upon completion of separation formalities.</p><p>All dues and dues-recoveries are settled as per the Full &amp; Final settlement statement. Company property, documents and access credentials entrusted during the period of service have been returned.</p>`,
      NOC: `<p>This is to certify that {{company_name}} has <b>no objection</b> to <b>{{employee_name}}</b> (Employee Code: {{employee_code}}) joining any other organization or engaging in any lawful professional activity after {{last_working_day}}.</p><p>All dues have been cleared and no demands remain outstanding from either side as of the date of this letter.</p>`,
    }
    // EXT-04 — render template/default bodies with the exit context (the old
    // packet shipped raw {{variables}} or empty strings).
    const vendor = await db.vendor.findUnique({ where: { id: ctx.vendorId } })
    const desig = emp.designationId ? await db.designation.findFirst({ where: { id: emp.designationId } }) : null
    const lwd = res.actualLwd || res.proposedLwd
    const vars: Record<string, string> = {
      employee_name: emp.fullName || "",
      employee_code: emp.code || "",
      designation: desig?.name || "",
      joining_date: emp.joiningDate || "",
      last_working_day: lwd || "",
      company_name: vendor?.name || "the company",
      date: isoDate(new Date()),
    }
    const renderVars = (body: string) => {
      let out = body
      for (const [k, v] of Object.entries(vars)) out = out.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, "gi"), v)
      return out
    }
    const { buildLetterHtml } = await import("./letters")
    const letters: any[] = []
    for (const type of wanted) {
      let letter = await db.hrLetter.findFirst({
        where: { vendorId: ctx.vendorId, employeeId: emp.id, type, createdAt: { gte: res.createdAt }, status: { in: ["APPROVED", "ISSUED"] } },
        orderBy: { createdAt: "desc" },
      })
      if (!letter) {
        const template = templates.find((t) => t.type === type)
        const subject = titleCase(type === "EXPERIENCE" ? "Experience Certificate" : type === "RELIEVING" ? "Relieving Letter" : "No Objection Certificate")
        const rawBody = template?.body || DEFAULT_BODIES[type] || ""
        const content = renderVars(rawBody)
        // M-14 — race-safe server-side numbering via the shared sequence
        // counter (count+1 duplicated numbers under concurrency)
        const letterNumber = await nextFormattedSeq(ctx.vendorId, `letters:${new Date().getFullYear()}`,
          (n) => `L-${new Date().getFullYear()}-${String(n).padStart(4, "0")}`)
        letter = await db.hrLetter.create({
          data: {
            vendorId: ctx.vendorId, employeeId: emp.id, templateId: template?.id || null,
            type, letterNumber, subject: template?.subject || subject,
            content, status: "DRAFT", signatoryName: template?.signatoryName || vendor?.name,
            dataJson: JSON.stringify({ exitPacket: true, resignationId: res.id }),
          },
        })
        // M-14 — route through the same approval gate as letters.submit:
        // templates flagged requiresApproval go to the workflow; exit-packet
        // types (experience/relieving/NOC) default to direct issue.
        const needsApproval = template?.requiresApproval === true
        if (needsApproval) {
          const { submitForApproval } = await import("../approval")
          const approvalId = await submitForApproval(ctx, "LETTER", "HrLetter", letter.id,
            `${subject} — ${emp.fullName}`, { employeeId: emp.id, letterId: letter.id, amount: 0 })
          await db.hrLetter.update({ where: { id: letter.id }, data: { status: "PREPARED", approvalRequestId: approvalId } })
        } else {
          await db.hrLetter.update({ where: { id: letter.id }, data: { status: "APPROVED", approvedBy: ctx.userName } })
        }
        await audit(ctx, "exitPacket.letter", "HrLetter", letter.id, `Generated ${subject} for exit packet (${emp.fullName})${needsApproval ? " — routed for approval" : ""}`)
      }
      const html = await buildLetterHtml(ctx.vendorId, letter)
      letters.push({ id: letter.id, type, letterNumber: letter.letterNumber, subject: letter.subject, html })
    }
    // combined print-ready packet: one page per letter
    const _settings = await getSettings(ctx.vendorId)
    const packetHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Exit Packet — ${emp.fullName}</title>
<style>body{font-family:Georgia,'Times New Roman',serif;margin:0;padding:32px;color:#111}.page{page-break-after:always}.page:last-child{page-break-after:auto}h1{font-size:20px}</style>
</head><body>
${letters.map((l) => {
        const b = l.html
        const s0 = b.indexOf("<body>")
        const s1 = b.lastIndexOf("</body>")
        return `<div class="page">${s0 >= 0 && s1 > s0 ? b.slice(s0 + 6, s1) : b}</div>`
      }).join("\n")}
</body></html>`
    await audit(ctx, "exitPacket.generate", "Resignation", res.id, `Generated exit document packet for ${emp.fullName} (${emp.code}) — ${letters.length} letters`)
    await notify(ctx.vendorId, { role: "HR_ADMIN" }, "Exit Packet Generated",
      `Exit document packet for ${emp.fullName} (${letters.map((l) => titleCase(l.type.replace(/_/g, " "))).join(", ")}) is ready to download.`, "EXIT", "exit")
    return { resignationId: res.id, employeeName: emp.fullName, employeeCode: emp.code, generatedAt: isoDate(new Date()), letters, packetHtml }
  },
})

// ================= P2 — commission rule engine =================
// Full Commission Rule Setup & Calculation Engine implemented in ./commissions
export { orderCommissionRules } from "./commissions"

// ================= P2 — shift auto-roster (recurring + rotation) =================
route("shifts.autoRoster", {
  perm: ["shifts", "edit"],
  handler: async (ctx, p) => {
    const { fromDate, toDate, pattern } = p
    if (!fromDate || !toDate || fromDate > toDate) throw new Deny("Invalid date range")
    if (toDate > new Date(Date.now() + 92 * 86400000).toISOString().slice(0, 10)) throw new Deny("Auto-roster is limited to 90 days ahead")
    const employees: any[] = p.employeeIds || []
    if (!employees.length) throw new Deny("Select at least one employee")
    // pattern: [{ shiftId, days: ["SUNDAY", ...] }] recurring weekly; optional rotateEveryWeeks alternates shiftId order
    const weekly: { shiftId: string; days: string[] }[] = (pattern || []).filter((x: any) => x.shiftId && x.days?.length)
    if (!weekly.length) throw new Deny("Pattern needs at least one shift with days")
    const rotateEveryWeeks = Number(p.rotateEveryWeeks || 0) // 0 = static recurring
    const shiftIds = weekly.map((w) => w.shiftId)
    for (const sid of shiftIds) {
      const sh = await db.shift.findFirst({ where: { id: sid, vendorId: ctx.vendorId } })
      if (!sh) throw new Deny("Shift not found", 404)
    }
    const wd = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"]
    let created = 0
    let d = fromDate, guard = 0
    let weekIndex = 0
    let lastWeekStart = ""
    while (d <= toDate && guard < 400) {
      if (!lastWeekStart || new Date(`${d}T00:00:00Z`).getUTCDay() === 0) {
        if (lastWeekStart) weekIndex++
        lastWeekStart = d
      }
      const dow = wd[new Date(`${d}T00:00:00Z`).getUTCDay()]
      // rotation: every N weeks the shift list shifts by one position
      const rotation = rotateEveryWeeks > 0 ? Math.floor(weekIndex / rotateEveryWeeks) % weekly.length : 0
      for (let i = 0; i < weekly.length; i++) {
        const pattern = weekly[(i + rotation) % weekly.length]
        if (!pattern.days.includes(dow)) continue
        for (const empId of employees) {
          const emp = await db.employee.findFirst({ where: { id: empId, vendorId: ctx.vendorId } })
          if (!emp) continue
          const clash = await db.shiftAssignment.findFirst({
            where: { vendorId: ctx.vendorId, employeeId: empId, fromDate: { lte: d }, OR: [{ toDate: null }, { toDate: { gte: d } }] },
          })
          if (clash) continue // existing roster wins
          await db.shiftAssignment.create({ data: { vendorId: ctx.vendorId, employeeId: empId, shiftId: pattern.shiftId, fromDate: d, toDate: d } })
          created++
        }
        break
      }
      const dt = new Date(`${d}T00:00:00Z`)
      dt.setUTCDate(dt.getUTCDate() + 1)
      d = dt.toISOString().slice(0, 10)
      guard++
    }
    await audit(ctx, "shifts.autoRoster", "ShiftAssignment", null,
      `Auto-roster generated ${created} assignment(s) for ${employees.length} employee(s), ${fromDate} → ${toDate}${rotateEveryWeeks > 0 ? ` (rotating every ${rotateEveryWeeks} week(s))` : ""}`)
    return { created }
  },
})

// ================= P2 — payroll reversal / adjustment register =================
route("payroll.reversals", {
  perm: ["payroll", "view"],
  handler: async (ctx) => {
    const runs = await db.payrollRun.findMany({
      where: { vendorId: ctx.vendorId, runType: "ADJUSTMENT" },
      orderBy: { createdAt: "desc" },
    })
    const out: any[] = []
    for (const run of runs) {
      const entries = await db.payrollEntry.findMany({ where: { runId: run.id } })
      const parent = run.adjustRunId
        ? await db.payrollRun.findFirst({ where: { id: run.adjustRunId, vendorId: ctx.vendorId } })
        : null
      out.push({
        id: run.id, periodMonth: run.periodMonth, periodYear: run.periodYear,
        adjustRunId: run.adjustRunId, parentStatus: parent?.status || null,
        status: run.status, createdAt: run.createdAt, processedDate: run.processedDate,
        entryCount: entries.length, totalNet: entries.reduce((s, e) => s + e.net, 0),
        totalGross: entries.reduce((s, e) => s + e.gross, 0),
        entries: entries.map((e) => ({
          id: e.id, employeeId: e.employeeId, status: e.status,
          gross: e.gross, net: e.net, ait: e.ait, adjustEntryId: e.adjustEntryId,
        })),
      })
    }
    return out
  },
})

// ================= P2 — audit retention cleanup =================
// RDM-001 (Wave R3-3) — the purge was a one-click anti-forensic tool in any
// settings.edit holder's hands: set retention to 1 day, purge, and the trail
// of your own prior actions is gone (the single purge audit row survives).
// Four gates now:
//   1. VENDOR_OWNER role (the tenant's owner — HR_ADMIN and custom roles with
//      settings.edit can no longer erase the trail that audits THEM);
//   2. typed confirmation (confirm: "PURGE") + a written reason (≥ 10 chars);
//   3. a 365-day floor on the effective retention window — the purge cutoff is
//      max(settings days, 365), so a shortened setting can never delete
//      younger rows;
//   4. money-related audit actions are NEVER purged (payroll/payout/settlement/
//      loan/advance/bonus/commission/accounting/backup rows are permanent
//      evidence of financial state changes).

/** Audit action prefixes that are exempt from purging (financial evidence). */
export const PROTECTED_AUDIT_ACTION_PREFIXES = [
  "payroll", "payout", "settlement", "loans", "advances", "bonus", "commissions",
  "accounting", "backups", "auditRetention",
] as const

/** Pure predicate — exported for tests. */
export function isProtectedAuditAction(action: string): boolean {
  return PROTECTED_AUDIT_ACTION_PREFIXES.some((p) => action === p || action.startsWith(p))
}

/** Pure: the effective retention window (days) — never below the floor. */
export function effectiveRetentionDays(configuredDays: number): number {
  if (!Number.isFinite(configuredDays) || configuredDays <= 0) return 0 // 0 = unlimited → purge refuses
  return Math.max(Math.ceil(configuredDays), 365)
}

route("auditRetention.purge", {
  perm: ["settings", "edit"],
  schema: z.object({
    confirm: z.literal("PURGE"),
    reason: z.string().trim().min(10).max(400),
  }).strict(),
  handler: async (ctx, p) => {
    if (ctx.role !== "VENDOR_OWNER") {
      throw new Deny("The audit purge is restricted to the Vendor Owner role — it destroys the forensic trail that audits administrators themselves", 403)
    }
    if (!p || p.confirm !== "PURGE") {
      throw new Deny('Type PURGE to confirm the audit-trail cleanup', 400)
    }
    const settings = await getSettings(ctx.vendorId)
    const days = Number(settings.auditRetention?.days || 0)
    if (days <= 0) throw new Deny("Audit retention is unlimited (set a retention window in Settings → Branding & Modules first)")
    // RDM-001 floor: even a shortened setting cannot purge rows younger than 365 days
    const effDays = effectiveRetentionDays(days)
    const cutoff = new Date(Date.now() - effDays * 86400000)
    const res = await db.auditLog.deleteMany({
      where: {
        vendorId: ctx.vendorId,
        createdAt: { lt: cutoff },
        // money-related rows survive every purge — they are the permanent
        // financial evidence; Prisma NOT-list = NOT (any prefix match)
        NOT: PROTECTED_AUDIT_ACTION_PREFIXES.map((prefix) => ({ action: { startsWith: prefix } })),
      },
    })
    await audit(ctx, "auditRetention.purge", "AuditLog", null,
      `Purged ${res.count} audit row(s) older than ${effDays} day(s)${effDays !== days ? ` (floor applied: configured ${days}d, minimum 365d)` : ""} — reason: ${p.reason}`,
      { reason: p.reason })
    return { purged: res.count, effectiveDays: effDays, protectedActions: true }
  },
})

// ================= P2 — backup export (full vendor data) =================
route("backups.export", {
  perm: ["settings", "edit"],
  handler: async (ctx, p) => {
    const vendorId = ctx.vendorId
    // C-2 — three mandatory gates before any data leaves:
    //   1. typed confirmation string (no accidental one-click exfiltration)
    //   2. fresh password re-authentication (a stolen/CSRF'd session is not enough)
    //   3. audit entry written BEFORE the response is built (preventive, not forensic)
    if (p?.confirm !== "EXPORT") {
      throw new Deny('Type EXPORT to confirm the backup download', 400)
    }
    const { verifyPasswordAsync } = await import("../auth")
    const user = await db.user.findUnique({ where: { id: ctx.userId } })
    if (!user || !(await verifyPasswordAsync(String(p?.password || ""), user.passwordHash))) {
      throw new Deny("Password confirmation failed — re-enter your password to download the backup", 401)
    }
    await audit(ctx, "backups.export", "Vendor", vendorId, `Backup export confirmed by ${ctx.userName} (re-authenticated)`)
    // M-04/M-05 — the payload build runs as a BACKGROUND JOB: table dumps of
    // every business table no longer hold the request thread; the client
    // polls jobs.get and downloads the result when the job lands DONE.
    const { submitJob } = await import("../jobs")
    const jobId = await submitJob(ctx, "BACKUP_EXPORT", { vendorId })
    return { jobId, status: "QUEUED" }
  },
})

// ================= P2 — employee bulk import wizard =================
// M-01 — import-cell validators: all imported cells are UNTRUSTED input.
const IMPORT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
function normalizeImportDate(v: unknown): string | null {
  if (v == null || v === "") return null
  const s = String(v).trim()
  if (IMPORT_DATE_RE.test(s)) return s
  // Excel serial dates / "DD/MM/YYYY" shapes are rejected — the importer UI
  // normalizes to ISO; anything else reaching here is malformed input.
  throw new Deny(`Invalid date "${s}" — expected ISO format YYYY-MM-DD`, 400)
}
const VALID_EMPLOYMENT = new Set(["PERMANENT", "PROBATIONARY", "CONTRACTUAL", "TEMPORARY", "PART_TIME", "INTERN", "COMMISSION", "FREELANCE"])
function normalizeEmploymentType(v: unknown): string {
  const t = String(v || "PERMANENT").trim().toUpperCase().replace(/\s+/g, "_")
  if (!VALID_EMPLOYMENT.has(t)) throw new Deny(`Invalid employment type "${t}"`, 400)
  return t
}

/** R1 — header aliases: the downloadable demo template uses human-friendly
 * column titles ("Employment Type", "Date of Birth", …); map them onto the
 * canonical keys the importer reads. Unknown headers pass through untouched.
 * NOTE: "Employee Code" is deliberately NOT mapped anymore — the 2026-10
 * round removed employee code from the user-input template; codes are ALWAYS
 * generated by the system (ignored even if a stale template still has the
 * column). */
const IMPORT_HEADER_ALIASES: Record<string, string> = {
  "Full Name": "fullName",
  "Email": "officialEmail",
  "Official Email": "officialEmail",
  "Mobile": "mobile",
  "Branch": "branch",
  "Department": "department",
  "Designation": "designation",
  "Shift": "shift",
  "Joining Date": "joiningDate",
  "Employment Type": "employmentType",
  "Gender": "gender",
  "Date of Birth": "dob",
  "Present Address": "presentAddress",
  "Permanent Address": "permanentAddress",
}
function normalizeImportRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row || {})) {
    const key = IMPORT_HEADER_ALIASES[String(k).trim()] || String(k).trim()
    out[key] = v
  }
  return out
}

route("employees.bulkImport", {
  schema: S.employeesBulkImport,
  perm: ["employees", "create"],
  handler: async (ctx, p) => {
    const rows: any[] = p.rows || []
    if (!rows.length) throw new Deny("No rows to import")
    if (rows.length > 500) throw new Deny("Import limited to 500 rows per batch")
    // SaaS plan capacity — server-side seat check before importing (LEGACY tenants pass)
    if (!p.dryRun) {
      await requireCapacity(ctx.vendorId, "EMPLOYEES", rows.length)
    }
    const branches = await db.branch.findMany({ where: { vendorId: ctx.vendorId } })
    const departments = await db.department.findMany({ where: { vendorId: ctx.vendorId } })
    const designations = await db.designation.findMany({ where: { vendorId: ctx.vendorId } })
    const shifts = await db.shift.findMany({ where: { vendorId: ctx.vendorId } })
    const existing = await db.employee.findMany({ where: { vendorId: ctx.vendorId }, select: { code: true, officialEmail: true, personalEmail: true, mobile: true } })
    const results: { row: number; status: "CREATED" | "SKIPPED" | "ERROR"; detail: string }[] = []
    let created = 0
    // 2026-10 round — per-row account provisioning + queued credential
    // delivery accounting (summary fields required by the import report)
    let accountsCreated = 0
    let duplicateUsers = 0
    let invalidMasterData = 0
    let missingEmailAccounts = 0
    const provisionedEmployeeIds: string[] = []
    // pre-load existing tenant user emails so the per-row duplicate-user
    // classification does not need a query per row
    const existingUserEmails = new Set(
      (await db.user.findMany({ where: { vendorId: ctx.vendorId }, select: { email: true } })).map((u) => u.email)
    )
    // 2026-10 import round — codes come from the SHARED settings-aware
    // allocator (employee-code.ts): the same SequenceCounter key, prefix,
    // suffix, start-number and padding the interactive create path uses.
    // The bulk path previously kept its own "employee-code" counter, so bulk
    // and interactive creates interleaved ranges and serial numbers were
    // neither chronological nor sequential. `existingCodes` is shared across
    // the batch so per-row allocations skip each other without re-querying.
    const existingCodes = new Set(existing.map((e: any) => e.code))
    const genCode = () => nextEmployeeCode(ctx.vendorId, existingCodes)
    for (const [i, rawRow] of rows.entries()) {
      try {
        // R1 — normalize human-friendly template headers onto canonical keys
        const r = normalizeImportRow(rawRow)
        const fullName = String(r.fullName || r["Full Name"] || "").trim()
        if (!fullName) { results.push({ row: i + 1, status: "ERROR", detail: "fullName is required" }); continue }
        const email = String(r.officialEmail || r.Email || "").trim().toLowerCase()
        const mobile = String(r.mobile || r.Mobile || "").trim()
        const cleanMobile = mobile.replace(/[\s\-()]/g, "")
        if (email && existing.some((e) => (e.officialEmail || "").toLowerCase() === email)) {
          results.push({ row: i + 1, status: "SKIPPED", detail: `duplicate email ${email}` }); continue
        }
        if (cleanMobile && existing.some((e) => e.mobile && e.mobile.replace(/[\s\-()]/g, "") === cleanMobile)) {
          results.push({ row: i + 1, status: "SKIPPED", detail: `duplicate mobile ${mobile}` }); continue
        }
        // Future joining date validation (aligned with single employee create)
        if (r.joiningDate) {
          const jd = String(r.joiningDate).trim()
          const d = new Date(jd + "T00:00:00")
          if (!isNaN(d.getTime()) && d > new Date()) {
            throw new Error(`Joining date "${jd}" cannot be in the future`)
          }
        }
        // M-6 — unrecognized lookup names are LOUD failures, not silent nulls:
        // a typo'd branch/department/designation/shift used to import the
        // employee with the field silently dropped (orphaned org assignment).
        const findId = (list: any[], v: string, label: string): string | null => {
          const raw = String(v || "").trim()
          if (!raw) return null
          const hit = list.find((x) => (x.name || x.title || "").toLowerCase() === raw.toLowerCase())
          if (!hit) throw new Error(`unknown ${label} "${raw}" — pick the name from Settings, or leave it blank`)
          return hit.id
        }
        // dryRun: validate the same fields the real write path persists, but
        // DO NOT allocate a persistent sequence code so the counter is never burned.
        if (p.dryRun) {
          normalizeImportDate(r.joiningDate)
          normalizeEmploymentType(r.employmentType)
          if (r.dob) normalizeImportDate(r.dob)
          // validate lookup references
          findId(branches, String(r.branch || ""), "branch")
          findId(departments, String(r.department || ""), "department")
          findId(designations, String(r.designation || ""), "designation")
          findId(shifts, String(r.shift || ""), "shift")
          results.push({ row: i + 1, status: "CREATED", detail: `[dry-run] valid — ${fullName}` })
          continue
        }
        // Real import: allocate code sequentially from shared counter
        const code = await genCode()
        // M-6 — the employee + import-history pair is atomic per row: the old
        // two separate awaits could strand an employee with no history (or
        // vice versa after a crash between them).
        const emp = await db.$transaction(async (tx) => {
          const created = await tx.employee.create({
            data: {
              vendorId: ctx.vendorId, code, fullName,
              officialEmail: email || null, mobile: mobile || null,
              branchId: findId(branches, String(r.branch || ""), "branch"),
              departmentId: findId(departments, String(r.department || ""), "department"),
              designationId: findId(designations, String(r.designation || ""), "designation"),
              shiftId: findId(shifts, String(r.shift || ""), "shift"),
            // M-01/M-14 — validated ISO date + PERMANENT default (valid
            // EMPLOYMENT_TYPES member; the old "FULL_TIME" default was invalid)
            joiningDate: normalizeImportDate(r.joiningDate),
            employmentType: normalizeEmploymentType(r.employmentType),
            gender: String(r.gender || "").toUpperCase() || null,
            dob: normalizeImportDate(r.dob) || null,
            presentAddress: r.presentAddress || null,
            permanentAddress: r.permanentAddress || null,
              status: "PROBATION",
            } as any,
          })
          await tx.employeeHistory.create({
            data: { vendorId: ctx.vendorId, employeeId: created.id, eventType: "JOINED", title: "Bulk imported", description: `${fullName} imported via the bulk import wizard`, effectiveDate: created.joiningDate || today(), createdBy: ctx.userId },
          })
          return created
        })
        existing.push({ code: emp.code, officialEmail: email, personalEmail: null, mobile } as any)
        created++
        // ---- per-row EMPLOYEE user account provisioning (2026-10 round §10–§12).
        // Strictly isolated from the row above: a provisioning skip or failure
        // NEVER fails the import — the employee row is already committed.
        let accountNote = ""
        try {
          if (!email) {
            missingEmailAccounts++
            accountNote = " · no user account (employee has no email)"
          } else if (existingUserEmails.has(email)) {
            duplicateUsers++
            accountNote = " · no user account (email already used)"
          } else {
            const prov = await provisionEmployeeUser(ctx.vendorId, emp.id)
            if (prov.status === "CREATED") {
              accountsCreated++
              provisionedEmployeeIds.push(emp.id)
              if (prov.email) existingUserEmails.add(prov.email)
              accountNote = " · user account created (credentials queued)"
              if (prov.userId) {
                await audit(ctx, "employees.accountProvisioned", "User", prov.userId,
                  `EMPLOYEE user account auto-created during bulk import for ${fullName} (${emp.code})`,
                  { newValue: { employeeId: emp.id, email: prov.email, source: "bulkImport" } })
              }
            } else if (prov.status === "DUPLICATE_EMAIL" || prov.status === "ALREADY_LINKED") {
              duplicateUsers++
              accountNote = ` · no user account (${prov.detail})`
            } else {
              accountNote = ` · no user account (${prov.detail})`
            }
          }
        } catch (provErr: any) {
          accountNote = ` · user account provisioning failed (${String(provErr?.message || provErr).slice(0, 120)})`
        }
        results.push({ row: i + 1, status: "CREATED", detail: `${emp.code} — ${fullName}${accountNote}` })
      } catch (err: any) {
        results.push({ row: i + 1, status: "ERROR", detail: String(err?.message || err).slice(0, 200) })
        // classify master-data errors for the import summary
        if (/unknown (branch|department|designation|shift)/i.test(String(err?.message || ""))) invalidMasterData++
      }
    }
    if (p.dryRun) {
      return { created, total: rows.length, dryRun: true, results }
    }
    // ---- queue the credential delivery as ONE background job (2026-10 §12) ----
    // The import RPC must not sit through potentially hundreds of SMTP/SMS
    // round-trips; the job rotates each queued account onto a fresh temporary
    // password (the plaintext never persists anywhere) and delivers it through
    // the channels enabled in Settings → Communication → Automation. Delivery
    // outcomes land per employee in CommunicationLog.
    let deliveryJobId: string | null = null
    if (provisionedEmployeeIds.length > 0) {
      const { submitJob } = await import("../jobs")
      deliveryJobId = await submitJob(ctx, "EMPLOYEE_CREDENTIALS_DELIVERY", {
        employeeIds: provisionedEmployeeIds, source: "bulkImport",
      }, provisionedEmployeeIds.length)
    }
    await audit(ctx, "employees.bulkImport", "Employee", null,
      `Bulk import: ${created} created, ${rows.length - created} skipped/failed, ${accountsCreated} user accounts created${deliveryJobId ? `, credentials queued (${deliveryJobId.slice(0, 8)})` : ""}`)
    await notify(ctx.vendorId, { role: "HR_ADMIN" }, "Bulk Import Finished",
      `${created} of ${rows.length} row(s) imported successfully.${accountsCreated ? ` ${accountsCreated} employee portal account(s) created — credential delivery is queued.` : ""}`, "SYSTEM", "employees")
    return {
      created, total: rows.length, results,
      // 2026-10 round — import summary (§12)
      summary: {
        totalRows: rows.length,
        imported: created,
        failed: rows.length - created,
        accountsCreated,
        duplicateUsers,
        missingEmailAccounts,
        invalidMasterData,
        credentialsQueued: provisionedEmployeeIds.length,
        deliveryJobId,
        // delivery outcomes are recorded asynchronously per employee in the
        // Communication log; failures never fail the import itself
        communicationStatus: deliveryJobId ? "QUEUED" : "NOT_QUEUED",
      },
    }
  },
})

// ---------------------------------------------------------------------------
// T-20 (2026-10-31) — prefixed aliases for this module's flat registrations.
// Root cause (API_CONTRACT_AUDIT.md §5.1): taxExemptions.*/salaryTemplates.*/
// overtime.*/reimbursements.*/orgChart.*/promotions.list/transfers.list/
// salaryRevisions.list/exitPacket.generate/auditRetention.purge/
// backups.export carry no module prefix, unlike every other route family.
// Each alias uses the feature module its canonical route already gates by
// (the perm's first segment), so dispatcher behavior is identical by
// construction. Three roadmap registrations are ALREADY module-prefixed and
// are deliberately NOT re-aliased: shifts.autoRoster, payroll.reversals,
// employees.bulkImport. The flat names stay CANONICAL (the web SPA's live
// call sites — inventory in the audit doc); these aliases serve new
// consumers that expect the prefixed spelling.
// ---------------------------------------------------------------------------
alias("ait.taxExemptions.list", "taxExemptions.list")
alias("ait.taxExemptions.save", "taxExemptions.save")
alias("ait.taxExemptions.delete", "taxExemptions.delete")
alias("payroll.salaryTemplates.list", "salaryTemplates.list")
alias("payroll.salaryTemplates.save", "salaryTemplates.save")
alias("payroll.salaryTemplates.delete", "salaryTemplates.delete")
alias("payroll.salaryTemplates.apply", "salaryTemplates.apply")
alias("payroll.salaryRevisions.list", "salaryRevisions.list")
alias("attendance.overtime.list", "overtime.list")
alias("attendance.overtime.submit", "overtime.submit")
alias("expenses.reimbursements.list", "reimbursements.list")
alias("expenses.reimbursements.mark", "reimbursements.mark")
alias("employees.orgChart.data", "orgChart.data")
alias("employees.orgChart.organogram", "orgChart.organogram")
alias("employees.orgChart.saveLayout", "orgChart.saveLayout")
alias("employees.orgChart.batchSetReporting", "orgChart.batchSetReporting")
alias("employees.orgChart.setReportingManager", "orgChart.setReportingManager")
alias("employees.orgChart.reassignEmployee", "orgChart.reassignEmployee")
alias("employees.orgChart.assignDesignationDepartment", "orgChart.assignDesignationDepartment")
alias("employees.orgChart.desigChart.data", "orgChart.desigChart.data")
alias("employees.orgChart.desigChart.saveHierarchy", "orgChart.desigChart.saveHierarchy")
alias("employees.promotions.list", "promotions.list")
alias("employees.transfers.list", "transfers.list")
alias("letters.exitPacket.generate", "exitPacket.generate")
alias("settings.auditRetention.purge", "auditRetention.purge")
alias("settings.backups.export", "backups.export")
