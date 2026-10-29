"use client"
// ============ /owner/security — Security & Trust console (Phase 5 P4) ========
// The security slice of the Owner Panel, on the P0/P1/P2/P3 console design
// system. Two tabs, both fed by fixed-set SQL aggregates:
//   - POSTURE  — KPIs from owner.security.overview: MFA adoption across the
//                platform team, lockouts, failed-login rates (24h/7d/30d,
//                both planes), the failure-reason mix, the offending-IP
//                workbench (>=3 failures in 30d, worst first), the
//                live-session census, audit activity and every retention
//                horizon vs its sweep policy.
//   - SESSIONS — owner.security.sessions: the live-session governance grid.
//                Pre-auth challenges (MFA_PENDING / ENROLL_PENDING — the
//                potentially-stuck attack surface) surface FIRST, then full
//                sessions by soonest expiry. Expiry bands are computed IN
//                SQL, so the band chips filter and the sort never
//                materialize the session table.
// Read-only console — no mutations. Session revocation is deliberately NOT
// invented here: it does not exist as an owner action, and this phase keeps
// every mutation untouched (the P2/P3 discipline).
import { useCallback, useEffect, useState } from "react"
import {
  ChevronLeft, ChevronRight, Clock, Fingerprint, KeyRound, ListX, Lock, MonitorSmartphone,
  RefreshCw, ScrollText, Search, ShieldAlert, ShieldCheck,
} from "lucide-react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useOwnerApi, ownerRpc } from "@/saas/owner/client"
import { ErrorBanner, KpiCard, Loading, PageHeader, TableShell, Td, fmtDateTime } from "@/saas/owner/ui"
import { OWNER_ROLE_LABELS } from "@/saas/owner/rbac-shared"
import { cn } from "@/lib/utils"

// ---- types -------------------------------------------------------------------
type Overview = {
  generatedAt: string
  team: {
    total: number; active: number; suspended: number
    mfaEnrolled: number; mfaAdoptionPct: number | null
    lockedNow: number; withFailures: number
  }
  logins: {
    attempts24h: number; failures24h: number; failureRate24h: number | null
    attempts7d: number; failures7d: number; failureRate7d: number | null
    attempts30d: number; failures30d: number; failureRate30d: number | null
    mfaLogins30d: number; mfaShare30d: number | null
    distinctIps30d: number
    planes: { plane: "TENANT" | "OWNER"; attempts: number; failures: number }[]
  }
  failureReasons: { reason: string; count: number }[]
  offendingIps: { ip: string; failures: number; successes: number; lastSeen: string }[]
  sessions: {
    live: number; full: number; pending: number
    expiring24h: number; distinctIps: number; owners: number
  }
  audit: {
    events24h: number; events7d: number; events30d: number
    notifications30d: number; actors30d: number
    topActions: { action: string; count: number }[]
    topEntities: { entity: string; count: number }[]
  }
  retention: {
    auditPolicyDays: number | null; auditOldestDays: number | null
    loginOwnerPolicyDays: number; loginOwnerOldestDays: number | null
    loginTenantPolicyDays: number; loginTenantOldestDays: number | null
  }
  trend: { weekStart: string; attempts: number; failures: number }[]
  policy: {
    ownerMfaRequired: boolean; sessionDays: number
    lockoutThreshold: number; lockoutMinutes: number; offenderMinFailures: number
  }
}

type SessionRow = {
  id: string; kind: string; createdAt: string; lastSeenAt: string; expiresAt: string
  ip: string | null; userAgent: string | null
  ownerName: string; ownerEmail: string; ownerRole: string
  ownerStatus: string; ownerMfa: boolean
  expiresInMinutes: number; idleMinutes: number; band: string
}

// ---- formatting + metadata -----------------------------------------------------
const REASON_LABELS: Record<string, string> = {
  INVALID_CREDENTIALS: "Invalid credentials",
  LOCKED_OUT: "Account locked out",
  MFA_REQUIRED_FAILED: "MFA challenge failed",
  MFA_FAILED: "MFA challenge failed",
  INACTIVE_VENDOR: "Vendor inactive",
  RATE_LIMITED: "Rate limited",
  AMBIGUOUS_EMAIL: "Ambiguous email",
  ERROR: "Server error",
  UNKNOWN: "Unrecorded reason",
}

