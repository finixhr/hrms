// ============ Excel Template Generator & Bulk Threshold Import Parser ============
import * as XLSX from "xlsx"

export interface ThresholdRowParseResult {
  rowNo: number
  targetType: "TOTAL" | "BRANCH" | "DEPARTMENT" | "EMPLOYEE"
  targetIdentifier: string // Code or Name
  targetName: string
  resolvedTargetId: string | null
  thresholdAmount: number
  valid: boolean
  error?: string
}

/**
 * Generates an Excel workbook with instructions, metadata reference sheets (Branches, Departments, Employees),
 * and the Threshold Import template worksheet with sample data.
 */
export function generateCommissionThresholdTemplate(data: {
  ruleName: string
  branches: { code?: string | null; name: string; id: string }[]
  departments: { code?: string | null; name: string; id: string }[]
  employees: { code?: string | null; fullName: string; id: string }[]
}): Buffer {
  const wb = XLSX.utils.book_new()

  // 1. Template Sheet with Total, Branches, Departments, and all eligible Employees
  // The "Approved Threshold Amount (BDT)" column is blank so administrators can enter amounts
  const templateRows: any[] = []

  // Row for TOTAL
  templateRows.push({
    "Target Type (TOTAL / BRANCH / DEPARTMENT / EMPLOYEE)": "TOTAL",
    "Identifier (Code or Name, leave blank for TOTAL)": "",
    "Approved Threshold Amount (BDT)": "",
  })

  // Rows for Branches
  for (const b of data.branches) {
    templateRows.push({
      "Target Type (TOTAL / BRANCH / DEPARTMENT / EMPLOYEE)": "BRANCH",
      "Identifier (Code or Name, leave blank for TOTAL)": b.name || b.code || "",
      "Approved Threshold Amount (BDT)": "",
    })
  }

  // Rows for Departments
  for (const d of data.departments) {
    templateRows.push({
      "Target Type (TOTAL / BRANCH / DEPARTMENT / EMPLOYEE)": "DEPARTMENT",
      "Identifier (Code or Name, leave blank for TOTAL)": d.name || d.code || "",
      "Approved Threshold Amount (BDT)": "",
    })
  }

  // Rows for Employees (only eligible employees)
  for (const e of data.employees) {
    templateRows.push({
      "Target Type (TOTAL / BRANCH / DEPARTMENT / EMPLOYEE)": "EMPLOYEE",
      "Identifier (Code or Name, leave blank for TOTAL)": e.code || e.fullName || "",
      "Approved Threshold Amount (BDT)": "",
    })
  }

  const wsTemplate = XLSX.utils.json_to_sheet(templateRows)
  wsTemplate["!cols"] = [{ wch: 45 }, { wch: 40 }, { wch: 30 }]
  XLSX.utils.book_append_sheet(wb, wsTemplate, "Thresholds")

  // 2. Reference: Branches
  const branchRows = data.branches.map((b) => ({
    "Branch Code": b.code || "—",
    "Branch Name": b.name,
    "System ID": b.id,
  }))
  const wsBranches = XLSX.utils.json_to_sheet(branchRows)
  wsBranches["!cols"] = [{ wch: 20 }, { wch: 35 }, { wch: 30 }]
  XLSX.utils.book_append_sheet(wb, wsBranches, "Branches")

  // 3. Reference: Departments
  const deptRows = data.departments.map((d) => ({
    "Department Code": d.code || "—",
    "Department Name": d.name,
    "System ID": d.id,
  }))
  const wsDepts = XLSX.utils.json_to_sheet(deptRows)
  wsDepts["!cols"] = [{ wch: 20 }, { wch: 35 }, { wch: 30 }]
  XLSX.utils.book_append_sheet(wb, wsDepts, "Departments")

  // 4. Reference: Employees
  const empRows = data.employees.map((e) => ({
    "Employee Code": e.code || "—",
    "Employee Name": e.fullName,
    "System ID": e.id,
  }))
  const wsEmps = XLSX.utils.json_to_sheet(empRows)
  wsEmps["!cols"] = [{ wch: 20 }, { wch: 35 }, { wch: 30 }]
  XLSX.utils.book_append_sheet(wb, wsEmps, "Employees")

  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" })
  return buf
}

/**
 * Parse and validate uploaded Excel file or JSON rows against authorized organizational entities.
 * Validates references, duplicates, invalid amounts, conflicting thresholds, and missing fields.
 */
