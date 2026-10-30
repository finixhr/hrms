"use client"
// ============ Widget registry — the dashboard's source of truth ============
// Declares every available HRM widget with its availability gates (permission,
// module visibility, SaaS entitlement, role), sizing hints and default order.
// The default layout replicates the classic HR Dashboard arrangement so a
// fresh tenant sees exactly the sensible setup; each user then customizes.
import {
  LayoutDashboard, Users, Clock, Gauge, Wallet, TrendingUp, Building2, Receipt,
  PieChart, Network, UserRound, Cake, CheckCircle2, ShieldAlert, Cctv, ListChecks, Megaphone, Zap,
  Rss, Plane, Timer, MonitorSmartphone, FileWarning, UserPlus, LogOut, Landmark, Boxes,
  ShoppingCart, TrendingUp as TrendingIcon, Sparkles, ShieldCheck, CalendarDays, Receipt as ReceiptIcon,
  AlertTriangle,
} from "lucide-react"
import type { DashboardLayout, PlacedWidget, WidgetDef, WidgetGates } from "./types"
import { isWidgetAvailable } from "./types"
import {
  QuickActionsWidget, WorkforceKpisWidget, AttendanceTodayWidget, AttendanceRateWidget,
  PayrollSummaryWidget, HeadcountTrendWidget, BranchDistributionWidget, PayrollTrendWidget,
  DepartmentDistributionWidget, EmploymentTypeWidget, GenderSplitWidget, DesignationTopWidget,
  BirthdaysWidget, PendingApprovalsWidget, AlertsWidget, CameraStatusWidget, MyTasksWidget,
  AnnouncementsWidget,
  // 2026-10 expansion
  AttendanceLiveFeedWidget, UpcomingLeavesWidget, OvertimeMonthWidget, DeviceHealthWidget,
  NewJoinersWidget, ProbationCompletionsWidget, ExitNoticesWidget, LoanInstallmentsWidget,
  ExpenseSummaryWidget, ExpiringDocumentsWidget, PerformanceReviewsWidget, LowStockWidget,
  PendingProcurementWidget, PlanUsageWidget, RecentAuditWidget, UpcomingEventsWidget,
  // Wave 2 WP-K — asset widgets
  AssetFleetWidget, AssetWarrantyWidget,
} from "./widgets"

