/// <reference types="bun-types" />
// ============ Phase 3 WS-D — mobile v1.1 (MOB-1..6) ============================
// Token exchange + refresh rotation + reuse detection (MOB-1), keyset cursor
// pagination (MOB-2/3), read-audit sampling (MOB-4), page-scoped decoration
// (MOB-5) and updatedSince/ETag delta sync (MOB-6) — all through the REAL
// route handlers (NextRequest → GET/POST), the same pattern as m5-metrics.
import "./_testdb"
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, uniq } from "./_fixtures"
import { NextRequest } from "next/server"
import { POST as tokenRoute } from "@/app/api/v1/auth/token/route"
import { GET as employeesRoute } from "@/app/api/v1/employees/route"
import { GET as attendanceRoute } from "@/app/api/v1/attendance/route"
import { hashPasswordAsync } from "@/hrm-server/auth"

const PASSWORD = "P3Passw0rd!"

let vendor: { id: string }
let hrUser: { id: string; email: string }
let empUser: { id: string; email: string }

function req(url: string, opts: { bearer?: string; ifNoneMatch?: string; method?: "GET" | "POST"; body?: unknown } = {}) {
  const headers: Record<string, string> = {}
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`
  if (opts.ifNoneMatch) headers["if-none-match"] = opts.ifNoneMatch
  const hasBody = opts.body != null
  if (hasBody) headers["content-type"] = "application/json"
  return new NextRequest(url, {
    method: hasBody ? "POST" : (opts.method || "GET"),
    headers,
    ...(hasBody ? { body: JSON.stringify(opts.body) } : {}),
  })
}

async function grant(_unused: string, body: unknown) {
  const res = await tokenRoute(req("http://localhost/api/v1/auth/token", { body }) as any)
  return { status: res.status, json: await res.json().catch(() => null) }
}

beforeAll(async () => {
  vendor = await mkVendor("P3 Mobile Tenant")
  // HR_MANAGER (not in the MFA-by-default set) + the integrations.view grant
  // that gates API credential administration
  const hr = await mkUser(vendor.id, {
    role: "HR_MANAGER", email: `p3-hr-${uniq()}@test.example`, name: "P3 HR",
    permissions: ["employees.view", "integrations.view", "attendance.view", "leave.view"],
  })
  await db.user.update({ where: { id: hr.id }, data: { passwordHash: await hashPasswordAsync(PASSWORD) } })
  hrUser = { id: hr.id, email: hr.email }
  // an ESS employee — must NOT be able to mint user tokens
  const emp = await mkUser(vendor.id, { role: "EMPLOYEE", email: `p3-emp-${uniq()}@test.example`, name: "P3 Employee" })
  await db.user.update({ where: { id: emp.id }, data: { passwordHash: await hashPasswordAsync(PASSWORD) } })
  empUser = { id: emp.id, email: emp.email }
})

const prevSampleRate = process.env.HRM_API_AUDIT_SAMPLE_RATE
afterAll(() => {
  if (prevSampleRate === undefined) delete process.env.HRM_API_AUDIT_SAMPLE_RATE
  else process.env.HRM_API_AUDIT_SAMPLE_RATE = prevSampleRate
})

describe("MOB-1 — password grant, scopes and credential hygiene", () => {
  test("password grant issues a working access+refresh pair (session machinery)", async () => {
    const out = await grant("", { grant_type: "password", email: hrUser.email, password: PASSWORD })
    expect(out.status).toBe(200)
    expect(out.json.ok).toBe(true)
    expect(out.json.data.token_type).toBe("Bearer")
    expect(out.json.data.access_token.split(".").length).toBe(3) // JWT
    expect(out.json.data.refresh_token.startsWith("fkr_")).toBe(true)
    // default scopes = the read set
    expect(out.json.data.scope).toContain("employees:read")

    // the access token authenticates against the employees route
    const list = await employeesRoute(req(`http://localhost/api/v1/employees?pageSize=5`, { bearer: out.json.data.access_token }))
    expect(list.status).toBe(200)
    const body = await list.json()
    expect(body.ok).toBe(true)
  })

  test("bad credentials and ESS-role grants are refused", async () => {
    const bad = await grant("", { grant_type: "password", email: hrUser.email, password: "wrong" })
    expect(bad.status).toBe(401)

    const ess = await grant("", { grant_type: "password", email: empUser.email, password: PASSWORD })
    expect(ess.status).toBe(403) // EMPLOYEE cannot mint tokens (no integrations.view)
    expect(ess.json.error).toMatch(/integrations\.view|role/i)
  })

  test("scope requests are validated against the catalog", async () => {
    const bad = await grant("", { grant_type: "password", email: hrUser.email, password: PASSWORD, scopes: ["employees:read", "root:all"] })
    expect(bad.status).toBe(400)
  })

  test("a token without the route's scope is refused (403, not silent pass)", async () => {
    const out = await grant("", { grant_type: "password", email: hrUser.email, password: PASSWORD, scopes: ["leave:read"] })
    expect(out.status).toBe(200)
    const res = await employeesRoute(req("http://localhost/api/v1/employees", { bearer: out.json.data.access_token }))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe("SCOPE_MISSING")
  })

  test("deleting the backing session kills the access token (revocation)", async () => {
    const out = await grant("", { grant_type: "password", email: hrUser.email, password: PASSWORD })
    const token = out.json.data.access_token
    expect((await employeesRoute(req("http://localhost/api/v1/employees", { bearer: token }))).status).toBe(200)
    // revoke: delete the session the JWT is bound to
    const claims = JSON.parse(Buffer.from(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString())
    await db.session.delete({ where: { id: claims.sid } })
    expect((await employeesRoute(req("http://localhost/api/v1/employees", { bearer: token }))).status).toBe(401)
  })
})

