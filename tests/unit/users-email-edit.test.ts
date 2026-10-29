/// <reference types="bun-types" />
// ============ R7 regression: users.save must persist email changes ============
// The users.save update path used to drop the email field entirely — an admin
// could edit every other attribute but the new address never saved. These
// tests guard the fix: changed emails persist (lower-cased), duplicates are
// rejected, unchanged emails are left alone.
import "./_testdb" // first — sets DATABASE_URL before db.ts is constructed
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { getRoute } from "@/hrm-server/routes/router"
import { mkVendor, mkUser, makeCtx, uniq } from "./_fixtures"

let vendor: { id: string }
let admin: any
let adminCtx: any

beforeAll(async () => {
  vendor = await mkVendor("R7 Vendor")
  admin = await mkUser(vendor.id, { role: "VENDOR_OWNER" })
  adminCtx = makeCtx(admin)
})

describe("R7 users.save email editing", () => {
  test("changed email is persisted (lower-cased)", async () => {
    const target = await mkUser(vendor.id, { role: "HR_ADMIN", email: uniq("old") + "@test.local" })
    const def = getRoute("users.save")!
    await def.handler(adminCtx, {
      id: target.id,
      name: target.name,
      email: "NewAddress@Test.Local",
      role: "HR_ADMIN",
      status: "ACTIVE",
    })
    const after = await db.user.findUnique({ where: { id: target.id } })
    expect(after?.email).toBe("newaddress@test.local")
  })

  test("duplicate email within the vendor is rejected", async () => {
    const taken = uniq("taken") + "@test.local"
    await mkUser(vendor.id, { role: "HR_ADMIN", email: taken })
    const target = await mkUser(vendor.id, { role: "HR_ADMIN" })
    const def = getRoute("users.save")!
    await expect(def.handler(adminCtx, {
      id: target.id, name: target.name, email: taken, role: "HR_ADMIN", status: "ACTIVE",
    })).rejects.toThrow(/already exists/i)
  })

  test("invalid email format is rejected", async () => {
    const target = await mkUser(vendor.id, { role: "HR_ADMIN" })
    const def = getRoute("users.save")!
    await expect(def.handler(adminCtx, {
      id: target.id, name: target.name, email: "not-an-email", role: "HR_ADMIN", status: "ACTIVE",
    })).rejects.toThrow(/invalid email/i)
  })

  test("unchanged email keeps its exact value (no duplicate self-conflict)", async () => {
    const email = uniq("same") + "@test.local"
    const target = await mkUser(vendor.id, { role: "HR_ADMIN", email })
    const def = getRoute("users.save")!
    await def.handler(adminCtx, {
      id: target.id, name: "Renamed User", email, role: "HR_MANAGER", status: "ACTIVE",
    })
    const after = await db.user.findUnique({ where: { id: target.id } })
    expect(after?.email).toBe(email)
    expect(after?.name).toBe("Renamed User")
    expect(after?.role).toBe("HR_MANAGER")
  })
})
