"use client"
// ============ Employment Lifecycle (HRM-014 backlog 4-6/4-7/4-8) ============
// Read registers for promotions, transfers and salary revisions — all raised
// from the Employee 360° profile → History tab and approved via the engine.
import { Info, UserRound } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { useHrm } from "../store"
import { useApi } from "../api"
import { PageHeader, SectionTabs, StatusBadge, fmtMoney, fmtDate, titleCase, EmptyState } from "../shared/ui-kit"
import { DataTable, type Column } from "../shared/data-table"

type Promotion = {
  id: string
  employeeName: string
  employeeCode?: string | null
  fromTitle?: string | null
  toTitle?: string | null
  oldGrade?: string | null
  newGrade?: string | null
  newBasicSalary?: number | null
  effectiveDate: string
  reason?: string | null
  status: string
}

type Transfer = {
  id: string
  employeeName: string
  employeeCode?: string | null
  fromBranch?: string | null
  toBranch?: string | null
  fromDept?: string | null
  toDept?: string | null
  effectiveDate: string
  reason?: string | null
  status: string
}

type SalaryRevision = {
  id: string
  employeeName: string
  employeeCode?: string | null
  previousSalary: number
  newSalary: number
  increaseAmount: number
  increasePercent: number
  effectiveDate: string
  reason?: string | null
  type: string
  status: string
}

const REVISION_TYPE_COLORS: Record<string, string> = {
  INCREMENT: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  STRUCTURE_CHANGE: "bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300",
  NEW_STRUCTURE: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
}

function EmployeeCell({ name, code }: { name?: string | null; code?: string | null }) {
  return (
    <div>
      <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{name || "—"}</p>
      {code && <p className="text-[11px] text-slate-500 dark:text-slate-400">{code}</p>}
    </div>
  )
}

function FromTo({ from, to, second }: { from?: string | null; to?: string | null; second?: { from?: string | null; to?: string | null } }) {
  const line = (f?: string | null, t?: string | null) => (
    <span className="flex items-center gap-1.5 min-w-0">
      <span className="text-xs text-slate-600 dark:text-slate-300 truncate">{f || "—"}</span>
      <span className="text-emerald-500 shrink-0" aria-label="to">→</span>
      <span className="text-xs font-medium text-slate-800 dark:text-slate-100 truncate">{t || "—"}</span>
    </span>
  )
  return (
    <div className="space-y-0.5">
      {line(from, to)}
      {second && <div className="pl-0.5">{line(second.from, second.to)}</div>}
    </div>
  )
}

export default function LifecycleView() {
  const { can } = useHrm()
  // global-search deep link: pre-select a tab (params arrive with the view)
  const presetTab = useHrm((s) => (s.view?.key === "lifecycle" && s.view?.params?.tab) || undefined)
  const canEmployees = can("employees", "view")
  const canPayroll = can("payroll", "view")

  return (
    <div className="space-y-4">
      <PageHeader
        title="Employment Lifecycle"
        subtitle="Promotions, transfers and salary revisions — the immutable employee history register"
      />

      <div className="rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50/60 dark:bg-emerald-950/40 p-3 flex items-start gap-2">
        <Info className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" />
        <p className="text-xs text-slate-600 dark:text-slate-300">
          New promotion / transfer / salary revision requests are raised from the Employee 360° profile → History tab and flow through the approval engine.
        </p>
      </div>

      <SectionTabs
        defaultValue={presetTab as string | undefined}
        tabs={[
          { value: "promotions", label: "Promotions", content: canEmployees ? <PromotionsTab /> : <DeniedNotice /> },
          { value: "transfers", label: "Transfers", content: canEmployees ? <TransfersTab /> : <DeniedNotice /> },
          { value: "revisions", label: "Salary Revisions", content: canPayroll ? <SalaryRevisionsTab /> : <DeniedNotice need="payroll.view" /> },
        ]}
      />
    </div>
  )
}

function DeniedNotice({ need = "employees.view" }: { need?: string }) {
  return (
    <div className="rounded-xl border bg-white dark:bg-slate-900">
      <EmptyState icon={UserRound} title="Permission required" hint={`Your role does not include ${need} — ask an administrator if you need access to this register.`} />
    </div>
  )
}

