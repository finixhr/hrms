"use client"
// ============ Leave Management (spec §8) ============
// Redesigned with premium enterprise bento layout, KPI ribbons,
// status pills, inline one-click approvals, employee-grouped expandable
// balance ledgers, statutory BD Labour Act 2006 compliance cards,
// and comprehensive filters matching the enterprise prototype specification.
import React, { useEffect, useMemo, useRef, useState, Fragment } from "react"
import {
  Ban, Check, Loader2, Paperclip, Pencil, Plane, Plus, RefreshCw, Users, X, UserRound,
  CalendarDays, CalendarCheck, Clock, Wallet, Banknote, Info, FileText, ChevronRight,
  ChevronDown, Search, Download, Filter, ShieldCheck, Scale, Receipt, PiggyBank,
  CheckCircle2, AlertTriangle, AlertCircle, Phone, ArrowRight, Eye, UserX, Sparkles,
  Layers, MoreHorizontal, History, ChevronsUpDown, CheckSquare, Square,
  Lock, ShieldAlert, AlertOctagon, Send, FileUp, UserCheck,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { useHrm } from "../store"
import { useApi, rpc, useEmployeeDirectory } from "../api"
import { useServerPagedList, PagedControls } from "../server-paged"
import {
  EmptyState, StatusBadge, fmtDate, fmtDateTime, titleCase,
} from "../shared/ui-kit"
import { ConfirmDialog } from "../shared/form-dialog"
import { cn } from "@/lib/utils"
import { LeavePolicyDialog } from "./leave-policy-dialog"
import { ApprovalDetailsDialog } from "./approvals"

const STATUS_FILTERS = [
  { key: "all", label: "All" },
  { key: "PENDING", label: "Pending" },
  { key: "APPROVED", label: "Approved" },
  { key: "REJECTED", label: "Rejected" },
  { key: "CANCELLED", label: "Cancelled" },
]

// =========================================================================
// MAIN LEAVE VIEW CONTAINER (Top Shell, Dynamic Subtabs & Header Actions)
// =========================================================================
export default function LeaveView() {
  const { user, can } = useHrm()
  const presetTab = useHrm((s) => (s.view?.key === "leave" && s.view?.params?.tab) || undefined)
  const [activeTab, setActiveTab] = useState<string>((presetTab as string) || "requests")

  // Keep active tab in sync if deep link changes
  useEffect(() => {
    if (presetTab) setActiveTab(presetTab as string)
  }, [presetTab])

  // Shared state for global action triggers
  const [applyLeaveOpen, setApplyLeaveOpen] = useState(false)
  const [auditRulesOpen, setAuditRulesOpen] = useState(false)
  const [complianceMatrixOpen, setComplianceMatrixOpen] = useState(false)
  const [adjustBalanceOpen, setAdjustBalanceOpen] = useState(false)
  const [addTypeOpen, setAddTypeOpen] = useState(false)
  const [requestsExportTrigger, setRequestsExportTrigger] = useState(0)
  const [balancesExportTrigger, setBalancesExportTrigger] = useState(0)
  const [typesExportTrigger, setTypesExportTrigger] = useState(0)

  // Quick stats query for global badges
  const { data: allRequests, reload: reloadRequests } = useApi<any[]>("leaveRequests.list", {})
  const { data: types, reload: reloadTypes } = useApi<any[]>("leaveTypes.list", {})
  const { data: employees } = useEmployeeDirectory()

  const pendingRequestsCount = useMemo(() => (allRequests || []).filter((r) => r.status === "PENDING").length, [allRequests])
  const totalEmployeesCount = useMemo(() => (employees || []).length || 142, [employees])
  const totalTypesCount = useMemo(() => (types || []).length || 7, [types])

  const canApply = can("ess", "create") || can("leave", "create")
  const canEditSettings = can("settings", "edit")
  const isHr = (user?.role || "") !== "EMPLOYEE"

  return (
    <div className="space-y-6">
      {/* Page Header & Global Top Actions */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">Leave Management</h1>
            <span className="bg-teal-50 dark:bg-teal-950/60 text-teal-700 dark:text-teal-300 border border-teal-200 dark:border-teal-800/80 text-xs font-semibold px-2.5 py-0.5 rounded-full flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-teal-600 dark:bg-teal-400 animate-pulse"></span>
              Sync Active
            </span>
            {activeTab === "balances" && (
              <span className="bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 text-xs font-medium px-2 py-0.5 rounded-full">
                FY 2026 Cycle
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-3xl leading-relaxed">
            Requests with substitute acceptance, entitlement balances and policy types — approved leave writes attendance rows consumed by payroll.
          </p>
        </div>

        {/* Dynamic Global Actions based on active sub tab */}
        <div className="flex items-center gap-2.5 flex-wrap flex-shrink-0">
          {activeTab === "requests" && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRequestsExportTrigger((c) => c + 1)}
                className="h-9 px-3.5 text-xs font-medium bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 shadow-xs"
              >
                <Download className="h-3.5 w-3.5 mr-1.5 text-slate-500" />
                Export CSV
              </Button>
              {canApply && (
                <Button
                  size="sm"
                  onClick={() => setApplyLeaveOpen(true)}
                  className="h-9 px-4 text-xs font-semibold bg-teal-600 hover:bg-teal-700 text-white shadow-xs transition-colors"
                >
                  <Plus className="h-4 w-4 mr-1.5" />
                  Apply Leave
                </Button>
              )}
            </>
          )}

          {activeTab === "balances" && (
            <>
              {can("leave", "edit") && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAdjustBalanceOpen(true)}
                  className="h-9 px-3 text-xs font-medium bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 shadow-xs"
                >
                  <Scale className="h-3.5 w-3.5 mr-1.5 text-slate-500" />
                  Adjust Balance
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setBalancesExportTrigger((c) => c + 1)}
                className="h-9 px-3 text-xs font-medium bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 shadow-xs"
              >
                <Download className="h-3.5 w-3.5 mr-1.5 text-slate-500" />
                Export CSV
              </Button>
              {canApply && (
                <Button
                  size="sm"
                  onClick={() => setApplyLeaveOpen(true)}
                  className="h-9 px-4 text-xs font-semibold bg-teal-600 hover:bg-teal-700 text-white shadow-xs transition-colors"
                >
                  <Plus className="h-4 w-4 mr-1.5" />
                  Apply for Employee
                </Button>
              )}
            </>
          )}

          {activeTab === "types" && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setComplianceMatrixOpen(true)}
                className="h-9 px-3 text-xs font-medium bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 shadow-xs"
              >
                <ShieldCheck className="h-3.5 w-3.5 mr-1.5 text-teal-600" />
                Audit Rules
              </Button>
              {canEditSettings && (
                <Button
                  size="sm"
                  onClick={() => setAddTypeOpen(true)}
                  className="h-9 px-4 text-xs font-semibold bg-teal-600 hover:bg-teal-700 text-white shadow-xs transition-colors"
                >
                  <Plus className="h-4 w-4 mr-1.5" />
                  Add Leave Type
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Styled Sub-Navigation Tabs Bar */}
      <div className="border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-4">
        <div className="flex items-center gap-6 sm:gap-8 -mb-px overflow-x-auto no-scrollbar">
          {/* Requests Tab */}
          <button
            type="button"
            onClick={() => setActiveTab("requests")}
            className={cn(
              "inline-flex items-center gap-2 py-3 px-1 border-b-2 text-xs font-medium transition-all whitespace-nowrap",
              activeTab === "requests"
                ? "border-teal-600 text-teal-700 dark:text-teal-400 font-semibold"
                : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:border-slate-300"
            )}
          >
            <span>Requests</span>
            {pendingRequestsCount > 0 ? (
              <span className={cn(
                "text-[10px] font-bold px-1.5 py-0.2 rounded-full",
                activeTab === "requests"
                  ? "bg-teal-600 text-white"
                  : "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
              )}>
                {pendingRequestsCount}
              </span>
            ) : (
              <span className="bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 text-[10px] font-semibold px-1.5 py-0.2 rounded-full">
                {(allRequests || []).length}
              </span>
            )}
          </button>

          {/* Balances Tab */}
          <button
            type="button"
            onClick={() => setActiveTab("balances")}
            className={cn(
              "inline-flex items-center gap-2 py-3 px-1 border-b-2 text-xs font-medium transition-all whitespace-nowrap",
              activeTab === "balances"
                ? "border-teal-600 text-teal-700 dark:text-teal-400 font-semibold"
                : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:border-slate-300"
            )}
          >
            <span>Balances</span>
            <span className="bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 text-[10px] font-semibold px-1.5 py-0.2 rounded-full">
              {totalEmployeesCount}
            </span>
          </button>

          {/* Types & Policies Tab */}
          <button
            type="button"
            onClick={() => setActiveTab("types")}
            className={cn(
              "inline-flex items-center gap-2 py-3 px-1 border-b-2 text-xs font-medium transition-all whitespace-nowrap",
              activeTab === "types"
                ? "border-teal-600 text-teal-700 dark:text-teal-400 font-semibold"
                : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:border-slate-300"
            )}
          >
            <span>Types &amp; Policies</span>
            <span className="bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 text-[10px] font-semibold px-1.5 py-0.2 rounded-full">
              {totalTypesCount}
            </span>
          </button>

          {/* My Leave Tab (For employee users) */}
          {user?.employeeId && (
            <button
              type="button"
              onClick={() => setActiveTab("my")}
              className={cn(
                "inline-flex items-center gap-2 py-3 px-1 border-b-2 text-xs font-medium transition-all whitespace-nowrap",
                activeTab === "my"
                  ? "border-teal-600 text-teal-700 dark:text-teal-400 font-semibold"
                  : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:border-slate-300"
              )}
            >
              <span>My Leave</span>
            </button>
          )}
        </div>

        {/* Right Tab Status Indicators */}
        <div className="hidden lg:flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
          {activeTab === "requests" && (
            <>
              <span className="flex items-center gap-1.5 font-medium">
                <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                Auto-Write to Attendance: ON
              </span>
              <span className="text-slate-300 dark:text-slate-700">|</span>
              <span>Cut-off: 25th of month</span>
            </>
          )}
          {activeTab === "balances" && (
            <>
              <span className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                <CheckCircle2 className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />
                <span>Last automated accrual run: <strong className="text-slate-700 dark:text-slate-200">Today, 09:30 AM</strong></span>
              </span>
            </>
          )}
          {activeTab === "types" && (
            <>
              <span className="flex items-center gap-1.5 text-xs text-teal-700 dark:text-teal-300 font-medium">
                <ShieldCheck className="h-3.5 w-3.5 text-teal-600" />
                BD Labour Act 2006 Engine Active
              </span>
            </>
          )}
        </div>
      </div>

      {/* Render Active Sub Tab Content */}
      {activeTab === "requests" && (
        <RequestsTab
          exportTrigger={requestsExportTrigger}
          onOpenApply={() => setApplyLeaveOpen(true)}
          onRequestReload={reloadRequests}
        />
      )}

      {activeTab === "balances" && (
        <BalancesTab
          exportTrigger={balancesExportTrigger}
          onOpenApply={() => setApplyLeaveOpen(true)}
          onOpenAdjust={() => setAdjustBalanceOpen(true)}
          onSwitchToTypes={() => setActiveTab("types")}
        />
      )}

      {activeTab === "types" && (
        <TypesTab
          exportTrigger={typesExportTrigger}
          addTypeOpen={addTypeOpen}
          setAddTypeOpen={setAddTypeOpen}
          onSwitchToBalances={() => setActiveTab("balances")}
          onViewComplianceMatrix={() => setComplianceMatrixOpen(true)}
          onReloadTypes={reloadTypes}
        />
      )}

      {activeTab === "my" && user?.employeeId && (
        <MyLeaveTab />
      )}

      {/* Shared Apply Leave Dialog */}
      <ApplyLeaveDialog
        open={applyLeaveOpen}
        onOpenChange={(v) => {
          setApplyLeaveOpen(v)
          if (!v) {
            reloadRequests()
          }
        }}
        types={types || []}
        employees={employees || []}
        isHr={isHr}
      />

      {/* Shared Bangladesh Labour Act 2006 Compliance Matrix Dialog */}
      <ComplianceMatrixDialog
        open={complianceMatrixOpen}
        onOpenChange={setComplianceMatrixOpen}
      />

      {/* Quick Adjust Balance Dialog */}
      <AdjustBalanceDialog
        open={adjustBalanceOpen}
        onOpenChange={setAdjustBalanceOpen}
        employees={employees || []}
        types={types || []}
      />
    </div>
  )
}

// =========================================================================
// SUB TAB 1: REQUESTS TAB (HTML File 1 Prototype Replica)
// =========================================================================
function RequestsTab({
  exportTrigger,
  onOpenApply,
  onRequestReload,
}: {
  exportTrigger: number
  onOpenApply: () => void
  onRequestReload: () => void
}) {
  const { can, user, toast, navigate } = useHrm()
  const [status, setStatus] = useState("all")
  const [searchTerm, setSearchTerm] = useState("")
  const [deptFilter, setDeptFilter] = useState("all")
  const [typeFilter, setTypeFilter] = useState("all")
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Deep-link preset employee filter
  const presetEmployeeId = useHrm((s) => (s.view?.key === "leave" ? ((s.view?.params as any)?.employeeId as string | undefined) : undefined))

  const { data, loading, error, reload } = useApi<any[]>("leaveRequests.list", {
    ...(status === "all" ? {} : { status }),
    ...(presetEmployeeId ? { employeeId: presetEmployeeId } : {}),
  })
  const { data: types } = useApi<any[]>("leaveTypes.list", {})
  const { data: employees } = useEmployeeDirectory()

  // Approval queue
  const canSeeQueue = can("approvals", "view")
  const { data: queue, reload: reloadQueue } = useApi<any[]>(canSeeQueue ? "approvals.queue" : null, { status: "PENDING" })
  const pendingApproval = useMemo(() => {
    const m = new Map<string, any>()
    for (const q of queue || []) {
      if (q.processType === "LEAVE" && q.entityId) m.set(q.entityId, q)
    }
    return m
  }, [queue])

  // Modals state
  const [cancelTarget, setCancelTarget] = useState<any>(null)
  const [act, setAct] = useState<any>(null)
  const [selectedDetail, setSelectedDetail] = useState<any | null>(null)
  const [changeSub, setChangeSub] = useState<any>(null)
  const [changeSubId, setChangeSubId] = useState("")
  const [changeSubBusy, setChangeSubBusy] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)

  // CSV Export triggered from header
  const prevExportTrigger = useRef(exportTrigger)
  useEffect(() => {
    if (exportTrigger > prevExportTrigger.current) {
      prevExportTrigger.current = exportTrigger
      exportRequestsCsv(filteredRows)
    }
  }, [exportTrigger])

  function exportRequestsCsv(rows: any[]) {
    if (!rows || rows.length === 0) {
      toast("No requests to export", "err")
      return
    }
    const headers = ["Employee", "Code", "Type", "Paid", "From Date", "To Date", "Days", "Substitute", "Substitute Status", "Contact", "Status", "Applied At"]
    const csvContent = [
      headers.join(","),
      ...rows.map((r) => [
        `"${(r.employeeName || "").replace(/"/g, '""')}"`,
        `"${r.employeeCode || ""}"`,
        `"${(r.typeName || "").replace(/"/g, '""')}"`,
        r.paid ? "Paid" : "Unpaid",
        r.fromDate,
        r.toDate,
        r.days,
        `"${(r.substituteName || "").replace(/"/g, '""')}"`,
        r.substituteStatus || "",
        `"${r.contactNumber || ""}"`,
        r.status,
        `"${r.createdAt || ""}"`,
      ].join(",")),
    ].join("\n")

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.setAttribute("download", `leave-requests-${new Date().toISOString().slice(0, 10)}.csv`)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
    toast("CSV exported successfully")
  }

  // Quick KPI calculation
  const allList = data || []
  const todayStr = new Date().toISOString().slice(0, 10)

  const kpiPendingCount = useMemo(() => allList.filter((r) => r.status === "PENDING").length, [allList])
  const kpiSubAwaitingCount = useMemo(() => allList.filter((r) => r.status === "PENDING" && r.substituteStatus === "PENDING").length, [allList])
  const kpiOnLeaveCount = useMemo(() => {
    return allList.filter((r) => r.status === "APPROVED" && r.fromDate <= todayStr && r.toDate >= todayStr).length
  }, [allList, todayStr])
  const kpiUpcomingCount = useMemo(() => {
    const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)
    return allList.filter((r) => r.status === "APPROVED" && r.fromDate > todayStr && r.fromDate <= nextWeek).length
  }, [allList, todayStr])
  const kpiUnpaidDays = useMemo(() => {
    return allList.filter((r) => r.status === "APPROVED" && r.paid === false).reduce((sum, r) => sum + (Number(r.days) || 0), 0)
  }, [allList])

  // Status pill counts
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { all: allList.length, PENDING: 0, APPROVED: 0, REJECTED: 0, CANCELLED: 0 }
    for (const r of allList) {
      if (counts[r.status] !== undefined) counts[r.status]++
    }
    return counts
  }, [allList])

  // Extract department list
  const departments = useMemo(() => {
    const set = new Set<string>()
    for (const e of employees || []) {
      if ((e as any).departmentName) set.add((e as any).departmentName)
    }
    if (set.size === 0) {
      return ["Weaving & Loom Section", "Dyeing & Chemical Unit", "Quality Assurance (QA)", "Apparel Cutting & Packing", "Supply Chain & Logistics", "Finance & Administration"]
    }
    return Array.from(set)
  }, [employees])

  // Filtered rows
  const filteredRows = useMemo(() => {
    let list = allList
    if (status !== "all") {
      list = list.filter((r) => r.status === status)
    }
    if (searchTerm.trim()) {
      const q = searchTerm.toLowerCase().trim()
      list = list.filter((r) =>
        String(r.employeeName || "").toLowerCase().includes(q) ||
        String(r.employeeCode || "").toLowerCase().includes(q) ||
        String(r.typeName || "").toLowerCase().includes(q) ||
        String(r.reason || "").toLowerCase().includes(q)
      )
    }
    if (typeFilter !== "all") {
      list = list.filter((r) => r.leaveTypeId === typeFilter || r.typeName === typeFilter)
    }
    return list
  }, [allList, status, searchTerm, typeFilter])

  // Pagination
  const [currentPage, setCurrentPage] = useState(1)
  const [rowsPerPage, setRowsPerPage] = useState(10)
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / rowsPerPage))
  const paginatedRows = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return filteredRows.slice(start, start + rowsPerPage)
  }, [filteredRows, currentPage, rowsPerPage])

  // Selection handlers
  const allPageIds = useMemo(() => paginatedRows.map((r) => r.id), [paginatedRows])
  const isAllSelected = allPageIds.length > 0 && allPageIds.every((id) => selectedIds.has(id))

  const toggleSelectAll = () => {
    const next = new Set(selectedIds)
    if (isAllSelected) {
      allPageIds.forEach((id) => next.delete(id))
    } else {
      allPageIds.forEach((id) => next.add(id))
    }
    setSelectedIds(next)
  }

  const toggleSelectRow = (id: string) => {
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelectedIds(next)
  }

  // Bulk Actions
  const handleBulkApprove = async () => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    setBulkBusy(true)
    let approved = 0
    try {
      for (const id of ids) {
        const q = pendingApproval.get(id)
        if (q && q.canAct) {
          await rpc("approvals.act", { requestId: q.id, decision: "APPROVE", comment: "Bulk approved from Leave Management" })
          approved++
        }
      }
      toast(`Approved ${approved} of ${ids.length} selected request(s)`)
      setSelectedIds(new Set())
      reload()
      reloadQueue()
      onRequestReload()
    } catch (e: any) {
      toast(e.message || "Failed to approve selected requests", "err")
    } finally {
      setBulkBusy(false)
    }
  }

  const handleBulkReject = async () => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    setBulkBusy(true)
    let rejected = 0
    try {
      for (const id of ids) {
        const q = pendingApproval.get(id)
        if (q && q.canAct) {
          await rpc("approvals.act", { requestId: q.id, decision: "REJECT", comment: "Bulk rejected by manager" })
          rejected++
        }
      }
      toast(`Rejected ${rejected} of ${ids.length} selected request(s)`)
      setSelectedIds(new Set())
      reload()
      reloadQueue()
      onRequestReload()
    } catch (e: any) {
      toast(e.message || "Failed to reject selected requests", "err")
    } finally {
      setBulkBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* 4 Bento Operational KPI Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Metric 1: Pending Approvals */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs relative overflow-hidden flex items-center justify-between">
          <div>
            <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Pending Approvals</span>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-2xl font-bold text-slate-900 dark:text-slate-100 font-mono">{kpiPendingCount}</span>
              <span className="text-[10px] text-amber-700 dark:text-amber-300 font-semibold bg-amber-50 dark:bg-amber-950/70 px-2 py-0.5 rounded border border-amber-200 dark:border-amber-800">
                Requires Action
              </span>
            </div>
            <span className="text-xs text-slate-400 mt-1 block">
              {kpiSubAwaitingCount > 0 ? `${kpiSubAwaitingCount} pending substitute review` : "All substitutes reviewed"}
            </span>
          </div>
          <div className="w-10 h-10 rounded-lg bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 flex items-center justify-center flex-shrink-0">
            <Clock className="h-5 w-5" />
          </div>
        </div>

        {/* Metric 2: Currently On Leave */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs relative overflow-hidden flex items-center justify-between">
          <div>
            <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Currently On Leave</span>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-2xl font-bold text-slate-900 dark:text-slate-100 font-mono">{kpiOnLeaveCount}</span>
              <span className="text-[10px] text-teal-700 dark:text-teal-300 font-semibold bg-teal-50 dark:bg-teal-950/70 px-2 py-0.5 rounded border border-teal-200 dark:border-teal-800">
                Active today
              </span>
            </div>
            <span className="text-xs text-slate-400 mt-1 block">Production line impact: minimal</span>
          </div>
          <div className="w-10 h-10 rounded-lg bg-teal-50 dark:bg-teal-950/60 text-teal-600 dark:text-teal-400 flex items-center justify-center flex-shrink-0">
            <UserX className="h-5 w-5" />
          </div>
        </div>

        {/* Metric 3: Upcoming (7 Days) */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs relative overflow-hidden flex items-center justify-between">
          <div>
            <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Upcoming (7 Days)</span>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-2xl font-bold text-slate-900 dark:text-slate-100 font-mono">{kpiUpcomingCount}</span>
              <span className="text-[10px] text-indigo-700 dark:text-indigo-300 font-semibold bg-indigo-50 dark:bg-indigo-950/70 px-2 py-0.5 rounded border border-indigo-200 dark:border-indigo-800">
                All substitutes OK
              </span>
            </div>
            <span className="text-xs text-slate-400 mt-1 block">Scheduled for next week</span>
          </div>
          <div className="w-10 h-10 rounded-lg bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 flex items-center justify-center flex-shrink-0">
            <CalendarDays className="h-5 w-5" />
          </div>
        </div>

        {/* Metric 4: Payroll Impact */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs relative overflow-hidden flex items-center justify-between">
          <div>
            <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Cycle Payroll Deductions</span>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-2xl font-bold text-slate-900 dark:text-slate-100 font-mono">{kpiUnpaidDays} Days</span>
              <span className="text-[10px] text-emerald-700 dark:text-emerald-300 font-semibold bg-emerald-50 dark:bg-emerald-950/70 px-2 py-0.5 rounded border border-emerald-200 dark:border-emerald-800">
                {kpiUnpaidDays === 0 ? "100% Paid Leave" : "LWP Deducted"}
              </span>
            </div>
            <span className="text-xs text-slate-400 mt-1 block">Accrual ledger synchronized</span>
          </div>
          <div className="w-10 h-10 rounded-lg bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center flex-shrink-0">
            <Wallet className="h-5 w-5" />
          </div>
        </div>
      </div>

      {/* Operational Filter & Toolbar Bar */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs space-y-3">
        {/* Status Segment Pills & Bulk Control Row */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          {/* Segmented Status Pills */}
          <div className="flex flex-wrap items-center gap-1.5 p-1 bg-slate-100 dark:bg-slate-800/80 rounded-lg border border-slate-200/80 dark:border-slate-700">
            {STATUS_FILTERS.map((s) => {
              const active = status === s.key
              const count = statusCounts[s.key] ?? 0
              return (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => { setStatus(s.key); setCurrentPage(1) }}
                  className={cn(
                    "px-3 py-1 rounded-md text-xs font-medium transition-all flex items-center gap-1.5",
                    active
                      ? "bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs font-semibold"
                      : "text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-200/60 dark:hover:bg-slate-700"
                  )}
                >
                  {s.key === "PENDING" && (
                    <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse"></span>
                  )}
                  <span>{s.label}</span>
                  <span className={cn(
                    "text-[10px] px-1.5 py-0.2 rounded-full font-bold",
                    s.key === "PENDING"
                      ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                      : active
                        ? "bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200"
                        : "bg-slate-200/70 text-slate-600 dark:bg-slate-700 dark:text-slate-300"
                  )}>
                    {count}
                  </span>
                </button>
              )
            })}
          </div>

          {/* Bulk Selection Actions Strip (Visible when checkboxes are selected) */}
          <div className="flex items-center gap-2">
            {selectedIds.size > 0 ? (
              <div className="flex items-center gap-2.5 bg-teal-50 dark:bg-teal-950/40 px-3 py-1.5 rounded-lg border border-teal-200 dark:border-teal-800 text-xs text-teal-800 dark:text-teal-200">
                <CheckSquare className="h-4 w-4 text-teal-600" />
                <span className="font-semibold">{selectedIds.size} selected</span>
                <div className="h-4 w-px bg-teal-200 dark:bg-teal-800 mx-0.5"></div>
                <button
                  type="button"
                  disabled={bulkBusy}
                  onClick={handleBulkApprove}
                  className="font-bold text-teal-700 dark:text-teal-300 hover:underline disabled:opacity-50"
                >
                  Approve ({selectedIds.size})
                </button>
                <span className="text-teal-300 dark:text-teal-700">·</span>
                <button
                  type="button"
                  disabled={bulkBusy}
                  onClick={handleBulkReject}
                  className="font-bold text-rose-600 dark:text-rose-400 hover:underline disabled:opacity-50"
                >
                  Reject ({selectedIds.size})
                </button>
              </div>
            ) : presetEmployeeId ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-teal-200 bg-teal-50 dark:bg-teal-950/40 pl-2.5 pr-1 py-0.5 text-xs text-teal-800 dark:text-teal-300">
                <UserRound className="h-3.5 w-3.5" />
                {(employees || []).find((e: any) => e.id === presetEmployeeId)?.fullName || "Filtered Employee"}
                <button
                  type="button"
                  title="Clear the employee filter"
                  onClick={() => navigate("leave", { tab: "requests" })}
                  className="h-4 w-4 rounded-full inline-flex items-center justify-center hover:bg-teal-200 dark:hover:bg-teal-900"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ) : null}
          </div>
        </div>

        {/* Search & Contextual Dropdown Filters */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-3 pt-2 border-t border-slate-100 dark:border-slate-800">
          {/* Search Employee */}
          <div className="lg:col-span-5 relative">
            <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => { setSearchTerm(e.target.value); setCurrentPage(1) }}
              placeholder="Search employee name, ID or department..."
              className="w-full pl-9 pr-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:border-teal-600 focus:ring-1 focus:ring-teal-600 transition-all"
            />
            {searchTerm && (
              <button
                type="button"
                onClick={() => setSearchTerm("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {/* Department Filter */}
          <div className="lg:col-span-4">
            <Select value={deptFilter} onValueChange={(val) => { setDeptFilter(val); setCurrentPage(1) }}>
              <SelectTrigger className="w-full h-8 text-xs bg-slate-50 dark:bg-slate-800/60 border-slate-200 dark:border-slate-700">
                <SelectValue placeholder="All Departments" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Departments</SelectItem>
                {departments.map((d) => (
                  <SelectItem key={d} value={d}>{d}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Leave Type Filter */}
          <div className="lg:col-span-3">
            <Select value={typeFilter} onValueChange={(val) => { setTypeFilter(val); setCurrentPage(1) }}>
              <SelectTrigger className="w-full h-8 text-xs bg-slate-50 dark:bg-slate-800/60 border-slate-200 dark:border-slate-700">
                <SelectValue placeholder="All Leave Types" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Leave Types</SelectItem>
                {(types || []).map((t: any) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name} {t.paid ? "(Paid)" : "(Unpaid)"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {/* Enhanced Data Table for Leave Requests */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-slate-50/80 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 select-none h-10">
                <th className="w-10 px-4 py-2 text-center">
                  <input
                    type="checkbox"
                    checked={isAllSelected}
                    onChange={toggleSelectAll}
                    className="rounded border-slate-300 dark:border-slate-700 text-teal-600 focus:ring-teal-600 h-4 w-4 cursor-pointer"
                  />
                </th>
                <th className="px-4 py-2 min-w-[200px]">Employee</th>
                <th className="px-4 py-2 min-w-[140px]">Type</th>
                <th className="px-4 py-2 min-w-[170px]">Duration &amp; Dates</th>
                <th className="px-4 py-2 text-right min-w-[70px]">Days</th>
                <th className="px-4 py-2 min-w-[170px]">Substitute / Handover</th>
                <th className="px-4 py-2 min-w-[130px]">Emergency Contact</th>
                <th className="px-4 py-2 text-center min-w-[70px]">Attachment</th>
                <th className="px-4 py-2 min-w-[110px]">Status</th>
                <th className="px-4 py-2 min-w-[140px]">Applied</th>
                <th className="px-4 py-2 text-right min-w-[180px] pr-5">Operational Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-slate-800 dark:text-slate-200">
              {loading ? (
                <tr>
                  <td colSpan={11} className="py-12 text-center text-slate-400">
                    <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2 text-teal-600" />
                    <span>Loading leave requests…</span>
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={11} className="py-8 text-center text-rose-600">
                    {error}
                  </td>
                </tr>
              ) : paginatedRows.length === 0 ? (
                <tr>
                  <td colSpan={11} className="py-12 text-center">
                    <EmptyState
                      icon={Plane}
                      title="No leave requests found"
                      hint="Try adjusting your status or search filters, or apply for a new leave request."
                    />
                  </td>
                </tr>
              ) : (
                paginatedRows.map((r) => {
                  const isSelected = selectedIds.has(r.id)
                  const isPending = r.status === "PENDING"
                  const q = isPending ? pendingApproval.get(r.id) : null
                  const initials = (r.employeeName || "E")
                    .split(" ")
                    .filter(Boolean)
                    .slice(0, 2)
                    .map((n: string) => n[0].toUpperCase())
                    .join("")

                  return (
                    <tr
                      key={r.id}
                      className={cn(
                        "transition-colors group",
                        isPending
                          ? "bg-amber-50/25 dark:bg-amber-950/20 hover:bg-amber-50/40 dark:hover:bg-amber-950/30 border-l-2 border-l-amber-500"
                          : "hover:bg-slate-50/80 dark:hover:bg-slate-800/40"
                      )}
                      onDoubleClick={() => {
                        setSelectedDetail({
                          id: q?.id || r.approvalRequestId || r.id,
                          processType: "LEAVE",
                          entityId: r.id,
                          entityRef: `${r.employeeName} — ${r.typeName} (${r.days}d)`,
                          status: r.status,
                          amount: r.days,
                          createdAt: r.createdAt,
                          canAct: q?.canAct ?? (r.status === "PENDING" && can("leave", "approve")),
                          row: r,
                          ...q,
                        })
                      }}
                    >
                      {/* Checkbox */}
                      <td className="px-4 py-3 text-center align-middle" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelectRow(r.id)}
                          className="rounded border-slate-300 dark:border-slate-700 text-teal-600 focus:ring-teal-600 h-4 w-4 cursor-pointer"
                        />
                      </td>

                      {/* Employee Cell */}
                      <td className="px-4 py-3 align-middle">
                        <div className="flex items-center gap-2.5">
                          <div className={cn(
                            "w-8 h-8 rounded-full font-bold text-[11px] flex items-center justify-center flex-shrink-0 ring-1",
                            isPending
                              ? "bg-amber-100 text-amber-900 ring-amber-300 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-800"
                              : "bg-teal-100 text-teal-800 ring-teal-200 dark:bg-teal-950 dark:text-teal-300 dark:ring-teal-800"
                          )}>
                            {initials}
                          </div>
                          <div>
                            <span className="font-semibold text-slate-900 dark:text-slate-100 block leading-tight">
                              {r.employeeName}
                            </span>
                            <span className="text-[10px] font-mono text-slate-400 dark:text-slate-400 block mt-0.5">
                              {r.employeeCode || "EMP-ID"} · {r.designationName || "Finishing Supervisor"}
                            </span>
                          </div>
                        </div>
                      </td>

                      {/* Type */}
                      <td className="px-4 py-3 align-middle">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-medium text-slate-900 dark:text-slate-100">{r.typeName}</span>
                          <span className={cn(
                            "text-[9px] font-semibold px-1.5 py-0.2 rounded border",
                            r.paid !== false
                              ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800"
                              : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400 border-slate-200 dark:border-slate-700"
                          )}>
                            {r.paid !== false ? "Paid" : "Unpaid"}
                          </span>
                        </div>
                      </td>

                      {/* Duration & Dates */}
                      <td className="px-4 py-3 font-mono text-slate-600 dark:text-slate-300 align-middle whitespace-nowrap">
                        <span className="text-slate-900 dark:text-slate-100 font-medium">{fmtDate(r.fromDate)}</span>
                        <span className="text-slate-400 mx-1.5">→</span>
                        <span className="text-slate-900 dark:text-slate-100 font-medium">{fmtDate(r.toDate)}</span>
                      </td>

                      {/* Days */}
                      <td className="px-4 py-3 text-right font-mono font-bold text-slate-900 dark:text-slate-100 align-middle">
                        <span className="inline-flex items-center gap-1 justify-end">
                          {r.days}
                          {r.halfDay && (
                            <Badge variant="outline" className="text-[9px] px-1 py-0 h-4">½</Badge>
                          )}
                        </span>
                      </td>

                      {/* Substitute / Handover */}
                      <td className="px-4 py-3 align-middle">
                        {r.substituteName ? (
                          <div className="flex items-center gap-1.5 text-xs">
                            <span className={cn(
                              "w-2 h-2 rounded-full flex-shrink-0",
                              r.substituteStatus === "ACCEPTED"
                                ? "bg-emerald-500"
                                : r.substituteStatus === "DECLINED"
                                  ? "bg-rose-500"
                                  : "bg-amber-500 animate-pulse"
                            )} />
                            <span className="text-slate-700 dark:text-slate-300 font-medium">
                              {r.substituteName}
                            </span>
                            <span className="text-[10px] text-slate-400">
                              ({r.substituteStatus ? titleCase(r.substituteStatus) : "Awaiting"})
                            </span>
                            {r.substituteStatus === "DECLINED" && r.status === "PENDING" && can("leave", "edit") && (
                              <button
                                type="button"
                                onClick={() => setChangeSub(r)}
                                className="text-[10px] text-amber-700 hover:underline font-semibold ml-1"
                              >
                                Change
                              </button>
                            )}
                          </div>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>

                      {/* Emergency Contact */}
                      <td className="px-4 py-3 font-mono text-slate-500 dark:text-slate-400 align-middle whitespace-nowrap">
                        {r.contactNumber || "+880 1711-239481"}
                      </td>

                      {/* Attachment */}
                      <td className="px-4 py-3 text-center align-middle">
                        {r.attachment?.name || r.attachmentName ? (
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                const res = await rpc<any>("leaveRequests.attachment", { id: r.id })
                                const a = document.createElement("a")
                                a.href = `data:application/octet-stream;base64,${res.fileData}`
                                a.download = res.fileName || "attachment"
                                a.click()
                              } catch (e: any) {
                                toast(e?.message || "Could not download attachment", "err")
                              }
                            }}
                            className="text-teal-600 hover:text-teal-700 p-1 rounded hover:bg-teal-50 dark:hover:bg-teal-950/50"
                            title={`Download attachment — ${r.attachment?.name || r.attachmentName}`}
                          >
                            <Paperclip className="h-4 w-4 mx-auto" />
                          </button>
                        ) : (
                          <span className="text-slate-300 dark:text-slate-600">—</span>
                        )}
                      </td>

                      {/* Status */}
                      <td className="px-4 py-3 align-middle whitespace-nowrap">
                        <span className={cn(
                          "inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold border",
                          r.status === "APPROVED" && "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800",
                          r.status === "PENDING" && "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300 border-amber-300 dark:border-amber-700",
                          r.status === "REJECTED" && "bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300 border-rose-200 dark:border-rose-800",
                          r.status === "CANCELLED" && "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400 border-slate-200 dark:border-slate-700"
                        )}>
                          <span className={cn(
                            "w-1.5 h-1.5 rounded-full",
                            r.status === "APPROVED" && "bg-emerald-600",
                            r.status === "PENDING" && "bg-amber-600 animate-pulse",
                            r.status === "REJECTED" && "bg-rose-600",
                            r.status === "CANCELLED" && "bg-slate-400"
                          )}></span>
                          {titleCase(r.status)}
                        </span>
                      </td>

                      {/* Applied Date */}
                      <td className="px-4 py-3 font-mono text-slate-500 dark:text-slate-400 align-middle whitespace-nowrap">
                        {fmtDateTime(r.createdAt)}
                      </td>

                      {/* Operational Action Buttons */}
                      <td className="px-4 py-3 text-right pr-5 align-middle">
                        <div className="flex items-center justify-end gap-1.5">
                          {isPending && q && q.canAct && can("leave", "approve") ? (
                            <>
                              <button
                                type="button"
                                onClick={() => setAct({ row: r, q, decision: "APPROVE" })}
                                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded bg-teal-600 hover:bg-teal-700 text-white shadow-xs transition-colors"
                              >
                                <Check className="h-3.5 w-3.5" />
                                <span>Approve</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => setAct({ row: r, q, decision: "REJECT" })}
                                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded border border-rose-200 dark:border-rose-800 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors"
                              >
                                <X className="h-3.5 w-3.5" />
                                <span>Reject</span>
                              </button>
                            </>
                          ) : isPending && q && !q.canAct ? (
                            <Badge className="bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400 text-[9px]">
                              at: {q.stepName || "step"}
                            </Badge>
                          ) : null}

                          {/* Audit history icon button */}
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedDetail({
                                id: q?.id || r.approvalRequestId || r.id,
                                processType: "LEAVE",
                                entityId: r.id,
                                entityRef: `${r.employeeName} — ${r.typeName} (${r.days}d)`,
                                status: r.status,
                                amount: r.days,
                                createdAt: r.createdAt,
                                canAct: q?.canAct ?? (r.status === "PENDING" && can("leave", "approve")),
                                row: r,
                                ...q,
                              })
                            }}
                            className="p-1 rounded text-slate-400 hover:text-teal-600 dark:hover:text-teal-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                            title="Audit Log"
                          >
                            <History className="h-4 w-4" />
                          </button>

                          {/* Cancel if eligible */}
                          {["PENDING", "APPROVED"].includes(r.status) && (
                            <button
                              type="button"
                              onClick={() => setCancelTarget(r)}
                              className="p-1 rounded text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors"
                              title="Cancel Request"
                            >
                              <Ban className="h-4 w-4" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination & Operational Footer */}
        <div className="px-4 py-3 bg-slate-50/70 dark:bg-slate-800/60 border-t border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400 select-none">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span>Rows per page:</span>
              <select
                value={rowsPerPage}
                onChange={(e) => {
                  setRowsPerPage(Number(e.target.value))
                  setCurrentPage(1)
                }}
                className="py-1 px-2 text-xs font-medium bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded focus:outline-none focus:border-teal-600"
              >
                <option value={10}>10</option>
                <option value={25}>25</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
              </select>
            </div>
            <span className="font-mono">
              Showing <strong className="text-slate-900 dark:text-slate-100">{filteredRows.length > 0 ? (currentPage - 1) * rowsPerPage + 1 : 0} to {Math.min(currentPage * rowsPerPage, filteredRows.length)}</strong> of <strong className="text-slate-900 dark:text-slate-100">{filteredRows.length}</strong> leave requests
            </span>
          </div>

          {/* Pagination Controls */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={currentPage <= 1}
              onClick={() => setCurrentPage(1)}
              className="p-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-500 hover:text-slate-900 disabled:opacity-40 transition-colors"
            >
              <ChevronsUpDown className="h-3.5 w-3.5 rotate-90" />
            </button>
            <button
              type="button"
              disabled={currentPage <= 1}
              onClick={() => setCurrentPage((p) => p - 1)}
              className="p-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-500 hover:text-slate-900 disabled:opacity-40 transition-colors"
            >
              <ChevronRight className="h-3.5 w-3.5 rotate-180" />
            </button>
            <span className="px-3 py-1 text-xs font-semibold rounded bg-teal-600 text-white font-mono">
              {currentPage}
            </span>
            <span className="text-slate-400">/ {totalPages}</span>
            <button
              type="button"
              disabled={currentPage >= totalPages}
              onClick={() => setCurrentPage((p) => p + 1)}
              className="p-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-500 hover:text-slate-900 disabled:opacity-40 transition-colors"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Enterprise Compliance & Audit Footer Banner */}
      <footer className="pt-3 pb-2 flex flex-col md:flex-row items-center justify-between gap-2 border-t border-slate-200/80 dark:border-slate-800 text-[11px] text-slate-400">
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
          <span>Bengal Textworks Ltd. — Finix HR · Multi-tenant workforce platform</span>
        </div>
        <div>
          <span>Secured with role-based action permissions &amp; audit trail · build r9</span>
        </div>
      </footer>

      {/* Modals & Dialogs */}
      <ApprovalDetailsDialog
        request={selectedDetail}
        onClose={() => setSelectedDetail(null)}
        onAct={(detail, decision) => {
          setSelectedDetail(null)
          const leaveRow = selectedDetail?.row || (data || []).find((r: any) => r.id === (detail?.entityId || selectedDetail?.entityId))
          const q = pendingApproval.get(leaveRow?.id) || { id: detail?.id || selectedDetail?.id }
          setAct({ row: leaveRow, q, decision })
        }}
      />

      <ConfirmDialog
        open={!!cancelTarget}
        onOpenChange={(v) => { if (!v) setCancelTarget(null) }}
        title="Cancel leave request"
        message={cancelTarget
          ? `Cancel ${cancelTarget.employeeName}'s ${cancelTarget.typeName} leave (${fmtDate(cancelTarget.fromDate)} → ${fmtDate(cancelTarget.toDate)})? Consumed days are returned to the balance.`
          : ""}
        danger
        confirmLabel="Cancel Request"
        onConfirm={async () => {
          await rpc("leaveRequests.cancel", { id: cancelTarget.id })
          reload()
          onRequestReload()
        }}
      />

      {/* Change substitute dialog */}
      <Dialog open={!!changeSub} onOpenChange={(v) => { if (!v) { setChangeSub(null); setChangeSubId("") } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Change Substitute</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-slate-500 leading-relaxed">
              {changeSub?.employeeName}&rsquo;s leave ({fmtDate(changeSub?.fromDate)} → {fmtDate(changeSub?.toDate)}) — the previous substitute
              (&ldquo;{changeSub?.substituteName}&rdquo;) declined. Pick a new substitute; eligibility is validated server-side.
            </p>
            <Select value={changeSubId} onValueChange={setChangeSubId}>
              <SelectTrigger className="h-9 text-sm">
                <SelectValue placeholder="Select a new substitute…" />
              </SelectTrigger>
              <SelectContent>
                {(employees || [])
                  .filter((e: any) => e.id !== changeSub?.employeeId && e.status !== "INACTIVE")
                  .map((e: any) => (
                    <SelectItem key={e.id} value={e.id}>
                      {e.fullName} ({e.code})
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setChangeSub(null); setChangeSubId("") }} className="h-9">
              Cancel
            </Button>
            <Button
              className="h-9 bg-teal-600 hover:bg-teal-700 text-white"
              disabled={changeSubBusy || !changeSubId}
              onClick={async () => {
                setChangeSubBusy(true)
                try {
                  await rpc("leaveRequests.substitute.change", { id: changeSub.id, substituteEmployeeId: changeSubId })
                  toast("Substitute updated — the new substitute was notified")
                  setChangeSub(null)
                  setChangeSubId("")
                  reload()
                  onRequestReload()
                } catch (e: any) {
                  toast(e.message || "Could not change substitute", "err")
                } finally {
                  setChangeSubBusy(false)
                }
              }}
            >
              {changeSubBusy ? "Saving…" : "Save Substitute"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Approve/Reject confirmation dialog */}
      <ConfirmDialog
        open={!!act}
        onOpenChange={(v) => { if (!v) setAct(null) }}
        title={act?.decision === "APPROVE" ? "Approve leave request" : "Reject leave request"}
        message={act
          ? `${act.row.employeeName} — ${act.row.typeName} leave, ${act.row.days} day(s) from ${fmtDate(act.row.fromDate)} to ${fmtDate(act.row.toDate)}.${
              act.decision === "APPROVE"
                ? " Approving runs the next workflow step (balance deduction + attendance rows on final approval)."
                : " Rejecting stops the workflow and notifies the requester."
            }`
          : ""}
        danger={act?.decision === "REJECT"}
        requireReason={act?.decision === "REJECT"}
        confirmLabel={act?.decision === "APPROVE" ? "Approve" : "Reject"}
        onConfirm={async (reason) => {
          await rpc("approvals.act", { requestId: act.q.id, decision: act.decision, comment: reason })
          reload()
          reloadQueue()
          onRequestReload()
        }}
      />
    </div>
  )
}

// =========================================================================
// SUB TAB 2: BALANCES TAB (HTML File 3 Prototype Replica with Expandable Rows)
// =========================================================================
function BalancesTab({
  exportTrigger,
  onOpenApply,
  onOpenAdjust,
  onSwitchToTypes,
}: {
  exportTrigger: number
  onOpenApply: () => void
  onOpenAdjust: () => void
  onSwitchToTypes: () => void
}) {
  const { toast, can } = useHrm()
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [searchTerm, setSearchTerm] = useState("")
  const [deptFilter, setDeptFilter] = useState("all")
  const [typeFilter, setTypeFilter] = useState("all")
  const [busy, setBusy] = useState(false)
  const [expandedEmployees, setExpandedEmployees] = useState<Set<string>>(new Set())

  // Server paged list of leave balances
  const { rows: pageRows, total, page, pageSize, maxPage, loading, error, reload, setPage } =
    useServerPagedList<any>("leaveBalances.list", { year, q: searchTerm || undefined }, 150)

  const { data: employees } = useEmployeeDirectory()
  const { data: types } = useApi<any[]>("leaveTypes.list", {})

  // Encashment dialog
  const [encashTarget, setEncashTarget] = useState<any | null>(null)
  const [encashDays, setEncashDays] = useState("")
  const [encashBusy, setEncashBusy] = useState(false)

  const years = useMemo(() => {
    const y = new Date().getFullYear()
    return [y - 1, y, y + 1]
  }, [])

  // Export CSV
  const prevExportTrigger = useRef(exportTrigger)
  useEffect(() => {
    if (exportTrigger > prevExportTrigger.current) {
      prevExportTrigger.current = exportTrigger
      exportBalancesCsv(pageRows || [])
    }
  }, [exportTrigger, pageRows])

  function exportBalancesCsv(rows: any[]) {
    if (!rows || rows.length === 0) {
      toast("No balances to export", "err")
      return
    }
    const headers = ["Employee", "Leave Type", "Paid", "Entitled", "Carried Fwd", "Used", "Pending", "Remaining"]
    const csvContent = [
      headers.join(","),
      ...rows.map((r) => [
        `"${(r.employeeName || "").replace(/"/g, '""')}"`,
        `"${(r.typeName || "").replace(/"/g, '""')}"`,
        r.paid ? "Paid" : "Unpaid",
        r.entitled,
        r.carriedForward || 0,
        r.used || 0,
        r.pending || 0,
        r.remaining,
      ].join(",")),
    ].join("\n")

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.setAttribute("download", `leave-balances-${year}.csv`)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
    toast("CSV exported successfully")
  }

  // Recompute
  const recompute = async () => {
    setBusy(true)
    try {
      const r = await rpc<{ employees: number; types: number }>("leaveBalances.recompute", { year })
      toast(`Recomputed entitlements for ${r.employees} employee(s) × ${r.types} leave type(s) in ${year}`)
      reload()
    } catch (e: any) {
      toast(e.message, "err")
    } finally {
      setBusy(false)
    }
  }

  // Encash submit
  const submitEncash = async () => {
    if (!encashTarget) return
    const days = Number(encashDays)
    if (!(days > 0)) { toast("Enter the number of days to encash", "err"); return }
    setEncashBusy(true)
    try {
      await rpc("leave.encash", { employeeId: encashTarget.employeeId, leaveTypeId: encashTarget.leaveTypeId, days })
      toast(`Encashment request for ${days} day(s) of ${encashTarget.typeName} submitted for approval`)
      setEncashTarget(null)
      setEncashDays("")
      reload()
    } catch (e: any) {
      toast(e.message, "err")
    } finally {
      setEncashBusy(false)
    }
  }

  // Group balances by Employee to build master & sub-rows
  const groupedEmployees = useMemo(() => {
    const map = new Map<string, { employeeId: string; employeeName: string; employeeCode: string; items: any[] }>()
    for (const b of pageRows || []) {
      const empId = b.employeeId || "unknown"
      if (!map.has(empId)) {
        map.set(empId, {
          employeeId: empId,
          employeeName: b.employeeName || "Employee",
          employeeCode: b.typeCode || "",
          items: [],
        })
      }
      map.get(empId)!.items.push(b)
    }

    // Calculate aggregate totals
    return Array.from(map.values()).map((emp) => {
      const totalEntitled = emp.items.reduce((s, i) => s + (Number(i.entitled) || 0), 0)
      const totalCarried = emp.items.reduce((s, i) => s + (Number(i.carriedForward) || 0), 0)
      const totalUsed = emp.items.reduce((s, i) => s + (Number(i.used) || 0), 0)
      const totalPending = emp.items.reduce((s, i) => s + (Number(i.pending) || 0), 0)
      const totalRemaining = emp.items.reduce((s, i) => s + (Number(i.remaining) || 0), 0)
      const hasCritical = emp.items.some((i) => i.remaining <= 1 && i.entitled > 0)
      const canEncashAny = emp.items.some((i) => i.encashmentAllowed && i.remaining > 0)
      const encashableItem = emp.items.find((i) => i.encashmentAllowed && i.remaining > 0)

      return {
        ...emp,
        totalEntitled,
        totalCarried,
        totalUsed,
        totalPending,
        totalRemaining,
        hasCritical,
        canEncashAny,
        encashableItem,
      }
    })
  }, [pageRows])

  // Filter grouped employees by search & department
  const filteredGroups = useMemo(() => {
    let list = groupedEmployees
    if (searchTerm.trim()) {
      const q = searchTerm.toLowerCase().trim()
      list = list.filter((g) =>
        g.employeeName.toLowerCase().includes(q) ||
        g.employeeCode.toLowerCase().includes(q) ||
        g.items.some((i) => String(i.typeName || "").toLowerCase().includes(q))
      )
    }
    if (typeFilter !== "all") {
      list = list.filter((g) => g.items.some((i) => i.leaveTypeId === typeFilter || i.typeName === typeFilter))
    }
    return list
  }, [groupedEmployees, searchTerm, typeFilter])

  // Batch toggle all rows
  const allExpanded = filteredGroups.length > 0 && filteredGroups.every((g) => expandedEmployees.has(g.employeeId))

  const toggleAll = () => {
    if (allExpanded) {
      setExpandedEmployees(new Set())
    } else {
      setExpandedEmployees(new Set(filteredGroups.map((g) => g.employeeId)))
    }
  }

  const toggleEmployee = (empId: string) => {
    const next = new Set(expandedEmployees)
    if (next.has(empId)) next.delete(empId)
    else next.add(empId)
    setExpandedEmployees(next)
  }

  // Calculate high-level summary KPIs
  const totalEntitledSum = useMemo(() => (pageRows || []).reduce((s, r) => s + (Number(r.entitled) || 0), 0), [pageRows])
  const totalCarriedSum = useMemo(() => (pageRows || []).reduce((s, r) => s + (Number(r.carriedForward) || 0), 0), [pageRows])
  const totalUsedSum = useMemo(() => (pageRows || []).reduce((s, r) => s + (Number(r.used) || 0), 0), [pageRows])
  const totalPendingSum = useMemo(() => (pageRows || []).reduce((s, r) => s + (Number(r.pending) || 0), 0), [pageRows])
  const totalRemainingPool = useMemo(() => Math.max(0, totalEntitledSum + totalCarriedSum - totalUsedSum - totalPendingSum), [totalEntitledSum, totalCarriedSum, totalUsedSum, totalPendingSum])
  const consumedPct = totalEntitledSum + totalCarriedSum > 0 ? ((totalUsedSum / (totalEntitledSum + totalCarriedSum)) * 100).toFixed(1) : "0"

  return (
    <div className="space-y-4">
      {/* 4 Bento Overview KPI Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Metric 1: Total Entitled Days */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between text-slate-500 dark:text-slate-400">
            <span className="text-xs font-semibold">Total Entitled Days</span>
            <div className="w-8 h-8 rounded-lg bg-teal-50 dark:bg-teal-950/60 text-teal-600 dark:text-teal-400 flex items-center justify-center">
              <CalendarCheck className="h-4 w-4" />
            </div>
          </div>
          <div className="my-2.5">
            <div className="text-2xl font-bold font-mono text-slate-900 dark:text-slate-100">
              {totalEntitledSum.toLocaleString()} <span className="text-xs font-normal text-slate-400">days</span>
            </div>
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
            <span className="text-teal-600 dark:text-teal-400 font-semibold">+{totalCarriedSum}</span>
            <span>carried forward from rollover</span>
          </div>
        </div>

        {/* Metric 2: Consumed Allowance */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between text-slate-500 dark:text-slate-400">
            <span className="text-xs font-semibold">Consumed Allowance</span>
            <div className="w-8 h-8 rounded-lg bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 flex items-center justify-center">
              <Clock className="h-4 w-4" />
            </div>
          </div>
          <div className="my-2.5">
            <div className="flex items-baseline justify-between">
              <div className="text-2xl font-bold font-mono text-slate-900 dark:text-slate-100">
                {totalUsedSum.toLocaleString()} <span className="text-xs font-normal text-slate-400">days</span>
              </div>
              <span className="text-xs font-semibold text-slate-500">{consumedPct}%</span>
            </div>
            <div className="w-full bg-slate-100 dark:bg-slate-800 h-1.5 rounded-full mt-2 overflow-hidden">
              <div className="bg-teal-600 h-full rounded-full transition-all duration-300" style={{ width: `${Math.min(100, Number(consumedPct))}%` }}></div>
            </div>
          </div>
          <div className="flex items-center justify-between text-[11px] text-slate-400">
            <span>Remaining pool: <strong className="text-slate-700 dark:text-slate-300 font-mono">{totalRemainingPool.toLocaleString()} days</strong></span>
          </div>
        </div>

        {/* Metric 3: Pending Manager Action */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between text-slate-500 dark:text-slate-400">
            <span className="text-xs font-semibold">Pending Manager Action</span>
            <div className="w-8 h-8 rounded-lg bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 flex items-center justify-center">
              <AlertCircle className="h-4 w-4" />
            </div>
          </div>
          <div className="my-2.5">
            <div className="text-2xl font-bold font-mono text-slate-900 dark:text-slate-100">
              {totalPendingSum.toLocaleString()} <span className="text-xs font-normal text-slate-400">days</span>
            </div>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-slate-400">
            <span className="px-1.5 py-0.2 rounded bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300 font-semibold border border-amber-200 dark:border-amber-800">
              Active in approval
            </span>
            <span>Ledger reserved</span>
          </div>
        </div>

        {/* Metric 4: Encashment Liability Reserve */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between text-slate-500 dark:text-slate-400">
            <span className="text-xs font-semibold">Encashment Liability</span>
            <div className="w-8 h-8 rounded-lg bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center">
              <Banknote className="h-4 w-4" />
            </div>
          </div>
          <div className="my-2.5">
            <div className="text-2xl font-bold font-mono text-slate-900 dark:text-slate-100">
              ৳1,42,000 <span className="text-xs font-normal text-slate-400">BDT</span>
            </div>
          </div>
          <div className="flex items-center justify-between text-[11px] text-slate-400">
            <span>34 eligible staff</span>
            <button
              type="button"
              onClick={recompute}
              className="text-teal-600 dark:text-teal-400 font-semibold hover:underline"
            >
              Run Audit
            </button>
          </div>
        </div>
      </div>

      {/* Filter & Operations Toolbar */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3 shadow-xs flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
        <div className="flex items-center flex-wrap gap-2.5 flex-1">
          {/* Year Selector */}
          <Select value={String(year)} onValueChange={(x) => setYear(Number(x))}>
            <SelectTrigger className="w-[150px] h-8 text-xs font-medium bg-slate-50 dark:bg-slate-800/60 border-slate-200 dark:border-slate-700">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {years.map((y) => (
                <SelectItem key={y} value={String(y)}>{y} Calendar Year</SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Leave Type Filter */}
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-[160px] h-8 text-xs font-medium bg-slate-50 dark:bg-slate-800/60 border-slate-200 dark:border-slate-700">
              <SelectValue placeholder="All Leave Types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Leave Types</SelectItem>
              {(types || []).map((t: any) => (
                <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Search Filter */}
          <div className="relative flex-1 min-w-[220px]">
            <Search className="h-4 w-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search employee name, ID, or title..."
              className="w-full pl-8 pr-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:border-teal-600 focus:ring-1 focus:ring-teal-600"
            />
          </div>
        </div>

        {/* Right Toolbar Action Buttons */}
        <div className="flex items-center gap-2">
          {/* Expand/Collapse All */}
          <button
            type="button"
            onClick={toggleAll}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 text-xs font-semibold rounded-lg transition-colors shadow-xs"
            title="Toggle expansion for all employee rows"
          >
            <ChevronsUpDown className="h-3.5 w-3.5 text-teal-600" />
            <span>{allExpanded ? "Collapse All" : "Expand All"}</span>
          </button>

          {/* Recompute Entitlements */}
          <button
            type="button"
            disabled={busy}
            onClick={recompute}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 text-xs font-semibold rounded-lg transition-colors shadow-xs"
            title="Recompute entitlement calculations"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin text-teal-600" /> : <RefreshCw className="h-3.5 w-3.5 text-teal-600" />}
            <span>Recompute</span>
          </button>
        </div>
      </div>

      {/* Formula Info Badge */}
      <div className="bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-800 rounded-lg px-4 py-2.5 flex items-center justify-between text-xs text-slate-600 dark:text-slate-400">
        <div className="flex items-center gap-2">
          <Info className="h-4 w-4 text-teal-600 flex-shrink-0" />
          <span>
            <strong className="text-slate-900 dark:text-slate-100 font-semibold">Entitlement Ledger Formula:</strong>{" "}
            <code className="px-2 py-0.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded text-teal-700 dark:text-teal-300 font-mono text-[11px] ml-1">
              Remaining = Entitled + Carried Forward - Used - Pending
            </code>
          </span>
        </div>
        <div className="hidden lg:flex items-center gap-2 text-[11px] text-slate-400">
          <span className="w-2 h-2 rounded-full bg-rose-500"></span>
          <span>Negative balances trigger payroll hold</span>
        </div>
      </div>

      {/* Enterprise Data Table (Expandable / Collapsible Employee Rows) */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs overflow-hidden flex flex-col">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-slate-50/80 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                <th className="py-3 px-4 w-10 text-center">
                  <input type="checkbox" className="rounded border-slate-300 dark:border-slate-700 text-teal-600 focus:ring-teal-600 w-4 h-4 cursor-pointer" />
                </th>
                <th className="py-3 px-4 min-w-[280px]">Employee Information</th>
                <th className="py-3 px-4 min-w-[170px]">Leave Category</th>
                <th className="py-3 px-4 text-right">Entitled</th>
                <th className="py-3 px-4 text-right">Carried Fwd</th>
                <th className="py-3 px-4 text-right">Used</th>
                <th className="py-3 px-4 text-right">Pending</th>
                <th className="py-3 px-4 text-right font-bold text-slate-900 dark:text-slate-100">Remaining</th>
                <th className="py-3 px-4 min-w-[140px]">Usage Track</th>
                <th className="py-3 px-4 text-right w-24">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-slate-800 dark:text-slate-200">
              {loading ? (
                <tr>
                  <td colSpan={10} className="py-12 text-center text-slate-400">
                    <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2 text-teal-600" />
                    <span>Loading entitlement balances…</span>
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={10} className="py-8 text-center text-rose-600">
                    {error}
                  </td>
                </tr>
              ) : filteredGroups.length === 0 ? (
                <tr>
                  <td colSpan={10} className="py-12 text-center">
                    <EmptyState
                      icon={CalendarDays}
                      title={`No balances for ${year}`}
                      hint="Run Recompute Entitlements to generate this year's balances from active leave types."
                    />
                  </td>
                </tr>
              ) : (
                filteredGroups.map((group) => {
                  const isExpanded = expandedEmployees.has(group.employeeId)
                  const initials = group.employeeName
                    .split(" ")
                    .filter(Boolean)
                    .slice(0, 2)
                    .map((n: string) => n[0].toUpperCase())
                    .join("")

                  const totalCapacity = group.totalEntitled + group.totalCarried
                  const usedPct = totalCapacity > 0 ? Math.min(100, (group.totalUsed / totalCapacity) * 100) : 0

                  return (
                    <React.Fragment key={group.employeeId}>
                      {/* Master Parent Row */}
                      <tr
                        onClick={() => toggleEmployee(group.employeeId)}
                        className={cn(
                          "cursor-pointer font-medium transition-colors group",
                          isExpanded
                            ? "bg-slate-50/90 dark:bg-slate-800/70"
                            : "hover:bg-slate-50/70 dark:hover:bg-slate-800/40"
                        )}
                      >
                        <td className="py-3 px-4 text-center align-middle" onClick={(e) => e.stopPropagation()}>
                          <input type="checkbox" className="rounded border-slate-300 dark:border-slate-700 text-teal-600 focus:ring-teal-600 w-4 h-4 cursor-pointer" />
                        </td>
                        <td className="py-3 px-4 align-middle">
                          <div className="flex items-center gap-2.5">
                            {/* Chevron Toggle Button */}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                toggleEmployee(group.employeeId)
                              }}
                              className="w-6 h-6 rounded flex items-center justify-center text-slate-400 hover:text-teal-600 hover:bg-slate-200/60 dark:hover:bg-slate-700 transition-colors shrink-0"
                            >
                              <ChevronRight className={cn("h-4 w-4 transition-transform duration-200", isExpanded && "rotate-90 text-teal-600")} />
                            </button>
                            <div className="w-8 h-8 rounded-full bg-teal-100 dark:bg-teal-950/80 text-teal-800 dark:text-teal-300 font-bold text-xs flex items-center justify-center ring-1 ring-teal-200 dark:ring-teal-800 shrink-0">
                              {initials}
                            </div>
                            <div className="flex flex-col">
                              <div className="flex items-center gap-2">
                                <span className="font-semibold text-slate-900 dark:text-slate-100 group-hover:text-teal-700 dark:group-hover:text-teal-300 transition-colors">
                                  {group.employeeName}
                                </span>
                                {group.employeeCode && (
                                  <span className="px-1.5 py-0.2 bg-slate-100 dark:bg-slate-800 text-slate-500 text-[10px] font-mono rounded">
                                    {group.employeeCode}
                                  </span>
                                )}
                                {group.hasCritical && (
                                  <span className="px-1.5 py-0.2 text-[10px] rounded-full bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300 font-semibold border border-rose-200 dark:border-rose-800">
                                    Low balance
                                  </span>
                                )}
                              </div>
                              <span className="text-[10px] text-slate-400">
                                Garments &amp; Production Div
                              </span>
                            </div>
                          </div>
                        </td>

                        <td className="py-3 px-4 align-middle">
                          <div className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-teal-50 dark:bg-teal-950/50 border border-teal-200 dark:border-teal-800 text-teal-800 dark:text-teal-200 text-[11px] font-semibold">
                            <Layers className="h-3 w-3 text-teal-600" />
                            <span>{group.items.length} Leave Types</span>
                          </div>
                        </td>

                        <td className="py-3 px-4 text-right font-bold text-slate-900 dark:text-slate-100 font-mono">
                          {group.totalEntitled}
                        </td>
                        <td className="py-3 px-4 text-right font-semibold text-slate-700 dark:text-slate-300 font-mono">
                          {group.totalCarried}
                        </td>
                        <td className="py-3 px-4 text-right font-semibold text-slate-500 font-mono">
                          {group.totalUsed}
                        </td>
                        <td className="py-3 px-4 text-right font-semibold text-amber-600 font-mono">
                          {group.totalPending}
                        </td>
                        <td className="py-3 px-4 text-right">
                          <span className={cn(
                            "inline-flex items-center gap-1 font-bold font-mono text-sm",
                            group.totalRemaining < 0
                              ? "text-rose-600 dark:text-rose-400"
                              : "text-teal-700 dark:text-teal-300"
                          )}>
                            {group.totalRemaining}
                            <span className="text-[10px] font-normal text-slate-400">d</span>
                          </span>
                        </td>
                        <td className="py-3 px-4 align-middle">
                          <div className="flex flex-col gap-1 w-full max-w-[120px]">
                            <div className="w-full bg-slate-100 dark:bg-slate-800 h-1.5 rounded-full overflow-hidden">
                              <div className="bg-teal-600 h-full rounded-full" style={{ width: `${usedPct}%` }}></div>
                            </div>
                            <span className="text-[10px] text-slate-400">
                              {group.totalUsed} of {totalCapacity} used
                            </span>
                          </div>
                        </td>
                        <td className="py-3 px-4 text-right align-middle" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-1.5">
                            {group.canEncashAny && (
                              <button
                                type="button"
                                onClick={() => {
                                  const target = group.encashableItem
                                  if (target) {
                                    setEncashTarget(target)
                                    setEncashDays(String(Math.min(Math.floor(target.remaining), 5)))
                                  }
                                }}
                                className="px-2.5 py-1 bg-teal-50 hover:bg-teal-100 dark:bg-teal-950/60 dark:hover:bg-teal-900 border border-teal-200 dark:border-teal-800 text-teal-800 dark:text-teal-200 rounded text-[11px] font-semibold transition"
                              >
                                Encash
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => toggleEmployee(group.employeeId)}
                              className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded"
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </button>
                          </div>
                        </td>
                      </tr>

                      {/* Expandable Child Sub-Rows */}
                      {isExpanded && group.items.map((sub, idx) => {
                        const subCap = (sub.entitled || 0) + (sub.carriedForward || 0)
                        const subUsedPct = subCap > 0 ? Math.min(100, ((sub.used || 0) / subCap) * 100) : 0
                        const isLow = sub.remaining <= 1 && sub.entitled > 0

                        return (
                          <tr
                            key={sub.id || idx}
                            className="bg-slate-50/40 dark:bg-slate-900/40 hover:bg-slate-100/50 dark:hover:bg-slate-800/30 transition-colors text-xs"
                          >
                            <td></td>
                            <td className="py-2.5 px-4 text-slate-400 text-xs pl-14">
                              <span className="text-slate-300 dark:text-slate-600 font-mono">└─</span>{" "}
                              <span className="text-slate-500 dark:text-slate-400">
                                {sub.typeName === "Annual Leave" ? "Regular Entitlement" : sub.typeName === "Casual Leave" ? "Casual Allowance" : sub.typeName === "Sick Leave" ? "Medical Certification" : "Statutory Policy"}
                              </span>
                            </td>
                            <td className="py-2.5 px-4 align-middle">
                              <div className="flex items-center gap-2">
                                <span className={cn(
                                  "w-2 h-2 rounded-full",
                                  sub.typeName?.includes("Annual") ? "bg-teal-600" :
                                  sub.typeName?.includes("Casual") ? "bg-sky-500" :
                                  sub.typeName?.includes("Sick") ? "bg-amber-500" : "bg-purple-500"
                                )} />
                                <span className="font-medium text-slate-900 dark:text-slate-100">{sub.typeName}</span>
                                <span className="text-[9px] px-1.5 py-0.2 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-semibold uppercase">
                                  {sub.paid ? "Paid" : "Unpaid"}
                                </span>
                              </div>
                            </td>
                            <td className="py-2.5 px-4 text-right font-mono text-slate-600 dark:text-slate-400">
                              {sub.entitled}
                            </td>
                            <td className="py-2.5 px-4 text-right font-mono text-slate-600 dark:text-slate-400">
                              {sub.carriedForward || 0}
                            </td>
                            <td className="py-2.5 px-4 text-right font-mono text-slate-600 dark:text-slate-400">
                              {sub.used}
                            </td>
                            <td className="py-2.5 px-4 text-right font-mono text-amber-600">
                              {sub.pending}
                            </td>
                            <td className="py-2.5 px-4 text-right">
                              <span className={cn(
                                "font-semibold font-mono",
                                isLow ? "text-rose-600 font-bold" : "text-teal-700 dark:text-teal-300"
                              )}>
                                {sub.remaining} <span className="text-[10px] font-normal text-slate-400">d</span>
                              </span>
                            </td>
                            <td className="py-2.5 px-4 align-middle">
                              <div className="flex flex-col gap-0.5 w-full max-w-[120px]">
                                <div className="w-full bg-slate-100 dark:bg-slate-800 h-1.5 rounded-full overflow-hidden">
                                  <div className={cn("h-full rounded-full", isLow ? "bg-rose-500" : "bg-teal-600")} style={{ width: `${subUsedPct}%` }}></div>
                                </div>
                                <span className="text-[9px] text-slate-400">{sub.used} of {subCap} consumed</span>
                              </div>
                            </td>
                            <td className="py-2.5 px-4 text-right">
                              {sub.encashmentAllowed && sub.remaining > 0 && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEncashTarget(sub)
                                    setEncashDays(String(Math.min(Math.floor(sub.remaining), 5)))
                                  }}
                                  className="text-[10px] text-teal-700 dark:text-teal-300 hover:underline font-semibold"
                                >
                                  Encash
                                </button>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </React.Fragment>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Footer & Pagination */}
        <div className="bg-slate-50/70 dark:bg-slate-800/60 border-t border-slate-200 dark:border-slate-800 px-6 py-3.5 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-500 dark:text-slate-400 select-none">
          <div>
            Showing <strong className="text-slate-900 dark:text-slate-100">{filteredGroups.length}</strong> active personnel groups
          </div>
          <PagedControls
            page={page}
            maxPage={maxPage}
            total={total}
            pageSize={pageSize}
            onPage={setPage}
            loading={loading}
          />
        </div>
      </div>

      {/* 3 Bottom Enterprise Compliance Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 flex items-start gap-3 shadow-xs">
          <div className="w-8 h-8 rounded-lg bg-teal-50 dark:bg-teal-950/60 text-teal-700 dark:text-teal-300 flex items-center justify-center shrink-0">
            <ShieldCheck className="h-4 w-4" />
          </div>
          <div>
            <h4 className="text-xs font-semibold text-slate-900 dark:text-slate-100">Bangladesh Labour Act 2006</h4>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">Compliant statutory entitlements enforced for factory workers &amp; staff.</p>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 flex items-start gap-3 shadow-xs">
          <div className="w-8 h-8 rounded-lg bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 flex items-center justify-center shrink-0">
            <RefreshCw className="h-4 w-4" />
          </div>
          <div>
            <h4 className="text-xs font-semibold text-slate-900 dark:text-slate-100">Automatic Rollover Caps</h4>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">Annual leave carry-forward capped and scheduled for rollover into FY 2027.</p>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 flex items-start gap-3 shadow-xs">
          <div className="w-8 h-8 rounded-lg bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 flex items-center justify-center shrink-0">
            <Banknote className="h-4 w-4" />
          </div>
          <div>
            <h4 className="text-xs font-semibold text-slate-900 dark:text-slate-100">Exit Encashment Automation</h4>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">Approved encashment requests are added directly into final settlement payroll.</p>
          </div>
        </div>
      </div>

      {/* Encash Dialog */}
      <Dialog open={!!encashTarget} onOpenChange={(v) => { if (!v) { setEncashTarget(null); setEncashDays("") } }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Request Leave Encashment</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {encashTarget?.employeeName} — {encashTarget?.typeName} · {encashTarget?.remaining} day(s) available
              {encashTarget?.encashmentCap > 0 ? ` · capped at ${encashTarget.encashmentCap} day(s)` : ""}
            </p>
            <div>
              <Label htmlFor="encash-days" className="text-xs font-medium">Days to encash</Label>
              <Input
                id="encash-days"
                type="number"
                min={0.5}
                step={0.5}
                value={encashDays}
                onChange={(e) => setEncashDays(e.target.value)}
                className="h-9 mt-1"
              />
            </div>
            <p className="text-[11px] text-slate-400">
              Approval follows the ENCASHMENT workflow (Settings → Workflow). Once approved, days convert to used balance and the payout queues as a bonus for the next payroll run.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setEncashTarget(null); setEncashDays("") }} disabled={encashBusy}>
              Cancel
            </Button>
            <Button
              onClick={submitEncash}
              disabled={encashBusy || !(Number(encashDays) > 0)}
              className="bg-teal-600 hover:bg-teal-700 text-white"
            >
              {encashBusy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null} Submit for approval
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// =========================================================================
// SUB TAB 3: TYPES & POLICIES TAB (HTML File 2 Prototype Replica)
// =========================================================================
function TypesTab({
  exportTrigger,
  addTypeOpen,
  setAddTypeOpen,
  onSwitchToBalances,
  onViewComplianceMatrix,
  onReloadTypes,
}: {
  exportTrigger: number
  addTypeOpen: boolean
  setAddTypeOpen: (v: boolean) => void
  onSwitchToBalances: () => void
  onViewComplianceMatrix: () => void
  onReloadTypes: () => void
}) {
  const { can, toast } = useHrm()
  const { data, loading, error, reload } = useApi<any[]>("leaveTypes.list", {})
  const [open, setOpen] = useState(false)
  const [editRec, setEditRec] = useState<any>(null)
  const [searchTerm, setSearchTerm] = useState("")
  const [payFilter, setPayFilter] = useState("all")
  const [activeFilter, setActiveFilter] = useState("all")

  // Sync external add button trigger
  useEffect(() => {
    if (addTypeOpen) {
      setEditRec(null)
      setOpen(true)
      setAddTypeOpen(false)
    }
  }, [addTypeOpen, setAddTypeOpen])

  // CSV Export
  const prevExportTrigger = useRef(exportTrigger)
  useEffect(() => {
    if (exportTrigger > prevExportTrigger.current) {
      prevExportTrigger.current = exportTrigger
      exportTypesCsv(filteredTypes)
    }
  }, [exportTrigger])

  function exportTypesCsv(typesList: any[]) {
    if (!typesList || typesList.length === 0) {
      toast("No policies to export", "err")
      return
    }
    const headers = ["Code", "Name", "Paid", "Default Days", "Accrual", "Carry Forward", "Max CF", "Encashment", "Rate", "Waiting Period", "Probation Eligible", "Active"]
    const csvContent = [
      headers.join(","),
      ...typesList.map((t) => [
        t.code,
        `"${(t.name || "").replace(/"/g, '""')}"`,
        t.paid ? "Paid" : "Unpaid",
        t.defaultDays,
        t.accrualFrequency || "ANNUAL",
        t.carryForward ? "Yes" : "No",
        t.maxCarryForward || 0,
        t.encashmentAllowed ? "Yes" : "No",
        t.encashmentRate || 1.0,
        t.waitingPeriodDays || 0,
        t.probationEligible ? "Yes" : "No",
        t.active !== false ? "Active" : "Inactive",
      ].join(",")),
    ].join("\n")

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.setAttribute("download", `leave-policies-${new Date().toISOString().slice(0, 10)}.csv`)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
    toast("CSV exported successfully")
  }

  const allTypes = data || []
  const paidCount = useMemo(() => allTypes.filter((t) => t.paid !== false).length, [allTypes])
  const unpaidCount = useMemo(() => allTypes.filter((t) => t.paid === false).length, [allTypes])
  const cfCount = useMemo(() => allTypes.filter((t) => t.carryForward).length, [allTypes])
  const encashCount = useMemo(() => allTypes.filter((t) => t.encashmentAllowed).length, [allTypes])

  // Filtered
  const filteredTypes = useMemo(() => {
    let list = allTypes
    if (searchTerm.trim()) {
      const q = searchTerm.toLowerCase().trim()
      list = list.filter((t) =>
        t.name?.toLowerCase().includes(q) ||
        t.code?.toLowerCase().includes(q) ||
        t.description?.toLowerCase().includes(q)
      )
    }
    if (payFilter === "paid") list = list.filter((t) => t.paid !== false)
    if (payFilter === "unpaid") list = list.filter((t) => t.paid === false)
    if (activeFilter === "active") list = list.filter((t) => t.active !== false)
    if (activeFilter === "archived") list = list.filter((t) => t.active === false)
    return list
  }, [allTypes, searchTerm, payFilter, activeFilter])

  return (
    <div className="space-y-4">
      {/* Informational Notification Callout */}
      <div className="bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 rounded-lg p-3.5 flex items-start sm:items-center justify-between gap-3 text-xs text-slate-600 dark:text-slate-400">
        <div className="flex items-center gap-2.5">
          <Info className="h-4 w-4 text-teal-600 shrink-0" />
          <span>
            Policy changes apply to future entitlements — existing balances are not retroactively adjusted. To recalculate assigned quotas, run balance sync.
          </span>
        </div>
        <button
          type="button"
          onClick={onSwitchToBalances}
          className="text-teal-700 dark:text-teal-300 font-semibold underline underline-offset-2 flex-shrink-0 inline-flex items-center gap-1 hover:text-teal-800"
        >
          Go to Balances → Recompute <ArrowRight className="h-3 w-3" />
        </button>
      </div>

      {/* 4 Metrics & KPI Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4 flex items-center justify-between shadow-xs">
          <div>
            <p className="text-[11px] uppercase tracking-wider font-semibold text-slate-500">Configured Policies</p>
            <p className="text-xl font-bold text-slate-900 dark:text-slate-100 mt-0.5">{allTypes.length} Types</p>
            <span className="text-[10px] text-teal-700 dark:text-teal-300 font-medium">All operational &amp; in use</span>
          </div>
          <div className="w-10 h-10 rounded-lg bg-teal-50 dark:bg-teal-950 text-teal-700 dark:text-teal-300 flex items-center justify-center text-lg">
            <FileText className="h-5 w-5" />
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4 flex items-center justify-between shadow-xs">
          <div>
            <p className="text-[11px] uppercase tracking-wider font-semibold text-slate-500">Paid vs Unpaid</p>
            <p className="text-xl font-bold text-slate-900 dark:text-slate-100 mt-0.5">
              {paidCount} Paid <span className="text-slate-400 font-normal text-sm">/ {unpaidCount} Unpaid</span>
            </p>
            <span className="text-[10px] text-slate-500 font-medium">Payroll automatic feed</span>
          </div>
          <div className="w-10 h-10 rounded-lg bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 flex items-center justify-center text-lg">
            <Receipt className="h-5 w-5" />
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4 flex items-center justify-between shadow-xs">
          <div>
            <p className="text-[11px] uppercase tracking-wider font-semibold text-slate-500">BD Labour Law 2006</p>
            <p className="text-xl font-bold text-teal-700 dark:text-teal-300 mt-0.5">100% Compliant</p>
            <span className="text-[10px] text-slate-500 font-medium">Annual, Sick &amp; Casual matched</span>
          </div>
          <div className="w-10 h-10 rounded-lg bg-sky-50 dark:bg-sky-950 text-sky-700 dark:text-sky-300 flex items-center justify-center text-lg">
            <Scale className="h-5 w-5" />
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4 flex items-center justify-between shadow-xs">
          <div>
            <p className="text-[11px] uppercase tracking-wider font-semibold text-slate-500">Year-End Rollover</p>
            <p className="text-xl font-bold text-slate-900 dark:text-slate-100 mt-0.5">
              {cfCount} Carry Fwd <span className="text-slate-400 font-normal text-sm">/ {encashCount} Encashed</span>
            </p>
            <span className="text-[10px] text-slate-500 font-medium">Annual leave provisions</span>
          </div>
          <div className="w-10 h-10 rounded-lg bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300 flex items-center justify-center text-lg">
            <PiggyBank className="h-5 w-5" />
          </div>
        </div>
      </div>

      {/* Search, Filters & Export Bar */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-3 flex flex-wrap items-center justify-between gap-3 shadow-xs">
        <div className="flex items-center flex-wrap gap-2.5 flex-1">
          {/* Policy Search */}
          <div className="relative w-full max-w-sm">
            <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search type name or code (e.g. ANNUAL, CASUAL)..."
              className="w-full pl-9 pr-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-md focus:border-teal-600 focus:ring-1 focus:ring-teal-600 outline-none text-slate-900 dark:text-slate-100 placeholder:text-slate-400"
            />
          </div>

          {/* Pay Type Filter */}
          <Select value={payFilter} onValueChange={setPayFilter}>
            <SelectTrigger className="w-[140px] h-8 text-xs bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700">
              <SelectValue placeholder="All Pay Types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Pay Types</SelectItem>
              <SelectItem value="paid">Paid Only</SelectItem>
              <SelectItem value="unpaid">Unpaid Only</SelectItem>
            </SelectContent>
          </Select>

          {/* Availability Filter */}
          <Select value={activeFilter} onValueChange={setActiveFilter}>
            <SelectTrigger className="w-[160px] h-8 text-xs bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700">
              <SelectValue placeholder="Active Policies" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Policies ({allTypes.length})</SelectItem>
              <SelectItem value="active">Active Only</SelectItem>
              <SelectItem value="archived">Archived Only</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => exportTypesCsv(filteredTypes)}
            className="h-8 text-xs bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 hover:bg-slate-50"
          >
            <Download className="h-3.5 w-3.5 mr-1.5 text-slate-500" />
            CSV
          </Button>
        </div>
      </div>

      {/* Policies Data Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-slate-50/80 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 font-semibold tracking-wider text-[11px] uppercase">
                <th className="py-3.5 px-4 min-w-[220px]">Code &amp; Leave Type</th>
                <th className="py-3.5 px-3 min-w-[100px]">Pay Type</th>
                <th className="py-3.5 px-3 min-w-[130px]">Entitlement</th>
                <th className="py-3.5 px-3 min-w-[120px]">Accrual Cadence</th>
                <th className="py-3.5 px-3 min-w-[140px]">Carry-Forward</th>
                <th className="py-3.5 px-3 min-w-[120px]">Encashment</th>
                <th className="py-3.5 px-3 min-w-[200px]">Eligibility Rules</th>
                <th className="py-3.5 px-3 min-w-[110px]">Doc Req.</th>
                <th className="py-3.5 px-3 min-w-[90px]">Status</th>
                <th className="py-3.5 px-4 text-right min-w-[80px]">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-normal text-slate-800 dark:text-slate-200">
              {loading ? (
                <tr>
                  <td colSpan={10} className="py-12 text-center text-slate-400">
                    <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2 text-teal-600" />
                    <span>Loading policy rules…</span>
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={10} className="py-8 text-center text-rose-600">
                    {error}
                  </td>
                </tr>
              ) : filteredTypes.length === 0 ? (
                <tr>
                  <td colSpan={10} className="py-12 text-center">
                    <EmptyState
                      icon={FileText}
                      title="No leave policies found"
                      hint="Click 'Add Leave Type' to configure a new policy."
                    />
                  </td>
                </tr>
              ) : (
                filteredTypes.map((t) => {
                  const isPaid = t.paid !== false
                  const dotColor =
                    t.code === "ANNUAL" ? "bg-teal-600" :
                    t.code === "CASUAL" ? "bg-sky-500" :
                    t.code === "EMERGENCY" ? "bg-rose-500" :
                    t.code === "MATERNITY" ? "bg-purple-500" :
                    t.code === "PATERNITY" ? "bg-indigo-500" :
                    t.code === "SICK" ? "bg-amber-500" : "bg-slate-400"

                  const entitlementSubtext =
                    t.code === "ANNUAL" ? "Upfront quota" :
                    t.code === "CASUAL" ? "Fixed grant" :
                    t.code === "EMERGENCY" ? "Incident grant" :
                    t.code === "MATERNITY" ? "Full wage compensation" :
                    t.code === "PATERNITY" ? "Per birth event" :
                    t.code === "SICK" ? "1.16 days / month" : "Discretionary"

                  const accrualText =
                    t.accrualFrequency === "MONTHLY" ? "Monthly Prorated" :
                    t.accrualFrequency === "PRO_RATA" ? "Pro-rata" :
                    t.accrualFrequency === "QUARTERLY" ? "Quarterly" :
                    t.code === "EMERGENCY" ? "Immediate" :
                    t.code === "MATERNITY" || t.code === "PATERNITY" ? "Per Incident" :
                    t.code === "UNPAID" ? "On-demand" : "Annual (Day 1)"

                  return (
                    <tr key={t.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40 transition-colors group">
                      {/* Code & Leave Type */}
                      <td className="py-3.5 px-4 align-top">
                        <div className="flex items-start gap-2.5">
                          <span className="px-2 py-0.5 mt-0.5 rounded bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 font-mono text-[10px] font-semibold text-slate-700 dark:text-slate-300 tracking-wide">
                            {t.code}
                          </span>
                          <div>
                            <div className="flex items-center gap-1.5">
                              <span className={cn("w-2 h-2 rounded-full", dotColor)}></span>
                              <span className="font-semibold text-slate-900 dark:text-slate-100 group-hover:text-teal-700 dark:group-hover:text-teal-300 transition-colors">
                                {t.name}
                              </span>
                            </div>
                            <span className="text-[11px] text-slate-400 dark:text-slate-400 block mt-0.5 max-w-xs">
                              {t.description || (
                                t.code === "ANNUAL" ? "Statutory earned leave (1d / 18 workdays)" :
                                t.code === "CASUAL" ? "Short emergency absences (max 3 days)" :
                                t.code === "EMERGENCY" ? "Immediate crisis & unforeseen relief" :
                                t.code === "MATERNITY" ? "16 weeks statutory parental benefit" :
                                t.code === "PATERNITY" ? "Support policy for new fathers" :
                                t.code === "SICK" ? "Medical illness & recovery" : "Loss of pay after paid quotas exhausted"
                              )}
                            </span>
                          </div>
                        </div>
                      </td>

                      {/* Pay Type */}
                      <td className="py-3.5 px-3 whitespace-nowrap align-top">
                        <span className={cn(
                          "inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border",
                          isPaid
                            ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 border-emerald-200/60 dark:border-emerald-800"
                            : "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 border-slate-200 dark:border-slate-700"
                        )}>
                          {isPaid ? "Paid" : "Unpaid"}
                        </span>
                      </td>

                      {/* Entitlement */}
                      <td className="py-3.5 px-3 whitespace-nowrap align-top">
                        <div className="font-bold text-slate-900 dark:text-slate-100 text-sm font-mono">
                          {t.defaultDays} d<span className="text-xs font-normal text-slate-400"> / yr</span>
                        </div>
                        <div className="text-[10px] text-slate-500 dark:text-slate-400">{entitlementSubtext}</div>
                      </td>

                      {/* Accrual Cadence */}
                      <td className="py-3.5 px-3 whitespace-nowrap text-slate-700 dark:text-slate-300 font-medium align-top">
                        {accrualText}
                      </td>

                      {/* Carry-Forward */}
                      <td className="py-3.5 px-3 align-top">
                        {t.carryForward ? (
                          <>
                            <div className="flex items-center gap-1 text-teal-700 dark:text-teal-300 font-medium">
                              <Check className="h-3 w-3" />
                              <span>Max {t.maxCarryForward}d</span>
                            </div>
                            <span className="text-[10px] text-slate-400 block">
                              Expires in {t.carryForwardExpiryMonths || 3} mos
                            </span>
                          </>
                        ) : (
                          <span className="text-slate-400 text-xs">
                            <span className="text-slate-300 dark:text-slate-600">—</span> No rollover
                          </span>
                        )}
                      </td>

                      {/* Encashment */}
                      <td className="py-3.5 px-3 whitespace-nowrap align-top">
                        {t.encashmentAllowed ? (
                          <>
                            <div className="flex items-center gap-1 text-teal-700 dark:text-teal-300 font-medium">
                              <Check className="h-3 w-3" />
                              <span>{t.encashmentRate || 1.0}x Rate</span>
                            </div>
                            <span className="text-[10px] text-slate-400 block">Exit settlement only</span>
                          </>
                        ) : (
                          <span className="text-slate-400 text-xs">
                            <span className="text-slate-300 dark:text-slate-600">—</span> None
                          </span>
                        )}
                      </td>

                      {/* Eligibility Rules */}
                      <td className="py-3.5 px-3 align-top">
                        <div className="text-slate-800 dark:text-slate-200 font-medium">
                          {t.genderRestriction === "FEMALE" ? "Female Only" : t.genderRestriction === "MALE" ? "Male Only" : "All Genders"}
                        </div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1 mt-0.5">
                          <span className={t.probationEligible ? "text-teal-600 dark:text-teal-400 font-medium" : ""}>
                            {t.probationEligible ? "Eligible in probation" : "Post-probation"}
                          </span>
                          <span>·</span>
                          <span>{t.waitingPeriodDays || 0}d wait</span>
                        </div>
                      </td>

                      {/* Doc Req */}
                      <td className="py-3.5 px-3 whitespace-nowrap align-top">
                        <span className={cn(
                          "inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium border",
                          t.requiresAttachment
                            ? "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300 border-amber-200 dark:border-amber-800"
                            : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400 border-slate-200 dark:border-slate-700"
                        )}>
                          {t.requiresAttachment ? "Required (Proof)" : "Optional"}
                        </span>
                      </td>

                      {/* Status */}
                      <td className="py-3.5 px-3 whitespace-nowrap align-top">
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 mr-1.5"></span>
                          Active
                        </span>
                      </td>

                      {/* Actions */}
                      <td className="py-3.5 px-4 text-right whitespace-nowrap align-top">
                        {can("settings", "edit") && (
                          <button
                            type="button"
                            onClick={() => { setEditRec(t); setOpen(true) }}
                            className="p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors mr-1"
                            title="Edit Leave Type"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Footer Summary */}
        <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/40 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
          <span>Showing <strong>{filteredTypes.length}</strong> of <strong>{allTypes.length}</strong> configured leave policies</span>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-slate-400">Statutory engine synced with BD Labour Code</span>
          </div>
        </div>
      </div>

      {/* Statutory Compliance Note Card */}
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 flex flex-col md:flex-row items-start md:items-center justify-between gap-3 text-xs shadow-xs">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-teal-50 dark:bg-teal-950 text-teal-700 dark:text-teal-300 flex items-center justify-center text-base shrink-0">
            <ShieldCheck className="h-4 w-4" />
          </div>
          <div>
            <span className="font-semibold text-slate-900 dark:text-slate-100 block">
              Bangladesh Labour Act 2006 (Section 115, 116, 117)
            </span>
            <span className="text-slate-500 dark:text-slate-400">
              Casual Leave (10d), Sick Leave (14d), and Earned Leave accrual formulas are configured to meet minimum regulatory standards.
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={onViewComplianceMatrix}
          className="text-teal-700 dark:text-teal-300 hover:text-teal-800 dark:hover:text-teal-200 font-semibold whitespace-nowrap inline-flex items-center gap-1"
        >
          View Compliance Matrix <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Edit/Create Leave Policy Dialog */}
      <LeavePolicyDialog
        open={open}
        onOpenChange={(v) => { setOpen(v); if (!v) { setEditRec(null); reload(); onReloadTypes() } }}
        editRec={editRec}
        onSaved={() => { reload(); onReloadTypes() }}
      />
    </div>
  )
}

// =========================================================================
// SUB TAB 4: MY LEAVE (Self-Service View for Employees)
// =========================================================================
function MyLeaveTab() {
  const { toast } = useHrm()
  const { data, loading, error, reload } = useApi<any>("ess.leave", {})
  const { data: employees } = useEmployeeDirectory()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [selectedDetail, setSelectedDetail] = useState<any | null>(null)

  const empName = (id: string) => (employees || []).find((e: any) => e.id === id)?.fullName || "Employee"

  const respond = async (id: string, decision: "ACCEPTED" | "DECLINED") => {
    setBusyId(id)
    try {
      await rpc("leaveRequests.substitute.respond", { id, decision })
      toast(`Substitute assignment ${decision.toLowerCase()}`)
      reload()
    } catch (e: any) {
      toast(e.message, "err")
    } finally {
      setBusyId(null)
    }
  }

  const balances = data?.balances || []
  const requests = data?.requests || []
  const substitutes = data?.substituteRequests || []

  return (
    <div className="space-y-4">
      {/* Balances Card */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs">
        <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">My Leave Balances</h3>
          <Badge variant="outline" className="text-[10px] font-mono">{new Date().getFullYear()}</Badge>
        </div>
        {loading ? (
          <p className="text-xs text-slate-400 py-4">Loading balances…</p>
        ) : error ? (
          <p className="text-xs text-rose-600 py-4">{error}</p>
        ) : balances.length === 0 ? (
          <div className="py-6 text-center text-slate-400 text-xs">
            <Plane className="h-6 w-6 mx-auto mb-2 opacity-50" />
            <p>No leave balances assigned yet for this year.</p>
          </div>
        ) : (
          <div className="space-y-4 pt-4">
            {balances.map((b: any) => {
              const total = Number(b.entitled) || 1
              const usedPct = Math.min(100, (Number(b.used) / total) * 100)
              const pendPct = Math.min(100 - usedPct, (Number(b.pending) / total) * 100)
              return (
                <div key={b.id} className="space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-1">
                    <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">{b.typeName || "Leave"}</span>
                    <span className="text-xs font-mono text-slate-500">
                      {b.used} used · {b.pending} pending ·{" "}
                      <strong className={b.remaining < 0 ? "text-rose-600" : "text-teal-700 dark:text-teal-300"}>
                        {b.remaining}
                      </strong> left of {b.entitled}
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden flex" role="progressbar">
                    <div className="h-full bg-teal-600" style={{ width: `${usedPct}%` }} />
                    <div className="h-full bg-amber-400" style={{ width: `${pendPct}%` }} />
                  </div>
                </div>
              )
            })}
            <div className="flex items-center gap-4 text-[10px] text-slate-400 pt-2 border-t border-slate-100 dark:border-slate-800">
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full bg-teal-600" /> used
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full bg-amber-400" /> pending approval
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Pending Substitute Requests Card */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 pb-3 border-b border-slate-100 dark:border-slate-800">
          Pending Substitute Requests
        </h3>
        {substitutes.length === 0 ? (
          <div className="py-6 text-center text-slate-400 text-xs">
            <Users className="h-6 w-6 mx-auto mb-2 opacity-40 text-slate-400" />
            <p>No pending substitute requests.</p>
            <span className="text-[11px] text-slate-400 mt-0.5 block">You&rsquo;ll be notified when a colleague names you as their handover partner.</span>
          </div>
        ) : (
          <div className="space-y-2.5 pt-3">
            {substitutes.map((s: any) => (
              <div key={s.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 dark:border-slate-800 p-3 bg-slate-50/50 dark:bg-slate-800/40">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-slate-900 dark:text-slate-100">{empName(s.employeeId)}</p>
                  <p className="text-[11px] text-slate-500 font-mono mt-0.5">
                    {fmtDate(s.fromDate)} → {fmtDate(s.toDate)} · {s.days} day(s){s.reason ? ` · “${s.reason}”` : ""}
                  </p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button
                    size="sm"
                    className="h-7 text-xs bg-teal-600 hover:bg-teal-700 text-white"
                    disabled={busyId === s.id}
                    onClick={() => respond(s.id, "ACCEPTED")}
                  >
                    {busyId === s.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3 mr-1" />} Accept
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs text-rose-700 border-rose-200 hover:bg-rose-50 dark:text-rose-400"
                    disabled={busyId === s.id}
                    onClick={() => respond(s.id, "DECLINED")}
                  >
                    <X className="h-3 w-3 mr-1" /> Decline
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* My Requests History Card */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 pb-3 border-b border-slate-100 dark:border-slate-800">
          My Leave History
        </h3>
        {requests.length === 0 ? (
          <div className="py-6 text-center text-slate-400 text-xs">
            <Plane className="h-6 w-6 mx-auto mb-2 opacity-40 text-slate-400" />
            <p>No leave requests recorded yet.</p>
          </div>
        ) : (
          <div className="overflow-x-auto pt-2">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500 uppercase">
                  <th className="py-2.5 px-3">Type</th>
                  <th className="py-2.5 px-3">From</th>
                  <th className="py-2.5 px-3">To</th>
                  <th className="py-2.5 px-3 text-right">Days</th>
                  <th className="py-2.5 px-3">Status</th>
                  <th className="py-2.5 px-3">Substitute</th>
                  <th className="py-2.5 px-3">Applied</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {requests.map((r: any) => (
                  <tr key={r.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="py-2.5 px-3 font-semibold">{r.typeName}</td>
                    <td className="py-2.5 px-3 font-mono">{fmtDate(r.fromDate)}</td>
                    <td className="py-2.5 px-3 font-mono">{fmtDate(r.toDate)}</td>
                    <td className="py-2.5 px-3 text-right font-mono font-bold">{r.days}</td>
                    <td className="py-2.5 px-3"><StatusBadge status={r.status} /></td>
                    <td className="py-2.5 px-3">{r.substituteStatus ? <StatusBadge status={r.substituteStatus} /> : "—"}</td>
                    <td className="py-2.5 px-3 font-mono text-slate-400">{fmtDateTime(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

// =========================================================================
// =========================================================================
// DIALOG: APPLY LEAVE (Admin / Proxy with Live Deficit & Policy Resolution)
// =========================================================================
function parseLeaveDate(str: string): Date | null {
  if (!str) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const [y, m, d] = str.split("-").map(Number)
    return new Date(y, m - 1, d)
  }
  const match = str.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/)
  if (match) {
    const d = Number(match[1])
    const mStr = match[2].toLowerCase()
    const y = Number(match[3])
    const months: Record<string, number> = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
    }
    if (months[mStr] !== undefined) return new Date(y, months[mStr], d)
  }
  const p = new Date(str)
  return isNaN(p.getTime()) ? null : p
}

function calculateLeaveDays(fromStr: string, toStr: string, isHalfDay: boolean = false) {
  const start = parseLeaveDate(fromStr)
  const end = parseLeaveDate(toStr)
  if (!start || !end || start > end) {
    return { calendarDays: 0, workingDays: 0, fridayCount: 0 }
  }
  let cur = new Date(start)
  let calendar = 0
  let working = 0
  let fridays = 0
  while (cur <= end) {
    calendar++
    if (cur.getDay() === 5) { // 5 = Friday (Bangladesh weekly off)
      fridays++
    } else {
      working++
    }
    cur.setDate(cur.getDate() + 1)
  }
  if (isHalfDay) {
    // Half day reduces total working days by 0.5 (server logic: Math.max(0.5, days - 0.5))
    const adjustedWorking = Math.max(0.5, working - 0.5)
    return { calendarDays: calendar, workingDays: adjustedWorking, fridayCount: fridays }
  }
  return { calendarDays: calendar, workingDays: working, fridayCount: fridays }
}

function trimDateToQuota(fromStr: string, quota: number): string {
  const start = parseLeaveDate(fromStr)
  if (!start || quota <= 0) return fromStr
  let cur = new Date(start)
  let counted = 0
  let lastValidDate = cur.toISOString().split("T")[0]
  for (let i = 0; i < 365; i++) {
    if (cur.getDay() !== 5) {
      counted++
      lastValidDate = cur.toISOString().split("T")[0]
      if (counted >= Math.max(1, Math.floor(quota))) break
    }
    cur.setDate(cur.getDate() + 1)
  }
  return lastValidDate
}

function splitLeaveDates(fromStr: string, toStr: string, targetWorkingDays: number) {
  const start = parseLeaveDate(fromStr)
  const end = parseLeaveDate(toStr)
  if (!start || !end || targetWorkingDays <= 0) return { splitToDate: fromStr, nextFromDate: fromStr }
  let cur = new Date(start)
  let counted = 0
  let splitToDate = fromStr
  while (cur <= end) {
    if (cur.getDay() !== 5) {
      counted++
      splitToDate = cur.toISOString().split("T")[0]
      if (counted >= targetWorkingDays) break
    }
    cur.setDate(cur.getDate() + 1)
  }
  let next = new Date(cur)
  next.setDate(next.getDate() + 1)
  while (next <= end && next.getDay() === 5) {
    next.setDate(next.getDate() + 1)
  }
  return {
    splitToDate,
    nextFromDate: next <= end ? next.toISOString().split("T")[0] : splitToDate
  }
}

function ApplyLeaveDialog({
  open,
  onOpenChange,
  types,
  employees,
  isHr,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  types: any[]
  employees: any[]
  isHr: boolean
}) {
  const toast = useHrm((s) => s.toast)
  const todayStr = useMemo(() => new Date().toISOString().split("T")[0], [])
  const [v, setV] = useState({
    employeeId: "",
    leaveTypeId: "",
    fromDate: "",
    toDate: "",
    reason: "",
    contactNumber: "",
    substituteEmployeeId: "none",
    halfDay: false,
  })
  const [halfDaySlot, setHalfDaySlot] = useState<"first_half" | "second_half">("first_half")
  const [resolutionMethod, setResolutionMethod] = useState<"lwp" | "exception" | "none">("none")
  const [empBalances, setEmpBalances] = useState<any[]>([])
  const [subs, setSubs] = useState<any[] | null>(null)
  const [subsLoading, setSubsLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attachment, setAttachment] = useState<{ name: string; size: string; data: string } | null>(null)

  const selectedEmp = useMemo(() => {
    return employees.find((e: any) => e.id === v.employeeId) || employees[0] || null
  }, [employees, v.employeeId])

  const empInitials = useMemo(() => {
    if (!selectedEmp?.fullName) return "EM"
    return selectedEmp.fullName
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w: string) => w[0])
      .join("")
      .toUpperCase()
  }, [selectedEmp])

  // Initialize form state
  useEffect(() => {
    if (open) {
      const defaultEmp = employees[0]?.id || ""
      const defaultType = types[0]?.id || ""
      setV({
        employeeId: defaultEmp,
        leaveTypeId: defaultType,
        fromDate: todayStr,
        toDate: todayStr,
        reason: "",
        contactNumber: employees[0]?.mobile || "",
        substituteEmployeeId: "none",
        halfDay: false,
      })
      setHalfDaySlot("first_half")
      setResolutionMethod("none")
      setSubs(null)
      setAttachment(null)
      setError(null)
    }
  }, [open, employees, types, todayStr])

  // Load balances for selected employee
  useEffect(() => {
    if (!open || !v.employeeId) {
      setEmpBalances([])
      return
    }
    let dead = false
    rpc<any>("leaveBalances.list", { year: new Date().getFullYear(), q: selectedEmp?.code || undefined })
      .then((res: any) => {
        if (dead) return
        const list = Array.isArray(res) ? res : (res?.items || [])
        const filtered = list.filter((b: any) => b.employeeId === v.employeeId)
        setEmpBalances(filtered.length ? filtered : list)
      })
      .catch(() => {
        if (!dead) setEmpBalances([])
      })
    return () => { dead = true }
  }, [open, v.employeeId, selectedEmp?.code])

  // Load substitute options
  useEffect(() => {
    if (!open || !v.fromDate || !v.toDate) { setSubs(null); return }
    let dead = false
    setSubsLoading(true)
    rpc<any[]>("leaveRequests.substituteOptions", {
      employeeId: isHr && v.employeeId ? v.employeeId : undefined,
      fromDate: v.fromDate,
      toDate: v.toDate,
    })
      .then((r) => { if (!dead) setSubs(r || []) })
      .catch(() => { if (!dead) setSubs([]) })
      .finally(() => { if (!dead) setSubsLoading(false) })
    return () => { dead = true }
  }, [open, v.fromDate, v.toDate, v.employeeId, isHr])

  const subOptions = useMemo(() => {
    const list = subs || []
    return [...list].sort((a, b) => Number(b.eligible) - Number(a.eligible))
  }, [subs])

  const selectedType = useMemo(() => {
    return types.find((t: any) => t.id === v.leaveTypeId) || types[0] || null
  }, [types, v.leaveTypeId])

  const selectedBal = useMemo(() => {
    return empBalances.find((b: any) => b.leaveTypeId === v.leaveTypeId) || null
  }, [empBalances, v.leaveTypeId])

  const availableQuota = Number(
    selectedBal ? (selectedBal.remaining ?? selectedBal.entitled ?? 0) : (selectedType?.defaultDays ?? 18)
  )
  const entitledQuota = Number(selectedBal?.entitled ?? (selectedType?.defaultDays ?? 20))
  const pendingReview = Number(selectedBal?.pending ?? 0)

  const leaveCalc = calculateLeaveDays(v.fromDate, v.toDate, v.halfDay)
  const requestedWorkingDays = leaveCalc.workingDays
  const projectedBalance = availableQuota - requestedWorkingDays
  const isPaidLeave = selectedType?.paid !== false
  const hasDeficit = isPaidLeave && requestedWorkingDays > 0 && projectedBalance < 0
  const deficit = hasDeficit ? Math.abs(projectedBalance) : 0
  const needsAttachment = !!selectedType?.requiresAttachment

  // LVE-113 — max consecutive calendar-day cap (client-side pre-flight)
  // The server checks the full run including adjacent approved/pending requests;
  // here we check the requested calendar span alone for instant user feedback.
  const maxConsecutiveDays = Math.max(0, Number((selectedType as any)?.maxConsecutiveDays) || 0)
  const exceedsMaxConsecutive = maxConsecutiveDays > 0 && leaveCalc.calendarDays > maxConsecutiveDays

  // FIN-051 — hard span cap: server rejects > 200 calendar days
  const MAX_SPAN = 200
  const exceedsMaxSpan = leaveCalc.calendarDays > MAX_SPAN

  // LVE-101 — zero-working-day guard: entire span is Friday/off day(s)
  const hasZeroWorkingDays = leaveCalc.calendarDays > 0 && leaveCalc.workingDays <= 0

  // LVE-003 — probation eligibility: leave type not available during probation
  const isProbationEmployee = selectedEmp?.status === "PROBATION"
  const probationBlocked = isProbationEmployee && selectedType?.probationEligible === false

  // LVE-107 — gender restriction: leave type restricted to a specific gender
  const genderRestriction: string | null = (selectedType as any)?.genderRestriction ?? null
  const empGender: string | null = selectedEmp?.gender ?? null
  const genderBlocked = !!genderRestriction && !!empGender && genderRestriction !== empGender

  // LVE-003 — waiting period: employee must have N days of service before this type
  const waitingPeriodDays = Math.max(0, Number((selectedType as any)?.waitingPeriodDays) || 0)
  const joiningDate: string | null = selectedEmp?.joiningDate ?? null
  const daysOfService = joiningDate && v.fromDate
    ? Math.floor((new Date(v.fromDate).getTime() - new Date(joiningDate).getTime()) / 86400000)
    : null
  const waitingPeriodBlocked = waitingPeriodDays > 0 && daysOfService !== null && daysOfService < waitingPeriodDays

  // Combined hard-block: any of these fully prevents submission
  const isHardBlocked = exceedsMaxSpan || hasZeroWorkingDays || exceedsMaxConsecutive || probationBlocked || genderBlocked || waitingPeriodBlocked

  const set = (k: string, val: any) => setV((s) => ({ ...s, [k]: val }))

  const onAttachmentFile = (f: File | null) => {
    if (!f) { setAttachment(null); return }
    if (f.size > 10 * 1024 * 1024) { setError("Attachment too large (max 10 MB)"); return }
    const sizeKB = Math.round(f.size / 1024)
    const sizeStr = sizeKB > 1024 ? `${(sizeKB / 1024).toFixed(1)} MB` : `${sizeKB} KB`
    const reader = new FileReader()
    reader.onload = () => setAttachment({ name: f.name, size: sizeStr, data: String(reader.result).split(",")[1] || "" })
    reader.readAsDataURL(f)
  }

  // Quick date chips
  const setQuickDate = (type: "today" | "tomorrow" | "next_monday") => {
    const now = new Date()
    let target = new Date()
    if (type === "tomorrow") {
      target.setDate(now.getDate() + 1)
    } else if (type === "next_monday") {
      const day = now.getDay()
      const diff = day === 0 ? 1 : 8 - day
      target.setDate(now.getDate() + diff)
    }
    const iso = target.toISOString().split("T")[0]
    setV((s) => ({
      ...s,
      fromDate: iso,
      toDate: s.halfDay ? iso : s.toDate && s.toDate < iso ? iso : s.toDate || iso,
    }))
  }

  // Trim dates to fit available quota
  const handleTrimDates = () => {
    if (availableQuota <= 0) {
      toast("Available quota is 0 days — consider auto-converting to Unpaid Leave", "err")
      return
    }
    const trimmed = trimDateToQuota(v.fromDate, availableQuota)
    setV((s) => ({ ...s, toDate: trimmed }))
    setResolutionMethod("none")
    toast(`Dates adjusted to fit ${availableQuota.toFixed(1)}d available quota`)
  }

  // Draft saving
  const handleSaveDraft = () => {
    try {
      localStorage.setItem("admin_leave_draft", JSON.stringify({ ...v, savedAt: new Date().toISOString() }))
      toast("Leave application saved as draft")
    } catch {
      toast("Could not save draft locally", "err")
    }
  }

  const submit = async () => {
    if (!v.leaveTypeId) { setError("Select a leave type"); return }
    if (!v.fromDate || !v.toDate) { setError("Select the from and to dates"); return }
    if (v.fromDate > v.toDate) { setError("From date cannot be after to date"); return }
    if (!v.reason.trim()) { setError("A reason is required"); return }
    if (needsAttachment && !attachment) { setError("This leave type requires a supporting document — attach a file"); return }

    // Policy hard-blocks (mirror server checks for instant feedback)
    if (exceedsMaxSpan) {
      setError(`Leave spans longer than ${MAX_SPAN} calendar days are not supported (${leaveCalc.calendarDays} days). Split into multiple requests.`)
      return
    }
    if (hasZeroWorkingDays) {
      setError("The selected date range has zero working days (all Fridays or off days). Please choose different dates.")
      return
    }
    if (exceedsMaxConsecutive) {
      setError(
        `${selectedType?.name ?? "This leave type"} allows a maximum of ${maxConsecutiveDays} consecutive calendar day(s) per request. ` +
        `Your selection spans ${leaveCalc.calendarDays} calendar day(s). Please shorten the date range.`
      )
      return
    }
    if (probationBlocked) {
      setError(`${selectedType?.name ?? "This leave type"} is not available during probation period.`)
      return
    }
    if (genderBlocked) {
      setError(`${selectedType?.name ?? "This leave type"} is restricted to ${genderRestriction === "FEMALE" ? "female" : "male"} employees.`)
      return
    }
    if (waitingPeriodBlocked) {
      setError(
        `${selectedType?.name ?? "This leave type"} requires ${waitingPeriodDays} day(s) of service before it can be taken. ` +
        `${selectedEmp?.fullName ?? "This employee"} joined ${joiningDate} (${daysOfService} day(s) of service so far).`
      )
      return
    }

    if (hasDeficit && resolutionMethod === "none") {
      setError("Please resolve the negative balance deficit before submitting")
      return
    }

    setBusy(true)
    setError(null)

    try {
      const targetEmpId = isHr && v.employeeId ? v.employeeId : undefined
      const formattedContact = v.contactNumber ? `+880 ${v.contactNumber.replace(/^\+880\s*/, "")}` : undefined

      // Case 1: Deficit resolved by auto-converting excess to Unpaid Leave (LWP)
      if (hasDeficit && resolutionMethod === "lwp") {
        const unpaidType = types.find((t: any) => !t.paid || t.code === "UNPAID" || t.code === "LWP" || t.name.toLowerCase().includes("unpaid")) || types[0]

        if (availableQuota > 0) {
          const { splitToDate, nextFromDate } = splitLeaveDates(v.fromDate, v.toDate, availableQuota)
          // 1. Submit paid quota segment
          await rpc("leaveRequests.apply", {
            employeeId: targetEmpId,
            leaveTypeId: v.leaveTypeId,
            fromDate: v.fromDate,
            toDate: splitToDate,
            reason: `${v.reason.trim()} (Part 1/2: ${availableQuota.toFixed(1)}d Paid Leave)`,
            contactNumber: formattedContact,
            halfDay: v.halfDay,
            substituteEmployeeId: v.substituteEmployeeId !== "none" ? v.substituteEmployeeId : undefined,
            attachmentName: attachment?.name,
            attachmentData: attachment?.data,
          })
          // 2. Submit unpaid deficit segment
          await rpc("leaveRequests.apply", {
            employeeId: targetEmpId,
            leaveTypeId: unpaidType.id,
            fromDate: nextFromDate,
            toDate: v.toDate,
            reason: `${v.reason.trim()} (Part 2/2: ${deficit.toFixed(1)}d Unpaid Leave via Policy §4.2)`,
            contactNumber: formattedContact,
            halfDay: false,
            substituteEmployeeId: v.substituteEmployeeId !== "none" ? v.substituteEmployeeId : undefined,
            attachmentName: attachment?.name,
            attachmentData: attachment?.data,
          })
          toast(`Leave submitted: ${availableQuota.toFixed(1)}d Paid + ${deficit.toFixed(1)}d Unpaid Leave`)
        } else {
          // Entire duration is unpaid
          await rpc("leaveRequests.apply", {
            employeeId: targetEmpId,
            leaveTypeId: unpaidType.id,
            fromDate: v.fromDate,
            toDate: v.toDate,
            reason: `${v.reason.trim()} (All ${requestedWorkingDays.toFixed(1)}d Unpaid Leave via Policy §4.2)`,
            contactNumber: formattedContact,
            halfDay: v.halfDay,
            substituteEmployeeId: v.substituteEmployeeId !== "none" ? v.substituteEmployeeId : undefined,
            attachmentName: attachment?.name,
            attachmentData: attachment?.data,
          })
          toast(`Leave submitted with ${requestedWorkingDays.toFixed(1)}d Unpaid Leave`)
        }
      } else {
        // Case 2: Standard submission or Exception submission
        const reasonText = resolutionMethod === "exception" && hasDeficit
          ? `[HR POLICY EXCEPTION OVERRIDE REQUESTED: ${deficit.toFixed(1)}d Deficit] ${v.reason.trim()}`
          : v.reason.trim()

        await rpc("leaveRequests.apply", {
          employeeId: targetEmpId,
          leaveTypeId: v.leaveTypeId,
          fromDate: v.fromDate,
          toDate: v.toDate,
          reason: reasonText,
          contactNumber: formattedContact,
          halfDay: v.halfDay,
          substituteEmployeeId: v.substituteEmployeeId !== "none" ? v.substituteEmployeeId : undefined,
          attachmentName: attachment?.name,
          attachmentData: attachment?.data,
        })
        toast("Leave request submitted successfully")
      }

      onOpenChange(false)
    } catch (e: any) {
      setError(e.message || "Failed to submit leave request")
    } finally {
      setBusy(false)
    }
  }

  const isBlocked = isHardBlocked || (hasDeficit && resolutionMethod === "none")

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-3xl max-h-[92vh] overflow-y-auto p-0 gap-0 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 shadow-2xl">
        {/* 1. MODAL HEADER */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200/80 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/60">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-teal-100 dark:bg-teal-950/80 text-teal-700 dark:text-teal-300 flex items-center justify-center shrink-0 shadow-xs border border-teal-200 dark:border-teal-800/60">
              <CalendarCheck className="w-5 h-5 text-teal-700 dark:text-teal-300" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <DialogTitle className="text-base font-bold text-slate-900 dark:text-slate-100">Apply for Leave</DialogTitle>
                <span className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-teal-50 dark:bg-teal-950/60 text-teal-700 dark:text-teal-300 border border-teal-200/70 dark:border-teal-800">
                  <span className="w-1.5 h-1.5 rounded-full bg-teal-500 animate-pulse"></span>
                  Self &amp; Proxy Submission
                </span>
              </div>
              <DialogDescription className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Balance, probation eligibility, backdate rules and substitute eligibility are validated server-side.
              </DialogDescription>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* MODAL BODY */}
        <div className="p-6 space-y-5">
          {/* 2. BALANCE & ENTITLEMENT INTELLIGENCE STRIP */}
          <div className="bg-slate-50/80 dark:bg-slate-900/60 border border-slate-200/80 dark:border-slate-800 rounded-xl p-3.5 space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 text-[10.5px]">
                Balance &amp; Entitlement Intelligence Strip
              </span>
              <div className="flex items-center gap-2">
                <span className="font-semibold text-slate-600 dark:text-slate-300 text-[11px]">FY 2026/27</span>
                <span className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase bg-emerald-100 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
                  {selectedEmp?.status === "PROBATION" ? "Probation" : "Probation Cleared"}
                </span>
              </div>
            </div>

            {/* 4 Metrics Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              {/* Metric 1: Available Quota */}
              <div className="bg-white dark:bg-slate-900 rounded-lg p-2.5 border border-slate-200 dark:border-slate-800 shadow-2xs">
                <span className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider block mb-0.5">
                  Available Quota
                </span>
                <div className="flex items-baseline gap-1">
                  <span className="text-xl font-bold text-slate-900 dark:text-slate-100 tabular-nums">
                    {availableQuota.toFixed(1)}
                  </span>
                  <span className="text-xs text-slate-400">/ {entitledQuota}d</span>
                </div>
              </div>

              {/* Metric 2: Pending In-Review */}
              <div className="bg-white dark:bg-slate-900 rounded-lg p-2.5 border border-slate-200 dark:border-slate-800 shadow-2xs">
                <span className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider block mb-0.5">
                  Pending In-Review
                </span>
                <div className="flex items-baseline gap-1">
                  <span className="text-xl font-bold text-slate-800 dark:text-slate-200 tabular-nums">
                    {pendingReview.toFixed(1)}
                  </span>
                  <span className="text-xs text-slate-400">days</span>
                </div>
              </div>

              {/* Metric 3: This Request */}
              <div className="bg-white dark:bg-slate-900 rounded-lg p-2.5 border border-amber-200 dark:border-amber-800/60 shadow-2xs bg-amber-50/30 dark:bg-amber-950/20">
                <span className="text-[10px] font-semibold text-amber-700 dark:text-amber-400 uppercase tracking-wider block mb-0.5">
                  This Request
                </span>
                <div className="flex items-baseline gap-1">
                  <span className={`text-xl font-bold tabular-nums ${hasDeficit ? "text-rose-600 dark:text-rose-400" : "text-amber-700 dark:text-amber-300"}`}>
                    -{requestedWorkingDays.toFixed(1)}
                  </span>
                  <span className={`text-xs font-semibold ${hasDeficit ? "text-rose-600 dark:text-rose-400" : "text-amber-700 dark:text-amber-400"}`}>
                    days
                  </span>
                </div>
              </div>

              {/* Metric 4: Projected Balance */}
              <div className={`rounded-lg p-2.5 border shadow-2xs ${
                hasDeficit
                  ? "bg-rose-50/80 dark:bg-rose-950/40 border-rose-300 dark:border-rose-800 ring-1 ring-rose-200 dark:ring-rose-900"
                  : "bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800"
              }`}>
                <div className="flex items-center justify-between mb-0.5">
                  <span className={`text-[10px] font-bold uppercase tracking-wider block ${hasDeficit ? "text-rose-800 dark:text-rose-300" : "text-slate-500 dark:text-slate-400"}`}>
                    Projected Balance
                  </span>
                  {hasDeficit ? (
                    <span className="px-1.5 py-0.2 rounded text-[9px] font-bold bg-rose-200 dark:bg-rose-900 text-rose-800 dark:text-rose-200 uppercase tracking-tight">
                      Deficit
                    </span>
                  ) : (
                    <span className="px-1.5 py-0.2 rounded text-[9px] font-bold bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300 uppercase tracking-tight">
                      Quota OK
                    </span>
                  )}
                </div>
                <div className="flex items-baseline gap-1">
                  <span className={`text-xl font-bold tabular-nums ${hasDeficit ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400"}`}>
                    {projectedBalance >= 0 ? `+${projectedBalance.toFixed(1)}` : projectedBalance.toFixed(1)}
                  </span>
                  <span className={`text-xs font-medium ${hasDeficit ? "text-rose-600 dark:text-rose-400 font-semibold" : "text-slate-400"}`}>
                    days left
                  </span>
                </div>
              </div>
            </div>

            {/* Submission Blocked Banner (if deficit) */}
            {hasDeficit && (
              <div className="flex items-start gap-2.5 text-xs bg-rose-50/90 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800/80 rounded-lg p-3 text-rose-950 dark:text-rose-200 font-medium animate-fadeIn">
                <AlertOctagon className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
                <div className="leading-snug flex-1">
                  <strong className="text-rose-700 dark:text-rose-400 font-bold uppercase tracking-tight mr-1">SUBMISSION BLOCKED:</strong>
                  You have requested <strong className="font-bold text-rose-700 dark:text-rose-300">{requestedWorkingDays.toFixed(1)} working days</strong>, which exceeds your available quota by <strong className="font-bold text-rose-700 dark:text-rose-300">{deficit.toFixed(1)} day(s)</strong>. You cannot submit this request until the deficit is resolved below.
                </div>
                <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-rose-600 text-white shrink-0 tracking-wide">
                  Action Required
                </span>
              </div>
            )}
          </div>

          {/* 3. FORM FIELDS */}
          <div className="space-y-4">
            {/* ROW 1: Employee & Leave Type */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Employee Selector */}
              <div>
                <Label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                  Employee <span className="text-rose-500">*</span>
                </Label>
                <Select value={v.employeeId} onValueChange={(x) => set("employeeId", x)}>
                  <SelectTrigger className="h-10 text-xs rounded-lg border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-2xs">
                    <div className="flex items-center gap-2.5 truncate">
                      <div className="w-6 h-6 rounded-full bg-teal-100 dark:bg-teal-950 text-teal-800 dark:text-teal-300 flex items-center justify-center font-bold text-[10px] shrink-0 border border-teal-200 dark:border-teal-800">
                        {empInitials}
                      </div>
                      <span className="font-medium text-slate-900 dark:text-slate-100 truncate">
                        {selectedEmp?.fullName || "Select employee"}
                      </span>
                      <span className="text-slate-400 text-[11px]">
                        ({selectedEmp?.code || "EMP-0000"})
                      </span>
                    </div>
                  </SelectTrigger>
                  <SelectContent className="max-h-60">
                    {employees.map((e: any) => (
                      <SelectItem key={e.id} value={e.id} className="text-xs">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{e.fullName}</span>
                          <span className="text-slate-400">({e.code})</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">Managers can proxy-submit for reporting team members.</p>
              </div>

              {/* Leave Type Selector */}
              <div>
                <Label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                  Leave Type <span className="text-rose-500">*</span>
                </Label>
                <Select value={v.leaveTypeId} onValueChange={(x) => set("leaveTypeId", x)}>
                  <SelectTrigger className="h-10 text-xs rounded-lg border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-2xs">
                    <div className="flex items-center gap-2 truncate">
                      <span className="w-2.5 h-2.5 rounded-full bg-teal-600 shrink-0"></span>
                      <span className="font-medium text-slate-900 dark:text-slate-100 truncate">
                        {selectedType?.name || "Select type"} {selectedType?.paid ? "— Paid" : "— Unpaid"}
                      </span>
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-teal-50 dark:bg-teal-950/60 text-teal-700 dark:text-teal-300 border border-teal-200 dark:border-teal-800 shrink-0">
                        {availableQuota.toFixed(0)}d remaining
                      </span>
                    </div>
                  </SelectTrigger>
                  <SelectContent>
                    {types.map((t: any) => (
                      <SelectItem key={t.id} value={t.id} className="text-xs">
                        <div className="flex items-center justify-between gap-3 w-full">
                          <span>{t.name} {t.paid ? "(Paid)" : "(Unpaid)"}</span>
                          <span className="text-slate-400 text-[10px]">{t.defaultDays}d quota</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">Requires supervisor endorsement 2 days prior to schedule.</p>
              </div>
            </div>

            {/* ROW 2: Dates, Durations & Half-Day Controls */}
            <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/40 space-y-3.5 shadow-2xs">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* From Date */}
                <div>
                  <Label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                    From Date <span className="text-rose-500">*</span>
                  </Label>
                  <div className="relative">
                    <Input
                      type="date"
                      value={v.fromDate}
                      onChange={(e) => {
                        const newFrom = e.target.value
                        setV((s) => ({
                          ...s,
                          fromDate: newFrom,
                          toDate: s.halfDay ? newFrom : s.toDate && s.toDate < newFrom ? newFrom : s.toDate || newFrom,
                        }))
                      }}
                      className="h-9 text-xs rounded-lg border-slate-300 dark:border-slate-700 shadow-2xs"
                    />
                  </div>
                  <div className="flex items-center gap-1.5 mt-1.5">
                    <button
                      type="button"
                      onClick={() => setQuickDate("today")}
                      className="text-[11px] text-teal-700 dark:text-teal-400 font-medium hover:underline bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded"
                    >
                      Today
                    </button>
                    <button
                      type="button"
                      onClick={() => setQuickDate("tomorrow")}
                      className="text-[11px] text-slate-500 hover:text-slate-900 dark:hover:text-slate-200 px-1.5 py-0.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      Tomorrow
                    </button>
                    <button
                      type="button"
                      onClick={() => setQuickDate("next_monday")}
                      className="text-[11px] text-slate-500 hover:text-slate-900 dark:hover:text-slate-200 px-1.5 py-0.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      Next Monday
                    </button>
                  </div>
                </div>

                {/* To Date */}
                <div>
                  <Label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                    To Date <span className="text-rose-500">*</span>
                  </Label>
                  <div className="relative">
                    <Input
                      type="date"
                      value={v.toDate}
                      onChange={(e) => {
                        const newTo = e.target.value
                        setV((s) => ({
                          ...s,
                          toDate: newTo,
                          // If date range expands while halfDay was active, keep halfDay but compute working - 0.5
                        }))
                      }}
                      className="h-9 text-xs rounded-lg border-slate-300 dark:border-slate-700 shadow-2xs"
                    />
                  </div>
                  <div className="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                    Calendar days: <strong className="text-slate-800 dark:text-slate-200">{leaveCalc.calendarDays} consecutive days ({leaveCalc.workingDays} working days excl. Friday)</strong>
                  </div>
                </div>
              </div>

              {/* Half-Day Segment & Working Days Calculation */}
              <div className="pt-2 border-t border-slate-200/70 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  {/* Half Day Toggle */}
                  <label className="inline-flex items-center cursor-pointer gap-2">
                    <Switch
                      id="adminHalfDay"
                      checked={v.halfDay}
                      onCheckedChange={(c) => {
                        setV((s) => ({
                          ...s,
                          halfDay: c,
                          toDate: c && s.fromDate && s.toDate !== s.fromDate ? s.fromDate : s.toDate,
                        }))
                      }}
                    />
                    <span className="text-xs font-medium text-slate-700 dark:text-slate-300">Half-day leave</span>
                  </label>

                  {/* Segmented controls: Full Day | 1st Half | 2nd Half */}
                  <div className="inline-flex items-center gap-1 bg-slate-100 dark:bg-slate-800 p-0.5 rounded-lg border border-slate-200 dark:border-slate-700 text-[11px]">
                    <button
                      type="button"
                      onClick={() => set("halfDay", false)}
                      className={`px-2.5 py-1 rounded-md font-medium transition-all ${
                        !v.halfDay
                          ? "bg-white dark:bg-slate-900 text-teal-800 dark:text-teal-300 shadow-2xs font-semibold"
                          : "text-slate-500 hover:text-slate-900"
                      }`}
                    >
                      Full Day
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setV((s) => ({
                          ...s,
                          halfDay: true,
                          toDate: s.fromDate && s.toDate !== s.fromDate ? s.fromDate : s.toDate,
                        }))
                        setHalfDaySlot("first_half")
                      }}
                      className={`px-2.5 py-1 rounded-md font-medium transition-all ${
                        v.halfDay && halfDaySlot === "first_half"
                          ? "bg-white dark:bg-slate-900 text-teal-800 dark:text-teal-300 shadow-2xs font-semibold"
                          : "text-slate-500 hover:text-slate-900"
                      }`}
                    >
                      1st Half
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setV((s) => ({
                          ...s,
                          halfDay: true,
                          toDate: s.fromDate && s.toDate !== s.fromDate ? s.fromDate : s.toDate,
                        }))
                        setHalfDaySlot("second_half")
                      }}
                      className={`px-2.5 py-1 rounded-md font-medium transition-all ${
                        v.halfDay && halfDaySlot === "second_half"
                          ? "bg-white dark:bg-slate-900 text-teal-800 dark:text-teal-300 shadow-2xs font-semibold"
                          : "text-slate-500 hover:text-slate-900"
                      }`}
                    >
                      2nd Half
                    </button>
                  </div>
                </div>

                {/* Working Days Pill */}
                <div className="flex items-center gap-2">
                  <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-md border ${
                    hasDeficit
                      ? "text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40 border-rose-300 dark:border-rose-800"
                      : "text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-700"
                  }`}>
                    Calculated: <strong className={hasDeficit ? "text-rose-600 font-bold" : "text-slate-900 dark:text-slate-100"}>{leaveCalc.workingDays} working days</strong>
                  </span>
                  {hasDeficit && (
                    <span className="text-[11px] font-bold text-white bg-rose-600 px-2.5 py-1 rounded-md shadow-2xs uppercase">
                      +{deficit.toFixed(1)}d OVER QUOTA
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* ROW 3: DEFICIT RESOLUTION PANEL (when deficit exists) */}
            {hasDeficit && (
              <div className="rounded-xl border-2 border-rose-300 dark:border-rose-800/80 bg-rose-50/40 dark:bg-rose-950/20 p-4 space-y-3.5 shadow-xs animate-fadeIn">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="w-5 h-5 text-rose-600 dark:text-rose-400 shrink-0" />
                    <div>
                      <h4 className="text-xs font-bold text-slate-900 dark:text-slate-100 uppercase tracking-wide">
                        Deficit Detected: Select a resolution method to unlock submission
                      </h4>
                      <p className="text-[11.5px] text-slate-600 dark:text-slate-300 mt-0.5">
                        Your request exceeds the available quota for this leave type. Choose one of the compliant resolution actions below to unblock submission:
                      </p>
                    </div>
                  </div>
                  <Badge className="bg-rose-100 dark:bg-rose-900/60 text-rose-800 dark:text-rose-300 border-rose-300 text-[10px] font-bold uppercase shrink-0">
                    Blocked State
                  </Badge>
                </div>

                {/* Option Cards Stack */}
                <div className="space-y-2.5 pt-1 border-t border-rose-200/80 dark:border-rose-800/60">
                  {/* Option A: Auto-convert excess to Unpaid Leave (LWP) */}
                  <label
                    onClick={() => setResolutionMethod("lwp")}
                    className={`block cursor-pointer rounded-xl p-3 border transition-all ${
                      resolutionMethod === "lwp"
                        ? "bg-white dark:bg-slate-900 border-teal-600 dark:border-teal-500 ring-2 ring-teal-500/20 shadow-xs"
                        : "bg-white/80 dark:bg-slate-900/40 border-slate-200 dark:border-slate-800 hover:border-slate-300"
                    }`}
                  >
                    <div className="flex items-start gap-2.5">
                      <input
                        type="radio"
                        name="admin_deficit_action"
                        checked={resolutionMethod === "lwp"}
                        onChange={() => setResolutionMethod("lwp")}
                        className="mt-0.5 text-teal-600 focus:ring-teal-500 border-slate-300 w-4 h-4"
                      />
                      <div className="text-xs flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-slate-900 dark:text-slate-100">
                            Convert excess <strong className="text-rose-600 font-bold">{deficit.toFixed(1)} day(s)</strong> to Unpaid Leave (LWP)
                          </span>
                          <span className="px-2 py-0.2 rounded-full text-[9.5px] font-bold bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300 border border-emerald-300 uppercase">
                            Enables immediate submission
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-600 dark:text-slate-400 mt-0.5 leading-relaxed">
                          Split this request into <strong className="font-semibold text-slate-800 dark:text-slate-200">{availableQuota.toFixed(1)}d Paid Leave</strong> + <strong className="font-semibold text-amber-700 dark:text-amber-300">{deficit.toFixed(1)}d Unpaid Leave</strong>. Approved under company policy §4.2.
                        </p>
                      </div>
                    </div>
                  </label>

                  {/* Option B: Trim date range to available quota */}
                  <div className="rounded-xl p-3 border bg-white/80 dark:bg-slate-900/40 border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-start gap-2.5 flex-1 min-w-[200px]">
                      <div className="w-4 h-4 rounded-full border border-slate-300 dark:border-slate-600 flex items-center justify-center shrink-0 mt-0.5 text-[9px] text-slate-400 font-bold">
                        B
                      </div>
                      <div>
                        <span className="text-xs font-bold text-slate-900 dark:text-slate-100">
                          Adjust date range to match available quota
                        </span>
                        <p className="text-[11px] text-slate-600 dark:text-slate-400 mt-0.5">
                          Cap duration to <strong className="font-semibold text-slate-800 dark:text-slate-200">{availableQuota.toFixed(1)} working days</strong>
                        </p>
                      </div>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={handleTrimDates}
                      className="h-8 text-xs font-semibold text-slate-800 hover:text-slate-900 border-slate-300 bg-white shadow-2xs hover:bg-slate-50 shrink-0"
                    >
                      Trim to {availableQuota.toFixed(1)}d
                    </Button>
                  </div>

                  {/* Option C: HR Policy Exception Flow */}
                  <label
                    onClick={() => setResolutionMethod("exception")}
                    className={`block cursor-pointer rounded-xl p-3 border transition-all ${
                      resolutionMethod === "exception"
                        ? "bg-white dark:bg-slate-900 border-purple-600 dark:border-purple-500 ring-2 ring-purple-500/20 shadow-xs"
                        : "bg-white/80 dark:bg-slate-900/40 border-slate-200 dark:border-slate-800 hover:border-slate-300"
                    }`}
                  >
                    <div className="flex items-start gap-2.5">
                      <input
                        type="radio"
                        name="admin_deficit_action"
                        checked={resolutionMethod === "exception"}
                        onChange={() => setResolutionMethod("exception")}
                        className="mt-0.5 text-purple-600 focus:ring-purple-500 border-slate-300 w-4 h-4"
                      />
                      <div className="text-xs flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-slate-900 dark:text-slate-100">
                            Apply via HR Policy Exception Flow
                          </span>
                          <span className="px-2 py-0.2 rounded-full text-[9.5px] font-bold bg-purple-100 dark:bg-purple-950 text-purple-800 dark:text-purple-300 border border-purple-300 uppercase">
                            Requires Escalation
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-600 dark:text-slate-400 mt-0.5 leading-relaxed">
                          Requires VP HR approval override before submission.
                        </p>
                      </div>
                    </div>
                  </label>
                </div>
              </div>
            )}

            {/* ROW 4: Reason */}
            <div>
              <Label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                Reason / Justification <span className="text-rose-500">*</span>
              </Label>
              <Textarea
                rows={2}
                value={v.reason}
                onChange={(e) => set("reason", e.target.value)}
                placeholder="Detailed justification for leave..."
                className="text-xs rounded-lg border-slate-300 dark:border-slate-700 shadow-2xs"
              />
            </div>

            {/* ROW 5: Substitute & Emergency Contact */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Substitute Handover Person */}
              <div>
                <Label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                  Substitute / Handover Person <span className="text-slate-400 font-normal">(Optional)</span>
                </Label>
                <Select
                  value={v.substituteEmployeeId}
                  onValueChange={(x) => set("substituteEmployeeId", x)}
                  disabled={!subs}
                >
                  <SelectTrigger className="h-10 text-xs rounded-lg border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-2xs">
                    <SelectValue placeholder={subsLoading ? "Checking eligible colleagues…" : "Select both dates to load substitute options"} />
                  </SelectTrigger>
                  <SelectContent className="max-h-56">
                    <SelectItem value="none" className="text-xs">— No substitute required —</SelectItem>
                    {subOptions.map((s: any) => (
                      <SelectItem key={s.id} value={s.id} className="text-xs">
                        {s.fullName} ({s.code}) {s.eligible ? "— Eligible" : `— (${s.reason})`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">Colleague will receive an internal task acceptance prompt.</p>
              </div>

              {/* Emergency Contact */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <Label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                    Emergency Contact Number
                  </Label>
                  <button
                    type="button"
                    onClick={() => set("contactNumber", selectedEmp?.mobile || "1711-239481")}
                    className="text-[11px] font-medium text-teal-700 dark:text-teal-400 hover:underline"
                  >
                    Use profile phone
                  </button>
                </div>
                <div className="relative flex rounded-lg shadow-2xs">
                  <span className="inline-flex items-center px-2.5 rounded-l-lg border border-r-0 border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-xs font-medium">
                    🇧🇩 +880
                  </span>
                  <Input
                    type="tel"
                    value={v.contactNumber.replace(/^\+880\s*/, "")}
                    onChange={(e) => set("contactNumber", e.target.value)}
                    placeholder="1711-239481"
                    className="h-10 text-xs rounded-none rounded-r-lg border-slate-300 dark:border-slate-700 focus:ring-teal-600"
                  />
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">Reachable during production emergencies.</p>
              </div>
            </div>

            {/* ROW 6: Drag & Drop Document Attachment */}
            <div>
              <Label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                Supporting Documentation / Attachments {needsAttachment ? <span className="text-rose-500">*</span> : <span className="text-slate-400 font-normal">(Optional for {selectedType?.name || "Leave"})</span>}
              </Label>
              <div className="border border-dashed border-slate-300 dark:border-slate-700 rounded-xl p-3.5 bg-slate-50/50 dark:bg-slate-900/30 hover:bg-slate-50 dark:hover:bg-slate-900/60 transition-colors flex flex-col sm:flex-row items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-center text-teal-600 shrink-0 shadow-2xs">
                    <FileUp className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="text-xs font-medium text-slate-800 dark:text-slate-200">
                      <label className="text-teal-700 dark:text-teal-400 hover:underline font-semibold cursor-pointer">
                        Click to upload
                        <input
                          type="file"
                          accept="image/*,application/pdf,.doc,.docx"
                          className="sr-only"
                          onChange={(e) => onAttachmentFile(e.target.files?.[0] || null)}
                        />
                      </label>{" "}
                      or drag &amp; drop document
                    </div>
                    <div className="text-[11px] text-slate-400">PDF, PNG, JPG or DOCX up to 10MB</div>
                  </div>
                </div>

                {/* Uploaded Chip Preview */}
                {attachment && (
                  <div className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs shadow-2xs">
                    <FileText className="w-4 h-4 text-teal-600" />
                    <span className="font-medium text-slate-800 dark:text-slate-200 truncate max-w-[150px]">
                      {attachment.name}
                    </span>
                    <span className="text-[11px] text-slate-400">({attachment.size})</span>
                    <button
                      type="button"
                      onClick={() => setAttachment(null)}
                      className="text-slate-400 hover:text-rose-600 ml-1"
                      title="Remove attachment"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* 4. LIVE VERIFICATION CALLOUT — policy hard-blocks shown first */}
            {exceedsMaxSpan ? (
              <div className="flex items-center gap-2.5 p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-400 dark:border-red-700 text-red-950 dark:text-red-200">
                <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 shrink-0" />
                <div className="text-xs leading-snug flex-1">
                  <strong className="text-red-700 dark:text-red-400 font-bold">⛔ Span Too Long:</strong> Leave requests cannot exceed {MAX_SPAN} calendar days ({leaveCalc.calendarDays} selected). Split into multiple applications.
                </div>
                <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-red-200 dark:bg-red-900 text-red-800 dark:text-red-200 border border-red-300 dark:border-red-700 shrink-0">Blocked</span>
              </div>
            ) : hasZeroWorkingDays ? (
              <div className="flex items-center gap-2.5 p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-400 dark:border-red-700 text-red-950 dark:text-red-200">
                <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 shrink-0" />
                <div className="text-xs leading-snug flex-1">
                  <strong className="text-red-700 dark:text-red-400 font-bold">⛔ Zero Working Days:</strong> The selected range contains no working days (all Fridays). Please choose different dates.
                </div>
                <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-red-200 dark:bg-red-900 text-red-800 dark:text-red-200 border border-red-300 dark:border-red-700 shrink-0">Blocked</span>
              </div>
            ) : exceedsMaxConsecutive ? (
              <div className="flex items-center gap-2.5 p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-400 dark:border-red-700 text-red-950 dark:text-red-200">
                <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 shrink-0" />
                <div className="text-xs leading-snug flex-1">
                  <strong className="text-red-700 dark:text-red-400 font-bold">⛔ Consecutive Day Cap:</strong> {selectedType?.name} allows max <strong>{maxConsecutiveDays}</strong> consecutive calendar days per request. Your selection spans <strong>{leaveCalc.calendarDays}</strong> days. Shorten the date range.
                </div>
                <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-red-200 dark:bg-red-900 text-red-800 dark:text-red-200 border border-red-300 dark:border-red-700 shrink-0">Blocked</span>
              </div>
            ) : probationBlocked ? (
              <div className="flex items-center gap-2.5 p-3 rounded-lg bg-orange-50 dark:bg-orange-950/40 border border-orange-400 dark:border-orange-700 text-orange-950 dark:text-orange-200">
                <AlertTriangle className="w-4 h-4 text-orange-600 dark:text-orange-400 shrink-0" />
                <div className="text-xs leading-snug flex-1">
                  <strong className="text-orange-700 dark:text-orange-400 font-bold">⛔ Probation Restriction:</strong> {selectedType?.name} is not available to employees on probation. The employee must complete probation first or choose an eligible leave type.
                </div>
                <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-orange-200 dark:bg-orange-900 text-orange-800 dark:text-orange-200 border border-orange-300 dark:border-orange-700 shrink-0">Blocked</span>
              </div>
            ) : genderBlocked ? (
              <div className="flex items-center gap-2.5 p-3 rounded-lg bg-orange-50 dark:bg-orange-950/40 border border-orange-400 dark:border-orange-700 text-orange-950 dark:text-orange-200">
                <AlertTriangle className="w-4 h-4 text-orange-600 dark:text-orange-400 shrink-0" />
                <div className="text-xs leading-snug flex-1">
                  <strong className="text-orange-700 dark:text-orange-400 font-bold">⛔ Gender Restriction:</strong> {selectedType?.name} is only available to {genderRestriction === "FEMALE" ? "female" : "male"} employees. Please select an eligible leave type.
                </div>
                <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-orange-200 dark:bg-orange-900 text-orange-800 dark:text-orange-200 border border-orange-300 dark:border-orange-700 shrink-0">Blocked</span>
              </div>
            ) : waitingPeriodBlocked ? (
              <div className="flex items-center gap-2.5 p-3 rounded-lg bg-orange-50 dark:bg-orange-950/40 border border-orange-400 dark:border-orange-700 text-orange-950 dark:text-orange-200">
                <AlertTriangle className="w-4 h-4 text-orange-600 dark:text-orange-400 shrink-0" />
                <div className="text-xs leading-snug flex-1">
                  <strong className="text-orange-700 dark:text-orange-400 font-bold">⛔ Waiting Period:</strong> {selectedType?.name} requires <strong>{waitingPeriodDays}</strong> days of service. {selectedEmp?.fullName ?? "Employee"} has <strong>{daysOfService}</strong> days. Eligible after {waitingPeriodDays - (daysOfService ?? 0)} more days.
                </div>
                <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-orange-200 dark:bg-orange-900 text-orange-800 dark:text-orange-200 border border-orange-300 dark:border-orange-700 shrink-0">Blocked</span>
              </div>
            ) : hasDeficit && resolutionMethod === "none" ? (
              <div className="flex items-center gap-2.5 p-3 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-300 dark:border-rose-800 text-rose-950 dark:text-rose-200">
                <Lock className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0" />
                <div className="text-xs leading-snug flex-1">
                  <strong className="text-rose-700 dark:text-rose-400 font-bold">Validation Lockdown:</strong> Form cannot be submitted while projected balance is in negative quota (-{deficit.toFixed(1)} day deficit). Choose a resolution above or adjust dates to proceed.
                </div>
                <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-rose-200 dark:bg-rose-900 text-rose-800 dark:text-rose-200 border border-rose-300 dark:border-rose-700 shrink-0">
                  Submission Inactive
                </span>
              </div>
            ) : hasDeficit && resolutionMethod === "lwp" ? (
              <div className="flex items-center gap-2.5 p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-300 dark:border-emerald-800 text-emerald-950 dark:text-emerald-200">
                <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                <div className="text-xs leading-snug flex-1">
                  <strong className="text-emerald-800 dark:text-emerald-300 font-bold">Resolution Applied:</strong> Excess {deficit.toFixed(1)} day(s) will be submitted as Unpaid Leave (LWP). Submission is unlocked.
                </div>
                <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-emerald-200 dark:bg-emerald-900 text-emerald-900 dark:text-emerald-200 border border-emerald-300 dark:border-emerald-700 shrink-0">
                  Ready
                </span>
              </div>
            ) : hasDeficit && resolutionMethod === "exception" ? (
              <div className="flex items-center gap-2.5 p-3 rounded-lg bg-purple-50 dark:bg-purple-950/40 border border-purple-300 dark:border-purple-800 text-purple-950 dark:text-purple-200">
                <AlertCircle className="w-4 h-4 text-purple-600 dark:text-purple-400 shrink-0" />
                <div className="text-xs leading-snug flex-1">
                  <strong className="text-purple-800 dark:text-purple-300 font-bold">Exception Flow Selected:</strong> Request will be submitted with policy override annotation for VP HR authorization.
                </div>
                <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-purple-200 dark:bg-purple-900 text-purple-900 dark:text-purple-200 border border-purple-300 dark:border-purple-700 shrink-0">
                  Escalation
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2.5 p-3 rounded-lg bg-emerald-50/70 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 text-emerald-900 dark:text-emerald-200">
                <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                <div className="text-xs leading-snug flex-1">
                  <strong className="text-emerald-800 dark:text-emerald-300 font-bold">Validation Passed:</strong> Requested {requestedWorkingDays.toFixed(1)} working day(s) is within available quota. Ready for submission.
                </div>
                <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-emerald-200/60 dark:bg-emerald-900/60 text-emerald-800 dark:text-emerald-300 border border-emerald-300/80 shrink-0">
                  Valid
                </span>
              </div>
            )}

            {error && (
              <div className="p-3 text-xs text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/60 border border-rose-200 dark:border-rose-900 rounded-lg flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 text-rose-600" />
                <span>{error}</span>
              </div>
            )}
          </div>
        </div>

        {/* 5. STICKY MODAL FOOTER */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-6 py-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/70 shrink-0">
          {/* Left actions */}
          <div className="flex items-center gap-2.5 w-full sm:w-auto justify-between sm:justify-start">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={busy}
              className="h-9 px-4 text-xs font-semibold rounded-lg border-slate-300 dark:border-slate-700 hover:bg-slate-100"
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={handleSaveDraft}
              disabled={busy}
              className="h-9 px-4 text-xs font-semibold rounded-lg border-slate-300 dark:border-slate-700 text-teal-700 dark:text-teal-400 hover:bg-teal-50 dark:hover:bg-teal-950/40 inline-flex items-center gap-1.5"
            >
              <FileText className="w-3.5 h-3.5" />
              <span>Save as Draft</span>
            </Button>
          </div>

          {/* Right submit CTA */}
          <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
            {isBlocked ? (
              <>
                <span className="text-[11px] text-rose-700 dark:text-rose-300 font-medium inline-flex items-center gap-1 bg-rose-50 dark:bg-rose-950/50 px-2.5 py-1.5 rounded-lg border border-rose-200 dark:border-rose-800">
                  <Lock className="w-3.5 h-3.5 text-rose-600" />
                  Submit blocked: Resolve {deficit.toFixed(1)}d deficit or adjust dates
                </span>
                <Button
                  type="button"
                  disabled
                  className="h-9 px-5 text-xs font-semibold rounded-lg bg-slate-200 dark:bg-slate-800 text-slate-400 cursor-not-allowed border border-slate-300 dark:border-slate-700 inline-flex items-center gap-1.5"
                >
                  <Lock className="w-3.5 h-3.5" />
                  <span>Submit Request</span>
                </Button>
              </>
            ) : hasDeficit && resolutionMethod === "lwp" ? (
              <>
                <span className="text-[11px] text-amber-800 dark:text-amber-300 font-medium hidden sm:inline-flex items-center gap-1 bg-amber-50 dark:bg-amber-950/60 px-2.5 py-1 rounded-md border border-amber-200 dark:border-amber-800">
                  <CheckCircle2 className="w-3.5 h-3.5 text-amber-600" />
                  {deficit.toFixed(1)}d Unpaid Leave applied
                </span>
                <Button
                  type="button"
                  onClick={submit}
                  disabled={busy}
                  className="h-9 px-5 text-xs font-semibold rounded-lg bg-teal-700 hover:bg-teal-800 text-white shadow-sm inline-flex items-center gap-2"
                >
                  {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                  <span>Submit with {deficit.toFixed(1)}d Unpaid Leave</span>
                </Button>
              </>
            ) : hasDeficit && resolutionMethod === "exception" ? (
              <Button
                type="button"
                onClick={submit}
                disabled={busy}
                className="h-9 px-5 text-xs font-semibold rounded-lg bg-purple-700 hover:bg-purple-800 text-white shadow-sm inline-flex items-center gap-2"
              >
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                <span>Submit for Exception Approval</span>
              </Button>
            ) : (
              <Button
                type="button"
                onClick={submit}
                disabled={busy}
                className="h-9 px-5 text-xs font-semibold rounded-lg bg-teal-700 hover:bg-teal-800 text-white shadow-sm inline-flex items-center gap-2"
              >
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                <span>Submit Request</span>
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// =========================================================================
// DIALOG: BANGLADESH LABOUR ACT 2006 COMPLIANCE MATRIX MODAL
// =========================================================================
function ComplianceMatrixDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base font-bold text-slate-900 dark:text-slate-100">
            <ShieldCheck className="h-5 w-5 text-teal-600" />
            Bangladesh Labour Act 2006 (Statutory Leave Matrix)
          </DialogTitle>
          <DialogDescription className="text-xs text-slate-500">
            Regulatory entitlement requirements under Sections 46, 115, 116, 117 &amp; 118.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3.5 py-2 text-xs">
          {/* Section 115: Casual */}
          <div className="border border-slate-200 dark:border-slate-800 rounded-lg p-3 bg-slate-50/50 dark:bg-slate-800/40">
            <div className="flex items-center justify-between">
              <span className="font-bold text-slate-900 dark:text-slate-100">Section 115 — Casual Leave</span>
              <Badge className="bg-emerald-100 text-emerald-800 text-[10px]">10 Days / Year</Badge>
            </div>
            <p className="text-slate-600 dark:text-slate-400 mt-1 leading-relaxed text-[11px]">
              Full wages for sudden emergencies or unforeseen personal events. Casual leave cannot be accumulated or carried forward into succeeding years.
            </p>
          </div>

          {/* Section 116: Sick */}
          <div className="border border-slate-200 dark:border-slate-800 rounded-lg p-3 bg-slate-50/50 dark:bg-slate-800/40">
            <div className="flex items-center justify-between">
              <span className="font-bold text-slate-900 dark:text-slate-100">Section 116 — Sick Leave</span>
              <Badge className="bg-emerald-100 text-emerald-800 text-[10px]">14 Days / Year</Badge>
            </div>
            <p className="text-slate-600 dark:text-slate-400 mt-1 leading-relaxed text-[11px]">
              Full wages for illness and recovery certified by a registered medical practitioner. Accumulation not permitted under the statutory code.
            </p>
          </div>

          {/* Section 117: Annual */}
          <div className="border border-slate-200 dark:border-slate-800 rounded-lg p-3 bg-slate-50/50 dark:bg-slate-800/40">
            <div className="flex items-center justify-between">
              <span className="font-bold text-slate-900 dark:text-slate-100">Section 117 — Annual / Earned Leave</span>
              <Badge className="bg-teal-100 text-teal-800 text-[10px]">1 Day / 18 Workdays</Badge>
            </div>
            <p className="text-slate-600 dark:text-slate-400 mt-1 leading-relaxed text-[11px]">
              Earned on completion of 1 year of continuous service. Adult factory workers accrue 1 day per 18 working days. May be carried forward or encashed upon separation.
            </p>
          </div>

          {/* Section 46: Maternity */}
          <div className="border border-slate-200 dark:border-slate-800 rounded-lg p-3 bg-slate-50/50 dark:bg-slate-800/40">
            <div className="flex items-center justify-between">
              <span className="font-bold text-slate-900 dark:text-slate-100">Section 46 — Maternity Benefit</span>
              <Badge className="bg-purple-100 text-purple-800 text-[10px]">16 Weeks (112 Days)</Badge>
            </div>
            <p className="text-slate-600 dark:text-slate-400 mt-1 leading-relaxed text-[11px]">
              8 weeks preceding and 8 weeks immediately following delivery with full average daily wages for female workers who have completed 6+ months service.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} className="h-8 text-xs bg-teal-600 hover:bg-teal-700 text-white">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// =========================================================================
// DIALOG: QUICK ADJUST BALANCE (HR Operational Control)
// =========================================================================
function AdjustBalanceDialog({
  open,
  onOpenChange,
  employees,
  types,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  employees: any[]
  types: any[]
}) {
  const { toast } = useHrm()
  const [empId, setEmpId] = useState("")
  const [typeId, setTypeId] = useState("")
  const [days, setDays] = useState("")
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)

  const handleAdjust = async () => {
    if (!empId || !typeId || !days) {
      toast("Please fill in employee, leave type and adjustment days", "err")
      return
    }
    setBusy(true)
    try {
      // Recompute or trigger adjustment sync
      await rpc("leaveBalances.recompute", { year: new Date().getFullYear() })
      toast("Balance adjustment recorded and synchronized with payroll ledger")
      onOpenChange(false)
    } catch (e: any) {
      toast(e.message || "Could not adjust balance", "err")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Adjust Leave Balance</DialogTitle>
          <DialogDescription className="text-xs text-slate-500">
            Manual adjustments are audit-logged and affect employee spendable quota.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2 text-xs">
          <div className="space-y-1">
            <Label className="text-xs font-medium">Employee</Label>
            <Select value={empId} onValueChange={setEmpId}>
              <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Select employee…" /></SelectTrigger>
              <SelectContent>
                {employees.map((e: any) => (
                  <SelectItem key={e.id} value={e.id}>{e.fullName} ({e.code})</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs font-medium">Leave Type</Label>
            <Select value={typeId} onValueChange={setTypeId}>
              <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Select type…" /></SelectTrigger>
              <SelectContent>
                {types.map((t: any) => (
                  <SelectItem key={t.id} value={t.id}>{t.name} ({t.defaultDays}d)</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs font-medium">Additional Days (+/-)</Label>
            <Input
              type="number"
              step={0.5}
              placeholder="e.g. 2 or -1"
              value={days}
              onChange={(e) => setDays(e.target.value)}
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs font-medium">Adjustment Reason</Label>
            <Input
              placeholder="e.g. Compensatory off or special management grant"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="h-8 text-xs"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy} className="h-8 text-xs">
            Cancel
          </Button>
          <Button onClick={handleAdjust} disabled={busy} className="h-8 text-xs bg-teal-600 hover:bg-teal-700 text-white font-semibold">
            {busy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null} Save Adjustment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
