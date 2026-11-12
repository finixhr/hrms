// ============ KPI service layer (2026-11 redesign) ============
// Shared business logic for the KPI routes: assignment creation with indicator
// snapshots, the approval state machine (SoD-guarded, conditional check-and-set
// updates), revision archiving, the legacy resultsJson mirror and dashboard
// summaries. Routes stay thin: scope checks → zod → service call.
import { db } from "@/lib/db"
import { Deny } from "../rbac"
import { audit, notify } from "../audit"
import { getSettings } from "../settings"
import type { Ctx } from "../types"
import {
  achievementPct, indicatorScore, ratingFor, resolvePeriodRange, scoringOptions, weightedScore,
} from "./scoring"
import {
  DEFAULT_KPI_PERFORMANCE_SETTINGS, KPI_STATUSES, type KpiDirection, type KpiPerformanceSettings, type KpiStatus, type KpiUnit,
} from "./constants"

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Tenant KPI settings (company-aware: company overrides layer on top of the
 * tenant tree for the overridable `performance` group), defensively merged
 * over the defaults. */
export function normalizeKpiSettings(raw: unknown): KpiPerformanceSettings {
  const r = (raw || {}) as Partial<KpiPerformanceSettings>
  const ratings = Array.isArray(r.ratings)
    ? r.ratings
        .filter((b) => b && Number.isFinite(Number(b.min)) && typeof b.label === "string" && b.label.trim())
        .map((b) => ({ min: Number(b.min), label: String(b.label).trim() }))
        .sort((a, b) => b.min - a.min)
    : []
  return {
    achievementMaxPct: Math.max(100, Number(r.achievementMaxPct) || DEFAULT_KPI_PERFORMANCE_SETTINGS.achievementMaxPct),
    exactTolerancePct: Math.min(100, Math.max(0, Number(r.exactTolerancePct ?? DEFAULT_KPI_PERFORMANCE_SETTINGS.exactTolerancePct))),
    missingDataCountsZero: !!r.missingDataCountsZero,
    selfApprovalAllowed: !!r.selfApprovalAllowed,
    scoreDecimals: Math.min(3, Math.max(0, Math.round(Number(r.scoreDecimals ?? DEFAULT_KPI_PERFORMANCE_SETTINGS.scoreDecimals)))) as KpiPerformanceSettings["scoreDecimals"],
    ratings: ratings.length >= 2 ? ratings : DEFAULT_KPI_PERFORMANCE_SETTINGS.ratings,
  }
}

export async function kpiSettings(vendorId: string, companyId?: string | null): Promise<KpiPerformanceSettings> {
  const settings = await getSettings(vendorId, { companyId: companyId || undefined })
  return normalizeKpiSettings((settings as any).performance)
}

// ---------------------------------------------------------------------------
// Approval history + SoD
// ---------------------------------------------------------------------------

export async function recordKpiAction(
  vendorId: string,
  rec: { entityType: "KPI_TARGET" | "KPI_ACHIEVEMENT" | "KPI_BATCH"; entityId: string; batchId?: string | null; employeeId?: string | null; action: "SUBMIT" | "APPROVE" | "REJECT" | "REQUEST_CHANGES" | "CANCEL" | "REVISE"; comment?: string },
  ctx: Ctx | null,
): Promise<void> {
  await db.kpiApprovalAction.create({
    data: {
      vendorId,
      entityType: rec.entityType,
      entityId: rec.entityId,
      batchId: rec.batchId ?? null,
      employeeId: rec.employeeId ?? null,
      action: rec.action,
      comment: rec.comment || null,
      actorId: ctx?.userId ?? null,
      actorName: ctx?.userName ?? null,
    },
  })
}

export async function kpiActionHistory(vendorId: string, entityType: string, entityId: string) {
  return db.kpiApprovalAction.findMany({
    where: { vendorId, entityType, entityId },
    orderBy: { createdAt: "asc" },
  })
}

/** SoD — the creator cannot approve their own submission unless the tenant
 * lifted the rule (settings.performance.selfApprovalAllowed). */