// ================= PROMOTIONS (4-6) =================
function PromotionsTab() {
  const { data, loading, error } = useApi<Promotion[]>("promotions.list", {})
  const rows = data || []

  const columns: Column<Promotion>[] = [
    { key: "employeeName", label: "Employee", sortValue: (r) => r.employeeName, render: (r) => <EmployeeCell name={r.employeeName} code={r.employeeCode} /> },
    { key: "fromTitle", label: "Designation", sortValue: (r) => r.fromTitle || "", render: (r) => <FromTo from={r.fromTitle} to={r.toTitle} /> },
    {
      key: "oldGrade", label: "Grade", sortValue: (r) => r.oldGrade || "",
      render: (r) => <FromTo from={r.oldGrade} to={r.newGrade} />,
    },
    {
      key: "newBasicSalary", label: "New Basic", align: "right", sortValue: (r) => r.newBasicSalary || 0,
      render: (r) => r.newBasicSalary != null
        ? <span className="text-xs font-semibold tabular-nums">{fmtMoney(r.newBasicSalary)}</span>
        : <span className="text-xs text-slate-400">—</span>,
    },
    { key: "effectiveDate", label: "Effective", sortValue: (r) => r.effectiveDate, render: (r) => <span className="text-xs text-slate-500 tabular-nums">{fmtDate(r.effectiveDate)}</span> },
    { key: "reason", label: "Reason", sortValue: (r) => r.reason || "", render: (r) => <span className="text-xs text-slate-500 truncate block max-w-[220px]">{r.reason || "—"}</span> },
    { key: "status", label: "Status", render: (r) => <StatusBadge status={r.status} /> },
  ]

  return (
    <DataTable
      columns={columns} rows={rows} loading={loading} error={error} pageSize={15} csvName="promotions"
      searchPlaceholder="Search employee, designation…"
      emptyTitle="No promotions recorded"
      emptyHint="Raise a promotion from the Employee 360° profile → History tab — it then flows through the approval engine."
    />
  )
}

// ================= TRANSFERS (4-7) =================
function TransfersTab() {
  const { data, loading, error } = useApi<Transfer[]>("transfers.list", {})
  const rows = data || []

  const columns: Column<Transfer>[] = [
    { key: "employeeName", label: "Employee", sortValue: (r) => r.employeeName, render: (r) => <EmployeeCell name={r.employeeName} code={r.employeeCode} /> },
    {
      key: "fromBranch", label: "Movement", sortValue: (r) => r.fromBranch || "",
      render: (r) => <FromTo from={r.fromBranch} to={r.toBranch} second={{ from: r.fromDept, to: r.toDept }} />,
    },
    { key: "effectiveDate", label: "Effective", sortValue: (r) => r.effectiveDate, render: (r) => <span className="text-xs text-slate-500 tabular-nums">{fmtDate(r.effectiveDate)}</span> },
    { key: "reason", label: "Reason", sortValue: (r) => r.reason || "", render: (r) => <span className="text-xs text-slate-500 truncate block max-w-[220px]">{r.reason || "—"}</span> },
    { key: "status", label: "Status", render: (r) => <StatusBadge status={r.status} /> },
  ]

  return (
    <DataTable
      columns={columns} rows={rows} loading={loading} error={error} pageSize={15} csvName="transfers"
      searchPlaceholder="Search employee, branch…"
      emptyTitle="No transfers recorded"
      emptyHint="Raise a transfer from the Employee 360° profile → History tab — it then flows through the approval engine."
    />
  )
}

// ================= SALARY REVISIONS (4-8) =================
function SalaryRevisionsTab() {
  const { data, loading, error } = useApi<SalaryRevision[]>("salaryRevisions.list", {})
  const rows = data || []

  const columns: Column<SalaryRevision>[] = [
    { key: "employeeName", label: "Employee", sortValue: (r) => r.employeeName, render: (r) => <EmployeeCell name={r.employeeName} code={r.employeeCode} /> },
    { key: "previousSalary", label: "Previous", align: "right", sortValue: (r) => r.previousSalary, render: (r) => <span className="text-xs text-slate-600 dark:text-slate-300 tabular-nums">{fmtMoney(r.previousSalary)}</span> },
    { key: "newSalary", label: "New", align: "right", sortValue: (r) => r.newSalary, render: (r) => <span className="text-xs font-semibold tabular-nums">{fmtMoney(r.newSalary)}</span> },
    {
      key: "increaseAmount", label: "Increase", align: "right", sortValue: (r) => r.increaseAmount,
      render: (r) => (
        <Badge className={
          r.increaseAmount > 0
            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 text-[10px] tabular-nums"
            : r.increaseAmount < 0
              ? "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300 text-[10px] tabular-nums"
              : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-500 dark:text-slate-400 text-[10px] tabular-nums"
        }>
          {r.increaseAmount >= 0 ? "+" : ""}{fmtMoney(r.increaseAmount)} ({r.increasePercent >= 0 ? "+" : ""}{Number(r.increasePercent ?? 0).toFixed(1)}%)
        </Badge>
      ),
    },
    {
      key: "type", label: "Type", sortValue: (r) => r.type,
      render: (r) => <Badge className={`text-[10px] ${REVISION_TYPE_COLORS[r.type] || "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"}`}>{titleCase(r.type)}</Badge>,
    },
    { key: "effectiveDate", label: "Effective", sortValue: (r) => r.effectiveDate, render: (r) => <span className="text-xs text-slate-500 tabular-nums">{fmtDate(r.effectiveDate)}</span> },
    { key: "reason", label: "Reason", sortValue: (r) => r.reason || "", render: (r) => <span className="text-xs text-slate-500 truncate block max-w-[220px]">{r.reason || "—"}</span> },
    { key: "status", label: "Status", render: (r) => <StatusBadge status={r.status} /> },
  ]

  return (
    <DataTable
      columns={columns} rows={rows} loading={loading} error={error} pageSize={15} csvName="salary-revisions"
      searchPlaceholder="Search employee, reason…"
      emptyTitle="No salary revisions recorded"
      emptyHint="Raise a salary revision from the Employee 360° profile → History tab — it then flows through the approval engine."
    />
  )
}
