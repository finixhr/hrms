// ============ Performance / KPI / Task routes (spec §11) ============
import { db } from "@/lib/db"
import { route } from "./registry"
import { Deny, employeeScopeFilter, assertEmployeeVisible } from "../rbac"
import { audit, notify } from "../audit"
import { notifyChannels } from "../delivery"
import { j, today } from "../utils"
import { REVIEW_AREAS } from "../types"
import { safePayload } from "../security"
import { S } from "../validation"

// ---------- Review cycles ----------
route("cycles.list", {
  perm: ["performance", "view"],
  handler: async (ctx) => db.reviewCycle.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { year: "desc" } }),
})
route("cycles.save", {
  perm: ["performance", "create"],
  handler: async (ctx, p) => {
    // H-5 — explicit whitelist; vendorId/id are server-controlled
    const data = safePayload<any>(p, ["name", "year", "startDate", "endDate", "status"],
      { numericFields: ["year"] })
    if (!data.name) throw new Deny("Cycle name is required")
    if (data.year && (!Number.isInteger(data.year) || data.year < 2000 || data.year > 2100)) throw new Deny("Invalid year")
    if (p.id) {
      const rec = await db.reviewCycle.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
      if (!rec) throw new Deny("Not found", 404)
      const updated = await db.reviewCycle.update({ where: { id: p.id }, data })
      // Audit Low — cycle updates were previously unaudited
      await audit(ctx, "cycles.update", "ReviewCycle", p.id, `Updated review cycle ${data.name || rec.name}`, { oldValue: rec, newValue: data })
      return updated
    }
    const rec = await db.reviewCycle.create({ data: { ...data, vendorId: ctx.vendorId } })
    await audit(ctx, "cycles.create", "ReviewCycle", rec.id, `Created review cycle ${p.name}`)
    return rec
  },
})

// ---------- Performance reviews ----------
route("reviews.list", {
  perm: ["performance", "view"],
  handler: async (ctx, p) => {
    const where: any = { vendorId: ctx.vendorId }
    if (p?.cycleId) where.cycleId = p.cycleId
    if (p?.employeeId) where.employeeId = p.employeeId
    const scope = employeeScopeFilter(ctx)
    if (!p?.employeeId) where.employeeId = { in: (await db.employee.findMany({ where: scope, select: { id: true } })).map((e) => e.id) }
    // MOD-16 (Phase 2 WS4) — optional pagination + page-scoped name joins
    const paged = p?.page != null || p?.pageSize != null
    const pageSize = Math.min(500, Math.max(1, Number(p?.pageSize) || 200))
    const page = Math.max(1, Number(p?.page) || 1)
    const [list, total] = paged
      ? await Promise.all([
<<<<<<< HEAD
          db.performanceReview.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: (page - 1) * pageSize, take: pageSize }),
=======
          db.performanceReview.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
>>>>>>> origin/main
          db.performanceReview.count({ where }),
        ])
      : [await db.performanceReview.findMany({ where, orderBy: { createdAt: "desc" } }), null]
    const pageIds = [...new Set(list.flatMap((r) => [r.employeeId, r.reviewerId].filter((x): x is string => !!x)))]
    const employees = pageIds.length
      ? await db.employee.findMany({ where: { vendorId: ctx.vendorId, id: { in: pageIds } }, select: { id: true, fullName: true, code: true } })
      : []
    const cycles = await db.reviewCycle.findMany({ where: { vendorId: ctx.vendorId } })
    const empById = new Map(employees.map((e) => [e.id, e]))
    const cycleById = new Map(cycles.map((c) => [c.id, c.name]))
    const items = list.map((r) => ({
      ...r,
      ratings: j(r.ratingsJson, {}),
      inputs: j((r as any).inputsJson, {}),
      employeeName: empById.get(r.employeeId)?.fullName || "—",
      cycleName: cycleById.get(r.cycleId) || "—",
      reviewerName: r.reviewerId ? empById.get(r.reviewerId)?.fullName : undefined,
    }))
    return paged ? { items, total, page, pageSize } : items
  },
})

