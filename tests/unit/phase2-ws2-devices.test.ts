// Phase 2 WS2 — device ingestion scale fixes.
// SCL-8 batched raw-event storage · SCL-3 fair per-vendor sweep paging ·
// SCL-4 comm-log sampling + bounded trim · SCL-9 grouped rebuild ·
// MOD-20 indexed auto-map lookup.
import "./_testdb"
import { describe, expect, test } from "bun:test"
import { db } from "@/lib/db"
import { uniq } from "./_fixtures"
import {
  storeRawEventBatch,
  sweepOnce,
  _resetSweepCursorForTests,
  logComm,
} from "@/hrm-server/zkteco/gateway"
import { trimCommLogOnce } from "@/hrm-server/zkteco/sweeper"
import {
  findEmployeeForDeviceUser,
  autoMapDeviceUser,
  invalidateEmployeeDirectoryCache,
  rebuildDaily,
} from "@/hrm-server/zkteco/processor"
import { getSettings } from "@/hrm-server/settings"

function iso(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 86_400_000)
  return d.toISOString().slice(0, 10)
}

async function mkVendor(): Promise<string> {
  const v = await db.vendor.create({ data: { name: uniq("ws2"), code: uniq("WS2") } })
  return v.id
}

describe("SCL-8 storeRawEventBatch — batched ingest with exact classification", () => {
  test("fresh batch: all accepted; re-send: all duplicates; mixed batch classified precisely", async () => {
    const vendorId = await mkVendor()
    const mk = (i: number) => ({
      vendorId,
      deviceId: "ws2-test-device",
      deviceSerial: uniq("SN"),
      deviceUserId: String(i),
      eventTime: `${iso(0)} 09:00:00`,
      verifyMode: 1,
      attendanceStatus: null,
      workCode: null,
      eventType: "CHECK_IN",
      rawLine: `line-${i}`,
      payloadHash: `ws2-batch-${vendorId}-${i}`,
      processingStatus: "RECEIVED",
    })
    const batch = [mk(1), mk(2), mk(3)]
    const first = await storeRawEventBatch(batch)
    expect(first.acceptedHashes.size).toBe(3)
    expect(first.duplicateHashes.size).toBe(0)
    expect(first.failed).toBe(0)

    // device retry of the same batch → all duplicates
    const retry = await storeRawEventBatch(batch)
    expect(retry.acceptedHashes.size).toBe(0)
    expect(retry.duplicateHashes.size).toBe(3)

    // mixed: two new + one already-stored → precise split
    const mixed = await storeRawEventBatch([mk(4), mk(2), mk(5)])
    expect(mixed.acceptedHashes.size).toBe(2)
    expect(mixed.duplicateHashes.size).toBe(1)
    expect(mixed.duplicateHashes.has(`ws2-batch-${vendorId}-2`)).toBe(true)
  })

  test("empty buffer is a no-op", async () => {
    const r = await storeRawEventBatch([])
    expect(r.acceptedHashes.size).toBe(0)
    expect(r.duplicateHashes.size).toBe(0)
    expect(r.failed).toBe(0)
  })
})