export function assertNotSelfApproval(ctx: Ctx, createdBy: string | null | undefined, settings: KpiPerformanceSettings, what: string): void {
  if (settings.selfApprovalAllowed) return
  if (createdBy && createdBy === ctx.userId) {
    throw new Deny(`Separation of duties — you submitted this ${what} and cannot approve your own submission (configurable under Settings → Performance).`, 403)
  }
}

// ---------------------------------------------------------------------------
// Target assignment creation (single + shared by bulk)
// ---------------------------------------------------------------------------

export type IndicatorInput = {
  /** template indicator id (assignment snapshot copied from it) */
  indicatorId?: string | null
  /** employee-specific custom indicator (no template row) */
  name?: string | null
  description?: string | null
  builtinKey?: string | null
  unit: KpiUnit
  unitLabel?: string | null
  direction: KpiDirection
  weight: number
  targetValue?: number | null
  sortOrder?: number
}

export type CreateTargetInput = {
  vendorId: string
  employeeId: string
  templateId?: string | null
  periodLabel: string
  dueDate?: string | null
  periodStart?: string | null
  periodEnd?: string | null
  remarks?: string | null
  createdBy: string
  batchId?: string | null
  companyId?: string | null
  indicators: IndicatorInput[]
  /** false = save as DRAFT (editable before submission) */
  submit?: boolean
  employeeName?: string
}

/** Weight validation: Σweight must equal 100 (≥1 indicator). */
export function validateIndicatorWeights(indicators: { weight: number }[]): void {
  if (!indicators.length) throw new Deny("Add at least one KPI indicator", 400)
  const total = indicators.reduce((s, i) => s + (Number(i.weight) || 0), 0)
  if (Math.round(total * 100) !== 10000) {
    throw new Deny(`Indicator weights must total exactly 100% — currently ${Math.round(total * 100) / 100}%`, 400)
  }
  for (const i of indicators) {
    if (Number(i.weight) < 0) throw new Deny("Indicator weights cannot be negative", 400)
  }
}

/** Duplicate-period guard: one target assignment per (vendor, employee, period). */
export async function assertNoExistingAssignment(vendorId: string, employeeId: string, periodLabel: string, exceptId?: string): Promise<void> {
  const existing = await db.kpiAssignment.findFirst({
    where: { vendorId, employeeId, periodLabel, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true, status: true },
  })
  if (existing) {
    throw new Deny(
      existing.status === "CANCELLED"
        ? `A cancelled KPI target already exists for this employee and period — reactivate it instead of creating a duplicate`
        : `This employee already has a KPI target for ${periodLabel} (${existing.status.replace(/_/g, " ").toLowerCase()})`,
      409,
    )
  }
}

export async function createTargetAssignment(input: CreateTargetInput) {
  validateIndicatorWeights(input.indicators)
  await assertNoExistingAssignment(input.vendorId, input.employeeId, input.periodLabel)
  const period = resolvePeriodRange(input.periodLabel, input.periodStart, input.periodEnd)
  const submit = input.submit !== false
  const created = await db.kpiAssignment.create({
    data: {
      vendorId: input.vendorId,
      employeeId: input.employeeId,
      templateId: input.templateId ?? null,
      periodLabel: input.periodLabel,
      periodStart: period?.start ?? null,
      periodEnd: period?.end ?? null,
      dueDate: input.dueDate ?? null,
      remarks: input.remarks ?? null,
      batchId: input.batchId ?? null,
      createdBy: input.createdBy,
      status: submit ? "PENDING_APPROVAL" : "DRAFT",
      submittedAt: submit ? new Date() : null,
    },
  })
  await db.kpiAssignmentIndicator.createMany({
    data: input.indicators.map((i, idx) => ({
      vendorId: input.vendorId,
      assignmentId: created.id,
      indicatorId: i.indicatorId ?? null,
      name: (i.name || "Indicator").trim(),
      source: i.builtinKey ? "BUILTIN" : "CUSTOM",
      builtinKey: i.builtinKey ?? null,
      unit: i.unit,
      unitLabel: i.unitLabel ?? null,
      direction: i.direction,
      weight: Number(i.weight) || 0,
      targetValue: i.targetValue == null || i.targetValue === (undefined as any) ? null : Number(i.targetValue),
      sortOrder: i.sortOrder ?? idx + 1,
    })),
  })
  await syncAssignmentMirror(created.id, input.companyId ?? null)
  return db.kpiAssignment.findUnique({ where: { id: created.id } })
}

