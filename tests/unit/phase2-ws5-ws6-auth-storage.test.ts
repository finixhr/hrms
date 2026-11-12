// Phase 2 WS5 + WS6 — auth-path caches, session purge, storage rollup.
// SCL-17 bounded caches · SCL-18 role template cache · SCL-19 session purge ·
// MOD-5 storage rollup (read path + incremental bumps + nightly reconcile).
import "./_testdb"
import { describe, expect, test } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, makeCtx, uniq } from "./_fixtures"
import { getRoute } from "@/hrm-server/routes/router"
import { roleTemplate, invalidateRoleCache } from "@/hrm-server/auth"
import {
  storageUsedBytes,
  storageUsedBytesLive,
  bumpStorageRollup,
  reconcileStorageRollups,
} from "@/hrm-server/saas/entitlements"
import { getSettings } from "@/hrm-server/settings"
import { resolveEntitlements } from "@/hrm-server/saas/entitlements"

describe("SCL-18 roleTemplate cache", () => {
  test("custom role template resolves and caches; invalidation forces a fresh read", async () => {
    const v = await mkVendor()
    const key = uniq("CUSTOM")
    await db.role.create({
      data: { vendorId: v.id, key, name: "Custom", permissions: JSON.stringify(["employees.view", "leave.view"]), isSystem: false },
    })
    const t1 = await roleTemplate(v.id, key)
    expect(t1).toEqual(["employees.view", "leave.view"])
    // change the row WITHOUT invalidation → still the cached value inside TTL
    const roleRow = await db.role.findFirst({ where: { vendorId: v.id, key } })
    await db.role.update({ where: { id: roleRow!.id }, data: { permissions: JSON.stringify(["employees.view"]) } })
    const t2 = await roleTemplate(v.id, key)
    expect(t2).toEqual(["employees.view", "leave.view"]) // cached (30 s TTL)
    // explicit invalidation (what roles.save does) → fresh read immediately
    invalidateRoleCache(v.id)
    const t3 = await roleTemplate(v.id, key)
    expect(t3).toEqual(["employees.view"])
  })

  test("fallback to the static template for unknown roles is unchanged", async () => {
    const v = await mkVendor()
    const t = await roleTemplate(v.id, "HR_ADMIN")
    expect(Array.isArray(t)).toBe(true)
    expect(t.length).toBeGreaterThan(0)
  })
})

describe("SCL-17 bounded caches", () => {
  test("settings cache returns within TTL and invalidates on save", async () => {
    const v = await mkVendor()
    const s1 = await getSettings(v.id)
    expect(s1.general).toBeTruthy()
    const s2 = await getSettings(v.id)
    expect(s2.general).toBeTruthy()
    // save path invalidates (same settings object shape either way)
    const { saveSettingsGroup } = await import("@/hrm-server/settings")
    await saveSettingsGroup(v.id, "general", { companyName: "Cache Test Co" })
    const s3 = await getSettings(v.id)
    expect(s3.general.companyName).toBe("Cache Test Co")
  })

  test("entitlements resolve + invalidate round-trip", async () => {
    const v = await mkVendor()
    const e1 = await resolveEntitlements(v.id)
    expect(e1).toBeTruthy()
    const { invalidateEntitlements } = await import("@/hrm-server/saas/entitlements")
    invalidateEntitlements(v.id)
    const e2 = await resolveEntitlements(v.id)
    expect(e2.status).toBeTruthy()
  })
})

describe("SCL-19 session purge", () => {
  test("expired FULL + PREAUTH sessions and owner sessions are purgeable by expiresAt", async () => {
    const v = await mkVendor()
    const u = await mkUser(v.id, { role: "HR_ADMIN" })
    await db.session.create({ data: { id: `expired-${uniq("s")}`, userId: u.id, kind: "FULL", expiresAt: new Date(Date.now() - 86_400_000) } })
    await db.session.create({ data: { id: `preauth-${uniq("s")}`, userId: u.id, kind: "PREAUTH", expiresAt: new Date(Date.now() - 600_000) } })
    await db.session.create({ data: { id: `live-${uniq("s")}`, userId: u.id, kind: "FULL", expiresAt: new Date(Date.now() + 3_600_000) } })
    const purged = await db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } })
    expect(purged.count).toBe(2)
    const remaining = await db.session.findMany({ where: { userId: u.id } })
    expect(remaining.length).toBe(1)
    expect(remaining[0].id.startsWith("live-")).toBe(true)
  })
})

