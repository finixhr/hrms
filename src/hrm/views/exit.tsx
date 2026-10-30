"use client"
// ============ Exit Management: resignations, notice period, clearance & final settlement ============
// Settlement posts an accounting journal and marks the employee RESIGNED on payment.
// WP-L (Wave 2): the exit case surfaces the exiting employee's OUTSTANDING company
// assets — clearance cannot be completed while any handover is unreturned; each
// can be marked returned or cleared with a recovery deduction (FinalSettlement line).
import { useEffect, useState, useMemo } from "react"
import {
  DoorOpen, CheckCheck, Banknote, Calculator, Info, LogOut, ShieldCheck, AlertTriangle, UserRound, ListChecks,
  Boxes, Undo2, Landmark, RefreshCw, Printer, Files,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Switch } from "@/components/ui/switch"
import { useHrm } from "../store"
import { rpc } from "../api"
import { useServerPagedList, PagedControls } from "../server-paged"
import { PageHeader, StatCard, StatusBadge, fmtMoney, fmtDate, titleCase, minutesHHMM, SectionTabs, SectionCard, KV, EmptyState, openPrintWindow } from "../shared/ui-kit"
import { DataTable, type Column } from "../shared/data-table"
import { ConfirmDialog, FormDialog } from "../shared/form-dialog"

const TERMINAL_STATUSES = ["ACCEPTED", "COMPLETED", "WITHDRAWN", "REJECTED"]
const NOTICE_MODES: Record<string, string> = {
  FULL: "Employee served the full required notice period — no buyout deduction applies.",
  SHORT: "Employee served at least half the required notice — partial shortfall recorded.",
  BUYOUT: "Employee served less than half the required notice — buyout deduction applies in the final settlement.",
  WAIVED: "No notice served — the full notice amount is deducted (or waived by management).",
  EARLY_RELEASE: "Released early by management decision — notice requirement waived.",
}

