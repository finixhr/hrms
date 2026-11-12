/// <reference types="bun-types" />
// ============ Test fixtures: vendor / user / employee / ctx ============
import "./_testdb" // first — sets DATABASE_URL before db.ts constructs the client
import { db } from "@/lib/db"
import type { Ctx, RoleKey } from "@/hrm-server/types"
import { ROLE_TEMPLATES } from "@/hrm-server/types"
import { newToken, sessionTokenHash } from "@/hrm-server/auth"

let seq = 0
export const uniq = (p = "id") => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 7)}`

/** GAP-101 — every tenant in production has at least one Company (provisioning
 *  runs ensureDefaultCompany; the W1 dispatcher gate fails closed without one),
 *  so the shared fixtures provision the same shape. Companyless vendors are the
 *  legacy pre-split edge case: suites that test it ask for it explicitly with
 *  `{ company: false }` rather than inheriting it by accident. */
export async function mkVendor(name = "Test Vendor", opts: { company?: boolean } = {}) {
  const vendor = await db.vendor.create({ data: { name, code: uniq("V") } })
  if (opts.company !== false) {
    const c = await db.company.create({ data: { vendorId: vendor.id, code: "MAIN", name, isDefault: true, active: true } })
    fixtureCompany.set(vendor.id, c.id)
  }
  return vendor
}

// Only vendors whose company the fixture itself provisioned get automatic
// stamping: a suite that creates its own Company rows keeps full control over
// who holds access to which company, exactly as it asserts.
const fixtureCompany = new Map<string, string>()

/** The fixture-provisioned default company of a vendor (null when the suite
 *  opted out with `{ company: false }` and manages companies itself). */
export async function defaultCompanyId(vendorId: string): Promise<string | null> {
  return fixtureCompany.get(vendorId) ?? null
}

export async function mkUser(vendorId: string, over: { role?: RoleKey | string; email?: string; name?: string; permissions?: string[]; employeeId?: string | null; branchId?: string | null; departmentId?: string | null } = {}) {
  const user = await db.user.create({
    data: {
      name: over.name || "Test User",
      email: over.email || `${uniq("u")}@test.local`,
      passwordHash: "x",
      role: over.role || "VENDOR_OWNER",
      permissions: JSON.stringify(over.permissions ?? ROLE_TEMPLATES[(over.role as RoleKey) || "VENDOR_OWNER"] ?? []),
      vendorId,
      employeeId: over.employeeId ?? null,
      branchId: over.branchId ?? null,
      departmentId: over.departmentId ?? null,
    },
  })
  // GAP-101 — same row users.save provisions (R-G): non-admin roles have no
  // legacy fallback, so without it they 403 at the company gate.
  const companyId = fixtureCompany.get(vendorId)
  if (companyId) {
    await db.userCompanyAccess.create({
      data: { vendorId, userId: user.id, companyId, role: user.role, active: true, isDefault: true },
    })
  }
  return user
}

export async function mkBranch(vendorId: string, name = "HQ") {
  return db.branch.create({ data: { vendorId, name, code: uniq("B"), companyId: await defaultCompanyId(vendorId) } })
}

export async function mkEmployee(vendorId: string, over: { branchId?: string | null; departmentId?: string | null; fullName?: string; code?: string } = {}) {
  return db.employee.create({
    data: {
      vendorId,
      companyId: await defaultCompanyId(vendorId),
      fullName: over.fullName || "Test Employee",
      code: over.code || uniq("E"),
      branchId: over.branchId ?? null,
      departmentId: over.departmentId ?? null,
      joiningDate: "2024-01-01",
      employmentType: "PERMANENT",
      status: "ACTIVE",
    },
  })
}

export async function mkSession(userId: string, kind = "FULL") {
  const id = newToken()
  await db.session.create({
    data: { id, tokenHash: sessionTokenHash(id), userId, kind, csrfToken: newToken(), expiresAt: new Date(Date.now() + 3600_000), ip: "127.0.0.1", lastSeenAt: new Date() },
  })
  return id
}

export function makeCtx(user: { id: string; vendorId: string; role: string; employeeId?: string | null; branchId?: string | null; departmentId?: string | null }, permsOverride?: string[]): Ctx {
  const perms = permsOverride ?? (user.role === "VENDOR_OWNER" ? ["*"] : (ROLE_TEMPLATES as Record<string, string[]>)[user.role] ?? [])
  const companyId = fixtureCompany.get(user.vendorId) ?? null
  return {
    userId: user.id,
    userName: "Test User",
    vendorId: user.vendorId,
    role: user.role as RoleKey,
    permissions: new Set(perms),
    employeeId: user.employeeId ?? undefined,
    branchId: user.branchId ?? undefined,
    departmentId: user.departmentId ?? undefined,
    ip: "127.0.0.1",
    // GAP-101 — the same company context getCtxFromToken resolves in production
    ...(companyId
      ? { activeCompanyId: companyId, companyAccess: [{ companyId, role: user.role, isDefault: true }] as unknown as Ctx["companyAccess"] }
      : {}),
  }
}
