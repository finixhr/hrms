// ============ Website CMS default content (code-level fallback) ============
// Server-side module. These defaults are the fallback the public site renders
// when no DB row exists yet; the owner console seeds/edits them into
// SaasSiteSetting / SaasCmsPage / SaasCmsFeature / SaasCmsClient rows.
// RULE (master prompt §1): every item describes shipped capabilities only.
import { FEATURE_PAGES } from "@/saas/web/features"
import type {
  ClientRecord, CursorConfig, FeatureRecord, FooterConfig, SiteContact, SiteIdentity,
  SiteNav, SiteSeo, CmsBlock,
} from "@/saas/web/content-types"

// ---- visual keys (must match the registry in src/saas/web/visuals/index.tsx) --
export const FEATURE_VISUAL_KEYS = [
  "dashboard", "employee", "attendance", "tracking", "payroll", "leave",
  "device", "performance", "inventory", "security", "reports", "camera",
  "letters", "communication", "tasks", "exit", "calendar", "recruitment",
] as const

// ---- site identity ------------------------------------------------------------
export const DEFAULT_SITE_IDENTITY: SiteIdentity = {
  siteName: "Finix HR",
  tagline: "One Platform to Run Your Entire Workforce",
  description:
    "Multi-tenant HR operations platform: employee management, attendance with selfie & GPS verification, live tracking, payroll & AIT, leave, performance, inventory, procurement, security and analytics — in one workspace.",
  company: "Finix HR",
  country: "Bangladesh",
  supportEmail: "support@finixhr.example",
  supportPhone: "",
  address: "Dhaka, Bangladesh",
  logoUrl: "/logo.svg",
  faviconUrl: "/logo.svg",
  navCtaLabel: "Get Started",
  navCtaHref: "/register",
  navSignInLabel: "Sign in",
  navSignInHref: "/login",
}

// ---- SEO defaults ----------------------------------------------------------------
export const DEFAULT_SEO: SiteSeo = {
  metaTitle: "Finix HR — Workforce Management Platform",
  metaDescription:
    "Finix HR is a standalone HRM & workforce platform: employees, attendance with selfie & GPS proof, live tracking, payroll & AIT, leave, performance, inventory, procurement, security and analytics.",
  keywords: ["HRM", "HR software", "Workforce management", "Payroll", "Bangladesh", "Attendance", "Live tracking", "SaaS"],
  ogTitle: "Finix HR — Workforce Management Platform",
  ogDescription: "One platform to run your entire workforce — employees, attendance, payroll, tracking and analytics.",
}

// ---- contact defaults -----------------------------------------------------------------
export const DEFAULT_CONTACT: SiteContact = {
  heading: "Talk to the Finix HR team",
  sub: "Questions about plans, modules, device integration or migration? Send a message — a platform specialist replies within one business day.",
  phone: "",
  email: "support@finixhr.example",
  address: "Dhaka, Bangladesh",
  hours: "Sunday – Thursday, 9:00 – 18:00 (UTC+6)",
  showForm: true,
}

