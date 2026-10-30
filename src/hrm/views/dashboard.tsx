"use client"
// ============ HR Dashboard (spec §16) — customizable widget workspace ============
// 2026 redesign: the fixed dashboard became a WIDGET-BASED customizable grid
// (src/hrm/dashboard/). This view keeps its responsibilities:
//   1. load dashboard.stats ONCE and hand it to every widget via context
//   2. render the greeting header
//   3. render the post-approval onboarding checklist (self-hiding, admins)
// All KPI/chart/list content now lives in the widget library — the default
// layout reproduces the previous arrangement for every existing user.
import { useHrm } from "../store"
import { useApi } from "../api"
import { PageHeader, ErrorBanner } from "../shared/ui-kit"
import { OnboardingChecklist } from "./onboarding"
import { CustomizableDashboard } from "../dashboard/grid"

export default function DashboardView() {
  const user = useHrm((s) => s.user)
  const { data, loading, error } = useApi<any>("dashboard.stats")

  const today = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })
  const vendorSummary = data
    ? `${data.workforce.total} employees · ${data.byBranch.length} branches · ${data.byDepartment.length} departments`
    : "Your workforce command center"

  return (
    <div className="space-y-3">
      <PageHeader
        title={`Good day, ${user?.name?.split(" ")[0]}`}
        subtitle={`${today} · ${vendorSummary}`}
      />

      {/* 2026-10-04 — post-approval setup checklist (live from onboarding.status;
          self-hiding once complete or dismissed by an admin) */}
      <OnboardingChecklist />

      {error ? (
        <ErrorBanner message={error} />
      ) : loading && !data ? (
        // grid-shaped skeleton lives inside the dashboard component
        <CustomizableDashboard data={null} />
      ) : data ? (
        <CustomizableDashboard data={data} />
      ) : null}
    </div>
  )
}
