/// <reference types="bun-types" />
// ============ Phase 4 WS-A — the integer-paisa money core + EMI calendar +
// AIT slab validation (MON-9 / MON-11 / MON-12) ============
// Every quantity in the payroll engine now has exactly ONE rounding boundary;
// these unit tests pin the boundary semantics of the money core, the
// calendar-month EMI scheduling, and the admin-facing slab-table validation.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { toPaisa, fromPaisa, divHalfUp, divFloor, mulRatio, mulPct, takaOf } from "@/hrm-server/money"
import { addMonthsIso } from "@/hrm-server/utils"
import { applyRecoveryFloorPaisa } from "@/hrm-server/loan-math"
import { mkVendor, mkUser, mkSession } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"

let vendor: { id: string }
let adminToken: string
let fyId: string

beforeAll(async () => {
  vendor = await mkVendor("P4 WS-A Money Vendor")
  const u = await mkUser(vendor.id, { role: "HR_ADMIN", name: "P4 Money Admin" })
  adminToken = await mkSession(u.id, "FULL")
  const created = await postHrm("ait.fiscalYears.save", {
    label: "P4 FY 2026-27", incomeYear: "2026-27", assessmentYear: "2027-28",
    rebateRatePercent: 15, rebateCapFraction: 0.25, rebateCapAmount: 10_000_000,
    exemptionFraction: 0.3333, exemptionCap: 500_000, minimumTax: 5_000, festivalBonusCount: 2,
  }, { bearer: adminToken })
  fyId = created.body.data.id
})

describe("money core — the one boundary per quantity (MON-9)", () => {
  test("toPaisa/fromPaisa round-trip exactly (the H-09 invariant by construction)", () => {
    for (const taka of [0, 0.01, 0.5, 123.45, 50000.5, 61802.65, 9999999.99]) {
      const p = toPaisa(taka)
      expect(p % 10n).toBeGreaterThanOrEqual(0n) // integer paisa, always
      expect(fromPaisa(p)).toBe(taka)
      expect(toPaisa(fromPaisa(p))).toBe(p)
    }
    expect(takaOf(123456n)).toBe(1234.56)
  })

  test("divHalfUp — half rounds UP, negatives mirror Math.round (toward +∞)", () => {
    expect(divHalfUp(5n, 10n)).toBe(1n) // 0.5 → 1 (half up)
    expect(divHalfUp(15n, 10n)).toBe(2n) // 1.5 → 2
    expect(divHalfUp(14n, 10n)).toBe(1n) // 1.4 → 1
    expect(divHalfUp(-5n, 10n)).toBe(0n) // -0.5 → -0 (Math.round semantics)
    expect(divHalfUp(-15n, 10n)).toBe(-1n) // -1.5 → -1 (toward +∞)
    expect(divHalfUp(-25n, 10n)).toBe(-2n) // -2.5 → -2
    // spot-check against Math.round over a range (normalize -0 vs 0 —
    // Object.is distinguishes them but both denote zero)
    for (let n = -50; n <= 50; n++) {
      expect(Number(divHalfUp(BigInt(n), 7n)) || 0).toBe(Math.round(n / 7) || 0)
    }
  })

  test("divFloor — caps never round a budget UP", () => {
    expect(divFloor(99n, 100n)).toBe(0n)
    expect(divFloor(199n, 100n)).toBe(1n)
    expect(divFloor(-5n, 100n)).toBe(-1n) // mathematical floor, not truncation
  })

  test("mulRatio / mulPct — one exact boundary per quantity", () => {
    // weekly proration: 6 of 26 working days of ৳52,000 = ৳12,000 exactly
    expect(mulRatio(toPaisa(52000), 6, 26)).toBe(toPaisa(12000))
    // zero guards mirror weeklyFraction
    expect(mulRatio(toPaisa(52000), 0, 26)).toBe(0n)
    expect(mulRatio(toPaisa(52000), 6, 0)).toBe(0n)
    // never prorates above the basis (fraction cap)
    expect(mulRatio(toPaisa(52000), 30, 26)).toBe(toPaisa(52000))
    // monthly (1/1) is the identity
    expect(mulRatio(toPaisa(52000), 1, 1)).toBe(toPaisa(52000))
    // percentages: 10% of ৳61,801.65 = ৳6,180.17 (half-up on the paisa)
    expect(mulPct(6180165n, 10)).toBe(618017n)
    expect(mulPct(100000n, 12.5)).toBe(12500n) // fractional percent exact
    expect(mulPct(100000n, 0)).toBe(0n)
  })

  test("applyRecoveryFloorPaisa — identical semantics to the float twin", () => {
    // uncapped: recovery under the floor passes through
    let f = applyRecoveryFloorPaisa(toPaisa(2000), toPaisa(1000), toPaisa(40000), 50)
    expect(f.capped).toBe(false)
    expect(f.deferredP).toBe(0n)
    // capped: loan is cut first, then advance; the cap floors (never rounds up)
    f = applyRecoveryFloorPaisa(toPaisa(9000), toPaisa(4000), toPaisa(20000), 50)
    expect(f.capped).toBe(true)
    expect(f.loanDeductionP + f.advanceDeductionP).toBe(1_000_000n) // floor(৳20,000×50%) = ৳10,000 = 1,000,000 paisa
    expect(f.loanDeductionP).toBe(toPaisa(6000)) // loan cut by the ৳3,000 excess first
    expect(f.advanceDeductionP).toBe(toPaisa(4000)) // advance untouched while loan covers the excess
    expect(f.deferredP).toBe(toPaisa(3000))
    // disabled floor (0%) is the historical pass-through
    f = applyRecoveryFloorPaisa(toPaisa(9000), toPaisa(4000), toPaisa(20000), 0)
    expect(f.capped).toBe(false)
    expect(f.loanDeductionP).toBe(toPaisa(9000))
    // negative pre-recovery net → zero cap, everything defers
    f = applyRecoveryFloorPaisa(toPaisa(500), 0n, toPaisa(-100), 50)
    expect(f.capped).toBe(true)
    expect(f.loanDeductionP).toBe(0n)
    expect(f.deferredP).toBe(toPaisa(500))
  })
})

