"use client"
// ============ Dashboard widget library ============
// Every widget's CONTENT lives here as a plain component. The registry
// (registry.tsx) wires them up with titles, icons, gates and default sizes.
// Data comes from the shared WidgetCtx (dashboard.stats payload) or from the
// widget's own RPC for self-scoped feeds (tasks / announcements / cameras).
import { useEffect, useState } from "react"
import dynamic from "next/dynamic"
import {
  Users, UserX, Clock, Wallet, Banknote, Receipt, TrendingUp,
  Cake, Sparkles, AlertTriangle, FileWarning, LogOut, Plus, CalendarDays, Plane, BadgeCheck,
  ChevronRight, Timer, Landmark, Cctv, ListChecks, Megaphone, ArrowUpRight, CircleDot,
  FileUp, FileSignature, Building2, ShoppingCart, Boxes, ClipboardList, ShieldCheck,
  Activity, MonitorSmartphone, CreditCard, PackageCheck, PackageOpen,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { useApi, rpc } from "../api"
import { StatCard, fmtMoney, fmtDate, titleCase } from "../shared/ui-kit"
import type { WidgetCtx } from "./types"

// ---- lazy chart loaders (recharts stays out of the first paint — L-5) ----
const chartLoading = () => <div className="h-[190px] rounded-lg bg-muted/60 animate-pulse" />
const HeadcountTrendChart = dynamic(() => import("./chart-widgets").then((m) => ({ default: m.HeadcountTrendChart })), { ssr: false, loading: chartLoading })
const BranchBarsChart = dynamic(() => import("./chart-widgets").then((m) => ({ default: m.BranchBarsChart })), { ssr: false, loading: chartLoading })
const PayrollTrendChart = dynamic(() => import("./chart-widgets").then((m) => ({ default: m.PayrollTrendChart })), { ssr: false, loading: chartLoading })
const DonutChart = dynamic(() => import("./chart-widgets").then((m) => ({ default: m.DonutChart })), { ssr: false, loading: chartLoading })
const DepartmentBars = dynamic(() => import("./chart-widgets").then((m) => ({ default: m.DepartmentBars })), { ssr: false, loading: chartLoading })
const DesignationList = dynamic(() => import("./chart-widgets").then((m) => ({ default: m.DesignationList })), { ssr: false, loading: chartLoading })
const RateRing = dynamic(() => import("./chart-widgets").then((m) => ({ default: m.RateRing })), { ssr: false, loading: chartLoading })
const CameraDashboardCharts = dynamic(() => import("../views/camera-dashboard-charts").then((m) => ({ default: m.CameraDashboardCharts })), {
  ssr: false,
  loading: () => <div className="h-[240px] rounded-lg bg-muted/60 animate-pulse" />,
})

// ============ shared widget atoms ============

function MiniStat({ label, value, total, tone }: { label: string; value: number; total: number; tone: string }) {
  const tones: Record<string, string> = {
    emerald: "text-emerald-700 dark:text-emerald-400 bg-emerald-500/10",
    amber: "text-amber-700 dark:text-amber-400 bg-amber-500/10",
    orange: "text-orange-700 dark:text-orange-400 bg-orange-500/10",
    rose: "text-rose-700 dark:text-rose-400 bg-rose-500/10",
    teal: "text-teal-700 dark:text-teal-400 bg-teal-500/10",
  }
  return (
    <div className={`rounded-lg p-2 ${tones[tone]}`}>
      <p className="text-[10px] font-medium uppercase tracking-wide opacity-80">{label}</p>
      <p className="text-lg font-bold tabular-nums leading-6">{value}</p>
      <p className="text-[10px] opacity-60">of {total}</p>
    </div>
  )
}

function Row({ icon: Icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <span className="text-muted-foreground truncate">{label}</span>
      <span className="ml-auto font-bold tabular-nums text-slate-800 dark:text-slate-100">{value}</span>
    </div>
  )
}

export function AlertRow({ icon: Icon, text, action, tone }: { icon: any; text: string; action?: () => void; tone?: string }) {
  // WCAG-conscious tones: 800-weight text on tinted backgrounds (≥4.5:1)
  const tones: Record<string, string> = {
    amber: "text-amber-800 dark:text-amber-300 bg-amber-500/15",
    rose: "text-rose-800 dark:text-rose-300 bg-rose-500/15",
    violet: "text-violet-800 dark:text-violet-300 bg-violet-500/15",
    slate: "text-slate-700 dark:text-slate-300 bg-muted",
  }
  return (
    <button onClick={action} disabled={!action}
      className={`w-full flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${tone ? tones[tone] : "text-slate-600 dark:text-slate-300 bg-muted"} ${action ? "hover:brightness-95" : "cursor-default"}`}>
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate flex-1">{text}</span>
      {action && <ChevronRight className="h-3 w-3 shrink-0 opacity-50" />}
    </button>
  )
}

function WidgetEmpty({ text }: { text: string }) {
  return <p className="text-xs text-muted-foreground py-6 text-center">{text}</p>
}

// ============ Overview widgets ============

export function QuickActionsWidget({ navigate, can }: WidgetCtx) {
  // 2026-10 expansion — the quick-action bar now covers the complete HRM
  // feature set (people, time, pay, operations, communication, insights).
  // Every action is permission-gated; hidden modules are respected by the
  // widget-level module gate plus these per-action permission checks.
  const actions: { label: string; icon: any; onClick: () => void; perm?: boolean }[] = [
    { label: "Add Employee", icon: Plus, onClick: () => navigate("employees", { add: true }), perm: can("employees", "create") },
    { label: "Bulk Import", icon: FileUp, onClick: () => navigate("employees", { import: true }), perm: can("employees", "create") },
    { label: "Mark Attendance", icon: Clock, onClick: () => navigate("attendance"), perm: can("attendance", "create") },
    { label: "Device Sync", icon: MonitorSmartphone, onClick: () => navigate("attendance", { tab: "devices" }), perm: can("devices", "view") },
    { label: "Leave Request", icon: Plane, onClick: () => navigate("leave"), perm: can("leave", "view") },
    { label: "Overtime", icon: Timer, onClick: () => navigate("overtime"), perm: can("attendance", "view") },
    { label: "Generate Payroll", icon: Wallet, onClick: () => navigate("payroll"), perm: can("payroll", "create") },
    { label: "Payslips", icon: CreditCard, onClick: () => navigate("payroll", { tab: "payslips" }), perm: can("payroll", "view") },
    { label: "Loans & Advances", icon: Landmark, onClick: () => navigate("loans"), perm: can("loans", "view") },
    { label: "Expense Claims", icon: Receipt, onClick: () => navigate("expenses"), perm: can("expenses", "view") },
    { label: "Issue HR Letter", icon: FileSignature, onClick: () => navigate("documents", { tab: "issue" }), perm: can("letters", "generate") },
    { label: "Compose Email/SMS", icon: Megaphone, onClick: () => navigate("communication"), perm: can("communication", "create") },
    { label: "Announcement", icon: Megaphone, onClick: () => navigate("announcements"), perm: can("announcements", "create") },
    { label: "New Task", icon: ClipboardList, onClick: () => navigate("tasks", { create: true }), perm: can("tasks", "create") },
    { label: "Performance", icon: TrendingUp, onClick: () => navigate("performance"), perm: can("performance", "view") },
    { label: "Add Branch", icon: Building2, onClick: () => navigate("organization", { tab: "branches" }), perm: can("organization", "create") },
    { label: "Procurement", icon: ShoppingCart, onClick: () => navigate("procurement"), perm: can("procurement", "view") },
    { label: "Inventory", icon: Boxes, onClick: () => navigate("inventory"), perm: can("inventory", "view") },
    { label: "HR Calendar", icon: CalendarDays, onClick: () => navigate("calendar") },
    { label: "Approvals", icon: BadgeCheck, onClick: () => navigate("approvals"), perm: can("approvals", "view") },
    { label: "Reports", icon: Activity, onClick: () => navigate("reports"), perm: can("reports", "view") },
    { label: "HR Settings", icon: Sparkles, onClick: () => navigate("settings"), perm: can("settings", "view") },
  ]
  const visible = actions.filter((a) => a.perm !== false)
  if (visible.length === 0) return <WidgetEmpty text="No quick actions available for your role." />
  return (
    <div className="flex flex-wrap gap-1.5">
      {visible.map((a) => (
        <Button key={a.label} size="sm" variant="outline" onClick={a.onClick} className="h-8 text-xs">
          <a.icon className="h-3.5 w-3.5 text-primary" /> {a.label}
        </Button>
      ))}
    </div>
  )
}

export function WorkforceKpisWidget({ data, navigate }: WidgetCtx) {
  const { workforce } = data
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2.5">
      <StatCard label="Total Employees" value={workforce.total} icon={Users} tone="emerald" onClick={() => navigate("employees")} sub={`${workforce.active} active`} />
      <StatCard label="Probation" value={workforce.probation} icon={Timer} tone="amber" sub="confirmation due soon" onClick={() => navigate("employees", { status: "PROBATION" })} />
      {/* M-8 — every workforce stat-card drills into a FILTERED directory list */}
      <StatCard label="On Leave" value={workforce.onLeave} icon={Plane} tone="sky" sub="currently away" onClick={() => navigate("employees", { status: "ON_LEAVE" })} />
      <StatCard label="New Joiners (30d)" value={workforce.newJoiners30} icon={Sparkles} tone="violet" sub="welcome aboard" onClick={() => navigate("employees")} />
      <StatCard label="Resigned" value={workforce.resigned} icon={LogOut} tone="slate" sub="exited employees" onClick={() => navigate("employees", { status: "RESIGNED" })} />
      <StatCard label="Terminated" value={workforce.terminated} icon={UserX} tone="rose" sub="this vendor" />
    </div>
  )
}

