import { describe, expect, it } from "bun:test"
import * as XLSX from "xlsx"
import { generatePfOpeningTemplate, parseAndValidatePfRows } from "../../src/hrm-server/pf-import"

describe("PF Bulk Import Engine", () => {
  const mockEmployees = [
    {
      id: "emp-1",
      code: "EMP-001",
      fullName: "Rahim Ahmed",
      departmentName: "Engineering",
      designationName: "Software Engineer",
      basicSalary: 45000,
      grossSalary: 75000,
      enrolledInPf: true,
    },
    {
      id: "emp-2",
      code: "EMP-002",
      fullName: "Karim Uddin",
      departmentName: "Marketing",
      designationName: "Marketing Officer",
      basicSalary: 30000,
      grossSalary: 50000,
      enrolledInPf: false,
    },
    {
      id: "emp-3",
      code: "EMP-003",
      fullName: "Fatema Begum",
      departmentName: "HR",
      designationName: "HR Executive",
      basicSalary: 35000,
      grossSalary: 55000,
      enrolledInPf: true,
    },
  ]

  it("generates an Excel template pre-populated with active employees", () => {
    const buffer = generatePfOpeningTemplate({
      employees: mockEmployees,
      currentYear: 2026,
      currentMonth: 10,
    })

    expect(buffer).toBeDefined()
    expect(buffer.length).toBeGreaterThan(0)

    const wb = XLSX.read(buffer, { type: "buffer" })
    expect(wb.SheetNames).toContain("PF_Opening_Balances")
    expect(wb.SheetNames).toContain("Instructions")

    const ws = wb.Sheets["PF_Opening_Balances"]
    const rows: any[] = XLSX.utils.sheet_to_json(ws)
    expect(rows.length).toBe(3)
    expect(rows[0]["Employee Code"]).toBe("EMP-001")
    expect(rows[0]["Employee Name"]).toBe("Rahim Ahmed")
    expect(rows[0]["Department"]).toBe("Engineering")
    expect(rows[0]["Designation"]).toBe("Software Engineer")
    expect(rows[0]["PF Status"]).toBe("Eligible")
    expect(rows[0]["Monthly Basic (BDT)"]).toBe(45000)
    expect(rows[0]["Year"]).toBe(2026)
    expect(rows[0]["Month"]).toBe(10)
  })

  it("parses and validates input rows, correctly marking READY, SKIPPED, and ERROR", () => {
    const rawRows = [
      {
        "Employee Code": "EMP-001",
        "Employee Name": "Rahim Ahmed",
        "Employee Contribution (BDT)": 4500,
        "Employer Contribution (BDT)": 4500,
        "Source (OPENING / MANUAL)": "OPENING",
        "Year": 2026,
        "Month": 9,
        "Note": "Initial balance",
      },
      {
        "Employee Code": "EMP-002",
        "Employee Name": "Karim Uddin",
        "Employee Contribution (BDT)": 3000,
        "Employer Contribution (BDT)": 3000,
        "Source (OPENING / MANUAL)": "OPENING",
        "Year": 2026,
        "Month": 9,
      },
      {
        // Zero amount should be SKIPPED cleanly
        "Employee Code": "EMP-003",
        "Employee Name": "Fatema Begum",
        "Employee Contribution (BDT)": 0,
        "Employer Contribution (BDT)": 0,
      },
      {
        // Non-existent code should be ERROR
        "Employee Code": "EMP-999",
        "Employee Name": "Unknown Guy",
        "Employee Contribution (BDT)": 1000,
        "Employer Contribution (BDT)": 1000,
      },
    ]

    const result = parseAndValidatePfRows(rawRows, mockEmployees)

    expect(result.totalRows).toBe(4)
    expect(result.validCount).toBe(2)
    expect(result.skippedCount).toBe(1)
    expect(result.errorCount).toBe(1)
    expect(result.totalEmployeeAmount).toBe(7500)
    expect(result.totalEmployerAmount).toBe(7500)
    expect(result.totalCombined).toBe(15000)

    expect(result.items[0].status).toBe("READY")
    expect(result.items[1].status).toBe("READY")
    expect(result.items[1].alreadyEnrolled).toBe(false) // Needs auto-enrollment
    expect(result.items[2].status).toBe("SKIPPED")
    expect(result.items[3].status).toBe("ERROR")
    expect(result.items[3].error).toContain("EMP-999")
  })
})