// ---- navigation (17 features incl. the module-consistency additions) --------------------
export const DEFAULT_SITE_NAV: SiteNav = [
  {
    label: "Features",
    href: "/features",
    children: [
      { label: "All in One Dashboard", href: "/features/all-in-one-dashboard", desc: "Every workforce KPI on one screen" },
      { label: "Employee Management", href: "/features/employee-management", desc: "Directory, 360° profiles, lifecycle & documents" },
      { label: "Attendance", href: "/features/attendance", desc: "Shifts, geo-fencing, selfie proof, corrections" },
      { label: "Live Tracking", href: "/features/live-tracking", desc: "Real-time location, battery & GPS status, history" },
      { label: "Payroll & Finance", href: "/features/payroll", desc: "Salary structures, runs, payslips, AIT, PF" },
      { label: "Leave & Self-Service", href: "/features/leave-management", desc: "Balances, applications, approvals, ESS portal" },
      { label: "HR Letters", href: "/features/hr-letters", desc: "19 letter types with approvals & issuance register" },
      { label: "Communication", href: "/features/communication-hub", desc: "Email & SMS blasts, announcements, event templates" },
      { label: "Tasks & Approvals", href: "/features/tasks-approvals", desc: "Task board, unified approval queue, workflows" },
      { label: "Exit Management", href: "/features/exit-management", desc: "Resignations, clearance, full & final settlement" },
      { label: "Company Calendar", href: "/features/workforce-calendar", desc: "Holidays, events, celebrations, leave visibility" },
      { label: "Device Integration", href: "/features/device-integration", desc: "ZKTeco ADMS push, health, commands, history sync" },
      { label: "Performance", href: "/features/performance", desc: "Review cycles, KPI templates & assignments" },
      { label: "CCTV Camera Manager", href: "/features/cctv-camera-manager", desc: "Multi-brand camera registry, health & launch" },
      { label: "Inventory & Procurement", href: "/features/inventory-procurement", desc: "Requisitions, purchase, warehouses, stock" },
      { label: "Security & Control", href: "/features/security", desc: "RBAC, MFA, audit, tenant isolation" },
      { label: "Reports & Analytics", href: "/features/reports-analytics", desc: "Workforce reports and HR analytics" },
      // Wave 2 WP-P — recruitment pipeline + the public careers page it feeds
      { label: "Recruitment & Careers", href: "/features/recruitment-pipeline", desc: "Job openings, public careers page, applicant pipeline" },
    ],
  },
  { label: "Pricing", href: "/pricing" },
  { label: "Clients", href: "/clients" },
  { label: "About", href: "/about" },
  { label: "FAQ", href: "/faq" },
  { label: "Contact", href: "/contact" },
  // Wave 2 WP-P — the public job board fed by published tenant openings
  { label: "Careers", href: "/careers" },
]

