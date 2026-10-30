// Phase 2 WS4 — employee/leave/approval scale fixes.
// FE-1 employees.refList · FE-3 employees.statusCounts + decorate fix ·
// MOD-3 approvals.queue batching · MOD-4 substitute batch ·
// MOD-16 pagination sweep · MOD-17 trigram index.
import "./_testdb"
import { describe, expect, test } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, makeCtx, uniq } from "./_fixtures"
import { getRoute } from "@/hrm-server/routes/router"

describe("FE-1 employees.refList — lightweight picker directory", () => {
<<<<<<< HEAD
  // T-10 (2026-10-30): the picker directory intentionally gained `status`
  // (R6/R7 pickers filter by employment status — inventory.tsx:736,
  // fieldforce.tsx:142, loans.tsx:156, leave.tsx:268 read e.status off the
  // cached useEmployeeDirectory rows). The key pin below was widened to
  // match the live contract; the sensitive-field exclusions still hold.
  test("returns id/code/fullName/status only, ordered, with total + truncated flag", async () => {
=======
  test("returns id/code/fullName only, ordered, with total + truncated flag", async () => {
>>>>>>> origin/main
    const v = await mkVendor()
    await mkEmployee(v.id, { fullName: "Ref Alpha" })
    await mkEmployee(v.id, { fullName: "Ref Beta" })
    const owner = await mkUser(v.id, { role: "VENDOR_OWNER" })
    const res: any = await getRoute("employees.refList")!.handler(makeCtx(owner), {})
    expect(res.total).toBeGreaterThanOrEqual(2)
    expect(res.truncated).toBe(false)
    const row = res.refs.find((r: any) => r.fullName === "Ref Alpha")
    expect(row).toBeTruthy()
<<<<<<< HEAD
    expect(Object.keys(row!).sort()).toEqual(["code", "fullName", "id", "status"])
=======
    expect(Object.keys(row!).sort()).toEqual(["code", "fullName", "id"])
>>>>>>> origin/main
    // no photo/contact columns ever leave the server
    expect((row as any).photoUrl).toBeUndefined()
    expect((row as any).mobile).toBeUndefined()
  })

  test("q search matches name and code case-insensitively", async () => {
    const v = await mkVendor()
    await mkEmployee(v.id, { fullName: uniq("Zqx") + " Searchable" })
    const owner = await mkUser(v.id, { role: "VENDOR_OWNER" })
    const res: any = await getRoute("employees.refList")!.handler(makeCtx(owner), { q: "zqx" })
    expect(res.refs.length).toBe(1)
  })
})

describe("FE-3 employees.statusCounts + decorate", () => {
  test("one groupBy returns every status count under the same filters", async () => {
    const v = await mkVendor()
    for (const [st, name] of [["ACTIVE", "A1"], ["ACTIVE", "A2"], ["PROBATION", "P1"], ["RESIGNED", "R1"]] as const) {
      await db.employee.create({ data: { vendorId: v.id, code: uniq(st), fullName: name, joiningDate: "2024-01-01", employmentType: "PERMANENT", status: st } })
    }
    const owner = await mkUser(v.id, { role: "VENDOR_OWNER" })
    const res: any = await getRoute("employees.statusCounts")!.handler(makeCtx(owner), {})
    expect(res.total).toBeGreaterThanOrEqual(4)
    expect(res.counts.ACTIVE).toBeGreaterThanOrEqual(2)
    expect(res.counts.PROBATION).toBeGreaterThanOrEqual(1)
    expect(res.counts.RESIGNED).toBeGreaterThanOrEqual(1)
  })

  test("decorate resolves manager names via the page-scoped lookup", async () => {
    const v = await mkVendor()
    const mgr = await mkEmployee(v.id, { fullName: "The Manager" })
    await mkEmployee(v.id, { fullName: "Reports To Manager" })
    // set reportingManagerId on the report
    const report = await db.employee.findFirst({ where: { vendorId: v.id, fullName: "Reports To Manager" } })
    await db.employee.update({ where: { id: report!.id }, data: { reportingManagerId: mgr.id } })
    const owner = await mkUser(v.id, { role: "VENDOR_OWNER" })
    const res: any = await getRoute("employees.list")!.handler(makeCtx(owner), { q: "Reports To Manager" })
    expect(res.length).toBe(1)
    expect(res[0].managerName).toBe("The Manager")
  })
})

describe("MOD-3 approvals.queue — set-based step/action prefetch", () => {
  test("queue output shape preserved (steps, actions, canAct) after batching", async () => {
    const v = await mkVendor()
    const owner = await mkUser(v.id, { role: "VENDOR_OWNER" })
    // a leave-type approval request via the engine's own submit path
    const wf = await db.approvalWorkflow.create({
      data: { vendorId: v.id, processType: "LEAVE", name: "Leave WF", active: true },
    })
    await db.approvalStep.create({
      data: { vendorId: wf.vendorId, workflowId: wf.id, sequence: 1, name: "HR", approverRole: "HR_ADMIN" },
    })
    const emp = await mkEmployee(v.id, { fullName: "Queue Emp" })
    await db.approvalRequest.create({
      data: {
        vendorId: v.id, workflowId: wf.id, processType: "LEAVE", entityType: "LeaveRequest",
        entityId: "x", entityRef: "LV-1", requestedBy: owner.id, currentStep: 1, status: "PENDING",
        payloadJson: JSON.stringify({ amount: 100 }),
      },
    })
    await db.approvalAction.create({
      data: { vendorId: v.id, requestId: (await db.approvalRequest.findFirst({ where: { vendorId: v.id } }))!.id, step: 1, userId: owner.id, userName: "Owner", action: "SUBMIT", comment: "submitted", createdAt: new Date() },
    })
    const res: any = await getRoute("approvals.queue")!.handler(makeCtx(owner), { status: "PENDING" })
    const leaveRows = res.filter((r: any) => r.processType === "LEAVE")
    expect(leaveRows.length).toBe(1)
    expect(leaveRows[0].stepName).toBe("HR")
    expect(leaveRows[0].approverRoleLabel).toBeTruthy()
    expect(leaveRows[0].actions.length).toBe(1)
    expect(leaveRows[0].actions[0].action).toBe("SUBMIT")
    expect(typeof leaveRows[0].canAct).toBe("boolean")
    expect(leaveRows[0].payload.amount).toBe(100)
    void emp
  })
})

describe("MOD-4 leaveRequests.substituteOptions — batched eligibility", () => {
  test("identical eligibility outputs: blockers (on leave / scheduled off) + notes (branch/dept/grade)", async () => {
    const v = await mkVendor()
    const owner = await mkUser(v.id, { role: "VENDOR_OWNER" })
    const requester = await mkEmployee(v.id, { fullName: "Sub Requester" })
    const fine = await mkEmployee(v.id, { fullName: "Sub Fine" })
    const away = await mkEmployee(v.id, { fullName: "Sub Away" })
    // pick a 3-day window that contains NO weekly-off day (the vendor's
    // default weekly holiday would otherwise disqualify every candidate —
    // correctly, per the same rule the original checkSubstitute applies)
    const { getSettings } = await import("@/hrm-server/settings")
    const { resolveWeeklyOffDays } = await import("@/hrm-server/utils")
    const st = await getSettings(v.id)
    const wd = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"]
    let fromDate = ""
    for (let offset = 7; offset < 40 && !fromDate; offset++) {
      const d0 = new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10)
      const d1 = new Date(Date.now() + (offset + 1) * 86400000).toISOString().slice(0, 10)
      const d2 = new Date(Date.now() + (offset + 2) * 86400000).toISOString().slice(0, 10)
      const dows = [d0, d1, d2].map((x) => wd[new Date(`${x}T00:00:00Z`).getUTCDay()])
      const offs = resolveWeeklyOffDays(null, null, st.general.weeklyHoliday)
      if (!dows.some((x) => offs.includes(x))) fromDate = d0
    }
    const toDate = new Date(new Date(`${fromDate}T00:00:00Z`).getTime() + 2 * 86400000).toISOString().slice(0, 10)
    // 'away' has an approved overlapping leave
    await db.leaveRequest.create({
      data: { vendorId: v.id, employeeId: away.id, leaveTypeId: "lt", fromDate, toDate, days: 3, status: "APPROVED", reason: "overlap" },
    })
    const res: any = await getRoute("leaveRequests.substituteOptions")!.handler(
      makeCtx(owner), { employeeId: requester.id, fromDate, toDate },
    )
    const fineRow = res.find((r: any) => r.fullName === "Sub Fine")
    const awayRow = res.find((r: any) => r.fullName === "Sub Away")
    expect(fineRow?.eligible).toBe(true)
    expect(fineRow?.reason).toBe("eligible")
    expect(awayRow?.eligible).toBe(false)
    expect(awayRow?.reason).toContain("already on leave")
    // eligibleOnly filter
    const only: any = await getRoute("leaveRequests.substituteOptions")!.handler(
      makeCtx(owner), { employeeId: requester.id, fromDate, toDate, eligibleOnly: true },
    )
    expect(only.every((r: any) => r.eligible)).toBe(true)
    expect(only.find((r: any) => r.fullName === "Sub Away")).toBeUndefined()
  })
})

describe("MOD-16 pagination sweep — paged mode everywhere, legacy arrays intact", () => {
  test("leaveRequests.list: paged {items,total} + legacy array", async () => {
    const v = await mkVendor()
    const owner = await mkUser(v.id, { role: "VENDOR_OWNER" })
    const emp = await mkEmployee(v.id, { fullName: "LR Emp" })
    for (let i = 0; i < 3; i++) {
      await db.leaveRequest.create({
        data: { vendorId: v.id, employeeId: emp.id, leaveTypeId: "lt", fromDate: `2026-01-0${i + 1}`, toDate: `2026-01-0${i + 1}`, days: 1, status: "PENDING", reason: `r${i}` },
      })
    }
    const ctx = makeCtx(owner)
    const legacy: any = await getRoute("leaveRequests.list")!.handler(ctx, {})
    expect(Array.isArray(legacy)).toBe(true)
    expect(legacy.length).toBeGreaterThanOrEqual(3)
    expect(legacy[0].employeeName).toBeTruthy()

    const p1: any = await getRoute("leaveRequests.list")!.handler(ctx, { page: 1, pageSize: 2 })
    expect(p1.items.length).toBe(2)
    expect(p1.total).toBeGreaterThanOrEqual(3)
    expect(p1.items[0].employeeName).toBeTruthy()
    const p2: any = await getRoute("leaveRequests.list")!.handler(ctx, { page: 2, pageSize: 2 })
    expect(p2.items.length + p1.items.length).toBe(p1.total)
  })

  test("letters.list / reviews.list / tasks.list paged mode returns totals", async () => {
    const v = await mkVendor()
    const owner = await mkUser(v.id, { role: "VENDOR_OWNER" })
    const ctx = makeCtx(owner)
    const letters: any = await getRoute("letters.list")!.handler(ctx, { page: 1, pageSize: 10 })
    expect(letters).toHaveProperty("items")
    expect(letters).toHaveProperty("total")
    const reviews: any = await getRoute("reviews.list")!.handler(ctx, { page: 1, pageSize: 10 })
    expect(reviews).toHaveProperty("items")
    expect(reviews).toHaveProperty("total")
    const tasks: any = await getRoute("tasks.list")!.handler(ctx, { page: 1, pageSize: 10 })
    expect(tasks).toHaveProperty("items")
    expect(tasks).toHaveProperty("total")
  })
})