route("reviews.save", {
  perm: ["performance", "create"],
  handler: async (ctx, p) => {
    const emp = await assertEmployeeVisible(ctx, p.employeeId)
    // Audit Low — reviewerId must reference an employee of THIS tenant
    if (p.reviewerId) {
      const reviewer = await db.employee.findFirst({ where: { id: p.reviewerId, vendorId: ctx.vendorId } })
      if (!reviewer) throw new Deny("Reviewer not found in this organization", 404)
    }
    const ratings: Record<string, number> = {}
    for (const a of REVIEW_AREAS) {
      if (p.ratings?.[a] != null) ratings[a] = Math.max(1, Math.min(5, Number(p.ratings[a])))
    }
    const values = Object.values(ratings)
    const overall = values.length ? Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 10) / 10 : 0
    // PRF-01 (R7) — peer input recorded by HR on behalf of colleagues:
    // { name, ratings (partial ok), comments }. Stored in inputsJson.peers;
    // the manager's own ratings stay in ratingsJson.
    const peers = sanitizePeerInputs(p.peerInputs)
    const existing = await db.performanceReview.findFirst({ where: { cycleId: p.cycleId, employeeId: p.employeeId } })
    if (existing) {
      if (existing.status === "FINAL") throw new Deny("Finalized reviews are immutable")
      const prevInputs = j((existing as any).inputsJson, {}) as any
      const rec = await db.performanceReview.update({
        where: { id: existing.id },
        data: {
          ratingsJson: JSON.stringify(ratings), overallRating: overall,
          reviewerId: p.reviewerId || existing.reviewerId,
          managerComments: p.managerComments ?? existing.managerComments,
          employeeComments: p.employeeComments ?? existing.employeeComments,
          strengths: p.strengths ?? existing.strengths,
          weaknesses: p.weaknesses ?? existing.weaknesses,
          goals: p.goals ?? existing.goals,
          improvementPlan: p.improvementPlan ?? existing.improvementPlan,
          status: p.status || existing.status,
          submittedAt: p.status === "SUBMITTED" ? new Date() : existing.submittedAt,
          // peer input replaces wholesale when provided; the self block is
          // employee-owned and NEVER overwritten from the HR plane
          ...(peers !== null ? { inputsJson: JSON.stringify({ ...prevInputs, peers }) } : {}),
        },
      })
      await audit(ctx, "reviews.update", "PerformanceReview", rec.id, `Updated review for ${emp.fullName} (overall ${overall})${peers ? ` + ${peers.length} peer input(s)` : ""}`)
      return rec
    }
    const rec = await db.performanceReview.create({
      data: {
        vendorId: ctx.vendorId, cycleId: p.cycleId, employeeId: p.employeeId,
        reviewerId: p.reviewerId || ctx.employeeId, ratingsJson: JSON.stringify(ratings),
        overallRating: overall, managerComments: p.managerComments, employeeComments: p.employeeComments,
        strengths: p.strengths, weaknesses: p.weaknesses, goals: p.goals, improvementPlan: p.improvementPlan,
        status: p.status || "DRAFT",
        ...(peers ? { inputsJson: JSON.stringify({ peers }) } : {}),
      },
    })
    await audit(ctx, "reviews.create", "PerformanceReview", rec.id, `Review created for ${emp.fullName} (overall ${overall})`)
    if (p.status === "SUBMITTED") {
      await db.employeeHistory.create({
        data: { vendorId: ctx.vendorId, employeeId: emp.id, eventType: "REVIEW", title: `Performance review submitted (${overall}/5)`, effectiveDate: today(), dataJson: JSON.stringify({ reviewId: rec.id }) },
      })
    }
    return rec
  },
})

/** PRF-01 (R7) — normalize HR-recorded peer inputs. null = "leave the
 *  existing peers untouched" (absent key); [] clears them. */
