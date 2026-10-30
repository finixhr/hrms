// ============ Employee Lifecycle routes (spec §6) — immutable history ============
// Promotion / Transfer / Salary Revision submit through the reusable approval
// engine; the finalize hooks in hooks.ts are the ONLY path that applies them.
import { db } from "@/lib/db"
import { route } from "./registry"
import { Deny, assertEmployeeVisible } from "../rbac"
import { audit } from "../audit"
import { submitForApproval } from "../approval"
import { structurePaisa } from "../money"

// ---------- Promotion ----------
route("lifecycle.promote", {
  perm: ["employees", "edit"],
  handler: async (ctx, p) => {
    const emp = await assertEmployeeVisible(ctx, p.employeeId)
    const oldDesig = emp.designationId ? await db.designation.findUnique({ where: { id: emp.designationId } }) : null
    const newDesig = p.newDesignationId ? await db.designation.findFirst({ where: { id: p.newDesignationId, vendorId: ctx.vendorId } }) : null
    if (p.newDesignationId && !newDesig) throw new Deny("New designation not found", 404)

    const promo = await db.promotion.create({
      data: {
        vendorId: ctx.vendorId, employeeId: emp.id,
        oldDesignationId: emp.designationId, newDesignationId: p.newDesignationId || null,
        oldDepartmentId: emp.departmentId, newDepartmentId: p.newDepartmentId || null,
        oldGrade: emp.grade, newGrade: p.newGrade || null,
        newBasicSalary: p.newBasicSalary ?? null,
        effectiveDate: p.effectiveDate, reason: p.reason || null,
        status: "PENDING",
      },
    })
    await submitForApproval(ctx, "PROMOTION", "Promotion", promo.id, `Promotion — ${emp.fullName}`,
      { employeeId: emp.id, promotionId: promo.id, amount: p.newBasicSalary || 0 })
    await audit(ctx, "lifecycle.promote", "Promotion", promo.id,
      `Promotion request for ${emp.fullName}: ${oldDesig?.name || "—"} → ${newDesig?.name || "—"} effective ${p.effectiveDate}`)
    return promo
  },
})

/** Applied ONLY by the PROMOTION approval finalize hook. */
export async function applyPromotion(promotionId: string, ctxUserId: string, vendorId: string, decision: string) {
  const promo = await db.promotion.findFirst({ where: { id: promotionId, vendorId } })
  if (!promo || promo.status !== "PENDING") return
  const emp = await db.employee.findUnique({ where: { id: promo.employeeId } })
  if (!emp) return
  if (decision === "REJECTED") {
    await db.promotion.update({ where: { id: promo.id }, data: { status: "REJECTED", approvedBy: ctxUserId } })
    return
  }
  const oldDesig = promo.oldDesignationId ? await db.designation.findUnique({ where: { id: promo.oldDesignationId } }) : null
  const newDesig = promo.newDesignationId ? await db.designation.findUnique({ where: { id: promo.newDesignationId } }) : null
  await db.employee.update({
    where: { id: emp.id },
    data: {
      designationId: promo.newDesignationId || emp.designationId,
      departmentId: promo.newDepartmentId || emp.departmentId,
      grade: promo.newGrade || emp.grade,
    },
  })
  await db.promotion.update({ where: { id: promo.id }, data: { status: "APPROVED", approvedBy: ctxUserId } })
  await db.employeeHistory.create({
    data: {
      vendorId, employeeId: emp.id, eventType: "PROMOTION",
      title: `Promoted: ${oldDesig?.name || "—"} → ${newDesig?.name || "—"}`,
      description: promo.reason || undefined, effectiveDate: promo.effectiveDate,
      amount: promo.newBasicSalary || undefined,
      dataJson: JSON.stringify({ promotionId: promo.id }), createdBy: ctxUserId,
    },
  })
  const { notifyChannels } = await import("../delivery")
  // promotion matrix row (Settings → Communication → Automation) — email/SMS
  // toggles on top of the always-on in-app notification
  await notifyChannels(vendorId, { employeeId: emp.id }, "Congratulations on your Promotion!",
    `You have been promoted to ${newDesig?.name || "a new position"} effective ${promo.effectiveDate}.`, "SYSTEM", "ess", {}, "promotion",
    { designation: newDesig?.name || "a new position", effectiveDate: promo.effectiveDate })
}

