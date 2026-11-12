// ============ PF Opening / Historical Contribution Excel Import Engine ============
import * as XLSX from "xlsx"
import crypto from "crypto"

/**
 * MON-3 (Phase 1) — the dedupe key component for PfContribution rows.
 * PfContribution previously had NO uniqueness: a retried import or double
 * upload duplicated every row, and because exit settlement PF payout sums ALL
 * contribution rows, duplicates converted directly into overpayment at the
 * employee's exit. The new unique key is
 *   (vendorId, employeeId, periodYear, periodMonth, source, noteHash)
 * where noteHash = sha256(note) — with the creating run folded in for
 * PAYROLL rows so the multiple weekly runs of one month (each legitimately
 * writing its own PAYROLL row) never collide on the identical note text.
 * Mirrored bit-for-bit by the backfill in the 9_wave9zc migration.
 */
export function pfNoteHash(note: string | null | undefined, source: string, runId?: string | null): string {
  const basis = source === "PAYROLL"
    ? `${note || ""}|run:${runId || ""}`
    : `${note || ""}`
  return crypto.createHash("sha256").update(basis, "utf8").digest("hex")
}

export interface PfImportRowItem {
  rowNo: number
  employeeId?: string
  employeeCode: string
  employeeName: string
  department?: string
  designation?: string
  employeeAmount: number
  employerAmount: number
  totalAmount: number
  year: number
  month: number
  source: "OPENING" | "MANUAL" | "WITHDRAWAL"
  note: string
  status: "READY" | "SKIPPED" | "ERROR"
  error?: string
  alreadyEnrolled?: boolean
}

export interface PfImportPreviewResult {
  totalRows: number
  validCount: number
  skippedCount: number
  errorCount: number
  totalEmployeeAmount: number
  totalEmployerAmount: number
  totalCombined: number
  items: PfImportRowItem[]
  errors: string[]
}

/**
 * Generate a pre-filled Excel template (.xlsx) containing all active employees
 * so the administrator can easily input previously deducted PF / opening balances.
 */
export function generatePfOpeningTemplate(data: {
  employees: {
    id: string
    code: string
    fullName: string
    departmentName?: string | null
    designationName?: string | null
    basicSalary?: number | null
    grossSalary?: number | null
    pfStatus?: string
  }[]
  currentYear?: number
  currentMonth?: number
}): Buffer {
  const wb = XLSX.utils.book_new()
  const year = data.currentYear || new Date().getFullYear()
  const month = data.currentMonth || new Date().getMonth() + 1

  const rows = (data.employees || []).map((emp) => ({
    "Employee Code": emp.code,
    "Employee Name": emp.fullName,
    "Department": emp.departmentName || "—",
    "Designation": emp.designationName || "—",
    "PF Status": emp.pfStatus || "Eligible",
    "Monthly Basic (BDT)": emp.basicSalary ? Math.round(emp.basicSalary) : 0,
    "Employee Contribution (BDT)": 0,
    "Employer Contribution (BDT)": 0,
    "Source (OPENING / MANUAL)": "OPENING",
    "Year": year,
    "Month": month,
    "Note": "Opening balance carried from previous system",
  }))

  const ws = XLSX.utils.json_to_sheet(rows)
  ws["!cols"] = [
    { wch: 16 }, // Employee Code
    { wch: 28 }, // Employee Name
    { wch: 22 }, // Department
    { wch: 22 }, // Designation
    { wch: 18 }, // PF Status
    { wch: 20 }, // Monthly Basic
    { wch: 26 }, // Employee Contribution
    { wch: 26 }, // Employer Contribution
    { wch: 26 }, // Source
    { wch: 10 }, // Year
    { wch: 10 }, // Month
    { wch: 45 }, // Note
  ]

  XLSX.utils.book_append_sheet(wb, ws, "PF_Opening_Balances")

  // Add a helpful Instructions sheet
  const instructionRows = [
    { "Step": "1", "Instruction": "This template is pre-populated with your PF-eligible active employees." },
    { "Step": "2", "Instruction": "Enter the previously deducted PF amount in 'Employee Contribution (BDT)'." },
    { "Step": "3", "Instruction": "Enter the matching employer amount in 'Employer Contribution (BDT)'." },
    { "Step": "4", "Instruction": "Employees with 0 or blank contributions will be cleanly skipped during import." },
    { "Step": "5", "Instruction": "Source can be 'OPENING' (for carried forward balances) or 'MANUAL'." },
    { "Step": "6", "Instruction": "Save the file and upload it in HRM -> Payroll & Finance -> Provident Fund -> Bulk Import." },
    { "Step": "7", "Instruction": "You will get a live verification preview to verify all totals before final recording." },
  ]
  const wsInst = XLSX.utils.json_to_sheet(instructionRows)
  wsInst["!cols"] = [{ wch: 10 }, { wch: 80 }]
  XLSX.utils.book_append_sheet(wb, wsInst, "Instructions")

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" })
}

/**
 * Normalizes loose column header names to standard keys.
 */
function findVal(row: Record<string, any>, candidates: string[]): any {
  for (const c of candidates) {
    if (row[c] !== undefined && row[c] !== null && row[c] !== "") return row[c]
  }
  // Try case-insensitive lookup
  const lowerCandidates = candidates.map((c) => c.toLowerCase().trim())
  for (const [k, v] of Object.entries(row)) {
    const lk = k.toLowerCase().trim()
    if (lowerCandidates.includes(lk) && v !== undefined && v !== null && v !== "") return v
  }
  return undefined
}

/**
 * Parse and validate uploaded rows against existing employee records.
 */
