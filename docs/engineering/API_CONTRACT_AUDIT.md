# Finix HR — API Contract Audit

> Source of truth: **the server implementation** — `src/hrm-server/routes/*.ts` registrations read via the `route()` registry (`src/hrm-server/routes/registry.ts`) and dispatched by `POST /api/hrm { action, payload }` (`src/app/api/hrm/route.ts`).
> Client under audit: the Expo mobile app (`mobile/`).
> Method: every string action referenced by mobile code was extracted (`rpc()` calls, `useFetch()` calls, dynamic card actions) and matched against the 566 server-registered actions; payload and response shapes were then read from the handler source.
> Audit date: 2026-10-30.

---

## 1. Summary

- **39 distinct actions** are referenced by mobile code.
- **23 (59%) do not exist on the server** → every call fails with the dispatcher's "unknown action" denial before any business logic runs.
- **4 existing actions are called with wrong payload field names or wrong response shapes** (leave apply, MFA verify, support ticket create, notifications list).
- **2 actions are semantically wrong for the employee plane** (`dashboard.stats`, `attendance.today` — both are HR-scoped views, not self views; `attendance.today` also returns an array where mobile expects a single record).
- The correct employee-plane contract already exists server-side as the **`ess.*` action family** (18 self-scoped actions) plus the self-scoped attendance/tracking routes. The mobile app was written against an imagined API and must be rewired to the real one.

---

## 2. Full contract matrix (mobile → server)

Legend: ✅ correct · ⚠️ exists but wrong shape/fields/scope · ❌ does not exist on the server.

### 2.1 Authentication & session

| Mobile call | Verdict | Server reality (file:line) | Required fix |
|---|---|---|---|
| `auth.login` `{ email, password }` | ⚠️ | `routes/auth.ts:101`, `public: true`. Non-MFA: `{ token, id, user, vendor, mfaEnrollSuggested }`. MFA: `{ token: null, user, vendor, mfaRequired: true, mfaToken }` (`auth.ts:183`). Forced enrollment: `{ token: null, user, vendor, mfaEnrollmentRequired: true, enrollToken }` (`auth.ts:173`) | mobile reads `res.tempToken` (`mobile/src/lib/auth.ts:56`) — must read `mfaToken`; must handle `mfaEnrollmentRequired` |
| `auth.mfa.verify` `{ token, code }` | ⚠️ | `routes/auth.ts:190`, reads `{ mfaToken, code, useRecovery }` — `mfaToken` REQUIRED (400 otherwise) | send `{ mfaToken, code }` |
| `auth.me` `{}` | ✅ | `routes/auth.ts:653` — `{ user: { id, name, email, role, roleLabel, employeeId, branchId, departmentId, employeePhotoUrl, permissions[], fieldAccess, mfaEnrolled, mfaRequired }, vendor, csrfToken, … }` | keep; use `permissions[]` for module gating |
| *(root layout)* raw `fetch` of `auth.me` | ⚠️ | same | replace hand-rolled fetch (`mobile/app/_layout.tsx:24`) with shared `rpc()` so 401 → token cleared, network errors distinguished |

### 2.2 Home / dashboard / notifications

| Mobile call | Verdict | Server reality | Required fix |
|---|---|---|---|
| `dashboard.stats` `{}` | ⚠️ | `routes/reports.ts:52`, perm `["dashboard","view"]`, returns workforce KPI object (`workforce.total/active/…`), memoized 60 s. NOT the flat `presentToday/myCheckin/…` shape mobile declares; employees typically lack `dashboard.view` | use `ess.dashboard` (`routes/ess.ts:350`) → `{ attendance: { present, late, absent, overtimeMinutes }, casualRemaining, openTasks, unreadNotifications, activeLoans, outstandingLoans, outstandingAdvances, pendingExpenses }` |
| `notifications.list` `{ page: 1, limit: 5 }` | ⚠️ | `routes/communication.ts:44` — **takes no payload** (page/limit ignored, capped `take: 100`), returns a **bare array** of Notification rows (`{ id, title, message, type, link, readAt, createdAt, … }`) | expect array; slice client-side; map `readAt` → read state |

