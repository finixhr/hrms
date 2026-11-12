/// <reference types="bun-types" />
// ============ R15 regression: subscription expiry notice automation ============
// Audit (2026-10-12): reminders were email-only at hardcoded 30/15/7/3/1 days
// before expiry, with a SaasSetting marker as the only dedupe (failed sends
// were never retried, nothing was journaled). Now:
//   · lead times are configurable (subscription.renewalReminderDays)
//   · post-expiry notices configurable (subscription.postExpiryNoticeDays)
//   · every email/SMS attempt is journaled in SaasExpiryNotice with the
//     unique key (vendor, kind, refDate, daysOffset, channel)
//   · SENT rows never re-send; FAILED rows retry up to 3 attempts
//   · optional SMS channel per the expirySmsEnabled setting
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, uniq } from "./_fixtures"
import { notifyExpiryNotice } from "@/hrm-server/saas/notify"

let vendor: { id: string }
let adminEmail: string

beforeAll(async () => {
  vendor = await mkVendor("R15 Vendor")
  const u = await mkUser(vendor.id, { role: "VENDOR_OWNER", email: `r15-admin-${uniq()}@test.example`, name: "R15 Admin" })
  adminEmail = u.email
})

const baseNotice = (over: Partial<Parameters<typeof notifyExpiryNotice>[0]> = {}) => ({
  vendorId: vendor.id,
  vendorName: "R15 Vendor",
  planName: "R15 Growth",
  endDate: new Date(Date.now() + 7 * 86400000),
  daysOffset: 7,
  kind: "PRE_EXPIRY" as const,
  adminEmail,
  adminPhone: null,
  smsEnabled: false,
  ...over,
})

