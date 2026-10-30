"use client"
// ============ /owner/fleet — Fleet Health console (Phase 5 P0, Scope 5) ========
// Per-tenant operational health: KPI hero, backup compliance strip, and the
// fleet grid where every tenant carries a SQL-computed health tier
// (HEALTHY / WATCH / AT_RISK / DORMANT — single source: owner.fleet.tenants).
// All data comes from owner.fleet.overview / owner.fleet.tenants — no
// fabricated numbers. Auto-refreshes every 60 s; deep-links into the tenant
// detail page for drill-down.
import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import {
  Archive, ChevronLeft, ChevronRight, Cpu, HardDrive, HeartPulse, Loader2, Radar,
  RefreshCw, Search, ShieldCheck, Timer, Users,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useOwnerApi, ownerRpc } from "@/saas/owner/client"
import { ErrorBanner, KpiCard, Loading, PageHeader, StatusChip, TableShell, Td, fmtDateTime } from "@/saas/owner/ui"

type Overview = {
  generatedAt: string
  tenants: { total: number; active: number; inactive: number; dormant: number; activeLast30d: number }
  workforce: { activeEmployees: number; activeUsers: number }
  devices: { online: number; enabled: number }
  storageBytes: number
  renewalsNext30d: number
  failedLogins24h: number
  subscriptionsByStatus: { status: string; count: number }[]
  backup: {
    lastBackup: { status: string; startedAt: string; finishedAt: string | null; checksum: string | null; sizeBytes: number | null; error: string | null } | null
    lastDrill: { status: string; startedAt: string; finishedAt: string | null; pass: boolean | null } | null
    encryptionEnabled: boolean
    scheduleEnabled: boolean
    retention: number
  }
}

type FleetRow = {
  id: string; name: string; code: string; active: boolean; createdAt: string
  admin: { name: string; email: string } | null
  planName: string; subscriptionStatus: string; endDate: string | null
  tier: string; lastLoginAt: string | null
  activeEmployees: number; activeUsers: number
  devicesEnabled: number; devicesOnline: number; storageBytes: number
}

type FleetPage = { total: number; page: number; pageSize: number; rows: FleetRow[] }

const TIERS = ["ALL", "AT_RISK", "WATCH", "DORMANT", "HEALTHY"] as const
type Tier = (typeof TIERS)[number]

const TIER_STYLE: Record<string, { chip: string; dot: string; label: string }> = {
  HEALTHY: { chip: "border-emerald-400/40 bg-emerald-500/10 text-emerald-300 light:text-emerald-700", dot: "bg-emerald-400", label: "Healthy" },
  WATCH: { chip: "border-amber-400/40 bg-amber-500/10 text-amber-300 light:text-amber-700", dot: "bg-amber-400", label: "Watch" },
  AT_RISK: { chip: "border-rose-400/40 bg-rose-500/10 text-rose-300 light:text-rose-600", dot: "bg-rose-400", label: "At Risk" },
  DORMANT: { chip: "border-slate-400/40 bg-slate-500/10 light:bg-slate-200 text-slate-400 light:text-slate-600", dot: "bg-slate-400", label: "Dormant" },
}

function timeAgo(iso: string | null): string {
  if (!iso) return "never"
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return `${Math.floor(d / 30)}mo ago`
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

function daysUntil(iso: string | null): number | null {
  if (!iso) return null
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000)
}

/** Age in whole hours (module-level — react-hooks/purity forbids Date.now()
 * inside component bodies; same convention as timeAgo above). */
function ageHours(iso: string | null): number | null {
  if (!iso) return null
  return Math.floor((Date.now() - new Date(iso).getTime()) / 3600000)
}