// ============ Time & attendance widgets ============

export function AttendanceTodayWidget({ data, navigate }: WidgetCtx) {
  const { workforce, attendanceToday } = data
  return (
    <div>
      <div className="grid grid-cols-3 sm:grid-cols-5 gap-2.5 mb-3.5">
        <MiniStat label="Present" value={attendanceToday.present} total={workforce.total} tone="emerald" />
        <MiniStat label="Late" value={attendanceToday.late} total={workforce.total} tone="amber" />
        <MiniStat label="On Leave" value={attendanceToday.leave} total={workforce.total} tone="orange" />
        <MiniStat label="Absent" value={attendanceToday.absent} total={workforce.total} tone="rose" />
        <MiniStat label="WFH / Trip" value={attendanceToday.wfh + attendanceToday.businessTrip} total={workforce.total} tone="teal" />
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Attendance rate today</span>
          <button onClick={() => navigate("attendance")} className="font-bold text-primary tabular-nums hover:underline">{attendanceToday.rate}%</button>
        </div>
        <Progress value={attendanceToday.rate} className="h-1.5" />
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground pt-0.5">
          <span>Early leave: <b className="text-slate-700 dark:text-slate-300">{attendanceToday.earlyLeave}</b></span>
          <span>Half day: <b className="text-slate-700 dark:text-slate-300">{attendanceToday.halfDay}</b></span>
          <span>Overtime today: <b className="text-slate-700 dark:text-slate-300">{attendanceToday.overtime}</b></span>
          <span>Marked records: <b className="text-slate-700 dark:text-slate-300">{attendanceToday.marked}</b></span>
        </div>
      </div>
    </div>
  )
}

export function AttendanceRateWidget({ data }: WidgetCtx) {
  const { attendanceToday, workforce } = data
  return (
    <RateRing rate={attendanceToday.rate} label="present" sub={`${attendanceToday.present} present · ${attendanceToday.absent} absent · ${workforce.active} active`} />
  )
}

// ============ Payroll & finance widgets ============

export function PayrollSummaryWidget({ data, navigate }: WidgetCtx) {
  const { payroll, loan } = data
  return (
    <div className="space-y-2 text-sm">
      <Row icon={Banknote} label={`Gross (${payroll.period})`} value={fmtMoney(payroll.gross)} />
      <Row icon={Wallet} label="Net disbursed" value={fmtMoney(payroll.net)} />
      <Row icon={Receipt} label="Deductions + AIT" value={fmtMoney(payroll.deductions)} />
      <Row icon={TrendingUp} label="Overtime cost" value={fmtMoney(payroll.overtime)} />
      <Row icon={Sparkles} label="Bonus / commission" value={fmtMoney(payroll.bonus)} />
      <Row icon={Landmark} label="Loan outstanding" value={fmtMoney(loan.outstanding)} />
      <div className="pt-1.5 border-t space-y-1">
        <AlertRow icon={BadgeCheck} text={`${payroll.pendingApproval} run(s) awaiting approval`} action={() => navigate("approvals")} />
        <AlertRow icon={Wallet} text={`${payroll.pendingPayment} run(s) awaiting payment`} action={() => navigate("payroll")} />
      </div>
    </div>
  )
}

