"use client"
// ============ Employee Directory + 360° Biodata (spec §5) ============
// Central source of truth: personal, family, education, references, previous
// employment, bank/MFS, secure documents, history timeline, lifecycle actions.
import { useEffect, useMemo, useRef, useState } from "react"
import {
  Users, Plus, ArrowLeft, GraduationCap, HeartHandshake, Landmark,
  Briefcase, FileText, History, TrendingUp, ArrowRightLeft, BadgeCheck, Upload, Eye, FolderOpen,
  Download, ShieldCheck, Pencil, Trash2, UserRound, Mail, Phone, MapPin, CalendarDays, Banknote, Plane, Sparkles, LogOut,
  FileSpreadsheet, FileUp, CheckCircle2, XCircle, AlertTriangle,
  MoreVertical, KeyRound, Ban, PlayCircle, CalendarClock, CalendarRange, UserRoundPlus,
  Hash, ReceiptText, Printer, Copy, Check, ChevronDown, ExternalLink, Laptop, Shield, PhoneCall, Timer,
  UserCheck, Layers, ArrowRight, Info, UserX, Award,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useHrm } from "../store"
import { useEmployeeDirectory, useApi, rpc } from "../api"
import { PageHeader, RowButton, StatCard, StatusBadge, fmtMoney, fmtDate, isExpired, titleCase, SectionCard, SectionTabs, type SectionTabGroup, KV, EmptyState, todayDhaka } from "../shared/ui-kit"
import { DataTable, type Column } from "../shared/data-table"
import { FormDialog, ConfirmDialog, type FieldDef } from "../shared/form-dialog"
import { processEmployeePhoto } from "../shared/photo"
import { validateNid } from "../validators-bd"
import { EmployeeProfilePrintModal } from "./employee-profile-print"
import { EditProfileDialog } from "./employee-edit-dialog"
import { CreateEmployeeDialog } from "./employee-create-dialog"
import { EmployeeQuickActionSheet, type QuickActionType } from "./employee-quick-actions-sheet"
import { TerminateEmployeeDialog, RetireEmployeeDialog } from "./employee-exit-dialogs"
// R1 — bulk employee import: client-side Excel/CSV parsing (xlsx) + the demo
// template generator. Rows are sent to the audited employees.bulkImport RPC.
// M-29 — xlsx (~400 KB) is loaded LAZILY inside the handlers (same pattern as
// the holidays tab) instead of eagerly importing on every directory page load.

// employee weeklyOff override — stored as a comma list ("FRIDAY,SATURDAY")
const fmtWeeklyOff = (v?: string | null) =>
  v ? v.split(",").filter(Boolean).map((d) => titleCase(d)).join(" + ") : "—"

export default function EmployeesView() {
  const { view, navigate: _navigate, can: _can, user: _user } = useHrm()
  const employeeId = (view.params as any)?.employeeId
  const addOpen = (view.params as any)?.add === true
  const printParam = (view.params as any)?.print === true
  // M-8 — dashboard stat-card drill-downs land here with a status/department
  // filter; the directory picks the params up as initial filter state
  const drillStatus = (view.params as any)?.status || ""
  const drillDept = (view.params as any)?.departmentId || ""

  if (employeeId) return <Employee360 employeeId={employeeId} editParam={(view.params as any)?.edit === true} printParam={printParam} />
  return <Directory addOpen={addOpen} drillStatus={drillStatus} drillDepartmentId={drillDept} />
}

