// ============ Employee company transfer (between companies of one tenant) ============
// Every table holding an employee's history (attendance, leave, payslips, loans,
// salary, performance, documents… 48 of them) reaches its company THROUGH the
// Employee row. Changing Employee.companyId would silently move all of it to the new
// company and strip it from the old company's reports and books.
//
// So a transfer is modelled as two employments, the way a rehire already is
// (Employee.priorEmployeeId):
//   · the source Employee row is CLOSED: status TRANSFERRED, transferredOutDate set.
//     It stays in the source company with every child row untouched;
//   · a new Employee row OPENS in the destination company, joiningDate = effective
//     date, serviceStartDate = the original service start, priorEmployeeId = source;
//   · the login moves to the new row;
//   · CompanyTransfer is the permanent record of who, what and when.
//
// Lifecycle: PENDING (in the approval engine) → SCHEDULED (approved, waiting for the
// effective date) → COMPLETED. Also REJECTED / CANCELLED.
import { db } from "@/lib/db"
import { Deny } from "./rbac"
import { audit, notify } from "./audit"
import { getSettings } from "./settings"
import { addDays, today } from "./utils"
import { spendableDays, leaveYearOf } from "./leave-math"
import { invalidateCompanyAccessCache } from "./company"
import { bumpStorageRollup } from "./saas/entitlements"
import type { Prisma } from "@prisma/client"
import { loggerFor } from "@/hrm-server/log"
const log = loggerFor("company-transfer")

export const TRANSFERRED_STATUS = "TRANSFERRED"
const TRANSFERABLE_STATUSES = ["ACTIVE", "PROBATION", "ON_LEAVE"]

/** A closed employment takes no new records: a loan or leave filed on it would never
 *  be deducted or seen again. The dispatcher runs this for every write naming an
 *  employee. One exception: attendance for days BEFORE the transfer, which the source
 *  company may still need to correct before running its final payroll. */
export async function assertEmploymentOpen(vendorId: string, action: string, payload: { employeeId: string; date?: unknown }) {
  const emp = await db.employee.findFirst({ where: { id: payload.employeeId, vendorId }, select: { status: true, transferredOutDate: true } })
  if (emp?.status !== TRANSFERRED_STATUS) return
  const out = emp.transferredOutDate
  if (action.startsWith("attendance.") && typeof payload.date === "string" && out && payload.date < out) return
  throw new Deny("This employment record was closed by a company transfer and is read-only. Use the employee's current record in the destination company.", 409)
}
const FY_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

/** Every employment record of this person, oldest first (follows completed transfers). */
export async function employmentChainIds(vendorId: string, employeeId: string): Promise<string[]> {
  const chain = [employeeId]
  let cursor = employeeId
  for (let i = 0; i < 50; i++) {
    const prev = await db.companyTransfer.findFirst({ where: { vendorId, status: "COMPLETED", toEmployeeId: cursor }, select: { fromEmployeeId: true } })
    if (!prev) break
    chain.unshift(prev.fromEmployeeId)
    cursor = prev.fromEmployeeId
  }
  cursor = employeeId
  for (let i = 0; i < 50; i++) {
    const next = await db.companyTransfer.findFirst({ where: { vendorId, status: "COMPLETED", fromEmployeeId: cursor }, select: { toEmployeeId: true } })
    if (!next?.toEmployeeId) break
    chain.push(next.toEmployeeId)
    cursor = next.toEmployeeId
  }
  return chain
}

/** What must be settled in the source company first. Each item either belongs to the
 *  source company's books or approval chain, or would be orphaned by the move. */
