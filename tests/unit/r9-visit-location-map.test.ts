/// <reference types="bun-types" />
// ============ R9 regression: visit-location map picker + geocode proxy ============
// Audit (2026-10-12): visit locations were authored with raw lat/lng number
// inputs — error-prone and unverifiable. The location dialog is now a real
// map picker (click-to-place, draggable circle, address search through the
// server-side Nominatim proxy `fieldforce.geo.search`). Regression-tested
// here at the API boundary:
//   · geo.search contract: permission gate, min-3-char validation, shape
//   · locations.save coordinate validation stays strict (the server is the
//     authority on radius enforcement — a lying client cannot widen it)
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkSession, mkEmployee, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"

let vendor: { id: string }
let admin: { id: string; token: string }
let employeeToken: string

beforeAll(async () => {
  vendor = await mkVendor("R9 Vendor")
  const u = await mkUser(vendor.id, { role: "HR_ADMIN", name: "R9 Admin" })
  admin = { id: u.id, token: await mkSession(u.id, "FULL") }
  const emp = await mkEmployee(vendor.id, { fullName: "R9 Field Rep" })
  const eu = await mkUser(vendor.id, { role: "EMPLOYEE", email: `r9-emp-${uniq()}@test.example`, employeeId: emp.id })
  employeeToken = await mkSession(eu.id, "FULL")
})

describe("R9 — fieldforce.geo.search contract", () => {
  test("requires at least 3 characters (clean 400, not an upstream call)", async () => {
    const res = await postHrm("fieldforce.geo.search", { q: "ab" }, { bearer: admin.token })
    expect(res.body.ok).toBe(false)
    expect(res.body.code).toBe(400)
    expect(String(res.body.error)).toMatch(/3/i)
  })

  test("rejects oversized queries (whitelist behavior)", async () => {
    const res = await postHrm("fieldforce.geo.search", { q: "x".repeat(250) }, { bearer: admin.token })
    expect(res.body.ok).toBe(false)
    expect(res.body.code).toBe(400)
  })

  test("requires fieldforce.view permission (EMPLOYEE role denied)", async () => {
    const res = await postHrm("fieldforce.geo.search", { q: "Dhaka" }, { bearer: employeeToken })
    expect(res.status).toBe(403)
  })

  test("unknown extra fields are rejected (strict whitelist schema)", async () => {
    const res = await postHrm("fieldforce.geo.search", { q: "Dhaka", limit: 50, evil: true }, { bearer: admin.token })
    // strict schema: smuggled fields never reach the handler (clean 400)
    expect(res.body.ok).toBe(false)
    expect(res.body.code).toBe(400)
    expect(String(res.body.error)).toMatch(/limit|unrecognized/i)
  })

  test("a well-formed query resolves or fails transparently (never a 500) — upstream MOCKED, no real network", async () => {
    // FORENSIC AUDIT 2026-11-10, FIN-026 (Phase 1): this case used to hit the
    // REAL Nominatim endpoint (tolerating 200/502/504) — in a network-restricted
    // environment it hung for the full 6 s upstream timeout and failed the
    // suite (the audit's 4th original failure). The upstream HTTP is now fully
    // stubbed: the happy path, the 502 and the timeout are each asserted
    // deterministically. Queries are unique per call so the route's 10-minute
    // geoCache can never cross-contaminate cases.
    const realFetch = globalThis.fetch
    const jsonResponse = (rows: unknown[], status = 200) =>
      new Response(JSON.stringify(rows), { status, headers: { "content-type": "application/json" } })
    try {
      // (a) happy path — upstream rows map to label/lat/lng
      globalThis.fetch = (async (input: any) => {
        expect(String(input)).toContain("nominatim.openstreetmap.org")
        return jsonResponse([{ display_name: "Dhaka, Bangladesh", lat: "23.8103324", lon: "90.4125181" }])
      }) as any
      const ok = await postHrm("fieldforce.geo.search", { q: `Dhaka Bangladesh ${uniq()}` }, { bearer: admin.token })
      expect(ok.status).toBe(200)
      expect(ok.body.ok).toBe(true)
      const results = ok.body.data?.results as any[]
      expect(results?.length).toBe(1)
      expect(results[0].label).toContain("Dhaka")
      expect(results[0].lat).toBeCloseTo(23.8103324, 6)
      expect(results[0].lng).toBeCloseTo(90.4125181, 6)

      // (b) upstream 5xx → transparent 502, never a 500
      globalThis.fetch = (async () => new Response("upstream down", { status: 503 })) as any
      const bad = await postHrm("fieldforce.geo.search", { q: `Nowhere ${uniq()}` }, { bearer: admin.token })
      expect(bad.status).toBe(502)
      expect(bad.body.ok).toBe(false)

      // (c) upstream hang → the 6 s abort fires → transparent 504, never a 500
      globalThis.fetch = (async (_input: any, init?: any) => {
        return await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))
        })
      }) as any
      const slow = await postHrm("fieldforce.geo.search", { q: `Slowtown ${uniq()}` }, { bearer: admin.token })
      expect(slow.status).toBe(504)
      expect(slow.body.ok).toBe(false)
    } finally {
      globalThis.fetch = realFetch
    }
  }, 20_000)
})

describe("R9 — location coordinate + radius validation (server authority)", () => {
  const good = { name: `R9 Depot ${uniq()}`, lat: 23.8103, lng: 90.4125, radiusM: 150 }

  test("valid coordinates + radius create the location", async () => {
    const res = await postHrm("fieldforce.locations.save", good, { bearer: admin.token })
    expect(res.body.ok).toBe(true)
    const rec = await db.visitLocation.findFirst({ where: { vendorId: vendor.id, name: good.name } })
    expect(rec?.lat).toBeCloseTo(23.8103, 6)
    expect(rec?.lng).toBeCloseTo(90.4125, 6)
    expect(rec?.radiusM).toBe(150)
  })

  test("latitude out of range is rejected", async () => {
    const res = await postHrm("fieldforce.locations.save", { ...good, name: `R9 Bad ${uniq()}`, lat: 91.5 }, { bearer: admin.token })
    expect(res.body.ok).toBe(false)
    expect(res.body.code).toBe(400)
  })

  test("longitude out of range is rejected", async () => {
    const res = await postHrm("fieldforce.locations.save", { ...good, name: `R9 Bad ${uniq()}`, lng: -181 }, { bearer: admin.token })
    expect(res.body.ok).toBe(false)
    expect(res.body.code).toBe(400)
  })

  test("radius below 10m / above 5000m is rejected (check-in integrity)", async () => {
    const tooSmall = await postHrm("fieldforce.locations.save", { ...good, name: `R9 Bad ${uniq()}`, radiusM: 5 }, { bearer: admin.token })
    expect(tooSmall.body.ok).toBe(false)
    const tooBig = await postHrm("fieldforce.locations.save", { ...good, name: `R9 Bad ${uniq()}`, radiusM: 6000 }, { bearer: admin.token })
    expect(tooBig.body.ok).toBe(false)
  })

  test("duplicate names within a tenant are rejected with a friendly message", async () => {
    const dupName = `R9 Dup ${uniq()}`
    await postHrm("fieldforce.locations.save", { ...good, name: dupName }, { bearer: admin.token })
    const res = await postHrm("fieldforce.locations.save", { ...good, name: dupName, lat: 23.76, lng: 90.4 }, { bearer: admin.token })
    expect(res.body.ok).toBe(false)
    expect(String(res.body.error)).toMatch(/already exists/i)
  })
})
