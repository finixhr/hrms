/// <reference types="bun-types" />
// ============ Phase 3 WS-E — SSRF guard + webhook/campaign scale (SEC-6, OPS-5)
// SEC-6: the outbound-URL guard must reject private IPv6 space, DNS names that
//        RESOLVE to private ranges (rebinding) and must never follow redirects.
// AUDIT M-10 (2026-11-07): the send path additionally PINS the connection to
//        the validated address list (resolveOutboundUrl + pinnedFetch in
//        security.ts) — the DNS-rebinding race between check and connect is
//        closed, and the old fetch-stub seam is gone with it: redirect/pin
//        coverage now drives the REAL transport against a local server.
// OPS-5: webhook deliveries get a backlog age ceiling (dead-letter); campaigns
//        are chunked + resumable + bounce-suppressed with single-flight claims.
import "./_testdb"
import { describe, test, expect } from "bun:test"
import * as http from "node:http"
import { db } from "@/lib/db"
import { mkVendor, mkUser, uniq } from "./_fixtures"
import { isPrivateIpv6, validateOutboundUrl, resolveOutboundUrl, pinnedFetch, redirectRefusal } from "@/hrm-server/security"
import { postSigned, deadLetterStaleDeliveries, attemptDelivery } from "@/hrm-server/webhooks"
import { deliverCampaign, dispatchDueCampaigns } from "@/hrm-server/saas/communication"
import { tryAcquireLock, releaseLock } from "@/hrm-server/coordination"

describe("SEC-6 — IPv6 private space is blocked at the string level", () => {
  test("loopback / unspecified / ULA / link-local / v4-mapped / documentation are all private (M-10)", () => {
    for (const h of [
      "::1", "::", "fd00::1", "fdab:1234::", "fc00::5", "fe80::1", "febf::1",
      "::ffff:10.1.2.3", "::ffff:127.0.0.1",
      // AUDIT M-10 — the WHOLE ::ffff:0:0/96 mapped block is rejected (dotted
      // AND hex spellings), not just the mapped-to-private subset; plus the
      // 2001:db8::/32 documentation range.
      "::ffff:8.8.8.8", "::ffff:a00:1", "2001:db8::1", "2001:db8:dead::beef",
    ]) {
      expect(isPrivateIpv6(h)).toBe(true)
    }
    for (const h of ["2606:4700:4700::1111", "2a00:1450:4001:81b::200e"]) {
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
    // AUDIT M-10 — documentation v6 + CGNAT v4 literals the old guard missed
    expect(validateOutboundUrl("https://[2001:db8::1]/x").ok).toBe(false)
    expect(validateOutboundUrl("https://100.64.0.7/x").ok).toBe(false) // 100.64/10 CGNAT
    expect(validateOutboundUrl("https://100.63.1.2/x").ok).toBe(true) // just below the /10
    expect(validateOutboundUrl("https://100.128.1.2/x").ok).toBe(true) // just above the /10
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

  test("AUDIT M-10 — pinnedFetch connects through the VALIDATED IP (never DNS) and surfaces, never follows, a 3xx", async () => {
    const seen: string[] = []
    const server = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url} host=${req.headers.host}`)
      res.writeHead(302, { location: "https://169.254.169.254/latest" })
      res.end()
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const port = (server.address() as any).port
    try {
      // Synthetic OK-check whose hostname CANNOT resolve (the .invalid TLD is
      // reserved): if the request lands on the local server, DNS was never
      // consulted — the exact M-10 rebinding trace. An attacker flipping the
      // name to 127.0.0.1 AFTER the check changes nothing: the connection
      // resolves through the validated address list only.
      const check = { url: new URL(`http://rebind-test.invalid:${port}/hook`), addresses: ["127.0.0.1"] }
      const res = await pinnedFetch(check, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
      expect(res.status).toBe(302) // the 3xx IS the terminal response — never followed
      expect(res.headers.get("location")).toBe("https://169.254.169.254/latest")
      expect(seen).toEqual([`POST /hook host=rebind-test.invalid:${port}`]) // Host header preserved
      // the shared refusal message both outbound paths emit on a 3xx
      expect(redirectRefusal(res, "webhook endpoints")).toMatch(/[Rr]edirect/)
    } finally {
      server.close()
    }
  })

  test("postSigned refuses a private endpoint before any connection is made (offline)", async () => {
    const out = await postSigned("https://localhost/hook", null, "p3.event", "p3-delivery", "{}")
    expect(out.ok).toBe(false)
    expect(out.status).toBeNull()
    expect(out.error).toMatch(/Blocked by SSRF guard/)
  })

  test("attemptDelivery fails the delivery row with the SSRF-guard note when the host rebinds private (end-to-end)", async () => {
    const vendor = await mkVendor("P3 SSRF Vendor")
    // nip.io name that RESOLVES to 127.0.0.1: passes the string-level guard,
    // caught by the send-time resolve-ALL check — the classic rebinding vector
    const endpoint = await db.webhookEndpoint.create({
      data: { vendorId: vendor.id, url: "https://127-0-0-1.nip.io/p3-e2e", eventsJson: JSON.stringify(["p3.event"]), active: true },
    })
    const delivery = await db.webhookDelivery.create({
      data: { vendorId: vendor.id, endpointId: endpoint.id, event: "p3.event", payloadJson: "{}" },
    })
    try {
      const out = await attemptDelivery(delivery)
      expect(out.attempted).toBe(true)
      expect(out.ok).toBe(false)
      expect(out.detail).toMatch(/Blocked by SSRF guard/)
      const row = await db.webhookDelivery.findUnique({ where: { id: delivery.id } })
      expect(row?.responseBody).toMatch(/Blocked by SSRF guard/)
      expect(row?.attempts).toBe(1)
    } finally {
      await db.webhookDelivery.delete({ where: { id: delivery.id } }).catch(() => {})
      await db.webhookEndpoint.delete({ where: { id: endpoint.id } }).catch(() => {})
    }
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
