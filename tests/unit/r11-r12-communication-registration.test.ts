/// <reference types="bun-types" />
// ============ R11 + R12 regression: owner Communication + registration Accept ============
// R11: campaign engine — audience resolution, opt-out consent, duplicate-send
//      prevention, scheduled dispatch claiming, all-skipped honesty (a run
//      with an unconfigured gateway is PARTIAL, never a fake "SENT").
// R12: owner.registrations.accept — provisions the tenant AND issues the
//      FIRST invoice (SaasInvoice.registrationId provenance) AND records the
//      invoice-email attempt; already-approved guard prevents double
//      provisioning.
// Owner-plane handlers are invoked through the registered ownerRoutes table
// with a synthesized OwnerCtx (the dispatcher's session/CSRF/perm gates are
// generic and covered elsewhere); assertions verify the DB + audit outcomes.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, uniq } from "./_fixtures"
import { ownerRoutes } from "@/hrm-server/saas/owner-routes"
// side-effect registration of owner.communication.* into the ownerRoutes table
// (in production the /api/owner dispatcher imports it; tests must too)
import "@/hrm-server/saas/communication-routes"
import { hashOwnerPassword } from "@/hrm-server/saas/owner-auth"
import type { OwnerCtx } from "@/hrm-server/saas/owner-auth"

let ctx: OwnerCtx
let vendorA: { id: string }
let vendorB: { id: string }

const call = async (action: string, payload: any) => {
  const def = ownerRoutes[action]
  if (!def) throw new Error(`unknown owner action: ${action}`)
  const parsed = def.schema ? def.schema.parse(payload) : payload
  return (def.handler as any)(ctx, parsed)
}

beforeAll(async () => {
  ctx = {
    ownerId: "test-owner-" + uniq("o"),
    name: "R11 Owner",
    email: "owner@test.example",
    roleKey: "SUPER_ADMIN",
    permissions: new Set(["communication.view", "communication.manage", "registrations.approve", "billing.manage", "settings.view"]),
  }
  vendorA = await mkVendor("R11 Tenant A")
  vendorB = await mkVendor("R11 Tenant B")
  // administrators (campaign recipients) for both vendors
  await mkUser(vendorA.id, { role: "VENDOR_OWNER", email: `r11-admin-a-${uniq()}@test.example`, name: "A Admin" })
  await mkUser(vendorB.id, { role: "VENDOR_OWNER", email: `r11-admin-b-${uniq()}@test.example`, name: "B Admin" })
  // vendor B opted out of marketing
  await db.vendor.update({ where: { id: vendorB.id }, data: { marketingOptOut: true } })
})

async function mkRegistration(orgName: string): Promise<string> {
  const r = await db.saasRegistration.create({
    data: {
      applicationNumber: "HRM-TEST-" + uniq("r"),
      organizationName: orgName,
      officialEmail: `official-${uniq()}@test.example`,
      adminName: "Reg Admin",
      adminEmail: `admin-${uniq()}@test.example`,
      adminPasswordHash: await hashOwnerPassword("RegPass@12345"),
      status: "PENDING",
    },
  })
  return r.id
}

