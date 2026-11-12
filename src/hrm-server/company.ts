// ============ MULTI-COMPANY core: company context resolution + enforcement ============
// (2026-11-03 — master prompt "Enterprise Multi-Company Management Architecture")
//
// The Vendor remains the TENANT (subscription, users, sessions — untouched).
// A Company is a child of the Vendor: the independently managed operating
// unit that owns branches, departments, employees, payroll, accounting books
// and approval workflows.
//
// This module is the SINGLE source of truth for company-context security.
// Every rule the master prompt mandates lives here once, instead of ad hoc
// company filters scattered through handlers:
//
//   1. A client can NEVER change vendorId or impersonate a company — the
//      active company is resolved from the SESSION row (Session.activeCompanyId)
//      and validated against UserCompanyAccess on EVERY request.
//   2. Company must belong to the authenticated Vendor.
//   3. Fail-closed: missing/invalid/inactive company or revoked access ⇒ the
//      context resolves to a safe state (default company when accessible,
//      otherwise no company context) and company-scoped operations DENY.
//   4. Cross-company record ids return safe 404s (assertCompanyRecord).
//   5. "All Companies" is an explicitly authorized consolidated REPORTING
//      context only — it never widens CRUD/pay/post operations.
import { db } from "@/lib/db"
import type { Prisma } from "@prisma/client"
import type { Ctx } from "./types"
import { Deny, employeeScopeFilter } from "./rbac"
import { getSettings, isCompanyOverridableGroup, COMPANY_OVERRIDABLE_GROUPS } from "./settings"

// ---------- short-TTL access cache (same pattern as the settings cache) ----------
// resolveCompanyAccess runs on EVERY authenticated request; the access rows
// change only when an admin edits them (companies.access.* invalidates).
const ACCESS_TTL_MS = 15_000
const ACCESS_CACHE_MAX = 10_000
type AccessEntry = {
  at: number
  rows: {
    companyId: string; code: string; name: string; role: string
    active: boolean; isDefault: boolean; branchScope: string | null; departmentScope: string | null
  }[]
}
const accessCache = new Map<string, AccessEntry>()

export function invalidateCompanyAccessCache(userId?: string): void {
  if (userId) accessCache.delete(userId)
  else accessCache.clear()
}

function capAccessCache(): void {
  if (accessCache.size < ACCESS_CACHE_MAX) return
  const now = Date.now()
  for (const [k, v] of accessCache) {
    if (now - v.at >= ACCESS_TTL_MS) accessCache.delete(k)
    if (accessCache.size <= ACCESS_CACHE_MAX / 2) return
  }
  while (accessCache.size >= ACCESS_CACHE_MAX) {
    const first = accessCache.keys().next().value
    if (first == null) return
    accessCache.delete(first)
  }
}

/** The resolved company access list of a user (ACTIVE rows only, newest default first). */
export async function resolveCompanyAccess(userId: string, vendorId: string): Promise<AccessEntry["rows"]> {
  const hit = accessCache.get(userId)
  if (hit && Date.now() - hit.at < ACCESS_TTL_MS) return hit.rows
  const rows = await db.userCompanyAccess.findMany({
    where: { userId, vendorId, active: true, company: { vendorId, active: true } },
    select: {
      companyId: true, role: true, isDefault: true, branchScope: true, departmentScope: true,
      company: { select: { code: true, name: true } },
    },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  })
  const mapped = rows.map((r) => ({
    companyId: r.companyId, code: r.company.code, name: r.company.name, role: r.role,
    active: true, isDefault: r.isDefault,
    branchScope: r.branchScope, departmentScope: r.departmentScope,
  }))
  capAccessCache()
  accessCache.set(userId, { at: Date.now(), rows: mapped })
  return mapped
}

