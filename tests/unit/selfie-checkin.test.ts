/// <reference types="bun-types" />
// ============ §28 — attendance.selfie.checkin (ESS portal selfie punch) ============
// The SELFIE check-in method was dead code: enforceMethodPolicy had a branch
// for selfie-without-GPS, but the only self check-in routes required GPS
// coordinates, and the portal had no selfie button at all. This suite pins
// the capability-gated route:
//   - policy gate: policy without SELFIE → 403
//   - Selfie Attendance G1: NO ATTENDANCE_METHOD policy → permissive legacy
//     default (parity with enforceMethodPolicy on the geo routes): the punch
//     lands as SELFIE/GEOFENCE_SELFIE so the portal buttons work out of the box
//   - happy path: SELFIE policy + selfie payload (no GPS) → attendance row +
//     AttendanceEvent (method SELFIE) + private proof row
//   - happy path: selfie WITH coordinates → method GEOFENCE_SELFIE (fence
//     validation still applies when GPS is present)
//   - requireGeofence policy + no GPS → 403
//   - H-4 parity: second selfie punch → "Already checked in today"
// All assertions drive POST /api/hrm (the real dispatcher boundary).
// NOTE on policy isolation: every mkMethodPolicy call uses an INCREASING
// priority — resolveEffectivePolicy breaks (rank, priority) ties with the
// first-created assignment, so a flat priority made test 2's no-selfie policy
// shadow every later test (the original suite failed 5/7 that way).
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { today } from "@/hrm-server/utils"
import { mkVendor, mkUser, mkEmployee, mkBranch, mkSession, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"

const FENCE = { lat: 23.8103, lng: 90.4125, radius: 500 }
// a tiny valid JPEG (SOI + APP0 JFIF header is enough for the byte-sniffer)
const SELFIE = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD//9k="

let vendor: { id: string }
let branchId: string

async function mkActor(name: string) {
  const emp = await mkEmployee(vendor.id, { branchId, fullName: name })
  const user = await mkUser(vendor.id, { role: "EMPLOYEE", name, employeeId: emp.id })
  return { emp, token: await mkSession(user.id, "FULL") }
}

// increasing per call — see the file header note on policy isolation
let policySeq = 0
async function mkMethodPolicy(methods: string[], requireGeofence: boolean) {
  const priority = 100 + ++policySeq * 10
  const policy = await db.attendancePolicy.create({
    data: {
      vendorId: vendor.id, name: `SI ${methods.join("+")} ${uniq()}`,
      policyType: "ATTENDANCE_METHOD", active: true, priority,
      daysOfWeek: "SUNDAY,MONDAY,TUESDAY,WEDNESDAY,THURSDAY,FRIDAY,SATURDAY",
      configJson: JSON.stringify({ methods, selfieRequired: false, requireGeofence }),
    },
  })
  await db.attendancePolicyAssignment.create({
    data: { vendorId: vendor.id, policyId: policy.id, scopeType: "ALL_EMPLOYEES", scopeId: null },
  })
  return policy.id
}

beforeAll(async () => {
  vendor = await mkVendor("Selfie CheckIn Vendor")
  const branch = await db.branch.create({
    data: {
      vendorId: vendor.id, name: "SI HQ", code: uniq("B"),
      latitude: FENCE.lat, longitude: FENCE.lng,
      geofenceRadius: FENCE.radius, geofenceActive: true,
    },
  })
  branchId = branch.id
})

describe("attendance.selfie.checkin — policy gate", () => {
  test("NO ATTENDANCE_METHOD policy → permissive legacy default (G1 parity with the geo routes): punch lands, method SELFIE", async () => {
    const { emp, token } = await mkActor("SI NoPolicy")
    const res = await postHrm("attendance.selfie.checkin", { selfieDataUrl: SELFIE }, { bearer: token })
    expect(res.status).toBe(200)
    const rec = await db.attendance.findFirst({ where: { vendorId: vendor.id, employeeId: emp.id, date: today() } })
    expect(rec?.checkIn).toBeTruthy()
    const ev = await db.attendanceEvent.findFirst({
      where: { vendorId: vendor.id, employeeId: emp.id, eventType: "CHECK_IN" },
      orderBy: { createdAt: "desc" as const },
    })
    expect(ev?.attendanceMethod).toBe("SELFIE")
  })

  test("policy without SELFIE → 403 listing the allowed methods", async () => {
    await mkMethodPolicy(["GEOFENCE", "DEVICE_PUNCH"], false)
    const { emp, token } = await mkActor("SI NoSelfie")
    const res = await postHrm("attendance.selfie.checkin", { selfieDataUrl: SELFIE }, { bearer: token })
    expect(res.status).toBe(403)
    expect(String(res.body?.error || "")).toMatch(/not allowed by your attendance policy/i)
    expect(String(res.body?.error || "")).toContain("GEOFENCE")
    expect(await db.attendance.findFirst({ where: { vendorId: vendor.id, employeeId: emp.id } })).toBeNull()
  })
})

describe("attendance.selfie.checkin — happy paths", () => {
  test("SELFIE policy + selfie without GPS → attendance row + SELFIE event + private proof", async () => {
    await mkMethodPolicy(["SELFIE", "GEOFENCE"], false)
    const { emp, token } = await mkActor("SI Plain")
    const res = await postHrm("attendance.selfie.checkin", {
      selfieDataUrl: SELFIE, deviceInfo: "si-test", clientTimestamp: new Date().toISOString(),
    }, { bearer: token })
    expect(res.status).toBe(200)
    const rec = await db.attendance.findFirst({ where: { vendorId: vendor.id, employeeId: emp.id, date: today() } })
    expect(rec?.checkIn).toBeTruthy()
    expect(rec?.checkOut).toBeNull()
    // event with the resolved method + no-fence reason
    const ev = await db.attendanceEvent.findFirst({
      where: { vendorId: vendor.id, employeeId: emp.id, eventType: "CHECK_IN" },
      orderBy: { createdAt: "desc" as const },
    })
    expect(ev?.attendanceMethod).toBe("SELFIE")
    expect(String(ev?.reason || "")).toMatch(/no GPS fix/i)
    // private proof stored and linked to the event
    const proof = await db.attendanceProof.findFirst({ where: { vendorId: vendor.id, employeeId: emp.id } })
    expect(proof).toBeTruthy()
    expect(proof?.attendanceEventId).toBe(ev?.id)
    expect(proof?.mimeType).toBe("image/jpeg")
  })

  test("SELFIE policy + selfie WITH in-fence coordinates → method GEOFENCE_SELFIE + fence match", async () => {
    await mkMethodPolicy(["SELFIE", "GEOFENCE_SELFIE", "GEOFENCE"], false)
    const { emp, token } = await mkActor("SI WithGps")
    const res = await postHrm("attendance.selfie.checkin", {
      selfieDataUrl: SELFIE,
      latitude: FENCE.lat, longitude: FENCE.lng, accuracyM: 10,
    }, { bearer: token })
    expect(res.status).toBe(200)
    expect(res.body?.data?.fence).toBeTruthy()
    const ev = await db.attendanceEvent.findFirst({
      where: { vendorId: vendor.id, employeeId: emp.id, eventType: "CHECK_IN" },
      orderBy: { createdAt: "desc" as const },
    })
    expect(ev?.attendanceMethod).toBe("GEOFENCE_SELFIE")
  })

  test("requireGeofence policy + no GPS → 403 (GPS stays mandatory)", async () => {
    await mkMethodPolicy(["SELFIE", "GEOFENCE_SELFIE"], true)
    const { token } = await mkActor("SI ReqGeo")
    const res = await postHrm("attendance.selfie.checkin", { selfieDataUrl: SELFIE }, { bearer: token })
    expect(res.status).toBe(403)
    expect(String(res.body?.error || "")).toMatch(/requires GPS/i)
  })
})

describe("attendance.selfie.checkin — guards", () => {
  test("second selfie punch the same day → 'Already checked in today' (H-4 parity)", async () => {
    await mkMethodPolicy(["SELFIE"], false)
    const { emp, token } = await mkActor("SI Twice")
    const first = await postHrm("attendance.selfie.checkin", { selfieDataUrl: SELFIE }, { bearer: token })
    expect(first.status).toBe(200)
    // the M-14 selfie throttle allows 12/10min — the second punch hits the H-4 guard first
    const second = await postHrm("attendance.selfie.checkin", { selfieDataUrl: SELFIE }, { bearer: token })
    expect(second.status).toBe(400)
    expect(String(second.body?.error || "")).toMatch(/already checked in/i)
    const recs = await db.attendance.findMany({ where: { vendorId: vendor.id, employeeId: emp.id } })
    expect(recs.length).toBe(1)
  })

  test("garbage selfie payload → byte-sniff rejection (400), nothing written", async () => {
    await mkMethodPolicy(["SELFIE"], false)
    const { emp, token } = await mkActor("SI Garbage")
    const res = await postHrm("attendance.selfie.checkin", {
      selfieDataUrl: "data:image/jpeg;base64,bm90LWFuLWltYWdl", // base64 of "not-an-image"
    }, { bearer: token })
    expect(res.status).toBe(400)
    expect(String(res.body?.error || "")).toMatch(/selfie|image/i)
    expect(await db.attendance.findFirst({ where: { vendorId: vendor.id, employeeId: emp.id } })).toBeNull()
  })
})
