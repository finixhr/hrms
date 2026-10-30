// ============ Commission Rule Setup Routes (spec §1, §2, §4) ============
import { db } from "@/lib/db"
import { route } from "./registry"
import {Deny} from "../rbac"
import { audit } from "../audit"
import { z } from "zod"
import {
  orderCommissionRules,
  validateRuleDates,
  isEmployeeServicePeriodEligible,
  resolveApplicableTarget,
  sanitizeSalesRevenue,
  calculateAndDistributeCommission,
} from "../commission-engine"
import {
  generateCommissionThresholdTemplate,
  parseAndValidateThresholdRows,
} from "../commission-import"
import { createApprovalRequest } from "../approval"
import * as XLSX from "xlsx"

export { orderCommissionRules }

// ---------- 1. List Commission Rules ----------
route("commissionRules.list", {
  perm: ["bonus", "view"],
  handler: async (ctx, p) => {
    const where: any = { vendorId: ctx.vendorId }
    if (p?.active !== undefined) where.active = Boolean(p.active)
    if (p?.calculationPeriod) where.calculationPeriod = p.calculationPeriod

    const rules = await db.commissionRule.findMany({
      where,
      include: {
        thresholds: true,
        thresholdImports: {
          orderBy: { createdAt: "desc" },
          take: 5,
        },
      },
      orderBy: { createdAt: "desc" },
    })

    const branches = await db.branch.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true, code: true } })
    const departments = await db.department.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true, code: true } })
    const designations = await db.designation.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true, code: true } })

    return rules.map((r) => ({
      ...r,
      eligibleStatuses: (() => { try { return JSON.parse(r.eligibleStatuses || "[]") } catch { return ["ACTIVE", "PROBATION"] } })(),
      branchName: branches.find((b) => b.id === r.branchId)?.name || null,
      departmentName: departments.find((d) => d.id === r.departmentId)?.name || null,
      designationName: designations.find((d) => d.id === r.designationId)?.name || null,
    }))
  },
})

// ---------- 2. Save / Update Commission Rule ----------
const ALL_EMP_STATUSES = ["ACTIVE", "PROBATION", "ON_LEAVE", "SUSPENDED", "RESIGNED", "TERMINATED", "RETIRED", "INACTIVE"] as const

const ruleSaveSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(2, "Rule name must be at least 2 characters").max(120),
  calculationPeriod: z.enum(["MONTHLY", "QUARTERLY", "HALF_YEARLY", "YEARLY"]).default("MONTHLY"),
  effectiveFrom: z.string().min(4).default(() => new Date().toISOString().slice(0, 10)),
  effectiveTo: z.string().nullable().optional(),
  active: z.boolean().default(true),
  basis: z.enum(["PERCENT_OF_SALES", "FLAT"]),
  percentMethod: z.enum(["TOTAL_REVENUE", "REVENUE_EXCEEDING_TARGET"]).nullable().optional(),
  flatMethod: z.enum(["PER_EMPLOYEE", "TOTAL_POOL"]).nullable().optional(),
  rate: z.number().finite().nonnegative("Rate must be non-negative"),
  distributionMethod: z.enum(["EQUAL", "SALARY_PRO_RATA"]).nullable().optional(),
  minServicePeriodValue: z.number().int().nonnegative().default(0),
  minServicePeriodUnit: z.enum(["DAYS", "MONTHS", "YEARS"]).default("MONTHS"),
  requireTotalTarget: z.boolean().default(false),
  requireBranchTarget: z.boolean().default(false),
  requireDeptTarget: z.boolean().default(false),
  requireEmpTarget: z.boolean().default(false),
  cap: z.number().finite().nonnegative().default(0),
  branchId: z.string().nullable().optional(),
  departmentId: z.string().nullable().optional(),
  designationId: z.string().nullable().optional(),
  eligibleStatuses: z.array(z.enum(ALL_EMP_STATUSES)).min(1, "At least one eligible employee status must be selected").optional(),
  submitForApproval: z.boolean().optional(),
  thresholds: z.array(z.object({
    targetType: z.enum(["TOTAL", "BRANCH", "DEPARTMENT", "EMPLOYEE"]),
    targetId: z.string().nullable().optional(),
    targetName: z.string().nullable().optional(),
    thresholdAmount: z.number().finite().nonnegative(),
  })).optional(),
})

