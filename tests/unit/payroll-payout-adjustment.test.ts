/// <reference types="bun-types" />
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkSession, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"

let vendor: { id: string }
let owner: { id: string; token: string }
let employee: { id: string }

beforeAll(async () => {
  vendor = await mkVendor("Payout Adjustment Vendor")
  const u = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "Payout Adj Owner" })
  owner = { id: u.id, token: await mkSession(u.id, "FULL") }
  employee = await db.employee.create({
    data: {
      vendorId: vendor.id,
      fullName: uniq("Adj Emp"),
      code: uniq("ADJ"),
      joiningDate: "2026-01-01",
      employmentType: "PERMANENT",
      status: "ACTIVE",
      salaryPayoutMethod: "BANK",
    },
  })
})

describe("payroll.payout.confirm with adjustment runs", () => {
  test("negative net adjustment run (recovery) posts Dr Bank, Cr Salaries Payable without error", async () => {
    const run = await db.payrollRun.create({
      data: {
        vendorId: vendor.id,
        periodMonth: 10,
        periodYear: 2026,
        periodWeek: 0,
        frequency: "MONTHLY",
        runType: "ADJUSTMENT",
        adjustSeq: 1,
        status: "PAID",
        paymentDate: "2026-10-20",
        totalGross: 0,
        totalNet: -5000,
        createdBy: owner.id,
      },
    })

    await db.payrollEntry.create({
      data: {
        runId: run.id,
        employeeId: employee.id,
        vendorId: vendor.id,
        status: "INCLUDED",
        gross: 0,
        grossPaisa: BigInt(0),
        net: -5000,
        netPaisa: BigInt(-500000),
      },
    })

    const res = await postHrm("payroll.payout.confirm", { runId: run.id }, { bearer: owner.token })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.journalId).toBeTruthy()

    const journal = await db.accountJournal.findUnique({ where: { id: res.body.data.journalId } })
    expect(journal).toBeTruthy()
    expect(journal?.amount).toBe(5000)
    expect(journal?.refType).toBe("SALARY_PAYOUT")

    const lines = JSON.parse(journal?.linesJson || "[]")
    const bankLine = lines.find((l: any) => l.account === "1200")
    const payableLine = lines.find((l: any) => l.account === "2100")

    expect(bankLine?.debit).toBe(5000)
    expect(payableLine?.credit).toBe(5000)

    const updatedRun = await db.payrollRun.findUnique({ where: { id: run.id } })
    expect(updatedRun?.payoutConfirmedAt).toBeTruthy()
    expect(updatedRun?.payoutJournalId).toBe(journal?.id)

    // Idempotent confirmation
    const resAgain = await postHrm("payroll.payout.confirm", { runId: run.id }, { bearer: owner.token })
    expect(resAgain.status).toBe(200)
    expect(resAgain.body.data.alreadyConfirmed).toBe(true)
    expect(resAgain.body.data.journalId).toBe(journal?.id)
  })

  test("positive net adjustment run (disbursement) posts Dr Salaries Payable, Cr Bank", async () => {
    const run = await db.payrollRun.create({
      data: {
        vendorId: vendor.id,
        periodMonth: 11,
        periodYear: 2026,
        periodWeek: 0,
        frequency: "MONTHLY",
        runType: "ADJUSTMENT",
        adjustSeq: 2,
        status: "PAID",
        paymentDate: "2026-11-20",
        totalGross: 4000,
        totalNet: 4000,
        createdBy: owner.id,
      },
    })

    await db.payrollEntry.create({
      data: {
        runId: run.id,
        employeeId: employee.id,
        vendorId: vendor.id,
        status: "INCLUDED",
        gross: 4000,
        grossPaisa: BigInt(400000),
        net: 4000,
        netPaisa: BigInt(400000),
      },
    })

    const res = await postHrm("payroll.payout.confirm", { runId: run.id }, { bearer: owner.token })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.journalId).toBeTruthy()

    const journal = await db.accountJournal.findUnique({ where: { id: res.body.data.journalId } })
    expect(journal?.amount).toBe(4000)

    const lines = JSON.parse(journal?.linesJson || "[]")
    const bankLine = lines.find((l: any) => l.account === "1200")
    const payableLine = lines.find((l: any) => l.account === "2100")

    expect(payableLine?.debit).toBe(4000)
    expect(bankLine?.credit).toBe(4000)
  })

  test("zero delta adjustment run confirms without error and posts no voucher", async () => {
    const run = await db.payrollRun.create({
      data: {
        vendorId: vendor.id,
        periodMonth: 12,
        periodYear: 2026,
        periodWeek: 0,
        frequency: "MONTHLY",
        runType: "ADJUSTMENT",
        adjustSeq: 3,
        status: "PAID",
        paymentDate: "2026-12-20",
        totalGross: 0,
        totalNet: 0,
        createdBy: owner.id,
      },
    })

    await db.payrollEntry.create({
      data: {
        runId: run.id,
        employeeId: employee.id,
        vendorId: vendor.id,
        status: "INCLUDED",
        gross: 0,
        grossPaisa: BigInt(0),
        net: 0,
        netPaisa: BigInt(0),
      },
    })

    const res = await postHrm("payroll.payout.confirm", { runId: run.id }, { bearer: owner.token })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.journalId).toBeNull()

    const updatedRun = await db.payrollRun.findUnique({ where: { id: run.id } })
    expect(updatedRun?.payoutConfirmedAt).toBeTruthy()
    expect(updatedRun?.payoutJournalId).toBeNull()
  })

  test("buildSalaryExport includes both INCLUDED and ADJUSTED entries of a run", async () => {
    const { buildSalaryExport } = await import("@/hrm-server/salary-export")
    const emp2 = await db.employee.create({
      data: {
        vendorId: vendor.id,
        fullName: uniq("Adj Emp 2"),
        code: uniq("ADJ2"),
        joiningDate: "2026-01-01",
        employmentType: "PERMANENT",
        status: "ACTIVE",
        salaryPayoutMethod: "CASH",
      },
    })

    const run = await db.payrollRun.create({
      data: {
        vendorId: vendor.id,
        periodMonth: 8,
        periodYear: 2026,
        periodWeek: 0,
        frequency: "MONTHLY",
        runType: "REGULAR",
        status: "PAID",
        paymentDate: "2026-08-30",
        totalGross: 50000,
        totalNet: 45000,
        createdBy: owner.id,
      },
    })

    // One entry is ADJUSTED (e.g. from an adjustment run), one is INCLUDED
    await db.payrollEntry.create({
      data: {
        runId: run.id,
        employeeId: employee.id,
        vendorId: vendor.id,
        status: "ADJUSTED",
        gross: 30000,
        grossPaisa: BigInt(3000000),
        net: 27000,
        netPaisa: BigInt(2700000),
      },
    })

    await db.payrollEntry.create({
      data: {
        runId: run.id,
        employeeId: emp2.id,
        vendorId: vendor.id,
        status: "INCLUDED",
        gross: 20000,
        grossPaisa: BigInt(2000000),
        net: 18000,
        netPaisa: BigInt(1800000),
      },
    })

    const exportData = await buildSalaryExport(vendor.id, run.id, "ALL", {})
    expect(exportData.totals.employees).toBe(2)
    expect(exportData.rows.length).toBe(2)
    expect(exportData.totals.gross).toBe(50000)
    expect(exportData.totals.net).toBe(45000)
  })
})
