"use client"
// ============ Geo-Fence management — map-based configuration (2026-10 round §19–§21) ============
// Interactive map replaces the numeric-only experience: search-click to set
// the center, drag the pin, adjust the radius, preview the boundary, save.
// Only geographic data is stored (no screenshots). Branch legacy fences are
// shown alongside (migrated rows are flagged).
import { useMemo, useState } from "react"
import { Compass, Loader2, MapPin, MapPinned, Plus, Save, Trash2, Power } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useHrm } from "../store"
import { rpc, useApi } from "../api"
import { SectionCard, EmptyState, esc } from "../shared/ui-kit"
import { ConfirmDialog } from "../shared/form-dialog"
import MapCanvas from "../shared/map-canvas"

export default function GeofenceManagerTab() {
  const { can, toast } = useHrm()
  const { data, reload } = useApi<any>("geofences.list", {})
  const { data: branches } = useApi<any[]>("branches.list", {})
  const [editing, setEditing] = useState<any | null>(null) // null = list; {} = new
  const [deleting, setDeleting] = useState<any | null>(null)
  const [busy, setBusy] = useState(false)
  // editor state
  const [name, setName] = useState("")
  const [branchId, setBranchId] = useState("")
  const [latitude, setLatitude] = useState(23.8103)
  const [longitude, setLongitude] = useState(90.4125)
  const [radiusM, setRadiusM] = useState(150)
  const [startTime, setStartTime] = useState("")
  const [endTime, setEndTime] = useState("")
  const [active, setActive] = useState(true)

  const fences = useMemo(() => data?.fences ?? [], [data])

  const openNew = () => {
    const b = (branches ?? [])[0]
    setEditing({})
    setName("")
    setBranchId(b?.id ?? "")
    setLatitude(b?.latitude ?? 23.8103)
    setLongitude(b?.longitude ?? 90.4125)
    setRadiusM(150)
    setStartTime("")
    setEndTime("")
    setActive(true)
  }

  const openEdit = (f: any) => {
    setEditing(f)
    setName(f.name)
    setBranchId(f.branchId ?? "")
    setLatitude(f.latitude)
    setLongitude(f.longitude)
    setRadiusM(f.radiusM)
    setStartTime(f.startTime ?? "")
    setEndTime(f.endTime ?? "")
    setActive(f.active)
  }

  const save = async () => {
    setBusy(true)
    try {
      await rpc("geofences.save", {
        id: editing?.id ?? undefined,
        name: name.trim(),
        branchId: branchId || null,
        type: "CIRCLE",
        latitude: Number(latitude),
        longitude: Number(longitude),
        radiusM: Number(radiusM),
        startTime: startTime || null,
        endTime: endTime || null,
        active,
      })
      toast(`Geo-fence ${editing?.id ? "updated" : "created"}: ${name}`)
      setEditing(null)
      reload()
    } catch (e: any) {
      toast(String(e?.message || e), "err")
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (f: any) => {
    try {
      await rpc("geofences.setEnabled", { id: f.id, active: !f.active })
      toast(`${!f.active ? "Enabled" : "Disabled"} ${f.name}`)
      reload()
    } catch (e: any) {
      toast(String(e?.message || e), "err")
    }
  }

  const remove = async () => {
    if (!deleting) return
    setBusy(true)
    try {
      await rpc("geofences.delete", { id: deleting.id, confirm: "DELETE" })
      toast(`Deleted ${deleting.name}`)
      setDeleting(null)
      reload()
    } catch (e: any) {
      toast(String(e?.message || e), "err")
    } finally {
      setBusy(false)
    }
  }

  // ---------- LIST VIEW ----------
  if (!editing) {
    const listMarkers = fences.map((f: any) => ({
      id: f.id,
      latitude: f.latitude,
      longitude: f.longitude,
      circle: { radiusM: f.radiusM, color: f.active ? "#0d9488" : "#94a3b8" },
      html: `<div style="width:12px;height:12px;border-radius:50%;background:${f.active ? "#0d9488" : "#94a3b8"};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)"></div>`,
      // M-25 — fence names are DB-derived: escape before popup HTML interpolation
      popup: `<div style="font-family:system-ui;font-size:11px"><b>${esc(f.name)}</b><br/>r=${Math.round(f.radiusM)}m${f.startTime ? `<br/>${esc(f.startTime)}-${esc(f.endTime)}` : ""}${f.active ? "" : "<br/><i>disabled</i>"}</div>`,
    }))
    return (
      <div className="space-y-4">
        <SectionCard
          title={<span>Geo-Fences <span className="text-slate-400 font-normal">· {fences.length} configured</span></span>}
          actions={can("geofence", "create") ? (
            <Button size="sm" onClick={openNew}><Plus className="h-3.5 w-3.5 mr-1.5" />New Geo-Fence</Button>
          ) : undefined}
        >
          {fences.length ? (
            <div className="space-y-4">
              <MapCanvas markers={listMarkers} zoom={11} style={{ height: 340 }} />
              <div className="grid gap-2">
                {fences.map((f: any) => (
                  <div key={f.id} className="flex items-center gap-3 rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2">
                    <MapPinned className="h-4 w-4 text-teal-600 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">
                        {f.name}{" "}
                        {f.migratedFromBranch && <Badge variant="outline" className="ml-1 text-[10px]">migrated from branch</Badge>}
                        {!f.active && <Badge variant="outline" className="ml-1 text-[10px] text-slate-400">disabled</Badge>}
                      </p>
                      <p className="text-[11px] text-slate-400 tabular-nums">
                        {f.latitude.toFixed(5)}, {f.longitude.toFixed(5)} · r={Math.round(f.radiusM)}m
                        {f.startTime && f.endTime ? ` · ${f.startTime}–${f.endTime}` : ""}
                        {f.branchId ? ` · ${((data?.branchDefaults ?? []).find((b: any) => b.id === f.branchId)?.name) ?? "branch"}` : ""}
                      </p>
                    </div>
                    {can("geofence", "edit") && (
                      <div className="flex gap-1.5">
                        <Button variant="ghost" size="sm" className="h-7 px-2" title={f.active ? "Disable" : "Enable"} onClick={() => toggle(f)}>
                          <Power className={`h-3.5 w-3.5 ${f.active ? "text-emerald-500" : "text-slate-400"}`} />
                        </Button>
                        <Button variant="outline" size="sm" className="h-7" onClick={() => openEdit(f)}>Edit</Button>
                        {can("geofence", "delete") && (
                          <Button variant="ghost" size="sm" className="h-7 px-2 text-rose-500" onClick={() => setDeleting(f)}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-slate-400">
                Branch fences configured before this feature were migrated automatically (flagged “migrated from branch”).
                Assign fences to attendance policies in the <b>Attendance Policies</b> tab.
              </p>
            </div>
          ) : (
            <EmptyState icon={MapPin} title="No geo-fences yet" hint="Create your first fence — click the map to position it, set the radius, save." />
          )}
        </SectionCard>
        <ConfirmDialog
          open={!!deleting}
          onOpenChange={(o) => !o && setDeleting(null)}
          title={`Delete geo-fence “${deleting?.name}”?`}
          message="Policies linked to this fence will lose the assignment. This cannot be undone."
          confirmLabel="Delete Geo-Fence"
          danger
          onConfirm={remove}
        />
      </div>
    )
  }

  // ---------- EDITOR VIEW (§20: search location → click map → drag center → radius → save) ----------
  return (
    <div className="space-y-4">
      <SectionCard
        title={editing?.id ? `Edit Geo-Fence — ${editing.name}` : "New Geo-Fence"}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditing(null)}>Cancel</Button>
            <Button size="sm" disabled={busy || !name.trim()} onClick={save}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4 mr-1.5" />}Save Geo-Fence
            </Button>
          </div>
        }
      >
        <div className="grid lg:grid-cols-2 gap-4">
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Area name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Head Office" className="text-sm" />
            </div>
            <div>
              <Label className="text-xs">Branch (optional anchor)</Label>
              <Select value={branchId || "none"} onValueChange={(v) => {
                const id = v === "none" ? "" : v
                setBranchId(id)
                const b = (branches ?? []).find((x: any) => x.id === id)
                if (b?.latitude != null && b?.longitude != null) {
                  setLatitude(b.latitude)
                  setLongitude(b.longitude)
                  if (b.geofenceRadius) setRadiusM(b.geofenceRadius)
                }
              }}>
                <SelectTrigger className="text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— No branch —</SelectItem>
                  {(branches ?? []).map((b: any) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Center latitude</Label>
                <Input type="number" step="0.00001" value={latitude} onChange={(e) => setLatitude(Number(e.target.value))} className="text-sm tabular-nums" />
              </div>
              <div>
                <Label className="text-xs">Center longitude</Label>
                <Input type="number" step="0.00001" value={longitude} onChange={(e) => setLongitude(Number(e.target.value))} className="text-sm tabular-nums" />
              </div>
            </div>
            <div>
              <Label className="text-xs">Radius: <b className="tabular-nums">{Math.round(radiusM)} m</b></Label>
              <input
                type="range" min={20} max={2000} step={10} value={radiusM}
                onChange={(e) => setRadiusM(Number(e.target.value))}
                className="w-full accent-teal-600"
              />
              <div className="flex gap-1.5 mt-1">
                {[50, 100, 150, 300, 500, 1000].map((r) => (
                  <button key={r} onClick={() => setRadiusM(r)} className={`text-[11px] px-2 py-0.5 rounded-full border ${radiusM === r ? "border-teal-500 bg-teal-50 dark:bg-teal-950 text-teal-700 dark:text-teal-300" : "border-slate-200 dark:border-slate-700 text-slate-500"}`}>
                    {r}m
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Valid from (optional)</Label>
                <Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="text-sm" />
              </div>
              <div>
                <Label className="text-xs">Valid until (optional)</Label>
                <Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className="text-sm" />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={active} onCheckedChange={setActive} />
              <Label className="text-xs">{active ? "Active" : "Disabled"}</Label>
            </div>
            <p className="text-[11px] text-slate-400 flex items-start gap-1.5">
              <Compass className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              Click the map to move the center, or drag the center pin. The circle previews the boundary employees must be inside.
            </p>
          </div>
          <div>
            <MapCanvas
              center={[latitude, longitude]}
              zoom={15}
              editableCircle={{ latitude, longitude, radiusM }}
              onCircleChange={(pos) => { setLatitude(pos.latitude); setLongitude(pos.longitude) }}
              onMapClick={(pos) => { setLatitude(pos.latitude); setLongitude(pos.longitude) }}
              style={{ height: 460 }}
            />
          </div>
        </div>
      </SectionCard>
    </div>
  )
}
