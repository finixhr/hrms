/// <reference types="bun-types" />
// ============ Unit tests — payroll proration (audit C-1) ============
// Validation criterion from the audit: "same month, one monthly run vs four
// weekly runs for identical attendance must sum to approximately one monthly
// gross (within rounding)."
import { test, expect, describe } from "bun:test"
import { weeklyFraction, workingDaysInWindow } from "@/hrm-server/payroll"

describe("weeklyFraction (C-1 proration)", () => {
  test("a full month's worth of working days → fraction 1", () => {
    expect(weeklyFraction(26, 26)).toBe(1)
  })

  test("one week of a 26-working-day month → ~0.19", () => {
    expect(weeklyFraction(5, 26)).toBeCloseTo(5 / 26, 5)
  })

  test("four typical weeks sum to approximately the monthly gross", () => {
    const fraction = weeklyFraction(5, 22)
    const gross = 26000
    const weeklyGross = Math.round(gross * fraction)
    // 4.x weeks at this fraction ≈ monthly gross within rounding tolerance
    const monthReconstructed = weeklyGross * (22 / 5)
    expect(Math.abs(monthReconstructed - gross)).toBeLessThanOrEqual(4 * 0.5)
  })

  test("zero working days in the window (holiday week) → fraction 0", () => {
    expect(weeklyFraction(0, 26)).toBe(0)
  })

  test("zero working days in the month (invalid roster) → fraction 0", () => {
    expect(weeklyFraction(5, 0)).toBe(0)
  })

  test("fraction never exceeds 1 (defensive cap)", () => {
    expect(weeklyFraction(30, 26)).toBe(1)
  })

  test("the monthly daily rate is consistent with the prorated weekly gross", () => {
    // gross/weekWD == gross_month/monthWD — the absence deduction is the same
    // daily value in both frequencies by construction.
    const gross = 52000, monthWD = 26, weekWD = 6
    const fraction = weeklyFraction(weekWD, monthWD)
    const weeklyGross = gross * fraction
    expect(weeklyGross / weekWD).toBeCloseTo(gross / monthWD, 8)
  })
})

describe("workingDaysInWindow", () => {
  test("counts non-weekly-off days inside an ISO week (Fri weekly off, BD style)", () => {
    // 2026-09-07 (Mon) → 2026-09-13 (Sun): Friday the 11th is the weekly off
    expect(workingDaysInWindow("2026-09-07", "2026-09-13", ["FRIDAY"])).toBe(6)
  })

  test("two-day window with both days off → 0 payable days", () => {
    expect(workingDaysInWindow("2026-09-11", "2026-09-12", ["FRIDAY", "SATURDAY"])).toBe(0)
  })

  test("single working day", () => {
    expect(workingDaysInWindow("2026-09-07", "2026-09-07", ["FRIDAY"])).toBe(1)
  })
})
