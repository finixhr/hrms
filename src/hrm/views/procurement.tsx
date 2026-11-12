"use client"
// ============ Requisition & Purchase — goods requisition lifecycle UI ============
// Employee requisitions → approval workflow → stock check → auto Purchase
// Request for shortage → quotations → purchase approval → stock entry →
// final issue → employee receipt confirmation. Fully traceable both ways.
import { useEffect, useState } from "react"
import { Plus, Send, CheckCircle2, XCircle, Undo2, Printer, Loader2, FileText,
  ShoppingCart, RefreshCcw, AlertTriangle, Boxes, ClipboardCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { GoodsRequisitionDialog } from "../shared/goods-requisition-dialog"
import { useHrm } from "../store"
import { rpc, useApi } from "../api"

// HRM store toast (text, kind) — same signature every other view uses
const toast = (text: string, kind?: "ok" | "err") => useHrm.getState().toast(text, kind)
import {
  PageHeader, StatCard, SectionCard, SectionTabs, LoadingRows, ErrorBanner,
  StatusBadge, fmtMoney, fmtDate, fmtDateTime, openPrintWindow, esc,
} from "../shared/ui-kit"
import { DataTable, type Column } from "../shared/data-table"

const STATUS_STYLES: Record<string, string> = {
  DRAFT: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  SUBMITTED: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  PENDING_APPROVAL: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  PENDING_STOCK: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  PURCHASE_REQUIRED: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  PENDING_PURCHASE: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  PENDING_STOCK_ENTRY: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  STOCK_AVAILABLE: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  PENDING_FINAL_APPROVAL: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  APPROVED: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  ISSUED: "bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300",
  PENDING_RECEIPT_CONFIRMATION: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  COMPLETED: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  REJECTED: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  RETURNED: "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
  CANCELLED: "bg-slate-200 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
  RECEIPT_DISPUTED: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  QUOTATION_COLLECTION: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  STOCK_ENTERED: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  PARTIALLY_FULFILLED: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  ISSUING: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
}

function StatusChip({ status }: { status?: string | null }) {
  if (!status) return <span className="text-slate-400 text-xs">—</span>
  return <Badge className={`text-[9px] whitespace-nowrap ${STATUS_STYLES[status] || ""}`}>{status.replace(/_/g, " ")}</Badge>
}

export default function ProcurementView() {
  const { can: _can } = useHrm()
  const tabs = [
    { value: "requisitions", label: "Goods Requisitions", content: <RequisitionsTab /> },
    { value: "purchases", label: "Purchase Requests", content: <PurchasesTab /> },
    { value: "suppliers", label: "Suppliers", content: <SuppliersTab /> },
    { value: "reports", label: "Reports", content: <ReportsTab /> },
  ]
  return (
    <div className="space-y-4">
      <PageHeader
        title="Requisition & Purchase"
        subtitle="Employee goods requisitions, workflow approvals, shortage-driven purchase requests, quotations, stock entry and receipt confirmation"
      />
      {/* M-23 — search deep links pre-select the tab (palette entries carry view params) */}
      <SectionTabs defaultValue={(useHrm((st) => (st.view?.key === "procurement" && (st.view?.params as any)?.tab)) as string) || "requisitions"} tabs={tabs} />
    </div>
  )
}

// ================= GOODS REQUISITIONS =================
function RequisitionsTab() {
  const { can, user: _user } = useHrm()
  const [status, setStatus] = useState("")
  const [priority, setPriority] = useState("")
  const { data, loading, error, reload } = useApi<any[]>("requisitions.list", { ...(status ? { status } : {}), ...(priority ? { priority } : {}) })
  const [createOpen, setCreateOpen] = useState(false)
  const [detail, setDetail] = useState<string | null>(null)
  const [act, setAct] = useState<any>(null)

  const columns: Column<any>[] = [
    { key: "reqNo", label: "Requisition", sortValue: (r) => r.reqNo, render: (r) => (
      <button className="text-left" onClick={() => setDetail(r.id)}>
        <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-400 hover:underline">{r.reqNo}</p>
        <p className="text-[11px] text-slate-500">{fmtDate(r.requestDate)} · {r.priority === "URGENT" ? "🔴 Urgent" : "Normal"}</p>
      </button>
    ) },
    { key: "employeeName", label: "Employee", sortValue: (r) => r.employeeName, render: (r) => (
      <div><p className="text-sm font-medium">{r.employeeName}</p><p className="text-[11px] text-slate-500">{r.employeeCode}</p></div>
    ) },
    { key: "items", label: "Items", align: "right", sortValue: (r) => r.itemCount, render: (r) => (
      <div className="text-xs"><span className="font-semibold">{r.itemCount}</span> <span className="text-slate-400">lines ·</span> {r.totalQty} qty</div>
    ) },
    { key: "shortage", label: "Shortage", align: "right", sortValue: (r) => r.totalShortage, render: (r) => r.totalShortage > 0 ? (
      <Badge className="bg-amber-100 text-amber-700 text-[9px]">{r.totalShortage} to purchase</Badge>
    ) : <span className="text-slate-400 text-xs">—</span> },
    { key: "status", label: "Status", render: (r) => <StatusChip status={r.status} /> },
    { key: "actions", label: "", align: "right", render: (r) => (
      <div className="flex gap-1 justify-end">
        {r.status === "DRAFT" && can("procurement", "create") && (
          <Button size="sm" className="h-7 text-[11px] " onClick={() => setAct({ requisition: r, decision: "SUBMIT" })}>
            <Send className="h-3 w-3 mr-1" /> Submit
          </Button>
        )}
        {["STOCK_AVAILABLE", "PENDING_FINAL_APPROVAL"].includes(r.status) && can("procurement", "approve") && (
          <Button size="sm" className="h-7 text-[11px] " onClick={() => setAct({ requisition: r, decision: "ISSUE" })}>
            <Boxes className="h-3 w-3 mr-1" /> Issue goods
          </Button>
        )}
        <Button size="sm" variant="outline" className="h-7 text-[11px] bg-white dark:bg-slate-900" onClick={() => setDetail(r.id)}>
          <FileText className="h-3 w-3 mr-1" /> View
        </Button>
      </div>
    ) },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          <Select value={status || "all"} onValueChange={(v) => setStatus(v === "all" ? "" : v)}>
            <SelectTrigger className="h-8 w-52 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {["DRAFT", "PENDING_APPROVAL", "PENDING_STOCK", "PURCHASE_REQUIRED", "PENDING_PURCHASE", "PENDING_STOCK_ENTRY", "STOCK_AVAILABLE", "ISSUED", "PENDING_RECEIPT_CONFIRMATION", "COMPLETED", "REJECTED", "RETURNED", "CANCELLED", "RECEIPT_DISPUTED"].map((s) => (
                <SelectItem key={s} value={s}>{s.replace(/_/g, " ")}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={priority || "all"} onValueChange={(v) => setPriority(v === "all" ? "" : v)}>
            <SelectTrigger className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any priority</SelectItem>
              <SelectItem value="NORMAL">Normal</SelectItem>
              <SelectItem value="URGENT">Urgent</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {can("procurement", "create") && (
          <Button size="sm" className="h-8 text-xs " onClick={() => setCreateOpen(true)}>
            <Plus className="h-3.5 w-3.5 mr-1" /> New Goods Requisition
          </Button>
        )}
      </div>

      <DataTable columns={columns} rows={data ?? undefined} loading={loading} error={error} pageSize={12} csvName="goods-requisitions"
        searchPlaceholder="Search requisition no, employee…" emptyTitle="No goods requisitions" emptyHint="Employees can request office goods from My Self-Service → Request Goods." />

      <GoodsRequisitionDialog open={createOpen} onOpenChange={setCreateOpen} onSaved={reload} />
      {detail && <RequisitionDetailDialog id={detail} onClose={() => { setDetail(null); reload() }} onAction={(a) => { setDetail(null); setAct(a) }} />}
      {act && <ActionDialog act={act} onClose={(v) => { setAct(null); if (v) reload() }} />}
    </div>
  )
}

// ---------- requisition detail (§19) ----------
function RequisitionDetailDialog({ id, onClose, onAction }: { id: string; onClose: () => void; onAction: (a: any) => void }) {
  const { can } = useHrm()
  const [data, setData] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    ;(async () => {
      try { setData(await rpc("requisitions.get", { id })) } catch (e: any) { setError(e.message) }
    })()
  }, [id])

  if (error) return <Dialog open onOpenChange={onClose}><DialogContent className="sm:max-w-lg"><ErrorBanner message={error} /></DialogContent></Dialog>
  if (!data) return <Dialog open onOpenChange={onClose}><DialogContent className="sm:max-w-2xl"><LoadingRows rows={6} /></DialogContent></Dialog>

  const timeline = [
    { label: "Submitted", done: !!data.submittedAt || data.status !== "DRAFT" },
    { label: "Manager Approved", done: ["APPROVED", "STOCK_AVAILABLE", "ISSUED", "PENDING_RECEIPT_CONFIRMATION", "COMPLETED", "PENDING_STOCK", "PURCHASE_REQUIRED", "PENDING_PURCHASE", "PENDING_STOCK_ENTRY"].includes(data.status) },
    { label: "Stock Checked", done: ["ISSUED", "COMPLETED", "STOCK_AVAILABLE", "PENDING_STOCK", "PURCHASE_REQUIRED", "PENDING_PURCHASE", "PENDING_STOCK_ENTRY"].includes(data.status) },
    { label: "Purchase (if short)", done: ["STOCK_AVAILABLE", "ISSUED", "PENDING_RECEIPT_CONFIRMATION", "COMPLETED"].includes(data.status) },
    { label: "Goods Issued", done: ["ISSUED", "PENDING_RECEIPT_CONFIRMATION", "COMPLETED"].includes(data.status) },
    { label: "Receipt Confirmed", done: data.status === "COMPLETED" },
  ]

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2 flex-wrap">
            {data.reqNo} <StatusChip status={data.status} />
            {data.priority === "URGENT" && <Badge className="bg-rose-100 text-rose-700 text-[9px]">URGENT</Badge>}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {data.employeeName} · requested {fmtDate(data.requestDate)}{data.requiredDate ? ` · required by ${fmtDate(data.requiredDate)}` : ""}
            {data.purpose ? ` · ${data.purpose}` : ""}
          </DialogDescription>
        </DialogHeader>

        {/* workflow timeline */}
        <div className="flex flex-wrap gap-1.5">
          {timeline.map((t, i) => (
            <Badge key={i} className={`text-[9px] ${t.done ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" : "bg-slate-100 text-slate-400 dark:bg-slate-800"}`}>
              {t.done ? <CheckCircle2 className="h-3 w-3 mr-1" /> : <AlertTriangle className="h-3 w-3 mr-1" />} {t.label}
            </Badge>
          ))}
        </div>

        {/* items with live availability */}
        <div className="rounded-xl border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-slate-50 dark:bg-slate-800">
                <TableHead className="text-[10px] uppercase">Item</TableHead>
                <TableHead className="text-[10px] uppercase text-right">Requested</TableHead>
                <TableHead className="text-[10px] uppercase text-right">Available</TableHead>
                <TableHead className="text-[10px] uppercase text-right">Shortage</TableHead>
                <TableHead className="text-[10px] uppercase text-right">Issued</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data.items || []).map((l: any) => (
                <TableRow key={l.id}>
                  <TableCell className="py-2">
                    <p className="text-xs font-medium">{l.itemName}</p>
                    {l.specification && <p className="text-[10px] text-slate-500">{l.specification}</p>}
                  </TableCell>
                  <TableCell className="text-xs py-2 text-right tabular-nums">{l.quantity} {l.unit}</TableCell>
                  <TableCell className="text-xs py-2 text-right tabular-nums text-emerald-700 dark:text-emerald-400">{l.liveAvailableQty}</TableCell>
                  <TableCell className="text-xs py-2 text-right tabular-nums text-amber-600">{l.shortageQty > 0 ? l.shortageQty : "—"}</TableCell>
                  <TableCell className="text-xs py-2 text-right tabular-nums">{l.issuedQty || "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {/* linked purchase requests */}
        {(data.purchaseRequests || []).length > 0 && (
          <SectionCard title="Linked purchase requests">
            <div className="space-y-2">
              {data.purchaseRequests.map((pr: any) => (
                <div key={pr.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2">
                  <div>
                    <p className="text-xs font-semibold">{pr.reqNo} <span className="text-slate-400 font-normal">· {pr.remarks || "shortage purchase"}</span></p>
                    <p className="text-[10px] text-slate-500">{(pr.items || []).length} line(s){pr.selectedQuotationId ? " · quotation selected" : ""}</p>
                  </div>
                  <StatusChip status={pr.status} />
                </div>
              ))}
            </div>
          </SectionCard>
        )}

        {/* history */}
        {(data.history || []).length > 0 && (
          <SectionCard title="Approval & status history">
            <div className="space-y-1.5 max-h-48 overflow-y-auto">
              {data.history.map((h: any, i: number) => (
                <div key={i} className="flex items-start gap-2 text-[11px]">
                  <span className="text-slate-400 tabular-nums shrink-0">{fmtDateTime(h.createdAt)}</span>
                  <span className="font-medium shrink-0">{h.userName}</span>
                  <span className="text-slate-600 dark:text-slate-300">{h.action}{h.fromStatus && h.toStatus ? ` — ${h.fromStatus} → ${h.toStatus}` : ""}{h.comment ? ` · "${h.comment}"` : ""}</span>
                </div>
              ))}
            </div>
          </SectionCard>
        )}

        <DialogFooter className="gap-2 flex-wrap">
          <Button variant="outline" onClick={onClose}>Close</Button>
          {data.status === "DRAFT" && can("procurement", "create") && (
            <Button onClick={() => onAction({ requisition: data, decision: "SUBMIT" })}>
              <Send className="h-4 w-4 mr-1.5" /> Submit
            </Button>
          )}
          {["PENDING_APPROVAL", "SUBMITTED"].includes(data.status) && can("procurement", "approve") && (
            <>
              <Button variant="outline" className="text-rose-600 border-rose-200 hover:bg-rose-50 dark:border-rose-900" onClick={() => onAction({ requisition: data, decision: "REJECT" })}>
                <XCircle className="h-4 w-4 mr-1.5" /> Reject
              </Button>
              <Button variant="outline" className="text-amber-600 border-amber-200 hover:bg-amber-50 dark:border-amber-900" onClick={() => onAction({ requisition: data, decision: "RETURN" })}>
                <Undo2 className="h-4 w-4 mr-1.5" /> Return
              </Button>
              <Button onClick={() => onAction({ requisition: data, decision: "APPROVE" })}>
                <CheckCircle2 className="h-4 w-4 mr-1.5" /> Approve
              </Button>
            </>
          )}
          {["STOCK_AVAILABLE", "PENDING_FINAL_APPROVAL"].includes(data.status) && can("procurement", "approve") && (
            <Button onClick={() => onAction({ requisition: data, decision: "ISSUE" })}>
              <Boxes className="h-4 w-4 mr-1.5" /> Issue goods
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------- approve / reject / return / submit / issue ----------
function ActionDialog({ act, onClose }: { act: any; onClose: (done: boolean) => void }) {
  const toast = useHrm((s) => s.toast)
  const [comment, setComment] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const r = act.requisition

  const run = async () => {
    setBusy(true); setErr(null)
    try {
      if (act.decision === "SUBMIT") {
        await rpc("requisitions.submit", { id: r.id })
        toast(`${r.reqNo} submitted for approval`)
      } else if (act.decision === "ISSUE") {
        const res = await rpc("requisitions.issue", { id: r.id })
        toast(`Goods issued on ${r.reqNo} — ${res.issuedLines?.length || 0} item(s) deducted from stock`)
      } else {
        await rpc("requisitions.action", { id: r.id, decision: act.decision, comment: comment || undefined })
        toast(`${r.reqNo} ${act.decision === "APPROVE" ? "approved" : act.decision === "REJECT" ? "rejected" : "returned for correction"}`)
      }
      onClose(true)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  const titles: Record<string, string> = {
    APPROVE: "Approve requisition", REJECT: "Reject requisition", RETURN: "Return for correction",
    SUBMIT: "Submit for approval", ISSUE: "Issue goods from stock",
  }
  const descs: Record<string, string> = {
    APPROVE: "On final approval the system re-validates stock in real time: if everything is available it issues immediately; if there is a shortage it creates a linked purchase request for the shortfall instead of rejecting.",
    REJECT: "The requisition is closed as rejected and the employee is notified.",
    RETURN: "The approval request is cancelled and the requisition goes back to the employee as RETURNED — editable and resubmittable with history preserved.",
    SUBMIT: "Sends the requisition into the configured approval workflow.",
    ISSUE: "Deducts the requested quantities from available stock inside a database transaction, records ISSUE transactions and notifies the employee to confirm receipt.",
  }

  return (
    <Dialog open onOpenChange={() => !busy && onClose(false)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">{titles[act.decision]} — {r.reqNo}</DialogTitle>
          <DialogDescription className="text-xs">{descs[act.decision]}</DialogDescription>
        </DialogHeader>
        {act.decision !== "SUBMIT" && (
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Comment</Label>
            <Input value={comment} onChange={(e) => setComment(e.target.value)} className="h-9" placeholder="Optional note recorded in the history" />
          </div>
        )}
        {err && <p className="text-sm text-rose-600 bg-rose-50 dark:bg-rose-950 rounded-md px-3 py-2">{err}</p>}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onClose(false)} disabled={busy}>Cancel</Button>
          <Button onClick={run} disabled={busy}
            className={act.decision === "REJECT" ? "bg-rose-600 hover:bg-rose-700 text-white" : act.decision === "RETURN" ? "bg-amber-600 hover:bg-amber-700 text-white" : ""}>
            {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null} Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ================= PURCHASE REQUESTS =================
function PurchasesTab() {
  const { can } = useHrm()
  const [status, setStatus] = useState("")
  const { data, loading, error, reload } = useApi<any[]>("purchase.list", status ? { status } : {})
  const [detail, setDetail] = useState<string | null>(null)
  const [quoteOpen, setQuoteOpen] = useState<any>(null)
  const [receiveOpen, setReceiveOpen] = useState<any>(null)

  const columns: Column<any>[] = [
    { key: "reqNo", label: "PR No.", sortValue: (r) => r.reqNo, render: (r) => (
      <button className="text-left" onClick={() => setDetail(r.id)}>
        <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-400 hover:underline">{r.reqNo}</p>
        {r.goodsReqNo ? <p className="text-[11px] text-slate-500">from {r.goodsReqNo}</p> : <p className="text-[11px] text-slate-400">manual</p>}
      </button>
    ) },
    { key: "employeeName", label: "For", sortValue: (r) => r.employeeName, render: (r) => <span className="text-xs">{r.employeeName}</span> },
    { key: "items", label: "Lines", align: "right", render: (r) => <span className="text-xs">{(r.items || []).length}</span> },
    { key: "quotationCount", label: "Quotations", align: "right", sortValue: (r) => r.quotationCount, render: (r) => (
      <Badge variant="outline" className="text-[10px]">{r.quotationCount || 0}</Badge>
    ) },
    { key: "totalAmount", label: "Total", align: "right", sortValue: (r) => r.totalAmount, render: (r) => <span className="text-xs font-semibold tabular-nums">{r.totalAmount > 0 ? fmtMoney(r.totalAmount) : "—"}</span> },
    { key: "status", label: "Status", render: (r) => <StatusChip status={r.status} /> },
    { key: "actions", label: "", align: "right", render: (r) => (
      <div className="flex gap-1 justify-end">
        {["DRAFT", "QUOTATION_COLLECTION"].includes(r.status) && can("procurement", "edit") && (
          <Button size="sm" variant="outline" className="h-7 text-[11px] bg-white dark:bg-slate-900" onClick={() => setQuoteOpen(r)}>
            <FileText className="h-3 w-3 mr-1" /> Quotation
          </Button>
        )}
        {["DRAFT", "QUOTATION_COLLECTION", "RETURNED"].includes(r.status) && can("procurement", "create") && (
          <Button size="sm" className="h-7 text-[11px] " onClick={() => submitPurchase(r, reload)}>
            <Send className="h-3 w-3 mr-1" /> Submit
          </Button>
        )}
        {["APPROVED", "PENDING_STOCK_ENTRY"].includes(r.status) && can("inventory", "approve") && (
          <Button size="sm" className="h-7 text-[11px] bg-teal-600 hover:bg-teal-700 text-white" onClick={() => setReceiveOpen(r)}>
            <ClipboardCheck className="h-3 w-3 mr-1" /> Receive stock
          </Button>
        )}
        <Button size="sm" variant="outline" className="h-7 text-[11px] bg-white dark:bg-slate-900" onClick={() => setDetail(r.id)}>View</Button>
      </div>
    ) },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Select value={status || "all"} onValueChange={(v) => setStatus(v === "all" ? "" : v)}>
          <SelectTrigger className="h-8 w-52 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {["DRAFT", "QUOTATION_COLLECTION", "PENDING_APPROVAL", "APPROVED", "PENDING_STOCK_ENTRY", "STOCK_ENTERED", "REJECTED", "CANCELLED"].map((s) => (
              <SelectItem key={s} value={s}>{s.replace(/_/g, " ")}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <DataTable columns={columns} rows={data ?? undefined} loading={loading} error={error} pageSize={12} csvName="purchase-requests"
        searchPlaceholder="Search PR no, employee…" emptyTitle="No purchase requests" emptyHint="Purchase requests are auto-created when an approved requisition has a stock shortage, or created manually." />

      {detail && <PurchaseDetailDialog id={detail} onClose={() => { setDetail(null); reload() }} />}
      {quoteOpen && <QuotationDialog pr={quoteOpen} onClose={(v) => { setQuoteOpen(null); if (v) reload() }} />}
      {receiveOpen && <ReceiveStockDialog pr={receiveOpen} onClose={(v) => { setReceiveOpen(null); if (v) reload() }} />}
    </div>
  )
}

async function submitPurchase(r: any, reload: () => void) {
  try {
    await rpc("purchase.submit", { id: r.id })
    toast(`${r.reqNo} submitted for purchase approval`)
    reload()
  } catch (e: any) { toast(e.message, "err") }
}

function PurchaseDetailDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useHrm()
  const [data, setData] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    ;(async () => {
      try { setData(await rpc("purchase.get", { id })) } catch (e: any) { setError(e.message) }
    })()
  }, [id])

  if (error) return <Dialog open onOpenChange={onClose}><DialogContent className="sm:max-w-lg"><ErrorBanner message={error} /></DialogContent></Dialog>
  if (!data) return <Dialog open onOpenChange={onClose}><DialogContent className="sm:max-w-2xl"><LoadingRows rows={6} /></DialogContent></Dialog>

  const act = async (decision: string) => {
    setBusy(true)
    try {
      await rpc("purchase.action", { id: data.id, decision })
      toast(`${data.reqNo} ${decision === "APPROVE" ? "approved — pending stock entry" : "rejected"}`)
      onClose()
    } catch (e: any) { toast(e.message, "err") } finally { setBusy(false) }
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">{data.reqNo} <StatusChip status={data.status} /></DialogTitle>
          <DialogDescription className="text-xs">
            {data.goodsReqNo ? `Shortage purchase for requisition ${data.goodsReqNo} · ` : ""}{data.remarks || ""}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-xl border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-slate-50 dark:bg-slate-800">
                <TableHead className="text-[10px] uppercase">Item</TableHead>
                <TableHead className="text-[10px] uppercase text-right">Requested</TableHead>
                <TableHead className="text-[10px] uppercase text-right">Available</TableHead>
                <TableHead className="text-[10px] uppercase text-right">Purchase qty</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data.items || []).map((i: any) => (
                <TableRow key={i.id}>
                  <TableCell className="py-2 text-xs font-medium">{i.itemName}{i.specification ? <span className="text-slate-400 font-normal"> — {i.specification}</span> : ""}</TableCell>
                  <TableCell className="text-xs py-2 text-right tabular-nums">{i.requestedQty} {i.unit}</TableCell>
                  <TableCell className="text-xs py-2 text-right tabular-nums text-emerald-700 dark:text-emerald-400">{i.availableQty}</TableCell>
                  <TableCell className="text-xs py-2 text-right tabular-nums font-bold text-amber-600">{i.purchaseQty} {i.unit}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {/* quotation comparison */}
        {(data.quotations || []).length > 0 && (
          <SectionCard title="Quotation comparison">
            <div className="space-y-2">
              {data.quotations.map((q: any) => (
                <div key={q.id} className={`rounded-lg border px-3 py-2 ${q.status === "SELECTED" ? "border-emerald-300 bg-emerald-50/60 dark:border-emerald-800 dark:bg-emerald-950/30" : "border-slate-200 dark:border-slate-800"}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold">{q.supplierName}{q.quotationNo ? ` · ${q.quotationNo}` : ""}{q.status === "SELECTED" && <Badge className="ml-2 bg-emerald-100 text-emerald-700 text-[9px]">selected</Badge>}</p>
                      <p className="text-[10px] text-slate-500">
                        {fmtMoney(q.totalAmount)} (incl. delivery {fmtMoney(q.deliveryCharge)})
                        {q.deliveryTime ? ` · delivery ${q.deliveryTime}` : ""}{q.paymentTerms ? ` · ${q.paymentTerms}` : ""}
                      </p>
                    </div>
                    {can("procurement", "approve") && q.status !== "SELECTED" && ["DRAFT", "QUOTATION_COLLECTION"].includes(data.status) && (
                      <Button size="sm" variant="outline" className="h-7 text-[11px] bg-white dark:bg-slate-900" onClick={async () => {
                        try {
                          await rpc("purchase.quotations.select", { id: q.id })
                          toast(`Quotation from ${q.supplierName} selected`)
                          const d = await rpc("purchase.get", { id })
                          setData(d)
                        } catch (e: any) { toast(e.message, "err") }
                      }}>Select</Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </SectionCard>
        )}

        <DialogFooter className="gap-2 flex-wrap">
          <Button variant="outline" onClick={onClose}>Close</Button>
          {data.status === "PENDING_APPROVAL" && can("procurement", "approve") && (
            <>
              <Button variant="outline" className="text-rose-600 border-rose-200 hover:bg-rose-50 dark:border-rose-900" disabled={busy} onClick={() => act("REJECT")}>Reject</Button>
              <Button disabled={busy} onClick={() => act("APPROVE")}>Approve purchase</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function QuotationDialog({ pr, onClose }: { pr: any; onClose: (saved: boolean) => void }) {
  const toast = useHrm((s) => s.toast)
  const { data: suppliers } = useApi<any[]>("inventory.suppliers.list", {})
  const [v, setV] = useState({ supplierId: "", supplierName: "", quotationNo: "", quotationDate: "", deliveryTime: "", paymentTerms: "", deliveryCharge: "" })
  const [lines, setLines] = useState<any[]>((pr.items || []).map((i: any) => ({ itemId: i.itemId, itemName: i.itemName, quantity: i.purchaseQty, unit: i.unit, unitPrice: "", discount: "", vatTax: "" })))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const set = (n: string, val: any) => setV((s) => ({ ...s, [n]: val }))
  const setLine = (i: number, key: string, val: any) => setLines((a) => a.map((x, j) => (j === i ? { ...x, [key]: val } : x)))
  const total = lines.reduce((s, l) => s + Math.max(0, Number(l.quantity) * Number(l.unitPrice || 0) - Number(l.discount || 0) + Number(l.vatTax || 0)), 0)

  const save = async () => {
    setErr(null)
    const sup = (suppliers || []).find((s: any) => s.id === v.supplierId)
    if (!v.supplierId && !v.supplierName) { setErr("Pick a supplier or type a name"); return }
    if (!lines.length || lines.some((l) => !(Number(l.quantity) > 0))) { setErr("Quotation lines need quantities"); return }
    setBusy(true)
    try {
      await rpc("purchase.quotations.add", {
        purchaseRequestId: pr.id, supplierId: v.supplierId || null, supplierName: sup?.name || v.supplierName,
        quotationNo: v.quotationNo || null, quotationDate: v.quotationDate || null,
        deliveryTime: v.deliveryTime || null, paymentTerms: v.paymentTerms || null,
        deliveryCharge: Number(v.deliveryCharge || 0),
        items: lines.map((l) => ({ itemId: l.itemId, itemName: l.itemName, quantity: Number(l.quantity), unit: l.unit, unitPrice: Number(l.unitPrice || 0), discount: Number(l.discount || 0), vatTax: Number(l.vatTax || 0) })),
      })
      toast(`Quotation from ${sup?.name || v.supplierName} added to ${pr.reqNo}`)
      onClose(true)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <Dialog open onOpenChange={() => !busy && onClose(false)}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">Add quotation — {pr.reqNo}</DialogTitle>
          <DialogDescription className="text-xs">Multiple vendor quotations can be collected and compared before purchase approval.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Supplier</Label>
            <Select value={v.supplierId || "new"} onValueChange={(val) => set("supplierId", val === "new" ? "" : val)}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="new">Type a new name →</SelectItem>
                {(suppliers || []).map((s: any) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {!v.supplierId && (
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Supplier name</Label>
              <Input value={v.supplierName} onChange={(e) => set("supplierName", e.target.value)} className="h-9" />
            </div>
          )}
          <div className="space-y-1.5"><Label className="text-xs font-medium">Quotation no.</Label><Input value={v.quotationNo} onChange={(e) => set("quotationNo", e.target.value)} className="h-9" /></div>
          <div className="space-y-1.5"><Label className="text-xs font-medium">Quotation date</Label><Input type="date" value={v.quotationDate} onChange={(e) => set("quotationDate", e.target.value)} className="h-9" /></div>
          <div className="space-y-1.5"><Label className="text-xs font-medium">Delivery time</Label><Input value={v.deliveryTime} onChange={(e) => set("deliveryTime", e.target.value)} className="h-9" placeholder="e.g. 7 days" /></div>
          <div className="space-y-1.5"><Label className="text-xs font-medium">Payment terms</Label><Input value={v.paymentTerms} onChange={(e) => set("paymentTerms", e.target.value)} className="h-9" placeholder="e.g. 50% advance" /></div>
        </div>
        <div className="rounded-xl border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-slate-50 dark:bg-slate-800">
                <TableHead className="text-[10px] uppercase">Item</TableHead>
                <TableHead className="text-[10px] uppercase text-right w-20">Qty</TableHead>
                <TableHead className="text-[10px] uppercase text-right w-28">Unit price ৳</TableHead>
                <TableHead className="text-[10px] uppercase text-right w-24">Discount ৳</TableHead>
                <TableHead className="text-[10px] uppercase text-right w-24">VAT/Tax ৳</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((l, i) => (
                <TableRow key={i}>
                  <TableCell className="p-1.5 text-xs font-medium">{l.itemName}</TableCell>
                  <TableCell className="p-1.5"><Input type="number" value={l.quantity} onChange={(e) => setLine(i, "quantity", e.target.value)} className="h-8 text-xs tabular-nums" /></TableCell>
                  <TableCell className="p-1.5"><Input type="number" value={l.unitPrice} onChange={(e) => setLine(i, "unitPrice", e.target.value)} className="h-8 text-xs tabular-nums" placeholder="0" /></TableCell>
                  <TableCell className="p-1.5"><Input type="number" value={l.discount} onChange={(e) => setLine(i, "discount", e.target.value)} className="h-8 text-xs tabular-nums" placeholder="0" /></TableCell>
                  <TableCell className="p-1.5"><Input type="number" value={l.vatTax} onChange={(e) => setLine(i, "vatTax", e.target.value)} className="h-8 text-xs tabular-nums" placeholder="0" /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5"><Label className="text-xs font-medium">Delivery charge ৳</Label><Input type="number" value={v.deliveryCharge} onChange={(e) => set("deliveryCharge", e.target.value)} className="h-9 w-32 tabular-nums" placeholder="0" /></div>
          <div className="text-sm font-bold tabular-nums ml-auto">Subtotal: {fmtMoney(total)} · Total: {fmtMoney(total + Number(v.deliveryCharge || 0))}</div>
        </div>
        {err && <p className="text-sm text-rose-600 bg-rose-50 dark:bg-rose-950 rounded-md px-3 py-2">{err}</p>}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onClose(false)} disabled={busy}>Cancel</Button>
          <Button onClick={save} disabled={busy}>{busy ? "Saving…" : "Add quotation"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ReceiveStockDialog({ pr, onClose }: { pr: any; onClose: (saved: boolean) => void }) {
  const toast = useHrm((s) => s.toast)
  const { data: warehouses } = useApi<any[]>("inventory.warehouses.list", {})
  const [v, setV] = useState({ warehouseId: "", invoiceNo: "", invoiceDate: "", receivedDate: new Date().toISOString().slice(0, 10) })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const set = (n: string, val: any) => setV((s) => ({ ...s, [n]: val }))

  const save = async () => {
    setErr(null)
    if (!v.warehouseId) { setErr("Select the receiving warehouse"); return }
    setBusy(true)
    try {
      const res = await rpc("purchase.receiveStock", { id: pr.id, ...v })
      toast(`Stock entry ${res.entryNo} posted — stock increased and linked requisitions re-checked`)
      onClose(true)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <Dialog open onOpenChange={() => !busy && onClose(false)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">Receive stock — {pr.reqNo}</DialogTitle>
          <DialogDescription className="text-xs">
            Creates and posts the stock entry in one step: quantities increase, transactions are recorded and the linked goods
            requisition is re-checked for availability. Stock only rises on this post (spec §7/§8).
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="text-xs font-medium">Warehouse / store</Label>
            <Select value={v.warehouseId || "none"} onValueChange={(val) => set("warehouseId", val === "none" ? "" : val)}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none" disabled>Select warehouse…</SelectItem>
                {(warehouses || []).map((w: any) => <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5"><Label className="text-xs font-medium">Invoice / challan no.</Label><Input value={v.invoiceNo} onChange={(e) => set("invoiceNo", e.target.value)} className="h-9" /></div>
          <div className="space-y-1.5"><Label className="text-xs font-medium">Invoice date</Label><Input type="date" value={v.invoiceDate} onChange={(e) => set("invoiceDate", e.target.value)} className="h-9" /></div>
          <div className="space-y-1.5"><Label className="text-xs font-medium">Received date</Label><Input type="date" value={v.receivedDate} onChange={(e) => set("receivedDate", e.target.value)} className="h-9" /></div>
        </div>
        {err && <p className="text-sm text-rose-600 bg-rose-50 dark:bg-rose-950 rounded-md px-3 py-2">{err}</p>}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onClose(false)} disabled={busy}>Cancel</Button>
          <Button onClick={save} disabled={busy} className="bg-teal-600 hover:bg-teal-700 text-white">{busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <ClipboardCheck className="h-4 w-4 mr-1.5" />} Receive & post</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ================= SUPPLIERS =================
function SuppliersTab() {
  const { can } = useHrm()
  const { data, loading, error, reload } = useApi<any[]>("inventory.suppliers.list", {})
  const [open, setOpen] = useState(false)
  const [edit, setEdit] = useState<any>(null)

  const columns: Column<any>[] = [
    { key: "name", label: "Supplier", sortValue: (s) => s.name, render: (s) => (
      <div><p className="text-sm font-semibold">{s.name}</p>{s.contactPerson && <p className="text-[11px] text-slate-500">{s.contactPerson}</p>}</div>
    ) },
    { key: "mobile", label: "Mobile", render: (s) => <span className="text-xs">{s.mobile || "—"}</span> },
    { key: "email", label: "Email", render: (s) => <span className="text-xs">{s.email || "—"}</span> },
    { key: "tin", label: "TIN", render: (s) => <span className="text-xs">{s.tin || "—"}</span> },
    { key: "status", label: "Status", render: (s) => <StatusBadge status={s.active ? "ACTIVE" : "INACTIVE"} /> },
    ...(can("inventory", "edit") ? [{ key: "actions", label: "", align: "right" as const, render: (s: any) => (
      <Button size="sm" variant="outline" className="h-7 text-[11px] bg-white dark:bg-slate-900" onClick={() => { setEdit(s); setOpen(true) }}>Edit</Button>
    ) }] : []),
  ]

  return (
    <div className="space-y-3">
      {can("inventory", "edit") && (
        <div className="flex justify-end">
          <Button size="sm" className="h-8 text-xs " onClick={() => { setEdit(null); setOpen(true) }}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Add supplier
          </Button>
        </div>
      )}
      <DataTable columns={columns} rows={data ?? undefined} loading={loading} error={error} pageSize={12} csvName="suppliers"
        searchPlaceholder="Search supplier…" emptyTitle="No suppliers" emptyHint="Add the vendors you source office goods from." />
      {open && <SupplierDialog edit={edit} onClose={(v) => { setOpen(false); if (v) reload() }} />}
    </div>
  )
}

function SupplierDialog({ edit, onClose }: { edit: any; onClose: (saved: boolean) => void }) {
  const toast = useHrm((s) => s.toast)
  const [v, setV] = useState({ name: edit?.name || "", contactPerson: edit?.contactPerson || "", mobile: edit?.mobile || "", email: edit?.email || "", address: edit?.address || "", tin: edit?.tin || "" })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const set = (n: string, val: any) => setV((s) => ({ ...s, [n]: val }))

  const save = async () => {
    if (!v.name) { setErr("Name is required"); return }
    setBusy(true); setErr(null)
    try {
      await rpc("inventory.suppliers.save", { ...(edit?.id ? { id: edit.id } : {}), ...v })
      toast(edit ? "Supplier updated" : "Supplier added")
      onClose(true)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <Dialog open onOpenChange={() => !busy && onClose(false)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle className="text-base">{edit ? `Edit — ${edit.name}` : "Add supplier"}</DialogTitle></DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1.5 sm:col-span-2"><Label className="text-xs font-medium">Name *</Label><Input value={v.name} onChange={(e) => set("name", e.target.value)} className="h-9" /></div>
          <div className="space-y-1.5"><Label className="text-xs font-medium">Contact person</Label><Input value={v.contactPerson} onChange={(e) => set("contactPerson", e.target.value)} className="h-9" /></div>
          <div className="space-y-1.5"><Label className="text-xs font-medium">Mobile</Label><Input value={v.mobile} onChange={(e) => set("mobile", e.target.value)} className="h-9" /></div>
          <div className="space-y-1.5"><Label className="text-xs font-medium">Email</Label><Input value={v.email} onChange={(e) => set("email", e.target.value)} className="h-9" /></div>
          <div className="space-y-1.5"><Label className="text-xs font-medium">TIN</Label><Input value={v.tin} onChange={(e) => set("tin", e.target.value)} className="h-9" /></div>
          <div className="space-y-1.5 sm:col-span-2"><Label className="text-xs font-medium">Address</Label><Input value={v.address} onChange={(e) => set("address", e.target.value)} className="h-9" /></div>
        </div>
        {err && <p className="text-sm text-rose-600 bg-rose-50 dark:bg-rose-950 rounded-md px-3 py-2">{err}</p>}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onClose(false)} disabled={busy}>Cancel</Button>
          <Button onClick={save} disabled={busy}>{busy ? "Saving…" : "Save supplier"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// C-07 — exported pure builder so unit tests can drive XSS payloads through
// the exact markup openPrintWindow receives. Every interpolation is escaped.
export function buildStockIssueReportHtml(issues: any[]): string {
  const rows = (issues || []).map((r: any) => `<tr><td style="padding:4px 8px;border-bottom:1px solid #e2e8f0">${esc(new Date(r.date).toLocaleDateString())}</td><td style="padding:4px 8px;border-bottom:1px solid #e2e8f0">${esc(r.requisitionNo)}</td><td style="padding:4px 8px;border-bottom:1px solid #e2e8f0">${esc(r.employeeName)}</td><td style="padding:4px 8px;border-bottom:1px solid #e2e8f0">${esc(r.itemName)}</td><td style="padding:4px 8px;border-bottom:1px solid #e2e8f0;text-align:right">${esc(r.quantity)} ${esc(r.unit)}</td><td style="padding:4px 8px;border-bottom:1px solid #e2e8f0">${esc(r.issuedBy)}</td></tr>`).join("")
  return `<html><head><title>Stock Issue Report</title><style>body{font-family:ui-sans-serif,system-ui,sans-serif;padding:24px}h1{font-size:16px}table{width:100%;border-collapse:collapse;font-size:12px}th{text-align:left;padding:6px 8px;border-bottom:2px solid #334155;background:#f8fafc}</style></head><body><h1>Stock Issue Report — goods issued against employees</h1><table><tr><th>Date</th><th>Requisition</th><th>Issued to</th><th>Item</th><th align="right">Qty</th><th>Issued by</th></tr>${rows}</table></body></html>`
}

// ================= REPORTS (§25) =================
function ReportsTab() {
  const { data, loading, error, reload } = useApi<any>("procurement.reports", {})

  const reqColumns: Column<any>[] = [
    { key: "reqNo", label: "Requisition", sortValue: (r) => r.reqNo, render: (r) => <span className="text-xs font-semibold">{r.reqNo}</span> },
    { key: "employeeName", label: "Employee", sortValue: (r) => r.employeeName, render: (r) => <span className="text-xs">{r.employeeName}</span> },
    { key: "requestDate", label: "Date", sortValue: (r) => r.requestDate, render: (r) => <span className="text-xs">{fmtDate(r.requestDate)}</span> },
    { key: "priority", label: "Priority", render: (r) => <span className="text-xs">{r.priority}</span> },
    { key: "itemCount", label: "Items", align: "right", render: (r) => <span className="text-xs">{r.itemCount}</span> },
    { key: "status", label: "Status", render: (r) => <StatusChip status={r.status} /> },
  ]
  const prColumns: Column<any>[] = [
    { key: "prReqNo", label: "PR", sortValue: (r) => r.prReqNo, render: (r) => <span className="text-xs font-semibold">{r.prReqNo}</span> },
    { key: "itemName", label: "Item", render: (r) => <span className="text-xs">{r.itemName}</span> },
    { key: "requestedQty", label: "Requested", align: "right", render: (r) => <span className="text-xs tabular-nums">{r.requestedQty}</span> },
    { key: "availableQty", label: "Available", align: "right", render: (r) => <span className="text-xs tabular-nums">{r.availableQty}</span> },
    { key: "purchaseQty", label: "To purchase", align: "right", render: (r) => <span className="text-xs font-bold tabular-nums text-amber-600">{r.purchaseQty} {r.unit}</span> },
    { key: "prStatus", label: "PR status", render: (r) => <StatusChip status={r.prStatus} /> },
  ]
  const issueColumns: Column<any>[] = [
    { key: "date", label: "Date", sortValue: (r) => r.date, render: (r) => <span className="text-xs">{fmtDateTime(r.date)}</span> },
    { key: "requisitionNo", label: "Requisition", render: (r) => <span className="text-xs font-semibold">{r.requisitionNo}</span> },
    { key: "employeeName", label: "Issued to", render: (r) => <span className="text-xs">{r.employeeName}</span> },
    { key: "itemName", label: "Item", render: (r) => <span className="text-xs">{r.itemName}</span> },
    { key: "quantity", label: "Qty", align: "right", render: (r) => <span className="text-xs tabular-nums">{r.quantity} {r.unit}</span> },
    { key: "issuedBy", label: "Issued by", render: (r) => <span className="text-xs text-slate-500">{r.issuedBy}</span> },
  ]

  const printIssues = () => {
    openPrintWindow(buildStockIssueReportHtml(data?.stockIssues))
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Pending approval" value={data?.pending?.approval ?? "—"} icon={Send} tone="sky" />
        <StatCard label="Awaiting stock / purchase" value={data?.pending?.stock ?? "—"} icon={ShoppingCart} tone="amber" />
        <StatCard label="Awaiting receipt confirmation" value={data?.pending?.receipt ?? "—"} icon={ClipboardCheck} tone="violet" />
        <StatCard label="Receipt disputes" value={data?.pending?.disputed ?? "—"} icon={AlertTriangle} tone="rose" />
      </div>
      <SectionCard title="Goods requisition report" actions={
        <Button size="sm" variant="outline" className="h-8 text-xs bg-white dark:bg-slate-900" onClick={reload}>
          <RefreshCcw className="h-3.5 w-3.5 mr-1" /> Refresh
        </Button>
      }>
        <DataTable columns={reqColumns} rows={data?.requisitions} loading={loading} error={error} pageSize={10} csvName="requisition-report" emptyTitle="No requisitions" />
      </SectionCard>
      <SectionCard title="Purchase requirement report — items currently requiring procurement">
        <DataTable columns={prColumns} rows={data?.purchaseRequirements} pageSize={10} csvName="purchase-requirements" emptyTitle="Nothing to purchase" emptyHint="Shortages from approved requisitions appear here." />
      </SectionCard>
      <SectionCard title="Stock issue report — issued goods against employees" actions={
        <Button size="sm" variant="outline" className="h-8 text-xs bg-white dark:bg-slate-900" onClick={printIssues}>
          <Printer className="h-3.5 w-3.5 mr-1" /> Print
        </Button>
      }>
        <DataTable columns={issueColumns} rows={data?.stockIssues} pageSize={10} csvName="stock-issues" emptyTitle="Nothing issued yet" />
      </SectionCard>
    </div>
  )
}
