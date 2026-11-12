"use client"
// ============ i18n — Bangla UI labels (L1/L5 localization) ============
// Pragmatic nav-level switcher: the sidebar navigation, group headers and a
// set of common action words are translated; everything else stays English.
// Preference source: localStorage "hrm_lang" (+ mirrored to the vendor
// settings group "localization" when the user has settings.edit permission).
// Exposed as an external store via useSyncExternalStore so components can
// subscribe without setState-in-effect cascades or hydration mismatches.
import { useSyncExternalStore } from "react"

export type Lang = "en" | "bn"
export const LANG_KEY = "hrm_lang"

/** Matches the static title in src/app/layout.tsx metadata. */
export const DEFAULT_TITLE = "Finix HR — HRM Workspace"

/** Bangla translations — keys are the exact English labels used in nav.ts
 *  plus common UI action words. Unknown keys fall back to the key itself. */
export const BN: Record<string, string> = {
  // ---- navigation items (exact labels from src/hrm/nav.ts) ----
  "HR Dashboard": "এইচআর ড্যাশবোর্ড",
  "HR Calendar": "এইচআর ক্যালেন্ডার",
  "Employee Directory": "কর্মী ডিরেক্টরি",
  "Employment Lifecycle": "চাকরির জীবনচক্র",
  "My Self-Service": "আমার সেলফ-সার্ভিস",
  "Branches & Departments": "শাখা ও বিভাগ",
  // MULTI-COMPANY (2026-11-03)
  "Companies": "কোম্পানিসমূহ",
  "Switch company": "কোম্পানি পরিবর্তন",
  "Company context": "কোম্পানি প্রসঙ্গ",
  "Active company": "সক্রিয় কোম্পানি",
  "No company access — ask an administrator.": "কোনো কোম্পানির অনুমতি নেই — প্রশাসকের সাথে যোগাযোগ করুন।",
  "Consolidated reporting — read-only": "সমন্বিত রিপোর্টিং — শুধু পঠনযোগ্য",
  "All Companies is a read-only consolidated view. Switch to a company to make changes.": "সব কোম্পানি একটি শুধু-পঠনযোগ্য সমন্বিত দৃশ্য। পরিবর্তন করতে একটি নির্দিষ্ট কোম্পানিতে যান।",
  "Org Chart": "সংগঠন চার্ট",
  "Attendance & Shifts": "উপস্থিতি ও শিফট",
  // 2026-10-14 — split menus (former "Attendance & Shifts" tabs)
  "Attendance": "উপস্থিতি",
  "Shifts": "শিফট",
  "Field & Security": "ফিল্ড ও নিরাপত্তা",
  "Devices": "ডিভাইস",
  "Field & Devices": "ফিল্ড ও ডিভাইস",
  "Overtime Management": "ওভারটাইম ব্যবস্থাপনা",
  "Leave Management": "ছুটি ব্যবস্থাপনা",
  "Payroll": "বেতন",
  "Loans & Advances": "ঋণ ও অগ্রিম",
  "Expense Claims": "খরচের দাবি",
  "Reimbursements": "খরচ পরিশোধ",
  "Performance & KPI": "পারফরম্যান্স ও কেপিআই",
  "Task Management": "কাজ ব্যবস্থাপনা",
  "Approval Queue": "অনুমোদন সারি",
  "Notification Center": "বিজ্ঞপ্তি কেন্দ্র",
  "Email & SMS Center": "ইমেইল ও এসএমএস কেন্দ্র",
  "HR Announcements": "এইচআর ঘোষণা",
  "Letters & Templates": "HR চিঠি",
  "HR Letters": "HR চিঠি",
  "Exit Management": "প্রস্থান ব্যবস্থাপনা",
  "HR Reports": "এইচআর রিপোর্ট",
  "HR Analytics": "এইচআর অ্যানালিটিক্স",
  "Audit Trail": "অডিট ট্রেইল",
  "HR Settings": "এইচআর সেটিংস",
  // ---- Wave 2 (2026-10-08) ----
  "Job Center": "জব সেন্টার",
  "Subscription & Usage": "সাবস্ক্রিপশন ও ব্যবহার",
  "Asset Management": "সম্পদ ব্যবস্থাপনা",
  "Field Force": "ফিল্ড ফোর্স",
  "Recruitment": "নিয়োগ",
  "Accounting": "হিসাবরক্ষণ",
  "Billing": "বিলিং",
  // ---- Wave 4 (2026-10-08) ----
  "AI Assist": "এআই সহায়ক",
  // ---- navigation group headers (UI-R1: 7 balanced sections) ----
  "Overview": "ওভারভিউ",
  "People": "জনবল",
  "Employee Management": "কর্মী ব্যবস্থাপনা",
  "Time & Attendance": "সময় ও উপস্থিতি",
  "Payroll & Finance": "বেতন ও অর্থ",
  "Operations": "অপারেশন",
  "Communication": "যোগাযোগ",
  "Insights & Settings": "বিশ্লেষণ ও সেটিংস",
  // Reports overhaul — the split of the former "Insights & Settings" group
  "Reports & Analytics": "রিপোর্ট ও অ্যানালিটিক্স",
  "Administration": "প্রশাসন",
  // legacy group headers (kept so older label references still translate)
  "HR & Workforce": "এইচআর ও কর্মশক্তি",
  "Employees": "কর্মী",
  "Organization": "সংগঠন",
  // "Attendance" moved up to the split-menu block (2026-10-14) — one key only
  "Leave": "ছুটি",
  "Employee Expenses": "কর্মী খরচ",
  "Performance": "পারফরম্যান্স",
  "Tasks": "কাজ",
  "Approvals": "অনুমোদন",
  "Notifications": "বিজ্ঞপ্তি",
  "HR Documents": "এইচআর ডকুমেন্ট",
  "Resignation & Exit": "পদত্যাগ ও প্রস্থান",
  "Insights": "অন্তর্দৃষ্টি",
  "Settings": "সেটিংস",
  "Procurement & Inventory": "ক্রয় ও ইনভেন্টরি",
  // ---- generic nav words requested by the spec ----
  "Reports": "রিপোর্ট",
  "Analytics": "অ্যানালিটিক্স",
  "Letters": "চিঠি",
  "Exit": "প্রস্থান",
  "Loans": "ঋণ",
  "Expenses": "খরচ",
  "Calendar": "ক্যালেন্ডার",
  "Audit": "অডিট",
  // ---- common action / UI words ----
  "Save": "সংরক্ষণ",
  "Cancel": "বাতিল",
  "Search": "খুঁজুন",
  "Add": "যোগ করুন",
  "Edit": "সম্পাদনা",
  "Delete": "মুছুন",
  "Approve": "অনুমোদন",
  "Reject": "প্রত্যাখ্যান",
  "Submit": "জমা দিন",
  "Loading": "লোড হচ্ছে…",
  "Total": "মোট",
  "Sign out": "সাইন আউট",
  "HRM Workspace": "এইচআরএম ওয়ার্কস্পেস",
  // ---- global search (palette) ----
  "Menus": "মেনু",
  "Tabs": "ট্যাব",
  "Searching…": "খুঁজা হচ্ছে…",
  "No results found": "কোনো ফলাফল পাওয়া যায়নি",
  "Search employees, tasks, menus…": "কর্মী, কাজ, মেনু খুঁজুন…",
  "Keep typing to search employees and tasks…": "কর্মী ও কাজ খুঁজতে আরও লিখুন…",
  // ---- Wave 2 WP-M (Field Force) — in-view tab labels + actions ----
  "Planning Board": "ভিজিট পরিকল্পনা বোর্ড",
  "Plan Editor": "পরিকল্পনা সম্পাদক",
  "My Visits": "আমার ভিজিট",
  "Check In": "চেক ইন",
  "Check Out": "চেক আউট",
  "Compliance": "সম্মতির হার",
  "Coverage": "কভারেজ",
  // ---- Wave 2 WP-P (Recruitment) — in-view tab labels + actions ----
  "Job Openings": "চাকরির পদ",
  "New Opening": "নতুন পদ",
  "Log Application": "আবেদন যোগ করুন",
  "Pipeline": "পাইপলাইন",
  "Hire": "নিয়োগ করুন",
  // ---- Wave 2 WP-K (Assets) — view labels + actions ----
  "Asset Registry": "সম্পদ রেজিস্ট্রি",
  "Register asset": "সম্পদ নিবন্ধন",
  "Register company asset": "কোম্পানির সম্পদ নিবন্ধন",
  "Assign asset": "সম্পদ হস্তান্তর",
  "Assign to": "হস্তান্তর করুন",
  "Assigned To": "হস্তান্তরপ্রাপ্ত",
  "Assigned now": "বর্তমানে হস্তান্তরকৃত",
  "Record return": "ফেরত নিবন্ধন",
  "Mark returned": "ফেরত চিহ্নিত করুন",
  "Return note": "ফেরতের নোট",
  "Handover note": "হস্তান্তরের নোট",
  "Condition at handover": "হস্তান্তরের সময় অবস্থা",
  "Condition at return": "ফেরতের সময় অবস্থা",
  "Warranty expiry": "ওয়ারেন্টি মেয়াদ",
  "Send for repair": "মেরামতির জন্য পাঠান",
  "Mark repaired": "মেরামত চিহ্নিত করুন",
  "Retire asset": "সম্পদ অবসর",
  "Mark lost": "হারানো চিহ্নিত করুন",
  "Add note": "নোট যোগ করুন",
  "Company Assets": "কোম্পানির সম্পদ",
  "Issue as asset": "সম্পদ হিসেবে ইস্যু",
  "Clear with deduction": "কর্টনামায় নিষ্পত্তি",
  "Asset Fleet": "সম্পদ বহর",
  // ---- Wave 2 WP-E (Accounting) — view labels + actions ----
  "Vouchers": "ভাউচার",
  "Chart of Accounts": "হিসাব খাতার তালিকা",
  "Trial Balance": "ট্রায়াল ব্যালান্স",
  "Ledger": "খাতিয়ান",
  "Income Statement": "আয়-ব্যয় বিবরণী",
  "Journal Voucher": "জাবেদ (ভাউচার)",
  "Post Voucher": "ভাউচার জমা দিন",
  "Add Line": "লাইন যোগ করুন",
  "Debit": "ডেবিট",
  "Credit": "ক্রেডিট",
  "Assets": "সম্পদ",
  "Liabilities": "দায়",
  // "Expenses" already translated above (generic nav words)
  "Opening Balance": "প্রারম্ভিক জমা",
  "Closing Balance": "সমাপনী জমা",
  "Net Movement": "নিট পরিবর্তন",
  "Void Voucher": "ভাউচার বাতিল",
  // ---- Wave 4 (SG-D) — common action / UI words (coverage extension) ----
  "View": "দেখুন",
  "Generate": "তৈরি করুন",
  "Export": "এক্সপোর্ট",
  "Print": "প্রিন্ট",
  "Close": "বন্ধ করুন",
  "Confirm": "নিশ্চিত করুন",
  "Back": "পিছনে",
  "Next": "পরবর্তী",
  "Refresh": "রিফ্রেশ",
  "Retry": "আবার চেষ্টা করুন",
  "Download": "ডাউনলোড",
  "Upload": "আপলোড",
  "Remove": "সরিয়ে ফেলুন",
  "Filter": "ফিল্টার",
  "Clear": "পরিষ্কার করুন",
  "Actions": "অ্যাকশন",
  "Status": "অবস্থা",
  "Name": "নাম",
  "Date": "তারিখ",
  "Amount": "পরিমাণ",
  "Notes": "নোট",
  "Active": "সক্রিয়",
  "Inactive": "নিষ্ক্রিয়",
  "Loading…": "লোড হচ্ছে…",
  "Working…": "কাজ চলছে…",
  // ---- Wave 4 (SG-D) — ESS tab labels (exact strings from views/ess.tsx) ----
  "My Attendance": "আমার উপস্থিতি",
  "My Leave": "আমার ছুটি",
  "My Payslips": "আমার পে-স্লিপ",
  "My Loans": "আমার ঋণ",
  "My Expenses": "আমার খরচ",
  "My Tasks": "আমার কাজ",
  "My Performance": "আমার পারফরম্যান্স",
  "My Documents": "আমার ডকুমেন্ট",
  "My Requisitions": "আমার রিকুইজিশন",
  "My AIT/Tax Certificate": "আমার এআইটি/কর সনদ",
  "My Resignation": "আমার পদত্যাগ",
  // "My Visits" already translated above (Wave 2 WP-M)
  // ---- Wave 4 (SG-D) — ESS headings, quick actions, section cards ----
  "My Self-Service Portal": "আমার সেলফ-সার্ভিস পোর্টাল",
  "Period": "সময়কাল",
  "Today": "আজ",
  "Leave Balances (this year)": "ছুটির ব্যালেন্স (এই বছর)",
  "Substitute Assignments Awaiting Your Response": "আপনার সাড়ার অপেক্ষায় থাকা প্রতিনিধি দায়িত্ব",
  "Guarantor Consent Needed — colleagues named you as guarantor": "গ্যারান্টর সম্মতি প্রয়োজন — সহকর্মীরা আপনাকে গ্যারান্টর হিসেবে নাম লিখেছেন",
  "Salary Advances": "বেতন অগ্রিম",
  "Issued Letters": "ইস্যুকৃত চিঠি",
  "Resignation Status": "পদত্যাগের অবস্থা",
  "Exit Clearance": "প্রস্থান ছাড়পত্র",
  "Final Settlement Computation": "চূড়ান্ত নিষ্পত্তি হিসাব",
  "Geo Check-In": "জিও চেক-ইন",
  "Selfie + Geo Check-In": "সেলফি + জিও চেক-ইন",
  "Selfie Check-In": "সেলফি চেক-ইন",
  "Apply Leave": "ছুটির আবেদন",
  "Submit Expense": "খরচ জমা দিন",
  "Request Loan": "ঋণের আবেদন",
  "Request Goods": "পণ্যের অনুরোধ",
  "Submit Resignation": "পদত্যাগ জমা দিন",
  "Request Correction": "সংশোধনের অনুরোধ",
  // ---- Wave 4 (SG-D) — login page strings (exact strings from views/login.tsx) ----
  "Sign in to your workspace": "আপনার ওয়ার্কস্পেসে সাইন ইন করুন",
  "Use your vendor account credentials": "আপনার ভেন্ডর অ্যাকাউন্টের ইমেইল ও পাসওয়ার্ড দিন",
  "Email": "ইমেইল",
  "Password": "পাসওয়ার্ড",
  "Sign in": "সাইন ইন",
  "Forgot password?": "পাসওয়ার্ড ভুলে গেছেন?",
  "Reset your password": "পাসওয়ার্ড রিসেট করুন",
  "Account email": "অ্যাকাউন্টের ইমেইল",
  "Reset code": "রিসেট কোড",
  "New password": "নতুন পাসওয়ার্ড",
  "Confirm new password": "নতুন পাসওয়ার্ড নিশ্চিত করুন",
  "Send reset code": "রিসেট কোড পাঠান",
  "Set new password": "নতুন পাসওয়ার্ড সেট করুন",
  "Back to sign in": "সাইন ইনে ফিরে যান",
  "Login failed": "লগইন ব্যর্থ হয়েছে",
  "Enter the 6-digit code from your authenticator app": "আপনার অথেনটিকেটর অ্যাপের ৬-সংখ্যার কোড লিখুন",
  "New password and confirmation do not match": "নতুন পাসওয়ার্ড ও নিশ্চিতকরণ মেলেনি",
  "Enter your account email first": "প্রথমে আপনার অ্যাকাউন্টের ইমেইল লিখুন",
  "Enter the reset code from the email": "ইমেইলে পাঠানো রিসেট কোডটি লিখুন",
  "Password updated — sign in with your new password.": "পাসওয়ার্ড হালনাগাদ হয়েছে — নতুন পাসওয়ার্ড দিয়ে সাইন ইন করুন।",
  // ---- Wave 4 (SG-D) — offline queue / PWA strings (introduced with sw.js) ----
  "Offline — check-ins will be saved locally": "অফলাইন — চেক-ইন ডিভাইসে সংরক্ষিত থাকবে",
  "Offline check-ins pending sync": "সিঙ্কের অপেক্ষায় থাকা অফলাইন চেক-ইন",
  "Sync now": "এখন সিঙ্ক করুন",
  "Saved offline — will sync when you reconnect": "অফলাইনে সংরক্ষিত — সংযোগ ফিরলে সিঙ্ক হবে",
  // ---- UXD-4 (P2 wave, 2026-11-09) — ADMIN MONEY SCREENS: payroll / payslips /
  // loans / expenses / accounting / billing column + action vocabulary (the
  // exact strings those views render; unknown keys still fall back to English
  // via tr(), so partial coverage degrades gracefully).
  // payroll — run + entry grid
  "Pay Runs": "পে রান",
  "Structures": "স্ট্রাকচার",
  "Payslips": "পে-স্লিপ",
  "Bonus & Commission": "বোনাস ও কমিশন",
  "Run #": "রান #",
  "Frequency": "ফ্রিকোয়েন্সি",
  "Gross": "মোট (গ্রস)",
  "OT": "ওভারটাইম",
  "Bonus": "বোনাস",
  "Commission": "কমিশন",
  "Deductions": "কর্তন",
  "AIT": "এআইটি",
  "Net": "নিট",
  "Net Pay": "নিট বেতন",
  "Employee": "কর্মী",
  "Basic": "মূল বেতন",
  "House Rent": "বাড়ি ভাড়া",
  "Medical": "চিকিৎসা",
  "Conveyance": "যাতায়াত",
  "Food": "খাদ্য",
  "Overtime": "ওভারটাইম",
  "Loan": "ঋণ",
  "Advance": "অগ্রিম",
  "Absent": "অনুপস্থিত",
  "Present": "উপস্থিত",
  "Working Days": "কার্যদিবস",
  "Pay Period": "পে-পিরিয়ড",
  "Payment Date": "পেমেন্ট তারিখ",
  "Create Run": "রান তৈরি করুন",
  "Calculate": "হিসাব করুন",
  "Mark as Paid": "পরিশোধিত হিসেবে চিহ্নিত করুন",
  "View / Print": "দেখুন / প্রিন্ট",
  "Remarks": "মন্তব্য",
  "Created By": "তৈরি করেছেন",
  "Created": "তৈরি হয়েছে",
  // payroll — statuses
  "DRAFT": "খসড়া",
  "PENDING_APPROVAL": "অনুমোদনের অপেক্ষায়",
  "APPROVED": "অনুমোদিত",
  "REJECTED": "প্রত্যাখ্যাত",
  "PAID": "পরিশোধিত",
  "CANCELLED": "বাতিল",
  // loans / advances
  "Principal": "মূল",
  "Outstanding": "অবশিষ্ট",
  "Installment": "কিস্তি",
  "Installments": "কিস্তি",
  "Interest": "সুদ",
  "Disbursed": "পরিশোধকৃত",
  "Recovered": "আদায়কৃত",
  "Recovery": "আদায়",
  "Due Date": "নির্ধারিত তারিখ",
  "Request": "অনুরোধ",
  "Requests": "অনুরোধসমূহ",
  // expenses
  "Expense": "খরচ",
  "Category": "ক্যাটাগরি",
  "Submitted": "জমা দেওয়া হয়েছে",
  "Pending": "অপেক্ষমাণ",
  "Reimburse": "পরিশোধ",
  // accounting / billing
  "Journal": "জার্নাল",
  "Journals": "জার্নাল",
  "Voucher": "ভাউচার",
  "Balance": "ব্যালেন্স",
  "Invoice": "ইনভয়েস",
  "Invoices": "ইনভয়েস",
  "Subscription": "সাবস্ক্রিপশন",
  "Plan": "প্ল্যান",
  "Monthly": "মাসিক",
  "Yearly": "বার্ষিক",
  "VAT": "ভ্যাট",
  "Due": "বাকি",
  "Paid": "পরিশোধিত",
  "Unpaid": "অপরিশোধিত",
  // AIT
  "AIT / Income Tax": "এআইটি / আয়কর",
  "Tax Certificate": "কর সনদ",
  "Fiscal Year": "অর্থবছর",
  "Taxable Income": "করযোগ্য আয়",
  "Exemption": "ছাড়",
  "Slab": "স্ল্যাব",
  "Withheld": "কর্তিত",
  // ---- FIN-037 (Phase 3) coverage backfill: the ESS self-service profile /
  // letters / notifications surface + the FIN-029 company-switch note shipped
  // without BN entries and rendered English for bn users (the exact gap the
  // audit registered). Found by scripts/check-i18n-coverage.mjs; the gate now
  // fails CI on any new untranslated literal.
  "All notifications": "সব বিজ্ঞপ্তি",
  "Unread only": "শুধু অপঠিত",
  "Mark all read": "সব পঠিত হিসেবে চিহ্নিত করুন",
  "Profile Photo": "প্রোফাইল ছবি",
  "Contact & Personal Details": "যোগাযোগ ও ব্যক্তিগত তথ্য",
  "Present Address": "বর্তমান ঠিকানা",
  "Emergency Contact": "ইমার্জেন্সি যোগাযোগ",
  "Keep your own contact details current — changes notify HR.": "নিজের যোগাযোগের তথ্য হালনাগাদ রাখুন — পরিবর্তন হলে এইচআর জানতে পায়।",
  "Save My Profile": "প্রোফাইল সংরক্ষণ করুন",
  "My Assets": "আমার সম্পদ",
  "Company equipment assigned to you. Return it to HR or your asset manager — unreturned assets block your exit clearance.": "আপনাকে বরাদ্দ করা কোম্পানির সম্পদ। অফিস ছাড়ার সময় এইচআর বা অ্যাসেট ম্যানেজারের কাছে ফেরত দিন — না ফেরত দিলে এক্সিট ক্লিয়ারেন্স আটকে যায়।",
  "My Interviews": "আমার ইন্টারভিউ",
  "Interviews where you are the named interviewer. Candidate contact details stay with the recruiting team; record outcomes from the Recruitment view.": "যেসব ইন্টারভিউতে আপনি নির্ধারিত ইন্টারভিউয়ার। প্রার্থীর যোগাযোগের তথ্য রিক্রুটিং টিমের কাছে থাকে; ফলাফল রেক্রুটমেন্ট ভিউ থেকে রেকর্ড করুন।",
  "Official announcements addressed to you. Opening a notice confirms you have read it.": "আপনাকে সম্বোধিত দপ্তরিক ঘোষণা। নোটিশ খুললে আপনি এটি পড়েছেন বলে গণ্য হয়।",
  "Request a Letter": "পত্রের জন্য অনুরোধ করুন",
  "Ask HR for a salary certificate, experience letter, employment certificate or NOC — no paperwork needed.": "এইচআরের কাছে বেতন সনদ, অভিজ্ঞতার পত্র, কর্মসংস্থান সনদ বা এনওসি চাইতে পারেন — কোনো কাগজপত্রের প্রয়োজন নেই।",
  "Letter type": "পত্রের ধরন",
  "Reason / notes (optional)": "কারণ / মন্তব্য (ঐচ্ছিক)",
  "Submit Request": "অনুরোধ জমা দিন",
  "Switching refreshes the workspace with the selected company's data, settings and your role in it.": "স্যুইচ করলে ওয়ার্কস্পেস নতুন করে লোড হয় — নির্বাচিত কোম্পানির তথ্য, সেটিংস এবং আপনার সেই কোম্পানিতে ভূমিকা অনুযায়ী।",
}

