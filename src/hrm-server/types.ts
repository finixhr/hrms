// ============ Finix HR — shared types, permissions, role templates ============

export type RoleKey =
  | "HR_ADMIN"
  | "HR_MANAGER"
  | "PAYROLL_OFFICER"
  | "BRANCH_MANAGER"
  | "DEPT_MANAGER"
  | "EMPLOYEE"
  | "VENDOR_OWNER"
  // ---- Wave 10 (2026-10-24) — synthetic role for Time-Limited Support
  // Access sessions. Matches NO special-cased role anywhere in the codebase
  // → deny-by-default in every in-handler role check; reachability is decided
  // per-action by supportAccessActionAllowed() at the dispatcher gate.
  | "SUPPORT"

export const ROLE_LABELS: Record<string, string> = {
  HR_ADMIN: "HR Admin",
  HR_MANAGER: "HR Manager",
  PAYROLL_OFFICER: "Payroll Officer",
  BRANCH_MANAGER: "Branch Manager",
  DEPT_MANAGER: "Department Manager",
  EMPLOYEE: "Employee (Self-Service)",
  VENDOR_OWNER: "Vendor Owner",
  SUPPORT: "Platform Support (Time-Limited)",
}

// Modules and action-level permissions (spec §3.2)
export const ACTIONS = [
  "view", "create", "edit", "delete", "approve", "reject", "generate",
  "process", "calculate", "pay", "export", "download", "upload", "verify", "assign",
  // EMP-10 (R5) — hard delete (irreversible purge) is a SEPARATE verb from
  // soft archive: employees.purge must be granted explicitly.
  "purge",
  // ---- Wave 4 (2026-10-08) — pinned report templates + scheduled delivery ----
  "schedule",
  // ---- Post-release fix (2026-10-08, CHANGES §9) — camera/integration verbs ----
  // "launch" and "manage" are real permission verbs used by live routes
  // (camera.launch, camera.manage, tracking.manage, jobs.manage, billing.manage)
  // and granted by ROLE_TEMPLATES — but they were missing from this catalog.
  // Three silent-failure sites depended on MODULES × ACTIONS:
  //   1. normalizePermissions (routes/admin.ts roles.save) STRIPPED them from
  //      every saved role override — editing the Vendor Owner role and saving
  //      "all permissions" actually removed camera.launch/camera.manage;
  //   2. the Settings → Roles & Permissions matrix could never display or
  //      grant them (invisible columns);
  //   3. provisionTenant + seed-owner wrote owner explicit-permission sets as
  //      MODULES × ACTIONS — every registration-provisioned tenant's Vendor
  //      Owner lacked them (explicit sets override the role template in
  //      auth.ts getCtxFromToken).
  "launch", "manage",
  // ---- Wave R3-3 (2026-10-17) — security/privacy verbs ----
  // "reveal" — lifts server-side field masking for the sensitive fields it is
  //   attached to (employeeDocs.reveal: full NID/passport/doc numbers).
  // "pii" — authorizes bulk-PII surfaces (reports.pii: biodata CSV/XLSX
  //   export + PII-class report scheduling). Without the verb in this catalog
  //   the HIGH-11 reports.pii gate was DEAD: normalizePermissions stripped it
  //   from every role, so nobody could ever hold it.
  "reveal", "pii",
] as const
export type ActionType = (typeof ACTIONS)[number]

