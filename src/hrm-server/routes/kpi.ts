// ============ KPI Performance System routes (2026-11 redesign) ============
// New `kpi.*` action family: system indicator registry, Company+Department
// templates, target assignments (single + bulk Excel with two-phase
// preview/execute), achievements (single + bulk) and the module's approval
// state machine. The PRE-REDESIGN routes (kpiTemplates.*, kpiAssignments.*,
// cycles.*, reviews.*, tasks.*) stay registered untouched in ./performance.ts
// for the ESS + mobile consumers — data compatibility is maintained by the
// resultsJson/totalScore mirror (kpi/service.ts syncAssignmentMirror).
import { z } from "zod"
import { db } from "@/lib/db"
import { route } from "./registry"
import { Deny, assertEmployeeVisible, employeeScopeFilter } from "../rbac"
import { audit } from "../audit"
import { j } from "../utils"
import { companyWhere, resolveCreateCompany } from "../company"
import type { Ctx } from "../types"
import {
  KPI_IMPORT_MAX_BYTES, KPI_IMPORT_MAX_ROWS, KPI_UNITS, KPI_DIRECTIONS, KPI_PERIOD_TYPES,
} from "../kpi/constants"
import { ratingFor, resolvePeriodRange, formatPeriodLabel, scoringOptions, weightedScore } from "../kpi/scoring"
import { builtinIndicatorCatalog, computeBuiltinForEmployees, getBuiltinIndicator } from "../kpi/indicators"
import {
  createTargetAssignment, decideAchievements, decideTarget,
  kpiActionHistory, kpiSettings, recordKpiAction, refreshBatchStatus,
  updateTargetAssignment, upsertAchievements,
} from "../kpi/service"
import {
  generateAchievementTemplate, generateAchievementsExport, generateTargetTemplate,
  generateTargetsExport, parseAchievementUpload, parseTargetUpload, readWorkbook,
  type AchievementRefRow, type AchievementTemplateRow,
} from "../kpi/excel"

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

const UNIT_ENUM = z.enum(KPI_UNITS.map((u) => u.value) as [string, ...string[]])
const DIRECTION_ENUM = z.enum(KPI_DIRECTIONS.map((d) => d.value) as [string, ...string[]])

const indicatorInput = z.object({
  indicatorId: z.string().trim().min(1).max(40).nullish(),
  name: z.string().trim().min(1).max(120).nullish(),
  description: z.string().trim().max(500).nullish(),
  builtinKey: z.string().trim().max(60).nullish(),
  unit: UNIT_ENUM,
  unitLabel: z.string().trim().max(30).nullish(),
  direction: DIRECTION_ENUM,
  weight: z.number().min(0).max(100),
  targetValue: z.number().min(0).nullish(),
  sortOrder: z.number().int().min(0).max(999).nullish(),
}).strict()

/** The typed shape of one indicator in template/assignment save payloads —
 *  the dispatcher validates with the schema above; this alias keeps handler
 *  callbacks over `p.indicators` explicitly typed (the registry types the
 *  handler payload as `any`). */
type IndicatorInput = z.infer<typeof indicatorInput>

const periodLabelSchema = z.string().trim().min(4).max(20)
const dueDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish()

/** Filter-tolerant optional string: "" (the "all" option in selects) and
 * null both normalize to null — the UI never has to guess which to send. */
const optFilter = (max = 40) => z.preprocess((v) => (v === "" ? null : v), z.string().trim().min(1).max(max).nullish())
const optPeriod = () => z.preprocess((v) => (v === "" ? null : v), periodLabelSchema.nullish())

const paginationSchema = {
  page: z.number().int().min(1).nullish(),
  pageSize: z.number().int().min(1).max(500).nullish(),
}

const ELIGIBLE_EMPLOYEE_STATUSES = ["ACTIVE", "PROBATION", "ON_LEAVE"]

/** Map-of-lists push helper (avoids non-null assertions). */
function pushTo<T>(m: Map<string, T[]>, k: string, v: T): void {
  const arr = m.get(k)
  if (arr) arr.push(v)
  else m.set(k, [v])
}

/** Eligible-employee base: company + caller scope + optional department. */
function eligibleEmployeeWhere(ctx: Ctx, p: { departmentId?: string | null; employmentType?: string | null; branchId?: string | null; designationId?: string | null }) {
  const where: any = { ...employeeScopeFilter(ctx), status: { in: ELIGIBLE_EMPLOYEE_STATUSES } }
  if (p.departmentId) where.departmentId = p.departmentId
  if (p.employmentType) where.employmentType = p.employmentType
  if (p.branchId) where.branchId = p.branchId
  if (p.designationId) where.designationId = p.designationId
  return where
}

async function orgNames(vendorId: string) {
  const [departments, designations, users] = await Promise.all([
    db.department.findMany({ where: { vendorId }, select: { id: true, name: true, companyId: true } }),
    db.designation.findMany({ where: { vendorId }, select: { id: true, name: true } }),
    db.user.findMany({ where: { vendorId }, select: { id: true, name: true } }),
  ])
  return {
    deptById: new Map(departments.map((d) => [d.id, d])),
    desigById: new Map(designations.map((d) => [d.id, d.name])),
    userById: new Map(users.map((u) => [u.id, u.name])),
  }
}

function pageParams(p: any) {
  const pageSize = Math.min(500, Math.max(1, Number(p?.pageSize) || 50))
  const page = Math.max(1, Number(p?.page) || 1)
  return { pageSize, page, skip: (page - 1) * pageSize, take: pageSize }
}

// ---------------------------------------------------------------------------
// System built-in indicator registry
// ---------------------------------------------------------------------------

route("kpi.builtinIndicators", {
  perm: ["kpi", "view"],
  handler: async () => builtinIndicatorCatalog(),
})

// ---------------------------------------------------------------------------
// TEMPLATES
// ---------------------------------------------------------------------------

/** Decorated template rows (indicators grouped, department joined). */
async function templateList(ctx: Ctx, p: { departmentId?: string | null; active?: boolean | null }) {
  const where: any = companyWhere(ctx, { deletedAt: null })
  if (p.departmentId) where.departmentId = p.departmentId
  if (p.active != null) where.active = p.active
  const templates = await db.kpiTemplate.findMany({ where, orderBy: { createdAt: "desc" } })
  if (!templates.length) return []
  const ids = templates.map((t) => t.id)
  const [indicators, { deptById }, counts] = await Promise.all([
    db.kpiIndicator.findMany({ where: { templateId: { in: ids } }, orderBy: { sortOrder: "asc" } }),
    orgNames(ctx.vendorId),
    db.kpiAssignment.groupBy({ by: ["templateId"], where: { vendorId: ctx.vendorId, templateId: { in: ids } }, _count: { _all: true } }),
  ])
  const indsByTemplate = new Map<string, any[]>()
  for (const i of indicators) pushTo(indsByTemplate, i.templateId, i)
  const countByTemplate = new Map(counts.map((c) => [c.templateId, c._count._all]))
  return templates.map((t) => ({
    ...t,
    items: j(t.itemsJson, []),
    indicators: (indsByTemplate.get(t.id) || []).map((i) => ({ ...i, builtinDef: i.builtinKey ? getBuiltinIndicator(i.builtinKey) || null : null })),
    departmentName: t.departmentId ? deptById.get(t.departmentId)?.name || null : null,
    assignmentCount: countByTemplate.get(t.id) || 0,
  }))
}

route("kpi.templates.list", {
  perm: ["kpi", "view"],
  handler: async (ctx, p) => templateList(ctx, { departmentId: p?.departmentId, active: p?.active }),
})

route("kpi.templates.get", {
  perm: ["kpi", "view"],
  schema: z.object({ id: z.string().trim().min(1).max(40) }).strict(),
  handler: async (ctx, p) => {
    const t = await db.kpiTemplate.findFirst({ where: { id: p.id, vendorId: ctx.vendorId, deletedAt: null } })
    if (!t) throw new Deny("KPI template not found", 404)
    const [indicators, { deptById }, assignmentCount] = await Promise.all([
      db.kpiIndicator.findMany({ where: { templateId: t.id }, orderBy: { sortOrder: "asc" } }),
      orgNames(ctx.vendorId),
      db.kpiAssignment.count({ where: { vendorId: ctx.vendorId, templateId: t.id } }),
    ])
    return {
      ...t,
      items: j(t.itemsJson, []),
      indicators: indicators.map((i) => ({ ...i, builtinDef: i.builtinKey ? getBuiltinIndicator(i.builtinKey) || null : null })),
      departmentName: t.departmentId ? deptById.get(t.departmentId)?.name || null : null,
      assignmentCount,
    }
  },
})

/** Template payload for create/update — indicators arrive in display order. */
const templateSaveSchema = z.object({
  id: z.string().trim().min(1).max(40).nullish(),
  companyId: z.string().trim().min(1).max(40).nullish(),
  departmentId: z.string().trim().min(1).max(40),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).nullish(),
  periodType: z.enum(KPI_PERIOD_TYPES as unknown as [string, ...string[]]).nullish(),
  indicators: z.array(indicatorInput).min(1).max(50),
  active: z.boolean().nullish(),
}).strict()

/** Uniqueness: ONE template per (company, department) regardless of active
 * state — an inactive template still holds the slot; reactivation goes
 * through the existing template. */
async function assertTemplateSlotFree(vendorId: string, companyId: string, departmentId: string, exceptId?: string) {
  const existing = await db.kpiTemplate.findFirst({
    where: { vendorId, companyId, departmentId, deletedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true, name: true, active: true },
  })
  if (existing) {
    throw new Deny(
      `${existing.name} is already the KPI template for this company + department${existing.active ? "" : " (currently inactive — reactivate it instead of creating a duplicate)"}`,
      409,
    )
  }
}

/** Keep the legacy itemsJson mirror in sync with the indicator rows. */
function legacyItemsJson(indicators: { name: string; unit: string; unitLabel: string | null; weight: number; targetValue: number | null; defaultTarget: number | null }[]) {
  return JSON.stringify(indicators.map((i) => ({
    name: i.name,
    target: i.targetValue ?? i.defaultTarget ?? 0,
    unit: i.unit === "PERCENT" ? "%" : i.unitLabel || i.unit,
    weight: i.weight,
  })))
}

