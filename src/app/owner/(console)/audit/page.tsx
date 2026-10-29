"use client"
// ============ /owner/audit — Platform Audit console (Phase 5 P4 rebuild) =====
// The platform forensic trail (§32), rebuilt on the P0/P1/P2/P3 console design
// system. The old page was a bare paged table; this rebuild adds the analytics
// companion owner.audit.overview (P4) — volume windows, a 6-week event trend,
// the action / entity / actor mixes and the retention horizon vs the SEC-16
// sweep policy — while the row grid keeps riding the long-standing
// owner.audit.list action (untouched, same filters: entity + search + paging).
// Read-only: the trail is append-only by design (MOD-15 keeps it that way).
import { useEffect, useState } from "react"
import {
  ChevronLeft, ChevronRight, History, RefreshCw, ScrollText, Search, UserCog,
} from "lucide-react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useOwnerApi } from "@/saas/owner/client"
import { ErrorBanner, KpiCard, Loading, PageHeader, StatusChip, TableShell, Td, fmtDateTime } from "@/saas/owner/ui"
import { cn } from "@/lib/utils"

type Row = {
  id: string; actorName: string; action: string; entity: string; entityId: string | null
  vendorId: string | null; summary: string; metadata: any; ip: string | null; createdAt: string
}

type Overview = {
  generatedAt: string
  events24h: number; events7d: number; events30d: number
  notifications30d: number; actors30d: number
  trend: { weekStart: string; events: number }[]
  topActions: { action: string; count: number }[]
  topEntities: { entity: string; count: number }[]
  topActors: { actorName: string; count: number }[]
  retention: { policyDays: number | null; oldestDays: number | null }
}

const ENTITIES = ["ALL", "SaaSRegistration", "Vendor", "SaaSSubscription", "SaaSPlan", "SaaSOwnerUser", "SaaSInvoice", "SaaSContactInquiry", "SaaSSetting"]

const weekLabel = (w: string) =>
  new Date(`${w}T00:00:00Z`).toLocaleString("en", { month: "short", day: "numeric", timeZone: "UTC" })