describe("MON-11 — calendar-month EMIs (addMonthsIso)", () => {
  test("dueDate table: i calendar months after the start, end-of-month clamped", () => {
    // the classic drift case: a 31st-of-the-month start
    expect(addMonthsIso("2026-01-31", 1)).toBe("2026-02-28") // non-leap 2026
    expect(addMonthsIso("2024-01-31", 1)).toBe("2024-02-29") // leap year
    expect(addMonthsIso("2026-03-31", 1)).toBe("2026-04-30")
    expect(addMonthsIso("2026-01-31", 2)).toBe("2026-03-31")
    expect(addMonthsIso("2026-01-15", 11)).toBe("2026-12-15")
    expect(addMonthsIso("2026-01-15", 12)).toBe("2027-01-15")
    expect(addMonthsIso("2026-06-30", 12)).toBe("2027-06-30")
  })

  test("February EMIs stay in February — payroll's month-prefix budgeting finds every installment", () => {
    const start = "2026-01-05"
    const months = ["2026-02-05", "2026-03-05", "2026-04-05"]
    for (let i = 1; i <= 3; i++) {
      const due = addMonthsIso(start, i)
      expect(due).toBe(months[i - 1])
      // the payroll budget key is the YYYY-MM prefix of the due date
      expect(due.slice(0, 7)).toBe(months[i - 1].slice(0, 7))
    }
    // consecutive installments are exactly one calendar month apart in the
    // month prefix — the property the legacy 30-day steps broke
    const a = addMonthsIso("2026-12-15", 1)
    const b = addMonthsIso("2026-11-15", 2)
    expect(a.slice(0, 7)).toBe("2027-01")
    expect(b.slice(0, 7)).toBe("2027-01")
  })

  test("an approved loan's schedule uses calendar months (end-to-end through applyLoanDecision)", async () => {
    const emp = await db.employee.create({ data: { vendorId: vendor.id, fullName: "P4 EMI Emp", code: "P4EMI" + Date.now() } })
    const loan = await db.loan.create({
      data: {
        vendorId: vendor.id, employeeId: emp.id, principal: 12000, installments: 12,
        installmentAmount: 1000, startDate: "2026-11-30", status: "PENDING", outstanding: 12000,
      },
    })
    const { applyLoanDecision } = await import("@/hrm-server/routes/finance")
    await applyLoanDecision({ userId: "test", userName: "P4", vendorId: vendor.id }, loan.id, "APPROVED")
    const inst = await db.loanInstallment.findMany({ where: { loanId: loan.id }, orderBy: { no: "asc" } })
    expect(inst.length).toBe(12)
    // #1: Dec 30 (calendar month after Nov 30); #3: Feb 28 — IN February
    expect(inst[0].dueDate).toBe("2026-12-30")
    expect(inst[2].dueDate).toBe("2027-02-28")
    expect(inst[2].dueDate.slice(0, 7)).toBe("2027-02")
    // every consecutive pair is exactly one calendar month apart in the prefix
    for (let i = 1; i < inst.length; i++) {
      const [y1, m1] = inst[i - 1].dueDate.split("-").map(Number)
      const [y2, m2] = inst[i].dueDate.split("-").map(Number)
      expect((y2 * 12 + m2) - (y1 * 12 + m1)).toBe(1)
    }
    const after = await db.loan.findUnique({ where: { id: loan.id } })
    expect(after?.status).toBe("ACTIVE")
    expect(after?.endDate).toBe(addMonthsIso("2026-11-30", 12))
  })
})

