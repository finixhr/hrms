"use client"
// ============ Employee Quick Actions Slide-Over Drawer ============
// Sleek, modern, responsive slide-over panel opening from the right side
// (desktop: right drawer, mobile: full/responsive sheet) on clicking any
// Employee 360° Quick Action button. Provides dedicated sub-views with
// dynamic date range, period, cycle and status filters without leaving the
// employee profile, plus direct full-module navigation when desired.

import { useEffect, useMemo, useState } from "react"
import {
  X, ExternalLink, CalendarRange, CalendarClock, Plane,
  ReceiptText, Sparkles, Landmark, FileText, MapPin, Printer, Mail,
  Loader2, Clock,
  Route, Wallet, Info, Star, RefreshCw, ChevronDown,
  Filter, ShieldCheck, CreditCard,
} from "lucide-react"
import {
  Sheet, SheetContent, SheetTitle, SheetDescription,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { useHrm } from "../store"
import { useApi, rpc } from "../api"
import {
  fmtMoney, fmtDate, titleCase, StatusBadge,
  RatingStars, openPrintWindow, esc, todayDhaka,
} from "../shared/ui-kit"
import MapCanvas, { type MapMarker } from "../shared/map-canvas"

export type QuickActionType =
  | "leave"
  | "payslips"
  | "attendance"
  | "performance"
  | "loans"
  | "ait"
  | "fieldforce"

interface EmployeeQuickActionSheetProps {
  open: boolean
  action: QuickActionType | null
  onClose: () => void
  employee: any
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]

const REVIEW_AREAS: [string, string][] = [
  ["attendance", "Attendance"],
  ["punctuality", "Punctuality"],
  ["productivity", "Productivity"],
  ["quality", "Quality of Work"],
  ["teamwork", "Teamwork"],
  ["communication", "Communication"],
  ["customerService", "Customer Service"],
  ["leadership", "Leadership"],
  ["targetAchievement", "Target Achievement"],
]

// ================= MAIN SHEET CONTAINER =================
export function EmployeeQuickActionSheet({
  open,
  action,
  onClose,
  employee,
}: EmployeeQuickActionSheetProps) {
  const { navigate } = useHrm()

  // Metadata per action
  const meta = useMemo(() => {
    switch (action) {
      case "leave":
        return {
          title: "Leave History & Entitlements",
          subtitle: "Balance entitlements, carry-forward, and submitted leave requests",
          icon: Plane,
          accentBg: "bg-sky-50 dark:bg-sky-950/60",
          accentText: "text-sky-600 dark:text-sky-400",
          borderTone: "border-sky-200 dark:border-sky-850",
          fullViewKey: "leave",
          fullParams: { tab: "requests", employeeId: employee?.id },
          permKey: "leave",
        }
      case "payslips":
        return {
          title: "Payslips & Salary Archive",
          subtitle: "Monthly payslips, gross pay, deductions, tax withholding & payment records",
          icon: ReceiptText,
          accentBg: "bg-emerald-50 dark:bg-emerald-950/60",
          accentText: "text-emerald-600 dark:text-emerald-400",
          borderTone: "border-emerald-200 dark:border-emerald-850",
          fullViewKey: "payroll",
          fullParams: { tab: "payslips", employeeId: employee?.id },
          permKey: "payslip",
        }
      case "attendance":
        return {
          title: "Attendance Register & Timesheet",
          subtitle: "Check-in/out records, working hours, late minutes & overtime tracking",
          icon: CalendarRange,
          accentBg: "bg-teal-50 dark:bg-teal-950/60",
          accentText: "text-teal-600 dark:text-teal-400",
          borderTone: "border-teal-200 dark:border-teal-850",
          fullViewKey: "attendance",
          fullParams: { tab: "register", employeeId: employee?.id },
          permKey: "attendance",
        }
      case "performance":
        return {
          title: "Performance Reviews & KPI Ratings",
          subtitle: "Review cycles, 9-area evaluations, manager feedback & goals",
          icon: Sparkles,
          accentBg: "bg-purple-50 dark:bg-purple-950/60",
          accentText: "text-purple-600 dark:text-purple-400",
          borderTone: "border-purple-200 dark:border-purple-850",
          fullViewKey: "performance",
          fullParams: { tab: "reviews", employeeId: employee?.id },
          permKey: "performance",
        }
      case "loans":
        return {
          title: "Loans & Salary Advances",
          subtitle: "Principal, outstanding balance, installment schedules & payroll recovery",
          icon: Landmark,
          accentBg: "bg-amber-50 dark:bg-amber-950/60",
          accentText: "text-amber-600 dark:text-amber-400",
          borderTone: "border-amber-200 dark:border-amber-850",
          fullViewKey: "loans",
          fullParams: { tab: "loans", employeeId: employee?.id },
          permKey: "loans",
        }
      case "ait":
        return {
          title: "AIT / Income Tax Profile (ITA 2023)",
          subtitle: "Taxpayer category, investment rebate, monthly TDS withholding estimation",
          icon: FileText,
          accentBg: "bg-blue-50 dark:bg-blue-950/60",
          accentText: "text-blue-600 dark:text-blue-400",
          borderTone: "border-blue-200 dark:border-blue-850",
          fullViewKey: "ait",
          fullParams: { employeeId: employee?.id },
          permKey: "ait",
        }
      case "fieldforce":
        return {
          title: "Field Force & Location Hits",
          subtitle: "Daily visit execution, GPS coordinates & stop completion tracking",
          icon: MapPin,
          accentBg: "bg-rose-50 dark:bg-rose-950/60",
          accentText: "text-rose-600 dark:text-rose-400",
          borderTone: "border-rose-200 dark:border-rose-850",
          fullViewKey: "fieldforce",
          fullParams: { tab: "history", employeeId: employee?.id },
          permKey: "fieldforce",
        }
      default:
        return null
    }
  }, [action, employee])

  if (!meta || !employee) return null
  const Icon = meta.icon

  const handleOpenFull = () => {
    onClose()
    navigate(meta.fullViewKey, meta.fullParams)
  }

  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-full sm:max-w-xl md:max-w-2xl lg:max-w-3xl p-0 flex flex-col gap-0 h-full overflow-hidden border-l border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xl"
      >
        {/* Header Bar */}
        <div className="shrink-0 bg-white dark:bg-slate-900 border-b border-slate-200/90 dark:border-slate-800 px-5 py-3.5 shadow-xs">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className={`h-10 w-10 rounded-xl flex items-center justify-center shrink-0 border ${meta.accentBg} ${meta.borderTone}`}>
                <Icon className={`h-5 w-5 ${meta.accentText}`} />
              </div>
              <div className="min-w-0">
                <SheetTitle className="text-base font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2 truncate">
                  {meta.title}
                </SheetTitle>
                <SheetDescription className="text-xs text-slate-500 dark:text-slate-400 truncate">
                  {meta.subtitle}
                </SheetDescription>
              </div>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <Button
                variant="outline"
                size="sm"
                onClick={handleOpenFull}
                title="Open this module in full page view"
                className="h-8 text-xs font-medium text-slate-700 dark:text-slate-200 hover:text-emerald-700 hover:border-emerald-300 dark:hover:text-emerald-400 gap-1.5"
              >
                <ExternalLink className="h-3.5 w-3.5 text-emerald-600" />
                <span className="hidden sm:inline">Open Full Page</span>
              </Button>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close panel"
                className="h-8 w-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Employee Identification Sub-Strip */}
          <div className="mt-3 pt-2.5 border-t border-slate-100 dark:border-slate-800/80 flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2">
              <div className="h-6 w-6 rounded-full bg-slate-200 dark:bg-slate-700 flex items-center justify-center text-[10px] font-bold text-slate-700 dark:text-slate-200 shrink-0">
                {employee.fullName ? employee.fullName.slice(0, 2).toUpperCase() : "EM"}
              </div>
              <span className="font-semibold text-slate-900 dark:text-slate-100">{employee.fullName}</span>
              <Badge variant="outline" className="font-mono text-[10px] px-1.5 py-0 border-slate-300 dark:border-slate-700">
                {employee.code}
              </Badge>
              <span className="text-slate-300 dark:text-slate-700">·</span>
              <span className="text-slate-500 dark:text-slate-400 truncate max-w-[200px]">{employee.designationName || "No Designation"}</span>
            </div>
            <StatusBadge status={employee.status} />
          </div>
        </div>

        {/* Dynamic Body Area (Scrollable) */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {action === "leave" && <LeavePanel employee={employee} onOpenFull={handleOpenFull} />}
          {action === "payslips" && <PayslipsPanel employee={employee} onOpenFull={handleOpenFull} />}
          {action === "attendance" && <AttendancePanel employee={employee} onOpenFull={handleOpenFull} />}
          {action === "performance" && <PerformancePanel employee={employee} onOpenFull={handleOpenFull} />}
          {action === "loans" && <LoansPanel employee={employee} onOpenFull={handleOpenFull} />}
          {action === "ait" && <AitPanel employee={employee} onOpenFull={handleOpenFull} />}
          {action === "fieldforce" && <FieldforcePanel employee={employee} onOpenFull={handleOpenFull} />}
        </div>

        {/* Bottom Footer Action Bar */}
        <div className="shrink-0 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 px-5 py-2.5 flex items-center justify-between text-xs text-slate-500">
          <span className="flex items-center gap-1.5">
            <Info className="h-3.5 w-3.5 text-slate-400" />
            Slide-over preview · Real-time synchronized records
          </span>
          <Button variant="ghost" size="sm" onClick={onClose} className="h-7 text-xs">
            Close
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}

// =========================================================================
// 1. LEAVE PANEL
// =========================================================================
function LeavePanel({ employee, onOpenFull: _onOpenFull }: { employee: any; onOpenFull: () => void }) {
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [status, setStatus] = useState("all")

  const years = useMemo(() => {
    const y = now.getFullYear()
    return [y - 2, y - 1, y, y + 1]
  }, [])

  // Leave balances for this employee in the selected year
  // P6 WS-B — the sheet rides the employeeId filter server-side (the old
  // load-all-then-filter-client-side pattern hauled EVERY employee's
  // balances/loans/advances into the browser to show ONE employee's)
  const { data: allBalances, loading: balancesLoading } = useApi<any[]>("leaveBalances.list", { year, employeeId: employee.id })
  const balances = useMemo(() => {
    return (allBalances || []).filter((b: any) => b.employeeId === employee.id)
  }, [allBalances, employee.id])

  // Leave requests for this employee
  const { data: requests, loading: requestsLoading } = useApi<any[]>("leaveRequests.list", {
    employeeId: employee.id,
    ...(status !== "all" ? { status } : {}),
  })

  // Summary counts
  const totalEntitled = balances.reduce((sum, b) => sum + (b.entitled || 0), 0)
  const totalUsed = balances.reduce((sum, b) => sum + (b.used || 0), 0)
  const totalRemaining = balances.reduce((sum, b) => sum + (b.remaining || 0), 0)
  const totalPending = balances.reduce((sum, b) => sum + (b.pending || 0), 0)

  return (
    <div className="space-y-4">
      {/* Dynamic Filters Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 bg-white dark:bg-slate-900 p-2.5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-2xs">
        <div className="flex items-center gap-2">
          <Label className="text-xs font-medium text-slate-500">Year:</Label>
          <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
            <SelectTrigger className="h-8 w-[100px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {years.map((y) => (
                <SelectItem key={y} value={String(y)} className="text-xs">
                  {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Status filter chips */}
        <div className="flex flex-wrap items-center gap-1">
          {["all", "APPROVED", "PENDING", "REJECTED", "CANCELLED"].map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatus(s)}
              className={`h-7 px-2.5 text-xs font-medium rounded-lg transition-colors cursor-pointer ${
                status === s
                  ? "bg-sky-600 text-white shadow-2xs"
                  : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700"
              }`}
            >
              {s === "all" ? "All Requests" : titleCase(s)}
            </button>
          ))}
        </div>
      </div>

      {/* KPI Stats Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3">
          <p className="text-[10px] uppercase font-semibold text-slate-400">Total Entitled</p>
          <p className="text-lg font-bold text-slate-900 dark:text-white tabular-nums mt-0.5">
            {balancesLoading ? "…" : `${totalEntitled} d`}
          </p>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3">
          <p className="text-[10px] uppercase font-semibold text-amber-500">Used / Taken</p>
          <p className="text-lg font-bold text-amber-600 dark:text-amber-400 tabular-nums mt-0.5">
            {balancesLoading ? "…" : `${totalUsed} d`}
          </p>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3">
          <p className="text-[10px] uppercase font-semibold text-emerald-500">Remaining Balance</p>
          <p className="text-lg font-bold text-emerald-600 dark:text-emerald-400 tabular-nums mt-0.5">
            {balancesLoading ? "…" : `${totalRemaining} d`}
          </p>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3">
          <p className="text-[10px] uppercase font-semibold text-sky-500">Pending Approval</p>
          <p className="text-lg font-bold text-sky-600 dark:text-sky-400 tabular-nums mt-0.5">
            {balancesLoading ? "…" : `${totalPending} d`}
          </p>
        </div>
      </div>

      {/* Leave Balances Breakdown Cards */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200 uppercase tracking-wider flex items-center gap-1.5">
            <Plane className="h-3.5 w-3.5 text-sky-600" /> Entitlements Breakdown ({year})
          </h3>
          <span className="text-[11px] text-slate-400">
            {balances.length} leave {balances.length === 1 ? "type" : "types"} configured
          </span>
        </div>

        {balancesLoading ? (
          <div className="py-6 text-center text-xs text-slate-400">Loading leave balances…</div>
        ) : balances.length === 0 ? (
          <p className="text-xs text-slate-500 py-3 text-center">No leave balance records found for {year}.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {balances.map((b: any) => {
              const maxDays = (b.entitled || 0) + (b.carriedForward || 0)
              const pctUsed = maxDays > 0 ? Math.min(100, Math.round(((b.used || 0) / maxDays) * 100)) : 0

              return (
                <div key={b.id || b.typeCode} className="border border-slate-200/80 dark:border-slate-800 rounded-lg p-3 bg-slate-50/50 dark:bg-slate-900/50 space-y-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs font-bold text-slate-800 dark:text-slate-100">{b.typeName || b.typeCode}</p>
                      <span className="text-[10px] text-slate-400">
                        {b.typeCode} · {b.paid ? "Paid Leave" : "Unpaid Leave"}
                      </span>
                    </div>
                    <div className="text-right">
                      <span className="text-sm font-extrabold text-emerald-600 dark:text-emerald-400 tabular-nums">
                        {b.remaining}
                      </span>
                      <span className="text-[10px] text-slate-400 block">left of {maxDays}</span>
                    </div>
                  </div>

                  {/* Progress bar */}
                  <div className="w-full bg-slate-200 dark:bg-slate-800 h-1.5 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        pctUsed > 85 ? "bg-rose-500" : pctUsed > 60 ? "bg-amber-500" : "bg-emerald-500"
                      }`}
                      style={{ width: `${pctUsed}%` }}
                    />
                  </div>

                  <div className="flex items-center justify-between text-[10px] text-slate-500 dark:text-slate-400 pt-0.5">
                    <span>Used: <b className="text-slate-700 dark:text-slate-200 tabular-nums">{b.used || 0}</b></span>
                    <span>Carried: <b className="text-slate-700 dark:text-slate-200 tabular-nums">{b.carriedForward || 0}</b></span>
                    <span>Pending: <b className="text-amber-600 tabular-nums">{b.pending || 0}</b></span>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Leave Request History Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-2xs">
        <div className="p-3.5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
          <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200 uppercase tracking-wider flex items-center gap-1.5">
            <CalendarRange className="h-3.5 w-3.5 text-sky-600" /> Request History
          </h3>
          <span className="text-[11px] text-slate-400">
            {(requests || []).length} record(s)
          </span>
        </div>

        {requestsLoading ? (
          <div className="py-8 text-center text-xs text-slate-400">Loading requests…</div>
        ) : !requests || requests.length === 0 ? (
          <div className="py-8 text-center text-xs text-slate-400">
            No {status !== "all" ? status.toLowerCase() : ""} leave requests found for this employee.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50/80 dark:bg-slate-800/60">
                  <TableHead className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">Type</TableHead>
                  <TableHead className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">Dates</TableHead>
                  <TableHead className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 text-right">Days</TableHead>
                  <TableHead className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">Substitute</TableHead>
                  <TableHead className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">Status</TableHead>
                  <TableHead className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {requests.map((r: any) => (
                  <TableRow key={r.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40">
                    <TableCell className="text-xs font-medium text-slate-800 dark:text-slate-200">
                      <div>
                        {r.typeName || "Leave"}
                        {r.paid != null && (
                          <Badge className="ml-1 text-[9px] px-1 py-0" variant={r.paid ? "default" : "secondary"}>
                            {r.paid ? "Paid" : "Unpaid"}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-slate-600 dark:text-slate-300 whitespace-nowrap tabular-nums">
                      {fmtDate(r.fromDate)} → {fmtDate(r.toDate)}
                    </TableCell>
                    <TableCell className="text-xs text-right font-bold text-slate-700 dark:text-slate-200 tabular-nums">
                      {r.days} {r.halfDay && <span className="text-[10px] text-sky-600 font-normal">(½)</span>}
                    </TableCell>
                    <TableCell className="text-xs text-slate-500">
                      {r.substituteName || "—"}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={r.status} />
                    </TableCell>
                    <TableCell className="text-xs text-slate-500 max-w-[140px] truncate" title={r.reason || ""}>
                      {r.reason || "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  )
}

// =========================================================================
// 2. PAYSLIPS PANEL
// =========================================================================
function PayslipsPanel({ employee, onOpenFull: _onOpenFull }: { employee: any; onOpenFull: () => void }) {
  const toast = useHrm((s) => s.toast)
  const [filterYear, setFilterYear] = useState<string>("all")
  const [printingId, setPrintingId] = useState<string | null>(null)
  const [emailingId, setEmailingId] = useState<string | null>(null)

  const { data: payslips, loading, reload } = useApi<any[]>("payslips.list", {
    employeeId: employee.id,
  })

  // Extract available years from payslips
  const availableYears = useMemo(() => {
    const set = new Set<string>()
    for (const p of payslips || []) {
      if (p.periodYear) set.add(String(p.periodYear))
      else if (p.period && /\d{4}/.test(p.period)) {
        const match = p.period.match(/\d{4}/)
        if (match) set.add(match[0])
      }
    }
    return Array.from(set).sort((a, b) => Number(b) - Number(a))
  }, [payslips])

  // Filtered payslips
  const filteredPayslips = useMemo(() => {
    let list = payslips || []
    if (filterYear !== "all") {
      list = list.filter((p: any) =>
        String(p.periodYear) === filterYear || (p.period && p.period.includes(filterYear))
      )
    }
    return list
  }, [payslips, filterYear])

  // Aggregate stats
  const totalGross = filteredPayslips.reduce((s, p) => s + (p.gross || 0), 0)
  const totalNet = filteredPayslips.reduce((s, p) => s + (p.net || 0), 0)
  const totalAit = filteredPayslips.reduce((s, p) => s + (p.ait || 0), 0)

  const handlePrint = async (r: any) => {
    setPrintingId(r.id)
    try {
      const res = await rpc<{ html: string }>("payslips.html", { entryId: r.entryId || r.id })
      const w = openPrintWindow(res.html)
      if (!w) toast("Popup blocked — allow popups to view payslips", "err")
    } catch (e: any) {
      toast(e.message || "Failed to load payslip print view", "err")
    } finally {
      setPrintingId(null)
    }
  }

  const handleEmail = async (r: any) => {
    setEmailingId(r.id)
    try {
      const res = await rpc<any>("payslips.email", { entryId: r.entryId || r.id })
      if (res.status === "SENT") toast(`Payslip ${r.payslipNumber} emailed successfully`)
      else if (res.status === "SKIPPED") toast(`Email skipped: ${res.detail || "no email or gateway"}`, "err")
      else toast(`Payslip email: ${res.detail || "failed"}`, "err")
    } catch (e: any) {
      toast(e.message || "Failed to email payslip", "err")
    } finally {
      setEmailingId(null)
    }
  }

  return (
    <div className="space-y-4">
      {/* Dynamic Filter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 bg-white dark:bg-slate-900 p-2.5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-2xs">
        <div className="flex items-center gap-2">
          <Label className="text-xs font-medium text-slate-500">Filter Year:</Label>
          <Select value={filterYear} onValueChange={setFilterYear}>
            <SelectTrigger className="h-8 w-[120px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs">All Years</SelectItem>
              {availableYears.map((y) => (
                <SelectItem key={y} value={y} className="text-xs">{y}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <span className="text-xs text-slate-500">
          Showing <b>{filteredPayslips.length}</b> payslip(s)
        </span>
      </div>

      {/* KPI Stats Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3">
          <p className="text-[10px] uppercase font-semibold text-slate-400">Payslips Issued</p>
          <p className="text-lg font-bold text-slate-900 dark:text-white tabular-nums mt-0.5">
            {loading ? "…" : filteredPayslips.length}
          </p>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3">
          <p className="text-[10px] uppercase font-semibold text-slate-500">Total Gross Salary</p>
          <p className="text-lg font-bold text-slate-900 dark:text-white tabular-nums mt-0.5">
            {loading ? "…" : fmtMoney(totalGross)}
          </p>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3">
          <p className="text-[10px] uppercase font-semibold text-emerald-600">Total Net Paid</p>
          <p className="text-lg font-bold text-emerald-600 dark:text-emerald-400 tabular-nums mt-0.5">
            {loading ? "…" : fmtMoney(totalNet)}
          </p>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3">
          <p className="text-[10px] uppercase font-semibold text-blue-500">Total Tax / AIT</p>
          <p className="text-lg font-bold text-blue-600 dark:text-blue-400 tabular-nums mt-0.5">
            {loading ? "…" : fmtMoney(totalAit)}
          </p>
        </div>
      </div>

      {/* Payslips Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-2xs">
        <div className="p-3.5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
          <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200 uppercase tracking-wider flex items-center gap-1.5">
            <ReceiptText className="h-3.5 w-3.5 text-emerald-600" /> Payslip Archive
          </h3>
          <Button variant="ghost" size="sm" onClick={() => reload()} className="h-7 text-xs">
            <RefreshCw className="h-3 w-3 mr-1" /> Refresh
          </Button>
        </div>

        {loading ? (
          <div className="py-8 text-center text-xs text-slate-400">Loading payslips…</div>
        ) : filteredPayslips.length === 0 ? (
          <div className="py-8 text-center text-xs text-slate-400">
            No payslip records generated for this employee yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50/80 dark:bg-slate-800/60">
                  <TableHead className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">Payslip No</TableHead>
                  <TableHead className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">Period</TableHead>
                  <TableHead className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 text-right">Gross</TableHead>
                  <TableHead className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 text-right">AIT</TableHead>
                  <TableHead className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 text-right">Net Pay</TableHead>
                  <TableHead className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">Status</TableHead>
                  <TableHead className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredPayslips.map((r: any) => (
                  <TableRow key={r.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40">
                    <TableCell className="text-xs font-mono font-medium text-slate-800 dark:text-slate-200">
                      {r.payslipNumber || "—"}
                    </TableCell>
                    <TableCell className="text-xs text-slate-600 dark:text-slate-300">
                      {r.period || "—"}
                      {r.paidOn && <span className="block text-[10px] text-slate-400">Paid: {fmtDate(r.paidOn)}</span>}
                    </TableCell>
                    <TableCell className="text-xs text-right tabular-nums text-slate-600 dark:text-slate-300">
                      {fmtMoney(r.gross)}
                    </TableCell>
                    <TableCell className="text-xs text-right tabular-nums text-slate-500">
                      {r.ait ? fmtMoney(r.ait) : "—"}
                    </TableCell>
                    <TableCell className="text-xs text-right font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                      {fmtMoney(r.net)}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={r.status} />
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs px-2"
                          disabled={printingId === r.id}
                          onClick={() => handlePrint(r)}
                          title="View / Print Payslip Document"
                        >
                          {printingId === r.id ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Printer className="h-3 w-3 mr-1" />}
                          Print
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs px-2 text-slate-500 hover:text-slate-900 dark:hover:text-white"
                          disabled={emailingId === r.id}
                          onClick={() => handleEmail(r)}
                          title="Email payslip to employee"
                        >
                          {emailingId === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Mail className="h-3 w-3" />}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  )
}

// =========================================================================
// 3. ATTENDANCE PANEL
// =========================================================================
const ATT_STATUS_CHIPS = [
  "all", "PRESENT", "LATE", "ABSENT", "LEAVE", "HALF_DAY", "HOLIDAY", "WEEKLY_OFF",
]
const ATT_TONE_MAP: Record<string, string> = {
  PRESENT: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  LATE: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  ABSENT: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  LEAVE: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  HOLIDAY: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  WEEKLY_OFF: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
}

function AttendancePanel({ employee, onOpenFull: _onOpenFull }: { employee: any; onOpenFull: () => void }) {
  const today = todayDhaka()
  const monthStart = today.slice(0, 8) + "01"

  const [mode, setMode] = useState<"month" | "range">("month")
  const [selectedMonth, setSelectedMonth] = useState<number>(new Date().getMonth() + 1)
  const [selectedYear, setSelectedYear] = useState<number>(new Date().getFullYear())
  const [from, setFrom] = useState(monthStart)
  const [to, setTo] = useState(today)
  const [statusFilter, setStatusFilter] = useState("all")

  // When in month mode, compute dates from month & year
  useEffect(() => {
    if (mode === "month") {
      const mStr = String(selectedMonth).padStart(2, "0")
      const start = `${selectedYear}-${mStr}-01`
      const lastDay = new Date(selectedYear, selectedMonth, 0).getDate()
      const end = `${selectedYear}-${mStr}-${String(lastDay).padStart(2, "0")}`
      setFrom(start)
      setTo(end)
    }
  }, [mode, selectedMonth, selectedYear])

  // Fetch attendance data using the server route
  const { data, loading } = useApi<any>("employees.attendanceHistory", {
    employeeId: employee.id,
    from,
    to,
    statuses: statusFilter !== "all" ? [statusFilter] : undefined,
  })

  // Summary counts
  const summary = (data?.summary || {}) as Record<string, number>
  const records: any[] = data?.records || []

  // Calculate total late and overtime minutes
  const totalLateMins = records.reduce((s, r) => s + (r.lateMinutes || 0), 0)
  const totalOtMins = records.reduce((s, r) => s + (r.otMinutes || 0), 0)

  return (
    <div className="space-y-4">
      {/* Mode Switch & Dynamic Date Controls */}
      <div className="bg-white dark:bg-slate-900 p-3 rounded-xl border border-slate-200 dark:border-slate-800 space-y-2.5 shadow-2xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {/* View mode toggle */}
          <div className="inline-flex items-center rounded-lg bg-slate-100 dark:bg-slate-800 p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setMode("month")}
              className={`px-3 py-1 rounded-md font-medium transition-colors ${
                mode === "month"
                  ? "bg-white dark:bg-slate-900 text-teal-700 dark:text-teal-300 shadow-2xs"
                  : "text-slate-600 dark:text-slate-400 hover:text-slate-900"
              }`}
            >
              Month View
            </button>
            <button
              type="button"
              onClick={() => setMode("range")}
              className={`px-3 py-1 rounded-md font-medium transition-colors ${
                mode === "range"
                  ? "bg-white dark:bg-slate-900 text-teal-700 dark:text-teal-300 shadow-2xs"
                  : "text-slate-600 dark:text-slate-400 hover:text-slate-900"
              }`}
            >
              Custom Range
            </button>
          </div>

          {/* Dynamic Inputs depending on mode */}
          {mode === "month" ? (
            <div className="flex items-center gap-1.5">
              <Select value={String(selectedMonth)} onValueChange={(v) => setSelectedMonth(Number(v))}>
                <SelectTrigger className="h-8 w-[120px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MONTHS.map((m, i) => (
                    <SelectItem key={m} value={String(i + 1)} className="text-xs">
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={String(selectedYear)} onValueChange={(v) => setSelectedYear(Number(v))}>
                <SelectTrigger className="h-8 w-[90px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[selectedYear - 1, selectedYear, selectedYear + 1].map((y) => (
                    <SelectItem key={y} value={String(y)} className="text-xs">
                      {y}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs">
              <div>
                <Input
                  type="date"
                  value={from}
                  max={to}
                  onChange={(e) => setFrom(e.target.value)}
                  className="h-8 w-[130px] text-xs"
                />
              </div>
              <span className="text-slate-400">→</span>
              <div>
                <Input
                  type="date"
                  value={to}
                  min={from}
                  onChange={(e) => setTo(e.target.value)}
                  className="h-8 w-[130px] text-xs"
                />
              </div>
            </div>
          )}
        </div>

        {/* Status filter chips */}
        <div className="flex flex-wrap items-center gap-1 pt-1 border-t border-slate-100 dark:border-slate-800">
          <span className="text-[10px] font-semibold uppercase text-slate-400 mr-1 flex items-center gap-1">
            <Filter className="h-3 w-3" /> Status:
          </span>
          {ATT_STATUS_CHIPS.map((st) => (
            <button
              key={st}
              type="button"
              onClick={() => setStatusFilter(st)}
              className={`h-6 px-2 text-[11px] font-medium rounded-full transition-colors cursor-pointer ${
                statusFilter === st
                  ? "bg-teal-700 text-white shadow-2xs"
                  : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200"
              }`}
            >
              {st === "all" ? "All" : titleCase(st)}
            </button>
          ))}
        </div>
      </div>

      {/* KPI Stats Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3">
          <p className="text-[10px] uppercase font-semibold text-emerald-600">Present</p>
          <p className="text-lg font-bold text-emerald-700 dark:text-emerald-400 tabular-nums mt-0.5">
            {loading ? "…" : summary.PRESENT || 0}
          </p>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3">
          <p className="text-[10px] uppercase font-semibold text-amber-500">Late Days</p>
          <p className="text-lg font-bold text-amber-600 dark:text-amber-400 tabular-nums mt-0.5">
            {loading ? "…" : summary.LATE || 0}
            {totalLateMins > 0 && <span className="text-xs font-normal text-slate-400 ml-1">({totalLateMins}m)</span>}
          </p>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3">
          <p className="text-[10px] uppercase font-semibold text-rose-500">Absent</p>
          <p className="text-lg font-bold text-rose-600 dark:text-rose-400 tabular-nums mt-0.5">
            {loading ? "…" : summary.ABSENT || 0}
          </p>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3">
          <p className="text-[10px] uppercase font-semibold text-sky-500">On Leave</p>
          <p className="text-lg font-bold text-sky-600 dark:text-sky-400 tabular-nums mt-0.5">
            {loading ? "…" : summary.LEAVE || 0}
          </p>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3">
          <p className="text-[10px] uppercase font-semibold text-teal-600">Total OT</p>
          <p className="text-lg font-bold text-teal-700 dark:text-teal-400 tabular-nums mt-0.5">
            {loading ? "…" : totalOtMins > 0 ? `${Math.floor(totalOtMins / 60)}h ${totalOtMins % 60}m` : "0m"}
          </p>
        </div>
      </div>

      {/* Timesheet Register Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-2xs">
        <div className="p-3.5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
          <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200 uppercase tracking-wider flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5 text-teal-600" /> Daily Register ({fmtDate(from)} → {fmtDate(to)})
          </h3>
          <span className="text-[11px] text-slate-400">
            {records.length} date entries
          </span>
        </div>

        {loading ? (
          <div className="py-8 text-center text-xs text-slate-400">Loading attendance entries…</div>
        ) : records.length === 0 ? (
          <div className="py-8 text-center text-xs text-slate-400">
            No attendance entries found in this period.
          </div>
        ) : (
          <div className="overflow-x-auto max-h-[50vh]">
            <Table>
              <TableHeader className="sticky top-0 bg-slate-50 dark:bg-slate-800 z-10">
                <TableRow>
                  <TableHead className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">Date</TableHead>
                  <TableHead className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">Status</TableHead>
                  <TableHead className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">Check In</TableHead>
                  <TableHead className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">Check Out</TableHead>
                  <TableHead className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 text-right">Worked</TableHead>
                  <TableHead className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 text-right">Late</TableHead>
                  <TableHead className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 text-right">OT</TableHead>
                  <TableHead className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">Source</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {records.map((r: any) => (
                  <TableRow key={r.id || r.date} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40">
                    <TableCell className="text-xs font-medium text-slate-800 dark:text-slate-200 whitespace-nowrap tabular-nums">
                      {fmtDate(r.date)}
                    </TableCell>
                    <TableCell>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${ATT_TONE_MAP[r.status] || "bg-slate-100 text-slate-600"}`}>
                        {titleCase(r.status)}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs tabular-nums text-slate-700 dark:text-slate-300">
                      {r.checkIn || "—"}
                    </TableCell>
                    <TableCell className="text-xs tabular-nums text-slate-700 dark:text-slate-300">
                      {r.checkOut || "—"}
                    </TableCell>
                    <TableCell className="text-xs text-right tabular-nums text-slate-600 dark:text-slate-300">
                      {r.workedMinutes ? `${Math.floor(r.workedMinutes / 60)}h ${r.workedMinutes % 60}m` : "—"}
                    </TableCell>
                    <TableCell className="text-xs text-right tabular-nums text-amber-600">
                      {r.lateMinutes ? `${r.lateMinutes}m` : "—"}
                    </TableCell>
                    <TableCell className="text-xs text-right tabular-nums text-teal-600">
                      {r.otMinutes ? `${r.otMinutes}m` : "—"}
                    </TableCell>
                    <TableCell className="text-xs text-slate-500">
                      <Badge variant="outline" className="text-[9px] px-1.5 py-0 font-normal">
                        {r.source ? titleCase(r.source) : "Standard"}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  )
}

// =========================================================================
// 4. PERFORMANCE PANEL
// =========================================================================
function PerformancePanel({ employee, onOpenFull: _onOpenFull }: { employee: any; onOpenFull: () => void }) {
  const [cycleId, setCycleId] = useState("all")
  const [expandedReviewId, setExpandedReviewId] = useState<string | null>(null)

  const { data: cycles } = useApi<any[]>("cycles.list", {})
  const { data: reviews, loading } = useApi<any[]>("reviews.list", {
    employeeId: employee.id,
    ...(cycleId !== "all" ? { cycleId } : {}),
  })

  // Summary statistics
  const reviewList = reviews || []
  const avgRating = useMemo(() => {
    if (reviewList.length === 0) return 0
    const sum = reviewList.reduce((s, r) => s + (Number(r.overallRating) || 0), 0)
    return Math.round((sum / reviewList.length) * 10) / 10
  }, [reviewList])

  const finalizedCount = reviewList.filter((r) => r.status === "FINAL").length

  return (
    <div className="space-y-4">
      {/* Dynamic Review Cycle Filter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 bg-white dark:bg-slate-900 p-2.5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-2xs">
        <div className="flex items-center gap-2">
          <Label className="text-xs font-medium text-slate-500">Review Cycle:</Label>
          <Select value={cycleId} onValueChange={setCycleId}>
            <SelectTrigger className="h-8 w-[180px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs">All Review Cycles</SelectItem>
              {(cycles || []).map((c: any) => (
                <SelectItem key={c.id} value={c.id} className="text-xs">
                  {c.name} ({c.year})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <span className="text-xs text-slate-500">
          <b>{reviewList.length}</b> review(s) found
        </span>
      </div>

      {/* KPI Stats Strip */}
      <div className="grid grid-cols-3 gap-2.5">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3">
          <p className="text-[10px] uppercase font-semibold text-slate-400">Total Reviews</p>
          <p className="text-lg font-bold text-slate-900 dark:text-white tabular-nums mt-0.5">
            {loading ? "…" : reviewList.length}
          </p>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3">
          <p className="text-[10px] uppercase font-semibold text-purple-600">Average Rating</p>
          <div className="flex items-center gap-1 mt-0.5">
            <span className="text-lg font-bold text-purple-700 dark:text-purple-300 tabular-nums">
              {loading ? "…" : avgRating > 0 ? `${avgRating} / 5` : "—"}
            </span>
            {avgRating > 0 && <Star className="h-4 w-4 text-amber-500 fill-amber-500 shrink-0" />}
          </div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3">
          <p className="text-[10px] uppercase font-semibold text-emerald-600">Finalized</p>
          <p className="text-lg font-bold text-emerald-600 dark:text-emerald-400 tabular-nums mt-0.5">
            {loading ? "…" : `${finalizedCount} of ${reviewList.length}`}
          </p>
        </div>
      </div>

      {/* Reviews Cards */}
      <div className="space-y-3">
        {loading ? (
          <div className="py-8 text-center text-xs text-slate-400">Loading performance reviews…</div>
        ) : reviewList.length === 0 ? (
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 text-center text-xs text-slate-400">
            No performance reviews evaluated for this employee in the selected cycle.
          </div>
        ) : (
          reviewList.map((r: any) => {
            const isExpanded = expandedReviewId === r.id
            const ratingsObj = (r.ratings || {}) as Record<string, number>

            return (
              <div
                key={r.id}
                className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3 shadow-2xs"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <h4 className="text-sm font-bold text-slate-900 dark:text-white">
                        {r.cycleName || "Review Cycle"}
                      </h4>
                      {r.cycleYear && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-normal">
                          {r.cycleYear}
                        </Badge>
                      )}
                      <StatusBadge status={r.status} />
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Evaluated by: <span className="font-medium text-slate-700 dark:text-slate-300">{r.reviewerName || "Manager"}</span>
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <div className="text-right">
                      <div className="flex items-center gap-1 justify-end">
                        <RatingStars value={Number(r.overallRating) || 0} />
                        <span className="text-sm font-bold text-slate-800 dark:text-slate-200 tabular-nums ml-1">
                          {Number(r.overallRating) || 0}
                        </span>
                      </div>
                      <span className="text-[10px] text-slate-400">Overall Score</span>
                    </div>

                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setExpandedReviewId(isExpanded ? null : r.id)}
                      className="h-8 text-xs text-slate-600 dark:text-slate-300"
                    >
                      {isExpanded ? "Hide Details" : "9 Areas"}
                      <ChevronDown className={`h-3.5 w-3.5 ml-1 transition-transform ${isExpanded ? "rotate-180" : ""}`} />
                    </Button>
                  </div>
                </div>

                {/* Feedback Notes */}
                {(r.managerComments || r.strengths || r.weaknesses || r.goals) && (
                  <div className="bg-slate-50/70 dark:bg-slate-850/50 rounded-lg p-3 space-y-2 text-xs">
                    {r.managerComments && (
                      <div>
                        <span className="font-semibold text-slate-700 dark:text-slate-300 block mb-0.5">Manager Feedback:</span>
                        <p className="text-slate-600 dark:text-slate-400 italic leading-relaxed">{r.managerComments}</p>
                      </div>
                    )}
                    {r.strengths && (
                      <div>
                        <span className="font-semibold text-emerald-700 dark:text-emerald-400 block mb-0.5">Key Strengths:</span>
                        <p className="text-slate-600 dark:text-slate-400 leading-relaxed">{r.strengths}</p>
                      </div>
                    )}
                    {r.goals && (
                      <div>
                        <span className="font-semibold text-sky-700 dark:text-sky-400 block mb-0.5">Future Goals:</span>
                        <p className="text-slate-600 dark:text-slate-400 leading-relaxed">{r.goals}</p>
                      </div>
                    )}
                  </div>
                )}

                {/* Expandable 9-Area Rating Breakdown */}
                {isExpanded && (
                  <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
                    <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-2">
                      9-Area Competency Ratings
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      {REVIEW_AREAS.map(([key, label]) => {
                        const val = ratingsObj[key] ?? 0
                        return (
                          <div key={key} className="flex items-center justify-between p-2 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-800 text-xs">
                            <span className="text-slate-700 dark:text-slate-300 font-medium truncate max-w-[130px]">{label}</span>
                            <div className="flex items-center gap-1 shrink-0">
                              <span className="font-bold text-slate-800 dark:text-slate-200 tabular-nums">{val}</span>
                              <Star className={`h-3 w-3 ${val > 0 ? "text-amber-500 fill-amber-500" : "text-slate-300"}`} />
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

// =========================================================================
// 5. LOANS & ADVANCES PANEL
// =========================================================================
function LoansPanel({ employee, onOpenFull: _onOpenFull }: { employee: any; onOpenFull: () => void }) {
  const [filterType, setFilterType] = useState<"all" | "loans" | "advances">("all")
  const [scheduleLoan, setScheduleLoan] = useState<any | null>(null)

  // Fetch loans and advances — P6 WS-B: employeeId-filtered server-side (the
  // old load-all-then-filter pattern hauled the tenant's whole loan book to
  // show ONE employee's)
  const { data: allLoans, loading: loansLoading } = useApi<any[]>("loans.list", { employeeId: employee.id })
  const { data: allAdvances, loading: advancesLoading } = useApi<any[]>("advances.list", { employeeId: employee.id })

  const loans = useMemo(() => {
    return (allLoans || []).filter((l: any) => l.employeeId === employee.id)
  }, [allLoans, employee.id])

  const advances = useMemo(() => {
    return (allAdvances || []).filter((a: any) => a.employeeId === employee.id)
  }, [allAdvances, employee.id])

  // Summaries
  const activeLoans = loans.filter((l) => l.status === "ACTIVE")
  const totalPrincipal = activeLoans.reduce((s, l) => s + (l.principal || 0), 0)
  const totalOutstanding = activeLoans.reduce((s, l) => s + (l.outstanding ?? l.balance ?? 0), 0)
  const totalMonthlyRecovery = activeLoans.reduce((s, l) => s + (l.monthlyDeduction || 0), 0)

  return (
    <div className="space-y-4">
      {/* Dynamic Type Filter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 bg-white dark:bg-slate-900 p-2.5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-2xs">
        <div className="inline-flex items-center rounded-lg bg-slate-100 dark:bg-slate-800 p-0.5 text-xs">
          <button
            type="button"
            onClick={() => setFilterType("all")}
            className={`px-3 py-1 rounded-md font-medium transition-colors ${
              filterType === "all" ? "bg-white dark:bg-slate-900 text-amber-700 dark:text-amber-300 shadow-2xs" : "text-slate-600 dark:text-slate-400"
            }`}
          >
            All Items
          </button>
          <button
            type="button"
            onClick={() => setFilterType("loans")}
            className={`px-3 py-1 rounded-md font-medium transition-colors ${
              filterType === "loans" ? "bg-white dark:bg-slate-900 text-amber-700 dark:text-amber-300 shadow-2xs" : "text-slate-600 dark:text-slate-400"
            }`}
          >
            Loans ({loans.length})
          </button>
          <button
            type="button"
            onClick={() => setFilterType("advances")}
            className={`px-3 py-1 rounded-md font-medium transition-colors ${
              filterType === "advances" ? "bg-white dark:bg-slate-900 text-amber-700 dark:text-amber-300 shadow-2xs" : "text-slate-600 dark:text-slate-400"
            }`}
          >
            Salary Advances ({advances.length})
          </button>
        </div>

        <span className="text-xs text-slate-500">
          <b>{activeLoans.length}</b> active loan(s)
        </span>
      </div>

      {/* KPI Stats Strip */}
      <div className="grid grid-cols-3 gap-2.5">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3">
          <p className="text-[10px] uppercase font-semibold text-slate-400">Total Active Principal</p>
          <p className="text-lg font-bold text-slate-900 dark:text-white tabular-nums mt-0.5">
            {loansLoading ? "…" : fmtMoney(totalPrincipal)}
          </p>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3">
          <p className="text-[10px] uppercase font-semibold text-rose-500">Total Outstanding</p>
          <p className="text-lg font-bold text-rose-600 dark:text-rose-400 tabular-nums mt-0.5">
            {loansLoading ? "…" : fmtMoney(totalOutstanding)}
          </p>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3">
          <p className="text-[10px] uppercase font-semibold text-amber-500">Monthly Payroll Recovery</p>
          <p className="text-lg font-bold text-amber-600 dark:text-amber-400 tabular-nums mt-0.5">
            {loansLoading ? "…" : fmtMoney(totalMonthlyRecovery)}
          </p>
        </div>
      </div>

      {/* Loans Section */}
      {(filterType === "all" || filterType === "loans") && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-2xs">
          <div className="p-3.5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
            <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200 uppercase tracking-wider flex items-center gap-1.5">
              <Landmark className="h-3.5 w-3.5 text-amber-600" /> Employee Loans
            </h3>
            <span className="text-[11px] text-slate-400">{loans.length} loan record(s)</span>
          </div>

          {loansLoading ? (
            <div className="py-8 text-center text-xs text-slate-400">Loading loans…</div>
          ) : loans.length === 0 ? (
            <div className="py-6 text-center text-xs text-slate-400">No loan records for this employee.</div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-slate-50/80 dark:bg-slate-800/60">
                    <TableHead className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">Type</TableHead>
                    <TableHead className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 text-right">Principal</TableHead>
                    <TableHead className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 text-right">Outstanding</TableHead>
                    <TableHead className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 text-right">Monthly</TableHead>
                    <TableHead className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">Status</TableHead>
                    <TableHead className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loans.map((l: any) => (
                    <TableRow key={l.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40">
                      <TableCell className="text-xs font-medium text-slate-800 dark:text-slate-200">
                        {titleCase(l.type || "PERSONAL")}
                        {l.startDate && <span className="block text-[10px] text-slate-400 font-normal">Start: {fmtDate(l.startDate)}</span>}
                      </TableCell>
                      <TableCell className="text-xs text-right tabular-nums text-slate-700 dark:text-slate-300">
                        {fmtMoney(l.principal)}
                      </TableCell>
                      <TableCell className="text-xs text-right font-bold tabular-nums text-rose-600 dark:text-rose-400">
                        {fmtMoney(l.outstanding ?? l.balance ?? 0)}
                      </TableCell>
                      <TableCell className="text-xs text-right tabular-nums text-slate-600 dark:text-slate-300">
                        {l.monthlyDeduction ? fmtMoney(l.monthlyDeduction) : "—"}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={l.status} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs px-2"
                          onClick={() => setScheduleLoan(l)}
                        >
                          Schedule
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}

      {/* Salary Advances Section */}
      {(filterType === "all" || filterType === "advances") && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-2xs">
          <div className="p-3.5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
            <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200 uppercase tracking-wider flex items-center gap-1.5">
              <Wallet className="h-3.5 w-3.5 text-amber-600" /> Salary Advances
            </h3>
            <span className="text-[11px] text-slate-400">{advances.length} advance record(s)</span>
          </div>

          {advancesLoading ? (
            <div className="py-8 text-center text-xs text-slate-400">Loading advances…</div>
          ) : advances.length === 0 ? (
            <div className="py-6 text-center text-xs text-slate-400">No salary advance records for this employee.</div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-slate-50/80 dark:bg-slate-800/60">
                    <TableHead className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">Date / Period</TableHead>
                    <TableHead className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 text-right">Amount</TableHead>
                    <TableHead className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">Reason</TableHead>
                    <TableHead className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {advances.map((a: any) => (
                    <TableRow key={a.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40">
                      <TableCell className="text-xs text-slate-700 dark:text-slate-300 tabular-nums">
                        {fmtDate(a.requestDate || a.createdAt)}
                        {a.recoveryMonth && (
                          <span className="block text-[10px] text-slate-400">
                            Recover: {MONTHS[a.recoveryMonth - 1]} {a.recoveryYear}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-right font-bold tabular-nums text-slate-900 dark:text-slate-100">
                        {fmtMoney(a.amount)}
                      </TableCell>
                      <TableCell className="text-xs text-slate-500 max-w-[200px] truncate" title={a.reason || ""}>
                        {a.reason || "—"}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={a.status} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}

      {/* Installment Schedule Dialog */}
      {scheduleLoan && (
        <Dialog open={!!scheduleLoan} onOpenChange={(v) => { if (!v) setScheduleLoan(null) }}>
          <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="text-base flex items-center gap-2">
                <CalendarClock className="h-4 w-4 text-amber-600" /> Loan Installment Schedule
              </DialogTitle>
              <p className="text-xs text-slate-500">
                {scheduleLoan.employeeName} · {fmtMoney(scheduleLoan.principal)} ({titleCase(scheduleLoan.type)})
              </p>
            </DialogHeader>

            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 text-xs bg-slate-50 dark:bg-slate-800 p-2.5 rounded-lg border">
                <div>Principal: <b>{fmtMoney(scheduleLoan.principal)}</b></div>
                <div>Outstanding: <b className="text-rose-600">{fmtMoney(scheduleLoan.outstanding ?? scheduleLoan.balance ?? 0)}</b></div>
                <div>Installments: <b>{scheduleLoan.installments} months</b></div>
                <div>Monthly Deduction: <b>{fmtMoney(scheduleLoan.monthlyDeduction)}</b></div>
              </div>

              {(!scheduleLoan.installmentsList || scheduleLoan.installmentsList.length === 0) ? (
                <p className="text-xs text-slate-400 text-center py-4">No detailed installments recorded yet.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="bg-slate-50 dark:bg-slate-800">
                      <TableHead className="text-[10px] uppercase">#</TableHead>
                      <TableHead className="text-[10px] uppercase">Due Date</TableHead>
                      <TableHead className="text-[10px] uppercase text-right">Amount</TableHead>
                      <TableHead className="text-[10px] uppercase text-right">Paid</TableHead>
                      <TableHead className="text-[10px] uppercase">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {scheduleLoan.installmentsList.map((inst: any, idx: number) => (
                      <TableRow key={inst.id || idx}>
                        <TableCell className="text-xs tabular-nums">#{inst.no || idx + 1}</TableCell>
                        <TableCell className="text-xs tabular-nums">{fmtDate(inst.dueDate)}</TableCell>
                        <TableCell className="text-xs text-right tabular-nums">{fmtMoney(inst.amount)}</TableCell>
                        <TableCell className="text-xs text-right tabular-nums text-emerald-600">{fmtMoney(inst.paidAmount || 0)}</TableCell>
                        <TableCell><StatusBadge status={inst.status} /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setScheduleLoan(null)}>Close</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

// =========================================================================
// 6. AIT / TAX PROFILE PANEL
// =========================================================================
function AitPanel({ employee, onOpenFull }: { employee: any; onOpenFull: () => void }) {
  const { data: configData } = useApi<any>("ait.config.get", {})
  const { data: profile, loading: profileLoading, error } = useApi<any>("ait.employee.profile", {
    employeeId: employee.id,
  })

  const fy = configData?.config?.fiscalYear
  const monthlyGross = profile?.monthlyGrossSalary || 0
  const monthlyBasic = profile?.monthlyBasicSalary || 0
  const annualGross = profile?.annualGrossOverride ?? (monthlyGross * 12)

  // Estimated annual TDS calculation
  const _estMonthlyTds = profile?.tdsYtd ? Math.round(profile.tdsYtd / 12) : null

  return (
    <div className="space-y-4">
      {/* Fiscal Year Status Strip */}
      <div className="flex flex-wrap items-center justify-between gap-2 bg-white dark:bg-slate-900 p-3 rounded-xl border border-slate-200 dark:border-slate-800 shadow-2xs">
        <div className="flex items-center gap-2">
          <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300 text-xs">
            {fy ? `Active FY ${fy.label}` : "Income Tax Act 2023"}
          </Badge>
          {fy && (
            <span className="text-xs text-slate-500">
              Assessment: {fy.assessmentYear} · {fy.tdsSectionRef || "Section 86"}
            </span>
          )}
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={onOpenFull}
          className="h-7 text-xs text-blue-600 hover:text-blue-700"
        >
          Open Live Calculator
        </Button>
      </div>

      {profileLoading ? (
        <div className="py-8 text-center text-xs text-slate-400">Loading tax profile…</div>
      ) : error ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs text-rose-700">
          {error}
        </div>
      ) : (
        <>
          {/* Tax Identification Details Card */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3">
            <h4 className="text-xs font-bold text-slate-800 dark:text-slate-200 uppercase tracking-wider flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5 text-blue-600" /> Tax Identification & Category
            </h4>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-800">
                <span className="text-slate-400 block text-[10px] uppercase font-semibold">Taxpayer Category</span>
                <span className="font-semibold text-slate-800 dark:text-slate-100 mt-0.5 block">
                  {profile?.taxpayerCategory ? titleCase(profile.taxpayerCategory) : "General Individual"}
                </span>
                {profile?.seniorSuggested && (
                  <span className="text-[10px] text-amber-600 block mt-0.5">
                    Age {profile.age} (eligible for Senior Citizen slab)
                  </span>
                )}
              </div>

              <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-800">
                <span className="text-slate-400 block text-[10px] uppercase font-semibold">e-TIN (12 Digits)</span>
                <span className="font-mono font-bold text-slate-800 dark:text-slate-100 mt-0.5 block">
                  {profile?.taxTin || employee.taxTin || "Not recorded"}
                </span>
              </div>

              <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-800">
                <span className="text-slate-400 block text-[10px] uppercase font-semibold">Section 78 Declared Investment</span>
                <span className="font-bold text-slate-800 dark:text-slate-100 mt-0.5 block">
                  {profile?.declaredInvestment ? fmtMoney(profile.declaredInvestment) : "৳ 0"}
                </span>
                <span className="text-[10px] text-slate-400 block">Eligible for tax rebate</span>
              </div>

              <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-800">
                <span className="text-slate-400 block text-[10px] uppercase font-semibold">TDS Deducted YTD</span>
                <span className="font-bold text-emerald-600 dark:text-emerald-400 mt-0.5 block">
                  {fmtMoney(profile?.tdsYtd || 0)}
                </span>
                <span className="text-[10px] text-slate-400 block">Current fiscal year withholding</span>
              </div>
            </div>
          </div>

          {/* Salary & TDS Assessment Card */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3">
            <h4 className="text-xs font-bold text-slate-800 dark:text-slate-200 uppercase tracking-wider flex items-center gap-1.5">
              <CreditCard className="h-3.5 w-3.5 text-blue-600" /> Salary Assessment & Deduction
            </h4>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 text-xs">
              <div className="p-2.5 rounded-lg border bg-slate-50/50 dark:bg-slate-800/40">
                <span className="text-slate-400 text-[10px] uppercase block">Monthly Gross</span>
                <span className="text-sm font-bold text-slate-900 dark:text-white tabular-nums mt-0.5 block">
                  {fmtMoney(monthlyGross)}
                </span>
              </div>
              <div className="p-2.5 rounded-lg border bg-slate-50/50 dark:bg-slate-800/40">
                <span className="text-slate-400 text-[10px] uppercase block">Monthly Basic</span>
                <span className="text-sm font-bold text-slate-900 dark:text-white tabular-nums mt-0.5 block">
                  {fmtMoney(monthlyBasic)}
                </span>
              </div>
              <div className="p-2.5 rounded-lg border bg-slate-50/50 dark:bg-slate-800/40">
                <span className="text-slate-400 text-[10px] uppercase block">Annualized Gross</span>
                <span className="text-sm font-bold text-slate-900 dark:text-white tabular-nums mt-0.5 block">
                  {fmtMoney(annualGross)}
                </span>
              </div>
            </div>

            <div className="rounded-lg bg-blue-50/60 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900 p-3 text-xs text-blue-900 dark:text-blue-200 space-y-1">
              <p className="font-semibold flex items-center gap-1">
                <Info className="h-3.5 w-3.5 text-blue-600" /> Section 86 Withholding Reference
              </p>
              <p className="text-[11px] text-blue-800/90 dark:text-blue-300 leading-relaxed">
                Salary tax is deducted monthly using the Section 86 average-rate method. Changes to declared investments or salary revisions automatically adjust upcoming payroll TDS deduction lines.
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// =========================================================================
// 7. FIELDFORCE & LOCATION HIT MAP PANEL
// =========================================================================
function minusDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00")
  d.setDate(d.getDate() - days)
  return d.toISOString().slice(0, 10)
}

function FieldforcePanel({ employee, onOpenFull: _onOpenFull }: { employee: any; onOpenFull: () => void }) {
  const today = todayDhaka()
  const [from, setFrom] = useState(minusDaysIso(today, 6))
  const [to, setTo] = useState(today)
  const [replayDate, setReplayDate] = useState<string | null>(null)

  // Fetch visit history for employee in range
  const { data, loading } = useApi<any>("fieldforce.history", {
    employeeId: employee.id,
    from,
    to,
  })

  // Replay hitmap data when date is clicked
  const { data: hitmapData, loading: hitmapLoading } = useApi<any>(
    replayDate ? "fieldforce.hitmap" : null,
    replayDate ? { employeeId: employee.id, date: replayDate } : {}
  )

  const s = data?.summary || {}
  const rows: any[] = data?.rows || []

  // Markers for MapCanvas if replay is active
  const mapMarkers: MapMarker[] = useMemo(() => {
    if (!hitmapData) return []
    const markers: MapMarker[] = []
    const planned: any[] = hitmapData.planned || []
    const track: any[] = hitmapData.track || []

    // Planned stops
    planned.forEach((p, idx) => {
      if (p.lat != null && p.lng != null) {
        markers.push({
          id: `stop-${idx}`,
          latitude: p.lat,
          longitude: p.lng,
          popup: `<b>Stop #${idx + 1}: ${esc(p.locationName || "Client")}</b><br/>Status: ${esc(p.visitStatus || "PLANNED")}`, // V4-001: escape DB strings
          circle: p.radiusM ? { radiusM: p.radiusM, color: "#0d9488" } : undefined,
        })
      }
    })

    // GPS track points
    track.forEach((t, idx) => {
      if (t.latitude != null && t.longitude != null) {
        markers.push({
          id: `track-${idx}`,
          latitude: t.latitude,
          longitude: t.longitude,
          lineGroup: "daily-track",
          popup: `GPS Ping: ${new Date(t.timestamp).toLocaleTimeString()}`,
        })
      }
    })

    return markers
  }, [hitmapData])

  return (
    <div className="space-y-4">
      {/* Dynamic Date Range Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 bg-white dark:bg-slate-900 p-2.5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-2xs">
        <div className="flex items-center gap-2 text-xs">
          <Label className="text-xs font-medium text-slate-500">Range:</Label>
          <Input
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
            className="h-8 w-[130px] text-xs"
          />
          <span className="text-slate-400">→</span>
          <Input
            type="date"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
            className="h-8 w-[130px] text-xs"
          />
        </div>

        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs px-2"
            onClick={() => { setFrom(minusDaysIso(today, 6)); setTo(today) }}
          >
            Last 7 Days
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs px-2"
            onClick={() => { setFrom(today); setTo(today) }}
          >
            Today
          </Button>
        </div>
      </div>

      {/* KPI Stats Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3">
          <p className="text-[10px] uppercase font-semibold text-slate-400">Planned Stops</p>
          <p className="text-lg font-bold text-slate-900 dark:text-white tabular-nums mt-0.5">
            {loading ? "…" : s.planned || 0}
          </p>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3">
          <p className="text-[10px] uppercase font-semibold text-emerald-600">Completed Stops</p>
          <p className="text-lg font-bold text-emerald-600 dark:text-emerald-400 tabular-nums mt-0.5">
            {loading ? "…" : s.completed || 0}
          </p>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3">
          <p className="text-[10px] uppercase font-semibold text-rose-500">Missed Visits</p>
          <p className="text-lg font-bold text-rose-600 dark:text-rose-400 tabular-nums mt-0.5">
            {loading ? "…" : s.missed || 0}
          </p>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3">
          <p className="text-[10px] uppercase font-semibold text-blue-500">GPS Pings</p>
          <p className="text-lg font-bold text-blue-600 dark:text-blue-400 tabular-nums mt-0.5">
            {loading ? "…" : s.gpsPings || 0}
          </p>
        </div>
      </div>

      {/* Map Replay Box (If selected) */}
      {replayDate && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3.5 space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-bold text-slate-800 dark:text-slate-200 uppercase tracking-wider flex items-center gap-1.5">
              <Route className="h-3.5 w-3.5 text-rose-600" /> GPS Replay — {fmtDate(replayDate)}
            </h4>
            <Button size="sm" variant="ghost" onClick={() => setReplayDate(null)} className="h-6 text-xs px-2 text-rose-600">
              Close Replay
            </Button>
          </div>

          {hitmapLoading ? (
            <div className="py-12 text-center text-xs text-slate-400">Loading map route…</div>
          ) : (
            <div className="h-64 w-full rounded-lg overflow-hidden border border-slate-200 dark:border-slate-800">
              <MapCanvas markers={mapMarkers} className="h-full w-full" />
            </div>
          )}
        </div>
      )}

      {/* Visit Records Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-2xs">
        <div className="p-3.5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
          <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200 uppercase tracking-wider flex items-center gap-1.5">
            <MapPin className="h-3.5 w-3.5 text-rose-600" /> Field Activity History
          </h3>
          <span className="text-[11px] text-slate-400">{rows.length} active day(s)</span>
        </div>

        {loading ? (
          <div className="py-8 text-center text-xs text-slate-400">Loading field visits…</div>
        ) : rows.length === 0 ? (
          <div className="py-8 text-center text-xs text-slate-400">
            No field force visits or tracking pings recorded in this date range.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50/80 dark:bg-slate-800/60">
                  <TableHead className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">Date</TableHead>
                  <TableHead className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 text-right">Planned</TableHead>
                  <TableHead className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 text-right">Completed</TableHead>
                  <TableHead className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 text-right">Missed</TableHead>
                  <TableHead className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 text-right">Pings</TableHead>
                  <TableHead className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r: any) => (
                  <TableRow key={r.date} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40">
                    <TableCell className="text-xs font-medium text-slate-800 dark:text-slate-200 tabular-nums">
                      {fmtDate(r.date)}
                    </TableCell>
                    <TableCell className="text-xs text-right tabular-nums text-slate-600 dark:text-slate-300">
                      {r.planned || 0}
                    </TableCell>
                    <TableCell className="text-xs text-right font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                      {r.completed || 0}
                    </TableCell>
                    <TableCell className="text-xs text-right font-bold tabular-nums text-rose-600 dark:text-rose-400">
                      {r.missed || 0}
                    </TableCell>
                    <TableCell className="text-xs text-right tabular-nums text-slate-500">
                      {r.gpsPings || "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant={replayDate === r.date ? "default" : "outline"}
                        className="h-7 text-xs px-2"
                        onClick={() => setReplayDate(replayDate === r.date ? null : r.date)}
                      >
                        <Route className="h-3 w-3 mr-1" />
                        {replayDate === r.date ? "Viewing" : "Hit Map"}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  )
}
