// ============ RBAC: server-side authorization + tenant scoping ============
// Authorization chain (spec §3.2):
// Current User → Vendor → Employee belongs to Vendor? → Branch permission →
// Department permission → Role permission → Action permission → ALLOW/DENY
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

/** Scope limits: branch managers see only their branch, dept managers only their department */
export function employeeScopeFilter(ctx: Ctx): Record<string, unknown> {
  const f: Record<string, unknown> = { vendorId: ctx.vendorId }
  if (ctx.role === "BRANCH_MANAGER" && ctx.branchId) f.branchId = ctx.branchId
  if (ctx.role === "DEPT_MANAGER" && ctx.departmentId) f.departmentId = ctx.departmentId
  return f
}

/** Verify an employee record belongs to the caller's tenant AND visibility scope */
export async function assertEmployeeVisible(ctx: Ctx, employeeId: string) {
  const emp = await db.employee.findFirst({
    where: {
      id: employeeId,
      ...employeeScopeFilter(ctx),
    },
  })
  if (!emp) throw new Deny("Employee not found in your scope", 404)
  return emp
}

/** H-04/H-05 — scope guard for manager-facing LIST endpoints (payslips, loans,
 * advances, expenses, bonuses, letters, resignations…).
 * Rules:
 *   1. An explicit client-supplied `payload.employeeId` MUST pass
 *      assertEmployeeVisible (throws 404 for cross-branch/cross-department ids).
 *   2. With no employeeId, BRANCH_MANAGER / DEPT_MANAGER lists default to their
 *      own scope (branch/department employee set) instead of the whole tenant.
 *   3. Unscoped roles (HR_ADMIN, VENDOR_OWNER, …) see the whole tenant as before.
 * Returns a Prisma `where` fragment to spread into the query. */
export async function scopedEmployeeWhere(ctx: Ctx, p?: { employeeId?: string | null }): Promise<Record<string, unknown>> {
  if (p?.employeeId) {
    await assertEmployeeVisible(ctx, p.employeeId)
    return { employeeId: p.employeeId }
  }
  const scope = employeeScopeFilter(ctx)
  if (scope.branchId || scope.departmentId) {
    const emps = await db.employee.findMany({ where: scope, select: { id: true } })
    return { employeeId: { in: emps.map((e) => e.id) } }
  }
  return {}
}

/** ESS guard: employee users can only access their own employee record */
export async function assertSelf(ctx: Ctx, employeeId: string) {
  if (ctx.role === "EMPLOYEE" && ctx.employeeId !== employeeId) {
    throw new Deny("You can only access your own records")
  }
}

/** Generic tenant assert for any vendor-scoped record */
export async function assertTenant<T extends { vendorId: string }>(rec: T | null, ctx: Ctx, what = "Record"): Promise<T> {
  if (!rec || rec.vendorId !== ctx.vendorId) throw new Deny(`${what} not found`, 404)
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
 *  paged list can find rows beyond the loaded page. */
export async function applyEmployeeSearch(
  vendorId: string,
  where: { employeeId?: any },
  q: unknown,
): Promise<void> {
  const needle = String(q || "").trim()
  if (!needle) return
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