export default function OwnerFleetPage() {
  const overview = useOwnerApi<Overview>("owner.fleet.overview")
  const [page, setPage] = useState(1)
  const [tier, setTier] = useState<Tier>("ALL")
  const [status, setStatus] = useState<"ALL" | "ACTIVE" | "INACTIVE">("ALL")
  const [search, setSearch] = useState("")
  const [query, setQuery] = useState("")
  const [rows, setRows] = useState<FleetRow[]>([])
  const [total, setTotal] = useState(0)
  const [pageSize] = useState(20)
  const [gridLoading, setGridLoading] = useState(true)
  const [gridError, setGridError] = useState<string | null>(null)

  // auto-refresh the KPI overview every 60 s (interval cleaned up on unmount)
  useEffect(() => {
    const t = setInterval(() => { overview.reload().catch(() => {}) }, 60_000)
    return () => clearInterval(t)
  }, [overview.reload])

  const loadGrid = useCallback(async () => {
    setGridLoading(true)
    setGridError(null)
    try {
      const d = await ownerRpc<FleetPage>("owner.fleet.tenants", { page, pageSize, tier, status, search: query || undefined })
      setRows(d.rows)
      setTotal(d.total)
    } catch (e: unknown) {
      setGridError((e as Error)?.message || "Failed to load the fleet grid")
    } finally {
      setGridLoading(false)
    }
  }, [page, pageSize, tier, status, query])

  useEffect(() => { loadGrid().catch(() => {}) }, [loadGrid])

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const o = overview.data

  return (
    <div className="space-y-5">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-blue-600 to-violet-600 shadow-lg shadow-indigo-950/50">
              <Radar className="h-4 w-4 text-white" />
            </span>
            Fleet Health
          </span>
        }
        sub="Operational health of every tenant workspace — one set-based snapshot, no per-tenant queries. At Risk: expired / ending ≤ 3d / empty workforce. Watch: grace or ending ≤ 14d. Dormant: no login in 30 days."
        actions={
          <Button variant="outline" size="sm" onClick={() => { overview.reload().catch(() => {}); loadGrid().catch(() => {}) }}
            disabled={overview.loading || gridLoading}
            className="h-9 border-white/10 light:border-slate-300 bg-white/5 light:bg-white text-white light:text-slate-900">
            {overview.loading || gridLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Refresh
          </Button>
        }
      />

      {overview.error && <ErrorBanner message={overview.error} />}

      {/* ---- KPI hero ---- */}
      {overview.loading && !o ? (
        <Loading label="Surveying the fleet…" />
      ) : o ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Tenants" value={o.tenants.total.toLocaleString()} icon={Users}
              sub={`${o.tenants.active.toLocaleString()} active · ${o.tenants.inactive.toLocaleString()} inactive`} />
            <KpiCard label="Dormant 30d+" value={o.tenants.dormant.toLocaleString()} icon={Radar} tone="amber"
              sub={`${o.tenants.activeLast30d.toLocaleString()} logged in within 30 days`} />
            <KpiCard label="Workforce" value={o.workforce.activeEmployees.toLocaleString()} icon={Users} tone="indigo"
              sub={`${o.workforce.activeUsers.toLocaleString()} active app users`} />
            <KpiCard label="Failed logins 24h" value={o.failedLogins24h.toLocaleString()} icon={ShieldCheck}
              tone={o.failedLogins24h > 50 ? "red" : "default"} sub="both planes, all tenants" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Devices online" value={`${o.devices.online.toLocaleString()} / ${o.devices.enabled.toLocaleString()}`} icon={Cpu}
              tone={o.devices.enabled > 0 && o.devices.online === 0 ? "red" : "default"} sub="enabled devices across the fleet" />
            <KpiCard label="Platform storage" value={fmtBytes(o.storageBytes)} icon={HardDrive} sub="documents + media, all tenants" />
            <KpiCard label="Renewals ≤ 30 days" value={o.renewalsNext30d.toLocaleString()} icon={Timer} tone="amber" sub="operating subscriptions" />
            <KpiCard label="Subscription mix" value={o.subscriptionsByStatus.length ? `${o.subscriptionsByStatus.length} state${o.subscriptionsByStatus.length === 1 ? "" : "s"}` : "—"} icon={Archive}
              sub={o.subscriptionsByStatus.map((s) => `${s.count} ${s.status.toLowerCase()}`).join(" · ") || "no subscriptions yet"} />
          </div>

          {/* ---- backup compliance strip ---- */}
          <BackupStrip backup={o.backup} />
        </>
      ) : null}

      {/* ---- fleet grid ---- */}
      <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60">
        <div className="flex flex-wrap items-center gap-3 border-b border-white/10 light:border-slate-200 px-4 py-3.5 sm:px-5">
          <p className="text-[11px] font-bold uppercase tracking-widest text-slate-500">Fleet grid</p>
          <div className="flex flex-wrap items-center gap-1.5">
            {TIERS.map((t) => (
              <button key={t} type="button" onClick={() => { setTier(t); setPage(1) }}
                className={`rounded-full border px-3 py-1 text-[11px] font-bold uppercase tracking-widest transition-colors ${
                  tier === t
                    ? t === "ALL"
                      ? "border-blue-400/50 bg-blue-500/15 text-blue-300 light:text-blue-700"
                      : TIER_STYLE[t]?.chip || ""
                    : "border-white/10 light:border-slate-300 text-slate-500 light:text-slate-600 hover:text-slate-300 light:hover:text-slate-800"
                }`}>
                {t === "ALL" ? "All" : TIER_STYLE[t]?.label}
              </button>
            ))}
          </div>
          <select value={status} onChange={(e) => { setStatus(e.target.value as typeof status); setPage(1) }}
            className="h-8 rounded-lg border border-white/10 light:border-slate-300 bg-white/5 light:bg-white px-2.5 text-xs font-semibold text-slate-300 light:text-slate-700">
            <option value="ALL">Any state</option>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </select>
          <form className="ml-auto flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); setQuery(search.trim()); setPage(1) }}>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Tenant, code or admin email…"
                className="h-9 w-56 border-white/10 light:border-slate-300 bg-white/5 light:bg-white pl-8 text-xs text-white light:text-slate-900" />
            </div>
            <Button type="submit" size="sm" className="h-9 bg-gradient-to-r from-blue-600 to-violet-600 text-white light:text-slate-900">Find</Button>
          </form>
        </div>

        {gridError && <div className="px-5 pt-4"><ErrorBanner message={gridError} /></div>}
        {gridLoading && rows.length === 0 ? (
          <Loading label="Loading the fleet…" />
        ) : (
          <TableShell headers={["Tier", "Tenant", "Plan", "Workforce", "Devices", "Storage", "Last login", "Term"]} empty={rows.length === 0}>
            {rows.map((r) => {
              const t = TIER_STYLE[r.tier] || TIER_STYLE.HEALTHY
              const d = daysUntil(r.endDate)
              return (
                <tr key={r.id} className="group transition-colors hover:bg-white/[0.03] light:hover:bg-slate-100/70">
                  <Td>
                    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest ${t.chip}`}>
                      {r.tier === "AT_RISK" ? (
                        <span className="relative flex h-1.5 w-1.5">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-60" />
                          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-rose-400" />
                        </span>
                      ) : (
                        <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} />
                      )}
                      {t.label}
                    </span>
                  </Td>
                  <Td>
                    <Link href={`/owner/tenants/${r.id}`} className="flex flex-col">
                      <span className="font-semibold text-white light:text-slate-900 group-hover:text-blue-300 light:group-hover:text-blue-700">
                        {r.name}
                      </span>
                      <span className="text-[11px] text-slate-500">
                        {r.code}{r.admin ? ` · ${r.admin.email}` : ""}{!r.active ? " · inactive" : ""}
                      </span>
                    </Link>
                  </Td>
                  <Td>
                    <span className="flex flex-col gap-1">
                      <span className="text-xs font-medium text-slate-200 light:text-slate-800">{r.planName}</span>
                      <StatusChip status={r.subscriptionStatus} />
                    </span>
                  </Td>
                  <Td className="tabular-nums">
                    <span className="text-slate-200 light:text-slate-800">{r.activeEmployees.toLocaleString()} emp</span>
                    <span className="text-[11px] text-slate-500"> · {r.activeUsers.toLocaleString()} users</span>
                  </Td>
                  <Td className="tabular-nums">
                    <span className={r.devicesEnabled > 0 && r.devicesOnline === 0 ? "text-amber-300 light:text-amber-700" : "text-slate-200 light:text-slate-800"}>
                      {r.devicesOnline}/{r.devicesEnabled}
                    </span>
                    <span className="text-[11px] text-slate-500"> online</span>
                  </Td>
                  <Td className="tabular-nums text-slate-300 light:text-slate-700">{fmtBytes(r.storageBytes)}</Td>
                  <Td>
                    <span className="flex flex-col">
                      <span className="text-xs text-slate-300 light:text-slate-700">{timeAgo(r.lastLoginAt)}</span>
                      {r.lastLoginAt && <span className="text-[10px] text-slate-500">{fmtDateTime(r.lastLoginAt)}</span>}
                    </span>
                  </Td>
                  <Td>
                    {d === null ? (
                      <span className="text-xs text-slate-500">—</span>
                    ) : (
                      <span className={`text-xs font-semibold tabular-nums ${d <= 3 ? "text-rose-300 light:text-rose-600" : d <= 14 ? "text-amber-300 light:text-amber-700" : "text-slate-300 light:text-slate-700"}`}>
                        {d < 0 ? `${-d}d overdue` : `${d}d left`}
                      </span>
                    )}
                  </Td>
                </tr>
              )
            })}
          </TableShell>
        )}

        {/* pagination */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 light:border-slate-200 px-4 py-3 sm:px-5">
          <p className="text-xs text-slate-500">
            {total.toLocaleString()} tenant{total === 1 ? "" : "s"} · page {page} of {totalPages}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1 || gridLoading} onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="h-8 border-white/10 light:border-slate-300 bg-white/5 light:bg-white text-white light:text-slate-900">
              <ChevronLeft className="h-3.5 w-3.5" /> Prev
            </Button>
            <Button variant="outline" size="sm" disabled={page >= totalPages || gridLoading} onClick={() => setPage((p) => p + 1)}
              className="h-8 border-white/10 light:border-slate-300 bg-white/5 light:bg-white text-white light:text-slate-900">
              Next <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Backup compliance strip — last backup / last drill / encryption / schedule,
 * each with an honest tone (green recent+ok, amber stale/off, red failed). */
function BackupStrip({ backup }: { backup: Overview["backup"] }) {
  const lastBackupAge = backup.lastBackup ? ageHours(backup.lastBackup.finishedAt || backup.lastBackup.startedAt) : null
  const backupTone: "red" | "amber" | "emerald" =
    !backup.lastBackup || backup.lastBackup.status === "FAILED" ? "red"
    : backup.lastBackup.status === "RUNNING" || backup.lastBackup.status === "PENDING" ? "amber"
    : lastBackupAge !== null && lastBackupAge > 48 ? "amber"
    : "emerald"
  const drillTone: "red" | "amber" | "emerald" =
    !backup.lastDrill ? "amber"
    : backup.lastDrill.status !== "DONE" ? "amber"
    : backup.lastDrill.pass === false ? "red"
    : "emerald"
  const cell = (tone: "red" | "amber" | "emerald") =>
    tone === "red" ? "border-rose-400/40 bg-rose-500/10"
    : tone === "amber" ? "border-amber-400/40 bg-amber-500/10"
    : "border-emerald-400/40 bg-emerald-500/10"
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <div className={`rounded-2xl border p-4 ${cell(backupTone)}`}>
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-bold uppercase tracking-widest text-slate-400 light:text-slate-600">Last backup</p>
          <Archive className="h-4 w-4 text-slate-500" />
        </div>
        <p className="mt-1.5 flex items-baseline gap-2 text-lg font-bold text-white light:text-slate-900">
          {backup.lastBackup ? backup.lastBackup.status : "Never"}
          {backup.lastBackup?.sizeBytes != null && <span className="text-xs font-medium text-slate-400">{fmtBytes(backup.lastBackup.sizeBytes)}</span>}
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-400 light:text-slate-600">
          {backup.lastBackup
            ? `${timeAgo(backup.lastBackup.finishedAt || backup.lastBackup.startedAt)} · ${fmtDateTime(backup.lastBackup.finishedAt || backup.lastBackup.startedAt)}`
            : "No backup has ever run — open Backup & Recovery"}
          {backup.lastBackup?.error ? <span className="mt-1 block text-rose-300 light:text-rose-600">{backup.lastBackup.error.slice(0, 140)}</span> : null}
        </p>
      </div>
      <div className={`rounded-2xl border p-4 ${cell(drillTone)}`}>
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-bold uppercase tracking-widest text-slate-400 light:text-slate-600">Restore drill</p>
          <HeartPulse className="h-4 w-4 text-slate-500" />
        </div>
        <p className="mt-1.5 flex items-baseline gap-2 text-lg font-bold text-white light:text-slate-900">
          {backup.lastDrill
            ? backup.lastDrill.pass === true ? "Passed" : backup.lastDrill.pass === false ? "Failed" : backup.lastDrill.status
            : "Never"}
        </p>
        <p className="mt-1 text-[11px] text-slate-400 light:text-slate-600">
          {backup.lastDrill ? `${timeAgo(backup.lastDrill.finishedAt || backup.lastDrill.startedAt)} · ${fmtDateTime(backup.lastDrill.startedAt)}` : "Run a drill from Backup & Recovery"}
        </p>
      </div>
      <div className={`rounded-2xl border p-4 ${backup.encryptionEnabled ? cell("emerald") : cell("amber")}`}>
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-bold uppercase tracking-widest text-slate-400 light:text-slate-600">At-rest encryption</p>
          <ShieldCheck className="h-4 w-4 text-slate-500" />
        </div>
        <p className="mt-1.5 text-lg font-bold text-white light:text-slate-900">{backup.encryptionEnabled ? "Enabled" : "Off"}</p>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-400 light:text-slate-600">
          {backup.encryptionEnabled
            ? "Artifacts are AES-256-CBC encrypted (HRM_BACKUP_KEY)."
            : "Set HRM_BACKUP_KEY to encrypt backup artifacts at rest."}
        </p>
      </div>
      <div className={`rounded-2xl border p-4 ${backup.scheduleEnabled ? cell("emerald") : cell("amber")}`}>
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-bold uppercase tracking-widest text-slate-400 light:text-slate-600">Nightly schedule</p>
          <Timer className="h-4 w-4 text-slate-500" />
        </div>
        <p className="mt-1.5 text-lg font-bold text-white light:text-slate-900">{backup.scheduleEnabled ? "On" : "Off"}</p>
        <p className="mt-1 text-[11px] text-slate-400 light:text-slate-600">
          {backup.scheduleEnabled ? `Automatic backups · retention ${backup.retention} runs` : "Enable in Backup & Recovery settings"}
        </p>
      </div>
    </div>
  )
}
