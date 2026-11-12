// ============ Phase 2 reporting foundation — the AnalyticsReport contract ============
// FIN (new, Phase 2) — the structured report contract the analytics rebuild
// needs: one typed envelope every report renders through, versioned, with
// every KPI carrying its unit, its written formula, and its previous-period
// comparison; every chart carrying its purpose; every table staying the
// plain { columns, rows } envelope the legacy renderer and the scheduled-
// delivery engine already understand; and an explicit methodology + warnings
// block so a reader can always answer "how was this number computed?".
//
// Design rules (from the consolidated remediation roadmap):
//   - METRIC DEFINITIONS are separated from COMPOSITIONS: a metric (e.g.
//     "attendance rate") is defined ONCE here with its unit and formula;
//     report definitions then COMPOSE metrics instead of re-deriving them —
//     the Phase 1 lesson (four divergent attendance-rate formulas) cannot
//     recur inside the new stack.
//   - The legacy ~40 reportRoute handlers keep working untouched; the legacy
//     adapter (see routes/reports.ts) wraps any of them as a table-only
//     definition — PII gating, CSV twins and scheduling are inherited for
//     free, and migration is report-by-report with no cutover dead period.
//   - Contract evolution is explicit: `contractVersion` + `methodology`
//     travel WITH the payload; a changed definition bumps the metric's
//     `definition` text (both stay retrievable in report-definition history
//     once versioned server-side by the scheduler).
import type { Ctx } from "./types"
import { Deny } from "./rbac"
import type { ReportCategory, ReportTier } from "./report-meta"

// ---------------- the contract (v1) ----------------

export type KpiUnit = "count" | "percent" | "currency" | "days" | "hours" | "ratio" | "text"

export type AnalyticsKpi = {
  /** metric key — MUST exist in METRIC_DEFINITIONS unless `local` is set */
  key: string
  label: string
  value: number | string | null
  unit: KpiUnit
  /** the formula IN WORDS — rendered next to the value (Phase 1 lesson:
   *  a number without its definition is how wrong formulas survived) */
  definition: string
  /** previous period comparison, when the report computes one */
  previous?: { value: number | string | null; deltaPct: number | null } | null
  /** direction interpretation for the comparison badge */
  intent?: "good-high" | "good-low" | "neutral"
  /** true when this KPI is report-specific (not in the shared metric catalogue) */
  local?: boolean
}

export type ChartKind = "line" | "bar" | "donut" | "pie"

export type AnalyticsChart = {
  key: string
  kind: ChartKind
  title: string
  /** WHY this chart exists — one sentence; the UI shows it as the caption */
  purpose: string
  series: { name: string; points: { label: string; value: number }[] }[]
  note?: string
}

export type AnalyticsTable = {
  columns: { key: string; label: string; align?: "left" | "right" }[]
  rows: (string | number | null)[][]
} | null

export type AnalyticsReport = {
  contractVersion: 1
  reportId: string
  title: string
  generatedAt: string
  period: {
    from: string
    to: string
    label: string
    comparison: { from: string; to: string; label: string } | null
  }
  /** the caller-supplied filters actually APPLIED (mirrored back honestly) */
  filters: Record<string, unknown>
  /** employee visibility scope the numbers were computed under */
  scope: { applied: boolean; description: string }
  kpis: AnalyticsKpi[]
  charts: AnalyticsChart[]
  table: AnalyticsTable
  /** honest caveats — empty only when there is genuinely nothing to warn about */
  warnings: string[]
  methodology: {
    source: string
    definitions: Record<string, string>
    generatedBy: string
  }
}

export type ReportParams = {
  from?: string
  to?: string
  /** comparison period (defaults to the immediately preceding period of the
   *  same length when the definition supports comparison) */
  compareFrom?: string
  compareTo?: string
  dimension?: string
  branchId?: string | null
  departmentId?: string | null
  [k: string]: unknown
}

// ---------------- metric definitions (the catalogue) ----------------

export type MetricDefinition = {
  key: string
  label: string
  unit: KpiUnit
  definition: string
}

/** The shared metric catalogue. A metric is defined EXACTLY ONCE — report
 *  definitions reference these keys, so two reports can never again disagree
 *  about what "attendance rate" means. Report-local KPIs (e.g. a specific
 *  report's "GPS violations") set `local: true` and carry their definition
 *  inline, but every metric that appears in MORE than one report MUST live
 *  here. */
