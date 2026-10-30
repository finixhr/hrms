"use client"
// ============ ZKTeco ADMS device management UI (spec §6, §21–§24) ============
// Tabs rendered inside the Attendance & Shifts view:
//   Devices · Device Events · Unknown Device Users · Sync Monitor
import { useEffect, useMemo, useState } from "react"
import {
  Loader2, Plus, RefreshCw, Fingerprint, Radio, AlertTriangle, UserX,
  Activity, Power, PowerOff, Wrench, Eye, RotateCw, Zap, Clock, MapPin, Trash2, UploadCloud, CheckCircle2, KeyRound,
  Info, History, CalendarRange, XCircle,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { useHrm } from "../store"
import { useApi, rpc, useEmployeeDirectory } from "../api"
import {
  StatCard, StatusBadge, KV, SectionCard,
  fmtDateTime,
} from "../shared/ui-kit"
import { DataTable, type Column } from "../shared/data-table"
import { ConfirmDialog, FormDialog, type FieldDef } from "../shared/form-dialog"

type Dev = any

const STATUS_DOT: Record<string, string> = {
  ONLINE: "bg-emerald-500",
  WARNING: "bg-amber-500",
  OFFLINE: "bg-rose-500",
  DISABLED: "bg-slate-400",
}

function DeviceStatusBadge({ d }: { d: Dev }) {
  const s = d.derivedStatus || "OFFLINE"
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium">
      <span className={`h-2 w-2 rounded-full ${STATUS_DOT[s] || "bg-slate-400"} ${s === "ONLINE" ? "animate-pulse" : ""}`} />
      <span className={
        s === "ONLINE" ? "text-emerald-600" : s === "WARNING" ? "text-amber-600" :
        s === "OFFLINE" ? "text-rose-600" : "text-slate-400"
      }>{s === "ONLINE" ? "Online" : s === "WARNING" ? "Warning" : s === "OFFLINE" ? "Offline" : "Disabled"}</span>
    </span>
  )
}

function ProcStatusBadge({ s }: { s: string }) {
  const tone: Record<string, string> = {
    PROCESSED: "bg-emerald-50 text-emerald-700 border-emerald-200",
    RECEIVED: "bg-sky-50 text-sky-700 border-sky-200",
    PROCESSING: "bg-indigo-50 text-indigo-700 border-indigo-200",
    UNKNOWN_EMPLOYEE: "bg-amber-50 text-amber-700 border-amber-200",
    FAILED: "bg-rose-50 text-rose-700 border-rose-200",
    DEAD_LETTER: "bg-rose-100 text-rose-900 border-rose-400 font-semibold",
    SKIPPED_MANUAL: "bg-slate-100 text-slate-600 border-slate-200",
    OUT_OF_WINDOW: "bg-violet-50 text-violet-700 border-violet-200",
  }
  return <Badge variant="outline" className={`text-[10px] ${tone[s] || ""}`}>{s.replace(/_/g, " ")}</Badge>
}

