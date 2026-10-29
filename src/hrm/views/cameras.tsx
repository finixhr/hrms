"use client"
// ============ Camera Manager — main list view (Phase 6 + UI fixes) ============
// Mirrors the attendance-devices.tsx pattern per CONVENTIONS.md.
// Deviation from confirmed decision: uses custom Dialog instead of FormDialog
// for the create/edit form — FormDialog can't render brand-conditional fields
// (verificationCode hidden for EZVIZ/IMOU, required for HIKVISION/DAHUA).
// Accepted by user in Phase 6 review.
//
// Launch UX: Option A (deep link + web portal + copy details, no SDK).
import { useEffect, useMemo, useState } from "react"
import {
  Plus, RefreshCw, Camera, Trash2, Power, PowerOff, Play, ExternalLink, Copy,
  Check, AlertTriangle, Key, Settings2, Loader2, ShieldCheck, Info, X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { useHrm } from "../store"
import { useApi, rpc } from "../api"
import {
  PageHeader, StatCard, StatusBadge, KV, SectionCard, fmtDate, fmtDateTime,
} from "../shared/ui-kit"
import { DataTable, type Column } from "../shared/data-table"
import { ConfirmDialog } from "../shared/form-dialog"

// ---------- types ----------

type CameraRow = {
  id: string
  brand: string
  name: string
  model: string | null
  serialNumber: string | null
  channel: number
  hasVerificationCode: boolean
  branchId: string | null
  location: string | null
  installDate: string | null
  status: string
  lastStatusCheckAt: string | null
  lastSeenAt: string | null
  lastError: string | null
  enabled: boolean
  createdAt: string
  updatedAt: string
}

type CameraListResponse = {
  cameras: CameraRow[]
  counts: { ONLINE: number; OFFLINE: number; UNKNOWN: number; total: number }
}

type Branch = { id: string; name: string; code: string }

type LaunchResult = {
  launchTarget:
    | { kind: "DEEP_LINK"; url: string }
    | { kind: "QR_CODE"; payload: string }
    | { kind: "CLOUD_STREAM_TOKEN"; url: string; accessToken: string; expiresAt: string }
  fallbackWebUrl: string
}

// ---------- brand visual config ----------

const BRAND_COLORS: Record<string, string> = {
  HIKVISION: "bg-blue-100 text-blue-700 border-blue-200",
  DAHUA: "bg-green-100 text-green-700 border-green-200",
  EZVIZ: "bg-orange-100 text-orange-700 border-orange-200",
  IMOU: "bg-red-100 text-red-700 border-red-200",
}

function BrandBadge({ brand }: { brand: string }) {
  const cls = BRAND_COLORS[brand] || "bg-slate-100 text-slate-700 border-slate-200"
  return <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${cls}`}>{brand}</span>
}

const BRAND_OPTIONS = [
  { value: "HIKVISION", label: "Hikvision" },
  { value: "DAHUA", label: "Dahua" },
  { value: "EZVIZ", label: "EZVIZ" },
  { value: "IMOU", label: "Imou" },
]

const isPerCameraBrand = (b: string) => b === "HIKVISION" || b === "DAHUA"

// All 6 camera permissions (for the debug badge — Fix 3)
const CAMERA_PERMS = [
  { key: "view", label: "View cameras" },
  { key: "create", label: "Register cameras" },
  { key: "edit", label: "Edit camera metadata" },
  { key: "delete", label: "Decommission cameras" },
  { key: "launch", label: "Launch live view" },
  { key: "manage", label: "Manage brand credentials" },
]

// ---------- main view ----------

export default function CamerasView() {
  const { can, toast, user } = useHrm()
  const [filterBrand, setFilterBrand] = useState<string>("")
  const [filterStatus, setFilterStatus] = useState<string>("")
  const { data, loading, error, reload } = useApi<CameraListResponse>("camera.list", {
    ...(filterBrand ? { brand: filterBrand } : {}),
    // WP-B (CCTV review §3.5) — ALWAYS fetch disabled rows too: the
    // Active/Disabled/All filters are pure client-side filters, so the
    // "Disabled" view must actually receive decommissioned cameras.
    includeDisabled: true,
  })
  const { data: branches } = useApi<Branch[]>("branches.list", {})

  const [formOpen, setFormOpen] = useState(false)
  const [editCam, setEditCam] = useState<CameraRow | null>(null)
  const [deleteCam, setDeleteCam] = useState<CameraRow | null>(null)
  const [restoreCam, setRestoreCam] = useState<CameraRow | null>(null)
  const [launchCam, setLaunchCam] = useState<CameraRow | null>(null)
  const [statusBusy, setStatusBusy] = useState<string | null>(null)
  const [credOpen, setCredOpen] = useState(false)
  const [permDebugOpen, setPermDebugOpen] = useState(false)

  // Fix 2: fetch credential state for pre-flight guidance in the form.
  // WP-B (CCTV review §3.7) — gated to camera.manage holders: the route is
  // camera.manage-only, so viewers without it fired 403 noise on every load.
  const { data: credState } = useApi<Record<string, boolean>>(can("camera", "manage") ? "camera.credential.state" : null, {})

  // Wave 3 WP-A (2026-10-08) — users holding camera.manage, so the Add-Camera
  // pre-flight warning can name EXACTLY who to contact (not a generic "admin").
  // Gated on users.view (users.list requires it — R3-3 perm split); managers/
  // owners hold it — without it the form falls back to role-level guidance.
  const canSeeUsers = can("users", "view")
  const { data: usersList } = useApi<any[]>(canSeeUsers ? "users.list" : null, {})
  const credentialAdmins = (usersList || [])
    .filter((u) => u.status === "ACTIVE" && (u.role === "VENDOR_OWNER" || u.role === "HR_ADMIN" || (u.permissions || []).includes("camera.manage")))
    .map((u) => u.name)
    .slice(0, 5)

  const rows = useMemo(() => {
    if (!data?.cameras) return []
    if (filterStatus === "disabled") return data.cameras.filter((c) => !c.enabled)
    if (filterStatus === "") return data.cameras.filter((c) => c.enabled)
    return data.cameras
  }, [data, filterStatus])

  const counts = data?.counts || { ONLINE: 0, OFFLINE: 0, UNKNOWN: 0, total: 0 }
  const hasActiveFilters = filterBrand !== "" || filterStatus !== ""

  // ---------- columns ----------

  const columns: Column<CameraRow>[] = [
    {
      key: "name", label: "Camera",
      render: (r) => (
        <div className="flex flex-col">
          <span className="font-medium text-slate-800">{r.name}</span>
          <span className="text-xs text-slate-500">{r.model || "—"}</span>
        </div>
      ),
    },
    { key: "brand", label: "Brand", render: (r) => <BrandBadge brand={r.brand} /> },
    {
      key: "serialNumber", label: "Serial",
      render: (r) => (
        <div className="flex flex-col">
          <span className="text-sm font-mono">{r.serialNumber || "—"}</span>
          <span className="text-xs text-slate-500">CH {r.channel}</span>
        </div>
      ),
    },
    {
      key: "branchId", label: "Location",
      render: (r) => {
        const br = branches?.find((b) => b.id === r.branchId)
        return (
          <div className="flex flex-col">
            <span className="text-sm">{br?.name || "Unassigned"}</span>
            <span className="text-xs text-slate-500">{r.location || "—"}</span>
          </div>
        )
      },
    },
    {
      key: "status", label: "Status",
      render: (r) => (
        <div className="flex flex-col gap-0.5">
          <StatusBadge status={r.enabled ? r.status : "DISABLED"} />
          {r.lastError && (
            <span className="text-xs text-rose-600 flex items-center gap-0.5" title={r.lastError}>
              <AlertTriangle className="h-3 w-3" /> Error
            </span>
          )}
        </div>
      ),
    },
    {
      key: "lastStatusCheckAt", label: "Last Check",
      render: (r) => (
        <div className="flex flex-col">
          <span className="text-sm">{r.lastStatusCheckAt ? fmtDateTime(r.lastStatusCheckAt) : "—"}</span>
          <span className="text-xs text-slate-500">{r.lastSeenAt ? `Seen ${fmtDate(r.lastSeenAt)}` : ""}</span>
        </div>
      ),
    },
    {
      key: "actions", label: "Actions", align: "right",
      render: (r) => (
        <div className="flex items-center gap-1">
          {can("camera", "launch") && r.enabled && (
            <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setLaunchCam(r) }} title="Launch">
              <Play className="h-4 w-4" />
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); refreshStatus(r) }} disabled={statusBusy === r.id} title="Refresh status">
            {statusBusy === r.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
          {can("camera", "edit") && r.enabled && (
            <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setEditCam(r); setFormOpen(true) }} title="Edit">
              <Settings2 className="h-4 w-4" />
            </Button>
          )}
          {can("camera", "delete") && r.enabled && (
            <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setDeleteCam(r) }} title="Decommission">
              <Power className="h-4 w-4 text-rose-600" />
            </Button>
          )}
          {can("camera", "edit") && !r.enabled && (
            <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setRestoreCam(r) }} title="Restore">
              <PowerOff className="h-4 w-4 text-emerald-600" />
            </Button>
          )}
        </div>
      ),
    },
  ]

  async function refreshStatus(cam: CameraRow) {
    setStatusBusy(cam.id)
    try {
      await rpc("camera.status", { id: cam.id })
      toast("Status refreshed", "ok")
      reload()
    } catch (e: any) {
      toast(e?.message || "Status check failed", "err")
    } finally {
      setStatusBusy(null)
    }
  }

  // ---------- render ----------

  return (
    <div className="space-y-5">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            Camera Manager
            {/* Fix 3: permission debug badge */}
            <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => setPermDebugOpen(true)} title="Show my permissions">
              <Info className="h-4 w-4 text-slate-400" />
            </Button>
          </span>
        }
        subtitle="CCTV device registry — live viewing via brand cloud handoff"
        actions={
          <>
            <Button variant="outline" onClick={reload} title="Refresh list">
              <RefreshCw className="h-4 w-4" />
            </Button>
            {/* Fix 4: Credentials button already gated on camera.manage ✓ */}
            {can("camera", "manage") && (
              <Button variant="outline" onClick={() => setCredOpen(true)}>
                <Key className="h-4 w-4 mr-1" /> Credentials
              </Button>
            )}
            {can("camera", "create") && (
              <Button onClick={() => { setEditCam(null); setFormOpen(true) }}>
                <Plus className="h-4 w-4 mr-1" /> Add Camera
              </Button>
            )}
          </>
        }
      />

      {/* Fix 3: Permission debug dialog */}
      <Dialog open={permDebugOpen} onOpenChange={setPermDebugOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><ShieldCheck className="h-5 w-5" /> My Camera Permissions</DialogTitle>
            <DialogDescription>Resolved at login from your role + grants.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            {CAMERA_PERMS.map((p) => {
              const granted = can("camera", p.key)
              return (
                <div key={p.key} className="flex items-center justify-between text-sm py-1">
                  <span className="text-slate-700">{p.label}</span>
                  <span className={`font-mono text-xs ${granted ? "text-emerald-600" : "text-rose-500"}`}>
                    {granted ? "✓ granted" : "✗ missing"}
                  </span>
                </div>
              )
            })}
          </div>
          <div className="text-xs text-slate-400 border-t pt-2">
            Permissions are resolved at login. If your admin recently changed your role, log out and back in.
          </div>
        </DialogContent>
      </Dialog>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Total" value={counts.total} icon={Camera} tone="slate" />
        <StatCard label="Online" value={counts.ONLINE} icon={Camera} tone="emerald" />
        <StatCard label="Offline" value={counts.OFFLINE} icon={Camera} tone="rose" />
        <StatCard label="Unknown" value={counts.UNKNOWN} icon={AlertTriangle} tone="amber" />
      </div>

      {/* Filters */}
      <div className="flex gap-3 items-end">
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-slate-500">Brand</Label>
          <Select value={filterBrand} onValueChange={setFilterBrand}>
            <SelectTrigger className="w-40"><SelectValue placeholder="All brands" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="">All brands</SelectItem>
              {BRAND_OPTIONS.map((b) => <SelectItem key={b.value} value={b.value}>{b.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-slate-500">Status</Label>
          <Select value={filterStatus} onValueChange={setFilterStatus}>
            <SelectTrigger className="w-40"><SelectValue placeholder="Active" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="">Active</SelectItem>
              <SelectItem value="disabled">Disabled</SelectItem>
              <SelectItem value="all">All</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {hasActiveFilters && (
          <Button size="sm" variant="ghost" onClick={() => { setFilterBrand(""); setFilterStatus("") }}>
            <X className="h-3 w-3 mr-1" /> Clear filters
          </Button>
        )}
      </div>

      {/* Fix 4: Improved empty state with permission-aware copy */}
      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        error={error}
        csvName="cameras"
        emptyTitle={hasActiveFilters ? "No cameras match your filters" : "No cameras"}
        emptyHint={
          hasActiveFilters
            ? "Try adjusting or clearing your filters."
            : can("camera", "create")
              ? "Click 'Add Camera' to register your first CCTV camera."
              : "No cameras registered. Contact your admin to add cameras."
        }
        onRowClick={(r) => { if (can("camera", "edit") && r.enabled) { setEditCam(r); setFormOpen(true) } }}
      />

      {/* Fix 1: Custom create/edit dialog with brand-conditional fields */}
      {formOpen && (
        <CameraFormDialog
          editCam={editCam}
          branches={branches || []}
          isBM={user?.role === "BRANCH_MANAGER"}
          bmBranchId={user?.branchId || undefined}
          credState={credState || {}}
          canManage={can("camera", "manage")}
          credentialAdmins={credentialAdmins}
          onClose={() => { setFormOpen(false); setEditCam(null) }}
          onSubmit={async (values) => {
            const payload = { ...values, brand: String(values.brand || "").toUpperCase(), channel: Number(values.channel) || 1 }
            if (editCam) {
              await rpc("camera.update", { id: editCam.id, ...payload })
            } else {
              await rpc("camera.create", payload)
            }
            setFormOpen(false); setEditCam(null); reload()
          }}
          onOpenCred={() => { setFormOpen(false); setEditCam(null); setCredOpen(true) }}
        />
      )}

      {/* Delete (soft-delete) confirmation */}
      <ConfirmDialog
        open={!!deleteCam}
        onOpenChange={(o) => !o && setDeleteCam(null)}
        title="Decommission Camera"
        message={`Decommission '${deleteCam?.name}'? The camera will be hidden from the active list. Restore it later if needed.`}
        danger
        confirmLabel="Decommission"
        requireReason
        onConfirm={async (reason) => {
          if (!deleteCam) return
          await rpc("camera.delete", { id: deleteCam.id, reason })
          setDeleteCam(null); reload()
        }}
      />

      {/* Restore confirmation */}
      <ConfirmDialog
        open={!!restoreCam}
        onOpenChange={(o) => !o && setRestoreCam(null)}
        title="Restore Camera"
        message={`Restore '${restoreCam?.name}' to active status?`}
        confirmLabel="Restore"
        onConfirm={async () => {
          if (!restoreCam) return
          await rpc("camera.restore", { id: restoreCam.id })
          setRestoreCam(null); reload()
        }}
      />

      {/* Launch dialog */}
      {launchCam && <LaunchDialog cam={launchCam} onClose={() => setLaunchCam(null)} />}

      {/* Credential management panel */}
      <CredentialPanel open={credOpen} onOpenChange={setCredOpen} canManage={can("camera", "manage")} />
    </div>
  )
}

// ====================================================================
// Fix 1 + Fix 2: Custom Camera Form Dialog with brand-conditional fields
// ====================================================================

function CameraFormDialog({
  editCam, branches, isBM, bmBranchId, credState, canManage, credentialAdmins, onClose, onSubmit, onOpenCred,
}: {
  editCam: CameraRow | null
  branches: Branch[]
  isBM: boolean
  bmBranchId?: string
  credState: Record<string, boolean>
  canManage: boolean
  credentialAdmins: string[]
  onClose: () => void
  onSubmit: (values: any) => Promise<void>
  onOpenCred: () => void
}) {
  const { toast } = useHrm()
  const [brand, setBrand] = useState<string>(editCam?.brand || "")
  const [name, setName] = useState<string>(editCam?.name || "")
  const [model, setModel] = useState<string>(editCam?.model || "")
  const [serialNumber, setSerialNumber] = useState<string>(editCam?.serialNumber || "")
  const [channel, setChannel] = useState<number>(editCam?.channel || 1)
  const [verificationCode, setVerificationCode] = useState<string>("")
  const [branchId, setBranchId] = useState<string>(editCam?.branchId || (isBM ? bmBranchId : "") || "")
  const [location, setLocation] = useState<string>(editCam?.location || "")
  const [installDate, setInstallDate] = useState<string>(editCam?.installDate || "")
  const [busy, setBusy] = useState(false)

  const isPerCam = isPerCameraBrand(brand)
  const isTenantCred = brand === "EZVIZ" || brand === "IMOU"
  const needsCreds = isTenantCred && !credState[brand]

  function handleSubmit() {
    // Validate
    if (!name.trim()) { toast("Camera name is required", "err"); return }
    if (!brand) { toast("Brand is required", "err"); return }
    if (isPerCam && !verificationCode.trim()) { toast("Verification code is required for " + brand, "err"); return }
    if (isTenantCred && !serialNumber.trim()) { toast("Serial number is required for " + brand, "err"); return }

    setBusy(true)
    const payload: any = {
      name: name.trim(),
      brand: brand.toUpperCase(),
      model: model.trim() || undefined,
      serialNumber: serialNumber.trim() || undefined,
      channel,
      branchId: branchId || undefined,
      location: location.trim() || undefined,
      installDate: installDate || undefined,
    }
    if (isPerCam) payload.verificationCode = verificationCode.trim()
    // Don't send verificationCode for EZVIZ/IMOU (not used)

    onSubmit(payload).catch((e) => {
      toast(e?.message || "Save failed", "err")
    }).finally(() => setBusy(false))
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editCam ? "Edit Camera" : "Add Camera"}</DialogTitle>
          <DialogDescription>{editCam ? `Update ${editCam.name}` : "Register a new CCTV camera"}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3 py-2">
          {/* Name */}
          <div className="col-span-2 space-y-1">
            <Label className="text-xs">Camera Name <span className="text-rose-500">*</span></Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Warehouse Gate 2" />
          </div>

          {/* Brand */}
          <div className="space-y-1">
            <Label className="text-xs">Brand <span className="text-rose-500">*</span></Label>
            <Select value={brand} onValueChange={setBrand}>
              <SelectTrigger><SelectValue placeholder="Select a brand" /></SelectTrigger>
              <SelectContent>
                {BRAND_OPTIONS.map((b) => <SelectItem key={b.value} value={b.value}>{b.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          {/* Model */}
          <div className="space-y-1">
            <Label className="text-xs">Model</Label>
            <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. DS-2CD2043G2" />
          </div>

          {/* Serial Number — conditional required marker */}
          <div className="space-y-1">
            <Label className="text-xs">
              Serial Number
              {isTenantCred && <span className="text-rose-500"> *</span>}
            </Label>
            <Input
              value={serialNumber}
              onChange={(e) => setSerialNumber(e.target.value)}
              placeholder="Device serial"
            />
            <p className="text-[10px] text-slate-400">
              {isPerCam
                ? "Informational — the brand cloud uses verificationCode to launch"
                : isTenantCred
                  ? "Required — per-camera identifier in your cloud account"
                  : brand === ""
                    ? "Select a brand first"
                    : ""}
            </p>
          </div>

          {/* Channel */}
          <div className="space-y-1">
            <Label className="text-xs">Channel</Label>
            <Input type="number" min={1} value={channel} onChange={(e) => setChannel(Number(e.target.value) || 1)} />
          </div>

          {/* Verification Code — ONLY for HIKVISION/DAHUA (Fix 1) */}
          {isPerCam && (
            <div className="col-span-2 space-y-1">
              <Label className="text-xs">Verification Code <span className="text-rose-500">*</span></Label>
              <Input
                value={verificationCode}
                onChange={(e) => setVerificationCode(e.target.value)}
                placeholder="Printed on the device sticker"
              />
              <p className="text-[10px] text-slate-400">Write-only — shown once at registration, then stripped from every API response. The brand cloud needs this to launch.</p>
            </div>
          )}

          {/* Fix 2: Pre-flight guidance for EZVIZ/IMOU without credentials.
              Wave 3 WP-A — the hint names where the keys come from, and the
              non-manager branch names exactly who to contact. */}
          {needsCreds && (
            <div className="col-span-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
              <div className="flex items-center gap-2 text-amber-800">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span className="font-medium">{brand} credentials not set up.</span>
              </div>
              <div className="mt-1.5 ml-6 space-y-1">
                {canManage ? (
                  <button onClick={onOpenCred} className="text-emerald-700 hover:text-emerald-800 font-medium underline">
                    Configure now →
                  </button>
                ) : (
                  <span className="text-amber-700">
                    Contact your tenant admin to configure {brand} credentials
                    {credentialAdmins.length > 0 ? `: ${credentialAdmins.join(", ")}` : " (any Vendor Owner or HR Admin user)."}
                  </span>
                )}
                <p className="text-[11px] text-amber-600">
                  {brand === "EZVIZ"
                    ? "Get your appKey and appSecret from the EZVIZ Open Platform (open.ezvizlife.com) → your application."
                    : "Get your appId and appSecret from the Imou Open Platform (open.imoulife.com) → your application."}
                </p>
              </div>
            </div>
          )}

          {/* Branch */}
          <div className="space-y-1">
            <Label className="text-xs">Branch</Label>
            <Select value={branchId} onValueChange={setBranchId} disabled={isBM}>
              <SelectTrigger><SelectValue placeholder="Unassigned" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="">Unassigned</SelectItem>
                {branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-[10px] text-slate-400">{isBM ? "Auto-set to your branch" : "Leave empty for unassigned"}</p>
          </div>

          {/* Sub-Location */}
          <div className="space-y-1">
            <Label className="text-xs">Sub-Location</Label>
            <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Gate 2, Reception" />
          </div>

          {/* Install Date */}
          <div className="space-y-1">
            <Label className="text-xs">Install Date</Label>
            <Input type="date" value={installDate} onChange={(e) => setInstallDate(e.target.value)} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {editCam ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ====================================================================
// Launch dialog (Option A) — unchanged
// ====================================================================

function LaunchDialog({ cam, onClose }: { cam: CameraRow; onClose: () => void }) {
  const { toast } = useHrm()
  const [launch, setLaunch] = useState<LaunchResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string>("")
  const [expiresInMinutes, setExpiresInMinutes] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    rpc<LaunchResult>("camera.launch", { id: cam.id })
      .then((r) => {
        if (cancelled) return
        setLaunch(r)
        if (r.launchTarget.kind === "CLOUD_STREAM_TOKEN") {
          const expiry = new Date(r.launchTarget.expiresAt).getTime()
          setExpiresInMinutes(Math.max(0, Math.round((expiry - Date.now()) / 60_000)))
        }
      })
      .catch((e) => { if (!cancelled) setError(e?.message || "Launch failed") })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [cam])

  function copy(text: string, label: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(label)
      toast(`${label} copied`, "ok")
      setTimeout(() => setCopied(""), 2000)
    })
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Camera className="h-5 w-5" /> Launch: {cam.name}
          </DialogTitle>
          <DialogDescription>
            <BrandBadge brand={cam.brand} />{" "}
            {cam.serialNumber && <span className="text-xs font-mono ml-2">{cam.serialNumber}</span>}
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
          </div>
        )}

        {error && (
          <div className="bg-rose-50 border border-rose-200 rounded-lg p-3 text-sm text-rose-700">{error}</div>
        )}

        {/* Extract launchTarget to a const so TypeScript can narrow the
            DEEP_LINK / CLOUD_STREAM_TOKEN / QR_CODE union inside the JSX blocks. */}
        {launch && (
          <div className="space-y-4">
            <a href={launch.fallbackWebUrl} target="_blank" rel="noopener noreferrer">
              <Button className="w-full ">
                <ExternalLink className="h-4 w-4 mr-2" /> Open {cam.brand} Portal
              </Button>
            </a>
            {(() => {
              const lt = launch.launchTarget as any
              return (
                <>
                  {lt.kind === "DEEP_LINK" && lt.url !== launch.fallbackWebUrl && (
                    <a href={lt.url} target="_blank" rel="noopener noreferrer">
                      <Button variant="outline" className="w-full">
                        <ExternalLink className="h-4 w-4 mr-2" /> Open {cam.brand} App
                      </Button>
                    </a>
                  )}
                  {lt.kind === "CLOUD_STREAM_TOKEN" && (
                    <div className="space-y-2">
                      <div className="bg-slate-50 border rounded-lg p-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-medium text-slate-600">Stream URL</span>
                          <button onClick={() => copy(lt.url, "Stream URL")} className="text-xs text-emerald-600 hover:text-emerald-700 flex items-center gap-1">
                            {copied === "Stream URL" ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />} Copy
                          </button>
                        </div>
                        <code className="text-xs break-all block bg-white p-2 rounded border">{lt.url}</code>
                      </div>
                      <div className="bg-slate-50 border rounded-lg p-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-medium text-slate-600">Access Token</span>
                          <button onClick={() => copy(lt.accessToken, "Access Token")} className="text-xs text-emerald-600 hover:text-emerald-700 flex items-center gap-1">
                            {copied === "Access Token" ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />} Copy
                          </button>
                        </div>
                        <code className="text-xs break-all block bg-white p-2 rounded border">{lt.accessToken}</code>
                      </div>
                      <div className="text-xs text-slate-500 flex items-center gap-1">
                        <AlertTriangle className="h-3 w-3" />
                        Expires at {fmtDateTime(lt.expiresAt)}
                        {expiresInMinutes !== null && ` (${expiresInMinutes} minutes from now)`}
                      </div>
                    </div>
                  )}
                  {/* UI-8-C2 — QR_CODE launch-target rendering path. */}
                  {lt.kind === "QR_CODE" && (
                    <div className="space-y-2">
                      <div className="bg-slate-50 border rounded-lg p-3 space-y-2">
                        <div className="text-xs font-medium text-slate-600">QR Code Payload</div>
                        <code className="text-xs break-all block bg-white p-2 rounded border">{lt.payload}</code>
                        <div className="text-xs text-slate-500">
                          Scan this QR code with the {cam.brand} mobile app to bind the camera to your account.
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )
            })()}

            <div className="border-t pt-3 space-y-1">
              <div className="text-xs font-medium text-slate-600 mb-2">Camera Details</div>
              <KV items={[
                ["Serial", cam.serialNumber || "—"],
                ["Channel", String(cam.channel)],
                ["Location", cam.location || "—"],
              ]} cols={3} />
            </div>

            {cam.hasVerificationCode && (cam.brand === "HIKVISION" || cam.brand === "DAHUA") && (
              <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                <AlertTriangle className="h-3 w-3 inline mr-1" />
                This camera has a verification code registered. Enter it in the {cam.brand} app to add the device — the code is not displayed here for security. Re-register the camera to get a new code.
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ====================================================================
// Credential management panel — unchanged
// ====================================================================

function CredentialPanel({ open, onOpenChange, canManage }: { open: boolean; onOpenChange: (o: boolean) => void; canManage: boolean }) {
  const { toast } = useHrm()
  const [credBrand, setCredBrand] = useState<string>("EZVIZ")
  const [credFormOpen, setCredFormOpen] = useState(false)
  const [deleteBrand, setDeleteBrand] = useState<string | null>(null)
  const [deleteCount, setDeleteCount] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  // WP-B (CCTV review §3.7) — gated to camera.manage holders (canManage prop):
  // the route requires camera.manage, so viewers without it fired 403 noise.
  const { data: credState, reload: reloadCredState } = useApi<Record<string, boolean>>(canManage ? "camera.credential.state" : null, {})

  async function handleCredSubmit(values: any) {
    setBusy(true)
    try {
      await rpc("camera.credential.upsert", { brand: credBrand, ...values })
      toast(`${credBrand} credentials saved`, "ok")
      setCredFormOpen(false)
      reloadCredState()
    } catch (e: any) {
      toast(e?.message || "Failed to save credentials", "err")
    } finally {
      setBusy(false)
    }
  }

  async function checkDeleteCount(brand: string) {
    setBusy(true)
    try {
      const list = await rpc<CameraListResponse>("camera.list", { brand, includeDisabled: true })
      setDeleteCount(list.cameras.length)
    } catch { setDeleteCount(0) }
    finally { setBusy(false) }
  }

  async function confirmDelete() {
    if (!deleteBrand) return
    setBusy(true)
    try {
      await rpc("camera.credential.delete", { brand: deleteBrand })
      toast(`${deleteBrand} credentials deleted`, "ok")
      setDeleteBrand(null); setDeleteCount(null)
      reloadCredState()
    } catch (e: any) {
      toast(e?.message || "Failed to delete credentials", "err")
    } finally {
      setBusy(false)
    }
  }

  if (!canManage) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Key className="h-5 w-5" /> Brand Credentials</DialogTitle>
          <DialogDescription>Tenant-level cloud credentials for EZVIZ/Imou. Hikvision/Dahua use per-camera verification codes (no tenant creds needed).</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Select value={credBrand} onValueChange={setCredBrand}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="EZVIZ">EZVIZ</SelectItem>
              <SelectItem value="IMOU">Imou</SelectItem>
            </SelectContent>
          </Select>

          <SectionCard title={`${credBrand} Credentials`} actions={
            <div className="flex gap-2 items-center">
              {credState?.[credBrand] ? (
                <Badge className="bg-emerald-50 text-emerald-700 border-emerald-200">
                  <Check className="h-3 w-3 mr-1" /> Configured
                </Badge>
              ) : (
                <Badge className="bg-slate-50 text-slate-500 border-slate-200">
                  <AlertTriangle className="h-3 w-3 mr-1" /> Not configured
                </Badge>
              )}
              <Button size="sm" variant="outline" onClick={() => setCredFormOpen(true)} disabled={busy}>
                {busy ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Plus className="h-3 w-3 mr-1" />}
                {credState?.[credBrand] ? "Rotate" : "Configure"}
              </Button>
              {credState?.[credBrand] && (
                <Button size="sm" variant="outline" onClick={() => { setDeleteBrand(credBrand); checkDeleteCount(credBrand) }} disabled={busy} className="text-rose-600">
                  <Trash2 className="h-3 w-3 mr-1" /> Delete
                </Button>
              )}
            </div>
          }>
            <p className="text-sm text-slate-500">
              {credState?.[credBrand]
                ? `${credBrand} credentials are configured. Use "Rotate" to replace with new keys.`
                : `Configure ${credBrand} cloud credentials to enable camera launches. Credentials are encrypted at rest and never displayed after saving.`}
            </p>
          </SectionCard>
        </div>

        {/* Credential form — uses FormDialog for password masking */}
        {credFormOpen && (
          <Dialog open onOpenChange={(o) => !o && setCredFormOpen(false)}>
            <DialogContent className="sm:max-w-md" onClick={(e) => e.stopPropagation()}>
              <DialogHeader>
                <DialogTitle>{credBrand} Credentials</DialogTitle>
                <DialogDescription>App keys from the brand&apos;s Open Platform developer console.</DialogDescription>
              </DialogHeader>
              <div className="space-y-3 py-2">
                {credBrand === "EZVIZ" ? (
                  <>
                    <div className="space-y-1">
                      <Label className="text-xs">App Key <span className="text-rose-500">*</span></Label>
                      <Input id="appKey" placeholder="EZVIZ Open Platform appKey" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">App Secret <span className="text-rose-500">*</span></Label>
                      <Input id="appSecret" type="password" placeholder="EZVIZ Open Platform appSecret" />
                    </div>
                  </>
                ) : (
                  <>
                    <div className="space-y-1">
                      <Label className="text-xs">App ID <span className="text-rose-500">*</span></Label>
                      <Input id="appId" placeholder="Imou Open Platform appId" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">App Secret <span className="text-rose-500">*</span></Label>
                      <Input id="appSecret" type="password" placeholder="Imou Open Platform appSecret" />
                    </div>
                  </>
                )}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setCredFormOpen(false)}>Cancel</Button>
                <Button disabled={busy} onClick={() => {
                  const appKey = (document.getElementById("appKey") as HTMLInputElement)?.value
                  const appId = (document.getElementById("appId") as HTMLInputElement)?.value
                  const appSecret = (document.getElementById("appSecret") as HTMLInputElement)?.value
                  handleCredSubmit(credBrand === "EZVIZ" ? { appKey, appSecret } : { appId, appSecret })
                }}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Save
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}

        <ConfirmDialog
          open={!!deleteBrand}
          onOpenChange={(o) => { if (!o) { setDeleteBrand(null); setDeleteCount(null) } }}
          title="Delete Credentials"
          message={deleteCount !== null
            ? `${deleteCount} ${deleteBrand} camera(s) will become unlaunchable. Proceed?`
            : "Loading affected camera count..."}
          danger
          confirmLabel="Delete"
          onConfirm={confirmDelete}
        />
      </DialogContent>
    </Dialog>
  )
}
