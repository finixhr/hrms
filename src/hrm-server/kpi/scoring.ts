// ============ KPI scoring engine (2026-11 redesign) ============
// Pure, reusable, DB-free. Consumers: the achievement routes (per-indicator
// scoring), the assignment mirror sync (weighted totals), the analytics
// services (aggregates) and the dbless unit tests.
//
// SCORING RULES (documented for auditors — mirrored in the UI tooltips):
//   Achievement % per indicator (clamped to [0, achievementMaxPct], rounded to
//   scoreDecimals, default 1):
//     HIGHER_IS_BETTER  → actual / target × 100
//                         target ≤ 0 and actual > 0 → achievementMaxPct (any
//                         result exceeds a zero target); target ≤ 0 and
//                         actual ≤ 0 → null (undefined measurement).
//     LOWER_IS_BETTER   → target / actual × 100
//                         actual ≤ 0 → achievementMaxPct (perfect — zero is the
//                         best possible "lower"); target ≤ 0 and actual > 0 → 0.
//     EXACT_TARGET      → within ± exactTolerancePct of the target → 100;
//                         otherwise 100 − |actual − target| / |target| × 100
//                         (absolute deviation when target = 0).
//   Weighted score = Σ(achievementPct_i × w_i) / Σ(w_i), computed over the
//   indicators that HAVE a score. Indicators without data are excluded from
//   both sides unless settings.performance.missingDataCountsZero, in which
//   case they contribute 0 to the numerator and their weight to the
//   denominator.
//   Final performance scores are ONLY computed from APPROVED achievements —
//   pending/rejected actuals never move a weighted score.
import { DEFAULT_KPI_PERFORMANCE_SETTINGS, type KpiDirection, type KpiPerformanceSettings } from "./constants"

export type ScoreInput = {
  direction: KpiDirection
  target: number | null | undefined
  actual: number | null | undefined
}

export type ScoringOptions = Pick<KpiPerformanceSettings, "achievementMaxPct" | "exactTolerancePct" | "scoreDecimals">

const DEFAULTS: ScoringOptions = {
  achievementMaxPct: DEFAULT_KPI_PERFORMANCE_SETTINGS.achievementMaxPct,
  exactTolerancePct: DEFAULT_KPI_PERFORMANCE_SETTINGS.exactTolerancePct,
  scoreDecimals: DEFAULT_KPI_PERFORMANCE_SETTINGS.scoreDecimals,
}

const round = (v: number, decimals: number) => {
  const f = Math.pow(10, decimals)
  return Math.round(v * f) / f
}

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Normalize tenant settings defensively (bad/missing values fall back). */
export function scoringOptions(partial?: Partial<KpiPerformanceSettings> | null): ScoringOptions {
  return {
    achievementMaxPct: Math.max(100, num(partial?.achievementMaxPct) ?? DEFAULTS.achievementMaxPct),
    exactTolerancePct: Math.min(100, Math.max(0, num(partial?.exactTolerancePct) ?? DEFAULTS.exactTolerancePct)),
    scoreDecimals: Math.min(3, Math.max(0, Math.round(num(partial?.scoreDecimals) ?? DEFAULTS.scoreDecimals))) as 0 | 1 | 2 | 3,
  }
}

/** Achievement % for one indicator. null = undefined measurement (no target,
 * no actual, or a mathematically undefined combination — see the header). */
export function achievementPct(input: ScoreInput, opts?: Partial<ScoringOptions>): number | null {
  const o = { ...DEFAULTS, ...opts }
  const target = num(input.target)
  const actual = num(input.actual)
  if (actual == null) return null
  if (input.direction === "LOWER_IS_BETTER") {
    if (actual <= 0) return o.achievementMaxPct
    if (target == null) return null
    if (target <= 0) return 0
    return round(clamp((target / actual) * 100, o.achievementMaxPct), o.scoreDecimals)
  }
  if (input.direction === "EXACT_TARGET") {
    if (target == null) return null
    if (target === 0) return round(clamp(actual === 0 ? o.achievementMaxPct : 0, o.achievementMaxPct), o.scoreDecimals)
    const deviationPct = (Math.abs(actual - target) / Math.abs(target)) * 100
    if (deviationPct <= o.exactTolerancePct) return o.achievementMaxPct
    return round(clamp(100 - deviationPct, o.achievementMaxPct), o.scoreDecimals)
  }
  // HIGHER_IS_BETTER
  if (target == null) return null
  if (target <= 0) return actual > 0 ? o.achievementMaxPct : null
  return round(clamp((actual / target) * 100, o.achievementMaxPct), o.scoreDecimals)
}

