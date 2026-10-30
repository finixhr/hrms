/// <reference types="bun-types" />
// ============ Low/Info finalization — L-9, L-13, L-14, M-5 comm-log cursor ============
// Covers the last wave of Low/Informational fixes:
//  · L-9  — isExpired: local-timezone date-only semantics (no UTC-midnight bug)
//  · L-13 — settings.patch: server-side partial update (no read-modify-write clobber)
//  · L-14 — redactCommLine: employee names never ride in comm-log diagnostics
//  · M-5  — devices.commLogs cursor pagination
import "./_testdb" // first — sets DATABASE_URL before db.ts is constructed
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { getRoute } from "@/hrm-server/routes/router"
import { getSettings } from "@/hrm-server/settings"
import { redactCommLine } from "@/hrm-server/zkteco/gateway"
import { isExpired } from "@/hrm/shared/ui-kit"
import { mkVendor, mkUser, makeCtx, uniq } from "./_fixtures"

let vendor: { id: string }

beforeAll(async () => {
  vendor = await mkVendor("LowFix Vendor")
})

// ---------------------------------------------------------------- L-9 ----
describe("L-9 isExpired (local-timezone date-only)", () => {
  const localToday = () => new Date().toLocaleDateString("en-CA") // YYYY-MM-DD

  test("a document expiring TODAY is not yet expired (local time)", () => {
    expect(isExpired(localToday())).toBe(false)
  })

  test("a document that expired YESTERDAY is expired", () => {
    const y = new Date(Date.now() - 24 * 3600_000).toLocaleDateString("en-CA")
    expect(isExpired(y)).toBe(true)
  })

  test("fixed dates compare against the injected local today key, not UTC midnight", () => {
    // 2026-09-21 expiry checked against local 2026-09-21 → NOT expired.
    // The old `new Date("2026-09-21") < new Date()` parsed the string at UTC
    // midnight and could flag this as expired depending on viewer timezone.
    expect(isExpired("2026-09-21", "2026-09-21")).toBe(false)
    expect(isExpired("2026-09-20", "2026-09-21")).toBe(true)
    expect(isExpired("2026-09-22", "2026-09-21")).toBe(false)
  })

  test("garbage and empty inputs are safely non-expired", () => {
    expect(isExpired(null)).toBe(false)
    expect(isExpired(undefined)).toBe(false)
    expect(isExpired("")).toBe(false)
    expect(isExpired("not-a-date")).toBe(false)
  })
})

// ---------------------------------------------------------------- L-14 ----
describe("L-14 redactCommLine (comm-log PII redaction)", () => {
  test("USERINFO lines mask the employee NAME field", () => {
    const line = "USERINFO\t1001\tRashedul Karim\t12345\t0\t2\t1\t\t0"
    const out = redactCommLine(line)
    expect(out).not.toContain("Rashedul Karim")
    expect(out).toContain("[REDACTED]")
    // PIN and card survive — operators need them for user mapping
    expect(out).toContain("1001")
    expect(out).toContain("12345")
  })

  test("USERINFO redaction is tab-position accurate (name column only)", () => {
    const out = redactCommLine("USERINFO\t7\tA\tB\tC")
    const parts = out.split("\t")
    expect(parts[2]).toBe("[REDACTED]")
    expect(parts[3]).toBe("B")
    expect(parts[4]).toBe("C")
  })

  test("ATTLOG and OPERLOG lines pass through unchanged (no names to redact)", () => {
    const att = "1001\t1\t2026-09-21 09:00:00\t0\t0\t0\t0"
    const op = "OPERLOG\t10\t2026-09-21 09:00:00\t29\t1"
    expect(redactCommLine(att)).toBe(att)
    expect(redactCommLine(op)).toBe(op)
  })

  test("short/malformed lines pass through untouched (no crash)", () => {
    expect(redactCommLine("USERINFO\t9")).toBe("USERINFO\t9")
    expect(redactCommLine("")).toBe("")
  })
})

