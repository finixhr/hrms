/// <reference types="bun-types" />
// ============ C-01 regression: sessions.list / sessions.revoke ============
// The session id IS the bearer token. sessions.list must never disclose it,
// and sessions.revoke must resolve the row server-side from the masked
// fingerprint so the caller never needs (or learns) a usable token.
import "./_testdb" // first — sets DATABASE_URL before db.ts is constructed
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { getRoute } from "@/hrm-server/routes/router"
import { getCtxFromToken } from "@/hrm-server/auth"
import { mkVendor, mkUser, mkSession, makeCtx } from "./_fixtures"

let vendor: { id: string }
let admin: { id: string; vendorId: string; role: string }
let regularUser: { id: string; vendorId: string; role: string }
let liveToken: string

beforeAll(async () => {
  vendor = await mkVendor("C01 Vendor")
  admin = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "Admin" })
  regularUser = await mkUser(vendor.id, { role: "HR_MANAGER", name: "Victim" })
  liveToken = await mkSession(regularUser.id)
})

describe("C-01 sessions.list", () => {
  test("response rows contain NO sessionId key (the bearer token must never leave the server)", async () => {
    const def = getRoute("sessions.list")!
    const rows = (await def.handler(makeCtx(admin), {})) as any[]
    expect(Array.isArray(rows)).toBe(true)
    const mine = rows.filter((r) => r.userEmail !== undefined)
    expect(mine.length).toBeGreaterThan(0)
    for (const row of mine) {
      expect(Object.keys(row)).not.toContain("sessionId")
      // every other field is metadata only
      expect(typeof row.id).toBe("string")
      expect(row.id).toMatch(/^[0-9a-f]{8}…[0-9a-f]{4}$/)
    }
  })

  test("the masked fingerprint cannot be used as a Bearer token", async () => {
    const def = getRoute("sessions.list")!
    const rows = (await def.handler(makeCtx(admin), {})) as any[]
    for (const row of rows) {
      const ctx = await getCtxFromToken(row.id)
      expect(ctx).toBeNull()
    }
  })

  test("response contains no full 64-hex token anywhere in the serialized payload", async () => {
    const def = getRoute("sessions.list")!
    const rows = (await def.handler(makeCtx(admin), {})) as any[]
    const json = JSON.stringify(rows)
    expect(json).not.toContain(liveToken)
    expect(json).not.toMatch(/"sessionId"/)
  })
})

describe("C-01 sessions.revoke", () => {
  test("revokes via the masked fingerprint without ever receiving the real token", async () => {
    const list = getRoute("sessions.list")!
    const rows = (await list.handler(makeCtx(admin), {})) as any[]
    const target = rows.find((r) => r.userEmail === (regularUser as any).email)
    expect(target).toBeTruthy()
    const revoke = getRoute("sessions.revoke")!
    const out = (await revoke.handler(makeCtx(admin), { maskedId: target.id, reason: "test revoke" })) as any
    expect(out.revoked).toBeGreaterThanOrEqual(1)
    // the session is really gone
    expect(await db.session.findUnique({ where: { id: liveToken } })).toBeNull()
  })

  test("rejects a raw session-token-shaped payload as an invalid fingerprint", async () => {
    const revoke = getRoute("sessions.revoke")!
    expect(revoke.handler(makeCtx(admin), { sessionId: liveToken })).rejects.toThrow(/fingerprint/i)
  })

  test("cross-venant masked fingerprint revokes nothing (tenant isolation)", async () => {
    const otherVendor = await mkVendor("Other Vendor")
    const otherUser = await mkUser(otherVendor.id, { role: "VENDOR_OWNER" })
    const otherToken = await mkSession(otherUser.id)
    const masked = `${otherToken.slice(0, 8)}…${otherToken.slice(-4)}`
    const revoke = getRoute("sessions.revoke")!
    expect(revoke.handler(makeCtx(admin), { maskedId: masked })).rejects.toThrow(/not found/i)
    // other vendor's session survives
    expect(await db.session.findUnique({ where: { id: otherToken } })).toBeTruthy()
  })
})
