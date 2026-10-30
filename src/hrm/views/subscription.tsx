"use client"
// 2026-10-25 (master prompt Part D §7): Billing and Subscription & Usage merged
// into ONE unified page — "Billing & Subscription" (src/hrm/views/billing.tsx)
// now carries the plan card, renew/pay, invoices & payments, the plan catalog
// with prorated self-service upgrades, live usage & limits and the module
// entitlements grid. This view is retired to a thin redirect: on mount it
// navigates to the billing view through the same zustand store action
// (navigate) the sidebar uses, with a button fallback in case the auto
// redirect does not fire (stale chunk remount, JS timing edge).
import { useEffect } from "react"
import { ArrowRight, CreditCard } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useHrm } from "../store"
import { PageHeader, SectionCard } from "../shared/ui-kit"

export default function SubscriptionView() {
  const navigate = useHrm((s) => s.navigate)
  // Only auto-redirect roles that can actually read the billing surface —
  // otherwise the billing view would land on its permission error banner.
  const canSeeBilling = useHrm((s) => s.can)("billing", "view")

  useEffect(() => {
    if (canSeeBilling) navigate("billing")
  }, [canSeeBilling, navigate])

  return (
    <div className="space-y-4">
      <PageHeader title="Subscription & Usage" subtitle="Moved into Billing & Subscription" />
      <SectionCard title="This page has moved">
        <div className="flex flex-col gap-3">
          <p className="text-sm text-slate-500 dark:text-slate-400 max-w-2xl">
            Subscription &amp; Usage is now part of <b>Billing &amp; Subscription</b> — your plan, renewals and
            payments, prorated upgrades and live usage in one place.
            {canSeeBilling ? " Taking you there…" : " Ask your platform administrator for access to the Billing page."}
          </p>
          {canSeeBilling && (
            <Button className="w-fit gap-1.5" onClick={() => navigate("billing")}>
              <CreditCard className="h-3.5 w-3.5" /> Go to Billing &amp; Subscription <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </SectionCard>
    </div>
  )
}
