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
import { useState } from "react"
import { Building2, Plus, Pencil, Trash2, MapPin, Store, Warehouse, Building } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useHrm } from "../store"
import { useApi, rpc, useEmployeeDirectory } from "../api"
import { PageHeader, StatCard, fmtMoney, titleCase, SectionTabs } from "../shared/ui-kit"
import { DataTable, type Column } from "../shared/data-table"
import { FormDialog, ConfirmDialog, type FieldDef } from "../shared/form-dialog"

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
    // fetch the next code BEFORE opening — FormDialog initializes its values
    // on the closed→open transition, so the code must be in `initial` at that
    // moment. A failed fetch still opens (blank code → server auto-generates).
    try {
      const res = await rpc<{ code: string }>("branches.nextCode", {})
      setNextCode(res?.code || null)
    } catch { /* the server still auto-generates on blank at create time */ }
    setOpen(true)
  }

  const fields: FieldDef[] = [
    editRec
      ? { name: "code", label: "Branch Code", help: "Assigned code — contact an administrator to change it." }
      : lockedCodeField(nextCode, "BR"),
    { name: "name", label: "Branch Name", required: true, span: 2 },
    { name: "type", label: "Type", type: "select", options: BRANCH_TYPES.map((t) => ({ value: t, label: titleCase(t) })), defaultValue: "STORE" },
    { name: "contact", label: "Contact" },
    { name: "address", label: "Address", type: "textarea", span: 2, rows: 2 },
    { name: "operatingHours", label: "Operating Hours", placeholder: "10:00-21:00" },
    { name: "managerId", label: "Branch Manager", type: "select", options: (employees || []).map((e: any) => ({ value: e.id, label: `${e.fullName} (${e.code})` })) },
    { name: "latitude", label: "Latitude (geo-fence)", type: "number", step: 0.000001, help: "Branch GPS center" },
    { name: "longitude", label: "Longitude (geo-fence)", type: "number", step: 0.000001 },
    { name: "geofenceRadius", label: "Geo-fence Radius (m)", type: "number", min: 20, defaultValue: 200 },
    { name: "geofenceStartTime", label: "Fence Window Start", type: "time", help: "Geo-fence punches accepted from (falls back to operating hours)" },
    { name: "geofenceEndTime", label: "Fence Window End", type: "time", help: "Geo-fence punches accepted until" },
    { name: "geofenceActive", label: "Geo-fence attendance enabled", type: "switch", defaultValue: true },
    { name: "active", label: "Active", type: "switch", defaultValue: true },
  ]

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
    { key: "employees", label: "Total Employee", align: "right", render: (b) => <span className="text-xs font-bold tabular-nums text-slate-700 dark:text-slate-200">{(employees || []).filter((e: any) => e.branchId === b.id).length}</span> },
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

      <FormDialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setEditRec(null); setNextCode(null); reload() } }}
        title={editRec ? `Edit — ${editRec.name}` : "Add Branch"} fields={fields}
        initial={editRec || (nextCode ? { code: nextCode } : undefined)} wide
        description={editRec ? undefined : "The branch code is generated automatically and locked. Geo-fence settings power geo-fence attendance validation."}
        onSubmit={async (v) => { await rpc(editRec ? "branches.update" : "branches.create", editRec ? { id: editRec.id, ...v } : v) }} />
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
    { key: "count", label: "Employees", align: "right", render: (d) => <span className="text-xs font-bold tabular-nums">{(employees || []).filter((e) => e.departmentId === d.id).length}</span> },
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
    { key: "count", label: "Holders", align: "right", render: (d) => <span className="text-xs font-bold tabular-nums">{(employees || []).filter((e) => e.designationId === d.id).length}</span> },
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
