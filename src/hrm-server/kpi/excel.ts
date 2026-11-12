// ============ KPI Excel import/export engine (2026-11 redesign) ============
// Dynamic, data-driven workbooks — never static files with hardcoded indicator
// columns. Target + Achievement templates are generated from the selected
// company/department template and the employees' APPROVED assignments, and the
// uploaded files are re-validated server-side at submit time (the preview is
// never trusted as authorization to write).
import * as XLSX from "xlsx"
import { formatPeriodLabel } from "./scoring"
import type { KpiDirection, KpiUnit } from "./constants"

// ---------------------------------------------------------------------------
// Shared preview/execute contract (same shape as the PF/commission imports)
// ---------------------------------------------------------------------------

export type ImportRowStatus = "READY" | "ERROR" | "SKIPPED"

export type TargetImportRow = {
  rowNo: number
  status: ImportRowStatus
  error?: string
  employeeCode: string
  employeeName: string
  departmentName: string
  designationName: string
  values: Record<string, number | null> // indicatorId → target value
  remarks?: string
}

export type AchievementImportRow = {
  rowNo: number
  status: ImportRowStatus
  error?: string
  employeeCode: string
  employeeName: string
  periodLabel: string
  indicatorRowId: string
  indicatorName: string
  unit: string
  direction: string
  // nullable: the reference row may carry no stored target AND the uploaded
  // cell may be blank/non-numeric — consumers (preview, journal, exports)
  // already treat null as "no target recorded"
  targetValue: number | null
  actualValue: number | null
  remarks?: string
}

export type ImportSummary = {
  total: number
  valid: number
  invalid: number
  skipped: number
  duplicates: number
  existing: number
}

export function summarize(rows: { status: ImportRowStatus; error?: string }[]): ImportSummary {
  const s: ImportSummary = { total: rows.length, valid: 0, invalid: 0, skipped: 0, duplicates: 0, existing: 0 }
  for (const r of rows) {
    if (r.status === "READY") s.valid++
    else if (r.status === "ERROR") s.invalid++
    else {
      s.skipped++
      if (r.error?.includes("Duplicate")) s.duplicates++
      if (r.error?.includes("already")) s.existing++
    }
  }
  return s
}

// ---------------------------------------------------------------------------
// Reference data shapes (filled by the routes, pure functions here)
// ---------------------------------------------------------------------------

export type TargetTemplateEmployee = {
  code: string
  fullName: string
  departmentName: string
  designationName: string
}

export type TargetIndicatorRef = {
  id: string
  name: string
  unit: KpiUnit
  unitLabel: string | null
  direction: KpiDirection
  weight: number
  defaultTarget: number | null
  builtinKey: string | null
}

const HEADER_EMPLOYEE_ID = "Employee ID"
const HEADER_EMPLOYEE_NAME = "Employee Name"
const HEADER_DEPARTMENT = "Department"
const HEADER_DESIGNATION = "Designation"
const HEADER_PERIOD = "Period"
const HEADER_INDICATOR = "Indicator"
const HEADER_INDICATOR_ID = "Indicator ID"
const HEADER_UNIT = "Unit"
const HEADER_DIRECTION = "Direction"
const HEADER_TARGET = "Target"
const HEADER_ACTUAL = "Actual Achievement"
const HEADER_REMARKS = "Remarks"

const directionLabel = (d: string) =>
  d === "LOWER_IS_BETTER" ? "Lower is better" : d === "EXACT_TARGET" ? "Exact target" : "Higher is better"

const unitLabel = (u: string, label: string | null) => (u === "PERCENT" ? "%" : u === "CUSTOM" ? label || "" : u === "HOURS" ? "hours" : u === "DAYS" ? "days" : u === "CURRENCY" ? "BDT" : u === "BOOLEAN" ? "0/1" : "")

// ---------------------------------------------------------------------------
// TARGET template generation
// ---------------------------------------------------------------------------

