"use client"
// ============ HR Reports engine — Wave 3 WP-E (2026-10-08) ============
// Left report list + filter bar + generic DataTable driven by the
// server-computed { columns, rows, meta } report envelope.
//
// Wave 3 overhaul:
//   - EXPLICIT generation: nothing auto-fetches — pick filters, press
//     "View / Generate"; last-used filters are cached per report key.
//   - Charts ONLY where meaningful (REPORTS[].charts): recharts toggle
//     (pie/donut/bar/line as flagged), derived client-side from the rendered
//     rows — switching chart type never refetches.
//   - "Export as" split-button: .xlsx (SheetJS, client-side, Bengali/৳-safe)
//     and .csv (the existing server CSV path, UTF-8 BOM).
//   - Print = IN-APP modal (ReportPrintModal) — Modern ERP SaaS layout with
//     company header + dotted separators + the three-part footer
//     (Print Date & Time · Powered by Finix HR · Page X of Y). The
//     openPrintWindow new-tab path is GONE.
<<<<<<< HEAD
import { useEffect, useMemo, useState } from "react"
=======
import { useEffect, useMemo, useRef, useState } from "react"
>>>>>>> origin/main
import {
  FileBarChart, Users, CalendarCheck, Plane, Wallet, Landmark, Receipt, TrendingUp,
  Filter, Check, ChevronsUpDown, Search, ShieldCheck, PlayCircle, Boxes, MapPin, Cake, ArrowLeftRight, PieChart, Hourglass,
  Save, Plus, Trash2, Pencil, Mail, CalendarClock, Gift, Download,
  HeartPulse, Timer, CalendarOff, Banknote, CalendarDays, Scale,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useHrm } from "../store"
import { useApi, rpc, useLookup } from "../api"
import { PageHeader, SectionCard, fmtMoney, titleCase, RowIconButton, LoadingRows, EmptyState, FieldError, fmtDateTime } from "../shared/ui-kit"
import { ConfirmDialog } from "../shared/form-dialog"
import { DataTable, type Column } from "../shared/data-table"
import {
  ExportAsMenu, ReportChart, ReportPrintModal,
  type ChartType, type PrintChartSpec, type PrintPayload, type ReportCompany,
} from "../shared/report-print"
import dynamic from "next/dynamic"

// 2026-10 round §39–§41 — chart-heavy overview (recharts stays lazy like analytics-charts)
const AttendanceOverviewReport = dynamic(() => import("./report-attendance-overview"), {
  loading: () => <div className="h-64 rounded-xl bg-slate-100 dark:bg-slate-800 animate-pulse" />,
})

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

type ReportDef = {
  key: string
  label: string
  icon: any
  hint: string
  needsMonth?: boolean
  needsYear?: boolean
  statuses?: string[]
  /** Wave 3 — chart types offered for this report (absent = no chart UI at all) */
  charts?: ChartType[]
  /** Wave 3 — extra dimension selector (headcount/demographics) */
  dimension?: { options: { value: string; label: string }[] }
  /** Wave 3 — probationExpiry horizon (days) */
  needsWithinDays?: boolean
  group?: string
  /** RPT-002 (Wave R3-3) — mirrors the server's isPiiReportKey(): bulk-PII
   *  reports get the typed-confirmation CSV dialog and the reports.pii-gated
   *  XLSX button. Keep in sync with reportRoute(…, { pii: true }) in
   *  src/hrm-server/routes/reports.ts. */
  pii?: boolean
}