describe("MON-12 — AIT slab-table validation + bracket echo", () => {
  test("a pasted CUMULATIVE table is saved but flagged with the WIDTHS warning", async () => {
    const res = await postHrm("ait.slabs.save", {
      fiscalYearId: fyId,
      slabs: [
        { slabLabel: "First ৳1L", upperLimit: 100000, ratePercent: 5 },
        { slabLabel: "Next ৳3L", upperLimit: 400000, ratePercent: 10 },
        { slabLabel: "Next ৳5L", upperLimit: 900000, ratePercent: 15 },
        { slabLabel: "Rest", upperLimit: "", ratePercent: 20 },
      ],
    }, { bearer: adminToken })
    expect(res.body.ok).toBe(true)
    expect(res.body.data.semantics).toBe("WIDTHS")
    expect(String(res.body.data.warning)).toMatch(/cumulative/i)
    // the echo shows the ACTUAL bands the engine will apply
    expect(res.body.data.brackets[0]).toMatchObject({ from: 0, to: 100000, rate: 5 })
    expect(res.body.data.brackets[1]).toMatchObject({ from: 100000, to: 500000, rate: 10 })
    expect(res.body.data.brackets[2]).toMatchObject({ from: 500000, to: 1400000, rate: 15 })
    expect(res.body.data.brackets[3]).toMatchObject({ from: 1400000, to: null, rate: 20 })
    // worked example on ৳10,00,000 UNDER THE PASTE INTERPRETATION (what the
    // admin must see): bands [0–1L)@5% + [1L–5L)@10% + [5L–14L)@15% →
    // ৳5,000 + ৳40,000 + ৳75,000 = ৳1,20,000 — visibly wrong vs the published
    // intent, which is exactly why the echo + warning exist
    expect(res.body.data.example).toMatchObject({ annualIncome: 10_00_000, tax: 120000 })
  })

  test("a DECREASING rate is rejected (marginal schedules never decrease)", async () => {
    const res = await postHrm("ait.slabs.save", {
      fiscalYearId: fyId,
      slabs: [
        { upperLimit: 100000, ratePercent: 10 },
        { upperLimit: 100000, ratePercent: 5 },
        { upperLimit: "", ratePercent: 15 },
      ],
    }, { bearer: adminToken })
    expect(res.body.ok).toBe(false)
    expect(String(res.body.error)).toMatch(/never decrease/i)
  })

  test("an all-zero table is rejected (it would withhold nothing)", async () => {
    const res = await postHrm("ait.slabs.save", {
      fiscalYearId: fyId,
      slabs: [
        { upperLimit: 100000, ratePercent: 0 },
        { upperLimit: "", ratePercent: 0 },
      ],
    }, { bearer: adminToken })
    expect(res.body.ok).toBe(false)
    expect(String(res.body.error)).toMatch(/0%/)
  })

  test("a mid-table unlimited band is rejected (later slabs would be unreachable)", async () => {
    const res = await postHrm("ait.slabs.save", {
      fiscalYearId: fyId,
      slabs: [
        { upperLimit: "", ratePercent: 5 },
        { upperLimit: 100000, ratePercent: 10 },
      ],
    }, { bearer: adminToken })
    expect(res.body.ok).toBe(false)
    expect(String(res.body.error)).toMatch(/FINAL slab/i)
  })

  test("a correct WIDTHS table echoes the intended brackets with no warning", async () => {
    const res = await postHrm("ait.slabs.save", {
      fiscalYearId: fyId,
      slabs: [
        { slabLabel: "First ৳1L", upperLimit: 100000, ratePercent: 5 },
        { slabLabel: "Next ৳3L", upperLimit: 300000, ratePercent: 10 },
        { slabLabel: "Next ৳5L", upperLimit: 500000, ratePercent: 15 },
        { slabLabel: "Next ৳10L", upperLimit: 1000000, ratePercent: 20 },
        { slabLabel: "Rest", upperLimit: "", ratePercent: 25 },
      ],
    }, { bearer: adminToken })
    expect(res.body.ok).toBe(true)
    expect(res.body.data.warning).toBeUndefined()
    expect(res.body.data.brackets).toHaveLength(5)
    expect(res.body.data.brackets[3]).toMatchObject({ from: 900000, to: 1900000, rate: 20 })
    expect(res.body.data.brackets[4]).toMatchObject({ from: 1900000, to: null, rate: 25 })
    // worked example: 5k + 30k + 75k + 150k(10L×15%… wait — 10L at 20% = 200k) —
    // ৳10,00,000 = 1L×5% + 3L×10% + 5L×15% + 1L×20% = 5000+30000+75000+20000 = ৳1,30,000
    expect(res.body.data.example.tax).toBe(130000)
  })
})