route("kpi.templates.create", {
  perm: ["kpi", "create"],
  mutating: true,
  schema: templateSaveSchema,
  handler: async (ctx, p) => {
    const companyId = await resolveCreateCompany(ctx, p.companyId)
    const dept = await db.department.findFirst({ where: { id: p.departmentId, vendorId: ctx.vendorId } })
    if (!dept) throw new Deny("Department not found", 404)
    if (dept.companyId !== companyId) throw new Deny("The department belongs to a different company", 400)
    await assertTemplateSlotFree(ctx.vendorId, companyId, p.departmentId)
    // validation: weights total 100, unique names, valid builtin keys
    const names = new Set<string>()
    const totalWeight = p.indicators.reduce((s: number, i: IndicatorInput) => s + i.weight, 0)
    if (Math.round(totalWeight * 100) !== 10000) throw new Deny(`Indicator weights must total exactly 100% — currently ${Math.round(totalWeight * 100) / 100}%`, 400)
    for (const i of p.indicators) {
      const name = (i.name || "").trim()
      if (!name) throw new Deny("Every indicator needs a name", 400)
      if (names.has(name.toLowerCase())) throw new Deny(`Duplicate indicator name: ${name}`, 400)
      names.add(name.toLowerCase())
      if (i.builtinKey && !getBuiltinIndicator(i.builtinKey)) throw new Deny(`Unknown built-in indicator: ${i.builtinKey}`, 400)
    }
    const rec = await db.kpiTemplate.create({
      data: {
        vendorId: ctx.vendorId,
        companyId,
        departmentId: p.departmentId,
        name: p.name,
        description: p.description || null,
        periodType: p.periodType || "MONTHLY",
        active: p.active !== false,
        createdBy: ctx.userId,
        itemsJson: legacyItemsJson(p.indicators),
      },
    })
    await db.kpiIndicator.createMany({
      data: p.indicators.map((i: IndicatorInput, idx: number) => ({
        vendorId: ctx.vendorId,
        templateId: rec.id,
        name: (i.name || "Indicator").trim(),
        description: i.description || null,
        source: i.builtinKey ? "BUILTIN" : "CUSTOM",
        builtinKey: i.builtinKey || null,
        unit: i.unit,
        unitLabel: i.unitLabel || null,
        direction: i.direction,
        defaultTarget: i.targetValue ?? null,
        weight: i.weight,
        sortOrder: i.sortOrder ?? idx + 1,
        active: true,
      })),
    })
    await audit(ctx, "kpi.templates.create", "KpiTemplate", rec.id,
      `Created KPI template "${p.name}" (${p.indicators.length} indicators) for ${dept.name}`, { newValue: { name: p.name, departmentId: p.departmentId, indicators: p.indicators.length } })
    return rec
  },
})

route("kpi.templates.update", {
  perm: ["kpi", "edit"],
  mutating: true,
  schema: templateSaveSchema,
  handler: async (ctx, p) => {
    if (!p.id) throw new Deny("Template id is required", 400)
    const rec = await db.kpiTemplate.findFirst({ where: { id: p.id, vendorId: ctx.vendorId, deletedAt: null, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
    if (!rec) throw new Deny("KPI template not found", 404)
    if (p.departmentId !== rec.departmentId) {
      // department re-assignment = a new slot — same uniqueness rule
      const dept = await db.department.findFirst({ where: { id: p.departmentId, vendorId: ctx.vendorId } })
      if (!dept) throw new Deny("Department not found", 404)
      if (dept.companyId !== rec.companyId) throw new Deny("The department belongs to a different company", 400)
      await assertTemplateSlotFree(ctx.vendorId, rec.companyId || "", p.departmentId, rec.id)
    }
    const names = new Set<string>()
    const totalWeight = p.indicators.reduce((s: number, i: IndicatorInput) => s + i.weight, 0)
    if (Math.round(totalWeight * 100) !== 10000) throw new Deny(`Indicator weights must total exactly 100% — currently ${Math.round(totalWeight * 100) / 100}%`, 400)
    for (const i of p.indicators) {
      const name = (i.name || "").trim()
      if (!name) throw new Deny("Every indicator needs a name", 400)
      if (names.has(name.toLowerCase())) throw new Deny(`Duplicate indicator name: ${name}`, 400)
      names.add(name.toLowerCase())
      if (i.builtinKey && !getBuiltinIndicator(i.builtinKey)) throw new Deny(`Unknown built-in indicator: ${i.builtinKey}`, 400)
    }
    // M-5 ratchet — the where-clause itself carries the tenant scope (the
    // preceding findFirst is defense in depth, not the safety mechanism)
    await db.kpiTemplate.updateMany({
      where: { id: rec.id, vendorId: ctx.vendorId },
      data: {
        name: p.name,
        departmentId: p.departmentId,
        description: p.description || null,
        periodType: p.periodType || rec.periodType,
        active: p.active != null ? p.active : rec.active,
        itemsJson: legacyItemsJson(p.indicators),
      },
    })
    // Replace the indicator set. Historical assignments are NEVER mutated —
    // they hold their own snapshots (KpiAssignmentIndicator rows).
    await db.kpiIndicator.deleteMany({ where: { templateId: rec.id } })
    await db.kpiIndicator.createMany({
      data: p.indicators.map((i: IndicatorInput, idx: number) => ({
        vendorId: ctx.vendorId,
        templateId: rec.id,
        name: (i.name || "Indicator").trim(),
        description: i.description || null,
        source: i.builtinKey ? "BUILTIN" : "CUSTOM",
        builtinKey: i.builtinKey || null,
        unit: i.unit,
        unitLabel: i.unitLabel || null,
        direction: i.direction,
        defaultTarget: i.targetValue ?? null,
        weight: i.weight,
        sortOrder: i.sortOrder ?? idx + 1,
        active: true,
      })),
    })
    await audit(ctx, "kpi.templates.update", "KpiTemplate", rec.id,
      `Updated KPI template "${p.name}" (${p.indicators.length} indicators). Existing assignments keep their historical snapshots.`,
      { oldValue: { name: rec.name, indicators: j(rec.itemsJson, []).length }, newValue: { name: p.name, indicators: p.indicators.length } })
    return { updated: true }
  },
})

route("kpi.templates.setStatus", {
  perm: ["kpi", "edit"],
  mutating: true,
  schema: z.object({ id: z.string().trim().min(1).max(40), active: z.boolean() }).strict(),
  handler: async (ctx, p) => {
    const rec = await db.kpiTemplate.findFirst({ where: { id: p.id, vendorId: ctx.vendorId, deletedAt: null } })
    if (!rec) throw new Deny("KPI template not found", 404)
    await db.kpiTemplate.updateMany({ where: { id: rec.id, vendorId: ctx.vendorId }, data: { active: p.active } })
    await audit(ctx, "kpi.templates.setStatus", "KpiTemplate", rec.id, `${p.active ? "Activated" : "Deactivated"} KPI template "${rec.name}"`)
    return { updated: true }
  },
})

route("kpi.templates.delete", {
  perm: ["kpi", "delete"],
  mutating: true,
  schema: z.object({ id: z.string().trim().min(1).max(40), confirm: z.literal("DELETE") }).strict(),
  handler: async (ctx, p) => {
    const rec = await db.kpiTemplate.findFirst({ where: { id: p.id, vendorId: ctx.vendorId, deletedAt: null } })
    if (!rec) throw new Deny("KPI template not found", 404)
    const used = await db.kpiAssignment.count({ where: { vendorId: ctx.vendorId, templateId: rec.id } })
    if (used > 0) {
      // historical assignments exist → archival, never a drop
      await db.kpiTemplate.updateMany({ where: { id: rec.id, vendorId: ctx.vendorId }, data: { deletedAt: new Date(), active: false } })
      await audit(ctx, "kpi.templates.delete", "KpiTemplate", rec.id,
        `Archived KPI template "${rec.name}" (${used} historical assignment(s) preserved — soft delete)`, { oldValue: { name: rec.name, assignments: used } })
      return { archived: true, assignments: used }
    }
    await db.kpiTemplate.deleteMany({ where: { id: rec.id, vendorId: ctx.vendorId } }) // indicators cascade via FK
    await audit(ctx, "kpi.templates.delete", "KpiTemplate", rec.id, `Deleted KPI template "${rec.name}" (no assignments)`, { oldValue: { name: rec.name } })
    return { deleted: true }
  },
})

/** Per-department template availability + eligible-employee counts — powers
 * the template creation UX and the assignment dashboard context. */
route("kpi.templates.departmentSummary", {
  perm: ["kpi", "view"],
  schema: z.object({ periodLabel: periodLabelSchema.nullish(), ...paginationSchema }).strict().partial().optional(),
  handler: async (ctx, p) => {
    const where: any = companyWhere(ctx)
    const [departments, templates, indicators] = await Promise.all([
      db.department.findMany({ where, orderBy: { name: "asc" } }),
      db.kpiTemplate.findMany({ where: { ...companyWhere(ctx), deletedAt: null } }),
      db.kpiIndicator.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { sortOrder: "asc" } }),
    ])
    const tmplByDept = new Map(templates.filter((t) => t.departmentId).map((t) => [String(t.departmentId), t]))
    const indsByTemplate = new Map<string, number>()
    for (const i of indicators) indsByTemplate.set(i.templateId, (indsByTemplate.get(i.templateId) || 0) + 1)
    const eligible = await db.employee.groupBy({
      by: ["departmentId"],
      where: eligibleEmployeeWhere(ctx, {}),
      _count: { _all: true },
    })
    const eligibleByDept = new Map(eligible.map((e) => [e.departmentId, e._count._all]))
    let assignedByDept: Map<string | null, number> | null = null
    if (p?.periodLabel) {
      const assigned = await db.kpiAssignment.groupBy({
        by: ["employeeId"],
        where: { vendorId: ctx.vendorId, periodLabel: p.periodLabel, status: { not: "CANCELLED" } },
      })
      const assignedIds = assigned.map((a) => a.employeeId)
      if (assignedIds.length) {
        const emps = await db.employee.findMany({ where: { vendorId: ctx.vendorId, id: { in: assignedIds } }, select: { departmentId: true } })
        assignedByDept = new Map<string | null, number>()
        for (const e of emps) assignedByDept.set(e.departmentId, (assignedByDept.get(e.departmentId) || 0) + 1)
      }
    }
    return departments.map((d) => {
      const t = tmplByDept.get(d.id)
      return {
        departmentId: d.id,
        departmentName: d.name,
        template: t ? { id: t.id, name: t.name, active: t.active, periodType: t.periodType, indicatorCount: indsByTemplate.get(t.id) || 0 } : null,
        eligibleEmployees: eligibleByDept.get(d.id) || 0,
        assignedThisPeriod: assignedByDept ? assignedByDept.get(d.id) || 0 : null,
      }
    })
  },
})

// ---------------------------------------------------------------------------
// TARGETS — summary + list + detail
// ---------------------------------------------------------------------------

route("kpi.targets.summary", {
  perm: ["kpi", "view"],
  schema: z.object({ departmentId: optFilter(), periodLabel: optPeriod() }).strict().partial().optional(),
  handler: async (ctx, p) => {
    const empWhere = eligibleEmployeeWhere(ctx, { departmentId: p?.departmentId || null })
    const employees = await db.employee.findMany({ where: empWhere, select: { id: true }, take: KPI_IMPORT_MAX_ROWS })
    const empIds = employees.map((e) => e.id)
    const assignments = empIds.length
      ? await db.kpiAssignment.findMany({
          where: {
            vendorId: ctx.vendorId,
            ...(p?.periodLabel ? { periodLabel: p.periodLabel } : {}),
            status: { not: "CANCELLED" },
            employeeId: { in: empIds },
          },
          select: { employeeId: true, status: true, periodLabel: true },
        })
      : []
    const totalEmployees = employees.length
    const assignedEmployees = new Set(assignments.map((a) => a.employeeId))
    const byStatus = assignments.reduce<Record<string, number>>((m, a) => ({ ...m, [a.status]: (m[a.status] || 0) + 1 }), {})
    return {
      totalEmployees,
      assigned: assignedEmployees.size,
      notAssigned: Math.max(0, totalEmployees - assignedEmployees.size),
      pendingApproval: byStatus.PENDING_APPROVAL || 0,
      approved: byStatus.APPROVED || 0,
      rejected: byStatus.REJECTED || 0,
      changesRequested: byStatus.CHANGES_REQUESTED || 0,
      drafts: byStatus.DRAFT || 0,
    }
  },
})

route("kpi.targets.list", {
  perm: ["kpi", "view"],
  schema: z.object({
    q: z.string().trim().max(80).nullish(),
    departmentId: optFilter(),
    periodLabel: optPeriod(),
    status: optFilter(30),
    dueDate: z.preprocess((v) => (v === "" ? null : v), z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish()),
    ...paginationSchema,
  }).strict().partial().optional(),
  handler: async (ctx, p) => {
    const where: any = { vendorId: ctx.vendorId }
    if (p?.status) where.status = p.status
    if (p?.periodLabel) where.periodLabel = p.periodLabel
    if (p?.dueDate) where.dueDate = p.dueDate
    if (p?.departmentId) {
      const ids = await db.employee.findMany({ where: { vendorId: ctx.vendorId, departmentId: p.departmentId }, select: { id: true } })
      where.employeeId = { in: ids.map((e) => e.id) }
    }
    const scope = employeeScopeFilter(ctx)
    const scopedEmps = await db.employee.findMany({ where: scope, select: { id: true } })
    const scopedIds = new Set(scopedEmps.map((e) => e.id))
    // intersect the department/period filter with the caller's scope
    if (where.employeeId?.in) where.employeeId = { in: (where.employeeId.in as string[]).filter((id) => scopedIds.has(id)) }
    else where.employeeId = { in: [...scopedIds] }
    if (p?.q) {
      const matching = await db.employee.findMany({
        where: { vendorId: ctx.vendorId, OR: [{ fullName: { contains: p.q, mode: "insensitive" } }, { code: { contains: p.q, mode: "insensitive" } }] },
        select: { id: true },
      })
      const qIds = new Set(matching.map((m) => m.id))
      where.employeeId = { in: (where.employeeId.in as string[]).filter((id) => qIds.has(id)) }
    }
    const { pageSize, page, skip, take } = pageParams(p)
    const [list, total] = await Promise.all([
      db.kpiAssignment.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip, take }),
      db.kpiAssignment.count({ where }),
    ])
    const pageEmpIds = [...new Set(list.map((a) => a.employeeId))]
    const [employees, { deptById, desigById, userById }, indicatorRows] = await Promise.all([
      db.employee.findMany({ where: { vendorId: ctx.vendorId, id: { in: pageEmpIds } }, select: { id: true, code: true, fullName: true, departmentId: true, designationId: true } }),
      orgNames(ctx.vendorId),
      list.length ? db.kpiAssignmentIndicator.findMany({ where: { assignmentId: { in: list.map((a) => a.id) } }, orderBy: { sortOrder: "asc" } }) : [],
    ])
    const empById = new Map(employees.map((e) => [e.id, e]))
    const indsByAssignment = new Map<string, any[]>()
    for (const r of indicatorRows) pushTo(indsByAssignment, r.assignmentId, r)
    const items = list.map((a) => {
      const emp = empById.get(a.employeeId)
      const inds = indsByAssignment.get(a.id) || []
      return {
        ...a,
        results: j(a.resultsJson, []),
        employeeCode: emp?.code || "—",
        employeeName: emp?.fullName || "—",
        departmentName: emp?.departmentId ? deptById.get(emp.departmentId)?.name || null : null,
        designationName: emp?.designationId ? desigById.get(emp.designationId) || null : null,
        indicators: inds,
        indicatorSummary: inds.map((i) => ({ name: i.name, target: i.targetValue, unit: i.unitLabel || i.unit, weight: i.weight })),
        createdByName: a.createdBy ? userById.get(a.createdBy) || null : null,
        decidedByName: a.decidedBy ? userById.get(a.decidedBy) || null : null,
      }
    })
    return { items, total, page, pageSize }
  },
})

