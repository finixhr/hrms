// ============ M-01 — shared Zod primitives for route payload validation ============
// Schemas declared here are attached per-action via registry `schema:`. The
// dispatcher validates + STRIPS (unknown keys dropped) before the handler
// runs, so a client can never smuggle server-only fields (createdBy,
// verified, status escalations…) past the whitelist.
//
// Rules (audit M-01):
//  - money: non-negative floats, finite
//  - dates: ISO date strings (YYYY-MM-DD) — no Date objects over RPC
//  - ids: cuid-ish strings
//  - enums: literal unions
//  - everything optional unless the route genuinely requires it
import { z, type ZodType } from "zod"
import { Deny } from "./rbac"

/** ISO date string YYYY-MM-DD (calendar date, no time component). */
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (YYYY-MM-DD)")
/** Date-time string (device frames, event times). */
export const isoDateTime = z.string().min(1)
/** Non-negative finite money amount. */
export const money = z.number().finite().min(0)
/** Positive finite money amount (loan principal, installment amount…). */
export const moneyPositive = z.number().finite().positive()
/** Signed money amount (adjustments may be negative). */
export const moneySigned = z.number().finite()
/** Entity id. */
export const id = z.string().min(1)
/** Optional entity id. */
export const idOpt = z.string().min(1).nullish()
/** Short text with a hard length cap (DB columns are bounded). */
export const text = (max = 500) => z.string().max(max)
/** Boolean-ish flag. */
export const flag = z.boolean().nullish()
/** Non-negative int. */
export const uint = z.number().int().min(0)

// ---------- FormDialog-tolerant primitives ----------
// FormDialog submits EVERY field on the form: untouched text inputs arrive as
// "", untouched selects as "" (or a "__none__"-mapped ""), untouched switches
// as false. These primitives accept that reality instead of 400-ing:
//   - emptyAsNull  : "" → null (nullable columns / optional ids)
//   - textOpt      : blank → null, otherwise max length capped string
//   - dateOpt      : "" → null, otherwise a strict ISO date
//   - numOpt       : ""/null → undefined, numeric strings coerced, finite ≥ 0
//   - intOpt       : numOpt + integer
//   - boolOpt      : true/false plus "true"/"false" string coercion
//   - upperEnum    : blank → null, case-insensitive uppercase enum

/** "" (or any blank string) → null; anything else passes through. */
const emptyAsNull = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), schema)

/** Optional text: blank → null, bounded length. */
export const textOpt = (max = 500) => emptyAsNull(z.string().max(max).nullish())

/** Optional date: blank → null, otherwise ISO YYYY-MM-DD. */
const dateOpt = emptyAsNull(isoDate.nullish())
/** Optional id: blank → null (untouched selects). */
const idBlankOpt = emptyAsNull(idOpt)
/** Optional non-negative number: blank/null → undefined, strings coerced. */
const numOpt = z.preprocess(
  (v) => {
    if (v === "" || v === null || v === undefined) return undefined
    if (typeof v === "string") return v.trim() === "" ? undefined : Number(v)
    return v
  },
  z.number().finite().min(0).nullish(),
)
/** Optional non-negative integer (probation months, progress…). */
const intOpt = z.preprocess(
  (v) => {
    if (v === "" || v === null || v === undefined) return undefined
    if (typeof v === "string") return v.trim() === "" ? undefined : Number(v)
    return v
  },
  z.number().int().min(0).nullish(),
)
/** Optional boolean: real booleans plus "true"/"false" string coercion. */
const boolOpt = z.preprocess((v) => {
  if (v === "true") return true
  if (v === "false") return false
  return v
}, z.boolean().nullish())
/** Case-insensitive enum whose value is normalized to UPPERCASE (blank strings coerce to null). */
const upperEnum = (values: [string, ...string[]]) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : typeof v === "string" ? v.toUpperCase() : v),
    z.enum(values).nullish()
  )

/** Validate a payload against a schema and return the typed object, or throw
 *  a 400 Deny with the first issue. `requireValid` is also usable inside
 *  handlers that validate sub-objects (bulk import rows, section payloads). */
