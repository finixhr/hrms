"use client"
// ============ Shared UI primitives for all HRM views ============
import { useState } from "react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Skeleton } from "@/components/ui/skeleton"

// HRM-003/L5 — vendor date format preference, applied app-wide.
// Written by the app shell whenever fresh settings arrive (and cached in
// localStorage so a reload never flashes the wrong format).
const DATE_FORMATS: Record<string, Intl.DateTimeFormatOptions> = {
  "DD MMM YYYY": { day: "2-digit", month: "short", year: "numeric" },
  "YYYY-MM-DD": { year: "numeric", month: "2-digit", day: "2-digit" },
  "MM/DD/YYYY": { month: "2-digit", day: "2-digit", year: "numeric" },
  "DD/MM/YYYY": { day: "2-digit", month: "2-digit", year: "numeric" },
}
let dateLocale = "en-GB"
let dateOptions: Intl.DateTimeFormatOptions = DATE_FORMATS["DD MMM YYYY"]
// M-9 — vendor localization (currency symbol + number grouping + clock)
// applied app-wide, same pattern as the date format.
let moneySymbol = "৳"
let moneyLocale = "en-IN" // 1,23,456 lakh-grouping (BD convention)
let clockHour12 = true
export function applyLocalization(loc?: {
  currencySymbol?: string | null
  numberFormat?: string | null
  timeFormat?: string | null
} | null) {
  if (loc?.currencySymbol) moneySymbol = loc.currencySymbol
  if (loc?.numberFormat === "123,456") moneyLocale = "en-US"
  else if (loc?.numberFormat === "1,23,456") moneyLocale = "en-IN"
  if (loc?.timeFormat === "24h") clockHour12 = false
  else if (loc?.timeFormat === "12h") clockHour12 = true
}
export function applyDateFormat(fmt?: string | null, locale?: string) {
  if (fmt && DATE_FORMATS[fmt]) dateOptions = DATE_FORMATS[fmt]
  // M-9 — Bangla mode renders dates AND numerals through the Bangla locale;
  // English mode pins the en-GB locale (the previous code never switched the
  // locale, so Bangla UI showed English dates/numerals)
  if (locale === "bn") dateLocale = "bn-BD"
  else if (locale) dateLocale = locale
  try { if (fmt) localStorage.setItem("hrm_date_format", fmt) } catch { /* private mode */ }
}
try {
  const cached = typeof localStorage !== "undefined" ? localStorage.getItem("hrm_date_format") : null
  if (cached && DATE_FORMATS[cached]) dateOptions = DATE_FORMATS[cached]
  // hydration-consistent Bangla dates: the language preference is readable
  // before React mounts, so first paint already matches the active language
  if (typeof localStorage !== "undefined" && localStorage.getItem("hrm_lang") === "bn") dateLocale = "bn-BD"
} catch { /* private mode */ }

/** M-9 — money display: 2 fraction digits ONLY when the value carries paisa
 *  precision (the H-9 paisa columns make those values lossless); whole-taka
 *  amounts stay compact. Honors the vendor's currency symbol + number
 *  grouping from the localization settings. */
export function fmtMoney(n: number | null | undefined, opts?: { paisaPrecision?: boolean }): string {
  const v = Number(n || 0)
  const hasFraction = opts?.paisaPrecision === true || (Number.isFinite(v) && Math.abs(v % 1) >= 0.005)
  return moneySymbol + v.toLocaleString(moneyLocale, {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2,
  })
}

// ============ M-29 — the ONE selfie-proof viewer ============
// Two divergent copies existed (attendance-history: a bare fixed div without
// focus trap or aria attributes; attendance-security: a proper Dialog). The
// Dialog version wins — focus trap, ESC handling and aria come from the
// shared radix primitives, and both call sites now render THIS component.
export function SelfieViewer({ selfie, onClose }: { selfie: { url: string; who: string } | null; onClose: () => void }) {
  if (!selfie) return null
  return (
    <div role="dialog" aria-modal="true" aria-label={`Selfie proof — ${selfie.who}`}
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-white dark:bg-slate-900 rounded-2xl max-w-lg w-full p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">Selfie Proof — {selfie.who}</p>
          <button type="button" onClick={onClose} className="text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 px-2 py-1 rounded">Close</button>
        </div>
        <img src={selfie.url} alt="selfie proof" className="w-full rounded-lg" />
        <p className="text-[11px] text-slate-400">
          Evidence only — not identity verification. This view was recorded in the audit trail.
        </p>
      </div>
    </div>
  )
}

