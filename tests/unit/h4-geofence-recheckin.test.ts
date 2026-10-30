/// <reference types="bun-types" />
// ============ H-4 regression: geofence re-check-in must not corrupt the day ============
// Audit H-4 (High): attendance.geofence.checkin had no re-entry guard and
// reused the manual-mark upsert whose update branch is a full-row overwrite.
// 09:00 in → 17:00 out → an accidental 22:00 re-check-in produced
// checkIn=22:00, checkOut=null, workingMinutes=0, status=LATE — payroll-affecting
// corruption of the daily summary, inconsistent with the biometric engine's
// first-in/last-out rule.
//
// Fix under test (first-in / last-out, biometric parity):
//   - a re-check-in at/after the recorded check-in ADDS NOTHING → clear
//     "Already checked in today" denial, record untouched
//   - an EARLIER punch moves the check-in back but NEVER nulls checkOut
//   - a first check-in of the day still works (no over-blocking)
//
// All assertions drive POST /api/hrm (the real dispatcher boundary).
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { today, hhmm } from "@/hrm-server/utils"
import { mkVendor, mkUser, mkEmployee, mkBranch, mkSession, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"

const FENCE = { lat: 23.8103, lng: 90.4125, radius: 500 }

let vendor: { id: string }
let branch: { id: string }

/** Fresh employee + linked EMPLOYEE user + FULL session per scenario (each
 *  test seeds its own day-row; the [vendorId, employeeId, date] unique key
 *  forbids sharing one employee across scenarios). */
async function mkSelfActor(name: string) {
  const emp = await mkEmployee(vendor.id, { branchId: branch.id, fullName: name })
  const user = await mkUser(vendor.id, { role: "EMPLOYEE", name, employeeId: emp.id })
  return { emp, token: await mkSession(user.id, "FULL") }
}

async function seedDay(employeeId: string, checkIn: string, checkOut: string | null, workingMinutes = 480) {
  return db.attendance.create({
    data: {
      vendorId: vendor.id, employeeId, date: today(),
      checkIn, checkOut, workingMinutes, lateMinutes: 0, earlyLeaveMinutes: 0,
      overtimeMinutes: 0, status: "PRESENT", source: "GEOFENCE",
    },
  })
}

function geoPayload() {
  return {
    latitude: FENCE.lat, longitude: FENCE.lng, accuracyM: 10,
    deviceInfo: "H4-test-device", clientTimestamp: new Date().toISOString(),
  }
}

async function currentRecord(employeeId: string) {
  return db.attendance.findFirst({ where: { vendorId: vendor.id, employeeId, date: today() } })
}

beforeAll(async () => {
  vendor = await mkVendor("H4 Geofence Vendor")
  branch = await db.branch.create({
    data: {
      vendorId: vendor.id, name: "H4 HQ", code: uniq("B"),
      latitude: FENCE.lat, longitude: FENCE.lng,
      geofenceRadius: FENCE.radius, geofenceActive: true,
    },
  })
})

describe("H-4 geofence re-check-in keeps first-in / last-out semantics", () => {
  test("check-in → check-out → accidental re-check-in: the day is NOT corrupted", async () => {
    const { emp, token } = await mkSelfActor("H4 Corrupt")
    const seeded = await seedDay(emp.id, "00:01", "17:00", 1020) // earliest possible check-in ⇒ any re-check-in is later
    const res = await postHrm("attendance.geofence.checkin", geoPayload(), { bearer: token })
    // the re-check-in adds nothing → clear denial (the checkout route denies the same way)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/already checked in/i)
    // record retains the original first-in / last-out and derived minutes
    const rec = await currentRecord(emp.id)
    expect(rec?.id).toBe(seeded.id)
    expect(rec?.checkIn).toBe("00:01")   // ← was overwritten with the re-check-in time
    expect(rec?.checkOut).toBe("17:00")  // ← was nulled
    expect(rec?.workingMinutes).toBe(1020)
    expect(rec?.status).toBe("PRESENT")  // ← became LATE with 0 minutes
  })

  test("an EARLIER punch moves the check-in back but never touches the check-out", async () => {
    const { emp, token } = await mkSelfActor("H4 Earlier")
    // seed the latest possible check-in ⇒ the route's hhmm() is earlier (except
    // in the 23:59–00:00 minute — see the guard below)
    const seeded = await seedDay(emp.id, "23:59", "17:00", 0)
    const now = hhmm()
    if (now === "23:59") {
      // single-minute edge: no earlier punch exists; the invariant below still
      // holds via the denial path — assert it and return.
      const res = await postHrm("attendance.geofence.checkin", geoPayload(), { bearer: token })
      expect(res.status).toBe(400)
      const rec = await currentRecord(emp.id)
      expect(rec?.checkOut).toBe("17:00")
      return
    }
    const res = await postHrm("attendance.geofence.checkin", geoPayload(), { bearer: token })
    expect(res.status).toBe(200)
    const rec = await currentRecord(emp.id)
    expect(rec?.id).toBe(seeded.id)
    expect(rec?.checkIn).toBe(now)      // first-in moved back to the earlier punch
    expect((rec?.checkIn ?? "23:59") < "23:59").toBe(true)
    expect(rec?.checkOut).toBe("17:00") // last-out preserved — NEVER nulled
  })

  test("control: the FIRST check-in of the day still works (no over-blocking)", async () => {
    const { emp, token } = await mkSelfActor("H4 Fresh")
    const res = await postHrm("attendance.geofence.checkin", geoPayload(), { bearer: token })
    expect(res.status).toBe(200)
    const rec = await db.attendance.findFirst({ where: { vendorId: vendor.id, employeeId: emp.id, date: today() } })
    expect(rec?.checkIn).toBe(hhmm())
    expect(rec?.checkOut).toBeNull()
  })
})
