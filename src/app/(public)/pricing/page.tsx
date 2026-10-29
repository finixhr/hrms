// ============ /pricing — dynamic, database-backed (master prompt §10) ============
// Server component: reads live plans from the platform database. If the SaaS
// layer or the database is unavailable at render time the page degrades to the
// "plans being configured" state — never fake prices.
import type { Metadata } from "next"
import { db } from "@/lib/db"
import { PricingCards, type PublicPlan } from "@/saas/web/pricing-cards"
import { CtaBand, SectionHeading } from "@/saas/web/sections"

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Subscription plans with monthly and yearly billing, capacity limits (employees, users, branches, devices, storage) and module entitlements — managed live by the platform operator, never hardcoded.",
  alternates: { canonical: "/pricing" },
}

export const dynamic = "force-dynamic"

async function loadPlans(): Promise<PublicPlan[]> {
  try {
    const rows = await db.saasPlan.findMany({
      where: { active: true, isPublic: true },
      orderBy: [{ sortOrder: "asc" }, { monthlyPrice: "asc" }],
    })
    return rows.map((p) => ({
      id: p.id,
      name: p.name,
      tagline: p.tagline,
      description: p.description,
      monthlyPrice: Number(p.monthlyPrice),
      yearlyPrice: Number(p.yearlyPrice),
      currency: p.currency,
      badge: p.badge,
      isTrialPlan: p.isTrialPlan,
      limits: {
        employeeLimit: p.employeeLimit,
        userLimit: p.userLimit,
        branchLimit: p.branchLimit,
        departmentLimit: p.departmentLimit,
        deviceLimit: p.deviceLimit,
        storageGb: p.storageGb,
        trackingEmployeeLimit: p.trackingEmployeeLimit,
      },
      features: {
        payroll: p.payrollEnabled,
        ait: p.aitEnabled,
        inventory: p.inventoryEnabled,
        procurement: p.procurementEnabled,
        performance: p.performanceEnabled,
        ess: p.essEnabled,
        camera: p.cameraEnabled,
        tracking: p.trackingEnabled,
        geofence: p.geofenceEnabled,
        api: p.apiAccess,
        advancedReports: p.advancedReports,
        fieldForce: p.fieldForceEnabled,
      },
      supportLevel: p.supportLevel,
    }))
  } catch {
    return []
  }
}

export default async function PricingPage() {
  const plans = await loadPlans()
  return (
    <>
      <section className="bg-slate-950 light:bg-white">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6">
          <SectionHeading
            eyebrow="Pricing"
            title="Plans that scale with your organization"
            sub="Every plan defines capacity limits and module entitlements, enforced transparently on the server. Approaching a limit? The workspace tells you before you hit it."
          />
          <div className="mt-12">
            <PricingCards plans={plans} />
          </div>
        </div>
      </section>

      <section className="border-t border-white/10 bg-slate-950 light:border-slate-200 light:bg-slate-50">
        <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
          <SectionHeading eyebrow="Good to know" title="How billing works here" />
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            {[
              { t: "Approval-based activation", d: "Online payment isn't forced: every application is reviewed by the platform team, and payment can be handled offline (bank/MFS). The architecture is gateway-ready for when that changes." },
              { t: "Prices are snapshots", d: "The price you start with is recorded on your subscription. Later plan-list price changes never rewrite what an existing customer pays." },
              { t: "Expired ≠ deleted", d: "If a subscription lapses, the workspace becomes read-only. All data stays safe and fully readable — nothing is ever deleted because a payment lapsed." },
              { t: "Limits are visible", d: "Your workspace shows live usage vs. plan limits (employees, storage, devices…). When you approach a limit, the message says exactly what to do." },
            ].map((x) => (
              <div key={x.t} className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 light:border-slate-200 light:bg-white light:shadow-sm">
                <p className="text-sm font-bold text-white light:text-slate-900">{x.t}</p>
                <p className="mt-2 text-[13px] leading-relaxed text-slate-400 light:text-slate-600">{x.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <CtaBand title="Not sure which plan fits?" sub="Register anyway — pick the closest plan and the platform team will size it with you during review. Plan changes later are ordinary, audited operations." />
    </>
  )
}