// ============ Chart widgets ============

export function HeadcountTrendWidget({ data }: WidgetCtx) {
  return <HeadcountTrendChart data={data.headcountTrend} />
}

export function BranchDistributionWidget({ data, navigate }: WidgetCtx) {
  return <BranchBarsChart data={data.byBranch} onBarClick={() => navigate("employees")} />
}

export function PayrollTrendWidget({ data }: WidgetCtx) {
  return <PayrollTrendChart data={data.payrollTrend} fmtMoney={fmtMoney} />
}

export function DepartmentDistributionWidget({ data, navigate }: WidgetCtx) {
  const sorted = [...data.byDepartment].sort((a: any, b: any) => b.value - a.value)
  return <DepartmentBars data={sorted} onClick={() => navigate("employees")} />
}

export function EmploymentTypeWidget({ data }: WidgetCtx) {
  return (
    <div>
      <DonutChart data={data.byEmploymentType} />
      <div className="flex flex-wrap gap-x-3 gap-y-1 justify-center">
        {data.byEmploymentType.map((g: any, i: number) => (
          <span key={g.name} className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
            <span className="h-2 w-2 rounded-full" style={{ background: ["#059669", "#0d9488", "#6366f1", "#f59e0b", "#ec4899", "#64748b"][i % 6] }} />
            {g.name} <b className="tabular-nums text-slate-700 dark:text-slate-200">{g.value}</b>
          </span>
        ))}
      </div>
    </div>
  )
}

export function GenderSplitWidget({ data }: WidgetCtx) {
  return (
    <div>
      <DonutChart data={data.byGender} offset={3} />
      <div className="flex flex-wrap gap-x-3 gap-y-1 justify-center">
        {data.byGender.map((g: any, i: number) => (
          <span key={g.name} className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
            <span className="h-2 w-2 rounded-full" style={{ background: ["#ec4899", "#0d9488", "#f59e0b"][i % 3] }} />
            {g.name} <b className="tabular-nums text-slate-700 dark:text-slate-200">{g.value}</b>
          </span>
        ))}
      </div>
    </div>
  )
}

export function DesignationTopWidget({ data }: WidgetCtx) {
  return <DesignationList data={data.byDesignation} />
}

// ============ People & culture widgets ============

export function BirthdaysWidget({ data }: WidgetCtx) {
  const { todayBirthdays, upcomingBirthdays, anniversaries } = data
  return (
    <div className="space-y-1.5">
      {todayBirthdays.length === 0 && anniversaries.length === 0 && upcomingBirthdays.length === 0 && (
        <WidgetEmpty text="No celebrations this week." />
      )}
      {todayBirthdays.map((b: any) => (
        <div key={b.id} className="flex items-center gap-2.5 rounded-lg bg-pink-500/10 p-2">
          <Cake className="h-4 w-4 text-pink-500 shrink-0" />
          <div className="min-w-0">
            <p className="text-xs font-semibold text-slate-800 dark:text-slate-100 truncate">Happy Birthday, {b.name.split(" ")[0]}!</p>
            <p className="text-[10px] text-muted-foreground">Celebrating today</p>
          </div>
        </div>
      ))}
      {anniversaries.map((a: any) => (
        <div key={a.id} className="flex items-center gap-2.5 rounded-lg bg-amber-500/10 p-2">
          <Sparkles className="h-4 w-4 text-amber-500 shrink-0" />
          <div className="min-w-0">
            <p className="text-xs font-semibold text-slate-800 dark:text-slate-100 truncate">
              {a.years > 0 ? `Happy ${a.years}${a.years === 1 ? "st" : a.years === 2 ? "nd" : a.years === 3 ? "rd" : "th"} Work Anniversary, ${a.name.split(" ")[0]}!` : `${a.name} joined this month`}
            </p>
            <p className="text-[10px] text-muted-foreground">Work anniversary today</p>
          </div>
        </div>
      ))}
      {upcomingBirthdays.slice(0, 4).map((b: any) => (
        <div key={b.id} className="flex items-center gap-2 text-xs text-muted-foreground px-1">
          <Cake className="h-3.5 w-3.5 text-muted-foreground/50" />
          <span className="truncate">{b.name}</span>
          <span className="ml-auto text-[10px] tabular-nums">{fmtDate(b.date)}</span>
        </div>
      ))}
    </div>
  )
}

// ============ Compliance & alerts widgets ============

export function PendingApprovalsWidget({ data, can, navigate }: WidgetCtx) {
  const { pending } = data
  const total = Object.values(pending).reduce((s: number, v: any) => s + v, 0)
  return (
    <div className="space-y-1.5">
      {pending.leave > 0 && can("leave", "view") && <AlertRow icon={Plane} text={`${pending.leave} leave request(s) pending`} action={() => navigate("leave")} />}
      {pending.loans + pending.advances > 0 && <AlertRow icon={Landmark} text={`${pending.loans + pending.advances} loan / advance request(s)`} action={() => navigate("loans")} />}
      {pending.expenses > 0 && <AlertRow icon={Receipt} text={`${pending.expenses} expense claim(s) pending`} action={() => navigate("expenses")} />}
      {pending.attendanceCorrections > 0 && <AlertRow icon={Clock} text={`${pending.attendanceCorrections} attendance correction(s)`} action={() => navigate("attendance")} />}
      {pending.resignations > 0 && <AlertRow icon={LogOut} text={`${pending.resignations} resignation(s) in review`} action={() => navigate("exit")} />}
      {total === 0 && <WidgetEmpty text="All clear — no pending requests." />}
    </div>
  )
}

