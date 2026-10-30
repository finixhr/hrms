// ============ Employee Master routes (spec §5) — central source of truth ============
import { db } from "@/lib/db"
import { route } from "./registry"
import { Deny, employeeScopeFilter, assertEmployeeVisible } from "../rbac"
import { audit, notify, auditDiff, auditPIIScrub } from "../audit"
import { isoDate, today, daysBetween, csv } from "../utils"
import { deactivateMappingsForEmployee } from "../zkteco/processor"
import { CLEARANCE_DEPARTMENTS, CLEARANCE_ITEMS } from "./exit"
import { nextEmployeeCode } from "../employee-code"
import { safePayload } from "../security"
import { getSettings } from "../settings"
import { webhookEmit } from "../webhooks"
import { structurePaisa, SALARY_MONEY_FIELDS } from "../money"
import { S } from "../validation"
import { z } from "zod"
import { validateNid } from "../../hrm/validators-bd"
import { maskDocNumber, isMaskedDocNumber } from "../../hrm/pii"
import { validateEmployeeDoc, sniffMime, decodeBase64Payload } from "../uploads"
import { applyPayoutSelection } from "../payout"
import { piiTextForStorage, encryptPiiFile, readPiiText, readPiiFileStrict, maskPiiNumber } from "../pii-field"
import {
  callerFieldAccess, projectRecord, stripDeniedWriteFields,
  type FieldAccess, type FieldGroup,
} from "../field-permissions"
import { requireCapacity , bumpStorageRollup } from "../saas/entitlements"
import { provisionAndNotify, deliverEmployeeCredentials, generateTempPassword } from "../employee-provisioning"
import { eventChannels } from "../delivery"

const _EMPLOYEE_SELECT = {
  // EMP-04 (R5) — the directory select list (previously dead code): list rows
  // carry ONLY identity-safe + contact + employment columns. Deep fields
  // (taxTin, salary payout config, otEligible, prior-employer tax figures)
  // never leave the server on this surface; the 360° employees.get remains
  // the full-profile surface behind field permissions.
  id: true, code: true, vendorId: true, photoUrl: true, photoThumb: true, fullName: true, nameBn: true, preferredName: true,
  fatherName: true, motherName: true, spouseName: true, dob: true, placeOfBirth: true,
  gender: true, bloodGroup: true, maritalStatus: true, nationality: true, religion: true,
  mobile: true, altMobile: true, personalEmail: true, officialEmail: true,
  emergencyName: true, emergencyRelation: true, emergencyMobile: true,
  presentAddress: true, permanentAddress: true, division: true, district: true, city: true, postCode: true,
  presentDivision: true, presentDistrict: true, presentCity: true, presentPostCode: true, addressSame: true,
  branchId: true, departmentId: true, designationId: true, reportingManagerId: true,
  hrManagerId: true, supervisorId: true, workLocation: true,
  joiningDate: true, confirmationDate: true, probationMonths: true,
  employmentType: true, status: true, category: true, grade: true, shiftId: true, weeklyOff: true,
  contractStart: true, contractEnd: true, createdAt: true, updatedAt: true,
}

/** C-3/H-5 — the only fields a create/update caller may set. vendorId, code
 * and id are server-controlled on create; code is immutable on update. Aligned
 * with the Employee model AND the client forms: otEligible /
 * previousEmployerIncome / taxAlreadyDeducted are exposed by the 360° edit
 * dialog (overtime & tax section) and were silently dropped before. Status
 * flows through the dedicated lifecycle/exit flows AND the edit form's status
 * select (validated server-side in the update handler). */
const EMPLOYEE_WRITABLE = [
  "photoUrl", "photoThumb", "fullName", "nameBn", "preferredName", "fatherName", "motherName", "spouseName",
  "dob", "placeOfBirth", "gender", "bloodGroup", "maritalStatus", "nationality", "religion",
  "mobile", "altMobile", "personalEmail", "officialEmail",
  "emergencyName", "emergencyRelation", "emergencyMobile",
  "presentAddress", "permanentAddress", "division", "district", "city", "postCode",
  "presentDivision", "presentDistrict", "presentCity", "presentPostCode", "addressSame",
  "branchId", "departmentId", "designationId", "reportingManagerId", "hrManagerId", "supervisorId", "workLocation",
  "joiningDate", "confirmationDate", "probationMonths", "employmentType", "category", "grade", "shiftId", "weeklyOff",
  "contractStart", "contractEnd",
  "otEligible", "previousEmployerIncome", "taxAlreadyDeducted",
  // 2026-10-14 — e-TIN captured at creation time (Employee create form → Tax
  // section) and editable from the 360° profile; feeds the AIT module's
  // per-employee tax profile and payslip AIT certificates.
  "taxTin",
  // EXT-05 (R7) — rehire linkage to the prior Employee row (validated in
  // prepareEmployeeCreate: same tenant + an exited status).
  "priorEmployeeId",
]

/** 2026-10-14 — e-TIN normalisation shared by create and update: trims the
 * input, strips separators, and validates the same 6–17 digit shape as the
 * AIT module's profile editor (routes/ait.ts). Empty clears the field. */
function normalizeTaxTin(v: unknown): string | null | undefined {
  if (v == null) return undefined // untouched — keep stored value
  const tin = String(v).replace(/[\s-]/g, "").trim()
  if (tin === "") return null
  if (!/^\d{6,17}$/.test(tin)) throw new Deny("TIN must be 6–17 digits (Bangladesh e-TIN is 12)", 400)
  return tin
}

/** Fields safePayload must coerce: numbers arriving as strings (FormDialog
 * number inputs) and booleans arriving as "true"/"false" strings. */
const EMPLOYEE_NUMERIC_FIELDS = ["probationMonths", "previousEmployerIncome", "taxAlreadyDeducted"]
const EMPLOYEE_BOOL_FIELDS = ["addressSame", "otEligible"]

// Weekly-off override on the employee record — same storage convention as
// shifts: uppercase comma list ("FRIDAY,SATURDAY"). Accepts an array from the
// multiselect UI or any separated string; invalid day names are dropped.
const WEEK_DAYS = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"]
function normalizeEmployeeWeeklyOff(v: unknown): string | null {
  if (v == null || v === "") return null
  const raw = Array.isArray(v) ? v : String(v).split(/[,\s]+/)
  const days = [...new Set(raw.map((d) => String(d).trim().toUpperCase()).filter((d) => (WEEK_DAYS as string[]).includes(d)))]
  return days.length ? days.join(",") : null
}

async function decorate(list: any[]) {
  if (!list.length) return []
  const vendorId = list[0].vendorId
  // FE-3 (Phase 2 WS4) — the manager-name join used to load the ENTIRE
  // employee table per decorated page (and every .find() was a linear scan).
  // Manager rows now come from one whereIn over the page's manager ids and
  // every name resolution goes through Maps built in a single pass.
  const managerIds = [...new Set(list.map((e) => e.reportingManagerId).filter((x): x is string => !!x))]
  const [branches, depts, desigs, shifts, mgrs] = await Promise.all([
    db.branch.findMany({ where: { vendorId }, select: { id: true, name: true } }),
    db.department.findMany({ where: { vendorId }, select: { id: true, name: true } }),
    db.designation.findMany({ where: { vendorId }, select: { id: true, name: true } }),
    db.shift.findMany({ where: { vendorId }, select: { id: true, name: true } }),
    managerIds.length
      ? db.employee.findMany({ where: { vendorId, id: { in: managerIds } }, select: { id: true, fullName: true } })
      : Promise.resolve([] as { id: string; fullName: string }[]),
  ])
  const branchById = new Map(branches.map((b) => [b.id, b.name]))
  const deptById = new Map(depts.map((d) => [d.id, d.name]))
  const desigById = new Map(desigs.map((d) => [d.id, d.name]))
  const shiftById = new Map(shifts.map((sh) => [sh.id, sh.name]))
  const mgrById = new Map(mgrs.map((m) => [m.id, m.fullName]))
  return list.map((e) => ({
    ...e,
    branchName: e.branchId ? branchById.get(e.branchId) : undefined,
    departmentName: e.departmentId ? deptById.get(e.departmentId) : undefined,
    designationName: e.designationId ? desigById.get(e.designationId) : undefined,
    shiftName: e.shiftId ? shiftById.get(e.shiftId) : undefined,
    managerName: e.reportingManagerId ? mgrById.get(e.reportingManagerId) : undefined,
  }))
}

route("employees.list", {
  perm: ["employees", "view"],
  handler: async (ctx, p) => {
    const where: any = employeeScopeFilter(ctx)
    if (p?.status) where.status = p.status
    if (p?.branchId) where.branchId = p.branchId
    if (p?.departmentId) where.departmentId = p.departmentId
    if (p?.employmentType) where.employmentType = p.employmentType
    if (p?.q) {
      // Directory search — matches employee ID code (e.g. EMP-0024), name,
      // mobile and both email addresses. `mode: "insensitive"` preserves the
      // SQLite-era behavior ("emp-0024" finds EMP-0024) on PostgreSQL (ILIKE).
      where.OR = [
        { fullName: { contains: p.q, mode: "insensitive" } }, { code: { contains: p.q, mode: "insensitive" } },
        { mobile: { contains: p.q, mode: "insensitive" } }, { officialEmail: { contains: p.q, mode: "insensitive" } },
        { personalEmail: { contains: p.q, mode: "insensitive" } },
      ]
    }
    // M-7 — server-side pagination with a hard ceiling. Paginated callers
    // (p.paginate) receive { rows, total }; legacy callers receive the capped list.
    const take = Math.min(Math.max(1, Number(p?.take) || 500), 1000)
    const skip = Math.max(0, Number(p?.skip) || 0)
    const [list, total] = await Promise.all([
      db.employee.findMany({ where, orderBy: { createdAt: "desc" }, select: _EMPLOYEE_SELECT, take, skip }),
      db.employee.count({ where }),
    ])
    const decorated = await decorate(list)
    // FLD-103 — list rows carry contact/employment columns; the same field-
    // permission projection as employees.get applies (salary/bank/identity are
    // not part of list rows). Cached settings make this a cheap resolver call.
    const listAccess = callerFieldAccess(await getSettings(ctx.vendorId), ctx.role)
    // 2026-10 round — linked portal-account existence per row (drives the
    // three-dot menu: "Create login account" vs "Reset login password").
    // One batched query for the whole page, existence flag only — no secrets.
    const accountRows = await db.user.findMany({
      where: { vendorId: ctx.vendorId, employeeId: { in: list.map((e: any) => e.id) } },
      select: { employeeId: true, status: true },
    })
    const accountMap = new Map(accountRows.map((u) => [u.employeeId, u.status]))
    // Photo payload slimming — list rows ship the 96×96 thumbnail (when one
    // exists) in place of the 512×512 photoUrl data URL. List/picker
    // consumers (directory rows, org chart, employee pickers) only render
    // small avatars; the 360° profile (employees.get) still serves the full
    // photoUrl. Rows uploaded before thumbnails existed keep their original
    // photoUrl (photoThumb is NULL → passthrough).
    const slim = decorated.map((e: any) => {
      const row: any = { ...e }
      if (row.photoThumb) row.photoUrl = row.photoThumb
      delete row.photoThumb
      row.hasUserAccount = accountMap.has(e.id)
      row.userAccountStatus = accountMap.get(e.id) || null
      return projectRecord(row, listAccess, { groups: ["contact", "employment"] })
    })
    if (p?.paginate) return { rows: slim, total, take, skip }
    return slim
  },
})

// ---------- FE-1 (Phase 2 WS4): lightweight picker directory ----------
// The client directory hook used to sweep the ENTIRE employee table into the
// browser (paged employees.list calls, rows carrying contact/employment
// columns + base64 photo thumbs — tens of MB at 10K employees) because every
// picker wanted id/code/fullName. This route returns exactly that triple
// with one indexed query; photo/contact columns never leave the server.
route("employees.refList", {
  perm: ["employees", "view"],
  handler: async (ctx, p) => {
    const where: any = employeeScopeFilter(ctx)
    if (p?.q) {
      where.OR = [
        { fullName: { contains: p.q, mode: "insensitive" } },
        { code: { contains: p.q, mode: "insensitive" } },
      ]
    }
    // bounded by ceiling; `truncated` tells the picker it should prefer
    // server-side search (q) over local filtering
    const take = Math.min(Math.max(1, Number(p?.take) || 10_000), 10_000)
    const [refs, total] = await Promise.all([
      db.employee.findMany({
        where,
        select: { id: true, code: true, fullName: true, status: true },
        orderBy: { fullName: "asc" },
        take,
      }),
      db.employee.count({ where }),
    ])
    return { refs, total, truncated: total > refs.length }
  },
})

// ---------- FE-3 (Phase 2 WS4): directory status cards in ONE groupBy ----------
// The directory used to fire six employees.list take:1 count RPCs per filter
// change, each running the full decorate() path (which itself scanned the
// whole employee table for manager names). One groupBy now returns every
// status count under the same filters.
route("employees.statusCounts", {
  perm: ["employees", "view"],
  handler: async (ctx, p) => {
    const where: any = employeeScopeFilter(ctx)
    if (p?.branchId) where.branchId = p.branchId
    if (p?.departmentId) where.departmentId = p.departmentId
    if (p?.employmentType) where.employmentType = p.employmentType
    if (p?.q) {
      where.OR = [
        { fullName: { contains: p.q, mode: "insensitive" } }, { code: { contains: p.q, mode: "insensitive" } },
        { mobile: { contains: p.q, mode: "insensitive" } }, { officialEmail: { contains: p.q, mode: "insensitive" } },
        { personalEmail: { contains: p.q, mode: "insensitive" } },
      ]
    }
    const rows = await db.employee.groupBy({ by: ["status"], _count: { _all: true }, where })
    const byStatus: Record<string, number> = {}
    let total = 0
    for (const r of rows) {
      byStatus[String(r.status)] = r._count._all
      total += r._count._all
    }
    return { total, counts: byStatus }
  },
})

// ================= RBAC-105 (Wave R3-5) — server-side directory export =================
// employees.export was granted by every default template but gated nothing:
// no route consumed the verb, and the directory's DataTable CSV button was
// generated client-side with NO permission check at all. This route makes the
// verb real — a scope-filtered directory CSV of NON-PII columns (no contact,
// no identity numbers, no salary data; the bulk-PII biodata export keeps its
// own reports.pii gate from R3-3), capped and audit-logged itself.
route("employees.exportCsv", {
  perm: ["employees", "export"],
  schema: z.object({
    status: z.string().optional(),
    branchId: z.string().optional(),
    departmentId: z.string().optional(),
    employmentType: z.string().optional(),
    q: z.string().optional(),
  }).strict(),
  handler: async (ctx, p) => {
    const where: any = employeeScopeFilter(ctx)
    if (p?.status) where.status = p.status
    if (p?.branchId) where.branchId = p.branchId
    if (p?.departmentId) where.departmentId = p.departmentId
    if (p?.employmentType) where.employmentType = p.employmentType
    if (p?.q) {
      where.OR = [
        { fullName: { contains: p.q, mode: "insensitive" } }, { code: { contains: p.q, mode: "insensitive" } },
      ]
    }
    const MAX_ROWS = 10_000
    const [emps, branches, depts, desigs] = await Promise.all([
      db.employee.findMany({ where, orderBy: { code: "asc" }, take: MAX_ROWS + 1, select: {
        code: true, fullName: true, designationId: true, departmentId: true, branchId: true,
        employmentType: true, grade: true, joiningDate: true, status: true,
      } }),
      db.branch.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } }),
      db.department.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } }),
      db.designation.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } }),
    ])
    const truncated = emps.length > MAX_ROWS
    const rows = truncated ? emps.slice(0, MAX_ROWS) : emps
    const nameOf = (list: { id: string; name: string }[], id: string | null) => list.find((x) => x.id === id)?.name || ""
    const out = csv([
      ["Code", "Name", "Designation", "Department", "Branch", "Employment Type", "Grade", "Joining Date", "Status"],
      ...rows.map((e) => [
        e.code, e.fullName, nameOf(desigs, e.designationId), nameOf(depts, e.departmentId), nameOf(branches, e.branchId),
        e.employmentType || "", e.grade || "", e.joiningDate || "", e.status || "",
      ]),
    ])
    await audit(ctx, "employees.export", "Employee", null,
      `Exported ${rows.length} directory row${rows.length === 1 ? "" : "s"} to CSV${truncated ? ` (capped at ${MAX_ROWS})` : ""}${p?.status ? ` · status ${p.status}` : ""}`)
    return { fileName: `employee-directory-${today()}.csv`, csv: out, count: rows.length, truncated }
  },
})

