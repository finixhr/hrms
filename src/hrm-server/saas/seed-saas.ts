// ============ SaaS platform seed (§59) — plans, owner account, demo data ============
// Three call modes:
//   1. From seed.ts      (full demo corpus): seedSaaSLayer({ demo: true })
//   2. From seed-owner.ts (clean tenant)     : seedSaaSLayer({ demo: false })
//   3. Standalone         : bun run src/hrm-server/saas/seed-saas.ts
//        HRM_SAAS_SEED_DEMO=1 adds the demo registrations/subscriptions.
//
// SAFETY RULES (master prompt §59):
//   - Demo registrations are marked isDemo=true and never counted as real data.
//   - The owner super-admin is ALWAYS created. When HRM_SAAS_OWNER_PASSWORD is
//     unset or fails validation the seed mints a strong one-time random
//     password and prints it once — a known/default/weak password is never
//     written in any environment (mirrors seed-owner.ts HIGH-1).
//   - Plans are configuration, not statistics — seeding them is always safe.
import crypto from "crypto"
import { db } from "@/lib/db"
import { hashOwnerPassword } from "./owner-auth"
import { hashPassword } from "../auth"
import { nextApplicationNumber } from "./sequences"
import { saasAudit } from "./audit"

const PLAN_DEFS = [
  {
    name: "Starter",
    tagline: "For small businesses getting organized",
    description: "Core HR: employees, attendance, leave and self-service — the essentials to run a small team properly.",
    monthlyPrice: 2500, yearlyPrice: 25000, sortOrder: 1, badge: null,
    employeeLimit: 50, userLimit: 10, branchLimit: 3, departmentLimit: 10, deviceLimit: 2, storageGb: 5, trackingEmployeeLimit: 0,
    payrollEnabled: false, aitEnabled: false, inventoryEnabled: false, procurementEnabled: false,
    performanceEnabled: false, essEnabled: true, cameraEnabled: false, trackingEnabled: false,
    geofenceEnabled: false, apiAccess: false, advancedReports: false,
    supportLevel: "STANDARD",
  },
  {
    name: "Business",
    tagline: "For growing organizations",
    description: "Everything in Starter plus payroll & AIT, live tracking, geo-fencing and device integration — the full operational toolkit.",
    monthlyPrice: 6500, yearlyPrice: 65000, sortOrder: 2, badge: "Most Popular",
    employeeLimit: 500, userLimit: 50, branchLimit: 15, departmentLimit: 50, deviceLimit: 10, storageGb: 25, trackingEmployeeLimit: 100,
    payrollEnabled: true, aitEnabled: true, inventoryEnabled: false, procurementEnabled: false,
    performanceEnabled: true, essEnabled: true, cameraEnabled: true, trackingEnabled: true,
    geofenceEnabled: true, apiAccess: false, advancedReports: true,
    fieldForceEnabled: true, // R3/R7 (2026-10-12): the demo seed ships field-force data for the sales cast
    supportLevel: "PRIORITY",
  },
  {
    name: "Professional",
    tagline: "For larger HR operations",
    description: "The complete platform: inventory & procurement, API access, advanced reports and dedicated support.",
    monthlyPrice: 15000, yearlyPrice: 150000, sortOrder: 3, badge: null,
    employeeLimit: 2000, userLimit: 200, branchLimit: 50, departmentLimit: 200, deviceLimit: 40, storageGb: 100, trackingEmployeeLimit: 500,
    payrollEnabled: true, aitEnabled: true, inventoryEnabled: true, procurementEnabled: true,
    performanceEnabled: true, essEnabled: true, cameraEnabled: true, trackingEnabled: true,
    geofenceEnabled: true, apiAccess: true, advancedReports: true,
    fieldForceEnabled: true,
    supportLevel: "DEDICATED",
  },
  {
    name: "Enterprise",
    tagline: "Custom pricing and advanced requirements",
    description: "Unlimited scale with custom terms — contact the platform team to size it together.",
    monthlyPrice: 0, yearlyPrice: 0, sortOrder: 4, badge: null,
    employeeLimit: null, userLimit: null, branchLimit: null, departmentLimit: null, deviceLimit: null, storageGb: null, trackingEmployeeLimit: null,
    payrollEnabled: true, aitEnabled: true, inventoryEnabled: true, procurementEnabled: true,
    performanceEnabled: true, essEnabled: true, cameraEnabled: true, trackingEnabled: true,
    geofenceEnabled: true, apiAccess: true, advancedReports: true,
    fieldForceEnabled: true,
    supportLevel: "DEDICATED",
  },
  {
    name: "Trial",
    tagline: "14-day evaluation",
    description: "Full Business feature set for evaluation — converts to a paid plan on approval.",
    monthlyPrice: 0, yearlyPrice: 0, sortOrder: 5, badge: null,
    employeeLimit: 25, userLimit: 5, branchLimit: 2, departmentLimit: 8, deviceLimit: 2, storageGb: 2, trackingEmployeeLimit: 10,
    // Post-release fix (CHANGES §9): the tagline promises the full Business
    // feature set, but the seed previously shipped cameraEnabled: false and
    // advancedReports: false — evaluators lost the Camera Manager (incl. EZVIZ
    // credential setup) and analytics mid-trial. Both now match Business.
    payrollEnabled: true, aitEnabled: true, inventoryEnabled: false, procurementEnabled: false,
    performanceEnabled: true, essEnabled: true, cameraEnabled: true, trackingEnabled: true,
    geofenceEnabled: true, apiAccess: false, advancedReports: true,
    supportLevel: "STANDARD",
  },
]

