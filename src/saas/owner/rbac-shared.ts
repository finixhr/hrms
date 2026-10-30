// Client-safe re-export of the owner role labels + permission vocabulary
// (no server imports). The authoritative copy lives in
// src/hrm-server/saas/constants.ts; this file exists so client pages never
// import server code. Keep in sync — the server validates against its own copy.
export const OWNER_ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: "SaaS Super Admin",
  ADMINISTRATOR: "SaaS Administrator",
  SALES_MANAGER: "Sales / Registration Manager",
  BILLING_MANAGER: "Billing Manager",
  SUPPORT_MANAGER: "Support Manager",
}

export const OWNER_PERMISSION_LABELS: Record<string, string> = {
  "dashboard.view": "View dashboard",
  "registrations.view": "View registration applications",
  "registrations.manage": "Manage applications (review notes, status)",
  "registrations.approve": "Approve & provision applications",
  "registrations.reject": "Reject applications",
  "tenants.view": "View tenants",
  "tenants.manage": "Manage tenants (suspend, overrides, plan changes)",
  "plans.view": "View plans",
  "plans.manage": "Create / edit plans",
  "subscriptions.view": "View subscriptions",
  "subscriptions.manage": "Manage subscriptions (extend, upgrade, grace)",
  "billing.view": "View invoices & payments",
  "billing.manage": "Create invoices, record payments",
  "inquiries.view": "View inquiries",
  "inquiries.manage": "Handle inquiries",
  "users.view": "View owner users",
  "users.manage": "Create / edit owner users",
  "roles.view": "View roles & permissions",
  "roles.manage": "Create / edit roles, assign permissions",
  "audit.view": "View platform audit log",
  "settings.view": "View platform settings",
  "settings.manage": "Edit platform settings & gateway",
  "cms.view": "View website CMS content",
  "cms.manage": "Edit & publish website CMS",
  // ---- 2026-10-26 sync with server OWNER_PERMISSIONS (was stale: the Roles
  // console could not display or grant these families at all) ----
  "communication.view": "View campaigns, templates & delivery logs",
  "communication.manage": "Create / send / schedule campaigns & templates",
  "health.view": "View system health",
  "health.manage": "Run health test actions (test email/SMS, clear caches)",
  "support.view": "Work support tickets & live support requests",
  "support.access": "Start / join time-limited support sessions",
  "support.manage": "Approve live access, revoke sessions, edit support policy",
}

/** Logical permission groups (mirrors OWNER_PERMISSION_GROUPS on the server —
 *  presentation only). */
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