function sanitizePeerInputs(raw: unknown): Array<{ name: string; ratings: Record<string, number>; comments?: string; recordedAt: string }> | null {
  if (raw === undefined || raw === null) return null
  if (!Array.isArray(raw)) throw new Deny("peerInputs must be an array", 400)
  const out: Array<{ name: string; ratings: Record<string, number>; comments?: string; recordedAt: string }> = []
  for (const peer of raw.slice(0, 10)) {
    if (!peer || typeof peer !== "object") throw new Deny("Each peer input must be an object", 400)
    const name = String((peer as any).name || "").trim().slice(0, 100)
    if (!name) throw new Deny("Each peer input needs a colleague name", 400)
    const ratings: Record<string, number> = {}
    for (const a of REVIEW_AREAS) {
      const v = (peer as any).ratings?.[a]
      if (v != null) ratings[a] = Math.max(1, Math.min(5, Number(v)))
    }
    out.push({ name, ratings, comments: String((peer as any).comments || "").slice(0, 1000) || undefined, recordedAt: new Date().toISOString() })
  }
  return out
}

// ---------- ESS-05 (R7) — employee review acknowledgment ----------
// The review loop closes: the employee sees the SUBMITTED review, records
// their own comments and acknowledges it (SUBMITTED → ACKNOWLEDGED). HR can
// then finalize. Previously ACKNOWLEDGED was dead vocabulary and
// "Employee Comments" was HR-authored — the process was one-directional.
// INTENTIONALLY_SELF_SCOPED (M-02 / ESS-05 R7): the employee acknowledges
// their OWN review only.
route("reviews.acknowledge", {
  handler: async (ctx, p) => {
    if (!ctx.employeeId) throw new Deny("Your account has no linked employee profile", 400)
    const rec = await db.performanceReview.findFirst({ where: { id: p.id, vendorId: ctx.vendorId, employeeId: ctx.employeeId } })
    if (!rec) throw new Deny("Review not found", 404)
    if (rec.status === "DRAFT") throw new Deny("This review is not ready for acknowledgment yet", 400)
    if (rec.status === "FINAL") throw new Deny("This review is already final", 400)
    const comments = p.comments !== undefined && p.comments !== null ? String(p.comments).slice(0, 2000) : rec.employeeComments
    await db.performanceReview.update({ where: { id: rec.id }, data: { status: "ACKNOWLEDGED", employeeComments: comments } })
    const emp = await db.employee.findUnique({ where: { id: rec.employeeId } })
    await audit(ctx, "reviews.acknowledge", "PerformanceReview", rec.id, `${emp?.fullName} acknowledged their review (${rec.overallRating}/5)${comments ? " with comments" : ""}`)
    // The reviewer + HR see the acknowledgment
    await notify(ctx.vendorId, { role: "HR_ADMIN" }, "Review Acknowledged",
      `${emp?.fullName} acknowledged their performance review (${rec.overallRating}/5). It can now be finalized.`, "SYSTEM", "performance")
    if (rec.reviewerId) {
      await notify(ctx.vendorId, { employeeId: rec.reviewerId }, "Review Acknowledged",
        `${emp?.fullName} acknowledged the review you submitted.`, "SYSTEM", "ess")
    }
    return { acknowledged: true }
  },
})

// ---------- PRF-01 (R7) — employee self-assessment ----------
// The employee rates THEMSELVES on the same nine areas and adds free-form
// comments before the manager finalizes. Stored in inputsJson.self — the
// manager's ratingsJson is never touched. Editable until FINAL.
// INTENTIONALLY_SELF_SCOPED (M-02 / PRF-01 R7): the employee rates
// THEMSELVES on their own review only.
route("ess.reviewSelf", {
  handler: async (ctx, p) => {
    if (!ctx.employeeId) throw new Deny("Your account has no linked employee profile", 400)
    const rec = await db.performanceReview.findFirst({ where: { id: p.id, vendorId: ctx.vendorId, employeeId: ctx.employeeId } })
    if (!rec) throw new Deny("Review not found", 404)
    if (rec.status === "FINAL") throw new Deny("This review is final — self-assessments are closed", 400)
    const ratings: Record<string, number> = {}
    for (const a of REVIEW_AREAS) {
      if (p.ratings?.[a] != null) ratings[a] = Math.max(1, Math.min(5, Number(p.ratings[a])))
    }
    if (!Object.keys(ratings).length && !p.comments) throw new Deny("Rate at least one area or add comments", 400)
    const prevInputs = j((rec as any).inputsJson, {}) as any
    const selfBlock = { ratings, comments: String(p.comments || "").slice(0, 2000) || undefined, submittedAt: new Date().toISOString() }
    await db.performanceReview.update({ where: { id: rec.id }, data: { inputsJson: JSON.stringify({ ...prevInputs, self: selfBlock }) } })
    const emp = await db.employee.findUnique({ where: { id: rec.employeeId } })
    await audit(ctx, "ess.reviewSelf", "PerformanceReview", rec.id, `${emp?.fullName} submitted a self-assessment (${Object.keys(ratings).length} area(s))`)
    await notify(ctx.vendorId, { role: "HR_ADMIN" }, "Self-Assessment Submitted",
      `${emp?.fullName} submitted their self-assessment for a performance review.`, "SYSTEM", "performance")
    return { ok: true }
  },
})