route("commissionRules.save", {
  perm: ["bonus", "create"],
  schema: ruleSaveSchema,
  handler: async (ctx, p) => {
    const v = p as z.infer<typeof ruleSaveSchema>

    // Cross-field validations
    if (v.basis === "PERCENT_OF_SALES") {
      if (v.rate > 100) {
        throw new Deny("Commission rate cannot exceed 100% for Percentage of Sales Revenue", 400)
      }
      if (!v.percentMethod) {
        throw new Deny("Percentage calculation method is required for Percentage of Sales Revenue basis", 400)
      }
      if (!v.distributionMethod) {
        throw new Deny("Distribution method is required for Percentage of Sales Revenue", 400)
      }
    } else if (v.basis === "FLAT") {
      if (!v.flatMethod) {
        throw new Deny("Flat amount calculation method is required for Flat Amount basis", 400)
      }
      if (v.flatMethod === "TOTAL_POOL" && !v.distributionMethod) {
        throw new Deny("Distribution method is required when Flat Amount Total Employee Pool is selected", 400)
      }
    }

    const effFrom = new Date(v.effectiveFrom)
    const effTo = v.effectiveTo ? new Date(v.effectiveTo) : null
    validateRuleDates(effFrom, effTo)

    // Check overlapping active rules for same scope & period
    if (v.active) {
      const overlapping = await db.commissionRule.findMany({
        where: {
          vendorId: ctx.vendorId,
          active: true,
          calculationPeriod: v.calculationPeriod,
          branchId: v.branchId || null,
          departmentId: v.departmentId || null,
          designationId: v.designationId || null,
          ...(v.id ? { id: { not: v.id } } : {}),
        },
      })

      for (const r of overlapping) {
        const rFrom = new Date(r.effectiveFrom)
        const rTo = r.effectiveTo ? new Date(r.effectiveTo) : null
        const isOverlap = (!rTo || rTo >= effFrom) && (!effTo || effTo >= rFrom)
        if (isOverlap) {
          throw new Deny(
            `An active rule "${r.name}" already covers period ${v.calculationPeriod} with overlapping dates (${r.effectiveFrom.toISOString().slice(0, 10)} to ${r.effectiveTo ? r.effectiveTo.toISOString().slice(0, 10) : "open-ended"}). Deactivate or adjust the dates of the existing rule first to prevent duplicate payouts.`,
            400
          )
        }
      }
    }

    const ruleData: any = {
      vendorId: ctx.vendorId,
      name: v.name.trim(),
      calculationPeriod: v.calculationPeriod,
      effectiveFrom: effFrom,
      effectiveTo: effTo,
      active: v.active,
      basis: v.basis,
      percentMethod: v.basis === "PERCENT_OF_SALES" ? v.percentMethod : null,
      flatMethod: v.basis === "FLAT" ? v.flatMethod : null,
      rate: v.rate,
      distributionMethod:
        v.basis === "PERCENT_OF_SALES" || (v.basis === "FLAT" && v.flatMethod === "TOTAL_POOL")
          ? v.distributionMethod
          : null,
      minServicePeriodValue: v.minServicePeriodValue || 0,
      minServicePeriodUnit: v.minServicePeriodUnit || "MONTHS",
      requireTotalTarget: Boolean(v.requireTotalTarget),
      requireBranchTarget: Boolean(v.requireBranchTarget),
      requireDeptTarget: Boolean(v.requireDeptTarget),
      requireEmpTarget: Boolean(v.requireEmpTarget),
      cap: v.cap || 0,
      branchId: v.branchId || null,
      departmentId: v.departmentId || null,
      designationId: v.designationId || null,
      eligibleStatuses: JSON.stringify(
        v.eligibleStatuses && v.eligibleStatuses.length > 0
          ? v.eligibleStatuses
          : ["ACTIVE", "PROBATION"]
      ),
    }

    let rec: any
    let isUpdate = false

    if (v.id) {
      const existing = await db.commissionRule.findFirst({
        where: { id: v.id, vendorId: ctx.vendorId },
        include: { thresholds: true },
      })
      if (!existing) throw new Deny("Commission rule not found", 404)

      isUpdate = true
      ruleData.version = existing.version + 1

      // If submitForApproval requested, set to PENDING_APPROVAL
      if (v.submitForApproval) {
        ruleData.status = "PENDING_APPROVAL"
      }

      rec = await db.commissionRule.update({
        where: { id: v.id },
        data: ruleData,
      })

      // Sync thresholds if provided
      if (Array.isArray(v.thresholds)) {
        await db.commissionThreshold.deleteMany({ where: { ruleId: rec.id } })
        if (v.thresholds.length > 0) {
          await db.commissionThreshold.createMany({
            data: v.thresholds.map((t) => ({
              vendorId: ctx.vendorId,
              ruleId: rec.id,
              targetType: t.targetType,
              targetId: t.targetId || null,
              targetName: t.targetName || null,
              thresholdAmount: t.thresholdAmount,
              status: "APPROVED",
            })),
          })
        }
      }

      await audit(ctx, "commissionRules.update", "CommissionRule", rec.id, `Updated commission rule ${rec.name} (v${rec.version})`, {
        oldValue: existing,
        newValue: ruleData,
      })
    } else {
      ruleData.createdBy = ctx.userId
      ruleData.status = v.submitForApproval ? "PENDING_APPROVAL" : "ACTIVE"

      rec = await db.commissionRule.create({
        data: ruleData,
      })

      if (Array.isArray(v.thresholds) && v.thresholds.length > 0) {
        await db.commissionThreshold.createMany({
          data: v.thresholds.map((t) => ({
            vendorId: ctx.vendorId,
            ruleId: rec.id,
            targetType: t.targetType,
            targetId: t.targetId || null,
            targetName: t.targetName || null,
            thresholdAmount: t.thresholdAmount,
            status: "APPROVED",
          })),
        })
      }

      await audit(ctx, "commissionRules.create", "CommissionRule", rec.id, `Created commission rule ${rec.name}`)
    }

    // Submit for approval if requested
    if (v.submitForApproval) {
      try {
        const approvalReq = await createApprovalRequest(
          ctx,
          "COMMISSION_RULE",
          "CommissionRule",
          rec.id,
          `Commission Rule: ${rec.name} (${rec.calculationPeriod})`,
          { ruleId: rec.id, ruleName: rec.name, isUpdate }
        )
        rec = await db.commissionRule.update({
          where: { id: rec.id },
          data: { approvalRequestId: approvalReq.id },
        })
      } catch (_err: any) {
        // If no workflow is configured, it falls back to active
        await db.commissionRule.update({
          where: { id: rec.id },
          data: { status: "ACTIVE" },
        })
      }
    }

    return rec
  },
})