/** Translate a label. English returns the key unchanged; unknown Bangla
 *  keys also fall back to the key so nothing ever renders blank. */
export function tr(key: string, lang: Lang): string {
  if (lang !== "bn") return key
  return BN[key] || key
}

// ---------- external store (SSR-safe, no setState-in-effect) ----------
const listeners = new Set<() => void>()

/** Read the stored preference (client-side only; defaults to English). */
export function getLang(): Lang {
  if (typeof window === "undefined") return "en"
  return window.localStorage.getItem(LANG_KEY) === "bn" ? "bn" : "en"
}

/** Retitle the browser tab for the active language. */
export function applyTitle(lang: Lang, vendorName?: string | null) {
  if (typeof document === "undefined") return
  document.title = lang === "bn"
    ? `${vendorName || "Finix HR"} — এইচআরএম`
    : DEFAULT_TITLE
}

/** FIN-030 (Phase 3) — carry the ACTIVE COMPANY in the document title so
 *  every embedding shell (browser tab, PWA, the Tauri desktop webview) shows
 *  whose books are open after a company switch. Appends/replaces a
 *  " · <Company>" segment after whatever base applyTitle() set (en or bn);
 *  a null name removes the segment (logout / no company). Idempotent. */
export function applyCompanyTitle(companyName?: string | null) {
  if (typeof document === "undefined") return
  const base = (document.title || DEFAULT_TITLE).split(" · ")[0]
  document.title = companyName ? `${base} · ${companyName}` : base
}