export function generateTargetTemplate(opts: {
  companyName: string
  departmentName: string
  periodLabel: string
  periodStart?: string | null
  periodEnd?: string | null
  dueDate?: string | null
  templateName: string
  indicators: TargetIndicatorRef[]
  employees: TargetTemplateEmployee[]
}): Buffer {
  const indHeaders = opts.indicators.map((i) => `${i.name}${unitLabel(i.unit, i.unitLabel) ? ` (${unitLabel(i.unit, i.unitLabel)})` : ""}`)
  const header = [HEADER_EMPLOYEE_ID, HEADER_EMPLOYEE_NAME, HEADER_DEPARTMENT, HEADER_DESIGNATION, ...indHeaders, HEADER_REMARKS]
  const rows: (string | number | null)[][] = opts.employees.map((e) => [
    e.code,
    e.fullName,
    e.departmentName,
    e.designationName,
    ...opts.indicators.map((i) => i.defaultTarget ?? null),
    "",
  ])
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows])
  ws["!cols"] = [
    { wch: 14 }, { wch: 26 }, { wch: 20 }, { wch: 22 },
    ...opts.indicators.map(() => ({ wch: 16 })),
    { wch: 28 },
  ]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, "KPI Targets")

  // (string | number)[][]: the indicator table mixes text columns with the
  // numeric weight and the default target
  const instructions: (string | number)[][] = [
    ["KPI Target Assignment — bulk upload template"],
    [],
    ["Company", opts.companyName],
    ["Department", opts.departmentName],
    ["KPI Template", opts.templateName],
    ["Period", `${formatPeriodLabel(opts.periodLabel, opts.periodStart, opts.periodEnd)} (${opts.periodLabel})`],
    ["Due Date", opts.dueDate || "—"],
    ["Employees included", String(opts.employees.length)],
    [],
    ["HOW TO FILL"],
    [`1. Do NOT modify the "${HEADER_EMPLOYEE_ID}", "${HEADER_EMPLOYEE_NAME}", "${HEADER_DEPARTMENT}" or "${HEADER_DESIGNATION}" columns — the Employee ID is the authoritative identifier.`],
    ["2. Enter a target value for EVERY indicator on EVERY employee row. Blank or non-numeric cells are reported as errors."],
    ["3. Indicator weights must total 100% (already validated on the template). Per-employee target overrides are allowed and expected."],
    ["4. Upload the completed file in the wizard — you will see a validation preview before anything is saved."],
    ["5. All created targets enter PENDING APPROVAL. Nothing is applied without approval."],
    [],
    ["INDICATORS"],
    ["Name", "Type", "Unit", "Direction", "Weight %", "Default target"],
    ...opts.indicators.map((i) => [
      i.name,
      i.builtinKey ? "System built-in" : "Custom",
      unitLabel(i.unit, i.unitLabel) || i.unit,
      directionLabel(i.direction),
      i.weight,
      i.defaultTarget ?? "—",
    ]),
  ]
  const wsInstr = XLSX.utils.aoa_to_sheet(instructions)
  wsInstr["!cols"] = [{ wch: 34 }, { wch: 18 }, { wch: 14 }, { wch: 18 }, { wch: 10 }, { wch: 16 }]
  XLSX.utils.book_append_sheet(wb, wsInstr, "Instructions")
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer
}

// ---------------------------------------------------------------------------
// TARGET parse + validate
// ---------------------------------------------------------------------------