### 2.3 Attendance (check-in / check-out)

| Mobile call | Verdict | Server reality | Required fix |
|---|---|---|---|
| `attendance.today` `{}` | ⚠️ | `routes/attendance.ts:273`, perm `attendance.view`, returns **array of ALL in-scope employees** (HR daily grid): `[{ employeeId, code, fullName, branchName, departmentName, shiftName, record, impliedStatus }]` | replace with `ess.attendance` → `{ records, summary, today }` (self-scoped, no perm) |
| `attendance.myWeek` `{}` | ❌ | no such action | derive from `ess.attendance` month records (filter current week client-side) |
| `attendance.selfCheckin` `{ latitude, longitude }` | ❌ | no plain self check-in exists. Real check-in paths: `attendance.geofence.checkin` (schema `S.geoCheckin`: `latitude*, longitude*, accuracyM, deviceInfo, selfieQuality, selfieDataUrl ≤2.5 MB, batteryPercentage, isCharging, gpsStatus, networkStatus, deviceId, mobileSessionId, clientEventId`; requires GEOFENCE feature + method policy + geofence validation, `routes/attendance.ts:877`) and `attendance.selfie.checkin` (`S.selfieCheckin`, `selfieDataUrl` REQUIRED, `routes/attendance.ts:1100`) | use `attendance.geofence.checkin` with GPS + `clientEventId`; consult `tracking.status` first for the effective method policy |
| `attendance.selfCheckout` `{ latitude, longitude }` | ⚠️ | exists (`routes/attendance.ts:707`, schema `S.selfCheckout` — lat/lng nullish OK) BUT the plain route is denied when the tenant's ATTENDANCE_METHOD policy requires GPS (L-13) | prefer `attendance.geofence.checkout` (`routes/attendance.ts:1002`, same schema family incl. `clientEventId`); fall back to `selfCheckout` only without GPS |
| `tracking.location` | ✅ | `routes/tracking.ts` — live-tracking ping (used by `mobile/src/lib/location.ts:25`) | keep; ensure payload matches `S` schema for it |
| `tracking.status` | ✅ (unused) | `routes/tracking.ts:239` → `{ trackingEnabled, intervalSec, policySource, mandatoryGps, attendanceMethods, … }` — the documented pre-check-in consultation point | **mobile must call it** before rendering check-in affordances |

**Idempotency**: the server already deduplicates via `clientEventId` (`ci:`/`co:`/`si:` prefixes — `routes/attendance.ts:971,1074,1237`; schemas `validation.ts:280,304,324`). The mobile client never sends it. Duplicate punches after a retry are therefore possible.

### 2.4 Leave

| Mobile call | Verdict | Server reality | Required fix |
|---|---|---|---|
| `leaveTypes.list` `{}` | ✅ | `routes/leave.ts` — exists (perm `leave.view`) | superseded by `ess.leave` (returns types too) |
| `leaveRequests.myBalances` `{}` | ❌ | no such action; balances live in `leaveBalances.list` (perm `leave.view`, HR plane) | use `ess.leave` → `{ balances: [{ leaveTypeId, typeName, remaining(spendable), … }], types, requests, substitutes }` (`routes/ess.ts:81`) |
| `leaveRequests.myRequests` `{ page: 1 }` | ❌ | no such action; `leaveRequests.list` is the HR/manager plane (perm `leave.view`, scope filters, optional `myTeam`) | use `ess.leave` `requests` (self rows, `fromDate`/`toDate`/`typeName`) |
| `leaveRequests.apply` `{ leaveTypeId, startDate, endDate, reason }` | ⚠️ | exists (`routes/leave.ts:274`), schema `S.leaveApply` (`validation.ts:225`): `{ employeeId?, leaveTypeId*, fromDate*, toDate*, reason?, halfDay?, contactNumber?, substituteEmployeeId?, attachmentName?, attachmentData? }` — **`fromDate`/`toDate` required**; `.passthrough()` | send `fromDate`/`toDate`; employee self-apply is policy-gated (ESS feature + `ess.create`/`leave.create` permission) |

