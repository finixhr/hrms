// ============ /register — server page (loads live plans + platform settings) ============
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

export const dynamic = "force-dynamic"

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
        employeeLimit: p.employeeLimit, userLimit: p.userLimit, branchLimit: p.branchLimit,
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
          <RegisterForm
            plans={plans}
            registrationEnabled={settings ? settings.registration.enabled : true}
            messageOnSubmit={settings ? settings.registration.messageOnSubmit : "Keep your Application ID — you can track its status anytime."}
          />
        </div>
      </div>
    </section>
  )
}
