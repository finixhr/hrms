"use client"
// ============ Attendance & Shifts (spec §7) ============
// Daily mark grid, monthly register, shift definitions + roster, biometric
// devices with sync, geo-fence validation simulator and
// the attendance correction workflow. Late / early-leave / OT are always
// computed server-side against the employee's assigned shift.
import { useEffect, useMemo, useRef, useState } from "react"
import {
  BellRing, BellOff, CalendarDays, CheckCircle2, ClipboardCheck, Clock, Loader2, LogIn, LogOut,
  Pencil, Plus, Trash2, Users, XCircle,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useHrm } from "../store"
import { useApi, rpc, useEmployeeDirectory } from "../api"
import {
  PageHeader, RowButton, RowIconButton, SectionCard, SectionTabs, StatusBadge,
  fmtDate, minutesHHMM, titleCase,
} from "../shared/ui-kit"
import { DataTable, type Column } from "../shared/data-table"
import { ConfirmDialog, FormDialog, type FieldDef } from "../shared/form-dialog"
import { AdmsDevicesTab, AdmsEventsTab, AdmsUnknownTab, AdmsSyncTab } from "./attendance-devices"
import { punchAlertsMuted, setPunchAlertsMuted, PUNCH_ALERT_MUTE_EVENT } from "../shared/punch-alerts"
import LiveTrackingTab from "./tracking"
import AttendanceHistoryTab from "./attendance-history"
import SecurityEventsTab from "./attendance-security"
import GeofenceManagerTab from "./geofence-manager"
import AttendancePoliciesTab from "./attendance-policies"

