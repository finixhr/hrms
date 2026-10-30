// ============ FLD-103 (Wave R3-5) — Field-level permission engine ============
// Tenant-editable field-group permissions consumed by a SERVER-SIDE projection
// helper on the employee surface (employees.get / employees.list / employees
// .update / employees.create / employees.banks.* / salaryStructures.save).
//
// DESIGN (audit 3-e, FLD-103 recommendation):
//   - Keep the coarse MODULES×ACTIONS matrix as layer 1 (route perms).
//   - This is layer 2: per-ROLE rules on 5 field groups of the employee record
//     (salary, bank, identity, contact, employment) with 3 access modes.
//   - Storage: the `fieldPermissions` hrSettings group (no schema change) —
//     { roles: { [roleKey]: { [group]: "full"|"mask"|"none" } }, default? }.
//   - BACKWARD COMPATIBILITY: an absent group / absent role / absent config
//     resolves to "full" — an unconfigured tenant behaves exactly as before.
//   - MORE RESTRICTIVE WINS: the effective access is the stricter of the
//     module-perm layer (payroll.view / bankInfo.view / employeeDocs.reveal…)
//     and the field layer — a field rule can only ever narrow, never widen,
//     what the route permission already granted.
//   - VIEWS NEED NO PER-FIELD LOGIC on the read side: the server withholds
//     (null) or masks the values; the client renders what it receives. On the
//     write side denied fields are STRIPPED server-side (whitelist semantics)
//     and the attempt is audit-noted, so a full-form save from a restricted
//     role still lands for the fields that role may edit.
import type { HrSettings } from "./settings"

export const FIELD_GROUPS = ["salary", "bank", "identity", "contact", "employment"] as const
export type FieldGroup = (typeof FIELD_GROUPS)[number]

export type FieldAccess = "full" | "mask" | "none"

export const FIELD_GROUP_LABELS: Record<FieldGroup, string> = {
  salary: "Salary & structure",
  bank: "Bank accounts & payout",
  identity: "Identity numbers (NID/passport/e-TIN)",
  contact: "Contact & address",
  employment: "Employment (branch/dept/grade/dates)",
}

export const FIELD_ACCESS_LABELS: Record<FieldAccess, string> = {
  full: "Full",
  mask: "Masked",
  none: "Hidden",
}

export type FieldPermissionConfig = {
  /** role key (system or custom) → per-group access overrides */
  roles?: Record<string, Partial<Record<FieldGroup, FieldAccess>>>
  /** tenant-wide fallback for roles not listed in `roles` */
  default?: Partial<Record<FieldGroup, FieldAccess>> | null
}

function isFieldAccess(v: unknown): v is FieldAccess {
  return v === "full" || v === "mask" || v === "none"
}

/** Defensive parse of the raw settings group → typed config (never throws). */
export function parseFieldPermissionConfig(raw: unknown): FieldPermissionConfig {
  const cfg: FieldPermissionConfig = {}
  if (!raw || typeof raw !== "object") return cfg
  const r = raw as any
  if (r.roles && typeof r.roles === "object" && !Array.isArray(r.roles)) {
    const roles: FieldPermissionConfig["roles"] = {}
    for (const [roleKey, groups] of Object.entries(r.roles)) {
      if (!roleKey || typeof roleKey !== "string" || !groups || typeof groups !== "object") continue
      const entry: Partial<Record<FieldGroup, FieldAccess>> = {}
      for (const g of FIELD_GROUPS) {
        if (isFieldAccess((groups as any)[g])) entry[g] = (groups as any)[g]
      }
      if (Object.keys(entry).length) roles[roleKey] = entry
    }
    if (Object.keys(roles).length) cfg.roles = roles
  }
  if (r.default && typeof r.default === "object" && !Array.isArray(r.default)) {
    const def: Partial<Record<FieldGroup, FieldAccess>> = {}
    for (const g of FIELD_GROUPS) {
      if (isFieldAccess((r.default as any)[g])) def[g] = (r.default as any)[g]
    }
    if (Object.keys(def).length) cfg.default = def
  }
  return cfg
}

/** Resolve the FIELD-layer access for one role + group.
 *  Precedence: role-specific rule → tenant default → "full" (compat). */
export function resolveFieldAccess(cfg: FieldPermissionConfig | null | undefined, role: string, group: FieldGroup): FieldAccess {
  if (!cfg) return "full"
  const roleRule = cfg.roles?.[role]
  if (roleRule && isFieldAccess(roleRule[group])) return roleRule[group] as FieldAccess
  if (cfg.default && isFieldAccess(cfg.default[group])) return cfg.default[group] as FieldAccess
  return "full"
}