// ---------- 3. Delete Commission Rule ----------
route("commissionRules.delete", {
  perm: ["bonus", "approve"],
  handler: async (ctx, p) => {
    const existing = await db.commissionRule.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!existing) throw new Deny("Commission rule not found", 404)

    // Check if rule is in active use
    const hasLogs = await db.commissionCalculationLog.count({ where: { ruleId: p.id } })
    if (hasLogs > 0) {
      // Soft-delete / deactivate instead of dropping historical calculation records
      await db.commissionRule.update({ where: { id: p.id }, data: { active: false, status: "INACTIVE" } })
      await audit(ctx, "commissionRules.deactivate", "CommissionRule", p.id, `Deactivated rule "${existing.name}" due to historical records`)
      return { deleted: true, deactivated: true }
    }

    await db.commissionRule.delete({ where: { id: p.id } })
    await audit(ctx, "commissionRules.delete", "CommissionRule", p.id, `Deleted commission rule ${existing.name}`)
    return { deleted: true }
  },
})

// ---------- 4. Download Excel Template ----------
route("commissionRules.thresholdTemplate", {
  perm: ["bonus", "view"],
  handler: async (ctx, p) => {
    const rule = p.ruleId ? await db.commissionRule.findFirst({ where: { id: p.ruleId, vendorId: ctx.vendorId } }) : null

    // Determine scope & filters from rule or explicit parameters (e.g. from new rule form)
    const branchId = p.branchId !== undefined ? p.branchId : rule?.branchId
    const departmentId = p.departmentId !== undefined ? p.departmentId : rule?.departmentId
    const designationId = p.designationId !== undefined ? p.designationId : rule?.designationId
    const minServicePeriodValue = p.minServicePeriodValue !== undefined ? Number(p.minServicePeriodValue) : (rule?.minServicePeriodValue || 0)
    const minServicePeriodUnit = p.minServicePeriodUnit || rule?.minServicePeriodUnit || "MONTHS"

    let eligibleStatuses: string[] = ["ACTIVE", "PROBATION"]
    if (p.eligibleStatuses && Array.isArray(p.eligibleStatuses) && p.eligibleStatuses.length > 0) {
      eligibleStatuses = p.eligibleStatuses
    } else if (rule?.eligibleStatuses) {
      try {
        const parsed = JSON.parse(rule.eligibleStatuses)
        if (Array.isArray(parsed) && parsed.length > 0) eligibleStatuses = parsed
      } catch {
        eligibleStatuses = ["ACTIVE", "PROBATION"]
      }
    }

    const branches = await db.branch.findMany({
      where: {
        vendorId: ctx.vendorId,
        ...(branchId ? { id: branchId } : {}),
      },
      select: { id: true, name: true, code: true },
    })

    const departments = await db.department.findMany({
      where: {
        vendorId: ctx.vendorId,
        ...(departmentId ? { id: departmentId } : {}),
      },
      select: { id: true, name: true, code: true },
    })

    const allEmps = await db.employee.findMany({
      where: {
        vendorId: ctx.vendorId,
        status: { in: eligibleStatuses as any },
        ...(branchId ? { branchId } : {}),
        ...(departmentId ? { departmentId } : {}),
        ...(designationId ? { designationId } : {}),
      },
      select: {
        id: true,
        fullName: true,
        code: true,
        joiningDate: true,
        status: true,
        branchId: true,
        departmentId: true,
        designationId: true,
      },
      orderBy: { code: "asc" },
    })

    const now = new Date()
    const eligibleEmployees = allEmps.filter((emp) =>
      isEmployeeServicePeriodEligible(emp.joiningDate, now, minServicePeriodValue, minServicePeriodUnit as any)
    )

    const buffer = generateCommissionThresholdTemplate({
      ruleName: rule?.name || p.name || "Commission Thresholds",
      branches,
      departments,
      employees: eligibleEmployees,
    })

    return {
      fileName: `Commission_Threshold_Template_${(rule?.name || p.name || "Rule").replace(/[^a-zA-Z0-9_-]/g, "_")}.xlsx`,
      base64: buffer.toString("base64"),
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }
  },
})

// ---------- 5. Preview Bulk Threshold Import ----------
route("commissionRules.importPreview", {
  perm: ["bonus", "import"],
  handler: async (ctx, p) => {
    if (!p.ruleId) throw new Deny("Rule ID is required", 400)
    const rule = await db.commissionRule.findFirst({ where: { id: p.ruleId, vendorId: ctx.vendorId } })
    if (!rule) throw new Deny("Commission rule not found", 404)

    let rows: any[] = []
    if (p.base64) {
      const buf = Buffer.from(p.base64, "base64")
      const wb = XLSX.read(buf, { type: "buffer" })
      const sheetName = wb.SheetNames.includes("Thresholds") ? "Thresholds" : wb.SheetNames[0]
      const ws = wb.Sheets[sheetName]
      rows = XLSX.utils.sheet_to_json(ws)
    } else if (Array.isArray(p.rows)) {
      rows = p.rows
    } else {
      throw new Deny("No file content or rows provided", 400)
    }

    const branches = await db.branch.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true, code: true } })
    const departments = await db.department.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true, code: true } })
    const employees = await db.employee.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, fullName: true, code: true } })

    const preview = parseAndValidateThresholdRows(rows, { branches, departments, employees })

    return preview
  },
})

