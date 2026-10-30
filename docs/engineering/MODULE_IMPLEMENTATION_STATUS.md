# Finix HR — Module Implementation Status

> Honest classification per the directive: **Fully / Partially / Not implemented / Blocked by backend / Blocked by product decision**.
> A placeholder or broken-contract screen is NEVER "fully implemented". Status reflects the state **after the first implementation cycle (2026-10-30)** — i.e., including the P0 contract repairs in `IMPLEMENTATION_CHANGELOG.md`.
> Server-side counts: 40 route files, 566 registered actions (verified by registry extraction 2026-10-30).

Legend: **S**=server actions exist · **W**=web SPA screens · **M**=mobile native screens.

---

## 1. Employee core (mobile Priority A)

| Module | Server | Web | Mobile | Classification & notes |
|---|---|---|---|---|
| Authentication (login, session, MFA verify) | ✅ 21 `auth.*` + passkeys | ✅ | ✅ rewired | **Partial→Functional**: MFA verify + session restore fixed; forced-enrollment wizard NOT native (honest redirect) → stays *Partial* until T-14 |
| Home dashboard | ✅ `ess.dashboard` | ✅ | ✅ rewired | **Functional (employee plane)**: personal stats + notifications; HR workforce dashboard intentionally web-only |
| Attendance view (today/week/month) | ✅ `ess.attendance` | ✅ | ✅ rewired | **Functional** |
| Check-in / check-out (GPS/geofence) | ✅ geofence.checkin/checkout + selfCheckout | ✅ | ✅ offline outbox (M3/T-12) | **Functional incl. offline**: punches queue on-device (`finixhr_outbox_v1`), replay with the same `clientEventId` (server-side idempotent replay, commit `dcbea29`); success shown only after server confirmation — see `OFFLINE_OUTBOX.md`. `selfCheckout` fallback stays online-only (no idempotency key in its schema) |
| Selfie attendance | ✅ `attendance.selfie.checkin` + replay-safe proof write | ✅ (web upload flow) | ✅ native capture (M3/T-13) | **Functional**: front-camera capture → ≤640px JPEG → explicit confirm → authenticated upload; policy-required selfie attaches to geo punches; online-only by design (photo never stored on device); selfie = proof of presence, NOT identity verification (§27) |
| Leave (balances/types/apply/history) | ✅ `ess.leave` + `leaveRequests.apply` | ✅ | ✅ rewired | **Functional**: `fromDate`/`toDate` contract fixed |
| Payslips | ✅ `ess.payroll` + `.html` | ✅ | ✅ (was already correct) | **Functional** — HTML document rendered in WebView viewer (legitimate use) |
| Notifications | ✅ `notifications.list/read/unreadCount` | ✅ | ✅ rewired | **Functional** (read-state display; mark-read action pending T-15 polish) |
| Employee directory | ✅ `ess.colleagues` | ✅ | ✅ rewired | **Functional** (names + org context only — by design) |

## 2. Employee self-service (mobile Priority B)

| Module | Server | Web | Mobile | Classification |
|---|---|---|---|---|
| ESS hub (announcements, documents, expenses) | ✅ `ess.documents`, `ess.expenses`, `announcements.list` | ✅ | ✅ rewired | **Functional** |
| Tasks / goals | ✅ `ess.tasks` | ✅ | ✅ (via ESS + performance screen) | **Functional** (view-only; comments/status changes web-only for now) |
| Performance (reviews, KPIs) | ✅ `ess.performance` | ✅ | ✅ rewired | **Functional** (view + acknowledge pending) |
| Support tickets | ✅ `support.tickets`, `support.ticket.create/reply/close/reopen` | ✅ | ✅ rewired (create + list) | **Partial**: create/list fixed; reply/close/reopen not yet in mobile UI |
| Recruitment (HR users) | ✅ `recruitment.openings.list`, `applications.*` | ✅ | ✅ permission-gated rewired | **Partial (by design)**: HR users see openings; employee plane excludes it (product decision §7 health report) |
| Reports (HR users) | ✅ `reports.templates.*`, `reports.attendanceOverview` | ✅ rich | ✅ permission-gated rebuilt | **Partial**: templates + attendance overview; deep report builder remains web-only |
| Shift schedules | ✅ `shifts.*` (5 actions) | ✅ | ❌ | **Not implemented (mobile)** — backlog |
| Holidays | ✅ `holidays.*` (4) + `reports.holidayCalendarIcs` | ✅ | ❌ | **Not implemented (mobile)** — backlog |
| Asset management (self) | ✅ `ess.myAssets` | ✅ | ❌ | **Not implemented (mobile)** — backlog |
| Loans / advances (self) | ✅ `ess.loans` | ✅ | ❌ | **Not implemented (mobile)** — backlog |
| Document upload (self) | ✅ `ess.profile.update` (whitelist) | ✅ | ❌ | **Not implemented (mobile)** — backlog |

## 3. HR / admin plane (web SPA — reference client)

All 40 server route modules have web SPA surfaces (`src/app/app/` + `src/hrm-server/routes/`): organization, employees (2244-line route file), attendance & devices (ZKTeco ADMS + ISAPI + iclock device planes), leave, payroll (golden tests), finance/accounting, AIT tax, commissions, procurement, inventory, cameras, field force, ATS/recruitment, assets, billing, support, letters, communication, admin, SaaS owner console (`/owner/*`). Classification: **server ✅ / web ✅ / mobile N/A (HR plane)**. Module-by-module completion sweep = backlog T-24.

## 4. Platform

| Module | Status |
|---|---|
| SaaS owner console | **Functional** (owner routes + `/owner/*` console; billing, tenants, plans, quotas, lifecycle) |
| Tenant billing & payments | **Partial** — gateway routes exist (`api/payments/*`), idempotency test currently failing (T-10) |
| Public website/CMS | **Functional** (`(public)` routes + website studio) |
| Desktop shell | **Partial** — managed launcher + web HRM loads; CSP now set; single-instance/auto-update/window-state NOT implemented (T-22) |
| Mobile app shell | **Functional** — expo-router, tabs, auth guard, secure storage, push scaffolding, offline outbox boot (`initOutbox` after session restore) |

## 5. Module-family coverage matrix (38 families, directive §3 Phase 5)

38 module families are server-covered (566 actions); web coverage is broad; mobile covers 13 families natively after the first cycle (employee core + ESS + support + permission-gated recruitment/reports), with 10 families remaining for Priority B/C. After M3 the mobile employee core includes the offline outbox (geofence punches) and native selfie capture — the offline SELFIE path is deliberately out of scope (see `OFFLINE_OUTBOX.md` §7). No family is "blocked by backend" — the server side exists everywhere the mobile app needed it; the gaps were client-side contract failures (now fixed).

---

## 6. Explicitly NOT claimed

- No offline synchronization yet (T-12) — online-only with retry-safe `clientEventId`.
- No native MFA enrollment (T-14), no selfie capture (T-13), no push E2E proof (T-15).
- Reports/recruitment on mobile are intentionally permission-gated views, not full HR workbenches.
- Desktop build verification (Windows/macOS) could not run in this sandbox — config-level changes only.