route("employees.get", {
  perm: ["employees", "view"],
  handler: async (ctx, p) => {
    const emp = await assertEmployeeVisible(ctx, p.id)
    // FLD-101 (Wave R3-3) — salary structure + revision history are withheld
    // SERVER-SIDE unless the caller holds payroll.view. The client's
    // "Confidential" mask was cosmetic: the full component breakdown (and
    // every historical revision) rode the RPC payload for anyone with the
    // profile permission. Mirrors the C-05 bank pattern: what the UI never
    // shows must not be on the wire either.
    const canSeeSalary = ctx.permissions.has("payroll.view") || ctx.permissions.has("*")
    // FLD-102 — identity document numbers (NID/passport/birth-reg) are BD-PII:
    // masked to last-4 unless the caller holds the dedicated reveal verb.
    // Full numbers remain available through the audited doc file download.
    const canRevealIdentity = ctx.permissions.has("employeeDocs.reveal") || ctx.permissions.has("*")
    // C-05 — bank account rows carry payment credentials: only callers holding
    // bankInfo.view get them at all, and even then the account number is masked
    // to its last 4 digits (full numbers never leave the server inline).
    const canSeeBanks = ctx.permissions.has("bankInfo.view")
    // FLD-103 (Wave R3-5) — field-level permission layer: per-role rules on 5
    // field groups (hrSettings.fieldPermissions) combined with the module-perm
    // outcomes above. MORE RESTRICTIVE WINS — a field rule can only narrow what
    // the route permission granted. Note the semantics per group:
    //   salary    — "mask" behaves as "none" for amounts (no meaningful
    //               partial form); salaryVisible mirrors the effective outcome.
    //   bank      — rows are last-4-masked for EVERYONE (C-05), so "full" and
    //               "mask" read identically; only "none" hides the rows.
    //   identity  — "full" needs the reveal verb too (combine does that);
    //               "mask" keeps the FLD-102 default; "none" hides numbers.
    //   contact / employment — projected on the employee object (and on
    //               employees.list rows): "none" nulls, "mask" masks contact
    //               values (employment has no partial form — "mask" ≡ "full").
    const fpSettings = await getSettings(ctx.vendorId)
    const access = callerFieldAccess(fpSettings, ctx.role, {
      salary: canSeeSalary ? "full" : null,
      bank: canSeeBanks ? "full" : null,
      identity: canRevealIdentity ? "full" : "mask",
    })
    const effSalary = access.salary === "full" // load structure/revisions? ("mask" has no partial form for amounts)
    const effBanks = access.bank !== "none" // bank rows always last-4-masked (C-05)
    const [
      branches, depts, desigs, shifts, structure, family, education, refs, prevEmp, banks,
      docs, docsWithFile, history, manager, promos, transfers, revisions, linkedUser,
      vendor, settings, hrManager, supervisor, assetAssignments,
    ] = await Promise.all([
      db.branch.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } }),
      db.department.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } }),
      db.designation.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } }),
      db.shift.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } }),
      // FLD-101 — not even LOADED for non-payroll viewers
      // FLD-103 — or for callers whose role's field rules hide the salary group
      effSalary
        ? db.salaryStructure.findFirst({ where: { employeeId: emp.id, status: "ACTIVE" } })
        : Promise.resolve(null),
      db.familyMember.findMany({ where: { employeeId: emp.id } }),
      db.education.findMany({ where: { employeeId: emp.id } }),
      db.referee.findMany({ where: { employeeId: emp.id } }),
      db.previousEmployment.findMany({ where: { employeeId: emp.id } }),
      effBanks
        ? db.bankAccount.findMany({
            where: { employeeId: emp.id },
            // C-05 — explicit select; accountNumber masked below, never returned raw
            select: { id: true, holderName: true, bank: true, branch: true, routingNumber: true, accountType: true, mfsProvider: true, paymentMethod: true, isPrimary: true, verified: true, accountNumber: true, mfsNumber: true },
          })
        : Promise.resolve([]),
      // C-05 — document file bytes (base64 fileData) must NEVER ride along with
      // the profile payload — not even loaded from the DB. They are downloadable
      // only through the audited employees.docs.download route.
      db.employeeDocument.findMany({
        where: { vendorId: ctx.vendorId, employeeId: emp.id },
        orderBy: { createdAt: "desc" },
        select: { id: true, category: true, docType: true, title: true, docNumber: true, nameOnDoc: true, issueDate: true, expiryDate: true, issuingAuthority: true, status: true, fileName: true, notes: true, verified: true, verifiedBy: true, verifiedAt: true, createdAt: true },
      }),
      // existence-only probe: which docs carry a file (drives the Download button)
      db.employeeDocument.findMany({ where: { vendorId: ctx.vendorId, employeeId: emp.id, fileData: { not: null } }, select: { id: true } }),
      db.employeeHistory.findMany({ where: { vendorId: ctx.vendorId, employeeId: emp.id }, orderBy: { createdAt: "desc" } }),
      emp.reportingManagerId ? db.employee.findUnique({ where: { id: emp.reportingManagerId }, select: { fullName: true } }) : null,
      db.promotion.findMany({ where: { vendorId: ctx.vendorId, employeeId: emp.id }, orderBy: { createdAt: "desc" } }),
      db.transfer.findMany({ where: { vendorId: ctx.vendorId, employeeId: emp.id }, orderBy: { createdAt: "desc" } }),
      // FLD-101 — revision history is as sensitive as the structure itself
      // FLD-103 — same field-layer gate as the structure itself
      effSalary
        ? db.salaryRevision.findMany({ where: { vendorId: ctx.vendorId, employeeId: emp.id }, orderBy: { createdAt: "desc" } })
        : Promise.resolve([]),
      // linked portal account (existence + status only — never secrets) for
      // the 360° profile and the directory action menu (reset password /
      // suspend gating)
      db.user.findFirst({
        where: { vendorId: ctx.vendorId, employeeId: emp.id },
        select: { id: true, email: true, status: true, role: true, lastLoginAt: true, mustChangePassword: true, lockedUntil: true },
      }),
      db.vendor.findUnique({
        where: { id: ctx.vendorId },
        select: { id: true, name: true, legalName: true, code: true, logoUrl: true, address: true, phone: true, email: true, signatoryName: true, signatoryDesignation: true },
      }),
      getSettings(ctx.vendorId),
      emp.hrManagerId ? db.employee.findUnique({ where: { id: emp.hrManagerId }, select: { fullName: true } }) : null,
      emp.supervisorId ? db.employee.findUnique({ where: { id: emp.supervisorId }, select: { fullName: true } }) : null,
      db.assetAssignment.findMany({
        where: { vendorId: ctx.vendorId, employeeId: emp.id, returnedAt: null },
        orderBy: { assignedAt: "desc" },
      }),
    ])
    const maskedBanks = banks.map((b) => ({
      ...b,
      // F28 (P6) — account/MFS numbers are encrypted at rest; maskPiiNumber
      // decrypts then masks, so the last-4 shown is always the REAL last-4.
      accountNumber: maskPiiNumber(b.accountNumber),
      mfsNumber: maskPiiNumber(b.mfsNumber),
    }))
    const hasFileIds = new Set(docsWithFile.map((d) => d.id))
    // FLD-102 + FLD-103 — every doc row's number follows the caller's effective
    // identity access: "full" (reveal verb + no field restriction) keeps the
    // raw number, "mask" shows last-4, "none" hides the number entirely.
    // (identity docs AND the rest: trade licences, contracts… all PII).
    const docMeta = docs.map((d) => ({
      ...d,
      // F28 (P6) — docNumber decrypts BEFORE the access projection so the
      // full/mask/none tiers apply to the REAL number (legacy plaintext rows
      // pass through readPiiText untouched).
      docNumber:
        access.identity === "full" ? readPiiText(d.docNumber)
        : access.identity === "mask" ? maskDocNumber(readPiiText(d.docNumber))
        : null,
      hasFile: hasFileIds.has(d.id),
    }))
    const linkedAccount = linkedUser
      ? {
          userId: linkedUser.id, email: linkedUser.email, status: linkedUser.status,
          role: linkedUser.role, lastLoginAt: linkedUser.lastLoginAt,
          mustChangePassword: linkedUser.mustChangePassword, locked: !!(linkedUser.lockedUntil && linkedUser.lockedUntil > new Date()),
        }
      : null

    let assignedAssets: any[] = []
    if (assetAssignments.length) {
      const assetIds = assetAssignments.map((a) => a.assetId)
      const assetList = await db.asset.findMany({
        where: { vendorId: ctx.vendorId, id: { in: assetIds } },
        select: {
          id: true, code: true, name: true, category: true, brandModel: true, serialImei: true, condition: true,
          purchaseDate: true, warrantyExpiry: true,
        },
      })
      const assetMap = new Map(assetList.map((a) => [a.id, a]))
      assignedAssets = assetAssignments.map((asg) => ({
        id: asg.id,
        assignedAt: asg.assignedAt,
        dueAt: asg.dueAt,
        conditionOut: asg.conditionOut,
        note: asg.note,
        asset: assetMap.get(asg.assetId) || null,
      })).filter((x) => x.asset)
    }

    const company = {
      name: vendor?.name || settings?.general?.companyName || "Finix HR",
      legalName: vendor?.legalName || settings?.general?.legalName || null,
      code: vendor?.code || null,
      logoUrl: vendor?.logoUrl || settings?.general?.logoUrl || null,
      address: vendor?.address || settings?.general?.address || null,
      phone: vendor?.phone || settings?.general?.phone || null,
      email: vendor?.email || settings?.general?.email || null,
      website: settings?.general?.website || null,
      binVatReg: settings?.general?.binVatReg || null,
      signatoryName: vendor?.signatoryName || settings?.general?.signatoryName || null,
      signatoryDesignation: vendor?.signatoryDesignation || settings?.general?.signatoryDesignation || null,
    }

    const decoratedPromos = promos.map((p) => ({
      ...p,
      oldDesignation: desigs.find((d) => d.id === p.oldDesignationId)?.name || p.oldDesignationId || null,
      newDesignation: desigs.find((d) => d.id === p.newDesignationId)?.name || p.newDesignationId || null,
      // EMP-01 — the promotions "Department & Grade" column reads
      // departmentName; without this decoration it rendered "—" forever.
      departmentName: depts.find((d) => d.id === p.newDepartmentId)?.name || null,
      oldDepartmentName: depts.find((d) => d.id === p.oldDepartmentId)?.name || null,
    }))

    const decoratedTransfers = transfers.map((t) => ({
      ...t,
      fromBranch: branches.find((b) => b.id === t.fromBranchId)?.name || t.fromBranchId || null,
      toBranch: branches.find((b) => b.id === t.toBranchId)?.name || t.toBranchId || null,
      fromDepartment: depts.find((d) => d.id === t.fromDepartmentId)?.name || t.fromDepartmentId || null,
      toDepartment: depts.find((d) => d.id === t.toDepartmentId)?.name || t.toDepartmentId || null,
    }))

    const primaryIdentityDoc = docs.find((d) => d.category === "IDENTITY" || ["NID", "PASSPORT", "BIRTH_REG", "DRIVING_LICENCE", "OTHER_ID"].includes(d.docType))
    // FLD-102 + FLD-103 — effective identity access decides the wire format.
    // F28 (P6) — docNumber decrypts BEFORE the projection (legacy plaintext
    // passes through readPiiText untouched).
    const primaryIdentityNumber = readPiiText(primaryIdentityDoc?.docNumber)
    const identityNumber =
      access.identity === "full" ? (primaryIdentityNumber || null)
      : access.identity === "mask" ? maskDocNumber(primaryIdentityNumber)
      : null

    // FLD-103 — the caller's effective field access rides the payload so the
    // client can disable edit-dialog sections (and render masks) without any
    // per-field logic of its own.
    return {
      employee: projectRecord({
        ...emp,
        branchName: branches.find((b) => b.id === emp.branchId)?.name,
        departmentName: depts.find((d) => d.id === emp.departmentId)?.name,
        designationName: desigs.find((d) => d.id === emp.designationId)?.name,
        shiftName: shifts.find((s) => s.id === emp.shiftId)?.name,
        managerName: manager?.fullName,
        hrManagerName: hrManager?.fullName,
        supervisorName: supervisor?.fullName,
        nid: identityNumber,
        identityType: primaryIdentityDoc?.docType || "NID",
        identityNumber,
        identityTitle: primaryIdentityDoc?.title || null,
        // FLD-101 — explicit markers so the client can render the affordance
        // ("Confidential") instead of guessing from nulls.
        salaryVisible: effSalary,
        identityNumberVisible: access.identity === "full",
      }, access),
      company,
      structure, family, education, references: refs, prevEmployment: prevEmp, banks: maskedBanks, docs: docMeta, history,
      promotions: decoratedPromos, transfers: decoratedTransfers, revisions, linkedAccount,
      assignedAssets,
      fieldAccess: access,
      // EXT-05 (R7) — rehire linkage: the prior service record this employee
      // was linked to at creation (id/name/code/status/joining date), so the
      // 360° timeline can offer "view prior service history".
      priorEmployee: (emp as any).priorEmployeeId
        ? await db.employee.findFirst({ where: { id: (emp as any).priorEmployeeId, vendorId: ctx.vendorId }, select: { id: true, code: true, fullName: true, status: true, joiningDate: true } })
        : null,
      // EMP-12 (R6) — the org lookup tables stay (they are tens of rows); the
      // employee DIRECTORY left the payload: every people-picker consumes the
      // cached employees.refList (id/code/fullName) instead, so opening a
      // 360° profile no longer loads the whole tenant (the audit's "manager
      // pickers" finding — at 10K employees this was a directory per open).
      lookups: { branches, departments: depts, designations: desigs, shifts },
    }
  },
})