// ---------- 6. Submit Bulk Threshold Import for Approval ----------
route("commissionRules.importSubmit", {
  perm: ["bonus", "import"],
  handler: async (ctx, p) => {
    if (!p.ruleId) throw new Deny("Rule ID is required", 400)
    const rule = await db.commissionRule.findFirst({ where: { id: p.ruleId, vendorId: ctx.vendorId } })
    if (!rule) throw new Deny("Commission rule not found", 404)

    const branches = await db.branch.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true, code: true } })
    const departments = await db.department.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true, code: true } })
    const employees = await db.employee.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, fullName: true, code: true } })

    let rows: any[] = []
    if (p.base64) {
      const buf = Buffer.from(p.base64, "base64")
      const wb = XLSX.read(buf, { type: "buffer" })
      const sheetName = wb.SheetNames.includes("Thresholds") ? "Thresholds" : wb.SheetNames[0]
      rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName])
    } else if (Array.isArray(p.rows)) {
      rows = p.rows
    } else {
      throw new Deny("No file data provided", 400)
    }

    const validation = parseAndValidateThresholdRows(rows, { branches, departments, employees })

    if (validation.validRows === 0) {
      throw new Deny("Cannot submit import: no valid threshold records found in the file", 400)
    }

    // Unapproved imports must not affect production calculations until approved.
    const importBatch = await db.commissionThresholdImport.create({
      data: {
        vendorId: ctx.vendorId,
        ruleId: rule.id,
        fileName: p.fileName || "threshold_import.xlsx",
        totalRows: validation.totalRows,
        validRows: validation.validRows,
        invalidRows: validation.invalidRows,
        rowsJson: JSON.stringify(validation.parsedRows),
        status: "PENDING",
        uploadedBy: ctx.userId,
      },
    })

    // Submit to Approval Workflow
    let approvalRequestId: string | null = null
    try {
      const approvalReq = await createApprovalRequest(
        ctx,
        "COMMISSION_IMPORT",
        "CommissionThresholdImport",
        importBatch.id,
        `Threshold Import for ${rule.name} (${validation.validRows} rows)`,
        { importId: importBatch.id, ruleId: rule.id, validRows: validation.validRows }
      )
      approvalRequestId = approvalReq.id
      await db.commissionThresholdImport.update({
        where: { id: importBatch.id },
        data: { approvalRequestId },
      })
    } catch {
      // If no workflow is configured, stays PENDING for authorized manual approval via commissionRules.importApprove
    }

    await audit(ctx, "commissionRules.importSubmit", "CommissionThresholdImport", importBatch.id,
      `Submitted threshold import for rule "${rule.name}" (${validation.validRows} valid rows, ${validation.invalidRows} invalid rows)`)

    return {
      id: importBatch.id,
      importBatchId: importBatch.id,
      status: "PENDING",
      approvalRequestId,
      validation,
    }
  },
})

// ---------- 7. Approve / Reject Bulk Threshold Import ----------
route("commissionRules.importDecide", {
  perm: ["bonus", "approve"],
  handler: async (ctx, p) => {
    const importBatch = await db.commissionThresholdImport.findFirst({
      where: { id: p.importId, vendorId: ctx.vendorId },
      include: { rule: true },
    })
    if (!importBatch) throw new Deny("Threshold import not found", 404)
    if (importBatch.status !== "PENDING") {
      throw new Deny(`This import batch has already been decided (${importBatch.status})`, 400)
    }

    // Separation of duties: uploader cannot approve their own import unless VENDOR_OWNER / superuser
    if (importBatch.uploadedBy === ctx.userId && ctx.role !== "VENDOR_OWNER" && !ctx.permissions.has("*")) {
      throw new Deny("Separation of duties: you cannot approve a threshold import you uploaded yourself", 403)
    }

    const decision = p.decision === "APPROVE" ? "APPROVED" : "REJECTED"

    if (decision === "REJECTED") {
      await db.commissionThresholdImport.update({
        where: { id: importBatch.id },
        data: {
          status: "REJECTED",
          approvedBy: ctx.userId,
          actedAt: new Date(),
          rejectionReason: p.reason || "Rejected by approver",
        },
      })
      await audit(ctx, "commissionRules.importReject", "CommissionThresholdImport", importBatch.id,
        `Rejected threshold import for rule "${importBatch.rule.name}"`)
      return { ok: true, status: "REJECTED" }
    }

    // APPROVED: Atomically apply valid rows into CommissionThreshold
    const parsedRows = JSON.parse(importBatch.rowsJson || "[]")
    const validRows = parsedRows.filter((r: any) => r.valid)

    await db.$transaction(async (tx) => {
      // Remove all previous approved thresholds for this rule and place newly approved thresholds
      await tx.commissionThreshold.deleteMany({
        where: {
          ruleId: importBatch.ruleId,
        },
      })

      // Create approved threshold rows
      await tx.commissionThreshold.createMany({
        data: validRows.map((r: any) => ({
          vendorId: ctx.vendorId,
          ruleId: importBatch.ruleId,
          targetType: r.targetType,
          targetId: r.resolvedTargetId || null,
          targetName: r.targetName || null,
          thresholdAmount: r.thresholdAmount,
          status: "APPROVED",
          importId: importBatch.id,
        })),
      })

      // Mark import approved
      await tx.commissionThresholdImport.update({
        where: { id: importBatch.id },
        data: {
          status: "APPROVED",
          approvedBy: ctx.userId,
          actedAt: new Date(),
        },
      })
    })

    await audit(ctx, "commissionRules.importApprove", "CommissionThresholdImport", importBatch.id,
      `Approved threshold import for rule "${importBatch.rule.name}" (${validRows.length} thresholds activated)`)

    return { ok: true, status: "APPROVED", activatedCount: validRows.length }
  },
})

// ---------- Download Calculation Template for Commission Run ----------
const calculationTemplateSchema = z.object({
  ruleId: z.string().optional(),
  month: z.number().int().min(1).max(12).optional(),
  year: z.number().int().min(2000).max(2100).optional(),
})