export function requireValid<T>(schema: ZodType<T>, payload: unknown, what = "payload"): T {
  const parsed = schema.safeParse(payload)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const path = issue?.path?.length ? ` at "${issue.path.join(".")}"` : ""
    throw new Deny(`Invalid ${what}${path}: ${issue?.message || "validation failed"}`, 400)
  }
  return parsed.data
}

// ---------- shared action payload schemas ----------
export const S = {
  /** id-only payloads (get/delete/enable/toggle actions). */
  byId: z.object({ id: id }).passthrough(),
  /** Deny-style confirmation guard for destructive actions. */
  confirmDelete: z.object({ id: id, confirm: z.literal("DELETE") }).passthrough(),

  /** Employee create/update payload — aligned with the Employee model columns,
   * the server route's EMPLOYEE_WRITABLE whitelist and BOTH client forms
   * (CreateEmployeeDialog + EditProfileDialog). Strict (whitelist) as before,
   * but the whitelist now matches reality. FormDialog conventions are handled
   * by the tolerant primitives: "" dates → null, "" selects → null, numeric
   * strings coerced, gender/maritalStatus accepted in any letter case and
   * normalized to uppercase. Salary-structure fields ride along for the
   * atomic employees.createWithStructure action. */
  employeesSave: z.object({
    id: idBlankOpt, // update only
    code: textOpt(50), // manual employee code (auto-generated when blank)
    // personal
    fullName: z.string().min(1).max(200),
    // L-27 — an image data URL (the client upload pattern) or an https:// URL;
    // anything else (http://, javascript:, arbitrary text) is rejected so an
    // editor cannot point employee photos at attacker-controlled or insecure
    // origins that leak viewer IPs.
    photoUrl: textOpt(2_000_000).nullish().refine((v) => {
      if (!v) return true
      return /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(v) || /^https:\/\/[^\s"']+$/i.test(v)
    }, { message: "photoUrl must be an image data URL or an https:// URL" }),
    // 96×96 list thumbnail riding along with photoUrl (client-generated
    // data URL; small cap — thumbs are ~4-6KB)
    photoThumb: textOpt(300_000).nullish(),
    nameBn: textOpt(200),
    preferredName: textOpt(200),
    fatherName: textOpt(200),
    motherName: textOpt(200),
    spouseName: textOpt(200),
    dob: dateOpt,
    placeOfBirth: textOpt(200),
    gender: upperEnum(["MALE", "FEMALE", "OTHER"]),
    bloodGroup: textOpt(10),
    maritalStatus: upperEnum(["SINGLE", "MARRIED", "DIVORCED", "WIDOWED"]),
    nationality: textOpt(60),
    religion: textOpt(60),
    // contact
    mobile: textOpt(30),
    altMobile: textOpt(30),
    personalEmail: textOpt(200),
    officialEmail: textOpt(200),
    emergencyName: textOpt(200),
    emergencyRelation: textOpt(100),
    emergencyMobile: textOpt(30),
    // address
    presentAddress: textOpt(500),
    permanentAddress: textOpt(500),
    division: textOpt(100),
    district: textOpt(100),
    city: textOpt(100),
    postCode: textOpt(20),
    presentDivision: textOpt(100),
    presentDistrict: textOpt(100),
    presentCity: textOpt(100),
    presentPostCode: textOpt(20),
    addressSame: boolOpt,
    // employment
    branchId: idBlankOpt,
    departmentId: idBlankOpt,
    designationId: idBlankOpt,
    reportingManagerId: idBlankOpt,
    hrManagerId: idBlankOpt,
    supervisorId: idBlankOpt,
    workLocation: textOpt(200),
    joiningDate: dateOpt,
    confirmationDate: dateOpt,
    probationMonths: intOpt,
    employmentType: upperEnum(["PERMANENT", "PROBATIONARY", "CONTRACTUAL", "TEMPORARY", "PART_TIME", "INTERN", "COMMISSION", "FREELANCE"]),
    status: upperEnum(["ACTIVE", "PROBATION", "ON_LEAVE", "SUSPENDED", "RESIGNED", "TERMINATED", "RETIRED", "INACTIVE", "EXITED"]),
    category: textOpt(100),
    grade: textOpt(50),
    shiftId: idBlankOpt,
    weeklyOff: z.union([z.string().max(60), z.array(z.string().max(20))]).nullish(), // array joined server-side
    contractStart: dateOpt,
    contractEnd: dateOpt,
    // overtime & tax (spec §7.6 / §9.5) — editable on the 360° profile
    otEligible: boolOpt,
    previousEmployerIncome: numOpt,
    taxAlreadyDeducted: numOpt,
    // 2026-10-14 — e-TIN: captured on the Employee create form and the 360°
    // profile; normalised + validated in routes/employees.ts (6–17 digits).
    taxTin: textOpt(20),
    // 2026-10-15 — Identity document (NID / Birth Reg / Passport) captured on create and edit
    identityType: textOpt(50),
    identityNumber: textOpt(50),
    nid: textOpt(50),
    // initial salary structure (employees.createWithStructure only)
    basic: numOpt,
    houseRent: numOpt,
    medical: numOpt,
    conveyance: numOpt,
    food: numOpt,
    mobileAllow: numOpt,
    internetAllow: numOpt,
    attendanceAllow: numOpt,
    otherAllowance: numOpt,
    // ---- Salary & Payout section (2026-10 round §46): rides along on
    // employees.createWithStructure / employees.update; validated + applied
    // server-side via applyPayoutSelection (never frontend-only).
    payoutMethod: upperEnum(["BANK", "CASH", "MFS"]),
    payoutBank: textOpt(200),
    payoutBranch: textOpt(200),
    payoutAccountName: textOpt(200),
    payoutAccountNumber: textOpt(50),
    payoutRoutingNumber: textOpt(30),
    payoutMfsProvider: upperEnum(["BKASH", "NAGAD", "ROCKET", "OTHER"]),
    payoutMfsNumber: textOpt(30),
  }).strict(), // strict = whitelist: unknown client fields are REJECTED

  employeesBulkImport: z.object({
    rows: z.array(z.record(z.string(), z.unknown())).min(1).max(5000),
    dryRun: z.boolean().nullish(),
  }).strict(),

  leaveApply: z.object({
    employeeId: idOpt,
    leaveTypeId: id,
    fromDate: isoDate,
    toDate: isoDate,
    reason: textOpt(1000),
    halfDay: flag,
    contactNumber: textOpt(30),
    substituteEmployeeId: idOpt,
    attachmentName: textOpt(200),
    attachmentData: z.string().max(3_000_000).nullish(),
  }).passthrough(),

  // H-7 — encashment MUST name the leave type: the balance lookup is scoped by
  // (employeeId, leaveTypeId, year) and the LeaveBalance unique key makes the
  // row unique. Without it, findFirst picked an arbitrary row among the
  // employee's leave types for the year (non-deterministic money computation).
  leaveEncash: z.object({
    employeeId: idOpt,
    leaveTypeId: id,
    days: z.number().finite().positive(),
  }).passthrough(),

  // EXIT-011 (R3-4) — final-settlement calculation input. `otherDeductions`
  // used to arrive unvalidated (schema-less action): a NEGATIVE value
  // inflated netPayable, and a non-numeric string coerced to NaN mid-math.
  // The amount is pinned to a finite, non-negative number; everything else
  // the handler needs (resignationId) is an id.
  settlementCalculate: z.object({
    resignationId: id,
    otherDeductions: z.number().finite().min(0).max(1_000_000_000).optional(),
  }).passthrough(),

  // M-14 — the geo-attendance routes previously declared NO schema: any shape
  // reached the handler (multi-MB base64 decoded before any post-check).
  // check-in/out REQUIRE coordinates; the plain self check-out makes them
  // optional (GPS-failure fallback).
  geoCheckin: z.object({
    employeeId: idOpt,
    latitude: z.number().finite(),
    longitude: z.number().finite(),
    accuracyM: z.number().finite().min(0).nullish(),
    deviceInfo: textOpt(200),
    // G1 — capture provenance from the in-app camera dialog ({score, method,
    // faceDetected, faceRatio, brightness, sharpness, width, height,
    // bytesApprox}). Evidence metadata only — stored on the proof row for
    // reviewers, never used to decide verification status (§27).
    selfieQuality: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).nullish(),
    selfieDataUrl: z.string().max(2_500_000).nullish(), // data-URL; client downscales to ≤640px JPEG
    batteryPercentage: z.number().min(0).max(100).nullish(),
    isCharging: flag,
    gpsStatus: z.string().max(20).nullish(),
    networkStatus: z.string().max(20).nullish(),
    deviceId: textOpt(120),
    mobileSessionId: textOpt(120),
    clientEventId: textOpt(120),
    clientTimestamp: z.string().max(40).nullish(),
    isMockLocation: flag,
    reason: textOpt(300),
<<<<<<< HEAD
    // M3 (T-12) — true when the mobile outbox recorded this punch on-device
    // while offline and is replaying it after reconnect. The punch stays real
    // (GPS/clientTimestamp captured at punch time), but a material delay
    // flags the event OFFLINE_CAPTURE for HR review — see
    // routes/attendance.ts offlineCaptureVerdict.
    offlineCapture: flag,
=======
>>>>>>> origin/main
  }).passthrough(),

  // §28 selfie check-in: the selfie PROOF is the requirement; GPS is
  // best-effort (a selfie-only punch must work where GPS fails — indoors,
  // no fix, or plain-HTTP LAN where the browser blocks geolocation). The
  // server route enforces the ATTENDANCE_METHOD policy before anything else.
  selfieCheckin: z.object({
    employeeId: idOpt,
    selfieQuality: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).nullish(),
    selfieDataUrl: z.string().min(32).max(2_500_000), // REQUIRED — data-URL; client downscales to ≤640px JPEG
    latitude: z.number().finite().nullish(),
    longitude: z.number().finite().nullish(),
    accuracyM: z.number().finite().min(0).nullish(),
    deviceInfo: textOpt(200),
    batteryPercentage: z.number().min(0).max(100).nullish(),
    isCharging: flag,
    gpsStatus: z.string().max(20).nullish(),
    networkStatus: z.string().max(20).nullish(),
    deviceId: textOpt(120),
    mobileSessionId: textOpt(120),
    clientEventId: textOpt(120),
    clientTimestamp: z.string().max(40).nullish(),
    isMockLocation: flag,
    reason: textOpt(300),
<<<<<<< HEAD
    // M3 (T-12) — offline outbox replay marker (see S.geoCheckin note)
    offlineCapture: flag,
=======
>>>>>>> origin/main
  }).passthrough(),

  geoCheckout: z.object({
    employeeId: idOpt,
    latitude: z.number().finite(),
    longitude: z.number().finite(),
    accuracyM: z.number().finite().min(0).nullish(),
    deviceInfo: textOpt(200),
    selfieQuality: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).nullish(),
    selfieDataUrl: z.string().max(2_500_000).nullish(),
    batteryPercentage: z.number().min(0).max(100).nullish(),
    isCharging: flag,
    gpsStatus: z.string().max(20).nullish(),
    networkStatus: z.string().max(20).nullish(),
    deviceId: textOpt(120),
    mobileSessionId: textOpt(120),
    clientEventId: textOpt(120),
    clientTimestamp: z.string().max(40).nullish(),
    isMockLocation: flag,
    reason: textOpt(300),
<<<<<<< HEAD
    // M3 (T-12) — offline outbox replay marker (see S.geoCheckin note)
    offlineCapture: flag,
=======
>>>>>>> origin/main
  }).passthrough(),

  selfCheckout: z.object({
    employeeId: idOpt,
    latitude: z.number().finite().nullish(),
    longitude: z.number().finite().nullish(),
    accuracyM: z.number().finite().min(0).nullish(),
    reason: textOpt(300),
  }).passthrough(),

  // ATT-305/ATT-311 (R3-4) — manual marking finally has a schema: the date
  // must be a well-formed ISO date (the future-date / lock / PAID-period
  // guards run in the handler on top of the shape check).
  attendanceMark: z.object({
    employeeId: id,
    date: isoDate,
  }).passthrough(),

  // ATT-311 (R3-4) — bulk marking is bounded: at most 500 employees per call,
  // well-formed date, no schema-less mega-loops inside one RPC.
  attendanceBulkMark: z.object({
    date: isoDate,
    employeeIds: z.array(id).min(1).max(500),
    checkIn: z.string().regex(/^\d{2}:\d{2}$/).nullish(),
    checkOut: z.string().regex(/^\d{2}:\d{2}$/).nullish(),
  }).passthrough(),

  // ATT-305 (R3-4) — correction requests carry a well-formed date.
  attendanceCorrectionRequest: z.object({
    date: isoDate,
  }).passthrough(),

  leaveDecision: z.object({
    requestId: id,
    decision: z.enum(["APPROVE", "REJECT", "CANCEL"]),
    comment: textOpt(1000),
  }).passthrough(),

  loanCreate: z.object({
    // FIN-01 — ESS submits carry no employeeId (the logged-in profile is the
    // requester); the schema must not demand it or validation 400s before the
    // handler's resolveRequester self-scope can run. resolveRequester still
    // enforces: EMPLOYEE may only submit for themselves.
    employeeId: id.nullish(),
    principal: moneyPositive,
    interestRate: z.number().min(0).max(100).nullish(),
    installments: z.number().int().min(1).max(360),
    installmentAmount: money.nullish(),
    startDate: isoDate,
    purpose: textOpt(500),
    // LOA-005 (R3-4) — loan type is now a closed enum (arbitrary strings used
    // to ride through .passthrough()); the dead deductionType / accountNumber
    // fields were REMOVED from the API surface — the engine is flat-principal
    // (interestRate is display metadata only) and no handler ever read them.
    type: z.enum(["PERSONAL", "HOUSING", "MEDICAL", "EMERGENCY", "OTHER"]).nullish(),
    guarantorId: id.nullish(),
  }).passthrough(),

  advanceCreate: z.object({
    // FIN-01 — see loanCreate: optional for ESS self-service submits.
    employeeId: id.nullish(),
    amount: moneyPositive,
    reason: textOpt(500),
    repaymentMonths: z.number().int().min(1).max(60).nullish(),
    deductionStart: isoDate.nullish(),
    installments: z.number().int().min(1).max(120).nullish(),
    installmentAmount: money.nullish(),
    // 2026-10-14 — guarantor fallback: HR may designate a colleague whose
    // salary carries the recovery when the borrower has no payable salary in
    // a period (Payroll → Loan & Advance Control). Loans require the
    // guarantor's ESS consent (spec §10.1); advances are created by HR, so
    // the designation is effective immediately.
    guarantorId: id.nullish(),
  }).passthrough(),

  payrollCreate: z.object({
    periodYear: z.number().int().min(2000).max(2100),
    periodMonth: z.number().int().min(1).max(12),
    periodWeek: z.number().int().min(0).max(53).nullish(),
    // PAY-002 (R3-1) — ONLY REGULAR runs are user-creatable. ADJUSTMENT runs are
    // minted exclusively by payroll.adjustmentCreate (delta semantics); the
    // historical BONUS / FINAL_SETTLEMENT runTypes were never implemented by
    // the calculation engine — a run of either type paid a FULL second month.
    runType: z.enum(["REGULAR"]).nullish(),
    employeeIds: z.array(id).nullish(),
    notes: textOpt(1000),
  }).passthrough(),

  /** Submission creates an approval request; decisions happen via approvals.act. */
  payrollSubmit: z.object({ runId: id }).strict(),

  taskSave: z.object({
    // Whitelist aligned with the Task model and the client's Tasks view:
    // assigneeId is REQUIRED on create (the handler resolves the assignee);
    // scope/startDate/branchId/progress/checklist/comments are real form /
    // detail-dialog fields the old schema rejected. Status values match the
    // model's TODO | IN_PROGRESS | ON_HOLD | COMPLETED | CANCELLED set.
    // title/description are OPTIONAL because the detail dialog sends partial
    // updates ({ id, checklist } / { id, status, progress }) without them;
    // the handler enforces title presence on CREATE with a clean 400.
    id: idBlankOpt,
    title: textOpt(200),
    description: textOpt(3000),
    assigneeId: idBlankOpt,
    scope: upperEnum(["EMPLOYEE", "DEPARTMENT", "HR", "PAYROLL"]),
    priority: upperEnum(["LOW", "MEDIUM", "HIGH", "URGENT"]),
    status: upperEnum(["TODO", "IN_PROGRESS", "ON_HOLD", "COMPLETED", "CANCELLED"]),
    progress: z.preprocess(
      (v) => {
        if (v === "" || v === null || v === undefined) return undefined
        if (typeof v === "string") return v.trim() === "" ? undefined : Number(v)
        return v
      },
      z.number().int().min(0).max(100).nullish(),
    ),
    startDate: dateOpt,
    dueDate: dateOpt,
    departmentId: idBlankOpt,
    branchId: idBlankOpt,
    checklist: z.array(z.any()).nullish(), // [{text, done}]
    comments: z.array(z.any()).nullish(), // [{userId, userName, text, at}]
  }).strict(),

  bankSave: z.object({
    // M-01 — `verified` is deliberately NOT in the writable set: bank-account
    // verification flows through the dedicated employeeDocs.verify action.
    employeeId: id,
    holderName: textOpt(200),
    bank: textOpt(200),
    branch: textOpt(200),
    accountNumber: textOpt(50),
    routingNumber: textOpt(30),
    accountType: z.enum(["SAVINGS", "CURRENT", "SALARY"]).nullish(),
    ifsc: textOpt(20),
    swift: textOpt(20),
    currency: z.enum(["BDT", "USD", "EUR"]).nullish(),
  }).strict(),

  // ================= 2026-10 round: tracking / geo-fence / policies / payout =================

  /** GeoFence create/update (map-based config, §20). Geographic data only —
   *  no screenshots, no client-computed distances. */
  geofenceSave: z.object({
    id: idBlankOpt,
    name: z.string().min(1).max(120),
    branchId: idBlankOpt,
    type: z.literal("CIRCLE").nullish(), // POLYGON reserved for the future
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    radiusM: z.number().finite().min(10).max(100_000),
    geometryJson: textOpt(20_000),
    startTime: textOpt(5),
    endTime: textOpt(5),
    active: flag,
  }).strict(),

  /** AttendancePolicy create/update (§6–§7). configJson is validated per
   *  policyType in the route handler (typed zod sub-schemas). */
  policySave: z.object({
    id: idBlankOpt,
    name: z.string().min(1).max(120),
    policyType: z.enum(["TRACKING", "MANDATORY_GPS", "MULTIPLE_CHECKIN", "ATTENDANCE_METHOD", "ATTENDANCE_RULES"]),
    priority: intOpt,
    startDate: dateOpt,
    endDate: dateOpt,
    startTime: textOpt(5),
    endTime: textOpt(5),
    daysOfWeek: z.array(upperEnum(["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"])).nullish(),
    timezone: textOpt(60),
    active: flag,
    config: z.record(z.string(), z.any()).nullish(),
    assignments: z.array(z.object({
      scopeType: z.enum(["ALL_EMPLOYEES", "BRANCH", "DEPARTMENT", "EMPLOYEE"]),
      scopeId: idBlankOpt,
    })).nullish(),
    geoFenceIds: z.array(id).nullish(),
  }).strict(),

  /** Mobile location ping (§64). Client-declared signals (mock flag, provider)
   *  ride along as HINTS only — the server derives every decision itself. */
  trackingLocation: z.object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    accuracyM: z.number().finite().min(0).max(100_000).nullish(),
    altitude: z.number().finite().nullish(),
    speed: z.number().finite().min(0).nullish(),
    heading: z.number().finite().min(0).max(360).nullish(),
    batteryPercentage: z.number().int().min(0).max(100).nullish(),
    isCharging: flag,
    gpsStatus: upperEnum(["OK", "DISABLED", "LOW_ACCURACY"]),
    networkStatus: upperEnum(["ONLINE", "OFFLINE", "WEAK"]),
    clientTimestamp: textOpt(40),
    clientEventId: textOpt(80),
    isMockLocation: flag,
    provider: textOpt(40),
    deviceId: textOpt(120),
    trackingSessionId: textOpt(80),
  }).strict(),

  /** Mobile attendance action (check-in/out/periodic §22, §26, §30–§32). */
  attendanceAction: z.object({
    latitude: z.number().finite().min(-90).max(90).nullish(),
    longitude: z.number().finite().min(-180).max(180).nullish(),
    accuracyM: z.number().finite().min(0).max(100_000).nullish(),
    batteryPercentage: z.number().int().min(0).max(100).nullish(),
    isCharging: flag,
    gpsStatus: upperEnum(["OK", "DISABLED", "LOW_ACCURACY"]),
    networkStatus: upperEnum(["ONLINE", "OFFLINE", "WEAK"]),
    clientTimestamp: textOpt(40),
    clientEventId: textOpt(80),
    isMockLocation: flag,
    provider: textOpt(40),
    deviceId: textOpt(120),
    mobileSessionId: textOpt(80),
    selfieDataUrl: textOpt(2_500_000).nullish(), // ~1.8MB binary after base64
    selfieMimeType: textOpt(60),
    deviceInfo: textOpt(200),
  }).strict(),

  /** Salary export request (§48, §76). The export TYPE is a server-side
   *  filter, not a trust source — the server re-resolves every employee's
   *  true payout method (§77). */
  salaryExport: z.object({
    runId: id,
    type: z.enum(["ALL", "BANK", "CASH", "MFS"]),
    format: z.enum(["xlsx", "csv", "pdf"]),
    branchId: idBlankOpt,
    departmentId: idBlankOpt,
    employeeId: idBlankOpt,
  }).strict(),

  /** Payout selection on employee create/edit (§46). */
  payoutSelection: z.object({
    method: z.enum(["BANK", "CASH", "MFS"]).nullish(),
    bank: textOpt(200),
    branch: textOpt(200),
    holderName: textOpt(200),
    accountNumber: textOpt(50),
    routingNumber: textOpt(30),
    mfsProvider: upperEnum(["BKASH", "NAGAD", "ROCKET", "OTHER"]),
    mfsNumber: textOpt(30),
  }).strict(),

  // ---- Selfie Attendance G2/G3/G4 ----
  /** G2 — admin-side device registry lookup: the employee whose enrolled
   *  devices are listed / decided on. Shared by employeeDevices.list and any
   *  scoped admin surface. */
  employeeId: z.object({
    employeeId: id,
  }).passthrough(),

  /** G2 — employee self-enrolment of the device they are punching from. The
   *  deviceId is a client-generated stable identifier (uuid); the enrolment
   *  KEY is server-issued and returned ONCE. */
  myDeviceEnroll: z.object({
    deviceId: z.string().min(8).max(120),
    label: textOpt(80),
    platform: z.enum(["ANDROID", "IOS", "WEB", "UNKNOWN"]).nullish(),
    userAgent: textOpt(200),
  }).passthrough(),

  /** G2 — admin approve/revoke of an employee's enrolled device. */
  deviceDecision: z.object({
    id,
    decision: z.enum(["APPROVE", "REVOKE"]),
    reason: textOpt(200),
  }).passthrough(),

  /** G3 — employee acceptance of the selfie-capture consent (version comes
   *  from the vendor settings; the client may only echo it). */
  consentAccept: z.object({
    version: textOpt(40),
    userAgent: textOpt(200),
  }).passthrough(),

  /** G4 — attendance-event export: same filter set as events.list, no paging
   *  (row cap instead). */
  eventsExport: z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
    employeeId: z.string().nullish(),
    branchId: z.string().nullish(),
    departmentId: z.string().nullish(),
    eventType: z.string().nullish(),
    attendanceMethod: z.string().nullish(),
    status: z.string().nullish(),
    locationIntegrityStatus: z.string().nullish(),
    gpsStatus: z.string().nullish(),
    geoFenceId: z.string().nullish(),
    reviewStatus: z.string().nullish(),
    format: z.enum(["csv", "xlsx"]).nullish(),
  }).strict(),
}
