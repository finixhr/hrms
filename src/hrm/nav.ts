// ============ Navigation structure (spec §20 — Final Vendor Panel Navigation) ============
// UI-R1 (2026-10-04 UI audit): the previous 18 groups — 8 of them holding a
// single item — produced a long, fragmented, scannability-poor sidebar. The
// same 31 destinations are now organised into 7 balanced sections (2–6 items
// each) that mirror how HR teams actually move through the workspace:
// overview → people → time → pay → operations → communication → insights.
// View KEYS are unchanged, so navigation, permissions, module gating,
// global search and deep links all keep working.
import { LayoutDashboard, CalendarDays, Users, Building2, Clock, Timer, Plane, Wallet,
  Landmark, Receipt, HandCoins, TrendingUp, TrendingDown, ListChecks, CheckCircle2, Bell, Megaphone, MailPlus,
  FileText, LogOut, UserRound, FileBarChart, BarChart3, ShieldCheck, Settings, Network, GitBranch,
  Landmark as TaxIcon, ShoppingCart, Boxes, Cctv, Sparkles, UserPlus, MapPin, Bot,
  CalendarClock, MonitorSmartphone, Radar, Gift, PiggyBank,
  BookOpen, FilePenLine, Settings2, LifeBuoy } from "lucide-react"

export type NavItem = { key: string; label: string; icon: any; perm?: [string, string] }
export type NavGroup = { label: string; items: NavItem[] }