route("employees.create", {
  schema: S.employeesSave,
  perm: ["employees", "create"],
  handler: async (ctx, p) => {
    // SaaS plan capacity — server-side seat check (LEGACY tenants pass)
    await requireCapacity(ctx.vendorId, "EMPLOYEES", 1)
    const { code, payload, stripped } = await prepareEmployeeCreate(ctx, p)
    const emp = await db.employee.create({
      data: {
        ...payload,
        vendorId: ctx.vendorId, // forced AFTER the spread — tenant can never be overridden
        code,
      } as any,
    })
    const rawIdNum = p.identityNumber || p.nid
    if (rawIdNum) {
      const docNumber = String(rawIdNum).trim()
      if (docNumber) {
        const docType = (p.identityType ? String(p.identityType).toUpperCase() : "NID")
        const title = docType === "NID" ? "National ID Card" : docType === "PASSPORT" ? "Passport" : docType === "BIRTH_REG" ? "Birth Registration Certificate" : "Identity Document"
        await db.employeeDocument.create({
          data: {
            vendorId: ctx.vendorId,
            employeeId: emp.id,
            category: "IDENTITY",
            docType,
            title,
            // F28 (P6) — identity numbers encrypt at the storage boundary
            docNumber: piiTextForStorage(docNumber),
            nameOnDoc: emp.fullName,
            status: "VALID",
            verified: true,
            verifiedBy: ctx.userId,
            verifiedAt: new Date(),
          },
        })
      }
    }
    // welcome notification + history event
    await db.employeeHistory.create({
      data: {
        vendorId: ctx.vendorId, employeeId: emp.id, eventType: "JOINED",
        title: "Joined the organization", description: `${emp.fullName} joined as employee ${emp.code}`,
        effectiveDate: emp.joiningDate || isoDate(new Date()), createdBy: ctx.userId,
      },
    })
    await audit(ctx, "employees.create", "Employee", emp.id, `Created employee ${emp.fullName} (${emp.code})`, { newValue: { code, fullName: p.fullName, branchId: p.branchId, departmentId: p.departmentId }, ...(stripped.length ? { fieldPermissionsWithheld: [...new Set(stripped)] } : {}) })
    // Wave 4 WP-C — outbound webhook (fire-and-forget, delivery-log-backed)
    void webhookEmit(ctx.vendorId, "employee.created", { id: emp.id, code, fullName: emp.fullName })
    await notify(ctx.vendorId, { role: "HR_ADMIN" }, "New Employee Added", `${emp.fullName} (${emp.code}) joined.`, "SYSTEM", "employees")
    // Auto-provision the linked EMPLOYEE user account + temporary
    // credentials (matrix-controlled delivery). Best-effort: a provisioning
    // skip (no email / duplicate / capacity) never fails the creation.
    const account = await provisionAndNotify(ctx.vendorId, emp.id, { userId: ctx.userId, userName: ctx.userName })
    return { id: emp.id, code, account: accountSummary(account) }
  },
})

/** M-03 — one atomic RPC for "employee + initial salary structure". The old
 *  client flow chained employees.create → salaryStructures.save; a failure
 *  between the two left an employee without a structure (and a user holding
 *  only employees.create could never complete the compound operation). The
 *  whole thing — employee row, JOINED history event, initial structure (with
 *  H-09 paisa dual-write), audits — is one $transaction: it either lands
 *  completely or not at all. Requires employees.create; payroll.edit is
 *  additionally required only when a structure is actually written
 *  (basic > 0). */
route("employees.createWithStructure", {
  schema: S.employeesSave,
  perm: ["employees", "create"],
  handler: async (ctx, p) => {
    // SaaS plan capacity — same seat check as employees.create
    await requireCapacity(ctx.vendorId, "EMPLOYEES", 1)
    const basic = Number(p.basic || 0)
    // payroll.edit is only needed when the call actually WRITES a salary
    // structure (basic > 0). The previous unconditional check locked every
    // role without payroll.edit out of the client's ONLY create path, even
    // for employees created without an initial structure.
    if (basic > 0 && !ctx.permissions.has("payroll.edit") && !ctx.permissions.has("*")) {
      throw new Deny("Creating an employee with a salary structure also requires payroll edit permission", 403)
    }
    const { code, payload, stripped } = await prepareEmployeeCreate(ctx, p)
    const emp = await db.$transaction(async (tx) => {
      const created = await tx.employee.create({
        data: { ...payload, vendorId: ctx.vendorId, code } as any,
      })
      await tx.employeeHistory.create({
        data: {
          vendorId: ctx.vendorId, employeeId: created.id, eventType: "JOINED",
          title: "Joined the organization", description: `${created.fullName} joined as employee ${created.code}`,
          effectiveDate: created.joiningDate || isoDate(new Date()), createdBy: ctx.userId,
        },
      })
      const rawIdNum = p.identityNumber || p.nid
      if (rawIdNum) {
        const docNumber = String(rawIdNum).trim()
        if (docNumber) {
          const docType = (p.identityType ? String(p.identityType).toUpperCase() : "NID")
          const title = docType === "NID" ? "National ID Card" : docType === "PASSPORT" ? "Passport" : docType === "BIRTH_REG" ? "Birth Registration Certificate" : "Identity Document"
          await tx.employeeDocument.create({
            data: {
              vendorId: ctx.vendorId,
              employeeId: created.id,
              category: "IDENTITY",
              docType,
              title,
              // F28 (P6) — identity numbers encrypt at the storage boundary
              docNumber: piiTextForStorage(docNumber),
              nameOnDoc: created.fullName,
              status: "VALID",
              verified: true,
              verifiedBy: ctx.userId,
              verifiedAt: new Date(),
            },
          })
        }
      }
      if (basic > 0) {
        const comps: Record<string, number> = {}
        let gross = 0
        for (const f of SALARY_MONEY_FIELDS) {
          const v = Number((p as any)[f] || 0)
          comps[f] = v
          gross += v
        }
        gross = Math.round(gross)
        await tx.salaryStructure.create({
          data: {
            vendorId: ctx.vendorId, employeeId: created.id, status: "ACTIVE",
            effectiveFrom: created.joiningDate || isoDate(new Date()), createdBy: ctx.userId,
            // H-09/H-8 — paisa dual-write via the shared helper (same
            // convention as every other structure write path)
            ...comps, gross, ...structurePaisa({ ...comps, gross }),
            componentsJson: "[]",
          } as any,
        })
      }
      // 2026-10 round §46 — Salary & Payout section: employee + structure +
      // payout account land atomically. applyPayoutSelection re-validates the
      // method against the payout settings and the actual gross (server-side,
      // never frontend-only §45). ctx.vendorId is passed explicitly — the
      // employee row exists only inside THIS uncommitted transaction.
      if (p.payoutMethod) {
        const grossForPayout = basic > 0
          ? Math.round(["basic", "houseRent", "medical", "conveyance", "food", "mobileAllow", "internetAllow", "attendanceAllow", "otherAllowance"].reduce((s, f) => s + Number((p as any)[f] || 0), 0))
          : 0
        await applyPayoutSelection(tx, created.id, ctx.vendorId, p.payoutMethod as "BANK" | "CASH" | "MFS", grossForPayout, {
          bank: p.payoutBank ?? null,
          branch: p.payoutBranch ?? null,
          holderName: p.payoutAccountName ?? null,
          accountNumber: p.payoutAccountNumber ?? null,
          routingNumber: p.payoutRoutingNumber ?? null,
          mfsProvider: p.payoutMfsProvider ?? null,
          mfsNumber: p.payoutMfsNumber ?? null,
        })
      }
      return created
    }, { timeout: 30_000, maxWait: 10_000 })
    await audit(ctx, "employees.create", "Employee", emp.id, `Created employee ${emp.fullName} (${emp.code})`, { newValue: { code, fullName: p.fullName, branchId: p.branchId, departmentId: p.departmentId }, ...(stripped.length ? { fieldPermissionsWithheld: [...new Set(stripped)] } : {}) })
    if (basic > 0) {
      await audit(ctx, "salaryStructures.create", "SalaryStructure", emp.id, `Initial structure for ${emp.fullName} (basic ৳${basic}) created atomically with the employee record`)
    }
    if (p.payoutMethod) {
      await audit(ctx, "payout.method.set", "Employee", emp.id, `Salary payout method set to ${p.payoutMethod} for ${emp.fullName} (${emp.code}) at creation`)
    }
    await notify(ctx.vendorId, { role: "HR_ADMIN" }, "New Employee Added", `${emp.fullName} (${emp.code}) joined.`, "SYSTEM", "employees")
    // Auto-provision the linked EMPLOYEE user account + temporary
    // credentials (matrix-controlled delivery). Best-effort AFTER the
    // transaction commits: a provisioning skip (no email / duplicate /
    // capacity) or a delivery failure never rolls the employee back.
    const account = await provisionAndNotify(ctx.vendorId, emp.id, { userId: ctx.userId, userName: ctx.userName })
    return { id: emp.id, code, account: accountSummary(account) }
  },
})

/** Account-provisioning summary for RPC responses — carries the plaintext
 *  temporary password ONLY when no channel could deliver it (both Email and
 *  SMS off or undeliverable) so the authorized creator can hand it over once.
 *  Never persisted, never logged. */
function accountSummary(account: Awaited<ReturnType<typeof provisionAndNotify>>) {
  const p = account.provision
  const d = account.delivery
  const nothingDelivered = !d || (d.email !== "SENT" && d.sms !== "SENT")
  return {
    status: p.status,
    email: p.email || null,
    detail: p.detail || null,
    emailStatus: d?.email || "NA",
    smsStatus: d?.sms || "NA",
    // one-time reveal for the authorized admin — only when undeliverable
    ...(p.status === "CREATED" && nothingDelivered && p.tempPassword ? { tempPassword: p.tempPassword } : {}),
  }
}

/** Shared employee-create payload prep (code generation + C-3 whitelist +
 *  status/weekday normalization). Used by employees.create and the atomic
 *  employees.createWithStructure compound action. */
async function prepareEmployeeCreate(ctx: any, p: any): Promise<{ code: string; payload: Record<string, any>; stripped: string[] }> {
  // Employee ID scheme from Settings → Employee (prefix/suffix/start/pad).
  // Manually supplied codes are honored as-is; the generated sequence scans
  // for the first unused number so it never collides with existing records.
  let code = p.code
  if (!code || String(code).trim() === "") {
    // 2026-10 import round — ONE shared allocator (employee-code.ts) now backs
    // BOTH the interactive create paths and the bulk importer, so serial
    // numbers stay chronological/sequential no matter which surface mints
    // them. M-7 semantics preserved: atomic SequenceCounter + bounded
    // advance-past-collision loop.
    code = await nextEmployeeCode(ctx.vendorId)
  }
  if (p.joiningDate) {
    const d = new Date(p.joiningDate + "T00:00:00")
    if (d > new Date()) throw new Deny("Joining date cannot be in the future")
  }
  // C-3 — explicit field whitelist; vendorId/id/code are NEVER taken
  // from the payload (cross-tenant record creation is impossible).
  const safe = safePayload<any>(p, EMPLOYEE_WRITABLE, { numericFields: EMPLOYEE_NUMERIC_FIELDS, boolFields: EMPLOYEE_BOOL_FIELDS })
  // FLD-103 — field-layer whitelist: groups the caller's role may not write
  // are STRIPPED (not rejected — a full-form save still lands for the allowed
  // fields); the stripped key list is returned so the create handlers can
  // audit the withheld attempt.
  const fpAccess = callerFieldAccess(await getSettings(ctx.vendorId), ctx.role)
  const { payload, stripped } = stripDeniedWriteFields(safe, fpAccess)
  // employeeSettings.defaultProbationMonths fills ONLY when the caller left
  // the value empty — manually entered values always win (backward compatible)
  if (payload.probationMonths == null) {
    const es = (await getSettings(ctx.vendorId)).employeeSettings
    if (es.defaultProbationMonths > 0) payload.probationMonths = es.defaultProbationMonths
  }
  // EXT-05 (R7) — rehire linkage: the prior row must be THIS tenant's and
  // must actually be a prior employment (an exited status). Linking to an
  // ACTIVE employee would create a nonsensical self-reference.
  if (payload.priorEmployeeId) {
    const prior = await db.employee.findFirst({
      where: { id: payload.priorEmployeeId, vendorId: ctx.vendorId, status: { in: ["RESIGNED", "TERMINATED", "RETIRED", "INACTIVE"] } },
      select: { id: true, fullName: true, status: true },
    })
    if (!prior) throw new Deny("The prior-employee link must reference a former employee of this organization (resigned, terminated, retired or archived)", 400)
  }
  // “Present address same as permanent” tick (spec §5.1) — enforced server-side
  if (payload.addressSame === true) {
    if (payload.permanentAddress !== undefined) payload.presentAddress = payload.permanentAddress
    if (payload.division !== undefined) payload.presentDivision = payload.division
    if (payload.district !== undefined) payload.presentDistrict = payload.district
    if (payload.city !== undefined) payload.presentCity = payload.city
    if (payload.postCode !== undefined) payload.presentPostCode = payload.postCode
  }
  if ("weeklyOff" in payload) payload.weeklyOff = normalizeEmployeeWeeklyOff(payload.weeklyOff)
  // 2026-10-14 — e-TIN: normalise + validate (same 6–17 digit rule as the AIT module)
  const tin = normalizeTaxTin((p as any).taxTin)
  if (tin !== undefined) payload.taxTin = tin
  // normalize case-sensitive selects defensively (the zod schema uppercases
  // them already; bulk import and API callers rely on this too)
  if (typeof payload.gender === "string") payload.gender = payload.gender.toUpperCase()
  if (typeof payload.maritalStatus === "string") payload.maritalStatus = payload.maritalStatus.toUpperCase()
  if (typeof payload.employmentType === "string") payload.employmentType = payload.employmentType.toUpperCase()
  // status is server-validated (never a free-form payload key)
  const EMPLOYEE_STATUSES = ["ACTIVE", "PROBATION", "ON_LEAVE", "SUSPENDED", "INACTIVE", "RESIGNED", "TERMINATED", "RETIRED", "EXITED"]
  payload.status = EMPLOYEE_STATUSES.includes(p.status) ? p.status : "PROBATION"

  // Phase 4: Authoritative server-side validation & business constraints on employee creation
  if (payload.fullName !== undefined && (!payload.fullName || String(payload.fullName).trim().length < 2)) {
    throw new Deny("Full Name is required (minimum 2 characters)", 400)
  }
  if (payload.dob) {
    const d = new Date(payload.dob + "T00:00:00")
    if (isNaN(d.getTime())) throw new Deny("Invalid Date of Birth", 400)
    if (d > new Date()) throw new Deny("Date of birth cannot be in the future", 400)
  }
  if (payload.confirmationDate && payload.joiningDate) {
    const joinD = new Date(payload.joiningDate + "T00:00:00")
    const confD = new Date(payload.confirmationDate + "T00:00:00")
    if (confD < joinD) throw new Deny("Confirmation date cannot precede joining date", 400)
  }
  if (payload.contractEnd && payload.contractStart) {
    const startD = new Date(payload.contractStart + "T00:00:00")
    const endD = new Date(payload.contractEnd + "T00:00:00")
    if (endD < startD) throw new Deny("Contract end date cannot precede contract start date", 400)
  }
  if (payload.personalEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(payload.personalEmail).trim())) {
    throw new Deny("Invalid personal email address format", 400)
  }
  if (payload.officialEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(payload.officialEmail).trim())) {
    throw new Deny("Invalid official email address format", 400)
  }
  if (payload.probationMonths != null && (payload.probationMonths < 0 || isNaN(payload.probationMonths))) {
    throw new Deny("Probation period must be 0 or more months", 400)
  }

  // Identity document validation
  const rawIdNum = p.identityNumber !== undefined ? p.identityNumber : p.nid
  if (rawIdNum) {
    if (isMaskedDocNumber(rawIdNum)) {
      throw new Deny("The identity number field contains the masked value — re-enter the full number (or leave it empty to keep the stored one)", 400)
    }
    const docType = (p.identityType ? String(p.identityType).toUpperCase() : "NID")
    if (docType === "NID") {
      const nidCheck = validateNid(rawIdNum)
      if (!nidCheck.ok) throw new Deny(nidCheck.message, 400)
    }
  }

  // Referential verification within tenant scope
  if (payload.branchId) {
    const b = await db.branch.findFirst({ where: { id: payload.branchId, vendorId: ctx.vendorId } })
    if (!b) throw new Deny("Selected branch does not belong to your organization", 400)
  }
  if (payload.departmentId) {
    const d = await db.department.findFirst({ where: { id: payload.departmentId, vendorId: ctx.vendorId } })
    if (!d) throw new Deny("Selected department does not belong to your organization", 400)
  }
  if (payload.designationId) {
    const des = await db.designation.findFirst({ where: { id: payload.designationId, vendorId: ctx.vendorId } })
    if (!des) throw new Deny("Selected designation does not belong to your organization", 400)
  }
  if (payload.shiftId) {
    const s = await db.shift.findFirst({ where: { id: payload.shiftId, vendorId: ctx.vendorId } })
    if (!s) throw new Deny("Selected shift does not belong to your organization", 400)
  }
  if (payload.reportingManagerId) {
    const m = await db.employee.findFirst({ where: { id: payload.reportingManagerId, vendorId: ctx.vendorId } })
    if (!m) throw new Deny("Selected reporting manager does not exist", 400)
  }
  if (payload.supervisorId) {
    const sup = await db.employee.findFirst({ where: { id: payload.supervisorId, vendorId: ctx.vendorId } })
    if (!sup) throw new Deny("Selected supervisor does not exist", 400)
  }
  if (payload.hrManagerId) {
    const hr = await db.employee.findFirst({ where: { id: payload.hrManagerId, vendorId: ctx.vendorId } })
    if (!hr) throw new Deny("Selected HR manager does not exist", 400)
  }

  return { code, payload, stripped }
}

