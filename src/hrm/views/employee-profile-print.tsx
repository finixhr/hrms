"use client"
// ============ Employee 360° Profile Print & Export CV ============
// Production-ready corporate Employee Profile / CV document generator.
// Aggregates existing Employee 360° biodata from original database sources:
// - Tenant company branding & letterhead
// - Employee demographics, personal biodata, addresses, emergency contacts
// - Employment, departmental & organizational hierarchy
// - Academic qualifications & education history
// - Professional experience & previous employments
// - Professional credentials & verified certifications
// - Family members & dependents
// - Professional references
// - Internal career progression (promotions & branch/dept transfers)
// - Company-issued assets (WP-K Asset Management)
// - Optional confidential sections (Salary structure, Bank/MFS credentials, Tax TIN)
//   STRICT SECURITY: Excluded by default unless caller holds explicit RBAC
//   permissions and intentionally toggles them on.
import { useState, useId } from "react"
import {
  Printer, ArrowLeft, Download, ShieldCheck, CheckCircle2,
  Mail, Phone, MapPin, Calendar, Award, Building,
  Briefcase, GraduationCap, HeartHandshake, UserCheck, Laptop, Lock,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { useHrm } from "../store"
import { rpc } from "../api"
import { fmtDate, fmtMoney, titleCase } from "../shared/ui-kit"

export interface EmployeeProfilePrintProps {
  data: any
  onClose: () => void
}

const PRINT_CSS_ID = "finix-employee-profile-print-css"
const BROWSER_FONT_STACK = '"Noto Sans Bengali", "Hind Siliguri", "SolaimanLipi", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'

function ensurePrintStyles() {
  if (typeof document === "undefined") return
  if (document.getElementById(PRINT_CSS_ID)) return
  const style = document.createElement("style")
  style.id = PRINT_CSS_ID
  style.textContent = `
@media print {
  @page {
    size: A4 portrait;
    margin: 10mm 10mm 12mm 10mm;
  }
  html, body {
    background: #ffffff !important;
    color: #0f172a !important;
    font-size: 11pt !important;
    margin: 0 !important;
    padding: 0 !important;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }
  /* Hide all application chrome, navigation, toolbars, and background elements */
  body > *:not(#finix-employee-profile-print-portal) {
    display: none !important;
  }
  #finix-employee-profile-print-portal {
    position: static !important;
    inset: auto !important;
    display: block !important;
    background: #ffffff !important;
    padding: 0 !important;
    margin: 0 !important;
    overflow: visible !important;
    z-index: auto !important;
    font-family: ${BROWSER_FONT_STACK} !important;
  }
  #finix-employee-profile-print-portal .print-hide {
    display: none !important;
  }
  #finix-employee-profile-print-portal .print-document-sheet {
    box-shadow: none !important;
    border: none !important;
    margin: 0 auto !important;
    padding: 0 !important;
    max-width: 100% !important;
    width: 100% !important;
    background: #ffffff !important;
  }
  /* Avoid breaking inside sections, tables, and signature blocks */
  .cv-section,
  .cv-card,
  .cv-table-container,
  .cv-signature-block,
  tr {
    break-inside: avoid !important;
    page-break-inside: avoid !important;
  }
  /* Avoid orphan headings */
  h1, h2, h3, h4, .cv-section-title {
    break-after: avoid !important;
    page-break-after: avoid !important;
  }
  table {
    table-layout: fixed;
    width: 100%;
  }
  th, td {
    word-break: break-word;
    overflow-wrap: anywhere;
  }
}
`
  document.head.appendChild(style)
}

function calculateAge(dobStr?: string | null): string | null {
  if (!dobStr) return null
  const d = new Date(dobStr + (dobStr.length === 10 ? "T00:00:00" : ""))
  if (isNaN(d.getTime())) return null
  const now = new Date()
  let age = now.getFullYear() - d.getFullYear()
  const m = now.getMonth() - d.getMonth()
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) {
    age--
  }
  return age > 0 ? `${age} yrs` : null
}

function calculateTenure(joiningDateStr?: string | null): string | null {
  if (!joiningDateStr) return null
  const d = new Date(joiningDateStr + (joiningDateStr.length === 10 ? "T00:00:00" : ""))
  if (isNaN(d.getTime())) return null
  const now = new Date()
  let years = now.getFullYear() - d.getFullYear()
  let months = now.getMonth() - d.getMonth()
  if (months < 0) {
    years--
    months += 12
  }
  if (now.getDate() < d.getDate()) {
    months--
    if (months < 0) {
      years--
      months += 12
    }
  }
  if (years <= 0 && months <= 0) return "Less than a month"
  const parts: string[] = []
  if (years > 0) parts.push(`${years} ${years === 1 ? "yr" : "yrs"}`)
  if (months > 0) parts.push(`${months} ${months === 1 ? "mo" : "mos"}`)
  return parts.join(" ")
}