// ---------------------------------------------------------------- L-13 ----
describe("L-13 settings.patch (server-side partial update)", () => {
  test("patching ONE key preserves the group's other keys (no clobber)", async () => {
    const owner = await mkUser(vendor.id, { role: "VENDOR_OWNER" })
    const ctx = makeCtx(owner)
    const def = getRoute("settings.patch")!
    // seed two keys via the full save
    await getRoute("settings.save")!.handler(ctx, {
      group: "localization",
      values: { language: "en", currencySymbol: "BDT" },
    })
    // patch only language — the clobber-prone read-modify-write is gone
    await def.handler(ctx, { group: "localization", values: { language: "bn" } })
    const s: any = await getSettings(vendor.id, { maskSecrets: false, noCache: true })
    expect(s.localization.language).toBe("bn")
    expect(s.localization.currencySymbol).toBe("BDT") // survived the patch
  })

  test("unknown group is rejected", async () => {
    const owner = await mkUser(vendor.id, { role: "VENDOR_OWNER" })
    const def = getRoute("settings.patch")!
    await expect(def.handler(makeCtx(owner), { group: "no-such-group", values: { a: 1 } })).rejects.toThrow("Unknown settings group")
  })

  test("empty values are rejected (a no-op patch is a bug, not a request)", async () => {
    const owner = await mkUser(vendor.id, { role: "VENDOR_OWNER" })
    const def = getRoute("settings.patch")!
    await expect(def.handler(makeCtx(owner), { group: "localization", values: {} })).rejects.toThrow()
  })

  test("the route is permission-gated (settings.edit)", async () => {
    const def = getRoute("settings.patch")!
    expect(def.perm).toEqual(["settings", "edit"])
    const viewer = await mkUser(vendor.id, { role: "EMPLOYEE" })
    // the registry dispatcher enforces perm before the handler runs; the route
    // definition itself must carry the gate
    expect((def as any).perm).toBeDefined()
    expect((def as any).perm).not.toContain(null)
    expect((viewer as any).id).toBeTruthy()
  })
})

// ---------------------------------------------------------------- M-5 ----
describe("M-5 devices.commLogs cursor pagination", () => {
  test("cursor mode pages through append-only logs and reports nextCursor", async () => {
    const owner = await mkUser(vendor.id, { role: "VENDOR_OWNER" })
    const ctx = makeCtx(owner)
    const dev = await db.attendanceDevice.create({
      data: {
        vendorId: vendor.id, deviceId: uniq("D"), name: "Cursor Test Device",
        deviceIdentifier: uniq("SN"), protocol: "ADMS", enabled: true,
        timezone: "Asia/Dhaka", status: "ONLINE", syncStatus: "IDLE", eventCount: 0, configuration: "{}",
      },
    })
    const ids: string[] = []
    const sn = uniq("SN")
    for (let i = 0; i < 7; i++) {
      const row = await db.deviceCommLog.create({
        data: {
          vendorId: vendor.id, deviceId: dev.id, serial: sn,
          endpoint: "/iclock/cdata", requestType: "ATTLOG", httpStatus: 200, ok: true,
          error: `test-${i}`, ip: "127.0.0.1",
        },
      })
      ids.push(row.id)
    }
    const def = getRoute("devices.commLogs")!

    // page 1 (3 per page) — newest first
    const p1: any = await def.handler(ctx, { size: 3 })
    expect(p1.items).toHaveLength(3)
    expect(p1.nextCursor).toBe(p1.items[p1.items.length - 1].id)
    expect(p1.items[0].error).toBe("test-6")

    // page 2 via cursor
    const p2: any = await def.handler(ctx, { size: 3, cursor: p1.nextCursor })
    expect(p2.items.map((r: any) => r.error)).toEqual(["test-3", "test-2", "test-1"])

    // last page: 1 row, no nextCursor
    const p3: any = await def.handler(ctx, { size: 3, cursor: p2.nextCursor })
    expect(p3.items.map((r: any) => r.error)).toEqual(["test-0"])
    expect(p3.nextCursor).toBeNull()

    // no overlap, no gaps, strictly ordered
    const all = [...p1.items, ...p2.items, ...p3.items].map((r: any) => r.id)
    expect(new Set(all).size).toBe(7)
    expect(all).toEqual(ids.slice().reverse())
  })

  test("legacy page/size offset mode still works", async () => {
    const owner = await mkUser(vendor.id, { role: "VENDOR_OWNER" })
    const def = getRoute("devices.commLogs")!
    const out: any = await def.handler(makeCtx(owner), { page: 1, size: 5 })
    expect(Array.isArray(out.items)).toBe(true)
    expect(out.total).toBeGreaterThanOrEqual(0)
    expect(out.page).toBe(1)
  })
})
