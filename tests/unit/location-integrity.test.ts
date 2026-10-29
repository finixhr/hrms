/// <reference types="bun-types" />
// ============ Unit tests — GPS anti-spoofing / location integrity (2026-10 round §24–§25, §81) ============
import { test, expect, describe } from "bun:test"
import { analyzeLocationIntegrity, integrityToEventStatus } from "@/hrm-server/location-integrity"

const CFG = { maxAccuracyM: 150, suspiciousAction: "REVIEW" as const }
const NOW = new Date("2026-10-05T10:00:00Z")

describe("analyzeLocationIntegrity (§24 spoofing signals)", () => {
  test("clean first fix is VERIFIED + ALLOW", () => {
    const v = analyzeLocationIntegrity(
      { latitude: 23.8103, longitude: 90.4125, accuracyM: 20, clientTimestamp: NOW.toISOString() },
      null, NOW, CFG
    )
    expect(v.status).toBe("VERIFIED")
    expect(v.decision).toBe("ALLOW")
    expect(v.signals).toHaveLength(0)
  })

  test("client-declared mock location → MOCK_LOCATION (hard evidence, §24)", () => {
    const v = analyzeLocationIntegrity(
      { latitude: 23.8103, longitude: 90.4125, accuracyM: 20, isMockLocation: true },
      null, NOW, CFG
    )
    expect(v.status).toBe("MOCK_LOCATION")
    expect(v.decision).toBe("REVIEW")
  })

  test("impossible movement: 5km in 60s → IMPOSSIBLE_MOVEMENT", () => {
    const prev = { latitude: 23.8103, longitude: 90.4125, at: new Date(NOW.getTime() - 60_000) }
    // ~0.045° lat ≈ 5km north
    const v = analyzeLocationIntegrity(
      { latitude: 23.8553, longitude: 90.4125, accuracyM: 20 }, prev, NOW, CFG
    )
    expect(v.status).toBe("IMPOSSIBLE_MOVEMENT")
    expect(v.decision).toBe("REVIEW")
  })

  test("suspicious action REJECT escalates impossible movement to REJECT (§25)", () => {
    const prev = { latitude: 23.8103, longitude: 90.4125, at: new Date(NOW.getTime() - 60_000) }
    const v = analyzeLocationIntegrity(
      { latitude: 23.8553, longitude: 90.4125, accuracyM: 20 }, prev, NOW,
      { maxAccuracyM: 150, suspiciousAction: "REJECT" }
    )
    expect(v.decision).toBe("REJECT")
  })

  test("plausible walking movement stays VERIFIED", () => {
    const prev = { latitude: 23.8103, longitude: 90.4125, at: new Date(NOW.getTime() - 60_000) }
    // ~100m north in 60s ≈ 1.7 m/s — walking/running, fine
    const v = analyzeLocationIntegrity(
      { latitude: 23.8112, longitude: 90.4125, accuracyM: 20 }, prev, NOW, CFG
    )
    expect(v.status).toBe("VERIFIED")
  })

  test("stale location: 20-minute-old captured fix → STALE_LOCATION (§24)", () => {
    const v = analyzeLocationIntegrity(
      { latitude: 23.8103, longitude: 90.4125, accuracyM: 20, clientTimestamp: new Date(NOW.getTime() - 20 * 60_000).toISOString() },
      null, NOW, CFG
    )
    expect(v.status).toBe("STALE_LOCATION")
  })

  test("timestamp anomaly: client clock 7 minutes behind → TIMESTAMP_ANOMALY (§80)", () => {
    const v = analyzeLocationIntegrity(
      { latitude: 23.8103, longitude: 90.4125, accuracyM: 20, clientTimestamp: new Date(NOW.getTime() - 7 * 60_000).toISOString() },
      null, NOW, CFG
    )
    expect(v.status).toBe("TIMESTAMP_ANOMALY")
    expect(v.signals.some((s) => s.startsWith("client_clock_behind"))).toBe(true)
  })

  test("repeated identical coordinates across pings → SUSPICIOUS (frozen GPS)", () => {
    const prev = { latitude: 23.8103, longitude: 90.4125, at: new Date(NOW.getTime() - 5 * 60_000) }
    const v = analyzeLocationIntegrity(
      { latitude: 23.8103, longitude: 90.4125, accuracyM: 20 }, prev, NOW, CFG
    )
    expect(v.status).toBe("SUSPICIOUS")
    expect(v.signals).toContain("repeated_identical_location")
  })

  test("accuracy above policy ceiling → LOW_ACCURACY (§23)", () => {
    const v = analyzeLocationIntegrity(
      { latitude: 23.8103, longitude: 90.4125, accuracyM: 400 }, null, NOW, CFG
    )
    expect(v.status).toBe("LOW_ACCURACY")
  })

  test("suspiciously perfect accuracy (<1m) → SUSPICIOUS", () => {
    const v = analyzeLocationIntegrity(
      { latitude: 23.8103, longitude: 90.4125, accuracyM: 0.5 }, null, NOW, CFG
    )
    expect(v.status).toBe("SUSPICIOUS")
  })

  test("device mismatch vs bound session → DEVICE_MISMATCH (§24)", () => {
    const v = analyzeLocationIntegrity(
      { latitude: 23.8103, longitude: 90.4125, accuracyM: 20, deviceId: "device-B" },
      null, NOW, { ...CFG }, 
    )
    // without a bound device this is fine — bind one:
    expect(v.status).toBe("VERIFIED")
    const v2 = analyzeLocationIntegrity(
      { latitude: 23.8103, longitude: 90.4125, accuracyM: 20, deviceId: "device-B", boundDeviceId: "device-A" },
      null, NOW, CFG
    )
    expect(v2.status).toBe("DEVICE_MISMATCH")
    expect(v2.decision).toBe("REVIEW")
  })
})

describe("integrityToEventStatus (§4/§27 honest labeling)", () => {
  test("ALLOW → ACCEPTED (never VERIFIED — that label is reserved §27)", () => {
    expect(integrityToEventStatus({ status: "VERIFIED", signals: [], decision: "ALLOW", notes: "" })).toBe("ACCEPTED")
  })
  test("WARN → SUSPICIOUS", () => {
    expect(integrityToEventStatus({ status: "SUSPICIOUS", signals: [], decision: "WARN", notes: "" })).toBe("SUSPICIOUS")
  })
  test("REVIEW → REVIEW_REQUIRED", () => {
    expect(integrityToEventStatus({ status: "MOCK_LOCATION", signals: [], decision: "REVIEW", notes: "" })).toBe("REVIEW_REQUIRED")
  })
  test("REJECT → REJECTED", () => {
    expect(integrityToEventStatus({ status: "MOCK_LOCATION", signals: [], decision: "REJECT", notes: "" })).toBe("REJECTED")
  })
})
