"use client"
// ============ Bonuses & Commission Management Module ============
// Dedicated SaaS workspace separating Bonus Management and Commission Management.
// Tab 1: "Bonus" — Bonus Records, + Create Bonus, Bonus Eligibility Rules & Workforce Auditor, Bulk Approve.
// Tab 2: "Commission" — Commission Payouts, Commission Rule Setup, Calculate Commissions Wizard, Calculation Audit Trail.
import { useState, useMemo, useEffect } from "react"
import {
  Gift, Coins, Plus, CheckCircle2, XCircle, UserCheck,
  Layers, ShieldCheck, Clock, AlertTriangle,
  History, Eye, Pencil, Trash2, Download,
  Calculator, Info, Check,
  Search, Users, ChevronRight, ArrowLeft, Wallet,
} from "lucide-react"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useHrm } from "../store"
import { useApi, rpc, useEmployeeDirectory } from "../api"
import { cn } from "@/lib/utils"
import {
  PageHeader, StatCard, StatusBadge, fmtMoney, fmtDate, fmtDateTime,
  titleCase, SectionCard, KV,
} from "../shared/ui-kit"
import { DataTable, type Column } from "../shared/data-table"
import { ConfirmDialog } from "../shared/form-dialog"
import {
  CommissionCalculateDialog,
  CommissionRuleFormDialog,
  BulkThresholdImportDialog,
  CommissionRuleDetailDialog,
  type CommissionRuleRow,
} from "../shared/commission-rules-dialog"

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]
const monthLabel = (m?: number | null) => (Number(m) >= 1 && Number(m) <= 12 ? MONTHS[Number(m) - 1] : "—")

const BONUS_TYPES = [
  { value: "FESTIVAL", label: "Festival Bonus (Eid / Puja / Xmas)" },
  { value: "PERFORMANCE", label: "Performance Bonus" },
  { value: "ATTENDANCE", label: "Attendance Incentive" },
  { value: "REFERRAL", label: "Employee Referral Bonus" },
  { value: "SPECIAL", label: "Special / Discretionary Bonus" },
  { value: "ENCASHMENT", label: "Leave Encashment" },
]

type BonusMode = "SINGLE" | "ALL_ELIGIBLE" | "CUSTOM"

type BulkBonusResult = {
  mode: string
  requested: number
  created: number
  skipped: number
  errors: number
  results: { employeeId: string; employeeName: string; status: string; amount?: number; detail: string }[]
}

export type BonusBatch = {
  batchKey: string
  batchId?: string
  type: string
  label: string
  periodMonth: number | null
  periodYear: number | null
  calcType: string
  percent: number | null
  baseAmount: number | null
  totalAmount: number
  employeeCount: number
  pendingCount: number
  approvedCount: number
  paidCount: number
  rejectedCount: number
  status: "PENDING" | "APPROVED" | "PARTIAL" | "PAID" | "REJECTED"
  createdAt: string
  createdBy?: string
  items: any[]
}

export function getBonusBatchKey(b: any): string {
  if (b.formula && b.formula.startsWith("BATCH:")) {
    return b.formula.slice(6).split(";")[0]
  }
  const dateStr = b.createdAt ? new Date(b.createdAt).toISOString().slice(0, 10) : ""
  const normLabel = (b.label || "").trim().toLowerCase()
  return `${b.type}_${b.periodYear || 0}_${b.periodMonth || 0}_${normLabel}_${dateStr}`
}

export function groupBonusBatches(rows: any[]): BonusBatch[] {
  const map = new Map<string, BonusBatch>()
  for (const b of rows) {
    const key = getBonusBatchKey(b)
    let batch = map.get(key)
    if (!batch) {
      batch = {
        batchKey: key,
        batchId: b.formula?.startsWith("BATCH:") ? b.formula.slice(6).split(";")[0] : undefined,
        type: b.type,
        label: b.label || (b.type === "SALES_COMMISSION" ? "Sales Commission" : `${titleCase(b.type)} Bonus`),
        periodMonth: b.periodMonth ?? null,
        periodYear: b.periodYear ?? null,
        calcType: b.calcType || "FIXED",
        percent: b.percent ?? null,
        baseAmount: b.baseAmount ?? null,
        totalAmount: 0,
        employeeCount: 0,
        pendingCount: 0,
        approvedCount: 0,
        paidCount: 0,
        rejectedCount: 0,
        status: "PENDING",
        createdAt: b.createdAt,
        createdBy: b.createdBy,
        items: [],
      }
      map.set(key, batch)
    }
    batch.totalAmount += Number(b.amount || 0)
    batch.employeeCount++
    if (b.status === "PENDING") batch.pendingCount++
    else if (b.status === "APPROVED" || b.status === "IN_PAYROLL") batch.approvedCount++
    else if (b.status === "PAID") batch.paidCount++
    else if (b.status === "REJECTED") batch.rejectedCount++
    batch.items.push(b)
  }

  return Array.from(map.values()).map((batch) => {
    let status: "PENDING" | "APPROVED" | "PARTIAL" | "PAID" | "REJECTED" = "PENDING"
    if (batch.paidCount === batch.employeeCount && batch.employeeCount > 0) status = "PAID"
    else if (batch.approvedCount === batch.employeeCount && batch.employeeCount > 0) status = "APPROVED"
    else if (batch.rejectedCount === batch.employeeCount && batch.employeeCount > 0) status = "REJECTED"
    else if (batch.pendingCount > 0 && (batch.approvedCount > 0 || batch.paidCount > 0)) status = "PARTIAL"
    else if (batch.approvedCount > 0) status = "APPROVED"
    else if (batch.pendingCount > 0) status = "PENDING"
    return { ...batch, status }
  })
}

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "px-2.5 py-1 rounded-full text-xs font-medium transition-colors border",
        active
          ? "bg-primary text-primary-foreground border-primary shadow-xs"
          : "bg-card text-muted-foreground border-slate-200 dark:border-slate-800 hover:text-foreground"
      )}
    >
      {label}
    </button>
  )
}

/** Evaluates an employee against the configured bonus policy rules */
function evaluateBonusEligibility(emp: any, policy: any): { eligible: boolean; tenureMonths: number; reason: string } {
  const joining = emp.joiningDate ? new Date(emp.joiningDate) : null
  const now = new Date()
  let tenureMonths = 0
  if (joining && !isNaN(joining.getTime())) {
    const diffTime = Math.max(0, now.getTime() - joining.getTime())
    tenureMonths = Math.round((diffTime / (1000 * 60 * 60 * 24 * 30.4375)) * 10) / 10
  }

  // 1. Notice Period check
  if (policy?.autoExcludeNoticePeriod && emp.status === "NOTICE_PERIOD") {
    return { eligible: false, tenureMonths, reason: "Excluded: Employee is currently serving notice period" }
  }

  // 2. Allowed status check
  const status = emp.status || "ACTIVE"
  if (status === "PROBATION" && !policy?.allowProbation) {
    return { eligible: false, tenureMonths, reason: "Ineligible: Probationary employees are excluded by policy" }
  }
  if (emp.employmentType === "CONTRACTUAL" && !policy?.allowContract) {
    return { eligible: false, tenureMonths, reason: "Ineligible: Contractual employees are excluded by policy" }
  }
  if (!["ACTIVE", "PROBATION"].includes(status)) {
    return { eligible: false, tenureMonths, reason: `Ineligible: Status is ${status}` }
  }

  // 3. Service duration check
  const minMonths = Number(policy?.minServiceMonths) || 6
  if (tenureMonths < minMonths) {
    return {
      eligible: false,
      tenureMonths,
      reason: `Ineligible: Service duration is ${tenureMonths} mo(s) (requires min ${minMonths} months)`,
    }
  }

  return {
    eligible: true,
    tenureMonths,
    reason: `Meets service threshold (${tenureMonths} mo(s) ≥ ${minMonths} months)`,
  }
}

