/// <reference types="bun-types" />
// ============ Phase 4 WS-D — platform hygiene (SEC-16 / FE-7 / usage metering) ============
// SEC-16: sweepSaasAuditRetention purges platform audit rows past the
//         retention window (default 730 days); an EXPLICIT 0 disables it —
//         parsed without the falsy-`||` trap.
// FE-7:   the four dead dependencies stay out (manifest + source tree).
// Metering: captureUsageSnapshots writes the monthly UsageSnapshot series for
//         EVERY vendor in one set-based statement; past months stay frozen;
//         owner.usage.history serves the series with tenant identity.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import * as fs from "fs"
import * as path from "path"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee } from "./_fixtures"
import { sweepSaasAuditRetention, captureUsageSnapshots } from "@/hrm-server/jobs"
import { ownerRoutes } from "@/hrm-server/saas/owner-routes"
import type { OwnerCtx } from "@/hrm-server/saas/owner-auth"

let vendor: { id: string }
let ctx: OwnerCtx

const callOwnerAction = async (action: string, payload: any) => {
  const def = ownerRoutes[action]
  if (!def) throw new Error(`unknown owner action: ${action}`)
  const parsed = def.schema ? def.schema.parse(payload) : payload
  return (def.handler as any)(ctx, parsed)
}

beforeAll(async () => {
  vendor = await mkVendor("P4 WSD Vendor")
  ctx = {
    ownerId: "p4-wsd-owner",
    name: "P4 WSD Owner",
    email: "p4-wsd@test.example",
    roleKey: "SUPER_ADMIN",
    permissions: new Set(["tenants.view"]),
  }
})

describe("SEC-16 — SaaSAuditLog retention sweep", () => {
  test("rows older than the window are purged; younger rows survive; returns the count", async () => {
    const old = await db.saasAuditLog.create({ data: {
      actorId: "a", actorName: "old", action: "OWNER_LOGIN", entity: "OwnerSession", entityId: null,
      summary: "old row",
      createdAt: new Date(Date.now() - 800 * 86400000), // ~800 days — past the 730 default
    } })
    const young = await db.saasAuditLog.create({ data: {
      actorId: "a", actorName: "young", action: "OWNER_LOGIN", entity: "OwnerSession", entityId: null, summary: "young row",
    } })
    const prev = process.env.HRM_SAAS_AUDIT_RETENTION_DAYS
    delete process.env.HRM_SAAS_AUDIT_RETENTION_DAYS
    try {
      const purged = await sweepSaasAuditRetention()
      expect(purged).toBeGreaterThanOrEqual(1)
      expect(await db.saasAuditLog.findUnique({ where: { id: old.id } })).toBeNull()
      expect(await db.saasAuditLog.findUnique({ where: { id: young.id } })).not.toBeNull()
    } finally {
      if (prev != null) process.env.HRM_SAAS_AUDIT_RETENTION_DAYS = prev
    }
  })

  test("an EXPLICIT HRM_SAAS_AUDIT_RETENTION_DAYS=0 disables the sweep (no falsy-|| trap)", async () => {
    const ancient = await db.saasAuditLog.create({ data: {
      actorId: "a", actorName: "ancient", action: "NOTIFICATION_EMAIL", entity: "Vendor", entityId: null,
      summary: "ancient row",
      createdAt: new Date(Date.now() - 4000 * 86400000), // ~11 years old
    } })
    const prev = process.env.HRM_SAAS_AUDIT_RETENTION_DAYS
    process.env.HRM_SAAS_AUDIT_RETENTION_DAYS = "0"
    try {
      const purged = await sweepSaasAuditRetention()
      expect(purged).toBe(0)
      expect(await db.saasAuditLog.findUnique({ where: { id: ancient.id } })).not.toBeNull()
    } finally {
      if (prev != null) process.env.HRM_SAAS_AUDIT_RETENTION_DAYS = prev
      else delete process.env.HRM_SAAS_AUDIT_RETENTION_DAYS
      await db.saasAuditLog.deleteMany({ where: { id: ancient.id } })
    }
  })
})

