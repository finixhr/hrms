// ============ Salary export engine (2026-10 round §48–§54, §76–§77) ============
// Server-side export builder over a selected payroll run.
//   Types:  ALL | BANK | CASH | MFS (payout method resolved server-side from
//           the employee's designated payout configuration — NEVER from a
//           client-asserted value, §77)
//   Formats: XLSX (xlsx pkg), CSV (shared util), PDF (pdf-lib — pure JS, runs
//           under Bun + Next standalone, §53)
//
// Security contract: the ROUTE enforces permissions/audit; this module only
// shapes data. Totals are computed from the FULL filtered set server-side
// (§79) — never from browser-visible paginated rows.
import * as XLSX from "xlsx"
import { PDFDocument, StandardFonts, rgb } from "pdf-lib"
import { db } from "@/lib/db"
import { csv, j } from "./utils"
import { resolveSalaryPayouts } from "./payout"

export type SalaryExportType = "ALL" | "BANK" | "CASH" | "MFS"
export type SalaryExportFormat = "xlsx" | "csv" | "pdf"

export type ExportFilters = {
  branchId?: string | null
  departmentId?: string | null
  employeeId?: string | null
}

export type ExportRow = {
  code: string
  fullName: string
  designation: string
  department: string
  branch: string
  gross: number
  ot: number
  bonus: number
  deductions: number
  ait: number
  net: number
  payoutMethod: string
  // bank-transfer columns (BANK export)
  bank?: string | null
  bankBranch?: string | null
  accountName?: string | null
  accountNumber?: string | null
  routingNumber?: string | null
  // MFS columns
  mfsProvider?: string | null
  mfsAccountName?: string | null
  mfsNumber?: string | null
  /** CASH sheet only: blank column for physical payment confirmation (§51) */
  signatureCol?: string
}

export type ExportTotals = {
  employees: number
  gross: number
  ot: number
  bonus: number
  deductions: number
  ait: number
  net: number
}

export type SalaryExportResult = {
  rows: ExportRow[]
  totals: ExportTotals
  runLabel: string
  skipped: { employeeId: string; reason: string }[]
}

/** Collect + shape the export dataset from a payroll run (server-authoritative). */
export async function buildSalaryExport(
  vendorId: string,
  runId: string,
  type: SalaryExportType,
  filters: ExportFilters
): Promise<SalaryExportResult> {
  const run = await db.payrollRun.findFirst({ where: { id: runId, vendorId } })
  if (!run) throw Object.assign(new Error("Payroll run not found"), { code: 404 })
  // R1 — a cancelled run's entries are void (payslips cleared, ledgers
  // reverted): exporting them would produce an unpayable sheet for money that
  // never moved. Refuse explicitly instead of returning stale rows.
  if (run.status === "CANCELLED") {
    throw Object.assign(new Error("This payroll run was cancelled — re-create and pay the month before exporting"), { code: 400 })
  }
  const entries = await db.payrollEntry.findMany({ where: { runId, status: { in: ["INCLUDED", "ADJUSTED"] } } })
  const emps = await db.employee.findMany({
    where: {
      vendorId,
      ...(filters.employeeId ? { id: filters.employeeId } : {}),
      ...(filters.branchId ? { branchId: filters.branchId } : {}),
      ...(filters.departmentId ? { departmentId: filters.departmentId } : {}),
    },
  })
  const empById = new Map(emps.map((e) => [e.id, e]))
  const desigs = await db.designation.findMany({ where: { vendorId } })
  const desigById = new Map(desigs.map((d) => [d.id, d.name]))
  const depts = await db.department.findMany({ where: { vendorId } })
  const deptById = new Map(depts.map((d) => [d.id, d.name]))
  const branches = await db.branch.findMany({ where: { vendorId } })
  const branchById = new Map(branches.map((b) => [b.id, b.name]))

  const rows: ExportRow[] = []
  const skipped: { employeeId: string; reason: string }[] = []
  // RPT-12 — one batched payout resolution for the whole run (the old
  // per-entry loop round-tripped per employee on the most-exported file)
  const payoutByEmp = await resolveSalaryPayouts(entries.map((e) => e.employeeId))
  for (const e of entries) {
    const emp = empById.get(e.employeeId)
    if (!emp) continue
    const payout = payoutByEmp.get(emp.id) || { method: null, account: null, note: "Employee not found" }
    const method = payout.method ?? "CASH"
    if (type !== "ALL" && method !== type) continue
    if ((type === "BANK" || type === "MFS") && !payout.account) {
      // an export of bank transfers cannot include an employee with no
      // designated account — skip with a visible reason instead of guessing
      skipped.push({ employeeId: emp.code, reason: payout.note ?? `No ${type} payout account designated` })
      continue
    }
    const bd = j(e.breakdownJson, {} as any)
    const pfDeduction = Number(bd.pf?.employeeAmount) || 0
    rows.push({
      code: emp.code,
      fullName: emp.fullName,
      designation: emp.designationId ? (desigById.get(emp.designationId) ?? "—") : "—",
      department: emp.departmentId ? (deptById.get(emp.departmentId) ?? "—") : "—",
      branch: emp.branchId ? (branchById.get(emp.branchId) ?? "—") : "—",
      gross: round2(e.gross),
      ot: round2(e.otAmount),
      bonus: round2(e.bonus),
      deductions: round2(e.absenceDeduction + e.lateDeduction + e.loanDeduction + e.advanceDeduction + e.otherDeduction + pfDeduction),
      ait: round2(e.ait),
      net: round2(e.net),
      payoutMethod: method,
      bank: payout.account?.bank ?? null,
      bankBranch: payout.account?.branch ?? null,
      accountName: payout.account?.holderName ?? null,
      accountNumber: payout.account?.accountNumber ?? null,
      routingNumber: payout.account?.routingNumber ?? null,
      mfsProvider: payout.account?.mfsProvider ?? null,
      mfsAccountName: payout.account?.holderName ?? null,
      mfsNumber: payout.account?.mfsNumber ?? null,
    })
  }
  // deterministic order for exports
  rows.sort((a, b) => a.code.localeCompare(b.code))
  const totals: ExportTotals = {
    employees: rows.length,
    gross: round2(rows.reduce((s, r) => s + r.gross, 0)),
    ot: round2(rows.reduce((s, r) => s + r.ot, 0)),
    bonus: round2(rows.reduce((s, r) => s + r.bonus, 0)),
    deductions: round2(rows.reduce((s, r) => s + r.deductions, 0)),
    ait: round2(rows.reduce((s, r) => s + r.ait, 0)),
    net: round2(rows.reduce((s, r) => s + r.net, 0)),
  }
  const runLabel = `${run.periodYear}-${String(run.periodMonth).padStart(2, "0")}${run.periodWeek ? ` W${run.periodWeek}` : ""} (${run.runType})`
  return { rows, totals, runLabel, skipped }
}