export const MODULES = [
  "dashboard", "calendar", "employees", "employeeDocs", "bankInfo", "organization",
  "attendance", "devices", "shifts", "leave", "payroll", "ait", "bonus", "payslip",
  "loans", "advances", "expenses", "performance", "kpi", "tasks",
  "approvals", "notifications", "announcements", "communication", "letters", "exit",
  "procurement", "inventory", "pf",
  "ess", "reports", "analytics", "audit", "settings", "accounting",
  // ---- Phase 3 (Camera Manager §7) — singular per kickoff item 7 ----
  "camera",
  // ---- 2026-10 round (§58) — live tracking + geo-fence management ----
  "tracking", "geofence",
  // ---- 2026-10-07 — SaaS plan view is now a grantable permission ----
  "subscription",
  // ---- Wave 2 WP-A (2026-10-08) — Job Queue Center ----
  "jobs",
  // ---- Wave 2 (2026-10-08): WP-K assets · WP-M fieldforce · WP-P recruitment ----
  "assets", "fieldforce", "recruitment",
  // ---- Wave 2 WP-H — tenant self-service billing portal ----
  "billing",
  // ---- 2026-10-25 — Support Center (master prompt Part A): tickets + chat +
  // Live Support Access requests. view-only family (support.view gates all
  // support.* routes — the ticket system is conversational, not CRUD-heavy).
  "support",
  // ---- Wave 4 (2026-10-08) — public REST API keys + outbound webhooks ----
  "integrations",
  // ---- Wave 4 (2026-10-08) — AI assist (NL report queries, anomalies, resume screen) ----
  "ai",
  // ---- Wave R3-3 (2026-10-17) — user & role administration (RBAC-104) ----
  // Splits the old single settings.edit full-escalation key: managing user
  // accounts and role definitions is its own permission family. users.edit
  // gates users.save/roles.save; users.delete gates users.delete; users.view
  // keeps the Settings → Users tab readable for managers without granting
  // any privilege escalation.
  "users",
] as const
export type ModuleKey = (typeof MODULES)[number]

export const MODULE_LABELS: Record<string, string> = {
  dashboard: "HR Dashboard", calendar: "HR Calendar", employees: "Employees",
  employeeDocs: "Employee Documents", bankInfo: "Bank Information", organization: "Organization",
  attendance: "Attendance", devices: "Attendance Devices", shifts: "Shifts & Roster", leave: "Leave",
  payroll: "Payroll", ait: "AIT / Tax", bonus: "Bonus & Commission", payslip: "Payslips",
  loans: "Loans", advances: "Advances", expenses: "Expenses", performance: "Performance",
  kpi: "KPI", tasks: "Tasks", approvals: "Approvals", notifications: "Notifications",
  announcements: "Announcements", communication: "Communication Center", letters: "HR Letters", exit: "Resignation & Exit",
  procurement: "Requisition & Purchase", inventory: "Stock Inventory", pf: "Provident Fund",
  ess: "Self-Service", reports: "Reports", analytics: "HR Analytics",
  audit: "Audit Trail", settings: "HR Settings", accounting: "Accounting Integration",
  // ---- Phase 3 (Camera Manager) ----
  camera: "Camera Manager",
  // ---- 2026-10 round (§58) ----
  tracking: "Live Tracking", geofence: "Geo-Fence",
  // ---- 2026-10-07 ----
  subscription: "Subscription & Usage",
  // ---- Wave 2 WP-A ----
  jobs: "Job Queue Center",
  // ---- Wave 2: WP-K / WP-M / WP-P ----
  assets: "Asset Management",
  fieldforce: "Field Force",
  recruitment: "Recruitment",
  billing: "Billing",
  support: "Support Center",
  // ---- Wave 4 (2026-10-08) ----
  integrations: "API & Webhooks",
  ai: "AI Assist",
  // ---- Wave R3-3 (2026-10-17) ----
  users: "Users & Roles",
}

export type Ctx = {
  userId: string
  userName: string
  vendorId: string
  role: RoleKey
  permissions: Set<string>
  employeeId?: string | null
  branchId?: string | null
  departmentId?: string | null
  ip?: string
  /** C-4 — CSRF token bound to the caller's session (cookie-authenticated calls must echo it). */
  csrfToken?: string
  /** Wave 10 (2026-10-24) — present ONLY on time-limited support sessions
   *  (the third session plane, saas_support_session cookie). Drives the
   *  persistent tenant-side SUPPORT ACCESS banner + auth.supportExit, and
   *  gates every action through supportAccessActionAllowed(). */
  supportSession?: {
    id: string
    tenantName: string
    operatorName: string
    accessMode: "READ_ONLY" | "CONTROLLED_WRITE"
    expiresAt: string
    /** approved module scope — tenant-initiated Live Support sessions (§4.3);
     *  empty/undefined = full read surface (owner-initiated sessions). */
    modules?: string[]
    /** originating SaasLiveSupportRequest id (tenant-initiated sessions) */
    requestId?: string
  }
}

