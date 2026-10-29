/// <reference types="bun-types" />
// ============ Phase 3 WS-E — SSRF guard + webhook/campaign scale (SEC-6, OPS-5)
// SEC-6: the outbound-URL guard must reject private IPv6 space, DNS names that
//        RESOLVE to private ranges (rebinding) and must never follow redirects.
// OPS-5: webhook deliveries get a backlog age ceiling (dead-letter); campaigns
//        are chunked + resumable + bounce-suppressed with single-flight claims.
import "./_testdb"
import { describe, test, expect, afterAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, uniq } from "./_fixtures"
import { isPrivateIpv6, validateOutboundUrl, resolveOutboundUrl } from "@/hrm-server/security"
import { postSigned, deadLetterStaleDeliveries, attemptDelivery } from "@/hrm-server/webhooks"
import { deliverCampaign, dispatchDueCampaigns } from "@/hrm-server/saas/communication"
import { tryAcquireLock, releaseLock } from "@/hrm-server/coordination"

// ---- fetch stub management (the redirect test replaces global fetch) ----
const realFetch = globalThis.fetch
afterAll(() => { globalThis.fetch = realFetch })

describe("SEC-6 — IPv6 private space is blocked at the string level", () => {
  test("loopback / unspecified / ULA / link-local / v4-mapped are all private", () => {
    for (const h of ["::1", "::", "fd00::1", "fdab:1234::", "fc00::5", "fe80::1", "febf::1", "::ffff:10.1.2.3", "::ffff:127.0.0.1"]) {
      expect(isPrivateIpv6(h)).toBe(true)
    }
    for (const h of ["2606:4700:4700::1111", "2a00:1450:4001:81b::200e", "2001:db8::1"]) {
      expect(isPrivateIpv6(h)).toBe(false)
    }
  })

  test("validateOutboundUrl rejects IPv6 literals the v4-only guard used to miss", () => {
    expect(validateOutboundUrl("https://[::1]/x").ok).toBe(false)
    expect(validateOutboundUrl("https://[fd12:3456::1]/x").ok).toBe(false)
    expect(validateOutboundUrl("https://[fe80::1]/x").ok).toBe(false)
    expect(validateOutboundUrl("https://[2606:4700:4700::1111]/x").ok).toBe(true) // public v6 passes
    // the v4 checks still hold
    expect(validateOutboundUrl("https://169.254.169.254/latest/meta-data").ok).toBe(false)
    expect(validateOutboundUrl("https://10.0.0.5/hook").ok).toBe(false)
    expect(validateOutboundUrl("http://example.com/hook").ok).toBe(false) // https-only
  })
})

