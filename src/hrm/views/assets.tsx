"use client"
// ============ Wave 2 WP-K — Asset Management view ============
// Company asset registry + full lifecycle UI: stat cards, filtered paginated
// table, assign/return handover dialogs (condition + note + due date), a
// detail dialog with the append-only AssetEvent timeline, warranty badges
// (≤30d lead — the same window the daily warranty-reminder job uses), and
// repair/retire/lose/note/delete actions.
import { useMemo, useState } from "react"
import {
  Boxes, Plus, RefreshCcw, PackageCheck, PackageOpen, Wrench, AlertTriangle,
  PackageX, ShieldCheck, History, StickyNote, Undo2, PackageSearch, Landmark, CircleDot,
  MoreHorizontal, Eye, ArrowLeftRight,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useHrm } from "../store"
import { rpc, useApi, useLookup, useEmployeeDirectory } from "../api"
import {
  PageHeader, StatCard, SectionCard, fmtMoney, fmtDate, fmtDateTime,
  titleCase, EmptyState, FieldError,
} from "../shared/ui-kit"
import { DataTable, type Column } from "../shared/data-table"
import { FormDialog, ConfirmDialog, type FieldDef } from "../shared/form-dialog"

const toast = (text: string, kind?: "ok" | "err") => useHrm.getState().toast(text, kind)

const CATEGORIES = ["LAPTOP", "DESKTOP", "MOBILE", "SIM", "ID_CARD", "ACCESS_CARD", "MONITOR", "VEHICLE", "FURNITURE", "OTHER"] as const
const CONDITIONS = ["NEW", "GOOD", "FAIR", "DAMAGED"] as const
const STATUSES = ["IN_STOCK", "ASSIGNED", "RETURNED", "REPAIR", "RETIRED", "LOST"] as const
const ASSIGNABLE = ["IN_STOCK", "RETURNED"]

/** Asset-status colors (module-specific, semantically distinct). */
const STATUS_CLS: Record<string, string> = {
  IN_STOCK: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  ASSIGNED: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  RETURNED: "bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300",
  REPAIR: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  RETIRED: "bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
  LOST: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
}
function AssetStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="secondary" className={`font-medium whitespace-nowrap gap-1.5 text-[10px] ${STATUS_CLS[status] || ""}`}>
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current opacity-80 shrink-0" />
      {titleCase(status)}
    </Badge>
  )
}

const CONDITION_CLS: Record<string, string> = {
  NEW: "text-emerald-700 dark:text-emerald-400",
  GOOD: "text-teal-700 dark:text-teal-400",
  FAIR: "text-amber-700 dark:text-amber-400",
  DAMAGED: "text-rose-700 dark:text-rose-400",
}