export async function transferBlockers(vendorId: string, employeeId: string, fromCompanyId: string | null, effectiveDate: string): Promise<string[]> {
  const emp = await db.employee.findFirst({ where: { id: employeeId, vendorId } })
  if (!emp) return ["Employee not found"]
  const where = { vendorId, employeeId }
  const out: string[] = []
  if (!TRANSFERABLE_STATUSES.includes(emp.status)) out.push(`Employee status is ${emp.status} — only active, probation or on-leave employees can be transferred`)
  const [loans, advances, guaranteeLoans, guaranteeAdvances, pendingLeave, futureLeave, corrections, expenses, promotions, transfers, revisions, resignations, assets, reports, paidRun] = await Promise.all([
    db.loan.count({ where: { ...where, status: { in: ["PENDING", "APPROVED", "ACTIVE"] } } }),
    db.advance.count({ where: { ...where, status: { in: ["PENDING", "APPROVED", "RECOVERING"] } } }),
    db.loan.count({ where: { vendorId, guarantorId: employeeId, status: "ACTIVE" } }),
    db.advance.count({ where: { vendorId, guarantorId: employeeId, status: { in: ["APPROVED", "RECOVERING"] } } }),
    db.leaveRequest.count({ where: { ...where, status: "PENDING" } }),
    db.leaveRequest.count({ where: { ...where, status: "APPROVED", toDate: { gte: effectiveDate } } }),
    db.attendanceCorrection.count({ where: { ...where, status: "PENDING" } }),
    db.expenseClaim.count({ where: { ...where, status: { in: ["PENDING", "APPROVED"] } } }),
    db.promotion.count({ where: { ...where, status: "PENDING" } }),
    db.transfer.count({ where: { ...where, status: "PENDING" } }),
    db.salaryRevision.count({ where: { ...where, status: "PENDING" } }),
    db.resignation.count({ where: { ...where, status: { notIn: ["WITHDRAWN", "REJECTED", "CANCELLED"] } } }),
    db.assetAssignment.count({ where: { ...where, returnedAt: null } }),
    db.employee.count({
      where: {
        vendorId, status: { in: ["ACTIVE", "PROBATION", "ON_LEAVE", "SUSPENDED"] },
        OR: [{ reportingManagerId: employeeId }, { hrManagerId: employeeId }, { supervisorId: employeeId }],
      },
    }),
    fromCompanyId
      ? db.payrollRun.findFirst({ where: { vendorId, companyId: fromCompanyId, status: "PAID", periodWeek: 0, periodYear: Number(effectiveDate.slice(0, 4)), periodMonth: Number(effectiveDate.slice(5, 7)) }, select: { id: true } })
      : null,
  ])
  // Loans and advances sit on the source company's books. Recovering them through the
  // destination's payroll would credit a receivable that company doesn't hold.
  if (loans) out.push(`${loans} open loan(s) — close or settle them in this company first`)
  if (advances) out.push(`${advances} open advance(s) — recover or settle them in this company first`)
  if (guaranteeLoans + guaranteeAdvances) out.push(`Guarantor on ${guaranteeLoans + guaranteeAdvances} active loan(s)/advance(s) — replace the guarantor first`)
  if (pendingLeave) out.push(`${pendingLeave} pending leave request(s) — decide them first`)
  if (futureLeave) out.push(`${futureLeave} approved leave request(s) reach the effective date — cancel them, or transfer after they end`)
  if (corrections) out.push(`${corrections} pending attendance correction(s) — decide them first`)
  if (expenses) out.push(`${expenses} unpaid expense claim(s) — decide or reimburse them first`)
  if (promotions) out.push(`${promotions} pending promotion(s) — decide them first`)
  if (transfers) out.push(`${transfers} pending branch/department transfer(s) — decide them first`)
  if (revisions) out.push(`${revisions} pending salary revision(s) — decide them first`)
  if (resignations) out.push("An exit case is open for this employee — complete or withdraw it first")
  if (assets) out.push(`${assets} assigned asset(s) belong to this company — return them first`)
  if (reports) out.push(`${reports} employee(s) report to this person — assign them another manager first`)
  if (paidRun) out.push(`Payroll for ${effectiveDate.slice(0, 7)} is already PAID in this company — choose a date in the next unpaid month, or the month would be paid twice`)
  return out
}

