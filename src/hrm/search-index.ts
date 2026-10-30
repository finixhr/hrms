// ============ Global Search — static navigation index (menus + page tabs) ============
// Pure data + pure functions: derived from the sidebar NAV configuration and a
// static registry of the SectionTabs that live inside each page. No database
// queries — searching static navigation client-side keeps the palette instant
// and the server free for the entity search (employees/tasks) only.
import { NAV } from "./nav"

export type SearchTarget = {
  kind: "menu" | "tab"
  view: string // navigate() key — the existing SPA route
  tab?: string // SectionTabs value (tab results only)
  /** Nested SectionTabs value inside the target tab (e.g. Templates → SMS). */
  tpl?: string
  label: string
  parent: string // sidebar group (menus) / page title (tabs)
  perm?: [string, string] // permission required to see the destination
  module?: string // module-visibility key (B5 toggles)
  requiresEmployeeId?: boolean // ESS-linked destinations
  keywords?: string[] // recall aliases
}

// M-08 — the view→module map is shared with app-shell via module-map.ts (the
// two copies had drifted, hiding modules that search still indexed).
export { MODULE_OF } from "./module-map"
import { MODULE_OF } from "./module-map"

// Recall aliases — words users type that don't appear in the label itself.
const NAV_KEYWORDS: Record<string, string[]> = {
  dashboard: ["home", "overview"],
  employees: ["staff", "directory", "biodata", "360", "worker", "directory"],
  lifecycle: ["promotion", "transfer", "increment", "revision"],
  ess: ["self service", "self-service", "my portal", "portal", "mine"],
  orgchart: ["hierarchy", "tree", "reporting line"],
  organization: ["branch", "department", "designation", "holiday"],
  attendance: ["punch", "biometric", "check in", "checkin", "marking", "register"],
  shifts: ["shift", "roster", "schedule", "rotation", "night", "early"],
  fieldsecurity: ["tracking", "live location", "gps", "geofence", "geo fence", "security events", "field"],
  devices: ["zkteco", "adms", "biometric terminal", "fingerprint", "device", "sync"],
  overtime: ["ot", "extra hours"],
  leave: ["absence", "holiday", "casual", "sick", "annual"],
  payroll: ["salary", "pay slip", "payslip", "wages"],
  bonuses: ["bonus", "commission", "sales commission", "incentive", "rules", "threshold"],
  ait: ["tds", "income tax", "tax", "কর", "withholding"],
  loans: ["installment", "advance", "emi"],
  expenses: ["claim", "reimbursement", "bill"],
  reimbursements: ["reimburse", "payback", "expense"],
  performance: ["review", "appraisal", "kpi", "rating"],
  tasks: ["todo", "to-do", "kanban", "assignment"],
  approvals: ["pending", "queue", "delegate", "delegation"],
  notifications: ["alerts", "messages", "unread"],
  announcements: ["notice", "circular", "news"],
  communication: ["email", "sms", "mail", "broadcast"],
  documents: ["letters", "templates", "certificate", "noc", "experience"],
  exit: ["resign", "resignation", "clearance", "settlement", "notice period"],
  reports: ["export", "csv", "register"],
  analytics: ["charts", "insights", "metrics", "headcount", "trend"],
  audit: ["logs", "trail", "history", "who did what"],
  settings: ["configuration", "config", "preferences", "roles", "workflows"],
  calendar: ["events", "holidays", "schedule"],
}

// ---------- Menus / sub-menus: derived from the sidebar configuration ----------
export const NAV_INDEX: SearchTarget[] = NAV.flatMap((g) =>
  g.items.map((it) => ({
    kind: "menu" as const,
    view: it.key,
    label: it.label,
    parent: g.label,
    perm: it.perm,
    module: MODULE_OF[it.key],
    requiresEmployeeId: it.key === "ess",
    keywords: NAV_KEYWORDS[it.key],
  })),
)

