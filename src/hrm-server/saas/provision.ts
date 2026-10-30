// ============ Transactional tenant provisioning (registration approval) ============
// Runs when a SaaS owner APPROVES a registration application. Creates the
// tenant (Vendor), the primary administrator (VENDOR_OWNER), the statutory
// configuration and the subscription — as ONE database transaction so a
// partially-activated tenant can never exist (master prompt §18).
//
// The blueprint mirrors src/hrm-server/seed-owner.ts (the app's own clean
// tenant bootstrap): 15 approval workflows, 8 BD statutory leave types, the
// password policy, and the AIT FY config (best-effort after commit — it is
// idempotent and only affects Payroll AIT).
import { db } from "@/lib/db"
import { ensureAitConfig } from "../ait-engine"
import { j } from "../utils"
import type { SaasRegistration } from "@prisma/client"

// All 15 approval-engine process types (schema ApprovalWorkflow.processType)
// — identical to seed-owner.ts.
const PROCESS_TYPES = [
  "LEAVE", "LOAN", "ADVANCE", "EXPENSE", "PAYROLL", "LETTER", "RESIGNATION",
  "PROMOTION", "TRANSFER", "SALARY_REVISION", "OVERTIME", "ENCASHMENT",
  "GOODS_REQUISITION", "PURCHASE", "ASSET_ISSUE",
] as const

// BD statutory leave types with standard policies (Bangladesh Labour Act) —
// identical to seed-owner.ts. LVE-113 (R7): encashment on ANNUAL only, sick
// attachments, casual 3-day consecutive cap, no EARNED duplicate.
const LEAVE_TYPE_DEFS: [string, string, boolean, number, boolean, boolean][] = [
  ["CASUAL", "Casual Leave", true, 10, false, false],
  ["SICK", "Sick Leave", true, 14, false, false],
  ["ANNUAL", "Annual Leave", true, 20, true, true],
  ["EMERGENCY", "Emergency Leave", true, 7, false, false],
  ["MATERNITY", "Maternity Leave", true, 112, false, false],
  ["PATERNITY", "Paternity Leave", true, 7, false, false],
  ["UNPAID", "Unpaid Leave", false, 15, false, false],
]

export function cycleEndDate(start: Date, cycle: string): Date {
  const end = new Date(start)
  if (cycle === "YEARLY") end.setFullYear(end.getFullYear() + 1)
  else end.setMonth(end.getMonth() + 1)
  return end
}

/** Unique, stable vendor code from the organization name: uppercase alnum
 *  slug (max 8) + 4-char hex suffix to guarantee uniqueness. */
function vendorCodeFrom(orgName: string): string {
  const slug = (orgName || "ORG")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .slice(0, 8) || "ORG"
  const suffix = Math.random().toString(16).slice(2, 6).toUpperCase()
  return `${slug}-${suffix}`
}

export type ProvisionResult = {
  vendorId: string
  vendorCode: string
  adminUserId: string
  subscriptionId: string
  initialInvoiceId?: string
  initialInvoiceNumber?: string
  warnings: string[]
}

/**
 * Provisions a fully-operational tenant from an APPROVED registration.
 * @param reg the registration row (must carry adminPasswordHash)
 * @param planId the plan to assign (falls back to the registration's plan)
 * @param actorName who approved (for records)
 */