function clamp(v: number, max: number): number {
  return Math.max(0, Math.min(v, max))
}

/** Per-indicator weighted contribution: achievementPct × weight / 100. */
export function indicatorScore(pct: number | null, weight: number | null | undefined): number | null {
  if (pct == null) return null
  const w = num(weight) ?? 0
  return round((pct * w) / 100, 2)
}

export type WeightedItem = { pct: number | null; weight: number | null | undefined }

export type WeightedResult = {
  /** weighted-average achievement on a 0–achievementMaxPct scale */
  score: number | null
  /** number of indicators that contributed */
  counted: number
  /** number of indicators skipped for missing data */
  missing: number
  /** normalization basis — present when the weights did not sum to 100 */
  basis?: { totalWeight: number; countedWeight: number }
}

/** Weighted KPI score = Σ(pct×w)/Σ(w). Missing data is excluded from both
 * sides unless missingDataCountsZero. */
export function weightedScore(
  items: WeightedItem[],
  opts?: Partial<ScoringOptions & Pick<KpiPerformanceSettings, "missingDataCountsZero">>,
): WeightedResult {
  const o = { ...DEFAULTS, ...opts }
  const missingDataCountsZero = opts?.missingDataCountsZero ?? DEFAULT_KPI_PERFORMANCE_SETTINGS.missingDataCountsZero
  const totalWeight = items.reduce((s, i) => s + (num(i.weight) ?? 0), 0)
  let counted = 0
  let missing = 0
  let numerator = 0
  let countedWeight = 0
  for (const i of items) {
    const w = num(i.weight) ?? 0
    if (i.pct == null) {
      missing++
      if (missingDataCountsZero) {
        countedWeight += w // contributes 0 to the numerator, weight to denominator
        counted++
      }
      continue
    }
    counted++
    countedWeight += w
    numerator += i.pct * w
  }
  if (!counted) return { score: null, counted: 0, missing }
  const score = countedWeight > 0 ? numerator / countedWeight : null
  return {
    score: score == null ? null : round(clamp(score, o.achievementMaxPct), o.scoreDecimals),
    counted,
    missing,
    ...(totalWeight !== 100 && totalWeight > 0 ? { basis: { totalWeight, countedWeight } } : {}),
  }
}

export type RatingBand = { min: number; label: string }

export type RatingResult = { label: string; rank: number; stars: number }

/** Resolve the rating band for a weighted score. Bands are the configurable
 * `performance.ratings` list; the numeric legacy mirror rating (1–n stars,
 * n = band count) keeps the KpiAssignment.rating column meaningful. */
export function ratingFor(
  score: number | null | undefined,
  bands?: RatingBand[] | null,
): RatingResult | null {
  if (score == null) return null
  const list = (bands && bands.length ? bands : DEFAULT_KPI_PERFORMANCE_SETTINGS.ratings)
    .filter((b) => b && typeof b.min === "number" && Number.isFinite(b.min) && typeof b.label === "string" && b.label.trim())
    .sort((a, b) => b.min - a.min)
  if (!list.length) return null
  const idx = list.findIndex((b) => score >= b.min)
  const band = list[idx === -1 ? list.length - 1 : idx]
  const rank = idx === -1 ? list.length : idx + 1
  return { label: band.label, rank, stars: Math.max(1, list.length - rank + 1) }
}

// ============ Period resolution ============
// periodLabel formats: "YYYY-MM" (monthly) · "YYYY-Qn" (quarterly) · "YYYY"
// (yearly) · anything else = CUSTOM and requires explicit periodStart/End.

export type PeriodRange = { start: string; end: string; type: "MONTHLY" | "QUARTERLY" | "YEARLY" | "CUSTOM" }

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()

const MONTH_LABELS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

/** Resolve a periodLabel (+ optional explicit window) into a concrete date
 * range. Unknown labels without an explicit window fall back to the calendar
 * month of `fallback` (default: today) so scoring is never undefined. */