/**
 * Resolve the ACTIVE COMPANY for a session (fail-closed, never client-driven).
 *
 * Resolution order:
 *   1. Session.activeCompanyId — validated against the user's live access
 *      rows (revoked/inactive company ⇒ access disappears IMMEDIATELY; we
 *      then fall through instead of trusting a stale pointer).
 *   2. EMPLOYEE-role users → the company of their linked Employee row
 *      (their company is a property of their employment, not a choice) —
 *      F-01: only while that company is ACTIVE; a deactivated employment
 *      company falls through to the safe state instead of operating against
 *      a company the tenant has deactivated.
 *   3. The user's default company (isDefault access row).
 *   4. Legacy/no-access users: the vendor's default company when the user's
 *      tenant role is administrative (HR_ADMIN/VENDOR_OWNER) — this is the
 *      backward-compatible path for tenants migrated before any access rows
 *      existed (the 2026-11-03 migration seeds one access row per user, but
 *      users created later without rows keep working through this rule).
 *   5. Otherwise null — company-scoped operations deny with a clear message.
 */
export async function resolveActiveCompany(
  session: { activeCompanyId?: string | null },
  user: { id: string; vendorId: string; role: string; employeeId?: string | null },
): Promise<{ companyId: string | null; role?: string; branchScope?: string[] | null; departmentScope?: string[] | null }> {
  const access = await resolveCompanyAccess(user.id, user.vendorId)
  // 1. session-pinned company — must still be accessible
  if (session.activeCompanyId) {
    const row = access.find((a) => a.companyId === session.activeCompanyId)
    if (row) {
      return {
        companyId: row.companyId, role: row.role,
        branchScope: row.branchScope ? JSON.parse(row.branchScope) : null,
        departmentScope: row.departmentScope ? JSON.parse(row.departmentScope) : null,
      }
    }
  }
  // 2. ESS users: their employment fixes their company — but only while
  //    that company is ACTIVE (F-01, post-R-G review): a deactivated
  //    employment company falls through to the documented safe state below
  //    (default company when accessible, otherwise no company context) so a
  //    company-scoped operation can never run against a company the tenant
  //    has deactivated. The lookup is vendor-scoped as defense in depth — a
  //    foreign-tenant employee pointer can never mint a company context.
  if (user.role === "EMPLOYEE" && user.employeeId) {
    const emp = await db.employee.findFirst({
      where: { id: user.employeeId, vendorId: user.vendorId },
      select: { companyId: true, company: { select: { active: true, vendorId: true } } },
    })
    // F-01: the employment company must be ACTIVE and belong to the user's
    // OWN vendor — a deactivated or foreign-tenant company can never become
    // the active company context (fail through to the safe state below).
    if (emp?.companyId && emp.company?.active && emp.company.vendorId === user.vendorId) {
      return { companyId: emp.companyId, role: "EMPLOYEE" }
    }
  }
  // 3. default access row
  const def = access.find((a) => a.isDefault) || access[0]
  if (def) {
    return {
      companyId: def.companyId, role: def.role,
      branchScope: def.branchScope ? JSON.parse(def.branchScope) : null,
      departmentScope: def.departmentScope ? JSON.parse(def.departmentScope) : null,
    }
  }
  // 4. legacy administrative fallback (migrated tenants without access rows)
  if (user.role === "HR_ADMIN" || user.role === "VENDOR_OWNER") {
    const company = await db.company.findFirst({
      where: { vendorId: user.vendorId, active: true },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
      select: { id: true },
    })
    if (company) return { companyId: company.id, role: user.role }
  }
  // 5. no company context
  return { companyId: null }
}

// ---------- enforcement helpers (the centralized abstraction) ----------

/**
 * FAIL-CLOSED company context for a company-scoped operation. Throws Deny
 * when the caller has no usable active company. Use in every handler that
 * creates/updates/processes company-scoped business data.
 */
export function requireCompanyAccess(ctx: Ctx): string {
  if (!ctx.activeCompanyId) {
    throw new Deny(
      "No active company — select a company in the workspace switcher first, or ask an administrator for company access.",
      403,
    )
  }
  return ctx.activeCompanyId
}

/** Assert `companyId` is a valid, ACTIVE company of the caller's vendor AND
 *  accessible to the caller. Returns the company row. Safe 404 on failure
 *  (never reveals whether the company exists for another tenant). */
