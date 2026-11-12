// ============ KPI Performance Review & Analytics routes (2026-11 redesign) ============
// The unified analytics experience replacing the standalone Review + Analytics
// tabs. EVERY number here derives from APPROVED KPI targets + APPROVED
// achievements (pending/rejected data never moves a performance score).
// Filters: department, employee, designation, one-or-many periods, custom date
// range, performance rating band.
import { z } from "zod"
import { db } from "@/lib/db"
import { route } from "./registry"
import { assertEmployeeVisible, employeeScopeFilter } from "../rbac"
import { audit } from "../audit"
import { formatPeriodLabel, ratingFor, weightedScore, scoringOptions } from "../kpi/scoring"
import { kpiSettings } from "../kpi/service"

/** Map-of-lists push helper (avoids non-null assertions). */
function pushTo<T>(m: Map<string, T[]>, k: string, v: T): void {
  const arr = m.get(k)
  if (arr) arr.push(v)
  else m.set(k, [v])
}

const optFilter = (max = 40) => z.preprocess((v) => (v === "" ? null : v), z.string().trim().min(1).max(max).nullish())
const optPeriod = () => z.preprocess((v) => (v === "" ? null : v), z.string().trim().min(4).max(20).nullish())

const analyticsFilterSchema = z.object({
  departmentId: optFilter(),
  employeeId: optFilter(),
  designationId: optFilter(),
  periodLabel: optPeriod(),
  periods: z.array(z.string().trim().min(4).max(20)).max(36).nullish(),
  from: z.preprocess((v) => (v === "" ? null : v), z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish()),
  to: z.preprocess((v) => (v === "" ? null : v), z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish()),
  rating: optFilter(60), // rating label filter
  minScore: z.number().min(0).max(1000).nullish(),
  maxScore: z.number().min(0).max(1000).nullish(),
  page: z.number().int().min(1).nullish(),
  pageSize: z.number().int().min(1).max(500).nullish(),
}).strict().partial().optional()

/** Resolve the employee universe + assignments + approved achievements for the
 * given filters. Shared by every analytics route so the numbers are always
 * computed the same way. */
async function analyticsContext(ctx: any, p: any) {
  const scope = employeeScopeFilter(ctx)
  const [scopedEmployees, departments, designations] = await Promise.all([
    db.employee.findMany({
      where: {
        ...scope,
        ...(p?.departmentId ? { departmentId: p.departmentId } : {}),
        ...(p?.employeeId ? { id: p.employeeId } : {}),
        ...(p?.designationId ? { designationId: p.designationId } : {}),
      },
      select: { id: true, code: true, fullName: true, departmentId: true, designationId: true, status: true },
    }),
    db.department.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } }),
    db.designation.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } }),
  ])
  const employeeIds = scopedEmployees.map((e) => e.id)
  const periodFilter: any = {}
  const periods = p?.periods?.length ? p.periods : p?.periodLabel ? [p.periodLabel] : null
  if (periods) periodFilter.periodLabel = { in: periods }
  else if (p?.from || p?.to) {
    // custom date range → match assignments whose period window overlaps
    periodFilter.OR = [
      ...(p?.from ? [{ periodEnd: { gte: p.from } }, { periodEnd: null }] : []),
      ...(p?.to ? [{ periodStart: { lte: p.to } }, { periodStart: null }] : []),
    ]
  }
  const assignments = employeeIds.length
    ? await db.kpiAssignment.findMany({
        where: { vendorId: ctx.vendorId, status: { not: "CANCELLED" }, employeeId: { in: employeeIds }, ...periodFilter },
        orderBy: [{ periodLabel: "asc" }, { createdAt: "asc" }],
      })
    : []
  const assignmentIds = assignments.map((a) => a.id)
  const achievements = assignmentIds.length
    ? await db.kpiAchievement.findMany({ where: { vendorId: ctx.vendorId, assignmentId: { in: assignmentIds } } })
    : []
  const settings = await kpiSettings(ctx.vendorId, ctx.activeCompanyId)
  return {
    employees: scopedEmployees,
    empById: new Map(scopedEmployees.map((e) => [e.id, e])),
    deptById: new Map(departments.map((d) => [d.id, d.name])),
    desigById: new Map(designations.map((d) => [d.id, d.name])),
    assignments,
    achievements,
    achByAssignment: achievements.reduce((m, a) => {
      pushTo(m, a.assignmentId, a)
      return m
    }, new Map<string, typeof achievements>()),
    settings,
  }
}

