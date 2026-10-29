"use client"
// ============ Performance & KPI: review cycles, 9-area reviews, KPI templates & assignments ============
// Reviews are unique per (cycle, employee); KPI template weights must total 100%.
import { useEffect, useState } from "react"
import {
  ClipboardCheck, Plus, Pencil, Trash2, Star, Target, TrendingUp, Award, Lock, Gauge, Users, X, UserRound,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useHrm } from "../store"
import { useApi, rpc, useEmployeeDirectory } from "../api"
import { PageHeader, StatCard, StatusBadge, fmtDate, SectionTabs, SectionCard, EmptyState, RatingStars } from "../shared/ui-kit"
import { DataTable, type Column } from "../shared/data-table"
import { FormDialog, ConfirmDialog, type FieldDef } from "../shared/form-dialog"

// 9 review areas (spec §11.1) — [key, label]
const REVIEW_AREAS: [string, string][] = [
  ["attendance", "Attendance"], ["punctuality", "Punctuality"], ["productivity", "Productivity"],
  ["quality", "Quality of Work"], ["teamwork", "Teamwork"], ["communication", "Communication"],
  ["customerService", "Customer Service"], ["leadership", "Leadership"], ["targetAchievement", "Target Achievement"],
]
const RATING_WORDS = ["", "Poor", "Fair", "Satisfactory", "Good", "Excellent"]

export default function PerformanceView() {
  // global-search deep link: pre-select a tab (params arrive with the view)
  const presetTab = useHrm((s) => (s.view?.key === "performance" && s.view?.params?.tab) || undefined)
  return (
    <div className="space-y-4">
      <PageHeader title="Performance & KPI" subtitle="Review cycles with 9-area ratings, weighted KPI templates, assignments and analytics" />
      <SectionTabs defaultValue={presetTab as string | undefined} tabs={[
        { value: "reviews", label: "Reviews", content: <ReviewsTab /> },
        { value: "templates", label: "KPI Templates", content: <KpiTemplatesTab /> },
        { value: "assignments", label: "KPI Assignments", content: <KpiAssignmentsTab /> },
        { value: "analytics", label: "Analytics", content: <AnalyticsTab /> },
      ]} />
    </div>
  )
}

