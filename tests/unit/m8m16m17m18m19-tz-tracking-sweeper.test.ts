/// <reference types="bun-types" />
// ============ M-8/M-16/M-17/M-18/M-19 — tz clock, tracking consent/debounce, sweeper lock ============
// M-8/M-18: today()/hhmm() read the SERVER-LOCAL clock — Asia/Dhaka business
//           rules drifted 6h on UTC hosts (check-ins 00:00–06:00 Dhaka landed
//           on the previous date); punch occurredAt parsed in the server zone.
// M-16: the tracking ingest ignored trackingEnabled/consent — a stopped or
//           globally-disabled tracker kept appending telemetry + events.
// M-17: per-ping alarm events + per-admin notification fan-out had no debounce.
// M-19: the sweeper lock was claimed once and never renewed — cadence = TTL.
import { describe, expect, it } from "bun:test"
import { sessionTokenHash } from "@/hrm-server/auth"
import { postHrm } from "./_hrm-endpoint"
import { db } from "@/lib/db"
import { mkEmployee, mkUser, mkVendor, uniq } from "./_fixtures"
import { today, hhmm, zonedParts, fromZonedWall } from "@/hrm-server/utils"
import { ingestLocation } from "@/hrm-server/tracking"
import { claimSweepLock } from "@/hrm-server/zkteco/sweeper"

describe("M-8/M-18 — one deployment wall clock", () => {
  const prevTz = process.env.ADMS_TIMEZONE_OFFSET_HOURS

  it("today()/hhmm() resolve in the ADMS_TIMEZONE_OFFSET_HOURS frame, not the host zone", () => {
    // a fixed instant: 2026-10-02T20:30Z
    const fakeNow = new Date("2026-10-02T20:30:00Z")
    process.env.ADMS_TIMEZONE_OFFSET_HOURS = "6"
    let p = zonedParts(fakeNow)
    expect(`${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`).toBe("2026-10-03") // 02:30 next day in Dhaka
    expect(`${p.hh}:${p.mm}`).toBe("02:30")
    process.env.ADMS_TIMEZONE_OFFSET_HOURS = "0"
    p = zonedParts(fakeNow)
    expect(`${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`).toBe("2026-10-02")
    expect(`${p.hh}:${p.mm}`).toBe("20:30")
    // today()/hhmm() follow the SAME frame (default +6 = Asia/Dhaka)
    delete process.env.ADMS_TIMEZONE_OFFSET_HOURS
    const shifted = new Date(Date.now() + 6 * 3600_000)
    const expectDhaka = `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`
    expect(today()).toBe(expectDhaka)
    if (prevTz) process.env.ADMS_TIMEZONE_OFFSET_HOURS = prevTz
  })

  it("fromZonedWall converts a Dhaka wall time to the true instant (punch projection frame)", () => {
    process.env.ADMS_TIMEZONE_OFFSET_HOURS = "6"
    const instant = fromZonedWall("2026-10-02T09:00:00") // 09:00 Dhaka
    expect(instant.toISOString()).toBe("2026-10-02T03:00:00.000Z") // = 03:00 UTC
    const back = zonedParts(instant)
    expect(`${back.hh}:${back.mm}`).toBe("09:00") // round-trips to the wall clock
    if (prevTz) process.env.ADMS_TIMEZONE_OFFSET_HOURS = prevTz
  })
})

describe("M-16 — tracking consent gate", () => {
  async function mkEmpSession(vendorId: string) {
    const emp = await mkEmployee(vendorId, { fullName: "Tracked " + uniq("e") })
    const u = await mkUser(vendorId, { role: "EMPLOYEE", employeeId: emp.id, email: uniq("trk") + "@t.local" })
    const id = `trk-${uniq("s")}`
    await db.session.create({ data: { id, tokenHash: sessionTokenHash(id), userId: u.id, kind: "FULL", csrfToken: "x", expiresAt: new Date(Date.now() + 3600_000), ip: "127.0.0.1", lastSeenAt: new Date() } })
    return { emp, sess: id }
  }
  const ping = (n: number) => ({
    latitude: 23.8, longitude: 90.4, accuracyM: 10, gpsStatus: "OK", networkStatus: "ONLINE",
    batteryPercentage: 80, clientEventId: `evt-${n}-${Date.now()}`,
  })

  it("tracking.stop refuses further pings — no point, no event, clear message", async () => {
    const vendor = await mkVendor("M16-Stop")
    const { emp, sess } = await mkEmpSession(vendor.id)
    // admin stops tracking for the employee
    await db.employeeTrackingState.create({ data: { vendorId: vendor.id, employeeId: emp.id, trackingEnabled: false, trackingStatus: "OFFLINE" } as any })
    const r = await postHrm("tracking.location", ping(1), { bearer: sess })
    expect(r.status).toBe(400)
    expect(r.body?.error).toContain("Tracking is disabled")
    expect(await db.trackingPoint.count({ where: { employeeId: emp.id } })).toBe(0)
  })

  it("vendor-wide disable (Settings → Tracking) refuses pings even with the employee toggle on", async () => {
    const vendor = await mkVendor("M16-Global")
    const { emp, sess } = await mkEmpSession(vendor.id)
    await db.employeeTrackingState.create({ data: { vendorId: vendor.id, employeeId: emp.id, trackingEnabled: true, trackingStatus: "TRACKING" } as any })
    await db.hrSetting.create({ data: { vendorId: vendor.id, group: "tracking", key: "enabled", value: "false" } })
    const r = await postHrm("tracking.location", ping(2), { bearer: sess })
    expect(r.status).toBe(400)
    expect(r.body?.error).toContain("Tracking is disabled")
  })

  it("an enabled tracker still ingests (no false positives)", async () => {
    const vendor = await mkVendor("M16-Ok")
    const { emp, sess } = await mkEmpSession(vendor.id)
    await db.employeeTrackingState.create({ data: { vendorId: vendor.id, employeeId: emp.id, trackingEnabled: true, trackingStatus: "TRACKING" } as any })
    const r = await postHrm("tracking.location", ping(3), { bearer: sess })
    expect(r.status).toBe(200)
    expect(r.body?.data?.ok).toBe(true)
  })
})