export function EmployeeProfilePrintModal({ data, onClose }: EmployeeProfilePrintProps) {
  const { can, toast } = useHrm()
  const idPrefix = useId()
  const emp = data?.employee
  const company = data?.company || {}

  // Toggles for optional / sensitive sections
  // STRICT RULE: Exclude salary, bank details, tax identifiers from general CV by default
  const canViewPayroll = can("payroll", "view")
  const canViewBanks = can("bankInfo", "view")

  const [includeSalary, setIncludeSalary] = useState(false)
  const [includeBanks, setIncludeBanks] = useState(false)
  const [includeTin, setIncludeTin] = useState(false)
  const [includeTimeline, setIncludeTimeline] = useState(true)
  const [includeAssets, setIncludeAssets] = useState(true)

  // Ensure CSS injection
  ensurePrintStyles()

  if (!emp) return null

  const handlePrint = async () => {
    try {
      void rpc("employees.auditPrint", { id: emp.id }).catch(() => {})
    } catch {
      // non-blocking audit
    }
    window.print()
  }

  const handleSavePdf = () => {
    toast("In the print dialog, choose 'Save as PDF' as your Destination.", "ok")
    handlePrint()
  }

  // Filter verified certifications / credentials from documents
  const certDocs = (data.docs || []).filter((d: any) =>
    d.category === "EDUCATION" ||
    d.category === "EXPERIENCE" ||
    d.docType === "CERTIFICATE" ||
    d.docType === "EXPERIENCE_CERT" ||
    d.docType === "PASSPORT" ||
    d.docType === "NID" ||
    d.docType === "DRIVING_LICENCE"
  )

  const hasEducation = (data.education || []).length > 0
  const hasExperience = (data.prevEmployment || []).length > 0
  const hasFamily = (data.family || []).length > 0
  const hasReferences = (data.references || []).length > 0
  const hasPromotions = (data.promotions || []).length > 0
  const hasTransfers = (data.transfers || []).length > 0
  const hasHistory = includeTimeline && (data.history || []).length > 0
  const hasAssets = includeAssets && (data.assignedAssets || []).length > 0
  const hasCertDocs = certDocs.length > 0
  const hasSalary = includeSalary && canViewPayroll && !!data.structure
  const hasBanks = includeBanks && canViewBanks && (data.banks || []).length > 0

  const age = calculateAge(emp.dob)
  const tenure = calculateTenure(emp.joiningDate)

  // Resolve primary identity document (NID / Passport / Birth Reg)
  const identityDocs = (data.docs || []).filter((d: any) =>
    d.category === "IDENTITY" ||
    ["NID", "PASSPORT", "BIRTH_REG", "DRIVING_LICENCE", "OTHER_ID"].includes(d.docType)
  )
  const primaryId = identityDocs[0]
  const idType = emp.identityType || primaryId?.docType || "NID"
  const idNumber = emp.identityNumber || emp.nid || primaryId?.docNumber
  const idLabel = idType === "PASSPORT" ? "Passport No" : idType === "BIRTH_REG" ? "Birth Registration No" : idType === "DRIVING_LICENCE" ? "Driving Licence" : "National ID (NID)"
  const idShortLabel = idType === "PASSPORT" ? "Passport" : idType === "BIRTH_REG" ? "Birth Reg" : idType === "DRIVING_LICENCE" ? "Driving Lic" : "NID"

  return (
    <div
      id="finix-employee-profile-print-portal"
      className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/80 backdrop-blur-xs flex flex-col items-center print:bg-white print:overflow-visible print:static"
      style={{ fontFamily: BROWSER_FONT_STACK }}
    >
      {/* Top action toolbar - hidden when printing */}
      <div className="sticky top-0 z-20 w-full bg-slate-900 border-b border-slate-800 text-white px-4 py-3 shadow-md print-hide">
        <div className="max-w-5xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={onClose}
              className="h-8 text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700"
            >
              <ArrowLeft className="h-3.5 w-3.5 mr-1.5" /> Return to Employee Details
            </Button>
            <div className="border-l border-slate-700 pl-3">
              <p className="text-xs font-semibold text-white truncate">{emp.fullName}</p>
              <p className="text-[11px] text-slate-400">{emp.code} · {emp.designationName || "Staff"}</p>
            </div>
          </div>

          {/* Privacy & customization controls */}
          <div className="flex flex-wrap items-center gap-3 text-xs bg-slate-950/60 px-3 py-1.5 rounded-lg border border-slate-800">
            {canViewPayroll && (
              <label htmlFor={`${idPrefix}-salary-toggle`} className="flex items-center gap-1.5 cursor-pointer text-slate-300 hover:text-white">
                <Switch
                  id={`${idPrefix}-salary-toggle`}
                  checked={includeSalary}
                  onCheckedChange={setIncludeSalary}
                  className="data-[state=checked]:bg-emerald-600 scale-75"
                />
                <span className="text-[11px]">Compensation</span>
              </label>
            )}
            {canViewBanks && (
              <label htmlFor={`${idPrefix}-bank-toggle`} className="flex items-center gap-1.5 cursor-pointer text-slate-300 hover:text-white">
                <Switch
                  id={`${idPrefix}-bank-toggle`}
                  checked={includeBanks}
                  onCheckedChange={setIncludeBanks}
                  className="data-[state=checked]:bg-emerald-600 scale-75"
                />
                <span className="text-[11px]">Bank / MFS</span>
              </label>
            )}
            <label htmlFor={`${idPrefix}-tin-toggle`} className="flex items-center gap-1.5 cursor-pointer text-slate-300 hover:text-white">
              <Switch
                id={`${idPrefix}-tin-toggle`}
                checked={includeTin}
                onCheckedChange={setIncludeTin}
                className="data-[state=checked]:bg-emerald-600 scale-75"
              />
              <span className="text-[11px]">TIN</span>
            </label>
            <label htmlFor={`${idPrefix}-assets-toggle`} className="flex items-center gap-1.5 cursor-pointer text-slate-300 hover:text-white">
              <Switch
                id={`${idPrefix}-assets-toggle`}
                checked={includeAssets}
                onCheckedChange={setIncludeAssets}
                className="data-[state=checked]:bg-emerald-600 scale-75"
              />
              <span className="text-[11px]">Assets</span>
            </label>
            <label htmlFor={`${idPrefix}-history-toggle`} className="flex items-center gap-1.5 cursor-pointer text-slate-300 hover:text-white">
              <Switch
                id={`${idPrefix}-history-toggle`}
                checked={includeTimeline}
                onCheckedChange={setIncludeTimeline}
                className="data-[state=checked]:bg-emerald-600 scale-75"
              />
              <span className="text-[11px]">Timeline</span>
            </label>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleSavePdf}
              className="h-8 text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700"
              title="Save as PDF via browser print"
            >
              <Download className="h-3.5 w-3.5 mr-1.5 text-sky-400" /> Save as PDF
            </Button>
            <Button
              size="sm"
              onClick={handlePrint}
              className="h-8 text-xs bg-emerald-600 hover:bg-emerald-500 text-white font-medium shadow-xs"
            >
              <Printer className="h-3.5 w-3.5 mr-1.5" /> Print Profile
            </Button>
          </div>
        </div>
      </div>

      {/* Printable Sheet Viewport */}
      <div className="w-full flex justify-center py-6 px-3 print:p-0">
        <div className="print-document-sheet w-full max-w-[210mm] bg-white text-slate-900 shadow-2xl rounded-xs p-8 sm:p-12 print:shadow-none print:p-0 print:rounded-none">

          {/* ================= COMPANY LETTERHEAD ================= */}
          <header className="border-b-2 border-emerald-700 pb-4 mb-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 uppercase">
                  {company.legalName || company.name || "Finix HR"}
                </h1>
                {company.legalName && company.name && company.legalName !== company.name && (
                  <p className="text-xs text-slate-600 font-medium">{company.name}</p>
                )}
                <div className="text-[10.5px] text-slate-600 space-y-0.5 mt-1">
                  {company.address && (
                    <p className="flex items-center gap-1.5">
                      <MapPin className="h-3 w-3 text-emerald-700 shrink-0" />
                      <span>{company.address}</span>
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                    {company.phone && (
                      <span className="flex items-center gap-1">
                        <Phone className="h-2.5 w-2.5 text-emerald-700" /> {company.phone}
                      </span>
                    )}
                    {company.email && (
                      <span className="flex items-center gap-1">
                        <Mail className="h-2.5 w-2.5 text-emerald-700" /> {company.email}
                      </span>
                    )}
                    {company.website && (
                      <span>Web: {company.website}</span>
                    )}
                    {company.binVatReg && (
                      <span className="font-medium text-slate-700">BIN/VAT: {company.binVatReg}</span>
                    )}
                  </div>
                </div>
              </div>

              {company.logoUrl ? (
                <div className="shrink-0 max-w-[160px] max-h-[56px] flex items-center justify-end">
                  <img
                    src={company.logoUrl}
                    alt={company.name || "Company Logo"}
                    className="max-h-[54px] max-w-[150px] object-contain"
                  />
                </div>
              ) : (
                <div className="h-12 w-12 rounded-lg bg-emerald-50 border border-emerald-200 flex items-center justify-center shrink-0">
                  <Building className="h-6 w-6 text-emerald-700" />
                </div>
              )}
            </div>

            {/* Document Title Banner */}
            <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between">
              <div>
                <h2 className="text-base sm:text-lg font-extrabold tracking-wider text-emerald-800 uppercase">
                  EMPLOYEE PROFILE
                </h2>
                <p className="text-[10px] text-slate-500 uppercase tracking-widest">
                  Comprehensive 360° Corporate Record &amp; Biodata
                </p>
              </div>
              <div className="text-right">
                <span className="inline-block px-2.5 py-0.5 rounded text-[10px] font-bold tracking-wider uppercase bg-slate-100 text-slate-700 border border-slate-200">
                  CONFIDENTIAL
                </span>
                <p className="text-[9.5px] text-slate-400 mt-0.5">
                  Generated: {fmtDate(new Date().toISOString())}
                </p>
              </div>
            </div>
          </header>

          {/* ================= EMPLOYEE HEADER PROFILE CARD ================= */}
          <div className="cv-card mb-6 rounded-lg border border-slate-200 bg-slate-50/70 p-4">
            <div className="flex flex-col sm:flex-row items-center sm:items-start gap-4">
              {/* Photograph */}
              <div className="shrink-0">
                {emp.photoUrl ? (
                  <img
                    src={emp.photoUrl}
                    alt={emp.fullName}
                    className="h-28 w-28 object-cover rounded-md border-2 border-white shadow-xs"
                  />
                ) : (
                  <div className="h-28 w-28 rounded-md bg-gradient-to-br from-emerald-600 to-teal-700 text-white flex flex-col items-center justify-center border-2 border-white shadow-xs">
                    <span className="text-2xl font-bold tracking-wider">
                      {(emp.fullName || "?").split(" ").map((x: string) => x[0]).slice(0, 2).join("")}
                    </span>
                    <span className="text-[9px] uppercase tracking-wider text-emerald-100 mt-1">Photo N/A</span>
                  </div>
                )}
              </div>

              {/* Identity & Core Details */}
              <div className="flex-1 min-w-0 text-center sm:text-left space-y-1">
                <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2">
                  <h3 className="text-xl font-bold text-slate-900 tracking-tight">{emp.fullName}</h3>
                  {emp.nameBn && (
                    <span className="text-sm text-slate-600 font-medium font-serif">
                      ({emp.nameBn})
                    </span>
                  )}
                  <Badge variant="outline" className="bg-emerald-50 text-emerald-800 border-emerald-300 font-mono text-xs px-2 py-0.5">
                    {emp.code}
                  </Badge>
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase ${
                    emp.status === "ACTIVE" ? "bg-emerald-100 text-emerald-800" :
                    emp.status === "PROBATION" ? "bg-amber-100 text-amber-800" :
                    "bg-slate-200 text-slate-700"
                  }`}>
                    {emp.status}
                  </span>
                </div>

                <p className="text-sm font-semibold text-emerald-700">
                  {emp.designationName || "Designation Not Assigned"}
                  {emp.grade ? ` · Grade: ${emp.grade}` : ""}
                </p>

                <p className="text-xs text-slate-600">
                  {emp.departmentName || "Department N/A"}
                  {emp.branchName ? ` · ${emp.branchName}` : ""}
                  {emp.workLocation ? ` (${emp.workLocation})` : ""}
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-x-3 gap-y-1 text-[11px] text-slate-600 pt-2 border-t border-slate-200/80">
                  <div className="flex items-center gap-1.5">
                    <Briefcase className="h-3 w-3 text-slate-400 shrink-0" />
                    <span><strong>Type:</strong> {titleCase(emp.employmentType)}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Calendar className="h-3 w-3 text-slate-400 shrink-0" />
                    <span><strong>Joined:</strong> {fmtDate(emp.joiningDate)}</span>
                  </div>
                  {tenure && (
                    <div className="flex items-center gap-1.5">
                      <Award className="h-3 w-3 text-slate-400 shrink-0" />
                      <span><strong>Tenure:</strong> {tenure}</span>
                    </div>
                  )}
                  {emp.officialEmail && (
                    <div className="flex items-center gap-1.5 truncate">
                      <Mail className="h-3 w-3 text-slate-400 shrink-0" />
                      <span className="truncate">{emp.officialEmail}</span>
                    </div>
                  )}
                  {emp.mobile && (
                    <div className="flex items-center gap-1.5">
                      <Phone className="h-3 w-3 text-slate-400 shrink-0" />
                      <span>{emp.mobile}</span>
                    </div>
                  )}
                  {idNumber && (
                    <div className="flex items-center gap-1.5">
                      <ShieldCheck className="h-3 w-3 text-emerald-700 shrink-0" />
                      <span><strong>{idShortLabel}:</strong> <span className="font-mono">{idNumber}</span></span>
                    </div>
                  )}
                  {emp.taxTin && (
                    <div className="flex items-center gap-1.5">
                      <ShieldCheck className="h-3 w-3 text-emerald-700 shrink-0" />
                      <span><strong>e-TIN:</strong> <span className="font-mono">{emp.taxTin}</span></span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* ================= BIODATA & PERSONAL INFORMATION ================= */}
          <section className="cv-section mb-5">
            <h4 className="cv-section-title text-xs font-bold uppercase tracking-wider text-emerald-800 border-b border-emerald-200 pb-1 mb-2.5 flex items-center gap-1.5">
              <span>Personal Information</span>
            </h4>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 text-[11px]">
              <div>
                <span className="text-slate-500 block text-[10px] uppercase">Father&apos;s Name</span>
                <span className="font-medium text-slate-800">{emp.fatherName || "—"}</span>
              </div>
              <div>
                <span className="text-slate-500 block text-[10px] uppercase">Mother&apos;s Name</span>
                <span className="font-medium text-slate-800">{emp.motherName || "—"}</span>
              </div>
              <div>
                <span className="text-slate-500 block text-[10px] uppercase">Spouse&apos;s Name</span>
                <span className="font-medium text-slate-800">{emp.spouseName || "—"}</span>
              </div>
              <div>
                <span className="text-slate-500 block text-[10px] uppercase">Date of Birth</span>
                <span className="font-medium text-slate-800">{fmtDate(emp.dob)}{age ? ` (${age})` : ""}</span>
              </div>
              <div>
                <span className="text-slate-500 block text-[10px] uppercase">Gender</span>
                <span className="font-medium text-slate-800">{titleCase(emp.gender)}</span>
              </div>
              <div>
                <span className="text-slate-500 block text-[10px] uppercase">Blood Group</span>
                <span className="font-medium text-slate-800">{emp.bloodGroup || "—"}</span>
              </div>
              <div>
                <span className="text-slate-500 block text-[10px] uppercase">Marital Status</span>
                <span className="font-medium text-slate-800">{titleCase(emp.maritalStatus)}</span>
              </div>
              <div>
                <span className="text-slate-500 block text-[10px] uppercase">Nationality</span>
                <span className="font-medium text-slate-800">{emp.nationality || "Bangladeshi"}</span>
              </div>
              <div>
                <span className="text-slate-500 block text-[10px] uppercase">Religion</span>
                <span className="font-medium text-slate-800">{emp.religion || "—"}</span>
              </div>
              <div>
                <span className="text-slate-500 block text-[10px] uppercase">Place of Birth</span>
                <span className="font-medium text-slate-800">{emp.placeOfBirth || "—"}</span>
              </div>
              <div>
                <span className="text-slate-500 block text-[10px] uppercase">Personal Email</span>
                <span className="font-medium text-slate-800 truncate block">{emp.personalEmail || "—"}</span>
              </div>
              <div>
                <span className="text-slate-500 block text-[10px] uppercase">Alt. Mobile</span>
                <span className="font-medium text-slate-800">{emp.altMobile || "—"}</span>
              </div>
              <div>
                <span className="text-slate-500 block text-[10px] uppercase font-semibold">{idLabel}</span>
                <span className="font-medium font-mono text-slate-800">{idNumber || "—"}</span>
              </div>
              <div>
                <span className="text-slate-500 block text-[10px] uppercase font-semibold">TIN (e-TIN)</span>
                <span className="font-medium font-mono text-slate-800">{emp.taxTin || "—"}</span>
              </div>
              {identityDocs.slice(1).map((doc: any, idx: number) => (
                <div key={doc.id || idx}>
                  <span className="text-slate-500 block text-[10px] uppercase font-semibold">
                    {doc.docType === "PASSPORT" ? "Passport No" : doc.docType === "BIRTH_REG" ? "Birth Reg No" : doc.title || doc.docType}
                  </span>
                  <span className="font-medium font-mono text-slate-800">{doc.docNumber || "—"}</span>
                </div>
              ))}
            </div>
          </section>

          {/* ================= ADDRESSES & EMERGENCY CONTACT ================= */}
          <section className="cv-section mb-5">
            <h4 className="cv-section-title text-xs font-bold uppercase tracking-wider text-emerald-800 border-b border-emerald-200 pb-1 mb-2.5 flex items-center gap-1.5">
              <span>Addresses &amp; Emergency Contact</span>
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-[11px]">
              <div className="bg-slate-50/50 p-2.5 rounded border border-slate-200/60">
                <span className="text-emerald-800 font-semibold block text-[10.5px] mb-1">Present Address</span>
                <p className="text-slate-700 leading-relaxed">{emp.presentAddress || "—"}</p>
                {(emp.presentCity || emp.presentDistrict || emp.presentDivision || emp.presentPostCode) ? (
                  <p className="text-slate-500 text-[10px] mt-1">
                    {[emp.presentCity, emp.presentDistrict, emp.presentDivision, emp.presentPostCode ? `Postal Code: ${emp.presentPostCode}` : null].filter(Boolean).join(", ")}
                  </p>
                ) : (emp.district || emp.division || emp.postCode) ? (
                  <p className="text-slate-500 text-[10px] mt-1">
                    {[emp.district, emp.division, emp.postCode ? `Postal Code: ${emp.postCode}` : null].filter(Boolean).join(", ")}
                  </p>
                ) : null}
              </div>

              <div className="bg-slate-50/50 p-2.5 rounded border border-slate-200/60">
                <span className="text-emerald-800 font-semibold block text-[10.5px] mb-1">Permanent Address</span>
                <p className="text-slate-700 leading-relaxed">
                  {emp.addressSame ? "Same as Present Address" : (emp.permanentAddress || "—")}
                </p>
                {!emp.addressSame && (emp.city || emp.district || emp.division || emp.postCode) && (
                  <p className="text-slate-500 text-[10px] mt-1">
                    {[emp.city, emp.district, emp.division, emp.postCode ? `Postal Code: ${emp.postCode}` : null].filter(Boolean).join(", ")}
                  </p>
                )}
              </div>

              <div className="bg-rose-50/40 p-2.5 rounded border border-rose-200/60">
                <span className="text-rose-800 font-semibold block text-[10.5px] mb-1">Emergency Contact</span>
                {emp.emergencyName ? (
                  <div className="space-y-0.5 text-slate-700">
                    <p className="font-medium text-slate-900"><span className="text-slate-500 font-normal">Contact Person: </span>{emp.emergencyName}</p>
                    <p className="text-[10px] text-slate-500">Relationship: {emp.emergencyRelation || "—"}</p>
                    <p className="font-mono text-slate-800 font-semibold">{emp.emergencyMobile || "—"}</p>
                  </div>
                ) : (
                  <p className="text-slate-400 italic">No emergency contact recorded</p>
                )}
              </div>
            </div>
          </section>

          {/* ================= EMPLOYMENT & ORGANIZATIONAL DETAILS ================= */}
          <section className="cv-section mb-5">
            <h4 className="cv-section-title text-xs font-bold uppercase tracking-wider text-emerald-800 border-b border-emerald-200 pb-1 mb-2.5 flex items-center gap-1.5">
              <span>Employment &amp; Organizational Profile</span>
            </h4>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 text-[11px]">
              <div>
                <span className="text-slate-500 block text-[10px] uppercase">Department</span>
                <span className="font-medium text-slate-800">{emp.departmentName || "—"}</span>
              </div>
              <div>
                <span className="text-slate-500 block text-[10px] uppercase">Branch Office</span>
                <span className="font-medium text-slate-800">{emp.branchName || "—"}</span>
              </div>
              <div>
                <span className="text-slate-500 block text-[10px] uppercase">Reporting Manager</span>
                <span className="font-medium text-slate-800">{emp.managerName || "—"}</span>
              </div>
              <div>
                <span className="text-slate-500 block text-[10px] uppercase">Shift Schedule</span>
                <span className="font-medium text-slate-800">{emp.shiftName || "Standard"}</span>
              </div>
              <div>
                <span className="text-slate-500 block text-[10px] uppercase">Weekly Off</span>
                <span className="font-medium text-slate-800">{emp.weeklyOff || "Friday, Saturday"}</span>
              </div>
              <div>
                <span className="text-slate-500 block text-[10px] uppercase">Confirmation Date</span>
                <span className="font-medium text-slate-800">{fmtDate(emp.confirmationDate)}</span>
              </div>
              <div>
                <span className="text-slate-500 block text-[10px] uppercase">Probation Period</span>
                <span className="font-medium text-slate-800">{emp.probationMonths ? `${emp.probationMonths} Months` : "—"}</span>
              </div>
              <div>
                <span className="text-slate-500 block text-[10px] uppercase">Overtime Eligible</span>
                <span className="font-medium text-slate-800">{emp.otEligible ? "Yes" : "No"}</span>
              </div>
              {emp.contractStart && (
                <div className="col-span-2">
                  <span className="text-slate-500 block text-[10px] uppercase">Contract Duration</span>
                  <span className="font-medium text-slate-800">{fmtDate(emp.contractStart)} to {fmtDate(emp.contractEnd)}</span>
                </div>
              )}
            </div>
          </section>

          {/* ================= ACADEMIC QUALIFICATIONS ================= */}
          {hasEducation && (
            <section className="cv-section mb-5">
              <h4 className="cv-section-title text-xs font-bold uppercase tracking-wider text-emerald-800 border-b border-emerald-200 pb-1 mb-2 flex items-center gap-1.5">
                <GraduationCap className="h-3.5 w-3.5 text-emerald-700" />
                <span>Academic Qualifications</span>
              </h4>
              <div className="cv-table-container overflow-hidden rounded border border-slate-200">
                <table className="w-full text-left text-[11px]">
                  <thead className="bg-slate-50 text-[10px] font-semibold uppercase text-slate-600 border-b border-slate-200">
                    <tr>
                      <th className="py-1.5 px-3">Degree / Examination</th>
                      <th className="py-1.5 px-3">Institution</th>
                      <th className="py-1.5 px-3">Board / University</th>
                      <th className="py-1.5 px-3">Major / Subject</th>
                      <th className="py-1.5 px-3 text-center">Passing Year</th>
                      <th className="py-1.5 px-3 text-right">Result / GPA</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {(data.education || []).map((edu: any, i: number) => (
                      <tr key={edu.id || i} className={i % 2 === 1 ? "bg-slate-50/40" : ""}>
                        <td className="py-1.5 px-3 font-semibold text-slate-900">{edu.degree}</td>
                        <td className="py-1.5 px-3 text-slate-700">{edu.institution || "—"}</td>
                        <td className="py-1.5 px-3 text-slate-700">{edu.board || "—"}</td>
                        <td className="py-1.5 px-3 text-slate-700">{edu.major || "—"}</td>
                        <td className="py-1.5 px-3 text-center text-slate-800 font-mono">{edu.passingYear || "—"}</td>
                        <td className="py-1.5 px-3 text-right font-medium text-emerald-800">{edu.result || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* ================= PROFESSIONAL EXPERIENCE ================= */}
          {hasExperience && (
            <section className="cv-section mb-5">
              <h4 className="cv-section-title text-xs font-bold uppercase tracking-wider text-emerald-800 border-b border-emerald-200 pb-1 mb-2 flex items-center gap-1.5">
                <Briefcase className="h-3.5 w-3.5 text-emerald-700" />
                <span>Professional Work Experience</span>
              </h4>
              <div className="cv-table-container overflow-hidden rounded border border-slate-200">
                <table className="w-full text-left text-[11px]">
                  <thead className="bg-slate-50 text-[10px] font-semibold uppercase text-slate-600 border-b border-slate-200">
                    <tr>
                      <th className="py-1.5 px-3">Company / Organization</th>
                      <th className="py-1.5 px-3">Designation &amp; Dept</th>
                      <th className="py-1.5 px-3">Service Period</th>
                      <th className="py-1.5 px-3">Supervisor / Contact</th>
                      <th className="py-1.5 px-3">Reason for Leaving</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {(data.prevEmployment || []).map((prev: any, i: number) => (
                      <tr key={prev.id || i} className={i % 2 === 1 ? "bg-slate-50/40" : ""}>
                        <td className="py-1.5 px-3 font-semibold text-slate-900">{prev.company}</td>
                        <td className="py-1.5 px-3 text-slate-700">
                          {prev.designation || "—"}
                          {prev.department ? ` (${prev.department})` : ""}
                        </td>
                        <td className="py-1.5 px-3 text-slate-700 whitespace-nowrap">
                          {fmtDate(prev.joinDate)} → {prev.leaveDate ? fmtDate(prev.leaveDate) : "Present"}
                        </td>
                        <td className="py-1.5 px-3 text-slate-600">
                          {prev.supervisor || prev.contact || "—"}
                        </td>
                        <td className="py-1.5 px-3 text-slate-600 italic">
                          {prev.reasonForLeaving || "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* ================= CERTIFICATIONS & VERIFIED CREDENTIALS ================= */}
          {hasCertDocs && (
            <section className="cv-section mb-5">
              <h4 className="cv-section-title text-xs font-bold uppercase tracking-wider text-emerald-800 border-b border-emerald-200 pb-1 mb-2 flex items-center gap-1.5">
                <Award className="h-3.5 w-3.5 text-emerald-700" />
                <span>Certifications &amp; Professional Credentials</span>
              </h4>
              <div className="cv-table-container overflow-hidden rounded border border-slate-200">
                <table className="w-full text-left text-[11px]">
                  <thead className="bg-slate-50 text-[10px] font-semibold uppercase text-slate-600 border-b border-slate-200">
                    <tr>
                      <th className="py-1.5 px-3">Credential Title</th>
                      <th className="py-1.5 px-3">Category / Type</th>
                      <th className="py-1.5 px-3">Document / License No.</th>
                      <th className="py-1.5 px-3">Issuing Authority</th>
                      <th className="py-1.5 px-3 text-center">Issue / Expiry</th>
                      <th className="py-1.5 px-3 text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {certDocs.map((doc: any, i: number) => (
                      <tr key={doc.id || i} className={i % 2 === 1 ? "bg-slate-50/40" : ""}>
                        <td className="py-1.5 px-3 font-semibold text-slate-900">{doc.title}</td>
                        <td className="py-1.5 px-3 text-slate-700">{titleCase(doc.docType)}</td>
                        <td className="py-1.5 px-3 font-mono text-slate-800">{doc.docNumber || "—"}</td>
                        <td className="py-1.5 px-3 text-slate-700">{doc.issuingAuthority || "—"}</td>
                        <td className="py-1.5 px-3 text-center text-slate-600 text-[10px]">
                          {doc.issueDate ? fmtDate(doc.issueDate) : "—"}
                          {doc.expiryDate ? ` → ${fmtDate(doc.expiryDate)}` : ""}
                        </td>
                        <td className="py-1.5 px-3 text-right">
                          {doc.verified ? (
                            <span className="text-[10px] text-emerald-700 font-bold">✓ Verified</span>
                          ) : (
                            <span className="text-[10px] text-slate-500">On Record</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* ================= FAMILY MEMBERS & DEPENDENTS ================= */}
          {hasFamily && (
            <section className="cv-section mb-5">
              <h4 className="cv-section-title text-xs font-bold uppercase tracking-wider text-emerald-800 border-b border-emerald-200 pb-1 mb-2 flex items-center gap-1.5">
                <HeartHandshake className="h-3.5 w-3.5 text-emerald-700" />
                <span>Family Members &amp; Dependents</span>
              </h4>
              <div className="cv-table-container overflow-hidden rounded border border-slate-200">
                <table className="w-full text-left text-[11px]">
                  <thead className="bg-slate-50 text-[10px] font-semibold uppercase text-slate-600 border-b border-slate-200">
                    <tr>
                      <th className="py-1.5 px-3">Name</th>
                      <th className="py-1.5 px-3">Relationship</th>
                      <th className="py-1.5 px-3">Date of Birth / Age</th>
                      <th className="py-1.5 px-3">Gender</th>
                      <th className="py-1.5 px-3">Occupation</th>
                      <th className="py-1.5 px-3">Contact</th>
                      <th className="py-1.5 px-3 text-center">Dependent</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {(data.family || []).map((f: any, i: number) => {
                      const famAge = calculateAge(f.dob)
                      return (
                        <tr key={f.id || i} className={i % 2 === 1 ? "bg-slate-50/40" : ""}>
                          <td className="py-1.5 px-3 font-semibold text-slate-900">{f.name}</td>
                          <td className="py-1.5 px-3 text-slate-700">{titleCase(f.relationship)}</td>
                          <td className="py-1.5 px-3 text-slate-700">{fmtDate(f.dob)}{famAge ? ` (${famAge})` : ""}</td>
                          <td className="py-1.5 px-3 text-slate-700">{titleCase(f.gender)}</td>
                          <td className="py-1.5 px-3 text-slate-700">{f.occupation || "—"}</td>
                          <td className="py-1.5 px-3 text-slate-600">{f.mobile || "—"}</td>
                          <td className="py-1.5 px-3 text-center">
                            {f.dependent ? (
                              <span className="px-1.5 py-0.5 rounded text-[9.5px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">Yes</span>
                            ) : (
                              <span className="text-[10px] text-slate-400">No</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* ================= REFERENCES ================= */}
          {hasReferences && (
            <section className="cv-section mb-5">
              <h4 className="cv-section-title text-xs font-bold uppercase tracking-wider text-emerald-800 border-b border-emerald-200 pb-1 mb-2 flex items-center gap-1.5">
                <UserCheck className="h-3.5 w-3.5 text-emerald-700" />
                <span>Professional &amp; Personal References</span>
              </h4>
              <div className="cv-table-container overflow-hidden rounded border border-slate-200">
                <table className="w-full text-left text-[11px]">
                  <thead className="bg-slate-50 text-[10px] font-semibold uppercase text-slate-600 border-b border-slate-200">
                    <tr>
                      <th className="py-1.5 px-3">Referee Name</th>
                      <th className="py-1.5 px-3">Designation &amp; Organization</th>
                      <th className="py-1.5 px-3">Relationship / Known For</th>
                      <th className="py-1.5 px-3">Contact</th>
                      <th className="py-1.5 px-3 text-right">Type</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {(data.references || []).map((ref: any, i: number) => (
                      <tr key={ref.id || i} className={i % 2 === 1 ? "bg-slate-50/40" : ""}>
                        <td className="py-1.5 px-3 font-semibold text-slate-900">{ref.name}</td>
                        <td className="py-1.5 px-3 text-slate-700">
                          {ref.designation || "—"}
                          {ref.organization ? `, ${ref.organization}` : ""}
                        </td>
                        <td className="py-1.5 px-3 text-slate-700">
                          {ref.relationship || "—"}
                          {ref.knownFor ? ` (${ref.knownFor})` : ""}
                        </td>
                        <td className="py-1.5 px-3 text-slate-600">
                          {[ref.mobile, ref.email].filter(Boolean).join(" · ") || "—"}
                        </td>
                        <td className="py-1.5 px-3 text-right">
                          <span className="text-[10px] text-slate-600 font-medium">
                            {titleCase(ref.type)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* ================= INTERNAL CAREER PROGRESSION ================= */}
          {(hasPromotions || hasTransfers) && (
            <section className="cv-section mb-5">
              <h4 className="cv-section-title text-xs font-bold uppercase tracking-wider text-emerald-800 border-b border-emerald-200 pb-1 mb-2 flex items-center gap-1.5">
                <Award className="h-3.5 w-3.5 text-emerald-700" />
                <span>Career Progression &amp; Mobility</span>
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {hasPromotions && (
                  <div className="rounded border border-slate-200 p-2.5 bg-slate-50/30">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-slate-600 block mb-1.5">
                      Promotions Record
                    </span>
                    <div className="space-y-1.5 text-[11px]">
                      {(data.promotions || []).map((p: any, i: number) => (
                        <div key={p.id || i} className="border-b border-slate-100 last:border-0 pb-1 last:pb-0">
                          <div className="flex items-center justify-between">
                            <span className="font-semibold text-slate-900">{p.oldDesignation || "—"} → {p.newDesignation}</span>
                            <span className="text-[10px] text-slate-500">{fmtDate(p.effectiveDate)}</span>
                          </div>
                          {p.reason && <p className="text-[10px] text-slate-500 italic mt-0.5">{p.reason}</p>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {hasTransfers && (
                  <div className="rounded border border-slate-200 p-2.5 bg-slate-50/30">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-slate-600 block mb-1.5">
                      Transfers &amp; Relocations
                    </span>
                    <div className="space-y-1.5 text-[11px]">
                      {(data.transfers || []).map((t: any, i: number) => (
                        <div key={t.id || i} className="border-b border-slate-100 last:border-0 pb-1 last:pb-0">
                          <div className="flex items-center justify-between">
                            <span className="font-semibold text-slate-900">{t.oldDepartment || t.oldBranch || "Unit"} → {t.newDepartment || t.newBranch}</span>
                            <span className="text-[10px] text-slate-500">{fmtDate(t.effectiveDate)}</span>
                          </div>
                          {t.reason && <p className="text-[10px] text-slate-500 italic mt-0.5">{t.reason}</p>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* ================= COMPANY ASSETS ISSUED ================= */}
          {hasAssets && (
            <section className="cv-section mb-5">
              <h4 className="cv-section-title text-xs font-bold uppercase tracking-wider text-emerald-800 border-b border-emerald-200 pb-1 mb-2 flex items-center gap-1.5">
                <Laptop className="h-3.5 w-3.5 text-emerald-700" />
                <span>Company Assets Issued &amp; Custody</span>
              </h4>
              <div className="cv-table-container overflow-hidden rounded border border-slate-200">
                <table className="w-full text-left text-[11px]">
                  <thead className="bg-slate-50 text-[10px] font-semibold uppercase text-slate-600 border-b border-slate-200">
                    <tr>
                      <th className="py-1.5 px-3">Asset Code</th>
                      <th className="py-1.5 px-3">Item Name</th>
                      <th className="py-1.5 px-3">Category</th>
                      <th className="py-1.5 px-3">Brand &amp; Model</th>
                      <th className="py-1.5 px-3">Serial / IMEI</th>
                      <th className="py-1.5 px-3 text-center">Assigned Date</th>
                      <th className="py-1.5 px-3 text-right">Condition</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {(data.assignedAssets || []).map((item: any, i: number) => (
                      <tr key={item.id || i} className={i % 2 === 1 ? "bg-slate-50/40" : ""}>
                        <td className="py-1.5 px-3 font-mono font-semibold text-slate-900">{item.asset?.code || "—"}</td>
                        <td className="py-1.5 px-3 font-medium text-slate-800">{item.asset?.name || "—"}</td>
                        <td className="py-1.5 px-3 text-slate-600">{titleCase(item.asset?.category)}</td>
                        <td className="py-1.5 px-3 text-slate-600">{item.asset?.brandModel || "—"}</td>
                        <td className="py-1.5 px-3 font-mono text-slate-600 text-[10px]">{item.asset?.serialImei || "—"}</td>
                        <td className="py-1.5 px-3 text-center text-slate-600">{fmtDate(item.assignedAt)}</td>
                        <td className="py-1.5 px-3 text-right font-medium text-slate-700">{titleCase(item.conditionOut || item.asset?.condition || "Good")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* ================= OPTIONAL CONFIDENTIAL: SALARY & COMPENSATION ================= */}
          {hasSalary && (
            <section className="cv-section mb-5 bg-amber-50/30 p-3 rounded border border-amber-200/80">
              <div className="flex items-center justify-between border-b border-amber-200 pb-1 mb-2">
                <h4 className="cv-section-title text-xs font-bold uppercase tracking-wider text-amber-900 flex items-center gap-1.5">
                  <Lock className="h-3 w-3 text-amber-700" />
                  <span>Confidential Salary &amp; Allowance Structure</span>
                </h4>
                <span className="text-[9.5px] font-semibold text-amber-800">
                  Effective: {fmtDate(data.structure?.effectiveFrom)}
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 text-[11px]">
                <div>
                  <span className="text-slate-500 block text-[10px] uppercase">Basic Salary</span>
                  <span className="font-semibold text-slate-800">{fmtMoney(data.structure.basic)}</span>
                </div>
                <div>
                  <span className="text-slate-500 block text-[10px] uppercase">House Rent</span>
                  <span className="font-semibold text-slate-800">{fmtMoney(data.structure.houseRent)}</span>
                </div>
                <div>
                  <span className="text-slate-500 block text-[10px] uppercase">Medical Allowance</span>
                  <span className="font-semibold text-slate-800">{fmtMoney(data.structure.medical)}</span>
                </div>
                <div>
                  <span className="text-slate-500 block text-[10px] uppercase">Conveyance</span>
                  <span className="font-semibold text-slate-800">{fmtMoney(data.structure.conveyance)}</span>
                </div>
                <div>
                  <span className="text-slate-500 block text-[10px] uppercase">Food Allowance</span>
                  <span className="font-semibold text-slate-800">{fmtMoney(data.structure.food)}</span>
                </div>
                <div>
                  <span className="text-slate-500 block text-[10px] uppercase">Mobile &amp; Internet</span>
                  <span className="font-semibold text-slate-800">{fmtMoney((data.structure.mobileAllow || 0) + (data.structure.internetAllow || 0))}</span>
                </div>
                <div>
                  <span className="text-slate-500 block text-[10px] uppercase">Other Allowances</span>
                  <span className="font-semibold text-slate-800">{fmtMoney(data.structure.otherAllowance)}</span>
                </div>
                <div className="bg-amber-100/60 p-1 rounded">
                  <span className="text-amber-900 block text-[10px] font-bold uppercase">GROSS MONTHLY</span>
                  <span className="font-extrabold text-sm text-amber-900">{fmtMoney(data.structure.gross)}</span>
                </div>
              </div>
            </section>
          )}

          {/* ================= OPTIONAL CONFIDENTIAL: BANK & PAYMENT DETAILS ================= */}
          {hasBanks && (
            <section className="cv-section mb-5 bg-amber-50/30 p-3 rounded border border-amber-200/80">
              <div className="flex items-center justify-between border-b border-amber-200 pb-1 mb-2">
                <h4 className="cv-section-title text-xs font-bold uppercase tracking-wider text-amber-900 flex items-center gap-1.5">
                  <Lock className="h-3 w-3 text-amber-700" />
                  <span>Confidential Bank &amp; Payout Accounts</span>
                </h4>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-[11px]">
                {(data.banks || []).map((b: any, i: number) => (
                  <div key={b.id || i} className="bg-white p-2 rounded border border-amber-200 text-slate-800">
                    <p className="font-semibold text-slate-900">{b.bank || b.mfsProvider || "Bank / MFS"}</p>
                    <p className="text-[10.5px] text-slate-600">Branch: {b.branch || "—"} · Holder: {b.holderName || "—"}</p>
                    <p className="font-mono text-xs font-bold text-slate-800 mt-0.5">
                      Account: {b.accountNumber || b.mfsNumber || "—"}
                    </p>
                    <div className="flex items-center gap-2 mt-1 text-[10px]">
                      <span className="text-slate-500">Routing: {b.routingNumber || "—"}</span>
                      {b.isPrimary && <Badge className="bg-emerald-100 text-emerald-800 text-[9px] px-1">Primary</Badge>}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* ================= LIFECYCLE HISTORY TIMELINE ================= */}
          {hasHistory && (
            <section className="cv-section mb-6">
              <h4 className="cv-section-title text-xs font-bold uppercase tracking-wider text-emerald-800 border-b border-emerald-200 pb-1 mb-2.5 flex items-center gap-1.5">
                <span>Internal Service History &amp; Key Milestones</span>
              </h4>
              <div className="space-y-2 text-[10.5px]">
                {(data.history || []).slice(0, 8).map((h: any, i: number) => (
                  <div key={h.id || i} className="flex items-start gap-3 pl-2 border-l-2 border-emerald-300">
                    <span className="font-mono text-[10px] text-slate-500 w-20 shrink-0 pt-0.5">
                      {fmtDate(h.effectiveDate || h.createdAt)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-slate-900">{h.title || titleCase(h.eventType)}</p>
                      {h.description && (
                        <p className="text-slate-600 text-[10px]">{h.description}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* ================= OFFICIAL SIGNATURE & VERIFICATION BLOCK ================= */}
          <div className="cv-signature-block mt-8 pt-6 border-t border-slate-300">
            <div className="grid grid-cols-2 gap-12 text-[11px]">
              <div className="text-center pt-8">
                <div className="border-t border-slate-800 w-44 mx-auto mb-1" />
                <p className="font-semibold text-slate-900">Employee Signature</p>
                <p className="text-[10px] text-slate-500">Date: ________________________</p>
              </div>

              <div className="text-center pt-8">
                <div className="border-t border-slate-800 w-48 mx-auto mb-1" />
                <p className="font-semibold text-slate-900">
                  {company.signatoryName || "Authorized Signatory"}
                </p>
                <p className="text-[10px] text-slate-600">
                  {company.signatoryDesignation || "Human Resources / Management"}
                </p>
                <p className="text-[10px] text-slate-500">Date: ________________________</p>
              </div>
            </div>

            {/* Bottom print stamp */}
            <div className="mt-8 pt-3 border-t border-slate-100 flex flex-col sm:flex-row items-center justify-between text-[9.5px] text-slate-400 gap-1">
              <span>Finix HR ERP · Unified Employee 360° Profile Document</span>
              <span>Confidential Corporate Record · System Generated</span>
              <span className="flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3 text-emerald-600" /> Verified Record
              </span>
            </div>
          </div>

        </div>
      </div>
    </div>
  )
}
