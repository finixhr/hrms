"use client"
// ============ Overtime Management (HRM-014 / spec §7.6) ============
// OT register for a month with day-type tiers (weekday / weekly-off / holiday),
// vendor rate policy, cost estimate and the §7.6 approval flow.
import { useMemo, useState } from "react"
import {
  Timer, CalendarDays, Clock, Gauge, Info, Check, X, Send, ListChecks,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useHrm } from "../store"
import { useApi, rpc, useEmployeeDirectory } from "../api"
import { PageHeader, StatCard, fmtMoney, fmtDate, titleCase, minutesHHMM } from "../shared/ui-kit"
import { DataTable, type Column } from "../shared/data-table"
import { ConfirmDialog } from "../shared/form-dialog"

type OtRow = {
  id: string
  date: string
  employeeId: string
  employeeName: string
  employeeCode?: string | null
  branchId?: string | null
  departmentId?: string | null
  shiftId?: string | null
  checkIn?: string | null
  checkOut?: string | null
  overtimeMinutes: number
  otApproved: boolean | null
  status: string
  tier: "holiday" | "weekly-off" | "weekday"
  multiplier: number
  estCost: number
  source?: string | null
}

type OtData = {
  month: string
  rows: OtRow[]
  totalMinutes: number
  pendingCount: number
  otApprovalRequired: boolean
  maxOtHoursPerMonth?: number | null
  otRates?: {
    weekdayRate?: number
    holidayRate?: number
    weeklyOffRate?: number
    calcBasis?: string
    roundToMinutes?: number
  }
}

const TIER_COLORS: Record<string, string> = {
  weekday: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  "weekly-off": "bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300",
  holiday: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
}

// Sentinel for "All" in selects (Radix rejects value="").
const ALL = "__all__"

