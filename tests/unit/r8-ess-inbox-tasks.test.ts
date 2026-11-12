/// <reference types="bun-types" />
// ============ R8 regression: ESS self-service task updates + inbox ============
// Audit (2026-10-12): tasks.save required [tasks, create] — a permission NO
// EMPLOYEE role template carries — so every self-service edit of one's OWN
// task (status/progress/checklist taps in My Tasks) 403'd. Fix: the route
// splits trust levels server-side:
//   · assignee → may update own task's status/progress/checklist/comments
//   · managerial fields (reassign, scope, priority, dates) → tasks.edit/create
//   · creating tasks → tasks.create
// The ESS portal also gained a data-driven Inbox tab (notifications.list /
// notifications.read, self-scoped) — the API contract is regression-tested
// here so the tab can never silently regress to static data.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkSession, mkEmployee, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"

let vendor: { id: string }
let admin: { id: string; token: string }
let empUser: { id: string; token: string; employeeId: string }
let otherEmp: { id: string; employeeId: string }
let taskId: string

beforeAll(async () => {
  vendor = await mkVendor("R8 Vendor")
  const u = await mkUser(vendor.id, { role: "HR_ADMIN", name: "R8 Admin" })
  admin = { id: u.id, token: await mkSession(u.id, "FULL") }

  const emp = await mkEmployee(vendor.id, { fullName: "R8 Field Staff" })
  const eu = await mkUser(vendor.id, { role: "EMPLOYEE", name: "R8 Field Staff", email: `r8-emp-${uniq()}@test.example`, employeeId: emp.id })
  empUser = { id: eu.id, token: await mkSession(eu.id, "FULL"), employeeId: emp.id }

  const emp2 = await mkEmployee(vendor.id, { fullName: "R8 Other Staff" })
  otherEmp = { id: emp2.id, employeeId: emp2.id }

  // manager creates a task assigned to the employee
  const res = await postHrm("tasks.save", {
    title: "R8 Site inspection", description: "Visit the client site", assigneeId: emp.id, priority: "HIGH",
  }, { bearer: admin.token })
  if (res.body.ok) taskId = res.body.data.id
  else throw new Error("fixture task creation failed: " + JSON.stringify(res.body).slice(0, 200))
})

describe("R8 — ESS self-service task updates", () => {
  test("EMPLOYEE assignee can update own task progress/status (previously 403)", async () => {
    const res = await postHrm("tasks.save", { id: taskId, status: "IN_PROGRESS", progress: 40 }, { bearer: empUser.token })
    expect(res.body.ok).toBe(true)
    const rec = await db.task.findUnique({ where: { id: taskId } })
    expect(rec?.status).toBe("IN_PROGRESS")
    expect(rec?.progress).toBe(40)
  })

  test("assignee can complete the checklist on their own task", async () => {
    const res = await postHrm("tasks.save", {
      id: taskId, checklist: [{ text: "Photos taken", done: true }, { text: "Report filed", done: false }],
    }, { bearer: empUser.token })
    expect(res.body.ok).toBe(true)
    const rec = await db.task.findUnique({ where: { id: taskId } })
    const list = JSON.parse(rec?.checklistJson || "[]")
    expect(list).toHaveLength(2)
    expect(list[0].done).toBe(true)
  })

  test("EMPLOYEE cannot CREATE tasks (no tasks.create in the role)", async () => {
    const res = await postHrm("tasks.save", { title: "Sneaky task", assigneeId: empUser.employeeId }, { bearer: empUser.token })
    expect(res.body.ok).toBe(false)
    expect(String(res.body.error)).toMatch(/permission to create tasks/i)
  })

  test("EMPLOYEE managerial fields are stripped, not applied (reassign silently ignored)", async () => {
    const res = await postHrm("tasks.save", {
      id: taskId, progress: 80, assigneeId: otherEmp.employeeId, priority: "LOW",
    }, { bearer: empUser.token })
    expect(res.body.ok).toBe(true)
    const rec = await db.task.findUnique({ where: { id: taskId } })
    // self-service part applied…
    expect(rec?.progress).toBe(80)
    // …managerial part NOT applied (no tasks.edit/create permission)
    expect(rec?.assigneeId).toBe(empUser.employeeId)
    expect(rec?.priority).toBe("HIGH")
  })

  test("unrelated employee (not the assignee) cannot edit the task", async () => {
    const stranger = await mkUser(vendor.id, { role: "EMPLOYEE", email: `r8-stranger-${uniq()}@test.example`, employeeId: otherEmp.employeeId })
    const token = await mkSession(stranger.id, "FULL")
    const res = await postHrm("tasks.save", { id: taskId, status: "ON_HOLD" }, { bearer: token })
    expect(res.body.ok).toBe(false)
    expect(String(res.body.error)).toMatch(/permission to edit tasks/i)
  })
})

