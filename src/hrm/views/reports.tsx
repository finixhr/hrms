"use client"
// ============ HR Reports — the thin host view ============
// Reports overhaul — the classic 50-entry report list, its filter bar,
// charts, print modal, legacy PII dialog and deprecation banner are RETIRED.
// This view is now a thin host:
//   - PageHeader + the reports.view permission gate
//   - ONE catalogue fetch (analytics.report.catalog) with loading / error
//     states; the unified workspace (views/analytics-workspace.tsx) renders
//     everything the user interacts with (sidebar, dynamic filter bar,
//     structured preview, enterprise exports)
//   - ?report=<key> deep links flow to the workspace, normalized there
//     against the catalogue ("workspace" → none, bare legacy key →
//     legacy.<key>, "attendanceOverview" → attendance.overview)
//   - the retained Templates & Scheduled Delivery section (reports.schedule
//     holders) — the workspace raises onSaveTemplate with the current report
//     + applied filters; this host owns the editor dialog and delivery log
import { useMemo, useState } from "react"
import { CalendarClock, Mail, Pencil, PlayCircle, Plus, Save, ShieldCheck, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useHrm } from "../store"
import { useApi, rpc } from "../api"
import type { ReportCatalog, CatalogDefinition } from "../shared/analytics-report"
import { PageHeader, SectionCard, RowIconButton, LoadingRows, EmptyState, FieldError, fmtDateTime } from "../shared/ui-kit"
import { ConfirmDialog } from "../shared/form-dialog"
import dynamic from "next/dynamic"

// The unified HR Reports workspace (catalogue sidebar + dynamic filter bar +
// structured preview + PDF/XLSX/CSV exports). Lazy like every heavy view.
const AnalyticsWorkspace = dynamic(() => import("./analytics-workspace"), {
  loading: () => <div className="h-64 rounded-xl bg-slate-100 dark:bg-slate-800 animate-pulse" />,
})

/** Business-domain category order — client mirror of the server's
 *  REPORT_CATEGORIES (report-meta.ts) so the template dialog's grouped
 *  select matches the workspace sidebar's section order. */
const CATEGORY_ORDER = [
  "Employees", "Workforce", "Attendance", "Leave", "Payroll", "Performance",
  "Loans & Advances", "Assets", "Recruitment", "Field Operations", "Finance & Accounting",
]
const categoryRank = (c: string): number => {
  const i = CATEGORY_ORDER.indexOf(c)
  return i === -1 ? CATEGORY_ORDER.length : i
}

type TemplateRecipient = { email: string; name?: string }
type ReportTemplate = {
  id: string; name: string; reportKey: string; filters: Record<string, unknown>
  format: string; schedule: string; recipients: TemplateRecipient[]
  lastRunAt: string | null; lastStatus: string | null; active: boolean
  createdByName?: string | null; createdAt: string
}
type DeliveryLog = {
  id: string; templateId: string; templateName: string; reportKey: string
  format: string; status: string; detail?: string | null
  recipientCount: number; rows?: number | null; startedAt: string
}

