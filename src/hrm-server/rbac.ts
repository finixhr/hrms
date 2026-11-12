// ============ RBAC: server-side authorization + tenant scoping ============
// Authorization chain (spec §3.2):
// Current User → Vendor → Employee belongs to Vendor? → Branch permission →
// Department permission → Role permission → Action permission → ALLOW/DENY
// MULTI-COMPANY (2026-11-03): the chain gains the COMPANY boundary right
// after the vendor check — the active company (server-validated on the Ctx)
// narrows every employee/record scope. The centralized helpers below are the
// ONLY sanctioned way to scope queries; handlers must not hand-roll company
// filters (master prompt rule 17).
import { db } from "@/lib/db"
import type { Ctx } from "./types"

export class Deny extends Error {
  code: number
  constructor(msg: string, code = 403) {
    super(msg)
    this.code = code
  }
}

export function can(ctx: Ctx, module: string, action: string): boolean {
  return ctx.permissions.has("*") || ctx.permissions.has(`${module}.${action}`)
}

export function require(ctx: Ctx, module: string, action: string): void {
  if (!can(ctx, module, action)) {
    throw new Deny(`Permission denied: ${module}.${action} is not granted to your role`)
  }
}

/** Scope limits: branch managers see only their branch, dept managers only their
 *  department. MULTI-COMPANY — when a concrete company is the active context,
 *  the filter also pins the company boundary (the All Companies REPORTING
 *  context intentionally keeps the tenant scope: it is read-only).
 *
 *  R-03 (W1) — WRITE-path resolution (`forWrite: true`): the company clause
 *  NEVER dissolves IN ALL COMPANIES MODE — a mode-context write throws Deny
 *  (the dispatcher 403s mutations centrally; this is the in-filter backstop
 *  for any code path that reaches a query without passing the gate). A
 *  legacy/no-company context (pre-attribution users, vendors without
 *  companies) keeps today's vendor-scoped write behavior — single-company
 *  behavior is preserved bit-for-bit (W1-AC-11). Reads keep today's
 *  behavior exactly (mode = tenant-wide consolidated reads).
 *
 *  R-03 (independent verification) — PER-COMPANY BRANCH/DEPARTMENT SCOPE:
 *  UserCompanyAccess.branchScope/departmentScope ("JSON array of branch ids;
 *  null = all branches of the company" — schema.prisma) now narrows EVERY
 *  surface built on this filter (employee directory, pickers, manager lists,
 *  assertEmployeeVisible, reports, search). Semantics (fail-closed, the
 *  effective scope is always an INTERSECTION, never a union):
 *    • scope null/undefined → no narrowing (all branches/departments of the
 *      active company — the documented unrestricted value, and what the
 *      migration backfill / R-04 auto-create / wizard grants write).
 *    • scope = [ids…] → branchId/departmentId `{ in: ids }`.
 *    • scope = [] (empty array) → `{ in: [] }` — matches NOTHING. An empty
 *      explicit scope must not silently become unrestricted access.
 *    • a role-scoped manager's own branch/dept INTERSECTS the scope: inside
 *      it → keeps exactly it; outside → `{ in: [] }` (matches nothing). A
 *      restriction from one dimension is never discarded because another
 *      dimension is present.
 *    • All Companies mode: company.ts sets companyBranchScope/…Scope null on
 *      the Ctx in mode, so consolidated reads stay tenant-wide by design. */
export function employeeScopeFilter(ctx: Ctx, opts?: { forWrite?: boolean }): Record<string, unknown> {
  if (opts?.forWrite && ctx.allCompaniesMode) {
    throw new Deny("All Companies mode is a read-only consolidated view. Switch to a specific company to create, edit, process or post records.", 403)
  }
  const f: Record<string, unknown> = { vendorId: ctx.vendorId }
  if (ctx.activeCompanyId && !ctx.allCompaniesMode) f.companyId = ctx.activeCompanyId
  if (ctx.role === "BRANCH_MANAGER" && ctx.branchId) f.branchId = ctx.branchId
  if (ctx.role === "DEPT_MANAGER" && ctx.departmentId) f.departmentId = ctx.departmentId
  applyCompanyOrgScope(f, ctx)
  return f
}

/** R-03 — narrow `f` by the active company's per-access branch/department
 *  scope. Private helper of employeeScopeFilter; company.ts's
 *  companyEmployeeScopeFilter delegates to employeeScopeFilter so both
 *  resolvers share ONE implementation and can never drift apart again. */
