// ============ /register — server page (loads live plans + platform settings) ============
import { Suspense } from "react"
import type { Metadata } from "next"
import { db } from "@/lib/db"
import { getSaasSettings } from "@/hrm-server/saas/settings"
import { RegisterForm } from "@/saas/web/register-form"
import { type PublicPlan } from "@/saas/web/pricing-cards"
import { SectionHeading } from "@/saas/web/sections"

export const metadata: Metadata = {
  title: "Register your organization",
  description:
    "Submit your organization profile, primary administrator and plan preference. Applications are reviewed by the platform team; your workspace is provisioned on approval.",
  alternates: { canonical: "/register" },
  robots: { index: true, follow: true },
}

// PRF-11 (P2 wave, 2026-11-09) — force-dynamic removed: content reads
// through unstable_cache with tag invalidation (owner CMS saves call
// invalidateCmsCache → revalidateTag), so the page is statically rendered
// and revalidated instead of querying the database on every pageview.
//
// FORENSIC AUDIT 2026-11-10, FIN-003 (Phase 0): RegisterForm reads search
// params (useSearchParams — ?plan=…&cycle=…) during static pre-rendering, so
// it MUST sit inside a <Suspense> boundary or `next build` fails at the
// static-generation stage with "useSearchParams() should be wrapped in a
// suspense boundary". Same pattern as src/app/owner/reset-password/page.tsx.

async function loadPlans(): Promise<PublicPlan[]> {
  try {
    const rows = await db.saasPlan.findMany({
      where: { active: true, isPublic: true },
      orderBy: [{ sortOrder: "asc" }, { monthlyPrice: "asc" }],
    })
    return rows.map((p) => ({
      id: p.id, name: p.name, tagline: p.tagline, description: p.description,
      monthlyPrice: Number(p.monthlyPrice), yearlyPrice: Number(p.yearlyPrice),
      currency: p.currency, badge: p.badge, isTrialPlan: p.isTrialPlan,
      limits: {
        employeeLimit: p.employeeLimit, userLimit: p.userLimit, companyLimit: p.companyLimit, branchLimit: p.branchLimit,
        departmentLimit: p.departmentLimit, deviceLimit: p.deviceLimit, storageGb: p.storageGb,
        trackingEmployeeLimit: p.trackingEmployeeLimit,
      },
      features: {
        payroll: p.payrollEnabled, ait: p.aitEnabled, inventory: p.inventoryEnabled,
        procurement: p.procurementEnabled, performance: p.performanceEnabled, ess: p.essEnabled,
        camera: p.cameraEnabled, tracking: p.trackingEnabled, geofence: p.geofenceEnabled,
        api: p.apiAccess, advancedReports: p.advancedReports,
        fieldForce: p.fieldForceEnabled,
      },
      supportLevel: p.supportLevel,
    }))
  } catch {
    return []
  }
}

export default async function RegisterPage() {
  const [plans, settings] = await Promise.all([
    loadPlans(),
    getSaasSettings().catch(() => null),
  ])
  return (
    <section className="bg-slate-950 light:bg-white">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6">
        <SectionHeading
          eyebrow="Registration"
          title="Apply for your HR workspace"
          sub="Tell us about your organization and pick a plan. A platform administrator reviews every application — once approved, your workspace is provisioned and your administrator can sign in immediately."
        />
        <div className="mt-12">
          <Suspense
            fallback={
              <div
                className="mx-auto flex h-96 max-w-2xl items-center justify-center rounded-lg border border-slate-800 bg-slate-900/50 text-sm text-slate-400 light:border-slate-200 light:bg-slate-50"
                aria-label="Loading registration form"
              >
                Loading registration form…
              </div>
            }
          >
            <RegisterForm
              plans={plans}
              registrationEnabled={settings ? settings.registration.enabled : true}
              messageOnSubmit={settings ? settings.registration.messageOnSubmit : "Keep your Application ID — you can track its status anytime."}
            />
          </Suspense>
        </div>
      </div>
    </section>
  )
}