// ---------- Transfer ----------
route("lifecycle.transfer", {
  perm: ["employees", "edit"],
  handler: async (ctx, p) => {
    const emp = await assertEmployeeVisible(ctx, p.employeeId)
    // ---- MOD-10 (Phase 4) — vendor-scoped FK validation. The transfer row
    // used to store whatever ids the caller sent: another TENANT's branch /
    // department / designation / shift or manager passed the create (no
    // cross-tenant FK exists on those columns) and was then applied verbatim
    // to the employee record at approval. Every PROVIDED target is validated
    // against THIS vendor (≤1 count query per entity kind, only for the
    // kinds addressed) with an actionable 400 naming the field.
    const validateRef = async (field: string, kind: "branch" | "department" | "designation" | "shift", id?: string | null) => {
      if (!id) return
      const table = kind === "branch" ? db.branch : kind === "department" ? db.department : kind === "designation" ? db.designation : db.shift
      const found = await (table as any).count({ where: { id, vendorId: ctx.vendorId } })
      if (!found) {
        throw new Deny(`${field}: no ${kind} with this id exists in your workspace — refresh the transfer form and pick one from the list.`, 400)
      }
    }
    await validateRef("toBranchId", "branch", p.toBranchId)
    await validateRef("toDepartmentId", "department", p.toDepartmentId)
    await validateRef("toDesignationId", "designation", p.toDesignationId)
    await validateRef("toShiftId", "shift", p.toShiftId)
    if (p.toManagerId) {
      const mgr = await db.employee.count({ where: { id: p.toManagerId, vendorId: ctx.vendorId } })
      if (!mgr) {
        throw new Deny(`toManagerId: no employee with this id exists in your workspace — refresh the transfer form and pick a manager from the list.`, 400)
      }
    }
    const t = await db.transfer.create({
      data: {
        vendorId: ctx.vendorId, employeeId: emp.id,
        fromBranchId: emp.branchId, toBranchId: p.toBranchId || null,
        fromDepartmentId: emp.departmentId, toDepartmentId: p.toDepartmentId || null,
        fromDesignationId: emp.designationId, toDesignationId: p.toDesignationId || null,
        fromManagerId: emp.reportingManagerId, toManagerId: p.toManagerId || null,
        fromShiftId: emp.shiftId, toShiftId: p.toShiftId || null,
        workLocation: p.workLocation || null,
        effectiveDate: p.effectiveDate, reason: p.reason || null, status: "PENDING",
      },
    })
    await submitForApproval(ctx, "TRANSFER", "Transfer", t.id, `Transfer — ${emp.fullName}`,
      { employeeId: emp.id, transferId: t.id, amount: 0 })
    await audit(ctx, "lifecycle.transfer", "Transfer", t.id, `Transfer request for ${emp.fullName} effective ${p.effectiveDate}`)
    return t
  },
})

export async function applyTransfer(transferId: string, ctxUserId: string, vendorId: string, decision: string) {
  const t = await db.transfer.findFirst({ where: { id: transferId, vendorId } })
  if (!t || t.status !== "PENDING") return
  const emp = await db.employee.findUnique({ where: { id: t.employeeId } })
  if (!emp) return
  if (decision === "REJECTED") {
    await db.transfer.update({ where: { id: t.id }, data: { status: "REJECTED", approvedBy: ctxUserId } })
    return
  }
  await db.employee.update({
    where: { id: emp.id },
    data: {
      branchId: t.toBranchId || emp.branchId,
      departmentId: t.toDepartmentId || emp.departmentId,
      designationId: t.toDesignationId || emp.designationId,
      reportingManagerId: t.toManagerId || emp.reportingManagerId,
      shiftId: t.toShiftId || emp.shiftId,
      workLocation: t.workLocation || emp.workLocation,
    },
  })
  await db.transfer.update({ where: { id: t.id }, data: { status: "APPROVED", approvedBy: ctxUserId } })
  await db.employeeHistory.create({
    data: {
      vendorId, employeeId: emp.id, eventType: "TRANSFER",
      title: "Transferred",
      description: [t.toBranchId && "branch changed", t.toDepartmentId && "department changed", t.toShiftId && "shift changed"].filter(Boolean).join(", ") || undefined,
      effectiveDate: t.effectiveDate, dataJson: JSON.stringify({ transferId: t.id }), createdBy: ctxUserId,
    },
  })
  const { notifyChannels } = await import("../delivery")
  // transfer matrix row (Settings → Communication → Automation)
  await notifyChannels(vendorId, { employeeId: emp.id }, "Transfer Notification",
    `Your transfer is effective from ${t.effectiveDate}.`, "SYSTEM", "ess", {}, "transfer",
    {
      effectiveDate: t.effectiveDate,
      branch: t.toBranchId ? (await db.branch.findUnique({ where: { id: t.toBranchId } }).then((b) => b?.name).catch(() => "")) || "" : "",
      department: t.toDepartmentId ? (await db.department.findUnique({ where: { id: t.toDepartmentId } }).then((d) => d?.name).catch(() => "")) || "" : "",
    })
}

