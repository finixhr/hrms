/// <reference types="bun-types" -*-
// ============ M-14/M-15 regression: selfie throttle + zod + fence-REVIEW trail ============
// M-14 (Medium): the selfie rate-limit preset (12/10min) existed in
// RATE_LIMITS but was never wired; the geo-attendance routes declared NO zod
// schema (any shape reached the handler); the dispatcher read bodies with no
// cap (multi-MB base64 decoded before any post-check).
//
// M-15 (Medium): a fence REVIEW verdict threw a review-flagged Deny that no
// caller caught — poor-GPS employees were hard-rejected with NO
// REVIEW_REQUIRED event, no audit row, no review-queue entry, contradicting
// the §23/§25 design intent.
//
// Route-layer: everything drives POST /api/hrm.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkBranch, mkSession, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"

const FENCE = { lat: 23.8103, lng: 90.4125, radius: 500 }

let vendor: { id: string }
let token: string
let employee: { id: string }

async function mkActor(name: string) {
  const emp = await mkEmployee(vendor.id, { branchId: branchId!, fullName: name })
  const user = await mkUser(vendor.id, { role: "EMPLOYEE", name, employeeId: emp.id })
  return { emp, token: await mkSession(user.id, "FULL") }
}
let branchId: string

beforeAll(async () => {
  vendor = await mkVendor("M14M15 Vendor")
  const branch = await db.branch.create({
    data: {
      vendorId: vendor.id, name: "M14 HQ", code: uniq("B"),
      latitude: FENCE.lat, longitude: FENCE.lng,
      geofenceRadius: FENCE.radius, geofenceActive: true,
    },
  })
  branchId = branch.id
  const admin = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "M14 Admin" })
  token = await mkSession(admin.id, "FULL")
  employee = await mkEmployee(vendor.id, { branchId: branch.id, fullName: "M15 Poor GPS" })
})

describe("M-14 geo routes are zod-validated and body-capped", () => {
  test("geofence.checkin rejects a payload without coordinates (400 validation)", async () => {
    const { token: t } = await mkActor("M14 NoGPS")
    const res = await postHrm("attendance.geofence.checkin", { deviceInfo: "no coords" }, { bearer: t })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/latitude|coordinates/i)
  })

  test("selfie uploads are throttled at 12 per 10 minutes (preset wired)", async () => {
    const { emp, token: t } = await mkActor("M14 Selfie")
    const payload = {
      latitude: FENCE.lat, longitude: FENCE.lng, accuracyM: 10,
      deviceInfo: "M14", clientTimestamp: new Date().toISOString(),
      selfieDataUrl: "data:image/jpeg;base64,M14",
    }
    let last = 200
    for (let i = 0; i < 14; i++) {
      const res = await postHrm("attendance.geofence.checkin", payload, { bearer: t })
      last = res.status
      if (res.status === 429) break
    }
    expect(last).toBe(429) // ← was 200 forever (preset never wired)
    expect(await db.attendance.findFirst({ where: { vendorId: vendor.id, employeeId: emp.id } })).toBeTruthy()
  })

  test("the dispatcher caps oversized bodies before parsing (413)", async () => {
    const huge = "x".repeat(9 * 1024 * 1024) // 9 MB > 8 MB cap
    const res = await postHrm("attendance.geofence.checkin", { latitude: 1, longitude: 1, deviceInfo: huge }, { bearer: token })
    expect(res.status).toBe(413)
  })
})

describe("M-15 a fence REVIEW verdict leaves a review trail", () => {
  test("poor-accuracy inside-fence check-in is denied BUT recorded as REVIEW_REQUIRED", async () => {
    const { emp, token: t } = await mkActor("M15 Review")
    // inside the fence but with unusable accuracy → evaluateFences REVIEW verdict
    const res = await postHrm("attendance.geofence.checkin", {
      latitude: FENCE.lat, longitude: FENCE.lng, accuracyM: 50_000,
      deviceInfo: "M15", clientTimestamp: new Date().toISOString(),
    }, { bearer: t })
    // the denial still surfaces…
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/accuracy|review/i)
    // …but now a REVIEW_REQUIRED AttendanceEvent exists (was: no trail at all)
    const ev = await db.attendanceEvent.findFirst({
      where: { vendorId: vendor.id, employeeId: emp.id, status: "REVIEW_REQUIRED" },
      orderBy: { createdAt: "desc" as const },
    })
    expect(ev).toBeTruthy()
    expect(ev?.eventType).toBe("CHECK_IN")
    expect(String(ev?.reason || "")).toMatch(/needs review/i)
    // …and an audit row documents the flagged attempt
    const log = await db.auditLog.findFirst({
      where: { vendorId: vendor.id, action: "attendance.geofence.checkin" },
      orderBy: { createdAt: "desc" as const },
    })
    expect(String(log?.summary || "")).toMatch(/flagged for review/i)
    // no attendance record was written for the denied attempt
    expect(await db.attendance.findFirst({ where: { vendorId: vendor.id, employeeId: emp.id } })).toBeNull()
  })
})