route("reviews.finalize", {
  perm: ["performance", "approve"],
  handler: async (ctx, p) => {
    const rec = await db.performanceReview.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!rec) throw new Deny("Not found", 404)
    if (rec.status === "FINAL") throw new Deny("Already finalized")
    await db.performanceReview.update({ where: { id: p.id }, data: { status: "FINAL" } })
    const emp = await db.employee.findUnique({ where: { id: rec.employeeId } })
    await audit(ctx, "reviews.finalize", "PerformanceReview", p.id, `Finalized review of ${emp?.fullName} (${rec.overallRating}/5)`)
    await notifyChannels(ctx.vendorId, { employeeId: rec.employeeId }, "Performance Review Finalized",
      `Your review has been finalized with an overall rating of ${rec.overallRating}/5.`, "SYSTEM", "ess",
      { email: true }, "performance_review",
      { reviewName: `Review — rating ${rec.overallRating}/5`, endDate: today() })
    return { finalized: true }
  },
})

// ---------- KPI ----------
route("kpiTemplates.list", {
  perm: ["kpi", "view"],
  handler: async (ctx) => {
    const templates = await db.kpiTemplate.findMany({ where: { vendorId: ctx.vendorId } })
    const desigs = await db.designation.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } })
    return templates.map((t) => ({
      ...t, items: j(t.itemsJson, []),
      designationName: desigs.find((d) => d.id === t.designationId)?.name,
    }))
  },
})
route("kpiTemplates.save", {
  perm: ["kpi", "create"],
  handler: async (ctx, p) => {
    const items = (p.items || []).map((i: any) => ({ name: i.name, target: Number(i.target), unit: i.unit || "", weight: Number(i.weight || 0) }))
    const totalWeight = items.reduce((s: number, i: any) => s + i.weight, 0)
    if (items.length && totalWeight !== 100) throw new Deny(`KPI weights must total 100% (currently ${totalWeight}%)`)
    if (p.id) {
      const rec = await db.kpiTemplate.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
      if (!rec) throw new Deny("Not found", 404)
      const updated = await db.kpiTemplate.update({ where: { id: p.id }, data: { name: p.name, designationId: p.designationId || null, itemsJson: JSON.stringify(items), active: p.active !== false } })
      await audit(ctx, "kpiTemplates.update", "KpiTemplate", p.id, `Updated KPI template ${p.name || rec.name}`, { oldValue: rec })
      return updated
    }
    const rec = await db.kpiTemplate.create({ data: { vendorId: ctx.vendorId, name: p.name, designationId: p.designationId || null, itemsJson: JSON.stringify(items) } })
    await audit(ctx, "kpiTemplates.create", "KpiTemplate", rec.id, `KPI template ${p.name} (${items.length} indicators)`)
    return rec
  },
})
route("kpiTemplates.delete", {
  perm: ["kpi", "create"],
  handler: async (ctx, p) => {
    const rec = await db.kpiTemplate.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!rec) throw new Deny("Not found", 404)
    const used = await db.kpiAssignment.count({ where: { vendorId: ctx.vendorId, templateId: p.id } })
    if (used > 0) throw new Deny("Template is assigned to employees")
    await db.kpiTemplate.delete({ where: { id: p.id } })
    return { deleted: true }
  },
})

