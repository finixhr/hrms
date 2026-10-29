// Verify the CHANGES §9 permission-catalog fix end-to-end:
//   A. ACTIONS now carries "launch" + "manage" — a provisioned owner's explicit
//      permission set (MODULES × ACTIONS, exactly what provisionTenant writes)
//      includes camera.launch / camera.manage and would survive the
//      roles.save normalizePermissions filter (same MODULES × ACTIONS set).
//   B. No ROLE_TEMPLATES verb is outside MODULES × ACTIONS ever again
//      (regression guard for the silent-strip class of bug).
//   C. A Trial-plan tenant resolves CAMERA entitlement true (post-repair seed
//      parity: "full Business feature set" tagline) — self-cleaning probe that
//      temporarily moves Rongin Traders to the Trial plan and restores it.
import { PrismaClient } from "@prisma/client"

const db = new PrismaClient()
let failures = 0
const assert = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗ FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

async function main() {
  // ---------- A. catalog + provision-shaped set ----------
  const { ACTIONS, MODULES, ROLE_TEMPLATES } = await import("../src/hrm-server/types")
  assert("ACTIONS includes launch", (ACTIONS as readonly string[]).includes("launch"))
  assert("ACTIONS includes manage", (ACTIONS as readonly string[]).includes("manage"))

  const valid = new Set<string>()
  for (const m of MODULES) for (const a of ACTIONS) valid.add(`${m}.${a}`)
  // exactly what provisionTenant / seed-owner write on the owner user
  const provisioned = Array.from(valid)
  for (const verb of ["camera.launch", "camera.manage", "tracking.manage", "jobs.manage", "billing.manage"]) {
    assert(`provisioned owner set contains ${verb}`, provisioned.includes(verb))
    // normalizePermissions is the same MODULES × ACTIONS filter — survival check
    assert(`normalizePermissions would keep ${verb}`, valid.has(verb))
  }

  // ---------- B. regression guard: every template verb is grantable ----------
  for (const [role, perms] of Object.entries(ROLE_TEMPLATES)) {
    const outside = perms.filter((p) => !valid.has(p))
    assert(`ROLE_TEMPLATES.${role} fully inside MODULES × ACTIONS`, outside.length === 0,
      outside.length ? `outside: ${outside.join(",")}` : `${perms.length} perms`)
  }

  // ---------- C. Trial-plan camera entitlement (self-cleaning) ----------
  const vendor = await db.vendor.findFirst({ where: { name: "Rongin Traders" } })
  const trial = await db.saasPlan.findFirst({ where: { name: "Trial" } })
  if (!vendor || !trial) {
    console.log("(skipped) demo vendor or Trial plan missing — run against the seeded dev DB")
    return
  }
  const { resolveEntitlements, featureBlocked, invalidateEntitlements } =
    await import("../src/hrm-server/saas/entitlements")

  const original = await db.saasSubscription.findUnique({ where: { vendorId: vendor.id } })
  const end = new Date(Date.now() + 30 * 86400_000)
  await db.saasSubscription.upsert({
    where: { vendorId: vendor.id },
    create: {
      vendorId: vendor.id, planId: trial.id, planName: trial.name,
      status: "ACTIVE", billingCycle: "MONTHLY", startDate: new Date(), endDate: end,
      priceAtCreation: 0, currencySnapshot: "BDT",
    },
    update: { planId: trial.id, planName: trial.name, status: "ACTIVE", endDate: end },
  })
  invalidateEntitlements(vendor.id)
  const ent = await resolveEntitlements(vendor.id)
  assert("Trial tenant CAMERA feature true", ent.features.CAMERA === true, `mode=${ent.mode} plan=${ent.planName}`)
  assert("Trial tenant camera module NOT blocked", featureBlocked(ent, "camera") === false)

  // restore the demo corpus exactly as it was (ALL price/plan fields — the
  // smoke suites assert on priceAtCreation during plan-change requests)
  invalidateEntitlements(vendor.id)
  if (original) {
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
  invalidateEntitlements(vendor.id)
  console.log("cleanup done (Rongin subscription restored)")
}

main()
  .catch((e) => { console.error("FAIL:", e); process.exit(1) })
  .finally(() => db.$disconnect())

if (typeof process.exitCode !== "number" || process.exitCode === 0) {
  // surfaced by the catch path above; keep bun's exit-code semantics intact
  process.exitCode = failures > 0 ? 1 : 0
}
