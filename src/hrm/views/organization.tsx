"use client"
// ============ Organization: Branches (with geo-fence), Departments, Designations ============
// Holiday Calendar moved to HR Settings → Holiday Calendar (shared component in
// src/hrm/shared/holidays-tab.tsx — same data, same routes, new home).
//
// 2026-10 round — the auto-generated Code field on Branch / Department /
// Designation CREATE is now LOCKED (read-only): it is fetched from the
// {listName}.nextCode RPC the moment the dialog opens and displayed disabled,
// so users can see the code they will get but cannot manually edit it.
// The server keeps its atomic generate-on-blank path as the concurrency
// backstop (a rare unique-race surfaces the DB error in the dialog).
//
// 2026-11 — Branch dialog redesigned to match the compact two-column layout.
// The geo-fence section now includes a "Set on Map" button that opens a
// Leaflet-powered map picker dialog — click or drag the pin to set lat/lng.
import { useEffect, useRef, useState } from "react"
import { Building2, Plus, Pencil, Trash2, MapPin, Store, Warehouse, Building, Crosshair, Loader2, LocateFixed } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { useHrm } from "../store"
import { useApi, rpc, useEmployeeDirectory } from "../api"
import { PageHeader, StatCard, fmtMoney, titleCase, SectionTabs, FieldError } from "../shared/ui-kit"
import { DataTable, type Column } from "../shared/data-table"
import { FormDialog, ConfirmDialog, type FieldDef } from "../shared/form-dialog"
import MapCanvas from "../shared/map-canvas"

const BRANCH_TYPES = ["STORE", "OFFICE", "WAREHOUSE", "OTHER"]

/** Locked, pre-fetched auto-code field for a CREATE dialog.
 *  `code` is the next code from {listName}.nextCode (or null while loading —
 *  the field then shows an "auto-generating" placeholder). */
function lockedCodeField(code: string | null, prefix: string): FieldDef {
  return {
    name: "code",
    label: "Code",
    disabled: true,
    placeholder: code ? undefined : "Auto-generating…",
    help: code
      ? `Auto-generated (${code}) — locked, it cannot be edited manually.`
      : `Auto-generated (${prefix}-000N format) — locked, it cannot be edited manually.`,
  }
}