route("kpi.targets.get", {
  perm: ["kpi", "view"],
  schema: z.object({ id: z.string().trim().min(1).max(40) }).strict(),
  handler: async (ctx, p) => {
    const a = await db.kpiAssignment.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!a) throw new Deny("KPI target assignment not found", 404)
    await assertEmployeeVisible(ctx, a.employeeId)
    const [emp, inds, achievements, history, revisions, template, { deptById, desigById, userById }] = await Promise.all([
      db.employee.findUnique({ where: { id: a.employeeId }, select: { id: true, code: true, fullName: true, departmentId: true, designationId: true, status: true } }),
      db.kpiAssignmentIndicator.findMany({ where: { assignmentId: a.id }, orderBy: { sortOrder: "asc" } }),
      db.kpiAchievement.findMany({ where: { assignmentId: a.id } }),
      kpiActionHistory(ctx.vendorId, "KPI_TARGET", a.id),
      db.kpiRevision.findMany({ where: { entityType: "KPI_TARGET", entityId: a.id }, orderBy: { revision: "desc" } }),
      a.templateId ? db.kpiTemplate.findUnique({ where: { id: a.templateId }, select: { id: true, name: true } }) : Promise.resolve(null),
      orgNames(ctx.vendorId),
    ])
    const achByRow = new Map(achievements.map((x) => [x.indicatorRowId, x]))
    return {
      ...a,
      results: j(a.resultsJson, []),
      employee: emp ? { ...emp, departmentName: emp.departmentId ? deptById.get(emp.departmentId)?.name || null : null, designationName: emp.designationId ? desigById.get(emp.designationId) || null : null } : null,
      templateName: template?.name || null,
      indicators: inds.map((i) => ({ ...i, achievement: achByRow.get(i.id) || null })),
      achievements,
      history,
      revisions: revisions.map((r) => ({ ...r, snapshot: j(r.snapshotJson, null), snapshotJson: undefined })),
      createdByName: a.createdBy ? userById.get(a.createdBy) || null : null,
      decidedByName: a.decidedBy ? userById.get(a.decidedBy) || null : null,
    }
  },
})

// ---------------------------------------------------------------------------
// TARGETS — assign / update / decide / cancel
// ---------------------------------------------------------------------------

const targetAssignSchema = z.object({
  employeeId: z.string().trim().min(1).max(40),
  templateId: z.string().trim().min(1).max(40).nullish(),
  periodLabel: periodLabelSchema,
  dueDate: dueDateSchema,
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  remarks: z.string().trim().max(1000).nullish(),
  indicators: z.array(indicatorInput).min(1).max(50),
  submit: z.boolean().nullish(),
}).strict()

route("kpi.targets.assign", {
  perm: ["kpi", "assign"],
  mutating: true,
  schema: targetAssignSchema,
  handler: async (ctx, p) => {
    const emp = await assertEmployeeVisible(ctx, p.employeeId, { forWrite: true })
    // resolve the department template: explicit templateId (must match the
    // employee's department) or the employee's own department template
    let template: any = null
    if (p.templateId) {
      template = await db.kpiTemplate.findFirst({ where: { id: p.templateId, vendorId: ctx.vendorId, deletedAt: null } })
      if (!template) throw new Deny("KPI template not found", 404)
      if (template.departmentId && template.departmentId !== emp.departmentId) {
        throw new Deny("This template belongs to a different department than the employee's", 400)
      }
      if (template.companyId && emp.companyId && template.companyId !== emp.companyId) {
        throw new Deny("This template belongs to a different company", 400)
      }
    } else if (emp.departmentId && emp.companyId) {
      template = await db.kpiTemplate.findFirst({ where: { vendorId: ctx.vendorId, companyId: emp.companyId, departmentId: emp.departmentId, deletedAt: null } })
    }
    // employee-specific custom indicators are allowed even without a template
    if (!template && p.indicators.every((i: IndicatorInput) => i.indicatorId)) {
      throw new Deny("No KPI template is configured for this employee's department — create one first, or add employee-specific custom indicators", 400)
    }
    // template-linked indicator ids must belong to the resolved template
    const templateIndicatorIds = template
      ? new Set((await db.kpiIndicator.findMany({ where: { templateId: template.id }, select: { id: true } })).map((i) => i.id))
      : new Set<string>()
    for (const i of p.indicators) {
      if (i.indicatorId && !templateIndicatorIds.has(i.indicatorId)) {
        throw new Deny("Indicator does not belong to the resolved template", 400)
      }
    }
    const rec = await createTargetAssignment({
      vendorId: ctx.vendorId,
      employeeId: p.employeeId,
      templateId: template?.id ?? null,
      periodLabel: p.periodLabel,
      dueDate: p.dueDate || null,
      periodStart: p.periodStart || null,
      periodEnd: p.periodEnd || null,
      remarks: p.remarks || null,
      createdBy: ctx.userId,
      companyId: ctx.activeCompanyId || null,
      indicators: p.indicators,
      submit: p.submit !== false,
    })
    if (!rec) throw new Deny("Could not create the KPI target assignment", 500)
    await audit(ctx, "kpi.targets.assign", "KpiAssignment", rec.id,
      `Assigned KPI target to ${emp.fullName} for ${p.periodLabel} (${p.indicators.length} indicator(s))${p.submit === false ? " — draft" : " — submitted for approval"}`)
    await recordKpiAction(ctx.vendorId, { entityType: "KPI_TARGET", entityId: rec.id, employeeId: p.employeeId, action: "SUBMIT", comment: p.submit === false ? "draft created" : undefined }, ctx)
    if (p.submit !== false) {
      const { notify } = await import("../audit")
      await notify(ctx.vendorId, { role: "HR_ADMIN" }, "KPI Target Submitted",
        `A KPI target for ${emp.fullName} (${p.periodLabel}) is waiting for approval.`, "SYSTEM", "performance")
    }
    return rec
  },
})

route("kpi.targets.update", {
  perm: ["kpi", "assign"],
  mutating: true,
  schema: z.object({
    id: z.string().trim().min(1).max(40),
    dueDate: dueDateSchema,
    remarks: z.string().trim().max(1000).nullish(),
    indicators: z.array(indicatorInput.merge(z.object({ id: z.string().trim().min(1).max(40).nullish() }))).min(1).max(50).nullish(),
    resubmit: z.boolean().nullish(),
  }).strict(),
  handler: async (ctx, p) => {
    const existing = await db.kpiAssignment.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!existing) throw new Deny("KPI target assignment not found", 404)
    await assertEmployeeVisible(ctx, existing.employeeId, { forWrite: true })
    return updateTargetAssignment(ctx, {
      assignmentId: p.id,
      dueDate: p.dueDate === undefined ? undefined : p.dueDate || null,
      remarks: p.remarks === undefined ? undefined : p.remarks,
      indicators: p.indicators || undefined,
      resubmit: p.resubmit || false,
    })
  },
})

route("kpi.targets.decide", {
  perm: ["kpi", "approve"],
  mutating: true,
  schema: z.object({
    id: z.string().trim().min(1).max(40),
    decision: z.enum(["APPROVE", "REJECT", "REQUEST_CHANGES"]),
    comment: z.string().trim().max(1000).nullish(),
  }).strict(),
  handler: async (ctx, p) => decideTarget(ctx, p.id, p.decision, p.comment || undefined),
})