function applyCompanyOrgScope(f: Record<string, unknown>, ctx: Ctx): void {
  // The scope is a property of ONE company access row — it only applies while
  // a concrete company is the active context (mode reads stay consolidated;
  // mode writes already threw in employeeScopeFilter).
  if (!ctx.activeCompanyId || ctx.allCompaniesMode) return
  if (ctx.companyBranchScope) {
    if (f.branchId === undefined) {
      // no role branch → the company scope applies (including the fail-closed
      // empty array: `{in: []}` matches nothing, never "all branches")
      f.branchId = { in: ctx.companyBranchScope }
    } else if (typeof f.branchId === "string") {
      // INTERSECT the role branch with the company scope: a manager whose own
      // branch is NOT in the scope matches NOTHING; one whose branch IS in
      // the scope keeps exactly their branch.
      f.branchId = ctx.companyBranchScope.includes(f.branchId) ? f.branchId : { in: [] }
    }
  }
  if (ctx.companyDepartmentScope) {
    if (f.departmentId === undefined) {
      f.departmentId = { in: ctx.companyDepartmentScope }
    } else if (typeof f.departmentId === "string") {
      f.departmentId = ctx.companyDepartmentScope.includes(f.departmentId) ? f.departmentId : { in: [] }
    }
  }
}

/** Verify an employee record belongs to the caller's tenant, company AND
 *  visibility scope (company check via the companyId column; cross-company
 *  ids 404 — the existence of another company's employee is never revealed).
 *  R-03 (W1) — `forWrite: true` routes the visibility check through the
 *  write-path resolution (the company clause never dissolves on a write).
 *  R-03 (independent verification) — the check now ALSO enforces the active
 *  company's per-access branchScope/departmentScope (see employeeScopeFilter):
 *  a directly-supplied employee id outside the effective scope 404s. */
export async function assertEmployeeVisible(ctx: Ctx, employeeId: string, opts?: { forWrite?: boolean }) {
  const emp = await db.employee.findFirst({
    where: {
      id: employeeId,
      ...employeeScopeFilter(ctx, opts),
    },
  })
  if (!emp) throw new Deny("Employee not found in your scope", 404)
  return emp
}

/** H-04/H-05 — scope guard for manager-facing LIST endpoints (payslips, loans,
 * advances, expenses, bonuses, letters, resignations…).
 * Rules:
 *   1. An explicit client-supplied `payload.employeeId` MUST pass
 *      assertEmployeeVisible (throws 404 for cross-branch/cross-department and
 *      cross-company ids).
 *   2. With no employeeId, BRANCH_MANAGER / DEPT_MANAGER lists default to their
 *      own scope (branch/department employee set) instead of the whole tenant.
 *   3. SEC-05 (W2 carry-forward closure): while a CONCRETE company is the
 *      active context, EVERY role — including unscoped ones (HR_ADMIN,
 *      VENDOR_OWNER, PAYROLL_OFFICER, …) — resolves an explicit permitted
 *      employee set from the complete canonical scope (active companyId +
 *      branch + department + role restrictions, via employeeScopeFilter).
 *      Previously the employee set was only resolved when a branch/department
 *      clause existed, so an unscoped role fell through to `{}` and received
 *      TENANT-WIDE employee-child records (payslips of every company in the
 *      vendor). Empty permitted sets stay fail-closed (`{ in: [] }`); a `null`
 *      scope still means "all of the active company", never "all companies".
 *   4. The All Companies read-only REPORTING context keeps the authorized
 *      tenant-wide consolidated read (returns `{}`); legacy/no-company contexts
 *      keep the pre-W2 vendor-wide behavior exactly.
 * Returns a Prisma `where` fragment to spread into the query. */
export async function scopedEmployeeWhere(ctx: Ctx, p?: { employeeId?: string | null }): Promise<Record<string, unknown>> {
  if (p?.employeeId) {
    await assertEmployeeVisible(ctx, p.employeeId)
    return { employeeId: p.employeeId }
  }
  const scope = employeeScopeFilter(ctx)
  // SEC-05: concrete active company ⇒ ALWAYS restrict to the company's
  // permitted employee set, even for roles without a branch/department clause.
  if (ctx.activeCompanyId && !ctx.allCompaniesMode) {
    const emps = await db.employee.findMany({ where: scope, select: { id: true } })
    return { employeeId: { in: emps.map((e) => e.id) } }
  }
  // Legacy/no-company context: role branch/department narrowing still applies.
  if (scope.branchId || scope.departmentId) {
    const emps = await db.employee.findMany({ where: scope, select: { id: true } })
    return { employeeId: { in: emps.map((e) => e.id) } }
  }
  // All Companies consolidated read / legacy unscoped read: tenant-wide.
  return {}
}

/** AUDIT M-7 (2026-11-07) — RELATION-filter variant of scopedEmployeeWhere
 *  for child models that declare a Prisma `employee` relation (LeaveRequest,
 *  Loan, PayrollEntry today). Instead of materializing the ENTIRE permitted
 *  employee set as `employeeId: { in: [...ids] }` on every request (5k-50k
 *  bind parameters for large tenants — slow queries, PgBouncer pressure and
 *  Postgres's ~32k per-statement parameter limit), the scope composes into a
 *  JOIN: `{ employee: { is: <employeeScopeFilter> } }`. Semantically
 *  EQUIVALENT to the materialized form (both restrict to live employees
 *  matching the scope) but O(1) in parameters.
 *  Callers must ONLY use this with models that have the relation — check
 *  `employee Employee @relation(...)` on the model in schema.prisma first.
 *  FIN-017 (Phase 2, 2026-11-10) — CLOSED: migration 9_wave9zzam added the
 *  relation to the 47 employee-child models that lacked it (plus
 *  (vendorId, employeeId) indexes for the six tables without an
 *  employeeId probe path); all 17 former materialized call sites across
 *  letters/pf/attendance/finance/exit/leave/payroll now use this variant,
 *  and scripts/check-model-isolation.mjs keeps the registry
 *  (deploy/model-isolation-registry.json) honest in CI. The materialized
 *  helper above remains for the no-relation edge (none today among
 *  employee-child models) and as the documented semantic reference. */
