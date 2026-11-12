// ============ Global Search routes (employees + tasks) ============
// Additive feature — serves the navbar command palette's live section.
// Security model (identical to the rest of the HRM):
//   - session/tenant resolved by the central dispatcher (ctx.vendorId is NEVER client-supplied)
//   - employees: only for holders of employees.view, always through employeeScopeFilter()
//     (tenant + branch/dept manager visibility) — the exact scope as employees.list
//   - FIN-023 (Phase 2): employee results pass through the SAME callerFieldAccess
//     contact projection as employees.list — masked/hidden roles get masked or
//     absent phones+emails here too, and the contact fields leave the MATCH SET
//     (searching by a raw phone/email must not bypass the field-permission layer)
//   - tasks: the exact visibility rule of tasks.list — users without tasks.view
//     (and EMPLOYEE-role users) only ever see tasks assigned to THEMSELVES
//   - returns the minimum fields needed for a result row; no salary, address,
//     DOB, national ID or other sensitive biodata leaves the server
import { db } from "@/lib/db"
import { route } from "./registry"
import { employeeScopeFilter } from "../rbac"
import { normalizeQuery, MIN_QUERY, rankByRelevance } from "../search-rank"
import { callerFieldAccess, maskContactValue } from "../field-permissions"
import { getSettings } from "../settings"

const EMPLOYEE_LIMIT = 7
const TASK_LIMIT = 7
const FETCH_POOL = 30 // over-fetch, rank in memory, then cap (avoids ranking the whole table)

  // INTENTIONALLY_SELF_SCOPED (M-02): global search: results are permission-filtered per module inside the handler