export function AlertsWidget({ data, navigate }: WidgetCtx) {
  const { repeatedLate, longAbsence, missingAttendance, loanInstallmentsDue, performanceReviewDue, expiringDocs, contractExpiry, probationCompletion, noticePeriod } = data
  const total = repeatedLate.length + longAbsence.length + expiringDocs.length + contractExpiry.length + (missingAttendance || []).length + (loanInstallmentsDue || []).length + (performanceReviewDue || []).length
  return (
    <div className="space-y-1.5">
      {repeatedLate.slice(0, 2).map((r: any) => <AlertRow key={r.employeeId} icon={AlertTriangle} text={`${r.name} — late ${r.count}× this month`} tone="amber" action={() => navigate("employees")} />)}
      {longAbsence.slice(0, 2).map((r: any) => <AlertRow key={r.employeeId} icon={UserX} text={`${r.name} — absent ${r.count} day(s)`} tone="rose" action={() => navigate("employees")} />)}
      {(missingAttendance || []).slice(0, 3).map((m: any) => <AlertRow key={`miss-${m.id}`} icon={UserX} text={`${m.name} — no attendance marked today`} tone="amber" action={() => navigate("attendance")} />)}
      {(loanInstallmentsDue || []).slice(0, 2).map((l: any) => <AlertRow key={`li-${l.loanId}-${l.no}`} icon={Landmark} text={`${l.employeeName} — loan installment ${fmtMoney(l.amount)} due ${fmtDate(l.dueDate)}`} tone="amber" action={() => navigate("loans")} />)}
      {(performanceReviewDue || []).slice(0, 2).map((c: any) => <AlertRow key={`rd-${c.id}`} icon={Timer} text={`Review cycle "${c.name}" ends ${fmtDate(c.endDate)}`} tone="violet" action={() => navigate("performance")} />)}
      {expiringDocs.slice(0, 3).map((d: any) => <AlertRow key={d.id} icon={FileWarning} text={`${d.name} — ${titleCase(d.docType)} expires ${fmtDate(d.expiryDate)}`} tone="amber" action={() => navigate("employees", { employeeId: d.employeeId })} />)}
      {contractExpiry.slice(0, 2).map((c: any) => <AlertRow key={c.id} icon={FileWarning} text={`${c.name} — contract ends ${fmtDate(c.contractEnd)}`} tone="rose" action={() => navigate("employees", { employeeId: c.id })} />)}
      {probationCompletion.slice(0, 2).map((p: any) => <AlertRow key={p.id} icon={Timer} text={`${p.name} — probation completes soon`} tone="violet" action={() => navigate("employees", { employeeId: p.id })} />)}
      {noticePeriod.slice(0, 2).map((n: any) => <AlertRow key={n.id} icon={LogOut} text={`${n.name} — LWD ${fmtDate(n.lwd)} (${titleCase(n.mode)})`} tone="slate" action={() => navigate("exit")} />)}
      {total === 0 && <WidgetEmpty text="No active alerts." />}
    </div>
  )
}

// ============ Camera widget (Phase 7.1) ============

export function CameraStatusWidget({ navigate }: WidgetCtx) {
  const { data, loading } = useApi<{ cameras: any[]; counts: { ONLINE: number; OFFLINE: number; UNKNOWN: number; total: number } }>("camera.list", {})
  if (loading || !data) return <div className="h-[200px] rounded-lg bg-muted/60 animate-pulse" />
  if (data.counts.total === 0) return <WidgetEmpty text="No cameras configured yet." />

  // Compute per-brand breakdown client-side
  const byBrand = Object.entries(
    data.cameras.reduce((acc: Record<string, number>, c: any) => {
      acc[c.brand] = (acc[c.brand] || 0) + 1
      return acc
    }, {}),
  ).map(([brand, count]) => ({ brand, count }))

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-4 gap-2">
        <StatCard label="Total" value={data.counts.total} icon={Cctv} tone="slate" />
        <StatCard label="Online" value={data.counts.ONLINE} icon={Cctv} tone="emerald" />
        <StatCard label="Offline" value={data.counts.OFFLINE} icon={Cctv} tone="rose" />
        <StatCard label="Unknown" value={data.counts.UNKNOWN} icon={AlertTriangle} tone="amber" />
      </div>
      <CameraDashboardCharts counts={data.counts} byBrand={byBrand} />
      <Button size="sm" variant="outline" className="w-full h-7 text-xs" onClick={() => navigate("cameras")}>
        Open Camera Manager <ArrowUpRight className="h-3 w-3" />
      </Button>
    </div>
  )
}

// ============ My tasks widget (self-scoped feed) ============

export function MyTasksWidget({ navigate }: WidgetCtx) {
  const [tasks, setTasks] = useState<any[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    // self-scoped: without tasks.view the server returns only the caller's
    // own assignments; with it, created/department tasks are included
    rpc<any>("tasks.list", { mine: true })
      .then((d) => { if (!cancelled) setTasks((d || []).slice(0, 6)) })
      .catch((e) => { if (!cancelled) setError(e?.message || "Failed to load tasks") })
    return () => { cancelled = true }
  }, [])

  if (error) return <WidgetEmpty text={error} />
  if (!tasks) return <div className="space-y-2 p-1">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-7 rounded bg-muted/60 animate-pulse" />)}</div>
  const open = tasks.filter((t) => !["COMPLETED", "CLOSED"].includes(t.status))
  if (open.length === 0) return (
    <div className="py-4 text-center">
      <p className="text-xs text-muted-foreground">No open tasks assigned to you.</p>
      <Button size="sm" variant="outline" className="h-7 text-xs mt-2" onClick={() => navigate("tasks")}>View Task Board</Button>
    </div>
  )
  const dueTone = (d?: string | null) => (d && d < new Date().toLocaleDateString("en-CA") ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground")
  return (
    <div className="space-y-1">
      {open.map((t) => (
        <button key={t.id} onClick={() => navigate("tasks", { taskId: t.id })}
          className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent transition-colors group focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          <CircleDot className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
          <span className="text-xs font-medium truncate flex-1 group-hover:text-foreground">{t.title}</span>
          <span className={`text-[10px] tabular-nums shrink-0 ${dueTone(t.dueDate)}`}>{t.dueDate ? fmtDate(t.dueDate) : "—"}</span>
        </button>
      ))}
      <button onClick={() => navigate("tasks")} className="w-full text-[11px] text-primary hover:underline pt-1">View all tasks <ChevronRight className="inline h-3 w-3" /></button>
    </div>
  )
}

// ============ Announcements widget (company feed) ============

