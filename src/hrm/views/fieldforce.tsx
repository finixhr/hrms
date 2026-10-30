"use client"
// ============ Wave 2 WP-M — Field Force Management (admin surface) ============
// Four tabs:
//   1. Planning Board — date picker + employee filter → per-employee cards
//      (planned / in-progress / completed / missed / ad-hoc counts) and the
//      visit timeline for the selected employee (check-in/out times,
//      duration, server-computed out-of-radius flags).
//   2. Plan Editor — pick employee + date → location picker + planned-window
//      time inputs + tasks per stop → save (upsert) / delete.
//   3. Locations — visit-location master data CRUD (DataTable + FormDialog,
//      lat/lng + radius + contact fields) with a map preview.
//   4. Reports — compliance %, coverage and average duration for a date
//      range, per-employee breakdown.
// The ESS side ("My Visits" check-in/out) lives in views/ess.tsx; the daily
// missed-visit sweep lives in hrm-server/jobs.ts.
import { useEffect, useMemo, useRef, useState } from "react"
import {
  AlertTriangle, BarChart3, CalendarDays, CheckCircle2, ClipboardList, Clock,
  Loader2, MapPin, MapPinned, Pencil, Plus, RefreshCw, Route, Timer, Trash2, Users,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useHrm } from "../store"
import { rpc, useApi, useEmployeeDirectory } from "../api"
import {
  EmptyState, ErrorBanner, PageHeader, SectionCard, StatCard,
  StatusBadge, esc, fmtDate, minutesHHMM, titleCase,
} from "../shared/ui-kit"
import { DataTable, type Column } from "../shared/data-table"
import { ConfirmDialog } from "../shared/form-dialog"
import MapCanvas from "../shared/map-canvas"

function todayIso(): string { return new Date().toISOString().slice(0, 10) }

function plusMonth(iso: string): string {
  const d = new Date(iso + "T00:00:00")
  d.setMonth(d.getMonth() - 1)
  return d.toISOString().slice(0, 10)
}

// ---- visit status chips (StatusBadge has no FIELD_FORCE-specific tones) ----
const VISIT_TONES: Record<string, string> = {
  PLANNED: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  CHECKED_IN: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  COMPLETED: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  MISSED: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  CANCELLED: "bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500",
}
function VisitChip({ status }: { status: string }) {
  return (
    <Badge variant="secondary" className={`font-medium whitespace-nowrap text-[10px] ${VISIT_TONES[status] ?? VISIT_TONES.PLANNED}`}>
      {titleCase(status)}
    </Badge>
  )
}

function initials(name?: string | null): string {
  if (!name) return "?"
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join("").toUpperCase()
}

const TABS: { key: string; label: string }[] = [
  { key: "board", label: "Planning Board" },
  { key: "plan", label: "Plan Editor" },
  { key: "locations", label: "Locations" },
  { key: "history", label: "History" },
  { key: "report", label: "Reports" },
]