export async function assertCompany(ctx: Ctx, companyId: string, opts?: { allowInactive?: boolean }) {
  const company = await db.company.findFirst({
    where: { id: companyId, vendorId: ctx.vendorId, ...(opts?.allowInactive ? {} : { active: true }) },
  })
  if (!company) throw new Deny("Company not found", 404)
  if (!ctx.companyAccess?.some((a) => a.companyId === company.id)) {
    // admins without explicit rows may reach any company of their tenant
    if (!(ctx.role === "HR_ADMIN" || ctx.role === "VENDOR_OWNER")) {
      throw new Deny("You do not have access to this company", 403)
    }
  }
  return company
}

/** Prisma `where` fragment for company-scoped LIST queries. When the session
 *  operates in a concrete company, rows are filtered to it; the All Companies
 *  REPORTING context (ctx.allCompaniesMode) intentionally keeps the tenant
 *  scope for read-only consolidated surfaces (denied for mutations by the
 *  dispatcher gate).
 *
 *  R-03 (W1) — WRITE-path resolution (`forWrite: true`): the company clause
 *  never dissolves IN ALL COMPANIES MODE (a mode-context write throws Deny —
 *  backstop for code paths that bypass the central dispatcher gate); a
 *  legacy/no-company context keeps today's vendor-scoped behavior
 *  (single-company behavior preserved — W1-AC-11). */
export function companyWhere(ctx: Ctx, extra?: Record<string, unknown>, opts?: { forWrite?: boolean }): Record<string, unknown> {
  if (opts?.forWrite && ctx.allCompaniesMode) {
    throw new Deny("All Companies mode is a read-only consolidated view. Switch to a specific company to create, edit, process or post records.", 403)
  }
  const base: Record<string, unknown> = { vendorId: ctx.vendorId, ...(extra || {}) }
  if (ctx.activeCompanyId && !ctx.allCompaniesMode) base.companyId = ctx.activeCompanyId
  return base
}

/**
 * Company-aware employee scope: the tenant + branch/dept rules of
 * employeeScopeFilter PLUS the active-company boundary PLUS the per-company
 * branch/department scope from UserCompanyAccess. This is the shared filter
 * behind employee directory listings, pickers and manager list endpoints.
 *
 * R-03 (W1) — two fixes:
 *  1. WRITE-path resolution (`forWrite: true`): the company clause never
 *     dissolves IN ALL COMPANIES MODE (a mode-context write throws Deny —
 *     same semantics as employeeScopeFilter / companyWhere); a legacy
 *     no-company context keeps today's vendor-scoped behavior (W1-AC-11).
 *  2. The bogus INTERSECTION fix (SEC-05/SEC-13 W1 slice): a role-scoped
 *     manager (own branchId/departmentId) INTERSECTED with the access row's
 *     branch/department scope previously had the role clause OVERWRITTEN by
 *     the scope — a manager whose own branch sat outside the company scope
 *     silently received the whole company scope. Now: own-branch ∈ scope →
 *     keeps exactly it; own-branch ∉ scope → `{in: []}` (matches nothing);
 *     no role branch → the company scope applies.
 *
 * R-03 (independent verification) — this resolver now DELEGATES to
 * employeeScopeFilter (rbac.ts), which applies the same intersection
 * semantics to EVERY canonical-filter surface. The two resolvers share one
 * implementation and can no longer drift apart; the previous copy kept
 * `branchScope: '[]'` (empty JSON array) fail-OPEN — the empty scope was
 * skipped by a truthiness check and the user silently received ALL branches
 * of the company. Empty scope is now fail-closed (`{in: []}` matches
 * nothing); `null` remains the documented unrestricted value.
 */
export function companyEmployeeScopeFilter(ctx: Ctx, opts?: { forWrite?: boolean }): Record<string, unknown> {
  return employeeScopeFilter(ctx, opts)
}

/**
 * Assert a record belongs to the caller's active company (404 otherwise).
 * `rec` is any row that carries vendorId + (optionally) companyId. Records
 * without a companyId (tenant-level rows) pass the company check.
 */