export function AnnouncementsWidget({ navigate }: WidgetCtx) {
  const [items, setItems] = useState<any[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    rpc<any>("announcements.list", {})
      .then((d) => { if (!cancelled) setItems((d || []).slice(0, 5)) })
      .catch((e) => { if (!cancelled) setError(e?.message || "Failed to load announcements") })
    return () => { cancelled = true }
  }, [])

  if (error) return <WidgetEmpty text={error} />
  if (!items) return <div className="space-y-2 p-1">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-8 rounded bg-muted/60 animate-pulse" />)}</div>
  if (items.length === 0) return <WidgetEmpty text="No announcements published yet." />
  return (
    <div className="space-y-1">
      {items.map((a) => (
        <button key={a.id} onClick={() => navigate("announcements")}
          className="w-full flex items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent transition-colors group focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          <Megaphone className={`h-3.5 w-3.5 mt-0.5 shrink-0 ${a.pinned ? "text-amber-500" : "text-muted-foreground/60"}`} />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium truncate group-hover:text-foreground">{a.title}</p>
            <p className="text-[10px] text-muted-foreground truncate">{fmtDate(a.createdAt)} · {a.audience || "All Employees"}</p>
          </div>
          {a.pinned && <span className="text-[9px] font-bold uppercase text-amber-600 dark:text-amber-400 shrink-0 mt-0.5">Pinned</span>}
        </button>
      ))}
      <button onClick={() => navigate("announcements")} className="w-full text-[11px] text-primary hover:underline pt-1">All announcements <ChevronRight className="inline h-3 w-3" /></button>
    </div>
  )
}

// ==================================================================================
// 2026-10 dashboard expansion — widgets covering the complete HRM feature set.
// Feed-style widgets default to rowSpan 2 (see registry); every widget
// declares its own permission / module / subscription gates there.
// ==================================================================================

// ---------- Time & Attendance ----------

/** Live punch feed — polls the lightweight attendance.liveFeed RPC and lists
 *  the newest recorded attendance events (device, mobile, admin). */
export function AttendanceLiveFeedWidget({ navigate }: WidgetCtx) {
  const [feed, setFeed] = useState<{ id: string; name: string; code: string; time: string; type: string; method: string }[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let lastId: string | null = null
    const load = async () => {
      try {
        const res = await rpc<any>("attendance.liveFeed", lastId ? { after: lastId } : {})
        if (cancelled) return
        if (res?.events?.length) lastId = res.events[0].id
        setFeed((res?.events || []).slice(0, 14))
        setError(null)
      } catch (e: any) {
        if (!cancelled) setError(e?.message || "Live feed unavailable")
      }
    }
    load()
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") load()
    }, 15_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])

  if (error) return <WidgetEmpty text={error} />
  if (!feed) return <div className="space-y-2 p-1">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-6 rounded bg-muted/60 animate-pulse" />)}</div>
  if (feed.length === 0) return <WidgetEmpty text="No attendance events recorded yet today." />
  const methodTone = (m: string) =>
    m === "DEVICE_PUNCH" || m === "BIOMETRIC" ? "text-emerald-600 dark:text-emerald-400"
    : m === "MOBILE" || m === "GEOFENCE" || m === "SELFIE" ? "text-cyan-600 dark:text-cyan-400"
    : "text-slate-500"
  return (
    <div className="space-y-0.5 -mx-1">
      {feed.map((e) => (
        <button key={e.id} onClick={() => navigate("attendance")}
          className="w-full flex items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-accent transition-colors group focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          <CircleDot className={`h-3 w-3 shrink-0 ${e.type === "CHECK_OUT" ? "text-rose-400" : "text-emerald-500"}`} />
          <span className="text-[11px] font-medium truncate flex-1 group-hover:text-foreground">{e.name}</span>
          <span className="text-[9px] text-muted-foreground shrink-0">{e.code}</span>
          <span className={`text-[9px] font-semibold shrink-0 ${methodTone(e.method)}`}>
            {e.type === "CHECK_OUT" ? "OUT" : "IN"}
          </span>
          <span className="text-[10px] tabular-nums text-muted-foreground shrink-0 w-11 text-right">{e.time}</span>
        </button>
      ))}
      <button onClick={() => navigate("attendance")} className="w-full text-[11px] text-primary hover:underline pt-1">
        Open attendance <ChevronRight className="inline h-3 w-3" />
      </button>
    </div>
  )
}

/** Approved leaves starting within the next 7 days. */
export function UpcomingLeavesWidget({ data, navigate }: WidgetCtx) {
  const rows = (data?.upcomingLeaves || []) as { id: string; name: string; type: string; fromDate: string; toDate: string; days: number }[]
  if (!rows.length) return <WidgetEmpty text="No approved leaves upcoming in the next 7 days." />
  return (
    <div className="space-y-1">
      {rows.slice(0, 7).map((l) => (
        <button key={l.id} onClick={() => navigate("leave")}
          className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent transition-colors group focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          <Plane className="h-3.5 w-3.5 text-cyan-500 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium truncate group-hover:text-foreground">{l.name}</p>
            <p className="text-[10px] text-muted-foreground">{l.type} · {l.days}d</p>
          </div>
          <span className="text-[10px] tabular-nums text-muted-foreground shrink-0">{fmtDate(l.fromDate)}</span>
        </button>
      ))}
      {rows.length > 7 && <p className="text-[10px] text-muted-foreground text-center pt-0.5">+{rows.length - 7} more</p>}
    </div>
  )
}

/** Overtime worked this month (total hours + employees). */
export function OvertimeMonthWidget({ data, navigate }: WidgetCtx) {
  const ot = data?.overtimeMonth || { minutes: 0, employees: 0 }
  const hours = Math.floor(ot.minutes / 60)
  const mins = ot.minutes % 60
  return (
    <div className="flex flex-col items-center justify-center h-full gap-1 py-1">
      <Timer className="h-5 w-5 text-amber-500" />
      <p className="text-2xl font-bold tabular-nums text-slate-800 dark:text-slate-100 leading-none">
        {hours}<span className="text-sm font-semibold text-muted-foreground">h</span> {mins}<span className="text-sm font-semibold text-muted-foreground">m</span>
      </p>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">overtime this month</p>
      <p className="text-[11px] text-muted-foreground">{ot.employees} employee(s) with OT</p>
      <button onClick={() => navigate("overtime")} className="text-[11px] text-primary hover:underline mt-0.5">Review overtime</button>
    </div>
  )
}