export default function FieldForceView() {
  // 2026-10-14 — Employee Actions deep link (employee 360° → "Location Hit
  // Map"): preset the tab and pre-filter the history to ONE employee.
  const presetParams = useHrm((s) => (s.view?.key === "fieldforce" ? (s.view?.params as any) : null))
  const [tab, setTab] = useState((presetParams?.tab as string) || "board")
  // shared plan-editor target (the board's "Edit Plan" button preloads it)
  const [editEmployeeId, setEditEmployeeId] = useState<string>("")
  const [editDate, setEditDate] = useState<string>(todayIso())

  return (
    <div className="space-y-4">
      <PageHeader
        title="Field Force"
        subtitle="Visit planning, GPS-validated check-ins and field compliance for your mobile workforce"
      />
      {/* local tab strip (same pattern as the ESS portal) so the board's
          "Edit Plan" deep link can switch tabs programmatically */}
      <div className="flex flex-wrap gap-1 bg-slate-100 dark:bg-slate-800 p-1 rounded-xl">
        {TABS.map((t) => (
          <button key={t.key} type="button" onClick={() => setTab(t.key)} aria-pressed={tab === t.key}
            className={`px-3 py-1.5 rounded-lg text-xs sm:text-sm font-medium transition-colors ${tab === t.key ? "bg-white dark:bg-slate-900 text-emerald-700 dark:text-emerald-300 shadow-sm" : "text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100"}`}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "board" && <BoardTab onEditPlan={(employeeId, date) => { setEditEmployeeId(employeeId); setEditDate(date); setTab("plan") }} />}
      {tab === "plan" && <PlanEditorTab employeeId={editEmployeeId} date={editDate} onTargetChange={(employeeId, date) => { setEditEmployeeId(employeeId); setEditDate(date) }} />}
      {tab === "locations" && <LocationsTab />}
      {tab === "history" && <HistoryTab presetEmployeeId={(presetParams?.employeeId as string) || null} />}
      {tab === "report" && <ReportTab />}
    </div>
  )
}

// ============================================================ PLANNING BOARD

function BoardTab({ onEditPlan }: { onEditPlan: (employeeId: string, date: string) => void }) {
  const { can } = useHrm()
  const [date, setDate] = useState(todayIso())
  const [filter, setFilter] = useState("all")
  const [selected, setSelected] = useState<string | null>(null)
  const { data: board, loading, error, reload } = useApi<any>("fieldforce.board", { date })
  const { data: employees } = useEmployeeDirectory()
  const { data: detail, loading: detailLoading } = useApi<any>(selected ? "fieldforce.plan.get" : null, { date, employeeId: selected })

  const rows = useMemo(() => {
    const all = board?.rows ?? []
    if (filter === "all") return all
    return all.filter((r: any) => r.employeeId === filter)
  }, [board, filter])

  const totals = board?.totals
  const selectedRow = (board?.rows ?? []).find((r: any) => r.employeeId === selected)

  return (
    <div className="space-y-4">
      {/* date + employee filter */}
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <Label className="text-xs text-slate-500">Date</Label>
          <Input type="date" value={date} onChange={(e) => { setDate(e.target.value); setSelected(null) }} className="w-[160px] h-9" />
        </div>
        <Select value={filter} onValueChange={(v) => { setFilter(v); if (v !== "all") setSelected(v) }}>
          <SelectTrigger className="w-52 h-9 text-xs"><SelectValue placeholder="Employee" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All employees with plans</SelectItem>
            {(employees ?? []).filter((e: any) => ["ACTIVE", "PROBATION"].includes(e.status)).map((e: any) => (
              <SelectItem key={e.id} value={e.id}>{e.fullName} ({e.code})</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" className="h-9" onClick={() => reload()}>
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Refresh
        </Button>
        <span className="text-[11px] text-slate-400 ml-auto flex items-center gap-1">
          <CalendarDays className="h-3 w-3" /> visits missed by past-window plans are swept nightly
        </span>
      </div>

      {/* day totals */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <StatCard label="Employees on plan" value={totals?.employees ?? 0} icon={Users} tone="slate" sub={`for ${fmtDate(date)}`} />
        <StatCard label="Planned stops" value={totals?.planned ?? 0} icon={ClipboardList} tone="violet" />
        <StatCard label="In progress" value={totals?.checkedIn ?? 0} icon={Clock} tone="sky" sub="checked in, not out" />
        <StatCard label="Completed" value={totals?.completed ?? 0} icon={CheckCircle2} tone="emerald" />
        <StatCard label="Missed" value={totals?.missed ?? 0} icon={AlertTriangle} tone="rose" sub="no check-in before window" />
      </div>

      {error ? <ErrorBanner message={error} /> : loading ? (
        <div className="flex items-center justify-center py-12 text-slate-400"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : rows.length === 0 ? (
        <SectionCard title="Planning Board">
          <EmptyState icon={MapPin} title="No visit plans for this date" hint="Create a plan in the Plan Editor tab — pick an employee, add stops with location and time window." />
        </SectionCard>
      ) : (
        <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {rows.map((r: any) => (
            <button
              key={r.employeeId}
              type="button"
              onClick={() => setSelected(r.employeeId === selected ? null : r.employeeId)}
              aria-pressed={selected === r.employeeId}
              className={`text-left rounded-xl border bg-card p-4 transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected === r.employeeId ? "border-primary/60 ring-1 ring-primary/30" : "border-slate-200 dark:border-slate-800"}`}
            >
              <div className="flex items-center gap-3">
                {r.photoThumb ? (
                  <img src={r.photoThumb} alt="" className="h-10 w-10 rounded-full object-cover border shrink-0" />
                ) : (
                  <div className="h-10 w-10 rounded-full bg-slate-200 dark:bg-slate-700 flex items-center justify-center text-slate-400 text-sm font-bold shrink-0">{initials(r.fullName)}</div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">{r.fullName}</p>
                  <p className="text-[11px] text-slate-400 truncate">{r.code} · {r.designation}</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5 mt-3">
                <VisitChip status="PLANNED" /><span className="text-xs font-bold tabular-nums text-slate-600 dark:text-slate-300">{r.planned}</span>
                {r.checkedIn > 0 && <><VisitChip status="CHECKED_IN" /><span className="text-xs font-bold tabular-nums text-sky-700 dark:text-sky-300">{r.checkedIn}</span></>}
                {r.completed > 0 && <><VisitChip status="COMPLETED" /><span className="text-xs font-bold tabular-nums text-emerald-700 dark:text-emerald-300">{r.completed}</span></>}
                {r.missed > 0 && <><VisitChip status="MISSED" /><span className="text-xs font-bold tabular-nums text-rose-700 dark:text-rose-300">{r.missed}</span></>}
                {r.adHoc > 0 && <Badge variant="outline" className="text-[10px]">{r.adHoc} ad-hoc</Badge>}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* visit timeline for the selected employee */}
      {selected && (
        <SectionCard
          title={<span>Visit Timeline <span className="text-slate-400 font-normal">· {selectedRow?.fullName ?? "employee"} · {fmtDate(date)}</span></span>}
          actions={can("fieldforce", "edit") && (
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => onEditPlan(selected, date)}>
              <Pencil className="h-3.5 w-3.5 mr-1.5" /> Edit Plan
            </Button>
          )}
        >
          {detailLoading ? (
            <div className="flex items-center justify-center py-10 text-slate-400"><Loader2 className="h-5 w-5 animate-spin" /></div>
          ) : !detail?.plan && !(detail?.visits ?? []).length ? (
            <EmptyState icon={MapPin} title="No plan and no visits for this day" />
          ) : (
            <div className="space-y-2">
              {detail?.plan?.note && (
                <p className="text-xs text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-900 rounded-lg px-3 py-2">
                  <b className="text-slate-600 dark:text-slate-300">Plan note:</b> {detail.plan.note}
                </p>
              )}
              {(detail?.items ?? []).map((item: any) => (
                <div key={item.id} className="rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <MapPin className="h-3.5 w-3.5 text-teal-600 shrink-0" />
                    <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{item.locationName}</p>
                    {item.locationAddress && <span className="text-[11px] text-slate-400 truncate max-w-[240px]">{item.locationAddress}</span>}
                    {item.plannedFrom && (
                      <span className="text-[11px] tabular-nums text-slate-500 dark:text-slate-400">{item.plannedFrom}{item.plannedTo ? `–${item.plannedTo}` : ""}</span>
                    )}
                    <span className="ml-auto flex items-center gap-1.5">
                      {item.visit?.outOfRadius && (
                        <Badge variant="outline" className="text-[10px] text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-800">
                          <AlertTriangle className="h-3 w-3 mr-1" /> out of radius {item.visit?.distanceM}m
                        </Badge>
                      )}
                      <VisitChip status={item.visit?.status ?? "PLANNED"} />
                    </span>
                  </div>
                  {item.tasks && <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 whitespace-pre-line line-clamp-2">{item.tasks}</p>}
                  {item.visit && (
                    <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5 text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                      <span>Check-in <b className="text-slate-600 dark:text-slate-300">{new Date(item.visit.checkInAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</b>{item.visit.distanceM != null ? ` · ${item.visit.distanceM}m from center` : ""}</span>
                      {item.visit.checkOutAt && <span>Check-out <b className="text-slate-600 dark:text-slate-300">{new Date(item.visit.checkOutAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</b></span>}
                      {item.visit.durationMin != null && <span>Duration <b className="text-slate-600 dark:text-slate-300">{minutesHHMM(item.visit.durationMin)}</b></span>}
                      {item.visit.remarks && <span className="basis-full text-slate-400 italic truncate">{item.visit.remarks}</span>}
                    </div>
                  )}
                </div>
              ))}
              {(detail?.visits ?? []).filter((v: any) => !v.planItemId).map((v: any) => (
                <div key={v.id} className="rounded-lg border border-dashed border-slate-300 dark:border-slate-700 px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <MapPin className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                    <p className="text-sm font-medium text-slate-700 dark:text-slate-200">{v.locationName}</p>
                    <Badge variant="outline" className="text-[10px]">ad-hoc</Badge>
                    {v.outOfRadius && (
                      <Badge variant="outline" className="text-[10px] text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-800">
                        <AlertTriangle className="h-3 w-3 mr-1" /> out of radius {v.distanceM}m
                      </Badge>
                    )}
                    <span className="ml-auto"><VisitChip status={v.status} /></span>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5 text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                    <span>Check-in <b className="text-slate-600 dark:text-slate-300">{new Date(v.checkInAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</b></span>
                    {v.checkOutAt && <span>Check-out <b className="text-slate-600 dark:text-slate-300">{new Date(v.checkOutAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</b></span>}
                    {v.durationMin != null && <span>Duration <b className="text-slate-600 dark:text-slate-300">{minutesHHMM(v.durationMin)}</b></span>}
                    {v.remarks && <span className="basis-full text-slate-400 italic truncate">{v.remarks}</span>}
                  </div>
                </div>
              ))}
              {(detail?.items ?? []).length === 0 && (detail?.visits ?? []).length === 0 && (
                <EmptyState icon={ClipboardList} title="No stops planned and no visits recorded" />
              )}
            </div>
          )}
        </SectionCard>
      )}
    </div>
  )
}

// ============================================================ PLAN EDITOR

type EditorItem = { id?: string; locationId: string; plannedFrom: string; plannedTo: string; tasks: string }

function PlanEditorTab({ employeeId, date, onTargetChange }: { employeeId: string; date: string; onTargetChange: (employeeId: string, date: string) => void }) {
  const { can, toast } = useHrm()
  const { data: employees } = useEmployeeDirectory()
  // include disabled locations so existing plans that reference them keep a
  // matching Select option (the server validates existence, not activity)
  const { data: locationsData, reload: reloadLocations } = useApi<any>("fieldforce.locations.list", { includeInactive: true })
  const locations = locationsData?.locations ?? []
  const [empId, setEmpId] = useState(employeeId || "")
  const [planDate, setPlanDate] = useState(date || todayIso())
  const [note, setNote] = useState("")
  const [items, setItems] = useState<EditorItem[]>([])
  const [busy, setBusy] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  // 2026-10-13 — map picker: index of the stop row the picker is creating a
  // location for (null = closed). The created VisitLocation is auto-selected
  // for that stop, so a stoppage point + area radius can be chosen directly on
  // the map without leaving the plan editor.
  const [mapPick, setMapPick] = useState<number | null>(null)
  const { data: plan, loading, reload } = useApi<any>(empId ? "fieldforce.plan.get" : null, { date: planDate, employeeId: empId })

  // hydrate the editor ONCE per (employee, date) target — a later reload
  // (after save) must not wipe in-progress edits (FormDialog's open-transition
  // pattern, applied to this inline editor). The response-identity guard
  // prevents a STALE response for the previously selected employee from
  // leaking into the editor while the new one loads.
  const hydratedRef = useRef(false)
  useEffect(() => { hydratedRef.current = false }, [empId, planDate])
  useEffect(() => {
    if (!empId) { setItems([]); setNote(""); return }
    if (!plan || plan.employeeId !== empId || plan.date !== planDate) return
    if (hydratedRef.current) return
    hydratedRef.current = true
    setNote(plan.plan?.note ?? "")
    setItems((plan.items ?? []).map((i: any) => ({
      id: i.id,
      locationId: i.locationId,
      plannedFrom: i.plannedFrom ?? "",
      plannedTo: i.plannedTo ?? "",
      tasks: i.tasks ?? "",
    })))
  }, [empId, planDate, plan])

  const canEdit = can("fieldforce", "edit")
  const activeEmployees = (employees ?? []).filter((e: any) => ["ACTIVE", "PROBATION"].includes(e.status))
  const emp = activeEmployees.find((e: any) => e.id === empId)

  const setItem = (idx: number, patch: Partial<EditorItem>) => {
    setItems((arr) => arr.map((it, i) => (i === idx ? { ...it, ...patch } : it)))
  }

  const save = async () => {
    if (!empId) { toast("Pick an employee first", "err"); return }
    if (items.some((it) => !it.locationId)) { toast("Every stop needs a location", "err"); return }
    setBusy(true)
    try {
      await rpc("fieldforce.plan.save", {
        employeeId: empId,
        date: planDate,
        note: note.trim() || undefined,
        items: items.map((it) => ({
          ...(it.id ? { id: it.id } : {}),
          locationId: it.locationId,
          plannedFrom: it.plannedFrom || undefined,
          plannedTo: it.plannedTo || undefined,
          tasks: it.tasks.trim() || undefined,
        })),
      })
      toast(`Visit plan saved for ${emp?.fullName ?? "employee"} on ${planDate}`)
      await reload()
    } catch (e: any) {
      toast(String(e?.message || e), "err")
    } finally { setBusy(false) }
  }

  const remove = async () => {
    if (!plan?.plan?.id) return
    setBusy(true)
    try {
      await rpc("fieldforce.plan.delete", { id: plan.plan.id })
      toast("Visit plan deleted")
      hydratedRef.current = false
      setItems([])
      setNote("")
      await reload()
    } catch (e: any) {
      toast(String(e?.message || e), "err")
    } finally { setBusy(false) }
  }

  return (
    <div className="space-y-4">
      <SectionCard
        title="Plan Editor"
        actions={empId && canEdit && (
          <div className="flex gap-1.5">
            {plan?.plan?.id && can("fieldforce", "delete") && (
              <Button variant="outline" size="sm" className="h-8 text-xs text-rose-600 hover:text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-950" onClick={() => setDeleteOpen(true)} disabled={busy}>
                <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete Plan
              </Button>
            )}
            <Button size="sm" className="h-8 text-xs" onClick={save} disabled={busy || loading}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5 mr-1" />} Save Plan
            </Button>
          </div>
        )}
      >
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[220px]">
            <Label className="text-xs text-slate-500">Employee</Label>
            <Select value={empId} onValueChange={(v) => { setEmpId(v); onTargetChange(v, planDate) }}>
              <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="Pick employee…" /></SelectTrigger>
              <SelectContent>
                {activeEmployees.map((e: any) => (
                  <SelectItem key={e.id} value={e.id}>{e.fullName} ({e.code})</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs text-slate-500">Date</Label>
            <Input type="date" value={planDate} onChange={(e) => { setPlanDate(e.target.value); onTargetChange(empId, e.target.value) }} className="w-[160px] h-9" />
          </div>
          {loading && <Loader2 className="h-4 w-4 animate-spin text-slate-400 mb-2" />}
          <p className="text-[11px] text-slate-400 ml-auto max-w-xs">
            One plan per employee per day. Stops are synced item-by-item — existing check-ins are preserved.
          </p>
        </div>

        {!empId ? (
          <EmptyState icon={Users} title="Pick an employee to plan their day" hint="Select an employee and a date, then add stops below." />
        ) : (
          <div className="space-y-3 mt-4">
            <div>
              <Label className="text-xs text-slate-500">Plan note (optional)</Label>
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Route A — start from Uttara, avoid morning traffic" className="h-9" disabled={!canEdit} />
            </div>

            {items.map((it, idx) => (
              <div key={idx} className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 grid gap-2 sm:grid-cols-12">
                <div className="sm:col-span-4">
                  <Label className="text-xs text-slate-400">Stop {idx + 1} — location</Label>
                  <div className="flex gap-1.5">
                    <div className="flex-1 min-w-0">
                      <Select value={it.locationId} onValueChange={(v) => setItem(idx, { locationId: v })} disabled={!canEdit}>
                        <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="Pick location…" /></SelectTrigger>
                        <SelectContent>
                          {locations.map((l: any) => (
                            <SelectItem key={l.id} value={l.id}>{l.name}{!l.active ? " (disabled)" : ""}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {/* 2026-10-13 — choose a stoppage location (with area radius)
                        directly on the map instead of picking a master row */}
                    <Button variant="outline" size="icon" type="button" className="h-9 w-9 shrink-0" title="Choose stoppage location on the map" aria-label={`Choose stoppage location for stop ${idx + 1} on the map`} disabled={!canEdit} onClick={() => setMapPick(idx)}>
                      <MapPinned className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <div className="sm:col-span-2">
                  <Label className="text-xs text-slate-400">From</Label>
                  <Input type="time" value={it.plannedFrom} onChange={(e) => setItem(idx, { plannedFrom: e.target.value })} className="h-9" disabled={!canEdit} />
                </div>
                <div className="sm:col-span-2">
                  <Label className="text-xs text-slate-400">To</Label>
                  <Input type="time" value={it.plannedTo} onChange={(e) => setItem(idx, { plannedTo: e.target.value })} className="h-9" disabled={!canEdit} />
                </div>
                <div className="sm:col-span-3">
                  <Label className="text-xs text-slate-400">Tasks</Label>
                  <Input value={it.tasks} onChange={(e) => setItem(idx, { tasks: e.target.value })} placeholder="e.g. Stock check + collect payment" className="h-9" disabled={!canEdit} />
                </div>
                <div className="sm:col-span-1 flex items-end justify-end">
                  <Button variant="ghost" size="icon" className="h-9 w-9 text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950"
                    aria-label={`Remove stop ${idx + 1}`} disabled={!canEdit} onClick={() => setItems((arr) => arr.filter((_, i) => i !== idx))}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}

            <Button variant="outline" size="sm" className="h-9" disabled={!canEdit} onClick={() => setItems((arr) => [...arr, { locationId: "", plannedFrom: "", plannedTo: "", tasks: "" }])}>
              <Plus className="h-3.5 w-3.5 mr-1.5" /> Add Stop
            </Button>
            {locations.length === 0 && (
              <p className="text-xs text-amber-600 dark:text-amber-400">No visit locations yet — add a stop and use its map button to place the first stoppage point, or create locations in the Locations tab.</p>
            )}
          </div>
        )}
      </SectionCard>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete this visit plan?"
        message={`The plan for ${emp?.fullName ?? "the employee"} on ${fmtDate(planDate)} and all its stops will be removed. Recorded visits are kept (history), but missed-visit tracking stops.`}
        confirmLabel="Delete Plan"
        danger
        onConfirm={remove}
      />

      {/* 2026-10-13 — stoppage-location map picker for the stop row `mapPick`.
          The dialog creates a VisitLocation (pin + area radius on the live
          map); the created row is auto-selected for that stop. */}
      <LocationMapDialog
        open={mapPick !== null}
        initial={mapPick !== null ? {} : null}
        onClose={() => setMapPick(null)}
        onSaved={(savedRow) => {
          if (mapPick != null && savedRow?.id) setItem(mapPick, { locationId: savedRow.id })
          reloadLocations()
        }}
      />
    </div>
  )
}

// ============================================================ LOCATIONS

/** R9 (2026-10-12) — full map-picker dialog for visit locations. Replaces the
 *  old plain lat/lng number inputs with: (a) address search (server-side
 *  Nominatim proxy `fieldforce.geo.search`), (b) click-to-place /
 *  draggable circle on the live map, (c) two-way synced coordinate inputs
 *  with range validation, (d) radius slider + presets. The circle is the
 *  check-in radius the server enforces on fieldforce.visit.checkin. */
function LocationMapDialog({
  open, initial, onClose, onSaved,
}: {
  open: boolean
  initial: any | null // {} = new, row = edit, null = closed
  onClose: () => void
  /** 2026-10-13 — receives the saved VisitLocation row, so the plan editor's
   * stop picker can auto-select the freshly created location. */
  onSaved: (savedRow?: any) => void
}) {
  const { toast } = useHrm()
  const editing = !!initial?.id
  const [name, setName] = useState("")
  const [address, setAddress] = useState("")
  const [lat, setLat] = useState(23.8103)
  const [lng, setLng] = useState(90.4125)
  const [radiusM, setRadiusM] = useState(150)
  const [contactName, setContactName] = useState("")
  const [contactPhone, setContactPhone] = useState("")
  const [note, setNote] = useState("")
  const [active, setActive] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // ---- address search state (R9) ----
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<{ label: string; lat: number; lng: number }[]>([])
  const [searching, setSearching] = useState(false)
  const [searchErr, setSearchErr] = useState<string | null>(null)

  useEffect(() => {
    if (open && initial) {
      setName(initial.name || "")
      setAddress(initial.address || "")
      setLat(Number.isFinite(initial.lat) ? Number(initial.lat) : 23.8103)
      setLng(Number.isFinite(initial.lng) ? Number(initial.lng) : 90.4125)
      setRadiusM(Number.isFinite(initial.radiusM) ? Math.round(initial.radiusM) : 150)
      setContactName(initial.contactName || "")
      setContactPhone(initial.contactPhone || "")
      setNote(initial.note || "")
      setActive(initial.active !== false)
      setErr(null)
      setQuery(""); setResults([]); setSearchErr(null)
    }
  }, [open, initial])

  const runSearch = async () => {
    const q = query.trim()
    if (q.length < 3) { setSearchErr("Type at least 3 characters to search"); return }
    setSearching(true); setSearchErr(null); setResults([])
    try {
      const res = await rpc<{ results: { label: string; lat: number; lng: number }[] }>("fieldforce.geo.search", { q })
      setResults(res.results || [])
      if (!res.results?.length) setSearchErr("No matching place found — try a nearby landmark or type the coordinates")
    } catch (e: any) {
      setSearchErr(e.message || "Address search failed")
    } finally { setSearching(false) }
  }

  const pick = (r: { label: string; lat: number; lng: number }) => {
    setLat(r.lat); setLng(r.lng)
    if (!address) setAddress(r.label.split(",").slice(0, 3).join(",").trim())
    setResults([]); setQuery("")
    toast(`Moved to ${r.lat.toFixed(5)}, ${r.lng.toFixed(5)} — fine-tune by clicking the map`)
  }

  const submit = async () => {
    setErr(null)
    // client-side mirror of the server zod contract (clean messages, not 400s)
    if (!name.trim()) { setErr("Location name is required"); return }
    const la = Number(lat), lo = Number(lng)
    if (!Number.isFinite(la) || la < -90 || la > 90) { setErr("Latitude must be a decimal between -90 and 90"); return }
    if (!Number.isFinite(lo) || lo < -180 || lo > 180) { setErr("Longitude must be a decimal between -180 and 180"); return }
    const r = Math.round(Number(radiusM))
    if (!Number.isFinite(r) || r < 10 || r > 5000) { setErr("Check-in radius must be between 10 and 5000 m"); return }
    setBusy(true)
    try {
      const savedRow = await rpc<any>("fieldforce.locations.save", {
        ...(editing ? { id: initial.id } : {}),
        name: name.trim(),
        address: address.trim() || undefined,
        lat: la, lng: lo, radiusM: r,
        contactName: contactName.trim() || undefined,
        contactPhone: contactPhone.trim() || undefined,
        note: note.trim() || undefined,
        active,
      })
      toast(editing ? `Updated ${name.trim()}` : `Created ${name.trim()}`)
      onSaved(savedRow)
      onClose()
    } catch (e: any) {
      setErr(e.message || "Could not save the location")
    } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !busy) onClose() }}>
      <DialogContent className="sm:max-w-4xl md:max-w-5xl lg:max-w-6xl w-[95vw] max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit Location — ${initial?.name}` : "New Visit Location"}</DialogTitle>
          <DialogDescription>
            Search an address or click the map to place the check-in point. Field employees can only check in within the circle (server-verified).
          </DialogDescription>
        </DialogHeader>

        {err && <ErrorBanner message={err} />}

        <div className="grid gap-6 md:grid-cols-2 mt-1">
          {/* ---- left: fields ---- */}
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Location name <span className="text-rose-500">*</span></Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Rangs Bazaar Outlet" className="mt-1" />
            </div>

            {/* R9 — address search */}
            <div>
              <Label className="text-xs">Find address (places the pin)</Label>
              <div className="mt-1 flex gap-1.5">
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); runSearch() } }}
                  placeholder="e.g. Dhanmondi 27, Dhaka"
                />
                <Button type="button" size="sm" className="h-9 px-3" onClick={runSearch} disabled={searching || query.trim().length < 3}>
                  {searching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MapPinned className="h-3.5 w-3.5" />}
                </Button>
              </div>
              {searchErr && <p className="mt-1 text-[11px] text-amber-600">{searchErr}</p>}
              {results.length > 0 && (
                <div className="mt-1.5 rounded-lg border border-slate-200 dark:border-slate-700 divide-y divide-slate-100 dark:divide-slate-800 max-h-40 overflow-y-auto">
                  {results.map((r, i) => (
                    <button key={i} type="button" onClick={() => pick(r)}
                      className="w-full text-left px-2.5 py-2 text-xs hover:bg-emerald-50 dark:hover:bg-emerald-950/40 text-slate-600 dark:text-slate-300">
                      <span className="font-medium text-slate-800 dark:text-slate-100">{r.label.split(",")[0]}</span>
                      <span className="block text-[10px] truncate text-slate-400">{r.label} · {r.lat.toFixed(4)}, {r.lng.toFixed(4)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div>
              <Label className="text-xs">Address (optional)</Label>
              <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Street, area, city" className="mt-1" />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Latitude <span className="text-rose-500">*</span></Label>
                <Input type="number" step="0.00001" value={Number.isFinite(lat as number) ? lat : ""} onChange={(e) => setLat(e.target.value === "" ? NaN : Number(e.target.value))} className="mt-1 tabular-nums" />
              </div>
              <div>
                <Label className="text-xs">Longitude <span className="text-rose-500">*</span></Label>
                <Input type="number" step="0.00001" value={Number.isFinite(lng as number) ? lng : ""} onChange={(e) => setLng(e.target.value === "" ? NaN : Number(e.target.value))} className="mt-1 tabular-nums" />
              </div>
            </div>

            <div>
              <Label className="text-xs">Check-in radius: <b className="tabular-nums">{Math.round(radiusM)} m</b></Label>
              <input type="range" min={10} max={2000} step={10} value={radiusM} onChange={(e) => setRadiusM(Number(e.target.value))} className="w-full accent-teal-600 mt-1" />
              <div className="flex flex-wrap gap-1.5 mt-1">
                {[50, 100, 150, 300, 500, 1000].map((r) => (
                  <button key={r} type="button" onClick={() => setRadiusM(r)}
                    className={`text-[11px] px-2 py-0.5 rounded-full border ${radiusM === r ? "border-teal-500 bg-teal-50 dark:bg-teal-950 text-teal-700 dark:text-teal-300" : "border-slate-200 dark:border-slate-700 text-slate-500"}`}>
                    {r}m
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Contact person</Label>
                <Input value={contactName} onChange={(e) => setContactName(e.target.value)} className="mt-1" />
              </div>
              <div>
                <Label className="text-xs">Contact phone</Label>
                <Input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="+8801…" className="mt-1 tabular-nums" />
              </div>
            </div>

            <div>
              <Label className="text-xs">Note</Label>
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className="mt-1" />
            </div>

            <div className="flex items-center gap-2">
              <Switch checked={active} onCheckedChange={setActive} />
              <Label className="text-xs">{active ? "Active (available for planning & check-in)" : "Disabled"}</Label>
            </div>
          </div>

          {/* ---- right: the map ---- */}
          <div className="space-y-2">
            <MapCanvas
              center={[Number.isFinite(lat as number) ? lat : 23.8103, Number.isFinite(lng as number) ? lng : 90.4125]}
              zoom={15}
              editableCircle={{
                latitude: Number.isFinite(lat as number) ? lat : 23.8103,
                longitude: Number.isFinite(lng as number) ? lng : 90.4125,
                radiusM: Math.round(radiusM) || 150,
              }}
              onCircleChange={(pos) => { setLat(Number(pos.latitude.toFixed(7))); setLng(Number(pos.longitude.toFixed(7))) }}
              onMapClick={(pos) => { setLat(Number(pos.latitude.toFixed(7))); setLng(Number(pos.longitude.toFixed(7))) }}
              style={{ height: 420 }}
            />
            <p className="text-[11px] text-slate-400 flex items-start gap-1.5">
              <MapPin className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              Click the map (or drag the pin) to move the check-in center; drag the circle edge to resize the radius. Coordinates update live on the left.
            </p>
          </div>
        </div>

        <DialogFooter className="mt-2 gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-1.5" />}
            {editing ? "Save Changes" : "Create Location"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function LocationsTab() {
  const { can, toast } = useHrm()
  const { data, loading, error, reload } = useApi<any>("fieldforce.locations.list", { includeInactive: true })
  const [editing, setEditing] = useState<any | null>(null) // {} = new, row = edit
  const [deleting, setDeleting] = useState<any | null>(null)
  const [showDisabled, setShowDisabled] = useState(true)

  const all: any[] = data?.locations ?? []
  const rows = showDisabled ? all : all.filter((l) => l.active)

  const columns: Column<any>[] = [
    {
      key: "name", label: "Location", sortValue: (l) => l.name,
      render: (l) => (
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{l.name} {!l.active && <Badge variant="outline" className="ml-1 text-[10px] text-slate-400">disabled</Badge>}</p>
          {l.address && <p className="text-[11px] text-slate-400 truncate max-w-[260px]">{l.address}</p>}
        </div>
      ),
    },
    { key: "coords", label: "Coordinates", sortValue: (l) => l.lat, searchValue: (l) => `${l.lat}, ${l.lng}`, render: (l) => <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">{l.lat.toFixed(5)}, {l.lng.toFixed(5)}</span> },
    { key: "radiusM", label: "Radius", align: "right", sortValue: (l) => l.radiusM, render: (l) => <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300">{Math.round(l.radiusM)} m</span> },
    {
      key: "contact", label: "Contact", searchValue: (l) => `${l.contactName ?? ""} ${l.contactPhone ?? ""}`,
      render: (l) => l.contactName || l.contactPhone ? (
        <div className="text-xs text-slate-500 dark:text-slate-400">
          {l.contactName && <p>{l.contactName}</p>}
          {l.contactPhone && <p className="tabular-nums">{l.contactPhone}</p>}
        </div>
      ) : <span className="text-xs text-slate-400">—</span>,
    },
    { key: "active", label: "Status", align: "center", sortValue: (l) => (l.active ? 1 : 0), render: (l) => <StatusBadge status={l.active ? "ACTIVE" : "INACTIVE"} /> },
    {
      key: "actions", label: "", align: "right",
      render: (l) => (
        <div className="flex justify-end gap-1">
          {can("fieldforce", "edit") && (
            <Button variant="ghost" size="sm" className="h-7 px-2" title="Edit location" onClick={() => setEditing(l)}>Edit</Button>
          )}
          {can("fieldforce", "delete") && l.active && (
            <Button variant="ghost" size="sm" className="h-7 px-2 text-rose-500 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950" title="Disable location" onClick={() => setDeleting(l)}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      ),
    },
  ]

  const markers = rows.filter((l) => Number.isFinite(l.lat) && Number.isFinite(l.lng)).map((l) => ({
    id: l.id,
    latitude: l.lat,
    longitude: l.lng,
    circle: { radiusM: l.radiusM, color: l.active ? "#0d9488" : "#94a3b8" },
    popup: `<div style="font-family:system-ui;font-size:11px"><b>${esc(l.name)}</b><br/>r=${Math.round(l.radiusM)}m${l.address ? `<br/>${esc(l.address)}` : ""}${l.active ? "" : "<br/><i>disabled</i>"}</div>`,
  }))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={showDisabled ? "all" : "active"} onValueChange={(v) => setShowDisabled(v === "all")}>
          <SelectTrigger className="w-44 h-9 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Active + disabled</SelectItem>
            <SelectItem value="active">Active only</SelectItem>
          </SelectContent>
        </Select>
        {can("fieldforce", "edit") && (
          <Button size="sm" className="h-9" onClick={() => setEditing({})}>
            <Plus className="h-3.5 w-3.5 mr-1.5" /> New Location
          </Button>
        )}
      </div>

      {rows.length > 0 && (
        <SectionCard title={<span>Location map <span className="text-slate-400 font-normal">· {rows.length} plotted · circles are check-in radii</span></span>}>
          <MapCanvas
            center={markers.length ? [markers[0].latitude, markers[0].longitude] : undefined}
            zoom={11}
            markers={markers}
            style={{ height: 320 }}
          />
        </SectionCard>
      )}

      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        error={error}
        searchable
        searchPlaceholder="Search name / address / contact…"
        emptyTitle="No visit locations yet"
        emptyHint="Create the client sites your field team visits — search an address, place the pin on the map and set a check-in radius."
        csvName="field-force-locations"
      />

      {/* R9 — map-picker dialog replaces the plain lat/lng FormDialog */}
      <LocationMapDialog
        open={!!editing}
        initial={editing}
        onClose={() => setEditing(null)}
        onSaved={reload}
      />

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => { if (!v) setDeleting(null) }}
        title={`Disable “${deleting?.name}”?`}
        message="The location is soft-deleted (set inactive): existing plans and visit history are preserved, but it can no longer be planned or checked into."
        confirmLabel="Disable Location"
        danger
        onConfirm={async () => {
          if (!deleting) return
          await rpc("fieldforce.locations.delete", { id: deleting.id })
          toast(`Disabled ${deleting.name}`)
          reload()
        }}
      />
    </div>
  )
}

// ============================================================ REPORTS

function ReportTab() {
  const { data: employees } = useEmployeeDirectory()
  const [from, setFrom] = useState(plusMonth(todayIso()))
  const [to, setTo] = useState(todayIso())
  const [employeeId, setEmployeeId] = useState("all")
  const { data, loading, error } = useApi<any>("fieldforce.report", { from, to, employeeId: employeeId === "all" ? null : employeeId })
  // 2026-10-14 — per-employee Location Hit Map from the Reports breakdown:
  // date chooser state (employee preselected, date defaults to the range end)
  // + the open HitMapDialog target.
  const [pick, setPick] = useState<{ employeeId: string; employeeName: string } | null>(null)
  const [pickDate, setPickDate] = useState<string>(todayIso())
  const [hitmap, setHitmap] = useState<{ employeeId: string; employeeName: string; date: string } | null>(null)

  const s = data?.summary
  const columns: Column<any>[] = [
    {
      key: "fullName", label: "Employee", sortValue: (r) => r.fullName,
      render: (r) => (
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{r.fullName}</p>
          <p className="text-[11px] text-slate-400">{r.code} · {r.designation}</p>
        </div>
      ),
    },
    { key: "planned", label: "Planned", align: "right", sortValue: (r) => r.planned, render: (r) => <span className="text-xs font-bold tabular-nums">{r.planned}</span> },
    { key: "completed", label: "Completed", align: "right", sortValue: (r) => r.completed, render: (r) => <span className="text-xs font-bold tabular-nums text-emerald-600 dark:text-emerald-400">{r.completed}</span> },
    { key: "missed", label: "Missed", align: "right", sortValue: (r) => r.missed, render: (r) => <span className={`text-xs font-bold tabular-nums ${r.missed ? "text-rose-600 dark:text-rose-400" : ""}`}>{r.missed}</span> },
    { key: "adHoc", label: "Ad-hoc", align: "right", sortValue: (r) => r.adHoc, render: (r) => <span className="text-xs tabular-nums text-slate-500">{r.adHoc}</span> },
    { key: "coverage", label: "Locations", align: "right", sortValue: (r) => r.coverage, render: (r) => <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300">{r.coverage}</span> },
    { key: "avgDurationMin", label: "Avg time", align: "right", sortValue: (r) => r.avgDurationMin ?? 0, render: (r) => <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300">{r.avgDurationMin != null ? minutesHHMM(r.avgDurationMin) : "—"}</span> },
    {
      key: "compliancePct", label: "Compliance", align: "right", sortValue: (r) => r.compliancePct,
      render: (r) => {
        const tone = r.planned === 0 ? "bg-slate-400" : r.compliancePct >= 80 ? "bg-emerald-500" : r.compliancePct >= 50 ? "bg-amber-500" : "bg-rose-500"
        return (
          <div className="flex items-center justify-end gap-2 min-w-[86px]">
            <div className="flex-1 h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden max-w-[54px]">
              <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, r.compliancePct)}%` }} />
            </div>
            <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300 w-11 text-right">{r.planned ? `${r.compliancePct}%` : "—"}</span>
          </div>
        )
      },
    },
    {
      // 2026-10-14 — view the employee's dotted GPS trail (day replay) from
      // the Reports breakdown: opens a date chooser, then the Hit Map dialog
      key: "actions", label: "", align: "right",
      render: (r) => (
        <Button variant="outline" size="sm" className="h-8 text-xs whitespace-nowrap"
          title={`View ${r.fullName}'s location hit map (dotted GPS trail + stoppages)`}
          onClick={() => { setPickDate(to || todayIso()); setPick({ employeeId: r.employeeId, employeeName: r.fullName }) }}>
          <Route className="h-3.5 w-3.5 mr-1 text-teal-600" /> View Location Hit Map
        </Button>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <Label className="text-xs text-slate-500">From</Label>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-[150px] h-9" />
        </div>
        <div>
          <Label className="text-xs text-slate-500">To</Label>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-[150px] h-9" />
        </div>
        <Select value={employeeId} onValueChange={setEmployeeId}>
          <SelectTrigger className="w-52 h-9 text-xs"><SelectValue placeholder="Employee" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All employees in my scope</SelectItem>
            {(employees ?? []).map((e: any) => (
              <SelectItem key={e.id} value={e.id}>{e.fullName} ({e.code})</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
        <StatCard label="Compliance" value={s ? `${s.compliancePct}%` : "—"} icon={BarChart3} tone="emerald" sub="completed vs planned stops" />
        <StatCard label="Planned stops" value={s?.planned ?? 0} icon={ClipboardList} tone="violet" />
        <StatCard label="Completed" value={s?.completed ?? 0} icon={CheckCircle2} tone="teal" sub={s ? `${s.completedPlanned} planned + ${s.completed - s.completedPlanned} ad-hoc` : undefined} />
        <StatCard label="Missed" value={s?.missed ?? 0} icon={AlertTriangle} tone="rose" sub="window passed, no check-in" />
        <StatCard label="Coverage" value={s?.coverage ?? 0} icon={MapPinned} tone="sky" sub="distinct locations visited" />
        <StatCard label="Avg visit time" value={s?.avgDurationMin != null ? minutesHHMM(s.avgDurationMin) : "—"} icon={Clock} tone="slate" sub="check-in → check-out" />
      </div>

      <DataTable
        columns={columns}
        rows={data?.rows ?? []}
        loading={loading}
        error={error}
        searchable
        searchPlaceholder="Search employee…"
        emptyTitle="No visit activity in this range"
        emptyHint="Plan visits and let the field team check in with GPS — compliance lands here."
        csvName="field-force-report"
      />

      {/* 2026-10-14 — date chooser before opening the hit map from a Reports
          row: the report itself aggregates a whole range, the hit map replays
          ONE day, so the admin picks which day to replay (defaults to the
          range end, clamped inside the report range). */}
      <Dialog open={!!pick} onOpenChange={(v) => { if (!v) setPick(null) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              <Route className="h-4 w-4 text-teal-600" /> Location Hit Map — {pick?.employeeName}
            </DialogTitle>
            <DialogDescription>
              Pick the day to replay: the map shows that day&apos;s dotted GPS trail with the duration of every stoppage.
            </DialogDescription>
          </DialogHeader>
          <div>
            <Label className="text-xs text-slate-500">Day</Label>
            <Input
              type="date"
              value={pickDate}
              min={from || undefined}
              max={to || todayIso()}
              onChange={(e) => setPickDate(e.target.value)}
              className="w-[180px] h-9 mt-1"
            />
            <p className="text-[11px] text-slate-400 mt-1.5">
              Clamped to the report range {from ? fmtDate(from) : "—"} → {to ? fmtDate(to) : "—"}. GPS data comes from live tracking (seed demo data included).
            </p>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setPick(null)}>Cancel</Button>
            <Button disabled={!pickDate} onClick={() => {
              if (pick && pickDate) {
                setHitmap({ employeeId: pick.employeeId, employeeName: pick.employeeName, date: pickDate })
                setPick(null)
              }
            }}>
              <MapPinned className="h-4 w-4 mr-1.5" /> Open Hit Map
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {hitmap && (
        <HitMapDialog
          employeeId={hitmap.employeeId}
          employeeName={hitmap.employeeName}
          date={hitmap.date}
          onClose={() => setHitmap(null)}
        />
      )}
    </div>
  )
}

// ============================================================ HISTORY (Employee)

/** N business days back as an ISO date (client-side companion of plusMonth). */
function minusDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00")
  d.setDate(d.getDate() - days)
  return d.toISOString().slice(0, 10)
}

/** History → Employee: one row per (employee, business date) plan inside the
 * selected range — separate rows for different dates — each with a
 * "View Location Hit Map" action that replays the day on the map. */
function HistoryTab({ presetEmployeeId }: { presetEmployeeId?: string | null }) {
  const { data: employees } = useEmployeeDirectory()
  const [from, setFrom] = useState(minusDaysIso(todayIso(), 6))
  const [to, setTo] = useState(todayIso())
  // 2026-10-14 — Employee Actions deep link: start filtered to the linked
  // employee (the operator can widen the filter again at any time).
  const [employeeId, setEmployeeId] = useState(presetEmployeeId || "all")
  const [hitmap, setHitmap] = useState<{ employeeId: string; employeeName: string; date: string } | null>(null)
  const { data, loading, error } = useApi<any>("fieldforce.history", { from, to, employeeId: employeeId === "all" ? null : employeeId })

  const s = data?.summary
  const columns: Column<any>[] = [
    {
      key: "fullName", label: "Employee", sortValue: (r) => r.fullName,
      render: (r) => (
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{r.fullName}</p>
          <p className="text-[11px] text-slate-400">{r.code} · {r.designation}</p>
        </div>
      ),
    },
    { key: "date", label: "Date", sortValue: (r) => r.date, render: (r) => <span className="text-xs font-medium text-slate-700 dark:text-slate-200 whitespace-nowrap">{fmtDate(r.date)}</span> },
    { key: "planned", label: "Stops", align: "right", sortValue: (r) => r.planned, render: (r) => <span className="text-xs font-bold tabular-nums">{r.planned}</span> },
    { key: "completed", label: "Completed", align: "right", sortValue: (r) => r.completed, render: (r) => <span className="text-xs font-bold tabular-nums text-emerald-600 dark:text-emerald-400">{r.completed}</span> },
    { key: "missed", label: "Missed", align: "right", sortValue: (r) => r.missed, render: (r) => <span className={`text-xs font-bold tabular-nums ${r.missed ? "text-rose-600 dark:text-rose-400" : ""}`}>{r.missed}</span> },
    { key: "adHoc", label: "Ad-hoc", align: "right", sortValue: (r) => r.adHoc, render: (r) => <span className="text-xs tabular-nums text-slate-500">{r.adHoc}</span> },
    { key: "gpsPings", label: "GPS pings", align: "right", sortValue: (r) => r.gpsPings, render: (r) => <span className="text-xs tabular-nums text-slate-500" title="Location updates recorded this day">{r.gpsPings || "—"}</span> },
    {
      key: "lastActivityAt", label: "Last activity", sortValue: (r) => r.lastActivityAt ?? "",
      render: (r) => <span className="text-xs text-slate-500 whitespace-nowrap">{r.lastActivityAt ? new Date(r.lastActivityAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}</span>,
    },
    {
      key: "actions", label: "", align: "right",
      render: (r) => (
        <Button variant="outline" size="sm" className="h-8 text-xs whitespace-nowrap" onClick={() => setHitmap({ employeeId: r.employeeId, employeeName: r.fullName, date: r.date })}>
          <Route className="h-3.5 w-3.5 mr-1 text-teal-600" /> View Location Hit Map
        </Button>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <Label className="text-xs text-slate-500">From</Label>
          <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="w-[150px] h-9" />
        </div>
        <div>
          <Label className="text-xs text-slate-500">To</Label>
          <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="w-[150px] h-9" />
        </div>
        <Select value={employeeId} onValueChange={setEmployeeId}>
          <SelectTrigger className="w-52 h-9 text-xs"><SelectValue placeholder="Employee" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All employees in my scope</SelectItem>
            {(employees ?? []).map((e: any) => (
              <SelectItem key={e.id} value={e.id}>{e.fullName} ({e.code})</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-slate-400 ml-auto max-w-xs">
          Employee visit plans in the range — one row per employee per day, newest first.
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
        <StatCard label="Employees" value={s?.employees ?? 0} icon={Users} tone="emerald" />
        <StatCard label="Days" value={s?.days ?? 0} icon={CalendarDays} tone="violet" />
        <StatCard label="Planned stops" value={s?.planned ?? 0} icon={ClipboardList} tone="violet" />
        <StatCard label="Completed" value={s?.completed ?? 0} icon={CheckCircle2} tone="teal" />
        <StatCard label="Missed" value={s?.missed ?? 0} icon={AlertTriangle} tone="rose" />
        <StatCard label="GPS pings" value={s?.gpsPings ?? 0} icon={MapPin} tone="sky" sub="tracking updates in range" />
      </div>

      <DataTable
        columns={columns}
        rows={data?.rows ?? []}
        loading={loading}
        error={error}
        searchable
        searchPlaceholder="Search employee…"
        emptyTitle="No field activity in this range"
        emptyHint="Plans, GPS-validated check-ins and ad-hoc visits land here — one row per employee per day."
        csvName="field-force-history"
      />

      {hitmap && (
        <HitMapDialog
          employeeId={hitmap.employeeId}
          employeeName={hitmap.employeeName}
          date={hitmap.date}
          onClose={() => setHitmap(null)}
        />
      )}
    </div>
  )
}

// ============================================================ LOCATION HIT MAP

const HITMAP_TONES: Record<string, string> = {
  PLANNED: "#64748b",
  CHECKED_IN: "#0284c7",
  COMPLETED: "#059669",
  MISSED: "#e11d48",
  CANCELLED: "#94a3b8",
  STOP: "#d97706", // derived (unplanned) stoppage
}

/** Numbered map pin (divIcon HTML). */
function hitPin(label: string, color: string, size = 22): string {
  return `<div style="width:${size}px;height:${size}px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:${color};border:2px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center"><span style="transform:rotate(45deg);color:#fff;font-size:10px;font-weight:700;line-height:1">${label}</span></div>`
}

function hhmmssOf(iso: string | null | undefined): string {
  if (!iso) return "—"
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

export function HitMapDialog({
  employeeId,
  employeeName,
  date: initialDate,
  onClose,
}: {
  employeeId: string
  employeeName: string
  date?: string
  onClose: () => void
}) {
  const [date, setDate] = useState(initialDate || new Date().toISOString().slice(0, 10))
  const { data, loading, error } = useApi<any>("fieldforce.hitmap", { employeeId, date })

  // everything derives from `data` in ONE memo (React-Compiler-friendly:
  // no manual memo over values computed outside it)
  const view = useMemo(() => {
    const planned: any[] = data?.planned ?? []
    const visits: any[] = data?.visits ?? []
    const stops: any[] = data?.stops ?? []
    const track: any[] = data?.track ?? []
    const markers: any[] = []
    // planned stops: numbered pin + dashed circle of the check-in radius
    planned.forEach((p, i) => {
      if (p.lat == null || p.lng == null) return
      const tone = HITMAP_TONES[p.visitStatus] ?? HITMAP_TONES.PLANNED
      markers.push({
        id: `plan-${p.id}`,
        latitude: p.lat, longitude: p.lng,
        circle: { radiusM: p.radiusM ?? 150, color: tone, fillColor: tone },
        html: hitPin(String(i + 1), tone),
        popup: `<b>${esc(p.locationName)}</b><br/>Planned ${p.plannedFrom ?? "—"}–${p.plannedTo ?? "—"}` +
          (p.tasks ? `<br/><span style="color:#64748b">${esc(p.tasks)}</span>` : "") +
          (p.visitStatus !== "PLANNED"
            ? `<br/>${titleCase(p.visitStatus)}${p.durationMin != null ? ` · ${minutesHHMM(p.durationMin)}` : ""}` +
              (p.distanceM != null ? `<br/>Check-in ${p.distanceM} m from center${p.outOfRadius ? " · <b style=\"color:#e11d48\">out of radius</b>" : ""}` : "")
            : "<br/><span style=\"color:#94a3b8\">no check-in recorded</span>"),
      })
    })
    // recorded visits: pin at the check-in position with the stop duration
    visits.forEach((v, i) => {
      if (v.checkInLat == null || v.checkInLng == null) return
      const tone = HITMAP_TONES[v.status] ?? HITMAP_TONES.PLANNED
      markers.push({
        id: `visit-${v.id}`,
        latitude: v.checkInLat, longitude: v.checkInLng,
        html: hitPin(`${planned.length + i + 1}`, tone),
        popup: `<b>${esc(v.locationName ?? "Visit")}</b> · ${titleCase(v.status)}` +
          `<br/>In ${hhmmssOf(v.checkInAt)} → Out ${hhmmssOf(v.checkOutAt)}` +
          (v.durationMin != null ? `<br/>Stop duration: <b>${minutesHHMM(v.durationMin)}</b>` : "") +
          (v.distanceM != null ? `<br/>${v.distanceM} m from center${v.outOfRadius ? " · <b style=\"color:#e11d48\">out of radius</b>" : ""}` : ""),
      })
    })
    // derived (unplanned) stoppages: amber dot with the duration
    stops.forEach((s, i) => {
      markers.push({
        id: `stop-${i}`,
        latitude: s.lat, longitude: s.lng,
        circle: { radiusM: 75, color: HITMAP_TONES.STOP, fillColor: HITMAP_TONES.STOP },
        html: hitPin("S", HITMAP_TONES.STOP, 18),
        popup: `<b>Unplanned stoppage</b><br/>${hhmmssOf(s.from)} → ${hhmmssOf(s.to)}` +
          `<br/>Duration: <b>${minutesHHMM(s.durationMin)}</b> (${s.pointCount} GPS fixes)`,
      })
    })
    // the GPS trace itself: tiny dots chained into the dashed polyline
    track.forEach((t, i) => {
      markers.push({
        id: `tr-${i}`,
        latitude: t.lat, longitude: t.lng,
        lineGroup: "track",
        html: `<div style="width:6px;height:6px;border-radius:50%;background:#0d9488;border:1px solid #fff;opacity:.85"></div>`,
        popup: `GPS ${hhmmssOf(t.at)}${t.acc != null ? ` · ±${Math.round(t.acc)} m` : ""}${t.batt != null ? ` · battery ${t.batt}%` : ""}`,
      })
    })
    // viewport: every positioned thing
    const fitTo: [number, number][] = []
    for (const p of planned) if (p.lat != null && p.lng != null) fitTo.push([p.lat, p.lng])
    for (const v of visits) if (v.checkInLat != null && v.checkInLng != null) fitTo.push([v.checkInLat, v.checkInLng])
    for (const s of stops) fitTo.push([s.lat, s.lng])
    for (const t of track) fitTo.push([t.lat, t.lng])
    // chronological stoppage list (recorded visits with a check-out + derived)
    const stoppageList: { kind: string; name: string; from: string | null; to: string | null; durationMin: number | null; extra?: string }[] = []
    for (const p of planned) {
      if (p.visitStatus === "PLANNED" || p.visitStatus === "MISSED") continue
      stoppageList.push({
        kind: p.visitStatus, name: p.locationName,
        from: p.checkInAt, to: p.checkOutAt, durationMin: p.durationMin,
        extra: p.outOfRadius ? "out of radius" : undefined,
      })
    }
    for (const v of visits) {
      if (v.planItemId != null) continue // already listed through its planned stop
      stoppageList.push({
        kind: v.status, name: `${v.locationName ?? "Ad-hoc visit"} (ad-hoc)`,
        from: v.checkInAt, to: v.checkOutAt, durationMin: v.durationMin,
        extra: v.outOfRadius ? "out of radius" : undefined,
      })
    }
    for (const s of stops) {
      stoppageList.push({ kind: "STOP", name: "Unplanned stoppage", from: s.from, to: s.to, durationMin: s.durationMin })
    }
    stoppageList.sort((a, b) => String(a.from ?? "").localeCompare(String(b.from ?? "")))
    return { planned, visits, stops, track, markers, fitTo, stoppageList }
  }, [data])

  const { planned, visits, markers, fitTo, stoppageList } = view
  const summary = data?.summary

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="sm:max-w-4xl md:max-w-5xl lg:max-w-6xl xl:max-w-7xl w-[96vw] max-h-[94vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex flex-wrap items-center justify-between gap-3 pr-6">
            <DialogTitle className="text-base flex items-center gap-2">
              <Route className="h-4 w-4 text-teal-600" /> Location Hit Map — {employeeName} · {fmtDate(date)}
            </DialogTitle>
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-slate-500 whitespace-nowrap">Date:</Label>
              <Input
                type="date"
                value={date}
                max={new Date().toISOString().slice(0, 10)}
                onChange={(e) => setDate(e.target.value)}
                className="h-8 w-36 text-xs tabular-nums"
              />
            </div>
          </div>
          <DialogDescription>
            Dotted line: the day&apos;s GPS tracking trail. Numbered pins: planned stops and visits (popups show every stoppage&apos;s duration). Amber &quot;S&quot; pins: stoppages detected in the trail without a recorded visit.
          </DialogDescription>
        </DialogHeader>

        {error && <ErrorBanner message={error} />}
        {loading ? (
          <div className="py-16 text-center text-xs text-slate-400 flex items-center justify-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Assembling the day&apos;s track…
          </div>
        ) : (
          <>
            {/* summary strip */}
            <div className="flex flex-wrap gap-1.5 text-[11px]">
              <span className="rounded-full px-2.5 py-0.5 font-medium bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">{summary?.totalPings ?? 0} GPS fixes</span>
              <span className="rounded-full px-2.5 py-0.5 font-medium bg-teal-50 text-teal-700 dark:bg-teal-950 dark:text-teal-300">{summary?.trackKm ?? 0} km travelled</span>
              <span className="rounded-full px-2.5 py-0.5 font-medium bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300">{summary?.planned ?? 0} planned</span>
              <span className="rounded-full px-2.5 py-0.5 font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">{summary?.completed ?? 0} completed</span>
              <span className="rounded-full px-2.5 py-0.5 font-medium bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300">{summary?.missed ?? 0} missed</span>
              <span className="rounded-full px-2.5 py-0.5 font-medium bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300">{summary?.adHoc ?? 0} ad-hoc</span>
              <span className="rounded-full px-2.5 py-0.5 font-medium bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300">{summary?.stops ?? 0} unplanned stoppages</span>
            </div>

            {data && data.totalPings === 0 && planned.length === 0 && visits.length === 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40 p-3 text-xs text-amber-800 dark:text-amber-300">
                Nothing recorded for this day — no visit plan, no check-ins and no GPS tracking points.
              </div>
            )}
            {data && data.totalPings === 0 && (planned.length > 0 || visits.length > 0) && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40 p-3 text-xs text-amber-800 dark:text-amber-300">
                No GPS tracking points were recorded this day (location tracking was off), so the dotted trail cannot be drawn — planned stops and recorded visits are shown.
              </div>
            )}
            {data && data.trackStride > 1 && (
              <p className="text-[11px] text-slate-400">
                {data.totalPings} GPS fixes recorded; every {data.trackStride}th is drawn to keep the map responsive.
              </p>
            )}

            <MapCanvas markers={markers} fitTo={fitTo} style={{ height: 520 }} />

            {/* legend */}
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
              <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-6 border-t-2 border-dashed border-teal-600" /> GPS trail (dotted)</span>
              <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: HITMAP_TONES.COMPLETED }} /> completed stop</span>
              <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: HITMAP_TONES.CHECKED_IN }} /> checked in</span>
              <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: HITMAP_TONES.MISSED }} /> missed</span>
              <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: HITMAP_TONES.PLANNED }} /> planned / not visited</span>
              <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: HITMAP_TONES.STOP }} /> unplanned stoppage</span>
              <span>circles = check-in radius</span>
            </div>

            {/* every stoppage with its duration */}
            <div>
              <p className="text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5 flex items-center gap-1.5">
                <Timer className="h-3.5 w-3.5" /> Stoppages this day ({stoppageList.length})
              </p>
              {stoppageList.length === 0 ? (
                <p className="text-xs text-slate-400">No stoppages recorded or detected — every stop is still open or the day had no visits.</p>
              ) : (
                <div className="rounded-lg border overflow-hidden max-h-56 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 dark:bg-slate-800 sticky top-0">
                      <tr>
                        {["#", "Stop", "From", "To", "Duration", "Type"].map((h) => (
                          <th key={h} className="px-2.5 py-2 text-left font-semibold text-slate-500 whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {stoppageList.map((r, i) => (
                        <tr key={i} className="border-t border-slate-100 dark:border-slate-800">
                          <td className="px-2.5 py-1.5 tabular-nums text-slate-400">{i + 1}</td>
                          <td className="px-2.5 py-1.5 font-medium text-slate-700 dark:text-slate-200">{r.name}{r.extra ? <span className="ml-1.5 text-rose-600 dark:text-rose-400">({r.extra})</span> : ""}</td>
                          <td className="px-2.5 py-1.5 tabular-nums text-slate-500">{hhmmssOf(r.from)}</td>
                          <td className="px-2.5 py-1.5 tabular-nums text-slate-500">{hhmmssOf(r.to)}</td>
                          <td className="px-2.5 py-1.5 tabular-nums font-semibold text-slate-700 dark:text-slate-200">{r.durationMin != null ? minutesHHMM(r.durationMin) : "open"}</td>
                          <td className="px-2.5 py-1.5"><VisitChip status={r.kind === "STOP" ? "CHECKED_IN" : r.kind} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