route("commissions.calculationTemplate", {
  perm: ["bonus", "view"],
  schema: calculationTemplateSchema,
  handler: async (ctx, p) => {
    const v = p as z.infer<typeof calculationTemplateSchema>
    const now = new Date()
    const month = v.month || (now.getMonth() + 1)
    const year = v.year || now.getFullYear()

    const lastDayOfMonth = new Date(year, month, 0).getDate()
    const calcDate = new Date(year, month - 1, lastDayOfMonth, 23, 59, 59, 999)

    let selectedRule: any = null
    let activeRules: any[] = []

    if (v.ruleId && v.ruleId !== "AUTO") {
      selectedRule = await db.commissionRule.findFirst({
        where: { id: v.ruleId, vendorId: ctx.vendorId },
        include: {
          thresholds: {
            where: { status: "APPROVED" },
          },
        },
      })
      if (!selectedRule) throw new Deny("Commission rule not found", 404)
      activeRules = [selectedRule]
    } else {
      activeRules = orderCommissionRules(
        await db.commissionRule.findMany({
          where: { vendorId: ctx.vendorId, active: true, status: "ACTIVE" },
          include: {
            thresholds: {
              where: { status: "APPROVED" },
            },
          },
        })
      )
    }

    const branches = await db.branch.findMany({
      where: { vendorId: ctx.vendorId },
      select: { id: true, name: true, code: true },
    })
    const departments = await db.department.findMany({
      where: { vendorId: ctx.vendorId },
      select: { id: true, name: true, code: true },
    })
    const designations = await db.designation.findMany({
      where: { vendorId: ctx.vendorId },
      select: { id: true, name: true, code: true },
    })

    // Collect all eligible statuses across all rules for broad employee fetch
    const allStatuses = new Set<string>()
    for (const rule of activeRules) {
      const parsed: string[] = (() => {
        try { return JSON.parse(rule.eligibleStatuses || "[]") } catch { return ["ACTIVE", "PROBATION"] }
      })()
      parsed.forEach((s) => allStatuses.add(s))
    }
    // Fallback: if no rules loaded yet, fetch all
    const statusFilter = allStatuses.size > 0 ? Array.from(allStatuses) : ["ACTIVE", "PROBATION"]

    const employees = await db.employee.findMany({
      where: {
        vendorId: ctx.vendorId,
        status: { in: statusFilter as any },
      },
      select: {
        id: true,
        fullName: true,
        code: true,
        joiningDate: true,
        status: true,
        branchId: true,
        departmentId: true,
        designationId: true,
      },
      orderBy: { code: "asc" },
    })

    const branchMap = new Map(branches.map((b) => [b.id, b.name]))
    const deptMap = new Map(departments.map((d) => [d.id, d.name]))
    const desigMap = new Map(designations.map((d) => [d.id, d.name]))

    // Filter eligible employees based on the rule(s)
    const eligibleEmployees: any[] = []
    for (const emp of employees) {
      let matchingRule: any = null
      let targetResult: any = null

      for (const rule of activeRules) {
        // Eligible employee statuses check
        const ruleStatuses: string[] = (() => {
          try { return JSON.parse(rule.eligibleStatuses || "[]") } catch { return ["ACTIVE", "PROBATION"] }
        })()
        if (ruleStatuses.length > 0 && !ruleStatuses.includes(emp.status)) continue

        // Scope restrictions
        if (rule.branchId && rule.branchId !== emp.branchId) continue
        if (rule.departmentId && rule.departmentId !== emp.departmentId) continue
        if (rule.designationId && rule.designationId !== emp.designationId) continue

        // Service period eligibility check as of the period calculation date
        const isEligible = isEmployeeServicePeriodEligible(
          emp.joiningDate,
          calcDate,
          rule.minServicePeriodValue,
          rule.minServicePeriodUnit as any
        )
        if (!isEligible) continue

        matchingRule = rule
        targetResult = resolveApplicableTarget(emp, rule.thresholds || [], {
          requireEmpTarget: rule.requireEmpTarget,
          requireDeptTarget: rule.requireDeptTarget,
          requireBranchTarget: rule.requireBranchTarget,
          requireTotalTarget: rule.requireTotalTarget,
        })
        break
      }

      if (selectedRule) {
        if (matchingRule?.id === selectedRule.id) {
          eligibleEmployees.push({
            emp,
            rule: matchingRule,
            targetType: targetResult?.targetType || "NONE",
            targetAmount: targetResult?.targetAmount || 0,
          })
        }
      } else if (matchingRule) {
        eligibleEmployees.push({
          emp,
          rule: matchingRule,
          targetType: targetResult?.targetType || "NONE",
          targetAmount: targetResult?.targetAmount || 0,
        })
      }
    }

    // Build the workbook
    const wb = XLSX.utils.book_new()

    // 1. Sheet: "Sales Entries"
    const salesRows = eligibleEmployees.map((item) => ({
      "Employee Code": item.emp.code || item.emp.id,
      "Employee Name": item.emp.fullName,
      "Department": deptMap.get(item.emp.departmentId) || "—",
      "Branch": branchMap.get(item.emp.branchId) || "—",
      "Designation": desigMap.get(item.emp.designationId) || "—",
      "Applicable Rule": item.rule.name,
      "Target Type": item.targetType,
      "Target Revenue (BDT)": item.targetAmount > 0 ? item.targetAmount : 0,
      "Sales Revenue (BDT)": "", // Empty column ready for user to input sales revenue!
    }))

    const wsSales = XLSX.utils.json_to_sheet(salesRows)
    wsSales["!cols"] = [
      { wch: 18 },
      { wch: 28 },
      { wch: 22 },
      { wch: 22 },
      { wch: 22 },
      { wch: 28 },
      { wch: 16 },
      { wch: 22 },
      { wch: 24 },
    ]
    XLSX.utils.book_append_sheet(wb, wsSales, "Sales Entries")

    // 2. Sheet: "Rule & Threshold Targets"
    const thresholdSummaryRows: any[] = []
    for (const rule of activeRules) {
      thresholdSummaryRows.push({
        "Rule Name": rule.name,
        "Target Type": "RULE CONFIG",
        "Target Name": `Basis: ${rule.basis === "PERCENT_OF_SALES" ? `${rule.rate}% of sales` : `৳${rule.rate} flat`}`,
        "Approved Target Amount (BDT)": rule.cap > 0 ? `Cap: ৳${rule.cap}` : "No Cap",
        "Notes": `Min Service: ${rule.minServicePeriodValue} ${rule.minServicePeriodUnit.toLowerCase()}`,
      })

      for (const t of rule.thresholds || []) {
        thresholdSummaryRows.push({
          "Rule Name": rule.name,
          "Target Type": t.targetType,
          "Target Name": t.targetName || (t.targetType === "TOTAL" ? "Company-Wide Total" : (t.targetId || "—")),
          "Approved Target Amount (BDT)": t.thresholdAmount,
          "Notes": t.status === "APPROVED" ? "Approved Threshold" : t.status,
        })
      }
    }

    const wsThresholds = XLSX.utils.json_to_sheet(thresholdSummaryRows)
    wsThresholds["!cols"] = [
      { wch: 28 },
      { wch: 18 },
      { wch: 35 },
      { wch: 30 },
      { wch: 35 },
    ]
    XLSX.utils.book_append_sheet(wb, wsThresholds, "Threshold Targets")

    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" })
    const ruleSlug = (selectedRule?.name || "Active_Rules").replace(/[^a-zA-Z0-9_-]/g, "_")
    const fileName = `Sales_Commission_Template_${ruleSlug}_${month}_${year}.xlsx`

    return {
      fileName,
      base64: buffer.toString("base64"),
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      eligibleCount: eligibleEmployees.length,
    }
  },
})

