"use client"
// ============ Phase 2 reporting foundation — structured report components ============
// The client half of the AnalyticsReport contract: shared KPI card, comparison
// badge, chart container and export menu every structured report renders
// through (seeded from the attendance overview's visual language). Both
// exports — the server CSV twin and the client-side XLSX — are built from
// the SAME contract payload the UI renders, so the export can never disagree
// with the screen (the unified export pipeline).
import { useState } from "react"
import { FileSpreadsheet, FileText, Info, TriangleAlert, ArrowUpRight, ArrowDownRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ReportChart, type PrintChartSpec } from "./report-print"
import { rpc } from "../api"
import { useHrm } from "../store"

// ---- contract types (client mirror of hrm-server/analytics-report.ts) ----
export type StructuredKpi = {
  key: string
  label: string
  value: number | string | null
  unit: string
  definition: string
  previous?: { value: number | string | null; deltaPct: number | null } | null
  intent?: "good-high" | "good-low" | "neutral"
  local?: boolean
}
export type StructuredChart = {
  key: string
  kind: "line" | "bar" | "donut" | "pie"
  title: string
  purpose: string
  series: { name: string; points: { label: string; value: number }[] }[]
  note?: string
}
export type StructuredReport = {
  contractVersion: 1
  reportId: string
  title: string
  generatedAt: string
  period: { from: string; to: string; label: string; comparison: { from: string; to: string; label: string } | null }
  filters: Record<string, unknown>
  scope: { applied: boolean; description: string }
  kpis: StructuredKpi[]
  charts: StructuredChart[]
  table: { columns: { key: string; label: string; align?: "left" | "right" }[]; rows: (string | number | null)[][] } | null
  warnings: string[]
  methodology: { source: string; definitions: Record<string, string>; generatedBy: string }
}

// ---- catalogue mirror types (client half of analytics.report.catalog) ----
// Mirrors src/hrm-server/analytics-report.ts ReportDefinition + routes/
// reports.ts `analytics.report.catalog` (definitions exclude internal
// reports and advanced-tier reports the plan lacks — those arrive in
// `lockedDefinitions` with title + category only).
export type CatalogFilterSpec = {
  type: "enum" | "date" | "ref"
  options?: { value: string; label: string }[]
  required?: boolean
  default?: unknown
}
export type CatalogDefinition = {
  reportId: string
  title: string
  description: string
  category: string
  tier: "core" | "advanced"
  permission: [string, string]
  exportPermission: [string, string]
  pii: boolean
  period: "range" | "snapshot"
  comparisonSupported: boolean
  filters?: Record<string, CatalogFilterSpec>
  /** the report's advertised filter vocabulary (subset of the server's
   *  ReportFilterField union — numeric/boolean fields appear here without a
   *  validated enum spec). */
  filterFields?: string[]
}
export type LockedCatalogDefinition = { reportId: string; title: string; category: string }
export type ReportCatalog = {
  definitions: CatalogDefinition[]
  lockedDefinitions: LockedCatalogDefinition[]
}

// ---- human-readable filter description (client mirror) ----
/** Mirror of the server's describeFilters() (analytics-report.ts): the same
 *  label map, the same month-name expansion, the same empty-skip rule — so
 *  the client XLSX "Report Info" sheet shows EXACTLY what the server-baked
 *  PDF/XLSX/CSV header line shows (one description, no drift). */
const FILTER_LABELS: Record<string, string> = {
  branchId: "Branch", departmentId: "Department", employeeId: "Employee",
  status: "Status", employmentType: "Employment type", month: "Month", year: "Year",
  from: "From", to: "To", dimension: "Group by", runType: "Run type", cycleId: "Cycle",
  divisor: "Divisor", eligibleOnly: "Eligible only", percent: "Percent", basis: "Basis",
  withinDays: "Within days", eventType: "Event type",
}
const FILTER_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

