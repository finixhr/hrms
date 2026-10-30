"use client"
// ============ Loans & Advances (spec §10): installment schedules, approval workflow,
// payroll auto-recovery — all connected to the accounting journal.
import { useEffect, useMemo, useRef, useState } from "react"
import {
  Plus, Landmark, Wallet, Clock, CheckCircle2, Info, Coins, Check, X,
  UserRound, Search, AlertTriangle, ShieldAlert, AlertCircle,
  RefreshCw,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useHrm } from "../store"
import { useApi, rpc, useEmployeeDirectory } from "../api"
import { useServerPagedList, PagedControls } from "../server-paged"
import {
  PageHeader, StatCard, StatusBadge, fmtMoney, fmtDate, titleCase, SectionTabs, KV, EmptyState,
} from "../shared/ui-kit"
import { DataTable, type Column } from "../shared/data-table"
import { ConfirmDialog } from "../shared/form-dialog"

const LOAN_TYPES = ["PERSONAL", "HOUSING", "MEDICAL", "EMERGENCY", "OTHER"]

function getInitials(name?: string | null): string {
  if (!name) return "E"
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() || "")
    .join("") || "E"
}

export default function LoansView() {
  const { can } = useHrm()
  // global-search deep link: pre-select a tab (params arrive with the view)
  const presetTab = useHrm((s) => (s.view?.key === "loans" && s.view?.params?.tab) || undefined)
  return (
    <div className="space-y-4">
      <PageHeader
        title="Loans & Advances"
        subtitle="Employee loans with installment schedules and salary advances — both recovered automatically via payroll"
      />
      <SectionTabs
        defaultValue={presetTab as string | undefined}
        tabs={[
          { value: "loans", label: "Loans", content: <LoansTab /> },
          ...(can("advances", "view") ? [{ value: "advances", label: "Advances", content: <AdvancesTab /> }] : []),
        ]}
      />
    </div>
  )
}

