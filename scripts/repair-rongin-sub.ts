import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()
async function main() {
  const v = await db.vendor.findFirst({ where: { name: "Rongin Traders" } })
  if (!v) throw new Error("vendor missing")
  const starter = await db.saasPlan.findFirst({ where: { name: "Starter" } })
  if (!starter) throw new Error("Starter plan missing")
  const sub = await db.saasSubscription.findUnique({ where: { vendorId: v.id } })
  if (!sub) throw new Error("Rongin subscription missing")
  console.log("before:", sub.planName, sub.billingCycle, sub.priceAtCreation, sub.currencySnapshot)
  // seeded shape: Starter / MONTHLY / priceAtCreation 2500 / BDT / ACTIVE,
  // expiring ~5 days out (drives the renewal console)
  await db.saasSubscription.update({
    where: { vendorId: v.id },
    data: {
      planId: starter.id, planName: "Starter", billingCycle: "MONTHLY",
      priceAtCreation: 2500, currencySnapshot: "BDT", status: "ACTIVE",
      endDate: new Date(Date.now() + 5 * 86400_000),
    },
  })
  const after = await db.saasSubscription.findUnique({ where: { vendorId: v.id } })
  console.log("after: ", after?.planName, after?.billingCycle, after?.priceAtCreation, after?.currencySnapshot)
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