// ---------- Page tabs (static registry mirroring each view's SectionTabs) ----------
// Only tabs whose runtime visibility depends solely on permissions/employeeId
// are indexed — the exact conditions the views apply. Nothing here creates a
// new page: every entry navigates to the existing view with { tab } params,
// which the views already support through their presetTab deep-link pattern.
// The module key is derived from the destination view so the B5 module
// visibility toggles hide tab results exactly like they hide the sidebar.
const RAW_TAB_INDEX: SearchTarget[] = [
  // Attendance (records) / Shifts / Field & Security / Devices — the four
  // separate menus of the 2026-10-14 split; tab VALUES are unchanged so
  // existing deep links keep resolving to the right tab in its new view.
  { kind: "tab", view: "attendance", tab: "daily", label: "Daily Attendance", parent: "Attendance", perm: ["attendance", "view"] },
  { kind: "tab", view: "attendance", tab: "register", label: "Monthly Register", parent: "Attendance", perm: ["attendance", "view"] },
  { kind: "tab", view: "attendance", tab: "history", label: "Attendance History", parent: "Attendance", perm: ["attendance", "view"] },
  { kind: "tab", view: "attendance", tab: "corrections", label: "Corrections", parent: "Attendance", perm: ["attendance", "view"] },
  { kind: "tab", view: "shifts", tab: "shifts", label: "Shifts & Roster", parent: "Shifts", perm: ["attendance", "view"] },
  { kind: "tab", view: "shifts", tab: "policies", label: "Attendance Policies", parent: "Shifts", perm: ["attendance", "view"] },
  { kind: "tab", view: "fieldsecurity", tab: "tracking", label: "Live Tracking", parent: "Field & Security", perm: ["tracking", "view"] },
  { kind: "tab", view: "fieldsecurity", tab: "geofence", label: "Geo-Fence", parent: "Field & Security", perm: ["geofence", "view"] },
  { kind: "tab", view: "fieldsecurity", tab: "security", label: "Security Events", parent: "Field & Security", perm: ["attendance", "view"] },
  { kind: "tab", view: "devices", tab: "devices", label: "ADMS Devices", parent: "Devices", perm: ["devices", "view"] },
  { kind: "tab", view: "devices", tab: "deviceEvents", label: "Device Events", parent: "Devices", perm: ["devices", "view"] },
  { kind: "tab", view: "devices", tab: "unknownUsers", label: "Unknown Users", parent: "Devices", perm: ["devices", "view"] },
  { kind: "tab", view: "devices", tab: "syncMonitor", label: "Sync Monitor", parent: "Devices", perm: ["devices", "view"] },
  // Approvals
  { kind: "tab", view: "approvals", tab: "queue", label: "Pending Queue", parent: "Approval Queue", perm: ["approvals", "view"] },
  { kind: "tab", view: "approvals", tab: "history", label: "History", parent: "Approval Queue", perm: ["approvals", "view"] },
  { kind: "tab", view: "approvals", tab: "delegation", label: "Delegation", parent: "Approval Queue", perm: ["approvals", "view"] },
  // Documents / Letters
  { kind: "tab", view: "documents", tab: "issue", label: "Issue Letter", parent: "HR Letters", perm: ["letters", "view"] },
  { kind: "tab", view: "documents", tab: "issued", label: "Issued Letters", parent: "HR Letters", perm: ["letters", "view"] },
  // Exit
  { kind: "tab", view: "exit", tab: "resignations", label: "Resignations", parent: "Exit Management", perm: ["exit", "view"] },
  { kind: "tab", view: "exit", tab: "guide", label: "Process & Formula", parent: "Exit Management", perm: ["exit", "view"] },
  // Leave
  { kind: "tab", view: "leave", tab: "requests", label: "Leave Requests", parent: "Leave Management", perm: ["leave", "view"] },
  { kind: "tab", view: "leave", tab: "balances", label: "Leave Balances", parent: "Leave Management", perm: ["leave", "view"] },
  { kind: "tab", view: "leave", tab: "types", label: "Leave Types & Policies", parent: "Leave Management", perm: ["leave", "view"] },
  { kind: "tab", view: "leave", tab: "my", label: "My Leave", parent: "Leave Management", perm: ["leave", "view"], requiresEmployeeId: true },
  // Employment Lifecycle
  { kind: "tab", view: "lifecycle", tab: "promotions", label: "Promotions", parent: "Employment Lifecycle", perm: ["employees", "view"] },
  { kind: "tab", view: "lifecycle", tab: "transfers", label: "Transfers", parent: "Employment Lifecycle", perm: ["employees", "view"] },
  { kind: "tab", view: "lifecycle", tab: "revisions", label: "Salary Revisions", parent: "Employment Lifecycle", perm: ["payroll", "view"] },
  // Loans & Advances
  { kind: "tab", view: "loans", tab: "loans", label: "Loans", parent: "Loans & Advances", perm: ["loans", "view"] },
  { kind: "tab", view: "loans", tab: "advances", label: "Advances", parent: "Loans & Advances", perm: ["advances", "view"] },
  // Organization
  { kind: "tab", view: "organization", tab: "branches", label: "Branches", parent: "Branches & Departments", perm: ["organization", "view"] },
  { kind: "tab", view: "organization", tab: "departments", label: "Departments", parent: "Branches & Departments", perm: ["organization", "view"] },
  { kind: "tab", view: "organization", tab: "designations", label: "Designations", parent: "Branches & Departments", perm: ["organization", "view"] },
  { kind: "tab", view: "orgchart", tab: "organogram", label: "Organogram", parent: "Org Chart", perm: ["employees", "view"] },
  { kind: "tab", view: "orgchart", tab: "reporting", label: "Reporting Structure", parent: "Org Chart", perm: ["employees", "view"] },
  // Payroll
  { kind: "tab", view: "payroll", tab: "runs", label: "Payroll Runs", parent: "Payroll", perm: ["payroll", "view"] },
  { kind: "tab", view: "payroll", tab: "structures", label: "Salary Structures", parent: "Payroll", perm: ["payroll", "view"] },
  { kind: "tab", view: "bonuses", tab: "bonus", label: "Bonus", parent: "Bonuses & Commission", perm: ["bonus", "view"] },
  { kind: "tab", view: "bonuses", tab: "commission", label: "Commission", parent: "Bonuses & Commission", perm: ["bonus", "view"] },
  { kind: "tab", view: "bonuses", tab: "commission-rules", label: "Commission Rule Setup", parent: "Bonuses & Commission", perm: ["bonus", "view"] },
  { kind: "tab", view: "bonuses", tab: "calculate", label: "Calculate Commissions", parent: "Bonuses & Commission", perm: ["bonus", "calculate"] },
  { kind: "tab", view: "deductions", tab: "deductions", label: "Deductions", parent: "Deductions", perm: ["payroll", "view"] },
  { kind: "tab", view: "pf", tab: "pf", label: "Provident Fund", parent: "Provident Fund", perm: ["payroll", "view"] },
  // 2026-10-14 — loan/advance recovery control system (guarantor fallback)
  { kind: "tab", view: "payroll", tab: "loanControl", label: "Loan & Advance Control", parent: "Payroll", perm: ["payroll", "view"] },
  { kind: "tab", view: "payroll", tab: "payslips", label: "Payslips", parent: "Payroll", perm: ["payslip", "view"] },
  // AIT / Income Tax module (single home for all tax setup + operations)
  { kind: "tab", view: "ait", tab: "calculator", label: "AIT Calculator", parent: "AIT / Income Tax", perm: ["ait", "view"] },
  { kind: "tab", view: "ait", tab: "employees", label: "Employees TDS / Batch", parent: "AIT / Income Tax", perm: ["ait", "view"] },
  { kind: "tab", view: "ait", tab: "certificates", label: "Employee AIT/Tax Certificate", parent: "AIT / Income Tax", perm: ["ait", "view"] },
  { kind: "tab", view: "ait", tab: "reconciliation", label: "AIT Reconciliation", parent: "AIT / Income Tax", perm: ["ait", "view"] },
  { kind: "tab", view: "ait", tab: "config", label: "AIT Fiscal Year Config", parent: "AIT / Income Tax", perm: ["ait", "edit"] },
  { kind: "tab", view: "ait", tab: "audit", label: "AIT Audit Log", parent: "AIT / Income Tax", perm: ["ait", "view"] },
  // Procurement & Inventory
  { kind: "tab", view: "procurement", tab: "requisitions", label: "Goods Requisitions", parent: "Requisition & Purchase", perm: ["procurement", "view"] },
  { kind: "tab", view: "procurement", tab: "purchases", label: "Purchase Requests", parent: "Requisition & Purchase", perm: ["procurement", "view"] },
  { kind: "tab", view: "procurement", tab: "suppliers", label: "Suppliers", parent: "Requisition & Purchase", perm: ["procurement", "view"] },
  { kind: "tab", view: "procurement", tab: "reports", label: "Procurement Reports", parent: "Requisition & Purchase", perm: ["procurement", "view"] },
  { kind: "tab", view: "inventory", tab: "overview", label: "Stock Overview", parent: "Stock Inventory", perm: ["inventory", "view"] },
  { kind: "tab", view: "inventory", tab: "items", label: "Stock Items", parent: "Stock Inventory", perm: ["inventory", "view"] },
  { kind: "tab", view: "inventory", tab: "warehouses", label: "Warehouses", parent: "Stock Inventory", perm: ["inventory", "view"] },
  { kind: "tab", view: "inventory", tab: "entries", label: "Stock Entries", parent: "Stock Inventory", perm: ["inventory", "view"] },
  { kind: "tab", view: "inventory", tab: "transactions", label: "Stock Transactions", parent: "Stock Inventory", perm: ["inventory", "view"] },
  // ESS — self-service goods + tax certificates
  { kind: "tab", view: "ess", tab: "goods", label: "My Requisitions", parent: "My Self-Service", requiresEmployeeId: true },
  { kind: "tab", view: "ess", tab: "taxcert", label: "My AIT/Tax Certificate", parent: "My Self-Service", requiresEmployeeId: true },
  // Performance & KPI
  { kind: "tab", view: "performance", tab: "reviews", label: "Performance Reviews", parent: "Performance & KPI", perm: ["performance", "view"] },
  { kind: "tab", view: "performance", tab: "templates", label: "KPI Templates", parent: "Performance & KPI", perm: ["performance", "view"] },
  { kind: "tab", view: "performance", tab: "assignments", label: "KPI Assignments", parent: "Performance & KPI", perm: ["performance", "view"] },
  { kind: "tab", view: "performance", tab: "analytics", label: "Performance Analytics", parent: "Performance & KPI", perm: ["performance", "view"] },
  // HR Settings
  { kind: "tab", view: "settings", tab: "general", label: "General Settings", parent: "HR Settings", perm: ["settings", "view"] },
  { kind: "tab", view: "settings", tab: "employee", label: "Employee Settings", parent: "HR Settings", perm: ["settings", "view"] },
  { kind: "tab", view: "settings", tab: "holidays", label: "Holiday Calendar", parent: "HR Settings", perm: ["organization", "view"] },
  { kind: "tab", view: "settings", tab: "attendance", label: "Attendance Settings", parent: "HR Settings", perm: ["settings", "view"] },
  { kind: "tab", view: "settings", tab: "leave", label: "Leave Settings", parent: "HR Settings", perm: ["settings", "view"] },
  { kind: "tab", view: "settings", tab: "payroll", label: "Payroll Settings", parent: "HR Settings", perm: ["settings", "view"] },
  { kind: "tab", view: "settings", tab: "shiftsettings", label: "Shifts & OT Settings", parent: "HR Settings", perm: ["settings", "view"] },
  { kind: "tab", view: "settings", tab: "users", label: "Users & Security", parent: "HR Settings", perm: ["settings", "view"] },
  { kind: "tab", view: "settings", tab: "roles", label: "Roles & Permissions", parent: "HR Settings", perm: ["settings", "view"] },
  { kind: "tab", view: "settings", tab: "workflows", label: "Approval Workflows", parent: "HR Settings", perm: ["settings", "view"] },
  { kind: "tab", view: "settings", tab: "localization", label: "Localization & Branding", parent: "HR Settings", perm: ["settings", "view"] },
  { kind: "tab", view: "settings", tab: "backup", label: "Backup & Restore", parent: "HR Settings", perm: ["settings", "view"] },
  // 2026-10 restructure — Templates now lives in HR Settings (SMS / Email / Letter)
  { kind: "tab", view: "settings", tab: "templates", label: "Templates", parent: "HR Settings", perm: ["settings", "view"] },
  { kind: "tab", view: "settings", tab: "templates", label: "SMS Templates", parent: "HR Settings → Templates", perm: ["settings", "view"], tpl: "smsTemplates" },
  { kind: "tab", view: "settings", tab: "templates", label: "Email Templates", parent: "HR Settings → Templates", perm: ["settings", "view"], tpl: "emailTemplates" },
  { kind: "tab", view: "settings", tab: "templates", label: "Letter Templates", parent: "HR Settings → Templates", perm: ["letters", "view"], tpl: "letterTemplates" },
  // Accounting sidebar pages
  { kind: "tab", view: "acc-coa",       tab: "coa",             label: "Chart of Accounts",  parent: "Chart of Accounts",  perm: ["accounting", "view"] },
  { kind: "tab", view: "acc-vouchers",  tab: "vouchers",        label: "Voucher Entry",       parent: "Voucher Entry",      perm: ["accounting", "view"] },
  { kind: "tab", view: "acc-approvals", tab: "approvals",       label: "Voucher Approval",    parent: "Voucher Approval",   perm: ["accounting", "approve"] },
  { kind: "tab", view: "acc-statements",tab: "trialBalance",    label: "Trial Balance",       parent: "Statements",         perm: ["accounting", "view"] },
  { kind: "tab", view: "acc-statements",tab: "balanceSheet",    label: "Balance Sheet",       parent: "Statements",         perm: ["accounting", "view"] },
  { kind: "tab", view: "acc-statements",tab: "cashFlow",        label: "Cash Flow",           parent: "Statements",         perm: ["accounting", "view"] },
  { kind: "tab", view: "acc-statements",tab: "ledger",          label: "Ledger Statement",    parent: "Statements",         perm: ["accounting", "view"] },
  { kind: "tab", view: "acc-statements",tab: "incomeStatement", label: "Income Statement",    parent: "Statements",         perm: ["accounting", "view"] },
  { kind: "tab", view: "acc-controls",  tab: "periods",         label: "Periods",             parent: "Controls & Budgets", perm: ["accounting", "view"] },
  { kind: "tab", view: "acc-controls",  tab: "costCenters",     label: "Cost Centers",        parent: "Controls & Budgets", perm: ["accounting", "view"] },
  { kind: "tab", view: "acc-controls",  tab: "budgets",         label: "Budgets",             parent: "Controls & Budgets", perm: ["accounting", "view"] },
]