describe("MOB-1 — refresh rotation, reuse detection and family revocation", () => {
  test("rotation issues a fresh pair; reusing the OLD refresh revokes the family", async () => {
    const first = await grant("", { grant_type: "password", email: hrUser.email, password: PASSWORD })
    const refresh1 = first.json.data.refresh_token

    const second = await grant("", { grant_type: "refresh_token", refresh_token: refresh1 })
    expect(second.status).toBe(200)
    expect(second.json.data.refresh_token).not.toBe(refresh1) // rotated
    const refresh2 = second.json.data.refresh_token

    // THEFT SIGNAL: presenting the already-rotated refresh1
    const reuse = await grant("", { grant_type: "refresh_token", refresh_token: refresh1 })
    expect(reuse.status).toBe(401)
    expect(reuse.json.error).toMatch(/reuse/i)

    // the whole family is dead — refresh2 (legitimately issued) no longer works
    const afterReuse = await grant("", { grant_type: "refresh_token", refresh_token: refresh2 })
    expect(afterReuse.status).toBe(401)

    // a fresh password grant starts a NEW family and works again
    const fresh = await grant("", { grant_type: "password", email: hrUser.email, password: PASSWORD })
    expect(fresh.status).toBe(200)
  })

  test("garbage refresh tokens are a clean 401", async () => {
    const out = await grant("", { grant_type: "refresh_token", refresh_token: "fkr_nope" })
    expect(out.status).toBe(401)
  })
})