route("kpi.targets.cancel", {
  perm: ["kpi", "edit"],
  mutating: true,
  schema: z.object({ id: z.string().trim().min(1).max(40), reason: z.string().trim().min(3).max(500) }).strict(),
  handler: async (ctx, p) => {
    const rec = await db.kpiAssignment.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!rec) throw new Deny("KPI target assignment not found", 404)
    await assertEmployeeVisible(ctx, rec.employeeId, { forWrite: true })
    if (rec.status === "CANCELLED") throw new Deny("Already cancelled", 409)
    const res = await db.kpiAssignment.updateMany({
      where: { id: rec.id, vendorId: ctx.vendorId, status: { not: "CANCELLED" } },
      data: { status: "CANCELLED" },
    })
    if (res.count === 0) throw new Deny("Just updated by another user — reload", 409)
    await recordKpiAction(ctx.vendorId, { entityType: "KPI_TARGET", entityId: rec.id, employeeId: rec.employeeId, action: "CANCEL", comment: p.reason }, ctx)
    await audit(ctx, "kpi.targets.cancel", "KpiAssignment", rec.id, `Cancelled KPI target (${rec.periodLabel}) — ${p.reason}`, { reason: p.reason })
    if (rec.batchId) await refreshBatchStatus(ctx.vendorId, rec.batchId)
    return { cancelled: true }
  },
})

// ---------------------------------------------------------------------------
// TARGETS — bulk Excel (template download → preview → submit)
// ---------------------------------------------------------------------------

const bulkTargetConfig = z.object({
  departmentId: z.string().trim().min(1).max(40),
  periodLabel: periodLabelSchema,
  dueDate: dueDateSchema,
  employmentType: z.string().trim().max(40).nullish(),
  branchId: z.string().trim().max(40).nullish(),
  designationId: z.string().trim().max(40).nullish(),
  remarks: z.string().trim().max(1000).nullish(),
}).strict()

async function bulkTargetContext(ctx: Ctx, p: z.infer<typeof bulkTargetConfig>) {
  const dept = await db.department.findFirst({ where: { id: p.departmentId, vendorId: ctx.vendorId } })
  if (!dept) throw new Deny("Department not found", 404)
  const companyId = dept.companyId
  if (!companyId) throw new Deny("The department has no owning company — fix the department setup first", 400)
  if (ctx.activeCompanyId && !ctx.allCompaniesMode && ctx.activeCompanyId !== companyId) {
    throw new Deny("The department belongs to a different company than your active one", 403)
  }
  const template = await db.kpiTemplate.findFirst({ where: { vendorId: ctx.vendorId, companyId, departmentId: p.departmentId, deletedAt: null } })
  if (!template) throw new Deny(`No KPI template exists for ${dept.name} — create the Company + Department template first`, 400)
  if (!template.active) throw new Deny(`The KPI template for ${dept.name} is inactive — reactivate it before bulk assignment`, 400)
  const indicators = await db.kpiIndicator.findMany({ where: { vendorId: ctx.vendorId, templateId: template.id, active: true }, orderBy: { sortOrder: "asc" } })
  if (!indicators.length) throw new Deny("The template has no active indicators", 400)
  // eligible employees: department members in the caller's scope, minus those
  // already holding ANY (non-cancelled) assignment for the period
  const employees = await db.employee.findMany({
    where: eligibleEmployeeWhere(ctx, { departmentId: p.departmentId, employmentType: p.employmentType, branchId: p.branchId, designationId: p.designationId }),
    select: { id: true, code: true, fullName: true, departmentId: true, designationId: true },
    take: KPI_IMPORT_MAX_ROWS + 1,
    orderBy: { code: "asc" },
  })
  if (employees.length > KPI_IMPORT_MAX_ROWS) throw new Deny(`More than ${KPI_IMPORT_MAX_ROWS} employees match — narrow the filters`, 400)
  const existing = employees.length
    ? await db.kpiAssignment.findMany({
        where: { vendorId: ctx.vendorId, periodLabel: p.periodLabel, status: { not: "CANCELLED" }, employeeId: { in: employees.map((e) => e.id) } },
        select: { employeeId: true },
      })
    : []
  const existingIds = new Set(existing.map((e) => e.employeeId))
  return { dept, companyId, template, indicators, employees, existingIds }
}

route("kpi.targets.bulkTemplate", {
  perm: ["kpi", "assign"],
  schema: bulkTargetConfig,
  handler: async (ctx, p) => {
    const { dept, companyId, template, indicators, employees, existingIds } = await bulkTargetContext(ctx, p)
    const company = await db.company.findUnique({ where: { id: companyId }, select: { name: true } })
    const { desigById } = await orgNames(ctx.vendorId)
    const eligible = employees.filter((e) => !existingIds.has(e.id))
    const buf = generateTargetTemplate({
      companyName: company?.name || "—",
      departmentName: dept.name,
      periodLabel: p.periodLabel,
      periodStart: resolvePeriodRange(p.periodLabel)?.start || null,
      periodEnd: resolvePeriodRange(p.periodLabel)?.end || null,
      dueDate: p.dueDate || null,
      templateName: template.name,
      indicators: indicators.map((i) => ({
        id: i.id, name: i.name, unit: i.unit as any, unitLabel: i.unitLabel,
        direction: i.direction as any, weight: i.weight, defaultTarget: i.defaultTarget, builtinKey: i.builtinKey,
      })),
      employees: eligible.map((e) => ({
        code: e.code, fullName: e.fullName, departmentName: dept.name,
        designationName: e.designationId ? desigById.get(e.designationId) || "" : "",
      })),
    })
    await audit(ctx, "kpi.targets.bulkTemplate", "KpiTemplate", template.id,
      `Downloaded the bulk KPI target template for ${dept.name} · ${p.periodLabel} (${eligible.length} eligible employee(s))`)
    return {
      filename: `kpi-targets-${dept.name.toLowerCase().replace(/\s+/g, "-")}-${p.periodLabel}.xlsx`,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      base64: buf.toString("base64"),
      eligibleEmployees: eligible.length,
      alreadyAssigned: existingIds.size,
      indicators: indicators.map((i) => ({ id: i.id, name: i.name, unit: i.unit, unitLabel: i.unitLabel, direction: i.direction, weight: i.weight, defaultTarget: i.defaultTarget, builtinKey: i.builtinKey })),
    }
  },
})

async function parseBulkTargetFile(ctx: Ctx, p: { base64: string } & z.infer<typeof bulkTargetConfig>) {
  if (!p.base64) throw new Deny("Upload the completed Excel file first", 400)
  if (p.base64.length > KPI_IMPORT_MAX_BYTES * 1.4) throw new Deny("File too large (max ~8 MB)", 400)
  const { dept, companyId, template, indicators, employees, existingIds } = await bulkTargetContext(ctx, p)
  let wb: import("xlsx").WorkBook
  try {
    wb = readWorkbook(p.base64)
  } catch {
    throw new Deny("Could not read the file — export the template from this wizard, fill it and upload the .xlsx", 400)
  }
  const { desigById } = await orgNames(ctx.vendorId)
  const eligibleByCode = new Map(employees.map((e) => [e.code, {
    code: e.code, fullName: e.fullName, departmentName: dept.name,
    designationName: e.designationId ? desigById.get(e.designationId) || "" : "",
    departmentId: e.departmentId || "", id: e.id,
  }]))
  const existingEmployeeIdsByCode = new Map<string, string>()
  for (const e of employees) if (existingIds.has(e.id)) existingEmployeeIdsByCode.set(e.code, e.id)
  const parsed = parseTargetUpload(wb, {
    indicators: indicators.map((i) => ({
      id: i.id, name: i.name, unit: i.unit as any, unitLabel: i.unitLabel,
      direction: i.direction as any, weight: i.weight, defaultTarget: i.defaultTarget, builtinKey: i.builtinKey,
    })),
    eligibleByCode,
    existingEmployeeIdsByCode,
  })
  return { dept, companyId, template, indicators, employees, existingIds, eligibleByCode, parsed }
}

route("kpi.targets.bulkPreview", {
  perm: ["kpi", "assign"],
  schema: bulkTargetConfig.extend({ base64: z.string().min(10) }),
  handler: async (ctx, p) => {
    const { parsed } = await parseBulkTargetFile(ctx, p)
    return {
      rows: parsed.rows,
      summary: parsed.summary,
      missingHeaders: parsed.missingHeaders,
    }
  },
})

route("kpi.targets.bulkSubmit", {
  perm: ["kpi", "assign"],
  mutating: true,
  schema: bulkTargetConfig.extend({ base64: z.string().min(10), onlyValid: z.boolean().nullish() }),
  handler: async (ctx, p) => {
    // re-validate server-side — the preview result is NEVER trusted as a
    // write authorization
    const { dept, template, indicators, eligibleByCode, parsed } = await parseBulkTargetFile(ctx, p)
    const ready = parsed.rows.filter((r) => r.status === "READY")
    if (!ready.length) throw new Deny("No valid rows in the upload — fix the reported errors and upload again", 400)
    const batch = await db.kpiBatch.create({
      data: {
        vendorId: ctx.vendorId,
        companyId: dept.companyId,
        kind: "TARGET",
        templateId: template.id,
        departmentId: dept.id,
        periodLabel: p.periodLabel,
        dueDate: p.dueDate || null,
        totalEmployees: parsed.summary.total,
        validCount: parsed.summary.valid,
        invalidCount: parsed.summary.invalid + parsed.summary.skipped,
        status: "PENDING_APPROVAL",
        createdBy: ctx.userId,
      },
    })
    let created = 0
    for (const row of ready) {
      const emp = eligibleByCode.get(row.employeeCode)
      if (!emp) continue
      try {
        await createTargetAssignment({
          vendorId: ctx.vendorId,
          employeeId: emp.id,
          templateId: template.id,
          periodLabel: p.periodLabel,
          dueDate: p.dueDate || null,
          remarks: p.remarks || row.remarks || null,
          createdBy: ctx.userId,
          batchId: batch.id,
          companyId: dept.companyId,
          indicators: indicators.map((i) => ({
            indicatorId: i.id,
            name: i.name,
            builtinKey: i.builtinKey,
            unit: i.unit as any,
            unitLabel: i.unitLabel,
            direction: i.direction as any,
            weight: i.weight,
            targetValue: row.values[i.id] ?? i.defaultTarget ?? null,
          })),
          submit: true,
        })
        created++
      } catch (e: any) {
        // per-employee failure must not sink the batch — recorded as an ERROR row
        const failedRow = parsed.rows.find((r) => r.rowNo === row.rowNo)
        if (failedRow) {
          failedRow.status = "ERROR"
          failedRow.error = e?.message || "Creation failed"
        }
      }
    }
    await db.kpiBatch.updateMany({ where: { id: batch.id, vendorId: ctx.vendorId }, data: { validCount: created } })
    await recordKpiAction(ctx.vendorId, { entityType: "KPI_BATCH", entityId: batch.id, batchId: batch.id, action: "SUBMIT", comment: `bulk target import — ${created} employee(s)` }, ctx)
    await audit(ctx, "kpi.targets.bulkSubmit", "KpiBatch", batch.id,
      `Bulk KPI target import for ${dept.name} · ${p.periodLabel}: ${created} created, ${parsed.summary.invalid} invalid, ${parsed.summary.skipped} skipped`,
      { newValue: { batchId: batch.id, created, invalid: parsed.summary.invalid, skipped: parsed.summary.skipped } })
    if (created) {
      const { notify } = await import("../audit")
      await notify(ctx.vendorId, { role: "HR_ADMIN" }, "Bulk KPI Targets Submitted",
        `${created} KPI target(s) for ${dept.name} (${p.periodLabel}) are waiting for approval.`, "SYSTEM", "performance")
    }
    return { batchId: batch.id, created, invalid: parsed.summary.invalid, skipped: parsed.summary.skipped, rows: parsed.rows }
  },
})