describe("M-17 — alarm debounce", () => {
  it("two consecutive mock-location pings record ONE SECURITY_FLAG event and ONE notification", async () => {
    const vendor = await mkVendor("M17-Debounce")
    await mkUser(vendor.id, { role: "HR_ADMIN", email: uniq("m17hr") + "@t.local" }) // notification recipient
    const emp = await mkEmployee(vendor.id, { fullName: "Suspicious " + uniq("e") })
    await db.employeeTrackingState.create({ data: { vendorId: vendor.id, employeeId: emp.id, trackingEnabled: true, trackingStatus: "TRACKING", deviceId: "dev-A" } as any })
    const base = { latitude: 23.8, longitude: 90.4, accuracyM: 10, gpsStatus: "OK" as const, networkStatus: "ONLINE" as const, batteryPercentage: 80, isMockLocation: true, deviceId: "dev-A" }
    const r1 = await ingestLocation(vendor.id, emp.id, { ...base, clientEventId: uniq("m1") })
    const r2 = await ingestLocation(vendor.id, emp.id, { ...base, clientEventId: uniq("m2") })
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    // both pings were flagged in the response status, but only ONE event row
    expect(r1.events).toContain("SECURITY_FLAG")
    expect(r2.events).toContain("SECURITY_FLAG")
    expect(await db.attendanceEvent.count({ where: { employeeId: emp.id, eventType: "SECURITY_FLAG" } })).toBe(1)
    // and the admin notification fanned out once, not per ping
    expect(await db.notification.count({ where: { vendorId: vendor.id, title: "Suspicious Location" } })).toBe(1)
  })

  it("a fresh alarm AFTER the debounce window is recorded again (window, not suppression)", async () => {
    const vendor = await mkVendor("M17-Window")
    const emp = await mkEmployee(vendor.id, { fullName: "Windowed " + uniq("e") })
    // pre-existing SECURITY_FLAG event 20 minutes ago (outside the 15-min window)
    await db.attendanceEvent.create({ data: { vendorId: vendor.id, employeeId: emp.id, eventType: "SECURITY_FLAG", attendanceMethod: "MOBILE", occurredAt: new Date(Date.now() - 20 * 60_000) } as any })
    await db.employeeTrackingState.create({ data: { vendorId: vendor.id, employeeId: emp.id, trackingEnabled: true, trackingStatus: "TRACKING", deviceId: "dev-B" } as any })
    const r = await ingestLocation(vendor.id, emp.id, {
      latitude: 23.8, longitude: 90.4, accuracyM: 10, gpsStatus: "OK", networkStatus: "ONLINE",
      batteryPercentage: 80, isMockLocation: true, deviceId: "dev-B", clientEventId: uniq("m3"),
    })
    expect(r.events).toContain("SECURITY_FLAG")
    expect(await db.attendanceEvent.count({ where: { employeeId: emp.id, eventType: "SECURITY_FLAG" } })).toBe(2)
  })
})

describe("M-19 — sweeper lock renews while held", () => {
  it("the holder re-claims without going stale; a live foreign holder blocks; a stale one is taken over", async () => {
    // clean slate for the lock row
    await db.hrSetting.deleteMany({ where: { vendorId: "__system__", group: "sweeper" } })
    expect(await claimSweepLock()).toBe(true) // seed + claim
    expect(await claimSweepLock()).toBe(true) // holder RENEWS immediately (was false until TTL)
    // a live foreign holder blocks this process
    await db.hrSetting.updateMany({
      where: { vendorId: "__system__", group: "sweeper", key: "zkteco:sweepLock" },
      data: { value: JSON.stringify({ owner: "other-process", at: new Date().toISOString() }) },
    })
    expect(await claimSweepLock()).toBe(false)
    // a stale foreign holder (past the liveness TTL) is taken over
    await db.hrSetting.updateMany({
      where: { vendorId: "__system__", group: "sweeper", key: "zkteco:sweepLock" },
      data: { value: JSON.stringify({ owner: "other-process", at: new Date(Date.now() - 10 * 60_000).toISOString() }) },
    })
    expect(await claimSweepLock()).toBe(true)
    await db.hrSetting.deleteMany({ where: { vendorId: "__system__", group: "sweeper" } })
  })
})