**Effect**: every mobile leave application today fails Zod validation (`fromDate`/`toDate` missing) — the exact mismatch the directive predicted.

### 2.5 ESS / payroll / documents

| Mobile call | Verdict | Server reality | Required fix |
|---|---|---|---|
| `ess.payroll` `{}` | ✅ | `routes/ess.ts:118` → `{ payslips: [{ entryId, payslipNumber, period, paidOn, gross, net, ait, breakdown }], totalAit }` (60 most recent) | verify client interface matches (it is close; confirm when fixing) |
| `ess.payroll.html` `{ entryId }` | ✅ | `routes/ess.ts` → `{ html }` (audited payslip document render) | keep — WebView used as an HTML *document viewer*, not as an app substitute |
| `ess.myDocuments` `{ page: 1 }` | ❌ | real name: `ess.documents` (`routes/ess.ts:287`) → `{ docs: [{ id, docType, title, status, verified, expiryDate }], letters }` | rename + expect `{ docs, letters }` (not `{ data }`) |

### 2.6 Support

| Mobile call | Verdict | Server reality | Required fix |
|---|---|---|---|
| `support.myTickets` `{ page: 1 }` | ❌ | real name: `support.tickets` (`routes/support.ts:133`), perm `["support","view"]`, schema `{ status: "ALL"|… , take ≤100 }` → `{ rows: [...] }` | rename; send `{ status: "ALL", take }`; read `rows` |
| `support.createTicket` `{ subject, body, priority }` | ❌ | real name: `support.ticket.create` (`routes/support.ts:198`), perm `support.view`, **strict** schema `{ subject (4–160), category: "GENERAL"|…, priority: "LOW"\|"NORMAL"\|"HIGH"\|"URGENT", message (10–5000), attachments[] }` | rename; send `message` (not `body`); priority enum uses `NORMAL` — mobile currently offers "MEDIUM" which would fail `.strict()`; mobile also lacks the `category` concept |

### 2.7 Performance / goals / KPIs / reviews

| Mobile call | Verdict | Server reality | Required fix |
|---|---|---|---|
| `performance.myGoals` `{}` | ❌ | no `performance.*` prefix exists at all (see §5). Employee-visible data: `ess.tasks` (own tasks, `routes/ess.ts:257`, take 200) and `ess.performance` → `{ reviews, kpis }` (`routes/ess.ts:267`) | goals → `ess.tasks`; reviews/KPIs → `ess.performance` |
| `performance.myKpis` `{}` | ❌ | as above | `ess.performance.kpis` |
| `performance.myReviews` `{}` | ❌ | as above (only SUBMITTED/ACKNOWLEDGED/FINAL reviews are employee-visible — ESS-03) | `ess.performance.reviews` |

### 2.8 Recruitment

| Mobile call | Verdict | Server reality | Required fix |
|---|---|---|---|
| `recruitment.openJobs` `{ page: 1 }` | ❌ | real name: `recruitment.openings.list` (`routes/recruitment.ts:97`), perm `["recruitment","view"]`, schema `{ status? }` | rename; gate module by `recruitment.view` permission |
| `recruitment.myApplications` `{}` | ❌ | no employee "my applications" concept; `recruitment.applications.list` is the HR pipeline (perm `recruitment.view`) | drop for employee plane; show for perm-holders |
| `recruitment.stats` `{}` | ❌ | no such action | remove; derive counts from openings list if needed |

### 2.9 Reports