describe("MOD-5 storage rollup", () => {
  test("storageUsedBytes reads the rollup (1 read); missing row seeds from live compute", async () => {
    const v = await mkVendor()
    const emp = await mkEmployee(v.id, { fullName: "Storage Emp" })
    await db.employee.update({
      where: { id: emp.id },
      data: { photoUrl: "data:image/png;base64," + "A".repeat(1000) },
    })
    await db.employeeDocument.create({
      data: { vendorId: v.id, employeeId: emp.id, category: "IDENTITY", docType: "NID", title: "NID", docNumber: "1", fileData: "B".repeat(2000) },
    })
    // no rollup row yet → live compute + seed
    const first = await storageUsedBytes(v.id)
    expect(first).toBeGreaterThanOrEqual(3000)
    const row = await db.usageRollup.findUnique({ where: { vendorId: v.id } })
    expect(row).toBeTruthy()
    expect(Number(row!.storageBytes)).toBe(first)
    // second read comes from the rollup (mutate the row to prove it)
    await db.usageRollup.update({ where: { vendorId: v.id }, data: { storageBytes: 12345 } })
    const second = await storageUsedBytes(v.id)
    expect(second).toBe(12345)
  })

  test("bumpStorageRollup increments and decrements atomically (upsert-on-missing)", async () => {
    const v = await mkVendor()
    await bumpStorageRollup(v.id, 500)
    await bumpStorageRollup(v.id, 300)
    let row = await db.usageRollup.findUnique({ where: { vendorId: v.id } })
    expect(Number(row!.storageBytes)).toBe(800)
    await bumpStorageRollup(v.id, -200)
    row = await db.usageRollup.findUnique({ where: { vendorId: v.id } })
    expect(Number(row!.storageBytes)).toBe(600)
    // zero-delta is a no-op on a vendor with no row
    const v2 = await mkVendor()
    await bumpStorageRollup(v2.id, 0)
    expect(await db.usageRollup.findUnique({ where: { vendorId: v2.id } })).toBeNull()
  })

  test("reconcileStorageRollups corrects drift to the exact live total (set-based)", async () => {
    const v = await mkVendor()
    const emp = await mkEmployee(v.id, { fullName: "Reconcile Emp" })
    await db.employee.update({ where: { id: emp.id }, data: { photoUrl: "data:image/png;base64," + "C".repeat(777) } })
    // plant a WRONG rollup (simulating a missed/double-counted bump)
    await db.usageRollup.upsert({
      where: { vendorId: v.id },
      create: { vendorId: v.id, storageBytes: 1 },
      update: { storageBytes: 1 },
    })
    await reconcileStorageRollups()
    const row = await db.usageRollup.findUnique({ where: { vendorId: v.id } })
    const live = await storageUsedBytesLive(v.id)
    expect(Number(row!.storageBytes)).toBe(live)
    expect(live).toBeGreaterThanOrEqual(777)
  })

  test("upload authorization path: employees.docs create bumps the rollup", async () => {
    const v = await mkVendor()
    const owner = await mkUser(v.id, { role: "VENDOR_OWNER" })
    const emp = await mkEmployee(v.id, { fullName: "Doc Emp" })
    const before = await storageUsedBytes(v.id)
    // the same 1x1 PNG fixture the m37 upload-validation suite uses, padded
    const fileData = "data:image/png;base64," + ("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" + Buffer.from("P".repeat(1500)).toString("base64"))
    await getRoute("employees.docs.create")!.handler(makeCtx(owner), {
      employeeId: emp.id, category: "IDENTITY", docType: "NID", title: "NID", docNumber: uniq("N"),
      fileData,
    })
    const after = await storageUsedBytes(v.id)
    // F28 (P6) — the rollup tracks the STORED string's length. file bytes are
    // encrypted at rest (encf:: envelope ≈ input + 33%), so the bump equals
    // the ciphertext length, not the pre-encryption input length.
    const doc = await db.employeeDocument.findFirstOrThrow({ where: { vendorId: v.id, employeeId: emp.id }, orderBy: { createdAt: "desc" } })
    expect(doc.fileData?.startsWith("encf::")).toBe(true)
    expect(after - before).toBe(doc.fileData!.length)
    expect(after - before).toBeGreaterThan(fileData.length)
  })
})