// ---------------------------------------------------------------------------
// Legacy mirror — keeps resultsJson / totalScore / rating coherent for the
// pre-redesign routes (kpiAssignments.list, ESS, reports, mobile).
// ---------------------------------------------------------------------------

export async function syncAssignmentMirror(assignmentId: string, companyId?: string | null): Promise<{ totalScore: number; rating: number }> {
  const [assignment, rows, achievements] = await Promise.all([
    db.kpiAssignment.findUnique({ where: { id: assignmentId } }),
    db.kpiAssignmentIndicator.findMany({ where: { assignmentId }, orderBy: { sortOrder: "asc" } }),
    db.kpiAchievement.findMany({ where: { assignmentId } }),
  ])
  if (!assignment) return { totalScore: 0, rating: 0 }
  const settings = await kpiSettings(assignment.vendorId, companyId)
  const opts = scoringOptions(settings)
  const achByRow = new Map(achievements.map((a) => [a.indicatorRowId, a]))
  const mirrorItems: any[] = []
  const approvedItems: { pct: number | null; weight: number }[] = []
  for (const r of rows) {
    const a = achByRow.get(r.id)
    const pct = a?.actualValue != null
      ? achievementPct({ direction: r.direction as KpiDirection, target: r.targetValue, actual: a.actualValue }, opts)
      : null
    const score = indicatorScore(pct, r.weight)
    mirrorItems.push({
      name: r.name,
      target: r.targetValue,
      unit: r.unitLabel || r.unit,
      weight: r.weight,
      actual: a?.actualValue ?? null,
      achievementPct: pct,
      score,
    })
    if (a?.status === "APPROVED") approvedItems.push({ pct, weight: r.weight })
  }
  // Final performance scores are computed from APPROVED achievements ONLY.
  const w = weightedScore(approvedItems, { ...opts, missingDataCountsZero: settings.missingDataCountsZero })
  const rating = ratingFor(w.score, settings.ratings)
  await db.kpiAssignment.update({
    where: { id: assignmentId },
    data: {
      resultsJson: JSON.stringify(mirrorItems),
      totalScore: w.score ?? 0,
      rating: rating?.stars ?? 0,
      scoreBasisJson: w.basis ? JSON.stringify({ totalWeight: w.basis.totalWeight, countedWeight: w.basis.countedWeight, achievementMaxPct: opts.achievementMaxPct, approvedOnly: true }) : null,
    },
  })
  return { totalScore: w.score ?? 0, rating: rating?.stars ?? 0 }
}

// ---------------------------------------------------------------------------
// Revision archive — an APPROVED record that is edited keeps its previous
// approved state immutable in KpiRevision before rolling back to approval.
// ---------------------------------------------------------------------------

async function archiveTargetRevision(assignmentId: string, changedBy: string, summary: string): Promise<number> {
  const [assignment, rows] = await Promise.all([
    db.kpiAssignment.findUnique({ where: { id: assignmentId } }),
    db.kpiAssignmentIndicator.findMany({ where: { assignmentId }, orderBy: { sortOrder: "asc" } }),
  ])
  if (!assignment) throw new Deny("Assignment not found", 404)
  await db.kpiRevision.create({
    data: {
      vendorId: assignment.vendorId,
      entityType: "KPI_TARGET",
      entityId: assignmentId,
      revision: assignment.revision,
      snapshotJson: JSON.stringify({
        assignment: {
          dueDate: assignment.dueDate, remarks: assignment.remarks, status: assignment.status,
          periodStart: assignment.periodStart, periodEnd: assignment.periodEnd, revision: assignment.revision,
        },
        indicators: rows.map((r) => ({
          indicatorId: r.indicatorId, name: r.name, unit: r.unit, unitLabel: r.unitLabel,
          direction: r.direction, weight: r.weight, targetValue: r.targetValue, sortOrder: r.sortOrder,
        })),
      }),
      changeSummary: summary,
      changedBy,
    },
  })
  return assignment.revision
}

