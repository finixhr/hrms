"use client"
// ============ UsagePanel (WP-C) — live usage vs plan limits, ONE data source ============
// Shared by the Subscription & Usage view, the Billing page (WP-H) and the
// plan-usage dashboard widget. Data comes from the subscription.usage RPC
// (per-limit {used, limit, pct, status}); warning ≥80%, danger ≥95%, over =
// usage > limit with an upgrade CTA. LEGACY tenants see unlimited badges.

import {
  Users, UserRound, Building2, Network, Cctv, MapPin, HardDrive, ArrowUpRight, AlertTriangle,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { useApi } from "../api"
import { useHrm } from "../store"

export type UsageRow = {
  key: string
  used: number
  limit: number | null
  pct: number | null
  status: "ok" | "warning" | "danger" | "over" | "unlimited"
  unit: "GB" | "count"
}

export type UsageResponse = {
  mode: "SUBSCRIBED" | "LEGACY"
  planName: string | null
  rows: UsageRow[]
  callout: { key: string; pct: number | null; status: string; message: string } | null
}

const ICONS: Record<string, any> = {
  EMPLOYEES: Users,
  USERS: UserRound,
  BRANCHES: Building2,
  DEPARTMENTS: Network,
  DEVICES: Cctv,
  TRACKING_EMPLOYEES: MapPin,
  STORAGE: HardDrive,
}

const LABELS: Record<string, string> = {
  EMPLOYEES: "Employees",
  USERS: "Users",
  BRANCHES: "Branches",
  DEPARTMENTS: "Departments",
  DEVICES: "Attendance Devices",
  TRACKING_EMPLOYEES: "Live-Tracking Employees",
  STORAGE: "Storage",
}

// R14 (2026-10-12) — clear storage display: under 1 GB the used amount shows
// MB (e.g. "412.6 MB"); at or above 1 GB it shows GB with 2 decimals.
// Fractional-GB plan limits (storageGb < 1, e.g. 0.5 GB plans) display as MB.
export function fmtStorageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB"
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}
export function fmtStorageGb(gb: number | null | undefined): string {
  if (gb == null) return "unlimited"
  if (gb >= 1) return `${Number(gb) % 1 === 0 ? gb.toLocaleString() : gb.toFixed(2)} GB`
  return `${Math.round(gb * 1024)} MB`
}
function fmtUsed(row: UsageRow): string {
  if (row.unit === "GB") return fmtStorageBytes(row.used)
  return row.used.toLocaleString()
}
function fmtLimit(row: UsageRow): string {
  if (row.limit == null) return "unlimited"
  if (row.unit === "GB") return fmtStorageGb(row.limit)
  return row.limit.toLocaleString()
}