describe("Per-tenant usage metering (UsageSnapshot series)", () => {
  test("one capture call snapshots EVERY vendor with the right counts, idempotently", async () => {
    // a second vendor with richer data
    const v2 = await mkVendor("P4 WSD Vendor 2")
    await mkUser(v2.id, { role: "VENDOR_OWNER", name: "Admin" })
    await mkEmployee(v2.id, { fullName: "Active Emp" })
    const leaver = await mkEmployee(v2.id, { fullName: "Left Emp" })
    await db.employee.update({ where: { id: leaver.id }, data: { status: "RESIGNED" } })

    const date = new Date().toISOString().slice(0, 10)
    const before = await db.vendor.count()
    const captured = await captureUsageSnapshots(date)
    expect(captured).toBe(before) // one row per vendor, including vendors with no data

    const year = Number(date.slice(0, 4)), month = Number(date.slice(5, 7))
    const snap = await db.usageSnapshot.findUnique({ where: { vendorId_periodYear_periodMonth: { vendorId: v2.id, periodYear: year, periodMonth: month } } })
    expect(snap).toBeTruthy()
    expect(snap!.employeesTotal).toBe(2)          // active + resigned
    expect(snap!.employeesPayroll).toBe(1)        // payroll-scope excludes the leaver
    expect(snap!.portalUsers).toBe(1)             // the VENDOR_OWNER
    expect(snap!.devicesEnrolled).toBe(0)

    // idempotent: a second capture the same day UPDATES, never duplicates
    await captureUsageSnapshots(date)
    const rows = await db.usageSnapshot.findMany({ where: { vendorId: v2.id, periodYear: year, periodMonth: month } })
    expect(rows).toHaveLength(1)
  })

  test("past months stay FROZEN — a new capture never rewrites history", async () => {
    const year = 2025, month = 6
    await db.usageSnapshot.create({ data: {
      vendorId: vendor.id, periodYear: year, periodMonth: month,
      employeesTotal: 42, employeesPayroll: 40, portalUsers: 3, devicesEnrolled: 2, storageBytes: 1000n,
    } })
    const today = new Date().toISOString().slice(0, 10)
    await captureUsageSnapshots(today)
    const frozen = await db.usageSnapshot.findUnique({ where: { vendorId_periodYear_periodMonth: { vendorId: vendor.id, periodYear: year, periodMonth: month } } })
    expect(frozen?.employeesTotal).toBe(42) // untouched by today's capture
  })

  test("owner.usage.history serves the monthly series with tenant identity", async () => {
    const out: any = await callOwnerAction("owner.usage.history", { id: vendor.id })
    expect(out.tenant.id).toBe(vendor.id)
    expect(typeof out.tenant.name).toBe("string")
    const periods = out.months.map((m: any) => m.period)
    // the frozen 2025-06 row and the current month are both in the series
    expect(periods).toContain("2025-06")
    const current = new Date().toISOString().slice(0, 7)
    expect(periods).toContain(current)
    const frozenRow = out.months.find((m: any) => m.period === "2025-06")
    expect(frozenRow.employeesTotal).toBe(42)
    expect(frozenRow.storageBytes).toBe(1000)
    // newest first
    expect(out.months[0].period).toBe(current)
  })
})

describe("FE-7 — dead dependencies stay removed", () => {
  const DEAD = ["@xyflow/react", "dagre", "html-to-image", "@types/dagre"]

  test("package.json and bun.lock are free of the four packages", () => {
    const pkg = fs.readFileSync(path.join(import.meta.dir, "..", "..", "package.json"), "utf8")
    const lock = fs.readFileSync(path.join(import.meta.dir, "..", "..", "bun.lock"), "utf8")
    for (const dep of DEAD) {
      expect(pkg.includes(`"${dep}"`)).toBe(false)
      expect(lock.includes(`"${dep}"`)).toBe(false)
    }
  })

  test("no source file imports them (reintroduction guard)", () => {
    const srcRoot = path.join(import.meta.dir, "..", "..", "src")
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(ts|tsx|js|jsx)$/.test(e.name)) {
          const content = fs.readFileSync(p, "utf8")
          if (/from ["'](react-)?(flow|dagre|html-to-image)|@xyflow|html-to-image/.test(content)) offenders.push(p)
        }
      }
    }
    walk(srcRoot)
    expect(offenders).toEqual([])
  })
})