// ---------- Role permission templates ----------
const all = (m: string, acts: string[]) => acts.map((a) => `${m}.${a}`)
const basic = (m: string) => [`${m}.view`]

/** Full tenant-administration set. Shared by HR_ADMIN and VENDOR_OWNER:
 * the vendor owner IS the top authority of their own tenant — the app's
 * whole purpose is letting platform vendors manage their teams, so the
 * owner role carries the complete HR/organization/payroll toolkit
 * (scoped to their own vendorId by the RBAC layer at every query). */
const TENANT_ADMIN_PERMS = [
  ...all("dashboard", ["view"]),
  ...all("calendar", ["view"]),
  // EMP-10 (R5) — employees.purge rides the admin templates so current admins
  // keep hard-delete; HR_MANAGER/BRANCH_MANAGER never carried employees.delete
  // and stay without purge.
  ...all("employees", ["view", "create", "edit", "delete", "export", "assign", "purge"]),
  ...all("employeeDocs", ["view", "upload", "edit", "download", "delete", "verify"]),
  // ---- Wave R3-3 (FLD-102) — full identity numbers are masked to last-4
  // server-side; the reveal verb lifts the mask for tenant admins.
  ...all("employeeDocs", ["reveal"]),
  ...all("bankInfo", ["view", "edit", "verify"]),
  ...all("organization", ["view", "create", "edit", "delete"]),
  ...all("attendance", ["view", "create", "edit", "process", "export", "verify", "download"]),
  ...all("devices", ["view", "create", "edit", "delete", "process", "export"]),
  ...all("shifts", ["view", "create", "edit", "delete", "assign"]),
  ...all("leave", ["view", "create", "edit", "approve", "reject", "export", "assign"]),
  ...all("payroll", ["view", "create", "process", "calculate", "approve", "pay", "export", "edit"]),
  ...all("ait", ["view", "create", "edit", "calculate"]),
  ...all("bonus", ["view", "create", "edit", "approve", "reject", "calculate", "pay", "import"]),
  ...all("payslip", ["view", "generate", "download", "export"]),
  ...all("loans", ["view", "create", "approve", "reject", "pay", "export"]),
  ...all("advances", ["view", "create", "approve", "reject", "pay"]),
  ...all("expenses", ["view", "create", "approve", "reject", "pay"]),
  ...all("performance", ["view", "create", "edit", "approve"]),
  ...all("kpi", ["view", "create", "assign", "edit"]),
  ...all("tasks", ["view", "create", "edit", "delete", "assign"]),
  ...all("approvals", ["view", "approve", "reject"]),
  ...all("notifications", ["view"]),
  ...all("announcements", ["view", "create", "edit", "delete"]),
  ...all("communication", ["view", "create", "export"]),
  ...all("letters", ["view", "generate", "approve", "reject", "download", "edit"]),
  ...all("exit", ["view", "create", "approve", "reject", "process", "calculate", "pay"]),
  ...all("ess", ["view"]),
  ...all("reports", ["view", "export", "download"]),
  // ---- Wave R3-3 (RPT-001/002) — the HIGH-11 bulk-PII gate finally has a
  // grantable verb: biodata CSV/XLSX export + PII-class report scheduling.
  ...all("reports", ["pii"]),
  ...all("analytics", ["view"]),
  ...all("audit", ["view", "export"]),
  ...all("settings", ["view", "edit"]),
  ...all("accounting", ["view", "create", "export", "approve"]),
  // Wave 3 WP-B (2026-10-08) — accounting.create posts manual vouchers,
  // accounting.approve works the DRAFT→PENDING_APPROVAL→POSTED queue.
  // Auto-generated journals (payroll/loans/expenses) stay auto-POSTED.
  // Requisition & Purchase + Stock Inventory (goods flow for admins)
  ...all("procurement", ["view", "create", "edit", "approve"]),
  ...all("inventory", ["view", "create", "edit", "approve"]),
  // ---- Camera Manager (Phase 3, Camera Manager §11 confirmed table) ----
  // HR_ADMIN + VENDOR_OWNER get the full camera.* set: view, create, edit,
  // delete, launch, manage. Note the verb split: permission "camera.edit"
  // maps to audit action "camera.update" (mirrors devices.ts:178 — the
  // existing convention is permission .edit → audit .update). Other verbs
  // match 1:1. "camera.manage" gates credential rotation/deletion only in v1
  // (location CRUD stays under organization.*; bulk import + tenant-wide
  // settings deferred to v2 per Camera Manager §C3).
  ...all("camera", ["view", "create", "edit", "delete", "launch", "manage"]),
  // ---- 2026-10 round (§58) — live tracking + geo-fence management ----
  // tracking.view gates the live map / history / security event queues;
  // tracking.manage gates start/stop + policy assignment. Geo-fence CRUD is
  // its own module; attendance policies/multi-check-in/security review reuse
  // the existing attendance.* verbs (create/edit for config, verify for
  // review, assign for policy assignment) — no parallel permission family.
  ...all("tracking", ["view", "manage"]),
  ...all("geofence", ["view", "create", "edit", "delete"]),
  ...all("attendance", ["assign"]),
  // 2026-10-07 — Subscription & Usage (the tenant's plan, limits and usage)
  // is a permission like any other module: granted to management roles by
  // default, NOT to the Employee (Self-Service) role, editable per role in
  // HR Settings → Roles & Permissions.
  ...all("subscription", ["view"]),
  // Wave 2 WP-A — Job Queue Center: admin/operators get view + manage (retry /
  // cancel / requeue / recover-stale). NOT granted to the Employee
  // (Self-Service) role; every route is vendor-scoped (H-10).
  ...all("jobs", ["view", "manage"]),
  // Wave 2 WP-K — assets: register/assign/return lifecycle
  ...all("assets", ["view", "create", "edit", "delete", "assign"]),
  // Wave 2 WP-M — field force: locations, plans, board, reports
  ...all("fieldforce", ["view", "create", "edit", "delete"]),
  // Wave 2 WP-P — recruitment: openings CRUD + pipeline
  ...all("recruitment", ["view", "create", "edit", "delete"]),
  // Wave 2 WP-H — tenant self-service billing: admins/owners only (never ESS)
  ...all("billing", ["view", "manage"]),
  // 2026-10-25 — Support Center: every management role (and ESS users via
  // their own template below) can open tickets and request live support —
  // it is the tenant's help channel, including for locked/expired tenants.
  ...all("support", ["view"]),
  // Wave 3 WP-C (2026-10-08) — HR managers get read access to the Billing
  // portal (plan catalog + invoices); plan CHANGES still require
  // billing.manage (admins/owners) or a plan-change request.
  // ...granted to HR_MANAGER below via basic("billing").
  // ---- Wave 4 (2026-10-08) ----
  // Scheduled report templates: admins pin filters + email schedules.
  ...all("reports", ["schedule"]),
  // API keys + outbound webhooks: tenant-administration asset (never ESS).
  ...all("integrations", ["view", "create", "edit", "delete"]),
  // AI assist: NL report queries, attendance anomalies, resume screening.
  ...all("ai", ["view", "generate"]),
  // ---- Wave R3-3 (RBAC-104) — user & role administration split ----
  ...all("users", ["view", "create", "edit", "delete"]),
]