export function parseAndValidateThresholdRows(
  rawRows: any[],
  entities: {
    branches: { id: string; name: string; code?: string | null }[]
    departments: { id: string; name: string; code?: string | null }[]
    employees: { id: string; fullName: string; code?: string | null }[]
  }
): {
  totalRows: number
  validRows: number
  invalidRows: number
  errors: string[]
  preview: ThresholdRowParseResult[]
  parsedRows: ThresholdRowParseResult[]
} {
  const branchMap = new Map<string, string>()
  entities.branches.forEach((b) => {
    branchMap.set(b.id.toLowerCase(), b.id)
    branchMap.set(b.name.trim().toLowerCase(), b.id)
    if (b.code) branchMap.set(b.code.trim().toLowerCase(), b.id)
  })

  const deptMap = new Map<string, string>()
  entities.departments.forEach((d) => {
    deptMap.set(d.id.toLowerCase(), d.id)
    deptMap.set(d.name.trim().toLowerCase(), d.id)
    if (d.code) deptMap.set(d.code.trim().toLowerCase(), d.id)
  })

  const empMap = new Map<string, { id: string; name: string }>()
  entities.employees.forEach((e) => {
    empMap.set(e.id.toLowerCase(), { id: e.id, name: e.fullName })
    empMap.set(e.fullName.trim().toLowerCase(), { id: e.id, name: e.fullName })
    if (e.code) empMap.set(e.code.trim().toLowerCase(), { id: e.id, name: e.fullName })
  })

  const parsedRows: ThresholdRowParseResult[] = []
  const seenKeys = new Set<string>()

  let validCount = 0
  let invalidCount = 0

  for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i]
    const rowNo = row.rowNo || i + 2

    // Read keys flexibly across column headers
    const rawTargetType = String(
      row["Target Type (TOTAL / BRANCH / DEPARTMENT / EMPLOYEE)"] ||
      row["Target Type"] ||
      row.targetType ||
      row.TargetType ||
      row.type ||
      ""
    ).trim().toUpperCase()

    const rawIdentifier = String(
      row["Identifier (Code or Name, leave blank for TOTAL)"] ||
      row["Target Identifier"] ||
      row.targetIdentifier ||
      row.targetId ||
      row.identifier ||
      row.name ||
      ""
    ).trim()

    const rawAmount =
      row["Approved Threshold Amount (BDT)"] !== undefined
        ? row["Approved Threshold Amount (BDT)"]
        : row["Threshold Amount (BDT)"] !== undefined
        ? row["Threshold Amount (BDT)"]
        : row["Threshold Amount"] !== undefined
        ? row["Threshold Amount"]
        : row.thresholdAmount !== undefined
        ? row.thresholdAmount
        : row.amount

    // If the threshold amount is blank / empty string, skip this row so unconfigured template entries
    // do not trigger errors or zero-amount thresholds. Explicit 0 values ("0" or 0) are still kept.
    if (rawAmount === undefined || rawAmount === null || String(rawAmount).trim() === "") {
      continue
    }

    const amount = Number(rawAmount)

    let error: string | undefined
    let targetType: "TOTAL" | "BRANCH" | "DEPARTMENT" | "EMPLOYEE" = "TOTAL"
    let resolvedId: string | null = null
    let targetName = ""

    if (!["TOTAL", "BRANCH", "DEPARTMENT", "EMPLOYEE"].includes(rawTargetType)) {
      error = `Invalid Target Type "${rawTargetType}". Must be TOTAL, BRANCH, DEPARTMENT, or EMPLOYEE.`
    } else {
      targetType = rawTargetType as any
    }

    if (!error) {
      if (isNaN(amount) || amount < 0) {
        error = `Invalid threshold amount "${rawAmount}". Must be a non-negative number.`
      }
    }

    if (!error) {
      if (targetType === "TOTAL") {
        resolvedId = null
        targetName = "Total Organization Target"
      } else if (targetType === "BRANCH") {
        if (!rawIdentifier) {
          error = "Branch name or code is required for BRANCH target type."
        } else {
          const matchId = branchMap.get(rawIdentifier.toLowerCase())
          if (!matchId) {
            error = `Unknown Branch identifier "${rawIdentifier}".`
          } else {
            resolvedId = matchId
            const b = entities.branches.find((x) => x.id === matchId)
            targetName = b?.name || rawIdentifier
          }
        }
      } else if (targetType === "DEPARTMENT") {
        if (!rawIdentifier) {
          error = "Department name or code is required for DEPARTMENT target type."
        } else {
          const matchId = deptMap.get(rawIdentifier.toLowerCase())
          if (!matchId) {
            error = `Unknown Department identifier "${rawIdentifier}".`
          } else {
            resolvedId = matchId
            const d = entities.departments.find((x) => x.id === matchId)
            targetName = d?.name || rawIdentifier
          }
        }
      } else if (targetType === "EMPLOYEE") {
        if (!rawIdentifier) {
          error = "Employee code or name is required for EMPLOYEE target type."
        } else {
          const match = empMap.get(rawIdentifier.toLowerCase())
          if (!match) {
            error = `Unknown Employee identifier "${rawIdentifier}".`
          } else {
            resolvedId = match.id
            targetName = match.name
          }
        }
      }
    }

    // Check duplicate key
    const dedupeKey = `${targetType}:${resolvedId || "ALL"}`
    if (!error && seenKeys.has(dedupeKey)) {
      error = `Duplicate threshold entry for ${targetType} (${rawIdentifier || "TOTAL"}) in this file.`
    } else if (!error) {
      seenKeys.add(dedupeKey)
    }

    const isValid = !error
    if (isValid) validCount++
    else invalidCount++

    parsedRows.push({
      rowNo,
      targetType,
      targetIdentifier: rawIdentifier,
      targetName,
      resolvedTargetId: resolvedId,
      thresholdAmount: isNaN(amount) ? 0 : amount,
      valid: isValid,
      error,
    })
  }

  const errors: string[] = []
  for (const r of parsedRows) {
    if (r.error) errors.push(r.error)
  }

  return {
    totalRows: rawRows.length,
    validRows: validCount,
    invalidRows: invalidCount,
    errors,
    preview: parsedRows,
    parsedRows,
  }
}