/** Attendance device fleet health (online/offline + last event). */
export function DeviceHealthWidget({ data, navigate }: WidgetCtx) {
  const d = data?.deviceHealth || { online: 0, offline: 0, total: 0, lastEventAt: null }
  if (!d.total) return <WidgetEmpty text="No attendance devices registered." />
  const pct = Math.round((d.online / d.total) * 100)
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="text-2xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400">{d.online}</span>
            <span className="text-xs text-muted-foreground">/ {d.total} online</span>
          </div>
          <Progress value={pct} className="h-1.5 mt-1.5" />
        </div>
        {d.offline > 0 && <Badge className="bg-rose-100 text-rose-700 text-[10px] shrink-0">{d.offline} offline</Badge>}
      </div>
      <div className="space-y-1">
        <Row icon={CircleDot} label="Last punch received" value={d.lastEventAt ? new Date(d.lastEventAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"} />
      </div>
      <Button size="sm" variant="outline" className="w-full h-7 text-xs" onClick={() => navigate("attendance", { tab: "syncMonitor" })}>
        Sync Monitor <ArrowUpRight className="h-3 w-3" />
      </Button>
    </div>
  )
}

// ---------- People ----------

/** New joiners in the last 30 days. */
export function NewJoinersWidget({ data, navigate }: WidgetCtx) {
  const rows = (data?.newJoiners || []) as { id: string; name: string; joiningDate: string; photoUrl?: string }[]
  if (!rows.length) return <WidgetEmpty text="No new joiners in the last 30 days." />
  return (
    <div className="space-y-1">
      {rows.slice(0, 6).map((j) => (
        <button key={j.id} onClick={() => navigate("employees", { employeeId: j.id })}
          className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent transition-colors group focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          <div className="h-6 w-6 rounded-full bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 flex items-center justify-center text-[9px] font-bold shrink-0">
            {j.name.split(" ").map((s) => s[0]).slice(0, 2).join("")}
          </div>
          <span className="text-xs font-medium truncate flex-1 group-hover:text-foreground">{j.name}</span>
          <span className="text-[10px] tabular-nums text-muted-foreground shrink-0">{fmtDate(j.joiningDate)}</span>
        </button>
      ))}
      {rows.length > 6 && <p className="text-[10px] text-muted-foreground text-center">+{rows.length - 6} more</p>}
    </div>
  )
}

/** Probation periods completing soon (action needed: confirm or extend). */
export function ProbationCompletionsWidget({ data, navigate }: WidgetCtx) {
  const rows = (data?.probationCompletion || []) as { id: string; name: string; joiningDate: string; probationMonths: number }[]
  if (!rows.length) return <WidgetEmpty text="No probation completions due." />
  return (
    <div className="space-y-1">
      {rows.slice(0, 6).map((p) => (
        <AlertRow key={p.id} icon={Timer} text={`${p.name} — ${p.probationMonths}-month probation completes soon`} tone="violet" action={() => navigate("employees", { employeeId: p.id })} />
      ))}
    </div>
  )
}

/** Active notice periods (exit pipeline). */
export function ExitNoticesWidget({ data, navigate }: WidgetCtx) {
  const rows = (data?.noticePeriod || []) as { id: string; name: string; lwd: string; mode: string }[]
  if (!rows.length) return <WidgetEmpty text="No employees currently serving notice." />
  return (
    <div className="space-y-1">
      {rows.slice(0, 6).map((n) => (
        <AlertRow key={n.id} icon={LogOut} text={`${n.name} — LWD ${fmtDate(n.lwd)} (${titleCase(n.mode || "notice")})`} tone="slate" action={() => navigate("exit")} />
      ))}
    </div>
  )
}

// ---------- Payroll & Finance ----------

/** Loan installments falling due within the next 7 days. */
export function LoanInstallmentsWidget({ data, navigate }: WidgetCtx) {
  const rows = (data?.loanInstallmentsDue || []) as { loanId: string; employeeName: string; no: number; amount: number; dueDate: string }[]
  if (!rows.length) return <WidgetEmpty text="No loan installments due in the next 7 days." />
  const total = rows.reduce((s, r) => s + r.amount, 0)
  return (
    <div className="space-y-1">
      {rows.slice(0, 6).map((l) => (
        <AlertRow key={`${l.loanId}-${l.no}`} icon={Landmark} text={`${l.employeeName} — installment ${l.no} · ${fmtMoney(l.amount)} · ${fmtDate(l.dueDate)}`} tone="amber" action={() => navigate("loans")} />
      ))}
      {rows.length > 6 && <p className="text-[10px] text-muted-foreground text-center">+{rows.length - 6} more</p>}
      <div className="pt-1 border-t flex items-center justify-between text-xs">
        <span className="text-muted-foreground">Total due</span>
        <span className="font-bold tabular-nums text-slate-800 dark:text-slate-100">{fmtMoney(total)}</span>
      </div>
    </div>
  )
}

/** Pending expense claims at a glance. */
export function ExpenseSummaryWidget({ data, navigate }: WidgetCtx) {
  const e = data?.expensesMonth || { pendingCount: 0, pendingAmount: 0 }
  return (
    <div className="flex flex-col items-center justify-center h-full gap-1 py-1">
      <Receipt className="h-5 w-5 text-violet-500" />
      <p className="text-2xl font-bold tabular-nums text-slate-800 dark:text-slate-100 leading-none">{e.pendingCount}</p>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">expense claims pending</p>
      <p className="text-[11px] text-muted-foreground">{fmtMoney(e.pendingAmount)} claimed</p>
      <button onClick={() => navigate("expenses")} className="text-[11px] text-primary hover:underline mt-0.5">Review claims</button>
    </div>
  )
}

// ---------- Compliance & Alerts ----------

/** Expiring employee documents + contracts (compliance list). */
export function ExpiringDocumentsWidget({ data, navigate }: WidgetCtx) {
  const docs = (data?.expiringDocs || []) as { id: string; employeeId: string; name: string; docType: string; expiryDate: string }[]
  const contracts = (data?.contractExpiry || []) as { id: string; name: string; contractEnd: string }[]
  if (!docs.length && !contracts.length) return <WidgetEmpty text="No documents or contracts expiring soon." />
  return (
    <div className="space-y-1 overflow-y-auto scroll-thin">
      {docs.slice(0, 6).map((d) => (
        <AlertRow key={d.id} icon={FileWarning} text={`${d.name} — ${titleCase(d.docType)} expires ${fmtDate(d.expiryDate)}`} tone="amber" action={() => navigate("employees", { employeeId: d.employeeId })} />
      ))}
      {contracts.slice(0, 4).map((c) => (
        <AlertRow key={`c-${c.id}`} icon={FileWarning} text={`${c.name} — contract ends ${fmtDate(c.contractEnd)}`} tone="rose" action={() => navigate("employees", { employeeId: c.id })} />
      ))}
    </div>
  )
}

// ---------- Operations ----------

/** Performance review cycles ending soon. */
export function PerformanceReviewsWidget({ data, navigate }: WidgetCtx) {
  const rows = (data?.performanceReviewDue || []) as { id: string; name: string; endDate: string }[]
  if (!rows.length) return <WidgetEmpty text="No review cycles ending in the next 14 days." />
  return (
    <div className="space-y-1">
      {rows.map((c) => (
        <AlertRow key={c.id} icon={TrendingUp} text={`Review cycle "${c.name}" ends ${fmtDate(c.endDate)}`} tone="violet" action={() => navigate("performance")} />
      ))}
    </div>
  )
}

/** Low-stock inventory items (at/below reorder level). */
export function LowStockWidget({ data, navigate }: WidgetCtx) {
  const rows = (data?.lowStock || []) as { id: string; name: string; code: string; quantity: number; reorderLevel: number }[]
  if (!rows.length) return <WidgetEmpty text="No items at or below reorder level." />
  return (
    <div className="space-y-1">
      {rows.slice(0, 6).map((it) => (
        <AlertRow key={it.id} icon={Boxes} text={`${it.name} — ${it.quantity} left (reorder at ${it.reorderLevel})`} tone="amber" action={() => navigate("inventory")} />
      ))}
      {rows.length > 6 && <p className="text-[10px] text-muted-foreground text-center">+{rows.length - 6} more items low</p>}
    </div>
  )
}

/** Pending purchase requests in the procurement pipeline. */
export function PendingProcurementWidget({ data, navigate }: WidgetCtx) {
  const n = data?.pendingProcurement || 0
  return (
    <div className="flex flex-col items-center justify-center h-full gap-1 py-1">
      <ShoppingCart className="h-5 w-5 text-cyan-500" />
      <p className="text-2xl font-bold tabular-nums text-slate-800 dark:text-slate-100 leading-none">{n}</p>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">purchase requests in pipeline</p>
      <button onClick={() => navigate("procurement")} className="text-[11px] text-primary hover:underline mt-0.5">Open procurement</button>
    </div>
  )
}

// ---------- Platform ----------

/** Plan usage — employees / devices / storage against plan limits. */
export function PlanUsageWidget({ navigate }: WidgetCtx) {
  // WP-C (2026-10-08) — the widget now uses subscription.usage, the SAME data
  // source as the Subscription & Usage view and the Billing page UsagePanel
  // (per-limit {used, limit, pct, status}; warning ≥80% / danger ≥95%).
  const [info, setInfo] = useState<any>(null)
  const [usage, setUsage] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    Promise.all([
      rpc<any>("subscription.overview", {}),
      rpc<any>("subscription.usage", {}).catch(() => null),
    ])
      .then(([o, u]) => { if (!cancelled) { setInfo(o); setUsage(u) } })
      .catch((e) => { if (!cancelled) setError(e?.message || "Subscription unavailable") })
    return () => { cancelled = true }
  }, [])
  if (error) return <WidgetEmpty text={error} />
  if (!info) return <div className="space-y-2 p-1">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-6 rounded bg-muted/60 animate-pulse" />)}</div>
  const bar = (label: string, row: any, fmt: (n: number) => string) => {
    if (!row) return null
    const cap = row.limit
    const pct = cap != null ? Math.min(100, row.pct ?? 0) : 0
    const tone =
      row.status === "over" || row.status === "danger" ? "[&>div]:bg-rose-500"
      : row.status === "warning" ? "[&>div]:bg-amber-500"
      : "[&>div]:bg-emerald-500"
    return (
      <div key={label} className="space-y-1">
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-muted-foreground">{label}</span>
          <span className={`tabular-nums font-semibold ${row.status === "over" || row.status === "danger" ? "text-rose-600" : row.status === "warning" ? "text-amber-600" : "text-slate-700 dark:text-slate-200"}`}>
            {fmt(row.used)}{cap != null ? ` / ${fmt(cap)}` : " · unlimited"}
          </span>
        </div>
        {cap != null && <Progress value={pct} className={`h-1 ${tone}`} />}
      </div>
    )
  }
  const rows: Record<string, any> = {}
  for (const r of usage?.rows || []) rows[r.key] = r
  const gb = (n: number) => `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-indigo-500 shrink-0" />
        <p className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">{info.planName || (info.mode === "LEGACY" ? "Legacy workspace" : "Trial")}</p>
        {info.daysRemaining != null && (
          <Badge className={`text-[10px] shrink-0 ${info.daysRemaining <= 7 ? "bg-rose-100 text-rose-700" : "bg-emerald-100 text-emerald-700"}`}>
            {info.daysRemaining}d left
          </Badge>
        )}
      </div>
      {usage?.callout && usage.callout.status !== "ok" && (
        <p className={`text-[11px] rounded-md px-2 py-1 ${usage.callout.status === "over" ? "bg-rose-50 dark:bg-rose-950/40 text-rose-600" : "bg-amber-50 dark:bg-amber-950/40 text-amber-700"}`}>
          {usage.callout.message}
        </p>
      )}
      {bar("Employees", rows.EMPLOYEES, (n) => String(n))}
      {bar("Devices", rows.DEVICES, (n) => String(n))}
      {bar("Storage", rows.STORAGE, gb)}
      <Button size="sm" variant="outline" className="w-full h-7 text-xs" onClick={() => navigate("subscription")}>
        Subscription & usage <ArrowUpRight className="h-3 w-3" />
      </Button>
    </div>
  )
}

/** Recent audit trail entries. */
export function RecentAuditWidget({ navigate }: WidgetCtx) {
  const [items, setItems] = useState<any[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    rpc<any>("audit.list", { limit: 8 })
      .then((d) => { if (!cancelled) setItems(d?.items || []) })
      .catch((e) => { if (!cancelled) setError(e?.message || "Audit unavailable") })
    return () => { cancelled = true }
  }, [])
  if (error) return <WidgetEmpty text={error} />
  if (!items) return <div className="space-y-2 p-1">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-5 rounded bg-muted/60 animate-pulse" />)}</div>
  if (!items.length) return <WidgetEmpty text="No audit entries yet." />
  return (
    <div className="space-y-0.5 overflow-y-auto scroll-thin">
      {items.map((a) => (
        <button key={a.id} onClick={() => navigate("audit")}
          className="w-full flex items-start gap-2 rounded-md px-2 py-1 text-left hover:bg-accent transition-colors group focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          <ShieldCheck className="h-3 w-3 mt-0.5 text-slate-400 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] leading-snug truncate group-hover:text-foreground">{a.summary || a.action}</p>
            <p className="text-[9px] text-muted-foreground">{a.userName || "system"} · {new Date(a.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</p>
          </div>
        </button>
      ))}
    </div>
  )
}

/** Upcoming company calendar events (holidays, events, celebrations). */
export function UpcomingEventsWidget({ navigate }: WidgetCtx) {
  const [events, setEvents] = useState<{ date: string; kind: string; title: string; detail?: string }[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const now = new Date()
    rpc<any[]>("calendar.events", { month: now.getMonth() + 1, year: now.getFullYear() })
      .then((list) => {
        if (cancelled) return
        const today = now.toISOString().slice(0, 10)
        setEvents((list || []).filter((e) => e.date >= today).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 8))
      })
      .catch((e) => { if (!cancelled) setError(e?.message || "Calendar unavailable") })
    return () => { cancelled = true }
  }, [])
  if (error) return <WidgetEmpty text={error} />
  if (!events) return <div className="space-y-2 p-1">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-5 rounded bg-muted/60 animate-pulse" />)}</div>
  if (!events.length) return <WidgetEmpty text="Nothing scheduled for the rest of this month." />
  const iconOf = (kind: string) => kind === "HOLIDAY" ? CalendarDays : kind === "BIRTHDAY" ? Cake : kind === "ANNIVERSARY" ? Sparkles : CalendarDays
  return (
    <div className="space-y-1">
      {events.map((e, i) => {
        const Icon = iconOf(e.kind)
        return (
          <button key={`${e.date}-${i}`} onClick={() => navigate("calendar")}
            className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent transition-colors group focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
            <Icon className={`h-3.5 w-3.5 shrink-0 ${e.kind === "HOLIDAY" ? "text-rose-400" : e.kind === "BIRTHDAY" ? "text-violet-400" : e.kind === "ANNIVERSARY" ? "text-amber-400" : "text-cyan-400"}`} />
            <span className="text-xs font-medium truncate flex-1 group-hover:text-foreground">{e.title}</span>
            <span className="text-[10px] tabular-nums text-muted-foreground shrink-0">{fmtDate(e.date)}</span>
          </button>
        )
      })}
    </div>
  )
}

// re-export for the picker icon
export const WidgetIcons = { ListChecks, Megaphone }

// ---------- Operations — Wave 2 WP-K (assets) ----------

/** WP-K — asset fleet at a glance: status mix + outstanding handovers + the
 *  30-day warranty lead (the same window the daily reminder job uses).
 *  Self-scoped feed: fetches assets.stats (PlanUsageWidget pattern). */
export function AssetFleetWidget({ navigate }: WidgetCtx) {
  const [stats, setStats] = useState<{
    total: number; byStatus: Record<string, number>; outstandingAssignments: number
    warrantyExpiringSoon: number; warrantyExpired: number
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    rpc<typeof stats>("assets.stats", {})
      .then((d) => { if (!cancelled) setStats(d) })
      .catch((e) => { if (!cancelled) setError(e?.message || "Assets unavailable") })
    return () => { cancelled = true }
  }, [])
  if (error) return <WidgetEmpty text={error} />
  if (!stats) return <div className="space-y-2 p-1">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-5 rounded bg-muted/60 animate-pulse" />)}</div>
  const assigned = stats.byStatus?.ASSIGNED || 0
  const inStock = stats.byStatus?.IN_STOCK || 0
  const repair = stats.byStatus?.REPAIR || 0
  const lost = stats.byStatus?.LOST || 0
  return (
    <div className="space-y-1">
      <Row icon={Boxes} label="Total assets" value={String(stats.total)} />
      <Row icon={PackageCheck} label="Assigned now" value={String(assigned)} />
      <Row icon={PackageOpen} label="In stock · repair · lost" value={`${inStock} · ${repair} · ${lost}`} />
      {(stats.warrantyExpiringSoon > 0 || stats.warrantyExpired > 0) && (
        <AlertRow icon={AlertTriangle}
          text={`${stats.warrantyExpiringSoon} warranty${stats.warrantyExpiringSoon !== 1 ? "ies" : "y"} expiring ≤30d${stats.warrantyExpired ? ` · ${stats.warrantyExpired} already expired` : ""}`}
          tone="amber" action={() => navigate("assets")} />
      )}
      <Button size="sm" variant="outline" className="w-full h-7 text-xs" onClick={() => navigate("assets")}>
        Asset registry <ArrowUpRight className="h-3 w-3" />
      </Button>
    </div>
  )
}

/** WP-K — assets whose warranty expires within 30 days (nearest first),
 *  including who currently holds them. Self-scoped feed via assets.list. */
export function AssetWarrantyWidget({ navigate }: WidgetCtx) {
  const [rows, setRows] = useState<{ id: string; code: string; name: string; warrantyExpiry: string; currentAssignment: { employeeName: string } | null }[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const horizon = new Date()
    horizon.setDate(horizon.getDate() + 30)
    rpc<{ assets: { id: string; code: string; name: string; warrantyExpiry: string; currentAssignment: { employeeName: string } | null }[] }>(
      "assets.list", { warrantyExpiringBefore: horizon.toLocaleDateString("en-CA"), sortBy: "warranty", pageSize: 6 },
    )
      .then((res) => { if (!cancelled) setRows(res?.assets || []) })
      .catch((e) => { if (!cancelled) setError(e?.message || "Assets unavailable") })
    return () => { cancelled = true }
  }, [])
  if (error) return <WidgetEmpty text={error} />
  if (!rows) return <div className="space-y-2 p-1">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-5 rounded bg-muted/60 animate-pulse" />)}</div>
  if (!rows.length) return <WidgetEmpty text="No asset warranties expiring in the next 30 days." />
  return (
    <div className="space-y-1">
      {rows.slice(0, 6).map((a) => (
        <AlertRow key={a.id} icon={AlertTriangle}
          text={`${a.code} ${a.name} — warranty ${fmtDate(a.warrantyExpiry)}${a.currentAssignment ? ` · held by ${a.currentAssignment.employeeName}` : ""}`}
          tone="amber" action={() => navigate("assets")} />
      ))}
      {rows.length > 6 && <p className="text-[10px] text-muted-foreground text-center">+{rows.length - 6} more</p>}
    </div>
  )
}