/** 6-week audit volume — thin CSS bars (the P3 chart language). */
function VolumeChart({ trend }: { trend: Overview["trend"] }) {
  const max = Math.max(1, ...trend.map((t) => t.events))
  return (
    <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-5">
      <p className="mb-1 text-xs font-bold uppercase tracking-widest text-slate-500">Forensic events — last 6 weeks</p>
      <p className="mb-4 text-[11px] text-slate-600 light:text-slate-500">
        Every audited platform action per calendar week (Monday start, UTC) — owner actions and system notifications alike.
      </p>
      <div className="flex h-28 items-end gap-2 sm:gap-4">
        {trend.map((t) => (
          <div key={t.weekStart} className="flex h-full flex-1 flex-col items-center justify-end gap-1.5">
            <span className="text-[10px] font-bold tabular-nums text-slate-400 light:text-slate-600">{t.events.toLocaleString("en-IN")}</span>
            <div
              className="w-full max-w-[30px] rounded-t-md bg-gradient-to-t from-amber-600/70 to-orange-400 transition-all"
              style={{ height: `${Math.max(t.events > 0 ? 6 : 2, (t.events / max) * 100)}%` }}
              title={`${weekLabel(t.weekStart)}: ${t.events.toLocaleString("en-IN")} event${t.events === 1 ? "" : "s"}`}
            />
            <span className="text-[10px] font-semibold text-slate-500">{weekLabel(t.weekStart)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** One mix row: label + bar + count (the P3 PlanRow language). */
function MixRow({ label, count, max, tone }: { label: string; count: number; max: number; tone: string }) {
  const pct = max > 0 ? Math.max(2, Math.round((count / max) * 100)) : 0
  return (
    <div className="flex items-center gap-3">
      <span className="w-40 shrink-0 truncate text-xs font-semibold text-slate-300 light:text-slate-700" title={label}>{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10 light:bg-slate-200">
        <div className={cn("h-full rounded-full", tone)} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-12 shrink-0 text-right text-xs tabular-nums text-slate-400 light:text-slate-600">
        {count.toLocaleString("en-IN")}
      </span>
    </div>
  )
}

export default function AuditPage() {
  const overview = useOwnerApi<Overview>("owner.audit.overview")
  const [entity, setEntity] = useState("ALL")
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(1)
  const { data, loading, error, reload } = useOwnerApi<{ rows: Row[]; total: number }>(
    "owner.audit.list", { entity, search: search || undefined, page, pageSize: 50 }, [entity, search, page]
  )

  // 60 s auto-refresh (the P0–P3 console rhythm)
  useEffect(() => {
    const t = setInterval(() => {
      overview.reload().catch(() => {})
      reload().catch(() => {})
    }, 60_000)
    return () => clearInterval(t)
  }, [overview.reload, reload])

  const o = overview.data
  const actionMax = Math.max(1, ...(o?.topActions || []).map((a) => a.count))
  const entityMax = Math.max(1, ...(o?.topEntities || []).map((a) => a.count))
  const actorMax = Math.max(1, ...(o?.topActors || []).map((a) => a.count))
  const maxPage = Math.max(1, Math.ceil((data?.total || 0) / 50))

  return (
    <div className="space-y-5">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 shadow-lg shadow-amber-950/50">
              <ScrollText className="h-4 w-4 text-white" />
            </span>
            Platform Audit
          </span>
        }
        sub="Every sensitive platform action — actor, action, target, before/after, reason and IP — from the append-only SaaSAuditLog. The forensic record survives even the deletions it witnesses."
        actions={
          <div className="flex items-center gap-2">
            {o && <span className="hidden text-xs text-slate-500 sm:inline">generated {new Date(o.generatedAt).toLocaleTimeString()}</span>}
            <Button variant="outline" size="sm" disabled={overview.loading || loading}
              onClick={() => { overview.reload().catch(() => {}); reload().catch(() => {}) }}>
              <RefreshCw className={cn("h-3.5 w-3.5", (overview.loading || loading) && "animate-spin")} /> Refresh
            </Button>
          </div>
        }
      />

      {overview.error && <ErrorBanner message={overview.error} />}

      {o && (
        <>
          {/* KPI strip */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Events — 24h" value={o.events24h.toLocaleString("en-IN")}
              tone={o.events24h > 0 ? "default" : "default"} icon={History}
              sub={`${o.events7d.toLocaleString("en-IN")} in 7d · ${o.events30d.toLocaleString("en-IN")} in 30d`} />
            <KpiCard label="Active actors — 30d" value={o.actors30d.toLocaleString("en-IN")} tone="indigo" icon={UserCog}
              sub={`${o.notifications30d.toLocaleString("en-IN")} system notifications in the window`} />
            <KpiCard label="Oldest record" value={o.retention.oldestDays == null ? "empty" : `${o.retention.oldestDays.toLocaleString("en-IN")} d`}
              tone="default" icon={History}
              sub={o.retention.policyDays == null
                ? "retention sweep disabled (HRM_SAAS_AUDIT_RETENTION_DAYS=0)"
                : `within the ${o.retention.policyDays}-day policy window`} />
            <KpiCard label="Trail retention" value={o.retention.policyDays == null ? "OFF" : `${o.retention.policyDays} d`}
              tone={o.retention.policyDays == null ? "amber" : "emerald"} icon={History}
              sub="SEC-16 nightly sweep — append-only within the window" />
          </div>

          {/* trend + mixes */}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <VolumeChart trend={o.trend} />
            <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-5">
              <p className="mb-1 text-xs font-bold uppercase tracking-widest text-slate-500">Top actions — trailing 30 days</p>
              <p className="mb-4 text-[11px] text-slate-600 light:text-slate-500">The most frequent audited actions; NOTIFICATION_* rows are system emails riding the same trail.</p>
              {o.topActions.length ? (
                <div className="space-y-2.5">
                  {o.topActions.map((a) => (
                    <MixRow key={a.action} label={a.action.replace(/_/g, " ")} count={a.count} max={actionMax}
                      tone="bg-gradient-to-r from-amber-500 to-orange-400" />
                  ))}
                </div>
              ) : <p className="text-xs text-slate-500">No audited actions in 30 days.</p>}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-5">
              <p className="mb-1 text-xs font-bold uppercase tracking-widest text-slate-500">Entities touched — trailing 30 days</p>
              <p className="mb-4 text-[11px] text-slate-600 light:text-slate-500">Which records the platform team acted on most.</p>
              {o.topEntities.length ? (
                <div className="space-y-2.5">
                  {o.topEntities.map((e) => (
                    <MixRow key={e.entity} label={e.entity.replace("SaaS", "")} count={e.count} max={entityMax}
                      tone="bg-gradient-to-r from-teal-500 to-emerald-400" />
                  ))}
                </div>
              ) : <p className="text-xs text-slate-500">No entities touched in 30 days.</p>}
            </div>
            <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-5">
              <p className="mb-1 text-xs font-bold uppercase tracking-widest text-slate-500">Most active actors — trailing 30 days</p>
              <p className="mb-4 text-[11px] text-slate-600 light:text-slate-500">
                Who acted most (system notifications included). Deep-dive a person in{" "}
                <Link href="/owner/users" className="font-semibold text-indigo-300 light:text-indigo-700 hover:text-indigo-200 light:hover:text-indigo-800">Owner Users</Link>.
              </p>
              {o.topActors.length ? (
                <div className="space-y-2.5">
                  {o.topActors.map((a) => (
                    <MixRow key={a.actorName} label={a.actorName} count={a.count} max={actorMax}
                      tone="bg-gradient-to-r from-indigo-500 to-violet-400" />
                  ))}
                </div>
              ) : <p className="text-xs text-slate-500">No actors in 30 days.</p>}
            </div>
          </div>
        </>
      )}

      {/* ---- the forensic grid (owner.audit.list, untouched action) ---- */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
          <Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1) }}
            placeholder="Search summary, actor or action…" className="h-9 w-72 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 pl-8 text-xs" />
        </div>
        <Select value={entity} onValueChange={(v) => { setEntity(v); setPage(1) }}>
          <SelectTrigger className="h-9 w-52 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ENTITIES.map((e) => <SelectItem key={e} value={e}>{e === "ALL" ? "All entities" : e.replace("SaaS", "")}</SelectItem>)}
          </SelectContent>
        </Select>
        <span className="ml-auto text-xs text-slate-500">{data ? `${data.total.toLocaleString("en-IN")} events` : ""}</span>
      </div>

      {error && <ErrorBanner message={error} />}
      {loading && !data ? <Loading /> : (
        <TableShell headers={["When", "Actor", "Action", "Entity", "Summary", "IP"]} empty={data?.rows.length === 0}>
          {data?.rows.map((r) => (
            <tr key={r.id} className="align-top transition-colors hover:bg-white/[0.03] light:hover:bg-slate-100/60">
              <Td className="text-xs tabular-nums">{fmtDateTime(r.createdAt)}</Td>
              <Td className="text-xs text-white light:text-slate-900">{r.actorName}</Td>
              <Td><StatusChip status={r.action.includes("REJECT") || r.action.includes("SUSPEND") ? "REJECTED" : r.action.includes("APPROVE") || r.action.includes("CREATED") ? "APPROVED" : "UNDER_REVIEW"} /></Td>
              <Td className="text-xs">{r.entity.replace("SaaS", "")}</Td>
              <Td className="max-w-[480px] whitespace-normal text-xs leading-relaxed">{r.summary}</Td>
              <Td className="font-mono text-xs text-slate-500">{r.ip || "—"}</Td>
            </tr>
          ))}
        </TableShell>
      )}

      {data && data.total > 50 && (
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
  )
}