export const NAV: NavGroup[] = [
  {
    label: "Overview",
    items: [
      { key: "dashboard", label: "HR Dashboard", icon: LayoutDashboard, perm: ["dashboard", "view"] },
      { key: "calendar", label: "HR Calendar", icon: CalendarDays, perm: ["calendar", "view"] },
    ],
  },
  {
    label: "Employee Management",
    items: [
      { key: "employees", label: "Employee Directory", icon: Users, perm: ["employees", "view"] },
      { key: "lifecycle", label: "Employment Lifecycle", icon: GitBranch, perm: ["employees", "view"] },
      { key: "ess", label: "My Self-Service", icon: UserRound },
      { key: "organization", label: "Branches & Departments", icon: Building2, perm: ["organization", "view"] },
      { key: "orgchart", label: "Org Chart", icon: Network, perm: ["employees", "view"] },
      { key: "exit", label: "Exit Management", icon: LogOut, perm: ["exit", "view"] },
      // Wave 2 WP-P — recruitment pipeline + public careers page
      { key: "recruitment", label: "Recruitment", icon: UserPlus, perm: ["recruitment", "view"] },
    ],
  },
  {
    label: "Time & Attendance",
    items: [
      // 2026-10-14 — "Attendance & Shifts" split into two menus; Field &
      // Security and Devices (their former tab groups) became top-level menus
      // in the new "Field & Devices" section below. View keys are new but the
      // tab values inside each view are unchanged (deep links keep working).
      { key: "attendance", label: "Attendance", icon: Clock, perm: ["attendance", "view"] },
      { key: "shifts", label: "Shifts", icon: CalendarClock, perm: ["attendance", "view"] },
      { key: "overtime", label: "Overtime Management", icon: Timer, perm: ["attendance", "view"] },
      { key: "leave", label: "Leave Management", icon: Plane, perm: ["leave", "view"] },
    ],
  },
  {
    label: "Field & Devices",
    items: [
      { key: "fieldsecurity", label: "Field & Security", icon: Radar, perm: ["tracking", "view"] },
      // Wave 2 WP-M — field force visits (moved from Operations, 2026-10)
      { key: "fieldforce", label: "Field Force", icon: MapPin, perm: ["fieldforce", "view"] },
      { key: "devices", label: "Devices", icon: MonitorSmartphone, perm: ["devices", "view"] },
      { key: "cameras", label: "Camera Manager", icon: Cctv, perm: ["camera", "view"] },
    ],
  },
  {
    label: "Payroll & Finance",
    items: [
      { key: "payroll", label: "Payroll", icon: Wallet, perm: ["payroll", "view"] },
      { key: "bonuses", label: "Bonuses & Commission", icon: Gift, perm: ["bonus", "view"] },
      { key: "deductions", label: "Deductions", icon: TrendingDown, perm: ["payroll", "view"] },
      { key: "pf", label: "Provident Fund", icon: PiggyBank, perm: ["payroll", "view"] },
      { key: "ait", label: "AIT / Income Tax", icon: TaxIcon, perm: ["ait", "view"] },
      { key: "loans", label: "Loans & Advances", icon: Landmark, perm: ["loans", "view"] },
      { key: "expenses", label: "Expense Claims", icon: Receipt, perm: ["expenses", "view"] },
      { key: "reimbursements", label: "Reimbursements", icon: HandCoins, perm: ["expenses", "view"] },
    ],
  },
  {
    label: "Accounting",
    items: [
      { key: "acc-coa", label: "Chart of Accounts", icon: BookOpen, perm: ["accounting", "view"] },
      { key: "acc-vouchers", label: "Voucher Entry", icon: FilePenLine, perm: ["accounting", "view"] },
      { key: "acc-approvals", label: "Voucher Approval", icon: CheckCircle2, perm: ["accounting", "approve"] },
      { key: "acc-statements", label: "Statements", icon: BarChart3, perm: ["accounting", "view"] },
      { key: "acc-controls", label: "Controls & Budgets", icon: Settings2, perm: ["accounting", "view"] },
    ],
  },
  {
    label: "Operations",
    items: [
      { key: "procurement", label: "Requisition & Purchase", icon: ShoppingCart, perm: ["procurement", "view"] },
      { key: "inventory", label: "Stock Inventory", icon: Boxes, perm: ["inventory", "view"] },
      // Wave 2 WP-K — employee asset register
      { key: "assets", label: "Asset Management", icon: Boxes, perm: ["assets", "view"] },
      { key: "tasks", label: "Task Management", icon: ListChecks, perm: ["tasks", "view"] },
      { key: "performance", label: "Performance & KPI", icon: TrendingUp, perm: ["performance", "view"] },
    ],
  },
  {
    label: "Communication",
    items: [
      { key: "approvals", label: "Approval Queue", icon: CheckCircle2, perm: ["approvals", "view"] },
      { key: "notifications", label: "Notification Center", icon: Bell },
      { key: "communication", label: "Email & SMS Center", icon: MailPlus, perm: ["communication", "view"] },
      { key: "announcements", label: "HR Announcements", icon: Megaphone },
      { key: "documents", label: "HR Letters", icon: FileText, perm: ["letters", "view"] },
    ],
  },
  {
    label: "Insights & Settings",
    items: [
      { key: "reports", label: "HR Reports", icon: FileBarChart, perm: ["reports", "view"] },
      { key: "analytics", label: "HR Analytics", icon: BarChart3, perm: ["analytics", "view"] },
      // Wave 4 (2026-10-08) — AI assist: NL report queries, attendance anomaly
      // detection, resume screening. Degrades to deterministic engines when
      // no LLM is configured.
      { key: "aiassist", label: "AI Assist", icon: Bot, perm: ["ai", "view"] },
      { key: "audit", label: "Audit Trail", icon: ShieldCheck, perm: ["audit", "view"] },
      { key: "settings", label: "HR Settings", icon: Settings, perm: ["settings", "view"] },
      // Wave 2 WP-A — observable background queue (admin/operators).
      { key: "jobs", label: "Job Center", icon: ListChecks, perm: ["jobs", "view"] },
      // 2026-10-25 (master prompt Part A) — Support Center: ordinary chat
      // support tickets + Live Support Access requests. Available to every
      // role (incl. locked/expired tenants — the dispatcher allowlists it).
      { key: "support", label: "Support Center", icon: LifeBuoy, perm: ["support", "view"] },
      // Wave 2 WP-H — tenant self-service billing portal (admins/owners only).
      // 2026-10-25 (master prompt Part D §7): Billing and Subscription & Usage
      // are MERGED into one page — single nav entry (the subscription view
      // stays registered for old deep links and redirects into Billing).
      { key: "billing", label: "Billing & Subscription", icon: Wallet, perm: ["billing", "view"] },
    ],
  },
]
