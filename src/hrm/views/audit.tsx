"use client"
// ============ Audit Trail (spec §18 / Phase hardening) ============
// Immutable, filterable log of every sensitive HR action in this vendor.
import { useEffect, useState } from "react"
import { ScrollText, Search, Info, ShieldCheck, LogIn, MonitorSmartphone, Download } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useHrm } from "../store"
import { useApi, rpc } from "../api"
import { PageHeader, fmtDateTime, SectionCard } from "../shared/ui-kit"
import { DataTable, type Column } from "../shared/data-table"

const ENTITIES = [
  "Employee", "Branch", "Department", "Designation", "Shift", "Attendance", "LeaveRequest",
  "PayrollRun", "PayrollEntry", "Loan", "Advance", "ExpenseClaim", "HrLetter", "Resignation",
  "FinalSettlement", "User", "AccountJournal", "SalaryStructure", "Promotion", "Transfer",
  "SalaryRevision", "Task", "LeaveType", "HrSetting", "ApprovalWorkflow", "AttendanceCorrection",
  "KpiAssignment", "ReviewCycle", "Bonus", "AttendanceDevice", "CompanyEvent", "Announcement",
]

export default function AuditView() {
  const { can } = useHrm()
  const toast = useHrm((s) => s.toast)
  const allowed = can("audit", "view")
  const canExport = can("audit", "export")
  const [exporting, setExporting] = useState(false)
  const [surface, setSurface] = useState<"actions" | "logins">("actions")

  const [entity, setEntity] = useState("")
  const [q, setQ] = useState("")
  const [from, setFrom] = useState("")
  const [applied, setApplied] = useState<{ entity: string; q: string; from: string }>({ entity: "", q: "", from: "" })

  // M-13 — cursor pagination: first page via useApi, subsequent pages appended
  // manually with the returned nextCursor (no more silent 200-row truncation).
  const { data, loading, error } = useApi<any>(
    allowed ? "audit.list" : null,
    { entity: applied.entity || undefined, q: applied.q || undefined, from: applied.from || undefined, limit: 50 },
  )
  const [extra, setExtra] = useState<any[]>([])
  const [loadingMore, setLoadingMore] = useState(false)
  const rows: any[] = [...(data?.items ?? (Array.isArray(data) ? data : [])), ...extra]
  const nextCursor: string | null = data?.nextCursor ?? null
  const loadMore = async () => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    try {
      const res = await rpc<any>("audit.list", {
        entity: applied.entity || undefined, q: applied.q || undefined, from: applied.from || undefined,
        limit: 50, cursor: nextCursor,
      })
      setExtra((prev) => [...prev, ...(res.items || [])])
    } catch { /* surfaced by the error banner */ }
    finally { setLoadingMore(false) }
  }
  // reset appended pages whenever filters change
  useEffect(() => { setExtra([]) }, [applied])

  if (!allowed) {
    return (
      <div className="rounded-xl border bg-white dark:bg-slate-900 p-8 text-center">
        <ShieldCheck className="h-8 w-8 text-slate-300 mx-auto mb-2" />
        <p className="text-sm font-medium text-slate-600 dark:text-slate-300">You do not have permission to view the audit trail.</p>
      </div>
    )
  }

  const apply = () => setApplied({ entity, q, from })

  // RBAC-105/BTN-103 (Wave R3-5) — the export is now a REAL server-side route
  // (audit.export, perm-gated, capped, audited itself) instead of a
  // client-side CSV dump of the loaded page.
  const exportCsv = async () => {
    setExporting(true)
    try {
      const res = await rpc<any>("audit.export", {
        entity: applied.entity || undefined, q: applied.q || undefined, from: applied.from || undefined,
      })
      const blob = new Blob([res.csv], { type: "text/csv;charset=utf-8" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url; a.download = res.fileName || "audit-trail.csv"
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
      toast(`Exported ${res.count} audit entries${res.truncated ? " (capped at 50,000 — narrow the filters)" : ""}`)
    } catch (e: any) {
      toast(e.message || "Export failed", "err")
    } finally { setExporting(false) }
  }

  const columns: Column<any>[] = [
    { key: "createdAt", label: "When", sortValue: (r) => String(r.createdAt), render: (r) => <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300 whitespace-nowrap">{fmtDateTime(r.createdAt)}</span> },
    { key: "userName", label: "User", render: (r) => <span className="text-xs font-medium text-slate-700 dark:text-slate-200">{r.userName || "system"}</span> },
    { key: "action", label: "Action", render: (r) => <Badge variant="outline" className="text-[10px] font-mono bg-slate-50 dark:bg-slate-800 whitespace-nowrap">{r.action}</Badge> },
    { key: "entity", label: "Entity", render: (r) => <span className="text-xs text-slate-600 dark:text-slate-300 whitespace-nowrap">{r.entity}</span> },
    { key: "summary", label: "Summary", render: (r) => <span className="text-xs text-slate-700 dark:text-slate-300 break-words whitespace-normal max-w-[420px] block leading-snug">{r.summary}</span> },
    { key: "reason", label: "Reason", render: (r) => r.reason ? <span className="text-xs text-amber-700 dark:text-amber-400 italic break-words max-w-[180px] block">{r.reason}</span> : <span className="text-xs text-slate-400">—</span> },
    { key: "ip", label: "IP", render: (r) => <span className="text-[10px] tabular-nums text-slate-400 font-mono">{r.ip || "—"}</span> },
  ]

  return (
    <div className="space-y-4">
      <PageHeader
        title="Audit Trail"
        subtitle="Every sensitive HR action in this vendor — immutable and filterable"
      />

      {/* R16 — surface switcher: action trail / login attempts */}
      <div className="flex gap-1.5 p-1 rounded-xl border bg-slate-50/70 dark:bg-slate-900/60 w-fit">
        <button
          onClick={() => setSurface("actions")}
          className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${surface === "actions" ? "bg-white dark:bg-slate-800 shadow-sm text-slate-900 dark:text-slate-100" : "text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"}`}
        >
          <ScrollText className="h-3.5 w-3.5" /> Action trail
        </button>
        <button
          onClick={() => setSurface("logins")}
          className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${surface === "logins" ? "bg-white dark:bg-slate-800 shadow-sm text-slate-900 dark:text-slate-100" : "text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"}`}
        >
          <LogIn className="h-3.5 w-3.5" /> Login audit
        </button>
      </div>

      {surface === "logins" ? <LoginAuditTab /> : (
      <>

      {/* note card */}
      <div className="rounded-xl border border-teal-200 dark:border-teal-900 bg-teal-50 dark:bg-teal-950/40 p-3.5 flex items-start gap-2.5">
        <Info className="h-4 w-4 text-teal-600 shrink-0 mt-0.5" />
        <p className="text-xs text-teal-800 dark:text-teal-300 leading-relaxed">
          Audit covers employee edits, salary changes, bank changes, document access/downloads, attendance edits,
          leave/loan/payroll approvals, role changes, resignation decisions and letter issuance.
          Records include the acting user, IP address and — for sensitive actions — a mandatory reason.
        </p>
      </div>

      {/* filter bar */}
      <div className="rounded-xl border bg-white dark:bg-slate-900 p-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          <Select value={entity || "ALL"} onValueChange={(v) => setEntity(v === "ALL" ? "" : v)}>
            <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="All entities" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All entities</SelectItem>
              {ENTITIES.map((e) => <SelectItem key={e} value={e}>{e}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") apply() }}
              placeholder="Search summary…" className="pl-8 h-9 text-xs" />
          </div>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 text-xs" title="From date" />
          <div className="flex gap-2">
            <Button size="sm" className="h-9 flex-1 text-xs " onClick={apply}>
              <ScrollText className="h-3.5 w-3.5 mr-1" /> Apply Filters
            </Button>
            {/* RBAC-105 — server-side, permission-gated, audit-logged export */}
            {canExport && (
              <Button size="sm" variant="outline" className="h-9 text-xs bg-white dark:bg-slate-900" onClick={exportCsv} disabled={exporting}>
                <Download className="h-3.5 w-3.5 mr-1" /> {exporting ? "Exporting…" : "Export CSV"}
              </Button>
            )}
            <Button size="sm" variant="outline" className="h-9 text-xs bg-white dark:bg-slate-900"
              onClick={() => { setEntity(""); setQ(""); setFrom(""); setApplied({ entity: "", q: "", from: "" }) }}>
              Clear
            </Button>
          </div>
        </div>
        <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-2">
          Showing the latest {(data || []).length} entr{(data || []).length === 1 ? "y" : "ies"}{applied.entity ? ` · entity ${applied.entity}` : ""}{applied.from ? ` · since ${applied.from}` : ""}{applied.q ? ` · matching “${applied.q}”` : ""}.
        </p>
      </div>

      <DataTable
        columns={columns}
        rows={rows.length ? rows : undefined}
        loading={loading}
        error={error}
        pageSize={20}
        dense
        searchPlaceholder="Filter visible rows…"
        emptyTitle="No audit entries match"
        emptyHint="Clear the filters or pick another date range."
      />

      {/* M-13 — cursor pagination: fetch the next page on demand */}
      {nextCursor && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more entries"}
          </Button>
        </div>
      )}

      <SectionCard title="Retention & integrity">
        <p className="text-xs text-slate-500 leading-relaxed">
          Audit logs are append-only: entries cannot be edited or deleted through the application. Export is available
          to roles holding <span className="font-mono text-[10px] bg-slate-100 dark:bg-slate-800 px-1 rounded">audit.export</span> permission.
          Retention: entries are kept for 5 years (Bangladesh labour-law record-keeping horizon), then purged by the
          scheduled retention job (<span className="font-mono text-[10px] bg-slate-100 dark:bg-slate-800 px-1 rounded">jobs.ts → auditRetention</span>).
          Employee-change entries store only the changed fields with sensitive values masked (M-13).
        </p>
      </SectionCard>
      </>
      )}
    </div>
  )
}

// ================= R16 — Login audit tab =================
function LoginAuditTab() {
  const { toast } = useHrm()
  const [outcome, setOutcome] = useState("")
  const [email, setEmail] = useState("")
  const [applied, setApplied] = useState<any>({})

  const { data, loading, error, reload } = useApi<any>(
    "audit.logins.list",
    {
      success: applied.outcome === "success" ? true : applied.outcome === "failed" ? false : undefined,
      email: applied.email || undefined,
      from: applied.from || undefined,
      to: applied.to || undefined,
      limit: 50,
    },
  )

  const columns: Column<any>[] = [
    { key: "createdAt", label: "When", sortValue: (r) => String(r.createdAt), render: (r) => <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300 whitespace-nowrap">{fmtDateTime(r.createdAt)}</span> },
    { key: "email", label: "Account", render: (r) => (
      <div>
        <p className="text-xs font-medium text-slate-700 dark:text-slate-200">{r.email || "—"}</p>
        {r.userName && <p className="text-[10px] text-slate-500">{r.userName}{r.role ? ` · ${r.role}` : ""}</p>}
      </div>
    ) },
    { key: "success", label: "Outcome", render: (r) => r.success ? (
      <Badge className="bg-emerald-100 text-emerald-700 text-[10px]">SUCCESS{r.mfaUsed ? " · MFA" : ""}</Badge>
    ) : (
      <Badge className="bg-rose-100 text-rose-700 text-[10px]">{r.failureReason || "FAILED"}</Badge>
    ) },
    { key: "device", label: "Device / browser", render: (r) => (
      <div className="flex items-start gap-1.5">
        <MonitorSmartphone className="h-3.5 w-3.5 text-slate-400 mt-0.5 shrink-0" />
        <div>
          <p className="text-xs text-slate-600 dark:text-slate-300">{r.browser || "Unknown browser"} · {r.os || "unknown OS"}</p>
          <p className="text-[10px] text-slate-400 uppercase tracking-wide">{r.deviceType || "unknown"}</p>
        </div>
      </div>
    ) },
    { key: "ip", label: "IP", render: (r) => <span className="text-[10px] tabular-nums text-slate-400 font-mono">{r.ip || "—"}</span> },
  ]

  const summary = data?.summary
  const topIps: { ip: string | null; count: number }[] = data?.topIps || []

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        {[
          { label: "Total attempts", value: summary?.total ?? "—" },
          { label: "Successful", value: summary?.success ?? "—" },
          { label: "Failed", value: summary?.failed ?? "—" },
          { label: "Failure rate", value: summary && summary.total ? `${Math.round((summary.failed / Math.max(1, summary.total)) * 100)}%` : "—" },
        ].map((s) => (
          <div key={s.label} className="rounded-xl border bg-white dark:bg-slate-900 p-3">
            <p className="text-[10px] uppercase tracking-wide text-slate-500">{s.label}</p>
            <p className="text-lg font-bold tabular-nums mt-0.5">{s.value}</p>
          </div>
        ))}
      </div>

      <SectionCard title="Filters">
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <label className="text-[10px] uppercase tracking-wide text-slate-500">Outcome</label>
            <Select value={outcome || "all"} onValueChange={(v) => setOutcome(v === "all" ? "" : v)}>
              <SelectTrigger className="h-9 w-36 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="success">Successful</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-[10px] uppercase tracking-wide text-slate-500">Email contains</label>
            <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="user@company.com" className="h-9 w-52 text-xs" />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] uppercase tracking-wide text-slate-500">From date</label>
            <Input type="date" value={applied.fromDate} onChange={(e) => setApplied((a: any) => ({ ...a, fromDate: e.target.value }))} className="h-9 w-36 text-xs" />
          </div>
          <Button size="sm" className="h-9" onClick={() => {
            setApplied({ outcome, email, from: applied.fromDate })
            reload()
            toast("Filters applied")
          }}>Apply</Button>
        </div>
      </SectionCard>

      {topIps.length > 0 && (
        <SectionCard title="Top source IPs">
          <div className="flex flex-wrap gap-2">
            {topIps.map((t) => (
              <Badge key={t.ip || "?"} variant="outline" className="text-[10px] font-mono">
                {t.ip || "unknown"} · {t.count} attempt{t.count === 1 ? "" : "s"}
              </Badge>
            ))}
          </div>
        </SectionCard>
      )}

      <DataTable
        columns={columns}
        rows={data?.items || []}
        loading={loading}
        error={error}
        pageSize={20}
        dense
        searchPlaceholder="Filter visible rows…"
        emptyTitle="No login attempts recorded"
        emptyHint="Sign-in attempts (successful and failed) appear here in real time."
      />

      <SectionCard title="What is recorded & privacy">
        <p className="text-xs text-slate-500 leading-relaxed">
          Every sign-in attempt on this workspace — successful and failed — is recorded with the attempted account,
          resolved user identity (when the account exists), the source IP, the full User-Agent and derived
          browser/OS/device labels. MFA-factor failures and lockouts are included. Rows are purged after the
          retention window configured in <span className="font-mono text-[10px] bg-slate-100 dark:bg-slate-800 px-1 rounded">Settings → Security → Login audit retention</span>
          (default 180 days). Access requires the <span className="font-mono text-[10px] bg-slate-100 dark:bg-slate-800 px-1 rounded">audit.view</span> permission.
        </p>
      </SectionCard>
    </div>
  )
}