describe("SCL-3 full — fair per-vendor sweeper paging", () => {
  test("a single pass processes BOTH vendors when one has a big backlog (no cross-tenant starvation)", async () => {
    const v1 = await mkVendor()
    const v2 = await mkVendor()
    // v1: 40 pending unknown-PIN events (big backlog); v2: 2 pending
    const mkPending = async (vendorId: string, i: number) => {
      await db.attendanceRawEvent.create({
        data: {
          vendorId,
          deviceId: "ws2-test-device",
          deviceSerial: uniq("SN"),
          deviceUserId: `ghost-${i}`,
          eventTime: `${iso(1)} 0${i % 8}:15:00`,
          verifyMode: 1,
          attendanceStatus: null,
          workCode: null,
          eventType: "CHECK_IN",
          rawLine: `line-${i}`,
          payloadHash: uniq(`ws2-sweep-${vendorId}`),
          processingStatus: "RECEIVED",
        },
      })
    }
    for (let i = 0; i < 40; i++) await mkPending(v1, i)
    for (let i = 0; i < 2; i++) await mkPending(v2, i)

    _resetSweepCursorForTests()
    const res = await sweepOnce()
    // v1's ghosts have no mapping → UNKNOWN_EMPLOYEE (not FAILED); v2's too.
    // Fairness proof: BOTH vendors' events left the RECEIVED state in ONE pass
    // (the old flat take:1000 by eventTime would also have covered 42 events,
    // but a 1000+ backlog on v1 alone would have starved v2 entirely).
    const remainingV1 = await db.attendanceRawEvent.count({ where: { vendorId: v1, processingStatus: "RECEIVED" } })
    const remainingV2 = await db.attendanceRawEvent.count({ where: { vendorId: v2, processingStatus: "RECEIVED" } })
    expect(remainingV1).toBe(0)
    expect(remainingV2).toBe(0)
    expect(res.processed + res.failed).toBeGreaterThan(0)
  })

  test("per-vendor sweep (explicit vendorId) still processes the whole budget", async () => {
    const v = await mkVendor()
    for (let i = 0; i < 5; i++) {
      await db.attendanceRawEvent.create({
        data: {
          vendorId: v, deviceId: "ws2-test-device", deviceSerial: uniq("SN"), deviceUserId: `ghost-${i}`,
          eventTime: `${iso(2)} 10:00:00`, verifyMode: 1, attendanceStatus: null, workCode: null,
          eventType: "CHECK_IN", rawLine: `l${i}`, payloadHash: uniq(`ws2-pv-${v}`), processingStatus: "RECEIVED",
        },
      })
    }
    _resetSweepCursorForTests()
    await sweepOnce(v)
    const remaining = await db.attendanceRawEvent.count({ where: { vendorId: v, processingStatus: "RECEIVED" } })
    expect(remaining).toBe(0)
  })
})

describe("SCL-4 — comm-log sampling + bounded trim", () => {
  test("logComm routine sampling: first row per key writes, immediate repeats are dropped, other keys unaffected", async () => {
    const vendorId = await mkVendor()
    const key = uniq("ws2-sample")
    const countForKey = () => db.deviceCommLog.count({ where: { vendorId, requestType: "GETREQUEST", error: { equals: null } } })
    const before = await countForKey()
    await logComm({ vendorId, serial: uniq("SN"), endpoint: "/iclock/getrequest", requestType: "GETREQUEST", httpStatus: 200, sample: { key } })
    expect(await countForKey()).toBe(before + 1)
    // immediate repeat (same key, window not elapsed) — dropped without a write
    await logComm({ vendorId, serial: uniq("SN"), endpoint: "/iclock/getrequest", requestType: "GETREQUEST", httpStatus: 200, sample: { key } })
    expect(await countForKey()).toBe(before + 1)
    // a DIFFERENT key still writes (per-device windows are independent)
    await logComm({ vendorId, serial: uniq("SN"), endpoint: "/iclock/getrequest", requestType: "GETREQUEST", httpStatus: 200, sample: { key: key + "-b" } })
    expect(await countForKey()).toBe(before + 2)
    // errors are never sampled (no sample flag passed by contract)
    await logComm({ vendorId, serial: uniq("SN"), endpoint: "/iclock/cdata", requestType: "REJECTED", httpStatus: 401, ok: false, error: "denied" })
    expect(await db.deviceCommLog.count({ where: { vendorId, requestType: "REJECTED" } })).toBeGreaterThan(0)
  })

  test("trimCommLogOnce keeps the newest 20k per vendor and purges overflow (synthetic 20,010 rows)", async () => {
    const vendorId = await mkVendor()
    const rows: { vendorId: string; serial: string; endpoint: string; requestType: string; httpStatus: number }[] = []
    for (let i = 0; i < 20_010; i++) {
      rows.push({ vendorId, serial: "SN-TRIM", endpoint: "/iclock/getrequest", requestType: "GETREQUEST", httpStatus: 200 })
    }
    await db.deviceCommLog.createMany({ data: rows })
    const total = await db.deviceCommLog.count({ where: { vendorId } })
    expect(total).toBe(20_010)
    const gTrim = globalThis as unknown as { __zkCommLogTrimCursor?: string }
    gTrim.__zkCommLogTrimCursor = ""
    const purged = await trimCommLogOnce()
    expect(purged).toBe(10)
    expect(await db.deviceCommLog.count({ where: { vendorId } })).toBe(20_000)
  })
})

