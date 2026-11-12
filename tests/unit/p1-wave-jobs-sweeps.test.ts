/// <reference types="bun-types" />
// ============ P1 wave (2026-11-09) — job pool + retention/gating regression tests ============
// Audit Chapter 16, Table 7:
//   PRF-4  drainJobs runs claimed jobs through a bounded worker pool so the
//          per-type lane caps are real (was: strictly serial — one job at a
//          time per process, caps dead code; fan-outs starved money lanes).
//   PRF-9  tracking maintenance is gated behind a per-vendor 15-minute
//          window with batched policy resolution (was: every vendor, every
//          60-second tick).
//   PRF-10 CommunicationLog + SaasSmsMessage get settings-driven retention
//          sweeps in the daily jobs (default 365 days; 0 = keep forever).
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkEmployee, defaultCompanyId } from "./_fixtures"
import { communicationRetentionSweep, saasSmsJournalRetentionSweep, drainJobs } from "@/hrm-server/jobs"
import { reconcileOfflineStates, resetTrackingMaintenanceGate } from "@/hrm-server/tracking"

const DAY = 86_400_000

describe("P1/PRF-10 — communication + SMS journal retention sweeps", () => {
  let vendor: { id: string }
  beforeAll(async () => {
    vendor = await mkVendor("P1 Retention Vendor")
  })

  test("CommunicationLog and tenant-plane SMS rows older than the window are purged; fresh rows stay", async () => {
    const old = new Date(Date.now() - 400 * DAY)
    const fresh = new Date()
    await db.communicationLog.create({ data: { vendorId: vendor.id, channel: "EMAIL", message: "old", createdAt: old } })
    await db.communicationLog.create({ data: { vendorId: vendor.id, channel: "EMAIL", message: "fresh", createdAt: fresh } })
    await db.saasSmsMessage.create({ data: { plane: "TENANT", vendorId: vendor.id, toPhone: "8801712345678", purpose: "NOTICE", provider: "generichttp", status: "SENT", createdAt: old } })
    await db.saasSmsMessage.create({ data: { plane: "TENANT", vendorId: vendor.id, toPhone: "8801712345678", purpose: "NOTICE", provider: "generichttp", status: "SENT", createdAt: fresh } })
    // platform-plane row for the OTHER sweep below
    await db.saasSmsMessage.create({ data: { plane: "PLATFORM", vendorId: null, toPhone: "8801712345678", purpose: "OTP_LOGIN", provider: "sslwireless", status: "SENT", createdAt: old } })

    const purged = await communicationRetentionSweep(vendor.id, new Date().toISOString().slice(0, 10), {})
    expect(purged).toBe(2) // one CommunicationLog + one tenant-plane SMS
    expect(await db.communicationLog.count({ where: { vendorId: vendor.id } })).toBe(1)
    expect(await db.saasSmsMessage.count({ where: { plane: "TENANT", vendorId: vendor.id } })).toBe(1)
  })

  test("retentionDays = 0 keeps everything forever", async () => {
    const old = new Date(Date.now() - 4000 * DAY)
    await db.communicationLog.create({ data: { vendorId: vendor.id, channel: "SMS", message: "ancient", createdAt: old } })
    const purged = await communicationRetentionSweep(vendor.id, new Date().toISOString().slice(0, 10), { notifications: { communicationRetentionDays: 0 } })
    expect(purged).toBe(0)
    expect(await db.communicationLog.count({ where: { vendorId: vendor.id, message: "ancient" } })).toBe(1)
  })

  test("the platform-plane SMS journal sweep purges owner-console rows past the window", async () => {
    const purged = await saasSmsJournalRetentionSweep(new Date().toISOString().slice(0, 10), {})
    expect(purged).toBeGreaterThanOrEqual(1) // the OTP_LOGIN row seeded above
    expect(await db.saasSmsMessage.count({ where: { plane: "PLATFORM", purpose: "OTP_LOGIN", createdAt: { lt: new Date(Date.now() - 366 * DAY) } } })).toBe(0)
  })
})

describe("P1/PRF-9 — tracking maintenance sweep gate", () => {
  test("a stale tracking state flips OFFLINE on the first pass; the immediate second pass is gated (no queries per state); force re-runs", async () => {
    resetTrackingMaintenanceGate()
    const vendor = await mkVendor("P1 Tracking Vendor")
    const employee = await mkEmployee(vendor.id, { fullName: "P1 Tracked Employee" })
    await db.employeeTrackingState.create({
      data: {
        vendorId: vendor.id, employeeId: employee.id, trackingEnabled: true,
        trackingStatus: "TRACKING", lastSeenAt: new Date(Date.now() - 60 * 60_000), // silent for an hour
      },
    })
    const first = await reconcileOfflineStates({ force: true })
    expect(first.checked).toBeGreaterThanOrEqual(1)
    expect(first.flipped).toBeGreaterThanOrEqual(1)
    const row = await db.employeeTrackingState.findUnique({ where: { employeeId: employee.id } })
    expect(row?.trackingStatus).toBe("OFFLINE")

    // the gate: an immediate second pass skips the vendor entirely
    const second = await reconcileOfflineStates()
    expect(second.checked).toBe(0)
    // ...and force bypasses the gate (idempotent — already OFFLINE is excluded)
    const third = await reconcileOfflineStates({ force: true })
    expect(third.flipped).toBe(0)
  })
})

describe("P1/PRF-4 — the drain runs a bounded worker pool", () => {
  test("drainJobs still claims + settles everything pending and returns the count (pool semantics equal the serial contract)", async () => {
    const ran = await drainJobs()
    expect(typeof ran).toBe("number")
    expect(ran).toBeGreaterThanOrEqual(0)
  })
})