export function describeFilters(filters: Record<string, unknown>): string {
  const bits: string[] = []
  for (const [k, v] of Object.entries(filters || {})) {
    if (v == null || v === "" || (Array.isArray(v) && v.length === 0)) continue
    const label = FILTER_LABELS[k] ?? k
    const text = k === "month" && Number(v) >= 1 && Number(v) <= 12 ? FILTER_MONTHS[Number(v) - 1] : String(v)
    bits.push(`${label}: ${text}`)
  }
  return bits.join(" · ")
}

/** The "Report Info" rows for the client XLSX export: report title, period,
 *  applied filters (human-readable, via describeFilters) and generation
 *  timestamp — the provenance block that travels with every artifact. */
export function reportInfoRows(report: StructuredReport): unknown[][] {
  const rows: unknown[][] = [
    ["Report", report.title],
    ["Period", report.period.label],
    ["From", report.period.from],
    ["To", report.period.to],
  ]
  if (report.period.comparison) rows.push(["Comparison", report.period.comparison.label])
  for (const line of describeFilters(report.filters).split(" · ").filter(Boolean)) {
    const idx = line.indexOf(": ")
    rows.push(idx > 0 ? [line.slice(0, idx), line.slice(idx + 2)] : ["Filter", line])
  }
  rows.push(["Generated at", new Date(report.generatedAt).toLocaleString()])
  return rows
}

// ---- units → display ----
function fmtValue(v: number | string | null, unit: string): string {
  if (v == null) return "—"
  if (typeof v === "string") return v
  if (unit === "percent") return `${v}%`
  if (unit === "currency") return `৳${v.toLocaleString()}`
  if (unit === "days" || unit === "hours" || unit === "count" || unit === "ratio") return v.toLocaleString()
  return String(v)
}

/** The previous-period comparison badge: Δ% with direction coloring by the
 *  KPI's intent (a RISE in absenteeism is good news for nobody). */
