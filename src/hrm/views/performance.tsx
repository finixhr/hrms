"use client"
// ============ Performance & KPI (2026-11 redesign) ============
// Four primary sections per the KPI Performance System master prompt:
//   1. KPI Templates — Company + Department templates with built-in + custom indicators
//   2. KPI Target Assignments — single + bulk Excel assignment with approval workflow
//   3. KPI Target Achievement — actual data entry (single + bulk) with approval
//   4. Performance Review & Analytics — the UNIFIED experience that replaced the
//      standalone Review (9-area cycles) and Analytics tabs. The pre-redesign
//      backend routes (cycles.*/reviews.*/kpiTemplates.*/kpiAssignments.*) stay
//      registered for ESS + mobile consumers; their data stays coherent through
//      the resultsJson/totalScore mirror (src/hrm-server/kpi/service.ts).
import { useHrm } from "../store"
import { PageHeader, SectionTabs } from "../shared/ui-kit"
import KpiTemplatesTab from "./kpi/templates-tab"
import KpiTargetsTab from "./kpi/targets-tab"
import KpiAchievementsTab from "./kpi/achievements-tab"
import KpiAnalyticsTab from "./kpi/analytics-tab"

export default function PerformanceView() {
  // global-search deep link: pre-select a tab (params arrive with the view)
  const presetTab = useHrm((s) => (s.view?.key === "performance" && s.view?.params?.tab) || undefined)
  return (
    <div className="space-y-4">
      <PageHeader
        title="Performance & KPI"
        subtitle="Company + Department KPI templates · target assignment & achievement with mandatory approval · unified performance review & analytics"
      />
      <SectionTabs defaultValue={(presetTab as string | undefined) || "templates"} tabs={[
        { value: "templates", label: "KPI Templates", content: <KpiTemplatesTab /> },
        { value: "assignments", label: "KPI Target Assignments", content: <KpiTargetsTab /> },
        { value: "achievements", label: "KPI Target Achievement", content: <KpiAchievementsTab /> },
        { value: "analytics", label: "Performance Review & Analytics", content: <KpiAnalyticsTab /> },
      ]} />
    </div>
  )
}