export const ROLE_TEMPLATES: Record<RoleKey, string[]> = {
  HR_ADMIN: [...TENANT_ADMIN_PERMS],
  HR_MANAGER: [
    ...basic("dashboard"), ...basic("calendar"),
    ...all("employees", ["view", "create", "edit", "export", "assign"]),
    ...all("employeeDocs", ["view", "upload", "edit", "download", "verify"]),
    // R3-3 — HR managers verify identity documents, so they see full numbers
    ...all("employeeDocs", ["reveal"]),
    // RBAC-102 (Wave R3-5) — bank CRUD now really rides bankInfo.edit (the
    // employees.banks.* section routes were re-gated from employees.edit).
    // HR managers legitimately maintain the payout section of the employee
    // profile, so the default template carries the verb — revoking it now
    // actually locks the section.
    ...basic("bankInfo"),
    ...all("bankInfo", ["edit"]),
    ...all("organization", ["view"]),
    ...all("attendance", ["view", "create", "edit", "export", "verify", "download"]), // L-19: verify = corrections decide (was a hardcoded role list); download = private selfie-evidence viewing (attendance.selfie.view, §26)
    ...all("devices", ["view", "create", "edit", "process"]),
    ...all("shifts", ["view", "assign"]),
    ...all("leave", ["view", "approve", "reject", "export"]),
    // payroll.edit — the client's employee 360° view already offers HR
    // managers the Set/Revise Structure dialogs (gated on employees.edit);
    // employees.createWithStructure writes the initial structure too. Without
    // payroll.edit the server denied every one of those UI actions.
    ...all("payroll", ["view", "edit", "process", "export"]),
    ...basic("ait"), ...basic("bonus"),
    ...all("payslip", ["view", "download"]),
    ...all("loans", ["view", "approve", "reject"]),
    ...all("advances", ["view", "approve", "reject"]),
    ...all("expenses", ["view", "approve", "reject"]),
    ...all("performance", ["view", "create", "edit", "approve"]),
    ...all("kpi", ["view", "assign", "edit"]),
    ...all("tasks", ["view", "create", "edit", "assign"]),
    ...all("approvals", ["view", "approve", "reject"]),
    ...basic("notifications"),
    ...all("announcements", ["view", "create", "edit"]),
    ...all("communication", ["view", "create"]),
    ...all("letters", ["view", "generate", "approve", "reject", "download"]),
    ...all("exit", ["view", "process", "approve", "reject"]),
    ...basic("ess"), ...basic("subscription"), ...basic("billing"), ...basic("support"), ...basic("jobs"), ...basic("assets"), ...basic("fieldforce"), ...basic("recruitment"), ...basic("reports"), ...basic("analytics"), ...basic("settings"),
    // Wave 3 WP-C — billing.view: HR managers see the Billing portal
    // (catalog + invoices); plan changes need billing.manage or a request.
    // Wave 4 — managers may pin report templates + schedules (reports.schedule)
    // and use AI assist reads; integration (API key/webhook) administration
    // stays admin-only.
    ...all("reports", ["schedule"]),
    ...basic("ai"),
    // R3-3 — read visibility of the user list (privilege WRITES stay with
    // users.edit holders = tenant admins)
    ...basic("users"),
    // requisition approvals + read-only stock visibility for HR
    ...all("procurement", ["view", "approve"]),
    ...basic("inventory"),
    // ---- Camera Manager (Phase 3, Camera Manager §11) ----
    // HR_MANAGER: view, create, edit, launch — NO delete (camera decommission
    // is a more sensitive admin action), NO manage (credential rotation is
    // reserved for tenant admins).
    ...all("camera", ["view", "create", "edit", "launch"]),
    // 2026-10 round — HR managers see live tracking, manage geo-fences and
    // assign attendance policies (attendance.assign reused, no new family).
    ...all("tracking", ["view"]),
    ...all("geofence", ["view", "create", "edit"]),
    ...all("attendance", ["assign"]),
  ],
  PAYROLL_OFFICER: [
    ...basic("dashboard"), ...basic("calendar"),
    ...all("employees", ["view", "export"]),
    ...all("employeeDocs", ["view"]),
    ...all("attendance", ["view", "export"]),
    ...all("devices", ["view", "export"]),
    ...all("shifts", ["view"]),
    ...all("leave", ["view", "export"]),
    ...all("payroll", ["view", "process", "calculate", "approve", "pay", "export", "edit"]),
    // 2026-10 round §54 — bank-transfer salary exports carry full account
    // details; payroll officers need bankInfo.view for the bank export sheet
    ...basic("bankInfo"),
    ...all("ait", ["view", "create", "edit", "calculate"]),
    ...all("bonus", ["view", "create", "edit", "calculate", "approve", "pay", "import"]),
    ...all("payslip", ["view", "generate", "download", "export"]),
    ...all("loans", ["view", "approve", "pay", "export"]),
    ...all("advances", ["view", "approve", "pay"]),
    ...all("expenses", ["view", "approve", "pay"]),
    ...all("approvals", ["view", "approve", "reject"]),
    ...basic("notifications"),
    ...basic("communication"),
    ...all("exit", ["view", "calculate", "pay", "process"]),
    ...basic("ess"), ...basic("subscription"), ...basic("support"), ...basic("jobs"), ...basic("assets"), ...basic("fieldforce"), ...basic("recruitment"), ...basic("reports"), ...basic("analytics"),
    ...all("accounting", ["view", "export"]),
  ],
  BRANCH_MANAGER: [
    ...basic("dashboard"), ...basic("calendar"),
    ...all("employees", ["view", "edit", "export"]),
    ...all("employeeDocs", ["view"]),
    ...all("organization", ["view"]),
    ...all("attendance", ["view", "create", "edit", "export"]),
    ...all("devices", ["view", "edit"]), // branch-scoped in routes
    ...all("shifts", ["view", "assign"]),
    ...all("leave", ["view", "approve", "reject", "export"]),
    ...all("payroll", ["view", "approve"]),
    ...basic("bonus"), ...basic("payslip"),
    ...all("loans", ["view", "approve"]),
    ...all("advances", ["view", "approve"]),
    ...all("expenses", ["view", "approve"]),
    ...all("performance", ["view", "create", "edit", "approve"]),
    ...all("kpi", ["view", "assign"]),
    ...all("tasks", ["view", "create", "edit", "assign"]),
    ...all("approvals", ["view", "approve", "reject"]),
    ...basic("notifications"),
    ...all("announcements", ["view", "create"]),
    ...all("letters", ["view", "generate", "approve", "download"]),
    ...all("exit", ["view", "process", "approve"]),
    ...basic("ess"), ...basic("subscription"), ...basic("support"), ...basic("jobs"), ...basic("assets"), ...basic("fieldforce"), ...basic("recruitment"), ...basic("reports"), ...basic("analytics"),
    ...all("procurement", ["view", "approve"]),
    // ---- Camera Manager (Phase 3, Camera Manager §11) ----
    // BRANCH_MANAGER: view + launch ONLY (branch-scoped via cameraScopeFilter
    // in src/hrm-server/cameras/repository.ts). NO create/edit/delete/manage —
    // CCTV is more sensitive than attendance terminals (the existing
    // devices.* template gives BRANCH_MANAGER view+edit; cameras get view+launch
    // only). Branch scoping is enforced server-side, not just at the UI layer.
    ...all("camera", ["view", "launch"]),
    // 2026-10 round — branch managers see live tracking + fences for THEIR
    // branch (server-side scope filters in the tracking routes).
    ...all("tracking", ["view"]),
    ...all("geofence", ["view"]),
  ],
  DEPT_MANAGER: [
    ...basic("dashboard"), ...basic("calendar"),
    ...all("employees", ["view"]),
    ...all("attendance", ["view", "export"]),
    ...all("shifts", ["view"]),
    ...all("leave", ["view", "approve", "reject"]),
    ...all("payroll", ["view", "approve"]),
    ...basic("payslip"),
    ...all("performance", ["view", "create", "edit", "approve"]),
    ...all("kpi", ["view", "assign", "edit"]),
    ...all("tasks", ["view", "create", "edit", "assign"]),
    ...all("approvals", ["view", "approve", "reject"]),
    ...basic("notifications"),
    ...all("announcements", ["view"]),
    ...all("letters", ["view", "download"]),
    ...basic("ess"), ...basic("subscription"), ...basic("support"), ...basic("jobs"), ...basic("assets"), ...basic("fieldforce"), ...basic("recruitment"), ...basic("reports"),
    // department managers approve their team's goods requisitions
    ...all("procurement", ["view", "approve"]),
    // 2026-10 round — department managers see live tracking for THEIR department
    ...all("tracking", ["view"]),
  ],
  EMPLOYEE: [
    ...basic("calendar"),
    ...all("ess", ["view", "create", "edit", "download"]),
    // self-service requests (routes enforce own-record-only for EMPLOYEE role)
    ...all("loans", ["create"]),
    ...all("advances", ["create"]),
    ...all("expenses", ["create"]),
    // own goods requisitions (server forces employeeId = caller)
    ...all("procurement", ["create"]),
    ...basic("notifications"),
    ...basic("announcements"),
    // 2026-10-25 — Support Center is available to every user, including ESS
    // employees (they may raise issues about their own self-service account).
    ...basic("support"),
  ],
  VENDOR_OWNER: [
    // The vendor owner manages their whole tenant: full HR toolkit (employees,
    // organization, attendance, payroll, leave, letters…), identical in scope
    // to HR_ADMIN and still hard-scoped to their own vendorId by the RBAC
    // layer. The previous read-only template made the app's primary user
    // unable to add or edit their own staff.
    ...TENANT_ADMIN_PERMS,
  ],
  // ---- Wave 10 (2026-10-24) — the synthetic support role carries NO template:
  // a support session's effective permissions are computed per-authorization
  // by supportPermissionsFor() (module.view read surface + the explicitly
  // scoped SUPPORT_WRITE_CATALOG) — never from this map.
  SUPPORT: [],
}

