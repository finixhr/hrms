"use client"
// ============ /owner/support — the Support desk console (3 tabs) ============
// The support team's single control room:
//   TAB 1 "Support Tickets" (new) — the ticket queue:
//     - KPI strip from owner.supportTickets.overview (queue health)
//     - filterable/searchable queue (status chips · priority · search · pages)
//     - conversation panel: TENANT/SUPPORT bubbles (internal notes visually
//       distinct, amber), attachments as signed-URL chips, reply composer
//       with the internal-note toggle, agent assign + status dropdowns,
//       15s visibility-gated poll on the open ticket.
//   TAB 2 "Live Support Requests" (new) — the privileged-access review queue
//     (Part B §4.1): tenant-submitted requests → module-subset approval with
//     minutes/access-mode/agent → the ONE-TIME activation link dialog
//     (single-use, bound to the agent's owner session, 10-minute window) or
//     rejection with a reason. ACTIVE rows get the session card with
//     countdown, End Session and the master-prompt §5 RE-ENTRY link.
//   TAB 3 "Support Access" (Wave 10, kept) — the operator-initiated control
//     room: KPIs, start-session form (one-time enter link), live board w/
//     15s poll + countdown, session history, platform policy editor. Every
//     ACTIVE row now also carries the §5 re-entry anchor.
//
// RE-ENTRY (master prompt §5) needs NO RPC: a plain anchor to
// /api/support-access/resume?session=<id> — the endpoint authenticates the
// operator's owner session server-side, validates status/expiry/binding,
// rotates the token and redirects into the tenant workspace. We render it
// for EVERY ACTIVE session; the server denies other operators with a clear
// message (by design — we can't know our own ownerId client-side).
//
// All enforcement is server-side (owner.supportTickets.* / owner.supportLive.*
// need support.view; approvals/rejections additionally support.manage;
// owner.supportAccess.* needs support.access) — this UI is convenience only.
import { useCallback, useEffect, useRef, useState } from "react"
import {
  CheckCircle2, ChevronLeft, ChevronRight, Clock, Copy, ExternalLink, History, Inbox,
  LifeBuoy, Loader2, Lock, MessagesSquare, Paperclip, PlayCircle, RefreshCw, Search,
  Send, Settings2, ShieldAlert, ShieldCheck, ShieldOff, StopCircle, StickyNote, Timer,
  UserCheck, X, XCircle,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useOwnerApi, ownerRpc } from "@/saas/owner/client"
import { ErrorBanner, Glass, KpiCard, Loading, PageHeader, StatusChip, TableShell, Td, fmtDateTime } from "@/saas/owner/ui"
import { cn } from "@/lib/utils"

// ---------------- shared types ----------------

type Policy = {
  enabled: boolean
  defaultMinutes: number
  maxMinutes: number
  requireTicketForWrite: boolean
  maxConcurrentActive: number
}
type Overview = { active: number; startedLast24h: number; sessionsCreatedLast24h: number; deniedLast24h: number }
type ActiveSession = {
  id: string; targetVendorId: string; targetVendorName: string; operatorOwnerId: string
  operatorName: string; accessMode: "READ_ONLY" | "CONTROLLED_WRITE"; reason: string; ticketRef: string | null
  startedAt: string | null; expiresAt: string | null; lastSeenAt: string | null; ip: string | null
  remainingSeconds: number; mine: boolean
}
type HistoryRow = {
  id: string; targetVendorName: string; operatorName: string; accessMode: string; status: string
  reason: string; ticketRef: string | null; scope: string[]; requestedMinutes: number
  startedAt: string | null; endedAt: string | null; endedReason: string | null; endedByName: string | null
  ip: string | null; createdAt: string
}
type StartResult = { sessionId: string; enterUrl: string; expiresAt: string }

type TicketStatus = "OPEN" | "ASSIGNED" | "IN_PROGRESS" | "WAITING_TENANT" | "WAITING_SUPPORT" | "RESOLVED" | "CLOSED"
const TICKET_STATUSES: TicketStatus[] = ["OPEN", "ASSIGNED", "IN_PROGRESS", "WAITING_TENANT", "WAITING_SUPPORT", "RESOLVED", "CLOSED"]

type TicketOverview = {
  open: number; assigned: number; inProgress: number; waitingTenant: number; waitingSupport: number
  resolvedToday: number; livePending: number; liveActive: number; unassigned: number; totalOpenWork: number
}
type TicketRow = {
  id: string; number: string; vendorId: string; subject: string; category: string
  priority: string; status: string; requesterName: string; assigneeName: string | null
  assigneeOwnerId: string | null; lastMessageAt: string | null; firstResponseAt: string | null
  createdAt: string; closedAt: string | null
}
type TicketListResult = { rows: TicketRow[]; total: number; page: number; take: number }
type TicketAttachment = { objectKey: string; fileName: string; mimeType: string; sizeBytes: number; uploadedBy: string; url: string | null }
type TicketMessage = {
  id: string; authorRole: "TENANT" | "SUPPORT"; authorName: string; body: string
  internalNote: boolean; createdAt: string; attachments: TicketAttachment[]
}
type TicketDetail = {
  ticket: {
    id: string; number: string; subject: string; category: string; priority: string; status: string
    vendorId: string; vendorName: string; vendorCode: string | null; requesterName: string
    assigneeName: string | null; assigneeOwnerId: string | null; firstResponseAt: string | null
    createdAt: string; closedAt: string | null; closedByName: string | null
  }
  messages: TicketMessage[]
}

type LiveSessionInfo = {
  id: string; status: string; accessMode: "READ_ONLY" | "CONTROLLED_WRITE"
  operatorName: string | null; operatorOwnerId: string; modules: string[]
  startedAt: string | null; expiresAt: string | null; enterPending: boolean; endedReason: string | null
}
type LiveRequestRow = {
  id: string; title: string; description: string; category: string; modules: string[]
  priority: string; status: string; contextNote: string | null; ticketId: string | null
  vendorId: string; vendorName: string; vendorCode: string | null
  requestedByName: string; requestedAt: string
  reviewedByName: string | null; reviewedAt: string | null; reviewNote: string | null
  approvedModules: string[] | null; approvedMinutes: number | null
  approvedAgentName: string | null; approvedAgentOwnerId: string | null
  session: LiveSessionInfo | null
}
type LiveListResult = { rows: LiveRequestRow[]; total: number; page: number; take: number }
type ApproveResult = { sessionId: string; enterUrl: string; activationExpiresAt: string }
type ActivationLink = { requestId: string; enterUrl: string; activationExpiresAt: string }

type OwnerUser = { id: string; email: string; name: string; roleKey: string; roleLabel: string; status: string }

type OverviewApi = { data: TicketOverview | null; loading: boolean; error: string | null; reload: () => Promise<void> }

const inputCls = "h-10 border-white/10 light:border-slate-300 bg-white/5 light:bg-white light:text-slate-900"

// ---------------- shared helpers ----------------

/** The master-prompt §5 re-entry URL — a plain link, no RPC, no stored token. */
function resumeUrl(sessionId: string): string {
  return `/api/support-access/resume?session=${sessionId}`
}
function absoluteUrl(path: string): string {
  if (typeof window === "undefined") return path
  return new URL(path, window.location.origin).href
}
function mmss(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
function modLabel(m: string): string {
  return m.replace(/_/g, " ")
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement("textarea")
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand("copy")
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }
}

/** Inline toast (the P2 billing discipline — zero browser alerts). */
function Toast({ tone, children }: { tone: "ok" | "err"; children: React.ReactNode }) {
  return (
    <div className={cn("flex items-start gap-2 rounded-xl border p-3 text-sm",
      tone === "ok"
        ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-200 light:text-emerald-700"
        : "border-rose-400/40 bg-rose-500/10 text-rose-200 light:text-rose-700")} role="status">
      {tone === "ok" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
      <span className="whitespace-pre-wrap">{children}</span>
    </div>
  )
}
function useConsoleToast() {
  const [toast, setToast] = useState<{ tone: "ok" | "err"; text: string } | null>(null)
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 6_000)
    return () => clearTimeout(t)
  }, [toast])
  const notify = useCallback((tone: "ok" | "err", text: string) => setToast({ tone, text }), [])
  const node = toast ? <Toast tone={toast.tone}>{toast.text}</Toast> : null
  return { notify, node }
}

/** Owner users for the agent pickers (users.view; filtered to ACTIVE client-side). */
function useOwnerUsers() {
  const [users, setUsers] = useState<OwnerUser[]>([])
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    ownerRpc<{ users: OwnerUser[] }>("owner.users.list", {})
      .then((r) => { if (alive) setUsers((r.users || []).filter((u) => u.status === "ACTIVE")) })
      .catch((e) => { if (alive) setErr(e?.message || "Could not load the owner user list") })
    return () => { alive = false }
  }, [])
  return { users, err }
}