const parseNumber = (v: unknown): number | null => {
  if (v == null || v === "") return null
  if (typeof v === "number") return Number.isFinite(v) ? v : null
  const s = String(v).trim().replace(/,/g, "")
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

const headerVal = (row: Record<string, unknown>, candidates: string[]): unknown => {
  for (const key of Object.keys(row)) {
    if (candidates.some((c) => key.trim().toLowerCase() === c.toLowerCase())) return row[key]
  }
  return undefined
}

export type ParsedTargetUpload = {
  rows: TargetImportRow[]
  summary: ImportSummary
  missingHeaders: string[]
}

/** Validate a target upload against the reference data. Employee identity is
 * resolved ONLY by the stable employee code — names/departments in the file
 * are advisory and never trusted. */
export function parseTargetUpload(
  wb: XLSX.WorkBook,
  ref: {
    indicators: TargetIndicatorRef[]
    eligibleByCode: Map<string, TargetTemplateEmployee & { departmentName: string }>
    existingEmployeeIdsByCode: Map<string, string> // code → employeeId already assigned for this period
  },
): ParsedTargetUpload {
  const sheetName = wb.SheetNames.includes("KPI Targets") ? "KPI Targets" : wb.SheetNames[0]
  if (!sheetName) return { rows: [], summary: summarize([]), missingHeaders: [HEADER_EMPLOYEE_ID] }
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[sheetName], { defval: null, raw: true })
  // map file columns → indicator ids by header text
  const sheetHeaders = raw.length ? Object.keys(raw[0]) : []
  const missing: string[] = []
  if (!sheetHeaders.some((h) => h.trim().toLowerCase() === HEADER_EMPLOYEE_ID.toLowerCase())) missing.push(HEADER_EMPLOYEE_ID)
  const indByHeader = new Map<string, TargetIndicatorRef>()
  for (const ind of ref.indicators) {
    const base = ind.name.trim().toLowerCase()
    const match = sheetHeaders.find((h) => {
      const hl = h.trim().toLowerCase()
      return hl === base || hl.startsWith(base + " (") || hl.startsWith(base + "(")
    })
    if (match) indByHeader.set(match, ind)
    else missing.push(ind.name)
  }
  const seen = new Set<string>()
  const rows: TargetImportRow[] = []
  raw.forEach((r, idx) => {
    const rowNo = idx + 2 // +1 header, +1 1-based
    const code = String(headerVal(r, [HEADER_EMPLOYEE_ID]) ?? "").trim()
    const emp = code ? ref.eligibleByCode.get(code) : undefined
    const base = {
      rowNo,
      employeeCode: code,
      employeeName: String(headerVal(r, [HEADER_EMPLOYEE_NAME]) ?? emp?.fullName ?? ""),
      departmentName: String(headerVal(r, [HEADER_DEPARTMENT]) ?? emp?.departmentName ?? ""),
      designationName: String(headerVal(r, [HEADER_DESIGNATION]) ?? emp?.designationName ?? ""),
      remarks: headerVal(r, [HEADER_REMARKS]) != null ? String(headerVal(r, [HEADER_REMARKS])).slice(0, 500) : undefined,
      values: {},
    }
    if (!code) {
      rows.push({ ...base, status: "ERROR", error: "Missing Employee ID" })
      return
    }
    if (!emp) {
      rows.push({ ...base, status: "ERROR", error: "Unknown employee code (not in the selected company/department, outside your scope, or inactive)" })
      return
    }
    if (seen.has(code)) {
      rows.push({ ...base, status: "SKIPPED", error: `Duplicate row for employee ${code} — only the first occurrence is imported` })
      return
    }
    seen.add(code)
    if (ref.existingEmployeeIdsByCode.has(code)) {
      rows.push({ ...base, status: "SKIPPED", error: "Employee already has a KPI target for this period" })
      return
    }
    const values: Record<string, number | null> = {}
    const problems: string[] = []
    for (const [header, ind] of indByHeader) {
      const v = parseNumber(r[header])
      if (v == null) problems.push(`${ind.name}: missing/invalid target value`)
      else if (v < 0) problems.push(`${ind.name}: target cannot be negative`)
      else values[ind.id] = v
    }
    if (!Object.keys(values).length && !problems.length) problems.push("No indicator values found on this row")
    if (problems.length) {
      rows.push({ ...base, status: "ERROR", error: problems.join("; ") })
      return
    }
    rows.push({ ...base, status: "READY", values })
  })
  return { rows, summary: summarize(rows), missingHeaders: missing }
}

// ---------------------------------------------------------------------------
// ACHIEVEMENT template generation
// ---------------------------------------------------------------------------

export type AchievementTemplateRow = {
  code: string
  fullName: string
  departmentName: string
  periodLabel: string
  indicatorRowId: string
  indicatorName: string
  unit: KpiUnit
  unitLabel: string | null
  direction: KpiDirection
  weight: number
  targetValue: number | null
  /** pre-computed built-in value (admin may override) */
  prefillActual: number | null
  builtinKey: string | null
}

