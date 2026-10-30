// ============ Vendor HR Settings with typed defaults (spec §4.1) ============
import { db } from "@/lib/db"
import { j } from "./utils"
import { validateOutboundUrl } from "./security"
import { encryptField, decryptField, fieldKeyConfigured } from "./crypto-field"

// K-7/Phase-3 — settings cache: getSettings was re-reading and re-parsing the
// whole settings tree on EVERY request (3-5 RPC setup queries each). A short
// TTL cache with write-through invalidation keeps every vendor's settings hot
// while preserving read-your-writes for the saving user.
const SETTINGS_TTL_MS = 15_000
type CacheEntry = { settings: HrSettings; at: number }
// SCL-17 (Phase 2 WS5) — bounded settings cache: entries evict stale-first
// then oldest-inserted past the cap, so a 100K-tenant fleet cannot grow the
// map without limit (15 s TTL means at most one miss per vendor per window).
const SETTINGS_CACHE_MAX = 10_000
const settingsCache = new Map<string, CacheEntry>()

function invalidateSettings(vendorId: string) {
  settingsCache.delete(vendorId)
}

function capSettingsCache(): void {
  if (settingsCache.size < SETTINGS_CACHE_MAX) return
  const now = Date.now()
  for (const [k, v] of settingsCache) {
    if (now - v.at >= SETTINGS_TTL_MS) settingsCache.delete(k)
    if (settingsCache.size <= SETTINGS_CACHE_MAX / 2) return
  }
  while (settingsCache.size >= SETTINGS_CACHE_MAX) {
    const first = settingsCache.keys().next().value
    if (first == null) return
    settingsCache.delete(first)
  }
}

// ---------- M-36 — SMTP/SMS secrets encrypted at rest ----------
// Audit M-36: email.password and sms.apiKey/apiSecret sat in cleartext
// HrSetting rows (write-only toward the API, but readable in a DB dump) —
// inconsistent with the AES-256-GCM camera-credential scheme. They are now
// stored as "enc::<iv.tag.enc>" under HRM_MFA_KEY, context comms::v1.
// Legacy plaintext rows keep reading until the one-shot rotation script
// (scripts/encrypt-secrets-at-rest.ts) re-wraps them.
const COMMS_CONTEXT = "comms::v1"
const COMMS_ENC_PREFIX = "enc::"

function wrapCommsSecret(v: string): string {
  return COMMS_ENC_PREFIX + encryptField(v, COMMS_CONTEXT)
}

function unwrapCommsSecret(v: unknown): unknown {
  if (typeof v !== "string" || !v.startsWith(COMMS_ENC_PREFIX)) return v // legacy plaintext / non-secret
  try {
    return decryptField(v.slice(COMMS_ENC_PREFIX.length), COMMS_CONTEXT)
  } catch {
    // wrong/rotated HRM_MFA_KEY — treat as unset so send paths skip cleanly
    // instead of leaking a ciphertext into an SMTP AUTH attempt
    return ""
  }
}

