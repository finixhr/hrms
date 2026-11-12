"use client"
// ============ HR Reports — the unified reports workspace ============
// Reports overhaul — ONE surface for every report the tenant can run:
//   - catalogue sidebar straight from the SERVER registry
//     (analytics.report.catalog): business-domain categories (collapsible),
//     favourites, search, PII / Analytics badges, and locked advanced-tier
//     reports with an upgrade affordance (→ Billing).
//   - a DYNAMIC filter bar: renders only the selected report's advertised
//     filterFields, enum options straight from the server's filters spec;
//     per-report filter memory (localStorage) + saved filter sets.
//   - explicit generate → structured preview (KPIs / charts / table /
//     warnings / methodology) through the shared AnalyticsReportView.
//   - enterprise outputs — PDF / XLSX / CSV through the background
//     generation lane (submit → poll → download), gated on the export
//     permission (reports.pii.export for PII reports, with the HIGH-11
//     typed "EXPORT" confirmation dialog).
//   - the FIN-077 monthly-snapshot callout for Workforce reports.
// The parent (views/reports.tsx) fetches the catalogue ONCE and owns the
// Templates & Scheduled Delivery section; the workspace raises
// onSaveTemplate with the current report + applied filters.
import { useEffect, useMemo, useRef, useState } from "react"
import {
  PlayCircle, Search, Star, Trash2, DatabaseZap, Download, FileSpreadsheet, FileType2, CalendarRange,
  ChevronDown, ChevronRight, Lock, Filter, RotateCcw, Save, ShieldCheck, FileBarChart, Check, ChevronsUpDown,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useHrm } from "../store"
import { rpc, useLookup, useEmployeeDirectory } from "../api"
import {
  AnalyticsReportView, describeFilters,
  type StructuredReport, type ReportCatalog, type CatalogDefinition, type LockedCatalogDefinition,
} from "../shared/analytics-report"
import { SectionCard, EmptyState, fmtDateTime } from "../shared/ui-kit"

// ---- persistence keys (favourites + saved filter sets keep their legacy keys) ----
const FAV_KEY = "finix-workspace-favs"
const SAVED_KEY = "finix-workspace-saved"
const FILTER_CACHE_PREFIX = "finix-ws-filter-"

/** Business-domain category order — client mirror of the server's
 *  REPORT_CATEGORIES (report-meta.ts) so sections keep a stable, sensible
 *  order; unknown categories sort last, alphabetically. */
const CATEGORY_ORDER = [
  "Employees", "Workforce", "Attendance", "Leave", "Payroll", "Performance",
  "Loans & Advances", "Assets", "Recruitment", "Field Operations", "Finance & Accounting",
]
const categoryRank = (c: string): number => {
  const i = CATEGORY_ORDER.indexOf(c)
  return i === -1 ? CATEGORY_ORDER.length : i
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

/** Small labels for the dynamic filter bar (mirrors the server's
 *  describeFilters() vocabulary so a filter reads the same everywhere). */
const FIELD_LABELS: Record<string, string> = {
  month: "Month", year: "Year", from: "From", to: "To",
  branchId: "Branch", departmentId: "Department", employeeId: "Employee",
  status: "Status", employmentType: "Employment type", dimension: "Group by",
  runType: "Run type", cycleId: "Cycle", divisor: "Divisor",
  eligibleOnly: "Eligible only", percent: "Percent (%)", basis: "Basis",
  withinDays: "Within days", eventType: "Event type",
}

type SavedFilter = { id: string; reportId: string; label: string; params: Record<string, unknown>; savedAt: string }
type Artifact = { filename: string; base64: string; contentType: string }
type GenState = { status: string; progress: number; artifact?: Artifact }
type ExportFormat = "PDF" | "XLSX" | "CSV"

export type AnalyticsWorkspaceProps = {
  /** the analytics.report.catalog payload — fetched ONCE by the parent
   *  (loading / error states are handled there; null is tolerated). */
  catalog: ReportCatalog | null
  /** reports.schedule holders see the "Save as template" affordance */
  canSchedule?: boolean
  /** raised when the user saves the current report + filters as a delivery
   *  template — the parent owns the TemplateDialog. */
  onSaveTemplate?: (snapshot: { reportId: string; filters: Record<string, unknown> }) => void
  /** the ?report= deep-link key from the view params (normalized against the
   *  catalogue internally: "workspace" → none, bare legacy key → legacy.<key>,
   *  "attendanceOverview" → attendance.overview). */
  deepLinkReport?: string
}

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback
  try { return JSON.parse(window.localStorage.getItem(key) || "") as T } catch { return fallback }
}
function writeJson(key: string, v: unknown) {
  try { window.localStorage.setItem(key, JSON.stringify(v)) } catch { /* quota/private mode */ }
}

