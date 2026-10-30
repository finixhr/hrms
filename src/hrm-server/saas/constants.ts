// ============ SaaS platform constants: owner RBAC, feature keys, module gates ============
// This is the SINGLE source of truth for the platform plane's permission
// vocabulary. It intentionally does NOT import from ../types (tenant RBAC) —
// the two planes keep separate vocabularies so a tenant permission string can
// never be confused with an owner permission string (audit requirement §31).

// ---- Owner roles ------------------------------------------------------------
export type OwnerRoleKey = "SUPER_ADMIN" | "ADMINISTRATOR" | "SALES_MANAGER" | "BILLING_MANAGER" | "SUPPORT_MANAGER"

export const OWNER_ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: "SaaS Super Admin",
  ADMINISTRATOR: "SaaS Administrator",
  SALES_MANAGER: "Sales / Registration Manager",
  BILLING_MANAGER: "Billing Manager",
  SUPPORT_MANAGER: "Support Manager",
}

// ---- Owner permission vocabulary (granular, dot-namespaced like the tenant RBAC,
//      but under owner.* so grep can prove the planes never cross) ------------
export const OWNER_PERMISSIONS = [
  "dashboard.view",
  "registrations.view",
  "registrations.manage", // review notes, under-review, request-info
  "registrations.approve",
  "registrations.reject",
  "tenants.view",
  "tenants.manage", // suspend/reactivate/overrides/change plan
  "plans.view",
  "plans.manage",
  "subscriptions.view",
  "subscriptions.manage", // extend/upgrade/downgrade/cycle/grace
  "billing.view",
  "billing.manage", // invoices + record payments
  "inquiries.view",
  "inquiries.manage",
  "users.view",
  "users.manage", // owner users CRUD
  "roles.view", // Roles & Permissions: view role list + details
  "roles.manage", // Roles & Permissions: create/edit/assign perms/activate/delete
  "audit.view",
  "settings.view",
  "settings.manage",
  "cms.view", // website CMS: read pages/features/clients/testimonials/media
  "cms.manage", // website CMS: write/publish everything
  // ---- Wave 2 WP-N (2026-10-08) — System Health console ----
  "health.view", // read the health snapshot (cards + drill-downs)
  "health.manage", // manual test actions (send test email/SMS, clear caches)
  // ---- R11 (2026-10-12) — SaaS Owner Communication console ----
  "communication.view", // campaigns, templates, delivery logs, audience preview
  "communication.manage", // create/edit/send/schedule campaigns + templates
  // ---- 2026-10-25 Support Center (Part A §3.1 + Part B §4.1) — the support
  // desk's READ family. FIX (2026-10-26): support-center-routes.ts registers
  // owner.supportTickets.* / owner.supportLive.* / owner.supportTickets.overview
  // with perm:"support.view", but this key was MISSING from the vocabulary —
  // every owner user (incl. SUPER_ADMIN, whose set is [...OWNER_PERMISSIONS])
  // hit "Permission denied: support.view is not granted to your role" on the
  // Owner Console → Support Access tabs 1-2. ----
  "support.view", // read + work the ticket queue & live-support review queue
  // ---- Wave 10 (2026-10-24) — Time-Limited Support Access (master prompt §2) ----
  "support.access", // start/end OWN support sessions, live board, history
  "support.manage", // revoke ANY session, edit the platform policy, and the
  // additional approval required to mint a CONTROLLED_WRITE authorization
] as const
export type OwnerPermission = (typeof OWNER_PERMISSIONS)[number]

/** Logical permission groups for the Roles & Permissions console UI —
 *  presentation only; the server always validates against the flat
 *  OWNER_PERMISSIONS vocabulary. */
export const OWNER_PERMISSION_GROUPS: { key: string; label: string; perms: string[] }[] = [
  { key: "dashboard", label: "Dashboard", perms: ["dashboard.view"] },
  {
    key: "registrations",
    label: "Registration Applications",
    perms: ["registrations.view", "registrations.manage", "registrations.approve", "registrations.reject"],
  },
  {
    key: "tenants",
    label: "Tenants",
    perms: ["tenants.view", "tenants.manage"],
  },
  {
    key: "plans",
    label: "Plans & Subscriptions",
    perms: ["plans.view", "plans.manage", "subscriptions.view", "subscriptions.manage"],
  },
  {
    key: "billing",
    label: "Billing",
    perms: ["billing.view", "billing.manage"],
  },
  {
    key: "inquiries",
    label: "Inquiries",
    perms: ["inquiries.view", "inquiries.manage"],
  },
  {
    key: "access",
    label: "Users, Roles & Audit",
    perms: ["users.view", "users.manage", "roles.view", "roles.manage", "audit.view"],
  },
  {
    key: "settings",
    label: "Platform Settings",
    perms: ["settings.view", "settings.manage"],
  },
  {
    key: "cms",
    label: "Website Studio (CMS)",
    perms: ["cms.view", "cms.manage"],
  },
  {
    key: "communication",
    label: "Communication (Campaigns)",
    perms: ["communication.view", "communication.manage"],
  },
  {
    key: "health",
    label: "System Health",
    perms: ["health.view", "health.manage"],
  },
  {
    key: "support",
    label: "Support Desk (Tickets & Time-Limited Access)",
    perms: ["support.view", "support.access", "support.manage"],
  },
]