async function archiveAchievementRevisions(assignmentId: string, changedBy: string, summary: string): Promise<string[]> {
  const rows = await db.kpiAchievement.findMany({ where: { assignmentId, status: "APPROVED" } })
  const archived: string[] = []
  for (const row of rows) {
    await db.kpiRevision.create({
      data: {
        vendorId: row.vendorId,
        entityType: "KPI_ACHIEVEMENT",
        entityId: row.id,
        revision: row.revision,
        snapshotJson: JSON.stringify({
          actualValue: row.actualValue, achievementPct: row.achievementPct, score: row.score,
          reportedDate: row.reportedDate, remarks: row.remarks, status: row.status,
        }),
        changeSummary: summary,
        changedBy,
      },
    })
    archived.push(row.id)
  }
  return archived
}

// ---------------------------------------------------------------------------
// Target decisions (single-assignment state machine)
// ---------------------------------------------------------------------------

export type TargetDecision = "APPROVE" | "REJECT" | "REQUEST_CHANGES"

export async function decideTarget(
  ctx: Ctx,
  assignmentId: string,
  decision: TargetDecision,
  comment?: string,
): Promise<{ status: KpiStatus }> {
  const rec = await db.kpiAssignment.findFirst({ where: { id: assignmentId, vendorId: ctx.vendorId } })
  if (!rec) throw new Deny("KPI target assignment not found", 404)
  const settings = await kpiSettings(ctx.vendorId, ctx.activeCompanyId)
  if (decision !== "APPROVE" || rec.status !== "APPROVED") {
    assertNotSelfApproval(ctx, rec.createdBy, settings, "KPI target")
  }
  const newStatus: KpiStatus = decision === "APPROVE" ? "APPROVED" : decision === "REJECT" ? "REJECTED" : "CHANGES_REQUESTED"
  if ((decision === "REJECT" || decision === "REQUEST_CHANGES") && !comment?.trim()) {
    throw new Deny(`${decision === "REJECT" ? "Rejection" : "Change request"} requires a reason`, 400)
  }
  if (rec.status !== "PENDING_APPROVAL" && !(decision === "APPROVE" && rec.status === "CHANGES_REQUESTED")) {
    throw new Deny(`Only targets pending approval can be decided — this one is ${rec.status.replace(/_/g, " ").toLowerCase()}`, 409)
  }
  // M-1-style conditional check-and-set: two concurrent approvers cannot
  // double-decide the same assignment.
  const res = await db.kpiAssignment.updateMany({
    where: { id: assignmentId, vendorId: ctx.vendorId, status: rec.status },
    data: { status: newStatus, decidedBy: ctx.userId, decidedAt: new Date() },
  })
  if (res.count === 0) throw new Deny("This target was just updated by another user — reload and retry", 409)
  await recordKpiAction(ctx.vendorId, {
    entityType: "KPI_TARGET", entityId: assignmentId, employeeId: rec.employeeId, batchId: rec.batchId,
    action: decision === "APPROVE" ? "APPROVE" : decision === "REJECT" ? "REJECT" : "REQUEST_CHANGES",
    comment,
  }, ctx)
  const emp = await db.employee.findUnique({ where: { id: rec.employeeId }, select: { fullName: true } })
  const action = decision === "APPROVE" ? "approved" : decision === "REJECT" ? "rejected" : "returned with change requests"
  await audit(ctx, `kpi.targets.${decision.toLowerCase()}`, "KpiAssignment", assignmentId,
    `KPI target for ${emp?.fullName || "employee"} (${rec.periodLabel}) ${action}${comment ? ` — ${comment}` : ""}`,
    { oldValue: { status: rec.status }, newValue: { status: newStatus }, reason: comment })
  await notify(ctx.vendorId, { employeeId: rec.employeeId }, `KPI Target ${decision === "APPROVE" ? "Approved" : decision === "REJECT" ? "Rejected" : "Changes Requested"}`,
    `Your KPI target for ${rec.periodLabel} was ${action}.${comment ? ` Reason: ${comment}` : ""}`, "SYSTEM", "performance")
  // a batch's rollup status may change when its members change
  if (rec.batchId) await refreshBatchStatus(ctx.vendorId, rec.batchId)
  return { status: newStatus }
}

