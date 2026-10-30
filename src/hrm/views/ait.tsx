"use client"
// ============ AIT / Income Tax — Income Tax Act 2023 module ============
// Spec: dynamic fiscal-year configuration (Finance Ordinance 2025 defaults for
// FY 2025-26), individual live calculator with full legal breakdown, batch TDS
// for all employees, year-end reconciliation, printable TDS certificates
// (Section 86) and the immutable calculation audit journal. Bilingual EN/বাংলা
// labels; every field carries its legal basis in a tooltip.
import { useEffect, useRef, useState } from "react"
import {
  Calculator, Users, Scale, ScrollText, Printer, Save, Loader2, Info,
  Wallet, AlertTriangle, CheckCircle2, TrendingUp, TrendingDown, RefreshCcw, Plus, Trash2,
  ArrowUp, ArrowDown, BadgeCheck, Landmark, RotateCcw, } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useHrm } from "../store"
import { rpc, useLookup } from "../api"

// HRM store toast (text, kind) — same signature every other view uses
const toast = (text: string, kind?: "ok" | "err") => useHrm.getState().toast(text, kind)
import { useApi } from "../api"
import {
  PageHeader, StatCard, SectionCard, SectionTabs, EmptyState, LoadingRows, ErrorBanner,
  StatusBadge, fmtMoney, titleCase, openPrintWindow, esc,
} from "../shared/ui-kit"
import { DataTable, type Column } from "../shared/data-table"

const DISCLAIMER_BN = "এই হিসাবটি আয়কর আইন ২০২৩-এর ধারা ৮৬ অনুযায়ী মাসিক উৎসে কর কর্তনের (AIT/TDS) একটি প্রাক্কলন (গড় হার + ধারা ৮৬(৪) সমন্বয়)। চূড়ান্ত দায় ধারা ১৬৬-এর অধীনে বার্ষিক রিটার্নে নির্ধারিত হবে। ঘোষিত বিনিয়োগের ক্ষেত্রে ধারা ৭৮ রেয়াত বার্ষিক কর থেকে বাদ দেওয়া হয়; ন্যূনতম কর ও নিট-সম্পদ সারচার্জ বার্ষিক হিসাবরূপে পৃথকভাবে দেখানো হয় এবং মাসিক কর্তনে যোগ করা হয় না। কর্মীর শ্রেণি ও ঘোষিত তথ্য HR কর্তৃক যাচাইকৃত হতে হবে।"
const DISCLAIMER_EN = "This is an estimate for monthly salary tax withholding under Section 86, Income Tax Act 2023 (average-rate method with the sub-section (4) cumulative adjustment). Final tax liability is determined by the annual return under Section 166. The Section 78 investment rebate is deducted from the annual tax when an investment is declared; the minimum-tax floor and the net-wealth surcharge are shown as separate annual items and are not added to monthly withholding. The employee category and declared figures must be verified by HR."

function LegalRef({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Info className="h-3 w-3 text-slate-400 hover:text-emerald-600 inline-block ml-1 cursor-help shrink-0" aria-hidden />
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-xs">{text}</TooltipContent>
    </Tooltip>
  )
}

export default function AitView() {
  const { can, view } = useHrm()
  const { data: configData, loading, error, reload } = useApi<any>("ait.config.get", {})

  const fy = configData?.config?.fiscalYear
  const noConfig = !loading && !error && !fy

  // global-search deep link: seed the tab from view params (remount on change)
  const presetTab = ((view?.params as any)?.tab as string) || "calculator"

  const tabs = [
    { value: "calculator", label: "Calculator", content: <CalculatorTab config={configData?.config} /> },
    { value: "employees", label: "Employees TDS / ব্যাচ", content: <BatchTab /> },
    { value: "certificates", label: "Employee AIT/Tax Certificate", content: <CertificatesTab config={configData?.config} /> },
    { value: "reconciliation", label: "Reconciliation", content: <ReconciliationTab /> },
    ...(can("ait", "edit") ? [{ value: "config", label: "Fiscal Year Config", content: <ConfigTab onChanged={reload} /> }] : []),
    { value: "audit", label: "Audit Log", content: <AuditTab /> },
  ]

  return (
    <div className="space-y-4">
      <PageHeader
        title="AIT / Income Tax — আয়কর"
        subtitle={fy
          ? `${fy.label} · income year ${fy.incomeYear} · assessment year ${fy.assessmentYear} · ${fy.tdsSectionRef}`
          : "Advance Income Tax engine (Income Tax Act 2023)"}
        actions={fy ? (
          <div className="flex items-center gap-2">
            <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 text-[11px]">
              <BadgeCheck className="h-3 w-3 mr-1" /> Active FY {fy.label}
            </Badge>
            {can("ait", "edit") && (
              <Button size="sm" variant="outline" className="h-8 text-xs bg-white dark:bg-slate-900" onClick={reload}>
                <RefreshCcw className="h-3.5 w-3.5 mr-1" /> Reload
              </Button>
            )}
          </div>
        ) : undefined}
      />

      {/* threshold + slab summary strip */}
      {fy && <ConfigSummaryStrip config={configData.config} />}

      {loading ? <LoadingRows rows={5} /> : error ? <ErrorBanner message={error} /> : noConfig ? (
        <EmptyState icon={Scale} title="No active fiscal year configuration"
          hint="An admin must create and activate a fiscal year under the Fiscal Year Config tab before any calculation can run (spec §9)." />
      ) : (
        <SectionTabs key={presetTab} defaultValue={presetTab} tabs={tabs} />
      )}

      {/* mandatory disclaimer — shown in UI and every printed report (spec §11) */}
      <div className="rounded-xl border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 p-4">
        <p className="flex items-start gap-2 text-xs text-amber-800 dark:text-amber-200">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{DISCLAIMER_BN}</span>
        </p>
        <p className="text-[11px] text-amber-700/80 dark:text-amber-300/70 mt-1.5 border-t border-amber-200/60 dark:border-amber-900/60 pt-1.5">{DISCLAIMER_EN}</p>
      </div>
    </div>
  )
}

// ---------- summary strip (3A/3B at a glance) ----------
function ConfigSummaryStrip({ config }: { config: any }) {
  const fy = config?.fiscalYear
  if (!fy) return null
  const cats: any[] = config.categories || []
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
      {cats.slice(0, 4).map((c: any) => (
        <StatCard key={c.code} label={c.label.split(" /")[0]} value={fmtMoney(c.threshold)} sub="tax-free threshold" icon={Scale} tone="emerald" />
      ))}
      <StatCard label="Salary exemption" value={fmtMoney(fy.exemptionCap)} sub={`MIN(gross × ${fy.exemptionFraction.toFixed(4)}, cap) — Third Schedule`} icon={Wallet} tone="teal" />
      <StatCard label="Minimum tax" value={fmtMoney(fy.minimumTax)} sub={`Individual floor — annual Finance Act (§163)${fy.newTaxpayerMinimumTax ? ` · first-time filers ${fmtMoney(fy.newTaxpayerMinimumTax)}` : ""}`} icon={AlertTriangle} tone="amber" />
    </div>
  )
}