export const METRIC_DEFINITIONS: MetricDefinition[] = [
  {
    key: "headcount.total",
    label: "Headcount",
    unit: "count",
    definition: "Employees in the caller's visibility scope at period end, all statuses (directory rows; excludes nothing — exited employees are in the directory until archived).",
  },
  {
    key: "headcount.active",
    label: "Active headcount",
    unit: "count",
    definition: "Employees in scope whose status is ACTIVE, PROBATION or ON_LEAVE at period end.",
  },
  {
    key: "attendance.rate",
    label: "Attendance rate",
    unit: "percent",
    definition: "Not-counted attendance days (present-ish statuses) ÷ expected employee-days, capped at 100%. LEAVE, LEAVE_UNPAID, HOLIDAY and WEEKLY_OFF are excluded from BOTH numerator and denominator.",
  },
  {
    key: "attendance.absent_days",
    label: "Absent employee-days",
    unit: "count",
    definition: "Attendance records with status ABSENT in the period, across employees in scope.",
  },
  {
    key: "attendance.late",
    label: "Late arrivals",
    unit: "count",
    definition: "Attendance records with status LATE in the period, across employees in scope.",
  },
  {
    key: "attendance.on_leave_days",
    label: "Leave days",
    unit: "count",
    definition: "Attendance records with status LEAVE or LEAVE_UNPAID in the period, across employees in scope.",
  },
  {
    key: "workforce.turnover",
    label: "Turnover (trailing 12m)",
    unit: "percent",
    definition: "Exits in the trailing 12 months ÷ average headcount over the window ((start + end) ÷ 2), exit month = resignation/lifecycle LWD only.",
  },
  {
    key: "workforce.avg_tenure_months",
    label: "Average tenure",
    unit: "days",
    definition: "Mean days since joining date across employees in scope, expressed in months (÷ 30).",
  },
  {
    key: "workforce.joiners",
    label: "New joiners",
    unit: "count",
    definition: "Employees whose joining date falls inside the period (from the monthly workforce snapshot series).",
  },
  {
    key: "workforce.exits",
    label: "Exits",
    unit: "count",
    definition: "Employees whose earliest recorded exit date (non-cancelled resignation/lifecycle LWD) falls inside the period (from the monthly workforce snapshot series).",
  },
  {
    key: "workforce.attrition",
    label: "Attrition (period)",
    unit: "percent",
    definition: "Exits in the period ÷ average headcount over the period ((start + end) ÷ 2 minimum), from the monthly workforce snapshot series.",
  },
  {
    key: "payroll.cost",
    label: "Payroll cost (gross)",
    unit: "currency",
    definition: "Sum of PAID payroll-run gross totals for the months of the period, vendor-wide (requires the payroll.view permission).",
  },
  {
    key: "payroll.ot_cost",
    label: "Overtime cost",
    unit: "currency",
    definition: "Sum of PAID payroll-run overtime totals for the months of the period, vendor-wide (requires the payroll.view permission).",
  },
]

const METRIC_BY_KEY = new Map(METRIC_DEFINITIONS.map((m) => [m.key, m]))

export function metricDefinition(key: string): MetricDefinition | undefined {
  return METRIC_BY_KEY.get(key)
}

/** Build a KPI from the catalogue (definition comes from the ONE place). */
export function kpi(
  key: string,
  value: number | string | null,
  opts: { previous?: AnalyticsKpi["previous"]; intent?: AnalyticsKpi["intent"]; label?: string } = {},
): AnalyticsKpi {
  const def = METRIC_BY_KEY.get(key)
  if (!def) {
    throw new Error(`[analytics-report] KPI "${key}" is not in METRIC_DEFINITIONS — add it there or mark the KPI local`)
  }
  return { key, label: opts.label ?? def.label, value, unit: def.unit, definition: def.definition, previous: opts.previous ?? null, intent: opts.intent }
}

/** Δ% between two numeric values (null-safe; null when either side is null). */
export function deltaPct(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null || previous === 0) return null
  return Math.round(((current - previous) / previous) * 1000) / 10
}

// ---------------- the report-definition registry ----------------

export type ReportDefinition = {
  reportId: string
  title: string
  description: string
  /** business-domain category (HR Reports metadata — report-meta.ts) */
  category: ReportCategory
  /** subscription tier: "advanced" reports require the ADVANCED_REPORTS plan feature */
  tier: ReportTier
  /** excluded from the HR Reports catalog (scheduler/AI/templates only) */
  internal?: boolean
  /** permission pair enforced at render time (definition-specific: the legacy
   *  adapter inherits the legacy route's gate — including reports.pii.view
   *  for PII-class reports) */
  permission: [string, string]
  /** export permission pair for the CSV twin */
  exportPermission: [string, string]
  pii: boolean
  /** period shape this report renders over */
  period: "range" | "snapshot"
  comparisonSupported: boolean
  filters?: Record<string, { type: "enum" | "date" | "ref"; options?: { value: string; label: string }[]; required?: boolean; default?: unknown }>
  /** the FULL advertised filter vocabulary (ReportFilterField names) the
   *  report honours — superset of `filters` (numeric/boolean fields like
   *  year / withinDays / percent stay here without enum validation). */
  filterFields?: string[]
  render: (ctx: Ctx, p: ReportParams) => Promise<AnalyticsReport>
}