/** One employee×period review row — the unit of the review table, the trend
 * charts and the exports. Score comes from APPROVED achievements only. */
function reviewRow(a: any, ctxData: Awaited<ReturnType<typeof analyticsContext>>) {
  const achs = ctxData.achByAssignment.get(a.id) || []
  const approved = achs.filter((x) => x.status === "APPROVED")
  const opts = scoringOptions(ctxData.settings)
  const w = weightedScore(
    approved.map((x) => ({ pct: x.achievementPct, weight: x.weight })),
    { ...opts, missingDataCountsZero: ctxData.settings.missingDataCountsZero },
  )
  const statuses = new Set(achs.map((x) => x.status))
  const aggStatus = !achs.length ? "NOT_UPLOADED"
    : statuses.has("PENDING_APPROVAL") ? "PENDING_APPROVAL"
    : statuses.has("CHANGES_REQUESTED") ? "CHANGES_REQUESTED"
    : statuses.has("REJECTED") ? "REJECTED"
    : statuses.has("DRAFT") ? "DRAFT"
    : "APPROVED"
  const emp = ctxData.empById.get(a.employeeId)
  const achievementAvg = approved.length
    ? Math.round((approved.reduce((s, x) => s + (x.achievementPct || 0), 0) / approved.length) * 10) / 10
    : null
  return {
    assignmentId: a.id,
    employeeId: a.employeeId,
    employeeCode: emp?.code || "—",
    employeeName: emp?.fullName || "—",
    departmentId: emp?.departmentId || null,
    departmentName: emp?.departmentId ? ctxData.deptById.get(emp.departmentId) || null : null,
    designationName: emp?.designationId ? ctxData.desigById.get(emp.designationId) || null : null,
    periodLabel: a.periodLabel,
    periodDisplay: formatPeriodLabel(a.periodLabel, a.periodStart, a.periodEnd),
    periodStart: a.periodStart,
    periodEnd: a.periodEnd,
    targetStatus: a.status,
    status: aggStatus,
    uploadedIndicators: achs.filter((x) => x.actualValue != null).length,
    totalIndicators: j(a.resultsJson, []).length || achs.length,
    score: w.score,
    achievementAvg,
    rating: ratingFor(w.score, ctxData.settings.ratings),
    totalScore: a.totalScore,
    dueDate: a.dueDate,
  }
}

function j(v: string | null, fallback: any) {
  try { return v ? JSON.parse(v) : fallback } catch { return fallback }
}

// ---------------------------------------------------------------------------
// Summary cards
// ---------------------------------------------------------------------------

route("kpi.analytics.summary", {
  perm: ["performance", "view"],
  schema: analyticsFilterSchema,
  handler: async (ctx, p) => {
    const data = await analyticsContext(ctx, p)
    const rows = data.assignments.map((a) => reviewRow(a, data))
    const withTargets = new Set(rows.filter((r) => r.targetStatus === "APPROVED").map((r) => r.employeeId))
    const withApprovedAch = new Set(rows.filter((r) => r.status === "APPROVED" && r.uploadedIndicators > 0).map((r) => r.employeeId))
    const scored = rows.filter((r) => r.score != null)
    const bands = data.settings.ratings
    const topBand = bands[0]
    const bottomBand = bands[bands.length - 1]
    const highPerformers = scored.filter((r) => topBand != null && r.score != null && r.score >= topBand.min).length
    const needImprovement = scored.filter((r) => bottomBand != null && r.score != null && r.score < (bands[bands.length - 2]?.min ?? bottomBand.min)).length
    const avgScore = scored.length ? Math.round((scored.reduce((s, r) => s + (r.score || 0), 0) / scored.length) * 10) / 10 : null
    return {
      totalEmployees: new Set(rows.map((r) => r.employeeId)).size,
      withApprovedTargets: withTargets.size,
      withApprovedAchievements: withApprovedAch.size,
      avgScore,
      highPerformers,
      needImprovement,
      pendingTargets: data.assignments.filter((a) => a.status === "PENDING_APPROVAL").length,
      pendingAchievementReviews: rows.filter((r) => r.status === "PENDING_APPROVAL").length,
      periods: [...new Set(data.assignments.map((a) => a.periodLabel))].sort(),
    }
  },
})

