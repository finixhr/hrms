/// <reference types="bun-types" />
// ============ Unit tests — geo-fence evaluation + accuracy rules (2026-10 round §22–§23, §81) ============
import { test, expect, describe } from "bun:test"
import { evaluateFence, evaluateFences, haversineM } from "@/hrm-server/geo"

const FENCE = {
  id: "f1", name: "Head Office", type: "CIRCLE",
  latitude: 23.8103, longitude: 90.4125, radiusM: 150,
  startTime: "09:00", endTime: "17:30", active: true,
}
const NOON = new Date("2026-10-05T12:00:00+06:00") // Monday 12:00 Dhaka — inside window

describe("evaluateFence (§22 server-side distance + §23 accuracy)", () => {
  test("inside the fence with sane accuracy → ok", () => {
    const v = evaluateFence(FENCE, 23.8110, 90.4125, 25, { now: NOON })
    expect(v.ok).toBe(true)
    expect(v.distanceM!).toBeLessThan(150)
  })

  test("outside the fence → rejected with an actionable distance message (§87)", () => {
    // ~0.01° lat ≈ 1.1km north — far outside
    const v = evaluateFence(FENCE, 23.8203, 90.4125, 25, { now: NOON })
    expect(v.ok).toBe(false)
    expect(v.reason).toContain("m from Head Office")
  })

  test("boundary: near the radius edge still passes", () => {
    // ~144m south of center (0.00130° lat ≈ 144m) — inside the 150m radius
    const v = evaluateFence(FENCE, 23.8103 - 0.0013, 90.4125, 10, { now: NOON })
    expect(v.ok).toBe(true)
  })

  test("poor accuracy inside a small fence → REVIEW verdict, not silent accept (§23)", () => {
    const v = evaluateFence(FENCE, 23.8103, 90.4125, 500, { now: NOON })
    expect(v.ok).toBe(false)
    expect(v.reason!.startsWith("REVIEW:")).toBe(true)
    expect(v.reason).toContain("accuracy")
  })

  test("accuracy above policy max (independent of fence size) → REVIEW", () => {
    const v = evaluateFence(FENCE, 23.8103, 90.4125, 400, { now: NOON, maxAccuracyM: 150 })
    expect(v.ok).toBe(false)
    expect(v.reason!.startsWith("REVIEW:")).toBe(true)
  })

  test("disabled fence → rejected as disabled", () => {
    const v = evaluateFence({ ...FENCE, active: false }, 23.8103, 90.4125, 20, { now: NOON })
    expect(v.ok).toBe(false)
    expect(v.reason).toContain("disabled")
  })

  test("outside the fence time window → rejected (§22 schedule)", () => {
    const evening = new Date("2026-10-05T18:30:00+06:00")
    const v = evaluateFence(FENCE, 23.8103, 90.4125, 20, { now: evening })
    expect(v.ok).toBe(false)
    expect(v.reason).toContain("Outside geo-fence hours")
  })

  test("fence with no time window is valid all day", () => {
    const night = new Date("2026-10-05T22:00:00+06:00")
    const v = evaluateFence({ ...FENCE, startTime: null, endTime: null }, 23.8103, 90.4125, 20, { now: night })
    expect(v.ok).toBe(true)
  })
})

describe("evaluateFences (§21 multi-fence: closest passing fence wins)", () => {
  const FENCES = [
    { ...FENCE, id: "f1", name: "Head Office" },
    { ...FENCE, id: "f2", name: "Client Site A", latitude: 23.7503, longitude: 90.4125, radiusM: 200 },
  ]

  test("position inside the second fence resolves to it", () => {
    const v = evaluateFences(FENCES, 23.7503, 90.4125, 20, { now: NOON })
    expect(v.ok).toBe(true)
    expect(v.fence!.name).toBe("Client Site A")
  })

  test("REVIEW beats hard-fail when one fence is accuracy-blocked", () => {
    const v = evaluateFences(FENCES, 23.8103, 90.4125, 500, { now: NOON })
    expect(v.ok).toBe(false)
    expect(v.reason!.startsWith("REVIEW:")).toBe(true)
  })

  test("no fences at all → clear message", () => {
    const v = evaluateFences([], 23.8103, 90.4125, 20, { now: NOON })
    expect(v.ok).toBe(false)
    expect(v.reason).toContain("No geo-fence")
  })
})

describe("haversineM sanity (§22)", () => {
  test("zero distance at the same point", () => {
    expect(haversineM(23.8103, 90.4125, 23.8103, 90.4125)).toBe(0)
  })
  test("~111km per degree of latitude", () => {
    const d = haversineM(23.0, 90.0, 24.0, 90.0)
    expect(d).toBeGreaterThan(110_000)
    expect(d).toBeLessThan(112_500)
  })
})

// ============ R10 (2026-10-12) — the misleading "No active GEO Fence" message ============
// ROOT CAUSE: when EVERY fence that applies to an employee failed on its TIME
// WINDOW (distanceM null), evaluateFences' closest-distance selection
// discarded those reasons and fell through to the generic
// "No active geo-fence covers this location" — while the employee stood
// dead-center inside the fence. The fix surfaces the actionable
// "Outside geo-fence hours (…)" reason instead.
describe("R10 — all-closed fences surface the hours reason (not the generic message)", () => {
  const fence = (over: any = {}) => ({
    id: "f1", name: "HQ", type: "CIRCLE",
    latitude: 23.8103, longitude: 90.4125, radiusM: 500,
    startTime: "09:00", endTime: "17:00", active: true, ...over,
  })

  test("single fence closed for hours → the hours reason surfaces from the SET evaluator", () => {
    const v = evaluateFences([fence()], 23.8103, 90.4125, 10, { now: new Date("2026-10-12T02:30:00Z") }) // 09:30 Dhaka → closed
    expect(v.ok).toBe(false)
    expect(v.reason).toContain("Outside geo-fence hours")
  })

  test("multiple fences all closed for hours → still the hours reason (previously the generic message)", () => {
    const v = evaluateFences(
      [fence({ id: "f1" }), fence({ id: "f2", name: "Plant", startTime: "10:00", endTime: "16:00" })],
      23.8103, 90.4125, 10,
      { now: new Date("2026-10-12T02:30:00Z") },
    )
    expect(v.ok).toBe(false)
    expect(String(v.reason)).toContain("geo-fence hours")
    expect(String(v.reason)).not.toContain("No active geo-fence covers")
  })

  test("open fence + outside radius → distance reason still wins over a closed fence", () => {
    const v = evaluateFences(
      [fence({ id: "closed" }), fence({ id: "open", startTime: null, endTime: null, name: "Warehouse", latitude: 23.815, longitude: 90.415 })],
      23.8103, 90.4125, 10,
      { now: new Date("2026-10-12T02:30:00Z") },
    )
    expect(v.ok).toBe(false)
    expect(String(v.reason)).toMatch(/from Warehouse/)
  })

  test("inside an open fence during open hours → still passes", () => {
    const v = evaluateFences([fence()], 23.8103, 90.4125, 10, { now: new Date("2026-10-12T06:30:00Z") }) // 12:30 Dhaka → open
    expect(v.ok).toBe(true)
  })
})