route("employees.update", {
  schema: S.employeesSave,
  perm: ["employees", "edit"],
  handler: async (ctx, p) => {
    const existing = await assertEmployeeVisible(ctx, p.id)
    // H-5 — whitelist discipline on update as well
    const safe = safePayload<any>(p, EMPLOYEE_WRITABLE, { numericFields: EMPLOYEE_NUMERIC_FIELDS, boolFields: EMPLOYEE_BOOL_FIELDS })
    // “Present address same as permanent” tick (spec §5.1) — enforced server-side
    if (safe.addressSame === true) {
      safe.presentAddress = (safe.permanentAddress !== undefined ? safe.permanentAddress : existing?.permanentAddress) ?? null
      safe.presentDivision = (safe.division !== undefined ? safe.division : existing?.division) ?? null
      safe.presentDistrict = (safe.district !== undefined ? safe.district : existing?.district) ?? null
      safe.presentCity = (safe.city !== undefined ? safe.city : existing?.city) ?? null
      safe.presentPostCode = (safe.postCode !== undefined ? safe.postCode : existing?.postCode) ?? null
    }
    if ("weeklyOff" in safe) safe.weeklyOff = normalizeEmployeeWeeklyOff(safe.weeklyOff)
    // 2026-10-14 — e-TIN: normalise + validate (same 6–17 digit rule as the AIT module)
    const tinUpd = normalizeTaxTin((p as any).taxTin)
    if (tinUpd !== undefined) safe.taxTin = tinUpd
    // FLD-103 (Wave R3-5) — field-layer write whitelist: groups the caller's
    // role may not edit are STRIPPED after every derivation (so copied contact
    // values are caught too). The save still lands for the allowed fields;
    // the withheld keys are audit-noted below so probing is visible.
    const updAccess = callerFieldAccess(await getSettings(ctx.vendorId), ctx.role)
    const { payload: data, stripped: fpStripped } = stripDeniedWriteFields(safe, updAccess)
    // Prevent self-reporting references / circular approval loops
    if (data.reportingManagerId && data.reportingManagerId === p.id) {
      throw new Deny("An employee cannot be their own reporting manager", 400)
    }
    if (data.supervisorId && data.supervisorId === p.id) {
      throw new Deny("An employee cannot be their own supervisor", 400)
    }
    if (data.hrManagerId && data.hrManagerId === p.id) {
      throw new Deny("An employee cannot be their own HR manager", 400)
    }
    // Status: the edit form exposes a status select, and the handler below has
    // always recorded a STATUS_CHANGE history event on transitions — the old
    // whitelist silently dropped the field, making both dead. Only validated
    // statuses are accepted; anything else leaves the status untouched.
    const UPDATEABLE_STATUSES = ["ACTIVE", "PROBATION", "ON_LEAVE", "SUSPENDED", "INACTIVE", "RESIGNED", "TERMINATED", "RETIRED"]
    if (typeof p.status === "string" && UPDATEABLE_STATUSES.includes(p.status)) {
      data.status = p.status
    }
    if (typeof data.gender === "string") data.gender = data.gender.toUpperCase()
    if (typeof data.maritalStatus === "string") data.maritalStatus = data.maritalStatus.toUpperCase()
    if (typeof data.employmentType === "string") data.employmentType = data.employmentType.toUpperCase()

    // Phase 4: Authoritative server-side validation & business constraints
    if (data.fullName !== undefined && (!data.fullName || String(data.fullName).trim().length < 2)) {
      throw new Deny("Full Name is required (minimum 2 characters)", 400)
    }
    if (data.dob) {
      const d = new Date(data.dob + "T00:00:00")
      if (isNaN(d.getTime())) throw new Deny("Invalid Date of Birth", 400)
      if (d > new Date()) throw new Deny("Date of birth cannot be in the future", 400)
    }
    const effectiveJoining = data.joiningDate || existing.joiningDate
    if (data.confirmationDate && effectiveJoining) {
      const joinD = new Date(effectiveJoining + "T00:00:00")
      const confD = new Date(data.confirmationDate + "T00:00:00")
      if (confD < joinD) throw new Deny("Confirmation date cannot precede joining date", 400)
    }
    const effectiveContractStart = data.contractStart || existing.contractStart
    if (data.contractEnd && effectiveContractStart) {
      const startD = new Date(effectiveContractStart + "T00:00:00")
      const endD = new Date(data.contractEnd + "T00:00:00")
      if (endD < startD) throw new Deny("Contract end date cannot precede contract start date", 400)
    }
    if (data.personalEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(data.personalEmail).trim())) {
      throw new Deny("Invalid personal email address format", 400)
    }
    if (data.officialEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(data.officialEmail).trim())) {
      throw new Deny("Invalid official email address format", 400)
    }
    if (data.probationMonths != null && (data.probationMonths < 0 || isNaN(data.probationMonths))) {
      throw new Deny("Probation period must be 0 or more months", 400)
    }
    if (data.previousEmployerIncome != null && (data.previousEmployerIncome < 0 || isNaN(data.previousEmployerIncome))) {
      throw new Deny("Previous employer income must be a non-negative amount", 400)
    }
    if (data.taxAlreadyDeducted != null && (data.taxAlreadyDeducted < 0 || isNaN(data.taxAlreadyDeducted))) {
      throw new Deny("Tax already deducted must be a non-negative amount", 400)
    }

    // Referential verification within tenant scope
    if (data.branchId) {
      const b = await db.branch.findFirst({ where: { id: data.branchId, vendorId: ctx.vendorId } })
      if (!b) throw new Deny("Selected branch does not belong to your organization", 400)
    }
    if (data.departmentId) {
      const d = await db.department.findFirst({ where: { id: data.departmentId, vendorId: ctx.vendorId } })
      if (!d) throw new Deny("Selected department does not belong to your organization", 400)
    }
    if (data.designationId) {
      const des = await db.designation.findFirst({ where: { id: data.designationId, vendorId: ctx.vendorId } })
      if (!des) throw new Deny("Selected designation does not belong to your organization", 400)
    }
    if (data.shiftId) {
      const s = await db.shift.findFirst({ where: { id: data.shiftId, vendorId: ctx.vendorId } })
      if (!s) throw new Deny("Selected shift does not belong to your organization", 400)
    }
    if (data.reportingManagerId) {
      const m = await db.employee.findFirst({ where: { id: data.reportingManagerId, vendorId: ctx.vendorId } })
      if (!m) throw new Deny("Selected reporting manager does not exist", 400)
    }
    if (data.supervisorId) {
      const sup = await db.employee.findFirst({ where: { id: data.supervisorId, vendorId: ctx.vendorId } })
      if (!sup) throw new Deny("Selected supervisor does not exist", 400)
    }
    if (data.hrManagerId) {
      const hr = await db.employee.findFirst({ where: { id: data.hrManagerId, vendorId: ctx.vendorId } })
      if (!hr) throw new Deny("Selected HR manager does not exist", 400)
    }

    const emp = await db.employee.update({ where: { id: p.id }, data })
    if (existing.status !== emp.status) {
      await db.employeeHistory.create({
        data: { vendorId: ctx.vendorId, employeeId: emp.id, eventType: "STATUS_CHANGE", title: `Status: ${existing.status} → ${emp.status}`, effectiveDate: isoDate(new Date()), createdBy: ctx.userId },
      })
    }
    // 2026-10-15 — Identity document (NID / Birth Reg / Passport) update/upsert
    // FLD-102 guard: a masked value round-tripped from a redacted read is
    // treated as UNCHANGED — a profile edit by a non-reveal viewer must never
    // overwrite the stored number with bullets.
    // FLD-103 — a role whose field rules hide the identity group cannot rewrite
    // the identity document either (read-none implies write-none).
    const identityWritable = updAccess.identity !== "none"
    const rawIdNum0 = p.identityNumber !== undefined ? p.identityNumber : p.nid
    const rawIdNum = isMaskedDocNumber(rawIdNum0) ? undefined : rawIdNum0
    if (identityWritable && (rawIdNum !== undefined || (p.identityType !== undefined && !isMaskedDocNumber(rawIdNum0)))) {
      const existingDoc = await db.employeeDocument.findFirst({
        where: {
          vendorId: ctx.vendorId,
          employeeId: p.id,
          OR: [
            { category: "IDENTITY" },
            { docType: { in: ["NID", "PASSPORT", "BIRTH_REG", "DRIVING_LICENCE", "OTHER_ID"] } },
          ],
        },
        orderBy: { createdAt: "desc" },
      })
      const docType = (p.identityType ? String(p.identityType).toUpperCase() : (existingDoc?.docType || "NID"))
      const title = docType === "NID" ? "National ID Card" : docType === "PASSPORT" ? "Passport" : docType === "BIRTH_REG" ? "Birth Registration Certificate" : "Identity Document"
      const docNumber = rawIdNum !== undefined ? (rawIdNum ? String(rawIdNum).trim() : null) : (existingDoc?.docNumber ?? null)

      if (existingDoc) {
        await db.employeeDocument.update({
          where: { id: existingDoc.id },
          data: {
            category: "IDENTITY",
            docType,
            title,
            // F28 (P6) — encrypt at the storage boundary. piiTextForStorage
            // passes the KEPT stored ciphertext through untouched (rawIdNum
            // undefined → docNumber came from existingDoc), so an unrelated
            // edit never re-encrypts or corrupts the stored number.
            docNumber: piiTextForStorage(docNumber),
            nameOnDoc: p.fullName || existing.fullName,
          },
        })
      } else if (docNumber) {
        await db.employeeDocument.create({
          data: {
            vendorId: ctx.vendorId,
            employeeId: p.id,
            category: "IDENTITY",
            docType,
            title,
            // F28 (P6) — identity numbers encrypt at the storage boundary
            docNumber: piiTextForStorage(docNumber),
            nameOnDoc: p.fullName || existing.fullName,
            status: "VALID",
            verified: true,
            verifiedBy: ctx.userId,
            verifiedAt: new Date(),
          },
        })
      }
    }
    // 2026-10 round §46/§45 — payout-method change on employee edit: re-validate
    // against the ACTIVE salary structure (server-side enforcement point).
    // FLD-103 — payout fields are the bank group's write surface: a role with
    // bank "none" cannot redirect salary payouts.
    if (p.payoutMethod && updAccess.bank !== "none") {
      const structure = await db.salaryStructure.findFirst({ where: { employeeId: emp.id, status: "ACTIVE" }, orderBy: { effectiveFrom: "desc" } })
      const payoutBefore = { method: (existing as any).salaryPayoutMethod ?? null, accountId: (existing as any).salaryPayoutAccountId ?? null }
      await db.$transaction(async (tx) => {
        await applyPayoutSelection(tx, emp.id, ctx.vendorId, p.payoutMethod as "BANK" | "CASH" | "MFS", structure?.gross ?? 0, {
          bank: p.payoutBank ?? null,
          branch: p.payoutBranch ?? null,
          holderName: p.payoutAccountName ?? null,
          accountNumber: p.payoutAccountNumber ?? null,
          routingNumber: p.payoutRoutingNumber ?? null,
          mfsProvider: p.payoutMfsProvider ?? null,
          mfsNumber: p.payoutMfsNumber ?? null,
        })
      })
      await audit(ctx, "payout.method.set", "Employee", emp.id,
        `Salary payout method for ${emp.fullName} (${emp.code}) set to ${p.payoutMethod}${structure ? ` (gross ৳${structure.gross.toLocaleString("en-IN")})` : " (no active structure)"}`,
        { oldValue: payoutBefore, newValue: { method: p.payoutMethod } })
    }
    // M-13 — store the CHANGED-FIELDS diff (PII keys masked), never the whole row.
    // FLD-103 — field-permission withheld keys are part of the audit record so
    // probing (a restricted role repeatedly sending locked fields) is visible.
    await audit(ctx, "employees.update", "Employee", emp.id,
      `Updated ${emp.fullName} (${Object.keys(auditDiff(existing, emp) || {}).join(", ") || "no field changes"})${fpStripped.length ? ` · field permissions withheld: ${[...new Set(fpStripped)].join(", ")}` : ""}`, auditDiff(existing, emp) || undefined)
    // Wave 4 WP-C — outbound webhook (fire-and-forget, delivery-log-backed)
    void webhookEmit(ctx.vendorId, "employee.updated", { id: emp.id, code: emp.code, fullName: emp.fullName })
    return emp
  },
})