// ================= REVIEWS =================
function ReviewsTab() {
  const { can, navigate } = useHrm()
  const { data: cycles } = useApi<any[]>("cycles.list", {})
  const { data: employees } = useEmployeeDirectory()
  const [cycleId, setCycleId] = useState("all")
  // 2026-10-14 — Employee Actions deep link (employee 360° → "Performance"):
  // server-side pre-filter to ONE employee until cleared (✕ chip).
  // reviews.list has always accepted employeeId.
  const presetEmployeeId = useHrm((s) => (s.view?.key === "performance" ? ((s.view?.params as any)?.employeeId as string | undefined) : undefined))
  const { data, loading, error, reload } = useApi<any[]>("reviews.list", {
    cycleId: cycleId === "all" ? "" : cycleId,
    ...(presetEmployeeId ? { employeeId: presetEmployeeId } : {}),
  })
  const [reviewOpen, setReviewOpen] = useState(false)
  const [editRec, setEditRec] = useState<any>(null)
  const [detail, setDetail] = useState<any>(null)
  const [cycleOpen, setCycleOpen] = useState(false)
  const [finalizeTarget, setFinalizeTarget] = useState<any>(null)

  const ratingFields: FieldDef[] = REVIEW_AREAS.map(([key, label]) => ({
    name: `rating_${key}`, label,
    type: "select" as const,
    options: [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `${n} · ${RATING_WORDS[n]}` })),
    defaultValue: "3",
  }))

  const fields: FieldDef[] = [
    { name: "employeeId", label: "Employee", type: "select", required: true, options: (employees || []).map((e: any) => ({ value: e.id, label: `${e.fullName} (${e.code})` })) },
    { name: "cycleId", label: "Review Cycle", type: "select", required: true, options: (cycles || []).map((c: any) => ({ value: c.id, label: `${c.name} (${c.year})` })) },
    { name: "reviewerId", label: "Reviewer", type: "select", options: (employees || []).map((e: any) => ({ value: e.id, label: e.fullName })) },
    { name: "status", label: "Save As", type: "select", options: [{ value: "DRAFT", label: "Draft" }, { value: "SUBMITTED", label: "Submitted" }], defaultValue: "SUBMITTED", help: "Submitted reviews can be finalized." },
    ...ratingFields,
    { name: "managerComments", label: "Manager Comments", type: "textarea", span: 2, rows: 2 },
    { name: "employeeComments", label: "Employee Comments", type: "textarea", span: 2, rows: 2 },
    { name: "strengths", label: "Strengths", type: "textarea", span: 2, rows: 2 },
    { name: "weaknesses", label: "Weaknesses", type: "textarea", span: 2, rows: 2 },
    { name: "goals", label: "Goals", type: "textarea", span: 2, rows: 2 },
    { name: "improvementPlan", label: "Improvement Plan", type: "textarea", span: 2, rows: 2 },
    // PRF-01 (R7) — peer input, one colleague per line
    { name: "peerInput", label: "Peer Input (one colleague per line, optional)", type: "textarea", span: 2, rows: 3, placeholder: "Kamal Hossain: teamwork=4, communication=5; strong collaborator on the ERP rollout\nNusrat Jahan: quality=5; meticulous QA feedback" },
  ]

  const editInitial = editRec ? {
    employeeId: editRec.employeeId,
    cycleId: editRec.cycleId,
    reviewerId: editRec.reviewerId || "",
    status: editRec.status === "FINAL" ? "SUBMITTED" : editRec.status,
    managerComments: editRec.managerComments || "",
    employeeComments: editRec.employeeComments || "",
    strengths: editRec.strengths || "",
    weaknesses: editRec.weaknesses || "",
    goals: editRec.goals || "",
    improvementPlan: editRec.improvementPlan || "",
    ...Object.fromEntries(REVIEW_AREAS.map(([k]) => [`rating_${k}`, editRec.ratings?.[k] != null ? String(editRec.ratings[k]) : ""])),
  } : undefined

  const columns: Column<any>[] = [
    {
      key: "employeeName", label: "Employee", sortValue: (r) => r.employeeName,
      render: (r) => (
        <div>
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{r.employeeName}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">{r.cycleName}</p>
        </div>
      ),
    },
    { key: "overallRating", label: "Overall", sortValue: (r) => r.overallRating || 0, render: (r) => <RatingStars value={Number(r.overallRating || 0)} /> },
    { key: "status", label: "Status", render: (r) => <StatusBadge status={r.status} /> },
    { key: "reviewerName", label: "Reviewer", render: (r) => <span className="text-xs text-slate-600 dark:text-slate-300">{r.reviewerName || "—"}</span> },
    { key: "submittedAt", label: "Submitted", sortValue: (r) => r.submittedAt || "", render: (r) => <span className="text-xs text-slate-500">{r.submittedAt ? fmtDate(r.submittedAt) : "—"}</span> },
    {
      key: "actions", label: "", align: "right", render: (r) => (
        <div className="flex gap-1">
          {can("performance", "create") && r.status !== "FINAL" && (
            <Button size="icon" variant="ghost" className="h-7 w-7" title="Edit review"
              onClick={(ev) => { ev.stopPropagation(); setEditRec(r); setReviewOpen(true) }}>
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          )}
          {can("performance", "approve") && ["SUBMITTED", "ACKNOWLEDGED"].includes(r.status) && (
            <Button size="icon" variant="ghost" className="h-7 w-7 text-amber-600 hover:text-amber-700" title="Finalize review"
              onClick={(ev) => { ev.stopPropagation(); setFinalizeTarget(r) }}>
              <Lock className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-full sm:w-60">
          <Select value={cycleId} onValueChange={setCycleId}>
            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Cycle" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All cycles</SelectItem>
              {(cycles || []).map((c: any) => (
                <SelectItem key={c.id} value={c.id}>{c.name} · {c.year}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {presetEmployeeId && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 dark:bg-emerald-950/40 pl-2.5 pr-1 py-0.5 text-[11px] text-emerald-800 dark:text-emerald-300">
            <UserRound className="h-3 w-3" />
            {(employees || []).find((e: any) => e.id === presetEmployeeId)?.fullName || "Selected employee"}
            <button type="button" title="Clear the employee filter" onClick={() => navigate("performance", { tab: "reviews" })}
              className="h-4 w-4 rounded-full inline-flex items-center justify-center hover:bg-emerald-200 dark:hover:bg-emerald-900">
              <X className="h-2.5 w-2.5" />
            </button>
          </span>
        )}
        {can("performance", "create") && (
          <Button size="sm" onClick={() => { setEditRec(null); setReviewOpen(true) }} className="h-8 ">
            <Plus className="h-3.5 w-3.5 mr-1" /> New Review
          </Button>
        )}
        {can("performance", "create") && (
          <Button size="sm" variant="outline" onClick={() => setCycleOpen(true)} className="h-8 text-xs">
            <Plus className="h-3.5 w-3.5 mr-1" /> New Cycle
          </Button>
        )}
      </div>

      <DataTable columns={columns} rows={data ?? undefined} loading={loading} error={error} csvName="performance-reviews"
        searchPlaceholder="Search employee…" onRowClick={(r) => setDetail(r)}
        emptyTitle="No reviews yet" emptyHint="Create a review cycle, then add the first performance review." />

      <FormDialog open={reviewOpen} onOpenChange={(v) => { setReviewOpen(v); if (!v) { setEditRec(null); reload() } }}
        title={editRec ? `Edit Review — ${editRec.employeeName}` : "New Performance Review"} wide
        description="One review per employee per cycle — saving the same employee + cycle updates it. Overall rating is the mean of the 9 areas."
        fields={fields} initial={editInitial}
        onSubmit={async (v) => {
          const ratings: Record<string, number> = {}
          for (const [k] of REVIEW_AREAS) {
            const rv = v[`rating_${k}`]
            if (rv !== "" && rv != null) ratings[k] = Number(rv)
          }
          // PRF-01 (R7) — peer input (optional): one colleague per line as
          // "Name: area=rating, ...; comment" — normalized server-side.
          const peerInputs: any[] = []
          const peerLines = String(v.peerInput || "").split("\n").map((l: string) => l.trim()).filter(Boolean)
          for (const line of peerLines.slice(0, 10)) {
            const [namePart, rest] = line.split(":")
            if (!namePart?.trim() || !rest?.trim()) continue
            const peer: any = { name: namePart.trim(), ratings: {} }
            for (const chunk of rest.split(";")) {
              const c = chunk.trim()
              if (!c) continue
              const m = c.match(/^([a-zA-Z]+)\s*=\s*([1-5])$/)
              if (m) peer.ratings[m[1].toLowerCase()] = Number(m[2])
              else peer.comments = c
            }
            peerInputs.push(peer)
          }
          await rpc("reviews.save", {
            cycleId: v.cycleId, employeeId: v.employeeId, reviewerId: v.reviewerId || undefined,
            ratings, status: v.status,
            managerComments: v.managerComments, employeeComments: v.employeeComments,
            strengths: v.strengths, weaknesses: v.weaknesses, goals: v.goals, improvementPlan: v.improvementPlan,
            ...(peerInputs.length ? { peerInputs } : {}),
          })
        }} />

      <FormDialog open={cycleOpen} onOpenChange={(v) => { setCycleOpen(v); if (!v) reload() }}
        title="New Review Cycle" description="Reviews are grouped by cycle (e.g. 2026 Annual Performance Review)."
        fields={[
          { name: "name", label: "Cycle Name", required: true, span: 2, placeholder: "2026 Annual Performance Review" },
          { name: "year", label: "Year", type: "number", required: true, defaultValue: new Date().getFullYear() },
          { name: "status", label: "Status", type: "select", options: ["ACTIVE", "CLOSED"].map((s) => ({ value: s, label: s })), defaultValue: "ACTIVE" },
          { name: "startDate", label: "Start Date", type: "date" },
          { name: "endDate", label: "End Date", type: "date" },
        ]}
        onSubmit={async (v) => { await rpc("cycles.save", { name: v.name, year: Number(v.year), startDate: v.startDate || undefined, endDate: v.endDate || undefined, status: v.status }) }} />

      <ReviewDetailDialog open={!!detail} onOpenChange={(v) => { if (!v) setDetail(null) }} review={detail} />

      <ConfirmDialog open={!!finalizeTarget} onOpenChange={(v) => { if (!v) setFinalizeTarget(null) }}
        title="Finalize review" confirmLabel="Finalize"
        message={`Finalize the review of ${finalizeTarget?.employeeName} (${finalizeTarget?.overallRating}/5)? Finalized reviews are immutable and the employee is notified.`}
        onConfirm={async () => { await rpc("reviews.finalize", { id: finalizeTarget.id }); reload() }} />
    </div>
  )
}

// ---------- Review detail (9 labeled star bars + comments) ----------
function ReviewDetailDialog({ open, onOpenChange, review }: { open: boolean; onOpenChange: (v: boolean) => void; review: any }) {
  if (!review) return null
  const comments: [string, any][] = [
    ["Manager Comments", review.managerComments],
    ["Employee Comments", review.employeeComments],
    ["Strengths", review.strengths],
    ["Weaknesses", review.weaknesses],
    ["Goals", review.goals],
    ["Improvement Plan", review.improvementPlan],
  ].filter(([, text]) => text) as [string, any][]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">Performance Review — {review.employeeName}</DialogTitle>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span>{review.cycleName}</span>
            <StatusBadge status={review.status} />
            <span className="inline-flex items-center gap-1">Overall <RatingStars value={Number(review.overallRating || 0)} /></span>
            {review.reviewerName && <span>· Reviewer: {review.reviewerName}</span>}
          </div>
        </DialogHeader>

        <div className="space-y-2 py-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Ratings — 9 Areas</p>
          {REVIEW_AREAS.map(([key, label]) => {
            const v = Number(review.ratings?.[key] || 0)
            return (
              <div key={key} className="flex items-center gap-3">
                <span className="w-32 sm:w-44 shrink-0 text-xs font-medium text-slate-600 dark:text-slate-300">{label}</span>
                <div className="flex-1 h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                  <div className="h-full rounded-full bg-gradient-to-r from-amber-400 to-emerald-500" style={{ width: `${(v / 5) * 100}%` }} />
                </div>
                {v ? <RatingStars value={v} /> : <span className="text-xs text-slate-400 w-14 text-right">—</span>}
              </div>
            )
          })}
        </div>

        {comments.length > 0 && (
          <div className="space-y-2 pt-1">
            {comments.map(([label, text]) => (
              <div key={label} className="rounded-lg bg-slate-50 dark:bg-slate-800/60 p-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1">{label}</p>
                <p className="text-sm text-slate-700 dark:text-slate-200 whitespace-pre-wrap">{text}</p>
              </div>
            ))}
          </div>
        )}

        {/* PRF-01 (R7) — multi-reviewer input: self-assessment + peer panels */}
        {review.inputs?.self && (
          <div className="rounded-xl border border-sky-200 dark:border-sky-900/60 bg-sky-50/60 dark:bg-sky-950/30 p-3 space-y-2">
            <p className="text-[11px] font-bold uppercase tracking-wide text-sky-700 dark:text-sky-400 flex items-center gap-1.5">
              <UserRound className="h-3.5 w-3.5" /> Self-Assessment (from the employee)
            </p>
            <div className="space-y-1.5">
              {REVIEW_AREAS.filter(([key]) => review.inputs.self.ratings?.[key] != null).map(([key, label]) => {
                const v = Number(review.inputs.self.ratings[key])
                return (
                  <div key={key} className="flex items-center gap-3">
                    <span className="w-32 sm:w-44 shrink-0 text-xs font-medium text-slate-600 dark:text-slate-300">{label}</span>
                    <div className="flex-1 h-1.5 rounded-full bg-sky-100 dark:bg-sky-900/50 overflow-hidden">
                      <div className="h-full rounded-full bg-gradient-to-r from-sky-400 to-indigo-500" style={{ width: `${(v / 5) * 100}%` }} />
                    </div>
                    <RatingStars value={v} />
                  </div>
                )
              })}
            </div>
            {review.inputs.self.comments && <p className="text-xs text-slate-600 dark:text-slate-300 whitespace-pre-wrap pt-1">{review.inputs.self.comments}</p>}
            {review.inputs.self.submittedAt && <p className="text-[10px] text-slate-400">submitted {new Date(review.inputs.self.submittedAt).toLocaleString()}</p>}
          </div>
        )}
        {Array.isArray(review.inputs?.peers) && review.inputs.peers.length > 0 && (
          <div className="space-y-2">
            <p className="text-[11px] font-bold uppercase tracking-wide text-violet-600 dark:text-violet-400 pt-1">Peer Input ({review.inputs.peers.length})</p>
            {review.inputs.peers.map((peer: any, i: number) => {
              const peerVals = Object.values(peer.ratings || {}) as number[]
              const peerAvg = peerVals.length ? Math.round((peerVals.reduce((a: number, b: number) => a + b, 0) / peerVals.length) * 10) / 10 : null
              return (
                <div key={i} className="rounded-xl border border-violet-200 dark:border-violet-900/60 bg-violet-50/60 dark:bg-violet-950/30 p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-violet-800 dark:text-violet-300">{peer.name}</p>
                    {peerAvg != null && <span className="text-[10px] font-bold text-violet-600 dark:text-violet-400">avg {peerAvg}/5</span>}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {REVIEW_AREAS.filter(([key]) => peer.ratings?.[key] != null).map(([key, label]) => (
                      <Badge key={key} variant="outline" className="text-[9px] text-violet-700 dark:text-violet-400 border-violet-200 dark:border-violet-800">{label}: {peer.ratings[key]}/5</Badge>
                    ))}
                  </div>
                  {peer.comments && <p className="text-[11px] text-slate-600 dark:text-slate-300 mt-1.5 whitespace-pre-wrap">{peer.comments}</p>}
                </div>
              )
            })}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ================= KPI TEMPLATES =================
function KpiTemplatesTab() {
  const { can } = useHrm()
  const { data, loading, error, reload } = useApi<any[]>("kpiTemplates.list", {})
  const { data: designations } = useApi<any[]>("designations.list", {})
  const [open, setOpen] = useState(false)
  const [editRec, setEditRec] = useState<any>(null)
  const [delTarget, setDelTarget] = useState<any>(null)

  const columns: Column<any>[] = [
    {
      key: "name", label: "Template", sortValue: (t) => t.name,
      render: (t) => (
        <div>
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t.name}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">{(t.items || []).length} indicator{(t.items || []).length === 1 ? "" : "s"}</p>
        </div>
      ),
    },
    { key: "designationName", label: "Designation", render: (t) => t.designationName ? <Badge variant="outline" className="text-[10px]">{t.designationName}</Badge> : <span className="text-xs text-slate-400">All designations</span> },
    { key: "weight", label: "Weight Total", render: (t) => <Badge className="bg-emerald-100 text-emerald-700 text-[10px] tabular-nums">{(t.items || []).reduce((s: number, i: any) => s + (Number(i.weight) || 0), 0)}%</Badge> },
    { key: "active", label: "Active", render: (t) => <Badge className={t.active ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"}>{t.active ? "Active" : "Inactive"}</Badge> },
    {
      key: "actions", label: "", align: "right", render: (t) => can("kpi", "create") && (
        <div className="flex gap-1">
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => { setEditRec(t); setOpen(true) }}><Pencil className="h-3.5 w-3.5" /></Button>
          <Button size="icon" variant="ghost" className="h-7 w-7 text-slate-400 hover:text-rose-600" onClick={() => setDelTarget(t)}><Trash2 className="h-3.5 w-3.5" /></Button>
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-500 flex items-center gap-1"><Target className="h-3.5 w-3.5 text-emerald-600" /> Indicator weights must total exactly 100% per template.</p>
        {can("kpi", "create") && (
          <Button size="sm" onClick={() => { setEditRec(null); setOpen(true) }} className="h-8 ">
            <Plus className="h-3.5 w-3.5 mr-1" /> New Template
          </Button>
        )}
      </div>
      <DataTable columns={columns} rows={data ?? undefined} loading={loading} error={error} csvName="kpi-templates"
        searchPlaceholder="Search template…" emptyTitle="No KPI templates" emptyHint="Create a weighted KPI template, then assign it to employees." />

      <KpiTemplateDialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setEditRec(null); reload() } }}
        template={editRec} designations={designations || []} onDone={reload} />

      <ConfirmDialog open={!!delTarget} onOpenChange={(v) => { if (!v) setDelTarget(null) }} title="Delete KPI template"
        message={`Delete "${delTarget?.name}"? Blocked if the template is already assigned to employees.`} danger confirmLabel="Delete"
        onConfirm={async () => { await rpc("kpiTemplates.delete", { id: delTarget.id }); reload() }} />
    </div>
  )
}

// ---------- Custom KPI template dialog (weighted items editor) ----------
function KpiTemplateDialog({ open, onOpenChange, template, designations, onDone }: {
  open: boolean; onOpenChange: (v: boolean) => void; template?: any; designations: any[]; onDone: () => void
}) {
  const toast = useHrm((s) => s.toast)
  const [name, setName] = useState("")
  const [designationId, setDesignationId] = useState("")
  const [items, setItems] = useState<any[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setName(template?.name || "")
      setDesignationId(template?.designationId || "")
      setItems(template?.items?.length
        ? template.items.map((i: any) => ({ name: i.name || "", target: i.target ?? "", unit: i.unit || "", weight: i.weight ?? "" }))
        : [{ name: "", target: "", unit: "", weight: "" }])
      setError(null)
    }
  }, [open, template])

  const total = items.reduce((s, i) => s + (Number(i.weight) || 0), 0)
  const setItem = (idx: number, key: string, val: any) => setItems((arr) => arr.map((it, i) => (i === idx ? { ...it, [key]: val } : it)))

  const submit = async () => {
    if (!name.trim()) { setError("Template name is required"); return }
    const clean = items.filter((i) => String(i.name || "").trim())
    if (!clean.length) { setError("Add at least one KPI indicator"); return }
    if (total !== 100) { setError(`Indicator weights must total exactly 100% — currently ${total}%`); return }
    setBusy(true)
    try {
      await rpc("kpiTemplates.save", {
        id: template?.id,
        name: name.trim(),
        designationId: designationId || undefined,
        items: clean.map((i) => ({ name: String(i.name).trim(), target: Number(i.target) || 0, unit: String(i.unit || "").trim(), weight: Number(i.weight) || 0 })),
        active: template ? template.active !== false : true,
      })
      toast("KPI template saved")
      onOpenChange(false)
      onDone()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">{template ? `Edit KPI Template — ${template.name}` : "New KPI Template"}</DialogTitle>
          <p className="text-xs text-slate-500">Define weighted indicators — the weight total must equal 100% before you can save.</p>
        </DialogHeader>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 py-2">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Template Name <span className="text-rose-500">*</span></Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="h-9" placeholder="e.g. Sales Executive KPI" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Designation (optional)</Label>
            <Select value={designationId || "none"} onValueChange={(v) => setDesignationId(v === "none" ? "" : v)}>
              <SelectTrigger className="h-9"><SelectValue placeholder="All designations" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">All designations</SelectItem>
                {designations.map((d: any) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="sm:col-span-2 space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-medium">Indicators</Label>
              <Badge className={`${total === 100 ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"} text-[10px] tabular-nums`}>
                Total weight: {total}% {total === 100 ? "✓" : "— must equal 100"}
              </Badge>
            </div>
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800 overflow-hidden">
              <div className="grid grid-cols-12 gap-2 px-3 py-1.5 bg-slate-50 dark:bg-slate-800/60 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                <span className="col-span-5">Indicator</span>
                <span className="col-span-2">Target</span>
                <span className="col-span-2">Unit</span>
                <span className="col-span-2">Weight %</span>
                <span className="col-span-1" />
              </div>
              {items.map((it, idx) => (
                <div key={idx} className="grid grid-cols-12 gap-2 px-3 py-2 items-center">
                  <Input className="col-span-5 h-8 text-xs" value={it.name} placeholder="e.g. Monthly sales volume" onChange={(e) => setItem(idx, "name", e.target.value)} />
                  <Input className="col-span-2 h-8 text-xs tabular-nums" type="number" value={it.target} placeholder="0" onChange={(e) => setItem(idx, "target", e.target.value)} />
                  <Input className="col-span-2 h-8 text-xs" value={it.unit} placeholder="৳ / qty / %" onChange={(e) => setItem(idx, "unit", e.target.value)} />
                  <Input className="col-span-2 h-8 text-xs tabular-nums" type="number" value={it.weight} placeholder="0" onChange={(e) => setItem(idx, "weight", e.target.value)} />
                  <Button size="icon" variant="ghost" className="h-7 w-7 col-span-1 text-slate-400 hover:text-rose-600" disabled={items.length <= 1}
                    onClick={() => setItems((arr) => arr.filter((_, i) => i !== idx))}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between gap-2">
              <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setItems((arr) => [...arr, { name: "", target: "", unit: "", weight: "" }])}>
                <Plus className="h-3.5 w-3.5 mr-1" /> Add Indicator
              </Button>
              {total !== 100 && <p className="text-[11px] text-amber-600">Adjust weights so they total exactly 100%.</p>}
            </div>
          </div>
        </div>

        {error && <p className="text-sm text-rose-600 bg-rose-50 dark:bg-rose-950 rounded-md px-3 py-2">{error}</p>}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy || total !== 100}>
            {busy ? "Saving…" : "Save Template"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ================= KPI ASSIGNMENTS =================
function KpiAssignmentsTab() {
  const { can } = useHrm()
  const { data, loading, error, reload } = useApi<any[]>("kpiAssignments.list", {})
  const { data: employees } = useEmployeeDirectory()
  const { data: templates } = useApi<any[]>("kpiTemplates.list", {})
  const [assignOpen, setAssignOpen] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const detailRow = (data || []).find((a: any) => a.id === detailId) || null

  const avgAch = (a: any): number | null => {
    const rs = (a.results || []).filter((r: any) => r.achievementPct != null)
    if (!rs.length) return null
    return Math.round((rs.reduce((s: number, r: any) => s + r.achievementPct, 0) / rs.length) * 10) / 10
  }
  const achClass = (v: number) => v >= 100 ? "bg-emerald-100 text-emerald-700" : v >= 75 ? "bg-teal-100 text-teal-700" : v >= 50 ? "bg-amber-100 text-amber-700" : "bg-rose-100 text-rose-700"

  const columns: Column<any>[] = [
    {
      key: "employeeName", label: "Employee", sortValue: (a) => a.employeeName,
      render: (a) => (
        <div>
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{a.employeeName}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">{a.templateName || "—"}</p>
        </div>
      ),
    },
    { key: "periodLabel", label: "Period", render: (a) => <Badge variant="outline" className="text-[10px] tabular-nums">{a.periodLabel}</Badge> },
    {
      key: "dueDate", label: "Due", sortValue: (a) => a.dueDate || "",
      render: (a) => {
        const past = a.dueDate && new Date(a.dueDate) < new Date() && ["PENDING", "IN_PROGRESS"].includes(a.status)
        return <span className={`text-xs ${past ? "text-rose-600 font-medium" : "text-slate-500"}`}>{a.dueDate ? fmtDate(a.dueDate) : "—"}</span>
      },
    },
    { key: "status", label: "Status", render: (a) => <StatusBadge status={a.status} /> },
    {
      key: "score", label: "Score", align: "right", sortValue: (a) => avgAch(a) ?? -1,
      render: (a) => {
        const v = avgAch(a)
        return v == null ? <span className="text-xs text-slate-400">—</span> : <Badge className={`${achClass(v)} text-[10px] tabular-nums`}>{v}% avg</Badge>
      },
    },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-500 flex items-center gap-1"><Gauge className="h-3.5 w-3.5 text-emerald-600" /> Score = average achievement % across the template indicators.</p>
        {can("kpi", "assign") && (
          <Button size="sm" onClick={() => setAssignOpen(true)} className="h-8 ">
            <Plus className="h-3.5 w-3.5 mr-1" /> Assign KPI
          </Button>
        )}
      </div>

      <DataTable columns={columns} rows={data ?? undefined} loading={loading} error={error} csvName="kpi-assignments"
        searchPlaceholder="Search employee…" onRowClick={(a) => setDetailId(a.id)}
        emptyTitle="No KPI assignments" emptyHint="Assign a KPI template to an employee for a scoring period." />

      <FormDialog open={assignOpen} onOpenChange={(v) => { setAssignOpen(v); if (!v) reload() }}
        title="Assign KPI" description="The template indicators are copied to the assignment; actuals are entered later."
        fields={[
          { name: "employeeId", label: "Employee", type: "select", required: true, span: 2, options: (employees || []).map((e: any) => ({ value: e.id, label: `${e.fullName} (${e.code})` })) },
          { name: "templateId", label: "KPI Template", type: "select", required: true, span: 2, options: (templates || []).filter((t: any) => t.active !== false).map((t: any) => ({ value: t.id, label: `${t.name}${t.designationName ? ` — ${t.designationName}` : ""}` })) },
          { name: "periodLabel", label: "Period Label", required: true, defaultValue: "2026-Q3", placeholder: "2026-Q3" },
          { name: "dueDate", label: "Due Date", type: "date" },
        ]}
        onSubmit={async (v) => { await rpc("kpiAssignments.assign", { employeeId: v.employeeId, templateId: v.templateId, periodLabel: v.periodLabel, dueDate: v.dueDate || undefined }) }} />

      <KpiDetailDialog open={!!detailRow} onOpenChange={(v) => { if (!v) setDetailId(null) }} assignment={detailRow} onReload={reload} />
    </div>
  )
}

// ---------- KPI assignment detail (results table + enter actuals) ----------
function KpiDetailDialog({ open, onOpenChange, assignment, onReload }: {
  open: boolean; onOpenChange: (v: boolean) => void; assignment: any; onReload: () => void
}) {
  const { can } = useHrm()
  const [actualsOpen, setActualsOpen] = useState(false)

  if (!assignment) return null
  const results = assignment.results || []
  const scored = results.filter((r: any) => r.achievementPct != null)
  const avgAch = scored.length ? Math.round((scored.reduce((s: number, r: any) => s + r.achievementPct, 0) / scored.length) * 10) / 10 : null
  const totalScore = results.reduce((s: number, r: any) => s + (r.score || 0), 0)
  const achClass = (v: number) => v >= 100 ? "text-emerald-600" : v >= 75 ? "text-teal-600" : v >= 50 ? "text-amber-600" : "text-rose-600"

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-base">KPI — {assignment.employeeName}</DialogTitle>
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <span>{assignment.templateName || "—"}</span>
              <Badge variant="outline" className="text-[10px] tabular-nums">{assignment.periodLabel}</Badge>
              <StatusBadge status={assignment.status} />
              {assignment.dueDate && <span>· Due {fmtDate(assignment.dueDate)}</span>}
            </div>
          </DialogHeader>

          {results.length === 0 ? (
            <EmptyState icon={Target} title="No indicators on this assignment" />
          ) : (
            <>
              <div className="grid grid-cols-3 gap-2 py-1">
                <div className="rounded-lg border p-2.5 text-center">
                  <p className="text-[10px] uppercase tracking-wide text-slate-400">Avg Achievement</p>
                  <p className={`text-lg font-bold tabular-nums ${avgAch != null ? achClass(avgAch) : "text-slate-400"}`}>{avgAch != null ? `${avgAch}%` : "—"}</p>
                </div>
                <div className="rounded-lg border p-2.5 text-center">
                  <p className="text-[10px] uppercase tracking-wide text-slate-400">Total Score</p>
                  <p className="text-lg font-bold tabular-nums text-slate-800 dark:text-slate-100">{totalScore || "—"}</p>
                </div>
                <div className="rounded-lg border p-2.5 text-center">
                  <p className="text-[10px] uppercase tracking-wide text-slate-400">Indicators</p>
                  <p className="text-lg font-bold tabular-nums text-slate-800 dark:text-slate-100">{results.length}</p>
                </div>
              </div>

              <div className="rounded-lg border overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 dark:bg-slate-800/60 text-[10px] uppercase tracking-wide text-slate-400">
                      <th className="text-left font-semibold px-3 py-2">Indicator</th>
                      <th className="text-right font-semibold px-3 py-2">Target</th>
                      <th className="text-right font-semibold px-3 py-2">Actual</th>
                      <th className="text-right font-semibold px-3 py-2">Ach. %</th>
                      <th className="text-right font-semibold px-3 py-2">Weight</th>
                      <th className="text-right font-semibold px-3 py-2">Score</th>
                      <th className="text-center font-semibold px-3 py-2">Rating</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {results.map((r: any, i: number) => (
                      <tr key={i}>
                        <td className="px-3 py-2">
                          <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{r.name}</p>
                          <p className="text-[10px] text-slate-500 dark:text-slate-400">{r.unit || "—"}</p>
                        </td>
                        <td className="px-3 py-2 text-right text-xs tabular-nums text-slate-600 dark:text-slate-300">{r.target ?? "—"}</td>
                        <td className="px-3 py-2 text-right text-xs tabular-nums text-slate-600 dark:text-slate-300">{r.actual ?? "—"}</td>
                        <td className={`px-3 py-2 text-right text-xs font-semibold tabular-nums ${r.achievementPct != null ? achClass(r.achievementPct) : "text-slate-400"}`}>
                          {r.achievementPct != null ? `${r.achievementPct}%` : "—"}
                        </td>
                        <td className="px-3 py-2 text-right text-xs tabular-nums text-slate-500">{r.weight ?? "—"}%</td>
                        <td className="px-3 py-2 text-right text-xs tabular-nums text-slate-600 dark:text-slate-300">{r.score ?? "—"}</td>
                        <td className="px-3 py-2 text-center">{r.rating != null ? <RatingStars value={Number(r.rating)} /> : <span className="text-xs text-slate-400">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <DialogFooter className="gap-2 sm:justify-between">
            <p className="text-[11px] text-slate-500 dark:text-slate-400">Achievement % = actual ÷ target · Score = achievement × weight.</p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
              {can("kpi", "edit") && assignment.status !== "REVIEWED" && (
                <Button onClick={() => setActualsOpen(true)}>
                  <Pencil className="h-3.5 w-3.5 mr-1" /> Enter Actuals
                </Button>
              )}
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <EnterActualsDialog open={actualsOpen} onOpenChange={setActualsOpen} assignment={assignment} onDone={onReload} />
    </>
  )
}

// ---------- Enter actuals (number input per indicator) ----------
function EnterActualsDialog({ open, onOpenChange, assignment, onDone }: {
  open: boolean; onOpenChange: (v: boolean) => void; assignment: any; onDone: () => void
}) {
  const toast = useHrm((s) => s.toast)
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open && assignment) {
      const v: Record<string, string> = {}
      for (const i of assignment.results || []) v[i.name] = i.actual != null ? String(i.actual) : ""
      setValues(v)
      setError(null)
    }
  }, [open, assignment])

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const results: Record<string, number> = {}
      for (const i of assignment.results || []) {
        const val = values[i.name]
        if (val !== "" && val != null) results[i.name] = Number(val)
      }
      await rpc("kpiAssignments.submitResults", { id: assignment.id, results })
      toast("KPI results submitted")
      onOpenChange(false)
      onDone()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const items = assignment?.results || []

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">Enter Actuals — {assignment?.employeeName}</DialogTitle>
          <p className="text-xs text-slate-500">{assignment?.templateName} · {assignment?.periodLabel}. Achievement % and score are computed server-side.</p>
        </DialogHeader>
        <div className="space-y-3 py-2 max-h-[55vh] overflow-y-auto pr-1">
          {items.map((i: any, idx: number) => (
            <div key={idx} className="space-y-1.5">
              <Label className="text-xs font-medium text-slate-600 dark:text-slate-300">{i.name}</Label>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 -mt-1">Target: {i.target} {i.unit} · Weight {i.weight}%</p>
              <Input type="number" value={values[i.name] ?? ""} placeholder="Actual value" className="h-9 tabular-nums"
                onChange={(e) => setValues((v) => ({ ...v, [i.name]: e.target.value }))} />
            </div>
          ))}
          {items.length === 0 && <EmptyState icon={Target} title="No indicators" />}
        </div>
        {error && <p className="text-sm text-rose-600 bg-rose-50 dark:bg-rose-950 rounded-md px-3 py-2">{error}</p>}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "Submitting…" : "Submit Results"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ================= ANALYTICS =================
function AnalyticsTab() {
  const { data: reviews } = useApi<any[]>("reviews.list", {})
  const { data: assignments } = useApi<any[]>("kpiAssignments.list", {})

  const list = reviews || []
  const rated = list.filter((r) => Number(r.overallRating) > 0)
  const avgRating = rated.length ? Math.round((rated.reduce((s: number, r: any) => s + Number(r.overallRating || 0), 0) / rated.length) * 10) / 10 : 0
  const top = [...rated].sort((a, b) => Number(b.overallRating) - Number(a.overallRating)).slice(0, 5)

  const allResults = (assignments || []).flatMap((a: any) => (a.results || []).filter((r: any) => r.achievementPct != null))
  const avgAch = allResults.length ? Math.round((allResults.reduce((s: number, r: any) => s + r.achievementPct, 0) / allResults.length) * 10) / 10 : null

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Avg Review Rating" value={avgRating || "—"} sub={rated.length ? `of ${rated.length} rated reviews` : "no rated reviews"} icon={Star} tone="amber" />
        <StatCard label="Reviews Recorded" value={list.length} icon={ClipboardCheck} tone="emerald" />
        <StatCard label="KPI Assignments" value={assignments?.length ?? "—"} icon={Target} tone="violet" />
        <StatCard label="Avg KPI Achievement" value={avgAch != null ? `${avgAch}%` : "—"} icon={TrendingUp} tone="teal" />
      </div>

      <SectionCard title="Top Performers" actions={<span className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1"><Users className="h-3 w-3" /> Top 5 by overall rating</span>}>
        {top.length === 0 ? (
          <EmptyState icon={Award} title="No rated reviews yet" hint="Overall ratings appear here once reviews are submitted." />
        ) : (
          <div className="space-y-2">
            {top.map((r: any, i: number) => (
              <div key={r.id || i} className="flex items-center gap-3 rounded-lg border border-slate-100 dark:border-slate-800 px-3 py-2">
                <span className={`h-7 w-7 shrink-0 rounded-full flex items-center justify-center text-xs font-bold ${i === 0 ? "bg-amber-100 text-amber-700" : i === 1 ? "bg-slate-200 text-slate-600" : i === 2 ? "bg-orange-100 text-orange-700" : "bg-slate-100 text-slate-500"}`}>
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">{r.employeeName}</p>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">{r.cycleName}</p>
                </div>
                {r.status === "FINAL" && <Badge variant="outline" className="text-[9px] shrink-0">Final</Badge>}
                <RatingStars value={Number(r.overallRating)} />
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  )
}
