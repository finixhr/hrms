// ============ Public website constants (single source of truth) ============
// The marketing site's own copy lives here so pages stay thin. Everything
// must describe CAPABILITIES THAT ACTUALLY EXIST in the HRM (master prompt §1
// — never advertise a feature the product does not have).
export const SITE = {
  name: "Finix HR",
  fullName: "Finix HR — Workforce Management Platform",
  tagline: "One Platform to Run Your Entire Workforce",
  description:
    "Multi-tenant HR operations platform: employee management, attendance with selfie & GPS verification, live tracking, payroll & AIT, leave, performance, inventory, procurement, security and analytics — in one workspace.",
  url: process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000",
  supportEmail: "support@finixhr.example",
  company: "Finix HR",
  country: "Bangladesh",
} as const

export const SITE_NAV: { label: string; href: string; children?: { label: string; href: string; desc?: string }[] }[] = [
  {
    label: "Features",
    href: "/features",
    children: [
      { label: "Employee Management", href: "/features/employee-management", desc: "Directory, 360° profiles, lifecycle & documents" },
      { label: "Attendance", href: "/features/attendance", desc: "Shifts, geo-fencing, selfie proof, corrections" },
      { label: "Live Tracking", href: "/features/live-tracking", desc: "Real-time location, battery & GPS status, history" },
      { label: "Payroll & Finance", href: "/features/payroll", desc: "Salary structures, runs, payslips, AIT, PF" },
      { label: "Leave & Self-Service", href: "/features/leave-management", desc: "Balances, applications, approvals, ESS portal" },
      { label: "Device Integration", href: "/features/device-integration", desc: "ZKTeco ADMS push, health, commands, history sync" },
      { label: "Performance", href: "/features/performance", desc: "Review cycles, KPI templates & assignments" },
      { label: "Inventory & Procurement", href: "/features/inventory-procurement", desc: "Requisitions, purchase, warehouses, stock" },
      { label: "Security & Control", href: "/features/security", desc: "RBAC, MFA, audit, tenant isolation" },
      { label: "Reports & Analytics", href: "/features/reports-analytics", desc: "Workforce reports and HR analytics" },
    ],
  },
  { label: "Pricing", href: "/pricing" },
  { label: "About", href: "/about" },
  { label: "FAQ", href: "/faq" },
  { label: "Contact", href: "/contact" },
]

export const SITE_FOOTER = {
  groups: [
    {
      title: "Product",
      links: [
        { label: "Features", href: "/features" },
        { label: "Pricing", href: "/pricing" },
        { label: "Device Integration", href: "/features/device-integration" },
        { label: "Security", href: "/features/security" },
        { label: "Register", href: "/register" },
      ],
    },
    {
      title: "Resources",
      links: [
        { label: "FAQ", href: "/faq" },
        { label: "Track Application", href: "/registration-status" },
        { label: "Contact", href: "/contact" },
      ],
    },
    {
      title: "Company",
      links: [
        { label: "About", href: "/about" },
        { label: "Contact", href: "/contact" },
      ],
    },
    {
      title: "Legal",
      links: [
        { label: "Privacy Policy", href: "/legal/privacy" },
        { label: "Terms of Service", href: "/legal/terms" },
      ],
    },
  ],
  note:
    "Registered names and marks belong to their respective owners. Legal pages are placeholders until the operator's counsel finalizes them — nothing on this site constitutes legal advice.",
} as const

// ---- how-it-works (registration → approval → workspace) --------------------
export const HOW_IT_WORKS: { step: string; title: string; body: string }[] = [
  {
    step: "1",
    title: "Register your organization",
    body: "Submit your organization profile, primary administrator and the modules you need. It takes about five minutes — no payment information.",
  },
  {
    step: "2",
    title: "Choose a subscription plan",
    body: "Pick a plan and a monthly or yearly billing cycle, matched to your expected headcount, branches and devices. Plans can be changed later.",
  },
  {
    step: "3",
    title: "Platform review & approval",
    body: "The platform team reviews the application, may ask a clarifying question, then approves it. You can track the status anytime with your Application ID.",
  },
  {
    step: "4",
    title: "Your HR workspace goes live",
    body: "On approval your workspace is provisioned instantly with statutory configuration. Sign in with the administrator email and password you chose at registration.",
  },
]

// ---- value propositions (hero-adjacent strip) ------------------------------
export const VALUE_PROPS: { icon: string; title: string; body: string }[] = [
  {
    icon: "layers",
    title: "One Platform",
    body: "People, attendance, payroll, leave, tracking, inventory and analytics run in one system with one sign-in — not a bundle of disconnected tools.",
  },
  {
    icon: "building",
    title: "Multi-Tenant by Design",
    body: "Every organization's data is isolated per tenant. Tenant users can only ever reach their own company's records — enforced on every query.",
  },
  {
    icon: "activity",
    title: "Real-Time Visibility",
    body: "Attendance, device health, live tracking and workforce activity are visible as they happen, with security signals for GPS-disabled or spoof-suspect check-ins.",
  },
  {
    icon: "shield",
    title: "Secure by Design",
    body: "Role-based access control, MFA, CSRF protection, audit trails and rate limiting are built in — not bolted on after the fact.",
  },
  {
    icon: "scaling",
    title: "Scales With You",
    body: "Plans and feature access grow with the organization: employee seats, branch counts, device counts and module entitlements are enforced transparently.",
  },
]