route("kpiAssignments.list", {
  perm: ["kpi", "view"],
  handler: async (ctx, p) => {
    const where: any = { vendorId: ctx.vendorId }
    if (p?.employeeId) where.employeeId = p.employeeId
    if (p?.status) where.status = p.status
    const scope = employeeScopeFilter(ctx)
    if (!p?.employeeId) where.employeeId = { in: (await db.employee.findMany({ where: scope, select: { id: true } })).map((e) => e.id) }
    const list = await db.kpiAssignment.findMany({ where, orderBy: { createdAt: "desc" } })
    const employees = await db.employee.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, fullName: true } })
    const templates = await db.kpiTemplate.findMany({ where: { vendorId: ctx.vendorId } })
    return list.map((a) => ({
      ...a, results: j(a.resultsJson, []),
      employeeName: employees.find((e) => e.id === a.employeeId)?.fullName || "—",
      templateName: templates.find((t) => t.id === a.templateId)?.name,
    }))
  },
})

route("kpiAssignments.assign", {
  perm: ["kpi", "assign"],
  handler: async (ctx, p) => {
    const emp = await assertEmployeeVisible(ctx, p.employeeId)
    const template = await db.kpiTemplate.findFirst({ where: { id: p.templateId, vendorId: ctx.vendorId } })
    if (!template) throw new Deny("KPI template not found", 404)
    const items = j(template.itemsJson, [])
    const results = items.map((i: any) => ({ name: i.name, target: i.target, unit: i.unit, weight: i.weight, actual: null, achievementPct: null, score: null, rating: null }))
    const rec = await db.kpiAssignment.create({
      data: {
        vendorId: ctx.vendorId, employeeId: p.employeeId, templateId: template.id,
        periodLabel: p.periodLabel || String(new Date().getFullYear()), dueDate: p.dueDate || null,
        status: "PENDING", resultsJson: JSON.stringify(results),
      },
    })
    await audit(ctx, "kpiAssignments.assign", "KpiAssignment", rec.id, `Assigned KPI "${template.name}" to ${emp.fullName}`)
    await notify(ctx.vendorId, { employeeId: p.employeeId }, "KPI Assigned",
      `You have been assigned the KPI "${template.name}" for ${rec.periodLabel}.`, "SYSTEM", "ess")
    return rec
  },
})

route("kpiAssignments.submitResults", {
  perm: ["kpi", "edit"],
  handler: async (ctx, p) => {
    const rec = await db.kpiAssignment.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!rec) throw new Deny("Not found", 404)
    if (rec.status === "REVIEWED") throw new Deny("Already reviewed")
    const items = j(rec.resultsJson, [])
    const updated = items.map((i: any) => {
      const actual = p.results?.[i.name] != null ? Number(p.results[i.name]) : i.actual
      const achievementPct = actual != null && i.target ? Math.round((actual / i.target) * 1000) / 10 : null
      const score = achievementPct != null ? Math.round((achievementPct * i.weight) / 100) : null
      return { ...i, actual, achievementPct, score }
    })
    const totalScore = updated.reduce((s: number, i: any) => s + (i.score || 0), 0)
    const rating = totalScore >= 90 ? 5 : totalScore >= 75 ? 4 : totalScore >= 60 ? 3 : totalScore >= 40 ? 2 : 1
    await db.kpiAssignment.update({
      where: { id: rec.id },
      data: { resultsJson: JSON.stringify(updated.map((i: any) => ({ ...i, rating: i.score != null ? rating : null }))), status: p.status || "SUBMITTED" },
    })
    await audit(ctx, "kpiAssignments.submitResults", "KpiAssignment", rec.id, `Results submitted (score ${totalScore}, rating ${rating})`)
    return { ok: true, totalScore, rating }
  },
})

// ---------- Tasks ----------
  // INTENTIONALLY_SELF_SCOPED (M-02): returns tasks the caller created, is assigned, or can see by department scope