function safeParseArray(s?: string | null): any[] {
  try {
    const v = JSON.parse(s || "[]")
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}
function safeParse(s?: string | null): any {
  try { return JSON.parse(s || "{}") } catch { return {} }
}

export default function ExitView() {
  // global-search deep link: pre-select a tab (params arrive with the view)
  const presetTab = useHrm((s) => (s.view?.key === "exit" && s.view?.params?.tab) || undefined)
  // P6 WS-B — server-paged list (MOD-16 contract): the whole exit history no
  // longer ships to the browser; the KPI strip reads the paged `summary`.
  const [q, setQ] = useState("")
  const { rows, total, page, pageSize, maxPage, loading, error, reload, setPage, envelope } =
    useServerPagedList<any>("resignations.list", { q: q || undefined }, 50)
  const list = rows
  const stats: any = envelope?.summary

  const inNotice = stats ? Number(stats.inNotice) : list.filter((r) => r.status === "NOTICE_PERIOD").length
  const completed = stats ? Number(stats.completed) : list.filter((r) => r.status === "COMPLETED").length
  const pendingSettlements = stats
    ? Number(stats.pendingSettlements)
    : list.filter((r) => r.settlement && ["DRAFT", "CALCULATED", "APPROVED"].includes(r.settlement.status)).length

  return (
    <div className="space-y-4">
      <PageHeader title="Exit Management" subtitle="Resignations, notice period tracking, departmental clearance and final settlement with accounting posting" />
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <StatCard label="In Notice Period" value={inNotice} icon={DoorOpen} tone="violet" sub="active exits in progress" />
        <StatCard label="Completed Exits" value={completed} icon={CheckCheck} tone="emerald" sub="settlement paid & closed" />
        <StatCard label="Pending Settlements" value={pendingSettlements} icon={Banknote} tone="amber" sub="calculated or awaiting approval" />
      </div>
      <SectionTabs defaultValue={presetTab as string | undefined} tabs={[
        { value: "resignations", label: "Resignations", content: (
          <ResignationsTab data={rows} loading={loading} error={error} reload={reload}
            onSearch={setQ}
            page={page} pageSize={pageSize} maxPage={maxPage} total={total} onPage={setPage} paged={!!envelope} />
        ) },
        { value: "guide", label: "Process & Formula", content: <GuideTab /> },
      ]} />
    </div>
  )
}

// ================= EXIT CASES (RESIGNATIONS, TERMINATIONS, RETIREMENTS) =================
function ResignationsTab({ data, loading, error, reload, onSearch, page, pageSize, maxPage, total, onPage, paged }: {
  data: any[] | undefined; loading?: boolean; error?: string | null; reload: () => void
  onSearch?: (q: string) => void
  page?: number; pageSize?: number; maxPage?: number; total?: number; onPage?: (p: number) => void; paged?: boolean
}) {
  const [detailId, setDetailId] = useState<string | null>(null)
  const [filterType, setFilterType] = useState<string>("")
  const detailRow = (data || []).find((r: any) => r.id === detailId) || null

  const filteredRows = useMemo(() => {
    if (!filterType) return data
    return (data || []).filter((r: any) => (r.exitType || "RESIGNATION") === filterType)
  }, [data, filterType])

  const countFor = (t: string) => (data || []).filter((r: any) => (r.exitType || "RESIGNATION") === t).length

  const columns: Column<any>[] = [
    {
      key: "employeeName", label: "Employee", sortValue: (r) => r.employeeName,
      render: (r) => (
        <div>
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{r.employeeName}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">{r.employeeCode || "—"}</p>
        </div>
      ),
    },
    {
      key: "exitType", label: "Exit Type", sortValue: (r) => r.exitType || "RESIGNATION",
      render: (r) => {
        const type = r.exitType || "RESIGNATION"
        const cls = type === "TERMINATION"
          ? "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300 border-rose-200 dark:border-rose-900"
          : type === "RETIREMENT"
          ? "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300 border-purple-200 dark:border-purple-900"
          : "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300 border-violet-200 dark:border-violet-900"
        return (
          <Badge variant="outline" className={`text-[10px] font-semibold ${cls}`}>
            {titleCase(type)}
          </Badge>
        )
      },
    },
    { key: "submissionDate", label: "Initiated", sortValue: (r) => r.submissionDate || "", render: (r) => <span className="text-xs text-slate-500">{fmtDate(r.submissionDate)}</span> },
    { key: "resignationDate", label: "Effective Date", sortValue: (r) => r.resignationDate || "", render: (r) => <span className="text-xs text-slate-600 dark:text-slate-300">{fmtDate(r.resignationDate)}</span> },
    { key: "proposedLwd", label: "LWD", sortValue: (r) => r.actualLwd || r.proposedLwd || "", render: (r) => <span className="text-xs text-slate-600 dark:text-slate-300">{fmtDate(r.actualLwd || r.proposedLwd)}</span> },
    {
      key: "reason", label: "Reason",
      render: (r) => <span className="text-xs text-slate-500" title={r.reason || ""}>{(r.reason || "").length > 42 ? `${r.reason.slice(0, 42)}…` : r.reason || "—"}</span>,
    },
    { key: "noticeMode", label: "Notice Mode", render: (r) => <Badge variant="outline" className="text-[10px]">{titleCase(r.noticeMode)}</Badge> },
    { key: "servedDays", label: "Served", align: "right", sortValue: (r) => r.servedDays || 0, render: (r) => <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300">{r.servedDays || 0}/{r.noticeDays || 30}d</span> },
    { key: "status", label: "Status", render: (r) => <StatusBadge status={r.status} /> },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setFilterType("")}
          className={`h-7 px-3 rounded-full text-xs font-medium transition-colors ${!filterType ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900" : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700"}`}
        >
          All Exits ({data?.length || 0})
        </button>
        <button
          type="button"
          onClick={() => setFilterType("RESIGNATION")}
          className={`h-7 px-3 rounded-full text-xs font-medium transition-colors ${filterType === "RESIGNATION" ? "bg-violet-600 text-white" : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700"}`}
        >
          Resignations ({countFor("RESIGNATION")})
        </button>
        <button
          type="button"
          onClick={() => setFilterType("TERMINATION")}
          className={`h-7 px-3 rounded-full text-xs font-medium transition-colors ${filterType === "TERMINATION" ? "bg-rose-600 text-white" : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700"}`}
        >
          Terminations ({countFor("TERMINATION")})
        </button>
        <button
          type="button"
          onClick={() => setFilterType("RETIREMENT")}
          className={`h-7 px-3 rounded-full text-xs font-medium transition-colors ${filterType === "RETIREMENT" ? "bg-purple-600 text-white" : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700"}`}
        >
          Retirements ({countFor("RETIREMENT")})
        </button>
      </div>

      <DataTable columns={columns} rows={filteredRows} loading={loading} error={error} csvName="exit-cases"
        searchPlaceholder="Search employee, reason…" onSearch={onSearch} onRowClick={(r) => setDetailId(r.id)}
        emptyTitle="No exit cases found" emptyHint="Initiate employee termination or retirement from Employee Directory, or resignation via ESS." />
      {paged && page != null && pageSize != null && maxPage != null && total != null && onPage && (
        <PagedControls page={page} maxPage={maxPage} total={total} pageSize={pageSize} onPage={onPage} loading={loading} />
      )}

      <ExitCaseDialog open={!!detailRow} onOpenChange={(v) => { if (!v) setDetailId(null) }} resignation={detailRow} onReload={reload} />
    </div>
  )
}

// ================= EXIT CASE DIALOG =================
function ExitCaseDialog({ open, onOpenChange, resignation, onReload }: {
  open: boolean; onOpenChange: (v: boolean) => void; resignation: any; onReload: () => void
}) {
  const { can, user } = useHrm()
  const toast = useHrm((s) => s.toast)
  const [clearance, setClearance] = useState<any>(null)
  const [checklist, setChecklist] = useState<any[]>([])
  const [settlement, setSettlement] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [withdrawOpen, setWithdrawOpen] = useState(false)
  const [payOpen, setPayOpen] = useState(false)
  // WP-L — outstanding company assets (returnedAt = null) + their actions
  const [returnAsset, setReturnAsset] = useState<any>(null)
  const [clearAsset, setClearAsset] = useState<any>(null)

  useEffect(() => {
    if (open && resignation) {
      const raw = resignation.clearance
      setClearance(raw || null)
      setChecklist(raw?.checklist || safeParseArray(raw?.checklistJson))
      const st = resignation.settlement
      setSettlement(st ? { ...st, computation: safeParse(st.computationJson) } : null)
      setWithdrawOpen(false)
      setPayOpen(false)
      setReturnAsset(null)
      setClearAsset(null)
      setError(null)
    }
  }, [open, resignation])

  if (!resignation) return null

  const allItems = checklist.flatMap((d: any) => d.items || [])
  const clearedCount = allItems.filter((i: any) => i.cleared).length
  const remainingDays = Math.max(0, (resignation.noticeDays || 30) - (resignation.servedDays || 0))
  const own = !!user?.employeeId && user.employeeId === resignation.employeeId
  const canWithdraw = (own || can("exit", "approve")) && !TERMINAL_STATUSES.includes(resignation.status)
  const outstandingAssets: any[] = resignation.outstandingAssets || []

  const toggleItem = (deptIdx: number, itemIdx: number) => {
    setChecklist((cl) => cl.map((d: any, di: number) =>
      di === deptIdx ? { ...d, items: d.items.map((it: any, ii: number) => (ii === itemIdx ? { ...it, cleared: !it.cleared } : it)) } : d
    ))
  }

  const saveClearance = async () => {
    if (!clearance?.id) return
    setBusy(true)
    setError(null)
    try {
      const res = await rpc("clearance.save", { id: clearance.id, checklist })
      setClearance({ ...clearance, status: res.status })
      toast(res.status === "CLEARED" ? "Clearance complete — all items cleared" : "Clearance saved (in progress)")
      onReload()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const calculateSettlement = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await rpc("settlements.calculate", { resignationId: resignation.id })
      setSettlement({ id: res.id, status: "CALCULATED", netPayable: res.computation.netPayable, computation: res.computation })
      toast("Settlement calculated")
      onReload()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const approveSettlement = async () => {
    setBusy(true)
    setError(null)
    try {
      await rpc("settlements.approve", { id: settlement.id })
      setSettlement({ ...settlement, status: "APPROVED" })
      toast("Settlement approved")
      onReload()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-base flex flex-wrap items-center gap-2">
              Exit Case ({titleCase(resignation.exitType || "Resignation")}) — {resignation.employeeName}
              <StatusBadge status={resignation.status} />
              <Badge variant="outline" className="text-[10px]">{titleCase(resignation.noticeMode)} notice</Badge>
            </DialogTitle>
            <p className="text-xs text-slate-500">Click any exit case row to reopen this case file.</p>
          </DialogHeader>

          <div className="grid lg:grid-cols-2 gap-4 py-1">
            {/* ---------- left column ---------- */}
            <div className="space-y-4">
              <SectionCard title={`${titleCase(resignation.exitType || "Resignation")} Summary`} actions={
                <div className="flex items-center gap-1.5">
                  {/* EXT-04 (R7) — experience certificate + relieving letter + NOC packet */}
                  {["ACCEPTED", "NOTICE_PERIOD", "COMPLETED"].includes(resignation.status) && can("letters", "generate") && (
                    <Button size="sm" variant="outline" disabled={busy}
                      className="h-7 text-xs border-emerald-200 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-400 dark:hover:bg-emerald-950/50"
                      onClick={async () => {
                        setBusy(true)
                        try {
                          const res = await rpc<{ packetHtml: string; letters: any[] }>("exitPacket.generate", { resignationId: resignation.id })
                          const w = openPrintWindow(res.packetHtml, { print: false })
                          if (!w) toast("Popup blocked — allow popups to view the packet", "err")
                          else toast(`Exit packet ready — ${res.letters.length} letters (experience certificate, relieving letter, NOC)`, "ok")
                          onReload()
                        } catch (e: any) { toast(e.message || "Could not generate the packet", "err") }
                        finally { setBusy(false) }
                      }}>
                      <Files className="h-3 w-3 mr-1" /> Exit Packet
                    </Button>
                  )}
                  {canWithdraw && (
                    <Button size="sm" variant="outline" className="h-7 text-xs text-rose-600 hover:text-rose-700 hover:border-rose-300" onClick={() => setWithdrawOpen(true)}>
                      <LogOut className="h-3 w-3 mr-1" /> Withdraw
                    </Button>
                  )}
                </div>
              }>
                <KV items={[
                  ["Employee", `${resignation.employeeName}${resignation.employeeCode ? ` (${resignation.employeeCode})` : ""}`],
                  ["Exit Type", <Badge key="extype" variant="outline" className="text-[10px] font-semibold">{titleCase(resignation.exitType || "Resignation")}</Badge>],
                  ["Employee Status", <StatusBadge key="empst" status={resignation.employeeStatus} />],
                  ["Case Status", <StatusBadge key="st" status={resignation.status} />],
                  ["Initiated Date", fmtDate(resignation.submissionDate)],
                  ["Effective Date", fmtDate(resignation.resignationDate)],
                  ["Proposed LWD", fmtDate(resignation.proposedLwd)],
                  ["Actual LWD", fmtDate(resignation.actualLwd)],
                  ["Reason", resignation.reason || "—"],
                  ["Remarks", resignation.remarks || "—"],
                ]} />
              </SectionCard>

              <SectionCard title="Notice Period">
                <KV items={[
                  ["Required Notice", `${resignation.noticeDays || 30} days`],
                  ["Served", `${resignation.servedDays || 0} days`],
                  ["Remaining", `${remainingDays} days`],
                  ["Actual LWD", fmtDate(resignation.actualLwd || resignation.proposedLwd)],
                ]} />
                <div className="mt-3">
                  <div className="flex items-center justify-between text-[10px] text-slate-500 dark:text-slate-400 mb-1">
                    <span>Notice served</span>
                    <span className="tabular-nums">{resignation.servedDays || 0}/{resignation.noticeDays || 30} days</span>
                  </div>
                  <div className="h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                    <div className="h-full rounded-full bg-violet-500"
                      style={{ width: `${Math.min(100, Math.round(((resignation.servedDays || 0) / (resignation.noticeDays || 30)) * 100))}%` }} />
                  </div>
                </div>
                <div className="mt-3 rounded-lg bg-slate-50 dark:bg-slate-800/60 p-3 flex gap-2">
                  <Info className="h-4 w-4 text-violet-600 shrink-0 mt-0.5" />
                  <p className="text-xs text-slate-600 dark:text-slate-300">
                    <b>{titleCase(resignation.noticeMode)} mode:</b> {NOTICE_MODES[resignation.noticeMode] || "—"}
                  </p>
                </div>
              </SectionCard>
            </div>

            {/* ---------- right column ---------- */}
            <div className="space-y-4">
              {/* WP-L — Company Assets pending return (hard clearance block) */}
              <CompanyAssetsCard
                resignation={resignation}
                canProcess={can("exit", "process")}
                canDeduct={can("exit", "pay")}
                onMarkReturned={(a) => setReturnAsset(a)}
                onClearWithDeduction={(a) => setClearAsset(a)}
              />

              <SectionCard title="Exit Clearance" actions={
                <span className="text-[11px] text-slate-500 dark:text-slate-400 tabular-nums flex items-center gap-1">
                  <ListChecks className="h-3 w-3" /> {clearedCount}/{allItems.length} cleared
                </span>
              }>
                {outstandingAssets.length > 0 && (
                  <div className="mb-3 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 p-2.5 flex gap-2">
                    <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-800 dark:text-amber-300">
                      <b>Clearance cannot be completed</b> while {outstandingAssets.length} company asset{outstandingAssets.length !== 1 ? "s" : ""}
                      {" "}({outstandingAssets.map((a: any) => a.assetCode).join(", ")}) {outstandingAssets.length !== 1 ? "are" : "is"} unreturned —
                      the save is rejected until every handover is closed above.
                    </p>
                  </div>
                )}
                {!clearance ? (
                  <EmptyState icon={ShieldCheck} title="Clearance not started"
                    hint="The departmental clearance checklist is created automatically once the resignation is accepted (notice period)." />
                ) : (
                  <>
                    <div className="mb-3">
                      <div className="h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                        <div className="h-full rounded-full bg-emerald-500 transition-all"
                          style={{ width: `${allItems.length ? Math.round((clearedCount / allItems.length) * 100) : 0}%` }} />
                      </div>
                      <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">Clearance status: {titleCase(clearance.status)}</p>
                    </div>
                    <div className="space-y-3 max-h-64 overflow-y-auto pr-1">
                      {checklist.map((d: any, di: number) => (
                        <div key={di}>
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1.5">{d.department}</p>
                          <div className="space-y-1.5">
                            {(d.items || []).map((it: any, ii: number) => (
                              <div key={ii} className="flex items-center justify-between gap-2 rounded-md border border-slate-100 dark:border-slate-800 px-2.5 py-1.5">
                                <span className="text-xs text-slate-700 dark:text-slate-200">{it.item}</span>
                                {can("exit", "process") ? (
                                  <Switch checked={!!it.cleared} onCheckedChange={() => toggleItem(di, ii)} className="data-[state=checked]:bg-primary" />
                                ) : it.cleared ? (
                                  <Badge className="bg-emerald-100 text-emerald-700 text-[9px]">Cleared</Badge>
                                ) : (
                                  <Badge variant="outline" className="text-[9px]">Pending</Badge>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                    {can("exit", "process") && (
                      <Button size="sm" onClick={saveClearance} disabled={busy} className="mt-3 w-full h-8 ">
                        {busy ? "Saving…" : "Save Clearance"}
                      </Button>
                    )}
                  </>
                )}
              </SectionCard>

              <SectionCard title="Final Settlement">
                {/* EXIT-009 — clearance status banner: settlement money cannot move
                    before the exit clearance checklist is CLEARED */}
                {resignation.clearance && resignation.clearance.status !== "CLEARED" && (
                  <div className="mb-3 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-300 flex items-start gap-2">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" />
                    <span>
                      Exit clearance is <b>{resignation.clearance.status === "IN_PROGRESS" ? "in progress" : "not started"}</b> — the settlement
                      cannot be approved or paid until the checklist is cleared (dues this settlement recovers count as settled).
                    </span>
                  </div>
                )}
                {!settlement ? (
                  <div className="py-4 text-center space-y-2">
                    {can("exit", "calculate") && ["NOTICE_PERIOD", "ACCEPTED"].includes(resignation.status) ? (
                      <>
                        <p className="text-xs text-slate-500">Compute the final settlement from salary, overtime, leave encashment and dues.</p>
                        <Button size="sm" onClick={calculateSettlement} disabled={busy} className="h-8 ">
                          <Calculator className="h-3.5 w-3.5 mr-1" /> {busy ? "Calculating…" : "Calculate Settlement"}
                        </Button>
                      </>
                    ) : (
                      <EmptyState icon={Banknote} title="No settlement calculated yet"
                        hint={["NOTICE_PERIOD", "ACCEPTED"].includes(resignation.status)
                          ? "You need the exit.calculate permission to compute settlements."
                          : "Settlement can be calculated once the resignation is accepted (notice period)."} />
                    )}
                  </div>
                ) : (
                  <SettlementCard settlement={settlement}
                    canApprove={can("exit", "approve")} canPay={can("exit", "pay")}
                    canCalculate={can("exit", "calculate")}
                    onApprove={approveSettlement} onPay={() => setPayOpen(true)}
                    onRecalculate={calculateSettlement} busy={busy} />
                )}
              </SectionCard>
            </div>
          </div>

          {error && <p className="text-sm text-rose-600 bg-rose-50 dark:bg-rose-950 rounded-md px-3 py-2">{error}</p>}

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Close Case</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog open={withdrawOpen} onOpenChange={setWithdrawOpen} title="Withdraw resignation"
        confirmLabel="Withdraw"
        message={`Withdraw the resignation of ${resignation.employeeName}? The pending approval request is also withdrawn. This cannot be done once the exit is accepted or completed.`}
        onConfirm={async () => {
          await rpc("resignations.withdraw", { id: resignation.id })
          toast("Resignation withdrawn")
          onReload()
          onOpenChange(false)
        }} />

      {/* WP-L — mark an outstanding company asset returned (same logic as assets.return) */}
      {returnAsset && (
        <FormDialog
          open onOpenChange={(v) => { if (!v) setReturnAsset(null) }}
          title={`Mark ${returnAsset.assetCode} returned`}
          description={`${returnAsset.assetName} — handed over ${fmtDate(returnAsset.assignedAt)}${returnAsset.conditionOut ? ` in ${titleCase(returnAsset.conditionOut)} condition` : ""}. The asset goes back on the shelf.`}
          fields={[
            {
              name: "conditionIn", label: "Condition at return", type: "select" as const,
              defaultValue: returnAsset.conditionOut || "GOOD",
              options: ["NEW", "GOOD", "FAIR", "DAMAGED"].map((c) => ({ value: c, label: titleCase(c) })),
            },
            { name: "note", label: "Return note", type: "textarea" as const, rows: 2, span: 2 as const, placeholder: "e.g. scratched lid, charger missing" },
          ]}
          submitLabel="Mark returned"
          onSubmit={async (v) => {
            await rpc("exit.assets.return", {
              assignmentId: returnAsset.assignmentId,
              conditionIn: v.conditionIn || null, note: v.note || null,
            })
            toast(`${returnAsset.assetCode} marked returned`)
            onReload()
          }}
        />
      )}

      {/* WP-L — clear an outstanding company asset with a recovery deduction (FinalSettlement line) */}
      {clearAsset && (
        <FormDialog
          open onOpenChange={(v) => { if (!v) setClearAsset(null) }}
          title={`Clear ${clearAsset.assetCode} with deduction`}
          description={`${clearAsset.assetName}${clearAsset.purchaseCost ? ` · purchased at ${fmtMoney(clearAsset.purchaseCost)}` : ""} — the recovery amount is recorded as a FinalSettlement deduction line and the asset is retired.`}
          fields={[
            {
              name: "recoveryAmount", label: "Recovery amount (৳)", type: "number" as const, required: true, min: 0.01, step: 0.01,
              defaultValue: clearAsset.purchaseCost ?? undefined,
              help: "Deducted from the net payable in the final settlement.",
            },
            { name: "note", label: "Reason / note", type: "textarea" as const, rows: 2, span: 2 as const, placeholder: "e.g. laptop not recovered — amount recovered from settlement" },
          ]}
          submitLabel="Clear with deduction"
          onSubmit={async (v) => {
            await rpc("exit.assets.clearWithDeduction", {
              assignmentId: clearAsset.assignmentId,
              recoveryAmount: Number(v.recoveryAmount),
              note: v.note || null,
            })
            toast(`${clearAsset.assetCode} cleared with a ${fmtMoney(Number(v.recoveryAmount))} deduction`)
            onReload()
          }}
        />
      )}

      <ConfirmDialog open={payOpen} onOpenChange={setPayOpen} title="Pay final settlement" danger confirmLabel="Pay & Complete Exit"
        message={`Posts the settlement journal to Accounting and marks ${resignation.employeeName} as ${resignation.exitType || "RESIGNED"}. Net payable ${fmtMoney(settlement?.netPayable || 0)}. This action cannot be undone.`}
        onConfirm={async () => {
          await rpc("settlements.pay", { id: settlement.id })
          setSettlement({ ...settlement, status: "PAID" })
          toast(`Settlement paid — exit completed, employee marked ${resignation.exitType || "RESIGNED"}`)
          onReload()
          onOpenChange(false)
        }} />
    </>
  )
}

// ---------- WP-L — Company Assets pending return (exit clearance block) ----------
function CompanyAssetsCard({ resignation, canProcess, canDeduct, onMarkReturned, onClearWithDeduction }: {
  resignation: any; canProcess: boolean; canDeduct: boolean
  onMarkReturned: (a: any) => void; onClearWithDeduction: (a: any) => void
}) {
  const assets: any[] = resignation.outstandingAssets || []
  return (
    <SectionCard title="Company Assets" actions={
      <span className="text-[11px] text-slate-500 dark:text-slate-400 tabular-nums flex items-center gap-1">
        <Boxes className="h-3 w-3" /> {assets.length} pending return
      </span>
    }>
      {assets.length === 0 ? (
        <p className="text-xs text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5 py-1">
          <CheckCheck className="h-3.5 w-3.5" /> No outstanding company assets — nothing blocks the clearance on the asset side.
        </p>
      ) : (
        <div className="space-y-1.5">
          {assets.map((a) => (
            <div key={a.assignmentId} className="rounded-md border border-slate-100 dark:border-slate-800 px-2.5 py-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-slate-800 dark:text-slate-100 truncate">
                    {a.assetName} <span className="font-mono text-[10px] text-slate-400 font-normal">{a.assetCode}</span>
                  </p>
                  <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">
                    {titleCase(a.category)} · handed over {fmtDate(a.assignedAt)}
                    {a.conditionOut ? ` · out ${titleCase(a.conditionOut)}` : ""}
                    {a.purchaseCost ? ` · ${fmtMoney(a.purchaseCost)}` : ""}
                    {a.assetStatus && a.assetStatus !== "ASSIGNED" ? ` · asset ${titleCase(a.assetStatus)}` : ""}
                  </p>
                  {(a.brandModel || a.serialImei || a.purchaseDate || a.warrantyExpiry) && (
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-slate-600 dark:text-slate-300 mt-1">
                      {a.brandModel && (
                        <span>Brand/Model: <strong className="font-medium text-slate-800 dark:text-slate-100">{a.brandModel}</strong></span>
                      )}
                      {a.serialImei && (
                        <span>S/N / IMEI: <strong className="font-mono font-medium text-slate-800 dark:text-slate-100">{a.serialImei}</strong></span>
                      )}
                      {a.purchaseDate && (
                        <span>Purchased: {fmtDate(a.purchaseDate)}</span>
                      )}
                      {a.warrantyExpiry && (
                        <span>Warranty: <strong className="text-emerald-700 dark:text-emerald-400 font-medium">{fmtDate(a.warrantyExpiry)}</strong></span>
                      )}
                    </div>
                  )}
                </div>
              </div>
              {(canProcess || canDeduct) && (
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {canProcess && (
                    <Button size="sm" variant="outline" className="h-7 text-[11px] bg-white dark:bg-slate-900" onClick={() => onMarkReturned(a)}>
                      <Undo2 className="h-3 w-3 mr-1" /> Mark Returned
                    </Button>
                  )}
                  {canDeduct && (
                    <Button size="sm" variant="outline" className="h-7 text-[11px] text-rose-700 border-rose-200 hover:bg-rose-50 dark:text-rose-400 dark:border-rose-900" onClick={() => onClearWithDeduction(a)}>
                      <Landmark className="h-3 w-3 mr-1" /> Clear with deduction
                    </Button>
                  )}
                </div>
              )}
            </div>
          ))}
          <p className="text-[10px] text-slate-400 flex items-start gap-1 pt-0.5">
            <AlertTriangle className="h-3 w-3 shrink-0 mt-px" />
            Clearance completion is blocked until every handover above is closed — “Clear with deduction” records a recovery line in the final settlement.
          </p>
        </div>
      )}
    </SectionCard>
  )
}

// ---------- Settlement computation card ----------
function SettlementCard({ settlement, canApprove, canPay, canCalculate, onApprove, onPay, onRecalculate, busy }: {
  settlement: any; canApprove: boolean; canPay: boolean; canCalculate?: boolean
  onApprove: () => void; onPay: () => void; onRecalculate?: () => void; busy?: boolean
}) {
  const toast = useHrm((st) => st.toast)
  const c = settlement.computation || {}
  const assetDeductions: { assetCode: string; recoveryAmount: number }[] = Array.isArray(c.assetDeductions) ? c.assetDeductions : []
  const assetRecovery = assetDeductions.reduce((s, d) => s + (Number(d.recoveryAmount) || 0), 0)
  const lines: [string, number, boolean][] = [
    // EXIT-005 — final salary on the payroll convention; the basis line shows
    // the working days / absences / payroll netting it was computed from
    ["Final Salary", c.finalSalary, true],
    [`Overtime${c.otMinutes ? ` (${minutesHHMM(c.otMinutes)})` : ""}`, c.otAmount, true],
    [`Leave Encashment${c.encashableDays ? ` (${c.encashableDays} days)` : ""}`, c.leaveEncashment, true],
    ["Bonus Due", c.bonusDue, true],
    // EXIT-001 — statutory gratuity is now part of the settlement money
    ...(c.gratuity != null
      ? [[`Gratuity${c.gratuityYears ? ` (${c.gratuityYears}y × 30 days' basic${c.gratuityCapped ? ", capped" : ""})` : ""}`, c.gratuity, true] as [string, number, boolean]]
      : []),
    // EXIT-003 — employer-owed notice pay (termination / waived / early release)
    ...(c.noticePay
      ? [[`Notice Pay${c.shortNoticeDays ? ` (${c.shortNoticeDays} days unserved)` : ""}`, c.noticePay, true] as [string, number, boolean]]
      : []),
    // EXIT-007 — provident fund balance settled through the exit flow
    ...(c.pfSettlement
      ? [[`PF Settlement${c.pfEmployeeShare ? ` (employee ${fmtMoney(c.pfEmployeeShare)}${c.pfEmployerShare ? ` + employer ${fmtMoney(c.pfEmployerShare)}` : ""})` : ""}`, c.pfSettlement, true] as [string, number, boolean]]
      : []),
    ["Loan Due", c.loanDue, false],
    ["Advance Due", c.advanceDue, false],
    [`Notice Buyout${c.shortNoticeDays ? ` (${c.shortNoticeDays} days short)` : ""}`, c.noticeBuyout, false],
    ...(assetDeductions.length
      ? [[`Asset Recovery${assetDeductions.length > 1 ? ` (${assetDeductions.length} assets: ${assetDeductions.map((d) => d.assetCode).join(", ")})` : ` — ${assetDeductions[0].assetCode}`}`, assetRecovery, false] as [string, number, boolean]]
      : []),
    ["Other Deductions", (Number(c.otherDeductions) || 0) - assetRecovery, false],
    // PAY-010b (R3-4) — settlement AIT withheld on the salary-like components
    ...(c.settlementAit
      ? [[`AIT Withheld${c.aitDetail?.ruleSetName ? ` (${c.aitDetail.ruleSetName})` : ""}`, c.settlementAit, false] as [string, number, boolean]]
      : []),
  ]
  const fsb = c.finalSalaryBasis

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <StatusBadge status={settlement.status} />
          {canCalculate && settlement.status === "CALCULATED" && onRecalculate && (
            <Button
              variant="outline"
              size="sm"
              onClick={onRecalculate}
              disabled={busy}
              className="h-6 px-2 text-[10px] gap-1 text-slate-600 hover:text-slate-900"
              title="Recalculate settlement with latest data"
            >
              <RefreshCw className={`h-3 w-3 ${busy ? "animate-spin" : ""}`} />
              Recalculate
            </Button>
          )}
        </div>
        <span className="text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">Gross {fmtMoney(c.gross)} · Deductions {fmtMoney(c.totalDeductions)}</span>
      </div>

      <div className="rounded-lg border border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800 overflow-hidden">
        {lines.map(([label, amount, positive], i) => (
          <div key={i} className="flex items-center justify-between px-3 py-1.5">
            <span className="text-xs text-slate-600 dark:text-slate-300">
              <span className={`inline-block w-3 font-bold ${positive ? "text-emerald-600" : "text-rose-500"}`}>{positive ? "+" : "−"}</span>
              {label}
            </span>
            <span className={`text-xs font-medium tabular-nums ${positive ? "text-emerald-700 dark:text-emerald-400" : "text-rose-600"}`}>{fmtMoney(amount || 0)}</span>
          </div>
        ))}
      </div>

      {/* EXIT-005 — the final-salary calculation basis, for audit */}
      {fsb && (
        <p className="text-[10px] text-slate-400 leading-relaxed">
          Final salary basis: {fsb.daysUptoLwd}/{fsb.monthWorkingDays} working days of the LWD month
          {fsb.absentDays ? ` · ${fsb.absentDays} absent day(s) deducted (৳${fmtMoney(fsb.absenceDeduction)})` : ""}
          {fsb.alreadyPaidGross ? ` · netted against ৳${fmtMoney(fsb.alreadyPaidGross)} already paid by payroll this month` : ""}.
        </p>
      )}

      <div className="rounded-xl bg-primary px-4 py-3 flex items-center justify-between shadow-sm">
        <span className="text-xs font-semibold uppercase tracking-wide text-emerald-50">Net Payable</span>
        <span className="text-2xl font-bold tabular-nums text-white">{fmtMoney(c.netPayable ?? settlement.netPayable)}</span>
      </div>

      <div className="flex flex-wrap gap-2">
        {/* EXT-04 (R7) — printable Full & Final statement */}
        {["CALCULATED", "APPROVED", "PAID"].includes(settlement.status) && (
          <Button size="sm" variant="outline" disabled={busy}
            className="h-8 border-emerald-200 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-400 dark:hover:bg-emerald-950/50"
            onClick={async () => {
              try {
                const res = await rpc<{ html: string }>("settlements.html", { id: settlement.id })
                const w = openPrintWindow(res.html, { print: false })
                if (!w) toast("Popup blocked — allow popups to view the statement", "err")
              } catch (e: any) { toast(e.message || "Could not open statement", "err") }
            }}>
            <Printer className="h-3.5 w-3.5 mr-1" /> Print F&F Statement
          </Button>
        )}
        {canApprove && settlement.status === "CALCULATED" && (
          <Button size="sm" onClick={onApprove} disabled={busy} className="h-8 ">
            <CheckCheck className="h-3.5 w-3.5 mr-1" /> {busy ? "Working…" : "Approve Settlement"}
          </Button>
        )}
        {canPay && settlement.status === "APPROVED" && (
          <Button size="sm" onClick={onPay} className="h-8 bg-rose-600 hover:bg-rose-700 text-white">
            <Banknote className="h-3.5 w-3.5 mr-1" /> Pay Settlement
          </Button>
        )}
        {settlement.status === "PAID" && (
          <p className="text-xs text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5">
            <CheckCheck className="h-3.5 w-3.5" /> Paid — journal posted, employee marked RESIGNED.
          </p>
        )}
        {settlement.status === "CALCULATED" && !canApprove && (
          <p className="text-[11px] text-slate-500 dark:text-slate-400">Awaiting approval (exit.approve permission required).</p>
        )}
        {settlement.status === "APPROVED" && !canPay && (
          <p className="text-[11px] text-slate-500 dark:text-slate-400">Approved — awaiting payment (exit.pay permission required).</p>
        )}
      </div>
    </div>
  )
}

// ================= PROCESS & FORMULA GUIDE =================
function GuideTab() {
  const steps = [
    { title: "Resignation submitted", text: "Employee submits via Self-Service (or HR on their behalf) with resignation date, proposed last working day and reason." },
    { title: "Approval workflow", text: "Manager → HR review via the reusable approval engine. Rejection ends the case; acceptance starts the notice period." },
    { title: "Notice period & clearance", text: "Notice mode (FULL / SHORT / BUYOUT / WAIVED) is computed from served days. Departmental clearance checklist is issued to HR, Finance, Accounts, IT, Admin, Warehouse and Management." },
    { title: "Settlement calculated", text: "Final salary (working days to the LWD, minus absences, netted against payroll already paid), overtime, leave encashment, gratuity, PF balance and bonus minus loan, advance, notice buyout and other dues." },
    { title: "Approve & pay", text: "Payment requires a CLEARED exit checklist, posts the settlement journal to Accounting (loans/advances closed, PF paid out, bonuses marked paid) and marks the employee RESIGNED — the exit is completed." },
  ]
  return (
    <div className="space-y-4">
      <SectionCard title="Final Settlement Formula">
        <div className="rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/50 p-4 flex items-start gap-3">
          <Calculator className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" />
          <p className="text-sm font-medium text-slate-700 dark:text-slate-200 leading-relaxed">
            Final Salary + OT + Bonus + Leave Encashment − Loan − Advance − Other Deductions <b className="text-emerald-700 dark:text-emerald-400">= Final Settlement → Accounting</b>
          </p>
        </div>
        <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-2 flex items-center gap-1">
          <AlertTriangle className="h-3 w-3" /> Notice buyout is deducted automatically when the employee serves a short notice. Festival bonus is included only when configured.
        </p>
      </SectionCard>

      <div className="grid md:grid-cols-2 gap-4">
        <SectionCard title="Notice Period Modes">
          <div className="space-y-2.5">
            {Object.entries(NOTICE_MODES).map(([mode, text]) => (
              <div key={mode} className="rounded-lg border border-slate-100 dark:border-slate-800 p-2.5">
                <p className="text-xs font-semibold text-slate-700 dark:text-slate-200 mb-0.5">{titleCase(mode)}</p>
                <p className="text-xs text-slate-500 dark:text-slate-400">{text}</p>
              </div>
            ))}
          </div>
        </SectionCard>

        <SectionCard title="Exit Process Flow">
          <div className="relative pl-6">
            <div className="absolute left-2 top-1 bottom-1 w-px bg-slate-200 dark:bg-slate-700" />
            {steps.map((s, i) => (
              <div key={i} className="relative pb-4 last:pb-0">
                <div className="absolute -left-[1.28rem] top-0.5 h-6 w-6 rounded-full bg-white dark:bg-slate-900 border-2 border-emerald-500 flex items-center justify-center">
                  <span className="text-[10px] font-bold text-emerald-600">{i + 1}</span>
                </div>
                <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{s.title}</p>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{s.text}</p>
              </div>
            ))}
          </div>
        </SectionCard>
      </div>

      <SectionCard title="Employees">
        <p className="text-xs text-slate-500 flex items-center gap-1.5">
          <UserRound className="h-3.5 w-3.5 text-emerald-600" />
          Employees submit and withdraw their own resignations, and track clearance &amp; settlement, from the ESS module (Self-Service → My Exit). This view is HR-facing.
        </p>
      </SectionCard>
    </div>
  )
}