// ---- footer --------------------------------------------------------------------------------
export const DEFAULT_SITE_FOOTER: FooterConfig = {
  groups: [
    {
      title: "Product",
      links: [
        { label: "Features", href: "/features" },
        { label: "All in One Dashboard", href: "/features/all-in-one-dashboard" },
        { label: "Live Tracking", href: "/features/live-tracking" },
        { label: "Device Integration", href: "/features/device-integration" },
        { label: "Pricing", href: "/pricing" },
        { label: "Register", href: "/register" },
      ],
    },
    {
      title: "Clients",
      links: [
        { label: "Valued Clients", href: "/clients" },
        { label: "Client Stories", href: "/clients#stories" },
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
}

// ---- cursor effect ------------------------------------------------------------------------------
export const DEFAULT_CURSOR_CONFIG: CursorConfig = {
  enabled: true,
  // Wave 11 §12 — Comet is the platform default effect for the public
  // marketing website ("Make Comet the default effect").
  style: "comet",
  primaryColor: "#818cf8", // indigo-400 — orb fill / dot / ring
  accentColor: "#a78bfa", // violet-400 — glow / trail / highlights
  pullStrength: 5, // 0–10 (5 = designed feel)
  trailIntensity: 65, // 0–100 movement trail strength
  glow: 65, // 0–100 overall glow
  magnetic: true,
  tilt: true,
  ripple: true,
  viewLabels: true,
  viewLabel: "VIEW",
}

// ---- feature defaults (existing 10 + 5 module-consistency pages + 2 new) ----
const VISUAL_BY_SLUG: Record<string, string> = {
  "employee-management": "employee",
  attendance: "attendance",
  "live-tracking": "tracking",
  payroll: "payroll",
  "leave-management": "leave",
  "device-integration": "device",
  performance: "performance",
  "inventory-procurement": "inventory",
  security: "security",
  "reports-analytics": "reports",
  // 2026-10 module-consistency round — new feature pages for previously
  // unlisted modules (HR letters, communication, tasks/approvals, exit,
  // calendar)
  "hr-letters": "letters",
  "communication-hub": "communication",
  "tasks-approvals": "tasks",
  "exit-management": "exit",
  "workforce-calendar": "calendar",
  // Wave 2 WP-P — recruitment pipeline
  "recruitment-pipeline": "recruitment",
}

const NEW_FEATURES: Omit<FeatureRecord, "id" | "updatedAt">[] = [
  {
    slug: "all-in-one-dashboard",
    title: "All in One Dashboard",
    navLabel: "All in One Dashboard",
    headline: "Your entire workforce, on one screen",
    sub: "KPIs, attendance, payroll, tasks and activity — a live command center for HR that updates as your organization works.",
    visual: "dashboard",
    icon: "gauge",
    accent: "indigo",
    sortOrder: 0,
    visible: true,
    showOnHome: true,
    content: {
      problem: [
        "HR data lives in six different screens — headcount in one tool, attendance in another, payroll in a third — so every morning starts with a tab-hunting ritual.",
        "Managers discover problems late: an attendance anomaly on Tuesday surfaces at month-end payroll review.",
        "Executives ask one simple question — how is the workforce doing today? — and nobody can answer it without a spreadsheet exercise.",
      ],
      solution: [
        "A single dashboard aggregates every module in real time: headcount, attendance today, payroll status, pending approvals and live security signals.",
        "Role-aware cards mean an executive sees trends and totals, while an HR operator sees actionable queues — tasks, corrections, approvals.",
        "Charts, donuts and trend graphs are computed from your live tenant data — the same numbers payroll and reports use, not a parallel metric.",
      ],
      capabilities: [
        {
          title: "Command center",
          items: [
            "Headcount, active employees and joiners-exiters trends",
            "Attendance summary: present, absent, late and on-leave today",
            "Payroll run status with processing stages",
            "Pending tasks and approval queues",
          ],
        },
        {
          title: "Live signals",
          items: [
            "Device health and last-sync indicators",
            "Security events: GPS-disabled and spoof-suspect check-ins",
            "Notification feed with unread tracking",
            "Recent activity across modules",
          ],
        },
        {
          title: "Charts & analytics",
          items: [
            "Attendance trends and department distribution",
            "Payroll composition donuts (gross, deductions, net)",
            "Camera status charts for tenants with the camera module",
            "Exportable report packs for stakeholders",
          ],
        },
      ],
      workflow: [
        { title: "Sign in", body: "The dashboard is the landing view — your role decides which cards and queues appear." },
        { title: "Scan the day", body: "KPI cards summarize today's attendance, headcount and payroll status; charts show the trend." },
        { title: "Act on queues", body: "Pending tasks and approvals link straight to the module — one click, no hunting." },
        { title: "Drill down", body: "Every number links to the underlying records, from a department's attendance to a payroll run's entries." },
      ],
      security: [
        "Dashboard data is vendor-scoped — a tenant only ever sees its own workforce.",
        "Cards respect granular RBAC: users without payroll access see no payroll figures.",
        "Every dashboard load is an auditable, CSRF-protected request.",
      ],
      cta: { primary: "Register your organization", secondary: "Explore all features" },
    },
  },
  {
    slug: "cctv-camera-manager",
    title: "CCTV Camera Manager",
    navLabel: "CCTV Camera Manager",
    headline: "Every branch camera, one managed registry",
    sub: "Register Hikvision, Dahua, EZVIZ and Imou cameras per branch, monitor health and status, and launch live views — without leaving the HR platform.",
    visual: "camera",
    icon: "cctv",
    accent: "cyan",
    sortOrder: 9,
    visible: true,
    showOnHome: true,
    content: {
      problem: [
        "Branch camera inventories live in a spreadsheet that drifts from reality — nobody knows which unit is offline until an incident is reviewed.",
        "Credentials for camera portals are shared over chat and never rotated, so access is effectively unmanaged.",
        "Reviewing footage means digging through each branch's separate portal with different accounts and UIs.",
      ],
      solution: [
        "A structured registry per branch: brand, model, serial, channel, location, install date and status — with unique serial+channel enforcement.",
        "Health checking: ONLINE/OFFLINE/UNKNOWN per camera from the brand's cloud API (EZVIZ/Imou) or last-known status (Hikvision/Dahua).",
        "One-click launch: deep links, QR codes or cloud stream tokens route each user to the right view — with per-camera rate limits and full audit.",
      ],
      capabilities: [
        {
          title: "Registry & grid",
          items: [
            "Per-branch camera directory with status and brand filters",
            "ONLINE / OFFLINE / UNKNOWN status chips and counts",
            "Soft delete and restore with reasons and audit",
            "Brand badges: HIKVISION, DAHUA, EZVIZ, IMOU",
          ],
        },
        {
          title: "Health & status",
          items: [
            "Per-camera status checks against the provider API",
            "Last status check, last seen and last error surfaced per row",
            "Manual status override with a required reason",
            "Status distribution charts on the dashboard",
          ],
        },
        {
          title: "Credentials & launch",
          items: [
            "Tenant-level cloud credentials, encrypted at rest (AES-256-GCM)",
            "Per-camera verification codes for Hikvision/Dahua, write-only after save",
            "Launch targets: deep link, QR code or cloud stream token",
            "Rate-limited launching with strict audit logging",
          ],
        },
      ],
      workflow: [
        { title: "Register the camera", body: "Add brand, model, serial and channel; assign a branch and location. Unique serial+channel prevents duplicates." },
        { title: "Connect credentials", body: "For EZVIZ/Imou, store tenant cloud keys once; for Hikvision/Dahua, capture the per-camera verification code." },
        { title: "Monitor health", body: "Status checks update ONLINE/OFFLINE; the dashboard charts the fleet so offline units stand out." },
        { title: "Launch the view", body: "One click generates the brand-appropriate launch target — deep link, QR or stream token — and the action is audited." },
      ],
      security: [
        "Camera data is vendor- and branch-scoped; branch managers only see their own site's cameras.",
        "Verification codes and cloud payloads are encrypted with rotating key versions and masked on read.",
        "Every launch and credential change is written to the immutable audit log.",
        "Launch endpoints are rate-limited per camera and per tenant.",
      ],
      cta: { primary: "Register your organization", secondary: "Explore all features" },
    },
  },
  {
    // Wave 2 WP-P — Recruitment & the public careers page (shipped capabilities only)
    slug: "recruitment-pipeline",
    title: "Recruitment & Careers",
    navLabel: "Recruitment & Careers",
    headline: "Hire from a public careers page into your employee directory",
    sub: "Publish job openings to a public careers page, collect applications with CVs, and run a kanban pipeline from New to Hired — one click prefills the employee record.",
    visual: "recruitment",
    icon: "briefcase",
    accent: "violet",
    sortOrder: 10,
    visible: true,
    showOnHome: true,
    content: {
      problem: [
        "Job openings live in a spreadsheet while applications arrive scattered across email inboxes, Facebook messages and voice notes — nothing is comparable, nothing is trackable.",
        "Candidates attach CVs in a dozen formats; the ones that survive land in a shared folder nobody audited since the last hire.",
        "When someone IS finally hired, their details are retyped into the HR system by hand — a second chance to get the name, phone or email wrong.",
      ],
      solution: [
        "A structured job-opening register per organization: title, department, branch, employment type, positions, salary range and an application deadline.",
        "Openings with the Public flag appear on the platform's careers page — candidates apply online with a rate-limited, spam-guarded form and attach a CV (PDF/DOC/DOCX, 2 MB).",
        "Applications flow into a kanban pipeline (New → Shortlisted → Interview → Offered → Hired, plus Rejected) with notes, CV downloads and an audited status trail; marking someone Hired prefills the Add Employee form.",
      ],
      capabilities: [
        {
          title: "Openings & the careers page",
          items: [
            "Job opening register with department, branch, type, positions and deadline",
            "Draft / Open / Paused / Closed lifecycle with quick actions",
            "Publish toggle — Open + Public openings list on the public careers page",
            "Past-deadline openings stop accepting applications automatically",
          ],
        },
        {
          title: "Applications & CVs",
          items: [
            "Public apply form with CV upload (PDF/DOC/DOCX, byte-level type check, 2 MB cap)",
            "Rate-limited submissions per IP and per opening, with a bot honeypot",
            "Back-office entry for walk-in and referred candidates",
            "CV downloads behind permissions, with an audit row per access",
          ],
        },
        {
          title: "Pipeline & hiring",
          items: [
            "Kanban board across application statuses with quick moves",
            "Internal notes and a locked record once an applicant is Hired",
            "Hire action prefills the Add Employee wizard (name, email, phone, department)",
            "HR notified in-app and by email/SMS on every website application",
          ],
        },
      ],
      workflow: [
        { title: "Create the opening", body: "Add title, department, branch, type and deadline. It starts as a Draft — nothing is public yet." },
        { title: "Publish it", body: "Set it to Open with the Public flag: it appears on the careers page and starts accepting online applications." },
        { title: "Screen the pipeline", body: "Applications land as New. Advance through Shortlisted, Interview and Offered with notes and CV downloads — every move is audited." },
        { title: "Hire", body: "Mark the applicant Hired: the Add Employee form opens pre-filled with their name, email, phone and the opening's department." },
      ],
      security: [
        "The public listing is filtered server-side — closed, non-public and past-deadline openings are never sent to the browser.",
        "Applications are vendor-scoped like every HRM record; cross-tenant ids resolve to 404.",
        "Public submissions are rate-limited per IP and per opening, honeypot-guarded, and validated with strict schemas before anything is stored.",
        "CV files are type-checked by content (magic bytes), capped at 2 MB, and every download is audit-logged.",
      ],
      cta: { primary: "Register your organization", secondary: "View open positions" },
    },
  },
]

export const DEFAULT_FEATURES: FeatureRecord[] = [
  ...NEW_FEATURES.map((f) => ({ ...f, id: `default-${f.slug}`, updatedAt: new Date(0).toISOString() })),
  ...FEATURE_PAGES.map((p, i) => ({
    id: `default-${p.slug}`,
    slug: p.slug,
    title: p.title,
    navLabel: p.navLabel,
    headline: p.headline,
    sub: p.sub,
    visual: VISUAL_BY_SLUG[p.slug] ?? null,
    icon: "star",
    accent: "blue",
    sortOrder: i + 1,
    visible: true,
    showOnHome: true,
    content: {
      problem: p.problem,
      solution: p.solution,
      capabilities: p.capabilities,
      workflow: p.workflow,
      security: p.security,
      cta: p.cta,
    },
    updatedAt: new Date(0).toISOString(),
  })),
]

// ---- valued clients defaults ---------------------------------------------------------------
// Placeholder-brand clients (no real logos): industry-plausible reference stories.
export const DEFAULT_CLIENTS: ClientRecord[] = [
  {
    id: "default-client-1",
    name: "Bengal Textworks Ltd.",
    industry: "Textile & Garments Manufacturing",
    description: "3,400+ workers across two Dhaka EPZ plants running attendance, payroll and compliance on Finix HR.",
    story:
      "Bengal Textworks moved 3,400 workers from three spreadsheet islands onto one Finix HR workspace. Within two payroll cycles, attendance-to-payroll reconciliation dropped from a five-day manual exercise to a same-day review: device check-ins flow straight into the ledger, and the AIT engine computes withholding per employee automatically. Their HR team now closes payroll on day two instead of day seven, and branch managers check their own attendance anomalies from the dashboard before HR even asks.",
    quote:
      "The turning point was watching a device check-in appear in the attendance ledger in real time — after years of importing CSVs. Payroll close went from a week to two days.",
    personName: "Nazia Rahman",
    personRole: "Head of People Operations",
    metrics: [
      { label: "Workers onboarded", value: "3,400+" },
      { label: "Payroll close time", value: "7 days → 2 days" },
      { label: "Devices integrated", value: "18 ZKTeco units" },
    ],
    logoText: "BT",
    logoColor: "#2563eb",
    logoUrl: null,
    website: null,
    featured: true,
    visible: true,
    sortOrder: 1,
    updatedAt: new Date(0).toISOString(),
  },
  {
    id: "default-client-2",
    name: "Bay Logistics Group",
    industry: "Logistics & Distribution",
    description: "Field fleet with live GPS tracking, geofenced check-ins and per-trip attendance across Chattogram and Dhaka hubs.",
    story:
      "Bay Logistics runs 260 field staff across two hubs. Before Finix HR, attendance for field teams meant paper sheets collected at day end — and payroll disputes every month. With live tracking and geofence-verified mobile check-ins, every field worker's day is reconstructed automatically: location trail, battery and GPS status, and geofence entry/exit events. Their dispute rate fell by 80% in the first quarter, and the tracking timeline became the reference both HR and operations trust.",
    quote:
      "The tracking timeline ended our attendance disputes. When a driver and the supervisor remember a day differently, the data settles it in a minute.",
    personName: "Tanvir Alam",
    personRole: "Operations Director",
    metrics: [
      { label: "Field staff tracked", value: "260" },
      { label: "Attendance disputes", value: "−80%" },
      { label: "Hubs live", value: "2" },
    ],
    logoText: "BL",
    logoColor: "#0891b2",
    logoUrl: null,
    website: null,
    featured: true,
    visible: true,
    sortOrder: 2,
    updatedAt: new Date(0).toISOString(),
  },
  {
    id: "default-client-3",
    name: "GreenGrocer Retail Chain",
    industry: "Retail & FMCG",
    description: "24 outlets with shift-based rosters, ESS leave portal and camera-linked branch security.",
    story:
      "GreenGrocer's 24 outlets each run three shifts a day. Finix HR shift assignments and the mobile ESS portal let 600+ retail staff view rosters, apply for leave and check their own payslips — without calling the head office. Branch CCTV cameras are registered in the camera manager, so the central loss-prevention team monitors camera health per outlet from the same workspace they use for people operations.",
    quote:
      "Six hundred staff stopped phoning head office about leave balances. The self-service portal paid for itself in the first month.",
    personName: "Sadia Karim",
    personRole: "General Manager, HR",
    metrics: [
      { label: "Outlets", value: "24" },
      { label: "Staff on ESS", value: "600+" },
      { label: "Shifts per day", value: "3 × 24 outlets" },
    ],
    logoText: "GG",
    logoColor: "#059669",
    logoUrl: null,
    website: null,
    featured: false,
    visible: true,
    sortOrder: 3,
    updatedAt: new Date(0).toISOString(),
  },
  {
    id: "default-client-4",
    name: "MedCare Diagnostics",
    industry: "Healthcare Services",
    description: "Diagnostic network with on-call rosters, technician tracking and compliance-ready payroll reports.",
    story:
      "MedCare Diagnostics coordinates 180 phlebotomists who collect home samples across the city. On-call rosters, live technician tracking and automated payroll reports in one workspace cut their coordination overhead by half. Their compliance team exports audit-ready attendance and payroll reports for institutional clients directly from the platform.",
    quote:
      "We hand institutional clients audit-ready reports straight from Finix HR. The preparation that used to take a week now takes an hour.",
    personName: "Dr. Farhana Yusuf",
    personRole: "Chief Operating Officer",
    metrics: [
      { label: "Technicians tracked", value: "180" },
      { label: "Report prep time", value: "1 week → 1 hour" },
      { label: "Cities covered", value: "Dhaka + Gazipur" },
    ],
    logoText: "MD",
    logoColor: "#7c3aed",
    logoUrl: null,
    website: null,
    featured: false,
    visible: true,
    sortOrder: 4,
    updatedAt: new Date(0).toISOString(),
  },
  {
    id: "default-client-5",
    name: "Skyline Construction Co.",
    industry: "Construction & Engineering",
    description: "Project-site attendance with geofencing, wage payroll and multi-project costing.",
    story:
      "Skyline runs geofenced attendance at six project sites: workers check in on their phones inside the site boundary, and the platform reconstructs each day with location proof. Wage payroll with overtime policies pays 1,100+ workers per cycle, and project managers pull per-site labor cost reports without waiting for month-end consolidation.",
    quote:
      "Per-site labor costing that used to arrive a week after month-end is now a live dashboard for each project manager.",
    personName: "Rezaul Haque",
    personRole: "Project Control Lead",
    metrics: [
      { label: "Project sites", value: "6" },
      { label: "Workers per cycle", value: "1,100+" },
      { label: "Geofences", value: "6 active" },
    ],
    logoText: "SC",
    logoColor: "#ea580c",
    logoUrl: null,
    website: null,
    featured: false,
    visible: true,
    sortOrder: 5,
    updatedAt: new Date(0).toISOString(),
  },
  {
    id: "default-client-6",
    name: "PinnacleSoft Solutions",
    industry: "IT & Software Services",
    description: "Software house with performance reviews, KPI cycles and flexible-shift attendance.",
    story:
      "PinnacleSoft runs structured performance: quarterly review cycles with KPI templates assigned per role, and review workflows that route through managers before HR sign-off. Flexible shift policies cover their engineering teams' staggered hours, and the analytics module correlates attrition signals with review outcomes.",
    quote:
      "Review cycles that were skipped in busy quarters now complete on schedule — the workflow enforces itself politely.",
    personName: "Nusrat Jahan",
    personRole: "VP Engineering",
    metrics: [
      { label: "Review cycles / year", value: "4" },
      { label: "KPI templates", value: "12 role-based" },
      { label: "On-time completion", value: "96%" },
    ],
    logoText: "PS",
    logoColor: "#db2777",
    logoUrl: null,
    website: null,
    featured: false,
    visible: true,
    sortOrder: 6,
    updatedAt: new Date(0).toISOString(),
  },
]

// ---- testimonials defaults --------------------------------------------------------------------
export const DEFAULT_TESTIMONIALS = [
  {
    id: "default-testimonial-1",
    clientName: "Bengal Textworks Ltd.",
    personName: "Nazia Rahman",
    personRole: "Head of People Operations",
    quote:
      "Finix HR replaced three spreadsheets and a scanner. Attendance flows from devices into payroll without a single manual step, and our HR team finally trusts the numbers they sign.",
    rating: 5,
    visible: true,
    sortOrder: 1,
    updatedAt: new Date(0).toISOString(),
  },
  {
    id: "default-testimonial-2",
    clientName: "Bay Logistics Group",
    personName: "Tanvir Alam",
    personRole: "Operations Director",
    quote:
      "Live tracking with geofence check-ins ended our attendance disputes. What used to be a monthly argument between drivers and supervisors is now a two-minute timeline review.",
    rating: 5,
    visible: true,
    sortOrder: 2,
    updatedAt: new Date(0).toISOString(),
  },
  {
    id: "default-testimonial-3",
    clientName: "GreenGrocer Retail Chain",
    personName: "Sadia Karim",
    personRole: "General Manager, HR",
    quote:
      "The self-service portal is the quiet hero — 600 staff check rosters, leave and payslips themselves. Our HR desk answers real questions instead of repetitive ones.",
    rating: 5,
    visible: true,
    sortOrder: 3,
    updatedAt: new Date(0).toISOString(),
  },
  {
    id: "default-testimonial-4",
    clientName: "Skyline Construction Co.",
    personName: "Rezaul Haque",
    personRole: "Project Control Lead",
    quote:
      "Geofenced site attendance plus wage payroll in one system. Per-site labor costing is live, not a month-end surprise, and the audit trail stands up to client scrutiny.",
    rating: 5,
    visible: true,
    sortOrder: 4,
    updatedAt: new Date(0).toISOString(),
  },
]

// ---- homepage default blocks (page builder) ------------------------------------------------------
let blockSeq = 0
const b = (type: CmsBlock["type"], data: Record<string, unknown>): CmsBlock => ({
  id: `default-home-${++blockSeq}`,
  type,
  visible: true,
  data,
})

export const DEFAULT_HOME_BLOCKS: CmsBlock[] = [
  b("hero", {
    badge: "Standalone HRM SaaS Platform",
    title: "One Platform to Run Your Entire Workforce",
    sub: "Employee management, attendance with selfie & GPS verification, live tracking, payroll & AIT, leave, performance, inventory and analytics — in one multi-tenant workspace.",
    bullets: [
      "ZKTeco devices push check-ins as they happen",
      "Selfie + GPS proof on every mobile check-in",
      "Payroll with AIT, PF and payslips built in",
    ],
    stats: [
      { value: "14", label: "approval workflow types" },
      { value: "12+", label: "HR modules in one workspace" },
      { value: "8+", label: "statutory BD leave types" },
      { value: "1", label: "sign-in for your whole team" },
    ],
  }),
  b("value-props", {
    title: "Why teams choose Finix HR",
    items: [
      { icon: "layers", title: "One Platform", body: "People, attendance, payroll, leave, tracking, inventory and analytics run in one system with one sign-in — not a bundle of disconnected tools." },
      { icon: "building", title: "Multi-Tenant by Design", body: "Every organization's data is isolated per tenant. Tenant users can only ever reach their own company's records — enforced on every query." },
      { icon: "activity", title: "Real-Time Visibility", body: "Attendance, device health, live tracking and workforce activity are visible as they happen, with security signals for GPS-disabled or spoof-suspect check-ins." },
      { icon: "shield", title: "Secure by Design", body: "Role-based access control, MFA, CSRF protection, audit trails and rate limiting are built in — not bolted on after the fact." },
      { icon: "scaling", title: "Scales With You", body: "Plans and feature access grow with the organization: employee seats, branch counts, device counts and module entitlements are enforced transparently." },
    ],
  }),
  b("features", {
    eyebrow: "One platform",
    title: "Everything your HR team runs, in one system",
    sub: "Each module below exists in the shipped product today — nothing on this page is a promise about the future.",
    source: "cms-features",
  }),
  b("feature-demo", {
    featureSlug: "all-in-one-dashboard",
    eyebrow: "All in One Dashboard",
    title: "Your entire workforce, on one screen",
    sub: "A live command center — KPI cards, attendance and payroll summaries, charts, pending tasks and activity — computed from real tenant data.",
    flip: false,
  }),
  b("clients", {
    title: "Valued clients run their workforce on Finix HR",
    sub: "Organizations across manufacturing, logistics, retail, healthcare, construction and software trust Finix HR for daily HR operations.",
    layout: "grid",
    showStories: true,
  }),
  b("testimonials", {
    title: "What HR teams say",
    sub: "Real operators, real workflows — from device check-ins to payroll close.",
  }),
  b("how-it-works", {
    title: "From application to workspace in four steps",
    sub: "Every organization on the platform goes through the same transparent review — you always know exactly where your application stands.",
    steps: [
      { step: "1", title: "Register your organization", body: "Submit your organization profile, primary administrator and the modules you need. It takes about five minutes — no payment information." },
      { step: "2", title: "Choose a subscription plan", body: "Pick a plan and a monthly or yearly billing cycle, matched to your expected headcount, branches and devices. Plans can be changed later." },
      { step: "3", title: "Platform review & approval", body: "The platform team reviews the application, may ask a clarifying question, then approves it. You can track the status anytime with your Application ID." },
      { step: "4", title: "Your HR workspace goes live", body: "On approval your workspace is provisioned instantly with statutory configuration. Sign in with the administrator email and password you chose at registration." },
    ],
  }),
  b("cta", {
    title: "Start Your HR Journey",
    sub: "Register your organization in about five minutes. No payment information — a platform administrator reviews every application before workspaces go live.",
    primaryLabel: "Register your organization",
    primaryHref: "/register",
    secondaryLabel: "View pricing",
    secondaryHref: "/pricing",
    note: "Already applied? Track your application status anytime.",
  }),
]

// ---- system pages defaults ------------------------------------------------------------------
export const DEFAULT_PAGES = [
  {
    slug: "home",
    title: "Home",
    pageType: "HOME",
    navLabel: "Home",
    showInNav: false,
    isSystem: true,
    blocks: DEFAULT_HOME_BLOCKS,
    seoTitle: null as string | null,
    seoDesc: null as string | null,
  },
  {
    slug: "about",
    title: "About Finix HR",
    pageType: "SYSTEM",
    navLabel: "About",
    showInNav: false,
    isSystem: true,
    blocks: [],
    seoTitle: "About Finix HR",
    seoDesc: "Finix HR builds workforce software for organizations that run on operational truth.",
  },
  {
    slug: "faq",
    title: "Frequently Asked Questions",
    pageType: "SYSTEM",
    navLabel: "FAQ",
    showInNav: false,
    isSystem: true,
    blocks: [],
    seoTitle: "FAQ — Finix HR",
    seoDesc: "Answers about plans, modules, device integration, security and data ownership.",
  },
  {
    // Wave 2 WP-P — the public careers page. The route at /careers renders the
    // live listing of published tenant openings; THIS record is the page's
    // visibility toggle in the owner console (unpublish / hide → the route
    // 404s) and carries its SEO overrides. Blocks on it are not rendered —
    // the board is dynamic data, not static CMS content.
    slug: "careers",
    title: "Careers",
    pageType: "SYSTEM",
    navLabel: "Careers",
    showInNav: false,
    isSystem: true,
    blocks: [],
    seoTitle: "Careers — Open Positions",
    seoDesc: "Open positions at organizations running on Finix HR — apply online with your CV; every application reaches the hiring team directly.",
  },
]