route("tasks.list", {
  handler: async (ctx, p) => {
    const where: any = { vendorId: ctx.vendorId }
    if (p?.status) where.status = p.status
    if (p?.assigneeId) where.assigneeId = p.assigneeId
    if (p?.mine && ctx.employeeId) where.assigneeId = ctx.employeeId
    if (p?.scope) where.scope = p.scope
    // Audit Low — perm gate: users WITHOUT tasks.view see only their own
    // assigned tasks; the previous version exposed every tenant task thread
    // to any authenticated account.
    if (ctx.role === "EMPLOYEE" || !ctx.permissions.has("tasks.view")) where.assigneeId = ctx.employeeId
    // MOD-16 (Phase 2 WS4) — optional pagination + page-scoped name joins
    const paged = p?.page != null || p?.pageSize != null
    const pageSize = Math.min(500, Math.max(1, Number(p?.pageSize) || 200))
    const page = Math.max(1, Number(p?.page) || 1)
    const [list, total] = paged
      ? await Promise.all([
<<<<<<< HEAD
          db.task.findMany({ where, orderBy: [{ status: "asc" }, { dueDate: "asc" }, { id: "asc" }], skip: (page - 1) * pageSize, take: pageSize }),
=======
          db.task.findMany({ where, orderBy: [{ status: "asc" }, { dueDate: "asc" }], skip: (page - 1) * pageSize, take: pageSize }),
>>>>>>> origin/main
          db.task.count({ where }),
        ])
      : [await db.task.findMany({ where, orderBy: [{ status: "asc" }, { dueDate: "asc" }] }), null]
    const pageIds = [...new Set(list.map((t) => t.assigneeId).filter((x): x is string => !!x))]
    const employees = pageIds.length
      ? await db.employee.findMany({ where: { vendorId: ctx.vendorId, id: { in: pageIds } }, select: { id: true, fullName: true } })
      : []
    const empById = new Map(employees.map((e) => [e.id, e.fullName]))
    const items = list.map((t) => ({
      ...t, checklist: j(t.checklistJson, []), comments: j(t.commentsJson, []),
      assigneeName: empById.get(t.assigneeId) || "—",
    }))
    return paged ? { items, total, page, pageSize } : items
  },
})