/** Combine the field layer with the module-perm layer outcome.
 *  `perm` is what the route permission already decided for the caller:
 *    - "full" = granted, "mask" = granted-but-masked by an existing rule
 *      (C-05 bank last-4 / FLD-102 identity masking),
 *    - null = NOT granted (module layer denied → effective none),
 *    - undefined = no module-layer input for this group (auth.me, contact /
 *      employment in employees.get) → the field layer decides alone.
 *  The MORE RESTRICTIVE of the two layers wins — a field rule can never
 *  rescue access the module layer denied. */
export function combineFieldAccess(field: FieldAccess, perm: FieldAccess | null | undefined): FieldAccess {
  if (perm === null) return "none"
  if (perm === undefined) return field
  if (field === "none" || perm === "none") return "none"
  if (field === "mask" || perm === "mask") return "mask"
  return "full"
}

// ---- Employee column → field group mapping (the projection whitelist) ------

/** Employee-record columns in the CONTACT group (phones, emails, addresses). */
export const CONTACT_FIELDS = [
  "mobile", "altMobile", "personalEmail", "officialEmail",
  "emergencyName", "emergencyRelation", "emergencyMobile",
  "presentAddress", "permanentAddress", "division", "district", "city", "postCode",
  "presentDivision", "presentDistrict", "presentCity", "presentPostCode", "addressSame",
] as const

/** Employee-record columns in the EMPLOYMENT group (org placement + terms).
 *  EMP-04 (R5): taxTin (e-TIN) moved OUT of this group into the identity
 *  group — the product labels it identity data, so it masks like NID/passport
 *  instead of riding employment's mask==full default. */
export const EMPLOYMENT_FIELDS = [
  "branchId", "departmentId", "designationId", "reportingManagerId", "hrManagerId",
  "supervisorId", "workLocation", "joiningDate", "confirmationDate", "probationMonths",
  "employmentType", "category", "grade", "shiftId", "weeklyOff", "contractStart", "contractEnd",
  "previousEmployerIncome", "taxAlreadyDeducted",
] as const

/** Employee-record columns in the IDENTITY group (read side). e-TIN is
 *  identity data (EMP-04): masked to last-4 under a mask rule, nulled under
 *  none — exactly like the NID/passport numbers on the doc surface. */
export const IDENTITY_FIELDS = ["taxTin"] as const

function maskIdentityValue(v: unknown): string {
  const s = String(v ?? "")
  return s.length <= 4 ? s : `•••• ${s.slice(-4)}`
}

/** Payout/bank columns accepted by employees.update / createWithStructure. */
export const BANK_WRITE_FIELDS = [
  "payoutMethod", "payoutBank", "payoutBranch", "payoutAccountName", "payoutAccountNumber",
  "payoutRoutingNumber", "payoutMfsProvider", "payoutMfsNumber",
] as const

/** Identity-number inputs accepted by employees.update / create paths.
 *  EMP-04 (R5) — taxTin edits ride the identity group's write gate. */
export const IDENTITY_WRITE_FIELDS = ["identityNumber", "nid", "identityType", "taxTin"] as const

export type FieldAccessMap = Record<FieldGroup, FieldAccess>

/** Effective access map for a caller (field layer ∎ perm layer already applied
 *  by the caller for salary/bank/identity — see employees.get). */
export function fieldAccessMapFor(
  cfg: FieldPermissionConfig | null | undefined,
  role: string,
  permOverrides?: Partial<Record<FieldGroup, FieldAccess | null>>,
): FieldAccessMap {
  const out = {} as FieldAccessMap
  for (const g of FIELD_GROUPS) {
    out[g] = combineFieldAccess(resolveFieldAccess(cfg, role, g), permOverrides?.[g])
  }
  return out
}

/** Convenience: read the config off a full settings object. */
export function fieldPermissionsFromSettings(settings: HrSettings | null | undefined): FieldPermissionConfig {
  return parseFieldPermissionConfig((settings as any)?.fieldPermissions)
}

/** One-call resolver for a request context: settings + role + the module-perm
 *  layer's outcome per group (null = route permission denied the group).
 *  `permOverrides` values follow combineFieldAccess semantics. */
export function callerFieldAccess(
  settings: HrSettings | null | undefined,
  role: string,
  permOverrides?: Partial<Record<FieldGroup, FieldAccess | null>>,
): FieldAccessMap {
  return fieldAccessMapFor(fieldPermissionsFromSettings(settings), role, permOverrides)
}