// ── Geo-fence map picker dialog ───────────────────────────────────────────────
// Opens a Leaflet map so the user can click or drag the pin to choose lat/lng.
// Includes a "Current Location" tracker button to quickly center on user GPS.
function GeoMapPickerDialog({
  open,
  onOpenChange,
  latitude,
  longitude,
  radiusM,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  latitude: number
  longitude: number
  radiusM: number
  onConfirm: (pos: { latitude: number; longitude: number }) => void
}) {
  const [pos, setPos] = useState({ latitude, longitude })
  const [fitTarget, setFitTarget] = useState<[number, number] | null>(null)
  const [locating, setLocating] = useState(false)
  const [locError, setLocError] = useState<string | null>(null)

  // Reset local pos whenever the dialog is opened with fresh parent values.
  useEffect(() => {
    if (open) {
      setPos({ latitude, longitude })
      setFitTarget([latitude, longitude])
      setLocError(null)
      setLocating(false)
    }
  }, [open, latitude, longitude])

  const handleCurrentLocation = () => {
    if (typeof window === "undefined" || !navigator.geolocation) {
      setLocError("Geolocation is not supported by your browser")
      return
    }
    setLocating(true)
    setLocError(null)
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const lat = Number(position.coords.latitude.toFixed(6))
        const lng = Number(position.coords.longitude.toFixed(6))
        setPos({ latitude: lat, longitude: lng })
        setFitTarget([lat, lng])
        setLocating(false)
      },
      (err) => {
        setLocating(false)
        const msg = err.code === 1
          ? "Location permission denied. Please allow location access."
          : (err.message || "Failed to retrieve current location.")
        setLocError(msg)
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl p-0 overflow-hidden">
        <DialogHeader className="px-4 pt-4 pb-2">
          <DialogTitle className="text-base flex items-center gap-2">
            <MapPin className="h-4 w-4 text-teal-600" />
            Set Geo-Fence Location
          </DialogTitle>
          <p className="text-xs text-slate-500">
            Click anywhere on the map or drag the green pin to set the branch GPS centre.
            Coordinates update in real time.
          </p>
        </DialogHeader>

        {/* Map with interactive controls */}
        <div className="relative">
          <MapCanvas
            center={[pos.latitude, pos.longitude]}
            fitTo={fitTarget ? [fitTarget] : [[pos.latitude, pos.longitude]]}
            zoom={15}
            editableCircle={{ latitude: pos.latitude, longitude: pos.longitude, radiusM: radiusM || 200 }}
            onMapClick={(p) => {
              setPos(p)
              setFitTarget([p.latitude, p.longitude])
            }}
            onCircleChange={(p) => {
              setPos({ latitude: p.latitude, longitude: p.longitude })
            }}
            style={{ height: 380, borderRadius: 0 }}
          />

          {/* Current Location Tracker button on the map */}
          <div className="absolute top-3 right-3 z-[1000] flex flex-col items-end gap-1 pointer-events-auto">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={locating}
              onClick={handleCurrentLocation}
              className="shadow-md bg-white hover:bg-slate-100 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-100 border border-slate-300 dark:border-slate-600 h-8 px-2.5 gap-1.5 text-xs font-medium cursor-pointer"
              title="Set center to current location"
            >
              {locating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-teal-600" />
              ) : (
                <LocateFixed className="h-3.5 w-3.5 text-teal-600" />
              )}
              <span>Current Location</span>
            </Button>
            {locError && (
              <span className="text-[10px] bg-rose-50 text-rose-600 dark:bg-rose-950 dark:text-rose-300 border border-rose-200 dark:border-rose-800 px-2 py-0.5 rounded shadow max-w-[240px] text-right">
                {locError}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 px-4 py-3 bg-slate-50 dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800">
          <p className="text-xs tabular-nums text-slate-500 font-mono">
            {pos.latitude.toFixed(6)}, {pos.longitude.toFixed(6)}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button size="sm" onClick={() => { onConfirm(pos); onOpenChange(false) }}>
              Confirm Location
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ── Branch add/edit dialog ────────────────────────────────────────────────────
// Compact two-column design matching spec image:
// Row 1: Branch Code | Branch Name *
// Row 2: Type (full width) | Contact (full width)
// Row 3: Address (full width span-2)
// Row 4: Operating Hours | Branch Manager (full width)
// Row 5: Latitude + Longitude + Set on Map button | Geo-fence Radius (m)
// Row 6: Fence Window Start & End (short width, left column) | Active & Geo-fence switches (right column)
function BranchDialog({
  open,
  onOpenChange,
  editRec,
  nextCode,
  employees,
  onSaved,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  editRec: any | null
  nextCode: string | null
  employees: any[]
  onSaved: () => void
}) {
  const toast = useHrm((s) => s.toast)
  const isEdit = !!editRec

  // ── form state ──
  const [code, setCode] = useState("")
  const [name, setName] = useState("")
  const [type, setType] = useState("STORE")
  const [contact, setContact] = useState("")
  const [address, setAddress] = useState("")
  const [operatingHours, setOperatingHours] = useState("")
  const [managerId, setManagerId] = useState("")
  const [latitude, setLatitude] = useState<number | "">("")
  const [longitude, setLongitude] = useState<number | "">("")
  const [geofenceRadius, setGeofenceRadius] = useState<number | "">(200)
  const [geofenceStartTime, setGeofenceStartTime] = useState("")
  const [geofenceEndTime, setGeofenceEndTime] = useState("")
  const [geofenceActive, setGeofenceActive] = useState(true)
  const [active, setActive] = useState(true)
  const [mapOpen, setMapOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const wasOpen = useRef(false)
  // Initialise on closed→open transition.
  useEffect(() => {
    if (open && !wasOpen.current) {
      if (editRec) {
        setCode(editRec.code ?? "")
        setName(editRec.name ?? "")
        setType(editRec.type ?? "STORE")
        setContact(editRec.contact ?? "")
        setAddress(editRec.address ?? "")
        setOperatingHours(editRec.operatingHours ?? "")
        setManagerId(editRec.managerId ?? "")
        setLatitude(editRec.latitude ?? "")
        setLongitude(editRec.longitude ?? "")
        setGeofenceRadius(editRec.geofenceRadius ?? 200)
        setGeofenceStartTime(editRec.geofenceStartTime ?? "")
        setGeofenceEndTime(editRec.geofenceEndTime ?? "")
        setGeofenceActive(editRec.geofenceActive ?? true)
        setActive(editRec.active ?? true)
      } else {
        setCode(nextCode ?? "")
        setName("")
        setType("STORE")
        setContact("")
        setAddress("")
        setOperatingHours("")
        setManagerId("")
        setLatitude("")
        setLongitude("")
        setGeofenceRadius(200)
        setGeofenceStartTime("")
        setGeofenceEndTime("")
        setGeofenceActive(true)
        setActive(true)
      }
      setError(null)
    }
    wasOpen.current = open
  }, [open, editRec, nextCode])

  const submit = async () => {
    if (!name.trim()) { setError("Branch Name is required"); return }
    setBusy(true)
    setError(null)
    try {
      const payload: any = {
        name: name.trim(),
        type,
        contact: contact || undefined,
        address: address || undefined,
        operatingHours: operatingHours || undefined,
        managerId: managerId || undefined,
        latitude: latitude !== "" ? Number(latitude) : undefined,
        longitude: longitude !== "" ? Number(longitude) : undefined,
        geofenceRadius: geofenceRadius !== "" ? Number(geofenceRadius) : undefined,
        geofenceStartTime: geofenceStartTime || undefined,
        geofenceEndTime: geofenceEndTime || undefined,
        geofenceActive,
        active,
      }
      if (isEdit) {
        await rpc("branches.update", { id: editRec.id, ...payload })
      } else {
        await rpc("branches.create", { code: code || undefined, ...payload })
      }
      toast("Saved successfully")
      onOpenChange(false)
      onSaved()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const latNum = latitude !== "" ? Number(latitude) : 23.8103
  const lngNum = longitude !== "" ? Number(longitude) : 90.4078

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v) }}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-base">
              {isEdit ? `Edit — ${editRec?.name}` : "Add Branch"}
            </DialogTitle>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-x-4 gap-y-3 py-1">
            {/* Row 1: Branch Code | Branch Name */}
            <div className="space-y-1">
              <Label className="text-xs font-medium text-slate-600 dark:text-slate-300">
                Branch Code
              </Label>
              <Input
                value={code}
                disabled
                readOnly
                className="font-mono bg-slate-50 dark:bg-slate-900 text-slate-500 dark:text-slate-400"
              />
              {isEdit && (
                <p className="text-[11px] text-slate-500">
                  Assigned code — contact an administrator to change it.
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label className="text-xs font-medium text-slate-600 dark:text-slate-300">
                Branch Name <span className="text-rose-500 ml-0.5">*</span>
              </Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>

            {/* Row 2: Type (full width matching Branch Code) | Contact (full width) */}
            <div className="space-y-1">
              <Label className="text-xs font-medium text-slate-600 dark:text-slate-300">Type</Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {BRANCH_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{titleCase(t)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs font-medium text-slate-600 dark:text-slate-300">Contact</Label>
              <Input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="+880 1761743494" />
            </div>

            {/* Row 3: Address — full width span-2 */}
            <div className="space-y-1 col-span-2">
              <Label className="text-xs font-medium text-slate-600 dark:text-slate-300">Address</Label>
              <Textarea value={address} onChange={(e) => setAddress(e.target.value)} rows={2} />
            </div>

            {/* Row 4: Operating Hours | Branch Manager (full width matching Contact) */}
            <div className="space-y-1">
              <Label className="text-xs font-medium text-slate-600 dark:text-slate-300">Operating Hours</Label>
              <Input value={operatingHours} onChange={(e) => setOperatingHours(e.target.value)} placeholder="09:00 AM - 18:00 PM" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs font-medium text-slate-600 dark:text-slate-300">Branch Manager</Label>
              <Select value={managerId || "__none__"} onValueChange={(v) => setManagerId(v === "__none__" ? "" : v)}>
                <SelectTrigger className="w-full"><SelectValue placeholder="— None —" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">— None —</SelectItem>
                  {employees.map((e: any) => (
                    <SelectItem key={e.id} value={e.id}>{e.fullName} ({e.code})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Row 5: Latitude + Longitude + Set on Map button | Geo-fence Radius (m) */}
            <div>
              <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-end">
                <div className="space-y-1">
                  <Label className="text-xs font-medium text-slate-600 dark:text-slate-300 whitespace-nowrap">
                    Latitude (geo-fence)
                  </Label>
                  <Input
                    type="number"
                    step="0.000001"
                    value={latitude}
                    onChange={(e) => setLatitude(e.target.value === "" ? "" : Number(e.target.value))}
                    className="tabular-nums"
                    placeholder="23.7925"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs font-medium text-slate-600 dark:text-slate-300 whitespace-nowrap">
                    Longitude (geo-fence)
                  </Label>
                  <Input
                    type="number"
                    step="0.000001"
                    value={longitude}
                    onChange={(e) => setLongitude(e.target.value === "" ? "" : Number(e.target.value))}
                    className="tabular-nums"
                    placeholder="90.4078"
                  />
                </div>
                <div className="space-y-1 flex flex-col items-center">
                  <Label className="text-xs font-medium text-slate-600 dark:text-slate-300 whitespace-nowrap">
                    Set on Map
                  </Label>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    title="Set on Map"
                    className="h-8 w-12 text-slate-700 dark:text-slate-200 border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
                    onClick={() => setMapOpen(true)}
                  >
                    <Crosshair className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs font-medium text-slate-600 dark:text-slate-300">
                Geo-fence Radius (m)
              </Label>
              <Input
                type="number"
                min={20}
                value={geofenceRadius}
                onChange={(e) => setGeofenceRadius(e.target.value === "" ? "" : Number(e.target.value))}
                placeholder="200"
              />
            </div>

            {/* Row 6:
                Left column: Fence Window Start & Fence Window End side-by-side with short width
                Right column: Active & Geo-fence attendance enabled switches at previous position of Fence Window End */}
            <div className="space-y-1">
              <div className="flex items-start gap-4">
                <div className="space-y-1">
                  <Label className="text-xs font-medium text-slate-600 dark:text-slate-300 whitespace-nowrap">
                    Fence Window Start
                  </Label>
                  <Input
                    type="time"
                    value={geofenceStartTime}
                    onChange={(e) => setGeofenceStartTime(e.target.value)}
                    className="w-32 tabular-nums"
                  />
                  <p className="text-[11px] text-slate-500 whitespace-nowrap">punches accepted from</p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs font-medium text-slate-600 dark:text-slate-300 whitespace-nowrap">
                    Fence Window End
                  </Label>
                  <Input
                    type="time"
                    value={geofenceEndTime}
                    onChange={(e) => setGeofenceEndTime(e.target.value)}
                    className="w-32 tabular-nums"
                  />
                  <p className="text-[11px] text-slate-500 whitespace-nowrap">punches accepted until</p>
                </div>
              </div>
            </div>

            <div className="flex flex-col justify-center gap-2.5 pt-2">
              <div className="flex items-center gap-2.5">
                <Switch id="branch-active" checked={active} onCheckedChange={setActive} />
                <Label htmlFor="branch-active" className="text-xs font-medium text-slate-600 dark:text-slate-300 cursor-pointer">
                  Active
                </Label>
              </div>
              <div className="flex items-center gap-2.5">
                <Switch id="branch-geofence-active" checked={geofenceActive} onCheckedChange={setGeofenceActive} />
                <Label htmlFor="branch-geofence-active" className="text-xs font-medium text-slate-600 dark:text-slate-300 cursor-pointer">
                  Geo-fence attendance enabled
                </Label>
              </div>
            </div>
          </div>

          <FieldError message={error} />

          <DialogFooter className="gap-2 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
            <Button onClick={submit} disabled={busy} className="bg-emerald-600 hover:bg-emerald-700 text-white font-medium">
              {busy ? <><Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />Saving…</> : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Map picker — opens on "Set on Map" */}
      <GeoMapPickerDialog
        open={mapOpen}
        onOpenChange={setMapOpen}
        latitude={latNum}
        longitude={lngNum}
        radiusM={geofenceRadius !== "" ? Number(geofenceRadius) : 200}
        onConfirm={(pos) => {
          setLatitude(Number(pos.latitude.toFixed(6)))
          setLongitude(Number(pos.longitude.toFixed(6)))
        }}
      />
    </>
  )
}

export default function OrganizationView() {
  return (
    <div className="space-y-4">
      <PageHeader title="Organization Structure" subtitle="Branches with geo-fence, departments and designations" />
      {/* M-23 — search deep links pre-select the tab */}
      <SectionTabs defaultValue={(useHrm((st) => (st.view?.key === "organization" && (st.view?.params as any)?.tab)) as string) || "branches"} tabs={[
        { value: "branches", label: "Branches", content: <BranchesTab /> },
        { value: "departments", label: "Departments", content: <DepartmentsTab /> },
        { value: "designations", label: "Designations", content: <DesignationsTab /> },
      ]} />
    </div>
  )
}

function BranchesTab() {
  const { can } = useHrm()
  const { data, loading, error, reload } = useApi<any[]>("branches.list", {})
  const { data: employees } = useEmployeeDirectory()
  const [open, setOpen] = useState(false)
  const [editRec, setEditRec] = useState<any>(null)
  const [delTarget, setDelTarget] = useState<any>(null)
  // 2026-10 — the next auto code, fetched when the CREATE dialog opens
  const [nextCode, setNextCode] = useState<string | null>(null)

  const openCreate = async () => {
    setEditRec(null)
    setNextCode(null)
    // fetch the next code BEFORE opening — BranchDialog initializes its values
    // on the closed→open transition, so the code must be ready at that moment.
    // A failed fetch still opens (blank code → server auto-generates).
    try {
      const res = await rpc<{ code: string }>("branches.nextCode", {})
      setNextCode(res?.code || null)
    } catch { /* the server still auto-generates on blank at create time */ }
    setOpen(true)
  }

  const columns: Column<any>[] = [
    {
      key: "name", label: "Branch", render: (b) => (
        <div className="flex items-center gap-2.5">
          <div className="h-8 w-8 rounded-lg bg-emerald-50 dark:bg-emerald-950 flex items-center justify-center shrink-0">
            {b.type === "WAREHOUSE" ? <Warehouse className="h-4 w-4 text-emerald-600" /> : b.type === "OFFICE" ? <Building className="h-4 w-4 text-emerald-600" /> : <Store className="h-4 w-4 text-emerald-600" />}
          </div>
          <div>
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{b.name}</p>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">{b.code} · {titleCase(b.type)}</p>
          </div>
        </div>
      ),
    },
    { key: "address", label: "Address", render: (b) => <span className="text-xs text-slate-500">{b.address || "—"}</span> },
    { key: "geofence", label: "Geo-Fence", render: (b) => b.geofenceActive && b.latitude ? <Badge className="bg-teal-100 text-teal-700 text-[10px]"><MapPin className="h-3 w-3 mr-0.5" />{b.geofenceRadius}m</Badge> : <span className="text-xs text-slate-400">off</span> },
    { key: "hours", label: "Hours", render: (b) => <span className="text-xs text-slate-500 tabular-nums">{b.operatingHours || "—"}</span> },
    {
      key: "employees",
      label: "Total Employee",
      align: "right",
      render: (b) => {
        const count = b.employeeCount ?? b._count?.employees ?? (employees || []).filter((e: any) => e.branchId === b.id).length
        return <span className="text-xs font-bold tabular-nums text-slate-700 dark:text-slate-200">{count}</span>
      },
    },
    { key: "active", label: "Status", render: (b) => <Badge className={b.active ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"}>{b.active ? "Active" : "Inactive"}</Badge> },
    {
      key: "actions", label: "", align: "right", render: (b) => can("organization", "edit") && (
        <div className="flex gap-1">
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => { setEditRec(b); setOpen(true) }}><Pencil className="h-3.5 w-3.5" /></Button>
          <Button size="icon" variant="ghost" className="h-7 w-7 text-slate-400 hover:text-rose-600" onClick={() => setDelTarget(b)}><Trash2 className="h-3.5 w-3.5" /></Button>
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Branches" value={data?.length ?? "—"} icon={Building2} tone="emerald" />
        <StatCard label="Geo-fenced" value={(data || []).filter((b) => b.geofenceActive && b.latitude).length} icon={MapPin} tone="teal" />
        <StatCard label="Stores" value={(data || []).filter((b) => b.type === "STORE").length} icon={Store} tone="violet" />
        <StatCard label="Warehouses" value={(data || []).filter((b) => b.type === "WAREHOUSE").length} icon={Warehouse} tone="amber" />
      </div>
      {can("organization", "create") && (
        <Button size="sm" onClick={openCreate} className=" h-8">
          <Plus className="h-3.5 w-3.5 mr-1" /> Add Branch
        </Button>
      )}
      <DataTable columns={columns} rows={data || undefined} loading={loading} error={error} pageSize={10} csvName="branches" emptyTitle="No branches" />

      <BranchDialog
        open={open}
        onOpenChange={(v) => { setOpen(v); if (!v) { setEditRec(null); setNextCode(null) } }}
        editRec={editRec}
        nextCode={nextCode}
        employees={employees || []}
        onSaved={reload}
      />
      <ConfirmDialog open={!!delTarget} onOpenChange={(v) => { if (!v) setDelTarget(null) }} title="Delete branch"
        message={`Delete "${delTarget?.name}"? Blocked if employees are assigned.`} danger confirmLabel="Delete"
        onConfirm={async () => { await rpc("branches.delete", { id: delTarget.id }); reload() }} />
    </div>
  )
}

function DepartmentsTab() {
  const { can } = useHrm()
  const { data, loading, error, reload } = useApi<any[]>("departments.list", {})
  const { data: branches } = useApi<any[]>("branches.list", {})
  const { data: employees } = useEmployeeDirectory()
  const [open, setOpen] = useState(false)
  const [editRec, setEditRec] = useState<any>(null)
  const [delTarget, setDelTarget] = useState<any>(null)
  const [nextCode, setNextCode] = useState<string | null>(null)

  const openCreate = async () => {
    setEditRec(null)
    setNextCode(null)
    // fetch the next code BEFORE opening — FormDialog initializes its values
    // on the closed→open transition, so the code must be in `initial` at that
    // moment. A failed fetch still opens (blank code → server auto-generates).
    try {
      const res = await rpc<{ code: string }>("departments.nextCode", {})
      setNextCode(res?.code || null)
    } catch { /* the server still auto-generates on blank at create time */ }
    setOpen(true)
  }

  const fields: FieldDef[] = [
    editRec
      ? { name: "code", label: "Department Code", help: "Assigned code — contact an administrator to change it." }
      : lockedCodeField(nextCode, "DEPT"),
    { name: "name", label: "Name (English)", required: true },
    { name: "nameBn", label: "Name (Bangla)", placeholder: "বিভাগের নাম" },
    { name: "branchId", label: "Branch", type: "select", options: (branches || []).map((b: any) => ({ value: b.id, label: b.name })) },
    { name: "headId", label: "Department Head", type: "select", options: (employees || []).map((e: any) => ({ value: e.id, label: `${e.fullName} (${e.code})` })) },
    { name: "description", label: "Description", type: "textarea", span: 2 },
    { name: "status", label: "Status", type: "select", options: ["ACTIVE", "INACTIVE"].map((s) => ({ value: s, label: s })), defaultValue: "ACTIVE" },
  ]

  const columns: Column<any>[] = [
    {
      key: "name", label: "Department", render: (d) => (
        <div>
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{d.name}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">{d.code}{d.nameBn ? ` · ${d.nameBn}` : ""}</p>
        </div>
      ),
    },
    { key: "branchName", label: "Branch", render: (d) => <span className="text-xs text-slate-600 dark:text-slate-300">{(branches || []).find((b) => b.id === d.branchId)?.name || "—"}</span> },
    { key: "head", label: "Head", render: (d) => <span className="text-xs text-slate-600 dark:text-slate-300">{(employees || []).find((e) => e.id === d.headId)?.fullName || "—"}</span> },
    {
      key: "count",
      label: "Employees",
      align: "right",
      render: (d) => {
        const count = d.employeeCount ?? d._count?.employees ?? (employees || []).filter((e) => e.departmentId === d.id).length
        return <span className="text-xs font-bold tabular-nums">{count}</span>
      },
    },
    { key: "status", label: "Status", render: (d) => <Badge className={d.status === "ACTIVE" ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"}>{titleCase(d.status)}</Badge> },
    {
      key: "actions", label: "", align: "right", render: (d) => can("organization", "edit") && (
        <div className="flex gap-1">
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => { setEditRec(d); setOpen(true) }}><Pencil className="h-3.5 w-3.5" /></Button>
          <Button size="icon" variant="ghost" className="h-7 w-7 text-slate-400 hover:text-rose-600" onClick={() => setDelTarget(d)}><Trash2 className="h-3.5 w-3.5" /></Button>
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-3">
      {can("organization", "create") && (
        <Button size="sm" onClick={openCreate} className=" h-8">
          <Plus className="h-3.5 w-3.5 mr-1" /> Add Department
        </Button>
      )}
      <DataTable columns={columns} rows={data || undefined} loading={loading} error={error} pageSize={10} csvName="departments" emptyTitle="No departments" />
      <FormDialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setEditRec(null); setNextCode(null); reload() } }}
        title={editRec ? `Edit — ${editRec.name}` : "Add Department"} fields={fields}
        initial={editRec || (nextCode ? { code: nextCode } : undefined)} wide
        description={editRec ? undefined : "The department code is generated automatically and locked (DEPT-0001, DEPT-0002, …)."}
        onSubmit={async (v) => { await rpc(editRec ? "departments.update" : "departments.create", editRec ? { id: editRec.id, ...v } : v) }} />
      <ConfirmDialog open={!!delTarget} onOpenChange={(v) => { if (!v) setDelTarget(null) }} title="Delete department"
        message={`Delete "${delTarget?.name}"?`} danger confirmLabel="Delete"
        onConfirm={async () => { await rpc("departments.delete", { id: delTarget.id }); reload() }} />
    </div>
  )
}

function DesignationsTab() {
  const { can } = useHrm()
  const { data, loading, error, reload } = useApi<any[]>("designations.list", {})
  const { data: departments } = useApi<any[]>("departments.list", {})
  const { data: employees } = useEmployeeDirectory()
  const [open, setOpen] = useState(false)
  const [editRec, setEditRec] = useState<any>(null)
  const [delTarget, setDelTarget] = useState<any>(null)
  const [nextCode, setNextCode] = useState<string | null>(null)

  const openCreate = async () => {
    setEditRec(null)
    setNextCode(null)
    // fetch the next code BEFORE opening — FormDialog initializes its values
    // on the closed→open transition, so the code must be in `initial` at that
    // moment. A failed fetch still opens (blank code → server auto-generates).
    try {
      const res = await rpc<{ code: string }>("designations.nextCode", {})
      setNextCode(res?.code || null)
    } catch { /* the server still auto-generates on blank at create time */ }
    setOpen(true)
  }

  const fields: FieldDef[] = [
    editRec
      ? { name: "code", label: "Code", help: "Assigned code — contact an administrator to change it." }
      : lockedCodeField(nextCode, "DESIG"),
    { name: "name", label: "Designation", required: true },
    { name: "nameBn", label: "Bangla Name" },
    { name: "departmentId", label: "Department", type: "select", options: (departments || []).map((d: any) => ({ value: d.id, label: d.name })) },
    { name: "grade", label: "Grade", placeholder: "A / B / C" },
    { name: "minSalary", label: "Minimum Salary (৳)", type: "number" },
    { name: "maxSalary", label: "Maximum Salary (৳)", type: "number" },
    { name: "description", label: "Description", type: "textarea", span: 2 },
    { name: "status", label: "Status", type: "select", options: ["ACTIVE", "INACTIVE"].map((s) => ({ value: s, label: s })), defaultValue: "ACTIVE" },
  ]

  const columns: Column<any>[] = [
    {
      key: "name", label: "Designation", render: (d) => (
        <div>
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{d.name}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">{d.code}{d.nameBn ? ` · ${d.nameBn}` : ""}</p>
        </div>
      ),
    },
    { key: "department", label: "Department", render: (d) => <span className="text-xs text-slate-600 dark:text-slate-300">{(departments || []).find((x) => x.id === d.departmentId)?.name || "—"}</span> },
    { key: "grade", label: "Grade", render: (d) => d.grade ? <Badge variant="outline" className="text-[10px]">{d.grade}</Badge> : "—" },
    { key: "range", label: "Salary Range", render: (d) => <span className="text-xs text-slate-500 tabular-nums">{d.minSalary ? `${fmtMoney(d.minSalary)} – ${fmtMoney(d.maxSalary)}` : "—"}</span> },
    {
      key: "count",
      label: "Holders",
      align: "right",
      render: (d) => {
        const count = d.employeeCount ?? d._count?.employees ?? (employees || []).filter((e) => e.designationId === d.id).length
        return <span className="text-xs font-bold tabular-nums">{count}</span>
      },
    },
    {
      key: "actions", label: "", align: "right", render: (d) => can("organization", "edit") && (
        <div className="flex gap-1">
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => { setEditRec(d); setOpen(true) }}><Pencil className="h-3.5 w-3.5" /></Button>
          <Button size="icon" variant="ghost" className="h-7 w-7 text-slate-400 hover:text-rose-600" onClick={() => setDelTarget(d)}><Trash2 className="h-3.5 w-3.5" /></Button>
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-3">
      {can("organization", "create") && (
        <Button size="sm" onClick={openCreate} className=" h-8">
          <Plus className="h-3.5 w-3.5 mr-1" /> Add Designation
        </Button>
      )}
      <DataTable columns={columns} rows={data || undefined} loading={loading} error={error} pageSize={10} csvName="designations" emptyTitle="No designations" />
      <FormDialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setEditRec(null); setNextCode(null); reload() } }}
        title={editRec ? `Edit — ${editRec.name}` : "Add Designation"} fields={fields}
        initial={editRec || (nextCode ? { code: nextCode } : undefined)} wide
        description={editRec ? undefined : "The designation code is generated automatically and locked (DESIG-0001, DESIG-0002, …)."}
        onSubmit={async (v) => { await rpc(editRec ? "designations.update" : "designations.create", editRec ? { id: editRec.id, ...v } : v) }} />
      <ConfirmDialog open={!!delTarget} onOpenChange={(v) => { if (!v) setDelTarget(null) }} title="Delete designation"
        message={`Delete "${delTarget?.name}"?`} danger confirmLabel="Delete"
        onConfirm={async () => { await rpc("designations.delete", { id: delTarget.id }); reload() }} />
    </div>
  )
}