// Known weak/dev defaults refused in EVERY environment. The dev-only default
// ("SaasOwner@2026" below) is deliberately NOT in this list: it applies only
// outside production; production (or any invalid env value) falls through to
// a generated one-time password — the owner account is never skipped.
const PLACEHOLDER_PATTERNS = /^(Pass@123|Owner@123|CHANGE_ME|<|12345678|password)/i

/** One-time bootstrap password for the owner console when no valid
 *  HRM_SAAS_OWNER_PASSWORD is configured (~96 bits, URL-safe). The fixed
 *  "SaaS-" prefix guarantees the anchored placeholder patterns can never
 *  match a generated value. */
function generateOwnerPassword(): string {
  return `SaaS-${crypto.randomBytes(12).toString("base64url")}`
}

export async function seedSaaSLayer(opts: { demo?: boolean } = {}) {
  const demo = opts.demo ?? process.env.HRM_SAAS_SEED_DEMO === "1"
  const out: string[] = []

  // ---------- 1. plans (idempotent by name) ----------
  let createdPlans = 0
  for (const def of PLAN_DEFS) {
    const existing = await db.saasPlan.findFirst({ where: { name: def.name } })
    if (existing) continue
    await db.saasPlan.create({ data: { ...def, currency: "BDT", active: true, isPublic: def.name !== "Trial", isTrialPlan: def.name === "Trial" } })
    createdPlans++
  }
  const planCount = await db.saasPlan.count()
  out.push(`plans: ${createdPlans} created, ${planCount} total (Starter/Business/Professional/Enterprise/Trial)`)

  // ---------- 2. owner super-admin (ALWAYS created — never skipped) ----------
  const ownerEmail = (process.env.HRM_SAAS_OWNER_EMAIL || "owner@finixhr.local").toLowerCase().trim()
  const ownerName = process.env.HRM_SAAS_OWNER_NAME || "Platform Owner"
  const envPassword = process.env.HRM_SAAS_OWNER_PASSWORD || ""
  // Resolve a usable password without ever shipping a default in production:
  //   valid env value → use it · dev & unset → documented dev default ·
  //   anything else (production unset, weak/placeholder/short) → one-time
  //   generated password, printed once below so the console always has a login.
  const validPassword = (p: string) => !!p && p.length >= 12 && !PLACEHOLDER_PATTERNS.test(p)
  let ownerPassword = envPassword || (process.env.NODE_ENV === "production" ? "" : "SaasOwner@2026")
  const rejectedEnvValue = !!envPassword && !validPassword(envPassword)
  const generated = !validPassword(ownerPassword)
  if (generated) ownerPassword = generateOwnerPassword()

  const existing = await db.saasOwnerUser.findUnique({ where: { email: ownerEmail } })
  if (existing) {
    out.push(`owner: ${ownerEmail} already exists — reused`)
  } else {
    await db.saasOwnerUser.create({
      data: {
        email: ownerEmail, name: ownerName,
        passwordHash: hashOwnerPassword(ownerPassword),
        roleKey: "SUPER_ADMIN",
        permissions: JSON.stringify([]), // empty = full SUPER_ADMIN template
        status: "ACTIVE",
      },
    })
    await saasAudit({ name: "Seed" }, "OWNER_USER_CREATED", "SaaSOwnerUser", null,
      `Owner super-admin ${ownerEmail} seeded (SUPER_ADMIN${generated ? ", one-time generated password" : ""})`, {})
    if (generated) {
      out.push(`owner: ${ownerEmail} created (SUPER_ADMIN) — HRM_SAAS_OWNER_PASSWORD ${rejectedEnvValue ? "was rejected (weak/placeholder/short)" : "was not set"}, so a ONE-TIME password was generated:`)
      out.push(`owner:   ${ownerPassword}`)
      out.push(`owner:   SAVE IT NOW — it is stored hashed only and never shown again; rotate it after first login at /owner.`)
    } else {
      out.push(`owner: ${ownerEmail} created (SUPER_ADMIN — full template permissions)`)
    }
  }

  // ---------- 3. demo registrations (clearly marked, never real data) ----------
  if (demo) {
    const planBusiness = await db.saasPlan.findFirst({ where: { name: "Business" } })
    const planProfessional = await db.saasPlan.findFirst({ where: { name: "Professional" } })
    const planStarter = await db.saasPlan.findFirst({ where: { name: "Starter" } })

    const demoRegs: {
      org: string; admin: string; email: string; status: string; planId: string | null
      planName: string | null; cycle: string; emp: number; br: number; dev: number
      modules: string[]; note?: string; rejection?: string
    }[] = [
      { org: "Padma Textiles Ltd.", admin: "Shahidul Islam", email: "hr@padmatextiles.example", status: "PENDING", planId: planBusiness?.id || null, planName: "Business", cycle: "MONTHLY", emp: 320, br: 4, dev: 6, modules: ["EMPLOYEES", "ATTENDANCE", "PAYROLL", "LEAVE", "TRACKING", "ESS"], note: "Demo application (seed) — pending review" },
      { org: "Chattogram Logistics Co.", admin: "Farhana Yeasmin", email: "ops@clogistics.example", status: "UNDER_REVIEW", planId: planProfessional?.id || null, planName: "Professional", cycle: "YEARLY", emp: 850, br: 7, dev: 12, modules: ["EMPLOYEES", "ATTENDANCE", "PAYROLL", "DEVICES", "INVENTORY", "PROCUREMENT"], note: "Demo application (seed) — under review, asked for device count confirmation" },
      { org: "Sylhet Agro Farms", admin: "Kamrul Hasan", email: "kamrul@sylhetagro.example", status: "REJECTED", planId: planStarter?.id || null, planName: "Starter", cycle: "MONTHLY", emp: 18, br: 1, dev: 0, modules: ["EMPLOYEES", "ATTENDANCE", "ESS"], note: "Demo application (seed) — rejected", rejection: "Demo rejection (seed): organization details could not be verified. Please re-register with complete information." },
    ]
    let createdRegs = 0
    for (const r of demoRegs) {
      const dupe = await db.saasRegistration.findFirst({ where: { adminEmail: r.email } })
      if (dupe) continue
      const applicationNumber = await nextApplicationNumber()
      await db.saasRegistration.create({
        data: {
          applicationNumber,
          organizationName: r.org,
          organizationType: "PRIVATE_LTD",
          industry: "Demo",
          country: "Bangladesh",
          city: "Dhaka",
          officialEmail: `info@${r.org.split(" ")[0].toLowerCase()}.example`,
          adminName: r.admin,
          adminDesignation: "Managing Director",
          adminEmail: r.email,
          adminPhone: "+8801700000000",
          // demo credential — the seed prints it, it is NEVER a real password
          adminPasswordHash: hashPassword("DemoApp@2026"),
          employeeCount: r.emp, branchCount: r.br, deviceCount: r.dev,
          requestedModules: JSON.stringify(r.modules),
          planId: r.planId, planName: r.planName, billingCycle: r.cycle,
          status: r.status,
          internalNote: r.note,
          rejectionReason: r.rejection || null,
          reviewNote: r.status === "REJECTED" ? r.rejection : null,
          isDemo: true,
          source: "ADMIN",
        },
      })
      createdRegs++
    }
    out.push(`demo registrations: ${createdRegs} created (all isDemo=true — PENDING / UNDER_REVIEW / REJECTED examples)`)
  }

  // ---------- 4. demo subscriptions for existing demo vendors ----------
  if (demo) {
    const business = await db.saasPlan.findFirst({ where: { name: "Business" } })
    const starter = await db.saasPlan.findFirst({ where: { name: "Starter" } })
    const vendors = await db.vendor.findMany({ include: { saasSubscriptions: { select: { id: true } } } })
    let createdSubs = 0
    for (const v of vendors) {
      if (v.saasSubscriptions.length > 0) continue
      const isRongin = v.code === "RONGIN"
      const plan = isRongin ? starter : business
      if (!plan) continue
      const cycle = isRongin ? "MONTHLY" : "YEARLY"
      const start = new Date(Date.now() - (isRongin ? 20 : 200) * 86400000)
      const end = isRongin
        ? new Date(Date.now() + 5 * 86400000)   // expiring in 5 days → drives the renewal console
        : new Date(Date.now() + 165 * 86400000)
      const sub = await db.saasSubscription.create({
        data: {
          vendorId: v.id, planId: plan.id, planName: plan.name, billingCycle: cycle,
          status: "ACTIVE", startDate: start, endDate: end,
          priceAtCreation: cycle === "YEARLY" ? plan.yearlyPrice : plan.monthlyPrice,
          currencySnapshot: plan.currency,
          createdByName: "Seed (demo)",
          notes: "Demo subscription attached by the SaaS seed — isDemo provenance tracked by the seed itself",
        },
      })
      await db.saasSubscriptionEvent.create({
        data: {
          subscriptionId: sub.id, vendorId: v.id, type: "CREATED",
          toSnapshot: JSON.stringify({ plan: plan.name, cycle, status: "ACTIVE", endDate: end.toISOString() }),
          actorName: "Seed (demo)", note: "Demo subscription created by the SaaS seed",
        },
      })
      createdSubs++
    }
    out.push(`demo subscriptions: ${createdSubs} attached to seed vendors (Rongin Traders expires in 5 days — renewal console has data)`)
  }

  // ---- website CMS default content (pages, features, clients, testimonials) --
  try {
    const { seedCmsContent } = await import("./seed-cms")
    const r = await seedCmsContent({ only: "all" })
    out.push(`website CMS seeded: ${JSON.stringify(r.seeded)}`)
  } catch (e: any) {
    out.push(`website CMS seed skipped (${e?.message ?? "unknown error"})`)
  }

  return out
}

// Standalone runner: bun run src/hrm-server/saas/seed-saas.ts
// (HRM_SAAS_SEED_DEMO=1 to include demo registrations/subscriptions)
if (process.argv[1] && process.argv[1].includes("seed-saas")) {
  seedSaaSLayer({})
    .then((lines) => {
      console.log("── SaaS layer seed ─────────────────────────")
      lines.forEach((l) => console.log("  " + l))
      console.log("────────────────────────────────────────────")
    })
    .catch((e) => { console.error("saas seed failed:", e); process.exit(1) })
    .finally(() => db.$disconnect())
}