/** Recompute the batch rollup from its member assignments or achievements. */
export async function refreshBatchStatus(vendorId: string, batchId: string, decidedBy?: string | null): Promise<string> {
  const batch = await db.kpiBatch.findUnique({ where: { id: batchId } })
  if (!batch) return "UNKNOWN"

  let status = "PENDING_APPROVAL"
  if (batch.kind === "ACHIEVEMENT") {
    const achs = await db.kpiAchievement.findMany({
      where: { vendorId, batchId },
      select: { status: true },
    })
    const active = achs.filter((a) => a.status !== "CANCELLED")
    const approved = active.filter((a) => a.status === "APPROVED").length
    const rejected = active.filter((a) => a.status === "REJECTED" || a.status === "CHANGES_REQUESTED").length
    const pending = active.filter((a) => a.status === "PENDING_APPROVAL" || a.status === "DRAFT").length
    if (active.length && approved === active.length) status = "APPROVED"
    else if (active.length && rejected === active.length) status = "REJECTED"
    else if ((approved > 0 || rejected > 0) && pending > 0) status = "PARTIALLY_APPROVED"
    else if (pending === active.length) status = "PENDING_APPROVAL"
    else if (approved > 0) status = "APPROVED"
  } else {
    const members = await db.kpiAssignment.findMany({
      where: { vendorId, batchId },
      select: { status: true },
    })
    const active = members.filter((m) => m.status !== "CANCELLED")
    const approved = active.filter((m) => m.status === "APPROVED").length
    const rejected = active.filter((m) => m.status === "REJECTED" || m.status === "CHANGES_REQUESTED").length
    const pending = active.filter((m) => m.status === "PENDING_APPROVAL" || m.status === "DRAFT").length
    if (active.length && approved === active.length) status = "APPROVED"
    else if (active.length && rejected === active.length) status = "REJECTED"
    else if ((approved > 0 || rejected > 0) && pending > 0) status = "PARTIALLY_APPROVED"
    else if (pending === active.length) status = "PENDING_APPROVAL"
    else if (approved > 0) status = "APPROVED"
  }

  const isDecided = status === "APPROVED" || status === "REJECTED" || status === "PARTIALLY_APPROVED"
  const needsUpdate = status !== batch.status || (isDecided && !batch.decidedAt)
  if (needsUpdate) {
    await db.kpiBatch.update({
      where: { id: batchId },
      data: {
        status,
        ...(isDecided
          ? { decidedAt: batch.decidedAt || new Date(), ...(decidedBy && !batch.decidedBy ? { decidedBy } : {}) }
          : {}),
      },
    })
  }
  return status
}

// ---------------------------------------------------------------------------
// Achievement upsert (single employee) + decisions
// ---------------------------------------------------------------------------

export type AchievementValueInput = {
  indicatorRowId: string
  actualValue?: number | null
  reportedDate?: string | null
  remarks?: string | null
  evidenceName?: string | null
}

