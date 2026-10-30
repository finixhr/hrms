"use client"
// ============ Attendance Security Events — review workflow (2026-10 round §25, §35) ============
// Queue of suspicious / review-required attendance events. Admins inspect the
// integrity signals, view the selfie proof (audited) and APPROVE or REJECT.
// Nothing is auto-rejected on anomaly (§25): REVIEW parks it here.
import { useMemo, useState } from "react"
import { Camera, CheckCircle2, Loader2, ShieldAlert, XCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useHrm } from "../store"
import { rpc, useApi } from "../api"
import { SectionCard, StatusBadge, EmptyState, SelfieViewer, fmtDateTime } from "../shared/ui-kit"
import { DataTable, type Column } from "../shared/data-table"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"

// M-29 — alias onto the shared, locale-aware formatter (was a local en-GB duplicate)
const fmtTime = fmtDateTime

export default function SecurityEventsTab() {
  const { can, toast } = useHrm()
  const [page, setPage] = useState(1)
  const [selfie, setSelfie] = useState<{ url: string; who: string } | null>(null)
  const [rejecting, setRejecting] = useState<any | null>(null)
  const [reason, setReason] = useState("")
  const [busyId, setBusyId] = useState<string | null>(null)

  const { data, loading, reload } = useApi<any>("attendance.events.list", {
    reviewStatus: "PENDING",
    page, size: 50,
  })
  const events = useMemo(() => data?.events ?? [], [data])
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / 50))

  const decide = async (ev: any, decision: "APPROVE" | "REJECT", why?: string) => {
    setBusyId(ev.id)
    try {
      await rpc("attendance.events.review", { id: ev.id, decision, reason: why })
      toast(`Event ${decision === "APPROVE" ? "approved" : "rejected"} for ${ev.employeeName}`)
      setRejecting(null)
      setReason("")
      reload()
    } catch (e: any) {
      toast(String(e?.message || e), "err")
    } finally {
      setBusyId(null)
    }
  }

  const viewSelfie = async (ev: any) => {
    if (!ev.selfieProofId) return
    setBusyId(ev.id)
    try {
      const r = await rpc("attendance.selfie.view", { id: ev.selfieProofId })
      setSelfie({ url: r.dataUrl, who: `${ev.employeeName} · ${fmtTime(ev.occurredAt)}` })
    } catch (e: any) {
      toast(String(e?.message || e), "err")
    } finally {
      setBusyId(null)
    }
  }

  const columns: Column<any>[] = [
    { key: "employeeName", label: "Employee", render: (r) => (
      <div>
        <p className="font-medium">{r.employeeName}</p>
        <p className="text-[11px] text-slate-400">{r.employeeCode}</p>
      </div>
    ) },
    { key: "occurredAt", label: "When", render: (r) => <span className="tabular-nums text-xs">{fmtTime(r.occurredAt)}</span> },
    { key: "eventType", label: "Event", render: (r) => <span className="text-xs font-medium">{r.eventType.replace(/_/g, " ")}</span> },
    { key: "integrity", label: "Integrity", render: (r) => (
      <div className="flex flex-col gap-1">
        {r.locationIntegrityStatus && (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-purple-700 dark:text-purple-300">
            <ShieldAlert className="h-3.5 w-3.5" />{r.locationIntegrityStatus.replace(/_/g, " ")}
          </span>
        )}
        {r.gpsStatus === "DISABLED" && <span className="text-[11px] text-rose-600">GPS disabled</span>}
        <StatusBadge status={r.status} />
      </div>
    ) },
    { key: "signals", label: "Signals", render: (r) => {
      let flags: any = {}
      try { flags = JSON.parse(r.flagsJson || "{}") } catch { /* ignore */ }
      const sigs: string[] = flags.signals ?? []
      return sigs.length ? (
        <div className="flex flex-wrap gap-1 max-w-56">
          {sigs.slice(0, 3).map((s, i) => (
            <span key={i} className="text-[10px] rounded bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-900 px-1.5 py-0.5">{s.replace(/_/g, " ")}</span>
          ))}
          {sigs.length > 3 && <span className="text-[10px] text-slate-400">+{sigs.length - 3} more</span>}
        </div>
      ) : <span className="text-slate-300 text-xs">—</span>
    } },
    { key: "location", label: "Position", render: (r) => r.latitude != null ? (
      <span className="text-[11px] tabular-nums text-slate-500">{r.latitude.toFixed(4)}, {r.longitude?.toFixed(4)}{r.distanceFromGeoFenceM != null ? ` · ${r.distanceFromGeoFenceM}m from fence` : ""}</span>
    ) : <span className="text-slate-300">—</span> },
    { key: "actions", label: "Review", render: (r) => (
      <div className="flex items-center gap-1.5">
        {r.selfieProofId && (
          <Button variant="ghost" size="sm" className="h-7 px-2" disabled={busyId === r.id} onClick={() => viewSelfie(r)} title="View selfie proof (audited)">
            <Camera className="h-3.5 w-3.5" />
          </Button>
        )}
        {can("attendance", "verify") && (
          <>
            <Button variant="outline" size="sm" className="h-7 px-2.5 text-emerald-600 border-emerald-200 hover:bg-emerald-50" disabled={busyId === r.id} onClick={() => decide(r, "APPROVE")}>
              <CheckCircle2 className="h-3.5 w-3.5" />
            </Button>
            <Button variant="outline" size="sm" className="h-7 px-2.5 text-rose-600 border-rose-200 hover:bg-rose-50" disabled={busyId === r.id} onClick={() => setRejecting(r)}>
              <XCircle className="h-3.5 w-3.5" />
            </Button>
          </>
        )}
      </div>
    ) },
  ]

  return (
    <div className="space-y-4">
      <SectionCard
        title={<span>Security Review Queue <span className="text-slate-400 font-normal">· {data?.total ?? 0} pending review</span></span>}
        actions={totalPages > 1 ? (
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>Prev</Button>
            <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>Next</Button>
          </div>
        ) : undefined}
      >
        {loading ? (
          <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-slate-300" /></div>
        ) : events.length ? (
          <DataTable columns={columns} rows={events} />
        ) : (
          <EmptyState icon={ShieldAlert} title="No pending security reviews" hint="Suspicious or low-confidence attendance events land here for a human decision." />
        )}
      </SectionCard>

      {/* M-29 — the ONE shared selfie viewer (was a divergent copy) */}
      <SelfieViewer selfie={selfie} onClose={() => setSelfie(null)} />

      {/* rejection reason (§87 actionable feedback) */}
      <Dialog open={!!rejecting} onOpenChange={(o) => { if (!o) { setRejecting(null); setReason("") } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-sm">Reject event for {rejecting?.employeeName}?</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-slate-500">The employee is notified that their {rejecting?.eventType?.replace(/_/g, " ").toLowerCase()} was rejected after review.</p>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional, shown to the employee)…" className="text-xs min-h-20" />
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => { setRejecting(null); setReason("") }}>Cancel</Button>
            <Button variant="destructive" size="sm" disabled={busyId === rejecting?.id} onClick={() => decide(rejecting, "REJECT", reason.trim() || undefined)}>
              {busyId === rejecting?.id ? <Loader2 className="h-4 w-4 animate-spin" /> : "Reject Event"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