describe("R11 — communication campaigns", () => {
  test("campaign save + preview: opt-out visibility and placeholder render", async () => {
    const saved = await call("owner.communication.campaigns.save", {
      name: "R11 Launch promo", kind: "PROMOTIONAL", channel: "EMAIL",
      subject: "Hi {{tenantName}}", body: "Dear {{tenantName}} — a {{planName}} offer from {{platformName}}.",
      audienceType: "ALL",
    })
    expect(saved.id).toBeTruthy()

    // CUSTOM audience keeps the assertion isolated from other test files'
    // vendors that persist in the shared test DB
    const preview: any = await call("owner.communication.campaigns.preview", {
      audienceType: "CUSTOM", audienceIds: [vendorA.id, vendorB.id],
      templateBody: "Dear {{tenantName}} — a {{planName}} offer from {{platformName}}.",
    })
    expect(preview.total).toBe(2)
    expect(preview.optedOut).toBe(1)                          // B opted out
    expect(preview.reachable).toBe(1)
    // placeholders render with real values; unknown tokens stay verbatim
    expect(preview.sample.message).toMatch(/Dear .*? — a .*? offer from /)
    expect(preview.sample.to).toMatch(/@test\.example$/)
  })

  test("send with no gateway: recipients journaled SKIPPED, honest PARTIAL status", async () => {
    // (the test DB has no platform email gateway configured → every send SKIPS)
    // CUSTOM audience — same isolation rule as the preview test above: the
    // shared unit-test database accumulates every prior file's vendors, and an
    // ALL audience grows past the engine's RECIPIENTS_PER_PASS budget (200),
    // which would (correctly) leave the campaign SENDING for the tick resume
    // pass — making this test's outcome depend on file execution order.
    const saved: any = await call("owner.communication.campaigns.save", {
      name: "R11 NoGateway campaign", channel: "EMAIL", subject: "Hello", body: "World",
      audienceType: "CUSTOM", audienceIds: [vendorA.id, vendorB.id],
    })
    const tally: any = await call("owner.communication.campaigns.send", { id: saved.id, mode: "NOW" })
    expect(tally.total).toBeGreaterThanOrEqual(2)
    expect(tally.sent).toBe(0)
    expect(tally.skipped).toBeGreaterThanOrEqual(1)

    const c = await db.saasCampaign.findUnique({ where: { id: saved.id } })
    expect(c?.status).toBe("PARTIAL") // NOT "SENT" — nothing actually went out
    expect(c?.sentCount).toBe(0)

    const recipients = await db.saasCampaignRecipient.findMany({ where: { campaignId: saved.id } })
    expect(recipients.length).toBeGreaterThanOrEqual(2)
    const optedOut = recipients.find((r) => r.vendorId === vendorB.id)
    expect(optedOut?.status).toBe("SKIPPED")
    expect(String(optedOut?.lastError)).toMatch(/opted out/i)
  })

  test("re-sending a finished campaign is blocked (duplicate prevention)", async () => {
    const saved: any = await call("owner.communication.campaigns.save", {
      name: "R11 Dup guard", channel: "EMAIL", subject: "x", body: "y", audienceType: "CUSTOM", audienceIds: [vendorA.id],
    })
    await call("owner.communication.campaigns.send", { id: saved.id, mode: "NOW" })
    await expect(call("owner.communication.campaigns.send", { id: saved.id, mode: "NOW" }))
      .rejects.toThrow(/already ran/i)
  })

  test("scheduled campaigns are claimed + delivered by dispatchDueCampaigns exactly once", async () => {
    const saved: any = await call("owner.communication.campaigns.save", {
      name: "R11 Scheduled promo", channel: "SMS", body: "Promo SMS for {{tenantName}}", audienceType: "CUSTOM", audienceIds: [vendorA.id],
    })
    // schedule for the past → due immediately
    await db.saasCampaign.update({
      where: { id: saved.id },
      data: { status: "SCHEDULED", scheduledFor: new Date(Date.now() - 60_000) },
    })
    const { dispatchDueCampaigns } = await import("@/hrm-server/saas/communication")
    const first = await dispatchDueCampaigns()
    expect(first).toBeGreaterThanOrEqual(1)
    // second run: nothing left to claim (no double-send)
    const second = await dispatchDueCampaigns()
    expect(second).toBe(0)

    const c = await db.saasCampaign.findUnique({ where: { id: saved.id } })
    expect(["PARTIAL", "SENT", "FAILED"]).toContain(String(c?.status)) // ran to completion
    expect(c?.sentAt).toBeTruthy()

    const auditRows = await db.saasAuditLog.findMany({ where: { action: "CAMPAIGN_SENT", entityId: saved.id } })
    expect(auditRows.length).toBe(1) // exactly one completion audit row
  })

  test("templates: create, SMS length guard, delete", async () => {
    const tpl: any = await call("owner.communication.templates.save", {
      name: "R11 template", kind: "NEWSLETTER", channel: "EMAIL", subject: "Newsletter {{tenantName}}", body: "Content here",
    })
    expect(tpl.id).toBeTruthy()
    // SMS over 480 chars is rejected
    await expect(call("owner.communication.templates.save", {
      name: "R11 long SMS", channel: "SMS", body: "x".repeat(481),
    })).rejects.toThrow(/480/)
    // email template without subject is rejected
    await expect(call("owner.communication.templates.save", {
      name: "R11 no subject", channel: "EMAIL", body: "x",
    })).rejects.toThrow(/subject/i)
    const del: any = await call("owner.communication.templates.delete", { id: tpl.id })
    expect(del.ok).toBe(true)
  })
})

