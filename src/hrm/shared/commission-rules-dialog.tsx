"use client"
// ============ Commission Rule Setup Dialogs & Bulk Threshold Import (spec §1, §2, §4) ============
import { useEffect, useState, useRef, useMemo } from "react"
import {
  Coins, Plus, Pencil, Trash2, Download, Upload, CheckCircle2, XCircle, AlertTriangle,
  FileSpreadsheet, ShieldCheck, Clock, Layers, RefreshCw,
  Sparkles, ClipboardPaste, Search, ChevronLeft, ChevronRight,
  Settings,
} from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useHrm } from "../store"
import { useApi, rpc, useEmployeeDirectory } from "../api"
import { fmtMoney, fmtDate, fmtDateTime, titleCase, StatusBadge } from "./ui-kit"
import { DataTable, type Column } from "./data-table"
import { ConfirmDialog } from "./form-dialog"

export interface CommissionRuleRow {
  id: string
  name: string
  calculationPeriod: "MONTHLY" | "QUARTERLY" | "HALF_YEARLY" | "YEARLY"
  effectiveFrom: string
  effectiveTo?: string | null
  active: boolean
  basis: "PERCENT_OF_SALES" | "FLAT"
  percentMethod?: "TOTAL_REVENUE" | "REVENUE_EXCEEDING_TARGET" | null
  flatMethod?: "PER_EMPLOYEE" | "TOTAL_POOL" | null
  rate: number
  distributionMethod?: "EQUAL" | "SALARY_PRO_RATA" | null
  minServicePeriodValue: number
  minServicePeriodUnit: "DAYS" | "MONTHS" | "YEARS"
  requireTotalTarget: boolean
  requireBranchTarget: boolean
  requireDeptTarget: boolean
  requireEmpTarget: boolean
  cap: number
  status: "DRAFT" | "PENDING_APPROVAL" | "ACTIVE" | "INACTIVE" | "REJECTED"
  branchId?: string | null
  departmentId?: string | null
  designationId?: string | null
  branchName?: string | null
  departmentName?: string | null
  designationName?: string | null
  eligibleStatuses?: string[] | null
  thresholds?: any[]
  thresholdImports?: any[]
  version?: number
  createdAt?: string
}