export function assertCompanyRecord<T extends { vendorId: string; companyId?: string | null }>(
  rec: T | null,
  ctx: Ctx,
  what = "Record",
): T {
  if (!rec || rec.vendorId !== ctx.vendorId) throw new Deny(`${what} not found`, 404)
  if (ctx.activeCompanyId && rec.companyId && rec.companyId !== ctx.activeCompanyId && !ctx.allCompaniesMode) {
    throw new Deny(`${what} not found`, 404)
  }
  return rec
}

/**
 * Resolve the company a NEW company-scoped record must be created in.
 * The client MAY pass companyId (cross-company admin flows); it is VALIDATED
 * through assertCompany. Without one, the session's active company is
 * required (fail-closed — never a silent default for an invalid request).
 */
export async function resolveCreateCompany(ctx: Ctx, clientCompanyId?: unknown): Promise<string> {
  const cid = typeof clientCompanyId === "string" && clientCompanyId ? clientCompanyId : ctx.activeCompanyId
  if (!cid) throw new Deny("No active company for this operation — select a company first", 403)
  await assertCompany(ctx, cid)
  return cid
}

/**
 * Server-side relationship validation for org anchors (branch / department /
 * designation / managers / shift …): every referenced org row must belong to
 * the SAME company as the record being written. Cross-company relation ids
 * are rejected with 400 (they are client bugs, not missing records).
 */
export async function assertOrgAnchorBelongsToCompany(
  vendorId: string,
  companyId: string,
  refs: {
    branchId?: string | null
    departmentId?: string | null
    designationId?: string | null
    shiftId?: string | null
    reportingManagerId?: string | null
    hrManagerId?: string | null
    supervisorId?: string | null
    headId?: string | null
    managerId?: string | null
  },
): Promise<void> {
  const checks: [string, string, keyof typeof db][] = []
  if (refs.branchId) checks.push(["branchId", refs.branchId, "branch"])
  if (refs.departmentId) checks.push(["departmentId", refs.departmentId, "department"])
  if (refs.designationId) checks.push(["designationId", refs.designationId, "designation"])
  if (refs.shiftId) checks.push(["shiftId", refs.shiftId, "shift"])
  for (const empRef of [refs.reportingManagerId, refs.hrManagerId, refs.supervisorId, refs.headId, refs.managerId]) {
    if (empRef) checks.push(["employee reference", empRef, "employee"])
  }
  for (const [label, id, table] of checks) {
    const row = await (db as any)[table].findUnique({ where: { id }, select: { companyId: true, vendorId: true } })
    if (!row || row.vendorId !== vendorId) {
      throw new Deny(`${label} does not exist in this tenant`, 400)
    }
    if (row.companyId && row.companyId !== companyId) {
      throw new Deny(`${label} belongs to a different company`, 400)
    }
  }
}

/** Company-scoped settings resolution (company override → tenant → defaults).
 *  Thin wrapper so engines and handlers share ONE resolution path. */
export async function getSettingsForCompany(vendorId: string, companyId: string | null | undefined) {
  return getSettings(vendorId, { companyId: companyId || undefined })
}

// ---------- R-11/R-12 (W2) — employee-child ownership & journal stamping ----------

/** R-11/R-12 (W2, SEC-10) — the acting context of an approval finalize hook or
 *  a by-ID mutation: the full Ctx fields the engine passes. activeCompanyId /
 *  allCompaniesMode are OPTIONAL so legacy callers (unit tests, job workers
 *  without a company context) keep working; when a CONCRETE company is active
 *  the company checks below are enforced. */
export type DecisionCtx = {
  userId: string; userName: string; vendorId: string; ip?: string
  activeCompanyId?: string | null; allCompaniesMode?: boolean
}

/** R-11/R-12 (W2, SEC-10) — verify that an employee-child target belongs to the
 *  acting context's active company (non-disclosing 404 on mismatch). Legacy /
 *  no-company contexts and unattributed (NULL-company) legacy employees keep
 *  today's vendor-scoped behavior — the W1-approved compatibility rule. The
 *  check runs BEFORE any mutation. */
export async function assertDecisionEmployeeCompany(ctx: DecisionCtx, employeeId: string, what = "Record"): Promise<void> {
  if (!ctx.activeCompanyId || ctx.allCompaniesMode) return
  const owner = await db.employee.findUnique({ where: { id: employeeId }, select: { companyId: true } })
  if (owner?.companyId && owner.companyId !== ctx.activeCompanyId) {
    throw new Deny(`${what} not found`, 404)
  }
}

