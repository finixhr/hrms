// ============ Feature pages & feature-grid data (marketing copy) ============
// RULE (master prompt §1): every item below must exist in the shipped HRM.
// "Coming soon" is used ONLY where the repository does not support the claim
// (e.g. Hikvision ISAPI is foundation-only).

export type FeatureLink = { label: string }

export type FeaturePage = {
  slug: string
  title: string
  navLabel: string
  headline: string
  sub: string
  problem: string[]
  solution: string[]
  capabilities: { title: string; items: string[] }[]
  workflow: { title: string; body: string }[]
  security: string[]
  cta: { primary: string; secondary: string }
}

export const FEATURE_PAGES: FeaturePage[] = [
  {
    slug: "employee-management",
    title: "Employee Management",
    navLabel: "Employee Management",
    headline: "Every person, one organized record",
    sub: "A full 360° profile for every employee — identity, family, education, previous employment, documents, bank accounts, history — with an immutable lifecycle trail.",
    problem: [
      "Employee information lives in spreadsheets that drift out of date the moment someone is promoted, transferred or exits.",
      "HR teams lose hours reconciling paper documents with digital records, and expiry dates (NID, passport, contracts) surface only when something breaks.",
      "When an employee leaves, the knowledge of what they owned, earned and signed off walks out with them.",
    ],
    solution: [
      "A structured employee directory with codes, photos, thumbnails and search — scoped so managers only see the people they manage.",
      "Employee 360° pages aggregate every fact: personal and official details, family, education, referees, previous employment, bank accounts, documents with expiry tracking and verification states.",
      "Lifecycle events — promotions, transfers, salary revisions, exits — are recorded immutably, so history can never be quietly rewritten.",
    ],
    capabilities: [
      {
        title: "Core",
        items: ["Employee Directory with search & filters", "Employee 360° profile", "Employee code sequences (EMP-0001)", "Photo + thumbnail pipeline", "Employee Self-Service portal", "Global search across people"],
      },
      {
        title: "Organization",
        items: ["Branches", "Departments with branch mapping", "Designations", "Shifts & roster assignment", "Organization chart", "Reporting structure via manager maps"],
      },
      {
        title: "Records & documents",
        items: ["Employee documents (NID, passport, contracts…) with expiry states", "Family information", "Education records with certificates", "Previous employment", "Bank accounts (multi-account)", "Employee history (append-only)"],
      },
      {
        title: "Lifecycle",
        items: ["Transfers", "Promotions", "Salary revisions", "Resignation & exit clearance", "Final settlement", "HR letters with signatory & seal"],
      },
    ],
    workflow: [
      { title: "Add", body: "Create the employee with auto-generated code, branch/department/designation, joining date and optional initial salary structure — one atomic operation." },
      { title: "Enrich", body: "Attach documents with server-side file validation, family and education records, bank accounts; verify documents with an audit trail." },
      { title: "Run the lifecycle", body: "Promotions, transfers and salary revisions write immutable history; every change is audit-logged with before/after values." },
      { title: "Exit cleanly", body: "Resignation → approval workflow → exit clearance → final settlement, with payslips and letters generated from the same record." },
    ],
    security: [
      "Records are vendor-scoped on every query; cross-tenant ids resolve to 404, never 403.",
      "Branch and department managers see only their own scope.",
      "Document downloads and selfie evidence are permission-gated and audit-logged.",
      "PII is scrubbed from audit diffs before storage.",
    ],
    cta: { primary: "Register your organization", secondary: "View pricing" },
  },
  {
    slug: "attendance",
    title: "Attendance",
    navLabel: "Attendance",
    headline: "Attendance you can actually trust",
    sub: "Shifts, overtime and corrections — with geo-fencing, GPS verification, selfie proof and integrity signals that flag spoofing before payroll consumes the data.",
    problem: [
      "Paper or proxy attendance means payroll pays for hours that never happened.",
      "Manual corrections are invisible — nobody can tell who changed what, when, or why.",
      "Devices and manual entries disagree, and reconciling them eats the first day of every payroll cycle.",
    ],
    solution: [
      "Device events, manual entries and corrections land in ONE attendance ledger per employee per day, with a clear provenance for every state change.",
      "Attendance policies attach geo-fences, check-in windows, and required proofs per branch/department — evaluated server-side.",
      "Corrections flow through an approval workflow with reason codes; the original value, the corrected value and the approver are all retained.",
    ],
    capabilities: [
      { title: "Time & shifts", items: ["Attendance management", "Shift management & roster assignment", "Overtime management", "Attendance corrections with approvals", "Attendance history", "Holiday calendar"] },
      { title: "Verification & security", items: ["Geo-fence attendance", "GPS verification", "Selfie attendance proof (private, permission-gated)", "GPS-disabled alerts", "Low-battery alerts", "Location spoof detection", "Mandatory GPS policies"] },
      { title: "Device events", items: ["ZKTeco ADMS push ingestion", "Historical attendance synchronization", "Device health & communication logs", "Attendance security events", "Periodic verification"] },
      { title: "Reporting", items: ["Attendance overview reports", "Attendance export (Excel)", "Security signal queues for review", "Employee self-service attendance view"] },
    ],
    workflow: [
      { title: "Define policy", body: "Create attendance policies: geo-fence, check-in/out windows, overtime rules, required proofs. Assign per branch or department." },
      { title: "Capture", body: "Events arrive from ADMS devices, the self-service portal, or HR — each tagged with its source. Selfies are stored privately with tamper-evident hashes." },
      { title: "Review signals", body: "Security events (GPS disabled, outside fence, low battery, suspicious patterns) queue for review — never auto-punitive, always visible." },
      { title: "Correct & approve", body: "Corrections go through the approval engine with reasons; approved values feed payroll, and the trail shows both sides forever." },
    ],
    security: [
      "Selfie evidence is private: viewing requires attendance.selfie.view and is audit-logged.",
      "Every event carries device/user provenance and, where relevant, coordinates, accuracy and battery.",
      "Corrections are workflow-approved; the audit log records before/after values.",
      "Device plane (/iclock) is protocol-authenticated and separate from the application API.",
    ],
    cta: { primary: "Register your organization", secondary: "See device integration" },
  },
  {
    slug: "live-tracking",
    title: "Live Employee Tracking",
    navLabel: "Live Tracking",
    headline: "Field visibility, with consent and control",
    sub: "Real-time employee location for assigned branches, departments or individuals — scheduled, geo-fenced, and battery/GPS aware, with a complete history and movement maps.",
    problem: [
      "Field teams are invisible — dispatchers don't know who is actually at the site.",
      "When tracking is done with consumer chat apps, there is no boundary, no schedule and no record.",
      "Privacy is either ignored or handled by turning everything off.",
    ],
    solution: [
      "Tracking is explicitly enabled per employee by an administrator, with the employee notified in-app when it starts.",
      "Policies define WHEN tracking applies (schedule) and WHERE (geo-fence); outside the policy window no points are collected.",
      "Every point carries battery, GPS status, accuracy and network state — so review is based on facts, not guesses.",
    ],
    capabilities: [
      { title: "Live view", items: ["Live employee location map", "Branch/department/employee assignment", "Tracking policies (schedule + fence)", "Battery percentage", "GPS status", "Network status"] },
      { title: "History & evidence", items: ["Tracking history", "Movement maps", "Tracking security events (GPS-disabled, low battery, outside fence)", "Session start/stop trail"] },
      { title: "Controls", items: ["Admin start/stop per employee", "Employee notification on enable", "Policy assignment (branch/department/individual)", "Periodic verification"] },
    ],
    workflow: [
      { title: "Assign", body: "Create a tracking policy: applicable window (days/hours), geo-fence, target branch/department/employees." },
      { title: "Enable", body: "An administrator starts tracking for an employee; the employee is notified in-app, and the action is audit-logged." },
      { title: "Monitor", body: "The live map shows current positions with battery/GPS badges; security events queue for review." },
      { title: "Audit", body: "History and movement maps reconstruct any working day; every state change is on the record." },
    ],
    security: [
      "Tracking requires the tracking.manage permission and is per-employee explicit — no blanket surveillance.",
      "The employee is notified in-app when tracking starts.",
      "Points are retained as evidence with retention controls (retentionUntil).",
      "Battery/GPS/network states are recorded as signals, not punishments.",
      "This page describes tracking of employees with notice; it is not a claim of lawful basis for any deployment — organizations set their own policy.",
    ],
    cta: { primary: "Register your organization", secondary: "View pricing" },
  },
  {
    slug: "payroll",
    title: "Payroll & Finance",
    navLabel: "Payroll",
    headline: "Payroll that reconciles itself",
    sub: "Salary structures, payroll runs, payslips, loans, advances, expenses, AIT and provident fund — computed on the same attendance and leave data your organization already runs on.",
    problem: [
      "Every payroll cycle is a spreadsheet marathon: attendance here, leave there, advances somewhere else.",
      "AIT rules change and slabs are misapplied; year-end corrections are painful.",
      "Salary payouts are tracked in three places and none of them agree.",
    ],
    solution: [
      "Payroll runs consume the platform's own attendance and leave data; basic-to-gross structures with revisions are versioned.",
      "AIT is computed by the statutory engine (FY 2025-26 taxpayer categories and slabs) with a calculation log per entry.",
      "Payouts support bank/cash/MFS with export sheets; loans and advances recover with over-recovery protection.",
    ],
    capabilities: [
      { title: "Core payroll", items: ["Salary structures (basic-to-gross)", "Payroll runs with state machine", "Payroll entries per employee", "Payslips (PDF, email, bulk)", "Salary export (bank/cash/MFS)", "Bonus & commission rules"] },
      { title: "Money items", items: ["Loans with installments & over-recovery guard", "Advances", "Expense claims with approvals", "Reimbursements", "Salary revisions (history preserved)"] },
      { title: "Statutory (Bangladesh)", items: ["AIT / Income Tax engine", "Tax rule sets, slabs & exemptions", "AIT fiscal years", "AIT calculation log", "AIT certificates", "Provident Fund (enrollment + contributions)"] },
      { title: "Accounting", items: ["Accounting journals per run", "Payslip email delivery via gateway", "Payout validation & export engine"] },
    ],
    workflow: [
      { title: "Structure", body: "Define salary templates and per-employee structures; revisions create a new version, never overwrite." },
      { title: "Run", body: "Create a payroll run for a period; the engine computes from attendance, leave, loans, advances and AIT." },
      { title: "Approve", body: "Runs go through the approval workflow; approvals are recorded with actor and timestamp." },
      { title: "Pay & export", body: "Mark payouts (bank/cash/MFS), export the payout sheet, email payslips — every step audit-logged." },
    ],
    security: [
      "Payroll actions are permission-gated (payroll.process, payroll.approve, payroll.pay).",
      "Payslip PDFs are generated server-side; downloads are audit-logged.",
      "Money values use paisa-precision dual-write to avoid rounding drift.",
      "AIT calculation logs preserve every computed entry for audit.",
    ],
    cta: { primary: "Register your organization", secondary: "View pricing" },
  },
  {
    slug: "leave-management",
    title: "Leave & Employee Self-Service",
    navLabel: "Leave & Self-Service",
    headline: "Leave without the paperwork",
    sub: "Statutory leave types, balances, applications with attachments, substitutes, approval workflows and encashment — plus a self-service portal employees actually use.",
    problem: [
      "Leave applications arrive by chat and phone; balances are maintained by memory.",
      "Approvers are out of office and everything stalls.",
      "HR becomes a relay station for questions like “how many days do I have left?”",
    ],
    solution: [
      "Employees apply from the self-service portal with attachments; balances are computed server-side, never trusted from the client.",
      "Approval workflows route to managers with substitutes when the primary approver is away; every action is recorded.",
      "Balances, encashment and carry-forward follow the policy configured per leave type.",
    ],
    capabilities: [
      { title: "Leave", items: ["Leave types with statutory defaults (BD)", "Leave balances per year", "Leave applications with attachments", "Approval workflows with substitutes", "Holiday handling", "Leave encashment", "Carry-forward policy"] },
      { title: "Self-service portal", items: ["My profile & 360°", "My attendance", "My payslips", "My leave balances & applications", "My loans", "My expenses", "My tasks & performance", "Announcements & notifications", "Wishes & company events"] },
    ],
    workflow: [
      { title: "Configure", body: "Leave types ship with Bangladesh statutory defaults; adjust days, carry-forward, encashment and waiting periods." },
      { title: "Apply", body: "Employee applies in the portal (attachment when required); the server computes the day count — the client's number is ignored." },
      { title: "Approve", body: "Workflows route to the right approver; substitutes act when the primary is away; delegation is explicit." },
      { title: "Consume", body: "Approved leave writes attendance LEAVE rows so payroll picks it up automatically; balances update in place." },
    ],
    security: [
      "Self-service actions are employee-scoped server-side — a user can only ever act on their own record.",
      "Attachments are byte-validated (magic bytes) and size-capped.",
      "Approvals and rejections are audit-logged with the approver identity.",
    ],
    cta: { primary: "Register your organization", secondary: "View pricing" },
  },
  {
    slug: "device-integration",
    title: "Attendance Device Integration",
    navLabel: "Device Integration",
    headline: "ZKTeco ADMS, done properly",
    sub: "Devices push to the platform over the ADMS protocol: registration, live events, commands, health monitoring and historical synchronization — with Hikvision ISAPI support as a foundation.",
    problem: [
      "Attendance devices export CSVs someone has to fetch, merge and clean — every single day.",
      "When a device goes offline, nobody notices until payroll.",
      "Comm keys and device secrets end up in chat messages.",
    ],
    solution: [
      "Devices push directly to the platform's /iclock endpoint (ADMS protocol) — no CSV round-trips, no polling.",
      "Device health, communication logs and command queues make offline devices visible immediately.",
      "Comm keys are enrolled per device and shown once; access is write-only from then on.",
    ],
    capabilities: [
      { title: "ZKTeco ADMS / Push", items: ["Device registration (SN)", "Live event ingestion", "Historical attendance synchronization", "Device commands (info, restart…)", "Device health & status", "Device communication logs", "Per-device rate limiting", "Employee push to devices (ADMS user sync)"] },
      { title: "Security", items: ["Comm key enrollment (shown once)", "Keyless-device policy per tenant", "SN rate limits", "Protocol plane isolated from the app API", "Device events with provenance"] },
      { title: "Hikvision ISAPI", items: ["ISAPI foundation (deviceInfo, streamData endpoints)", "ISAPI freshness window checks", "Listed as foundation — full integration marked Coming Soon where the repository does not yet support it"] },
    ],
    workflow: [
      { title: "Register", body: "Add the device with its serial number; choose the branch, protocol (ADMS default) and timezone." },
      { title: "Connect", body: "Point the device at the platform's /iclock endpoint; it pushes CHECK-IN/OUT events with photos when supported." },
      { title: "Monitor", body: "Health dashboard shows ONLINE/OFFLINE with thresholds; communication logs answer “did it send?” definitively." },
      { title: "Synchronize", body: "Historical sync backfills missed ranges; employee rosters push to devices automatically." },
    ],
    security: [
      "The device plane is a separate route family with its own authentication and rate limits.",
      "Comm keys are never returned by any API after enrollment.",
      "Keyless devices are rejected until the tenant explicitly allows them.",
      "Raw protocol lines are redacted in logs (employee names masked) unless diagnostics are explicitly enabled.",
    ],
    cta: { primary: "Register your organization", secondary: "View pricing" },
  },
  {
    slug: "performance",
    title: "Performance & KPI",
    navLabel: "Performance",
    headline: "Reviews that run on records, not vibes",
    sub: "Review cycles, KPI templates, assignments and structured reviews — connected to the employee's own history, not a parallel spreadsheet.",
    problem: [
      "Performance reviews happen once a year in documents nobody can find afterwards.",
      "KPIs are set verbally; scoring is inconsistent between managers.",
      "History is lost between cycles, so “improvement” is a matter of opinion.",
    ],
    solution: [
      "KPI templates define measurable indicators once; assignments apply them per employee or department.",
      "Review cycles structure the process with states and deadlines; reviews record scores with the reviewer identity.",
      "The employee's performance history accumulates across cycles inside their 360° profile.",
    ],
    capabilities: [
      { title: "KPI", items: ["KPI templates", "KPI assignments (employee/department)", "Measurable indicators with targets"] },
      { title: "Reviews", items: ["Review cycles", "Performance reviews with scoring", "Performance history on the 360° profile", "Approval workflow integration"] },
    ],
    workflow: [
      { title: "Define", body: "Create KPI templates with indicators and targets; assign to employees or whole departments." },
      { title: "Cycle", body: "Open a review cycle; reviewers score assigned KPIs inside the employee's record." },
      { title: "Decide", body: "Reviews route through approvals; outcomes are recorded with reviewer identity." },
      { title: "Retain", body: "Every cycle remains on the profile — visible in context with attendance, leave and payroll facts." },
    ],
    security: [
      "Performance actions are permission-gated (performance.view/create/edit/approve).",
      "Review scores are audit-logged; managers see only their scope.",
    ],
    cta: { primary: "Register your organization", secondary: "View pricing" },
  },
  {
    slug: "inventory-procurement",
    title: "Inventory & Procurement",
    navLabel: "Inventory & Procurement",
    headline: "Requisition to stock, on the record",
    sub: "Purchase requests, quotations, goods receipt, warehouses, stock levels and suppliers — with approval workflows and full history for every requisition.",
    problem: [
      "Purchase requests live in inboxes; approval status is a matter of memory.",
      "Stock counts are wrong because entries and issues are tracked separately.",
      "Nobody can reconstruct why a purchase was approved or at what price.",
    ],
    solution: [
      "Requisitions are structured records with line items, quotations and an approval workflow — status is always visible.",
      "Goods receipt writes stock transactions; levels are computed from the ledger, not maintained by hand.",
      "Suppliers, warehouses and items are first-class entities with their own histories.",
    ],
    capabilities: [
      { title: "Procurement", items: ["Purchase requests with line items", "Purchase quotations", "Quotation comparison", "Goods requisition workflow", "Approval history per requisition"] },
      { title: "Inventory", items: ["Warehouses", "Items", "Stock levels (computed)", "Stock transactions (ledger)", "Stock entries (receive/issue)", "Suppliers"] },
    ],
    workflow: [
      { title: "Request", body: "A department raises a purchase request with items and quantities." },
      { title: "Quote & approve", body: "Quotations are recorded; the workflow routes the request for approval with the full context." },
      { title: "Receive", body: "Goods receipt confirms delivery and writes stock transactions into the ledger." },
      { title: "Track", body: "Stock levels update in real time; the requisition history shows every step and actor." },
    ],
    security: [
      "Procurement actions are permission-gated (procurement.view/create/approve).",
      "Requisition history is append-only.",
      "Stock transactions are ledger entries — never destructive updates.",
    ],
    cta: { primary: "Register your organization", secondary: "View pricing" },
  },
  {
    slug: "hr-letters",
    title: "HR Letters",
    navLabel: "HR Letters",
    headline: "Official letters, minutes not hours",
    sub: "Nineteen letter types from appointment to relieving — generated from employee data, routed through approval workflows, issued to the portal, email or print with the company letterhead, seal and signature.",
    problem: [
      "Every appointment, salary certificate or NOC starts from an old Word file someone edited last year.",
      "Letters go out without sign-off because the approval step lives in someone's inbox.",
      "There is no register of what was issued, to whom, or how many times it was downloaded.",
    ],
    solution: [
      "Templates render with employee variables — designation, salary, dates — straight from the employee 360° record.",
      "Sensitive letter types are approval-gated by default: generate, submit, approve, then issue — with the full state trail.",
      "Every issued letter gets a sequential number, an immutable snapshot of its content and a download counter.",
    ],
    capabilities: [
      { title: "Letter types", items: ["Appointment & confirmation", "Probation extension", "Salary & employment certificates", "Experience & relieving letters", "Increment, promotion & transfer", "Warning, show-cause & suspension", "Termination & resignation acceptance", "NOC and custom types"] },
      { title: "Template studio", items: ["Letter templates with variables", "Per-template signatory", "Approval-required flag", "Active/inactive templates", "Vendor letterhead, seal & signature"] },
      { title: "Issuance", items: ["Sequential letter numbers (L-YYYY-NNNN)", "Approval workflow for sensitive types", "Portal, email and print delivery", "Issued-letter register with statuses", "Download audit with reason capture"] },
    ],
    workflow: [
      { title: "Template", body: "Pick a type, write the body once with variables, set the signatory and whether approval is required." },
      { title: "Generate", body: "Select the employee and effective date; the platform resolves every variable from the employee record into a draft." },
      { title: "Approve", body: "Mandatory types route through the approval engine — HR review to management approval — before anything is issued." },
      { title: "Issue", body: "Deliver to the employee portal, email the print-ready document, or print from the browser; every download is counted and audited." },
    ],
    security: [
      "Letter generation, approval and download are separately permission-gated (letters.generate / approve / download).",
      "Sensitive letter types require an audited reason before download.",
      "Letter content is snapshotted at issuance — later template edits never rewrite what an employee received.",
    ],
    cta: { primary: "Register your organization", secondary: "View pricing" },
  },
  {
    slug: "communication-hub",
    title: "Email, SMS & Announcements",
    navLabel: "Communication",
    headline: "Every message, one auditable channel",
    sub: "Broadcast announcements, compose targeted email and SMS blasts, and automate event notifications — with delivery logs, recipient-level status and editable system templates.",
    problem: [
      "Company news goes out over personal WhatsApp groups nobody can search later.",
      "HR sends the same salary and leave emails by hand, every time.",
      "When a message 'didn't arrive', there is no evidence of what was sent, to whom, or why it failed.",
    ],
    solution: [
      "Announcements publish to the whole company or targeted audiences, pinned and visible in the employee portal.",
      "Compose email/SMS blasts by branch, department, designation or specific employees — with per-recipient delivery status.",
      "Event notifications (leave decisions, payslips, document expiry, wishes) fire automatically through editable system templates.",
    ],
    capabilities: [
      { title: "Broadcast", items: ["Company announcements with pinning", "Audience targeting (branch / department / designation / specific)", "Email + SMS with in-app mirror", "Variable personalization ({{name}}, {{company}})"] },
      { title: "Automation", items: ["Event-triggered email & SMS", "Editable system templates per event", "Birthday & anniversary wishes", "Document-expiry reminders", "Attendance alerts to HR"] },
      { title: "Evidence", items: ["Delivery log per send (sent / failed / skipped)", "Recipient-level detail", "Gateway status cards", "Communication history"] },
    ],
    workflow: [
      { title: "Connect", body: "Configure the SMTP email gateway and the SMS gateway (URL-template based) under HR Settings — secrets are encrypted at rest." },
      { title: "Compose", body: "Write the message once, choose the audience, and send through a background job that fans out per recipient." },
      { title: "Automate", body: "Pick the events and channels in the notification matrix; edit the system templates' wording to match your tone." },
      { title: "Verify", body: "Open the delivery log to see exactly who received what, through which channel, and why anything was skipped." },
    ],
    security: [
      "Gateway credentials are write-only and encrypted at rest; they are never returned by any API.",
      "Outbound URLs are validated against SSRF (public hosts only, https enforced).",
      "Every automated and manual send is recorded in the communication log with recipient status.",
    ],
    cta: { primary: "Register your organization", secondary: "View pricing" },
  },
  {
    slug: "tasks-approvals",
    title: "Tasks, Approvals & Workflows",
    navLabel: "Tasks & Approvals",
    headline: "Work that actually gets closed",
    sub: "A task board with checklists and comments, a unified approval queue for every request type, and a configurable workflow engine with delegation — so nothing waits on one person's inbox.",
    problem: [
      "HR to-dos live in notebooks and chat threads; nothing has an owner or a due date.",
      "Leave, loan, expense and correction requests arrive through five different channels.",
      "Approvals stall when the approver is on leave and nobody remembers to delegate.",
    ],
    solution: [
      "Tasks carry assignees, due dates, priorities, checklists and comment threads — with a personal board in self-service.",
      "One approval queue aggregates leave, loans, advances, expenses, attendance corrections, resignations and letters.",
      "Workflow steps define who approves what; substitutes and delegation keep requests moving when approvers are away.",
    ],
    capabilities: [
      { title: "Tasks", items: ["Assignees & watchers", "Due dates, priority, status", "Checklists per task", "Comment threads", "Personal board in ESS"] },
      { title: "Approvals", items: ["Unified pending queue", "Per-type approval views", "Approval history", "Bulk actions", "Delegation & substitutes"] },
      { title: "Workflow engine", items: ["Per-process approval chains", "Role-based steps", "Configurable process types (14)", "Auto-escalation via substitutes"] },
    ],
    workflow: [
      { title: "Define", body: "Configure the approval chain per process type — who reviews, who approves, in what order." },
      { title: "Submit", body: "Employees and HR submit requests; each lands in the queue of the right approver, not an inbox." },
      { title: "Act", body: "Approvers approve or reject with reasons from the queue; delegates act when the primary is away." },
      { title: "Track", body: "History keeps every decision with its actor and timestamp — visible for audits and disputes." },
    ],
    security: [
      "Approval actions are permission-gated per module and fully audit-logged with before/after values.",
      "Delegation is explicit, time-bounded and visible — not a shared password.",
      "Tasks and approvals are scoped: managers only see their own organization unit's requests.",
    ],
    cta: { primary: "Register your organization", secondary: "View pricing" },
  },
  {
    slug: "exit-management",
    title: "Exit & Offboarding",
    navLabel: "Exit Management",
    headline: "Offboarding as organized as joining",
    sub: "Resignation submission, notice-period tracking, clearance workflows, full-and-final settlement with provident-fund and leave encashment — and the biometric deactivation that actually happens.",
    problem: [
      "Resignations arrive verbally; notice dates and last-working-day are disputed later.",
      "Clearance becomes a scavenger hunt across IT, accounts and the department head.",
      "Ex-employees keep their device PINs and portal access for months.",
    ],
    solution: [
      "Employees submit resignations from self-service; HR tracks notice period with proposed and actual last working days.",
      "The exit checklist drives clearance, asset returns and dues — with settlement computed from salary, loans, PF and leave encashment.",
      "On the last working day the platform deactivates device mappings and portal access automatically.",
    ],
    capabilities: [
      { title: "Resignation", items: ["ESS submission", "Notice period with modes", "Proposed vs actual LWD", "Approval chain"] },
      { title: "Settlement", items: ["Full & final computation", "Loan & advance adjustments", "Provident fund payout", "Leave encashment"] },
      { title: "Offboarding", items: ["Exit checklist", "Employee status automation", "Device user deactivation on LWD", "Immutable employment history"] },
    ],
    workflow: [
      { title: "Submit", body: "The employee resigns from the portal; the request routes to HR with the notice period applied from settings." },
      { title: "Review", body: "HR and management review, negotiate the last working day and record the accepted terms." },
      { title: "Settle", body: "The settlement sheet computes salary, dues, loans, PF and encashment in one place for sign-off." },
      { title: "Close", body: "On the LWD the platform flips the employee status, disables biometric mappings and archives the record." },
    ],
    security: [
      "Exit actions are permission-gated and every status change is audit-logged.",
      "Settlement figures are computed server-side from the payroll ledger — never trusted from the client.",
      "The employment history is immutable: the exit story stays attached to the employee record forever.",
    ],
    cta: { primary: "Register your organization", secondary: "View pricing" },
  },
  {
    slug: "workforce-calendar",
    title: "Company Calendar",
    navLabel: "Company Calendar",
    headline: "One calendar for the whole workplace",
    sub: "Holidays, company events, birthdays, work anniversaries and leave visibility in a single month view — the shared source of truth HR and managers actually open every morning.",
    problem: [
      "Holidays are announced by memo and then argued about for the rest of the year.",
      "Managers schedule meetings on days half the team is on leave.",
      "Nothing reminds anyone of work anniversaries or the company event next week.",
    ],
    solution: [
      "A month-grid calendar shows holidays, events, celebrations and who is on leave — filterable per viewer role.",
      "Holiday management ships with Bangladesh defaults, supports optional holidays and branch-specific overrides.",
      "Birthdays, anniversaries and company events render automatically from employee data and HR's own event list.",
    ],
    capabilities: [
      { title: "Calendar", items: ["Month grid view", "Holidays & optional holidays", "Company events", "Birthdays & anniversaries", "Leave visibility"] },
      { title: "Holiday management", items: ["Bangladesh statutory defaults", "Branch-specific holidays", "Optional holiday limits", "Bulk import & export"] },
      { title: "Connections", items: ["Attendance honoring holidays", "Payroll holiday handling", "Leave encashment rules", "Weekly-off policy"] },
    ],
    workflow: [
      { title: "Plan", body: "Load the year's holidays (defaults included), add company events, and mark the optional holidays employees can pick from." },
      { title: "View", body: "The calendar renders each month with everything in one grid — filtered to what your role may see." },
      { title: "Connect", body: "Attendance marks holidays automatically; payroll and encashment rules consume the same holiday table." },
      { title: "Celebrate", body: "Birthday and anniversary wishes fire on the day through the communication engine — no manual reminders." },
    ],
    security: [
      "Leave visibility on the calendar is scope-aware — managers see their unit, not the whole company.",
      "Holiday edits are permission-gated and audit-logged.",
      "Employee personal dates are shown only to roles allowed to see the directory.",
    ],
    cta: { primary: "Register your organization", secondary: "View pricing" },
  },
  {
    slug: "security",
    title: "Security & Control",
    navLabel: "Security",
    headline: "Security that is enforced, not promised",
    sub: "Multi-tenant isolation, RBAC with custom roles, MFA, audit trails, approval workflows, rate limiting and attendance integrity controls — the same controls on every page, not a marketing page.",
    problem: [
      "Vendors say “secure”; you find out what that means after the incident.",
      "Shared admin accounts mean no accountability.",
      "Security reviews turn into archaeology because there is no trail.",
    ],
    solution: [
      "Every query is tenant-scoped at the data layer — a user of one organization can never address another's records, even with a valid id.",
      "Authorization is enforced server-side per action on every API call; the interface hiding buttons is convenience, never the control.",
      "The audit trail records actor, action, target, before/after, reason and IP for every sensitive operation.",
    ],
    capabilities: [
      { title: "Identity & access", items: ["Role-based access control (7 system roles)", "Custom roles with granular permissions", "Per-action server-side enforcement", "Branch/department scope limits", "MFA (TOTP) with recovery codes", "Password policies, expiry & lockout", "Session policy with concurrent-session caps"] },
      { title: "Audit & control", items: ["Audit trail for every sensitive action", "Approval workflows (14 process types)", "Approval delegation with windows", "Rate limiting on auth surfaces", "Security events (attendance & tracking)", "CSRF protection (double-submit + origin allowlist)", "Content-Security-Policy with per-request nonces"] },
      { title: "Tenant isolation", items: ["Row-level multi-tenancy on every model", "Cross-tenant ids resolve to 404 (no enumeration oracle)", "Structural composite unique keys", "Vendor-scoped settings & notifications"] },
    ],
    workflow: [
      { title: "Assign roles", body: "Start from system role templates; create custom roles with exactly the permissions each team needs." },
      { title: "Require MFA", body: "Require TOTP for privileged roles; unenrolled admins walk a first-login enrollment wizard." },
      { title: "Route approvals", body: "Approval workflows gate leave, loans, payroll, letters, promotions, purchases — with substitutes and delegation." },
      { title: "Review the trail", body: "The audit view answers who/what/when/why with before/after values and export." },
    ],
    security: [
      "This page IS the security documentation: every claim above maps to a control in the shipped product.",
      "No claim of compliance certification is made. Controls are listed factually so your security team can verify them.",
    ],
    cta: { primary: "Register your organization", secondary: "Contact us" },
  },
  {
    slug: "reports-analytics",
    title: "Reports & Analytics",
    navLabel: "Reports & Analytics",
    headline: "Numbers your organization can act on",
    sub: "Attendance overview reports, workforce analytics, HR dashboards and exportable results — computed from live data, with no fabricated statistics.",
    problem: [
      "Reports are built by hand each month and are stale by the time they're read.",
      "“Analytics” dashboards show vanity numbers disconnected from operations.",
      "Exporting anything means a developer.",
    ],
    solution: [
      "Reports run over live platform data with filters; exports produce Excel sheets directly.",
      "HR analytics aggregates headcount, attendance and payroll facts — real rows, real counts.",
      "The dashboard is the first screen: today's attendance, pending approvals and workforce KPIs.",
    ],
    capabilities: [
      { title: "Reports", items: ["Attendance overview reports", "HR reports with filters", "Excel export", "Payslip & salary exports", "Audit export"] },
      { title: "Analytics", items: ["HR dashboard KPIs", "Headcount analytics", "Analytics charts (dashboard & camera)", "Real counts from real data — never invented statistics"] },
    ],
    workflow: [
      { title: "Open", body: "The HR dashboard lands on sign-in with today's state." },
      { title: "Filter", body: "Reports accept the same filters managers use elsewhere (branch, department, period)." },
      { title: "Export", body: "One click produces the Excel sheet — no developer involved." },
      { title: "Trust", body: "Where the deployment has no data yet, the platform shows zero or “no data yet” — never fabricated numbers." },
    ],
    security: [
      "Reports and analytics are permission-gated (reports.view/export, analytics.view).",
      "Exports are audit-logged.",
      "Analytics never mixes demo/illustrative data into production figures.",
    ],
    cta: { primary: "Register your organization", secondary: "View pricing" },
  },
]

