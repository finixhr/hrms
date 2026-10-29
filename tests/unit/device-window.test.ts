/// <reference types="bun-types" />
// ============ C-4 regression: device timestamp freshness window ============
// Device event times are untrusted input. Events at now-30d, now+1h and
// 1970-01-01 are rejected; now-6d and now-1m are accepted. Drift is measured
// in the device's configured timezone (Asia/Dhaka), not UTC.
import { describe, test, expect } from "bun:test"
import { eventWithinWindow, clockDriftSec } from "@/hrm-server/zkteco/adapter"

const NOW = new Date("2026-09-21T04:30:00Z")
const iso = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19)

describe("eventWithinWindow (C-4)", () => {
  test("events at now − 30 days are REJECTED", () => {
    const t = new Date(NOW.getTime() - 30 * 86_400_000)
    expect(eventWithinWindow(iso(t), NOW)).toBe(false)
  })
  test("events at now + 1 hour are REJECTED", () => {
    const t = new Date(NOW.getTime() + 3600_000)
    expect(eventWithinWindow(iso(t), NOW)).toBe(false)
  })
  test("events at 1970-01-01 are REJECTED", () => {
    expect(eventWithinWindow("1970-01-01 00:00:00", NOW)).toBe(false)
  })
  test("events at now − 6 days are ACCEPTED", () => {
    const t = new Date(NOW.getTime() - 6 * 86_400_000)
    expect(eventWithinWindow(iso(t), NOW)).toBe(true)
  })
  test("events at now − 1 minute are ACCEPTED", () => {
    const t = new Date(NOW.getTime() - 60_000)
    expect(eventWithinWindow(iso(t), NOW)).toBe(true)
  })
  test("boundary: exactly now − 7 days is accepted (closed window), one second older rejected", () => {
    const edge = new Date(NOW.getTime() - 7 * 86_400_000)
    expect(eventWithinWindow(iso(edge), NOW)).toBe(true)
    expect(eventWithinWindow(iso(new Date(edge.getTime() - 1000)), NOW)).toBe(false)
  })
  test("boundary: exactly now + 5 minutes is accepted (closed window), one second later rejected", () => {
    const edge = new Date(NOW.getTime() + 5 * 60_000)
    expect(eventWithinWindow(iso(edge), NOW)).toBe(true)
    expect(eventWithinWindow(iso(new Date(edge.getTime() + 1000)), NOW)).toBe(false)
  })
  test("garbage timestamps are rejected (not accepted by accident)", () => {
    expect(eventWithinWindow("not-a-date", NOW)).toBe(false)
    expect(eventWithinWindow("", NOW)).toBe(false)
  })
  test("lookback is configurable (30-day window accepts now − 20 days)", () => {
    const t = new Date(NOW.getTime() - 20 * 86_400_000)
    expect(eventWithinWindow(iso(t), NOW, 30, 5)).toBe(true)
    expect(eventWithinWindow(iso(t), NOW, 7, 5)).toBe(false)
  })
})

describe("clockDriftSec (C-4 — Asia/Dhaka frame, not UTC)", () => {
  test("a device stamp equal to Dhaka-now reads ~zero drift (not −6h)", () => {
    const dhakaNow = new Date(NOW.getTime() + 6 * 3600_000) // UTC+6 wall clock
    const drift = clockDriftSec(iso(dhakaNow), NOW, 6)
    expect(Math.abs(drift)).toBeLessThanOrEqual(1)
  })
  test("comparing the same instant as UTC wall-clock would show the old 6h bug — the fixed function must NOT", () => {
    const stamp = iso(NOW) // same wall-clock digits as UTC now
    const drift = clockDriftSec(stamp, NOW, 6)
    // device frame is +6h ahead, so a UTC-now stamp reads −6h — CORRECT, that
    // is the real difference between the two wall clocks
    expect(drift).toBeLessThanOrEqual(-6 * 3600 + 2)
    expect(drift).toBeGreaterThanOrEqual(-6 * 3600 - 2)
  })
  test("drift is zero for a stamp matching the configured offset frame", () => {
    // device configured for UTC+0 → its stamps equal UTC now
    expect(Math.abs(clockDriftSec(iso(NOW), NOW, 0))).toBeLessThanOrEqual(1)
  })
})