export default function OvertimeView() {
  const { can, toast } = useHrm()
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7))
  const [employeeId, setEmployeeId] = useState("")
  const [tier, setTier] = useState("")
  const [approval, setApproval] = useState("")
  const [selected, setSelected] = useState<string[]>([])
  const [act, setAct] = useState<{ row: OtRow; decision: "APPROVE" | "REJECT" } | null>(null)
  const [submitTarget, setSubmitTarget] = useState<OtRow | null>(null)
  const [bulkOpen, setBulkOpen] = useState(false)

  const { data: employees } = useEmployeeDirectory()

  // Est. cost needs each employee's basic salary — the register route accepts a
  // basicByEmployee map; only payroll viewers may read salary structures.
  const canPayroll = can("payroll", "view")
  const { data: structures } = useApi<any[]>(canPayroll ? "salaryStructures.list" : null, { currentOnly: true })
  const basics = useMemo(() => {
    const m: Record<string, number> = {}
    const best: Record<string, string> = {}
    for (const s of structures || []) {
      if (!s.basic) continue
      // keep the latest effective structure per employee
      const from = String(s.effectiveFrom || "")
      if (m[s.employeeId] == null || from >= best[s.employeeId]) {
        m[s.employeeId] = s.basic
        best[s.employeeId] = from
      }
    }
    return m
  }, [structures])

  const payload = useMemo(() => ({
    month,
    employeeId: employeeId || undefined,
    ...(Object.keys(basics).length ? { basicByEmployee: basics } : {}),
  }), [month, employeeId, basics])

  const { data, loading, error, reload } = useApi<OtData>("overtime.list", payload)

  const rows = useMemo(() => {
    let out = data?.rows || []
    if (tier) out = out.filter((r) => r.tier === tier)
    if (approval === "PENDING") out = out.filter((r) => r.otApproved === false)
    else if (approval === "APPROVED") out = out.filter((r) => r.otApproved === true)
    else if (approval === "AUTO") out = out.filter((r) => r.otApproved === null)
    return out
  }, [data, tier, approval])

  const rates = data?.otRates || {}
  const otApprovalRequired = !!data?.otApprovalRequired
  const canEdit = can("attendance", "edit")

  const selectableIds = rows
    .filter((r) => r.otApproved === null && otApprovalRequired)
    .map((r) => r.id)
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.includes(id))

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))

  const approveAct = async (reason?: string) => {
    if (!act) return
    await rpc("attendance.otApprove", { id: act.row.id, decision: act.decision, reason })
    toast(`Overtime ${act.decision === "APPROVE" ? "approved" : "rejected"} for ${act.row.employeeName}`)
    reload()
  }

  const submitIds = async (ids: string[], label: string) => {
    const res = await rpc("overtime.submit", { ids })
    toast(`Submitted ${res?.submitted ?? ids.length} OT day(s) for approval — ${label}`)
    setSelected([])
    reload()
  }

  // only submit ids still visible/selectable under the current filters
  const bulkSubmit = () => submitIds(selected.filter((id) => selectableIds.includes(id)), "bulk selection")
  const singleSubmit = () => submitTarget ? submitIds([submitTarget.id], `${submitTarget.employeeName}, ${fmtDate(submitTarget.date)}`) : undefined

  const columns: Column<OtRow>[] = [
    ...(otApprovalRequired && canEdit ? [{
      key: "__sel", label: "", align: "center" as const, sortValue: (r: OtRow) => (r.otApproved === null ? "1" : "0"),
      render: (r: OtRow) => r.otApproved === null ? (
        <Checkbox
          aria-label={`Select overtime day of ${r.employeeName} on ${r.date}`}
          checked={selected.includes(r.id)}
          onCheckedChange={() => toggle(r.id)}
        />
      ) : <span className="text-xs text-slate-300 dark:text-slate-600">·</span>,
    }] : []),
    { key: "date", label: "Date", sortValue: (r) => r.date, render: (r) => <span className="text-xs font-medium text-slate-700 dark:text-slate-200 tabular-nums">{fmtDate(r.date)}</span> },
    {
      key: "employeeName", label: "Employee", sortValue: (r) => r.employeeName,
      render: (r) => (
        <div>
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{r.employeeName}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">{r.employeeCode || "—"}</p>
        </div>
      ),
    },
    {
      key: "checkIn", label: "In / Out", sortValue: (r) => r.checkIn || "",
      render: (r) => (
        <span className="text-xs text-slate-600 dark:text-slate-300 tabular-nums">
          {r.checkIn || "—"} <span className="text-slate-300 dark:text-slate-600">→</span> {r.checkOut || "—"}
        </span>
      ),
    },
    {
      key: "overtimeMinutes", label: "OT Hours", align: "right", sortValue: (r) => r.overtimeMinutes,
      render: (r) => <span className="text-xs font-bold text-teal-700 dark:text-teal-300 tabular-nums">{minutesHHMM(r.overtimeMinutes)}</span>,
    },
    {
      key: "tier", label: "Day Type", sortValue: (r) => r.tier,
      render: (r) => <Badge className={`text-[10px] ${TIER_COLORS[r.tier] || TIER_COLORS.weekday}`}>{titleCase(r.tier)}</Badge>,
    },
    {
      key: "multiplier", label: "Rate", align: "right", sortValue: (r) => r.multiplier,
      render: (r) => <span className="text-xs text-slate-600 dark:text-slate-300 tabular-nums">×{r.multiplier}</span>,
    },
    {
      key: "estCost", label: "Est. Cost", align: "right", sortValue: (r) => r.estCost,
      render: (r) => <span className="text-xs font-semibold tabular-nums">{fmtMoney(r.estCost)}</span>,
    },
    {
      key: "otApproved", label: "Approval", sortValue: (r) => (r.otApproved === null ? "auto" : String(r.otApproved)),
      render: (r) => r.otApproved === false
        ? <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300 text-[10px]">Pending</Badge>
        : r.otApproved === true
          ? <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 text-[10px]">Approved</Badge>
          : <Badge className="bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-500 dark:text-slate-400 text-[10px]">Auto</Badge>,
    },
    {
      key: "actions", label: "", align: "right",
      render: (r) => (
        <div className="flex items-center justify-end gap-1">
          {r.otApproved === null && otApprovalRequired && canEdit && (
            <Button size="sm" variant="outline" className="h-7 text-[10px] text-emerald-700 border-emerald-300 hover:bg-emerald-50 dark:text-emerald-400 dark:border-emerald-900"
              onClick={() => setSubmitTarget(r)}>
              <Send className="h-3 w-3 mr-0.5" /> Submit
            </Button>
          )}
          {r.otApproved === false && canEdit && (
            <>
              <Button size="sm" variant="outline" className="h-7 text-[10px] text-emerald-700 border-emerald-300 hover:bg-emerald-50 dark:text-emerald-400 dark:border-emerald-900"
                onClick={() => setAct({ row: r, decision: "APPROVE" })}>
                <Check className="h-3 w-3 mr-0.5" /> Approve
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-[10px] text-rose-700 border-rose-300 hover:bg-rose-50 dark:text-rose-400 dark:border-rose-900"
                onClick={() => setAct({ row: r, decision: "REJECT" })}>
                <X className="h-3 w-3 mr-0.5" /> Reject
              </Button>
            </>
          )}
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <PageHeader
        title="Overtime Management"
        subtitle="Overtime register with day-type tiers, cost estimate and the §7.6 approval flow — approved OT feeds payroll"
        actions={otApprovalRequired && canEdit && selectableIds.length > 0 && (
          <Button size="sm" onClick={() => setBulkOpen(true)} className="h-8 text-xs ">
            <ListChecks className="h-3.5 w-3.5 mr-1" /> Submit Selected ({selected.filter((id) => selectableIds.includes(id)).length})
          </Button>
        )}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Total OT Hours" value={`${((data?.totalMinutes || 0) / 60).toFixed(2)}h`}
          sub={`${data?.rows?.length || 0} OT day(s) in view`} icon={Timer} tone="emerald"
        />
        <StatCard label="Payable OT Days" value={data?.rows?.length || 0} icon={CalendarDays} tone="sky" />
        <StatCard label="Pending Approvals" value={data?.pendingCount || 0} icon={Clock} tone="amber" />
        <StatCard
          label="Monthly Cap" value={data?.maxOtHoursPerMonth ? `${data.maxOtHoursPerMonth}h` : "Unlimited"}
          sub={otApprovalRequired ? "OT approval required" : "OT auto-accepted"} icon={Gauge} tone="slate"
        />
      </div>

      {/* Policy banner — the three vendor day-type rates + rounding basis */}
      <div className="rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50/60 dark:bg-emerald-950/40 p-3 flex items-start gap-2">
        <Info className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" />
        <div className="text-xs text-slate-600 dark:text-slate-300 flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <span className="font-semibold text-slate-700 dark:text-slate-200">OT rate policy:</span>
          <span>Weekday <span className="font-bold tabular-nums">×{rates.weekdayRate ?? 1.5}</span></span>
          <span>Holiday <span className="font-bold tabular-nums">×{rates.holidayRate ?? 2}</span></span>
          <span>Weekly-off <span className="font-bold tabular-nums">×{rates.weeklyOffRate ?? 2}</span></span>
          <span className="text-slate-400">|</span>
          <span>Basis: <span className="font-medium">{titleCase(rates.calcBasis || "FIXED")}{rates.roundToMinutes ? ` (nearest ${rates.roundToMinutes}m up)` : ""}</span></span>
          <span className="text-slate-400">|</span>
          <span>Hourly base: <span className="font-medium">basic ÷ 208</span></span>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Month</Label>
          <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="h-9 w-[160px]" />
        </div>
        <div className="space-y-1.5 min-w-[200px]">
          <Label className="text-xs font-medium">Employee</Label>
          <Select value={employeeId || ALL} onValueChange={(v) => { setEmployeeId(v === ALL ? "" : v); setSelected([]) }}>
            <SelectTrigger className="h-9"><SelectValue placeholder="All employees" /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All employees</SelectItem>
              {(employees || []).map((e: any) => (
                <SelectItem key={e.id} value={e.id}>{e.fullName} ({e.code})</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Day Type</Label>
          <Select value={tier || ALL} onValueChange={(v) => setTier(v === ALL ? "" : v)}>
            <SelectTrigger className="h-9 w-[140px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All</SelectItem>
              <SelectItem value="weekday">Weekday</SelectItem>
              <SelectItem value="weekly-off">Weekly-off</SelectItem>
              <SelectItem value="holiday">Holiday</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Approval</Label>
          <Select value={approval || ALL} onValueChange={(v) => setApproval(v === ALL ? "" : v)}>
            <SelectTrigger className="h-9 w-[150px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All</SelectItem>
              <SelectItem value="PENDING">Pending</SelectItem>
              <SelectItem value="APPROVED">Approved</SelectItem>
              <SelectItem value="AUTO">Auto-accepted</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {otApprovalRequired && canEdit && selectableIds.length > 0 && (
          <Button variant="ghost" size="sm" className="h-9 text-xs"
            onClick={() => setSelected(allSelected ? [] : selectableIds)}>
            {allSelected ? "Clear" : "Select all"} pending
          </Button>
        )}
      </div>

      <DataTable
        columns={columns} rows={rows} loading={loading} error={error} pageSize={15} csvName="overtime"
        searchPlaceholder="Search employee, date…"
        emptyTitle="No overtime in this month"
        emptyHint="Overtime appears here once employees work past their shift end — day type and vendor rates are applied automatically."
      />

      {/* Approve / reject single OT day */}
      <ConfirmDialog open={!!act} onOpenChange={(v) => { if (!v) setAct(null) }}
        title={act?.decision === "APPROVE" ? "Approve overtime" : "Reject overtime"}
        message={act
          ? `${act.row.employeeName} — ${fmtDate(act.row.date)}, ${minutesHHMM(act.row.overtimeMinutes)} (${titleCase(act.row.tier)}, ×${act.row.multiplier}).${
              act.decision === "APPROVE"
                ? " Approved overtime becomes payable in the next payroll run."
                : " Rejected overtime is zeroed for payroll and the employee is notified."
            }`
          : ""}
        danger={act?.decision === "REJECT"}
        requireReason={act?.decision === "REJECT"}
        confirmLabel={act?.decision === "APPROVE" ? "Approve" : "Reject"}
        onConfirm={approveAct} />

      {/* Single-day submit for approval */}
      <ConfirmDialog open={!!submitTarget} onOpenChange={(v) => { if (!v) setSubmitTarget(null) }}
        title="Submit overtime for approval"
        message={submitTarget
          ? `Send ${minutesHHMM(submitTarget.overtimeMinutes)} of overtime for ${submitTarget.employeeName} on ${fmtDate(submitTarget.date)} through the approval engine (process type OVERTIME)? It is flagged "Pending" and excluded from payroll until approved.`
          : ""}
        confirmLabel="Submit for Approval"
        onConfirm={singleSubmit} />

      {/* Bulk submit for approval */}
      <ConfirmDialog open={bulkOpen} onOpenChange={(v) => { if (!v) setBulkOpen(false) }}
        title="Submit overtime for approval"
        message={`Submit ${selected.length} selected OT day(s) into the approval engine (process type OVERTIME)? They are flagged "Pending" and excluded from payroll until approved.`}
        confirmLabel="Submit for Approval"
        onConfirm={bulkSubmit} />
    </div>
  )
}
