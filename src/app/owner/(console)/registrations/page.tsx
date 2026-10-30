"use client"
// ============ /owner/registrations — the approval workflow console ============
// List → detail → review/approve/reject. Every state transition is audited
// server-side; this page is purely the operator's surface.
import { useCallback, useEffect, useState } from "react"
import {
  Building2, CheckCircle2, ChevronRight, Loader2, RotateCcw, Search, Send, Users, Wallet, XCircle,
} from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { ownerRpc, useOwnerApi } from "@/saas/owner/client"
import { ErrorBanner, PageHeader, StatusChip, TableShell, Td, fmtDate, fmtDateTime, Loading } from "@/saas/owner/ui"

type Row = {
  id: string
  applicationNumber: string
  organizationName: string
  industry: string | null
  adminName: string
  adminEmail: string
  adminPhone: string | null
  employeeCount: number
  branchCount: number
  deviceCount: number
  requestedModules: string[]
  planName: string | null
  billingCycle: string
  status: string
  reviewedByName: string | null
  createdAt: string
  reviewedAt: string | null
}

type Detail = Row & {
  organizationType: string | null
  website: string | null
  address: string | null
  city: string | null
  country: string
  contactNumber: string | null
  officialEmail: string
  adminDesignation: string | null
  internalNote: string | null
  reviewNote: string | null
  rejectionReason: string | null
  requestedInfoAt: string | null
  approvedVendorId: string | null
  submitIp: string | null
}

type PlanOption = { id: string; name: string; monthlyPrice: number; yearlyPrice: number; currency: string; employeeLimit: number | null; storageGb: number | null; supportLevel: string }

const STATUSES = ["ALL", "PENDING", "UNDER_REVIEW", "APPROVED", "REJECTED", "SUSPENDED", "CANCELLED"] as const

