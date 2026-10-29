/// <reference types="bun-types" />
// ============ FF History + Location Hit Map regression (2026-10-13) ============
// Field Force → History → Employee:
//   · fieldforce.history — one row per (employee, business date): separate
//     rows for different dates, correct planned/completed/ad-hoc counts,
//     GPS ping counts, range validation, EMPLOYEE role denied (perm gate)
//   · fieldforce.hitmap — planned stops with radius, recorded visits with
//     duration, the ordered GPS track, and derived (unplanned) stoppages;
//     a derived stop overlapping a recorded visit is not double-counted;
//     cross-tenant employee ids surface as 404
//   · detectTrackStoppages — stationary clusters become stoppages with the
//     right duration; transit never does
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkSession, mkEmployee, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { fromZonedWall } from "@/hrm-server/utils"
import { detectTrackStoppages } from "@/hrm-server/routes/fieldforce"

const DAY = "2026-10-10"
const DAY2 = "2026-10-11"
/** deployment-zone wall-clock string → true instant (same math as dayRange) */
const at = (wall: string) => fromZonedWall(wall)

describe("detectTrackStoppages (pure)", () => {
  const base = at(`${DAY}T10:00:00`).getTime()

  test("a stationary cluster becomes ONE stoppage with the right duration", () => {
    // 12 fixes, one per minute, all at the same spot → 11-minute stop
    const pts = Array.from({ length: 12 }, (_, i) => ({
      latitude: 23.8001, longitude: 90.4001, timestamp: new Date(base + i * 60_000),
    }))
    const stops = detectTrackStoppages(pts)
    expect(stops.length).toBe(1)
    expect(stops[0].durationMin).toBe(11)
    expect(stops[0].pointCount).toBe(12)
  })

  test("transit (every fix beyond the anchor radius) produces no stoppages", () => {
    // 30 fixes every 2 minutes, each ~220 m apart — beyond the 75 m anchor radius
    const pts = Array.from({ length: 30 }, (_, i) => ({
      latitude: 23.8 + i * 0.002, longitude: 90.4, timestamp: new Date(base + i * 120_000),
    }))
    expect(detectTrackStoppages(pts).length).toBe(0)
  })

  test("two clusters separated by a drive produce exactly two stoppages", () => {
    const pts: { latitude: number; longitude: number; timestamp: Date }[] = []
    for (let i = 0; i < 6; i++) pts.push({ latitude: 23.8000, longitude: 90.4000, timestamp: new Date(base + i * 60_000) }) // 5 min at A
    pts.push({ latitude: 23.8200, longitude: 90.4200, timestamp: new Date(base + 10 * 60_000) }) // the drive (far away)
    for (let i = 0; i < 7; i++) pts.push({ latitude: 23.8210, longitude: 90.4210, timestamp: new Date(base + (12 + i) * 60_000) }) // 6 min at B
    const stops = detectTrackStoppages(pts)
    expect(stops.length).toBe(2)
    expect(stops[0].durationMin).toBe(5)
    expect(stops[1].durationMin).toBe(6)
  })
})