// ---------- helpers ----------
function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}
function nowHHMM(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
const MARK_STATUSES = ["LEAVE", "HOLIDAY", "WEEKLY_OFF", "WFH", "BUSINESS_TRIP", "ABSENT"]
const WEEKLY_OFFS = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"]
// weeklyOff is stored as a comma list ("FRIDAY,SATURDAY") — format for display
const fmtWeeklyOff = (v?: string | null) =>
  v ? v.split(",").filter(Boolean).map((d) => titleCase(d)).join(" + ") : "—"

const CHIP_TONES: Record<string, string> = {
  emerald: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300",
  amber: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300",
  rose: "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/60 dark:text-rose-300",
  orange: "border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-900 dark:bg-orange-950/60 dark:text-orange-300",
  teal: "border-teal-200 bg-teal-50 text-teal-700 dark:border-teal-900 dark:bg-teal-950/60 dark:text-teal-300",
}
function StatChip({ label, value, tone }: { label: string; value: string | number; tone: keyof typeof CHIP_TONES }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs whitespace-nowrap ${CHIP_TONES[tone]}`}>
      <span className="opacity-80">{label}</span>
      <b className="tabular-nums">{value}</b>
    </span>
  )
}

// 2026-10-14 — the former single "Attendance & Shifts" screen is now FOUR
// top-level menus (user request): Attendance (records), Shifts (scheduling),
// Field & Security (tracking/geofence/security) and Devices (ADMS). Each view
// keeps its original tab VALUES so global-search deep links keep working —
// the search index now points each tab at its new view key.
export default function AttendanceView() {
  // global-search deep link: pre-select a tab (params arrive with the view)
  const presetTab = useHrm((s) => (s.view?.key === "attendance" && s.view?.params?.tab) || undefined)
  return (
    <div className="space-y-4">
      <PageHeader
        title="Attendance"
        subtitle="Shift-aware daily marking, monthly register, attendance history and the correction workflow"
      />
      <SectionTabs
        defaultValue={presetTab as string | undefined}
        tabs={[
          { value: "daily",       label: "Daily Attendance",   content: <DailyTab /> },
          { value: "register",    label: "Monthly Register",   content: <RegisterTab /> },
          { value: "history",     label: "Attendance History", content: <AttendanceHistoryTab /> },
          { value: "corrections", label: "Corrections",        content: <CorrectionsTab /> },
        ]}
      />
    </div>
  )
}

// ---- Shifts (separate menu): shift definitions, roster and check-in policies ----
export function ShiftsView() {
  const presetTab = useHrm((s) => (s.view?.key === "shifts" && s.view?.params?.tab) || undefined)
  return (
    <div className="space-y-4">
      <PageHeader
        title="Shifts"
        subtitle="Shift definitions, roster assignments and attendance/check-in policies — overtime is computed server-side against the assigned shift"
      />
      <SectionTabs
        defaultValue={presetTab as string | undefined}
        tabs={[
          { value: "shifts",   label: "Shifts & Roster",    content: <ShiftsTab /> },
          { value: "policies", label: "Policies & Check-In", content: <AttendancePoliciesTab /> },
        ]}
      />
    </div>
  )
}

// ---- Field & Security (separate menu): live tracking, geo-fence, security events ----
export function FieldSecurityView() {
  const { can } = useHrm()
  const presetTab = useHrm((s) => (s.view?.key === "fieldsecurity" && s.view?.params?.tab) || undefined)
  const canTrack = can("tracking", "view")
  const canGeofence = can("geofence", "view")
  return (
    <div className="space-y-4">
      <PageHeader
        title="Field & Security"
        subtitle="Live location tracking, geo-fence punch validation and attendance security events"
      />
      <SectionTabs
        defaultValue={presetTab as string | undefined}
        tabs={[
          ...(canTrack    ? [{ value: "tracking", label: "Live Tracking",    content: <LiveTrackingTab /> }]    : []),
          ...(canGeofence ? [{ value: "geofence", label: "Geo-Fence",        content: <GeofenceManagerTab /> }] : []),
          { value: "security", label: "Security Events", content: <SecurityEventsTab /> },
        ]}
      />
    </div>
  )
}

// ---- Devices (separate menu): ZKTeco ADMS devices, events, unknown users, sync ----
export function DevicesView() {
  const presetTab = useHrm((s) => (s.view?.key === "devices" && s.view?.params?.tab) || undefined)
  return (
    <div className="space-y-4">
      <PageHeader
        title="Devices"
        subtitle="ZKTeco ADMS biometric terminals — device registry, pushed events, unknown-user mapping and the sync monitor"
      />
      <SectionTabs
        defaultValue={presetTab as string | undefined}
        tabs={[
          { value: "devices",      label: "ADMS Devices",   content: <AdmsDevicesTab /> },
          { value: "deviceEvents", label: "Device Events",  content: <AdmsEventsTab /> },
          { value: "unknownUsers", label: "Unknown Users",  content: <AdmsUnknownTab /> },
          { value: "syncMonitor",  label: "Sync Monitor",   content: <AdmsSyncTab /> },
        ]}
      />
    </div>
  )
}

// ---------- Overtime approvals (spec §7.6 — approval requirement) ----------
function OtApprovalsCard() {
  const { toast } = useHrm()
  const [month, setMonth] = useState(todayIso().slice(5, 7))
  const [year, setYear] = useState(todayIso().slice(0, 4))
  const { data, reload } = useApi<any[]>("attendance.otPending", { month: Number(month), year: Number(year) })
  const [busyId, setBusyId] = useState<string | null>(null)
  // L-7 — rejecting an OT request now asks for a typed reason. The engine has
  // accepted a free-text reason since the flow shipped; the UI hardcoded
  // "Rejected by HR", which gave employees no actionable feedback.
  const [rejecting, setRejecting] = useState<any | null>(null)
  const rows = data || []

  const act = async (r: any, decision: "APPROVE" | "REJECT", reason?: string) => {
    setBusyId(r.id)
    try {
      await rpc("attendance.otApprove", { id: r.id, decision, reason: decision === "REJECT" ? (reason?.trim() || "Rejected by HR") : undefined })
      toast(`Overtime ${decision === "APPROVE" ? "approved" : "rejected"} for ${r.employeeName}`)
      reload()
    } catch (e: any) {
      toast(e.message, "err")
    } finally {
      setBusyId(null)
    }
  }

  if (rows.length === 0) return null
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/70 dark:border-amber-900 dark:bg-amber-950/40 px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-amber-800 dark:text-amber-300">
          <Clock className="h-4 w-4" /> Overtime awaiting approval ({rows.length})
        </div>
        <div className="flex items-center gap-1.5">
          <Select value={month} onValueChange={setMonth}>
            <SelectTrigger className="h-7 w-[110px] text-[11px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {MONTHS.map((m, i) => <SelectItem key={m} value={String(i + 1).padStart(2, "0")}>{m.slice(0, 3)}</SelectItem>)}
            </SelectContent>
          </Select>
          <Input type="number" value={year} onChange={(e) => setYear(e.target.value)} className="h-7 w-[70px] text-[11px]" aria-label="Year" />
        </div>
      </div>
      <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((r: any) => (
          <div key={r.id} className="flex items-center justify-between gap-2 rounded-md border border-amber-200/70 dark:border-amber-900/70 bg-white/80 dark:bg-slate-900/80 px-2.5 py-1.5">
            <div className="min-w-0">
              <p className="text-xs font-medium text-slate-800 dark:text-slate-100 truncate">{r.employeeName}</p>
              <p className="text-[10px] text-slate-500 dark:text-slate-400 tabular-nums">{fmtDate(r.date)} · {r.checkIn}→{r.checkOut || "—"} · {r.overtimeMinutes}m OT</p>
            </div>
            <div className="flex gap-1 shrink-0">
              <Button size="sm" variant="outline" className="h-6 px-2 text-[10px] text-emerald-700 border-emerald-300 hover:bg-emerald-50"
                disabled={busyId === r.id} onClick={() => act(r, "APPROVE")}>
                <CheckCircle2 className="h-3 w-3 mr-0.5" /> Approve
              </Button>
              <Button size="sm" variant="outline" className="h-6 px-2 text-[10px] text-rose-700 border-rose-300 hover:bg-rose-50"
                disabled={busyId === r.id} onClick={() => setRejecting(r)}>
                <XCircle className="h-3 w-3 mr-0.5" /> Reject
              </Button>
            </div>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-amber-700/80 dark:text-amber-400/80 mt-1.5">
        Vendor setting “Shifts → Overtime requires approval” is ON — unapproved OT is excluded from payroll until approved here.
      </p>
      {/* L-7 — rejection requires a typed reason (ConfirmDialog requireReason) */}
      <ConfirmDialog
        open={!!rejecting}
        onOpenChange={(v) => { if (!v) setRejecting(null) }}
        title="Reject overtime request"
        message={rejecting ? `Reject the overtime request from ${rejecting.employeeName} (${rejecting.overtimeMinutes}m on ${fmtDate(rejecting.date)})? The reason is shown to the employee.` : ""}
        confirmLabel="Reject"
        danger
        requireReason
        onConfirm={async (reason) => { if (rejecting) await act(rejecting, "REJECT", reason) }}
      />
    </div>
  )
}

// ================= Tab 1 — Daily attendance grid =================
const markFields: FieldDef[] = [
  { name: "checkIn", label: "Check In", type: "time", help: "Required unless a status override is chosen" },
  { name: "checkOut", label: "Check Out", type: "time" },
  {
    name: "status", label: "Status Override", type: "select", defaultValue: "NONE",
    options: [
      { value: "NONE", label: "No override — compute from times" },
      ...MARK_STATUSES.map((s) => ({ value: s, label: titleCase(s) })),
    ],
  },
  { name: "remarks", label: "Remarks", type: "textarea", span: 2, rows: 2 },
]
const bulkFields: FieldDef[] = [
  { name: "checkIn", label: "Check In Time", type: "time", required: true, defaultValue: "09:00" },
  { name: "checkOut", label: "Check Out Time", type: "time", defaultValue: "17:00" },
]

function DailyTab() {
  const { can, toast } = useHrm()
  const [date, setDate] = useState(todayIso())
  const { data, loading, error, reload } = useApi<any[]>("attendance.today", { date })
  // ---- live grid refresh + punch toasts ----
  // 2026-10-07 — punch TOASTS moved app-wide (shared/punch-alerts.tsx, mounted
  // in the shell, governed by HR Settings → Communications → Wishes &
  // Notifications → Punch Alerts). This tab now only refreshes its grid when
  // new punches land, and its bell mutes/unmutes the app-wide toasts for this
  // browser (same preference) — no duplicate toasts.
  const [liveToasts, setLiveToasts] = useState(true)
  const lastFeedIdRef = useRef<string | null>(null)
  // keep a LIVE reference to reload — the useApi callback is rebuilt when the
  // date changes, and a stale closure in the 15s poller would re-fetch the
  // ORIGINAL date and clobber the grid (M-04 abort semantics).
  const reloadRef = useRef(reload)
  useEffect(() => { reloadRef.current = reload })
  useEffect(() => {
    const sync = () => setLiveToasts(!punchAlertsMuted())
    sync()
    window.addEventListener(PUNCH_ALERT_MUTE_EVENT, sync)
    return () => window.removeEventListener(PUNCH_ALERT_MUTE_EVENT, sync)
  }, [])
  const toggleLiveToasts = () => setPunchAlertsMuted(liveToasts)
  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return
      try {
        const res = await rpc<{ events: { id: string }[] }>(
          "attendance.liveFeed", lastFeedIdRef.current ? { after: lastFeedIdRef.current, limit: 30 } : { limit: 15 })
        if (cancelled || !res?.events?.length) return
        if (!lastFeedIdRef.current) {
          // initial load — remember the newest id
          lastFeedIdRef.current = res.events[0].id
          return
        }
        // FE-2 (Phase 1) — the cursor must be the NEWEST event (events[0]).
        // attendance.liveFeed returns newest-first on BOTH branches (initial
        // load: occurredAt desc; after-poll: asc + reverse), but the old line
        // took events[length - 1] — the OLDEST of the batch. The cursor walked
        // BACKWARD, so every 15 s poll re-matched already-seen events, the
        // "new punches" branch fired forever, and the whole-workforce
        // attendance.today grid was re-fetched every 15 seconds per open tab.
        lastFeedIdRef.current = res.events[0].id
        reloadRef.current()
      } catch { /* live feed is best-effort — never disturb the tab */ }
    }
    poll()
    const timer = setInterval(poll, 15_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])
  const [selected, setSelected] = useState<string[]>([])
  const [markTarget, setMarkTarget] = useState<any>(null)
  const [markOpen, setMarkOpen] = useState(false)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const canMark = can("attendance", "create")
  const canBulk = can("attendance", "process")
  const rows = data || []

  // Fix: default order = most recent punch first (latest check-in/out), not
  // employee-name alphabetical. Employees without a punch today sink to the
  // bottom. HH:MM(:SS) strings compare correctly lexicographically.
  const lastPunchOf = (r: any) => {
    const ci = r.record?.checkIn || ""
    const co = r.record?.checkOut || ""
    return ci > co ? ci : co
  }
  const sortedRows = useMemo(() => [...rows].sort((a: any, b: any) => {
    const av = lastPunchOf(a)
    const bv = lastPunchOf(b)
    if (!av && !bv) return 0
    if (!av) return 1
    if (!bv) return -1
    return av < bv ? 1 : av > bv ? -1 : 0
  }), [rows])

  const stats = useMemo(() => ({
    present: rows.filter((r: any) => ["PRESENT", "LATE", "EARLY_LEAVE", "HALF_DAY", "WFH", "BUSINESS_TRIP"].includes(r.impliedStatus)).length,
    late: rows.filter((r: any) => r.impliedStatus === "LATE").length,
    absent: rows.filter((r: any) => r.impliedStatus === "ABSENT").length,
    onLeave: rows.filter((r: any) => r.impliedStatus === "LEAVE").length,
  }), [rows])

  const quickMark = async (row: any, kind: "in" | "out") => {
    setBusyId(row.employeeId)
    try {
      const t = nowHHMM()
      const rec = await rpc<any>("attendance.mark", {
        employeeId: row.employeeId,
        date,
        checkIn: kind === "in" ? t : row.record?.checkIn || t,
        ...(kind === "out" ? { checkOut: t } : {}),
      })
      toast(`${row.fullName} ${kind === "in" ? "checked in" : "checked out"} at ${t} — ${titleCase(rec.status)}`)
      reload()
    } catch (e: any) {
      toast(e.message, "err")
    } finally {
      setBusyId(null)
    }
  }

  const columns: Column<any>[] = [
    ...(canBulk ? [{
      key: "sel", label: "", className: "w-10",
      render: (r: any) => (
        <Checkbox
          aria-label={`Select ${r.fullName}`}
          checked={selected.includes(r.employeeId)}
          onCheckedChange={(c) => setSelected((s) => (c ? [...s, r.employeeId] : s.filter((x) => x !== r.employeeId)))}
        />
      ),
    }] : []),
    {
      key: "employee", label: "Employee", sortValue: (r) => `${r.fullName} ${r.code}`,
      render: (r) => (
        <div>
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{r.fullName}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">{r.code} · {r.branchName || "—"} · {r.departmentName || "—"}</p>
        </div>
      ),
    },
    { key: "shiftName", label: "Shift", render: (r) => <span className="text-xs text-slate-500">{r.shiftName || "—"}</span> },
    {
      key: "impliedStatus", label: "Status", sortValue: (r) => r.impliedStatus || "",
      render: (r) => r.impliedStatus ? <StatusBadge status={r.impliedStatus} /> : <Badge variant="outline" className="text-[10px] text-slate-500 dark:text-slate-400">Unmarked</Badge>,
    },
    { key: "checkIn", label: "Check In", sortValue: (r) => r.record?.checkIn || "", render: (r) => <span className="text-xs font-medium tabular-nums text-slate-700 dark:text-slate-200">{r.record?.checkIn || "—"}</span> },
    { key: "checkOut", label: "Check Out", sortValue: (r) => r.record?.checkOut || "", render: (r) => <span className="text-xs font-medium tabular-nums text-slate-700 dark:text-slate-200">{r.record?.checkOut || "—"}</span> },
    { key: "lateMinutes", label: "Late", align: "right", render: (r) => r.record?.lateMinutes ? <span className="text-xs font-medium text-amber-600 tabular-nums">{r.record.lateMinutes}m</span> : <span className="text-xs text-slate-400">—</span> },
    { key: "overtimeMinutes", label: "OT", align: "right", render: (r) => r.record?.overtimeMinutes ? <span className="text-xs font-medium text-teal-600 tabular-nums">{r.record.overtimeMinutes}m</span> : <span className="text-xs text-slate-400">—</span> },
    { key: "source", label: "Source", render: (r) => r.record?.source ? <Badge variant="outline" className="text-[10px]">{r.record.source}</Badge> : <span className="text-xs text-slate-400">—</span> },
    ...(canMark ? [{
      key: "actions", label: "", align: "right" as const,
      render: (r: any) => (
        <div className="flex items-center justify-end gap-1">
          {/* UI-R4 — normalized row actions (was: h-7 px-2 text-[10px] outline + ghost) */}
          <RowButton icon={busyId === r.employeeId ? undefined : LogIn} disabled={busyId === r.employeeId || !!r.record?.checkIn}
            title={r.record?.checkIn ? "Already checked in" : "Mark check-in with the current time"}
            onClick={() => quickMark(r, "in")}>
            {busyId === r.employeeId ? <Loader2 className="h-3 w-3 animate-spin" /> : null} In
          </RowButton>
          <RowButton icon={busyId === r.employeeId ? undefined : LogOut} disabled={busyId === r.employeeId || !r.record?.checkIn || !!r.record?.checkOut}
            title={!r.record?.checkIn ? "No check-in yet" : r.record?.checkOut ? "Already checked out" : "Mark check-out with the current time"}
            onClick={() => quickMark(r, "out")}>
            {busyId === r.employeeId ? <Loader2 className="h-3 w-3 animate-spin" /> : null} Out
          </RowButton>
          <RowIconButton icon={Pencil} label="Manual mark / correction" onClick={() => { setMarkTarget(r); setMarkOpen(true) }} />
        </div>
      ),
    }] : []),
  ]

  return (
    <div className="space-y-3">
      {canBulk && <OtApprovalsCard />}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <CalendarDays className="h-4 w-4 text-slate-400" />
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-9 w-[170px]" aria-label="Attendance date" />
          <Button size="icon" variant="ghost" className="h-9 w-9"
            title={liveToasts ? "Attendance event toasts ON — click to mute" : "Attendance event toasts muted — click to enable"}
            aria-label={liveToasts ? "Mute attendance event toasts" : "Enable attendance event toasts"}
            onClick={toggleLiveToasts}>
            {liveToasts
              ? <BellRing className="h-4 w-4 text-emerald-600" />
              : <BellOff className="h-4 w-4 text-slate-400" />}
          </Button>
          {canBulk && rows.length > 0 && (
            <Button size="sm" variant="outline" className="h-9 text-xs"
              onClick={() => setSelected(selected.length === rows.length ? [] : rows.map((r: any) => r.employeeId))}>
              {selected.length === rows.length ? "Clear selection" : "Select all"}
            </Button>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <StatChip label="Present" value={loading ? "…" : stats.present} tone="emerald" />
          <StatChip label="Late" value={loading ? "…" : stats.late} tone="amber" />
          <StatChip label="Absent" value={loading ? "…" : stats.absent} tone="rose" />
          <StatChip label="On Leave" value={loading ? "…" : stats.onLeave} tone="orange" />
        </div>
      </div>

      {canBulk && selected.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50/60 dark:border-emerald-900 dark:bg-emerald-950/40 px-3 py-2">
          <Users className="h-4 w-4 text-emerald-600" />
          <span className="text-xs font-medium text-slate-700 dark:text-slate-200">{selected.length} employee(s) selected</span>
          <Button size="sm" className="h-7 text-xs " onClick={() => setBulkOpen(true)}>
            <Clock className="h-3.5 w-3.5 mr-1" /> Bulk Mark
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setSelected([])}>Clear</Button>
        </div>
      )}

      <DataTable
        columns={columns} rows={sortedRows} loading={loading} error={error}
        pageSize={15} csvName={`daily-attendance-${date}`} searchPlaceholder="Search employee…"
        emptyTitle="No employees in scope" emptyHint="Active employees for your scope appear here with their shift and implied status."
      />

      <FormDialog
        open={markOpen} onOpenChange={(v) => { setMarkOpen(v); if (!v) { setMarkTarget(null); reload() } }}
        title={markTarget ? `Mark attendance — ${markTarget.fullName}` : "Mark attendance"}
        description={`Manual entry for ${fmtDate(date)}. Times are HH:MM; late / OT are recomputed against the assigned shift.`}
        fields={markFields} initial={markTarget?.record || undefined}
        onSubmit={async (v) => {
          const override = v.status && v.status !== "NONE" ? v.status : undefined
          if (!override && !v.checkIn) throw new Error("Enter a check-in time or choose a status override")
          await rpc("attendance.mark", {
            employeeId: markTarget.employeeId,
            date,
            checkIn: override ? undefined : v.checkIn,
            checkOut: v.checkOut || undefined,
            status: override,
            remarks: v.remarks || undefined,
          })
          reload()
        }}
      />

      <FormDialog
        open={bulkOpen} onOpenChange={setBulkOpen}
        title="Bulk mark attendance"
        description={`Apply the same check-in / check-out to ${selected.length} selected employee(s) on ${fmtDate(date)}. Existing records for the day are overwritten.`}
        fields={bulkFields}
        onSubmit={async (v) => {
          await rpc("attendance.bulkMark", { date, employeeIds: selected, checkIn: v.checkIn, checkOut: v.checkOut || undefined })
          setSelected([])
          reload()
        }}
      />
    </div>
  )
}

// ================= Tab 2 — Monthly register =================
function RegisterTab() {
  const now = new Date()
  // 2026-10-14 — Employee Actions deep link (employee 360° → "Attendance"):
  // pre-select this employee in the register's employee filter.
  const presetEmployeeId = useHrm((s) => (s.view?.key === "attendance" ? ((s.view?.params as any)?.employeeId as string | undefined) : undefined))
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [year, setYear] = useState(now.getFullYear())
  const [branchId, setBranchId] = useState("all")
  const [departmentId, setDepartmentId] = useState("all")
  const [employeeId, setEmployeeId] = useState(presetEmployeeId || "all")
  // SCL-10 (Phase 2 WS3) — the register is now SERVER-paginated (200 rows per
  // page + server-side employee search). The old handler shipped the whole
  // month (150K rows at 5K employees) to the browser on every filter change.
  const [page, setPage] = useState(1)
  const [q, setQ] = useState("")
  const { data: branches } = useApi<any[]>("branches.list", {})
  const { data: departments } = useApi<any[]>("departments.list", {})
  const { data: employees } = useEmployeeDirectory()

  const payload = useMemo(() => ({
    month, year,
    branchId: branchId === "all" ? undefined : branchId,
    departmentId: departmentId === "all" ? undefined : departmentId,
    employeeId: employeeId === "all" ? undefined : employeeId,
    q: q || undefined,
    page, pageSize: 200,
  }), [month, year, branchId, departmentId, employeeId, q, page])
  const { data, loading, error } = useApi<any>("attendance.register", payload)
  const items: any[] = data?.items ?? []
  const total: number = data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / 200))
  // any filter/search change restarts at page 1
  useEffect(() => { setPage(1) }, [month, year, branchId, departmentId, employeeId, q])
  const { data: summary } = useApi<any>("attendance.summary", { month, year, ...(employeeId !== "all" ? { employeeId } : {}) })

  const years = useMemo(() => {
    const y = new Date().getFullYear()
    return [y - 2, y - 1, y, y + 1]
  }, [])

  const columns: Column<any>[] = [
    { key: "date", label: "Date", sortValue: (r) => r.date, render: (r) => <span className="text-xs font-medium tabular-nums text-slate-700 dark:text-slate-200">{fmtDate(r.date)}</span> },
    {
      key: "employeeName", label: "Employee", sortValue: (r) => r.employeeName,
      render: (r) => (
        <div>
          <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{r.employeeName}</p>
          {r.employeeCode && <p className="text-[11px] text-slate-500 dark:text-slate-400">{r.employeeCode}</p>}
        </div>
      ),
    },
    { key: "status", label: "Status", render: (r) => <StatusBadge status={r.status} /> },
    { key: "checkIn", label: "Check In", render: (r) => <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300">{r.checkIn || "—"}</span> },
    { key: "checkOut", label: "Check Out", render: (r) => <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300">{r.checkOut || "—"}</span> },
    { key: "workingMinutes", label: "Working", align: "right", sortValue: (r) => r.workingMinutes || 0, render: (r) => <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300">{minutesHHMM(r.workingMinutes)}</span> },
    { key: "lateMinutes", label: "Late", align: "right", sortValue: (r) => r.lateMinutes || 0, render: (r) => r.lateMinutes ? <span className="text-xs font-medium text-amber-600 tabular-nums">{r.lateMinutes}m</span> : <span className="text-xs text-slate-400">—</span> },
    { key: "overtimeMinutes", label: "OT", align: "right", sortValue: (r) => r.overtimeMinutes || 0, render: (r) => r.overtimeMinutes ? <span className="text-xs font-medium text-teal-600 tabular-nums">{r.overtimeMinutes}m</span> : <span className="text-xs text-slate-400">—</span> },
    { key: "source", label: "Source", render: (r) => <Badge variant="outline" className="text-[10px]">{r.source || "—"}</Badge> },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label className="text-[11px] text-slate-500 dark:text-slate-400">Month</Label>
          <Select value={String(month)} onValueChange={(v) => setMonth(Number(v))}>
            <SelectTrigger className="w-[130px] h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              {MONTHS.map((m, i) => <SelectItem key={m} value={String(i + 1)}>{m}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-[11px] text-slate-500 dark:text-slate-400">Year</Label>
          <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
            <SelectTrigger className="w-[100px] h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              {years.map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-[11px] text-slate-500 dark:text-slate-400">Branch</Label>
          <Select value={branchId} onValueChange={setBranchId}>
            <SelectTrigger className="w-[160px] h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All branches</SelectItem>
              {(branches || []).map((b: any) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-[11px] text-slate-500 dark:text-slate-400">Department</Label>
          <Select value={departmentId} onValueChange={setDepartmentId}>
            <SelectTrigger className="w-[160px] h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All departments</SelectItem>
              {(departments || []).map((d: any) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-[11px] text-slate-500 dark:text-slate-400">Employee</Label>
          <Select value={employeeId} onValueChange={setEmployeeId}>
            <SelectTrigger className="w-[200px] h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All employees</SelectItem>
              {(employees || []).map((e: any) => <SelectItem key={e.id} value={e.id}>{e.fullName} ({e.code})</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <StatChip label="Present" value={summary ? summary.present : "…"} tone="emerald" />
        <StatChip label="Absent" value={summary ? summary.absent : "…"} tone="rose" />
        <StatChip label="Late" value={summary ? summary.late : "…"} tone="amber" />
        <StatChip label="Overtime" value={summary ? minutesHHMM(summary.totalOvertimeMinutes) : "…"} tone="teal" />
      </div>

      <DataTable
        columns={columns} rows={items.length ? items : undefined} loading={loading} error={error}
        pageSize={20} csvName="attendance-register" searchPlaceholder="Search employee…" onSearch={setQ}
        emptyTitle="No attendance records" emptyHint={`No records found for ${MONTHS[month - 1]} ${year} with these filters.`}
        onExportCsv={async () => {
          // full-month export keeps the OLD contract: fetch the unbounded
          // register (user-initiated, one-shot) and export everything
          const all = await rpc<any[]>("attendance.register", {
            month, year,
            branchId: branchId === "all" ? undefined : branchId,
            departmentId: departmentId === "all" ? undefined : departmentId,
            employeeId: employeeId === "all" ? undefined : employeeId,
            q: q || undefined,
          })
          return all
        }}
        toolbar={
          <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <span className="tabular-nums">{total.toLocaleString()} record{total === 1 ? "" : "s"}</span>
            <button type="button" className="rounded border border-slate-200 px-2 py-1 disabled:opacity-40 dark:border-slate-700" disabled={page <= 1 || loading} onClick={() => setPage((n) => Math.max(1, n - 1))}>Prev</button>
            <span className="tabular-nums">Page {page} / {pageCount}</span>
            <button type="button" className="rounded border border-slate-200 px-2 py-1 disabled:opacity-40 dark:border-slate-700" disabled={page >= pageCount || loading} onClick={() => setPage((n) => n + 1)}>Next</button>
          </div>
        }
      />
    </div>
  )
}

// ================= Tab 3 — Shift definitions + roster =================
function ShiftsTab() {
  const { can } = useHrm()
  const { data: shifts, loading, error, reload } = useApi<any[]>("shifts.list", {})
  const { data: rosters, loading: rLoading, error: rError, reload: rReload } = useApi<any[]>("rosters.list", {})
  const { data: branches } = useApi<any[]>("branches.list", {})
  const { data: employees } = useEmployeeDirectory()
  const [shiftOpen, setShiftOpen] = useState(false)
  const [editShift, setEditShift] = useState<any>(null)
  const [delShift, setDelShift] = useState<any>(null)
  const [rosterOpen, setRosterOpen] = useState(false)
  const [delRoster, setDelRoster] = useState<any>(null)

  const shiftFields: FieldDef[] = useMemo(() => [
    { name: "name", label: "Shift Name", required: true, placeholder: "Morning — Store" },
    { name: "type", label: "Type", type: "select", defaultValue: "FIXED", options: ["FIXED", "ROTATIONAL"].map((t) => ({ value: t, label: titleCase(t) })) },
    { name: "startTime", label: "Start Time", type: "time", required: true, defaultValue: "09:00" },
    { name: "endTime", label: "End Time", type: "time", required: true, defaultValue: "17:00" },
    { name: "graceMinutes", label: "Grace Period (min)", type: "number", min: 0, defaultValue: 10, help: "Late only counts after start + grace" },
    { name: "breakMinutes", label: "Break (min)", type: "number", min: 0, defaultValue: 60 },
    { name: "minWorkingHours", label: "Min Working Hours", type: "number", min: 0, step: 0.5, defaultValue: 8, help: "Below half of this is flagged HALF_DAY" },
    { name: "otThresholdMinutes", label: "OT Threshold (min)", type: "number", min: 0, defaultValue: 30, help: "Minutes past shift end before OT counts" },
    { name: "otMultiplier", label: "Weekday OT Rate ×", type: "number", min: 0, step: 0.1, defaultValue: 1.5, help: "Multiplier on basic hourly rate for weekday overtime" },
    { name: "otHolidayMultiplier", label: "Holiday OT Rate ×", type: "number", min: 0, step: 0.1, defaultValue: 2, help: "Government-holiday overtime rate" },
    { name: "otWeeklyOffMultiplier", label: "Weekly-Off OT Rate ×", type: "number", min: 0, step: 0.1, defaultValue: 2, help: "Weekly-day-off overtime rate" },
    { name: "weeklyOff", label: "Weekly Off Day(s)", type: "multiselect", defaultValue: ["FRIDAY"], options: WEEKLY_OFFS.map((d) => ({ value: d, label: titleCase(d) })), help: "Select one or more weekly off days (e.g. Friday + Saturday)" },
    { name: "branchId", label: "Branch", type: "select", placeholder: "All branches", options: (branches || []).map((b: any) => ({ value: b.id, label: b.name })) },
    { name: "active", label: "Active", type: "switch", defaultValue: true },
  ], [branches])

  const rosterFields: FieldDef[] = useMemo(() => [
    { name: "employeeId", label: "Employee", type: "select", required: true, options: (employees || []).map((e: any) => ({ value: e.id, label: `${e.fullName} (${e.code})` })) },
    { name: "shiftId", label: "Shift", type: "select", required: true, options: (shifts || []).map((s: any) => ({ value: s.id, label: `${s.name} · ${s.startTime}–${s.endTime}` })) },
    { name: "fromDate", label: "From Date", type: "date", required: true },
    { name: "toDate", label: "To Date", type: "date", help: "Leave blank for an open-ended assignment" },
    { name: "note", label: "Note", type: "textarea", span: 2, rows: 2 },
  ], [employees, shifts])

  const shiftColumns: Column<any>[] = [
    {
      key: "name", label: "Shift", sortValue: (s) => s.name,
      render: (s) => (
        <div>
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{s.name}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">{(branches || []).find((b: any) => b.id === s.branchId)?.name || "All branches"}</p>
        </div>
      ),
    },
    { key: "type", label: "Type", render: (s) => <Badge variant="outline" className="text-[10px]">{titleCase(s.type)}</Badge> },
    { key: "span", label: "Start – End", render: (s) => <span className="text-xs font-medium tabular-nums text-slate-700 dark:text-slate-200">{s.startTime} – {s.endTime}</span> },
    { key: "graceMinutes", label: "Grace", align: "right", render: (s) => <span className="text-xs tabular-nums text-slate-500">{s.graceMinutes}m</span> },
    { key: "breakMinutes", label: "Break", align: "right", render: (s) => <span className="text-xs tabular-nums text-slate-500">{s.breakMinutes}m</span> },
    { key: "minWorkingHours", label: "Min Hrs", align: "right", render: (s) => <span className="text-xs tabular-nums text-slate-500">{s.minWorkingHours}h</span> },
    { key: "ot", label: "OT Rule", render: (s) => <span className="text-xs text-slate-500">+{s.otThresholdMinutes}m · WD {s.otMultiplier ?? 1.5}× / Hol {(s.otHolidayMultiplier ?? 2)}× / Off {(s.otWeeklyOffMultiplier ?? 2)}×</span> },
    { key: "weeklyOff", label: "Weekly Off", render: (s) => <span className="text-xs text-slate-600 dark:text-slate-300">{fmtWeeklyOff(s.weeklyOff)}</span> },
    { key: "active", label: "Active", render: (s) => <Badge className={s.active ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"}>{s.active ? "Active" : "Inactive"}</Badge> },
    {
      key: "actions", label: "", align: "right",
      render: (s) => (can("shifts", "edit") || can("shifts", "delete")) && (
        <div className="flex gap-1">
          {can("shifts", "edit") && (
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => { setEditShift(s); setShiftOpen(true) }}><Pencil className="h-3.5 w-3.5" /></Button>
          )}
          {can("shifts", "delete") && (
            <Button size="icon" variant="ghost" className="h-7 w-7 text-slate-400 hover:text-rose-600" onClick={() => setDelShift(s)}><Trash2 className="h-3.5 w-3.5" /></Button>
          )}
        </div>
      ),
    },
  ]

  const rosterColumns: Column<any>[] = [
    {
      key: "employeeName", label: "Employee", sortValue: (r) => r.employeeName,
      render: (r) => (
        <div>
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{r.employeeName}</p>
          {r.employeeCode && <p className="text-[11px] text-slate-500 dark:text-slate-400">{r.employeeCode}</p>}
        </div>
      ),
    },
    { key: "shiftName", label: "Shift", render: (r) => <span className="text-xs font-medium text-slate-700 dark:text-slate-200">{r.shiftName}</span> },
    { key: "fromDate", label: "From", sortValue: (r) => r.fromDate, render: (r) => <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300">{fmtDate(r.fromDate)}</span> },
    { key: "toDate", label: "To", render: (r) => <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300">{r.toDate ? fmtDate(r.toDate) : "Open-ended"}</span> },
    { key: "note", label: "Note", render: (r) => <span className="text-xs text-slate-500" title={r.note || ""}>{r.note ? (r.note.length > 40 ? r.note.slice(0, 40) + "…" : r.note) : "—"}</span> },
    {
      key: "actions", label: "", align: "right",
      render: (r) => can("shifts", "delete") && (
        <Button size="icon" variant="ghost" className="h-7 w-7 text-slate-400 hover:text-rose-600" onClick={() => setDelRoster(r)}><Trash2 className="h-3.5 w-3.5" /></Button>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <SectionCard
        title="Shift Definitions"
        actions={can("shifts", "create") && (
          <Button size="sm" onClick={() => { setEditShift(null); setShiftOpen(true) }} className="h-8 text-xs ">
            <Plus className="h-3.5 w-3.5 mr-1" /> Add Shift
          </Button>
        )}
      >
        <DataTable columns={shiftColumns} rows={shifts || undefined} loading={loading} error={error} pageSize={10}
          csvName="shifts" searchPlaceholder="Search shift…" emptyTitle="No shifts defined"
          emptyHint="Shifts drive late, half-day and overtime computation for attendance and payroll." />
      </SectionCard>

      <SectionCard
        title="Roster Assignments"
        actions={can("shifts", "assign") && (
          <Button size="sm" onClick={() => setRosterOpen(true)} className="h-8 text-xs ">
            <Plus className="h-3.5 w-3.5 mr-1" /> Assign Roster
          </Button>
        )}
      >
        <DataTable columns={rosterColumns} rows={rosters || undefined} loading={rLoading} error={rError} pageSize={10}
          csvName="rosters" searchPlaceholder="Search roster…" emptyTitle="No roster assignments"
          emptyHint="Assign employees to shifts; the most recent overlapping assignment wins." />
      </SectionCard>

      <FormDialog open={shiftOpen} onOpenChange={(v) => { setShiftOpen(v); if (!v) { setEditShift(null); reload() } }}
        title={editShift ? `Edit — ${editShift.name}` : "Add Shift"} wide
        description="Grace, break, minimum working hours and OT rules feed the attendance engine."
        fields={shiftFields} initial={editShift ? { ...editShift, weeklyOff: String(editShift.weeklyOff || "").split(",").map((s: string) => s.trim()).filter(Boolean) } : editShift}
        onSubmit={async (v) => {
          const weeklyOff = Array.isArray(v.weeklyOff) ? v.weeklyOff.join(",") : v.weeklyOff
          await rpc(editShift ? "shifts.update" : "shifts.create",
            editShift ? { id: editShift.id, ...v, weeklyOff, branchId: v.branchId || null } : { ...v, weeklyOff, branchId: v.branchId || null })
        }} />

      <FormDialog open={rosterOpen} onOpenChange={(v) => { setRosterOpen(v); if (!v) rReload() }}
        title="Assign Roster" wide
        description="Roster assignments override the employee's default shift from the given date."
        fields={rosterFields}
        onSubmit={async (v) => {
          await rpc("rosters.assign", { ...v, toDate: v.toDate || undefined, note: v.note || undefined })
        }} />

      <ConfirmDialog open={!!delShift} onOpenChange={(v) => { if (!v) setDelShift(null) }} title="Delete shift"
        message={`Delete "${delShift?.name}"? Employees on this shift fall back to their default.`} danger confirmLabel="Delete"
        onConfirm={async () => { await rpc("shifts.delete", { id: delShift.id }); reload() }} />

      <ConfirmDialog open={!!delRoster} onOpenChange={(v) => { if (!v) setDelRoster(null) }} title="Remove roster assignment"
        message={`Remove the roster for ${delRoster?.employeeName}?`} danger confirmLabel="Remove"
        onConfirm={async () => { await rpc("rosters.delete", { id: delRoster.id }); rReload() }} />
    </div>
  )
}

// ================= Tab 6 — Geo-fence attendance =================


// ================= Tab 7 — Correction requests =================
function CorrectionsTab() {
  const { can } = useHrm() // L-19 — role no longer needed: the RBAC gate replaced it
  const [status, setStatus] = useState("all")
  const { data, loading, error, reload } = useApi<any[]>("attendance.corrections.list", status === "all" ? {} : { status })
  const { data: employees } = useEmployeeDirectory()
  const [open, setOpen] = useState(false)
  const [act, setAct] = useState<any>(null)
  // L-19 — RBAC gate instead of a hardcoded role list (matches the server route)
  const canDecide = can("attendance", "verify")

  const correctionFields: FieldDef[] = useMemo(() => [
    { name: "employeeId", label: "Employee", type: "select", required: true, options: (employees || []).map((e: any) => ({ value: e.id, label: `${e.fullName} (${e.code})` })) },
    { name: "date", label: "Date", type: "date", required: true },
    { name: "requestedIn", label: "Requested Check-In", type: "time" },
    { name: "requestedOut", label: "Requested Check-Out", type: "time" },
    { name: "reason", label: "Reason", type: "textarea", required: true, span: 2, rows: 2 },
  ], [employees])

  const columns: Column<any>[] = [
    {
      key: "employeeName", label: "Employee", sortValue: (c) => c.employeeName,
      render: (c) => <span className="text-sm font-medium text-slate-800 dark:text-slate-100">{c.employeeName}</span>,
    },
    { key: "date", label: "Date", sortValue: (c) => c.date, render: (c) => <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300">{fmtDate(c.date)}</span> },
    { key: "requestedIn", label: "Requested In", render: (c) => <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300">{c.requestedIn || "—"}</span> },
    { key: "requestedOut", label: "Requested Out", render: (c) => <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300">{c.requestedOut || "—"}</span> },
    { key: "reason", label: "Reason", render: (c) => <span className="text-xs text-slate-500" title={c.reason}>{c.reason && c.reason.length > 44 ? c.reason.slice(0, 44) + "…" : c.reason}</span> },
    { key: "status", label: "Status", render: (c) => <StatusBadge status={c.status} /> },
    {
      key: "actions", label: "", align: "right",
      render: (c) => c.status === "PENDING" && canDecide && (
        <div className="flex gap-1">
          <Button size="sm" variant="outline" className="h-7 text-[10px] text-emerald-700 border-emerald-300 hover:bg-emerald-50 dark:text-emerald-400"
            onClick={() => setAct({ rec: c, decision: "APPROVED" })}>
            <CheckCircle2 className="h-3 w-3 mr-0.5" /> Approve
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-[10px] text-rose-700 border-rose-300 hover:bg-rose-50 dark:text-rose-400"
            onClick={() => setAct({ rec: c, decision: "REJECTED" })}>
            <XCircle className="h-3 w-3 mr-0.5" /> Reject
          </Button>
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          {["all", "PENDING", "APPROVED", "REJECTED"].map((s) => (
            <button key={s} type="button" onClick={() => setStatus(s)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                status === s
                  ? "bg-primary text-primary-foreground"
                  : "border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:border-emerald-400"
              }`}>
              {s === "all" ? "All" : titleCase(s)}
            </button>
          ))}
        </div>
        {can("attendance", "create") && (
          <Button size="sm" onClick={() => setOpen(true)} className="h-8 text-xs ">
            <ClipboardCheck className="h-3.5 w-3.5 mr-1" /> Request Correction
          </Button>
        )}
      </div>

      <DataTable columns={columns} rows={data || undefined} loading={loading} error={error} pageSize={15}
        csvName="attendance-corrections" searchPlaceholder="Search employee…" emptyTitle="No correction requests"
        emptyHint="Employees request fixes for missed punches; HR Admin / Manager decides here." />

      <FormDialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reload() }}
        title="Request Attendance Correction" fields={correctionFields}
        description="Approving a correction rewrites that day's attendance record with the requested times."
        onSubmit={async (v) => {
          if (!v.requestedIn && !v.requestedOut) throw new Error("Enter at least one requested time")
          await rpc("attendance.corrections.request", {
            employeeId: v.employeeId,
            date: v.date,
            requestedIn: v.requestedIn || undefined,
            requestedOut: v.requestedOut || undefined,
            reason: v.reason,
          })
        }} />

      <ConfirmDialog open={!!act} onOpenChange={(v) => { if (!v) setAct(null) }}
        title={act?.decision === "APPROVED" ? "Approve correction" : "Reject correction"}
        message={act
          ? `${act.rec.employeeName} — ${fmtDate(act.rec.date)}${act.rec.requestedIn ? ` · in ${act.rec.requestedIn}` : ""}${act.rec.requestedOut ? ` · out ${act.rec.requestedOut}` : ""}. Reason: "${act.rec.reason}".${act.decision === "APPROVED" ? " Approving rewrites the attendance record for that day." : ""}`
          : ""}
        danger={act?.decision === "REJECTED"} confirmLabel={act?.decision === "APPROVED" ? "Approve" : "Reject"}
        onConfirm={async () => {
          await rpc("attendance.corrections.act", { id: act.rec.id, decision: act.decision })
          reload()
        }} />
    </div>
  )
}