/** R-07 (W2) — resolve an employee's companyId for journal stamping: every new
 *  journal derived from an employee-child entity posts into the verified
 *  owning employee's company's books. NULL for a missing or legacy-unattributed
 *  employee (preserves historical behavior for pre-attribution tenants). */
export async function employeeCompanyIdForJournal(vendorId: string, employeeId: string): Promise<string | null> {
  const emp = await db.employee.findUnique({ where: { id: employeeId }, select: { companyId: true, vendorId: true } })
  if (!emp || emp.vendorId !== vendorId) return null
  return emp.companyId
}

/**
 * R-13 — the ONE settings write-path matrix. Every route that writes a settings
 * group goes through this (settings.save/patch and the dedicated
 * bonusPolicy / ai / wishes / messageTemplates routes, GAP-215):
 *   · All Companies mode → 403 (read-only consolidated view);
 *   · no company + overridable group → fail closed when the vendor has companies
 *     (a missing context must not rewrite the baseline every company inherits);
 *   · concrete company + tenant-wide group → allowed ONLY when the write cannot
 *     reach beyond the caller's authority: the tenant owner, or a tenant with a
 *     single company. Anyone else gets a 400 naming who can change it.
 *
 * NEW-001 — the original matrix told callers to use "the vendor-level context",
 * but no such context exists: admins always resolve a company and All Companies
 * mode is read-only, so tenant-wide groups (company profile, SMTP/SMS, PF,
 * tracking, field permissions, password policy…) could not be saved by anyone
 * on any tenant that had a company.
 */
export async function assertSettingsWriteContext(ctx: Ctx, group: string): Promise<void> {
  if (ctx.allCompaniesMode) {
    throw new Deny("All Companies mode is a read-only consolidated view. Switch to a specific company to change settings.", 403)
  }
  const overridable = isCompanyOverridableGroup(group)
  if (!ctx.activeCompanyId) {
    if (overridable && (await db.company.count({ where: { vendorId: ctx.vendorId } })) > 0) {
      throw new Deny("No active company for this company-overridable settings group — select a company first (a missing company context must not rewrite the tenant-wide baseline every company inherits).", 403)
    }
    return
  }
  if (overridable || ctx.role === "VENDOR_OWNER") return
  if ((await db.company.count({ where: { vendorId: ctx.vendorId } })) <= 1) return
  throw new Deny(
    `The "${group}" settings group is tenant-wide policy (not company-overridable) and this tenant has several companies, so it applies to all of them — it can only be changed at vendor-level by the tenant owner. Company-specific overrides apply only to: ${COMPANY_OVERRIDABLE_GROUPS.join(", ")}.`,
    400,
  )
}

/** Get the settings for a company-scoped ctx (active company when present). */
export async function getSettingsForCtx(ctx: Ctx) {
  return getSettings(ctx.vendorId, { companyId: ctx.activeCompanyId || undefined })
}

/**
 * Ensure a vendor has its default company (idempotent). Used by tenant
 * provisioning and the company CRUD so every tenant ALWAYS has ≥1 company.
 * Identity comes from the Vendor row + its HrSetting general group.
 */
export async function ensureDefaultCompany(vendorId: string, opts?: { name?: string; tx?: Prisma.TransactionClient }): Promise<string> {
  const client = opts?.tx ?? db
  const existing = await client.company.findFirst({ where: { vendorId }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] })
  if (existing) return existing.id
  const vendor = await client.vendor.findUnique({ where: { id: vendorId } })
  if (!vendor) throw Object.assign(new Error("Vendor not found"), { code: 404 })
  const general = await client.hrSetting.findMany({ where: { vendorId, group: "general" } })
  const g = Object.fromEntries(general.map((r) => [r.key, r.value]))
  const strip = (v: unknown) => (typeof v === "string" ? v.replace(/^"|"$/g, "") : null)
  const company = await client.company.create({
    data: {
      vendorId,
      code: "MAIN",
      name: opts?.name || vendor.name,
      legalName: vendor.legalName,
      logoUrl: vendor.logoUrl,
      email: vendor.email,
      phone: vendor.phone,
      address: vendor.address,
      signatoryName: strip(g.signatoryName),
      signatoryDesignation: strip(g.signatoryDesignation),
      signatureUrl: strip(g.signatureUrl),
      sealUrl: strip(g.sealUrl),
      isDefault: true,
      active: true,
    },
  })
  return company.id
}

