"use client"
// ============ Recruitment: openings + applicant pipeline + ATS depth ============
// Wave 2 WP-P laid the two original surfaces; Wave 4 WP-D (ATS depth) added
// three more — the tab switcher now carries five:
//   - Openings tab — the job opening register (DataTable + FormDialog CRUD +
//     quick open/pause/close/publish actions). OPEN + isPublic openings feed
//     the platform's public /careers page (server-enforced listing filter).
//   - Pipeline tab — a kanban board over application statuses (NEW →
//     SHORTLISTED → INTERVIEW → OFFERED → HIRED, plus REJECTED). Cards move
//     via advance/reject buttons or the detail dialog's status select (drag
//     is deliberately NOT implemented — the status RPC is the authority and
//     every move is audited server-side).
//   - Interviews tab — scheduled rounds per application (schedule/edit dialog
//     with datetime-local, interviewer picker, https-only meeting link) and a
//     record-outcome dialog (PASSED advances NEW/SHORTLISTED applications to
//     the Interview stage — the server mirrors pipeline semantics).
//   - Offers tab — offer letters with the salary component breakdown + live
//     gross preview, DRAFT → SENT (best-effort applicant email) →
//     ACCEPTED/DECLINED state machine, one-live-offer rule, and a printable
//     letter (ats.offers.letter payload → escaped HTML → openPrintWindow,
//     the letters-module convention).
//   - Onboarding tab — the post-hire checklist (open/done/overdue chips,
//     toggle, vendor-scoped applicant/employee/assignee links). Accepting an
//     offer auto-seeds 3 starter tasks server-side.
// "Hire" on an application navigates to the Employee Directory with the Add
// Employee wizard open and the applicant's name/email/phone/department
// prefilled (view.params.prefill — read by employees.tsx CreateEmployeeDialog).
import { useEffect, useMemo, useState } from "react"
import {
  Briefcase, Plus, Users, UserCheck, Globe, Globe2, Pencil, Trash2, MoreVertical,
  PlayCircle, PauseCircle, XCircle, ChevronRight, FileDown, ClipboardList,
  LayoutGrid, Inbox, Ban, CalendarClock, FileText, ListChecks, CheckCircle2,
  RotateCcw, Printer, Send, ClipboardCheck,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useHrm } from "../store"
import { useApi, rpc, useLookup, useEmployeeDirectory } from "../api"
import {
  PageHeader, StatCard, fmtMoney, fmtDate, fmtDateTime, titleCase, LoadingRows,
  RowIconButton, FieldError, openPrintWindow, esc,
} from "../shared/ui-kit"
import { DataTable, type Column } from "../shared/data-table"
import { FormDialog, ConfirmDialog, type FieldDef } from "../shared/form-dialog"

// ---------- constants (mirror schema.prisma — frozen) ----------
const OPENING_STATUSES = ["DRAFT", "OPEN", "PAUSED", "CLOSED"] as const
const EMPLOYMENT_TYPES = ["FULL_TIME", "PART_TIME", "CONTRACT", "INTERN"] as const
const APP_STATUSES = ["NEW", "SHORTLISTED", "INTERVIEW", "OFFERED", "HIRED", "REJECTED"] as const

const INTERVIEW_ROUNDS = ["R1", "R2", "R3", "HR", "FINAL"] as const
const INTERVIEW_MODES = ["ONSITE", "PHONE", "VIDEO"] as const
const ROUND_LABEL: Record<string, string> = { R1: "R1", R2: "R2", R3: "R3", HR: "HR", FINAL: "Final" }

type AppStatus = (typeof APP_STATUSES)[number]

/** Forward pipeline move used by the card/board advance button. */
const NEXT_STATUS: Partial<Record<AppStatus, AppStatus>> = {
  NEW: "SHORTLISTED",
  SHORTLISTED: "INTERVIEW",
  INTERVIEW: "OFFERED",
  OFFERED: "HIRED",
}

const ALL_OPENINGS = "__all__" // Radix SelectItem rejects value=""
const NONE = "__none__" // same Radix rule for the "— None —" picker options

/** HIRED response → deep-link the Add Employee wizard with the applicant's
 *  biodata prefilled (view.params.prefill — read by employees.tsx). */
function hireNavigate(
  hired: { name: string; email?: string | null; phone?: string | null; departmentId?: string | null },
  toast: (t: string, k?: "ok" | "err") => void,
  navigate: (key: string, params?: Record<string, unknown>) => void,
) {
  toast(`${hired.name} hired — the Add Employee form is prefilled`)
  navigate("employees", {
    add: true,
    prefill: {
      fullName: hired.name,
      ...(hired.email ? { personalEmail: hired.email } : {}),
      ...(hired.phone ? { mobile: hired.phone } : {}),
      ...(hired.departmentId ? { departmentId: hired.departmentId } : {}),
    },
  })
}

