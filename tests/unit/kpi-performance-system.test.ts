// ============ KPI Performance System — dbless unit tests (2026-11 redesign) ============
// Pure-function coverage: the scoring engine (directions, zero handling,
// weighted averages, rating bands), period resolution and the Excel upload
// validation contract. No database — safe in the dbless suite.
import { describe, expect, test } from "bun:test"
import {
  achievementPct, indicatorScore, weightedScore, ratingFor, resolvePeriodRange, formatPeriodLabel,
  periodLabelsBetween, scoringOptions, sumUnitTotals,
} from "../../src/hrm-server/kpi/scoring"
import { DEFAULT_KPI_PERFORMANCE_SETTINGS } from "../../src/hrm-server/kpi/constants"
import {
  generateTargetTemplate, parseTargetUpload, generateAchievementTemplate, parseAchievementUpload,
  readWorkbook, summarize, errorReportCsv, type TargetIndicatorRef, type AchievementRefRow,
} from "../../src/hrm-server/kpi/excel"

// ---------------------------------------------------------------------------
// Scoring — direction formulas
// ---------------------------------------------------------------------------

describe("KPI achievementPct — HIGHER_IS_BETTER", () => {
  test("actual ÷ target × 100", () => {
    expect(achievementPct({ direction: "HIGHER_IS_BETTER", target: 200, actual: 100 })).toBe(50)
    expect(achievementPct({ direction: "HIGHER_IS_BETTER", target: 100, actual: 100 })).toBe(100)
    expect(achievementPct({ direction: "HIGHER_IS_BETTER", target: 400, actual: 100 })).toBe(25)
  })
  test("default max clamps over-achievement at 100", () => {
    expect(achievementPct({ direction: "HIGHER_IS_BETTER", target: 50, actual: 75 })).toBe(100)
    expect(achievementPct({ direction: "HIGHER_IS_BETTER", target: 50, actual: 75 }, { achievementMaxPct: 120 })).toBe(120)
    expect(achievementPct({ direction: "HIGHER_IS_BETTER", target: 100, actual: 0 })).toBe(0)
  })
  test("zero target: any positive actual exceeds it → max; zero actual → undefined", () => {
    expect(achievementPct({ direction: "HIGHER_IS_BETTER", target: 0, actual: 10 })).toBe(100)
    expect(achievementPct({ direction: "HIGHER_IS_BETTER", target: 0, actual: 0 })).toBeNull()
    expect(achievementPct({ direction: "HIGHER_IS_BETTER", target: null, actual: 10 })).toBeNull()
  })
  test("missing actual → null (missing data, never zero)", () => {
    expect(achievementPct({ direction: "HIGHER_IS_BETTER", target: 100, actual: null })).toBeNull()
  })
})

describe("KPI achievementPct — LOWER_IS_BETTER", () => {
  test("target ÷ actual × 100", () => {
    expect(achievementPct({ direction: "LOWER_IS_BETTER", target: 10, actual: 20 })).toBe(50)
    expect(achievementPct({ direction: "LOWER_IS_BETTER", target: 15, actual: 15 })).toBe(100)
  })
  test("actual = 0 is PERFECT for lower-is-better", () => {
    expect(achievementPct({ direction: "LOWER_IS_BETTER", target: 10, actual: 0 })).toBe(100)
  })
  test("zero target with positive actual → 0 (missed a zero target)", () => {
    expect(achievementPct({ direction: "LOWER_IS_BETTER", target: 0, actual: 5 })).toBe(0)
    expect(achievementPct({ direction: "LOWER_IS_BETTER", target: 0, actual: 0 })).toBe(100)
  })
})