export function generateAchievementTemplate(opts: {
  companyName: string
  departmentName: string
  periodLabel: string
  rows: AchievementTemplateRow[]
}): Buffer {
  const header = [HEADER_EMPLOYEE_ID, HEADER_EMPLOYEE_NAME, HEADER_DEPARTMENT, HEADER_PERIOD, HEADER_INDICATOR, HEADER_INDICATOR_ID, HEADER_UNIT, HEADER_DIRECTION, HEADER_TARGET, HEADER_ACTUAL, HEADER_REMARKS]
  const data = opts.rows.map((r) => [
    r.code,
    r.fullName,
    r.departmentName,
    r.periodLabel,
    r.indicatorName,
    r.indicatorRowId,
    unitLabel(r.unit, r.unitLabel) || r.unit,
    directionLabel(r.direction),
    r.targetValue ?? "",
    r.prefillActual ?? "",
    "",
  ])
  const ws = XLSX.utils.aoa_to_sheet([header, ...data])
  ws["!cols"] = [{ wch: 14 }, { wch: 26 }, { wch: 20 }, { wch: 12 }, { wch: 30 }, { wch: 28 }, { wch: 10 }, { wch: 16 }, { wch: 12 }, { wch: 18 }, { wch: 28 }]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, "KPI Achievements")
  const instructions: string[][] = [
    ["KPI Achievement — bulk upload template"],
    [],
    ["Company", opts.companyName],
    ["Department", opts.departmentName],
    ["Period", `${formatPeriodLabel(opts.periodLabel)} (${opts.periodLabel})`],
    ["Rows", String(opts.rows.length)],
    [],
    ["HOW TO FILL"],
    [`1. Rows are generated from APPROVED KPI target assignments — every (employee, indicator) pair already has a target.`],
    [`2. Do NOT modify "${HEADER_EMPLOYEE_ID}" or "${HEADER_INDICATOR_ID}" — together they are the authoritative identifier.`],
    ["3. System built-in indicators (attendance, leave, etc.) are computed automatically from system data and excluded from this manual template."],
    ["4. Enter the Actual Achievement for every remaining row. Blank values are reported as errors."],
    ["5. All uploaded achievement records enter PENDING APPROVAL — nothing is auto-approved."],
    ["6. Indicators that already have submitted or approved achievements are skipped (edit those individually instead)."],
  ]
  const wsInstr = XLSX.utils.aoa_to_sheet(instructions)
  wsInstr["!cols"] = [{ wch: 96 }]
  XLSX.utils.book_append_sheet(wb, wsInstr, "Instructions")
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer
}

// ---------------------------------------------------------------------------
// ACHIEVEMENT parse + validate
// ---------------------------------------------------------------------------

export type AchievementRefRow = {
  code: string
  indicatorRowId: string
  assignmentId: string
  employeeId: string
  periodLabel: string
  indicatorName: string
  unit: KpiUnit
  unitLabel: string | null
  direction: KpiDirection
  weight: number
  targetValue: number | null
  existingStatus: string | null // PENDING_APPROVAL / APPROVED / ... when the indicator already has a live row
}

export function parseAchievementUpload(
  wb: XLSX.WorkBook,
  ref: Map<string, AchievementRefRow>, // key `${code}|${indicatorRowId}`
): { rows: AchievementImportRow[]; summary: ImportSummary; missingHeaders: string[] } {
  const sheetName = wb.SheetNames.includes("KPI Achievements") ? "KPI Achievements" : wb.SheetNames[0]
  if (!sheetName) return { rows: [], summary: summarize([]), missingHeaders: [HEADER_EMPLOYEE_ID] }
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[sheetName], { defval: null, raw: true })
  const missing: string[] = []
  const sheetHeaders = raw.length ? Object.keys(raw[0]) : []
  if (!sheetHeaders.some((h) => h.trim().toLowerCase() === HEADER_EMPLOYEE_ID.toLowerCase())) missing.push(HEADER_EMPLOYEE_ID)
  if (!sheetHeaders.some((h) => h.trim().toLowerCase() === HEADER_INDICATOR_ID.toLowerCase())) missing.push(HEADER_INDICATOR_ID)
  const seen = new Set<string>()
  const rows: AchievementImportRow[] = []
  raw.forEach((r, idx) => {
    const rowNo = idx + 2
    const code = String(headerVal(r, [HEADER_EMPLOYEE_ID]) ?? "").trim()
    const indicatorRowId = String(headerVal(r, [HEADER_INDICATOR_ID]) ?? "").trim()
    const refRow = code && indicatorRowId ? ref.get(`${code}|${indicatorRowId}`) : undefined
    const base = {
      rowNo,
      employeeCode: code,
      employeeName: String(headerVal(r, [HEADER_EMPLOYEE_NAME]) ?? ""),
      periodLabel: String(headerVal(r, [HEADER_PERIOD]) ?? refRow?.periodLabel ?? ""),
      indicatorRowId,
      indicatorName: refRow?.indicatorName || String(headerVal(r, [HEADER_INDICATOR]) ?? ""),
      unit: refRow?.unit || String(headerVal(r, [HEADER_UNIT]) ?? ""),
      direction: refRow?.direction || "",
      targetValue: refRow?.targetValue ?? parseNumber(headerVal(r, [HEADER_TARGET])),
      actualValue: parseNumber(headerVal(r, [HEADER_ACTUAL])),
      remarks: headerVal(r, [HEADER_REMARKS]) != null ? String(headerVal(r, [HEADER_REMARKS])).slice(0, 500) : undefined,
    }
    if (!code || !indicatorRowId) {
      rows.push({ ...base, status: "ERROR", error: "Missing Employee ID or Indicator ID" })
      return
    }
    if (!refRow) {
      rows.push({ ...base, status: "ERROR", error: "Unknown employee/indicator pair — no approved KPI target assignment matches" })
      return
    }
    const key = `${code}|${indicatorRowId}`
    if (seen.has(key)) {
      rows.push({ ...base, status: "SKIPPED", error: "Duplicate row for the same employee + indicator — only the first occurrence is imported" })
      return
    }
    seen.add(key)
    if (refRow.existingStatus === "APPROVED") {
      rows.push({ ...base, status: "SKIPPED", error: "Achievement already approved — edit it individually to create a revision" })
      return
    }
    if (refRow.existingStatus === "PENDING_APPROVAL" || refRow.existingStatus === "DRAFT") {
      rows.push({ ...base, status: "SKIPPED", error: "Achievement already submitted — edit it individually instead" })
      return
    }
    if (base.actualValue == null) {
      rows.push({ ...base, status: "ERROR", error: "Missing Actual Achievement value" })
      return
    }
    if (base.actualValue < 0) {
      rows.push({ ...base, status: "ERROR", error: "Actual Achievement cannot be negative" })
      return
    }
    if (refRow.unit === "BOOLEAN" && ![0, 1].includes(base.actualValue)) {
      rows.push({ ...base, status: "ERROR", error: "Boolean indicators accept only 0 or 1" })
      return
    }
    rows.push({ ...base, status: "READY" })
  })
  return { rows, summary: summarize(rows), missingHeaders: missing }
}