const OPENING_META: Record<string, { label: string; cls: string; dot: string }> = {
  DRAFT: { label: "Draft", cls: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300", dot: "bg-slate-400" },
  OPEN: { label: "Open", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300", dot: "bg-emerald-500" },
  PAUSED: { label: "Paused", cls: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300", dot: "bg-amber-500" },
  CLOSED: { label: "Closed", cls: "bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300", dot: "bg-slate-400" },
}

const APP_META: Record<AppStatus, { label: string; cls: string; dot: string }> = {
  NEW: { label: "New", cls: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300", dot: "bg-sky-500" },
  SHORTLISTED: { label: "Shortlisted", cls: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300", dot: "bg-violet-500" },
  INTERVIEW: { label: "Interview", cls: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300", dot: "bg-amber-500" },
  OFFERED: { label: "Offered", cls: "bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300", dot: "bg-teal-500" },
  HIRED: { label: "Hired", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300", dot: "bg-emerald-500" },
  REJECTED: { label: "Rejected", cls: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300", dot: "bg-rose-400" },
}

const SOURCE_META: Record<string, string> = {
  WEBSITE: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  MANUAL: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
}

// ---------- ATS depth (Wave 4 WP-D) meta ----------
const OUTCOME_META: Record<string, { label: string; cls: string }> = {
  PASSED: { label: "Passed", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" },
  FAILED: { label: "Failed", cls: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300" },
  CANCELLED: { label: "Cancelled", cls: "bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300" },
  SCHEDULED: { label: "Scheduled", cls: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300" },
}

const OFFER_META: Record<string, { label: string; cls: string }> = {
  DRAFT: { label: "Draft", cls: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300" },
  SENT: { label: "Sent", cls: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300" },
  ACCEPTED: { label: "Accepted", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" },
  DECLINED: { label: "Declined", cls: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300" },
}

function OpeningBadge({ status }: { status: string }) {
  const m = OPENING_META[status] || OPENING_META.DRAFT
  return (
    <Badge variant="secondary" className={`font-medium whitespace-nowrap gap-1.5 ${m.cls}`}>
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current opacity-80 shrink-0" />
      {m.label}
    </Badge>
  )
}

function AppBadge({ status }: { status: string }) {
  const m = APP_META[(status as AppStatus)] || APP_META.NEW
  return (
    <Badge variant="secondary" className={`font-medium whitespace-nowrap gap-1.5 ${m.cls}`}>
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current opacity-80 shrink-0" />
      {m.label}
    </Badge>
  )
}

/** Interview outcome chip — a null column value is the implicit PENDING and
 *  renders as the amber "Scheduled" state; a decided round never flips back. */
function OutcomeBadge({ outcome, score }: { outcome?: string | null; score?: number | null }) {
  const m = OUTCOME_META[outcome || "SCHEDULED"]
  return (
    <div className="flex flex-col items-start gap-0.5">
      <Badge variant="secondary" className={`font-medium whitespace-nowrap gap-1.5 ${m.cls}`}>
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current opacity-80 shrink-0" />
        {m.label}
      </Badge>
      {score != null && <span className="text-[10px] text-slate-500 dark:text-slate-400 tabular-nums">{score}/100</span>}
    </div>
  )
}

function OfferBadge({ status }: { status: string }) {
  const m = OFFER_META[status] || OFFER_META.DRAFT
  return (
    <Badge variant="secondary" className={`font-medium whitespace-nowrap gap-1.5 ${m.cls}`}>
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current opacity-80 shrink-0" />
      {m.label}
    </Badge>
  )
}

function FilterChip({ label, active, onClick }: { label: string; active?: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`h-7 rounded-full px-3 text-xs font-medium border transition-colors ${active ? "bg-primary text-primary-foreground border-primary" : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-emerald-400"}`}>
      {label}
    </button>
  )
}

/** Small read-only count pill (tab-level summary chips). */
function ChipStat({ label, count, tone = "slate" }: { label: string; count: number; tone?: "slate" | "emerald" | "rose" | "amber" }) {
  const tones: Record<string, string> = {
    slate: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
    emerald: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
    rose: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
    amber: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  }
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-3 h-7 text-xs font-medium ${tones[tone]}`}>
      {label} <span className="font-bold tabular-nums">{count}</span>
    </span>
  )
}

/** Labeled field wrapper for the hand-rolled ATS dialogs (FormDialog covers
 *  the standard field types; these dialogs need datetime-local inputs,
 *  live gross previews and radio-style selectors). */
function Field({ label, required, help, children }: { label: string; required?: boolean; help?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs font-medium text-slate-600 dark:text-slate-300">
        {label}{required && <span className="text-rose-500 ml-0.5">*</span>}
      </Label>
      {children}
      {help && <p className="text-[11px] text-slate-500 dark:text-slate-400">{help}</p>}
    </div>
  )
}

export default function RecruitmentView() {
  const { view } = useHrm()
  const [tab, setTab] = useState<"openings" | "pipeline" | "interviews" | "offers" | "onboarding">("openings")
  // global-search / notification deep link: open straight into an application
  const [detailId, setDetailId] = useState<string | null>((view.params as any)?.applicationId || null)

  const openingsApi = useApi<any[]>("recruitment.openings.list", {})
  const applicationsApi = useApi<any[]>("recruitment.applications.list", {})
  const interviewsApi = useApi<any[]>("ats.interviews.list", {})
  const offersApi = useApi<any[]>("ats.offers.list", {})
  const onboardingApi = useApi<any[]>("ats.onboarding.list", {})
  // interviewer/assignee pickers — the cached users lookup is only fetched
  // while a tab that renders one is active (requires settings.view)
  const needUsers = tab === "interviews" || tab === "onboarding"
  const { data: users, error: usersError } = useLookup<any[]>("users.list", {}, needUsers)

  const openings = openingsApi.data || []
  const applications = applicationsApi.data || []
  const interviews = interviewsApi.data || []

  const openCount = openings.filter((o) => o.status === "OPEN").length
  const newCount = applications.filter((a) => a.status === "NEW").length
  const hiredCount = applications.filter((a) => a.status === "HIRED").length

  // Interviews tab chip — undated decided rounds never count; scheduledAt
  // strings are local (datetime-local input) so Date() parses them in the
  // viewer's timezone
  const upcomingCount = useMemo(() => {
    const now = new Date().getTime()
    const horizon = now + 7 * 24 * 60 * 60 * 1000
    return interviews.filter((i) => {
      if (i.outcome) return false
      const t = new Date(i.scheduledAt).getTime()
      return Number.isFinite(t) && t >= now && t <= horizon
    }).length
  }, [interviews])

  const detailRow = applications.find((a) => a.id === detailId) || null

  return (
    <div className="space-y-4">
      <PageHeader title="Recruitment"
        subtitle="Job openings, the applicant pipeline, interview scheduling, offer letters and the post-hire onboarding checklist" />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Open Openings" value={openCount} icon={Briefcase} tone="emerald" sub={`${openings.length} total openings`} />
        <StatCard label="Applications" value={applications.length} icon={ClipboardList} tone="sky" sub="all statuses" />
        <StatCard label="New / Unreviewed" value={newCount} icon={Inbox} tone="amber" sub="waiting in the pipeline" />
        <StatCard label="Hired" value={hiredCount} icon={UserCheck} tone="teal" sub="converted to employees" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex flex-wrap items-center rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-0.5 max-w-full" role="group" aria-label="Recruitment view mode">
          <button type="button" onClick={() => setTab("openings")}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${tab === "openings" ? "bg-primary text-primary-foreground" : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"}`}>
            <LayoutGrid className="h-3.5 w-3.5" /> Openings
          </button>
          <button type="button" onClick={() => setTab("pipeline")}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${tab === "pipeline" ? "bg-primary text-primary-foreground" : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"}`}>
            <Users className="h-3.5 w-3.5" /> Pipeline
            {applications.length > 0 && <span className="rounded-full bg-slate-200 dark:bg-slate-700 px-1.5 text-[10px] tabular-nums">{applications.length}</span>}
          </button>
          <button type="button" onClick={() => setTab("interviews")}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${tab === "interviews" ? "bg-primary text-primary-foreground" : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"}`}>
            <CalendarClock className="h-3.5 w-3.5" /> Interviews
            {upcomingCount > 0 && (
              <span className="rounded-full bg-amber-100 dark:bg-amber-900 px-1.5 text-[10px] tabular-nums font-semibold text-amber-700 dark:text-amber-300" title={`${upcomingCount} interview(s) in the next 7 days`}>
                {upcomingCount}
              </span>
            )}
          </button>
          <button type="button" onClick={() => setTab("offers")}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${tab === "offers" ? "bg-primary text-primary-foreground" : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"}`}>
            <FileText className="h-3.5 w-3.5" /> Offers
          </button>
          <button type="button" onClick={() => setTab("onboarding")}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${tab === "onboarding" ? "bg-primary text-primary-foreground" : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"}`}>
            <ListChecks className="h-3.5 w-3.5" /> Onboarding
          </button>
        </div>
      </div>

      {tab === "openings" ? (
        <OpeningsTab api={openingsApi} applicationsApi={applicationsApi} onGoPipeline={() => setTab("pipeline")} />
      ) : tab === "pipeline" ? (
        <PipelineTab openings={openings} applications={applications} loading={applicationsApi.loading} error={applicationsApi.error}
          reload={applicationsApi.reload} onOpenDetail={(id) => setDetailId(id)} />
      ) : tab === "interviews" ? (
        <InterviewsTab api={interviewsApi} applications={applications} users={users} usersError={usersError}
          reloadApplications={applicationsApi.reload} />
      ) : tab === "offers" ? (
        <OffersTab api={offersApi} applications={applications}
          reloadAll={() => { offersApi.reload(); applicationsApi.reload(); onboardingApi.reload() }} />
      ) : (
        <OnboardingTab api={onboardingApi} applications={applications} />
      )}

      {/* application detail dialog lives at the top level so the deep-link
          param and both tabs share it */}
      {detailRow && (
        <ApplicationDetailDialog app={detailRow} onOpenChange={(v) => { if (!v) setDetailId(null) }}
          reload={applicationsApi.reload} />
      )}
    </div>
  )
}

// ============================ OPENINGS TAB ============================

function OpeningsTab({ api, applicationsApi, onGoPipeline }: {
  api: { data: any[] | null; loading: boolean; error: string | null; reload: () => void }
  applicationsApi: { reload: () => void }
  onGoPipeline: () => void
}) {
  const { can, toast } = useHrm()
  const [status, setStatus] = useState<string>("")
  const [editRow, setEditRow] = useState<any | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [deleteRow, setDeleteRow] = useState<any | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  // department/branch pickers reuse the shared lookup cache
  const { data: branches } = useLookup<any[]>("branches.list")
  const { data: departments } = useLookup<any[]>("departments.list")

  const openings = (api.data || []).filter((o) => !status || o.status === status)

  const fields: FieldDef[] = [
    { name: "title", label: "Job Title", required: true, span: 2, placeholder: "e.g. Senior Accountant" },
    { name: "branchId", label: "Branch (location)", type: "select", options: [
      { value: "", label: "— None —" },
      ...(branches || []).map((b: any) => ({ value: b.id, label: b.name })),
    ] },
    { name: "departmentId", label: "Department", type: "select", options: [
      { value: "", label: "— None —" },
      ...(departments || []).map((d: any) => ({ value: d.id, label: d.name })),
    ] },
    { name: "employmentType", label: "Employment Type", type: "select", defaultValue: "FULL_TIME",
      options: EMPLOYMENT_TYPES.map((t) => ({ value: t, label: titleCase(t) })) },
    { name: "openings", label: "Positions", type: "number", min: 1, max: 999, defaultValue: 1, help: "How many people this opening hires" },
    { name: "salaryRange", label: "Salary Range", placeholder: "e.g. ৳35,000 – ৳45,000" },
    { name: "deadline", label: "Application Deadline", type: "date", help: "Past-deadline openings stop accepting applications on the careers page" },
    { name: "status", label: "Status", type: "select", defaultValue: "DRAFT",
      options: OPENING_STATUSES.map((s) => ({ value: s, label: OPENING_META[s].label })) },
    { name: "isPublic", label: "Publish to the public careers page", type: "switch", span: 2, help: "Only OPEN + published openings appear on /careers" },
    { name: "description", label: "Job Description", type: "richtext", span: 2, rows: 6, placeholder: "Role summary, responsibilities, reporting line…" },
    { name: "requirements", label: "Requirements", type: "richtext", span: 2, rows: 6, placeholder: "Education, experience, skills, certifications…" },
  ]

  const quickAction = async (row: any, patch: Record<string, unknown>, okMsg: string) => {
    setBusyId(row.id)
    try {
      await rpc("recruitment.openings.save", { id: row.id, ...patch })
      toast(okMsg)
      api.reload()
    } catch (e: any) {
      toast(e.message, "err")
    } finally {
      setBusyId(null)
    }
  }

  const columns: Column<any>[] = [
    {
      key: "title", label: "Opening", sortValue: (o) => o.title,
      searchValue: (o) => `${o.title} ${o.departmentName || ""} ${o.branchName || ""} ${o.salaryRange || ""}`,
      render: (o) => (
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">{o.title}</p>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            {o.isPublic ? (
              <Badge variant="outline" className="text-[9px] gap-1 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800">
                <Globe className="h-2.5 w-2.5" /> Public
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[9px] text-slate-500 dark:text-slate-400">Internal</Badge>
            )}
            {o.salaryRange && <span className="text-[11px] text-slate-500 dark:text-slate-400 truncate">{o.salaryRange}</span>}
          </div>
        </div>
      ),
    },
    {
      key: "departmentName", label: "Department / Branch", sortValue: (o) => o.departmentName || o.branchName || "",
      render: (o) => (
        <div className="min-w-0">
          <p className="text-xs text-slate-700 dark:text-slate-200 truncate">{o.departmentName || "—"}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">{o.branchName || "—"}</p>
        </div>
      ),
    },
    { key: "employmentType", label: "Type", render: (o) => <Badge variant="outline" className="text-[10px]">{titleCase(o.employmentType)}</Badge> },
    { key: "openings", label: "Positions", align: "center", sortValue: (o) => o.openings, render: (o) => <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300">{o.openings}</span> },
    {
      key: "deadline", label: "Deadline", sortValue: (o) => o.deadline || "",
      render: (o) => {
        const past = o.deadline && o.deadline < new Date().toISOString().slice(0, 10)
        return <span className={`text-xs ${past ? "text-rose-600 font-semibold" : "text-slate-500 dark:text-slate-400"}`}>{o.deadline ? fmtDate(o.deadline) : "—"}</span>
      },
    },
    {
      key: "applicationCount", label: "Applications", align: "center", sortValue: (o) => o.applicationCount || 0,
      render: (o) => (
        <button type="button" onClick={() => onGoPipeline()} className="text-xs tabular-nums font-medium text-slate-600 dark:text-slate-300 hover:text-emerald-600 dark:hover:text-emerald-400" title="Open the applicant pipeline">
          {o.applicationCount ?? 0}
        </button>
      ),
    },
    { key: "status", label: "Status", render: (o) => <OpeningBadge status={o.status} /> },
    {
      key: "actions", label: "", align: "right", className: "w-10",
      render: (o) => (
        <OpeningRowMenu row={o} busy={busyId === o.id} canEdit={can("recruitment", "edit")} canDelete={can("recruitment", "delete")}
          onEdit={() => setEditRow(o)} onDelete={() => setDeleteRow(o)} onAction={quickAction} />
      ),
    },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <FilterChip label="All" active={!status} onClick={() => setStatus("")} />
        {OPENING_STATUSES.map((s) => (
          <FilterChip key={s} label={OPENING_META[s].label} active={status === s} onClick={() => setStatus(status === s ? "" : s)} />
        ))}
        {can("recruitment", "create") && (
          <Button size="sm" variant="outline" className="h-7 ml-auto" onClick={() => setCreateOpen(true)}>
            <Plus className="h-3.5 w-3.5 mr-1" /> New Opening
          </Button>
        )}
      </div>

      {api.loading ? (
        <div className="rounded-xl border bg-white dark:bg-slate-900"><LoadingRows /></div>
      ) : api.error ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 dark:border-rose-900 dark:bg-rose-950 p-4 text-sm text-rose-700 dark:text-rose-300">{api.error}</div>
      ) : (
        <DataTable columns={columns} rows={openings} csvName="job-openings" pageSize={15} dense
          searchPlaceholder="Search title, department, branch…"
          emptyTitle="No job openings yet" emptyHint={can("recruitment", "create") ? "Create an opening, set it to Open and publish it to list it on the public careers page." : "No openings match the current filter."} />
      )}

      <div className="rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/50 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300 flex items-start gap-2">
        <Globe2 className="h-3.5 w-3.5 shrink-0 mt-0.5" />
        <span>
          Openings with status <b>Open</b> and the <b>Public</b> flag appear on the platform&apos;s careers page (<span className="font-mono">/careers</span>) —
          website submissions land in the pipeline as <b>New</b> applications and notify HR (in-app, plus email per the <i>Job Application Received</i> template in HR Settings → Templates).
        </span>
      </div>

      <FormDialog open={createOpen} onOpenChange={(v) => { setCreateOpen(v); if (!v) { api.reload(); applicationsApi.reload() } }}
        title="New Job Opening" description="Publish it by setting status Open with the Public flag — it then accepts applications on the careers page."
        fields={fields}
        onSubmit={async (v) => {
          await rpc("recruitment.openings.save", {
            title: v.title,
            branchId: v.branchId || undefined,
            departmentId: v.departmentId || undefined,
            employmentType: v.employmentType,
            description: v.description || undefined,
            requirements: v.requirements || undefined,
            openings: Number(v.openings || 1),
            salaryRange: v.salaryRange || undefined,
            deadline: v.deadline || undefined,
            status: v.status,
            isPublic: !!v.isPublic,
          })
        }} />

      <FormDialog open={!!editRow} onOpenChange={(v) => { if (!v) setEditRow(null); api.reload() }}
        title="Edit Job Opening" description={editRow ? `${editRow.title} · ${editRow.applicationCount ?? 0} application(s)` : undefined}
        fields={fields}
        initial={editRow ? {
          title: editRow.title, branchId: editRow.branchId || "", departmentId: editRow.departmentId || "",
          employmentType: editRow.employmentType, description: editRow.description || "", requirements: editRow.requirements || "",
          openings: editRow.openings, salaryRange: editRow.salaryRange || "", deadline: editRow.deadline || "",
          status: editRow.status, isPublic: !!editRow.isPublic,
        } : undefined}
        onSubmit={async (v) => {
          await rpc("recruitment.openings.save", {
            id: editRow.id,
            title: v.title,
            branchId: v.branchId || undefined,
            departmentId: v.departmentId || undefined,
            employmentType: v.employmentType,
            description: v.description || undefined,
            requirements: v.requirements || undefined,
            openings: Number(v.openings || 1),
            salaryRange: v.salaryRange || undefined,
            deadline: v.deadline || undefined,
            status: v.status,
            isPublic: !!v.isPublic,
          })
        }} />

      <ConfirmDialog open={!!deleteRow} onOpenChange={(v) => { if (!v) { setDeleteRow(null); api.reload() } }}
        title="Delete Job Opening" danger confirmLabel="Delete Opening"
        message={deleteRow ? `Delete "${deleteRow.title}"? Only openings with zero applications can be deleted — if candidates have applied, close the opening instead to preserve the hiring history.` : ""}
        onConfirm={async () => {
          await rpc("recruitment.openings.delete", { id: deleteRow.id })
        }} />
    </div>
  )
}

function OpeningRowMenu({ row, busy, canEdit, canDelete, onEdit, onDelete, onAction }: {
  row: any; busy: boolean; canEdit: boolean; canDelete: boolean
  onEdit: () => void; onDelete: () => void
  onAction: (row: any, patch: Record<string, unknown>, okMsg: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const act = (patch: Record<string, unknown>, okMsg: string) => {
    setOpen(false)
    return onAction(row, patch, okMsg)
  }
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon" title="Opening actions" aria-label={`Actions for ${row.title}`}
          disabled={busy} className="h-7 w-7 shrink-0 text-slate-500 hover:text-slate-700 dark:hover:text-slate-200">
          <MoreVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-xs">
          <span className="font-semibold text-slate-700 dark:text-slate-200 truncate block">{row.title}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {canEdit && row.status !== "OPEN" && (
          <DropdownMenuItem onClick={() => act({ status: "OPEN" }, "Opening is now Open")} className="gap-2 text-xs">
            <PlayCircle className="h-3.5 w-3.5 text-emerald-600" /> Open
          </DropdownMenuItem>
        )}
        {canEdit && row.status === "OPEN" && (
          <DropdownMenuItem onClick={() => act({ status: "PAUSED" }, "Opening paused")} className="gap-2 text-xs">
            <PauseCircle className="h-3.5 w-3.5 text-amber-600" /> Pause
          </DropdownMenuItem>
        )}
        {canEdit && row.status !== "CLOSED" && (
          <DropdownMenuItem onClick={() => act({ status: "CLOSED" }, "Opening closed")} className="gap-2 text-xs">
            <XCircle className="h-3.5 w-3.5 text-slate-500" /> Close
          </DropdownMenuItem>
        )}
        {canEdit && (
          <DropdownMenuItem onClick={() => act({ isPublic: !row.isPublic }, row.isPublic ? "Removed from the careers page" : "Published to the careers page")} className="gap-2 text-xs">
            <Globe className="h-3.5 w-3.5" /> {row.isPublic ? "Unpublish (internal only)" : "Publish to careers page"}
          </DropdownMenuItem>
        )}
        {canEdit && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => { setOpen(false); onEdit() }} className="gap-2 text-xs">
              <Pencil className="h-3.5 w-3.5" /> Edit Opening
            </DropdownMenuItem>
          </>
        )}
        {canDelete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => { setOpen(false); onDelete() }} className="gap-2 text-xs text-rose-600 focus:text-rose-600">
              <Trash2 className="h-3.5 w-3.5" /> Delete Opening
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ============================ PIPELINE TAB ============================

function PipelineTab({ openings, applications, loading, error, reload, onOpenDetail }: {
  openings: any[]
  applications: any[]
  loading: boolean
  error: string | null
  reload: () => void
  onOpenDetail: (id: string) => void
}) {
  const { can, navigate, toast } = useHrm()
  const [openingId, setOpeningId] = useState("")
  const [createOpen, setCreateOpen] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const filtered = useMemo(
    () => applications.filter((a) => !openingId || a.openingId === openingId),
    [applications, openingId],
  )

  /** Move an application. A move to HIRED returns the applicant's contact
   *  details from the server, which deep-links the Add Employee wizard. */
  const move = async (app: any, status: AppStatus) => {
    setBusyId(app.id)
    try {
      const res = await rpc<any>("recruitment.applications.status", { id: app.id, status })
      if (res?.hired) {
        hireNavigate(res.hired, toast, navigate)
      } else {
        toast(`${app.name} → ${APP_META[status].label}`)
        reload()
      }
    } catch (e: any) {
      toast(e.message, "err")
    } finally {
      setBusyId(null)
    }
  }

  const manualFields: FieldDef[] = [
    {
      name: "openingId", label: "Opening", type: "select", required: true, span: 2,
      options: openings.map((o) => ({ value: o.id, label: `${o.title}${o.status !== "OPEN" ? ` (${OPENING_META[o.status]?.label || o.status})` : ""}` })),
    },
    { name: "name", label: "Candidate Name", required: true, span: 2, placeholder: "e.g. Rahim Miah" },
    { name: "email", label: "Email", type: "email", placeholder: "candidate@email.com" },
    { name: "phone", label: "Phone", placeholder: "01XXXXXXXXX" },
    { name: "expectedSalary", label: "Expected Salary (৳)", type: "number", min: 0 },
    { name: "coverNote", label: "Cover Note / Summary", type: "textarea", span: 2, rows: 3, placeholder: "Where the candidate came from, screening notes…" },
    { name: "notes", label: "Internal Notes", type: "textarea", span: 2, rows: 2 },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-56">
          <Select value={openingId || ALL_OPENINGS} onValueChange={(v) => setOpeningId(v === ALL_OPENINGS ? "" : v)}>
            <SelectTrigger className="h-8 text-xs" aria-label="Filter by opening">
              <SelectValue placeholder="All openings" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_OPENINGS}>All openings</SelectItem>
              {openings.map((o) => (
                <SelectItem key={o.id} value={o.id}>{o.title}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {openingId && (
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setOpeningId("")}>Clear filter</Button>
        )}
        {can("recruitment", "create") && openings.length > 0 && (
          <Button size="sm" variant="outline" className="h-7 ml-auto" onClick={() => setCreateOpen(true)}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Log Application
          </Button>
        )}
        {can("recruitment", "create") && openings.length === 0 && (
          <p className="text-xs text-slate-500 dark:text-slate-400 ml-auto">Create an opening first to log applications.</p>
        )}
      </div>

      {loading ? (
        <div className="rounded-xl border bg-white dark:bg-slate-900"><LoadingRows /></div>
      ) : error ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 dark:border-rose-900 dark:bg-rose-950 p-4 text-sm text-rose-700 dark:text-rose-300">{error}</div>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-3 scroll-thin">
          {APP_STATUSES.map((s) => {
            const items = filtered.filter((a) => a.status === s)
            return (
              <div key={s} className="w-72 sm:w-80 shrink-0">
                <div className="flex items-center gap-2 mb-2 px-1">
                  <span className={`h-2 w-2 rounded-full ${APP_META[s].dot}`} />
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">{APP_META[s].label}</p>
                  <span className="ml-auto text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">{items.length}</span>
                </div>
                <div className="space-y-2 min-h-[60px] max-h-[62vh] overflow-y-auto pr-1 scroll-thin">
                  {items.length === 0 && (
                    <div className="rounded-lg border border-dashed border-slate-200 dark:border-slate-800 p-3 text-center text-[11px] text-slate-500 dark:text-slate-400">
                      {s === "NEW" ? "Website submissions land here" : "No applications"}
                    </div>
                  )}
                  {items.map((a) => (
                    <ApplicationCard key={a.id} app={a} busy={busyId === a.id} canEdit={can("recruitment", "edit")}
                      onClick={() => onOpenDetail(a.id)} onMove={move} />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <FormDialog open={createOpen} onOpenChange={(v) => { setCreateOpen(v); if (!v) reload() }}
        title="Log an Application" description="Back-office entry for walk-in, emailed or referred candidates — recorded with source Manual."
        fields={manualFields}
        onSubmit={async (v) => {
          await rpc("recruitment.applications.create", {
            openingId: v.openingId,
            name: v.name,
            email: v.email || undefined,
            phone: v.phone || undefined,
            expectedSalary: v.expectedSalary === "" || v.expectedSalary == null ? undefined : Number(v.expectedSalary),
            coverNote: v.coverNote || undefined,
            notes: v.notes || undefined,
          })
        }} />
    </div>
  )
}

// ---------- pipeline card ----------
function ApplicationCard({ app, busy, canEdit, onClick, onMove }: {
  app: any; busy: boolean; canEdit: boolean
  onClick: () => void
  onMove: (app: any, status: AppStatus) => Promise<void>
}) {
  const next = NEXT_STATUS[app.status as AppStatus]
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3 transition-all hover:shadow-md hover:border-emerald-300 dark:hover:border-emerald-800">
      <button type="button" onClick={onClick} className="w-full text-left" aria-label={`Open application from ${app.name}`}>
        <p className="text-sm font-semibold text-slate-800 dark:text-slate-100 leading-snug truncate">{app.name}</p>
        <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 truncate">{app.openingTitle}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-slate-400">
          <Badge className={`${SOURCE_META[app.source] || SOURCE_META.MANUAL} text-[9px] font-semibold`}>{titleCase(app.source)}</Badge>
          {app.email && <span className="truncate max-w-[130px]">{app.email}</span>}
          {!app.email && app.phone && <span className="truncate max-w-[130px]">{app.phone}</span>}
          {app.hasCv && <FileDown className="h-3 w-3 text-emerald-600 dark:text-emerald-400" aria-label="CV attached" />}
        </div>
        <p className="text-[10px] text-slate-400 mt-1.5">{fmtDate(app.createdAt)}</p>
      </button>
      {canEdit && app.status !== "HIRED" && app.status !== "REJECTED" && (
        <div className="mt-2 flex items-center gap-1.5 border-t border-slate-100 dark:border-slate-800 pt-2">
          {next && (
            <button type="button" disabled={busy} onClick={() => onMove(app, next)}
              className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 px-2 py-1 text-[10px] font-medium text-slate-600 dark:text-slate-300 hover:border-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-400 disabled:opacity-50 transition-colors"
              title={`Advance to ${APP_META[next].label}`}>
              {APP_META[next].label} <ChevronRight className="h-3 w-3" />
            </button>
          )}
          {app.status === "OFFERED" && (
            <button type="button" disabled={busy} onClick={() => onMove(app, "HIRED")}
              className="inline-flex items-center gap-1 rounded-md border border-emerald-300 dark:border-emerald-800 px-2 py-1 text-[10px] font-semibold text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950 disabled:opacity-50 transition-colors"
              title="Mark hired and open the prefilled Add Employee form">
              <UserCheck className="h-3 w-3" /> Hire
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => onMove(app, "REJECTED")}
            className="ml-auto inline-flex items-center gap-1 rounded-md border border-transparent px-2 py-1 text-[10px] font-medium text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 disabled:opacity-50 transition-colors"
            title="Reject application">
            <Ban className="h-3 w-3" /> Reject
          </button>
        </div>
      )}
    </div>
  )
}

// ---------- application detail ----------
function ApplicationDetailDialog({ app, onOpenChange, reload }: {
  app: any
  onOpenChange: (v: boolean) => void
  reload: () => void
}) {
  const { can, navigate, toast } = useHrm()
  const [notes, setNotes] = useState<string>(app.notes || "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // re-sync the notes editor when the dialog opens for a different application
  useEffect(() => {
    setNotes(app.notes || "")
    setError(null)
  }, [app.id, app.notes])

  /** Move / save. A pure status move PRESERVES stored notes (undefined is
   *  dropped from the payload); the notes editor passes the notes explicitly
   *  (empty string = clear the stored notes). */
  const save = async (target: AppStatus, notesOverride?: string) => {
    setBusy(true)
    setError(null)
    try {
      const res = await rpc<any>("recruitment.applications.status", {
        id: app.id,
        status: target,
        ...(notesOverride !== undefined ? { notes: notesOverride } : (notes.trim() ? { notes: notes.trim() } : {})),
      })
      if (res?.hired) {
        hireNavigate(res.hired, toast, navigate)
        return
      }
      toast(notesOverride !== undefined && target === app.status ? "Notes saved" : `${app.name} → ${APP_META[target].label}`)
      reload()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const downloadCv = async () => {
    setBusy(true)
    try {
      const res = await rpc<{ fileName: string; mime: string; data: string }>("recruitment.applications.cv", { id: app.id })
      const bin = atob(res.data)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const blob = new Blob([bytes], { type: res.mime })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = res.fileName || `cv-${app.name.replace(/\s+/g, "-").toLowerCase()}`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      toast("CV downloaded")
    } catch (e: any) {
      toast(e.message, "err")
    } finally {
      setBusy(false)
    }
  }

  const locked = app.status === "HIRED"

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base flex flex-wrap items-center gap-2">
            {app.name}
            <AppBadge status={app.status} />
            <Badge className={`${SOURCE_META[app.source] || SOURCE_META.MANUAL} text-[10px] font-semibold`}>{titleCase(app.source)}</Badge>
          </DialogTitle>
          <p className="text-xs text-slate-500 dark:text-slate-400 flex flex-wrap gap-x-3">
            <span>{app.openingTitle}</span>
            <span>Applied {fmtDate(app.createdAt)}</span>
          </p>
        </DialogHeader>

        <div className="grid sm:grid-cols-2 gap-x-6 gap-y-3 py-1">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Email</p>
            <p className="text-sm font-medium text-slate-800 dark:text-slate-200 break-words">{app.email || "—"}</p>
          </div>
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Phone</p>
            <p className="text-sm font-medium text-slate-800 dark:text-slate-200 break-words">{app.phone || "—"}</p>
          </div>
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Expected Salary</p>
            <p className="text-sm font-medium text-slate-800 dark:text-slate-200">{app.expectedSalary != null ? fmtMoney(app.expectedSalary) : "—"}</p>
          </div>
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Curriculum Vitae</p>
            <div className="mt-0.5">
              {app.hasCv ? (
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={downloadCv} disabled={busy}>
                  <FileDown className="h-3.5 w-3.5 mr-1" /> Download CV
                </Button>
              ) : (
                <p className="text-sm text-slate-400">No CV attached</p>
              )}
            </div>
          </div>
        </div>

        {app.coverNote && (
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1">Cover note</p>
            <p className="text-sm text-slate-700 dark:text-slate-200 whitespace-pre-wrap">{app.coverNote}</p>
          </div>
        )}

        {can("recruitment", "edit") ? (
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Move through the pipeline</p>
            {locked ? (
              <p className="text-xs text-emerald-700 dark:text-emerald-300 flex items-start gap-2">
                <UserCheck className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                This applicant is HIRED — the record is locked (hiring prefilled the Add Employee form). Create the employee from the Employee Directory.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-1.5">
                  {APP_STATUSES.filter((s) => s !== app.status).map((s) => (
                    <button key={s} type="button" disabled={busy} onClick={() => save(s)}
                      className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-50 ${s === "HIRED"
                        ? "border-emerald-300 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950"
                        : s === "REJECTED"
                          ? "border-slate-200 dark:border-slate-700 text-slate-500 hover:text-rose-600 dark:hover:text-rose-400 hover:border-rose-300"
                          : "border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-emerald-400"}`}>
                      {s === "HIRED" && <UserCheck className="h-3 w-3" />}
                      {APP_META[s].label}
                      {s === "HIRED" && <span className="font-semibold">→ hire</span>}
                    </button>
                  ))}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="app-notes" className="text-xs font-medium">Internal notes</Label>
                  <Textarea id="app-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)}
                    placeholder="Screening notes, interview feedback, offer details…" />
                  <Button size="sm" variant="outline" className="h-8" disabled={busy || notes === (app.notes || "")}
                    onClick={() => save(app.status as AppStatus, notes)}>
                    {busy ? "Saving…" : "Save Notes"}
                  </Button>
                </div>
              </>
            )}
          </div>
        ) : (
          app.notes && (
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1">Internal notes</p>
              <p className="text-sm text-slate-700 dark:text-slate-200 whitespace-pre-wrap">{app.notes}</p>
            </div>
          )
        )}

        {error && <p role="alert" className="text-sm text-rose-600 bg-rose-50 dark:bg-rose-950 rounded-md px-3 py-2">{error}</p>}
      </DialogContent>
    </Dialog>
  )
}

// ============================ INTERVIEWS TAB (Wave 4 WP-D) ============================

function InterviewsTab({ api, applications, users, usersError, reloadApplications }: {
  api: { data: any[] | null; loading: boolean; error: string | null; reload: () => void }
  applications: any[]
  users: any[] | null
  usersError: string | null
  reloadApplications: () => void
}) {
  const { can } = useHrm()
  const [outcome, setOutcome] = useState("")
  // undefined = closed · null = create · row = edit (keyed remount below)
  const [formRow, setFormRow] = useState<any | null | undefined>(undefined)
  const [outcomeRow, setOutcomeRow] = useState<any | null>(null)

  const all = api.data || []
  const interviews = all.filter((i) => !outcome || (i.outcome || "PENDING") === outcome)
  const now = new Date().getTime()
  const in7 = now + 7 * 24 * 60 * 60 * 1000
  const upcoming7 = all.filter((i) => {
    if (i.outcome) return false
    const t = new Date(i.scheduledAt).getTime()
    return Number.isFinite(t) && t >= now && t <= in7
  }).length
  const awaiting = all.filter((i) => !i.outcome).length

  const onSaved = () => {
    api.reload()
    reloadApplications() // a PASSED outcome can advance an application to INTERVIEW
  }

  const columns: Column<any>[] = [
    {
      key: "applicantName", label: "Applicant", sortValue: (i) => i.applicantName || "",
      searchValue: (i) => `${i.applicantName || ""} ${i.openingTitle || ""} ${i.interviewerName || ""} ${i.notes || ""}`,
      render: (i) => (
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">{i.applicantName || "—"}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">{i.openingTitle || "—"}</p>
        </div>
      ),
    },
    { key: "round", label: "Round", sortValue: (i) => i.round, render: (i) => <Badge variant="outline" className="text-[10px] font-semibold whitespace-nowrap">{ROUND_LABEL[i.round] || i.round}</Badge> },
    { key: "mode", label: "Mode", sortValue: (i) => i.mode, render: (i) => <span className="text-xs text-slate-600 dark:text-slate-300 whitespace-nowrap">{titleCase(i.mode)}</span> },
    { key: "scheduledAt", label: "Scheduled", sortValue: (i) => i.scheduledAt, render: (i) => <span className="text-xs text-slate-600 dark:text-slate-300 whitespace-nowrap">{fmtDateTime(i.scheduledAt)}</span> },
    { key: "interviewerName", label: "Interviewer", sortValue: (i) => i.interviewerName || "", render: (i) => <span className="text-xs text-slate-600 dark:text-slate-300 block truncate max-w-[140px]">{i.interviewerName || "—"}</span> },
    { key: "durationMin", label: "Duration", align: "center", sortValue: (i) => i.durationMin || 0, render: (i) => <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300 whitespace-nowrap">{i.durationMin ? `${i.durationMin} min` : "—"}</span> },
    { key: "outcome", label: "Outcome", sortValue: (i) => i.outcome || "", render: (i) => <OutcomeBadge outcome={i.outcome} score={i.score} /> },
    {
      key: "actions", label: "", align: "right", className: "w-10",
      render: (i) => (
        <div className="flex items-center justify-end gap-0.5">
          {can("recruitment", "edit") && !i.outcome && (
            <>
              <RowIconButton icon={ClipboardCheck} label="Record outcome" tone="brand" onClick={() => setOutcomeRow(i)} />
              <RowIconButton icon={Pencil} label="Edit interview" onClick={() => setFormRow(i)} />
            </>
          )}
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <ChipStat label="Next 7 days" count={upcoming7} tone="amber" />
        <ChipStat label="Awaiting outcome" count={awaiting} tone="slate" />
        <span className="hidden sm:block w-px h-5 bg-slate-200 dark:bg-slate-800" aria-hidden />
        <FilterChip label="All" active={!outcome} onClick={() => setOutcome("")} />
        {(["PENDING", "PASSED", "FAILED", "CANCELLED"] as const).map((o) => (
          <FilterChip key={o} label={OUTCOME_META[o === "PENDING" ? "SCHEDULED" : o].label} active={outcome === o} onClick={() => setOutcome(outcome === o ? "" : o)} />
        ))}
        {can("recruitment", "edit") && applications.length > 0 && (
          <Button size="sm" variant="outline" className="h-7 ml-auto" onClick={() => setFormRow(null)}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Schedule Interview
          </Button>
        )}
        {can("recruitment", "edit") && applications.length === 0 && (
          <p className="text-xs text-slate-500 dark:text-slate-400 ml-auto">Applications appear once candidates apply — schedule rounds from there.</p>
        )}
      </div>

      {api.loading ? (
        <div className="rounded-xl border bg-white dark:bg-slate-900"><LoadingRows /></div>
      ) : api.error ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 dark:border-rose-900 dark:bg-rose-950 p-4 text-sm text-rose-700 dark:text-rose-300">{api.error}</div>
      ) : (
        <DataTable columns={columns} rows={interviews} csvName="interviews" pageSize={15} dense
          searchPlaceholder="Search applicant, opening, interviewer…"
          emptyTitle="No interviews scheduled" emptyHint={can("recruitment", "edit") ? "Schedule the first round for a shortlisted applicant — a passed round advances the applicant to the Interview stage." : "No interviews match the current filter."} />
      )}

      {/* schedule/edit dialog — keyed remount so state resets per row */}
      {formRow !== undefined && (
        <InterviewFormDialog key={formRow ? formRow.id : "new"} row={formRow} applications={applications}
          users={users} usersError={usersError}
          onOpenChange={(v) => { if (!v) setFormRow(undefined) }} onSaved={onSaved} />
      )}

      {/* record-outcome dialog — keyed remount per interview */}
      {outcomeRow && (
        <InterviewOutcomeDialog key={outcomeRow.id} row={outcomeRow}
          onOpenChange={(v) => { if (!v) setOutcomeRow(null) }} onSaved={onSaved} />
      )}

      {usersError && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">
          The user list could not be loaded ({usersError}) — interviewer selection is unavailable for your role; the interview can still be scheduled without one.
        </p>
      )}
    </div>
  )
}

/** Schedule / edit an interview. Hand-rolled (not FormDialog) because the
 *  form needs a datetime-local input, which the shared field types do not
 *  cover. Values initialize from `row` on mount — the parent remounts the
 *  dialog per row (key), so no re-sync effects are needed. */
function InterviewFormDialog({ row, applications, users, usersError, onOpenChange, onSaved }: {
  row: any | null // null = create
  applications: any[]
  users: any[] | null
  usersError: string | null
  onOpenChange: (v: boolean) => void
  onSaved: () => void
}) {
  const toast = useHrm((s) => s.toast)
  const editing = !!row
  const [v, setV] = useState<Record<string, string>>(() => ({
    applicationId: row?.applicationId || "",
    round: row?.round || "R1",
    mode: row?.mode || "ONSITE",
    scheduledAt: row?.scheduledAt ? String(row.scheduledAt).slice(0, 16) : "",
    durationMin: row?.durationMin != null ? String(row.durationMin) : "",
    interviewerId: row?.interviewerId || "",
    location: row?.location || "",
    link: row?.link || "",
    notes: row?.notes || "",
  }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (k: string, val: string) => setV((s) => ({ ...s, [k]: val }))

  const submit = async () => {
    if (!v.applicationId) { setError("Application is required"); return }
    if (!v.scheduledAt) { setError("Scheduled date & time is required"); return }
    setBusy(true)
    setError(null)
    try {
      await rpc("ats.interviews.save", {
        ...(editing ? { id: row.id } : {}),
        applicationId: v.applicationId,
        round: v.round,
        mode: v.mode,
        scheduledAt: v.scheduledAt,
        durationMin: v.durationMin === "" ? undefined : Number(v.durationMin),
        interviewerId: v.interviewerId || undefined,
        location: v.location || undefined,
        link: v.link || undefined,
        notes: v.notes || undefined,
      })
      onOpenChange(false)
      toast(editing ? "Interview updated" : "Interview scheduled")
      onSaved()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const activeUsers = (users || []).filter((u: any) => u.status === "ACTIVE")

  return (
    <Dialog open onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">{editing ? "Edit Interview" : "Schedule Interview"}</DialogTitle>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {editing ? "Reschedule or correct the details — the recorded outcome stays untouched." : "Rounds live on the Interviews tab; a passed round advances NEW/SHORTLISTED applicants to the Interview stage."}
          </p>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-2.5 py-1">
          <div className="sm:col-span-2">
            <Field label="Application" required help="Every application of this tenant, newest first.">
              <Select value={v.applicationId || NONE} onValueChange={(x) => set("applicationId", x === NONE ? "" : x)}>
                <SelectTrigger><SelectValue placeholder="Select applicant…" /></SelectTrigger>
                <SelectContent>
                  {applications.map((a) => (
                    <SelectItem key={a.id} value={a.id}>{a.name} — {a.openingTitle}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field label="Round">
            <Select value={v.round} onValueChange={(x) => set("round", x)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {INTERVIEW_ROUNDS.map((r) => (
                  <SelectItem key={r} value={r}>{ROUND_LABEL[r]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Mode">
            <Select value={v.mode} onValueChange={(x) => set("mode", x)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {INTERVIEW_MODES.map((m) => (
                  <SelectItem key={m} value={m}>{titleCase(m)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Date & Time" required help="Local time — shown on the Interviews tab.">
            <Input type="datetime-local" value={v.scheduledAt} onChange={(e) => set("scheduledAt", e.target.value)} />
          </Field>
          <Field label="Duration (minutes)" help="Optional — 30 / 45 / 60 are typical.">
            <Input type="number" min={5} max={600} step={5} value={v.durationMin} onChange={(e) => set("durationMin", e.target.value)} placeholder="e.g. 45" />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Interviewer" help={usersError ? "User list unavailable for your role — leave unassigned or note the name below." : "Any active user of this tenant."}>
              <Select value={v.interviewerId || NONE} onValueChange={(x) => set("interviewerId", x === NONE ? "" : x)}>
                <SelectTrigger><SelectValue placeholder="— None —" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>— None —</SelectItem>
                  {activeUsers.map((u: any) => (
                    <SelectItem key={u.id} value={u.id}>{u.name} · {u.roleLabel || u.role}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field label="Location" help="On-site rounds — office / branch address.">
            <Input value={v.location} onChange={(e) => set("location", e.target.value)} placeholder="e.g. Head Office, Level 5" />
          </Field>
          <Field label="Meeting Link" help="https:// only — Google Meet, Zoom…">
            <Input value={v.link} onChange={(e) => set("link", e.target.value)} placeholder="https://meet.google.com/…" />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Notes">
              <Textarea rows={3} value={v.notes} onChange={(e) => set("notes", e.target.value)} placeholder="What to probe in this round, prep material, focus areas…" />
            </Field>
          </div>
        </div>
        <FieldError message={error} />
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? "Saving…" : editing ? "Save Interview" : "Schedule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Record an interview outcome — radio-style selector + optional score +
 *  notes. Decided interviews are frozen server-side (reschedule = new round). */
function InterviewOutcomeDialog({ row, onOpenChange, onSaved }: {
  row: any
  onOpenChange: (v: boolean) => void
  onSaved: () => void
}) {
  const toast = useHrm((s) => s.toast)
  const [outcome, setOutcome] = useState<"PASSED" | "FAILED" | "CANCELLED">("PASSED")
  const [score, setScore] = useState<string>(row.score != null ? String(row.score) : "")
  const [notes, setNotes] = useState<string>(row.notes || "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const options: { value: "PASSED" | "FAILED" | "CANCELLED"; label: string; hint: string }[] = [
    { value: "PASSED", label: "Passed", hint: "NEW/SHORTLISTED applicants advance to the Interview stage" },
    { value: "FAILED", label: "Failed", hint: "Does NOT auto-reject — the recruiter decides the next move" },
    { value: "CANCELLED", label: "Cancelled", hint: "The round never happened (no-show, withdrawn…)" },
  ]

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await rpc<any>("ats.interviews.outcome", {
        id: row.id,
        outcome,
        score: score === "" ? undefined : Number(score),
        notes: notes.trim(),
      })
      onOpenChange(false)
      toast(res?.applicationMoved
        ? `${row.applicantName || "Applicant"} passed — application advanced to the Interview stage`
        : `Interview recorded as ${outcome === "PASSED" ? "passed" : titleCase(outcome)}`)
      onSaved()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">Record Interview Outcome</DialogTitle>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {row.applicantName || "Applicant"} · {ROUND_LABEL[row.round] || row.round} round · {fmtDateTime(row.scheduledAt)}
          </p>
        </DialogHeader>
        <div className="space-y-1.5" role="radiogroup" aria-label="Interview outcome">
          {options.map((o) => (
            <button key={o.value} type="button" role="radio" aria-checked={outcome === o.value} onClick={() => setOutcome(o.value)}
              className={`w-full text-left rounded-lg border p-2.5 transition-colors ${outcome === o.value ? "border-primary ring-1 ring-primary" : "border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700"}`}>
              <p className={`text-sm font-semibold ${outcome === o.value ? "text-primary" : "text-slate-700 dark:text-slate-200"}`}>{o.label}</p>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">{o.hint}</p>
            </button>
          ))}
        </div>
        <div className="space-y-2.5">
          <Field label="Score (0–100)" help="Optional — the interviewer's overall rating.">
            <Input type="number" min={0} max={100} value={score} onChange={(e) => setScore(e.target.value)} placeholder="e.g. 78" />
          </Field>
          <Field label="Notes" help="Feedback and observations — replaces the interview notes on save.">
            <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Panel feedback, observations, follow-ups…" />
          </Field>
        </div>
        <FieldError message={error} />
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "Saving…" : "Record Outcome"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ============================ OFFERS TAB (Wave 4 WP-D) ============================

/** Salary component rows of the offer form (label order = print order). */
const SALARY_FIELDS: { name: string; label: string }[] = [
  { name: "basicSalary", label: "Basic Salary" },
  { name: "houseRent", label: "House Rent" },
  { name: "medical", label: "Medical" },
  { name: "transport", label: "Transport" },
  { name: "otherAllowance", label: "Other Allowance" },
]

function OffersTab({ api, applications, reloadAll }: {
  api: { data: any[] | null; loading: boolean; error: string | null; reload: () => void }
  applications: any[]
  reloadAll: () => void
}) {
  const { can, toast } = useHrm()
  const [status, setStatus] = useState("")
  const [formRow, setFormRow] = useState<any | null | undefined>(undefined)
  const [sendRow, setSendRow] = useState<any | null>(null)
  const [decideRow, setDecideRow] = useState<any | null>(null)

  const offers = (api.data || []).filter((o) => !status || o.status === status)

  const viewLetter = async (row: any) => {
    try {
      const d = await rpc<any>("ats.offers.letter", { id: row.id })
      const w = openPrintWindow(buildOfferLetterHtml(d), { print: true })
      if (!w) toast("Popup blocked — allow popups to view the offer letter", "err")
    } catch (e: any) {
      toast(e.message, "err")
    }
  }

  const columns: Column<any>[] = [
    {
      key: "applicantName", label: "Applicant", sortValue: (o) => o.applicantName || "",
      searchValue: (o) => `${o.applicantName || ""} ${o.openingTitle || ""} ${o.title}`,
      render: (o) => (
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">{o.applicantName || "—"}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">{o.openingTitle || "—"}</p>
        </div>
      ),
    },
    {
      key: "title", label: "Offer", sortValue: (o) => o.title,
      render: (o) => (
        <div className="min-w-0">
          <p className="text-sm text-slate-800 dark:text-slate-100 truncate">{o.title}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
            {o.grade ? `Grade ${o.grade}` : ""}{o.department ? `${o.grade ? " · " : ""}${o.department}` : ""}
          </p>
        </div>
      ),
    },
    {
      key: "gross", label: "Gross / month", align: "right", sortValue: (o) => o.gross || 0,
      render: (o) => <span className="text-sm font-semibold tabular-nums text-slate-800 dark:text-slate-100 whitespace-nowrap">{fmtMoney(o.gross)}</span>,
    },
    { key: "status", label: "Status", sortValue: (o) => o.status, render: (o) => <OfferBadge status={o.status} /> },
    {
      key: "sentAt", label: "Sent / Decided", sortValue: (o) => o.decidedAt || o.sentAt || "",
      render: (o) => (
        <div className="min-w-0 text-xs text-slate-500 dark:text-slate-400">
          <p className="whitespace-nowrap">{o.sentAt ? `Sent ${fmtDate(o.sentAt)}` : "Not sent"}</p>
          {o.decidedAt && <p className="whitespace-nowrap">Decided {fmtDate(o.decidedAt)}</p>}
        </div>
      ),
    },
    {
      key: "actions", label: "", align: "right", className: "w-10",
      render: (o) => (
        <OfferRowMenu row={o} canEdit={can("recruitment", "edit")}
          onLetter={() => viewLetter(o)} onEdit={() => setFormRow(o)} onSend={() => setSendRow(o)} onDecide={() => setDecideRow(o)} />
      ),
    },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <FilterChip label="All" active={!status} onClick={() => setStatus("")} />
        {(["DRAFT", "SENT", "ACCEPTED", "DECLINED"] as const).map((s) => (
          <FilterChip key={s} label={OFFER_META[s].label} active={status === s} onClick={() => setStatus(status === s ? "" : s)} />
        ))}
        {can("recruitment", "edit") && applications.length > 0 && (
          <Button size="sm" variant="outline" className="h-7 ml-auto" onClick={() => setFormRow(null)}>
            <Plus className="h-3.5 w-3.5 mr-1" /> New Offer
          </Button>
        )}
        {can("recruitment", "edit") && applications.length === 0 && (
          <p className="text-xs text-slate-500 dark:text-slate-400 ml-auto">Offers attach to applications — none exist yet.</p>
        )}
      </div>

      {api.loading ? (
        <div className="rounded-xl border bg-white dark:bg-slate-900"><LoadingRows /></div>
      ) : api.error ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 dark:border-rose-900 dark:bg-rose-950 p-4 text-sm text-rose-700 dark:text-rose-300">{api.error}</div>
      ) : (
        <DataTable columns={columns} rows={offers} csvName="offers" pageSize={15} dense
          searchPlaceholder="Search applicant, opening, offer title…"
          emptyTitle="No offers yet" emptyHint={can("recruitment", "edit") ? "Draft an offer for a shortlisted or interviewed applicant — sending moves it to Sent, acceptance seeds the onboarding checklist." : "No offers match the current filter."} />
      )}

      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 px-3 py-2 text-xs text-slate-600 dark:text-slate-300 flex items-start gap-2">
        <FileText className="h-3.5 w-3.5 shrink-0 mt-0.5 text-slate-400" />
        <span>
          One live offer per application — a draft or sent offer must be decided before another can be created.
          <b> Accepting</b> an offer moves the applicant to <b>Offered</b> and seeds 3 starter onboarding tasks; <b>Declining</b> leaves the pipeline untouched.
        </span>
      </div>

      {/* draft/edit dialog — keyed remount per row, live gross preview */}
      {formRow !== undefined && (
        <OfferFormDialog key={formRow ? formRow.id : "new"} row={formRow} applications={applications}
          onOpenChange={(v) => { if (!v) setFormRow(undefined) }} onSaved={api.reload} />
      )}

      {/* send confirm */}
      <ConfirmDialog open={!!sendRow} onOpenChange={(v) => { if (!v) setSendRow(null) }}
        title="Send Offer" confirmLabel="Send Offer"
        message={sendRow ? `Mark "${sendRow.title}" for ${sendRow.applicantName || "the applicant"} as sent? The applicant is emailed when an address is on file and the email gateway is configured — otherwise the status still moves to Sent and you contact them out-of-band.` : ""}
        onConfirm={async () => {
          const res = await rpc<any>("ats.offers.send", { id: sendRow.id })
          const st = res?.email?.status
          if (st === "SENT") toast("Offer email delivered to the applicant")
          else if (st) toast(`Offer email ${st}${res.email.detail ? ` — ${res.email.detail}` : ""}`, st === "FAILED" ? "err" : "ok")
          else toast("Offer marked sent — the applicant has no email on file; contact them out-of-band")
          api.reload()
        }} />

      {/* accept/decline dialog — keyed remount per row */}
      {decideRow && (
        <OfferDecideDialog key={decideRow.id} row={decideRow}
          onOpenChange={(v) => { if (!v) setDecideRow(null) }} onSaved={reloadAll} />
      )}
    </div>
  )
}

/** Draft / edit an offer. Hand-rolled (not FormDialog) for the live monthly
 *  gross preview under the salary component inputs. */
function OfferFormDialog({ row, applications, onOpenChange, onSaved }: {
  row: any | null // null = create
  applications: any[]
  onOpenChange: (v: boolean) => void
  onSaved: () => void
}) {
  const toast = useHrm((s) => s.toast)
  const editing = !!row
  const [v, setV] = useState<Record<string, string>>(() => ({
    applicationId: row?.applicationId || "",
    title: row?.title || "",
    grade: row?.grade || "",
    department: row?.department || "",
    joiningDate: row?.joiningDate || "",
    basicSalary: row?.basicSalary != null ? String(row.basicSalary) : "",
    houseRent: row?.houseRent != null ? String(row.houseRent) : "",
    medical: row?.medical != null ? String(row.medical) : "",
    transport: row?.transport != null ? String(row.transport) : "",
    otherAllowance: row?.otherAllowance != null ? String(row.otherAllowance) : "",
    notes: row?.notes || "",
  }))
  // auto-title: creating + user has not typed a title → follow the selected
  // application's opening ("<Opening> — Offer")
  const [titleTouched, setTitleTouched] = useState(editing)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (k: string, val: string) => setV((s) => ({ ...s, [k]: val }))

  const gross = SALARY_FIELDS.reduce((sum, f) => sum + (Number(v[f.name]) || 0), 0)

  const pickApplication = (id: string) => {
    const app = applications.find((a) => a.id === id)
    setV((s) => ({
      ...s,
      applicationId: id === NONE ? "" : id,
      title: !editing && !titleTouched && app ? `${app.openingTitle} — Offer` : s.title,
    }))
  }

  const submit = async () => {
    if (!v.applicationId) { setError("Application is required"); return }
    if (!v.title.trim()) { setError("Offer title is required"); return }
    setBusy(true)
    setError(null)
    try {
      await rpc("ats.offers.save", {
        ...(editing ? { id: row.id } : {}),
        applicationId: v.applicationId,
        title: v.title.trim(),
        grade: v.grade || undefined,
        department: v.department || undefined,
        joiningDate: v.joiningDate || undefined,
        basicSalary: Number(v.basicSalary) || 0,
        houseRent: Number(v.houseRent) || 0,
        medical: Number(v.medical) || 0,
        transport: Number(v.transport) || 0,
        otherAllowance: Number(v.otherAllowance) || 0,
        notes: v.notes || undefined,
      })
      onOpenChange(false)
      toast(editing ? "Offer updated" : "Offer drafted")
      onSaved()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">{editing ? "Edit Offer" : "Draft Offer"}</DialogTitle>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {editing ? "Draft terms — a sent or decided offer is frozen (decline + re-offer to supersede)." : "One live offer per application — drafts can be edited until sent."}
          </p>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-2.5 py-1">
          <div className="sm:col-span-2">
            <Field label="Application" required help="The applicant this offer is made to.">
              <Select value={v.applicationId || NONE} onValueChange={pickApplication}>
                <SelectTrigger><SelectValue placeholder="Select applicant…" /></SelectTrigger>
                <SelectContent>
                  {applications.map((a) => (
                    <SelectItem key={a.id} value={a.id}>{a.name} — {a.openingTitle}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="Offer Title" required help="Defaults to the opening title — the printable letter's headline.">
              <Input value={v.title} onChange={(e) => { setTitleTouched(true); set("title", e.target.value) }} placeholder="e.g. Senior Accountant — Offer" />
            </Field>
          </div>
          <Field label="Grade">
            <Input value={v.grade} onChange={(e) => set("grade", e.target.value)} placeholder="e.g. Grade 3" />
          </Field>
          <Field label="Department">
            <Input value={v.department} onChange={(e) => set("department", e.target.value)} placeholder="e.g. Finance" />
          </Field>
          <Field label="Joining Date">
            <Input type="date" value={v.joiningDate} onChange={(e) => set("joiningDate", e.target.value)} />
          </Field>
          <div className="sm:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-2.5 rounded-lg border border-slate-200 dark:border-slate-800 p-3">
            <p className="sm:col-span-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Monthly salary components (৳)</p>
            {SALARY_FIELDS.map((f) => (
              <Field key={f.name} label={f.label}>
                <Input type="number" min={0} step="any" value={v[f.name]} onChange={(e) => set(f.name, e.target.value)} placeholder="0" />
              </Field>
            ))}
            <div className="sm:col-span-2 rounded-md border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/50 px-3 py-2 flex items-center justify-between">
              <span className="text-xs font-medium text-emerald-700 dark:text-emerald-300">Monthly Gross</span>
              <span className="text-sm font-bold text-emerald-700 dark:text-emerald-300 tabular-nums">
                {fmtMoney(gross)} <span className="text-[10px] font-normal">/ month</span>
              </span>
            </div>
          </div>
          <div className="sm:col-span-2">
            <Field label="Notes">
              <Textarea rows={3} value={v.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Terms, conditions, probation length, benefits…" />
            </Field>
          </div>
        </div>
        <FieldError message={error} />
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "Saving…" : editing ? "Save Offer" : "Draft Offer"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Row actions for an offer — letter print is always available; state
 *  transitions follow the DRAFT → SENT → ACCEPTED/DECLINED machine. */
function OfferRowMenu({ row, canEdit, onLetter, onEdit, onSend, onDecide }: {
  row: any; canEdit: boolean
  onLetter: () => void; onEdit: () => void; onSend: () => void; onDecide: () => void
}) {
  const [open, setOpen] = useState(false)
  const go = (fn: () => void) => () => { setOpen(false); fn() }
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon" title="Offer actions" aria-label={`Actions for offer ${row.title}`}
          className="h-7 w-7 shrink-0 text-slate-500 hover:text-slate-700 dark:hover:text-slate-200">
          <MoreVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-xs">
          <span className="font-semibold text-slate-700 dark:text-slate-200 truncate block">{row.applicantName || "Offer"}</span>
          <span className="font-normal text-slate-400 truncate block">{row.title}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={go(onLetter)} className="gap-2 text-xs">
          <Printer className="h-3.5 w-3.5" /> View / Print Letter
        </DropdownMenuItem>
        {canEdit && row.status === "DRAFT" && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={go(onEdit)} className="gap-2 text-xs">
              <Pencil className="h-3.5 w-3.5" /> Edit Offer
            </DropdownMenuItem>
            <DropdownMenuItem onClick={go(onSend)} className="gap-2 text-xs">
              <Send className="h-3.5 w-3.5 text-emerald-600" /> Send to Applicant
            </DropdownMenuItem>
          </>
        )}
        {canEdit && row.status === "SENT" && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={go(onDecide)} className="gap-2 text-xs">
              <ClipboardCheck className="h-3.5 w-3.5 text-emerald-600" /> Record Decision…
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Accept / decline a SENT offer (radio-style). Accepting can move the
 *  application to Offered and seed starter onboarding tasks server-side. */
function OfferDecideDialog({ row, onOpenChange, onSaved }: {
  row: any
  onOpenChange: (v: boolean) => void
  onSaved: () => void
}) {
  const toast = useHrm((s) => s.toast)
  const [decision, setDecision] = useState<"ACCEPTED" | "DECLINED">("ACCEPTED")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await rpc<any>("ats.offers.decide", { id: row.id, decision })
      onOpenChange(false)
      if (decision === "ACCEPTED") {
        toast(`Offer accepted — application moved to ${titleCase(res?.applicationStatus) || "Offered"}${res?.onboardingCreated ? ` · ${res.onboardingCreated} starter onboarding tasks created` : ""}`)
      } else {
        toast("Offer declined — the pipeline stays put; decide the next move from the Pipeline tab")
      }
      onSaved()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">Record Offer Decision</DialogTitle>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {row.applicantName || "Applicant"} · {row.title} · sent {row.sentAt ? fmtDate(row.sentAt) : "—"}
          </p>
        </DialogHeader>
        <div className="space-y-1.5" role="radiogroup" aria-label="Offer decision">
          <button type="button" role="radio" aria-checked={decision === "ACCEPTED"} onClick={() => setDecision("ACCEPTED")}
            className={`w-full text-left rounded-lg border p-2.5 transition-colors ${decision === "ACCEPTED" ? "border-primary ring-1 ring-primary" : "border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700"}`}>
            <p className={`text-sm font-semibold ${decision === "ACCEPTED" ? "text-primary" : "text-slate-700 dark:text-slate-200"}`}>Accepted</p>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">Applicant moves to Offered · seeds 3 starter onboarding tasks · terms freeze</p>
          </button>
          <button type="button" role="radio" aria-checked={decision === "DECLINED"} onClick={() => setDecision("DECLINED")}
            className={`w-full text-left rounded-lg border p-2.5 transition-colors ${decision === "DECLINED" ? "border-primary ring-1 ring-primary" : "border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700"}`}>
            <p className={`text-sm font-semibold ${decision === "DECLINED" ? "text-primary" : "text-slate-700 dark:text-slate-200"}`}>Declined</p>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">The application stays where it is — the recruiter decides the next move</p>
          </button>
        </div>
        <FieldError message={error} />
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "Saving…" : "Record Decision"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------- offer letter print ----------
// The letters-module convention: build an escaped, self-contained HTML letter
// and hand it to openPrintWindow (ui-kit) — C-07 refuses script/handler/
// javascript: content, the CSP meta locks the window to styles-only, and the
// browser print dialog is raised by openPrintWindow({ print: true }). Built
// CLIENT-side from the ats.offers.letter payload (company letterhead from the
// tenant settings rides along with the components/gross data).
function buildOfferLetterHtml(d: any): string {
  const e = esc
  const c = d.company || {}
  const money = (n: any) => fmtMoney(Number(n) || 0)
  const compRows = (d.components || [])
    .map((k: any) => `<tr><td>${e(k.label)}</td><td style="text-align:right;white-space:nowrap">${money(k.amount)}</td></tr>`)
    .join("")
  const gen = d.generatedAt ? new Date(d.generatedAt) : new Date()
  const headSmall = [
    c.address ? e(c.address) : "",
    [c.phone, c.email].filter(Boolean).map(e).join(" · "),
  ].filter(Boolean).join(" · ")
  return `<!doctype html><html><head><meta charset="utf-8"><title>${e(d.title)}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
body{font-family:Georgia,'Times New Roman',serif;color:#111;margin:0;padding:48px;max-width:760px;margin:0 auto;line-height:1.7}
.head{text-align:center;border-bottom:3px double #059669;padding-bottom:16px;margin-bottom:20px}
.co{font-size:24px;font-weight:700;color:#065f46;letter-spacing:.04em}
.co small{display:block;font-weight:400;color:#555;font-size:11px;font-family:Arial;margin-top:4px}
.meta{font-size:12px;color:#555;display:flex;justify-content:space-between;margin-bottom:24px}
h2{font-size:16px;margin:0 0 16px;color:#065f46}
table.sal{width:100%;border-collapse:collapse;margin:16px 0;font-size:13px}
table.sal th{background:#f0fdf4;border-bottom:2px solid #059669;padding:7px 10px;text-align:left;font-family:Arial;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#065f46}
table.sal td{border-bottom:1px solid #ddd;padding:7px 10px}
table.sal tr.total td{border-top:2px solid #059669;border-bottom:none;background:#f0fdf4;font-weight:700}
.sig{margin-top:48px}.sig .line{margin-top:6px;font-size:13px}
.foot{margin-top:40px;border-top:1px dotted #94a3b8;padding-top:8px;font-size:10px;color:#777;font-family:Arial;display:flex;justify-content:space-between}
@media print{body{padding:0}}
</style></head><body>
<div class="head"><div class="co">${e(c.companyName || "Company")}${headSmall ? `<small>${headSmall}</small>` : ""}</div></div>
<div class="meta"><span>Ref: Offer — ${e(d.title)}</span><span>Date: ${e(gen.toLocaleDateString())}</span></div>
<h2>Offer of Employment</h2>
<p>Dear ${e(d.applicantName || "Candidate")},</p>
<p>We are pleased to offer you the position of <b>${e(d.title)}</b>${d.department ? ` in our <b>${e(d.department)}</b> department` : ""}${d.grade ? ` (grade <b>${e(d.grade)}</b>)` : ""}${d.openingTitle ? `, against your application for the role of ${e(d.openingTitle)}` : ""}.</p>
${d.joiningDate ? `<p>Your proposed joining date is <b>${e(fmtDate(d.joiningDate))}</b>.</p>` : ""}
<p>The monthly remuneration package is structured as follows:</p>
<table class="sal"><thead><tr><th>Component</th><th style="text-align:right">Amount / month</th></tr></thead><tbody>${compRows}<tr class="total"><td>Gross</td><td style="text-align:right;white-space:nowrap">${money(d.gross)}</td></tr></tbody></table>
${d.notes ? `<p>${e(d.notes)}</p>` : ""}
<p>Please confirm your acceptance with our HR team. We look forward to welcoming you aboard.</p>
<div class="sig"><div>______________________</div><div class="line"><b>${e(c.signatoryName || c.companyName || "Authorized Signatory")}</b></div><div class="line">${e(c.signatoryDesignation || "Authorized Signatory")}</div></div>
<div class="foot"><span>Generated ${e(gen.toLocaleString())}</span><span>Powered by Finix HR</span></div>
</body></html>`
}

// ============================ ONBOARDING TAB (Wave 4 WP-D) ============================

function OnboardingTab({ api, applications }: {
  api: { data: any[] | null; loading: boolean; error: string | null; reload: () => void }
  applications: any[]
}) {
  const { can, toast } = useHrm()
  const [editRow, setEditRow] = useState<any | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [deleteRow, setDeleteRow] = useState<any | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  // employee picker + assignee picker — mounted only while this tab is
  // active (the parent renders the tab conditionally), so the directory
  // sweep and the users lookup happen on first visit, then cache
  const directory = useEmployeeDirectory()
  const { data: users } = useLookup<any[]>("users.list", {}, true)
  const employees = directory.data || []
  const activeUsers = (users || []).filter((u: any) => u.status === "ACTIVE")

  const tasks = api.data || []
  const today = new Date().toLocaleDateString("en-CA") // local YYYY-MM-DD
  const openCount = tasks.filter((t) => !t.doneAt).length
  const doneCount = tasks.length - openCount
  const overdueCount = tasks.filter((t) => !t.doneAt && t.dueDate && t.dueDate < today).length

  const toggle = async (row: any) => {
    setBusyId(row.id)
    try {
      const rec = await rpc<any>("ats.onboarding.toggle", { id: row.id })
      toast(rec?.doneAt ? `"${row.title}" completed` : `"${row.title}" reopened`)
      api.reload()
    } catch (e: any) {
      toast(e.message, "err")
    } finally {
      setBusyId(null)
    }
  }

  const fields: FieldDef[] = [
    { name: "title", label: "Task", required: true, span: 2, placeholder: "e.g. Collect joining documents" },
    {
      name: "applicationId", label: "Hired Applicant", type: "select", span: 2,
      help: "Link to a hired applicant or an existing employee — at least one is required.",
      options: [
        { value: "", label: "— None —" },
        ...applications.map((a) => ({ value: a.id, label: `${a.name} · ${a.openingTitle}` })),
      ],
    },
    {
      name: "employeeId", label: "Employee", type: "select",
      options: [
        { value: "", label: "— None —" },
        ...employees.map((emp: any) => ({ value: emp.id, label: emp.code ? `${emp.fullName} (${emp.code})` : emp.fullName })),
      ],
    },
    {
      name: "assigneeId", label: "Assignee", type: "select",
      options: [
        { value: "", label: "— None —" },
        ...activeUsers.map((u: any) => ({ value: u.id, label: `${u.name} · ${u.roleLabel || u.role}` })),
      ],
    },
    { name: "dueDate", label: "Due Date", type: "date", help: "Overdue open tasks turn red in the list." },
  ]

  const columns: Column<any>[] = [
    {
      key: "title", label: "Task", sortValue: (t) => t.title,
      searchValue: (t) => `${t.title} ${t.applicantName || ""} ${t.employeeName || ""} ${t.assigneeName || ""}`,
      render: (t) => (
        <div className="min-w-0">
          <p className={`text-sm font-semibold truncate ${t.doneAt ? "text-slate-400 dark:text-slate-500 line-through" : "text-slate-800 dark:text-slate-100"}`}>{t.title}</p>
          {t.doneAt && (
            <p className="text-[11px] text-slate-500 dark:text-slate-400 whitespace-nowrap">
              by {t.doneByName || "—"} · {fmtDateTime(t.doneAt)}
            </p>
          )}
        </div>
      ),
    },
    {
      key: "forName", label: "For", sortValue: (t) => t.applicantName || t.employeeName || "",
      render: (t) => (
        <div className="min-w-0">
          <p className="text-xs text-slate-700 dark:text-slate-200 truncate">{t.applicantName || t.employeeName || "—"}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
            {t.applicantName ? "Applicant" : t.employeeCode ? t.employeeCode : t.employeeName ? "Employee" : ""}
          </p>
        </div>
      ),
    },
    { key: "assigneeName", label: "Assignee", sortValue: (t) => t.assigneeName || "", render: (t) => <span className="text-xs text-slate-600 dark:text-slate-300 block truncate max-w-[130px]">{t.assigneeName || "—"}</span> },
    {
      key: "dueDate", label: "Due", sortValue: (t) => t.dueDate || "",
      render: (t) => {
        const overdue = !t.doneAt && t.dueDate && t.dueDate < today
        return <span className={`text-xs whitespace-nowrap ${overdue ? "text-rose-600 font-semibold" : "text-slate-500 dark:text-slate-400"}`}>{t.dueDate ? fmtDate(t.dueDate) : "—"}</span>
      },
    },
    {
      key: "done", label: "Status", sortValue: (t) => (t.doneAt ? 1 : 0),
      render: (t) => {
        if (t.doneAt) return <Badge variant="secondary" className="font-medium whitespace-nowrap gap-1.5 bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"><CheckCircle2 className="h-3 w-3" /> Done</Badge>
        if (t.dueDate && t.dueDate < today) return <Badge variant="secondary" className="font-medium whitespace-nowrap bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300">Overdue</Badge>
        return <Badge variant="secondary" className="font-medium whitespace-nowrap bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">Open</Badge>
      },
    },
    {
      key: "actions", label: "", align: "right", className: "w-10",
      render: (t) => (
        <div className="flex items-center justify-end gap-0.5">
          {can("recruitment", "edit") && (
            <RowIconButton icon={t.doneAt ? RotateCcw : CheckCircle2} label={t.doneAt ? "Reopen task" : "Complete task"}
              tone={t.doneAt ? "neutral" : "brand"} disabled={busyId === t.id} onClick={() => toggle(t)} />
          )}
          {can("recruitment", "edit") && (
            <RowIconButton icon={Pencil} label="Edit task" onClick={() => setEditRow(t)} />
          )}
          {can("recruitment", "delete") && (
            <RowIconButton icon={Trash2} label="Delete task" tone="danger" onClick={() => setDeleteRow(t)} />
          )}
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <ChipStat label="Open" count={openCount} tone={overdueCount > 0 ? "rose" : "slate"} />
        <ChipStat label="Done" count={doneCount} tone="emerald" />
        <ChipStat label="Overdue" count={overdueCount} tone="rose" />
        {can("recruitment", "edit") && (
          <Button size="sm" variant="outline" className="h-7 ml-auto" onClick={() => setCreateOpen(true)}>
            <Plus className="h-3.5 w-3.5 mr-1" /> New Task
          </Button>
        )}
      </div>

      {api.loading ? (
        <div className="rounded-xl border bg-white dark:bg-slate-900"><LoadingRows /></div>
      ) : api.error ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 dark:border-rose-900 dark:bg-rose-950 p-4 text-sm text-rose-700 dark:text-rose-300">{api.error}</div>
      ) : (
        <DataTable columns={columns} rows={tasks} csvName="onboarding-tasks" pageSize={15} dense
          searchPlaceholder="Search task, applicant, employee, assignee…"
          emptyTitle="No onboarding tasks" emptyHint={can("recruitment", "edit") ? "Accepting an offer auto-creates 3 starter tasks — or add checklist items manually for any hired applicant or employee." : "Nothing on the onboarding checklist yet."} />
      )}

      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 px-3 py-2 text-xs text-slate-600 dark:text-slate-300 flex items-start gap-2">
        <ListChecks className="h-3.5 w-3.5 shrink-0 mt-0.5 text-slate-400" />
        <span>
          Accepting an offer seeds <b>Prepare appointment letter</b>, <b>Collect joining documents</b> and <b>Create employee profile &amp; assign assets</b> for that applicant.
          Tasks can also hang off an existing employee — completion is stamped with who and when.
        </span>
      </div>

      <FormDialog open={createOpen} onOpenChange={(v) => { setCreateOpen(v); if (!v) api.reload() }}
        title="New Onboarding Task" description="Checklist item for a hired applicant or an existing employee."
        fields={fields}
        onSubmit={async (v) => {
          if (!v.applicationId && !v.employeeId) {
            throw new Error("Link the task to a hired applicant or an existing employee")
          }
          await rpc("ats.onboarding.save", {
            title: v.title,
            applicationId: v.applicationId || undefined,
            employeeId: v.employeeId || undefined,
            assigneeId: v.assigneeId || undefined,
            dueDate: v.dueDate || undefined,
          })
        }} />

      <FormDialog open={!!editRow} onOpenChange={(v) => { if (!v) setEditRow(null); api.reload() }}
        title="Edit Onboarding Task" description={editRow ? editRow.title : undefined}
        fields={fields}
        initial={editRow ? {
          title: editRow.title,
          applicationId: editRow.applicationId || "",
          employeeId: editRow.employeeId || "",
          assigneeId: editRow.assigneeId || "",
          dueDate: editRow.dueDate || "",
        } : undefined}
        onSubmit={async (v) => {
          if (!v.applicationId && !v.employeeId) {
            throw new Error("Link the task to a hired applicant or an existing employee")
          }
          await rpc("ats.onboarding.save", {
            id: editRow.id,
            title: v.title,
            applicationId: v.applicationId || undefined,
            employeeId: v.employeeId || undefined,
            assigneeId: v.assigneeId || undefined,
            dueDate: v.dueDate || undefined,
          })
        }} />

      <ConfirmDialog open={!!deleteRow} onOpenChange={(v) => { if (!v) { setDeleteRow(null); api.reload() } }}
        title="Delete Onboarding Task" danger confirmLabel="Delete Task"
        message={deleteRow ? `Delete "${deleteRow.title}" from the onboarding checklist?` : ""}
        onConfirm={async () => {
          await rpc("ats.onboarding.delete", { id: deleteRow.id })
        }} />
    </div>
  )
}