// ============ employees.updatePhoto — photo-only update (no fullName required) ============
// Dedicated route for the avatar upload overlay in the 360° profile page.
// The employees.update route uses S.employeesSave schema which requires
// fullName — this route accepts only { id, photoUrl } and bypasses the
// full schema, so photo-only updates don't fail validation.
route("employees.updatePhoto", {
  perm: ["employees", "edit"],
  handler: async (ctx, p) => {
    await assertEmployeeVisible(ctx, p.id) // scope check — throws 404 if not visible
    // SaaS storage quota — count the incoming photo bytes against the plan
    // (LEGACY tenants have no quota configured and pass untouched).
    await requireCapacity(ctx.vendorId, "STORAGE", 0, {
      extraUsed: (p.photoUrl?.length || 0) + (p.photoThumb?.length || 0),
    })
    if (!p.photoUrl || typeof p.photoUrl !== "string") {
      throw new Deny("photoUrl is required", 400)
    }
    // Caps: photoUrl 2MB / photoThumb 300KB (data URLs — the client pipeline
    // emits ~60-100KB full + ~4-6KB thumb)
    if (p.photoUrl.length > 2_000_000) {
      throw new Deny("Photo too large (max 2MB). The client should resize before upload.", 400)
    }
    if (p.photoThumb != null && typeof p.photoThumb !== "string") {
      throw new Deny("photoThumb must be a string", 400)
    }
    if (typeof p.photoThumb === "string" && p.photoThumb.length > 300_000) {
      throw new Deny("Photo thumbnail too large (max 300KB)", 400)
    }
    // L-27 — same scheme rule as S.employeesSave: an image data URL (the
    // client upload pattern) or an https:// URL; this dedicated photo route
    // must not be a bypass for http:// / javascript: / arbitrary text.
    if (!/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(p.photoUrl) && !/^https:\/\/[^\s"']+$/i.test(p.photoUrl)) {
      throw new Deny("photoUrl must be an image data URL or an https:// URL", 400)
    }
    // ---- Wave 10 (2026-10-24) — cloud object storage offload (master prompt §4).
    // When the platform owner activated a storage provider (Cloudflare R2 /
    // Cloudinary), avatar data-URLs are offloaded to the bucket and the row
    // keeps the resulting https URL — every existing reader (thumbnails,
    // exports, ESS profile) already handles https photo URLs, and the DB stops
    // carrying the base64 payload. Storage OFF or a provider error → unchanged
    // historical behavior (the data URL is stored locally; nothing breaks).
    let photoUrl = p.photoUrl
    if (photoUrl.startsWith("data:")) {
      try {
        const { offloadDataUrl } = await import("../saas/storage")
        photoUrl = await offloadDataUrl(ctx.vendorId, "AVATAR", photoUrl, {
          keyHint: `avatar-${p.id}`,
          maxBytes: 2 * 1024 * 1024,
          refTable: "Employee",
          refId: p.id,
        })
      } catch (e: any) {
        console.error("[employees.updatePhoto] avatar offload failed (keeping local data URL):", e?.message || e)
      }
    }
    const data: any = { photoUrl }
    // thumb rides along when the client sent one (old clients / API callers
    // that only send photoUrl keep the previous single-field behaviour)
    if (typeof p.photoThumb === "string" && p.photoThumb.length > 0) data.photoThumb = p.photoThumb
    const before = await db.employee.findUnique({ where: { id: p.id }, select: { photoUrl: true, photoThumb: true } })
    const emp = await db.employee.update({ where: { id: p.id }, data })
    // MOD-5 — photo bytes delta (new photo + thumb minus the replaced ones)
    if (before) {
      const oldBytes = (before.photoUrl?.length || 0) + (before.photoThumb?.length || 0)
      const newBytes = (emp.photoUrl?.length || 0) + (emp.photoThumb?.length || 0)
      await bumpStorageRollup(ctx.vendorId, newBytes - oldBytes)
    }
    await audit(ctx, "employees.update", "Employee", emp.id, `Updated photo for ${emp.fullName} (${emp.code})`, { newValue: { photoUrl: "[updated]" } })
    return { id: emp.id, photoUrl: emp.photoUrl, photoThumb: emp.photoThumb }
  },
})

route("employees.delete", {
  perm: ["employees", "delete"],
  handler: async (ctx, p) => {
    const existing = await assertEmployeeVisible(ctx, p.id)
    // Soft-delete (archive): mark INACTIVE so historical attendance / payroll
    // records stay auditable. Works for any status — exited employees AND
    // dummy/test employees that the admin wants to remove from the directory.
    await db.employee.update({ where: { id: p.id }, data: { status: "INACTIVE" } })
    // Device enrollments are deactivated (never deleted) — history stays auditable
    await deactivateMappingsForEmployee(ctx.vendorId, p.id)
    await audit(ctx, "employees.delete", "Employee", p.id, `Archived ${existing.fullName} (was ${existing.status})`, { oldValue: auditPIIScrub(existing) })
    return { archived: true }
  },
})

// ---------- Hard delete (irreversible) — for dummy / test employees ----------
// Removes the employee AND all their related records (attendance, payroll,
// leave, loans, documents, history, etc.). Use ONLY for dummy/test data —
// for real employees use the soft-delete (employees.delete) above so history
// stays auditable. Requires the employee's CODE as typed confirmation.
route("employees.hardDelete", {
  // EMP-10 (R5) — purge is its own verb: irreversible statutory-record
  // destruction is no longer available to every role trusted to archive.
  perm: ["employees", "purge"],
  handler: async (ctx, p) => {
    const existing = await assertEmployeeVisible(ctx, p.id)
    const empName = existing.fullName
    const empCode = existing.code
    // M-03 — typed confirmation of the EMPLOYEE CODE (same pattern as the
    // backups.export typed confirmation). A generic constant ("DELETE") could
    // be typed without looking at the row; the code forces the operator to
    // identify the exact record they are about to irreversibly destroy.
    if (p.confirm !== empCode) {
      throw new Deny(`Confirmation required — type the employee code (${empCode}) to permanently delete this record.`, 400)
    }
    // H-14 — single atomic transaction with an explicit delete order and NO
    // per-call .catch(() => {}): any failing subsidiary delete aborts the whole
    // transaction (nothing partially removed). The order walks leaf tables
    // first, reference-clearing second, the employee row last.
    const _deleted = await db.$transaction(async (tx) => {
      // 0. M-12 — collect entity ids FIRST (the ApprovalRequest rows point at
      // them via scalar entityId; they must be captured before the rows go)
      const leaveIds = (await tx.leaveRequest.findMany({ where: { employeeId: p.id }, select: { id: true } })).map((r: any) => r.id)
      const loanIds2 = (await tx.loan.findMany({ where: { employeeId: p.id }, select: { id: true } })).map((r: any) => r.id)
      const advIds = (await tx.advance.findMany({ where: { employeeId: p.id }, select: { id: true } })).map((r: any) => r.id)
      const expIds = (await tx.expenseClaim.findMany({ where: { employeeId: p.id }, select: { id: true } })).map((r: any) => r.id)
      const resignationIds = (await tx.resignation.findMany({ where: { employeeId: p.id }, select: { id: true } })).map((r: any) => r.id)
      const entityIds = [...leaveIds, ...loanIds2, ...advIds, ...expIds, ...resignationIds]
      // 1. attendance & shift history (leaf tables)
      await tx.attendanceCorrection.deleteMany({ where: { employeeId: p.id } })
      await tx.attendanceRawEvent.deleteMany({ where: { employeeId: p.id } })
      await tx.attendance.deleteMany({ where: { employeeId: p.id } })
      await tx.shiftAssignment.deleteMany({ where: { employeeId: p.id } })
      // 2. leave
      await tx.leaveRequest.deleteMany({ where: { employeeId: p.id } })
      await tx.leaveRequest.deleteMany({ where: { substituteEmployeeId: p.id } })
      await tx.leaveBalance.deleteMany({ where: { employeeId: p.id } })
      // 3. loans/advances/expenses (installments are children of loans)
      const loansOfEmp = await tx.loan.findMany({ where: { employeeId: p.id }, select: { id: true } })
      if (loansOfEmp.length) {
        await tx.loanInstallment.deleteMany({ where: { loanId: { in: loansOfEmp.map((l: any) => l.id) } } })
      }
      await tx.loan.deleteMany({ where: { employeeId: p.id } })
      await tx.advance.deleteMany({ where: { employeeId: p.id } })
      await tx.expenseClaim.deleteMany({ where: { employeeId: p.id } })
      // 4. payroll & salary history
      await tx.payrollEntry.deleteMany({ where: { employeeId: p.id } })
      await tx.salaryRevision.deleteMany({ where: { employeeId: p.id } })
      await tx.salaryStructure.deleteMany({ where: { employeeId: p.id } })
      // 4b. M-12 — payroll extras that used to be orphaned
      await tx.bonus.deleteMany({ where: { employeeId: p.id } })
      await tx.deduction.deleteMany({ where: { employeeId: p.id } })
      await tx.pfEnrollment.deleteMany({ where: { employeeId: p.id } })
      await tx.pfContribution.deleteMany({ where: { employeeId: p.id } })
      await tx.aitCalculationLog.deleteMany({ where: { employeeId: p.id } })
      // 5. performance
      await tx.kpiAssignment.deleteMany({ where: { employeeId: p.id } })
      await tx.performanceReview.deleteMany({ where: { employeeId: p.id } })
      await tx.performanceReview.deleteMany({ where: { reviewerId: p.id } })
      await tx.task.deleteMany({ where: { assigneeId: p.id } })
      // 6. letters / exit — M-12: exit children (clearance checklist rows and
      // final settlements) hang off resignationId and were orphaned; likewise
      // the ApprovalRequest rows pointing at this employee's leave/loan/
      // advance/expense/resignation entities (scalar entityId, no FK).
      await tx.hrLetter.deleteMany({ where: { employeeId: p.id } })
      if (resignationIds.length) {
        await tx.exitClearance.deleteMany({ where: { resignationId: { in: resignationIds } } })
        await tx.finalSettlement.deleteMany({ where: { resignationId: { in: resignationIds } } })
      }
      if (entityIds.length) {
        await tx.approvalRequest.deleteMany({ where: { vendorId: ctx.vendorId, entityId: { in: entityIds } } })
      }
      await tx.resignation.deleteMany({ where: { employeeId: p.id } })
      // 7. biodata
      // MOD-5 — capture the cascaded inline bytes before the delete (docs
      // + the employee's own photo/thumb) and bump the rollup best-effort
      const cascadeDocs = await tx.employeeDocument.findMany({ where: { employeeId: p.id }, select: { fileData: true } })
      const cascadeBytes = cascadeDocs.reduce((s2, d) => s2 + String(d.fileData || "").length, 0)
        + String(existing.photoUrl || "").length + String(existing.photoThumb || "").length
      if (cascadeBytes > 0) await bumpStorageRollup(ctx.vendorId, -cascadeBytes).catch(() => {})
      await tx.employeeDocument.deleteMany({ where: { employeeId: p.id } })
      await tx.bankAccount.deleteMany({ where: { employeeId: p.id } })
      await tx.previousEmployment.deleteMany({ where: { employeeId: p.id } })
      await tx.referee.deleteMany({ where: { employeeId: p.id } })
      await tx.education.deleteMany({ where: { employeeId: p.id } })
      await tx.familyMember.deleteMany({ where: { employeeId: p.id } })
      await tx.employeeHistory.deleteMany({ where: { employeeId: p.id } })
      await tx.notification.deleteMany({ where: { employeeId: p.id } })
      // MOD-15 (Phase 4) — the AuditLog rows SURVIVE the hard delete: the
      // irreversible erase used to destroy the forensic record of everything
      // ever done to the employee — including the hardDelete's own audit row,
      // which is written AFTER this transaction commits and used to be the
      // only surviving trace. The trail (action, actor, timestamps, redacted
      // oldValue) is historical evidence and outlives the record it describes.
      // 7b. M-12 — attendance security/tracking evidence + lifecycle + comms
      // + procurement rows that used to be orphaned (scalar employeeId columns)
      await tx.attendanceEvent.deleteMany({ where: { employeeId: p.id } })
      await tx.attendanceProof.deleteMany({ where: { employeeId: p.id } })
      await tx.trackingPoint.deleteMany({ where: { employeeId: p.id } })
      await tx.employeeTrackingState.deleteMany({ where: { employeeId: p.id } })
      await tx.promotion.deleteMany({ where: { employeeId: p.id } })
      await tx.transfer.deleteMany({ where: { employeeId: p.id } })
      await tx.communicationRecipient.deleteMany({ where: { employeeId: p.id } })
      const goodsIds = (await tx.goodsRequisition.findMany({ where: { employeeId: p.id }, select: { id: true } })).map((g: any) => g.id)
      if (goodsIds.length) {
        await tx.goodsRequisitionItem.deleteMany({ where: { requisitionId: { in: goodsIds } } })
      }
      await tx.goodsRequisition.deleteMany({ where: { employeeId: p.id } })
      await tx.goodsReceiptConfirmation.deleteMany({ where: { employeeId: p.id } })
      // 8. device enrollments
      await tx.attendanceDeviceUser.deleteMany({ where: { employeeId: p.id } })
      // 9. clear cross-references from other rows
      await tx.employee.updateMany({ where: { reportingManagerId: p.id }, data: { reportingManagerId: null } })
      await tx.employee.updateMany({ where: { supervisorId: p.id }, data: { supervisorId: null } })
      await tx.employee.updateMany({ where: { hrManagerId: p.id }, data: { hrManagerId: null } })
      await tx.branch.updateMany({ where: { managerId: p.id }, data: { managerId: null } })
      // M-12 — unlink portal accounts pointing at this employee (the user
      // row itself stays: it is an auth record, and deleting it would lock
      // someone out without an audit trail — admins manage users explicitly)
      await tx.user.updateMany({ where: { employeeId: p.id }, data: { employeeId: null } })
      await tx.department.updateMany({ where: { headId: p.id }, data: { headId: null } })
      // 10. finally the employee row itself
      await tx.employee.delete({ where: { id: p.id } })
      return true
    })
    await audit(ctx, "employees.hardDelete", "Employee", p.id, `Hard-deleted ${empName} (${empCode}) and all related records`, { oldValue: auditPIIScrub(existing) })
    return { deleted: true, name: empName, code: empCode }
  },
})

// ---------- Employee lifecycle actions (2026-10 round §13–§17) ----------
// Directory three-dot menu surface: suspend/activate, reset login password,
// change shift, attendance history, backfill account provisioning. Every
// action is vendor-scoped (assertEmployeeVisible), RBAC-gated, audited and
// (where a decision affects the employee) notified through the
// Settings → Communication automation matrix.

/** Shared helper: notify an employee lifecycle decision through the
 *  employee_status matrix row (in-app always unless off; email/SMS toggles). */
async function notifyEmployeeStatus(
  vendorId: string,
  employeeId: string,
  title: string,
  message: string,
  vars: Record<string, string | number> = {},
) {
  const settings = await getSettings(vendorId)
  const ch = eventChannels(settings, "employee_status", { email: false })
  const { notifyChannels } = await import("../delivery")
  await notifyChannels(vendorId, { employeeId }, title, message, "SYSTEM", "ess", { email: ch.email, sms: ch.sms }, "employee_status", vars)
}

// ---- Suspend / Activate (§14) ------------------------------------------------
route("employees.suspend", {
  perm: ["employees", "edit"],
  handler: async (ctx, p) => {
    const existing = await assertEmployeeVisible(ctx, p.id)
    if (existing.status === "SUSPENDED") throw new Deny("Employee is already suspended", 400)
    if (["RESIGNED", "TERMINATED", "RETIRED", "INACTIVE"].includes(existing.status)) {
      throw new Deny(`Employee status is ${existing.status} — use the lifecycle/exit flows instead of suspension`, 400)
    }
    const reason = String(p?.reason || "").trim().slice(0, 300) || undefined
    await db.$transaction(async (tx) => {
      await tx.employee.update({ where: { id: p.id }, data: { status: "SUSPENDED" } })
      // Suspension must block portal access: the linked account is suspended
      // (login + session resolution both reject non-ACTIVE users) and any live
      // sessions are revoked. The employee RECORD itself is never deleted.
      const linkedUsers = await tx.user.findMany({ where: { vendorId: ctx.vendorId, employeeId: p.id }, select: { id: true } })
      for (const u of linkedUsers) {
        await tx.user.update({ where: { id: u.id }, data: { status: "SUSPENDED" } })
        await tx.session.deleteMany({ where: { userId: u.id } })
      }
    })
    await db.employeeHistory.create({
      data: {
        vendorId: ctx.vendorId, employeeId: p.id, eventType: "STATUS_CHANGE",
        title: "Suspended", description: reason ? `Suspended: ${reason}` : "Employee suspended — portal access blocked",
        effectiveDate: isoDate(new Date()), createdBy: ctx.userId,
      },
    })
    await deactivateMappingsForEmployee(ctx.vendorId, p.id)
    await audit(ctx, "employees.suspend", "Employee", p.id, `Suspended ${existing.fullName} (${existing.code})${reason ? ` — ${reason}` : ""}`, { oldValue: { status: existing.status }, newValue: { status: "SUSPENDED" }, reason })
    await notifyEmployeeStatus(ctx.vendorId, p.id, "Account suspended", "Your employment has been suspended. Portal access is disabled for the duration.", { status: "SUSPENDED" })
    return { status: "SUSPENDED" }
  },
})

route("employees.activate", {
  perm: ["employees", "edit"],
  handler: async (ctx, p) => {
    const existing = await assertEmployeeVisible(ctx, p.id)
    if (existing.status !== "SUSPENDED") throw new Deny("Employee is not suspended — nothing to activate", 400)
    const reason = String(p?.reason || "").trim().slice(0, 300) || undefined
    await db.$transaction(async (tx) => {
      await tx.employee.update({ where: { id: p.id }, data: { status: "ACTIVE" } })
      // restore the linked account (only rows this suspension actually turned
      // off: status SUSPENDED)
      await tx.user.updateMany({ where: { vendorId: ctx.vendorId, employeeId: p.id, status: "SUSPENDED" }, data: { status: "ACTIVE", failedLoginCount: 0, lockedUntil: null } })
    })
    await db.employeeHistory.create({
      data: {
        vendorId: ctx.vendorId, employeeId: p.id, eventType: "STATUS_CHANGE",
        title: "Activated", description: reason ? `Re-activated: ${reason}` : "Suspension lifted — portal access restored",
        effectiveDate: isoDate(new Date()), createdBy: ctx.userId,
      },
    })
    await audit(ctx, "employees.activate", "Employee", p.id, `Activated ${existing.fullName} (${existing.code})`, { oldValue: { status: existing.status }, newValue: { status: "ACTIVE" }, reason })
    await notifyEmployeeStatus(ctx.vendorId, p.id, "Account activated", "Your suspension has been lifted and portal access restored.", { status: "ACTIVE" })
    return { status: "ACTIVE" }
  },
})

// ---- EXT-05 (R7) — rehire detection ----------------------------------------------
// Rehires used to create orphaned duplicate identities with no linkage to the
// prior service record. The create dialog calls this with the identity fields
// as they are typed; former employees of THIS tenant that match (mobile,
// either email, name+DOB, or NID via the PII-encrypted identity documents)
// come back as linkage candidates with their prior service summary.
route("employees.rehireMatches", {
  perm: ["employees", "view"],
  handler: async (ctx, p) => {
    const mobile = String(p?.mobile || "").trim()
    const email = String(p?.officialEmail || p?.personalEmail || "").trim().toLowerCase()
    const nid = String(p?.nid || "").replace(/\D/g, "")
    const fullName = String(p?.fullName || "").trim()
    const dob = String(p?.dob || "").trim()
    if (!mobile && !email && !nid && !(fullName && dob)) return { matches: [] }

    const EXITED = ["RESIGNED", "TERMINATED", "RETIRED", "INACTIVE"]
    const former = await db.employee.findMany({
      where: { vendorId: ctx.vendorId, status: { in: EXITED } },
      select: { id: true, code: true, fullName: true, status: true, mobile: true, officialEmail: true, personalEmail: true, dob: true, joiningDate: true, priorEmployeeId: true },
      take: 5_000,
    })
    // NID match — identity documents of former employees (PII-encrypted at
    // rest; decrypted in-memory here only, never returned).
    const nidOwners = new Set<string>()
    if (nid) {
      const { readPiiText } = await import("../pii-field")
      const docs = await db.employeeDocument.findMany({
        where: { vendorId: ctx.vendorId, category: "IDENTITY", docNumber: { not: null } },
        select: { employeeId: true, docNumber: true },
        take: 20_000,
      })
      for (const d of docs) {
        const plain = readPiiText(d.docNumber)
        if (plain && plain.replace(/\D/g, "") === nid && former.some((f) => f.id === d.employeeId)) nidOwners.add(d.employeeId)
      }
    }
    const matches = former.filter((f) =>
      (mobile && f.mobile === mobile)
      || (email && ((f.officialEmail || "").toLowerCase() === email || (f.personalEmail || "").toLowerCase() === email))
      || nidOwners.has(f.id)
      || (fullName && dob && f.fullName === fullName && f.dob === dob),
    ).slice(0, 10)
    return {
      matches: matches.map((f) => ({
        id: f.id, code: f.code, fullName: f.fullName, status: f.status,
        dob: f.dob, joiningDate: f.joiningDate,
      })),
    }
  },
})

// ---- EMP-08 (R7) — Probation confirm / extend workflow ------------------------------
// Probation previously had NO end-of-period workflow: no confirmation action,
// no reminder (HR discovered lapsed probations by accident), and the calendar
// projected the end date in 30-day months. CONFIRM flips PROBATION → ACTIVE
// with the confirmation date + history + notification; EXTEND pushes the end
// out by whole calendar months (with the standard PROBATION_EXT letter flow
// available in HR Letters).
route("employees.probation", {
  perm: ["employees", "edit"],
  handler: async (ctx, p) => {
    const existing = await assertEmployeeVisible(ctx, p.id)
    if (existing.status !== "PROBATION") throw new Deny("Employee is not on probation", 400)
    const action = p.action === "EXTEND" ? "EXTEND" : p.action === "CONFIRM" ? "CONFIRM" : null
    if (!action) throw new Deny("action must be CONFIRM or EXTEND", 400)
    const remarks = String(p?.remarks || "").trim().slice(0, 500) || undefined

    if (action === "CONFIRM") {
      const confirmationDate = typeof p.effectiveDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.effectiveDate) ? p.effectiveDate : isoDate(new Date())
      if (existing.joiningDate && confirmationDate < existing.joiningDate) throw new Deny("Confirmation date cannot precede the joining date", 400)
      if (confirmationDate > today()) throw new Deny("Confirmation date cannot be in the future", 400)
      const newEmploymentType = existing.employmentType === "PROBATIONARY" ? "PERMANENT" : existing.employmentType
      await db.$transaction(async (tx) => {
        await tx.employee.update({ where: { id: p.id }, data: { status: "ACTIVE", confirmationDate, employmentType: newEmploymentType } })
        await tx.employeeHistory.create({
          data: {
            vendorId: ctx.vendorId, employeeId: p.id, eventType: "STATUS_CHANGE",
            title: "Probation confirmed", description: remarks || `Confirmed after ${existing.probationMonths} month(s) of probation`,
            effectiveDate: confirmationDate, createdBy: ctx.userId,
          },
        })
      })
      await audit(ctx, "employees.probation", "Employee", p.id, `Confirmed ${existing.fullName} (${existing.code}) after probation`, { oldValue: { status: "PROBATION" }, newValue: { status: "ACTIVE", confirmationDate }, reason: remarks })
      await notifyEmployeeStatus(ctx.vendorId, p.id, "Probation confirmed",
        "Congratulations — your probation period has been completed and your employment is confirmed.", { status: "ACTIVE" })
      return { status: "ACTIVE", confirmationDate }
    }

    // EXTEND — push the end date out by whole calendar months
    const extendMonths = Math.max(1, Math.min(12, Math.round(Number(p.extendMonths) || 0)))
    if (!extendMonths) throw new Deny("extendMonths must be between 1 and 12", 400)
    const newTotal = Math.min(36, existing.probationMonths + extendMonths)
    await db.$transaction(async (tx) => {
      await tx.employee.update({ where: { id: p.id }, data: { probationMonths: newTotal } })
      await tx.employeeHistory.create({
        data: {
          vendorId: ctx.vendorId, employeeId: p.id, eventType: "STATUS_CHANGE",
          title: `Probation extended to ${newTotal} month(s)`,
          description: remarks || `Extended by ${extendMonths} month(s)`,
          effectiveDate: isoDate(new Date()), createdBy: ctx.userId,
        },
      })
    })
    const { probationEndDate } = await import("../utils")
    const newEnd = probationEndDate(existing.joiningDate, newTotal)
    await audit(ctx, "employees.probation", "Employee", p.id, `Extended ${existing.fullName}'s probation by ${extendMonths} month(s) (total ${newTotal})`, { oldValue: { probationMonths: existing.probationMonths }, newValue: { probationMonths: newTotal }, reason: remarks })
    await notifyEmployeeStatus(ctx.vendorId, p.id, "Probation extended",
      `Your probation period has been extended by ${extendMonths} month(s).`, { probationMonths: newTotal })
    return { probationMonths: newTotal, probationEndDate: newEnd }
  },
})