export function UsageMeterRow({ row, onUpgrade }: { row: UsageRow; onUpgrade?: () => void }) {
  const Icon = ICONS[row.key] || HardDrive
  const unlimited = row.limit == null
  const pct = row.pct ?? 0
  const tone =
    row.status === "over" ? "text-rose-600 dark:text-rose-400"
    : row.status === "danger" ? "text-rose-600 dark:text-rose-400"
    : row.status === "warning" ? "text-amber-600 dark:text-amber-400"
    : "text-emerald-600"
  const barClass =
    row.status === "over" || row.status === "danger" ? "[&>div]:bg-rose-500"
    : row.status === "warning" ? "[&>div]:bg-amber-500"
    : "[&>div]:bg-emerald-500"
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Icon className={`h-4 w-4 shrink-0 ${tone}`} />
          <span className="text-sm font-medium truncate">{LABELS[row.key] || row.key}</span>
          {row.status === "over" && (
            <Badge className="bg-rose-100 text-rose-700 dark:bg-rose-900/60 dark:text-rose-300 hover:bg-rose-100 text-[10px]">over limit</Badge>
          )}
        </div>
        <span className={`text-sm font-bold tabular-nums ${row.status === "ok" || unlimited ? "text-slate-700 dark:text-slate-200" : tone}`}>
          {fmtUsed(row)} / {fmtLimit(row)}
        </span>
      </div>
      {!unlimited && <Progress value={Math.min(100, pct)} className={`mt-3 h-2 ${barClass}`} />}
      {row.status === "over" && (
        <div className="mt-2 flex items-center justify-between gap-2">
          <p className="text-xs text-rose-600 dark:text-rose-400">
            New records of this type are blocked until you upgrade.
          </p>
          {onUpgrade && (
            <Button size="sm" variant="outline" className="h-7 text-xs gap-1 shrink-0" onClick={onUpgrade}>
              <ArrowUpRight className="h-3.5 w-3.5" /> Upgrade
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

/** Full panel: fetches subscription.usage itself. `onUpgrade` routes the CTA
 *  (Billing page in tenant context, Billing admin elsewhere). */
export function UsagePanel({ onUpgrade, compact = false }: { onUpgrade?: () => void; compact?: boolean }) {
  const can = useHrm((s) => s.can)
  const { data, loading, error } = useApi<UsageResponse>(
    can("subscription", "view") ? "subscription.usage" : null, {},
  )
  if (loading) return <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{[...Array(compact ? 3 : 6)].map((_, i) => <div key={i} className="h-20 rounded-xl bg-slate-100 dark:bg-slate-800 animate-pulse" />)}</div>
  if (error) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-900 p-4 text-sm text-amber-800 dark:text-amber-300">
        Usage information is unavailable right now.
      </div>
    )
  }
  if (!data) return null
  if (data.mode === "LEGACY") {
    return (
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 text-sm text-slate-500">
        No plan limits apply to this workspace (legacy deployment).
      </div>
    )
  }
  return (
    <div className="space-y-3">
      {data.callout && data.callout.status !== "ok" && (
        <div className={`flex items-start gap-2 rounded-xl border p-3 text-sm ${
          data.callout.status === "over"
            ? "border-rose-200 bg-rose-50 dark:bg-rose-950/40 dark:border-rose-900 text-rose-700 dark:text-rose-300"
            : "border-amber-200 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-900 text-amber-800 dark:text-amber-300"
        }`}>
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{data.callout.message}</span>
        </div>
      )}
      <div className={`grid gap-2 ${compact ? "sm:grid-cols-2" : "sm:grid-cols-2 lg:grid-cols-3"}`}>
        {data.rows.map((row) => <UsageMeterRow key={row.key} row={row} onUpgrade={onUpgrade} />)}
      </div>
    </div>
  )
}

// ================= WP-C — create-time capacity pre-check =================
/** One shared client-side hook: fetches subscription.usage ONCE per mount
 *  window and answers "is this limit near/over?" so create forms can show an
 *  inline warning BEFORE the server blocks. The server's requireCapacity()
 *  remains the enforcement boundary (actionable Deny naming limit, usage and
 *  upgrade path); this is UX only. */
import { useMemo } from "react"
import { useHrm as useHrmStore } from "../store"

export function useCapacity(limitKey: string): {
  row: UsageRow | null
  nearLimit: boolean
  overLimit: boolean
  pct: number | null
  warning: string | null
} {
  const can = useHrmStore((s) => s.can)
  const { data } = useApi<UsageResponse>(
    can("subscription", "view") ? "subscription.usage" : null, {},
  )
  return useMemo(() => {
    const row = data?.rows.find((r) => r.key === limitKey) ?? null
    if (!row || row.limit == null) return { row: null, nearLimit: false, overLimit: false, pct: null, warning: null }
    const pct = row.pct ?? 0
    const nearLimit = pct >= 80
    const overLimit = row.status === "over"
    const fmt = row.unit === "GB" ? fmtStorageBytes(row.used) : row.used.toLocaleString()
    const fmtCap = row.unit === "GB" ? fmtStorageGb(row.limit) : row.limit?.toLocaleString() ?? "unlimited"
    const warning = overLimit
      ? `You are over your ${LABELS[limitKey] || limitKey} limit (${fmt} of ${fmtCap}) — the server will block new records until you upgrade.`
      : nearLimit
        ? `You are using ${pct}% of your ${LABELS[limitKey] || limitKey} limit (${fmt} of ${fmtCap}).`
        : null
    return { row, nearLimit, overLimit, pct, warning }
  }, [data, limitKey])
}

/** The inline warning banner create forms render above their fields. */
export function CapacityWarning({ limitKey }: { limitKey: string }) {
  const { warning } = useCapacity(limitKey)
  if (!warning) return null
  const over = warning.startsWith("You are over")
  return (
    <div className={`mb-3 flex items-start gap-2 rounded-lg border p-2.5 text-xs ${
      over
        ? "border-rose-200 bg-rose-50 dark:bg-rose-950/40 dark:border-rose-900 text-rose-700 dark:text-rose-300"
        : "border-amber-200 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-900 text-amber-800 dark:text-amber-300"
    }`}>
      <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
      <span>{warning}</span>
    </div>
  )
}