// ---------------------------------------------------------------------------
// TARGETS — batches (bulk review + decide)
// ---------------------------------------------------------------------------

route("kpi.targets.batches", {
  perm: ["kpi", "view"],
  schema: z.object({ status: optFilter(30), periodLabel: optPeriod(), ...paginationSchema }).strict().partial().optional(),
  handler: async (ctx, p) => {
    const where: any = companyWhere(ctx, { kind: "TARGET" })
    if (p?.status) where.status = p.status
    if (p?.periodLabel) where.periodLabel = p.periodLabel
    const { pageSize, page, skip, take } = pageParams(p)
    const [list, total] = await Promise.all([
      db.kpiBatch.findMany({ where, orderBy: { createdAt: "desc" }, skip, take }),
      db.kpiBatch.count({ where }),
    ])
    const { deptById, userById } = await orgNames(ctx.vendorId)
    return {
      items: list.map((b) => ({
        ...b,
        departmentName: b.departmentId ? deptById.get(b.departmentId)?.name || null : null,
        createdByName: b.createdBy ? userById.get(b.createdBy) || null : null,
        decidedByName: b.decidedBy ? userById.get(b.decidedBy) || null : null,
      })),
      total, page, pageSize,
    }
  },
})

route("kpi.targets.batchGet", {
  perm: ["kpi", "view"],
  schema: z.object({ id: z.string().trim().min(1).max(40) }).strict(),
  handler: async (ctx, p) => {
    const batch = await db.kpiBatch.findFirst({ where: { id: p.id, vendorId: ctx.vendorId, kind: "TARGET" } })
    if (!batch) throw new Deny("Batch not found", 404)
    const freshStatus = await refreshBatchStatus(ctx.vendorId, batch.id)
    batch.status = freshStatus
    const members = await db.kpiAssignment.findMany({
      where: { vendorId: ctx.vendorId, batchId: batch.id },
      orderBy: { createdAt: "asc" },
    })
    const empIds = [...new Set(members.map((m) => m.employeeId))]
    const [employees, inds, { deptById, desigById, userById }] = await Promise.all([
      empIds.length ? db.employee.findMany({ where: { vendorId: ctx.vendorId, id: { in: empIds } }, select: { id: true, code: true, fullName: true, departmentId: true, designationId: true } }) : [],
      db.kpiAssignmentIndicator.findMany({ where: { assignmentId: { in: members.map((m) => m.id) } }, orderBy: { sortOrder: "asc" } }),
      orgNames(ctx.vendorId),
    ])
    const empById = new Map(employees.map((e) => [e.id, e]))
    const indsByAssignment = new Map<string, typeof inds>()
    for (const i of inds) pushTo(indsByAssignment, i.assignmentId, i)
    return {
      batch: { ...batch, departmentName: batch.departmentId ? deptById.get(batch.departmentId)?.name || null : null, createdByName: batch.createdBy ? userById.get(batch.createdBy) || null : null },
      employees: members.map((m) => {
        const e = empById.get(m.employeeId)
        return {
          assignmentId: m.id,
          employeeId: m.employeeId,
          employeeCode: e?.code || "—",
          employeeName: e?.fullName || "—",
          designationName: e?.designationId ? desigById.get(e.designationId) || null : null,
          status: m.status,
          totalScore: m.totalScore,
          dueDate: m.dueDate,
          remarks: m.remarks,
          indicators: indsByAssignment.get(m.id) || [],
          results: j(m.resultsJson, []),
        }
      }),
      history: await kpiActionHistory(ctx.vendorId, "KPI_BATCH", batch.id),
    }
  },
})

route("kpi.targets.batchDecide", {
  perm: ["kpi", "approve"],
  mutating: true,
  schema: z.object({
    id: z.string().trim().min(1).max(40),
    decision: z.enum(["APPROVE", "REJECT", "REQUEST_CHANGES"]),
    ids: z.array(z.string().trim().min(1).max(40)).max(KPI_IMPORT_MAX_ROWS).nullish(), // selected assignment ids; all pending when omitted
    comment: z.string().trim().max(1000).nullish(),
  }).strict(),
  handler: async (ctx, p) => {
    const batch = await db.kpiBatch.findFirst({ where: { id: p.id, vendorId: ctx.vendorId, kind: "TARGET" } })
    if (!batch) throw new Deny("Batch not found", 404)
    if ((p.decision === "REJECT" || p.decision === "REQUEST_CHANGES") && !p.comment?.trim()) {
      throw new Deny(`${p.decision === "REJECT" ? "Rejection" : "Change request"} requires a reason`, 400)
    }
    const members = await db.kpiAssignment.findMany({
      where: { vendorId: ctx.vendorId, batchId: batch.id, status: "PENDING_APPROVAL", ...(p.ids?.length ? { id: { in: p.ids } } : {}) },
    })
    if (!members.length) throw new Deny("No pending targets match this selection", 409)
    let approved = 0
    let rejected = 0
    const skipped: { employeeId: string; reason: string }[] = []
    for (const m of members) {
      try {
        await decideTarget(ctx, m.id, p.decision, p.comment || undefined)
        if (p.decision === "APPROVE") approved++
        else rejected++
      } catch (e: any) {
        skipped.push({ employeeId: m.employeeId, reason: e?.message || "decision failed" })
      }
    }
    const status = await refreshBatchStatus(ctx.vendorId, batch.id)
    await recordKpiAction(ctx.vendorId, {
      entityType: "KPI_BATCH", entityId: batch.id, batchId: batch.id,
      action: p.decision === "APPROVE" ? "APPROVE" : p.decision === "REJECT" ? "REJECT" : "REQUEST_CHANGES",
      comment: `${p.ids?.length ? `selected (${p.ids.length})` : "all pending"} — approved ${approved}, decided ${rejected}, skipped ${skipped.length}${p.comment ? ` — ${p.comment}` : ""}`,
    }, ctx)
    return { approved, decided: approved + rejected, skipped, batchStatus: status }
  },
})

// ---------------------------------------------------------------------------
// TARGETS — export
// ---------------------------------------------------------------------------

route("kpi.targets.export", {
  perm: ["kpi", "export"],
  schema: z.object({
    format: z.enum(["xlsx", "csv"]),
    departmentId: optFilter(),
    periodLabel: optPeriod(),
    status: optFilter(30),
  }).strict(),
  handler: async (ctx, p) => {
    // reuse the list route's filter assembly by calling its handler internals
    const listHandler = (await import("./registry")).getRoute("kpi.targets.list")
    if (!listHandler) throw new Deny("List route unavailable", 500)
    const data: any = await listHandler.handler(ctx, { departmentId: p.departmentId, periodLabel: p.periodLabel, status: p.status, page: 1, pageSize: 500 })
    let rows = data.items || []
    let total = data.total || rows.length
    // page through the rest (bounded at 10k rows to stay interactive)
    while (rows.length < total && rows.length < 10000) {
      const next: any = await listHandler.handler(ctx, { departmentId: p.departmentId, periodLabel: p.periodLabel, status: p.status, page: Math.ceil(rows.length / (data.pageSize || 50)) + 1, pageSize: data.pageSize || 50 })
      rows = rows.concat(next.items || [])
      total = next.total
    }
    const settings = await kpiSettings(ctx.vendorId, ctx.activeCompanyId)
    const rowsForExport = rows.map((r: any) => ({
      ...r,
      ratingLabel: ratingFor(r.totalScore, settings.ratings)?.label || "",
    }))
    const indicatorNames = [...new Set(rowsForExport.flatMap((r: any) => (r.indicators || []).map((i: any) => String(i.name))))] as string[]
    await audit(ctx, "kpi.targets.export", "KpiAssignment", null, `Exported ${rowsForExport.length} KPI target assignment(s) as ${p.format.toUpperCase()}`)
    if (p.format === "csv") {
      const header = ["Employee ID", "Employee", "Department", "Period", "Due Date", "Status", "Score", "Rating", ...indicatorNames, "Remarks"]
      const esc = (v: unknown) => { const s = String(v ?? ""); return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s }
      const lines = ["\uFEFF" + header.join(",")]
      for (const r of rowsForExport) {
        const byName = new Map((r.indicators || []).map((i: any) => [i.name, i.targetValue]))
        lines.push([
          r.employeeCode, r.employeeName, r.departmentName || "", r.periodLabel, r.dueDate || "", r.status,
          r.totalScore ?? "", r.ratingLabel, ...indicatorNames.map((n) => byName.get(n) ?? ""), r.remarks || "",
        ].map((c) => `"${esc(c).replace(/"/g, '""')}"`).join(","))
      }
      return { format: "csv", filename: `kpi-targets-${new Date().toISOString().slice(0, 10)}.csv`, csv: lines.join("\n") }
    }
    const buf = generateTargetsExport(rowsForExport, indicatorNames)
    return {
      format: "xlsx",
      filename: `kpi-targets-${new Date().toISOString().slice(0, 10)}.xlsx`,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      base64: buf.toString("base64"),
    }
  },
})

// ---------------------------------------------------------------------------
// ACHIEVEMENTS — summary
// ---------------------------------------------------------------------------

route("kpi.achievements.summary", {
  perm: ["kpi", "view"],
  schema: z.object({ departmentId: optFilter(), periodLabel: optPeriod() }).strict().partial().optional(),
  handler: async (ctx, p) => {
    if (!p?.periodLabel) return { periodLabel: null, eligible: 0, uploaded: 0, notUploaded: 0, pendingApproval: 0, approved: 0, rejected: 0, unitTotals: {} }
    const empWhere = eligibleEmployeeWhere(ctx, { departmentId: p.departmentId || null })
    const scopedIds = (await db.employee.findMany({ where: empWhere, select: { id: true } })).map((e) => e.id)
    const approvedTargets = await db.kpiAssignment.findMany({
      where: { vendorId: ctx.vendorId, periodLabel: p.periodLabel, status: "APPROVED", employeeId: { in: scopedIds } },
      select: { id: true, employeeId: true },
    })
    const assignmentIds = approvedTargets.map((a) => a.id)
    const achievements = assignmentIds.length
      ? await db.kpiAchievement.findMany({ where: { vendorId: ctx.vendorId, assignmentId: { in: assignmentIds } } })
      : []
    const eligibleEmployees = new Set(approvedTargets.map((a) => a.employeeId))
    // employee-wise aggregate status
    const byAssignment = new Map<string, Set<string>>()
    for (const a of achievements) {
      if (!byAssignment.has(a.assignmentId)) byAssignment.set(a.assignmentId, new Set())
      const set = byAssignment.get(a.assignmentId)
      if (set) set.add(a.status)
    }
    let uploaded = 0, pending = 0, approved = 0, rejected = 0
    for (const t of approvedTargets) {
      const statuses = byAssignment.get(t.id)
      if (!statuses || !statuses.size) continue
      uploaded++
      if (statuses.has("PENDING_APPROVAL")) pending++
      else if (statuses.has("CHANGES_REQUESTED")) rejected++ // returned — needs rework
      else if (statuses.has("REJECTED")) rejected++
      else if (statuses.has("APPROVED")) approved++
    }
    // unit-aware totals — never merge incompatible measurement units
    const settings = await kpiSettings(ctx.vendorId, ctx.activeCompanyId)
    const opts = scoringOptions(settings)
    const unitTotals: Record<string, { unit: string; label: string; target: number; achieved: number; count: number; approvedOnly: boolean }> = {}
    for (const a of achievements) {
      if (a.status !== "APPROVED") continue
      const key = a.unit === "CUSTOM" ? `CUSTOM:${a.indicatorName}` : a.unit
      if (!unitTotals[key]) unitTotals[key] = { unit: a.unit, label: a.unit, target: 0, achieved: 0, count: 0, approvedOnly: true }
      unitTotals[key].count++
      unitTotals[key].target += Number(a.targetValue) || 0
      unitTotals[key].achieved += Number(a.actualValue) || 0
      void opts
    }
    return {
      periodLabel: p.periodLabel,
      periodDisplay: formatPeriodLabel(p.periodLabel),
      totalEligible: eligibleEmployees.size,
      uploaded,
      notUploaded: Math.max(0, eligibleEmployees.size - uploaded),
      pendingApproval: pending,
      approved,
      rejected,
      unitTotals,
    }
  },
})