| Mobile call | Verdict | Server reality | Required fix |
|---|---|---|---|
| `reports.overview` + 8 card actions (`reports.attendance|leave|payroll|headcount|turnover|performance|recruitment|fieldforce`) | ❌ all 9 | none exist. Real report actions: `reports.attendanceOverview` (+`Csv`), `reports.templates.{list,save,runNow,delete}`, `reports.holidayCalendarIcs`, `dashboard.stats`, `analytics.all`, `audit.*` — all perm-gated HR/plane actions | rebuild screen around real actions (templates list + attendanceOverview) gated by permissions, or remove for employee plane (product decision §7 of health report) |

### 2.10 Directory

| Mobile call | Verdict | Server reality | Required fix |
|---|---|---|---|
| `employees.list` (directory screen) | ⚠️ | exists, perm `["employees","view"]`, HR plane with field-level PII masking — wrong surface for an employee directory | use `ess.colleagues` (`routes/ess.ts:170`, perm `ess.view`) → names + org context only |

### 2.11 Push

| Mobile call | Verdict | Server reality | Required fix |
|---|---|---|---|
| `push.registerDevice` | ✅ | `routes/push.ts` — device-token registry (Expo/FCM/APNs) | keep; verify payload fields against schema during rewire |
| `push.unregisterDevice` | ✅ | `routes/push.ts` | keep (used in logout) |

---

## 3. Payload/response mismatch summary (the four confirmations)

1. **Leave apply**: mobile `startDate`/`endDate` → server `fromDate`/`toDate` (`validation.ts:228-229`).
2. **MFA verify**: mobile `token` → server `mfaToken` (`routes/auth.ts:193`).
3. **Support create**: mobile `body` + `MEDIUM` priority → server `message` + `NORMAL` (`routes/support.ts:200-206`, `.strict()`).
4. **Notifications list**: mobile `{ data: [...] }` → server bare array with `readAt` (`routes/communication.ts:44-52`).

Plus the login MFA challenge field: mobile `tempToken` → server `mfaToken` (`src/hrm-server/auth.ts:183`).

---

## 4. The correct employee-plane contract (what mobile SHOULD call)

| Screen | Action(s) | Notes |
|---|---|---|
| Login | `auth.login` → (`auth.mfa.verify`) | handle `mfaToken`, `mfaEnrollmentRequired` |
| Session restore | `auth.me` via shared `rpc()` | 401 → clear token → login |
| Home | `ess.dashboard`, `notifications.list` | array shape; `readAt` |
| Attendance | `ess.attendance`; `tracking.status`; `attendance.geofence.checkin` / `attendance.geofence.checkout` (+ `attendance.selfCheckout` fallback, online-only); `clientEventId` on every punch; **offline replay fields `offlineCapture` + `clientTimestamp` (M3)**; `attendance.selfie.checkin` (native capture, online-only) | method policy respected; retries are idempotent replays (`idempotentReplay: true`, commit `dcbea29`) — see `OFFLINE_OUTBOX.md` |
| Leave | `ess.leave` (balances+types+requests); `leaveRequests.apply` with `fromDate`/`toDate` | self-apply policy-gated server-side |
| Payslips | `ess.payroll`, `ess.payroll.html` | already correct |
| Documents/Announcements/Expenses/Tasks | `ess.documents`, `announcements.list` (array), `ess.expenses`, `ess.tasks` | |
| Performance | `ess.performance` (reviews+kpis) | |
| Directory | `ess.colleagues` | perm `ess.view` |
| Support | `support.tickets` `{ status, take }`, `support.ticket.create` `{ subject, category, priority, message }` | perm `support.view` |
| Recruitment / Reports (HR users only) | `recruitment.openings.list`, `recruitment.applications.list`, `reports.templates.list`, `reports.attendanceOverview` | gate by `auth.me` `permissions[]` |

---

## 5. Server-side contract hazards (for future work)