// C-07 — THE one HTML escaper for every print builder (procurement / AIT / ESS
// certificates, reports). Escapes all five HTML-significant characters so a
// value can never break out of text content or an attribute context. Bangla
// names, apostrophes (O'Brien) and quotes round-trip correctly as entities.
// Previously this lived privately inside reports.tsx; the three print builders
// in procurement.tsx / ait.tsx / ess.tsx interpolated raw values instead.
export function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/** V4-011: Timezone-aware today() for the client.
 *  Uses Intl to format in Asia/Dhaka regardless of browser locale,
 *  preventing date drift after 18:00 UTC on a UTC-offset browser. */
export function todayDhaka(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Dhaka" }) // sv-SE gives YYYY-MM-DD
}

export function fmtDate(iso?: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso + (iso.length === 10 ? "T00:00:00" : ""))
  if (isNaN(d.getTime())) return iso
  return d.toLocaleDateString(dateLocale, dateOptions)
}

/** L-9 — date-only expiry check in the viewer's LOCAL timezone.
 *  `new Date("2026-09-21")` parses at UTC midnight, so comparing it against
 *  `new Date()` marks documents expired up to a day early (or late) depending
 *  on the viewer's timezone. Date-only strings compared lexically against the
 *  LOCAL today key sidestep the timezone entirely: a doc expiring today is
 *  only expired from tomorrow, local time. */
export function isExpired(dateStr?: string | null, todayKey?: string): boolean {
  if (!dateStr) return false
  const d = String(dateStr).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false
  const today = todayKey ?? new Date().toLocaleDateString("en-CA") // YYYY-MM-DD, local
  return d < today
}

export function fmtDateTime(d?: string | Date | null): string {
  if (!d) return "—"
  const dd = new Date(d)
  // M-9 — honors the vendor timeFormat preference (12h/24h)
  return dd.toLocaleString(dateLocale, { ...dateOptions, hour: "2-digit", minute: "2-digit", hour12: clockHour12 })
}

export function titleCase(s?: string | null): string {
  if (!s) return "—"
  return s.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
}