// ---------------------------------------------------------------------------
// ACHIEVEMENTS — list + get
// ---------------------------------------------------------------------------

route("kpi.achievements.list", {
  perm: ["kpi", "view"],
  schema: z.object({
    q: z.string().trim().max(80).nullish(),
    departmentId: optFilter(),
    employeeId: optFilter(),
    periodLabel: optPeriod(),
    status: optFilter(30), // PENDING_APPROVAL | APPROVED | REJECTED | CHANGES_REQUESTED | NOT_UPLOADED
    ...paginationSchema,
  }).strict().partial().optional(),
  handler: async (ctx, p) => {
    const scope = employeeScopeFilter(ctx)
    const scopedIds = new Set((await db.employee.findMany({ where: scope, select: { id: true } })).map((e) => e.id))
    const where: any = { vendorId: ctx.vendorId, status: "APPROVED" } // targets must be approved
    if (p?.periodLabel) where.periodLabel = p.periodLabel
    let employeeFilter: string[] | null = null
    if (p?.departmentId) {
      employeeFilter = (await db.employee.findMany({ where: { vendorId: ctx.vendorId, departmentId: p.departmentId }, select: { id: true } })).map((e) => e.id)
    }
    if (p?.employeeId) {
      // narrows the department/q filter (and the caller's scope) to one employee
      employeeFilter = employeeFilter ? employeeFilter.filter((id) => id === p.employeeId) : [p.employeeId]
    }
    if (p?.q) {
      const matches = (await db.employee.findMany({
        where: { vendorId: ctx.vendorId, OR: [{ fullName: { contains: p.q, mode: "insensitive" } }, { code: { contains: p.q, mode: "insensitive" } }] },
        select: { id: true },
      })).map((e) => e.id)
      employeeFilter = employeeFilter ? employeeFilter.filter((id) => matches.includes(id)) : matches
    }
    const visible = employeeFilter ? employeeFilter.filter((id) => scopedIds.has(id)) : [...scopedIds]
    where.employeeId = { in: visible }
    // achievement-status filter → pre-resolve matching assignment ids
    if (p?.status && p.status !== "NOT_UPLOADED") {
      const distinct = await db.kpiAchievement.groupBy({
        by: ["assignmentId"],
        where: { vendorId: ctx.vendorId, status: p.status, employeeId: { in: visible } },
      })
      where.id = { in: distinct.map((d) => d.assignmentId) }
    } else if (p?.status === "NOT_UPLOADED") {
      const withAny = await db.kpiAchievement.groupBy({ by: ["assignmentId"], where: { vendorId: ctx.vendorId, employeeId: { in: visible } } })
      const exclude = new Set(withAny.map((d) => d.assignmentId))
      const all = await db.kpiAssignment.findMany({ where, select: { id: true } })
      where.id = { in: all.map((a) => a.id).filter((id) => !exclude.has(id)) }
    }
    const { pageSize, page, skip, take } = pageParams(p)
    const [list, total] = await Promise.all([
      db.kpiAssignment.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip, take }),
      db.kpiAssignment.count({ where }),
    ])
    const pageIds = list.map((a) => a.id)
    const [employees, achievements, { deptById, desigById }] = await Promise.all([
      db.employee.findMany({ where: { vendorId: ctx.vendorId, id: { in: [...new Set(list.map((a) => a.employeeId))] } }, select: { id: true, code: true, fullName: true, departmentId: true, designationId: true } }),
      pageIds.length ? db.kpiAchievement.findMany({ where: { vendorId: ctx.vendorId, assignmentId: { in: pageIds } } }) : [],
      orgNames(ctx.vendorId),
    ])
    const empById = new Map(employees.map((e) => [e.id, e]))
    const settings = await kpiSettings(ctx.vendorId, ctx.activeCompanyId)
    const opts = scoringOptions(settings)
    const byAssignment = new Map<string, typeof achievements>()
    for (const a of achievements) pushTo(byAssignment, a.assignmentId, a)
    const items = list.map((t) => {
      const emp = empById.get(t.employeeId)
      const achs = byAssignment.get(t.id) || []
      const statuses = new Set(achs.map((a) => a.status))
      const aggStatus = !achs.length ? "NOT_UPLOADED"
        : statuses.has("PENDING_APPROVAL") ? "PENDING_APPROVAL"
        : statuses.has("CHANGES_REQUESTED") ? "CHANGES_REQUESTED"
        : statuses.has("REJECTED") ? "REJECTED"
        : statuses.has("DRAFT") ? "DRAFT"
        : statuses.has("APPROVED") ? "APPROVED" : "NOT_UPLOADED"
      // score from APPROVED achievements only
      const approvedScore = weightedScore(
        achs.filter((a) => a.status === "APPROVED").map((a) => ({ pct: a.achievementPct, weight: a.weight })),
        { ...opts, missingDataCountsZero: settings.missingDataCountsZero },
      )
      const uploaded = achs.filter((a) => a.actualValue != null).length
      return {
        assignmentId: t.id,
        employeeId: t.employeeId,
        employeeCode: emp?.code || "—",
        employeeName: emp?.fullName || "—",
        departmentName: emp?.departmentId ? deptById.get(emp.departmentId)?.name || null : null,
        designationName: emp?.designationId ? desigById.get(emp.designationId) || null : null,
        periodLabel: t.periodLabel,
        periodDisplay: formatPeriodLabel(t.periodLabel, t.periodStart, t.periodEnd),
        dueDate: t.dueDate,
        status: aggStatus,
        uploadedIndicators: uploaded,
        totalIndicators: j(t.resultsJson, []).length || achs.length,
        score: approvedScore.score,
        rating: ratingFor(approvedScore.score, settings.ratings),
        indicators: achs.map((a) => ({
          id: a.id, indicatorName: a.indicatorName, unit: a.unit, direction: a.direction,
          weight: a.weight, targetValue: a.targetValue, actualValue: a.actualValue,
          achievementPct: a.achievementPct, score: a.score, status: a.status, remarks: a.remarks,
        })),
      }
    })
    return { items, total, page, pageSize }
  },
})

route("kpi.achievements.get", {
  perm: ["kpi", "view"],
  schema: z.object({ assignmentId: z.string().trim().min(1).max(40) }).strict(),
  handler: async (ctx, p) => {
    const t = await db.kpiAssignment.findFirst({ where: { id: p.assignmentId, vendorId: ctx.vendorId } })
    if (!t) throw new Deny("KPI target assignment not found", 404)
    await assertEmployeeVisible(ctx, t.employeeId)
    const [emp, inds, achievements, history, { deptById, desigById, userById }] = await Promise.all([
      db.employee.findUnique({ where: { id: t.employeeId }, select: { id: true, code: true, fullName: true, departmentId: true, designationId: true } }),
      db.kpiAssignmentIndicator.findMany({ where: { assignmentId: t.id }, orderBy: { sortOrder: "asc" } }),
      db.kpiAchievement.findMany({ where: { assignmentId: t.id } }),
      kpiActionHistory(ctx.vendorId, "KPI_ACHIEVEMENT", t.id),
      orgNames(ctx.vendorId),
    ])
    // revision archive depends on the achievement ids — fetched after the batch
    const revisions = achievements.length
      ? await db.kpiRevision.findMany({ where: { entityType: "KPI_ACHIEVEMENT", entityId: { in: achievements.map((a) => a.id) } }, orderBy: { revision: "desc" } })
      : []
    const achByRow = new Map(achievements.map((a) => [a.indicatorRowId, a]))
    const settings = await kpiSettings(ctx.vendorId, ctx.activeCompanyId)
    return {
      assignment: {
        id: t.id, periodLabel: t.periodLabel, periodDisplay: formatPeriodLabel(t.periodLabel, t.periodStart, t.periodEnd),
        periodStart: t.periodStart, periodEnd: t.periodEnd, dueDate: t.dueDate, status: t.status, remarks: t.remarks,
        revision: t.revision, totalScore: t.totalScore, rating: t.totalScore ? ratingFor(t.totalScore, settings.ratings) : null,
        createdBy: t.createdBy, createdByName: t.createdBy ? userById.get(t.createdBy) || null : null,
      },
      employee: emp ? {
        ...emp,
        departmentName: emp.departmentId ? deptById.get(emp.departmentId)?.name || null : null,
        designationName: emp.designationId ? desigById.get(emp.designationId) || null : null,
      } : null,
      indicators: inds.map((i) => ({
        ...i,
        achievement: achByRow.get(i.id) || null,
      })),
      history,
      revisions: revisions.map((r) => ({ ...r, snapshot: j(r.snapshotJson, null), snapshotJson: undefined })),
    }
  },
})

/** Pre-computed built-in indicator values for the single-entry form. */
route("kpi.achievements.prefill", {
  perm: ["kpi", "view"],
  schema: z.object({ assignmentId: z.string().trim().min(1).max(40) }).strict(),
  handler: async (ctx, p) => {
    const t = await db.kpiAssignment.findFirst({ where: { id: p.assignmentId, vendorId: ctx.vendorId } })
    if (!t) throw new Deny("KPI target assignment not found", 404)
    await assertEmployeeVisible(ctx, t.employeeId)
    const inds = await db.kpiAssignmentIndicator.findMany({ where: { assignmentId: t.id, source: "BUILTIN", builtinKey: { not: null } } })
    if (!inds.length) return { values: [] }
    const period = resolvePeriodRange(t.periodLabel, t.periodStart, t.periodEnd)
    // an unresolvable label (legacy/custom rows with no explicit dates) has
    // no builtin prefill window — return the empty set instead of failing
    if (!period) return { values: [] }
    const out: { indicatorRowId: string; value: number | null }[] = []
    for (const i of inds) {
      if (!i.builtinKey) continue
      const map = await computeBuiltinForEmployees(i.builtinKey, ctx.vendorId, [t.employeeId], period.start, period.end)
      out.push({ indicatorRowId: i.id, value: map.get(t.employeeId) ?? null })
    }
    return { values: out }
  },
})

// ---------------------------------------------------------------------------
// ACHIEVEMENTS — update + decide
// ---------------------------------------------------------------------------