export type HrSettings = {
  general: {
    companyName: string
    legalName: string
    address: string
    phone: string
    email: string
    website: string
    binVatReg: string
    logoUrl: string // data URL (client-resized) or http URL
    weeklyHoliday: string[] // weekday names
    workingHoursPerDay: number
    fiscalYearStart: string // "July"
    dateFormat: string
    // authorized letter signatory (spec §13.5) — mirrored onto the Vendor record
    signatoryName: string
    signatoryDesignation: string
    signatureUrl: string // data URL of the signature image
    sealUrl: string // data URL of the company seal / round stamp
  }
  attendance: {
    allowManualMarking: boolean
    requireCheckOut: boolean
    lateDeductionPerMinute: number // taka
    lateDeductionPerInstance: number
    halfDayHours: number
    absenceDeduction: boolean // deduct day salary for absent
    repeatedLateAlertDays: number
    longAbsenceAlertDays: number
    // ATT-305 (R3-4) — attendance period lock: manual marks, corrections and
    // bulk marks older than this many days are refused (0 = no lock). Edits
    // inside a period whose payroll run is already PAID are refused outright
    // unless the caller holds attendance.process and passes overridePaidLock.
    lockAfterDays: number
    // ATT-306 (R3-4) — compensatory leave accrual for weekly-off/holiday OT.
    // When enabled, approving OT on a non-working day credits the employee's
    // COMP_OFF leave balance at hoursPerDay hours per comp day (half-day
    // granularity, no accrual below half a day).
    compOffEnabled: boolean
    compOffHoursPerDay: number
  }
  geofence: {
    enabled: boolean
    defaultRadiusM: number
    requirePhoto: boolean
  }
  leave: {
    allowBackdated: boolean
    maxBackdateDays: number
    requireSubstitute: boolean
    substituteAcceptanceRequired: boolean
    probationMaxDays: number
    encashmentOnExit: boolean
    optionalHolidayLimit: number // A8 — max optional holidays per employee per year (0 = none)
    /** L-9 — when true (default, historical behavior) public/company holidays
     *  inside a leave span consume leave balance; when false they are skipped
     *  (the holiday is already a non-working day). Optional holidays are NEVER
     *  skipped — they are employee-elected, not company-wide days off. */
    countHolidaysAsLeave: boolean
    /** LVE-112 (R7) — pending-leave SLA: requests resting longer than this
     *  many days trigger a daily HR + employee nudge (0 = off). */
    approvalSlaDays: number
    /** LVE-112 (R7) — auto-cancel mode: pending leave requests older than
     *  this many days are cancelled by the daily sweep, releasing their
     *  reserved balance (0 = off). */
    autoCancelPendingDays: number
  }
  payroll: {
    frequency: "MONTHLY" | "WEEKLY"
    cutoffDay: number
    processingDay: number
    paymentDay: number
    absenceProration: boolean
    attendanceBonusFullMonth: boolean
    loanDeductionEnabled: boolean
    advanceDeductionEnabled: boolean
    // 2026-10-14 — Loan & Advance recovery control (Payroll → Loan & Advance
    // Control). When the borrower has no payable salary in a period (absent
    // the whole period / off the payroll), move the installment to the
    // GUARANTOR's salary, capped at loanGuarantorMaxPct% of the guarantor's
    // net pay for that period (cumulative across every loan they guarantee).
    loanGuarantorFallback: boolean
    loanGuarantorMaxPct: number // 1–100, % of the guarantor's net pay
    // ADV-001/PAY-009 (R3-4) — minimum take-home floor: the borrower's OWN
    // loan + advance recovery can never exceed this % of their pre-recovery
    // net for the period; the excess is deferred (loan arrears budgeting picks
    // it up next run, advances simply run longer). 0 = disabled (historical
    // clamp-to-zero behaviour — NOT recommended).
    recoveryMaxPctOfNet: number
    // LOA-001 (R3-4) — arrears budgeting: when a payroll run budgets a loan
    // installment it also picks up unpaid installments DUE ON OR BEFORE the
    // period end, up to this many EXTRA installments beyond the current one
    // (0 = current-month only, the historical behaviour).
    loanArrearsMax: number
    // ADV-002 (R3-4) — an advance may not exceed this % of the borrower's
    // monthly gross (0 = no cap). Guards festival-advance overshoots against
    // credit-light employees.
    advanceMaxPctOfMonthlyGross: number
    employerContributionPct: number // employer cost on top of gross
    payslipPrefix: string
  }
  // WF-001 (R3-4) — approval nudge sweep: a PENDING approval request resting
  // this many days triggers a daily reminder to the current step's approvers;
  // twice as long it escalates to HR_ADMIN/VENDOR_OWNER as well. 0 = off.
  approvals: {
    reminderDays: number
  }
  ait: {
    defaultRuleSetId: string | null
    annualizeMonths: number
    // PAY-010b (R3-4) — withhold AIT on the salary-like components of a final
    // settlement (final salary, OT, leave encashment, bonus, notice pay) at
    // the §86 average rate. Gratuity (BLA §96 statutory exemption) and the PF
    // refund (return of the employee's own money) are never withheld.
    settlementWithholding: boolean
  }
  shift: {
    autoDetect: boolean
    defaultShiftId: string | null
    otApprovalRequired: boolean
    maxOtHoursPerMonth: number
    // ATT-306 (R3-4) — statutory daily OT ceiling (BD Labour Act practice:
    // ordinary hours 8/day, 48/week → 2h/day OT ceiling). 0 = unlimited.
    maxOtHoursPerDay: number
  }
  wishes: {
    birthdayEnabled: boolean
    anniversaryEnabled: boolean
    birthdayTemplate: string
    anniversaryTemplate: string
    emailEnabled: boolean
    smsEnabled: boolean
    inAppEnabled: boolean
  }
  notification: {
    leaveRequestEmail: boolean
    payslipEmail: boolean
    salarySms: boolean
    attendanceAlertSms: boolean
    documentExpiryDays: number
  }
  // 2026-10-07 — real-time punch toasts (HR Settings → Communications →
  // Wishes & Notifications). Shown in-app to signed-in users who hold
  // `permission`, scoped to the employees they can see.
  punchAlerts: {
    enabled: boolean
    devicePunch: boolean // ZKTeco / biometric terminal punches
    geofencePunch: boolean // geo-fence (location) check-in/out
    selfiePunch: boolean // selfie / selfie+geo-fence check-in/out
    checkOut: boolean // also alert on check-outs (not only check-ins)
    permission: string // module.action a user needs to receive the toasts
    pollSeconds: number // how often open browsers check for new punches
  }
  // HRM-007 — password policy (complexity, expiry, reuse, lockout)
  passwordPolicy: {
    minLength: number
    requireUpper: boolean
    requireLower: boolean
    requireDigit: boolean
    requireSymbol: boolean
    expiryDays: number // 0 = never
    historyCount: number // reuse prevention (0 = off)
    lockoutThreshold: number // failed logins before lock
    lockoutMinutes: number
  }
  // S6 — session policy (idle timeout, concurrent cap)
  sessionPolicy: {
    idleTimeoutMinutes: number // 0 = disabled
    concurrentSessions: number // 0 = unlimited
  }
  // R16 (2026-10-12) — login-audit retention: failed+successful login attempts
  // are kept for this many days, then purged by the daily jobs sweep.
  // 0 = keep forever (not recommended — privacy-conscious default is 180).
  loginAudit: {
    retentionDays: number
  }
  // COM-04 (R6) — notification retention (0 = keep forever). The unread badge
  // also stops claiming more than the capped list can display.
  notifications: {
    retentionDays: number
  }
  // HRM-008 — late-coming policy (grace, tiered penalties, day salary deduction, leave adjustment, escalation, cap)
  latePolicy: {
    graceMinutes: number
    deductionMode: "TIERED" | "DAY_SALARY" | "LEAVE_ADJUSTMENT" | "FIXED_AMOUNT" | "PER_MINUTE" | "NONE"
    fixedDeductionPerDay: number
    perMinuteDeduction: number
    lateDaysThreshold: number // e.g. 3 days late
    deductDays: number // e.g. 1 day deduction
    salaryBasis: "BASIC" | "GROSS"
    leaveAdjustmentEnabled: boolean
    leaveTypeId: string // "FIRST_AVAILABLE_PAID" or a specific leaveTypeId
    leaveInsufficientFallback: "DEDUCT_SALARY" | "UNPAID_ABSENCE" | "NONE"
    tier1Minutes: number
    tier1Penalty: number
    tier2Minutes: number
    tier2Penalty: number
    repeatOffenderDays: number
    repeatOffenderPenalty: number
    maxDeductionCap: number // 0 = unlimited / no cap
  }
  // HRM-009 — early-leave policy
  earlyLeavePolicy: {
    thresholdMinutes: number
    deductionPerInstance: number
  }
  // HRM-010 — vendor-level overtime rates (shift multipliers override)
  otRates: {
    weekdayRate: number // multiplier of base hour rate
    holidayRate: number
    weeklyOffRate: number
    calcBasis: "FIXED" | "ROUNDED" | "ROUNDED_UP"
    roundToMinutes: number
  }
  // HRM-021 — notification preferences matrix (event × channel)
  notificationMatrix: Record<string, { email: boolean; sms: boolean; inApp: boolean }>
  // D1 — document expiry alert matrix (per document type lead days)
  documentExpiry: {
    types: { type: string; leadDays: number }[]
  }
  // L1/L5 — localization & formats
  localization: {
    language: "en" | "bn"
    currency: string
    currencySymbol: string
    timeFormat: "12h" | "24h"
    numberFormat: "1,23,456" | "123,456"
  }
  // B5 — module enable/disable toggles per vendor (nav + view gating)
  modules: {
    enabled: string[] // disabled module keys hide their nav + views
  }
  // B1 — branding / white-label theme
  branding: {
    primaryColor: string
    accentColor: string
    darkModeDefault: boolean
  }
  // T5 — audit retention (days; 0 = keep forever)
  auditRetention: {
    days: number
  }
  // FLD-103 (Wave R3-5) — field-level permission rules on the employee
  // record. Per-role access modes for 5 field groups (salary / bank /
  // identity / contact / employment); anything unlisted stays "full"
  // (backward compatible — an unconfigured tenant behaves exactly as before).
  // Consumed server-side by the employees.* projection/whitelist helpers in
  // field-permissions.ts; edited in Settings → Field Permissions.
  fieldPermissions: {
    roles: Record<string, Partial<Record<string, "full" | "mask" | "none">>> | null
    default: Partial<Record<string, "full" | "mask" | "none">> | null
  }
  // Employee management defaults (Employee Settings tab — id scheme, probation, notice)
  employeeSettings: {
    idPrefix: string // "EMP" → EMP-0001
    idSuffix: string // optional suffix appended after the number
    idStartNumber: number // first number in the sequence (existing codes are never renumbered)
    idPadLength: number // zero-padding width (4 → 0001)
    defaultProbationMonths: number // pre-fills the Create Employee form
    defaultNoticePeriodDays: number // pre-fills resignation notice (exit module)
    // EXIT-008 (R3-2) — BD Labour Act worker notice matrix: when ON, the
    // required notice for non-probationary, monthly-rated employees follows
    // §80/§81 BLA — 120 days (≥5 years' service) / 60 days (<5 years) —
    // instead of defaultNoticePeriodDays (the staff/contract convention).
    workerNoticeMatrix: boolean
  }
  // R5 — Self-Service ("My Portal") quick-action & request-button visibility.
  // Vendor admin controls which employee-initiated actions are exposed in the
  // ESS portal. All default ON; switching one OFF hides the matching button
  // (quick action row + the in-tab request button) for every portal user.
  essPortal: {
    showGeoCheckIn: boolean
    showSelfieGeoCheckIn: boolean // combined selfie + geofence punch (GEOFENCE_SELFIE)
    showSelfieCheckIn: boolean
    showCheckOut: boolean
    showApplyLeave: boolean
    showExpenseClaim: boolean
    showLoanRequest: boolean
    showAdvanceRequest: boolean
    showGoodsRequest: boolean
    showResignation: boolean
  }
  // G3 — selfie-capture consent: optional vendor policy text the employee must
  // acknowledge; acceptance recorded as EmployeeConsent rows (versioned).
  selfieConsent: {
    enabled: boolean
    version: string
    text: string
  }
  // Provident Fund vendor-level rules (per-employee overrides live on PfEnrollment)
  pf: {
    enabled: boolean
    employeePct: number // % of basis withheld from the employee
    employerPct: number // % of basis contributed by the employer
    basis: "BASIC" | "GROSS"
    minServiceMonths: number // eligibility gate (0 = immediate)
    // EXIT-007 (R3-2) — PF settlement at exit: the final settlement computes
    // the accumulated PF balance as a payable component, closes the enrollment
    // and writes the withdrawal ledger row when it is paid.
    settleAtExit: boolean // include the PF balance in the final settlement
    includeEmployerAtExit: boolean // pay out the employer share too (policy choice)
    // When true, eligible active employees are automatically enrolled in PF
    // without requiring manual enrollment per-head. The eligibility check
    // (minServiceMonths, ACTIVE status) is applied at the point of enrollment.
    autoEnroll: boolean
    eligibleStatuses: string[] // employee statuses eligible for PF (e.g. ["ACTIVE", "PROBATION"])
  }
  // PAY-006 (R3-2) — bonus approval exposure controls (Settings → Payroll →
  // Bonus Approval). escalationThreshold routes approvals of bonuses at or
  // above the threshold through the BONUS approval workflow (e.g. Owner
  // Approval) instead of direct approval; 0 disables escalation.
  bonusApproval: {
    escalationThreshold: number // ৳ — bonuses ≥ this need the BONUS workflow (0 = off)
    exposureWarnPct: number // preflight warning when bonus exposure exceeds this % of payroll
  }
  bonusPolicy: {
    minServiceMonths: number // e.g. 6 months minimum service to qualify
    minServiceDays: number // e.g. 180 days
    allowProbation: boolean // true = probation employees qualify
    allowContract: boolean // true = contractual employees qualify
    festivalBasis: "BASIC" | "GROSS" // default basis for festival bonuses
    festivalPercent: number // default % (e.g. 50% or 100% of basic)
    festivalsPerYear: number // standard 2 for BD (Eid / Puja)
    prorateFirstYear: boolean // pro-rate bonus for joiners with >= minService but < 1 year
    performanceBasis: "BASIC" | "GROSS"
    autoExcludeNoticePeriod: boolean // exclude employees currently serving notice period
  }
  // EXIT-001 (R3-1) — statutory gratuity (Settings → Payroll → Gratuity).
  // BLA 2006 §96 defaults; the exit settlement engine AND the advisory
  // Gratuity Provision report both read this single configuration so the
  // same rule is never computed two different ways.
  gratuity: {
    enabled: boolean
    eligibilityYears: number // completed years required (4y6m+ rounds up)
    daysPerYear: number // days of wages per completed year
    wageBasis: "BASIC" | "GROSS"
    divisor: number // daily-rate divisor: 30 (BLA) | 26 (factory)
    capAmount: number // flat cap on the total (0 = uncapped)
  }
  // LOAN-POL (2026-10 round) — Loans & Advances eligibility controls (Settings → Payroll → Loans & Advances Policy)
  loanPolicy: {
    eligibleStatuses: string[] // employee statuses eligible to apply (multi-select)
    minServiceMonths: number // minimum service tenure required before applying (0 = immediate)
    minPreviousRepaymentPct: number // minimum previous loan/advance repayment/payout ratio (%)
    allowConcurrentLoans: boolean // permit applying while having an ongoing active loan / advance
    maxConcurrentLoans: number // max simultaneous active loans (if concurrent allowed)
    minCurrentRepaidPctForNewLoan: number // min % of current loan that must be repaid before new one
    guarantorRequired: boolean // whether guarantor is mandatory
    guarantorMinServiceMonths: number // minimum guarantor service tenure in months
    guarantorAllowActiveLoan: boolean // whether guarantor can have an ongoing loan/advance
    guarantorMinRepaymentPct: number // guarantor minimum historical repayment ratio (%)
    guarantorEligibleStatuses: string[] // guarantor eligible employee statuses
  }
  // C-03 update — device gateway security. Replaces the removed 7-day
  // keyless grace window (HRM_DEVICE_GRACE_PERIOD_DAYS) and the lab-only
  // ATTENDANCE_GATEWAY_ALLOW_OPEN override: the vendor admin now decides
  // whether pre-registered devices without a comm key may communicate.
  devices: {
    allowKeyless: boolean // Enabled → keyless devices communicate normally; Disabled → rejected with 401
  }
  // 2026-10 round §11/§14/§61 — global TRACKING defaults. Per-group overrides
  // live in AttendancePolicy (TRACKING type) via the policy engine; these are
  // the fallbacks for employees with no tracking policy assigned.
  tracking: {
    enabled: boolean // master switch for the Live Tracking module
    updateIntervalSec: number // default ping interval (15/30/60/120/300/600/custom)
    retentionDays: number // TrackingPoint telemetry retention (0 = keep forever)
    lowBatteryThreshold: number // % — LOW_BATTERY state
    criticalBatteryThreshold: number // % — critical alert + event
    offlineAfterMinutes: number // no-update period → OFFLINE
  }
  // 2026-10 round §44–§45 — salary payout settings (Payroll → Payout Settings).
  // Threshold: salaries above maxCashMfsSalary are BANK-only, enforced at
  // employee create/edit, payout-account save, payroll calculate/pay and export.
  payout: {
    bankEnabled: boolean
    cashEnabled: boolean
    mfsEnabled: boolean
    maxCashMfsSalary: number
    thresholdBasis: "GROSS" | "NET"
  }
  // WP-F (2026-10-08) — tenant-editable journal account mapping + auto-post
  accounting: {
    /** default ON: pay → accrual journal (historical behaviour). */
    autoPost: boolean
    /** journal role → account code (validated against ACCOUNTS on read). */
    accountMapping: Record<string, string>
  }
  email: {
    enabled: boolean
    host: string // e.g. smtp.gmail.com
    port: number // 587 (STARTTLS) or 465 (SSL)
    secure: boolean // true for 465
    username: string // Gmail address
    password: string // Gmail app password (write-only)
    fromName: string
    fromAddress: string
  }
  sms: {
    enabled: boolean
    provider: string // e.g. BulkSMSBD, SSL Wireless, custom HTTP
    apiUrl: string // may contain {phone} {message} {sender} {apiKey} placeholders
    apiKey: string
    apiSecret: string
    senderId: string
    method: "GET" | "POST"
  }
  // 2026-10 restructure — SYSTEM SMS/Email template overrides (HR Settings →
  // Templates). The template LIST is fixed (message-templates.ts catalog);
  // tenants may edit wording per event. Missing key/field = system default.
  messageTemplates: Record<string, {
    emailSubject?: string
    emailBody?: string
    smsBody?: string
  }>
}

