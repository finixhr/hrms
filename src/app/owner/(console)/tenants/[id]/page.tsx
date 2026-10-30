"use client"
// ============ /owner/tenants/[id] — comprehensive tenant overview (§24) ============
import { use, useState } from "react"
import { CheckCircle2, Loader2, Lock, RotateCcw, PauseCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { ownerRpc, useOwnerApi } from "@/saas/owner/client"
import { TENANT_MODULES } from "@/hrm-server/saas/constants"
import { ErrorBanner, KpiCard, PageHeader, StatusChip, fmtDate, fmtDateTime, gb, Loading } from "@/saas/owner/ui"
import Link from "next/link"

export default function TenantDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  return <TenantDetailInner vendorId={id} />
}

function TenantDetailInner({ vendorId }: { vendorId: string }) {
  const { data, loading, error, reload } = useOwnerApi<any>("owner.tenants.get", { id: vendorId }, [vendorId])
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const run = async (label: string, fn: () => Promise<any>, after?: string) => {
    setBusy(label); setActionError(null)
    try {
      await fn()
      if (after) { setToast(after); setTimeout(() => setToast(null), 6000) }
      await reload()
    } catch (e: any) {
      setActionError(e?.message || "Action failed.")
    } finally { setBusy(null) }
  }

  if (loading) return <Loading label="Loading tenant…" />
  if (error) return <ErrorBanner message={error} />
  if (!data) return null

  const t = data.tenant
  const sub = data.subscription
  const ent = data.entitlements
  const u = data.usage

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/owner/tenants" className="text-xs text-slate-500 hover:text-slate-300 light:hover:text-slate-700">← Tenants</Link>
      </div>
      <PageHeader
        title={t.name}
        sub={<>code <span className="font-mono text-slate-400 light:text-slate-600">{t.code}</span> · created {fmtDate(t.createdAt)} · {t.active ? "active vendor record" : "inactive vendor record"}</>}
        actions={<StatusChip status={sub ? sub.status : "LEGACY"} />}
      />

      {toast && <div className="flex items-center gap-2 rounded-xl border border-emerald-400/30 bg-emerald-500/10 p-3 text-sm text-emerald-300 light:text-emerald-700"><CheckCircle2 className="h-4 w-4" /> {toast}</div>}
      {actionError && <ErrorBanner message={actionError} />}

      {/* usage KPIs */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Active employees" value={u.employees.toLocaleString()} sub={`limit: ${ent.limits.EMPLOYEES ?? "unlimited"}`} />
        <KpiCard label="Users" value={u.users} sub={`limit: ${ent.limits.USERS ?? "unlimited"}`} />
        <KpiCard label="Devices" value={u.devices} sub={`limit: ${ent.limits.DEVICES ?? "unlimited"}`} />
        <KpiCard label="Storage" value={`${gb(u.storageUsedBytes)} GB`} sub={`quota: ${ent.limits.STORAGE ?? "unlimited"} GB`} />
        <KpiCard label="Branches" value={u.branches} sub={`limit: ${ent.limits.BRANCHES ?? "unlimited"}`} />
        <KpiCard label="Departments" value={u.departments} sub={`limit: ${ent.limits.DEPARTMENTS ?? "unlimited"}`} />
        <KpiCard label="Live tracking" value={u.trackingEmployees} sub={`limit: ${ent.limits.TRACKING_EMPLOYEES ?? "unlimited"}`} />
        <KpiCard label="Workspace mode" value={ent.readonly ? "Read-only" : "Full access"} tone={ent.readonly ? "red" : "emerald"} sub={ent.mode === "LEGACY" ? "legacy tenant (pre-subscription)" : ent.status.toLowerCase()} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {/* modules */}
        <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-5">
          <p className="text-sm font-bold text-white light:text-slate-900">Module access (plan + overrides)</p>
          {ent.mode === "LEGACY" ? (
            <p className="mt-3 text-sm text-slate-400 light:text-slate-600">Legacy tenant — all modules, no metered limits. Overrides can still disable specific modules.</p>
          ) : (
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {Object.entries(ent.features).map(([k, on]: any) => {
                // module-consistency round — a feature row is "overridden" when
                // ANY module gated by that feature carries an explicit toggle
                // (feature flag itself may be flipped by an override).
                const gatedMods = TENANT_MODULES.filter((m) => m.feature === k)
                const overridden = gatedMods.some((m) => typeof ent.overrides?.[m.key] === "boolean")
                return (
                  <div key={k} className={cn(
                    "rounded-lg border p-2.5 text-[12px] font-medium",
                    on ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-200 light:text-emerald-700" : "border-white/10 light:border-slate-200 text-slate-500"
                  )}>
                    {k.replace(/_/g, " ").toLowerCase()}{overridden && " (override)"}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* subscription (R13 — polished plan summary: price + term + countdown) */}
        <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-5">
          <p className="text-sm font-bold text-white light:text-slate-900">Subscription</p>
          {sub ? (
            <>
              <div className="mt-3 grid grid-cols-3 gap-3">
                <div className="rounded-xl border border-emerald-400/25 bg-emerald-500/10 px-3.5 py-3">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-emerald-300/80">Plan</p>
                  <p className="mt-0.5 text-sm font-bold text-white light:text-slate-900 truncate" title={sub.planName}>{sub.planName || "—"}</p>
                  <p className="text-[11px] text-slate-400">{sub.billingCycle.toLowerCase()}</p>
                </div>
                <div className="rounded-xl border border-indigo-400/25 bg-indigo-500/10 px-3.5 py-3">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-indigo-300/80">Price at assignment</p>
                  <p className="mt-0.5 text-sm font-bold text-white light:text-slate-900 tabular-nums">
                    {sub.currency === "BDT" ? "৳" : `${sub.currency || ""} `}{Number(sub.priceAtCreation).toLocaleString()}
                  </p>
                  <p className="text-[11px] text-slate-400">snapshot at assignment</p>
                </div>
                <div className="rounded-xl border border-amber-400/25 bg-amber-500/10 px-3.5 py-3">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-amber-300/80">Term ends</p>
                  <p className="mt-0.5 text-sm font-bold text-white light:text-slate-900 tabular-nums">{fmtDate(sub.endDate)}</p>
                  <p className="text-[11px] text-slate-400">
                    {daysLeftLabel(sub.endDate, sub.status)}
                  </p>
                </div>
              </div>
              <div className="mt-3 space-y-2 text-[13px]">
                <Row k="Start" v={fmtDate(sub.startDate)} />
                <Row k="Status" v={sub.status} />
                <Row k="History events" v={`${sub.history.length}`} />
              </div>
            </>
          ) : (
            <p className="mt-3 text-sm text-slate-400 light:text-slate-600">No subscription row — this tenant predates the SaaS layer.</p>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            {sub && (
              <>
                {sub.status !== "SUSPENDED" ? (
                  <SuspendDialog onConfirm={(reason) => run("suspend", () => ownerRpc("owner.tenants.suspend", { id: vendorId, reason }), "Tenant suspended — workspace is read-only.")} busy={busy === "suspend"} />
                ) : (
                  <Button size="sm" disabled={busy === "reactivate"}
                    onClick={() => run("reactivate", () => ownerRpc("owner.tenants.reactivate", { id: vendorId }), "Tenant reactivated.")}
                    className="bg-emerald-600 text-white light:text-slate-900 hover:bg-emerald-500">
                    <RotateCcw className="h-4 w-4" /> Reactivate
                  </Button>
                )}
                <ChangePlanDialog
                  currentPlanId={sub.planId}
                  currentCycle={sub.billingCycle}
                  onApply={(planId, cycle, note) => run("changePlan", () => ownerRpc("owner.subscriptions.changePlan", { id: vendorId, planId, billingCycle: cycle, note }), "Plan changed and recorded in history.")}
                  busy={busy === "changePlan"}
                />
                <ExtendDialog
                  onApply={(months, days, note) => run("extend", () => ownerRpc("owner.subscriptions.extend", { id: vendorId, months, days, note }), "Subscription extended.")}
                  busy={busy === "extend"}
                />
              </>
            )}
            <OverrideDialog
              current={ent}
              onApply={(toggles, storageGb, note) => run("override", () => ownerRpc("owner.tenants.setOverride", {
                id: vendorId, featureToggles: toggles, storageGbOverride: storageGb, note,
              }), "Overrides applied — enforced server-side immediately.")}
              busy={busy === "override"}
            />
          </div>
        </div>
      </div>

      {/* subscription history */}
      {sub && (
        <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-5">
          <p className="text-sm font-bold text-white light:text-slate-900">Subscription history</p>
          {sub.history.length === 0 ? <p className="mt-3 text-sm text-slate-500">No events yet.</p> : (
            <div className="mt-3 space-y-1.5">
              {sub.history.map((h: any) => (
                <div key={h.id} className="flex items-center gap-3 rounded-lg border border-white/5 light:border-slate-200 bg-white/[0.02] light:bg-slate-50 px-3 py-2 text-sm">
                  <span className="rounded-full border border-white/15 light:border-slate-300 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-slate-400 light:text-slate-600">{h.type.replace(/_/g, " ")}</span>
                  <span className="text-slate-300 light:text-slate-700">{h.note || (h.to?.plan ? `→ ${h.to.plan}` : "—")}</span>
                  <span className="ml-auto text-xs text-slate-500">{fmtDateTime(h.createdAt)}{h.actorName ? ` · ${h.actorName}` : ""}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* R15 — expiry-notice journal for this tenant (deduped, retry-aware) */}
      {data.expiryNotices && data.expiryNotices.length > 0 && (
        <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-5">
          <p className="text-sm font-bold text-white light:text-slate-900">Expiry notices sent</p>
          <p className="mt-1 text-xs text-slate-500">Automated renewal/rejoin reminders (email + SMS) with retries — the journal the scheduler dedupes against.</p>
          <div className="mt-3 space-y-1.5">
            {data.expiryNotices.map((n: any) => (
              <div key={n.id} className="flex flex-wrap items-baseline gap-2 rounded-lg border border-white/5 light:border-slate-200 bg-white/[0.02] light:bg-slate-50 px-3 py-2 text-xs">
                <span className={cn("rounded-full border px-2 py-0.5 font-bold tracking-wide",
                  n.status === "SENT" ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-300" : n.status === "FAILED" ? "border-red-400/30 bg-red-500/10 text-red-300" : "border-slate-400/30 bg-slate-500/10 text-slate-400")}>
                  {n.status}
                </span>
                <span className="font-medium text-slate-200 light:text-slate-800">
                  {n.kind === "PRE_EXPIRY" ? `${n.daysOffset} day(s) before` : n.kind === "POST_EXPIRY" ? `${Math.abs(n.daysOffset)} day(s) after` : n.kind.toLowerCase()} · {n.channel.toLowerCase()}
                </span>
                <span className="text-slate-500">ref {n.refDate}{n.attempts > 1 ? ` · ${n.attempts} attempts` : ""}{n.detail ? ` · ${n.detail.slice(0, 60)}` : ""}</span>
                <span className="ml-auto text-slate-500">{fmtDateTime(n.sentAt)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* platform audit for this tenant */}
      <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-5">
        <p className="flex items-center gap-2 text-sm font-bold text-white light:text-slate-900"><Lock className="h-4 w-4 text-indigo-300 light:text-indigo-700" /> Platform actions on this tenant</p>
        {(!data.audit || data.audit.length === 0) ? <p className="mt-3 text-sm text-slate-500">No platform actions recorded.</p> : (
          <div className="mt-3 space-y-1.5">
            {data.audit.map((a: any) => (
              <div key={a.id} className="rounded-lg border border-white/5 light:border-slate-200 bg-white/[0.02] light:bg-slate-50 px-3 py-2 text-sm">
                <span className="font-medium text-slate-200 light:text-slate-800">{a.action.replace(/_/g, " ").toLowerCase()}</span>
                <span className="text-slate-400 light:text-slate-600"> — {a.summary}</span>
                <span className="ml-2 text-xs text-slate-500">{fmtDateTime(a.createdAt)} · {a.actorName}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function daysLeftLabel(endDate: string | Date, status: string): string {
  const days = Math.ceil((new Date(endDate).getTime() - Date.now()) / 86400000)
  if (status === "EXPIRED" || days < 0) return `expired ${Math.abs(days)} day(s) ago`
  if (days === 0) return "ends today"
  if (days <= 7) return `${days} day(s) left — renewing soon`
  return `${days} day(s) left`
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3 rounded-lg bg-white/[0.02] light:bg-slate-50 px-3 py-2">
      <span className="text-slate-500">{k}</span><span className="font-medium text-slate-200 light:text-slate-800">{v}</span>
    </div>
  )
}

function SuspendDialog({ onConfirm, busy }: { onConfirm: (reason: string) => void; busy: boolean }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} className="border-red-400/30 bg-red-500/10 text-red-300 light:text-red-600 hover:bg-red-500/20">
        <PauseCircle className="h-4 w-4" /> Suspend
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md border-white/10 light:border-slate-200 bg-slate-950 light:bg-slate-50">
          <DialogHeader><DialogTitle className="text-white light:text-slate-900">Suspend this tenant?</DialogTitle></DialogHeader>
          <p className="text-sm text-slate-400 light:text-slate-600">The workspace becomes read-only (data stays safe). Requires a reason — recorded in the audit log.</p>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} className="mt-3 bg-white/5 light:bg-slate-100 border-white/10 light:border-slate-200" placeholder="Reason (min 5 characters)…" />
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setOpen(false)} className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-white light:text-slate-900">Cancel</Button>
            <Button disabled={reason.trim().length < 5 || busy} onClick={() => { onConfirm(reason.trim()); setOpen(false) }} className="bg-red-600 text-white light:text-slate-900 hover:bg-red-500">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Suspend tenant"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function ChangePlanDialog({ currentPlanId, currentCycle, onApply, busy }: {
  currentPlanId: string; currentCycle: string; onApply: (planId: string, cycle: "MONTHLY" | "YEARLY", note?: string) => void; busy: boolean
}) {
  const [open, setOpen] = useState(false)
  const { data } = useOwnerApi<{ plans: any[] }>("owner.plans.forApproval", {})
  const [planId, setPlanId] = useState(currentPlanId)
  const [cycle, setCycle] = useState<"MONTHLY" | "YEARLY">(currentCycle === "YEARLY" ? "YEARLY" : "MONTHLY")
  const [note, setNote] = useState("")
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => { setPlanId(currentPlanId); setOpen(true) }} className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-white light:text-slate-900 hover:bg-white/10 light:hover:bg-slate-200">
        Change plan
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md border-white/10 light:border-slate-200 bg-slate-950 light:bg-slate-50">
          <DialogHeader><DialogTitle className="text-white light:text-slate-900">Change plan</DialogTitle></DialogHeader>
          <p className="text-sm text-slate-400 light:text-slate-600">Upgrade or downgrade — the previous state is preserved in the subscription history. A cycle change re-anchors the end date from today.</p>
          <div className="mt-4 space-y-3">
            <Select value={planId} onValueChange={setPlanId}>
              <SelectTrigger className="h-10 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(data?.plans || []).map((p: any) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <div className="flex rounded-lg border border-white/10 light:border-slate-200 p-1">
              {(["MONTHLY", "YEARLY"] as const).map((c) => (
                <button key={c} type="button" onClick={() => setCycle(c)}
                  className={cn("flex-1 rounded-md px-3 py-1.5 text-xs font-semibold", cycle === c ? "bg-white/10 light:bg-slate-200 text-white light:text-slate-900" : "text-slate-400 light:text-slate-600")}>
                  {c === "MONTHLY" ? "Monthly" : "Yearly"}
                </button>
              ))}
            </div>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Note for the history record…" className="bg-white/5 light:bg-slate-100 border-white/10 light:border-slate-200" />
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setOpen(false)} className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-white light:text-slate-900">Cancel</Button>
            <Button disabled={!planId || busy} onClick={() => { onApply(planId, cycle, note || undefined); setOpen(false) }} className="bg-gradient-to-r from-blue-600 to-violet-600 text-white light:text-slate-900">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Apply change"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function ExtendDialog({ onApply, busy }: { onApply: (months?: number, days?: number, note?: string) => void; busy: boolean }) {
  const [open, setOpen] = useState(false)
  const [months, setMonths] = useState("1")
  const [days, setDays] = useState("")
  const [note, setNote] = useState("")
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-white light:text-slate-900 hover:bg-white/10 light:hover:bg-slate-200">
        Extend
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md border-white/10 light:border-slate-200 bg-slate-950 light:bg-slate-50">
          <DialogHeader><DialogTitle className="text-white light:text-slate-900">Extend subscription</DialogTitle></DialogHeader>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs text-slate-400 light:text-slate-600">Months</Label>
              <Input type="number" min={1} max={36} value={months} onChange={(e) => setMonths(e.target.value)} className="mt-1.5 h-10 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100" />
            </div>
            <div>
              <Label className="text-xs text-slate-400 light:text-slate-600">…or days</Label>
              <Input type="number" min={1} max={1095} value={days} onChange={(e) => setDays(e.target.value)} placeholder="0" className="mt-1.5 h-10 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100" />
            </div>
          </div>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Why (goodwill, payment delay…)" className="mt-3 bg-white/5 light:bg-slate-100 border-white/10 light:border-slate-200" />
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setOpen(false)} className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-white light:text-slate-900">Cancel</Button>
            <Button disabled={busy} onClick={() => { onApply(Number(months) || undefined, Number(days) || undefined, note || undefined); setOpen(false) }} className="bg-gradient-to-r from-blue-600 to-violet-600 text-white light:text-slate-900">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Extend"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function OverrideDialog({ current, onApply, busy }: {
  current: any
  onApply: (toggles: Record<string, boolean>, storageGb: number | null, note?: string) => void
  busy: boolean
}) {
  const [open, setOpen] = useState(false)
  // 2026-10 module-consistency round — the override dialog now offers EVERY
  // tenant module from the authoritative catalog (TENANT_MODULES in
  // src/hrm-server/saas/constants.ts), not just the plan-gated 16: core
  // modules (calendar, tasks, letters, communication, exit, reports, …) can
  // also be forced on/off per tenant. Pure constants module — safe in a client
  // component, and the list can never drift from the entitlement engine again.
  const GATED = TENANT_MODULES.filter((m) => m.feature)
  const CORE = TENANT_MODULES.filter((m) => !m.feature)
  const renderToggle = (m: { key: string; label: string; feature?: string }) => {
    const state = toggles[m.key]
    return (
      <button key={m.key} type="button" title={`Module key: ${m.key}`}
        onClick={() => setToggles((s) => ({ ...s, [m.key]: s[m.key] === undefined ? false : undefined as any }))}
        className={cn(
          "rounded-lg border px-2 py-1.5 text-[11px] font-semibold",
          state === true ? "border-emerald-400/40 bg-emerald-500/15 text-emerald-200 light:text-emerald-700"
          : state === false ? "border-red-400/40 bg-red-500/15 text-red-200 light:text-red-600"
          : "border-white/10 light:border-slate-200 text-slate-500"
        )}>
        {m.label}{state === true ? " ON" : state === false ? " off" : m.feature ? " (plan)" : " (core on)"}
      </button>
    )
  }
  const [toggles, setToggles] = useState<Record<string, boolean>>(current.overrides || {})
  const [storageGb, setStorageGb] = useState(current.storageGbOverride != null ? String(current.storageGbOverride) : "")
  const [note, setNote] = useState("")
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} className="border-amber-400/30 bg-amber-500/10 text-amber-300 light:text-amber-700 hover:bg-amber-500/20">
        Overrides
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl border-white/10 light:border-slate-200 bg-slate-950 light:bg-slate-50 max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle className="text-white light:text-slate-900">Per-tenant module overrides</DialogTitle></DialogHeader>
          <p className="text-sm text-slate-400 light:text-slate-600">
            Overrides beat the plan for THIS tenant only. Use sparingly (support grace, incidents) — every change is audited.
          </p>
          <p className="text-[11px] leading-relaxed text-slate-500">
            Every HRM workspace module is controllable here — plan-gated modules show &quot;(plan)&quot; until overridden; core modules show
            &quot;(core on)&quot;. &quot;ON&quot; forces a module on, &quot;off&quot; forces it off (also hidden from the tenant&apos;s navigation).
            Server-side enforcement applies immediately on the next request.
          </p>
          <div className="mt-4">
            <p className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-500">Plan-gated modules</p>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
              {GATED.map(renderToggle)}
            </div>
          </div>
          <div className="mt-3">
            <p className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-500">Core modules</p>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
              {CORE.map(renderToggle)}
            </div>
          </div>
          <div className="mt-4">
            <Label className="text-xs text-slate-400 light:text-slate-600">Storage quota override (GB) — empty = plan value</Label>
            <Input value={storageGb} onChange={(e) => setStorageGb(e.target.value)} type="number" min={1} max={10000}
              className="mt-1.5 h-10 w-40 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100" />
          </div>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Why this override…" className="mt-3 bg-white/5 light:bg-slate-100 border-white/10 light:border-slate-200" />
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setOpen(false)} className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-white light:text-slate-900">Cancel</Button>
            <Button disabled={busy} onClick={() => {
              const clean = Object.fromEntries(Object.entries(toggles).filter(([, v]) => v !== undefined)) as Record<string, boolean>
              onApply(clean, storageGb === "" ? null : Number(storageGb), note || undefined)
              setOpen(false)
            }} className="bg-amber-600 text-white light:text-slate-900 hover:bg-amber-500">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Apply overrides"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