export default function BonusesView() {
  const { can, view } = useHrm()
  const toast = useHrm((s) => s.toast)
  const settings = useHrm((s) => s.settings)

  // Primary tab: "bonus" vs "commission"
  const defaultTab = view?.params?.tab === "commission" || view?.params?.tab === "commission-rules" ? "commission" : "bonus"
  const [activeMainTab, setActiveMainTab] = useState<string>(defaultTab)

  // Commission inner tab: "payouts" | "rules" | "calculate" | "audit"
  const defaultCommTab = view?.params?.tab === "commission-rules" ? "rules" : view?.params?.tab === "calculate" ? "calculate" : "payouts"
  const [activeCommTab, setActiveCommTab] = useState<string>(defaultCommTab)

  // Filters
  const [bonusStatusFilter, setBonusStatusFilter] = useState("")
  const [bonusTypeFilter, setBonusTypeFilter] = useState("ALL")
  const [commStatusFilter, setCommStatusFilter] = useState("")

  // Data queries
  const { data: allBonuses, loading: bonusesLoading, error: bonusesError, reload: reloadBonuses } =
    useApi<any[]>("bonuses.list", {})
  const { data: rules, loading: rulesLoading, error: rulesError, reload: reloadRules } =
    useApi<CommissionRuleRow[]>("commissionRules.list", {})
  const { data: calcLogs, loading: logsLoading, error: logsError, reload: reloadLogs } =
    useApi<any[]>("commissionRules.logs", {})
  const { data: employees } = useEmployeeDirectory()

  // Dialog states
  const [eligibilityOpen, setEligibilityOpen] = useState(false)
  const [createBonusOpen, setCreateBonusOpen] = useState(false)
  const [bulkBonusApproveOpen, setBulkBonusApproveOpen] = useState(false)
  const [bulkCommApproveOpen, setBulkCommApproveOpen] = useState(false)
  const [actBonus, setActBonus] = useState<any>(null)

  // Commission dialog states
  const [calcCommissionOpen, setCalcCommissionOpen] = useState(false)
  const [newRuleOpen, setNewRuleOpen] = useState(false)
  const [editRule, setEditRule] = useState<CommissionRuleRow | null>(null)
  const [importRule, setImportRule] = useState<CommissionRuleRow | null>(null)
  const [delRule, setDelRule] = useState<CommissionRuleRow | null>(null)
  const [selectedRuleDetail, setSelectedRuleDetail] = useState<CommissionRuleRow | null>(null)

  // Batch & Detail Selection State (Runs UX)
  const [selectedBonusBatchKey, setSelectedBonusBatchKey] = useState<string | null>(null)
  const [selectedCommBatchKey, setSelectedCommBatchKey] = useState<string | null>(null)
  const [bonusViewMode, setBonusViewMode] = useState<"runs" | "all">("runs")
  const [commViewMode, setCommViewMode] = useState<"runs" | "all">("runs")
  const [selectedBonusDetail, setSelectedBonusDetail] = useState<any | null>(null)
  const [selectedCommDetail, setSelectedCommDetail] = useState<any | null>(null)
  const [actBatch, setActBatch] = useState<{ batch: BonusBatch; decision: "APPROVE" | "REJECT" } | null>(null)

  // Policy from settings
  const bonusPolicy = (settings as any)?.bonusPolicy || {
    minServiceMonths: 6,
    minServiceDays: 180,
    allowProbation: false,
    allowContract: true,
    festivalBasis: "BASIC",
    festivalPercent: 100,
    festivalsPerYear: 2,
    prorateFirstYear: true,
    performanceBasis: "BASIC",
    autoExcludeNoticePeriod: true,
  }

  // Split bonuses vs commissions
  const bonusRows = useMemo(
    () => (allBonuses || []).filter((b: any) => b.type !== "SALES_COMMISSION"),
    [allBonuses]
  )
  const commissionRows = useMemo(
    () => (allBonuses || []).filter((b: any) => b.type === "SALES_COMMISSION"),
    [allBonuses]
  )

  // Filtered bonus rows
  const filteredBonusRows = useMemo(() => {
    return bonusRows.filter((b: any) => {
      if (bonusStatusFilter && b.status !== bonusStatusFilter) return false
      if (bonusTypeFilter !== "ALL" && b.type !== bonusTypeFilter) return false
      return true
    })
  }, [bonusRows, bonusStatusFilter, bonusTypeFilter])

  // Filtered commission rows
  const filteredCommissionRows = useMemo(() => {
    return commissionRows.filter((b: any) => {
      if (commStatusFilter && b.status !== commStatusFilter) return false
      return true
    })
  }, [commissionRows, commStatusFilter])

  // Batches
  const bonusBatches = useMemo(
    () => groupBonusBatches(filteredBonusRows),
    [filteredBonusRows]
  )
  const commBatches = useMemo(
    () => groupBonusBatches(filteredCommissionRows),
    [filteredCommissionRows]
  )

  const selectedBonusBatch = useMemo(() => {
    if (!selectedBonusBatchKey) return null
    return bonusBatches.find(
      (b) => b.batchKey === selectedBonusBatchKey || b.batchId === selectedBonusBatchKey
    ) || null
  }, [bonusBatches, selectedBonusBatchKey])

  const selectedCommBatch = useMemo(() => {
    if (!selectedCommBatchKey) return null
    return commBatches.find(
      (b) => b.batchKey === selectedCommBatchKey || b.batchId === selectedCommBatchKey
    ) || null
  }, [commBatches, selectedCommBatchKey])

  // Actionable pending items
  const actionableBonuses = useMemo(
    () => bonusRows.filter((b: any) => b.status === "PENDING" && !b.escalated),
    [bonusRows]
  )
  const actionableCommissions = useMemo(
    () => commissionRows.filter((b: any) => b.status === "PENDING" && !b.escalated),
    [commissionRows]
  )

  // Stats for Bonuses
  const bonusTotalDisbursed = useMemo(
    () => bonusRows.filter((b: any) => b.status === "APPROVED" || b.status === "IN_PAYROLL" || b.status === "PAID").reduce((s, b) => s + (Number(b.amount) || 0), 0),
    [bonusRows]
  )
  const bonusPendingAmount = useMemo(
    () => bonusRows.filter((b: any) => b.status === "PENDING").reduce((s, b) => s + (Number(b.amount) || 0), 0),
    [bonusRows]
  )
  const bonusApprovedAmount = useMemo(
    () => bonusRows.filter((b: any) => b.status === "APPROVED" || b.status === "IN_PAYROLL").reduce((s, b) => s + (Number(b.amount) || 0), 0),
    [bonusRows]
  )

  // Evaluated employees
  const evaluatedEmployees = useMemo(() => {
    return (employees || []).map((e: any) => ({
      ...e,
      eval: evaluateBonusEligibility(e, bonusPolicy),
    }))
  }, [employees, bonusPolicy])

  const eligibleEmployeesCount = useMemo(
    () => evaluatedEmployees.filter((e) => e.eval.eligible).length,
    [evaluatedEmployees]
  )

  // Stats for Commissions
  const commTotalDisbursed = useMemo(
    () => commissionRows.filter((b: any) => b.status === "APPROVED" || b.status === "IN_PAYROLL" || b.status === "PAID").reduce((s, b) => s + (Number(b.amount) || 0), 0),
    [commissionRows]
  )
  const commPendingAmount = useMemo(
    () => commissionRows.filter((b: any) => b.status === "PENDING").reduce((s, b) => s + (Number(b.amount) || 0), 0),
    [commissionRows]
  )
  const activeRulesCount = useMemo(
    () => (rules || []).filter((r) => r.active && r.status === "ACTIVE").length,
    [rules]
  )

  const empOpts = useMemo(
    () => (employees || []).map((e: any) => ({ value: e.id, label: `${e.fullName} (${e.code || "EMP"})` })),
    [employees]
  )

  // Table Columns: Bonus Batches / Runs Summary
  const bonusBatchColumns: Column<BonusBatch>[] = [
    {
      key: "period",
      label: "Bonus Run / Period",
      sortValue: (b) => `${b.periodYear || 0}-${String(b.periodMonth || 0).padStart(2, "0")}_${b.label}`,
      render: (b) => (
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">{b.label}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            {b.periodMonth ? `${monthLabel(b.periodMonth)} ${b.periodYear}` : "Discretionary Run"} · {b.employeeCount} {b.employeeCount === 1 ? "Employee" : "Employees"}
          </p>
        </div>
      ),
    },
    {
      key: "type",
      label: "Type",
      sortValue: (b) => b.type,
      render: (b) => (
        <Badge variant="outline" className="text-[11px] font-medium border-slate-200 dark:border-slate-700">
          {titleCase(b.type)}
        </Badge>
      ),
    },
    {
      key: "calc",
      label: "Basis / Calculation",
      render: (b) => (
        <span className="text-xs text-slate-600 dark:text-slate-300">
          {b.calcType === "PERCENT"
            ? `${b.percent}% of ${b.baseAmount ? `৳${Number(b.baseAmount).toLocaleString()}` : "Salary"}`
            : "Fixed Amount"}
        </span>
      ),
    },
    {
      key: "employees",
      label: "Workforce",
      align: "right",
      sortValue: (b) => b.employeeCount,
      render: (b) => (
        <div className="text-right">
          <span className="text-xs font-semibold tabular-nums text-slate-700 dark:text-slate-200 flex items-center justify-end gap-1">
            <Users className="h-3 w-3 text-slate-400" /> {b.employeeCount}
          </span>
          {b.pendingCount > 0 && (
            <span className="text-[10px] text-amber-600 font-medium block">
              {b.pendingCount} pending
            </span>
          )}
        </div>
      ),
    },
    {
      key: "totalAmount",
      label: "Total Amount",
      align: "right",
      sortValue: (b) => b.totalAmount,
      render: (b) => (
        <span className="text-sm font-bold tabular-nums text-slate-800 dark:text-slate-100">
          {fmtMoney(b.totalAmount)}
        </span>
      ),
    },
    {
      key: "status",
      label: "Status",
      render: (b) => <StatusBadge status={b.status} />,
    },
    {
      key: "createdAt",
      label: "Created",
      sortValue: (b) => b.createdAt || "",
      render: (b) => (
        <span className="text-xs text-slate-500 tabular-nums">
          {fmtDate(b.createdAt)}
        </span>
      ),
    },
    {
      key: "actions",
      label: "",
      align: "right",
      render: (b) => (
        <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
          {b.pendingCount > 0 && can("bonus", "approve") && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-400"
              onClick={() => setActBatch({ batch: b, decision: "APPROVE" })}
            >
              <CheckCircle2 className="h-3.5 w-3.5 mr-1 text-emerald-600" />
              Approve Batch
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs text-slate-600 hover:text-slate-900"
            onClick={() => setSelectedBonusBatchKey(b.batchKey)}
          >
            <span>View</span>
            <ChevronRight className="h-3.5 w-3.5 ml-1" />
          </Button>
        </div>
      ),
    },
  ]

  // Table Columns: Commission Batches / Runs Summary
  const commBatchColumns: Column<BonusBatch>[] = [
    {
      key: "period",
      label: "Commission Run / Period",
      sortValue: (b) => `${b.periodYear || 0}-${String(b.periodMonth || 0).padStart(2, "0")}_${b.label}`,
      render: (b) => (
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">{b.label}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            {b.periodMonth ? `${monthLabel(b.periodMonth)} ${b.periodYear}` : "Sales Commission Run"} · {b.employeeCount} {b.employeeCount === 1 ? "Agent" : "Agents"}
          </p>
        </div>
      ),
    },
    {
      key: "employees",
      label: "Sales Workforce",
      align: "right",
      sortValue: (b) => b.employeeCount,
      render: (b) => (
        <div className="text-right">
          <span className="text-xs font-semibold tabular-nums text-slate-700 dark:text-slate-200 flex items-center justify-end gap-1">
            <Users className="h-3 w-3 text-slate-400" /> {b.employeeCount}
          </span>
          {b.pendingCount > 0 && (
            <span className="text-[10px] text-amber-600 font-medium block">
              {b.pendingCount} pending
            </span>
          )}
        </div>
      ),
    },
    {
      key: "totalAmount",
      label: "Total Commission",
      align: "right",
      sortValue: (b) => b.totalAmount,
      render: (b) => (
        <span className="text-sm font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
          {fmtMoney(b.totalAmount)}
        </span>
      ),
    },
    {
      key: "status",
      label: "Status",
      render: (b) => <StatusBadge status={b.status} />,
    },
    {
      key: "createdAt",
      label: "Calculated At",
      sortValue: (b) => b.createdAt || "",
      render: (b) => (
        <span className="text-xs text-slate-500 tabular-nums">
          {fmtDate(b.createdAt)}
        </span>
      ),
    },
    {
      key: "actions",
      label: "",
      align: "right",
      render: (b) => (
        <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
          {b.pendingCount > 0 && can("bonus", "approve") && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-400"
              onClick={() => setActBatch({ batch: b, decision: "APPROVE" })}
            >
              <CheckCircle2 className="h-3.5 w-3.5 mr-1 text-emerald-600" />
              Approve Run
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs text-slate-600 hover:text-slate-900"
            onClick={() => setSelectedCommBatchKey(b.batchKey)}
          >
            <span>View</span>
            <ChevronRight className="h-3.5 w-3.5 ml-1" />
          </Button>
        </div>
      ),
    },
  ]

  // Table Columns: Bonus
  const bonusColumns: Column<any>[] = [
    {
      key: "employee",
      label: "Employee",
      sortValue: (b) => b.employeeName,
      render: (b) => (
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">{b.employeeName}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">{b.label || "Regular Bonus"}</p>
        </div>
      ),
    },
    {
      key: "type",
      label: "Bonus Type",
      sortValue: (b) => b.type,
      render: (b) => (
        <Badge variant="outline" className="text-[11px] font-medium border-slate-200 dark:border-slate-700">
          {titleCase(b.type)}
        </Badge>
      ),
    },
    {
      key: "calc",
      label: "Calculation",
      render: (b) => (
        <span className="text-xs text-slate-600 dark:text-slate-300">
          {b.calcType === "PERCENT"
            ? `${b.percent}% of ${b.baseAmount ? "Custom Base" : "Salary"}`
            : "Fixed Amount"}
        </span>
      ),
    },
    {
      key: "amount",
      label: "Amount",
      align: "right",
      sortValue: (b) => b.amount,
      render: (b) => (
        <span className="text-sm font-bold tabular-nums text-slate-800 dark:text-slate-100">
          {fmtMoney(b.amount)}
        </span>
      ),
    },
    {
      key: "period",
      label: "Target Period",
      sortValue: (b) => `${b.periodYear || ""}-${String(b.periodMonth || 0).padStart(2, "0")}`,
      render: (b) => (
        <span className="text-xs text-slate-500 tabular-nums">
          {b.periodMonth ? `${monthLabel(b.periodMonth)} ${b.periodYear}` : "—"}
        </span>
      ),
    },
    {
      key: "status",
      label: "Status",
      render: (b) => (
        <div className="flex items-center gap-1.5">
          <StatusBadge status={b.status} />
          {b.escalated && (
            <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300 text-[10px]">
              Escalated
            </Badge>
          )}
        </div>
      ),
    },
    {
      key: "actions",
      label: "",
      align: "right",
      render: (b) => {
        if (b.status === "PENDING" && b.escalated) {
          return <span className="text-[10px] text-amber-600 dark:text-amber-400 font-medium">In Owner Approval Queue</span>
        }
        if (b.status === "PENDING" && can("bonus", "approve")) {
          return (
            <div className="flex gap-1 justify-end">
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-emerald-600 hover:text-emerald-700"
                title="Approve Bonus"
                onClick={() => setActBonus({ bonus: b, decision: "APPROVE" })}
              >
                <CheckCircle2 className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-slate-400 hover:text-rose-600"
                title="Reject Bonus"
                onClick={() => setActBonus({ bonus: b, decision: "REJECT" })}
              >
                <XCircle className="h-4 w-4" />
              </Button>
            </div>
          )
        }
        return null
      },
    },
  ]

  // Table Columns: Commission Payouts
  const commissionColumns: Column<any>[] = [
    {
      key: "employee",
      label: "Employee",
      sortValue: (b) => b.employeeName,
      render: (b) => (
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">{b.employeeName}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate max-w-sm">{b.label || "Sales Commission"}</p>
        </div>
      ),
    },
    {
      key: "calc",
      label: "Calculation Basis",
      render: (b) => (
        <span className="text-xs text-slate-600 dark:text-slate-300">
          {b.calcType === "PERCENT"
            ? `${b.percent}% of Revenue`
            : "Fixed Rate / Tier"}
        </span>
      ),
    },
    {
      key: "amount",
      label: "Commission Payable",
      align: "right",
      sortValue: (b) => b.amount,
      render: (b) => (
        <span className="text-sm font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
          {fmtMoney(b.amount)}
        </span>
      ),
    },
    {
      key: "period",
      label: "Period",
      sortValue: (b) => `${b.periodYear || ""}-${String(b.periodMonth || 0).padStart(2, "0")}`,
      render: (b) => (
        <span className="text-xs text-slate-500 tabular-nums">
          {b.periodMonth ? `${monthLabel(b.periodMonth)} ${b.periodYear}` : "—"}
        </span>
      ),
    },
    {
      key: "status",
      label: "Status",
      render: (b) => (
        <div className="flex items-center gap-1.5">
          <StatusBadge status={b.status} />
          {b.escalated && (
            <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300 text-[10px]">
              Escalated
            </Badge>
          )}
        </div>
      ),
    },
    {
      key: "actions",
      label: "",
      align: "right",
      render: (b) => {
        if (b.status === "PENDING" && can("bonus", "approve")) {
          return (
            <div className="flex gap-1 justify-end">
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-emerald-600 hover:text-emerald-700"
                title="Approve Commission"
                onClick={() => setActBonus({ bonus: b, decision: "APPROVE" })}
              >
                <CheckCircle2 className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-slate-400 hover:text-rose-600"
                title="Reject Commission"
                onClick={() => setActBonus({ bonus: b, decision: "REJECT" })}
              >
                <XCircle className="h-4 w-4" />
              </Button>
            </div>
          )
        }
        return null
      },
    },
  ]

  // Table Columns: Commission Rules
  const ruleColumns: Column<CommissionRuleRow>[] = [
    {
      key: "name",
      label: "Rule Name",
      sortValue: (r) => r.name,
      render: (r) => (
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{r.name}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">{r.calculationPeriod} calculation</p>
        </div>
      ),
    },
    {
      key: "basis",
      label: "Calculation Basis & Rate",
      render: (r) => (
        <div>
          <Badge variant="outline" className="text-[11px]">
            {r.basis === "PERCENT_OF_SALES" ? "Percentage of Revenue" : "Flat Amount"}
          </Badge>
          <p className="text-xs font-semibold tabular-nums text-slate-700 dark:text-slate-200 mt-0.5">
            {r.basis === "PERCENT_OF_SALES" ? `${r.rate}%` : fmtMoney(r.rate || 0)}
            <span className="text-[10px] text-slate-400 font-normal ml-1">
              ({titleCase(r.percentMethod || r.flatMethod || "")})
            </span>
          </p>
        </div>
      ),
    },
    {
      key: "scope",
      label: "Scope",
      render: (r) => {
        if (!r.branchId && !r.departmentId && !r.designationId) {
          return <Badge variant="secondary" className="text-[10px]">Company-wide (Global)</Badge>
        }
        return (
          <div className="text-xs text-slate-600 dark:text-slate-300">
            {r.branchName && <div>Branch: <b>{r.branchName}</b></div>}
            {r.departmentName && <div>Dept: <b>{r.departmentName}</b></div>}
            {r.designationName && <div>Desig: <b>{r.designationName}</b></div>}
          </div>
        )
      },
    },
    {
      key: "targets",
      label: "Targets Required",
      render: (r) => (
        <div className="flex flex-wrap gap-1">
          {r.requireTotalTarget && <Badge className="text-[9px] bg-slate-100 text-slate-700 border">Total</Badge>}
          {r.requireBranchTarget && <Badge className="text-[9px] bg-sky-50 text-sky-700 border">Branch</Badge>}
          {r.requireDeptTarget && <Badge className="text-[9px] bg-violet-50 text-violet-700 border">Dept</Badge>}
          {r.requireEmpTarget && <Badge className="text-[9px] bg-emerald-50 text-emerald-700 border">Employee</Badge>}
          {!r.requireTotalTarget && !r.requireBranchTarget && !r.requireDeptTarget && !r.requireEmpTarget && (
            <span className="text-[11px] text-slate-400">None</span>
          )}
        </div>
      ),
    },
    {
      key: "dates",
      label: "Effective Dates",
      render: (r) => (
        <span className="text-xs text-slate-500 tabular-nums">
          {fmtDate(r.effectiveFrom)} → {r.effectiveTo ? fmtDate(r.effectiveTo) : "Open-ended"}
        </span>
      ),
    },
    {
      key: "status",
      label: "Status",
      render: (r) => (
        <span className={cn(
          "inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold",
          r.active ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400"
        )}>
          {r.active ? "Active" : "Inactive"}
        </span>
      ),
    },
    {
      key: "actions",
      label: "",
      align: "right",
      render: (r) => (
        <div className="flex gap-1 justify-end">
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-slate-600 hover:text-primary"
            title="Edit Rule"
            onClick={(e) => {
              e.stopPropagation()
              setEditRule(r)
            }}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-slate-400 hover:text-rose-600"
            title="Deactivate Rule"
            onClick={(e) => {
              e.stopPropagation()
              setDelRule(r)
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ),
    },
  ]

  // Table Columns: Calculation Audit Logs
  const logColumns: Column<any>[] = [
    {
      key: "createdAt",
      label: "Timestamp",
      sortValue: (l) => l.createdAt,
      render: (l) => <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300">{fmtDateTime(l.createdAt)}</span>,
    },
    {
      key: "rule",
      label: "Rule Applied",
      render: (l) => (
        <div>
          <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">{l.ruleName || l.ruleId}</p>
          <p className="text-[10px] text-slate-400">Method: {titleCase(l.calculationMethod || "—")}</p>
        </div>
      ),
    },
    {
      key: "period",
      label: "Period",
      render: (l) => <span className="text-xs font-mono text-slate-700 dark:text-slate-200">{l.periodYear}-{String(l.periodMonth).padStart(2, "0")}</span>,
    },
    {
      key: "revenue",
      label: "Eligible Revenue",
      align: "right",
      render: (l) => <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300">{fmtMoney(l.eligibleRevenue || 0)}</span>,
    },
    {
      key: "targetMet",
      label: "Target Met",
      render: (l) => (
        <span className={cn(
          "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold",
          l.targetMet ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"
        )}>
          {l.targetMet ? "Yes" : "Below Target"}
        </span>
      ),
    },
    {
      key: "commission",
      label: "Total Commission",
      align: "right",
      render: (l) => (
        <span className="text-xs font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
          {fmtMoney(l.calculatedCommission || l.finalCommission || 0)}
        </span>
      ),
    },
    {
      key: "user",
      label: "Calculated By",
      render: (l) => <span className="text-xs text-slate-500">{l.createdByName || "System"}</span>,
    },
  ]

  const downloadExcelTemplate = async () => {
    try {
      const res = await rpc<any>("commissionRules.thresholdTemplate", {})
      if (res?.base64) {
        const link = document.createElement("a")
        link.href = `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${res.base64}`
        link.download = res.filename || "commission_threshold_template.xlsx"
        link.click()
        toast("Threshold template downloaded", "ok")
      }
    } catch (e: any) {
      toast(e.message || "Failed to download template", "err")
    }
  }

  return (
    <div className="space-y-4">
      {/* Page Header */}
      <PageHeader
        title="Bonuses & Commission"
        subtitle="Manage employee festival & performance bonuses, eligibility policies, sales commission rules, revenue targets, and automated calculation runs."
      />

      {/* Primary SaaS Tab Switcher: Bonus vs Commission */}
      <div className="flex items-center gap-1.5 p-1 bg-slate-100 dark:bg-slate-800/80 rounded-xl w-fit border border-slate-200/80 dark:border-slate-700/80">
        <button
          type="button"
          onClick={() => setActiveMainTab("bonus")}
          className={cn(
            "flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-all cursor-pointer",
            activeMainTab === "bonus"
              ? "bg-white dark:bg-slate-900 text-emerald-700 dark:text-emerald-400 shadow-xs font-bold"
              : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
          )}
        >
          <Gift className="h-4 w-4" />
          <span>Bonus Management</span>
          {actionableBonuses.length > 0 && (
            <span className="ml-1 px-1.5 py-0.2 rounded-full text-[10px] bg-amber-500 text-white font-bold">
              {actionableBonuses.length}
            </span>
          )}
        </button>

        <button
          type="button"
          onClick={() => setActiveMainTab("commission")}
          className={cn(
            "flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-all cursor-pointer",
            activeMainTab === "commission"
              ? "bg-white dark:bg-slate-900 text-emerald-700 dark:text-emerald-400 shadow-xs font-bold"
              : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
          )}
        >
          <Coins className="h-4 w-4" />
          <span>Commission Management</span>
          {activeRulesCount > 0 && (
            <span className="ml-1 px-1.5 py-0.2 rounded-full text-[10px] bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 font-bold">
              {activeRulesCount} active
            </span>
          )}
        </button>
      </div>

      {/* ============================================================== */}
      {/* SECTION 1: BONUS MANAGEMENT                                    */}
      {/* ============================================================== */}
      {activeMainTab === "bonus" && (
        selectedBonusBatch ? (
          <BonusRunDetail
            batch={selectedBonusBatch}
            onBack={() => setSelectedBonusBatchKey(null)}
            onChanged={reloadBonuses}
            onViewEmployee={(b) => setSelectedBonusDetail(b)}
            onApproveBatch={(b) => setActBatch({ batch: b, decision: "APPROVE" })}
            onRejectBatch={(b) => setActBatch({ batch: b, decision: "REJECT" })}
          />
        ) : (
          <div className="space-y-4">
            {/* Top KPI Stat Cards for Bonus */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <StatCard
                icon={Gift}
                label="Total Bonuses Recorded"
                value={fmtMoney(bonusTotalDisbursed + bonusPendingAmount)}
                sub={`${bonusRows.length} total bonus entries`}
                tone="emerald"
              />
              <StatCard
                icon={Clock}
                label="Pending Approval"
                value={fmtMoney(bonusPendingAmount)}
                sub={`${actionableBonuses.length} awaiting authorization`}
                tone="amber"
              />
              <StatCard
                icon={CheckCircle2}
                label="Approved / In Payroll"
                value={fmtMoney(bonusApprovedAmount)}
                sub="Ready for period disbursement"
                tone="teal"
              />
              <StatCard
                icon={ShieldCheck}
                label="Eligible Workforce"
                value={`${eligibleEmployeesCount} of ${employees?.length || 0}`}
                sub={`Min service: ${bonusPolicy.minServiceMonths} mos (${bonusPolicy.allowProbation ? "incl. probation" : "permanent only"})`}
                tone="violet"
                onClick={() => setEligibilityOpen(true)}
              />
            </div>

            {/* Action Bar & Controls */}
            <div className="flex flex-wrap items-center justify-between gap-2.5">
              {/* Filters & View switcher */}
              <div className="flex flex-wrap items-center gap-2">
                {/* View Mode Toggle: Runs vs All */}
                <div className="flex items-center gap-1 bg-slate-100 dark:bg-slate-800/80 p-0.5 rounded-lg border text-xs">
                  <button
                    type="button"
                    onClick={() => setBonusViewMode("runs")}
                    className={cn(
                      "px-2.5 py-1 rounded-md font-semibold transition-all cursor-pointer",
                      bonusViewMode === "runs"
                        ? "bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs"
                        : "text-slate-600 dark:text-slate-400 hover:text-slate-900"
                    )}
                  >
                    Bonus Runs ({bonusBatches.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setBonusViewMode("all")}
                    className={cn(
                      "px-2.5 py-1 rounded-md font-semibold transition-all cursor-pointer",
                      bonusViewMode === "all"
                        ? "bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs"
                        : "text-slate-600 dark:text-slate-400 hover:text-slate-900"
                    )}
                  >
                    All Records ({filteredBonusRows.length})
                  </button>
                </div>

                <div className="flex flex-wrap gap-1.5">
                  <FilterChip label="All" active={!bonusStatusFilter} onClick={() => setBonusStatusFilter("")} />
                  {["PENDING", "APPROVED", "IN_PAYROLL", "PAID", "REJECTED"].map((s) => (
                    <FilterChip
                      key={s}
                      label={titleCase(s)}
                      active={bonusStatusFilter === s}
                      onClick={() => setBonusStatusFilter(s)}
                    />
                  ))}
                </div>

                <div className="h-4 w-px bg-slate-200 dark:bg-slate-700 mx-1 hidden sm:block" />

                <Select value={bonusTypeFilter} onValueChange={setBonusTypeFilter}>
                  <SelectTrigger className="h-7 text-xs w-[160px]">
                    <SelectValue placeholder="Bonus Type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">All Bonus Types</SelectItem>
                    {BONUS_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>{t.label.split(" ")[0]} Bonus</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Action Buttons: "+ Create Bonus", "Bonus Eligibility Rules", Bulk Approve */}
              <div className="flex flex-wrap items-center gap-2">
                {can("settings", "view") && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setEligibilityOpen(true)}
                    className="h-8 text-xs gap-1.5"
                  >
                    <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                    <span>Bonus Eligibility Rules</span>
                  </Button>
                )}

                {can("bonus", "approve") && actionableBonuses.length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setBulkBonusApproveOpen(true)}
                    className="h-8 text-xs gap-1.5 border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-400"
                  >
                    <UserCheck className="h-3.5 w-3.5" />
                    <span>Bulk Approve ({actionableBonuses.length})</span>
                  </Button>
                )}

                {can("bonus", "create") && (
                  <Button
                    size="sm"
                    onClick={() => setCreateBonusOpen(true)}
                    className="h-8 text-xs gap-1.5"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span>+ Create Bonus</span>
                  </Button>
                )}
              </div>
            </div>

            {/* Bonus Records / Runs DataTable */}
            {bonusViewMode === "runs" ? (
              <DataTable
                columns={bonusBatchColumns}
                rows={bonusBatches}
                loading={bonusesLoading}
                error={bonusesError}
                pageSize={10}
                csvName="bonus_runs_summary"
                searchPlaceholder="Search bonus run, period, type…"
                onRowClick={(b) => setSelectedBonusBatchKey(b.batchKey)}
                emptyTitle="No bonus runs found"
                emptyHint="Click '+ Create Bonus' to issue festival or performance bonuses. It will appear here as a pending run."
              />
            ) : (
              <DataTable
                columns={bonusColumns}
                rows={filteredBonusRows}
                loading={bonusesLoading}
                error={bonusesError}
                pageSize={12}
                csvName="bonuses_all_records"
                searchPlaceholder="Search employee, label, type…"
                onRowClick={(b) => setSelectedBonusDetail(b)}
                emptyTitle="No bonus records found"
                emptyHint="Click '+ Create Bonus' to issue festival or performance bonuses to eligible employees."
              />
            )}
          </div>
        )
      )}

      {/* ============================================================== */}
      {/* SECTION 2: COMMISSION MANAGEMENT                               */}
      {/* ============================================================== */}
      {activeMainTab === "commission" && (
        <div className="space-y-4">
          {/* Top KPI Stat Cards for Commission */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard
              icon={Coins}
              label="Total Sales Commissions"
              value={fmtMoney(commTotalDisbursed + commPendingAmount)}
              sub={`${commissionRows.length} commission payouts issued`}
              tone="emerald"
            />
            <StatCard
              icon={Clock}
              label="Pending Approval"
              value={fmtMoney(commPendingAmount)}
              sub={`${actionableCommissions.length} commission approvals due`}
              tone="amber"
            />
            <StatCard
              icon={Layers}
              label="Active Commission Rules"
              value={activeRulesCount}
              sub={`${rules?.length || 0} configured rules in system`}
              tone="sky"
            />
            <StatCard
              icon={History}
              label="Calculation Audit Runs"
              value={calcLogs?.length || 0}
              sub="Traceable calculation history"
              tone="violet"
            />
          </div>

          {/* Sub-tabs under Commission */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-2">
            <div className="flex flex-wrap gap-1">
              {[
                { id: "payouts", label: "Commission Payouts", icon: Coins, count: commissionRows.length },
                { id: "rules", label: "Commission Rule Setup", icon: Layers, count: rules?.length },
                { id: "calculate", label: "Calculate Commissions", icon: Calculator },
                { id: "audit", label: "Calculation Audit Trail", icon: History, count: calcLogs?.length },
              ].map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setActiveCommTab(t.id)}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer",
                    activeCommTab === t.id
                      ? "bg-primary text-primary-foreground shadow-xs"
                      : "text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                  )}
                >
                  <t.icon className="h-3.5 w-3.5" />
                  <span>{t.label}</span>
                  {t.count !== undefined && (
                    <span className={cn(
                      "ml-1 text-[10px] px-1.5 py-0.2 rounded-full font-bold",
                      activeCommTab === t.id ? "bg-primary-foreground/20 text-white" : "bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300"
                    )}>
                      {t.count}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Subtab 1: Commission Payouts */}
          {activeCommTab === "payouts" && (
            selectedCommBatch ? (
              <CommissionRunDetail
                batch={selectedCommBatch}
                onBack={() => setSelectedCommBatchKey(null)}
                onChanged={reloadBonuses}
                onViewEmployee={(c) => setSelectedCommDetail(c)}
                onApproveBatch={(b) => setActBatch({ batch: b, decision: "APPROVE" })}
                onRejectBatch={(b) => setActBatch({ batch: b, decision: "REJECT" })}
              />
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    {/* View Mode Toggle: Runs vs All */}
                    <div className="flex items-center gap-1 bg-slate-100 dark:bg-slate-800/80 p-0.5 rounded-lg border text-xs">
                      <button
                        type="button"
                        onClick={() => setCommViewMode("runs")}
                        className={cn(
                          "px-2.5 py-1 rounded-md font-semibold transition-all cursor-pointer",
                          commViewMode === "runs"
                            ? "bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs"
                            : "text-slate-600 dark:text-slate-400 hover:text-slate-900"
                        )}
                      >
                        Commission Runs ({commBatches.length})
                      </button>
                      <button
                        type="button"
                        onClick={() => setCommViewMode("all")}
                        className={cn(
                          "px-2.5 py-1 rounded-md font-semibold transition-all cursor-pointer",
                          commViewMode === "all"
                            ? "bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs"
                            : "text-slate-600 dark:text-slate-400 hover:text-slate-900"
                        )}
                      >
                        All Records ({filteredCommissionRows.length})
                      </button>
                    </div>

                    <div className="flex flex-wrap gap-1.5">
                      <FilterChip label="All" active={!commStatusFilter} onClick={() => setCommStatusFilter("")} />
                      {["PENDING", "APPROVED", "IN_PAYROLL", "PAID", "REJECTED"].map((s) => (
                        <FilterChip
                          key={s}
                          label={titleCase(s)}
                          active={commStatusFilter === s}
                          onClick={() => setCommStatusFilter(s)}
                        />
                      ))}
                    </div>
                  </div>

                  {can("bonus", "approve") && actionableCommissions.length > 0 && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setBulkCommApproveOpen(true)}
                      className="h-8 text-xs gap-1.5 border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-400"
                    >
                      <UserCheck className="h-3.5 w-3.5" />
                      <span>Bulk Approve Commissions ({actionableCommissions.length})</span>
                    </Button>
                  )}
                </div>

                {commViewMode === "runs" ? (
                  <DataTable
                    columns={commBatchColumns}
                    rows={commBatches}
                    loading={bonusesLoading}
                    error={bonusesError}
                    pageSize={10}
                    csvName="commissions_runs_summary"
                    searchPlaceholder="Search commission run, rule, period…"
                    onRowClick={(b) => setSelectedCommBatchKey(b.batchKey)}
                    emptyTitle="No commission runs recorded"
                    emptyHint="Use 'Calculate Commissions' wizard to run automated calculation against approved rules."
                  />
                ) : (
                  <DataTable
                    columns={commissionColumns}
                    rows={filteredCommissionRows}
                    loading={bonusesLoading}
                    error={bonusesError}
                    pageSize={12}
                    csvName="commissions_all_records"
                    searchPlaceholder="Search employee, reference, period…"
                    onRowClick={(c) => setSelectedCommDetail(c)}
                    emptyTitle="No commission payouts recorded"
                    emptyHint="Use 'Calculate Commissions' to run automated calculation against approved rules and revenue targets."
                  />
                )}
              </div>
            )
          )}

          {/* Subtab 2: Commission Rule Setup */}
          {activeCommTab === "rules" && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-slate-500">
                  Configure calculation basis (Percentage / Flat), targets (Total, Branch, Dept, Employee), distribution methods, and caps.
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={downloadExcelTemplate}
                    className="h-8 text-xs gap-1.5"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>Download Template</span>
                  </Button>
                  {can("bonus", "create") && (
                    <Button
                      size="sm"
                      onClick={() => setNewRuleOpen(true)}
                      className="h-8 text-xs gap-1.5"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      <span>+ New Commission Rule</span>
                    </Button>
                  )}
                </div>
              </div>

              <DataTable
                columns={ruleColumns}
                rows={rules || undefined}
                loading={rulesLoading}
                error={rulesError}
                pageSize={10}
                csvName="commission_rules"
                searchPlaceholder="Search rule name, scope…"
                emptyTitle="No commission rules configured"
                emptyHint="Click '+ New Commission Rule' to set up monthly or quarterly sales incentive structures."
                onRowClick={(r) => setSelectedRuleDetail(r)}
              />
            </div>
          )}

          {/* Subtab 3: Calculate Commissions Wizard view */}
          {activeCommTab === "calculate" && (
            <SectionCard
              title="Automated Commission Calculation Wizard"
              actions={
                <Button size="sm" onClick={() => setCalcCommissionOpen(true)} className="h-8 text-xs gap-1.5">
                  <Calculator className="h-3.5 w-3.5" /> Start Calculation Run
                </Button>
              }
            >
              <div className="space-y-4 max-w-3xl">
                <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                  The automated commission calculation engine evaluates employee service period, active targets (Company-wide, Branch, Dept, Employee), deduplicates overlapping rules by specificity, applies total rule caps, and reconciles pro-rata or equal pool distributions.
                </p>

                <div className="grid sm:grid-cols-3 gap-3">
                  <div className="rounded-xl border p-3 bg-slate-50 dark:bg-slate-900/50">
                    <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">1. Select Calculation Period</p>
                    <p className="text-[11px] text-slate-400 mt-1">Calendar month boundary is computed automatically for accurate target checks.</p>
                  </div>
                  <div className="rounded-xl border p-3 bg-slate-50 dark:bg-slate-900/50">
                    <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">2. Input / Paste Sales Revenue</p>
                    <p className="text-[11px] text-slate-400 mt-1">Single or bulk paste revenue with instant comma formatting and sanitization.</p>
                  </div>
                  <div className="rounded-xl border p-3 bg-slate-50 dark:bg-slate-900/50">
                    <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">3. Review & Issue Bonuses</p>
                    <p className="text-[11px] text-slate-400 mt-1">Inspect calculated bonuses, applied caps, and actionable skipped explanations.</p>
                  </div>
                </div>
              </div>
            </SectionCard>
          )}

          {/* Subtab 4: Calculation Audit Trail */}
          {activeCommTab === "audit" && (
            <div className="space-y-3">
              <DataTable
                columns={logColumns}
                rows={calcLogs || undefined}
                loading={logsLoading}
                error={logsError}
                pageSize={15}
                csvName="commission_calculation_logs"
                searchPlaceholder="Search rule, user, period…"
                emptyTitle="No calculation logs recorded yet"
                emptyHint="Every executed commission calculation registers an immutable audit trail here."
              />
            </div>
          )}
        </div>
      )}

      {/* ============================================================== */}
      {/* DIALOG: BONUS ELIGIBILITY RULES & WORKFORCE AUDITOR            */}
      {/* ============================================================== */}
      <BonusEligibilityRulesDialog
        open={eligibilityOpen}
        onOpenChange={setEligibilityOpen}
        policy={bonusPolicy}
        employees={evaluatedEmployees}
      />

      {/* ============================================================== */}
      {/* DIALOG: + CREATE BONUS (MODERN SAAS GRADE MODAL)               */}
      {/* ============================================================== */}
      <CreateBonusDialog
        open={createBonusOpen}
        onOpenChange={setCreateBonusOpen}
        employees={evaluatedEmployees}
        onCreated={(batchId) => {
          reloadBonuses()
          if (batchId) {
            setSelectedBonusBatchKey(batchId)
          }
        }}
      />

      {/* ============================================================== */}
      {/* DIALOG: BATCH APPROVE / REJECT (ONE-CLICK SUMMARY APPROVAL)   */}
      {/* ============================================================== */}
      <ConfirmDialog
        open={!!actBatch}
        onOpenChange={(v) => { if (!v) setActBatch(null) }}
        title={actBatch?.decision === "APPROVE" ? `Approve ${actBatch.batch.type === "SALES_COMMISSION" ? "Commission" : "Bonus"} Run` : "Reject Run"}
        message={
          actBatch
            ? `Are you sure you want to ${actBatch.decision === "APPROVE" ? "approve" : "reject"} this run for ${actBatch.batch.pendingCount} employee(s) totalling ${fmtMoney(
                actBatch.batch.items.filter((i: any) => i.status === "PENDING").reduce((s: number, i: any) => s + (Number(i.amount) || 0), 0)
              )}? ${
                actBatch.decision === "APPROVE"
                  ? "Approved bonuses will be queued for disbursement in matching period's payroll calculation."
                  : "Rejected entries will not be included in payroll."
              }`
            : ""
        }
        confirmLabel={
          actBatch?.decision === "APPROVE"
            ? `Approve All (${actBatch.batch.pendingCount})`
            : "Reject Run"
        }
        danger={actBatch?.decision === "REJECT"}
        onConfirm={async () => {
          if (!actBatch) return
          const pendingIds = actBatch.batch.items
            .filter((i: any) => i.status === "PENDING")
            .map((i: any) => i.id)
          if (!pendingIds.length) {
            toast("No pending bonuses in this batch to action", "err")
            return
          }
          try {
            const res = await rpc<any>("bonuses.approveBulk", {
              ids: pendingIds,
              decision: actBatch.decision,
            })
            if (res.actioned > 0) {
              toast(`Successfully ${actBatch.decision.toLowerCase()}d ${res.actioned} bonus(es)!`, "ok")
            }
            if (res.escalated?.length > 0) {
              toast(`${res.escalated.length} bonus(es) escalated to executive approval workflow`, "ok")
            }
            if (res.skipped?.length > 0) {
              toast(`${res.skipped.length} bonus(es) skipped: ${res.skipped[0].reason}`, "err")
            }
            reloadBonuses()
          } catch (e: any) {
            toast(e.message || "Failed to action batch", "err")
          }
        }}
      />

      {/* ============================================================== */}
      {/* DIALOG: INDIVIDUAL BONUS DETAIL BREAKDOWN                      */}
      {/* ============================================================== */}
      <EmployeeBonusDetailDialog
        bonus={selectedBonusDetail}
        open={!!selectedBonusDetail}
        onOpenChange={(v) => { if (!v) setSelectedBonusDetail(null) }}
        onAction={() => {
          reloadBonuses()
          setSelectedBonusDetail(null)
        }}
      />

      {/* ============================================================== */}
      {/* DIALOG: INDIVIDUAL COMMISSION DETAIL BREAKDOWN                 */}
      {/* ============================================================== */}
      <EmployeeCommissionDetailDialog
        commission={selectedCommDetail}
        open={!!selectedCommDetail}
        onOpenChange={(v) => { if (!v) setSelectedCommDetail(null) }}
        onAction={() => {
          reloadBonuses()
          setSelectedCommDetail(null)
        }}
      />

      {/* ============================================================== */}
      {/* DIALOG: BULK BONUS APPROVE WITH TOTAL EXPOSURE                 */}
      {/* ============================================================== */}
      <BulkApproveDialog
        open={bulkBonusApproveOpen}
        onOpenChange={setBulkBonusApproveOpen}
        rows={actionableBonuses}
        title="Bulk Approve Bonuses"
        onDone={() => { reloadBonuses() }}
      />

      {/* ============================================================== */}
      {/* DIALOG: BULK COMMISSION APPROVE                                */}
      {/* ============================================================== */}
      <BulkApproveDialog
        open={bulkCommApproveOpen}
        onOpenChange={setBulkCommApproveOpen}
        rows={actionableCommissions}
        title="Bulk Approve Sales Commissions"
        onDone={() => { reloadBonuses() }}
      />

      {/* ============================================================== */}
      {/* DIALOG: SINGLE BONUS DECISION (APPROVE / REJECT)               */}
      {/* ============================================================== */}
      <ConfirmDialog
        open={!!actBonus}
        onOpenChange={(v) => { if (!v) setActBonus(null) }}
        title={actBonus?.decision === "APPROVE" ? "Approve Bonus Payout" : "Reject Bonus"}
        message={actBonus ? `${actBonus.decision === "APPROVE" ? "Approve" : "Reject"} ${fmtMoney(actBonus.bonus.amount)} for ${actBonus.bonus.employeeName}? Approved entries are included in matching period's payroll calculation.` : ""}
        confirmLabel={actBonus?.decision === "APPROVE" ? "Approve" : "Reject"}
        danger={actBonus?.decision === "REJECT"}
        onConfirm={async () => {
          const res = await rpc<any>("bonuses.approve", { id: actBonus.bonus.id, decision: actBonus.decision })
          if (res?.status === "ESCALATED") toast(res.message || "Bonus escalated to executive approval workflow", "ok")
          else toast(`Bonus ${actBonus.decision.toLowerCase()}d successfully`, "ok")
          reloadBonuses()
        }}
      />

      {/* ============================================================== */}
      {/* COMMISSION DIALOGS                                             */}
      {/* ============================================================== */}
      <CommissionCalculateDialog
        open={calcCommissionOpen}
        onOpenChange={setCalcCommissionOpen}
        onDone={(batchId) => {
          reloadBonuses()
          reloadLogs()
          setActiveCommTab("payouts")
          if (batchId) {
            setSelectedCommBatchKey(batchId)
          }
        }}
        empOpts={empOpts}
      />

      <CommissionRuleFormDialog
        open={newRuleOpen}
        onOpenChange={(v) => { setNewRuleOpen(v); if (!v) reloadRules() }}
        onSaved={() => { setNewRuleOpen(false); reloadRules() }}
      />

      {editRule && (
        <CommissionRuleFormDialog
          rule={editRule}
          open={!!editRule}
          onOpenChange={(v) => { if (!v) setEditRule(null); reloadRules() }}
          onSaved={() => { setEditRule(null); reloadRules() }}
        />
      )}

      {selectedRuleDetail && (
        <CommissionRuleDetailDialog
          rule={selectedRuleDetail}
          open={!!selectedRuleDetail}
          onOpenChange={(v) => { if (!v) setSelectedRuleDetail(null) }}
          onEdit={(r) => {
            setSelectedRuleDetail(null)
            setEditRule(r)
          }}
        />
      )}

      {importRule && (
        <BulkThresholdImportDialog
          rule={importRule}
          open={!!importRule}
          onOpenChange={(v) => { if (!v) setImportRule(null); reloadRules() }}
          onUpdated={() => { setImportRule(null); reloadRules() }}
        />
      )}

      <ConfirmDialog
        open={!!delRule}
        onOpenChange={(v) => { if (!v) setDelRule(null) }}
        title="Deactivate Commission Rule"
        message={delRule ? `Are you sure you want to deactivate "${delRule.name}"? Rules with historical calculations are soft-deactivated to maintain audit trail integrity.` : ""}
        danger
        confirmLabel="Deactivate Rule"
        onConfirm={async () => {
          if (!delRule) return
          await rpc("commissionRules.delete", { id: delRule.id })
          toast("Commission rule deactivated", "ok")
          reloadRules()
        }}
      />
    </div>
  )
}

// ============================================================================
// BONUS RUN DETAIL VIEW (RUN UX LIKE PAYROLL RUN)
// ============================================================================
function BonusRunDetail({
  batch,
  onBack,
  onChanged: _onChanged,
  onViewEmployee,
  onApproveBatch,
  onRejectBatch,
}: {
  batch: BonusBatch
  onBack: () => void
  onChanged: () => void
  onViewEmployee: (b: any) => void
  onApproveBatch: (b: BonusBatch) => void
  onRejectBatch: (b: BonusBatch) => void
}) {
  const { can } = useHrm()
  const [searchTerm, _setSearchTerm] = useState("")

  const filteredItems = useMemo(() => {
    if (!searchTerm.trim()) return batch.items
    const s = searchTerm.toLowerCase()
    return batch.items.filter((b) =>
      (b.employeeName || "").toLowerCase().includes(s) ||
      (b.employeeCode || "").toLowerCase().includes(s) ||
      (b.label || "").toLowerCase().includes(s)
    )
  }, [batch.items, searchTerm])

  const detailColumns: Column<any>[] = [
    {
      key: "employee",
      label: "Employee",
      sortValue: (b) => b.employeeName,
      render: (b) => (
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">{b.employeeName}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
            {b.employeeCode ? `${b.employeeCode} · ` : ""}{b.label || "Regular Bonus"}
          </p>
        </div>
      ),
    },
    {
      key: "calc",
      label: "Calculation Basis",
      render: (b) => (
        <span className="text-xs text-slate-600 dark:text-slate-300">
          {b.calcType === "PERCENT"
            ? `${b.percent}% of ${b.baseAmount ? `৳${Number(b.baseAmount).toLocaleString()}` : "Salary"}`
            : "Fixed Amount"}
        </span>
      ),
    },
    {
      key: "amount",
      label: "Bonus Amount",
      align: "right",
      sortValue: (b) => b.amount,
      render: (b) => (
        <span className="text-sm font-bold tabular-nums text-slate-800 dark:text-slate-100">
          {fmtMoney(b.amount)}
        </span>
      ),
    },
    {
      key: "status",
      label: "Status",
      render: (b) => (
        <div className="flex items-center gap-1.5">
          <StatusBadge status={b.status} />
          {b.escalated && (
            <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300 text-[10px]">
              Escalated
            </Badge>
          )}
        </div>
      ),
    },
    {
      key: "actions",
      label: "",
      align: "right",
      render: (b) => (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs text-slate-500 hover:text-slate-900"
          onClick={(e) => {
            e.stopPropagation()
            onViewEmployee(b)
          }}
        >
          <Eye className="h-3.5 w-3.5 mr-1" />
          <span>View</span>
        </Button>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onBack} className="h-8 text-xs">
          <ArrowLeft className="h-4 w-4 mr-1" /> All Bonus Runs
        </Button>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs">{titleCase(batch.type)}</Badge>
          <StatusBadge status={batch.status} />
        </div>
      </div>

      <SectionCard title={`${batch.label} — Bonus Run`}>
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
          <KV
            cols={4}
            items={[
              ["Period", batch.periodMonth ? `${monthLabel(batch.periodMonth)} ${batch.periodYear}` : "Discretionary"],
              ["Bonus Type", titleCase(batch.type)],
              ["Employees", `${batch.employeeCount} Total (${batch.pendingCount} Pending)`],
              ["Created Date", fmtDate(batch.createdAt)],
            ]}
          />
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {batch.pendingCount > 0 && can("bonus", "approve") && (
              <>
                <Button
                  size="sm"
                  onClick={() => onApproveBatch(batch)}
                  className="h-8 text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
                >
                  <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
                  Approve Batch ({batch.pendingCount} Pending)
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onRejectBatch(batch)}
                  className="h-8 text-xs border-rose-300 text-rose-600 dark:border-rose-800 hover:bg-rose-50"
                >
                  <XCircle className="h-3.5 w-3.5 mr-1.5" />
                  Reject Batch
                </Button>
              </>
            )}
          </div>
        </div>
      </SectionCard>

      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3">
        <StatCard label="Total Run Exposure" value={fmtMoney(batch.totalAmount)} icon={Gift} tone="emerald" />
        <StatCard label="Total Employees" value={batch.employeeCount} icon={Users} tone="slate" />
        <StatCard label="Pending Approval" value={batch.pendingCount} icon={Clock} tone="amber" sub={fmtMoney(batch.items.filter((i: any) => i.status === "PENDING").reduce((s: number, i: any) => s + (Number(i.amount) || 0), 0))} />
        <StatCard label="Approved / Ready" value={batch.approvedCount} icon={CheckCircle2} tone="teal" sub={fmtMoney(batch.items.filter((i: any) => i.status === "APPROVED" || i.status === "IN_PAYROLL").reduce((s: number, i: any) => s + (Number(i.amount) || 0), 0))} />
        <StatCard label="Disbursed (Paid)" value={batch.paidCount} icon={Wallet} tone="sky" sub={fmtMoney(batch.items.filter((i: any) => i.status === "PAID").reduce((s: number, i: any) => s + (Number(i.amount) || 0), 0))} />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-slate-500">
            Click on any employee row to inspect individual bonus calculation breakdown and approval history.
          </p>
        </div>

        <DataTable
          columns={detailColumns}
          rows={filteredItems}
          pageSize={12}
          csvName={`bonus_run_${batch.type}_${batch.periodYear || 0}_${batch.periodMonth || 0}`}
          searchPlaceholder="Search employee in this run..."
          onRowClick={(b) => onViewEmployee(b)}
          emptyTitle="No employee records found in this run"
          emptyHint="All employee bonuses for this run have been processed."
        />
      </div>
    </div>
  )
}

// ============================================================================
// COMMISSION RUN DETAIL VIEW (RUN UX LIKE PAYROLL RUN)
// ============================================================================
function CommissionRunDetail({
  batch,
  onBack,
  onChanged: _onChanged,
  onViewEmployee,
  onApproveBatch,
  onRejectBatch,
}: {
  batch: BonusBatch
  onBack: () => void
  onChanged: () => void
  onViewEmployee: (c: any) => void
  onApproveBatch: (b: BonusBatch) => void
  onRejectBatch: (b: BonusBatch) => void
}) {
  const { can } = useHrm()
  const [searchTerm, _setSearchTerm] = useState("")

  const filteredItems = useMemo(() => {
    if (!searchTerm.trim()) return batch.items
    const s = searchTerm.toLowerCase()
    return batch.items.filter((b) =>
      (b.employeeName || "").toLowerCase().includes(s) ||
      (b.employeeCode || "").toLowerCase().includes(s) ||
      (b.label || "").toLowerCase().includes(s)
    )
  }, [batch.items, searchTerm])

  const detailColumns: Column<any>[] = [
    {
      key: "employee",
      label: "Sales Agent",
      sortValue: (b) => b.employeeName,
      render: (b) => (
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">{b.employeeName}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
            {b.employeeCode ? `${b.employeeCode} · ` : ""}{b.label || "Sales Commission"}
          </p>
        </div>
      ),
    },
    {
      key: "calc",
      label: "Calculation Basis",
      render: (b) => (
        <span className="text-xs text-slate-600 dark:text-slate-300">
          {b.calcType === "PERCENT"
            ? `${b.percent}% of Revenue`
            : "Fixed Rate / Tier"}
        </span>
      ),
    },
    {
      key: "amount",
      label: "Commission Payable",
      align: "right",
      sortValue: (b) => b.amount,
      render: (b) => (
        <span className="text-sm font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
          {fmtMoney(b.amount)}
        </span>
      ),
    },
    {
      key: "status",
      label: "Status",
      render: (b) => (
        <div className="flex items-center gap-1.5">
          <StatusBadge status={b.status} />
          {b.escalated && (
            <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300 text-[10px]">
              Escalated
            </Badge>
          )}
        </div>
      ),
    },
    {
      key: "actions",
      label: "",
      align: "right",
      render: (b) => (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs text-slate-500 hover:text-slate-900"
          onClick={(e) => {
            e.stopPropagation()
            onViewEmployee(b)
          }}
        >
          <Eye className="h-3.5 w-3.5 mr-1" />
          <span>View</span>
        </Button>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onBack} className="h-8 text-xs">
          <ArrowLeft className="h-4 w-4 mr-1" /> All Commission Runs
        </Button>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs bg-emerald-50 border-emerald-200 text-emerald-700">Sales Commission</Badge>
          <StatusBadge status={batch.status} />
        </div>
      </div>

      <SectionCard title={`Commission Run — ${batch.label}`}>
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
          <KV
            cols={4}
            items={[
              ["Period", batch.periodMonth ? `${monthLabel(batch.periodMonth)} ${batch.periodYear}` : "Discretionary"],
              ["Rule / Payout", batch.label || "Sales Commission"],
              ["Sales Agents", `${batch.employeeCount} Total (${batch.pendingCount} Pending)`],
              ["Calculated At", fmtDate(batch.createdAt)],
            ]}
          />
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {batch.pendingCount > 0 && can("bonus", "approve") && (
              <>
                <Button
                  size="sm"
                  onClick={() => onApproveBatch(batch)}
                  className="h-8 text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
                >
                  <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
                  Approve Commission Run ({batch.pendingCount} Pending)
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onRejectBatch(batch)}
                  className="h-8 text-xs border-rose-300 text-rose-600 dark:border-rose-800 hover:bg-rose-50"
                >
                  <XCircle className="h-3.5 w-3.5 mr-1.5" />
                  Reject Run
                </Button>
              </>
            )}
          </div>
        </div>
      </SectionCard>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Total Commission" value={fmtMoney(batch.totalAmount)} icon={Coins} tone="emerald" />
        <StatCard label="Sales Agents" value={batch.employeeCount} icon={Users} tone="slate" />
        <StatCard label="Pending Approval" value={batch.pendingCount} icon={Clock} tone="amber" sub={fmtMoney(batch.items.filter((i: any) => i.status === "PENDING").reduce((s: number, i: any) => s + (Number(i.amount) || 0), 0))} />
        <StatCard label="Approved / Paid" value={batch.approvedCount + batch.paidCount} icon={CheckCircle2} tone="teal" sub={fmtMoney(batch.items.filter((i: any) => i.status === "APPROVED" || i.status === "IN_PAYROLL" || i.status === "PAID").reduce((s: number, i: any) => s + (Number(i.amount) || 0), 0))} />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-slate-500">
            Click on any sales agent to view calculation breakdown, eligible revenue, and target reconciliation.
          </p>
        </div>

        <DataTable
          columns={detailColumns}
          rows={filteredItems}
          pageSize={12}
          csvName={`commission_run_${batch.periodYear || 0}_${batch.periodMonth || 0}`}
          searchPlaceholder="Search sales agent in this run..."
          onRowClick={(c) => onViewEmployee(c)}
          emptyTitle="No commission records found in this run"
          emptyHint="All commission bonuses for this run have been processed."
        />
      </div>
    </div>
  )
}

// ============================================================================
// INDIVIDUAL EMPLOYEE BONUS DETAIL BREAKDOWN DIALOG
// ============================================================================
function EmployeeBonusDetailDialog({
  bonus,
  open,
  onOpenChange,
  onAction,
}: {
  bonus: any
  open: boolean
  onOpenChange: (open: boolean) => void
  onAction?: () => void
}) {
  const { can } = useHrm()
  const toast = useHrm((s) => s.toast)
  const [busy, setBusy] = useState(false)

  if (!bonus) return null

  const act = async (decision: "APPROVE" | "REJECT") => {
    setBusy(true)
    try {
      const res = await rpc<any>("bonuses.approve", { id: bonus.id, decision })
      if (res?.status === "ESCALATED") toast(res.message || "Bonus escalated to approval workflow", "ok")
      else toast(`Bonus ${decision.toLowerCase()}d successfully`, "ok")
      if (onAction) onAction()
      onOpenChange(false)
    } catch (e: any) {
      toast(e.message || "Failed to action bonus", "err")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            <Gift className="h-4 w-4 text-emerald-600" />
            <span>Bonus Calculation Breakdown</span>
          </DialogTitle>
          <DialogDescription className="text-xs text-slate-500">
            Individual employee bonus breakdown and audit history.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2 text-xs">
          <div className="p-3 rounded-lg border bg-slate-50 dark:bg-slate-900/50 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-slate-800 dark:text-slate-100 text-sm">{bonus.employeeName}</span>
              <StatusBadge status={bonus.status} />
            </div>
            {bonus.employeeCode && (
              <p className="text-[11px] text-slate-500">Employee ID: <b>{bonus.employeeCode}</b></p>
            )}
            <p className="text-[11px] text-slate-500">{bonus.label || "Regular Bonus"}</p>
          </div>

          <div className="p-3 rounded-lg border space-y-2">
            <div className="flex justify-between items-center py-1 border-b border-slate-100 dark:border-slate-800">
              <span className="text-slate-500">Bonus Type</span>
              <Badge variant="outline" className="text-[11px]">{titleCase(bonus.type)}</Badge>
            </div>
            <div className="flex justify-between items-center py-1 border-b border-slate-100 dark:border-slate-800">
              <span className="text-slate-500">Target Period</span>
              <span className="font-medium text-slate-700 dark:text-slate-200">
                {bonus.periodMonth ? `${monthLabel(bonus.periodMonth)} ${bonus.periodYear}` : "Discretionary"}
              </span>
            </div>
            <div className="flex justify-between items-center py-1 border-b border-slate-100 dark:border-slate-800">
              <span className="text-slate-500">Calculation Method</span>
              <span className="font-medium text-slate-700 dark:text-slate-200">
                {bonus.calcType === "PERCENT" ? "Percentage of Salary" : "Fixed Amount"}
              </span>
            </div>
            {bonus.calcType === "PERCENT" && (
              <>
                <div className="flex justify-between items-center py-1 border-b border-slate-100 dark:border-slate-800">
                  <span className="text-slate-500">Applied Percentage</span>
                  <span className="font-bold text-slate-700 dark:text-slate-200">{bonus.percent}%</span>
                </div>
                {bonus.baseAmount && (
                  <div className="flex justify-between items-center py-1 border-b border-slate-100 dark:border-slate-800">
                    <span className="text-slate-500">Base Salary Basis</span>
                    <span className="font-medium text-slate-700 dark:text-slate-200">{fmtMoney(bonus.baseAmount)}</span>
                  </div>
                )}
              </>
            )}
            <div className="flex justify-between items-center pt-2">
              <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">Calculated Bonus Payable</span>
              <span className="text-base font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">
                {fmtMoney(bonus.amount)}
              </span>
            </div>
          </div>

          <div className="p-2.5 rounded-lg border text-[11px] text-slate-500 space-y-1">
            <div className="flex justify-between">
              <span>Created:</span>
              <span>{fmtDateTime(bonus.createdAt)}</span>
            </div>
            {bonus.status !== "PENDING" && (
              <div className="flex justify-between">
                <span>Actioned Status:</span>
                <span className="font-medium text-slate-700 dark:text-slate-200">{bonus.status}</span>
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="flex items-center justify-between sm:justify-between">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {bonus.status === "PENDING" && can("bonus", "approve") && (
            <div className="flex gap-1.5">
              <Button
                variant="outline"
                size="sm"
                className="text-rose-600 border-rose-200 hover:bg-rose-50"
                disabled={busy}
                onClick={() => act("REJECT")}
              >
                Reject
              </Button>
              <Button
                size="sm"
                className="bg-emerald-600 hover:bg-emerald-700 text-white"
                disabled={busy}
                onClick={() => act("APPROVE")}
              >
                Approve Bonus
              </Button>
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ============================================================================
// INDIVIDUAL EMPLOYEE COMMISSION DETAIL BREAKDOWN DIALOG
// ============================================================================
function EmployeeCommissionDetailDialog({
  commission,
  open,
  onOpenChange,
  onAction,
}: {
  commission: any
  open: boolean
  onOpenChange: (open: boolean) => void
  onAction?: () => void
}) {
  const { can } = useHrm()
  const toast = useHrm((s) => s.toast)
  const [busy, setBusy] = useState(false)

  if (!commission) return null

  const act = async (decision: "APPROVE" | "REJECT") => {
    setBusy(true)
    try {
      const res = await rpc<any>("bonuses.approve", { id: commission.id, decision })
      if (res?.status === "ESCALATED") toast(res.message || "Commission escalated to approval workflow", "ok")
      else toast(`Commission ${decision.toLowerCase()}d successfully`, "ok")
      if (onAction) onAction()
      onOpenChange(false)
    } catch (e: any) {
      toast(e.message || "Failed to action commission", "err")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            <Coins className="h-4 w-4 text-emerald-600" />
            <span>Sales Commission Breakdown</span>
          </DialogTitle>
          <DialogDescription className="text-xs text-slate-500">
            Individual sales agent calculation breakdown and payout authorization.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2 text-xs">
          <div className="p-3 rounded-lg border bg-slate-50 dark:bg-slate-900/50 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-slate-800 dark:text-slate-100 text-sm">{commission.employeeName}</span>
              <StatusBadge status={commission.status} />
            </div>
            {commission.employeeCode && (
              <p className="text-[11px] text-slate-500">Employee ID: <b>{commission.employeeCode}</b></p>
            )}
            <p className="text-[11px] text-slate-500">{commission.label || "Sales Commission"}</p>
          </div>

          <div className="p-3 rounded-lg border space-y-2">
            <div className="flex justify-between items-center py-1 border-b border-slate-100 dark:border-slate-800">
              <span className="text-slate-500">Commission Rule</span>
              <span className="font-medium text-slate-700 dark:text-slate-200">{commission.label?.split("—")[0]?.trim() || "Sales Commission"}</span>
            </div>
            <div className="flex justify-between items-center py-1 border-b border-slate-100 dark:border-slate-800">
              <span className="text-slate-500">Target Period</span>
              <span className="font-medium text-slate-700 dark:text-slate-200">
                {commission.periodMonth ? `${monthLabel(commission.periodMonth)} ${commission.periodYear}` : "Current Period"}
              </span>
            </div>
            <div className="flex justify-between items-center py-1 border-b border-slate-100 dark:border-slate-800">
              <span className="text-slate-500">Calculation Type</span>
              <span className="font-medium text-slate-700 dark:text-slate-200">
                {commission.calcType === "PERCENT" ? "Percentage of Revenue" : "Fixed Rate / Tier"}
              </span>
            </div>
            <div className="flex justify-between items-center pt-2">
              <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">Commission Payable</span>
              <span className="text-base font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">
                {fmtMoney(commission.amount)}
              </span>
            </div>
          </div>

          <div className="p-2.5 rounded-lg border text-[11px] text-slate-500 space-y-1">
            <div className="flex justify-between">
              <span>Calculated:</span>
              <span>{fmtDateTime(commission.createdAt)}</span>
            </div>
            {commission.status !== "PENDING" && (
              <div className="flex justify-between">
                <span>Actioned Status:</span>
                <span className="font-medium text-slate-700 dark:text-slate-200">{commission.status}</span>
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="flex items-center justify-between sm:justify-between">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {commission.status === "PENDING" && can("bonus", "approve") && (
            <div className="flex gap-1.5">
              <Button
                variant="outline"
                size="sm"
                className="text-rose-600 border-rose-200 hover:bg-rose-50"
                disabled={busy}
                onClick={() => act("REJECT")}
              >
                Reject
              </Button>
              <Button
                size="sm"
                className="bg-emerald-600 hover:bg-emerald-700 text-white"
                disabled={busy}
                onClick={() => act("APPROVE")}
              >
                Approve Commission
              </Button>
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ============================================================================
// BONUS ELIGIBILITY RULES & AUDIT DIALOG
// ============================================================================
function BonusEligibilityRulesDialog({
  open,
  onOpenChange,
  policy: initialPolicy,
  employees,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  policy: any
  employees: any[]
}) {
  const toast = useHrm((s) => s.toast)
  const settings = useHrm((s) => s.settings)
  const [activeTab, setActiveTab] = useState<"policy" | "workforce">("policy")
  const [busy, setBusy] = useState(false)
  const [filterQuery, setFilterQuery] = useState("")

  const [form, setForm] = useState<any>(initialPolicy)

  useEffect(() => {
    if (open) {
      setForm((settings as any)?.bonusPolicy || initialPolicy)
    }
  }, [open, settings, initialPolicy])

  const savePolicy = async () => {
    setBusy(true)
    try {
      await useHrm.getState().saveSettingsGroup("bonusPolicy", {
        minServiceMonths: Math.max(0, Number(form.minServiceMonths) || 6),
        minServiceDays: Math.max(0, Number(form.minServiceDays) || 180),
        allowProbation: Boolean(form.allowProbation),
        allowContract: Boolean(form.allowContract),
        festivalBasis: form.festivalBasis === "GROSS" ? "GROSS" : "BASIC",
        festivalPercent: Math.max(1, Number(form.festivalPercent) || 100),
        festivalsPerYear: Math.max(1, Number(form.festivalsPerYear) || 2),
        prorateFirstYear: Boolean(form.prorateFirstYear),
        performanceBasis: form.performanceBasis === "GROSS" ? "GROSS" : "BASIC",
        autoExcludeNoticePeriod: Boolean(form.autoExcludeNoticePeriod),
      })
      toast("Bonus eligibility rules saved successfully", "ok")
      onOpenChange(false)
    } catch (e: any) {
      toast(e.message || "Failed to save policy", "err")
    } finally {
      setBusy(false)
    }
  }

  // Filtered employees for audit tab
  const filteredEmployees = useMemo(() => {
    if (!filterQuery) return employees
    const q = filterQuery.toLowerCase()
    return employees.filter(
      (e) => e.fullName.toLowerCase().includes(q) || (e.code || "").toLowerCase().includes(q)
    )
  }, [employees, filterQuery])

  const eligibleCount = employees.filter((e) => e.eval.eligible).length

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] flex flex-col p-0 overflow-hidden">
        <DialogHeader className="p-5 pb-3 border-b">
          <div className="flex items-center justify-between">
            <DialogTitle className="text-base flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-emerald-600" />
              <span>Bonus Eligibility Rules & Workforce Policy</span>
            </DialogTitle>
          </div>
          <DialogDescription className="text-xs text-slate-500">
            Define statutory service period thresholds, employment status qualifications, and live eligibility checks.
          </DialogDescription>

          <div className="flex gap-2 pt-3">
            <button
              type="button"
              onClick={() => setActiveTab("policy")}
              className={cn(
                "px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-all",
                activeTab === "policy"
                  ? "bg-primary text-primary-foreground shadow-xs"
                  : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300"
              )}
            >
              Policy Rules & Parameters
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("workforce")}
              className={cn(
                "px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-all flex items-center gap-1.5",
                activeTab === "workforce"
                  ? "bg-primary text-primary-foreground shadow-xs"
                  : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300"
              )}
            >
              <Users className="h-3.5 w-3.5" />
              <span>Workforce Eligibility Auditor</span>
              <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-emerald-100 text-emerald-800 font-bold">
                {eligibleCount} / {employees.length}
              </span>
            </button>
          </div>
        </DialogHeader>

        <div className="p-5 overflow-y-auto flex-1 space-y-4">
          {activeTab === "policy" && (
            <div className="space-y-4">
              <div className="rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50/50 dark:bg-emerald-950/20 p-3 flex items-start gap-2 text-xs text-slate-700 dark:text-slate-300">
                <Info className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                <span>
                  <b>Bangladesh Labor Act (BLA) Standards:</b> Permanent employees with at least 6 months of continuous service are entitled to statutory festival bonuses. Configure company-specific criteria below.
                </span>
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold">Minimum Service Period (Months)*</Label>
                  <Input
                    type="number"
                    min={0}
                    max={60}
                    value={form?.minServiceMonths ?? 6}
                    onChange={(e) => setForm({ ...form, minServiceMonths: e.target.value })}
                    className="h-9 text-sm"
                  />
                  <p className="text-[11px] text-slate-400">Default is 6 months (continuous employment required)</p>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold">Default Festival Bonus Wage Basis</Label>
                  <Select
                    value={form?.festivalBasis || "BASIC"}
                    onValueChange={(v) => setForm({ ...form, festivalBasis: v })}
                  >
                    <SelectTrigger className="h-9 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="BASIC">Basic Salary (Recommended)</SelectItem>
                      <SelectItem value="GROSS">Gross Salary</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-slate-400">Calculation percentage applies to this salary component</p>
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold">Default Festival Bonus Rate (%)</Label>
                  <Input
                    type="number"
                    min={1}
                    max={200}
                    value={form?.festivalPercent ?? 100}
                    onChange={(e) => setForm({ ...form, festivalPercent: e.target.value })}
                    className="h-9 text-sm"
                  />
                  <p className="text-[11px] text-slate-400">e.g. 100% of 1 month&apos;s basic salary</p>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold">Festivals Covered Per Fiscal Year</Label>
                  <Input
                    type="number"
                    min={1}
                    max={12}
                    value={form?.festivalsPerYear ?? 2}
                    onChange={(e) => setForm({ ...form, festivalsPerYear: e.target.value })}
                    className="h-9 text-sm"
                  />
                  <p className="text-[11px] text-slate-400">Typically 2 major religious festivals per year</p>
                </div>
              </div>

              <div className="space-y-3 pt-2 border-t">
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Employment Status Eligibility</p>

                <label className="flex items-center justify-between rounded-lg border p-3 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-900/50">
                  <div>
                    <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Include Probationary Employees</p>
                    <p className="text-xs text-slate-500">Allow employees currently on probation to qualify if they meet the tenure rule.</p>
                  </div>
                  <Switch
                    checked={!!form?.allowProbation}
                    onCheckedChange={(c) => setForm({ ...form, allowProbation: c })}
                  />
                </label>

                <label className="flex items-center justify-between rounded-lg border p-3 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-900/50">
                  <div>
                    <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Include Contractual Employees</p>
                    <p className="text-xs text-slate-500">Include fixed-term or contractual employees in eligible workforce rosters.</p>
                  </div>
                  <Switch
                    checked={!!form?.allowContract}
                    onCheckedChange={(c) => setForm({ ...form, allowContract: c })}
                  />
                </label>

                <label className="flex items-center justify-between rounded-lg border p-3 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-900/50">
                  <div>
                    <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Exclude Resigning / Notice Period</p>
                    <p className="text-xs text-slate-500">Automatically exclude employees who are actively serving notice periods.</p>
                  </div>
                  <Switch
                    checked={!!form?.autoExcludeNoticePeriod}
                    onCheckedChange={(c) => setForm({ ...form, autoExcludeNoticePeriod: c })}
                  />
                </label>
              </div>
            </div>
          )}

          {activeTab === "workforce" && (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="relative flex-1 max-w-sm">
                  <Search className="h-3.5 w-3.5 text-slate-400 absolute left-2.5 top-2.5" />
                  <Input
                    placeholder="Filter employee name or code…"
                    value={filterQuery}
                    onChange={(e) => setFilterQuery(e.target.value)}
                    className="h-8 text-xs pl-8"
                  />
                </div>
                <Badge variant="outline" className="text-xs">
                  {eligibleCount} of {employees.length} Eligible
                </Badge>
              </div>

              <div className="rounded-lg border overflow-hidden max-h-[400px] overflow-y-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-slate-50/80 dark:bg-slate-800/60">
                      <TableHead className="text-[10px] uppercase text-slate-500">Employee</TableHead>
                      <TableHead className="text-[10px] uppercase text-slate-500">Joined</TableHead>
                      <TableHead className="text-[10px] uppercase text-slate-500">Tenure</TableHead>
                      <TableHead className="text-[10px] uppercase text-slate-500">Status</TableHead>
                      <TableHead className="text-[10px] uppercase text-slate-500">Eligibility</TableHead>
                      <TableHead className="text-[10px] uppercase text-slate-500">Reason / Policy Check</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredEmployees.map((e) => (
                      <TableRow key={e.id}>
                        <TableCell className="py-2">
                          <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">{e.fullName}</p>
                          <p className="text-[10px] text-slate-400 font-mono">{e.code}</p>
                        </TableCell>
                        <TableCell className="py-2 text-xs tabular-nums text-slate-500">
                          {e.joiningDate ? fmtDate(e.joiningDate) : "—"}
                        </TableCell>
                        <TableCell className="py-2 text-xs tabular-nums font-medium text-slate-700 dark:text-slate-300">
                          {e.eval.tenureMonths} mo(s)
                        </TableCell>
                        <TableCell className="py-2">
                          <StatusBadge status={e.status} />
                        </TableCell>
                        <TableCell className="py-2">
                          <span className={cn(
                            "inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold",
                            e.eval.eligible
                              ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                              : "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                          )}>
                            {e.eval.eligible ? "ELIGIBLE" : "INELIGIBLE"}
                          </span>
                        </TableCell>
                        <TableCell className="py-2 text-xs text-slate-500 max-w-xs truncate" title={e.eval.reason}>
                          {e.eval.reason}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="p-4 border-t bg-slate-50/50 dark:bg-slate-900/50">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          {activeTab === "policy" && (
            <Button disabled={busy} onClick={savePolicy} className="gap-1.5">
              <Check className="h-3.5 w-3.5" />
              <span>{busy ? "Saving…" : "Save Policy Rules"}</span>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ============================================================================
// + CREATE BONUS DIALOG
// ============================================================================
function CreateBonusDialog({
  open,
  onOpenChange,
  employees,
  onCreated,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  employees: any[]
  onCreated: (batchId?: string) => void
}) {
  const toast = useHrm((s) => s.toast)
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<BonusMode>("ALL_ELIGIBLE")
  const [singleEmpId, setSingleEmpId] = useState("")
  const [customEmpIds, setCustomEmpIds] = useState<string[]>([])
  const [bonusType, setBonusType] = useState("FESTIVAL")
  const [calcType, setCalcType] = useState<"FIXED" | "PERCENT">("PERCENT")
  const [amount, setAmount] = useState("")
  const [percent, setPercent] = useState("100")
  const [base, setBase] = useState<"BASIC" | "GROSS" | "CUSTOM">("BASIC")
  const [customBase, setCustomBase] = useState("")
  const [periodMonth, setPeriodMonth] = useState(String(new Date().getMonth() + 1))
  const [periodYear, setPeriodYear] = useState(new Date().getFullYear())
  const [label, setLabel] = useState("")

  const [confirmStep, setConfirmStep] = useState(false)
  const [resultReport, setResultReport] = useState<BulkBonusResult | null>(null)

  const eligibleEmployees = useMemo(() => employees.filter((e) => e.eval?.eligible), [employees])

  useEffect(() => {
    if (open) {
      setConfirmStep(false)
      setResultReport(null)
      setSingleEmpId(employees[0]?.id || "")
      setLabel(`Festival Bonus — ${monthLabel(Number(periodMonth))} ${periodYear}`)
    }
  }, [open, employees, periodMonth, periodYear])

  const targetCount = mode === "SINGLE" ? 1 : mode === "ALL_ELIGIBLE" ? eligibleEmployees.length : customEmpIds.length

  const handleSubmit = async () => {
    setBusy(true)
    try {
      let resolvedEmployeeIds: string[] | undefined = undefined
      let resolvedMode: "SINGLE" | "CUSTOM" | "ALL" = "SINGLE"

      if (mode === "SINGLE") {
        if (!singleEmpId) throw new Error("Select an employee")
        resolvedMode = "SINGLE"
      } else if (mode === "ALL_ELIGIBLE") {
        resolvedMode = "CUSTOM"
        resolvedEmployeeIds = eligibleEmployees.map((e) => e.id)
        if (resolvedEmployeeIds.length === 0) throw new Error("No eligible employees found based on policy")
      } else {
        if (customEmpIds.length === 0) throw new Error("Select at least one employee")
        resolvedMode = "CUSTOM"
        resolvedEmployeeIds = customEmpIds
      }

      const res = await rpc<BulkBonusResult>("bonuses.createBulk", {
        mode: resolvedMode,
        employeeId: resolvedMode === "SINGLE" ? singleEmpId : undefined,
        employeeIds: resolvedMode === "CUSTOM" ? resolvedEmployeeIds : undefined,
        type: bonusType,
        calcType,
        amount: calcType === "FIXED" ? Number(amount) : undefined,
        percent: calcType === "PERCENT" ? Number(percent) : undefined,
        base: calcType === "PERCENT" ? base : undefined,
        baseAmount: calcType === "PERCENT" && base === "CUSTOM" ? Number(customBase) : undefined,
        periodMonth: Number(periodMonth),
        periodYear: Number(periodYear),
        label: label.trim() || undefined,
      })

      setResultReport(res)
      setConfirmStep(false)
      onCreated((res as any)?.batchId)
      toast(`Bonus run created: ${res.created} created, ${res.skipped} skipped — pending approval`, res.created > 0 ? "ok" : "err")
    } catch (e: any) {
      toast(e.message || "Failed to create bonuses", "err")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v) }}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            <Gift className="h-4 w-4 text-emerald-600" />
            <span>Create Employee Bonus</span>
          </DialogTitle>
          <DialogDescription className="text-xs text-slate-500">
            Issue festival or performance bonuses in bulk or per employee. All created bonuses start in PENDING status.
          </DialogDescription>
        </DialogHeader>

        {resultReport ? (
          <div className="space-y-4">
            <div className="grid grid-cols-4 gap-2">
              <div className="p-2.5 rounded-lg border text-center">
                <p className="text-[10px] text-slate-400 uppercase">Target</p>
                <p className="text-base font-bold tabular-nums">{resultReport.requested}</p>
              </div>
              <div className="p-2.5 rounded-lg border bg-emerald-50 dark:bg-emerald-950/30 text-center">
                <p className="text-[10px] text-emerald-600 uppercase">Created</p>
                <p className="text-base font-bold tabular-nums text-emerald-700">{resultReport.created}</p>
              </div>
              <div className="p-2.5 rounded-lg border bg-amber-50 dark:bg-amber-950/30 text-center">
                <p className="text-[10px] text-amber-600 uppercase">Skipped</p>
                <p className="text-base font-bold tabular-nums text-amber-700">{resultReport.skipped}</p>
              </div>
              <div className="p-2.5 rounded-lg border text-center">
                <p className="text-[10px] text-rose-500 uppercase">Errors</p>
                <p className="text-base font-bold tabular-nums text-rose-600">{resultReport.errors}</p>
              </div>
            </div>

            <div className="max-h-60 overflow-y-auto rounded-lg border divide-y divide-slate-100 dark:divide-slate-800 text-xs">
              {resultReport.results.map((r, i) => (
                <div key={i} className="flex items-start gap-2 p-2.5">
                  {r.status === "CREATED" ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0 mt-0.5" />
                  ) : r.status === "SKIPPED" ? (
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0 mt-0.5" />
                  ) : (
                    <XCircle className="h-3.5 w-3.5 text-rose-600 shrink-0 mt-0.5" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-slate-800 dark:text-slate-100">{r.employeeName}</p>
                    <p className={cn(
                      "text-[11px]",
                      r.status === "CREATED" ? "text-emerald-700" : r.status === "SKIPPED" ? "text-amber-600" : "text-rose-600"
                    )}>
                      {r.detail}
                    </p>
                  </div>
                  {r.amount !== undefined && (
                    <span className="font-bold tabular-nums text-slate-700">{fmtMoney(r.amount)}</span>
                  )}
                </div>
              ))}
            </div>

            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : confirmStep ? (
          <div className="space-y-4">
            <div className="rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50/50 dark:bg-emerald-950/20 p-4 space-y-2 text-xs">
              <p className="font-semibold text-sm text-slate-900 dark:text-slate-100">Please confirm bonus parameters:</p>
              <p>• <b>Bonus Type:</b> {titleCase(bonusType)} Bonus</p>
              <p>• <b>Recipients:</b> {mode === "SINGLE" ? "1 Employee" : `${targetCount} Selected/Eligible Employees`}</p>
              <p>• <b>Calculation:</b> {calcType === "PERCENT" ? `${percent}% of ${base} Salary` : fmtMoney(Number(amount))}</p>
              <p>• <b>Target Period:</b> {monthLabel(Number(periodMonth))} {periodYear}</p>
              <p>• <b>Label:</b> {label || "—"}</p>
            </div>

            <p className="text-[11px] text-slate-500">
              Each bonus will be issued in <b>PENDING</b> status and routed for approval before inclusion in payroll calculations.
            </p>

            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmStep(false)} disabled={busy}>Back</Button>
              <Button disabled={busy} onClick={handleSubmit}>
                {busy ? "Creating…" : `Confirm & Create for ${targetCount} Employee(s)`}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Mode selection */}
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Distribution Mode*</Label>
              <Select value={mode} onValueChange={(v: BonusMode) => setMode(v)}>
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL_ELIGIBLE">
                    All Eligible Employees ({eligibleEmployees.length} based on Bonus Policy)
                  </SelectItem>
                  <SelectItem value="SINGLE">Single Specific Employee</SelectItem>
                  <SelectItem value="CUSTOM">Custom Selected Employees</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {mode === "SINGLE" && (
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">Select Employee*</Label>
                <Select value={singleEmpId} onValueChange={setSingleEmpId}>
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue placeholder="Choose employee…" />
                  </SelectTrigger>
                  <SelectContent>
                    {employees.map((e) => (
                      <SelectItem key={e.id} value={e.id}>{e.fullName} ({e.code})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {mode === "CUSTOM" && (
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">Pick Employees ({customEmpIds.length} selected)*</Label>
                <div className="max-h-40 overflow-y-auto border rounded-lg divide-y text-xs">
                  {employees.map((e) => {
                    const checked = customEmpIds.includes(e.id)
                    return (
                      <label key={e.id} className="flex items-center gap-2 p-2 hover:bg-slate-50 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            if (checked) setCustomEmpIds(customEmpIds.filter((id) => id !== e.id))
                            else setCustomEmpIds([...customEmpIds, e.id])
                          }}
                          className="h-3.5 w-3.5 accent-emerald-600"
                        />
                        <span className="font-medium text-slate-800">{e.fullName}</span>
                        <span className="text-[10px] text-slate-400 font-mono">({e.code})</span>
                        {!e.eval?.eligible && (
                          <span className="ml-auto text-[10px] text-amber-600 bg-amber-50 px-1.5 py-0.2 rounded">
                            Policy Ineligible
                          </span>
                        )}
                      </label>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Type & Calculation */}
            <div className="grid sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">Bonus Type*</Label>
                <Select value={bonusType} onValueChange={setBonusType}>
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BONUS_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">Calculation Method*</Label>
                <Select value={calcType} onValueChange={(v: "FIXED" | "PERCENT") => setCalcType(v)}>
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PERCENT">Percentage (%) of Salary</SelectItem>
                    <SelectItem value="FIXED">Fixed Amount (৳)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {calcType === "PERCENT" ? (
              <div className="grid sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold">Salary Base*</Label>
                  <Select value={base} onValueChange={(v: any) => setBase(v)}>
                    <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="BASIC">Basic Salary (Recommended)</SelectItem>
                      <SelectItem value="GROSS">Gross Salary</SelectItem>
                      <SelectItem value="CUSTOM">Custom Uniform Base (৳)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold">Percentage Rate (%)*</Label>
                  <Input
                    type="number"
                    min={1}
                    max={300}
                    value={percent}
                    onChange={(e) => setPercent(e.target.value)}
                    className="h-9 text-sm"
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">Fixed Bonus Amount (৳)*</Label>
                <Input
                  type="number"
                  min={1}
                  placeholder="e.g. 15000"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="h-9 text-sm"
                />
              </div>
            )}

            {calcType === "PERCENT" && base === "CUSTOM" && (
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">Custom Base Amount (৳)*</Label>
                <Input
                  type="number"
                  min={1}
                  placeholder="e.g. 25000"
                  value={customBase}
                  onChange={(e) => setCustomBase(e.target.value)}
                  className="h-9 text-sm"
                />
              </div>
            )}

            {/* Period & Label */}
            <div className="grid sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">Period Month & Year*</Label>
                <div className="flex gap-2">
                  <Select value={periodMonth} onValueChange={setPeriodMonth}>
                    <SelectTrigger className="h-9 text-sm flex-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {MONTHS.map((m, i) => (
                        <SelectItem key={m} value={String(i + 1)}>{m}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    type="number"
                    value={periodYear}
                    onChange={(e) => setPeriodYear(Number(e.target.value))}
                    className="h-9 text-sm w-24"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">Bonus Label / Note</Label>
                <Input
                  placeholder="e.g. Eid-ul-Fitr Bonus 2026"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  className="h-9 text-sm"
                />
              </div>
            </div>

            <DialogFooter className="pt-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button onClick={() => setConfirmStep(true)}>Review & Confirm</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ============================================================================
// BULK APPROVE DIALOG
// ============================================================================
function BulkApproveDialog({
  open,
  onOpenChange,
  rows,
  title,
  onDone,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  rows: any[]
  title: string
  onDone: () => void
}) {
  const toast = useHrm((s) => s.toast)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [typed, setTyped] = useState("")
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<any>(null)

  useEffect(() => {
    if (open) {
      setSelected(new Set(rows.map((r) => r.id)))
      setTyped("")
      setResult(null)
      setBusy(false)
    }
  }, [open, rows])

  const selRows = rows.filter((r) => selected.has(r.id))
  const total = selRows.reduce((s, r) => s + (Number(r.amount) || 0), 0)

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const runDecision = async (decision: "APPROVE" | "REJECT") => {
    setBusy(true)
    try {
      const res = await rpc<any>("bonuses.approveBulk", { ids: [...selected], decision })
      setResult(res)
      onDone()
    } catch (e: any) {
      toast(e.message || "Failed bulk decision", "err")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !busy) onOpenChange(v) }}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            <UserCheck className="h-4 w-4 text-emerald-600" />
            <span>{title}</span>
          </DialogTitle>
        </DialogHeader>

        {result ? (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-1.5">
              <Badge className="bg-emerald-100 text-emerald-700">
                Actioned ({result.decision === "APPROVE" ? "Approved" : "Rejected"}): {result.actioned}
              </Badge>
              {result.escalated?.length > 0 && (
                <Badge className="bg-amber-100 text-amber-700">Escalated: {result.escalated.length}</Badge>
              )}
            </div>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="max-h-56 overflow-y-auto border rounded-lg divide-y text-xs">
              {rows.map((b) => (
                <label key={b.id} className="flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-900">
                  <input
                    type="checkbox"
                    checked={selected.has(b.id)}
                    onChange={() => toggle(b.id)}
                    className="h-3.5 w-3.5 accent-emerald-600"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-slate-800 dark:text-slate-100 truncate">{b.employeeName}</p>
                    <p className="text-[10px] text-slate-400">{b.label || titleCase(b.type)}</p>
                  </div>
                  <span className="font-bold tabular-nums text-slate-800 dark:text-slate-100">{fmtMoney(b.amount)}</span>
                </label>
              ))}
            </div>

            <div className="rounded-xl bg-primary text-white p-3.5 flex items-center justify-between shadow-xs">
              <div>
                <p className="text-[11px] uppercase tracking-wide opacity-80">Selected Total ({selRows.length} rows)</p>
                <p className="text-xl font-bold tabular-nums">{fmtMoney(total)}</p>
              </div>
            </div>

            <div>
              <Label className="text-xs">Type APPROVE to confirm authorization, or REJECT to decline</Label>
              <Input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder="APPROVE"
                className="h-9 mt-1 font-mono uppercase"
              />
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
              <Button
                variant="outline"
                className="text-rose-600 border-rose-200 hover:bg-rose-50"
                disabled={busy || selected.size === 0 || typed.trim().toUpperCase() !== "REJECT"}
                onClick={() => runDecision("REJECT")}
              >
                Reject Selected
              </Button>
              <Button
                disabled={busy || selected.size === 0 || typed.trim().toUpperCase() !== "APPROVE"}
                onClick={() => runDecision("APPROVE")}
              >
                Approve {fmtMoney(total)}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
