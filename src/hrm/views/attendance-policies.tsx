"use client"
// ============ Attendance Policies — dynamic policy engine UI (2026-10 round §6–§7, §18, §29) ============
// ONE reusable policy system: TRACKING, MANDATORY_GPS, MULTIPLE_CHECKIN and
// ATTENDANCE_METHOD policies, each with scope assignments (EMPLOYEE >
// DEPARTMENT > BRANCH > ALL_EMPLOYEES — resolved server-side), schedule
// (dates/time window/weekdays, server clock) and typed config. The effective
// policy for any employee can be inspected ("Source: Employee/…").
import { useMemo, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useHrm } from "../store"
import { rpc, useApi, useEmployeeDirectory } from "../api"
import { SectionCard, EmptyState } from "../shared/ui-kit"
import { ConfirmDialog } from "../shared/form-dialog"
import { Loader2, Pencil, Plus, Settings2, ShieldCheck, Trash2 } from "lucide-react"

const POLICY_TYPES: { key: string; label: string; hint: string }[] = [
  { key: "TRACKING", label: "Live Tracking", hint: "location ping interval, accuracy limits, battery thresholds, offline window" },
  { key: "MANDATORY_GPS", label: "Mandatory GPS", hint: "GPS must stay ON inside the schedule; violations recorded" },
  { key: "MULTIPLE_CHECKIN", label: "Multiple Check-In", hint: "periodic re-verification check-ins (interval / limit / methods)" },
  { key: "ATTENDANCE_METHOD", label: "Attendance Method", hint: "allowed check-in methods: geo-fence / selfie / device punch" },
  // ATT-017 (R7) — per-employee/group day-level rules (late grace, early
  // leave, half-day threshold, daily OT cap) merged over tenant settings
  { key: "ATTENDANCE_RULES", label: "Attendance Rules", hint: "per-group late grace / early-leave / half-day / daily-OT overrides (empty = inherit Settings)" },
]
const DAYS = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"]
const CHECK_METHODS = ["GEOFENCE", "SELFIE", "GEOFENCE_SELFIE", "DEVICE_PUNCH"]
const SCOPE_LABEL: Record<string, string> = { ALL_EMPLOYEES: "All Employees", BRANCH: "Branch", DEPARTMENT: "Department", EMPLOYEE: "Employee" }

type PolicyDraft = {
  id?: string
  name: string
  policyType: string
  priority: number
  startDate: string
  endDate: string
  startTime: string
  endTime: string
  days: string[]
  active: boolean
  config: any
  assignments: { scopeType: string; scopeId?: string | null }[]
  geoFenceIds: string[]
}

const emptyDraft = (type: string): PolicyDraft => ({
  name: "",
  policyType: type,
  priority: 0,
  startDate: "",
  endDate: "",
  startTime: "",
  endTime: "",
  days: ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY"],
  active: true,
  config: {},
  assignments: [{ scopeType: "ALL_EMPLOYEES" }],
  geoFenceIds: [],
})

const defaultsFor = (type: string): any => ({
  TRACKING: { updateIntervalSec: 60, maxAccuracyM: 150, lowBatteryThreshold: 20, criticalBatteryThreshold: 10, offlineAfterMinutes: 15, suspiciousAction: "REVIEW" },
  MANDATORY_GPS: { graceMinutes: 5 },
  MULTIPLE_CHECKIN: { minIntervalMinutes: 60, maxPerDay: 10, methods: [...CHECK_METHODS] },
  ATTENDANCE_METHOD: { methods: ["GEOFENCE", "DEVICE_PUNCH"], selfieRequired: false, requireGeofence: false, deviceBinding: "OFF" },
  ATTENDANCE_RULES: { graceMinutes: null, earlyLeaveThresholdMinutes: null, halfDayHours: null, maxOtHoursPerDay: null },
}[type] ?? {})