// ---------------------------------------------------------------------------
// Employee-wise review table (paged)
// ---------------------------------------------------------------------------

route("kpi.analytics.employees", {
  perm: ["performance", "view"],
  schema: analyticsFilterSchema,
  handler: async (ctx, p) => {
    const data = await analyticsContext(ctx, p)
    let rows = data.assignments.map((a) => reviewRow(a, data))
    // score trend vs the employee's previous period (same filter universe)
    const byEmp = new Map<string, typeof rows>()
    for (const r of rows) pushTo(byEmp, r.employeeId, r)
    for (const list of byEmp.values()) {
      list.sort((a, b) => (a.periodLabel < b.periodLabel ? -1 : 1))
      for (let i = 1; i < list.length; i++) {
        // locals keep the indexed access null-safe for the trend math below
        const cur = list[i]
        const prev = list[i - 1]
        if (!cur || !prev) continue
        ;(cur as any).prevScore = prev.score
        ;(cur as any).trend = cur.score != null && prev.score != null
          ? Math.round(((cur.score - prev.score) / Math.max(1, prev.score || 1)) * 1000) / 10
          : null
      }
    }
    if (p?.rating) rows = rows.filter((r) => r.rating?.label === p.rating)
    if (p?.minScore != null) rows = rows.filter((r) => (r.score ?? -1) >= p.minScore)
    if (p?.maxScore != null) rows = rows.filter((r) => (r.score ?? 1e9) <= p.maxScore)
    rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.employeeName.localeCompare(b.employeeName))
    const pageSize = Math.min(500, Math.max(1, Number(p?.pageSize) || 50))
    const page = Math.max(1, Number(p?.page) || 1)
    return {
      items: rows.slice((page - 1) * pageSize, page * pageSize),
      total: rows.length,
      page,
      pageSize,
      ratingBands: data.settings.ratings,
    }
  },
})

// ---------------------------------------------------------------------------
// Employee performance detail (multi-period deep dive)
// ---------------------------------------------------------------------------

route("kpi.analytics.employeeDetail", {
  perm: ["performance", "view"],
  schema: z.object({
    employeeId: z.string().trim().min(1).max(40),
    periods: z.array(z.string().trim().min(4).max(20)).max(36).nullish(),
  }).strict(),
  handler: async (ctx, p) => {
    const emp = await assertEmployeeVisible(ctx, p.employeeId)
    const settings = await kpiSettings(ctx.vendorId, ctx.activeCompanyId)
    const assignments = await db.kpiAssignment.findMany({
      where: {
        vendorId: ctx.vendorId, employeeId: p.employeeId, status: { not: "CANCELLED" },
        ...(p.periods?.length ? { periodLabel: { in: p.periods } } : {}),
      },
      orderBy: { periodLabel: "asc" },
    })
    const ids = assignments.map((a) => a.id)
    const [achs, inds, deptName, desigName] = await Promise.all([
      ids.length ? db.kpiAchievement.findMany({ where: { vendorId: ctx.vendorId, assignmentId: { in: ids } } }) : [],
      ids.length ? db.kpiAssignmentIndicator.findMany({ where: { assignmentId: { in: ids } }, orderBy: { sortOrder: "asc" } }) : [],
      emp.departmentId ? db.department.findUnique({ where: { id: emp.departmentId }, select: { name: true } }) : Promise.resolve(null),
      emp.designationId ? db.designation.findUnique({ where: { id: emp.designationId }, select: { name: true } }) : Promise.resolve(null),
    ])
    const opts = scoringOptions(settings)
    const periods = assignments.map((a) => {
      const rows = inds.filter((i) => i.assignmentId === a.id)
      const empAchs = achs.filter((x) => x.assignmentId === a.id)
      const approved = empAchs.filter((x) => x.status === "APPROVED")
      const w = weightedScore(approved.map((x) => ({ pct: x.achievementPct, weight: x.weight })), { ...opts, missingDataCountsZero: settings.missingDataCountsZero })
      return {
        assignmentId: a.id,
        periodLabel: a.periodLabel,
        periodDisplay: formatPeriodLabel(a.periodLabel, a.periodStart, a.periodEnd),
        dueDate: a.dueDate,
        targetStatus: a.status,
        score: w.score,
        rating: ratingFor(w.score, settings.ratings),
        indicators: rows.map((r) => {
          const ach = empAchs.find((x) => x.indicatorRowId === r.id) || null
          return {
            indicatorRowId: r.id,
            name: r.name,
            source: r.source,
            builtinKey: r.builtinKey,
            unit: r.unit,
            unitLabel: r.unitLabel,
            direction: r.direction,
            weight: r.weight,
            targetValue: r.targetValue,
            actualValue: ach?.actualValue ?? null,
            achievementPct: ach?.achievementPct ?? null,
            score: ach?.score ?? null,
            status: ach?.status ?? "NOT_UPLOADED",
            remarks: ach?.remarks ?? null,
            revision: ach?.revision ?? null,
          }
        }),
      }
    })
    const scored = periods.filter((x) => x.score != null)
    return {
      employee: {
        id: emp.id, code: emp.code, fullName: emp.fullName, status: emp.status,
        departmentName: deptName?.name || null, designationName: desigName?.name || null,
      },
      periods,
      trend: scored.map((x) => ({ period: x.periodLabel, display: x.periodDisplay, score: x.score, rating: x.rating?.label })),
      avgScore: scored.length ? Math.round((scored.reduce((s, x) => s + (x.score || 0), 0) / scored.length) * 10) / 10 : null,
      bestPeriod: scored.length ? scored.reduce((b, x) => ((x.score || 0) > (b.score || 0) ? x : b)).periodLabel : null,
      ratingBands: settings.ratings,
    }
  },
})