describe("R15 — expiry notice journal, dedupe and retries", () => {
  test("every attempt is journaled in SaasExpiryNotice (channel-aware)", async () => {
    await notifyExpiryNotice(baseNotice())
    const rows = await db.saasExpiryNotice.findMany({
      where: { vendorId: vendor.id, kind: "PRE_EXPIRY", daysOffset: 7 },
    })
    expect(rows.length).toBe(1) // email channel only (sms disabled)
    expect(rows[0].channel).toBe("EMAIL")
    expect(rows[0].refDate).toBe(new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10))
    // no gateway in the test DB → the attempt is journaled as SKIPPED, not SENT
    expect(["SKIPPED", "SENT", "FAILED"]).toContain(rows[0].status)
    expect(rows[0].attempts).toBe(1)
  })

  test("SENT rows never re-send; SKIPPED/FAILED rows retry (attempts increment)", async () => {
    // --- SENT row: hard dedupe, no further attempt ---
    const sentEnd = new Date(Date.now() + 9 * 86400000)
    const sentRef = sentEnd.toISOString().slice(0, 10)
    await db.saasExpiryNotice.create({
      data: {
        vendorId: vendor.id, kind: "PRE_EXPIRY", refDate: sentRef, daysOffset: 9,
        channel: "EMAIL", status: "SENT", attempts: 1, detail: "delivered",
      },
    })
    const resSent = await notifyExpiryNotice(baseNotice({ endDate: sentEnd, daysOffset: 9 }))
    expect(resSent.email.status).toBe("SENT") // journal guard short-circuits
    const sentRows = await db.saasExpiryNotice.findMany({
      where: { vendorId: vendor.id, kind: "PRE_EXPIRY", daysOffset: 9, channel: "EMAIL" },
    })
    expect(sentRows.length).toBe(1)
    expect(sentRows[0].attempts).toBe(1) // no second send attempt

    // --- SKIPPED row (gateway unset): retried, attempts increment ---
    const skipEnd = new Date(Date.now() + 11 * 86400000)
    await notifyExpiryNotice(baseNotice({ endDate: skipEnd, daysOffset: 11 }))
    await notifyExpiryNotice(baseNotice({ endDate: skipEnd, daysOffset: 11 })) // retry
    const skipRows = await db.saasExpiryNotice.findMany({
      where: { vendorId: vendor.id, kind: "PRE_EXPIRY", daysOffset: 11, channel: "EMAIL" },
    })
    expect(skipRows.length).toBe(1) // same journal row (unique key)
    expect(skipRows[0].attempts).toBe(2) // retried once more
  })

  test("different lead times journal separately (7 vs 3 days before)", async () => {
    await notifyExpiryNotice(baseNotice({ daysOffset: 3 }))
    const rows = await db.saasExpiryNotice.findMany({
      where: { vendorId: vendor.id, kind: "PRE_EXPIRY", channel: "EMAIL" },
      orderBy: { daysOffset: "asc" },
    })
    const offsets = rows.map((r) => r.daysOffset)
    expect(offsets).toContain(3)
    expect(offsets).toContain(7)
  })

  test("post-expiry notices journal with negative offsets (rejoin nudges)", async () => {
    const expired = new Date(Date.now() - 2 * 86400000)
    await notifyExpiryNotice(baseNotice({ kind: "POST_EXPIRY", endDate: expired, daysOffset: -2 }))
    const rows = await db.saasExpiryNotice.findMany({
      where: { vendorId: vendor.id, kind: "POST_EXPIRY" },
    })
    expect(rows.length).toBe(1)
    expect(rows[0].daysOffset).toBe(-2)
    expect(rows[0].refDate).toBe(expired.toISOString().slice(0, 10))
  })

  test("SMS channel journals as a separate row when enabled", async () => {
    await notifyExpiryNotice(baseNotice({
      daysOffset: 1, smsEnabled: true, adminPhone: "+8801700000001",
    }))
    const rows = await db.saasExpiryNotice.findMany({
      where: { vendorId: vendor.id, kind: "PRE_EXPIRY", daysOffset: 1 },
    })
    expect(rows.length).toBe(2) // EMAIL + SMS
    expect(rows.map((r) => r.channel).sort()).toEqual(["EMAIL", "SMS"])
  })

  test("retry guard: attempts cap at 3 (failed rows stop retrying)", async () => {
    // simulate a FAILED row with 3 attempts already recorded
    const end = new Date(Date.now() + 5 * 86400000)
    const refDate = end.toISOString().slice(0, 10)
    await db.saasExpiryNotice.create({
      data: {
        vendorId: vendor.id, kind: "PRE_EXPIRY", refDate, daysOffset: 5,
        channel: "EMAIL", status: "FAILED", attempts: 3, detail: "simulated gateway error",
      },
    })
    const res = await notifyExpiryNotice(baseNotice({ endDate: end, daysOffset: 5 }))
    // exhausted → the journal guard returns WITHOUT sending again
    expect(res.email.status).toBe("FAILED")
    const rows = await db.saasExpiryNotice.findMany({
      where: { vendorId: vendor.id, kind: "PRE_EXPIRY", daysOffset: 5, channel: "EMAIL" },
    })
    expect(rows.length).toBe(1)
    expect(rows[0].attempts).toBe(3) // no fourth attempt
  })
})

describe("R15 — settings drive the sweep windows", () => {
  test("renewalReminderDays + postExpiryNoticeDays round-trip through settings", async () => {
    const { saveSaasSettingsGroup, getSaasSettings } = await import("@/hrm-server/saas/settings")
    await saveSaasSettingsGroup("subscription", {
      renewalReminderDays: [21, 10, 2],
      postExpiryNoticeDays: [1, 14],
      expirySmsEnabled: true,
    })
    const s = await getSaasSettings()
    expect(s.subscription.renewalReminderDays).toEqual([21, 10, 2])
    expect(s.subscription.postExpiryNoticeDays).toEqual([1, 14])
    expect(s.subscription.expirySmsEnabled).toBe(true)
    // restore defaults for other tests in this run
    await saveSaasSettingsGroup("subscription", {
      renewalReminderDays: [30, 15, 7, 3, 1],
      postExpiryNoticeDays: [1, 7],
      expirySmsEnabled: false,
    })
  })
})