function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100
}

// ---------- per-type column sets (§49–§52) ----------

export function exportColumns(type: SalaryExportType): { key: keyof ExportRow; label: string }[] {
  const base: { key: keyof ExportRow; label: string }[] = [
    { key: "code", label: "Employee ID" },
    { key: "fullName", label: "Employee Name" },
  ]
  if (type === "BANK") {
    return [
      ...base,
      { key: "bank", label: "Bank" },
      { key: "bankBranch", label: "Bank Branch" },
      { key: "accountName", label: "Account Name" },
      { key: "accountNumber", label: "Account Number" },
      { key: "routingNumber", label: "Routing Number" },
      { key: "net", label: "Net Salary" },
    ]
  }
  if (type === "CASH") {
    // cash disbursement sheet: identity + amount + a blank signature column
    // for physical payment confirmation (§51 — no bank data on this sheet)
    return [
      ...base,
      { key: "branch", label: "Branch" },
      { key: "department", label: "Department" },
      { key: "net", label: "Net Salary" },
      { key: "signatureCol", label: "Payment Confirmation / Signature" },
    ]
  }
  if (type === "MFS") {
    return [
      ...base,
      { key: "mfsProvider", label: "MFS Provider" },
      { key: "mfsAccountName", label: "MFS Account Name" },
      { key: "mfsNumber", label: "MFS Account Number" },
      { key: "net", label: "Net Salary" },
    ]
  }
  return [
    ...base,
    { key: "designation", label: "Designation" },
    { key: "department", label: "Department" },
    { key: "branch", label: "Branch" },
    { key: "gross", label: "Gross Salary" },
    { key: "ot", label: "OT" },
    { key: "bonus", label: "Bonus" },
    { key: "deductions", label: "Deductions" },
    { key: "ait", label: "AIT" },
    { key: "net", label: "Net Salary" },
    { key: "payoutMethod", label: "Payout Method" },
  ]
}

function cellValue(r: ExportRow, key: keyof ExportRow): string | number {
  if (key === "signatureCol") return ""
  return (r as any)[key] ?? ""
}

/** Totals row appended to sheets (§41: every report shows totals).
 *  RPT-02 — the row is built FROM the column map, so it can never drift out
 *  of alignment again: the old hand-counted literals printed BANK's net
 *  total under "Routing Number" (7 items on an 8-column sheet, "Net Salary"
 *  left blank), MFS lost its net the same way (5 on 6), and the ALL sheet
 *  carried 11 items on 12 columns (every sum one column left of its header). */
