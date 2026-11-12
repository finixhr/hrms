/// <reference types="bun-types" />
// ============ Unit tests — salary export shaping + rate limiting (2026-10 round §49–§53, §66) ============
import { test, expect, describe } from "bun:test"
import { exportColumns, renderCsv, type ExportRow, type ExportTotals, type SalaryExportResult } from "@/hrm-server/salary-export"
import { rateLimit } from "@/hrm-server/rate-limit"

const row = (over: Partial<ExportRow> = {}): ExportRow => ({
  code: "EMP-0001", fullName: "Rahim Miah", designation: "Sales Officer", department: "Sales", branch: "Head Office",
  gross: 15000, ot: 500, bonus: 1000, deductions: 500, ait: 250, net: 15750, payoutMethod: "BANK",
  bank: "BRAC Bank", bankBranch: "Gulshan", accountName: "Rahim Miah", accountNumber: "1701204578412003",
  routingNumber: "060330204", mfsProvider: null, mfsAccountName: null, mfsNumber: null, ...over,
})

const totals: ExportTotals = { employees: 2, gross: 30000, ot: 1000, bonus: 2000, deductions: 1000, ait: 500, net: 30500 }
const data = (rows: ExportRow[]): SalaryExportResult => ({ rows, totals, runLabel: "2026-10 (REGULAR)", skipped: [] })

describe("export column sets (§49–§52 — right data, no leakage)", () => {
  test("ALL sheet carries the full salary breakdown + payout method", () => {
    const cols = exportColumns("ALL").map((c) => c.label)
    for (const expected of ["Employee ID", "Gross Salary", "OT", "Bonus", "Deductions", "AIT", "Net Salary", "Payout Method"]) {
      expect(cols).toContain(expected)
    }
  })

  test("BANK sheet exposes bank transfer columns only (§50)", () => {
    const keys = exportColumns("BANK").map((c) => c.key)
    expect(keys).toContain("bank")
    expect(keys).toContain("bankBranch")
    expect(keys).toContain("accountNumber")
    expect(keys).toContain("routingNumber")
    expect(keys).toContain("net")
    // no department/branch noise on the bank sheet
    expect(keys).not.toContain("department")
    expect(keys).not.toContain("payoutMethod")
  })

  test("CASH sheet has a signature column and NO bank data (§51)", () => {
    const keys = exportColumns("CASH").map((c) => c.key)
    expect(keys).toContain("signatureCol")
    expect(keys).toContain("branch")
    expect(keys).not.toContain("bank")
    expect(keys).not.toContain("accountNumber")
    expect(keys).not.toContain("routingNumber")
  })

  test("MFS sheet has provider/account columns (§52)", () => {
    const keys = exportColumns("MFS").map((c) => c.key)
    expect(keys).toContain("mfsProvider")
    expect(keys).toContain("mfsNumber")
    expect(keys).not.toContain("bank")
  })
})

describe("CSV rendering (§41 totals row + §53 CSV format)", () => {
  test("renders header, rows and a TOTAL line", () => {
    const csv = renderCsv("ALL", data([row(), row({ code: "EMP-0002", payoutMethod: "CASH" })]))
    const lines = csv.trim().split("\n")
    expect(lines[0]).toContain("Employee ID")
    expect(lines[1]).toContain("EMP-0001")
    expect(lines[1]).toContain("15750")
    expect(lines[lines.length - 1]).toContain("TOTAL")
    expect(lines[lines.length - 1]).toContain("2 employees")
  })

  test("bank sheet rows render account numbers, cash sheet does not", () => {
    const bank = renderCsv("BANK", data([row()]))
    expect(bank).toContain("1701204578412003")
    const cash = renderCsv("CASH", data([row()]))
    expect(cash).not.toContain("1701204578412003")
  })

  test("XLSX and PDF renderers produce non-empty payloads (§53 formats)", async () => {
    const { renderXlsx, renderPdf } = await import("@/hrm-server/salary-export")
    const xlsx = renderXlsx("ALL", data([row()]), "2026-10")
    expect(xlsx.length).toBeGreaterThan(1000) // real xlsx container
    expect(xlsx.slice(0, 2).toString()).toBe("PK") // zip magic
    const pdf = await renderPdf("ALL", data([row()]), "2026-10", "Test Co")
    expect(pdf.length).toBeGreaterThan(500)
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toContain("%PDF")
  })
})

describe("RPT-02 — totals row alignment (column-count parity on all four variants)", () => {
  const cells = (line: string) => line.split(",").map((c) => c.replace(/^"|"$/g, "").replace(/^'/, ""))

  for (const type of ["ALL", "BANK", "CASH", "MFS"] as const) {
    test(`${type} totals row has exactly as many cells as the header`, () => {
      const csv = renderCsv(type, data([row(), row({ code: "EMP-0002" })]))
      const lines = csv.trim().split("\n")
      const header = lines[0]!
      const totals = lines[lines.length - 1]!
      expect(cells(totals).length).toBe(cells(header).length)
    })

    test(`${type} net total lands under the Net Salary column`, () => {
      const csv = renderCsv(type, data([row(), row({ code: "EMP-0002" })]))
      const lines = csv.trim().split("\n")
      const header = cells(lines[0]!)
      const totals = cells(lines[lines.length - 1]!)
      const netIdx = header.findIndex((h) => h === "Net Salary")
      expect(netIdx).toBeGreaterThanOrEqual(0)
      // the shared totals fixture nets 30500 (2 employees × 15750 row net = 31500
      // is NOT what the fixture declares — totals are fixture-driven, not row-derived)
      expect(Number(totals[netIdx])).toBe(30500)
    })
  }

  test("ALL totals also align every sum under its own header (gross/ot/bonus/deductions/ait)", () => {
    const csv = renderCsv("ALL", data([row(), row({ code: "EMP-0002" })]))
    const lines = csv.trim().split("\n")
    const header = cells(lines[0]!)
    const totals = cells(lines[lines.length - 1]!)
    const at = (label: string) => Number(totals[header.findIndex((h) => h === label)])
    expect(at("Gross Salary")).toBe(30000)
    expect(at("OT")).toBe(1000)
    expect(at("Bonus")).toBe(2000)
    expect(at("Deductions")).toBe(1000)
    expect(at("AIT")).toBe(500)
  })
})

describe("rate limiter (§66 targeted limiting)", () => {
  test("allows up to the limit inside the window and blocks after", () => {
    const key = `test:${Date.now()}:${Math.random()}`
    for (let i = 0; i < 3; i++) {
      const r = rateLimit(key, 3, 60_000)
      expect(r.ok).toBe(true)
    }
    const blocked = rateLimit(key, 3, 60_000)
    expect(blocked.ok).toBe(false)
    expect(blocked.retryAfterSec).toBeGreaterThan(0)
  })

  test("independent keys do not interfere", () => {
    const a = `a:${Date.now()}:${Math.random()}`
    const b = `b:${Date.now()}:${Math.random()}`
    rateLimit(a, 1, 60_000)
    expect(rateLimit(a, 1, 60_000).ok).toBe(false)
    expect(rateLimit(b, 1, 60_000).ok).toBe(true)
  })
})