route("kpi.achievements.update", {
  perm: ["kpi", "edit"],
  mutating: true,
  schema: z.object({
    assignmentId: z.string().trim().min(1).max(40),
    values: z.array(z.object({
      indicatorRowId: z.string().trim().min(1).max(40),
      actualValue: z.number().min(0).nullish(),
      reportedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
      remarks: z.string().trim().max(500).nullish(),
      evidenceName: z.string().trim().max(200).nullish(),
    }).strict()).min(1).max(50),
    submit: z.boolean().nullish(),
  }).strict(),
  handler: async (ctx, p) => {
    const t = await db.kpiAssignment.findFirst({ where: { id: p.assignmentId, vendorId: ctx.vendorId } })
    if (!t) throw new Deny("KPI target assignment not found", 404)
    await assertEmployeeVisible(ctx, t.employeeId, { forWrite: true })
    return upsertAchievements(ctx, { assignmentId: p.assignmentId, values: p.values, submit: p.submit !== false })
  },
})

route("kpi.achievements.decide", {
  perm: ["kpi", "approve"],
  mutating: true,
  schema: z.object({
    assignmentId: z.string().trim().min(1).max(40),
    decision: z.enum(["APPROVE", "REJECT", "REQUEST_CHANGES"]),
    comment: z.string().trim().max(1000).nullish(),
  }).strict(),
  handler: async (ctx, p) => decideAchievements(ctx, p.assignmentId, p.decision, p.comment || undefined),
})

// ---------------------------------------------------------------------------
// ACHIEVEMENTS — bulk Excel
// ---------------------------------------------------------------------------

const bulkAchievementConfig = z.object({
  departmentId: z.string().trim().min(1).max(40).nullish(),
  periodLabel: periodLabelSchema,
  employmentType: z.string().trim().max(40).nullish(),
  branchId: z.string().trim().max(40).nullish(),
}).strict()

async function bulkAchievementContext(ctx: Ctx, p: z.infer<typeof bulkAchievementConfig>) {
  const empWhere = eligibleEmployeeWhere(ctx, { departmentId: p.departmentId || null, employmentType: p.employmentType, branchId: p.branchId })
  const scoped = (await db.employee.findMany({ where: empWhere, select: { id: true } })).map((e) => e.id)
  const assignments = await db.kpiAssignment.findMany({
    where: { vendorId: ctx.vendorId, periodLabel: p.periodLabel, status: "APPROVED", employeeId: { in: scoped } },
    take: KPI_IMPORT_MAX_ROWS,
    orderBy: { createdAt: "asc" },
  })
  if (!assignments.length) throw new Deny(`No approved KPI target assignments exist for ${p.periodLabel}${p.departmentId ? " in this department" : ""}`, 400)
  const assignmentIds = assignments.map((a) => a.id)
  const [inds, achievements, employees, { deptById }] = await Promise.all([
    db.kpiAssignmentIndicator.findMany({ where: { assignmentId: { in: assignmentIds } }, orderBy: { sortOrder: "asc" } }),
    db.kpiAchievement.findMany({ where: { vendorId: ctx.vendorId, assignmentId: { in: assignmentIds } } }),
    db.employee.findMany({ where: { vendorId: ctx.vendorId, id: { in: [...new Set(assignments.map((a) => a.employeeId))] } }, select: { id: true, code: true, fullName: true, departmentId: true } }),
    orgNames(ctx.vendorId),
  ])
  return { assignments, inds, achievements, employees, deptById }
}

route("kpi.achievements.bulkTemplate", {
  perm: ["kpi", "edit"],
  schema: bulkAchievementConfig,
  handler: async (ctx, p) => {
    const { assignments, inds, achievements, employees, deptById } = await bulkAchievementContext(ctx, p)
    const empById = new Map(employees.map((e) => [e.id, e]))
    void achievements // already surfaced through bulkAchievementContext's ref map
    const indsByAssignment = new Map<string, typeof inds>()
    for (const i of inds) pushTo(indsByAssignment, i.assignmentId, i)
    const company = ctx.activeCompanyId ? await db.company.findUnique({ where: { id: ctx.activeCompanyId }, select: { name: true } }) : null

    const templateRows: AchievementTemplateRow[] = []
    for (const a of assignments) {
      const emp = empById.get(a.employeeId)
      for (const i of indsByAssignment.get(a.id) || []) {
        // Exclude built-in indicators: they are taken from system data and do not need manual entry
        if (i.source === "BUILTIN" || i.builtinKey) continue
        templateRows.push({
          code: emp?.code || "—",
          fullName: emp?.fullName || "—",
          departmentName: emp?.departmentId ? deptById.get(emp.departmentId)?.name || "" : "",
          periodLabel: a.periodLabel,
          indicatorRowId: i.id,
          indicatorName: i.name,
          unit: i.unit as any,
          unitLabel: i.unitLabel,
          direction: i.direction as any,
          weight: i.weight,
          targetValue: i.targetValue,
          prefillActual: null,
          builtinKey: null,
        })
      }
    }
    const buf = generateAchievementTemplate({
      companyName: company?.name || "All Companies",
      departmentName: p.departmentId ? (deptById.get(p.departmentId)?.name || "") : "All departments",
      periodLabel: p.periodLabel,
      rows: templateRows,
    })
    await audit(ctx, "kpi.achievements.bulkTemplate", "KpiAssignment", null,
      `Downloaded the bulk achievement template for ${p.periodLabel} (${templateRows.length} row(s) from ${assignments.length} approved assignment(s))`)
    return {
      filename: `kpi-achievements-${p.periodLabel}.xlsx`,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      base64: buf.toString("base64"),
      rows: templateRows.length,
      assignments: assignments.length,
      prefilledBuiltins: 0,
    }
  },
})

route("kpi.achievements.bulkPreview", {
  perm: ["kpi", "edit"],
  schema: bulkAchievementConfig.extend({ base64: z.string().min(10) }),
  handler: async (ctx, p) => {
    const { assignments, inds, achievements, employees } = await bulkAchievementContext(ctx, p)
    const ref = buildAchievementRef(assignments, inds, achievements, employees)
    let wb: import("xlsx").WorkBook
    try { wb = readWorkbook(p.base64) } catch { throw new Deny("Could not read the file — use the template downloaded from this wizard", 400) }
    const parsed = parseAchievementUpload(wb, ref)
    return { rows: parsed.rows, summary: parsed.summary, missingHeaders: parsed.missingHeaders }
  },
})

function buildAchievementRef(assignments: any[], inds: any[], achievements: any[], employees: any[]) {
  const empById = new Map(employees.map((e) => [e.id, e]))
  const assignmentById = new Map(assignments.map((a) => [a.id, a]))
  const achByRow = new Map(achievements.map((a) => [a.indicatorRowId, a]))
  const ref = new Map<string, AchievementRefRow>()
  for (const i of inds) {
    const a = assignmentById.get(i.assignmentId)
    if (!a) continue
    const emp = empById.get(a.employeeId)
    if (!emp) continue
    const existing = achByRow.get(i.id)
    ref.set(`${emp.code}|${i.id}`, {
      code: emp.code,
      indicatorRowId: i.id,
      assignmentId: a.id,
      employeeId: a.employeeId,
      periodLabel: a.periodLabel,
      indicatorName: i.name,
      unit: i.unit as any,
      unitLabel: i.unitLabel,
      direction: i.direction as any,
      weight: i.weight,
      targetValue: i.targetValue,
      existingStatus: existing ? existing.status : null,
    })
  }
  return ref
}

route("kpi.achievements.bulkSubmit", {
  perm: ["kpi", "edit"],
  mutating: true,
  schema: bulkAchievementConfig.extend({ base64: z.string().min(10) }),
  handler: async (ctx, p) => {
    const { assignments, inds, achievements, employees, deptById } = await bulkAchievementContext(ctx, p)
    const ref = buildAchievementRef(assignments, inds, achievements, employees)
    let wb: import("xlsx").WorkBook
    try { wb = readWorkbook(p.base64) } catch { throw new Deny("Could not read the file — use the template downloaded from this wizard", 400) }
    const parsed = parseAchievementUpload(wb, ref)
    const ready = parsed.rows.filter((r) => r.status === "READY")
    if (!ready.length) throw new Deny("No valid rows in the upload — fix the reported errors and upload again", 400)
    const batch = await db.kpiBatch.create({
      data: {
        vendorId: ctx.vendorId,
        companyId: ctx.activeCompanyId || null,
        kind: "ACHIEVEMENT",
        departmentId: p.departmentId || null,
        periodLabel: p.periodLabel,
        totalEmployees: parsed.summary.total,
        validCount: parsed.summary.valid,
        invalidCount: parsed.summary.invalid + parsed.summary.skipped,
        status: "PENDING_APPROVAL",
        createdBy: ctx.userId,
      },
    })
    // group READY rows by assignment → one upsert per employee (atomic per employee)
    const byAssignment = new Map<string, typeof ready>()
    for (const r of ready) {
      const refRow = ref.get(`${r.employeeCode}|${r.indicatorRowId}`)
      if (refRow) pushTo(byAssignment, refRow.assignmentId, r)
    }

    const indsByAssignment = new Map<string, typeof inds>()
    for (const i of inds) pushTo(indsByAssignment, i.assignmentId, i)

    // live pre-computation of built-in indicators so their achievements are taken directly from system data
    const builtinKeys = [...new Set(inds.filter((i) => (i.source === "BUILTIN" || i.builtinKey) && i.builtinKey).map((i) => String(i.builtinKey)))]
    const prefillByRow = new Map<string, number | null>()
    if (builtinKeys.length && assignments.length) {
      const firstWindow = resolvePeriodRange(assignments[0].periodLabel, assignments[0].periodStart, assignments[0].periodEnd)
      if (firstWindow) {
        for (const key of builtinKeys) {
          const keyRows = inds.filter((i) => i.builtinKey === key)
          const empIds = [...new Set(keyRows.map((r) => assignments.find((a) => a.id === r.assignmentId)?.employeeId).filter((x): x is string => !!x))]
          const values = await computeBuiltinForEmployees(key, ctx.vendorId, empIds, firstWindow.start, firstWindow.end)
          for (const r of keyRows) {
            const a = assignments.find((x) => x.id === r.assignmentId)
            if (a) prefillByRow.set(r.id, values.get(a.employeeId) ?? null)
          }
        }
      }
    }

    let updated = 0
    const failed: { rowNo: number; error: string }[] = []
    for (const [assignmentId, rows] of byAssignment) {
      const assignmentInds = indsByAssignment.get(assignmentId) || []
      const manualValues = rows.map((r) => ({
        indicatorRowId: r.indicatorRowId,
        actualValue: r.actualValue,
        remarks: r.remarks || null,
      }))
      // Built-in indicators: taken automatically from system data
      const builtinValues = assignmentInds
        .filter((i) => (i.source === "BUILTIN" || i.builtinKey) && prefillByRow.has(i.id) && prefillByRow.get(i.id) != null)
        .map((i) => ({
          indicatorRowId: i.id,
          actualValue: prefillByRow.get(i.id)!,
          remarks: "Computed from system data",
        }))
      const allValues = [...manualValues, ...builtinValues]

      try {
        await upsertAchievements(ctx, {
          assignmentId,
          values: allValues,
          submit: true,
          batchId: batch.id,
        })
        updated += allValues.length
      } catch (e: any) {
        for (const r of rows) failed.push({ rowNo: r.rowNo, error: e?.message || "upsert failed" })
      }
    }
    await db.kpiBatch.updateMany({ where: { id: batch.id, vendorId: ctx.vendorId }, data: { validCount: updated } })
    await recordKpiAction(ctx.vendorId, { entityType: "KPI_BATCH", entityId: batch.id, batchId: batch.id, action: "SUBMIT", comment: `bulk achievement import — ${updated} value(s)` }, ctx)
    await audit(ctx, "kpi.achievements.bulkSubmit", "KpiBatch", batch.id,
      `Bulk achievement upload for ${p.periodLabel}: ${updated} value(s) across ${byAssignment.size} employee(s), ${parsed.summary.invalid + parsed.summary.skipped} skipped/invalid`,
      { newValue: { batchId: batch.id, updated, employees: byAssignment.size } })
    const { notify } = await import("../audit")
    await notify(ctx.vendorId, { role: "HR_ADMIN" }, "KPI Achievements Submitted",
      `Bulk achievement data for ${p.periodLabel} (${byAssignment.size} employee(s)) is waiting for approval.`, "SYSTEM", "performance")
    void deptById
    return { batchId: batch.id, updated, employees: byAssignment.size, failed, rows: parsed.rows }
  },
})