export const WIDGETS: WidgetDef[] = [
  // ---------- Overview ----------
  {
    id: "quick-actions", title: "Quick Actions", icon: Zap, category: "Overview",
    description: "Permission-aware shortcuts — add employees, mark attendance, run payroll, approvals.",
    defaultSize: 12, minSize: 6, render: (ctx) => <QuickActionsWidget {...ctx} />,
  },
  {
    id: "workforce-kpis", title: "Workforce KPIs", icon: Users, category: "Overview",
    description: "Total headcount, probation, on leave, new joiners, resigned and terminated — each drills into a filtered directory.",
    defaultSize: 12, minSize: 8, linkTo: "employees", render: (ctx) => <WorkforceKpisWidget {...ctx} />,
  },
  {
    id: "attendance-rate", title: "Attendance Rate", icon: Gauge, category: "Overview",
    description: "Today's attendance rate at a glance with present/absent split.",
    defaultSize: 4, minSize: 3, linkTo: "attendance", render: (ctx) => <AttendanceRateWidget {...ctx} />,
  },
  // ---------- People ----------
  {
    id: "birthdays", title: "Birthdays & Anniversaries", icon: Cake, category: "People",
    description: "Today's celebrations and upcoming birthdays across the workforce.",
    defaultSize: 4, minSize: 3, render: (ctx) => <BirthdaysWidget {...ctx} />,
  },
  {
    id: "department-distribution", title: "By Department", icon: Network, category: "People",
    description: "Headcount distribution across departments with drill-down.",
    defaultSize: 4, minSize: 3, linkTo: "employees", render: (ctx) => <DepartmentDistributionWidget {...ctx} />,
  },
  {
    id: "designation-top", title: "Top Designations", icon: UserRound, category: "People",
    description: "Most populated designations, ranked.",
    defaultSize: 4, minSize: 3, render: (ctx) => <DesignationTopWidget {...ctx} />,
  },
  {
    id: "gender-split", title: "Gender Split", icon: PieChart, category: "People",
    description: "Workforce gender composition donut.",
    defaultSize: 4, minSize: 3, render: (ctx) => <GenderSplitWidget {...ctx} />,
  },
  // ---------- Time & Attendance ----------
  {
    id: "attendance-today", title: "Attendance Today", icon: Clock, category: "Time & Attendance",
    description: "Present / late / leave / absent / WFH breakdown with the live attendance rate.",
    defaultSize: 8, minSize: 6, linkTo: "attendance", perm: ["attendance", "view"], render: (ctx) => <AttendanceTodayWidget {...ctx} />,
  },
  // ---------- Payroll & Finance ----------
  {
    id: "payroll-summary", title: "Payroll & Financial HR", icon: Wallet, category: "Payroll & Finance",
    description: "Latest paid run — gross, net, deductions, overtime, bonus and loan outstanding.",
    defaultSize: 4, minSize: 3, linkTo: "payroll", perm: ["payroll", "view"], feature: "PAYROLL", render: (ctx) => <PayrollSummaryWidget {...ctx} />,
  },
  {
    id: "payroll-trend", title: "Payroll Trend", icon: Receipt, category: "Payroll & Finance",
    description: "Gross vs net across the last paid runs.",
    defaultSize: 4, minSize: 3, perm: ["payroll", "view"], feature: "PAYROLL", render: (ctx) => <PayrollTrendWidget {...ctx} />,
  },
  {
    id: "headcount-trend", title: "Headcount Trend", icon: TrendingUp, category: "Payroll & Finance",
    description: "12-month headcount evolution.",
    defaultSize: 4, minSize: 3, render: (ctx) => <HeadcountTrendWidget {...ctx} />,
  },
  {
    id: "branch-distribution", title: "Employees by Branch", icon: Building2, category: "Payroll & Finance",
    description: "Headcount per branch — click a bar to open the directory.",
    defaultSize: 4, minSize: 3, linkTo: "employees", perm: ["organization", "view"], render: (ctx) => <BranchDistributionWidget {...ctx} />,
  },
  {
    id: "employment-type", title: "Employment Mix", icon: PieChart, category: "Payroll & Finance",
    description: "Full-time / part-time / contract composition.",
    defaultSize: 4, minSize: 3, render: (ctx) => <EmploymentTypeWidget {...ctx} />,
  },
  // ---------- Compliance & Alerts ----------
  {
    id: "pending-approvals", title: "Pending Approvals", icon: CheckCircle2, category: "Compliance & Alerts",
    description: "Leave, loans, expenses, corrections and resignations awaiting action.",
    defaultSize: 4, minSize: 3, linkTo: "approvals", perm: ["approvals", "view"], render: (ctx) => <PendingApprovalsWidget {...ctx} />,
  },
  {
    id: "alerts", title: "Alerts & Compliance", icon: ShieldAlert, category: "Compliance & Alerts",
    description: "Repeated lateness, absences, expiring documents, contracts and probation deadlines.",
    defaultSize: 4, minSize: 3, render: (ctx) => <AlertsWidget {...ctx} />,
  },
  {
    id: "camera-status", title: "Camera Manager", icon: Cctv, category: "Compliance & Alerts",
    description: "CCTV fleet health — online/offline counts and brand breakdown.",
    defaultSize: 8, minSize: 6, linkTo: "cameras", perm: ["camera", "view"], module: "camera", feature: "CAMERA", render: (ctx) => <CameraStatusWidget {...ctx} />,
  },
  // ---------- Communication ----------
  {
    id: "my-tasks", title: "My Tasks", icon: ListChecks, category: "Communication",
    description: "Your open assignments with due dates.",
    defaultSize: 4, minSize: 3, linkTo: "tasks", render: (ctx) => <MyTasksWidget {...ctx} />,
  },
  {
    id: "announcements", title: "Announcements", icon: Megaphone, category: "Communication",
    description: "Latest company announcements and pinned posts.",
    defaultSize: 4, minSize: 3, linkTo: "announcements", render: (ctx) => <AnnouncementsWidget {...ctx} />,
  },
  // ---------- 2026-10 expansion: Time & Attendance ----------
  {
    id: "attendance-live-feed", title: "Attendance Live Feed", icon: Rss, category: "Time & Attendance",
    description: "Newest recorded punches — device, mobile and admin entries as they land (auto-refreshes).",
    defaultSize: 4, minSize: 3, defaultRowSpan: 2, minRowSpan: 1, linkTo: "attendance", perm: ["attendance", "view"],
    bodyClassName: "overflow-y-auto scroll-thin",
    render: (ctx) => <AttendanceLiveFeedWidget {...ctx} />,
  },
  {
    id: "upcoming-leaves", title: "Upcoming Leaves", icon: Plane, category: "Time & Attendance",
    description: "Approved leaves starting in the next 7 days.",
    defaultSize: 4, minSize: 3, linkTo: "leave", perm: ["leave", "view"], render: (ctx) => <UpcomingLeavesWidget {...ctx} />,
  },
  {
    id: "overtime-month", title: "Overtime This Month", icon: Timer, category: "Time & Attendance",
    description: "Total overtime hours and the employees earning them this month.",
    defaultSize: 4, minSize: 3, linkTo: "overtime", perm: ["attendance", "view"], render: (ctx) => <OvertimeMonthWidget {...ctx} />,
  },
  {
    id: "device-health", title: "Device Health", icon: MonitorSmartphone, category: "Time & Attendance",
    description: "Attendance device fleet — online/offline counts and the last punch received.",
    defaultSize: 4, minSize: 3, perm: ["devices", "view"], module: "devices", render: (ctx) => <DeviceHealthWidget {...ctx} />,
  },
  // ---------- 2026-10 expansion: People ----------
  {
    id: "new-joiners", title: "New Joiners (30d)", icon: UserPlus, category: "People",
    description: "Employees who joined in the last 30 days.",
    defaultSize: 4, minSize: 3, linkTo: "employees", render: (ctx) => <NewJoinersWidget {...ctx} />,
  },
  {
    id: "probation-completions", title: "Probation Completions", icon: Timer, category: "People",
    description: "Probation periods ending soon — confirm or extend.",
    defaultSize: 4, minSize: 3, render: (ctx) => <ProbationCompletionsWidget {...ctx} />,
  },
  {
    id: "exit-notices", title: "Notice Periods", icon: LogOut, category: "People",
    description: "Employees currently serving their notice period.",
    defaultSize: 4, minSize: 3, linkTo: "exit", perm: ["exit", "view"], render: (ctx) => <ExitNoticesWidget {...ctx} />,
  },
  // ---------- 2026-10 expansion: Payroll & Finance ----------
  {
    id: "loan-installments", title: "Loan Installments Due", icon: Landmark, category: "Payroll & Finance",
    description: "Installments falling due within the next 7 days.",
    defaultSize: 4, minSize: 3, linkTo: "loans", perm: ["loans", "view"], feature: "PAYROLL", render: (ctx) => <LoanInstallmentsWidget {...ctx} />,
  },
  {
    id: "expense-summary", title: "Expense Claims", icon: ReceiptIcon, category: "Payroll & Finance",
    description: "Pending expense claims and their total value.",
    defaultSize: 4, minSize: 3, linkTo: "expenses", perm: ["expenses", "view"], feature: "PAYROLL", render: (ctx) => <ExpenseSummaryWidget {...ctx} />,
  },
  // ---------- 2026-10 expansion: Compliance & Alerts ----------
  {
    id: "expiring-documents", title: "Expiring Documents", icon: FileWarning, category: "Compliance & Alerts",
    description: "Employee documents and contracts approaching expiry.",
    defaultSize: 4, minSize: 3, defaultRowSpan: 2, minRowSpan: 1,
    bodyClassName: "overflow-y-auto scroll-thin",
    render: (ctx) => <ExpiringDocumentsWidget {...ctx} />,
  },
  // ---------- 2026-10 expansion: Operations ----------
  {
    id: "performance-reviews", title: "Review Cycles Ending", icon: TrendingIcon, category: "Operations",
    description: "Performance review cycles ending within 14 days.",
    defaultSize: 4, minSize: 3, linkTo: "performance", perm: ["performance", "view"], feature: "PERFORMANCE", render: (ctx) => <PerformanceReviewsWidget {...ctx} />,
  },
  {
    id: "low-stock", title: "Low Stock Alerts", icon: Boxes, category: "Operations",
    description: "Inventory items at or below their reorder level.",
    defaultSize: 4, minSize: 3, linkTo: "inventory", perm: ["inventory", "view"], feature: "INVENTORY", render: (ctx) => <LowStockWidget {...ctx} />,
  },
  {
    id: "pending-procurement", title: "Procurement Pipeline", icon: ShoppingCart, category: "Operations",
    description: "Purchase requests pending in the procurement pipeline.",
    defaultSize: 4, minSize: 3, linkTo: "procurement", perm: ["procurement", "view"], feature: "PROCUREMENT", render: (ctx) => <PendingProcurementWidget {...ctx} />,
  },
  // ---------- 2026-10 expansion: Communication ----------
  {
    id: "upcoming-events", title: "Upcoming Events", icon: CalendarDays, category: "Communication",
    description: "Holidays, company events, birthdays and anniversaries from the company calendar.",
    defaultSize: 4, minSize: 3, linkTo: "calendar", module: "calendar", perm: ["calendar", "view"], render: (ctx) => <UpcomingEventsWidget {...ctx} />,
  },
  // ---------- 2026-10 expansion: Platform ----------
  {
    id: "plan-usage", title: "Plan & Usage", icon: Sparkles, category: "Platform",
    description: "Your subscription plan with employees, devices and storage usage against limits.",
    defaultSize: 4, minSize: 3, linkTo: "subscription", module: "subscription", perm: ["subscription", "view"], render: (ctx) => <PlanUsageWidget {...ctx} />,
  },
  {
    id: "recent-audit", title: "Recent Activity", icon: ShieldCheck, category: "Platform",
    description: "The latest audit trail entries — who did what, and when.",
    defaultSize: 4, minSize: 3, defaultRowSpan: 2, minRowSpan: 1, linkTo: "audit", perm: ["audit", "view"],
    bodyClassName: "overflow-y-auto scroll-thin",
    render: (ctx) => <RecentAuditWidget {...ctx} />,
  },
  // ---------- Wave 2 WP-K — asset widgets (appended; existing layouts unaffected) ----------
  {
    id: "asset-fleet", title: "Asset Fleet", icon: Boxes, category: "Operations",
    description: "Company assets by status — assigned, in stock, repair, lost — plus the 30-day warranty lead.",
    defaultSize: 4, minSize: 3, linkTo: "assets", perm: ["assets", "view"], module: "assets", feature: "INVENTORY",
    render: (ctx) => <AssetFleetWidget {...ctx} />,
  },
  {
    id: "asset-warranty", title: "Asset Warranties Expiring", icon: AlertTriangle, category: "Operations",
    description: "Assets whose warranty expires within 30 days, and who currently holds them.",
    defaultSize: 4, minSize: 3, linkTo: "assets", perm: ["assets", "view"], module: "assets", feature: "INVENTORY",
    render: (ctx) => <AssetWarrantyWidget {...ctx} />,
  },
]