export async function upsertAchievements(
  ctx: Ctx,
  input: { assignmentId: string; values: AchievementValueInput[]; submit?: boolean; batchId?: string | null },
): Promise<{ updated: number; submitted: number }> {
  const rec = await db.kpiAssignment.findFirst({ where: { id: input.assignmentId, vendorId: ctx.vendorId } })
  if (!rec) throw new Deny("KPI target assignment not found", 404)
  if (rec.status !== "APPROVED") {
    throw new Deny(`Achievements can only be recorded against an APPROVED target — this one is ${rec.status.replace(/_/g, " ").toLowerCase()}`, 409)
  }
  if (!input.values.length) throw new Deny("Provide at least one achievement value", 400)
  const rows = await db.kpiAssignmentIndicator.findMany({ where: { assignmentId: rec.id } })
  const rowById = new Map(rows.map((r) => [r.id, r]))
  for (const v of input.values) {
    if (!rowById.has(v.indicatorRowId)) throw new Deny("Indicator does not belong to this assignment", 400)
  }
  const settings = await kpiSettings(ctx.vendorId, ctx.activeCompanyId)
  const opts = scoringOptions(settings)
  const existing = await db.kpiAchievement.findMany({ where: { assignmentId: rec.id } })
  const byRow = new Map(existing.map((a) => [a.indicatorRowId, a]))
  const submit = input.submit !== false
  let updated = 0
  for (const v of input.values) {
    const row = rowById.get(v.indicatorRowId)
    if (!row) throw new Deny("Indicator does not belong to this assignment", 400)
    const prev = byRow.get(v.indicatorRowId)
    if (prev?.status === "APPROVED") {
      // APPROVED achievements are immutable from ordinary editing — archive
      // the previous approved state and roll the row back into re-approval.
      await archiveAchievementRevisions(rec.id, ctx.userId, "achievement correction (re-approval)")
    }
    const actual = v.actualValue == null ? null : Number(v.actualValue)
    const pct = actual == null ? null : achievementPct({ direction: row.direction as KpiDirection, target: row.targetValue, actual }, opts)
    const score = indicatorScore(pct, row.weight)
    const data = {
      actualValue: actual,
      achievementPct: pct,
      score,
      reportedDate: v.reportedDate || null,
      remarks: v.remarks || null,
      evidenceName: v.evidenceName || null,
      status: submit ? "PENDING_APPROVAL" : "DRAFT",
      submittedBy: ctx.userId,
      submittedAt: submit ? new Date() : null,
      decidedBy: null,
      decidedAt: null,
    }
    if (prev) {
      await db.kpiAchievement.update({
        where: { id: prev.id },
        data: { ...data, ...(prev.status === "APPROVED" ? { revision: { increment: 1 } } : {}) },
      })
    } else {
      await db.kpiAchievement.create({
        data: {
          vendorId: ctx.vendorId,
          assignmentId: rec.id,
          employeeId: rec.employeeId,
          indicatorRowId: row.id,
          indicatorId: row.indicatorId,
          indicatorName: row.name,
          unit: row.unit,
          direction: row.direction,
          weight: row.weight,
          targetValue: row.targetValue ?? 0,
          batchId: input.batchId ?? null,
          revision: 1,
          ...data,
        },
      })
    }
    updated++
  }
  await syncAssignmentMirror(rec.id, ctx.activeCompanyId)
  await recordKpiAction(ctx.vendorId, {
    entityType: "KPI_ACHIEVEMENT", entityId: rec.id, employeeId: rec.employeeId,
    action: submit ? "SUBMIT" : "REVISE",
    comment: `${updated} indicator value(s) ${submit ? "submitted for approval" : "saved as draft"}`,
  }, ctx)
  if (submit) {
    const emp = await db.employee.findUnique({ where: { id: rec.employeeId }, select: { fullName: true } })
    await audit(ctx, "kpi.achievements.submit", "KpiAchievement", rec.id,
      `Achievement data submitted for ${emp?.fullName || "employee"} (${rec.periodLabel}, ${updated} indicator(s))`)
    await notify(ctx.vendorId, { role: "HR_ADMIN" }, "KPI Achievement Submitted",
      `Achievement data for ${emp?.fullName || "an employee"} (${rec.periodLabel}) is waiting for approval.`, "SYSTEM", "performance")
  }
  return { updated, submitted: submit ? updated : 0 }
}

/** Employee-wise achievement decision: all PENDING_APPROVAL rows of the
 * assignment move together. */