export function ComparisonBadge({ kpi }: { kpi: StructuredKpi }) {
  if (!kpi.previous || kpi.previous.deltaPct == null) return null
  const d = kpi.previous.deltaPct
  const up = d > 0
  const good = kpi.intent === "good-high" ? up : kpi.intent === "good-low" ? !up : null
  const cls = good == null
    ? "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
    : good
      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
      : "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300"
  return (
    <span className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${cls}`} title={`vs previous period: ${fmtValue(kpi.previous.value, kpi.unit)}`}>
      {up ? <ArrowUpRight className="h-2.5 w-2.5" /> : <ArrowDownRight className="h-2.5 w-2.5" />}
      {up ? "+" : ""}{d}%
    </span>
  )
}

/** One KPI card: value + unit + comparison badge + its written definition
 *  (the Phase 1 lesson — a number without its formula is how wrong numbers
 *  survive, so the definition travels WITH the value). */
export function KpiCard({ kpi }: { kpi: StructuredKpi }) {
  return (
    <div className="rounded-xl border bg-white dark:bg-slate-900 p-3 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 truncate">{kpi.label}</p>
        <ComparisonBadge kpi={kpi} />
      </div>
      <p className="mt-1 text-xl font-bold tabular-nums text-slate-800 dark:text-slate-100 leading-none">
        {fmtValue(kpi.value, kpi.unit)}
        {kpi.unit === "percent" ? <span className="text-sm font-semibold text-slate-400 ml-0.5">%</span> : null}
      </p>
      <p className="mt-1.5 text-[10px] leading-snug text-slate-400 line-clamp-2" title={kpi.definition}>
        {kpi.definition}
      </p>
    </div>
  )
}

/** A contract chart → the shared ReportChart renderer, plus the purpose
 *  caption (WHY the chart exists) and the series note. */
export function ChartContainer({ chart, height = 240 }: { chart: StructuredChart; height?: number }) {
  // AnalyticsChart series (1..n named series over shared labels) → the
  // PrintChartSpec shape (data rows keyed s0..s3)
  const labels = chart.series[0]?.points.map((p) => p.label) || []
  const spec: PrintChartSpec = {
    data: labels.map((label, i) => {
      const point: { label: string; [k: string]: string | number } = { label: String(label) }
      chart.series.forEach((s, si) => { point[`s${si}`] = s.points[i]?.value ?? 0 })
      return point
    }),
    series: chart.series.map((s, si) => ({ key: `s${si}`, name: s.name })),
    type: chart.kind === "donut" ? "donut" : chart.kind === "pie" ? "pie" : chart.kind,
  }
  if (!spec.data.length) return null
  return (
    <div className="rounded-xl border bg-white dark:bg-slate-900 p-3 shadow-sm">
      <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">{chart.title}</p>
      <p className="mt-0.5 mb-2 text-[10px] leading-snug text-slate-400">{chart.purpose}</p>
      <ReportChart spec={spec} height={height} />
      {chart.note && <p className="mt-1.5 text-[10px] text-slate-400">{chart.note}</p>}
    </div>
  )
}

/** The unified export menu: .csv (server twin, built from the SAME contract
 *  payload — audited like every export) and .xlsx (client SheetJS, multi-
 *  sheet: KPI summary + table, built from the same payload). */
export function ExportReportMenu({ report, canExport, disabled }: {
  report: StructuredReport
  canExport: boolean
  disabled?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const { toast } = useHrm()
  const fileBase = `hr-structured-${report.reportId}-${report.period.from}_${report.period.to}`.replace(/[^\w.-]+/g, "-")

  const exportCsv = async () => {
    try {
      const res = await rpc<{ csv: string }>("analytics.report.renderCsv", {
        reportId: report.reportId,
        ...report.filters,
      })
      const blob = new Blob(["\uFEFF" + res.csv], { type: "text/csv;charset=utf-8" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `${fileBase}.csv`
      a.click()
      URL.revokeObjectURL(url)
      toast("Structured report exported as .csv (audited)")
    } catch (e: any) {
      toast(e?.message || "Export failed", "err")
    }
  }

  const exportXlsx = async () => {
    if (busy) return
    setBusy(true)
    try {
      const XLSX = await import("xlsx")
      const wb = XLSX.utils.book_new()
      // sheet 0 — "Report Info": provenance block (title, period, applied
      // filters, generated-at) mirroring the server-baked export header line
      const infoRows = reportInfoRows(report)
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(infoRows), "Report Info")
      // sheet 1 — the KPI summary with definitions + comparison
      const kpiRows: unknown[][] = [
        ["KPI", "Value", "Unit", "Previous", "Δ%", "Definition"],
        ...report.kpis.map((k) => [
          k.label,
          k.value ?? "",
          k.unit,
          k.previous?.value ?? "",
          k.previous?.deltaPct == null ? "" : `${k.previous.deltaPct > 0 ? "+" : ""}${k.previous.deltaPct}%`,
          k.definition,
        ]),
      ]
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(kpiRows), "KPIs")
      // sheet 2..n — one sheet per chart series
      for (const c of report.charts) {
        const rows: unknown[][] = [[c.title], ["Series", "Point", "Value"]]
        for (const s of c.series) for (const p of s.points) rows.push([s.name, p.label, p.value])
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), c.key.slice(0, 28) || "Chart")
      }
      // last sheet — the table
      if (report.table) {
        const tRows: unknown[][] = [report.table.columns.map((c) => c.label), ...report.table.rows]
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(tRows), "Table")
      }
      XLSX.writeFile(wb, `${fileBase}.xlsx`)
    } catch (e: any) {
      console.error("xlsx export failed", e)
    } finally {
      setBusy(false)
    }
  }

  if (!canExport) return null
  return (
    <div className="flex items-center gap-1.5 print:hidden">
      <Button size="sm" variant="outline" className="h-8 text-xs bg-white dark:bg-slate-900" onClick={() => void exportXlsx()} disabled={disabled || busy}>
        <FileSpreadsheet className="h-3.5 w-3.5 mr-1 text-emerald-600" /> .xlsx
      </Button>
      <Button size="sm" variant="outline" className="h-8 text-xs bg-white dark:bg-slate-900" onClick={() => void exportCsv()} disabled={disabled}>
        <FileText className="h-3.5 w-3.5 mr-1 text-sky-600" /> .csv
      </Button>
    </div>
  )
}

/** The full structured report view: KPI grid → charts → table → warnings →
 *  methodology. Everything the contract carries is rendered; nothing is
 *  silently dropped. */
export function AnalyticsReportView({ report, canExport }: { report: StructuredReport; canExport: boolean }) {
  return (
    <div className="space-y-4">
      {/* header: period + scope + export */}
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="text-[10px] bg-white dark:bg-slate-900">
          <Info className="h-3 w-3 mr-1 text-emerald-600" /> Contract v{report.contractVersion}
        </Badge>
        <Badge variant="outline" className="text-[10px] bg-white dark:bg-slate-900">{report.period.label}</Badge>
        {report.period.comparison && (
          <Badge variant="outline" className="text-[10px] bg-white dark:bg-slate-900">vs {report.period.comparison.label}</Badge>
        )}
        <Badge variant="outline" className="text-[10px] bg-white dark:bg-slate-900" title={report.scope.description}>
          {report.scope.applied ? "scoped" : "org-wide"}
        </Badge>
        <div className="ml-auto">
          <ExportReportMenu report={report} canExport={canExport} />
        </div>
      </div>

      {/* KPI grid */}
      {report.kpis.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-2.5">
          {report.kpis.map((k) => <KpiCard key={k.key} kpi={k} />)}
        </div>
      )}

      {/* charts */}
      {report.charts.length > 0 && (
        <div className="grid lg:grid-cols-2 gap-3">
          {report.charts.map((c) => <ChartContainer key={c.key} chart={c} />)}
        </div>
      )}

      {/* table */}
      {report.table && report.table.rows.length > 0 && (
        <div className="rounded-xl border bg-white dark:bg-slate-900 p-3 shadow-sm overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-left">
                {report.table.columns.map((c) => (
                  <th key={c.key} className={`py-1.5 px-2 font-semibold text-slate-500 dark:text-slate-400 ${c.align === "right" ? "text-right" : ""}`}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.table.rows.map((r, i) => (
                <tr key={i} className="border-b last:border-0 hover:bg-slate-50/60 dark:hover:bg-slate-800/40">
                  {r.map((v, j) => (
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): Phase 3 analytics/PDF/commission surface, index/lookup guarded by construction
                    <td key={j} className={`py-1.5 px-2 tabular-nums text-slate-700 dark:text-slate-300 ${report.table!.columns[j]?.align === "right" ? "text-right" : ""}`}>
                      {v == null || v === "" ? <span className="text-slate-400">—</span> : String(v)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {report.table && report.table.rows.length === 0 && (
        <div className="rounded-xl border bg-white dark:bg-slate-900 p-4 text-xs text-slate-400 text-center">
          No rows in scope for the selected filters.
        </div>
      )}

      {/* warnings — always visible, never folded away */}
      {report.warnings.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/70 dark:bg-amber-950/30 dark:border-amber-900 p-3 space-y-1.5">
          {report.warnings.map((w, i) => (
            <p key={i} className="flex gap-1.5 text-[11px] leading-snug text-amber-800 dark:text-amber-300">
              <TriangleAlert className="h-3.5 w-3.5 shrink-0 mt-px" /> {w}
            </p>
          ))}
        </div>
      )}

      {/* methodology — how every number was computed */}
      <div className="rounded-xl border bg-white dark:bg-slate-900 p-3">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Methodology</p>
        <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400"><b>Source:</b> {report.methodology.source}</p>
        <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400"><b>Generated by:</b> {report.methodology.generatedBy} · {new Date(report.generatedAt).toLocaleString()}</p>
        {Object.keys(report.methodology.definitions).length > 0 && (
          <ul className="mt-1.5 space-y-0.5">
            {Object.entries(report.methodology.definitions).map(([k, v]) => (
              <li key={k} className="text-[10px] text-slate-400"><b className="text-slate-500 dark:text-slate-300">{k}:</b> {v}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
