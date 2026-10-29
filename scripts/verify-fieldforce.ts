// Verify FIELD_FORCE entitlement resolves true for an Enterprise-subscribed tenant
import { PrismaClient } from "@prisma/client"

const db = new PrismaClient()

async function main() {
  const vendor = await db.vendor.findFirst({ where: { name: "Rongin Traders" } })
  if (!vendor) throw new Error("test vendor missing")
  const plan = await db.saasPlan.findFirst({ where: { name: "Enterprise" } })
  if (!plan) throw new Error("Enterprise plan missing")

  // Simulate an ACTIVE Enterprise subscription for the vendor
  const end = new Date(Date.now() + 30 * 86400_000)
  await db.saasSubscription.upsert({
    where: { vendorId: vendor.id },
    create: {
      vendorId: vendor.id, planId: plan.id, planName: plan.name,
      status: "ACTIVE", billingCycle: "MONTHLY",
      startDate: new Date(), endDate: end,
      priceAtCreation: 0, currencySnapshot: "BDT",
    },
    update: { planId: plan.id, planName: plan.name, status: "ACTIVE", endDate: end },
  })

  const { resolveEntitlements, featureBlocked } = await import("../src/hrm-server/saas/entitlements")
  const ent = await resolveEntitlements(vendor.id)
  console.log("mode:", ent.mode, "| plan:", ent.planName)
  console.log("FIELD_FORCE feature:", ent.features.FIELD_FORCE)
  console.log("fieldforce module blocked:", featureBlocked(ent, "fieldforce"))
  console.log("camera blocked (sanity, expect false):", featureBlocked(ent, "camera"))

  // restore: remove the test subscription so the demo corpus is unchanged
  // (priceAtCreation/currencySnapshot restored too — smoke suites assert on them)
  const original = await db.saasSubscription.findUnique({ where: { vendorId: vendor.id } })
  if (original && original.planName !== "Enterprise") {
    await db.saasSubscription.update({
      where: { vendorId: vendor.id },
      data: {
        planId: original.planId, planName: original.planName, status: original.status,
        endDate: original.endDate, billingCycle: original.billingCycle,
        priceAtCreation: original.priceAtCreation, currencySnapshot: original.currencySnapshot,
      },
    })
  } else {
    await db.saasSubscription.delete({ where: { vendorId: vendor.id } }).catch(() => {})
  }
  const { invalidateEntitlements } = await import("../src/hrm-server/saas/entitlements")
  invalidateEntitlements(vendor.id)
  console.log("cleanup done")
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1) }).finally(() => db.$disconnect())