// ---------------------------------------------------------------------------
// Chart datasets
// ---------------------------------------------------------------------------

route("kpi.analytics.charts", {
  perm: ["performance", "view"],
  schema: analyticsFilterSchema,
  handler: async (ctx, p) => {
    const data = await analyticsContext(ctx, p)
    const rows = data.assignments.map((a) => reviewRow(a, data))
    // department-wise average score
    const byDept = new Map<string, { total: number; n: number }>()
    for (const r of rows) {
      if (r.score == null || !r.departmentName) continue
      const acc = byDept.get(r.departmentName) || { total: 0, n: 0 }
      acc.total += r.score
      acc.n++
      byDept.set(r.departmentName, acc)
    }
    const departmentPerformance = [...byDept.entries()]
      .map(([name, v]) => ({ name, avgScore: Math.round((v.total / v.n) * 10) / 10, employees: v.n }))
      .sort((a, b) => b.avgScore - a.avgScore)
    // indicator-wise achievement (approved only) + target vs actual + unit totals
    const approvedAchs = data.achievements.filter((x) => x.status === "APPROVED")
    const byIndicator = new Map<string, { pcts: number[]; targets: number[]; actuals: number[]; unit: string }>()
    for (const a of approvedAchs) {
      const acc = byIndicator.get(a.indicatorName) || { pcts: [], targets: [], actuals: [], unit: a.unit }
      if (a.achievementPct != null) acc.pcts.push(a.achievementPct)
      acc.targets.push(Number(a.targetValue) || 0)
      if (a.actualValue != null) acc.actuals.push(a.actualValue)
      byIndicator.set(a.indicatorName, acc)
    }
    const indicatorAchievement = [...byIndicator.entries()].map(([name, v]) => ({
      name,
      avgAchievementPct: v.pcts.length ? Math.round((v.pcts.reduce((s, x) => s + x, 0) / v.pcts.length) * 10) / 10 : null,
      avgTarget: v.targets.length ? Math.round((v.targets.reduce((s, x) => s + x, 0) / v.targets.length) * 100) / 100 : null,
      avgActual: v.actuals.length ? Math.round((v.actuals.reduce((s, x) => s + x, 0) / v.actuals.length) * 100) / 100 : null,
      unit: v.unit,
      count: v.pcts.length,
    })).sort((a, b) => (b.avgAchievementPct ?? -1) - (a.avgAchievementPct ?? -1))
    // rating distribution
    const ratingDistribution = data.settings.ratings.map((b) => ({
      label: b.label,
      count: rows.filter((r) => r.rating?.label === b.label).length,
    }))
    // period-over-period trend
    const byPeriod = new Map<string, { total: number; n: number }>()
    for (const r of rows) {
      if (r.score == null) continue
      const acc = byPeriod.get(r.periodLabel) || { total: 0, n: 0 }
      acc.total += r.score
      acc.n++
      byPeriod.set(r.periodLabel, acc)
    }
    const periodTrend = [...byPeriod.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([period, v]) => ({
      period,
      display: formatPeriodLabel(period),
      avgScore: Math.round((v.total / v.n) * 10) / 10,
      reviews: v.n,
    }))
    // high/low performer distribution (top + bottom band employees)
    const scoredRows = rows.filter((r) => r.score != null)
    const topPerformers = [...scoredRows].sort((a, b) => ((b.score || 0) - (a.score || 0)) || a.employeeName.localeCompare(b.employeeName)).slice(0, 10)
      .map((r) => ({ employeeId: r.employeeId, employeeName: r.employeeName, departmentName: r.departmentName, period: r.periodDisplay, score: r.score, rating: r.rating?.label }))
    const bottomPerformers = [...scoredRows].sort((a, b) => ((a.score || 0) - (b.score || 0)) || a.employeeName.localeCompare(b.employeeName)).slice(0, 10)
      .map((r) => ({ employeeId: r.employeeId, employeeName: r.employeeName, departmentName: r.departmentName, period: r.periodDisplay, score: r.score, rating: r.rating?.label }))
    return { departmentPerformance, indicatorAchievement, ratingDistribution, periodTrend, topPerformers, bottomPerformers, ratingBands: data.settings.ratings }
  },
})

