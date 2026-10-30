"use client"
// ============ Finix HR — Add Employee Dialog ============
// Comprehensive UX/UI restructuring and enterprise validation suite.
// Features:
// 1. Dual-mode navigation: Desktop sidebar with section error badges & mobile tab bar
// 2. View modes: Focused single-section tabbed mode OR continuous all-sections scroll
// 3. 8 logical field groups strictly preserving all existing database attributes
// 4. Client-side real-time & on-submit validation with instant field error pointers
// 5. Unsaved changes guard modal protecting against accidental data loss
// 6. Interactive helpers: Photo crop & preview, live Age badge, Bangladesh NID/e-TIN
//    format checks, address auto-mirroring switch, 7-day weekly off chips with presets,
//    dynamic Gross Salary calculator, and one-time password reveal modal.

import { useState, useEffect, useRef, useMemo, useCallback } from "react"
import {
  UserRound, Users, ShieldCheck, MapPin, Briefcase, CalendarRange,
  CalendarClock, Banknote, AlertCircle, AlertTriangle,
  X, ChevronRight, ChevronLeft, Phone, Mail,
  Calendar, CreditCard, Check, Upload,
  UserPlus, History,
} from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"
import { CapacityWarning } from "../shared/usage-panel"
import { processEmployeePhoto } from "../shared/photo"
import { useHrm } from "../store"
import { rpc, useEmployeeDirectory } from "../api"
import { titleCase, fmtMoney, todayDhaka } from "../shared/ui-kit"
import { validateNid, validateTin } from "../validators-bd"
import { cn } from "@/lib/utils"

// Sentinel for empty Radix select options
const NONE = "__none__"

export const WEEKLY_OFF_DAYS = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"] as const
export const EMPLOYMENT_TYPES = ["PERMANENT", "PROBATIONARY", "CONTRACTUAL", "TEMPORARY", "PART_TIME", "INTERN", "COMMISSION", "FREELANCE"] as const
export const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "O+", "O-", "AB+", "AB-"] as const
export const GENDER_OPTIONS = ["MALE", "FEMALE", "OTHER"] as const
export const MARITAL_STATUS_OPTIONS = ["SINGLE", "MARRIED", "WIDOWED", "DIVORCED"] as const
export const RELIGION_OPTIONS = ["ISLAM", "HINDUISM", "BUDDHISM", "CHRISTIANITY", "OTHER"] as const
export const BD_BANKS = [
  "AB Bank", "BRAC Bank", "City Bank", "Dutch-Bangla Bank", "Eastern Bank",
  "Islami Bank Bangladesh", "Janata Bank", "Meghna Bank", "Mercantile Bank",
  "Midland Bank", "Mutual Trust Bank", "National Bank", "NCC Bank", "One Bank",
  "Premier Bank", "Prime Bank", "Pubali Bank", "Rupali Bank", "Shahjalal Islami Bank",
  "Sonali Bank", "South Bangla Agriculture Bank", "Southeast Bank", "Standard Bank",
  "Trust Bank", "United Commercial Bank", "Uttara Bank", "Bank Asia", "Other",
] as const
export const MFS_PROVIDERS = [
  { value: "BKASH", label: "bKash" },
  { value: "NAGAD", label: "Nagad" },
  { value: "ROCKET", label: "Rocket" },
  { value: "OTHER", label: "Other MFS" },
] as const

export type CreateSectionKey =
  | "basic"
  | "personal"
  | "identity"
  | "address"
  | "organization"
  | "lifecycle"
  | "attendance"
  | "compensation"

export interface CreateSectionMeta {
  id: CreateSectionKey
  number: number
  label: string
  title: string
  subtitle: string
  icon: any
}

export const CREATE_FORM_SECTIONS: CreateSectionMeta[] = [
  {
    id: "basic",
    number: 1,
    label: "Basic Info",
    title: "Basic Information",
    subtitle: "Full name, aliases & candidate photograph",
    icon: UserRound,
  },
  {
    id: "personal",
    number: 2,
    label: "Personal & Family",
    title: "Personal & Family Information",
    subtitle: "Parents, spouse, date of birth, blood group & gender",
    icon: Users,
  },
  {
    id: "identity",
    number: 3,
    label: "Identity & Contacts",
    title: "Identity & Contact Information",
    subtitle: "NID/Passport, phone numbers, emails & emergency contacts",
    icon: ShieldCheck,
  },
  {
    id: "address",
    number: 4,
    label: "Address Details",
    title: "Address Information",
    subtitle: "Permanent & present residences with live auto-mirroring",
    icon: MapPin,
  },
  {
    id: "organization",
    number: 5,
    label: "Organization & Job",
    title: "Organizational & Job Information",
    subtitle: "Branch, department, designation, category & hierarchy",
    icon: Briefcase,
  },
  {
    id: "lifecycle",
    number: 6,
    label: "Lifecycle & Probation",
    title: "Employment & Probation Details",
    subtitle: "Joining, confirmation, probation period & contract dates",
    icon: CalendarRange,
  },
  {
    id: "attendance",
    number: 7,
    label: "Schedule & Off Days",
    title: "Work Schedule & Attendance",
    subtitle: "Work shift, weekly off override chips & overtime eligibility",
    icon: CalendarClock,
  },
  {
    id: "compensation",
    number: 8,
    label: "Compensation & Tax",
    title: "Compensation, Tax & Salary Structure",
    subtitle: "Tax e-TIN, salary allowances & payout credentials",
    icon: Banknote,
  },
]

// ---------------- Validation Logic ----------------
export interface CreateValidationResult {
  isValid: boolean
  errors: Record<string, string>
  sectionErrors: Record<CreateSectionKey, number>
  firstInvalidSection?: CreateSectionKey
  firstInvalidField?: string
}

export function validateEmployeeCreateForm(values: Record<string, any>): CreateValidationResult {
  const errors: Record<string, string> = {}
  const sectionErrors: Record<CreateSectionKey, number> = {
    basic: 0,
    personal: 0,
    identity: 0,
    address: 0,
    organization: 0,
    lifecycle: 0,
    attendance: 0,
    compensation: 0,
  }

  const markError = (section: CreateSectionKey, field: string, msg: string) => {
    errors[field] = msg
    sectionErrors[section] = (sectionErrors[section] || 0) + 1
  }

  // 1. Basic Info
  const fullName = String(values.fullName || "").trim()
  if (!fullName) {
    markError("basic", "fullName", "Full Name is required")
  } else if (fullName.length < 2) {
    markError("basic", "fullName", "Full Name must be at least 2 characters")
  }

  // 2. Personal & Family Info
  if (!values.dob) {
    markError("personal", "dob", "Date of Birth is required")
  } else {
    const dobDate = new Date(values.dob + "T00:00:00")
    if (isNaN(dobDate.getTime())) {
      markError("personal", "dob", "Invalid date format for Date of Birth")
    } else {
      const now = new Date()
      if (dobDate > now) {
        markError("personal", "dob", "Date of birth cannot be in the future")
      } else {
        const ageYears = (now.getTime() - dobDate.getTime()) / (365.25 * 24 * 3600 * 1000)
        if (ageYears < 14) {
          markError("personal", "dob", "Employee must be at least 14 years old under Bangladesh labor laws")
        } else if (ageYears > 100) {
          markError("personal", "dob", "Date of birth indicates an implausible age (> 100 years)")
        }
      }
    }
  }

  if (!values.gender) {
    markError("personal", "gender", "Gender selection is required")
  }
  if (!values.maritalStatus) {
    markError("personal", "maritalStatus", "Marital status selection is required")
  }

  // 3. Identity & Contacts
  if (values.personalEmail && String(values.personalEmail).trim()) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(String(values.personalEmail).trim())) {
      markError("identity", "personalEmail", "Invalid personal email address format")
    }
  }
  if (values.officialEmail && String(values.officialEmail).trim()) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(String(values.officialEmail).trim())) {
      markError("identity", "officialEmail", "Invalid official email address format")
    }
  }
  if (values.mobile && String(values.mobile).trim()) {
    const cleaned = String(values.mobile).replace(/[\s-]/g, "")
    if (!/^\+?\d{8,15}$/.test(cleaned)) {
      markError("identity", "mobile", "Personal mobile must contain 8 to 15 digits")
    }
  }
  if (values.altMobile && String(values.altMobile).trim()) {
    const cleaned = String(values.altMobile).replace(/[\s-]/g, "")
    if (!/^\+?\d{8,15}$/.test(cleaned)) {
      markError("identity", "altMobile", "Alternate mobile must contain 8 to 15 digits")
    }
  }
  if (values.emergencyMobile && String(values.emergencyMobile).trim()) {
    const cleaned = String(values.emergencyMobile).replace(/[\s-]/g, "")
    if (!/^\+?\d{8,15}$/.test(cleaned)) {
      markError("identity", "emergencyMobile", "Emergency mobile must contain 8 to 15 digits")
    }
  }

  // Identity document validation
  const idNumber = String(values.identityNumber || "").trim()
  const idType = values.identityType || "NID"
  if (idNumber) {
    if (idType === "NID") {
      const nidCheck = validateNid(idNumber)
      if (!nidCheck.ok) {
        markError("identity", "identityNumber", nidCheck.message)
      }
    } else if (idType === "BIRTH_REG") {
      const cleanBirth = idNumber.replace(/[\s-]/g, "")
      if (!/^\d{17}$/.test(cleanBirth)) {
        markError("identity", "identityNumber", "Birth Registration Number must be exactly 17 digits")
      }
    } else if (idType === "PASSPORT") {
      if (idNumber.length < 6 || idNumber.length > 15) {
        markError("identity", "identityNumber", "Passport number must be between 6 and 15 alphanumeric characters")
      }
    }
  }

  // 4. Address Information: postCode check if provided
  if (values.postCode && String(values.postCode).trim()) {
    if (!/^\d{4,6}$/.test(String(values.postCode).trim())) {
      markError("address", "postCode", "Post code should be 4 to 6 digits")
    }
  }
  if (values.presentPostCode && String(values.presentPostCode).trim()) {
    if (!/^\d{4,6}$/.test(String(values.presentPostCode).trim())) {
      markError("address", "presentPostCode", "Post code should be 4 to 6 digits")
    }
  }

  // 5. Organization & Job: Required hierarchy keys
  if (!values.branchId) {
    markError("organization", "branchId", "Branch is required")
  }
  if (!values.departmentId) {
    markError("organization", "departmentId", "Department is required")
  }
  if (!values.designationId) {
    markError("organization", "designationId", "Designation is required")
  }

  // 6. Lifecycle & Probation
  if (!values.joiningDate) {
    markError("lifecycle", "joiningDate", "Joining Date is required")
  } else {
    const joinDate = new Date(values.joiningDate + "T00:00:00")
    if (isNaN(joinDate.getTime())) {
      markError("lifecycle", "joiningDate", "Invalid Joining Date format")
    } else if (values.confirmationDate) {
      const confDate = new Date(values.confirmationDate + "T00:00:00")
      if (isNaN(confDate.getTime())) {
        markError("lifecycle", "confirmationDate", "Invalid Confirmation Date format")
      } else if (confDate < joinDate) {
        markError("lifecycle", "confirmationDate", "Confirmation date cannot precede joining date")
      }
    }
  }

  if (values.probationMonths != null && values.probationMonths !== "") {
    const num = Number(values.probationMonths)
    if (isNaN(num) || num < 0) {
      markError("lifecycle", "probationMonths", "Probation period must be 0 or more months")
    }
  }

  if (values.contractStart && values.contractEnd) {
    const cStart = new Date(values.contractStart + "T00:00:00")
    const cEnd = new Date(values.contractEnd + "T00:00:00")
    if (!isNaN(cStart.getTime()) && !isNaN(cEnd.getTime()) && cEnd < cStart) {
      markError("lifecycle", "contractEnd", "Contract end date cannot precede contract start date")
    }
  }

  // 8. Compensation & Tax
  if (values.taxTin && String(values.taxTin).trim()) {
    const tinCheck = validateTin(values.taxTin)
    if (!tinCheck.ok) {
      markError("compensation", "taxTin", tinCheck.message)
    }
  }

  // Basic salary & allowances must be non-negative
  const salaryKeys = ["basic", "houseRent", "medical", "conveyance", "food", "mobileAllow", "internetAllow", "attendanceAllow", "otherAllowance"]
  for (const k of salaryKeys) {
    if (values[k] != null && values[k] !== "") {
      const num = Number(values[k])
      if (isNaN(num) || num < 0) {
        markError("compensation", k, "Amount must be a non-negative number")
      }
    }
  }

  // Payout validation
  if (values.payoutMethod === "BANK") {
    if (!values.payoutAccountNumber || !String(values.payoutAccountNumber).trim()) {
      markError("compensation", "payoutAccountNumber", "Account number is required when payout method is Bank")
    } else if (String(values.payoutAccountNumber).trim().length < 6) {
      markError("compensation", "payoutAccountNumber", "Bank account number must be at least 6 characters")
    }
    if (values.payoutRoutingNumber && String(values.payoutRoutingNumber).trim()) {
      const cleanRouting = String(values.payoutRoutingNumber).replace(/[\s-]/g, "")
      if (!/^\d{9}$/.test(cleanRouting)) {
        markError("compensation", "payoutRoutingNumber", "Bangladesh bank routing number must be 9 digits")
      }
    }
  } else if (values.payoutMethod === "MFS") {
    if (!values.payoutMfsNumber || !String(values.payoutMfsNumber).trim()) {
      markError("compensation", "payoutMfsNumber", "MFS mobile number is required when payout method is MFS")
    } else {
      const cleanMfs = String(values.payoutMfsNumber).replace(/[\s-]/g, "")
      if (!/^\+?\d{11,14}$/.test(cleanMfs)) {
        markError("compensation", "payoutMfsNumber", "MFS mobile number must be 11 to 14 digits")
      }
    }
  }

  const errorKeys = Object.keys(errors)
  const isValid = errorKeys.length === 0

  let firstInvalidSection: CreateSectionKey | undefined
  let firstInvalidField: string | undefined
  if (!isValid) {
    firstInvalidField = errorKeys[0]
    for (const sec of CREATE_FORM_SECTIONS) {
      if (sectionErrors[sec.id] > 0) {
        firstInvalidSection = sec.id
        break
      }
    }
  }

  return {
    isValid,
    errors,
    sectionErrors,
    firstInvalidSection,
    firstInvalidField,
  }
}

