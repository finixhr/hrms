/// <reference types="bun-types" />
// ============ M3 (T-12) — offline outbox SERVER contract ============
// The mobile offline outbox (mobile/src/lib/offline.ts) records approved
// attendance punches on-device and replays them with the SAME clientEventId
// until the server accepts them. This suite pins the server half of that
// contract at the real dispatcher boundary (POST /api/hrm):
//
//   · idempotent replay: a retried punch whose first attempt was accepted
//     returns the recorded outcome (idempotentReplay: true) WITHOUT
//     re-running side effects — exactly ONE attendance row, ONE
//     AttendanceEvent, ONE selfie proof, ONE punch-confirmation
//     notification (the pre-M3 behavior stored the selfie bytes twice and
//     re-notified on every retry);
//   · replay precedence: the replay check runs before throttles/policy so a
//     retry can never be blocked by rate limits the original attempt
//     consumed, and before the H-4 first-in guard so a successful attempt is
//     never answered with a bogus "Already checked in today";
//   · duplicate semantics UNCHANGED for genuinely different events: a second
//     check-in with a DIFFERENT clientEventId still gets the H-4 denial;
//   · tenant isolation: the replay lookup is vendor-scoped — the same
//     clientEventId from another tenant is a new event, never a replay;
//   · offlineCapture classification: a punch recorded offline and submitted
//     within 120s is accepted like an online punch; a materially delayed
//     replay (>120s, or no device timestamp) flags the event
//     OFFLINE_CAPTURE → status REVIEW_REQUIRED + reviewStatus PENDING, with
//     the attendance row intact and HR notified.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { today } from "@/hrm-server/utils"
import { mkVendor, mkUser, mkEmployee, mkBranch, mkSession, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"

const FENCE = { lat: 23.8103, lng: 90.4125, radius: 500 }
// a tiny valid JPEG (SOI + APP0 JFIF header satisfies the byte-sniffer)
const SELFIE = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD//9k="

let vendor: { id: string }
let branch: { id: string }

async function mkSelfActor(name: string) {
  const emp = await mkEmployee(vendor.id, { branchId: branch.id, fullName: name })
  const user = await mkUser(vendor.id, { role: "EMPLOYEE", name, employeeId: emp.id })
  return { emp, token: await mkSession(user.id, "FULL") }
}

function geoPayload(clientEventId?: string, extra: Record<string, unknown> = {}) {
  return {
    latitude: FENCE.lat, longitude: FENCE.lng, accuracyM: 10,
    deviceInfo: "M3-outbox-test-device",
    clientTimestamp: new Date().toISOString(),
    ...(clientEventId ? { clientEventId } : {}),
    ...extra,
  }
}

function selfiePayload(clientEventId?: string, extra: Record<string, unknown> = {}) {
  return {
    selfieDataUrl: SELFIE,
    deviceInfo: "M3-outbox-test-device",
    clientTimestamp: new Date().toISOString(),
    ...(clientEventId ? { clientEventId } : {}),
    ...extra,
  }
}

function evtId(prefix: "ci" | "co" | "si", clientEventId: string) {
  return `${prefix}:${clientEventId}`
}

beforeAll(async () => {
  vendor = await mkVendor("M3 Outbox Vendor")
  branch = await db.branch.create({
    data: {
      vendorId: vendor.id, name: "M3 HQ", code: uniq("B"),
      latitude: FENCE.lat, longitude: FENCE.lng,
      geofenceRadius: FENCE.radius, geofenceActive: true,
    },
  })
})

describe("M3 · idempotent replay — geofence check-in", () => {
  test("retry with the same clientEventId returns the recorded outcome and writes nothing twice", async () => {
    const { emp, token } = await mkSelfActor("M3 Replay CI")
    const ceid = uniq("evt")
    const first = await postHrm("attendance.geofence.checkin", geoPayload(ceid), { bearer: token })
    expect(first.status).toBe(200)
    expect(first.body.data.idempotentReplay).toBeUndefined() // first attempt = a real punch

    const retry = await postHrm("attendance.geofence.checkin", geoPayload(ceid), { bearer: token })
    expect(retry.status).toBe(200)
    expect(retry.body.data.idempotentReplay).toBe(true)     // retry = replay, not a new punch

    // exactly ONE of every durable record — the pre-M3 handler re-ran side
    // effects on retry (duplicate event rows were prevented by the
    // unique(vendorId, clientEventId) index, but notifications and any
    // attached selfie proof were duplicated)
    expect(await db.attendance.count({ where: { vendorId: vendor.id, employeeId: emp.id, date: today() } })).toBe(1)
    expect(await db.attendanceEvent.count({ where: { vendorId: vendor.id, clientEventId: evtId("ci", ceid) } })).toBe(1)
    expect(await db.notification.count({ where: { vendorId: vendor.id, employeeId: emp.id, title: "Punch recorded" } })).toBe(1)

    // the replay echoes the recorded punch time, not a new one
    expect(retry.body.data.checkIn).toBe(first.body.data.checkIn)
  })

  test("replay of a REVIEW_REQUIRED punch keeps the review verdict (no silent downgrade)", async () => {
    const { emp, token } = await mkSelfActor("M3 Replay Review")
    const ceid = uniq("evt")
    // offline capture 3h old → REVIEW_REQUIRED on the first attempt
    const stale = new Date(Date.now() - 3 * 3600_000).toISOString()
    const first = await postHrm("attendance.geofence.checkin", geoPayload(ceid, { offlineCapture: true, clientTimestamp: stale }), { bearer: token })
    expect(first.status).toBe(200)

    const retry = await postHrm("attendance.geofence.checkin", geoPayload(ceid, { offlineCapture: true, clientTimestamp: stale }), { bearer: token })
    expect(retry.status).toBe(200)
    expect(retry.body.data.idempotentReplay).toBe(true)
    expect(retry.body.data.eventStatus).toBe("REVIEW_REQUIRED")
    expect(retry.body.data.reviewStatus).toBe("PENDING")
    expect(await db.attendanceEvent.count({ where: { vendorId: vendor.id, clientEventId: evtId("ci", ceid) } })).toBe(1)
    expect(await db.attendance.count({ where: { vendorId: vendor.id, employeeId: emp.id, date: today() } })).toBe(1)
  })
})

describe("M3 · idempotent replay — geofence check-out", () => {
  test("check-out retry with the same clientEventId replays without touching the record again", async () => {
    const { emp, token } = await mkSelfActor("M3 Replay CO")
    const ciId = uniq("evt")
    await postHrm("attendance.geofence.checkin", geoPayload(ciId), { bearer: token })

    const coId = uniq("evt")
    const first = await postHrm("attendance.geofence.checkout", geoPayload(coId), { bearer: token })
    expect(first.status).toBe(200)

    const retry = await postHrm("attendance.geofence.checkout", geoPayload(coId), { bearer: token })
    expect(retry.status).toBe(200)
    expect(retry.body.data.idempotentReplay).toBe(true)
    expect(retry.body.data.checkOut).toBe(first.body.data.checkOut)

    expect(await db.attendanceEvent.count({ where: { vendorId: vendor.id, clientEventId: evtId("co", coId) } })).toBe(1)
    expect(await db.attendance.count({ where: { vendorId: vendor.id, employeeId: emp.id, date: today() } })).toBe(1)
    expect(await db.notification.count({ where: { vendorId: vendor.id, employeeId: emp.id, title: "Punch recorded" } })).toBe(2) // one per punch (in + out), still one per punch after retry
  })
})

describe("M3 · idempotent replay — selfie check-in", () => {
  test("selfie retry stores the photo ONCE (no duplicate proof bytes) and replays the outcome", async () => {
    const { emp, token } = await mkSelfActor("M3 Replay SI")
    const ceid = uniq("evt")
    const first = await postHrm("attendance.selfie.checkin", selfiePayload(ceid), { bearer: token })
    expect(first.status).toBe(200)

    const retry = await postHrm("attendance.selfie.checkin", selfiePayload(ceid), { bearer: token })
    expect(retry.status).toBe(200)
    expect(retry.body.data.idempotentReplay).toBe(true)

    // THE selfie-specific guarantee: the pre-M3 retry re-stored the selfie
    // bytes as a second (orphaned) AttendanceProof row
    expect(await db.attendanceProof.count({ where: { vendorId: vendor.id, employeeId: emp.id } })).toBe(1)
    expect(await db.attendanceEvent.count({ where: { vendorId: vendor.id, clientEventId: evtId("si", ceid) } })).toBe(1)
    expect(await db.attendance.count({ where: { vendorId: vendor.id, employeeId: emp.id, date: today() } })).toBe(1)
    expect(await db.notification.count({ where: { vendorId: vendor.id, employeeId: emp.id, title: "Punch recorded" } })).toBe(1)
  })

  test("replay bypasses the selfie rate limiter the first attempt consumed (no 429 on retry)", async () => {
    const { token } = await mkSelfActor("M3 Replay Throttle")
    const ceid = uniq("evt")
    await postHrm("attendance.selfie.checkin", selfiePayload(ceid), { bearer: token })
    // the retry would be punch #2 within the window; the replay check runs
    // BEFORE guardSelfieRate, so it must still answer 200, not 429
    const retry = await postHrm("attendance.selfie.checkin", selfiePayload(ceid), { bearer: token })
    expect(retry.status).toBe(200)
    expect(retry.body.data.idempotentReplay).toBe(true)
  })
})

describe("M3 · duplicate semantics unchanged for DIFFERENT logical events", () => {
  test("a second check-in with a different clientEventId still gets the H-4 denial", async () => {
    const { token } = await mkSelfActor("M3 Distinct CI")
    await postHrm("attendance.geofence.checkin", geoPayload(uniq("evt")), { bearer: token })
    const second = await postHrm("attendance.geofence.checkin", geoPayload(uniq("evt")), { bearer: token })
    expect(second.status).toBe(400)
    expect(String(second.body.error)).toMatch(/already checked in/i)
  })
})

describe("M3 · replay lookup is tenant-scoped", () => {
  test("the same clientEventId from ANOTHER tenant is a new event, never a replay", async () => {
    const vendorB = await mkVendor("M3 Outbox Vendor B")
    const branchB = await db.branch.create({
      data: {
        vendorId: vendorB.id, name: "B HQ", code: uniq("B"),
        latitude: FENCE.lat, longitude: FENCE.lng,
        geofenceRadius: FENCE.radius, geofenceActive: true,
      },
    })
    const empA = await mkEmployee(vendor.id, { branchId: branch.id, fullName: "M3 Tenant A" })
    const userA = await mkUser(vendor.id, { role: "EMPLOYEE", name: "A", employeeId: empA.id })
    const tokenA = await mkSession(userA.id, "FULL")
    const empB = await mkEmployee(vendorB.id, { branchId: branchB.id, fullName: "M3 Tenant B" })
    const userB = await mkUser(vendorB.id, { role: "EMPLOYEE", name: "B", employeeId: empB.id })
    const tokenB = await mkSession(userB.id, "FULL")

    const sharedCeid = uniq("evt")
    const a = await postHrm("attendance.geofence.checkin", geoPayload(sharedCeid), { bearer: tokenA })
    expect(a.status).toBe(200)
    expect(a.body.data.idempotentReplay).toBeUndefined()

    const b = await postHrm("attendance.geofence.checkin", geoPayload(sharedCeid), { bearer: tokenB })
    expect(b.status).toBe(200)
    expect(b.body.data.idempotentReplay).toBeUndefined() // NOT a replay — vendor-scoped key

    // one event per vendor with the same logical key
    expect(await db.attendanceEvent.count({ where: { vendorId: vendor.id, clientEventId: evtId("ci", sharedCeid) } })).toBe(1)
    expect(await db.attendanceEvent.count({ where: { vendorId: vendorB.id, clientEventId: evtId("ci", sharedCeid) } })).toBe(1)
  })
})

describe("M3 · offlineCapture classification", () => {
  test("offline punch submitted within 120s → accepted like an online punch (no review)", async () => {
    const { emp, token } = await mkSelfActor("M3 Offline Fresh")
    const ceid = uniq("evt")
    const res = await postHrm("attendance.geofence.checkin", geoPayload(ceid, { offlineCapture: true }), { bearer: token })
    expect(res.status).toBe(200)
    const ev = await db.attendanceEvent.findFirst({ where: { vendorId: vendor.id, clientEventId: evtId("ci", ceid) } })
    expect(ev?.status).toBe("ACCEPTED")
    expect(ev?.reviewStatus).toBe("NONE")
    expect(String(ev?.flagsJson)).not.toContain("OFFLINE_CAPTURE")
    expect(String(ev?.reason)).toContain("recorded offline, submitted within 120s")
  })

  test("offline punch submitted 3h later → event flagged OFFLINE_CAPTURE for review, attendance row intact", async () => {
    const { emp, token } = await mkSelfActor("M3 Offline Stale")
    // the review notification targets { role: "HR_ADMIN" } — the vendor needs
    // one for the notification row to exist
    const hr = await mkUser(vendor.id, { role: "HR_ADMIN", name: "M3 HR Admin" })
    void hr
    const ceid = uniq("evt")
    const stale = new Date(Date.now() - 3 * 3600_000).toISOString()
    const res = await postHrm("attendance.geofence.checkin", geoPayload(ceid, { offlineCapture: true, clientTimestamp: stale }), { bearer: token })
    expect(res.status).toBe(200)

    // the punch is real: attendance row exists with the punch recorded
    const rec = await db.attendance.findFirst({ where: { vendorId: vendor.id, employeeId: emp.id, date: today() } })
    expect(rec?.checkIn).toBeTruthy()

    // but it is NOT silently approved: event queued for review with the
    // preserved device timestamp as evidence
    const ev = await db.attendanceEvent.findFirst({ where: { vendorId: vendor.id, clientEventId: evtId("ci", ceid) } })
    expect(ev?.status).toBe("REVIEW_REQUIRED")
    expect(ev?.reviewStatus).toBe("PENDING")
    expect(ev?.clientTimestamp).toBe(stale)
    expect(String(ev?.flagsJson)).toContain("OFFLINE_CAPTURE")
    expect(String(ev?.reason)).toContain("recorded offline, submitted")

    // HR was notified for the review queue
    expect(await db.notification.count({ where: { vendorId: vendor.id, title: "Attendance Needs Review" } })).toBeGreaterThanOrEqual(1)
  })

  test("offline capture WITHOUT a device timestamp → conservative review", async () => {
    const { token } = await mkSelfActor("M3 Offline NoTs")
    const ceid = uniq("evt")
    const res = await postHrm("attendance.selfie.checkin", { ...selfiePayload(ceid, { offlineCapture: true }), clientTimestamp: undefined }, { bearer: token })
    expect(res.status).toBe(200)
    const ev = await db.attendanceEvent.findFirst({ where: { vendorId: vendor.id, clientEventId: evtId("si", ceid) } })
    expect(ev?.status).toBe("REVIEW_REQUIRED")
    expect(ev?.reviewStatus).toBe("PENDING")
    expect(String(ev?.flagsJson)).toContain("OFFLINE_CAPTURE")
  })

  test("delayed offline check-OUT is flagged the same way", async () => {
    const { token } = await mkSelfActor("M3 Offline CO")
    await postHrm("attendance.geofence.checkin", geoPayload(uniq("evt")), { bearer: token })
    const coId = uniq("evt")
    const stale = new Date(Date.now() - 2 * 3600_000).toISOString()
    const res = await postHrm("attendance.geofence.checkout", geoPayload(coId, { offlineCapture: true, clientTimestamp: stale }), { bearer: token })
    expect(res.status).toBe(200)
    const ev = await db.attendanceEvent.findFirst({ where: { vendorId: vendor.id, clientEventId: evtId("co", coId) } })
    expect(ev?.status).toBe("REVIEW_REQUIRED")
    expect(String(ev?.flagsJson)).toContain("OFFLINE_CAPTURE")
  })

  test("online punch (no offlineCapture) is completely unaffected", async () => {
    const { token } = await mkSelfActor("M3 Online Plain")
    const ceid = uniq("evt")
    const res = await postHrm("attendance.geofence.checkin", geoPayload(ceid, { clientTimestamp: new Date(Date.now() - 5 * 3600_000).toISOString() }), { bearer: token })
    expect(res.status).toBe(200)
    const ev = await db.attendanceEvent.findFirst({ where: { vendorId: vendor.id, clientEventId: evtId("ci", ceid) } })
    // a stale clientTimestamp on an ONLINE punch is a clock-skew question for
    // location integrity, NOT an offline capture — no OFFLINE_CAPTURE flag
    expect(String(ev?.flagsJson)).not.toContain("OFFLINE_CAPTURE")
  })
})
