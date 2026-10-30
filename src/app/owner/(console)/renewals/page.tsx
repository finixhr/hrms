"use client"
// ============ /owner/renewals — Renewal Calendar console (P5 rebuild) =======
// §28, rebuilt on the P0–P4 console design system. The old page rode the
// pre-P5 owner.renewals.list — a full-table load JS-filtered in memory. P5
// rewrote the action to the SQL-paged console standard (window semantics +
// CEIL day arithmetic IN SQL, summary block, total/page/pageSize; rows +
// settings shape unchanged), and this page now uses it properly:
//   - KPI strip from the response's own summary (≤7d / ≤30d / overdue /
//     operating) + the grace policy banner.
//   - Window chips instead of a Select; soonest-endDate-first ordering (most
//     urgent renewal first; EXPIRED = most overdue first).
//   - True pagination + 60 s auto-refresh, dark + light modes.
import { useEffect, useState } from "react"
import Link from "next/link"
import { AlertTriangle, CalendarClock, ChevronLeft, ChevronRight, History, RefreshCw, ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useOwnerApi } from "@/saas/owner/client"
import { ErrorBanner, KpiCard, PageHeader, StatusChip, TableShell, Td, fmtDate, Loading } from "@/saas/owner/ui"
import { cn } from "@/lib/utils"

type Row = {
  id: string; vendorId: string; tenant: string; planName: string
  cycle: string; status: string; endDate: string; daysRemaining: number
}

type Response = {
  rows: Row[]
  settings: { gracePeriodDays: number; renewalReminderDays: number[] }
  summary: { operating: number; expiring7d: number; expiring30d: number; overdue: number }
  total: number; page: number; pageSize: number
}

const WINDOW_CHIPS = [
  { key: "7", label: "≤ 7 days" },
  { key: "30", label: "≤ 30 days" },
  { key: "60", label: "≤ 60 days" },
  { key: "EXPIRED", label: "Already expired" },
  { key: "ALL", label: "All operating" },
] as const
type WindowChip = (typeof WINDOW_CHIPS)[number]["key"]

const PAGE_SIZE = 25

export default function RenewalsPage() {
  const [win, setWin] = useState<WindowChip>("30")
  const [page, setPage] = useState(1)
  const { data, loading, error, reload } = useOwnerApi<Response>(
    "owner.renewals.list", { window: win, page, pageSize: PAGE_SIZE }, [win, page]
  )

  // 60 s auto-refresh (the P0–P4 console rhythm)
  useEffect(() => {
    const t = setInterval(() => { reload().catch(() => {}) }, 60_000)
    return () => clearInterval(t)
  }, [reload])

  const total = data?.total || 0
  const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const s = data?.summary

  return (
    <div className="space-y-5">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-teal-500 to-emerald-600 shadow-lg shadow-teal-950/50">
              <CalendarClock className="h-4 w-4 text-white" />
            </span>
            Renewal Calendar
          </span>
        }
        sub="Upcoming expirations with days remaining, soonest first. Windows, day counts and paging all compute in SQL."
        actions={
          <Button variant="outline" size="sm" disabled={loading} onClick={() => reload().catch(() => {})}>
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /> Refresh
          </Button>
        }
      />

      {s && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard label="Operating subscriptions" value={s.operating.toLocaleString("en-IN")} icon={ShieldCheck}
            sub="TRIAL + ACTIVE + PAST_DUE + GRACE + EXPIRED statuses" />
          <KpiCard label="Expiring ≤ 7 days" value={s.expiring7d.toLocaleString("en-IN")}
            tone={s.expiring7d > 0 ? "amber" : "emerald"} icon={CalendarClock}
            sub="renewal reminder emails already firing at the configured marks" />
          <KpiCard label="Expiring ≤ 30 days" value={s.expiring30d.toLocaleString("en-IN")}
            tone={s.expiring30d > 0 ? "amber" : "default"} icon={CalendarClock}
            sub="the working renewal pipeline — extend from each tenant's page" />
          <KpiCard label="Past end date" value={s.overdue.toLocaleString("en-IN")}
            tone={s.overdue > 0 ? "red" : "emerald"} icon={AlertTriangle}
            sub="inside / beyond grace — the lifecycle sweep takes it from here" />
        </div>
      )}

      {data?.settings && (
        <p className="flex items-center gap-2 rounded-xl border border-blue-400/25 bg-blue-500/10 p-3 text-sm text-blue-200 light:text-blue-700">
          <CalendarClock className="h-4 w-4" />
          Grace policy: {data.settings.gracePeriodDays} days · reminders at {data.settings.renewalReminderDays.join(" / ")} days before expiry.
        </p>
      )}

      {/* window chips */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          {WINDOW_CHIPS.map((c) => (
            <button key={c.key} type="button" onClick={() => { setWin(c.key); setPage(1) }}
              className={cn("rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors",
                win === c.key
                  ? "border-teal-400/50 bg-teal-500/15 text-teal-200 light:text-teal-700"
                  : "border-white/10 light:border-slate-200 text-slate-500 light:text-slate-600 hover:text-white light:hover:text-slate-900")}>
              {c.label}
            </button>
          ))}
        </div>
        <span className="ml-auto text-xs text-slate-500">
          {total.toLocaleString("en-IN")} renewal{total === 1 ? "" : "s"} in view
        </span>
      </div>

      {error && <ErrorBanner message={error} />}
      {loading && !data ? <Loading /> : (
        <TableShell headers={["Tenant", "Plan", "Cycle", "Status", "Ends", "Days remaining", ""]} empty={data?.rows.length === 0}>
          {data?.rows.map((r) => (
            <tr key={r.id} className="transition-colors hover:bg-white/[0.03] light:hover:bg-slate-100/60">
              <Td>
                <Link href={`/owner/tenants/${r.vendorId}`} className="font-medium text-white light:text-slate-900 hover:text-indigo-300 light:hover:text-indigo-700">{r.tenant}</Link>
              </Td>
              <Td className="text-xs">{r.planName}</Td>
              <Td><StatusChip status={r.cycle} /></Td>
              <Td><StatusChip status={r.status} /></Td>
              <Td className="text-xs">{fmtDate(r.endDate)}</Td>
              <Td className={cn("font-semibold tabular-nums", r.daysRemaining < 0 ? "text-red-300 light:text-red-600" : r.daysRemaining <= 7 ? "text-amber-300 light:text-amber-700" : "text-slate-300 light:text-slate-700")}>
                {r.daysRemaining < 0 ? `${Math.abs(r.daysRemaining)}d ago` : `${r.daysRemaining}d`}
              </Td>
              <Td>
                <Link href={`/owner/tenants/${r.vendorId}`} className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-300 light:text-indigo-700 hover:text-indigo-200 light:hover:text-indigo-800">
                  extend <ChevronRight className="h-3 w-3" />
                </Link>
              </Td>
            </tr>
          ))}
        </TableShell>
      )}

      {total > PAGE_SIZE && (
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
      <p className="flex items-center gap-1.5 text-xs text-slate-500">
        <History className="h-3.5 w-3.5" />
        Day counts are whole-day ceilings computed in SQL — a subscription ending later today reads 0d, one ending in 6.5 days reads 7d.
      </p>
    </div>
  )
}