export function minutesHHMM(m: number): string {
  if (!m) return "—"
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

// ---------- M-9 — shared field-error display (role=alert for screen readers) ----------
/** Every form/dialog error banner in the app renders through this component
 *  so assistive tech ANNOUNCES the error (role="alert") instead of silently
 *  showing red text. Used by FormDialog, ConfirmDialog, login and ESS. */
export function FieldError({ message }: { message?: string | null }) {
  if (!message) return null
  return (
    <p role="alert" className="text-sm text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950 rounded-md px-3 py-2">
      {message}
    </p>
  )
}

// ---------- Page header ----------
/** 2026 redesign — compact page header: tighter title (text-lg), muted
 *  subtitle, right-aligned actions. Same props contract as before. */
export function PageHeader({ title, subtitle, actions }: { title: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 mb-4">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-100">{title}</h1>
        {subtitle && <p className="text-[13px] text-slate-500 dark:text-slate-400 mt-0.5">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-1.5">{actions}</div>}
    </div>
  )
}

// ---------- Stat card ----------
/** 2026 redesign — restrained KPI card: soft tinted icon chip (no heavy
 *  gradients), tabular value, hover lift on clickable variants. TONE KEYS AND
 *  PROPS ARE UNCHANGED so all 30+ call-sites keep working. */
const STAT_TONES: Record<string, string> = {
  emerald: "text-emerald-600 dark:text-emerald-400 bg-emerald-500/12 dark:bg-emerald-400/15 ring-emerald-500/20",
  amber: "text-amber-600 dark:text-amber-400 bg-amber-500/12 dark:bg-amber-400/15 ring-amber-500/20",
  rose: "text-rose-600 dark:text-rose-400 bg-rose-500/12 dark:bg-rose-400/15 ring-rose-500/20",
  sky: "text-sky-600 dark:text-sky-400 bg-sky-500/12 dark:bg-sky-400/15 ring-sky-500/20",
  violet: "text-violet-600 dark:text-violet-400 bg-violet-500/12 dark:bg-violet-400/15 ring-violet-500/20",
  teal: "text-teal-600 dark:text-teal-400 bg-teal-500/12 dark:bg-teal-400/15 ring-teal-500/20",
  orange: "text-orange-600 dark:text-orange-400 bg-orange-500/12 dark:bg-orange-400/15 ring-orange-500/20",
  slate: "text-slate-600 dark:text-slate-300 bg-slate-500/12 dark:bg-slate-400/15 ring-slate-500/20",
}
export function StatCard({ label, value, sub, icon: Icon, tone = "emerald", onClick }: {
  label: string; value: string | number; sub?: string; icon?: any; tone?: keyof typeof STAT_TONES; onClick?: () => void
}) {
  const body = (
    <CardContent className="p-3.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400 truncate">{label}</p>
          <p className="text-[22px] leading-7 font-bold text-slate-900 dark:text-slate-50 mt-0.5 tabular-nums">{value}</p>
          {sub && <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 truncate">{sub}</p>}
        </div>
        {Icon && (
          <div className={cn("shrink-0 h-8 w-8 rounded-lg ring-1 flex items-center justify-center", STAT_TONES[tone] || STAT_TONES.emerald)}>
            <Icon className="h-4 w-4" strokeWidth={2} />
          </div>
        )}
      </div>
    </CardContent>
  )
  // M-9 — the clickable card is a real BUTTON (focusable, Enter/Space
  // activation, screen-reader name) instead of a div with an onClick
  if (onClick) {
    return (
      <button type="button" onClick={onClick}
        aria-label={`${label}: ${value}${sub ? ` — ${sub}` : ""}`}
        className="relative overflow-hidden group cursor-pointer text-left w-full rounded-xl border bg-card text-card-foreground hrm-shadow-xs hover:hrm-shadow-md hover:-translate-y-px active:translate-y-0 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1">
        {body}
      </button>
    )
  }
  return <Card className="relative overflow-hidden group">{body}</Card>
}

// ---------- Status badge ----------
const STATUS_COLORS: Record<string, string> = {
  ACTIVE: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  PRESENT: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  APPROVED: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  PAID: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  ISSUED: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  CLEARED: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  RECOVERED: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  COMPLETED: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  VERIFIED: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  ONLINE: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  PENDING: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  PROBATION: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  DRAFT: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  CALCULATED: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  HR_REVIEW: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  MANAGER_APPROVAL: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  ACCOUNTING_APPROVAL: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  SUBMITTED: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  UNDER_REVIEW: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  NOTICE_PERIOD: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  ON_LEAVE: "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
  LATE: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  EARLY_LEAVE: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  HALF_DAY: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  LEAVE: "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
  WFH: "bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300",
  BUSINESS_TRIP: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300",
  REJECTED: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  ABSENT: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  TERMINATED: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  RETIRED: "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
  SUSPENDED: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  EXPIRED: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  ERROR: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  OFFLINE: "bg-slate-300 text-slate-700 dark:bg-slate-700 dark:text-slate-300",
  CANCELLED: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
  WITHDRAWN: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
  RESIGNED: "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-300",
  WEEKLY_OFF: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
  HOLIDAY: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  TODO: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  IN_PROGRESS: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  ON_HOLD: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  CLOSED: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  RECOVERING: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  SUPERSEDED: "bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300",
  INACTIVE: "bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300",
}
export function StatusBadge({ status, className }: { status?: string | null; className?: string }) {
  if (!status) return <span className="text-slate-500 dark:text-slate-400">—</span>
  const cls = STATUS_COLORS[status] || "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
  return (
    <Badge variant="secondary" className={cn("font-medium whitespace-nowrap gap-1.5", cls, className)}>
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current opacity-80 shrink-0" />
      {titleCase(status)}
    </Badge>
  )
}

// ---------- Key/value grid ----------
export function KV({ items, cols = 2 }: { items: [string, React.ReactNode][]; cols?: number }) {
  return (
    <div className={cn("grid gap-x-6 gap-y-3", cols === 3 ? "sm:grid-cols-3" : cols === 4 ? "sm:grid-cols-2 lg:grid-cols-4" : "sm:grid-cols-2")}>
      {items.map(([k, v], i) => (
        <div key={i} className="min-w-0">
          <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">{k}</dt>
          <dd className="text-sm font-medium text-slate-800 dark:text-slate-200 break-words">{v ?? "—"}</dd>
        </div>
      ))}
    </div>
  )
}

// ---------- Tabs wrapper ----------
/** A single tab. `badge` renders a count pill (only when > 0). `badgeTone` allows semantic color (default neutral). `description` renders context banner directly under sub-tabs. */
export type SectionTab = {
  value: string
  label: string
  content: React.ReactNode
  badge?: number
  badgeTone?: "neutral" | "rose" | "amber" | "emerald"
  description?: React.ReactNode
}
/** A labelled cluster of tabs rendered as a second navigation level. */
export type SectionTabGroup = { label: string; tabs: SectionTab[] }

/** UI-R3 (2026-10-04 UI audit): SectionTabs grew a grouped mode.
 *
 * PROBLEM — pages with 9–20 tabs (Settings ≈20, Payroll 9, Attendance 8)
 * rendered every tab in ONE wrapping pill row: a multi-row "wall of tabs"
 * that was the single most-cited clutter complaint of the UI audit.
 *
 * FIX — when `groups` is passed, navigation becomes two-level:
 *   1. a compact segmented control of group labels (level 1)
 *   2. an underline chip row of the ACTIVE group's tabs only (level 2)
 * Flattened tab values still drive one Radix <Tabs>, so deep links
 * (`defaultValue`), badges and per-tab content are unchanged. Pages that
 * pass plain `tabs` keep the original single-row look.
 */
export function SectionTabs({ tabs, groups, defaultValue, value, onValueChange }: {
  tabs?: SectionTab[]
  groups?: SectionTabGroup[]
  defaultValue?: string
  value?: string
  onValueChange?: (val: string) => void
}) {
  const allTabs: SectionTab[] = groups ? groups.flatMap((g) => g.tabs) : (tabs || [])
  const [internalActive, setInternalActive] = useState<string>(defaultValue || allTabs[0]?.value || "")
  const active = value !== undefined ? value : internalActive
  const setActive = (val: string) => {
    if (value === undefined) setInternalActive(val)
    onValueChange?.(val)
  }
  const activeGroup = groups?.find((g) => g.tabs.some((t) => t.value === active))
  const activeTab = allTabs.find((t) => t.value === active)

  return (
    <Tabs value={active} onValueChange={setActive} className="w-full">
      {groups && activeGroup ? (
        <div className="mb-4">
          {/* level 1 — group segmented control */}
          <div role="group" aria-label="Sections" className="flex flex-wrap gap-1 rounded-lg bg-muted p-1 w-fit max-w-full">
            {groups.map((g) => {
              const groupBadge = g.tabs.reduce((s, t) => s + (t.badge != null && t.badge > 0 ? t.badge : 0), 0)
              const hasAlert = g.tabs.some((t) => t.badgeTone === "rose" && (t.badge != null && t.badge > 0))
              const hasWarn = g.tabs.some((t) => t.badgeTone === "amber" && (t.badge != null && t.badge > 0))
              const isOn = g.label === activeGroup.label
              return (
                <button key={g.label} type="button" aria-pressed={isOn} onClick={() => setActive(g.tabs[0].value)}
                  className={cn(
                    "rounded-md px-3 h-7 text-xs font-medium transition-colors whitespace-nowrap inline-flex items-center",
                    isOn ? "bg-card text-foreground shadow-sm hrm-brand-text"
                         : "text-muted-foreground hover:text-foreground",
                  )}>
                  {g.label}
                  {groupBadge > 0 && (
                    <span className={cn(
                      "ml-1.5 rounded-full text-[10px] px-1.5 py-0.5 font-bold tabular-nums border leading-none",
                      hasAlert
                        ? "bg-rose-500 text-white border-rose-600 shadow-xs"
                        : hasWarn
                        ? "bg-amber-500 text-white border-amber-600 shadow-xs"
                        : "bg-slate-200/80 text-slate-700 dark:bg-slate-800 dark:text-slate-300 border-slate-300/80 dark:border-slate-700 font-semibold"
                    )}>
                      {groupBadge}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
          {/* level 2 — tabs of the active group (underline chips) */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1.5 border-b">
            {activeGroup.tabs.map((t) => {
              const isOn = t.value === active
              return (
                <button key={t.value} type="button" role="tab" aria-selected={isOn} onClick={() => setActive(t.value)}
                  className={cn(
                    "relative py-1.5 text-[13px] border-b-2 -mb-px transition-colors whitespace-nowrap inline-flex items-center",
                    isOn ? "border-primary text-primary font-semibold"
                         : "border-transparent text-muted-foreground hover:text-foreground",
                  )}>
                  {t.label}
                  {t.badge != null && t.badge > 0 && (
                    <span className={cn(
                      "ml-1.5 rounded-full text-[10px] px-1.5 py-0.5 font-bold tabular-nums border leading-none",
                      t.badgeTone === "rose"
                        ? "bg-rose-500 text-white border-rose-600 shadow-xs"
                        : t.badgeTone === "amber"
                        ? "bg-amber-500 text-white border-amber-600 shadow-xs"
                        : t.badgeTone === "emerald"
                        ? "bg-emerald-600 text-white border-emerald-700 shadow-xs"
                        : "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 border-slate-300/80 dark:border-slate-700 font-semibold"
                    )}>
                      {t.badge}
                    </span>
                  )}
                </button>
              )
            })}
          </div>

          {/* Contextual description & compliance audit position (immediately beneath sub-tabs / at the red line) */}
          {activeTab?.description && (
            <div className="mt-3">
              {activeTab.description}
            </div>
          )}
        </div>
      ) : (
        <div>
          <TabsList className="flex-wrap h-auto gap-1 bg-muted p-1 rounded-lg">
            {allTabs.map((t) => (
              <TabsTrigger key={t.value} value={t.value} className="data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-sm hrm-brand-tab-active text-xs px-3 h-7 inline-flex items-center">
                {t.label}
                {t.badge != null && t.badge > 0 && (
                  <span className={cn(
                    "ml-1.5 rounded-full text-[10px] px-1.5 py-0.5 font-bold tabular-nums border leading-none",
                    t.badgeTone === "rose"
                      ? "bg-rose-500 text-white border-rose-600 shadow-xs"
                      : t.badgeTone === "amber"
                      ? "bg-amber-500 text-white border-amber-600 shadow-xs"
                      : t.badgeTone === "emerald"
                      ? "bg-emerald-600 text-white border-emerald-700 shadow-xs"
                      : "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 border-slate-300/80 dark:border-slate-700 font-semibold"
                  )}>
                    {t.badge}
                  </span>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
          {activeTab?.description && (
            <div className="mt-3">
              {activeTab.description}
            </div>
          )}
        </div>
      )}
      {allTabs.map((t) => (
        <TabsContent key={t.value} value={t.value} className={cn("mt-3", groups && (activeTab?.description ? "mt-2" : "mt-4"))}>{t.content}</TabsContent>
      ))}
    </Tabs>
  )
}

// ---------- Table row actions (UI-R4: one size system for every list page) ----------
// Before: each page hand-rolled its action column — h-6 px-2 text-[10px] here,
// h-9 text-xs there, ghost icon buttons elsewhere. Three primitives now cover
// the whole app, all at h-7 with text-xs labels (44px+ click targets are kept
// via padding; tones stay SEMANTIC: brand = confirm/go, danger = destructive).

/** Icon-only ghost action for tables (edit / delete / view / download).
 *  Row clicks stop at the button: without the explicit stopPropagation the
 *  click bubbles to the (clickable) <tr> and BOTH actions fire — e.g. opening
 *  the 360° profile behind a delete confirm dialog. */
export function RowIconButton({ icon: Icon, label, onClick, disabled, tone = "neutral" }: {
  icon: any; label: string; onClick?: (e?: React.MouseEvent) => void; disabled?: boolean; tone?: "neutral" | "danger" | "brand"
}) {
  return (
    <Button type="button" variant="ghost" size="icon"
      onClick={(e) => { e.stopPropagation(); onClick?.(e) }}
      disabled={disabled} title={label} aria-label={label}
      className={cn("h-7 w-7 shrink-0",
        tone === "danger" && "text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950",
        tone === "brand" && "text-slate-500 hover:text-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-950",
      )}>
      <Icon className="h-3.5 w-3.5" />
    </Button>
  )
}

/** Compact labelled action for tables (Approve / In / Out / Export). Same
 *  stopPropagation discipline as RowIconButton — clickable rows must not
 *  swallow (or double-fire on) row actions. */
export function RowButton({ icon: Icon, children, onClick, disabled, title, tone = "neutral" }: {
  icon?: any; children: React.ReactNode; onClick?: (e?: React.MouseEvent) => void; disabled?: boolean; title?: string; tone?: "neutral" | "brand" | "danger"
}) {
  return (
    <Button type="button" size="sm" variant={tone === "brand" ? "default" : "outline"}
      onClick={(e) => { e.stopPropagation(); onClick?.(e) }}
      disabled={disabled} title={title}
      className={cn("h-7 px-2.5 text-xs gap-1 shrink-0",
        tone === "brand" && "",
        tone === "danger" && "text-rose-700 border-rose-200 hover:bg-rose-50 hover:text-rose-800 dark:border-rose-900 dark:hover:bg-rose-950",
      )}>
      {Icon && <Icon className="h-3.5 w-3.5" />}
      {children}
    </Button>
  )
}

// ---------- Empty / loading states ----------
export function EmptyState({ icon: Icon, title, hint }: { icon?: any; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      {Icon && (
        <div className="mb-3 h-11 w-11 rounded-full bg-muted flex items-center justify-center">
          <Icon className="h-5 w-5 text-muted-foreground" />
        </div>
      )}
      <p className="text-[13px] font-medium text-slate-500 dark:text-slate-400">{title}</p>
      {hint && <p className="text-xs text-slate-400 dark:text-slate-500 mt-1 max-w-sm">{hint}</p>}
    </div>
  )
}

export function LoadingRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: rows }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
    </div>
  )
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-rose-200 bg-rose-50 dark:border-rose-900 dark:bg-rose-950 p-4 text-sm text-rose-700 dark:text-rose-300">
      {message}
    </div>
  )
}

// ---------- Section card ----------
export function SectionCard({ title, description, actions, children, className }: { title?: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <Card className={className}>
      {title && (
        <CardHeader className="py-3 min-h-[44px] flex flex-row items-center justify-between space-y-0">
          <div className="min-w-0">
            <CardTitle className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 tracking-tight">{title}</CardTitle>
            {description && <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5 font-normal">{description}</p>}
          </div>
          {actions}
        </CardHeader>
      )}
      <CardContent className={title ? "pt-0" : "p-4"}>{children}</CardContent>
    </Card>
  )
}

// ---------- Progress pill for ratings ----------
export function RatingStars({ value }: { value: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" title={`${value}/5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={i <= Math.round(value) ? "text-amber-400" : "text-slate-300 dark:text-slate-600"}>★</span>
      ))}
      <span className="ml-1 text-xs font-medium text-slate-600 dark:text-slate-300">{value}</span>
    </span>
  )
}


/**
 * H-1 — the ONE safe way to display server-rendered print HTML (payslips,
 * letters). The server escapes/sanitizes every value and ships a
 * default-src 'none' CSP with no scripts; this helper additionally refuses
 * to write anything if the payload smuggles a <script> tag, an inline event
 * handler (on*=…) or a javascript: URL past that defense (C-07). Print is
 * triggered by the OPENER (same-origin call), never by document scripts.
 * Replaces the three duplicated window.open+document.write sites.
 */
export function openPrintWindow(html: string, opts?: { print?: boolean }): Window | null {
  if (typeof window === "undefined") return null
  // C-07 — reject event-handler attributes (onerror=, onload=, …) and
  // javascript: URLs BEFORE the markup ever reaches document.write.
  if (/<script[\s>]/i.test(html) || /\son\w+\s*=/i.test(html) || /javascript\s*:/i.test(html)) {
    // belt & braces — the server CSP already blocks scripts; a payload here
    // means the renderer contract was violated. Refuse to display it.
    console.error("[print] refusing HTML containing script/event-handler/javascript: content")
    return null
  }
  const w = window.open("", "_blank")
  if (!w) return null
  w.document.write(html)
  w.document.close()
  if (opts?.print) setTimeout(() => { try { w.print() } catch { /* ignore */ } }, 400)
  return w
}