// ---- Terminate Employee (Exit System) ----------------------------------------------
route("employees.terminate", {
  perm: ["employees", "edit"],
  handler: async (ctx, p) => {
    const targetId = p.employeeId || p.id
    if (!targetId) throw new Deny("Employee ID is required", 400)
    const emp = await assertEmployeeVisible(ctx, targetId)
    if (["RESIGNED", "TERMINATED", "RETIRED", "INACTIVE"].includes(emp.status)) {
      throw new Deny(`Employee is already ${emp.status.toLowerCase()} — exit is already completed`, 400)
    }

    const reason = String(p.reason || "").trim()
    if (!reason) throw new Deny("Termination reason is required", 400)
    const effectiveDate = String(p.effectiveDate || today()).slice(0, 10)
    const lwd = String(p.lwd || p.lastWorkingDay || effectiveDate).slice(0, 10)
    if (lwd < effectiveDate) throw new Deny("Last working day cannot be before effective date", 400)
    const userRemarks = String(p.remarks || "").trim()
    const noticeMode = String(p.noticeMode || "WAIVED").toUpperCase()
    const noticeDays = Math.max(0, Number(p.noticeDays) || 0)
    const immediateRevoke = p.immediateRevoke !== false

    const existingExit = await db.resignation.findFirst({
      where: { vendorId: ctx.vendorId, employeeId: emp.id, status: { in: ["SUBMITTED", "UNDER_REVIEW", "MANAGER_APPROVED", "HR_REVIEW", "MANAGEMENT_REVIEW", "NOTICE_PERIOD", "ACCEPTED"] } },
      orderBy: { createdAt: "desc" },
    })

    const remarksWithTag = `[EXIT_TYPE:TERMINATION]${userRemarks ? ` ${userRemarks}` : ""}`
    let exitRec: any = null

    if (existingExit) {
      exitRec = await db.resignation.update({
        where: { id: existingExit.id },
        data: {
          reason: `Termination: ${reason}`,
          remarks: remarksWithTag,
          letterName: "EXIT_TYPE:TERMINATION",
          resignationDate: effectiveDate,
          actualLwd: lwd,
          proposedLwd: lwd,
          noticeMode,
          noticeDays,
          status: "NOTICE_PERIOD",
          closureStatus: immediateRevoke ? "DONE" : "SCHEDULED",
          closureDoneAt: immediateRevoke ? new Date() : null,
          actedBy: ctx.userId,
          actedAt: new Date(),
        },
      })
    } else {
      exitRec = await db.resignation.create({
        data: {
          vendorId: ctx.vendorId,
          employeeId: emp.id,
          submissionDate: today(),
          resignationDate: effectiveDate,
          proposedLwd: lwd,
          actualLwd: lwd,
          reason: `Termination: ${reason}`,
          remarks: remarksWithTag,
          letterName: "EXIT_TYPE:TERMINATION",
          status: "NOTICE_PERIOD",
          noticeMode,
          noticeDays,
          servedDays: Math.max(0, daysBetween(effectiveDate, lwd)),
          closureStatus: immediateRevoke ? "DONE" : "SCHEDULED",
          closureDoneAt: immediateRevoke ? new Date() : null,
          actedBy: ctx.userId,
          actedAt: new Date(),
        },
      })
    }

    // Initialize Exit Clearance checklist
    if (p.createExitClearance !== false) {
      const existingClearance = await db.exitClearance.findFirst({ where: { resignationId: exitRec.id } })
      if (!existingClearance) {
        const checklist = CLEARANCE_DEPARTMENTS.map((dept) => ({
          department: dept,
          items: CLEARANCE_ITEMS.map((item) => ({
            item,
            cleared: immediateRevoke && item === "System access revoked",
          })),
        }))
        await db.exitClearance.create({
          data: {
            vendorId: ctx.vendorId,
            resignationId: exitRec.id,
            checklistJson: JSON.stringify(checklist),
            status: "IN_PROGRESS",
          },
        })
      }
    }

    // Access revocation and employee status change
    await db.$transaction(async (tx) => {
      if (immediateRevoke || lwd <= today()) {
        await tx.employee.update({ where: { id: emp.id }, data: { status: "TERMINATED" } })
        const linkedUsers = await tx.user.findMany({ where: { vendorId: ctx.vendorId, employeeId: emp.id } })
        for (const u of linkedUsers) {
          await tx.user.update({ where: { id: u.id }, data: { status: "INACTIVE" } })
          await tx.session.deleteMany({ where: { userId: u.id } })
        }
      }
    })

    if (immediateRevoke || lwd <= today()) {
      await deactivateMappingsForEmployee(ctx.vendorId, emp.id)
    }

    // Append to employee timeline
    await db.employeeHistory.create({
      data: {
        vendorId: ctx.vendorId,
        employeeId: emp.id,
        eventType: "EXIT",
        title: "Employment Terminated",
        description: `${reason}${userRemarks ? ` — ${userRemarks}` : ""} · Effective ${effectiveDate} · LWD ${lwd} · Notice: ${noticeMode}`,
        effectiveDate,
        createdBy: ctx.userId,
        dataJson: JSON.stringify({ exitType: "TERMINATION", resignationId: exitRec.id, reason, remarks: userRemarks, lwd, noticeMode }),
      },
    })

    // Audit and notifications
    await audit(ctx, "employees.terminate", "Employee", emp.id, `Terminated ${emp.fullName} (${emp.code}) — ${reason}`, {
      oldValue: { status: emp.status },
      newValue: { status: immediateRevoke ? "TERMINATED" : emp.status, resignationId: exitRec.id, exitType: "TERMINATION", lwd, remarks: userRemarks },
      reason,
    })

    await notify(ctx.vendorId, { employeeId: emp.id }, "Employment Terminated",
      `Your employment has been terminated effective ${effectiveDate}. Please contact HR for exit clearance and final settlement.`, "EXIT", "ess")
    await notify(ctx.vendorId, { role: "HR_ADMIN" }, "Employee Terminated",
      `${emp.fullName} (${emp.code}) has been terminated effective ${effectiveDate}. Exit case and clearance checklist are open in Exit Management.`, "EXIT", "exit")
    await notify(ctx.vendorId, { role: "VENDOR_OWNER" }, "Employee Terminated",
      `${emp.fullName} (${emp.code}) was terminated by ${ctx.userName}.`, "EXIT", "exit")

    return { ok: true, status: immediateRevoke ? "TERMINATED" : emp.status, resignationId: exitRec.id, exitType: "TERMINATION" }
  },
})