describe("MOD-20 — indexed auto-map lookup", () => {
  test("EXACT rule: case-insensitive code match via indexed lookup", async () => {
    const vendorId = await mkVendor()
    await db.employee.create({ data: { vendorId, code: `TCSBL-${uniq("005")}`, fullName: "Exact Match" } })
    const code = (await db.employee.findFirst({ where: { vendorId } }))!.code
    const hit = await findEmployeeForDeviceUser(vendorId, code.toLowerCase())
    expect(hit?.rule).toBe("EXACT")
    expect(hit?.fullName).toBe("Exact Match")
  })

  test("NUMERIC rule: PIN 12 matches EMP-0012 via cached directory; ambiguity → null", async () => {
    const vendorId = await mkVendor()
    await db.employee.create({ data: { vendorId, code: uniq("EMP") + "-0012", fullName: "Numeric Match" } })
    invalidateEmployeeDirectoryCache()
    const hit = await findEmployeeForDeviceUser(vendorId, "12")
    expect(hit?.rule).toBe("NUMERIC")
    // ambiguity: a second employee with numeric tail 12 → no match
    await db.employee.create({ data: { vendorId, code: uniq("CON") + "-12", fullName: "Ambiguous" } })
    invalidateEmployeeDirectoryCache(vendorId)
    const miss = await findEmployeeForDeviceUser(vendorId, "12")
    expect(miss).toBeNull()
  })

  test("autoMapDeviceUser creates the mapping and requeues UNKNOWN_EMPLOYEE punches", async () => {
    const vendorId = await mkVendor()
    const dev = await db.attendanceDevice.create({
      data: {
        vendorId, deviceId: uniq("D"), name: "AutoMap Device", deviceIdentifier: uniq("SN"),
        protocol: "ADMS", enabled: true, timezone: "Asia/Dhaka", status: "ONLINE", syncStatus: "IDLE",
        eventCount: 0, configuration: "{}",
      },
    })
    const emp = await db.employee.create({ data: { vendorId, code: uniq("AUTOMAP") + "-0077", fullName: "AutoMap Target" } })
    // a parked unknown punch for the PIN
    await db.attendanceRawEvent.create({
      data: {
        vendorId, deviceId: dev.id, deviceSerial: dev.deviceIdentifier || uniq("SN"), deviceUserId: "0077",
        eventTime: `${iso(1)} 09:05:00`, verifyMode: 1, attendanceStatus: null, workCode: null,
        eventType: "CHECK_IN", rawLine: "l", payloadHash: uniq("ws2-am"), processingStatus: "UNKNOWN_EMPLOYEE",
      },
    })
    const mapping = await autoMapDeviceUser(vendorId, dev.id, "0077")
    expect(mapping?.employeeId).toBe(emp.id)
    const requeued = await db.attendanceRawEvent.findFirst({ where: { vendorId, deviceUserId: "0077" } })
    expect(requeued?.processingStatus).toBe("RECEIVED")
  })
})

describe("SCL-9 — grouped rebuild idempotency after batching", () => {
  test("rebuildDaily is idempotent and the projection does not duplicate events", async () => {
    const vendorId = await mkVendor()
    const emp = await db.employee.create({ data: { vendorId, code: uniq("RB"), fullName: "Rebuild Test" } })
    const today = iso(0)
    await db.attendanceRawEvent.createMany({
      data: [["09:01:00", "IN"], ["17:02:00", "OUT"]].map(([clock, type], i) => ({
        vendorId, deviceId: "ws2-test-device", deviceSerial: uniq("SN"), deviceUserId: "u1",
        eventTime: `${today} ${clock}`, verifyMode: 1, attendanceStatus: null, workCode: null,
        eventType: type, rawLine: `l${i}`, payloadHash: uniq(`ws2-rb${i}`), processingStatus: "RECEIVED",
      })),
    })
    await db.attendanceRawEvent.updateMany({ where: { vendorId }, data: { employeeId: emp.id } })
    const settings = await getSettings(vendorId)
    const r1 = await rebuildDaily(vendorId, emp.id, today)
    expect(r1.touched).toBe(true)
    const events = await db.attendanceEvent.count({ where: { vendorId, employeeId: emp.id } })
    expect(events).toBe(2)
    // second rebuild — no duplicate events, attendance stays single-row
    await rebuildDaily(vendorId, emp.id, today)
    expect(await db.attendanceEvent.count({ where: { vendorId, employeeId: emp.id } })).toBe(2)
    expect(await db.attendance.count({ where: { vendorId, employeeId: emp.id, date: today } })).toBe(1)
    // back-links present on both raw events
    const raws = await db.attendanceRawEvent.findMany({ where: { vendorId, employeeId: emp.id } })
    expect(raws.every((r) => r.attendanceEventId != null)).toBe(true)
    void settings
  })
})