export const WIDGET_BY_ID: Record<string, WidgetDef> = Object.fromEntries(WIDGETS.map((w) => [w.id, w]))

/** Widgets the CURRENT user may see (all gates applied). */
export function availableWidgets(gates: WidgetGates): WidgetDef[] {
  return WIDGETS.filter((w) => isWidgetAvailable(w, gates))
}

/** Default arrangement order — mirrors the classic HR Dashboard layout. */
export const DEFAULT_ORDER = [
  "quick-actions",
  "workforce-kpis",
  "attendance-today", "attendance-live-feed", "payroll-summary",
  "headcount-trend", "branch-distribution", "payroll-trend",
  "department-distribution", "employment-type", "gender-split",
  "designation-top", "birthdays", "pending-approvals", "alerts",
  "attendance-rate", "my-tasks", "announcements",
  "camera-status",
  // 2026-10 expansion — appended so existing saved layouts are unaffected
  "upcoming-leaves", "overtime-month", "upcoming-events",
  "new-joiners", "probation-completions", "exit-notices",
  "loan-installments", "expense-summary",
  "expiring-documents", "performance-reviews", "low-stock", "pending-procurement",
  "device-health", "plan-usage", "recent-audit",
  // Wave 2 WP-K — asset widgets (APPENDED ONLY; never reorder the entries above)
  "asset-fleet", "asset-warranty",
]

