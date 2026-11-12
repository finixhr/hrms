/**
 * HR Reports — business metadata for every report on the unified HR Reports
 * surface. Single source of truth for business-friendly titles/descriptions
 * (no internal report IDs, no "Legacy report —" prefixes), business-domain
 * categories, subscription tier, and the filter vocabulary each report
 * honours (drives the dynamic filter bar + server-side validation).
 *
 * Keys are stable API identifiers (legacy reportRoute keys / structured ids)
 * and never appear in user-facing strings.
 */

export const REPORT_CATEGORIES = [
  "Employees",
  "Workforce",
  "Attendance",
  "Leave",
  "Payroll",
  "Performance",
  "Loans & Advances",
  "Assets",
  "Recruitment",
  "Field Operations",
  "Finance & Accounting",
] as const

export type ReportCategory = (typeof REPORT_CATEGORIES)[number]
export type ReportTier = "core" | "advanced"

export type ReportFilterField =
  | "branchId" | "departmentId" | "employeeId"
  | "employmentType" | "status"
  | "month" | "year" | "from" | "to"
  | "dimension" | "eventType" | "withinDays"
  | "runType" | "cycleId"
  | "divisor" | "eligibleOnly" | "percent" | "basis"

export type ReportMeta = {
  title: string
  description: string
  category: ReportCategory
  tier: ReportTier
  filters: ReportFilterField[]
  /** excluded from the HR Reports catalog (scheduler/AI/templates only) */
  internal?: boolean
}

const FALLBACK: ReportMeta = {
  title: "Custom Report",
  description: "Custom registered report.",
  category: "Workforce",
  tier: "core",
  filters: [],
}

