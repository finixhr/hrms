// ============ KPI Performance System — shared vocabulary (2026-11 redesign) ============
// Pure constants + types shared by the scoring engine, the indicator registry,
// the Excel engine, the routes and the frontend contract. No imports — safe to
// reference from anywhere (including dbless unit tests).

export type KpiUnit =
  | "PERCENT"
  | "NUMBER"
  | "CURRENCY"
  | "SCORE"
  | "HOURS"
  | "DAYS"
  | "BOOLEAN"
  | "CUSTOM"

export type KpiDirection = "HIGHER_IS_BETTER" | "LOWER_IS_BETTER" | "EXACT_TARGET"

export const KPI_UNITS: { value: KpiUnit; label: string; suffix: string }[] = [
  { value: "PERCENT", label: "Percentage (%)", suffix: "%" },
  { value: "NUMBER", label: "Number (count)", suffix: "" },
  { value: "CURRENCY", label: "Currency (৳)", suffix: "৳" },
  { value: "SCORE", label: "Score (0–100)", suffix: "" },
  { value: "HOURS", label: "Hours", suffix: "h" },
  { value: "DAYS", label: "Days", suffix: "d" },
  { value: "BOOLEAN", label: "Boolean (0/1)", suffix: "" },
  { value: "CUSTOM", label: "Custom unit", suffix: "" },
]

export const KPI_DIRECTIONS: { value: KpiDirection; label: string; hint: string }[] = [
  { value: "HIGHER_IS_BETTER", label: "Higher is better", hint: "Achievement % = actual ÷ target × 100" },
  { value: "LOWER_IS_BETTER", label: "Lower is better", hint: "Achievement % = target ÷ actual × 100 (e.g. response time, error rate)" },
  { value: "EXACT_TARGET", label: "Exact target", hint: "Scored against an exact target with a configurable tolerance" },
]

/** Target-assignment + achievement status machine (2026-11 redesign).
 * Transitions:
 *   DRAFT → PENDING_APPROVAL (submit) → APPROVED | REJECTED | CHANGES_REQUESTED
 *   CHANGES_REQUESTED → PENDING_APPROVAL (resubmit after edit)
 *   APPROVED → (edit) → PENDING_APPROVAL with revision+1 and archived snapshot
 *   any → CANCELLED (creator / approver with kpi.edit) */
export type KpiStatus =
  | "DRAFT"
  | "PENDING_APPROVAL"
  | "APPROVED"
  | "REJECTED"
  | "CHANGES_REQUESTED"
  | "CANCELLED"

export const KPI_STATUSES: KpiStatus[] = [
  "DRAFT", "PENDING_APPROVAL", "APPROVED", "REJECTED", "CHANGES_REQUESTED", "CANCELLED",
]

/** Batch status — PENDING_APPROVAL → PARTIALLY_APPROVED → APPROVED | REJECTED | CANCELLED. */
export type KpiBatchStatus = "PENDING_APPROVAL" | "PARTIALLY_APPROVED" | "APPROVED" | "REJECTED" | "CANCELLED"

export const KPI_PERIOD_TYPES = ["MONTHLY", "QUARTERLY", "YEARLY", "CUSTOM"] as const
export type KpiPeriodType = (typeof KPI_PERIOD_TYPES)[number]

export const KPI_MAX_WEIGHT_TOTAL = 100
/** Hard cap on any bulk Excel import row count (mirrors KPI_BULK_MAX in the legacy route). */
export const KPI_IMPORT_MAX_ROWS = 5000
/** Excel upload size cap (base64 payload ≈ 8 MB) — mirrors the employee bulk import bound. */
export const KPI_IMPORT_MAX_BYTES = 8 * 1024 * 1024

/** Default performance rating bands (configurable per tenant via the
 * `performance` settings group — never hardcode these in feature code). */
export const DEFAULT_KPI_RATINGS: { min: number; label: string }[] = [
  { min: 90, label: "Outstanding" },
  { min: 80, label: "Exceeds Expectations" },
  { min: 70, label: "Meets Expectations" },
  { min: 60, label: "Needs Improvement" },
  { min: 0, label: "Unsatisfactory" },
]

/** Tenant-level KPI settings (HrSettings.performance). */
export type KpiPerformanceSettings = {
  /** over-achievement clamp for achievement % (≥ 100). */
  achievementMaxPct: number
  /** EXACT_TARGET scoring: within ± this % of target counts as 100. */
  exactTolerancePct: number
  /** true: indicators without approved achievements count as score 0 in the
   * weighted average; false (default): they are excluded from BOTH the
   * numerator and the denominator. */
  missingDataCountsZero: boolean
  /** true: the creator may approve their own submission (SoD lift). */
  selfApprovalAllowed: boolean
  /** decimal places for achievement % / scores (default 1). */
  scoreDecimals: number
  /** configurable rating bands — [{min, label}] sorted descending by min. */
  ratings: { min: number; label: string }[]
}

export const DEFAULT_KPI_PERFORMANCE_SETTINGS: KpiPerformanceSettings = {
  achievementMaxPct: 100,
  exactTolerancePct: 5,
  missingDataCountsZero: false,
  selfApprovalAllowed: false,
  scoreDecimals: 1,
  ratings: DEFAULT_KPI_RATINGS,
}