describe("R12 — registration Accept & invoice", () => {
  test("accept provisions tenant + first invoice (registrationId provenance) + audit trail", async () => {
    const plan = await db.saasPlan.create({
      data: { name: "R12 Plan", monthlyPrice: 3500, yearlyPrice: 35000, currency: "BDT", isPublic: true, active: true, sortOrder: 1 },
    })
    const regId = await mkRegistration("R12 Accepted Traders")

    const out: any = await call("owner.registrations.accept", {
      id: regId, planId: plan.id, billingCycle: "MONTHLY", invoiceDueDays: 7,
    })
    expect(out.status).toBe("APPROVED")
    expect(out.vendorId).toBeTruthy()
    expect(out.invoice.number).toMatch(/^INV-/)       // platform sequence
    expect(out.invoice.amount).toBe(3500)
    expect(out.invoice.status).toBe("PENDING")
    // gateway unconfigured in the test DB → email attempt journaled as SKIPPED
    expect(["SENT", "SKIPPED", "FAILED"]).toContain(out.invoiceEmailStatus)

    const inv = await db.saasInvoice.findUnique({ where: { id: out.invoice.id } })
    expect(inv?.registrationId).toBe(regId)            // R12 provenance link
    expect(inv?.subscriptionId).toBeTruthy()           // linked to the live subscription
    expect(inv?.periodEnd.getTime()).toBeGreaterThan(inv!.periodStart.getTime())

    const reg = await db.saasRegistration.findUnique({ where: { id: regId } })
    expect(reg?.status).toBe("APPROVED")
    expect(reg?.approvedVendorId).toBe(out.vendorId)

    const auditActions = await db.saasAuditLog.findMany({
      where: { vendorId: out.vendorId, action: { in: ["REGISTRATION_ACCEPTED", "TENANT_CREATED", "INVOICE_CREATED"] } },
    })
    expect(auditActions.map((a) => a.action)).toContain("REGISTRATION_ACCEPTED")
    expect(auditActions.map((a) => a.action)).toContain("INVOICE_CREATED")
  })

  test("accepting an already-approved application is blocked", async () => {
    const plan = await db.saasPlan.findFirst({ where: { name: "R12 Plan" } })
    const regId = await mkRegistration("R12 Dup Guard Ltd")
    const first: any = await call("owner.registrations.accept", { id: regId, planId: plan!.id, invoiceDueDays: 0 })
    expect(first.status).toBe("APPROVED")
    await expect(call("owner.registrations.accept", { id: regId, planId: plan!.id, invoiceDueDays: 0 }))
      .rejects.toThrow(/already approved/i)
    // exactly ONE invoice exists for this registration (no double-billing)
    const invoices = await db.saasInvoice.findMany({ where: { registrationId: regId } })
    expect(invoices.length).toBe(1)
  })

  test("accept with trial days issues the full-term invoice and TRIAL subscription", async () => {
    const plan = await db.saasPlan.findFirst({ where: { name: "R12 Plan" } })
    const regId = await mkRegistration("R12 Trial Ventures")
    const out: any = await call("owner.registrations.accept", {
      id: regId, planId: plan!.id, trialDays: 14, invoiceDueDays: 7,
    })
    const sub = await db.saasSubscription.findUnique({ where: { id: out.subscriptionId } })
    expect(sub?.status).toBe("TRIAL")
    // invoice still covers the plan price (the trial rides inside the term)
    expect(Number(out.invoice.amount)).toBe(3500)
  })
})