export async function scopedEmployeeRelationWhere(ctx: Ctx, p?: { employeeId?: string | null }): Promise<Record<string, unknown>> {
  if (p?.employeeId) {
    await assertEmployeeVisible(ctx, p.employeeId)
    return { employeeId: p.employeeId }
  }
  const scope = employeeScopeFilter(ctx)
  // The SEC-05 company rule and the All-Companies consolidated read both
  // compose directly into the relation's `is` filter — no id list is built.
  // The tenant-wide tail (`{}`) matches scopedEmployeeWhere exactly: the
  // caller's own vendorId clause already scopes the read.
  if (ctx.activeCompanyId && !ctx.allCompaniesMode) {
    return { employee: { is: scope } }
  }
  if (scope.branchId || scope.departmentId) {
    return { employee: { is: scope } }
  }
  return {}
}

/** ESS guard: employee users can only access their own employee record */
export async function assertSelf(ctx: Ctx, employeeId: string) {
  if (ctx.role === "EMPLOYEE" && ctx.employeeId !== employeeId) {
    throw new Deny("You can only access your own records")
  }
}

/** Generic tenant assert for any vendor-scoped record. MULTI-COMPANY —
 *  when the record carries a companyId and a concrete company is the active
 *  context, the record's company must match (cross-company record ids 404).
 *  Tenant-level rows (no companyId) pass, as does the read-only All
 *  Companies reporting context. */
export async function assertTenant<T extends { vendorId: string }>(rec: T | null, ctx: Ctx, what = "Record"): Promise<T> {
  if (!rec || rec.vendorId !== ctx.vendorId) throw new Deny(`${what} not found`, 404)
  const withCompany = rec as T & { companyId?: string | null }
  if (ctx.activeCompanyId && withCompany.companyId && withCompany.companyId !== ctx.activeCompanyId && !ctx.allCompaniesMode) {
    throw new Deny(`${what} not found`, 404)
  }
  return rec
}

export function listPerms(ctx: Ctx) {
  return Array.from(ctx.permissions).sort()
}

/** P6 WS-B — intersect an existing (possibly scoped) employeeId filter with a
 *  server-side employee search (q matches name/code case-insensitively).
 *  Mutates `where.employeeId` in place:
 *    - no prior filter          → { in: matched ids }
 *    - prior { in: [...] } set  → the INTERSECTION (scope ∩ search)
 *    - prior single id          → kept only when it matches, else "__none__"
 *      (a sentinel that matches nothing — Prisma has no FALSE literal)
 *  The SCL-10 discipline: the employee set is resolved ONCE per request so a
 *  paged list can find rows beyond the loaded page.
 *  AUDIT M-7 (2026-11-07) — RELATION-shape support: when `where.employee` is
 *  already a `{ is: <scope> }` relation filter (scopedEmployeeRelationWhere),
 *  the search INTERSECTS into the relation's `is` clause instead of
 *  materializing any id list — the whole query stays O(1) in parameters. */
export async function applyEmployeeSearch(
  vendorId: string,
  where: { employeeId?: any; employee?: any },
  q: unknown,
): Promise<void> {
  const needle = String(q || "").trim()
  if (!needle) return
  const relShape = where.employee && typeof where.employee === "object" && where.employee.is && typeof where.employee.is === "object"
    ? where.employee : null
  if (relShape) {
    // relation shape — compose the search into `employee.is` (AND of the
    // existing scope and the name/code match), no id materialization
    const priorIs = relShape.is
    relShape.is = {
      AND: [
        priorIs,
        { OR: [
          { fullName: { contains: needle, mode: "insensitive" } },
          { code: { contains: needle, mode: "insensitive" } },
        ] },
      ],
    }
    return
  }
  const matches = await db.employee.findMany({
    where: {
      vendorId,
      OR: [
        { fullName: { contains: needle, mode: "insensitive" } },
        { code: { contains: needle, mode: "insensitive" } },
      ],
    },
    select: { id: true },
  })
  const matched = new Set(matches.map((m) => m.id))
  const prior = where.employeeId
  if (prior == null) {
    where.employeeId = { in: [...matched] }
  } else if (typeof prior === "string") {
    where.employeeId = matched.has(prior) ? prior : "__none__"
  } else if (prior && Array.isArray(prior.in)) {
    where.employeeId = { in: prior.in.filter((x: string) => matched.has(x)) }
  } else {
    where.employeeId = "__none__"
  }
}