// ---------- 8. Calculate Commissions Engine Endpoint ----------
const calculateSchema = z.object({
  ruleId: z.string().optional(),
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2000).max(2100),
  entries: z.array(z.object({
    employeeId: z.string().min(1),
    salesAmount: z.number().finite().nonnegative().default(0),
    transactions: z.array(z.object({
      id: z.string().optional(),
      amount: z.number().finite(),
      status: z.enum(["COMPLETED", "CANCELLED", "REVERSED", "RETURN"]).optional(),
    })).optional(),
  })).min(1).max(10000),
})

route("commissions.calculate", {
  perm: ["bonus", "calculate"],
  altPerm: ["bonus", "create"],
  schema: calculateSchema,
  handler: async (ctx, p) => {
    const v = p as z.infer<typeof calculateSchema>
    const { month, year } = v

    // Calculation period date boundaries: periodStart (1st of month) to periodEnd (end of month)
    const periodStart = new Date(year, month - 1, 1, 0, 0, 0, 0)
    const lastDayOfMonth = new Date(year, month, 0).getDate()
    const periodEnd = new Date(year, month - 1, lastDayOfMonth, 23, 59, 59, 999)
    const calcDate = periodEnd // Service period evaluated as of the end of the calculation period

    // Find rules
    let rules: any[] = []
    if (v.ruleId) {
      const specified = await db.commissionRule.findFirst({
        where: { id: v.ruleId, vendorId: ctx.vendorId, active: true },
        include: { thresholds: true },
      })
      if (!specified) throw new Deny("Specified active commission rule not found", 404)
      rules = [specified]
    } else {
      rules = orderCommissionRules(
        await db.commissionRule.findMany({
          where: { vendorId: ctx.vendorId, active: true, status: "ACTIVE" },
          include: { thresholds: true },
        })
      )
    }

    if (!rules.length) throw new Deny("No active commission rules configured for this organization", 400)

    const employees = await db.employee.findMany({
      where: { vendorId: ctx.vendorId },
    })

    const empById = new Map<string, any>(employees.map((x) => [x.id, x]))
    const empIds = employees.map((e) => e.id)
    const activeSalaryStructures = await db.salaryStructure.findMany({
      where: { vendorId: ctx.vendorId, employeeId: { in: empIds }, status: "ACTIVE" },
      orderBy: { effectiveFrom: "desc" },
    })
    const salaryByEmp = new Map<string, any>()
    for (const s of activeSalaryStructures) {
      if (!salaryByEmp.has(s.employeeId)) {
        salaryByEmp.set(s.employeeId, s)
      }
    }

    const createdBonuses: any[] = []
    const skipped: { employeeId: string; reason: string }[] = []
    const processedEmployees = new Set<string>()
    const commBatchId = "cb_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7)

    // Pre-query existing commissions for this period across all submitted entries to avoid N+1 DB queries
    const existingPeriodCommissions = await db.bonus.findMany({
      where: {
        vendorId: ctx.vendorId,
        employeeId: { in: v.entries.map((e) => e.employeeId) },
        type: "SALES_COMMISSION",
        periodMonth: month,
        periodYear: year,
        status: { in: ["PENDING", "APPROVED", "IN_PAYROLL", "PAID"] },
      },
    })

    // Group entries by matching rule (sorted by specificity)
    for (const rule of rules) {
      // Evaluate rule effective dates: rule must cover the selected period
      const rFrom = new Date(rule.effectiveFrom)
      const rTo = rule.effectiveTo ? new Date(rule.effectiveTo) : null
      if (rFrom > periodEnd || (rTo && rTo < periodStart)) {
        if (v.ruleId) {
          skipped.push({
            employeeId: "ALL",
            reason: `Rule "${rule.name}" is effective from ${rule.effectiveFrom.slice(0, 10)}${rule.effectiveTo ? ` to ${rule.effectiveTo.slice(0, 10)}` : ""}, which does not cover period ${month}/${year}`,
          })
        }
        continue
      }

      // Filter candidate employees for this rule scope
      const candidateEntries: {
        emp: any
        salesAmount: number
        transactions?: any[]
      }[] = []

      for (const e of v.entries) {
        if (!v.ruleId && processedEmployees.has(e.employeeId)) {
          continue // Already awarded commission by a more specific rule in this calculation
        }

        const emp = empById.get(e.employeeId)
        if (!emp) {
          skipped.push({ employeeId: e.employeeId, reason: "Employee not found in organization" })
          continue
        }

        // Eligible employee status check
        const ruleStatuses: string[] = (() => {
          try { return JSON.parse(rule.eligibleStatuses || "[]") } catch { return ["ACTIVE", "PROBATION"] }
        })()
        if (ruleStatuses.length > 0 && !ruleStatuses.includes(emp.status)) {
          if (v.ruleId) {
            skipped.push({
              employeeId: emp.id,
              reason: `Employee status "${emp.status}" is not eligible for this rule (eligible: ${ruleStatuses.join(", ")})`,
            })
          }
          continue
        }

        // Branch / Department / Designation Scope check
        if (rule.branchId && rule.branchId !== emp.branchId) {
          if (v.ruleId) {
            skipped.push({
              employeeId: emp.id,
              reason: `Employee does not belong to rule's branch restriction`,
            })
          }
          continue
        }
        if (rule.departmentId && rule.departmentId !== emp.departmentId) {
          if (v.ruleId) {
            skipped.push({
              employeeId: emp.id,
              reason: `Employee does not belong to rule's department restriction`,
            })
          }
          continue
        }
        if (rule.designationId && rule.designationId !== emp.designationId) {
          if (v.ruleId) {
            skipped.push({
              employeeId: emp.id,
              reason: `Employee does not belong to rule's designation restriction`,
            })
          }
          continue
        }

        // Check service period eligibility
        const servicePeriodOk = isEmployeeServicePeriodEligible(
          emp.joiningDate,
          calcDate,
          rule.minServicePeriodValue,
          rule.minServicePeriodUnit as any
        )
        if (!servicePeriodOk) {
          skipped.push({
            employeeId: emp.id,
            reason: `Employee has not completed minimum service period of ${rule.minServicePeriodValue} ${rule.minServicePeriodUnit.toLowerCase()}`,
          })
          continue
        }

        // Deduplication: prevent duplicate commission payment for same employee + period + rule
        const existingCommission = existingPeriodCommissions.find(
          (b) => b.employeeId === emp.id && b.label && b.label.includes(rule.name)
        )
        if (existingCommission) {
          skipped.push({
            employeeId: emp.id,
            reason: `Commission for "${rule.name}" already exists for this period (${existingCommission.status.toLowerCase()}) — duplicate prevented`,
          })
          continue
        }

        candidateEntries.push({
          emp,
          salesAmount: e.salesAmount,
          transactions: e.transactions,
        })
      }

      if (candidateEntries.length === 0) continue

      // Resolve revenue and approved thresholds for candidate employees
      const eligibleEmployees: {
        id: string
        fullName: string
        code?: string
        eligibleRevenue: number
        targetRevenue: number
        targetTypeApplied: string
        applicableSalary: number
      }[] = []

      for (const c of candidateEntries) {
        const cleanRevenue = sanitizeSalesRevenue({
          employeeId: c.emp.id,
          salesAmount: c.salesAmount,
          transactions: c.transactions,
        })

        // Resolve approved target threshold
        const targetRes = resolveApplicableTarget(c.emp, rule.thresholds, {
          requireTotalTarget: rule.requireTotalTarget,
          requireBranchTarget: rule.requireBranchTarget,
          requireDeptTarget: rule.requireDeptTarget,
          requireEmpTarget: rule.requireEmpTarget,
        })

        if (targetRes.missingThreshold) {
          skipped.push({
            employeeId: c.emp.id,
            reason: `Missing approved ${targetRes.targetType.toLowerCase()} revenue threshold required by rule "${rule.name}"`,
          })
          continue
        }

        // Check if revenue target condition met
        if (rule.percentMethod === "REVENUE_EXCEEDING_TARGET" && cleanRevenue <= targetRes.targetAmount) {
          skipped.push({
            employeeId: c.emp.id,
            reason: `Revenue (৳${cleanRevenue.toLocaleString("en-IN")}) did not exceed applicable target (৳${targetRes.targetAmount.toLocaleString("en-IN")})`,
          })
          continue
        }

        const activeStruct = salaryByEmp.get(c.emp.id)
        const applicableSalary = activeStruct?.gross || activeStruct?.basic || 0

        eligibleEmployees.push({
          id: c.emp.id,
          fullName: c.emp.fullName,
          code: c.emp.code,
          eligibleRevenue: cleanRevenue,
          targetRevenue: targetRes.targetAmount,
          targetTypeApplied: targetRes.targetType,
          applicableSalary,
        })
      }

      if (eligibleEmployees.length === 0) continue

      // Run calculation & distribution with total cap enforcement and reconciliation
      const calcResult = calculateAndDistributeCommission(rule, eligibleEmployees)

      for (const alloc of calcResult.allocations) {
        if (!(alloc.finalCommissionAmount > 0)) {
          skipped.push({
            employeeId: alloc.employeeId,
            reason: "Calculated commission amount is 0",
          })
          continue
        }

        // Create PENDING SALES_COMMISSION bonus record
        const bonus = await db.bonus.create({
          data: {
            vendorId: ctx.vendorId,
            employeeId: alloc.employeeId,
            type: "SALES_COMMISSION",
            formula: `BATCH:${commBatchId}`,
            label: `${rule.name} — sales ৳${alloc.eligibleRevenue.toLocaleString("en-IN")}${alloc.targetRevenue > 0 ? ` (target ৳${alloc.targetRevenue.toLocaleString("en-IN")})` : ""}`,
            amount: alloc.finalCommissionAmount,
            periodMonth: month,
            periodYear: year,
            status: "PENDING",
            createdBy: ctx.userId, // SoD anchor: creator cannot approve
          },
        })

        // Create traceable calculation log
        await db.commissionCalculationLog.create({
          data: {
            vendorId: ctx.vendorId,
            ruleId: rule.id,
            ruleName: rule.name,
            ruleVersion: rule.version,
            periodMonth: month,
            periodYear: year,
            calculationPeriod: rule.calculationPeriod,
            employeeId: alloc.employeeId,
            employeeName: alloc.employeeName,
            employeeCode: alloc.employeeCode || null,
            eligibleRevenue: alloc.eligibleRevenue,
            targetRevenue: alloc.targetRevenue,
            targetTypeApplied: alloc.targetTypeApplied,
            basis: rule.basis,
            calculationMethod: rule.basis === "PERCENT_OF_SALES" ? (rule.percentMethod || "TOTAL_REVENUE") : (rule.flatMethod || "PER_EMPLOYEE"),
            rate: rule.rate,
            distributionMethod: rule.distributionMethod || null,
            baseCalculatedAmount: alloc.baseCalculatedAmount,
            capApplied: alloc.capApplied,
            capAmount: alloc.capAmount || null,
            finalCommissionAmount: alloc.finalCommissionAmount,
            bonusId: bonus.id,
            calculatedBy: ctx.userId,
          },
        })

        processedEmployees.add(alloc.employeeId)

        createdBonuses.push({
          ...bonus,
          employeeName: alloc.employeeName,
          employeeCode: alloc.employeeCode || null,
          ruleName: rule.name,
          eligibleRevenue: alloc.eligibleRevenue,
          targetRevenue: alloc.targetRevenue,
          targetTypeApplied: alloc.targetTypeApplied,
          baseCalculatedAmount: alloc.baseCalculatedAmount,
          finalCommissionAmount: alloc.finalCommissionAmount,
          capApplied: alloc.capApplied,
          capAmount: alloc.capAmount || null,
          rate: rule.rate,
          basis: rule.basis,
        })

        await audit(
          ctx,
          "commissions.calculate",
          "Bonus",
          bonus.id,
          `Commission ৳${alloc.finalCommissionAmount} for ${alloc.employeeName} (rule "${rule.name}", revenue ৳${alloc.eligibleRevenue.toLocaleString("en-IN")})`
        )
      }
    }

    const totalCommission = createdBonuses.reduce((sum, b) => sum + (Number(b.amount) || 0), 0)

    return {
      created: createdBonuses.length,
      skipped,
      bonuses: createdBonuses,
      totalCommission,
      batchId: commBatchId,
    }
  },
})