/** Persist locally, retitle the tab and notify subscribers. */
export function setLang(lang: Lang, vendorName?: string | null) {
  if (typeof window !== "undefined") window.localStorage.setItem(LANG_KEY, lang)
  applyTitle(lang, vendorName)
  listeners.forEach((l) => l())
}

/** useSyncExternalStore wiring — subscribe to preference changes. */
export function subscribeLang(cb: () => void): () => void {
  listeners.add(cb)
  // keep in sync if another tab/window changes the preference
  if (typeof window !== "undefined") {
    window.addEventListener("storage", onStorage)
  }
  return () => {
    listeners.delete(cb)
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage)
  }
}
function onStorage(e: StorageEvent) {
  if (e.key === LANG_KEY) listeners.forEach((l) => l())
}

/** React hook: current language, hydration-safe. */
export function useLang(): Lang {
  return useSyncExternalStore(subscribeLang, getLang, () => "en" as Lang)
}

/** React hook for views (Wave 4): current language plus a translate function
 *  bound to it — `const { lang, t } = useI18n()`. Same dictionary and the
 *  same fallback rules as tr(); existing exports stay untouched. */
export function useI18n(): { lang: Lang; t: (key: string) => string } {
  const lang = useLang()
  return { lang, t: (key: string) => tr(key, lang) }
}
