// ============ Pricing + contact blocks (DB plans + contact settings) ============
import { Clock, Mail, MapPin, Phone } from "lucide-react"
import { SectionHeading } from "@/saas/web/sections"
import { PricingCards, type PublicPlan } from "@/saas/web/pricing-cards"
import { ContactForm } from "@/saas/web/contact-form"
import { getSiteSettings } from "@/hrm-server/saas/cms"
import { db } from "@/lib/db"

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback)

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
    return [] // DB unavailable → "plans being configured" state (never fake prices)
  }
}

export async function PricingBlock({ data }: { data: Record<string, unknown> }) {
  const plans = await loadPlans()
  return (
    <section className="bg-slate-950 light:bg-white">
      <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6">
        <SectionHeading
          eyebrow={str(data.eyebrow, "Pricing")}
          title={<>{str(data.title, "Plans that scale with your organization")}</>}
          sub={str(data.sub, "Every plan defines capacity limits and module entitlements, enforced transparently on the server. Approaching a limit? The workspace tells you before you hit it.")}
        />
        <div className="mt-12">
          <PricingCards plans={plans} />
        </div>
      </div>
    </section>
  )
}

export async function ContactBlock({ data }: { data: Record<string, unknown> }) {
  const { contact } = await getSiteSettings()
  const showForm = data.showForm !== false && contact.showForm
  return (
    <section className="bg-slate-950 light:bg-white">
      <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6">
        <SectionHeading
          eyebrow={str(data.eyebrow, "Contact")}
          title={<>{str(data.title) || contact.heading}</>}
          sub={str(data.sub) || contact.sub}
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
          <div className="space-y-4">
            {(contact.phone || str(data.phone)) && (
              <InfoCard icon={Phone} label="Phone" value={contact.phone || str(data.phone)} />
            )}
            {(contact.email || str(data.email)) && (
              <InfoCard icon={Mail} label="Email" value={contact.email || str(data.email)} />
            )}
            {(contact.address || str(data.address)) && (
              <InfoCard icon={MapPin} label="Office" value={contact.address || str(data.address)} />
            )}
            {contact.hours && <InfoCard icon={Clock} label="Hours" value={contact.hours} />}
          </div>
          {showForm ? (
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 light:border-slate-200 light:bg-white light:shadow-sm">
              <ContactForm />
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-white/15 p-6 text-center text-sm text-slate-500 light:border-slate-300">
              Contact form disabled by the site owner.
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

function InfoCard({ icon: Icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <div className="flex items-start gap-4 rounded-2xl border border-white/10 bg-white/[0.03] p-5 light:border-slate-200 light:bg-white light:shadow-sm">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500/20 to-violet-500/20 ring-1 ring-white/10 light:ring-slate-200">
        <Icon className="h-4.5 w-4.5 text-indigo-300 light:text-indigo-600" />
      </span>
      <div>
        <p className="text-xs font-bold uppercase tracking-widest text-slate-500">{label}</p>
        <p className="mt-1 text-[15px] font-semibold text-white light:text-slate-900">{value}</p>
      </div>
    </div>
  )
}