export const DEFAULT_SETTINGS: HrSettings = {
  general: { companyName: "My Company Ltd.", legalName: "", address: "", phone: "", email: "", website: "", binVatReg: "", logoUrl: "", weeklyHoliday: ["FRIDAY"], workingHoursPerDay: 8, fiscalYearStart: "July", dateFormat: "DD MMM YYYY", signatoryName: "", signatoryDesignation: "", signatureUrl: "", sealUrl: "" },
  attendance: { allowManualMarking: true, requireCheckOut: true, lateDeductionPerMinute: 0, lateDeductionPerInstance: 50, halfDayHours: 4, absenceDeduction: true, repeatedLateAlertDays: 3, longAbsenceAlertDays: 3, lockAfterDays: 0, compOffEnabled: false, compOffHoursPerDay: 8 },
  geofence: { enabled: true, defaultRadiusM: 150, requirePhoto: false },
  leave: { allowBackdated: true, maxBackdateDays: 7, requireSubstitute: false, substituteAcceptanceRequired: true, probationMaxDays: 10, encashmentOnExit: true, optionalHolidayLimit: 2, countHolidaysAsLeave: true, approvalSlaDays: 0, autoCancelPendingDays: 0 },
  payroll: { frequency: "MONTHLY", cutoffDay: 25, processingDay: 26, paymentDay: 30, absenceProration: true, attendanceBonusFullMonth: true, loanDeductionEnabled: true, advanceDeductionEnabled: true, loanGuarantorFallback: true, loanGuarantorMaxPct: 25, recoveryMaxPctOfNet: 50, loanArrearsMax: 3, advanceMaxPctOfMonthlyGross: 100, employerContributionPct: 5, payslipPrefix: "PS" },
  // WF-001 — BD scenario the marketing copy promised: requests resting on a
  // step whose approver is away get nudged daily and escalated to the tenant
  // admins rather than stalling silently.
  approvals: { reminderDays: 3 },
  ait: { defaultRuleSetId: null, annualizeMonths: 12, settlementWithholding: true },
  shift: { autoDetect: true, defaultShiftId: null, otApprovalRequired: false, maxOtHoursPerMonth: 60, maxOtHoursPerDay: 2 },
  wishes: { birthdayEnabled: true, anniversaryEnabled: true, birthdayTemplate: "Happy Birthday, {{name}}! Wishing you a wonderful day from the {{company}} family.", anniversaryTemplate: "Happy {{years}}{{ordinal}} Work Anniversary, {{name}}! Thank you for your dedicated service at {{company}}.", emailEnabled: true, smsEnabled: false, inAppEnabled: true },
  notification: { leaveRequestEmail: true, payslipEmail: true, salarySms: true, attendanceAlertSms: false, documentExpiryDays: 30 },
  punchAlerts: { enabled: true, devicePunch: true, geofencePunch: true, selfiePunch: true, checkOut: true, permission: "attendance.view", pollSeconds: 15 },
  passwordPolicy: { minLength: 8, requireUpper: true, requireLower: true, requireDigit: true, requireSymbol: false, expiryDays: 0, historyCount: 3, lockoutThreshold: 5, lockoutMinutes: 15 },
  sessionPolicy: { idleTimeoutMinutes: 0, concurrentSessions: 0 },
  loginAudit: { retentionDays: 180 },
  notifications: { retentionDays: 90 },
  latePolicy: {
    graceMinutes: 10,
    deductionMode: "TIERED",
    fixedDeductionPerDay: 50,
    perMinuteDeduction: 0,
    lateDaysThreshold: 3,
    deductDays: 1,
    salaryBasis: "BASIC",
    leaveAdjustmentEnabled: false,
    leaveTypeId: "FIRST_AVAILABLE_PAID",
    leaveInsufficientFallback: "DEDUCT_SALARY",
    tier1Minutes: 15,
    tier1Penalty: 50,
    tier2Minutes: 30,
    tier2Penalty: 100,
    repeatOffenderDays: 3,
    repeatOffenderPenalty: 200,
    maxDeductionCap: 0,
  },
  earlyLeavePolicy: { thresholdMinutes: 15, deductionPerInstance: 0 },
  // ATT-306 (R3-4) — statutory default: the BD Labour Act OT premium is TWICE
  // the ordinary rate (§(8h/day, 48h/week); 1.5× was an under-payment default.
  // Vendors that saved an explicit otRates group keep their configured value.
  otRates: { weekdayRate: 2, holidayRate: 2, weeklyOffRate: 2, calcBasis: "ROUNDED_UP", roundToMinutes: 15 },
  notificationMatrix: {
    leave_request: { email: true, sms: false, inApp: true },
    leave_decision: { email: true, sms: false, inApp: true },
    payslip_generated: { email: true, sms: false, inApp: true },
    salary_credited: { email: false, sms: true, inApp: true },
    attendance_alert: { email: true, sms: false, inApp: true },
    document_expiry: { email: true, sms: false, inApp: true },
    resignation_submitted: { email: true, sms: false, inApp: true },
    loan_request: { email: true, sms: false, inApp: true },
    loan_decision: { email: true, sms: false, inApp: true },
    advance_request: { email: true, sms: false, inApp: true },
    advance_decision: { email: true, sms: false, inApp: true },
    expense_request: { email: true, sms: false, inApp: true },
    expense_decision: { email: true, sms: false, inApp: true },
    performance_review: { email: true, sms: false, inApp: true },
    // employee lifecycle communications (2026-10 round — automation controls)
    employee_account_created: { email: false, sms: false, inApp: true },
    employee_credentials: { email: true, sms: false, inApp: false },
    password_reset: { email: true, sms: false, inApp: false },
    promotion: { email: true, sms: false, inApp: true },
    transfer: { email: true, sms: false, inApp: true },
    shift_change: { email: true, sms: false, inApp: true },
    salary_revision: { email: true, sms: false, inApp: true },
    employee_status: { email: true, sms: false, inApp: true },
    // 2026-10 round §17 — tracking/security notification events
    gps_disabled: { email: true, sms: false, inApp: true },
    tracking_offline: { email: false, sms: false, inApp: true },
    low_battery: { email: false, sms: false, inApp: true },
    geofence_violation: { email: true, sms: false, inApp: true },
    location_spoof_suspected: { email: true, sms: false, inApp: true },
    mandatory_gps_violation: { email: true, sms: false, inApp: true },
    attendance_review_required: { email: true, sms: false, inApp: true },
  },
  documentExpiry: { types: [
    { type: "NID", leadDays: 30 }, { type: "PASSPORT", leadDays: 60 }, { type: "CONTRACT", leadDays: 90 },
    { type: "TRADE_LICENSE", leadDays: 30 }, { type: "OTHER", leadDays: 30 },
  ] },
  localization: { language: "en", currency: "BDT", currencySymbol: "৳", timeFormat: "12h", numberFormat: "123,456" },
  modules: { enabled: [] },
  branding: { primaryColor: "#059669", accentColor: "#0d9488", darkModeDefault: false },
  auditRetention: { days: 0 },
  // FLD-103 — empty by default: no role restrictions until configured
  fieldPermissions: { roles: null, default: null },
  employeeSettings: { idPrefix: "EMP", idSuffix: "", idStartNumber: 1, idPadLength: 4, defaultProbationMonths: 3, defaultNoticePeriodDays: 30, workerNoticeMatrix: false },
  // R5 — every ESS portal action visible by default (incl. the combined
  // Selfie + Geo quick action, Selfie Attendance G1)
  essPortal: { showGeoCheckIn: true, showSelfieGeoCheckIn: true, showSelfieCheckIn: true, showCheckOut: true, showApplyLeave: true, showExpenseClaim: true, showLoanRequest: true, showAdvanceRequest: true, showGoodsRequest: true, showResignation: true },
  // G3 — consent capture OFF by default; vendors opt in and write their own text
  selfieConsent: { enabled: false, version: "", text: "" },
  pf: { enabled: false, employeePct: 10, employerPct: 10, basis: "BASIC", minServiceMonths: 0, settleAtExit: true, includeEmployerAtExit: true, autoEnroll: false, eligibleStatuses: ["ACTIVE", "PROBATION"] },
  // PAY-006 — escalation ON by default at ৳50,000: large bonuses require the
  // BONUS workflow's owner gate. Tenants without a BONUS workflow configured
  // fall back to direct approval (audited), so existing installs are unaffected.
  bonusApproval: { escalationThreshold: 50000, exposureWarnPct: 25 },
  bonusPolicy: { minServiceMonths: 6, minServiceDays: 180, allowProbation: false, allowContract: true, festivalBasis: "BASIC", festivalPercent: 100, festivalsPerYear: 2, prorateFirstYear: true, performanceBasis: "BASIC", autoExcludeNoticePeriod: true },
  // EXIT-001 — BLA §96 statutory defaults: 30 days' basic wages per completed
  // year, eligible after 5 years of continuous service (4y6m rounds up)
  gratuity: { enabled: true, eligibilityYears: 5, daysPerYear: 30, wageBasis: "BASIC", divisor: 30, capAmount: 0 },
  loanPolicy: {
    eligibleStatuses: ["ACTIVE", "PROBATION"],
    minServiceMonths: 6,
    minPreviousRepaymentPct: 80,
    allowConcurrentLoans: false,
    maxConcurrentLoans: 1,
    minCurrentRepaidPctForNewLoan: 50,
    guarantorRequired: false,
    guarantorMinServiceMonths: 12,
    guarantorAllowActiveLoan: false,
    guarantorMinRepaymentPct: 90,
    guarantorEligibleStatuses: ["ACTIVE"],
  },
  // C-03 update — secure default: keyless devices are rejected until the
  // admin explicitly allows them (Settings → Devices → Allow Keyless Devices).
  devices: { allowKeyless: false },
  // 2026-10 round — tracking defaults (Live Tracking module)
  tracking: { enabled: true, updateIntervalSec: 60, retentionDays: 90, lowBatteryThreshold: 20, criticalBatteryThreshold: 10, offlineAfterMinutes: 15 },
  // 2026-10 round — payout defaults: all methods enabled, ৳10,000 cash/MFS ceiling (§44 example)
  payout: { bankEnabled: true, cashEnabled: true, mfsEnabled: true, maxCashMfsSalary: 10000, thresholdBasis: "GROSS" },
  // WP-F — defaults reproduce the historical hard-wired chart exactly
  accounting: { autoPost: true, accountMapping: {
    salaryExpense: "5100", otExpense: "5110", bonusExpense: "5120", pfEmployerExpense: "5150",
    aitPayable: "2105", pfPayable: "2150", salariesPayable: "2100", loanReceivable: "1150",
    advances: "1155", deductionsRecovered: "5290", bank: "1200", cash: "1010", mfs: "1210",
  } },
  email: { enabled: false, host: "smtp.gmail.com", port: 587, secure: false, username: "", password: "", fromName: "Finix HR", fromAddress: "" },
  sms: { enabled: false, provider: "", apiUrl: "", apiKey: "", apiSecret: "", senderId: "", method: "POST" },
  // no overrides by default — every event uses its system-defined template
  messageTemplates: {},
}