const allOwner = (...list: OwnerPermission[]) => [...list]

export const OWNER_ROLE_TEMPLATES: Record<OwnerRoleKey, string[]> = {
  SUPER_ADMIN: [...OWNER_PERMISSIONS],
  ADMINISTRATOR: allOwner(
    "dashboard.view",
    "registrations.view", "registrations.manage", "registrations.approve", "registrations.reject",
    "tenants.view", "tenants.manage",
    "plans.view", "plans.manage",
    "subscriptions.view", "subscriptions.manage",
    "billing.view", "billing.manage",
    "inquiries.view", "inquiries.manage",
    "users.view",
    "roles.view", "roles.manage",
    "audit.view",
    "settings.view", "settings.manage",
    "cms.view", "cms.manage",
    "communication.view", "communication.manage",
    "health.view",
    "support.view", "support.access", "support.manage",
  ),
  SALES_MANAGER: allOwner(
    "dashboard.view",
    "registrations.view", "registrations.manage", "registrations.approve", "registrations.reject",
    "tenants.view",
    "plans.view",
    "inquiries.view", "inquiries.manage",
    "communication.view", "communication.manage",
    "audit.view",
  ),
  BILLING_MANAGER: allOwner(
    "dashboard.view",
    "tenants.view",
    "plans.view",
    "subscriptions.view", "subscriptions.manage",
    "billing.view", "billing.manage",
    "audit.view",
  ),
  SUPPORT_MANAGER: allOwner(
    "dashboard.view",
    "tenants.view",
    "subscriptions.view",
    "inquiries.view", "inquiries.manage",
    "audit.view",
    "cms.view",
    "health.view",
    // ---- Wave 10 (2026-10-24) — the support desk's OWN permission family ----
    "support.view", // ticket queue + live-support review queue (2026-10-26 fix)
    "support.access", // start/end own time-limited sessions + live board
  ),
}

// ---- Feature entitlement keys (what a plan can unlock) -----------------------
// Mirrors the HRM module keys they gate — see entitlements.moduleGates for the
// mapping. Keep in sync with the SaaSPlan *Enabled columns.
export const FEATURE_KEYS = [
  "PAYROLL", "AIT", "INVENTORY", "PROCUREMENT", "PERFORMANCE", "ESS",
  "CAMERA", "TRACKING", "GEOFENCE", "API", "ADVANCED_REPORTS",
  // ---- Wave 2 WP-M (2026-10-08) — Field Force premium feature ----
  "FIELD_FORCE",
] as const
export type FeatureKey = (typeof FEATURE_KEYS)[number]

export const FEATURE_LABELS: Record<string, string> = {
  PAYROLL: "Payroll & Finance",
  AIT: "AIT / Income Tax",
  INVENTORY: "Stock Inventory",
  PROCUREMENT: "Requisition & Purchase",
  PERFORMANCE: "Performance & KPI",
  ESS: "Employee Self-Service",
  CAMERA: "Camera Manager",
  TRACKING: "Live Employee Tracking",
  GEOFENCE: "Geo-Fence",
  API: "API Access",
  ADVANCED_REPORTS: "Advanced Reports & Analytics",
  FIELD_FORCE: "Field Force Management",
}

// ---- Authoritative tenant-module catalog -------------------------------------
// ONE list describing every HRM workspace module a tenant can have, derived
// from src/hrm/module-map.ts MODULES (+ the tracking/geofence/kpi/accounting
// sub-modules the entitlement engine gates). Four surfaces MUST stay aligned
// with it: (1) the SaaS Owner Console per-tenant override dialog, (2) the
// website registration module wish-list, (3) the website feature pages/grid,
// (4) the tenant navigation (module-map.ts). `feature` (when present) is the
// plan entitlement that unlocks the module; core modules have no plan flag
// but are still individually controllable through per-tenant overrides
// (SaaS Owner Console → Tenants → Overrides) and tenant-side module
// visibility (Settings → Localization & Branding → Modules).
export type TenantModuleDef = {
  key: string
  label: string
  /** Plan feature key that gates this module (undefined = core). */
  feature?: FeatureKey
}