// ---------------------------------------------------------------------------
// Export (Excel / CSV) of the review table
// ---------------------------------------------------------------------------

route("kpi.analytics.export", {
  perm: ["performance", "export"],
  schema: z.object({
    format: z.enum(["xlsx", "csv"]),
    departmentId: optFilter(),
    employeeId: optFilter(),
    designationId: optFilter(),
    periodLabel: optPeriod(),
    periods: z.array(z.string().trim().min(4).max(20)).max(36).nullish(),
    rating: optFilter(60),
  }).strict(),
  handler: async (ctx, p) => {
    const data = await analyticsContext(ctx, p)
    let rows = data.assignments.map((a) => reviewRow(a, data))
    if (p?.rating) rows = rows.filter((r) => r.rating?.label === p.rating)
    await audit(ctx, "kpi.analytics.export", "KpiAssignment", null, `Exported the performance review report (${rows.length} employee-period row(s)) as ${(p as any).format?.toUpperCase()}`)
    if ((p as any).format === "csv") {
      const header = ["Employee ID", "Employee", "Department", "Designation", "Period", "Due Date", "KPI Score", "Achievement %", "Performance Rating", "Review Status", "Target Status"]
      const esc = (v: unknown) => { const s = String(v ?? ""); return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s }
      const lines = ["\uFEFF" + header.join(",")]
      for (const r of rows) {
        lines.push([
          r.employeeCode, r.employeeName, r.departmentName || "", r.designationName || "", r.periodLabel,
          r.dueDate || "", r.score ?? "", r.achievementAvg ?? "", r.rating?.label || "", r.status, r.targetStatus,
        ].map((c) => `"${esc(c).replace(/"/g, '""')}"`).join(","))
      }
      return { format: "csv", filename: `performance-review-${new Date().toISOString().slice(0, 10)}.csv`, csv: lines.join("\n") }
    }
    const header = ["Employee ID", "Employee", "Department", "Designation", "Period", "Due Date", "KPI Score", "Achievement %", "Performance Rating", "Review Status", "Target Status"]
    const dataRows = rows.map((r) => [
      r.employeeCode, r.employeeName, r.departmentName || "", r.designationName || "", r.periodLabel,
      r.dueDate || "", r.score ?? "", r.achievementAvg ?? "", r.rating?.label || "", r.status, r.targetStatus,
    ])
    const XLSX = await import("xlsx")
    const ws = XLSX.utils.aoa_to_sheet([header, ...dataRows])
    ws["!cols"] = header.map((h, i) => ({ wch: i === 1 ? 26 : Math.min(24, Math.max(10, h.length + 6)) }))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, "Performance Review")
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer
    return {
      format: "xlsx",
      filename: `performance-review-${new Date().toISOString().slice(0, 10)}.xlsx`,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      base64: buf.toString("base64"),
    }
  },
})

// NOTE — CSV export guards mirror the shared excel.ts conventions (BOM +
// formula-injection prefix).