/** Sensible default layout for a user: default order ∩ availability. */
export function buildDefaultLayout(available: WidgetDef[]): PlacedWidget[] {
  const byId = new Map(available.map((d) => [d.id, d]))
  return DEFAULT_ORDER
    .map((id) => byId.get(id))
    .filter((d): d is WidgetDef => !!d)
    .map((d) => ({
      id: d.id,
      size: d.defaultSize,
      ...(d.defaultRowSpan && d.defaultRowSpan > 1 ? { rowSpan: d.defaultRowSpan } : {}),
    }))
}

// ============ per-user persistence (localStorage) ============
// The layout is a pure UI preference — localStorage keeps it per browser per
// user without touching the backend (the redesign must not alter the DB or
// the RPC surface). Key is namespaced by user id so shared machines never
// cross-contaminate layouts.

// v3 keys keep the v2 namespace: saved v2 layouts (no rowSpan) load unchanged
// and default to a single row — the schema is additive, not a migration.
const layoutKey = (userId: string) => `hrm_dash_v3_${userId}`
/** legacy v2 keys are migrated on first load (same data, no rowSpan) */
const legacyLayoutKey = (userId: string) => `hrm_dash_v2_${userId}`

const VALID_SIZES = new Set([3, 4, 6, 8, 12])
const VALID_ROW_SPANS = new Set([1, 2, 3])

