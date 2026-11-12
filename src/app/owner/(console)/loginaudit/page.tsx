"use client"
// ============ /owner/loginaudit — Login Audit console (Phase 5 P4 rebuild) ===
// R16 login-attempt audit, rebuilt on the P0/P1/P2/P3 console design system.
// Every login attempt on BOTH planes (tenant /api/hrm + owner /api/owner),
// success AND failure: identity (where resolvable), tenant, IP, browser / OS /
// device (parsed from the user-agent at capture time), MFA usage and failure
// reason. The grid keeps riding the long-standing owner.loginaudit.list action
// (untouched — same filters + the response's own success/failure counters);
// the KPI strip and failure-reason legend render from those counters. Rows are
// retention-swept by the platform scheduler (tenant rows per-tenant setting,
// owner rows 180 days). Security posture lives in the P4 Security Console.
import { useEffect, useState } from "react"
import {
  Bot, CheckCircle2, KeyRound, Monitor, RefreshCw, Search, Smartphone, Tablet, XCircle,
} from "lucide-react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { useOwnerApi } from "@/saas/owner/client"
import { ErrorBanner, KpiCard, Loading, PageHeader, TableShell, Td, fmtDateTime } from "@/saas/owner/ui"

type Row = {
  id: string
  plane: "TENANT" | "OWNER"
  email: string
  success: boolean
  failureReason: string | null
  userId: string | null
  userName: string | null
  vendorId: string | null
  vendorName: string | null
  role: string | null
  mfaUsed: boolean
  ip: string | null
  userAgent: string | null
  browser: string | null
  os: string | null
  deviceType: string | null
  createdAt: string
}

const inputCls = "h-9 border-white/10 light:border-slate-300 bg-white/5 light:bg-white light:text-slate-900 text-xs"

const reasonLabels: Record<string, string> = {
  INVALID_CREDENTIALS: "Invalid credentials",
  LOCKED_OUT: "Account locked out",
  MFA_FAILED: "MFA challenge failed",
  MFA_REQUIRED_FAILED: "MFA challenge failed",
  RATE_LIMITED: "Rate limited",
  INACTIVE_VENDOR: "Vendor inactive",
  AMBIGUOUS_EMAIL: "Ambiguous email (multiple tenants)",
  ERROR: "Server error",
}