function CopyBtn({ text, label = "Copy link", className }: { text: string; label?: string; className?: string }) {
  const [ok, setOk] = useState(false)
  return (
    <Button size="sm" variant="outline" className={className}
      onClick={async () => {
        const done = await copyText(text)
        setOk(done)
        if (done) setTimeout(() => setOk(false), 1_500)
      }}>
      {ok ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
      {ok ? "Copied" : label}
    </Button>
  )
}

/**
 * Master prompt §5 — the re-entry anchor for an ACTIVE session. A PLAIN link
 * (never a fetch): the endpoint authenticates the operator's owner session
 * server-side, validates status/expiry/operator binding, rotates the token
 * and redirects into the tenant workspace.
 */
function ReEnterButton({ sessionId, label, className }: { sessionId: string; label: string; className?: string }) {
  return (
    <Button asChild size="sm" className={cn("bg-gradient-to-r from-emerald-500 to-teal-500 text-white hover:opacity-90", className)}>
      <a href={`/api/support-access/resume?session=${sessionId}`} target="_blank" rel="noopener">
        <ExternalLink className="h-3.5 w-3.5" /> {label}
      </a>
    </Button>
  )
}

// ---------------- chips ----------------

const chipBase = "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest"
const TICKET_STATUS_TONE: Record<string, string> = {
  OPEN: "border-blue-400/40 bg-blue-500/10 text-blue-300 light:text-blue-700",
  ASSIGNED: "border-indigo-400/40 bg-indigo-500/10 text-indigo-300 light:text-indigo-700",
  IN_PROGRESS: "border-violet-400/40 bg-violet-500/10 text-violet-300 light:text-violet-700",
  WAITING_TENANT: "border-amber-400/40 bg-amber-500/10 text-amber-300 light:text-amber-700",
  WAITING_SUPPORT: "border-cyan-400/40 bg-cyan-500/10 text-cyan-300 light:text-cyan-700",
  RESOLVED: "border-emerald-400/40 bg-emerald-500/10 text-emerald-300 light:text-emerald-700",
  CLOSED: "border-slate-400/40 bg-slate-500/10 light:bg-slate-200 text-slate-400 light:text-slate-600",
}
const LIVE_STATUS_TONE: Record<string, string> = {
  PENDING_REVIEW: "border-amber-400/40 bg-amber-500/10 text-amber-300 light:text-amber-700",
  APPROVED: "border-blue-400/40 bg-blue-500/10 text-blue-300 light:text-blue-700",
  ACTIVE: "border-emerald-400/40 bg-emerald-500/10 text-emerald-300 light:text-emerald-700",
  COMPLETED: "border-slate-400/40 bg-slate-500/10 light:bg-slate-200 text-slate-400 light:text-slate-600",
  CANCELLED: "border-slate-400/40 bg-slate-500/10 light:bg-slate-200 text-slate-400 light:text-slate-600",
  REJECTED: "border-rose-400/40 bg-rose-500/10 text-rose-300 light:text-rose-600",
  REVOKED: "border-rose-400/40 bg-rose-500/10 text-rose-300 light:text-rose-600",
  EXPIRED: "border-rose-400/40 bg-rose-500/10 text-rose-300 light:text-rose-600",
}
const PRIORITY_TONE: Record<string, string> = {
  LOW: "border-slate-400/40 bg-slate-500/10 text-slate-400 light:text-slate-600",
  NORMAL: "border-sky-400/40 bg-sky-500/10 text-sky-300 light:text-sky-700",
  HIGH: "border-amber-400/40 bg-amber-500/10 text-amber-300 light:text-amber-700",
  URGENT: "border-rose-400/40 bg-rose-500/10 text-rose-300 light:text-rose-600",
}
function TicketStatusChip({ status }: { status: string }) {
  return <span className={cn(chipBase, TICKET_STATUS_TONE[status] || "border-slate-400/40 bg-slate-500/10 text-slate-300 light:text-slate-700")}>{status.replace(/_/g, " ")}</span>
}
function LiveStatusChip({ status }: { status: string }) {
  return <span className={cn(chipBase, LIVE_STATUS_TONE[status] || "border-slate-400/40 bg-slate-500/10 text-slate-300 light:text-slate-700")}>{status.replace(/_/g, " ")}</span>
}
function PriorityChip({ p }: { p: string }) {
  return <span className={cn(chipBase, PRIORITY_TONE[p] || "border-slate-400/40 bg-slate-500/10 text-slate-300 light:text-slate-700")}>{p}</span>
}

// =====================================================================
// PAGE SHELL — 3 tabs
// =====================================================================

const TABS = [
  { key: "tickets", label: "Support Tickets", icon: MessagesSquare },
  { key: "live", label: "Live Support Requests", icon: LifeBuoy },
  { key: "access", label: "Support Access", icon: ShieldCheck },
] as const
type TabKey = (typeof TABS)[number]["key"]

export default function SupportPage() {
  const [tab, setTab] = useState<TabKey>("tickets")
  // queue-health overview feeds the tab badges + both new tabs (support.view)
  const tkOverview = useOwnerApi<TicketOverview>("owner.supportTickets.overview", {})

  return (
    <div className="space-y-5">
      <PageHeader
        title="Support"
        sub="The support desk: the ticket queue with live conversations, the privileged Live Support Access review flow (approve a module subset → one-time activation link → audited session), and the operator-initiated control room. Every approval, reply and session transition lands in the platform audit log."
      />

      {/* ---- tab bar ---- */}
      <div className="-mx-1 overflow-x-auto scroll-thin px-1 pb-1" role="tablist" aria-label="Support sections">
        <div className="flex min-w-max gap-1.5">
          {TABS.map((t) => {
            const badge =
              t.key === "tickets" ? tkOverview.data?.totalOpenWork
              : t.key === "live" ? tkOverview.data?.livePending
              : undefined
            return (
              <button
                key={t.key} role="tab" aria-selected={tab === t.key} type="button" onClick={() => setTab(t.key)}
                className={cn("flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3.5 py-2 text-[12px] font-semibold transition-colors",
                  tab === t.key
                    ? "bg-gradient-to-r from-emerald-500 to-teal-600 text-white shadow-lg shadow-emerald-950/40"
                    : "border border-white/10 light:border-slate-200 text-slate-400 light:text-slate-600 hover:bg-white/5 light:hover:bg-slate-100 hover:text-white light:hover:text-slate-900")}>
                <t.icon className="h-3.5 w-3.5" /> {t.label}
                {typeof badge === "number" && badge > 0 && (
                  <span className="rounded-full bg-white/25 px-1.5 py-0.5 text-[10px] font-bold leading-none tabular-nums">{badge}</span>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {tab === "tickets" && <SupportTicketsTab overview={tkOverview} />}
      {tab === "live" && <LiveRequestsTab overview={tkOverview} />}
      {tab === "access" && <SupportAccessTab />}
    </div>
  )
}

// =====================================================================
// TAB 1 — Support Tickets
// =====================================================================

const TICKET_PAGE_SIZE = 15
const TICKET_STATUS_CHIPS: { key: string; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "OPEN", label: "Open" },
  { key: "ASSIGNED", label: "Assigned" },
  { key: "IN_PROGRESS", label: "In progress" },
  { key: "WAITING_TENANT", label: "Waiting tenant" },
  { key: "WAITING_SUPPORT", label: "Waiting us" },
  { key: "RESOLVED", label: "Resolved" },
  { key: "CLOSED", label: "Closed" },
]
const PRIORITIES = ["ALL", "LOW", "NORMAL", "HIGH", "URGENT"]

function SupportTicketsTab({ overview }: { overview: OverviewApi }) {
  const { users, err: usersErr } = useOwnerUsers()
  const { notify, node: toastNode } = useConsoleToast()

  const [status, setStatus] = useState("ALL")
  const [priority, setPriority] = useState("ALL")
  const [search, setSearch] = useState("")
  const [query, setQuery] = useState("")
  const [page, setPage] = useState(1)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // debounce the search box → server query (subject / #number / requester)
  useEffect(() => {
    const t = setTimeout(() => { setQuery(search.trim()); setPage(1) }, 300)
    return () => clearTimeout(t)
  }, [search])

  const listQ = useOwnerApi<TicketListResult>(
    "owner.supportTickets.list",
    { status, priority, search: query || undefined, page, take: TICKET_PAGE_SIZE },
    [status, priority, query, page],
  )

  const reloadList = listQ.reload
  const reloadOverview = overview.reload
  const reloadAll = useCallback(() => {
    void reloadList()
    void reloadOverview()
  }, [reloadList, reloadOverview])

  if (overview.loading && !overview.data) return <Loading label="Loading the ticket queue…" />
  if (overview.error) return <ErrorBanner message={overview.error} />

  const ov = overview.data ?? {
    open: 0, assigned: 0, inProgress: 0, waitingTenant: 0, waitingSupport: 0,
    resolvedToday: 0, livePending: 0, liveActive: 0, unassigned: 0, totalOpenWork: 0,
  }
  const rows = listQ.data?.rows ?? []
  const total = listQ.data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / TICKET_PAGE_SIZE))

  return (
    <div className="space-y-4">
      {toastNode}

      {/* ---- queue-health KPIs (owner.supportTickets.overview) ---- */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="Open work" value={ov.totalOpenWork} icon={Inbox} tone="indigo" sub="open + assigned + in progress + waiting us" />
        <KpiCard label="Unassigned" value={ov.unassigned} icon={UserCheck} tone={ov.unassigned > 0 ? "amber" : "default"} sub="open or waiting us, no agent" />
        <KpiCard label="Waiting us" value={ov.waitingSupport} icon={Clock} />
        <KpiCard label="Waiting tenant" value={ov.waitingTenant} icon={Timer} />
        <KpiCard label="Resolved today" value={ov.resolvedToday} icon={CheckCircle2} tone="emerald" />
        <KpiCard label="Live requests" value={ov.livePending} icon={LifeBuoy} tone={ov.livePending > 0 ? "amber" : "default"} sub={`${ov.liveActive} active support session(s)`} />
      </div>

      <div className="grid gap-4 xl:grid-cols-5">
        {/* ---- queue ---- */}
        <Glass className="xl:col-span-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-bold text-white light:text-slate-900">Ticket queue</p>
            <div className="flex items-center gap-2">
              {listQ.loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-500" />}
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { void listQ.reload(); void overview.reload() }}>
                <RefreshCw className="h-3.5 w-3.5" /> Refresh
              </Button>
            </div>
          </div>
          <p className="mt-0.5 text-[11px] text-slate-500">
            {total} ticket{total === 1 ? "" : "s"}{query ? ` matching “${query}”` : ""} · page {page} of {pages}
          </p>

          {/* status chips */}
          <div className="-mx-1 mt-3 flex gap-1.5 overflow-x-auto px-1 pb-1">
            {TICKET_STATUS_CHIPS.map((c) => (
              <button key={c.key} type="button" aria-pressed={status === c.key}
                onClick={() => { setStatus(c.key); setPage(1) }}
                className={cn("whitespace-nowrap rounded-full border px-3 py-1 text-[11px] font-bold uppercase tracking-wider transition-colors",
                  status === c.key
                    ? "border-emerald-400/50 bg-emerald-500/15 text-emerald-300 light:text-emerald-700"
                    : "border-white/10 light:border-slate-200 text-slate-500 hover:text-slate-300 light:hover:text-slate-700")}>
                {c.label}
              </button>
            ))}
          </div>

          {/* search + priority */}
          <div className="mt-3 flex gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} className={`${inputCls} h-9 pl-9 text-xs`} placeholder="Search subject, #number, requester…" />
            </div>
            <Select value={priority} onValueChange={(v) => { setPriority(v); setPage(1) }}>
              <SelectTrigger className={`${inputCls} h-9 w-36 text-xs`}><SelectValue /></SelectTrigger>
              <SelectContent>
                {PRIORITIES.map((p) => <SelectItem key={p} value={p}>{p === "ALL" ? "Any priority" : p}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          {/* rows */}
          <div className="mt-3 space-y-2">
            {listQ.loading && !listQ.data ? (
              <div className="space-y-2">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="h-[74px] animate-pulse rounded-xl border border-white/5 bg-white/[0.03]" />
                ))}
              </div>
            ) : rows.length === 0 ? (
              <p className="rounded-lg border border-white/10 light:border-slate-200 p-6 text-center text-xs text-slate-500">
                No tickets match — try another filter or clear the search.
              </p>
            ) : (
              rows.map((r) => (
                <button key={r.id} type="button" onClick={() => setSelectedId(r.id)}
                  className={cn("w-full rounded-xl border p-3 text-left transition-colors",
                    selectedId === r.id
                      ? "border-emerald-400/40 bg-emerald-500/10"
                      : "border-white/10 light:border-slate-200 bg-white/[0.02] light:bg-slate-50 hover:bg-white/5 light:hover:bg-slate-100")}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-bold tabular-nums text-slate-500">#{r.number}</span>
                    <TicketStatusChip status={r.status} />
                  </div>
                  <p className="mt-1 truncate text-sm font-semibold text-white light:text-slate-900">{r.subject}</p>
                  <p className="mt-0.5 truncate text-[11px] text-slate-500">
                    {r.requesterName}{r.assigneeName ? ` · ${r.assigneeName}` : " · unassigned"} · {fmtDateTime(r.lastMessageAt || r.createdAt)}
                  </p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <PriorityChip p={r.priority} />
                    <span className="rounded-full border border-white/10 light:border-slate-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">{modLabel(r.category)}</span>
                  </div>
                </button>
              ))
            )}
          </div>

          {/* pagination */}
          <div className="mt-3 flex items-center justify-between">
            <span className="text-[11px] text-slate-500">page {page} / {pages}</span>
            <div className="flex gap-1.5">
              <Button size="sm" variant="outline" disabled={page <= 1 || listQ.loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                <ChevronLeft className="h-3.5 w-3.5" /> Prev
              </Button>
              <Button size="sm" variant="outline" disabled={page >= pages || listQ.loading} onClick={() => setPage((p) => p + 1)}>
                Next <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </Glass>

        {/* ---- conversation panel ---- */}
        <div className="xl:col-span-3">
          {selectedId ? (
            <TicketThread
              ticketId={selectedId}
              users={users}
              usersErr={usersErr}
              onChanged={reloadAll}
              onClose={() => setSelectedId(null)}
              notify={notify}
            />
          ) : (
            <Glass className="flex h-full min-h-64 flex-col items-center justify-center gap-2 p-8 text-center">
              <MessagesSquare className="h-8 w-8 text-slate-600" />
              <p className="text-sm font-semibold text-slate-400">Pick a ticket from the queue</p>
              <p className="max-w-sm text-xs leading-relaxed text-slate-500">
                The conversation loads with full history, attachments and the internal-note trail. Replies notify the tenant by email; internal notes never leave the support side. The open ticket re-polls every 15 seconds.
              </p>
            </Glass>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------- conversation panel ----------------

function TicketThread({ ticketId, users, usersErr, onChanged, onClose, notify }: {
  ticketId: string
  users: OwnerUser[]
  usersErr: string | null
  onChanged: () => void
  onClose: () => void
  notify: (tone: "ok" | "err", text: string) => void
}) {
  const [data, setData] = useState<TicketDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reply, setReply] = useState("")
  const [internalNote, setInternalNote] = useState(false)
  const [busy, setBusy] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const res = await ownerRpc<TicketDetail>("owner.supportTickets.get", { ticketId })
      setData(res)
      setError(null)
    } catch (e: any) {
      if (!silent) setError(e?.message || "Could not load the ticket")
    } finally {
      if (!silent) setLoading(false)
    }
  }, [ticketId])

  useEffect(() => { setData(null); setReply(""); setInternalNote(false); void load() }, [load])

  // 15s poll on the open ticket (visibility-gated — silent, never flashes skeletons)
  useEffect(() => {
    const poll = setInterval(() => {
      if (document.visibilityState !== "visible") return
      void load(true)
    }, 15_000)
    return () => clearInterval(poll)
  }, [load])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [data?.messages.length, loading])

  const sendReply = async () => {
    const msg = reply.trim()
    if (!msg || !data) return
    const wasNote = internalNote
    setBusy(true)
    try {
      await ownerRpc("owner.supportTickets.reply", { ticketId, message: msg, internalNote: wasNote })
      setReply(""); setInternalNote(false)
      await load(true)
      onChanged()
      notify("ok", wasNote ? "Internal note added — the tenant never sees it." : "Reply sent — the tenant was notified by email.")
    } catch (e: any) {
      notify("err", e?.message || "Could not send the reply.")
    } finally { setBusy(false) }
  }

  const assign = async (u: OwnerUser) => {
    setBusy(true)
    try {
      await ownerRpc("owner.supportTickets.assign", { ticketId, agentOwnerId: u.id, agentName: u.name })
      await load(true)
      onChanged()
      notify("ok", `Ticket assigned to ${u.name}.`)
    } catch (e: any) {
      notify("err", e?.message || "Could not assign the ticket.")
    } finally { setBusy(false) }
  }

  const changeStatus = async (s: string) => {
    if (!data) return
    const prev = data.ticket.status
    if (s === prev) return
    setBusy(true)
    try {
      await ownerRpc("owner.supportTickets.status", { ticketId, status: s })
      await load(true)
      onChanged()
      notify("ok", `Status: ${prev.replace(/_/g, " ")} → ${s.replace(/_/g, " ")}.`)
    } catch (e: any) {
      notify("err", e?.message || "Could not change the status.")
    } finally { setBusy(false) }
  }

  if (loading && !data) return <Glass className="flex min-h-64 items-center justify-center"><Loading label="Loading conversation…" /></Glass>
  if (error) return <Glass className="p-5"><ErrorBanner message={error} /></Glass>
  if (!data) return null
  const t = data.ticket

  return (
    <Glass className="flex h-full flex-col">
      {/* ---- thread header ---- */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-bold tabular-nums text-slate-500">#{t.number}</span>
            <TicketStatusChip status={t.status} />
            <PriorityChip p={t.priority} />
          </div>
          <p className="mt-1 truncate text-sm font-bold text-white light:text-slate-900">{t.subject}</p>
          <p className="mt-0.5 text-[11px] text-slate-500">
            {t.vendorName}{t.vendorCode ? ` (${t.vendorCode})` : ""} · {modLabel(t.category)} · requested by {t.requesterName}
          </p>
        </div>
        <Button size="icon-sm" variant="ghost" aria-label="Close conversation" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
        <span>opened {fmtDateTime(t.createdAt)}</span>
        <span>first response {fmtDateTime(t.firstResponseAt)}</span>
        <span>assignee {t.assigneeName || "—"}</span>
        {t.closedAt && <span className="text-slate-400">closed {fmtDateTime(t.closedAt)}{t.closedByName ? ` by ${t.closedByName}` : ""}</span>}
      </div>

      {/* ---- assign + status controls ---- */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Select value={t.assigneeOwnerId || ""} onValueChange={(v) => { const u = users.find((x) => x.id === v); if (u) void assign(u) }}>
          <SelectTrigger className={`${inputCls} h-8 w-56 text-xs`} disabled={users.length === 0}>
            <SelectValue placeholder={usersErr ? "Agent list unavailable…" : "Assign to agent…"} />
          </SelectTrigger>
          <SelectContent>
            {users.map((u) => <SelectItem key={u.id} value={u.id}>{u.name} · {u.roleLabel}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={t.status} onValueChange={(v) => void changeStatus(v)}>
          <SelectTrigger className={`${inputCls} h-8 w-44 text-xs`}><SelectValue /></SelectTrigger>
          <SelectContent>
            {TICKET_STATUSES.map((s) => <SelectItem key={s} value={s}>{s.replace(/_/g, " ")}</SelectItem>)}
          </SelectContent>
        </Select>
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-500" />}
        {usersErr && <span className="text-[11px] text-amber-300" title={usersErr}>agent picker needs the users.view permission</span>}
      </div>

      {/* ---- messages ---- */}
      <div ref={scrollRef} className="mt-3 min-h-56 flex-1 space-y-3 overflow-y-auto rounded-xl border border-white/5 light:border-slate-200 bg-black/10 light:bg-slate-50 p-3" style={{ maxHeight: 460 }}>
        {data.messages.length === 0 && (
          <p className="py-10 text-center text-xs text-slate-500">No messages yet — send the first reply.</p>
        )}
        {data.messages.map((m) => (
          <div key={m.id} className={cn("flex", m.authorRole === "SUPPORT" ? "justify-end" : "justify-start")}>
            <div className={cn("max-w-[85%] rounded-2xl border px-3.5 py-2.5",
              m.internalNote
                ? "border-amber-400/40 border-dashed bg-amber-500/10"
                : m.authorRole === "SUPPORT"
                  ? "border-emerald-400/30 bg-emerald-500/10"
                  : "border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100")}>
              <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
                <span className="font-semibold text-slate-400">{m.authorName}</span>
                <span>{m.authorRole === "SUPPORT" ? "· Finix support" : "· tenant"}</span>
                <span>· {fmtDateTime(m.createdAt)}</span>
              </div>
              {m.internalNote && (
                <p className="mb-1 inline-flex items-center gap-1 rounded-full border border-amber-400/40 bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-amber-300 light:text-amber-700">
                  <StickyNote className="h-3 w-3" /> Internal note
                </p>
              )}
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-200 light:text-slate-800">{m.body}</p>
              {m.attachments.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {m.attachments.map((a) => a.url ? (
                    <a key={a.objectKey} href={a.url} target="_blank" rel="noopener"
                      className="inline-flex items-center gap-1 rounded-lg border border-white/10 light:border-slate-300 bg-white/5 light:bg-white px-2 py-1 text-[11px] text-slate-300 light:text-slate-700 hover:border-emerald-400/40 hover:text-emerald-300 light:hover:text-emerald-700">
                      <Paperclip className="h-3 w-3" /> {a.fileName}
                      <span className="text-slate-500">{fmtBytes(a.sizeBytes)}</span>
                    </a>
                  ) : (
                    <span key={a.objectKey} className="inline-flex items-center gap-1 rounded-lg border border-white/10 light:border-slate-200 px-2 py-1 text-[11px] text-slate-500">
                      <Paperclip className="h-3 w-3" /> {a.fileName} <span className="text-slate-600">(link unavailable)</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* ---- composer ---- */}
      <div className="mt-3 space-y-2">
        {t.status === "CLOSED" ? (
          <p className="rounded-lg border border-white/10 light:border-slate-200 bg-white/[0.02] light:bg-slate-50 p-3 text-xs text-slate-400">
            <Lock className="mr-1 inline h-3 w-3" />
            This ticket is closed{t.closedByName ? ` by ${t.closedByName}` : ""} — set the status back (e.g. OPEN or IN_PROGRESS) to reopen it before replying.
          </p>
        ) : (
          <>
            <Textarea
              value={reply} maxLength={5000}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void sendReply() } }}
              className={`${inputCls} min-h-20 text-sm`}
              placeholder={internalNote ? "Internal note — support only, never sent to the tenant…" : "Reply to the tenant… (Ctrl/⌘+Enter to send)"} />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="flex cursor-pointer items-center gap-2 text-[11px] text-slate-400">
                <input type="checkbox" checked={internalNote} onChange={(e) => setInternalNote(e.target.checked)} className="accent-amber-500" />
                <StickyNote className="h-3.5 w-3.5 text-amber-400" /> Internal note — visible to support only
              </label>
              <div className="flex items-center gap-2">
                <span className="text-[11px] tabular-nums text-slate-600">{reply.length}/5000</span>
                <Button size="sm" disabled={busy || !reply.trim()} onClick={() => void sendReply()}
                  className={internalNote ? "border border-amber-400/40 bg-amber-500/15 text-amber-200 light:text-amber-700 hover:bg-amber-500/25" : "bg-gradient-to-r from-emerald-500 to-teal-500 text-white"}>
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                  {internalNote ? "Add note" : "Send reply"}
                </Button>
              </div>
            </div>
            <p className="text-[11px] leading-relaxed text-slate-500">
              Public replies move the ticket to “Waiting tenant” and email the tenant admins; internal notes never reach the tenant and never change the status. The first public reply records the first-response timestamp.
            </p>
          </>
        )}
      </div>
    </Glass>
  )
}

// =====================================================================
// TAB 2 — Live Support Requests (privileged-access review queue)
// =====================================================================

const LIVE_PAGE_SIZE = 10
const LIVE_STATUS_CHIPS: { key: string; label: string }[] = [
  { key: "PENDING_REVIEW", label: "Pending review" },
  { key: "ALL", label: "All" },
  { key: "APPROVED", label: "Approved" },
  { key: "ACTIVE", label: "Active" },
  { key: "COMPLETED", label: "Completed" },
  { key: "REJECTED", label: "Rejected" },
  { key: "REVOKED", label: "Revoked" },
  { key: "EXPIRED", label: "Expired" },
  { key: "CANCELLED", label: "Cancelled" },
]

function LiveRequestsTab({ overview }: { overview: OverviewApi }) {
  const { users, err: usersErr } = useOwnerUsers()
  const { notify, node: toastNode } = useConsoleToast()

  const [status, setStatus] = useState("PENDING_REVIEW")
  const [page, setPage] = useState(1)
  const reqQ = useOwnerApi<LiveListResult>("owner.supportLive.requests", { status, page, take: LIVE_PAGE_SIZE }, [status, page])

  const [selectedId, setSelectedId] = useState<string | null>(null)
  // review form (PENDING_REVIEW)
  const [approvedMods, setApprovedMods] = useState<string[]>([])
  const [minutes, setMinutes] = useState<number | null>(15)
  const [accessMode, setAccessMode] = useState<"READ_ONLY" | "CONTROLLED_WRITE">("READ_ONLY")
  const [agentId, setAgentId] = useState("")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  // the ONE-TIME activation link — kept in memory only until the tab unmounts
  const [activation, setActivation] = useState<ActivationLink | null>(null)

  const rows = reqQ.data?.rows ?? []
  const selected = rows.find((r) => r.id === selectedId) ?? null
  const agent = users.find((u) => u.id === agentId) ?? null
  const total = reqQ.data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / LIVE_PAGE_SIZE))

  const reloadRequests = reqQ.reload
  const reloadOverview = overview.reload
  const reloadAll = useCallback(() => {
    void reloadRequests()
    void reloadOverview()
  }, [reloadRequests, reloadOverview])

  // 60 s auto-refresh keeps the queue + selected row fresh (console rhythm)
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState !== "visible") return
      void reloadRequests()
    }, 60_000)
    return () => clearInterval(t)
  }, [reloadRequests])

  // reset the review form whenever another request is selected for review
  useEffect(() => {
    if (!selected || selected.status !== "PENDING_REVIEW") return
    setApprovedMods(selected.modules) // default: the full requested set — the reviewer narrows it
    setMinutes(15)
    setAccessMode("READ_ONLY")
    setAgentId("")
    setNote("")
  }, [selectedId, selected?.status])

  const approve = async () => {
    if (!selected) return
    if (approvedMods.length === 0) {
      notify("err", "Select at least one module — the approved set must be a subset of the requested modules.")
      return
    }
    if (!agent) {
      notify("err", "Pick the support agent who will receive the one-time activation link.")
      return
    }
    setBusy(true)
    try {
      const res = await ownerRpc<ApproveResult>("owner.supportLive.approve", {
        requestId: selected.id,
        modules: approvedMods,
        ...(minutes != null ? { minutes } : {}),
        accessMode,
        agentOwnerId: agent.id,
        agentName: agent.name,
        ...(note.trim() ? { note: note.trim() } : {}),
      })
      setActivation({ requestId: selected.id, enterUrl: res.enterUrl, activationExpiresAt: res.activationExpiresAt })
      notify("ok", `Approved — ${agent.name} received a one-time activation link (10-minute window) and an in-app notification.`)
      reloadAll()
    } catch (e: any) {
      notify("err", e?.message || "Approval failed — the support.manage permission is required.")
    } finally { setBusy(false) }
  }

  const reject = async () => {
    if (!selected) return
    if (note.trim().length < 5) {
      notify("err", "A rejection reason (min 5 chars) is required — the tenant sees it in their request history.")
      return
    }
    setBusy(true)
    try {
      await ownerRpc("owner.supportLive.reject", { requestId: selected.id, reason: note.trim() })
      notify("ok", "Rejected — the tenant sees the decision note in their Support Center.")
      setSelectedId(null)
      setNote("")
      reloadAll()
    } catch (e: any) {
      notify("err", e?.message || "Rejection failed — the support.manage permission is required.")
    } finally { setBusy(false) }
  }

  if (reqQ.loading && !reqQ.data) return <Loading label="Loading live-support requests…" />
  if (reqQ.error) return <ErrorBanner message={reqQ.error} />

  const ov = overview.data

  return (
    <div className="space-y-4">
      {toastNode}

      {/* ---- strip ---- */}
      <div className="grid gap-3 sm:grid-cols-3">
        <KpiCard label="Pending review" value={ov?.livePending ?? 0} icon={ShieldAlert} tone={(ov?.livePending ?? 0) > 0 ? "amber" : "default"} sub="tenant-submitted requests awaiting a decision" />
        <KpiCard label="Active sessions" value={ov?.liveActive ?? 0} icon={PlayCircle} tone="emerald" sub="privileged sessions running now" />
        <KpiCard label="Requests listed" value={total} icon={LifeBuoy} sub={`page ${page} of ${pages} · ${status === "ALL" ? "any status" : status.replace(/_/g, " ").toLowerCase()}`} />
      </div>

      {/* ---- queue ---- */}
      <Glass>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-bold text-white light:text-slate-900">Live Support request queue</p>
          <div className="flex items-center gap-2">
            {reqQ.loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-500" />}
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={reloadAll}><RefreshCw className="h-3.5 w-3.5" /> Refresh</Button>
          </div>
        </div>

        <div className="-mx-1 mt-3 flex gap-1.5 overflow-x-auto px-1 pb-1">
          {LIVE_STATUS_CHIPS.map((c) => (
            <button key={c.key} type="button" aria-pressed={status === c.key}
              onClick={() => { setStatus(c.key); setPage(1) }}
              className={cn("whitespace-nowrap rounded-full border px-3 py-1 text-[11px] font-bold uppercase tracking-wider transition-colors",
                status === c.key
                  ? "border-amber-400/50 bg-amber-500/15 text-amber-300 light:text-amber-700"
                  : "border-white/10 light:border-slate-200 text-slate-500 hover:text-slate-300 light:hover:text-slate-700")}>
              {c.label}
            </button>
          ))}
        </div>

        <div className="mt-3">
          <TableShell headers={["Request", "Vendor", "Priority", "Status", "Requested", "Session", ""]} empty={rows.length === 0}>
            {rows.map((r) => (
              <tr key={r.id}
                className={cn("cursor-pointer border-b border-white/5 light:border-slate-100 transition-colors hover:bg-white/[0.03] light:hover:bg-slate-100",
                  selectedId === r.id && "bg-emerald-500/5")}
                onClick={() => setSelectedId(r.id)}>
                <Td className="max-w-64 text-xs font-medium">
                  <span className="block truncate">{r.title}</span>
                  <span className="block truncate text-[11px] text-slate-500">{modLabel(r.category)} · {r.modules.length} module{r.modules.length === 1 ? "" : "s"}{r.ticketId ? " · linked ticket" : ""}</span>
                </Td>
                <Td className="text-xs">
                  <span className="block truncate">{r.vendorName}</span>
                  <span className="block text-[11px] text-slate-500">{r.vendorCode || r.vendorId}</span>
                </Td>
                <Td><PriorityChip p={r.priority} /></Td>
                <Td><LiveStatusChip status={r.status} /></Td>
                <Td className="text-xs">
                  <span className="block">{r.requestedByName}</span>
                  <span className="block text-[11px] text-slate-500">{fmtDateTime(r.requestedAt)}</span>
                </Td>
                <Td className="text-xs">
                  {r.session ? (
                    <>
                      <StatusChip status={r.session.status} />
                      {r.session.enterPending && <span className="ml-1.5 text-[10px] font-bold uppercase tracking-wider text-amber-400">enter pending</span>}
                    </>
                  ) : "—"}
                </Td>
                <Td>
                  <Button size="sm" variant="outline" className="h-7 text-xs"
                    onClick={(e) => { e.stopPropagation(); setSelectedId(r.id) }}>
                    {r.status === "PENDING_REVIEW" ? "Review" : "View"}
                  </Button>
                </Td>
              </tr>
            ))}
          </TableShell>
        </div>

        <div className="mt-3 flex items-center justify-between">
          <span className="text-[11px] text-slate-500">page {page} / {pages}</span>
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" disabled={page <= 1 || reqQ.loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              <ChevronLeft className="h-3.5 w-3.5" /> Prev
            </Button>
            <Button size="sm" variant="outline" disabled={page >= pages || reqQ.loading} onClick={() => setPage((p) => p + 1)}>
              Next <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </Glass>

      {/* ---- selected request: review / status panel ---- */}
      {selected ? (
        <Glass className="p-5">
          <div className="grid gap-5 xl:grid-cols-2">
            <RequestSummary r={selected} />
            <div>
              {selected.status === "PENDING_REVIEW" && (
                <div className="space-y-3">
                  <p className="text-xs font-bold uppercase tracking-widest text-amber-400">Review — approve scoped access or reject</p>
                  <div>
                    <Label className="text-xs text-slate-400">Approved modules (subset of requested)</Label>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {selected.modules.map((m) => (
                        <label key={m} className={cn("flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors",
                          approvedMods.includes(m)
                            ? "border-emerald-400/50 bg-emerald-500/15 text-emerald-200 light:text-emerald-700"
                            : "border-white/10 light:border-slate-200 text-slate-500")}>
                          <input type="checkbox" className="accent-emerald-500" checked={approvedMods.includes(m)}
                            onChange={(e) => setApprovedMods((s) => e.target.checked ? [...s, m] : s.filter((x) => x !== m))} />
                          {modLabel(m)}
                        </label>
                      ))}
                    </div>
                    <p className="mt-1 text-[11px] text-slate-500">
                      {approvedMods.length}/{selected.modules.length} modules — approval can only narrow the request, never widen it.
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs text-slate-400">Minutes (5–240 · empty = policy default)</Label>
                      <Input type="number" min={5} max={240} value={minutes ?? ""}
                        onChange={(e) => setMinutes(e.target.value === "" ? null : Number(e.target.value))} className={inputCls} />
                    </div>
                    <div>
                      <Label className="text-xs text-slate-400">Access mode</Label>
                      <Select value={accessMode} onValueChange={(v) => setAccessMode(v as "READ_ONLY" | "CONTROLLED_WRITE")}>
                        <SelectTrigger className={inputCls}><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="READ_ONLY">Read-only (default)</SelectItem>
                          <SelectItem value="CONTROLLED_WRITE">Controlled write</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div>
                    <Label className="text-xs text-slate-400">Support agent — receives the one-time activation link</Label>
                    <Select value={agentId} onValueChange={setAgentId}>
                      <SelectTrigger className={inputCls}>
                        <SelectValue placeholder={users.length === 0 ? (usersErr ? "Agent list unavailable…" : "Loading agents…") : "Pick an agent…"} />
                      </SelectTrigger>
                      <SelectContent>
                        {users.map((u) => <SelectItem key={u.id} value={u.id}>{u.name} · {u.roleLabel}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    {usersErr && <p className="mt-1 text-[11px] text-amber-300">Owner user list unavailable ({usersErr}) — the agent picker needs the users.view permission.</p>}
                  </div>
                  <div>
                    <Label className="text-xs text-slate-400">Review note — optional for approval · required as the rejection reason</Label>
                    <Textarea value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)}
                      className={`${inputCls} min-h-16 text-xs`}
                      placeholder="e.g. Approved read-only for the attendance module only — payroll stays off-limits." />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button disabled={busy} onClick={() => void approve()} className="bg-gradient-to-r from-emerald-500 to-teal-500 text-white">
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Approve & mint activation link
                    </Button>
                    <Button disabled={busy} variant="outline" className="border-rose-400/30 text-rose-300 hover:bg-rose-500/10" onClick={() => void reject()}>
                      <XCircle className="h-4 w-4" /> Reject
                    </Button>
                  </div>
                  <p className="text-[11px] leading-relaxed text-slate-500">
                    Approving needs the support.manage permission; controlled write additionally binds the agent to it. The activation link is single-use, bound to the agent&apos;s signed-in owner session and expires in 10 minutes. The tenant sees the approved modules, minutes and agent in their Support Center.
                  </p>
                </div>
              )}

              {selected.status === "APPROVED" && (
                <div className="space-y-3">
                  <div className="rounded-xl border border-white/10 light:border-slate-200 bg-white/[0.02] light:bg-slate-50 p-3">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Approval</p>
                    <p className="mt-1 text-xs text-slate-300 light:text-slate-700">
                      {selected.approvedAgentName || "—"} · {selected.approvedMinutes ?? "—"} min
                      {selected.session ? ` · ${selected.session.accessMode === "CONTROLLED_WRITE" ? "Controlled write" : "Read-only"}` : ""}
                    </p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {(selected.approvedModules || []).map((m) => (
                        <span key={m} className="rounded-full border border-emerald-400/40 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] text-emerald-300 light:text-emerald-700">{modLabel(m)}</span>
                      ))}
                    </div>
                    {selected.reviewNote && (
                      <p className="mt-2 text-[11px] text-slate-400">“{selected.reviewNote}” — {selected.reviewedByName || "reviewer"}</p>
                    )}
                  </div>
                  {selected.session ? (
                    selected.session.status === "ACTIVE" ? (
                      <ActiveSessionCard session={selected.session} onEnded={reloadAll} notify={notify} />
                    ) : selected.session.status === "PENDING" ? (
                      selected.session.enterPending ? (
                        <div className="rounded-xl border border-amber-400/40 bg-amber-500/10 p-3">
                          <p className="text-xs font-bold text-amber-200 light:text-amber-700">
                            <Clock className="mr-1 inline h-3.5 w-3.5" /> Activation link pending — one-time window, expires ≤10 minutes after approval
                          </p>
                          {activation && activation.requestId === selected.id ? (
                            <>
                              <p className="mt-1 text-[11px] text-amber-200/70">Minted in this console · expires {fmtDateTime(activation.activationExpiresAt)}</p>
                              <div className="mt-2 flex flex-wrap gap-2">
                                <CopyBtn text={absoluteUrl(activation.enterUrl)} label="Copy activation link" />
                                <Button size="sm" variant="outline" onClick={() => window.open(activation.enterUrl, "_blank", "noopener")}>
                                  <ExternalLink className="h-3.5 w-3.5" /> Open
                                </Button>
                              </div>
                            </>
                          ) : (
                            <p className="mt-1 text-[11px] leading-relaxed text-amber-200/70">
                              The link was displayed once to the approver and sent to {selected.approvedAgentName || "the agent"} in-app — it cannot be re-displayed. If it was lost, let it lapse and have the tenant submit a fresh request.
                            </p>
                          )}
                        </div>
                      ) : (
                        <div className="rounded-xl border border-white/10 light:border-slate-200 bg-white/[0.02] light:bg-slate-50 p-3">
                          <p className="text-xs text-slate-400">The 10-minute activation window elapsed without entry — the session never started. The tenant can submit a fresh request.</p>
                        </div>
                      )
                    ) : (
                      <div className="rounded-xl border border-white/10 light:border-slate-200 bg-white/[0.02] light:bg-slate-50 p-3 text-xs text-slate-400">
                        <StatusChip status={selected.session.status} />
                        <p className="mt-1.5">
                          {selected.session.operatorName ? `Operator ${selected.session.operatorName}. ` : ""}
                          {selected.session.endedReason ? `Ended — ${selected.session.endedReason}.` : "Session finished."}
                        </p>
                      </div>
                    )
                  ) : (
                    <p className="text-[11px] text-slate-500">Approved — waiting for the session row (the agent has not entered yet).</p>
                  )}
                </div>
              )}

              {selected.status === "ACTIVE" && (
                selected.session ? (
                  <ActiveSessionCard session={selected.session} onEnded={reloadAll} notify={notify} />
                ) : (
                  <p className="text-[11px] text-slate-500">Session row not loaded yet — refresh the queue.</p>
                )
              )}

              {["REJECTED", "CANCELLED", "COMPLETED", "REVOKED", "EXPIRED"].includes(selected.status) && (
                <div className="space-y-2 rounded-xl border border-white/10 light:border-slate-200 bg-white/[0.02] light:bg-slate-50 p-3">
                  <div className="flex items-center gap-2">
                    <LiveStatusChip status={selected.status} />
                    {selected.priority && <PriorityChip p={selected.priority} />}
                  </div>
                  {selected.reviewedByName && (
                    <p className="text-[11px] text-slate-500">Reviewed by {selected.reviewedByName} · {fmtDateTime(selected.reviewedAt)}</p>
                  )}
                  {selected.reviewNote && <p className="text-xs text-slate-400">“{selected.reviewNote}”</p>}
                  {selected.approvedAgentName && (
                    <p className="text-[11px] text-slate-500">Approved for {selected.approvedAgentName} · {selected.approvedMinutes ?? "—"} min</p>
                  )}
                  {selected.session && (
                    <p className="text-[11px] text-slate-500">
                      Session <StatusChip status={selected.session.status} />
                      {selected.session.operatorName ? ` · operator ${selected.session.operatorName}` : ""}
                      {selected.session.endedReason ? ` · ended — ${selected.session.endedReason}` : ""}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        </Glass>
      ) : (
        <Glass className="flex min-h-40 flex-col items-center justify-center gap-2 p-8 text-center">
          <LifeBuoy className="h-8 w-8 text-slate-600" />
          <p className="text-sm font-semibold text-slate-400">Select a request to review</p>
          <p className="max-w-md text-xs leading-relaxed text-slate-500">
            Pending requests show the tenant&apos;s full description, requested modules (you approve a subset), duration, access mode and the assigned agent. Approving mints a single-use activation link with a 10-minute window; the tenant sees every decision in their Support Center.
          </p>
        </Glass>
      )}

      {/* ---- the ONE-TIME activation link (shown once, highlighted) ---- */}
      <ActivationDialog activation={activation} onClose={() => setActivation(null)} />
    </div>
  )
}

/** Read-only left column of the review panel. */
function RequestSummary({ r }: { r: LiveRequestRow }) {
  return (
    <div className="space-y-3">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <LiveStatusChip status={r.status} />
          <PriorityChip p={r.priority} />
          <span className="text-[11px] uppercase tracking-wider text-slate-500">{modLabel(r.category)}</span>
        </div>
        <p className="mt-1.5 text-sm font-bold text-white light:text-slate-900">{r.title}</p>
        <p className="mt-0.5 text-[11px] text-slate-500">
          {r.vendorName}{r.vendorCode ? ` (${r.vendorCode})` : ""} · requested by {r.requestedByName} · {fmtDateTime(r.requestedAt)}
          {r.ticketId ? " · linked to a support ticket" : ""}
        </p>
      </div>
      <div className="rounded-xl border border-white/10 light:border-slate-200 bg-black/10 light:bg-slate-50 p-3">
        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Description</p>
        <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-slate-300 light:text-slate-700">{r.description}</p>
      </div>
      {r.contextNote && (
        <div className="rounded-xl border border-white/10 light:border-slate-200 bg-white/[0.02] light:bg-slate-100 p-3">
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Tenant context note</p>
          <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-slate-300 light:text-slate-700">{r.contextNote}</p>
        </div>
      )}
      <div>
        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Requested modules</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {r.modules.map((m) => (
            <span key={m} className="rounded-full border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100 px-2.5 py-0.5 text-[11px] text-slate-300 light:text-slate-700">{modLabel(m)}</span>
          ))}
        </div>
      </div>
      {r.reviewedByName && (
        <p className="text-[11px] text-slate-500">
          Reviewed by {r.reviewedByName} · {fmtDateTime(r.reviewedAt)}{r.reviewNote ? ` — “${r.reviewNote}”` : ""}
        </p>
      )}
    </div>
  )
}

/** ACTIVE session card — operator, modules, countdown, §5 re-entry, End. */
function ActiveSessionCard({ session, onEnded, notify }: {
  session: LiveSessionInfo
  onEnded: () => void
  notify: (tone: "ok" | "err", text: string) => void
}) {
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(t)
  }, [])
  const left = session.expiresAt ? Math.max(0, Math.floor((new Date(session.expiresAt).getTime() - now) / 1000)) : 0

  const end = async () => {
    setBusy(true)
    try {
      await ownerRpc("owner.supportAccess.end", { sessionId: session.id, reason: "ended from the live-support review board" })
      notify("ok", "Session ended — the transition is in the audit log.")
      onEnded()
    } catch (e: any) {
      notify("err", e?.message || "Could not end the session.")
    } finally { setBusy(false) }
  }

  return (
    <div className="rounded-xl border border-emerald-400/30 bg-emerald-500/5 p-4" role="status">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-bold text-emerald-300 light:text-emerald-700">
          <PlayCircle className="mr-1 inline h-4 w-4" /> Live session ACTIVE
        </p>
        <span className={cn("rounded-md px-2 py-1 text-xs font-bold tabular-nums",
          left < 120 ? "bg-rose-500/15 text-rose-300" : "bg-emerald-500/15 text-emerald-300 light:text-emerald-700")}>
          <Clock className="mr-1 inline h-3 w-3" /> {mmss(left)} left
        </span>
      </div>
      <p className="mt-1.5 text-[11px] text-slate-400">
        Operator {session.operatorName || "—"} · {session.accessMode === "CONTROLLED_WRITE" ? "Controlled write" : "Read-only"}
        {session.startedAt ? ` · started ${fmtDateTime(session.startedAt)}` : ""}
        {session.expiresAt ? ` · expires ${fmtDateTime(session.expiresAt)}` : ""}
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {session.modules.map((m) => (
          <span key={m} className="rounded-full border border-emerald-400/40 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] text-emerald-300 light:text-emerald-700">{modLabel(m)}</span>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <ReEnterButton sessionId={session.id} label="Enter Active Session" />
        <CopyBtn text={absoluteUrl(resumeUrl(session.id))} label="Copy re-entry link" />
        <Button size="sm" variant="outline" disabled={busy} className="border-rose-400/30 text-rose-300 hover:bg-rose-500/10" onClick={() => void end()}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <StopCircle className="h-3.5 w-3.5" />} End session
        </Button>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
        Re-entry re-authenticates the operator&apos;s owner session server-side, validates status, expiry and operator binding, rotates the token and redirects into the tenant workspace. Other operators are denied with a clear message.
      </p>
    </div>
  )
}

/** The ONE-TIME activation link dialog — highlighted, copy button, 10-min warning. */
function ActivationDialog({ activation, onClose }: { activation: ActivationLink | null; onClose: () => void }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!activation) return
    const t = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(t)
  }, [activation])
  const left = activation ? Math.max(0, Math.floor((new Date(activation.activationExpiresAt).getTime() - now) / 1000)) : 0

  return (
    <Dialog open={!!activation} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="border-amber-400/40 bg-slate-900/95 light:bg-white sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-amber-300 light:text-amber-700">
            <ShieldAlert className="h-4 w-4" /> One-time activation link
          </DialogTitle>
        </DialogHeader>
        {activation && (
          <div className="space-y-3">
            <p className="rounded-lg border border-amber-400/40 bg-amber-500/10 p-3 text-xs font-semibold leading-relaxed text-amber-200 light:text-amber-700">
              Single-use link bound to the agent&apos;s signed-in owner session — expires in 10 minutes.
            </p>
            <div className="flex items-center justify-between gap-2 text-[11px] text-slate-400">
              <span>Expires {fmtDateTime(activation.activationExpiresAt)}</span>
              <span className={cn("rounded-md px-2 py-1 font-bold tabular-nums", left > 0 ? "bg-amber-500/15 text-amber-300" : "bg-rose-500/15 text-rose-300")}>
                <Clock className="mr-1 inline h-3 w-3" /> {left > 0 ? `${mmss(left)} left` : "expired"}
              </span>
            </div>
            <code className="block break-all rounded-lg border border-white/10 bg-black/40 p-3 text-[11px] leading-relaxed text-amber-200 light:text-amber-800">
              {activation.enterUrl}
            </code>
            <div className="flex flex-wrap gap-2">
              <CopyBtn text={absoluteUrl(activation.enterUrl)} label="Copy link" />
              <Button size="sm" className="bg-gradient-to-r from-amber-500 to-orange-500 text-white" onClick={() => window.open(activation.enterUrl, "_blank", "noopener")}>
                <ExternalLink className="h-3.5 w-3.5" /> Open activation link
              </Button>
              <Button size="sm" variant="ghost" className="text-slate-400" onClick={onClose}>Dismiss</Button>
            </div>
            <p className="text-[11px] leading-relaxed text-slate-500">
              The link is displayed ONCE and never stored in plaintext — copy it now and hand it to the agent through your usual channel; they were also notified in-app. It burns on first use and only works while the agent is signed into the owner console.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// =====================================================================
// TAB 3 — Support Access (Wave 10 control room, kept + §5 re-entry)
// =====================================================================

function SupportAccessTab() {
  const overview = useOwnerApi<Overview>("owner.supportAccess.overview", {})
  const policyQ = useOwnerApi<{ policy: Policy; writeCatalog: string[] }>("owner.supportAccess.policy", {})
  const { notify, node: toastNode } = useConsoleToast()

  const [tenantSearch, setTenantSearch] = useState("")
  const [tenants, setTenants] = useState<{ id: string; name: string; code: string; active: boolean }[]>([])
  const [tenantPicked, setTenantPicked] = useState<{ id: string; name: string } | null>(null)
  const [reason, setReason] = useState("")
  const [ticket, setTicket] = useState("")
  const [mode, setMode] = useState<"READ_ONLY" | "CONTROLLED_WRITE">("READ_ONLY")
  const [minutes, setMinutes] = useState<number | null>(null)
  const [scope, setScope] = useState<string[]>([])
  const [startBusy, setStartBusy] = useState(false)
  const [startErr, setStartErr] = useState<string | null>(null)
  const [enterLink, setEnterLink] = useState<StartResult | null>(null)
  const [linkSecondsLeft, setLinkSecondsLeft] = useState(0)

  const [board, setBoard] = useState<ActiveSession[]>([])
  const [boardBusy, setBoardBusy] = useState(false)
  const [history, setHistory] = useState<{ sessions: HistoryRow[]; total: number } | null>(null)
  const [histStatus, setHistStatus] = useState<string>("ALL")

  // ---- tenant picker (debounced search) ----
  useEffect(() => {
    if (tenantPicked) return
    const t = setTimeout(async () => {
      try {
        const res = await ownerRpc<{ tenants: typeof tenants }>("owner.supportAccess.tenants", { search: tenantSearch || undefined })
        setTenants(res.tenants)
      } catch { /* permission or transient — the picker just stays empty */ }
    }, 250)
    return () => clearTimeout(t)
  }, [tenantSearch, tenantPicked])

  // ---- live board poll (15s + countdown re-render every second) ----
  const loadBoard = useCallback(async () => {
    setBoardBusy(true)
    try {
      const res = await ownerRpc<{ sessions: ActiveSession[] }>("owner.supportAccess.active", {})
      setBoard(res.sessions)
    } catch { /* transient */ } finally { setBoardBusy(false) }
  }, [])
  useEffect(() => {
    void loadBoard()
    const poll = setInterval(loadBoard, 15_000)
    return () => clearInterval(poll)
  }, [loadBoard])
  useEffect(() => {
    const tick = setInterval(() => {
      setBoard((b) => b.map((s) => ({ ...s, remainingSeconds: Math.max(0, s.remainingSeconds - 1) })))
      setLinkSecondsLeft((v) => Math.max(0, v - 1))
    }, 1000)
    return () => clearInterval(tick)
  }, [])

  const loadHistory = useCallback(async () => {
    try {
      const res = await ownerRpc<{ sessions: HistoryRow[]; total: number }>("owner.supportAccess.history", {
        page: 1, pageSize: 25, ...(histStatus !== "ALL" ? { status: histStatus } : {}),
      })
      setHistory(res)
    } catch { /* transient */ }
  }, [histStatus])
  useEffect(() => { void loadHistory() }, [loadHistory])

  const startSession = async () => {
    if (!tenantPicked) { setStartErr("Pick a tenant first."); return }
    setStartBusy(true); setStartErr(null); setEnterLink(null)
    try {
      const res = await ownerRpc<StartResult>("owner.supportAccess.start", {
        vendorId: tenantPicked.id,
        reason,
        ticketRef: ticket || undefined,
        accessMode: mode,
        ...(minutes ? { minutes } : {}),
        ...(mode === "CONTROLLED_WRITE" ? { scope } : {}),
      })
      setEnterLink(res)
      setLinkSecondsLeft(60)
      setReason(""); setTicket(""); setScope([])
      setMode("READ_ONLY")
      setTenantPicked(null)
      void loadBoard()
      void overview.reload()
    } catch (e: any) {
      setStartErr(e?.message || "Could not start the support session.")
    } finally { setStartBusy(false) }
  }

  const endSession = async (row: ActiveSession) => {
    try {
      await ownerRpc("owner.supportAccess.end", { sessionId: row.id, reason: row.mine ? "operator exit (console)" : "revoked from the support board" })
      void loadBoard(); void loadHistory(); void overview.reload()
    } catch (e: any) { notify("err", e?.message || "Could not end the session.") }
  }

  if (overview.loading || policyQ.loading) return <Loading />
  if (overview.error) return <ErrorBanner message={overview.error} />

  const p = policyQ.data?.policy
  const catalog = policyQ.data?.writeCatalog || []

  return (
    <div className="space-y-5">
      {toastNode}

      <div className="flex items-center justify-end">
        <Button size="sm" variant="outline" onClick={() => { void loadBoard(); void overview.reload(); void loadHistory(); void policyQ.reload() }}>
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </Button>
      </div>

      {/* ---- overview KPIs ---- */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Active sessions" value={overview.data?.active ?? 0} icon={UserCheck} tone="emerald" sub={`cap ${p?.maxConcurrentActive ?? "—"}`} />
        <KpiCard label="Started (24h)" value={overview.data?.startedLast24h ?? 0} icon={PlayCircle} />
        <KpiCard label="Denied reaches (24h)" value={overview.data?.deniedLast24h ?? 0} icon={ShieldOff} tone="amber" />
        <KpiCard label="Policy" value={p?.enabled ? "Enabled" : "Disabled"} icon={p?.enabled ? ShieldCheck : ShieldOff} tone={p?.enabled ? "emerald" : "default"} sub={`default ${p?.defaultMinutes ?? "—"} min · max ${p?.maxMinutes ?? "—"} min`} />
      </div>

      {/* ---- the ONE-TIME enter link (shown once, 60 seconds) ---- */}
      {enterLink && (
        <Glass className="border-amber-400/40 bg-amber-500/10 p-4">
          <p className="text-sm font-bold text-amber-200">One-time support link ready — valid {linkSecondsLeft}s</p>
          <p className="mt-1 text-xs text-amber-200/70">
            The capability is bound to your owner account, burns on first use, and is never stored in plaintext. Open it in a new tab while signed in here.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              className="bg-gradient-to-r from-amber-500 to-orange-500 text-white"
              onClick={() => { window.open(enterLink.enterUrl, "_blank", "noopener"); setEnterLink(null) }}
            >
              <PlayCircle className="h-4 w-4" /> Open tenant workspace
            </Button>
            <Button size="sm" variant="ghost" className="text-amber-200/80" onClick={() => setEnterLink(null)}>Dismiss</Button>
          </div>
        </Glass>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        {/* ---- start a session ---- */}
        <Glass className="p-5">
          <p className="text-sm font-bold text-white light:text-slate-900">Start a support session</p>
          <div className="mt-4 space-y-3">
            <div>
              <Label className="text-xs text-slate-400">Tenant</Label>
              {tenantPicked ? (
                <div className="mt-1.5 flex items-center justify-between rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-3 py-2">
                  <span className="text-sm text-emerald-200">{tenantPicked.name}</span>
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setTenantPicked(null)}>change</Button>
                </div>
              ) : (
                <div className="relative mt-1.5">
                  <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-500" />
                  <Input value={tenantSearch} onChange={(e) => setTenantSearch(e.target.value)} className={`${inputCls} pl-9`} placeholder="Search tenants by name or code…" />
                  {tenants.length > 0 && (
                    <div className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-white/10 bg-slate-900/95 light:bg-white p-1 shadow-xl">
                      {tenants.map((t) => (
                        <button key={t.id} type="button" className="block w-full rounded-md px-3 py-2 text-left text-xs text-slate-200 light:text-slate-800 hover:bg-white/10 light:hover:bg-slate-100"
                          onClick={() => { setTenantPicked({ id: t.id, name: t.name }); setTenants([]); setTenantSearch("") }}>
                          {t.name} <span className="text-slate-500">({t.code}{t.active ? "" : " · inactive"})</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div>
              <Label className="text-xs text-slate-400">Reason (min 10 chars — shown in the audit log)</Label>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} className={inputCls} placeholder="e.g. Investigating attendance device sync failures reported via ticket #4821" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-slate-400">Access mode</Label>
                <Select value={mode} onValueChange={(v) => setMode(v as "READ_ONLY" | "CONTROLLED_WRITE")}>
                  <SelectTrigger className={inputCls}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="READ_ONLY">Read-only (all *.view)</SelectItem>
                    <SelectItem value="CONTROLLED_WRITE">Controlled write (scoped)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs text-slate-400">Duration (minutes)</Label>
                <Input type="number" min={5} max={p?.maxMinutes ?? 30} value={minutes ?? p?.defaultMinutes ?? 15}
                  onChange={(e) => setMinutes(Number(e.target.value))} className={inputCls} />
              </div>
            </div>
            <div>
              <Label className="text-xs text-slate-400">Ticket / reference {p?.requireTicketForWrite ? "(required for controlled write)" : "(optional)"}</Label>
              <Input value={ticket} onChange={(e) => setTicket(e.target.value)} className={inputCls} placeholder="#4821" />
            </div>
            {mode === "CONTROLLED_WRITE" && (
              <div>
                <Label className="text-xs text-slate-400">Write scope — only these actions unlock (needs support.manage)</Label>
                <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2">
                  {catalog.map((c) => (
                    <label key={c} className="flex items-center gap-2 rounded-lg border border-white/10 light:border-slate-200 bg-white/[0.02] light:bg-slate-50 px-3 py-2 text-xs">
                      <input type="checkbox" checked={scope.includes(c)} className="accent-emerald-500"
                        onChange={(e) => setScope((s) => e.target.checked ? [...s, c] : s.filter((x) => x !== c))} />
                      <code className="text-[11px] text-slate-300 light:text-slate-700">{c}</code>
                    </label>
                  ))}
                </div>
              </div>
            )}
            {startErr && <p className="rounded-lg border border-rose-400/30 bg-rose-500/10 p-2.5 text-xs text-rose-300">{startErr}</p>}
            <Button disabled={startBusy || !tenantPicked || reason.trim().length < 10} onClick={startSession}
              className="w-full bg-gradient-to-r from-emerald-500 to-teal-500 text-white">
              {startBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><PlayCircle className="h-4 w-4" /> Mint one-time support link</>}
            </Button>
            <p className="text-[11px] leading-relaxed text-slate-500">
              The link opens the tenant workspace with a persistent SUPPORT ACCESS banner; expiry is enforced server-side on every request — the countdown is only UX. Support sessions never receive the tenant admin role and never reach payroll, approvals, user administration, billing or exports.
            </p>
          </div>
        </Glass>

        {/* ---- live board ---- */}
        <Glass className="p-5">
          <div className="flex items-center justify-between">
            <p className="text-sm font-bold text-white light:text-slate-900">Live sessions</p>
            <div className="flex items-center gap-2">
              {boardBusy && <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-500" />}
              <span className="text-xs text-slate-500">auto-refresh 15s</span>
            </div>
          </div>
          <div className="mt-4 space-y-2">
            {board.length === 0 && <p className="rounded-lg border border-white/10 light:border-slate-200 p-4 text-center text-xs text-slate-500">No active support sessions.</p>}
            {board.map((s) => (
              <div key={s.id} className={cn("rounded-xl border p-3", s.mine ? "border-emerald-400/30 bg-emerald-500/5" : "border-white/10 light:border-slate-200 bg-white/[0.02] light:bg-slate-50")}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-white light:text-slate-900">{s.targetVendorName}</p>
                    <p className="text-[11px] text-slate-400">{s.operatorName}{s.mine ? " (you)" : ""} · {s.accessMode === "CONTROLLED_WRITE" ? "Controlled write" : "Read-only"}{s.ticketRef ? ` · ${s.ticketRef}` : ""}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn("rounded-md px-2 py-1 text-xs font-bold tabular-nums", s.remainingSeconds < 120 ? "bg-rose-500/15 text-rose-300" : "bg-white/10 light:bg-slate-200 text-slate-200 light:text-slate-700")}>
                      <Clock className="mr-1 inline h-3 w-3" />{Math.floor(s.remainingSeconds / 60)}:{String(s.remainingSeconds % 60).padStart(2, "0")}
                    </span>
                    {/* master prompt §5 — re-entry anchor (server re-authenticates the operator) */}
                    <ReEnterButton sessionId={s.id} label={s.mine ? "Re-enter Live Support" : "Enter Active Session"} />
                    <CopyBtn text={absoluteUrl(resumeUrl(s.id))} label="Copy re-entry link" />
                    <Button size="sm" variant="outline" className="h-8 border-rose-400/30 text-rose-300 hover:bg-rose-500/10" onClick={() => endSession(s)}>
                      <StopCircle className="h-3.5 w-3.5" /> {s.mine ? "End" : "Revoke"}
                    </Button>
                  </div>
                </div>
                <p className="mt-2 text-[11px] text-slate-500">“{s.reason}” — started {fmtDateTime(s.startedAt)} · ip {s.ip || "—"}</p>
              </div>
            ))}
          </div>
        </Glass>
      </div>

      {/* ---- history ---- */}
      <Glass className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-bold text-white light:text-slate-900"><History className="mr-1.5 inline h-4 w-4" />Session history</p>
          <Select value={histStatus} onValueChange={setHistStatus}>
            <SelectTrigger className={`${inputCls} h-8 w-40 text-xs`}><SelectValue /></SelectTrigger>
            <SelectContent>
              {["ALL", "ACTIVE", "ENDED", "EXPIRED", "REVOKED", "PENDING"].map((s) => (
                <SelectItem key={s} value={s}>{s === "ALL" ? "Any status" : s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="mt-3">
          <TableShell headers={["Tenant", "Operator", "Mode", "Status", "Minutes", "Started", "Ended", "Why"]} empty={(history?.sessions?.length ?? 0) === 0}>
            {(history?.sessions || []).map((r) => (
              <tr key={r.id} className="border-b border-white/5 light:border-slate-100">
                <Td className="text-xs font-medium">{r.targetVendorName}</Td>
                <Td className="text-xs">{r.operatorName}</Td>
                <Td className="text-xs">{r.accessMode === "CONTROLLED_WRITE" ? "Controlled write" : "Read-only"}</Td>
                <Td><StatusChip status={r.status} /></Td>
                <Td className="text-xs tabular-nums">{r.requestedMinutes}</Td>
                <Td className="text-xs">{fmtDateTime(r.startedAt)}</Td>
                <Td className="text-xs">{r.endedAt ? `${fmtDateTime(r.endedAt)}${r.endedByName ? ` by ${r.endedByName}` : ""}` : "—"}</Td>
                <Td className="max-w-56 truncate text-xs text-slate-400"><span title={r.reason} className="block truncate">{r.reason}</span></Td>
              </tr>
            ))}
          </TableShell>
        </div>
      </Glass>

      {/* ---- policy editor (support.manage) ---- */}
      {p && <PolicyCard policy={p} onSaved={() => void policyQ.reload()} />}
    </div>
  )
}

function PolicyCard({ policy, onSaved }: { policy: Policy; onSaved: () => void }) {
  const [form, setForm] = useState<Policy>(policy)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const savedRef = useRef(false)
  useEffect(() => { if (!savedRef.current) setForm(policy) }, [policy])

  const save = async () => {
    setBusy(true); setErr(null)
    try {
      await ownerRpc("owner.supportAccess.savePolicy", {
        enabled: form.enabled,
        defaultMinutes: form.defaultMinutes,
        maxMinutes: form.maxMinutes,
        requireTicketForWrite: form.requireTicketForWrite,
        maxConcurrentActive: form.maxConcurrentActive,
      })
      savedRef.current = true
      onSaved()
      setTimeout(() => { savedRef.current = false }, 1000)
    } catch (e: any) { setErr(e?.message || "Save failed — the support.manage permission is required.") } finally { setBusy(false) }
  }

  return (
    <Glass className="p-5">
      <div className="flex items-center justify-between">
        <p className="text-sm font-bold text-white light:text-slate-900"><Settings2 className="mr-1.5 inline h-4 w-4" />Platform policy (support.manage)</p>
        <Button size="sm" disabled={busy} onClick={save} className="bg-white/10 light:bg-slate-900 text-white light:text-white hover:bg-white/20 light:hover:bg-slate-800">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save policy"}
        </Button>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <label className="flex items-center justify-between rounded-lg border border-white/10 light:border-slate-200 bg-white/[0.02] light:bg-slate-50 p-3">
          <span className="pr-3 text-xs">Support access enabled</span>
          <Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} />
        </label>
        <div>
          <Label className="text-xs text-slate-400">Default minutes</Label>
          <Input type="number" min={5} max={240} value={form.defaultMinutes} onChange={(e) => setForm({ ...form, defaultMinutes: Number(e.target.value) })} className={inputCls} />
        </div>
        <div>
          <Label className="text-xs text-slate-400">Max minutes</Label>
          <Input type="number" min={15} max={240} value={form.maxMinutes} onChange={(e) => setForm({ ...form, maxMinutes: Number(e.target.value) })} className={inputCls} />
        </div>
        <div>
          <Label className="text-xs text-slate-400">Max concurrent (platform)</Label>
          <Input type="number" min={1} max={100} value={form.maxConcurrentActive} onChange={(e) => setForm({ ...form, maxConcurrentActive: Number(e.target.value) })} className={inputCls} />
        </div>
        <label className="flex items-center justify-between rounded-lg border border-white/10 light:border-slate-200 bg-white/[0.02] light:bg-slate-50 p-3 sm:col-span-2">
          <span className="pr-3 text-xs"><Lock className="mr-1 inline h-3 w-3" />Ticket required for controlled write</span>
          <Switch checked={form.requireTicketForWrite} onCheckedChange={(v) => setForm({ ...form, requireTicketForWrite: v })} />
        </label>
        {err && <p className="sm:col-span-2 xl:col-span-4 rounded-lg border border-rose-400/30 bg-rose-500/10 p-2.5 text-xs text-rose-300">{err}</p>}
      </div>
      <p className="mt-3 text-[11px] text-slate-500"><Timer className="mr-1 inline h-3 w-3" />Server-side policy: sessions hard-expire on every request; the sweeper transitions stale rows to EXPIRED daily.</p>
    </Glass>
  )
}