// H-2 — single source of truth for the savable-groups whitelist. Previously
// settings.save and settings.patch (routes/organization.ts) each carried an
// INLINE copy of this list, and the essPortal group (R5) shipped in defaults +
// Settings UI without being added to either copy — making the Self-Service
// Portal tab permanently unsavable ("Unknown settings group"). Deriving the
// whitelist from DEFAULT_SETTINGS makes the registries structurally unable to
// drift: a group defined in the settings schema is savable by definition, and
// tests/unit/h2-settings-whitelist.test.ts asserts the Settings UI only
// renders groups that exist here.
export const SETTINGS_SAVE_GROUPS: readonly string[] = Object.keys(DEFAULT_SETTINGS)

export async function getSettings(vendorId: string, opts?: { maskSecrets?: boolean; noCache?: boolean }): Promise<HrSettings> {
  const maskSecrets = opts?.maskSecrets !== false
  // K-7 — serve from the cache (masked callers get a masked CLONE — the cached
  // object itself holds the unmasked values and is never handed out directly)
  const cached = settingsCache.get(vendorId)
  if (!opts?.noCache && cached && Date.now() - cached.at < SETTINGS_TTL_MS) {
    if (!maskSecrets) return cached.settings
    const clone: any = JSON.parse(JSON.stringify(cached.settings))
    if (clone.email) clone.email = { ...clone.email, password: "", passwordSet: !!clone.email.password }
    if (clone.sms) clone.sms = { ...clone.sms, apiKey: "", apiSecret: "", apiKeySet: !!clone.sms.apiKey, apiSecretSet: !!clone.sms.apiSecret }
    return clone as HrSettings
  }
  const rows = await db.hrSetting.findMany({ where: { vendorId } })
  const merged: any = JSON.parse(JSON.stringify(DEFAULT_SETTINGS))
  // Rows are per-(group,key): merge each key's value into its group. Spreading
  // the parsed value directly (old code) exploded arrays/strings into indexed
  // keys the moment the first row landed in the table.
  for (const r of rows) {
    if (!merged[r.group]) merged[r.group] = {}
    merged[r.group][r.key] = j(r.value, undefined as never)
  }
  // M-36 — decrypt comms secrets after the merge (masked reads blank them
  // below anyway; unmasked internal reads — sendEmail/sendSms — get plaintext)
  if (merged.email?.password !== undefined) merged.email.password = unwrapCommsSecret(merged.email.password)
  if (merged.sms?.apiKey !== undefined) merged.sms.apiKey = unwrapCommsSecret(merged.sms.apiKey)
  if (merged.sms?.apiSecret !== undefined) merged.sms.apiSecret = unwrapCommsSecret(merged.sms.apiSecret)
  capSettingsCache(); settingsCache.set(vendorId, { settings: merged as HrSettings, at: Date.now() })
  // Secrets are write-only: never return stored SMTP/SMS credentials to
  // clients. K-7 cache-poisoning fix: the mask is applied to a DEEP CLONE —
  // mutating `merged` here used to blank the password inside the cached
  // entry too (same object reference), so every later unmasked read
  // (sendEmail/sendSms/payslip mail) saw empty secrets and every send was
  // "SKIPPED: gateway not configured" despite credentials being stored.
  if (maskSecrets) {
    const clone: any = JSON.parse(JSON.stringify(merged))
    if (clone.email) clone.email = { ...clone.email, password: "", passwordSet: !!clone.email.password }
    if (clone.sms) {
      clone.sms = { ...clone.sms, apiKey: "", apiSecret: "", apiKeySet: !!clone.sms.apiKey, apiSecretSet: !!clone.sms.apiSecret }
    }
    return clone as HrSettings
  }
  return merged as HrSettings
}