// ---- Retire Employee (Exit System) ----------------------------------------------
route("employees.retire", {
  perm: ["employees", "edit"],
  handler: async (ctx, p) => {
    const targetId = p.employeeId || p.id
    if (!targetId) throw new Deny("Employee ID is required", 400)
    const emp = await assertEmployeeVisible(ctx, targetId)
    if (["RESIGNED", "TERMINATED", "RETIRED", "INACTIVE"].includes(emp.status)) {
      throw new Deny(`Employee is already ${emp.status.toLowerCase()} — exit is already completed`, 400)
    }

    const reason = String(p.reason || "Normal Retirement (Superannuation Age)").trim()
    const effectiveDate = String(p.effectiveDate || today()).slice(0, 10)
    const lwd = String(p.lwd || p.lastWorkingDay || effectiveDate).slice(0, 10)
    if (lwd < effectiveDate) throw new Deny("Last working day cannot be before effective date", 400)
    const userRemarks = String(p.remarks || "").trim()
    const noticeMode = String(p.noticeMode || "FULL").toUpperCase()
    const noticeDays = Math.max(0, Number(p.noticeDays) || 30)
    const immediateRevoke = p.immediateRevoke !== undefined ? !!p.immediateRevoke : lwd <= today()

    const existingExit = await db.resignation.findFirst({
      where: { vendorId: ctx.vendorId, employeeId: emp.id, status: { in: ["SUBMITTED", "UNDER_REVIEW", "MANAGER_APPROVED", "HR_REVIEW", "MANAGEMENT_REVIEW", "NOTICE_PERIOD", "ACCEPTED"] } },
      orderBy: { createdAt: "desc" },
    })

    const remarksWithTag = `[EXIT_TYPE:RETIREMENT]${userRemarks ? ` ${userRemarks}` : ""}`
    let exitRec: any = null

    if (existingExit) {
      exitRec = await db.resignation.update({
        where: { id: existingExit.id },
        data: {
          reason: `Retirement: ${reason}`,
          remarks: remarksWithTag,
          letterName: "EXIT_TYPE:RETIREMENT",
          resignationDate: effectiveDate,
          actualLwd: lwd,
          proposedLwd: lwd,
          noticeMode,
          noticeDays,
          status: "NOTICE_PERIOD",
          closureStatus: immediateRevoke ? "DONE" : "SCHEDULED",
          closureDoneAt: immediateRevoke ? new Date() : null,
          actedBy: ctx.userId,
          actedAt: new Date(),
        },
      })
    } else {
      exitRec = await db.resignation.create({
        data: {
          vendorId: ctx.vendorId,
          employeeId: emp.id,
          submissionDate: today(),
          resignationDate: effectiveDate,
          proposedLwd: lwd,
          actualLwd: lwd,
          reason: `Retirement: ${reason}`,
          remarks: remarksWithTag,
          letterName: "EXIT_TYPE:RETIREMENT",
          status: "NOTICE_PERIOD",
          noticeMode,
          noticeDays,
          servedDays: Math.max(0, daysBetween(effectiveDate, lwd)),
          closureStatus: immediateRevoke ? "DONE" : "SCHEDULED",
          closureDoneAt: immediateRevoke ? new Date() : null,
          actedBy: ctx.userId,
          actedAt: new Date(),
        },
      })
    }

    // Initialize Exit Clearance checklist
    if (p.createExitClearance !== false) {
      const existingClearance = await db.exitClearance.findFirst({ where: { resignationId: exitRec.id } })
      if (!existingClearance) {
        const checklist = CLEARANCE_DEPARTMENTS.map((dept) => ({
          department: dept,
          items: CLEARANCE_ITEMS.map((item) => ({
            item,
            cleared: immediateRevoke && item === "System access revoked",
          })),
        }))
        await db.exitClearance.create({
          data: {
            vendorId: ctx.vendorId,
            resignationId: exitRec.id,
            checklistJson: JSON.stringify(checklist),
            status: "IN_PROGRESS",
          },
        })
      }
    }

    // Access revocation and status change
    await db.$transaction(async (tx) => {
      if (immediateRevoke || lwd <= today()) {
        await tx.employee.update({ where: { id: emp.id }, data: { status: "RETIRED" } })
        const linkedUsers = await tx.user.findMany({ where: { vendorId: ctx.vendorId, employeeId: emp.id } })
        for (const u of linkedUsers) {
          await tx.user.update({ where: { id: u.id }, data: { status: "INACTIVE" } })
          await tx.session.deleteMany({ where: { userId: u.id } })
        }
      }
    })

    if (immediateRevoke || lwd <= today()) {
      await deactivateMappingsForEmployee(ctx.vendorId, emp.id)
    }

    // Timeline event
    await db.employeeHistory.create({
      data: {
        vendorId: ctx.vendorId,
        employeeId: emp.id,
        eventType: "EXIT",
        title: "Employee Retired",
        description: `${reason}${userRemarks ? ` — ${userRemarks}` : ""} · Effective ${effectiveDate} · LWD ${lwd}`,
        effectiveDate,
        createdBy: ctx.userId,
        dataJson: JSON.stringify({ exitType: "RETIREMENT", resignationId: exitRec.id, reason, remarks: userRemarks, lwd, noticeMode }),
      },
    })

    // Audit and notifications
    await audit(ctx, "employees.retire", "Employee", emp.id, `Retired ${emp.fullName} (${emp.code}) — ${reason}`, {
      oldValue: { status: emp.status },
      newValue: { status: immediateRevoke ? "RETIRED" : emp.status, resignationId: exitRec.id, exitType: "RETIREMENT", lwd, remarks: userRemarks },
      reason,
    })

    await notify(ctx.vendorId, { employeeId: emp.id }, "Retirement Processed",
      `Your retirement has been processed effective ${effectiveDate}. We thank you for your dedicated service. Clearance and final settlement will be coordinated by HR.`, "EXIT", "ess")
    await notify(ctx.vendorId, { role: "HR_ADMIN" }, "Employee Retired",
      `${emp.fullName} (${emp.code}) has retired effective ${effectiveDate}. Exit case and settlement are ready in Exit Management.`, "EXIT", "exit")
    await notify(ctx.vendorId, { role: "VENDOR_OWNER" }, "Employee Retired",
      `${emp.fullName} (${emp.code})'s retirement was recorded by ${ctx.userName}.`, "EXIT", "exit")

    return { ok: true, status: immediateRevoke ? "RETIRED" : emp.status, resignationId: exitRec.id, exitType: "RETIREMENT" }
  },
})

// ---- Reset Login Password (§15) ----------------------------------------------
// Generates a NEW secure temporary password (existing passwords are scrypt
// hashes and can never be displayed), forces a first-login change, revokes
// every live session, and delivers the credentials through the channels
// enabled for the employee_credentials matrix event.
route("employees.resetPassword", {
  perm: ["employees", "edit"], // R1-012: was incorrectly ["settings","edit"]; resetPassword is an employee action
  handler: async (ctx, p) => {
    const emp = await assertEmployeeVisible(ctx, p.employeeId || p.id)
    const user = await db.user.findFirst({ where: { vendorId: ctx.vendorId, employeeId: emp.id } })
    if (!user) {
      throw new Deny("This employee has no linked user account. Use \"Create login account\" first.", 400)
    }
    const settings = await getSettings(ctx.vendorId)
    const tempPassword = generateTempPassword(settings.passwordPolicy)
    const { hashPasswordAsync } = await import("../auth")
    await db.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          // MOD-8 (Phase 1) — async scrypt on the request path
          passwordHash: await hashPasswordAsync(tempPassword),
          mustChangePassword: true,
          passwordChangedAt: new Date(),
          passwordResetToken: null,
          passwordResetExpiresAt: null,
          passwordResetRequestedAt: null,
          failedLoginCount: 0,
          lockedUntil: null,
        },
      })
      // every existing session dies — the old password must never be usable again
      await tx.session.deleteMany({ where: { userId: user.id } })
    })
    const delivery = await deliverEmployeeCredentials(ctx.vendorId, emp.id, { email: user.email }, tempPassword, { reset: true })
    await audit(ctx, "employees.resetPassword", "User", user.id,
      `Login password reset for ${emp.fullName} (${emp.code}) — temporary password issued, first-login change enforced (email ${delivery.email}, sms ${delivery.sms})`)
    const nothingDelivered = delivery.email !== "SENT" && delivery.sms !== "SENT"
    return {
      email: user.email,
      emailStatus: delivery.email,
      smsStatus: delivery.sms,
      // one-time reveal for the authorized admin — only when no channel could deliver
      ...(nothingDelivered ? { tempPassword } : {}),
      note: nothingDelivered
        ? "No delivery channel is enabled — copy the temporary password now and share it securely; it will not be shown again."
        : "The temporary password was delivered through the enabled channels. The employee must set a new password at first sign-in.",
    }
  },
})

// ---- Change Shift (§16) -------------------------------------------------------
// Uses the existing Shift master data (no separate shift system), records a
// ShiftAssignment row + an employee history event + audit trail.
// RBAC-105 (Wave R3-5) — assigning a shift is exactly what the employees.assign
// verb in the roles matrix describes; it now satisfies the route on its own
// (employees.edit still works — every pre-existing grant keeps working, and
// tenants can now delegate roster assignment without profile-edit rights).
route("employees.changeShift", {
  perm: ["employees", "edit"],
  // RBAC-105 (re-audit 2026-10-18 repair) — the documented dual-verb gate:
  // assign-OR-edit. The altPerm reaches the dispatcher so an assign-only
  // holder genuinely passes the boundary (the in-handler check below stays
  // as defense in depth for engine-level callers).
  altPerm: ["employees", "assign"],
  handler: async (ctx, p) => {
    if (!ctx.permissions.has("employees.edit") && !ctx.permissions.has("employees.assign") && !ctx.permissions.has("*")) {
      throw new Deny("Changing an employee's shift requires employees edit or assign permission", 403)
    }
    const emp = await assertEmployeeVisible(ctx, p.employeeId || p.id)
    const shift = await db.shift.findFirst({ where: { id: p.shiftId, vendorId: ctx.vendorId, active: true } })
    if (!shift) throw new Deny("Shift not found in your organization", 404)
    if (emp.shiftId === shift.id) throw new Deny(`Employee is already assigned to ${shift.name}`, 400)
    const previousShift = emp.shiftId
      ? (await db.shift.findUnique({ where: { id: emp.shiftId }, select: { name: true } }))?.name || "—"
      : "—"
    const note = String(p?.note || "").trim().slice(0, 300) || undefined
    await db.$transaction(async (tx) => {
      await tx.employee.update({ where: { id: emp.id }, data: { shiftId: shift.id } })
      await tx.shiftAssignment.create({
        data: {
          vendorId: ctx.vendorId, employeeId: emp.id, shiftId: shift.id,
          fromDate: isoDate(new Date()), note: note || "Shift changed via employee action menu",
          createdBy: ctx.userId,
        },
      })
    })
    await db.employeeHistory.create({
      data: {
        vendorId: ctx.vendorId, employeeId: emp.id, eventType: "SHIFT_CHANGE",
        title: `Shift changed: ${previousShift} → ${shift.name}`,
        description: `Shift assignment changed from ${previousShift} to ${shift.name}${note ? ` — ${note}` : ""}`,
        effectiveDate: isoDate(new Date()), createdBy: ctx.userId,
      },
    })
    await audit(ctx, "employees.changeShift", "Employee", emp.id,
      `Shift changed for ${emp.fullName} (${emp.code}): ${previousShift} → ${shift.name}`,
      { oldValue: { shiftId: previousShift }, newValue: { shiftId: shift.id, shiftName: shift.name }, reason: note })
    // shift_change matrix event — in-app + optional email/SMS to the employee
    const settings = await getSettings(ctx.vendorId)
    const ch = eventChannels(settings, "shift_change", { email: false })
    const { notifyChannels } = await import("../delivery")
    await notifyChannels(ctx.vendorId, { employeeId: emp.id }, "Shift changed",
      `Your shift has been changed to ${shift.name} (${shift.startTime}–${shift.endTime}), effective immediately.`,
      "SYSTEM", "ess", { email: ch.email, sms: ch.sms }, "shift_change",
      { shiftName: `${shift.name} (${shift.startTime}–${shift.endTime})`, effectiveDate: isoDate(new Date()) })
    return { shiftId: shift.id, shiftName: shift.name }
  },
})

// ---- View Attendance History (§17) -------------------------------------------
// Reuses the existing Attendance daily-summary table with free date-range +
// status + source filters. No duplicated calculation logic — summaries are
// computed from the SAME rows the attendance module writes.
const ATT_HISTORY_STATUSES = ["PRESENT", "ABSENT", "LATE", "EARLY_LEAVE", "HALF_DAY", "LEAVE", "HOLIDAY", "WEEKLY_OFF", "WFH", "BUSINESS_TRIP"]
const ATT_HISTORY_SOURCES = ["MANUAL", "BIOMETRIC", "GEOFENCE", "WEB", "IMPORT"]
route("employees.attendanceHistory", {
  perm: ["attendance", "view"],
  handler: async (ctx, p) => {
    const emp = await assertEmployeeVisible(ctx, p.employeeId || p.id)
    const today = isoDate(new Date())
    const from = String(p?.from || today.slice(0, 8) + "01").slice(0, 10)
    const to = String(p?.to || today).slice(0, 10)
    if (from > to) throw new Deny("From-date must be before the to-date", 400)
    // bounded range — keep the payload and query cost predictable
    const days = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400000)
    if (days > 366) throw new Deny("Date range too large — split into periods of one year or less", 400)
    const where: any = { vendorId: ctx.vendorId, employeeId: emp.id, date: { gte: from, lte: to } }
    if (Array.isArray(p?.statuses) && p.statuses.length > 0) where.status = { in: p.statuses.filter((s: string) => ATT_HISTORY_STATUSES.includes(s)) }
    if (Array.isArray(p?.sources) && p.sources.length > 0) where.source = { in: p.sources.filter((s: string) => ATT_HISTORY_SOURCES.includes(s)) }
    const [records, total] = await Promise.all([
      db.attendance.findMany({ where, orderBy: { date: "desc" }, take: 400 }),
      db.attendance.count({ where }),
    ])
    // summary derived from the same filtered set (no separate calculation engine)
    const summary: Record<string, number> = {}
    for (const r of records) summary[r.status] = (summary[r.status] || 0) + 1
    return { employee: { id: emp.id, fullName: emp.fullName, code: emp.code }, from, to, total, summary, records }
  },
})

// ---- Backfill: create the linked login account for an existing employee -----
// Covers employees created before auto-provisioning, or created without an
// email on file (NO_EMAIL skip) whose email was added later.
route("employees.provisionAccount", {
  perm: ["employees", "edit"],
  handler: async (ctx, p) => {
    const emp = await assertEmployeeVisible(ctx, p.employeeId || p.id)
    const result = await provisionAndNotify(ctx.vendorId, emp.id, { userId: ctx.userId, userName: ctx.userName })
    if (result.provision.status !== "CREATED") {
      throw new Deny(result.provision.detail || "Account could not be created", 400)
    }
    const d = result.delivery
    const nothingDelivered = !d || (d.email !== "SENT" && d.sms !== "SENT")
    return {
      status: result.provision.status,
      email: result.provision.email,
      emailStatus: d?.email || "NA",
      smsStatus: d?.sms || "NA",
      ...(nothingDelivered && result.provision.tempPassword ? { tempPassword: result.provision.tempPassword } : {}),
    }
  },
})