export async function provisionTenant(
  reg: SaasRegistration,
  planId: string,
  actor: { id?: string | null; name?: string | null }
): Promise<ProvisionResult> {
  const plan = await db.saasPlan.findUnique({ where: { id: planId } })
  if (!plan) throw Object.assign(new Error("Plan not found — it may have been deleted. Restore it or pick another plan."), { code: 400 })
  if (!reg.adminPasswordHash) {
    throw Object.assign(
      new Error("This application has no stored administrator credential (created before the SaaS layer). Re-register or set a password manually."),
      { code: 400 }
    )
  }

  const warnings: string[] = []
  const billingCycle = reg.billingCycle === "YEARLY" ? "YEARLY" : "MONTHLY"
  const startDate = new Date()
  const endDate = cycleEndDate(startDate, billingCycle)
  const price = billingCycle === "YEARLY" ? plan.yearlyPrice : plan.monthlyPrice

  // ---- ONE transaction: vendor + admin + policy + workflows + leave types ----
  const created = await db.$transaction(async (tx) => {
    // 1. vendor (tenant)
    let code = vendorCodeFrom(reg.organizationName)
    // retry-safe: the 4-char hex suffix collision chance is negligible, but
    // the unique constraint would abort the transaction — check first.
    while (await tx.vendor.findUnique({ where: { code } })) code = vendorCodeFrom(reg.organizationName)
    const vendor = await tx.vendor.create({
      data: {
        name: reg.organizationName,
        code,
        legalName: reg.organizationName,
        address: [reg.address, reg.city, reg.country].filter(Boolean).join(", ") || null,
        phone: reg.adminPhone || reg.contactNumber || null,
        email: reg.officialEmail || reg.adminEmail,
        active: true,
      },
    })

    // 2. primary administrator — VENDOR_OWNER with the full tenant-admin
    //    permission set (same as the clean seed; ALL_PERMISSIONS is computed
    //    in admin routes as MODULES × ACTIONS — replicate inline so this file
    //    has no import cycle with routes).
    const { ACTIONS, MODULES } = await import("../types")
    const allPerms: string[] = []
    for (const m of MODULES) for (const a of ACTIONS) allPerms.push(`${m}.${a}`)
    const admin = await tx.user.create({
      data: {
        vendorId: vendor.id,
        email: reg.adminEmail.toLowerCase().trim(),
        name: reg.adminName,
        phone: reg.adminPhone || null,
        passwordHash: reg.adminPasswordHash, // chosen by the applicant at registration
        role: "VENDOR_OWNER",
        permissions: JSON.stringify(allPerms),
        status: "ACTIVE",
        // the applicant picked this password days ago at most — count it as
        // fresh so the 90-day policy below starts counting from activation.
        passwordChangedAt: new Date(),
      },
    })

    // 3. password rotation policy (same as the clean seed)
    await tx.hrSetting.upsert({
      where: { vendorId_group_key: { vendorId: vendor.id, group: "passwordPolicy", key: "expiryDays" } },
      create: { vendorId: vendor.id, group: "passwordPolicy", key: "expiryDays", value: "90" },
      update: { value: "90" },
    })

    // 4. the 14 single-step approval workflows
    for (const processType of PROCESS_TYPES) {
      const wf = await tx.approvalWorkflow.create({
        data: {
          vendorId: vendor.id, processType,
          name: `${processType.replace(/_/g, " ")} Approval`.replace(/\b\w/g, (c) => c.toUpperCase()),
          active: true,
          description: "Provisioned default: single Owner Approval step — customize in Settings → Approval Workflows",
        },
      })
      await tx.approvalStep.create({
        data: {
          vendorId: vendor.id, // DB-02 (R5)
          workflowId: wf.id, sequence: 1, name: "Owner Approval",
          approverRole: "VENDOR_OWNER", required: true, rejectBehavior: "REJECT_ALL",
        },
      })
    }

    // 5. BD statutory leave types
    for (const [code, name, paid, days, cf, encash] of LEAVE_TYPE_DEFS) {
      await tx.leaveType.create({
        data: {
          vendorId: vendor.id, code, name, paid, defaultDays: days,
          carryForward: cf, maxCarryForward: cf ? 5 : 0,
          encashmentAllowed: encash,
          waitingPeriodDays: code === "CASUAL" ? 0 : 30,
          probationEligible: ["CASUAL", "SICK", "EMERGENCY"].includes(code),
          // LVE-113 (R7) — medical certificate + consecutive-run cap
          requiresAttachment: code === "SICK",
          maxConsecutiveDays: code === "CASUAL" ? 3 : 0,
        },
      })
    }

    // 6. the subscription (price snapshot at creation)
    //    2026-10-25 (master prompt Part F §10): a PAID plan provisions as
    //    PENDING_PAYMENT — the tenant stays fully LOCKED out of the HR
    //    modules until the first invoice is paid and verified. A TRIAL plan
    //    is a deliberately authorized free entitlement and provisions as
    //    TRIAL with immediate access.
    const initialStatus = plan.isTrialPlan ? "TRIAL" : "PENDING_PAYMENT"
    const sub = await tx.saasSubscription.create({
      data: {
        vendorId: vendor.id,
        planId: plan.id,
        planName: plan.name,
        billingCycle,
        status: initialStatus,
        startDate,
        endDate,
        priceAtCreation: price,
        currencySnapshot: plan.currency,
        createdBy: actor.id || null,
        createdByName: actor.name || null,
      },
    })
    await tx.saasSubscriptionEvent.create({
      data: {
        subscriptionId: sub.id, vendorId: vendor.id, type: "CREATED",
        toSnapshot: JSON.stringify({ plan: plan.name, cycle: billingCycle, status: initialStatus, endDate: endDate.toISOString() }),
        actorId: actor.id || null, actorName: actor.name || null,
        note: `Tenant provisioned from application ${reg.applicationNumber}`,
      },
    })

    return { vendor, admin, sub }
  })

  // ---- post-commit: AIT statutory config (idempotent ensure; uses the db
  //      handle, not tx — by design, see ait-engine). Failure is a warning,
  //      never a partially-created tenant: the transaction above already
  //      committed a fully functional tenant; AIT only matters once the
  //      customer runs Payroll AIT, and ensureAitConfig runs again lazily.
  try {
    await ensureAitConfig(created.vendor.id)
  } catch (e: any) {
    warnings.push(`AIT statutory config could not be bootstrapped automatically (${String(e?.message || e).slice(0, 160)}). Payroll AIT will bootstrap it on first use — or run it from Settings.`)
  }

  // invalidate the entitlements memo for safety (new subscription row)
  const { invalidateEntitlements } = await import("./entitlements")
  invalidateEntitlements(created.vendor.id)

  let initialInvoice: { id: string; number: string } | undefined

  // 2026-10-25 (master prompt Part F §10): a paid plan's FIRST invoice is
  // issued at provisioning so the tenant can Pay Now immediately from the
  // Billing & Subscription page. Paying it flips PENDING_PAYMENT → ACTIVE
  // (settle.ts → applyPaidTerm). Failure is a warning — the tenant can still
  // trigger it from the Billing page via billing.renew (idempotent per term).
  if (created.sub.status === "PENDING_PAYMENT") {
    try {
      const { createTermInvoice } = await import("./payments/billing-ops")
      initialInvoice = await createTermInvoice({
        vendorId: created.vendor.id,
        subscriptionId: created.sub.id,
        registrationId: reg.id || null,
        amount: Number(price),
        currency: plan.currency,
        periodStart: startDate,
        periodEnd: endDate,
        dueAt: startDate,
        notes: `Initial subscription — ${plan.name} (${billingCycle.toLowerCase()})`,
        actor: { id: actor.id || null, name: actor.name || "Provisioning" },
      })
    } catch (e: any) {
      warnings.push(`The initial invoice could not be issued automatically (${String(e?.message || e).slice(0, 160)}). The tenant can generate it from the Billing page.`)
    }
  }

  return {
    vendorId: created.vendor.id,
    vendorCode: created.vendor.code,
    adminUserId: created.admin.id,
    subscriptionId: created.sub.id,
    initialInvoiceId: initialInvoice?.id,
    initialInvoiceNumber: initialInvoice?.number,
    warnings,
  }
}

/** Attach the outcome back onto the registration row + optional subscription
 *  event trail. Called by the approve route AFTER provisioning succeeds. */
export function requestedModulesOf(reg: SaasRegistration): string[] {
  return j(reg.requestedModules || "[]", [])
}