export function parseAndValidatePfRows(
  rawRows: any[],
  employees: {
    id: string
    code: string
    fullName: string
    departmentName?: string | null
    designationName?: string | null
    enrolledInPf?: boolean
  }[]
): PfImportPreviewResult {
  const empByCode = new Map<string, typeof employees[0]>()
  for (const e of employees) {
    empByCode.set(e.code.toLowerCase().trim(), e)
  }

  const items: PfImportRowItem[] = []
  const globalErrors: string[] = []

  let validCount = 0
  let skippedCount = 0
  let errorCount = 0
  let totalEmployeeAmount = 0
  let totalEmployerAmount = 0

  rawRows.forEach((row, idx) => {
    const rowNo = idx + 2 // 1-indexed, +1 for header

    const rawCode = findVal(row, [
      "Employee Code", "employeeCode", "code", "EMP CODE", "Employee ID", "Employee Id", "Emp ID", "Emp Code",
    ])
    const rawName = findVal(row, [
      "Employee Name", "employeeName", "name", "Full Name", "Employee",
    ])
    const rawEmpAmount = findVal(row, [
      "Employee Contribution (BDT)", "Employee Contribution (৳)", "Employee Contribution", "Employee Amount (BDT)",
      "Employee Amount (৳)", "Employee Amount", "employeeAmount", "Employee Share", "Employee",
    ])
    const rawMgrAmount = findVal(row, [
      "Employer Contribution (BDT)", "Employer Contribution (৳)", "Employer Contribution", "Employer Amount (BDT)",
      "Employer Amount (৳)", "Employer Amount", "employerAmount", "Employer Share", "Employer",
    ])
    const rawSource = findVal(row, ["Source (OPENING / MANUAL)", "Source", "source"])
    const rawYear = findVal(row, ["Year", "year", "Period Year", "periodYear"])
    const rawMonth = findVal(row, ["Month", "month", "Period Month", "periodMonth"])
    const rawNote = findVal(row, ["Note", "note", "Remarks", "remark"])

    const employeeCode = String(rawCode || "").trim()
    const employeeName = String(rawName || "").trim()

    // Skip completely empty spacer rows
    if (!employeeCode && !employeeName && rawEmpAmount === undefined && rawMgrAmount === undefined) {
      return
    }

    const matchedEmp = employeeCode ? empByCode.get(employeeCode.toLowerCase()) : undefined
    const empAmount = Number(rawEmpAmount) || 0
    const mgrAmount = Number(rawMgrAmount) || 0
    const totalAmount = empAmount + mgrAmount

    const parsedYear = Number(rawYear) || new Date().getFullYear()
    const parsedMonth = Number(rawMonth) || (new Date().getMonth() + 1)
    const normalizedSource = String(rawSource || "OPENING").toUpperCase().trim()
    const validSource: "OPENING" | "MANUAL" | "WITHDRAWAL" = ["OPENING", "MANUAL", "WITHDRAWAL"].includes(normalizedSource)
      ? (normalizedSource as any)
      : "OPENING"

    const note = String(rawNote || "Opening balance carried from previous system").slice(0, 300)

    // Validation checks
    let status: "READY" | "SKIPPED" | "ERROR" = "READY"
    let errorMsg: string | undefined

    if (!employeeCode) {
      status = "ERROR"
      errorMsg = "Missing Employee Code"
    } else if (!matchedEmp) {
      status = "ERROR"
      errorMsg = `Employee Code "${employeeCode}" not found in current organization records`
    } else if (isNaN(empAmount) || isNaN(mgrAmount) || empAmount < 0 || mgrAmount < 0) {
      status = "ERROR"
      errorMsg = "Contribution amounts cannot be negative or invalid numbers"
    } else if (parsedYear < 2000 || parsedYear > 2100) {
      status = "ERROR"
      errorMsg = `Invalid year ${parsedYear} (must be between 2000 and 2100)`
    } else if (parsedMonth < 1 || parsedMonth > 12) {
      status = "ERROR"
      errorMsg = `Invalid month ${parsedMonth} (must be between 1 and 12)`
    } else if (empAmount === 0 && mgrAmount === 0) {
      // 0 or blank amount is cleanly marked SKIPPED so user can keep pre-filled rows they don't want to import
      status = "SKIPPED"
      errorMsg = "Both Employee and Employer amounts are zero — row will be skipped"
    }

    if (status === "READY") {
      validCount++
      totalEmployeeAmount += empAmount
      totalEmployerAmount += mgrAmount
    } else if (status === "SKIPPED") {
      skippedCount++
    } else {
      errorCount++
      if (errorMsg) globalErrors.push(`Row ${rowNo} (${employeeCode || "Unknown"}): ${errorMsg}`)
    }

    items.push({
      rowNo,
      employeeId: matchedEmp?.id,
      employeeCode: matchedEmp?.code || employeeCode,
      employeeName: matchedEmp?.fullName || employeeName || "—",
      department: matchedEmp?.departmentName || "—",
      designation: matchedEmp?.designationName || "—",
      employeeAmount: empAmount,
      employerAmount: mgrAmount,
      totalAmount,
      year: parsedYear,
      month: parsedMonth,
      source: validSource,
      note,
      status,
      error: errorMsg,
      alreadyEnrolled: matchedEmp?.enrolledInPf ?? false,
    })
  })

  return {
    totalRows: items.length,
    validCount,
    skippedCount,
    errorCount,
    totalEmployeeAmount,
    totalEmployerAmount,
    totalCombined: totalEmployeeAmount + totalEmployerAmount,
    items,
    errors: globalErrors,
  }
}