// ---------- 8b. List Commission Calculation Logs (Audit Trail) ----------
route("commissionRules.logs", {
  perm: ["bonus", "view"],
  handler: async (ctx, p) => {
    const where: any = { vendorId: ctx.vendorId }
    if (p?.ruleId) where.ruleId = p.ruleId
    if (p?.employeeId) where.employeeId = p.employeeId
    if (p?.periodYear) where.periodYear = Number(p.periodYear)
    if (p?.periodMonth) where.periodMonth = Number(p.periodMonth)

    const logs = await db.commissionCalculationLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 100,
    })
    return logs
  },
})

// ---------- 9. Finalize Hooks for Approval Engine ----------
export async function applyCommissionRuleDecision(ctx: any, ruleId: string, decision: "APPROVED" | "REJECTED") {
  const rule = await db.commissionRule.findFirst({ where: { id: ruleId, vendorId: ctx.vendorId } })
  if (!rule || rule.status !== "PENDING_APPROVAL") return

  await db.commissionRule.update({
    where: { id: rule.id },
    data: {
      status: decision === "APPROVED" ? "ACTIVE" : "REJECTED",
      approvedBy: ctx.userId,
    },
  })
  await audit(ctx, "commissionRules.approvalFinalize", "CommissionRule", rule.id,
    `Commission rule "${rule.name}" ${decision.toLowerCase()} via approval workflow`)
}

