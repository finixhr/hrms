"use client"
// ============ Approval Queue (spec §3.3) ============
// The unified cross-module workflow inbox: leave, loan, advance, expense,
// payroll, letters, resignation, promotion, transfer and salary revision all
// flow through one engine with per-step role routing and amount thresholds.
import { useEffect, useMemo, useState } from "react"
import {
  BookOpen, CheckCircle2, History, XCircle, X, Eye,
  User, Calendar, Clock, Phone, Mail,
  ShieldCheck, Package, Banknote, CreditCard, AlertCircle, FileText,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { useHrm } from "../store"
import { useApi, rpc } from "../api"
import { PageHeader, RowButton, SectionTabs, StatusBadge, fmtDateTime, fmtMoney, fmtDate, titleCase, todayDhaka } from "../shared/ui-kit"
import { DataTable, type Column } from "../shared/data-table"
import { ConfirmDialog } from "../shared/form-dialog"

const PROCESS_COLORS: Record<string, string> = {
  LEAVE: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  LOAN: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  EXPENSE: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  ADVANCE: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  PAYROLL: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  LETTER: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  RESIGNATION: "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
  PROMOTION: "bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300",
  TRANSFER: "bg-cyan-100 text-cyan-700 dark:bg-cyan-950 dark:text-cyan-300",
  SALARY_REVISION: "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-950 dark:text-fuchsia-300",
  OVERTIME: "bg-lime-100 text-lime-700 dark:bg-lime-950 dark:text-lime-300",
  ENCASHMENT: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300",
  GOODS_REQUISITION: "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
  PURCHASE: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  ASSET_ISSUE: "bg-yellow-100 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-300",
  MASTER_REQUEST: "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
  // SG-C (Wave 4) — manual accounting vouchers: slate chip / violet text so
  // they read as "finance pointer rows" and never as engine workflow rows.
  VOUCHER: "bg-slate-100 text-violet-700 dark:bg-slate-800 dark:text-violet-300",
}

/** Amount for any inbox row: engine rows carry `amount`, voucher pointer rows
 *  carry it inside `payload` (the voucher mapping keeps payload authoritative). */
function rowAmount(r: any): number | null | undefined {
  return r.amount ?? r.payload?.amount
}

/** Voucher rows deep-link into the Vouchers tab instead of acting here — the
 *  approve/reject state machine (H-9) lives in the accounting view. */
function OpenVouchersButton({ navigate }: { navigate: (key: string, params?: Record<string, unknown>) => void }) {
  return (
    <RowButton icon={BookOpen} tone="brand"
      title="Open the Vouchers tab — manual vouchers approve through the accounting H-9 state machine"
      onClick={() => navigate("accounting", { tab: "vouchers" })}>
      Open Vouchers →
    </RowButton>
  )
}

function ProcessBadge({ t }: { t: string }) {
  return (
    <Badge className={`text-[10px] font-semibold whitespace-nowrap ${PROCESS_COLORS[t] || "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"}`}>
      {titleCase(t)}
    </Badge>
  )
}

export default function ApprovalsView() {
  // global-search deep link: pre-select a tab (params arrive with the view)
  const presetTab = useHrm((s) => (s.view?.key === "approvals" && s.view?.params?.tab) || undefined)
  return (
    <div className="space-y-4">
      <PageHeader
        title="Approval Queue"
        subtitle="One inbox for every workflow — steps route by role and branch/department scope, with amount-threshold auto-pass"
      />
      <SectionTabs
        defaultValue={presetTab as string | undefined}
        tabs={[
          { value: "queue", label: "Pending Queue", content: <QueueTab /> },
          { value: "history", label: "History", content: <HistoryTab /> },
          { value: "delegation", label: "Delegation", content: <DelegationTab /> },
        ]}
      />
    </div>
  )
}

// ---------- Shared: actions trail dialog ----------
function TrailDialog({ trail, onClose }: { trail: any; onClose: () => void }) {
  const actions = trail?.actions || []
  return (
    <Dialog open={!!trail} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">Approval Trail</DialogTitle>
        </DialogHeader>
        {trail && <p className="text-xs text-slate-500 -mt-1 mb-2">{trail.entityRef}</p>}
        {actions.length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-6">No actions recorded yet — waiting on step {trail?.currentStep}.</p>
        ) : (
          <ol className="space-y-0 max-h-[60vh] overflow-y-auto">
            {actions.map((a: any, i: number) => (
              <li key={i} className="flex gap-3">
                <div className="flex flex-col items-center pt-1">
                  <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${a.action === "APPROVE" ? "bg-emerald-500" : "bg-rose-500"}`} />
                  {i < actions.length - 1 && <span className="w-px flex-1 bg-slate-200 dark:bg-slate-700" />}
                </div>
                <div className="pb-4 min-w-0">
                  <p className="text-xs font-medium text-slate-700 dark:text-slate-200">
                    Step {a.step} · {a.userName}{" "}
                    <Badge className={`ml-1 text-[9px] ${a.action === "APPROVE" ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
                      {titleCase(a.action)}
                    </Badge>
                  </p>
                  {a.comment && <p className="text-[11px] text-slate-500 italic mt-0.5 break-words">“{a.comment}”</p>}
                  <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">{fmtDateTime(a.at)}</p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ---------- Request Details & Employee Context Modal ----------
function ApprovalDetailsDialog({
  request,
  onClose,
  onAct,
}: {
  request: any | null
  onClose: () => void
  onAct?: (row: any, decision: "APPROVE" | "REJECT") => void
}) {
  const { can } = useHrm()
  const [data, setData] = useState<any | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!request?.id) {
      setData(null)
      return
    }
    setLoading(true)
    setError(null)
    let dead = false
    rpc<any>("approvals.details", { id: request.id })
      .then((res) => {
        if (!dead) setData(res)
      })
      .catch((err: any) => {
        if (!dead) setError(err?.message || "Failed to load approval details")
      })
      .finally(() => {
        if (!dead) setLoading(false)
      })
    return () => {
      dead = true
    }
  }, [request?.id])

  if (!request) return null

  const isPending = request.status === "PENDING"
  const canApprove = (data?.canAct ?? request.canAct) && can("approvals", "approve") && isPending

  return (
    <Dialog open={!!request} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="sm:max-w-4xl max-h-[92vh] flex flex-col p-0 gap-0 overflow-hidden bg-slate-50 dark:bg-slate-950">
        <DialogHeader className="p-4 sm:p-5 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shrink-0">
          <div className="flex items-start justify-between gap-3 pr-6">
            <div className="space-y-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <ProcessBadge t={request.processType} />
                <DialogTitle className="text-base font-bold text-slate-800 dark:text-slate-100 truncate">
                  {request.entityRef || titleCase(request.processType)}
                </DialogTitle>
                <StatusBadge status={request.status} />
              </div>
              <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400 flex-wrap pt-0.5">
                <span className="flex items-center gap-1">
                  <Calendar className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                  Submitted {fmtDateTime(request.createdAt)}
                </span>
                {data?.submittedBy && (
                  <span className="flex items-center gap-1">
                    <User className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                    Issued by: <strong className="font-medium text-slate-700 dark:text-slate-300">{data.submittedBy.name}</strong> ({data.submittedBy.role})
                  </span>
                )}
              </div>
            </div>
            {rowAmount(request) != null && (
              <div className="text-right shrink-0">
                <span className="text-xs text-slate-400 block font-medium uppercase tracking-wider">Amount</span>
                <span className="text-lg font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                  {fmtMoney(rowAmount(request))}
                </span>
              </div>
            )}
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-5">
          {loading ? (
            <div className="py-20 flex flex-col items-center justify-center gap-2 text-slate-500">
              <Clock className="h-6 w-6 animate-spin text-emerald-600" />
              <p className="text-sm">Loading request details and employee history…</p>
            </div>
          ) : error ? (
            <div className="py-16 text-center text-sm text-rose-600 px-4">
              <AlertCircle className="h-8 w-8 mx-auto text-rose-500 mb-2" />
              {error}
            </div>
          ) : data ? (
            <>
              {/* 1. Target Employee Profile */}
              {data.employee && (
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-2xs">
                  <div className="flex items-center justify-between mb-3 border-b border-slate-100 dark:border-slate-800/80 pb-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                      <User className="h-3.5 w-3.5 text-emerald-600" /> Employee Profile
                    </span>
                    <Badge variant="outline" className="text-[10px] font-mono">
                      {data.employee.code}
                    </Badge>
                  </div>
                  <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                    <Avatar className="h-12 w-12 border border-slate-200 dark:border-slate-700 shrink-0">
                      <AvatarImage src={data.employee.photoThumb || data.employee.photoUrl || undefined} />
                      <AvatarFallback className="bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300 font-bold">
                        {data.employee.fullName.slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h4 className="text-sm font-bold text-slate-800 dark:text-slate-100">{data.employee.fullName}</h4>
                        {data.employee.nameBn && (
                          <span className="text-xs text-slate-400 font-normal">({data.employee.nameBn})</span>
                        )}
                        <Badge variant="outline" className="text-[10px] uppercase font-semibold">
                          {data.employee.status}
                        </Badge>
                      </div>
                      <p className="text-xs text-slate-600 dark:text-slate-300 mt-0.5">
                        {[data.employee.designation?.name, data.employee.department?.name, data.employee.branch?.name]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                      <div className="flex items-center gap-4 text-[11px] text-slate-500 mt-1.5 flex-wrap">
                        {data.employee.officialEmail && (
                          <span className="flex items-center gap-1">
                            <Mail className="h-3 w-3 text-slate-400" /> {data.employee.officialEmail}
                          </span>
                        )}
                        {data.employee.mobile && (
                          <span className="flex items-center gap-1">
                            <Phone className="h-3 w-3 text-slate-400" /> {data.employee.mobile}
                          </span>
                        )}
                        {data.employee.joiningDate && (
                          <span>Joined {fmtDate(data.employee.joiningDate)}</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* 2. Request Details breakdown */}
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-2xs">
                <div className="flex items-center justify-between mb-3 border-b border-slate-100 dark:border-slate-800/80 pb-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                    <FileText className="h-3.5 w-3.5 text-emerald-600" /> Request Details
                  </span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
                  {data.processType === "LEAVE" && (
                    <>
                      <div>
                        <p className="text-slate-400 text-[11px]">Leave Type</p>
                        <p className="font-semibold text-slate-800 dark:text-slate-200 mt-0.5">{data.entityDetails?.leaveTypeName || "Leave"}</p>
                      </div>
                      <div>
                        <p className="text-slate-400 text-[11px]">Duration</p>
                        <p className="font-semibold text-slate-800 dark:text-slate-200 mt-0.5">
                          {data.entityDetails?.fromDate ? `${fmtDate(data.entityDetails.fromDate)} → ${fmtDate(data.entityDetails.toDate)}` : "—"}
                        </p>
                      </div>
                      <div>
                        <p className="text-slate-400 text-[11px]">Total Days</p>
                        <p className="font-semibold text-slate-800 dark:text-slate-200 mt-0.5">
                          {data.entityDetails?.days} day{data.entityDetails?.days > 1 ? "s" : ""} {data.entityDetails?.halfDay ? "(Half Day)" : ""}
                        </p>
                      </div>
                      <div>
                        <p className="text-slate-400 text-[11px]">Contact During Leave</p>
                        <p className="font-semibold text-slate-800 dark:text-slate-200 mt-0.5">{data.entityDetails?.contactNumber || "—"}</p>
                      </div>
                      <div className="col-span-2 sm:col-span-4">
                        <p className="text-slate-400 text-[11px]">Reason for Leave</p>
                        <p className="text-slate-700 dark:text-slate-300 mt-0.5 bg-slate-50 dark:bg-slate-800/50 p-2.5 rounded-lg border border-slate-200/60 dark:border-slate-800">
                          {data.entityDetails?.reason || "No reason specified"}
                        </p>
                      </div>
                    </>
                  )}

                  {data.processType === "ASSET_ISSUE" && (
                    <>
                      <div>
                        <p className="text-slate-400 text-[11px]">Item Name</p>
                        <p className="font-semibold text-slate-800 dark:text-slate-200 mt-0.5">{data.entityDetails?.itemName || data.payload?.itemName || "—"}</p>
                      </div>
                      <div>
                        <p className="text-slate-400 text-[11px]">Item Code</p>
                        <p className="font-semibold text-slate-800 dark:text-slate-200 font-mono mt-0.5">{data.entityDetails?.itemCode || data.payload?.itemCode || "—"}</p>
                      </div>
                      <div>
                        <p className="text-slate-400 text-[11px]">Quantity</p>
                        <p className="font-semibold text-slate-800 dark:text-slate-200 mt-0.5">{data.entityDetails?.qty || data.payload?.qty || 1} {data.entityDetails?.unit || data.payload?.unit || "Pcs"}</p>
                      </div>
                      <div>
                        <p className="text-slate-400 text-[11px]">Condition Out</p>
                        <Badge variant="outline" className="mt-0.5 font-semibold text-[10px]">{data.entityDetails?.conditionOut || data.payload?.conditionOut || "NEW"}</Badge>
                      </div>
                      {(data.entityDetails?.note || data.payload?.note) && (
                        <div className="col-span-2 sm:col-span-4">
                          <p className="text-slate-400 text-[11px]">Issue Note</p>
                          <p className="text-slate-700 dark:text-slate-300 mt-0.5 bg-slate-50 dark:bg-slate-800/50 p-2.5 rounded-lg border border-slate-200/60 dark:border-slate-800">
                            {data.entityDetails?.note || data.payload?.note}
                          </p>
                        </div>
                      )}
                    </>
                  )}

                  {data.processType === "EXPENSE" && (
                    <>
                      <div>
                        <p className="text-slate-400 text-[11px]">Category</p>
                        <Badge variant="outline" className="mt-0.5 text-[10px]">{titleCase(data.entityDetails?.category || "Other")}</Badge>
                      </div>
                      <div>
                        <p className="text-slate-400 text-[11px]">Bill Date</p>
                        <p className="font-semibold text-slate-800 dark:text-slate-200 mt-0.5">{data.entityDetails?.date ? fmtDate(data.entityDetails.date) : "—"}</p>
                      </div>
                      <div>
                        <p className="text-slate-400 text-[11px]">Payment Method</p>
                        <p className="font-semibold text-slate-800 dark:text-slate-200 mt-0.5">{data.entityDetails?.paymentMethod || "Bank"}</p>
                      </div>
                      <div>
                        <p className="text-slate-400 text-[11px]">Receipt Attached</p>
                        <p className="font-semibold text-slate-800 dark:text-slate-200 mt-0.5">{data.entityDetails?.receiptName || "None"}</p>
                      </div>
                      {data.entityDetails?.description && (
                        <div className="col-span-2 sm:col-span-4">
                          <p className="text-slate-400 text-[11px]">Description</p>
                          <p className="text-slate-700 dark:text-slate-300 mt-0.5 bg-slate-50 dark:bg-slate-800/50 p-2.5 rounded-lg border border-slate-200/60 dark:border-slate-800">
                            {data.entityDetails.description}
                          </p>
                        </div>
                      )}
                    </>
                  )}

                  {data.processType === "ADVANCE" && (
                    <>
                      <div>
                        <p className="text-slate-400 text-[11px]">Advance Amount</p>
                        <p className="font-bold text-emerald-600 dark:text-emerald-400 mt-0.5">{fmtMoney(data.entityDetails?.amount || data.amount)}</p>
                      </div>
                      <div>
                        <p className="text-slate-400 text-[11px]">Deduction Month</p>
                        <p className="font-semibold text-slate-800 dark:text-slate-200 mt-0.5">{data.entityDetails?.deductionMonth || "Next Payroll"}</p>
                      </div>
                      <div>
                        <p className="text-slate-400 text-[11px]">Installments</p>
                        <p className="font-semibold text-slate-800 dark:text-slate-200 mt-0.5">{data.entityDetails?.installments || 1} month(s)</p>
                      </div>
                      <div>
                        <p className="text-slate-400 text-[11px]">Request Date</p>
                        <p className="font-semibold text-slate-800 dark:text-slate-200 mt-0.5">{data.entityDetails?.requestDate ? fmtDate(data.entityDetails.requestDate) : fmtDate(data.createdAt)}</p>
                      </div>
                      {data.entityDetails?.reason && (
                        <div className="col-span-2 sm:col-span-4">
                          <p className="text-slate-400 text-[11px]">Reason for Advance</p>
                          <p className="text-slate-700 dark:text-slate-300 mt-0.5 bg-slate-50 dark:bg-slate-800/50 p-2.5 rounded-lg border border-slate-200/60 dark:border-slate-800">
                            {data.entityDetails.reason}
                          </p>
                        </div>
                      )}
                    </>
                  )}

                  {data.processType === "LOAN" && (
                    <>
                      <div>
                        <p className="text-slate-400 text-[11px]">Principal</p>
                        <p className="font-bold text-emerald-600 dark:text-emerald-400 mt-0.5">{fmtMoney(data.entityDetails?.principal || data.amount)}</p>
                      </div>
                      <div>
                        <p className="text-slate-400 text-[11px]">Loan Type</p>
                        <p className="font-semibold text-slate-800 dark:text-slate-200 mt-0.5">{titleCase(data.entityDetails?.type || "Personal")}</p>
                      </div>
                      <div>
                        <p className="text-slate-400 text-[11px]">Installments</p>
                        <p className="font-semibold text-slate-800 dark:text-slate-200 mt-0.5">{data.entityDetails?.installments} months</p>
                      </div>
                      <div>
                        <p className="text-slate-400 text-[11px]">Monthly Deduction</p>
                        <p className="font-semibold text-slate-800 dark:text-slate-200 mt-0.5">{fmtMoney(data.entityDetails?.installmentAmount)}</p>
                      </div>
                      {data.entityDetails?.purpose && (
                        <div className="col-span-2 sm:col-span-4">
                          <p className="text-slate-400 text-[11px]">Loan Purpose</p>
                          <p className="text-slate-700 dark:text-slate-300 mt-0.5 bg-slate-50 dark:bg-slate-800/50 p-2.5 rounded-lg border border-slate-200/60 dark:border-slate-800">
                            {data.entityDetails.purpose}
                          </p>
                        </div>
                      )}
                    </>
                  )}

                  {data.processType === "MASTER_REQUEST" && (
                    <>
                      <div>
                        <p className="text-slate-400 text-[11px]">Request Type</p>
                        <Badge className="mt-1 bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300 font-semibold text-xs">
                          {data.entityDetails?.type === "ITEM" ? "Item (Stock / Goods)" : data.entityDetails?.type === "CATEGORY" ? "Category" : "Unit of Measurement"}
                        </Badge>
                      </div>
                      <div>
                        <p className="text-slate-400 text-[11px]">Requested Name</p>
                        <p className="font-bold text-slate-800 dark:text-slate-100 text-sm mt-0.5">{data.entityDetails?.name || data.entityRef}</p>
                      </div>

                      {data.entityDetails?.type === "ITEM" && (
                        <>
                          <div>
                            <p className="text-slate-400 text-[11px]">Category</p>
                            <p className="font-semibold text-slate-800 dark:text-slate-200 mt-0.5">{data.entityDetails?.category || "OTHER"}</p>
                          </div>
                          <div>
                            <p className="text-slate-400 text-[11px]">Unit</p>
                            <p className="font-semibold text-slate-800 dark:text-slate-200 mt-0.5">{data.entityDetails?.unit || "Pcs"}</p>
                          </div>
                          <div>
                            <p className="text-slate-400 text-[11px]">Unit Cost</p>
                            <p className="font-semibold tabular-nums text-slate-800 dark:text-slate-200 mt-0.5">{fmtMoney(data.entityDetails?.unitCost || 0)}</p>
                          </div>
                          <div>
                            <p className="text-slate-400 text-[11px]">Reorder Level</p>
                            <p className="font-semibold tabular-nums text-slate-800 dark:text-slate-200 mt-0.5">{data.entityDetails?.reorderLevel || 0}</p>
                          </div>
                          <div>
                            <p className="text-slate-400 text-[11px]">Brand &amp; Model</p>
                            <p className="font-semibold text-slate-800 dark:text-slate-200 mt-0.5">{data.entityDetails?.brandModel || "—"}</p>
                          </div>
                          <div>
                            <p className="text-slate-400 text-[11px]">Warranty Coverage</p>
                            <p className="font-semibold text-slate-800 dark:text-slate-200 mt-0.5">{data.entityDetails?.hasWarranty ? "Yes" : "No"}</p>
                          </div>
                        </>
                      )}

                      {data.entityDetails?.type === "CATEGORY" && (
                        <div className="col-span-2">
                          <p className="text-slate-400 text-[11px]">Description</p>
                          <p className="text-slate-700 dark:text-slate-300 mt-0.5">{data.entityDetails?.description || "—"}</p>
                        </div>
                      )}

                      {data.entityDetails?.type === "UNIT" && (
                        <div>
                          <p className="text-slate-400 text-[11px]">Symbol / Short Code</p>
                          <Badge variant="outline" className="font-mono mt-1 text-xs">{data.entityDetails?.symbol || "—"}</Badge>
                        </div>
                      )}

                      {data.entityDetails?.remarks && (
                        <div className="col-span-2 sm:col-span-4">
                          <p className="text-slate-400 text-[11px]">Requester Reason / Purpose</p>
                          <p className="text-slate-700 dark:text-slate-300 mt-0.5 bg-slate-50 dark:bg-slate-800/50 p-2.5 rounded-lg border border-slate-200/60 dark:border-slate-800">
                            {data.entityDetails.remarks}
                          </p>
                        </div>
                      )}
                    </>
                  )}

                  {data.processType !== "LEAVE" && data.processType !== "ASSET_ISSUE" && data.processType !== "EXPENSE" && data.processType !== "ADVANCE" && data.processType !== "LOAN" && data.processType !== "MASTER_REQUEST" && (
                    <div className="col-span-2 sm:col-span-4">
                      <p className="text-slate-400 text-[11px]">Reference</p>
                      <p className="font-medium text-slate-800 dark:text-slate-200 mt-0.5">{data.entityRef || "—"}</p>
                    </div>
                  )}
                </div>
              </div>

              {/* 3. Approval Flow & Previously Approved By */}
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-2xs">
                <div className="flex items-center justify-between mb-3 border-b border-slate-100 dark:border-slate-800/80 pb-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                    <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" /> Approval Flow &amp; Decisions
                  </span>
                  <span className="text-xs text-slate-400">Step {data.currentStep} of {data.steps?.length || 1}</span>
                </div>
                <div className="space-y-2.5">
                  {data.steps?.map((st: any, idx: number) => {
                    const isDone = st.status === "APPROVED"
                    const isReject = st.status === "REJECTED"
                    const isCurrent = st.sequence === data.currentStep && data.status === "PENDING"
                    return (
                      <div
                        key={idx}
                        className={`p-3 rounded-lg border transition-all ${
                          isCurrent
                            ? "border-amber-300 bg-amber-50/50 dark:border-amber-800/60 dark:bg-amber-950/20"
                            : isDone
                            ? "border-emerald-200 bg-emerald-50/40 dark:border-emerald-900/40 dark:bg-emerald-950/20"
                            : isReject
                            ? "border-rose-200 bg-rose-50/40 dark:border-rose-900/40 dark:bg-rose-950/20"
                            : "border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/50"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-center gap-2.5">
                            <span
                              className={`h-5 w-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
                                isDone
                                  ? "bg-emerald-600 text-white"
                                  : isReject
                                  ? "bg-rose-600 text-white"
                                  : isCurrent
                                  ? "bg-amber-500 text-white animate-pulse"
                                  : "bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300"
                              }`}
                            >
                              {isDone ? "✓" : isReject ? "✕" : st.sequence}
                            </span>
                            <div>
                              <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">
                                Step {st.sequence}: {st.name}
                              </p>
                              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                                Approver Role: <strong className="font-medium text-slate-700 dark:text-slate-300">{st.roleLabel || st.role || "Approver"}</strong>
                                {st.amountThreshold && ` · Auto-pass < ৳${fmtMoney(st.amountThreshold)}`}
                              </p>
                            </div>
                          </div>
                          <div>
                            {isDone && <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 text-[10px]">✓ Approved</Badge>}
                            {isReject && <Badge className="bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300 text-[10px]">✕ Rejected</Badge>}
                            {isCurrent && <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 text-[10px] animate-pulse">⏳ Awaiting Action</Badge>}
                            {!isDone && !isReject && !isCurrent && <Badge variant="outline" className="text-[10px] text-slate-400">Upcoming</Badge>}
                          </div>
                        </div>
                        {(st.actedBy || st.comment) && (
                          <div className="mt-2 pt-2 border-t border-slate-200/60 dark:border-slate-800/60 text-xs">
                            <p className="text-slate-700 dark:text-slate-300 flex items-center gap-1.5 flex-wrap">
                              <span className="font-semibold text-emerald-700 dark:text-emerald-400">Approved by:</span>
                              <strong>{st.actedBy}</strong>
                              {st.actedAt && (
                                <span className="text-[10px] text-slate-400">({fmtDateTime(st.actedAt)})</span>
                              )}
                            </p>
                            {st.comment && (
                              <p className="text-[11px] italic text-slate-600 dark:text-slate-400 mt-1 pl-2 border-l-2 border-emerald-400">
                                “{st.comment}”
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* 4. Contextual Employee History (Leave, Asset, Expense, Advance, Loan) */}
              {data.history && (
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-2xs space-y-4">
                  {/* LEAVE: Balances & Previous Leaves */}
                  {data.history.type === "LEAVE" && (
                    <>
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                            <Calendar className="h-3.5 w-3.5 text-emerald-600" /> Available Leave Balances ({new Date().getFullYear()})
                          </span>
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                          {data.history.balances?.map((b: any, idx: number) => (
                            <div key={idx} className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/30">
                              <div className="flex items-center justify-between text-[11px]">
                                <span className="font-semibold truncate text-slate-700 dark:text-slate-200">{b.leaveTypeName}</span>
                                {b.isPaid && <span className="text-[9px] text-emerald-600 font-medium bg-emerald-50 dark:bg-emerald-950 px-1 rounded">Paid</span>}
                              </div>
                              <p className="text-lg font-bold text-emerald-600 dark:text-emerald-400 mt-1 tabular-nums">
                                {b.available} <span className="text-xs font-normal text-slate-500">avail</span>
                              </p>
                              <p className="text-[10px] text-slate-400 mt-0.5">
                                Quota: {b.entitled} · Taken: {b.used} {b.pending > 0 ? `· Pending: ${b.pending}` : ""}
                              </p>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                            Previous Leave History
                          </span>
                          <span className="text-[11px] text-slate-400">{data.history.previousLeaves?.length || 0} record(s)</span>
                        </div>
                        {(!data.history.previousLeaves || data.history.previousLeaves.length === 0) ? (
                          <p className="text-xs text-slate-400 py-3 text-center">No prior leave history on record for this employee.</p>
                        ) : (
                          <div className="overflow-x-auto">
                            <table className="w-full text-left text-xs">
                              <thead>
                                <tr className="border-b text-slate-400 text-[11px]">
                                  <th className="py-1.5 pr-2">Leave Type</th>
                                  <th className="py-1.5 px-2">Duration</th>
                                  <th className="py-1.5 px-2">Days</th>
                                  <th className="py-1.5 px-2">Reason</th>
                                  <th className="py-1.5 pl-2 text-right">Status</th>
                                </tr>
                              </thead>
                              <tbody>
                                {data.history.previousLeaves.map((pl: any, idx: number) => (
                                  <tr key={idx} className="border-b last:border-0 border-slate-100 dark:border-slate-800">
                                    <td className="py-2 pr-2 font-medium text-slate-800 dark:text-slate-200">{pl.leaveTypeName}</td>
                                    <td className="py-2 px-2 text-slate-600 dark:text-slate-300">{fmtDate(pl.fromDate)} → {fmtDate(pl.toDate)}</td>
                                    <td className="py-2 px-2 font-semibold text-slate-700 dark:text-slate-200">{pl.days}d</td>
                                    <td className="py-2 px-2 text-slate-500 truncate max-w-[180px]">{pl.reason || "—"}</td>
                                    <td className="py-2 pl-2 text-right"><StatusBadge status={pl.status} /></td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    </>
                  )}

                  {/* ASSET: Previously Issued Asset List */}
                  {data.history.type === "ASSET" && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                          <Package className="h-3.5 w-3.5 text-emerald-600" /> Previously Issued Assets ({data.history.assignedAssets?.length || 0})
                        </span>
                        {data.history.currentlyHeldCount != null && (
                          <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 text-[10px]">
                            {data.history.currentlyHeldCount} currently held
                          </Badge>
                        )}
                      </div>
                      {(!data.history.assignedAssets || data.history.assignedAssets.length === 0) ? (
                        <p className="text-xs text-slate-400 py-4 text-center">No company assets currently or previously assigned to this employee.</p>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-left text-xs">
                            <thead>
                              <tr className="border-b text-slate-400 text-[11px]">
                                <th className="py-1.5 pr-2">Asset Code</th>
                                <th className="py-1.5 px-2">Asset / Item</th>
                                <th className="py-1.5 px-2">Category</th>
                                <th className="py-1.5 px-2">Serial / Tag</th>
                                <th className="py-1.5 px-2">Assigned Date</th>
                                <th className="py-1.5 px-2">Condition</th>
                                <th className="py-1.5 pl-2 text-right">Status</th>
                              </tr>
                            </thead>
                            <tbody>
                              {data.history.assignedAssets.map((ast: any, idx: number) => (
                                <tr key={idx} className="border-b last:border-0 border-slate-100 dark:border-slate-800">
                                  <td className="py-2 pr-2 font-mono font-medium text-emerald-700 dark:text-emerald-400">{ast.assetCode}</td>
                                  <td className="py-2 px-2 font-medium text-slate-800 dark:text-slate-200">{ast.name}</td>
                                  <td className="py-2 px-2 text-slate-500">{titleCase(ast.category)}</td>
                                  <td className="py-2 px-2 font-mono text-[11px] text-slate-500">{ast.serialImei || "—"}</td>
                                  <td className="py-2 px-2 text-slate-600 dark:text-slate-300">{fmtDate(ast.assignedAt)}</td>
                                  <td className="py-2 px-2 text-slate-600 dark:text-slate-300">{ast.conditionOut || "Good"}</td>
                                  <td className="py-2 pl-2 text-right">
                                    {ast.isCurrentlyHeld ? (
                                      <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 text-[10px]">
                                        Currently Held
                                      </Badge>
                                    ) : (
                                      <Badge variant="outline" className="text-[10px] text-slate-400">
                                        Returned {ast.returnedAt ? fmtDate(ast.returnedAt) : ""}
                                      </Badge>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}

                  {/* EXPENSE: Previous Claims */}
                  {data.history.type === "EXPENSE" && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                          <CreditCard className="h-3.5 w-3.5 text-emerald-600" /> Previous Expense Claims
                        </span>
                        <div className="flex items-center gap-2 text-xs">
                          <span className="text-slate-500">Approved: <strong className="text-emerald-600">{fmtMoney(data.history.totalApproved)}</strong></span>
                        </div>
                      </div>
                      {(!data.history.previousExpenses || data.history.previousExpenses.length === 0) ? (
                        <p className="text-xs text-slate-400 py-4 text-center">No previous expense claims on record for this employee.</p>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-left text-xs">
                            <thead>
                              <tr className="border-b text-slate-400 text-[11px]">
                                <th className="py-1.5 pr-2">Claim Title</th>
                                <th className="py-1.5 px-2">Category</th>
                                <th className="py-1.5 px-2">Date</th>
                                <th className="py-1.5 px-2 text-right">Amount</th>
                                <th className="py-1.5 pl-2 text-right">Status</th>
                              </tr>
                            </thead>
                            <tbody>
                              {data.history.previousExpenses.map((exp: any, idx: number) => (
                                <tr key={idx} className="border-b last:border-0 border-slate-100 dark:border-slate-800">
                                  <td className="py-2 pr-2 font-medium text-slate-800 dark:text-slate-200">{exp.title}</td>
                                  <td className="py-2 px-2 text-slate-500">{titleCase(exp.category)}</td>
                                  <td className="py-2 px-2 text-slate-600 dark:text-slate-300">{fmtDate(exp.date)}</td>
                                  <td className="py-2 px-2 font-semibold tabular-nums text-right">{fmtMoney(exp.amount)}</td>
                                  <td className="py-2 pl-2 text-right"><StatusBadge status={exp.status} /></td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}

                  {/* ADVANCE: Previous Advances */}
                  {data.history.type === "ADVANCE" && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                          <Banknote className="h-3.5 w-3.5 text-emerald-600" /> Previous Salary Advances
                        </span>
                        {data.history.outstandingTotal > 0 && (
                          <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 text-[10px]">
                            Outstanding: {fmtMoney(data.history.outstandingTotal)}
                          </Badge>
                        )}
                      </div>
                      {(!data.history.previousAdvances || data.history.previousAdvances.length === 0) ? (
                        <p className="text-xs text-slate-400 py-4 text-center">No prior salary advances on record for this employee.</p>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-left text-xs">
                            <thead>
                              <tr className="border-b text-slate-400 text-[11px]">
                                <th className="py-1.5 pr-2">Date</th>
                                <th className="py-1.5 px-2">Amount</th>
                                <th className="py-1.5 px-2">Repaid</th>
                                <th className="py-1.5 px-2">Deduction Month</th>
                                <th className="py-1.5 pl-2 text-right">Status</th>
                              </tr>
                            </thead>
                            <tbody>
                              {data.history.previousAdvances.map((adv: any, idx: number) => (
                                <tr key={idx} className="border-b last:border-0 border-slate-100 dark:border-slate-800">
                                  <td className="py-2 pr-2 text-slate-600 dark:text-slate-300">{fmtDate(adv.requestDate || adv.createdAt)}</td>
                                  <td className="py-2 px-2 font-semibold tabular-nums">{fmtMoney(adv.amount)}</td>
                                  <td className="py-2 px-2 text-emerald-600 tabular-nums">{fmtMoney(adv.repaidAmount || 0)}</td>
                                  <td className="py-2 px-2 text-slate-500">{adv.deductionMonth || "—"}</td>
                                  <td className="py-2 pl-2 text-right"><StatusBadge status={adv.status} /></td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}

                  {/* LOAN: Previous Loans */}
                  {data.history.type === "LOAN" && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                          <Banknote className="h-3.5 w-3.5 text-emerald-600" /> Previous Loans
                        </span>
                        {data.history.activeLoanBalance > 0 && (
                          <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 text-[10px]">
                            Active Balance: {fmtMoney(data.history.activeLoanBalance)}
                          </Badge>
                        )}
                      </div>
                      {(!data.history.previousLoans || data.history.previousLoans.length === 0) ? (
                        <p className="text-xs text-slate-400 py-4 text-center">No prior loans on record for this employee.</p>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-left text-xs">
                            <thead>
                              <tr className="border-b text-slate-400 text-[11px]">
                                <th className="py-1.5 pr-2">Start Date</th>
                                <th className="py-1.5 px-2">Principal</th>
                                <th className="py-1.5 px-2">Installments</th>
                                <th className="py-1.5 px-2">Monthly</th>
                                <th className="py-1.5 px-2">Repaid</th>
                                <th className="py-1.5 pl-2 text-right">Status</th>
                              </tr>
                            </thead>
                            <tbody>
                              {data.history.previousLoans.map((ln: any, idx: number) => (
                                <tr key={idx} className="border-b last:border-0 border-slate-100 dark:border-slate-800">
                                  <td className="py-2 pr-2 text-slate-600 dark:text-slate-300">{fmtDate(ln.startDate || ln.createdAt)}</td>
                                  <td className="py-2 px-2 font-semibold tabular-nums">{fmtMoney(ln.principal)}</td>
                                  <td className="py-2 px-2 text-slate-500">{ln.installments}m</td>
                                  <td className="py-2 px-2 tabular-nums">{fmtMoney(ln.installmentAmount)}</td>
                                  <td className="py-2 px-2 text-emerald-600 tabular-nums">{fmtMoney(ln.paidAmount || ln.totalRepaid || 0)}</td>
                                  <td className="py-2 pl-2 text-right"><StatusBadge status={ln.status} /></td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}

                  {/* VOUCHER Lines */}
                  {data.history.type === "VOUCHER" && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                          Journal Voucher Lines
                        </span>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-xs">
                          <thead>
                            <tr className="border-b text-slate-400 text-[11px]">
                              <th className="py-1.5 pr-2">Account Code</th>
                              <th className="py-1.5 px-2">Account Name</th>
                              <th className="py-1.5 px-2 text-right">Debit</th>
                              <th className="py-1.5 pl-2 text-right">Credit</th>
                            </tr>
                          </thead>
                          <tbody>
                            {data.history.lines?.map((ln: any, idx: number) => (
                              <tr key={idx} className="border-b last:border-0 border-slate-100 dark:border-slate-800">
                                <td className="py-2 pr-2 font-mono font-medium">{ln.account || ln.accountCode}</td>
                                <td className="py-2 px-2 font-medium">{ln.accountName || "—"}</td>
                                <td className="py-2 px-2 text-right font-semibold tabular-nums">{ln.debit ? fmtMoney(ln.debit) : "—"}</td>
                                <td className="py-2 pl-2 text-right font-semibold tabular-nums">{ln.credit ? fmtMoney(ln.credit) : "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* MASTER_REQUEST: Item / Category / Unit creation intent */}
                  {data.history.type === "MASTER_REQUEST" && (
                    <div className="p-3.5 rounded-lg bg-purple-50/70 dark:bg-purple-950/40 border border-purple-200 dark:border-purple-800/60 text-xs">
                      <div className="flex items-center gap-2 font-semibold text-purple-900 dark:text-purple-200">
                        <Package className="h-4 w-4 text-purple-600 dark:text-purple-400" />
                        <span>Master Data Creation Action</span>
                      </div>
                      <p className="text-purple-700 dark:text-purple-300 mt-1">
                        When approved, this <strong>{data.history.masterType === "ITEM" ? "Item" : data.history.masterType === "CATEGORY" ? "Category" : "Unit"}</strong> will be automatically saved to the system database, and will be immediately available in the stock inventory and goods requisition catalogues.
                      </p>
                    </div>
                  )}
                </div>
              )}
            </>
          ) : null}
        </div>

        {/* Footer Actions */}
        <div className="p-3.5 sm:p-4 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex items-center justify-between gap-3 shrink-0">
          <div>
            {canApprove && (
              <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400 flex items-center gap-1">
                <CheckCircle2 className="h-3.5 w-3.5" /> Ready for your action
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {canApprove && (
              <>
                <Button
                  className="bg-emerald-600 hover:bg-emerald-700 text-white font-medium text-xs h-8 cursor-pointer"
                  onClick={() => {
                    onClose()
                    onAct?.(request, "APPROVE")
                  }}
                >
                  <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Approve
                </Button>
                <Button
                  variant="outline"
                  className="text-rose-600 border-rose-200 hover:bg-rose-50 dark:hover:bg-rose-950 text-xs h-8 cursor-pointer"
                  onClick={() => {
                    onClose()
                    onAct?.(request, "REJECT")
                  }}
                >
                  <XCircle className="h-3.5 w-3.5 mr-1" /> Reject
                </Button>
              </>
            )}
            <Button variant="outline" className="text-xs h-8 cursor-pointer" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ================= Tab 1 — Pending queue =================
function QueueTab() {
  const { can, user, navigate } = useHrm()
  const { data, loading, error, reload } = useApi<any[]>("approvals.queue", { status: "PENDING" })
  const [act, setAct] = useState<any>(null)
  const [trail, setTrail] = useState<any>(null)
  const [selectedDetail, setSelectedDetail] = useState<any | null>(null)
  const rows = data || []
  const voucherRows = rows.filter((r: any) => r.processType === "VOUCHER")
  const awaiting = rows.filter((r: any) => r.canAct).length

  // Filter state: null = All Pending
  const presetType = useHrm((s) => (s.view?.key === "approvals" && s.view?.params?.type) || undefined)
  const [selectedType, setSelectedType] = useState<string | null>((presetType as string) || null)

  useEffect(() => {
    if (presetType) setSelectedType(presetType as string)
  }, [presetType])

  // Extract only process types that currently have pending approval items
  const typeCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const r of rows) {
      const t = r.processType
      if (t) map.set(t, (map.get(t) || 0) + 1)
    }
    return Array.from(map.entries())
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
  }, [rows])

  // If the active filter has no pending items left (e.g. after approval/rejection), reset to all
  useEffect(() => {
    if (selectedType && !typeCounts.some((tc) => tc.type === selectedType)) {
      setSelectedType(null)
    }
  }, [typeCounts, selectedType])

  // Filtered rows for the table
  const filteredRows = useMemo(() => {
    if (!selectedType) return rows
    return rows.filter((r: any) => r.processType === selectedType)
  }, [rows, selectedType])

  const filteredAwaiting = useMemo(() => {
    return filteredRows.filter((r: any) => r.canAct).length
  }, [filteredRows])

  const columns: Column<any>[] = [
    { key: "processType", label: "Process", render: (r) => <ProcessBadge t={r.processType} /> },
    {
      key: "entityRef", label: "Reference", sortValue: (r) => r.entityRef || "",
      render: (r) => <span className="text-xs font-medium text-slate-700 dark:text-slate-200">{r.entityRef || titleCase(r.entityType)}</span>,
    },
    {
      key: "amount", label: "Amount", align: "right", sortValue: (r) => rowAmount(r) ?? 0,
      render: (r) => rowAmount(r) != null
        ? <span className="text-xs font-semibold tabular-nums text-slate-700 dark:text-slate-200">{fmtMoney(rowAmount(r))}</span>
        : <span className="text-xs text-slate-400">—</span>,
    },
    {
      key: "stepName", label: "Pending At", sortValue: (r) => r.pendingAt || r.stepName,
      render: (r) => (
        <div className="flex items-center gap-1.5 flex-wrap">
          {/* SOP-1 (this audit) — show the human-readable role label (e.g.
              "HR Admin", "Vendor Owner", "Payroll Officer") as the primary
              "pending at" text, with the step name as a secondary detail.
              Previously only `stepName` was shown — that confused admins when
              the step name was generic like "Finance / Accounting Approval"
              while the actual role was PAYROLL_OFFICER. */}
          <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">{r.pendingAt || r.stepName}</span>
          <span className="text-[10px] text-slate-500 dark:text-slate-400">#{r.currentStep}</span>
          {r.stepName && r.pendingAt && r.stepName !== r.pendingAt && (
            <span className="text-[10px] text-slate-500 dark:text-slate-400 italic" title="Workflow step name (admin-configured)">({r.stepName})</span>
          )}
          {r.thresholdSkip && (
            <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300 text-[9px]" title="This step is auto-passed because the amount is below the configured threshold">
              auto-pass &lt; threshold
            </Badge>
          )}
        </div>
      ),
    },
    { key: "createdAt", label: "Submitted", sortValue: (r) => r.createdAt, render: (r) => <span className="text-[11px] text-slate-500 dark:text-slate-400">{fmtDateTime(r.createdAt)}</span> },
    { key: "status", label: "Status", render: (r) => <StatusBadge status={r.status} /> },
    {
      key: "actions", label: "", align: "right",
      render: (r) => (
        <div className="flex items-center justify-end gap-1">
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-slate-500 hover:text-emerald-700 dark:hover:text-emerald-400"
            title="View request details & employee history"
            onClick={() => setSelectedDetail(r)}
          >
            <Eye className="h-3.5 w-3.5" />
          </Button>
          {r.processType === "VOUCHER" ? (
            // SG-C — voucher pointer row: open the Vouchers tab instead of
            // Approve/Reject (canAct is always false for these rows server-side)
            <OpenVouchersButton navigate={navigate} />
          ) : (
            <>
              <Button size="icon" variant="ghost" className="h-7 w-7 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                title="View approval trail" onClick={() => setTrail(r)}>
                <History className="h-3.5 w-3.5" />
              </Button>
              {!r.canAct && (
                <Badge className={
                  r.requestedBy === user?.id
                    ? "bg-sky-100 text-sky-600 dark:bg-sky-950 dark:text-sky-300 text-[9px] whitespace-nowrap"
                    : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400 text-[9px] whitespace-nowrap"
                }
                  title={r.requestedBy === user?.id
                    ? "You submitted this request — separation of duties prevents you from acting on the FIRST step. Once another human approver approves a prior step, you can act on subsequent steps."
                    : `This step is routed to ${r.pendingAt || r.approverRoleLabel || "another approver"} — you can act once it reaches your step`}>
                  {r.requestedBy === user?.id ? "your request" : `awaiting ${r.pendingAt || r.approverRoleLabel || "other"}`}
                </Badge>
              )}
              {r.canAct && can("approvals", "approve") && (
                <>
                  {/* UI-R4 — Approve is the solid primary action; Reject a quiet
                      danger outline (audit: equal-weight buttons slowed scanning) */}
                  <RowButton icon={CheckCircle2} tone="brand" onClick={() => setAct({ row: r, decision: "APPROVE" })}>Approve</RowButton>
                  <RowButton icon={XCircle} tone="danger" onClick={() => setAct({ row: r, decision: "REJECT" })}>Reject</RowButton>
                </>
              )}
            </>
          )}
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-3">
      {!loading && !error && rows.length > 0 && (
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5 pb-0.5">
          {/* Filter tabs: only types that have pending requests, plus All Pending tab to reset */}
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setSelectedType(null)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-all flex items-center gap-1.5 cursor-pointer ${
                !selectedType
                  ? "bg-emerald-600 text-white shadow-sm ring-1 ring-emerald-600 font-semibold"
                  : "border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:border-emerald-400 hover:bg-slate-50 dark:hover:bg-slate-800/60"
              }`}
            >
              <span>All Pending</span>
              <span
                className={`text-[10px] px-1.5 py-0.2 rounded-full font-semibold ${
                  !selectedType
                    ? "bg-white/20 text-white"
                    : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400"
                }`}
              >
                {rows.length}
              </span>
            </button>

            {typeCounts.map(({ type, count }) => {
              const active = selectedType === type
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() => setSelectedType(active ? null : type)}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition-all flex items-center gap-1.5 cursor-pointer ${
                    active
                      ? "bg-emerald-600 text-white shadow-sm ring-1 ring-emerald-600 font-semibold"
                      : "border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:border-emerald-400 hover:bg-slate-50 dark:hover:bg-slate-800/60"
                  }`}
                  title={`Filter by ${titleCase(type)}`}
                >
                  <span>{titleCase(type)}</span>
                  <span
                    className={`text-[10px] px-1.5 py-0.2 rounded-full font-semibold ${
                      active
                        ? "bg-white/20 text-white"
                        : (PROCESS_COLORS[type] || "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300")
                    }`}
                  >
                    {count}
                  </span>
                </button>
              )
            })}

            {selectedType && (
              <button
                type="button"
                onClick={() => setSelectedType(null)}
                className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium text-rose-600 dark:text-rose-400 hover:text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 transition-colors cursor-pointer"
                title="Reset filter to show all pending requests"
              >
                <X className="h-3 w-3" />
                Clear
              </button>
            )}
          </div>

          {/* Quick status counters */}
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <span
              className="rounded-full border border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/40 px-3 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-300"
              title="Requests ready for your approval step"
            >
              {selectedType
                ? `${filteredAwaiting} of ${awaiting} awaiting your action`
                : `${awaiting} awaiting your action`}
            </span>
            {voucherRows.length > 0 && (
              <span
                className="rounded-full border border-violet-200 bg-violet-50 dark:border-violet-900 dark:bg-violet-950/40 px-3 py-1 text-xs font-medium text-violet-700 dark:text-violet-300"
                title="Manual journal vouchers submitted for approval — open the Vouchers tab to act on them"
              >
                {voucherRows.length} voucher{voucherRows.length === 1 ? "" : "s"} awaiting approval
              </span>
            )}
          </div>
        </div>
      )}

      <DataTable
        columns={columns}
        rows={filteredRows}
        loading={loading}
        error={error}
        pageSize={15}
        csvName={selectedType ? `approval-queue-${selectedType.toLowerCase()}` : "approval-queue"}
        searchPlaceholder="Search reference…"
        emptyTitle={selectedType ? `No ${titleCase(selectedType)} requests pending` : "All requests processed — great work!"}
        emptyHint={selectedType ? "Click 'All Pending' to reset the filter." : "New submissions from leave, loans, advances, expenses, payroll, HR letters and manual accounting vouchers will land here."}
      />

      <ConfirmDialog open={!!act} onOpenChange={(v) => { if (!v) setAct(null) }}
        title={act?.decision === "APPROVE" ? "Approve request" : "Reject request"}
        message={act
          ? `${act.row.entityRef} — currently at step "${act.row.stepName}" (step ${act.row.currentStep}).${
            act.decision === "APPROVE"
              ? " Approving advances it to the next step (or finalizes it)."
              : " Rejecting stops the workflow and notifies the requester."}`
          : ""}
        danger={act?.decision === "REJECT"}
        requireReason={act?.decision === "REJECT"}
        confirmLabel={act?.decision === "APPROVE" ? "Approve" : "Reject"}
        onConfirm={async (reason) => {
          await rpc("approvals.act", { requestId: act.row.id, decision: act.decision, comment: reason })
          reload()
        }} />

      <TrailDialog trail={trail} onClose={() => setTrail(null)} />

      <ApprovalDetailsDialog
        request={selectedDetail}
        onClose={() => setSelectedDetail(null)}
        onAct={(row, decision) => {
          setSelectedDetail(null)
          setAct({ row, decision })
        }}
      />
    </div>
  )
}

// ================= Tab 2 — History =================
function HistoryTab() {
  const [status, setStatus] = useState("APPROVED")
  const { data, loading, error } = useApi<any[]>("approvals.history", { status })
  const navigate = useHrm((s) => s.navigate)
  const [trail, setTrail] = useState<any>(null)
  const [selectedDetail, setSelectedDetail] = useState<any | null>(null)

  const columns: Column<any>[] = [
    { key: "processType", label: "Process", render: (r) => <ProcessBadge t={r.processType} /> },
    {
      key: "entityRef", label: "Reference", sortValue: (r) => r.entityRef || "",
      render: (r) => <span className="text-xs font-medium text-slate-700 dark:text-slate-200">{r.entityRef || titleCase(r.entityType)}</span>,
    },
    {
      key: "amount", label: "Amount", align: "right", sortValue: (r) => rowAmount(r) ?? 0,
      render: (r) => rowAmount(r) != null ? <span className="text-xs tabular-nums text-slate-700 dark:text-slate-200">{fmtMoney(rowAmount(r))}</span> : <span className="text-xs text-slate-400">—</span>,
    },
    { key: "stepName", label: "Last Step", render: (r) => <span className="text-xs text-slate-600 dark:text-slate-300">{r.stepName} <span className="text-[10px] text-slate-500 dark:text-slate-400">#{r.currentStep}</span></span> },
    { key: "createdAt", label: "Submitted", sortValue: (r) => r.createdAt, render: (r) => <span className="text-[11px] text-slate-500 dark:text-slate-400">{fmtDateTime(r.createdAt)}</span> },
    { key: "status", label: "Status", render: (r) => <StatusBadge status={r.status} /> },
    {
      key: "actions", label: "", align: "right",
      render: (r) => (
        <div className="flex items-center justify-end gap-1">
          <Button size="sm" variant="outline" className="h-7 text-[10px]" title="View request details & employee history" onClick={() => setSelectedDetail(r)}>
            <Eye className="h-3 w-3 mr-0.5" /> View
          </Button>
          {r.processType === "VOUCHER" ? (
            // SG-C — voucher pointer rows link to the Vouchers tab; the Trail
            // button stays available when the decision (approve/reject) is on record
            <>
              {(r.actions?.length || 0) > 0 && (
                <Button size="sm" variant="outline" className="h-7 text-[10px]" onClick={() => setTrail(r)}>
                  <History className="h-3 w-3 mr-0.5" /> Trail
                </Button>
              )}
              <OpenVouchersButton navigate={navigate} />
            </>
          ) : (
            <Button size="sm" variant="outline" className="h-7 text-[10px]" onClick={() => setTrail(r)}>
              <History className="h-3 w-3 mr-0.5" /> Trail
            </Button>
          )}
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {["APPROVED", "REJECTED", "CANCELLED"].map((s) => (
          <button key={s} type="button" onClick={() => setStatus(s)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              status === s
                ? "bg-primary text-primary-foreground"
                : "border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:border-emerald-400"
            }`}>
            {titleCase(s)}
          </button>
        ))}
      </div>

      <DataTable columns={columns} rows={data || undefined} loading={loading} error={error} pageSize={15}
        csvName={`approval-history-${status.toLowerCase()}`} searchPlaceholder="Search reference…"
        emptyTitle={`No ${status.toLowerCase()} requests`} emptyHint="Completed, rejected and cancelled requests are archived here with their full action trail." />

      <TrailDialog trail={trail} onClose={() => setTrail(null)} />
      <ApprovalDetailsDialog request={selectedDetail} onClose={() => setSelectedDetail(null)} />
    </div>
  )
}


// ================= §L — Approval Delegation tab =================
function DelegationTab() {
  const s = useHrm()
  const { data, loading, error, reload } = useApi<any[]>("delegations.list")
  const [open, setOpen] = useState(false)
  const [toEmail, setToEmail] = useState("")
  const [startDate, setStartDate] = useState(todayDhaka())
<<<<<<< HEAD
  // T-11 — one-time default (today + 7d) evaluated once per mount via the
  // lazy initializer; not a per-render impurity the purity rule guards
  // against (a plain `new Date(...)` in the render body would be).
  const [endDate, setEndDate] = useState(() => new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10))
=======
  const [endDate, setEndDate] = useState(new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10))
>>>>>>> origin/main
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  // M-03 — proper ConfirmDialog replaces the browser's window.confirm
  const [ending, setEnding] = useState<any | null>(null)

  const isAdmin = s.user?.role === "HR_ADMIN" || s.user?.role === "VENDOR_OWNER"
  const mine = (data || []).filter((d: any) => d.fromUserId === s.user?.id)
  const received = (data || []).filter((d: any) => d.toUserId === s.user?.id)

  const create = async () => {
    if (busy) return
    if (!toEmail.trim()) { s.toast("Enter the colleague's email address", "err"); return }
    setBusy(true)
    try {
      // resolve email → user id happens server-side via toUserId lookup below
      const users = await rpc<any[]>("users.list", {})
      const target = (users || []).find((u: any) => String(u.email).toLowerCase() === toEmail.trim().toLowerCase())
      if (!target) { s.toast("No user with that email in your organization", "err"); setBusy(false); return }
      await rpc("delegations.save", { toUserId: target.id, startDate, endDate, reason: reason || null })
      s.toast(`Delegation created — your approvals go to ${target.name} until ${endDate}`)
      setOpen(false); setToEmail(""); setReason("")
      reload()
    } catch (e: any) {
      s.toast(e.message || "Could not create the delegation", "err")
    } finally {
      setBusy(false)
    }
  }

  const end = async (row: any) => {
    setEnding(row)
  }

  const columns: Column<any>[] = [
    { key: "fromName", label: "Delegator", render: (r) => <div><p className="font-medium text-sm">{r.fromName}</p><p className="text-[11px] text-slate-500">{r.fromEmail}</p></div> },
    { key: "toName", label: "Delegate (acts on their behalf)", render: (r) => <div><p className="font-medium text-sm">{r.toName}</p><p className="text-[11px] text-slate-500">{r.toEmail}</p></div> },
    { key: "startDate", label: "Window", render: (r) => <span className="text-xs tabular-nums">{r.startDate} → {r.endDate}</span> },
    { key: "currentlyActive", label: "Status", render: (r) => r.currentlyActive
        ? <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">Active</Badge>
        : <Badge variant="secondary">{r.active ? "Scheduled" : "Ended"}</Badge> },
    { key: "reason", label: "Reason", render: (r) => <span className="text-xs text-slate-500">{r.reason || "—"}</span> },
    { key: "actions", label: "", align: "right", render: (r) => {
      const canEnd = isAdmin || r.fromUserId === s.user?.id || r.toUserId === s.user?.id
      return r.currentlyActive && canEnd ? (
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => end(r)} aria-label={`End delegation from ${r.fromName} to ${r.toName}`}>End</Button>
      ) : null
    } },
  ]

  return (
    <div className="space-y-4">
      <div className="rounded-xl border bg-white dark:bg-slate-900 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Delegate your approvals while you are away</p>
            <p className="text-xs text-slate-500 mt-0.5">
              You are currently delegating to <b>{mine.filter((d: any) => d.currentlyActive).length || "no one"}</b>
              {received.filter((d: any) => d.currentlyActive).length > 0 && <> · acting for <b>{received.filter((d: any) => d.currentlyActive).map((d: any) => d.fromName).join(", ")}</b></>}
              . Delegated approvals appear in the delegate&apos;s queue and are stamped &quot;(delegate of …)&quot; in the audit trail.
            </p>
          </div>
          <Button onClick={() => setOpen(true)} className="h-9">Delegate…</Button>
        </div>
      </div>
      <DataTable columns={columns} rows={data || undefined} loading={loading} error={error} pageSize={10}
        searchable={false} emptyTitle="No delegations" emptyHint="Delegate your approval authority before leave or travel — the engine honors it automatically." />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delegate my approval authority</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label htmlFor="dlg-email" className="text-xs font-medium">Colleague&apos;s email</label>
              <input id="dlg-email" className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm" value={toEmail} onChange={(e) => setToEmail(e.target.value)} placeholder="name@company.com" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label htmlFor="dlg-from" className="text-xs font-medium">From</label>
                <input id="dlg-from" type="date" className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="dlg-to" className="text-xs font-medium">Until (max 90 days)</label>
                <input id="dlg-to" type="date" className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </div>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="dlg-reason" className="text-xs font-medium">Reason (optional)</label>
              <input id="dlg-reason" className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. annual leave" />
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-2">
            <Button variant="outline" onClick={() => setOpen(false)} className="h-9">Cancel</Button>
            <Button onClick={create} disabled={busy} className="h-9">{busy ? "Creating…" : "Create delegation"}</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* M-03 — destructive action confirmed through the shared ConfirmDialog
          (busy + error states built in) instead of window.confirm */}
      <ConfirmDialog open={!!ending} onOpenChange={(v) => { if (!v) setEnding(null) }}
        title="End delegation" danger confirmLabel="End delegation"
        message={`End the delegation ${ending?.fromName} → ${ending?.toName}? Their approval queue stops receiving your requests immediately.`}
        onConfirm={async () => {
          await rpc("delegations.end", { id: ending.id })
          s.toast("Delegation ended")
          reload()
        }} />
    </div>
  )
}