1. **Unprefixed route modules — RESOLVED for new consumers by T-20 (2026-10-31); flat names stay canonical + DEPRECATED for new code.** `routes/performance.ts` registers `cycles.*`, `reviews.*`, `kpiTemplates.*`, `kpiAssignments.*`, `tasks.*` and `routes/roadmap.ts` registers `reimbursements.*`, `overtime.*`, `orgChart.*`, `taxExemptions.*`, `salaryTemplates.*`, `promotions.list`, `transfers.list`, `shifts.autoRoster`, `payroll.reversals`, `auditRetention.purge`, `backups.export`, `employees.bulkImport` — historically **no module prefix**, unlike every other module (`attendance.*`, `leaveRequests.*`, …). The dispatcher's module-gate maps action prefixes to features; unprefixed actions bypass prefix-based feature gating (each carries its own `perm` instead). This inconsistency was the root cause of the mobile app's imagined `performance.*` namespace.
   **T-20 delivered** the audited fix: registry alias support (`alias()` in `routes/registry.ts` — the alias shares the canonical RouteDef OBJECT, so perm/schema/handler/lockout classification are identical by construction), with the web-SPA call-site inventory done first (35 live flat-name call sites verified across `src/hrm` + `src/app`; 9 further registered-but-uncalled flat names inventoried). **Deprecation note: the flat spellings above are deprecated for NEW consumers** — use the prefixed aliases: `performance.cycles.*`, `performance.reviews.*`, `performance.kpiTemplates.*`, `performance.kpiAssignments.*`, `performance.tasks.*`, `ait.taxExemptions.*`, `payroll.salaryTemplates.*`, `payroll.salaryRevisions.list`, `attendance.overtime.*`, `expenses.reimbursements.*`, `employees.orgChart.*`, `employees.promotions.list`, `employees.transfers.list`, `letters.exitPacket.generate`, `settings.auditRetention.purge`, `settings.backups.export`. (`shifts.autoRoster`, `payroll.reversals`, `employees.bulkImport` were already module-prefixed and are not re-aliased.) Flat names keep resolving — removal would need its own coordinated migration; new code must not add flat-name call sites. Pinned by `tests/unit/t20-route-aliases.test.ts` (8 tests: def-object identity, exact alias inventory, SPA back-compat, prefix-gate parity, dispatcher behavioral parity incl. permission-denial parity).
