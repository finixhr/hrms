/// <reference types="bun-types" />
// ============ Test fixtures: vendor / user / employee / ctx ============
import "./_testdb" // first — sets DATABASE_URL before db.ts constructs the client
import { db } from "@/lib/db"
import type { Ctx, RoleKey } from "@/hrm-server/types"
import { ROLE_TEMPLATES } from "@/hrm-server/types"
import { newToken, sessionTokenHash } from "@/hrm-server/auth"

let seq = 0
export const uniq = (p = "id") => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 7)}`

export async function mkVendor(name = "Test Vendor") {
  return db.vendor.create({ data: { name, code: uniq("V") } })
}

export async function mkUser(vendorId: string, over: { role?: RoleKey | string; email?: string; name?: string; permissions?: string[]; employeeId?: string | null; branchId?: string | null; departmentId?: string | null } = {}) {
  return db.user.create({
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
}

export async function mkBranch(vendorId: string, name = "HQ") {
  return db.branch.create({ data: { vendorId, name, code: uniq("B") } })
}

export async function mkEmployee(vendorId: string, over: { branchId?: string | null; departmentId?: string | null; fullName?: string; code?: string } = {}) {
  return db.employee.create({
    data: {
      vendorId,
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
  }
}