export default function AttendancePoliciesTab() {
  const { can, toast } = useHrm()
  const { data: policies, reload } = useApi<any[]>("attendance.policy.list", {})
  const { data: branches } = useApi<any[]>("branches.list", {})
  const { data: departments } = useApi<any[]>("departments.list", {})
  const { data: fences } = useApi<any>("geofences.list", {})
  const dir = useEmployeeDirectory()
  const [draft, setDraft] = useState<PolicyDraft | null>(null)
  const [deleting, setDeleting] = useState<any | null>(null)
  const [busy, setBusy] = useState(false)
  const [effectiveFor, setEffectiveFor] = useState("")
  const [effective, setEffective] = useState<any | null>(null)

  const fenceList = useMemo(() => (fences as any)?.fences ?? [], [fences])

  const openEdit = (p?: any, typeHint?: string) => {
    if (p) {
      setDraft({
        id: p.id,
        name: p.name,
        policyType: p.policyType,
        priority: p.priority ?? 0,
        startDate: p.startDate ?? "",
        endDate: p.endDate ?? "",
        startTime: p.startTime ?? "",
        endTime: p.endTime ?? "",
        days: (p.daysOfWeek || "").split(",").filter(Boolean),
        active: p.active,
        config: { ...defaultsFor(p.policyType), ...safeParse(p.configJson) },
        assignments: (p.assignments ?? []).map((a: any) => ({ scopeType: a.scopeType, scopeId: a.scopeId })),
        geoFenceIds: (p.fences ?? []).map((f: any) => f.geoFenceId),
      })
    } else {
      const t = typeHint ?? "TRACKING"
      setDraft({ ...emptyDraft(t), config: { ...defaultsFor(t) } })
    }
  }

  const save = async () => {
    if (!draft || !draft.name.trim()) return
    setBusy(true)
    try {
      await rpc("attendance.policy.save", {
        id: draft.id,
        name: draft.name.trim(),
        policyType: draft.policyType,
        priority: Number(draft.priority) || 0,
        startDate: draft.startDate || null,
        endDate: draft.endDate || null,
        startTime: draft.startTime || null,
        endTime: draft.endTime || null,
        daysOfWeek: draft.days,
        timezone: "Asia/Dhaka",
        active: draft.active,
        config: draft.config,
        assignments: draft.assignments,
        geoFenceIds: draft.geoFenceIds,
      })
      toast(`Policy ${draft.id ? "updated" : "created"}: ${draft.name}`)
      setDraft(null)
      reload()
    } catch (e: any) {
      toast(String(e?.message || e), "err")
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!deleting) return
    setBusy(true)
    try {
      await rpc("attendance.policy.delete", { id: deleting.id, confirm: "DELETE" })
      toast(`Deleted policy ${deleting.name}`)
      setDeleting(null)
      reload()
    } catch (e: any) {
      toast(String(e?.message || e), "err")
    } finally {
      setBusy(false)
    }
  }

  const checkEffective = async () => {
    if (!effectiveFor) return
    try {
      const r = await rpc("attendance.policy.effective", { employeeId: effectiveFor })
      setEffective(r)
    } catch (e: any) {
      toast(String(e?.message || e), "err")
    }
  }

  const scopeName = (a: { scopeType: string; scopeId?: string | null }) => {
    if (a.scopeType === "ALL_EMPLOYEES") return "All Employees"
    if (a.scopeType === "BRANCH") return (branches ?? []).find((b: any) => b.id === a.scopeId)?.name ?? "Branch"
    if (a.scopeType === "DEPARTMENT") return (departments ?? []).find((d: any) => d.id === a.scopeId)?.name ?? "Department"
    return (dir.data ?? []).find((e: any) => e.id === a.scopeId)?.fullName ?? "Employee"
  }

  // ---------------- EDITOR ----------------
  if (draft) {
    const cfg = draft.config
    const setCfg = (patch: any) => setDraft({ ...draft, config: { ...cfg, ...patch } })
    return (
      <SectionCard
        title={draft.id ? `Edit Policy — ${draft.name}` : `New ${POLICY_TYPES.find((t) => t.key === draft.policyType)?.label} Policy`}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setDraft(null)}>Cancel</Button>
            <Button size="sm" disabled={busy || !draft.name.trim()} onClick={save}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Save Policy
            </Button>
          </div>
        }
      >
        <div className="grid lg:grid-cols-2 gap-6">
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Policy name</Label>
                <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Field Staff Tracking" className="text-sm" />
              </div>
              <div>
                <Label className="text-xs">Type</Label>
                <Select value={draft.policyType} onValueChange={(v) => setDraft({ ...draft, policyType: v, config: { ...defaultsFor(v) } })}>
                  <SelectTrigger className="text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {POLICY_TYPES.map((t) => <SelectItem key={t.key} value={t.key}>{t.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* typed config per policy (§6: one engine, typed settings) */}
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-3">
              <p className="text-xs font-semibold text-slate-500 flex items-center gap-1.5"><Settings2 className="h-3.5 w-3.5" />Configuration</p>
              {draft.policyType === "TRACKING" && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs">Update interval (§11)</Label>
                    <Select value={String(cfg.updateIntervalSec ?? 60)} onValueChange={(v) => setCfg({ updateIntervalSec: Number(v) })}>
                      <SelectTrigger className="text-sm"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {[15, 30, 60, 120, 300, 600].map((s) => <SelectItem key={s} value={String(s)}>{s < 60 ? `${s} seconds` : `${s / 60} minute(s)`}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs">Max GPS accuracy (m)</Label>
                    <Input type="number" min={10} value={cfg.maxAccuracyM ?? 150} onChange={(e) => setCfg({ maxAccuracyM: Number(e.target.value) })} className="text-sm" />
                  </div>
                  <div>
                    <Label className="text-xs">Low battery % (§14)</Label>
                    <Input type="number" min={1} max={99} value={cfg.lowBatteryThreshold ?? 20} onChange={(e) => setCfg({ lowBatteryThreshold: Number(e.target.value) })} className="text-sm" />
                  </div>
                  <div>
                    <Label className="text-xs">Critical battery %</Label>
                    <Input type="number" min={1} max={99} value={cfg.criticalBatteryThreshold ?? 10} onChange={(e) => setCfg({ criticalBatteryThreshold: Number(e.target.value) })} className="text-sm" />
                  </div>
                  <div>
                    <Label className="text-xs">Offline after (minutes)</Label>
                    <Input type="number" min={1} value={cfg.offlineAfterMinutes ?? 15} onChange={(e) => setCfg({ offlineAfterMinutes: Number(e.target.value) })} className="text-sm" />
                  </div>
                  <div>
                    <Label className="text-xs">Suspicious location action (§25)</Label>
                    <Select value={cfg.suspiciousAction ?? "REVIEW"} onValueChange={(v) => setCfg({ suspiciousAction: v })}>
                      <SelectTrigger className="text-sm"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {["ALLOW", "WARN", "REVIEW", "REJECT"].map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}
              {draft.policyType === "MANDATORY_GPS" && (
                <div>
                  <Label className="text-xs">Grace period (minutes)</Label>
                  <Input type="number" min={0} max={120} value={cfg.graceMinutes ?? 5} onChange={(e) => setCfg({ graceMinutes: Number(e.target.value) })} className="text-sm" />
                  <p className="text-[11px] text-slate-400 mt-1">GPS may be off this long before a MANDATORY_GPS_VIOLATION is recorded.</p>
                </div>
              )}
              {draft.policyType === "MULTIPLE_CHECKIN" && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs">Minimum interval (minutes)</Label>
                      <Select value={String(cfg.minIntervalMinutes ?? 60)} onValueChange={(v) => setCfg({ minIntervalMinutes: Number(v) })}>
                        <SelectTrigger className="text-sm"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {[30, 45, 60, 90, 120, 180].map((m) => <SelectItem key={m} value={String(m)}>Every {m} minutes</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label className="text-xs">Max checks per day</Label>
                      <Input type="number" min={1} max={50} value={cfg.maxPerDay ?? 10} onChange={(e) => setCfg({ maxPerDay: Number(e.target.value) })} className="text-sm" />
                    </div>
                  </div>
                  <div>
                    <Label className="text-xs">Allowed periodic check methods (§30)</Label>
                    <div className="flex flex-wrap gap-3 mt-1">
                      {CHECK_METHODS.map((m) => (
                        <label key={m} className="flex items-center gap-1.5 text-xs">
                          <Checkbox
                            checked={(cfg.methods ?? []).includes(m)}
                            onCheckedChange={(v) => setCfg({ methods: v ? [...(cfg.methods ?? []), m] : (cfg.methods ?? []).filter((x: string) => x !== m) })}
                          />
                          {m.replace(/_/g, " ")}
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              )}
              {draft.policyType === "ATTENDANCE_METHOD" && (
                <div className="space-y-3">
                  <div>
                    <Label className="text-xs">Allowed check-in methods (§28)</Label>
                    <div className="flex flex-wrap gap-3 mt-1">
                      {CHECK_METHODS.map((m) => (
                        <label key={m} className="flex items-center gap-1.5 text-xs">
                          <Checkbox
                            checked={(cfg.methods ?? []).includes(m)}
                            onCheckedChange={(v) => setCfg({ methods: v ? [...(cfg.methods ?? []), m] : (cfg.methods ?? []).filter((x: string) => x !== m) })}
                          />
                          {m.replace(/_/g, " ")}
                        </label>
                      ))}
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-xs"><Switch checked={!!cfg.selfieRequired} onCheckedChange={(v) => setCfg({ selfieRequired: v })} /> Selfie required (e.g. field employees)</label>
                  <label className="flex items-center gap-2 text-xs"><Switch checked={!!cfg.requireGeofence} onCheckedChange={(v) => setCfg({ requireGeofence: v })} /> Must be inside a geo-fence</label>
                  <div>
                    <Label className="text-xs">Device binding</Label>
                    <Select value={cfg.deviceBinding ?? "OFF"} onValueChange={(v) => setCfg({ deviceBinding: v })}>
                      <SelectTrigger className="h-8 text-xs mt-1"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="OFF">OFF — record deviceId only</SelectItem>
                        <SelectItem value="ADVISORY">ADVISORY — flag unknown devices for review</SelectItem>
                        <SelectItem value="STRICT">STRICT — only enrolled devices may punch</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}
              {draft.policyType === "ATTENDANCE_RULES" && (
                <div className="space-y-3">
                  <p className="text-[11px] text-slate-400">Each empty field inherits the tenant-wide setting (Settings → Time &amp; Attendance). Assign to a branch, department, specific employees — or everyone.</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs">Late grace (minutes)</Label>
                      <Input type="number" min={0} max={120} placeholder="inherit" value={cfg.graceMinutes ?? ""} onChange={(e) => setCfg({ graceMinutes: e.target.value === "" ? null : Number(e.target.value) })} className="text-sm" />
                    </div>
                    <div>
                      <Label className="text-xs">Early-leave threshold (minutes)</Label>
                      <Input type="number" min={0} max={120} placeholder="inherit" value={cfg.earlyLeaveThresholdMinutes ?? ""} onChange={(e) => setCfg({ earlyLeaveThresholdMinutes: e.target.value === "" ? null : Number(e.target.value) })} className="text-sm" />
                    </div>
                    <div>
                      <Label className="text-xs">Half-day threshold (hours)</Label>
                      <Input type="number" min={0.5} max={12} step={0.5} placeholder="inherit" value={cfg.halfDayHours ?? ""} onChange={(e) => setCfg({ halfDayHours: e.target.value === "" ? null : Number(e.target.value) })} className="text-sm" />
                    </div>
                    <div>
                      <Label className="text-xs">Daily overtime cap (hours)</Label>
                      <Input type="number" min={0} max={8} step={0.5} placeholder="inherit" value={cfg.maxOtHoursPerDay ?? ""} onChange={(e) => setCfg({ maxOtHoursPerDay: e.target.value === "" ? null : Number(e.target.value) })} className="text-sm" />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* schedule (§7) */}
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-3">
              <p className="text-xs font-semibold text-slate-500">Schedule (server clock · Asia/Dhaka)</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Daily window start</Label>
                  <Input type="time" value={draft.startTime} onChange={(e) => setDraft({ ...draft, startTime: e.target.value })} className="text-sm" />
                </div>
                <div>
                  <Label className="text-xs">Daily window end</Label>
                  <Input type="time" value={draft.endTime} onChange={(e) => setDraft({ ...draft, endTime: e.target.value })} className="text-sm" />
                </div>
                <div>
                  <Label className="text-xs">Valid from (optional)</Label>
                  <Input type="date" value={draft.startDate} onChange={(e) => setDraft({ ...draft, startDate: e.target.value })} className="text-sm" />
                </div>
                <div>
                  <Label className="text-xs">Valid until (optional)</Label>
                  <Input type="date" value={draft.endDate} onChange={(e) => setDraft({ ...draft, endDate: e.target.value })} className="text-sm" />
                </div>
              </div>
              <div>
                <Label className="text-xs">Days of week</Label>
                <div className="flex flex-wrap gap-2.5 mt-1">
                  {DAYS.map((d) => (
                    <label key={d} className="flex items-center gap-1 text-xs">
                      <Checkbox
                        checked={draft.days.includes(d)}
                        onCheckedChange={(v) => setDraft({ ...draft, days: v ? [...draft.days, d] : draft.days.filter((x) => x !== d) })}
                      />
                      {d.slice(0, 3)}
                    </label>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 text-xs"><Switch checked={draft.active} onCheckedChange={(v) => setDraft({ ...draft, active: v })} /> Active</label>
                <div className="flex items-center gap-2 text-xs">
                  Priority
                  <Input type="number" className="h-7 w-20 text-xs" value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })} />
                </div>
              </div>
            </div>
          </div>

          {/* assignments + fences (§21) */}
          <div className="space-y-3">
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-2">
              <p className="text-xs font-semibold text-slate-500">Assign to (scope priority: Employee {'>'} Department {'>'} Branch {'>'} All)</p>
              {draft.assignments.map((a, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <Select value={a.scopeType} onValueChange={(v) => {
                    const next = [...draft.assignments]
                    next[i] = { scopeType: v, scopeId: null }
                    setDraft({ ...draft, assignments: next })
                  }}>
                    <SelectTrigger className="h-8 text-xs w-36"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Object.entries(SCOPE_LABEL).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {a.scopeType !== "ALL_EMPLOYEES" && (
                    <Select value={a.scopeId ?? ""} onValueChange={(v) => {
                      const next = [...draft.assignments]
                      next[i] = { ...a, scopeId: v }
                      setDraft({ ...draft, assignments: next })
                    }}>
                      <SelectTrigger className="h-8 text-xs flex-1"><SelectValue placeholder="Select target…" /></SelectTrigger>
                      <SelectContent>
                        {a.scopeType === "BRANCH" && (branches ?? []).map((b: any) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                        {a.scopeType === "DEPARTMENT" && (departments ?? []).map((d: any) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
                        {a.scopeType === "EMPLOYEE" && (dir.data ?? []).map((e: any) => <SelectItem key={e.id} value={e.id}>{e.fullName} ({e.code})</SelectItem>)}
                      </SelectContent>
                    </Select>
                  )}
                  <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => setDraft({ ...draft, assignments: draft.assignments.filter((_, j) => j !== i) })}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
              <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setDraft({ ...draft, assignments: [...draft.assignments, { scopeType: "ALL_EMPLOYEES", scopeId: null }] })}>
                <Plus className="h-3.5 w-3.5 mr-1" />Add assignment
              </Button>
            </div>

            <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-2">
              <p className="text-xs font-semibold text-slate-500">Geo-Fences in effect (§21)</p>
              {fenceList.length ? (
                <div className="space-y-1.5 max-h-52 overflow-auto">
                  {fenceList.map((f: any) => (
                    <label key={f.id} className="flex items-center gap-2 text-xs">
                      <Checkbox
                        checked={draft.geoFenceIds.includes(f.id)}
                        onCheckedChange={(v) => setDraft({ ...draft, geoFenceIds: v ? [...draft.geoFenceIds, f.id] : draft.geoFenceIds.filter((x) => x !== f.id) })}
                      />
                      {f.name} <span className="text-slate-400">r={Math.round(f.radiusM)}m{!f.active ? " · disabled" : ""}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-slate-400">No geo-fences yet — create them in the Geo-Fence tab.</p>
              )}
            </div>
          </div>
        </div>
      </SectionCard>
    )
  }

  // ---------------- LIST ----------------
  const byType = (t: string) => (policies ?? []).filter((p: any) => p.policyType === t)
  return (
    <div className="space-y-4">
      <SectionCard
        title="Effective Policy inspector (§6)"
        actions={<span className="text-xs text-slate-400">the server resolves which policy applies and from which scope</span>}
      >
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-56">
            <Label className="text-xs">Employee</Label>
            <Select value={effectiveFor} onValueChange={setEffectiveFor}>
              <SelectTrigger className="text-sm"><SelectValue placeholder="Pick an employee…" /></SelectTrigger>
              <SelectContent>
                {(dir.data ?? []).map((e: any) => <SelectItem key={e.id} value={e.id}>{e.fullName} ({e.code})</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <Button size="sm" disabled={!effectiveFor} onClick={checkEffective}><ShieldCheck className="h-3.5 w-3.5 mr-1.5" />Resolve</Button>
        </div>
        {effective && (
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2 mt-3">
            {POLICY_TYPES.map((t) => {
              const info = effective[t.key]
              return (
                <div key={t.key} className="rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-slate-400">{t.label}</p>
                  {info ? (
                    <>
                      <p className="text-sm font-medium truncate">{info.name}</p>
                      <p className="text-[11px] text-slate-400">
                        Source: <b className={info.source === "Employee" ? "text-emerald-600" : "text-slate-500"}>{info.source}</b>
                        {info.inSchedule ? " · in schedule" : " · out of schedule"}
                      </p>
                    </>
                  ) : (
                    <p className="text-xs text-slate-400 mt-1">No policy (global defaults)</p>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </SectionCard>

      {POLICY_TYPES.map((t) => (
        <SectionCard
          key={t.key}
          title={<span>{t.label} Policies <span className="text-slate-400 font-normal">· {byType(t.key).length}</span></span>}
          actions={can("attendance", "edit") ? (
            <Button size="sm" variant="outline" onClick={() => openEdit(null, t.key)}><Plus className="h-3.5 w-3.5 mr-1.5" />New</Button>
          ) : undefined}
        >
          {byType(t.key).length ? (
            <div className="grid gap-2">
              {byType(t.key).map((p: any) => (
                <div key={p.id} className="flex items-center gap-3 rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium flex items-center gap-1.5">
                      {p.name}
                      {!p.active && <Badge variant="outline" className="text-[10px] text-slate-400">inactive</Badge>}
                      {p.priority ? <Badge variant="outline" className="text-[10px]">priority {p.priority}</Badge> : null}
                    </p>
                    <p className="text-[11px] text-slate-400">
                      {(p.daysOfWeek || "").split(",").filter(Boolean).map((d: string) => d.slice(0, 3)).join(" + ") || "all days"}
                      {p.startTime && p.endTime ? ` · ${p.startTime}–${p.endTime}` : ""}
                      {p.assignments?.length ? ` · ${p.assignments.map((a: any) => scopeName(a)).join(", ")}` : " · unassigned"}
                      {p.fences?.length ? ` · ${p.fences.length} fence(s)` : ""}
                    </p>
                  </div>
                  {can("attendance", "edit") && (
                    <Button variant="outline" size="sm" className="h-7" onClick={() => openEdit(p)}><Pencil className="h-3.5 w-3.5" /></Button>
                  )}
                  {can("attendance", "delete") && (
                    <Button variant="ghost" size="sm" className="h-7 px-2 text-rose-500" onClick={() => setDeleting(p)}><Trash2 className="h-3.5 w-3.5" /></Button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <EmptyState icon={Settings2} title={`No ${t.label.toLowerCase()} policy`} hint={t.hint} />
          )}
        </SectionCard>
      ))}

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete policy “${deleting?.name}”?`}
        message="The policy and its assignments are removed. Employees fall back to the next policy in scope priority or the global defaults."
        confirmLabel="Delete Policy"
        danger
        onConfirm={remove}
      />
    </div>
  )
}

function safeParse(s: string): any {
  try { return JSON.parse(s || "{}") } catch { return {} }
}