// ---------- R-G (W2 completion patch, SEC-16) — provisioning default access rows ----------

/** R-G (SEC-16) — resolve the company a newly provisioned user's default
 *  access row points at:
 *    1. the linked employee's EMPLOYMENT company when one is known AND
 *       ACTIVE (F-01) — the ESS resolution rule (resolveActiveCompany rule 2)
 *       treats employment as the source of an employee's company ONLY while
 *       that company is active, so the row must agree with it: a row granted
 *       on an inactive company would be inert forever (resolveCompanyAccess
 *       filters inactive companies) — a dead grant. An inactive employment
 *       company therefore uses the same rule the runtime resolver applies:
 *       fall through to (2);
 *    2. the vendor's default ACTIVE company, using the exact ordering of
 *       resolveActiveCompany rule 4 (isDefault desc, createdAt asc) so a
 *       pre-existing legacy admin context and the new row resolve the SAME
 *       company. Inactive companies are skipped by the active filter — an
 *       inactive default-flagged company can never receive the row.
 *  Returns null when the vendor has no active company (legacy pre-split
 *  tenants) — no row can be granted, and user creation MUST NOT fail there. */
export async function resolveProvisioningCompanyId(
  vendorId: string,
  employeeCompanyId?: string | null,
): Promise<string | null> {
  if (employeeCompanyId) {
    // defense in depth: the caller has already validated the employee belongs
    // to this vendor; the company is re-checked against the same vendor here
    // so a forged/mismatched id can never point the row at another tenant's
    // company — and, per F-01, it must ALSO be active (see doc comment).
    const own = await db.company.findFirst({ where: { id: employeeCompanyId, vendorId, active: true }, select: { id: true } })
    if (own) return own.id
  }
  const fallback = await db.company.findFirst({
    where: { vendorId, active: true },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    select: { id: true },
  })
  return fallback?.id ?? null
}

/** R-G (SEC-16) — create the default UserCompanyAccess row for a newly
 *  provisioned user, INSIDE the caller's transaction (atomicity is the
 *  finding's core demand: a user must never land without its access row
 *  while its vendor has companies — every company-scoped module would
 *  fail-closed 403 "No active company" until a manual grant).
 *
 *  Row shape per the FINAL plan §4.2 R-G and the W1 R-04 auto-create:
 *    · role = the tenant user's role (User.role) — the company role starts
 *      as the tenant role, never wider;
 *    · permissions/excludedPermissions = '[]'/'[]' — the derived-baseline
 *      model keeps User.permissions the single inherited source; the S4a/S4b
 *      columns hold deliberate deltas only (interpreted from W3/R-14);
 *    · active = true, isDefault = true (the provisioning row IS the user's
 *      default company).
 *  Idempotent: an existing (userId, companyId) row is left untouched — a
 *  duplicate call can never mint a second row. */
export async function ensureProvisioningAccessRow(
  tx: Prisma.TransactionClient,
  args: {
    vendorId: string
    userId: string
    companyId: string
    role: string
    grantedById?: string | null
    grantedByName?: string | null
  },
): Promise<void> {
  const existing = await tx.userCompanyAccess.findFirst({
    where: { userId: args.userId, companyId: args.companyId },
    select: { id: true },
  })
  if (existing) return
  await tx.userCompanyAccess.create({
    data: {
      vendorId: args.vendorId,
      userId: args.userId,
      companyId: args.companyId,
      role: args.role,
      permissions: "[]", // S4a — derived-baseline delta: none
      excludedPermissions: "[]", // S4b — derived-baseline delta: none
      active: true,
      isDefault: true,
      grantedById: args.grantedById ?? null,
      grantedByName: args.grantedByName ?? null,
    },
  })
}
