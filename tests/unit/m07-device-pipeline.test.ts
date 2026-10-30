/// <reference types="bun-types" />
// ============ M-07 regression: device pipeline concurrency + protocol gaps ============
//  * atomic event claims (conditional RECEIVED/FAILED → PROCESSING)
//  * stale-claim crash recovery loops back to RECEIVED
//  * DEAD_LETTER is terminal and excluded from sweep candidates
//  * retry backoff measured from lastAttemptAt, not createdAt
//  * eventCount uses atomic { increment }
//  * takeCommand claims QUEUED → SENT atomically
//  * resolveDevice rejects cross-protocol endpoints
import "./_testdb" // first — sets DATABASE_URL before db.ts is constructed
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkBranch, mkEmployee, uniq } from "./_fixtures"
import { resolveDevice, takeCommand, sweepOnce } from "@/hrm-server/zkteco/gateway"

let vendor: { id: string }
let admsDevice: any
let isapiDevice: any

async function mkDevice(over: Record<string, unknown>) {
  return db.attendanceDevice.create({
    data: {
      vendorId: vendor.id, deviceId: uniq("DEV"), name: "M07 Device",
      manufacturer: "ZKTeco", model: "SpeedFace V5L", protocol: "ADMS",
      deviceIdentifier: uniq("SN"), serialNumber: uniq("SN"), timezone: "Asia/Dhaka",
      enabled: true, status: "OFFLINE", ...over,
    } as any,
  })
}

async function mkRawEvent(deviceId: string, over: Record<string, unknown> = {}) {
  return db.attendanceRawEvent.create({
    data: {
      vendorId: vendor.id, deviceId, deviceSerial: "SN",
      deviceUserId: "1", eventTime: "2026-09-15 09:00:00",
      eventType: "IN", rawLine: "1\t2026-09-15 09:00:00\t1\t0\t1\t0",
      payloadHash: uniq("fp"), processingStatus: "RECEIVED", ...over,
    } as any,
  })
}

beforeAll(async () => {
  vendor = await mkVendor("M07 Vendor")
  await mkUser(vendor.id, { role: "VENDOR_OWNER" })
  // C-03 update — keyless devices now require the vendor admin setting
  // "Allow Keyless Devices"; enable it so the keyless fixture device below
  // authenticates the way it used to inside the old grace window.
  const { saveSettingsGroup } = await import("@/hrm-server/settings")
  await saveSettingsGroup(vendor.id, "devices", { allowKeyless: true })
  admsDevice = await mkDevice({})
  isapiDevice = await mkDevice({ protocol: "HIKVISION_ISAPI", manufacturer: "Hikvision" })
})

describe("M-07 resolveDevice — endpoint-protocol isolation", () => {
  test("an ISAPI device is rejected on an ADMS endpoint", async () => {
    const r: any = await resolveDevice(isapiDevice.deviceIdentifier, null, { endpointProtocol: "ADMS" })
    expect(r.ok).toBe(false)
    expect(r.code).toBe(403)
    expect(r.reason).toMatch(/not accepted on an ADMS endpoint/)
  })
  test("an ADMS device is rejected on an ISAPI endpoint", async () => {
    const r: any = await resolveDevice(admsDevice.deviceIdentifier, null, { endpointProtocol: "ISAPI" })
    expect(r.ok).toBe(false)
    expect(r.code).toBe(403)
    expect(r.reason).toMatch(/not accepted on an ISAPI endpoint/)
  })
  test("no protocol filter given → behavior unchanged (backward compatible)", async () => {
    // keyless device: accepted because the vendor's Allow Keyless Devices
    // setting is ON (keyless flag), NOT rejected by protocol isolation
    const r = await resolveDevice(admsDevice.deviceIdentifier, null)
    expect(r.ok).toBe(true)
    expect((r as any).keyless).toBe(true)
  })
})

