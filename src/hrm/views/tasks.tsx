"use client"
// ============ Task Management: Kanban board + list view (feeds the HR Calendar) ============
import { useEffect, useState } from "react"
import {
  KanbanSquare, List, Plus, CalendarClock, CheckSquare, Send, AlertTriangle, CircleCheck, Clock, UserCheck,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useHrm } from "../store"
import { useApi, rpc, useEmployeeDirectory } from "../api"
import { PageHeader, StatCard, StatusBadge, fmtDate, fmtDateTime, titleCase, LoadingRows } from "../shared/ui-kit"
import { DataTable, type Column } from "../shared/data-table"
import { FormDialog, type FieldDef } from "../shared/form-dialog"

const TASK_STATUSES = ["TODO", "IN_PROGRESS", "ON_HOLD", "COMPLETED", "CANCELLED"]
const STATUS_META: Record<string, { label: string; dot: string }> = {
  TODO: { label: "To Do", dot: "bg-slate-400" },
  IN_PROGRESS: { label: "In Progress", dot: "bg-sky-500" },
  ON_HOLD: { label: "On Hold", dot: "bg-amber-500" },
  COMPLETED: { label: "Completed", dot: "bg-emerald-500" },
  CANCELLED: { label: "Cancelled", dot: "bg-slate-300" },
}
const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"]
const PRIORITY_META: Record<string, string> = {
  LOW: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  MEDIUM: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  HIGH: "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
  URGENT: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
}
const SCOPES = ["EMPLOYEE", "DEPARTMENT", "HR", "PAYROLL"]