/** Searchable employee picker with real-time query, status badges and selection card */
function EmployeeSearchPicker({
  employees,
  selectedId,
  onSelect,
  label,
  placeholder = "Search by employee name, code (e.g. EMP-001), department…",
  required = false,
  excludeId = null,
  disabled = false,
  helperText,
}: {
  employees: any[]
  selectedId: string | null
  onSelect: (emp: any | null) => void
  label: string
  placeholder?: string
  required?: boolean
  excludeId?: string | null
  disabled?: boolean
  helperText?: string
}) {
  const [query, setQuery] = useState("")
  const [isOpen, setIsOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const selectedEmp = useMemo(
    () => employees.find((e) => e.id === selectedId),
    [employees, selectedId]
  )

  const candidateList = useMemo(() => {
    return employees.filter((e) => !excludeId || e.id !== excludeId)
  }, [employees, excludeId])

  const filteredEmployees = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return candidateList.slice(0, 20)
    return candidateList
      .filter((e) => {
        const nameMatch = (e.fullName || "").toLowerCase().includes(q)
        const codeMatch = (e.code || "").toLowerCase().includes(q)
        const dept = typeof e.department === "object" ? e.department?.name : e.department
        const deptMatch = (dept || "").toLowerCase().includes(q)
        const desig = typeof e.designation === "object" ? e.designation?.name : e.designation
        const desigMatch = (desig || "").toLowerCase().includes(q)
        return nameMatch || codeMatch || deptMatch || desigMatch
      })
      .slice(0, 30)
  }, [candidateList, query])

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [])

  return (
    <div ref={containerRef} className="space-y-1.5 relative">
      <div className="flex items-center justify-between">
        <Label className="text-xs font-semibold text-slate-800 dark:text-slate-200">
          {label} {required && <span className="text-rose-500">*</span>}
        </Label>
        {selectedEmp && !disabled && (
          <button
            type="button"
            onClick={() => {
              onSelect(null)
              setQuery("")
              setIsOpen(true)
            }}
            className="text-[11px] text-indigo-600 dark:text-indigo-400 hover:underline flex items-center gap-1 font-medium"
          >
            Change
          </button>
        )}
      </div>

      {selectedEmp ? (
        <div className="flex items-center justify-between p-2.5 rounded-xl border border-emerald-200 dark:border-emerald-800/80 bg-emerald-50/40 dark:bg-emerald-950/20 shadow-xs transition-all">
          <div className="flex items-center gap-3 min-w-0">
            <div className="h-9 w-9 rounded-full bg-gradient-to-tr from-emerald-600 to-teal-500 text-white flex items-center justify-center font-bold text-xs shrink-0 shadow-xs">
              {getInitials(selectedEmp.fullName)}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-xs text-slate-900 dark:text-slate-100 truncate">
                  {selectedEmp.fullName}
                </span>
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white dark:bg-slate-800 border border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300">
                  {selectedEmp.code}
                </span>
                {selectedEmp.status && (
                  <span
                    className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${
                      selectedEmp.status === "ACTIVE"
                        ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-200"
                        : selectedEmp.status === "PROBATION"
                        ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                        : "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300"
                    }`}
                  >
                    {selectedEmp.status}
                  </span>
                )}
              </div>
              <p className="text-[10px] text-muted-foreground truncate mt-0.5">
                {[
                  typeof selectedEmp.department === "object" ? selectedEmp.department?.name : selectedEmp.department,
                  typeof selectedEmp.designation === "object" ? selectedEmp.designation?.name : selectedEmp.designation,
                ]
                  .filter(Boolean)
                  .join(" · ") || "Employee"}
              </p>
            </div>
          </div>
          {!disabled && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 text-slate-400 hover:text-rose-600 rounded-full"
              onClick={() => {
                onSelect(null)
                setQuery("")
                setIsOpen(true)
              }}
              title="Deselect employee"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      ) : (
        <div className="relative">
          <div className="relative">
            <Search className="h-3.5 w-3.5 text-slate-400 absolute left-3 top-2.5" />
            <Input
              type="text"
              value={query}
              disabled={disabled}
              onChange={(e) => {
                setQuery(e.target.value)
                setIsOpen(true)
              }}
              onFocus={() => setIsOpen(true)}
              placeholder={placeholder}
              className="pl-9 pr-8 h-9 text-xs"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-600"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {isOpen && (
            <div className="absolute top-full left-0 right-0 mt-1 z-50 bg-popover border border-border rounded-xl shadow-xl max-h-56 overflow-y-auto divide-y divide-border">
              {filteredEmployees.length === 0 ? (
                <div className="p-3 text-xs text-muted-foreground text-center">
                  No employee matches your query
                </div>
              ) : (
                filteredEmployees.map((emp) => (
                  <button
                    key={emp.id}
                    type="button"
                    onClick={() => {
                      onSelect(emp)
                      setIsOpen(false)
                      setQuery("")
                    }}
                    className="w-full p-2.5 text-left flex items-center justify-between hover:bg-muted/70 transition-colors text-xs"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="h-7 w-7 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 flex items-center justify-center font-bold text-[10px] shrink-0 border border-slate-200 dark:border-slate-700">
                        {getInitials(emp.fullName)}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-semibold truncate text-slate-900 dark:text-slate-100">
                            {emp.fullName}
                          </span>
                          <span className="text-[10px] font-mono text-muted-foreground">
                            {emp.code}
                          </span>
                        </div>
                        <p className="text-[10px] text-muted-foreground truncate">
                          {[
                            typeof emp.department === "object" ? emp.department?.name : emp.department,
                            typeof emp.designation === "object" ? emp.designation?.name : emp.designation,
                          ]
                            .filter(Boolean)
                            .join(" · ") || "Employee"}
                        </p>
                      </div>
                    </div>
                    {emp.status && (
                      <span
                        className={`text-[9px] px-1.5 py-0.5 rounded font-medium shrink-0 ml-2 ${
                          emp.status === "ACTIVE"
                            ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                            : emp.status === "PROBATION"
                            ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                            : "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300"
                        }`}
                      >
                        {emp.status}
                      </span>
                    )}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      )}
      {helperText && !selectedEmp && (
        <p className="text-[10px] text-muted-foreground">{helperText}</p>
      )}
    </div>
  )
}

/** Professional SaaS-grade Loan Application Dialog with Searchable Selectors, Diagnostics & Breakdown */
function LoanApplicationDialog({
  open,
  onOpenChange,
  employees,
  isEmployee,
  currentUserEmployeeId,
  presetEmployeeId,
  onSuccess,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  employees: any[]
  isEmployee: boolean
  currentUserEmployeeId?: string | null
  presetEmployeeId?: string
  onSuccess: () => void
}) {
  const toast = useHrm((s) => s.toast)
  const defaultEmpId = isEmployee ? (currentUserEmployeeId || "") : (presetEmployeeId || "")

  const [employeeId, setEmployeeId] = useState(defaultEmpId)
  const [type, setType] = useState("PERSONAL")
  const [principal, setPrincipal] = useState<number | string>(50000)
  const [installments, setInstallments] = useState<number | string>(12)
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10))
  const [guarantorId, setGuarantorId] = useState<string | null>(null)
  const [purpose, setPurpose] = useState("")

  const [eligibility, setEligibility] = useState<any | null>(null)
  const [evaluating, setEvaluating] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setEmployeeId(isEmployee ? (currentUserEmployeeId || "") : (presetEmployeeId || ""))
      setType("PERSONAL")
      setPrincipal(50000)
      setInstallments(12)
      setStartDate(new Date().toISOString().slice(0, 10))
      setGuarantorId(null)
      setPurpose("")
      setSubmitError(null)
    }
  }, [open, isEmployee, currentUserEmployeeId, presetEmployeeId])

  // Live preflight evaluation
  useEffect(() => {
    if (!open || !employeeId) {
      setEligibility(null)
      return
    }

    let active = true
    setEvaluating(true)

    const timer = setTimeout(async () => {
      try {
        const res = await rpc<any>("loans.checkEligibility", {
          employeeId,
          guarantorId: guarantorId || undefined,
          principal: Number(principal) || 0,
          installments: Number(installments) || 1,
          type: "LOAN",
        })
        if (active) {
          setEligibility(res)
        }
      } catch (err: any) {
        if (active) {
          console.warn("Eligibility preflight error", err)
        }
      } finally {
        if (active) setEvaluating(false)
      }
    }, 250)

    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [open, employeeId, guarantorId, principal, installments])

  const numPrincipal = Math.max(0, Number(principal) || 0)
  const numInstallments = Math.max(1, Number(installments) || 1)
  const monthlyEMI = Math.round(numPrincipal / numInstallments)

  // Estimated completion date
  const estCompletion = useMemo(() => {
    if (!startDate || !(numInstallments >= 1)) return "—"
    const d = new Date(startDate)
    if (isNaN(d.getTime())) return "—"
    d.setMonth(d.getMonth() + numInstallments)
    return d.toLocaleDateString("en-US", { month: "short", year: "numeric" })
  }, [startDate, numInstallments])

  const canSubmit =
    !!employeeId &&
    numPrincipal > 0 &&
    numInstallments >= 1 &&
    (!eligibility || eligibility.eligible)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return

    setSubmitting(true)
    setSubmitError(null)
    try {
      await rpc("loans.create", {
        ...(isEmployee ? {} : { employeeId }),
        type,
        principal: numPrincipal,
        installments: numInstallments,
        startDate,
        purpose: purpose.trim() || undefined,
        guarantorId: guarantorId || undefined,
      })
      toast(`Loan of ${fmtMoney(numPrincipal)} submitted successfully for approval.`)
      onSuccess()
      onOpenChange(false)
    } catch (err: any) {
      setSubmitError(err?.message || "Failed to submit loan application")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[92vh] overflow-y-auto p-0 gap-0 rounded-2xl">
        {/* Header */}
        <div className="p-5 border-b border-border bg-slate-50/70 dark:bg-slate-900/40">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-indigo-600 text-white flex items-center justify-center shadow-md shadow-indigo-500/20">
                <Landmark className="h-5 w-5" />
              </div>
              <div>
                <DialogTitle className="text-base font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                  Apply for Loan
                  {evaluating ? (
                    <Badge variant="outline" className="text-[10px] font-normal gap-1 text-indigo-600 border-indigo-200">
                      <RefreshCw className="h-2.5 w-2.5 animate-spin" /> Checking eligibility…
                    </Badge>
                  ) : eligibility ? (
                    eligibility.eligible ? (
                      <Badge className="bg-emerald-100 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 border-emerald-300 text-[10px] gap-1">
                        <CheckCircle2 className="h-3 w-3 text-emerald-600" /> Policy Eligible
                      </Badge>
                    ) : (
                      <Badge className="bg-rose-100 dark:bg-rose-950/60 text-rose-800 dark:text-rose-300 border-rose-300 text-[10px] gap-1">
                        <AlertTriangle className="h-3 w-3 text-rose-600" /> Ineligible ({eligibility.reasons.length})
                      </Badge>
                    )
                  ) : null}
                </DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                  Submits to unified approval workflow. Approved loans auto-deduct monthly via payroll.
                </DialogDescription>
              </div>
            </div>
          </div>
        </div>

        {/* Content Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          {/* Section 1: Borrower Selection */}
          {!isEmployee && (
            <div className="space-y-3">
              <EmployeeSearchPicker
                employees={employees}
                selectedId={employeeId || null}
                onSelect={(emp) => setEmployeeId(emp?.id || "")}
                label="Borrower (Employee)"
                required
                excludeId={guarantorId}
                helperText="Search and select the employee applying for the loan"
              />
            </div>
          )}

          {/* Section 2: Real-time Eligibility Diagnostics */}
          {eligibility && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {/* Status Diagnostic */}
                <div className={`p-2.5 rounded-lg border text-xs ${
                  eligibility.borrower.statusEligible
                    ? "bg-emerald-50/60 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800/60"
                    : "bg-rose-50/70 dark:bg-rose-950/30 border-rose-200 dark:border-rose-900"
                }`}>
                  <p className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground">Status</p>
                  <p className="font-semibold mt-0.5 flex items-center gap-1 truncate">
                    {eligibility.borrower.statusEligible ? (
                      <Check className="h-3 w-3 text-emerald-600 shrink-0" />
                    ) : (
                      <X className="h-3 w-3 text-rose-600 shrink-0" />
                    )}
                    {eligibility.borrower.status}
                  </p>
                </div>

                {/* Service Period Diagnostic */}
                <div className={`p-2.5 rounded-lg border text-xs ${
                  eligibility.borrower.serviceEligible
                    ? "bg-emerald-50/60 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800/60"
                    : "bg-rose-50/70 dark:bg-rose-950/30 border-rose-200 dark:border-rose-900"
                }`}>
                  <p className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground">Service Period</p>
                  <p className="font-semibold mt-0.5 flex items-center gap-1 truncate">
                    {eligibility.borrower.serviceEligible ? (
                      <Check className="h-3 w-3 text-emerald-600 shrink-0" />
                    ) : (
                      <X className="h-3 w-3 text-rose-600 shrink-0" />
                    )}
                    {eligibility.borrower.serviceMonths} mos (min {eligibility.borrower.minServiceMonthsRequired})
                  </p>
                </div>

                {/* Concurrent Loans Diagnostic */}
                <div className={`p-2.5 rounded-lg border text-xs ${
                  eligibility.borrower.concurrentEligible
                    ? "bg-emerald-50/60 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800/60"
                    : "bg-rose-50/70 dark:bg-rose-950/30 border-rose-200 dark:border-rose-900"
                }`}>
                  <p className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground">Active Loans</p>
                  <p className="font-semibold mt-0.5 flex items-center gap-1 truncate">
                    {eligibility.borrower.concurrentEligible ? (
                      <Check className="h-3 w-3 text-emerald-600 shrink-0" />
                    ) : (
                      <X className="h-3 w-3 text-rose-600 shrink-0" />
                    )}
                    {eligibility.borrower.activeLoansCount === 0 ? "None (Clean)" : `${eligibility.borrower.activeLoansCount} Active`}
                  </p>
                </div>

                {/* Repayment History Diagnostic */}
                <div className={`p-2.5 rounded-lg border text-xs ${
                  eligibility.borrower.payoutEligible
                    ? "bg-emerald-50/60 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800/60"
                    : "bg-rose-50/70 dark:bg-rose-950/30 border-rose-200 dark:border-rose-900"
                }`}>
                  <p className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground">Payout Ratio</p>
                  <p className="font-semibold mt-0.5 flex items-center gap-1 truncate">
                    {eligibility.borrower.payoutEligible ? (
                      <Check className="h-3 w-3 text-emerald-600 shrink-0" />
                    ) : (
                      <X className="h-3 w-3 text-rose-600 shrink-0" />
                    )}
                    {eligibility.borrower.payoutRatio}% (min {eligibility.borrower.minPayoutRatioRequired}%)
                  </p>
                </div>
              </div>

              {/* Policy Blocking Reasons */}
              {!eligibility.eligible && (
                <div className="rounded-xl border border-rose-200 dark:border-rose-900 bg-rose-50/70 dark:bg-rose-950/40 p-3.5 text-xs text-rose-900 dark:text-rose-200 space-y-1">
                  <div className="font-bold flex items-center gap-1.5 text-rose-700 dark:text-rose-400">
                    <ShieldAlert className="h-4 w-4 shrink-0" /> Ineligible under Company Policy:
                  </div>
                  <ul className="list-disc pl-5 space-y-0.5 text-[11px]">
                    {eligibility.reasons.map((r: string, idx: number) => (
                      <li key={idx}>{r}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Advisory Warnings */}
              {eligibility.warnings && eligibility.warnings.length > 0 && (
                <div className="rounded-xl border border-amber-200 dark:border-amber-900 bg-amber-50/70 dark:bg-amber-950/30 p-3 text-xs text-amber-900 dark:text-amber-200 space-y-1">
                  <div className="font-semibold flex items-center gap-1.5 text-amber-800 dark:text-amber-400">
                    <AlertCircle className="h-4 w-4 shrink-0" /> Policy Advisory:
                  </div>
                  <ul className="list-disc pl-5 space-y-0.5 text-[11px]">
                    {eligibility.warnings.map((w: string, idx: number) => (
                      <li key={idx}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Section 3: Loan Parameters */}
          <div className="space-y-4 pt-1">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Loan Type */}
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">Loan Type</Label>
                <Select value={type} onValueChange={setType}>
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    {LOAN_TYPES.map((t) => (
                      <SelectItem key={t} value={t} className="text-xs">
                        {titleCase(t)} Loan
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Start Date */}
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">First Deduction / Start Date</Label>
                <Input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="h-9 text-xs"
                  required
                />
              </div>
            </div>

            {/* Principal Amount with Quick Presets */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-semibold">Principal Amount (৳)</Label>
                <div className="flex items-center gap-1.5">
                  {[10000, 25000, 50000, 100000, 200000].map((amt) => (
                    <button
                      key={amt}
                      type="button"
                      onClick={() => setPrincipal(amt)}
                      className={`text-[10px] px-2 py-0.5 rounded-full border transition-all ${
                        numPrincipal === amt
                          ? "bg-indigo-600 text-white border-indigo-600 font-semibold shadow-xs"
                          : "bg-card text-muted-foreground border-border hover:bg-muted"
                      }`}
                    >
                      {amt >= 100000 ? `${amt / 100000}L` : `${amt / 1000}k`}
                    </button>
                  ))}
                </div>
              </div>
              <Input
                type="number"
                min={1}
                value={principal}
                onChange={(e) => setPrincipal(e.target.value)}
                placeholder="50000"
                className="h-9 text-xs font-mono font-medium"
                required
              />
            </div>

            {/* Installments with Quick Tenure Presets */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-semibold">Tenure (Number of Installments)</Label>
                <div className="flex items-center gap-1.5">
                  {[3, 6, 12, 24, 36].map((mos) => (
                    <button
                      key={mos}
                      type="button"
                      onClick={() => setInstallments(mos)}
                      className={`text-[10px] px-2 py-0.5 rounded-full border transition-all ${
                        numInstallments === mos
                          ? "bg-indigo-600 text-white border-indigo-600 font-semibold shadow-xs"
                          : "bg-card text-muted-foreground border-border hover:bg-muted"
                      }`}
                    >
                      {mos}m
                    </button>
                  ))}
                </div>
              </div>
              <Input
                type="number"
                min={1}
                max={360}
                value={installments}
                onChange={(e) => setInstallments(e.target.value)}
                placeholder="12"
                className="h-9 text-xs font-mono font-medium"
                required
              />
            </div>
          </div>

          {/* Section 4: Dynamic Financial Breakdown & EMI Card */}
          <div className="rounded-xl border border-indigo-200/70 dark:border-indigo-900/60 bg-gradient-to-br from-indigo-50/50 via-slate-50/30 to-purple-50/30 dark:from-indigo-950/20 dark:via-slate-900/40 dark:to-purple-950/20 p-4 space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                <Coins className="h-4 w-4 text-indigo-600" /> Repayment &amp; EMI Breakdown
              </span>
              <Badge variant="outline" className="text-[10px] border-indigo-200 text-indigo-700 dark:text-indigo-300">
                Direct Payroll Deduction
              </Badge>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
              <div>
                <p className="text-[10px] uppercase font-bold text-muted-foreground">Monthly EMI</p>
                <p className="text-base font-bold text-indigo-600 dark:text-indigo-400 tabular-nums">
                  {fmtMoney(monthlyEMI)}
                </p>
                <p className="text-[10px] text-muted-foreground">per month</p>
              </div>
              <div>
                <p className="text-[10px] uppercase font-bold text-muted-foreground">Total Principal</p>
                <p className="text-sm font-semibold tabular-nums text-slate-800 dark:text-slate-200">
                  {fmtMoney(numPrincipal)}
                </p>
                <p className="text-[10px] text-muted-foreground">0% Interest</p>
              </div>
              <div>
                <p className="text-[10px] uppercase font-bold text-muted-foreground">Deductions</p>
                <p className="text-sm font-semibold tabular-nums text-slate-800 dark:text-slate-200">
                  {numInstallments} months
                </p>
                <p className="text-[10px] text-muted-foreground">equal installments</p>
              </div>
              <div>
                <p className="text-[10px] uppercase font-bold text-muted-foreground">Est. Completion</p>
                <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                  {estCompletion}
                </p>
                <p className="text-[10px] text-muted-foreground">final recovery</p>
              </div>
            </div>
          </div>

          {/* Section 5: Searchable Guarantor Selection & Verification */}
          <div className="space-y-3 pt-1">
            <EmployeeSearchPicker
              employees={employees}
              selectedId={guarantorId}
              onSelect={(emp) => setGuarantorId(emp?.id || null)}
              label={`Guarantor ${eligibility?.policy?.guarantorRequired ? "(Required)" : "(Optional)"}`}
              required={eligibility?.policy?.guarantorRequired}
              excludeId={employeeId}
              helperText="The guarantor must consent via their Self-Service portal before the workflow begins"
            />

            {/* Guarantor Live Status Card */}
            {eligibility?.guarantor && (
              <div className={`p-3 rounded-xl border text-xs space-y-1.5 ${
                eligibility.guarantor.eligible
                  ? "bg-emerald-50/50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800"
                  : "bg-rose-50/60 dark:bg-rose-950/30 border-rose-200 dark:border-rose-900"
              }`}>
                <div className="flex items-center justify-between">
                  <span className="font-semibold flex items-center gap-1.5">
                    {eligibility.guarantor.eligible ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                    ) : (
                      <AlertTriangle className="h-3.5 w-3.5 text-rose-600" />
                    )}
                    Guarantor Qualification: {eligibility.guarantor.eligible ? "Qualified" : "Ineligible"}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    Tenure: {eligibility.guarantor.serviceMonths}m · Debt: {eligibility.guarantor.hasActiveDebt ? "Active Debt" : "Clear"} · History: {eligibility.guarantor.payoutRatio}%
                  </span>
                </div>
                {!eligibility.guarantor.eligible && (
                  <ul className="list-disc pl-5 text-[11px] text-rose-700 dark:text-rose-300">
                    {eligibility.guarantor.reasons.map((r: string, idx: number) => (
                      <li key={idx}>{r}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          {/* Section 6: Purpose & Notes */}
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold">Purpose / Reason (Optional)</Label>
            <Textarea
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              placeholder="e.g. Family medical emergency, home renovation, or education fee"
              rows={2}
              className="text-xs"
            />
          </div>

          {/* Error Banner */}
          {submitError && (
            <div className="rounded-xl border border-rose-300 bg-rose-50 dark:bg-rose-950/40 p-3 text-xs text-rose-700 dark:text-rose-300 flex items-center gap-2">
              <AlertCircle className="h-4 w-4 shrink-0 text-rose-600" />
              <span>{submitError}</span>
            </div>
          )}

          {/* Footer Actions */}
          <div className="pt-2 flex items-center justify-end gap-2.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
              className="h-9 px-4 text-xs"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={!canSubmit || submitting}
              className="h-9 px-5 text-xs bg-indigo-600 hover:bg-indigo-700 text-white font-semibold shadow-sm gap-1.5"
            >
              {submitting ? (
                <>
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" /> Submitting…
                </>
              ) : (
                <>
                  <Check className="h-3.5 w-3.5" /> Submit Application
                </>
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Professional SaaS-grade Advance Application Dialog */
function AdvanceApplicationDialog({
  open,
  onOpenChange,
  employees,
  isEmployee,
  currentUserEmployeeId,
  presetEmployeeId,
  onSuccess,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  employees: any[]
  isEmployee: boolean
  currentUserEmployeeId?: string | null
  presetEmployeeId?: string
  onSuccess: () => void
}) {
  const toast = useHrm((s) => s.toast)
  const defaultEmpId = isEmployee ? (currentUserEmployeeId || "") : (presetEmployeeId || "")

  const [employeeId, setEmployeeId] = useState(defaultEmpId)
  const [amount, setAmount] = useState<number | string>(15000)
  const [installments, setInstallments] = useState<number | string>(1)
  const [recoveryDate, setRecoveryDate] = useState(new Date().toISOString().slice(0, 10))
  const [guarantorId, setGuarantorId] = useState<string | null>(null)
  const [reason, setReason] = useState("")

  const [eligibility, setEligibility] = useState<any | null>(null)
  const [evaluating, setEvaluating] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setEmployeeId(isEmployee ? (currentUserEmployeeId || "") : (presetEmployeeId || ""))
      setAmount(15000)
      setInstallments(1)
      setRecoveryDate(new Date().toISOString().slice(0, 10))
      setGuarantorId(null)
      setReason("")
      setSubmitError(null)
    }
  }, [open, isEmployee, currentUserEmployeeId, presetEmployeeId])

  useEffect(() => {
    if (!open || !employeeId) {
      setEligibility(null)
      return
    }

    let active = true
    setEvaluating(true)

    const timer = setTimeout(async () => {
      try {
        const res = await rpc<any>("loans.checkEligibility", {
          employeeId,
          guarantorId: guarantorId || undefined,
          principal: Number(amount) || 0,
          installments: Number(installments) || 1,
          type: "ADVANCE",
        })
        if (active) {
          setEligibility(res)
        }
      } catch (err: any) {
        if (active) {
          console.warn("Advance eligibility preflight error", err)
        }
      } finally {
        if (active) setEvaluating(false)
      }
    }, 250)

    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [open, employeeId, guarantorId, amount, installments])

  const numAmount = Math.max(0, Number(amount) || 0)
  const numInstallments = Math.max(1, Number(installments) || 1)
  const monthlyRecovery = Math.round(numAmount / numInstallments)

  const canSubmit =
    !!employeeId &&
    numAmount > 0 &&
    numInstallments >= 1 &&
    (!eligibility || eligibility.eligible)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return

    setSubmitting(true)
    setSubmitError(null)
    try {
      await rpc("advances.create", {
        ...(isEmployee ? {} : { employeeId }),
        amount: numAmount,
        installments: numInstallments,
        recoveryDate: recoveryDate || undefined,
        reason: reason.trim() || undefined,
        ...(isEmployee ? {} : { guarantorId: guarantorId || undefined }),
      })
      toast(`Advance request of ${fmtMoney(numAmount)} submitted successfully.`)
      onSuccess()
      onOpenChange(false)
    } catch (err: any) {
      setSubmitError(err?.message || "Failed to submit advance request")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[92vh] overflow-y-auto p-0 gap-0 rounded-2xl">
        <div className="p-5 border-b border-border bg-slate-50/70 dark:bg-slate-900/40">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-teal-600 text-white flex items-center justify-center shadow-md shadow-teal-500/20">
              <Wallet className="h-5 w-5" />
            </div>
            <div>
              <DialogTitle className="text-base font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                Request Salary Advance
                {evaluating ? (
                  <Badge variant="outline" className="text-[10px] font-normal gap-1 text-teal-600 border-teal-200">
                    <RefreshCw className="h-2.5 w-2.5 animate-spin" /> Evaluating…
                  </Badge>
                ) : eligibility ? (
                  eligibility.eligible ? (
                    <Badge className="bg-emerald-100 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 border-emerald-300 text-[10px] gap-1">
                      <CheckCircle2 className="h-3 w-3 text-emerald-600" /> Eligible
                    </Badge>
                  ) : (
                    <Badge className="bg-rose-100 dark:bg-rose-950/60 text-rose-800 dark:text-rose-300 border-rose-300 text-[10px] gap-1">
                      <AlertTriangle className="h-3 w-3 text-rose-600" /> Ineligible
                    </Badge>
                  )
                ) : null}
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                Short-term interest-free emergency funding recovered via upcoming payroll runs.
              </DialogDescription>
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          {!isEmployee && (
            <EmployeeSearchPicker
              employees={employees}
              selectedId={employeeId || null}
              onSelect={(emp) => setEmployeeId(emp?.id || "")}
              label="Borrower (Employee)"
              required
              excludeId={guarantorId}
              helperText="Select the employee requesting this salary advance"
            />
          )}

          {/* Section 2: Real-time Eligibility Diagnostics */}
          {eligibility && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {/* Status Diagnostic */}
                <div className={`p-2.5 rounded-lg border text-xs ${
                  eligibility.borrower.statusEligible
                    ? "bg-emerald-50/60 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800/60"
                    : "bg-rose-50/70 dark:bg-rose-950/30 border-rose-200 dark:border-rose-900"
                }`}>
                  <p className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground">Status</p>
                  <p className="font-semibold mt-0.5 flex items-center gap-1 truncate">
                    {eligibility.borrower.statusEligible ? (
                      <Check className="h-3 w-3 text-emerald-600 shrink-0" />
                    ) : (
                      <X className="h-3 w-3 text-rose-600 shrink-0" />
                    )}
                    {eligibility.borrower.status}
                  </p>
                </div>

                {/* Service Period Diagnostic */}
                <div className={`p-2.5 rounded-lg border text-xs ${
                  eligibility.borrower.serviceEligible
                    ? "bg-emerald-50/60 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800/60"
                    : "bg-rose-50/70 dark:bg-rose-950/30 border-rose-200 dark:border-rose-900"
                }`}>
                  <p className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground">Service Period</p>
                  <p className="font-semibold mt-0.5 flex items-center gap-1 truncate">
                    {eligibility.borrower.serviceEligible ? (
                      <Check className="h-3 w-3 text-emerald-600 shrink-0" />
                    ) : (
                      <X className="h-3 w-3 text-rose-600 shrink-0" />
                    )}
                    {eligibility.borrower.serviceMonths} mos (min {eligibility.borrower.minServiceMonthsRequired})
                  </p>
                </div>

                {/* Concurrent Loans & Advances Diagnostic */}
                <div className={`p-2.5 rounded-lg border text-xs ${
                  eligibility.borrower.concurrentEligible
                    ? "bg-emerald-50/60 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800/60"
                    : "bg-rose-50/70 dark:bg-rose-950/30 border-rose-200 dark:border-rose-900"
                }`}>
                  <p className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground">Active Debt</p>
                  <p className="font-semibold mt-0.5 flex items-center gap-1 truncate">
                    {eligibility.borrower.concurrentEligible ? (
                      <Check className="h-3 w-3 text-emerald-600 shrink-0" />
                    ) : (
                      <X className="h-3 w-3 text-rose-600 shrink-0" />
                    )}
                    {eligibility.borrower.totalActiveCredits === 0 ? "None (Clear)" : `${eligibility.borrower.totalActiveCredits} Active`}
                  </p>
                </div>

                {/* Repayment History Diagnostic */}
                <div className={`p-2.5 rounded-lg border text-xs ${
                  eligibility.borrower.payoutEligible
                    ? "bg-emerald-50/60 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800/60"
                    : "bg-rose-50/70 dark:bg-rose-950/30 border-rose-200 dark:border-rose-900"
                }`}>
                  <p className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground">Payout Ratio</p>
                  <p className="font-semibold mt-0.5 flex items-center gap-1 truncate">
                    {eligibility.borrower.payoutEligible ? (
                      <Check className="h-3 w-3 text-emerald-600 shrink-0" />
                    ) : (
                      <X className="h-3 w-3 text-rose-600 shrink-0" />
                    )}
                    {eligibility.borrower.payoutRatio}% (min {eligibility.borrower.minPayoutRatioRequired}%)
                  </p>
                </div>
              </div>

              {/* Policy Blocking Reasons */}
              {!eligibility.eligible && (
                <div className="rounded-xl border border-rose-200 dark:border-rose-900 bg-rose-50/70 dark:bg-rose-950/40 p-3.5 text-xs text-rose-900 dark:text-rose-200 space-y-1">
                  <div className="font-bold flex items-center gap-1.5 text-rose-700 dark:text-rose-400">
                    <ShieldAlert className="h-4 w-4 shrink-0" /> Ineligible under Company Policy:
                  </div>
                  <ul className="list-disc pl-5 space-y-0.5 text-[11px]">
                    {eligibility.reasons.map((r: string, idx: number) => (
                      <li key={idx}>{r}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Advisory Warnings */}
              {eligibility.warnings && eligibility.warnings.length > 0 && (
                <div className="rounded-xl border border-amber-200 dark:border-amber-900 bg-amber-50/70 dark:bg-amber-950/30 p-3 text-xs text-amber-900 dark:text-amber-200 space-y-1">
                  <div className="font-semibold flex items-center gap-1.5 text-amber-800 dark:text-amber-400">
                    <AlertCircle className="h-4 w-4 shrink-0" /> Policy Advisory:
                  </div>
                  <ul className="list-disc pl-5 space-y-0.5 text-[11px]">
                    {eligibility.warnings.map((w: string, idx: number) => (
                      <li key={idx}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <div className="space-y-4">
            {/* Amount */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-semibold">Advance Amount (৳)</Label>
                <div className="flex items-center gap-1.5">
                  {[5000, 10000, 20000, 30000, 50000].map((amt) => (
                    <button
                      key={amt}
                      type="button"
                      onClick={() => setAmount(amt)}
                      className={`text-[10px] px-2 py-0.5 rounded-full border transition-all ${
                        numAmount === amt
                          ? "bg-teal-600 text-white border-teal-600 font-semibold shadow-xs"
                          : "bg-card text-muted-foreground border-border hover:bg-muted"
                      }`}
                    >
                      ৳{amt >= 1000 ? `${amt / 1000}k` : amt}
                    </button>
                  ))}
                </div>
              </div>
              <Input
                type="number"
                min={1}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="15000"
                className="h-9 text-xs font-mono font-medium"
                required
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Installments */}
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">Recovery Installments</Label>
                <Select value={String(installments)} onValueChange={setInstallments}>
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue placeholder="Select installments" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1 Month (Lump-sum recovery)</SelectItem>
                    <SelectItem value="2">2 Monthly Installments</SelectItem>
                    <SelectItem value="3">3 Monthly Installments</SelectItem>
                    <SelectItem value="6">6 Monthly Installments</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Recovery Date */}
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">Recovery Start Date</Label>
                <Input
                  type="date"
                  value={recoveryDate}
                  onChange={(e) => setRecoveryDate(e.target.value)}
                  className="h-9 text-xs"
                />
              </div>
            </div>
          </div>

          {/* Recovery Breakdown Card */}
          <div className="rounded-xl border border-teal-200 dark:border-teal-900 bg-teal-50/40 dark:bg-teal-950/20 p-4 space-y-2">
            <span className="text-xs font-bold text-teal-900 dark:text-teal-200 flex items-center gap-1.5">
              <Coins className="h-4 w-4 text-teal-600" /> Recovery Calculation
            </span>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-1">
              <div>
                <p className="text-[10px] uppercase font-bold text-muted-foreground">Monthly Recovery</p>
                <p className="text-sm font-bold text-teal-700 dark:text-teal-300 tabular-nums">
                  {fmtMoney(monthlyRecovery)} / month
                </p>
              </div>
              <div>
                <p className="text-[10px] uppercase font-bold text-muted-foreground">Total Advance</p>
                <p className="text-sm font-semibold tabular-nums text-slate-800 dark:text-slate-200">
                  {fmtMoney(numAmount)}
                </p>
              </div>
              <div>
                <p className="text-[10px] uppercase font-bold text-muted-foreground">Deductions</p>
                <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                  {numInstallments} {numInstallments === 1 ? "payroll cycle" : "payroll cycles"}
                </p>
              </div>
            </div>
          </div>

          {/* Guarantor Selection & Verification */}
          {!isEmployee && (
            <div className="space-y-3 pt-1">
              <EmployeeSearchPicker
                employees={employees}
                selectedId={guarantorId}
                onSelect={(emp) => setGuarantorId(emp?.id || null)}
                label={`Guarantor ${eligibility?.policy?.guarantorRequired ? "(Required)" : "(Fallback Payer / Optional)"}`}
                required={eligibility?.policy?.guarantorRequired}
                excludeId={employeeId}
                helperText="Carries recovery when borrower has no payable salary in a period"
              />

              {/* Guarantor Live Status Card */}
              {eligibility?.guarantor && (
                <div className={`p-3 rounded-xl border text-xs space-y-1.5 ${
                  eligibility.guarantor.eligible
                    ? "bg-emerald-50/50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800"
                    : "bg-rose-50/60 dark:bg-rose-950/30 border-rose-200 dark:border-rose-900"
                }`}>
                  <div className="flex items-center justify-between">
                    <span className="font-semibold flex items-center gap-1.5">
                      {eligibility.guarantor.eligible ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                      ) : (
                        <AlertTriangle className="h-3.5 w-3.5 text-rose-600" />
                      )}
                      Guarantor Qualification: {eligibility.guarantor.eligible ? "Qualified" : "Ineligible"}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      Tenure: {eligibility.guarantor.serviceMonths}m · Debt: {eligibility.guarantor.hasActiveDebt ? "Active Debt" : "Clear"} · History: {eligibility.guarantor.payoutRatio}%
                    </span>
                  </div>
                  {!eligibility.guarantor.eligible && (
                    <ul className="list-disc pl-5 text-[11px] text-rose-700 dark:text-rose-300">
                      {eligibility.guarantor.reasons.map((r: string, idx: number) => (
                        <li key={idx}>{r}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Reason */}
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold">Reason / Note (Optional)</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Festival advance, emergency medical expenses, urgent family support"
              rows={2}
              className="text-xs"
            />
          </div>

          {submitError && (
            <div className="rounded-xl border border-rose-300 bg-rose-50 dark:bg-rose-950/40 p-3 text-xs text-rose-700 dark:text-rose-300 flex items-center gap-2">
              <AlertCircle className="h-4 w-4 shrink-0 text-rose-600" />
              <span>{submitError}</span>
            </div>
          )}

          <div className="pt-2 flex items-center justify-end gap-2.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
              className="h-9 px-4 text-xs"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={!canSubmit || submitting}
              className="h-9 px-5 text-xs bg-teal-600 hover:bg-teal-700 text-white font-semibold shadow-sm gap-1.5"
            >
              {submitting ? (
                <>
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" /> Submitting…
                </>
              ) : (
                <>
                  <Check className="h-3.5 w-3.5" /> Submit Request
                </>
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ================= LOANS =================
function LoansTab() {
  const { can, user, navigate } = useHrm()
  // P6 WS-B — server-paged list (MOD-16 contract): the tenant's whole loan
  // book no longer ships to the browser; search + pagination run in SQL and
  // the KPI strip reads the paged `summary` block (set-based cohort truth).
  const [q, setQ] = useState("")
  const presetEmployeeId = useHrm((s) => (s.view?.key === "loans" ? ((s.view?.params as any)?.employeeId as string | undefined) : undefined))
  const { rows, total, page, pageSize, maxPage, loading, error, reload, setPage, envelope } =
    useServerPagedList<any>("loans.list", { q: q || undefined, employeeId: presetEmployeeId }, 50)
  const { data: employees } = useEmployeeDirectory()
  const [applyOpen, setApplyOpen] = useState(false)
  const [detail, setDetail] = useState<any>(null)
  const [payTarget, setPayTarget] = useState<any>(null)
  const [act, setAct] = useState<any>(null)
  const stats: any = envelope?.summary

  const isEmployee = user?.role === "EMPLOYEE"
  const canApply = can("loans", "create") || can("ess", "create")

  const presetEmployeeName = presetEmployeeId ? (employees || []).find((e: any) => e.id === presetEmployeeId)?.fullName : undefined

  const canSeeQueue = can("approvals", "view")
  const { data: queue, reload: reloadQueue } = useApi<any[]>(canSeeQueue ? "approvals.queue" : null, { status: "PENDING" })
  const pendingApproval = useMemo(() => {
    const m = new Map<string, any>()
    for (const q of queue || []) {
      if (q.processType === "LOAN" && q.entityId) m.set(q.entityId, q)
    }
    return m
  }, [queue])

  // P6 WS-B — the KPI strip reads the set-based summary (cohort truth);
  // page-scoped fallbacks keep the cards honest if the envelope is absent
  const loans = rows
  const totalOutstanding = stats ? Number(stats.outstandingActive) : loans.filter((l) => l.status === "ACTIVE").reduce((s, l) => s + (l.outstanding || 0), 0)
  const activeCount = stats ? Number(stats.active) : loans.filter((l) => l.status === "ACTIVE").length
  const pendingCount = stats ? Number(stats.pending) : loans.filter((l) => l.status === "PENDING").length
  const closedCount = stats ? Number(stats.closed) : loans.filter((l) => l.status === "CLOSED").length

  const columns: Column<any>[] = [
    {
      key: "employeeName", label: "Employee", sortValue: (l) => l.employeeName,
      render: (l) => (
        <div>
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{l.employeeName}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">{l.employeeCode}</p>
        </div>
      ),
    },
    { key: "type", label: "Type", render: (l) => <Badge variant="outline" className="text-[10px]">{titleCase(l.type)}</Badge> },
    { key: "principal", label: "Principal", align: "right", sortValue: (l) => l.principal, render: (l) => <span className="text-xs text-slate-600 dark:text-slate-300 tabular-nums">{fmtMoney(l.principal)}</span> },
    {
      key: "installments", label: "Installments", sortValue: (l) => (l.installments || []).length,
      render: (l) => {
        const insts: any[] = l.installments || []
        if (!insts.length) return <span className="text-xs text-slate-400">—</span>
        const paid = insts.filter((i) => i.status === "PAID").length
        const pct = Math.round((paid / insts.length) * 100)
        return (
          <div className="w-24">
            <div className="flex justify-between text-[10px] text-slate-500 mb-0.5 tabular-nums">
              <span>{paid}/{insts.length}</span><span>{pct}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
              <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )
      },
    },
    { key: "paidAmount", label: "Paid", align: "right", sortValue: (l) => l.paidAmount, render: (l) => <span className="text-xs tabular-nums">{fmtMoney(l.paidAmount)}</span> },
    { key: "outstanding", label: "Outstanding", align: "right", sortValue: (l) => l.outstanding, render: (l) => <span className="text-xs font-bold tabular-nums text-slate-800 dark:text-slate-100">{fmtMoney(l.outstanding)}</span> },
    { key: "nextDue", label: "Next Due", sortValue: (l) => l.nextDue || "", render: (l) => <span className="text-xs text-slate-500 tabular-nums">{fmtDate(l.nextDue)}</span> },
    { key: "status", label: "Status", render: (l) => <StatusBadge status={l.status} /> },
    {
      key: "actions", label: "", align: "right",
      render: (l) => {
        const q = l.status === "PENDING" ? pendingApproval.get(l.id) : null
        if (l.status === "PENDING" && l.guarantorStatus === "PENDING") {
          return (
            <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300 text-[9px] whitespace-nowrap"
              title={`Waiting for ${l.guarantorName || "the guarantor"} to consent before the workflow starts`}>
              awaiting guarantor
            </Badge>
          )
        }
        if (!q) return null
        if (!q.canAct || !can("loans", "approve")) {
          return <Badge className="bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-500 dark:text-slate-400 text-[9px] whitespace-nowrap" title="Waiting for an earlier workflow step to complete">at step: {q.stepName}</Badge>
        }
        return (
          <div className="flex items-center justify-end gap-1">
            <Button size="sm" variant="outline" className="h-7 text-[10px] text-emerald-700 border-emerald-300 hover:bg-emerald-50 dark:text-emerald-400 dark:border-emerald-900"
              onClick={(e) => { e.stopPropagation(); setAct({ row: l, q, decision: "APPROVE" }) }}>
              <Check className="h-3 w-3 mr-0.5" /> Approve
            </Button>
            <Button size="sm" variant="outline" className="h-7 text-[10px] text-rose-700 border-rose-300 hover:bg-rose-50 dark:text-rose-400 dark:border-rose-900"
              onClick={(e) => { e.stopPropagation(); setAct({ row: l, q, decision: "REJECT" }) }}>
              <X className="h-3 w-3 mr-0.5" /> Reject
            </Button>
          </div>
        )
      },
    },
  ]

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Total Outstanding" value={fmtMoney(totalOutstanding)} icon={Landmark} tone="emerald" />
        <StatCard label="Active Loans" value={activeCount} icon={Wallet} tone="teal" />
        <StatCard label="Pending Approval" value={pendingCount} icon={Clock} tone="amber" />
        <StatCard label="Closed Loans" value={closedCount} icon={CheckCircle2} tone="slate" />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-500 flex items-center gap-1.5">
          <Info className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
          Goes through the approval workflow (Manager → HR → Finance). Approved loans auto-deduct from payroll.
        </p>
        {presetEmployeeId && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 dark:bg-emerald-950/40 pl-2.5 pr-1 py-0.5 text-[11px] text-emerald-800 dark:text-emerald-300">
            <UserRound className="h-3 w-3" />
            {presetEmployeeName || "Selected employee"}
            <button type="button" title="Clear the employee filter" onClick={() => navigate("loans", { tab: "loans" })}
              className="h-4 w-4 rounded-full inline-flex items-center justify-center hover:bg-emerald-200 dark:hover:bg-emerald-900">
              <X className="h-2.5 w-2.5" />
            </button>
          </span>
        )}
        {canApply && (
          <Button size="sm" onClick={() => setApplyOpen(true)} className="h-8 text-xs bg-indigo-600 hover:bg-indigo-700 text-white gap-1.5 shadow-xs">
            <Plus className="h-3.5 w-3.5" /> Apply for Loan
          </Button>
        )}
      </div>

      <DataTable
        columns={columns} rows={loans} loading={loading} error={error} pageSize={12} csvName="loans"
        searchPlaceholder="Search employee…" onSearch={setQ} onRowClick={(l) => setDetail(l)}
        emptyTitle="No loans" emptyHint="Approved loans create installment schedules and post a disbursement journal."
      />
      <PagedControls page={page} maxPage={maxPage} total={total} pageSize={pageSize} onPage={setPage} loading={loading} />

      <LoanApplicationDialog
        open={applyOpen}
        onOpenChange={(v) => { setApplyOpen(v); if (!v) reload() }}
        employees={employees || []}
        isEmployee={isEmployee}
        currentUserEmployeeId={user?.employeeId}
        presetEmployeeId={presetEmployeeId}
        onSuccess={reload}
      />

      <LoanDetailDialog
        loan={detail}
        canPay={can("loans", "pay")}
        onOpenChange={(v) => { if (!v) setDetail(null) }}
        onPay={(inst) => setPayTarget({ inst, loan: detail })}
      />

      <ConfirmDialog
        open={!!payTarget}
        onOpenChange={(v) => { if (!v) setPayTarget(null) }}
        title="Record installment payment"
        message={payTarget ? `Record ${fmtMoney((payTarget.inst.amount || 0) - (payTarget.inst.paidAmount || 0))} for installment #${payTarget.inst.no} of ${payTarget.loan.employeeName}? The outstanding balance is reduced accordingly.` : ""}
        confirmLabel="Record Payment"
        onConfirm={async () => {
          await rpc("loans.recordInstallment", { installmentId: payTarget.inst.id })
          reload()
          setDetail(null)
        }}
      />

      {/* inline approve/reject via the unified approval engine */}
      <ConfirmDialog open={!!act} onOpenChange={(v) => { if (!v) setAct(null) }}
        title={act?.decision === "APPROVE" ? "Approve loan" : "Reject loan"}
        message={act
          ? `${act.row.employeeName} — ${titleCase(act.row.type)} loan of ${fmtMoney(act.row.principal)} over ${act.row.installmentCount ?? (act.row.installments || []).length} installments.${
              act.decision === "APPROVE"
                ? " Final approval generates the installment schedule and posts the disbursement journal."
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
        }} />
    </div>
  )
}

function LoanDetailDialog({ loan, canPay, onOpenChange, onPay }: {
  loan: any; canPay: boolean; onOpenChange: (v: boolean) => void; onPay: (inst: any) => void
}) {
  if (!loan) return null
  const insts: any[] = loan.installments || []
  const payable = (i: any) => ["PENDING", "PARTIAL", "OVERDUE"].includes(i.status)

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">{loan.employeeName} — {titleCase(loan.type)} Loan</DialogTitle>
          <p className="text-xs text-slate-500">
            Principal {fmtMoney(loan.principal)} · Outstanding {fmtMoney(loan.outstanding)}
            {/* L-7 — honest label: the rate is RECORDED on the ledger but is not charged in installments (the plan splits the principal exactly) */}
            {loan.interestRate ? ` · ${loan.interestRate}% p.a. (recorded)` : " · interest-free"}
          </p>
        </DialogHeader>

        <KV cols={4} items={[
          ["Status", <StatusBadge key="s" status={loan.status} />],
          ["Start Date", fmtDate(loan.startDate)],
          ["End Date", fmtDate(loan.endDate)],
          ["Paid", fmtMoney(loan.paidAmount)],
        ]} />
        {loan.guarantorName && (
          <KV cols={3} items={[
            ["Guarantor", `${loan.guarantorName}${loan.guarantorRespondedAt ? ` · responded ${fmtDate(String(loan.guarantorRespondedAt).slice(0, 10))}` : ""}`],
            ["Guarantor Status", loan.guarantorStatus ? <StatusBadge key="gs" status={loan.guarantorStatus} /> : "—"],
            ["Guarantor Note", loan.guarantorNote || "—"],
          ]} />
        )}
        {loan.status === "PENDING" && loan.guarantorStatus === "PENDING" && (
          <p className="text-[11px] text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded-md px-2.5 py-1.5">
            The approval workflow starts only after {loan.guarantorName || "the guarantor"} consents in their self-service portal.
          </p>
        )}
        {loan.purpose && (
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Purpose</p>
            <p className="text-sm text-slate-600 dark:text-slate-300">{loan.purpose}</p>
          </div>
        )}

        <div className="rounded-lg border overflow-hidden">
          <div className="px-3 py-1.5 bg-slate-50 dark:bg-slate-800/60 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Installment Schedule
          </div>
          {insts.length === 0 ? (
            <EmptyState title="No installments yet" hint="Installments are generated when the loan is approved." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50/80 dark:bg-slate-800/60">
                  <TableHead className="text-[10px] uppercase text-slate-500">No</TableHead>
                  <TableHead className="text-[10px] uppercase text-slate-500">Due Date</TableHead>
                  <TableHead className="text-[10px] uppercase text-slate-500 text-right">Amount</TableHead>
                  <TableHead className="text-[10px] uppercase text-slate-500 text-right">Paid</TableHead>
                  <TableHead className="text-[10px] uppercase text-slate-500">Status</TableHead>
                  {canPay && <TableHead className="text-[10px] uppercase text-slate-500 text-right">Action</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {insts.map((i) => (
                  <TableRow key={i.id || i.no}>
                    <TableCell className="text-xs py-1.5 tabular-nums">#{i.no}</TableCell>
                    <TableCell className="text-xs py-1.5 tabular-nums">{fmtDate(i.dueDate)}</TableCell>
                    <TableCell className="text-xs py-1.5 text-right tabular-nums">{fmtMoney(i.amount)}</TableCell>
                    <TableCell className="text-xs py-1.5 text-right tabular-nums">{fmtMoney(i.paidAmount)}</TableCell>
                    <TableCell className="py-1.5"><StatusBadge status={i.status} /></TableCell>
                    {canPay && (
                      <TableCell className="py-1.5 text-right">
                        {payable(i) ? (
                          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onPay(i)}>
                            <Wallet className="h-3 w-3 mr-1" /> Record Payment
                          </Button>
                        ) : <span className="text-xs text-slate-300 dark:text-slate-600">—</span>}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ================= ADVANCES =================
function AdvancesTab() {
  const { can, user, navigate } = useHrm()
  // P6 WS-B — server-paged list (MOD-16 contract): search + pagination in
  // SQL; the KPI strip reads the paged `summary` block (set-based truth).
  const [q, setQ] = useState("")
  const presetEmployeeId = useHrm((s) => (s.view?.key === "loans" ? ((s.view?.params as any)?.employeeId as string | undefined) : undefined))
  const { rows, total, page, pageSize, maxPage, loading, error, reload, setPage, envelope } =
    useServerPagedList<any>("advances.list", { q: q || undefined, employeeId: presetEmployeeId }, 50)
  const { data: employees } = useEmployeeDirectory()
  const [open, setOpen] = useState(false)
  const [act, setAct] = useState<any>(null)
  const stats: any = envelope?.summary

  const isEmployee = user?.role === "EMPLOYEE"
  const canRequest = can("advances", "create") || can("ess", "create")

  const presetEmployeeName = presetEmployeeId ? (employees || []).find((e: any) => e.id === presetEmployeeId)?.fullName : undefined

  const canSeeQueue = can("approvals", "view")
  const { data: queue, reload: reloadQueue } = useApi<any[]>(canSeeQueue ? "approvals.queue" : null, { status: "PENDING" })
  const pendingApproval = useMemo(() => {
    const m = new Map<string, any>()
    for (const q of queue || []) {
      if (q.processType === "ADVANCE" && q.entityId) m.set(q.entityId, q)
    }
    return m
  }, [queue])

  // P6 WS-B — set-based summary with page-scoped fallbacks
  const advances = rows
  const outstanding = stats ? Number(stats.outstandingRecovering) : advances.filter((a) => a.status === "RECOVERING").reduce((s, a) => s + (a.outstanding || 0), 0)
  const recoveringCount = stats ? Number(stats.recovering) : advances.filter((a) => a.status === "RECOVERING").length
  const pendingCount = stats ? Number(stats.pending) : advances.filter((a) => a.status === "PENDING").length
  const recoveredCount = stats ? Number(stats.recovered) : advances.filter((a) => a.status === "RECOVERED").length

  const columns: Column<any>[] = [
    {
      key: "employeeName", label: "Employee", sortValue: (a) => a.employeeName,
      render: (a) => (
        <div>
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{a.employeeName}</p>
          {a.reason && <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate max-w-[220px]">{a.reason}</p>}
        </div>
      ),
    },
    { key: "amount", label: "Amount", align: "right", sortValue: (a) => a.amount, render: (a) => <span className="text-xs font-semibold tabular-nums">{fmtMoney(a.amount)}</span> },
    { key: "requested", label: "Requested", sortValue: (a) => a.requestDate, render: (a) => <span className="text-xs text-slate-500 tabular-nums">{fmtDate(a.requestDate)}</span> },
    {
      key: "guarantor", label: "Guarantor", sortValue: (a) => a.guarantorName || "",
      render: (a) => a.guarantorName
        ? <span className="text-xs text-slate-600 dark:text-slate-300" title="Carries the recovery when the borrower has no payable salary">{a.guarantorName}</span>
        : <span className="text-xs text-slate-400">—</span>,
    },
    { key: "recoveryDate", label: "Recovery Date", sortValue: (a) => a.recoveryDate || "", render: (a) => <span className="text-xs text-slate-500 tabular-nums">{fmtDate(a.recoveryDate)}</span> },
    { key: "installments", label: "Installments", align: "right", sortValue: (a) => a.installments, render: (a) => <span className="text-xs tabular-nums">{a.installments}</span> },
    { key: "deducted", label: "Deducted", align: "right", sortValue: (a) => a.deducted, render: (a) => <span className="text-xs tabular-nums">{fmtMoney(a.deducted)}</span> },
    { key: "outstanding", label: "Outstanding", align: "right", sortValue: (a) => a.outstanding, render: (a) => <span className="text-xs font-bold tabular-nums text-slate-800 dark:text-slate-100">{fmtMoney(a.outstanding)}</span> },
    { key: "status", label: "Status", render: (a) => <StatusBadge status={a.status} /> },
    {
      key: "actions", label: "", align: "right",
      render: (a) => {
        const q = a.status === "PENDING" ? pendingApproval.get(a.id) : null
        if (!q) return null
        if (!q.canAct || !can("advances", "approve")) {
          return <Badge className="bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-500 dark:text-slate-400 text-[9px] whitespace-nowrap" title="Waiting for an earlier workflow step to complete">at step: {q.stepName}</Badge>
        }
        return (
          <div className="flex items-center justify-end gap-1">
            <Button size="sm" variant="outline" className="h-7 text-[10px] text-emerald-700 border-emerald-300 hover:bg-emerald-50 dark:text-emerald-400 dark:border-emerald-900"
              onClick={() => setAct({ row: a, q, decision: "APPROVE" })}>
              <Check className="h-3 w-3 mr-0.5" /> Approve
            </Button>
            <Button size="sm" variant="outline" className="h-7 text-[10px] text-rose-700 border-rose-300 hover:bg-rose-50 dark:text-rose-400 dark:border-rose-900"
              onClick={() => setAct({ row: a, q, decision: "REJECT" })}>
              <X className="h-3 w-3 mr-0.5" /> Reject
            </Button>
          </div>
        )
      },
    },
  ]

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Outstanding Advances" value={fmtMoney(outstanding)} icon={Coins} tone="amber" />
        <StatCard label="Under Recovery" value={recoveringCount} icon={Wallet} tone="teal" />
        <StatCard label="Pending Approval" value={pendingCount} icon={Clock} tone="violet" />
        <StatCard label="Fully Recovered" value={recoveredCount} icon={CheckCircle2} tone="emerald" />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-500 flex items-center gap-1.5">
          <Info className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
          Advances are separate from loans and recovered via payroll. When the borrower has no payable salary in a period, the recovery falls to the designated guarantor (Payroll → Loan &amp; Advance Policy).
        </p>
        {presetEmployeeId && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 dark:bg-emerald-950/40 pl-2.5 pr-1 py-0.5 text-[11px] text-emerald-800 dark:text-emerald-300">
            <UserRound className="h-3 w-3" />
            {presetEmployeeName || "Selected employee"}
            <button type="button" title="Clear the employee filter" onClick={() => navigate("loans", { tab: "advances" })}
              className="h-4 w-4 rounded-full inline-flex items-center justify-center hover:bg-emerald-200 dark:hover:bg-emerald-900">
              <X className="h-2.5 w-2.5" />
            </button>
          </span>
        )}
        {canRequest && (
          <Button size="sm" onClick={() => setOpen(true)} className="h-8 text-xs bg-teal-600 hover:bg-teal-700 text-white gap-1.5 shadow-xs">
            <Plus className="h-3.5 w-3.5" /> Request Advance
          </Button>
        )}
      </div>

      <DataTable
        columns={columns} rows={advances} loading={loading} error={error} pageSize={12} csvName="advances"
        searchPlaceholder="Search employee…" onSearch={setQ} emptyTitle="No advances" emptyHint="Approved advances post a payment journal and recover over payroll."
      />
      <PagedControls page={page} maxPage={maxPage} total={total} pageSize={pageSize} onPage={setPage} loading={loading} />

      <AdvanceApplicationDialog
        open={open}
        onOpenChange={(v) => { setOpen(v); if (!v) reload() }}
        employees={employees || []}
        isEmployee={isEmployee}
        currentUserEmployeeId={user?.employeeId}
        presetEmployeeId={presetEmployeeId}
        onSuccess={reload}
      />

      {/* inline approve/reject via the unified approval engine */}
      <ConfirmDialog open={!!act} onOpenChange={(v) => { if (!v) setAct(null) }}
        title={act?.decision === "APPROVE" ? "Approve advance" : "Reject advance"}
        message={act
          ? `${act.row.employeeName} — salary advance of ${fmtMoney(act.row.amount)}, recovered over ${act.row.installments} installment(s).${
              act.row.guarantorName ? ` Fallback payer: ${act.row.guarantorName} (carries the recovery when the borrower has no payable salary).` : ""
            }${
              act.decision === "APPROVE"
                ? " Final approval posts the payment journal and starts payroll recovery."
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
        }} />
    </div>
  )
}
