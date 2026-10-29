"use client"
// ============ Employee Exit Dialogs: Terminate & Retire ============
// Provides full exit system initiation directly from the Employee Directory.
// Records termination or retirement, provisions the exit case with departmental
// clearance (HR, IT, Finance, Warehouse) and settlement pipeline, and handles
// optional immediate access/biometric revocation.

import { useState } from "react"
import {
  UserX, Award, AlertTriangle, ShieldAlert, Calendar, Clock,
  Info, Loader2, Sparkles,
} from "lucide-react"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { useHrm } from "../store"
import { rpc } from "../api"
import { StatusBadge, fmtDate } from "../shared/ui-kit"

function getToday(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, "0")
  const d = String(now.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

const TERMINATION_REASONS = [
  "Misconduct / Disciplinary Action",
  "Unsatisfactory Performance",
  "Downsizing / Redundancy / Restructuring",
  "Breach of Company Policy / Code of Conduct",
  "Contract Expiration / Non-Renewal",
  "Job Abandonment / Absconding",
  "Mutual Separation Agreement",
  "Other Reason",
]

const RETIREMENT_REASONS = [
  "Normal Retirement (Superannuation Age)",
  "Voluntary / Early Retirement",
  "Medical / Health Grounds",
  "Service Tenure Completion",
  "Mutual Retirement Agreement",
  "Other Reason",
]

// ================= TERMINATE EMPLOYEE DIALOG =================
export function TerminateEmployeeDialog({
  open,
  onOpenChange,
  employee,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  employee: any
  onDone: () => void
}) {
  const { toast } = useHrm()
  const today = getToday()

  const [selectedReason, setSelectedReason] = useState(TERMINATION_REASONS[0])
  const [customReason, setCustomReason] = useState("")
  const [effectiveDate, setEffectiveDate] = useState(today)
  const [lwd, setLwd] = useState(today)
  const [noticeMode, setNoticeMode] = useState<"WAIVED" | "FULL" | "SHORT" | "BUYOUT">("WAIVED")
  const [noticeDays, setNoticeDays] = useState<number>(0)
  const [remarks, setRemarks] = useState("")
  const [immediateRevoke, setImmediateRevoke] = useState(true)
  const [createExitClearance, setCreateExitClearance] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmText, setConfirmText] = useState("") // V3-008: typed confirm guard

  if (!employee) return null

  const handleNoticeModeChange = (mode: "WAIVED" | "FULL" | "SHORT" | "BUYOUT") => {
    setNoticeMode(mode)
    if (mode === "WAIVED") {
      setNoticeDays(0)
    } else if (mode === "FULL") {
      setNoticeDays(30)
    } else if (mode === "SHORT") {
      setNoticeDays(15)
    } else if (mode === "BUYOUT") {
      setNoticeDays(30)
    }
  }

  const handleSubmit = async () => {
    const finalReason = selectedReason === "Other Reason" ? customReason.trim() : selectedReason
    if (!finalReason) {
      setError("Please specify the termination reason.")
      return
    }
    if (!effectiveDate) {
      setError("Effective date is required.")
      return
    }
    if (lwd && lwd < effectiveDate) {
      setError("Last working day cannot be prior to effective date.")
      return
    }

    setBusy(true)
    setError(null)
    try {
      await rpc("employees.terminate", {
        employeeId: employee.id,
        reason: finalReason,
        effectiveDate,
        lwd: lwd || effectiveDate,
        noticeMode,
        noticeDays: Number(noticeDays) || 0,
        remarks: remarks.trim() || undefined,
        immediateRevoke,
        createExitClearance,
      })
      toast(`Terminated ${employee.fullName} — exit case initialized`)
      onDone()
    } catch (e: any) {
      setError(e.message || "Failed to terminate employee")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2 text-rose-700 dark:text-rose-400">
            <UserX className="h-4 w-4" /> Terminate Employee
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Employee Master Card */}
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-800/40 p-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-sm text-slate-800 dark:text-slate-100 truncate">{employee.fullName}</span>
                <span className="text-xs font-mono text-slate-500">{employee.code}</span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                {employee.designationName || "No designation"} · {employee.departmentName || "No department"} · {employee.branchName || "Main"}
              </p>
              {employee.joiningDate && (
                <p className="text-[11px] text-slate-400 mt-0.5">
                  Joined: {fmtDate(employee.joiningDate)} · Current Status: <span className="font-medium text-slate-600 dark:text-slate-300">{employee.status}</span>
                </p>
              )}
            </div>
            <StatusBadge status={employee.status} />
          </div>

          {/* Form fields */}
          <div className="space-y-3">
            {/* Reason */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Termination Reason <span className="text-rose-600">*</span></Label>
              <Select value={selectedReason} onValueChange={setSelectedReason}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue placeholder="Select primary reason" />
                </SelectTrigger>
                <SelectContent>
                  {TERMINATION_REASONS.map((r) => (
                    <SelectItem key={r} value={r} className="text-xs">{r}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedReason === "Other Reason" && (
                <Input
                  className="mt-1.5 h-8 text-xs"
                  placeholder="Specify custom termination reason…"
                  value={customReason}
                  onChange={(e) => setCustomReason(e.target.value)}
                />
              )}
            </div>

            {/* Dates row */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium flex items-center gap-1">
                  <Calendar className="h-3 w-3 text-slate-500" /> Effective Date
                </Label>
                <Input
                  type="date"
                  className="h-8 text-xs"
                  value={effectiveDate}
                  onChange={(e) => {
                    setEffectiveDate(e.target.value)
                    if (noticeMode === "WAIVED") setLwd(e.target.value)
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium flex items-center gap-1">
                  <Clock className="h-3 w-3 text-slate-500" /> Last Working Day (LWD)
                </Label>
                <Input
                  type="date"
                  className="h-8 text-xs"
                  value={lwd}
                  onChange={(e) => setLwd(e.target.value)}
                />
              </div>
            </div>

            {/* Notice Period Mode */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Notice Mode</Label>
                <Select value={noticeMode} onValueChange={(v: any) => handleNoticeModeChange(v)}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="WAIVED" className="text-xs">Immediate Release (Waived)</SelectItem>
                    <SelectItem value="FULL" className="text-xs">Full Notice (30 Days)</SelectItem>
                    <SelectItem value="SHORT" className="text-xs">Short Notice (15 Days)</SelectItem>
                    <SelectItem value="BUYOUT" className="text-xs">Notice Pay / Buyout</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Notice Days</Label>
                <Input
                  type="number"
                  min="0"
                  className="h-8 text-xs"
                  value={noticeDays}
                  onChange={(e) => setNoticeDays(Number(e.target.value))}
                />
              </div>
            </div>

            {/* Remarks */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Remarks / Investigation Note (Optional)</Label>
              <Textarea
                rows={2}
                className="text-xs"
                placeholder="Internal case remarks, evidence notes, or severance details…"
                value={remarks}
                onChange={(e) => setRemarks(e.target.value)}
              />
            </div>

            {/* Exit System Toggles */}
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-3 bg-white dark:bg-slate-900/60">
              <p className="text-xs font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
                <ShieldAlert className="h-3.5 w-3.5 text-rose-600" /> Exit System & Access Controls
              </p>

              <div className="flex items-start justify-between gap-3 pt-1">
                <div className="space-y-0.5">
                  <Label className="text-xs font-medium cursor-pointer" onClick={() => setImmediateRevoke(!immediateRevoke)}>
                    Revoke system access and biometrics immediately
                  </Label>
                  <p className="text-[11px] text-slate-500 leading-normal">
                    Disables ESS portal account, terminates all active sessions, and deactivates biometric attendance machine mapping.
                  </p>
                </div>
                <Switch checked={immediateRevoke} onCheckedChange={setImmediateRevoke} />
              </div>

              <div className="flex items-start justify-between gap-3 border-t border-slate-100 dark:border-slate-800 pt-2.5">
                <div className="space-y-0.5">
                  <Label className="text-xs font-medium cursor-pointer" onClick={() => setCreateExitClearance(!createExitClearance)}>
                    Initialize Exit Clearance & Settlement case
                  </Label>
                  <p className="text-[11px] text-slate-500 leading-normal">
                    Creates an exit case in Exit Management with departmental checklist (HR, IT, Finance, Warehouse) to track company assets and final settlement.
                  </p>
                </div>
                <Switch checked={createExitClearance} onCheckedChange={setCreateExitClearance} />
              </div>
            </div>

            {/* V3-008: Typed confirmation to prevent accidental termination */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-rose-700 dark:text-rose-400">
                Type <b>TERMINATE</b> to confirm this action
              </Label>
              <Input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="TERMINATE"
                className="h-9 text-xs font-mono border-rose-300 dark:border-rose-800 focus-visible:ring-rose-500"
              />
            </div>

            {/* Caution Banner */}
            <div className="rounded-lg border border-rose-200 dark:border-rose-900/60 bg-rose-50/70 dark:bg-rose-950/30 p-2.5 flex items-start gap-2 text-rose-700 dark:text-rose-300">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-rose-600" />
              <div className="text-xs leading-relaxed">
                <b>Termination Warning:</b> The employee status will be set to <b>TERMINATED</b> and recorded in the audit trail. This triggers offboarding and exit clearance.
              </div>
            </div>

            {error && (
              <div className="rounded-md bg-rose-50 dark:bg-rose-950 p-2.5 text-xs text-rose-600 dark:text-rose-300">
                {error}
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={handleSubmit}
            disabled={busy || confirmText !== "TERMINATE"}
            className="gap-1.5 bg-rose-600 hover:bg-rose-700 text-white"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {busy ? "Terminating…" : "Terminate Employee"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ================= RETIRE EMPLOYEE DIALOG =================
export function RetireEmployeeDialog({
  open,
  onOpenChange,
  employee,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  employee: any
  onDone: () => void
}) {
  const { toast } = useHrm()
  const today = getToday()

  const [selectedReason, setSelectedReason] = useState(RETIREMENT_REASONS[0])
  const [customReason, setCustomReason] = useState("")
  const [effectiveDate, setEffectiveDate] = useState(today)
  const [lwd, setLwd] = useState(today)
  const [noticeMode, setNoticeMode] = useState<"FULL" | "WAIVED" | "SHORT">("FULL")
  const [noticeDays, setNoticeDays] = useState<number>(30)
  const [remarks, setRemarks] = useState("")
  const [immediateRevoke, setImmediateRevoke] = useState(false)
  const [createExitClearance, setCreateExitClearance] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmText, setConfirmText] = useState("") // V3-008: typed confirm guard

  if (!employee) return null

  const handleNoticeModeChange = (mode: "FULL" | "WAIVED" | "SHORT") => {
    setNoticeMode(mode)
    if (mode === "FULL") {
      setNoticeDays(30)
    } else if (mode === "SHORT") {
      setNoticeDays(15)
    } else if (mode === "WAIVED") {
      setNoticeDays(0)
      setImmediateRevoke(true)
    }
  }

  const handleSubmit = async () => {
    const finalReason = selectedReason === "Other Reason" ? customReason.trim() : selectedReason
    if (!finalReason) {
      setError("Please specify the retirement reason.")
      return
    }
    if (!effectiveDate) {
      setError("Effective date is required.")
      return
    }
    if (lwd && lwd < effectiveDate) {
      setError("Last working day cannot be prior to effective date.")
      return
    }

    setBusy(true)
    setError(null)
    try {
      await rpc("employees.retire", {
        employeeId: employee.id,
        reason: finalReason,
        effectiveDate,
        lwd: lwd || effectiveDate,
        noticeMode,
        noticeDays: Number(noticeDays) || 0,
        remarks: remarks.trim() || undefined,
        immediateRevoke,
        createExitClearance,
      })
      toast(`Retirement processed for ${employee.fullName} — exit case initialized`)
      onDone()
    } catch (e: any) {
      setError(e.message || "Failed to process retirement")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2 text-purple-700 dark:text-purple-400">
            <Award className="h-4 w-4" /> Retire Employee
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Employee Master Card */}
          <div className="rounded-lg border border-purple-200/80 dark:border-purple-900/60 bg-purple-50/50 dark:bg-purple-950/20 p-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-sm text-slate-800 dark:text-slate-100 truncate">{employee.fullName}</span>
                <span className="text-xs font-mono text-slate-500">{employee.code}</span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                {employee.designationName || "No designation"} · {employee.departmentName || "No department"} · {employee.branchName || "Main"}
              </p>
              {employee.joiningDate && (
                <p className="text-[11px] text-slate-400 mt-0.5">
                  Joined: {fmtDate(employee.joiningDate)} · Current Status: <span className="font-medium text-slate-600 dark:text-slate-300">{employee.status}</span>
                </p>
              )}
            </div>
            <StatusBadge status={employee.status} />
          </div>

          {/* Form fields */}
          <div className="space-y-3">
            {/* Reason */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Retirement Reason / Type <span className="text-purple-600">*</span></Label>
              <Select value={selectedReason} onValueChange={setSelectedReason}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue placeholder="Select retirement type" />
                </SelectTrigger>
                <SelectContent>
                  {RETIREMENT_REASONS.map((r) => (
                    <SelectItem key={r} value={r} className="text-xs">{r}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedReason === "Other Reason" && (
                <Input
                  className="mt-1.5 h-8 text-xs"
                  placeholder="Specify custom retirement reason…"
                  value={customReason}
                  onChange={(e) => setCustomReason(e.target.value)}
                />
              )}
            </div>

            {/* Dates row */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium flex items-center gap-1">
                  <Calendar className="h-3 w-3 text-slate-500" /> Retirement Date
                </Label>
                <Input
                  type="date"
                  className="h-8 text-xs"
                  value={effectiveDate}
                  onChange={(e) => {
                    setEffectiveDate(e.target.value)
                    if (noticeMode === "WAIVED") setLwd(e.target.value)
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium flex items-center gap-1">
                  <Clock className="h-3 w-3 text-slate-500" /> Last Working Day (LWD)
                </Label>
                <Input
                  type="date"
                  className="h-8 text-xs"
                  value={lwd}
                  onChange={(e) => setLwd(e.target.value)}
                />
              </div>
            </div>

            {/* Notice Period Mode */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Notice Mode</Label>
                <Select value={noticeMode} onValueChange={(v: any) => handleNoticeModeChange(v)}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="FULL" className="text-xs">Full Notice (30 Days)</SelectItem>
                    <SelectItem value="SHORT" className="text-xs">Short Notice (15 Days)</SelectItem>
                    <SelectItem value="WAIVED" className="text-xs">Immediate Release (Waived)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Notice Days</Label>
                <Input
                  type="number"
                  min="0"
                  className="h-8 text-xs"
                  value={noticeDays}
                  onChange={(e) => setNoticeDays(Number(e.target.value))}
                />
              </div>
            </div>

            {/* Remarks / Citations */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Farewell & Gratitude Note (Optional)</Label>
              <Textarea
                rows={2}
                className="text-xs"
                placeholder="Recognition of honorable service, pension references, or citation note…"
                value={remarks}
                onChange={(e) => setRemarks(e.target.value)}
              />
            </div>

            {/* Exit System Toggles */}
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-3 bg-white dark:bg-slate-900/60">
              <p className="text-xs font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5 text-purple-600" /> Exit System & Offboarding Handover
              </p>

              <div className="flex items-start justify-between gap-3 pt-1">
                <div className="space-y-0.5">
                  <Label className="text-xs font-medium cursor-pointer" onClick={() => setImmediateRevoke(!immediateRevoke)}>
                    Revoke access immediately
                  </Label>
                  <p className="text-[11px] text-slate-500 leading-normal">
                    Disables ESS portal account immediately. Leave unchecked if the employee will continue working until their last working day.
                  </p>
                </div>
                <Switch checked={immediateRevoke} onCheckedChange={setImmediateRevoke} />
              </div>

              <div className="flex items-start justify-between gap-3 border-t border-slate-100 dark:border-slate-800 pt-2.5">
                <div className="space-y-0.5">
                  <Label className="text-xs font-medium cursor-pointer" onClick={() => setCreateExitClearance(!createExitClearance)}>
                    Initialize Exit Clearance & Settlement case
                  </Label>
                  <p className="text-[11px] text-slate-500 leading-normal">
                    Opens an exit case in Exit Management to track company assets handover and compute final gratuity, leave encashment, and provident fund settlement.
                  </p>
                </div>
                <Switch checked={createExitClearance} onCheckedChange={setCreateExitClearance} />
              </div>
            </div>

            {/* Info Banner */}
            <div className="rounded-lg border border-purple-200 dark:border-purple-900/60 bg-purple-50/70 dark:bg-purple-950/30 p-2.5 flex items-start gap-2 text-purple-800 dark:text-purple-300">
              <Info className="h-4 w-4 shrink-0 mt-0.5 text-purple-600" />
              <div className="text-xs leading-relaxed">
                <b>Retirement Information:</b> Recording retirement registers this milestone in the employee timeline and initializes the final settlement computation for terminal benefits.
              </div>
            </div>

            {error && (
              <div className="rounded-md bg-rose-50 dark:bg-rose-950 p-2.5 text-xs text-rose-600 dark:text-rose-300">
                {error}
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={busy}
            className="gap-1.5 bg-purple-700 hover:bg-purple-800 text-white"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {busy ? "Processing…" : "Retire Employee"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