export const TENANT_MODULES: TenantModuleDef[] = [
  // -- core workspace (no plan flag; override-controllable) --
  { key: "dashboard", label: "HR Dashboard" },
  { key: "calendar", label: "Company Calendar" },
  { key: "employees", label: "Employee Management" },
  { key: "employeeDocs", label: "Employee Documents" },
  { key: "organization", label: "Branches & Departments" },
  { key: "attendance", label: "Attendance" },
  { key: "devices", label: "Attendance Devices" },
  { key: "shifts", label: "Shifts & Rosters" },
  { key: "leave", label: "Leave Management" },
  { key: "overtime", label: "Overtime Management" },
  { key: "tasks", label: "Task Management" },
  { key: "approvals", label: "Approval Queue" },
  { key: "notifications", label: "Notification Center" },
  { key: "announcements", label: "Announcements" },
  { key: "communication", label: "Email & SMS Center" },
  { key: "letters", label: "HR Letters" },
  { key: "exit", label: "Exit Management" },
  { key: "reports", label: "HR Reports" },
  { key: "analytics", label: "HR Analytics" },
  { key: "audit", label: "Audit Trail" },
  { key: "settings", label: "HR Settings" },
  // -- Wave 2 (2026-10-08) modules --
  { key: "jobs", label: "Job Queue Center" },
  // -- Wave 2 (2026-10-08) new modules --
  { key: "assets", label: "Asset Management", feature: "INVENTORY" },
  { key: "fieldforce", label: "Field Force", feature: "FIELD_FORCE" },
  { key: "recruitment", label: "Recruitment" },
  // -- plan-gated modules --
  { key: "payroll", label: "Payroll", feature: "PAYROLL" },
  { key: "payslip", label: "Payslips", feature: "PAYROLL" },
  { key: "loans", label: "Loans", feature: "PAYROLL" },
  { key: "advances", label: "Advances", feature: "PAYROLL" },
  { key: "expenses", label: "Expense Claims", feature: "PAYROLL" },
  { key: "bonus", label: "Bonus", feature: "PAYROLL" },
  { key: "accounting", label: "Accounting Journals", feature: "PAYROLL" },
  { key: "ait", label: "AIT / Income Tax", feature: "AIT" },
  { key: "inventory", label: "Stock Inventory", feature: "INVENTORY" },
  { key: "procurement", label: "Requisition & Purchase", feature: "PROCUREMENT" },
  { key: "performance", label: "Performance & KPI", feature: "PERFORMANCE" },
  { key: "kpi", label: "KPI Engine", feature: "PERFORMANCE" },
  { key: "camera", label: "Camera Manager", feature: "CAMERA" },
  { key: "tracking", label: "Live Employee Tracking", feature: "TRACKING" },
  { key: "geofence", label: "Geo-Fence", feature: "GEOFENCE" },
  { key: "ess", label: "Employee Self-Service", feature: "ESS" },
  // ---- Wave R3-3 (SUB-101) — API & webhooks are now a real plan-gated,
  // owner-overridable module (previously absent: the SaaS Owner Console could
  // not toggle the REST API for a single tenant). ----
  { key: "integrations", label: "API & Webhooks", feature: "API" },
]

/** Module keys that a plan feature flag can gate (derived, never hand-copied). */
export const TENANT_MODULE_KEYS: string[] = TENANT_MODULES.map((m) => m.key)
export const TENANT_MODULE_BY_KEY: Record<string, TenantModuleDef> = Object.fromEntries(
  TENANT_MODULES.map((m) => [m.key, m]),
)

// ---- Resource limit keys -----------------------------------------------------
export const LIMIT_KEYS = [
  "EMPLOYEES", "USERS", "BRANCHES", "DEPARTMENTS", "DEVICES", "STORAGE", "TRACKING_EMPLOYEES",
] as const
export type LimitKey = (typeof LIMIT_KEYS)[number]

export const LIMIT_LABELS: Record<string, string> = {
  EMPLOYEES: "Active employees",
  USERS: "Application users",
  BRANCHES: "Branches",
  DEPARTMENTS: "Departments",
  DEVICES: "Attendance devices",
  STORAGE: "Storage quota (GB)",
  TRACKING_EMPLOYEES: "Live-tracking employees",
}