export function resolvePeriodRange(
  periodLabel: string,
  periodStart?: string | null,
  periodEnd?: string | null,
  fallback?: Date,
): PeriodRange | null {
  const label = String(periodLabel || "").trim()
  let m: RegExpMatchArray | null
  if ((m = label.match(/^(\d{4})-(\d{2})$/))) {
    const y = Number(m[1])
    const mo = Number(m[2])
    if (mo >= 1 && mo <= 12) {
      return { start: `${m[1]}-${m[2]}-01`, end: `${m[1]}-${m[2]}-${daysInMonth(y, mo)}`, type: "MONTHLY" }
    }
  }
  if ((m = label.match(/^(\d{4})-Q([1-4])$/))) {
    const y = Number(m[1])
    const q = Number(m[2])
    const fromM = (q - 1) * 3 + 1
    const toM = q * 3
    return { start: `${m[1]}-${String(fromM).padStart(2, "0")}-01`, end: `${m[1]}-${String(toM).padStart(2, "0")}-${daysInMonth(y, toM)}`, type: "QUARTERLY" }
  }
  if ((m = label.match(/^(\d{4})$/))) {
    return { start: `${m[1]}-01-01`, end: `${m[1]}-12-31`, type: "YEARLY" }
  }
  if (periodStart && periodEnd && /^\d{4}-\d{2}-\d{2}$/.test(periodStart) && /^\d{4}-\d{2}-\d{2}$/.test(periodEnd) && periodStart <= periodEnd) {
    return { start: periodStart, end: periodEnd, type: "CUSTOM" }
  }
  const f = fallback ?? new Date()
  const y = f.getUTCFullYear()
  const mo = f.getUTCMonth() + 1
  return { start: `${y}-${String(mo).padStart(2, "0")}-01`, end: `${y}-${String(mo).padStart(2, "0")}-${daysInMonth(y, mo)}`, type: "MONTHLY" }
}

/** Human label: "November 2026" · "Q3 2026" · "2026" · passthrough for custom. */
export function formatPeriodLabel(periodLabel: string, periodStart?: string | null, periodEnd?: string | null): string {
  const label = String(periodLabel || "").trim()
  let m: RegExpMatchArray | null
  if ((m = label.match(/^(\d{4})-(\d{2})$/))) {
    const mo = Number(m[2])
    if (mo >= 1 && mo <= 12) return `${MONTH_LABELS[mo - 1]} ${m[1]}`
  }
  if ((m = label.match(/^(\d{4})-Q([1-4])$/))) return `Q${m[2]} ${m[1]}`
  if (/^\d{4}$/.test(label)) return label
  if (periodStart && periodEnd) return `${periodStart} → ${periodEnd}`
  return label || "—"
}

/** All distinct period labels covered by a [from, to] window, ordered
 * ascending — powers the multi-period analytics selector. */
export function periodLabelsBetween(from: string, to: string, granularity: "MONTHLY" | "QUARTERLY" | "YEARLY" = "MONTHLY"): string[] {
  const out: string[] = []
  if (granularity === "YEARLY") {
    const y1 = Number(from.slice(0, 4))
    const y2 = Number(to.slice(0, 4))
    for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) out.push(String(y))
    return out
  }
  if (granularity === "QUARTERLY") {
    // walk quarters by 3-month steps
    let y = Number(from.slice(0, 4))
    let mo = Number(from.slice(5, 7))
    const endY = Number(to.slice(0, 4))
    const endMo = Number(to.slice(5, 7))
    while (y < endY || (y === endY && mo <= endMo)) {
      const q = Math.ceil(mo / 3)
      const label = `${y}-Q${q}`
      if (!out.includes(label)) out.push(label)
      mo += 3
      if (mo > 12) { mo = 1; y++ }
    }
    return out.sort()
  }
  let y = Number(from.slice(0, 4))
  let mo = Number(from.slice(5, 7))
  const endY = Number(to.slice(0, 4))
  const endMo = Number(to.slice(5, 7))
  while (y < endY || (y === endY && mo <= endMo)) {
    out.push(`${y}-${String(mo).padStart(2, "0")}`)
    mo++
    if (mo > 12) { mo = 1; y++ }
  }
  return out
}

/** Unit-aware totals: percentages/scores average; number/counters sum;
 * incompatible units are NEVER merged (returns per-unit breakdown instead). */
export type UnitTotals = Record<string, { target: number; achieved: number; count: number; unit: string; label: string }>

export function sumUnitTotals(items: { unit: string; unitLabel?: string | null; target: number | null; actual: number | null }[]): UnitTotals {
  const out: UnitTotals = {}
  for (const it of items) {
    const key = it.unitLabel ? `${it.unit}:${it.unitLabel}` : it.unit
    if (!out[key]) out[key] = { unit: it.unit, label: it.unitLabel || it.unit, target: 0, achieved: 0, count: 0 }
    out[key].count++
    if (it.target != null) out[key].target += it.target
    if (it.actual != null) out[key].achieved += it.actual
  }
  return out
}