export const TAB_INDEX: SearchTarget[] = RAW_TAB_INDEX.map((t) => ({ ...t, module: MODULE_OF[t.view] }))

/** Visibility rule for a search target — the same gating the app-shell applies
 *  to sidebar items (permission, module toggle, ESS employee-link), applied to
 *  search results so search can never reveal a destination the sidebar hides. */
export function targetVisible(
  t: SearchTarget,
  opts: { can: (m: string, a: string) => boolean; hasEmployeeId: boolean; isEmployeeOnly: boolean; hiddenModules: Set<string> },
): boolean {
  if (t.module && opts.hiddenModules.has(t.module)) return false
  if (t.requiresEmployeeId && !opts.hasEmployeeId && !opts.isEmployeeOnly) return false
  if (t.perm) return opts.can(t.perm[0], t.perm[1])
  return true
}

export type StaticHits = { menus: SearchTarget[]; tabs: SearchTarget[] }

/** Search the static navigation (menus + page tabs) with relevance ranking.
 *  Exact > starts-with > word-boundary > partial; keywords add recall.
 *  Returns at most `limit` per category, best first. */
export function searchStatic(
  rawQuery: string,
  opts: { can: (m: string, a: string) => boolean; hasEmployeeId: boolean; isEmployeeOnly: boolean; hiddenModules: Set<string> },
  limit = 8,
): StaticHits {
  const q = String(rawQuery ?? "").replace(/\s+/g, " ").trim().toLowerCase()
  if (q.length < 1) return { menus: [], tabs: [] }
  const scoreTarget = (t: SearchTarget): number => {
    const label = t.label.toLowerCase()
    if (label === q) return 100
    if (label.startsWith(q)) return 85
    const parent = t.parent.toLowerCase()
    const kw = (t.keywords || []).map((k) => k.toLowerCase())
    const texts = [label, ...kw, parent]
    let best = 0
    for (const text of texts) {
      if (text === q) best = Math.max(best, 90)
      else if (text.startsWith(q)) best = Math.max(best, 75)
      else {
        const idx = text.indexOf(q)
        if (idx > -1) {
          const boundary = idx === 0 || /[\s\-_/&,.)]/.test(text[idx - 1])
          best = Math.max(best, boundary ? 65 : 45)
        }
      }
    }
    return best
  }
  const rank = (list: SearchTarget[]) =>
    list
      .filter((t) => targetVisible(t, opts))
      .map((t) => ({ t, s: scoreTarget(t) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.t.label.localeCompare(b.t.label))
      .slice(0, limit)
      .map((x) => x.t)
  return { menus: rank(NAV_INDEX), tabs: rank(TAB_INDEX) }
}