// INTENTIONALLY_SELF_SCOPED (M-02): R8 split trust — structural edits need tasks.create in-handler; assignees may update their OWN task's progress/checklist/comments.
route("tasks.save", {
  schema: S.taskSave,
  // R8 (2026-10-12) — NO static perm: the handler splits the two trust
  // levels. (a) CREATE / reassign / scope changes still need tasks.create;
  // (b) the ASSIGNEE may update their own task's status/progress/checklist/
  // comments (self-service — the old static [tasks, create] gate 403'd every
  // EMPLOYEE self-edit even for a bare { id, progress } tap). Managers
  // without tasks.create fall through to tasks.edit for field updates.
  handler: async (ctx, p) => {
    if (p.id) {
      const rec = await db.task.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
      if (!rec) throw new Deny("Not found", 404)
      const isAssignee = !!ctx.employeeId && rec.assigneeId === ctx.employeeId
      const canManage = ctx.permissions.has("tasks.create") || ctx.permissions.has("tasks.edit")
      // Fields an assignee may self-serve. Anything beyond this (title,
      // description, reassign, scope, priority, dates, department/branch)
      // is a managerial edit and needs tasks.edit OR tasks.create.
      const SELF_FIELDS = ["status", "progress", "checklist", "comments"]
      const managerial = Object.keys(p).some((k) => k !== "id" && !SELF_FIELDS.includes(k))
      // gate 1: nobody except the assignee (or a task manager) may touch the
      // task at all — a stranger with no permission gets a clean 403 even for
      // a bare { id, status } tap.
      if (!isAssignee && !canManage) {
        throw new Deny("You do not have permission to edit tasks")
      }
      // gate 2: an assignee WITHOUT manage rights may only change the
      // self-service fields — managerial keys are stripped (not hard-failed)
      // so a self-service { id, progress } tap from a full detail dialog
      // still lands.
      if (managerial && isAssignee && !canManage) {
        for (const k of Object.keys(p)) if (k !== "id" && !SELF_FIELDS.includes(k)) delete (p as any)[k]
      }
      const data: any = { ...p }
      delete data.id
      delete data.vendorId
      delete data.checklist // mapped to checklistJson below (not a Task column)
      delete data.comments // mapped to commentsJson below (not a Task column)
      // Partial updates ({ id, checklist } / { id, status, progress }) must
      // never blank out fields the caller did not send.
      if (data.title == null || data.title === "") delete data.title
      if (data.description == null || data.description === "") delete data.description
      if (data.assigneeId == null || data.assigneeId === "") delete data.assigneeId
      data.checklistJson = p.checklist ? JSON.stringify(p.checklist) : rec.checklistJson
      data.commentsJson = p.comments ? JSON.stringify(p.comments) : rec.commentsJson
      const updated = await db.task.update({ where: { id: p.id }, data })
      await audit(ctx, isAssignee && !managerial ? "tasks.self-update" : "tasks.update", "Task", p.id, `Updated task "${p.title || rec.title}" (${p.status || rec.status})${isAssignee && !managerial ? " by assignee" : ""}`)
      if (p.status && p.status !== rec.status && p.status === "COMPLETED") {
        await notify(ctx.vendorId, { userId: ctx.userId }, "Task Completed", `"${rec.title}" marked completed.`, "TASK")
      }
      return updated
    }
    // Create: title + assignee are genuinely required (clean 400s, not Prisma errors)
    if (!ctx.permissions.has("tasks.create")) throw new Deny("You do not have permission to create tasks")
    if (!p.title || !String(p.title).trim()) throw new Deny("Title is required", 400)
    if (!p.assigneeId) throw new Deny("Assignee is required", 400)
    const emp = await db.employee.findFirst({ where: { id: p.assigneeId, vendorId: ctx.vendorId } })
    if (!emp) throw new Deny("Assignee not found", 404)
    const rec = await db.task.create({
      data: {
        vendorId: ctx.vendorId, title: p.title, description: p.description || null,
        assigneeId: p.assigneeId, departmentId: p.departmentId || emp.departmentId, branchId: p.branchId || emp.branchId,
        scope: p.scope || "EMPLOYEE", priority: p.priority || "MEDIUM",
        startDate: p.startDate || today(), dueDate: p.dueDate || null,
        checklistJson: JSON.stringify(p.checklist || []), commentsJson: "[]", createdBy: ctx.userId,
      },
    })
    await audit(ctx, "tasks.create", "Task", rec.id, `Created task "${p.title}" for ${emp.fullName}`)
    await notify(ctx.vendorId, { employeeId: p.assigneeId }, "New Task Assigned",
      `"${p.title}" (${p.priority || "MEDIUM"} priority)${p.dueDate ? " due " + p.dueDate : ""}.`, "TASK", "ess")
    return rec
  },
})

  // INTENTIONALLY_SELF_SCOPED (M-02): handler validates the caller can see the task before commenting
route("tasks.comment", {
  handler: async (ctx, p) => {
    const rec = await db.task.findFirst({ where: { id: p.taskId, vendorId: ctx.vendorId } })
    if (!rec) throw new Deny("Not found", 404)
    // Audit Low — comment rights: the assignee, or a user holding tasks.edit
    const isAssignee = !!ctx.employeeId && rec.assigneeId === ctx.employeeId
    if (!isAssignee && !ctx.permissions.has("tasks.edit")) {
      throw new Deny("Only the assignee or a task editor can comment on this task")
    }
    if (!p.text || !String(p.text).trim()) throw new Deny("Comment text is required", 400)
    const comments: any[] = j(rec.commentsJson, [])
    comments.push({ userId: ctx.userId, userName: ctx.userName, text: String(p.text).trim().slice(0, 1000), at: new Date().toISOString() })
    await db.task.update({ where: { id: rec.id }, data: { commentsJson: JSON.stringify(comments) } })
    if (rec.assigneeId && rec.assigneeId !== ctx.employeeId) {
      await notify(ctx.vendorId, { employeeId: rec.assigneeId }, "Task Comment",
        `${ctx.userName} commented on "${rec.title}".`, "TASK", "ess")
    }
    return { ok: true }
  },
})

route("tasks.delete", {
  perm: ["tasks", "delete"],
  handler: async (ctx, p) => {
    const rec = await db.task.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!rec) throw new Deny("Not found", 404)
    await db.task.delete({ where: { id: p.id } })
    await audit(ctx, "tasks.delete", "Task", p.id, `Deleted task "${rec.title}"`)
    return { deleted: true }
  },
})