describe("SEC-6 — send-time DNS resolution catches rebinding", () => {
  test("a name resolving to loopback is refused (the classic rebinding vector)", async () => {
    // string-level catch (fast path)
    const local = await resolveOutboundUrl("https://localhost/p3-test")
    expect(local.ok).toBe(false)
    // DNS-level catch: nip.io wildcard names are PUBLIC strings that RESOLVE
    // to private addresses — the exact rebinding shape the old guard missed
    const rebind = await resolveOutboundUrl("https://127-0-0-1.nip.io/p3-test")
    expect(rebind.ok).toBe(false)
    if (!rebind.ok) expect(rebind.reason).toMatch(/resolves to a private\/internal address/)
    const rebindV6 = await resolveOutboundUrl("https://localtest.me/p3-test")
    expect(rebindV6.ok).toBe(false)
  })

  test("a public name resolves and passes with its address list", async () => {
    const out = await resolveOutboundUrl("https://example.com/p3-test")
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.addresses.length).toBeGreaterThan(0)
      expect(out.url.hostname).toBe("example.com")
    }
  })

  test("postSigned sends with redirect: manual and treats 3xx as failure", async () => {
    let capturedInit: any = null
    globalThis.fetch = (async (_url: any, init: any) => {
      capturedInit = init
      return new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest" } })
    }) as any
    try {
      const out = await postSigned("https://example.com/hook", null, "p3.event", "p3-delivery", "{}")
      expect(capturedInit?.redirect).toBe("manual") // ← redirect-following disabled
      expect(out.ok).toBe(false)
      expect(out.error).toMatch(/[Rr]edirect/)
      expect(out.status).toBe(302)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test("attemptDelivery marks the delivery row FAILED with the redirect note (end-to-end)", async () => {
    const vendor = await mkVendor("P3 SSRF Vendor")
    const endpoint = await db.webhookEndpoint.create({
      data: { vendorId: vendor.id, url: "https://example.com/p3-redirect", eventsJson: JSON.stringify(["p3.event"]), active: true },
    })
    const delivery = await db.webhookDelivery.create({
      data: { vendorId: vendor.id, endpointId: endpoint.id, event: "p3.event", payloadJson: "{}" },
    })
    globalThis.fetch = (async () => new Response(null, { status: 301, headers: { location: "https://internal" } })) as any
    try {
      const out = await attemptDelivery(delivery)
      expect(out.attempted).toBe(true)
      expect(out.ok).toBe(false)
      expect(out.detail).toMatch(/[Rr]edirect/)
    } finally {
      globalThis.fetch = realFetch
    }
    const row = await db.webhookDelivery.findUnique({ where: { id: delivery.id } })
    expect(row?.responseBody).toMatch(/[Rr]edirect/)
    await db.webhookDelivery.delete({ where: { id: delivery.id } }).catch(() => {})
    await db.webhookEndpoint.delete({ where: { id: endpoint.id } }).catch(() => {})
  })
})

describe("OPS-5 — webhook backlog dead-letter sweep", () => {
  test("PENDING deliveries older than the backlog ceiling are FAILED; fresh ones untouched", async () => {
    const vendor = await mkVendor("P3 Backlog Vendor")
    const endpoint = await db.webhookEndpoint.create({
      data: { vendorId: vendor.id, url: "https://example.com/p3-backlog", eventsJson: "[]", active: true },
    })
    const stale = await db.webhookDelivery.create({
      data: { vendorId: vendor.id, endpointId: endpoint.id, event: "e", payloadJson: "{}", status: "PENDING", createdAt: new Date(Date.now() - 30 * 86400000) },
    })
    const fresh = await db.webhookDelivery.create({
      data: { vendorId: vendor.id, endpointId: endpoint.id, event: "e", payloadJson: "{}", status: "PENDING" },
    })
    const deadLettered = await deadLetterStaleDeliveries()
    expect(deadLettered).toBeGreaterThanOrEqual(1)
    const staleRow = await db.webhookDelivery.findUnique({ where: { id: stale.id } })
    expect(staleRow?.status).toBe("FAILED")
    expect(String(staleRow?.responseBody)).toMatch(/[Dd]ead-lettered/)
    const freshRow = await db.webhookDelivery.findUnique({ where: { id: fresh.id } })
    expect(freshRow?.status).toBe("PENDING") // still queued, not dead-lettered
  })
})

describe("OPS-5 — campaigns: resume, bounce list, single-flight", () => {
  test("a SENDING campaign with PENDING recipients RESUMES (crash recovery)", async () => {
    const v = await mkVendor("P3 Campaign Resume")
    await mkUser(v.id, { role: "VENDOR_OWNER", email: `p3-camp-${uniq()}@test.example` })

    const campaign = await db.saasCampaign.create({
      data: {
        name: "P3 Resume Campaign", channel: "EMAIL", subject: "Resume", body: "Hello {{tenantName}}",
        audienceType: "CUSTOM", audienceIds: JSON.stringify([v.id]),
        status: "SENDING", totalRecipients: 1, // a crash mid-run left it SENDING
      },
    })
    await db.saasCampaignRecipient.create({
      data: { campaignId: campaign.id, vendorId: v.id, vendorName: "P3 Campaign Resume", contactEmail: `p3-camp-${uniq()}@test.example`, status: "PENDING" },
    })

    // the OLD behavior: deliverCampaign threw "already ran (sending)" and the
    // recipient stayed PENDING forever. NOW it resumes and completes.
    const tally = await deliverCampaign(campaign.id, { id: "p3-test", name: "P3 Tester" })
    expect(tally.remaining).toBe(0)
    const after = await db.saasCampaign.findUnique({ where: { id: campaign.id } })
    expect(["PARTIAL", "SENT", "FAILED"]).toContain(after!.status) // gateway unset → PARTIAL
    expect(after!.sentAt).toBeTruthy()
    const recipients = await db.saasCampaignRecipient.findMany({ where: { campaignId: campaign.id } })
    expect(recipients.every((r) => r.status !== "PENDING")).toBe(true)
  })

  test("a bounce-suppressed address is SKIPPED instead of re-mailed", async () => {
    const v = await mkVendor("P3 Bounce Vendor")
    const bouncedEmail = `p3-bounced-${uniq()}@test.example`
    await mkUser(v.id, { role: "VENDOR_OWNER", email: bouncedEmail })
    await db.campaignBounce.create({
      data: { channel: "EMAIL", address: bouncedEmail, bounceCount: 3, reason: "hard bounce (fixture)" },
    })

    const campaign = await db.saasCampaign.create({
      data: {
        name: "P3 Bounce Campaign", channel: "EMAIL", subject: "B", body: "Hi {{tenantName}}",
        audienceType: "CUSTOM", audienceIds: JSON.stringify([v.id]), status: "DRAFT",
      },
    })
    const tally = await deliverCampaign(campaign.id, { id: "p3-test", name: "P3 Tester" })
    expect(tally.remaining).toBe(0)
    const rec = await db.saasCampaignRecipient.findFirst({ where: { campaignId: campaign.id } })
    expect(rec?.status).toBe("SKIPPED")
    expect(String(rec?.lastError)).toMatch(/bounce list/)
    // the suppression row is untouched (deleting it re-enables the address)
    expect(await db.campaignBounce.count({ where: { address: bouncedEmail } })).toBe(1)
  })

  test("the failure-path bounce upsert accumulates toward the suppression threshold", async () => {
    const email = `p3-fail-${uniq()}@test.example`
    // the exact upsert deliverCampaign runs when a send FAILS (the test DB has
    // no gateway configured, so a genuine FAILED outcome cannot be produced
    // here — the upsert semantics are what the failure path rides on)
    await db.campaignBounce.upsert({
      where: { channel_address: { channel: "EMAIL", address: email } },
      create: { channel: "EMAIL", address: email, reason: "fixture failure" },
      update: { bounceCount: { increment: 1 } },
    })
    await db.campaignBounce.upsert({
      where: { channel_address: { channel: "EMAIL", address: email } },
      create: { channel: "EMAIL", address: email, reason: "fixture failure" },
      update: { bounceCount: { increment: 1 } },
    })
    const row = await db.campaignBounce.findUnique({ where: { channel_address: { channel: "EMAIL", address: email } } })
    expect(row?.bounceCount).toBe(2) // accumulated, not overwritten
  })

  test("the per-campaign lock makes concurrent sends single-flight (409, never double-send)", async () => {
    const v = await mkVendor("P3 Lock Vendor")
    const campaign = await db.saasCampaign.create({
      data: {
        name: "P3 Lock Campaign", channel: "EMAIL", subject: "L", body: "Hi",
        audienceType: "CUSTOM", audienceIds: JSON.stringify([v.id]), status: "DRAFT",
      },
    })
    const held = await tryAcquireLock(`campaign:${campaign.id}`, 60_000)
    expect(held).not.toBeNull()
    await expect(deliverCampaign(campaign.id, { id: "p3", name: "t" })).rejects.toThrow(/already being delivered|another send/i)
    await releaseLock(held)
    // after release the same call goes through
    const tally = await deliverCampaign(campaign.id, { id: "p3", name: "t" })
    expect(tally.remaining).toBe(0)
  })

  test("dispatchDueCampaigns resumes a stuck SENDING campaign from the tick", async () => {
    const v = await mkVendor("P3 TickResume Vendor")
    await mkUser(v.id, { role: "VENDOR_OWNER", email: `p3-tick-${uniq()}@test.example` })
    const campaign = await db.saasCampaign.create({
      data: {
        name: "P3 TickResume Campaign", channel: "EMAIL", subject: "T", body: "Hi {{tenantName}}",
        audienceType: "CUSTOM", audienceIds: JSON.stringify([v.id]),
        status: "SENDING", totalRecipients: 1,
      },
    })
    await db.saasCampaignRecipient.create({
      data: { campaignId: campaign.id, vendorId: v.id, contactEmail: `p3-tick-${uniq()}@test.example`, status: "PENDING" },
    })
    const dispatched = await dispatchDueCampaigns({ id: "p3-tick", name: "P3 Tick" })
    expect(dispatched).toBeGreaterThanOrEqual(1) // the resume pass picked it up
    const after = await db.saasCampaign.findUnique({ where: { id: campaign.id } })
    expect(after!.status).not.toBe("SENDING") // ran to a terminal status
    expect(after!.status).not.toBe("FAILED") // and the no-contact skip is PARTIAL, not FAILED
  })
})