export const APPROVAL_PROCESS_TYPES = [
  "LEAVE", "LOAN", "ADVANCE", "EXPENSE", "PAYROLL", "LETTER", "RESIGNATION",
] as const

export const PAYROLL_STATUS_FLOW = [
  "DRAFT", "CALCULATED", "HR_REVIEW", "MANAGER_APPROVAL", "ACCOUNTING_APPROVAL",
  "APPROVED", "PROCESSING", "PAID",
  // R1 — terminal state reachable from any non-CANCELLED status via
  // payroll.runs.cancel; the month can then be re-created as a fresh run.
  "CANCELLED",
] as const

export const EMPLOYMENT_TYPES = [
  "PERMANENT", "PROBATIONARY", "CONTRACTUAL", "TEMPORARY", "PART_TIME", "INTERN",
  "COMMISSION", "FREELANCE",
]

export const EMPLOYEE_STATUSES = [
  "ACTIVE", "PROBATION", "ON_LEAVE", "SUSPENDED", "RESIGNED", "TERMINATED", "RETIRED", "INACTIVE",
]

export const ATTENDANCE_STATUSES = [
  "PRESENT", "ABSENT", "LATE", "EARLY_LEAVE", "HALF_DAY", "LEAVE", "HOLIDAY",
  "WEEKLY_OFF", "WFH", "BUSINESS_TRIP",
]