/** Warranty state: ≤30d lead (matches the daily reminder job's window). */
function warrantyState(w?: string | null): { label: string; cls: string } | null {
  if (!w) return null
  const today = new Date().toLocaleDateString("en-CA") // YYYY-MM-DD, local
  const days = Math.round((new Date(w + "T00:00:00").getTime() - new Date(today + "T00:00:00").getTime()) / 86400000)
  if (days < 0) return { label: `expired ${fmtDate(w)}`, cls: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300" }
  if (days <= 30) return { label: `${days}d left`, cls: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300" }
  return null
}

type AssignmentInfo = {
  id: string; employeeId: string; employeeName: string; employeeCode: string | null
  assignedAt: string; dueAt: string | null; conditionOut: string | null; note: string | null
}
type AssetRow = {
  id: string; code: string; name: string; category: string; brandModel: string | null
  serialImei: string | null; purchaseDate: string | null; purchaseCost: number | null
  warrantyExpiry: string | null; condition: string; status: string
  branchId: string | null; branchName: string | null; locationNote: string | null
  sourceItemId: string | null; notes: string | null; createdAt: string
  currentAssignment: AssignmentInfo | null
}

export default function AssetsView() {
  const { can } = useHrm()
  const { data: stats, reload: reloadStats } = useApi<{
    total: number; byStatus: Record<string, number>; byCategory: Record<string, number>
    outstandingAssignments: number; warrantyExpiringSoon: number; warrantyExpired: number
  }>("assets.stats", {})
  const { data: branches } = useLookup<{ id: string; name: string }[]>("branches.list", {})

  // ---- filters (server-side — the list is paginated) ----
  const [category, setCategory] = useState("")
  const [status, setStatus] = useState("")
  const [branchId, setBranchId] = useState("")
  const [warrantyOnly, setWarrantyOnly] = useState(false)
  const [q, setQ] = useState("")
  const warrantyBefore = useMemo(() => {
    if (!warrantyOnly) return undefined
    const d = new Date()
    d.setDate(d.getDate() + 30)
    return d.toLocaleDateString("en-CA")
  }, [warrantyOnly])

  const payload = useMemo(() => ({
    ...(category ? { category } : {}),
    ...(status ? { status } : {}),
    ...(branchId ? { branchId } : {}),
    ...(warrantyBefore ? { warrantyExpiringBefore: warrantyBefore, sortBy: "warranty" } : {}),
    ...(q ? { q } : {}),
  }), [category, status, branchId, warrantyBefore, q])
  const { data, loading, error, reload } = useApi<{ assets: AssetRow[]; total: number }>("assets.list", payload)

  // ---- dialogs ----
  const [createOpen, setCreateOpen] = useState(false)
  const [nextCode, setNextCode] = useState("")
  const [assignAsset, setAssignAsset] = useState<AssetRow | null>(null)
  const [returnRow, setReturnRow] = useState<AssetRow | null>(null)
  const [transferAsset, setTransferAsset] = useState<AssetRow | null>(null)
  const [lostAsset, setLostAsset] = useState<AssetRow | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [codeLoading, setCodeLoading] = useState(false)

  // Fetch the next locked code BEFORE opening the dialog so the locked field
  // shows the real code from the first paint (the server still allocates the
  // final code at create time — the preview never burns a sequence number).
  const openCreate = async () => {
    setCodeLoading(true)
    setNextCode("")
    try {
      const res = await rpc<{ code: string }>("assets.nextCode", {})
      setNextCode(res.code)
    } catch { /* the server generates one anyway on submit */ } finally {
      setCodeLoading(false)
    }
    setCreateOpen(true)
  }
  const refreshAll = () => { reload(); reloadStats() }

  const byS = (k: string) => stats?.byStatus?.[k] || 0

  const columns: Column<AssetRow>[] = [
    {
      key: "name", label: "Asset", sortValue: (a) => a.name, searchValue: (a) => `${a.name} ${a.code} ${a.serialImei || ""} ${a.brandModel || ""}`,
      render: (a) => (
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">
            {a.name} <span className="font-mono text-[11px] text-slate-400 font-normal">{a.code}</span>
          </p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
            {titleCase(a.category)}{a.brandModel ? ` · ${a.brandModel}` : ""}{a.serialImei ? ` · S/N ${a.serialImei}` : ""}
          </p>
        </div>
      ),
    },
    {
      key: "assignedTo", label: "Assigned To", sortValue: (a) => a.currentAssignment?.employeeName || "",
      render: (a) => a.currentAssignment ? (
        <div className="min-w-0">
          <p className="text-xs font-medium text-slate-800 dark:text-slate-200 truncate">{a.currentAssignment.employeeName}</p>
          <p className="text-[10px] text-slate-500 dark:text-slate-400">
            {a.currentAssignment.employeeCode || "—"} · since {fmtDate(a.currentAssignment.assignedAt)}
            {a.currentAssignment.dueAt ? ` · due ${fmtDate(a.currentAssignment.dueAt)}` : ""}
          </p>
        </div>
      ) : <span className="text-xs text-slate-400">—</span>,
    },
    {
      key: "condition", label: "Condition", sortValue: (a) => a.condition,
      render: (a) => <span className={`text-xs font-medium ${CONDITION_CLS[a.condition] || ""}`}>{titleCase(a.condition)}</span>,
    },
    { key: "status", label: "Status", sortValue: (a) => a.status, render: (a) => <AssetStatusBadge status={a.status} /> },
    {
      key: "warrantyExpiry", label: "Warranty", sortValue: (a) => a.warrantyExpiry || "9999",
      render: (a) => {
        const w = warrantyState(a.warrantyExpiry)
        return a.warrantyExpiry ? (
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] text-slate-600 dark:text-slate-300 tabular-nums">{fmtDate(a.warrantyExpiry)}</span>
            {w && <Badge className={`text-[9px] w-fit ${w.cls}`}>{w.label}</Badge>}
          </div>
        ) : <span className="text-xs text-slate-400">—</span>
      },
    },
    {
      key: "branchName", label: "Branch", sortValue: (a) => a.branchName || "",
      render: (a) => <span className="text-xs text-slate-600 dark:text-slate-300">{a.branchName || "—"}</span>,
    },
    {
      key: "actions", label: "", align: "right",
      render: (a) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontal className="h-4 w-4" />
              <span className="sr-only">Open menu</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setDetailId(a.id); }}>
              <Eye className="h-3.5 w-3.5 mr-2 text-slate-500" /> View detail
            </DropdownMenuItem>
            {can("assets", "assign") && (
              <DropdownMenuItem
                disabled={!a.currentAssignment && a.status !== "ASSIGNED"}
                onClick={(e) => { e.stopPropagation(); setReturnRow(a); }}
              >
                <Undo2 className="h-3.5 w-3.5 mr-2 text-teal-600" /> Take Return
              </DropdownMenuItem>
            )}
            {can("assets", "assign") && (
              <DropdownMenuItem
                disabled={["REPAIR", "RETIRED", "LOST"].includes(a.status)}
                onClick={(e) => { e.stopPropagation(); setTransferAsset(a); }}
              >
                <ArrowLeftRight className="h-3.5 w-3.5 mr-2 text-sky-600" /> Transfer to Another
              </DropdownMenuItem>
            )}
            {can("assets", "edit") && (
              <DropdownMenuItem
                disabled={["RETIRED", "LOST"].includes(a.status)}
                onClick={(e) => { e.stopPropagation(); setLostAsset(a); }}
                className="text-rose-600 focus:text-rose-600"
              >
                <AlertTriangle className="h-3.5 w-3.5 mr-2" /> Mark as Lost
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <PageHeader
        title="Asset Management"
        subtitle="Company assets — registration, employee handover, warranty tracking and the complete lifecycle ledger"
        actions={
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="outline" className="h-8 text-xs bg-white dark:bg-slate-900" onClick={refreshAll}>
              <RefreshCcw className="h-3.5 w-3.5 mr-1" /> Refresh
            </Button>
            {can("assets", "create") && (
              <Button size="sm" className="h-8 text-xs" onClick={openCreate} disabled={codeLoading}>
                <Plus className="h-3.5 w-3.5 mr-1" /> {codeLoading ? "Allocating code…" : "Register asset"}
              </Button>
            )}
          </div>
        }
      />

      {/* ---- stat cards ---- */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        <StatCard label="Total assets" value={stats?.total ?? "—"} icon={Boxes} tone="slate" onClick={() => { setStatus(""); setCategory(""); setBranchId(""); setWarrantyOnly(false) }} />
        <StatCard label="Assigned now" value={byS("ASSIGNED")} sub={`${stats?.outstandingAssignments ?? 0} outstanding handovers`} icon={PackageCheck} tone="violet" onClick={() => setStatus("ASSIGNED")} />
        <StatCard label="In stock" value={byS("IN_STOCK")} sub="available to assign" icon={PackageOpen} tone="emerald" onClick={() => setStatus("IN_STOCK")} />
        <StatCard label="In repair" value={byS("REPAIR")} sub={`${byS("LOST")} lost · ${byS("RETIRED")} retired`} icon={Wrench} tone="amber" onClick={() => setStatus("REPAIR")} />
        <StatCard label="Warranty ≤30d" value={stats?.warrantyExpiringSoon ?? "—"} sub={`${stats?.warrantyExpired ?? 0} already expired`} icon={AlertTriangle} tone="rose" onClick={() => setWarrantyOnly((v) => !v)} />
      </div>

      {/* ---- registry ---- */}
      <SectionCard title={`Asset registry${data?.total != null ? ` — ${data.total} record${data.total !== 1 ? "s" : ""}` : ""}`}>
        <div className="flex flex-wrap items-end gap-2 mb-3">
          <div className="space-y-1 min-w-[130px]">
            <Label className="text-[11px] text-slate-500">Category</Label>
            <Select value={category || "all"} onValueChange={(v) => setCategory(v === "all" ? "" : v)}>
              <SelectTrigger className="h-8 text-xs" aria-label="Filter by category"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {CATEGORIES.map((c) => <SelectItem key={c} value={c}>{titleCase(c)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1 min-w-[120px]">
            <Label className="text-[11px] text-slate-500">Status</Label>
            <Select value={status || "all"} onValueChange={(v) => setStatus(v === "all" ? "" : v)}>
              <SelectTrigger className="h-8 text-xs" aria-label="Filter by status"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {STATUSES.map((s) => <SelectItem key={s} value={s}>{titleCase(s)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1 min-w-[130px]">
            <Label className="text-[11px] text-slate-500">Branch</Label>
            <Select value={branchId || "all"} onValueChange={(v) => setBranchId(v === "all" ? "" : v)}>
              <SelectTrigger className="h-8 text-xs" aria-label="Filter by branch"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All branches</SelectItem>
                {(branches || []).map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <Button
            size="sm" variant={warrantyOnly ? "default" : "outline"} className="h-8 text-xs"
            aria-pressed={warrantyOnly}
            onClick={() => setWarrantyOnly((v) => !v)}>
            <AlertTriangle className="h-3.5 w-3.5 mr-1" /> Warranty ≤30d
          </Button>
          <div className="flex-1" />
          <p className="text-[11px] text-slate-400 hidden sm:block">Showing {data?.assets?.length ?? 0} of {data?.total ?? 0} — click a row for the full history</p>
        </div>
        <DataTable
          columns={columns} rows={data?.assets} loading={loading} error={error} pageSize={15}
          searchable onSearch={setQ} searchPlaceholder="Search code, name, serial…"
          csvName="assets" emptyTitle="No assets registered yet"
          emptyHint="Register laptops, SIMs, ID cards and other company property — then assign them to employees with a full handover trail."
          onRowClick={(a) => setDetailId(a.id)}
        />
      </SectionCard>

      {/* ---- dialogs ---- */}
      {createOpen && (
        <CreateAssetDialog
          nextCode={nextCode}
          branches={branches || []}
          onClose={(saved) => { setCreateOpen(false); if (saved) refreshAll() }}
        />
      )}
      {assignAsset && (
        <AssignDialog
          asset={assignAsset}
          onClose={(saved) => { setAssignAsset(null); if (saved) refreshAll() }}
        />
      )}
      {returnRow && (
        <ReturnDialog
          asset={returnRow}
          onClose={(saved) => { setReturnRow(null); if (saved) refreshAll() }}
        />
      )}
      {transferAsset && (
        <TransferAssetDialog
          asset={transferAsset}
          onClose={(saved) => { setTransferAsset(null); if (saved) refreshAll() }}
        />
      )}
      {lostAsset && (
        <MarkLostDialog
          asset={lostAsset}
          onClose={(saved) => { setLostAsset(null); if (saved) refreshAll() }}
        />
      )}
      {detailId && (
        <AssetDetailDialog
          assetId={detailId}
          onMutate={refreshAll}
          onClose={() => setDetailId(null)}
        />
      )}
    </div>
  )
}

// ================= CREATE (code locked) =================

function CreateAssetDialog({ nextCode, branches, onClose }: {
  nextCode: string; branches: { id: string; name: string }[]; onClose: (saved: boolean) => void
}) {
  const fields: FieldDef[] = [
    { name: "code", label: "Asset code", type: "text", disabled: true, defaultValue: nextCode || "AST-…", help: "Auto-generated and locked — issued when you save." },
    { name: "name", label: "Asset name", required: true, placeholder: "e.g. Dell Latitude 5440", span: 2 },
    { name: "category", label: "Category", type: "select", required: true, defaultValue: "LAPTOP", options: CATEGORIES.map((c) => ({ value: c, label: titleCase(c) })) },
    { name: "condition", label: "Condition", type: "select", defaultValue: "NEW", options: CONDITIONS.map((c) => ({ value: c, label: titleCase(c) })) },
    { name: "brandModel", label: "Brand / model", placeholder: "e.g. Dell Latitude 5440" },
    { name: "serialImei", label: "Serial / IMEI", placeholder: "e.g. 5CG1234ABC" },
    { name: "purchaseDate", label: "Purchase date", type: "date" },
    { name: "purchaseCost", label: "Purchase cost (৳)", type: "number", min: 0 },
    { name: "warrantyExpiry", label: "Warranty expiry", type: "date", help: "Warranty reminders fire 30 days before this date." },
    { name: "branchId", label: "Branch", type: "select", options: branches.map((b) => ({ value: b.id, label: b.name })), placeholder: "— None —" },
    { name: "locationNote", label: "Location note", placeholder: "e.g. 3rd floor store, rack B2", span: 2 },
    { name: "notes", label: "Notes", type: "textarea", rows: 2, span: 2 },
  ]
  return (
    <FormDialog
      open onOpenChange={(v) => !v && onClose(false)}
      title="Register company asset"
      description="Assets get a locked sequential code (AST-0001) and enter the registry as IN_STOCK."
      fields={fields} wide submitLabel="Register asset"
      onSubmit={async (v) => {
        await rpc("assets.create", {
          name: v.name, category: v.category, condition: v.condition || null,
          brandModel: v.brandModel || null, serialImei: v.serialImei || null,
          purchaseDate: v.purchaseDate || null,
          purchaseCost: v.purchaseCost === "" ? null : Number(v.purchaseCost || 0),
          warrantyExpiry: v.warrantyExpiry || null,
          branchId: v.branchId || null,
          locationNote: v.locationNote || null, notes: v.notes || null,
        })
      }}
    />
  )
}

// ================= ASSIGN =================

function AssignDialog({ asset, onClose }: { asset: AssetRow; onClose: (saved: boolean) => void }) {
  const { data: employees } = useEmployeeDirectory()
  const empOpts = useMemo(
    () => (employees || [])
      .filter((e) => ["ACTIVE", "PROBATION"].includes(e.status))
      .map((e) => ({ value: e.id, label: `${e.fullName}${e.code ? ` (${e.code})` : ""}` })),
    [employees],
  )
  const fields: FieldDef[] = [
    { name: "employeeId", label: "Assign to", type: "select", required: true, options: empOpts, span: 2, help: "Only ACTIVE or PROBATION employees are assignable." },
    { name: "conditionOut", label: "Condition at handover", type: "select", defaultValue: asset.condition, options: CONDITIONS.map((c) => ({ value: c, label: titleCase(c) })) },
    { name: "dueAt", label: "Return due date", type: "date" },
    { name: "note", label: "Handover note", type: "textarea", rows: 2, span: 2, placeholder: "e.g. charger + laptop bag included" },
  ]
  return (
    <FormDialog
      open onOpenChange={(v) => !v && onClose(false)}
      title={`Assign ${asset.code}`}
      description={`${asset.name} · ${titleCase(asset.status)} → ASSIGNED with a full handover record.`}
      fields={fields} submitLabel="Assign asset"
      onSubmit={async (v) => {
        await rpc("assets.assign", {
          assetId: asset.id, employeeId: v.employeeId,
          conditionOut: v.conditionOut || null, dueAt: v.dueAt || null, note: v.note || null,
        })
      }}
    />
  )
}

// ================= RETURN =================

function ReturnDialog({ asset, onClose }: { asset: AssetRow; onClose: (saved: boolean) => void }) {
  const ca = asset.currentAssignment
  const [conditionIn, setConditionIn] = useState(ca?.conditionOut || asset.condition || "GOOD")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const handleReturn = async () => {
    setErr(null)
    setBusy(true)
    try {
      await rpc("assets.return", {
        assignmentId: ca?.id || null,
        assetId: asset.id,
        conditionIn: conditionIn || null,
        note: note.trim() || null,
      })
      toast(`Asset ${asset.code} returned to shelf`)
      onClose(true)
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={() => !busy && onClose(false)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            <Undo2 className="h-5 w-5 text-teal-600" />
            <span>Take Return of {asset.code}</span>
          </DialogTitle>
          <DialogDescription className="text-xs">
            Return {asset.name} back to company stock (RETURNED status).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3.5 py-1">
          <div className="p-2.5 rounded-lg border bg-slate-50 dark:bg-slate-900/50 space-y-1 text-xs">
            <span className="text-slate-500 font-medium">Returning From:</span>
            <div className="flex items-center gap-2 font-medium text-slate-800 dark:text-slate-200">
              <span className="font-semibold">{ca?.employeeName || "Assigned Employee"}</span>
              {ca?.employeeCode && <span className="font-mono text-slate-400">({ca.employeeCode})</span>}
              {ca?.assignedAt && <span className="text-slate-400">· handed over {fmtDate(ca.assignedAt)}</span>}
            </div>
            {ca?.conditionOut && (
              <span className="text-[11px] text-slate-500">Condition at handover: <b>{titleCase(ca.conditionOut)}</b></span>
            )}
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Condition at Return</Label>
            <Select value={conditionIn} onValueChange={setConditionIn}>
              <SelectTrigger className="h-9 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONDITIONS.map((c) => (
                  <SelectItem key={c} value={c}>{titleCase(c)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Return Note (Optional)</Label>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Minor scratches on surface, charger returned"
              rows={2}
              className="text-xs resize-none"
            />
          </div>

          {err && <p className="text-xs text-rose-600 bg-rose-50 dark:bg-rose-950 p-2.5 rounded-md">{err}</p>}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => onClose(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-8 text-xs bg-teal-600 hover:bg-teal-700 text-white"
            onClick={handleReturn}
            disabled={busy}
          >
            {busy ? "Recording Return…" : "Confirm Return"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ================= TRANSFER =================

function TransferAssetDialog({ asset, onClose }: { asset: AssetRow; onClose: (saved: boolean) => void }) {
  const { data: employees } = useEmployeeDirectory()
  const ca = asset.currentAssignment
  const [toEmployeeId, setToEmployeeId] = useState("")
  const [conditionIn, setConditionIn] = useState(ca?.conditionOut || asset.condition || "GOOD")
  const [conditionOut, setConditionOut] = useState(asset.condition || "GOOD")
  const [dueAt, setDueAt] = useState("")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const activeEmployees = useMemo(
    () => (employees || [])
      .filter((e) => ["ACTIVE", "PROBATION"].includes(e.status) && e.id !== ca?.employeeId)
      .map((e) => ({ id: e.id, label: `${e.fullName}${e.code ? ` (${e.code})` : ""}`, department: e.departmentName })),
    [employees, ca?.employeeId],
  )

  const handleTransfer = async () => {
    setErr(null)
    if (!toEmployeeId) {
      setErr("Please select the employee to transfer this asset to")
      return
    }
    setBusy(true)
    try {
      await rpc("assets.transfer", {
        assetId: asset.id,
        toEmployeeId,
        conditionIn: ca ? conditionIn : undefined,
        conditionOut,
        dueAt: dueAt || undefined,
        note: note.trim() || undefined,
      })
      const targetEmp = activeEmployees.find((e) => e.id === toEmployeeId)
      toast(`Asset ${asset.code} transferred to ${targetEmp?.label || "employee"}`)
      onClose(true)
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={() => !busy && onClose(false)}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            <ArrowLeftRight className="h-5 w-5 text-sky-600" />
            <span>Transfer Asset to Another Employee</span>
          </DialogTitle>
          <DialogDescription className="text-xs">
            Reassign {asset.name} ({asset.code}) with complete handover trail and audit ledger.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3.5 py-1">
          {/* Current holder banner */}
          <div className="p-2.5 rounded-lg border bg-slate-50 dark:bg-slate-900/50 space-y-1 text-xs">
            <span className="text-slate-500 font-medium">Currently Held By:</span>
            <div className="flex items-center gap-2 font-medium text-slate-800 dark:text-slate-200">
              {ca ? (
                <>
                  <span className="font-semibold">{ca.employeeName}</span>
                  {ca.employeeCode && <span className="font-mono text-slate-400">({ca.employeeCode})</span>}
                  <span className="text-slate-400">· since {fmtDate(ca.assignedAt)}</span>
                </>
              ) : (
                <span className="text-emerald-600 font-semibold">In Stock (Not currently assigned)</span>
              )}
            </div>
          </div>

          {/* New employee picker */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Transfer To (New Employee) *</Label>
            <Select value={toEmployeeId} onValueChange={setToEmployeeId}>
              <SelectTrigger className="h-9 text-xs">
                <SelectValue placeholder="Select employee…" />
              </SelectTrigger>
              <SelectContent className="max-h-56">
                {activeEmployees.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.label} {e.department ? `· ${e.department}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Condition check */}
          <div className="grid grid-cols-2 gap-3">
            {ca && (
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Condition In (From Previous)</Label>
                <Select value={conditionIn} onValueChange={setConditionIn}>
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CONDITIONS.map((c) => (
                      <SelectItem key={c} value={c}>{titleCase(c)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className={`space-y-1.5 ${!ca ? "col-span-2" : ""}`}>
              <Label className="text-xs font-medium">Condition Out (To New)</Label>
              <Select value={conditionOut} onValueChange={setConditionOut}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CONDITIONS.map((c) => (
                    <SelectItem key={c} value={c}>{titleCase(c)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Return Due Date */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Return Due Date (Optional)</Label>
            <Input
              type="date"
              value={dueAt}
              onChange={(e) => setDueAt(e.target.value)}
              className="h-9 text-xs"
            />
          </div>

          {/* Transfer Note */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Transfer Note / Accessories Included</Label>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Transferred with charger, mouse, and laptop bag"
              rows={2}
              className="text-xs resize-none"
            />
          </div>

          {err && <p className="text-xs text-rose-600 bg-rose-50 dark:bg-rose-950 p-2.5 rounded-md">{err}</p>}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => onClose(false)} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" className="h-8 text-xs bg-sky-600 hover:bg-sky-700 text-white" onClick={handleTransfer} disabled={busy || !toEmployeeId}>
            {busy ? "Transferring…" : "Confirm Transfer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ================= MARK AS LOST =================

function MarkLostDialog({ asset, onClose }: { asset: AssetRow; onClose: (saved: boolean) => void }) {
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const ca = asset.currentAssignment

  const handleMarkLost = async () => {
    setErr(null)
    if (!note.trim() || note.trim().length < 3) {
      setErr("Please provide a reason / note explaining how the asset was lost (min 3 characters)")
      return
    }
    setBusy(true)
    try {
      await rpc("assets.lose", {
        id: asset.id,
        note: note.trim(),
      })
      toast(`Asset ${asset.code} marked as LOST`)
      onClose(true)
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={() => !busy && onClose(false)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2 text-rose-600">
            <AlertTriangle className="h-5 w-5" />
            <span>Mark Asset as Lost</span>
          </DialogTitle>
          <DialogDescription className="text-xs">
            {asset.name} ({asset.code})
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1">
          <div className="p-3 rounded-lg border border-rose-200 bg-rose-50/70 dark:bg-rose-950/40 text-rose-800 dark:text-rose-200 text-xs space-y-1">
            <p className="font-semibold">Are you sure you want to mark this asset as LOST?</p>
            {ca ? (
              <p className="text-[11px] text-rose-700 dark:text-rose-300">
                This asset is currently assigned to <b>{ca.employeeName}</b>. The outstanding assignment will remain tracked for exit clearance and recovery deduction.
              </p>
            ) : (
              <p className="text-[11px] text-rose-700 dark:text-rose-300">
                The asset will be flagged as lost and removed from available stock.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Reason / Incident Note *</Label>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Lost during transit / Police GD filed / Stolen from office"
              rows={3}
              className="text-xs resize-none"
            />
          </div>

          {err && <p className="text-xs text-rose-600 bg-rose-50 dark:bg-rose-950 p-2.5 rounded-md">{err}</p>}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => onClose(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-8 text-xs bg-rose-600 hover:bg-rose-700 text-white"
            onClick={handleMarkLost}
            disabled={busy || !note.trim()}
          >
            {busy ? "Marking Lost…" : "Confirm Mark as Lost"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ================= DETAIL + HISTORY =================

type EventRow = {
  id: string; type: string; actorName: string | null; note: string | null; createdAt: string
  snapshot: Record<string, unknown>; employeeName: string | null; employeeCode: string | null
}

const EVENT_ICON: Record<string, typeof Undo2> = {
  ASSIGN: PackageSearch, RETURN: Undo2, REPAIR: Wrench, RETIRE: PackageX, LOSE: AlertTriangle,
  NOTE: StickyNote, CLEARED_WITH_DEDUCTION: Landmark,
}
const EVENT_CLS: Record<string, string> = {
  ASSIGN: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300 border-violet-200 dark:border-violet-900",
  RETURN: "bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300 border-teal-200 dark:border-teal-900",
  REPAIR: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300 border-amber-200 dark:border-amber-900",
  RETIRE: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300 border-slate-200 dark:border-slate-700",
  LOSE: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300 border-rose-200 dark:border-rose-900",
  NOTE: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300 border-slate-200 dark:border-slate-700",
  CLEARED_WITH_DEDUCTION: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300 border-rose-200 dark:border-rose-900",
}
const EVENT_LABEL: Record<string, string> = {
  ASSIGN: "Assigned", RETURN: "Returned", REPAIR: "Repair", RETIRE: "Retired", LOSE: "Lost",
  NOTE: "Note", CLEARED_WITH_DEDUCTION: "Cleared with deduction",
}

function AssetDetailDialog({ assetId, onMutate, onClose }: {
  assetId: string; onMutate: () => void; onClose: () => void
}) {
  const { can } = useHrm()
  const toast = useHrm((s) => s.toast)
  const { data, loading, error, reload } = useApi<{ asset: AssetRow; events: EventRow[] }>("assets.history", { assetId })
  const [noteOpen, setNoteOpen] = useState(false)
  const [returnOpen, setReturnOpen] = useState(false)
  const [transferOpen, setTransferOpen] = useState(false)
  const [lostOpen, setLostOpen] = useState(false)
  const [confirmAct, setConfirmAct] = useState<{ kind: "repair" | "retire" | "lose" | "delete"; title: string; message: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [actError, setActError] = useState<string | null>(null)

  const asset = data?.asset
  const events = data?.events || []
  const w = asset ? warrantyState(asset.warrantyExpiry) : null

  const runLifecycle = async (action: string, extra: Record<string, unknown> = {}) => {
    setBusy(true); setActError(null)
    try {
      await rpc(action, { id: assetId, ...extra })
      toast(`${asset?.code || "Asset"} updated`)
      reload()
      onMutate()
    } catch (e) {
      setActError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Dialog open onOpenChange={(v) => { if (!v) onClose() }}>
        <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-base flex flex-wrap items-center gap-2">
              {asset ? asset.name : "Asset"}
              {asset && <span className="font-mono text-xs text-slate-400">{asset.code}</span>}
              {asset && <AssetStatusBadge status={asset.status} />}
              {asset?.sourceItemId && <Badge variant="outline" className="text-[9px]">issued from inventory</Badge>}
            </DialogTitle>
            {asset && (
              <DialogDescription className="text-xs">
                Registered {fmtDate(asset.createdAt)} · full append-only lifecycle ledger below.
              </DialogDescription>
            )}
          </DialogHeader>

          {/* Action buttons bar */}
          {asset && (
            <div className="flex flex-wrap items-center justify-between gap-2 p-2.5 rounded-xl border bg-slate-50/70 dark:bg-slate-900/40">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Asset Actions:</span>
              <div className="flex flex-wrap items-center gap-1.5">
                {can("assets", "assign") && (asset.currentAssignment || asset.status === "ASSIGNED") && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs bg-white dark:bg-slate-800 text-teal-700 dark:text-teal-400 border-teal-200 dark:border-teal-800 hover:bg-teal-50"
                    onClick={() => setReturnOpen(true)}
                  >
                    <Undo2 className="h-3.5 w-3.5 mr-1.5" /> Take Return
                  </Button>
                )}
                {can("assets", "assign") && !["REPAIR", "RETIRED", "LOST"].includes(asset.status) && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs bg-white dark:bg-slate-800 text-sky-700 dark:text-sky-400 border-sky-200 dark:border-sky-800 hover:bg-sky-50"
                    onClick={() => setTransferOpen(true)}
                  >
                    <ArrowLeftRight className="h-3.5 w-3.5 mr-1.5" /> Transfer to Another
                  </Button>
                )}
                {can("assets", "edit") && !["RETIRED", "LOST"].includes(asset.status) && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs bg-white dark:bg-slate-800 text-rose-700 dark:text-rose-400 border-rose-200 dark:border-rose-900 hover:bg-rose-50"
                    onClick={() => setLostOpen(true)}
                  >
                    <AlertTriangle className="h-3.5 w-3.5 mr-1.5" /> Mark as Lost
                  </Button>
                )}
              </div>
            </div>
          )}

          {error && <FieldError message={error} />}
          {loading && !asset && <p className="text-sm text-slate-400 py-6 text-center">Loading asset…</p>}

          {asset && (
            <div className="grid lg:grid-cols-2 gap-4 py-1">
              <div className="space-y-4">
                <SectionCard title="Details">
                  <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2.5">
                    {([
                      ["Category", titleCase(asset.category)],
                      ["Condition", <span key="c" className={CONDITION_CLS[asset.condition] || ""}>{titleCase(asset.condition)}</span>],
                      ["Brand / model", asset.brandModel || "—"],
                      ["Serial / IMEI", asset.serialImei || "—"],
                      ["Branch", asset.branchName || "—"],
                      ["Location", asset.locationNote || "—"],
                      ["Purchased", asset.purchaseDate ? `${fmtDate(asset.purchaseDate)}${asset.purchaseCost ? ` · ${fmtMoney(asset.purchaseCost)}` : ""}` : "—"],
                      ["Warranty", asset.warrantyExpiry ? (
                        <span key="w" className="flex items-center gap-1.5">
                          {fmtDate(asset.warrantyExpiry)}
                          {w && <Badge className={`text-[9px] ${w.cls}`}>{w.label}</Badge>}
                        </span>
                      ) : "—"],
                      ["Notes", asset.notes || "—"],
                    ] as [string, React.ReactNode][]).map(([k, v]) => (
                      <div key={k} className="min-w-0">
                        <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">{k}</dt>
                        <dd className="text-sm font-medium text-slate-800 dark:text-slate-200 break-words">{v ?? "—"}</dd>
                      </div>
                    ))}
                  </dl>
                </SectionCard>

                <SectionCard title="Current handover">
                  {asset.currentAssignment ? (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <PackageCheck className="h-4 w-4 text-violet-500 shrink-0" />
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{asset.currentAssignment.employeeName}</p>
                          <p className="text-[11px] text-slate-500 dark:text-slate-400">
                            {asset.currentAssignment.employeeCode || "—"} · since {fmtDate(asset.currentAssignment.assignedAt)}
                            {asset.currentAssignment.dueAt ? ` · due ${fmtDate(asset.currentAssignment.dueAt)}` : ""}
                          </p>
                        </div>
                      </div>
                      <p className="text-xs text-slate-600 dark:text-slate-300">
                        Out condition: <b className={CONDITION_CLS[asset.currentAssignment.conditionOut || ""] || ""}>{titleCase(asset.currentAssignment.conditionOut || "—")}</b>
                        {asset.currentAssignment.note ? ` · ${asset.currentAssignment.note}` : ""}
                      </p>
                      {can("assets", "assign") && (
                        <p className="text-[11px] text-slate-400">Use the table&apos;s Return action to close this handover.</p>
                      )}
                    </div>
                  ) : (
                    <EmptyState icon={PackageOpen} title="Not assigned"
                      hint={ASSIGNABLE.includes(asset.status)
                        ? "Use the table's Assign action to hand this asset to an employee."
                        : `Status is ${titleCase(asset.status)} — it must return to the shelf before assigning.`} />
                  )}
                </SectionCard>

                <SectionCard title="Lifecycle actions">
                  <div className="flex flex-wrap gap-1.5">
                    {can("assets", "edit") && ["IN_STOCK", "RETURNED", "REPAIR"].includes(asset.status) && (
                      <Button size="sm" variant="outline" className="h-8 text-xs" disabled={busy}
                        onClick={() => setConfirmAct({
                          kind: "repair",
                          title: asset.status === "REPAIR" ? "Mark repaired" : "Send for repair",
                          message: asset.status === "REPAIR"
                            ? `${asset.code} comes back to the shelf as IN_STOCK.`
                            : `${asset.code} is marked REPAIR while being serviced — it cannot be assigned.`,
                        })}>
                        <Wrench className="h-3.5 w-3.5 mr-1" /> {asset.status === "REPAIR" ? "Mark repaired" : "Send for repair"}
                      </Button>
                    )}
                    {can("assets", "edit") && !["ASSIGNED", "RETIRED", "LOST"].includes(asset.status) && (
                      <Button size="sm" variant="outline" className="h-8 text-xs" disabled={busy}
                        onClick={() => setConfirmAct({ kind: "retire", title: "Retire asset", message: `${asset.code} is permanently removed from active use and can no longer be assigned.` })}>
                        <PackageX className="h-3.5 w-3.5 mr-1" /> Retire
                      </Button>
                    )}
                    {can("assets", "edit") && !["RETIRED", "LOST"].includes(asset.status) && (
                      <Button size="sm" variant="outline" className="h-8 text-xs text-rose-700 border-rose-200 hover:bg-rose-50 dark:text-rose-400 dark:border-rose-900" disabled={busy}
                        onClick={() => setConfirmAct({ kind: "lose", title: "Mark lost", message: `${asset.code} is marked LOST.${asset.status === "ASSIGNED" ? " The outstanding handover stays open — it must still be cleared during exit (with a recovery deduction if applicable)." : ""}` })}>
                        <AlertTriangle className="h-3.5 w-3.5 mr-1" /> Mark lost
                      </Button>
                    )}
                    {can("assets", "edit") && (
                      <Button size="sm" variant="outline" className="h-8 text-xs" disabled={busy} onClick={() => setNoteOpen(true)}>
                        <StickyNote className="h-3.5 w-3.5 mr-1" /> Add note
                      </Button>
                    )}
                    {can("assets", "delete") && !["ASSIGNED", "RETIRED", "LOST"].includes(asset.status) && (
                      <Button size="sm" variant="outline" className="h-8 text-xs text-rose-700 border-rose-200 hover:bg-rose-50 dark:text-rose-400 dark:border-rose-900" disabled={busy}
                        onClick={() => setConfirmAct({ kind: "delete", title: "Delete asset", message: `${asset.code} will be removed together with its event timeline. Only possible while it has no handover history — prefer Retire otherwise.` })}>
                        Delete
                      </Button>
                    )}
                  </div>
                  <FieldError message={actError} />
                </SectionCard>
              </div>

              {/* ---- timeline ---- */}
              <SectionCard title="History" actions={
                <span className="text-[11px] text-slate-500 dark:text-slate-400 tabular-nums flex items-center gap-1">
                  <History className="h-3 w-3" /> {events.length} event{events.length !== 1 ? "s" : ""}
                </span>
              }>
                {events.length === 0 ? (
                  <EmptyState icon={ShieldCheck} title="No events yet" hint="Assignments, returns, repairs and notes all appear here — nothing is editable after the fact." />
                ) : (
                  <div className="relative pl-6 max-h-[420px] overflow-y-auto scroll-thin pr-1">
                    <div className="absolute left-2 top-1 bottom-1 w-px bg-slate-200 dark:bg-slate-700" aria-hidden />
                    {events.map((e) => {
                      const Icon = EVENT_ICON[e.type] || CircleDot
                      const snap = e.snapshot || {}
                      const emp = snap.employee as { name?: string } | undefined
                      const cond = (snap.conditionOut || snap.conditionIn) as string | undefined
                      const transition = snap.from && snap.to ? `${String(snap.from)} → ${String(snap.to)}` : null
                      const recovery = snap.recoveryAmount != null ? Number(snap.recoveryAmount) : null
                      return (
                        <div key={e.id} className="relative pb-4 last:pb-0">
                          <div className={`absolute -left-[1.31rem] top-0.5 h-[22px] w-[22px] rounded-full border flex items-center justify-center ${EVENT_CLS[e.type] || EVENT_CLS.NOTE}`}>
                            <Icon className="h-3 w-3" />
                          </div>
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            <p className="text-[13px] font-semibold text-slate-800 dark:text-slate-100">{EVENT_LABEL[e.type] || titleCase(e.type)}</p>
                            <span className="text-[10px] text-slate-400">{fmtDateTime(e.createdAt)}</span>
                          </div>
                          {(emp?.name || e.employeeName || cond || transition || recovery != null) && (
                            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                              {emp?.name || e.employeeName ? `to ${emp?.name || e.employeeName}` : ""}
                              {cond ? ` · condition ${titleCase(cond)}` : ""}
                              {transition ? ` · ${transition}` : ""}
                              {recovery != null ? ` · recovered ${fmtMoney(recovery)}` : ""}
                            </p>
                          )}
                          {e.note && <p className="text-xs text-slate-600 dark:text-slate-300 mt-0.5 italic">“{e.note}”</p>}
                          {e.actorName && <p className="text-[10px] text-slate-400 mt-0.5">by {e.actorName}</p>}
                        </div>
                      )
                    })}
                  </div>
                )}
              </SectionCard>
            </div>
          )}

          <DialogFooter className="gap-2 sm:justify-between items-center">
            <div className="flex flex-wrap gap-2">
              {can("assets", "assign") && (asset?.currentAssignment || asset?.status === "ASSIGNED") && (
                <Button size="sm" variant="outline" className="h-8 text-xs text-teal-700 border-teal-200 hover:bg-teal-50" onClick={() => setReturnOpen(true)}>
                  <Undo2 className="h-3.5 w-3.5 mr-1.5" /> Take Return
                </Button>
              )}
              {can("assets", "assign") && asset && !["REPAIR", "RETIRED", "LOST"].includes(asset.status) && (
                <Button size="sm" variant="outline" className="h-8 text-xs text-sky-700 border-sky-200 hover:bg-sky-50" onClick={() => setTransferOpen(true)}>
                  <ArrowLeftRight className="h-3.5 w-3.5 mr-1.5" /> Transfer to Another
                </Button>
              )}
              {can("assets", "edit") && asset && !["RETIRED", "LOST"].includes(asset.status) && (
                <Button size="sm" variant="outline" className="h-8 text-xs text-rose-700 border-rose-200 hover:bg-rose-50" onClick={() => setLostOpen(true)}>
                  <AlertTriangle className="h-3.5 w-3.5 mr-1.5" /> Mark as Lost
                </Button>
              )}
            </div>
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={onClose}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- quick action dialogs ---- */}
      {returnOpen && asset && (
        <ReturnDialog
          asset={asset}
          onClose={(saved) => {
            setReturnOpen(false)
            if (saved) {
              reload()
              onMutate()
            }
          }}
        />
      )}
      {transferOpen && asset && (
        <TransferAssetDialog
          asset={asset}
          onClose={(saved) => {
            setTransferOpen(false)
            if (saved) {
              reload()
              onMutate()
            }
          }}
        />
      )}
      {lostOpen && asset && (
        <MarkLostDialog
          asset={asset}
          onClose={(saved) => {
            setLostOpen(false)
            if (saved) {
              reload()
              onMutate()
            }
          }}
        />
      )}

      {/* ---- add note ---- */}
      {noteOpen && asset && (
        <FormDialog
          open onOpenChange={(v) => !v && setNoteOpen(false)}
          title={`Note on ${asset.code}`}
          description="Appended to the asset timeline — nothing is overwritten."
          fields={[{ name: "note", label: "Note", type: "textarea", rows: 3, required: true, span: 2 }]}
          submitLabel="Add note"
          onSubmit={async (v) => {
            await rpc("assets.note", { assetId: asset.id, note: v.note })
            onMutate()
          }}
        />
      )}

      {/* ---- lifecycle confirmations ---- */}
      {confirmAct && asset && (
        <ConfirmDialog
          open onOpenChange={(v) => !v && setConfirmAct(null)}
          title={confirmAct.title} message={confirmAct.message}
          confirmLabel={confirmAct.kind === "delete" ? "Delete" : confirmAct.title}
          danger={confirmAct.kind === "lose" || confirmAct.kind === "delete"}
          requireReason={confirmAct.kind !== "repair"}
          onConfirm={async (reason) => {
            const action = confirmAct.kind === "delete" ? "assets.delete" : `assets.${confirmAct.kind}`
            await runLifecycle(action, confirmAct.kind === "delete" ? {} : reason ? { note: reason } : {})
            setConfirmAct(null)
          }}
        />
      )}
    </>
  )
}