// ---------------------------------------------------------------------------
// Error report (CSV) + list exports
// ---------------------------------------------------------------------------

export function errorReportCsv(rows: { rowNo: number; status: string; employeeCode?: string; error?: string }[]): string {
  const esc = (v: unknown) => {
    const s = String(v ?? "")
    return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  }
  const lines = ["\uFEFFRow,Status,Employee ID,Error"]
  for (const r of rows) {
    lines.push([r.rowNo, r.status, r.employeeCode || "", r.error || ""].map((c) => `"${esc(c).replace(/"/g, '""')}"`).join(","))
  }
  return lines.join("\n")
}

/** Filtered target-assignment export (Excel). */
export function generateTargetsExport(rows: Record<string, any>[], indicatorsByName: string[]): Buffer {
  const header = ["Employee ID", "Employee", "Department", "Designation", "Period", "Due Date", "Status", "Score", "Rating", ...indicatorsByName, "Approver", "Creator", "Remarks"]
  const data = rows.map((r) => [
    r.employeeCode, r.employeeName, r.departmentName, r.designationName, r.periodLabel,
    r.dueDate || "", r.status, r.totalScore ?? "", r.ratingLabel || "",
    ...indicatorsByName.map((n) => r.indicatorSummary?.[n] ?? ""),
    r.decidedByName || "", r.createdByName || "", r.remarks || "",
  ])
  const ws = XLSX.utils.aoa_to_sheet([header, ...data])
  ws["!cols"] = header.map((h, i) => ({ wch: i === 0 ? 14 : Math.min(28, Math.max(12, String(h).length + 6)) }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, "KPI Targets")
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer
}

/** Filtered achievement export (Excel). */
export function generateAchievementsExport(rows: Record<string, any>[]): Buffer {
  const header = ["Employee ID", "Employee", "Department", "Period", "Indicator", "Unit", "Direction", "Weight %", "Target", "Actual", "Achievement %", "Score", "Status", "Remarks"]
  const data = rows.map((r) => [
    r.employeeCode, r.employeeName, r.departmentName, r.periodLabel, r.indicatorName,
    r.unitLabel || r.unit, directionLabel(r.direction), r.weight, r.targetValue ?? "",
    r.actualValue ?? "", r.achievementPct ?? "", r.score ?? "", r.status, r.remarks || "",
  ])
  const ws = XLSX.utils.aoa_to_sheet([header, ...data])
  ws["!cols"] = header.map((h, i) => ({ wch: i === 1 ? 26 : Math.min(24, Math.max(10, String(h).length + 6)) }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, "KPI Achievements")
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer
}

export function readWorkbook(base64: string): XLSX.WorkBook {
  const buf = Buffer.from(base64, "base64")
  return XLSX.read(buf, { type: "buffer" })
}