/** Approval engine decided. Approved transfers apply now if due, otherwise on their date. */
export async function decideCompanyTransfer(transferId: string, userId: string | null, vendorId: string, decision: string): Promise<void> {
  const t = await db.companyTransfer.findFirst({ where: { id: transferId, vendorId } })
  if (!t || t.status !== "PENDING") return
  if (decision === "REJECTED") {
    await db.companyTransfer.updateMany({ where: { id: t.id, status: "PENDING" }, data: { status: "REJECTED", decidedById: userId, decidedAt: new Date() } })
    await notify(vendorId, { employeeId: t.fromEmployeeId }, "Company Transfer Rejected", "Your company transfer request was not approved.", "SYSTEM", "ess")
    return
  }
  // An approval that arrives after the requested date applies from today. Attendance
  // and pay already recorded under the source company stay there.
  const t0 = today()
  const effectiveDate = t.effectiveDate < t0 ? t0 : t.effectiveDate
  await db.companyTransfer.updateMany({ where: { id: t.id, status: "PENDING" }, data: { status: "SCHEDULED", effectiveDate, decidedById: userId, decidedAt: new Date() } })
  if (effectiveDate <= t0) await applyCompanyTransfer(t.id, vendorId, userId)
}

/** Open the new employment and close the old one, in one transaction. A blocker that
 *  appeared since approval leaves the transfer SCHEDULED with the reason recorded;
 *  the daily job retries it. */
