// ============ M-08 — single source of truth for module visibility ============
// `moduleOf` in app-shell.tsx and MODULE_OF in search-index.ts used to be two
// hand-maintained copies that drifted (missing procurement/inventory/ait/
// devices/shifts/advances/payslip/bonus meant those modules could never be
// hidden and never appeared in module-scoped search). Both now derive from
// this shared constant.
export const MODULES = [
  "dashboard", "calendar", "employees", "employeeDocs", "organization",
  "attendance", "devices", "shifts", "leave", "overtime",
  "payroll", "ait", "bonus", "payslip", "loans", "advances",
  "expenses", "procurement", "inventory", "performance", "tasks",
  "approvals", "notifications", "announcements", "communication",
  "letters", "exit", "ess", "reports", "analytics", "audit", "settings",
  "camera",
  // Wave 2 (2026-10-08) — Job Queue Center (WP-A)
  "jobs",
  // Wave 2 (2026-10-08): WP-K assets · WP-M fieldforce · WP-P recruitment · WP-E accounting
  "assets", "fieldforce", "recruitment", "accounting",
  // Wave 2 WP-H — billing portal
  "billing",
  // Wave 4 (2026-10-08) — AI assist (NL report queries, anomalies, resume screen)
  "ai",
  // Wave 4 (2026-10-08) — API keys + webhooks (admin settings surface)
  "integrations",
] as const

export type ModuleKey = (typeof MODULES)[number]

/** view key → module key (used by nav visibility AND search indexing). */
export const MODULE_OF: Record<string, string> = {
  dashboard: "dashboard",
  calendar: "calendar",
  employees: "employees",
  lifecycle: "employees",
  orgchart: "employees",
  organization: "organization",
  attendance: "attendance",
  overtime: "attendance",
  // 2026-10-14 — the split menus map to their modules: Shifts → shifts
  // (existing module), Field & Security → attendance (its tabs are gated by
  // tracking/geofence permissions and were part of the attendance module),
  // Devices → devices (existing module).
  shifts: "shifts",
  fieldsecurity: "attendance",
  devices: "devices",
  leave: "leave",
  payroll: "payroll",
  bonuses: "bonus",
  deductions: "payroll",
  pf: "payroll",
  ait: "ait",
  loans: "loans",
  advances: "advances",
  expenses: "expenses",
  reimbursements: "expenses",
  procurement: "procurement",
  inventory: "inventory",
  performance: "performance",
  tasks: "tasks",
  approvals: "approvals",
  notifications: "notifications",
  announcements: "announcements",
  communication: "communication",
  documents: "letters",
  exit: "exit",
  ess: "ess",
  reports: "reports",
  analytics: "analytics",
  audit: "audit",
  settings: "settings",
  cameras: "camera",
  // SaaS layer — the tenant's own subscription view (platform info, not an HR module)
  subscription: "subscription",
  // Wave 2 WP-A — Job Queue Center
  jobs: "jobs",
  // Wave 2: new modules
  assets: "assets",
  fieldforce: "fieldforce",
  recruitment: "recruitment",
  accounting: "accounting",
  "acc-coa": "accounting",
  "acc-vouchers": "accounting",
  "acc-approvals": "accounting",
  "acc-statements": "accounting",
  "acc-controls": "accounting",
  billing: "billing",
  // Wave 4 (2026-10-08)
  aiassist: "ai",
}

/** M-21 — one shared hidden-modules resolver for the shell AND global search.
 *  The settings group stores DISABLED module keys under `modules.disabled`
 *  (renamed from the misnamed `enabled`, which also stored disabled keys);
 *  the legacy key is read once so pre-rename deployments keep their config.
 *  global-search previously read ONLY the legacy `enabled` key, so modules
 *  hidden by an admin after the rename stayed searchable. */
export function hiddenModulesOf(settings: any): Set<string> {
  const disabled = (settings?.modules?.disabled as string[]) ?? (settings?.modules?.enabled as string[]) ?? []
  return new Set<string>(disabled)
}

/** WP-D (2026-10-08) — client mirror of the server's MODULE_FEATURE_GATES
 *  (src/hrm-server/saas/entitlements.ts): HRM module key → plan feature key.
 *  Modules NOT listed are core (available to every operating tenant).
 *  Previously a private copy inside app-shell.tsx; now shared so the Module
 *  Visibility settings (settings.tsx) can split plan-covered modules from
 *  plan-excluded ones with the SAME precedence the shell enforces. */
export const SAAS_GATED_MODULE_FEATURE: Record<string, string> = {
  payroll: "PAYROLL", payslip: "PAYROLL", loans: "PAYROLL", advances: "PAYROLL",
  expenses: "PAYROLL", bonus: "PAYROLL", accounting: "PAYROLL",
  ait: "AIT", inventory: "INVENTORY", procurement: "PROCUREMENT",
  performance: "PERFORMANCE", kpi: "PERFORMANCE",
  camera: "CAMERA", tracking: "TRACKING", geofence: "GEOFENCE", ess: "ESS",
  // 2026-10 module-consistency round — ADVANCED_REPORTS now gates analytics
  // (server-side MODULE_FEATURE_GATES gained the same entry).
  analytics: "ADVANCED_REPORTS",
  // ---- Wave 2 (2026-10-08) ----
  assets: "INVENTORY",
  fieldforce: "FIELD_FORCE",
}

/** WP-D — does the tenant's CURRENT plan cover this module?
 *  Mirrors featureBlocked() precedence: explicit per-tenant override wins,
 *  then the plan feature gate. LEGACY tenants cover everything. */
export function moduleCoveredByPlan(
  moduleKey: string,
  subscription: { mode?: string; features?: Record<string, boolean> | null; overrides?: Record<string, boolean> | null } | null | undefined,
): boolean {
  if (!subscription || subscription.mode !== "SUBSCRIBED") return true // LEGACY / not resolved yet
  // explicit per-tenant override wins (both directions), exactly like the server
  if (subscription.overrides && typeof subscription.overrides[moduleKey] === "boolean") {
    return subscription.overrides[moduleKey]
  }
  const gate = SAAS_GATED_MODULE_FEATURE[moduleKey]
  if (!gate) return true // core module — no plan flag
  if (!subscription.features) return true // features unresolved — don't over-hide
  return subscription.features[gate] !== false
}