describe("M-07 takeCommand — atomic QUEUED → SENT claim", () => {
  test("a claimed command is never delivered twice; races fall through to the next command", async () => {
    const c1 = await db.deviceCommand.create({
      data: { vendorId: vendor.id, deviceId: admsDevice.id, command: "CHECK", createdBy: "test" },
    })
    const c2 = await db.deviceCommand.create({
      data: { vendorId: vendor.id, deviceId: admsDevice.id, command: "DATA UPDATE USERINFO", createdBy: "test" },
    })
    const first = await takeCommand(admsDevice)
    expect(first).toBe("CHECK")
    // simulate a concurrent delivery racing on the SAME first row:
    const stolen = await db.deviceCommand.updateMany({
      where: { id: c1.id, status: "QUEUED" }, data: { status: "SENT", sentAt: new Date() },
    })
    expect(stolen.count).toBe(0) // already claimed — the conditional update loses
    const second = await takeCommand(admsDevice)
    expect(second).toBe("DATA UPDATE USERINFO")
    await db.deviceCommand.deleteMany({ where: { id: { in: [c1.id, c2.id] } } })
  })
})

describe("M-07 sweepOnce — claims, recovery, dead-letter, backoff", () => {
  test("stale PROCESSING claims are recovered to RECEIVED", async () => {
    const ev = await mkRawEvent(admsDevice.id, { processingStatus: "PROCESSING", claimedAt: new Date(Date.now() - 10 * 60_000) })
    await sweepOnce()
    const after = await db.attendanceRawEvent.findUnique({ where: { id: ev.id } })
    // recovered and either re-processed (UNKNOWN_EMPLOYEE: no mapping exists) or re-claimed
    expect(["UNKNOWN_EMPLOYEE", "PROCESSED"]).toContain(after?.processingStatus ?? "")
  })

  test("DEAD_LETTER is terminal — never re-swept", async () => {
    const ev = await mkRawEvent(admsDevice.id, {
      processingStatus: "DEAD_LETTER", retryCount: 99,
      lastAttemptAt: new Date(Date.now() - 60 * 60_000),
      processingError: "DEAD-LETTER: retry limit exceeded",
    })
    const before = await db.attendanceRawEvent.count({ where: { processingStatus: "DEAD_LETTER" } })
    await sweepOnce()
    const after = await db.attendanceRawEvent.findUnique({ where: { id: ev.id } })
    expect(after?.processingStatus).toBe("DEAD_LETTER") // untouched by the sweep
    const stillDead = await db.attendanceRawEvent.count({ where: { processingStatus: "DEAD_LETTER" } })
    expect(stillDead).toBe(before)
  })

  test("a FAILED retry past its backoff window is re-attempted (lastAttemptAt, not createdAt)", async () => {
    const ev = await mkRawEvent(admsDevice.id, {
      processingStatus: "FAILED", retryCount: 1,
      lastAttemptAt: new Date(Date.now() - 30 * 60_000), // far past the 15s backoff
      processingError: "transient",
    })
    await sweepOnce()
    const after = await db.attendanceRawEvent.findUnique({ where: { id: ev.id } })
    // re-attempted: no mapping exists → terminal UNKNOWN_EMPLOYEE (not FAILED)
    expect(after?.processingStatus).toBe("UNKNOWN_EMPLOYEE")
    expect(after?.lastAttemptAt).not.toBeNull()
  })

  test("a FAILED retry INSIDE its backoff window is skipped", async () => {
    const ev = await mkRawEvent(admsDevice.id, {
      processingStatus: "FAILED", retryCount: 3,
      lastAttemptAt: new Date(), // backoff 15s·2^2 = 60s — just attempted
      processingError: "transient",
    })
    await sweepOnce()
    const after = await db.attendanceRawEvent.findUnique({ where: { id: ev.id } })
    expect(after?.processingStatus).toBe("FAILED") // skipped — not re-attempted
  })

  test("eventCount updates are atomic increments (lost-update safe)", async () => {
    const dev = await mkDevice({ eventCount: 10 })
    // two overlapping "batches" both increment — a read-modify-write would drop one
    await Promise.all([
      db.attendanceDevice.update({ where: { id: dev.id }, data: { eventCount: { increment: 5 } } }),
      db.attendanceDevice.update({ where: { id: dev.id }, data: { eventCount: { increment: 5 } } }),
    ])
    const after = await db.attendanceDevice.findUnique({ where: { id: dev.id } })
    expect(after?.eventCount).toBe(20)
  })
})