export async function applyCompanyTransfer(transferId: string, vendorId: string, actorUserId: string | null): Promise<{ applied: boolean; toEmployeeId?: string; blockers?: string[] }> {
  const t = await db.companyTransfer.findFirst({ where: { id: transferId, vendorId } })
  if (!t || t.status !== "SCHEDULED") return { applied: false }
  const blockers = await transferBlockers(vendorId, t.fromEmployeeId, t.fromCompanyId, t.effectiveDate)
  if (blockers.length) {
    const message = blockers.join("; ").slice(0, 1000)
    if (t.applyError !== message) {
      await db.companyTransfer.update({ where: { id: t.id }, data: { applyError: message } })
      await notify(vendorId, { role: "HR_ADMIN" }, "Company Transfer On Hold", `A scheduled company transfer can't complete yet: ${message}`, "SYSTEM", "employees")
    }
    return { applied: false, blockers }
  }

  const E = t.effectiveDate
  const dayBefore = addDays(E, -1)
  const settings = await getSettings(vendorId)
  const fyStart = Math.max(0, FY_MONTHS.indexOf(settings.general.fiscalYearStart || "July"))
  let copiedDocBytes = 0
  const leaveNotes: string[] = []

  const { newEmployeeId, fullName } = await db.$transaction(async (tx) => {
    const claimed = await tx.companyTransfer.updateMany({ where: { id: t.id, status: "SCHEDULED" }, data: { status: "COMPLETED", appliedAt: new Date(), applyError: null } })
    if (claimed.count !== 1) throw new Deny("This transfer was already processed", 409)
    const src = await tx.employee.findUniqueOrThrow({ where: { id: t.fromEmployeeId } })

    // Mobile and official email are unique per tenant, so the open record takes them.
    // The source values stay in sourceSnapshotJson.
    await tx.employee.update({
      where: { id: src.id },
      data: { status: TRANSFERRED_STATUS, transferredOutDate: E, mobile: null, officialEmail: null },
    })

    const { id: _id, createdAt: _c, updatedAt: _u, ...identity } = src
    const created = await tx.employee.create({
      data: {
        ...identity,
        companyId: t.toCompanyId,
        code: t.toCode,
        branchId: t.toBranchId,
        departmentId: t.toDepartmentId,
        designationId: t.toDesignationId,
        shiftId: t.toShiftId,
        reportingManagerId: t.toManagerId,
        hrManagerId: null,
        supervisorId: null,
        joiningDate: E,
        serviceStartDate: src.serviceStartDate || src.joiningDate,
        priorEmployeeId: src.id,
        transferredOutDate: null,
        transferredToEmployeeId: null,
      } as Prisma.EmployeeUncheckedCreateInput,
    })
    await tx.employee.update({ where: { id: src.id }, data: { transferredToEmployeeId: created.id } })

    // Reference data the new employment needs is COPIED: the source keeps its own.
    const copy = async (model: string, where: Record<string, unknown>, over: Record<string, unknown> = {}) => {
      const delegate = (tx as any)[model]
      const rows: any[] = await delegate.findMany({ where: { employeeId: src.id, ...where } })
      for (const { id: _rowId, ...row } of rows) await delegate.create({ data: { ...row, employeeId: created.id, ...over } })
      return rows
    }
    await copy("bankAccount", {})
    await copy("familyMember", {})
    await copy("education", {})
    await copy("referee", {})
    await copy("previousEmployment", {})
    await copy("employeeConsent", {})
    await copy("employeeDevice", { status: "ACTIVE" })
    await copy("pfEnrollment", { status: "ACTIVE" }, { enrollDate: E })
    const docs = await copy("employeeDocument", {})
    copiedDocBytes = docs.reduce((n, d) => n + (d.fileData ? String(d.fileData).length : 0), 0)
    await copy("salaryStructure", { status: "ACTIVE" }, { effectiveFrom: E, effectiveTo: null, status: "ACTIVE" })

    // Close what belongs to the old employment. Salary stays readable for its final
    // payroll run: calculation accepts SUPERSEDED structures.
    await tx.salaryStructure.updateMany({ where: { employeeId: src.id, status: "ACTIVE" }, data: { status: "SUPERSEDED", effectiveTo: dayBefore } })
    await tx.shiftAssignment.updateMany({ where: { vendorId, employeeId: src.id, OR: [{ toDate: null }, { toDate: { gte: E } }] }, data: { toDate: dayBefore } })
    await tx.attendanceDeviceUser.updateMany({ where: { vendorId, employeeId: src.id, enrollmentStatus: "ACTIVE" }, data: { enrollmentStatus: "INACTIVE" } })
    await tx.employeeDevice.updateMany({ where: { vendorId, employeeId: src.id, status: "ACTIVE" }, data: { status: "REVOKED" } })
    await tx.employeeTrackingState.updateMany({ where: { vendorId, employeeId: src.id }, data: { trackingEnabled: false } })

    // Leave types belong to a company, so unused days move to the same-coded type.
    if (t.carryLeaveBalances) {
      const year = leaveYearOf(E, fyStart)
      const balances = await tx.leaveBalance.findMany({ where: { employeeId: src.id, year } })
      if (balances.length) {
        const fromTypes = await tx.leaveType.findMany({ where: { id: { in: balances.map((b) => b.leaveTypeId) } }, select: { id: true, code: true, name: true } })
        const toTypes = await tx.leaveType.findMany({ where: { vendorId, companyId: t.toCompanyId, active: true }, select: { id: true, code: true } })
        for (const b of balances) {
          const fromType = fromTypes.find((x) => x.id === b.leaveTypeId)
          const days = spendableDays(b)
          if (days <= 0 || !fromType) continue
          const toType = toTypes.find((x) => x.code === fromType.code)
          if (!toType) {
            leaveNotes.push(`${days} day(s) of ${fromType.name}: no matching leave type in the destination company`)
            continue
          }
          await tx.leaveBalance.create({ data: { vendorId, employeeId: created.id, leaveTypeId: toType.id, year, entitled: days, used: 0, pending: 0, carriedForward: 0 } })
        }
      }
    }

    // Login: same account, new employment, new company context.
    const user = await tx.user.findFirst({ where: { vendorId, employeeId: src.id } })
    if (user) {
      await tx.user.update({ where: { id: user.id }, data: { employeeId: created.id, branchId: t.toBranchId, departmentId: t.toDepartmentId } })
      await tx.userCompanyAccess.updateMany({ where: { userId: user.id }, data: { isDefault: false } })
      if (user.role !== "VENDOR_OWNER" && user.role !== "HR_ADMIN") {
        await tx.userCompanyAccess.updateMany({ where: { userId: user.id, companyId: t.fromCompanyId }, data: { active: false } })
      }
      const row = await tx.userCompanyAccess.findFirst({ where: { userId: user.id, companyId: t.toCompanyId } })
      if (row) await tx.userCompanyAccess.update({ where: { id: row.id }, data: { active: true, isDefault: true } })
      else await tx.userCompanyAccess.create({ data: { vendorId, userId: user.id, companyId: t.toCompanyId, role: user.role, active: true, isDefault: true, grantedById: actorUserId, grantedByName: "Company transfer" } })
    }

    const [fromCo, toCo] = await Promise.all([
      tx.company.findUnique({ where: { id: t.fromCompanyId }, select: { name: true } }),
      tx.company.findUnique({ where: { id: t.toCompanyId }, select: { name: true } }),
    ])
    const data = JSON.stringify({ companyTransferId: t.id, fromCompanyId: t.fromCompanyId, toCompanyId: t.toCompanyId, fromEmployeeId: src.id, toEmployeeId: created.id })
    await tx.employeeHistory.createMany({
      data: [
        { vendorId, employeeId: src.id, eventType: "COMPANY_TRANSFER_OUT", title: `Transferred to ${toCo?.name || "another company"}`, description: t.reason, effectiveDate: E, dataJson: data, createdBy: actorUserId },
        { vendorId, employeeId: created.id, eventType: "COMPANY_TRANSFER_IN", title: `Transferred from ${fromCo?.name || "another company"}`, description: t.reason, effectiveDate: E, dataJson: data, createdBy: actorUserId },
      ],
    })
    await tx.companyTransfer.update({
      where: { id: t.id },
      data: {
        toEmployeeId: created.id,
        sourceSnapshotJson: JSON.stringify({ code: src.code, status: src.status, mobile: src.mobile, officialEmail: src.officialEmail, joiningDate: src.joiningDate, branchId: src.branchId, departmentId: src.departmentId, designationId: src.designationId, shiftId: src.shiftId, reportingManagerId: src.reportingManagerId }),
        resultJson: JSON.stringify({ leaveNotes, loginMoved: !!user }),
      },
    })
    return { newEmployeeId: created.id, fullName: src.fullName }
  }, { timeout: 60_000, maxWait: 10_000 })

  invalidateCompanyAccessCache()
  if (copiedDocBytes) await bumpStorageRollup(vendorId, copiedDocBytes)
  await audit(
    { userId: actorUserId, userName: "Company transfer", vendorId } as any,
    "companyTransfer.apply", "CompanyTransfer", t.id,
    `${fullName} moved to company ${t.toCompanyId} effective ${E} (employment ${t.fromEmployeeId} closed, ${newEmployeeId} opened)`,
    { newValue: { fromCompanyId: t.fromCompanyId, toCompanyId: t.toCompanyId, effectiveDate: E, leaveNotes } },
  )
  await notify(vendorId, { employeeId: newEmployeeId }, "Company Transfer Complete", `Your transfer is effective from ${E}.`, "SYSTEM", "ess")
  return { applied: true, toEmployeeId: newEmployeeId }
}

/** Daily job: apply every approved transfer whose date has arrived. */
export async function applyDueCompanyTransfers(vendorId: string, date: string): Promise<number> {
  const due = await db.companyTransfer.findMany({ where: { vendorId, status: "SCHEDULED", effectiveDate: { lte: date } }, orderBy: { effectiveDate: "asc" }, select: { id: true } })
  let applied = 0
  for (const t of due) {
    try {
      if ((await applyCompanyTransfer(t.id, vendorId, null)).applied) applied++
    } catch (e) {
      log.error(`[jobs] company transfer ${t.id} failed`, e)
      await db.companyTransfer.update({ where: { id: t.id }, data: { applyError: String((e as Error)?.message || e).slice(0, 1000) } }).catch(() => {})
    }
  }
  return applied
}
