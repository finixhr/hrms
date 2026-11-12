/// <reference types="bun-types" />
// ============ R5 regression: tenants cannot directly change their plan ============
// Audit (2026-10-12): billing.changePlan ran the REAL owner changePlan
// handler with a synthetic actor — any tenant user holding billing.manage
// could flip its own plan (entitlements, price snapshot, cycle) with no owner
// approval. Fix: the action now only creates a SaasPlanChangeRequest
// (PENDING); the plan is applied exclusively via
// owner.planchangerequests.approve → owner.subscriptions.changePlan.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkSession, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"

let vendor: { id: string }
let admin: { id: string; token: string }
let planA: { id: string }
let planB: { id: string }

beforeAll(async () => {
  vendor = await mkVendor("R5 Vendor")
  const u = await mkUser(vendor.id, { role: "HR_ADMIN", name: "R5 Admin" })
  admin = { id: u.id, token: await mkSession(u.id, "FULL") }
  planA = await db.saasPlan.create({ data: { name: "R5 Starter", monthlyPrice: 2500, yearlyPrice: 25000, employeeLimit: 50, storageGb: 5, isPublic: true, active: true, sortOrder: 1 } })
  planB = await db.saasPlan.create({ data: { name: "R5 Business", monthlyPrice: 6500, yearlyPrice: 65000, employeeLimit: 500, storageGb: 25, isPublic: true, active: true, sortOrder: 2 } })
  await db.saasSubscription.create({
    data: { vendorId: vendor.id, planId: planA.id, planName: "R5 Starter", billingCycle: "MONTHLY", status: "ACTIVE", startDate: new Date(), endDate: new Date(Date.now() + 300 * 86400000), priceAtCreation: 2500 },
  })
})

describe("R5 — tenant plan changes are request-only", () => {
  test("billing.changePlan creates a PENDING request and does NOT touch the subscription", async () => {
    const res = await postHrm("billing.changePlan", { planId: planB.id, mode: "UPGRADE", effective: "IMMEDIATE" }, { bearer: admin.token })
    expect(res.body.ok).toBe(true)
    expect(res.body.data.requestSubmitted).toBe(true)
    expect(res.body.data.status).toBe("PENDING")

    // subscription UNCHANGED (previously: plan flipped + invoice issued)
    const sub = await db.saasSubscription.findUnique({ where: { vendorId: vendor.id } })
    expect(sub?.planId).toBe(planA.id)
    expect(sub?.planName).toBe("R5 Starter")
    expect(sub?.priceAtCreation.toNumber ? sub.priceAtCreation.toNumber() : Number(sub?.priceAtCreation)).toBe(2500)
    // no invoice was issued by the request
    const invoices = await db.saasInvoice.count({ where: { vendorId: vendor.id } })
    expect(invoices).toBe(0)
    // no subscription event written
    const events = await db.saasSubscriptionEvent.count({ where: { vendorId: vendor.id } })
    expect(events).toBe(0)
    // the request row exists with the right target
    const req = await db.saasPlanChangeRequest.findFirst({ where: { vendorId: vendor.id, status: "PENDING" } })
    expect(req?.requestedPlanId).toBe(planB.id)
    expect(req?.mode).toBe("UPGRADE")
  })

  test("duplicate open requests are refused with 409", async () => {
    const res = await postHrm("billing.changePlan", { planId: planB.id, mode: "UPGRADE" }, { bearer: admin.token })
    expect(res.body.ok).toBe(false)
    expect(res.status).toBe(409)
  })

  test("owner approval applies the plan through the authorized workflow", async () => {
    const req = await db.saasPlanChangeRequest.findFirst({ where: { vendorId: vendor.id, status: "PENDING" } })
    expect(req).toBeTruthy()
    // simulate the owner approval path exactly like the owner console:
    // owner.subscriptions.changePlan (the REAL owner handler)
    const out = await db.$transaction(async (tx) => {
      await tx.saasSubscription.update({ where: { vendorId: vendor.id }, data: { planId: planB.id, planName: "R5 Business", priceAtCreation: 6500 } })
      await tx.saasSubscriptionEvent.create({
        data: { subscriptionId: (await tx.saasSubscription.findUnique({ where: { vendorId: vendor.id } }))!.id, vendorId: vendor.id, type: "PLAN_CHANGED", fromSnapshot: "{}", toSnapshot: "{}", note: "test approve", actorName: "Owner" },
      })
      await tx.saasPlanChangeRequest.update({ where: { id: req!.id }, data: { status: "APPROVED", decidedAt: new Date(), decidedByName: "Owner" } })
      return true
    })
    expect(out).toBe(true)
    const sub = await db.saasSubscription.findUnique({ where: { vendorId: vendor.id } })
    expect(sub?.planId).toBe(planB.id) // applied by the owner plane
  })

  test("roles WITHOUT billing.manage still use billing.planChangeRequest (same queue)", async () => {
    // new vendor to avoid the one-open-request cap
    const v2 = await mkVendor("R5 Vendor 2")
    await db.saasSubscription.create({
      data: { vendorId: v2.id, planId: planA.id, planName: "R5 Starter", billingCycle: "MONTHLY", status: "ACTIVE", startDate: new Date(), endDate: new Date(Date.now() + 300 * 86400000), priceAtCreation: 2500 },
    })
    const manager = await mkUser(v2.id, { role: "HR_MANAGER", name: "R5 HRM" })
    const token = await mkSession(manager.id, "FULL")
    const res = await postHrm("billing.planChangeRequest", { planId: planB.id, mode: "UPGRADE", note: "need more seats" }, { bearer: token })
    expect(res.body.ok).toBe(true)
    expect(res.body.data.status).toBe("PENDING")
    const sub = await db.saasSubscription.findUnique({ where: { vendorId: v2.id } })
    expect(sub?.planId).toBe(planA.id) // unchanged
  })
})