export default function TasksView() {
  const { can, user, view } = useHrm()
  const [viewMode, setViewMode] = useState<"board" | "list">("board")
  const [status, setStatus] = useState("")
  const [mine, setMine] = useState(false)
  const { data, loading, error, reload } = useApi<any[]>("tasks.list", { status, mine })
  const { data: employees } = useEmployeeDirectory()
  const [createOpen, setCreateOpen] = useState(false)
  // global-search deep link: open straight into a task's detail dialog
  const [detailId, setDetailId] = useState<string | null>((view.params as any)?.taskId || null)

  const tasks = data || []
  const detailRow = tasks.find((t: any) => t.id === detailId) || null

  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const weekEnd = new Date(todayStart.getTime() + 7 * 86400000)
  const isOpen = (t: any) => ["TODO", "IN_PROGRESS", "ON_HOLD"].includes(t.status)
  const openCount = tasks.filter(isOpen).length
  const dueThisWeek = tasks.filter((t) => t.dueDate && isOpen(t) && new Date(t.dueDate) >= todayStart && new Date(t.dueDate) <= weekEnd).length
  const completedThisMonth = tasks.filter((t) => t.status === "COMPLETED" && t.updatedAt && new Date(t.updatedAt).getMonth() === now.getMonth() && new Date(t.updatedAt).getFullYear() === now.getFullYear()).length
  const urgentCount = tasks.filter((t) => t.priority === "URGENT" && !["COMPLETED", "CANCELLED"].includes(t.status)).length

  const fields: FieldDef[] = [
    { name: "title", label: "Title", required: true, span: 2, placeholder: "e.g. Prepare festival bonus list" },
    { name: "description", label: "Description", type: "textarea", span: 2, rows: 3 },
    { name: "assigneeId", label: "Assignee", type: "select", required: true, options: (employees || []).map((e: any) => ({ value: e.id, label: `${e.fullName} (${e.code})` })) },
    { name: "scope", label: "Scope", type: "select", options: SCOPES.map((s) => ({ value: s, label: titleCase(s) })), defaultValue: "EMPLOYEE" },
    { name: "priority", label: "Priority", type: "select", options: PRIORITIES.map((p) => ({ value: p, label: titleCase(p) })), defaultValue: "MEDIUM" },
    { name: "startDate", label: "Start Date", type: "date" },
    { name: "dueDate", label: "Due Date", type: "date", help: "Due dates feed the HR Calendar automatically." },
  ]

  const columns: Column<any>[] = [
    {
      key: "title", label: "Title", sortValue: (t) => t.title,
      render: (t) => {
        const done = (t.checklist || []).filter((c: any) => c.done).length
        return (
          <div>
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t.title}</p>
            {(t.checklist || []).length > 0 && <p className="text-[11px] text-slate-500 dark:text-slate-400">{done}/{t.checklist.length} checklist</p>}
          </div>
        )
      },
    },
    { key: "assigneeName", label: "Assignee", render: (t) => <span className="text-xs text-slate-600 dark:text-slate-300">{t.assigneeName || "—"}</span> },
    { key: "scope", label: "Scope", render: (t) => <Badge variant="outline" className="text-[10px]">{titleCase(t.scope)}</Badge> },
    { key: "priority", label: "Priority", sortValue: (t) => PRIORITIES.indexOf(t.priority), render: (t) => <Badge className={`${PRIORITY_META[t.priority] || PRIORITY_META.MEDIUM} text-[10px] font-semibold`}>{titleCase(t.priority)}</Badge> },
    { key: "startDate", label: "Start", sortValue: (t) => t.startDate || "", render: (t) => <span className="text-xs text-slate-500">{fmtDate(t.startDate)}</span> },
    {
      key: "dueDate", label: "Due", sortValue: (t) => t.dueDate || "",
      render: (t) => {
        const past = t.dueDate && new Date(t.dueDate) < todayStart && !["COMPLETED", "CANCELLED"].includes(t.status)
        return <span className={`text-xs ${past ? "text-rose-600 font-semibold" : "text-slate-500"}`}>{fmtDate(t.dueDate)}</span>
      },
    },
    {
      key: "progress", label: "Progress", sortValue: (t) => t.progress || 0,
      render: (t) => (
        <div className="flex items-center gap-2 min-w-[90px]">
          <div className="flex-1 h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
            <div className="h-full rounded-full bg-emerald-500" style={{ width: `${t.progress || 0}%` }} />
          </div>
          <span className="text-[10px] tabular-nums text-slate-400">{t.progress || 0}%</span>
        </div>
      ),
    },
    { key: "status", label: "Status", render: (t) => <StatusBadge status={t.status} /> },
  ]

  return (
    <div className="space-y-4">
      <PageHeader title="Task Management"
        subtitle="Kanban board & task register — due dates automatically appear on the HR Calendar"
        actions={can("tasks", "create") && (
          <Button size="sm" onClick={() => setCreateOpen(true)} className="h-8 ">
            <Plus className="h-3.5 w-3.5 mr-1" /> New Task
          </Button>
        )} />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Open Tasks" value={openCount} icon={KanbanSquare} tone="emerald" sub="to do · in progress · on hold" />
        <StatCard label="Due This Week" value={dueThisWeek} icon={CalendarClock} tone="amber" />
        <StatCard label="Completed This Month" value={completedThisMonth} icon={CircleCheck} tone="teal" />
        <StatCard label="Urgent" value={urgentCount} icon={AlertTriangle} tone="rose" sub="open urgent priority" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex items-center rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-0.5">
          <button onClick={() => setViewMode("board")}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${viewMode === "board" ? "bg-primary text-primary-foreground" : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"}`}>
            <KanbanSquare className="h-3.5 w-3.5" /> Board
          </button>
          <button onClick={() => setViewMode("list")}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${viewMode === "list" ? "bg-primary text-primary-foreground" : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"}`}>
            <List className="h-3.5 w-3.5" /> List
          </button>
        </div>
        <FilterChip label="All" active={!status} onClick={() => setStatus("")} />
        {TASK_STATUSES.map((s) => (
          <FilterChip key={s} label={STATUS_META[s].label} active={status === s} onClick={() => setStatus(status === s ? "" : s)} />
        ))}
        {user?.employeeId && (
          <button onClick={() => setMine((m) => !m)}
            className={`h-7 rounded-full px-3 text-xs font-medium border inline-flex items-center gap-1 transition-colors ${mine ? "bg-primary text-primary-foreground border-primary" : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-emerald-400"}`}>
            <UserCheck className="h-3 w-3" /> My Tasks
          </button>
        )}
      </div>

      {loading ? (
        <div className="rounded-xl border bg-white dark:bg-slate-900"><LoadingRows /></div>
      ) : error ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 dark:border-rose-900 dark:bg-rose-950 p-4 text-sm text-rose-700 dark:text-rose-300">{error}</div>
      ) : viewMode === "board" ? (
        <div className="flex gap-3 overflow-x-auto pb-3">
          {TASK_STATUSES.map((s) => {
            const items = tasks.filter((t) => t.status === s)
            return (
              <div key={s} className="w-72 sm:w-80 shrink-0">
                <div className="flex items-center gap-2 mb-2 px-1">
                  <span className={`h-2 w-2 rounded-full ${STATUS_META[s].dot}`} />
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">{STATUS_META[s].label}</p>
                  <span className="ml-auto text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">{items.length}</span>
                </div>
                <div className="space-y-2 min-h-[60px] max-h-[65vh] overflow-y-auto pr-1">
                  {items.length === 0 && (
                    <div className="rounded-lg border border-dashed border-slate-200 dark:border-slate-800 p-3 text-center text-[11px] text-slate-500 dark:text-slate-400">No tasks</div>
                  )}
                  {items.map((t) => <TaskCard key={t.id} task={t} todayStart={todayStart} onClick={() => setDetailId(t.id)} />)}
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <DataTable columns={columns} rows={tasks} csvName="tasks" pageSize={15}
          searchPlaceholder="Search title, assignee…" onRowClick={(t) => setDetailId(t.id)}
          emptyTitle="No tasks found" emptyHint="Create a task or adjust the filters." />
      )}

      <div className="rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/50 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
        <CalendarClock className="h-3.5 w-3.5 shrink-0" />
        Task due dates feed the HR Calendar automatically — assignees and HR see them on the calendar view.
      </div>

      <FormDialog open={createOpen} onOpenChange={(v) => { setCreateOpen(v); if (!v) reload() }}
        title="New Task" description="The assignee is notified immediately; the due date appears on the HR Calendar."
        fields={fields}
        onSubmit={async (v) => {
          await rpc("tasks.save", {
            title: v.title, description: v.description || undefined, assigneeId: v.assigneeId,
            scope: v.scope, priority: v.priority, startDate: v.startDate || undefined, dueDate: v.dueDate || undefined,
          })
        }} />

      <TaskDetailDialog open={!!detailRow} onOpenChange={(v) => { if (!v) setDetailId(null) }} task={detailRow} onReload={reload} />
    </div>
  )
}

function FilterChip({ label, active, onClick }: { label: string; active?: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`h-7 rounded-full px-3 text-xs font-medium border transition-colors ${active ? "bg-primary text-primary-foreground border-primary" : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-emerald-400"}`}>
      {label}
    </button>
  )
}

// ---------- Board card ----------
function TaskCard({ task, todayStart, onClick }: { task: any; todayStart: Date; onClick: () => void }) {
  const done = (task.checklist || []).filter((c: any) => c.done).length
  const total = (task.checklist || []).length
  const overdue = task.dueDate && new Date(task.dueDate) < todayStart && !["COMPLETED", "CANCELLED"].includes(task.status)
  return (
    <div onClick={onClick}
      className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3 cursor-pointer hover:shadow-md hover:border-emerald-300 dark:hover:border-emerald-800 transition-all">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold text-slate-800 dark:text-slate-100 leading-snug">{task.title}</p>
        <Badge className={`${PRIORITY_META[task.priority] || PRIORITY_META.MEDIUM} text-[9px] font-semibold shrink-0`}>{task.priority}</Badge>
      </div>
      <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">{task.assigneeName || "—"} · {titleCase(task.scope)}</p>
      <div className="mt-2">
        <div className="flex items-center justify-between text-[10px] text-slate-500 dark:text-slate-400 mb-1">
          <span>{task.progress || 0}%</span>
          {total > 0 && <span className="inline-flex items-center gap-0.5"><CheckSquare className="h-3 w-3" />{done}/{total}</span>}
        </div>
        <div className="h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
          <div className="h-full rounded-full bg-emerald-500" style={{ width: `${task.progress || 0}%` }} />
        </div>
      </div>
      {task.dueDate && (
        <p className={`text-[10px] mt-2 inline-flex items-center gap-1 ${overdue ? "text-rose-600 font-semibold" : "text-slate-400"}`}>
          <Clock className="h-3 w-3" /> Due {fmtDate(task.dueDate)}
        </p>
      )}
    </div>
  )
}

// ---------- Task detail: checklist, comments, status + progress ----------
function TaskDetailDialog({ open, onOpenChange, task, onReload }: {
  open: boolean; onOpenChange: (v: boolean) => void; task: any; onReload: () => void
}) {
  const { can, user } = useHrm()
  const toast = useHrm((s) => s.toast)
  const [checklist, setChecklist] = useState<any[]>([])
  const [status, setStatus] = useState("")
  const [progress, setProgress] = useState(0)
  const [comments, setComments] = useState<any[]>([])
  const [comment, setComment] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const taskId = task?.id

  // Reset local state only when the dialog opens for a task (not on background list reloads,
  // so unsaved status/progress edits and comment drafts survive)
  useEffect(() => {
    if (open && task) {
      setChecklist(task.checklist || [])
      setStatus(task.status)
      setProgress(task.progress || 0)
      setComments(task.comments || [])
      setComment("")
      setError(null)
    }
  }, [open, taskId])

  if (!task) return null
  const doneCount = checklist.filter((c: any) => c.done).length

  const toggleCheck = async (idx: number) => {
    const next = checklist.map((c: any, i: number) => (i === idx ? { ...c, done: !c.done } : c))
    setChecklist(next)
    try {
      await rpc("tasks.save", { id: task.id, checklist: next })
      onReload()
    } catch (e: any) {
      toast(e.message, "err")
      setChecklist(checklist)
    }
  }

  const saveMeta = async () => {
    setBusy(true)
    setError(null)
    try {
      await rpc("tasks.save", { id: task.id, status, progress })
      toast("Task updated")
      onReload()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const addComment = async () => {
    if (!comment.trim()) return
    setBusy(true)
    setError(null)
    try {
      await rpc("tasks.comment", { taskId: task.id, text: comment.trim() })
      setComments((cs) => [...cs, { userName: user?.name || "You", text: comment.trim(), at: new Date().toISOString() }])
      setComment("")
      onReload()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base flex flex-wrap items-center gap-2">
            {task.title}
            <StatusBadge status={task.status} />
            <Badge className={`${PRIORITY_META[task.priority] || PRIORITY_META.MEDIUM} text-[10px] font-semibold`}>{task.priority}</Badge>
          </DialogTitle>
          <p className="text-xs text-slate-500 flex flex-wrap gap-x-3">
            <span>{task.assigneeName || "—"}</span>
            <span>Scope: {titleCase(task.scope)}</span>
            <span>Start: {fmtDate(task.startDate)}</span>
            <span className={task.dueDate && new Date(task.dueDate) < new Date() && !["COMPLETED", "CANCELLED"].includes(task.status) ? "text-rose-600 font-medium" : ""}>
              Due: {fmtDate(task.dueDate)}
            </span>
          </p>
        </DialogHeader>

        <div className="grid sm:grid-cols-2 gap-4 py-1">
          <div className="space-y-4">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1">Description</p>
              <p className="text-sm text-slate-700 dark:text-slate-200 whitespace-pre-wrap min-h-[40px]">{task.description || "No description."}</p>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Checklist</p>
                <span className="text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">{doneCount}/{checklist.length}</span>
              </div>
              {checklist.length === 0 ? (
                <p className="text-xs text-slate-400">No checklist items on this task.</p>
              ) : (
                <div className="space-y-1.5 max-h-52 overflow-y-auto pr-1">
                  {checklist.map((c: any, i: number) => (
                    <label key={i} className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-200 cursor-pointer">
                      <Checkbox checked={!!c.done} disabled={!can("tasks", "create")} onCheckedChange={() => toggleCheck(i)}
                        className="mt-0.5 data-[state=checked]:bg-primary data-[state=checked]:border-emerald-600" />
                      <span className={c.done ? "line-through text-slate-400" : ""}>{c.text}</span>
                    </label>
                  ))}
                </div>
              )}
              {!can("tasks", "create") && checklist.length > 0 && <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">Read-only — updating tasks requires the tasks.create permission.</p>}
            </div>
          </div>

          <div className="space-y-4">
            {can("tasks", "create") ? (
              <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Update Task</p>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Status</Label>
                  <Select value={status} onValueChange={setStatus}>
                    <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {TASK_STATUSES.map((s) => <SelectItem key={s} value={s}>{STATUS_META[s].label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium">Progress</Label>
                    <span className="text-xs tabular-nums text-slate-500">{progress}%</span>
                  </div>
                  <input type="range" min={0} max={100} step={5} value={progress}
                    onChange={(e) => setProgress(Number(e.target.value))} className="w-full accent-emerald-600" />
                  <div className="h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                    <div className="h-full rounded-full bg-emerald-500" style={{ width: `${progress}%` }} />
                  </div>
                </div>
                <Button size="sm" onClick={saveMeta} disabled={busy} className="w-full h-8 ">
                  {busy ? "Saving…" : "Save Changes"}
                </Button>
              </div>
            ) : (
              <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1.5">Progress</p>
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                    <div className="h-full rounded-full bg-emerald-500" style={{ width: `${task.progress || 0}%` }} />
                  </div>
                  <span className="text-xs tabular-nums text-slate-500">{task.progress || 0}%</span>
                </div>
              </div>
            )}
          </div>
        </div>

        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-2">Comments ({comments.length})</p>
          <div className="space-y-2 max-h-48 overflow-y-auto mb-2 pr-1">
            {comments.length === 0 && <p className="text-xs text-slate-400">No comments yet.</p>}
            {comments.map((c: any, i: number) => (
              <div key={i} className="rounded-lg bg-slate-50 dark:bg-slate-800/60 px-3 py-2">
                <p className="text-xs">
                  <span className="font-semibold text-slate-700 dark:text-slate-200">{c.userName || "User"}</span>
                  <span className="text-slate-400"> · {fmtDateTime(c.at)}</span>
                </p>
                <p className="text-sm text-slate-700 dark:text-slate-200 mt-0.5">{c.text}</p>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add a comment…"
              className="h-9" onKeyDown={(e) => { if (e.key === "Enter") addComment() }} />
            <Button aria-label="Send" size="icon" onClick={addComment} disabled={busy || !comment.trim()} className="h-9 w-9 shrink-0 ">
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {error && <p className="text-sm text-rose-600 bg-rose-50 dark:bg-rose-950 rounded-md px-3 py-2">{error}</p>}
      </DialogContent>
    </Dialog>
  )
}
