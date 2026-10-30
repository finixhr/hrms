"use client"
// ============ /owner/analytics — Growth & Engagement console (Phase 5 P3) ====
// The growth slice of the Owner Panel, rebuilt on the P0/P1/P2 console design
// system (the old Wave 4 SG-C page — take:50 lists, alert() reminders, and a
// dunning queue now superseded by Revenue & Collections — is fully replaced).
// Data sources (all fixed-set, scale-first):
//   - owner.growth.overview — growth KPIs (tenants, signups 30d/MTD, trials),
//     MRR + ARPU + plan mix (the established priceAtCreation methodology),
//     the registration funnel, churn signals from the lifecycle event log,
//     live fleet usage + the monthly UsageSnapshot metering series with MoM
//     deltas, and engagement KPIs over successful tenant-plane logins.
//   - owner.growth.engagement — the per-tenant engagement matrix: the tier is
//     computed IN SQL (DORMANT / LIGHT / STEADY / POWER over a login LATERAL)
//     so the tier chips filter and the dormant-first sort never materialize
//     the fleet; usage seats + the MoM delta ride UsageSnapshot LATERALs.
// Read-only console — no mutations, no dunning (see Revenue & Collections).
import { useCallback, useEffect, useState } from "react"
import {
  ArrowDownRight, ArrowRight, ArrowUpRight, BarChart3, Building2, CalendarX2, ChevronLeft,
  ChevronRight, RefreshCw, Search, Sparkles, TrendingUp, Users, Wallet,
} from "lucide-react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useOwnerApi, ownerRpc } from "@/saas/owner/client"
import { ErrorBanner, KpiCard, Loading, PageHeader, TableShell, Td, fmtDate, gb } from "@/saas/owner/ui"
import { cn } from "@/lib/utils"

// ---- types ------------------------------------------------------------------
type UsageMetrics = {
  employeesTotal: number; employeesPayroll: number; portalUsers: number
  devicesEnrolled: number; storageBytes: number
}

type Overview = {
  generatedAt: string
  growth: {
    tenantsTotal: number; tenantsActive: number; newVendors30d: number; newVendorsMtd: number
    trialsCurrent: number
    signupTrend: { month: string; vendors: number }[]
  }
  revenue: {
    mrr: number; currency: string; payingSubs: number; arpu: number | null
    planMix: { planId: string; name: string; subscribers: number; mrr: number }[]
    pastDueSubs: number; failedPayments30d: number
  }
  churn: {
    cancelled30d: number; expired30d: number; suspended30d: number; reactivated30d: number
    churnRate30d: number | null
    events30d: { type: string; count: number }[]
  }
  usage: {
    live: UsageMetrics
    latestPeriod: string | null; previousPeriod: string | null
    latest: UsageMetrics | null; previous: UsageMetrics | null
    trend: ({ month: string } & UsageMetrics)[]
  }
  engagement: {
    engagedTenants30d: number; engagedActive30d: number; idleActive: number; logins30d: number
    engagedShare30d: number | null
    loginsByWeek: { weekStart: string; logins: number }[]
    registrations: Record<string, number>
  }
}

type MatrixRow = {
  id: string; name: string; code: string; vendorActive: boolean; vendorCreatedAt: string
  subStatus: string | null; planName: string | null
  logins30d: number; lastLoginAt: string | null; daysSinceLogin: number | null
  seatsNow: number | null; seatsPeriod: string | null; seatsPrev: number | null
  tier: string
}

// ---- formatting + tier metadata ----------------------------------------------
const fmtMoney = (n: number, currency = "BDT") =>
  `${currency === "BDT" ? "৳" : `${currency} `}${(Number(n) || 0).toLocaleString("en-IN")}`

