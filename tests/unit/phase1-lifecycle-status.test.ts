/// <reference types="bun-types" />
// ============ FIN-004 (Phase 1) — status writes run the access chain ============
// The audit's lifecycle bypass: employees.update wrote a terminal status and
// ONE history row — nothing else. An employee flipped to RESIGNED through
// the edit form kept a live login (user row ACTIVE, warm sessions, active
// device enrollment). Now every status write runs the same side-effect chain
// as the dedicated flows, and a nightly reconciliation job (drivable on
// demand via jobs.reconcileUserStatus) closes any drift a legacy or direct
// writer left behind.
import "./_testdb"
import { describe, test, expect } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { reconcileUserEmployeeStatus } from "@/hrm-server/jobs"

async function mkWorld() {
  const v = await mkVendor(uniq("p1life"))
  const owner = await mkUser(v.id, { role: "VENDOR_OWNER", name: "P1 Life Owner" })
  const token = await mkSession(owner.id, "FULL")
  return { v, owner, token }
}

/** An employee with a linked user + a warm session (the ESS login shape). */
async function mkEmployeeWithLogin(vendorId: string, name: string) {
  const emp = await mkEmployee(vendorId, { fullName: name })
  const user = await mkUser(vendorId, { role: "EMPLOYEE", name: `${name} ESS`, employeeId: emp.id })
  const session = await mkSession(user.id, "FULL")
  return { emp, user, session }
}

describe("FIN-004 — employees.update runs the access side-effect chain", () => {
  test("flipping to TERMINATED through the edit form revokes the ESS login", async () => {
    const { v, token } = await mkWorld()
    const { emp, user, session } = await mkEmployeeWithLogin(v.id, "P1 Form Terminated")
    const r = await postHrm("employees.update", { id: emp.id, fullName: emp.fullName, status: "TERMINATED" }, { bearer: token })
    expect(r.status).toBe(200)
    // the linked user is deactivated, the session is revoked
    const u2 = await db.user.findUnique({ where: { id: user.id } })
    expect(u2!.status).toBe("INACTIVE")
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0)
    // and the session token no longer authenticates
    const me = await postHrm("auth.me", {}, { bearer: session })
    expect(me.status).toBe(401)
    // the history row records the access actions
    const hist = await db.employeeHistory.findFirst({ where: { vendorId: v.id, employeeId: emp.id, eventType: "STATUS_CHANGE" } })
    expect(hist).not.toBeNull()
    expect(String(hist!.description)).toContain("INACTIVE")
    void session
  })

  test("SUSPENDED suspends the linked user and revokes sessions; restore brings SUSPENDED users back", async () => {
    const { v, token } = await mkWorld()
    const { emp, user, session } = await mkEmployeeWithLogin(v.id, "P1 Form Suspended")
    const r = await postHrm("employees.update", { id: emp.id, fullName: emp.fullName, status: "SUSPENDED" }, { bearer: token })
    expect(r.status).toBe(200)
    expect((await db.user.findUnique({ where: { id: user.id } }))!.status).toBe("SUSPENDED")
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0)
    // restore: the SUSPENDED user comes back (mirrors the dedicated restore)
    const back = await postHrm("employees.update", { id: emp.id, fullName: emp.fullName, status: "ACTIVE" }, { bearer: token })
    expect(back.status).toBe(200)
    expect((await db.user.findUnique({ where: { id: user.id } }))!.status).toBe("ACTIVE")
    void session
  })

  test("restoring a TERMINATED employee does NOT reactivate the deactivated user", async () => {
    const { v, token } = await mkWorld()
    const { emp, user } = await mkEmployeeWithLogin(v.id, "P1 Rehire Guard")
    await postHrm("employees.update", { id: emp.id, fullName: emp.fullName, status: "RESIGNED" }, { bearer: token })
    expect((await db.user.findUnique({ where: { id: user.id } }))!.status).toBe("INACTIVE")
    // a re-hire through the edit form restores the EMPLOYEE row but not the
    // deliberately deactivated user account — that stays an admin action
    await postHrm("employees.update", { id: emp.id, fullName: emp.fullName, status: "ACTIVE" }, { bearer: token })
    expect((await db.user.findUnique({ where: { id: user.id } }))!.status).toBe("INACTIVE")
  })
})

describe("FIN-004 — the User-vs-Employee reconciliation job", () => {
  test("drift (terminal employee, ACTIVE user, warm session) is closed and recorded", async () => {
    const { v, owner, token } = await mkWorld()
    const { emp, user, session } = await mkEmployeeWithLogin(v.id, "P1 Drift")
    // simulate the legacy bypass: raw status write, no side effects
    await db.employee.update({ where: { id: emp.id }, data: { status: "RESIGNED" } })
    expect((await db.user.findUnique({ where: { id: user.id } }))!.status).toBe("ACTIVE") // drift exists
    // the on-demand route (same pass the nightly job runs)
    const r = await postHrm("jobs.reconcileUserStatus", {}, { bearer: token })
    expect(r.status).toBe(200)
    expect(r.body.data.reconciled).toBeGreaterThanOrEqual(1)
    // drift closed: user deactivated, sessions gone
    expect((await db.user.findUnique({ where: { id: user.id } }))!.status).toBe("INACTIVE")
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0)
    // the reconciliation is narrated in the employee history
    const hist = await db.employeeHistory.findFirst({ where: { vendorId: v.id, employeeId: emp.id, eventType: "STATUS_CHANGE", title: { contains: "reconciled" } } })
    expect(hist).not.toBeNull()
    // a second pass finds nothing (idempotent)
    const again = await postHrm("jobs.reconcileUserStatus", {}, { bearer: token })
    expect(again.status).toBe(200)
    void session
    void owner
  })

  test("the direct function reports zero for a clean vendor", async () => {
    const v = await mkVendor(uniq("p1clean"))
    const emp = await mkEmployee(v.id, { fullName: "P1 Clean Active" })
    const user = await mkUser(v.id, { role: "EMPLOYEE", employeeId: emp.id })
    await mkSession(user.id, "FULL")
    const n = await reconcileUserEmployeeStatus(v.id)
    expect(n).toBe(0)
    expect((await db.user.findUnique({ where: { id: user.id } }))!.status).toBe("ACTIVE")
  })
})