// ---------- Biodata sections ----------
// NOTE: FormDialog submits "" for untouched fields; Prisma rejects empty
// strings for non-string columns. Convention below: "" = not provided → skip.
// M-11 — every section write/delete enforces the caller's employee scope
// (branch managers may only touch their branch's employees), not just the tenant.
// RBAC-102 (Wave R3-5) — the macro now accepts a per-section perm override so
// a section's true permission family can diverge from the employees.* default:
// the banks section rides bankInfo.view / bankInfo.edit (the roles matrix has
// advertised that vocabulary since the C-05 round while the routes silently
// used employees.* — the audit's "dead verb" drift).
const SECTION = (
  section: string,
  model: keyof typeof db,
  fields: string[],
  perms?: { list?: [string, string]; write?: [string, string]; fieldGroup?: FieldGroup; listSelect?: Record<string, boolean> }
) => {
  // FLD-103 — when a section is bound to a field group, the caller's
  // field-layer access gates it beyond the route perm: "none" hides the rows
  // (list) / denies the write (create/update/delete).
  const sectionFieldAccess = async (ctx: any): Promise<FieldAccess> => {
    if (!perms?.fieldGroup) return "full"
    return callerFieldAccess(await getSettings(ctx.vendorId), ctx.role)[perms.fieldGroup]
  }
  route(`employees.${section}.list`, {
    perm: perms?.list || ["employees", "view"],
    handler: async (ctx, p) => {
      await assertEmployeeVisible(ctx, p.employeeId)
      if ((await sectionFieldAccess(ctx)) === "none") return []
      // SEC-3 (Phase 1) — `perms.listSelect` restricts the columns a list
      // returns. docs.list previously answered to bare employees.view and
      // returned EVERY column — including fileData, the full base64 document
      // BYTES, which no list view needs (downloads go through
      // employees.docs.download with its own permission + audit).
      const rows = await (db as any)[model].findMany({
        where: { employeeId: p.employeeId },
        ...(perms?.listSelect ? { select: perms.listSelect } : {}),
      })
      // RBAC-102 — bank rows leaving the server are masked to last-4 exactly
      // like the employees.get payload (C-05): the raw account number must
      // never ride an RPC response, whichever surface reads it.
      // F28 (P6) — maskPiiNumber decrypts the at-rest ciphertext first.
      if (section === "banks") {
        return rows.map((b: any) => ({
          ...b,
          accountNumber: maskPiiNumber(b.accountNumber),
          mfsNumber: maskPiiNumber(b.mfsNumber),
        }))
      }
      // F28 (P6) — document numbers are encrypted at rest; docs.list is the
      // module's designed surface for the RAW number (employeeDocs.view) —
      // decrypt for those callers (legacy plaintext passes through).
      if (section === "docs") {
        return rows.map((d: any) => ({ ...d, docNumber: readPiiText(d.docNumber) }))
      }
      return rows
    },
  })
  route(`employees.${section}.create`, {
    perm: section === "docs" ? ["employeeDocs", "upload"] : perms?.write || ["employees", "edit"],
    handler: async (ctx, p) => {
      await assertEmployeeVisible(ctx, p.employeeId)
      if ((await sectionFieldAccess(ctx)) === "none") {
        throw new Deny(`Your role's field permissions do not allow editing the ${section} section`, 403)
      }
      // M-37 — server-side upload validation (2 MB decoded + magic-byte MIME
      // allowlist). The cap previously existed ONLY in the client picker.
      if (section === "docs" && p.fileData !== undefined) {
        const check = validateEmployeeDoc(p.fileData)
        if (!check.ok) throw new Deny(check.reason, 400)
        // SaaS storage quota — count the incoming document bytes against the
        // plan (LEGACY tenants have no quota configured and pass untouched).
        await requireCapacity(ctx.vendorId, "STORAGE", 0, { extraUsed: String(p.fileData).length })
      }
      const data: any = { employeeId: p.employeeId }
      for (const f of fields) if (p[f] !== undefined && p[f] !== "") data[f] = p[f]
      // DB-02 (R5) — every biodata-section child row carries its tenant (the
      // docs-only vendorId line left banks/family/education/referee rows
      // unscoped; assertEmployeeVisible above already tenant-checked the target).
      data.vendorId = ctx.vendorId
      // F28 (P6) — PII columns encrypt at the storage boundary (fail-closed
      // without a deployment key, exactly like MFA/comm-key/comms writes).
      if (section === "banks") {
        if (data.accountNumber !== undefined) data.accountNumber = piiTextForStorage(data.accountNumber)
        if (data.mfsNumber !== undefined) data.mfsNumber = piiTextForStorage(data.mfsNumber)
      }
      if (section === "docs") {
        if (data.docNumber !== undefined) data.docNumber = piiTextForStorage(data.docNumber)
        if (data.fileData !== undefined) data.fileData = encryptPiiFile(String(data.fileData))
      }
      const rec = await (db as any)[model].create({ data })
      // MOD-5 (Phase 2 WS6) — best-effort storage rollup bump for inline doc bytes.
      // F28 (P6) — the rollup counts the STORED (encrypted) length so the
      // quota tracks actual database bytes, not the pre-encryption input.
      if (section === "docs" && p.fileData !== undefined) await bumpStorageRollup(ctx.vendorId, String(rec.fileData || "").length)
      await audit(ctx, `employees.${section}.create`, section, rec.id, `Added ${section} record to employee ${p.employeeId}`)
      return section === "banks" ? maskBankRow(rec) : (section === "docs" ? { ...rec, docNumber: readPiiText(rec.docNumber), fileData: undefined } : rec)
    },
  })
  route(`employees.${section}.update`, {
    perm: section === "docs" ? ["employeeDocs", "edit"] : perms?.write || ["employees", "edit"],
    handler: async (ctx, p) => {
      const rec = await (db as any)[model].findUnique({ where: { id: p.id } })
      if (!rec) throw new Deny("Not found", 404)
      await assertEmployeeVisible(ctx, rec.employeeId) // M-11 — scope, not just tenant
      if ((await sectionFieldAccess(ctx)) === "none") {
        throw new Deny(`Your role's field permissions do not allow editing the ${section} section`, 403)
      }
      // M-37 — same server-side validation on the update path (file replacement)
      if (section === "docs" && p.fileData !== undefined) {
        const check = validateEmployeeDoc(p.fileData)
        if (!check.ok) throw new Deny(check.reason, 400)
      }
      const data: any = {}
      for (const f of fields) if (p[f] !== undefined && p[f] !== "") data[f] = p[f]
      // F28 (P6) — PII columns encrypt at the storage boundary. piiTextForStorage
      // passes ALREADY-ENCRYPTED values through untouched, so the payout merge
      // path (which keeps stored ciphertexts when the client sends blanks)
      // can never double-encrypt.
      if (section === "banks") {
        if (data.accountNumber !== undefined) data.accountNumber = piiTextForStorage(data.accountNumber)
        if (data.mfsNumber !== undefined) data.mfsNumber = piiTextForStorage(data.mfsNumber)
      }
      if (section === "docs") {
        if (data.docNumber !== undefined) data.docNumber = piiTextForStorage(data.docNumber)
        if (data.fileData !== undefined) data.fileData = encryptPiiFile(String(data.fileData))
      }
      const updated = await (db as any)[model].update({ where: { id: p.id }, data })
      // MOD-5 — file replacement delta. F28 (P6) — counts STORED bytes on both
      // sides (encrypted lengths), so the rollup tracks actual DB bytes.
      if (section === "docs" && p.fileData !== undefined) {
        await bumpStorageRollup(ctx.vendorId, String(updated.fileData || "").length - String(rec.fileData || "").length)
      }
      // M-13 — PII-minimal diff (family/education/bank rows carry the most PII)
      await audit(ctx, `employees.${section}.update`, section, p.id, `Updated ${section}`, auditDiff(rec, updated) || undefined)
      return section === "banks" ? maskBankRow(updated) : (section === "docs" ? { ...updated, docNumber: readPiiText(updated.docNumber), fileData: undefined } : updated)
    },
  })
  route(`employees.${section}.delete`, {
    perm: section === "docs" ? ["employeeDocs", "delete"] : perms?.write || ["employees", "edit"],
    handler: async (ctx, p) => {
      const rec = await (db as any)[model].findUnique({ where: { id: p.id } })
      if (!rec) throw new Deny("Not found", 404)
      await assertEmployeeVisible(ctx, rec.employeeId) // M-11 — scope, not just tenant
      if ((await sectionFieldAccess(ctx)) === "none") {
        throw new Deny(`Your role's field permissions do not allow editing the ${section} section`, 403)
      }
      if (section === "docs" && rec.fileData) await bumpStorageRollup(ctx.vendorId, -String(rec.fileData).length)
      await (db as any)[model].delete({ where: { id: p.id } })
      await audit(ctx, `employees.${section}.delete`, section, p.id, `Deleted ${section} record`, { oldValue: auditPIIScrub(rec) })
      return { deleted: true }
    },
  })
}

/** RBAC-102 — C-05 mask applied to every bank row that leaves the server
 *  through the section routes (account + MFS numbers → last 4 digits).
 *  F28 (P6) — maskPiiNumber decrypts the at-rest ciphertext first, so the
 *  last-4 shown is always the REAL last-4. */
function maskBankRow(b: any) {
  if (!b) return b
  return {
    ...b,
    accountNumber: maskPiiNumber(b.accountNumber),
    mfsNumber: maskPiiNumber(b.mfsNumber),
  }
}

SECTION("family", "familyMember", ["name", "relationship", "dob", "gender", "occupation", "mobile", "email", "address", "dependent", "notes"])
SECTION("education", "education", ["degree", "examination", "institution", "board", "major", "passingYear", "result", "notes"])
SECTION("references", "referee", ["name", "relationship", "organization", "designation", "mobile", "email", "address", "knownFor", "type", "notes"])
SECTION("prevEmployment", "previousEmployment", ["company", "designation", "department", "joinDate", "leaveDate", "lastSalary", "reasonForLeaving", "supervisor", "contact", "notes"])
SECTION("banks", "bankAccount", ["holderName", "bank", "branch", "accountNumber", "routingNumber", "accountType", "mfsProvider", "mfsNumber", "paymentMethod", "isPrimary"], { list: ["bankInfo", "view"], write: ["bankInfo", "edit"], fieldGroup: "bank" })
// M-01 — `verified` is NOT client-writable on bank accounts: it flows through
// the dedicated employees.banks.verify action below (bankInfo.verify gate —
// RBAC-102 aligned the verb with the roles matrix; it previously rode
// employeeDocs.verify, a different module's family),
// mirroring document verification.
route("employees.banks.verify", {
  perm: ["bankInfo", "verify"],
  handler: async (ctx, p) => {
    const rec = await db.bankAccount.findFirst({ where: { id: p.id, employeeId: p.employeeId } })
    if (!rec) throw new Deny("Bank account not found", 404)
    await assertEmployeeVisible(ctx, rec.employeeId)
    // P3 (re-audit 2026-10-18) — the update used to write verifiedBy/verifiedAt,
    // columns that do not exist on BankAccount (the `as any` cast hid the
    // PrismaClientValidationError), so EVERY verify call 500'd. The verifier's
    // identity and the decision time live in the audit row below (the same
    // trail pattern the docs verify route documents); `verified` itself is the
    // column the payout resolver reads.
    const updated = await db.bankAccount.update({
      where: { id: p.id },
      data: { verified: p.verified !== false },
    })
    // F28 (P6) — decrypt (lenient) for the last-4 audit label.
    const acctLast4 = readPiiText(rec.accountNumber)
    await audit(ctx, "employees.banks.verify", "BankAccount", p.id,
      `${p.verified !== false ? "Verified" : "Un-verified"} bank account ${acctLast4 ? "…" + String(acctLast4).slice(-4) : ""} by ${ctx.userName}`)
    return { id: updated.id, verified: updated.verified }
  },
})
// SEC-3 (Phase 1) — the docs section is gated by employeeDocs.view (its own
// module family, aligned with create/update/delete which already use
// employeeDocs.*), and the LIST response excludes fileData: the full document
// bytes leave the server only through employees.docs.download
// (employeeDocs.download + audit + employee-scope check). docNumber stays
// visible to employeeDocs.view holders — that is the module's designed surface.
SECTION("docs", "employeeDocument", ["category", "docType", "title", "docNumber", "nameOnDoc", "issueDate", "expiryDate", "issuingAuthority", "status", "fileName", "fileData", "notes"], {
  list: ["employeeDocs", "view"],
  listSelect: {
    id: true, vendorId: true, employeeId: true, category: true, docType: true,
    title: true, docNumber: true, nameOnDoc: true, issueDate: true,
    expiryDate: true, issuingAuthority: true, status: true, fileName: true,
    notes: true, verified: true, verifiedBy: true, verifiedAt: true, createdAt: true,
    // fileData deliberately ABSENT — bytes travel via docs.download only
  },
})
// Secure document view/download with audit (spec §5.5)
route("employees.docs.download", {
  perm: ["employeeDocs", "download"],
  handler: async (ctx, p) => {
    const rec = await db.employeeDocument.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!rec || !rec.fileData) throw new Deny("Document file not found", 404)
    await assertEmployeeVisible(ctx, rec.employeeId) // scope check: branch manager cannot access other branches' docs
    const emp = await db.employee.findUnique({ where: { id: rec.employeeId } })
    // F28 (P6) — file bytes decrypt at the egress boundary. STRICT: a document
    // stored under a rotated-away key fails loudly (operator-actionable) —
    // never garbage bytes, never a silent 404.
    const fileData = readPiiFileStrict(rec.fileData)
    await audit(ctx, "employeeDocs.download", "EmployeeDocument", rec.id, `Downloaded ${rec.docType} of ${emp?.fullName}`)
    return { fileName: rec.fileName, fileData, docType: rec.docType }
  },
})
route("employees.docs.verify", {
  perm: ["employeeDocs", "verify"],
  handler: async (ctx, p) => {
    const rec = await db.employeeDocument.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!rec) throw new Deny("Not found", 404)
    await assertEmployeeVisible(ctx, rec.employeeId) // scope check
    const updated = await db.employeeDocument.update({
      where: { id: p.id },
      data: { verified: p.verified !== false, verifiedBy: ctx.userId, verifiedAt: new Date() },
    })
    await audit(ctx, "employeeDocs.verify", "EmployeeDocument", p.id, `${p.verified !== false ? "Verified" : "Un-verified"} document ${rec.title}`)
    return updated
  },
})

/** R6 — in-app document VIEW (popup preview) with its own audit trail.
 * Same permission gate as the download (viewing a stored file IS file access);
 * audited distinctly so the trail shows reads vs downloads. Returns the base64
 * payload + a derived MIME type so the client can render image/PDF previews. */
route("employees.docs.view", {
  perm: ["employeeDocs", "download"],
  handler: async (ctx, p) => {
    const rec = await db.employeeDocument.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!rec || !rec.fileData) throw new Deny("Document file not found", 404)
    await assertEmployeeVisible(ctx, rec.employeeId) // scope check
    const emp = await db.employee.findUnique({ where: { id: rec.employeeId } })
    // F28 (P6) — decrypt at the egress boundary (STRICT — see download).
    const fileData = readPiiFileStrict(rec.fileData)
    // L-29 — the MIME type is derived from the STORED BYTES (magic-number
    // sniff), never from the client-controlled fileName: a renamed
    // executable must not be served inline as an image, and a legacy
    // .svg-named row must not render as an active document. Unrecognized
    // payloads download as application/octet-stream (no inline preview).
    const sniffed = sniffMime(decodeBase64Payload(String(fileData)) || Buffer.alloc(0))
    await audit(ctx, "employeeDocs.view", "EmployeeDocument", rec.id, `Viewed ${rec.docType} of ${emp?.fullName}`)
    return {
      fileName: rec.fileName,
      fileData,
      mimeType: sniffed || "application/octet-stream",
      title: rec.title,
      docType: rec.docType,
    }
  },
})

/** Audited profile print / CV export action */
route("employees.auditPrint", {
  perm: ["employees", "view"],
  handler: async (ctx, p) => {
    const emp = await assertEmployeeVisible(ctx, p.id)
    await audit(ctx, "employees.print", "Employee", emp.id, `Printed/exported 360° profile of ${emp.fullName} (${emp.code})`)
    return { ok: true }
  },
})