// ---------- Salary Revision / Increment (never overwrite history — spec §6.3) ----------
route("lifecycle.reviseSalary", {
  perm: ["payroll", "edit"],
  handler: async (ctx, p) => {
    const emp = await assertEmployeeVisible(ctx, p.employeeId)
    const current = await db.salaryStructure.findFirst({ where: { employeeId: emp.id, status: "ACTIVE" } })
    if (!current) throw new Deny("Employee has no active salary structure")
    const newGross = Number(p.newGross)
    if (!(newGross > 0)) throw new Deny("New gross salary must be positive")
    if (newGross < current.gross * 0.5) throw new Deny("New salary is less than 50% of current — please verify")
    const increase = newGross - current.gross
    const incPct = current.gross > 0 ? Math.round((increase / current.gross) * 1000) / 10 : 0

    const rev = await db.salaryRevision.create({
      data: {
        vendorId: ctx.vendorId, employeeId: emp.id,
        previousSalary: current.gross, newSalary: newGross,
        increaseAmount: increase, increasePercent: incPct,
        effectiveDate: p.effectiveDate, reason: p.reason || null,
        type: p.type || "INCREMENT", status: "PENDING",
      },
    })
    await submitForApproval(ctx, "SALARY_REVISION", "SalaryRevision", rev.id, `Salary revision — ${emp.fullName}`,
      { employeeId: emp.id, revisionId: rev.id, amount: increase, newGross, effectiveDate: p.effectiveDate })
    await audit(ctx, "lifecycle.reviseSalary", "SalaryRevision", rev.id,
      `Salary revision request ${emp.fullName}: ৳${current.gross} → ৳${newGross} (+${incPct}%)`)
    return rev
  },
})

export async function applySalaryRevision(revisionId: string, ctxUserId: string, vendorId: string, decision: string) {
  const rev = await db.salaryRevision.findFirst({ where: { id: revisionId, vendorId } })
  if (!rev || rev.status !== "PENDING") return
  const emp = await db.employee.findUnique({ where: { id: rev.employeeId } })
  if (!emp) return
  if (decision === "REJECTED") {
    await db.salaryRevision.update({ where: { id: rev.id }, data: { status: "REJECTED", approvedBy: ctxUserId } })
    return
  }
  // Close current structure (effectiveTo = day before), create new — history preserved
  const current = await db.salaryStructure.findFirst({ where: { employeeId: emp.id, status: "ACTIVE" } })
  if (current) {
    const d = new Date(rev.effectiveDate + "T00:00:00")
    d.setDate(d.getDate() - 1)
    await db.salaryStructure.update({
      where: { id: current.id },
      data: { status: "SUPERSEDED", effectiveTo: d.toISOString().slice(0, 10) },
    })
    const ratio = current.gross > 0 ? rev.newSalary / current.gross : 1
    const newComps = {
      basic: Math.round(current.basic * ratio), houseRent: Math.round(current.houseRent * ratio),
      medical: Math.round(current.medical * ratio), conveyance: Math.round(current.conveyance * ratio),
      food: current.food, mobileAllow: current.mobileAllow, internetAllow: current.internetAllow,
      attendanceAllow: current.attendanceAllow, otherAllowance: Math.round(current.otherAllowance * ratio),
    }
    await db.salaryStructure.create({
      data: {
        vendorId, employeeId: emp.id, effectiveFrom: rev.effectiveDate,
        ...newComps,
        gross: rev.newSalary, componentsJson: current.componentsJson,
        // H-8 — paisa dual-write via the shared helper (this path previously
        // wrote Float-only rows, leaving NULL paisa shadow columns)
        ...structurePaisa({ ...newComps, gross: rev.newSalary }),
        revisionId: rev.id, status: "ACTIVE", createdBy: ctxUserId,
      },
    })
  }
  await db.salaryRevision.update({ where: { id: rev.id }, data: { status: "APPROVED", approvedBy: ctxUserId } })
  await db.employeeHistory.create({
    data: {
      vendorId, employeeId: emp.id, eventType: "SALARY_REVISION",
      title: `Salary: ৳${rev.previousSalary} → ৳${rev.newSalary} (+${rev.increasePercent}%)`,
      effectiveDate: rev.effectiveDate, amount: rev.newSalary,
      dataJson: JSON.stringify({ revisionId: rev.id }), createdBy: ctxUserId,
    },
  })
  const { notifyChannels } = await import("../delivery")
  // salary_revision matrix row (Settings → Communication → Automation)
  await notifyChannels(vendorId, { employeeId: emp.id }, "Salary Revision Approved",
    `Your salary has been revised to ৳${rev.newSalary} effective ${rev.effectiveDate}.`, "PAYROLL", "ess", {}, "salary_revision",
    { newSalary: rev.newSalary, effectiveDate: rev.effectiveDate })
}

route("lifecycle.history", {
  perm: ["employees", "view"],
  handler: async (ctx, p) => {
    await assertEmployeeVisible(ctx, p.employeeId)
    return db.employeeHistory.findMany({
      where: { vendorId: ctx.vendorId, employeeId: p.employeeId },
      orderBy: { createdAt: "desc" },
    })
  },
})

route("lifecycle.pending", {
  perm: ["employees", "view"],
  handler: async (ctx, p) => {
    await assertEmployeeVisible(ctx, p.employeeId)
    const [promos, transfers, revisions] = await Promise.all([
      db.promotion.findMany({ where: { vendorId: ctx.vendorId, employeeId: p.employeeId } }),
      db.transfer.findMany({ where: { vendorId: ctx.vendorId, employeeId: p.employeeId } }),
      db.salaryRevision.findMany({ where: { vendorId: ctx.vendorId, employeeId: p.employeeId } }),
    ])
    return { promotions: promos, transfers, revisions }
  },
})