route("search.global", {
  handler: async (ctx, p) => {
    const q = normalizeQuery(p?.q)
    if (q.length < MIN_QUERY) return { employees: [], tasks: [] }

    // ---------- Employees (permission + tenant/branch/dept scoped) ----------
    let employees: any[] = []
    if (ctx.permissions.has("employees.view")) {
      // FIN-023 (Phase 2) — the same contact-field projection as employees.list.
      // "full" keeps raw values AND match-by-contact; "mask"/"none" remove the
      // contact columns from both the MATCH SET and the result row (a masked
      // role must not be able to probe phone numbers digit by digit through
      // the command palette — the directory already enforces this layer).
      const contactAccess = callerFieldAccess(await getSettings(ctx.vendorId), ctx.role).contact
      const contactSearchable = contactAccess === "full"
      const where: { vendorId?: string; branchId?: string; OR: any[] } = {
        ...employeeScopeFilter(ctx),
        OR: [
          // mode:"insensitive" (ILIKE) — preserves SQLite's case-insensitive LIKE
          // behavior for user-facing search after the PostgreSQL migration.
          { code: { contains: q, mode: "insensitive" as const } },
          { fullName: { contains: q, mode: "insensitive" as const } },
          { preferredName: { contains: q, mode: "insensitive" as const } },
          ...(contactSearchable ? [
            { mobile: { contains: q, mode: "insensitive" as const } },
            { personalEmail: { contains: q, mode: "insensitive" as const } },
            { officialEmail: { contains: q, mode: "insensitive" as const } },
          ] : []),
        ],
      }
      const rows = await db.employee.findMany({
        where,
        take: FETCH_POOL,
        select: {
          id: true, code: true, fullName: true, preferredName: true, mobile: true,
          personalEmail: true, officialEmail: true, designationId: true, departmentId: true, branchId: true,
        },
      })
      const ranked = rankByRelevance(
        q.toLowerCase(),
        rows,
        (e) => [
          { text: e.code, boost: 5 }, // ID match is the strongest intent signal
          { text: e.fullName },
          { text: e.preferredName },
          ...(contactSearchable ? [
            { text: e.mobile },
            { text: e.officialEmail },
            { text: e.personalEmail },
          ] : []),
        ],
        (e) => e.fullName || e.code,
        EMPLOYEE_LIMIT,
      )
      // decorate with org names in three constant queries (no N+1)
      const ids = {
        designation: [...new Set(ranked.map((e) => e.designationId).filter(Boolean))] as string[],
        department: [...new Set(ranked.map((e) => e.departmentId).filter(Boolean))] as string[],
        branch: [...new Set(ranked.map((e) => e.branchId).filter(Boolean))] as string[],
      }
      // MULTI-COMPANY — org-name decoration resolves inside the ACTIVE company
      // (the All Companies reporting context keeps the tenant scope).
      const [desigs, depts, branches] = await Promise.all([
        ids.designation.length ? db.designation.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}), id: { in: ids.designation } }, select: { id: true, name: true } }) : [],
        ids.department.length ? db.department.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}), id: { in: ids.department } }, select: { id: true, name: true } }) : [],
        ids.branch.length ? db.branch.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}), id: { in: ids.branch } }, select: { id: true, name: true } }) : [],
      ])
      employees = ranked.map((e) => ({
        id: e.id,
        code: e.code,
        fullName: e.fullName,
        // FIN-023 — contact fields follow the caller's field-permission layer:
        // none → null, mask → the same maskContactValue shape employees.list shows
        mobile: contactAccess === "none" ? null : contactAccess === "mask" ? maskContactValue(e.mobile) : e.mobile,
        email: contactAccess === "none"
          ? null
          : contactAccess === "mask"
            ? maskContactValue(e.officialEmail || e.personalEmail || null)
            : (e.officialEmail || e.personalEmail || null),
        designationName: desigs.find((d) => d.id === e.designationId)?.name || null,
        departmentName: depts.find((d) => d.id === e.departmentId)?.name || null,
        branchName: branches.find((b) => b.id === e.branchId)?.name || null,
      }))
    }

    // ---------- Tasks (tasks.list visibility model) ----------
    const taskWhere: any = { vendorId: ctx.vendorId }
    // MULTI-COMPANY — tasks of OTHER companies never surface in search (null
    // companyId = tenant-wide rows stay visible — the holidays/announcements semantics).
    if (ctx.activeCompanyId && !ctx.allCompaniesMode) {
      taskWhere.AND = [{ OR: [{ companyId: ctx.activeCompanyId }, { companyId: null }] }]
    }
    // users WITHOUT tasks.view see only their own assigned tasks — never the tenant-wide thread
    if (ctx.role === "EMPLOYEE" || !ctx.permissions.has("tasks.view")) {
      taskWhere.assigneeId = ctx.employeeId || "__no_match__"
    }
    // searching by assignee name: resolve matching employee ids first (vendor-scoped)
    // MULTI-COMPANY — assignee-name resolution stays inside the active company
    const assigneeMatches = await db.employee.findMany({
      where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}), fullName: { contains: q, mode: "insensitive" } },
      select: { id: true, fullName: true },
      take: FETCH_POOL,
    })
    taskWhere.OR = [
      { title: { contains: q, mode: "insensitive" as const } },
      { description: { contains: q, mode: "insensitive" as const } },
      { id: { contains: q, mode: "insensitive" as const } },
      { assigneeId: { in: assigneeMatches.map((a) => a.id) } },
    ]
    const taskRows = await db.task.findMany({
      where: taskWhere,
      take: FETCH_POOL,
      select: { id: true, title: true, description: true, status: true, priority: true, dueDate: true, assigneeId: true },
    })
    // resolve assignee names BEFORE ranking — a task can be a hit through its
    // assignee's name alone, so the name must be a ranking field (not just a
    // decoration applied after the cut, which would drop those hits)
    const assigneeIds = [...new Set(taskRows.map((t) => t.assigneeId).filter(Boolean))]
    // MULTI-COMPANY — assignee names of other companies' employees never render
    const assignees = assigneeIds.length
      ? await db.employee.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}), id: { in: assigneeIds } }, select: { id: true, fullName: true } })
      : []
    const nameOf = (id: string | null | undefined) => assignees.find((a) => a.id === id)?.fullName || null
    const tasks = rankByRelevance(
      q.toLowerCase(),
      taskRows,
      (t) => [{ text: t.title }, { text: nameOf(t.assigneeId) }],
      (t) => t.title,
      TASK_LIMIT,
    ).map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      dueDate: t.dueDate,
      assigneeName: nameOf(t.assigneeId),
    }))

    return { employees, tasks }
  },
})