export default function LoginAuditPage() {
  const [search, setSearch] = useState("")
  const [plane, setPlane] = useState("ALL")
  const [outcome, setOutcome] = useState("ALL")
  const [deviceType, setDeviceType] = useState("ALL")
  const [browser, setBrowser] = useState("")
  const [page, setPage] = useState(1)

  const { data, loading, error, reload } = useOwnerApi<
    { total: number; pageSize: number; rows: Row[]; failureCount: number; successCount: number; failureReasons: Record<string, number> }
  >(
    "owner.loginaudit.list",
    {
      search: search || undefined,
      plane, outcome, deviceType,
      browser: browser.trim() || undefined,
      page, pageSize: 30,
    },
    [search, plane, outcome, deviceType, browser, page]
  )

  // 60 s auto-refresh (the P0–P3 console rhythm)
  useEffect(() => {
    const t = setInterval(() => { reload().catch(() => {}) }, 60_000)
    return () => clearInterval(t)
  }, [reload])

  const deviceIcon = (d: string | null) =>
    d === "mobile" ? <Smartphone className="h-3.5 w-3.5" /> : d === "tablet" ? <Tablet className="h-3.5 w-3.5" /> : d === "bot" ? <Bot className="h-3.5 w-3.5" /> : <Monitor className="h-3.5 w-3.5" />

  const total = data?.total || 0
  const successes = data?.successCount || 0
  const failures = data?.failureCount || 0
  const failureRate = total > 0 ? Math.round((failures / total) * 1000) / 10 : null
  const maxPage = Math.max(1, Math.ceil(total / 30))
  const reasonEntries = Object.entries(data?.failureReasons || {}).sort((a, b) => b[1] - a[1])

  return (
    <div className="space-y-5">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500 to-blue-600 shadow-lg shadow-sky-950/50">
              <KeyRound className="h-4 w-4 text-white" />
            </span>
            Login Audit
          </span>
        }
        sub="Every sign-in attempt on both planes — success and failure, with identity, IP, browser, OS and device. Retention: 180 days (owner plane) / per-tenant setting."
        actions={
          <div className="flex items-center gap-2">
            <Link href="/owner/security" className="hidden text-xs font-semibold text-indigo-300 light:text-indigo-700 hover:text-indigo-200 light:hover:text-indigo-800 sm:inline">
              Security Console →
            </Link>
            <Button variant="outline" size="sm" disabled={loading} onClick={() => reload().catch(() => {})}>
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /> Refresh
            </Button>
          </div>
        }
      />

      {/* KPI strip — counters within the CURRENT filter window */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Attempts in view" value={total.toLocaleString("en-IN")}
          sub="matching the filters below" icon={KeyRound} />
        <KpiCard label="Succeeded" value={successes.toLocaleString("en-IN")} tone="emerald" icon={CheckCircle2}
          sub={`${data ? data.rows.filter((r) => r.success && r.mfaUsed).length : 0} MFA-verified on this page`} />
        <KpiCard label="Failed" value={failures.toLocaleString("en-IN")} tone={failures > 0 ? "red" : "default"} icon={XCircle}
          sub={failureRate == null ? "no attempts in view" : `${failureRate}% of attempts in view`} />
        <KpiCard label="Failure mix in view" value={reasonEntries.length || "—"}
          sub={reasonEntries.length
            ? `top: ${reasonLabels[reasonEntries[0][0]] || reasonEntries[0][0].replace(/_/g, " ")} · ${reasonEntries[0][1]}`
            : "no failures in view"} icon={Bot} />
      </div>

      {/* filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
          <Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1) }}
            placeholder="Email, user, tenant or IP…" className={cn(inputCls, "w-64 pl-8")} />
        </div>
        <Select value={plane} onValueChange={(v) => { setPlane(v); setPage(1) }}>
          <SelectTrigger className={cn(inputCls, "w-36")}><SelectValue /></SelectTrigger>
          <SelectContent>
            {["ALL", "TENANT", "OWNER"].map((p) => <SelectItem key={p} value={p}>{p === "ALL" ? "Both planes" : p === "TENANT" ? "Tenant app" : "Owner console"}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={outcome} onValueChange={(v) => { setOutcome(v); setPage(1) }}>
          <SelectTrigger className={cn(inputCls, "w-32")}><SelectValue /></SelectTrigger>
          <SelectContent>
            {["ALL", "SUCCESS", "FAILURE"].map((o) => <SelectItem key={o} value={o}>{o === "ALL" ? "All outcomes" : o === "SUCCESS" ? "Success" : "Failure"}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={deviceType} onValueChange={(v) => { setDeviceType(v); setPage(1) }}>
          <SelectTrigger className={cn(inputCls, "w-32")}><SelectValue /></SelectTrigger>
          <SelectContent>
            {["ALL", "desktop", "mobile", "tablet", "bot"].map((d) => <SelectItem key={d} value={d}>{d === "ALL" ? "All devices" : d === "desktop" ? "Desktop" : d === "mobile" ? "Mobile" : d === "tablet" ? "Tablet" : "Bot"}</SelectItem>)}
          </SelectContent>
        </Select>
        <Input value={browser} onChange={(e) => { setBrowser(e.target.value); setPage(1) }}
          placeholder="Browser contains…" className={cn(inputCls, "w-40")} />
      </div>

      {/* failure-reason legend (within the current filter window) */}
      {reasonEntries.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {reasonEntries.map(([reason, n]) => (
            <span key={reason} title={`${n} in view`}
              className="inline-flex items-center gap-1.5 rounded-full border border-red-400/30 bg-red-500/10 px-3 py-1 text-[11px] font-bold tracking-wide text-red-300 light:text-red-600">
              {reasonLabels[reason] || reason.replace(/_/g, " ")}
              <span className="rounded-full bg-red-500/20 px-1.5 text-[10px] tabular-nums">{n}</span>
            </span>
          ))}
        </div>
      )}

      {error && <ErrorBanner message={error} />}
      {loading && !data ? <Loading /> : (
        <TableShell headers={["When", "Identity", "Plane", "Outcome", "Environment", "IP"]} empty={data?.rows.length === 0}>
          {data?.rows.map((r) => (
            <tr key={r.id} className="transition-colors hover:bg-white/[0.03] light:hover:bg-slate-100/60">
              <Td className="text-xs tabular-nums text-slate-500">{fmtDateTime(r.createdAt)}</Td>
              <Td>
                <span className="text-sm text-white light:text-slate-900">{r.userName || r.email || "—"}</span>
                <span className="block text-xs text-slate-500">{r.email}{r.vendorName ? ` · ${r.vendorName}` : r.role ? ` · ${r.role.toLowerCase()}` : ""}</span>
              </Td>
              <Td>
                <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-bold tracking-wide",
                  r.plane === "OWNER"
                    ? "border-indigo-400/30 bg-indigo-500/10 text-indigo-300 light:text-indigo-700"
                    : "border-teal-400/30 bg-teal-500/10 text-teal-300 light:text-teal-700")}>
                  {r.plane === "OWNER" ? "OWNER" : "TENANT"}
                </span>
              </Td>
              <Td>
                {r.success ? (
                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-300 light:text-emerald-700">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Success{r.mfaUsed ? " · MFA" : ""}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-300 light:text-red-600">
                    <XCircle className="h-3.5 w-3.5" /> {reasonLabels[r.failureReason || ""] || r.failureReason || "Failed"}
                  </span>
                )}
              </Td>
              <Td className="text-xs">
                <span className="inline-flex items-center gap-1.5 text-slate-300 light:text-slate-700">
                  {deviceIcon(r.deviceType)}
                  <span className="text-slate-400 light:text-slate-600">{r.browser || "unknown browser"} · {r.os || "unknown OS"}</span>
                </span>
                {r.userAgent && (
                  <span className="block max-w-[280px] truncate text-[10px] text-slate-600" title={r.userAgent}>{r.userAgent}</span>
                )}
              </Td>
              <Td className="font-mono text-xs tabular-nums text-slate-400 light:text-slate-600">{r.ip || "—"}</Td>
            </tr>
          ))}
        </TableShell>
      )}

      {data && data.total > data.pageSize && (
        <div className="flex items-center justify-center gap-3">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}
            className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-white light:text-slate-900">
            Previous
          </Button>
          <span className="text-xs text-slate-500">page {page} / {maxPage}</span>
          <Button variant="outline" size="sm" disabled={page >= maxPage} onClick={() => setPage((p) => p + 1)}
            className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-white light:text-slate-900">
            Next
          </Button>
        </div>
      )}
    </div>
  )
}