const SCHEDULE_BADGE: Record<string, { label: string; cls: string }> = {
  OFF: { label: "Manual", cls: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400" },
  DAILY: { label: "Daily", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" },
  WEEKLY: { label: "Weekly", cls: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300" },
  MONTHLY: { label: "Monthly", cls: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300" },
}

const STATUS_CHIP: Record<string, string> = {
  SENT: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  FAILED: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  SKIPPED: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
}

const ScheduleBadge = ({ schedule }: { schedule: string }) => {
  const b = SCHEDULE_BADGE[schedule] || SCHEDULE_BADGE.OFF
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${b.cls}`}>{b.label}</span>
}

const StatusChip = ({ status }: { status: string }) => (
  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_CHIP[status] || STATUS_CHIP.SKIPPED}`}>{status}</span>
)

/** "Month: October · Branch: Gulshan" — readable summary of a stored filter
 *  object (label map mirrors the server's describeFilters vocabulary). */
function summarizeFilters(filters: Record<string, unknown> | null | undefined): string {
  const LABELS: Record<string, string> = {
    branchId: "Branch", departmentId: "Department", employeeId: "Employee",
    status: "Status", employmentType: "Employment type", month: "Month", year: "Year",
    from: "From", to: "To", dimension: "Group by", runType: "Run type", cycleId: "Cycle",
    divisor: "Divisor", eligibleOnly: "Eligible only", percent: "Percent", basis: "Basis",
    withinDays: "Within days", eventType: "Event type",
  }
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
  const bits = Object.entries(filters || {}).filter(([, v]) => v !== "" && v != null).map(([k, v]) => {
    const label = LABELS[k] ?? k
    const text = k === "month" && Number(v) >= 1 && Number(v) <= 12 ? MONTHS[Number(v) - 1] : String(v)
    return `${label}: ${text}`
  })
  return bits.length ? bits.join(" · ") : "No filters (whole company scope)"
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default function ReportsView() {
  const { can, toast } = useHrm()
  const view = useHrm((s) => s.view)
  const allowed = can("reports", "view")
  const canSchedule = can("reports", "schedule")

  // ONE catalogue fetch for the whole page — loading and error states are
  // handled HERE (the workspace receives resolved data only).
  const catalogApi = useApi<ReportCatalog>(allowed ? "analytics.report.catalog" : null, {})

  // ---- Wave 4 — saved templates + scheduled delivery (reports.schedule only) ----
  const templatesApi = useApi<{ templates: ReportTemplate[]; deliveries: DeliveryLog[] }>(
    allowed && canSchedule ? "reports.templates.list" : null, {},
  )
  const templates = templatesApi.data?.templates || []
  const deliveries = templatesApi.data?.deliveries || []
  const [tplDialog, setTplDialog] = useState<{ mode: "new"; reportId: string | null; filters: Record<string, unknown> } | { mode: "edit"; tpl: ReportTemplate } | null>(null)
  const [deleting, setDeleting] = useState<ReportTemplate | null>(null)
  const [runningId, setRunningId] = useState<string | null>(null)

  // ?report=<key> deep link — normalized inside the workspace against the
  // catalogue ("workspace" → no selection, bare legacy key → legacy.<key>).
  const deepLinkReport = (view?.params as any)?.report as string | undefined

  // Template rows name a catalogue reportId (or, on older templates, a bare
  // legacy key) — resolve the business title either way.
  const reportLabelOf = (key: string): string => {
    const defs = catalogApi.data?.definitions
    if (!defs) return key
    return defs.find((d) => d.reportId === key)?.title
      || defs.find((d) => d.reportId === `legacy.${key}`)?.title
      || key
  }

  const runTemplateNow = async (t: ReportTemplate) => {
    setRunningId(t.id)
    try {
      const res = await rpc<{ status: string; detail: string | null; rows: number | null }>("reports.templates.runNow", { id: t.id })
      if (res.status === "SENT") toast(`"${t.name}" emailed — ${res.rows ?? 0} rows`)
      else if (res.status === "SKIPPED") toast(`"${t.name}" skipped — ${res.detail || "no recipients or gateway not configured"}`)
      else toast(`"${t.name}" failed — ${res.detail || "see delivery history"}`, "err")
      templatesApi.reload()
    } catch (e: any) {
      toast(e?.message || "Run failed", "err")
    } finally {
      setRunningId(null)
    }
  }

  if (!allowed) {
    return (
      <div className="rounded-xl border bg-white dark:bg-slate-900 p-10 text-center shadow-sm">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 dark:bg-emerald-950">
          <ShieldCheck className="h-6 w-6 text-emerald-600" />
        </div>
        <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">HR Reports is not available on your role</p>
        <p className="mx-auto mt-1 max-w-sm text-xs text-slate-500 dark:text-slate-400">
          The reports.view permission is required to browse the report catalogue and generate reports.
          Contact your administrator if you need access.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="HR Reports"
        subtitle="Generate, preview and export workforce reports"
      />

      {/* ---------- the unified workspace (catalogue + builder + preview) ---------- */}
      {catalogApi.loading && !catalogApi.data ? (
        <div className="grid lg:grid-cols-[300px_1fr] gap-4 items-start">
          <div className="h-[70vh] rounded-xl bg-slate-100 dark:bg-slate-800 animate-pulse" />
          <div className="h-[70vh] rounded-xl bg-slate-100 dark:bg-slate-800 animate-pulse" />
        </div>
      ) : catalogApi.error && !catalogApi.data ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-rose-200 bg-rose-50 dark:border-rose-900 dark:bg-rose-950/40 p-4">
          <p className="min-w-0 flex-1 text-sm text-rose-700 dark:text-rose-300">
            {catalogApi.error} — the report catalogue could not be loaded.
          </p>
          <Button size="sm" variant="outline" className="h-8 text-xs bg-white dark:bg-slate-900" onClick={() => catalogApi.reload()}>
            Retry
          </Button>
        </div>
      ) : (
        <AnalyticsWorkspace
          catalog={catalogApi.data}
          canSchedule={canSchedule}
          onSaveTemplate={(snap) => setTplDialog({ mode: "new", reportId: snap.reportId, filters: snap.filters })}
          deepLinkReport={deepLinkReport}
        />
      )}

      {/* ---------- Wave 4 — saved templates + scheduled delivery (reports.schedule only) ---------- */}
      {canSchedule && (
        <SectionCard
          title={
            <span className="flex items-center gap-1.5">
              <CalendarClock className="h-3.5 w-3.5 text-emerald-600" /> Saved Templates &amp; Scheduled Delivery
            </span>
          }
          description="Deliver a pinned report + filters by email — on demand or on a daily / weekly / monthly schedule."
        >
          {templatesApi.loading && !templates.length ? (
            <LoadingRows rows={3} />
          ) : templatesApi.error && !templates.length ? (
            <EmptyState icon={Mail} title="Could not load templates" hint={templatesApi.error} />
          ) : !templates.length ? (
            <EmptyState
              icon={CalendarClock}
              title="No saved templates yet"
              hint="Open a report, set the filters and press “Save as template” in the workspace — then run it on demand or email it on a daily/weekly/monthly schedule."
            />
          ) : (
            <>
              <div className="overflow-x-auto -mx-2 px-2">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wide text-slate-400 border-b">
                      <th className="py-2 pr-3 font-semibold">Name</th>
                      <th className="py-2 pr-3 font-semibold">Report</th>
                      <th className="py-2 pr-3 font-semibold">Schedule</th>
                      <th className="py-2 pr-3 font-semibold">Format</th>
                      <th className="py-2 pr-3 font-semibold">Recipients</th>
                      <th className="py-2 pr-3 font-semibold">Last run</th>
                      <th className="py-2 font-semibold text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {templates.map((t) => (
                      <tr key={t.id} className="border-b border-slate-100 dark:border-slate-800 last:border-0 hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                        <td className="py-2 pr-3 max-w-[180px]">
                          <p className="font-medium text-slate-700 dark:text-slate-200 truncate">{t.name}</p>
                          <p className="text-[10px] text-slate-400 truncate">{summarizeFilters(t.filters)}</p>
                        </td>
                        <td className="py-2 pr-3 text-slate-600 dark:text-slate-300 max-w-[140px] truncate">{reportLabelOf(t.reportKey)}</td>
                        <td className="py-2 pr-3"><ScheduleBadge schedule={t.schedule} /></td>
                        <td className="py-2 pr-3 text-slate-500 dark:text-slate-400 font-mono text-[10px]">{t.format}</td>
                        <td className="py-2 pr-3 text-slate-600 dark:text-slate-300">
                          <span className="inline-flex items-center gap-1"><Mail className="h-3 w-3 text-slate-400" />{t.recipients?.length || 0}</span>
                        </td>
                        <td className="py-2 pr-3 whitespace-nowrap">
                          {t.lastRunAt ? (
                            <span className="flex flex-col gap-0.5">
                              <span className="text-slate-500 dark:text-slate-400 text-[10px]">{fmtDateTime(t.lastRunAt)}</span>
                              {t.lastStatus && <StatusChip status={t.lastStatus} />}
                            </span>
                          ) : (
                            <span className="text-[10px] text-slate-400">never run</span>
                          )}
                        </td>
                        <td className="py-2 text-right">
                          <div className="inline-flex items-center gap-0.5">
                            <RowIconButton icon={PlayCircle} label="Run now" tone="brand" disabled={runningId === t.id}
                              onClick={() => { void runTemplateNow(t) }} />
                            <RowIconButton icon={Pencil} label="Edit template" disabled={runningId === t.id}
                              onClick={() => setTplDialog({ mode: "edit", tpl: t })} />
                            <RowIconButton icon={Trash2} label="Delete template" tone="danger" disabled={runningId === t.id}
                              onClick={() => setDeleting(t)} />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-[11px] text-slate-400">
                Scheduled sends go out via your email gateway (Settings → Email Gateway) around {new Date().getUTCHours()}:00 UTC — “Run now” delivers immediately.
              </p>
            </>
          )}

          {/* ---- recent deliveries (last 20) ---- */}
          <div className="mt-4 border-t border-dashed border-slate-200 dark:border-slate-700 pt-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 flex items-center gap-1 mb-2">
              <Mail className="h-3 w-3" /> Recent deliveries
            </p>
            {templatesApi.loading && !deliveries.length ? (
              <LoadingRows rows={2} />
            ) : !deliveries.length ? (
              <p className="text-xs text-slate-400 py-2">No deliveries yet — run a template or wait for the schedule.</p>
            ) : (
              <div className="max-h-64 overflow-y-auto space-y-1.5 pr-1">
                {deliveries.map((d) => (
                  <div key={d.id} className="flex items-center gap-2 rounded-lg border border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1.5">
                    <StatusChip status={d.status} />
                    <span className="text-xs font-medium text-slate-700 dark:text-slate-200 truncate max-w-[160px]">{d.templateName}</span>
                    <span className="text-[10px] text-slate-400 font-mono truncate hidden sm:inline">{d.reportKey}.{d.format.toLowerCase()}</span>
                    <span className="text-[10px] text-slate-400 whitespace-nowrap hidden md:inline">{d.rows != null ? `${d.rows} rows` : "—"} · {d.recipientCount} rcpt</span>
                    {d.detail && <span className="text-[10px] text-slate-400 truncate hidden lg:inline max-w-[220px]" title={d.detail}>{d.detail}</span>}
                    <span className="ml-auto text-[10px] text-slate-400 whitespace-nowrap">{fmtDateTime(d.startedAt)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </SectionCard>
      )}

      {/* Wave 4 — template editor (keyed remount: fresh state every open) */}
      {tplDialog && (
        <TemplateDialog
          key={tplDialog.mode === "edit" ? `edit-${tplDialog.tpl.id}` : "new"}
          initial={tplDialog.mode === "edit" ? tplDialog.tpl : null}
          defaultReportId={tplDialog.mode === "new" ? tplDialog.reportId : null}
          filtersSnapshot={tplDialog.mode === "new" ? tplDialog.filters : {}}
          filterSummary={tplDialog.mode === "new" ? summarizeFilters(tplDialog.filters) : ""}
          catalog={catalogApi.data}
          onDone={() => { setTplDialog(null); templatesApi.reload() }}
          onCancel={() => setTplDialog(null)}
        />
      )}

      {/* Wave 4 — delete confirmation */}
      {deleting && (
        <ConfirmDialog
          open
          onOpenChange={(v) => { if (!v) setDeleting(null) }}
          title="Delete template"
          message={`Delete “${deleting.name}”? Its schedule stops immediately. Past delivery records are kept for audit.`}
          confirmLabel="Delete template"
          danger
          onConfirm={async () => {
            await rpc("reports.templates.delete", { id: deleting.id })
            templatesApi.reload()
          }}
        />
      )}
    </div>
  )
}

// ---------------- Wave 4 — template editor dialog ----------------
/** Create/edit a saved report template. Purpose-built (not FormDialog) because
 *  recipients are a REPEATABLE email input list (max 10), which the schema-
 *  driven form engine does not model. State is initialized once per mount;
 *  the parent mounts it conditionally + keyed so every open starts fresh —
 *  no setState-in-effect, no input wipe on parent re-renders.
 *
 *  Reports overhaul — the report list comes from the passed CATALOGUE
 *  (analytics.report.catalog definitions, grouped by business category);
 *  older templates that stored a bare legacy key are normalized to their
 *  legacy.<key> catalogue id, and PDF joins XLSX/CSV as a delivery format. */
function TemplateDialog({ initial, defaultReportId, filtersSnapshot, filterSummary, catalog, onDone, onCancel }: {
  initial: ReportTemplate | null
  defaultReportId: string | null
  /** filters captured from the ACTIVE report filter bar (create flow only) */
  filtersSnapshot: Record<string, unknown>
  filterSummary: string
  catalog: ReportCatalog | null
  onDone: () => void
  onCancel: () => void
}) {
  const toast = useHrm((s) => s.toast)
  const definitions = useMemo(() => (catalog?.definitions || [])
    .slice()
    .sort((a, b) => categoryRank(a.category) - categoryRank(b.category) || a.title.localeCompare(b.title)), [catalog])
  const groupedDefs = useMemo(() => {
    const out = new Map<string, CatalogDefinition[]>()
    for (const d of definitions) out.set(d.category, [...(out.get(d.category) || []), d])
    return [...out.entries()]
  }, [definitions])

  const [name, setName] = useState(initial?.name || "")
  const [reportKey, setReportKey] = useState(() => {
    const known = (k: string) => definitions.some((d) => d.reportId === k)
    if (initial?.reportKey) {
      // older templates store bare legacy keys — normalize to the catalogue id
      const k = known(initial.reportKey) ? initial.reportKey : `legacy.${initial.reportKey}`
      if (known(k)) return k
    }
    if (defaultReportId && known(defaultReportId)) return defaultReportId
    return definitions[0]?.reportId || ""
  })
  const [format, setFormat] = useState(initial?.format === "CSV" ? "CSV" : initial?.format === "PDF" ? "PDF" : "XLSX")
  const [schedule, setSchedule] = useState(initial?.schedule || "OFF")
  const [active, setActive] = useState(initial?.active ?? true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // stable per-row ids (index keys would bleed input focus on remove)
  // T-11 — ids are derived, not ref-counted: the initializer assigns
  // index-based ids (evaluated once per mount) and addRecipient derives the
  // next id from the current rows, so no ref is touched during render.
  const [recipients, setRecipients] = useState<{ id: number; email: string; name: string }[]>(() => {
    const rows = (initial?.recipients || []).map((r) => ({ email: r.email || "", name: r.name || "" }))
    return (rows.length ? rows : [{ email: "", name: "" }]).map((r, i) => ({ ...r, id: i + 1 }))
  })
  const addRecipient = () => {
    if (recipients.length >= 10) return
    setRecipients((rs) => [...rs, { id: (rs[rs.length - 1]?.id ?? 0) + 1, email: "", name: "" }])
  }
  const setRecipient = (id: number, field: "email" | "name", value: string) => {
    setRecipients((rs) => rs.map((r) => (r.id === id ? { ...r, [field]: value } : r)))
  }
  const removeRecipient = (id: number) => {
    setRecipients((rs) => (rs.length <= 1 ? rs : rs.filter((r) => r.id !== id)))
  }

  const filtersShown: Record<string, unknown> = initial ? initial.filters : filtersSnapshot
  const filtersSummaryShown = initial ? summarizeFilters(initial.filters) : filterSummary

  const submit = async () => {
    const cleanName = name.trim()
    if (cleanName.length < 2) { setError("Template name is required (2–80 characters)."); return }
    const valid = recipients
      .map((r) => ({ email: r.email.trim().toLowerCase(), name: r.name.trim() }))
      .filter((r) => r.email)
    if (recipients.some((r) => r.email.trim() && !EMAIL_RE.test(r.email.trim()))) {
      setError("One or more recipient emails look invalid — check the addresses.")
      return
    }
    if (!valid.length) { setError("At least one recipient email is required."); return }
    if (!reportKey) { setError("Pick a report from the catalogue."); return }
    setBusy(true)
    setError(null)
    try {
      await rpc("reports.templates.save", {
        ...(initial ? { id: initial.id } : {}),
        name: cleanName,
        reportKey,
        filters: initial ? initial.filters : filtersSnapshot,
        format,
        schedule,
        recipients: valid.map((r) => (r.name ? { email: r.email, name: r.name } : { email: r.email })),
        active,
      })
      toast(`Template “${cleanName}” saved`)
      onDone()
    } catch (e: any) {
      setError(e?.message || "Save failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v && !busy) onCancel() }}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">{initial ? `Edit template — ${initial.name}` : "Save current as template"}</DialogTitle>
          <p className="text-xs text-slate-500">
            Pin a report + filters, then deliver it on a schedule or on demand via your email gateway.
          </p>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-2.5 py-1">
          <div className="space-y-1">
            <Label htmlFor="tpl-name" className="text-xs font-medium text-slate-600 dark:text-slate-300">
              Template name <span className="text-rose-500">*</span>
            </Label>
            <Input id="tpl-name" value={name} maxLength={80} placeholder="e.g. Monthly attendance digest"
              onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="tpl-report" className="text-xs font-medium text-slate-600 dark:text-slate-300">Report</Label>
            <Select value={reportKey} onValueChange={setReportKey}>
              <SelectTrigger id="tpl-report" className="text-xs"><SelectValue placeholder="Pick a report" /></SelectTrigger>
              <SelectContent>
                {groupedDefs.map(([cat, defs]) => (
                  <SelectGroup key={cat}>
                    <SelectLabel className="text-[10px] uppercase tracking-wide text-slate-400">{cat}</SelectLabel>
                    {defs.map((d) => (
                      <SelectItem key={d.reportId} value={d.reportId}>{d.title}</SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="tpl-format" className="text-xs font-medium text-slate-600 dark:text-slate-300">File format</Label>
            <Select value={format} onValueChange={setFormat}>
              <SelectTrigger id="tpl-format" className="text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="XLSX">Excel (.xlsx)</SelectItem>
                <SelectItem value="CSV">CSV (.csv)</SelectItem>
                <SelectItem value="PDF">PDF (.pdf)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="tpl-schedule" className="text-xs font-medium text-slate-600 dark:text-slate-300">Schedule</Label>
            <Select value={schedule} onValueChange={setSchedule}>
              <SelectTrigger id="tpl-schedule" className="text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="OFF">Manual — run on demand only</SelectItem>
                <SelectItem value="DAILY">Daily</SelectItem>
                <SelectItem value="WEEKLY">Weekly (from Monday)</SelectItem>
                <SelectItem value="MONTHLY">Monthly (from the 1st)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* current/stored filters — read-only snapshot */}
          <div className="sm:col-span-2 rounded-lg border bg-slate-50 dark:bg-slate-900 p-2.5 space-y-1">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              {initial ? "Stored filters (read-only)" : "Current filters (read-only)"}
            </p>
            <p className="text-xs text-slate-600 dark:text-slate-300">{filtersSummaryShown}</p>
            <pre className="text-[10px] leading-relaxed text-slate-400 whitespace-pre-wrap break-all font-mono max-h-16 overflow-y-auto">
              {JSON.stringify(filtersShown)}
            </pre>
          </div>

          {/* repeatable recipient inputs */}
          <div className="sm:col-span-2 space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-medium text-slate-600 dark:text-slate-300">
                Recipients <span className="text-rose-500">*</span>
              </Label>
              <Button type="button" size="sm" variant="outline" className="h-7 text-xs bg-white dark:bg-slate-900"
                onClick={addRecipient} disabled={recipients.length >= 10}>
                <Plus className="h-3.5 w-3.5 mr-1" /> Add ({recipients.length}/10)
              </Button>
            </div>
            <div className="space-y-1.5 max-h-44 overflow-y-auto pr-1">
              {recipients.map((r) => (
                <div key={r.id} className="flex items-center gap-1.5">
                  <Input type="email" placeholder="name@company.com" value={r.email} maxLength={160}
                    className="h-8 flex-[1.6] text-xs" aria-label={`Recipient email ${r.id}`}
                    onChange={(e) => setRecipient(r.id, "email", e.target.value)} />
                  <Input placeholder="Name (optional)" value={r.name} maxLength={80}
                    className="h-8 flex-1 text-xs" aria-label={`Recipient name ${r.id}`}
                    onChange={(e) => setRecipient(r.id, "name", e.target.value)} />
                  <RowIconButton icon={Trash2} label="Remove recipient" tone="danger"
                    disabled={recipients.length <= 1} onClick={() => removeRecipient(r.id)} />
                </div>
              ))}
            </div>
          </div>

          <div className="sm:col-span-2 flex items-center gap-2 pt-1">
            <Switch id="tpl-active" checked={active} onCheckedChange={setActive} />
            <Label htmlFor="tpl-active" className="text-xs font-medium text-slate-600 dark:text-slate-300">
              Active {schedule === "OFF" ? "(matters once a schedule is set)" : "(scheduled sends enabled)"}
            </Label>
          </div>
        </div>
        {/* M-9 — announced to screen readers (role=alert) */}
        <FieldError message={error} />
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button onClick={() => { void submit() }} disabled={busy}>
            <Save className="mr-1 h-3.5 w-3.5" /> {busy ? "Saving…" : initial ? "Save changes" : "Save template"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