2. **`leaveRequests.apply` is `.passthrough()`** — unknown fields (like mobile's current `startDate`) are not rejected, which made the missing-required error the only symptom. Prefer `.strict()` or explicit error surfacing when touching this schema (careful: web SPA may send extra fields intentionally).
3. **`notifications.list` ignores pagination params** — clients that believe they are paginating (`{ page, limit }`) silently get the take-100 array. Any new consumer must be documented.
4. **`attendance.today` is an HR grid** despite its self-sounding name — a trap for mobile-style clients (the mobile app fell into it).
5. **Dual response envelopes**: some list actions return bare arrays (legacy contract), others `{ items, total, page, pageSize }` when paged params are sent (`leaveRequests.list`, `loans.list`, `leaveBalances.list`). Consumers must pin one mode explicitly.

---

## 6. Contract tests (added during Task C — see changelog)

A new unit-test file `tests/unit/mobile-contract.test.ts` pins the employee-plane contract: for each action in §4 it asserts the route exists in the registry, is (or is not) permission-gated as expected, and where cheaply possible asserts response-shape invariants via direct handler invocation. This makes the 23 missing-action class of failure impossible to reintroduce silently.

## 7. M3 additions (2026-10-30) — offline outbox & selfie contract

Punch routes (`attendance.geofence.checkin/checkout`, `attendance.selfie.checkin`) gained three replay-contract elements (server commit `dcbea29`):

1. **Idempotent replay**: a retry with an already-accepted `{vendorId, prefixed clientEventId}` returns the recorded outcome (`idempotentReplay: true`, `eventStatus`, `reviewStatus`, `recordedAt`, original punch time) with NO side effects re-run — exactly one attendance row / event / selfie proof / notification. The replay check runs after identity but BEFORE the feature gate, selfie throttle, storage quota, method policy, geofence validation and the H-4 guard, so a retry can never be blocked by resources its own first attempt consumed.
2. **`offlineCapture` + `clientTimestamp` (optional fields, all three punch schemas)**: delayed device-captured deliveries are classified — ≤ 120 s like an online punch; > 120 s or missing timestamp → event flagged `OFFLINE_CAPTURE`, status `REVIEW_REQUIRED`, reviewStatus `PENDING`, HR notified, device timestamp preserved as evidence. Attendance punch time remains the server receipt time.
3. **Cross-tenant keys are never replays**: the lookup is vendor-scoped.

Pinned by `tests/unit/m3-offline-outbox-server.test.ts` (12 tests) and three new pins in `mobile-contract.test.ts` (closed outbox action union, schema field presence, selfie required-photo validation). The mobile side sends these fields via the offline outbox — full architecture record: `OFFLINE_OUTBOX.md`.

## 8. M4 additions (2026-10-30) — enrollment wizard, push honesty, export failure contracts

1. **`auth.mfa.enroll.start` / `auth.mfa.enroll.enable` are now consumed natively** (T-14). The actions were already registered, public and capability-gated (enrollToken = proof of password); the mobile wizard references both, and the contract test now pins their existence, public classification and app-side references — the T-02 "web portal only" dead end cannot silently return. The behavioral contract (start provisions a secret + QR data-URL; enable verifies, refuses already-enrolled accounts, promotes to a full session, returns recovery codes exactly once) was already pinned by `h1-mfa-enrollment.test.ts` and is unchanged.
2. **Push registration contract** (T-15): `push.registerDevice` / `push.unregisterDevice` schemas were already pinned (token REQUIRED, platform enum expo/fcm/apns). M4 adds a config-level pin: `mobile/app.json` must keep a non-placeholder `expo.extra.eas.projectId` and `push.ts` must keep resolving that path (fail-closed without it). Premise note: the audit's original T-15 premise ("no configured projectId") was wrong — the key existed under `expo.extra.eas` (release-line `eas init`); it is cited here so the record is straight.
3. **Export failure contracts** (T-16): `payroll.export.salary` (404 unknown run / 400 cancelled run / 404 no-match filters / 403 BANK without `bankInfo.view` / real csv+xlsx+pdf bytes with truthful totals / audit row), `attendance.events.export` (rowCount == delivered lines, truncated flag) and `pf.template.download` (always a decodable workbook) are now pinned by `tests/unit/t16-export-honesty.test.ts` (12 tests at the POST /api/hrm boundary). No server contract changed — the tests document the existing honest behavior and make regression loud.

## 9. M5 additions (2026-10-31) — ESS payload bound, ESS isolation coverage, route aliases

1. **`ess.leave` payload bound** (T-18): the request history is capped at the 200 most recent (was the one remaining unbounded ESS read) and accepts an OPTIONAL `{ month, year }` filter on the leave START date (`fromDate` prefix — the same shape `ess.attendance` already used). Response shape unchanged (`balances` / `types` / `requests` / `substituteRequests`); existing callers send no payload and behave identically. The full ESS list-caps audit shipped with it (see §9.3).
2. **ESS-plane isolation coverage** (T-19): `tests/unit/ess-isolation.test.ts` (20 tests at the dispatcher boundary) proves vendor/employee scoping under adversarial payloads for `ess.*`, `tracking.status` and the punch actor resolution (`attendance.geofence.checkin` / `attendance.selfie.checkin` / `attendance.selfCheckout`), including the staff act-for-other path (permission + tenant-scope checks) and no-profile sessions.
3. **ESS list caps audit** (T-18): every `findMany` list read in `routes/ess.ts` is now take-bounded (requests/substitutes/myAssets 200, loans/advances/guarantees/reviews/kpis/cycles/documents/letters 100, bank accounts 20, leave-type catalog 100, org catalogs 200) or consciously classified as naturally/transitively bounded (month-prefix reads, `in:`-set decoration reads) — pinned structurally by `tests/unit/t18-ess-list-caps.test.ts`.
4. **Prefixed aliases** (T-20): see §5.1 above — both spellings resolve; flat names deprecated for new consumers.
