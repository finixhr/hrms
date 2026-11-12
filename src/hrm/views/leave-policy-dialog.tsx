"use client"
import { useEffect, useRef, useState } from "react"
import {
  CalendarCheck, CalendarDays, Clock, Redo2, Wallet, Banknote, MoveUpRight,
  Info, RotateCw, FileText, Check, X, Loader2, Users, RefreshCw,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { useHrm } from "../store"
import { rpc } from "../api"
import { FieldError } from "../shared/ui-kit"
import { cn } from "@/lib/utils"

export const COLOR_PRESETS = [
  { id: "emerald", name: "Emerald (Default)", bg: "bg-emerald-600", dot: "bg-emerald-600", previewBadge: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800" },
  { id: "blue", name: "Blue", bg: "bg-blue-600", dot: "bg-blue-600", previewBadge: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300 border-blue-200 dark:border-blue-800" },
  { id: "indigo", name: "Indigo", bg: "bg-indigo-600", dot: "bg-indigo-600", previewBadge: "bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300 border-indigo-200 dark:border-indigo-800" },
  { id: "amber", name: "Amber", bg: "bg-amber-500", dot: "bg-amber-500", previewBadge: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border-amber-200 dark:border-amber-800" },
  { id: "rose", name: "Rose", bg: "bg-rose-500", dot: "bg-rose-500", previewBadge: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300 border-rose-200 dark:border-rose-800" },
]

export function LeavePolicyDialog({
  open,
  onOpenChange,
  editRec,
  onSaved,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  editRec: any | null
  onSaved: () => void
}) {
  const toast = useHrm((s) => s.toast)
  const isEdit = !!editRec

  const [tab, setTab] = useState<"general" | "entitlement" | "carryover" | "encashment">("general")

  // Form state - General
  const [code, setCode] = useState("")
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [color, setColor] = useState("emerald")
  const [active, setActive] = useState(true)
  const [paid, setPaid] = useState(true)
  const [requiresAttachment, setRequiresAttachment] = useState(false)

  // Form state - Entitlement & Accrual
  const [defaultDays, setDefaultDays] = useState<number | "">(10)
  const [accrualFrequency, setAccrualFrequency] = useState("ANNUAL")
  const [waitingPeriodDays, setWaitingPeriodDays] = useState<number | "">(0)
  const [genderRestriction, setGenderRestriction] = useState("all")
  const [probationEligible, setProbationEligible] = useState(false)
  const [minNoticeDays, setMinNoticeDays] = useState<number | "">(2)
  const [maxConsecutiveDays, setMaxConsecutiveDays] = useState<number | "">(0)

  // Form state - Carry-Forward & Rollover
  const [carryForward, setCarryForward] = useState(false)
  const [maxCarryForward, setMaxCarryForward] = useState<number | "">(0)
  const [carryForwardExpiryMonths, setCarryForwardExpiryMonths] = useState<number | "">(3)

  // Form state - Encashment & Exit
  const [encashmentAllowed, setEncashmentAllowed] = useState(false)
  const [encashableOnExit, setEncashableOnExit] = useState(true)
  const [encashmentRate, setEncashmentRate] = useState<number | "">(1.0)
  const [encashmentCap, setEncashmentCap] = useState<number | "">(0)

  const [busy, setBusy] = useState(false)
  const [recomputing, setRecomputing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) {
      setTab("general")
      if (editRec) {
        setCode(editRec.code ?? "")
        setName(editRec.name ?? "")
        setDescription(editRec.description ?? `Standard statutory leave policy for ${editRec.name ?? "this leave type"}.`)
        setColor(editRec.color ?? "emerald")
        setActive(editRec.active ?? true)
        setPaid(editRec.paid ?? true)
        setRequiresAttachment(editRec.requiresAttachment ?? false)
        setDefaultDays(editRec.defaultDays ?? 10)
        setAccrualFrequency(editRec.accrualFrequency ?? "ANNUAL")
        setWaitingPeriodDays(editRec.waitingPeriodDays ?? 0)
        setGenderRestriction(editRec.genderRestriction ?? "all")
        setProbationEligible(editRec.probationEligible ?? false)
        setMinNoticeDays(editRec.minNoticeDays ?? 2)
        setMaxConsecutiveDays(editRec.maxConsecutiveDays ?? 0)
        setCarryForward(editRec.carryForward ?? false)
        setMaxCarryForward(editRec.maxCarryForward ?? 0)
        setCarryForwardExpiryMonths(editRec.carryForwardExpiryMonths ?? 3)
        setEncashmentAllowed(editRec.encashmentAllowed ?? false)
        setEncashableOnExit(editRec.encashableOnExit ?? true)
        setEncashmentRate(editRec.encashmentRate ?? 1.0)
        setEncashmentCap(editRec.encashmentCap ?? 0)
      } else {
        setCode("")
        setName("")
        setDescription("")
        setColor("emerald")
        setActive(true)
        setPaid(true)
        setRequiresAttachment(false)
        setDefaultDays(10)
        setAccrualFrequency("ANNUAL")
        setWaitingPeriodDays(0)
        setGenderRestriction("all")
        setProbationEligible(false)
        setMinNoticeDays(2)
        setMaxConsecutiveDays(0)
        setCarryForward(false)
        setMaxCarryForward(0)
        setCarryForwardExpiryMonths(3)
        setEncashmentAllowed(false)
        setEncashableOnExit(true)
        setEncashmentRate(1.0)
        setEncashmentCap(0)
      }
      setError(null)
    }
    wasOpen.current = open
  }, [open, editRec])

  const handleRecompute = async () => {
    setRecomputing(true)
    try {
      const year = new Date().getFullYear()
      const r = await rpc<{ employees: number; types: number }>("leaveBalances.recompute", { year })
      toast(`Recomputed entitlements for ${r?.employees ?? 0} employee(s) × ${r?.types ?? 0} leave type(s) in ${year}`)
    } catch (e: any) {
      toast(e.message || "Failed to recompute entitlements", "err")
    } finally {
      setRecomputing(false)
    }
  }

  const submit = async () => {
    if (!code.trim()) { setError("Policy Code is required"); return }
    if (!name.trim()) { setError("Leave Type Name is required"); return }
    setBusy(true)
    setError(null)
    try {
      const payload: any = {
        code: code.trim().toUpperCase(),
        name: name.trim(),
        paid,
        defaultDays: defaultDays === "" ? 0 : Number(defaultDays),
        carryForward,
        maxCarryForward: carryForward ? (maxCarryForward === "" ? 0 : Number(maxCarryForward)) : 0,
        carryForwardExpiryMonths: carryForwardExpiryMonths === "" ? 0 : Number(carryForwardExpiryMonths),
        accrualFrequency,
        encashmentAllowed,
        encashmentRate: encashmentRate === "" ? 1 : Number(encashmentRate),
        encashmentCap: encashmentCap === "" ? 0 : Number(encashmentCap),
        waitingPeriodDays: waitingPeriodDays === "" ? 0 : Number(waitingPeriodDays),
        probationEligible,
        requiresAttachment,
        genderRestriction: genderRestriction === "all" ? null : genderRestriction,
        maxConsecutiveDays: maxConsecutiveDays === "" ? 0 : Number(maxConsecutiveDays),
        active,
      }
      if (editRec?.id) {
        payload.id = editRec.id
      }
      await rpc("leaveTypes.save", payload)
      toast(isEdit ? "Leave policy updated successfully" : "Leave policy created successfully")
      onOpenChange(false)
      onSaved()
    } catch (e: any) {
      setError(e.message || "Failed to save leave policy")
    } finally {
      setBusy(false)
    }
  }

  const activeColorObj = COLOR_PRESETS.find((c) => c.id === color) || COLOR_PRESETS[0]

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v) }}>
      <DialogContent showCloseButton={false} className="sm:max-w-4xl p-0 overflow-hidden max-h-[92vh] flex flex-col bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-2xl rounded-2xl gap-0">
        {/* BEGIN: Modal Header */}
        <header className="px-6 sm:px-8 pt-6 pb-5 border-b border-slate-100 dark:border-slate-800 flex items-start justify-between bg-white dark:bg-slate-900 relative">
          <div className="flex items-start space-x-3.5">
            <div className="w-10 h-10 rounded-xl bg-emerald-50 dark:bg-emerald-950/80 border border-emerald-100 dark:border-emerald-800 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0 shadow-xs">
              <CalendarCheck className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center space-x-2.5">
                <h2 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
                  {isEdit ? "Configure Leave Type" : "Add Leave Type"}
                </h2>
                <span className={cn(
                  "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border",
                  active
                    ? "bg-emerald-50 text-emerald-700 border-emerald-200/80 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800"
                    : "bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700"
                )}>
                  <span className={cn("w-1.5 h-1.5 rounded-full mr-1.5", active ? "bg-emerald-500" : "bg-slate-400")}></span>
                  {active ? "Active Policy" : "Inactive"}
                </span>
                <span className="hidden sm:inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
                  {paid ? "Paid Leave" : "Unpaid"}
                </span>
              </div>
              <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 mt-0.5 flex items-center gap-1.5 flex-wrap">
                <span className="font-medium text-slate-700 dark:text-slate-300">{name || "Leave Type"}</span>
                <span className="text-slate-300 dark:text-slate-600">•</span>
                <span className="font-mono text-[11px] bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded text-slate-600 dark:text-slate-300 font-semibold tracking-wide">
                  CODE: {code || "—"}
                </span>
                <span className="text-slate-300 dark:text-slate-600">•</span>
                <span>Statutory baseline allowance</span>
              </p>
            </div>
          </div>
          <button
            aria-label="Close modal"
            onClick={() => onOpenChange(false)}
            className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg p-1.5 transition-colors focus:outline-none"
            type="button"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        {/* BEGIN: Policy Snapshot Ribbon */}
        <div className="bg-slate-50/80 dark:bg-slate-800/50 border-b border-slate-200/80 dark:border-slate-800 px-6 sm:px-8 py-2.5 flex items-center justify-between text-xs text-slate-600 dark:text-slate-300">
          <div className="flex items-center space-x-4 overflow-x-auto py-0.5 scrollbar-none">
            <div className="flex items-center space-x-1.5 shrink-0">
              <CalendarDays className="h-4 w-4 text-emerald-600" />
              <span>Entitlement: <strong className="text-slate-800 dark:text-slate-100 font-semibold">{defaultDays || 0} days / yr</strong></span>
            </div>
            <span className="text-slate-300 dark:text-slate-700 shrink-0">|</span>
            <div className="flex items-center space-x-1.5 shrink-0">
              <MoveUpRight className="h-4 w-4 text-blue-600" />
              <span>Rollover: <strong className="text-slate-800 dark:text-slate-100 font-semibold">{carryForward ? `Max ${maxCarryForward || 0} days` : "Disabled"}</strong></span>
            </div>
            <span className="text-slate-300 dark:text-slate-700 shrink-0">|</span>
            <div className="flex items-center space-x-1.5 shrink-0">
              <Banknote className="h-4 w-4 text-amber-600" />
              <span>Encashment: <strong className="text-slate-800 dark:text-slate-100 font-semibold">{encashmentAllowed ? `Allowed (${encashmentRate || 1}×)` : "Disabled"}</strong></span>
            </div>
            <span className="text-slate-300 dark:text-slate-700 shrink-0">|</span>
            <div className="flex items-center space-x-1.5 shrink-0">
              <Users className="h-4 w-4 text-purple-600" />
              <span>Eligible: <strong className="text-slate-800 dark:text-slate-100 font-semibold">{genderRestriction === "FEMALE" ? "Female Only" : genderRestriction === "MALE" ? "Male Only" : "All Genders"}</strong></span>
            </div>
          </div>
          <button
            type="button"
            onClick={handleRecompute}
            disabled={recomputing}
            className="hidden md:flex items-center space-x-1.5 text-emerald-700 dark:text-emerald-400 bg-emerald-100/60 dark:bg-emerald-950/60 hover:bg-emerald-100 dark:hover:bg-emerald-900 px-2 py-0.5 rounded text-[11px] font-medium border border-emerald-200/60 dark:border-emerald-800 shrink-0 transition"
          >
            {recomputing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCw className="h-3 w-3" />}
            <span>Recompute Balances</span>
          </button>
        </div>

        {/* BEGIN: Navigation Tabs Bar */}
        <nav aria-label="Modal Sections" className="px-6 sm:px-8 border-b border-slate-200 dark:border-slate-800 flex space-x-1 sm:space-x-4 bg-white dark:bg-slate-900">
          <button
            type="button"
            onClick={() => setTab("general")}
            className={cn(
              "flex items-center space-x-2 py-3 px-3 border-b-2 font-medium text-xs sm:text-sm focus:outline-none transition-colors",
              tab === "general"
                ? "border-emerald-600 text-emerald-700 dark:text-emerald-400"
                : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:border-slate-300"
            )}
          >
            <FileText className="h-4 w-4" />
            <span>General & Status</span>
          </button>
          <button
            type="button"
            onClick={() => setTab("entitlement")}
            className={cn(
              "flex items-center space-x-2 py-3 px-3 border-b-2 font-medium text-xs sm:text-sm focus:outline-none transition-colors",
              tab === "entitlement"
                ? "border-emerald-600 text-emerald-700 dark:text-emerald-400"
                : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:border-slate-300"
            )}
          >
            <Clock className="h-4 w-4" />
            <span>Entitlement & Accrual</span>
          </button>
          <button
            type="button"
            onClick={() => setTab("carryover")}
            className={cn(
              "flex items-center space-x-2 py-3 px-3 border-b-2 font-medium text-xs sm:text-sm focus:outline-none transition-colors",
              tab === "carryover"
                ? "border-emerald-600 text-emerald-700 dark:text-emerald-400"
                : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:border-slate-300"
            )}
          >
            <Redo2 className="h-4 w-4" />
            <span>Carry-Forward & Rollover</span>
          </button>
          <button
            type="button"
            onClick={() => setTab("encashment")}
            className={cn(
              "flex items-center space-x-2 py-3 px-3 border-b-2 font-medium text-xs sm:text-sm focus:outline-none transition-colors",
              tab === "encashment"
                ? "border-emerald-600 text-emerald-700 dark:text-emerald-400"
                : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:border-slate-300"
            )}
          >
            <Wallet className="h-4 w-4" />
            <span>Encashment & Exit</span>
          </button>
        </nav>

        {/* BEGIN: Modal Form Body */}
        <div className="overflow-y-auto px-6 py-6 sm:px-8 space-y-6 flex-1 bg-slate-50/30 dark:bg-slate-950/20 max-h-[calc(92vh-280px)]">
          {/* TAB 1: General & Status */}
          {tab === "general" && (
            <div className="space-y-6 animate-in fade-in-50 duration-150">
              {/* Section: Basic Information */}
              <div className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200/90 dark:border-slate-800 shadow-2xs space-y-5">
                <div className="border-b border-slate-100 dark:border-slate-800 pb-3 flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Basic Information</h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400">Public name, code identifier, and color tagging</p>
                  </div>
                  <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded">Core Settings</span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
                  {/* Leave Code */}
                  <div className="md:col-span-4 space-y-1">
                    <Label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                      Policy Code <span className="text-rose-500">*</span>
                    </Label>
                    <Input
                      value={code}
                      onChange={(e) => setCode(e.target.value.toUpperCase())}
                      placeholder="e.g. ANNUAL"
                      className="uppercase font-mono text-sm tracking-wider"
                    />
                    <p className="text-[11px] text-slate-400">Unique internal system identifier</p>
                  </div>

                  {/* Leave Name */}
                  <div className="md:col-span-8 space-y-1">
                    <Label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                      Leave Type Name <span className="text-rose-500">*</span>
                    </Label>
                    <Input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="e.g. Annual Leave"
                      className="text-sm font-medium"
                    />
                    <p className="text-[11px] text-slate-400">Display title shown to employees in self-service portal</p>
                  </div>

                  {/* Description */}
                  <div className="md:col-span-7 space-y-1">
                    <Label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                      Description / Policy Purpose
                    </Label>
                    <Textarea
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      rows={3}
                      placeholder="Standard statutory annual paid leave entitlement for full-time and part-time staff."
                      className="text-sm leading-relaxed"
                    />
                  </div>

                  {/* Color & Badge Preview */}
                  <div className="md:col-span-5 flex flex-col justify-between space-y-1">
                    <Label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                      Badge & Calendar Color
                    </Label>
                    <div className="p-3 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 rounded-lg flex-1 flex flex-col justify-center space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-slate-500">Live Preview:</span>
                        <span className={cn("inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold border", activeColorObj.previewBadge)}>
                          <span className={cn("w-2 h-2 rounded-full mr-1.5", activeColorObj.dot)}></span>
                          {name || "Annual Leave"}
                        </span>
                      </div>
                      <div className="flex items-center space-x-2 pt-1 border-t border-slate-200/60 dark:border-slate-700">
                        <span className="text-xs text-slate-500 mr-1">Palette:</span>
                        {COLOR_PRESETS.map((p) => (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => setColor(p.id)}
                            className={cn(
                              "w-5 h-5 rounded-full transition",
                              p.bg,
                              color === p.id ? "ring-2 ring-offset-2 ring-emerald-600 dark:ring-offset-slate-900" : "hover:ring-2 hover:ring-slate-300"
                            )}
                            title={p.name}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Section: Status & Governance Toggles */}
              <div className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200/90 dark:border-slate-800 shadow-2xs space-y-4">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Policy Status & Rules</h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400">Availability and pay deduction configuration</p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {/* Active Policy */}
                  <div className="flex items-center justify-between p-3.5 bg-slate-50 dark:bg-slate-800/60 hover:bg-slate-100/70 dark:hover:bg-slate-800 transition rounded-xl border border-slate-200 dark:border-slate-800">
                    <div className="pr-3">
                      <Label htmlFor="toggle-active" className="text-sm font-semibold text-slate-800 dark:text-slate-200 cursor-pointer block">
                        Active Policy
                      </Label>
                      <p className="text-xs text-slate-500 mt-0.5">Staff can request and managers can approve this leave</p>
                    </div>
                    <Switch id="toggle-active" checked={active} onCheckedChange={setActive} />
                  </div>

                  {/* Paid Leave */}
                  <div className="flex items-center justify-between p-3.5 bg-slate-50 dark:bg-slate-800/60 hover:bg-slate-100/70 dark:hover:bg-slate-800 transition rounded-xl border border-slate-200 dark:border-slate-800">
                    <div className="pr-3">
                      <Label htmlFor="toggle-paid" className="text-sm font-semibold text-slate-800 dark:text-slate-200 cursor-pointer block">
                        Paid Leave
                      </Label>
                      <p className="text-xs text-slate-500 mt-0.5">Approved bookings do not deduct from employee base salary</p>
                    </div>
                    <Switch id="toggle-paid" checked={paid} onCheckedChange={setPaid} />
                  </div>

                  {/* Attachment Required */}
                  <div className="sm:col-span-2 flex items-center justify-between p-3.5 bg-slate-50 dark:bg-slate-800/60 hover:bg-slate-100/70 dark:hover:bg-slate-800 transition rounded-xl border border-slate-200 dark:border-slate-800">
                    <div className="pr-3">
                      <Label htmlFor="toggle-attachment" className="text-sm font-semibold text-slate-800 dark:text-slate-200 cursor-pointer block">
                        Supporting Document / Certificate Required
                      </Label>
                      <p className="text-xs text-slate-500 mt-0.5">Prompt employees to upload a receipt, note, or flight itinerary upon booking</p>
                    </div>
                    <Switch id="toggle-attachment" checked={requiresAttachment} onCheckedChange={setRequiresAttachment} />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: Entitlement & Accrual */}
          {tab === "entitlement" && (
            <div className="space-y-6 animate-in fade-in-50 duration-150">
              {/* Accrual & Base Entitlement */}
              <div className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200/90 dark:border-slate-800 shadow-2xs space-y-5">
                <div className="border-b border-slate-100 dark:border-slate-800 pb-3 flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Allowance & Accrual Cadence</h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400">Configure balance grant rates and scheduled distribution</p>
                  </div>
                  <span className="text-[11px] font-medium text-emerald-700 bg-emerald-50 dark:bg-emerald-950 dark:text-emerald-300 px-2 py-0.5 rounded border border-emerald-100 dark:border-emerald-800">
                    {accrualFrequency === "ANNUAL" ? "Annual Accrual" : accrualFrequency === "MONTHLY" ? "Monthly Accrual" : accrualFrequency === "QUARTERLY" ? "Quarterly Accrual" : "Pro-Rata Accrual"}
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                  {/* Default Days / Year */}
                  <div className="space-y-1">
                    <Label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                      Default Allowance <span className="text-rose-500">*</span>
                    </Label>
                    <div className="relative rounded-lg shadow-2xs">
                      <Input
                        type="number"
                        min="0"
                        step="0.5"
                        value={defaultDays}
                        onChange={(e) => setDefaultDays(e.target.value === "" ? "" : Number(e.target.value))}
                        className="font-semibold text-slate-900 dark:text-slate-100 pr-24"
                      />
                      <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none text-xs text-slate-500 font-medium">
                        days / year
                      </div>
                    </div>
                    <p className="text-[11px] text-slate-400 mt-1">Full statutory annual allowance</p>
                  </div>

                  {/* Accrual Cadence */}
                  <div className="space-y-1">
                    <Label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                      Accrual Cadence
                    </Label>
                    <Select value={accrualFrequency} onValueChange={setAccrualFrequency}>
                      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ANNUAL">Annual — full entitlement on day one</SelectItem>
                        <SelectItem value="MONTHLY">Monthly accrual (e.g. 1.67 days / mo)</SelectItem>
                        <SelectItem value="QUARTERLY">Quarterly accrual</SelectItem>
                        <SelectItem value="PRO_RATA">Bi-weekly / Pro-rata accrual</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-[11px] text-slate-400 mt-1">When balances are officially credited</p>
                  </div>

                  {/* Waiting Period */}
                  <div className="space-y-1">
                    <Label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                      Waiting Period
                    </Label>
                    <div className="relative rounded-lg shadow-2xs">
                      <Input
                        type="number"
                        min="0"
                        value={waitingPeriodDays}
                        onChange={(e) => setWaitingPeriodDays(e.target.value === "" ? "" : Number(e.target.value))}
                        className="pr-16"
                      />
                      <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none text-xs text-slate-500 font-medium">
                        days
                      </div>
                    </div>
                    <p className="text-[11px] text-slate-400 mt-1">Service duration before leave can be booked</p>
                  </div>
                </div>
              </div>

              {/* Eligibility & Booking Safeguards */}
              <div className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200/90 dark:border-slate-800 shadow-2xs space-y-5">
                <div className="border-b border-slate-100 dark:border-slate-800 pb-3 flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Demographic & Booking Safeguards</h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400">Gender eligibility, probation restrictions, and lead times</p>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  {/* Gender Eligibility */}
                  <div className="space-y-1">
                    <Label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                      Eligible Gender
                    </Label>
                    <Select value={genderRestriction} onValueChange={setGenderRestriction}>
                      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Genders (Default)</SelectItem>
                        <SelectItem value="FEMALE">Female Only (e.g. Maternity / Nursing)</SelectItem>
                        <SelectItem value="MALE">Male Only (e.g. Paternity Leave)</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-[11px] text-slate-400 mt-1">Scope this policy to specific workforce segments</p>
                  </div>

                  {/* Probation Eligibility Toggle Card */}
                  <div className="flex items-center justify-between p-3.5 bg-slate-50 dark:bg-slate-800/60 rounded-xl border border-slate-200 dark:border-slate-800">
                    <div className="pr-3">
                      <Label htmlFor="toggle-probation" className="text-sm font-semibold text-slate-800 dark:text-slate-200 cursor-pointer block">
                        Eligible During Probation
                      </Label>
                      <p className="text-xs text-slate-500 mt-0.5">Allow new hires on probationary terms to submit requests</p>
                    </div>
                    <Switch id="toggle-probation" checked={probationEligible} onCheckedChange={setProbationEligible} />
                  </div>

                  {/* Minimum Advance Notice */}
                  <div className="space-y-1">
                    <Label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                      Minimum Advance Notice
                    </Label>
                    <div className="relative rounded-lg shadow-2xs">
                      <Input
                        type="number"
                        min="0"
                        value={minNoticeDays}
                        onChange={(e) => setMinNoticeDays(e.target.value === "" ? "" : Number(e.target.value))}
                        className="pr-16"
                      />
                      <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none text-xs text-slate-500 font-medium">
                        days
                      </div>
                    </div>
                    <p className="text-[11px] text-slate-400 mt-1">Required advance notice before start date</p>
                  </div>

                  {/* Max Consecutive Days */}
                  <div className="space-y-1">
                    <Label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                      Max Consecutive Days
                    </Label>
                    <div className="relative rounded-lg shadow-2xs">
                      <Input
                        type="number"
                        min="0"
                        value={maxConsecutiveDays}
                        onChange={(e) => setMaxConsecutiveDays(e.target.value === "" ? "" : Number(e.target.value))}
                        className="pr-16"
                      />
                      <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none text-xs text-slate-500 font-medium">
                        days
                      </div>
                    </div>
                    <p className="text-[11px] text-slate-400 mt-1">Cap on single continuous booking duration (0 = unlimited)</p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: Carry-Forward & Rollover */}
          {tab === "carryover" && (
            <div className="space-y-6 animate-in fade-in-50 duration-150">
              <div className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200/90 dark:border-slate-800 shadow-2xs space-y-5">
                {/* Master Toggle */}
                <div className="flex items-center justify-between pb-4 border-b border-slate-200 dark:border-slate-800">
                  <div>
                    <div className="flex items-center space-x-2">
                      <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">Carry Forward Unused Balances</span>
                      <span className={cn(
                        "px-2 py-0.5 rounded text-[11px] font-medium border",
                        carryForward
                          ? "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800"
                          : "bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700"
                      )}>
                        {carryForward ? "Enabled" : "Disabled"}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">Roll remaining unused annual leave days into the next cycle at fiscal year-end</p>
                  </div>
                  <Switch checked={carryForward} onCheckedChange={setCarryForward} />
                </div>

                {/* Carry-forward settings */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5 pt-1">
                  <div className="space-y-1">
                    <Label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                      Maximum Carry-Forward Cap
                    </Label>
                    <div className="relative rounded-lg shadow-2xs">
                      <Input
                        type="number"
                        min="0"
                        disabled={!carryForward}
                        value={maxCarryForward}
                        onChange={(e) => setMaxCarryForward(e.target.value === "" ? "" : Number(e.target.value))}
                        className="font-semibold text-slate-900 dark:text-slate-100 pr-16"
                      />
                      <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none text-xs text-slate-500 font-medium">
                        days
                      </div>
                    </div>
                    <p className="text-[11px] text-slate-400 mt-1">Unused days beyond this limit are automatically forfeited (0 = no limit)</p>
                  </div>

                  <div className="space-y-1">
                    <Label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                      Carried Days Expire After
                    </Label>
                    <div className="relative rounded-lg shadow-2xs">
                      <Input
                        type="number"
                        min="0"
                        disabled={!carryForward}
                        value={carryForwardExpiryMonths}
                        onChange={(e) => setCarryForwardExpiryMonths(e.target.value === "" ? "" : Number(e.target.value))}
                        className="pr-20"
                      />
                      <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none text-xs text-slate-500 font-medium">
                        months
                      </div>
                    </div>
                    <p className="text-[11px] text-slate-400 mt-1"><span className="font-semibold text-slate-600 dark:text-slate-300">0</span> = no grace expiration (valid throughout new year)</p>
                  </div>
                </div>

                {/* Explanatory Callout Box */}
                <div className="p-3.5 bg-amber-50/70 dark:bg-amber-950/30 border border-amber-200/80 dark:border-amber-800/60 rounded-lg flex items-start space-x-3 text-xs text-amber-900 dark:text-amber-200">
                  <Info className="h-4 w-4 text-amber-700 dark:text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-medium text-amber-950 dark:text-amber-100">Year-End Auto Rollover Logic:</span>
                    <p className="text-amber-800/90 dark:text-amber-300/80 mt-0.5 leading-relaxed">
                      {carryForward
                        ? `On cycle close, any balance up to ${maxCarryForward || 0} days will transfer to the employee's carried pool${Number(carryForwardExpiryMonths) > 0 ? ` and must be consumed within ${carryForwardExpiryMonths} months` : ' with no grace expiration'}.`
                        : "Carry-forward is disabled. Unused leave balances at fiscal year-end will be forfeited automatically."}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: Encashment & Exit */}
          {tab === "encashment" && (
            <div className="space-y-6 animate-in fade-in-50 duration-150">
              <div className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200/90 dark:border-slate-800 shadow-2xs space-y-5">
                <div className="border-b border-slate-100 dark:border-slate-800 pb-3 flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Encashment Permissions</h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400">Enable cash redemption during employment and upon termination</p>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {/* Active Encashment */}
                  <div className="flex items-center justify-between p-3.5 bg-slate-50 dark:bg-slate-800/60 hover:bg-slate-100/70 dark:hover:bg-slate-800 transition rounded-xl border border-slate-200 dark:border-slate-800">
                    <div className="pr-3">
                      <Label htmlFor="toggle-encashment" className="text-sm font-semibold text-slate-800 dark:text-slate-200 cursor-pointer block">
                        Allow Active Encashment
                      </Label>
                      <p className="text-xs text-slate-500 mt-0.5">Staff can request cash payouts while actively employed</p>
                    </div>
                    <Switch id="toggle-encashment" checked={encashmentAllowed} onCheckedChange={setEncashmentAllowed} />
                  </div>

                  {/* Exit Encashment */}
                  <div className="flex items-center justify-between p-3.5 bg-slate-50 dark:bg-slate-800/60 hover:bg-slate-100/70 dark:hover:bg-slate-800 transition rounded-xl border border-slate-200 dark:border-slate-800">
                    <div className="pr-3">
                      <Label htmlFor="toggle-exit" className="text-sm font-semibold text-slate-800 dark:text-slate-200 cursor-pointer block">
                        Encashable on Exit
                      </Label>
                      <p className="text-xs text-slate-500 mt-0.5">Pay out accrued balances in the final settlement</p>
                    </div>
                    <Switch id="toggle-exit" checked={encashableOnExit} onCheckedChange={setEncashableOnExit} />
                  </div>
                </div>

                {/* Encashment Rates & Limits */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5 pt-2 border-t border-slate-100 dark:border-slate-800">
                  <div className="space-y-1">
                    <Label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                      Encashment Rate Multiplier
                    </Label>
                    <div className="relative rounded-lg shadow-2xs">
                      <Input
                        type="number"
                        min="0"
                        step="0.1"
                        value={encashmentRate}
                        onChange={(e) => setEncashmentRate(e.target.value === "" ? "" : Number(e.target.value))}
                        className="font-semibold text-slate-900 dark:text-slate-100 pr-24"
                      />
                      <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none text-xs text-slate-500 font-medium">
                        × daily pay
                      </div>
                    </div>
                    <p className="text-[11px] text-slate-400 mt-1"><strong className="text-slate-600 dark:text-slate-300">1.0</strong> = exactly 1 day base pay per unused leave day</p>
                  </div>

                  <div className="space-y-1">
                    <Label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                      Encashment Cap (Days)
                    </Label>
                    <div className="relative rounded-lg shadow-2xs">
                      <Input
                        type="number"
                        min="0"
                        value={encashmentCap}
                        onChange={(e) => setEncashmentCap(e.target.value === "" ? "" : Number(e.target.value))}
                        className="pr-16"
                      />
                      <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none text-xs text-slate-500 font-medium">
                        days
                      </div>
                    </div>
                    <p className="text-[11px] text-slate-400 mt-1"><strong className="text-slate-600 dark:text-slate-300">0</strong> = uncapped payout pool for exit settlements</p>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Error message if any */}
        <div className="px-6 sm:px-8">
          <FieldError message={error} />
        </div>

        {/* BEGIN: Recompute Balances Notice Banner */}
        <div className="px-6 sm:px-8 py-2.5 bg-emerald-50/60 dark:bg-emerald-950/40 border-t border-emerald-100 dark:border-emerald-900/60 flex items-center justify-between text-xs text-emerald-900 dark:text-emerald-200">
          <div className="flex items-center space-x-2">
            <RefreshCw className="h-4 w-4 text-emerald-600 shrink-0" />
            <span className="truncate">Modified rules will apply to upcoming periods. For immediate adjustments, run <strong>Balances → Recompute</strong>.</span>
          </div>
          <button
            type="button"
            onClick={handleRecompute}
            disabled={recomputing}
            className="text-emerald-700 dark:text-emerald-400 font-semibold hover:text-emerald-950 dark:hover:text-emerald-200 underline underline-offset-2 ml-4 shrink-0 transition"
          >
            {recomputing ? "Recomputing…" : "Run Recompute"}
          </button>
        </div>

        {/* BEGIN: Modal Footer */}
        <footer className="px-6 sm:px-8 py-4 bg-white dark:bg-slate-900 border-t border-slate-200/90 dark:border-slate-800 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center space-x-2 text-xs text-slate-500 dark:text-slate-400 w-full sm:w-auto">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
            <span>Last modified: <strong>{isEdit ? "Configured Policy" : "New Policy"}</strong> by HR Administrator</span>
          </div>
          <div className="flex items-center space-x-3 w-full sm:w-auto justify-end">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={busy}
              type="button"
              className="w-full sm:w-auto px-4 py-2"
            >
              Cancel
            </Button>
            <Button
              onClick={submit}
              disabled={busy}
              type="button"
              className="w-full sm:w-auto px-5 py-2 bg-emerald-700 hover:bg-emerald-800 text-white font-semibold flex items-center justify-center space-x-1.5 shadow-xs"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              <span>Save Leave Policy</span>
            </Button>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  )
}