// ================= CALCULATOR (7A — live & reactive) =================
function CalculatorTab({ config }: { config: any }) {
  const { can, user: _user } = useHrm()
  const { data: employees } = useLookup<any[]>("employees.list", {}, can("ait", "calculate") || can("employees", "view"))
  const [employeeId, setEmployeeId] = useState("")
  const defaultBonusCount = String(config?.fiscalYear?.festivalBonusCount ?? 2)
  const initialForm = {
    taxpayerCategory: "", monthlyBasicSalary: "", monthlyGrossSalary: "", currentMonthGross: "",
    festivalBonusBasis: "BASIC" as "BASIC" | "GROSS" | "FIXED",
    festivalBonusMultiplier: defaultBonusCount,
    festivalBonusAmount: "",
    festivalBonusOverride: "",
    annualGrossOverride: "", declaredInvestment: "", previousEmployerIncome: "", tdsYtd: "",
    netWealth: "", motorVehicles: "",
  }
  const [form, setForm] = useState(initialForm)
  const [result, setResult] = useState<any>(null)
  const [inputEcho, setInputEcho] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [calcError, setCalcError] = useState<string | null>(null)
  const [profile, setProfile] = useState<any>(null)
  const [certOpen, setCertOpen] = useState(false)
  const debRef = useRef<any>(null)

  const categories: any[] = config?.categories || []

  // load employee tax profile → prefill the form (spec §5)
  // R2 (2026-10-12) — the server returns a FLAT payload (taxpayerCategory,
  // monthlyBasicSalary, …): the old nested reads (p.employee?.…, p.structure?.…)
  // left every field undefined. tdsYtd falls back to the employee's recorded
  // taxAlreadyDeducted when the operator hasn't typed one.
  const loadProfile = async (id: string) => {
    try {
      const p = await rpc("ait.employee.profile", { employeeId: id })
      setProfile(p)
      const next = {
        taxpayerCategory: p.taxpayerCategory || "",
        monthlyBasicSalary: p.monthlyBasicSalary ? String(p.monthlyBasicSalary) : "",
        monthlyGrossSalary: p.monthlyGrossSalary ? String(p.monthlyGrossSalary) : "",
        currentMonthGross: p.monthlyGrossSalary ? String(p.monthlyGrossSalary) : "",
        festivalBonusBasis: "BASIC" as const,
        festivalBonusMultiplier: p.festivalBonusOverride != null ? String(p.festivalBonusOverride) : defaultBonusCount,
        festivalBonusAmount: "",
        festivalBonusOverride: p.festivalBonusOverride != null ? String(p.festivalBonusOverride) : "",
        annualGrossOverride: p.annualGrossOverride != null ? String(p.annualGrossOverride) : "",
        declaredInvestment: p.declaredInvestment != null ? String(p.declaredInvestment) : "",
        previousEmployerIncome: p.previousEmployerIncome ? String(p.previousEmployerIncome) : "",
        tdsYtd: p.tdsYtd ? String(p.tdsYtd) : "",
        netWealth: p.netWealth != null ? String(p.netWealth) : "",
        motorVehicles: p.motorVehicles != null ? String(p.motorVehicles) : "",
      }
      setForm(next)
      recalc(next, id)
    } catch (e: any) {
      toast(e.message || "Could not load the employee tax profile", "err")
    }
  }

  // live recalculation — debounced on any input change (spec 7A)
  const recalc = (f = form, empId = employeeId) => {
    if (debRef.current) clearTimeout(debRef.current)
    debRef.current = setTimeout(async () => {
      const hasInput = Number(f.monthlyGrossSalary) > 0 || Number(f.annualGrossOverride) > 0
      if (!hasInput) { setResult(null); setCalcError(null); return }
      setBusy(true); setCalcError(null)
      try {
        const payload: any = {
          taxpayerCategory: f.taxpayerCategory || null,
          monthlyBasicSalary: Number(f.monthlyBasicSalary || 0),
          monthlyGrossSalary: Number(f.monthlyGrossSalary || 0),
          currentMonthGross: Number(f.currentMonthGross || f.monthlyGrossSalary || 0),
          festivalBonusBasis: f.festivalBonusBasis || "BASIC",
          festivalBonusMultiplier: f.festivalBonusBasis !== "FIXED" && f.festivalBonusMultiplier !== "" ? Number(f.festivalBonusMultiplier) : null,
          festivalBonusAmount: f.festivalBonusBasis === "FIXED" && f.festivalBonusAmount !== "" ? Number(f.festivalBonusAmount) : null,
          festivalBonusOverride: f.festivalBonusBasis === "FIXED"
            ? (f.festivalBonusAmount === "" ? null : Number(f.festivalBonusAmount))
            : (f.festivalBonusMultiplier === "" ? null : Number(f.festivalBonusMultiplier)),
          annualGrossOverride: f.annualGrossOverride === "" ? null : Number(f.annualGrossOverride),
          declaredInvestment: f.declaredInvestment === "" ? null : Number(f.declaredInvestment),
          previousEmployerIncome: Number(f.previousEmployerIncome || 0),
          tdsYtd: f.tdsYtd === "" ? null : Number(f.tdsYtd),
          netWealth: f.netWealth === "" ? null : Number(f.netWealth),
          motorVehicles: f.motorVehicles === "" ? null : Number(f.motorVehicles),
        }
        if (empId) payload.employeeId = empId
        const d = await rpc("ait.calc.preview", payload)
        setResult(d.result)
        setInputEcho(d.input)
      } catch (e: any) {
        setResult(null)
        setCalcError(e.message)
      } finally { setBusy(false) }
    }, 300)
  }

  const setField = (n: string, v: string) => {
    const next = { ...form, [n]: v }
    setForm(next)
    recalc(next)
  }

  const setBonusBasis = (basis: "BASIC" | "GROSS" | "FIXED") => {
    const next = { ...form, festivalBonusBasis: basis }
    setForm(next)
    recalc(next)
  }

  const resetCalculator = () => {
    if (debRef.current) clearTimeout(debRef.current)
    setEmployeeId("")
    setProfile(null)
    setForm({
      taxpayerCategory: "",
      monthlyBasicSalary: "",
      monthlyGrossSalary: "",
      currentMonthGross: "",
      festivalBonusBasis: "BASIC",
      festivalBonusMultiplier: defaultBonusCount,
      festivalBonusAmount: "",
      festivalBonusOverride: "",
      annualGrossOverride: "",
      declaredInvestment: "",
      previousEmployerIncome: "",
      tdsYtd: "",
      netWealth: "",
      motorVehicles: "",
    })
    setResult(null)
    setInputEcho(null)
    setCalcError(null)
    toast("Calculator data cleared")
  }

  useEffect(() => { return () => { if (debRef.current) clearTimeout(debRef.current) } }, [])

  const saveProfile = async () => {
    if (!employeeId) return
    try {
      const bonusOverride = form.festivalBonusBasis === "FIXED"
        ? (form.festivalBonusAmount === "" ? null : Number(form.festivalBonusAmount))
        : (form.festivalBonusMultiplier === "" ? null : Number(form.festivalBonusMultiplier))
      await rpc("ait.employee.save", {
        employeeId,
        taxCategory: form.taxpayerCategory || null,
        festivalBonusOverride: bonusOverride,
        annualGrossOverride: form.annualGrossOverride === "" ? null : Number(form.annualGrossOverride),
        declaredInvestment: form.declaredInvestment === "" ? null : Number(form.declaredInvestment),
        previousEmployerIncome: Number(form.previousEmployerIncome || 0),
        netWealth: form.netWealth === "" ? null : Number(form.netWealth),
        motorVehicles: form.motorVehicles === "" ? null : Number(form.motorVehicles),
      })
      toast("Tax profile saved to the employee record")
      loadProfile(employeeId)
    } catch (e: any) { toast(e.message || "Could not save the tax profile", "err") }
  }

  const recordCalc = async () => {
    if (!result) return
    if (!employeeId) { toast("Pick an employee first — a recorded calculation is always tied to one", "err"); return }
    try {
      await rpc("ait.calc.save", { employeeId, input: inputEcho, result })
      toast("Calculation recorded to the audit journal")
    } catch (e: any) { toast(e.message || "Could not record", "err") }
  }

  const empOpts = (employees || []).filter((e: any) => ["ACTIVE", "PROBATION", "ON_LEAVE"].includes(e.status))

  return (
    <div className="grid grid-cols-1 xl:grid-cols-5 gap-4 items-start">
      {/* ---------- inputs ---------- */}
      <div className="xl:col-span-2 space-y-3">
        <SectionCard
          title="Inputs — ইনপুট"
          actions={
            <div className="flex items-center gap-1.5">
              {busy && <Loader2 className="h-4 w-4 animate-spin text-emerald-600 mr-1" />}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={resetCalculator}
                className="h-7 px-2 text-xs text-slate-500 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30 gap-1"
                title="Reset all inputs and clear calculator"
              >
                <RotateCcw className="h-3 w-3" /> Clear / Reset
              </Button>
            </div>
          }
        >
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Employee / কর্মী</Label>
              <Select value={employeeId || "none"} onValueChange={(v) => {
                const id = v === "none" ? "" : v
                setEmployeeId(id); setResult(null)
                if (id) loadProfile(id)
                else setForm({ ...form, taxpayerCategory: "" })
              }}>
                <SelectTrigger className="h-9"><SelectValue placeholder="Ad-hoc calculation (no employee)" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Ad-hoc — no employee record</SelectItem>
                  {empOpts.map((e: any) => <SelectItem key={e.id} value={e.id}>{e.fullName} ({e.code})</SelectItem>)}
                </SelectContent>
              </Select>
              {profile && <p className="text-[11px] text-slate-500">DOB {profile.employee?.dob || "—"} · TDS YTD from payroll ৳{Number(profile.tdsYtd || 0).toLocaleString("en-IN")}</p>}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Taxpayer category <LegalRef text="Tax-free threshold per category — annual Finance Act rates (§18(2), ITA 2023), configurable per fiscal year. Senior (≥65) and female are auto-suggested from the profile with a verify warning." /></Label>
                <Select value={form.taxpayerCategory || "general"} onValueChange={(v) => setField("taxpayerCategory", v === "general" ? "" : v)}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="general">General / সাধারণ</SelectItem>
                    {categories.filter((c: any) => c.code !== "general").map((c: any) => (
                      <SelectItem key={c.code} value={c.code}>{c.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Current month gross (৳)</Label>
                <Input type="number" min={0} value={form.currentMonthGross} onChange={(e) => setField("currentMonthGross", e.target.value)} className="h-9"
                  placeholder="actual gross this month" aria-label="Current month gross salary in taka" />
                <p className="text-[10px] text-slate-400">This month&rsquo;s TDS base <LegalRef text="Monthly TDS = current month's gross × average rate — Section 86, ITA 2023 average-rate method." /></p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Monthly basic (৳)</Label>
                <Input type="number" min={0} value={form.monthlyBasicSalary} onChange={(e) => setField("monthlyBasicSalary", e.target.value)} className="h-9" placeholder="e.g. 30000" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Monthly gross (৳) <span className="text-rose-500">*</span></Label>
                <Input type="number" min={0} value={form.monthlyGrossSalary} onChange={(e) => setField("monthlyGrossSalary", e.target.value)} className="h-9" placeholder="e.g. 60000" />
              </div>
            </div>

            <div className="border-t pt-3 space-y-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Festival Bonus & Overrides</p>

              {/* Dynamic Festival Bonus */}
              <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/40 p-2.5 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <Label className="text-xs font-medium">Festival bonus (উৎসব ভাতা)</Label>
                    <p className="text-[10px] text-slate-400">Calculate based on basic, gross, or a fixed amount</p>
                  </div>
                  <div className="inline-flex items-center rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 p-0.5 text-xs shadow-2xs">
                    <button
                      type="button"
                      onClick={() => setBonusBasis("BASIC")}
                      className={`px-2 py-0.5 rounded text-[11px] font-semibold transition-all ${
                        form.festivalBonusBasis === "BASIC"
                          ? "bg-emerald-600 text-white shadow-2xs"
                          : "text-slate-600 dark:text-slate-400 hover:text-slate-900"
                      }`}
                    >
                      Basic
                    </button>
                    <button
                      type="button"
                      onClick={() => setBonusBasis("GROSS")}
                      className={`px-2 py-0.5 rounded text-[11px] font-semibold transition-all ${
                        form.festivalBonusBasis === "GROSS"
                          ? "bg-emerald-600 text-white shadow-2xs"
                          : "text-slate-600 dark:text-slate-400 hover:text-slate-900"
                      }`}
                    >
                      Gross
                    </button>
                    <button
                      type="button"
                      onClick={() => setBonusBasis("FIXED")}
                      className={`px-2 py-0.5 rounded text-[11px] font-semibold transition-all ${
                        form.festivalBonusBasis === "FIXED"
                          ? "bg-emerald-600 text-white shadow-2xs"
                          : "text-slate-600 dark:text-slate-400 hover:text-slate-900"
                      }`}
                    >
                      Fixed Amount (৳)
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 items-center pt-0.5">
                  {form.festivalBonusBasis === "FIXED" ? (
                    <>
                      <div className="space-y-1">
                        <Label className="text-[10px] text-slate-500 uppercase tracking-wide">Fixed Bonus Amount (৳)</Label>
                        <Input
                          type="number"
                          min={0}
                          value={form.festivalBonusAmount}
                          onChange={(e) => setField("festivalBonusAmount", e.target.value)}
                          className="h-8 text-xs bg-white dark:bg-slate-950"
                          placeholder="e.g. 50000"
                        />
                      </div>
                      <div className="text-[11px] text-slate-500 bg-white dark:bg-slate-950 p-2 rounded border border-slate-200 dark:border-slate-800">
                        Total annual festival bonus: <b className="text-emerald-600 dark:text-emerald-400">৳{Number(form.festivalBonusAmount || 0).toLocaleString("en-IN")}</b>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="space-y-1">
                        <Label className="text-[10px] text-slate-500 uppercase tracking-wide">
                          Multiplier ({form.festivalBonusBasis === "GROSS" ? "× Monthly Gross" : "× Monthly Basic"})
                        </Label>
                        <div className="flex items-center gap-1.5">
                          <Input
                            type="number"
                            min={0}
                            step="0.5"
                            value={form.festivalBonusMultiplier}
                            onChange={(e) => setField("festivalBonusMultiplier", e.target.value)}
                            className="h-8 text-xs bg-white dark:bg-slate-950 w-28"
                            placeholder={String(config?.fiscalYear?.festivalBonusCount ?? 2)}
                          />
                          <span className="text-xs text-slate-500">
                            × {form.festivalBonusBasis === "GROSS" ? "gross" : "basic"}
                          </span>
                        </div>
                      </div>
                      <div className="text-[11px] text-slate-500 bg-white dark:bg-slate-950 p-2 rounded border border-slate-200 dark:border-slate-800">
                        Total annual bonus: <b className="text-emerald-600 dark:text-emerald-400">৳{Math.round(
                          (Number(form.festivalBonusMultiplier || (config?.fiscalYear?.festivalBonusCount ?? 2))) *
                          (form.festivalBonusBasis === "GROSS" ? Number(form.monthlyGrossSalary || 0) : Number(form.monthlyBasicSalary || 0))
                        ).toLocaleString("en-IN")}</b>
                      </div>
                    </>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Annual gross override (৳)</Label>
                  <Input type="number" min={0} value={form.annualGrossOverride} onChange={(e) => setField("annualGrossOverride", e.target.value)} className="h-9" placeholder="actual known annual" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Declared investment (৳) <LegalRef text="Investment tax rebate — Section 78, ITA 2023 (as consolidated June 2025). Rebate = LOWER OF 3% of taxable income, the year's rebate rate (15%/10%) of eligible investment, or the absolute cap (৳10,00,000 / ৳7,50,000). Applied only when HR records the declaration with proof (Sixth Schedule Part 3 items — life insurance, recognised PF, government securities, mutual funds, etc.)." /></Label>
                  <Input type="number" min={0} value={form.declaredInvestment} onChange={(e) => setField("declaredInvestment", e.target.value)} className="h-9" placeholder="only with proof" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Previous employer income (৳)</Label>
                  <Input type="number" min={0} value={form.previousEmployerIncome} onChange={(e) => setField("previousEmployerIncome", e.target.value)} className="h-9" placeholder="same income year" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">TDS deducted YTD (৳) <LegalRef text="§86(4) — the actual tax already deducted this income year (auto-filled from PAID payroll runs + prior withholding). Drives the cumulative surplus/deficit catch-up adjustment." /></Label>
                  <Input type="number" min={0} value={form.tdsYtd} onChange={(e) => setField("tdsYtd", e.target.value)} className="h-9" placeholder="year to date" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Declared net worth (৳) <LegalRef text="Net-wealth surcharge (FO 2025 / FA 2026): 10% of the tax amount over ৳4 crore net worth (or owning more than one motor car, or a city-corporation house over 8,000 sft), 20% over ৳10 crore, 30% over ৳20 crore, 35% over ৳50 crore. Assessed on the annual tax after rebate — never added to monthly withholding." /></Label>
                  <Input type="number" min={0} value={form.netWealth} onChange={(e) => setField("netWealth", e.target.value)} className="h-9" placeholder="surcharge test" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Motor vehicles owned</Label>
                  <Input type="number" min={0} value={form.motorVehicles} onChange={(e) => setField("motorVehicles", e.target.value)} className="h-9" placeholder="more than 1 triggers the 10% band" />
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 text-xs text-slate-600 hover:text-rose-600 hover:border-rose-200 hover:bg-rose-50 dark:hover:bg-rose-950/30 gap-1 bg-white dark:bg-slate-900"
                onClick={resetCalculator}
              >
                <RotateCcw className="h-3.5 w-3.5 text-slate-400" /> Clear / Reset
              </Button>
              {employeeId && can("ait", "edit") && (
                <Button size="sm" variant="outline" className="h-8 text-xs bg-white dark:bg-slate-900" onClick={saveProfile}>
                  <Save className="h-3.5 w-3.5 mr-1 text-emerald-600" /> Save profile to employee
                </Button>
              )}
              {result && (
                <Button size="sm" variant="outline" className="h-8 text-xs bg-white dark:bg-slate-900" onClick={recordCalc}>
                  <ScrollText className="h-3.5 w-3.5 mr-1 text-emerald-600" /> Record calculation
                </Button>
              )}
              {employeeId && result && (
                <Button size="sm" className="h-8 text-xs " onClick={() => setCertOpen(true)}>
                  <Printer className="h-3.5 w-3.5 mr-1" /> TDS certificate
                </Button>
              )}
            </div>
          </div>
        </SectionCard>
      </div>

      {/* ---------- live breakdown ---------- */}
      <div className="xl:col-span-3">
        {calcError ? (
          <div className="rounded-xl border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 p-4 text-sm text-rose-700 dark:text-rose-300">{calcError}</div>
        ) : !result ? (
          <EmptyState icon={Calculator} title="Enter a monthly gross to see the live breakdown"
            hint="Every output updates in real time as any input changes — projection, exemption, threshold, slabs, average rate and this month's TDS." />
        ) : (
          <BreakdownCard result={result} />
        )}
      </div>

      {certOpen && employeeId && (
        <CertificateDialog employeeId={employeeId} onClose={() => setCertOpen(false)} />
      )}
    </div>
  )
}

// ---------- glassmorphism breakdown card (spec §6 + §8) ----------
function BreakdownCard({ result }: { result: any }) {
  const lines: any[] = result.lines || []
  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-slate-700/60 bg-slate-900/90 dark:bg-slate-900/95 backdrop-blur-xl shadow-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-700/60 flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-bold text-slate-50">Calculation breakdown — হিসাবের বিবরণ</p>
            <p className="text-[11px] text-slate-400">{result.config?.label} · income year {result.config?.incomeYear} · AY {result.config?.assessmentYear}</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge className="bg-slate-800 text-slate-200 border border-slate-700 text-[10px]">{result.categoryLabel?.split(" /")[0]}</Badge>
            {result.categoryAssumed && <Badge className="bg-amber-500/15 text-amber-300 border border-amber-700/50 text-[10px]">verify category</Badge>}
          </div>
        </div>

        <div className="divide-y divide-slate-800/70">
          {lines.map((l, i) => {
            const isTotal = l.key === "monthlyTds"
            const isMajor = ["annualGross", "taxableIncome", "annualTax", "averageRate"].includes(l.key)
            if (l.key === "slabTax") return null // rendered as the slab table below
            return (
              <div key={l.key} className={`flex items-start justify-between gap-3 px-5 py-2.5 ${isTotal ? "bg-gradient-to-r from-emerald-600/25 via-teal-500/20 to-emerald-600/25" : isMajor ? "bg-slate-800/40" : ""}`}>
                <div className="min-w-0">
                  <p className={`text-xs ${isTotal ? "font-bold text-emerald-200" : isMajor ? "font-semibold text-slate-100" : "text-slate-300"}`}>
                    {i + 1}. {l.label} <span className="text-slate-500 font-normal">/ {l.labelBn}</span>
                    {l.ref ? <LegalRef text={l.ref} /> : null}
                  </p>
                  {(l.formula || l.key === "threshold") && (
                    <p className="text-[10px] text-slate-500 mt-0.5 font-mono">
                      {l.formula || `category threshold applied: ${result.categoryLabel?.split(" /")[0]}`}
                    </p>
                  )}
                </div>
                <p className={`tabular-nums shrink-0 ${isTotal ? "text-lg font-extrabold text-emerald-200" : isMajor ? "text-sm font-bold text-slate-100" : "text-sm text-slate-300"}`}>
                  {l.display ?? fmtMoney(l.value)}
                </p>
              </div>
            )
          })}
        </div>

        {/* slab-wise table (spec §6 line 7) */}
        {(result.slabLines || []).length > 0 && (
          <div className="px-5 py-4 border-t border-slate-700/60">
            <p className="text-xs font-semibold text-slate-100 mb-2">
              Slab-wise tax — স্তরভিত্তিক কর <LegalRef text="Progressive slabs applied to income above the category threshold — annual Finance Act slab table (rates prescribed per assessment year, §18(2) ITA 2023). Bands and rates are fiscal-year configuration, never hardcoded." />
            </p>
            <div className="rounded-xl overflow-hidden border border-slate-700/60">
              <Table>
                <TableHeader>
                  <TableRow className="bg-slate-800/70 border-slate-700/60">
                    <TableHead className="text-[10px] uppercase text-slate-400">Slab</TableHead>
                    <TableHead className="text-[10px] uppercase text-slate-400 text-right">Rate</TableHead>
                    <TableHead className="text-[10px] uppercase text-slate-400 text-right">Amount taxed</TableHead>
                    <TableHead className="text-[10px] uppercase text-slate-400 text-right">Tax</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.slabLines.map((s: any, i: number) => (
                    <TableRow key={i} className="border-slate-800/70">
                      <TableCell className="text-xs text-slate-300 py-2">{s.slab || s.slabLabel}</TableCell>
                      <TableCell className="text-xs text-slate-300 py-2 text-right tabular-nums">{s.rate}%</TableCell>
                      <TableCell className="text-xs text-slate-300 py-2 text-right tabular-nums">{fmtMoney(s.amount)}</TableCell>
                      <TableCell className="text-xs text-slate-100 py-2 text-right tabular-nums font-semibold">{fmtMoney(s.tax)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </div>

      {/* warnings (spec §6) */}
      {(result.warnings || []).length > 0 && (
        <SectionCard title="⚠ Warnings — সতর্কতা">
          <ul className="space-y-2">
            {result.warnings.map((w: any, i: number) => (
              <li key={i} className="flex items-start gap-2 text-xs text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded-lg px-3 py-2">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <span>{w.message}{w.bn ? <span className="block text-[11px] opacity-80 mt-0.5">{w.bn}</span> : null}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      {/* notes */}
      {(result.notes || []).length > 0 && (
        <SectionCard title="Notes">
          <ul className="space-y-1.5">
            {result.notes.map((n: string, i: number) => (
              <li key={i} className="flex items-start gap-2 text-[11px] text-slate-600 dark:text-slate-300">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0 mt-0.5" /> {n}
              </li>
            ))}
          </ul>
        </SectionCard>
      )}
    </div>
  )
}

// ================= BATCH (7B) =================
function BatchTab() {
  const { can } = useHrm()
  const [data, setData] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [branchId, setBranchId] = useState("")
  const { data: branches } = useApi<any[]>(can("organization", "view") ? "branches.list" : null, {})

  const run = async () => {
    setBusy(true); setError(null)
    try {
      const d = await rpc("ait.batch.calculate", branchId ? { branchId } : {})
      setData(d)
      toast(`TDS calculated for ${d.summary.employees} employees under ${d.fiscalYear}`)
    } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }

  const columns: Column<any>[] = [
    { key: "employeeName", label: "Employee", sortValue: (r) => r.name, render: (r) => (
      <div><p className="text-sm font-semibold">{r.name}</p><p className="text-[11px] text-slate-500">{r.code}</p></div>
    ) },
    { key: "category", label: "Category", sortValue: (r) => r.category, render: (r) => (
      <div className="flex items-center gap-1">
        <Badge variant="outline" className="text-[10px]">{r.category || "—"}</Badge>
        {r.categoryAssumed && <Badge className="bg-amber-100 text-amber-700 text-[9px]">assumed</Badge>}
      </div>
    ) },
    { key: "annualGross", label: "Annual gross", align: "right", sortValue: (r) => r.annualGross, render: (r) => <span className="text-xs tabular-nums">{fmtMoney(r.annualGross)}</span> },
    { key: "annualTax", label: "Annual tax", align: "right", sortValue: (r) => r.annualTax, render: (r) => <span className="text-xs tabular-nums font-semibold">{fmtMoney(r.annualTax)}</span> },
    { key: "averageRate", label: "Avg rate", align: "right", sortValue: (r) => r.averageRatePercent, render: (r) => <span className="text-xs tabular-nums">{r.averageRatePercent?.toFixed(2)}%</span> },
    { key: "monthlyTds", label: "Monthly TDS", align: "right", sortValue: (r) => r.monthlyTds, render: (r) => <span className="text-xs tabular-nums font-bold text-emerald-700 dark:text-emerald-400">{fmtMoney(r.monthlyTds)}</span> },
    { key: "warnings", label: "Flags", render: (r) => (
      <div className="flex flex-wrap gap-1">
        {(r.warnings || []).includes("MIN_TAX") && <Badge className="bg-amber-100 text-amber-700 text-[9px]">min tax</Badge>}
        {(r.warnings || []).some((w: string) => w.startsWith("CATEGORY_") || w === "DOB_MISSING") && <Badge className="bg-sky-100 text-sky-700 text-[9px]">verify category</Badge>}
        {(r.warnings || []).length === 0 && <span className="text-slate-400 text-xs">—</span>}
      </div>
    ) },
  ]

  return (
    <div className="space-y-3">
      <SectionCard title="Batch TDS — ব্যাচ কর গণনা" actions={
        <div className="flex items-center gap-2">
          {(branches || []).length > 0 && (
            <Select value={branchId || "all"} onValueChange={(v) => setBranchId(v === "all" ? "" : v)}>
              <SelectTrigger className="h-8 w-44 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All branches</SelectItem>
                {(branches || []).map((b: any) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
          {can("ait", "calculate") && (
            <Button size="sm" className="h-8 text-xs " onClick={run} disabled={busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Calculator className="h-3.5 w-3.5 mr-1" />} Calculate all employees
            </Button>
          )}
        </div>
      }>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Pulls every employee with an active salary structure under the active fiscal-year configuration and computes TDS in one pass
          (spec 7B). Each result is written to the immutable audit journal with the configuration snapshot used.
        </p>
        {error && <p className="text-sm text-rose-600 bg-rose-50 rounded-md px-3 py-2 mt-3">{error}</p>}
      </SectionCard>

      {data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <StatCard label="Employees" value={data.summary.employees} icon={Users} tone="emerald" />
            <StatCard label="Total annual tax" value={fmtMoney(data.summary.totalAnnualTax)} icon={Landmark} tone="teal" />
            <StatCard label="Total monthly TDS" value={fmtMoney(data.summary.totalMonthlyTds)} icon={Wallet} tone="sky" />
            <StatCard label="Below minimum tax" value={data.summary.minTaxFlags} sub="minimum-tax floor warning" icon={AlertTriangle} tone="amber" />
            <StatCard label="Unverified category" value={data.summary.unverifiedCategories} sub="missing DOB / assumed" icon={Info} tone="slate" />
          </div>
          <DataTable columns={columns} rows={data.results} pageSize={15} csvName="ait-batch"
            searchPlaceholder="Search employee…" emptyTitle="No employees with salary structures" emptyHint="Employees need an active salary structure before TDS can be computed." />
        </>
      )}
    </div>
  )
}

// ================= RECONCILIATION (7C) =================
function ReconciliationTab() {
  const { data, loading, error, reload } = useApi<any>("ait.reconciliation", {})
  const [busy, setBusy] = useState<string | null>(null)
  const [adjusted, setAdjusted] = useState<Record<string, boolean>>({})

  // the route returns the raw gap + months left; the catch-up monthly amount is gap ÷ remaining months
  const suggestedMonthly = (r: any) => Math.ceil(r.gap / Math.max(1, r.catchUpMonthsLeft || 1))
  const applyAdjustment = async (row: any) => {
    setBusy(row.employeeId)
    try {
      await rpc("deductions.save", {
        employeeId: row.employeeId, type: "AIT", label: `TDS catch-up — remaining ${row.catchUpMonthsLeft} month(s)`,
        amount: suggestedMonthly(row), month: new Date().getMonth() + 1, year: new Date().getFullYear(),
      })
      setAdjusted((a) => ({ ...a, [row.employeeId]: true }))
      toast(`৳${suggestedMonthly(row).toLocaleString("en-IN")}/month catch-up deduction added for ${row.name}`)
    } catch (e: any) { toast(e.message || "Could not add the adjustment", "err") } finally { setBusy(null) }
  }

  const columns: Column<any>[] = [
    { key: "employeeName", label: "Employee", sortValue: (r) => r.name, render: (r) => (
      <div><p className="text-sm font-semibold">{r.name}</p><p className="text-[11px] text-slate-500">{r.code}</p></div>
    ) },
    { key: "annualTax", label: "Estimated annual tax", align: "right", sortValue: (r) => r.annualTax, render: (r) => <span className="text-xs tabular-nums">{fmtMoney(r.annualTax)}</span> },
    { key: "tdsYtd", label: "TDS deducted YTD", align: "right", sortValue: (r) => r.deducted, render: (r) => <span className="text-xs tabular-nums">{fmtMoney(r.deducted)}</span> },
    { key: "gap", label: "Surplus / (Shortfall)", align: "right", sortValue: (r) => r.gap, render: (r) => (
      <span className={`text-xs font-bold tabular-nums ${r.gap > 0 ? "text-rose-600" : r.gap < -1000 ? "text-sky-600" : "text-emerald-600"}`}>
        {r.gap > 0 ? `−${fmtMoney(r.gap)}` : `+${fmtMoney(-r.gap)}`}
      </span>
    ) },
    { key: "status", label: "Status", render: (r) => <StatusBadge status={r.status} /> },
    { key: "suggested", label: "Suggested TDS / month", align: "right", render: (r) => r.gap > 0 ? (
      <div className="flex items-center justify-end gap-2">
        <span className="text-xs font-bold tabular-nums text-amber-600">{fmtMoney(suggestedMonthly(r))}</span>
        {adjusted[r.employeeId] ? <Badge className="bg-emerald-100 text-emerald-700 text-[9px]">added</Badge> : (
          <Button size="sm" variant="outline" className="h-7 text-[11px] bg-white dark:bg-slate-900" disabled={busy === r.employeeId}
            onClick={() => applyAdjustment(r)}>Add catch-up</Button>
        )}
      </div>
    ) : <span className="text-slate-400 text-xs">—</span> },
  ]

  // derived totals — the route returns per-direction counts, not per-direction totals
  const recRows: any[] = data?.rows || []
  const totalShortfall = recRows.filter((r) => r.status === "SHORTFALL").reduce((s, r) => s + r.gap, 0)
  const totalSurplus = recRows.filter((r) => r.status === "SURPLUS").reduce((s, r) => s - r.gap, 0)

  return (
    <div className="space-y-3">
      {data?.fiscalYear && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <StatCard label="Income year" value={data.fiscalYear} sub={`${data.summary.monthsElapsed} month(s) elapsed`} icon={Scale} tone="emerald" />
          <StatCard label="Employees" value={data.summary.employees} icon={Users} tone="teal" />
          <StatCard label="Shortfall employees" value={data.summary.shortfall} sub={fmtMoney(totalShortfall)} icon={TrendingDown} tone="rose" />
          <StatCard label="Surplus employees" value={data.summary.surplus} sub={fmtMoney(totalSurplus)} icon={TrendingUp} tone="sky" />
          <StatCard label="On track" value={data.summary.employees - data.summary.shortfall - data.summary.surplus} icon={CheckCircle2} tone="slate" />
        </div>
      )}
      <SectionCard title="Year-end reconciliation — বার্ষিক সমন্বয়" actions={
        <Button size="sm" variant="outline" className="h-8 text-xs bg-white dark:bg-slate-900" onClick={reload}>
          <RefreshCcw className="h-3.5 w-3.5 mr-1" /> Refresh
        </Button>
      }>
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
          Compares TDS actually deducted (payroll entries inside the income year) against the estimated annual liability
          (spec 7C). &ldquo;Add catch-up&rdquo; creates an AIT deduction line for the suggested monthly amount so the remaining
          months cover the gap.
        </p>
        <DataTable columns={columns} rows={data?.rows ?? undefined} loading={loading} error={error} pageSize={12} csvName="ait-reconciliation"
          searchPlaceholder="Search employee…" emptyTitle="Nothing to reconcile yet" emptyHint="Run payroll with AIT deductions first." />
      </SectionCard>
    </div>
  )
}

// ================= FISCAL YEAR CONFIG (7E — admin) =================
function ConfigTab({ onChanged }: { onChanged: () => void }) {
  const { data: years, loading, error, reload } = useApi<any[]>("ait.fiscalYears.list", {})
  const [fyOpen, setFyOpen] = useState<any>(null)
  const [catsOpen, setCatsOpen] = useState<any>(null)
  const [slabsOpen, setSlabsOpen] = useState<any>(null)

  const activate = async (y: any) => {
    try {
      await rpc("ait.fiscalYears.activate", { id: y.id })
      toast(`${y.label} activated — all other years deactivated`)
      reload(); onChanged()
    } catch (e: any) { toast(e.message, "err") }
  }

  return (
    <div className="space-y-3">
      <SectionCard title="Fiscal years — অর্থ বছর" actions={
        <Button size="sm" className="h-8 text-xs " onClick={() => setFyOpen({})}>
          <Plus className="h-3.5 w-3.5 mr-1" /> New fiscal year
        </Button>
      }>
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
          <b>This is the single control point for every AIT/TDS rule.</b> Everything the engine reads is stored per fiscal
          year — thresholds, taxpayer categories, slabs, the salary exemption, minimum tax and rebate rates (spec §3) — so a
          new Finance Act year is a configuration change, never a code change. Only one year can be active at a time, and
          payroll runs keep the snapshot they were calculated with.
        </p>
        {loading ? <LoadingRows rows={3} /> : error ? <ErrorBanner message={error} /> : !(years || []).length ? (
          <EmptyState title="No fiscal years yet" hint="Create FY 2025-26 with the Finance Ordinance 2025 defaults." />
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {(years || []).map((y: any) => (
              <div key={y.id} className={`rounded-xl border p-4 space-y-2 ${y.active ? "border-emerald-300 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-950/30" : "border-slate-200 dark:border-slate-800"}`}>
                <div className="flex items-center justify-between">
                  <p className="text-sm font-bold">{y.label}</p>
                  {y.active ? <Badge className="bg-emerald-100 text-emerald-700 text-[10px]"><BadgeCheck className="h-3 w-3 mr-1" />Active</Badge>
                    : <Button size="sm" variant="outline" className="h-7 text-[11px] bg-white dark:bg-slate-900" onClick={() => activate(y)}>Activate</Button>}
                </div>
                <p className="text-[11px] text-slate-500">Income year {y.incomeYear} · AY {y.assessmentYear}</p>
                <p className="text-[11px] text-slate-500">{y.categories?.length ?? 0} categories · {y.slabs?.length ?? 0} slabs</p>
                <p className="text-[11px] text-slate-500 font-mono">exempt 1/{Math.round(1 / (y.exemptionFraction || 1/3))} · cap {fmtMoney(y.exemptionCap)} · min {fmtMoney(y.minimumTax)}</p>
                <div className="flex flex-wrap gap-1.5 pt-1">
                  <Button size="sm" variant="outline" className="h-7 text-[11px] bg-white dark:bg-slate-900" onClick={() => setFyOpen(y)}>Edit</Button>
                  <Button size="sm" variant="outline" className="h-7 text-[11px] bg-white dark:bg-slate-900" onClick={() => setCatsOpen(y)}>Categories</Button>
                  <Button size="sm" variant="outline" className="h-7 text-[11px] bg-white dark:bg-slate-900" onClick={() => setSlabsOpen(y)}>Slabs</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      {fyOpen && <FiscalYearDialog year={fyOpen} onClose={(v) => { setFyOpen(null); if (v) { reload(); onChanged() } }} />}
      {catsOpen && <CategoriesDialog year={catsOpen} onClose={(v) => { setCatsOpen(null); if (v) { reload(); onChanged() } }} />}
      {slabsOpen && <SlabsDialog year={slabsOpen} onClose={(v) => { setSlabsOpen(null); if (v) { reload(); onChanged() } }} />}
    </div>
  )
}

function FiscalYearDialog({ year, onClose }: { year: any; onClose: (saved: boolean) => void }) {
  const toast = useHrm((s) => s.toast)
  const [v, setV] = useState<Record<string, any>>({
    label: year?.label || "", incomeYear: year?.incomeYear || "", assessmentYear: year?.assessmentYear || "",
    tdsSectionRef: year?.tdsSectionRef || "Section 86, Income Tax Act 2023",
    exemptionFraction: year?.exemptionFraction ?? 0.3333, exemptionCap: year?.exemptionCap ?? 500000,
    minimumTax: year?.minimumTax ?? 5000, newTaxpayerMinimumTax: year?.newTaxpayerMinimumTax ?? 1000,
    rebateRatePercent: year?.rebateRatePercent ?? 10,
    rebateIncomeCapPercent: year?.rebateIncomeCapPercent ?? 3,
    rebateCapFraction: year?.rebateCapFraction ?? 0.25, rebateCapAmount: year?.rebateCapAmount ?? 750000,
    festivalBonusCount: year?.festivalBonusCount ?? 2, notes: year?.notes || "",
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const set = (n: string, val: any) => setV((s) => ({ ...s, [n]: val }))

  const submit = async () => {
    setBusy(true); setErr(null)
    try {
      await rpc("ait.fiscalYears.save", { ...(year?.id ? { id: year.id } : {}), ...v })
      toast(year?.id ? "Fiscal year updated" : "Fiscal year created")
      onClose(true)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  const F = ({ n, label, hint, step = 1 }: { n: string; label: string; hint?: string; step?: number }) => (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium">{label}</Label>
      <Input type={n === "label" || n === "incomeYear" || n === "assessmentYear" || n === "tdsSectionRef" || n === "notes" ? "text" : "number"}
        step={step} value={v[n] ?? ""} onChange={(e) => set(n, e.target.value)} className="h-9" />
      {hint && <p className="text-[10px] text-slate-500">{hint}</p>}
    </div>
  )

  return (
    <Dialog open onOpenChange={(_o) => !busy && onClose(false)}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">{year?.id ? `Edit — ${year.label}` : "New fiscal year"}</DialogTitle>
          <DialogDescription className="text-xs">
            Finance-Act values for this year — rates are prescribed per assessment year by Parliament (§18(2), ITA 2023). Defaults shown are the Finance Act 2026 figures for FY 2026-27.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 py-1">
          <F n="label" label="Label" hint='e.g. "FY 2026-27"' />
          <F n="incomeYear" label="Income year" hint="e.g. 2026-27 (July 2026 – June 2027)" />
          <F n="assessmentYear" label="Assessment year" hint="Income year + 1 — §2(15)/(24), ITA 2023 (e.g. 2027-28)" />
          <F n="tdsSectionRef" label="TDS section reference" hint="Shown on certificates and tooltips" />
          <F n="exemptionFraction" label="Exemption fraction" step={0.0001} hint="1/3 = 0.3333 — Third Schedule item 27, ITA 2023" />
          <F n="exemptionCap" label="Exemption cap (৳)" hint="৳5,00,000 for IY 2025-26 onward" />
          <F n="minimumTax" label="Minimum tax (৳)" hint="Individual floor — annual Finance Act (§163 framework); warning-only for TDS" />
          <F n="newTaxpayerMinimumTax" label="First-time filer minimum (৳)" hint="৳1,000 (AY 2026-27+); blank = not applicable" />
          <F n="rebateRatePercent" label="Investment rebate rate (%)" hint="§78(b) — 15% (IY 2025-26) / 10% (IY 2026-27)" />
          <F n="rebateIncomeCapPercent" label="Rebate cap — % of taxable income" step={0.01} hint="§78(a) — 3% of taxable income" />
          <F n="rebateCapAmount" label="Rebate absolute cap (৳)" hint="§78(c) — ৳10,00,000 (IY 2025-26) / ৳7,50,000 (IY 2026-27)" />
          <F n="festivalBonusCount" label="Festival bonuses (× basic)" hint="Default projection: 2 × basic (spec §4 step 1)" />
          <div className="sm:col-span-2"><F n="notes" label="Notes (NBR circular / SRO references)" /></div>
        </div>
        {err && <p className="text-sm text-rose-600 bg-rose-50 dark:bg-rose-950 rounded-md px-3 py-2">{err}</p>}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onClose(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "Saving…" : "Save fiscal year"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CategoriesDialog({ year, onClose }: { year: any; onClose: (saved: boolean) => void }) {
  const toast = useHrm((s) => s.toast)
  const [rows, setRows] = useState<any[]>(
    (year?.categories?.length)
      ? year.categories.map((c: any) => ({ code: c.key, label: c.label, threshold: c.threshold, autoRule: null, active: true }))
      : [{ code: "general", label: "General / সাধারণ", threshold: 400000, autoRule: null, active: true }]
  )
  const [busy, setBusy] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    (async () => {
      try {
        const { config } = await rpc("ait.config.get", { fiscalYearId: year.id })
        setRows((config?.categories || []).map((c: any) => ({ code: c.code, label: c.label, threshold: c.threshold, autoRule: c.autoRule, active: true })))
      } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
    })()
  }, [year.id])

  const save = async () => {
    setBusy(true); setErr(null)
    try {
      await rpc("ait.categories.save", { fiscalYearId: year.id, categories: rows.map((r, i) => ({ ...r, sortOrder: i + 1 })) })
      toast("Taxpayer categories saved")
      onClose(true)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <Dialog open onOpenChange={() => !busy && onClose(false)}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">Taxpayer categories — {year.label}</DialogTitle>
          <DialogDescription className="text-xs">
            Tax-free thresholds per category (annual Finance Act rates — FO 2025 / FA 2026). Add custom categories or
            adjust thresholds every year — the engine reads whatever exists.
          </DialogDescription>
        </DialogHeader>
        {busy && !rows.length ? <LoadingRows rows={4} /> : (
          <div className="rounded-xl border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50 dark:bg-slate-800">
                  <TableHead className="text-[10px] uppercase">Code</TableHead>
                  <TableHead className="text-[10px] uppercase">Label (EN / বাংলা)</TableHead>
                  <TableHead className="text-[10px] uppercase text-right">Threshold ৳</TableHead>
                  <TableHead className="text-[10px] uppercase">Auto-rule</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r, i) => (
                  <TableRow key={i}>
                    <TableCell className="p-1.5"><Input value={r.code} onChange={(e) => setRows((a) => a.map((x, j) => j === i ? { ...x, code: e.target.value } : x))} className="h-8 text-xs" /></TableCell>
                    <TableCell className="p-1.5"><Input value={r.label} onChange={(e) => setRows((a) => a.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} className="h-8 text-xs" /></TableCell>
                    <TableCell className="p-1.5"><Input type="number" value={r.threshold} onChange={(e) => setRows((a) => a.map((x, j) => j === i ? { ...x, threshold: Number(e.target.value) } : x))} className="h-8 text-xs tabular-nums" /></TableCell>
                    <TableCell className="p-1.5">
                      <Select value={r.autoRule || "none"} onValueChange={(val) => setRows((a) => a.map((x, j) => j === i ? { ...x, autoRule: val === "none" ? null : val } : x))}>
                        <SelectTrigger className="h-8 text-xs w-36"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">—</SelectItem>
                          <SelectItem value="AGE_GE_65">Age ≥ 65</SelectItem>
                          <SelectItem value="GENDER_FEMALE">Female</SelectItem>
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="p-1.5 text-right">
                      <Button size="icon" variant="ghost" className="h-7 w-7 text-slate-400 hover:text-rose-600" disabled={rows.length <= 1}
                        onClick={() => setRows((a) => a.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" /></Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="border-t px-3 py-2 bg-slate-50 dark:bg-slate-800">
              <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => setRows((a) => [...a, { code: "", label: "", threshold: 400000, autoRule: null, active: true }])}>
                <Plus className="h-3 w-3 mr-1" /> Add category
              </Button>
            </div>
          </div>
        )}
        {err && <p className="text-sm text-rose-600 bg-rose-50 dark:bg-rose-950 rounded-md px-3 py-2 mt-2">{err}</p>}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onClose(false)} disabled={busy}>Cancel</Button>
          <Button onClick={save} disabled={busy}>{busy ? "Saving…" : "Save categories"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SlabsDialog({ year, onClose }: { year: any; onClose: (saved: boolean) => void }) {
  const toast = useHrm((s) => s.toast)
  const [rows, setRows] = useState<any[]>([])
  const [busy, setBusy] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    (async () => {
      try {
        const { config } = await rpc("ait.config.get", { fiscalYearId: year.id })
        setRows((config?.slabs || []).map((s: any) => ({ order: s.order, slabLabel: s.slabLabel, upperLimit: s.upperLimit, ratePercent: s.ratePercent })))
      } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
    })()
  }, [year.id])

  const move = (i: number, dir: -1 | 1) => setRows((a) => {
    const b = [...a]
    const j = i + dir
    if (j < 0 || j >= b.length) return a
    ;[b[i], b[j]] = [b[j], b[i]]
    return b
  })

  const save = async () => {
    setBusy(true); setErr(null)
    try {
      await rpc("ait.slabs.save", { fiscalYearId: year.id, slabs: rows.map((r, i) => ({ ...r, order: i + 1 })) })
      toast("Slabs saved")
      onClose(true)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <Dialog open onOpenChange={() => !busy && onClose(false)}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">Tax slabs — {year.label}</DialogTitle>
          <DialogDescription className="text-xs">
            Ordered cumulative bands applied to income ABOVE the category threshold. Width is the band size (৳); the final band
            must be unlimited. The engine loops over whatever slabs exist — it never assumes a fixed count.
          </DialogDescription>
        </DialogHeader>
        {busy && !rows.length ? <LoadingRows rows={4} /> : (
          <div className="rounded-xl border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50 dark:bg-slate-800">
                  <TableHead className="text-[10px] uppercase w-8"></TableHead>
                  <TableHead className="text-[10px] uppercase">Slab label</TableHead>
                  <TableHead className="text-[10px] uppercase text-right">Band width ৳ (blank = ∞)</TableHead>
                  <TableHead className="text-[10px] uppercase text-right">Rate %</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r, i) => (
                  <TableRow key={i}>
                    <TableCell className="p-1.5">
                      <div className="flex flex-col">
                        <Button size="icon" variant="ghost" className="h-5 w-5" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="h-3 w-3" /></Button>
                        <Button size="icon" variant="ghost" className="h-5 w-5" disabled={i === rows.length - 1} onClick={() => move(i, 1)}><ArrowDown className="h-3 w-3" /></Button>
                      </div>
                    </TableCell>
                    <TableCell className="p-1.5"><Input value={r.slabLabel} onChange={(e) => setRows((a) => a.map((x, j) => j === i ? { ...x, slabLabel: e.target.value } : x))} className="h-8 text-xs" placeholder="e.g. First ৳ 3,00,000" /></TableCell>
                    <TableCell className="p-1.5"><Input type="number" value={r.upperLimit ?? ""} onChange={(e) => setRows((a) => a.map((x, j) => j === i ? { ...x, upperLimit: e.target.value === "" ? null : Number(e.target.value) } : x))} className="h-8 text-xs tabular-nums" placeholder="∞" /></TableCell>
                    <TableCell className="p-1.5"><Input type="number" step={0.5} value={r.ratePercent} onChange={(e) => setRows((a) => a.map((x, j) => j === i ? { ...x, ratePercent: Number(e.target.value) } : x))} className="h-8 text-xs w-24 tabular-nums" /></TableCell>
                    <TableCell className="p-1.5 text-right">
                      <Button size="icon" variant="ghost" className="h-7 w-7 text-slate-400 hover:text-rose-600" disabled={rows.length <= 1}
                        onClick={() => setRows((a) => a.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" /></Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="border-t px-3 py-2 bg-slate-50 dark:bg-slate-800">
              <Button size="sm" variant="outline" className="h-7 text-[11px]"
                onClick={() => setRows((a) => [...a, { slabLabel: "", upperLimit: null, ratePercent: 0 }])}>
                <Plus className="h-3 w-3 mr-1" /> Add band
              </Button>
            </div>
          </div>
        )}
        {err && <p className="text-sm text-rose-600 bg-rose-50 dark:bg-rose-950 rounded-md px-3 py-2 mt-2">{err}</p>}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onClose(false)} disabled={busy}>Cancel</Button>
          <Button onClick={save} disabled={busy}>{busy ? "Saving…" : "Save slabs"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ================= EMPLOYEE AIT/TAX CERTIFICATES (7D — per-employee register) =================
function CertificatesTab({ config }: { config: any }) {
  const { can } = useHrm()
  const [period, setPeriod] = useState({ month: new Date().getMonth() + 1, year: new Date().getFullYear() })
  const [certFor, setCertFor] = useState<string | null>(null)
  const { data: employees, loading, error, refresh } = useLookup<any[]>("employees.list", {}, can("ait", "calculate") || can("employees", "view"))

  const categories: any[] = config?.categories || []
  const catLabel = (code?: string | null) =>
    code ? (categories.find((c: any) => c.code === code)?.label?.split(" /")[0] || titleCase(code)) : "General"
  const rows = (employees || []).filter((e: any) => ["ACTIVE", "PROBATION", "ON_LEAVE"].includes(e.status))

  const columns: Column<any>[] = [
    {
      key: "fullName", label: "Employee", sortValue: (e) => e.fullName, render: (e) => (
        <div>
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{e.fullName}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">{e.code} · {e.designationName || "—"}</p>
        </div>
      ),
    },
    { key: "taxTin", label: "TIN", sortValue: (e) => e.taxTin || "", render: (e) => <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300">{e.taxTin || "—"}</span> },
    { key: "taxCategory", label: "Category", sortValue: (e) => e.taxCategory || "", render: (e) => (
      <Badge variant="outline" className="text-[10px]">{catLabel(e.taxCategory)}</Badge>
    ) },
    { key: "branchName", label: "Branch", sortValue: (e) => e.branchName || "", render: (e) => <span className="text-xs text-slate-500 dark:text-slate-400">{e.branchName || "—"}</span> },
    { key: "status", label: "Status", render: (e) => <StatusBadge status={e.status} /> },
    {
      key: "actions", label: "", align: "right", render: (e) => can("ait", "view") && (
        <Button size="sm" variant="outline" className="h-7 text-[11px] bg-white dark:bg-slate-900" onClick={() => setCertFor(e.id)}>
          <Printer className="h-3 w-3 mr-1" /> Certificate
        </Button>
      ),
    },
  ]

  return (
    <div className="space-y-3">
      <SectionCard title="Employee AIT/Tax Certificates — কর্মী কর সনদ" actions={
        <div className="flex items-center gap-2">
          <Select value={String(period.month)} onValueChange={(v) => setPeriod((p) => ({ ...p, month: Number(v) }))}>
            <SelectTrigger className="h-8 w-32 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {Array.from({ length: 12 }, (_, i) => <SelectItem key={i + 1} value={String(i + 1)}>{monthName(i + 1)}</SelectItem>)}
            </SelectContent>
          </Select>
          <Input type="number" value={period.year} min={2000} max={2100} aria-label="Certificate year"
            onChange={(e) => setPeriod((p) => ({ ...p, year: Number(e.target.value) || p.year }))}
            className="h-8 w-20 text-xs tabular-nums" />
          <Button size="sm" variant="outline" className="h-8 text-xs bg-white dark:bg-slate-900" onClick={refresh}>
            <RefreshCcw className="h-3.5 w-3.5 mr-1" /> Refresh
          </Button>
        </div>
      }>
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
          Print the Section 86 salary-tax (TDS) certificate for any employee for the selected month of {monthName(period.month)} {period.year}
          (spec 7D). Each certificate carries the company header with TIN, the employee&rsquo;s TIN and designation, the income/assessment year,
          the full step-by-step calculation with slab lines, the month&rsquo;s TDS and the year-to-date figure, the bilingual disclaimer and the
          authorized-signatory block. Employees can also download their own certificate from Employee Self-Service.
        </p>
        <DataTable columns={columns} rows={rows} loading={loading} error={error} pageSize={12} csvName="ait-certificate-register"
          searchPlaceholder="Search employee…" emptyTitle="No employees found"
          emptyHint="Employees appear here once they exist in the directory." />
      </SectionCard>

      {certFor && (
        <CertificateDialog employeeId={certFor} month={period.month} year={period.year} onClose={() => setCertFor(null)} />
      )}
    </div>
  )
}

// ================= TDS CERTIFICATE (7D — printable) =================
// C-07 — exported pure builder (unit-testable): every interpolation is escaped
// so stored values (names, designations, signatories, slabs, admin-editable
// letter text) can never break out of text/attribute context in print output.
export function buildTdsCertificateHtml(c: any, month: number, year: number): string {
  const rows = (c.result?.lines || []).map((l: any) =>
    `<tr><td style="padding:6px 10px;border-bottom:1px solid #e2e8f0">${esc(l.label)}${l.ref ? ` <span style="color:#64748b">(${esc(l.ref)})</span>` : ""}</td><td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;text-align:right;font-variant-numeric:tabular-nums">${esc(l.display ?? fmtMoney(l.value))}</td></tr>`
  ).join("")
  const slabs = (c.result?.slabLines || []).map((s: any) =>
    `<tr><td style="padding:4px 10px;border-bottom:1px solid #e2e8f0">${esc(s.slabLabel)}</td><td style="padding:4px 10px;border-bottom:1px solid #e2e8f0;text-align:right">${esc(s.rate)}%</td><td style="padding:4px 10px;border-bottom:1px solid #e2e8f0;text-align:right">${esc(fmtMoney(s.amount))}</td><td style="padding:4px 10px;border-bottom:1px solid #e2e8f0;text-align:right">${esc(fmtMoney(s.tax))}</td></tr>`
  ).join("")
  return `
  <html><head><title>TDS Certificate — ${esc(c.employee?.name)}</title>
  <style>body{font-family:ui-sans-serif,system-ui,'Noto Sans Bengali',sans-serif;padding:32px;color:#0f172a}
  h1{font-size:20px;margin:0} h2{font-size:14px;margin:16px 0 6px}
  table{width:100%;border-collapse:collapse;font-size:12px}
  .meta td{padding:3px 10px 3px 0;font-size:12px}
  .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #059669;padding-bottom:12px}
  .disc{margin-top:24px;padding:10px 12px;border:1px solid #f59e0b;background:#fffbeb;font-size:11px;color:#92400e}
  .sign{margin-top:48px;display:flex;justify-content:flex-end}
  .sign div{border-top:1px solid #334155;padding-top:6px;font-size:12px;text-align:center}
  </style></head><body>
  <div class="head">
    <div>
      <h1>${esc(c.company?.name || "")}</h1>
      <p style="font-size:12px;margin:2px 0">${esc(c.company?.address || "")} ${c.company?.phone ? "· " + esc(c.company.phone) : ""}</p>
      <p style="font-size:11px;color:#475569;margin:2px 0">${c.company?.binVatReg ? "BIN/VAT: " + esc(c.company.binVatReg) + " · " : ""}TIN: ${esc(c.employee?.tin || "—")}</p>
    </div>
    <div style="text-align:right">
      <h1 style="color:#059669">TDS Certificate</h1>
      <p style="font-size:12px;margin:2px 0">Salary Tax Slip / মাসিক কর কর্তন সনদ</p>
      <p style="font-size:11px;color:#475569;margin:2px 0">${esc(c.fiscalYear?.label)} · AY ${esc(c.fiscalYear?.assessmentYear)} · Period ${esc(month)}/${esc(year)}</p>
    </div>
  </div>
  <h2>Employee / কর্মী</h2>
  <table class="meta">
    <tr><td><b>${esc(c.employee?.name)}</b> (${esc(c.employee?.code)})</td><td>Designation: ${esc(c.employee?.designation || "—")}</td></tr>
    <tr><td>TIN: ${esc(c.employee?.tin || "—")}</td><td>Mobile: ${esc(c.employee?.mobile || "—")}</td></tr>
  </table>
  <h2>Calculation — ${esc(c.fiscalYear?.tdsSectionRef)}</h2>
  <table>${rows}</table>
  ${slabs ? `<h2>Slab-wise tax — annual Finance Act slabs (§18(2), ITA 2023)</h2><table><tr><th align="left" style="padding:4px 10px">Slab</th><th align="right" style="padding:4px 10px">Rate</th><th align="right" style="padding:4px 10px">Amount</th><th align="right" style="padding:4px 10px">Tax</th></tr>${slabs}</table>` : ""}
  <table class="meta" style="margin-top:14px">
    <tr><td><b>TDS this month:</b> ৳ ${esc(fmtMoney(c.tdsThisMonth).replace("৳ ", ""))}</td><td><b>TDS year-to-date:</b> ৳ ${esc(fmtMoney(c.tdsYtd).replace("৳ ", ""))}</td></tr>
  </table>
  <div class="disc">
    <b>Disclaimer / দাবিত্যাগ:</b> ${esc(DISCLAIMER_BN)}<br/>${esc(DISCLAIMER_EN)}
  </div>
  <div class="sign"><div>${esc(c.company?.signatoryName || "Authorized Signatory")}<br><span style="color:#64748b">${esc(c.company?.signatoryDesignation || "")}</span></div></div>
  </body></html>`
}

function CertificateDialog({ employeeId, month = new Date().getMonth() + 1, year = new Date().getFullYear(), onClose }: {
  employeeId: string; month?: number; year?: number; onClose: () => void
}) {
  const [data, setData] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    ;(async () => {
      try { setData(await rpc("ait.certificate", { employeeId, month, year })) }
      catch (e: any) { setError(e.message) }
    })()
  }, [employeeId, month, year])

  const print = () => {
    const c = data
    openPrintWindow(buildTdsCertificateHtml(c, month, year))
  }

  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base">TDS certificate — Section 86, ITA 2023</DialogTitle>
          <DialogDescription className="text-xs">Opens a print-ready salary tax slip for {monthName(month)} {year}.</DialogDescription>
        </DialogHeader>
        {error ? <ErrorBanner message={error} /> : !data ? <LoadingRows rows={4} /> : (
          <div className="text-xs text-slate-600 dark:text-slate-300 space-y-1">
            <p><b>{data.employee?.name}</b> ({data.employee?.code}) · {data.employee?.designation || "—"}</p>
            <p>FY {data.fiscalYear?.label} · TDS this month <b>{fmtMoney(data.tdsThisMonth)}</b> · YTD <b>{fmtMoney(data.tdsYtd)}</b></p>
          </div>
        )}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>Close</Button>
          <Button onClick={print} disabled={!data}>
            <Printer className="h-4 w-4 mr-1.5" /> Print certificate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function monthName(m: number) {
  return ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][m - 1] || "?"
}

// ================= AUDIT LOG (7F) =================
function AuditTab() {
  // R2 (2026-10-12) — server contract: filter param is `kind` (PREVIEW/SAVE/
  // BATCH/PAYROLL/RECONCILIATION); rows carry employeeCode / summary / operatorName.
  const [kind, setKind] = useState("")
  const { data, loading, error, reload } = useApi<any[]>("ait.logs.list", kind ? { kind } : {})

  const columns: Column<any>[] = [
    { key: "createdAt", label: "When", sortValue: (l) => l.createdAt, render: (l) => (
      <div><p className="text-xs tabular-nums">{new Date(l.createdAt).toLocaleString()}</p></div>
    ) },
    { key: "employeeName", label: "Employee", sortValue: (l) => l.employeeName, render: (l) => (
      <div><p className="text-sm font-medium">{l.employeeName}</p><p className="text-[11px] text-slate-500">{l.employeeCode}</p></div>
    ) },
    { key: "kind", label: "Source", render: (l) => <StatusBadge status={l.kind} /> },
    { key: "run", label: "Run", render: (l) => <span className="text-xs text-slate-500">{l.runId ? "run-linked" : "—"}</span> },
    { key: "annualTax", label: "Annual tax", align: "right", sortValue: (l) => l.summary?.annualTax, render: (l) => <span className="text-xs tabular-nums">{fmtMoney(l.summary?.annualTax)}</span> },
    { key: "monthlyTds", label: "Monthly TDS", align: "right", sortValue: (l) => l.summary?.monthlyTds, render: (l) => <span className="text-xs font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">{fmtMoney(l.summary?.monthlyTds)}</span> },
    { key: "by", label: "Calculated by", render: (l) => <span className="text-xs text-slate-500">{l.operatorName}</span> },
  ]

  return (
    <SectionCard title="Calculation audit journal — হিসাবের অডিট জার্নাল" actions={
      <div className="flex items-center gap-2">
        <Select value={kind || "all"} onValueChange={(v) => setKind(v === "all" ? "" : v)}>
          <SelectTrigger className="h-8 w-40 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sources</SelectItem>
            <SelectItem value="PREVIEW">Calculator preview</SelectItem>
            <SelectItem value="SAVE">Calculator save</SelectItem>
            <SelectItem value="BATCH">Batch</SelectItem>
            <SelectItem value="PAYROLL">Payroll</SelectItem>
            <SelectItem value="RECONCILIATION">Reconciliation</SelectItem>
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" className="h-8 text-xs bg-white dark:bg-slate-900" onClick={reload}>
          <RefreshCcw className="h-3.5 w-3.5 mr-1" /> Refresh
        </Button>
      </div>
    }>
      <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
        Every TDS calculation is journaled with its timestamp, the fiscal-year configuration snapshot used, full inputs and
        outputs and the calculating user (spec 7F). Rows are append-only — payroll-finalized calculations are immutable.
      </p>
      <DataTable columns={columns} rows={data ?? undefined} loading={loading} error={error} pageSize={15} csvName="ait-audit-log"
        searchPlaceholder="Search employee…" emptyTitle="No calculations recorded yet" emptyHint="Run the calculator or a batch to populate the journal." />
    </SectionCard>
  )
}
