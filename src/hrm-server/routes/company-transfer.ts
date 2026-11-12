// ============ Employee company transfer routes ============
// The design lives in ../company-transfer.ts. A request rides the source company's
// TRANSFER approval workflow, the same as a branch/department transfer.
import { z } from "zod"
import { route } from "./registry"
import { db } from "@/lib/db"
import { Deny, assertEmployeeVisible } from "../rbac"
import { audit } from "../audit"
import { assertCompany, assertOrgAnchorBelongsToCompany } from "../company"
import { isoDate } from "../validation"
import { today } from "../utils"
import { submitForApproval } from "../approval"
import { transferBlockers, applyCompanyTransfer } from "../company-transfer"

const id = z.string().trim().min(1).max(40)
const optionalId = z.preprocess((v) => (v === "" ? null : v), id.nullish())

/** The destination company's org lists, for the transfer form. Normal pickers only
 *  see the ACTIVE company, so this is the one read across the boundary, and it needs
 *  access to the destination. */
route("companyTransfer.destinationOptions", {
  perm: ["employees", "edit"],
  schema: z.object({ companyId: id }).strict(),
  handler: async (ctx, p) => {
    await assertCompany(ctx, p.companyId)
    const where = { vendorId: ctx.vendorId, companyId: p.companyId }
    const [branches, departments, designations, shifts, managers] = await Promise.all([
      db.branch.findMany({ where: { ...where, active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
      db.department.findMany({ where, select: { id: true, name: true }, orderBy: { name: "asc" } }),
      db.designation.findMany({ where, select: { id: true, name: true }, orderBy: { name: "asc" } }),
      db.shift.findMany({ where: { ...where, active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
      db.employee.findMany({ where: { ...where, status: { in: ["ACTIVE", "PROBATION"] } }, select: { id: true, fullName: true, code: true }, orderBy: { fullName: "asc" }, take: 1000 }),
    ])
    return { branches, departments, designations, shifts, managers }
  },
})

/** What stands in the way, so the form can say so before anyone files a request. */
route("companyTransfer.preflight", {
  perm: ["employees", "edit"],
  schema: z.object({ employeeId: id, effectiveDate: isoDate }).strict(),
  handler: async (ctx, p) => {
    const emp = await assertEmployeeVisible(ctx, p.employeeId, { forWrite: true })
    return { blockers: await transferBlockers(ctx.vendorId, emp.id, emp.companyId, p.effectiveDate) }
  },
})

route("companyTransfer.request", {
  perm: ["employees", "edit"],
  mutating: true,
  schema: z.object({
    employeeId: id,
    toCompanyId: id,
    toBranchId: id,
    toDepartmentId: optionalId,
    toDesignationId: optionalId,
    toShiftId: optionalId,
    toManagerId: optionalId,
    toCode: z.string().trim().min(1).max(60).optional(),
    effectiveDate: isoDate,
    reason: z.string().trim().min(3).max(1000),
    carryLeaveBalances: z.boolean().default(true),
  }).strict(),
  handler: async (ctx, p) => {
    const emp = await assertEmployeeVisible(ctx, p.employeeId, { forWrite: true })
    if (!emp.companyId) throw new Deny("This employee has no owning company recorded — repair the record before transferring", 409)
    if (emp.companyId === p.toCompanyId) throw new Deny("The employee already belongs to this company — use a branch/department transfer instead", 400)
    await assertCompany(ctx, p.toCompanyId)
    await assertOrgAnchorBelongsToCompany(ctx.vendorId, p.toCompanyId, {
      branchId: p.toBranchId, departmentId: p.toDepartmentId, designationId: p.toDesignationId, shiftId: p.toShiftId, reportingManagerId: p.toManagerId,
    })
    if (p.effectiveDate < today()) {
      throw new Deny("The effective date can't be in the past: attendance and pay up to today stay with the current company", 400)
    }
    const open = await db.companyTransfer.findFirst({ where: { vendorId: ctx.vendorId, fromEmployeeId: emp.id, status: { in: ["PENDING", "SCHEDULED"] } }, select: { id: true } })
    if (open) throw new Deny("A company transfer is already in progress for this employee", 409)
    const blockers = await transferBlockers(ctx.vendorId, emp.id, emp.companyId, p.effectiveDate)
    if (blockers.length) throw new Deny(`Can't transfer yet: ${blockers.join("; ")}`, 409)
    const toCode = p.toCode || emp.code
    const taken = await db.employee.findFirst({ where: { companyId: p.toCompanyId, code: toCode }, select: { id: true } })
    if (taken) throw new Deny(`Employee code ${toCode} is already used in the destination company — enter a different code`, 409)

    const t = await db.companyTransfer.create({
      data: {
        vendorId: ctx.vendorId, fromEmployeeId: emp.id,
        fromCompanyId: emp.companyId, toCompanyId: p.toCompanyId,
        fromBranchId: emp.branchId, toBranchId: p.toBranchId,
        fromDepartmentId: emp.departmentId, toDepartmentId: p.toDepartmentId ?? null,
        fromDesignationId: emp.designationId, toDesignationId: p.toDesignationId ?? null,
        fromShiftId: emp.shiftId, toShiftId: p.toShiftId ?? null,
        fromManagerId: emp.reportingManagerId, toManagerId: p.toManagerId ?? null,
        fromCode: emp.code, toCode,
        requestedEffectiveDate: p.effectiveDate, effectiveDate: p.effectiveDate,
        reason: p.reason, carryLeaveBalances: p.carryLeaveBalances,
        requestedById: ctx.userId, requestedByName: ctx.userName,
      },
    })
    try {
      await submitForApproval(ctx, "TRANSFER", "CompanyTransfer", t.id, `Company transfer — ${emp.fullName}`, { employeeId: emp.id, companyTransferId: t.id, amount: 0 })
    } catch (e) {
      await db.companyTransfer.delete({ where: { id: t.id } }).catch(() => {})
      throw e
    }
    await audit(ctx, "companyTransfer.request", "CompanyTransfer", t.id, `Company transfer requested for ${emp.fullName}, effective ${p.effectiveDate}`, {
      newValue: { fromCompanyId: emp.companyId, toCompanyId: p.toCompanyId, toBranchId: p.toBranchId, effectiveDate: p.effectiveDate },
    })
    return t
  },
})

/** Transfers touching the active company, in either direction. */
route("companyTransfer.list", {
  perm: ["employees", "view"],
  schema: z.object({ employeeId: id.optional(), status: z.string().max(20).optional() }).strict(),
  handler: async (ctx, p) => {
    const where: any = { vendorId: ctx.vendorId }
    if (ctx.activeCompanyId && !ctx.allCompaniesMode) where.OR = [{ fromCompanyId: ctx.activeCompanyId }, { toCompanyId: ctx.activeCompanyId }]
    if (p.status) where.status = p.status
    if (p.employeeId) {
      await assertEmployeeVisible(ctx, p.employeeId)
      where.AND = [{ OR: [{ fromEmployeeId: p.employeeId }, { toEmployeeId: p.employeeId }] }]
    }
    const rows = await db.companyTransfer.findMany({ where, orderBy: { createdAt: "desc" }, take: 200 })
    const companyIds = [...new Set(rows.flatMap((r) => [r.fromCompanyId, r.toCompanyId]))]
    const empIds = [...new Set(rows.map((r) => r.fromEmployeeId))]
    const [companies, employees] = await Promise.all([
      db.company.findMany({ where: { vendorId: ctx.vendorId, id: { in: companyIds } }, select: { id: true, name: true } }),
      db.employee.findMany({ where: { vendorId: ctx.vendorId, id: { in: empIds } }, select: { id: true, fullName: true } }),
    ])
    const companyName = new Map(companies.map((c) => [c.id, c.name]))
    const employeeName = new Map(employees.map((e) => [e.id, e.fullName]))
    // sourceSnapshotJson carries the closed record's contact details: never in a list
    return rows.map(({ sourceSnapshotJson: _snapshot, ...r }) => ({
      ...r,
      employeeName: employeeName.get(r.fromEmployeeId) ?? null,
      fromCompanyName: companyName.get(r.fromCompanyId) ?? null,
      toCompanyName: companyName.get(r.toCompanyId) ?? null,
    }))
  },
})

/** Withdraw before it takes effect. A completed transfer is a fact: reverse it with
 *  a new transfer back, which keeps the full trail. */
route("companyTransfer.cancel", {
  perm: ["employees", "edit"],
  mutating: true,
  schema: z.object({ id }).strict(),
  handler: async (ctx, p) => {
    const t = await db.companyTransfer.findFirst({ where: { id: p.id, vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { fromCompanyId: ctx.activeCompanyId } : {}) } })
    if (!t) throw new Deny("Company transfer not found", 404)
    const claimed = await db.companyTransfer.updateMany({ where: { id: t.id, status: { in: ["PENDING", "SCHEDULED"] } }, data: { status: "CANCELLED" } })
    if (claimed.count !== 1) throw new Deny(`This transfer is already ${t.status.toLowerCase()}`, 409)
    await db.approvalRequest.updateMany({ where: { vendorId: ctx.vendorId, entityType: "CompanyTransfer", entityId: t.id, status: "PENDING" }, data: { status: "CANCELLED" } })
    await audit(ctx, "companyTransfer.cancel", "CompanyTransfer", t.id, "Company transfer cancelled before taking effect")
    return { status: "CANCELLED" }
  },
})

/** Retry a held transfer once its blockers are cleared, without waiting for tonight's job. */
route("companyTransfer.retry", {
  perm: ["employees", "edit"],
  mutating: true,
  schema: z.object({ id }).strict(),
  handler: async (ctx, p) => {
    const t = await db.companyTransfer.findFirst({ where: { id: p.id, vendorId: ctx.vendorId, status: "SCHEDULED", ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { fromCompanyId: ctx.activeCompanyId } : {}) } })
    if (!t) throw new Deny("Scheduled company transfer not found", 404)
    if (t.effectiveDate > today()) throw new Deny(`This transfer takes effect on ${t.effectiveDate}`, 409)
    return applyCompanyTransfer(t.id, ctx.vendorId, ctx.userId)
  },
})
