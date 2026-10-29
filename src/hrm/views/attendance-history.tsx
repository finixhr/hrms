"use client"
// ============ Attendance History (2026-10 round §35–§36, §38) ============
// Filterable event history + per-employee/day MOVEMENT MAP (points →
// polyline → check-in/out + periodic markers). Only the requested
// employee/date range is fetched (§38) — history never floods the live map.
import { useMemo, useState } from "react"
import { CalendarRange, Loader2, MapPin, ShieldAlert, Camera } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useHrm } from "../store"
import { rpc, useApi, useEmployeeDirectory } from "../api"
import { SectionCard, StatusBadge, EmptyState, SelfieViewer, fmtDateTime } from "../shared/ui-kit"
import { DataTable, type Column } from "../shared/data-table"
import MapCanvas from "../shared/map-canvas"

const EVENT_TYPES = ["CHECK_IN", "CHECK_OUT", "PERIODIC_CHECK_IN", "PERIODIC_VERIFICATION", "DEVICE_PUNCH", "GPS_DISABLED", "MANDATORY_GPS_VIOLATION", "LOW_BATTERY", "GEOFENCE_VIOLATION", "SECURITY_FLAG"]
const METHODS = ["GEOFENCE", "SELFIE", "GEOFENCE_SELFIE", "DEVICE_PUNCH", "BIOMETRIC", "MOBILE", "ADMIN", "WEB"]
const INTEGRITY = ["VERIFIED", "SUSPICIOUS", "MOCK_LOCATION", "IMPOSSIBLE_MOVEMENT", "STALE_LOCATION", "LOW_ACCURACY", "TIMESTAMP_ANOMALY", "DEVICE_MISMATCH"]