const weekLabel = (w: string) =>
  new Date(`${w}T00:00:00Z`).toLocaleString("en", { month: "short", day: "numeric", timeZone: "UTC" })

/** compact freshness: "just now" / "12m" / "3h" / "4d" */
const fmtIdle = (minutes: number): string => {
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m`
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`
  return `${Math.floor(minutes / (60 * 24))}d`
}

const fmtCountdown = (minutes: number): string => {
  if (minutes < 60) return `${minutes}m`
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`
  return `${Math.floor(minutes / (60 * 24))}d`
}

/** light display-only UA hint (sessions store the raw agent, unlike the
 *  login audit's parse-time labels) */
const uaHint = (ua: string | null): string => {
  if (!ua) return "—"
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome"
    : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : /curl/i.test(ua) ? "curl" : "Unknown"
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS"
    : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "—"
  return `${browser} · ${os}`
}

const KIND_META: Record<string, { label: string; chip: string }> = {
  FULL: { label: "Full session", chip: "border-emerald-400/40 bg-emerald-500/10 text-emerald-300 light:text-emerald-700" },
  MFA_PENDING: { label: "MFA pending", chip: "border-amber-400/40 bg-amber-500/10 text-amber-300 light:text-amber-700" },
  ENROLL_PENDING: { label: "Enroll pending", chip: "border-violet-400/40 bg-violet-500/10 text-violet-300 light:text-violet-700" },
}

const BAND_META: Record<string, { label: string; chip: string }> = {
  EXPIRING_1H: { label: "< 1 hour", chip: "border-red-400/40 bg-red-500/10 text-red-300 light:text-red-600" },
  EXPIRING_24H: { label: "< 24 hours", chip: "border-amber-400/40 bg-amber-500/10 text-amber-300 light:text-amber-700" },
  LATER: { label: "later", chip: "border-slate-400/30 bg-slate-500/10 text-slate-400 light:text-slate-600" },
}

const KIND_CHIPS = [
  { key: "ALL", label: "All live" },
  { key: "FULL", label: "Full sessions" },
  { key: "PENDING", label: "Pre-auth challenges" },
] as const
type KindChip = (typeof KIND_CHIPS)[number]["key"]

const BAND_CHIPS = [
  { key: "ALL", label: "Any expiry" },
  { key: "EXPIRING_1H", label: "< 1 hour" },
  { key: "EXPIRING_24H", label: "< 24 hours" },
  { key: "LATER", label: "Later" },
] as const
type BandChip = (typeof BAND_CHIPS)[number]["key"]

/** Signed failure-rate delta chip between the 7d and 30d rates. */
function RateChip({ rate7d, rate30d }: { rate7d: number | null; rate30d: number | null }) {
  if (rate7d == null || rate30d == null || rate30d === 0) return null
  const d = Math.round((rate7d - rate30d) * 10) / 10
  if (d === 0) return <span className="text-[10px] font-semibold text-slate-600 light:text-slate-500">steady vs 30d</span>
  const up = d > 0
  return (
    <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-bold tabular-nums",
      up
        ? "border-red-400/40 bg-red-500/10 text-red-300 light:text-red-600"
        : "border-emerald-400/40 bg-emerald-500/10 text-emerald-300 light:text-emerald-700")}>
      {up ? "▲" : "▼"} {Math.abs(d).toFixed(1)}% vs 30d
    </span>
  )
}

/** 6-week attempts-vs-failures — grouped CSS bars (the P3 chart language). */
function SecurityChart({ trend }: { trend: Overview["trend"] }) {
  const max = Math.max(1, ...trend.map((t) => t.attempts))
  return (
    <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-5">
      <div className="mb-1 flex items-center justify-between">
        <p className="text-xs font-bold uppercase tracking-widest text-slate-500">Login attempts — last 6 weeks</p>
        <div className="flex items-center gap-3 text-[10px] font-semibold text-slate-500">
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-slate-400" /> Succeeded</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-rose-400" /> Failed</span>
        </div>
      </div>
      <p className="mb-4 text-[11px] text-slate-600 light:text-slate-500">
        Every authentication attempt on both planes per calendar week (Monday start, UTC) — failures tinted rose.
      </p>
      <div className="flex h-40 items-end gap-2 sm:gap-4">
        {trend.map((t) => {
          const failPct = Math.max(t.failures > 0 ? 4 : 0, (t.failures / max) * 100)
          const okPct = Math.max(t.attempts - t.failures > 0 ? 4 : 0, ((t.attempts - t.failures) / max) * 100)
          return (
            <div key={t.weekStart} className="flex h-full flex-1 flex-col items-center justify-end gap-1.5">
              <div className="flex h-full w-full items-end justify-center gap-1" aria-hidden>
                <div
                  className="w-full max-w-[22px] rounded-t-md bg-gradient-to-t from-slate-600/70 to-slate-400 transition-all"
                  style={{ height: `${okPct}%` }}
                  title={`${weekLabel(t.weekStart)}: ${(t.attempts - t.failures).toLocaleString("en-IN")} succeeded`}
                />
                <div
                  className="w-full max-w-[22px] rounded-t-md bg-gradient-to-t from-rose-600/80 to-rose-400 transition-all"
                  style={{ height: `${failPct}%` }}
                  title={`${weekLabel(t.weekStart)}: ${t.failures.toLocaleString("en-IN")} failed`}
                />
              </div>
              <span className="text-[10px] font-semibold tabular-nums text-slate-500">{weekLabel(t.weekStart)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** One failure-reason bar row (the P3 PlanRow language). */
function ReasonRow({ reason, count, max }: { reason: string; count: number; max: number }) {
  const pct = max > 0 ? Math.max(2, Math.round((count / max) * 100)) : 0
  return (
    <div className="flex items-center gap-3">
      <span className="w-36 shrink-0 truncate text-xs font-semibold text-slate-300 light:text-slate-700" title={reason}>
        {REASON_LABELS[reason] || reason.replace(/_/g, " ")}
      </span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10 light:bg-slate-200">
        <div className="h-full rounded-full bg-gradient-to-r from-rose-500 to-red-400" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-14 shrink-0 text-right text-xs tabular-nums text-slate-400 light:text-slate-600">
        {count.toLocaleString("en-IN")}
      </span>
    </div>
  )
}

// ===== RENDER =====
type Tab = "posture" | "sessions"
const TABS: { key: Tab; label: string; icon: any }[] = [
  { key: "posture", label: "Posture", icon: ShieldCheck },
  { key: "sessions", label: "Sessions", icon: MonitorSmartphone },
]

export default function SecurityConsolePage() {
  const overview = useOwnerApi<Overview>("owner.security.overview")
  const [tab, setTab] = useState<Tab>("posture")

  // ---- sessions tab -----------------------------------------------------------
  const [page, setPage] = useState(1)
  const [kind, setKind] = useState<KindChip>("ALL")
  const [band, setBand] = useState<BandChip>("ALL")
  const [search, setSearch] = useState("")
  const [query, setQuery] = useState("")
  const [rows, setRows] = useState<SessionRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pageSize] = useState(15)

  const loadSessions = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const r = await ownerRpc<{ total: number; rows: SessionRow[] }>("owner.security.sessions", {
        page, pageSize, kind, band, search: query || undefined,
      })
      setRows(r.rows); setTotal(r.total)
    } catch (e: any) { setError(e?.message || "Failed to load the session grid") } finally { setLoading(false) }
  }, [page, pageSize, kind, band, query])
  useEffect(() => { loadSessions().catch(() => {}) }, [loadSessions])

  // ---- 60 s auto-refresh: the overview + the grid when its tab is open -------
  useEffect(() => {
    const t = setInterval(() => {
      overview.reload().catch(() => {})
      if (tab === "sessions") loadSessions().catch(() => {})
    }, 60_000)
    return () => clearInterval(t)
  }, [tab, overview.reload, loadSessions])

  const d = overview.data
  const maxPage = Math.max(1, Math.ceil(total / pageSize))
  const reasonMax = Math.max(1, ...(d?.failureReasons || []).map((r) => r.count))

  return (
    <div className="space-y-5">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-rose-500 to-red-600 shadow-lg shadow-rose-950/50">
              <ShieldAlert className="h-4 w-4 text-white" />
            </span>
            Security &amp; Trust
          </span>
        }
        sub="The platform security posture — owner-team MFA adoption and lockouts, failed-login rates across both planes, the offending-IP workbench, live session governance and every retention horizon. Computed live from the audit-grade logs."
        actions={
          <div className="flex items-center gap-2">
            {d && <span className="hidden text-xs text-slate-500 sm:inline">generated {new Date(d.generatedAt).toLocaleTimeString()}</span>}
            <Button variant="outline" size="sm" disabled={overview.loading}
              onClick={() => { overview.reload().catch(() => {}); if (tab === "sessions") loadSessions().catch(() => {}) }}>
              <RefreshCw className={cn("h-3.5 w-3.5", overview.loading && "animate-spin")} /> Refresh
            </Button>
          </div>
        }
      />

      {overview.error && <ErrorBanner message={overview.error} />}
      {overview.loading && !d ? <Loading label="Computing security posture…" /> : d ? (
        <>
          {/* ---- headline KPIs ---- */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="MFA adoption" value={
              d.team.mfaAdoptionPct == null ? "—" : `${d.team.mfaAdoptionPct}%`
            } tone={d.team.mfaAdoptionPct == null ? "default" : d.team.mfaAdoptionPct >= 100 ? "emerald" : "amber"} icon={Fingerprint}
              sub={d.team.total > 0
                ? `${d.team.mfaEnrolled} of ${d.team.total} owner users enrolled · policy ${d.policy.ownerMfaRequired ? "REQUIRES MFA" : "optional"}`
                : "No owner users yet"} />
            <KpiCard label="Failed logins — 24h" value={d.logins.failures24h.toLocaleString("en-IN")}
              tone={d.logins.failures24h > 0 ? "red" : "emerald"} icon={KeyRound}
              sub={d.logins.failureRate24h == null
                ? "No login attempts in 24 hours"
                : `${d.logins.failureRate24h}% of ${d.logins.attempts24h.toLocaleString("en-IN")} attempts · ${d.logins.failures7d.toLocaleString("en-IN")} failed in 7d`} />
            <KpiCard label="Live owner sessions" value={d.sessions.live.toLocaleString("en-IN")} tone="indigo" icon={MonitorSmartphone}
              sub={`${d.sessions.full} full · ${d.sessions.pending} pre-auth · ${d.sessions.expiring24h} expiring < 24h`} />
            <KpiCard label="Audit events — 30d" value={d.audit.events30d.toLocaleString("en-IN")} icon={ScrollText}
              sub={`${d.audit.actors30d} actor${d.audit.actors30d === 1 ? "" : "s"} · ${d.audit.events24h.toLocaleString("en-IN")} in 24h · ${d.audit.notifications30d.toLocaleString("en-IN")} notifications`} />
          </div>

          {/* ---- alerts rail ---- */}
          {(d.team.lockedNow > 0 || d.sessions.pending > 0 || d.team.suspended > 0) ? (
            <div className="flex flex-wrap items-center gap-2">
              {d.team.lockedNow > 0 && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-red-400/40 bg-red-500/10 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-red-300 light:text-red-600">
                  <Lock className="h-3 w-3" /> {d.team.lockedNow} owner account{d.team.lockedNow === 1 ? "" : "s"} locked
                </span>
              )}
              {d.sessions.pending > 0 && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/40 bg-amber-500/10 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-amber-300 light:text-amber-700">
                  <Clock className="h-3 w-3" /> {d.sessions.pending} pre-auth challenge{d.sessions.pending === 1 ? "" : "s"} live
                </span>
              )}
              {d.team.suspended > 0 && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-400/40 bg-slate-500/10 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-slate-300 light:text-slate-600">
                  <ListX className="h-3 w-3" /> {d.team.suspended} owner account{d.team.suspended === 1 ? "" : "s"} suspended
                </span>
              )}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-emerald-300 light:text-emerald-700">
                <ShieldCheck className="h-3 w-3" /> No lockouts · no stuck challenges · nobody suspended
              </span>
            </div>
          )}

          {/* ---- tab bar ---- */}
          <div className="-mx-1 overflow-x-auto scroll-thin px-1 pb-1" role="tablist" aria-label="Security sections">
            <div className="flex min-w-max gap-1.5">
              {TABS.map((t) => (
                <button
                  key={t.key} role="tab" aria-selected={tab === t.key} type="button" onClick={() => setTab(t.key)}
                  className={cn("flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3.5 py-2 text-[12px] font-semibold transition-colors",
                    tab === t.key
                      ? "bg-gradient-to-r from-rose-600 to-red-600 text-white shadow-lg shadow-rose-950/40"
                      : "border border-white/10 light:border-slate-200 text-slate-400 light:text-slate-600 hover:bg-white/5 light:hover:bg-slate-100 hover:text-white light:hover:text-slate-900")}>
                  <t.icon className="h-3.5 w-3.5" /> {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* ---- POSTURE tab ---- */}
          {tab === "posture" && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                <SecurityChart trend={d.trend} />
                {/* failure-reason mix */}
                <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-5">
                  <p className="mb-1 text-xs font-bold uppercase tracking-widest text-slate-500">Why logins fail — trailing 30 days</p>
                  <p className="mb-4 text-[11px] text-slate-600 light:text-slate-500">
                    Failed attempts by recorded reason, both planes, computed in SQL. Empty when 30 days pass without a failure.
                  </p>
                  {d.failureReasons.length ? (
                    <div className="space-y-2.5">
                      {d.failureReasons.map((r) => (
                        <ReasonRow key={r.reason} reason={r.reason} count={r.count} max={reasonMax} />
                      ))}
                    </div>
                  ) : <p className="text-xs text-emerald-300 light:text-emerald-700">No failed login attempts in 30 days.</p>}
                  <div className="mt-4 flex items-center gap-2 border-t border-white/10 light:border-slate-200 pt-3">
                    <RateChip rate7d={d.logins.failureRate7d} rate30d={d.logins.failureRate30d} />
                    {d.logins.failureRate30d != null && (
                      <span className="text-[10px] font-semibold text-slate-600 light:text-slate-500">
                        30d rate {d.logins.failureRate30d}% · MFA-verified {d.logins.mfaShare30d == null ? "—" : `${d.logins.mfaShare30d}%`} of successes
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* offending-IP workbench + login lens */}
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
                <div className="xl:col-span-2 rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-5">
                  <div className="mb-1 flex items-center justify-between">
                    <p className="text-xs font-bold uppercase tracking-widest text-slate-500">Offending IPs — trailing 30 days</p>
                    <span className="text-[10px] font-semibold text-slate-500">≥ {d.policy.offenderMinFailures} failures · worst first</span>
                  </div>
                  <p className="mb-4 text-[11px] text-slate-600 light:text-slate-500">
                    Brute-force / credential-stuffing signals: IPs with repeated failed attempts. Successes ride each row so a busy shared NAT is visibly different from a pure attacker.
                  </p>
                  {d.offendingIps.length ? (
                    <TableShell headers={["IP address", "Failed", "Succeeded", "Last seen", "Signal"]} empty={false}>
                      {d.offendingIps.map((o) => (
                        <tr key={o.ip} className="transition-colors hover:bg-white/[0.03] light:hover:bg-slate-100/60">
                          <Td className="font-mono text-xs font-semibold text-white light:text-slate-900">{o.ip}</Td>
                          <Td className="text-xs font-bold tabular-nums text-red-300 light:text-red-600">{o.failures.toLocaleString("en-IN")}</Td>
                          <Td className="text-xs tabular-nums text-slate-400 light:text-slate-600">{o.successes.toLocaleString("en-IN")}</Td>
                          <Td className="text-xs">{fmtDateTime(o.lastSeen)}</Td>
                          <Td>
                            <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                              o.successes === 0
                                ? "border-red-400/40 bg-red-500/10 text-red-300 light:text-red-600"
                                : "border-amber-400/40 bg-amber-500/10 text-amber-300 light:text-amber-700")}>
                              {o.successes === 0 ? "pure attacker" : "mixed traffic"}
                            </span>
                          </Td>
                        </tr>
                      ))}
                    </TableShell>
                  ) : (
                    <p className="text-xs text-emerald-300 light:text-emerald-700">
                      No IP has {d.policy.offenderMinFailures}+ failed attempts in 30 days — no brute-force signals.
                    </p>
                  )}
                </div>

                {/* login lens */}
                <div className="space-y-3">
                  <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-5">
                    <p className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-500">Login lens — 30 days</p>
                    <dl className="space-y-2 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <dt className="text-slate-500">Attempts (both planes)</dt>
                        <dd className="font-bold tabular-nums text-white light:text-slate-900">{d.logins.attempts30d.toLocaleString("en-IN")}</dd>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <dt className="text-slate-500">Failed</dt>
                        <dd className="font-bold tabular-nums text-red-300 light:text-red-600">{d.logins.failures30d.toLocaleString("en-IN")}</dd>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <dt className="text-slate-500">Failure rate</dt>
                        <dd className="font-bold tabular-nums text-white light:text-slate-900">{d.logins.failureRate30d == null ? "—" : `${d.logins.failureRate30d}%`}</dd>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <dt className="text-slate-500">Distinct IPs</dt>
                        <dd className="font-bold tabular-nums text-white light:text-slate-900">{d.logins.distinctIps30d.toLocaleString("en-IN")}</dd>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <dt className="text-slate-500">MFA-verified successes</dt>
                        <dd className="font-bold tabular-nums text-white light:text-slate-900">{d.logins.mfaLogins30d.toLocaleString("en-IN")}</dd>
                      </div>
                    </dl>
                    <div className="mt-4 grid grid-cols-2 gap-2">
                      {d.logins.planes.map((p) => (
                        <div key={p.plane} className="rounded-xl border border-white/10 light:border-slate-200 bg-white/[0.02] light:bg-white/70 p-3">
                          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{p.plane === "TENANT" ? "Tenant plane" : "Owner plane"}</p>
                          <p className="mt-1 text-lg font-bold tabular-nums text-white light:text-slate-900">{p.attempts.toLocaleString("en-IN")}</p>
                          <p className="text-[10px] font-semibold text-slate-500">{p.failures.toLocaleString("en-IN")} failed</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* retention + policy cards */}
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-5">
                  <p className="mb-1 text-xs font-bold uppercase tracking-widest text-slate-500">Retention horizons</p>
                  <p className="mb-4 text-[11px] text-slate-600 light:text-slate-500">
                    Oldest retained row vs its sweep policy — the nightly platform pass purges beyond each window.
                  </p>
                  <dl className="space-y-2.5 text-xs">
                    {[
                      { label: "Platform audit trail", policy: d.retention.auditPolicyDays, oldest: d.retention.auditOldestDays },
                      { label: "Login audit — owner plane", policy: d.retention.loginOwnerPolicyDays, oldest: d.retention.loginOwnerOldestDays },
                      { label: "Login audit — tenant plane", policy: d.retention.loginTenantPolicyDays, oldest: d.retention.loginTenantOldestDays },
                    ].map((r) => (
                      <div key={r.label} className="flex items-center justify-between gap-2 border-b border-white/5 light:border-slate-200/60 pb-2 last:border-0 last:pb-0">
                        <dt className="text-slate-500">{r.label}</dt>
                        <dd className="flex items-center gap-2">
                          <span className="font-bold tabular-nums text-white light:text-slate-900">
                            {r.oldest == null ? "empty" : `${r.oldest.toLocaleString("en-IN")} d old`}
                          </span>
                          <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-semibold",
                            r.policy == null
                              ? "border-amber-400/40 bg-amber-500/10 text-amber-300 light:text-amber-700"
                              : r.oldest != null && r.oldest > r.policy
                                ? "border-red-400/40 bg-red-500/10 text-red-300 light:text-red-600"
                                : "border-emerald-400/30 bg-emerald-500/10 text-emerald-300 light:text-emerald-700")}>
                            {r.policy == null ? "sweep disabled" : `${r.policy} d policy`}
                          </span>
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <p className="mt-3 text-[10px] text-slate-600 light:text-slate-500">
                    Tenant-plane login retention is per-tenant configurable (default {d.retention.loginTenantPolicyDays} days) — the policy shown is that default.
                  </p>
                </div>

                <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-5">
                  <p className="mb-1 text-xs font-bold uppercase tracking-widest text-slate-500">Active policies</p>
                  <p className="mb-4 text-[11px] text-slate-600 light:text-slate-500">
                    The enforcement knobs from Platform Settings → Security, as the login flow reads them right now.
                  </p>
                  <dl className="space-y-2.5 text-xs">
                    <div className="flex items-center justify-between gap-2 border-b border-white/5 light:border-slate-200/60 pb-2">
                      <dt className="text-slate-500">Owner MFA</dt>
                      <dd className={cn("rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                        d.policy.ownerMfaRequired
                          ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-300 light:text-emerald-700"
                          : "border-amber-400/40 bg-amber-500/10 text-amber-300 light:text-amber-700")}>
                        {d.policy.ownerMfaRequired ? "required" : "optional"}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-2 border-b border-white/5 light:border-slate-200/60 pb-2">
                      <dt className="text-slate-500">Lockout</dt>
                      <dd className="font-bold tabular-nums text-white light:text-slate-900">
                        {d.policy.lockoutThreshold} failed → {d.policy.lockoutMinutes} min
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-2 border-b border-white/5 light:border-slate-200/60 pb-2">
                      <dt className="text-slate-500">Owner session lifetime</dt>
                      <dd className="font-bold tabular-nums text-white light:text-slate-900">{d.policy.sessionDays} day{d.policy.sessionDays === 1 ? "" : "s"}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-slate-500">Offender signal floor</dt>
                      <dd className="font-bold tabular-nums text-white light:text-slate-900">≥ {d.policy.offenderMinFailures} failures / 30d</dd>
                    </div>
                  </dl>
                  <p className="mt-3 text-[10px] text-slate-600 light:text-slate-500">
                    Team management lives in <Link href="/owner/users" className="font-semibold text-indigo-300 light:text-indigo-700 hover:text-indigo-200 light:hover:text-indigo-800">Owner Users</Link>; the forensic trail in <Link href="/owner/audit" className="font-semibold text-indigo-300 light:text-indigo-700 hover:text-indigo-200 light:hover:text-indigo-800">Platform Audit</Link>.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* ---- SESSIONS tab ---- */}
          {tab === "sessions" && (
            <div className="space-y-4">
              <p className="flex items-start gap-2 rounded-xl border border-blue-400/25 bg-blue-500/10 p-3 text-sm text-blue-200 light:text-blue-700">
                <MonitorSmartphone className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Live owner-console sessions only (expired rows never appear). <strong>Pre-auth challenges</strong> — MFA / enrollment
                  windows issued mid-login — sort first: they are short-lived by design, and a pile of stale ones is a
                  credential-stuffing footprint. Owner identities join each row; the per-session CSRF token never leaves the server.
                </span>
              </p>

              {/* filter rail */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                  <Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1) }}
                    onKeyDown={(e) => { if (e.key === "Enter") { setQuery(search); setPage(1) } }}
                    placeholder="Search owner name or email…" className="h-9 w-64 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 pl-8 text-xs" />
                </div>
                <div className="flex gap-1">
                  {KIND_CHIPS.map((c) => (
                    <button key={c.key} type="button" onClick={() => { setKind(c.key); setPage(1) }}
                      className={cn("rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors",
                        kind === c.key
                          ? "border-rose-400/50 bg-rose-500/15 text-rose-200 light:text-rose-700"
                          : "border-white/10 light:border-slate-200 text-slate-500 light:text-slate-600 hover:text-white light:hover:text-slate-900")}>
                      {c.label}
                    </button>
                  ))}
                </div>
                <div className="flex gap-1">
                  {BAND_CHIPS.map((c) => (
                    <button key={c.key} type="button" onClick={() => { setBand(c.key); setPage(1) }}
                      className={cn("rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors",
                        band === c.key
                          ? "border-rose-400/50 bg-rose-500/15 text-rose-200 light:text-rose-700"
                          : "border-white/10 light:border-slate-200 text-slate-500 light:text-slate-600 hover:text-white light:hover:text-slate-900")}>
                      {c.label}
                    </button>
                  ))}
                </div>
                {query && (
                  <button type="button" onClick={() => { setQuery(""); setSearch("") }}
                    className="text-[11px] font-semibold text-slate-500 underline-offset-2 hover:text-white light:hover:text-slate-900 hover:underline">
                    clear “{query}”
                  </button>
                )}
                <span className="ml-auto text-xs text-slate-500">{total.toLocaleString("en-IN")} live session{total === 1 ? "" : "s"}</span>
              </div>

              {error && <ErrorBanner message={error} />}
              {loading ? <Loading /> : (
                <TableShell headers={["Owner", "Role", "Kind", "Created", "Last seen", "Expires in", "IP", "Device"]} empty={rows.length === 0}>
                  {rows.map((s) => {
                    const kindMeta = KIND_META[s.kind] || { label: s.kind, chip: "border-slate-400/30 bg-slate-500/10 text-slate-400" }
                    const bandMeta = BAND_META[s.band] || BAND_META.LATER
                    return (
                      <tr key={s.id} className="transition-colors hover:bg-white/[0.03] light:hover:bg-slate-100/60">
                        <Td>
                          <p className="text-xs font-semibold text-white light:text-slate-900">{s.ownerName}</p>
                          <p className="text-[11px] text-slate-500">{s.ownerEmail}</p>
                          <div className="mt-1 flex items-center gap-1">
                            {s.ownerStatus !== "ACTIVE" && (
                              <span className="rounded-full border border-red-400/40 bg-red-500/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-red-300 light:text-red-600">suspended</span>
                            )}
                            {s.ownerMfa ? (
                              <span className="rounded-full border border-emerald-400/30 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-emerald-300 light:text-emerald-700">mfa</span>
                            ) : (
                              <span className="rounded-full border border-amber-400/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-amber-300 light:text-amber-700">no mfa</span>
                            )}
                          </div>
                        </Td>
                        <Td className="text-xs">{OWNER_ROLE_LABELS[s.ownerRole as keyof typeof OWNER_ROLE_LABELS] || s.ownerRole}</Td>
                        <Td>
                          <span className={cn("inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider", kindMeta.chip)}>
                            {kindMeta.label}
                          </span>
                        </Td>
                        <Td className="text-xs">{fmtDateTime(s.createdAt)}</Td>
                        <Td className="text-xs">
                          <span className="tabular-nums" title={fmtDateTime(s.lastSeenAt)}>{fmtIdle(s.idleMinutes)}</span>
                        </Td>
                        <Td>
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-bold tabular-nums text-white light:text-slate-900">{fmtCountdown(s.expiresInMinutes)}</span>
                            <span className={cn("rounded-full border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider", bandMeta.chip)}>{bandMeta.label}</span>
                          </div>
                        </Td>
                        <Td className="font-mono text-xs text-slate-400 light:text-slate-600">{s.ip || "—"}</Td>
                        <Td className="text-xs text-slate-400 light:text-slate-600">{uaHint(s.userAgent)}</Td>
                      </tr>
                    )
                  })}
                </TableShell>
              )}

              {total > pageSize && (
                <div className="flex items-center justify-center gap-3">
                  <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}
                    className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-white light:text-slate-900">
                    <ChevronLeft className="h-3.5 w-3.5" /> Previous
                  </Button>
                  <span className="text-xs text-slate-500">page {page} / {maxPage}</span>
                  <Button variant="outline" size="sm" disabled={page >= maxPage} onClick={() => setPage((p) => p + 1)}
                    className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-white light:text-slate-900">
                    Next <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )}
            </div>
          )}
        </>
      ) : null}
    </div>
  )
}