// ============================================================
// Device Config Hint — the OFFICIAL ZKTeco Push SDK / ADMS configuration
// guidance shown to HR admins. Lists the exact Server URL & key the admin
// must enter into the device's "Communication → Push" menu, plus the
// Hikvision ISAPI URL for Hikvision DS-K1T terminals (common in BD).
// ============================================================
function DeviceConfigHint() {
  const [origin, setOrigin] = useState<string>("")
  const [pingResult, setPingResult] = useState<string | null>(null)
  const [pingBusy, setPingBusy] = useState(false)
  useEffect(() => {
    if (typeof window !== "undefined") setOrigin(window.location.origin)
  }, [])
  // Strip the path; ZKTeco firmware APPENDS /iclock/cdata to whatever the
  // admin enters — so the admin should enter ONLY the protocol + host (+port).
  const zktecoUrl = origin || "https://your-hrm-server.example.com"
  const hikUrl = zktecoUrl + "/ISAPI/AccessControl/Notification/streamData"
  const pingUrl = zktecoUrl + "/iclock/ping"

  const runPing = async () => {
    setPingBusy(true)
    setPingResult("Testing…")
    try {
      const r = await fetch(pingUrl)
      const t = await r.text()
      setPingResult(`✓ HTTP ${r.status} — gateway reachable\n${t}`)
    } catch (e: any) {
      setPingResult(`❌ Cannot reach gateway: ${e.message}\nThis usually means the dev server is binding to localhost only, or a firewall is blocking port 3000.`)
    } finally {
      setPingBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50/60 dark:bg-emerald-950/30 px-3 py-2.5 text-[11px] space-y-1.5">
      <div className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-300 font-medium">
        <Radio className="h-3.5 w-3.5" /> Device configuration — official ZKTeco Push SDK / ADMS
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1 text-slate-600 dark:text-slate-300">
        <div>
          <span className="font-medium">ZKTeco (SenseFace / SpeedFace / ProFace):</span>
          <br />
          <span>Menu → Comm → Cloud Server Settings:</span>
          <br />
          <span className="font-mono text-emerald-700 dark:text-emerald-300">Server Address: </span>
          <span className="font-mono">{origin ? new URL(origin).hostname : "—"}</span>
          <br />
          <span className="font-mono text-emerald-700 dark:text-emerald-300">Server Port: </span>
          <span className="font-mono">{origin ? new URL(origin).port || (origin.startsWith("https") ? "443" : "80") : "3000"}</span>
          <br />
          <span className="font-mono text-emerald-700 dark:text-emerald-300">Server Mode: </span>
          <span className="font-mono">ADMS</span>
          <br />
          <span>Protocol appends <code className="font-mono">/iclock/cdata</code> automatically.</span>
        </div>
        <div>
          <span className="font-medium">Hikvision (DS-K1T series):</span>
          <br />
          <span>Web UI → Event → Notification Server:</span>
          <br />
          <span className="font-mono text-emerald-700 dark:text-emerald-300">URL: </span>
          <span className="font-mono break-all">{hikUrl}</span>
          <br />
          <span className="text-amber-700 dark:text-amber-400">⚠ Hikvision ISAPI — Experimental / not yet supported in production. Event ingestion is implemented, but the integration is unverified against real DS-K1T firmware; see notes below.</span>
        </div>
      </div>
      <div className="pt-1.5 border-t border-emerald-200 dark:border-emerald-900 space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-slate-600 dark:text-slate-300">Gateway reachability test:</span>
          <code className="font-mono text-[10px] text-slate-500 break-all">{pingUrl}</code>
          <Button size="sm" variant="outline" className="h-6 text-[10px]" disabled={pingBusy} onClick={runPing}>
            {pingBusy ? "Testing…" : "Test from this PC"}
          </Button>
        </div>
        {pingResult && (
          <pre className={`text-[10px] font-mono whitespace-pre-wrap rounded-md px-2 py-1.5 ${
            pingResult.startsWith("✓")
              ? "bg-emerald-100 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300"
              : pingResult.startsWith("❌")
                ? "bg-rose-100 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300"
                : "bg-slate-100 dark:bg-slate-800 text-slate-600"
          }`}>{pingResult}</pre>
        )}
        <p className="text-[10px] text-slate-500">
          ✓ = gateway is reachable from THIS PC. To verify the device can reach it too,
          open the same URL in a browser on a PC connected to the SAME network/Wi-Fi as the device.
          If that also works but the device still shows Offline, reboot the device — it authenticates
          by its registered serial number (no key or secret is needed on the terminal).
        </p>
      </div>
      <div className="pt-1 border-t border-emerald-200 dark:border-emerald-900 text-slate-500 dark:text-slate-400">
        <span className="font-medium">Compatibility:</span> ZKTeco SpeedFace V5L / SenseFace 3A / ProFace X TI / ProFace X [D] / ProFace X [T] / MB460-VL / SpeedFace-V4L ·
        Hikvision DS-K1T804 / DS-K1T201 / DS-K1T501 (common models in BD).
        <br />
        No third-party API or middleware (ZKBioTime / C3 / ZKAccess) is required — the device pushes directly to this HRM.
      </div>
    </div>
  )
}

function fmtDT(d?: string | Date | null): string {
  if (!d) return "—"
  // L-4 — delegate to the shared formatter (vendor date/time preferences,
  // 12/24h clock) instead of a local en-GB hardcode
  return fmtDateTime(d)
}

type PushResult = {
  device: { id: string; name: string; sn: string }
  added: number
  alreadyRegistered: number
  commandQueued: boolean
  results: { employeeId: string; code: string; name: string; status: string; pin?: string }[]
  note: string
}

function ago(d?: string | Date | null): string {
  if (!d) return "never"
  const t = typeof d === "string" ? new Date(d.includes("T") ? d : d.replace(" ", "T") + "Z").getTime() : new Date(d).getTime()
  if (isNaN(t)) return "—"
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

// ============================================================
// Tab 1 — Devices
// ============================================================
export function AdmsDevicesTab() {
  const { can, toast } = useHrm()
  const { data, loading, error, reload } = useApi<Dev[]>("devices.list", {})
  const { data: branches } = useApi<any[]>("branches.list", {})
  const [open, setOpen] = useState(false)
  const [editDev, setEditDev] = useState<Dev | null>(null)
  const [detail, setDetail] = useState<Dev | null>(null)
  const [detailData, setDetailData] = useState<any>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [disableDev, setDisableDev] = useState<Dev | null>(null)
  const [deleteDev, setDeleteDev] = useState<Dev | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteMode, setDeleteMode] = useState<"soft" | "hard">("soft")
  const [pushResult, setPushResult] = useState<PushResult | null>(null)
  const [pushing, setPushing] = useState<string | null>(null)
  // R8 — historical attendance backfill dialog state
  const [historyDev, setHistoryDev] = useState<Dev | null>(null)
  // R9 — integration instructions popup
  const [configHintOpen, setConfigHintOpen] = useState(false)
  // C-03 — comm-key enrollment: dialog + the once-shown plaintext key
  const [keyDev, setKeyDev] = useState<Dev | null>(null)
  const [keyBusy, setKeyBusy] = useState(false)
  const [keyResult, setKeyResult] = useState<{ key: string; sn: string; note: string } | null>(null)
  const canCreate = can("devices", "create")
  const canEdit = can("devices", "edit")
  const canProcess = can("devices", "process")
  const canDelete = can("devices", "delete")

  const deviceFields: FieldDef[] = useMemo(() => [
    { name: "name", label: "Device Name", required: true, placeholder: "Head Office — SenseFace 3A" },
    { name: "deviceIdentifier", label: "Device Serial No. (SN)", required: true, placeholder: "e.g. CJXR251860053", help: "The exact SN the device pushes with — find it on the device label or Menu → Device Info" },
    { name: "protocol", label: "Protocol", type: "select", defaultValue: "ADMS", help: "ZKTeco pushes to /iclock/cdata (ADMS) · Hikvision pushes to /ISAPI/AccessControl/Notification/streamData",
      options: [{ value: "ADMS", label: "ZKTeco ADMS (Push SDK)" }, { value: "HIKVISION_ISAPI", label: "Hikvision ISAPI — Experimental / not yet supported" }] },
    { name: "model", label: "Model", defaultValue: "SenseFace 3A" },
    { name: "manufacturer", label: "Manufacturer", defaultValue: "ZKTeco" },
    { name: "branchId", label: "Branch", type: "select", options: (branches || []).map((b: any) => ({ value: b.id, label: b.name })) },
    { name: "location", label: "Mounted Location", placeholder: "Main entrance" },
    { name: "timezone", label: "Device Timezone", defaultValue: "Asia/Dhaka" },
  ], [branches])

  const openDetail = async (d: Dev) => {
    setDetail(d)
    setDetailData(null)
    try {
      const res = await rpc<any>("devices.get", { id: d.id })
      setDetailData(res)
    } catch (e: any) {
      toast(e.message, "err")
    }
  }

  const act = async (id: string, action: string, ok: (r: any) => string, extra?: Record<string, unknown>) => {
    setBusy(id + action)
    try {
      const r = await rpc<any>(action, { id, ...(extra || {}) })
      toast(ok(r))
      reload()
      if (detail?.id === id) openDetail({ ...detail })
    } catch (e: any) {
      toast(e.message, "err")
    } finally {
      setBusy(null)
    }
  }

  // Push employees → device: registers every in-scope active employee as a
  // device user (stable PIN, no duplicates) and queues a roster sync.
  const pushEmployees = async (d: Dev) => {
    setPushing(d.id)
    try {
      const r = await rpc<PushResult>("devices.pushEmployees", { deviceId: d.id })
      setPushResult(r)
      reload()
      if (detail?.id === d.id) openDetail({ ...detail })
    } catch (e: any) {
      toast(e.message, "err")
    } finally {
      setPushing(null)
    }
  }

  const columns: Column<Dev>[] = [
    {
      key: "name", label: "Device", sortValue: (d) => d.name,
      render: (d) => (
        <div className="flex items-center gap-2.5">
          <div className="h-8 w-8 rounded-lg bg-teal-50 dark:bg-teal-950 flex items-center justify-center shrink-0">
            <Fingerprint className="h-4 w-4 text-teal-600" />
          </div>
          <div>
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{d.name}</p>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono">{d.deviceIdentifier || d.deviceId}{d.model ? ` · ${d.model}` : ""}</p>
          </div>
        </div>
      ),
    },
    { key: "branchName", label: "Branch / Location", render: (d) => <span className="text-xs text-slate-600 dark:text-slate-300">{[d.branchName, d.location].filter(Boolean).join(" · ") || "—"}</span> },
    { key: "derivedStatus", label: "Status", sortValue: (d) => d.derivedStatus, render: (d) => <DeviceStatusBadge d={d} /> },
    { key: "lastSeenAt", label: "Last Seen", sortValue: (d) => String(d.lastSeenAt || ""), render: (d) => <span className="text-xs text-slate-500">{ago(d.lastSeenAt)}</span> },
    { key: "lastEventTime", label: "Last Punch", sortValue: (d) => d.lastEventTime || "", render: (d) => <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300">{d.lastEventTime ? d.lastEventTime.slice(11, 19) : "—"}</span> },
    { key: "todayEvents", label: "Today", align: "right", sortValue: (d) => d.todayEvents, render: (d) => <span className="text-xs font-semibold tabular-nums text-slate-700 dark:text-slate-200">{d.todayEvents}</span> },
    {
      key: "mappings", label: "Mappings", align: "right",
      render: (d) => (
        <span className="text-xs text-slate-500 tabular-nums">
          {d.activeMappings || 0} <span className="text-slate-300">/</span>
          {d.unknownUsers ? <span className="text-amber-600 font-semibold"> {d.unknownUsers} unknown</span> : " 0 unknown"}
        </span>
      ),
    },
    { key: "clockDrift", label: "Clock Drift", render: (d) => <span className="text-xs tabular-nums text-slate-500">{d.clockDrift || "—"}</span> },
    {
      key: "actions", label: "", align: "right",
      render: (d) => (
        <div className="flex items-center justify-end gap-1">
          <Button size="sm" variant="outline" className="h-7 text-[10px]" onClick={() => openDetail(d)}>
            <Eye className="h-3 w-3 mr-0.5" /> Details
          </Button>
          {canEdit && (
            <Button size="icon" variant="ghost" className="h-7 w-7 text-teal-600 hover:text-teal-700" title="Push employees to this device (register + sync roster)"
              disabled={pushing === d.id}
              onClick={() => pushEmployees(d)}>
              {pushing === d.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UploadCloud className="h-3.5 w-3.5" />}
            </Button>
          )}
          {canEdit && (
            <Button size="icon" variant="ghost" className={`h-7 w-7 ${d.hasCommKey ? "text-slate-400" : "text-amber-500"}`} title="Set / rotate comm key (C-03 device authentication)"
              disabled={keyBusy && keyDev?.id === d.id}
              onClick={() => { setKeyDev(d); setKeyResult(null) }}>
              <KeyRound className="h-3.5 w-3.5" />
            </Button>
          )}
          {canEdit && (
            <Button size="icon" variant="ghost" className="h-7 w-7" title="Edit device" onClick={() => { setEditDev(d); setOpen(true) }}>
              <Wrench className="h-3.5 w-3.5" />
            </Button>
          )}
          {canProcess && (
            <Button size="icon" variant="ghost" className="h-7 w-7" title="Queue CHECK command (test connection)" disabled={busy === d.id + "devices.test"}
              onClick={() => act(d.id, "devices.test", (r) => r.note)}>
              {busy === d.id + "devices.test" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
            </Button>
          )}
          {/* R8 — sync & pull OLD attendance data from the device's local storage */}
          {canProcess && (
            <Button size="icon" variant="ghost" className="h-7 w-7" title="Sync old attendance data from this device (historical backfill)"
              onClick={() => setHistoryDev(d)}>
              <span className="relative flex items-center justify-center">
                <History className="h-3.5 w-3.5" />
                {d.historySyncUntil && new Date(d.historySyncUntil) > new Date() && (
                  <span className="absolute -top-1.5 -right-1.5 flex h-2 w-2" title="Historical sync window active">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
                  </span>
                )}
              </span>
            </Button>
          )}
          {canEdit && (
            d.enabled ? (
              <Button size="icon" variant="ghost" className="h-7 w-7" title="Disable device" onClick={() => setDisableDev(d)}>
                <PowerOff className="h-3.5 w-3.5 text-rose-500" />
              </Button>
            ) : (
              <Button size="icon" variant="ghost" className="h-7 w-7" title="Enable device" disabled={busy === d.id + "devices.setEnabled"}
                onClick={() => act(d.id, "devices.setEnabled", () => "Device enabled — it will reconnect on its next push cycle", { enabled: true })}>
                <Power className="h-3.5 w-3.5 text-emerald-600" />
              </Button>
            )
          )}
          {canDelete && (
            <Button size="icon" variant="ghost" className="h-7 w-7 text-slate-400 hover:text-rose-600" title="Delete device"
              onClick={() => setDeleteDev(d)}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-500 max-w-2xl">
          ZKTeco terminals push punches directly to this HRM over the ADMS protocol — no ZKBioTime or intermediary software.
          Register a device with its serial number (SN), then open the integration instructions to configure the terminal.
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          {/* R9 — device integration/configuration instructions moved into this
              popup (was an always-visible block on the front of the tab). */}
          <Button size="sm" variant="outline" onClick={() => setConfigHintOpen(true)}
            className="h-8 text-xs bg-white dark:bg-slate-900" title="Device integration & configuration — official ZKTeco Push SDK / ADMS, gateway reachability test & compatibility info">
            <Info className="h-3.5 w-3.5 mr-1 text-teal-600" /> Instructions
          </Button>
          {canCreate && (
            <Button size="sm" onClick={() => { setEditDev(null); setOpen(true) }} className="h-8 text-xs ">
              <Plus className="h-3.5 w-3.5 mr-1" /> Register Device
            </Button>
          )}
        </div>
      </div>
      {/* R9 — full instructions (Push SDK / ADMS configuration + gateway
          reachability test + compatibility) open in this popup. */}
      <Dialog open={configHintOpen} onOpenChange={setConfigHintOpen}>
        <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Info className="h-4 w-4 text-teal-600" /> Device Integration &amp; Configuration
            </DialogTitle>
            <p className="text-xs text-slate-500">
              Official ZKTeco Push SDK / ADMS setup, gateway reachability test and device compatibility information.
            </p>
          </DialogHeader>
          <DeviceConfigHint />
        </DialogContent>
      </Dialog>
      <DataTable columns={columns} rows={data || undefined} loading={loading} error={error} pageSize={10}
        csvName="attendance-devices" searchPlaceholder="Search device / SN…" emptyTitle="No attendance devices registered"
        emptyHint="Register your SenseFace 3A with its serial number to start receiving pushes." />

      <FormDialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setEditDev(null); reload() } }}
        title={editDev ? "Edit Attendance Device" : "Register Attendance Device"}
        description={editDev ? "Device identity and placement" : "Pre-register the device — it becomes Online on its first push."}
        fields={deviceFields}
        initial={editDev ? {
          name: editDev.name, deviceIdentifier: editDev.deviceIdentifier,
          protocol: editDev.protocol === "HIKVISION_ISAPI" ? "HIKVISION_ISAPI" : "ADMS",
          model: editDev.model,
          manufacturer: editDev.manufacturer, branchId: editDev.branchId || "", location: editDev.location || "",
          timezone: editDev.timezone,
        } : undefined}
        submitLabel={editDev ? "Save Changes" : "Save Device"}
        onSubmit={async (v) => {
          const payload = { ...v, ...(editDev ? { id: editDev.id } : {}) }
          await rpc("devices.save", payload)
          toast(editDev ? "Device updated" : "Device registered — configure the ADMS URL on the terminal now")
        }} />

      <ConfirmDialog open={!!disableDev} onOpenChange={(v) => !v && setDisableDev(null)}
        title="Disable Device" message={`Disable ${disableDev?.name}? It will be rejected at the gateway until re-enabled. Historical attendance is preserved.`}
        confirmLabel="Disable Device" danger requireReason
        onConfirm={async (_reason) => {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): convert to an explicit null check
          await rpc("devices.setEnabled", { id: disableDev!.id, enabled: false })
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): convert to an explicit null check
          toast(`${disableDev!.name} disabled`)
          reload()
        }} />

      {/* C-03 — comm-key enrollment dialog: generates/rotates the device comm
          key and shows the plaintext EXACTLY ONCE for entry into the firmware. */}
      <Dialog open={!!keyDev} onOpenChange={(v) => { if (!v) { setKeyDev(null); setKeyResult(null); reload() } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-teal-600" /> Set Comm Key
            </DialogTitle>
          </DialogHeader>
          {keyDev && (
            <div className="space-y-3">
              <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 px-3 py-2">
                <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{keyDev.name}</p>
                <p className="text-[11px] text-slate-500 font-mono">{keyDev.deviceIdentifier}</p>
              </div>
              {!keyResult ? (
                <div className="space-y-3">
                  <p className="text-xs text-slate-500">
                    The comm key authenticates this terminal at the gateway (verified timing-safely against a salted
                    hash). {keyDev.hasCommKey ? "A key is already enrolled — generating a new one rotates it; the device must be re-keyed immediately." : "Leave blank to let the server generate a random key."}
                  </p>
                  <div className="space-y-1.5">
                    <Label htmlFor="commkey-input" className="text-xs">Custom key (optional, 4–64 printable chars)</Label>
                    <Input id="commkey-input" placeholder="Leave empty to auto-generate" autoComplete="off" />
                  </div>
                  <Button className="w-full bg-teal-600 hover:bg-teal-700 text-white" disabled={keyBusy}
                    onClick={async () => {
                      setKeyBusy(true)
                      try {
                        const input = document.getElementById("commkey-input") as HTMLInputElement | null
                        const r = await rpc<{ key: string; sn: string; note: string }>("devices.setCommKey",
                          { id: keyDev.id, ...(input?.value?.trim() ? { key: input.value.trim() } : {}) })
                        setKeyResult(r)
                        toast("Comm key enrolled — key it into the device firmware now")
                      } catch (e: any) {
                        toast(e.message, "err")
                      } finally {
                        setKeyBusy(false)
                      }
                    }}>
                    {keyBusy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <KeyRound className="h-4 w-4 mr-1" />}
                    {keyDev.hasCommKey ? "Generate New Key" : "Enroll Key"}
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="rounded-lg border-2 border-dashed border-amber-400 bg-amber-50 dark:bg-amber-950/40 px-4 py-3 text-center">
                    <p className="text-[10px] uppercase tracking-wider text-amber-700 dark:text-amber-400 font-semibold mb-1">Shown once — store it now</p>
                    <p className="text-2xl font-mono font-bold tracking-widest text-slate-900 dark:text-slate-50 select-all">{keyResult.key}</p>
                  </div>
                  <ol className="text-xs text-slate-500 space-y-1 list-decimal list-inside">
                    <li>On the device: <b>Menu → Communication → Comm Key</b> (or Options → Communication).</li>
                    <li>Enter the key above exactly (case-sensitive).</li>
                    <li>Save — the device includes it on every push automatically.</li>
                  </ol>
                  <Button variant="outline" className="w-full"
                    onClick={() => { navigator.clipboard?.writeText(keyResult.key).catch(() => {}); toast("Key copied to clipboard") }}>
                    Copy Key
                  </Button>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete device dialog — soft (only when no history) or hard (irreversible, removes all history). */}
      <Dialog open={!!deleteDev} onOpenChange={(v) => { if (!v) { setDeleteDev(null); setDeleteMode("soft") } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              <Trash2 className="h-4 w-4 text-rose-600" /> Delete Attendance Device
            </DialogTitle>
          </DialogHeader>
          {deleteDev && (
            <div className="space-y-3">
              <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 px-3 py-2">
                <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{deleteDev.name}</p>
                <p className="text-[11px] text-slate-500 font-mono">{deleteDev.deviceIdentifier} · {deleteDev.model || "—"}</p>
              </div>
              <div className="space-y-2">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input type="radio" name="devDelMode" checked={deleteMode === "soft"} onChange={() => setDeleteMode("soft")}
                    className="mt-0.5 accent-emerald-600" />
                  <div>
                    <p className="text-sm font-medium text-slate-700 dark:text-slate-200">Delete (preserves history)</p>
                    <p className="text-[11px] text-slate-500">Removes the device only if it has no attendance events or mappings. Fails otherwise — use the hard-delete option below.</p>
                  </div>
                </label>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input type="radio" name="devDelMode" checked={deleteMode === "hard"} onChange={() => setDeleteMode("hard")}
                    className="mt-0.5 accent-rose-600" />
                  <div>
                    <p className="text-sm font-medium text-rose-700 dark:text-rose-400">Permanently delete (removes all history)</p>
                    <p className="text-[11px] text-slate-500">Irreversible. Removes the device AND all its raw events, employee mappings, comm logs, and queued commands. Use ONLY for dummy / test devices.</p>
                  </div>
                </label>
              </div>
              {deleteMode === "hard" && (
                <div className="rounded-md bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900 px-3 py-2 text-[11px] text-rose-700 dark:text-rose-300">
                  ⚠ This cannot be undone. All attendance events, employee mappings, and comm logs for this device will be permanently deleted.
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setDeleteDev(null); setDeleteMode("soft") }} disabled={deleteBusy}>Cancel</Button>
            <Button
              disabled={deleteBusy}
              className={deleteMode === "hard" ? "bg-rose-600 hover:bg-rose-700 text-white" : "bg-amber-600 hover:bg-amber-700 text-white"}
              onClick={async () => {
                if (!deleteDev) return
                setDeleteBusy(true)
                try {
                  if (deleteMode === "hard") {
                    const r = await rpc<{ deleted: boolean; name: string; sn: string; events: number; mappings: number; commLogs: number; commands: number }>(
                      "devices.hardDelete", { id: deleteDev.id, confirm: "DELETE" }
                    )
                    toast(`Permanently deleted ${r.name} (SN ${r.sn}) — removed ${r.events} events, ${r.mappings} mappings, ${r.commLogs} comm logs, ${r.commands} commands`)
                  } else {
                    await rpc("devices.delete", { id: deleteDev.id })
                    toast(`${deleteDev.name} deleted`)
                  }
                  setDeleteDev(null)
                  setDeleteMode("soft")
                  reload()
                } catch (e: any) {
                  toast(e.message, "err")
                } finally {
                  setDeleteBusy(false)
                }
              }}>
              {deleteBusy ? "Deleting…" : deleteMode === "hard" ? "Permanently Delete" : "Delete Device"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {detail && (
        <DeviceDetailDialog device={detail} data={detailData}
          onOpenChange={(v) => { if (!v) { setDetail(null); setDetailData(null) } }}
          onRefresh={() => { reload(); openDetail(detail) }} />
      )}

      {pushResult && (
        <Dialog open onOpenChange={() => setPushResult(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-base flex items-center gap-2">
                <UploadCloud className="h-4 w-4 text-teal-600" /> Employee Push — {pushResult.device.name}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2 text-[11px]">
                <Badge className="bg-emerald-100 text-emerald-700"><CheckCircle2 className="h-3 w-3 mr-0.5" />{pushResult.added} new</Badge>
                <Badge className="bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">{pushResult.alreadyRegistered} already registered</Badge>
                {pushResult.commandQueued && <Badge className="bg-teal-100 text-teal-700">roster sync queued</Badge>}
              </div>
              <p className="text-xs text-slate-500">{pushResult.note}</p>
              <div className="rounded-lg border max-h-64 overflow-y-auto">
                <table className="w-full text-[11px]">
                  <thead className="bg-slate-50 dark:bg-slate-800/80 sticky top-0">
                    <tr>
                      <th className="text-left px-2 py-1.5 font-medium text-slate-500">Employee</th>
                      <th className="text-left px-2 py-1.5 font-medium text-slate-500">Code</th>
                      <th className="text-left px-2 py-1.5 font-medium text-slate-500">PIN</th>
                      <th className="text-left px-2 py-1.5 font-medium text-slate-500">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pushResult.results.slice(0, 200).map((r) => (
                      <tr key={r.employeeId} className="border-t border-slate-100 dark:border-slate-800">
                        <td className="px-2 py-1 text-slate-700 dark:text-slate-200 max-w-[160px] truncate">{r.name}</td>
                        <td className="px-2 py-1 font-mono text-slate-500">{r.code}</td>
                        <td className="px-2 py-1 font-mono text-slate-500">{r.pin || "—"}</td>
                        <td className="px-2 py-1">
                          {r.status === "ADDED"
                            ? <span className="text-emerald-600 font-medium">registered</span>
                            : <span className="text-slate-500">already on device</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {pushResult.results.length > 200 && (
                <p className="text-[10px] text-slate-400">Showing first 200 of {pushResult.results.length} employees.</p>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setPushResult(null)}>Close</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* R8 — historical attendance backfill dialog */}
      <SyncHistoryDialog device={historyDev} onOpenChange={(v) => { if (!v) setHistoryDev(null); reload() }} onDone={reload} />
    </div>
  )
}

// ============================================================
// R8 — Historical attendance sync dialog (pull OLD punches
// from the device's local storage with a widened ingest window)
// ============================================================
function SyncHistoryDialog({ device, onOpenChange, onDone }: { device: Dev | null; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const { toast } = useHrm()
  const [mode, setMode] = useState<"CHECK" | "DATA_QUERY">("CHECK")
  const [fromDate, setFromDate] = useState("")
  const [toDate, setToDate] = useState("")
  const [busy, setBusy] = useState(false)
  const [info, setInfo] = useState<{ windowDays: number; activeUntil: string; note: string; requeuedOutOfWindow?: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (device) {
      // sensible default range: the last 90 days (the supported backfill
      // range is up to ~10 years — widen the picker as needed)
      const to = new Date()
      const from = new Date(Date.now() - 90 * 86_400_000)
      setMode("CHECK")
      setToDate(to.toISOString().slice(0, 10))
      setFromDate(from.toISOString().slice(0, 10))
      setInfo(null)
      setError(null)
      setBusy(false)
    }
  }, [device?.id])

  // computed without non-null assertions for the lint pass
  const activeUntilMs = device?.historySyncUntil ? new Date(device.historySyncUntil).getTime() : 0
<<<<<<< HEAD
  // T-11 — "is active right now" is a time comparison; Date.now() in the
  // render body is the impurity the purity rule forbids. Captured once per
  // mount (the dialog re-renders with fresh device data on every reload,
  // which re-mounts this component anyway).
  const [nowMs] = useState(() => Date.now())
  const active = !!device && activeUntilMs > nowMs
=======
  const active = !!device && activeUntilMs > Date.now()
>>>>>>> origin/main
  const activeUntilStr = activeUntilMs ? new Date(activeUntilMs).toLocaleString() : ""

  const start = async () => {
    if (!device) return
    if (mode === "DATA_QUERY" && !fromDate) { setError("Pick a from-date for the range query"); return }
    setBusy(true)
    setError(null)
    try {
      const res = await rpc<{ windowDays: number; activeUntil: string; note: string; requeuedOutOfWindow?: number }>("devices.syncHistory", {
        id: device.id, mode, fromDate: mode === "DATA_QUERY" ? fromDate : undefined, toDate: mode === "DATA_QUERY" ? toDate : undefined,
      })
      setInfo(res)
      toast(`Historical sync started — widened window ${res.windowDays} day(s)${res.requeuedOutOfWindow ? `, ${res.requeuedOutOfWindow} stored punch(es) requeued` : ""}`)
      onDone()
    } catch (e: any) {
      setError(e?.message || "Could not start the historical sync")
    } finally {
      setBusy(false)
    }
  }

  const stop = async () => {
    if (!device) return
    setBusy(true)
    try {
      await rpc("devices.syncHistory.stop", { id: device.id })
      toast("Historical sync window closed — back to the normal freshness window")
      onDone()
      onOpenChange(false)
    } catch (e: any) {
      toast(e?.message || "Could not stop the sync window", "err")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={!!device} onOpenChange={(v) => { if (!v) onOpenChange(v) }}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <History className="h-4 w-4 text-teal-600" /> Sync Old Attendance Data
          </DialogTitle>
          <p className="text-xs text-slate-500">
            {device?.name} · <span className="font-mono">{device?.deviceIdentifier || device?.deviceId}</span>
          </p>
        </DialogHeader>

        <div className="space-y-3.5">
          {/* active state */}
          {active && (
            <div className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-3 py-2.5 space-y-1.5">
              <p className="text-xs font-semibold text-amber-700 dark:text-amber-300 flex items-center gap-1.5">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
                </span>
                Historical sync window ACTIVE — until {activeUntilStr}
              </p>
              <p className="text-[11px] text-amber-700/80 dark:text-amber-300/70">
                Old punches from this device are being accepted (window: {device?.historySyncWindowDays || 365} day(s) back). The device re-uploads on its poll cycle; progress shows in the Sync Monitor.
              </p>
              <Button size="sm" variant="outline" className="h-7 text-[11px] border-amber-300 text-amber-700 hover:bg-amber-100 dark:border-amber-800" disabled={busy} onClick={stop}>
                <XCircle className="h-3 w-3 mr-1" /> Close window early
              </Button>
            </div>
          )}

          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 px-3 py-2.5 text-[11px] text-slate-600 dark:text-slate-300 space-y-1.5">
            <p className="font-semibold text-slate-700 dark:text-slate-200">How it works</p>
            <p>
              Ongoing pushes only deliver <b>fresh</b> punches — anything older than the freshness window
              (default 7 days) is quarantined server-side as an out-of-window raw event (kept, never discarded).
              This tool <b>temporarily widens the window for this device</b>, immediately requeues every quarantined
              punch in the selected range, and asks the terminal to re-upload old records from its local storage.
            </p>
            <p>
              Re-uploaded punches are <b>deduplicated automatically</b> (records already in the system are never
              double-counted) and processed into the daily attendance register by the normal pipeline. Supported
              backfill range: up to ~10 years.
            </p>
          </div>

          <div className="space-y-2">
            <Label className="text-xs font-medium">Pull mode</Label>
            <div className="grid gap-2">
              <label className={`flex items-start gap-2 rounded-lg border px-3 py-2 cursor-pointer ${mode === "CHECK" ? "border-teal-400 bg-teal-50/50 dark:bg-teal-950/30" : "border-slate-200 dark:border-slate-800"}`}>
                <input type="radio" name="syncMode" checked={mode === "CHECK"} onChange={() => setMode("CHECK")} className="mt-0.5 accent-teal-600" />
                <div>
                  <p className="text-xs font-medium text-slate-700 dark:text-slate-200">Re-upload all unsent records — CHECK <span className="text-[10px] font-normal text-teal-600">(recommended)</span></p>
                  <p className="text-[10px] text-slate-500">Universally supported. The device re-uploads every record it has not confirmed as delivered — best when it was offline or the server was down.</p>
                </div>
              </label>
              <label className={`flex items-start gap-2 rounded-lg border px-3 py-2 cursor-pointer ${mode === "DATA_QUERY" ? "border-teal-400 bg-teal-50/50 dark:bg-teal-950/30" : "border-slate-200 dark:border-slate-800"}`}>
                <input type="radio" name="syncMode" checked={mode === "DATA_QUERY"} onChange={() => setMode("DATA_QUERY")} className="mt-0.5 accent-teal-600" />
                <div>
                  <p className="text-xs font-medium text-slate-700 dark:text-slate-200">Range query — DATA QUERY ATTLOG <span className="text-[10px] font-normal text-amber-600">(newer firmwares)</span></p>
                  <p className="text-[10px] text-slate-500">Asks the device to return attendance records for an explicit date range from its storage.</p>
                </div>
              </label>
            </div>
          </div>

          {mode === "DATA_QUERY" && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">From <span className="text-rose-500">*</span></Label>
                <Input type="date" className="h-9" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">To (blank = today)</Label>
                <Input type="date" className="h-9" value={toDate} onChange={(e) => setToDate(e.target.value)} />
              </div>
            </div>
          )}

          {info && (
            <div className="rounded-lg border border-emerald-300 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 px-3 py-2.5 text-[11px] text-emerald-700 dark:text-emerald-300 space-y-1">
              <p className="font-semibold flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5" /> Historical sync started</p>
              <p>Widened ingest window: <b>{info.windowDays} day(s)</b> back · active until {new Date(info.activeUntil).toLocaleString()}.</p>
              {!!info.requeuedOutOfWindow && (
                <p className="font-semibold">{info.requeuedOutOfWindow} quarantined out-of-window punch(es) requeued from server storage — they process even if the device never re-uploads.</p>
              )}
              <p className="text-emerald-700/80 dark:text-emerald-300/70">{info.note}</p>
            </div>
          )}
          {error && <p className="rounded-md bg-rose-50 dark:bg-rose-950/50 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">{error}</p>}

          <div className="rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-[10px] text-slate-500 flex items-start gap-1.5">
            <CalendarRange className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>
              The device consumes the command on its next poll (LOGDELAY, usually within a minute) as long as it is
              powered on and online. The widened window stays open for 24 hours (large backfills can take longer
              than an hour on the device&apos;s poll cadence) and can be closed early anytime while it is active.
            </span>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Close</Button>
          <Button onClick={start} disabled={busy || !!active} className="bg-teal-600 hover:bg-teal-700 text-white">
            {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <History className="h-4 w-4 mr-1" />}
            {active ? "Sync already active" : "Start Historical Sync"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DeviceDetailDialog({ device, data, onOpenChange, onRefresh }: {
  device: Dev; data: any; onOpenChange: (v: boolean) => void; onRefresh: () => void
}) {
  const { can, toast: _toast } = useHrm()
  const d = data?.device || device
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            <Fingerprint className="h-4 w-4 text-teal-600" /> {d.name}
            <DeviceStatusBadge d={d} />
          </DialogTitle>
        </DialogHeader>
        {!data ? (
          <div className="flex items-center justify-center py-10 text-slate-400"><Loader2 className="h-5 w-5 animate-spin" /></div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <SectionCard title="Device Information">
                <KV cols={1} items={[
                  ["Model", `${d.manufacturer || "—"} ${d.model || ""}`],
                  ["Serial (SN)", <span key="sn" className="font-mono text-xs">{d.deviceIdentifier || "—"}</span>],
                  ["Branch", d.branchName || "All branches"],
                  ["Location", d.location || "—"],
                  ["Timezone", d.timezone || "Asia/Dhaka"],
                  ["Firmware", d.pushVersion ? `Push v${d.pushVersion}` : "—"],
                  ["Clock drift", d.clockDrift || "—"],
                  ["Auth", <span key="auth" className="text-[10px]">Serial-number registration (no key required)</span>],
                ]} />
              </SectionCard>
              <SectionCard title="Connection & Activity">
                <KV cols={1} items={[
                  ["Last seen", `${fmtDT(d.lastSeenAt)} (${ago(d.lastSeenAt)})`],
                  ["Last attendance", d.lastEventTime || "—"],
                  ["Today's events", String(d.todayEvents ?? "—")],
                  ["Total events", String(d.eventCount ?? 0)],
                  ["Last sync", fmtDT(d.lastSyncAt)],
                  ["ADMS endpoint", <span key="ep" className="font-mono text-[10px]">/iclock/cdata (ZKTeco Push SDK)</span>],
                  ["Unknown users", String(d.unknownUsers ?? 0)],
                  ["IP (last push)", d.ipAddress || "—"],
                ]} />
              </SectionCard>
            </div>

            {can("devices", "edit") && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" className="h-8 text-xs" onClick={onRefresh}>
                  <RefreshCw className="h-3.5 w-3.5 mr-1" /> Refresh
                </Button>
              </div>
            )}

            <SectionCard title={`Employee Mapping (${data.mappings?.length || 0})`}>
              {data.mappings?.length ? (
                <div className="max-h-56 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-slate-400 border-b">
                        <th className="py-1.5 font-medium">PIN</th><th className="font-medium">Employee</th>
                        <th className="font-medium">Status</th><th className="font-medium">Enrollment</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.mappings.map((m: any) => (
                        <tr key={m.id} className="border-b border-slate-100 dark:border-slate-800">
                          <td className="py-1.5 font-mono">{m.deviceUserId}</td>
                          <td className="font-medium">{m.employeeName} <span className="text-slate-400">{m.employeeCode}</span></td>
                          <td>{m.enrollmentStatus === "ACTIVE"
                            ? <Badge variant="outline" className="text-[10px] bg-emerald-50 text-emerald-700 border-emerald-200">Active</Badge>
                            : <Badge variant="outline" className="text-[10px]">{m.enrollmentStatus}</Badge>}</td>
                          <td className="text-slate-400">{m.employeeStatus ? m.employeeStatus.replace(/_/g, " ").toLowerCase() : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <p className="text-xs text-slate-400">No employees enrolled on this device yet.</p>}
            </SectionCard>

            <SectionCard title="Recent Events">
              {data.recentEvents?.length ? (
                <div className="max-h-56 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-slate-400 border-b">
                        <th className="py-1.5 font-medium">Time</th><th className="font-medium">PIN</th>
                        <th className="font-medium">Employee</th><th className="font-medium">Type</th><th className="font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.recentEvents.map((e: any) => (
                        <tr key={e.id} className="border-b border-slate-100 dark:border-slate-800">
                          <td className="py-1.5 font-mono tabular-nums">{e.eventTime}</td>
                          <td className="font-mono">{e.deviceUserId}</td>
                          <td>{e.employeeName || <span className="text-amber-600">unknown</span>}</td>
                          <td className="text-slate-500">{e.eventType}</td>
                          <td><ProcStatusBadge s={e.processingStatus} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <p className="text-xs text-slate-400">No events received yet.</p>}
            </SectionCard>

            <SectionCard title="Communication History (latest)">
              {data.commLogs?.length ? (
                <div className="max-h-44 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-slate-400 border-b">
                        <th className="py-1.5 font-medium">When</th><th className="font-medium">Type</th>
                        <th className="font-medium">HTTP</th><th className="font-medium">Events</th><th className="font-medium">Detail</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.commLogs.map((c: any) => (
                        <tr key={c.id} className="border-b border-slate-100 dark:border-slate-800">
                          <td className="py-1.5 tabular-nums text-slate-500">{fmtDT(c.createdAt)}</td>
                          <td>{c.requestType}</td>
                          <td className={c.ok ? "text-emerald-600" : "text-rose-600"}>{c.httpStatus}</td>
                          <td className="tabular-nums">{c.eventCount}{c.duplicateCount ? ` (+${c.duplicateCount} dup)` : ""}</td>
                          <td className="text-slate-400 max-w-48 truncate">{c.error || `${c.durationMs}ms`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <p className="text-xs text-slate-400">No communication logged yet.</p>}
            </SectionCard>

            {data.commands?.length ? (
              <SectionCard title="Commands">
                <div className="space-y-1">
                  {data.commands.map((c: any) => (
                    <div key={c.id} className="flex items-center justify-between text-xs">
                      <span className="font-mono">{c.command}</span>
                      <span className="flex items-center gap-2">
                        <Badge variant="outline" className="text-[10px]">{c.status}</Badge>
                        <span className="text-slate-400">{c.sentAt ? fmtDT(c.sentAt) : "queued"}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </SectionCard>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ============================================================
// Tab 2 — Device Events (raw event browser)
// ============================================================
export function AdmsEventsTab() {
  const { can, toast } = useHrm()
  const [filters, setFilters] = useState<{ dateFrom?: string; dateTo?: string; deviceId?: string; processingStatus?: string; unknownOnly?: boolean }>({})
  const { data, loading, error, reload } = useApi<any>("devices.events", {
    dateFrom: filters.dateFrom || "", dateTo: filters.dateTo || "",
    deviceId: filters.deviceId || "", processingStatus: filters.processingStatus || "",
    unknownOnly: !!filters.unknownOnly, size: 100,
  })
  const { data: devices } = useApi<Dev[]>("devices.list", {})
  const [sel, setSel] = useState<any>(null)
  const [selData, setSelData] = useState<any>(null)
  const [reprocessing, setReprocessing] = useState(false)
  const canProcess = can("devices", "process")

  const openDetail = async (row: any) => {
    setSel(row)
    setSelData(null)
    try {
      const r = await rpc<any>("devices.eventDetail", { id: row.id })
      setSelData(r)
    } catch (e: any) {
      toast(e.message, "err")
    }
  }

  const reprocess = async () => {
    setReprocessing(true)
    try {
      const r = await rpc<any>("devices.reprocess", {
        deviceId: filters.deviceId || undefined,
        dateFrom: filters.dateFrom || undefined,
        dateTo: filters.dateTo || undefined,
        status: filters.processingStatus || undefined,
      })
      toast(`Reprocessed ${r.matched} event(s) — ${r.processed} processed, ${r.unknown} unknown, ${r.failed} failed`)
      reload()
    } catch (e: any) {
      toast(e.message, "err")
    } finally {
      setReprocessing(false)
    }
  }

  const items = data?.items || []
  const columns: Column<any>[] = [
    { key: "eventTime", label: "Timestamp", sortValue: (r) => r.eventTime, render: (r) => <span className="text-xs font-mono tabular-nums text-slate-700 dark:text-slate-200">{r.eventTime}</span> },
    {
      key: "employeeName", label: "Employee", sortValue: (r) => r.employeeName || "zz",
      render: (r) => r.employeeName ? (
        <div><p className="text-sm font-medium text-slate-800 dark:text-slate-100">{r.employeeName}</p><p className="text-[11px] text-slate-500 dark:text-slate-400">{r.employeeCode}</p></div>
      ) : <span className="text-xs text-amber-600 font-medium">Unknown PIN {r.deviceUserId}</span>,
    },
    { key: "deviceName", label: "Device / Branch", sortValue: (r) => r.deviceName, render: (r) => <div><p className="text-xs text-slate-600 dark:text-slate-300">{r.deviceName}</p><p className="text-[11px] text-slate-500 dark:text-slate-400">{r.branchName || "—"}</p></div> },
    { key: "eventType", label: "Event", render: (r) => <Badge variant="outline" className="text-[10px]">{r.eventType}</Badge> },
    { key: "verifyLabel", label: "Verify", render: (r) => <span className="text-xs text-slate-500">{r.verifyLabel}</span> },
    { key: "processingStatus", label: "Processing", sortValue: (r) => r.processingStatus, render: (r) => <ProcStatusBadge s={r.processingStatus} /> },
    { key: "receivedAt", label: "Received", sortValue: (r) => String(r.receivedAt), render: (r) => <span className="text-xs text-slate-400">{fmtDT(r.receivedAt)}</span> },
  ]

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 items-end">
        <div className="space-y-1">
          <Label className="text-[11px] font-medium text-slate-500">From</Label>
          <Input type="date" className="h-8 text-xs" value={filters.dateFrom || ""} onChange={(e) => setFilters((f) => ({ ...f, dateFrom: e.target.value }))} />
        </div>
        <div className="space-y-1">
          <Label className="text-[11px] font-medium text-slate-500">To</Label>
          <Input type="date" className="h-8 text-xs" value={filters.dateTo || ""} onChange={(e) => setFilters((f) => ({ ...f, dateTo: e.target.value }))} />
        </div>
        <div className="space-y-1">
          <Label className="text-[11px] font-medium text-slate-500">Device</Label>
          <Select value={filters.deviceId || "ALL"} onValueChange={(v) => setFilters((f) => ({ ...f, deviceId: v === "ALL" ? "" : v }))}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All devices</SelectItem>
              {(devices || []).map((d: any) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-[11px] font-medium text-slate-500">Status</Label>
          <Select value={filters.processingStatus || "ALL"} onValueChange={(v) => setFilters((f) => ({ ...f, processingStatus: v === "ALL" ? "" : v }))}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All statuses</SelectItem>
              {[
                "PROCESSED", "RECEIVED", "PROCESSING", "UNKNOWN_EMPLOYEE", "FAILED", "SKIPPED_MANUAL", "OUT_OF_WINDOW",
                // M-7 — terminal dead-letter bucket, surfaced for manual reprocess
                "DEAD_LETTER",
              ].map((s) => (
                <SelectItem key={s} value={s}>{s.replace(/_/g, " ")}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" className="h-8 text-xs" variant={filters.unknownOnly ? "default" : "outline"}
            onClick={() => setFilters((f) => ({ ...f, unknownOnly: !f.unknownOnly }))}>
            <UserX className="h-3.5 w-3.5 mr-1" /> Unknown only
          </Button>
        </div>
      </div>
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-400">{data ? `${data.total} event(s)` : "…"} — click a row for the raw payload & processing history</p>
        {canProcess && (
          <Button size="sm" variant="outline" className="h-8 text-xs" disabled={reprocessing} onClick={reprocess}>
            {reprocessing ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <RotateCw className="h-3.5 w-3.5 mr-1" />}
            Reprocess Filtered
          </Button>
        )}
      </div>
      <DataTable columns={columns} rows={items} loading={loading} error={error} pageSize={15}
        onRowClick={openDetail} searchPlaceholder="Search employee / PIN / device…"
        csvName="device-events" emptyTitle="No device events" emptyHint="Punches pushed by ADMS devices will appear here." />

      {sel && (
        <Dialog open onOpenChange={(v) => { if (!v) { setSel(null); setSelData(null) } }}>
          <DialogContent className="sm:max-w-2xl max-h-[88vh] overflow-y-auto">
            <DialogHeader><DialogTitle className="text-base">Event {sel.eventTime}</DialogTitle></DialogHeader>
            {!selData ? (
              <div className="flex items-center justify-center py-10 text-slate-400"><Loader2 className="h-5 w-5 animate-spin" /></div>
            ) : (
              <div className="space-y-4">
                <SectionCard title="Raw Event (immutable)">
                  <KV cols={2} items={[
                    ["Raw line", <code key="l" className="text-[11px] font-mono bg-slate-100 dark:bg-slate-800 rounded px-1.5 py-0.5 block break-all">{selData.raw.rawLine}</code>],
                    ["Fingerprint", <code key="h" className="text-[10px] font-mono text-slate-400 break-all">{selData.raw.payloadHash.slice(0, 24)}…</code>],
                    ["Device serial", selData.raw.deviceSerial],
                    ["Device PIN", selData.raw.deviceUserId],
                    ["Received", fmtDT(selData.raw.receivedAt)],
                    ["Verify mode", selData.raw.verifyLabel],
                  ]} />
                </SectionCard>
                <SectionCard title="Normalized">
                  <KV cols={2} items={[
                    ["Employee", selData.normalized.employee || "— (unmapped)"],
                    ["Event type", selData.normalized.eventType],
                    ["Processing", selData.raw.processingStatus],
                    ["Error", selData.raw.processingError || "—"],
                    ["Retries", String(selData.raw.retryCount)],
                    ["Processed at", fmtDT(selData.raw.processedAt)],
                  ]} />
                </SectionCard>
                <SectionCard title="Related Daily Attendance">
                  {selData.attendance ? (
                    <KV cols={2} items={[
                      ["Date", selData.attendance.date],
                      ["Check in / out", `${selData.attendance.checkIn || "—"} → ${selData.attendance.checkOut || "—"}`],
                      ["Status", <StatusBadge key="s" status={selData.attendance.status} />],
                      ["Late / OT", `${selData.attendance.lateMinutes || 0}m / ${selData.attendance.overtimeMinutes || 0}m`],
                      ["Source", selData.attendance.source],
                      ["Device", selData.attendance.deviceInfo || "—"],
                    ]} />
                  ) : <p className="text-xs text-slate-400">No attendance row affected (unmapped or protected day).</p>}
                </SectionCard>
              </div>
            )}
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

// ============================================================
// Tab 3 — Unknown Device Users
// ============================================================
export function AdmsUnknownTab() {
  const { can, toast } = useHrm()
  const { data, loading, error, reload } = useApi<any[]>("devices.unknownUsers", {})
  // device directory is fetched by the Devices tab; the Sync tab needs employees only
  const { data: employees } = useEmployeeDirectory()
  const [mapTarget, setMapTarget] = useState<any>(null)
  const [autoMapping, setAutoMapping] = useState(false)
  const canEdit = can("devices", "edit")
  const suggestedCount = (data || []).filter((r: any) => r.suggestedEmployeeId).length

  const mapFields: FieldDef[] = useMemo(() => [
    {
      name: "employeeId", label: "Map to Employee", type: "select", required: true,
      // working statuses + the Employee-ID suggestion (which may be on notice,
      // suspended, …) so a matching employee is always selectable
      options: (employees || []).filter((e: any) => ["ACTIVE", "PROBATION", "ON_LEAVE", "NOTICE_PERIOD", "SUSPENDED"].includes(e.status) || e.id === mapTarget?.suggestedEmployeeId)
        .map((e: any) => ({ value: e.id, label: `${e.fullName} — ${e.code}` })),
      help: mapTarget?.suggestedEmployee
        ? `Suggested by Employee ID match: ${mapTarget.suggestedEmployee}. ${mapTarget?.events || 0} historical punch(es) will be reprocessed automatically.`
        : `No employee has Employee ID "${mapTarget?.deviceUserId || ""}" — choose one manually. All ${mapTarget?.events || 0} historical punch(es) of this PIN will be reprocessed automatically.`,
    },
    {
      name: "allowAdditional", label: "Also keep the employee's existing PIN on this device", type: "switch",
      help: "Turn on when the employee is enrolled on the terminal under more than one User ID (e.g. re-enrolled). Both PINs then count as this employee's punches.",
    },
  ], [employees, mapTarget])

  const runAutoMap = async () => {
    setAutoMapping(true)
    try {
      const r = await rpc<any>("devices.autoMap", {})
      toast(r.mapped
        ? `Auto-mapped ${r.mapped} device user(s) by Employee ID — their punches are being processed${r.unmatched ? ` · ${r.unmatched} need manual mapping` : ""}`
        : `No device user matched an Employee ID${r.unmatched ? ` — ${r.unmatched} need manual mapping` : ""}`)
      reload()
    } catch (e: any) {
      toast(e.message, "err")
    } finally {
      setAutoMapping(false)
    }
  }

  const columns: Column<any>[] = [
    {
      key: "deviceUserId", label: "Unknown PIN", sortValue: (r) => r.deviceUserId,
      render: (r) => (
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-amber-50 dark:bg-amber-950 flex items-center justify-center shrink-0">
            <UserX className="h-4 w-4 text-amber-600" />
          </div>
          <div>
            <p className="text-sm font-semibold font-mono text-slate-800 dark:text-slate-100">PIN {r.deviceUserId}</p>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">{r.deviceUserName ? `${r.deviceUserName} · ` : ""}{r.deviceName}</p>
          </div>
        </div>
      ),
    },
    { key: "deviceSerial", label: "Device SN", render: (r) => <span className="text-xs font-mono text-slate-500">{r.deviceSerial}</span> },
    {
      key: "suggested", label: "Employee ID Match", sortValue: (r) => r.suggestedEmployee || "",
      render: (r) => r.suggestedEmployee
        ? <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">{r.suggestedEmployee}</span>
        : <span className="text-[11px] text-slate-400">No match — map manually</span>,
    },
    { key: "firstSeen", label: "First Seen", sortValue: (r) => r.firstSeen || "", render: (r) => <span className="text-xs tabular-nums text-slate-500">{r.firstSeen || "— (device roster)"}</span> },
    { key: "lastSeen", label: "Last Seen", sortValue: (r) => r.lastSeen || "", render: (r) => <span className="text-xs tabular-nums text-slate-500">{r.lastSeen || "—"}</span> },
    { key: "events", label: "Events", align: "right", sortValue: (r) => r.events, render: (r) => <span className="text-xs font-semibold tabular-nums text-amber-600">{r.events}</span> },
    ...(canEdit ? [{
      key: "actions", label: "", align: "right" as const,
      render: (r: any) => (
        <Button size="sm" className="h-7 text-[10px] " onClick={() => setMapTarget(r)}>
          <MapPin className="h-3 w-3 mr-0.5" /> Map to Employee
        </Button>
      ),
    }] : []),
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-xs text-slate-500 max-w-2xl">
          Device users whose User ID matches an HRM Employee ID are mapped <b>automatically</b> as soon as they punch or
          the device reports its user list. Anyone listed here had no unambiguous match — map them manually; every
          historical punch is reprocessed automatically. Nothing is discarded and no fake employees are created.
        </p>
        {canEdit && (
          <Button size="sm" variant="outline" className="h-8 text-xs" disabled={autoMapping || !suggestedCount} onClick={runAutoMap}
            title={suggestedCount ? `Map the ${suggestedCount} user(s) with an Employee ID match` : "No listed user matches an Employee ID"}>
            <MapPin className="h-3.5 w-3.5 mr-1" /> {autoMapping ? "Mapping…" : `Auto-map by Employee ID${suggestedCount ? ` (${suggestedCount})` : ""}`}
          </Button>
        )}
      </div>
      <DataTable columns={columns} rows={data || undefined} loading={loading} error={error} pageSize={10}
        searchPlaceholder="Search PIN / device…" emptyTitle="No unknown device users"
        emptyHint="Every device PIN is mapped to an employee. New unknown PINs appear here." />

      <FormDialog open={!!mapTarget} onOpenChange={(v) => { if (!v) { setMapTarget(null); reload() } }}
        title={`Map PIN ${mapTarget?.deviceUserId || ""} → Employee`}
        description={`${mapTarget?.deviceName || ""} — ${mapTarget?.events || 0} event(s) will be reprocessed with the new mapping.`}
        fields={mapFields} submitLabel="Map & Reprocess"
        initial={mapTarget?.suggestedEmployeeId ? { employeeId: mapTarget.suggestedEmployeeId } : undefined}
        onSubmit={async (v) => {
          const r = await rpc<any>("devices.mapUser", { deviceId: mapTarget.deviceId, deviceUserId: mapTarget.deviceUserId, employeeId: v.employeeId, allowAdditional: !!v.allowAdditional })
          toast(`Mapped — ${r.reprocessed} event(s) reprocessed, ${r.daysRebuilt} day(s) rebuilt`)
        }} />
    </div>
  )
}

// ============================================================
// Tab 4 — Sync Monitor (queue health & retry)
// ============================================================
export function AdmsSyncTab() {
  const { can, toast } = useHrm()
  const { data, loading: _loading, error, reload } = useApi<any>("devices.syncStats", {})
  const { data: devices } = useApi<Dev[]>("devices.list", {})
  const [sweeping, setSweeping] = useState(false)
  const canProcess = can("devices", "process")

  useEffect(() => {
    // L-4 — poll only while the tab is VISIBLE: a backgrounded Sync Monitor
    // tab stops hammering devices.syncStats every 10s (visibilitychange
    // pauses; returning to the tab refreshes immediately)
    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return
      reload()
    }
    const t = setInterval(tick, 10000)
    const onVisible = () => {
      if (document.visibilityState === "visible") tick()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      clearInterval(t)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [reload])

  const sweep = async () => {
    setSweeping(true)
    try {
      const r = await rpc<any>("devices.sweep", {})
      toast(`Sweep complete — ${r.processed} processed, ${r.failed} failed`)
      reload()
    } catch (e: any) {
      toast(e.message, "err")
    } finally {
      setSweeping(false)
    }
  }

  const retryFailed = async () => {
    setSweeping(true)
    try {
      const r = await rpc<any>("devices.reprocess", { status: "FAILED" })
      toast(`Reprocessed ${r.matched} failed event(s) — ${r.processed} now processed`)
      reload()
    } catch (e: any) {
      toast(e.message, "err")
    } finally {
      setSweeping(false)
    }
  }

  const q = data?.queue
  const ck = data?.commKey
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-500 max-w-2xl flex items-center gap-1.5">
          <Activity className="h-3.5 w-3.5 text-teal-600" />
          Live queue health — raw events are stored durably before acknowledgement, then processed with automatic retry & exponential backoff.
        </p>
        {canProcess && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="h-8 text-xs" disabled={sweeping} onClick={sweep}>
              {sweeping ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1" />} Run Sweep Now
            </Button>
            {!!q?.failed && (
              <Button size="sm" variant="outline" className="h-8 text-xs text-rose-600" disabled={sweeping} onClick={retryFailed}>
                <RotateCw className="h-3.5 w-3.5 mr-1" /> Retry {q.failed} Failed
              </Button>
            )}
          </div>
        )}
      </div>

      {/* C-03 — keyless-device notice: governed by the admin setting
          "Allow Keyless Devices" (Settings → Devices). The former 7-day
          grace window was removed — the toggle is the single control. */}
      {ck?.keyless > 0 && (
        <div className={`rounded-lg border px-4 py-3 text-xs flex items-start gap-2 ${
          ck.allowKeyless
            ? "border-amber-300 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300"
            : "border-rose-300 bg-rose-50 dark:bg-rose-950/40 text-rose-800 dark:text-rose-300"
        }`}>
          <KeyRound className="h-4 w-4 shrink-0 mt-0.5" />
          <span>
            <b>{ck.keyless} device{ck.keyless === 1 ? "" : "s"} registered without a comm key</b> —{" "}
            {ck.allowKeyless
              ? <>keyless devices are currently <b>allowed</b> (Settings → Devices → Allow Keyless Devices is ON) and communicate normally. Enrolling a comm key is still recommended before the setting is disabled.</>
              : <>keyless devices are <b>rejected with 401 Unauthorized</b> (Settings → Devices → Allow Keyless Devices is OFF). Enable the setting or enroll a comm key on the Devices tab (key icon) to restore their pushes.</>}
          </span>
        </div>
      )}

      {error ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 text-rose-700 px-4 py-3 text-sm">{error}</div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Events Today" value={String(data?.todayEvents ?? "—")} tone="sky" icon={Clock} sub={`Total stored: ${q?.total ?? 0}`} />
          <StatCard label="Processed" value={String(q?.processed ?? 0)} tone="emerald" icon={Radio} sub={`${q?.skippedManual ?? 0} skipped (manual days)`} />
          <StatCard label="Pending" value={String(q?.received ?? 0)} tone="sky" icon={Loader2} sub="queued for processing" />
          <StatCard label="Failed / Unknown" value={`${q?.failed ?? 0} / ${q?.unknown ?? 0}`} tone={(q?.failed ?? 0) > 0 ? "rose" : "amber"} icon={AlertTriangle}
            sub={`${data?.unknownUsers ?? 0} unknown PIN${(data?.unknownUsers ?? 0) === 1 ? "" : "s"} to map`} />
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <SectionCard title="Device Status">
          {devices?.length ? (
            <div className="space-y-2">
              {devices.map((d: any) => (
                <div key={d.id} className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-2 min-w-0">
                    <span className={`h-2 w-2 rounded-full shrink-0 ${STATUS_DOT[d.derivedStatus] || "bg-slate-400"}`} />
                    <span className="font-medium truncate text-slate-700 dark:text-slate-200">{d.name}</span>
                    <span className="text-slate-400 font-mono text-[10px]">{d.deviceIdentifier}</span>
                  </span>
                  <span className="text-slate-400 shrink-0 ml-2">
                    {d.todayEvents ?? 0} today · {ago(d.lastSeenAt)}
                  </span>
                </div>
              ))}
            </div>
          ) : <p className="text-xs text-slate-400">No devices registered.</p>}
        </SectionCard>
        <SectionCard title="Gateway Health">
          <KV cols={1} items={[
            ["Last event received", data ? `${fmtDT(data.lastEventReceivedAt)}` : "—"],
            ["Last event time (device clock)", data?.lastEventTime || "—"],
            ["Enabled devices", `${data?.devices?.enabled ?? 0} of ${data?.devices?.total ?? 0}`],
            ["Retry policy", "exponential backoff (15s ×2ⁿ, max 15m)"],
            ["Dead-letter", `after ${10} failed attempts → manual retry`],
            ["Raw retention", "forever — raw events are immutable"],
            ["Automatic pull", data?.autoSync?.enabled
              ? `ON — server asks every connected device to upload every ${data.autoSync.intervalSec}s${data.autoSync.lastAt ? ` · last ask ${fmtDT(data.autoSync.lastAt)}` : ""}`
              : "OFF — set ADMS_AUTO_CHECK_SECONDS to enable"],
            ["Auto-sync queued", `${data?.autoSync?.queued ?? 0} CHECK command(s) awaiting device poll`],
          ]} />
        </SectionCard>
      </div>
    </div>
  )
}