export async function decideAchievements(
  ctx: Ctx,
  assignmentId: string,
  decision: "APPROVE" | "REJECT" | "REQUEST_CHANGES",
  comment?: string,
): Promise<{ affected: number }> {
  const rec = await db.kpiAssignment.findFirst({ where: { id: assignmentId, vendorId: ctx.vendorId } })
  if (!rec) throw new Deny("KPI target assignment not found", 404)
  if ((decision === "REJECT" || decision === "REQUEST_CHANGES") && !comment?.trim()) {
    throw new Deny(`${decision === "REJECT" ? "Rejection" : "Change request"} requires a reason`, 400)
  }
  const settings = await kpiSettings(ctx.vendorId, ctx.activeCompanyId)
  assertNotSelfApproval(ctx, rec.createdBy, settings, "achievement batch")
  const newStatus = decision === "APPROVE" ? "APPROVED" : decision === "REJECT" ? "REJECTED" : "CHANGES_REQUESTED"
  // conditional check-and-set over the pending set only
  const res = await db.kpiAchievement.updateMany({
    where: { assignmentId, vendorId: ctx.vendorId, status: "PENDING_APPROVAL" },
    data: { status: newStatus, decidedBy: ctx.userId, decidedAt: new Date() },
  })
  if (res.count === 0) throw new Deny("No achievement data is pending approval for this employee and period", 409)
  await syncAssignmentMirror(assignmentId, ctx.activeCompanyId)
  await recordKpiAction(ctx.vendorId, {
    entityType: "KPI_ACHIEVEMENT", entityId: assignmentId, employeeId: rec.employeeId,
    action: decision === "APPROVE" ? "APPROVE" : decision === "REJECT" ? "REJECT" : "REQUEST_CHANGES",
    comment,
  }, ctx)
  const emp = await db.employee.findUnique({ where: { id: rec.employeeId }, select: { fullName: true } })
  const action = decision === "APPROVE" ? "approved" : decision === "REJECT" ? "rejected" : "returned with change requests"
  await audit(ctx, `kpi.achievements.${decision.toLowerCase()}`, "KpiAchievement", assignmentId,
    `Achievements for ${emp?.fullName || "employee"} (${rec.periodLabel}) ${action} — ${res.count} indicator(s)${comment ? ` — ${comment}` : ""}`,
    { reason: comment })
  await notify(ctx.vendorId, { employeeId: rec.employeeId }, `KPI Achievement ${decision === "APPROVE" ? "Approved" : decision === "REJECT" ? "Rejected" : "Changes Requested"}`,
    `Your achievement data for ${rec.periodLabel} was ${action}.${comment ? ` Reason: ${comment}` : ""}`, "SYSTEM", "performance")
  const achBatches = await db.kpiAchievement.findMany({
    where: { assignmentId, vendorId: ctx.vendorId, batchId: { not: null } },
    select: { batchId: true },
    distinct: ["batchId"],
  })
  for (const { batchId } of achBatches) {
    if (batchId) await refreshBatchStatus(ctx.vendorId, batchId, ctx.userId)
  }
  return { affected: res.count }
}

// ---------------------------------------------------------------------------
// Target edit (drafts free-edit; approved → revision + re-approval)
// ---------------------------------------------------------------------------

