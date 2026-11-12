/// <reference types="bun-types" />
// ============ Unit tests — leave day computation (audit H-6/Low) ============
import { test, expect, describe } from "bun:test"
import { leaveDaysBetween, weekdaysInMonth, csv } from "@/hrm-server/utils"

describe("leaveDaysBetween (H-6 authoritative count)", () => {
  test("full working week with Friday weekly-off counts 6 days", () => {
    expect(leaveDaysBetween("2026-09-07", "2026-09-13", ["FRIDAY"])).toBe(6)
  })

  test("Fri-Sat weekly off (BD standard)", () => {
    expect(leaveDaysBetween("2026-09-07", "2026-09-13", ["FRIDAY", "SATURDAY"])).toBe(5)
  })

  test("weekend-only span counts zero working days", () => {
    expect(leaveDaysBetween("2026-09-11", "2026-09-12", ["FRIDAY", "SATURDAY"])).toBe(0)
  })

  test("single day counts one", () => {
    expect(leaveDaysBetween("2026-09-08", "2026-09-08", [])).toBe(1)
  })

  test("cross-month span counts all working days", () => {
    // Aug 31 (Mon) → Sep 4 (Fri) 2026: 5 working days with no weekly off
    expect(leaveDaysBetween("2026-08-31", "2026-09-04", [])).toBe(5)
  })
})

describe("weekdaysInMonth", () => {
  test("September 2026 with Fri+Sat off has 22 working days", () => {
    expect(weekdaysInMonth(2026, 9, ["FRIDAY", "SATURDAY"])).toBe(22)
  })
})

describe("csv formula neutralization (M-8)", () => {
  test("formula-prefixed cells are apostrophe-guarded", () => {
    const rows: (string | number | null)[][] = [["=SUM(A1:A9)"], ["+cmd"], ["-2+1"], ["@xlsx"]]
    const out = csv(rows)
    const lines = out.split("\n")
    const APOS = String.fromCharCode(39) // '
    expect(lines[0]).toBe(APOS + "=SUM(A1:A9)")
    expect(lines[1]).toBe(APOS + "+cmd")
    expect(lines[2]).toBe(APOS + "-2+1")
    expect(lines[3]).toBe(APOS + "@xlsx")
  })

  test("plain values pass through untouched", () => {
    expect(csv([["a", 1, null]]).replace(/"/g, "")).toBe("a,1,")
  })

  test("cells containing commas/quotes are quoted per RFC", () => {
    expect(csv([["hello, world"]])).toBe('"hello, world"')
    expect(csv([['say "hi"']])).toBe('"say ""hi"""')
  })
})