function todayIso(): string { return new Date().toISOString().slice(0, 10) }
/** Default "From": the 1st of the month, eleven months back (a rolling year). */
function defaultFrom(): string {
  const d = new Date()
  d.setMonth(d.getMonth() - 11)
  return `${d.toISOString().slice(0, 7)}-01`
}

/** Default values for a report's advertised filter vocabulary (from/to window,
 *  current month/year, the server's dimension default, the handler defaults
 *  for withinDays=60 / percent=100). Overlaid with the cached per-report
 *  values by selectReport(). */
function defaultFilterValues(def: CatalogDefinition): Record<string, string> {
  const fields = def.filterFields?.length ? def.filterFields : Object.keys(def.filters || {})
  const now = new Date()
  const out: Record<string, string> = {}
  for (const f of fields) {
    switch (f) {
      case "from": out.from = defaultFrom(); break
      case "to": out.to = todayIso(); break
      case "month": out.month = String(now.getMonth() + 1); break
      case "year": out.year = String(now.getFullYear()); break
      case "dimension": {
        const spec = def.filters?.dimension
        out.dimension = spec?.default != null ? String(spec.default) : (spec?.options?.[0]?.value ?? "")
        break
      }
      case "withinDays": out.withinDays = "60"; break
      case "percent": out.percent = "100"; break
      default: out[f] = ""
    }
  }
  return out
}

/** Deep-link normalization: "workspace" → no selection; the pre-overhaul
 *  attendanceOverview pseudo-key → the structured attendance.overview; a bare
 *  legacy key → its legacy.<key> catalogue id; a structured id passes through
 *  when the catalogue actually offers it (locked/unknown keys → no selection). */
function normalizeDeepLinkKey(raw: string, catalog: ReportCatalog | null): string | null {
  if (!raw) return null
  if (raw === "workspace") return null
  if (raw === "attendanceOverview") return "attendance.overview"
  const defs = catalog?.definitions
  if (!defs || !defs.length) return null
  if (defs.some((d) => d.reportId === raw)) return raw
  const legacy = `legacy.${raw}`
  if (defs.some((d) => d.reportId === legacy)) return legacy
  return null
}

