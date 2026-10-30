/// <reference types="bun-types" />
// ============ H-03 regression: wishes.today privacy gate ============
// The tenant-wide birthday/anniversary board is restricted to non-EMPLOYEE
// roles holding employees.view; EMPLOYEE callers get only their own events.
import "./_testdb" // first — sets DATABASE_URL before db.ts is constructed
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { getRoute } from "@/hrm-server/routes/router"
import { today } from "@/hrm-server/utils"
import { mkVendor, mkUser, mkEmployee, makeCtx, uniq } from "./_fixtures"

let vendor: { id: string }
let selfEmp: { id: string }
let otherEmp: { id: string }
let employeeUser: any

beforeAll(async () => {
  vendor = await mkVendor("H03 Vendor")
  selfEmp = await mkEmployee(vendor.id, { fullName: "Self Employee" })
  otherEmp = await mkEmployee(vendor.id, { fullName: "Other Employee" })
  employeeUser = await mkUser(vendor.id, { role: "EMPLOYEE", employeeId: selfEmp.id })
  // today's birthday for BOTH employees — "today" MUST be the deployment-zone
  // date the route uses (utils.today / zonedParts, Asia/Dhaka default), not the
  // UTC process clock: they diverge 18:00–24:00 UTC daily and the test would
  // fail every evening (latent time-bomb, caught 2026-10-02 18:00 UTC).
  const date = today()
  const mmdd = date.slice(5)
  const y = Number(date.slice(0, 4)) - 30
  const dob = `${y}-${mmdd}`
  await db.employee.update({ where: { id: selfEmp.id }, data: { dob } })
  await db.employee.update({ where: { id: otherEmp.id }, data: { dob } })
})

describe("H-03 wishes.today", () => {
  test("EMPLOYEE sees only their own birthday — never the tenant-wide board", async () => {
    const def = getRoute("wishes.today")!
    const out = (await def.handler(makeCtx(employeeUser), {})) as any
    expect(out.birthdays).toHaveLength(1)
    expect(out.birthdays[0].employeeId).toBe(selfEmp.id)
    expect(JSON.stringify(out)).not.toContain("Other Employee")
  })

  test("EMPLOYEE with no linked employee profile gets an empty board (no data leak)", async () => {
    const unlinked = await mkUser(vendor.id, { role: "EMPLOYEE", employeeId: null })
    const def = getRoute("wishes.today")!
    const out = (await def.handler(makeCtx(unlinked), {})) as any
    expect(out.birthdays).toHaveLength(0)
    expect(out.anniversaries).toHaveLength(0)
  })

  test("HR_ADMIN (employees.view) sees the full board", async () => {
    const hrAdmin = await mkUser(vendor.id, { role: "HR_ADMIN" })
    const def = getRoute("wishes.today")!
    const out = (await def.handler(makeCtx(hrAdmin), {})) as any
    expect(out.birthdays.length).toBeGreaterThanOrEqual(2)
  })
})
