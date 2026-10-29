/// <reference types="bun-types" />
// ============ M-02 regression: residual ungated actions ============
// notifications.read is userId-scoped; delegations.list / requisitions.itemOptions
// / events.list / calendar.events carry permission gates; selfTest's vendor
// loop is scoped to the caller's vendor.
import "./_testdb" // first — sets DATABASE_URL before db.ts is constructed
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import "@/hrm-server/routes/router" // registers every action (side effect)
import { routes } from "@/hrm-server/routes/registry"
import { mkVendor, mkUser, makeCtx, uniq } from "./_fixtures"

const vendorA = await mkVendor("M02 Vendor A")
const vendorB = await mkVendor("M02 Vendor B")
const userA = await mkUser(vendorA.id, { role: "EMPLOYEE", name: "A Emp" })
const ownerA = await mkUser(vendorA.id, { role: "VENDOR_OWNER", name: "A Owner" })

beforeAll(async () => {
  await db.notification.create({ data: { vendorId: vendorA.id, userId: userA.id, title: "mine", message: "b", type: "SYSTEM" } as any })
  await db.notification.create({ data: { vendorId: vendorA.id, userId: ownerA.id, title: "theirs", message: "b", type: "SYSTEM" } as any })
})

describe("M-02 notifications.read", () => {
  test("a user cannot mark ANOTHER user's notification read (userId filter)", async () => {
    const other = await db.notification.findFirst({ where: { vendorId: vendorA.id, userId: ownerA.id } })
    expect(other).toBeTruthy()
    const ctxA = makeCtx(userA, [])
    await routes["notifications.read"]!.handler(ctxA, { id: other!.id })
    const after = await db.notification.findFirst({ where: { id: other!.id } })
    expect(after!.readAt).toBeNull() // untouched — filter blocked the write
  })
  test("own notification marks read fine", async () => {
    const own = await db.notification.findFirst({ where: { vendorId: vendorA.id, userId: userA.id } })
    const ctxA = makeCtx(userA, [])
    await routes["notifications.read"]!.handler(ctxA, { id: own!.id })
    const after = await db.notification.findFirst({ where: { id: own!.id } })
    expect(after!.readAt).not.toBeNull()
  })
})

describe("M-02 permission gates on previously ungated actions", () => {
  test("delegations.list requires approvals.view", () => {
    expect(routes["delegations.list"]!.perm).toEqual(["approvals", "view"])
  })
  test("requisitions.itemOptions requires procurement.view", () => {
    expect(routes["requisitions.itemOptions"]!.perm).toEqual(["procurement", "view"])
  })
  test("events.list requires announcements.view", () => {
    expect(routes["events.list"]!.perm).toEqual(["announcements", "view"])
  })
  test("calendar.events requires calendar.view", () => {
    expect(routes["calendar.events"]!.perm).toEqual(["calendar", "view"])
  })
})

describe("M-02 system.selfTest vendor scoping", () => {
  test("self-test reports only the caller's vendor — never enumerates other tenants", async () => {
    const ctxA = makeCtx(ownerA, ["*"])
    const res: any = await routes["system.selfTest"]!.handler(ctxA, {})
    const names: string[] = (res.results || []).map((r: any) => r.name)
    expect(names.some((n) => n.includes(vendorB.code ?? "M02 Vendor B") || n.includes("Vendor B"))).toBe(false)
    // and the caller's own vendor integrity row exists
    expect(names.some((n) => n.toLowerCase().includes("tenant integrity"))).toBe(true)
  })
})