// Human labels for the registration "requirements" checkboxes (the full
// module wish-list shown on the public form; keys map to FEATURE_KEYS /
// TENANT_MODULES keys). The chosen plan + per-tenant overrides decide what is
// ACTUALLY enabled — this list only captures what the prospect is interested in.
export const REGISTRATION_MODULES: { key: string; label: string }[] = [
  { key: "EMPLOYEES", label: "Employee Management" },
  { key: "ATTENDANCE", label: "Attendance & Shifts" },
  { key: "DEVICES", label: "ZKTeco / Attendance Devices" },
  { key: "LEAVE", label: "Leave Management" },
  { key: "OVERTIME", label: "Overtime Management" },
  { key: "PAYROLL", label: "Payroll & Payslips" },
  { key: "AIT", label: "AIT / Income Tax" },
  { key: "LOANS", label: "Loans & Advances" },
  { key: "EXPENSES", label: "Expense Claims" },
  { key: "TRACKING", label: "Live Tracking" },
  { key: "GEOFENCE", label: "Geo-Fencing" },
  { key: "INVENTORY", label: "Inventory" },
  { key: "PROCUREMENT", label: "Procurement" },
  { key: "PERFORMANCE", label: "Performance & KPI" },
  { key: "TASKS", label: "Task Management" },
  { key: "APPROVALS", label: "Approval Workflows" },
  { key: "COMMUNICATION", label: "Email & SMS Center" },
  { key: "LETTERS", label: "HR Letters" },
  { key: "EXIT", label: "Exit & Offboarding" },
  { key: "CALENDAR", label: "Company Calendar" },
  { key: "REPORTS", label: "Reports & Analytics" },
  { key: "CAMERA", label: "Camera Integration" },
  { key: "ESS", label: "Employee Self-Service" },
  // ---- Wave 2 (2026-10-08) ----
  { key: "ASSETS", label: "Asset Management" },
  { key: "FIELD_FORCE", label: "Field Force Visits" },
  { key: "RECRUITMENT", label: "Recruitment & Careers" },
  { key: "ACCOUNTING", label: "Accounting & Vouchers" },
]

export const BILLING_CYCLES = ["MONTHLY", "YEARLY"] as const
export type BillingCycle = (typeof BILLING_CYCLES)[number]

// ---- Subscription statuses ----------------------------------------------------
// PENDING_PAYMENT (2026-10-25, master prompt Part F) — a newly provisioned
// tenant on a PAID plan that has not completed its first verified payment.
// The workspace is fully LOCKED except auth/billing/subscription/support.
// A trial plan (deliberately authorized free entitlement) provisions as TRIAL.
export const SUBSCRIPTION_STATUSES = [
  "PENDING_PAYMENT", "TRIAL", "ACTIVE", "PAST_DUE", "GRACE_PERIOD", "EXPIRED", "SUSPENDED", "CANCELLED",
] as const
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number]

/** Statuses that permit full tenant operation. PAST_DUE keeps the tenant
 *  usable (owner is chasing payment) but is flagged in the owner console;
 *  GRACE_PERIOD keeps read+write during the negotiated window. */
export const OPERATING_STATUSES: string[] = ["TRIAL", "ACTIVE", "PAST_DUE", "GRACE_PERIOD"]
/** Statuses that lock the tenant into read-only (mutations denied). */
export const READONLY_STATUSES: string[] = ["EXPIRED", "SUSPENDED", "CANCELLED"]
/** Statuses that lock the tenant out of the HR modules ENTIRELY (reads too)
 *  — only auth / billing / subscription / support / payment-return surfaces
 *  stay reachable (master prompt §10: an unpaid tenant never touches HR data). */
export const LOCKED_STATUSES: string[] = ["PENDING_PAYMENT"]

// ---- Custom plan billing modes (master prompt Part G §12.1) --------------------
export const BILLING_MODES = ["RECURRING", "ONE_TIME"] as const
export type BillingMode = (typeof BILLING_MODES)[number]

// ---- Registration statuses ----------------------------------------------------
export const REGISTRATION_STATUSES = [
  "PENDING", "UNDER_REVIEW", "APPROVED", "REJECTED", "SUSPENDED", "CANCELLED",
] as const
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number]

export const REGISTRATION_STATUS_FLOW: Record<string, string[]> = {
  PENDING: ["UNDER_REVIEW", "APPROVED", "REJECTED", "CANCELLED"],
  UNDER_REVIEW: ["PENDING", "APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: ["SUSPENDED"],
  REJECTED: ["PENDING"], // allow re-opening a rejected application
  SUSPENDED: ["APPROVED", "CANCELLED"],
  CANCELLED: [],
}