function todayIso(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

// M-29 — alias onto the shared, locale-aware formatter (was a local en-GB duplicate)
const fmtTime = fmtDateTime

export default function AttendanceHistoryTab() {
  const { toast } = useHrm()
  const dir = useEmployeeDirectory()
  const [from, setFrom] = useState(todayIso(-7))
  const [to, setTo] = useState(todayIso())
  const [employeeId, setEmployeeId] = useState("all")
  const [eventType, setEventType] = useState("all")
  const [method, setMethod] = useState("all")
  const [integrity, setIntegrity] = useState("all")
  const [page, setPage] = useState(1)
  const [selfie, setSelfie] = useState<{ url: string; who: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const { data, loading, reload } = useApi<any>("attendance.events.list", {
    from, to,
    employeeId: employeeId === "all" ? null : employeeId,
    eventType: eventType === "all" ? null : eventType,
    attendanceMethod: method === "all" ? null : method,
    locationIntegrityStatus: integrity === "all" ? null : integrity,
    page, size: 50,
  })

  // movement map data for the selected employee + date range (§36)
  const mapEmployeeId = employeeId !== "all" ? employeeId : null
  const { data: track } = useApi<any>(
    mapEmployeeId ? "tracking.history" : null,
    mapEmployeeId ? { employeeId: mapEmployeeId, from, to, size: 800 } : undefined
  )

  const events = data?.events ?? []

  const viewSelfie = async (ev: any) => {
    if (!ev.selfieProofId) return
    setBusy(true)
    try {
      const r = await rpc("attendance.selfie.view", { id: ev.selfieProofId })
      setSelfie({ url: r.dataUrl, who: `${ev.employeeName} · ${fmtTime(ev.occurredAt)}` })
    } catch (e: any) {
      toast(String(e?.message || e), "err")
    } finally {
      setBusy(false)
    }
  }

  // G4 — export the CURRENT filter set as CSV (same filters the list uses)
  const exportCsv = async () => {
    setBusy(true)
    try {
      const r = await rpc<any>("attendance.events.export", {
        from, to,
        employeeId: employeeId === "all" ? null : employeeId,
        eventType: eventType === "all" ? null : eventType,
        attendanceMethod: method === "all" ? null : method,
        locationIntegrityStatus: integrity === "all" ? null : integrity,
        format: "csv",
      })
      const blob = new Blob(["\ufeff" + (r.csv || "")], { type: "text/csv;charset=utf-8" })
      const a = document.createElement("a")
      a.href = URL.createObjectURL(blob)
      a.download = `attendance-events-${from}-to-${to}.csv`
      a.click()
      URL.revokeObjectURL(a.href)
      toast(r.truncated ? `Export truncated at the ${r.rowCount}-row cap — narrow the date range` : `Exported ${r.rowCount} rows`, r.truncated ? "err" : "ok")
    } catch (e: any) {
      toast(e.message || "Export failed", "err")
    } finally {
      setBusy(false)
    }
  }

  const columns: Column<any>[] = [
    { key: "employeeName", label: "Employee", render: (r) => (
      <div>
        <p className="font-medium">{r.employeeName}</p>
        <p className="text-[11px] text-slate-400">{r.employeeCode}</p>
      </div>
    ) },
    { key: "occurredAt", label: "Date & Time", render: (r) => <span className="tabular-nums text-xs">{fmtTime(r.occurredAt)}</span> },
    { key: "eventType", label: "Event", render: (r) => <span className="text-xs font-medium">{r.eventType.replace(/_/g, " ")}</span> },
    { key: "attendanceMethod", label: "Method", render: (r) => <span className="text-xs">{r.attendanceMethod.replace(/_/g, " ")}</span> },
    { key: "location", label: "Location", render: (r) => r.latitude != null ? (
      <span className="text-[11px] tabular-nums text-slate-500">
        {r.latitude.toFixed(4)}, {r.longitude?.toFixed(4)}
        {r.accuracyM != null ? ` ±${Math.round(r.accuracyM)}m` : ""}
      </span>
    ) : <span className="text-slate-300">—</span> },
    { key: "battery", label: "Battery", render: (r) => r.batteryPercentage != null ? <span className="text-xs tabular-nums">{r.batteryPercentage}%</span> : <span className="text-slate-300">—</span> },
    { key: "gpsStatus", label: "GPS", render: (r) => <span className="text-xs">{r.gpsStatus ?? "—"}</span> },
    { key: "geoFence", label: "Geo-Fence", render: (r) => (
      <span className="text-xs">
        {r.geoFenceId ? (r.eventType === "GEOFENCE_VIOLATION" ? "outside" : "inside") : "—"}
        {r.distanceFromGeoFenceM != null ? ` (${r.distanceFromGeoFenceM}m)` : ""}
      </span>
    ) },
    { key: "status", label: "Verification", render: (r) => (
      <div className="flex flex-col gap-1">
        <StatusBadge status={r.status} />
        {r.locationIntegrityStatus && r.locationIntegrityStatus !== "VERIFIED" && (
          <span className="text-[10px] text-purple-600 dark:text-purple-400 flex items-center gap-0.5"><ShieldAlert className="h-3 w-3" />{r.locationIntegrityStatus.replace(/_/g, " ")}</span>
        )}
      </div>
    ) },
    { key: "selfie", label: "Proof", render: (r) => r.selfieProofId ? (
      <Button variant="ghost" size="sm" className="h-7 px-2" disabled={busy} onClick={() => viewSelfie(r)} title="View selfie proof (audited)">
        <Camera className="h-3.5 w-3.5" />
      </Button>
    ) : <span className="text-slate-300">—</span> },
    { key: "device", label: "Device", render: (r) => <span className="text-[11px] text-slate-400">{r.deviceId ? String(r.deviceId).slice(0, 12) : "—"}</span> },
  ]

  // movement map markers (§36): polyline points + event markers + fences
  const mapMarkers = useMemo(() => {
    if (!mapEmployeeId || !track) return []
    const out: any[] = []
    const points = track.points ?? []
    for (const p of points) {
      out.push({
        id: `pt-${p.id}`,
        latitude: p.latitude,
        longitude: p.longitude,
        lineGroup: "movement",
        html: `<div style="width:8px;height:8px;border-radius:50%;background:#0d9488;border:1.5px solid #fff"></div>`,
        popup: `<div style="font-family:system-ui;font-size:11px">
          <b>Location point</b><br/>${fmtTime(p.timestamp)}<br/>
          ±${Math.round(p.accuracyM ?? 0)}m · battery ${p.batteryPercentage ?? "?"}%
          ${p.locationIntegrityStatus && p.locationIntegrityStatus !== "VERIFIED" ? `<br/><span style="color:#9333ea">${p.locationIntegrityStatus.replace(/_/g, " ")}</span>` : ""}
        </div>`,
      })
    }
    for (const ev of track.events ?? []) {
      if (ev.latitude == null) continue
      const color = ev.eventType === "CHECK_IN" ? "#059669" : ev.eventType === "CHECK_OUT" ? "#dc2626" : ["SUSPICIOUS", "GEOFENCE_VIOLATION", "SECURITY_FLAG", "GPS_DISABLED", "MANDATORY_GPS_VIOLATION"].includes(ev.eventType) || ev.status === "REVIEW_REQUIRED" ? "#9333ea" : "#2563eb"
      out.push({
        id: `ev-${ev.id}`,
        latitude: ev.latitude,
        longitude: ev.longitude,
        html: `<div style="width:16px;height:16px;border-radius:50%;background:${color};border:2.5px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;color:#fff;font-size:9px;font-weight:bold">
          ${ev.eventType === "CHECK_IN" ? "▶" : ev.eventType === "CHECK_OUT" ? "■" : "•"}
        </div>`,
        popup: `<div style="font-family:system-ui;font-size:11px">
          <b>${ev.eventType.replace(/_/g, " ")}</b> · ${ev.attendanceMethod.replace(/_/g, " ")}<br/>
          ${fmtTime(ev.occurredAt)}<br/>
          ${ev.distanceFromGeoFenceM != null ? `fence distance ${ev.distanceFromGeoFenceM}m<br/>` : ""}
          battery ${ev.batteryPercentage ?? "?"}% · GPS ${ev.gpsStatus ?? "—"}<br/>
          status: <b>${ev.status}</b>
          ${ev.locationIntegrityStatus ? `<br/>integrity: ${ev.locationIntegrityStatus.replace(/_/g, " ")}` : ""}
        </div>`,
      })
    }
    return out
  }, [track])

  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / 50))

  return (
    <div className="space-y-4">
      {/* filters (§35) */}
      <SectionCard title="Attendance History" actions={
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400 hidden sm:inline">every normalized attendance/check event with security metadata</span>
          <Button size="sm" variant="outline" disabled={busy} onClick={exportCsv} className="h-7 text-[11px]">
            <CalendarRange className="h-3.5 w-3.5 mr-1 text-emerald-600" /> {busy ? "Exporting…" : "Export CSV"}
          </Button>
        </div>
      }>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="text-[11px] text-slate-400">From</label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 w-38 text-xs" />
          </div>
          <div>
            <label className="text-[11px] text-slate-400">To</label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-9 w-38 text-xs" />
          </div>
          <Select value={employeeId} onValueChange={(v) => { setEmployeeId(v); setPage(1) }}>
            <SelectTrigger className="w-52 h-9 text-xs"><SelectValue placeholder="Employee" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All employees</SelectItem>
              {(dir.data ?? []).map((e: any) => <SelectItem key={e.id} value={e.id}>{e.fullName} ({e.code})</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={eventType} onValueChange={(v) => { setEventType(v); setPage(1) }}>
            <SelectTrigger className="w-44 h-9 text-xs"><SelectValue placeholder="Event" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All events</SelectItem>
              {EVENT_TYPES.map((t) => <SelectItem key={t} value={t}>{t.replace(/_/g, " ")}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={method} onValueChange={(v) => { setMethod(v); setPage(1) }}>
            <SelectTrigger className="w-40 h-9 text-xs"><SelectValue placeholder="Method" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All methods</SelectItem>
              {METHODS.map((m) => <SelectItem key={m} value={m}>{m.replace(/_/g, " ")}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={integrity} onValueChange={(v) => { setIntegrity(v); setPage(1) }}>
            <SelectTrigger className="w-48 h-9 text-xs"><SelectValue placeholder="Security" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All security statuses</SelectItem>
              {INTEGRITY.map((i) => <SelectItem key={i} value={i}>{i.replace(/_/g, " ")}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" className="h-9" onClick={reload}><CalendarRange className="h-3.5 w-3.5 mr-1.5" />Apply</Button>
        </div>
      </SectionCard>

      {/* movement map (§36) — only when a single employee is selected */}
      {mapEmployeeId ? (
        <SectionCard
          title={<span>Movement Map <span className="text-slate-400 font-normal">· {(track?.totalPoints ?? 0)} point(s) + {(track?.events ?? []).length} event(s) · dotted line = path</span></span>}
        >
          {mapMarkers.length ? (
            <MapCanvas markers={mapMarkers} zoom={13} style={{ height: 420 }} />
          ) : (
            <EmptyState icon={MapPin} title="No location data" hint="No tracking points or located events for this employee in the selected range." />
          )}
        </SectionCard>
      ) : (
        <SectionCard title="Movement Map — pick an employee">
          <EmptyState icon={MapPin} title="Select a single employee" hint="The movement map loads the location history of ONE employee — choose an employee above." />
        </SectionCard>
      )}

      <SectionCard
        title={<span>Events <span className="text-slate-400 font-normal">· {data?.total ?? 0} event(s) · page {page} of {totalPages}</span></span>}
        actions={totalPages > 1 ? (
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>Prev</Button>
            <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>Next</Button>
          </div>
        ) : undefined}
      >
        {loading ? (
          <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-slate-300" /></div>
        ) : events.length ? (
          <DataTable columns={columns} rows={events} />
        ) : (
          <EmptyState icon={CalendarRange} title="No events found" hint="Adjust the date range or filters." />
        )}
      </SectionCard>

      {/* M-29 — the ONE shared selfie viewer (focus/ESC/aria-safe) */}
      <SelfieViewer selfie={selfie} onClose={() => setSelfie(null)} />
    </div>
  )
}