/** Load a saved layout; drops entries that no longer resolve to an available
 *  widget (module disabled, permission revoked, plan downgraded). */
export function loadSavedLayout(userId: string, available: WidgetDef[]): DashboardLayout | null {
  if (!userId) return null
  try {
    let raw = localStorage.getItem(layoutKey(userId))
    if (!raw) {
      // one-time migration from the v2 key (pre-rowSpan layouts)
      const legacy = localStorage.getItem(legacyLayoutKey(userId))
      if (legacy) {
        raw = legacy
        try { localStorage.setItem(layoutKey(userId), legacy) } catch { /* private mode */ }
      }
    }
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || !Array.isArray(parsed.widgets)) return null
    const ids = new Set(available.map((d) => d.id))
    const widgets = (parsed.widgets as any[])
      .filter((w) => w && typeof w.id === "string" && VALID_SIZES.has(w.size) && ids.has(w.id))
      .map((w) => ({
        id: w.id as string,
        size: w.size as 3 | 4 | 6 | 8 | 12,
        ...(VALID_ROW_SPANS.has(w.rowSpan) && w.rowSpan > 1 ? { rowSpan: w.rowSpan as 2 | 3 } : {}),
      }))
    if (widgets.length === 0) return null
    return { widgets }
  } catch {
    return null
  }
}

export function persistLayout(userId: string, layout: DashboardLayout): void {
  if (!userId) return
  try {
    localStorage.setItem(layoutKey(userId), JSON.stringify(layout))
  } catch { /* private mode */ }
}

export function clearSavedLayout(userId: string): void {
  if (!userId) return
  try {
    localStorage.removeItem(layoutKey(userId))
  } catch { /* private mode */ }
}

export const DASHBOARD_ICON = LayoutDashboard