describe("MOB-2/3 — keyset cursor pagination + updatedSince + ETag", () => {
  test("employees walk pages by cursor with no overlap and a truthful hasMore", async () => {
    // fresh grant for this suite
    const out = await grant("", { grant_type: "password", email: hrUser.email, password: PASSWORD })
    const bearer = out.json.data.access_token

    // fixture rows for THIS vendor
    for (let i = 0; i < 7; i++) await mkEmployee(vendor.id, { fullName: `P3 Cursor Emp ${i}` })

    const page1 = await employeesRoute(req(`http://localhost/api/v1/employees?pageSize=5&cursor=`, { bearer }))
    expect(page1.status).toBe(200)
    const b1 = await page1.json()
    expect(b1.data.length).toBe(5)
    expect(b1.meta.hasMore).toBe(true)
    expect(typeof b1.meta.nextCursor).toBe("string")

    const page2 = await employeesRoute(req(`http://localhost/api/v1/employees?pageSize=5&cursor=${encodeURIComponent(b1.meta.nextCursor)}`, { bearer }))
    const b2 = await page2.json()
    expect(b2.data.length).toBeGreaterThanOrEqual(2)
    const ids1 = new Set(b1.data.map((r: any) => r.id))
    expect(b2.data.every((r: any) => !ids1.has(r.id))).toBe(true) // keyset: no overlap
    expect(b2.meta.hasMore).toBe(false)

    // malformed cursor degrades to a fresh first page (never a 500)
    const bad = await employeesRoute(req(`http://localhost/api/v1/employees?pageSize=5&cursor=%%%bad`, { bearer }))
    expect(bad.status).toBe(200)
  })

  test("updatedSince returns only rows changed after the instant (delta sync)", async () => {
    const out = await grant("", { grant_type: "password", email: hrUser.email, password: PASSWORD })
    const bearer = out.json.data.access_token
    const since = new Date()
    await new Promise((r) => setTimeout(r, 30))
    const marker = uniq("P3DELTA")
    const created = await mkEmployee(vendor.id, { fullName: `P3 Delta ${marker}` })

    const res = await employeesRoute(req(`http://localhost/api/v1/employees?updatedSince=${since.toISOString()}&pageSize=100`, { bearer }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.some((r: any) => r.id === created.id)).toBe(true)
    expect(body.data.every((r: any) => new Date(r.updatedAt).getTime() >= since.getTime() - 1)).toBe(true)
    // pre-existing rows are excluded from the delta
    expect(body.data.length).toBeLessThan(await db.employee.count({ where: { vendorId: vendor.id } }))
  })

  test("ETag + If-None-Match short-circuits to 304 when nothing changed", async () => {
    const out = await grant("", { grant_type: "password", email: hrUser.email, password: PASSWORD })
    const bearer = out.json.data.access_token
    const url = "http://localhost/api/v1/employees?pageSize=3"

    const first = await employeesRoute(req(url, { bearer }))
    const etag = first.headers.get("etag")
    expect(etag).toBeTruthy()

    const revalidate = await employeesRoute(req(url, { bearer, ifNoneMatch: etag! }))
    expect(revalidate.status).toBe(304)
    expect(revalidate.headers.get("etag")).toBe(etag)
  })

  test("attendance cursor mode pages past the 500-row page cap with a truthful truncated flag", async () => {
    const out = await grant("", { grant_type: "password", email: hrUser.email, password: PASSWORD })
    const bearer = out.json.data.access_token

    const emp = await mkEmployee(vendor.id, { fullName: "P3 Att Emp" })
    // four DISTINCT days (the (vendor, employee, date) unique key caps one row
    // per day — exactly what a real range query walks)
    for (let i = 0; i < 4; i++) {
      await db.attendance.create({
        data: { vendorId: vendor.id, employeeId: emp.id, date: `2026-10-1${i}`, checkIn: "09:00", checkOut: "17:00", status: "PRESENT", source: "MANUAL" },
      })
    }
    // page mode still caps at min(pageSize, 500) with the honest truncated flag
    const pageMode = await attendanceRoute(req(`http://localhost/api/v1/attendance?from=2026-10-01&to=2026-10-31&pageSize=2`, { bearer }))
    const pm = await pageMode.json()
    expect(pm.data.length).toBe(2)
    expect(pm.meta.truncated).toBe(false)
    expect(pm.meta.hasMore).toBeUndefined()

    // cursor mode walks the whole range in bounded pages
    const first = await attendanceRoute(req(`http://localhost/api/v1/attendance?from=2026-10-01&to=2026-10-31&cursor=&pageSize=3`, { bearer }))
    const b1 = await first.json()
    expect(b1.data.length).toBe(3)
    expect(b1.meta.hasMore).toBe(true)
    expect(typeof b1.meta.nextCursor).toBe("string")
    expect(b1.meta.truncated).toBe(false) // cursor mode never lies about truncation

    const second = await attendanceRoute(req(`http://localhost/api/v1/attendance?from=2026-10-01&to=2026-10-31&cursor=${encodeURIComponent(b1.meta.nextCursor)}&pageSize=3`, { bearer }))
    const b2 = await second.json()
    expect(b2.data.length).toBe(1)
    expect(b2.meta.hasMore).toBe(false)
    const ids1 = new Set(b1.data.map((r: any) => r.id))
    expect(b2.data.every((r: any) => !ids1.has(r.id))).toBe(true)
  })
})

describe("MOB-4 — read-audit sampling (writes always audited)", () => {
  test("HRM_API_AUDIT_SAMPLE_RATE=0 drops read audits; =1 keeps them", async () => {
    const out = await grant("", { grant_type: "password", email: hrUser.email, password: PASSWORD })
    const bearer = out.json.data.access_token
    const before = async () =>
      db.auditLog.count({ where: { vendorId: vendor.id, action: "API_V1_REQUEST" } })

    process.env.HRM_API_AUDIT_SAMPLE_RATE = "0"
    let n0 = await before()
    for (let i = 0; i < 3; i++) {
      await employeesRoute(req("http://localhost/api/v1/employees?pageSize=1", { bearer }))
    }
    expect(await before()).toBe(n0) // zero sampled reads

    process.env.HRM_API_AUDIT_SAMPLE_RATE = "1"
    n0 = await before()
    await employeesRoute(req("http://localhost/api/v1/employees?pageSize=1", { bearer }))
    expect(await before()).toBe(n0 + 1) // every read audited
  })
})

describe("MOB-5 — page-scoped decoration keeps the response shape", () => {
  test("branch/department/designation names resolve for the page only", async () => {
    const out = await grant("", { grant_type: "password", email: hrUser.email, password: PASSWORD })
    const bearer = out.json.data.access_token
    const { mkBranch } = await import("./_fixtures")
    const branch = await mkBranch(vendor.id, "P3 Mobile Branch")
    await mkEmployee(vendor.id, { fullName: "P3 Decorated Emp", branchId: branch.id })

    const res = await employeesRoute(req("http://localhost/api/v1/employees?pageSize=100", { bearer }))
    const body = await res.json()
    const decorated = body.data.find((r: any) => r.branchId === branch.id)
    expect(decorated.branchName).toBe("P3 Mobile Branch")
    // same field set as the pre-Phase-3 contract
    for (const f of ["id", "code", "fullName", "branchName", "departmentName", "designationName", "reportingManagerName", "status", "createdAt", "updatedAt"]) {
      expect(f in (decorated || body.data[0])).toBe(true)
    }
  })
})