export function featurePageBySlug(slug: string): FeaturePage | undefined {
  return FEATURE_PAGES.find((p) => p.slug === slug)
}

// ---- landing feature-grid groups (compact form for the home page) ----------
// 2026-10 module-consistency round — every tenant module now has a landing
// presence; groups link to the matching feature page.
export const LANDING_FEATURE_GROUPS: { title: string; items: string[]; href: string }[] = [
  {
    title: "Workforce Management",
    href: "/features/employee-management",
    items: ["Employee Directory", "Employee 360°", "Organization chart", "Branches", "Departments", "Designations", "Employee lifecycle", "Documents with expiry tracking", "Employee history (immutable)"],
  },
  {
    title: "Attendance & Time",
    href: "/features/attendance",
    items: ["Attendance", "Shifts & rosters", "Overtime", "Attendance policies", "Geo-fencing", "GPS verification", "Selfie proof", "Security monitoring & corrections"],
  },
  {
    title: "Live Employee Tracking",
    href: "/features/live-tracking",
    items: ["Real-time location", "Scheduled tracking policies", "Branch/department/employee assignment", "Geo-fence", "Battery & GPS status", "Tracking history & movement maps", "Security alerts"],
  },
  {
    title: "Payroll & Finance",
    href: "/features/payroll",
    items: ["Salary structures", "Payroll runs", "Payslips", "Bank/Cash/MFS payout & export", "Loans", "Advances", "Expenses", "AIT / Income Tax", "Provident Fund", "Accounting journals"],
  },
  {
    title: "Leave & Self-Service",
    href: "/features/leave-management",
    items: ["Leave types & balances", "Applications with attachments", "Approval workflows & substitutes", "Encashment & carry-forward", "Employee self-service portal", "Announcements & notifications"],
  },
  {
    title: "HR Letters",
    href: "/features/hr-letters",
    items: ["19 letter types", "Letter templates with variables", "Approval-gated sensitive letters", "Sequential letter register", "Portal / email / print delivery", "Download audit"],
  },
  {
    title: "Communication",
    href: "/features/communication-hub",
    items: ["Email & SMS blasts", "Audience targeting", "Delivery & recipient logs", "Event-triggered notifications", "Editable system templates", "Birthday & anniversary wishes"],
  },
  {
    title: "Tasks, Approvals & Workflows",
    href: "/features/tasks-approvals",
    items: ["Task board with checklists", "Unified approval queue", "Approval history", "Delegation & substitutes", "14 configurable process types"],
  },
  {
    title: "Exit & Offboarding",
    href: "/features/exit-management",
    items: ["ESS resignations", "Notice-period tracking", "Clearance & full-and-final", "PF & leave encashment", "Automatic device deactivation"],
  },
  {
    title: "Company Calendar",
    href: "/features/workforce-calendar",
    items: ["Month grid", "Holidays & optional holidays", "Company events", "Birthdays & anniversaries", "Leave visibility"],
  },
  {
    title: "Performance & Operations",
    href: "/features/performance",
    items: ["KPI templates & assignments", "Review cycles", "Performance reviews & history", "Procurement & purchase requests", "Warehouses & stock", "Suppliers", "Tasks"],
  },
  {
    title: "Devices & Integration",
    href: "/features/device-integration",
    items: ["ZKTeco ADMS push", "Historical sync", "Device commands & health", "Camera manager (brand hand-off)", "Hikvision ISAPI foundation"],
  },
]