// ---- Read-side projection (pure) -------------------------------------------

export type ContactMask = (v: string | null | undefined) => string | null

/** Default contact masker: keeps the first 2 + last 2 chars of a phone number
 *  (017•••••••12) and the first char + domain of an email (r•••@gmail.com).
 *  Everything else falls back to a generic 4-visible mask. */
export function maskContactValue(v: string | null | undefined): string | null {
  if (v == null || v === "") return v as null
  const s = String(v)
  if (s.includes("@")) {
    const [local, domain] = s.split("@")
    if (!domain) return "•".repeat(Math.max(1, s.length - 1))
    return `${local.slice(0, 1)}${"•".repeat(Math.max(1, local.length - 1))}@${domain}`
  }
  if (s.length <= 4) return "••••"
  const head = s.slice(0, 2)
  const tail = s.slice(-2)
  return `${head}${"•".repeat(Math.max(2, s.length - 4))}${tail}`
}

/** Project ONE flat record (Employee row from list, or the employee object of
 *  employees.get) in place according to the effective access map. Pure —
 *  returns a new object. `include` narrows the groups applied (list rows carry
 *  no salary/bank/identity payloads). */
export function projectRecord<T extends Record<string, any>>(
  rec: T,
  access: FieldAccessMap,
  opts: { groups?: readonly FieldGroup[]; maskContact?: ContactMask } = {},
): T {
  const groups = opts.groups ?? FIELD_GROUPS
  const mask = opts.maskContact ?? maskContactValue
  const out: Record<string, any> = { ...rec }
  if (groups.includes("contact")) {
    const mode = access.contact
    for (const f of CONTACT_FIELDS) {
      if (mode === "none") out[f] = null
      else if (mode === "mask" && out[f] != null && out[f] !== "") out[f] = mask(out[f])
    }
  }
  if (groups.includes("employment")) {
    const mode = access.employment
    if (mode === "none") for (const f of EMPLOYMENT_FIELDS) out[f] = null
    // employment has no meaningful partial form: "mask" behaves as "full"
    // for org columns (documented) — hiding half a designation helps no one.
  }
  if (groups.includes("identity")) {
    // EMP-04 (R5) — e-TIN rides the identity group: none nulls it, mask shows
    // the last four digits (the same shape the NID/passport doc numbers use).
    const mode = access.identity
    for (const f of IDENTITY_FIELDS) {
      if (mode === "none") out[f] = null
      else if (mode === "mask" && out[f] != null && out[f] !== "") out[f] = maskIdentityValue(out[f])
    }
  }
  // salary / bank / identity are handled by their dedicated surfaces
  // (structure loading, bank row select, doc-number masking) — nothing to do
  // on a flat record here.
  return out as T
}

// ---- Write-side whitelist (pure) --------------------------------------------

export type StripResult = { payload: Record<string, any>; stripped: string[] }

/** Whitelist a write payload against the caller's effective access: fields of
 *  a group the caller may not EDIT are removed (never rejected — a full-form
 *  save from a partially-authorized role still lands for the allowed fields).
 *  Returned `stripped` lists the denied keys that were present, so callers can
 *  audit the attempt. */
export function stripDeniedWriteFields(
  payload: Record<string, any>,
  access: FieldAccessMap,
  opts: { groups?: readonly FieldGroup[] } = {},
): StripResult {
  const groups = opts.groups ?? FIELD_GROUPS
  const stripped: string[] = []
  const out: Record<string, any> = { ...payload }
  const drop = (fields: readonly string[]) => {
    for (const f of fields) {
      if (f in out && out[f] !== undefined) {
        delete out[f]
        stripped.push(f)
      }
    }
  }
  // NOTE on semantics: for the write side "mask" still means the field is
  // EDITABLE-but-masked-on-read (a masked editor updates the stored value);
  // only "none" denies the write. Tenants that want read-masked + write-locked
  // set the group to "none".
  if (groups.includes("contact") && access.contact === "none") drop(CONTACT_FIELDS)
  if (groups.includes("employment") && access.employment === "none") drop(EMPLOYMENT_FIELDS)
  if (groups.includes("bank") && access.bank === "none") drop(BANK_WRITE_FIELDS)
  if (groups.includes("identity") && access.identity === "none") drop(IDENTITY_WRITE_FIELDS)
  // salary: the write surface is salaryStructures.save (handled in payroll.ts)
  return { payload: out, stripped }
}