export const REPORT_META: Record<string, ReportMeta> = {
  // --- Employees ---
  employees: { title: "Employee Master List", description: "Complete employee roster with job, organization and status details.", category: "Employees", tier: "core", filters: ["branchId", "departmentId", "employmentType", "status", "employeeId"] },
  employeesBiodata: { title: "Employee Biodata (Confidential)", description: "Full confidential biodata per employee — personal, identity and statutory fields.", category: "Employees", tier: "core", filters: ["branchId", "departmentId", "employmentType", "status", "employeeId"] },
  employeesDirectory: { title: "Employee Directory", description: "Contact directory — names, designations, phones and emails.", category: "Employees", tier: "core", filters: ["branchId", "departmentId", "employmentType", "status"] },
  employeesNewJoiners: { title: "New Joiners", description: "Employees who joined within the selected period.", category: "Employees", tier: "core", filters: ["from", "to", "branchId", "departmentId", "employmentType", "status"] },
  employeesExits: { title: "Employee Exits", description: "Employees who exited, with exit dates and reasons.", category: "Employees", tier: "core", filters: ["from", "to", "branchId", "departmentId"] },
  employeesLifecycle: { title: "Employment Lifecycle Events", description: "Hire, transfer, promotion and exit events by month.", category: "Employees", tier: "core", filters: ["month", "year", "branchId", "departmentId", "eventType"] },
  // --- Attendance ---
  attendance: { title: "Attendance Summary", description: "Daily attendance records with status and worked hours.", category: "Attendance", tier: "core", filters: ["month", "year", "status", "branchId", "departmentId", "employmentType", "employeeId"] },
  attendanceLate: { title: "Late Arrivals", description: "Late check-ins per employee with minutes lost.", category: "Attendance", tier: "core", filters: ["month", "year", "branchId", "departmentId", "employmentType", "status", "employeeId"] },
  attendanceAbsence: { title: "Absence Report", description: "Absent days per employee for the period.", category: "Attendance", tier: "core", filters: ["month", "year", "branchId", "departmentId", "employmentType", "employeeId"] },
  attendanceOvertime: { title: "Overtime Summary", description: "Overtime hours per employee with approval status.", category: "Attendance", tier: "core", filters: ["month", "year", "branchId", "departmentId", "employmentType", "status", "employeeId"] },
  attendanceWorkingHours: { title: "Working Hours", description: "Total worked hours per employee for the period.", category: "Attendance", tier: "core", filters: ["month", "year", "branchId", "departmentId", "employmentType", "status", "employeeId"] },
  attendanceBranch: { title: "Attendance by Branch", description: "Attendance KPIs aggregated per branch.", category: "Attendance", tier: "core", filters: ["month", "year", "branchId", "employmentType", "status"] },
  attendanceDepartment: { title: "Attendance by Department", description: "Attendance KPIs aggregated per department.", category: "Attendance", tier: "core", filters: ["month", "year", "departmentId", "employmentType", "status"] },
  absenteeismTrend: { title: "Absenteeism Trend", description: "Month-over-month absenteeism rate across the workforce.", category: "Attendance", tier: "advanced", filters: ["year", "branchId", "departmentId"] },
  // --- Leave ---
  leave: { title: "Leave Register", description: "All leave applications with type, dates and approval status.", category: "Leave", tier: "core", filters: ["year", "status", "branchId", "departmentId", "employmentType", "employeeId"] },
  leaveBalances: { title: "Leave Balances", description: "Opening, taken and remaining balance per leave type.", category: "Leave", tier: "core", filters: ["year", "branchId", "departmentId", "employmentType", "employeeId"] },
  leaveUtilization: { title: "Leave Utilization", description: "Utilization rate per leave type across the workforce.", category: "Leave", tier: "advanced", filters: ["year", "branchId", "departmentId", "employmentType", "employeeId"] },
  leaveDepartment: { title: "Leave by Department", description: "Leave days aggregated per department.", category: "Leave", tier: "core", filters: ["year", "branchId"] },
  // --- Payroll ---
  payroll: { title: "Payroll Register", description: "Full payroll register per run — earnings, deductions and net pay.", category: "Payroll", tier: "core", filters: ["month", "year", "runType", "branchId", "departmentId", "employmentType", "status", "employeeId"] },
  payrollBranch: { title: "Payroll by Branch", description: "Payroll cost aggregated per branch.", category: "Payroll", tier: "core", filters: ["month", "year", "runType", "branchId", "employmentType", "status"] },
  payrollDepartment: { title: "Payroll by Department", description: "Payroll cost aggregated per department.", category: "Payroll", tier: "core", filters: ["month", "year", "runType", "departmentId", "employmentType", "status"] },
  payrollDeductions: { title: "Payroll Deductions", description: "Deduction breakdown per employee for the period.", category: "Payroll", tier: "core", filters: ["month", "year", "branchId", "departmentId", "employmentType"] },
  otCost: { title: "Overtime Cost", description: "Monetary overtime cost per employee and month.", category: "Payroll", tier: "advanced", filters: ["month", "year", "branchId", "departmentId", "employmentType", "employeeId"] },
  gratuity: { title: "Gratuity Provision", description: "Gratuity provisioning per employee with eligibility.", category: "Payroll", tier: "advanced", filters: ["branchId", "departmentId", "divisor", "eligibleOnly"] },
  festivalBonus: { title: "Festival Bonus Projection", description: "Projected festival bonus per employee.", category: "Payroll", tier: "advanced", filters: ["branchId", "departmentId", "percent", "basis"] },
  payslipDistribution: { title: "Payslip Distribution", description: "Payslip issue and delivery status per employee.", category: "Payroll", tier: "advanced", filters: ["month", "year", "branchId", "departmentId", "employmentType", "status", "employeeId"] },
  // --- Loans & Advances ---
  loans: { title: "Loan Accounts", description: "Employee loans with outstanding balance and installment status.", category: "Loans & Advances", tier: "core", filters: ["status", "branchId", "departmentId", "employeeId"] },
  advances: { title: "Employee Advances", description: "Salary advances with recovery status.", category: "Loans & Advances", tier: "core", filters: ["status", "branchId", "departmentId", "employeeId"] },
  // --- Finance & Accounting ---
  expenses: { title: "Expense Claims", description: "Expense claims with approval and payment status.", category: "Finance & Accounting", tier: "core", filters: ["status", "branchId", "departmentId", "employmentType", "employeeId"] },
  reimbursements: { title: "Reimbursements", description: "Reimbursed claims per employee.", category: "Finance & Accounting", tier: "core", filters: ["branchId", "departmentId", "employmentType"] },
  // --- Performance ---
  performance: { title: "Performance Review Summary", description: "Review outcomes per employee for a cycle.", category: "Performance", tier: "core", filters: ["cycleId", "branchId", "departmentId", "employmentType"] },
  performanceKpi: { title: "KPI Scorecard", description: "KPI scores per employee.", category: "Performance", tier: "core", filters: ["branchId", "departmentId", "employmentType"] },
  performanceTrend: { title: "Performance Trend", description: "Rating movement across review cycles.", category: "Performance", tier: "advanced", filters: ["branchId", "departmentId", "employmentType"] },
  // --- Workforce ---
  headcount: { title: "Headcount Distribution", description: "Headcount grouped by branch, department, status or employment type.", category: "Workforce", tier: "core", filters: ["dimension", "branchId", "departmentId", "employmentType", "status"] },
  demographics: { title: "Workforce Demographics", description: "Gender, blood group, marital status and religion mix.", category: "Workforce", tier: "advanced", filters: ["dimension", "branchId", "departmentId", "employmentType"] },
  salaryBands: { title: "Salary Bands", description: "Employee distribution across gross salary bands.", category: "Workforce", tier: "advanced", filters: ["branchId", "departmentId"] },
  probationExpiry: { title: "Probation Expiry Watchlist", description: "Employees whose probation expires within N days.", category: "Workforce", tier: "core", filters: ["withinDays", "branchId", "departmentId"] },
  birthdays: { title: "Upcoming Birthdays", description: "Birthdays and work anniversaries for the period.", category: "Workforce", tier: "core", filters: ["month", "year", "branchId", "departmentId"] },
  headcountMovement: { title: "Headcount Movement", description: "Monthly joiners, exits and net movement for the year.", category: "Workforce", tier: "advanced", filters: ["year", "branchId", "departmentId"] },
  attritionRate: { title: "Attrition Rate", description: "Monthly annualized attrition rate.", category: "Workforce", tier: "advanced", filters: ["year", "branchId", "departmentId"] },
  ageBands: { title: "Age Distribution", description: "Employee distribution across age bands.", category: "Workforce", tier: "advanced", filters: ["branchId", "departmentId"] },
  tenureBands: { title: "Tenure Distribution", description: "Employee distribution across tenure bands.", category: "Workforce", tier: "advanced", filters: ["branchId", "departmentId"] },
  holidayCalendar: { title: "Holiday Calendar", description: "Statutory and company holidays for the year.", category: "Workforce", tier: "core", filters: ["year"] },
  diversityOverTime: { title: "Diversity Trend", description: "Gender diversity mix across the year.", category: "Workforce", tier: "advanced", filters: ["year", "branchId", "departmentId"] },
  // --- Recruitment / Field / Assets ---
  recruitmentFunnel: { title: "Recruitment Funnel", description: "Candidates through each pipeline stage.", category: "Recruitment", tier: "core", filters: [] },
  assetAssignments: { title: "Asset Assignments", description: "Company assets issued, returned and overdue.", category: "Assets", tier: "core", filters: ["status"] },
  fieldforceVisits: { title: "Field Force Visits", description: "Field visits with distance and coverage per employee.", category: "Field Operations", tier: "core", filters: ["month", "year", "branchId", "departmentId", "employeeId"] },
  // --- internal (scheduler/AI only) ---
  paidPeriodRewrites: { title: "Paid Period Corrections", description: "Corrections applied to paid payroll periods (integrity audit).", category: "Payroll", tier: "core", filters: ["from", "to"], internal: true },
  // --- native structured reports ---
  "workforce.headcount": { title: "Headcount by Dimension", description: "Structured headcount analysis with KPIs, charts and comparison.", category: "Workforce", tier: "advanced", filters: ["dimension"] },
  "attendance.overview": { title: "Attendance Overview", description: "Structured attendance overview with KPIs, charts and period comparison.", category: "Attendance", tier: "advanced", filters: ["from", "to"] },
  "workforce.dashboard": { title: "Workforce Dashboard", description: "Whole-workforce dashboard — headcount, movement, payroll cost and leave.", category: "Workforce", tier: "advanced", filters: ["dimension"] },
}

/** Resolve metadata for a report id ("legacy.<key>" adapter ids included). */
export function reportMetaOf(reportId: string): ReportMeta {
  const key = reportId.startsWith("legacy.") ? reportId.slice("legacy.".length) : reportId
  return REPORT_META[key] ?? FALLBACK
}