export const FAQ_ITEMS: { q: string; a: string }[] = [
  {
    q: "What is this platform?",
    a: "A multi-tenant HR operations platform: employee management, attendance with verification, live tracking, payroll and AIT, leave, performance, inventory and procurement, communication, security and analytics — running as one system per organization.",
  },
  {
    q: "Is it multi-tenant?",
    a: "Yes. Each organization (tenant) has strictly isolated data. Tenant users can only ever query their own organization's records — this is enforced on every server-side query, not just hidden in the interface.",
  },
  {
    q: "How does registration approval work?",
    a: "You submit the registration form and receive an Application ID (like HRM-2026-000123). The platform team reviews it — they may ask a clarifying question — and when approved, your workspace is provisioned immediately. You can track the status anytime on the Registration Status page with your ID and email.",
  },
  {
    q: "How does pricing work?",
    a: "Plans define monthly and yearly prices plus capacity limits (employees, users, branches, departments, attendance devices, storage) and module entitlements. Prices shown on the Pricing page come from the database and are set by the platform operator — nothing is hardcoded into the website.",
  },
  {
    q: "Can I integrate ZKTeco attendance devices?",
    a: "Yes. Devices push to the platform over the ADMS protocol: registration, live events, commands, health monitoring, communication logs and historical synchronization. Comm keys are enrolled per device and never displayed again.",
  },
  {
    q: "Does it support live employee tracking?",
    a: "Yes — with explicit control. Tracking is enabled per employee by an administrator (the employee is notified in-app), governed by policies that define when (schedule) and where (geo-fence) it applies. Battery, GPS and network states are recorded as signals.",
  },
  {
    q: "Can I manage payroll and Bangladesh AIT?",
    a: "Yes. Payroll runs compute from your attendance and leave data; the AIT engine applies the statutory fiscal-year configuration (taxpayer categories and slabs) with a calculation log per entry, plus provident fund and payslip delivery.",
  },
  {
    q: "Can employees submit leave themselves?",
    a: "Yes. The self-service portal lets employees apply for leave (with attachments when required), view balances, attendance, payslips, loans, expenses and tasks — with approvals routed by workflow.",
  },
  {
    q: "Can I control which modules my team uses?",
    a: "Yes, at two levels: your plan defines which modules are included, and the platform can additionally enable or disable a specific module for your organization as an override. Both are enforced server-side.",
  },
  {
    q: "Can plans be upgraded later?",
    a: "Yes. Contact the platform administrator to change the plan, billing cycle or capacity — the change is applied by the platform team and recorded in your subscription history. The architecture also supports automated payment activation when the business adopts it.",
  },
  {
    q: "Can I use monthly or yearly billing?",
    a: "Yes — both cycles are offered (subject to what the platform currently allows). The renewal date is computed from your cycle, and upcoming renewals are visible in your subscription view.",
  },
  {
    q: "How is employee data protected?",
    a: "Tenant isolation on every query, role-based access control with custom roles, MFA for privileged roles, CSRF protection, per-request CSP nonces, rate limiting, and an audit trail with before/after values for every sensitive action. Attendance selfies are private and permission-gated; secrets (comm keys, MFA secrets, gateway credentials) are write-only.",
  },
  {
    q: "Can I manage multiple branches?",
    a: "Yes. Branches, departments and designations are first-class entities; branch managers can be scoped to their own branch, and attendance policies and tracking can be assigned per branch or department.",
  },
  {
    q: "What happens when a subscription expires?",
    a: "The workspace becomes read-only — all data stays safe and fully readable, but changes are blocked until the subscription is renewed. Data is never deleted because a subscription lapses.",
  },
]