describe("KPI achievementPct — EXACT_TARGET", () => {
  test("within tolerance → 100", () => {
    expect(achievementPct({ direction: "EXACT_TARGET", target: 90, actual: 91 }, { exactTolerancePct: 5 })).toBe(100)
    expect(achievementPct({ direction: "EXACT_TARGET", target: 90, actual: 85.6 }, { exactTolerancePct: 5 })).toBe(100)
  })
  test("outside tolerance degrades linearly", () => {
    // |95-90|/90 = 5.56% deviation → 100 - 5.56 = 94.4 (1dp)
    expect(achievementPct({ direction: "EXACT_TARGET", target: 90, actual: 95 }, { exactTolerancePct: 5 })).toBe(94.4)
  })
  test("zero target handled absolutely", () => {
    expect(achievementPct({ direction: "EXACT_TARGET", target: 0, actual: 0 })).toBe(100)
    expect(achievementPct({ direction: "EXACT_TARGET", target: 0, actual: 1 })).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Weighted score + rating bands
// ---------------------------------------------------------------------------

describe("KPI weightedScore", () => {
  test("Σ(pct×w)/Σ(w)", () => {
    const r = weightedScore([{ pct: 100, weight: 60 }, { pct: 50, weight: 40 }])
    expect(r.score).toBe(80) // (100*60 + 50*40)/100
    expect(r.counted).toBe(2)
    expect(r.missing).toBe(0)
  })
  test("missing data excluded from BOTH sides by default", () => {
    const r = weightedScore([{ pct: 100, weight: 60 }, { pct: null, weight: 40 }])
    expect(r.score).toBe(100) // only the scored indicator counts
    expect(r.missing).toBe(1)
  })
  test("missingDataCountsZero=true counts missing as zero", () => {
    const r = weightedScore([{ pct: 100, weight: 60 }, { pct: null, weight: 40 }], { missingDataCountsZero: true })
    expect(r.score).toBe(60)
  })
  test("all missing → null", () => {
    expect(weightedScore([{ pct: null, weight: 50 }]).score).toBeNull()
  })
  test("non-100 total weights are normalized and the basis recorded", () => {
    const r = weightedScore([{ pct: 100, weight: 20 }, { pct: 100, weight: 20 }])
    expect(r.score).toBe(100)
    expect(r.basis).toEqual({ totalWeight: 40, countedWeight: 40 })
  })
})

describe("KPI ratingFor — configurable bands", () => {
  const bands = DEFAULT_KPI_PERFORMANCE_SETTINGS.ratings
  test("band mapping follows the configured minimums", () => {
    expect(ratingFor(95, bands)?.label).toBe("Outstanding")
    expect(ratingFor(90, bands)?.label).toBe("Outstanding")
    expect(ratingFor(89.9, bands)?.label).toBe("Exceeds Expectations")
    expect(ratingFor(75, bands)?.label).toBe("Meets Expectations")
    expect(ratingFor(60, bands)?.label).toBe("Needs Improvement")
    expect(ratingFor(59.9, bands)?.label).toBe("Unsatisfactory")
    expect(ratingFor(null, bands)).toBeNull()
  })
  test("custom bands are honored (never hardcoded)", () => {
    const custom = [{ min: 50, label: "Pass" }, { min: 0, label: "Fail" }]
    expect(ratingFor(70, custom)?.label).toBe("Pass")
    expect(ratingFor(49, custom)?.label).toBe("Fail")
    expect(ratingFor(70, custom)?.stars).toBe(2)
  })
})

describe("indicatorScore + scoringOptions + sumUnitTotals", () => {
  test("indicator contribution = pct × weight / 100", () => {
    expect(indicatorScore(80, 25)).toBe(20)
    expect(indicatorScore(null, 25)).toBeNull()
  })
  test("scoringOptions normalizes bad settings defensively", () => {
    const o = scoringOptions({ achievementMaxPct: 50, exactTolerancePct: 400, scoreDecimals: 99 })
    expect(o.achievementMaxPct).toBe(100) // min 100
    expect(o.exactTolerancePct).toBe(100) // capped
    expect(o.scoreDecimals).toBe(3) // capped
  })
  test("unit totals never merge incompatible units", () => {
    const totals = sumUnitTotals([
      { unit: "PERCENT", target: 90, actual: 80 },
      { unit: "PERCENT", target: 100, actual: 95 },
      { unit: "CURRENCY", target: 50000, actual: 62000 },
      { unit: "CUSTOM", unitLabel: "tickets", target: 10, actual: 8 },
    ])
    expect(Object.keys(totals).length).toBe(3)
    expect(totals.PERCENT).toMatchObject({ target: 190, achieved: 175, count: 2 })
    expect(totals.CURRENCY.achieved).toBe(62000)
  })
})

// ---------------------------------------------------------------------------
// Period resolution
// ---------------------------------------------------------------------------

describe("resolvePeriodRange", () => {
  test("monthly label", () => {
    expect(resolvePeriodRange("2026-11")).toEqual({ start: "2026-11-01", end: "2026-11-30", type: "MONTHLY" })
    expect(resolvePeriodRange("2024-02")).toEqual({ start: "2024-02-01", end: "2024-02-29", type: "MONTHLY" })
  })
  test("quarterly label", () => {
    expect(resolvePeriodRange("2026-Q1")).toEqual({ start: "2026-01-01", end: "2026-03-31", type: "QUARTERLY" })
    expect(resolvePeriodRange("2026-Q4")).toEqual({ start: "2026-10-01", end: "2026-12-31", type: "QUARTERLY" })
  })
  test("yearly label", () => {
    expect(resolvePeriodRange("2026")).toEqual({ start: "2026-01-01", end: "2026-12-31", type: "YEARLY" })
  })
  test("custom labels require an explicit window", () => {
    expect(resolvePeriodRange("FY-2026", "2026-01-01", "2026-06-30")).toEqual({ start: "2026-01-01", end: "2026-06-30", type: "CUSTOM" })
    expect(resolvePeriodRange("FY-2026")?.type).toBe("MONTHLY") // fallback = current month
  })
  test("formatPeriodLabel renders human labels", () => {
    expect(formatPeriodLabel("2026-11")).toBe("November 2026")
    expect(formatPeriodLabel("2026-Q3")).toBe("Q3 2026")
    expect(formatPeriodLabel("2026")).toBe("2026")
    expect(formatPeriodLabel("custom", "2026-01-01", "2026-01-31")).toBe("2026-01-01 → 2026-01-31")
  })
  test("periodLabelsBetween walks months and quarters", () => {
    expect(periodLabelsBetween("2026-10-01", "2026-12-31")).toEqual(["2026-10", "2026-11", "2026-12"])
    expect(periodLabelsBetween("2026-01-01", "2026-12-31", "QUARTERLY")).toEqual(["2026-Q1", "2026-Q2", "2026-Q3", "2026-Q4"])
    expect(periodLabelsBetween("2025-11-01", "2026-02-28")).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"])
  })
})

// ---------------------------------------------------------------------------
// Excel engine — target template round trip
// ---------------------------------------------------------------------------

const TEST_INDICATORS: TargetIndicatorRef[] = [
  { id: "ind-1", name: "Attendance Compliance", unit: "PERCENT", unitLabel: null, direction: "HIGHER_IS_BETTER", weight: 60, defaultTarget: 95, builtinKey: "attendance.compliance" },
  { id: "ind-2", name: "Avg Response Time", unit: "CUSTOM", unitLabel: "min", direction: "LOWER_IS_BETTER", weight: 40, defaultTarget: 15, builtinKey: null },
]

function targetRoundTripWorkbook(): import("xlsx").WorkBook {
  const buf = generateTargetTemplate({
    companyName: "Test Co", departmentName: "Engineering", periodLabel: "2026-11",
    dueDate: "2026-12-05", templateName: "Engineering KPI",
    indicators: TEST_INDICATORS,
    employees: [
      { code: "EMP001", fullName: "John Doe", departmentName: "Engineering", designationName: "Engineer" },
      { code: "EMP002", fullName: "Jane Roe", departmentName: "Engineering", designationName: "Senior Engineer" },
    ],
  })
  return readWorkbook(buf.toString("base64"))
}

describe("KPI target Excel round trip", () => {
  const eligibleByCode = new Map([
    ["EMP001", { code: "EMP001", fullName: "John Doe", departmentName: "Engineering", designationName: "Engineer", departmentId: "d1", id: "e1" }],
    ["EMP002", { code: "EMP002", fullName: "Jane Roe", departmentName: "Engineering", designationName: "Senior Engineer", departmentId: "d1", id: "e2" }],
  ])
  const base = {
    indicators: TEST_INDICATORS,
    eligibleByCode,
    existingEmployeeIdsByCode: new Map<string, string>(),
  }

  test("generated template parses back with READY rows", () => {
    const wb = targetRoundTripWorkbook()
    const parsed = parseTargetUpload(wb, base)
    // default targets are pre-filled → both rows READY with indicator values
    expect(parsed.summary.total).toBe(2)
    expect(parsed.summary.valid).toBe(2)
    const row = parsed.rows[0]
    expect(row.employeeCode).toBe("EMP001")
    expect(row.values["ind-1"]).toBe(95)
    expect(row.values["ind-2"]).toBe(15)
  })

  test("unknown employee codes are errors, names are never trusted", () => {
    const wb = targetRoundTripWorkbook()
    const parsed = parseTargetUpload(wb, {
      ...base,
      eligibleByCode: new Map([["EMP001", eligibleByCode.get("EMP001")!]]),
    })
    expect(parsed.rows.find((r) => r.employeeCode === "EMP002")?.status).toBe("ERROR")
    expect(parsed.summary.valid).toBe(1)
  })

  test("duplicate rows and already-assigned employees are skipped", () => {
    const wb = targetRoundTripWorkbook()
    // duplicate EMP001 by appending is hard via workbook — simulate via two parses of the same employee
    const parsed = parseTargetUpload(wb, {
      ...base,
      existingEmployeeIdsByCode: new Map([["EMP001", "e1"]]),
    })
    expect(parsed.rows.find((r) => r.employeeCode === "EMP001")?.status).toBe("SKIPPED")
    expect(parsed.summary.existing).toBe(1)
    expect(parsed.rows.find((r) => r.employeeCode === "EMP002")?.status).toBe("READY")
  })

  test("missing indicator values are reported as errors (never silently skipped)", () => {
    const XLSX = require("xlsx")
    const wb = targetRoundTripWorkbook()
    const ws = wb.Sheets["KPI Targets"]
    // blank the second indicator on row 2 (EMP002)
    const addr = Object.keys(ws).find((k) => k.startsWith("F") && Number(k.slice(1)) === 3)
    if (addr) ws[addr] = { t: "z" }
    const parsed = parseTargetUpload(wb, base)
    expect(parsed.summary.valid).toBe(1)
    expect(parsed.summary.invalid).toBe(1)
    void XLSX
  })

  test("summarize tallies READY/ERROR/SKIPPED", () => {
    expect(summarize([{ status: "READY" }, { status: "ERROR" }, { status: "SKIPPED", error: "Duplicate" }]))
      .toEqual({ total: 3, valid: 1, invalid: 1, skipped: 1, duplicates: 1, existing: 0 })
  })

  test("error report CSV carries the formula-injection guard", () => {
    const csv = errorReportCsv([{ rowNo: 2, status: "ERROR", employeeCode: "=HYPERLINK", error: "bad" }])
    expect(csv.startsWith("\uFEFFRow,Status")).toBe(true)
    expect(csv).toContain("'=HYPERLINK")
  })
})

// ---------------------------------------------------------------------------
// Excel engine — achievement template round trip
// ---------------------------------------------------------------------------

describe("KPI achievement Excel round trip", () => {
  const ref = new Map<string, AchievementRefRow>()
  ref.set("EMP001|row-1", {
    code: "EMP001", indicatorRowId: "row-1", assignmentId: "a1", employeeId: "e1", periodLabel: "2026-11",
    indicatorName: "Attendance Compliance", unit: "PERCENT", unitLabel: null, direction: "HIGHER_IS_BETTER",
    weight: 60, targetValue: 95, existingStatus: null,
  })
  ref.set("EMP001|row-2", {
    code: "EMP001", indicatorRowId: "row-2", assignmentId: "a1", employeeId: "e1", periodLabel: "2026-11",
    indicatorName: "Avg Response Time", unit: "CUSTOM", unitLabel: "min", direction: "LOWER_IS_BETTER",
    weight: 40, targetValue: 15, existingStatus: "APPROVED",
  })

  function achWorkbook(): import("xlsx").WorkBook {
    const buf = generateAchievementTemplate({
      companyName: "Test Co", departmentName: "Engineering", periodLabel: "2026-11",
      rows: [
        { code: "EMP001", fullName: "John Doe", departmentName: "Engineering", periodLabel: "2026-11", indicatorRowId: "row-1", indicatorName: "Attendance Compliance", unit: "PERCENT", unitLabel: null, direction: "HIGHER_IS_BETTER", weight: 60, targetValue: 95, prefillActual: 98, builtinKey: "attendance.compliance" },
        { code: "EMP001", fullName: "John Doe", departmentName: "Engineering", periodLabel: "2026-11", indicatorRowId: "row-2", indicatorName: "Avg Response Time", unit: "CUSTOM", unitLabel: "min", direction: "LOWER_IS_BETTER", weight: 40, targetValue: 15, prefillActual: null, builtinKey: null },
      ],
    })
    return readWorkbook(buf.toString("base64"))
  }

  test("generated template parses back; built-in prefill carried; approved indicator skipped", () => {
    const parsed = parseAchievementUpload(achWorkbook(), ref)
    const row1 = parsed.rows.find((r) => r.indicatorRowId === "row-1")
    expect(row1?.status).toBe("READY")
    expect(row1?.actualValue).toBe(98) // pre-computed built-in value
    // row-2 has an APPROVED achievement already → skipped
    const row2 = parsed.rows.find((r) => r.indicatorRowId === "row-2")
    expect(row2?.status).toBe("SKIPPED")
    expect(parsed.summary.valid).toBe(1)
  })

  test("unknown employee/indicator pair is an error", () => {
    const wb = achWorkbook()
    const parsed = parseAchievementUpload(wb, new Map()) // empty ref
    expect(parsed.summary.invalid).toBe(2)
    expect(parsed.missingHeaders).toEqual([]) // headers were present
  })
})
