/// <reference types="bun-types" />
// ============ H-09 regression: staged paisa migration ============
// Golden-file verification (step 4): every PayrollEntry money amount written
// by calculateRun carries an integer paisa shadow that agrees with the Float
// value to the paisa — pre-migration (Float) and post-migration (paisa)
// reads of net pay must agree to the taka. Also verifies the step-2 backfill
// invariant on legacy rows (no row loses more than 1 paisa).
import "./_testdb" // first — sets DATABASE_URL before db.ts is constructed
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, makeCtx, uniq } from "./_fixtures"
import { calculateRun } from "@/hrm-server/payroll"

let vendor: { id: string }
let owner: { id: string; vendorId: string; role: string }
let ctx: any

const PAISA_FIELDS = [
  "gross", "otAmount", "bonus", "commission", "absenceDeduction", "lateDeduction",
  "loanDeduction", "advanceDeduction", "otherDeduction", "ait", "net",
] as const

beforeAll(async () => {
  vendor = await mkVendor("H09 Vendor")
  owner = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "Owner" })
  ctx = makeCtx(owner, ["*"])
})

describe("H-09 golden file — engine dual-write", () => {
  test("calculateRun writes paisa shadows that agree with the floats to the taka", async () => {
    const emp = await mkEmployee(vendor.id, { fullName: "H09 Golden Emp" })
    // paisa-precision salary: every component carries fractional taka
    const basic = 50000.50, houseRent = 10000.25, medical = 500.75
    const conveyance = 1000.10, food = 300.05
    const gross = basic + houseRent + medical + conveyance + food // 61802.65 — fractional by construction
    await db.salaryStructure.create({
      data: {
        vendorId: vendor.id, employeeId: emp.id,
        effectiveFrom: "2026-01-01", status: "ACTIVE",
        basic, houseRent, medical, conveyance, food,
        gross, // stored with paisa precision
        // 2026-10-13 — *Paisa columns are BIGINT: writes must be bigint
        basicPaisa: BigInt(Math.round(basic * 100)), houseRentPaisa: BigInt(Math.round(houseRent * 100)),
        medicalPaisa: BigInt(Math.round(medical * 100)), conveyancePaisa: BigInt(Math.round(conveyance * 100)),
        foodPaisa: BigInt(Math.round(food * 100)), grossPaisa: BigInt(Math.round(gross * 100)),
      },
    })
    // full attendance for the month so gross is not eaten by absence proration
    const month = 7, year = 2026
    const daysInMonth = new Date(year, month, 0).getDate()
    const rows: any[] = []
    for (let d = 1; d <= daysInMonth; d++) {
      const date = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`
      const dow = new Date(date + "T00:00:00Z").getUTCDay() // 0=Sun … 6=Sat
      if (dow === 5) continue // Friday weekly off (BD default)
      rows.push({ vendorId: vendor.id, employeeId: emp.id, date, status: "PRESENT" })
    }
    await db.attendance.createMany({ data: rows })

    const run = await db.payrollRun.create({
      data: {
        vendorId: vendor.id, periodMonth: month, periodYear: year, periodWeek: 0,
        frequency: "MONTHLY", runType: "REGULAR", status: "DRAFT", adjustSeq: 0, createdBy: owner.id,
      },
    })
    await calculateRun(ctx, run.id)

    const entries = await db.payrollEntry.findMany({ where: { runId: run.id } })
    expect(entries.length).toBeGreaterThanOrEqual(1)
    for (const e of entries) {
      for (const f of PAISA_FIELDS) {
        // 2026-10-13 — paisa columns are BIGINT → reads come back as bigint;
        // convert to Number for the invariant math (all values ≪ 2^53)
        const paisa = Number((e as any)[`${f}Paisa`])
        const float = (e as any)[f]
        expect(paisa).toBeNumber()
        // dual-write invariant: exact paisa shadow of the float
        expect(paisa).toBe(Math.round(float * 100))
        // H-9 acceptance: pre-migration vs post-migration agree to the taka
        expect(Math.round(paisa / 100)).toBe(Math.round(float))
      }
    }
    // business anchor: full attendance → gross is the structure gross
    expect(Math.round(entries[0].gross)).toBe(Math.round(gross))

    // run totals: paisa shadows agree with the float totals
    const after = await db.payrollRun.findFirst({ where: { id: run.id } })
    expect(Number(after?.totalNetPaisa)).toBe(Math.round(after!.totalNet * 100))
    expect(Math.round(Number(after!.totalNetPaisa) / 100)).toBe(Math.round(after!.totalNet))
    // totals are the sum of entry paisa within ≤1 paisa per entry (rounding accumulation bound)
    const sumEntryNetPaisa = entries.reduce((s, e) => s + Number((e as any).netPaisa), 0)
    expect(Math.abs(Number(after!.totalNetPaisa) - sumEntryNetPaisa)).toBeLessThanOrEqual(entries.length)
  })
})

describe("H-09 step 2 — backfill invariant on legacy rows", () => {
  test("ROUND(float * 100) loses no more than 1 paisa on every column (SalaryStructure + PayrollEntry + PayrollRun)", async () => {
    const vendor2 = await mkVendor("H09 Legacy Vendor")
    const owner2 = await mkUser(vendor2.id, { role: "VENDOR_OWNER", name: "Owner2" })
    const emp = await mkEmployee(vendor2.id, { fullName: "H09 Legacy Emp" })
    const legacy = await db.salaryStructure.create({
      data: {
        vendorId: vendor2.id, employeeId: emp.id, effectiveFrom: "2026-01-01", status: "ACTIVE",
        basic: 12345.67, houseRent: 2345.89, medical: 999.99, conveyance: 777.01,
        food: 555.55, mobileAllow: 111.11, internetAllow: 222.22,
        attendanceAllow: 333.33, otherAllowance: 444.44, gross: 12345.67 + 2345.89 + 999.99 + 777.01 + 555.55 + 111.11 + 222.22 + 333.33 + 444.44,
        // legacy row: paisa columns NULL (pre-migration state)
      },
    })
    const run = await db.payrollRun.create({
      data: {
        vendorId: vendor2.id, periodMonth: 7, periodYear: 2026, periodWeek: 0,
        frequency: "MONTHLY", runType: "REGULAR", status: "DRAFT", adjustSeq: 0, createdBy: owner2.id,
        totalGross: 12345.67, totalOt: 6789.01, totalBonus: 3456.78,
        totalDeduction: 234.56, totalAit: 789.12, totalNet: 4567.89,
      },
    })
    const entry = await db.payrollEntry.create({
      data: {
        vendorId: vendor2.id, runId: run.id, employeeId: emp.id, structureId: legacy.id,
        gross: 12345.67, otAmount: 678.91, bonus: 345.67, commission: 12.34,
        absenceDeduction: 56.78, lateDeduction: 9.87, loanDeduction: 654.32,
        advanceDeduction: 321.09, otherDeduction: 87.65, ait: 456.78, net: 89.01,
      },
    })

    // ---- run the shipped backfill statements (PostgreSQL dialect: $1 placeholders;
    // the SQLite original with ? placeholders is preserved in the repository's
    // pre-cutover git history (L-6 removed the archived migrations_sqlite dir
    // from the deliverable) — the invariant it guards is unchanged:
    // ROUND(float * 100) loses no more than 1 paisa) ----
    await db.$executeRawUnsafe(`UPDATE "SalaryStructure" SET
      "basicPaisa" = ROUND("basic" * 100), "houseRentPaisa" = ROUND("houseRent" * 100),
      "medicalPaisa" = ROUND("medical" * 100), "conveyancePaisa" = ROUND("conveyance" * 100),
      "foodPaisa" = ROUND("food" * 100), "mobileAllowPaisa" = ROUND("mobileAllow" * 100),
      "internetAllowPaisa" = ROUND("internetAllow" * 100), "attendanceAllowPaisa" = ROUND("attendanceAllow" * 100),
      "otherAllowancePaisa" = ROUND("otherAllowance" * 100), "grossPaisa" = ROUND("gross" * 100)
      WHERE "id" = $1`, legacy.id)
    await db.$executeRawUnsafe(`UPDATE "PayrollRun" SET
      "totalGrossPaisa" = ROUND("totalGross" * 100), "totalOtPaisa" = ROUND("totalOt" * 100),
      "totalBonusPaisa" = ROUND("totalBonus" * 100), "totalDeductionPaisa" = ROUND("totalDeduction" * 100),
      "totalAitPaisa" = ROUND("totalAit" * 100), "totalNetPaisa" = ROUND("totalNet" * 100)
      WHERE "id" = $1`, run.id)
    await db.$executeRawUnsafe(`UPDATE "PayrollEntry" SET
      "grossPaisa" = ROUND("gross" * 100), "otAmountPaisa" = ROUND("otAmount" * 100),
      "bonusPaisa" = ROUND("bonus" * 100), "commissionPaisa" = ROUND("commission" * 100),
      "absenceDeductionPaisa" = ROUND("absenceDeduction" * 100), "lateDeductionPaisa" = ROUND("lateDeduction" * 100),
      "loanDeductionPaisa" = ROUND("loanDeduction" * 100), "advanceDeductionPaisa" = ROUND("advanceDeduction" * 100),
      "otherDeductionPaisa" = ROUND("otherDeduction" * 100), "aitPaisa" = ROUND("ait" * 100),
      "netPaisa" = ROUND("net" * 100)
      WHERE "id" = $1`, entry.id)

    // ---- invariant: |paisa − float×100| ≤ 1 paisa (ROUND guarantees ≤ 0.5) ----
    // 2026-10-13 — paisa columns are BIGINT → reads are bigint; Number() first
    const s = await db.salaryStructure.findFirst({ where: { id: legacy.id } })
    for (const f of ["basic", "houseRent", "medical", "conveyance", "food", "mobileAllow", "internetAllow", "attendanceAllow", "otherAllowance", "gross"]) {
      expect(Math.abs(Number((s as any)[`${f}Paisa`]) - (s as any)[f] * 100)).toBeLessThanOrEqual(1)
    }
    const r = await db.payrollRun.findFirst({ where: { id: run.id } })
    for (const f of ["totalGross", "totalOt", "totalBonus", "totalDeduction", "totalAit", "totalNet"]) {
      expect(Math.abs(Number((r as any)[`${f}Paisa`]) - (r as any)[f] * 100)).toBeLessThanOrEqual(1)
    }
    const e2 = await db.payrollEntry.findFirst({ where: { id: entry.id } })
    for (const f of PAISA_FIELDS) {
      expect(Math.abs(Number((e2 as any)[`${f}Paisa`]) - (e2 as any)[f] * 100)).toBeLessThanOrEqual(1)
    }
  })
})