export const LEAVE_TYPE_CODES = [
  "CASUAL", "SICK", "ANNUAL", "EARNED", "EMERGENCY", "MATERNITY", "PATERNITY", "UNPAID", "OTHER",
]

export const LETTER_TYPES = [
  "APPOINTMENT", "CONFIRMATION", "PROBATION_EXT", "SALARY_CERT", "EMPLOYMENT_CERT", "EXPERIENCE",
  "INCREMENT", "PROMOTION", "TRANSFER", "WARNING", "APPRECIATION", "SHOW_CAUSE", "SUSPENSION",
  "TERMINATION", "RESIGN_ACCEPT", "RELEASE", "RELIEVING", "NOC", "CUSTOM",
]

export const BONUS_TYPES = [
  "FESTIVAL", "PERFORMANCE", "SALES_COMMISSION", "TARGET", "ATTENDANCE", "REFERRAL", "SPECIAL",
]

export const EXPENSE_CATEGORIES = [
  "TRAVEL", "FOOD", "MEDICAL", "OFFICE", "TRANSPORT", "CLIENT", "OTHER",
]

export const REVIEW_AREAS = [
  "attendance", "punctuality", "productivity", "quality", "teamwork", "communication",
  "customerService", "leadership", "targetAchievement",
]

export const REVIEW_AREA_LABELS: Record<string, string> = {
  attendance: "Attendance", punctuality: "Punctuality", productivity: "Productivity",
  quality: "Quality of Work", teamwork: "Teamwork", communication: "Communication",
  customerService: "Customer Service", leadership: "Leadership", targetAchievement: "Target Achievement",
}