export async function saveSettingsGroup(vendorId: string, group: string, patch: Record<string, unknown>) {
  // H-10 — validate the SMS gateway URL at SAVE time (https only, public hosts
  // only). Send-time guards exist too (gateway.ts); this stops bad config early
  // with a clear, actionable message.
  if (group === "sms" && typeof patch.apiUrl === "string" && patch.apiUrl.trim() !== "") {
    // Substitute placeholder tokens with a dummy host so the URL parses, then
    // validate the scheme/host shape of the real template.
    const probe = patch.apiUrl.replace(/\{(phone|message|sender|apiKey)\}/g, "probe")
    const check = validateOutboundUrl(probe)
    if (!check.ok) {
      throw Object.assign(new Error(`SMS gateway URL rejected: ${check.reason}`), { code: 400 })
    }
  }
  // FLD-103 (Wave R3-5) — field-permission rules are security-sensitive config:
  // validate the shape at save time (groups × access modes; role keys are
  // arbitrary strings because custom roles are first-class). A malformed
  // payload is rejected instead of silently ignored by the resolver.
  if (group === "fieldPermissions") {
    for (const key of Object.keys(patch)) {
      if (key !== "roles" && key !== "default") {
        throw Object.assign(new Error(`Unknown key "${key}" in fieldPermissions (allowed: roles, default)`), { code: 400 })
      }
    }
    const checkShape = (v: unknown, where: string) => {
      if (v == null) return
      if (typeof v !== "object" || Array.isArray(v)) {
        throw Object.assign(new Error(`fieldPermissions.${where} must be an object`), { code: 400 })
      }
      for (const [k, mode] of Object.entries(v as Record<string, unknown>)) {
        if (mode !== "full" && mode !== "mask" && mode !== "none") {
          throw Object.assign(new Error(`fieldPermissions.${where}.${k}: "${String(mode)}" is not one of full | mask | none`), { code: 400 })
        }
      }
    }
    const roles = (patch as any).roles
    if (roles != null) {
      if (typeof roles !== "object" || Array.isArray(roles)) {
        throw Object.assign(new Error("fieldPermissions.roles must be an object of role → group → access"), { code: 400 })
      }
      for (const [roleKey, groups] of Object.entries(roles as Record<string, unknown>)) {
        if (!roleKey || typeof roleKey !== "string" || roleKey.length > 40) {
          throw Object.assign(new Error(`fieldPermissions.roles: invalid role key "${roleKey}"`), { code: 400 })
        }
        checkShape(groups, `roles.${roleKey}`)
      }
    }
    checkShape((patch as any).default, "default")
  }
  // Secret fields are write-only: an empty submitted value keeps the stored one.
  const SECRET_KEEP: Record<string, string[]> = {
    email: ["password"],
    sms: ["apiKey", "apiSecret"],
  }
  const keepEmpty = SECRET_KEEP[group] || []
  const final: [string, unknown][] = []
  for (const [key, value] of Object.entries(patch)) {
    if (keepEmpty.includes(key) && (value === "" || value == null)) {
      const existing = await db.hrSetting.findFirst({ where: { vendorId, group, key } })
      if (existing) final.push([key, j(existing.value, "")])
      continue
    }
    // M-36 — comms secrets are stored ENCRYPTED at rest. Fail closed without
    // HRM_MFA_KEY (same policy as MFA enrollment and camera credentials).
    if (keepEmpty.includes(key) && typeof value === "string" && value !== "" && !value.startsWith(COMMS_ENC_PREFIX)) {
      if (!fieldKeyConfigured()) {
        throw Object.assign(new Error(`Cannot store ${group}.${key}: the server encryption key (HRM_MFA_KEY) is not configured — ask an administrator to set it`), { code: 500 })
      }
      final.push([key, wrapCommsSecret(value)])
      continue
    }
    final.push([key, value])
  }
  for (const [key, value] of final) {
    const existing = await db.hrSetting.findFirst({ where: { vendorId, group, key } })
    if (existing) {
      await db.hrSetting.update({ where: { id: existing.id }, data: { value: JSON.stringify(value) } })
    } else {
      await db.hrSetting.create({ data: { vendorId, group, key, value: JSON.stringify(value) } })
    }
  }
  // K-7 — write-through invalidation so the very next read sees this change
  invalidateSettings(vendorId)
}