const TIER_META: Record<string, { label: string; chip: string; hint: string }> = {
  DORMANT: {
    label: "Dormant",
    chip: "border-red-400/40 bg-red-500/10 text-red-300 light:text-red-600",
    hint: "no successful tenant login in 30 days",
  },
  LIGHT: {
    label: "Light",
    chip: "border-amber-400/40 bg-amber-500/10 text-amber-300 light:text-amber-700",
    hint: "1–9 logins in 30 days",
  },
  STEADY: {
    label: "Steady",
    chip: "border-sky-400/40 bg-sky-500/10 text-sky-300 light:text-sky-700",
    hint: "10–49 logins in 30 days",
  },
  POWER: {
    label: "Power",
    chip: "border-emerald-400/40 bg-emerald-500/10 text-emerald-300 light:text-emerald-700",
    hint: "50+ logins in 30 days",
  },
}

const TIER_CHIPS = [
  { key: "ALL", label: "All tenants" },
  { key: "DORMANT", label: "Dormant" },
  { key: "LIGHT", label: "Light" },
  { key: "STEADY", label: "Steady" },
  { key: "POWER", label: "Power" },
] as const
type TierChip = (typeof TIER_CHIPS)[number]["key"]

const REGISTRATION_META: { key: string; label: string; tile: string }[] = [
  { key: "PENDING", label: "Pending review", tile: "border-amber-400/30 bg-amber-500/[0.06] light:bg-amber-100/50" },
  { key: "APPROVED", label: "Approved", tile: "border-emerald-400/30 bg-emerald-500/[0.06] light:bg-emerald-100/50" },
  { key: "REJECTED", label: "Rejected", tile: "border-red-400/30 bg-red-500/[0.06] light:bg-red-100/50" },
  { key: "CANCELLED", label: "Cancelled", tile: "border-slate-400/30 bg-slate-500/[0.06] light:bg-slate-100/60" },
  { key: "WITHDRAWN", label: "Withdrawn", tile: "border-slate-400/30 bg-slate-500/[0.06] light:bg-slate-100/60" },
  { key: "TRIALS", label: "Trials live now", tile: "border-violet-400/30 bg-violet-500/[0.06] light:bg-violet-100/50" },
]

const monthLabel = (m: string) =>
  new Date(`${m}-01T00:00:00Z`).toLocaleString("en", { month: "short", timeZone: "UTC" })

const weekLabel = (w: string) =>
  new Date(`${w}T00:00:00Z`).toLocaleString("en", { month: "short", day: "numeric", timeZone: "UTC" })

const fmtAgo = (d: string | null, days: number | null): string => {
  if (!d) return "never"
  if (days == null) return fmtDate(d)
  if (days <= 0) return "today"
  if (days === 1) return "yesterday"
  return `${days}d ago`
}

/** Signed MoM delta chip: ▲ emerald / ▼ red / flat slate; null → honest dash. */
function DeltaChip({ now, prev, label }: { now: number | null; prev: number | null; label?: string }) {
  if (now == null || prev == null) {
    return <span className="text-[10px] font-semibold text-slate-600 light:text-slate-500">metering pending</span>
  }
  const d = now - prev
  const up = d > 0
  const flat = d === 0
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold tabular-nums",
      flat
        ? "border-slate-400/30 bg-slate-500/10 text-slate-400 light:text-slate-600"
        : up
          ? "border-emerald-400/40 bg-emerald-500/10 text-emerald-300 light:text-emerald-700"
          : "border-red-400/40 bg-red-500/10 text-red-300 light:text-red-600")}>
      {flat ? "±0" : up ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
      {flat ? "" : Math.abs(d).toLocaleString("en-IN")}{label ? ` ${label}` : ""}
    </span>
  )
}

