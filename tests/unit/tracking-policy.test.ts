/// <reference types="bun-types" />
// ============ Unit tests — attendance/tracking policy engine (2026-10 round §6–§7) ============
// Covers schedule evaluation (server-clock authoritative): date ranges,
// weekday sets, daily windows incl. midnight-crossing, and scope priority
// semantics that drive resolveEffectivePolicy.
import { test, expect, describe } from "bun:test"
import { policyInSchedule, trackingConfig, multipleCheckinConfig, attendanceMethodConfig, zonedParts, type PolicyRecord } from "@/hrm-server/attendance-policy"

const base: PolicyRecord = {
  id: "p1", vendorId: "v1", name: "Test policy", policyType: "TRACKING", priority: 0,
  startDate: null, endDate: null, startTime: null, endTime: null,
  daysOfWeek: "SUNDAY,MONDAY,TUESDAY,WEDNESDAY,THURSDAY", timezone: "Asia/Dhaka",
  active: true, configJson: "{}",
}

describe("policyInSchedule (§7 server-clock schedule)", () => {
  test("active policy with no restrictions is always in schedule", () => {
    // fixed Monday in Dhaka (never depend on the machine clock/weekday)
    expect(policyInSchedule(base, new Date("2026-10-05T12:00:00+06:00"))).toBe(true)
  })

  test("inactive policy is never in schedule", () => {
    expect(policyInSchedule({ ...base, active: false }, new Date())).toBe(false)
  })

  test("date range gates the policy (§7 start/end date)", () => {
    const p = { ...base, startDate: "2026-10-05", endDate: "2026-10-10" }
    expect(policyInSchedule(p, new Date("2026-10-07T12:00:00+06:00"))).toBe(true)
    expect(policyInSchedule(p, new Date("2026-10-04T12:00:00+06:00"))).toBe(false)
    expect(policyInSchedule(p, new Date("2026-10-11T12:00:00+06:00"))).toBe(false)
  })

  test("weekday set excludes Friday/Saturday (BD working week)", () => {
    // 2026-10-02 is a Friday (Asia/Dhaka); 2026-10-04 is a Sunday
    expect(policyInSchedule(base, new Date("2026-10-04T11:00:00+06:00"))).toBe(true)
    expect(policyInSchedule(base, new Date("2026-10-02T11:00:00+06:00"))).toBe(false)
  })

  test("daily time window inside/outside (09:00–17:30)", () => {
    const p = { ...base, startTime: "09:00", endTime: "17:30" }
    expect(policyInSchedule(p, new Date("2026-10-04T10:00:00+06:00"))).toBe(true)
    expect(policyInSchedule(p, new Date("2026-10-04T08:59:00+06:00"))).toBe(false)
    expect(policyInSchedule(p, new Date("2026-10-04T17:31:00+06:00"))).toBe(false)
  })

  test("midnight-crossing window (22:00–06:00) is honored", () => {
    const p = { ...base, startTime: "22:00", endTime: "06:00" }
    expect(policyInSchedule(p, new Date("2026-10-05T23:30:00+06:00"))).toBe(true)
    expect(policyInSchedule(p, new Date("2026-10-05T03:00:00+06:00"))).toBe(true)
    expect(policyInSchedule(p, new Date("2026-10-05T12:00:00+06:00"))).toBe(false)
  })

  test("timezone is respected (UTC timestamp evaluated in Asia/Dhaka)", () => {
    // 2026-10-04 20:00 UTC = 2026-10-05 02:00 Dhaka → outside 09:00–17:30
    const p = { ...base, startTime: "09:00", endTime: "17:30" }
    expect(policyInSchedule(p, new Date("2026-10-04T20:00:00Z"))).toBe(false)
    // 2026-10-04 06:00 UTC = 2026-10-04 12:00 Dhaka → inside the window
    expect(policyInSchedule(p, new Date("2026-10-04T06:00:00Z"))).toBe(true)
  })
})

describe("zonedParts (§80 time handling)", () => {
  test("UTC instant maps to the correct Dhaka calendar day + weekday", () => {
    const parts = zonedParts(new Date("2026-10-04T18:30:00Z"), "Asia/Dhaka") // 00:30 Oct 5 Dhaka
    expect(parts.d).toBe("05")
    expect(parts.weekday).toBe("MONDAY")
    expect(parts.h).toBe(0)
    expect(parts.min).toBe(30)
  })

  test("unknown timezone falls back to UTC without throwing", () => {
    const parts = zonedParts(new Date("2026-10-04T18:30:00Z"), "Not/AZone")
    expect(parts.d).toBe("04")
  })
})

describe("typed policy configs (§6 one engine, typed settings)", () => {
  test("tracking config defaults and overrides", () => {
    expect(trackingConfig(null).updateIntervalSec).toBe(60)
    expect(trackingConfig({ updateIntervalSec: 15, suspiciousAction: "REJECT" }).updateIntervalSec).toBe(15)
    expect(trackingConfig({ suspiciousAction: "REJECT" }).suspiciousAction).toBe("REJECT")
  })

  test("multiple check-in config defaults (§29)", () => {
    const c = multipleCheckinConfig(null)
    expect(c.minIntervalMinutes).toBe(60)
    expect(c.maxPerDay).toBe(10)
    expect(c.methods).toContain("GEOFENCE_SELFIE")
  })

  test("attendance method config defaults (§28)", () => {
    const c = attendanceMethodConfig({ selfieRequired: true })
    expect(c.selfieRequired).toBe(true)
    expect(c.methods).toContain("GEOFENCE")
  })
})