describe("R8 — ESS inbox API contract (data-driven notifications)", () => {
  test("notifications.list returns only the caller's own notifications", async () => {
    // seed two notifications for the employee + one for a manager
    const { notify } = await import("@/hrm-server/audit")
    await notify(vendor.id, { employeeId: empUser.employeeId }, "Leave approved", "Your casual leave was approved.", "LEAVE", "ess")
    await notify(vendor.id, { userId: admin.id }, "Manager notice", "Payroll draft ready.", "PAYROLL", "payroll")

    const res = await postHrm("notifications.list", {}, { bearer: empUser.token })
    expect(res.body.ok).toBe(true)
    const list = res.body.data as any[]
    expect(list.length).toBeGreaterThanOrEqual(1)
    expect(list.some((n) => n.title === "Leave approved")).toBe(true)
    expect(list.some((n) => n.title === "Manager notice")).toBe(false) // never another user's row

    const unread = list.filter((n) => !n.readAt)
    expect(unread.length).toBeGreaterThanOrEqual(1)
  })

  test("notifications.read marks own notification read (and only own)", async () => {
    const { notify } = await import("@/hrm-server/audit")
    await notify(vendor.id, { employeeId: empUser.employeeId }, "Loan update", "Your loan was approved.", "LOAN", "ess")
    const before = (await postHrm("notifications.list", {}, { bearer: empUser.token })).body.data as any[]
    const target = before.find((n) => n.title === "Loan update")
    expect(target).toBeTruthy()
    expect(target.readAt).toBeNull()

    const res = await postHrm("notifications.read", { id: target.id }, { bearer: empUser.token })
    expect(res.body.ok).toBe(true)

    const after = (await postHrm("notifications.list", {}, { bearer: empUser.token })).body.data as any[]
    expect(after.find((n) => n.id === target.id)?.readAt).toBeTruthy()
  })

  test("notifications.read cannot ack another user's notification", async () => {
    const { notify } = await import("@/hrm-server/audit")
    await notify(vendor.id, { userId: admin.id }, "Admin private", "For the manager only.", "SYSTEM")
    const adminNotif = (await postHrm("notifications.list", {}, { bearer: admin.token })).body.data.find((n: any) => n.title === "Admin private")
    // the employee tries to ack the admin's notification
    const res = await postHrm("notifications.read", { id: adminNotif.id }, { bearer: empUser.token })
    expect(res.body.ok).toBe(true) // idempotent no-op — but the row must stay unread
    const still = (await postHrm("notifications.list", {}, { bearer: admin.token })).body.data.find((n: any) => n.id === adminNotif.id)
    expect(still.readAt).toBeNull()
  })

  test("unreadCount reflects the caller's unread rows", async () => {
    const res = await postHrm("notifications.unreadCount", {}, { bearer: empUser.token })
    expect(res.body.ok).toBe(true)
    expect(Number(res.body.data.count)).toBeGreaterThanOrEqual(1)
  })
})