// ---------------------------------------------------------------------------
// ACHIEVEMENTS — batches + export
// ---------------------------------------------------------------------------

route("kpi.achievements.batches", {
  perm: ["kpi", "view"],
  schema: z.object({ status: optFilter(30), periodLabel: optPeriod(), ...paginationSchema }).strict().partial().optional(),
  handler: async (ctx, p) => {
    const where: any = companyWhere(ctx, { kind: "ACHIEVEMENT" })
    if (p?.status) where.status = p.status
    if (p?.periodLabel) where.periodLabel = p.periodLabel
    const { pageSize, page, skip, take } = pageParams(p)
    const [list, total] = await Promise.all([
      db.kpiBatch.findMany({ where, orderBy: { createdAt: "desc" }, skip, take }),
      db.kpiBatch.count({ where }),
    ])
    const { deptById, userById } = await orgNames(ctx.vendorId)
    return {
      items: list.map((b) => ({
        ...b,
        departmentName: b.departmentId ? deptById.get(b.departmentId)?.name || null : null,
        createdByName: b.createdBy ? userById.get(b.createdBy) || null : null,
        decidedByName: b.decidedBy ? userById.get(b.decidedBy) || null : null,
      })),
      total, page, pageSize,
    }
  },
})

route("kpi.achievements.batchGet", {
  perm: ["kpi", "view"],
  schema: z.object({ id: z.string().trim().min(1).max(40) }).strict(),
  handler: async (ctx, p) => {
    const batchRaw = await db.kpiBatch.findFirst({ where: { id: p.id, vendorId: ctx.vendorId, kind: "ACHIEVEMENT" } })
    if (!batchRaw) throw new Deny("Batch not found", 404)
    // Always recompute and persist the rollup status so the UI reflects the true state
    const freshStatus = await refreshBatchStatus(ctx.vendorId, batchRaw.id)
    // Re-fetch to get any updated decidedAt / decidedBy stamps written by refreshBatchStatus
    const batch = await db.kpiBatch.findUnique({ where: { id: batchRaw.id } }) ?? { ...batchRaw, status: freshStatus }
    const achievements = await db.kpiAchievement.findMany({ where: { vendorId: ctx.vendorId, batchId: batch.id } })
    const assignmentIds = [...new Set(achievements.map((a) => a.assignmentId))]
    // NOTE (typecheck-2026-11-09): this used to be ONE Promise.all whose
    // second leg referenced `assignments` inside its own initializer — a
    // TDZ crash at runtime whenever a batch had achievements, and the
    // circular reference typecheck flagged (TS7022/TS2448). The employee
    // ids come FROM the assignment rows, so the assignment query must
    // resolve first; orgNames rides along in the second round.
    const assignments = assignmentIds.length
      ? await db.kpiAssignment.findMany({ where: { id: { in: assignmentIds } } })
      : []
    const [employees, { deptById }] = await Promise.all([
      db.employee.findMany({ where: { vendorId: ctx.vendorId, id: { in: assignments.map((a) => a.employeeId) } }, select: { id: true, code: true, fullName: true, departmentId: true } }),
      orgNames(ctx.vendorId),
    ])
    const empById = new Map(employees.map((e) => [e.id, e]))
    const assignmentById = new Map(assignments.map((a) => [a.id, a]))
    const byEmployee = new Map<string, any[]>()
    for (const a of achievements) {
      const empId = assignmentById.get(a.assignmentId)?.employeeId
      if (!empId) continue
      pushTo(byEmployee, empId, a)
    }
    return {
      batch: { ...batch, departmentName: batch.departmentId ? deptById.get(batch.departmentId)?.name || null : null },
      employees: [...byEmployee.entries()].map(([empId, rows]) => {
        const emp = empById.get(empId)
        const assignment = assignmentById.get(rows[0].assignmentId)
        return {
          assignmentId: rows[0].assignmentId,
          employeeId: empId,
          employeeCode: emp?.code || "—",
          employeeName: emp?.fullName || "—",
          departmentName: emp?.departmentId ? deptById.get(emp.departmentId)?.name || null : null,
          status: rows.some((r) => r.status === "PENDING_APPROVAL") ? "PENDING_APPROVAL" : rows.every((r) => r.status === "APPROVED") ? "APPROVED" : rows[0].status,
          indicators: rows.map((r) => ({
            id: r.id, indicatorName: r.indicatorName, unit: r.unit, direction: r.direction, weight: r.weight,
            targetValue: r.targetValue, actualValue: r.actualValue, achievementPct: r.achievementPct, score: r.score, status: r.status, remarks: r.remarks,
          })),
          periodLabel: assignment?.periodLabel,
        }
      }),
      history: await kpiActionHistory(ctx.vendorId, "KPI_BATCH", batch.id),
    }
  },
})

route("kpi.achievements.batchDecide", {
  perm: ["kpi", "approve"],
  mutating: true,
  schema: z.object({
    id: z.string().trim().min(1).max(40),
    decision: z.enum(["APPROVE", "REJECT", "REQUEST_CHANGES"]),
    ids: z.array(z.string().trim().min(1).max(40)).max(KPI_IMPORT_MAX_ROWS).nullish(), // selected assignmentIds
    comment: z.string().trim().max(1000).nullish(),
  }).strict(),
  handler: async (ctx, p) => {
    const batch = await db.kpiBatch.findFirst({ where: { id: p.id, vendorId: ctx.vendorId, kind: "ACHIEVEMENT" } })
    if (!batch) throw new Deny("Batch not found", 404)
    if ((p.decision === "REJECT" || p.decision === "REQUEST_CHANGES") && !p.comment?.trim()) {
      throw new Deny(`${p.decision === "REJECT" ? "Rejection" : "Change request"} requires a reason`, 400)
    }
    const achievements = await db.kpiAchievement.findMany({ where: { vendorId: ctx.vendorId, batchId: batch.id, status: "PENDING_APPROVAL" } })
    let assignmentIds = [...new Set(achievements.map((a) => a.assignmentId))]
    const selectedIds = p.ids
    if (selectedIds?.length) assignmentIds = assignmentIds.filter((id) => selectedIds.includes(id))
    if (!assignmentIds.length) throw new Deny("No pending achievements match this selection", 409)
    let decided = 0
    const skipped: { assignmentId: string; reason: string }[] = []
    for (const id of assignmentIds) {
      try {
        await decideAchievements(ctx, id, p.decision, p.comment || undefined)
        decided++
      } catch (e: any) {
        skipped.push({ assignmentId: id, reason: e?.message || "decision failed" })
      }
    }
    await recordKpiAction(ctx.vendorId, {
      entityType: "KPI_BATCH", entityId: batch.id, batchId: batch.id,
      action: p.decision === "APPROVE" ? "APPROVE" : p.decision === "REJECT" ? "REJECT" : "REQUEST_CHANGES",
      comment: `${p.ids?.length ? `selected (${p.ids.length})` : "all pending"} — decided ${decided}, skipped ${skipped.length}${p.comment ? ` — ${p.comment}` : ""}`,
    }, ctx)
    // Recompute and persist the batch rollup status after all individual decisions are applied
    const batchStatus = await refreshBatchStatus(ctx.vendorId, batch.id, ctx.userId)
    return { decided, skipped, batchStatus }
  },
})

route("kpi.achievements.export", {
  perm: ["kpi", "export"],
  schema: z.object({
    format: z.enum(["xlsx", "csv"]),
    departmentId: optFilter(),
    periodLabel: optPeriod(),
    status: optFilter(30),
  }).strict(),
  handler: async (ctx, p) => {
    const listHandler = (await import("./registry")).getRoute("kpi.achievements.list")
    if (!listHandler) throw new Deny("List route unavailable", 500)
    const data: any = await listHandler.handler(ctx, { departmentId: p.departmentId, periodLabel: p.periodLabel, status: p.status, page: 1, pageSize: 500 })
    let items = data.items || []
    let total = data.total || items.length
    while (items.length < total && items.length < 10000) {
      const next: any = await listHandler.handler(ctx, { departmentId: p.departmentId, periodLabel: p.periodLabel, status: p.status, page: Math.ceil(items.length / (data.pageSize || 50)) + 1, pageSize: data.pageSize || 50 })
      items = items.concat(next.items || [])
      total = next.total
    }
    // flatten: one row per indicator
    const rows = items.flatMap((t: any) => t.indicators.map((i: any) => ({
      employeeCode: t.employeeCode, employeeName: t.employeeName, departmentName: t.departmentName,
      periodLabel: t.periodLabel, indicatorName: i.indicatorName, unit: i.unit, direction: i.direction,
      weight: i.weight, targetValue: i.targetValue, actualValue: i.actualValue,
      achievementPct: i.achievementPct, score: i.score, status: i.status, remarks: i.remarks,
    })))
    await audit(ctx, "kpi.achievements.export", "KpiAchievement", null, `Exported ${rows.length} achievement record(s) as ${p.format.toUpperCase()}`)
    if (p.format === "csv") {
      const header = ["Employee ID", "Employee", "Department", "Period", "Indicator", "Unit", "Direction", "Weight %", "Target", "Actual", "Achievement %", "Score", "Status", "Remarks"]
      const esc = (v: unknown) => { const s = String(v ?? ""); return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s }
      const lines = ["\uFEFF" + header.join(",")]
      for (const r of rows) {
        lines.push([
          r.employeeCode, r.employeeName, r.departmentName || "", r.periodLabel, r.indicatorName, r.unit, r.direction,
          r.weight, r.targetValue ?? "", r.actualValue ?? "", r.achievementPct ?? "", r.score ?? "", r.status, r.remarks || "",
        ].map((c) => `"${esc(c).replace(/"/g, '""')}"`).join(","))
      }
      return { format: "csv", filename: `kpi-achievements-${new Date().toISOString().slice(0, 10)}.csv`, csv: lines.join("\n") }
    }
    const buf = generateAchievementsExport(rows)
    return {
      format: "xlsx",
      filename: `kpi-achievements-${new Date().toISOString().slice(0, 10)}.xlsx`,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      base64: buf.toString("base64"),
    }
  },
})

// NOTE — the analytics routes live in ./kpi-analytics (kpi.analytics.*); the
// templates/targets/achievements families above are this file's scope.