export default function AnalyticsWorkspace({ catalog, canSchedule, onSaveTemplate, deepLinkReport }: AnalyticsWorkspaceProps) {
  const { can, navigate } = useHrm()
  const canExport = can("reports", "export")
  const canPiiExport = can("reports", "pii.export")
  // FIN-081 — PII-class reports render under reports.pii.view (server-enforced
  // in the definition's permission pair; this client check only keeps the
  // affordance honest — a stale client cannot bypass the dispatcher).
  const canPiiView = can("reports", "pii.view")

  const [q, setQ] = useState("")
  const [selected, setSelected] = useState<string | null>(null)
  const [favs, setFavs] = useState<string[]>([])
  const [saved, setSaved] = useState<SavedFilter[]>([])
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [snapshotInfo, setSnapshotInfo] = useState<{ count: number; first: string; last: string } | null>(null)

  // the dynamic filter state (values as STRINGS; typed on payload build)
  const [filterValues, setFilterValues] = useState<Record<string, string>>({})
  const [report, setReport] = useState<StructuredReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [genBusy, setGenBusy] = useState(false)
  const [genState, setGenState] = useState<GenState | null>(null)
  // HIGH-11 typed confirmation for PII-class exports (type "EXPORT" to enable)
  const [piiConfirm, setPiiConfirm] = useState<{ open: boolean; typed: string; format: ExportFormat | null }>({ open: false, typed: "", format: null })

  // lookups for the ref-typed filters (module-cached across mounts)
  const { data: branches } = useLookup<any[]>("branches.list", {}, !!catalog)
  const { data: departments } = useLookup<any[]>("departments.list", {}, !!catalog)
  const employees = useEmployeeDirectory()

  const definitions = useMemo(() => catalog?.definitions ?? [], [catalog])
  const lockedDefs = useMemo(() => catalog?.lockedDefinitions ?? [], [catalog])
  const activeDef: CatalogDefinition | null = useMemo(
    () => definitions.find((d) => d.reportId === selected) || null,
    [definitions, selected],
  )
  // the report's advertised filter vocabulary (fallback: the filters spec keys)
  const filterFields = useMemo(() => {
    if (!activeDef) return []
    return activeDef.filterFields?.length ? activeDef.filterFields : Object.keys(activeDef.filters || {})
  }, [activeDef])

  // cycles.list feeds the cycleId filter (performance reports); users without
  // performance.view fall back to a plain id input — the lookup error is inert.
  const needsCycles = filterFields.includes("cycleId")
  const { data: cycles } = useLookup<any[]>("cycles.list", {}, needsCycles)

  useEffect(() => {
    setFavs(readJson<string[]>(FAV_KEY, []))
    setSaved(readJson<SavedFilter[]>(SAVED_KEY, []))
    void (async () => {
      try {
        const s = await rpc<{ snapshots: { label: string }[] }>("analytics.snapshots.series", { months: 60 })
        const list = s.snapshots || []
        setSnapshotInfo(list.length
          ? { count: list.length, first: list[0]?.label || "", last: list[list.length - 1]?.label || "" }
          : { count: 0, first: "", last: "" })
      } catch { /* snapshot read is best-effort */ }
    })()
  }, [])

  /** Select a report (or none): reset the preview + generation state and load
   *  default filters overlaid with the per-report cached values. */
  const selectReport = (id: string | null) => {
    setSelected(id)
    setReport(null)
    setGenState(null)
    setError(null)
    setPiiConfirm({ open: false, typed: "", format: null })
    const def = id ? definitions.find((d) => d.reportId === id) : null
    if (!def) { setFilterValues({}); return }
    const values = defaultFilterValues(def)
    const cached = readJson<Record<string, unknown>>(FILTER_CACHE_PREFIX + def.reportId, {})
    for (const k of Object.keys(values)) {
      if (cached[k] !== undefined && cached[k] !== null) values[k] = String(cached[k])
    }
    setFilterValues(values)
  }

  // per-report filter memory — every change persists for the next visit
  useEffect(() => {
    if (!selected) return
    writeJson(FILTER_CACHE_PREFIX + selected, filterValues)
  }, [selected, filterValues])

  // deep links (?report=<key>): apply once per distinct key (a stale param
  // never yanks the user off their in-progress selection)
  const deepLinkApplied = useRef<string | null>(null)
  useEffect(() => {
    if (deepLinkReport === undefined) return
    if (deepLinkApplied.current === deepLinkReport) return
    deepLinkApplied.current = deepLinkReport
    selectReport(normalizeDeepLinkKey(deepLinkReport, catalog ?? null))
  }, [deepLinkReport])

  // ---- catalogue search + section grouping ----
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return definitions
    return definitions.filter((d) => d.title.toLowerCase().includes(needle) || d.category.toLowerCase().includes(needle))
  }, [definitions, q])

  const filteredLocked = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return lockedDefs
    return lockedDefs.filter((d) => d.title.toLowerCase().includes(needle) || (d.category || "").toLowerCase().includes(needle))
  }, [lockedDefs, q])

  const favDefs = useMemo(
    () => (q.trim() ? [] : definitions.filter((d) => favs.includes(d.reportId))),
    [definitions, favs, q],
  )

  const sections = useMemo(() => {
    const cats = new Map<string, { defs: CatalogDefinition[]; locked: LockedCatalogDefinition[] }>()
    for (const d of filtered) {
      const cur = cats.get(d.category) || { defs: [], locked: [] }
      cur.defs.push(d)
      cats.set(d.category, cur)
    }
    for (const l of filteredLocked) {
      const cur = cats.get(l.category) || { defs: [], locked: [] }
      cur.locked.push(l)
      cats.set(l.category, cur)
    }
    return [...cats.entries()].sort((a, b) => categoryRank(a[0]) - categoryRank(b[0]) || a[0].localeCompare(b[0]))
  }, [filtered, filteredLocked])

  const toggleFav = (id: string) => {
    setFavs((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
      writeJson(FAV_KEY, next)
      return next
    })
  }

  const setField = (field: string, value: string) => setFilterValues((prev) => ({ ...prev, [field]: value }))

  /** Only the report's advertised fields, only non-empty ones, correctly
   *  typed (month/year/withinDays/percent → number, eligibleOnly → boolean). */
  const buildFilterPayload = (): Record<string, unknown> => {
    const p: Record<string, unknown> = {}
    for (const f of filterFields) {
      const v = filterValues[f]
      if (v === undefined || v === null || v === "") continue
      if (f === "month" || f === "year" || f === "withinDays" || f === "percent") {
        const n = Number(v)
        if (Number.isFinite(n)) p[f] = n
      } else if (f === "eligibleOnly") {
        if (v === "1") p.eligibleOnly = true
      } else {
        p[f] = v
      }
    }
    return p
  }

  const generate = async (reportId: string, params: Record<string, unknown>) => {
    setBusy(true); setError(null)
    try {
      const data = await rpc<StructuredReport>("analytics.report.render", { reportId, ...params })
      setReport(data)
    } catch (e: any) {
      setReport(null)
      setError(e?.message || "Generation failed")
    } finally {
      setBusy(false)
    }
  }

  const resetFilters = () => {
    if (!activeDef) return
    try { window.localStorage.removeItem(FILTER_CACHE_PREFIX + activeDef.reportId) } catch { /* private mode */ }
    setFilterValues(defaultFilterValues(activeDef))
  }

  const saveCurrent = () => {
    if (!selected || !activeDef) return
    const params = buildFilterPayload()
    const desc = describeFilters(params)
    const entry: SavedFilter = {
      id: `${selected}-${Date.now()}`,
      reportId: selected,
      label: desc ? `${activeDef.title} · ${desc}` : activeDef.title,
      params,
      savedAt: new Date().toISOString(),
    }
    setSaved((prev) => {
      const next = [entry, ...prev].slice(0, 30)
      writeJson(SAVED_KEY, next)
      return next
    })
  }

  const runSaved = (s: SavedFilter) => {
    const def = definitions.find((d) => d.reportId === s.reportId)
    if (!def) {
      setError(`“${s.label}” runs a report that is no longer available on this plan — delete the saved set or contact your administrator.`)
      return
    }
    const values = defaultFilterValues(def)
    for (const [k, v] of Object.entries(s.params)) {
      if (v == null || v === "") continue
      if (k in values) values[k] = String(v)
    }
    setSelected(s.reportId)
    setFilterValues(values)
    setReport(null)
    setGenState(null)
    setError(null)
    setPiiConfirm({ open: false, typed: "", format: null })
    void generate(s.reportId, s.params)
  }

  const deleteSaved = (id: string) => setSaved((prev) => {
    const next = prev.filter((x) => x.id !== id)
    writeJson(SAVED_KEY, next)
    return next
  })

  /** Enterprise output — the background generation lane (PDF / XLSX / CSV). */
  const generateArtifact = async (format: ExportFormat) => {
    if (!selected) return
    setGenBusy(true); setGenState(null); setError(null)
    try {
      const payload: Record<string, unknown> = { reportId: selected, format, ...buildFilterPayload() }
      const sub = await rpc<{ jobId: string }>("analytics.report.generate", payload)
      // poll until DONE (bounded — the lane drains on submit)
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 400))
        const poll = await rpc<{ status: string; progress: number; error: string | null; artifact?: Artifact }>("analytics.report.generation", { jobId: sub.jobId })
        setGenState({ status: poll.status, progress: poll.progress, artifact: poll.artifact })
        if (poll.status === "DONE" || poll.status === "DEAD" || poll.status === "CANCELLED") {
          if (poll.status !== "DONE") throw new Error(poll.error || `Generation ${poll.status.toLowerCase()}`)
          break
        }
      }
    } catch (e: any) {
      setError(e?.message || "Background generation failed")
    } finally {
      setGenBusy(false)
    }
  }

  const downloadArtifact = () => {
    if (!genState?.artifact) return
    const bin = atob(genState.artifact.base64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const url = URL.createObjectURL(new Blob([bytes], { type: genState.artifact.contentType }))
    const a = document.createElement("a")
    a.href = url
    a.download = genState.artifact.filename
    a.click()
    URL.revokeObjectURL(url)
  }

  // export permission is definition-aware: PII reports need reports.pii.export
  const exportAllowed = activeDef ? (activeDef.pii ? canPiiExport : canExport) : canExport

  const requestArtifact = (format: ExportFormat) => {
    if (!selected || genBusy || !exportAllowed) return
    // RPT-002/HIGH-11 — PII-class exports go through the typed-confirmation
    // dialog first (the typed "EXPORT" is the client half of the server gate)
    if (activeDef?.pii) { setPiiConfirm({ open: true, typed: "", format }); return }
    void generateArtifact(format)
  }

  // ---- the dynamic filter bar: one control per advertised field ----
  const renderFilterField = (field: string) => {
    const label = FIELD_LABELS[field] ?? field
    const value = filterValues[field] ?? ""
    const spec = activeDef?.filters?.[field]
    const wrap = (control: React.ReactNode) => (
      <div key={field} className="min-w-0">
        <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</label>
        {control}
      </div>
    )
    switch (field) {
      case "from":
      case "to":
        return wrap(
          <input type="date" value={value} onChange={(e) => setField(field, e.target.value)}
            className="mt-0.5 h-9 w-full rounded-lg border bg-transparent px-2 text-xs" />,
        )
      case "year": {
        const nowY = new Date().getFullYear()
        const years = Array.from({ length: 7 }, (_, i) => nowY + 1 - i)
        const cur = Number(value)
        if (Number.isFinite(cur) && cur >= 2000 && cur <= 2100 && !years.includes(cur)) years.push(cur)
        years.sort((a, b) => b - a)
        return wrap(
          <Select value={value || "ANY"} onValueChange={(v) => setField("year", v === "ANY" ? "" : String(v))}>
            <SelectTrigger className="mt-0.5 h-9 text-xs"><SelectValue placeholder="Any year" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ANY">Any year</SelectItem>
              {years.map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
            </SelectContent>
          </Select>,
        )
      }
      case "branchId":
        return wrap(
          <Select value={value || "ANY"} onValueChange={(v) => setField("branchId", v === "ANY" ? "" : v)}>
            <SelectTrigger className="mt-0.5 h-9 text-xs"><SelectValue placeholder="All branches" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ANY">All branches</SelectItem>
              {(branches || []).map((b: any) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
            </SelectContent>
          </Select>,
        )
      case "departmentId":
        return wrap(
          <Select value={value || "ANY"} onValueChange={(v) => setField("departmentId", v === "ANY" ? "" : v)}>
            <SelectTrigger className="mt-0.5 h-9 text-xs"><SelectValue placeholder="All departments" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ANY">All departments</SelectItem>
              {(departments || []).map((d: any) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
            </SelectContent>
          </Select>,
        )
      case "employeeId":
        return wrap(
          <EmployeeCombobox employees={employees.data || []} value={value} onChange={(v) => setField("employeeId", v)} />,
        )
      case "eligibleOnly":
        return wrap(
          <div className="mt-0.5 flex h-9 items-center gap-2">
            <Switch checked={value === "1"} onCheckedChange={(v) => setField("eligibleOnly", v ? "1" : "")} aria-label="Eligible only" />
            <span className="text-xs text-slate-500 dark:text-slate-400">{value === "1" ? "Eligible only" : "All employees"}</span>
          </div>,
        )
      case "withinDays":
      case "percent":
        return wrap(
          <Input type="number" value={value} onChange={(e) => setField(field, e.target.value)}
            placeholder={field === "withinDays" ? "e.g. 60" : "e.g. 100"} className="mt-0.5 h-9 text-xs" />,
        )
      case "cycleId":
        if (cycles && cycles.length) {
          return wrap(
            <Select value={value || "ANY"} onValueChange={(v) => setField("cycleId", v === "ANY" ? "" : v)}>
              <SelectTrigger className="mt-0.5 h-9 text-xs"><SelectValue placeholder="Any cycle" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ANY">Any cycle</SelectItem>
                {cycles.map((c: any) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}{c.year ? ` (${c.year})` : ""}</SelectItem>
                ))}
              </SelectContent>
            </Select>,
          )
        }
        return wrap(
          <Input value={value} onChange={(e) => setField("cycleId", e.target.value)} placeholder="Review cycle id" className="mt-0.5 h-9 text-xs" />,
        )
      default: {
        // month / status / employmentType / dimension / runType / eventType /
        // basis / divisor — enum selects driven by the server's options spec
        // (month falls back to the hard-coded 12 months when the spec omits it)
        const options = spec?.options?.length
          ? spec.options
          : field === "month" ? MONTHS.map((m, i) => ({ value: String(i + 1), label: m })) : null
        if (!options) return null // no spec → skip the field
        return wrap(
          <Select value={value || "ANY"} onValueChange={(v) => setField(field, v === "ANY" ? "" : v)}>
            <SelectTrigger className="mt-0.5 h-9 text-xs"><SelectValue placeholder={`Any ${label.toLowerCase()}`} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ANY">Any {label.toLowerCase()}</SelectItem>
              {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>,
        )
      }
    }
  }

  const reportRow = (d: CatalogDefinition) => (
    <button key={d.reportId} onClick={() => selectReport(d.reportId)} title={d.description}
      className={`group w-full flex items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-all ${selected === d.reportId
        ? "bg-gradient-to-r from-emerald-50 to-teal-50/60 dark:from-emerald-950 dark:to-teal-950/60 text-emerald-700 dark:text-emerald-300 shadow-[inset_0_0_0_1px_rgb(16_185_129/0.15)]"
        : "hover:bg-slate-50 dark:hover:bg-slate-800/70 text-slate-600 dark:text-slate-300"}`}>
      <span className="flex-1 min-w-0">
        <span className="block text-xs font-medium truncate">{d.title}</span>
        {selected === d.reportId && d.description && (
          <span className="mt-0.5 block text-[9px] leading-snug text-slate-400 dark:text-slate-500 line-clamp-2">{d.description}</span>
        )}
      </span>
      {d.pii && (
        <Badge variant="outline" className="text-[8px] px-1 py-0 shrink-0 border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-400">PII</Badge>
      )}
      {d.tier === "advanced" && (
        <Badge variant="outline" className="text-[8px] px-1 py-0 shrink-0 border-teal-300 text-teal-700 dark:border-teal-800 dark:text-teal-400">Analytics</Badge>
      )}
      <span role="button" tabIndex={0}
        aria-label={favs.includes(d.reportId) ? `Remove ${d.title} from favourites` : `Add ${d.title} to favourites`}
        onClick={(e) => { e.stopPropagation(); toggleFav(d.reportId) }}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); toggleFav(d.reportId) } }}
        className={`shrink-0 rounded p-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${favs.includes(d.reportId) ? "text-amber-500" : "text-slate-300 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-amber-400"}`}>
        <Star className={`h-3.5 w-3.5 ${favs.includes(d.reportId) ? "fill-amber-400" : ""}`} />
      </span>
    </button>
  )

  const lockedRow = (l: LockedCatalogDefinition) => (
    <div key={l.reportId} title="Available on a higher plan — not selectable"
      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-slate-400 dark:text-slate-500">
      <Lock className="h-3.5 w-3.5 shrink-0" />
      <span className="flex-1 min-w-0 text-xs font-medium truncate">{l.title}</span>
      <button type="button" onClick={() => navigate("billing")}
        className="shrink-0 rounded text-[9px] font-semibold text-emerald-600 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
        Upgrade
      </button>
    </div>
  )

  const showSnapshotCallout = !selected || activeDef?.category === "Workforce"

  return (
    <div className="space-y-4">
      {/* ---------- the snapshot series callout (FIN-077, Workforce reports) ---------- */}
      {showSnapshotCallout && (
        <div className="rounded-xl border border-emerald-200 dark:border-emerald-900 bg-gradient-to-r from-emerald-50 to-teal-50/50 dark:from-emerald-950/60 dark:to-teal-950/30 p-3 flex flex-wrap items-center gap-3">
          <DatabaseZap className="h-5 w-5 text-emerald-600 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-emerald-800 dark:text-emerald-300">Monthly workforce snapshots</p>
            <p className="text-[11px] text-emerald-700/80 dark:text-emerald-400/80">
              {snapshotInfo && snapshotInfo.count > 0
                ? `${snapshotInfo.count} month(s) on file — ${snapshotInfo.first} → ${snapshotInfo.last}. Movement KPIs (joiners, exits, attrition, turnover) read THIS series; each month freezes as it closes.`
                : "None yet — run the twelve-month backfill once (Reports → schedule the analytics.snapshots.backfill action) and live captures start accumulating today; every month then freezes as it closes."}
            </p>
          </div>
          <Badge variant="outline" className="text-[10px] border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300">FIN-077 fix</Badge>
        </div>
      )}

      <div className="grid lg:grid-cols-[300px_1fr] gap-4 items-start">
        {/* ---------- the catalogue (server registry driven) ---------- */}
        <div className="rounded-xl border bg-white dark:bg-slate-900 p-2 shadow-sm">
          <div className="flex items-center justify-between px-2 py-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 flex items-center gap-1">
              <FileBarChart className="h-3 w-3" /> Catalogue
            </p>
            <span className="rounded-full bg-emerald-50 dark:bg-emerald-950 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-700 dark:text-emerald-300">
              {definitions.length || "…"}
            </span>
          </div>
          <div className="px-1.5 pb-1.5">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by title or category…"
                className="h-8 pl-7 text-xs rounded-lg" aria-label="Search the report catalogue" />
            </div>
          </div>
          <div className="space-y-0.5 max-h-[62vh] overflow-y-auto">
            {favDefs.length > 0 && (
              <div>
                <p className="text-[9px] font-semibold uppercase tracking-wide text-amber-600/70 dark:text-amber-400/70 px-2.5 pt-2 pb-1">
                  Favourites ({favDefs.length})
                </p>
                {favDefs.map(reportRow)}
              </div>
            )}
            {sections.map(([cat, sec]) => (
              <div key={cat}>
                <button type="button" onClick={() => setCollapsed((prev) => ({ ...prev, [cat]: !prev[cat] }))}
                  aria-expanded={!collapsed[cat]}
                  className="flex w-full items-center gap-1 rounded px-2.5 pt-2 pb-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
                  {collapsed[cat]
                    ? <ChevronRight className="h-3 w-3 text-slate-400 shrink-0" />
                    : <ChevronDown className="h-3 w-3 text-slate-400 shrink-0" />}
                  <span className="text-[9px] font-semibold uppercase tracking-wide text-slate-300 dark:text-slate-600 flex-1 text-left">{cat}</span>
                  <span className="text-[9px] font-medium text-slate-400 tabular-nums">{sec.defs.length + sec.locked.length}</span>
                </button>
                {!collapsed[cat] && (
                  <>
                    {sec.defs.map(reportRow)}
                    {sec.locked.length > 0 && <div className="my-1 border-t border-dashed border-slate-100 dark:border-slate-800" />}
                    {sec.locked.map(lockedRow)}
                  </>
                )}
              </div>
            ))}
            {!catalog && <div className="h-40 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800 m-2" />}
            {catalog && !filtered.length && !filteredLocked.length && (
              <p className="px-2.5 py-6 text-center text-[11px] text-slate-400">No report matches “{q}”.</p>
            )}
          </div>
        </div>

        {/* ---------- the builder + result ---------- */}
        <div className="space-y-4 min-w-0">
          {error && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 dark:bg-rose-950/40 dark:border-rose-900 p-4 text-sm text-rose-700 dark:text-rose-300">{error}</div>
          )}

          {!selected || !activeDef ? (
            <SectionCard title="Report builder">
              <EmptyState icon={FileBarChart} title="Ready when you are"
                hint="Pick a report from the catalogue — the filter bar adapts to each report's own vocabulary, previews render with catalogue-defined KPIs and methodology, and PDF / XLSX / CSV exports bake in the background lane from the same contract payload. Star the reports you use; save the filter sets you reuse." />
              {saved.length > 0 && (
                <div className="mt-3 space-y-1.5">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Saved filter sets</p>
                  {saved.map((s) => (
                    <div key={s.id} className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5">
                      <span className="flex-1 min-w-0">
                        <span className="block text-xs font-medium truncate">{s.label}</span>
                        <span className="block text-[9px] text-slate-400">saved {fmtDateTime(new Date(s.savedAt))}</span>
                      </span>
                      <Button size="sm" variant="outline" className="h-7 text-[10px]" onClick={() => runSaved(s)}>
                        <PlayCircle className="h-3 w-3 mr-1" /> Run
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-slate-400"
                        aria-label={`Delete saved filter set ${s.label}`} onClick={() => deleteSaved(s.id)}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>
          ) : (
            <>
              {/* selected report header (the page title lives in the parent) */}
              <div className="rounded-xl border bg-white dark:bg-slate-900 p-3 shadow-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <FileBarChart className="h-4 w-4 text-emerald-600 shrink-0" />
                  <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">{activeDef.title}</h2>
                  <Badge variant="outline" className="text-[10px]">{activeDef.category}</Badge>
                  {activeDef.tier === "advanced" ? (
                    <Badge variant="outline" className="text-[10px] border-teal-300 text-teal-700 dark:border-teal-800 dark:text-teal-400">Analytics</Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px] text-slate-500 dark:text-slate-400">Core</Badge>
                  )}
                  {activeDef.pii && (
                    <Badge variant="outline" className="text-[10px] border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-400">PII</Badge>
                  )}
                  <span className="ml-auto hidden font-mono text-[10px] text-slate-400 sm:inline">{activeDef.reportId}</span>
                </div>
                <p className="mt-1 text-[11px] leading-snug text-slate-500 dark:text-slate-400">{activeDef.description}</p>
              </div>

              {/* ---------- dynamic filter bar + GENERATE + exports ---------- */}
              <div className="rounded-xl border bg-white dark:bg-slate-900 p-3">
                <div className="flex items-center gap-2 mb-2.5">
                  <Filter className="h-3.5 w-3.5 text-emerald-600" />
                  <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">Filters</p>
                  <Button size="sm" variant="ghost" className="ml-auto h-7 text-[10px] text-slate-500" onClick={resetFilters}>
                    <RotateCcw className="mr-1 h-3 w-3" /> Reset
                  </Button>
                </div>
                {filterFields.length > 0 ? (
                  <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-2">
                    {filterFields.map(renderFilterField)}
                  </div>
                ) : (
                  <p className="text-[11px] text-slate-400">This report runs on the whole company scope — there are no filters to set.</p>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button size="sm" className="h-9 text-xs bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white shadow-sm shadow-emerald-600/20"
                    onClick={() => void generate(selected, buildFilterPayload())}
                    disabled={busy || (activeDef.pii && !canPiiView)}
                    title={activeDef.pii && !canPiiView ? "This report contains bulk personal data — the reports.pii.view permission is required to render it" : undefined}>
                    <PlayCircle className="mr-1 h-4 w-4" /> {busy ? "Generating…" : report ? "Regenerate" : "Generate report"}
                  </Button>
                  <Button size="sm" variant="outline" className="h-9 text-xs bg-white dark:bg-slate-900" onClick={saveCurrent} disabled={filterFields.length === 0}>
                    <Star className="mr-1 h-3.5 w-3.5" /> Save filter set
                  </Button>
                  {canSchedule && (
                    <Button size="sm" variant="outline" className="h-9 text-xs bg-white dark:bg-slate-900"
                      onClick={() => onSaveTemplate?.({ reportId: selected, filters: buildFilterPayload() })}
                      title="Pin this report + filters as an emailed template (on demand or on a schedule)">
                      <Save className="mr-1 h-3.5 w-3.5" /> Save as template
                    </Button>
                  )}
                  <span className="ml-auto flex items-center gap-1.5">
                    {(["PDF", "XLSX", "CSV"] as const).map((f) => (
                      <Button key={f} size="sm" variant="outline" className="h-9 text-[10px]" disabled={genBusy || !exportAllowed}
                        title={!exportAllowed
                          ? (activeDef.pii ? "Requires the reports.pii.export permission" : "Requires the reports.export permission")
                          : `Generate ${f} through the background lane`}
                        onClick={() => requestArtifact(f)}>
                        {f === "PDF" ? <FileType2 className="h-3 w-3 mr-1" /> : f === "XLSX" ? <FileSpreadsheet className="h-3 w-3 mr-1" /> : <Download className="h-3 w-3 mr-1" />}
                        {f}
                      </Button>
                    ))}
                  </span>
                </div>
                {genState && (
                  <div className="mt-2 flex items-center gap-2 rounded-lg border border-sky-200 dark:border-sky-900 bg-sky-50 dark:bg-sky-950/40 px-2.5 py-1.5">
                    <CalendarRange className="h-3.5 w-3.5 text-sky-600 shrink-0" />
                    <span className="text-[11px] text-sky-800 dark:text-sky-300 flex-1">
                      Background generation: {genState.status}
                      {genState.status === "RUNNING" || genState.status === "PENDING" ? ` (${genState.progress}/4)` : ""}
                      {genState.artifact ? ` — ${genState.artifact.filename}` : ""}
                    </span>
                    {genState.artifact && (
                      <Button size="sm" className="h-7 text-[10px]" onClick={downloadArtifact}>
                        <Download className="h-3 w-3 mr-1" /> Download
                      </Button>
                    )}
                  </div>
                )}
              </div>

              {report && <AnalyticsReportView report={report} canExport={exportAllowed} />}
              {!report && !busy && (
                <div className="rounded-xl border bg-white dark:bg-slate-900">
                  <EmptyState icon={PlayCircle} title="Ready when you are"
                    hint="Set the filters above and press Generate — the report renders with catalogue-defined KPIs, purpose-specified charts, the table and the methodology block. PDF / XLSX / CSV outputs bake in the background lane from the same contract payload." />
                </div>
              )}
              {busy && <div className="h-48 rounded-xl bg-slate-100 dark:bg-slate-800 animate-pulse" />}
            </>
          )}
        </div>
      </div>

      {/* RPT-002 (Wave R3-3) — HIGH-11 typed confirmation for PII-class
          exports: the client half that types the "EXPORT" the server gate
          requires before a bulk-personal-data artifact leaves the wire. */}
      <Dialog open={piiConfirm.open} onOpenChange={(v) => setPiiConfirm((s) => (v ? s : { open: false, typed: "", format: null }))}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-rose-600" /> Confirm bulk-PII export
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm text-slate-600 dark:text-slate-300">
            <p>
              <strong>{activeDef?.title || selected}</strong> contains bulk personal data.
              The {piiConfirm.format} export is recorded in the audit trail with your identity.
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Type <span className="font-mono font-semibold">EXPORT</span> to enable the download button.
            </p>
            <Input
              value={piiConfirm.typed}
              onChange={(e) => setPiiConfirm((s) => ({ ...s, typed: e.target.value }))}
              placeholder="EXPORT"
              className="font-mono"
              autoComplete="off"
              aria-label="Type EXPORT to confirm"
            />
          </div>
          <DialogFooter>
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setPiiConfirm({ open: false, typed: "", format: null })}>Cancel</Button>
            <Button
              size="sm"
              className="h-8 text-xs bg-rose-600 hover:bg-rose-700"
              disabled={piiConfirm.typed !== "EXPORT" || !piiConfirm.format}
              onClick={() => {
                const format = piiConfirm.format
                setPiiConfirm({ open: false, typed: "", format: null })
                if (format) void generateArtifact(format)
              }}
            >
              <Download className="h-3.5 w-3.5 mr-1" /> Export PII report{piiConfirm.format ? ` (.${piiConfirm.format.toLowerCase()})` : ""}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** Searchable employee picker (combobox) — ported from the classic report
 *  filter bar; drives the employeeId ref filter. */
function EmployeeCombobox({ employees, value, onChange }: { employees: any[]; value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const selected = employees.find((e) => e.id === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="mt-0.5 h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 text-xs text-left flex items-center gap-1 hover:bg-slate-50 dark:hover:bg-slate-800"
          role="combobox" aria-expanded={open} aria-controls="workspace-employee-combobox-list">
          <Search className="h-3.5 w-3.5 text-slate-400 shrink-0" />
          <span className="truncate flex-1 text-slate-600 dark:text-slate-300">{selected ? `${selected.fullName} (${selected.code})` : "All employees"}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[260px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search employee…" className="h-8 text-xs" />
          <CommandList id="workspace-employee-combobox-list" className="max-h-56">
            <CommandEmpty className="text-xs py-3">No employee found.</CommandEmpty>
            <CommandGroup>
              <CommandItem value="__all__" onSelect={() => { onChange(""); setOpen(false) }} className="text-xs">
                <Check className={`h-3.5 w-3.5 mr-1.5 ${!value ? "opacity-100" : "opacity-0"}`} /> All employees
              </CommandItem>
              {employees.map((e) => (
                <CommandItem key={e.id} value={`${e.fullName} ${e.code || ""}`} onSelect={() => { onChange(e.id); setOpen(false) }} className="text-xs">
                  <Check className={`h-3.5 w-3.5 mr-1.5 ${value === e.id ? "opacity-100" : "opacity-0"}`} />
                  <span className="truncate">{e.fullName}</span>
                  <span className="ml-auto text-[10px] text-slate-500 dark:text-slate-400">{e.code}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