export default function RegistrationsPage() {
  const [status, setStatus] = useState<string>("ALL")
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(1)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  // list
  const listDeps = [status, search, page]
  const { data, loading, error, reload } = useOwnerApi<{ rows: Row[]; total: number; pageSize: number }>(
    "owner.registrations.list",
    { status, search: search || undefined, page, pageSize: 25 },
    listDeps
  )

  // plans for the approve dialog
  const { data: plansData } = useOwnerApi<{ plans: PlanOption[] }>("owner.plans.forApproval", {})

  // detail loader
  const openDetail = useCallback(async (id: string) => {
    setSelectedId(id)
    setDetail(null)
    setActionError(null)
    setDetailLoading(true)
    try {
      const d = await ownerRpc<Detail>("owner.registrations.get", { id })
      setDetail(d)
    } catch (e: any) {
      setActionError(e?.message || "Could not load the application.")
    } finally {
      setDetailLoading(false)
    }
  }, [])

  useEffect(() => { if (selectedId) openDetail(selectedId) }, [selectedId, openDetail])

  // ---- action runners ----
  const runAction = async (label: string, fn: () => Promise<any>, after?: string) => {
    setBusy(label)
    setActionError(null)
    try {
      await fn()
      if (after) { setToast(after); setTimeout(() => setToast(null), 5000) }
      await reload()
      if (selectedId) await openDetail(selectedId)
      return true
    } catch (e: any) {
      setActionError(e?.message || "Action failed.")
      return false
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Registration Applications"
        sub="Every application from the public website lands here. Approving one provisions the tenant transactionally."
      />

      {toast && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-400/30 bg-emerald-500/10 p-3 text-sm text-emerald-300 light:text-emerald-700">
          <CheckCircle2 className="h-4 w-4" /> {toast}
        </div>
      )}

      {/* filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <Input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1) }}
            placeholder="Search organization, ID or email…"
            className="h-10 w-72 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 pl-9"
          />
        </div>
        <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1) }}>
          <SelectTrigger className="h-10 w-44 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100"><SelectValue /></SelectTrigger>
          <SelectContent>
            {STATUSES.map((s) => <SelectItem key={s} value={s}>{s === "ALL" ? "All statuses" : s.replace("_", " ")}</SelectItem>)}
          </SelectContent>
        </Select>
        <span className="ml-auto text-xs text-slate-500">{data ? `${data.total} application${data.total === 1 ? "" : "s"}` : ""}</span>
      </div>

      {error && <ErrorBanner message={error} />}
      {loading ? (
        <Loading />
      ) : (
        <TableShell
          headers={["Application", "Organization", "Contact", "Scale", "Plan", "Status", "Reviewer", "Submitted", ""]}
          empty={data?.rows.length === 0}
        >
          {data?.rows.map((r) => (
            <tr key={r.id} className="cursor-pointer transition-colors hover:bg-white/[0.03] light:hover:bg-slate-100/60" onClick={() => openDetail(r.id)}>
              <Td className="font-mono text-xs text-indigo-300 light:text-indigo-700">{r.applicationNumber}</Td>
              <Td>
                <span className="font-medium text-white light:text-slate-900">{r.organizationName}</span>
                {r.industry && <span className="block text-xs text-slate-500">{r.industry}</span>}
              </Td>
              <Td>
                <span className="text-white light:text-slate-900">{r.adminName}</span>
                <span className="block text-xs text-slate-500">{r.adminEmail}</span>
              </Td>
              <Td className="text-xs">{r.employeeCount} emp · {r.branchCount} br · {r.deviceCount} dev</Td>
              <Td className="text-xs">{r.planName ? `${r.planName} (${r.billingCycle[0]}${r.billingCycle.slice(1).toLowerCase()})` : "—"}</Td>
              <Td><StatusChip status={r.status} /></Td>
              <Td className="text-xs">{r.reviewedByName || "—"}</Td>
              <Td className="text-xs">{fmtDate(r.createdAt)}</Td>
              <Td><ChevronRight className="h-4 w-4 text-slate-600 light:text-slate-500" /></Td>
            </tr>
          ))}
        </TableShell>
      )}

      {/* pagination */}
      {data && data.total > data.pageSize && (
        <div className="flex items-center justify-center gap-3">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100">Previous</Button>
          <span className="text-xs text-slate-500">page {page} / {Math.ceil(data.total / data.pageSize)}</span>
          <Button variant="outline" size="sm" disabled={page >= Math.ceil(data.total / data.pageSize)} onClick={() => setPage((p) => p + 1)} className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100">Next</Button>
        </div>
      )}

      {/* detail + action dialog — wide (up to 5xl) so Organization / Primary
          administrator details render fully readable in the two-column layout;
          long values wrap instead of truncating. Responsive: 95vw cap on small
          screens, internal vertical scroll only — never horizontal overflow. */}
      <Dialog open={!!selectedId} onOpenChange={(o) => { if (!o) { setSelectedId(null); setDetail(null); setActionError(null) } }}>
        <DialogContent className="max-h-[90dvh] w-[min(64rem,95vw)] max-w-5xl overflow-y-auto overflow-x-hidden border-white/10 light:border-slate-200 bg-slate-950 light:bg-slate-50/95 light:bg-white/95 p-0">
          {detailLoading || !detail ? (
            <div className="py-16"><Loading label="Loading application…" /></div>
          ) : (
            <ApplicationDetail
              detail={detail}
              plans={plansData?.plans || []}
              busy={busy}
              actionError={actionError}
              onAction={runAction}
              onToast={(t) => { setToast(t); setTimeout(() => setToast(null), 6000) }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function ApplicationDetail({
  detail, plans, busy, actionError, onAction, onToast,
}: {
  detail: Detail
  plans: PlanOption[]
  busy: string | null
  actionError: string | null
  onAction: (label: string, fn: () => Promise<any>, after?: string) => Promise<boolean>
  onToast: (t: string) => void
}) {
  const [tab, setTab] = useState<"overview" | "review">("overview")
  const [internalNote, setInternalNote] = useState(detail.internalNote || "")
  const [reviewNote, setReviewNote] = useState(detail.reviewNote || "")
  const [rejectOpen, setRejectOpen] = useState(false)
  const [rejectReason, setRejectReason] = useState("")
  const [approveOpen, setApproveOpen] = useState(false)
  const [approvePlanId, setApprovePlanId] = useState(plans[0]?.id || "")
  const [approveCycle, setApproveCycle] = useState<"MONTHLY" | "YEARLY">(detail.billingCycle === "YEARLY" ? "YEARLY" : "MONTHLY")
  const [trialDays, setTrialDays] = useState("0")
  // R12 — Accept & invoice dialog state (separate workflow from Approve)
  const [acceptOpen, setAcceptOpen] = useState(false)
  const [acceptPlanId, setAcceptPlanId] = useState(plans[0]?.id || "")
  const [acceptCycle, setAcceptCycle] = useState<"MONTHLY" | "YEARLY">(detail.billingCycle === "YEARLY" ? "YEARLY" : "MONTHLY")
  const [acceptTrialDays, setAcceptTrialDays] = useState("0")
  const [acceptDueDays, setAcceptDueDays] = useState("7")

  const closed = detail.status === "APPROVED" || detail.status === "CANCELLED"
  const rejected = detail.status === "REJECTED"

  const fmtMoney = (n: number, cur: string) => `${cur === "BDT" ? "৳" : `${cur} `}${n.toLocaleString()}`
  const acceptPlan = plans.find((p) => p.id === acceptPlanId)

  return (
    <>
      <DialogHeader className="border-b border-white/10 light:border-slate-200 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <DialogTitle className="font-mono text-sm text-indigo-300 light:text-indigo-700">{detail.applicationNumber}</DialogTitle>
          <StatusChip status={detail.status} />
          <span className="text-sm font-semibold text-white light:text-slate-900">{detail.organizationName}</span>
          <span className="ml-auto text-xs text-slate-500">submitted {fmtDateTime(detail.createdAt)}{detail.submitIp ? ` · ${detail.submitIp}` : ""}</span>
        </div>
      </DialogHeader>

      <div className="px-5 pt-4">
        <div className="flex gap-1 rounded-lg border border-white/10 light:border-slate-200 p-1">
          {(["overview", "review"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={cn("flex-1 rounded-md px-3 py-1.5 text-xs font-semibold", tab === t ? "bg-white/10 light:bg-slate-200 text-white light:text-slate-900" : "text-slate-400 light:text-slate-600")}>
              {t === "overview" ? "Application" : "Review & decision"}
            </button>
          ))}
        </div>
      </div>

      {actionError && <div className="mx-5 mt-4 rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-300 light:text-red-600">{actionError}</div>}

      {tab === "overview" ? (
        <div className="space-y-5 p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <InfoCard icon={Building2} title="Organization">
              <KV k="Type" v={detail.organizationType?.replace(/_/g, " ") || "—"} />
              <KV k="Industry" v={detail.industry || "—"} />
              <KV k="Website" v={detail.website || "—"} />
              <KV k="Address" v={[detail.address, detail.city, detail.country].filter(Boolean).join(", ") || "—"} />
              <KV k="Official email" v={detail.officialEmail} />
              <KV k="Contact" v={detail.contactNumber || "—"} />
            </InfoCard>
            <InfoCard icon={Users} title="Primary administrator">
              <KV k="Name" v={detail.adminName} />
              <KV k="Designation" v={detail.adminDesignation || "—"} />
              <KV k="Email (sign-in)" v={detail.adminEmail} />
              <KV k="Phone" v={detail.adminPhone || "—"} />
            </InfoCard>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-4">
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Employees</p>
              <p className="mt-1 text-2xl font-bold text-white light:text-slate-900">{detail.employeeCount.toLocaleString()}</p>
            </div>
            <div className="rounded-xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-4">
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Branches</p>
              <p className="mt-1 text-2xl font-bold text-white light:text-slate-900">{detail.branchCount}</p>
            </div>
            <div className="rounded-xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-4">
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Devices</p>
              <p className="mt-1 text-2xl font-bold text-white light:text-slate-900">{detail.deviceCount}</p>
            </div>
          </div>

          <div className="rounded-xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-4">
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Requested modules</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {detail.requestedModules.length === 0 && <span className="text-xs text-slate-500">none selected</span>}
              {detail.requestedModules.map((m) => (
                <span key={m} className="rounded-full border border-indigo-400/30 bg-indigo-500/10 px-2.5 py-0.5 text-[11px] font-medium text-indigo-200 light:text-indigo-700">
                  {m.replace(/_/g, " ").toLowerCase()}
                </span>
              ))}
            </div>
          </div>

          {(detail.reviewNote || detail.rejectionReason || detail.requestedInfoAt) && (
            <div className="space-y-2">
              {detail.reviewNote && (
                <p className="rounded-xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-4 text-sm text-slate-300 light:text-slate-700">
                  <span className="font-semibold text-white light:text-slate-900">Review note (shared with applicant): </span>{detail.reviewNote}
                </p>
              )}
              {detail.rejectionReason && (
                <p className="rounded-xl border border-red-400/25 bg-red-500/10 p-4 text-sm text-red-200 light:text-red-600">
                  <span className="font-semibold">Rejection reason: </span>{detail.rejectionReason}
                </p>
              )}
              {detail.requestedInfoAt && (
                <p className="rounded-xl border border-blue-400/25 bg-blue-500/10 p-4 text-sm text-blue-200 light:text-blue-700">
                  Information was requested on {fmtDateTime(detail.requestedInfoAt)}.
                </p>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-5 p-5">
          {/* internal + shared notes */}
          <div className="grid gap-4">
            <div>
              <Label className="text-xs text-slate-400 light:text-slate-600">Internal note (never shown to the applicant)</Label>
              <Textarea value={internalNote} onChange={(e) => setInternalNote(e.target.value)} rows={3}
                className="mt-1.5 bg-white/5 light:bg-slate-100 border-white/10 light:border-slate-200" placeholder="Sizing, pricing discussion, risks…" />
            </div>
            <div>
              <Label className="text-xs text-slate-400 light:text-slate-600">Review note (shown on the applicant&apos;s status page)</Label>
              <Textarea value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} rows={2}
                className="mt-1.5 bg-white/5 light:bg-slate-100 border-white/10 light:border-slate-200" placeholder="e.g. Approved for the Business plan; welcome aboard." />
            </div>
          </div>

          {actionError && <div className="rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-300 light:text-red-600">{actionError}</div>}

          {/* actions */}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={!!busy || closed || rejected}
              onClick={() => onAction("review", () => ownerRpc("owner.registrations.review", {
                id: detail.id, toStatus: "UNDER_REVIEW", internalNote, reviewNote,
              }), "Moved to under review.")}
              className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-white light:text-slate-900 hover:bg-white/10 light:hover:bg-slate-200"
              variant="outline"
            >
              <Send className="h-4 w-4" /> Mark under review
            </Button>
            <Button
              disabled={!!busy || closed || rejected}
              onClick={() => onAction("requestInfo", () => ownerRpc("owner.registrations.review", {
                id: detail.id, toStatus: "REQUEST_INFO", internalNote, reviewNote,
              }), "Information requested — visible on the applicant&apos;s status page.")}
              variant="outline"
              className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-white light:text-slate-900 hover:bg-white/10 light:hover:bg-slate-200"
            >
              Request information
            </Button>
            {rejected && (
              <Button
                disabled={!!busy}
                onClick={() => onAction("reopen", () => ownerRpc("owner.registrations.reopen", { id: detail.id }), "Application re-opened.")}
                variant="outline" className="border-amber-400/30 bg-amber-500/10 text-amber-300 light:text-amber-700 hover:bg-amber-500/20"
              >
                <RotateCcw className="h-4 w-4" /> Re-open
              </Button>
            )}
            <Button
              disabled={!!busy || closed || rejected}
              onClick={() => { setAcceptPlanId(plans[0]?.id || ""); setAcceptCycle(detail.billingCycle === "YEARLY" ? "YEARLY" : "MONTHLY"); setAcceptOpen(true) }}
              className="bg-gradient-to-r from-indigo-600 to-blue-600 text-white hover:from-indigo-500 hover:to-blue-500"
              title="Accept the application, provision the tenant, issue the first invoice and email it to the applicant"
            >
              <Wallet className="h-4 w-4" /> Accept &amp; send invoice
            </Button>
            <Button
              disabled={!!busy || closed || rejected}
              onClick={() => { setApprovePlanId(plans[0]?.id || ""); setApproveOpen(true) }}
              className="bg-gradient-to-r from-emerald-600 to-teal-600 text-white light:text-slate-900 hover:from-emerald-500 hover:to-teal-500"
              title="Approve and provision the tenant with a plain welcome email (no invoice)"
            >
              <CheckCircle2 className="h-4 w-4" /> Approve &amp; provision
            </Button>
            <Button
              disabled={!!busy || closed}
              onClick={() => { setRejectReason(""); setRejectOpen(true) }}
              variant="outline"
              className="border-red-400/30 bg-red-500/10 text-red-300 light:text-red-600 hover:bg-red-500/20"
            >
              <XCircle className="h-4 w-4" /> Reject
            </Button>
          </div>
          {closed && <p className="text-xs text-slate-500">This application is closed — its record is permanent history.</p>}
        </div>
      )}

      {/* reject dialog */}
      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent className="max-w-md border-white/10 light:border-slate-200 bg-slate-950 light:bg-slate-50">
          <DialogHeader><DialogTitle className="text-white light:text-slate-900">Reject {detail.applicationNumber}?</DialogTitle></DialogHeader>
          <p className="text-sm text-slate-400 light:text-slate-600">
            The applicant sees this reason on their status page. The record is never deleted — re-opening stays possible.
          </p>
          <Textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} rows={4}
            className="mt-3 bg-white/5 light:bg-slate-100 border-white/10 light:border-slate-200" placeholder="Reason (min 10 characters)…" />
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setRejectOpen(false)} className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-white light:text-slate-900">Cancel</Button>
            <Button
              disabled={rejectReason.trim().length < 10 || busy === "reject"}
              onClick={async () => {
                const ok = await onAction("reject", () => ownerRpc("owner.registrations.reject", {
                  id: detail.id, rejectionReason: rejectReason.trim(), reviewNote: reviewNote || undefined,
                }), "Application rejected — reason recorded and visible to the applicant.")
                if (ok) setRejectOpen(false)
              }}
              className="bg-red-600 text-white light:text-slate-900 hover:bg-red-500"
            >
              {busy === "reject" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Reject application"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* R12 — accept & invoice dialog (distinct workflow from approve) */}
      <Dialog open={acceptOpen} onOpenChange={setAcceptOpen}>
        <DialogContent className="max-w-lg border-white/10 light:border-slate-200 bg-slate-950 light:bg-slate-50">
          <DialogHeader><DialogTitle className="text-white light:text-slate-900">Accept {detail.organizationName} &amp; send first invoice</DialogTitle></DialogHeader>
          <p className="text-sm text-slate-400 light:text-slate-600">
            Provisions the tenant (same transaction as approve) <b>and</b> issues the first subscription invoice,
            then emails the applicant a payment request with the full invoice details. The invoice lands in
            Invoices &amp; Payments as PENDING.
          </p>
          <div className="mt-4 space-y-4">
            <div>
              <Label className="text-xs text-slate-400 light:text-slate-600">Plan (explicit at acceptance)</Label>
              <Select value={acceptPlanId} onValueChange={setAcceptPlanId}>
                <SelectTrigger className="mt-1.5 h-10 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {plans.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} · {p.currency === "BDT" ? "৳" : p.currency}{acceptCycle === "YEARLY" ? p.yearlyPrice.toLocaleString() : p.monthlyPrice.toLocaleString()}
                      {acceptCycle === "YEARLY" ? "/yr" : "/mo"} · {p.employeeLimit ? `${p.employeeLimit} emp` : "unlimited"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-4">
              <div className="flex-1">
                <Label className="text-xs text-slate-400 light:text-slate-600">Billing cycle</Label>
                <div className="mt-1.5 flex rounded-lg border border-white/10 light:border-slate-200 p-1">
                  {(["MONTHLY", "YEARLY"] as const).map((c) => (
                    <button key={c} type="button" onClick={() => setAcceptCycle(c)}
                      className={cn("flex-1 rounded-md px-3 py-1.5 text-xs font-semibold", acceptCycle === c ? "bg-white/10 light:bg-slate-200 text-white light:text-slate-900" : "text-slate-400 light:text-slate-600")}>
                      {c === "MONTHLY" ? "Monthly" : "Yearly"}
                    </button>
                  ))}
                </div>
              </div>
              <div className="w-24">
                <Label className="text-xs text-slate-400 light:text-slate-600">Trial days</Label>
                <Input type="number" min={0} max={90} value={acceptTrialDays}
                  onChange={(e) => setAcceptTrialDays(e.target.value)} className="mt-1.5 h-10 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100" />
              </div>
              <div className="w-28">
                <Label className="text-xs text-slate-400 light:text-slate-600">Due (days)</Label>
                <Input type="number" min={0} max={60} value={acceptDueDays}
                  onChange={(e) => setAcceptDueDays(e.target.value)} className="mt-1.5 h-10 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100"
                  title="0 = due on receipt" />
              </div>
            </div>

            {/* invoice preview — mirrors exactly what the server will write */}
            <div className="rounded-lg border border-indigo-400/25 bg-indigo-500/10 p-3.5 text-xs leading-relaxed text-indigo-100 light:text-indigo-800">
              <p className="font-bold uppercase tracking-widest text-[10px] text-indigo-300 light:text-indigo-600">Invoice preview</p>
              <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 font-mono tabular-nums">
                <span className="text-slate-400">To</span><span>{detail.adminEmail}</span>
                <span className="text-slate-400">Plan</span><span>{acceptPlan?.name || "—"}</span>
                <span className="text-slate-400">Period</span>
                <span>{acceptCycle === "YEARLY" ? "1 year" : "1 month"} (issued today{Number(acceptTrialDays) > 0 ? `, first ${acceptTrialDays} day(s) trial` : ""})</span>
                <span className="text-slate-400">Amount</span>
                <span className="font-bold">{acceptPlan ? fmtMoney(acceptCycle === "YEARLY" ? acceptPlan.yearlyPrice : acceptPlan.monthlyPrice, acceptPlan.currency) : "—"}</span>
                <span className="text-slate-400">Due</span>
                <span>{Number(acceptDueDays) > 0 ? `in ${acceptDueDays} day(s)` : "on receipt"}</span>
              </div>
              <p className="mt-2.5 not-italic text-indigo-200/80 light:text-indigo-700">
                The email carries the invoice number, period, amount, due date, payment instructions and the sign-in reminder.
              </p>
            </div>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setAcceptOpen(false)} className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-white light:text-slate-900">Cancel</Button>
            <Button
              disabled={!acceptPlanId || busy === "accept"}
              onClick={async () => {
                const ok = await onAction("accept", () => ownerRpc("owner.registrations.accept", {
                  id: detail.id,
                  planId: acceptPlanId,
                  billingCycle: acceptCycle,
                  reviewNote: reviewNote || undefined,
                  trialDays: Number(acceptTrialDays) || 0,
                  invoiceDueDays: Number(acceptDueDays) || 0,
                }), "Accepted — tenant provisioned, first invoice issued and emailed to the applicant.")
                if (ok) setAcceptOpen(false)
              }}
              className="bg-gradient-to-r from-indigo-600 to-blue-600 text-white hover:from-indigo-500 hover:to-blue-500"
            >
              {busy === "accept" ? <Loader2 className="h-4 w-4 animate-spin" /> : <>Accept &amp; send invoice <ChevronRight className="h-4 w-4" /></>}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* approve dialog */}
      <Dialog open={approveOpen} onOpenChange={setApproveOpen}>
        <DialogContent className="max-w-lg border-white/10 light:border-slate-200 bg-slate-950 light:bg-slate-50">
          <DialogHeader><DialogTitle className="text-white light:text-slate-900">Approve &amp; provision {detail.organizationName}</DialogTitle></DialogHeader>
          <p className="text-sm text-slate-400 light:text-slate-600">
            One transaction creates the tenant, the administrator (using the password chosen at registration), statutory
            configuration and the subscription. On failure nothing is created.
          </p>
          <div className="mt-4 space-y-4">
            <div>
              <Label className="text-xs text-slate-400 light:text-slate-600">Plan (explicit at approval)</Label>
              <Select value={approvePlanId} onValueChange={setApprovePlanId}>
                <SelectTrigger className="mt-1.5 h-10 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {plans.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} · {p.currency === "BDT" ? "৳" : p.currency}{approveCycle === "YEARLY" ? p.yearlyPrice.toLocaleString() : p.monthlyPrice.toLocaleString()}
                      {approveCycle === "YEARLY" ? "/yr" : "/mo"} · {p.employeeLimit ? `${p.employeeLimit} emp` : "unlimited"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-4">
              <div className="flex-1">
                <Label className="text-xs text-slate-400 light:text-slate-600">Billing cycle</Label>
                <div className="mt-1.5 flex rounded-lg border border-white/10 light:border-slate-200 p-1">
                  {(["MONTHLY", "YEARLY"] as const).map((c) => (
                    <button key={c} type="button" onClick={() => setApproveCycle(c)}
                      className={cn("flex-1 rounded-md px-3 py-1.5 text-xs font-semibold", approveCycle === c ? "bg-white/10 light:bg-slate-200 text-white light:text-slate-900" : "text-slate-400 light:text-slate-600")}>
                      {c === "MONTHLY" ? "Monthly" : "Yearly"}
                    </button>
                  ))}
                </div>
              </div>
              <div className="w-36">
                <Label className="text-xs text-slate-400 light:text-slate-600">Trial days (optional)</Label>
                <Input type="number" min={0} max={90} value={trialDays}
                  onChange={(e) => setTrialDays(e.target.value)} className="mt-1.5 h-10 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100" />
              </div>
            </div>
            <div className="rounded-lg border border-emerald-400/25 bg-emerald-500/10 p-3 text-xs leading-relaxed text-emerald-200 light:text-emerald-700">
              After provisioning, the administrator signs in at <span className="font-mono">/app</span> with{" "}
              <span className="font-mono">{detail.adminEmail}</span> and the password they chose at registration.
            </div>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setApproveOpen(false)} className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-white light:text-slate-900">Cancel</Button>
            <Button
              disabled={!approvePlanId || busy === "approve"}
              onClick={async () => {
                const ok = await onAction("approve", () => ownerRpc("owner.registrations.approve", {
                  id: detail.id,
                  planId: approvePlanId,
                  billingCycle: approveCycle,
                  reviewNote: reviewNote || undefined,
                  trialDays: Number(trialDays) || 0,
                }), "Approved — tenant provisioned and subscription attached. The administrator can sign in now.")
                if (ok) { setApproveOpen(false); onToast("Tenant provisioned. Record the outcome in billing if needed.") }
              }}
              className="bg-gradient-to-r from-emerald-600 to-teal-600 text-white light:text-slate-900 hover:from-emerald-500 hover:to-teal-500"
            >
              {busy === "approve" ? <Loader2 className="h-4 w-4 animate-spin" /> : <>Approve &amp; provision <ChevronRight className="h-4 w-4" /></>}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function InfoCard({ icon: Icon, title, children }: { icon: any; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-4">
      <p className="flex items-center gap-2 text-sm font-bold text-white light:text-slate-900">
        <Icon className="h-4 w-4 text-indigo-300 light:text-indigo-700" /> {title}
      </p>
      <dl className="mt-3 space-y-2">{children}</dl>
    </div>
  )
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[13px]">
      <dt className="shrink-0 text-slate-500">{k}</dt>
      {/* wrap long emails/addresses instead of truncating — the wide modal
          exists precisely so this information is fully readable */}
      <dd className="min-w-0 flex-1 text-right font-medium break-words text-slate-200 light:text-slate-800" title={v}>{v}</dd>
    </div>
  )
}