// ================= DIRECTORY =================
function Directory({ addOpen, drillStatus, drillDepartmentId }: { addOpen?: boolean; drillStatus?: string; drillDepartmentId?: string }) {
  const { navigate, can } = useHrm()
  const toast = useHrm((s) => s.toast)
  // RBAC-105 — employees.export gates the directory CSV (client page export
  // AND the full server-side export route below).
  const canExport = can("employees", "export")
  const [exporting, setExporting] = useState(false)
  // M-8 — initial filter state honors drill-down params (status/departmentId)
  const [filters, setFilters] = useState<Record<string, string>>(() => ({
    status: drillStatus || "",
    departmentId: drillDepartmentId || "",
  }))
  // M-7 — server-paginated directory: pages of 200 with a Load More control,
  // so payload weight stays flat as the vendor grows (legacy full-list calls
  // would silently ship the whole table plus name-decoration joins).
  const PAGE_SIZE = 200
  const [rows, setRows] = useState<any[]>([])
  const [total, setTotal] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const filterKey = JSON.stringify(filters)
  // M-22 — status counts for the stat cards, from the SERVER (take:1 count
  // queries) — the cards used to count only the loaded 200-row page, so
  // "Total/Active/Probation/Exited" all froze at page size in larger vendors.
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({})

  const load = async (append = false) => {
    const skip = append ? rows.length : 0
    if (append) setLoadingMore(true); else setLoading(true)
    setError(null)
    try {
      const res = await rpc<any>("employees.list", { ...filters, paginate: true, take: PAGE_SIZE, skip })
      setTotal(res.total)
      setRows(append ? [...rows, ...res.rows] : res.rows)
      if (!append) {
        // vendor-level status totals under the current non-status filters
        // FE-3 (Phase 2 WS4) — ONE employees.statusCounts groupBy (was: six
        // employees.list take:1 count RPCs, each running the full decorate
        // path with its whole-table manager scan)
        const { status: _status, ...rest } = filters
        const counts = await rpc<any>("employees.statusCounts", rest).catch(() => null)
        setStatusCounts({
          TOTAL: counts?.total ?? 0,
          ACTIVE: counts?.counts?.ACTIVE ?? 0,
          PROBATION: counts?.counts?.PROBATION ?? 0,
          RESIGNED: counts?.counts?.RESIGNED ?? 0,
          TERMINATED: counts?.counts?.TERMINATED ?? 0,
          RETIRED: counts?.counts?.RETIRED ?? 0,
        })
      }
    } catch (e: any) {
      setError(e.message)
      if (!append) setRows([])
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }
  useEffect(() => { load(false) }, [filterKey])
  const data = rows
  const reload = () => load(false)
  const hasMore = total != null && rows.length < total
  const [createOpen, setCreateOpen] = useState(!!addOpen)
  const [importOpen, setImportOpen] = useState(false) // R1 — bulk import wizard
  const [lookups, setLookups] = useState<any>(null)
  const [lookupError, setLookupError] = useState<string | null>(null)
  // 2026-10 — the standalone Delete button/dialog moved INTO the three-dot
  // menu (EmployeeRowMenu): its old row click used to bubble and open the
  // profile behind the confirm dialog.

  // Load form lookups once. (Previously a side-effect inside useMemo with an
  // unhandled promise chain — if any lookup failed, `lookups` stayed null and
  // the Create dialog never mounted, making the Add Employee button dead.)
  useEffect(() => {
    let alive = true
    Promise.all([
      rpc("branches.list", {}),
      rpc("departments.list", {}),
      rpc("designations.list", {}),
      rpc("shifts.list", {}),
    ])
      .then(([branches, departments, designations, shifts]) => {
        if (alive) setLookups({ branches, departments, designations, shifts })
      })
      .catch((e: any) => {
        if (alive) setLookupError(e?.message || "Failed to load form options")
      })
    return () => { alive = false }
  }, [])

  const columns: Column<any>[] = [
    {
      key: "fullName", label: "Employee", sortValue: (r) => r.fullName,
      // The code (EMP-0024) and emails only RENDER inside this column's custom
      // cell — expose them to the search filter explicitly so directory search
      // by employee ID / email works, not just by display name.
      searchValue: (r) => [r.fullName, r.code, r.designationName, r.mobile, r.personalEmail, r.officialEmail].filter(Boolean).join(" "),
      render: (r) => (
        <div className="flex items-center gap-2.5">
          <Avatar className="h-8 w-8">
            {r.photoUrl && <AvatarImage src={r.photoUrl} alt={r.fullName} />}
            <AvatarFallback className="bg-emerald-100 text-emerald-700 text-[10px] font-bold">{(r.fullName || "?").split(" ").map((x: string) => x[0]).slice(0, 2).join("")}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">{r.fullName}</p>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">{r.code} · {r.designationName || "—"}</p>
          </div>
        </div>
      ),
    },
    { key: "departmentName", label: "Department", render: (r) => <span className="text-xs text-slate-600 dark:text-slate-300">{r.departmentName || "—"}</span> },
    { key: "branchName", label: "Branch", render: (r) => <span className="text-xs text-slate-600 dark:text-slate-300">{r.branchName || "—"}</span> },
    { key: "employmentType", label: "Type", render: (r) => <Badge variant="outline" className="text-[10px] font-medium">{titleCase(r.employmentType)}</Badge> },
    { key: "status", label: "Status", render: (r) => <StatusBadge status={r.status} /> },
    { key: "joiningDate", label: "Joined", sortValue: (r) => r.joiningDate || "", render: (r) => <span className="text-xs text-slate-500">{fmtDate(r.joiningDate)}</span> },
    { key: "mobile", label: "Mobile", render: (r) => <span className="text-xs text-slate-500 tabular-nums">{r.mobile || "—"}</span> },
    {
      key: "actions", label: "", align: "right",
      render: (r) => (
        <div className="flex items-center justify-end gap-1">
          {/* UI-R4 — normalized row actions: quick 360° + the three-dot menu
              (2026-10 §13–§17: suspend/activate, reset login password, change
              shift, attendance history, view/edit profile, create account).
              The standalone Delete button was REMOVED from the directory — its
              click used to bubble to the row and open the profile behind the
              confirm dialog; archive/hard-delete now live inside the menu where
              every item is explicitly permission-gated. */}
          <RowButton tone="neutral" onClick={() => navigate("employees", { employeeId: r.id })} title="Open the 360° biodata profile">360°</RowButton>
          <EmployeeRowMenu row={r} lookups={lookups} onDone={reload} />
        </div>
      ),
    },
  ]

  // M-22 — server-side counts (was: counting only the loaded page)
  const count = (s: string) => statusCounts[s] ?? 0

  // RBAC-105 (Wave R3-5) — full directory export through the REAL server-side
  // route (perm employees.export, scope-filtered, NON-PII columns, capped,
  // audited). Bulk-PII biodata exports stay on the reports.pii gate (R3-3).
  const exportCsv = async () => {
    setExporting(true)
    try {
      const res = await rpc<any>("employees.exportCsv", {
        status: filters.status || undefined,
        branchId: filters.branchId || undefined,
        departmentId: filters.departmentId || undefined,
        q: filters.q || undefined,
      })
      const blob = new Blob([res.csv], { type: "text/csv;charset=utf-8" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url; a.download = res.fileName || "employee-directory.csv"
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
      toast(`Exported ${res.count} directory rows${res.truncated ? " (capped at 10,000 — narrow the filters)" : ""}`)
    } catch (e: any) {
      toast(e.message || "Export failed", "err")
    } finally { setExporting(false) }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Employee Directory"
        subtitle="Central employee master — click any row for the 360° profile"
        actions={
          (can("employees", "create") || canExport) && (
            <div className="flex flex-wrap gap-1.5">
              {/* R1 — bulk import from Excel/CSV with a downloadable demo template */}
              {can("employees", "create") && (
                <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}
                  className="h-8 text-xs bg-white dark:bg-slate-900">
                  <FileUp className="h-3.5 w-3.5 mr-1 text-emerald-600" /> Bulk Import
                </Button>
              )}
              {/* RBAC-105 — server-side, permission-gated, audit-logged directory export */}
              {canExport && (
                <Button size="sm" variant="outline" onClick={exportCsv} disabled={exporting}
                  className="h-8 text-xs bg-white dark:bg-slate-900">
                  <Download className="h-3.5 w-3.5 mr-1 text-emerald-600" /> {exporting ? "Exporting…" : "Export CSV"}
                </Button>
              )}
              {can("employees", "create") && (
                <Button size="sm" disabled={!lookups} onClick={() => setCreateOpen(true)}
                  className=" h-8">
                  <Plus className="h-3.5 w-3.5 mr-1" /> {lookups ? "Add Employee" : "Loading form…"}
                </Button>
              )}
            </div>
          )
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Total" value={statusCounts.TOTAL ?? total ?? (data?.length || "—")} icon={Users} tone="emerald" />
        <StatCard label="Active" value={count("ACTIVE")} icon={BadgeCheck} tone="teal" />
        <StatCard label="Probation" value={count("PROBATION")} icon={CalendarDays} tone="amber" />
        <StatCard label="Exited" value={count("RESIGNED") + count("TERMINATED") + count("RETIRED")} icon={ArrowLeft} tone="slate" />
      </div>

      <div className="flex flex-wrap gap-2">
        <FilterChip label="All" active={!filters.status} onClick={() => setFilters((f) => ({ ...f, status: "" }))} />
        {/* 2026-10-14 — full status taxonomy on the directory filter chips (user
            request): INACTIVE (archived employees), SUSPENDED and RETIRED were
            previously unreachable from the UI even though employees.list has
            always accepted every status. */}
        {["ACTIVE", "PROBATION", "ON_LEAVE", "SUSPENDED", "INACTIVE", "RESIGNED", "TERMINATED", "RETIRED"].map((s) => (
          <FilterChip key={s} label={titleCase(s)} active={filters.status === s} onClick={() => setFilters((f) => ({ ...f, status: s }))} />
        ))}
        {lookups && (
          <Select value={filters.branchId || "all"} onValueChange={(v) => setFilters((f) => ({ ...f, branchId: v === "all" ? "" : v }))}>
            <SelectTrigger size="sm" className="h-7 rounded-full text-xs text-slate-600 dark:text-slate-300 px-3 gap-1">
              <SelectValue placeholder="All branches" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All branches</SelectItem>
              {lookups.branches.map((b: any) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        {lookups && (
          <Select value={filters.departmentId || "all"} onValueChange={(v) => setFilters((f) => ({ ...f, departmentId: v === "all" ? "" : v }))}>
            <SelectTrigger size="sm" className="h-7 rounded-full text-xs text-slate-600 dark:text-slate-300 px-3 gap-1">
              <SelectValue placeholder="All departments" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All departments</SelectItem>
              {lookups.departments.map((d: any) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
      </div>

      <DataTable columns={columns} rows={data || undefined} loading={loading} error={error} csvName={canExport ? "employee-directory" : undefined} stickyHeader pageSize={50}
        searchPlaceholder="Search name, ID (e.g. EMP-0024), mobile, email…"
        /* Server-side search: keystrokes are debounced into `filters.q` and
           employees.list matches them against name, CODE, mobile and emails
           across the WHOLE table — not just the currently loaded 200-row page
           (fixes "searching EMP-0024 shows blank"). */
        onSearch={(q) => setFilters((f) => ({ ...f, q }))}
        onRowClick={(r) => navigate("employees", { employeeId: r.id })}
        emptyTitle="No employees match the filters" />
      {hasMore && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" className="h-9" disabled={loadingMore} onClick={() => load(true)}>
            {loadingMore ? "Loading…" : `Load more (${rows.length} of ${total} shown)`}
          </Button>
        </div>
      )}

      {lookupError && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 dark:bg-rose-950 text-sm text-rose-700 dark:text-rose-300 px-4 py-2.5 flex items-center justify-between gap-3">
          <span>Employee form options failed to load: {lookupError}</span>
          <Button size="sm" variant="outline" className="h-7 text-xs shrink-0" onClick={() => { setLookupError(null); window.location.reload() }}>Retry</Button>
        </div>
      )}

      {lookups && (
        <CreateEmployeeDialog open={createOpen} onOpenChange={(v) => { setCreateOpen(v); if (!v) reload() }} lookups={lookups} onCreated={(id) => navigate("employees", { employeeId: id })} />
      )}

      {/* R1 — bulk employee import wizard (Excel/CSV) */}
      <BulkImportDialog open={importOpen} onOpenChange={(v) => { setImportOpen(v); if (!v) reload() }} lookups={lookups} />

    </div>
  )
}

function FilterChip({ label, active, onClick }: { label: string; active?: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`h-7 rounded-full px-3 text-xs font-medium border transition-colors ${active ? "bg-primary text-primary-foreground border-primary" : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-emerald-400"}`}>
      {label}
    </button>
  )
}

// ============================================================
// 2026-10 round §13–§17 — Employee three-dot action menu
// Suspend/Activate · Reset Login Password · Change Shift ·
// View Attendance History · View/Edit Profile · Create Login
// Account · Archive/Hard delete. Every item mirrors the server's
// permission gate; invisible without the permission.
// ============================================================
function EmployeeRowMenu({ row, lookups, onDone }: { row: any; lookups: any; onDone: () => void }) {
  const { navigate, can, toast } = useHrm()
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirm, setConfirm] = useState<{ kind: "suspend" | "activate" | "reset" | "account"; row: any } | null>(null)
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [shiftOpen, setShiftOpen] = useState(false)
  const [attOpen, setAttOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [terminateOpen, setTerminateOpen] = useState(false)
  const [retireOpen, setRetireOpen] = useState(false)
  const [deleteMode, setDeleteMode] = useState<"soft" | "hard">("soft")
  const [deleteConfirmText, setDeleteConfirmText] = useState("")
  // one-time temp password reveal (reset/account) — only when nothing was deliverable
  const [reveal, setReveal] = useState<{ email: string; tempPassword?: string; emailStatus: string; smsStatus: string; note: string } | null>(null)

  const canEdit = can("employees", "edit")
  const canReset = can("settings", "edit")
  const canAtt = can("attendance", "view")
  const canDelete = can("employees", "delete")
  // EMP-10 (R5) — hard delete is a separate verb (employees.purge): archive
  // stays gated on employees.delete, irreversible destruction needs purge.
  const canPurge = can("employees", "purge")
  const suspended = row.status === "SUSPENDED"
  const isExited = ["TERMINATED", "RETIRED", "RESIGNED", "INACTIVE"].includes(row.status)
  const hasAccount = !!row.hasUserAccount

  const act = async (fn: () => Promise<any>, okMsg: string) => {
    setBusy(true)
    try {
      const res = await fn()
      toast(okMsg)
      setConfirm(null)
      setReason("")
      onDone()
      return res
    } catch (e: any) {
      toast(e.message, "err")
      return null
    } finally { setBusy(false) }
  }

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon" title="Employee actions" aria-label={`Actions for ${row.fullName}`}
            className="h-7 w-7 shrink-0 text-slate-500 hover:text-slate-700 dark:hover:text-slate-200"
            onClick={(e) => e.stopPropagation()}>
            <MoreVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuLabel className="text-xs">
            <span className="font-semibold text-slate-700 dark:text-slate-200">{row.fullName}</span>
            <span className="ml-1 text-slate-400">{row.code}</span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {canEdit && (suspended ? (
            <DropdownMenuItem onClick={() => { setConfirm({ kind: "activate", row }); setReason("") }} className="gap-2 text-xs">
              <PlayCircle className="h-3.5 w-3.5 text-emerald-600" /> Activate Employee
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onClick={() => { setConfirm({ kind: "suspend", row }); setReason("") }} className="gap-2 text-xs">
              <Ban className="h-3.5 w-3.5 text-amber-600" /> Suspend Employee
            </DropdownMenuItem>
          ))}
          {canEdit && !isExited && (
            <>
              <DropdownMenuItem onClick={() => setTerminateOpen(true)} className="gap-2 text-xs text-rose-600 focus:text-rose-600 font-medium">
                <UserX className="h-3.5 w-3.5" /> Terminate Employee
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setRetireOpen(true)} className="gap-2 text-xs text-purple-600 dark:text-purple-400 focus:text-purple-600 font-medium">
                <Award className="h-3.5 w-3.5" /> Retire Employee
              </DropdownMenuItem>
            </>
          )}
          {isExited && can("exit", "view") && (
            <DropdownMenuItem onClick={() => navigate("exit")} className="gap-2 text-xs text-slate-600 dark:text-slate-300">
              <LogOut className="h-3.5 w-3.5 text-slate-500" /> View Exit Case
            </DropdownMenuItem>
          )}
          {canReset && hasAccount && (
            <DropdownMenuItem onClick={() => { setConfirm({ kind: "reset", row }); setReason("") }} className="gap-2 text-xs">
              <KeyRound className="h-3.5 w-3.5" /> Reset Login Password
            </DropdownMenuItem>
          )}
          {canEdit && !hasAccount && (
            <DropdownMenuItem onClick={() => { setConfirm({ kind: "account", row }); setReason("") }} className="gap-2 text-xs">
              <UserRoundPlus className="h-3.5 w-3.5" /> Create Login Account
            </DropdownMenuItem>
          )}
          {canEdit && !!lookups?.shifts?.length && (
            <DropdownMenuItem onClick={() => setShiftOpen(true)} className="gap-2 text-xs">
              <CalendarClock className="h-3.5 w-3.5" /> Change Shift
            </DropdownMenuItem>
          )}
          {canAtt && (
            <DropdownMenuItem onClick={() => setAttOpen(true)} className="gap-2 text-xs">
              <CalendarRange className="h-3.5 w-3.5" /> View Attendance History
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => navigate("employees", { employeeId: row.id })} className="gap-2 text-xs">
            <UserRound className="h-3.5 w-3.5" /> View Profile
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => navigate("employees", { employeeId: row.id, print: true })} className="gap-2 text-xs">
            <Printer className="h-3.5 w-3.5 text-emerald-600" /> Print Profile / Export CV
          </DropdownMenuItem>
          {canEdit && (
            <DropdownMenuItem onClick={() => navigate("employees", { employeeId: row.id, edit: true })} className="gap-2 text-xs">
              <Pencil className="h-3.5 w-3.5" /> Edit Employee
            </DropdownMenuItem>
          )}
          {canDelete && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => { setDeleteOpen(true); setDeleteMode("soft"); setDeleteConfirmText("") }} className="gap-2 text-xs text-rose-600 focus:text-rose-600">
                <Trash2 className="h-3.5 w-3.5" /> Delete / Archive
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* ---- suspend / activate / reset / create-account confirmations ---- */}
      <Dialog open={!!confirm} onOpenChange={(v) => { if (!v) { setConfirm(null); setReason(""); setReveal(null) } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              {confirm?.kind === "suspend" && <><Ban className="h-4 w-4 text-amber-600" /> Suspend Employee</>}
              {confirm?.kind === "activate" && <><PlayCircle className="h-4 w-4 text-emerald-600" /> Activate Employee</>}
              {confirm?.kind === "reset" && <><KeyRound className="h-4 w-4" /> Reset Login Password</>}
              {confirm?.kind === "account" && <><UserRoundPlus className="h-4 w-4" /> Create Login Account</>}
            </DialogTitle>
          </DialogHeader>
          {confirm && (
            <div className="space-y-3">
              <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 px-3 py-2">
                <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{confirm.row.fullName}</p>
                <p className="text-[11px] text-slate-500">{confirm.row.code} · {confirm.row.designationName || "—"} · {confirm.row.branchName || "—"}</p>
              </div>
              {confirm.kind === "suspend" && (
                <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                  Suspension blocks the employee&apos;s portal access (their linked account is suspended and active
                  sessions revoked) but the employee record and all history stay intact. The action is recorded in
                  the audit log and employee timeline.
                </p>
              )}
              {confirm.kind === "activate" && (
                <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                  Activation lifts the suspension: the employee returns to ACTIVE status and portal access is restored.
                </p>
              )}
              {confirm.kind === "reset" && (
                <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                  A new secure temporary password is generated (the current password is never displayed), all active
                  sessions are revoked, and the employee must choose a new password at the next sign-in. Delivery
                  follows the Communication settings (Email/SMS).
                </p>
              )}
              {confirm.kind === "account" && (
                <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                  Creates the employee self-service account ({confirm.row.officialEmail || confirm.row.personalEmail || "no email on file"})
                  with a temporary password that must be changed at first sign-in. If no email is on file, add one
                  to the employee profile first.
                </p>
              )}
              {(confirm.kind === "suspend" || confirm.kind === "activate") && (
                <div className="space-y-1.5">
                  <Label className="text-xs text-slate-500">Reason (optional — recorded in the audit trail)</Label>
                  <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="e.g. pending internal investigation" />
                </div>
              )}
              {reveal && (
                <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40 p-3">
                  <p className="text-xs text-amber-800 dark:text-amber-300">{reveal.note}</p>
                  <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-500">
                    <span>Email: <b>{reveal.emailStatus}</b></span>
                    <span>SMS: <b>{reveal.smsStatus}</b></span>
                  </div>
                  {reveal.tempPassword && (
                    <div className="flex items-center justify-between gap-2 rounded-md bg-white dark:bg-slate-900 border px-3 py-2">
                      <span className="text-xs text-slate-500">Temporary password</span>
                      <code className="font-mono text-sm font-bold text-slate-800 dark:text-slate-100 select-all">{reveal.tempPassword}</code>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setConfirm(null); setReason(""); setReveal(null) }} disabled={busy}>Close</Button>
            <Button
              disabled={busy || !!reveal}
              className={confirm?.kind === "suspend" ? "bg-amber-600 hover:bg-amber-700 text-white" : confirm?.kind === "activate" ? "" : "bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-900"}
              onClick={async () => {
                if (!confirm) return
                if (confirm.kind === "suspend") {
                  await act(() => rpc("employees.suspend", { id: confirm.row.id, reason: reason || undefined }), "Employee suspended")
                } else if (confirm.kind === "activate") {
                  await act(() => rpc("employees.activate", { id: confirm.row.id, reason: reason || undefined }), "Employee activated")
                } else if (confirm.kind === "reset") {
                  setBusy(true)
                  try {
                    const res = await rpc<any>("employees.resetPassword", { employeeId: confirm.row.id })
                    setReveal({ email: res.email, tempPassword: res.tempPassword, emailStatus: res.emailStatus, smsStatus: res.smsStatus, note: res.note })
                    toast("Login password reset")
                    onDone()
                  } catch (e: any) { toast(e.message, "err") } finally { setBusy(false) }
                } else if (confirm.kind === "account") {
                  setBusy(true)
                  try {
                    const res = await rpc<any>("employees.provisionAccount", { employeeId: confirm.row.id })
                    setReveal({ email: res.email, tempPassword: res.tempPassword, emailStatus: res.emailStatus, smsStatus: res.smsStatus, note: res.tempPassword ? "No delivery channel is enabled — copy the temporary password now and share it securely; it will not be shown again." : "Login account created — credentials delivered through the enabled channels." })
                    toast("Login account created")
                    onDone()
                  } catch (e: any) { toast(e.message, "err") } finally { setBusy(false) }
                }
              }}>
              {busy ? "Working…" : confirm?.kind === "suspend" ? "Suspend" : confirm?.kind === "activate" ? "Activate" : confirm?.kind === "reset" ? "Reset Password" : "Create Account"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- change shift ---- */}
      {shiftOpen && (
        <FormDialog
          open={shiftOpen}
          onOpenChange={setShiftOpen}
          title={`Change Shift — ${row.fullName}`}
          description={`Current shift: ${row.shiftName || "—"}. The change is effective immediately, recorded in the shift assignments and the employee timeline.`}
          fields={[
            { name: "shiftId", label: "New shift", type: "select", required: true, options: (lookups?.shifts || []).map((s: any) => ({ value: s.id, label: `${s.name} (${s.startTime}–${s.endTime})` })) },
            { name: "note", label: "Note (optional)", type: "textarea", rows: 2, placeholder: "e.g. moved to evening shift for the new project" },
          ]}
          submitLabel="Change Shift"
          onSubmit={async (v) => { await rpc("employees.changeShift", { employeeId: row.id, shiftId: v.shiftId, note: v.note || undefined }); onDone() }}
        />
      )}

      {/* ---- attendance history ---- */}
      {attOpen && <AttendanceHistoryDialog employee={row} onClose={() => setAttOpen(false)} />}

      {/* ---- archive / hard delete (moved from the standalone row button) ---- */}
      <Dialog open={deleteOpen} onOpenChange={(v) => { if (!v) { setDeleteOpen(false); setDeleteMode("soft"); setDeleteConfirmText("") } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              <Trash2 className="h-4 w-4 text-rose-600" /> Delete Employee
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 px-3 py-2">
              <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{row.fullName}</p>
              <p className="text-[11px] text-slate-500">{row.code} · {row.designationName || "—"} · {row.branchName || "—"}</p>
            </div>
            <div className="space-y-2">
              <label className="flex items-start gap-2 cursor-pointer">
                <input type="radio" name="delMode" checked={deleteMode === "soft"} onChange={() => setDeleteMode("soft")} className="mt-0.5 accent-emerald-600" />
                <div>
                  <p className="text-sm font-medium text-slate-700 dark:text-slate-200">Archive (soft delete) — recommended</p>
                  <p className="text-[11px] text-slate-500">Marks the employee INACTIVE. They disappear from the directory but historical attendance, payroll, and audit records stay intact. Can be reversed by setting status back to ACTIVE.</p>
                </div>
              </label>
              {canPurge && (
                <label className="flex items-start gap-2 cursor-pointer">
                  <input type="radio" name="delMode" checked={deleteMode === "hard"} onChange={() => setDeleteMode("hard")} className="mt-0.5 accent-rose-600" />
                  <div>
                    <p className="text-sm font-medium text-rose-700 dark:text-rose-400">Permanently delete (hard delete)</p>
                    <p className="text-[11px] text-slate-500">Irreversible. Removes the employee AND ALL related records: attendance, payroll, leave, loans, documents, history. Requires the <span className="font-mono">employees.purge</span> permission (separate from archive). Use ONLY for dummy / test data.</p>
                  </div>
                </label>
              )}
            </div>
            {deleteMode === "hard" && (
              <div className="space-y-1.5">
                <div className="rounded-md bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900 px-3 py-2 text-[11px] text-rose-700 dark:text-rose-300">
                  ⚠ This cannot be undone. All attendance, payroll, leave, loan, and document records for this employee will be permanently deleted.
                </div>
                <label className="block text-xs font-medium text-rose-700 dark:text-rose-400">
                  Type the employee code <span className="font-bold">{row.code}</span> to confirm
                </label>
                <Input value={deleteConfirmText} onChange={(e) => setDeleteConfirmText(e.target.value)}
                  placeholder={row.code} autoComplete="off" className="font-mono"
                  aria-label={`Type ${row.code} to confirm permanent deletion`} />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setDeleteOpen(false); setDeleteMode("soft"); setDeleteConfirmText("") }} disabled={busy}>Cancel</Button>
            <Button
              disabled={busy || (deleteMode === "hard" && deleteConfirmText !== row.code)}
              className={deleteMode === "hard" ? "bg-rose-600 hover:bg-rose-700 text-white" : "bg-amber-600 hover:bg-amber-700 text-white"}
              onClick={async () => {
                setBusy(true)
                try {
                  if (deleteMode === "hard") {
                    const r = await rpc<{ deleted: boolean; name: string; code: string }>("employees.hardDelete", { id: row.id, confirm: deleteConfirmText })
                    toast(`Permanently deleted ${r.name} (${r.code}) and all related records`)
                  } else {
                    await rpc("employees.delete", { id: row.id })
                    toast(`${row.fullName} archived (INACTIVE)`)
                  }
                  setDeleteOpen(false)
                  setDeleteMode("soft")
                  setDeleteConfirmText("")
                  onDone()
                } catch (e: any) {
                  toast(e.message, "err")
                } finally { setBusy(false) }
              }}>
              {busy ? "Deleting…" : deleteMode === "hard" ? "Permanently Delete" : "Archive Employee"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- Terminate Employee Exit Dialog ---- */}
      {terminateOpen && (
        <TerminateEmployeeDialog
          open={terminateOpen}
          onOpenChange={setTerminateOpen}
          employee={row}
          onDone={() => {
            setTerminateOpen(false)
            onDone()
          }}
        />
      )}

      {/* ---- Retire Employee Exit Dialog ---- */}
      {retireOpen && (
        <RetireEmployeeDialog
          open={retireOpen}
          onOpenChange={setRetireOpen}
          employee={row}
          onDone={() => {
            setRetireOpen(false)
            onDone()
          }}
        />
      )}
    </>
  )
}

// ---- §17 — employee attendance history dialog -----------------------------
// Date-range + status + source filters over the existing Attendance
// daily-summary rows (employees.attendanceHistory RPC). Reuses the same
// records the attendance module writes — no duplicated calculation logic.
const ATT_STATUS_FILTERS = ["PRESENT", "ABSENT", "LATE", "EARLY_LEAVE", "HALF_DAY", "LEAVE", "HOLIDAY", "WEEKLY_OFF", "WFH", "BUSINESS_TRIP"]
const ATT_SOURCE_FILTERS = ["MANUAL", "BIOMETRIC", "GEOFENCE", "WEB", "IMPORT"]
const ATT_TONE: Record<string, string> = {
  PRESENT: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  LATE: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  ABSENT: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  LEAVE: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  HOLIDAY: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  WEEKLY_OFF: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
}
function AttendanceHistoryDialog({ employee, onClose }: { employee: any; onClose: () => void }) {
  const today = todayDhaka()
  const monthStart = today.slice(0, 8) + "01"
  const [from, setFrom] = useState(monthStart)
  const [to, setTo] = useState(today)
  const [statuses, setStatuses] = useState<string[]>([])
  const [sources, setSources] = useState<string[]>([])
  // the project's data hook handles loading/error/abort + refetch on payload
  // change (dates and filters are part of the payload — no manual effect)
  const { data, loading, error } = useApi<any>("employees.attendanceHistory", {
    employeeId: employee.id, from, to, statuses, sources,
  })

  const toggle = (list: string[], setList: (v: string[]) => void, v: string) =>
    setList(list.includes(v) ? list.filter((x) => x !== v) : [...list, v])

  const summary = (data?.summary || {}) as Record<string, number>
  const records: any[] = data?.records || []

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="sm:max-w-3xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            <CalendarRange className="h-4 w-4" /> Attendance History — {employee.fullName}
          </DialogTitle>
        </DialogHeader>
        {/* date range — filters refetch automatically */}
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label className="text-xs text-slate-500">From</Label>
            <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="h-8 w-[140px] text-xs" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-slate-500">To</Label>
            <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="h-8 w-[140px] text-xs" />
          </div>
          {loading && <span className="text-[11px] text-slate-400 pb-1.5">loading…</span>}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {ATT_STATUS_FILTERS.map((s) => (
            <button key={s} type="button" onClick={() => toggle(statuses, setStatuses, s)}
              className={`h-6 rounded-full px-2.5 text-[11px] font-medium border transition-colors ${statuses.includes(s) ? "bg-slate-800 text-white border-slate-800 dark:bg-slate-200 dark:text-slate-900" : "bg-white dark:bg-slate-900 text-slate-500 border-slate-200 dark:border-slate-700 hover:border-slate-400"}`}>
              {titleCase(s)}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {ATT_SOURCE_FILTERS.map((s) => (
            <button key={s} type="button" onClick={() => toggle(sources, setSources, s)}
              className={`h-6 rounded-full px-2.5 text-[11px] font-medium border transition-colors ${sources.includes(s) ? "bg-primary text-primary-foreground border-primary" : "bg-white dark:bg-slate-900 text-slate-500 border-slate-200 dark:border-slate-700 hover:border-emerald-400"}`}>
              {titleCase(s)}
            </button>
          ))}
        </div>
        {/* summary chips */}
        <div className="flex flex-wrap gap-1.5 text-[11px]">
          {Object.entries(summary).map(([k, v]) => (
            <span key={k} className={`rounded-full px-2.5 py-0.5 font-medium ${ATT_TONE[k] || "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"}`}>
              {titleCase(k)}: <b>{v as number}</b>
            </span>
          ))}
          {data && <span className="text-slate-400">{data.total} record(s) in range</span>}
        </div>
        {error && <div className="rounded-lg border border-rose-200 bg-rose-50 dark:bg-rose-950 p-3 text-sm text-rose-700 dark:text-rose-300">{error}</div>}
        {/* records */}
        {loading ? (
          <div className="py-8 text-center text-xs text-slate-400">Loading attendance…</div>
        ) : records.length === 0 ? (
          <div className="py-8 text-center text-xs text-slate-400">No attendance records in this range.</div>
        ) : (
          <div className="rounded-lg border overflow-hidden max-h-[46dvh] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 dark:bg-slate-800 sticky top-0">
                <tr>
                  {["Date", "Status", "Check in", "Check out", "Worked", "Late", "OT", "Source", "Device"].map((h) => (
                    <th key={h} className="px-2.5 py-2 text-left font-semibold text-slate-500 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {records.map((r: any) => (
                  <tr key={r.id} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="px-2.5 py-1.5 whitespace-nowrap">{fmtDate(r.date)}</td>
                    <td className="px-2.5 py-1.5"><span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${ATT_TONE[r.status] || "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"}`}>{titleCase(r.status)}</span></td>
                    <td className="px-2.5 py-1.5 tabular-nums">{r.checkIn || "—"}</td>
                    <td className="px-2.5 py-1.5 tabular-nums">{r.checkOut || "—"}</td>
                    <td className="px-2.5 py-1.5 tabular-nums">{r.workedMinutes ? `${Math.floor(r.workedMinutes / 60)}h ${r.workedMinutes % 60}m` : "—"}</td>
                    <td className="px-2.5 py-1.5 tabular-nums">{r.lateMinutes ? `${r.lateMinutes}m` : "—"}</td>
                    <td className="px-2.5 py-1.5 tabular-nums">{r.otMinutes ? `${r.otMinutes}m` : "—"}</td>
                    <td className="px-2.5 py-1.5">{titleCase(r.source || "—")}</td>
                    <td className="px-2.5 py-1.5 max-w-[140px] truncate" title={r.deviceInfo || ""}>{r.deviceInfo || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

const EMPLOYMENT_TYPES = ["PERMANENT", "PROBATIONARY", "CONTRACTUAL", "TEMPORARY", "PART_TIME", "INTERN", "COMMISSION", "FREELANCE"]
const GENDERS = ["Male", "Female", "Other"]
// Major Bangladeshi banks for the Salary & Payout section (2026-10 round §46)

// ============================================================
// R1 — Bulk Employee Import (Excel only; 2026-10 single-sheet round)
// - ONE worksheet only ("Employees"): no separate Instructions/Lists sheets.
//   Concise guidance lives ON the sheet itself:
//     • a styled header row (emerald fill, bold white)
//     • colorful cell comments (mouse-over notes) on every header
//     • a short legend row above the header
// - .xlsx template WITHOUT an Employee Code column (codes are always
//   system-generated server-side, chronologically sequential)
// - Excel dropdown (data validation) lists are INLINE (literal lists inside
//   the same sheet) built from the tenant's CURRENT master data — no
//   cross-sheet references (older Excel builds silently strip those, which
//   together with the misplaced dataValidations block caused the "we found a
//   problem with some content" repair prompt on open — fixed below)
// - CSV template removed; file selection accepts .xlsx only
// ============================================================
const IMPORT_TEMPLATE_HEADERS = [
  "Full Name", "Email", "Mobile", "Branch", "Department", "Designation",
  "Shift", "Joining Date", "Employment Type", "Gender", "Date of Birth", "Present Address", "Permanent Address",
]
// Column letters of the dropdown-backed headers (A = 0 … M = 12)
const IMPORT_COL = { branch: "D", department: "E", designation: "F", shift: "G", employmentType: "I", gender: "J" } as const
// data rows covered by the dropdowns — matches the 500-row import cap
const IMPORT_DROPDOWN_LAST_ROW = 501
const IMPORT_TEMPLATE_DEMO_ROWS: (string | null)[][] = [
  ["Rahim Miah", "rahim.miah@example.com", "+880 1711-000001", null, null, null, null, "2026-01-05", "PERMANENT", "Male", "1995-03-12", "House 12, Road 4, Dhanmondi, Dhaka", "Vill: Baralekha, Dist: Moulvibazar"],
  ["Nusrat Jahan", "nusrat.jahan@example.com", "+880 1711-000002", null, null, null, null, "2026-02-01", "PROBATIONARY", "Female", "1998-07-25", "Flat B-6, Mirpur 10, Dhaka", "Vill: Kotwali, Dist: Chittagong"],
]
// Column widths tuned to the header + typical content
const IMPORT_COL_WIDTHS = [22, 28, 18, 18, 18, 20, 22, 13, 15, 9, 13, 34, 34]

/** Concise per-column guidance rendered as COLORFUL cell notes on the header
 *  row (hover a header cell in Excel to see it). Everything a user needs to
 *  fill the sheet correctly, without a separate instructions sheet. */
function importHeaderNote(header: string, lists: Record<string, string[]>): string {
  const L = (key: string) => lists[key] || []
  switch (header) {
    case "Full Name":
      return "REQUIRED — one employee per row starting at row 3 (keep the header and legend rows unchanged).\nEmployee Code is NOT in this file — the system generates it sequentially after import."
    case "Email":
      return "Optional — the official email doubles as the self-service login. An account is created automatically and the temporary password is delivered through the configured channels.\nDuplicate emails/mobiles (vs existing employees) are skipped, never duplicated."
    case "Mobile":
      return "Optional — e.g. +880 1711-000001. Used as a duplicate check and for SMS delivery."
    case "Branch":
      return `Optional — pick from the dropdown (your current Branch records).${L("branch").length ? `\nAllowed: ${L("branch").slice(0, 12).join(", ")}${L("branch").length > 12 ? " …" : ""}` : "\nNo branches configured yet — leave blank or add them under Settings → Organization first."}\nTyped names that do not exactly match fail row validation with a clear error.`
    case "Department":
      return `Optional — pick from the dropdown (your current Department records).${L("department").length ? `\nAllowed: ${L("department").slice(0, 12).join(", ")}${L("department").length > 12 ? " …" : ""}` : ""}`
    case "Designation":
      return `Optional — pick from the dropdown (your current Designation records).${L("designation").length ? `\nAllowed: ${L("designation").slice(0, 12).join(", ")}${L("designation").length > 12 ? " …" : ""}` : ""}`
    case "Shift":
      return `Optional — pick from the dropdown (your current Shift records).${L("shift").length ? `\nAllowed: ${L("shift").slice(0, 12).join(", ")}${L("shift").length > 12 ? " …" : ""}` : "\nNo shifts configured — leave blank for auto-detection."}`
    case "Joining Date":
      return "Optional — ISO format YYYY-MM-DD (e.g. 2026-01-05). Cannot be in the future."
    case "Employment Type":
      return `Optional — pick from the dropdown; blank = PERMANENT.\nAllowed: ${EMPLOYMENT_TYPES.join(", ")}.`
    case "Gender":
      return "Optional — pick from the dropdown: Male / Female / Other."
    case "Date of Birth":
      return "Optional — ISO format YYYY-MM-DD (e.g. 1995-03-12)."
    case "Present Address":
    case "Permanent Address":
      return "Optional — free text."
    default:
      return "Hover the other header cells for per-column guidance."
  }
}

/**
 * Build the single-sheet import template:
 *  1. SheetJS writes the sheet with header comments (cell.c → xl/comments1.xml
 *     + a colorful VML note shape) and column widths.
 *  2. The generated zip is post-processed (fflate) to add what SheetJS CE
 *     cannot write:
 *       a. a bold-white-on-emerald HEADER STYLE (new font/fill/xf appended to
 *          xl/styles.xml, referenced via s="…" on the header cells)
 *       b. INLINE-LIST data validations (dropdowns) — inserted immediately
 *          after </sheetData>, the FIRST position the OOXML CT_Worksheet
 *          sequence allows them to appear. (The previous generator appended
 *          them at </worksheet> — AFTER ignoredErrors/legacyDrawing — which
 *          violates the schema order and makes Excel show the
 *          "We found a problem with some content" repair dialog.)
 */
async function buildImportTemplate(lists: Record<string, string[]>): Promise<Uint8Array> {
  const mod: any = await import("xlsx")
  const XLSX = mod.default || mod
  // Row 1 = concise legend banner · Row 2 = styled header · Rows 3-4 = demo data
  const sheetRows: (string | null)[][] = [
    ["BULK EMPLOYEE IMPORT — only Full Name is required · dates = YYYY-MM-DD · hover header cells for guidance · codes are auto-generated"],
    [...IMPORT_TEMPLATE_HEADERS],
    ...IMPORT_TEMPLATE_DEMO_ROWS,
  ]
  const ws = XLSX.utils.aoa_to_sheet(sheetRows)
  ws["!cols"] = IMPORT_COL_WIDTHS.map((wch) => ({ wch }))
  // colorful comments on every header cell (row 2)
  IMPORT_TEMPLATE_HEADERS.forEach((h, i) => {
    const cell = ws[XLSX.utils.encode_cell({ r: 1, c: i })]
    if (cell) cell.c = [{ a: "Finix HR", t: importHeaderNote(h, lists) }]
  })
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, "Employees")
  const raw = new Uint8Array(XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer)

  // ---- post-zip patching (fflate) ----
  const { unzipSync, zipSync, strToU8, strFromU8 } = await import("fflate")
  const files = unzipSync(raw)
  const sheetPath = "xl/worksheets/sheet1.xml" // Employees is the ONLY sheet
  let xml = strFromU8(files[sheetPath])
  let styles = strFromU8(files["xl/styles.xml"])

  // (a) header style — bold white 11pt on emerald, centered, wrapped
  // (no non-null assertions — a malformed styles.xml falls back to no styling)
  const countOf = (tag: string): number => Number((styles.match(new RegExp(`<${tag} count="(\\d+)">`)) || [])[1] || 0)
  const nFills = countOf("fills")
  const nFonts = countOf("fonts")
  const nXfs = countOf("cellXfs")
  let headerStyle = -1
  if (nFills > 0 && nFonts > 0 && nXfs > 0) {
    styles = styles
      .replace(new RegExp(`<fills count="${nFills}">`), `<fills count="${nFills + 1}">`)
      .replace(/<\/fills>/, `<fill><patternFill patternType="solid"><fgColor rgb="FF0F766E"/><bgColor indexed="64"/></patternFill></fill></fills>`)
      .replace(new RegExp(`<fonts count="${nFonts}">`), `<fonts count="${nFonts + 1}">`)
      .replace(/<\/fonts>/, `<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font></fonts>`)
      .replace(new RegExp(`<cellXfs count="${nXfs}">`), `<cellXfs count="${nXfs + 1}">`)
      .replace(/<\/cellXfs>/, `<xf numFmtId="0" fontId="${nFonts}" fillId="${nFills}" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf></cellXfs>`)
    headerStyle = nXfs
  }

  // header cells: apply the emerald header style when it was created above
  if (headerStyle >= 0) {
    for (let i = 0; i < IMPORT_TEMPLATE_HEADERS.length; i++) {
      const ref = XLSX.utils.encode_cell({ r: 1, c: i })
      xml = xml.replace(`<c r="${ref}"`, `<c r="${ref}" s="${headerStyle}"`)
    }
  }

  // (b) inline-list data validations — Excel caps the literal list at 255
  // chars; longer master lists fall back to the note-only guidance (the
  // server still validates loudly), so the file NEVER becomes invalid.
  // XML-escape each entry (& < > would break the worksheet markup — e.g. a
  // department literally called "Finance & Accounts"); double quotes inside
  // an entry become doubled quotes per Excel's list syntax.
  const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  const inlineList = (values: string[]) => `"${values.map((v) => xmlEsc(String(v).replace(/"/g, "''"))).join(",")}"`
  const dvSpecs: { col: string; values: string[] }[] = [
    { col: IMPORT_COL.branch, values: lists.branch || [] },
    { col: IMPORT_COL.department, values: lists.department || [] },
    { col: IMPORT_COL.designation, values: lists.designation || [] },
    { col: IMPORT_COL.shift, values: lists.shift || [] },
    { col: IMPORT_COL.employmentType, values: [...EMPLOYMENT_TYPES] },
    { col: IMPORT_COL.gender, values: [...GENDERS] },
  ]
  const validations = dvSpecs
    .filter((d) => d.values.length > 0 && inlineList(d.values).length <= 255)
    .map((d) =>
      `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="${d.col}3:${d.col}${IMPORT_DROPDOWN_LAST_ROW}">` +
      `<formula1>${inlineList(d.values)}</formula1></dataValidation>`)
  if (validations.length > 0) {
    const dv = `<dataValidations count="${validations.length}">${validations.join("")}</dataValidations>`
    // OOXML CT_Worksheet element order: dataValidations must come AFTER
    // sheetData/mergeCells and BEFORE hyperlinks/printOptions/pageMargins/
    // ignoredErrors/legacyDrawing. SheetJS emits sheetData → ignoredErrors →
    // legacyDrawing(comments) — so the ONLY safe insert point is directly
    // after </sheetData>.
    xml = xml.replace("</sheetData>", "</sheetData>" + dv)
  }

  const out: Record<string, Uint8Array> = {
    ...files,
    "xl/styles.xml": strToU8(styles),
    [sheetPath]: strToU8(xml),
  }
  return zipSync(out, { level: 6 })
}

type ImportSummary = {
  totalRows: number
  imported: number
  failed: number
  accountsCreated: number
  duplicateUsers: number
  missingEmailAccounts: number
  invalidMasterData: number
  credentialsQueued: number
  deliveryJobId: string | null
  communicationStatus: string
}

function BulkImportDialog({ open, onOpenChange, lookups }: { open: boolean; onOpenChange: (v: boolean) => void; lookups: any }) {
  const toast = useHrm((s) => s.toast)
  const [rows, setRows] = useState<Record<string, any>[] | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ created: number; total: number; dryRun?: boolean; results: { row: number; status: string; detail: string }[]; summary?: ImportSummary } | null>(null)

  useEffect(() => {
    if (open) { setRows(null); setFileName(null); setParseError(null); setResult(null); setBusy(false) }
  }, [open])

  /** M-29 — lazily resolve the ~400 KB xlsx chunk (only when the wizard is
   *  actually used; the old top-level import shipped it with every directory
   *  page load). Same ESM/CJS interop as the holidays tab. */
  const loadXlsx = async () => {
    const mod: any = await import("xlsx")
    return mod.default || mod
  }

  /** Template download — ONE "Employees" worksheet with a styled header row,
   *  colorful mouse-over guidance notes on every column, and inline dropdown
   *  lists built from the tenant's CURRENT master records. No separate
   *  instruction/dropdown sheets (single-sheet requirement); the generated
   *  XML is schema-ordered so Excel opens it without any repair prompt. */
  const downloadExcelTemplate = async () => {
    const lists = {
      branch: (lookups?.branches || []).map((b: any) => b.name).filter(Boolean),
      department: (lookups?.departments || []).map((d: any) => d.name).filter(Boolean),
      designation: (lookups?.designations || []).map((d: any) => d.name).filter(Boolean),
      shift: (lookups?.shifts || []).map((s: any) => s.name).filter(Boolean),
    }
    const bytes = await buildImportTemplate(lists)
    const blob = new Blob([bytes as unknown as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })
    const a = document.createElement("a")
    a.href = URL.createObjectURL(blob)
    a.download = "employee-import-template.xlsx"
    a.click()
    URL.revokeObjectURL(a.href)
    toast("Template downloaded — single sheet with dropdowns and hover guidance on every column")
  }

  /** Parse the uploaded .xlsx into row objects (dates → ISO strings).
   *  Excel-only import (2026-10): the CSV template was removed and the file
   *  picker only accepts .xlsx; a chosen CSV is rejected with a clear hint. */
  const onFile = async (f: File | null) => {
    if (!f) { setRows(null); setFileName(null); return }
    setParseError(null)
    setResult(null)
    try {
      const name = f.name.toLowerCase()
      if (!name.endsWith(".xlsx")) {
        throw new Error("Only .xlsx files are supported — download the Excel template, fill it in and upload it back")
      }
      const buf = await f.arrayBuffer()
      const XLSX = await loadXlsx()
      const wb = XLSX.read(buf, { cellDates: true })
      // single-sheet template; still tolerate the legacy 3-sheet template
      const sheet = wb.Sheets[wb.SheetNames.find((n: string) => n.toLowerCase() !== "instructions" && n.toLowerCase() !== "lists") || wb.SheetNames[0]]
      if (!sheet) throw new Error("The file has no data sheet")
      // The template's row 1 is a legend banner — headers live on row 2.
      // sheet_to_json(range: 1) starts reading AT row 2, so row 2 becomes the
      // header row. Legacy files (no legend) are detected: if row 1 already
      // looks like the header, read from the top instead.
      const firstRowAddr = sheet["!ref"] ? sheet["!ref"].split(":")[0] : "A1"
      const firstRowNum = Number((firstRowAddr.match(/\d+/) || ["1"])[0])
      const a1 = sheet["A1"]
      const a1Text = a1 ? String(a1.w ?? a1.v ?? "") : ""
      const hasLegend = a1Text.toUpperCase().includes("BULK EMPLOYEE IMPORT")
      const json: Record<string, any>[] = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: true, range: hasLegend ? 1 : firstRowNum - 1 })
      if (!json.length) throw new Error("No data rows found below the header")
      if (json.length > 500) throw new Error(`Too many rows (${json.length}) — the import limit is 500 per batch`)
      // Excel date cells arrive as Date objects (cellDates) — normalize to ISO.
      // String dates pass through; the server validates the format.
      const normalized = json.map((row) => {
        const out: Record<string, any> = {}
        for (const [k, v] of Object.entries(row)) {
          if (v instanceof Date && !isNaN(v.getTime())) out[k] = v.toISOString().slice(0, 10)
          else out[k] = v
        }
        return out
      })
      setRows(normalized)
      setFileName(f.name)
    } catch (e: any) {
      setRows(null)
      setFileName(null)
      setParseError(e?.message || "Could not read the file")
    }
  }

  const runImport = async (dryRun: boolean) => {
    if (!rows?.length) return
    setBusy(true)
    setResult(null)
    try {
      const res = await rpc<{ created: number; total: number; dryRun?: boolean; results: { row: number; status: string; detail: string }[]; summary?: ImportSummary }>(
        "employees.bulkImport", { rows, dryRun })
      setResult(res)
      if (!dryRun) toast(`Import finished — ${res.created} of ${res.total} row(s) created${res.summary?.accountsCreated ? `, ${res.summary.accountsCreated} login account(s) created` : ""}`)
    } catch (e: any) {
      setParseError(e?.message || "Import failed")
    } finally {
      setBusy(false)
    }
  }

  const statusIcon = (s: string) =>
    s === "CREATED" ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
      : s === "SKIPPED" ? <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
        : <XCircle className="h-3.5 w-3.5 text-rose-600" />

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v) }}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <FileUp className="h-4 w-4 text-emerald-600" /> Bulk Import Employees
          </DialogTitle>
          <p className="text-xs text-slate-500">
            Upload the filled Excel (.xlsx) template — one sheet with dropdown lists and hover guidance on every
            column. Everything is validated server-side and audit-logged; imported employees get sequential codes
            and login accounts (when an email is provided).
          </p>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* step 1 — template */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3.5 space-y-2.5">
            <p className="text-xs font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 text-[10px] font-bold">1</span>
              Download the demo template
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" className="h-8 text-xs bg-white dark:bg-slate-900" onClick={downloadExcelTemplate} disabled={busy}>
                <FileSpreadsheet className="h-3.5 w-3.5 mr-1 text-emerald-600" /> Excel template (.xlsx — with dropdowns)
              </Button>
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              One worksheet, {IMPORT_TEMPLATE_HEADERS.length} columns. Only <b>Full Name</b> is required. Employee Code is
              generated automatically (chronologically sequential) — it is deliberately not part of the template.
              Hover each header cell in Excel for per-column guidance; Branch / Department / Designation / Shift /
              Employment Type / Gender columns have dropdown lists built from your current organization records.
            </p>
          </div>

          {/* step 2 — upload */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3.5 space-y-2.5">
            <p className="text-xs font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 text-[10px] font-bold">2</span>
              Upload your filled file
            </p>
            <input
              type="file"
              accept=".xlsx"
              className="block w-full text-xs text-slate-500 dark:text-slate-400
                file:mr-3 file:rounded-md file:border-0 file:bg-emerald-50 dark:file:bg-emerald-950
                file:px-3 file:py-2 file:text-xs file:font-medium file:text-emerald-700 dark:file:text-emerald-300
                hover:file:bg-emerald-100 dark:hover:file:bg-emerald-900"
              onChange={(e) => onFile(e.target.files?.[0] || null)}
            />
            {fileName && rows && (
              <div className="rounded-lg bg-emerald-50 dark:bg-emerald-950/40 px-3 py-2 text-[11px] text-emerald-700 dark:text-emerald-300">
                <b>{fileName}</b> — {rows.length} row(s) parsed and ready.
              </div>
            )}
            {parseError && (
              <p className="rounded-md bg-rose-50 dark:bg-rose-950/50 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">{parseError}</p>
            )}
          </div>

          {/* preview */}
          {rows && rows.length > 0 && !result && (
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3.5 space-y-2">
              <p className="text-xs font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 text-[10px] font-bold">3</span>
                Preview — first {Math.min(5, rows.length)} of {rows.length} row(s)
              </p>
              <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
                <table className="w-full text-[11px]">
                  <thead className="bg-slate-50 dark:bg-slate-800/60">
                    <tr>
                      {["Full Name", "Email", "Mobile", "Branch", "Department", "Designation", "Joining Date"].map((h) => (
                        <th key={h} className="px-2 py-1.5 text-left font-semibold text-slate-600 dark:text-slate-300 whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 5).map((r, i) => {
                      const get = (...keys: string[]) => { for (const k of keys) { const v = r[k]; if (v != null && v !== "") return String(v) } return "—" }
                      return (
                        <tr key={i} className="border-t border-slate-100 dark:border-slate-800">
                          <td className="px-2 py-1.5 font-medium text-slate-700 dark:text-slate-200">{get("Full Name", "fullName")}</td>
                          <td className="px-2 py-1.5 text-slate-500">{get("Email", "Official Email", "officialEmail")}</td>
                          <td className="px-2 py-1.5 text-slate-500">{get("Mobile", "mobile")}</td>
                          <td className="px-2 py-1.5 text-slate-500">{get("Branch", "branch")}</td>
                          <td className="px-2 py-1.5 text-slate-500">{get("Department", "department")}</td>
                          <td className="px-2 py-1.5 text-slate-500">{get("Designation", "designation")}</td>
                          <td className="px-2 py-1.5 text-slate-500 tabular-nums">{get("Joining Date", "joiningDate")}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                <Button size="sm" variant="outline" className="h-8 text-xs bg-white dark:bg-slate-900" disabled={busy} onClick={() => runImport(true)}>
                  {busy ? "Validating…" : "Validate only (no changes)"}
                </Button>
                <Button size="sm" className="h-8 text-xs " disabled={busy} onClick={() => runImport(false)}>
                  {busy ? "Importing…" : `Import ${rows.length} row(s)`}
                </Button>
              </div>
            </div>
          )}

          {/* results */}
          {result && (
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3.5 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                  {result.dryRun ? "Validation report (dry run — nothing was written)" : "Import report"}
                </p>
                <div className="flex flex-wrap gap-1.5 text-[11px]">
                  <Badge className="bg-emerald-100 text-emerald-700">{result.dryRun ? "would create" : "created"}: {result.created}</Badge>
                  <Badge className="bg-amber-100 text-amber-700">skipped: {result.results.filter((r) => r.status === "SKIPPED").length}</Badge>
                  <Badge className="bg-rose-100 text-rose-700">errors: {result.results.filter((r) => r.status === "ERROR").length}</Badge>
                </div>
              </div>
              <div className="max-h-56 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800">
                {result.results.map((r) => (
                  <div key={r.row} className="flex items-start gap-2 px-3 py-1.5 text-[11px]">
                    <span className="w-14 shrink-0 text-slate-400 tabular-nums">row {r.row}</span>
                    {statusIcon(r.status)}
                    <span className={
                      r.status === "CREATED" ? "text-emerald-700 dark:text-emerald-400 font-medium"
                        : r.status === "SKIPPED" ? "text-amber-600 dark:text-amber-400"
                          : "text-rose-600 dark:text-rose-400"
                    }>{r.detail}</span>
                  </div>
                ))}
              </div>
              {/* 2026-10 §12 — import summary: accounts, duplicates, master
                  data errors, credential delivery queue status */}
              {!result.dryRun && result.summary && (
                <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-2">Import summary</p>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
                    <span className="flex flex-col"><b className="text-slate-700 dark:text-slate-100 text-sm">{result.summary.imported}</b>Total imported</span>
                    <span className="flex flex-col"><b className="text-rose-600 text-sm">{result.summary.failed}</b>Failed rows</span>
                    <span className="flex flex-col"><b className="text-emerald-700 dark:text-emerald-300 text-sm">{result.summary.accountsCreated}</b>Login accounts created</span>
                    <span className="flex flex-col"><b className="text-slate-700 dark:text-slate-100 text-sm">{result.summary.duplicateUsers}</b>Duplicate users</span>
                    <span className="flex flex-col"><b className="text-slate-700 dark:text-slate-100 text-sm">{result.summary.missingEmailAccounts}</b>No email (no account)</span>
                    <span className="flex flex-col"><b className="text-rose-600 text-sm">{result.summary.invalidMasterData}</b>Invalid master data</span>
                    <span className="flex flex-col"><b className="text-slate-700 dark:text-slate-100 text-sm">{result.summary.credentialsQueued}</b>Credentials queued</span>
                    <span className="flex flex-col"><b className="text-slate-700 dark:text-slate-100 text-sm">{result.summary.communicationStatus === "QUEUED" ? "Queued (background job)" : "Not queued"}</b>Credential delivery</span>
                  </div>
                  {result.summary.credentialsQueued > 0 && (
                    <p className="mt-2 text-[11px] text-slate-500 leading-relaxed">
                      Temporary login passwords are being delivered in the background through the channels enabled in
                      Settings → Communication (Email/SMS). Each employee must change the temporary password at first
                      sign-in. Delivery outcomes appear per employee in the Communication log.
                    </p>
                  )}
                </div>
              )}
              {!result.dryRun && result.created > 0 && (
                <p className="text-[11px] text-slate-500">The directory has been refreshed — new employees are visible below.</p>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------- Create employee is imported from ./employee-create-dialog ----------

function calculateTenure(joiningDate?: string | null): string {
  if (!joiningDate) return "—"
  const start = new Date(joiningDate)
  if (isNaN(start.getTime())) return "—"
  const now = new Date()
  let years = now.getFullYear() - start.getFullYear()
  let months = now.getMonth() - start.getMonth()
  if (months < 0) {
    years--
    months += 12
  }
  if (years <= 0 && months <= 0) return "New joiner"
  const parts: string[] = []
  if (years > 0) parts.push(`${years} ${years === 1 ? "yr" : "yrs"}`)
  if (months > 0) parts.push(`${months} ${months === 1 ? "mo" : "mos"}`)
  return parts.join(" ") || "1 mo"
}

function calculateAge(dob?: string | null): string | null {
  if (!dob) return null
  const birth = new Date(dob)
  if (isNaN(birth.getTime())) return null
  const now = new Date()
  let age = now.getFullYear() - birth.getFullYear()
  const m = now.getMonth() - birth.getMonth()
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--
  return age > 0 ? `${age} yrs` : null
}

function CopyBadge({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = (e: React.MouseEvent) => {
    e.stopPropagation()
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button
      type="button"
      onClick={copy}
      title={`Copy ${label || text}`}
      className="inline-flex items-center gap-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors p-0.5 rounded cursor-pointer"
    >
      {copied ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
    </button>
  )
}

// Context & Compliance banner rendered directly below SectionTabs Level-2 chips (at the red line position)
function ProfileTabContextBanner({
  icon: Icon,
  title,
  description,
  audits,
}: {
  icon: any
  title: string
  description: string
  audits?: Array<{
    tone: "rose" | "amber" | "emerald" | "slate"
    text: string
    subtext?: string
    icon?: any
  }>
}) {
  return (
    <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-900/50 p-3 sm:px-4 sm:py-3 shadow-2xs transition-all">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        {/* Left: Icon + Title + Description */}
        <div className="flex items-start sm:items-center gap-3 min-w-0">
          <div className="h-8 w-8 rounded-lg bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20 flex items-center justify-center shrink-0 mt-0.5 sm:mt-0">
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h4 className="text-xs font-semibold text-slate-800 dark:text-slate-100 tracking-tight">
                {title}
              </h4>
              <span className="text-[10px] text-slate-400 dark:text-slate-500 font-mono hidden sm:inline">
                • Status & Audit Context
              </span>
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 line-clamp-1 sm:line-clamp-none">
              {description}
            </p>
          </div>
        </div>

        {/* Right: Real-time Compliance Status & Audit Badges */}
        {audits && audits.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {audits.map((a, idx) => {
              const AuditIcon = a.icon || (a.tone === "emerald" ? CheckCircle2 : a.tone === "rose" ? AlertTriangle : a.tone === "amber" ? AlertTriangle : Info)
              return (
                <div
                  key={idx}
                  className={cn(
                    "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium border shadow-2xs",
                    a.tone === "emerald"
                      ? "bg-emerald-50/80 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800"
                      : a.tone === "rose"
                      ? "bg-rose-50/90 text-rose-800 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800"
                      : a.tone === "amber"
                      ? "bg-amber-50/90 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800"
                      : "bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700"
                  )}
                  title={a.subtext || a.text}
                >
                  <AuditIcon className={cn(
                    "h-3.5 w-3.5 shrink-0",
                    a.tone === "emerald" ? "text-emerald-600 dark:text-emerald-400" :
                    a.tone === "rose" ? "text-rose-600 dark:text-rose-400" :
                    a.tone === "amber" ? "text-amber-600 dark:text-amber-400" :
                    "text-slate-400"
                  )} />
                  <span className="truncate max-w-[340px] sm:max-w-[420px]">{a.text}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ================= 360° PROFILE =================
function Employee360({ employeeId, editParam, printParam }: { employeeId: string; editParam?: boolean; printParam?: boolean }) {
  const { view, navigate, can, toast } = useHrm()
  const { data, loading, error, reload } = useApi<any>("employees.get", { id: employeeId })
  // "Edit Employee" from the directory three-dot menu lands here with edit=true
  const [editing, setEditing] = useState(!!editParam)
  const [docsOpen, setDocsOpen] = useState(false)
  const [printOpen, setPrintOpen] = useState(!!printParam)
  const [photoOpen, setPhotoOpen] = useState(false)
  const [photoBusy, setPhotoBusy] = useState(false)
  const [lifecycleAction, setLifecycleAction] = useState<"promote" | "transfer" | "revise" | "probationConfirm" | "probationExtend" | null>(null)
  const [quickAction, setQuickAction] = useState<QuickActionType | null>(null)
  const photoInputRef = useRef<HTMLInputElement>(null)

  if (loading) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="h-8 w-32 bg-slate-200 dark:bg-slate-800 rounded-lg" />
        <div className="h-44 bg-slate-200 dark:bg-slate-800 rounded-2xl" />
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-20 bg-slate-200 dark:bg-slate-800 rounded-xl" />
          ))}
        </div>
        <div className="h-96 bg-slate-200 dark:bg-slate-800 rounded-2xl" />
      </div>
    )
  }
  if (error) return <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{error}</div>
  if (!data) return null
  const e = data.employee

  // Shared upload pipeline: center-crop to 512×512 photoUrl + 96×96 photoThumb
  const uploadPhoto = async (file: File) => {
    setPhotoBusy(true)
    try {
      const { photoUrl, photoThumb } = await processEmployeePhoto(file)
      await rpc("employees.updatePhoto", { id: e.id, photoUrl, photoThumb })
      toast("Photo updated", "ok")
      reload()
    } catch (err: any) {
      toast(err?.message || "Photo upload failed", "err")
    } finally {
      setPhotoBusy(false)
    }
  }

  const primaryIdentityDoc = (data.docs || []).find((d: any) =>
    d.category === "IDENTITY" ||
    ["NID", "PASSPORT", "BIRTH_REG", "DRIVING_LICENCE", "OTHER_ID"].includes(d.docType)
  )
  const idType = e.identityType || primaryIdentityDoc?.docType || "NID"
  const idNumber = e.identityNumber || e.nid || primaryIdentityDoc?.docNumber
  const idLabel = idType === "PASSPORT" ? "Passport No" : idType === "BIRTH_REG" ? "Birth Reg No" : idType === "DRIVING_LICENCE" ? "Driving Licence" : "National ID (NID)"

  const defaultTab = (view.params as any)?.tab || "overview"

  // Context audits for Compensation & Banking (exact tab viewed by user)
  const primaryBank = (data.banks || []).find((b: any) => b.isPrimary) || data.banks?.[0]
  const isCashMethod = primaryBank?.paymentMethod === "CASH" || e.paymentMethod === "CASH" || (!primaryBank && (data.banks || []).length === 0)
  const grossSalary = Number(data.structure?.gross || 0)
  const cashOverThreshold = isCashMethod && grossSalary > 10000
  const bankMissing = (data.banks || []).length === 0 && !isCashMethod
  const tinMissing = !e.taxTin && grossSalary > 30000

  type AuditItem = { tone: "rose" | "amber" | "emerald" | "slate"; text: string; subtext?: string; icon?: any }

  const bankAudits: AuditItem[] = [
    ...(primaryBank ? [
      {
        tone: (primaryBank.verified ? "emerald" : "amber") as "emerald" | "amber",
        text: `${primaryBank.verified ? "Verified Payout" : "Routing Pending"}: ${primaryBank.bank || (primaryBank.mfsProvider ? `MFS (${titleCase(primaryBank.mfsProvider)})` : "Bank")} ${primaryBank.accountNumber ? `••••${primaryBank.accountNumber.slice(-4)}` : primaryBank.mfsNumber ? `••••${primaryBank.mfsNumber.slice(-4)}` : ""}`,
        subtext: primaryBank.branch ? `Branch: ${primaryBank.branch}` : undefined,
      }
    ] : [
      {
        tone: (cashOverThreshold ? "rose" : isCashMethod ? "slate" : "rose") as "rose" | "slate",
        text: isCashMethod ? "Payout Method: Cash Disbursement" : "Missing Payroll Account (Bank/MFS Unassigned)",
      }
    ]),
    ...(cashOverThreshold ? [
      {
        tone: "rose" as const,
        text: "BD Labor Act §120 Notice: Salary > ৳10,000 requires Bank/MFS transfer",
        subtext: "Salaries exceeding ৳10,000 must be paid via Bank/MFS for statutory corporate tax compliance.",
      }
    ] : []),
    ...(tinMissing ? [
      {
        tone: "amber" as const,
        text: "Tax Compliance Advisory: e-TIN recommended for taxable salary tier",
      }
    ] : []),
    ...(!cashOverThreshold && !bankMissing && primaryBank?.verified ? [
      {
        tone: "emerald" as const,
        text: "Payroll Ready • Compliant with Bangladesh Banking & Labor Rules",
      }
    ] : []),
  ]

  const overviewAudits: AuditItem[] = [
    ...(idNumber ? [
      { tone: "emerald" as const, text: `Verified ID: ${idLabel} (${idNumber})` }
    ] : [
      { tone: "rose" as const, text: "Missing Government Identity (NID / Passport / Birth Reg)" }
    ]),
    ...(e.emergencyContactMobile ? [
      { tone: "emerald" as const, text: `Emergency Contact: ${e.emergencyContactName || "Registered"} (${e.emergencyContactMobile})` }
    ] : [
      { tone: "amber" as const, text: "Missing Emergency Contact Details" }
    ]),
    ...(data.linkedAccount ? [
      { tone: "slate" as const, text: `ESS Portal Account: ${data.linkedAccount.email}` }
    ] : [
      { tone: "slate" as const, text: "No ESS Portal Login Account Created" }
    ]),
  ]

  const docCount = (data.docs || []).length
  const docAudits: AuditItem[] = [
    ...(primaryIdentityDoc ? [
      { tone: "emerald" as const, text: "Government Identity Scan Archived" }
    ] : [
      { tone: "rose" as const, text: "Missing Scanned Identity Proof (NID/Passport)" }
    ]),
    {
      tone: docCount > 0 ? "emerald" : "slate",
      text: `${docCount} Official Document(s) on file`,
    },
  ]

  const assetCount = (data.assignedAssets || []).length
  const assetAudits: AuditItem[] = [
    {
      tone: assetCount > 0 ? "emerald" : "slate",
      text: assetCount > 0 ? `${assetCount} Company Asset(s) Under Active Custody` : "No equipment currently assigned",
    }
  ]

  const promoTransferCount = (data.promotions || []).length + (data.transfers || []).length
  const careerAudits: AuditItem[] = [
    {
      tone: e.confirmationDate ? "emerald" : "amber",
      text: e.confirmationDate ? `Confirmed Permanent Employee (${calculateTenure(e.joiningDate)})` : `Probationary Employee (${e.probationMonths || 3} months)`,
    },
    {
      tone: "slate" as const,
      text: `${promoTransferCount} Lifecycle Milestone(s) recorded`,
    },
  ]

  const histCount = (data.history || []).length
  const histAudits: AuditItem[] = [
    {
      tone: "slate" as const,
      text: `${histCount} Immutable Audit Log Entries for this employee`,
    }
  ]

  const familyCount = (data.family || []).length
  const familyAudits: AuditItem[] = [
    {
      tone: familyCount > 0 ? "emerald" : "slate",
      text: familyCount > 0 ? `${familyCount} Recorded Dependent(s) / Family Member(s)` : "No family members or insurance nominees on file",
    }
  ]

  const eduCount = (data.education || []).length
  const eduAudits: AuditItem[] = [
    {
      tone: eduCount > 0 ? "emerald" : "slate",
      text: eduCount > 0 ? `${eduCount} Educational Degree(s) & Qualification(s)` : "No academic credentials recorded",
    }
  ]

  const prevCount = (data.prevEmployment || []).length
  const prevAudits: AuditItem[] = [
    {
      tone: prevCount > 0 ? "emerald" : "slate",
      text: prevCount > 0 ? `${prevCount} Previous Employment Record(s)` : "Fresh Graduate / No prior employment recorded",
    }
  ]

  const refCount = (data.references || []).length
  const refAudits: AuditItem[] = [
    {
      tone: refCount > 0 ? "emerald" : "slate",
      text: refCount > 0 ? `${refCount} Professional Reference(s) for Background Check` : "No professional references listed",
    }
  ]

  const groups: SectionTabGroup[] = [
    {
      label: "Personal & Profile",
      tabs: [
        {
          value: "overview",
          label: "Overview",
          description: (
            <ProfileTabContextBanner
              icon={UserRound}
              title="Personal & Master Profile Overview"
              description="Core demographic details, organizational placement, reporting manager, and government identification."
              audits={overviewAudits}
            />
          ),
          content: <OverviewTab data={data} onReload={reload} />
        },
        {
          value: "family",
          label: "Family & Dependents",
          badge: familyCount,
          description: (
            <ProfileTabContextBanner
              icon={HeartHandshake}
              title="Family Members & Nominees"
              description="Recorded dependents, spouse, children, and beneficiaries for health insurance and provident fund benefits."
              audits={familyAudits}
            />
          ),
          content: <SectionTable data={data} onReload={reload} section="family" />
        },
        {
          value: "education",
          label: "Education",
          badge: eduCount,
          description: (
            <ProfileTabContextBanner
              icon={GraduationCap}
              title="Academic Credentials & Qualifications"
              description="Degrees, passing institutions, certifications, majors, and verified academic qualifications."
              audits={eduAudits}
            />
          ),
          content: <SectionTable data={data} onReload={reload} section="education" />
        },
        {
          value: "prevEmployment",
          label: "Previous Employment",
          badge: prevCount,
          description: (
            <ProfileTabContextBanner
              icon={Briefcase}
              title="Prior Professional Experience"
              description="Employment history, past employers, designations, and verified previous work experience."
              audits={prevAudits}
            />
          ),
          content: <SectionTable data={data} onReload={reload} section="prevEmployment" />
        },
        {
          value: "references",
          label: "References",
          badge: refCount,
          description: (
            <ProfileTabContextBanner
              icon={UserCheck}
              title="Professional & Character References"
              description="Contactable referees for background verification, credential validation, and HR compliance checks."
              audits={refAudits}
            />
          ),
          content: <SectionTable data={data} onReload={reload} section="references" />
        },
      ],
    },
    {
      label: "Career & Lifecycle",
      tabs: [
        {
          value: "career",
          label: "Career Progression",
          badge: promoTransferCount,
          description: (
            <ProfileTabContextBanner
              icon={TrendingUp}
              title="Career Progression & Lifecycle"
              description="Documented record of internal promotions, job transfers, title changes, and department reassignments."
              audits={careerAudits}
            />
          ),
          content: <CareerTab data={data} onReload={reload} onAction={setLifecycleAction} />
        },
        {
          value: "history",
          label: "Audit Timeline",
          badge: histCount,
          description: (
            <ProfileTabContextBanner
              icon={History}
              title="Immutable Audit Trail & Activity Log"
              description="Chronological log of profile modifications, compensation updates, and administrative lifecycle actions."
              audits={histAudits}
            />
          ),
          content: <HistoryTab data={data} />
        },
      ],
    },
    {
      label: "Compensation & Assets",
      tabs: [
        {
          value: "bank",
          label: "Compensation & Banking",
          badge: (data.banks || []).length,
          badgeTone: (cashOverThreshold || bankMissing) ? "rose" : tinMissing ? "amber" : "neutral",
          description: (
            <ProfileTabContextBanner
              icon={Landmark}
              title="Compensation, Banking & Labor Law Compliance"
              description="Salary structure, automated payout methods, statutory allowances, and Bangladesh labor/tax compliance."
              audits={bankAudits}
            />
          ),
          content: <CompensationTab data={data} onReload={reload} />
        },
        {
          value: "assets",
          label: "Assigned Equipment",
          badge: assetCount,
          description: (
            <ProfileTabContextBanner
              icon={Laptop}
              title="Company Equipment & Asset Custody"
              description="Physical equipment, laptops, accessories, and tools currently assigned under the custody of this employee."
              audits={assetAudits}
            />
          ),
          content: <AssetsTab data={data} />
        },
      ],
    },
    {
      label: "Documents & Compliance",
      tabs: [
        {
          value: "documents",
          label: "Official Documents",
          badge: docCount,
          badgeTone: !primaryIdentityDoc ? "amber" : "neutral",
          description: (
            <ProfileTabContextBanner
              icon={FileText}
              title="Official Documents & Compliance Repository"
              description="Scanned government IDs, appointment letters, signed contracts, academic certificates, and HR files."
              audits={docAudits}
            />
          ),
          content: <DocumentsTab data={data} onReload={reload} />
        },
      ],
    },
  ]

  return (
    <div className="space-y-4">
      {/* Top Breadcrumb & Return Bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => navigate("employees")} className="h-8 text-xs text-slate-600 dark:text-slate-300">
            <ArrowLeft className="h-4 w-4 mr-1.5" /> Back to Directory
          </Button>
          <span className="text-slate-300 dark:text-slate-700">/</span>
          <span className="text-xs font-mono font-medium text-slate-500">{e.code}</span>
          <span className="text-slate-300 dark:text-slate-700">/</span>
          <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">{e.fullName}</span>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={e.status} />
        </div>
      </div>

      {/* Hero Profile Banner & Identity Header */}
      <div className="relative rounded-2xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm overflow-hidden">
        {/* Decorative subtle header background gradient bar */}
        <div className="h-20 bg-gradient-to-r from-emerald-600/15 via-teal-500/10 to-indigo-500/10 dark:from-emerald-950/40 dark:via-teal-950/30 dark:to-slate-900 border-b border-slate-100 dark:border-slate-800/80" />

        <div className="px-6 pb-6 pt-0">
          <div className="flex flex-col lg:flex-row gap-5 items-start lg:items-end justify-between -mt-10">
            {/* Avatar + Main Details */}
            <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-end min-w-0 flex-1">
              {/* Photo avatar */}
              <div className="relative group shrink-0">
                <Avatar className="h-24 w-24 rounded-2xl border-4 border-white dark:border-slate-900 shadow-md ring-1 ring-slate-200 dark:ring-slate-800 bg-white dark:bg-slate-800">
                  {e.photoUrl && <AvatarImage src={e.photoUrl} alt={e.fullName} className="object-cover rounded-2xl" />}
                  <AvatarFallback className="bg-gradient-to-br from-emerald-500 to-teal-600 text-white text-2xl font-bold rounded-2xl">
                    {e.fullName.split(" ").map((x: string) => x[0]).slice(0, 2).join("")}
                  </AvatarFallback>
                </Avatar>

                {/* Avatar hover action */}
                {e.photoUrl ? (
                  <button
                    type="button"
                    aria-label={`View ${e.fullName}'s photo`}
                    title="View photo"
                    onClick={() => setPhotoOpen(true)}
                    className="absolute inset-0 flex items-center justify-center bg-black/45 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer text-white"
                  >
                    <Eye className="h-6 w-6" />
                  </button>
                ) : can("employees", "edit") ? (
                  <label
                    className="absolute inset-0 flex items-center justify-center bg-black/45 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer text-white"
                    title="Upload photo"
                  >
                    <Upload className="h-6 w-6" />
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="hidden"
                      onChange={(ev) => {
                        const file = ev.target.files?.[0]
                        ev.target.value = ""
                        if (file) uploadPhoto(file)
                      }}
                    />
                  </label>
                ) : null}

                {/* Instant Change Photo Button Badge */}
                {can("employees", "edit") && (
                  <button
                    type="button"
                    onClick={() => photoInputRef.current?.click()}
                    disabled={photoBusy}
                    title="Change employee photo"
                    className="absolute -bottom-1 -right-1 h-7 w-7 rounded-full shadow border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center justify-center text-slate-600 dark:text-slate-300 transition-colors"
                  >
                    <Upload className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              {/* Identity & Metadata */}
              <div className="space-y-1.5 min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white tracking-tight">
                    {e.fullName}
                  </h1>
                  {e.nameBn && (
                    <span className="text-sm font-medium text-slate-500 dark:text-slate-400">
                      ({e.nameBn})
                    </span>
                  )}
                  {e.preferredName && (
                    <Badge variant="secondary" className="text-xs bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                      &quot;{e.preferredName}&quot;
                    </Badge>
                  )}
                  <StatusBadge status={e.status} />
                  <Badge variant="outline" className="font-mono text-xs font-semibold px-2 py-0.5 border-slate-300 dark:border-slate-700">
                    {e.code}
                  </Badge>
                  <CopyBadge text={e.code} label="Employee Code" />
                  <Badge variant="secondary" className="text-xs font-medium">
                    {titleCase(e.employmentType || "FULL_TIME")}
                  </Badge>
                </div>

                <p className="text-sm font-medium text-slate-600 dark:text-slate-300 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-semibold text-slate-800 dark:text-slate-100">{e.designationName || "No Designation"}</span>
                  <span className="text-slate-300 dark:text-slate-700">·</span>
                  <span>{e.departmentName || "No Department"}</span>
                  <span className="text-slate-300 dark:text-slate-700">·</span>
                  <span>{e.branchName || "Main Branch"}</span>
                  {e.workLocation && (
                    <>
                      <span className="text-slate-300 dark:text-slate-700">·</span>
                      <span className="text-slate-500">{e.workLocation}</span>
                    </>
                  )}
                </p>

                {/* Quick contact & metadata strip */}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-1 text-xs text-slate-500 dark:text-slate-400">
                  {e.mobile && (
                    <span className="inline-flex items-center gap-1 hover:text-slate-800 dark:hover:text-slate-200">
                      <Phone className="h-3.5 w-3.5 text-emerald-600" />
                      <a href={`tel:${e.mobile}`} className="hover:underline">{e.mobile}</a>
                      <CopyBadge text={e.mobile} label="Phone number" />
                    </span>
                  )}
                  {e.officialEmail && (
                    <span className="inline-flex items-center gap-1 hover:text-slate-800 dark:hover:text-slate-200">
                      <Mail className="h-3.5 w-3.5 text-emerald-600" />
                      <a href={`mailto:${e.officialEmail}`} className="hover:underline">{e.officialEmail}</a>
                      <CopyBadge text={e.officialEmail} label="Email" />
                    </span>
                  )}
                  <span className="inline-flex items-center gap-1" title="Joining Date & Duration">
                    <CalendarClock className="h-3.5 w-3.5 text-emerald-600" />
                    Joined {fmtDate(e.joiningDate)} <span className="text-emerald-700 dark:text-emerald-400 font-medium">({calculateTenure(e.joiningDate)})</span>
                  </span>
                  {e.taxTin && (
                    <span className="inline-flex items-center gap-1" title="Taxpayer Identification Number (e-TIN)">
                      <Hash className="h-3.5 w-3.5 text-slate-400" />
                      TIN: <span className="font-mono font-medium text-slate-700 dark:text-slate-300">{e.taxTin}</span>
                      <CopyBadge text={e.taxTin} label="e-TIN" />
                    </span>
                  )}
                  {idNumber && (
                    <span className="inline-flex items-center gap-1" title={idLabel}>
                      <ShieldCheck className="h-3.5 w-3.5 text-slate-400" />
                      {idType === "PASSPORT" ? "Passport" : idType === "BIRTH_REG" ? "Birth Reg" : "NID"}: <span className="font-mono font-medium text-slate-700 dark:text-slate-300">{idNumber}</span>
                    </span>
                  )}
                  {data.linkedAccount ? (
                    <span className="inline-flex items-center gap-1" title={`Linked ESS Portal Account: ${data.linkedAccount.email}`}>
                      <UserCheck className="h-3.5 w-3.5 text-emerald-600" />
                      Portal: <span className="font-medium text-slate-700 dark:text-slate-300">{data.linkedAccount.email}</span>
                      {data.linkedAccount.status !== "ACTIVE" && <Badge variant="outline" className="h-4 px-1 text-[9px]">{titleCase(data.linkedAccount.status)}</Badge>}
                      {data.linkedAccount.mustChangePassword && <Badge variant="outline" className="h-4 px-1 text-[9px] text-amber-600 border-amber-300">temp password</Badge>}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-slate-400" title="No ESS login account linked">
                      <Shield className="h-3.5 w-3.5" /> No portal account
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Action Hub */}
            <div className="flex flex-wrap items-center gap-2 shrink-0 mt-3 lg:mt-0">
              {/* View Documents */}
              <Button size="sm" variant="outline" onClick={() => setDocsOpen(true)} className="h-9 text-xs">
                <FolderOpen className="h-3.5 w-3.5 mr-1.5 text-slate-600 dark:text-slate-300" /> View Documents
                {(data.docs || []).length > 0 && (
                  <Badge variant="secondary" className="ml-1.5 h-4 px-1.5 text-[10px] font-semibold bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                    {(data.docs || []).length}
                  </Badge>
                )}
              </Button>

              {/* Print Profile / Export CV */}
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPrintOpen(true)}
                className="h-9 text-xs bg-emerald-50/70 hover:bg-emerald-100/70 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300 dark:hover:bg-emerald-950/70 border-emerald-300/80 dark:border-emerald-700/80 shadow-xs"
              >
                <Printer className="h-3.5 w-3.5 mr-1.5 text-emerald-600 dark:text-emerald-400" /> Print Profile / Export CV
              </Button>

              {/* Primary: Edit Profile */}
              {can("employees", "edit") && (
                <Button
                  size="sm"
                  onClick={() => setEditing(true)}
                  className="h-9 text-xs shadow-xs"
                >
                  <Pencil className="h-3.5 w-3.5 mr-1.5" /> Edit Profile
                </Button>
              )}

              {/* Lifecycle Actions Dropdown */}
              {(can("employees", "edit") || can("payroll", "edit")) && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="outline" className="h-9 text-xs">
                      <TrendingUp className="h-3.5 w-3.5 mr-1.5 text-emerald-600" /> Lifecycle <ChevronDown className="h-3.5 w-3.5 ml-1 text-slate-400" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52">
                    <DropdownMenuLabel className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                      Employee Lifecycle
                    </DropdownMenuLabel>
                    {can("employees", "edit") && (
                      <DropdownMenuItem onClick={() => setLifecycleAction("promote")} className="cursor-pointer text-xs py-2">
                        <TrendingUp className="h-4 w-4 mr-2 text-emerald-600" /> Promotion
                      </DropdownMenuItem>
                    )}
                    {can("employees", "edit") && (
                      <DropdownMenuItem onClick={() => setLifecycleAction("transfer")} className="cursor-pointer text-xs py-2">
                        <ArrowRightLeft className="h-4 w-4 mr-2 text-sky-600" /> Transfer
                      </DropdownMenuItem>
                    )}
                    {can("payroll", "edit") && (
                      <DropdownMenuItem onClick={() => setLifecycleAction("revise")} className="cursor-pointer text-xs py-2">
                        <Banknote className="h-4 w-4 mr-2 text-amber-600" /> Salary Revision
                      </DropdownMenuItem>
                    )}
                    {/* EMP-08 (R7) — end-of-probation workflow: confirm or extend */}
                    {can("employees", "edit") && e.status === "PROBATION" && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                          Probation
                        </DropdownMenuLabel>
                        <DropdownMenuItem onClick={() => setLifecycleAction("probationConfirm")} className="cursor-pointer text-xs py-2">
                          <BadgeCheck className="h-4 w-4 mr-2 text-emerald-600" /> Confirm Probation
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setLifecycleAction("probationExtend")} className="cursor-pointer text-xs py-2">
                          <Timer className="h-4 w-4 mr-2 text-amber-600" /> Extend Probation
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}

              {/* Employee Quick Actions Dropdown */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline" className="h-9 text-xs">
                    <Layers className="h-3.5 w-3.5 mr-1.5 text-slate-600 dark:text-slate-300" /> Quick Actions <ChevronDown className="h-3.5 w-3.5 ml-1 text-slate-400" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                    Quick Actions
                  </DropdownMenuLabel>
                  {can("leave", "view") && (
                    <DropdownMenuItem onClick={() => setQuickAction("leave")} className="cursor-pointer text-xs py-2">
                      <Plane className="h-4 w-4 mr-2 text-sky-600" /> Leave History & Balances
                    </DropdownMenuItem>
                  )}
                  {can("payslip", "view") && (
                    <DropdownMenuItem onClick={() => setQuickAction("payslips")} className="cursor-pointer text-xs py-2">
                      <ReceiptText className="h-4 w-4 mr-2 text-emerald-600" /> Payslips & Payroll
                    </DropdownMenuItem>
                  )}
                  {can("attendance", "view") && (
                    <DropdownMenuItem onClick={() => setQuickAction("attendance")} className="cursor-pointer text-xs py-2">
                      <CalendarRange className="h-4 w-4 mr-2 text-teal-600" /> Attendance Register
                    </DropdownMenuItem>
                  )}
                  {can("performance", "view") && (
                    <DropdownMenuItem onClick={() => setQuickAction("performance")} className="cursor-pointer text-xs py-2">
                      <Sparkles className="h-4 w-4 mr-2 text-purple-600" /> Performance Reviews
                    </DropdownMenuItem>
                  )}
                  {can("loans", "view") && (
                    <DropdownMenuItem onClick={() => setQuickAction("loans")} className="cursor-pointer text-xs py-2">
                      <Landmark className="h-4 w-4 mr-2 text-amber-600" /> Loans & Advances
                    </DropdownMenuItem>
                  )}
                  {can("ait", "view") && (
                    <DropdownMenuItem onClick={() => setQuickAction("ait")} className="cursor-pointer text-xs py-2">
                      <FileText className="h-4 w-4 mr-2 text-blue-600" /> Tax / AIT Profile
                    </DropdownMenuItem>
                  )}
                  {can("fieldforce", "view") && (
                    <DropdownMenuItem onClick={() => setQuickAction("fieldforce")} className="cursor-pointer text-xs py-2">
                      <MapPin className="h-4 w-4 mr-2 text-rose-600" /> Location Hit Map
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </div>
      </div>

      {/* Executive KPI Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <StatCard
          label="Tenure & Service"
          value={calculateTenure(e.joiningDate)}
          sub={e.confirmationDate ? `Confirmed ${fmtDate(e.confirmationDate)}` : `Probation (${e.probationMonths || 3} mos)`}
          icon={CalendarClock}
          tone="teal"
        />
        <StatCard
          label="Reporting Line"
          value={e.managerName || "Direct / Board"}
          sub={e.supervisorName ? `Supervisor: ${e.supervisorName}` : (e.departmentName || "General")}
          icon={UserRound}
          tone="sky"
        />
        <StatCard
          label="Monthly Salary"
          value={can("payroll", "view") && data.structure ? fmtMoney(data.structure.gross) : "Confidential"}
          sub={can("payroll", "view") && data.structure ? `Basic: ${fmtMoney(data.structure.basic)} · Grade: ${e.grade || "Standard"}` : `Grade: ${e.grade || "Standard"} · hidden (payroll.view required)`}
          icon={Banknote}
          tone="emerald"
        />
        <StatCard
          label="Shift & Hours"
          value={e.shiftName || "Standard Shift"}
          sub={`Off: ${fmtWeeklyOff(e.weeklyOff)}`}
          icon={CalendarDays}
          tone="slate"
        />
        <StatCard
          label="Assigned Assets"
          value={`${(data.assignedAssets || []).length} Items`}
          sub="Hardware & equipment"
          icon={Briefcase}
          tone="amber"
        />
      </div>

      {/* Modern Two-Level SectionTabs with Groups */}
      <SectionTabs defaultValue={defaultTab} groups={groups} />

      {/* Edit Profile Dialog */}
      {editing && (
        <EditProfileDialog open={editing} onOpenChange={(v) => { setEditing(v); if (!v) reload() }} onSaved={() => reload()} employee={e} lookups={data.lookups} fieldAccess={data.fieldAccess} />
      )}

      {/* Photo Viewer Lightbox Dialog */}
      <Dialog open={photoOpen} onOpenChange={setPhotoOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              <UserRound className="h-4 w-4 text-emerald-600" /> Employee Photo
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col items-center gap-3">
            <div className="w-full rounded-xl bg-slate-100 dark:bg-slate-800 p-3 flex justify-center">
              {e.photoUrl && (
                <img src={e.photoUrl} alt={`${e.fullName} — employee photo`} title={`${e.fullName} (${e.code})`}
                  className="max-h-[60vh] max-w-full h-auto w-auto object-contain rounded-lg shadow-sm" />
              )}
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 text-center">
              {e.fullName} · {e.code}{e.designationName ? ` · ${e.designationName}` : ""}
            </p>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setPhotoOpen(false)}>Close</Button>
            {can("employees", "edit") && (
              <Button onClick={() => photoInputRef.current?.click()} disabled={photoBusy}>
                <Upload className="h-3.5 w-3.5 mr-1" /> {photoBusy ? "Uploading…" : "Change Photo"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Hidden input backing photo upload */}
      <input ref={photoInputRef} id="profile-photo-input" type="file" accept="image/png,image/jpeg,image/webp" className="hidden" aria-hidden="true"
        onChange={(ev) => {
          const file = ev.target.files?.[0]
          ev.target.value = ""
          if (file) uploadPhoto(file)
        }} />

      {/* Documents Dialog */}
      <EmployeeDocumentsDialog open={docsOpen} onOpenChange={setDocsOpen} docs={data.docs || []} canDownload={can("employeeDocs", "download")} />

      {/* Print Profile / Export CV Modal */}
      {printOpen && (
        <EmployeeProfilePrintModal data={data} onClose={() => setPrintOpen(false)} />
      )}

      {/* Lifecycle Actions Modal (Promote / Transfer / Revise Salary) */}
      {lifecycleAction && (
        <LifecycleActionModal
          action={lifecycleAction}
          data={data}
          onClose={() => setLifecycleAction(null)}
          onDone={() => { setLifecycleAction(null); reload() }}
        />
      )}

      {/* Quick Action Right Slide-Over Panel */}
      <EmployeeQuickActionSheet
        open={!!quickAction}
        action={quickAction}
        onClose={() => setQuickAction(null)}
        employee={e}
      />
    </div>
  )
}

// ---------- View Documents modal ----------
function EmployeeDocumentsDialog({ open, onOpenChange, docs, canDownload }: {
  open: boolean; onOpenChange: (v: boolean) => void; docs: any[]; canDownload: boolean
}) {
  const toast = useHrm((s) => s.toast)
  const [downloading, setDownloading] = useState<string | null>(null)
  const [viewDoc, setViewDoc] = useState<any | null>(null)

  const download = async (d: any) => {
    setDownloading(d.id)
    try {
      const res = await rpc("employees.docs.download", { id: d.id })
      const a = document.createElement("a")
      a.href = `data:application/octet-stream;base64,${res.fileData}`
      a.download = res.fileName || "document"
      a.click()
    } catch (e: any) {
      toast(e.message, "err")
    } finally { setDownloading(null) }
  }

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <FolderOpen className="h-4 w-4 text-emerald-600" /> Employee Documents
          </DialogTitle>
        </DialogHeader>
        {docs.length === 0 ? (
          <div className="py-8 text-center">
            <FileText className="h-8 w-8 text-slate-300 mx-auto mb-2" />
            <p className="text-sm font-medium text-slate-600 dark:text-slate-300">No documents uploaded</p>
            <p className="text-xs text-slate-500 mt-1">Documents uploaded by HR appear here (Documents tab below).</p>
          </div>
        ) : (
          <div className="space-y-2">
            {docs.map((d) => (
              <div key={d.id} className="flex items-start gap-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3">
                <div className="h-9 w-9 rounded-lg bg-emerald-50 dark:bg-emerald-950 flex items-center justify-center shrink-0">
                  <FileText className="h-4 w-4 text-emerald-600" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <p className="text-sm font-medium text-slate-800 dark:text-slate-100 truncate">{d.title}</p>
                    {d.verified
                      ? <Badge className="bg-emerald-100 text-emerald-700 text-[9px]">✓ Verified</Badge>
                      : <Badge variant="outline" className="text-[9px]">Pending</Badge>}
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                    {titleCase(d.docType)} · {titleCase(d.category)}{d.docNumber ? ` · № ${d.docNumber}` : ""}
                  </p>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    {d.expiryDate
                      ? <>Expires <span className={isExpired(d.expiryDate) ? "text-rose-600 font-medium" : ""}>{fmtDate(d.expiryDate)}</span></>
                      : (d.fileName || "No file attached")}
                  </p>
                </div>
                {d.hasFile && canDownload && (
                  <div className="flex items-center gap-1 shrink-0">
                    {/* R6 — in-app popup preview (audit-logged as a view) */}
                    <Button size="icon" variant="outline" className="h-7 w-7" title="View document"
                      onClick={() => setViewDoc(d)}>
                      <Eye className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={downloading === d.id}
                      onClick={() => download(d)}>
                      <Download className="h-3 w-3 mr-1" /> {downloading === d.id ? "…" : "Download"}
                    </Button>
                  </div>
                )}
              </div>
            ))}
            <p className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1 pt-1">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" /> View &amp; download are permission-gated and audit-logged
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>

    {/* R6 — popup document viewer */}
    <DocumentViewerDialog doc={viewDoc} onClose={() => setViewDoc(null)} />
    </>
  )
}

// ---------- R6: popup document viewer (image / PDF preview over the audited view route) ----------
// The body is a separate component mounted only while a doc is selected, so
// its state resets naturally on close (no reset-effect with sync setState).
export function DocumentViewerDialog({ doc, onClose }: { doc: any | null; onClose: () => void }) {
  return (
    <Dialog open={!!doc} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="sm:max-w-4xl max-h-[92vh] flex flex-col">
        {doc ? <DocumentViewerBody doc={doc} onClose={onClose} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function DocumentViewerBody({ doc, onClose }: { doc: any; onClose: () => void }) {
  const [data, setData] = useState<{ fileName: string; fileData: string; mimeType: string; title: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [blobUrl, setBlobUrl] = useState<string | null>(null)

  useEffect(() => {
    let dead = false
    rpc<any>("employees.docs.view", { id: doc.id })
      .then((res) => { if (!dead) setData(res) })
      .catch((e: any) => { if (!dead) setError(e?.message || "Could not open document") })
      .finally(() => { if (!dead) setLoading(false) })
    return () => { dead = true }
  }, [doc.id])

  const ext = (data?.fileName || doc?.fileName || "").split(".").pop()?.toLowerCase() || ""
  const isImage = data ? data.mimeType.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(ext) : false
  const isPdf = data ? data.mimeType === "application/pdf" || ext === "pdf" : false

  // Create an object URL from base64 data:
  // Browsers (Chrome, Edge, Safari) strictly block or fail navigating iframes to `data:application/pdf`
  // due to opaque origin restrictions. A blob: URL has the same origin as the app and renders reliably.
  useEffect(() => {
    if (!data?.fileData) {
      setBlobUrl(null)
      return
    }
    try {
      let clean = data.fileData.replace(/^data:[^;]+;base64,/, "").replace(/\s/g, "")
      while (clean.length % 4) clean += "="
      const binary = atob(clean)
      const len = binary.length
      const bytes = new Uint8Array(len)
      for (let i = 0; i < len; i++) {
        bytes[i] = binary.charCodeAt(i)
      }
      const mime = isPdf ? "application/pdf" : (data.mimeType || "application/octet-stream")
      const blob = new Blob([bytes], { type: mime })
      const url = URL.createObjectURL(blob)
      setBlobUrl(url)
      return () => {
        URL.revokeObjectURL(url)
      }
    } catch (e) {
      console.error("Failed to create blob for document preview:", e)
      setBlobUrl(null)
    }
  }, [data?.fileData, data?.mimeType, isPdf])

  const handleDownload = () => {
    if (!data) return
    if (blobUrl) {
      const a = document.createElement("a")
      a.href = blobUrl
      a.download = data.fileName || doc?.title || "document"
      a.click()
    } else {
      const a = document.createElement("a")
      a.href = `data:application/octet-stream;base64,${data.fileData}`
      a.download = data.fileName || doc?.title || "document"
      a.click()
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 text-base pr-6">
          <Eye className="h-4 w-4 text-emerald-600 shrink-0" />
          <span className="truncate">{doc?.title || data?.fileName || "Document"}</span>
        </DialogTitle>
        {data?.fileName && (
          <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono truncate">{data.fileName}</p>
        )}
      </DialogHeader>
      <div className="flex-1 min-h-[350px] overflow-auto rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 flex flex-col items-center justify-center">
        {loading ? (
          <div className="h-full min-h-[350px] flex items-center justify-center text-sm text-slate-500">Opening document…</div>
        ) : error ? (
          <div className="h-full min-h-[350px] flex items-center justify-center text-sm text-rose-600 px-4 text-center">{error}</div>
        ) : data && isImage ? (
          <div className="p-4 flex items-start justify-center w-full">
            <img
              src={blobUrl || `data:${data.mimeType};base64,${data.fileData}`}
              alt={data.title || data.fileName}
              className="max-w-full max-h-[65vh] object-contain rounded shadow-sm"
            />
          </div>
        ) : data && isPdf ? (
          blobUrl ? (
            <iframe
              title={data.title || data.fileName || "document"}
              src={blobUrl}
              className="w-full h-[72vh] rounded-md border-0 bg-white"
            />
          ) : (
            <div className="h-full min-h-[350px] flex items-center justify-center text-sm text-slate-500">Preparing PDF preview…</div>
          )
        ) : data ? (
          <div className="h-full min-h-[350px] flex flex-col items-center justify-center gap-2 px-4 text-center">
            <FileText className="h-8 w-8 text-slate-300" />
            <p className="text-sm font-medium text-slate-600 dark:text-slate-300">Preview not available for this file type</p>
            <p className="text-xs text-slate-500">{data.fileName} — use the Download button to open it locally.</p>
          </div>
        ) : null}
      </div>
      {data && (
        <DialogFooter className="flex flex-row items-center justify-between sm:justify-between w-full pt-2">
          <div>
            {blobUrl && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.open(blobUrl, "_blank")}
                title="Open in a new browser tab"
              >
                <ExternalLink className="h-3.5 w-3.5 mr-1" /> Open in New Tab
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleDownload}>
              <Download className="h-3.5 w-3.5 mr-1" /> Download
            </Button>
            <Button size="sm" onClick={onClose}>Close</Button>
          </div>
        </DialogFooter>
      )}
    </>
  )
}


// ---------- Overview tab ----------
function OverviewTab({ data, onReload }: { data: any; onReload: () => void }) {
  const { can } = useHrm()
  const e = data.employee
  const s = data.structure

  const identityDocs = (data.docs || []).filter((d: any) =>
    d.category === "IDENTITY" ||
    ["NID", "PASSPORT", "BIRTH_REG", "DRIVING_LICENCE", "OTHER_ID"].includes(d.docType)
  )
  const primaryId = identityDocs[0]
  const idType = e.identityType || primaryId?.docType || "NID"
  const idNumber = e.identityNumber || e.nid || primaryId?.docNumber
  const idLabel = idType === "PASSPORT" ? "Passport No" : idType === "BIRTH_REG" ? "Birth Reg No" : idType === "DRIVING_LICENCE" ? "Driving Licence" : "National ID (NID)"
  const age = calculateAge(e.dob)

  return (
    <div className="grid lg:grid-cols-2 gap-5">
      {/* 1. Personal & Family Profile */}
      <SectionCard title="Personal Information">
        <KV items={[
          ["Full Legal Name", e.fullName],
          ["Bangla Name", e.nameBn || "—"],
          ["Preferred / Nickname", e.preferredName || "—"],
          ["Father's Name", e.fatherName || "—"],
          ["Mother's Name", e.motherName || "—"],
          ["Spouse Name", e.spouseName || "—"],
          ["Date of Birth", e.dob ? <span>{fmtDate(e.dob)}{age ? <Badge variant="secondary" className="ml-1.5 text-[10px] px-1 py-0">{age}</Badge> : null}</span> : "—"],
          ["Place of Birth", e.placeOfBirth || "—"],
          ["Gender", e.gender || "—"],
          ["Blood Group", e.bloodGroup ? <Badge variant="outline" className="text-rose-600 border-rose-200 dark:border-rose-800 font-bold">{e.bloodGroup}</Badge> : "—"],
          ["Marital Status", titleCase(e.maritalStatus) === "—" ? "—" : titleCase(e.maritalStatus)],
          ["Religion", e.religion || "—"],
          ["Nationality", e.nationality || "—"],
        ]} />
      </SectionCard>

      {/* 2. National Identity & Legal Documents */}
      <SectionCard title="National Identity & Legal">
        <KV items={[
          [idLabel, idNumber ? (
            <span className="font-mono font-medium text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
              {idNumber}
              <CopyBadge text={idNumber} label={idLabel} />
            </span>
          ) : "—"],
          ["e-TIN (Tax Identifier)", e.taxTin ? (
            <span className="font-mono font-medium text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
              {e.taxTin}
              <CopyBadge text={e.taxTin} label="e-TIN" />
            </span>
          ) : "—"],
          ["Primary ID Verified", primaryId?.verified ? (
            <Badge className="bg-emerald-100 text-emerald-700 text-[10px]">✓ Verified by HR</Badge>
          ) : primaryId ? (
            <Badge variant="outline" className="text-[10px]">Pending Verification</Badge>
          ) : "—"],
          ["Total Documents", `${(data.docs || []).length} document(s) uploaded`],
        ]} />

        {identityDocs.length > 1 && (
          <div className="mt-4 pt-4 border-t border-slate-100 dark:border-slate-800">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-2 flex items-center gap-1">
              <ShieldCheck className="h-3 w-3 text-emerald-600" /> Additional Identity Documents
            </p>
            <KV items={identityDocs.slice(1).map((d: any) => [
              d.docType === "PASSPORT" ? "Passport No" : d.docType === "BIRTH_REG" ? "Birth Reg No" : d.title || d.docType,
              d.docNumber ? <span className="font-mono font-medium text-slate-900 dark:text-slate-100">{d.docNumber}</span> : "—"
            ])} />
          </div>
        )}
      </SectionCard>

      {/* 3. Addresses & Emergency Contact */}
      <SectionCard title="Addresses & Emergency Contact">
        <KV items={[
          ["Personal Mobile", e.mobile || "—"],
          ["Alternate Mobile", e.altMobile || "—"],
          ["Personal Email", e.personalEmail || "—"],
          ["Official Email", e.officialEmail || "—"],
        ]} />

        {/* Addresses: Left = Present Address, Right = Permanent Address */}
        <div className="mt-4 pt-4 border-t border-slate-100 dark:border-slate-800 grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Left: Present Address */}
          <div className="space-y-3 md:pr-6 md:border-r md:border-slate-200 dark:md:border-slate-800">
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Present Address
              </dt>
              <dd className="text-sm font-medium text-slate-800 dark:text-slate-200 break-words mt-0.5">
                {e.presentAddress || "—"}
                {e.addressSame && (
                  <Badge variant="secondary" className="ml-2 text-[9px] bg-slate-100 text-slate-600">
                    Same as Permanent
                  </Badge>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Present City / District
              </dt>
              <dd className="text-sm font-medium text-slate-800 dark:text-slate-200 break-words mt-0.5">
                {`${e.presentCity || "—"} / ${e.presentDistrict || "—"}`}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Present Division & Post Code
              </dt>
              <dd className="text-sm font-medium text-slate-800 dark:text-slate-200 break-words mt-0.5">
                {`${e.presentDivision || "—"}${e.presentPostCode ? ` (${e.presentPostCode})` : ""}`}
              </dd>
            </div>
          </div>

          {/* Right: Permanent Address */}
          <div className="space-y-3 md:pl-2">
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Permanent Address
              </dt>
              <dd className="text-sm font-medium text-slate-800 dark:text-slate-200 break-words mt-0.5">
                {e.permanentAddress || "—"}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Permanent City / District
              </dt>
              <dd className="text-sm font-medium text-slate-800 dark:text-slate-200 break-words mt-0.5">
                {`${e.city || "—"} / ${e.district || "—"}`}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Permanent Division & Post Code
              </dt>
              <dd className="text-sm font-medium text-slate-800 dark:text-slate-200 break-words mt-0.5">
                {`${e.division || "—"}${e.postCode ? ` (${e.postCode})` : ""}`}
              </dd>
            </div>
          </div>
        </div>

        {/* Emergency contact box */}
        <div className="mt-4 pt-4 border-t border-slate-100 dark:border-slate-800">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-2 flex items-center gap-1">
            <PhoneCall className="h-3 w-3 text-rose-500" /> Emergency Contact
          </p>
          {(e.emergencyName || e.emergencyMobile) ? (
            <div className="rounded-lg bg-rose-50/60 dark:bg-rose-950/20 border border-rose-200/60 dark:border-rose-900/40 p-3 flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                  <span className="text-slate-500 font-normal">Contact Person: </span>
                  {e.emergencyName || "—"}
                </p>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Relationship: <span className="font-medium text-slate-700 dark:text-slate-300">{e.emergencyRelation || "Not specified"}</span>
                </p>
              </div>
              {e.emergencyMobile && (
                <div className="flex items-center gap-1">
                  <span className="font-mono text-xs font-medium text-slate-800 dark:text-slate-200">{e.emergencyMobile}</span>
                  <CopyBadge text={e.emergencyMobile} label="Emergency mobile" />
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-slate-400 italic">No emergency contact recorded</p>
          )}
        </div>
      </SectionCard>

      {/* 4. Job & Organizational Placement */}
      <SectionCard title="Job & Organization">
        <KV items={[
          ["Employee Code", <span key="c" className="font-mono font-medium">{e.code}</span>],
          ["Employment Status", <StatusBadge key="st" status={e.status} />],
          ["Employment Type", titleCase(e.employmentType || "FULL_TIME")],
          ["Category & Grade", `${e.category || "General"}${e.grade ? ` · Grade ${e.grade}` : ""}`],
          ["Branch", e.branchName || "—"],
          ["Department", e.departmentName || "—"],
          ["Designation", e.designationName || "—"],
          ["Work Location", e.workLocation || "—"],
          ["Reporting Manager", e.managerName || "—"],
          ["HR Manager", e.hrManagerName || "—"],
          ["Supervisor", e.supervisorName || "—"],
          ["Overtime Eligibility", e.otEligible ? <Badge className="bg-emerald-100 text-emerald-700 text-[10px]">OT Eligible</Badge> : <Badge variant="outline" className="text-[10px]">No OT</Badge>],
        ]} />
      </SectionCard>

      {/* EXT-05 (R7) — rehire linkage: prior service record banner */}
      {data.priorEmployee && (
        <div className="rounded-xl border border-violet-200 dark:border-violet-900/60 bg-gradient-to-r from-violet-50 to-indigo-50/60 dark:from-violet-950/40 dark:to-indigo-950/20 px-4 py-3 flex items-center gap-3">
          <History className="h-4 w-4 text-violet-600 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-violet-800 dark:text-violet-300">Rehired — prior service record linked</p>
            <p className="text-[11px] text-violet-700/80 dark:text-violet-400/80">
              {data.priorEmployee.fullName} ({data.priorEmployee.code}) · {titleCase(data.priorEmployee.status)}{data.priorEmployee.joiningDate ? ` · originally joined ${fmtDate(data.priorEmployee.joiningDate)}` : ""}. Prior history stays on the linked record for gratuity continuity decisions.
            </p>
          </div>
        </div>
      )}

      {/* 5. Lifecycle & Work Schedule */}
      <SectionCard title="Schedule & Lifecycle Terms">
        <KV items={[
          ["Joining Date", fmtDate(e.joiningDate)],
          ["Confirmation Date", e.confirmationDate ? fmtDate(e.confirmationDate) : <span className="text-amber-600 font-medium">Pending Confirmation</span>],
          ["Probation Duration", `${e.probationMonths || 3} months`],
          ["Contact / Duty Shift", e.shiftName || "—"],
          ["Weekly Off Days", fmtWeeklyOff(e.weeklyOff)],
          ["Contract Period", e.contractStart ? `${fmtDate(e.contractStart)} → ${fmtDate(e.contractEnd)}` : "Permanent / Ongoing"],
          ["Linked Portal Account", data.linkedAccount ? (
            <div className="flex items-center gap-1">
              <span className="text-xs font-medium text-slate-800 dark:text-slate-200">{data.linkedAccount.email}</span>
              <Badge className="bg-emerald-100 text-emerald-700 text-[9px]">Active</Badge>
            </div>
          ) : (
            <span className="text-slate-400">No account linked</span>
          )],
        ]} />
      </SectionCard>

      {/* 6. Current Salary Structure Snapshot */}
      <SectionCard
        title="Compensation Snapshot"
        actions={
          can("payroll", "edit") && <SalaryStructureDialog employee={e} structure={s} onDone={onReload} />
        }
      >
        {s ? (
          <div>
            <div className="flex items-center justify-between pb-3 mb-3 border-b border-slate-100 dark:border-slate-800">
              <span className="text-xs text-slate-500">Gross Monthly Package</span>
              <span className="text-base font-bold text-emerald-700 dark:text-emerald-400 font-mono">{fmtMoney(s.gross)}</span>
            </div>
            <KV cols={3} items={[
              ["Basic", fmtMoney(s.basic)],
              ["House Rent", fmtMoney(s.houseRent)],
              ["Medical", fmtMoney(s.medical)],
              ["Conveyance", fmtMoney(s.conveyance)],
              ["Food Allow.", fmtMoney(s.food)],
              ["Other Allow.", fmtMoney(s.otherAllowance)],
            ]} />
          </div>
        ) : e.salaryVisible === false ? (
          <EmptyState icon={Banknote} title="Compensation details are confidential" hint="Your role does not include payroll.view — salary structure and revision history are withheld by the server." />
        ) : (
          <EmptyState icon={Banknote} title="No active salary structure" hint="Set structure to include this employee in payroll." />
        )}
      </SectionCard>
    </div>
  )
}

// ---------- Career Progression tab ----------
function CareerTab({ data, onReload: _onReload, onAction }: { data: any; onReload: () => void; onAction: (action: "promote" | "transfer" | "revise") => void }) {
  const { can } = useHrm()
  const promotions = data.promotions || []
  const transfers = data.transfers || []
  const revisions = data.revisions || []

  return (
    <div className="space-y-5">
      {/* Promotions Card */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-emerald-600" />
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Promotions & Upgrades</h3>
            <Badge variant="outline" className="text-[10px]">{promotions.length}</Badge>
          </div>
          {can("employees", "edit") && (
            <Button size="sm" onClick={() => onAction("promote")} className="h-7 text-xs">
              <Plus className="h-3 w-3 mr-1" /> Promote Employee
            </Button>
          )}
        </div>
        {promotions.length === 0 ? (
          <EmptyState icon={TrendingUp} title="No promotions recorded" hint="Promotions will appear here once approved and applied." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-100 dark:border-slate-800 text-left text-slate-400 font-medium">
                  <th className="pb-2">Effective Date</th>
                  <th className="pb-2">Designation Progression</th>
                  <th className="pb-2">Department & Grade</th>
                  <th className="pb-2">New Basic</th>
                  <th className="pb-2">Reason</th>
                  <th className="pb-2 text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {promotions.map((p: any) => (
                  <tr key={p.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/50">
                    <td className="py-2.5 font-medium text-slate-800 dark:text-slate-200">{fmtDate(p.effectiveDate)}</td>
                    <td className="py-2.5">
                      <div className="flex items-center gap-1.5">
                        <span className="text-slate-400 line-through">{p.oldDesignation || "Previous"}</span>
                        <ArrowRight className="h-3 w-3 text-emerald-600 shrink-0" />
                        <span className="font-semibold text-emerald-700 dark:text-emerald-400">{p.newDesignation}</span>
                      </div>
                    </td>
                    <td className="py-2.5 text-slate-600 dark:text-slate-300">
                      {p.departmentName || "—"}{p.newGrade ? ` · Grade ${p.newGrade}` : ""}
                    </td>
                    <td className="py-2.5 font-medium text-slate-700 dark:text-slate-300">
                      {p.newBasicSalary ? fmtMoney(p.newBasicSalary) : "—"}
                    </td>
                    <td className="py-2.5 text-slate-500 max-w-xs truncate">{p.reason || "—"}</td>
                    <td className="py-2.5 text-right"><StatusBadge status={p.status || "APPROVED"} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Transfers Card */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ArrowRightLeft className="h-4 w-4 text-sky-600" />
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Transfers & Deployments</h3>
            <Badge variant="outline" className="text-[10px]">{transfers.length}</Badge>
          </div>
          {can("employees", "edit") && (
            <Button size="sm" onClick={() => onAction("transfer")} className="h-7 text-xs">
              <Plus className="h-3 w-3 mr-1" /> Transfer Employee
            </Button>
          )}
        </div>
        {transfers.length === 0 ? (
          <EmptyState icon={ArrowRightLeft} title="No transfer records" hint="Department and branch transfers will appear here once applied." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-100 dark:border-slate-800 text-left text-slate-400 font-medium">
                  <th className="pb-2">Effective Date</th>
                  <th className="pb-2">Branch Transition</th>
                  <th className="pb-2">Department Transition</th>
                  <th className="pb-2">Reason</th>
                  <th className="pb-2 text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {transfers.map((t: any) => (
                  <tr key={t.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/50">
                    <td className="py-2.5 font-medium text-slate-800 dark:text-slate-200">{fmtDate(t.effectiveDate)}</td>
                    <td className="py-2.5">
                      <div className="flex items-center gap-1.5">
                        <span className="text-slate-400">{t.fromBranch || "Original"}</span>
                        <ArrowRight className="h-3 w-3 text-sky-600 shrink-0" />
                        <span className="font-semibold text-sky-700 dark:text-sky-400">{t.toBranch || "Current"}</span>
                      </div>
                    </td>
                    <td className="py-2.5">
                      <div className="flex items-center gap-1.5">
                        <span className="text-slate-400">{t.fromDepartment || "Original"}</span>
                        <ArrowRight className="h-3 w-3 text-sky-600 shrink-0" />
                        <span className="font-semibold text-sky-700 dark:text-sky-400">{t.toDepartment || "Current"}</span>
                      </div>
                    </td>
                    <td className="py-2.5 text-slate-500 max-w-xs truncate">{t.reason || "—"}</td>
                    <td className="py-2.5 text-right"><StatusBadge status={t.status || "APPROVED"} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Salary Revisions Card */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Banknote className="h-4 w-4 text-emerald-600" />
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Salary Revisions</h3>
            <Badge variant="outline" className="text-[10px]">{revisions.length}</Badge>
          </div>
          {can("payroll", "edit") && (
            <Button size="sm" onClick={() => onAction("revise")} className="h-7 text-xs">
              <Plus className="h-3 w-3 mr-1" /> Revise Salary
            </Button>
          )}
        </div>
        {revisions.length === 0 ? (
          <EmptyState icon={Banknote} title="No salary revision records" hint="Salary increment and adjustment records will appear here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-100 dark:border-slate-800 text-left text-slate-400 font-medium">
                  <th className="pb-2">Effective Date</th>
                  <th className="pb-2">Gross Salary Change</th>
                  <th className="pb-2">Increment (৳)</th>
                  <th className="pb-2">Reason</th>
                  <th className="pb-2 text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {revisions.map((r: any) => {
                  // EMP-01 — the model stores previousSalary/newSalary (+increaseAmount);
                  // the old oldGross/newGross reads rendered "Tk 0 → Tk 0" on every row.
                  const oldSalary = Number(r.previousSalary ?? 0)
                  const newSalary = Number(r.newSalary ?? 0)
                  const diff = Number(r.increaseAmount ?? (newSalary - oldSalary))
                  return (
                    <tr key={r.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/50">
                      <td className="py-2.5 font-medium text-slate-800 dark:text-slate-200">{fmtDate(r.effectiveDate)}</td>
                      <td className="py-2.5">
                        <span className="text-slate-400">{fmtMoney(oldSalary)}</span> → <span className="font-semibold text-emerald-700 dark:text-emerald-400">{fmtMoney(newSalary)}</span>
                      </td>
                      <td className="py-2.5">
                        {diff > 0 ? (
                          <Badge className="bg-emerald-100 text-emerald-700 font-mono text-[10px]">+{fmtMoney(diff)}</Badge>
                        ) : diff < 0 ? (
                          <Badge className="bg-rose-100 text-rose-700 font-mono text-[10px]">{fmtMoney(diff)}</Badge>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="py-2.5 text-slate-500 max-w-xs truncate">{r.reason || "—"}</td>
                      <td className="py-2.5 text-right"><StatusBadge status={r.status || "APPROVED"} /></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------- Assigned Assets tab ----------
function AssetsTab({ data }: { data: any }) {
  const assets = data.assignedAssets || []

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-500 flex items-center gap-1.5">
          <Briefcase className="h-3.5 w-3.5 text-emerald-600" />
          Active company assets and equipment currently assigned to this employee
        </p>
        <Badge variant="outline" className="text-xs">{assets.length} item(s)</Badge>
      </div>

      {assets.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 dark:border-slate-800 p-8">
          <EmptyState
            icon={Laptop}
            title="No assets currently assigned"
            hint="Hardware, devices, and company property assigned in the Assets module will appear here."
          />
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40 text-left text-slate-500 font-medium">
                  <th className="py-2.5 px-4">Asset Tag / Code</th>
                  <th className="py-2.5 px-3">Asset Name & Category</th>
                  <th className="py-2.5 px-3">Brand & Model</th>
                  <th className="py-2.5 px-3">Serial / IMEI</th>
                  <th className="py-2.5 px-3">Assigned Date</th>
                  <th className="py-2.5 px-3">Condition Out</th>
                  <th className="py-2.5 px-4">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {assets.map((a: any) => (
                  <tr key={a.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/50">
                    <td className="py-3 px-4 font-mono font-medium text-slate-800 dark:text-slate-200">
                      <Badge variant="outline" className="font-mono text-[11px]">{a.asset.code}</Badge>
                    </td>
                    <td className="py-3 px-3">
                      <div className="font-medium text-slate-900 dark:text-slate-100">{a.asset.name}</div>
                      <div className="text-[11px] text-slate-400">{titleCase(a.asset.category || "General")}</div>
                    </td>
                    <td className="py-3 px-3 text-slate-600 dark:text-slate-300">
                      {a.asset.brandModel || "—"}
                    </td>
                    <td className="py-3 px-3 font-mono text-slate-600 dark:text-slate-300">
                      {a.asset.serialImei || "—"}
                    </td>
                    <td className="py-3 px-3 text-slate-600 dark:text-slate-300">
                      <div>{fmtDate(a.assignedAt)}</div>
                      {a.asset.purchaseDate && <div className="text-[10px] text-slate-400">Purchased: {fmtDate(a.asset.purchaseDate)}</div>}
                      {a.asset.warrantyExpiry && <div className="text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">Warranty: {fmtDate(a.asset.warrantyExpiry)}</div>}
                      {a.dueAt && <div className="text-[10px] text-amber-600">Due: {fmtDate(a.dueAt)}</div>}
                    </td>
                    <td className="py-3 px-3">
                      <Badge variant="secondary" className="text-[10px] font-medium">
                        {titleCase(a.conditionOut || a.asset.condition || "GOOD")}
                      </Badge>
                    </td>
                    <td className="py-3 px-4 text-slate-500 max-w-xs truncate">
                      {a.note || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------- Compensation & Banking tab ----------
function CompensationTab({ data, onReload }: { data: any; onReload: () => void }) {
  const { can, navigate } = useHrm()
  const e = data.employee
  const s = data.structure

  return (
    <div className="space-y-6">
      {/* Active Salary Structure Card */}
      <SectionCard
        title="Active Salary Structure"
        actions={
          can("payroll", "edit") && <SalaryStructureDialog employee={e} structure={s} onDone={onReload} />
        }
      >
        {s ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-100 dark:border-slate-800">
              <div className="flex items-center gap-2">
                <StatusBadge status={s.status || "ACTIVE"} />
                <span className="text-xs text-slate-500">Effective from <strong className="text-slate-700 dark:text-slate-300">{fmtDate(s.effectiveFrom)}</strong></span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs uppercase tracking-wider text-slate-400 font-semibold">Total Gross:</span>
                <span className="text-lg font-bold text-emerald-700 dark:text-emerald-400 font-mono">{fmtMoney(s.gross)}</span>
              </div>
            </div>

            <KV cols={4} items={[
              ["Basic Salary", fmtMoney(s.basic)],
              ["House Rent", fmtMoney(s.houseRent)],
              ["Medical Allowance", fmtMoney(s.medical)],
              ["Conveyance", fmtMoney(s.conveyance)],
              ["Food Allowance", fmtMoney(s.food)],
              ["Mobile Allowance", fmtMoney(s.mobileAllow)],
              ["Internet Allowance", fmtMoney(s.internetAllow)],
              ["Attendance Allowance", fmtMoney(s.attendanceAllow)],
              ["Other Allowance", fmtMoney(s.otherAllowance)],
              ["Effective Date", fmtDate(s.effectiveFrom)],
              ["Grade", e.grade || "Standard"],
              ["Total Gross (৳)", <span key="gross" className="text-emerald-700 dark:text-emerald-400 font-bold">{fmtMoney(s.gross)}</span>],
            ]} />

            {/* Quick payroll jump links */}
            <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mr-1">Payroll Actions:</span>
              {can("payslip", "view") && (
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => navigate("payroll", { tab: "payslips", employeeId: e.id })}>
                  <ReceiptText className="h-3 w-3 mr-1 text-emerald-600" /> View Payslips
                </Button>
              )}
              {can("loans", "view") && (
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => navigate("loans", { tab: "loans", employeeId: e.id })}>
                  <Landmark className="h-3 w-3 mr-1 text-amber-600" /> Loans & Advances
                </Button>
              )}
              {can("ait", "view") && (
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => navigate("ait", { employeeId: e.id })}>
                  <FileText className="h-3 w-3 mr-1 text-blue-600" /> Income Tax & AIT Profile
                </Button>
              )}
            </div>
          </div>
        ) : e.salaryVisible === false ? (
          <EmptyState icon={Banknote} title="Compensation details are confidential" hint="Your role does not include payroll.view — the server withholds salary structure and revision history for this profile." />
        ) : (
          <EmptyState icon={Banknote} title="No salary structure set" hint="Assign a salary structure to include this employee in payroll processing." />
        )}
      </SectionCard>

      {/* Bank & MFS Accounts */}
      <div>
        <div className="mb-2">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Disbursement & Banking Accounts</h3>
          <p className="text-xs text-slate-500">Bank accounts and Mobile Financial Services (bKash, Nagad, Rocket) used for automated payroll disbursement.</p>
        </div>
        <SectionTable data={data} onReload={onReload} section="banks" />
      </div>
    </div>
  )
}

// ---------- Generic biodata sections ----------
const SECTION_DEFS: Record<string, { title: string; icon: any; rows: (r: any) => [string, React.ReactNode][]; fields: FieldDef[]; canDelete?: string }> = {
  family: {
    title: "Family Members & Dependents",
    icon: HeartHandshake,
    rows: (r) => [["Name", r.name], ["Relationship", titleCase(r.relationship)], ["Date of Birth", fmtDate(r.dob)], ["Gender", r.gender || "—"], ["Occupation", r.occupation || "—"], ["Mobile", r.mobile || "—"], ["Email", r.email || "—"], ["Dependent", r.dependent ? "Yes" : "No"], ["Notes", r.notes || "—"]],
    fields: [
      { name: "name", label: "Name", required: true, span: 2 },
      { name: "relationship", label: "Relationship", type: "select", required: true, options: ["Spouse", "Child", "Father", "Mother", "Sibling", "Guardian", "Other"].map((x) => ({ value: x, label: x })) },
      { name: "dob", label: "Date of Birth", type: "date" },
      { name: "gender", label: "Gender", type: "select", options: ["Male", "Female", "Other"].map((x) => ({ value: x, label: x })) },
      { name: "occupation", label: "Occupation" },
      { name: "mobile", label: "Mobile" },
      { name: "email", label: "Email", type: "email" },
      { name: "dependent", label: "Dependent", type: "switch" },
      { name: "notes", label: "Notes", type: "textarea", span: 2 },
    ],
  },
  education: {
    title: "Education",
    icon: GraduationCap,
    rows: (r) => [["Degree", r.degree], ["Examination", r.examination || "—"], ["Institution", r.institution || "—"], ["Board/University", r.board || "—"], ["Major/Subject", r.major || "—"], ["Passing Year", r.passingYear || "—"], ["Result/GPA", r.result || "—"], ["Notes", r.notes || "—"]],
    fields: [
      { name: "degree", label: "Degree", required: true }, { name: "examination", label: "Examination" },
      { name: "institution", label: "Institution" }, { name: "board", label: "Board/University" },
      { name: "major", label: "Major/Subject" }, { name: "passingYear", label: "Passing Year" },
      { name: "result", label: "Result/GPA" }, { name: "notes", label: "Notes", type: "textarea", span: 2 },
    ],
  },
  references: {
    title: "References",
    icon: UserRound,
    rows: (r) => [["Name", r.name], ["Relationship", r.relationship || "—"], ["Organization", r.organization || "—"], ["Designation", r.designation || "—"], ["Mobile", r.mobile || "—"], ["Email", r.email || "—"], ["Type", titleCase(r.type)], ["Known For", r.knownFor || "—"], ["Verification", <StatusBadge key="vb" status={r.verificationStatus} />]],
    fields: [
      { name: "name", label: "Name", required: true, span: 2 },
      { name: "relationship", label: "Relationship" },
      { name: "type", label: "Reference Type", type: "select", options: ["PROFESSIONAL", "PERSONAL", "PREVIOUS_EMPLOYER", "GUARDIAN", "OTHER"].map((x) => ({ value: x, label: titleCase(x) })) },
      { name: "organization", label: "Organization" }, { name: "designation", label: "Designation" },
      { name: "mobile", label: "Mobile" }, { name: "email", label: "Email", type: "email" },
      { name: "address", label: "Address", span: 2 }, { name: "knownFor", label: "Known For (duration)" },
      { name: "notes", label: "Notes", type: "textarea", span: 2 },
    ],
  },
  prevEmployment: {
    title: "Previous Employment",
    icon: Briefcase,
    rows: (r) => [["Company", r.company], ["Designation", r.designation || "—"], ["Department", r.department || "—"], ["Period", `${fmtDate(r.joinDate)} → ${fmtDate(r.leaveDate)}`], ["Last Salary", r.lastSalary ? fmtMoney(r.lastSalary) : "—"], ["Reason for Leaving", r.reasonForLeaving || "—"], ["Supervisor", r.supervisor || "—"], ["Contact", r.contact || "—"]],
    fields: [
      { name: "company", label: "Company", required: true, span: 2 }, { name: "designation", label: "Designation" },
      { name: "department", label: "Department" }, { name: "joinDate", label: "Join Date", type: "date" },
      { name: "leaveDate", label: "Leaving Date", type: "date" }, { name: "lastSalary", label: "Last Salary (৳)", type: "number" },
      { name: "supervisor", label: "Supervisor" }, { name: "contact", label: "Contact" },
      { name: "reasonForLeaving", label: "Reason for Leaving", type: "textarea", span: 2 },
    ],
  },
  banks: {
    title: "Bank & MFS Accounts",
    icon: Landmark,
    rows: (r) => [["Account Holder", r.holderName || "—"], ["Bank", r.bank || "—"], ["Branch", r.branch || "—"], ["Account Number", r.accountNumber || "—"], ["Routing Number", r.routingNumber || "—"], ["Account Type", titleCase(r.accountType)], ["MFS Provider", r.mfsProvider ? titleCase(r.mfsProvider) : "—"], ["MFS Number", r.mfsNumber || "—"], ["Payment Method", titleCase(r.paymentMethod)], ["Primary", r.isPrimary ? "Yes" : "No"], ["Verified", r.verified ? <Badge className="bg-emerald-100 text-emerald-700">✓ Verified</Badge> : <Badge variant="outline">Unverified</Badge>]],
    fields: [
      { name: "holderName", label: "Account Holder", span: 2 },
      { name: "bank", label: "Bank" }, { name: "branch", label: "Bank Branch" },
      // masked-on-read fields: blank on edit keeps the stored number
      { name: "accountNumber", label: "Account Number", help: "Leave blank to keep the stored (masked) number" },
      { name: "routingNumber", label: "Routing Number" },
      { name: "accountType", label: "Account Type", type: "select", options: ["SALARY", "SAVINGS", "CURRENT"].map((x) => ({ value: x, label: titleCase(x) })) },
      { name: "mfsProvider", label: "MFS Provider", type: "select", options: ["BKASH", "NAGAD", "ROCKET", "OTHER"].map((x) => ({ value: x, label: "bKash / " + titleCase(x) })) },
      { name: "mfsNumber", label: "MFS Number", help: "Leave blank to keep the stored (masked) number" },
      { name: "paymentMethod", label: "Payment Method", type: "select", options: ["BANK", "MFS", "CASH", "OTHER"].map((x) => ({ value: x, label: titleCase(x) })) },
      { name: "isPrimary", label: "Primary account", type: "switch", defaultValue: true },
    ],
  },
}

function SectionTable({ data, onReload, section }: { data: any; onReload: () => void; section: string }) {
  const { can } = useHrm()
  const def = SECTION_DEFS[section]
  const [open, setOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<any>(null)
  const [delTarget, setDelTarget] = useState<any>(null)
  const keyMap: Record<string, string> = { family: "family", education: "education", references: "references", prevEmployment: "prevEmployment", banks: "banks" }
  const listKey = keyMap[section] || section
  const rows = (data as any)[listKey] || []
  // RBAC-102 + FLD-103 — the banks section rides bankInfo.edit AND the bank
  // field group; the generic sections stay on employees.edit. The server
  // enforces both layers regardless — this only keeps the buttons honest.
  const fa = (data as any).fieldAccess || {}
  const canEditSection = section === "banks"
    ? can("bankInfo", "edit") && fa.bank !== "none"
    : can("employees", "edit")

  const columns: Column<any>[] = [
    { key: "primary", label: def.rows(rows[0] || {})[0]?.[0] || "Record", render: (r) => <span className="text-sm font-medium text-slate-800 dark:text-slate-100">{def.rows(r)[0][1]}</span> },
    ...def.rows(rows[0] || {}).slice(1, 5).map(([k]: any, i: number) => ({
      key: `c${i}`, label: k, render: (r: any) => {
        const pairs = def.rows(r)
        return <span className="text-xs text-slate-600 dark:text-slate-300">{pairs[i + 1]?.[1] ?? "—"}</span>
      },
    })),
    {
      key: "actions", label: "", align: "right",
      render: (r) => canEditSection ? (
        <div className="flex items-center justify-end gap-1">
          {/* 2026-10 §7 — EDIT existing records (the server-side
              employees.<section>.update action existed but had no UI). */}
          <Button aria-label="Edit" size="icon" variant="ghost" className="h-7 w-7 text-slate-400 hover:text-emerald-700" title="Edit this record" onClick={(ev) => { ev.stopPropagation(); setEditTarget(r) }}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button aria-label="Delete" size="icon" variant="ghost" className="h-7 w-7 text-slate-400 hover:text-rose-600" onClick={(ev) => { ev.stopPropagation(); setDelTarget(r) }}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : null,
    },
  ]

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-500">{rows.length} record(s)</p>
        {canEditSection && (
          <Button size="sm" onClick={() => setOpen(true)} className="h-8 text-xs ">
            <Plus className="h-3.5 w-3.5 mr-1" /> Add {def.title.split("&")[0].trim()}
          </Button>
        )}
      </div>
      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed">
          <EmptyState icon={def.icon} title={`No ${def.title.toLowerCase()} records`} hint="Add the first record to complete the 360° biodata." />
        </div>
      ) : (
        <DataTable columns={columns} rows={rows} pageSize={10} searchable={false} />
      )}

      <FormDialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) onReload() }}
        title={`Add — ${def.title}`} fields={def.fields}
        onSubmit={async (v) => { await rpc(`employees.${listKey}.create`, { employeeId: data.employee.id, ...v }) }} />

      {/* 2026-10 §7 — edit dialog, prefilled from the row; only the server's
          whitelisted section fields are submitted (id + employeeId attach it).
          Bank/MFS rows arrive from employees.get with MASKED account numbers
          (•••• 1234) — prefilling them would write the mask back on save, so
          they are cleared and a blank submit keeps the stored value (the
          section-update handler skips empty strings by convention). */}
      {editTarget && (
        <FormDialog open={!!editTarget} onOpenChange={(v) => { if (!v) { setEditTarget(null); onReload() } }}
          title={`Edit — ${def.title}`} fields={def.fields}
          initial={section === "banks" ? { ...editTarget, accountNumber: "", mfsNumber: "" } : editTarget}
          submitLabel="Save changes"
          onSubmit={async (v) => {
            await rpc(`employees.${listKey}.update`, { id: editTarget.id, ...v })
          }} />
      )}

      <ConfirmDialog open={!!delTarget} onOpenChange={(v) => { if (!v) setDelTarget(null) }}
        title="Delete record" message={`Remove this ${def.title.toLowerCase()} record? This action is audit-logged.`} danger confirmLabel="Delete"
        onConfirm={async () => { await rpc(`employees.${listKey}.delete`, { id: delTarget.id }); onReload() }} />
    </div>
  )
}

// ---------- Documents tab ----------
function DocumentsTab({ data, onReload }: { data: any; onReload: () => void }) {
  const { can } = useHrm()
  const [open, setOpen] = useState(false)
  const [editDoc, setEditDoc] = useState<any | null>(null) // 2026-10 §7 — edit/replace flow
  const [viewDoc, setViewDoc] = useState<any | null>(null)
  const toast = useHrm((s) => s.toast) // M-26 — download failures surface as toasts
  const [docBusy, setDocBusy] = useState<string | null>(null) // M-26 — busy + double-click guard
  const docs = data.docs || []

  const columns: Column<any>[] = [
    { key: "title", label: "Document", render: (d) => (<div><p className="text-sm font-medium text-slate-800 dark:text-slate-100">{d.title}</p><p className="text-[11px] text-slate-500 dark:text-slate-400">{titleCase(d.docType)} · {titleCase(d.category)}</p></div>) },
    { key: "docNumber", label: "Number", render: (d) => <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300">{d.docNumber || "—"}</span> },
    { key: "expiryDate", label: "Expiry", render: (d) => d.expiryDate ? <span className={`text-xs ${isExpired(d.expiryDate) ? "text-rose-600 font-medium" : "text-slate-600 dark:text-slate-300"}`}>{fmtDate(d.expiryDate)}</span> : <span className="text-xs text-slate-400">—</span> },
    { key: "verified", label: "Verified", render: (d) => d.verified ? <Badge className="bg-emerald-100 text-emerald-700 text-[10px]">✓ Verified</Badge> : <Badge variant="outline" className="text-[10px]">Pending</Badge> },
    {
      key: "actions", label: "", align: "right",
      render: (d) => (
        <div className="flex items-center gap-1">
          {/* R6 — in-app popup preview (audit-logged as a view) */}
          {d.hasFile && can("employeeDocs", "download") && (
            <Button size="icon" variant="ghost" className="h-7 w-7 text-slate-500 hover:text-emerald-700" title="View document"
              onClick={() => setViewDoc(d)}>
              <Eye className="h-3.5 w-3.5" />
            </Button>
          )}
          {d.hasFile && can("employeeDocs", "download") && (
            <Button size="icon" variant="ghost" className="h-7 w-7 text-slate-500 hover:text-emerald-700" title="Download (audited)"
              disabled={docBusy === d.id}
              onClick={async () => {
                // M-26 — busy state + error surfacing + double-click guard
                // (the old bare await failed silently on error)
                setDocBusy(d.id)
                try {
                  const res = await rpc("employees.docs.download", { id: d.id })
                  const a = document.createElement("a")
                  a.href = `data:application/octet-stream;base64,${res.fileData}`
                  a.download = res.fileName || "document"
                  a.click()
                } catch (e: any) {
                  toast(e?.message || "Download failed", "err")
                } finally {
                  setDocBusy(null)
                }
              }}>
              <Download className={`h-3.5 w-3.5 ${docBusy === d.id ? "animate-pulse" : ""}`} />
            </Button>
          )}
          {can("employeeDocs", "verify") && !d.verified && (
            <Button size="sm" variant="outline" className="h-7 text-[10px]" onClick={async () => { await rpc("employees.docs.verify", { id: d.id }); onReload() }}>
              <ShieldCheck className="h-3 w-3 mr-1" /> Verify
            </Button>
          )}
          {/* 2026-10 §7 — edit document metadata + replace the attached file
              (employees.docs.update; verified stamps stay untouched). */}
          {can("employeeDocs", "edit") && (
            <Button size="icon" variant="ghost" className="h-7 w-7 text-slate-400 hover:text-emerald-700" title="Edit / replace document"
              onClick={() => setEditDoc(d)}>
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          )}
          {can("employeeDocs", "delete") && (
            <Button size="icon" variant="ghost" className="h-7 w-7 text-slate-400 hover:text-rose-600"
              onClick={async () => { await rpc("employees.docs.delete", { id: d.id }); onReload() }}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-500 flex items-center gap-1"><ShieldCheck className="h-3.5 w-3.5 text-emerald-600" /> View/download of sensitive documents is audit-logged</p>
        {can("employeeDocs", "upload") && (
          <Button size="sm" onClick={() => setOpen(true)} className="h-8 text-xs ">
            <Upload className="h-3.5 w-3.5 mr-1" /> Upload Document
          </Button>
        )}
      </div>
      <DataTable columns={columns} rows={docs} pageSize={10} emptyTitle="No documents uploaded" />

      <DocumentUploadDialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) onReload() }} employeeId={data.employee.id} editDoc={editDoc} onEditClose={() => { setEditDoc(null); onReload() }} />

      {/* R6 — popup document viewer */}
      <DocumentViewerDialog doc={viewDoc} onClose={() => setViewDoc(null)} />
    </div>
  )
}

function DocumentUploadDialog({ open, onOpenChange, employeeId, editDoc, onEditClose }: { open: boolean; onOpenChange: (v: boolean) => void; employeeId: string; editDoc?: any; onEditClose?: () => void }) {
  const [file, setFile] = useState<{ name: string; data: string } | null>(null)
  const [values, setValues] = useState<Record<string, any>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const toast = useHrm((s) => s.toast)
  const editing = !!editDoc

  useEffect(() => {
    if (open) { setFile(null); setError(null); setValues({ docType: "NID", category: "IDENTITY" }) }
  }, [open])

  // 2026-10 §7 — edit mode: prefill from the stored document row; a newly
  // picked file REPLACES the stored bytes, leaving it empty keeps the current
  // file. Only whitelisted metadata fields are written (verified/verifiedBy
  // audit stamps are never client-writable).
  useEffect(() => {
    if (editDoc) {
      setFile(null)
      setError(null)
      setValues({
        title: editDoc.title || "", category: editDoc.category || "IDENTITY", docType: editDoc.docType || "NID",
        docNumber: editDoc.docNumber || "", nameOnDoc: editDoc.nameOnDoc || "",
        issueDate: editDoc.issueDate || "", expiryDate: editDoc.expiryDate || "", notes: editDoc.notes || "",
      })
    }
  }, [editDoc])

  const onFile = (f: File | null) => {
    if (!f) return setFile(null)
    if (f.size > 2 * 1024 * 1024) { setError("File too large (max 2 MB)"); return }
    const reader = new FileReader()
    reader.onload = () => setFile({ name: f.name, data: String(reader.result).split(",")[1] || "" })
    reader.readAsDataURL(f)
  }

  const submit = async () => {
    if (!values.title) { setError("Title is required"); return }
    setBusy(true)
    try {
      if (editing) {
        // update: only changed metadata + an optional file REPLACEMENT
        // (no file picked → the stored bytes stay untouched)
        await rpc("employees.docs.update", {
          id: editDoc.id, ...values,
          fileName: file?.name,
          fileData: file?.data,
        })
        toast("Document updated")
        onEditClose?.()
      } else {
        await rpc("employees.docs.create", { employeeId, ...values, fileName: file?.name, fileData: file?.data })
        toast("Document uploaded")
        onOpenChange(false)
      }
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const set = (n: string, v: any) => setValues((s) => ({ ...s, [n]: v }))

  // render the EDIT dialog (editDoc set) or the UPLOAD dialog (open set)
  const showDialog = editing || open
  const close = (v: boolean) => {
    if (busy) return
    if (editing) { if (!v) onEditClose?.() }
    else onOpenChange(v)
  }

  return (
    <Dialog open={showDialog} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">{editing ? "Edit Employee Document" : "Upload Employee Document"}</DialogTitle>
          <p className="text-xs text-slate-500">{editing
            ? "Update the metadata and optionally replace the attached file. View/download of sensitive documents is audit-logged."
            : "Sensitive document — view/download requires permission and is audit-logged."}</p>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 py-2">
          <div className="sm:col-span-2 space-y-1.5">
            <Label className="text-xs font-medium">Title <span className="text-rose-500">*</span></Label>
            <Input value={values.title || ""} onChange={(e) => set("title", e.target.value)} className="h-9" placeholder="e.g. National ID Card" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Category</Label>
            <Select value={values.category || "IDENTITY"} onValueChange={(v) => set("category", v)}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                {["IDENTITY", "EDUCATION", "EXPERIENCE", "CONTRACT", "OTHER"].map((x) => <SelectItem key={x} value={x}>{titleCase(x)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Document Type</Label>
            <Select value={values.docType || "NID"} onValueChange={(v) => set("docType", v)}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                {["NID", "PASSPORT", "BIRTH_REG", "DRIVING_LICENCE", "OTHER_ID", "CERTIFICATE", "EXPERIENCE_CERT", "AGREEMENT", "APPOINTMENT", "CONFIRMATION", "SUPPORTING"].map((x) => <SelectItem key={x} value={x}>{titleCase(x)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-medium">Document Number</Label>
              {values.docType === "NID" && values.docNumber && (
                <span className={`text-[10px] ${validateNid(values.docNumber).ok ? "text-emerald-600 dark:text-emerald-400 font-medium" : "text-amber-600 dark:text-amber-400"}`}>
                  {validateNid(values.docNumber).message}
                </span>
              )}
            </div>
            <Input value={values.docNumber || ""} onChange={(e) => set("docNumber", e.target.value)} className="h-9" placeholder={values.docType === "NID" ? "e.g. 10, 13, or 17-digit NID" : ""} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Name on Document</Label>
            <Input value={values.nameOnDoc || ""} onChange={(e) => set("nameOnDoc", e.target.value)} className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Issue Date</Label>
            <Input type="date" value={values.issueDate || ""} onChange={(e) => set("issueDate", e.target.value)} className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Expiry Date</Label>
            <Input type="date" value={values.expiryDate || ""} onChange={(e) => set("expiryDate", e.target.value)} className="h-9" />
          </div>
          <div className="sm:col-span-2 space-y-1.5">
            <Label className="text-xs font-medium">{editing ? "Replace attachment (max 2 MB — leave empty to keep the current file)" : "Attachment (max 2 MB)"}</Label>
            <Input type="file" accept="image/*,.pdf" onChange={(e) => onFile(e.target.files?.[0] || null)} className="h-9 text-xs" />
            {file && <p className="text-[11px] text-emerald-600">✓ {file.name}</p>}
            {editing && !file && editDoc?.hasFile && <p className="text-[11px] text-slate-400">Current file: {editDoc.fileName || "on file"}</p>}
          </div>
          <div className="sm:col-span-2 space-y-1.5">
            <Label className="text-xs font-medium">Notes</Label>
            <Textarea rows={2} value={values.notes || ""} onChange={(e) => set("notes", e.target.value)} />
          </div>
        </div>
        {error && <p className="text-sm text-rose-600 bg-rose-50 rounded-md px-3 py-2">{error}</p>}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => close(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? (editing ? "Saving…" : "Uploading…") : editing ? "Save changes" : "Upload"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------- History tab ----------
function HistoryTab({ data }: { data: any }) {
  const events = data.history || []
  const iconFor: Record<string, any> = {
    JOINED: BadgeCheck, PROMOTION: TrendingUp, TRANSFER: ArrowRightLeft, SALARY_REVISION: Banknote,
    LEAVE: Plane, RESIGNATION: LogOut, EXIT: LogOut, LETTER: FileText, LOAN: Landmark, REVIEW: Sparkles, STATUS_CHANGE: UserRound, TASK: BadgeCheck, LOAN_CLOSED: Landmark,
  }
  return (
    <div className="relative pl-6">
      <div className="absolute left-2 top-1 bottom-1 w-px bg-slate-200 dark:bg-slate-700" />
      {events.length === 0 && <EmptyState icon={History} title="No history events yet" />}
      {events.map((h: any, i: number) => {
        const Icon = iconFor[h.eventType] || History
        return (
          <div key={h.id || i} className="relative pb-5">
            <div className="absolute -left-[1.28rem] top-0.5 h-6 w-6 rounded-full bg-white dark:bg-slate-900 border-2 border-emerald-500 flex items-center justify-center">
              <Icon className="h-3 w-3 text-emerald-600" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{h.title}</p>
              <Badge variant="outline" className="text-[9px] uppercase tracking-wide">{h.eventType.replace(/_/g, " ")}</Badge>
            </div>
            {h.description && <p className="text-xs text-slate-500 mt-0.5">{h.description}</p>}
            <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">{fmtDate(h.effectiveDate)}{h.amount ? ` · ${fmtMoney(h.amount)}` : ""}</p>
          </div>
        )
      })}
    </div>
  )
}

// ---------- Edit profile is imported from ./employee-edit-dialog ----------

// ---------- Salary structure ----------
function SalaryStructureDialog({ employee, structure, onDone }: { employee: any; structure: any; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const fields: FieldDef[] = [
    { name: "effectiveFrom", label: "Effective From", type: "date", required: true, defaultValue: structure?.effectiveFrom || todayDhaka() },
    { name: "basic", label: "Basic (৳)", type: "number", required: true },
    { name: "houseRent", label: "House Rent (৳)", type: "number" }, { name: "medical", label: "Medical (৳)", type: "number" },
    { name: "conveyance", label: "Conveyance (৳)", type: "number" }, { name: "food", label: "Food (৳)", type: "number" },
    { name: "mobileAllow", label: "Mobile (৳)", type: "number" }, { name: "internetAllow", label: "Internet (৳)", type: "number" },
    { name: "attendanceAllow", label: "Attendance Allowance (৳)", type: "number" }, { name: "otherAllowance", label: "Other Allowance (৳)", type: "number" },
  ]
  return (
    <>
      <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setOpen(true)}>
        {structure ? <Pencil className="h-3.5 w-3.5 mr-1" /> : <Plus className="h-3.5 w-3.5 mr-1" />}
        {structure ? "Revise Structure" : "Set Structure"}
      </Button>
      <FormDialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) onDone() }} title={`Salary Structure — ${employee.fullName}`}
        fields={fields} initial={structure || {}} wide
        description={structure ? "Saving supersedes the current structure — history is preserved." : "Initial salary structure."}
        onSubmit={async (v) => { await rpc("salaryStructures.save", { employeeId: employee.id, ...v }) }} />
    </>
  )
}

// ---------- Lifecycle actions ----------
function LifecycleActionModal({
  action,
  data,
  onClose,
  onDone,
}: {
  action: "promote" | "transfer" | "revise" | "probationConfirm" | "probationExtend"
  data: any
  onClose: () => void
  onDone: () => void
}) {
  const e = data.employee
  const lookups = data.lookups || {}
  // EMP-12 (R6) — the transfer's manager picker reads the CACHED shared
  // directory (the server no longer ships lookups.employees with profiles).
  const { data: directoryRows } = useEmployeeDirectory()

  const promoteFields: FieldDef[] = [
    { name: "newDesignationId", label: "New Designation", type: "select", required: true, options: (lookups.designations || []).map((d: any) => ({ value: d.id, label: d.name })) },
    { name: "newDepartmentId", label: "New Department (optional)", type: "select", options: (lookups.departments || []).map((d: any) => ({ value: d.id, label: d.name })) },
    { name: "newGrade", label: "New Grade" },
    { name: "newBasicSalary", label: "New Basic Salary (৳, optional)", type: "number" },
    { name: "effectiveDate", label: "Effective Date", type: "date", required: true },
    { name: "reason", label: "Reason", type: "textarea", span: 2 },
  ]
  const transferFields: FieldDef[] = [
    { name: "toBranchId", label: "To Branch", type: "select", options: (lookups.branches || []).map((b: any) => ({ value: b.id, label: b.name })) },
    { name: "toDepartmentId", label: "To Department", type: "select", options: (lookups.departments || []).map((d: any) => ({ value: d.id, label: d.name })) },
    { name: "toDesignationId", label: "To Designation", type: "select", options: (lookups.designations || []).map((d: any) => ({ value: d.id, label: d.name })) },
    { name: "toManagerId", label: "New Reporting Manager", type: "select", options: (directoryRows || []).map((m: any) => ({ value: m.id, label: m.fullName })) },
    { name: "toShiftId", label: "New Shift", type: "select", options: (lookups.shifts || []).map((s: any) => ({ value: s.id, label: s.name })) },
    { name: "workLocation", label: "Work Location" },
    { name: "effectiveDate", label: "Effective Date", type: "date", required: true },
    { name: "reason", label: "Reason", type: "textarea", span: 2 },
  ]
  const reviseFields: FieldDef[] = [
    { name: "newGross", label: "New Gross Salary (৳)", type: "number", required: true, help: `Current gross: ${fmtMoney(data.structure?.gross || 0)}` },
    { name: "effectiveDate", label: "Effective Date", type: "date", required: true },
    { name: "reason", label: "Reason", type: "textarea", span: 2 },
  ]

  // EMP-08 (R7) — probation confirm / extend (direct action, no approval flow:
  // the confirmation decision IS the approval)
  const probationEnd = useMemo(() => {
    if (!e.joiningDate || !e.probationMonths) return null
    const [y, m, d] = e.joiningDate.split("-").map(Number)
    const total = y * 12 + (m - 1) + e.probationMonths
    const ny = Math.floor(total / 12)
    const nm = (total % 12) + 1
    const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate()
    return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(d, lastDay)).padStart(2, "0")}`
  }, [e.joiningDate, e.probationMonths])
  const confirmFields: FieldDef[] = [
    { name: "effectiveDate", label: "Confirmation Date", type: "date", required: true, defaultValue: todayDhaka(), help: probationEnd ? `Probation ends ${probationEnd} (calendar months from joining)` : undefined },
    { name: "remarks", label: "Remarks", type: "textarea", span: 2, placeholder: "e.g. Performance satisfactory — confirmed as regular employee" },
  ]
  const extendFields: FieldDef[] = [
    { name: "extendMonths", label: "Extend by (months)", type: "number", required: true, min: 1, max: 12, defaultValue: 1, help: `Current probation: ${e.probationMonths || 3} month(s)${probationEnd ? ` · ends ${probationEnd}` : ""}` },
    { name: "remarks", label: "Reason", type: "textarea", span: 2, required: true, placeholder: "e.g. Needs further observation on target achievement" },
  ]

  const isProbation = action === "probationConfirm" || action === "probationExtend"
  const label = action === "promote" ? "Promotion" : action === "transfer" ? "Transfer" : action === "revise" ? "Salary Revision"
    : action === "probationConfirm" ? "Confirm Probation" : "Extend Probation"
  const fields = action === "promote" ? promoteFields : action === "transfer" ? transferFields : action === "revise" ? reviseFields
    : action === "probationConfirm" ? confirmFields : extendFields
  const rpcAction = action === "promote" ? "lifecycle.promote" : action === "transfer" ? "lifecycle.transfer" : action === "revise" ? "lifecycle.reviseSalary"
    : "employees.probation"

  return (
    <FormDialog
      open={true}
      onOpenChange={(v) => { if (!v) onClose() }}
      title={`${label} — ${e.fullName}`}
      fields={fields}
      wide
      description={isProbation
        ? action === "probationConfirm"
          ? "Confirms the employee after probation — status becomes ACTIVE with the confirmation date recorded in their history."
          : "Extends the probation period by whole calendar months. A PROBATION_EXT letter can be issued from HR Letters."
        : "Submitted through the approval workflow. History is immutable once applied."}
      onSubmit={async (v) => {
        await rpc(rpcAction, isProbation
          ? { id: e.id, action: action === "probationConfirm" ? "CONFIRM" : "EXTEND", ...v }
          : { employeeId: e.id, ...v })
        onDone()
      }}
    />
  )
}