const registry = new Map<string, ReportDefinition>()

export function registerReport(def: ReportDefinition): void {
  if (registry.has(def.reportId)) {
    if (process.env.NODE_ENV !== "production") {
      // Allow HMR in development to update report definitions in-place
      registry.set(def.reportId, def)
      return
    }
    throw new Error(`[analytics-report] duplicate report definition: "${def.reportId}"`)
  }
  registry.set(def.reportId, def)
}

export function reportDefinition(reportId: string): ReportDefinition | undefined {
  return registry.get(reportId)
}

export function listReportDefinitions(): ReportDefinition[] {
  return [...registry.values()]
}

/** Validate caller-supplied params against the definition's filter spec:
 *  unknown enum values are rejected (never silently ignored — the honest-
 *  filters rule), unknown KEYS are dropped by the dispatcher's zod schema. */
export function validateFilters(def: ReportDefinition, p: ReportParams): void {
  for (const [key, spec] of Object.entries(def.filters || {})) {
    if (spec.type !== "enum") continue
    const raw = p[key]
    if (raw == null || raw === "") continue
    if (!spec.options?.some((o) => o.value === String(raw))) {
      throw new Deny(`Unsupported ${key} filter value "${String(raw)}" — allowed: ${spec.options?.map((o) => o.value).join(", ")}`, 400)
    }
  }
}

/** Render a registered definition through the contract (permission + filter
 *  validation happen here so EVERY definition gets them for free). */
export async function renderAnalyticsReport(ctx: Ctx, reportId: string, p: ReportParams): Promise<AnalyticsReport> {
  const def = registry.get(reportId)
  if (!def) throw new Deny(`Unknown structured report: "${reportId}" (see analytics.report.catalog)`, 404)
  validateFilters(def, p)
  return def.render(ctx, p)
}

// ---------------- the unified export pipeline ----------------

/** Human-readable rendering of the filters a report APPLIED — one source for
 *  the PDF header line, the XLSX info block and the CSV preamble so every
 *  export shows the SAME filter description. Empty string when nothing was
 *  applied (null/undefined/empty values are skipped). */
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
  return bits.join(", ")
}

/** CSV of an AnalyticsReport — the SAME data the UI renders, one section per
 *  block (KPI summary, each chart's series, the table). Both exports (this
 *  CSV twin and the client-side XLSX built from the same payload) derive
 *  from the contract, so the two can never diverge again. */
export function reportToCsv(report: AnalyticsReport): string {
  const lines: string[] = []
  const q = (v: unknown): string => {
    let s = v == null ? "" : String(v)
    // GAP-328 — same M-8 guard as utils.csv, for TEXT cells only: a real number
    // (negative deltas included) must stay numeric in the spreadsheet.
    if (typeof v !== "number" && /^[=+\-@\t\r]/.test(s)) s = "'" + s
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  lines.push(`# ${report.title}`)
  lines.push(`# Period: ${report.period.label}`)
  const filtersLine = describeFilters(report.filters)
  if (filtersLine) lines.push(`# Filters: ${filtersLine}`)
  if (report.period.comparison) lines.push(`# Comparison: ${report.period.comparison.label}`)
  lines.push(`# Scope: ${report.scope.description}`)
  lines.push(`# Generated: ${report.generatedAt}`)
  lines.push("")
  lines.push("KPI,Value,Unit,Previous,Δ%,Definition")
  for (const k of report.kpis) {
    lines.push([
      q(k.label), q(k.value ?? ""), q(k.unit),
      q(k.previous?.value ?? ""), q(k.previous?.deltaPct == null ? "" : `${k.previous.deltaPct > 0 ? "+" : ""}${k.previous.deltaPct}%`),
      q(k.definition),
    ].join(","))
  }
  for (const c of report.charts) {
    lines.push("")
    lines.push(`# Chart: ${c.title} (${c.kind})`)
    lines.push("Series,Point,Value")
    for (const s of c.series) {
      for (const pt of s.points) {
        lines.push([q(s.name), q(pt.label), q(pt.value)].join(","))
      }
    }
  }
  if (report.table) {
    lines.push("")
    lines.push(report.table.columns.map((c) => q(c.label)).join(","))
    for (const row of report.table.rows) {
      lines.push(row.map(q).join(","))
    }
  }
  if (report.warnings.length) {
    lines.push("")
    lines.push("# Warnings")
    for (const w of report.warnings) lines.push(`# - ${w}`)
  }
  return lines.join("\n")
}