describe("fieldforce.history + fieldforce.hitmap (route boundary)", () => {
  let vendor: { id: string }
  let admin: { id: string; token: string }
  let otherVendorAdminToken: string
  let employeeToken: string
  let emp: { id: string }
  let locA: { id: string }; let locB: { id: string }; let locD: { id: string }
  let itemA: { id: string }
  let dayPings = 0

  beforeAll(async () => {
    vendor = await mkVendor("FF Hist Vendor")
    const u = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "FF Hist Admin" })
    admin = { id: u.id, token: await mkSession(u.id, "FULL") }

    // cross-tenant probe vendor
    const ov = await mkVendor("FF Hist Other Vendor")
    const ou = await mkUser(ov.id, { role: "VENDOR_OWNER", name: "FF Other Admin" })
    otherVendorAdminToken = await mkSession(ou.id, "FULL")

    emp = await mkEmployee(vendor.id, { fullName: "FF Hist Rep" })
    const eu = await mkUser(vendor.id, { role: "EMPLOYEE", email: `ff-hist-emp-${uniq()}@test.example`, employeeId: emp.id })
    employeeToken = await mkSession(eu.id, "FULL")

    locA = await db.visitLocation.create({ data: { vendorId: vendor.id, name: `FF Client A ${uniq()}`, lat: 23.8000, lng: 90.4000, radiusM: 150 } })
    locB = await db.visitLocation.create({ data: { vendorId: vendor.id, name: `FF Client B ${uniq()}`, lat: 23.8100, lng: 90.4100, radiusM: 150 } })
    const locC = await db.visitLocation.create({ data: { vendorId: vendor.id, name: `FF Client C ${uniq()}`, lat: 23.8300, lng: 90.4300, radiusM: 150 } })
    locD = await db.visitLocation.create({ data: { vendorId: vendor.id, name: `FF Ad-hoc Spot ${uniq()}`, lat: 23.8150, lng: 90.4150, radiusM: 150 } })

    // DAY plan: two stops (A morning, B noon) — saved through the real API
    const save = await postHrm("fieldforce.plan.save", {
      employeeId: emp.id, date: DAY,
      items: [
        { locationId: locA.id, plannedFrom: "09:00", plannedTo: "10:00", tasks: "Stock check" },
        { locationId: locB.id, plannedFrom: "11:00", plannedTo: "12:00" },
      ],
    }, { bearer: admin.token })
    expect(save.body.ok).toBe(true)
    itemA = (await db.visitPlanItem.findFirst({ where: { vendorId: vendor.id, locationId: locA.id } }))!

    // DAY2 plan: one stop (C)
    const save2 = await postHrm("fieldforce.plan.save", {
      employeeId: emp.id, date: DAY2, items: [{ locationId: locC.id, plannedFrom: "10:00", plannedTo: "11:00" }],
    }, { bearer: admin.token })
    expect(save2.body.ok).toBe(true)

    // DAY activity: completed visit at A (09:05 → 09:50, 45 min), open ad-hoc
    // visit at D (14:00, never checked out), GPS track: stationary at A while
    // visiting (46 fixes), a short drive, stationary at D (21 fixes)
    await db.visit.create({
      data: {
        vendorId: vendor.id, employeeId: emp.id, planItemId: itemA.id, locationId: locA.id,
        checkInAt: at(`${DAY}T09:05:00`), checkOutAt: at(`${DAY}T09:50:00`), durationMin: 45,
        checkInLat: 23.8005, checkInLng: 90.4005, status: "COMPLETED",
      },
    })
    await db.visit.create({
      data: {
        vendorId: vendor.id, employeeId: emp.id, planItemId: null, locationId: locD.id,
        checkInAt: at(`${DAY}T14:00:00`), checkInLat: 23.8155, checkInLng: 90.4155, status: "CHECKED_IN",
      },
    })
    const t0 = at(`${DAY}T09:05:00`).getTime()
    const trackRows: any[] = []
    for (let i = 0; i < 46; i++) trackRows.push({ vendorId: vendor.id, employeeId: emp.id, timestamp: new Date(t0 + i * 60_000), latitude: 23.8005, longitude: 90.4005 })
    for (let i = 0; i < 8; i++) trackRows.push({ vendorId: vendor.id, employeeId: emp.id, timestamp: new Date(at(`${DAY}T13:50:00`).getTime() + i * 60_000), latitude: 23.8005 + i * 0.002, longitude: 90.4005 + i * 0.002 })
    for (let i = 0; i < 21; i++) trackRows.push({ vendorId: vendor.id, employeeId: emp.id, timestamp: new Date(at(`${DAY}T14:00:00`).getTime() + i * 60_000), latitude: 23.8155, longitude: 90.4155 })
    await db.trackingPoint.createMany({ data: trackRows })
    dayPings = trackRows.length
  })

  test("EMPLOYEE role is denied (fieldforce.view permission gate)", async () => {
    const res = await postHrm("fieldforce.history", { from: DAY, to: DAY2 }, { bearer: employeeToken })
    expect(res.status).toBe(403)
  })

  test("inverted range is a clean 400", async () => {
    const res = await postHrm("fieldforce.history", { from: DAY2, to: DAY }, { bearer: admin.token })
    expect(res.body.ok).toBe(false)
    expect(res.body.code).toBe(400)
  })

  test("one row per (employee, date) — separate rows for different dates, newest first", async () => {
    const res = await postHrm("fieldforce.history", { from: DAY, to: DAY2, employeeId: emp.id }, { bearer: admin.token })
    expect(res.body.ok).toBe(true)
    const rows = res.body.data.rows
    expect(rows.length).toBe(2)
    expect(rows[0].date).toBe(DAY2)
    expect(rows[1].date).toBe(DAY)
    const day1 = rows[1]
    expect(day1.employeeId).toBe(emp.id)
    expect(day1.planned).toBe(2)
    expect(day1.completed).toBe(1)
    expect(day1.missed).toBe(0)
    expect(day1.adHoc).toBe(1)
    expect(day1.open).toBe(1)
    expect(day1.gpsPings).toBe(dayPings)
    const day2 = rows[0]
    expect(day2.planned).toBe(1)
    expect(day2.gpsPings).toBe(0)
  })

  test("narrow range drops the out-of-range plan day", async () => {
    const res = await postHrm("fieldforce.history", { from: DAY, to: DAY, employeeId: emp.id }, { bearer: admin.token })
    expect(res.body.ok).toBe(true)
    expect(res.body.data.rows.length).toBe(1)
    expect(res.body.data.rows[0].date).toBe(DAY)
  })

  test("hitmap: planned stops, visits, ordered track and derived stoppages", async () => {
    const res = await postHrm("fieldforce.hitmap", { employeeId: emp.id, date: DAY }, { bearer: admin.token })
    expect(res.body.ok).toBe(true)
    const d = res.body.data
    // planned stops carry the location radius and the recorded visit
    expect(d.planned.length).toBe(2)
    const stopA = d.planned.find((p: any) => p.locationId === locA.id)
    expect(stopA.radiusM).toBe(150)
    expect(stopA.visitStatus).toBe("COMPLETED")
    expect(stopA.durationMin).toBe(45)
    expect(stopA.outOfRadius).toBe(false)
    // 1 linked + 1 ad-hoc visit
    expect(d.visits.length).toBe(2)
    expect(d.visits.some((v: any) => v.planItemId == null)).toBe(true)
    // the full GPS trail, ordered, undownsampled at this size
    expect(d.totalPings).toBe(dayPings)
    expect(d.track.length).toBe(dayPings)
    const ats = d.track.map((t: any) => Date.parse(t.at))
    expect(ats.every((t: number, i: number) => i === 0 || ats[i - 1] <= t)).toBe(true)
    // derived stoppages: the ~21-minute wait at the ad-hoc spot survives (the
    // ad-hoc visit never checked out, so it cannot absorb it); the stationary
    // stretch at Client A is already covered by the recorded visit
    expect(d.stops.length).toBe(1)
    expect(d.stops[0].durationMin).toBeGreaterThanOrEqual(20)
    expect(d.summary.trackKm).toBeGreaterThan(0)
    expect(d.summary.stops).toBe(1)
  })

  test("hitmap on a plan-only day: planned stop, no track, no crash", async () => {
    const res = await postHrm("fieldforce.hitmap", { employeeId: emp.id, date: DAY2 }, { bearer: admin.token })
    expect(res.body.ok).toBe(true)
    expect(res.body.data.planned.length).toBe(1)
    expect(res.body.data.totalPings).toBe(0)
    expect(res.body.data.track.length).toBe(0)
    expect(res.body.data.stops.length).toBe(0)
  })

  test("cross-tenant employee id is a 404, not a leak", async () => {
    const res = await postHrm("fieldforce.hitmap", { employeeId: emp.id, date: DAY }, { bearer: otherVendorAdminToken })
    expect(res.status).toBe(404)
    const res2 = await postHrm("fieldforce.history", { from: DAY, to: DAY, employeeId: emp.id }, { bearer: otherVendorAdminToken })
    expect(res2.status).toBe(404)
    // scope-only query (no explicit id): the other tenant sees none of this vendor's rows
    const res3 = await postHrm("fieldforce.history", { from: DAY, to: DAY }, { bearer: otherVendorAdminToken })
    expect(res3.body.ok).toBe(true)
    expect(res3.body.data.rows.length).toBe(0)
  })

  test("unknown employee id is a 404", async () => {
    const res = await postHrm("fieldforce.hitmap", { employeeId: "nonexistent", date: DAY }, { bearer: admin.token })
    expect(res.status).toBe(404)
  })
})