const REPORTS: ReportDef[] = [
  // §17.1 Employee reports
  { key: "employees", label: "Employee Register", icon: Users, hint: "Directory with branch, department, designation, status", group: "Employees", statuses: ["ACTIVE", "PROBATION", "ON_LEAVE", "RESIGNED", "TERMINATED", "RETIRED", "INACTIVE"] },
  { key: "employeesBiodata", label: "Employee Biodata", icon: Users, hint: "Full 360° biodata: parents, DOB, blood, contact, address (PII — typed confirmation on export)", group: "Employees", pii: true },
  { key: "employeesDirectory", label: "Contact Directory", icon: Users, hint: "Compact contact directory with phone and email", group: "Employees" },
  { key: "employeesNewJoiners", label: "New Joiners", icon: Users, hint: "Employees joined in the selected period", group: "Employees" },
  { key: "employeesExits", label: "Exits", icon: Users, hint: "Resigned / terminated / retired employees with exit detail", group: "Employees" },
  { key: "employeesLifecycle", label: "Lifecycle History", icon: Users, hint: "Promotions, transfers, salary revisions, status changes", group: "Employees" },
  // Wave 3 — workforce analytics
  { key: "headcount", label: "Headcount", icon: PieChart, hint: "Employees grouped by branch, department, status or employment type", group: "Workforce", charts: ["pie", "donut", "bar"], dimension: { options: [{ value: "branch", label: "By branch" }, { value: "department", label: "By department" }, { value: "status", label: "By status" }, { value: "employmentType", label: "By employment type" }] } },
  { key: "demographics", label: "Demographics", icon: Users, hint: "Gender, blood group, marital status and religion split", group: "Workforce", charts: ["pie", "donut", "bar"], dimension: { options: [{ value: "gender", label: "By gender" }, { value: "bloodGroup", label: "By blood group" }, { value: "maritalStatus", label: "By marital status" }, { value: "religion", label: "By religion" }] } },
  { key: "salaryBands", label: "Salary Bands", icon: Wallet, hint: "Current basic-salary distribution across bands", group: "Workforce", charts: ["pie", "donut", "bar"] },
  { key: "headcountMovement", label: "Headcount Movement", icon: ArrowLeftRight, hint: "Joiners vs exits per month for the year", group: "Workforce", needsYear: true, charts: ["bar", "line"] },
  // ---- RPT-23 — the eight enterprise-standard reports (audit Phase R4) ----
  { key: "attritionRate", label: "Attrition Rate", icon: TrendingUp, hint: "Annualized attrition rate per month — exits × 12 ÷ month-end headcount", group: "Workforce", needsYear: true, charts: ["bar", "line"] },
  { key: "ageBands", label: "Age Bands", icon: HeartPulse, hint: "Workforce age distribution across standard bands", group: "Workforce", charts: ["pie", "donut", "bar"] },
  { key: "tenureBands", label: "Tenure Bands", icon: Timer, hint: "Service-length distribution across standard bands", group: "Workforce", charts: ["pie", "donut", "bar"] },
  { key: "diversityOverTime", label: "Diversity Over Time", icon: Scale, hint: "Gender mix by joining cohort year — hiring-diversity view", group: "Workforce", charts: ["bar"] },
  { key: "absenteeismTrend", label: "Absenteeism Trend", icon: CalendarOff, hint: "Absent employee-days and absenteeism rate per month", group: "Attendance", needsYear: true, charts: ["bar", "line"] },
  { key: "otCost", label: "OT Cost (৳)", icon: Banknote, hint: "Estimated overtime cost per employee — tier-aware, basic ÷ 208h basis", group: "Payroll", needsMonth: true, charts: ["bar"] },
  { key: "payslipDistribution", label: "Payslip Distribution Audit", icon: ShieldCheck, hint: "Consolidated run audit: totals, payout-method splits, payslip-number integrity", group: "Payroll", needsMonth: true },
  { key: "holidayCalendar", label: "Holiday Calendar", icon: CalendarDays, hint: "The year's holidays with type and branch scope — ICS export included", group: "Workforce", needsYear: true },
  { key: "birthdays", label: "Birthdays & Anniversaries", icon: Cake, hint: "Birthdays and work anniversaries in the selected month", group: "Workforce", needsMonth: true },
  { key: "probationExpiry", label: "Probation & Contract Expiry", icon: Hourglass, hint: "Probation confirmations and contract end dates within the horizon", group: "Workforce", needsWithinDays: true },
  // §17.2 Attendance reports
  { key: "attendance", label: "Attendance", icon: CalendarCheck, hint: "Daily attendance records with working minutes & OT", group: "Attendance", needsMonth: true, statuses: ["PRESENT", "ABSENT", "LATE", "EARLY_LEAVE", "HALF_DAY", "LEAVE", "HOLIDAY", "WEEKLY_OFF", "WFH", "BUSINESS_TRIP"] },
  // 2026-10 round §39–§41 — KPI cards + charts overview (special renderer)
  { key: "attendanceOverview", label: "Attendance Overview", icon: TrendingUp, hint: "KPIs, trends, method mix, GPS & geo-fence compliance and suspicious events", group: "Attendance" },
  { key: "attendanceLate", label: "Late Arrivals", icon: CalendarCheck, hint: "Late instances with minutes lost", group: "Attendance", needsMonth: true },
  { key: "attendanceAbsence", label: "Absence", icon: CalendarCheck, hint: "Absent days per employee", group: "Attendance", needsMonth: true, charts: ["bar"] },
  { key: "attendanceOvertime", label: "Overtime", icon: CalendarCheck, hint: "OT hours per employee for the month", group: "Attendance", needsMonth: true, charts: ["bar"] },
  { key: "attendanceWorkingHours", label: "Working Hours", icon: CalendarCheck, hint: "Total and average working hours per employee", group: "Attendance", needsMonth: true, charts: ["bar"] },
  { key: "attendanceBranch", label: "Branch Attendance", icon: CalendarCheck, hint: "Attendance rate by branch", group: "Attendance", needsMonth: true, charts: ["bar"] },
  { key: "attendanceDepartment", label: "Department Attendance", icon: CalendarCheck, hint: "Attendance rate by department", group: "Attendance", needsMonth: true, charts: ["bar"] },
  // §17.3 Leave reports
  { key: "leave", label: "Leave Register", icon: Plane, hint: "Leave requests with type, days, substitute and status", group: "Leave", statuses: ["PENDING", "APPROVED", "REJECTED", "CANCELLED"] },
  { key: "leaveBalances", label: "Leave Balances", icon: Plane, hint: "Remaining / entitled balance per employee and type", group: "Leave", needsYear: true },
  { key: "leaveUtilization", label: "Leave Utilization", icon: Plane, hint: "Used vs entitled by leave type", group: "Leave", needsYear: true, charts: ["bar"] },
  { key: "leaveDepartment", label: "Department Leave", icon: Plane, hint: "Leave consumption by department", group: "Leave", needsYear: true },
  // §17.4 Payroll & financial HR reports
  { key: "payroll", label: "Payroll Register", icon: Wallet, hint: "Payroll entries: gross, OT, bonus, deductions, AIT, net", group: "Payroll", needsMonth: true },
  { key: "payrollBranch", label: "Branch Payroll", icon: Wallet, hint: "Net payroll by branch for the month", group: "Payroll", needsMonth: true, charts: ["pie", "donut", "bar"] },
  { key: "payrollDepartment", label: "Department Payroll", icon: Wallet, hint: "Net payroll by department for the month", group: "Payroll", needsMonth: true, charts: ["bar"] },
  { key: "payrollDeductions", label: "Deductions", icon: Wallet, hint: "Absence, late, loan, advance, AIT deductions per employee", group: "Payroll", needsMonth: true, charts: ["bar"] },
  // ---- Wave 4 BD compliance — advisory projections (no payroll mutation) ----
  { key: "gratuity", label: "Gratuity Provision (BLA)", icon: Landmark, hint: "Bangladesh Labour Act gratuity projection — 30 days' basic per completed year for 5y+ employees (divisor 30, eligible only)", group: "Payroll" },
  { key: "festivalBonus", label: "Festival Bonus Preview", icon: Gift, hint: "Festival bonus preview — 100% of current basic for active headcount; actual payment runs through the payroll bonus engine", group: "Payroll" },
  { key: "loans", label: "Loans", icon: Landmark, hint: "Loans with principal, installments, paid & outstanding", group: "Financial HR", statuses: ["PENDING", "APPROVED", "ACTIVE", "CLOSED", "REJECTED"] },
  { key: "advances", label: "Advances", icon: Landmark, hint: "Advances with recovery progress and outstanding", group: "Financial HR", statuses: ["PENDING", "APPROVED", "RECOVERING", "REJECTED"] },
  { key: "expenses", label: "Expenses", icon: Receipt, hint: "Expense claims with reimbursement status", group: "Financial HR", statuses: ["PENDING", "APPROVED", "REIMBURSED", "REJECTED"] },
  { key: "reimbursements", label: "Reimbursements", icon: Receipt, hint: "Reimbursed claims with dates and totals", group: "Financial HR" },
  // §17.5 Performance reports
  { key: "performance", label: "Performance Reviews", icon: TrendingUp, hint: "Performance reviews with overall ratings", group: "Performance" },
  { key: "performanceKpi", label: "KPI Achievement", icon: TrendingUp, hint: "KPI achievement % per employee", group: "Performance", charts: ["bar"] },
  { key: "performanceTrend", label: "Performance Trend", icon: TrendingUp, hint: "Average rating per review cycle", group: "Performance", charts: ["line", "bar"] },
  // Wave 3 — recruitment / assets / field force
  { key: "recruitmentFunnel", label: "Recruitment Funnel", icon: PieChart, hint: "Openings and application pipeline by stage", group: "Recruitment & Field Ops", charts: ["pie", "donut", "bar"] },
  { key: "assetAssignments", label: "Asset Assignments", icon: Boxes, hint: "Employee asset assignment register with issue/return status", group: "Recruitment & Field Ops", statuses: ["Issued", "Returned", "Overdue"] },
  { key: "fieldforceVisits", label: "Field-Force Visits", icon: MapPin, hint: "Visit counts, completion and average duration per employee (month)", group: "Recruitment & Field Ops", needsMonth: true, charts: ["bar"] },
]

const NUMERIC_RE = /^[-৳\s]*[\d,]+(\.\d+)?%?$/

const FILTER_CACHE_PREFIX = "finix-rpt-filter-"

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Wave 4 — reports that can be pinned into a template. attendanceOverview is
 *  excluded: it is a special KPI/chart renderer, not the plain { columns, rows }
 *  envelope the scheduler emails. */
const TEMPLATE_REPORTS = REPORTS.filter((r) => r.key !== "attendanceOverview")