export async function updateTargetAssignment(
  ctx: Ctx,
  input: {
    assignmentId: string
    dueDate?: string | null
    remarks?: string | null
    indicators?: (IndicatorInput & { id?: string })[]
    resubmit?: boolean
  },
): Promise<{ revision: number; status: KpiStatus }> {
  const rec = await db.kpiAssignment.findFirst({ where: { id: input.assignmentId, vendorId: ctx.vendorId } })
  if (!rec) throw new Deny("KPI target assignment not found", 404)
  if (rec.status === "CANCELLED") throw new Deny("Cancelled targets cannot be edited", 409)

  const wasApproved = rec.status === "APPROVED"
  let revision = rec.revision
  if (wasApproved) {
    revision = (await archiveTargetRevision(rec.id, ctx.userId, "target edit — rolled back to re-approval")) + 1
  }

  if (input.indicators) {
    validateIndicatorWeights(input.indicators)
    const rows = await db.kpiAssignmentIndicator.findMany({ where: { assignmentId: rec.id } })
    const rowById = new Map(rows.map((r) => [r.id, r]))
    // delete rows that are no longer present (never touch history: rows
    // referenced by achievements are preserved to keep targets intact)
    const keep = new Set(input.indicators.filter((i) => i.id).map((i) => String(i.id)))
    const achRows = await db.kpiAchievement.findMany({ where: { assignmentId: rec.id }, select: { indicatorRowId: true } })
    const achRowIds = new Set(achRows.map((a) => a.indicatorRowId))
    for (const r of rows) {
      if (!keep.has(r.id) && !achRowIds.has(r.id)) {
        await db.kpiAssignmentIndicator.delete({ where: { id: r.id } })
      }
    }
    for (const [idx, i] of input.indicators.entries()) {
      const data = {
        name: (i.name || "Indicator").trim(),
        unit: i.unit,
        unitLabel: i.unitLabel ?? null,
        direction: i.direction,
        weight: Number(i.weight) || 0,
        targetValue: i.targetValue == null ? null : Number(i.targetValue),
        sortOrder: i.sortOrder ?? idx + 1,
        builtinKey: i.builtinKey ?? null,
        source: (i.builtinKey ? "BUILTIN" : "CUSTOM") as "BUILTIN" | "CUSTOM",
      }
      if (i.id && rowById.has(i.id)) {
        await db.kpiAssignmentIndicator.update({ where: { id: i.id }, data })
      } else {
        await db.kpiAssignmentIndicator.create({
          data: { vendorId: ctx.vendorId, assignmentId: rec.id, indicatorId: i.indicatorId ?? null, ...data },
        })
      }
    }
  }

  // status: DRAFT stays draft unless resubmit; REJECTED/CHANGES_REQUESTED
  // re-enter approval on resubmit; APPROVED edits always require re-approval.
  // The schema stores status as a plain String column (not a Prisma enum), so
  // the row type widens to string — narrow through the status catalog instead
  // of a blind cast; an unexpected stored value falls back to DRAFT.
  const toStatus = (s: string): KpiStatus =>
    (KPI_STATUSES as readonly string[]).includes(s) ? (s as KpiStatus) : "DRAFT"
  const nextStatus: KpiStatus = wasApproved
    ? "PENDING_APPROVAL"
    : input.resubmit && (rec.status === "DRAFT" || rec.status === "REJECTED" || rec.status === "CHANGES_REQUESTED")
      ? "PENDING_APPROVAL"
      : toStatus(rec.status)
  await db.kpiAssignment.update({
    where: { id: rec.id },
    data: {
      dueDate: input.dueDate !== undefined ? input.dueDate : rec.dueDate,
      remarks: input.remarks !== undefined ? input.remarks : rec.remarks,
      ...(wasApproved ? { revision } : {}),
      status: nextStatus,
      ...(nextStatus === "PENDING_APPROVAL" ? { submittedAt: new Date() } : {}),
    },
  })
  await syncAssignmentMirror(rec.id, ctx.activeCompanyId)
  if (wasApproved || input.resubmit) {
    await recordKpiAction(ctx.vendorId, {
      entityType: "KPI_TARGET", entityId: rec.id, employeeId: rec.employeeId,
      action: wasApproved ? "REVISE" : "SUBMIT",
      comment: wasApproved ? "approved target edited — revision submitted for re-approval" : "resubmitted",
    }, ctx)
  }
  await audit(ctx, "kpi.targets.update", "KpiAssignment", rec.id,
    `Updated KPI target (${rec.periodLabel})${wasApproved ? ` — revision ${revision}, previous approved state archived, re-approval required` : ""}`)
  return { revision, status: nextStatus }
}

// ---------------------------------------------------------------------------
// Template helpers
// ---------------------------------------------------------------------------

/** The active, non-deleted template for a department (company-scoped).
 * Inactive templates do NOT free the slot — reactivation goes through the
 * existing template (uniqueness is enforced regardless of active state). */
export async function departmentTemplate(vendorId: string, companyId: string, departmentId: string) {
  return db.kpiTemplate.findFirst({
    where: { vendorId, companyId, departmentId, deletedAt: null },
    orderBy: { createdAt: "asc" },
  })
}

/** Snapshot a template's indicators into IndicatorInput rows (per-employee
 * target overrides keyed by template indicator id). */
export async function templateIndicatorInputs(
  vendorId: string,
  templateId: string,
  overrides?: Record<string, number | null | undefined>,
): Promise<IndicatorInput[]> {
  const rows = await db.kpiIndicator.findMany({
    where: { vendorId, templateId, active: true },
    orderBy: { sortOrder: "asc" },
  })
  return rows.map((r, idx) => ({
    indicatorId: r.id,
    name: r.name,
    builtinKey: r.builtinKey,
    unit: r.unit as KpiUnit,
    unitLabel: r.unitLabel,
    direction: r.direction as KpiDirection,
    weight: r.weight,
    targetValue: overrides && r.id in overrides ? (overrides[r.id] ?? null) : r.defaultTarget,
    sortOrder: idx + 1,
  }))
}