// All employee status options for multi-select
const EMP_STATUS_OPTIONS: { value: string; label: string; desc: string; color: string }[] = [
  { value: "ACTIVE", label: "Active", desc: "Currently employed and active", color: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" },
  { value: "PROBATION", label: "Probation", desc: "Serving probationary period", color: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300" },
  { value: "ON_LEAVE", label: "On Leave", desc: "On approved leave", color: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300" },
  { value: "SUSPENDED", label: "Suspended", desc: "Temporarily suspended", color: "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300" },
  { value: "RESIGNED", label: "Resigned", desc: "Submitted resignation / serving notice", color: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300" },
  { value: "TERMINATED", label: "Terminated", desc: "Employment terminated by organization", color: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300" },
  { value: "RETIRED", label: "Retired", desc: "Retired from service", color: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300" },
  { value: "INACTIVE", label: "Inactive", desc: "Deactivated / long-term absent", color: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400" },
]

// ----------------------------------------------------------------------------------
// Main Commission Rules Management Dialog
// ----------------------------------------------------------------------------------
export function CommissionRulesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { can } = useHrm()
  const { data, loading, error, reload } = useApi<CommissionRuleRow[]>(open ? "commissionRules.list" : null, {})
  const [filterPeriod, setFilterPeriod] = useState<string>("ALL")
  const [editRule, setEditRule] = useState<CommissionRuleRow | null | { isNew: true }>(null)
  const [importRule, setImportRule] = useState<CommissionRuleRow | null>(null)
  const [delRule, setDelRule] = useState<CommissionRuleRow | null>(null)
  const [selectedRuleDetail, setSelectedRuleDetail] = useState<CommissionRuleRow | null>(null)

  const rows = (data || []).filter((r) => filterPeriod === "ALL" || r.calculationPeriod === filterPeriod)

  const columns: Column<CommissionRuleRow>[] = [
    {
      key: "name",
      label: "Rule Name & Details",
      sortValue: (r) => r.name,
      render: (r) => (
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-slate-800 dark:text-slate-100">{r.name}</span>
            <Badge variant="outline" className="text-[10px] font-mono">{r.calculationPeriod}</Badge>
          </div>
          <p className="text-[11px] text-slate-500">
            {r.basis === "PERCENT_OF_SALES" ? (
              <span>
                <b>{r.rate}%</b> of {r.percentMethod === "REVENUE_EXCEEDING_TARGET" ? "Revenue Exceeding Target" : "Total Revenue"}
              </span>
            ) : (
              <span>
                Flat <b>৳{fmtMoney(r.rate)}</b> ({r.flatMethod === "TOTAL_POOL" ? "Total Pool" : "Per Employee"})
              </span>
            )}
            {r.distributionMethod && (
              <span className="ml-1.5 text-slate-400">
                · {r.distributionMethod === "SALARY_PRO_RATA" ? "Salary Pro-rata" : "Equal"} Dist.
              </span>
            )}
          </p>
        </div>
      ),
    },
    {
      key: "effective",
      label: "Effective Window",
      render: (r) => (
        <div className="text-xs text-slate-600 dark:text-slate-300">
          <div>From: <span className="font-medium text-slate-800 dark:text-slate-200">{fmtDate(r.effectiveFrom)}</span></div>
          <div className="text-[11px] text-slate-400">
            To: {r.effectiveTo ? fmtDate(r.effectiveTo) : <span className="italic text-emerald-600 dark:text-emerald-400">Open-ended</span>}
          </div>
        </div>
      ),
    },
    {
      key: "eligibility",
      label: "Eligibility & Targets",
      render: (r) => {
        const targets: string[] = []
        if (r.requireEmpTarget) targets.push("Emp")
        if (r.requireDeptTarget) targets.push("Dept")
        if (r.requireBranchTarget) targets.push("Branch")
        if (r.requireTotalTarget) targets.push("Total")
        return (
          <div className="text-xs text-slate-600 dark:text-slate-300 space-y-0.5">
            <div>
              Service: <span className="font-semibold text-slate-700 dark:text-slate-200">{r.minServicePeriodValue} {titleCase(r.minServicePeriodUnit)}</span>
            </div>
            <div className="text-[11px] text-slate-500">
              Targets: {targets.length > 0 ? (
                <span className="text-emerald-700 dark:text-emerald-400 font-medium">{targets.join(" > ")}</span>
              ) : (
                <span className="text-slate-400 italic">None required</span>
              )}
            </div>
          </div>
        )
      },
    },
    {
      key: "cap",
      label: "Total Cap",
      align: "right",
      render: (r) => (
        <div className="text-xs text-right">
          {r.cap > 0 ? (
            <span className="font-semibold text-slate-700 dark:text-slate-200 tabular-nums">৳{fmtMoney(r.cap)}</span>
          ) : (
            <span className="text-slate-400 italic text-[11px]">Uncapped</span>
          )}
        </div>
      ),
    },
    {
      key: "status",
      label: "Status",
      render: (r) => (
        <div className="flex flex-col gap-1 items-start">
          {r.active ? (
            <Badge className="bg-emerald-100 text-emerald-700 text-[10px]">Active</Badge>
          ) : (
            <Badge variant="outline" className="text-slate-400 text-[10px]">Inactive</Badge>
          )}
          {r.status && r.status !== "ACTIVE" && (
            <Badge variant="secondary" className="text-[9px]">{titleCase(r.status)}</Badge>
          )}
        </div>
      ),
    },
    {
      key: "actions",
      label: "Actions",
      align: "right",
      render: (r) => (
        <div className="flex items-center justify-end gap-1">
          {can("bonus", "create") && (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-slate-600 hover:text-slate-900"
              onClick={(e) => {
                e.stopPropagation()
                setEditRule(r)
              }}
              title="Edit Rule"
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          )}
          {can("bonus", "approve") && (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-slate-400 hover:text-rose-600"
              onClick={(e) => {
                e.stopPropagation()
                setDelRule(r)
              }}
              title="Delete or Deactivate Rule"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      ),
    },
  ]

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) reload() }}>
      <DialogContent className="sm:max-w-4xl max-h-[92dvh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <DialogTitle className="text-base flex items-center gap-2">
              <Coins className="h-5 w-5 text-emerald-600" /> Commission Rule Setup
            </DialogTitle>
            {can("bonus", "create") && (
              <Button size="sm" onClick={() => setEditRule({ isNew: true })} className="h-8 text-xs">
                <Plus className="h-3.5 w-3.5 mr-1" /> New Commission Rule
              </Button>
            )}
          </div>
          <DialogDescription className="text-xs text-slate-500">
            Define calculation bases (Percentage or Flat), revenue target hierarchies, minimum service periods,
            distribution methods, total pool caps, and bulk-imported revenue thresholds.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500 font-medium">Filter Period:</span>
            <Select value={filterPeriod} onValueChange={setFilterPeriod}>
              <SelectTrigger className="w-36 h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All Periods</SelectItem>
                <SelectItem value="MONTHLY">Monthly</SelectItem>
                <SelectItem value="QUARTERLY">Quarterly</SelectItem>
                <SelectItem value="HALF_YEARLY">Half-Yearly</SelectItem>
                <SelectItem value="YEARLY">Yearly</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button size="sm" variant="ghost" onClick={() => reload()} className="h-7 text-xs text-slate-500">
            <RefreshCw className="h-3 w-3 mr-1" /> Refresh
          </Button>
        </div>

        <DataTable
          columns={columns}
          rows={rows}
          loading={loading}
          error={error}
          pageSize={6}
          csvName="commission-rules"
          searchPlaceholder="Search rules by name, period, scope…"
          emptyTitle="No commission rules configured"
          emptyHint="Click 'New Commission Rule' to set up percentage or flat commission schemes."
          onRowClick={(r) => setSelectedRuleDetail(r)}
        />

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

        {editRule && (
          <CommissionRuleFormDialog
            open={!!editRule}
            rule={"isNew" in editRule ? null : editRule}
            onOpenChange={(v) => { if (!v) setEditRule(null) }}
            onSaved={() => { setEditRule(null); reload() }}
          />
        )}

        {importRule && (
          <BulkThresholdImportDialog
            open={!!importRule}
            rule={importRule}
            onOpenChange={(v) => { if (!v) setImportRule(null) }}
            onUpdated={() => { reload() }}
          />
        )}

        <ConfirmDialog
          open={!!delRule}
          onOpenChange={(v) => { if (!v) setDelRule(null) }}
          title="Delete / Deactivate Rule"
          message={
            delRule
              ? `Are you sure you want to delete "${delRule.name}"? If historical commission calculations reference this rule, it will be safely deactivated instead of deleted.`
              : ""
          }
          confirmLabel="Proceed"
          danger
          onConfirm={async () => {
            if (!delRule) return
            await rpc("commissionRules.delete", { id: delRule.id })
            setDelRule(null)
            reload()
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

// ----------------------------------------------------------------------------------
// Section 1: Commission Rule Setup Form (Full Spec Form)
// ----------------------------------------------------------------------------------
interface FormProps {
  open: boolean
  rule?: CommissionRuleRow | null
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}

export function CommissionRuleFormDialog({ open, rule, onOpenChange, onSaved }: FormProps) {
  const toast = useHrm((s) => s.toast)
  const [busy, setBusy] = useState(false)

  // Scope lists
  const { data: branches } = useApi<any[]>(open ? "branches.list" : null, {})
  const { data: departments } = useApi<any[]>(open ? "departments.list" : null, {})
  const { data: designations } = useApi<any[]>(open ? "designations.list" : null, {})

  // Section A: Basic Information
  const [name, setName] = useState(rule?.name || "")
  const [calculationPeriod, setCalculationPeriod] = useState<string>(rule?.calculationPeriod || "MONTHLY")
  const [effectiveFrom, setEffectiveFrom] = useState(
    rule?.effectiveFrom ? rule.effectiveFrom.slice(0, 10) : new Date().toISOString().slice(0, 10)
  )
  const [effectiveTo, setEffectiveTo] = useState(rule?.effectiveTo ? rule.effectiveTo.slice(0, 10) : "")
  const [active, setActive] = useState(rule?.active !== undefined ? rule.active : true)

  // Section B: Commission Calculation
  const [basis, setBasis] = useState<"PERCENT_OF_SALES" | "FLAT">(rule?.basis || "PERCENT_OF_SALES")
  const [rate, setRate] = useState<string>(rule?.rate !== undefined ? String(rule.rate) : "5")
  const [percentMethod, setPercentMethod] = useState<string>(rule?.percentMethod || "TOTAL_REVENUE")
  const [flatMethod, setFlatMethod] = useState<string>(rule?.flatMethod || "PER_EMPLOYEE")

  // Section C: Eligibility Criteria & Revenue Targets
  const [minServicePeriodValue, setMinServicePeriodValue] = useState<string>(
    rule?.minServicePeriodValue !== undefined ? String(rule.minServicePeriodValue) : "0"
  )
  const [minServicePeriodUnit, setMinServicePeriodUnit] = useState<string>(rule?.minServicePeriodUnit || "MONTHS")
  const [requireTotalTarget, setRequireTotalTarget] = useState(Boolean(rule?.requireTotalTarget))
  const [requireBranchTarget, setRequireBranchTarget] = useState(Boolean(rule?.requireBranchTarget))
  const [requireDeptTarget, setRequireDeptTarget] = useState(Boolean(rule?.requireDeptTarget))
  const [requireEmpTarget, setRequireEmpTarget] = useState(Boolean(rule?.requireEmpTarget))

  // Section E: Total Commission Cap
  const [cap, setCap] = useState<string>(rule?.cap ? String(rule.cap) : "0")

  // Section F: Commission Distribution Method
  const [distributionMethod, setDistributionMethod] = useState<string>(rule?.distributionMethod || "EQUAL")

  // Scope filters
  const [branchId, setBranchId] = useState<string>(rule?.branchId || "")
  const [departmentId, setDepartmentId] = useState<string>(rule?.departmentId || "")
  const [designationId, setDesignationId] = useState<string>(rule?.designationId || "")

  // Eligible employee statuses (multi-select)
  const [eligibleStatuses, setEligibleStatuses] = useState<string[]>(() => {
    if (rule?.eligibleStatuses && Array.isArray(rule.eligibleStatuses) && rule.eligibleStatuses.length > 0) {
      return rule.eligibleStatuses
    }
    return ["ACTIVE", "PROBATION"]
  })

  const [mainTab, setMainTab] = useState<"config" | "thresholds">("config")
  const [savedRuleId, setSavedRuleId] = useState<string | null>(rule?.id || null)
  const effectiveRuleId = rule?.id || savedRuleId

  // Sync state if rule changes
  useEffect(() => {
    if (rule) {
      setSavedRuleId(rule.id || null)
      setName(rule.name || "")
      setCalculationPeriod(rule.calculationPeriod || "MONTHLY")
      setEffectiveFrom(rule.effectiveFrom ? rule.effectiveFrom.slice(0, 10) : new Date().toISOString().slice(0, 10))
      setEffectiveTo(rule.effectiveTo ? rule.effectiveTo.slice(0, 10) : "")
      setActive(rule.active !== false)
      setBasis(rule.basis || "PERCENT_OF_SALES")
      setRate(String(rule.rate || 0))
      setPercentMethod(rule.percentMethod || "TOTAL_REVENUE")
      setFlatMethod(rule.flatMethod || "PER_EMPLOYEE")
      setMinServicePeriodValue(String(rule.minServicePeriodValue || 0))
      setMinServicePeriodUnit(rule.minServicePeriodUnit || "MONTHS")
      setRequireTotalTarget(Boolean(rule.requireTotalTarget))
      setRequireBranchTarget(Boolean(rule.requireBranchTarget))
      setRequireDeptTarget(Boolean(rule.requireDeptTarget))
      setRequireEmpTarget(Boolean(rule.requireEmpTarget))
      setCap(String(rule.cap || 0))
      setDistributionMethod(rule.distributionMethod || "EQUAL")
      setBranchId(rule.branchId || "")
      setDepartmentId(rule.departmentId || "")
      setDesignationId(rule.designationId || "")
      setEligibleStatuses(
        rule.eligibleStatuses && Array.isArray(rule.eligibleStatuses) && rule.eligibleStatuses.length > 0
          ? rule.eligibleStatuses
          : ["ACTIVE", "PROBATION"]
      )
    } else {
      setSavedRuleId(null)
      setMainTab("config")
    }
  }, [rule])

  // Calculation Basis change handler with conditional clearing
  const handleBasisChange = (newBasis: "PERCENT_OF_SALES" | "FLAT") => {
    setBasis(newBasis)
    if (newBasis === "PERCENT_OF_SALES") {
      setFlatMethod("")
      if (!percentMethod) setPercentMethod("TOTAL_REVENUE")
      if (!distributionMethod) setDistributionMethod("EQUAL")
    } else {
      setPercentMethod("")
      if (!flatMethod) setFlatMethod("PER_EMPLOYEE")
      // Distribution method is only required if flatMethod is TOTAL_POOL
      if (flatMethod === "PER_EMPLOYEE") {
        setDistributionMethod("")
      }
    }
  }

  // Flat method change handler with conditional clearing
  const handleFlatMethodChange = (newFlatMethod: string) => {
    setFlatMethod(newFlatMethod)
    if (newFlatMethod === "TOTAL_POOL") {
      if (!distributionMethod) setDistributionMethod("EQUAL")
    } else {
      setDistributionMethod("")
    }
  }

  const showDistribution = basis === "PERCENT_OF_SALES" || (basis === "FLAT" && flatMethod === "TOTAL_POOL")

  const handleSubmit = async (submitForApproval = false): Promise<string | null> => {
    // Basic validations
    if (!name.trim()) {
      toast("Please enter a rule name", "err")
      return null
    }
    if (!effectiveFrom) {
      toast("Effective From date is required", "err")
      return null
    }
    if (effectiveTo && effectiveTo < effectiveFrom) {
      toast("Effective To date cannot precede Effective From date", "err")
      return null
    }
    const numRate = Number(rate)
    if (isNaN(numRate) || numRate < 0) {
      toast("Please enter a valid non-negative rate or amount", "err")
      return null
    }
    if (eligibleStatuses.length === 0) {
      toast("Please select at least one eligible employee status", "err")
      return null
    }
    if (basis === "PERCENT_OF_SALES") {
      if (numRate > 100) {
        toast("Commission rate cannot exceed 100% for percentage basis", "err")
        return null
      }
      if (!percentMethod) {
        toast("Please select a percentage calculation method", "err")
        return null
      }
      if (!distributionMethod) {
        toast("Please select a commission distribution method", "err")
        return null
      }
    } else if (basis === "FLAT") {
      if (!flatMethod) {
        toast("Please select a flat amount calculation method", "err")
        return null
      }
      if (flatMethod === "TOTAL_POOL" && !distributionMethod) {
        toast("Please select a distribution method for total employee pool", "err")
        return null
      }
    }

    setBusy(true)
    try {
      const res = await rpc<any>("commissionRules.save", {
        id: effectiveRuleId || undefined,
        name: name.trim(),
        calculationPeriod,
        effectiveFrom,
        effectiveTo: effectiveTo || null,
        active,
        basis,
        percentMethod: basis === "PERCENT_OF_SALES" ? percentMethod : null,
        flatMethod: basis === "FLAT" ? flatMethod : null,
        rate: numRate,
        distributionMethod: showDistribution ? distributionMethod : null,
        minServicePeriodValue: Math.max(0, parseInt(minServicePeriodValue, 10) || 0),
        minServicePeriodUnit,
        requireTotalTarget,
        requireBranchTarget,
        requireDeptTarget,
        requireEmpTarget,
        cap: Math.max(0, parseFloat(cap) || 0),
        branchId: branchId || null,
        departmentId: departmentId || null,
        designationId: designationId || null,
        eligibleStatuses: eligibleStatuses.length > 0 ? eligibleStatuses : ["ACTIVE", "PROBATION"],
        submitForApproval,
      })
      const newId = res?.id || effectiveRuleId
      if (newId) setSavedRuleId(newId)
      toast(effectiveRuleId ? "Commission rule updated successfully" : "Commission rule created successfully", "ok")
      onSaved()
      return newId
    } catch (e: any) {
      toast(e.message || "Failed to save commission rule", "err")
      return null
    } finally {
      setBusy(false)
    }
  }

  const ensureRuleSaved = async (): Promise<string | null> => {
    if (effectiveRuleId) return effectiveRuleId
    return await handleSubmit(false)
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v) }}>
      <DialogContent className="sm:max-w-4xl max-h-[92dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            <Coins className="h-5 w-5 text-emerald-600" />
            {effectiveRuleId ? `Edit Commission Rule — ${name || rule?.name || "Rule"}` : "New Commission Rule Setup"}
          </DialogTitle>
          <DialogDescription className="text-xs text-slate-500">
            Configure calculation parameters, revenue threshold requirements, service eligibility, and bulk-imported targets.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={mainTab} onValueChange={(v) => setMainTab(v as any)} className="w-full">
          <TabsList className="grid w-full grid-cols-2 mb-3">
            <TabsTrigger value="config" className="text-xs">
              <Settings className="h-3.5 w-3.5 mr-1.5" /> Rule Configuration
            </TabsTrigger>
            <TabsTrigger value="thresholds" className="text-xs">
              <FileSpreadsheet className="h-3.5 w-3.5 mr-1.5" /> Bulk Revenue Thresholds
            </TabsTrigger>
          </TabsList>

          <TabsContent value="config" className="space-y-6 py-1">
          {/* SECTION A: Basic Information */}
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 space-y-3 bg-slate-50/50 dark:bg-slate-900/40">
            <h4 className="text-xs font-bold text-slate-700 dark:text-slate-200 uppercase tracking-wider flex items-center gap-2">
              <span className="w-5 h-5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 flex items-center justify-center text-[10px]">A</span>
              Basic Information
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="sm:col-span-2">
                <Label className="text-xs font-semibold">Rule Name*</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Sales Team Monthly Commission Rule"
                  className="h-8 text-xs mt-1"
                />
              </div>
              <div>
                <Label className="text-xs font-semibold">Calculation Period*</Label>
                <Select value={calculationPeriod} onValueChange={setCalculationPeriod}>
                  <SelectTrigger className="h-8 text-xs mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="MONTHLY">Monthly</SelectItem>
                    <SelectItem value="QUARTERLY">Quarterly</SelectItem>
                    <SelectItem value="HALF_YEARLY">Half-Yearly</SelectItem>
                    <SelectItem value="YEARLY">Yearly</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between pt-5 px-2">
                <div>
                  <Label className="text-xs font-semibold">Active Status*</Label>
                  <p className="text-[11px] text-slate-400">Include in payroll commission calculations</p>
                </div>
                <Switch checked={active} onCheckedChange={setActive} />
              </div>
              <div>
                <Label className="text-xs font-semibold">Effective From*</Label>
                <Input
                  type="date"
                  value={effectiveFrom}
                  onChange={(e) => setEffectiveFrom(e.target.value)}
                  className="h-8 text-xs mt-1 font-mono"
                />
              </div>
              <div>
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-semibold">Effective To</Label>
                  <span className="text-[10px] text-slate-400 italic">Optional (blank = open-ended)</span>
                </div>
                <Input
                  type="date"
                  value={effectiveTo}
                  onChange={(e) => setEffectiveTo(e.target.value)}
                  className="h-8 text-xs mt-1 font-mono"
                />
              </div>
            </div>
          </div>

          {/* SECTION B: Commission Calculation */}
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 space-y-3 bg-slate-50/50 dark:bg-slate-900/40">
            <h4 className="text-xs font-bold text-slate-700 dark:text-slate-200 uppercase tracking-wider flex items-center gap-2">
              <span className="w-5 h-5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 flex items-center justify-center text-[10px]">B</span>
              Commission Calculation
            </h4>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label className="text-xs font-semibold">Calculation Basis*</Label>
                <Select value={basis} onValueChange={(v: any) => handleBasisChange(v)}>
                  <SelectTrigger className="h-8 text-xs mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PERCENT_OF_SALES">Percentage of Sales Revenue</SelectItem>
                    <SelectItem value="FLAT">Flat Amount (Fixed Commission)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label className="text-xs font-semibold">
                  {basis === "PERCENT_OF_SALES" ? "Commission Rate (%)*" : "Fixed Commission Amount (৳)*"}
                </Label>
                <Input
                  type="number"
                  min={0}
                  max={basis === "PERCENT_OF_SALES" ? 100 : undefined}
                  step={basis === "PERCENT_OF_SALES" ? 0.01 : 1}
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                  className="h-8 text-xs mt-1 tabular-nums font-mono"
                />
              </div>

              {/* Conditional: Percentage Calculation Method */}
              {basis === "PERCENT_OF_SALES" && (
                <div className="sm:col-span-2 pt-1">
                  <Label className="text-xs font-semibold">Percentage Calculation Method* (Single Selection)</Label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1.5">
                    <label className={`flex items-start gap-2.5 p-3 rounded-lg border cursor-pointer transition-colors ${percentMethod === "TOTAL_REVENUE" ? "border-emerald-500 bg-emerald-50/50 dark:bg-emerald-950/20" : "border-slate-200 dark:border-slate-800"}`}>
                      <input
                        type="radio"
                        name="percentMethod"
                        value="TOTAL_REVENUE"
                        checked={percentMethod === "TOTAL_REVENUE"}
                        onChange={() => setPercentMethod("TOTAL_REVENUE")}
                        className="mt-0.5 accent-emerald-600"
                      />
                      <div>
                        <span className="text-xs font-semibold block text-slate-800 dark:text-slate-100">1. Total Sales Revenue</span>
                        <span className="text-[11px] text-slate-500 block leading-tight mt-0.5">
                          Commission = Eligible Sales Revenue × Rate / 100
                        </span>
                      </div>
                    </label>

                    <label className={`flex items-start gap-2.5 p-3 rounded-lg border cursor-pointer transition-colors ${percentMethod === "REVENUE_EXCEEDING_TARGET" ? "border-emerald-500 bg-emerald-50/50 dark:bg-emerald-950/20" : "border-slate-200 dark:border-slate-800"}`}>
                      <input
                        type="radio"
                        name="percentMethod"
                        value="REVENUE_EXCEEDING_TARGET"
                        checked={percentMethod === "REVENUE_EXCEEDING_TARGET"}
                        onChange={() => setPercentMethod("REVENUE_EXCEEDING_TARGET")}
                        className="mt-0.5 accent-emerald-600"
                      />
                      <div>
                        <span className="text-xs font-semibold block text-slate-800 dark:text-slate-100">2. Revenue Exceeding Target</span>
                        <span className="text-[11px] text-slate-500 block leading-tight mt-0.5">
                          Commission = MAX(0, Eligible Revenue − Target) × Rate / 100
                        </span>
                      </div>
                    </label>
                  </div>
                </div>
              )}

              {/* Conditional: Flat Amount Calculation Method */}
              {basis === "FLAT" && (
                <div className="sm:col-span-2 pt-1">
                  <Label className="text-xs font-semibold">Flat Amount Calculation Method* (Single Selection)</Label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1.5">
                    <label className={`flex items-start gap-2.5 p-3 rounded-lg border cursor-pointer transition-colors ${flatMethod === "PER_EMPLOYEE" ? "border-emerald-500 bg-emerald-50/50 dark:bg-emerald-950/20" : "border-slate-200 dark:border-slate-800"}`}>
                      <input
                        type="radio"
                        name="flatMethod"
                        value="PER_EMPLOYEE"
                        checked={flatMethod === "PER_EMPLOYEE"}
                        onChange={() => handleFlatMethodChange("PER_EMPLOYEE")}
                        className="mt-0.5 accent-emerald-600"
                      />
                      <div>
                        <span className="text-xs font-semibold block text-slate-800 dark:text-slate-100">Per Employee</span>
                        <span className="text-[11px] text-slate-500 block leading-tight mt-0.5">
                          The specified fixed amount applies to each eligible employee individually.
                        </span>
                      </div>
                    </label>

                    <label className={`flex items-start gap-2.5 p-3 rounded-lg border cursor-pointer transition-colors ${flatMethod === "TOTAL_POOL" ? "border-emerald-500 bg-emerald-50/50 dark:bg-emerald-950/20" : "border-slate-200 dark:border-slate-800"}`}>
                      <input
                        type="radio"
                        name="flatMethod"
                        value="TOTAL_POOL"
                        checked={flatMethod === "TOTAL_POOL"}
                        onChange={() => handleFlatMethodChange("TOTAL_POOL")}
                        className="mt-0.5 accent-emerald-600"
                      />
                      <div>
                        <span className="text-xs font-semibold block text-slate-800 dark:text-slate-100">Total Employee Pool</span>
                        <span className="text-[11px] text-slate-500 block leading-tight mt-0.5">
                          The specified amount is the total pool to distribute among all eligible employees.
                        </span>
                      </div>
                    </label>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* SECTION C: Eligibility Criteria & Revenue Targets */}
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 space-y-3 bg-slate-50/50 dark:bg-slate-900/40">
            <h4 className="text-xs font-bold text-slate-700 dark:text-slate-200 uppercase tracking-wider flex items-center gap-2">
              <span className="w-5 h-5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 flex items-center justify-center text-[10px]">C</span>
              Eligibility Criteria and Revenue Targets
            </h4>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label className="text-xs font-semibold">Minimum Employee Service Period*</Label>
                <div className="flex items-center gap-2 mt-1">
                  <Input
                    type="number"
                    min={0}
                    value={minServicePeriodValue}
                    onChange={(e) => setMinServicePeriodValue(e.target.value)}
                    className="h-8 text-xs w-24 tabular-nums"
                  />
                  <Select value={minServicePeriodUnit} onValueChange={setMinServicePeriodUnit}>
                    <SelectTrigger className="h-8 text-xs flex-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="DAYS">Days</SelectItem>
                      <SelectItem value="MONTHS">Months</SelectItem>
                      <SelectItem value="YEARS">Years</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <p className="text-[10px] text-slate-400 mt-1">Calculated from joining date as of period end date.</p>
              </div>

              <div className="sm:col-span-2 pt-1">
                <Label className="text-xs font-semibold block mb-2">Revenue Target Eligibility Requirements</Label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div className="flex items-center justify-between p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
                    <div>
                      <span className="text-xs font-medium block">Total Revenue Target</span>
                      <span className="text-[10px] text-slate-400">Company-wide minimum target</span>
                    </div>
                    <Switch checked={requireTotalTarget} onCheckedChange={setRequireTotalTarget} />
                  </div>

                  <div className="flex items-center justify-between p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
                    <div>
                      <span className="text-xs font-medium block">Branch-wise Target</span>
                      <span className="text-[10px] text-slate-400">Branch-level approved threshold</span>
                    </div>
                    <Switch checked={requireBranchTarget} onCheckedChange={setRequireBranchTarget} />
                  </div>

                  <div className="flex items-center justify-between p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
                    <div>
                      <span className="text-xs font-medium block">Department-wise Target</span>
                      <span className="text-[10px] text-slate-400">Department-level threshold</span>
                    </div>
                    <Switch checked={requireDeptTarget} onCheckedChange={setRequireDeptTarget} />
                  </div>

                  <div className="flex items-center justify-between p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
                    <div>
                      <span className="text-xs font-medium block">Employee-wise Target</span>
                      <span className="text-[10px] text-slate-400">Individual employee threshold</span>
                    </div>
                    <Switch checked={requireEmpTarget} onCheckedChange={setRequireEmpTarget} />
                  </div>
                </div>

                <div className="mt-2 p-2 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 text-[11px] text-amber-800 dark:text-amber-300">
                  <span className="font-semibold">Target Hierarchy Rule:</span> When multiple targets overlap, deterministic precedence is{" "}
                  <code className="font-mono text-[10px] bg-amber-100 dark:bg-amber-900 px-1 py-0.5 rounded">Employee &gt; Department &gt; Branch &gt; Total</code>. Targets are never added together or subtracted more than once.
                </div>
              </div>
            </div>
          </div>

          {/* SECTION D: Total Commission Cap */}
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 space-y-3 bg-slate-50/50 dark:bg-slate-900/40">
            <h4 className="text-xs font-bold text-slate-700 dark:text-slate-200 uppercase tracking-wider flex items-center gap-2">
              <span className="w-5 h-5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 flex items-center justify-center text-[10px]">D</span>
              Total Commission Cap
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label className="text-xs font-semibold">Total Commission Cap Amount (৳)</Label>
                <Input
                  type="number"
                  min={0}
                  value={cap}
                  onChange={(e) => setCap(e.target.value)}
                  placeholder="0 (Uncapped)"
                  className="h-8 text-xs mt-1 tabular-nums font-mono"
                />
                <p className="text-[10px] text-slate-400 mt-1">
                  Enforced at the rule level across all eligible employees (0 = uncapped).
                </p>
              </div>
            </div>
          </div>

          {/* SECTION E: Commission Distribution Method (Conditional) */}
          {showDistribution && (
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 space-y-3 bg-slate-50/50 dark:bg-slate-900/40">
              <h4 className="text-xs font-bold text-slate-700 dark:text-slate-200 uppercase tracking-wider flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 flex items-center justify-center text-[10px]">E</span>
                Commission Distribution Method*
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1">
                <label className={`flex items-start gap-2.5 p-3 rounded-lg border cursor-pointer transition-colors ${distributionMethod === "EQUAL" ? "border-emerald-500 bg-emerald-50/50 dark:bg-emerald-950/20" : "border-slate-200 dark:border-slate-800"}`}>
                  <input
                    type="radio"
                    name="distributionMethod"
                    value="EQUAL"
                    checked={distributionMethod === "EQUAL"}
                    onChange={() => setDistributionMethod("EQUAL")}
                    className="mt-0.5 accent-emerald-600"
                  />
                  <div>
                    <span className="text-xs font-semibold block text-slate-800 dark:text-slate-100">1. Employee-wise Equal Distribution</span>
                    <span className="text-[11px] text-slate-500 block leading-tight mt-0.5">
                      Divide the distributable commission pool equally among all eligible employees.
                    </span>
                  </div>
                </label>

                <label className={`flex items-start gap-2.5 p-3 rounded-lg border cursor-pointer transition-colors ${distributionMethod === "SALARY_PRO_RATA" ? "border-emerald-500 bg-emerald-50/50 dark:bg-emerald-950/20" : "border-slate-200 dark:border-slate-800"}`}>
                  <input
                    type="radio"
                    name="distributionMethod"
                    value="SALARY_PRO_RATA"
                    checked={distributionMethod === "SALARY_PRO_RATA"}
                    onChange={() => setDistributionMethod("SALARY_PRO_RATA")}
                    className="mt-0.5 accent-emerald-600"
                  />
                  <div>
                    <span className="text-xs font-semibold block text-slate-800 dark:text-slate-100">2. Salary-wise Pro-rata Distribution</span>
                    <span className="text-[11px] text-slate-500 block leading-tight mt-0.5">
                      Distribute the pool in proportion to eligible employees&apos; active basic salaries, reconciling rounding remainder.
                    </span>
                  </div>
                </label>
              </div>
            </div>
          )}

          {/* SECTION F: Eligible Employee Statuses */}
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 space-y-3 bg-slate-50/50 dark:bg-slate-900/40">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-bold text-slate-700 dark:text-slate-200 uppercase tracking-wider flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 flex items-center justify-center text-[10px]">F</span>
                Eligible Employee Types
              </h4>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline"
                  onClick={() => setEligibleStatuses(EMP_STATUS_OPTIONS.map((o) => o.value))}
                >
                  Select All
                </button>
                <span className="text-slate-300 dark:text-slate-600 text-xs">|</span>
                <button
                  type="button"
                  className="text-[11px] text-slate-400 hover:text-rose-600 hover:underline"
                  onClick={() => setEligibleStatuses(["ACTIVE", "PROBATION"])}
                >
                  Reset to Default
                </button>
              </div>
            </div>

            <p className="text-[11px] text-slate-500 -mt-1">
              Select which employment statuses qualify for commission under this rule. Only employees with a matching status at the time of calculation will be included.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
              {EMP_STATUS_OPTIONS.map((opt) => {
                const checked = eligibleStatuses.includes(opt.value)
                return (
                  <label
                    key={opt.value}
                    className={`flex items-start gap-2.5 p-2.5 rounded-lg border cursor-pointer transition-all select-none ${
                      checked
                        ? "border-emerald-400 dark:border-emerald-700 bg-emerald-50/60 dark:bg-emerald-950/30 ring-1 ring-emerald-300 dark:ring-emerald-800"
                        : "border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-300 dark:hover:border-slate-700"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setEligibleStatuses((prev) => [...prev, opt.value])
                        } else {
                          // Prevent deselecting all
                          if (eligibleStatuses.length <= 1) return
                          setEligibleStatuses((prev) => prev.filter((s) => s !== opt.value))
                        }
                      }}
                      className="mt-0.5 accent-emerald-600 shrink-0"
                    />
                    <div className="min-w-0">
                      <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold leading-tight mb-0.5 ${opt.color}`}>
                        {opt.label}
                      </span>
                      <p className="text-[10px] text-slate-500 dark:text-slate-400 leading-tight">{opt.desc}</p>
                    </div>
                  </label>
                )
              })}
            </div>

            {eligibleStatuses.length === 0 && (
              <p className="text-[11px] text-rose-500 dark:text-rose-400 font-medium">
                ⚠ At least one employee status must be selected.
              </p>
            )}

            <div className="flex flex-wrap gap-1.5 pt-1">
              <span className="text-[10px] text-slate-400 font-medium">Currently selected:</span>
              {eligibleStatuses.length === 0 ? (
                <span className="text-[10px] text-rose-500">None</span>
              ) : (
                eligibleStatuses.map((s) => {
                  const opt = EMP_STATUS_OPTIONS.find((o) => o.value === s)
                  return (
                    <span key={s} className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold ${opt?.color || "bg-slate-100 text-slate-600"}`}>
                      {opt?.label || s}
                      <button
                        type="button"
                        aria-label={`Remove ${s}`}
                        className="opacity-60 hover:opacity-100"
                        onClick={() => {
                          if (eligibleStatuses.length <= 1) return
                          setEligibleStatuses((prev) => prev.filter((x) => x !== s))
                        }}
                      >
                        ×
                      </button>
                    </span>
                  )
                })
              )}
            </div>
          </div>

          {/* Optional Scope Scoping */}
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 space-y-3 bg-slate-50/50 dark:bg-slate-900/40">
            <h4 className="text-xs font-bold text-slate-700 dark:text-slate-200 uppercase tracking-wider flex items-center gap-2">
              <Layers className="h-4 w-4 text-slate-500" />
              Rule Scope (Optional)
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <Label className="text-xs font-medium">Branch Scope</Label>
                <Select value={branchId} onValueChange={setBranchId}>
                  <SelectTrigger className="h-8 text-xs mt-1">
                    <SelectValue placeholder="All Branches" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">All Branches</SelectItem>
                    {(branches || []).map((b) => (
                      <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label className="text-xs font-medium">Department Scope</Label>
                <Select value={departmentId} onValueChange={setDepartmentId}>
                  <SelectTrigger className="h-8 text-xs mt-1">
                    <SelectValue placeholder="All Departments" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">All Departments</SelectItem>
                    {(departments || []).map((d) => (
                      <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label className="text-xs font-medium">Designation Scope</Label>
                <Select value={designationId} onValueChange={setDesignationId}>
                  <SelectTrigger className="h-8 text-xs mt-1">
                    <SelectValue placeholder="All Designations" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">All Designations</SelectItem>
                    {(designations || []).map((d) => (
                      <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          {/* Threshold Quick-Action Banner */}
          <div className="rounded-lg border border-dashed border-emerald-300 dark:border-emerald-800/60 p-4 bg-emerald-50/50 dark:bg-emerald-950/20 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h5 className="text-xs font-bold text-emerald-900 dark:text-emerald-200 flex items-center gap-1.5">
                <FileSpreadsheet className="h-4 w-4 text-emerald-600" /> Bulk Revenue Threshold Setup
              </h5>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                Download the Excel template with eligible employees, upload completed target figures, and submit for authorization.
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setMainTab("thresholds")}
              className="h-8 text-xs border-emerald-300 text-emerald-700 hover:bg-emerald-100/60 dark:hover:bg-emerald-950/40"
            >
              Configure Revenue Thresholds &rarr;
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="thresholds" className="py-1">
          <BulkRevenueThresholdsProcess
            ruleId={effectiveRuleId}
            ruleName={name || rule?.name}
            branchId={branchId}
            departmentId={departmentId}
            designationId={designationId}
            minServicePeriodValue={minServicePeriodValue}
            minServicePeriodUnit={minServicePeriodUnit}
            eligibleStatuses={eligibleStatuses}
            onEnsureRuleSaved={ensureRuleSaved}
            onUpdated={onSaved}
          />
        </TabsContent>
      </Tabs>

      <DialogFooter className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy} className="h-8 text-xs">
          {mainTab === "thresholds" ? "Close" : "Cancel"}
        </Button>
        <div className="flex items-center gap-2">
          {mainTab === "thresholds" ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => setMainTab("config")}
              className="h-8 text-xs"
            >
              &larr; Back to Rule Setup
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => handleSubmit(true)}
                disabled={busy}
                className="h-8 text-xs border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-950/40"
              >
                <ShieldCheck className="h-3.5 w-3.5 mr-1" /> Save &amp; Submit for Approval
              </Button>
              <Button type="button" onClick={() => handleSubmit(false)} disabled={busy} className="h-8 text-xs">
                {busy ? "Saving…" : effectiveRuleId ? "Update Rule" : "Create Rule"}
              </Button>
            </>
          )}
        </div>
      </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ----------------------------------------------------------------------------------
// Section 1.D: Bulk Threshold Import Process & Dialogs (Template, Upload, Preview, Approval)
// ----------------------------------------------------------------------------------
export interface BulkRevenueThresholdsProcessProps {
  ruleId?: string | null
  ruleName?: string
  branchId?: string
  departmentId?: string
  designationId?: string
  minServicePeriodValue?: string | number
  minServicePeriodUnit?: string
  eligibleStatuses?: string[]
  onEnsureRuleSaved?: () => Promise<string | null>
  onUpdated?: () => void
}

export function BulkRevenueThresholdsProcess({
  ruleId,
  ruleName,
  branchId,
  departmentId,
  designationId,
  minServicePeriodValue,
  minServicePeriodUnit,
  eligibleStatuses,
  onEnsureRuleSaved,
  onUpdated,
}: BulkRevenueThresholdsProcessProps) {
  const { can } = useHrm()
  const toast = useHrm((s) => s.toast)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const [activeTab, setActiveTab] = useState("import")
  const [busy, setBusy] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [selectedFileName, setSelectedFileName] = useState("")
  const [fileBase64, setFileBase64] = useState<string | null>(null)
  const [previewResult, setPreviewResult] = useState<{
    validRows: number
    invalidRows: number
    totalRows: number
    errors: string[]
    preview: Array<{
      rowNumber: number
      targetType: string
      targetIdentifier: string
      thresholdAmount: number
      valid: boolean
      error?: string
      resolvedName?: string
    }>
  } | null>(null)

  // Load latest thresholds and imports for this rule
  const { data: ruleDetails, reload: reloadDetails } = useApi<CommissionRuleRow[]>(
    ruleId ? "commissionRules.list" : null,
    {}
  )

  const currentRule = (ruleDetails || []).find((r) => r.id === ruleId)
  const approvedThresholds = currentRule?.thresholds || []
  const importHistory = currentRule?.thresholdImports || []

  // Download Excel Template
  const handleDownloadTemplate = async () => {
    setDownloading(true)
    try {
      const res = await rpc<{ fileName: string; base64: string; contentType: string }>(
        "commissionRules.thresholdTemplate",
        {
          ruleId: ruleId || undefined,
          name: ruleName || currentRule?.name || "Commission Thresholds",
          branchId: branchId || undefined,
          departmentId: departmentId || undefined,
          designationId: designationId || undefined,
          minServicePeriodValue: minServicePeriodValue ? Number(minServicePeriodValue) : 0,
          minServicePeriodUnit: minServicePeriodUnit || "MONTHS",
          eligibleStatuses: eligibleStatuses || ["ACTIVE", "PROBATION"],
        }
      )
      const byteCharacters = atob(res.base64)
      const byteNumbers = new Array(byteCharacters.length)
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i)
      }
      const byteArray = new Uint8Array(byteNumbers)
      const blob = new Blob([byteArray], { type: res.contentType })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = res.fileName
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      toast("Threshold template downloaded with eligible employees", "ok")
    } catch (e: any) {
      toast(e.message || "Failed to download template", "err")
    } finally {
      setDownloading(false)
    }
  }

  // Handle file selection & preview
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setSelectedFileName(file.name)
    setBusy(true)

    try {
      let targetRuleId = ruleId
      if (!targetRuleId && onEnsureRuleSaved) {
        targetRuleId = await onEnsureRuleSaved()
        if (!targetRuleId) {
          setBusy(false)
          return
        }
      }
      if (!targetRuleId) {
        toast("Please save the rule first before uploading thresholds", "err")
        setBusy(false)
        return
      }

      const reader = new FileReader()
      reader.onload = async (event) => {
        const resultStr = event.target?.result as string
        const base64Data = resultStr.includes(",") ? resultStr.split(",")[1] : resultStr
        setFileBase64(base64Data)

        try {
          const preview = await rpc<any>("commissionRules.importPreview", {
            ruleId: targetRuleId,
            base64: base64Data,
          })
          setPreviewResult(preview)
          toast(`Preview loaded: ${preview.validRows} valid, ${preview.invalidRows} invalid`, "ok")
        } catch (err: any) {
          toast(err.message || "Validation failed", "err")
          setPreviewResult(null)
        } finally {
          setBusy(false)
        }
      }
      reader.readAsDataURL(file)
    } catch (_e: any) {
      toast("Failed to read file", "err")
      setBusy(false)
    }
  }

  // Submit Bulk Thresholds for Approval
  const handleSubmitForApproval = async () => {
    if (!fileBase64 || !previewResult) {
      toast("Please upload a validated Excel file first", "err")
      return
    }
    if (previewResult.validRows === 0) {
      toast("Cannot submit: 0 valid threshold records found", "err")
      return
    }

    let targetRuleId = ruleId
    if (!targetRuleId && onEnsureRuleSaved) {
      targetRuleId = await onEnsureRuleSaved()
    }
    if (!targetRuleId) {
      toast("Cannot submit: rule must be saved first", "err")
      return
    }

    setBusy(true)
    try {
      const res = await rpc<any>("commissionRules.importSubmit", {
        ruleId: targetRuleId,
        fileName: selectedFileName,
        base64: fileBase64,
      })
      toast(
        res.status === "PENDING"
          ? "Threshold import submitted for authorization. Calculations will not be affected until approved."
          : "Threshold import processed successfully",
        "ok"
      )
      setPreviewResult(null)
      setSelectedFileName("")
      setFileBase64(null)
      if (fileInputRef.current) fileInputRef.current.value = ""
      reloadDetails()
      if (onUpdated) onUpdated()
      setActiveTab("history")
    } catch (e: any) {
      toast(e.message || "Failed to submit threshold import", "err")
    } finally {
      setBusy(false)
    }
  }

  // Direct approve/reject import batch
  const handleDecideImport = async (importId: string, decision: "APPROVE" | "REJECT") => {
    setBusy(true)
    try {
      await rpc("commissionRules.importDecide", {
        importId,
        decision,
      })
      toast(`Import batch ${decision === "APPROVE" ? "approved & activated" : "rejected"}`, "ok")
      reloadDetails()
      if (onUpdated) onUpdated()
    } catch (e: any) {
      toast(e.message || "Failed to process import decision", "err")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between text-xs text-slate-500">
        <p>
          Download the multi-worksheet template, upload completed threshold figures, validate in real-time,
          and submit for authorization before production calculations apply them.
        </p>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="pt-1">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="import" className="text-xs">
            <Upload className="h-3.5 w-3.5 mr-1.5" /> Template &amp; Import
          </TabsTrigger>
          <TabsTrigger value="thresholds" className="text-xs">
            <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" /> Approved Thresholds ({approvedThresholds.length})
          </TabsTrigger>
          <TabsTrigger value="history" className="text-xs">
            <Clock className="h-3.5 w-3.5 mr-1.5" /> Import Batches &amp; Status ({importHistory.length})
          </TabsTrigger>
        </TabsList>

        {/* TAB 1: Template & Import */}
        <TabsContent value="import" className="space-y-4 pt-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Step 1: Download */}
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 bg-slate-50/50 dark:bg-slate-900/40 flex flex-col justify-between">
              <div>
                <h4 className="text-xs font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
                  <span className="w-4 h-4 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center text-[10px] font-bold">1</span>
                  Download Excel Template
                </h4>
                <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">
                  Pre-populated with Total, Branches, Departments, and only eligible Employees as per rule.
                  The threshold amount column is blank for entering figures.
                </p>
              </div>
              <div className="pt-3">
                <Button
                  size="sm"
                  type="button"
                  variant="outline"
                  onClick={handleDownloadTemplate}
                  disabled={downloading}
                  className="h-8 text-xs border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-950/40"
                >
                  <Download className="h-3.5 w-3.5 mr-1.5" />
                  {downloading ? "Preparing Excel…" : "Download Excel Template (.xlsx)"}
                </Button>
              </div>
            </div>

            {/* Step 2: Upload */}
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 bg-slate-50/50 dark:bg-slate-900/40 flex flex-col justify-between">
              <div>
                <h4 className="text-xs font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
                  <span className="w-4 h-4 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center text-[10px] font-bold">2</span>
                  Upload Completed File
                </h4>
                <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">
                  Select your completed Excel file to validate row types, identifier codes, duplicates, and threshold amounts.
                </p>
              </div>
              <div className="pt-3">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  className="hidden"
                  onChange={handleFileChange}
                />
                <Button
                  size="sm"
                  type="button"
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={busy}
                  className="h-8 text-xs"
                >
                  <Upload className="h-3.5 w-3.5 mr-1.5" />
                  {selectedFileName ? "Change File" : "Choose Excel File"}
                </Button>
                {selectedFileName && (
                  <span className="text-[11px] text-slate-600 dark:text-slate-300 ml-2 font-mono truncate">
                    {selectedFileName}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Step 3: Real-time Validation Preview */}
          {previewResult && (
            <div className="space-y-3 pt-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">Validation Preview:</span>
                  <Badge className="bg-emerald-100 text-emerald-700 text-[10px]">{previewResult.validRows} Valid Rows</Badge>
                  {previewResult.invalidRows > 0 && (
                    <Badge className="bg-rose-100 text-rose-700 text-[10px]">{previewResult.invalidRows} Invalid Rows</Badge>
                  )}
                  <Badge variant="outline" className="text-[10px]">{previewResult.totalRows} Total</Badge>
                </div>
                {can("bonus", "import") && (
                  <Button
                    size="sm"
                    type="button"
                    onClick={handleSubmitForApproval}
                    disabled={busy || previewResult.validRows === 0}
                    className="h-8 text-xs"
                  >
                    <ShieldCheck className="h-3.5 w-3.5 mr-1.5" />
                    Submit {previewResult.validRows} Record(s) for Approval
                  </Button>
                )}
              </div>

              <div className="max-h-64 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800">
                <div className="bg-slate-100 dark:bg-slate-800/60 px-3 py-1.5 text-[10px] font-semibold text-slate-600 dark:text-slate-300 grid grid-cols-12 gap-2">
                  <span className="col-span-1">Row</span>
                  <span className="col-span-2">Target Type</span>
                  <span className="col-span-3">Target Name / Code</span>
                  <span className="col-span-2 text-right">Threshold (৳)</span>
                  <span className="col-span-4">Status &amp; Feedback</span>
                </div>
                {previewResult.preview.map((row, idx) => (
                  <div
                    key={idx}
                    className={`px-3 py-1.5 text-[11px] grid grid-cols-12 gap-2 items-center ${
                      row.valid ? "hover:bg-slate-50 dark:hover:bg-slate-900" : "bg-rose-50/60 dark:bg-rose-950/20"
                    }`}
                  >
                    <span className="col-span-1 font-mono text-slate-400">#{row.rowNumber}</span>
                    <span className="col-span-2 font-medium">{row.targetType}</span>
                    <span className="col-span-3 truncate text-slate-700 dark:text-slate-200" title={row.resolvedName || row.targetIdentifier}>
                      {row.resolvedName || row.targetIdentifier || "—"}
                    </span>
                    <span className="col-span-2 text-right font-mono tabular-nums font-semibold">
                      ৳{fmtMoney(row.thresholdAmount)}
                    </span>
                    <span className="col-span-4 flex items-center gap-1.5 min-w-0">
                      {row.valid ? (
                        <span className="text-emerald-600 text-[10px] flex items-center gap-1 font-medium">
                          <CheckCircle2 className="h-3 w-3" /> Ready
                        </span>
                      ) : (
                        <span className="text-rose-600 text-[10px] flex items-center gap-1 truncate font-medium" title={row.error}>
                          <XCircle className="h-3 w-3 shrink-0" /> {row.error}
                        </span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-slate-500 italic">
                Note: Staged thresholds will not modify production calculation thresholds until formally authorized.
              </p>
            </div>
          )}
        </TabsContent>

        {/* TAB 2: Approved Active Thresholds */}
        <TabsContent value="thresholds" className="space-y-3 pt-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-slate-500">
              Currently approved thresholds enforced during commission calculation for rule &quot;{ruleName || currentRule?.name || "this rule"}&quot;.
            </p>
          </div>
          {approvedThresholds.length === 0 ? (
            <div className="p-8 text-center text-slate-400 text-xs border border-dashed rounded-lg">
              No approved thresholds configured for this rule yet. Download the template and import thresholds.
            </div>
          ) : (
            <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800">
              <div className="bg-slate-100 dark:bg-slate-800/60 px-3 py-1.5 text-[10px] font-semibold text-slate-600 dark:text-slate-300 grid grid-cols-12 gap-2">
                <span className="col-span-3">Target Scope</span>
                <span className="col-span-5">Target Name / Entity</span>
                <span className="col-span-4 text-right">Threshold Amount (৳)</span>
              </div>
              {approvedThresholds.map((t: any) => (
                <div key={t.id} className="px-3 py-2 text-xs grid grid-cols-12 gap-2 items-center">
                  <span className="col-span-3">
                    <Badge variant="outline" className="text-[10px]">{t.targetType}</Badge>
                  </span>
                  <span className="col-span-5 font-medium text-slate-800 dark:text-slate-200">
                    {t.targetName || "—"}
                  </span>
                  <span className="col-span-4 text-right font-mono font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
                    ৳{fmtMoney(t.thresholdAmount)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        {/* TAB 3: Import Batches & Status */}
        <TabsContent value="history" className="space-y-3 pt-3">
          <p className="text-xs text-slate-500">
            Audit log of threshold imports, authorization workflow requests, and approval decisions.
          </p>
          {importHistory.length === 0 ? (
            <div className="p-8 text-center text-slate-400 text-xs border border-dashed rounded-lg">
              No threshold imports recorded for this rule.
            </div>
          ) : (
            <div className="space-y-2">
              {importHistory.map((item: any) => (
                <div
                  key={item.id}
                  className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-wrap items-center justify-between gap-2"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-slate-800 dark:text-slate-100">{item.fileName}</span>
                      <StatusBadge status={item.status} />
                    </div>
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      Uploaded {fmtDateTime(item.createdAt)} · {item.totalRows} records ({item.validRows} valid)
                    </p>
                    {item.rejectionReason && (
                      <p className="text-[10px] text-rose-600 mt-0.5">Reason: {item.rejectionReason}</p>
                    )}
                  </div>

                  {item.status === "PENDING" && can("bonus", "approve") && (
                    <div className="flex items-center gap-1.5">
                      <Button
                        size="sm"
                        type="button"
                        variant="outline"
                        onClick={() => handleDecideImport(item.id, "REJECT")}
                        disabled={busy}
                        className="h-7 text-xs text-rose-600 border-rose-200 hover:bg-rose-50"
                      >
                        Reject
                      </Button>
                      <Button
                        size="sm"
                        type="button"
                        onClick={() => handleDecideImport(item.id, "APPROVE")}
                        disabled={busy}
                        className="h-7 text-xs"
                      >
                        Approve &amp; Activate
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}

interface ImportProps {
  open: boolean
  rule: CommissionRuleRow
  onOpenChange: (open: boolean) => void
  onUpdated: () => void
}

export function BulkThresholdImportDialog({ open, rule, onOpenChange, onUpdated }: ImportProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl max-h-[92dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5 text-emerald-600" />
            Bulk Revenue Threshold Setup — {rule.name}
          </DialogTitle>
          <DialogDescription className="text-xs text-slate-500">
            Download the multi-worksheet template, upload completed threshold figures, validate in real-time,
            and submit for authorization before production calculations apply them.
          </DialogDescription>
        </DialogHeader>

        <BulkRevenueThresholdsProcess
          ruleId={rule.id}
          ruleName={rule.name}
          branchId={rule.branchId || undefined}
          departmentId={rule.departmentId || undefined}
          designationId={rule.designationId || undefined}
          minServicePeriodValue={rule.minServicePeriodValue}
          minServicePeriodUnit={rule.minServicePeriodUnit}
          eligibleStatuses={rule.eligibleStatuses || undefined}
          onUpdated={onUpdated}
        />

        <DialogFooter className="pt-2 border-t border-slate-100 dark:border-slate-800">
          <Button variant="outline" onClick={() => onOpenChange(false)} className="h-8 text-xs">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ----------------------------------------------------------------------------------
// Section 1.E: Commission Rule Detail Modal
// ----------------------------------------------------------------------------------
export function CommissionRuleDetailDialog({
  rule,
  open,
  onOpenChange,
  onEdit,
}: {
  rule: CommissionRuleRow | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onEdit?: (rule: CommissionRuleRow) => void
}) {
  const { can } = useHrm()
  if (!rule) return null

  const targets: string[] = []
  if (rule.requireTotalTarget) targets.push("Total Organization")
  if (rule.requireBranchTarget) targets.push("Branch")
  if (rule.requireDeptTarget) targets.push("Department")
  if (rule.requireEmpTarget) targets.push("Individual Employee")

  const statuses = Array.isArray(rule.eligibleStatuses) && rule.eligibleStatuses.length > 0
    ? rule.eligibleStatuses
    : ["ACTIVE", "PROBATION"]

  const approvedThresholds = rule.thresholds || []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <DialogTitle className="text-base flex items-center gap-2">
              <Coins className="h-5 w-5 text-emerald-600" />
              <span>Commission Rule Details — {rule.name}</span>
            </DialogTitle>
            <Badge className={rule.active ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-600"}>
              {rule.active ? "Active" : "Inactive"}
            </Badge>
          </div>
          <DialogDescription className="text-xs text-slate-500">
            Complete rule setup parameters, calculation method, eligibility requirements, and approved revenue thresholds.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2 text-xs">
          {/* Overview Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div className="p-2.5 rounded-lg border bg-slate-50/50 dark:bg-slate-900/40">
              <span className="text-[10px] text-slate-400 uppercase font-semibold">Calculation Period</span>
              <p className="font-semibold text-slate-800 dark:text-slate-100 mt-0.5">{titleCase(rule.calculationPeriod)}</p>
            </div>
            <div className="p-2.5 rounded-lg border bg-slate-50/50 dark:bg-slate-900/40">
              <span className="text-[10px] text-slate-400 uppercase font-semibold">Effective From</span>
              <p className="font-semibold text-slate-800 dark:text-slate-100 mt-0.5">{fmtDate(rule.effectiveFrom)}</p>
            </div>
            <div className="p-2.5 rounded-lg border bg-slate-50/50 dark:bg-slate-900/40">
              <span className="text-[10px] text-slate-400 uppercase font-semibold">Effective To</span>
              <p className="font-semibold text-slate-800 dark:text-slate-100 mt-0.5">{rule.effectiveTo ? fmtDate(rule.effectiveTo) : "Open-ended"}</p>
            </div>
            <div className="p-2.5 rounded-lg border bg-slate-50/50 dark:bg-slate-900/40">
              <span className="text-[10px] text-slate-400 uppercase font-semibold">Total Pool Cap</span>
              <p className="font-semibold text-slate-800 dark:text-slate-100 mt-0.5">{rule.cap > 0 ? `৳${fmtMoney(rule.cap)}` : "Uncapped"}</p>
            </div>
          </div>

          {/* Calculation Basis Card */}
          <div className="p-3 rounded-lg border space-y-2">
            <h4 className="font-semibold text-slate-700 dark:text-slate-200 text-xs flex items-center justify-between">
              <span>Commission Calculation Basis</span>
              <Badge variant="outline" className="text-[10px] font-mono">{rule.basis}</Badge>
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1 text-slate-600 dark:text-slate-300">
              <div>
                <span className="text-slate-400 block text-[10px]">Rate / Value:</span>
                <span className="font-bold text-emerald-700 dark:text-emerald-400 text-sm">
                  {rule.basis === "PERCENT_OF_SALES" ? `${rule.rate}%` : `৳${fmtMoney(rule.rate)}`}
                </span>
              </div>
              <div>
                <span className="text-slate-400 block text-[10px]">Method:</span>
                <span className="font-medium text-slate-700 dark:text-slate-200">
                  {rule.basis === "PERCENT_OF_SALES"
                    ? (rule.percentMethod === "REVENUE_EXCEEDING_TARGET" ? "Revenue Exceeding Target" : "Total Revenue")
                    : (rule.flatMethod === "TOTAL_POOL" ? "Total Pool" : "Per Employee")}
                </span>
              </div>
              <div>
                <span className="text-slate-400 block text-[10px]">Distribution:</span>
                <span className="font-medium text-slate-700 dark:text-slate-200">
                  {rule.distributionMethod === "SALARY_PRO_RATA" ? "Salary Pro-rata" : rule.distributionMethod === "EQUAL" ? "Equal Distribution" : "—"}
                </span>
              </div>
            </div>
          </div>

          {/* Scope & Service Eligibility Card */}
          <div className="p-3 rounded-lg border space-y-2">
            <h4 className="font-semibold text-slate-700 dark:text-slate-200 text-xs">Scope &amp; Eligibility</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-slate-600 dark:text-slate-300">
              <div>
                <span className="text-slate-400 block text-[10px]">Organizational Scope:</span>
                <p className="text-xs">
                  Branch: <span className="font-medium">{rule.branchName || "All Branches"}</span> · Dept: <span className="font-medium">{rule.departmentName || "All Departments"}</span>
                </p>
              </div>
              <div>
                <span className="text-slate-400 block text-[10px]">Minimum Service Period:</span>
                <p className="font-medium text-xs">
                  {rule.minServicePeriodValue > 0 ? `${rule.minServicePeriodValue} ${titleCase(rule.minServicePeriodUnit)}` : "None (Immediate)"}
                </p>
              </div>
            </div>

            {/* Eligible Statuses */}
            <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
              <span className="text-slate-400 block text-[10px] mb-1">Eligible Employee Types:</span>
              <div className="flex flex-wrap gap-1">
                {statuses.map((st) => (
                  <Badge key={st} variant="secondary" className="text-[10px]">
                    {titleCase(st)}
                  </Badge>
                ))}
              </div>
            </div>
          </div>

          {/* Required Targets & Thresholds */}
          <div className="p-3 rounded-lg border space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="font-semibold text-slate-700 dark:text-slate-200 text-xs">Required Targets &amp; Approved Thresholds</h4>
              <Badge variant="outline" className="text-[10px]">
                {approvedThresholds.length} Approved Threshold{approvedThresholds.length === 1 ? "" : "s"}
              </Badge>
            </div>
            <div className="flex flex-wrap gap-1 text-[11px]">
              <span className="text-slate-400 mr-1">Hierarchy:</span>
              {targets.length > 0 ? (
                targets.map((t, idx) => (
                  <span key={t} className="inline-flex items-center gap-1 font-medium text-emerald-700 dark:text-emerald-400">
                    {idx > 0 && <span className="text-slate-300 dark:text-slate-600">&gt;</span>}
                    {t}
                  </span>
                ))
              ) : (
                <span className="text-slate-400 italic">None required</span>
              )}
            </div>

            {approvedThresholds.length > 0 && (
              <div className="max-h-48 overflow-y-auto rounded border divide-y text-[11px] mt-2">
                <div className="bg-slate-50 dark:bg-slate-800/60 px-2.5 py-1 font-semibold text-slate-500 grid grid-cols-12 gap-2 text-[10px]">
                  <span className="col-span-3">Scope</span>
                  <span className="col-span-5">Entity</span>
                  <span className="col-span-4 text-right">Threshold (৳)</span>
                </div>
                {approvedThresholds.map((t: any) => (
                  <div key={t.id} className="px-2.5 py-1.5 grid grid-cols-12 gap-2 items-center">
                    <span className="col-span-3 font-mono text-[10px]">{t.targetType}</span>
                    <span className="col-span-5 truncate text-slate-800 dark:text-slate-200">{t.targetName || "—"}</span>
                    <span className="col-span-4 text-right font-mono font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                      ৳{fmtMoney(t.thresholdAmount)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-slate-800">
          <Button variant="outline" onClick={() => onOpenChange(false)} className="h-8 text-xs">
            Close
          </Button>
          {onEdit && can("bonus", "create") && (
            <Button
              onClick={() => {
                onOpenChange(false)
                onEdit(rule)
              }}
              className="h-8 text-xs"
            >
              <Pencil className="h-3.5 w-3.5 mr-1.5" /> Edit Rule &amp; Thresholds
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ----------------------------------------------------------------------------------
// Comprehensive Commission Calculation Wizard Dialog
// ----------------------------------------------------------------------------------
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]

export function CommissionCalculateDialog({
  open,
  onOpenChange,
  onDone,
  empOpts: externalEmpOpts,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onDone?: (batchId?: string) => void
  empOpts?: { value: string; label: string }[]
}) {
  const toast = useHrm((s) => s.toast)
  const { data: employeesData } = useEmployeeDirectory()
  const { data: rules } = useApi<CommissionRuleRow[]>(open ? "commissionRules.list" : null, { active: true })

  const [month, setMonth] = useState(new Date().getMonth() + 1)
  const [year, setYear] = useState(new Date().getFullYear())
  const [selectedRuleId, setSelectedRuleId] = useState<string>("AUTO")
  const [entries, setEntries] = useState<{ employeeId: string; salesAmount: string }[]>([
    { employeeId: "", salesAmount: "" },
  ])
  const [pasteModalOpen, setPasteModalOpen] = useState(false)
  const [pasteText, setPasteText] = useState("")
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<any>(null)
  const [downloadingTemplate, setDownloadingTemplate] = useState(false)
  const [importing, setImporting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Entries search & pagination
  const [entrySearch, setEntrySearch] = useState("")
  const [page, setPage] = useState(1)
  const pageSize = 25

  // Results search & pagination
  const [resultSearch, setResultSearch] = useState("")
  const [resultPage, setResultPage] = useState(1)
  const resultPageSize = 25

  const internalEmpOpts = useMemo(() => {
    return (employeesData || [])
      .filter((e: any) => e.status === "ACTIVE" || e.status === "PROBATION")
      .map((e: any) => ({
        value: e.id,
        label: `${e.fullName} (${e.code || "EMP"})`,
        code: e.code,
        name: e.fullName,
        branchId: e.branchId,
        departmentId: e.departmentId,
      }))
  }, [employeesData])

  const empOpts = externalEmpOpts && externalEmpOpts.length > 0 ? externalEmpOpts : internalEmpOpts

  const empMap = useMemo(() => {
    const map = new Map<string, any>()
    for (const o of empOpts) {
      map.set(o.value, o)
    }
    return map
  }, [empOpts])

  // Find currently selected rule
  const selectedRule = rules?.find((r) => r.id === selectedRuleId)
  const isFlat = selectedRule?.basis === "FLAT"

  useEffect(() => {
    if (open) {
      setMonth(new Date().getMonth() + 1)
      setYear(new Date().getFullYear())
      setSelectedRuleId("AUTO")
      setEntries([{ employeeId: "", salesAmount: "" }])
      setResult(null)
      setPasteModalOpen(false)
      setPasteText("")
      setEntrySearch("")
      setPage(1)
      setResultSearch("")
      setResultPage(1)
    }
  }, [open])

  const setEntry = (i: number, k: "employeeId" | "salesAmount", v: string) => {
    setEntries((prev) => prev.map((e, idx) => (idx === i ? { ...e, [k]: v } : e)))
  }

  // Download official Excel calculation template for selected rule and period
  const handleDownloadTemplate = async () => {
    setDownloadingTemplate(true)
    try {
      const res = await rpc<any>("commissions.calculationTemplate", {
        ruleId: selectedRuleId !== "AUTO" ? selectedRuleId : undefined,
        month,
        year,
      })
      if (!res?.base64) throw new Error("Failed to generate calculation template")

      const blob = new Blob(
        [Uint8Array.from(atob(res.base64), (c) => c.charCodeAt(0))],
        { type: res.contentType || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }
      )
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = res.fileName || `Sales_Commission_Template_${month}_${year}.xlsx`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)

      toast(`Downloaded template with ${res.eligibleCount || 0} eligible employee(s) and targets`, "ok")
    } catch (e: any) {
      toast(String(e?.message || e), "err")
    } finally {
      setDownloadingTemplate(false)
    }
  }

  // Import filled Excel or CSV file
  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    event.target.value = "" // Reset input so re-selecting same file works

    setImporting(true)
    try {
      const mod: any = await import("xlsx")
      const XLSX = mod.default || mod
      const data = await file.arrayBuffer()
      const wb = XLSX.read(data, { type: "array" })

      const sheetName = wb.SheetNames.includes("Sales Entries")
        ? "Sales Entries"
        : wb.SheetNames.includes("Sales Calculation")
        ? "Sales Calculation"
        : wb.SheetNames[0]

      const ws = wb.Sheets[sheetName]
      const rows = (XLSX.utils.sheet_to_json(ws, { defval: "" }) as any[]) || []
      if (!rows.length) {
        toast("The uploaded file does not contain any data rows", "err")
        return
      }

      // Pre-build index maps for O(1) matching
      const codeMap = new Map<string, any>()
      const nameMap = new Map<string, any>()
      const idMap = new Map<string, any>()

      for (const e of employeesData || []) {
        if (e.id) idMap.set(String(e.id).trim().toLowerCase(), e)
        if (e.code) codeMap.set(String(e.code).trim().toLowerCase(), e)
        if (e.fullName) nameMap.set(String(e.fullName).trim().toLowerCase(), e)
      }

      const newEntries: { employeeId: string; salesAmount: string }[] = []
      let matchedCount = 0

      for (const row of rows) {
        // Resolve employee identifier from template columns or generic headers
        const rawId =
          row["Employee Code"] ??
          row["EmployeeCode"] ??
          row["Code"] ??
          row["Employee Name"] ??
          row["Name"] ??
          row["System ID"] ??
          row["ID"] ??
          Object.values(row)[0]

        if (!rawId) continue
        const identifier = String(rawId).trim().toLowerCase()
        if (
          identifier === "employee code" ||
          identifier === "employeecode" ||
          identifier === "code" ||
          identifier === "employee name"
        ) {
          continue
        }

        // Resolve sales revenue from template columns or generic headers
        const rawAmt =
          row["Sales Revenue (BDT)"] ??
          row["Sales Revenue"] ??
          row["Sales Revenue (৳)"] ??
          row["Actual Sales Revenue (BDT)"] ??
          row["Sales Amount"] ??
          row["Sales"] ??
          row["Revenue"] ??
          row["Amount"] ??
          Object.values(row)[8] ??
          Object.values(row)[1]

        const cleanAmt = String(rawAmt ?? "").replace(/[^0-9.]/g, "")

        const match = codeMap.get(identifier) || nameMap.get(identifier) || idMap.get(identifier)
        if (match) {
          newEntries.push({ employeeId: match.id, salesAmount: cleanAmt })
          matchedCount++
        }
      }

      if (newEntries.length > 0) {
        setEntries(newEntries)
        setPage(1)
        setEntrySearch("")
        toast(`Successfully imported ${matchedCount} employee sales record(s) from ${file.name}`, "ok")
      } else {
        toast("No matching employees found in uploaded file. Ensure column has Employee Code or Name.", "err")
      }
    } catch (err: any) {
      toast(`Import failed: ${err?.message || err}`, "err")
    } finally {
      setImporting(false)
    }
  }

  // Fast O(1) bulk paste sales with map lookup
  const handleApplyPaste = () => {
    if (!pasteText.trim()) return
    const lines = pasteText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    if (!lines.length) return

    // Pre-build index maps for O(1) matching
    const codeMap = new Map<string, any>()
    const nameMap = new Map<string, any>()
    const idMap = new Map<string, any>()

    for (const e of employeesData || []) {
      if (e.id) idMap.set(String(e.id).trim().toLowerCase(), e)
      if (e.code) codeMap.set(String(e.code).trim().toLowerCase(), e)
      if (e.fullName) nameMap.set(String(e.fullName).trim().toLowerCase(), e)
    }

    const newEntries: { employeeId: string; salesAmount: string }[] = []
    let matchedCount = 0

    for (const line of lines) {
      // Split by comma, tab, semicolon or pipe
      const parts = line.split(/[,\t;|]/).map((p) => p.trim())
      if (parts.length === 0) continue
      const rawIdentifier = parts[0]
      if (!rawIdentifier) continue

      const identifier = rawIdentifier.toLowerCase()
      // Skip common table headers
      if (
        identifier === "employeecode" ||
        identifier === "employee code" ||
        identifier === "emp code" ||
        identifier === "code" ||
        identifier === "id" ||
        identifier === "employee id" ||
        identifier === "name" ||
        identifier === "employee name" ||
        identifier === "employee"
      ) {
        continue
      }

      const rawAmt = parts[1] || ""
      const cleanAmt = rawAmt.replace(/[^0-9.]/g, "")

      const match = codeMap.get(identifier) || nameMap.get(identifier) || idMap.get(identifier)
      if (match) {
        newEntries.push({ employeeId: match.id, salesAmount: cleanAmt })
        matchedCount++
      }
    }

    if (newEntries.length > 0) {
      setEntries(newEntries)
      setPasteModalOpen(false)
      setPasteText("")
      setPage(1)
      setEntrySearch("")
      toast(`Successfully imported ${matchedCount} employee sales records from paste`, "ok")
    } else {
      toast("No matching employees found in pasted text. Format: EmployeeCode, SalesAmount", "err")
    }
  }

  // Valid entries: must have employeeId. If percentage basis, salesAmount should be non-negative numeric
  const valid = useMemo(() => {
    return entries.filter((e) => {
      if (!e.employeeId) return false
      const amt = Number(String(e.salesAmount).replace(/,/g, ""))
      if (isFlat) return true
      return !isNaN(amt) && amt >= 0 && e.salesAmount !== ""
    })
  }, [entries, isFlat])

  const totalSalesRevenue = useMemo(() => {
    return entries.reduce((acc, e) => {
      const amt = Number(String(e.salesAmount).replace(/,/g, ""))
      return !isNaN(amt) && amt > 0 ? acc + amt : acc
    }, 0)
  }, [entries])

  // Search filtering for entries
  const filteredEntriesWithIdx = useMemo(() => {
    if (!entrySearch.trim()) {
      return entries.map((e, idx) => ({ ...e, originalIndex: idx }))
    }
    const q = entrySearch.trim().toLowerCase()
    return entries
      .map((e, idx) => ({ ...e, originalIndex: idx }))
      .filter((e) => {
        const emp = empMap.get(e.employeeId)
        if (emp) {
          if (emp.label && emp.label.toLowerCase().includes(q)) return true
          if (emp.code && emp.code.toLowerCase().includes(q)) return true
          if (emp.name && emp.name.toLowerCase().includes(q)) return true
        }
        if (e.salesAmount && e.salesAmount.includes(q)) return true
        return false
      })
  }, [entries, entrySearch, empMap])

  const totalPages = Math.max(1, Math.ceil(filteredEntriesWithIdx.length / pageSize))
  const currentPage = Math.min(page, totalPages)
  const paginatedEntries = useMemo(() => {
    const start = (currentPage - 1) * pageSize
    return filteredEntriesWithIdx.slice(start, start + pageSize)
  }, [filteredEntriesWithIdx, currentPage, pageSize])

  // Results search & pagination
  // T-11 — optional-chained expressions in dependency lists defeat the
  // React Compiler's memoization preservation; the value is lifted to a
  // plain local first.
  const resultBonuses = result?.bonuses
  const filteredBonuses = useMemo(() => {
    if (!resultBonuses) return []
    if (!resultSearch.trim()) return resultBonuses
    const q = resultSearch.trim().toLowerCase()
    return resultBonuses.filter((b: any) => {
      return (
        (b.employeeName && b.employeeName.toLowerCase().includes(q)) ||
        (b.employeeCode && b.employeeCode.toLowerCase().includes(q)) ||
        (b.ruleName && b.ruleName.toLowerCase().includes(q))
      )
    })
  }, [resultBonuses, resultSearch])

  const totalResultPages = Math.max(1, Math.ceil(filteredBonuses.length / resultPageSize))
  const currentResultPage = Math.min(resultPage, totalResultPages)
  const paginatedBonuses = useMemo(() => {
    const start = (currentResultPage - 1) * resultPageSize
    return filteredBonuses.slice(start, start + resultPageSize)
  }, [filteredBonuses, currentResultPage, resultPageSize])

  const run = async () => {
    if (valid.length === 0) {
      toast("Please add at least one employee with sales revenue to calculate", "err")
      return
    }

    setBusy(true)
    try {
      const res = await rpc<any>("commissions.calculate", {
        ruleId: selectedRuleId !== "AUTO" ? selectedRuleId : undefined,
        month,
        year,
        entries: valid.map((e) => ({
          employeeId: e.employeeId,
          salesAmount: Number(String(e.salesAmount).replace(/,/g, "")) || 0,
        })),
      })
      setResult(res)
      setResultPage(1)
      setResultSearch("")
      if (onDone) onDone(res?.batchId)
      toast(`Calculated ${res.created} commission bonus(es)`, "ok")
    } catch (e: any) {
      toast(String(e?.message || e), "err")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !busy) onOpenChange(v) }}>
      <DialogContent className="sm:max-w-2xl max-h-[92dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            <Coins className="h-4 w-4 text-emerald-600" /> Calculate Sales Commissions
          </DialogTitle>
          <DialogDescription className="text-xs text-slate-500">
            Compute commission bonuses according to approved rules and revenue thresholds.
            Calculated commissions create pending <code className="text-[10px] bg-slate-100 dark:bg-slate-800 px-1 py-0.5 rounded">SALES_COMMISSION</code> bonuses for approval.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-4 pt-1">
            {/* Summary statistics */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              <div className="p-3 rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50/60 dark:bg-emerald-950/40">
                <p className="text-[11px] font-medium text-emerald-700 dark:text-emerald-300">Commissions Created</p>
                <p className="text-xl font-bold text-emerald-900 dark:text-emerald-100">{result.created || 0}</p>
                <p className="text-[10px] text-emerald-600 mt-0.5">Pending approval</p>
              </div>
              <div className="p-3 rounded-lg border border-teal-200 dark:border-teal-900 bg-teal-50/60 dark:bg-teal-950/40">
                <p className="text-[11px] font-medium text-teal-700 dark:text-teal-300">Total Payable Amount</p>
                <p className="text-xl font-bold text-teal-900 dark:text-teal-100">{fmtMoney(result.totalCommission || 0)}</p>
                <p className="text-[10px] text-teal-600 mt-0.5">For {MONTHS[month - 1]} {year}</p>
              </div>
              <div className="p-3 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50/60 dark:bg-amber-950/40">
                <p className="text-[11px] font-medium text-amber-700 dark:text-amber-300">Skipped Entries</p>
                <p className="text-xl font-bold text-amber-900 dark:text-amber-100">{result.skipped?.length || 0}</p>
                <p className="text-[10px] text-amber-600 mt-0.5">Did not qualify / duplicate</p>
              </div>
            </div>

            {/* Created bonuses table */}
            {result.bonuses?.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> Generated Commission Details ({result.bonuses.length})
                  </p>
                  {result.bonuses.length > 10 && (
                    <div className="relative w-48">
                      <Search className="absolute left-2 top-2 h-3 w-3 text-slate-400" />
                      <Input
                        placeholder="Search results..."
                        value={resultSearch}
                        onChange={(e) => {
                          setResultSearch(e.target.value)
                          setResultPage(1)
                        }}
                        className="h-7 pl-7 text-[11px]"
                      />
                    </div>
                  )}
                </div>

                <div className="rounded-lg border border-slate-200 dark:border-slate-800 overflow-hidden">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 dark:bg-slate-900/80 border-b border-slate-200 dark:border-slate-800 text-[11px] text-slate-600">
                      <tr>
                        <th className="py-2 px-3">Employee</th>
                        <th className="py-2 px-3">Rule Applied</th>
                        <th className="py-2 px-3 text-right">Revenue</th>
                        <th className="py-2 px-3 text-right">Target</th>
                        <th className="py-2 px-3 text-right">Commission</th>
                        <th className="py-2 px-3 text-center">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {paginatedBonuses.map((b: any, idx: number) => (
                        <tr key={idx} className="hover:bg-slate-50/50">
                          <td className="py-2 px-3">
                            <span className="font-semibold text-slate-800 dark:text-slate-100">{b.employeeName}</span>
                            {b.employeeCode && <span className="text-[10px] text-slate-400 block">{b.employeeCode}</span>}
                          </td>
                          <td className="py-2 px-3 text-slate-600">
                            <span>{b.ruleName}</span>
                            {b.capApplied && <Badge className="ml-1 text-[9px] bg-amber-100 text-amber-800">Cap Applied</Badge>}
                          </td>
                          <td className="py-2 px-3 text-right font-mono text-[11px]">
                            {b.eligibleRevenue > 0 ? fmtMoney(b.eligibleRevenue) : "—"}
                          </td>
                          <td className="py-2 px-3 text-right font-mono text-[11px] text-slate-500">
                            {b.targetRevenue > 0 ? fmtMoney(b.targetRevenue) : "—"}
                          </td>
                          <td className="py-2 px-3 text-right font-semibold font-mono text-emerald-700 dark:text-emerald-400">
                            {fmtMoney(b.finalCommissionAmount || b.amount)}
                          </td>
                          <td className="py-2 px-3 text-center">
                            <Badge className="bg-amber-100 text-amber-700 text-[9px] font-normal">Pending</Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {filteredBonuses.length > resultPageSize && (
                  <div className="flex items-center justify-between text-xs text-slate-500 pt-1">
                    <span>
                      Showing {(currentResultPage - 1) * resultPageSize + 1}–{Math.min(currentResultPage * resultPageSize, filteredBonuses.length)} of {filteredBonuses.length}
                    </span>
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 text-[11px]"
                        disabled={currentResultPage <= 1}
                        onClick={() => setResultPage((p) => Math.max(1, p - 1))}
                      >
                        <ChevronLeft className="h-3 w-3 mr-0.5" /> Prev
                      </Button>
                      <span className="text-[11px] font-mono px-1">
                        {currentResultPage} / {totalResultPages}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 text-[11px]"
                        disabled={currentResultPage >= totalResultPages}
                        onClick={() => setResultPage((p) => Math.min(totalResultPages, p + 1))}
                      >
                        Next <ChevronRight className="h-3 w-3 ml-0.5" />
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Skipped reasons */}
            {result.skipped?.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-500" /> Skipped Records &amp; Explanations
                </p>
                <div className="max-h-40 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800 text-[11px]">
                  {result.skipped.map((s: any, i: number) => {
                    const empName = empOpts.find((o) => o.value === s.employeeId)?.label || s.employeeId
                    return (
                      <div key={i} className="flex items-start gap-2 px-3 py-1.5">
                        <span className="font-semibold text-slate-700 dark:text-slate-300 shrink-0">
                          {s.employeeId === "ALL" ? "All Entries" : empName}:
                        </span>
                        <span className="text-slate-500">{s.reason}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {result.created === 0 && (!result.skipped || result.skipped.length === 0) && (
              <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 text-xs text-slate-600">
                No active commission rules matched the provided employees for this period. Please verify that your commission rules are set to Active status and effective for {MONTHS[month - 1]} {year}.
              </div>
            )}

            <DialogFooter className="pt-2">
              <Button variant="outline" onClick={() => setResult(null)} className="h-8 text-xs">
                Calculate Another Run
              </Button>
              <Button onClick={() => onOpenChange(false)} className="h-8 text-xs">
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-3 pt-1">
            {/* Period and Rule Controls */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div className="space-y-1">
                <Label className="text-[11px] text-slate-500">Period Month</Label>
                <Select value={String(month)} onValueChange={(v) => setMonth(Number(v))}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {MONTHS.map((m, i) => (
                      <SelectItem key={m} value={String(i + 1)}>{m}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-[11px] text-slate-500">Period Year</Label>
                <Input
                  type="number"
                  value={year}
                  onChange={(e) => setYear(Number(e.target.value) || year)}
                  className="h-8 text-xs font-mono"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px] text-slate-500">Commission Rule</Label>
                <Select value={selectedRuleId} onValueChange={setSelectedRuleId}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="AUTO">Auto-match Active Rules</SelectItem>
                    {(rules || []).map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.name} ({titleCase(r.calculationPeriod)})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Selected Rule Information Card */}
            {selectedRule && (
              <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 text-xs space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
                    <Sparkles className="h-3.5 w-3.5 text-amber-500" /> {selectedRule.name}
                  </span>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[10px]">{titleCase(selectedRule.calculationPeriod)}</Badge>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[11px] text-blue-600 hover:text-blue-700 dark:text-blue-400 hover:bg-blue-50/60 dark:hover:bg-blue-950/40"
                      onClick={handleDownloadTemplate}
                      disabled={downloadingTemplate}
                    >
                      <Download className="h-3 w-3 mr-1" />
                      {downloadingTemplate ? "Generating…" : "Download Rule Template"}
                    </Button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500">
                  <span>
                    Basis: <strong className="text-slate-700 dark:text-slate-300">
                      {selectedRule.basis === "PERCENT_OF_SALES"
                        ? `${selectedRule.rate}% of ${selectedRule.percentMethod === "REVENUE_EXCEEDING_TARGET" ? "Revenue Exceeding Target" : "Total Revenue"}`
                        : `৳${selectedRule.rate} (${selectedRule.flatMethod === "TOTAL_POOL" ? "Total Pool" : "Per Employee"})`}
                    </strong>
                  </span>
                  {selectedRule.minServicePeriodValue > 0 && (
                    <span>Min Service: <strong>{selectedRule.minServicePeriodValue} {selectedRule.minServicePeriodUnit.toLowerCase()}</strong></span>
                  )}
                  {selectedRule.cap > 0 && (
                    <span>Cap: <strong>৳{fmtMoney(selectedRule.cap)}</strong></span>
                  )}
                  {(selectedRule.requireTotalTarget || selectedRule.requireBranchTarget || selectedRule.requireDeptTarget || selectedRule.requireEmpTarget) && (
                    <span>Targets: <strong>{[
                      selectedRule.requireTotalTarget && "Total",
                      selectedRule.requireBranchTarget && "Branch",
                      selectedRule.requireDeptTarget && "Dept",
                      selectedRule.requireEmpTarget && "Emp",
                    ].filter(Boolean).join(", ")}</strong></span>
                  )}
                  {selectedRule.thresholds && selectedRule.thresholds.length > 0 && (
                    <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                      ✓ {selectedRule.thresholds.length} Configured Target(s) Available
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Quick summary banner when many rows */}
            {entries.length > 5 && (
              <div className="grid grid-cols-3 gap-2 p-2.5 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs">
                <div>
                  <span className="text-[10px] text-slate-500 uppercase tracking-wider block">Total Entries</span>
                  <span className="font-semibold text-slate-800 dark:text-slate-200">{entries.length} rows</span>
                </div>
                <div>
                  <span className="text-[10px] text-slate-500 uppercase tracking-wider block">Ready to Calculate</span>
                  <span className="font-semibold text-emerald-600 dark:text-emerald-400">{valid.length}</span>
                </div>
                <div>
                  <span className="text-[10px] text-slate-500 uppercase tracking-wider block">Total Sales Revenue</span>
                  <span className="font-semibold font-mono text-slate-800 dark:text-slate-200">৳{fmtMoney(totalSalesRevenue)}</span>
                </div>
              </div>
            )}

            {/* Hidden file input for Excel / CSV import */}
            <input
              type="file"
              ref={fileInputRef}
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={handleFileUpload}
            />

            {/* Quick actions toolbar & search bar */}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
                <Input
                  placeholder="Filter by employee code, name or amount..."
                  value={entrySearch}
                  onChange={(e) => {
                    setEntrySearch(e.target.value)
                    setPage(1)
                  }}
                  className="h-8 pl-8 text-xs"
                />
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-[11px] border-blue-200 dark:border-blue-900 text-blue-700 dark:text-blue-300 hover:bg-blue-50/60 dark:hover:bg-blue-950/40"
                  onClick={handleDownloadTemplate}
                  disabled={downloadingTemplate}
                  title="Download calculation template with eligible employees and targets"
                >
                  <Download className="h-3.5 w-3.5 mr-1 text-blue-600 dark:text-blue-400" />
                  {downloadingTemplate ? "Generating…" : "Download Template"}
                </Button>

                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-[11px] border-emerald-200 dark:border-emerald-900 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50/60 dark:hover:bg-emerald-950/40"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={importing}
                  title="Import filled Excel (.xlsx, .xls) or CSV file"
                >
                  <Upload className="h-3.5 w-3.5 mr-1 text-emerald-600 dark:text-emerald-400" />
                  {importing ? "Importing…" : "Import"}
                </Button>

                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-[11px]"
                  onClick={() => setPasteModalOpen(true)}
                >
                  <ClipboardPaste className="h-3 w-3 mr-1" /> Paste List
                </Button>

                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 text-[11px] text-slate-400 hover:text-rose-600"
                  onClick={() => {
                    setEntries([{ employeeId: "", salesAmount: "" }])
                    setPage(1)
                    setEntrySearch("")
                  }}
                >
                  Reset
                </Button>
              </div>
            </div>

            {/* Entries List (Paginated & Lightweight) */}
            <div className="max-h-[300px] overflow-y-auto space-y-2 pr-1 rounded-md border border-slate-100 dark:border-slate-800 p-2">
              {paginatedEntries.length === 0 ? (
                <div className="text-center py-6 text-xs text-slate-400">
                  No employee records match the filter.
                </div>
              ) : (
                paginatedEntries.map((e) => {
                  const emp = empMap.get(e.employeeId)
                  return (
                    <div key={e.originalIndex} className="flex items-center gap-2">
                      {e.employeeId ? (
                        <div className="flex-1 min-w-0 h-8 flex items-center justify-between px-2.5 rounded border border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-900/60 text-xs">
                          <span className="font-medium text-slate-800 dark:text-slate-100 truncate">
                            {emp?.label || e.employeeId}
                          </span>
                          <button
                            type="button"
                            onClick={() => setEntry(e.originalIndex, "employeeId", "")}
                            className="text-[10px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 ml-2 shrink-0 underline"
                            title="Change employee"
                          >
                            Change
                          </button>
                        </div>
                      ) : (
                        <Select value={e.employeeId} onValueChange={(v) => setEntry(e.originalIndex, "employeeId", v)}>
                          <SelectTrigger className="flex-1 h-8 text-xs">
                            <SelectValue placeholder="Select Employee…" />
                          </SelectTrigger>
                          <SelectContent className="max-h-56">
                            {empOpts.slice(0, 100).map((o) => (
                              <SelectItem key={o.value} value={o.value}>
                                {o.label}
                              </SelectItem>
                            ))}
                            {empOpts.length > 100 && (
                              <div className="px-2 py-1 text-[10px] text-slate-400 italic">
                                Showing first 100. Use paste list for bulk records.
                              </div>
                            )}
                          </SelectContent>
                        </Select>
                      )}

                      <Input
                        type="text"
                        value={e.salesAmount}
                        onChange={(ev) => setEntry(e.originalIndex, "salesAmount", ev.target.value)}
                        placeholder={isFlat ? "Fixed payout" : "Sales Revenue ৳"}
                        className="w-36 h-8 text-xs font-mono text-right"
                      />

                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 text-slate-400 hover:text-rose-600 shrink-0"
                        disabled={entries.length === 1}
                        onClick={() => {
                          setEntries((prev) => prev.filter((_, idx) => idx !== e.originalIndex))
                        }}
                        aria-label="Remove row"
                      >
                        <XCircle className="h-4 w-4" />
                      </Button>
                    </div>
                  )
                })
              )}
            </div>

            {/* Pagination Controls */}
            {filteredEntriesWithIdx.length > pageSize && (
              <div className="flex items-center justify-between text-xs text-slate-500 pt-1">
                <span>
                  Showing {paginatedEntries.length > 0 ? (currentPage - 1) * pageSize + 1 : 0}–{Math.min(currentPage * pageSize, filteredEntriesWithIdx.length)} of {filteredEntriesWithIdx.length} entries
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[11px]"
                    disabled={currentPage <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    <ChevronLeft className="h-3 w-3 mr-0.5" /> Prev
                  </Button>
                  <span className="text-[11px] font-mono px-2">
                    {currentPage} / {totalPages}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[11px]"
                    disabled={currentPage >= totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  >
                    Next <ChevronRight className="h-3 w-3 ml-0.5" />
                  </Button>
                </div>
              </div>
            )}

            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[11px] w-full"
              onClick={() => {
                setEntries((prev) => [...prev, { employeeId: "", salesAmount: "" }])
                setPage(Math.ceil((entries.length + 1) / pageSize))
              }}
            >
              <Plus className="h-3 w-3 mr-1" /> Add Row
            </Button>

            {/* Paste Modal */}
            {pasteModalOpen && (
              <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold">Paste Employee Sales Data</span>
                  <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => setPasteModalOpen(false)}>
                    <XCircle className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <p className="text-[11px] text-slate-500">
                  Paste rows directly from Excel or CSV with format: <code>EmployeeCode, SalesAmount</code> (e.g. <code>EMP-001, 250000</code>). You can paste 800+ lines at once. Headers are automatically skipped.
                </p>
                <textarea
                  rows={5}
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  placeholder={"EMP-001, 250000\nEMP-002, 320000\nEMP-003, 180000"}
                  className="w-full text-xs font-mono p-2 rounded border border-slate-200 dark:border-slate-800 bg-background"
                />
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-slate-400">
                    {pasteText.trim() ? `${pasteText.split(/\r?\n/).filter((l) => l.trim()).length} line(s) detected` : "Ready to paste"}
                  </span>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setPasteModalOpen(false)}>
                      Cancel
                    </Button>
                    <Button size="sm" className="h-7 text-xs" onClick={handleApplyPaste}>
                      Apply Paste
                    </Button>
                  </div>
                </div>
              </div>
            )}

            <DialogFooter className="pt-2 border-t border-slate-100 dark:border-slate-800">
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy} className="h-8 text-xs">
                Cancel
              </Button>
              <Button onClick={run} disabled={busy || valid.length === 0} className="h-8 text-xs">
                {busy ? "Calculating Commissions…" : `Calculate (${valid.length} employees)`}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