// ---------------- Component Props ----------------
export interface CreateEmployeeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  lookups: {
    branches?: { id: string; name: string }[]
    departments?: { id: string; name: string }[]
    designations?: { id: string; name: string }[]
    shifts?: { id: string; name: string }[]
    employees?: { id: string; fullName: string; code: string }[]
  }
  onCreated: (id: string) => void
}

export function CreateEmployeeDialog({ open, onOpenChange, lookups, onCreated }: CreateEmployeeDialogProps) {
  const { toast } = useHrm()
  const probationDefault = useHrm((s) => s.settings?.employeeSettings?.defaultProbationMonths) ?? 3
  const prefillParams = useHrm((s) => (s.view.params as any)?.prefill) as
    | { fullName?: string; personalEmail?: string; mobile?: string; departmentId?: string }
    | null
    | undefined

  const [activeSection, setActiveSection] = useState<CreateSectionKey>("basic")
  const [viewMode, setViewMode] = useState<"tabs" | "all">("tabs")
  const [busy, setBusy] = useState(false)
  const [photoBusy, setPhotoBusy] = useState(false)
  const [attemptedSubmit, setAttemptedSubmit] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // One-time reveal when credentials could not be delivered through any channel
  const [createdAccount, setCreatedAccount] = useState<{
    email: string
    tempPassword: string
    emailStatus: string
    smsStatus: string
    employeeId: string
    note: string
  } | null>(null)

  // EMP-12 (R6) — pickers read the CACHED shared directory (one
  // employees.refList per session, module-level 5-min cache); the server no
  // longer ships the tenant directory with every profile open.
  const { data: directory } = useEmployeeDirectory()
  const activeEmployees: { id: string; fullName: string; code: string }[] = useMemo(
    () => (directory || []).map((m: any) => ({ id: m.id, fullName: m.fullName, code: m.code })),
    [directory],
  )

  // Build fresh initial values
  // T-11 — optional-chained deps (`lookups?.branches`) defeat the compiler's
  // memoization preservation; the value is lifted to a plain local first.
  const lookupBranches = lookups?.branches
  const buildInitialValues = useCallback(() => {
    return {
      photoUrl: "",
      photoThumb: "",
      fullName: prefillParams?.fullName ? String(prefillParams.fullName).slice(0, 120) : "",
      nameBn: "",
      preferredName: "",
      fatherName: "",
      motherName: "",
      spouseName: "",
      dob: "",
      placeOfBirth: "",
      gender: "MALE",
      bloodGroup: "",
      maritalStatus: "SINGLE",
      religion: "ISLAM",
      nationality: "Bangladeshi",
      identityType: "NID",
      identityNumber: "",
      mobile: prefillParams?.mobile ? String(prefillParams.mobile).slice(0, 24) : "",
      altMobile: "",
      personalEmail: prefillParams?.personalEmail ? String(prefillParams.personalEmail).slice(0, 160) : "",
      officialEmail: "",
      emergencyName: "",
      emergencyMobile: "",
      emergencyRelation: "",
      addressSame: false,
      permanentAddress: "",
      division: "",
      district: "",
      city: "",
      postCode: "",
      presentAddress: "",
      presentDivision: "",
      presentDistrict: "",
      presentCity: "",
      presentPostCode: "",
      branchId: (lookups?.branches && lookups.branches.length === 1) ? lookups.branches[0].id : "",
      departmentId: prefillParams?.departmentId ? String(prefillParams.departmentId).slice(0, 40) : "",
      designationId: "",
      shiftId: "",
      reportingManagerId: "",
      hrManagerId: "",
      supervisorId: "",
      workLocation: "",
      joiningDate: todayDhaka(),
      confirmationDate: "",
      probationMonths: probationDefault,
      employmentType: "PERMANENT",
      category: "",
      grade: "",
      weeklyOff: [] as string[],
      contractStart: "",
      contractEnd: "",
      otEligible: true,
      taxTin: "",
      basic: "",
      houseRent: "",
      medical: "",
      conveyance: "",
      food: "",
      mobileAllow: "",
      internetAllow: "",
      attendanceAllow: "",
      otherAllowance: "",
      payoutMethod: "CASH",
      payoutBank: "",
      payoutBranch: "",
      payoutAccountName: "",
      payoutAccountNumber: "",
      payoutRoutingNumber: "",
      payoutMfsProvider: "BKASH",
      payoutMfsNumber: "",
    }
  }, [prefillParams, probationDefault, lookupBranches])

  const [formValues, setFormValues] = useState<Record<string, any>>(buildInitialValues)
  // T-11 — the initial-values snapshot is STATE (read during render by the
  // isDirty memo), not a ref: ref reads during render are exactly what the
  // react-hooks/refs rule forbids. Writers are the open-effect below and the
  // submit handler — both legal mutation points.
  const [initialSnapshot, setInitialSnapshot] = useState(() => JSON.stringify(buildInitialValues()))

  useEffect(() => {
    if (open) {
      const fresh = buildInitialValues()
      setFormValues(fresh)
      setInitialSnapshot(JSON.stringify(fresh))
      setAttemptedSubmit(false)
      setServerError(null)
      setActiveSection("basic")
    }
  }, [open, buildInitialValues])

  // Track dirty status
  const isDirty = useMemo(() => {
    return JSON.stringify(formValues) !== initialSnapshot
  }, [formValues, initialSnapshot])

  // Validation output computed in real time
  const validation = useMemo(() => {
    return validateEmployeeCreateForm(formValues)
  }, [formValues])

  // Field change helper
  const setFieldValue = (field: string, value: any) => {
    setFormValues((prev) => {
      const next = { ...prev, [field]: value }
      if (field === "addressSame") {
        if (value) {
          next.presentAddress = next.permanentAddress
          next.presentDivision = next.division
          next.presentDistrict = next.district
          next.presentCity = next.city
          next.presentPostCode = next.postCode
        }
      } else if (prev.addressSame) {
        if (field === "permanentAddress") next.presentAddress = value
        else if (field === "division") next.presentDivision = value
        else if (field === "district") next.presentDistrict = value
        else if (field === "city") next.presentCity = value
        else if (field === "postCode") next.presentPostCode = value
      }
      return next
    })
  }

  // Toggle day in weekly off
  const toggleWeeklyOffDay = (day: string) => {
    setFormValues((prev) => {
      const current = Array.isArray(prev.weeklyOff) ? [...prev.weeklyOff] : []
      const index = current.indexOf(day)
      if (index >= 0) {
        current.splice(index, 1)
      } else {
        current.push(day)
      }
      return { ...prev, weeklyOff: current }
    })
  }

  // Preset weekly off shortcuts
  const applyWeeklyOffPreset = (preset: "standard" | "friday" | "clear") => {
    let days: string[] = []
    if (preset === "standard") days = ["FRIDAY", "SATURDAY"]
    else if (preset === "friday") days = ["FRIDAY"]
    else days = []
    setFieldValue("weeklyOff", days)
  }

  // Photo upload handler
  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setPhotoBusy(true)
    try {
      const { photoUrl, photoThumb } = await processEmployeePhoto(file)
      setFormValues((prev) => ({ ...prev, photoUrl, photoThumb }))
      toast("Photograph processed", "ok")
    } catch (err: any) {
      toast(err.message || "Failed to process photo", "err")
    } finally {
      setPhotoBusy(false)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  const removePhoto = () => {
    setFormValues((prev) => ({ ...prev, photoUrl: "", photoThumb: "" }))
  }

  // Live total gross calculator
  const computedGross = useMemo(() => {
    const keys = ["basic", "houseRent", "medical", "conveyance", "food", "mobileAllow", "internetAllow", "attendanceAllow", "otherAllowance"]
    let sum = 0
    for (const k of keys) {
      const val = Number(formValues[k] || 0)
      if (!isNaN(val) && val > 0) sum += val
    }
    return sum
  }, [formValues])

  // Age calculation helper for DOB
  const dobAge = useMemo(() => {
    if (!formValues.dob) return null
    const d = new Date(formValues.dob + "T00:00:00")
    if (isNaN(d.getTime())) return null
    const now = new Date()
    const diff = (now.getTime() - d.getTime()) / (365.25 * 24 * 3600 * 1000)
    if (diff < 0) return null
    return Math.floor(diff)
  }, [formValues.dob])

  // Live NID validation summary
  const nidFeedback = useMemo(() => {
    if (!formValues.identityNumber || formValues.identityType !== "NID") return null
    return validateNid(formValues.identityNumber)
  }, [formValues.identityNumber, formValues.identityType])

  // EXT-05 (R7) — rehire detection: as the operator types the identity facts,
  // former employees of this organization with matching NID / mobile / email
  // surface as linkage candidates. Linking keeps the prior service record
  // reachable instead of creating an orphaned duplicate identity.
  const [rehireMatches, setRehireMatches] = useState<any[]>([])
  const [priorEmployeeId, setPriorEmployeeId] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const probe = async () => {
      const nid = String(formValues.identityNumber || "").replace(/\D/g, "")
      const mobile = String(formValues.mobile || "").trim()
      const email = String(formValues.officialEmail || formValues.personalEmail || "").trim()
      if (!nid && !mobile && !email) { if (!cancelled) { setRehireMatches([]); setPriorEmployeeId(null) }; return }
      try {
        const res = await rpc<any>("employees.rehireMatches", { nid: nid || undefined, mobile: mobile || undefined, officialEmail: email || undefined })
        if (!cancelled) {
          setRehireMatches(res?.matches || [])
          if (priorEmployeeId && !(res?.matches || []).some((m: any) => m.id === priorEmployeeId)) setPriorEmployeeId(null)
        }
      } catch { /* non-fatal probe */ }
    }
    const t = setTimeout(probe, 600)
    return () => { cancelled = true; clearTimeout(t) }
  }, [formValues.identityNumber, formValues.mobile, formValues.officialEmail, formValues.personalEmail])

  // Live e-TIN validation summary
  const tinFeedback = useMemo(() => {
    if (!formValues.taxTin) return null
    return validateTin(formValues.taxTin)
  }, [formValues.taxTin])

  // Intercept dialog close if dirty
  const handleOpenChange = (v: boolean) => {
    if (!v && isDirty && !busy) {
      setConfirmDiscardOpen(true)
    } else if (!v) {
      onOpenChange(false)
    }
  }

  // Submit Handler
  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    setAttemptedSubmit(true)
    setServerError(null)

    const result = validateEmployeeCreateForm(formValues)
    if (!result.isValid) {
      if (result.firstInvalidSection) {
        setActiveSection(result.firstInvalidSection)
        if (viewMode === "all") {
          const el = document.getElementById(`create-section-${result.firstInvalidSection}`)
          el?.scrollIntoView({ behavior: "smooth", block: "start" })
        }
      }
      toast("Please resolve highlighted validation errors before creating employee", "err")
      return
    }

    setBusy(true)
    try {
      const {
        basic, houseRent, medical, conveyance, food, mobileAllow,
        internetAllow, attendanceAllow, otherAllowance, ...profile
      } = formValues

      const payload: Record<string, any> = { ...profile }

      // Mirror address if enabled
      if (payload.addressSame && payload.permanentAddress) {
        payload.presentAddress = payload.permanentAddress
      }

      // Convert weeklyOff array to comma string or null
      if (Array.isArray(payload.weeklyOff)) {
        payload.weeklyOff = payload.weeklyOff.length ? payload.weeklyOff.join(",") : null
      }

      // Number parsing
      if (payload.probationMonths !== "" && payload.probationMonths != null) {
        payload.probationMonths = Number(payload.probationMonths)
      }

      // Clean photo fields if empty
      if (!payload.photoUrl) delete payload.photoUrl
      if (!payload.photoThumb) delete payload.photoThumb

      // Identity document bridge
      payload.nid = payload.identityNumber

      // EXT-05 (R7) — rehire linkage selected from the detection banner
      if (priorEmployeeId) payload.priorEmployeeId = priorEmployeeId
      else delete payload.priorEmployeeId

      // Normalize empty strings for optional fields so they coerce to null cleanly
      const blankToNullKeys = [
        "nameBn", "preferredName", "fatherName", "motherName", "spouseName",
        "dob", "placeOfBirth", "bloodGroup", "nationality", "religion",
        "mobile", "altMobile", "personalEmail", "officialEmail",
        "emergencyName", "emergencyRelation", "emergencyMobile",
        "presentAddress", "permanentAddress", "division", "district", "city", "postCode",
        "presentDivision", "presentDistrict", "presentCity", "presentPostCode",
        "branchId", "departmentId", "designationId", "shiftId", "reportingManagerId", "supervisorId", "hrManagerId",
        "joiningDate", "confirmationDate", "contractStart", "contractEnd",
        "gender", "maritalStatus", "employmentType", "category", "grade",
        "taxTin", "identityType", "identityNumber", "nid",
      ]
      for (const k of blankToNullKeys) {
        if (payload[k] === "" || payload[k] === NONE) {
          payload[k] = null
        }
      }

      if (payload.addressSame) {
        payload.presentAddress = payload.permanentAddress
        payload.presentDivision = payload.division
        payload.presentDistrict = payload.district
        payload.presentCity = payload.city
        payload.presentPostCode = payload.postCode
      }

      // Payout options normalization
      if (!payload.payoutMethod || payload.payoutMethod === "NONE") {
        delete payload.payoutMethod
        delete payload.payoutBank
        delete payload.payoutBranch
        delete payload.payoutAccountName
        delete payload.payoutAccountNumber
        delete payload.payoutRoutingNumber
        delete payload.payoutMfsProvider
        delete payload.payoutMfsNumber
      } else if (payload.payoutMethod === "CASH") {
        delete payload.payoutBank
        delete payload.payoutBranch
        delete payload.payoutAccountName
        delete payload.payoutAccountNumber
        delete payload.payoutRoutingNumber
        delete payload.payoutMfsProvider
        delete payload.payoutMfsNumber
      } else if (payload.payoutMethod === "BANK") {
        delete payload.payoutMfsProvider
        delete payload.payoutMfsNumber
        if (payload.payoutBank === NONE || payload.payoutBank === "") payload.payoutBank = null
      } else if (payload.payoutMethod === "MFS") {
        delete payload.payoutBank
        delete payload.payoutBranch
        delete payload.payoutAccountName
        delete payload.payoutAccountNumber
        delete payload.payoutRoutingNumber
        if (payload.payoutMfsProvider === "" || payload.payoutMfsProvider === NONE) payload.payoutMfsProvider = null
      }

      const emp = await rpc<any>("employees.createWithStructure", {
        ...payload,
        basic: Number(basic || 0),
        houseRent: Number(houseRent || 0),
        medical: Number(medical || 0),
        conveyance: Number(conveyance || 0),
        food: Number(food || 0),
        mobileAllow: Number(mobileAllow || 0),
        internetAllow: Number(internetAllow || 0),
        attendanceAllow: Number(attendanceAllow || 0),
        otherAllowance: Number(otherAllowance || 0),
      })

      const acc = emp?.account
      if (acc?.tempPassword) {
        setCreatedAccount({
          email: acc.email,
          tempPassword: acc.tempPassword,
          emailStatus: acc.emailStatus,
          smsStatus: acc.smsStatus,
          employeeId: emp.id,
          note: "No delivery channel is enabled (Settings → Communication) — copy the temporary password now and share it securely; it will not be shown again. The employee must set a new password at first sign-in.",
        })
        return
      }

      if (acc?.status === "CREATED") {
        toast(`Employee ${formValues.fullName} created — login account ${acc.email} created${acc.emailStatus === "SENT" || acc.smsStatus === "SENT" ? ", credentials sent" : ""}`, "ok")
      } else if (acc?.status === "NO_EMAIL") {
        toast(`Employee ${formValues.fullName} created (no login account — no email on file)`, "ok")
      } else if (acc?.detail) {
        toast(`Employee ${formValues.fullName} created — login account skipped: ${acc.detail}`, "ok")
      } else {
        toast(`Employee ${formValues.fullName} created successfully`, "ok")
      }

      setInitialSnapshot(JSON.stringify(formValues))
      onOpenChange(false)
      onCreated(emp.id)
    } catch (err: any) {
      setServerError(err.message || "Failed to create employee")
      toast(err.message || "Failed to create employee", "err")
    } finally {
      setBusy(false)
    }
  }

  // Active section index for Prev/Next buttons
  const activeSectionIndex = CREATE_FORM_SECTIONS.findIndex((s) => s.id === activeSection)

  const goToPrevSection = () => {
    if (activeSectionIndex > 0) {
      setActiveSection(CREATE_FORM_SECTIONS[activeSectionIndex - 1].id)
    }
  }

  const goToNextSection = () => {
    if (activeSectionIndex < CREATE_FORM_SECTIONS.length - 1) {
      setActiveSection(CREATE_FORM_SECTIONS[activeSectionIndex + 1].id)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          showCloseButton={false}
          className="max-w-5xl xl:max-w-6xl w-[95vw] h-[92vh] max-h-[92vh] flex flex-col p-0 gap-0 overflow-hidden rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-2xl"
          onInteractOutside={(e) => {
            if (isDirty) e.preventDefault()
          }}
        >
          {/* ============ DIALOG HEADER ============ */}
          <DialogHeader className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-900/90 shrink-0">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3.5 min-w-0">
                <div className="h-11 w-11 rounded-full bg-emerald-100 dark:bg-emerald-950/70 border-2 border-emerald-500/30 flex items-center justify-center text-emerald-700 dark:text-emerald-300 shrink-0">
                  <UserPlus className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <DialogTitle className="text-base sm:text-lg font-bold text-slate-900 dark:text-slate-100 truncate">
                      Add New Employee
                    </DialogTitle>
                    <Badge variant="outline" className="text-xs font-semibold bg-emerald-50 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300 border-emerald-200">
                      New Master Record
                    </Badge>
                    {isDirty && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 animate-pulse">
                        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                        Unsaved changes
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 truncate">
                    Creates the employee master profile, initial salary structure & self-service credentials
                  </p>
                </div>
              </div>

              {/* Mode Toggle & Close */}
              <div className="flex items-center gap-2">
                <div className="hidden sm:flex items-center bg-slate-200/70 dark:bg-slate-800 p-0.5 rounded-lg text-xs">
                  <button
                    type="button"
                    onClick={() => setViewMode("tabs")}
                    className={cn(
                      "px-2.5 py-1 rounded-md font-medium transition-all",
                      viewMode === "tabs"
                        ? "bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-xs"
                        : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
                    )}
                  >
                    Tabbed View
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewMode("all")}
                    className={cn(
                      "px-2.5 py-1 rounded-md font-medium transition-all",
                      viewMode === "all"
                        ? "bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-xs"
                        : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
                    )}
                  >
                    All Sections
                  </button>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
                  onClick={() => handleOpenChange(false)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Mobile / Horizontal Tab Strip */}
            <div className="flex lg:hidden overflow-x-auto no-scrollbar gap-1 pt-3 pb-1 border-t border-slate-200/60 dark:border-slate-800 mt-3 -mx-2 px-2">
              {CREATE_FORM_SECTIONS.map((sec) => {
                const Icon = sec.icon
                const errCount = validation.sectionErrors[sec.id] || 0
                const isActive = activeSection === sec.id
                return (
                  <button
                    key={sec.id}
                    type="button"
                    onClick={() => {
                      setActiveSection(sec.id)
                      if (viewMode === "all") {
                        document.getElementById(`create-section-${sec.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })
                      }
                    }}
                    className={cn(
                      "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap shrink-0 transition-colors",
                      isActive
                        ? "bg-emerald-600 text-white font-semibold shadow-xs"
                        : "bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700"
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    <span>{sec.label}</span>
                    {errCount > 0 && (
                      <span className="inline-flex items-center justify-center h-4 min-w-4 px-1 rounded-full text-[10px] font-bold bg-rose-500 text-white">
                        {errCount}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </DialogHeader>

          {/* ============ DIALOG BODY ============ */}
          <div className="flex-1 min-h-0 flex overflow-hidden">
            {/* Desktop Left Navigation Sidebar */}
            <aside className="hidden lg:flex w-72 border-r border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 flex-col shrink-0">
              <div className="p-3 overflow-y-auto flex-1 space-y-1">
                <p className="px-2 pb-1.5 text-[10px] uppercase font-bold tracking-wider text-slate-400 dark:text-slate-500">
                  Creation Sections
                </p>
                {CREATE_FORM_SECTIONS.map((sec) => {
                  const Icon = sec.icon
                  const errCount = validation.sectionErrors[sec.id] || 0
                  const isActive = activeSection === sec.id
                  return (
                    <button
                      key={sec.id}
                      type="button"
                      onClick={() => {
                        setActiveSection(sec.id)
                        if (viewMode === "all") {
                          document.getElementById(`create-section-${sec.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })
                        }
                      }}
                      className={cn(
                        "w-full text-left flex items-start gap-3 p-2.5 rounded-xl text-xs transition-all relative group",
                        isActive
                          ? "bg-emerald-50 dark:bg-emerald-950/40 text-emerald-950 dark:text-emerald-100 font-medium border border-emerald-200 dark:border-emerald-800/60 shadow-xs"
                          : "text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/60 hover:text-slate-900 dark:hover:text-slate-200 border border-transparent"
                      )}
                    >
                      <div
                        className={cn(
                          "h-8 w-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5 transition-colors",
                          isActive
                            ? "bg-emerald-600 text-white"
                            : "bg-slate-200/80 dark:bg-slate-800 text-slate-600 dark:text-slate-400 group-hover:bg-slate-300 dark:group-hover:bg-slate-700"
                        )}
                      >
                        <Icon className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-1">
                          <span className={cn("font-semibold truncate", isActive ? "text-emerald-900 dark:text-emerald-200" : "text-slate-800 dark:text-slate-200")}>
                            {sec.title}
                          </span>
                          {errCount > 0 ? (
                            <span className="inline-flex items-center justify-center h-4.5 min-w-4.5 px-1.5 rounded-full text-[10px] font-bold bg-rose-500 text-white shrink-0">
                              {errCount}
                            </span>
                          ) : (
                            isActive && <span className="h-1.5 w-1.5 rounded-full bg-emerald-600 shrink-0" />
                          )}
                        </div>
                        <p className="text-[11px] text-slate-500 dark:text-slate-400 line-clamp-1 mt-0.5 leading-tight">
                          {sec.subtitle}
                        </p>
                      </div>
                    </button>
                  )
                })}
              </div>

              {/* Sidebar Footer Status */}
              <div className="p-3 border-t border-slate-200 dark:border-slate-800 bg-white/50 dark:bg-slate-900/50">
                <div className="flex items-center justify-between text-[11px] text-slate-500 mb-1.5">
                  <span>Validation Status</span>
                  <span className={cn("font-semibold", validation.isValid ? "text-emerald-600" : "text-rose-600")}>
                    {validation.isValid ? "Ready to create" : `${Object.keys(validation.errors).length} issues`}
                  </span>
                </div>
                <div className="h-1.5 w-full bg-slate-200 dark:bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className={cn("h-full transition-all duration-300", validation.isValid ? "bg-emerald-500 w-full" : "bg-rose-500 w-2/3")}
                  />
                </div>
              </div>
            </aside>

            {/* Main Form Work Area */}
            <main className="flex-1 min-w-0 overflow-y-auto p-4 sm:p-6 lg:p-8 space-y-8 bg-slate-50/30 dark:bg-slate-950/20">
              {/* Capacity Warning Banner */}
              <CapacityWarning limitKey="EMPLOYEES" />

              {/* Server Error Alert Banner */}
              {serverError && (
                <div className="rounded-xl border border-rose-300 bg-rose-50 dark:border-rose-900 dark:bg-rose-950/70 p-4 text-xs text-rose-800 dark:text-rose-300 flex items-start gap-3">
                  <AlertCircle className="h-4 w-4 text-rose-600 shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="font-semibold text-rose-900 dark:text-rose-200">Server Validation Error</p>
                    <p className="mt-0.5">{serverError}</p>
                  </div>
                  <Button variant="ghost" size="icon" className="h-6 w-6 -mr-1 text-rose-600" onClick={() => setServerError(null)}>
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )}

              {/* Attempted Submit Errors Summary Banner */}
              {attemptedSubmit && !validation.isValid && (
                <div className="rounded-xl border border-rose-300 bg-rose-50/90 dark:border-rose-900/80 dark:bg-rose-950/60 p-4 text-xs text-rose-800 dark:text-rose-300">
                  <div className="flex items-center gap-2 font-bold text-rose-900 dark:text-rose-200 mb-2">
                    <AlertTriangle className="h-4 w-4 text-rose-600" />
                    <span>Please resolve {Object.keys(validation.errors).length} validation errors before creating employee:</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {Object.entries(validation.errors).map(([field, msg]) => (
                      <button
                        key={field}
                        type="button"
                        onClick={() => {
                          for (const sec of CREATE_FORM_SECTIONS) {
                            if (validation.sectionErrors[sec.id] > 0) {
                              setActiveSection(sec.id)
                              break
                            }
                          }
                          document.getElementById(`create-input-${field}`)?.focus()
                        }}
                        className="px-2.5 py-1 rounded-md bg-white dark:bg-slate-900 border border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300 hover:bg-rose-100 dark:hover:bg-rose-900/40 text-[11px] font-medium transition-colors"
                      >
                        <span className="font-semibold">{field}:</span> {msg}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Render Sections (either filtered by activeSection or all in scroll mode) */}
              {CREATE_FORM_SECTIONS.map((sec) => {
                if (viewMode === "tabs" && sec.id !== activeSection) return null
                return (
                  <section
                    key={sec.id}
                    id={`create-section-${sec.id}`}
                    className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs overflow-hidden scroll-mt-6"
                  >
                    {/* Section Card Header */}
                    <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/80 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="h-8 w-8 rounded-lg bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 flex items-center justify-center font-bold text-xs">
                          {sec.number}
                        </div>
                        <div>
                          <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                            {sec.title}
                            {validation.sectionErrors[sec.id] > 0 && (
                              <Badge variant="destructive" className="h-5 text-[10px] px-1.5">
                                {validation.sectionErrors[sec.id]} issue{validation.sectionErrors[sec.id] > 1 ? "s" : ""}
                              </Badge>
                            )}
                          </h3>
                          <p className="text-xs text-slate-500 dark:text-slate-400">{sec.subtitle}</p>
                        </div>
                      </div>
                    </div>

                    {/* Section Fields Grid */}
                    <div className="p-5 sm:p-6 space-y-5">
                      {/* ---------------- GROUP 1: BASIC INFORMATION ---------------- */}
                      {sec.id === "basic" && (
                        <div className="space-y-5">
                          {/* Photo Upload & Preview Card */}
                          <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/60 flex flex-wrap items-center justify-between gap-4">
                            <div className="flex items-center gap-4">
                              <Avatar className="h-16 w-16 ring-2 ring-emerald-500/30">
                                {formValues.photoUrl ? (
                                  <AvatarImage src={formValues.photoUrl} alt="Employee preview" />
                                ) : (
                                  <AvatarFallback className="bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 font-bold text-lg">
                                    {formValues.fullName ? formValues.fullName.slice(0, 2).toUpperCase() : <UserRound className="h-7 w-7" />}
                                  </AvatarFallback>
                                )}
                              </Avatar>
                              <div>
                                <p className="text-xs font-bold text-slate-800 dark:text-slate-200">
                                  Employee Photograph (Optional)
                                </p>
                                <p className="text-[11px] text-slate-500 mt-0.5">
                                  Square format recommended. Processed automatically into high-res and avatar thumbnail.
                                </p>
                              </div>
                            </div>

                            <div className="flex items-center gap-2">
                              <input
                                ref={fileInputRef}
                                type="file"
                                accept="image/*"
                                className="hidden"
                                onChange={handlePhotoUpload}
                              />
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-8 text-xs"
                                disabled={photoBusy}
                                onClick={() => fileInputRef.current?.click()}
                              >
                                <Upload className="h-3.5 w-3.5 mr-1.5" />
                                {photoBusy ? "Processing…" : formValues.photoUrl ? "Change Photo" : "Upload Photo"}
                              </Button>
                              {formValues.photoUrl && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-8 text-xs text-rose-600 hover:text-rose-700 hover:bg-rose-50"
                                  onClick={removePhoto}
                                >
                                  Remove
                                </Button>
                              )}
                            </div>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <CreateFormFieldWrapper
                              label="Full Name"
                              required
                              error={attemptedSubmit ? validation.errors.fullName : undefined}
                              help="Official legal name as recognized in employment agreements"
                            >
                              <Input
                                id="create-input-fullName"
                                value={formValues.fullName}
                                onChange={(e) => setFieldValue("fullName", e.target.value)}
                                placeholder="e.g. Rahim Miah"
                                className={cn(
                                  attemptedSubmit && validation.errors.fullName && "border-rose-400 focus-visible:ring-rose-400 bg-rose-50/20"
                                )}
                              />
                            </CreateFormFieldWrapper>

                            <CreateFormFieldWrapper
                              label="Preferred Name / Call Name"
                              help="Short name used in team communications"
                            >
                              <Input
                                id="create-input-preferredName"
                                value={formValues.preferredName}
                                onChange={(e) => setFieldValue("preferredName", e.target.value)}
                                placeholder="e.g. Rahim"
                              />
                            </CreateFormFieldWrapper>

                            <div className="sm:col-span-2">
                              <CreateFormFieldWrapper
                                label="Bangla Name"
                                help="Name in Bengali script (বাংলায় নাম)"
                              >
                                <Input
                                  id="create-input-nameBn"
                                  value={formValues.nameBn}
                                  onChange={(e) => setFieldValue("nameBn", e.target.value)}
                                  placeholder="যেমন: রহিম মিয়া"
                                />
                              </CreateFormFieldWrapper>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* ---------------- GROUP 2: PERSONAL & FAMILY INFORMATION ---------------- */}
                      {sec.id === "personal" && (
                        <div className="space-y-4">
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                            <CreateFormFieldWrapper label="Father's Name">
                              <Input
                                id="create-input-fatherName"
                                value={formValues.fatherName}
                                onChange={(e) => setFieldValue("fatherName", e.target.value)}
                                placeholder="Father's full name"
                              />
                            </CreateFormFieldWrapper>
                            <CreateFormFieldWrapper label="Mother's Name">
                              <Input
                                id="create-input-motherName"
                                value={formValues.motherName}
                                onChange={(e) => setFieldValue("motherName", e.target.value)}
                                placeholder="Mother's full name"
                              />
                            </CreateFormFieldWrapper>
                            <CreateFormFieldWrapper label="Spouse Name">
                              <Input
                                id="create-input-spouseName"
                                value={formValues.spouseName}
                                onChange={(e) => setFieldValue("spouseName", e.target.value)}
                                placeholder="Spouse name (if married)"
                              />
                            </CreateFormFieldWrapper>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                            <CreateFormFieldWrapper
                              label="Date of Birth"
                              required
                              error={attemptedSubmit ? validation.errors.dob : undefined}
                              help={dobAge !== null ? `Age: ${dobAge} years old` : "Required for tax category detection"}
                            >
                              <div className="relative">
                                <Input
                                  id="create-input-dob"
                                  type="date"
                                  value={formValues.dob}
                                  onChange={(e) => setFieldValue("dob", e.target.value)}
                                  className={cn(
                                    attemptedSubmit && validation.errors.dob && "border-rose-400 focus-visible:ring-rose-400 bg-rose-50/20"
                                  )}
                                />
                                {dobAge !== null && (
                                  <span className="absolute right-9 top-2 text-[10px] font-semibold bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 px-1.5 py-0.5 rounded">
                                    {dobAge} yrs
                                  </span>
                                )}
                              </div>
                            </CreateFormFieldWrapper>

                            <CreateFormFieldWrapper
                              label="Gender"
                              required
                              error={attemptedSubmit ? validation.errors.gender : undefined}
                            >
                              <Select
                                value={formValues.gender || "MALE"}
                                onValueChange={(v) => setFieldValue("gender", v)}
                              >
                                <SelectTrigger id="create-input-gender">
                                  <SelectValue placeholder="Select gender" />
                                </SelectTrigger>
                                <SelectContent>
                                  {GENDER_OPTIONS.map((g) => (
                                    <SelectItem key={g} value={g}>
                                      {titleCase(g)}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </CreateFormFieldWrapper>

                            <CreateFormFieldWrapper
                              label="Marital Status"
                              required
                              error={attemptedSubmit ? validation.errors.maritalStatus : undefined}
                            >
                              <Select
                                value={formValues.maritalStatus || "SINGLE"}
                                onValueChange={(v) => setFieldValue("maritalStatus", v)}
                              >
                                <SelectTrigger id="create-input-maritalStatus">
                                  <SelectValue placeholder="Select status" />
                                </SelectTrigger>
                                <SelectContent>
                                  {MARITAL_STATUS_OPTIONS.map((m) => (
                                    <SelectItem key={m} value={m}>
                                      {titleCase(m)}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </CreateFormFieldWrapper>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
                            <CreateFormFieldWrapper label="Blood Group">
                              <Select
                                value={formValues.bloodGroup || NONE}
                                onValueChange={(v) => setFieldValue("bloodGroup", v === NONE ? "" : v)}
                              >
                                <SelectTrigger id="create-input-bloodGroup">
                                  <SelectValue placeholder="Select blood group" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value={NONE}>— Not Specified —</SelectItem>
                                  {BLOOD_GROUPS.map((b) => (
                                    <SelectItem key={b} value={b}>
                                      {b}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </CreateFormFieldWrapper>

                            <CreateFormFieldWrapper label="Religion">
                              <Select
                                value={formValues.religion || "ISLAM"}
                                onValueChange={(v) => setFieldValue("religion", v)}
                              >
                                <SelectTrigger id="create-input-religion">
                                  <SelectValue placeholder="Select religion" />
                                </SelectTrigger>
                                <SelectContent>
                                  {RELIGION_OPTIONS.map((r) => (
                                    <SelectItem key={r} value={r}>
                                      {titleCase(r)}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </CreateFormFieldWrapper>

                            <CreateFormFieldWrapper label="Nationality">
                              <Input
                                id="create-input-nationality"
                                value={formValues.nationality}
                                onChange={(e) => setFieldValue("nationality", e.target.value)}
                                placeholder="e.g. Bangladeshi"
                              />
                            </CreateFormFieldWrapper>

                            <CreateFormFieldWrapper label="Place of Birth">
                              <Input
                                id="create-input-placeOfBirth"
                                value={formValues.placeOfBirth}
                                onChange={(e) => setFieldValue("placeOfBirth", e.target.value)}
                                placeholder="District / City"
                              />
                            </CreateFormFieldWrapper>
                          </div>
                        </div>
                      )}

                      {/* ---------------- GROUP 3: IDENTITY & CONTACT INFORMATION ---------------- */}
                      {sec.id === "identity" && (
                        <div className="space-y-5">
                          {/* Identity Document Block */}
                          <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 space-y-3">
                            <div className="flex items-center gap-2 text-xs font-bold text-slate-800 dark:text-slate-200">
                              <ShieldCheck className="h-4 w-4 text-emerald-600" />
                              <span>Official Identity Document</span>
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                              <CreateFormFieldWrapper label="Document Type">
                                <Select
                                  value={formValues.identityType || "NID"}
                                  onValueChange={(v) => setFieldValue("identityType", v)}
                                >
                                  <SelectTrigger id="create-input-identityType">
                                    <SelectValue placeholder="Select document type" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="NID">National ID (NID)</SelectItem>
                                    <SelectItem value="PASSPORT">Passport</SelectItem>
                                    <SelectItem value="BIRTH_REG">Birth Registration Certificate</SelectItem>
                                  </SelectContent>
                                </Select>
                              </CreateFormFieldWrapper>

                              <div className="sm:col-span-2">
                                <CreateFormFieldWrapper
                                  label="Document Number"
                                  error={attemptedSubmit ? validation.errors.identityNumber : undefined}
                                  help={
                                    nidFeedback
                                      ? nidFeedback.ok
                                        ? `✓ ${nidFeedback.message}`
                                        : `✗ ${nidFeedback.message}`
                                      : "National ID (10, 13 or 17 digits), Passport, or 17-digit Birth Certificate"
                                  }
                                >
                                  <Input
                                    id="create-input-identityNumber"
                                    value={formValues.identityNumber}
                                    onChange={(e) => setFieldValue("identityNumber", e.target.value)}
                                    placeholder={
                                      formValues.identityType === "NID"
                                        ? "e.g. 19901234567890123 (10/13/17 digits)"
                                        : formValues.identityType === "PASSPORT"
                                        ? "e.g. A12345678"
                                        : "e.g. 19901234567890123 (17 digits)"
                                    }
                                    className={cn(
                                      attemptedSubmit && validation.errors.identityNumber && "border-rose-400 focus-visible:ring-rose-400 bg-rose-50/20"
                                    )}
                                  />
                                </CreateFormFieldWrapper>
                              </div>
                            </div>

                            {/* EXT-05 (R7) — rehire detection banner */}
                            {rehireMatches.length > 0 && (
                              <div className="rounded-xl border border-amber-300 dark:border-amber-800 bg-gradient-to-r from-amber-50 to-orange-50/60 dark:from-amber-950/40 dark:to-orange-950/20 p-3.5">
                                <p className="text-xs font-bold text-amber-800 dark:text-amber-300 flex items-center gap-1.5">
                                  <History className="h-3.5 w-3.5" /> Former employee detected — is this a rehire?
                                </p>
                                <p className="text-[11px] text-amber-700/80 dark:text-amber-400/80 mt-1">
                                  {rehireMatches.length === 1 ? "This person matches a former employee" : `${rehireMatches.length} former employees match`}. Link the records to keep the prior service history reachable (gratuity continuity, references).
                                </p>
                                <div className="mt-2 space-y-1.5">
                                  {rehireMatches.slice(0, 3).map((m: any) => (
                                    <label key={m.id} className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-all ${priorEmployeeId === m.id ? "border-amber-400 bg-amber-100/60 dark:bg-amber-900/40 ring-1 ring-amber-400/50" : "border-amber-200 dark:border-amber-800/60 bg-white dark:bg-slate-900/60 hover:border-amber-300"}`}>
                                      <input type="radio" checked={priorEmployeeId === m.id} onChange={() => setPriorEmployeeId(priorEmployeeId === m.id ? null : m.id)} className="accent-amber-600" />
                                      <div className="min-w-0 flex-1">
                                        <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">{m.fullName} <span className="font-mono text-[10px] text-slate-400">{m.code}</span></p>
                                        <p className="text-[10px] text-slate-500 dark:text-slate-400">{titleCase(m.status)}{m.joiningDate ? ` · joined ${m.joiningDate}` : ""}</p>
                                      </div>
                                      {priorEmployeeId === m.id && <Badge className="bg-amber-100 text-amber-800 text-[9px]">linked</Badge>}
                                    </label>
                                  ))}
                                </div>
                                <label className="mt-2 flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400 cursor-pointer">
                                  <input type="radio" checked={!priorEmployeeId} onChange={() => setPriorEmployeeId(null)} className="accent-slate-400" />
                                  Not a rehire — create a fresh record
                                </label>
                              </div>
                            )}
                          </div>

                          {/* Communication Contacts */}
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <CreateFormFieldWrapper
                              label="Personal Mobile"
                              error={attemptedSubmit ? validation.errors.mobile : undefined}
                              help="Primary employee contact number"
                            >
                              <div className="relative">
                                <Input
                                  id="create-input-mobile"
                                  value={formValues.mobile}
                                  onChange={(e) => setFieldValue("mobile", e.target.value)}
                                  placeholder="01XXXXXXXXX"
                                  className="pl-8"
                                />
                                <Phone className="h-3.5 w-3.5 text-slate-400 absolute left-2.5 top-3" />
                              </div>
                            </CreateFormFieldWrapper>

                            <CreateFormFieldWrapper
                              label="Alternate Mobile"
                              error={attemptedSubmit ? validation.errors.altMobile : undefined}
                              help="Secondary contact number"
                            >
                              <div className="relative">
                                <Input
                                  id="create-input-altMobile"
                                  value={formValues.altMobile}
                                  onChange={(e) => setFieldValue("altMobile", e.target.value)}
                                  placeholder="01XXXXXXXXX"
                                  className="pl-8"
                                />
                                <Phone className="h-3.5 w-3.5 text-slate-400 absolute left-2.5 top-3" />
                              </div>
                            </CreateFormFieldWrapper>

                            <CreateFormFieldWrapper
                              label="Personal Email"
                              error={attemptedSubmit ? validation.errors.personalEmail : undefined}
                              help="For onboarding & confidential credentials delivery"
                            >
                              <div className="relative">
                                <Input
                                  id="create-input-personalEmail"
                                  type="email"
                                  value={formValues.personalEmail}
                                  onChange={(e) => setFieldValue("personalEmail", e.target.value)}
                                  placeholder="employee@gmail.com"
                                  className="pl-8"
                                />
                                <Mail className="h-3.5 w-3.5 text-slate-400 absolute left-2.5 top-3" />
                              </div>
                            </CreateFormFieldWrapper>

                            <CreateFormFieldWrapper
                              label="Official Work Email"
                              error={attemptedSubmit ? validation.errors.officialEmail : undefined}
                              help="Becomes the primary ESS login username"
                            >
                              <div className="relative">
                                <Input
                                  id="create-input-officialEmail"
                                  type="email"
                                  value={formValues.officialEmail}
                                  onChange={(e) => setFieldValue("officialEmail", e.target.value)}
                                  placeholder="employee@company.com"
                                  className="pl-8"
                                />
                                <Mail className="h-3.5 w-3.5 text-slate-400 absolute left-2.5 top-3" />
                              </div>
                            </CreateFormFieldWrapper>
                          </div>

                          {/* Emergency Contact Block */}
                          <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 space-y-3">
                            <p className="text-xs font-bold text-slate-800 dark:text-slate-200">
                              Emergency Contact Information
                            </p>
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                              <CreateFormFieldWrapper label="Emergency Contact Person Name">
                                <Input
                                  id="create-input-emergencyName"
                                  value={formValues.emergencyName}
                                  onChange={(e) => setFieldValue("emergencyName", e.target.value)}
                                  placeholder="Emergency contact full name"
                                />
                              </CreateFormFieldWrapper>

                              <CreateFormFieldWrapper
                                label="Contact Mobile"
                                error={attemptedSubmit ? validation.errors.emergencyMobile : undefined}
                              >
                                <Input
                                  id="create-input-emergencyMobile"
                                  value={formValues.emergencyMobile}
                                  onChange={(e) => setFieldValue("emergencyMobile", e.target.value)}
                                  placeholder="Emergency mobile number"
                                />
                              </CreateFormFieldWrapper>

                              <CreateFormFieldWrapper label="Relationship">
                                <Input
                                  id="create-input-emergencyRelation"
                                  value={formValues.emergencyRelation}
                                  onChange={(e) => setFieldValue("emergencyRelation", e.target.value)}
                                  placeholder="e.g. Spouse / Brother / Father"
                                />
                              </CreateFormFieldWrapper>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* ---------------- GROUP 4: ADDRESS INFORMATION ---------------- */}
                      {sec.id === "address" && (
                        <div className="space-y-5">
                          {/* Address Synchronization Switch */}
                          <div className="p-4 rounded-xl border border-emerald-200/80 bg-emerald-50/50 dark:border-emerald-900/60 dark:bg-emerald-950/20 flex flex-wrap items-center justify-between gap-3">
                            <div>
                              <p className="text-xs font-bold text-emerald-950 dark:text-emerald-200">
                                Address Synchronization
                              </p>
                              <p className="text-[11px] text-emerald-800/80 dark:text-emerald-300/80">
                                When enabled, present address automatically mirrors the permanent address details
                              </p>
                            </div>
                            <div className="flex items-center gap-2">
                              <Label htmlFor="create-switch-addressSame" className="text-xs font-semibold cursor-pointer">
                                Same as Permanent
                              </Label>
                              <Switch
                                id="create-switch-addressSame"
                                checked={formValues.addressSame}
                                onCheckedChange={(val) => setFieldValue("addressSame", val)}
                              />
                            </div>
                          </div>

                          {/* Permanent Address Block */}
                          <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-4">
                            <div className="flex items-center gap-2 text-xs font-bold text-slate-800 dark:text-slate-200">
                              <MapPin className="h-4 w-4 text-emerald-600" />
                              <span>Permanent Address</span>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
                              <CreateFormFieldWrapper label="Division">
                                <Input
                                  id="create-input-division"
                                  value={formValues.division}
                                  onChange={(e) => setFieldValue("division", e.target.value)}
                                  placeholder="e.g. Dhaka"
                                />
                              </CreateFormFieldWrapper>
                              <CreateFormFieldWrapper label="District">
                                <Input
                                  id="create-input-district"
                                  value={formValues.district}
                                  onChange={(e) => setFieldValue("district", e.target.value)}
                                  placeholder="e.g. Gazipur"
                                />
                              </CreateFormFieldWrapper>
                              <CreateFormFieldWrapper label="City / Upazila">
                                <Input
                                  id="create-input-city"
                                  value={formValues.city}
                                  onChange={(e) => setFieldValue("city", e.target.value)}
                                  placeholder="e.g. Kaliakair"
                                />
                              </CreateFormFieldWrapper>
                              <CreateFormFieldWrapper
                                label="Post Code"
                                error={attemptedSubmit ? validation.errors.postCode : undefined}
                              >
                                <Input
                                  id="create-input-postCode"
                                  value={formValues.postCode}
                                  onChange={(e) => setFieldValue("postCode", e.target.value)}
                                  placeholder="e.g. 1750"
                                />
                              </CreateFormFieldWrapper>
                            </div>

                            <CreateFormFieldWrapper label="Detailed Permanent Address (Village, Road, House)">
                              <Textarea
                                id="create-input-permanentAddress"
                                rows={2}
                                value={formValues.permanentAddress}
                                onChange={(e) => setFieldValue("permanentAddress", e.target.value)}
                                placeholder="House / Holding, Road name, Village / Sector, Landmark"
                              />
                            </CreateFormFieldWrapper>
                          </div>

                            {/* Present Address Block */}
                            <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-4">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2 text-xs font-bold text-slate-800 dark:text-slate-200">
                                  <MapPin className="h-4 w-4 text-emerald-600" />
                                  <span>Present Address (Current Residence)</span>
                                </div>
                                {formValues.addressSame && (
                                  <Badge variant="secondary" className="text-[10px]">
                                    Mirrored from Permanent
                                  </Badge>
                                )}
                              </div>

                              <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
                                <CreateFormFieldWrapper label="Division">
                                  <Input
                                    id="create-input-presentDivision"
                                    value={formValues.presentDivision}
                                    onChange={(e) => setFieldValue("presentDivision", e.target.value)}
                                    disabled={formValues.addressSame}
                                    placeholder={formValues.addressSame ? "Auto-synced" : "e.g. Dhaka"}
                                    className={cn(formValues.addressSame && "bg-slate-100 dark:bg-slate-800 text-slate-500 cursor-not-allowed")}
                                  />
                                </CreateFormFieldWrapper>
                                <CreateFormFieldWrapper label="District">
                                  <Input
                                    id="create-input-presentDistrict"
                                    value={formValues.presentDistrict}
                                    onChange={(e) => setFieldValue("presentDistrict", e.target.value)}
                                    disabled={formValues.addressSame}
                                    placeholder={formValues.addressSame ? "Auto-synced" : "e.g. Gazipur"}
                                    className={cn(formValues.addressSame && "bg-slate-100 dark:bg-slate-800 text-slate-500 cursor-not-allowed")}
                                  />
                                </CreateFormFieldWrapper>
                                <CreateFormFieldWrapper label="City / Upazila">
                                  <Input
                                    id="create-input-presentCity"
                                    value={formValues.presentCity}
                                    onChange={(e) => setFieldValue("presentCity", e.target.value)}
                                    disabled={formValues.addressSame}
                                    placeholder={formValues.addressSame ? "Auto-synced" : "e.g. Kaliakair"}
                                    className={cn(formValues.addressSame && "bg-slate-100 dark:bg-slate-800 text-slate-500 cursor-not-allowed")}
                                  />
                                </CreateFormFieldWrapper>
                                <CreateFormFieldWrapper
                                  label="Post Code"
                                  error={attemptedSubmit ? validation.errors.presentPostCode : undefined}
                                >
                                  <Input
                                    id="create-input-presentPostCode"
                                    value={formValues.presentPostCode}
                                    onChange={(e) => setFieldValue("presentPostCode", e.target.value)}
                                    disabled={formValues.addressSame}
                                    placeholder={formValues.addressSame ? "Auto-synced" : "e.g. 1750"}
                                    className={cn(formValues.addressSame && "bg-slate-100 dark:bg-slate-800 text-slate-500 cursor-not-allowed")}
                                  />
                                </CreateFormFieldWrapper>
                              </div>

                              <CreateFormFieldWrapper label="Detailed Present Address">
                                <Textarea
                                  id="create-input-presentAddress"
                                  rows={2}
                                  value={formValues.presentAddress}
                                  onChange={(e) => setFieldValue("presentAddress", e.target.value)}
                                  disabled={formValues.addressSame}
                                  placeholder={formValues.addressSame ? "Auto-synced from permanent address" : "House, Road, Area, City"}
                                  className={cn(formValues.addressSame && "bg-slate-100 dark:bg-slate-800 text-slate-500 cursor-not-allowed")}
                                />
                              </CreateFormFieldWrapper>
                            </div>
                        </div>
                      )}

                      {/* ---------------- GROUP 5: ORGANIZATIONAL & JOB INFORMATION ---------------- */}
                      {sec.id === "organization" && (
                        <div className="space-y-4">
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                            <CreateFormFieldWrapper
                              label="Branch"
                              required
                              error={attemptedSubmit ? validation.errors.branchId : undefined}
                            >
                              <Select
                                value={formValues.branchId || NONE}
                                onValueChange={(v) => setFieldValue("branchId", v === NONE ? "" : v)}
                              >
                                <SelectTrigger id="create-input-branchId">
                                  <SelectValue placeholder="Select branch" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value={NONE}>— Select Branch —</SelectItem>
                                  {(lookups?.branches || []).map((b: any) => (
                                    <SelectItem key={b.id} value={b.id}>
                                      {b.name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </CreateFormFieldWrapper>

                            <CreateFormFieldWrapper
                              label="Department"
                              required
                              error={attemptedSubmit ? validation.errors.departmentId : undefined}
                            >
                              <Select
                                value={formValues.departmentId || NONE}
                                onValueChange={(v) => setFieldValue("departmentId", v === NONE ? "" : v)}
                              >
                                <SelectTrigger id="create-input-departmentId">
                                  <SelectValue placeholder="Select department" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value={NONE}>— Select Department —</SelectItem>
                                  {(lookups?.departments || []).map((d: any) => (
                                    <SelectItem key={d.id} value={d.id}>
                                      {d.name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </CreateFormFieldWrapper>

                            <CreateFormFieldWrapper
                              label="Designation"
                              required
                              error={attemptedSubmit ? validation.errors.designationId : undefined}
                            >
                              <Select
                                value={formValues.designationId || NONE}
                                onValueChange={(v) => setFieldValue("designationId", v === NONE ? "" : v)}
                              >
                                <SelectTrigger id="create-input-designationId">
                                  <SelectValue placeholder="Select designation" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value={NONE}>— Select Designation —</SelectItem>
                                  {(lookups?.designations || []).map((des: any) => (
                                    <SelectItem key={des.id} value={des.id}>
                                      {des.name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </CreateFormFieldWrapper>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                            <CreateFormFieldWrapper label="Employment Type">
                              <Select
                                value={formValues.employmentType || "PERMANENT"}
                                onValueChange={(v) => setFieldValue("employmentType", v)}
                              >
                                <SelectTrigger id="create-input-employmentType">
                                  <SelectValue placeholder="Select type" />
                                </SelectTrigger>
                                <SelectContent>
                                  {EMPLOYMENT_TYPES.map((t) => (
                                    <SelectItem key={t} value={t}>
                                      {titleCase(t)}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </CreateFormFieldWrapper>

                            <CreateFormFieldWrapper label="Employment Category" help="e.g. Officer, Staff, Worker">
                              <Input
                                id="create-input-category"
                                value={formValues.category}
                                onChange={(e) => setFieldValue("category", e.target.value)}
                                placeholder="e.g. Permanent Staff"
                              />
                            </CreateFormFieldWrapper>

                            <CreateFormFieldWrapper label="Work Location" help="e.g. Corporate HQ, Plant-1">
                              <Input
                                id="create-input-workLocation"
                                value={formValues.workLocation}
                                onChange={(e) => setFieldValue("workLocation", e.target.value)}
                                placeholder="Work physical location"
                              />
                            </CreateFormFieldWrapper>
                          </div>

                          {/* Reporting & Management Hierarchy */}
                          <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 space-y-3">
                            <p className="text-xs font-bold text-slate-800 dark:text-slate-200">
                              Reporting Hierarchy & Approvers
                            </p>
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                              <CreateFormFieldWrapper label="Reporting Manager" help="Direct line manager">
                                <Select
                                  value={formValues.reportingManagerId || NONE}
                                  onValueChange={(v) => setFieldValue("reportingManagerId", v === NONE ? "" : v)}
                                >
                                  <SelectTrigger id="create-input-reportingManagerId">
                                    <SelectValue placeholder="Select reporting manager" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value={NONE}>— No Direct Manager —</SelectItem>
                                    {activeEmployees.map((m) => (
                                      <SelectItem key={m.id} value={m.id}>
                                        {m.fullName} ({m.code})
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </CreateFormFieldWrapper>

                              <CreateFormFieldWrapper label="Supervisor" help="Shift or floor supervisor">
                                <Select
                                  value={formValues.supervisorId || NONE}
                                  onValueChange={(v) => setFieldValue("supervisorId", v === NONE ? "" : v)}
                                >
                                  <SelectTrigger id="create-input-supervisorId">
                                    <SelectValue placeholder="Select supervisor" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value={NONE}>— No Supervisor —</SelectItem>
                                    {activeEmployees.map((m) => (
                                      <SelectItem key={m.id} value={m.id}>
                                        {m.fullName} ({m.code})
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </CreateFormFieldWrapper>

                              <CreateFormFieldWrapper label="HR Manager" help="Dedicated HR partner">
                                <Select
                                  value={formValues.hrManagerId || NONE}
                                  onValueChange={(v) => setFieldValue("hrManagerId", v === NONE ? "" : v)}
                                >
                                  <SelectTrigger id="create-input-hrManagerId">
                                    <SelectValue placeholder="Select HR manager" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value={NONE}>— No HR Manager —</SelectItem>
                                    {activeEmployees.map((m) => (
                                      <SelectItem key={m.id} value={m.id}>
                                        {m.fullName} ({m.code})
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </CreateFormFieldWrapper>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* ---------------- GROUP 6: EMPLOYMENT & PROBATION DETAILS ---------------- */}
                      {sec.id === "lifecycle" && (
                        <div className="space-y-5">
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                            <CreateFormFieldWrapper
                              label="Joining Date"
                              required
                              error={attemptedSubmit ? validation.errors.joiningDate : undefined}
                              help="Official joining date"
                            >
                              <Input
                                id="create-input-joiningDate"
                                type="date"
                                value={formValues.joiningDate}
                                onChange={(e) => setFieldValue("joiningDate", e.target.value)}
                                className={cn(
                                  attemptedSubmit && validation.errors.joiningDate && "border-rose-400 focus-visible:ring-rose-400 bg-rose-50/20"
                                )}
                              />
                            </CreateFormFieldWrapper>

                            <CreateFormFieldWrapper
                              label="Confirmation Date"
                              error={attemptedSubmit ? validation.errors.confirmationDate : undefined}
                              help="Permanent confirmation date (must be >= joining date)"
                            >
                              <Input
                                id="create-input-confirmationDate"
                                type="date"
                                value={formValues.confirmationDate}
                                onChange={(e) => setFieldValue("confirmationDate", e.target.value)}
                                className={cn(
                                  attemptedSubmit && validation.errors.confirmationDate && "border-rose-400 focus-visible:ring-rose-400 bg-rose-50/20"
                                )}
                              />
                            </CreateFormFieldWrapper>

                            <CreateFormFieldWrapper
                              label="Probation Period (Months)"
                              error={attemptedSubmit ? validation.errors.probationMonths : undefined}
                              help="Duration in months (0 = confirmed on join)"
                            >
                              <Input
                                id="create-input-probationMonths"
                                type="number"
                                min={0}
                                value={formValues.probationMonths}
                                onChange={(e) => setFieldValue("probationMonths", e.target.value)}
                              />
                            </CreateFormFieldWrapper>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <CreateFormFieldWrapper label="Salary Grade" help="e.g. Grade-4, Senior Officer">
                              <Input
                                id="create-input-grade"
                                value={formValues.grade}
                                onChange={(e) => setFieldValue("grade", e.target.value)}
                                placeholder="e.g. Grade 4"
                              />
                            </CreateFormFieldWrapper>
                          </div>

                          {/* Contract Lifecycle Details Block */}
                          <div
                            className={cn(
                              "p-4 rounded-xl border transition-colors space-y-3",
                              ["CONTRACTUAL", "TEMPORARY", "INTERN"].includes(formValues.employmentType)
                                ? "border-amber-300 bg-amber-50/50 dark:border-amber-900/60 dark:bg-amber-950/20"
                                : "border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50"
                            )}
                          >
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2 text-xs font-bold text-slate-800 dark:text-slate-200">
                                <Calendar className="h-4 w-4 text-emerald-600" />
                                <span>Fixed-Term / Contract Lifecycle</span>
                              </div>
                              {["CONTRACTUAL", "TEMPORARY", "INTERN"].includes(formValues.employmentType) && (
                                <Badge variant="outline" className="text-[10px] bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                                  Contractual Active
                                </Badge>
                              )}
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                              <CreateFormFieldWrapper label="Contract Start Date">
                                <Input
                                  id="create-input-contractStart"
                                  type="date"
                                  value={formValues.contractStart}
                                  onChange={(e) => setFieldValue("contractStart", e.target.value)}
                                />
                              </CreateFormFieldWrapper>

                              <CreateFormFieldWrapper
                                label="Contract End Date"
                                error={attemptedSubmit ? validation.errors.contractEnd : undefined}
                                help="Must be on or after Contract Start date"
                              >
                                <Input
                                  id="create-input-contractEnd"
                                  type="date"
                                  value={formValues.contractEnd}
                                  onChange={(e) => setFieldValue("contractEnd", e.target.value)}
                                  className={cn(
                                    attemptedSubmit && validation.errors.contractEnd && "border-rose-400 focus-visible:ring-rose-400 bg-rose-50/20"
                                  )}
                                />
                              </CreateFormFieldWrapper>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* ---------------- GROUP 7: WORK SCHEDULE & ATTENDANCE ---------------- */}
                      {sec.id === "attendance" && (
                        <div className="space-y-5">
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <CreateFormFieldWrapper
                              label="Duty Shift"
                              help="Default duty shift schedule assigned to the employee"
                            >
                              <Select
                                value={formValues.shiftId || NONE}
                                onValueChange={(v) => setFieldValue("shiftId", v === NONE ? "" : v)}
                              >
                                <SelectTrigger id="create-input-shiftId">
                                  <SelectValue placeholder="Select shift" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value={NONE}>— Shift from Department / None —</SelectItem>
                                  {(lookups?.shifts || []).map((s: any) => (
                                    <SelectItem key={s.id} value={s.id}>
                                      {s.name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </CreateFormFieldWrapper>

                            <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
                              <div>
                                <Label htmlFor="create-switch-otEligible" className="text-xs font-semibold cursor-pointer">
                                  Overtime Eligible
                                </Label>
                                <p className="text-[11px] text-slate-500 mt-0.5">
                                  When enabled, extra hours are calculated & disbursed in monthly payroll
                                </p>
                              </div>
                              <Switch
                                id="create-switch-otEligible"
                                checked={formValues.otEligible}
                                onCheckedChange={(val) => setFieldValue("otEligible", val)}
                              />
                            </div>
                          </div>

                          {/* Weekly Off Days Interactive Chip Selector */}
                          <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 space-y-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div>
                                <p className="text-xs font-bold text-slate-800 dark:text-slate-200">
                                  Weekly Off Days (Employee Override)
                                </p>
                                <p className="text-[11px] text-slate-500">
                                  Select the weekly off days for this employee. If none selected, the shift schedule is inherited.
                                </p>
                              </div>

                              {/* Presets */}
                              <div className="flex items-center gap-1.5">
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="h-7 text-[11px] px-2.5"
                                  onClick={() => applyWeeklyOffPreset("standard")}
                                >
                                  Fri + Sat (Standard)
                                </Button>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="h-7 text-[11px] px-2.5"
                                  onClick={() => applyWeeklyOffPreset("friday")}
                                >
                                  Friday Only
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 text-[11px] px-2 text-slate-500"
                                  onClick={() => applyWeeklyOffPreset("clear")}
                                >
                                  Clear
                                </Button>
                              </div>
                            </div>

                            {/* 7 Day Interactive Chips */}
                            <div className="flex flex-wrap gap-2 pt-1">
                              {WEEKLY_OFF_DAYS.map((day) => {
                                const isSelected = Array.isArray(formValues.weeklyOff) && formValues.weeklyOff.includes(day)
                                return (
                                  <button
                                    key={day}
                                    type="button"
                                    onClick={() => toggleWeeklyOffDay(day)}
                                    className={cn(
                                      "px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all border flex items-center gap-1.5",
                                      isSelected
                                        ? "bg-emerald-600 text-white border-emerald-600 shadow-xs scale-102"
                                        : "bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700"
                                    )}
                                  >
                                    {isSelected && <Check className="h-3 w-3 stroke-3" />}
                                    <span>{titleCase(day)}</span>
                                  </button>
                                )
                              })}
                            </div>
                          </div>
                        </div>
                      )}

                      {/* ---------------- GROUP 8: COMPENSATION, TAX & SALARY STRUCTURE ---------------- */}
                      {sec.id === "compensation" && (
                        <div className="space-y-5">
                          {/* e-TIN */}
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <CreateFormFieldWrapper
                              label="TIN (e-TIN)"
                              error={attemptedSubmit ? validation.errors.taxTin : undefined}
                              help={
                                tinFeedback
                                  ? tinFeedback.ok
                                    ? `✓ ${tinFeedback.message}`
                                    : `✗ ${tinFeedback.message}`
                                  : "Bangladesh 12-digit e-TIN. Feeds the AIT / Tax calculation."
                              }
                            >
                              <Input
                                id="create-input-taxTin"
                                value={formValues.taxTin}
                                onChange={(e) => setFieldValue("taxTin", e.target.value)}
                                placeholder="12-digit e-TIN"
                                className={cn(
                                  attemptedSubmit && validation.errors.taxTin && "border-rose-400 focus-visible:ring-rose-400 bg-rose-50/20"
                                )}
                              />
                            </CreateFormFieldWrapper>
                          </div>

                          {/* Initial Salary Structure Breakdown Card */}
                          <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 space-y-4">
                            <div className="flex flex-wrap items-center justify-between gap-3">
                              <div>
                                <p className="text-xs font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                                  <Banknote className="h-4 w-4 text-emerald-600" />
                                  <span>Initial Salary Structure (Monthly ৳)</span>
                                </p>
                                <p className="text-[11px] text-slate-500">
                                  Creates the active baseline salary structure and registers it with the payroll module.
                                </p>
                              </div>
                              <div className="px-3 py-1 rounded-lg bg-emerald-100 dark:bg-emerald-950/70 border border-emerald-300 dark:border-emerald-800 text-xs font-bold text-emerald-800 dark:text-emerald-300">
                                Gross: {fmtMoney(computedGross)} / mo
                              </div>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                              <CreateFormFieldWrapper label="Basic Salary (৳)" error={attemptedSubmit ? validation.errors.basic : undefined}>
                                <Input
                                  id="create-input-basic"
                                  type="number"
                                  min={0}
                                  value={formValues.basic}
                                  onChange={(e) => setFieldValue("basic", e.target.value)}
                                  placeholder="0"
                                />
                              </CreateFormFieldWrapper>

                              <CreateFormFieldWrapper label="House Rent (৳)" error={attemptedSubmit ? validation.errors.houseRent : undefined}>
                                <Input
                                  id="create-input-houseRent"
                                  type="number"
                                  min={0}
                                  value={formValues.houseRent}
                                  onChange={(e) => setFieldValue("houseRent", e.target.value)}
                                  placeholder="0"
                                />
                              </CreateFormFieldWrapper>

                              <CreateFormFieldWrapper label="Medical Allowance (৳)" error={attemptedSubmit ? validation.errors.medical : undefined}>
                                <Input
                                  id="create-input-medical"
                                  type="number"
                                  min={0}
                                  value={formValues.medical}
                                  onChange={(e) => setFieldValue("medical", e.target.value)}
                                  placeholder="0"
                                />
                              </CreateFormFieldWrapper>

                              <CreateFormFieldWrapper label="Conveyance Allowance (৳)" error={attemptedSubmit ? validation.errors.conveyance : undefined}>
                                <Input
                                  id="create-input-conveyance"
                                  type="number"
                                  min={0}
                                  value={formValues.conveyance}
                                  onChange={(e) => setFieldValue("conveyance", e.target.value)}
                                  placeholder="0"
                                />
                              </CreateFormFieldWrapper>

                              <CreateFormFieldWrapper label="Food Allowance (৳)" error={attemptedSubmit ? validation.errors.food : undefined}>
                                <Input
                                  id="create-input-food"
                                  type="number"
                                  min={0}
                                  value={formValues.food}
                                  onChange={(e) => setFieldValue("food", e.target.value)}
                                  placeholder="0"
                                />
                              </CreateFormFieldWrapper>

                              <CreateFormFieldWrapper label="Mobile Allowance (৳)" error={attemptedSubmit ? validation.errors.mobileAllow : undefined}>
                                <Input
                                  id="create-input-mobileAllow"
                                  type="number"
                                  min={0}
                                  value={formValues.mobileAllow}
                                  onChange={(e) => setFieldValue("mobileAllow", e.target.value)}
                                  placeholder="0"
                                />
                              </CreateFormFieldWrapper>

                              <CreateFormFieldWrapper label="Internet Allowance (৳)" error={attemptedSubmit ? validation.errors.internetAllow : undefined}>
                                <Input
                                  id="create-input-internetAllow"
                                  type="number"
                                  min={0}
                                  value={formValues.internetAllow}
                                  onChange={(e) => setFieldValue("internetAllow", e.target.value)}
                                  placeholder="0"
                                />
                              </CreateFormFieldWrapper>

                              <CreateFormFieldWrapper label="Attendance Allowance (৳)" error={attemptedSubmit ? validation.errors.attendanceAllow : undefined}>
                                <Input
                                  id="create-input-attendanceAllow"
                                  type="number"
                                  min={0}
                                  value={formValues.attendanceAllow}
                                  onChange={(e) => setFieldValue("attendanceAllow", e.target.value)}
                                  placeholder="0"
                                />
                              </CreateFormFieldWrapper>

                              <CreateFormFieldWrapper label="Other Allowance (৳)" error={attemptedSubmit ? validation.errors.otherAllowance : undefined}>
                                <Input
                                  id="create-input-otherAllowance"
                                  type="number"
                                  min={0}
                                  value={formValues.otherAllowance}
                                  onChange={(e) => setFieldValue("otherAllowance", e.target.value)}
                                  placeholder="0"
                                />
                              </CreateFormFieldWrapper>
                            </div>
                          </div>

                          {/* Salary Payout Configuration */}
                          <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/60 space-y-4">
                            <p className="text-xs font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                              <CreditCard className="h-4 w-4 text-emerald-600" />
                              <span>Salary Payout Method & Credentials</span>
                            </p>

                            <CreateFormFieldWrapper label="Payout Method" help="Cash/MFS ceiling enforced by vendor payout settings">
                              <Select
                                value={formValues.payoutMethod || "CASH"}
                                onValueChange={(v) => setFieldValue("payoutMethod", v)}
                              >
                                <SelectTrigger id="create-input-payoutMethod">
                                  <SelectValue placeholder="Select payout method" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="CASH">Cash</SelectItem>
                                  <SelectItem value="BANK">Bank Transfer</SelectItem>
                                  <SelectItem value="MFS">Mobile Financial Service (bKash / Nagad / Rocket)</SelectItem>
                                  <SelectItem value="NONE">— Configure Later (Unset) —</SelectItem>
                                </SelectContent>
                              </Select>
                            </CreateFormFieldWrapper>

                            {/* Bank Details */}
                            {formValues.payoutMethod === "BANK" && (
                              <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-4">
                                <p className="text-xs font-bold text-slate-800 dark:text-slate-200">
                                  Bank Account Details
                                </p>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                  <CreateFormFieldWrapper label="Bank Name">
                                    <Select
                                      value={formValues.payoutBank || NONE}
                                      onValueChange={(v) => setFieldValue("payoutBank", v === NONE ? "" : v)}
                                    >
                                      <SelectTrigger id="create-input-payoutBank">
                                        <SelectValue placeholder="Select bank" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value={NONE}>— Select Bank —</SelectItem>
                                        {BD_BANKS.map((b) => (
                                          <SelectItem key={b} value={b}>
                                            {b}
                                          </SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  </CreateFormFieldWrapper>

                                  <CreateFormFieldWrapper label="Branch Name">
                                    <Input
                                      id="create-input-payoutBranch"
                                      value={formValues.payoutBranch}
                                      onChange={(e) => setFieldValue("payoutBranch", e.target.value)}
                                      placeholder="e.g. Gulshan Branch"
                                    />
                                  </CreateFormFieldWrapper>

                                  <CreateFormFieldWrapper label="Account Holder Name">
                                    <Input
                                      id="create-input-payoutAccountName"
                                      value={formValues.payoutAccountName}
                                      onChange={(e) => setFieldValue("payoutAccountName", e.target.value)}
                                      placeholder="Name as it appears on bank passbook"
                                    />
                                  </CreateFormFieldWrapper>

                                  <CreateFormFieldWrapper
                                    label="Account Number"
                                    required
                                    error={attemptedSubmit ? validation.errors.payoutAccountNumber : undefined}
                                  >
                                    <Input
                                      id="create-input-payoutAccountNumber"
                                      value={formValues.payoutAccountNumber}
                                      onChange={(e) => setFieldValue("payoutAccountNumber", e.target.value)}
                                      placeholder="Account number"
                                    />
                                  </CreateFormFieldWrapper>

                                  <div className="sm:col-span-2">
                                    <CreateFormFieldWrapper
                                      label="Routing Number (9 Digits)"
                                      error={attemptedSubmit ? validation.errors.payoutRoutingNumber : undefined}
                                      help="BEFTN / RTGS 9-digit routing number (optional)"
                                    >
                                      <Input
                                        id="create-input-payoutRoutingNumber"
                                        value={formValues.payoutRoutingNumber}
                                        onChange={(e) => setFieldValue("payoutRoutingNumber", e.target.value)}
                                        placeholder="e.g. 125272654"
                                      />
                                    </CreateFormFieldWrapper>
                                  </div>
                                </div>
                              </div>
                            )}

                            {/* MFS Details */}
                            {formValues.payoutMethod === "MFS" && (
                              <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-4">
                                <p className="text-xs font-bold text-slate-800 dark:text-slate-200">
                                  Mobile Financial Service Account
                                </p>
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                                  <CreateFormFieldWrapper label="MFS Provider">
                                    <Select
                                      value={formValues.payoutMfsProvider || "BKASH"}
                                      onValueChange={(v) => setFieldValue("payoutMfsProvider", v)}
                                    >
                                      <SelectTrigger id="create-input-payoutMfsProvider">
                                        <SelectValue placeholder="Select provider" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        {MFS_PROVIDERS.map((p) => (
                                          <SelectItem key={p.value} value={p.value}>
                                            {p.label}
                                          </SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  </CreateFormFieldWrapper>

                                  <CreateFormFieldWrapper label="Account Holder Name">
                                    <Input
                                      id="create-input-payoutAccountNameMfs"
                                      value={formValues.payoutAccountName}
                                      onChange={(e) => setFieldValue("payoutAccountName", e.target.value)}
                                      placeholder="Registered wallet name"
                                    />
                                  </CreateFormFieldWrapper>

                                  <CreateFormFieldWrapper
                                    label="MFS Mobile Number"
                                    required
                                    error={attemptedSubmit ? validation.errors.payoutMfsNumber : undefined}
                                  >
                                    <Input
                                      id="create-input-payoutMfsNumber"
                                      value={formValues.payoutMfsNumber}
                                      onChange={(e) => setFieldValue("payoutMfsNumber", e.target.value)}
                                      placeholder="01XXXXXXXXX"
                                    />
                                  </CreateFormFieldWrapper>
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </section>
                )
              })}
            </main>
          </div>

          {/* ============ DIALOG STICKY FOOTER ============ */}
          <DialogFooter className="px-6 py-3.5 border-t border-slate-200 dark:border-slate-800 bg-slate-50/90 dark:bg-slate-900/90 flex flex-wrap items-center justify-between gap-3 shrink-0">
            {/* Left Nav Controls (Previous / Next in tabbed mode) */}
            <div className="flex items-center gap-2">
              {viewMode === "tabs" && (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 text-xs"
                    onClick={goToPrevSection}
                    disabled={activeSectionIndex === 0 || busy}
                  >
                    <ChevronLeft className="h-3.5 w-3.5 mr-1" />
                    Previous
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 text-xs"
                    onClick={goToNextSection}
                    disabled={activeSectionIndex === CREATE_FORM_SECTIONS.length - 1 || busy}
                  >
                    Next
                    <ChevronRight className="h-3.5 w-3.5 ml-1" />
                  </Button>
                </>
              )}
            </div>

            {/* Right Action Controls */}
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={() => handleOpenChange(false)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                className="h-8 text-xs bg-emerald-600 hover:bg-emerald-700 text-white font-semibold shadow-xs"
                onClick={() => handleSubmit()}
                disabled={busy}
              >
                {busy ? (
                  <>
                    <span className="h-3.5 w-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin mr-1.5" />
                    Creating Employee…
                  </>
                ) : (
                  <>
                    <UserPlus className="h-3.5 w-3.5 mr-1.5" />
                    Create Employee
                  </>
                )}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Discard Confirmation Modal */}
      <Dialog open={confirmDiscardOpen} onOpenChange={setConfirmDiscardOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2 text-rose-600 dark:text-rose-400">
              <AlertTriangle className="h-4 w-4" /> Discard Unsaved Employee Data?
            </DialogTitle>
          </DialogHeader>
          <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
            You have entered details for this new employee. If you leave now, all entered information will be discarded.
          </p>
          <DialogFooter className="gap-2 pt-2">
            <Button variant="outline" size="sm" onClick={() => setConfirmDiscardOpen(false)}>
              Keep Editing
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                setConfirmDiscardOpen(false)
                onOpenChange(false)
              }}
            >
              Discard & Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Post-Creation One-Time Credentials Modal */}
      {createdAccount && (
        <Dialog open onOpenChange={() => {}}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-base flex items-center gap-2 text-emerald-700 dark:text-emerald-400">
                <ShieldCheck className="h-5 w-5" /> Employee Created — Login Account Ready
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                {createdAccount.note}
              </p>
              <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 p-3.5 space-y-2 text-xs">
                <div className="flex justify-between items-center gap-3">
                  <span className="text-slate-500 font-medium">Login Email</span>
                  <span className="font-semibold text-slate-800 dark:text-slate-100">{createdAccount.email}</span>
                </div>
                <div className="flex justify-between items-center gap-3">
                  <span className="text-slate-500 font-medium">Temporary Password</span>
                  <code className="font-mono font-bold bg-white dark:bg-slate-900 border px-2 py-0.5 rounded select-all text-emerald-700 dark:text-emerald-300">
                    {createdAccount.tempPassword}
                  </code>
                </div>
                <div className="flex justify-between items-center gap-3 text-[11px] text-slate-400 pt-1 border-t border-slate-200 dark:border-slate-700">
                  <span>Delivery Status</span>
                  <span>Email: {createdAccount.emailStatus} · SMS: {createdAccount.smsStatus}</span>
                </div>
              </div>
            </div>
            <DialogFooter className="pt-2">
              <Button
                className="w-full bg-emerald-600 hover:bg-emerald-700 text-white"
                onClick={() => {
                  const id = createdAccount.employeeId
                  setCreatedAccount(null)
                  onOpenChange(false)
                  onCreated(id)
                }}
              >
                I&apos;ve Saved the Password — Open Profile
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}

// ---------------- Field Wrapper Helper ----------------
function CreateFormFieldWrapper({
  label,
  required,
  error,
  help,
  children,
}: {
  label: string
  required?: boolean
  error?: string
  help?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5 text-left">
      <div className="flex items-center justify-between gap-1">
        <Label className="text-xs font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-1">
          {label}
          {required && <span className="text-rose-500 font-bold">*</span>}
        </Label>
      </div>
      {children}
      {error ? (
        <p className="text-[11px] text-rose-600 dark:text-rose-400 font-medium flex items-center gap-1 mt-1">
          <AlertCircle className="h-3 w-3 shrink-0" />
          <span>{error}</span>
        </p>
      ) : help ? (
        <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 leading-tight">{help}</p>
      ) : null}
    </div>
  )
}