export async function applyCommissionImportDecision(ctx: any, importId: string, decision: "APPROVED" | "REJECTED") {
  const importBatch = await db.commissionThresholdImport.findFirst({
    where: { id: importId, vendorId: ctx.vendorId },
  })
  if (!importBatch || importBatch.status !== "PENDING") return

  if (decision === "REJECTED") {
    await db.commissionThresholdImport.update({
      where: { id: importBatch.id },
      data: { status: "REJECTED", approvedBy: ctx.userId, actedAt: new Date() },
    })
    return
  }

  // Activate thresholds
  const parsedRows = JSON.parse(importBatch.rowsJson || "[]")
  const validRows = parsedRows.filter((r: any) => r.valid)

  await db.$transaction(async (tx) => {
    // Remove all previous approved thresholds for this rule and place newly approved thresholds
    await tx.commissionThreshold.deleteMany({
      where: {
        ruleId: importBatch.ruleId,
      },
    })
    await tx.commissionThreshold.createMany({
      data: validRows.map((r: any) => ({
        vendorId: ctx.vendorId,
        ruleId: importBatch.ruleId,
        targetType: r.targetType,
        targetId: r.resolvedTargetId || null,
        targetName: r.targetName || null,
        thresholdAmount: r.thresholdAmount,
        status: "APPROVED",
        importId: importBatch.id,
      })),
    })
    await tx.commissionThresholdImport.update({
      where: { id: importBatch.id },
      data: { status: "APPROVED", approvedBy: ctx.userId, actedAt: new Date() },
    })
  })
  await audit(ctx, "commissionRules.importApprovalFinalize", "CommissionThresholdImport", importBatch.id,
    `Threshold import batch ${importBatch.id} approved and activated via approval workflow`)
}