function totalsRow(type: SalaryExportType, t: ExportTotals): (string | number)[] {
  const cols = exportColumns(type)
  const sums: Partial<Record<keyof ExportRow, number>> = {
    gross: round2(t.gross),
    ot: round2(t.ot),
    bonus: round2(t.bonus),
    deductions: round2(t.deductions),
    ait: round2(t.ait),
    net: round2(t.net),
  }
  return cols.map((c, i) => {
    if (i === 0) return "TOTAL"
    if (c.key in sums) return sums[c.key] as number
    // the full sheet carries the employee count in the name column
    if (type === "ALL" && c.key === "fullName") return `${t.employees} employees`
    return ""
  })
}

// ---------- format renderers ----------

export function renderCsv(type: SalaryExportType, data: SalaryExportResult): string {
  const cols = exportColumns(type)
  const header = cols.map((c) => c.label)
  const body = data.rows.map((r) => cols.map((c) => cellValue(r, c.key)))
  const foot = totalsRow(type, data.totals)
  return csv([header, ...body, foot])
}

export function renderXlsx(type: SalaryExportType, data: SalaryExportResult, runLabel: string): Buffer {
  const cols = exportColumns(type)
  const aoa: (string | number)[][] = [
    [`Salary Export — ${typeTitle(type)} — Run ${runLabel}`],
    cols.map((c) => c.label),
    ...data.rows.map((r) => cols.map((c) => cellValue(r, c.key))),
    totalsRow(type, data.totals),
  ]
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  // sensible column widths
  ws["!cols"] = cols.map((c) => ({ wch: Math.max(12, Math.min(34, c.label.length + 6)) }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, "Salary Export")
  const out = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer
  return out
}

export async function renderPdf(type: SalaryExportType, data: SalaryExportResult, runLabel: string, company: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const cols = exportColumns(type)
  const pageW = 842 // A4 landscape
  const pageH = 595
  const marginX = 32
  const rowH = 16
  const headerH = 58
  const usableW = pageW - marginX * 2
  const colW = usableW / cols.length

  let page = doc.addPage([pageW, pageH])
  let y = pageH
  const drawHeader = () => {
    page.drawText(`${company} — Salary Export`, { x: marginX, y: y - 18, size: 14, font: bold, color: rgb(0.02, 0.35, 0.24) })
    page.drawText(`${typeTitle(type)} · Payroll run ${runLabel} · ${data.totals.employees} employees`, {
      x: marginX, y: y - 34, size: 9, font, color: rgb(0.35, 0.35, 0.35),
    })
    y -= headerH
    // column headers
    cols.forEach((c, i) => {
      page.drawText(fit(c.label, colW - 6, bold, 8), { x: marginX + i * colW + 2, y, size: 8, font: bold })
    })
    y -= 6
    page.drawLine({
      start: { x: marginX, y }, end: { x: pageW - marginX, y }, thickness: 0.7, color: rgb(0.6, 0.6, 0.6),
    })
    y -= rowH
  }
  drawHeader()

  const drawRow = (cells: (string | number)[], isTotal: boolean, size = 8) => {
    if (y < marginX + rowH) {
      page = doc.addPage([pageW, pageH])
      y = pageH
      drawHeader()
    }
    cells.forEach((v, i) => {
      const text = typeof v === "number" ? v.toLocaleString("en-IN") : String(v ?? "")
      page.drawText(fit(text, colW - 6, isTotal ? bold : font, size), {
        x: marginX + i * colW + 2, y, size, font: isTotal ? bold : font,
      })
    })
    y -= rowH
  }

  for (const r of data.rows) {
    drawRow(cols.map((c) => cellValue(r, c.key)), false)
  }
  drawRow(totalsRow(type, data.totals), true)

  // skipped-accounts footnote (bank/MFS exports)
  if (data.skipped.length) {
    y -= 6
    drawRow([`Not included (no designated account): ${data.skipped.map((s) => `${s.employeeId} (${s.reason})`).join(", ")}`], false, 7)
  }
  return doc.save()
}

function typeTitle(t: SalaryExportType): string {
  return t === "ALL" ? "All Employees" : t === "BANK" ? "Bank Transfer" : t === "CASH" ? "Cash Salary" : "MFS Salary"
}

/** Fit text into a pixel width by truncating with an ellipsis. */
function fit(text: string, maxW: number, font: any, size: number): string {
  let t = String(text ?? "")
  if (font.widthOfTextAtSize(t, size) <= maxW) return t
  while (t.length > 1 && font.widthOfTextAtSize(t + "…", size) > maxW) t = t.slice(0, -1)
  return t + "…"
}