/** 12-month signup trend — pure CSS bars (the P2 TrendChart language). */
function SignupChart({ trend }: { trend: Overview["growth"]["signupTrend"] }) {
  const max = Math.max(1, ...trend.map((t) => t.vendors))
  return (
    <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-5">
      <div className="mb-1 flex items-center justify-between">
        <p className="text-xs font-bold uppercase tracking-widest text-slate-500">New tenants — last 12 months</p>
        <span className="flex items-center gap-1.5 text-[10px] font-semibold text-slate-500">
          <span className="h-2 w-2 rounded-full bg-violet-400" /> Signups
        </span>
      </div>
      <p className="mb-4 text-[11px] text-slate-600 light:text-slate-500">Tenant creations per calendar month, from vendor records — zeros are honest.</p>
      <div className="flex h-40 items-end gap-1 sm:gap-2">
        {trend.map((t) => (
          <div key={t.month} className="flex h-full flex-1 flex-col items-center justify-end gap-1.5">
            <div
              className="w-full max-w-[26px] rounded-t-md bg-gradient-to-t from-violet-600/70 to-fuchsia-400 transition-all"
              style={{ height: `${Math.max(t.vendors > 0 ? 4 : 0, (t.vendors / max) * 100)}%` }}
              title={`${t.month}: ${t.vendors} new tenant${t.vendors === 1 ? "" : "s"}`}
              aria-label={`${monthLabel(t.month)}: ${t.vendors} new tenants`}
            />
            <span className="text-[10px] font-semibold tabular-nums text-slate-500">{monthLabel(t.month)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** 6-month usage trend — payroll seats vs portal users (grouped CSS bars). */
function UsageChart({ trend }: { trend: Overview["usage"]["trend"] }) {
  const max = Math.max(1, ...trend.map((t) => Math.max(t.employeesPayroll, t.portalUsers)))
  return (
    <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-5">
      <div className="mb-1 flex items-center justify-between">
        <p className="text-xs font-bold uppercase tracking-widest text-slate-500">Fleet usage — last 6 months</p>
        <div className="flex items-center gap-3 text-[10px] font-semibold text-slate-500">
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-indigo-400" /> Payroll seats</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-teal-400" /> Portal users</span>
        </div>
      </div>
      <p className="mb-4 text-[11px] text-slate-600 light:text-slate-500">
        Fleet-summed monthly UsageSnapshot records — the frozen end-of-month series the nightly platform job captures.
      </p>
      <div className="flex h-40 items-end gap-2 sm:gap-4">
        {trend.map((t) => (
          <div key={t.month} className="flex h-full flex-1 flex-col items-center justify-end gap-1.5">
            <div className="flex h-full w-full items-end justify-center gap-1" aria-hidden>
              <div
                className="w-full max-w-[22px] rounded-t-md bg-gradient-to-t from-indigo-600/70 to-indigo-400 transition-all"
                style={{ height: `${Math.max(t.employeesPayroll > 0 ? 4 : 0, (t.employeesPayroll / max) * 100)}%` }}
                title={`${t.month}: ${t.employeesPayroll.toLocaleString("en-IN")} payroll seats`}
              />
              <div
                className="w-full max-w-[22px] rounded-t-md bg-gradient-to-t from-teal-600/70 to-teal-400 transition-all"
                style={{ height: `${Math.max(t.portalUsers > 0 ? 4 : 0, (t.portalUsers / max) * 100)}%` }}
                title={`${t.month}: ${t.portalUsers.toLocaleString("en-IN")} portal users`}
              />
            </div>
            <span className="text-[10px] font-semibold tabular-nums text-slate-500">{monthLabel(t.month)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** 6-week login activity — thin CSS bars with per-week tooltips. */
function LoginsChart({ weeks }: { weeks: Overview["engagement"]["loginsByWeek"] }) {
  const max = Math.max(1, ...weeks.map((w) => w.logins))
  return (
    <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-5">
      <p className="mb-1 text-xs font-bold uppercase tracking-widest text-slate-500">Successful tenant logins — last 6 weeks</p>
      <p className="mb-4 text-[11px] text-slate-600 light:text-slate-500">Successful tenant-plane authentications per calendar week (Monday start, UTC).</p>
      <div className="flex h-28 items-end gap-2 sm:gap-4">
        {weeks.map((w) => (
          <div key={w.weekStart} className="flex h-full flex-1 flex-col items-center justify-end gap-1.5">
            <span className="text-[10px] font-bold tabular-nums text-slate-400 light:text-slate-600">{w.logins.toLocaleString("en-IN")}</span>
            <div
              className="w-full max-w-[30px] rounded-t-md bg-gradient-to-t from-fuchsia-600/70 to-violet-400 transition-all"
              style={{ height: `${Math.max(w.logins > 0 ? 6 : 2, (w.logins / max) * 100)}%` }}
              title={`${weekLabel(w.weekStart)}: ${w.logins.toLocaleString("en-IN")} login${w.logins === 1 ? "" : "s"}`}
            />
            <span className="text-[10px] font-semibold text-slate-500">{weekLabel(w.weekStart)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** One plan-mix row: subscribers bar + MRR contribution. */
function PlanRow({ name, subscribers, mrr, max }: { name: string; subscribers: number; mrr: number; max: number }) {
  const pct = max > 0 ? Math.max(2, Math.round((mrr / max) * 100)) : 0
  return (
    <div className="flex items-center gap-3">
      <span className="w-28 shrink-0 truncate text-xs font-semibold text-slate-300 light:text-slate-700" title={name}>{name}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10 light:bg-slate-200">
        <div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-400" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-24 shrink-0 text-right text-xs tabular-nums text-slate-400 light:text-slate-600">{fmtMoney(mrr)}</span>
      <span className="w-20 shrink-0 text-right text-[10px] tabular-nums text-slate-600 light:text-slate-500">{subscribers} sub{subscribers === 1 ? "" : "s"}</span>
    </div>
  )
}

// ===== RENDER =====
type Tab = "growth" | "usage" | "engagement"
const TABS: { key: Tab; label: string; icon: any }[] = [
  { key: "growth", label: "Growth", icon: TrendingUp },
  { key: "usage", label: "Usage", icon: BarChart3 },
  { key: "engagement", label: "Engagement", icon: Users },
]

export default function GrowthEngagementPage() {
  const overview = useOwnerApi<Overview>("owner.growth.overview")
  const [tab, setTab] = useState<Tab>("growth")

  // ---- engagement matrix tab --------------------------------------------------
  const [page, setPage] = useState(1)
  const [tier, setTier] = useState<TierChip>("ALL")
  const [search, setSearch] = useState("")
  const [query, setQuery] = useState("")
  const [rows, setRows] = useState<MatrixRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pageSize] = useState(15)

  const loadMatrix = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const r = await ownerRpc<{ total: number; rows: MatrixRow[] }>("owner.growth.engagement", {
        page, pageSize, tier, search: query || undefined,
      })
      setRows(r.rows); setTotal(r.total)
    } catch (e: any) { setError(e?.message || "Failed to load the engagement matrix") } finally { setLoading(false) }
  }, [page, pageSize, tier, query])
  useEffect(() => { loadMatrix().catch(() => {}) }, [loadMatrix])

  // ---- 60 s auto-refresh: the overview + the matrix when its tab is open -----
  useEffect(() => {
    const t = setInterval(() => {
      overview.reload().catch(() => {})
      if (tab === "engagement") loadMatrix().catch(() => {})
    }, 60_000)
    return () => clearInterval(t)
  }, [tab, overview.reload, loadMatrix])

  const d = overview.data
  const maxPage = Math.max(1, Math.ceil(total / pageSize))
  const planMax = Math.max(1, ...(d?.revenue.planMix || []).map((p) => p.mrr))

  const usageTiles: { key: keyof UsageMetrics; label: string; fmt: (n: number) => string }[] = [
    { key: "employeesTotal", label: "Employees (total)", fmt: (n) => n.toLocaleString("en-IN") },
    { key: "employeesPayroll", label: "Payroll seats", fmt: (n) => n.toLocaleString("en-IN") },
    { key: "portalUsers", label: "Portal users", fmt: (n) => n.toLocaleString("en-IN") },
    { key: "devicesEnrolled", label: "Devices enrolled", fmt: (n) => n.toLocaleString("en-IN") },
    { key: "storageBytes", label: "Storage used", fmt: (n) => gb(n) },
  ]

  return (
    <div className="space-y-5">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-600 shadow-lg shadow-violet-950/50">
              <TrendingUp className="h-4 w-4 text-white" />
            </span>
            Growth &amp; Engagement
          </span>
        }
        sub="How the platform grows and how tenants use it — signups, recurring revenue, the registration funnel, fleet usage metering and the login-intensity matrix. Computed live from platform records."
        actions={
          <div className="flex items-center gap-2">
            {d && <span className="hidden text-xs text-slate-500 sm:inline">generated {new Date(d.generatedAt).toLocaleTimeString()}</span>}
            <Button variant="outline" size="sm" disabled={overview.loading}
              onClick={() => { overview.reload().catch(() => {}); if (tab === "engagement") loadMatrix().catch(() => {}) }}>
              <RefreshCw className={cn("h-3.5 w-3.5", overview.loading && "animate-spin")} /> Refresh
            </Button>
          </div>
        }
      />

      {overview.error && <ErrorBanner message={overview.error} />}
      {overview.loading && !d ? <Loading label="Computing growth analytics…" /> : d ? (
        <>
          {/* ---- headline KPIs ---- */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Tenants" value={d.growth.tenantsTotal.toLocaleString("en-IN")} icon={Building2}
              sub={`${d.growth.tenantsActive.toLocaleString("en-IN")} active · ${d.growth.newVendors30d} new in 30d · ${d.growth.newVendorsMtd} this month`} />
            <KpiCard label="MRR" value={fmtMoney(d.revenue.mrr)} tone="emerald" icon={Wallet}
              sub={d.revenue.payingSubs > 0
                ? `ARPU ${fmtMoney(d.revenue.arpu || 0)} · ${d.revenue.payingSubs} paying · trials excluded`
                : "No paying subscriptions yet — trials excluded by methodology"} />
            <KpiCard label="Engaged tenants (30d)" value={d.engagement.engagedActive30d.toLocaleString("en-IN")} tone="indigo" icon={Users}
              sub={d.engagement.engagedShare30d == null
                ? "No active tenants yet"
                : `${d.engagement.engagedShare30d}% of active · ${d.engagement.logins30d.toLocaleString("en-IN")} logins · ${d.engagement.idleActive} idle`} />
            <KpiCard label="Churn — 30d" value={d.churn.cancelled30d} tone={d.churn.cancelled30d > 0 ? "red" : "default"} icon={CalendarX2}
              sub={d.churn.churnRate30d == null
                ? "Nothing operating to churn"
                : `${d.churn.churnRate30d}% of operating · ${d.churn.expired30d} expired · ${d.churn.reactivated30d} reactivated`} />
          </div>

          {/* ---- tab bar ---- */}
          <div className="-mx-1 overflow-x-auto scroll-thin px-1 pb-1" role="tablist" aria-label="Growth sections">
            <div className="flex min-w-max gap-1.5">
              {TABS.map((t) => (
                <button
                  key={t.key} role="tab" aria-selected={tab === t.key} type="button" onClick={() => setTab(t.key)}
                  className={cn("flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3.5 py-2 text-[12px] font-semibold transition-colors",
                    tab === t.key
                      ? "bg-gradient-to-r from-violet-600 to-fuchsia-600 text-white shadow-lg shadow-violet-950/40"
                      : "border border-white/10 light:border-slate-200 text-slate-400 light:text-slate-600 hover:bg-white/5 light:hover:bg-slate-100 hover:text-white light:hover:text-slate-900")}>
                  <t.icon className="h-3.5 w-3.5" /> {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* ---- GROWTH tab ---- */}
          {tab === "growth" && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                <SignupChart trend={d.growth.signupTrend} />
                <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-5">
                  <p className="mb-1 text-xs font-bold uppercase tracking-widest text-slate-500">Plan mix — MRR contribution</p>
                  <p className="mb-4 text-[11px] text-slate-600 light:text-slate-500">
                    Operating subscriptions (ACTIVE + TRIAL) per plan; each bar is the plan&apos;s share of MRR — yearly cycles normalized ÷12, trials excluded from revenue.
                  </p>
                  {d.revenue.planMix.length ? (
                    <div className="space-y-2.5">
                      {d.revenue.planMix.map((p) => (
                        <PlanRow key={p.planId} name={p.name} subscribers={p.subscribers} mrr={p.mrr} max={planMax} />
                      ))}
                    </div>
                  ) : <p className="text-xs text-slate-600 light:text-slate-500">No operating subscriptions yet — assign a plan to a tenant to see the mix.</p>}
                </div>
              </div>

              {/* registration funnel strip */}
              <div>
                <p className="mb-2 text-xs font-bold uppercase tracking-widest text-slate-500">Registration funnel — applications by outcome</p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
                  {REGISTRATION_META.map((r) => {
                    const value = r.key === "TRIALS" ? d.growth.trialsCurrent : (d.engagement.registrations[r.key] || 0)
                    const hot = r.key === "PENDING" && value > 0
                    return (
                      <div key={r.key} className={cn("rounded-2xl border p-4", r.tile)}>
                        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{r.label}</p>
                        <p className={cn("mt-1.5 text-xl font-bold tabular-nums", hot ? "text-amber-300 light:text-amber-700" : "text-white light:text-slate-900")}>
                          {value.toLocaleString("en-IN")}
                        </p>
                        {r.key === "TRIALS" && <p className="mt-0.5 text-[10px] text-slate-600 light:text-slate-500">live subscriptions in TRIAL</p>}
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* churn rail */}
              <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-widest text-slate-500">Churn &amp; revenue risk — trailing 30 days</p>
                    <p className="mt-1 text-[11px] text-slate-600 light:text-slate-500">
                      Lifecycle events from the append-only subscription history; the rate is cancellations ÷ (paying now + cancelled in window).
                    </p>
                  </div>
                  <Link href="/owner/lifecycle" className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-300 light:text-indigo-700 hover:text-indigo-200 light:hover:text-indigo-800">
                    Lifecycle Console <ArrowRight className="h-3 w-3" />
                  </Link>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {d.churn.events30d.length ? d.churn.events30d.map((e) => (
                    <span key={e.type}
                      className={cn("inline-flex items-center rounded-full border px-3 py-1 text-[11px] font-bold uppercase tracking-wider",
                        e.type === "CANCELLED" || e.type === "EXPIRED"
                          ? "border-red-400/40 bg-red-500/10 text-red-300 light:text-red-600"
                          : e.type === "REACTIVATED"
                            ? "border-emerald-400/40 bg-emerald-500/10 text-emerald-300 light:text-emerald-700"
                            : "border-slate-400/30 bg-slate-500/10 text-slate-400 light:text-slate-600")}>
                      {e.type.replace(/_/g, " ")} · {e.count}
                    </span>
                  )) : (
                    <span className="rounded-full border border-emerald-400/30 bg-emerald-500/10 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-emerald-300 light:text-emerald-700">
                      No lifecycle events in 30 days
                    </span>
                  )}
                  <span className="inline-flex items-center rounded-full border border-amber-400/40 bg-amber-500/10 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-amber-300 light:text-amber-700">
                    Past-due / grace · {d.revenue.pastDueSubs}
                  </span>
                  <span className="inline-flex items-center rounded-full border border-orange-400/40 bg-orange-500/10 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-orange-300 light:text-orange-700">
                    Failed payments · {d.revenue.failedPayments30d}
                  </span>
                </div>
                <p className="mt-3 text-[11px] text-slate-600 light:text-slate-500">
                  Overdue invoice chasing lives in <Link href="/owner/billing" className="font-semibold text-indigo-300 light:text-indigo-700 hover:text-indigo-200 light:hover:text-indigo-800">Revenue &amp; Collections → Collections</Link> — this page stays read-only.
                </p>
              </div>
            </div>
          )}

          {/* ---- USAGE tab ---- */}
          {tab === "usage" && (
            <div className="space-y-4">
              <p className="flex items-start gap-2 rounded-xl border border-blue-400/25 bg-blue-500/10 p-3 text-sm text-blue-200 light:text-blue-700">
                <Sparkles className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Tiles show <strong>live counts</strong> from the tenant tables; the delta chips compare the two most recent monthly
                  UsageSnapshot records{d.usage.previousPeriod ? ` (${d.usage.latestPeriod} vs ${d.usage.previousPeriod})` : ""} — the series the
                  nightly platform job captures, and what per-tenant billing reconciliation reads.
                </span>
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
                {usageTiles.map((t) => (
                  <div key={t.key} className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-4">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{t.label}</p>
                    <p className="mt-1.5 truncate text-xl font-bold tabular-nums text-white light:text-slate-900" title={t.fmt(d.usage.live[t.key])}>
                      {t.fmt(d.usage.live[t.key])}
                    </p>
                    <div className="mt-1.5">
                      <DeltaChip now={d.usage.latest ? d.usage.latest[t.key] : null} prev={d.usage.previous ? d.usage.previous[t.key] : null} label="MoM" />
                    </div>
                  </div>
                ))}
              </div>
              <UsageChart trend={d.usage.trend} />
              <p className="text-[11px] text-slate-600 light:text-slate-500">
                {d.usage.latestPeriod
                  ? `Latest metered period: ${d.usage.latestPeriod}${d.usage.previousPeriod ? ` · previous: ${d.usage.previousPeriod}` : ""}. The last daily write of a month is that month's frozen end-of-month record.`
                  : "No metering history yet — the nightly platform job creates the monthly series on its first run."}
              </p>
            </div>
          )}

          {/* ---- ENGAGEMENT tab ---- */}
          {tab === "engagement" && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
                <div className="xl:col-span-2"><LoginsChart weeks={d.engagement.loginsByWeek} /></div>
                <div className="space-y-3">
                  <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-5">
                    <p className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-500">Engagement lens</p>
                    <dl className="space-y-2 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <dt className="text-slate-500">Engaged active tenants</dt>
                        <dd className="font-bold tabular-nums text-white light:text-slate-900">
                          {d.engagement.engagedActive30d.toLocaleString("en-IN")}{d.engagement.engagedShare30d != null && <span className="ml-1 text-[10px] font-semibold text-slate-500">({d.engagement.engagedShare30d}%)</span>}
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <dt className="text-slate-500">Idle active tenants</dt>
                        <dd className={cn("font-bold tabular-nums", d.engagement.idleActive > 0 ? "text-amber-300 light:text-amber-700" : "text-white light:text-slate-900")}>
                          {d.engagement.idleActive.toLocaleString("en-IN")}
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <dt className="text-slate-500">Logins (30d)</dt>
                        <dd className="font-bold tabular-nums text-white light:text-slate-900">{d.engagement.logins30d.toLocaleString("en-IN")}</dd>
                      </div>
                    </dl>
                  </div>
                  <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-5">
                    <p className="mb-2 text-xs font-bold uppercase tracking-widest text-slate-500">Tier definitions</p>
                    <ul className="space-y-1.5">
                      {Object.entries(TIER_META).map(([key, meta]) => (
                        <li key={key} className="flex items-center gap-2 text-[11px]">
                          <span className={cn("inline-flex w-16 shrink-0 justify-center rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest", meta.chip)}>{meta.label}</span>
                          <span className="text-slate-500">{meta.hint}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>

              {/* matrix controls */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex flex-wrap gap-1.5">
                  {TIER_CHIPS.map((c) => (
                    <button key={c.key} type="button" onClick={() => { setTier(c.key); setPage(1) }}
                      className={cn("rounded-full border px-3 py-1 text-[11px] font-bold uppercase tracking-wider transition-colors",
                        tier === c.key
                          ? c.key === "DORMANT"
                            ? "border-red-400/50 bg-red-500/15 text-red-300 light:text-red-600"
                            : "border-violet-400/50 bg-violet-500/15 text-violet-300 light:text-violet-700"
                          : "border-white/10 light:border-slate-200 text-slate-500 light:text-slate-600 hover:bg-white/5 light:hover:bg-slate-100")}>
                      {c.label}
                    </button>
                  ))}
                </div>
                <form className="flex flex-1 items-center gap-2 sm:justify-end" onSubmit={(e) => { e.preventDefault(); setQuery(search.trim()); setPage(1) }}>
                  <div className="relative w-full max-w-xs">
                    <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                    <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Tenant name or code…" aria-label="Search tenants"
                      className="h-9 pl-9 text-xs border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100" />
                  </div>
                  <Button type="submit" size="sm" variant="outline" className="h-9 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100">Find</Button>
                </form>
              </div>

              {error && <ErrorBanner message={error} />}
              {loading ? <Loading /> : (
                <TableShell headers={["Tenant", "Plan", "Subscription", "Logins (30d)", "Last login", "Payroll seats", "Seats MoM", "Tier"]} empty={rows.length === 0}>
                  {rows.map((r) => {
                    const meta = TIER_META[r.tier] || TIER_META.DORMANT
                    return (
                      <tr key={r.id} className="transition-colors hover:bg-white/[0.03] light:hover:bg-slate-100/60">
                        <Td>
                          <Link href={`/owner/tenants/${r.id}`} className="flex flex-col">
                            <span className="text-xs font-semibold text-white light:text-slate-900 hover:text-indigo-300 light:hover:text-indigo-700">{r.name}</span>
                            <span className="font-mono text-[10px] text-slate-500">{r.code}</span>
                          </Link>
                        </Td>
                        <Td className="text-xs">{r.planName || <span className="text-slate-600 light:text-slate-500">— no plan</span>}</Td>
                        <Td>
                          {r.subStatus ? (
                            <span className={cn("inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest",
                              r.subStatus === "ACTIVE" || r.subStatus === "TRIAL"
                                ? "border-emerald-400/40 bg-emerald-500/10 text-emerald-300 light:text-emerald-700"
                                : "border-amber-400/40 bg-amber-500/10 text-amber-300 light:text-amber-700")}>
                              {r.subStatus.replace(/_/g, " ")}
                            </span>
                          ) : (
                            <span className="inline-flex items-center rounded-full border border-slate-400/40 bg-slate-500/10 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest text-slate-400 light:text-slate-600">
                              legacy
                            </span>
                          )}
                        </Td>
                        <Td className="text-xs font-semibold tabular-nums">{r.logins30d.toLocaleString("en-IN")}</Td>
                        <Td className="text-xs">
                          <span title={r.lastLoginAt ? new Date(r.lastLoginAt).toLocaleString() : "No successful tenant login on record"}>{fmtAgo(r.lastLoginAt, r.daysSinceLogin)}</span>
                        </Td>
                        <Td className="text-xs tabular-nums">
                          {r.seatsNow == null
                            ? <span className="text-slate-600 light:text-slate-500" title="No UsageSnapshot record for this tenant yet">—</span>
                            : <span title={`Metered ${r.seatsPeriod} (UsageSnapshot)`}>{r.seatsNow.toLocaleString("en-IN")}</span>}
                        </Td>
                        <Td>
                          <DeltaChip now={r.seatsNow} prev={r.seatsPrev} />
                        </Td>
                        <Td>
                          <span className={cn("inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest", meta.chip)} title={meta.hint}>
                            {meta.label}
                          </span>
                        </Td>
                      </tr>
                    )
                  })}
                </TableShell>
              )}
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>{total} tenant{total === 1 ? "" : "s"}</span>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}
                    className="h-8 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100"><ChevronLeft className="h-3.5 w-3.5" /></Button>
                  <span className="tabular-nums">Page {page} / {maxPage}</span>
                  <Button size="sm" variant="outline" disabled={page >= maxPage} onClick={() => setPage((p) => p + 1)}
                    className="h-8 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100"><ChevronRight className="h-3.5 w-3.5" /></Button>
                </div>
              </div>
              <p className="text-[11px] text-slate-600 light:text-slate-500">
                Tiers derive from successful tenant-plane logins (LoginAuditLog); seats are the metered payroll-scope employees from each
                tenant&apos;s latest monthly UsageSnapshot record — never re-derived from live tables. Dormant sorts first: the actionable end.
              </p>
            </div>
          )}
        </>
      ) : null}
    </div>
  )
}