type TemplateRecipient = { email: string; name?: string }
type ReportTemplate = {
  id: string; name: string; reportKey: string; filters: Record<string, unknown>
  format: string; schedule: string; recipients: TemplateRecipient[]
  lastRunAt: string | null; lastStatus: string | null; active: boolean
  createdByName?: string | null; createdAt: string
}
type DeliveryLog = {
  id: string; templateId: string; templateName: string; reportKey: string
  format: string; status: string; detail?: string | null
  recipientCount: number; rows?: number | null; startedAt: string
}

const SCHEDULE_BADGE: Record<string, { label: string; cls: string }> = {
  OFF: { label: "Manual", cls: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400" },
  DAILY: { label: "Daily", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" },
  WEEKLY: { label: "Weekly", cls: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300" },
  MONTHLY: { label: "Monthly", cls: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300" },
}

const STATUS_CHIP: Record<string, string> = {
  SENT: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  FAILED: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  SKIPPED: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
}

const ScheduleBadge = ({ schedule }: { schedule: string }) => {
  const b = SCHEDULE_BADGE[schedule] || SCHEDULE_BADGE.OFF
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${b.cls}`}>{b.label}</span>
}

const StatusChip = ({ status }: { status: string }) => (
  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_CHIP[status] || STATUS_CHIP.SKIPPED}`}>{status}</span>
)

/** "month: 10 · branchId: xyz" — readable summary of a stored filter object. */
function summarizeFilters(filters: Record<string, unknown> | null | undefined): string {
  const bits = Object.entries(filters || {}).filter(([, v]) => v !== "" && v != null).map(([k, v]) => `${k}: ${String(v)}`)
  return bits.length ? bits.join(" · ") : "No filters (whole company scope)"
}

export default function ReportsView() {
  const { can, toast } = useHrm()
  const view = useHrm((s) => s.view)
  const allowed = can("reports", "view")
  const canExport = can("reports", "export")
  const canSchedule = can("reports", "schedule")
  // RPT-002 — bulk-PII export gate (mirrors the server's reports.pii route
  // gate on the CSV twin). Without it the client-side .xlsx path exported
  // biodata with nothing but a view audit trail.
  const canPii = can("reports", "pii")
  // typed-confirmation state for PII-class CSV exports (HIGH-11 client half —
  // previously the server required payload.confirm === "EXPORT" but no UI
  // ever sent it, so biodata CSV export 400'd for legit holders)
  const [piiConfirm, setPiiConfirm] = useState<{ open: boolean; typed: string }>({ open: false, typed: "" })

  const now = new Date()
  const presetReport = (view?.params as any)?.report as string | undefined
  const [reportKey, setReportKey] = useState(presetReport || "employees")

  useEffect(() => {
    const r = (view?.params as any)?.report as string | undefined
    if (r) setReportKey(r)
  }, [view?.params])
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [year, setYear] = useState(now.getFullYear())
  const [status, setStatus] = useState("")
  const [branchId, setBranchId] = useState("")
  const [departmentId, setDepartmentId] = useState("")
  const [employeeId, setEmployeeId] = useState("")
  const [dimension, setDimension] = useState("")
  const [withinDays, setWithinDays] = useState(60)

  // Wave 3 — explicit generation state (no report auto-fetch)
  const [gen, setGen] = useState<{ key: string; data: any } | null>(null)
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)

  // chart type per report (default = first allowed type)
  const [chartType, setChartType] = useState<ChartType | null>(null)
  const [printPayload, setPrintPayload] = useState<PrintPayload | null>(null)

  // ---- Wave 4 — saved templates + scheduled delivery (reports.schedule only) ----
  const templatesApi = useApi<{ templates: ReportTemplate[]; deliveries: DeliveryLog[] }>(
    allowed && canSchedule ? "reports.templates.list" : null, {},
  )
  const templates = templatesApi.data?.templates || []
  const deliveries = templatesApi.data?.deliveries || []
  const [tplDialog, setTplDialog] = useState<{ mode: "new" } | { mode: "edit"; tpl: ReportTemplate } | null>(null)
  const [deleting, setDeleting] = useState<ReportTemplate | null>(null)
  const [runningId, setRunningId] = useState<string | null>(null)

  const runTemplateNow = async (t: ReportTemplate) => {
    setRunningId(t.id)
    try {
      const res = await rpc<{ status: string; detail: string | null; rows: number | null }>("reports.templates.runNow", { id: t.id })
      if (res.status === "SENT") toast(`"${t.name}" emailed — ${res.rows ?? 0} rows`)
      else if (res.status === "SKIPPED") toast(`"${t.name}" skipped — ${res.detail || "no recipients or gateway not configured"}`)
      else toast(`"${t.name}" failed — ${res.detail || "see delivery history"}`, "err")
      templatesApi.reload()
    } catch (e: any) {
      toast(e?.message || "Run failed", "err")
    } finally {
      setRunningId(null)
    }
  }

  const { user } = useHrm()
  void user // reserved: printed-by line in the print payload (kept from the pre-wave-3 shell)
  const { data: branches } = useApi<any[]>(allowed ? "branches.list" : null, {})
  const { data: departments } = useApi<any[]>(allowed ? "departments.list" : null, {})
  const { data: employees } = useLookup<any[]>("employees.list", {}, allowed)
  const { data: settings } = useApi<any>(allowed ? "settings.get" : null)
  const company: ReportCompany = (settings?.general || {}) as ReportCompany

  // registry entries are exhaustive by construction; a stale key falls back to the first report
  const active = REPORTS.find((r) => r.key === reportKey) || REPORTS[0]

  // ---- Wave 3: load cached filters when switching reports; reset generation ----
  useEffect(() => {
    setGen(null); setGenError(null)
    setChartType(active.charts ? active.charts[0] : null)
    try {
      const cached = JSON.parse(localStorage.getItem(FILTER_CACHE_PREFIX + active.key) || "null")
      if (cached) {
        if (Number.isFinite(cached.month)) setMonth(cached.month)
        if (Number.isFinite(cached.year)) setYear(cached.year)
        setStatus(cached.status || "")
        setBranchId(cached.branchId || "")
        setDepartmentId(cached.departmentId || "")
        setEmployeeId(cached.employeeId || "")
        setDimension(cached.dimension || (active.dimension ? active.dimension.options[0].value : ""))
        if (Number.isFinite(cached.withinDays)) setWithinDays(cached.withinDays)
        return
      }
    } catch { /* corrupted cache — fall through to defaults */ }
    setStatus(""); setEmployeeId("")
    setDimension(active.dimension ? active.dimension.options[0].value : "")
  }, [reportKey])

  const payload = useMemo(() => {
    const p: Record<string, unknown> = {}
    if (active.needsMonth) { p.month = month; p.year = year }
    if (active.needsYear && !active.needsMonth) p.year = year
    if (status) p.status = status
    if (branchId) p.branchId = branchId
    if (departmentId) p.departmentId = departmentId
    if (employeeId) p.employeeId = employeeId
    if (active.dimension && dimension) p.dimension = dimension
    if (active.needsWithinDays) p.withinDays = withinDays
    return p
  }, [active, month, year, status, branchId, departmentId, employeeId, dimension, withinDays])

  // ---- Wave 3: explicit View / Generate ----
  const generate = async () => {
    setGenerating(true); setGenError(null)
    try {
      const data = await rpc<any>(`reports.${reportKey}`, payload)
      setGen({ key: reportKey, data })
      try { localStorage.setItem(FILTER_CACHE_PREFIX + active.key, JSON.stringify({ ...payload, month, year, withinDays })) } catch { /* private mode */ }
    } catch (e: any) {
      setGen(null)
      setGenError(e?.message || "Report generation failed")
    } finally { setGenerating(false) }
  }

  const generated = gen && gen.key === reportKey ? gen.data : null
  const columns: string[] = generated?.columns || []
  const rows: any[][] = generated?.rows || []
  const meta = generated?.meta

  // numeric-looking column detection (right-align + emphasis)
  const numericCols = useMemo(() => {
    const idx: Record<number, boolean> = {}
    columns.forEach((_, i) => {
      const vals = rows.map((r) => String(r[i] ?? "")).filter((v) => v !== "" && v !== "—")
      idx[i] = vals.length > 0 && vals.every((v) => NUMERIC_RE.test(v.trim()))
    })
    return idx
  }, [columns, rows])

  const tableColumns: Column<any>[] = useMemo(() => columns.map((c, i) => ({
    key: c,
    label: c,
    align: numericCols[i] ? ("right" as const) : ("left" as const),
    render: (row: any) => {
      const v = row[c]
      if (v == null || v === "") return <span className="text-slate-400">—</span>
      const asStr = String(v)
      if (numericCols[i] && (/^৳/.test(asStr) || /%$/.test(asStr))) return <span className="text-xs font-semibold tabular-nums">{asStr}</span>
      if (numericCols[i]) return <span className="text-xs font-medium tabular-nums">{asStr}</span>
      return <span className="text-xs text-slate-700 dark:text-slate-300">{asStr}</span>
    },
    sortValue: (row: any) => row[c],
  })), [columns, numericCols])

  // map row arrays → objects keyed by column label
  const tableRows = useMemo(() => rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]]))), [rows, columns])

  // ---- Wave 3: chart spec derived client-side from the RENDERED rows ----
  const chartSpec: PrintChartSpec | null = useMemo(() => {
    if (!active.charts || !columns.length || !rows.length) return null
    const labelIdx = columns.findIndex((_, i) => !numericCols[i])
    // numeric series EXCLUDING pure-percentage columns (mixing scales reads badly)
    const numIdxs = columns.map((_, i) => i).filter((i) => {
      if (!numericCols[i]) return false
      const vals = rows.map((r) => String(r[i] ?? "")).filter(Boolean)
      return !(vals.length && vals.every((v) => v.trim().endsWith("%")))
    })
    if (labelIdx < 0 || numIdxs.length === 0) return null
    const parse = (v: unknown) => {
      const n = Number(String(v ?? "").replace(/[^\d.-]/g, ""))
      return Number.isFinite(n) ? n : 0
    }
    const top = rows.slice(0, 14)
    return {
      data: top.map((r) => {
        const point: { label: string; [k: string]: string | number } = { label: String(r[labelIdx] ?? "—") }
        for (const i of numIdxs.slice(0, 4)) point[`s${i}`] = parse(r[i])
        return point
      }),
      series: numIdxs.slice(0, 4).map((i) => ({ key: `s${i}`, name: columns[i] })),
      type: chartType || active.charts[0],
    }
  }, [active, chartType, columns, rows, numericCols])

  if (!allowed) {
    return (
      <div className="rounded-xl border bg-white dark:bg-slate-900 p-8 text-center">
        <ShieldCheck className="h-8 w-8 text-slate-300 mx-auto mb-2" />
        <p className="text-sm font-medium text-slate-600 dark:text-slate-300">You do not have permission to view HR reports.</p>
      </div>
    )
  }

  const filterBits: string[] = []
  if (active.needsMonth) filterBits.push(`${MONTHS[month - 1]} ${year}`)
  if (active.needsYear && !active.needsMonth) filterBits.push(String(year))
  if (status) filterBits.push(`status: ${status.replace(/_/g, " ").toLowerCase()}`)
  if (branchId) filterBits.push(`branch: ${(branches || []).find((b: any) => b.id === branchId)?.name || "—"}`)
  if (departmentId) filterBits.push(`department: ${(departments || []).find((d: any) => d.id === departmentId)?.name || "—"}`)
  if (employeeId) filterBits.push(`employee: ${(employees || []).find((e: any) => e.id === employeeId)?.fullName || "—"}`)
  if (active.dimension && dimension) filterBits.push(`grouped by ${dimension.replace(/([A-Z])/g, " $1").toLowerCase().trim()}`)
  if (active.needsWithinDays) filterBits.push(`next ${withinDays} days`)

  const fileBase = `hr-report-${reportKey}-${active.needsMonth ? `${year}-${String(month).padStart(2, "0")}` : new Date().toISOString().slice(0, 10)}`

  // server CSV export (uses full dataset incl. server-side filters)
  const exportServerCsv = async () => {
    // RPT-002 — PII-class reports go through the typed-confirmation dialog
    // first; the typed "EXPORT" is injected into the payload so the server's
    // HIGH-11 gate (p.confirm === "EXPORT") finally passes from the UI.
    if (active.pii && piiConfirm.typed !== "EXPORT") {
      setPiiConfirm({ open: true, typed: "" })
      return
    }
    try {
      const res = await rpc<{ csv: string }>(`reports.${reportKey}Csv`, active.pii ? { ...payload, confirm: "EXPORT" } : payload)
      const blob = new Blob(["\uFEFF" + res.csv], { type: "text/csv;charset=utf-8" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `${fileBase}.csv`
      a.click()
      URL.revokeObjectURL(url)
      toast(active.pii ? "PII report exported as .csv (audited)" : "Report exported as .csv")
      setPiiConfirm({ open: false, typed: "" })
    } catch (e: any) { toast(e.message || "Export failed", "err") }
  }

  const resetFilters = () => { setStatus(""); setBranchId(""); setDepartmentId(""); setEmployeeId("") }

  // RPT-23 — holiday calendar subscribable ICS download
  const exportIcs = async () => {
    try {
      const res = await rpc<{ ics: string; filename: string }>("reports.holidayCalendarIcs", payload)
      const blob = new Blob([res.ics], { type: "text/calendar;charset=utf-8" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = res.filename || "holidays.ics"
      a.click()
      URL.revokeObjectURL(url)
      toast(`Calendar downloaded — import ${a.download} into Outlook or Google Calendar`)
    } catch (e: any) {
      toast(e?.message || "ICS export failed", "err")
    }
  }

  const openPrint = () => {
    setPrintPayload({
      company,
      title: active.label,
      meta: `${filterBits.length ? filterBits.join(" · ") : "All records"} · ${rows.length} row${rows.length === 1 ? "" : "s"}`,
      columns,
      numericCols,
      rows,
      chart: chartSpec,
    })
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="HR Reports"
        subtitle="Dynamic reports with filters, charts, .xlsx/.csv export and print preview"
        actions={
          <div className="flex flex-wrap gap-1.5 print:hidden">
            {canExport && reportKey !== "attendanceOverview" && (
              <ExportAsMenu
                fileBase={fileBase}
                onCsv={exportServerCsv}
                getXlsxData={() => ({ columns, rows: rows as (string | number | null)[][] })}
                disabled={!generated || (active.pii && !canPii)}
                // RPT-002 — the client-side .xlsx path must respect the same
                // reports.pii gate as the server CSV twin: a user without
                // reports.pii can render biodata on screen (view-gated) but
                // must not be able to export it.
                xlsxHidden={active.pii && !canPii}
              />
            )}
            {reportKey === "holidayCalendar" && (
              <Button size="sm" variant="outline" className="h-8 text-xs bg-white dark:bg-slate-900" onClick={exportIcs} disabled={!generated}>
                <CalendarDays className="mr-1 h-3.5 w-3.5 text-emerald-600" /> .ics
              </Button>
            )}
            {reportKey !== "attendanceOverview" && (
              <Button size="sm" variant="outline" className="h-8 text-xs bg-white dark:bg-slate-900" onClick={openPrint} disabled={!generated}>
                Print
              </Button>
            )}
          </div>
        }
      />

      <div className="grid lg:grid-cols-[240px_1fr] gap-4 items-start">
        {/* ---------- report list sidebar (R4 modern pass) ---------- */}
        <div className="rounded-xl border bg-white dark:bg-slate-900 p-2 print:hidden shadow-sm">
          <div className="flex items-center justify-between px-2 py-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 flex items-center gap-1">
              <FileBarChart className="h-3 w-3" /> Reports
            </p>
            <span className="rounded-full bg-emerald-50 dark:bg-emerald-950 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-700 dark:text-emerald-300">
              {REPORTS.length}
            </span>
          </div>
          <div className="space-y-0.5 max-h-[70vh] overflow-y-auto">
            {[...new Set(REPORTS.map((r) => r.group))].map((grp) => (
              <div key={grp}>
                <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-300 dark:text-slate-600 px-2.5 pt-2 pb-1">{grp}</p>
                {REPORTS.filter((r) => r.group === grp).map((r) => (
                  <button key={r.key} onClick={() => setReportKey(r.key)}
                    className={`group w-full flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-all ${reportKey === r.key
                      ? "bg-gradient-to-r from-emerald-50 to-teal-50/60 dark:from-emerald-950 dark:to-teal-950/60 text-emerald-700 dark:text-emerald-300 shadow-[inset_0_0_0_1px_rgb(16_185_129/0.15)]"
                      : "hover:bg-slate-50 dark:hover:bg-slate-800/70 text-slate-600 dark:text-slate-300"}`}>
                    <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors ${reportKey === r.key
                      ? "bg-emerald-600 text-white shadow-sm shadow-emerald-600/30"
                      : "bg-slate-100 dark:bg-slate-800 text-slate-400 group-hover:text-slate-600 dark:group-hover:text-slate-200"}`}>
                      <r.icon className="h-3.5 w-3.5" />
                    </span>
                    <span className="text-xs font-medium truncate">{r.label}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-4 min-w-0">
          {/* 2026-10 round — Attendance Overview has its own period filter + charts */}
          {reportKey === "attendanceOverview" ? (
            <AttendanceOverviewReport />
          ) : (
          <>
          {/* ---------- filter bar + GENERATE ---------- */}
          <div className="rounded-xl border bg-white dark:bg-slate-900 p-3 print:hidden">
            <div className="flex items-center gap-2 mb-3">
              <Filter className="h-3.5 w-3.5 text-emerald-600" />
              <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">{active.label} — {active.hint}</p>
              <Button size="sm" variant="ghost" className="ml-auto h-7 text-[10px] text-slate-500" onClick={resetFilters}>Reset filters</Button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-2">
              {active.needsMonth && (
                <>
                  <Select value={String(month)} onValueChange={(v) => setMonth(Number(v))}>
                    <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>{MONTHS.map((m, i) => <SelectItem key={m} value={String(i + 1)}>{m}</SelectItem>)}</SelectContent>
                  </Select>
                  <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
                    <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>{Array.from({ length: 9 }, (_, i) => now.getFullYear() + 1 - i).map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}</SelectContent>
                  </Select>
                </>
              )}
              {active.needsYear && !active.needsMonth && (
                <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
                  <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>{Array.from({ length: 9 }, (_, i) => now.getFullYear() + 1 - i).map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}</SelectContent>
                </Select>
              )}
              {active.needsWithinDays && (
                <Select value={String(withinDays)} onValueChange={(v) => setWithinDays(Number(v))}>
                  <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>{[30, 60, 90, 180, 366].map((d) => <SelectItem key={d} value={String(d)}>Next {d} days</SelectItem>)}</SelectContent>
                </Select>
              )}
              {active.dimension && (
                <Select value={dimension || active.dimension.options[0].value} onValueChange={setDimension}>
                  <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>{active.dimension.options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
                </Select>
              )}
              {active.statuses && (
                <Select value={status || "ALL"} onValueChange={(v) => setStatus(v === "ALL" ? "" : v)}>
                  <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="Any status" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">Any status</SelectItem>
                    {active.statuses.map((s) => <SelectItem key={s} value={s}>{titleCase(s)}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}
              <Select value={branchId || "ALL"} onValueChange={(v) => setBranchId(v === "ALL" ? "" : v)}>
                <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="All branches" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All branches</SelectItem>
                  {(branches || []).map((b: any) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={departmentId || "ALL"} onValueChange={(v) => setDepartmentId(v === "ALL" ? "" : v)}>
                <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="All departments" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All departments</SelectItem>
                  {(departments || []).map((d: any) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <EmployeeCombobox employees={employees || []} value={employeeId} onChange={setEmployeeId} />
            </div>
            {/* Wave 3 — the report is EXPLICITLY generated; nothing auto-fetches */}
            <div className="mt-3 flex items-center gap-2">
              <Button size="sm" className="h-9 text-xs bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white shadow-sm shadow-emerald-600/20" onClick={generate} disabled={generating}>
                <PlayCircle className="mr-1 h-4 w-4" /> {generating ? "Generating…" : generated ? "Regenerate" : "View / Generate"}
              </Button>
              {generated && (
                <span className="text-[11px] text-slate-400">
                  {meta?.count != null ? `${meta.count} row${meta.count === 1 ? "" : "s"}` : `${rows.length} row${rows.length === 1 ? "" : "s"}`}
                  {filterBits.length ? ` · ${filterBits.slice(0, 3).join(" · ")}` : ""}
                </span>
              )}
            </div>
          </div>

          {/* ---------- generation error ---------- */}
          {genError && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 dark:bg-rose-950/40 dark:border-rose-900 p-4 text-sm text-rose-700 dark:text-rose-300">
              {genError}
            </div>
          )}

          {/* ---------- charts (flagged reports only) ---------- */}
          {active.charts && chartSpec && chartSpec.data.length > 0 && (
            <SectionCard
              title="Visualization"
              actions={
                <div className="flex items-center gap-1">
                  {active.charts?.map((t) => (
                    <button key={t} onClick={() => setChartType(t)}
                      className={`rounded-md px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide transition-colors ${(chartType || active.charts?.[0]) === t ? "bg-emerald-600 text-white" : "bg-slate-100 dark:bg-slate-800 text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-700"}`}>
                      {t}
                    </button>
                  ))}
                </div>
              }
            >
              <div className="h-[280px]">
                <ReportChart spec={chartSpec} height={280} />
              </div>
              <p className="mt-2 text-[11px] text-slate-400">
                Chart reflects the top {Math.min(14, rows.length)} rendered rows — switch types without regenerating.
              </p>
            </SectionCard>
          )}

          {/* ---------- result meta ---------- */}
          {generated && (
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="text-[10px] bg-white dark:bg-slate-900">
                <FileBarChart className="h-3 w-3 mr-1 text-emerald-600" /> {active.label}
              </Badge>
              {meta?.count != null && <Badge className="bg-emerald-100 text-emerald-700 text-[10px]">{meta.count} row{meta.count === 1 ? "" : "s"}</Badge>}
              {active.needsMonth && <Badge variant="outline" className="text-[10px] bg-white dark:bg-slate-900">{MONTHS[month - 1]} {year}</Badge>}
              {meta?.run?.status && <Badge variant="outline" className="text-[10px] bg-white dark:bg-slate-900">Run: {titleCase(meta.run.status)}{meta.run.totalNet != null ? ` · net ${fmtMoney(meta.run.totalNet)}` : ""}</Badge>}
              {rows.length === 0 && <span className="text-xs text-slate-400">No matching rows — adjust filters{active.needsMonth ? " or the month/year" : ""} and regenerate.</span>}
            </div>
          )}

          {/* ---------- result table ---------- */}
          <DataTable
            columns={tableColumns}
            rows={tableRows}
            loading={generating}
            error={genError}
            pageSize={20}
            searchPlaceholder={`Search ${active.label.toLowerCase()}…`}
            emptyTitle={generated ? "No data for these filters" : "Ready when you are"}
            emptyHint={generated
              ? (active.needsMonth ? "Try another month/year — payroll needs a run for the selected period." : "Loosen the filters and regenerate.")
              : `Set the filters above and press "View / Generate" to produce the ${active.label} report.`}
          />

          {!allowed && (
            <SectionCard title="Permission required"><p className="text-sm text-slate-500">reports.view permission is required.</p></SectionCard>
          )}
          </>
          )}
        </div>
      </div>

      {/* ---------- Wave 4 — saved templates + scheduled delivery (reports.schedule only) ---------- */}
      {canSchedule && (
        <SectionCard
          title={
            <span className="flex items-center gap-1.5">
              <CalendarClock className="h-3.5 w-3.5 text-emerald-600" /> Saved Templates &amp; Scheduled Delivery
            </span>
          }
          actions={
            <Button size="sm" variant="outline" className="h-7 text-xs bg-white dark:bg-slate-900"
              onClick={() => setTplDialog({ mode: "new" })}
              disabled={tplDialog !== null}>
              <Save className="mr-1 h-3.5 w-3.5 text-emerald-600" /> Save current as template
            </Button>
          }
        >
          {templatesApi.loading && !templates.length ? (
            <LoadingRows rows={3} />
          ) : templatesApi.error && !templates.length ? (
            <EmptyState icon={Mail} title="Could not load templates" hint={templatesApi.error} />
          ) : !templates.length ? (
            <EmptyState
              icon={CalendarClock}
              title="No saved templates yet"
              hint="Set the filters above on any report and press “Save current as template” — then run it on demand or email it on a daily/weekly/monthly schedule."
            />
          ) : (
            <>
              <div className="overflow-x-auto -mx-2 px-2">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wide text-slate-400 border-b">
                      <th className="py-2 pr-3 font-semibold">Name</th>
                      <th className="py-2 pr-3 font-semibold">Report</th>
                      <th className="py-2 pr-3 font-semibold">Schedule</th>
                      <th className="py-2 pr-3 font-semibold">Format</th>
                      <th className="py-2 pr-3 font-semibold">Recipients</th>
                      <th className="py-2 pr-3 font-semibold">Last run</th>
                      <th className="py-2 font-semibold text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {templates.map((t) => {
                      const label = REPORTS.find((r) => r.key === t.reportKey)?.label || t.reportKey
                      return (
                        <tr key={t.id} className="border-b border-slate-100 dark:border-slate-800 last:border-0 hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                          <td className="py-2 pr-3 max-w-[180px]">
                            <p className="font-medium text-slate-700 dark:text-slate-200 truncate">{t.name}</p>
                            <p className="text-[10px] text-slate-400 truncate">{summarizeFilters(t.filters)}</p>
                          </td>
                          <td className="py-2 pr-3 text-slate-600 dark:text-slate-300 max-w-[140px] truncate">{label}</td>
                          <td className="py-2 pr-3"><ScheduleBadge schedule={t.schedule} /></td>
                          <td className="py-2 pr-3 text-slate-500 dark:text-slate-400 font-mono text-[10px]">{t.format}</td>
                          <td className="py-2 pr-3 text-slate-600 dark:text-slate-300">
                            <span className="inline-flex items-center gap-1"><Mail className="h-3 w-3 text-slate-400" />{t.recipients?.length || 0}</span>
                          </td>
                          <td className="py-2 pr-3 whitespace-nowrap">
                            {t.lastRunAt ? (
                              <span className="flex flex-col gap-0.5">
                                <span className="text-slate-500 dark:text-slate-400 text-[10px]">{fmtDateTime(t.lastRunAt)}</span>
                                {t.lastStatus && <StatusChip status={t.lastStatus} />}
                              </span>
                            ) : (
                              <span className="text-[10px] text-slate-400">never run</span>
                            )}
                          </td>
                          <td className="py-2 text-right">
                            <div className="inline-flex items-center gap-0.5">
                              <RowIconButton icon={PlayCircle} label="Run now" tone="brand" disabled={runningId === t.id}
                                onClick={() => { void runTemplateNow(t) }} />
                              <RowIconButton icon={Pencil} label="Edit template" disabled={runningId === t.id}
                                onClick={() => setTplDialog({ mode: "edit", tpl: t })} />
                              <RowIconButton icon={Trash2} label="Delete template" tone="danger" disabled={runningId === t.id}
                                onClick={() => setDeleting(t)} />
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-[11px] text-slate-400">
                Scheduled sends go out via your email gateway (Settings → Email Gateway) around {new Date().getUTCHours()}:00 UTC — “Run now” delivers immediately.
              </p>
            </>
          )}

          {/* ---- recent deliveries (last 20) ---- */}
          <div className="mt-4 border-t border-dashed border-slate-200 dark:border-slate-700 pt-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 flex items-center gap-1 mb-2">
              <Mail className="h-3 w-3" /> Recent deliveries
            </p>
            {templatesApi.loading && !deliveries.length ? (
              <LoadingRows rows={2} />
            ) : !deliveries.length ? (
              <p className="text-xs text-slate-400 py-2">No deliveries yet — run a template or wait for the schedule.</p>
            ) : (
              <div className="max-h-64 overflow-y-auto space-y-1.5 pr-1">
                {deliveries.map((d) => (
                  <div key={d.id} className="flex items-center gap-2 rounded-lg border border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1.5">
                    <StatusChip status={d.status} />
                    <span className="text-xs font-medium text-slate-700 dark:text-slate-200 truncate max-w-[160px]">{d.templateName}</span>
                    <span className="text-[10px] text-slate-400 font-mono truncate hidden sm:inline">{d.reportKey}.{d.format.toLowerCase()}</span>
                    <span className="text-[10px] text-slate-400 whitespace-nowrap hidden md:inline">{d.rows != null ? `${d.rows} rows` : "—"} · {d.recipientCount} rcpt</span>
                    {d.detail && <span className="text-[10px] text-slate-400 truncate hidden lg:inline max-w-[220px]" title={d.detail}>{d.detail}</span>}
                    <span className="ml-auto text-[10px] text-slate-400 whitespace-nowrap">{fmtDateTime(d.startedAt)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </SectionCard>
      )}

      {/* Wave 4 — template editor (keyed remount: fresh state every open) */}
      {tplDialog && (
        <TemplateDialog
          key={tplDialog.mode === "edit" ? `edit-${tplDialog.tpl.id}` : "new"}
          initial={tplDialog.mode === "edit" ? tplDialog.tpl : null}
          defaultReportKey={reportKey === "attendanceOverview" ? "employees" : reportKey}
          filtersSnapshot={payload}
          filterSummary={filterBits.length ? filterBits.join(" · ") : "All records"}
          onDone={() => { setTplDialog(null); templatesApi.reload() }}
          onCancel={() => setTplDialog(null)}
        />
      )}

      {/* Wave 4 — delete confirmation */}
      {deleting && (
        <ConfirmDialog
          open
          onOpenChange={(v) => { if (!v) setDeleting(null) }}
          title="Delete template"
          message={`Delete “${deleting.name}”? Its schedule stops immediately. Past delivery records are kept for audit.`}
          confirmLabel="Delete template"
          danger
          onConfirm={async () => {
            await rpc("reports.templates.delete", { id: deleting.id })
            templatesApi.reload()
          }}
        />
      )}

      {/* Wave 3 — in-app print preview (never a new tab) */}
      <ReportPrintModal payload={printPayload} onClose={() => setPrintPayload(null)} />

      {/* RPT-002 (Wave R3-3) — HIGH-11 typed confirmation for PII-class CSV
          exports: the server always required payload.confirm === "EXPORT";
          this dialog is the UI half that types it. */}
      <Dialog open={piiConfirm.open} onOpenChange={(v) => setPiiConfirm({ open: v, typed: v ? piiConfirm.typed : "" })}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-rose-600" /> Confirm bulk-PII export
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm text-slate-600 dark:text-slate-300">
            <p>
              <strong>{active.label}</strong> contains bulk personal data (parents, date of birth, contact and address fields).
              The export is recorded in the audit trail with your identity.
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Type <span className="font-mono font-semibold">EXPORT</span> to enable the download button.
            </p>
            <Input
              value={piiConfirm.typed}
              onChange={(e) => setPiiConfirm((s) => ({ ...s, typed: e.target.value }))}
              placeholder="EXPORT"
              className="font-mono"
              autoComplete="off"
            />
          </div>
          <DialogFooter>
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setPiiConfirm({ open: false, typed: "" })}>Cancel</Button>
            <Button
              size="sm"
              className="h-8 text-xs bg-rose-600 hover:bg-rose-700"
              disabled={piiConfirm.typed !== "EXPORT"}
              onClick={() => { void exportServerCsv() }}
            >
              <Download className="h-3.5 w-3.5 mr-1" /> Export PII report (.csv)
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** Searchable employee picker (combobox). */
function EmployeeCombobox({ employees, value, onChange }: { employees: any[]; value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const selected = employees.find((e) => e.id === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 text-xs text-left flex items-center gap-1 hover:bg-slate-50 dark:hover:bg-slate-800"
          role="combobox" aria-expanded={open} aria-controls="employee-combobox-list">
          <Search className="h-3.5 w-3.5 text-slate-400 shrink-0" />
          <span className="truncate flex-1 text-slate-600 dark:text-slate-300">{selected ? `${selected.fullName} (${selected.code})` : "All employees"}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[260px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search employee…" className="h-8 text-xs" />
          <CommandList id="employee-combobox-list" className="max-h-56">
            <CommandEmpty className="text-xs py-3">No employee found.</CommandEmpty>
            <CommandGroup>
              <CommandItem value="__all__" onSelect={() => { onChange(""); setOpen(false) }} className="text-xs">
                <Check className={`h-3.5 w-3.5 mr-1.5 ${!value ? "opacity-100" : "opacity-0"}`} /> All employees
              </CommandItem>
              {employees.map((e) => (
                <CommandItem key={e.id} value={`${e.fullName} ${e.code || ""}`} onSelect={() => { onChange(e.id); setOpen(false) }} className="text-xs">
                  <Check className={`h-3.5 w-3.5 mr-1.5 ${value === e.id ? "opacity-100" : "opacity-0"}`} />
                  <span className="truncate">{e.fullName}</span>
                  <span className="ml-auto text-[10px] text-slate-500 dark:text-slate-400">{e.code}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// ---------------- Wave 4 — template editor dialog ----------------
/** Create/edit a saved report template. Purpose-built (not FormDialog) because
 *  recipients are a REPEATABLE email input list (max 10), which the schema-
 *  driven form engine does not model. State is initialized once per mount;
 *  the parent mounts it conditionally + keyed so every open starts fresh —
 *  no setState-in-effect, no input wipe on parent re-renders. */
function TemplateDialog({ initial, defaultReportKey, filtersSnapshot, filterSummary, onDone, onCancel }: {
  initial: ReportTemplate | null
  defaultReportKey: string
  /** filters captured from the ACTIVE report filter bar (create flow only) */
  filtersSnapshot: Record<string, unknown>
  filterSummary: string
  onDone: () => void
  onCancel: () => void
}) {
  const toast = useHrm((s) => s.toast)
  const [name, setName] = useState(initial?.name || "")
  const [reportKey, setReportKey] = useState(
    initial?.reportKey && TEMPLATE_REPORTS.some((r) => r.key === initial.reportKey) ? initial.reportKey : defaultReportKey,
  )
  const [format, setFormat] = useState(initial?.format === "CSV" ? "CSV" : "XLSX")
  const [schedule, setSchedule] = useState(initial?.schedule || "OFF")
  const [active, setActive] = useState(initial?.active ?? true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // stable per-row ids (index keys would bleed input focus on remove)
<<<<<<< HEAD
  // T-11 — ids are derived, not ref-counted: the initializer assigns
  // index-based ids (evaluated once per mount) and addRecipient derives the
  // next id from the current rows, so no ref is touched during render.
  const [recipients, setRecipients] = useState<{ id: number; email: string; name: string }[]>(() => {
    const rows = (initial?.recipients || []).map((r) => ({ email: r.email || "", name: r.name || "" }))
    return (rows.length ? rows : [{ email: "", name: "" }]).map((r, i) => ({ ...r, id: i + 1 }))
  })
  const addRecipient = () => {
    if (recipients.length >= 10) return
    setRecipients((rs) => [...rs, { id: (rs[rs.length - 1]?.id ?? 0) + 1, email: "", name: "" }])
=======
  const nextRowId = useRef(1)
  const [recipients, setRecipients] = useState<{ id: number; email: string; name: string }[]>(() => {
    const rows = (initial?.recipients || []).map((r) => ({ email: r.email || "", name: r.name || "" }))
    return (rows.length ? rows : [{ email: "", name: "" }]).map((r) => ({ ...r, id: nextRowId.current++ }))
  })
  const addRecipient = () => {
    if (recipients.length >= 10) return
    setRecipients((rs) => [...rs, { id: nextRowId.current++, email: "", name: "" }])
>>>>>>> origin/main
  }
  const setRecipient = (id: number, field: "email" | "name", value: string) => {
    setRecipients((rs) => rs.map((r) => (r.id === id ? { ...r, [field]: value } : r)))
  }
  const removeRecipient = (id: number) => {
    setRecipients((rs) => (rs.length <= 1 ? rs : rs.filter((r) => r.id !== id)))
  }

  const filtersShown: Record<string, unknown> = initial ? initial.filters : filtersSnapshot
  const filtersSummaryShown = initial ? summarizeFilters(initial.filters) : filterSummary

  const submit = async () => {
    const cleanName = name.trim()
    if (cleanName.length < 2) { setError("Template name is required (2–80 characters)."); return }
    const valid = recipients
      .map((r) => ({ email: r.email.trim().toLowerCase(), name: r.name.trim() }))
      .filter((r) => r.email)
    if (recipients.some((r) => r.email.trim() && !EMAIL_RE.test(r.email.trim()))) {
      setError("One or more recipient emails look invalid — check the addresses.")
      return
    }
    if (!valid.length) { setError("At least one recipient email is required."); return }
    setBusy(true)
    setError(null)
    try {
      await rpc("reports.templates.save", {
        ...(initial ? { id: initial.id } : {}),
        name: cleanName,
        reportKey,
        filters: initial ? initial.filters : filtersSnapshot,
        format,
        schedule,
        recipients: valid.map((r) => (r.name ? { email: r.email, name: r.name } : { email: r.email })),
        active,
      })
      toast(`Template “${cleanName}” saved`)
      onDone()
    } catch (e: any) {
      setError(e?.message || "Save failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v && !busy) onCancel() }}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">{initial ? `Edit template — ${initial.name}` : "Save current as template"}</DialogTitle>
          <p className="text-xs text-slate-500">
            Pin a report + filters, then deliver it on a schedule or on demand via your email gateway.
          </p>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-2.5 py-1">
          <div className="space-y-1">
            <Label htmlFor="tpl-name" className="text-xs font-medium text-slate-600 dark:text-slate-300">
              Template name <span className="text-rose-500">*</span>
            </Label>
            <Input id="tpl-name" value={name} maxLength={80} placeholder="e.g. Monthly attendance digest"
              onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="tpl-report" className="text-xs font-medium text-slate-600 dark:text-slate-300">Report</Label>
            <Select value={reportKey} onValueChange={setReportKey}>
              <SelectTrigger id="tpl-report" className="text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {TEMPLATE_REPORTS.map((r) => (
                  <SelectItem key={r.key} value={r.key}>
                    {r.label}<span className="ml-2 text-[10px] text-slate-400">{r.group}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="tpl-format" className="text-xs font-medium text-slate-600 dark:text-slate-300">File format</Label>
            <Select value={format} onValueChange={setFormat}>
              <SelectTrigger id="tpl-format" className="text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="XLSX">Excel (.xlsx)</SelectItem>
                <SelectItem value="CSV">CSV (.csv)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="tpl-schedule" className="text-xs font-medium text-slate-600 dark:text-slate-300">Schedule</Label>
            <Select value={schedule} onValueChange={setSchedule}>
              <SelectTrigger id="tpl-schedule" className="text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="OFF">Manual — run on demand only</SelectItem>
                <SelectItem value="DAILY">Daily</SelectItem>
                <SelectItem value="WEEKLY">Weekly (from Monday)</SelectItem>
                <SelectItem value="MONTHLY">Monthly (from the 1st)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* current/stored filters — read-only snapshot */}
          <div className="sm:col-span-2 rounded-lg border bg-slate-50 dark:bg-slate-900 p-2.5 space-y-1">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              {initial ? "Stored filters (read-only)" : "Current filters (read-only)"}
            </p>
            <p className="text-xs text-slate-600 dark:text-slate-300">{filtersSummaryShown}</p>
            <pre className="text-[10px] leading-relaxed text-slate-400 whitespace-pre-wrap break-all font-mono max-h-16 overflow-y-auto">
              {JSON.stringify(filtersShown)}
            </pre>
          </div>

          {/* repeatable recipient inputs */}
          <div className="sm:col-span-2 space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-medium text-slate-600 dark:text-slate-300">
                Recipients <span className="text-rose-500">*</span>
              </Label>
              <Button type="button" size="sm" variant="outline" className="h-7 text-xs bg-white dark:bg-slate-900"
                onClick={addRecipient} disabled={recipients.length >= 10}>
                <Plus className="h-3.5 w-3.5 mr-1" /> Add ({recipients.length}/10)
              </Button>
            </div>
            <div className="space-y-1.5 max-h-44 overflow-y-auto pr-1">
              {recipients.map((r) => (
                <div key={r.id} className="flex items-center gap-1.5">
                  <Input type="email" placeholder="name@company.com" value={r.email} maxLength={160}
                    className="h-8 flex-[1.6] text-xs" aria-label={`Recipient email ${r.id}`}
                    onChange={(e) => setRecipient(r.id, "email", e.target.value)} />
                  <Input placeholder="Name (optional)" value={r.name} maxLength={80}
                    className="h-8 flex-1 text-xs" aria-label={`Recipient name ${r.id}`}
                    onChange={(e) => setRecipient(r.id, "name", e.target.value)} />
                  <RowIconButton icon={Trash2} label="Remove recipient" tone="danger"
                    disabled={recipients.length <= 1} onClick={() => removeRecipient(r.id)} />
                </div>
              ))}
            </div>
          </div>

          <div className="sm:col-span-2 flex items-center gap-2 pt-1">
            <Switch id="tpl-active" checked={active} onCheckedChange={setActive} />
            <Label htmlFor="tpl-active" className="text-xs font-medium text-slate-600 dark:text-slate-300">
              Active {schedule === "OFF" ? "(matters once a schedule is set)" : "(scheduled sends enabled)"}
            </Label>
          </div>
        </div>
        {/* M-9 — announced to screen readers (role=alert) */}
        <FieldError message={error} />
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button onClick={() => { void submit() }} disabled={busy}>
            <Save className="mr-1 h-3.5 w-3.5" /> {busy ? "Saving…" : initial ? "Save changes" : "Save template"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
