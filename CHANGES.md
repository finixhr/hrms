# HRMS_CCTV — Release Notes (2026-10-02, Build 5: Live Tracking + Secure Geo-Fence/Selfie Attendance + Multiple Check-In + Salary Payout & Dynamic Salary Export)

Implemented from the 93-section requirements round on top of Build 4, extending the existing architecture (no rewrites: Attendance stays the payroll-facing daily summary; AttendanceRawEvent stays the immutable ZKTeco input; BankAccount stays the payout foundation). **Database migration required** (`bunx prisma migrate deploy` — additive-only, with automatic backfills).

### 1. Live Employee Tracking (Attendance & Shifts → Live Tracking)
- Interactive map (Leaflet + OpenStreetMap — no API key, provider-abstracted) with employee photo markers, KPI cards (Total Assigned / Tracking / Online / GPS Disabled / Offline / Low Battery / Outside Fence / Suspicious), branch/department/status filters, polling refresh without page reloads, and per-employee detail (position, accuracy, battery + charging, GPS/network state, geo-fence status, attendance status, effective-policy source). Admins start/stop tracking per employee (audited).
- New models: `EmployeeTrackingState` (current state — the live map NEVER scans history), `TrackingPoint` (append-only telemetry with configurable retention 7–365 days; attendance summaries/events/audit/payroll are never auto-deleted).
- Evidence-based statuses only (§15): `OFFLINE_AFTER_LOW_BATTERY`, `POWER_OFF_UNCONFIRMED` — the system never claims deliberate power-off without device evidence. Offline reconciliation + retention sweeps run on the existing jobs scheduler.

### 2. Dynamic Attendance/Tracking Policy Engine (Attendance & Shifts → Policies & Check-In)
- ONE reusable policy system (§6) with four types: **Tracking** (interval 15s–10min, accuracy ceiling, battery thresholds, offline window, suspicious-action ALLOW/WARN/REVIEW/REJECT), **Mandatory GPS** (schedule + grace), **Multiple Check-In** (interval/frequency/daily-max/methods), **Attendance Method** (GEOFENCE / SELFIE / GEOFENCE+SELFIE / DEVICE_PUNCH + selfieRequired + requireGeofence).
- Scope assignments with deterministic priority EMPLOYEE > DEPARTMENT > BRANCH > ALL_EMPLOYEES, always resolved server-side; the UI shows "Effective Policy — Source: Employee/Department/Branch/Global" per employee.
- Server-clock schedules (dates, daily windows incl. midnight-crossing, weekdays, Asia/Dhaka) — the employee device clock is never authoritative.

### 3. Secure Geo-Fence Attendance (upgraded existing routes)
- `attendance.geofence.checkin/checkout` now run the full server-side pipeline: effective fences via the policy engine (legacy branch fences auto-migrated + kept as fallback), server-computed distance (client values never trusted), accuracy-aware validation (a ±210m fix inside a 100m fence → REVIEW, not silent accept), multi-signal anti-spoofing (mock-location, impossible movement, stale fixes, frozen GPS, timestamp anomalies, device mismatch), and immutable `AttendanceEvent` records.
- New `GeoFence` entity with map-based management (click/drag to position, radius slider + presets, validity windows) — geographic data only, no screenshots.

### 4. Selfie Attendance
- Employees capture a selfie during check-in/out (and periodic checks) when their policy requires it — camera capture in the ESS portal, ≤2MB, SHA-256 hashed, stored as private `AttendanceProof` behind a permission-gated, strict-audited view route. Never in /public, never in list payloads. A selfie is EVIDENCE, never labeled identity verification (§27).

### 5. Multiple Check-In
- Periodic re-verification checks (e.g. every 60 min) with server-enforced minimum interval, daily cap, schedule and allowed methods; duplicate prevention via idempotency keys (retried uploads never double-count); periodic checks NEVER touch the daily Attendance summary (payroll unaffected). Mobile contracts: `attendance.periodicCheck` + `attendance.multipleCheckin.validate`.

### 6. Attendance History & Security Review
- Attendance & Shifts → Attendance History: full event log (method, position, accuracy, battery, GPS, geo-fence distance, verification, integrity) with the complete filter set, plus a per-employee MOVEMENT MAP (points → dotted polyline → check-in/out + periodic + suspicious markers with popups).
- Security Events tab: review queue for suspicious/REVIEW events — inspect integrity signals, view the audited selfie proof, APPROVE/REJECT with a reason (rejections notify the employee). Nothing is auto-rejected on anomaly (§25).

### 7. Attendance Reporting Upgrade (HR Reports → Attendance Overview)
- KPI cards (Total/Present/Absent/Late/Early Leave/On Leave + Geo-Fence/Selfie/Device check-ins, Periodic checks, GPS violations, Suspicious events), attendance + suspicious trends, branch/department attendance-rate charts with totals tables, method-distribution + GPS/geo-fence compliance donuts, integrity signal breakdown — all server-authoritative (never computed from visible rows), CSV export.

### 8. Salary Payout Method (built on BankAccount — no duplicate table)
- `Employee.salaryPayoutMethod` (BANK/CASH/MFS) + `BankAccount.isSalaryPayoutAccount` (exactly-one designation — `isPrimary` is NOT treated as payout). Legacy single-account employees and active branch fences are backfilled automatically.
- Payroll → Payout Settings: enable/disable Bank/Cash/MFS + configurable Cash/MFS salary ceiling (default ৳10,000, GROSS or NET basis). Above the ceiling → BANK ONLY, enforced server-side at employee create/edit, payout-account save, payroll pay (blocks with the specific employee + reason) and export — never frontend-only. Payslips now resolve the DESIGNATED payout account (no more findFirst luck).
- Add/Edit Employee gains a "Salary & Payout" section (dynamic bank/MFS fields via conditional form fields; the backend repeats every validation).

### 9. Dynamic Salary Export (Payroll → Salary Export)
- Export any payroll run as **All Employees / Bank Transfer / Cash Salary / MFS Salary** in **Excel / CSV / PDF** (pdf-lib — pure JS, Bun/standalone-compatible), filtered by branch/department/employee, with server-side preview totals (incl. payout recipients + skipped employees with reasons) before generating. The server re-resolves every employee's TRUE payout method — a client "type=BANK" can't fabricate rows. Bank sheets require bankInfo.view; every export is audited.

### 10. Infrastructure & security
- ZKTeco device punches now project into the AttendanceEvent layer with raw-event provenance links (ingest pipeline unchanged and never blocked by projection failures).
- Targeted rate limiting for mobile ingestion (location 240/10min, attendance events 40/10min, selfies 12/10min) — the global security architecture is untouched.
- New RBAC modules `tracking.view/manage`, `geofence.*` (+ `attendance.assign` for policies; payroll officers get bankInfo.view for bank exports); branch/department manager scoping enforced server-side on every new action.
- 7 new notification-matrix events (gps_disabled, tracking_offline, low_battery, geofence_violation, location_spoof_suspected, mandatory_gps_violation, attendance_review_required) riding the existing Notification system.
- Mobile API contract documented in `src/hrm/API.md` (§12–§13, §63–§66): Bearer-authenticated /api/hrm RPC, session-derived identity, idempotency keys, offline-queue validation rules.

### Upgrade notes
```bash
bun install
bun run db:generate
bunx prisma migrate deploy   # 2_tracking_security_payout_20261002 (additive + backfills)
```
Verification: `tsc --noEmit` clean · `eslint` clean · permission lint OK (381 actions) · sandbox logic verification 58/58 (policy schedule, anti-spoofing, geofence accuracy, payout threshold matrix, export shaping, rate limiting). Unit tests (`bun test tests/unit`) require PostgreSQL — not available in the build sandbox; new suites: tracking-policy, location-integrity, geofence-eval, payout-rules, salary-export-shape. Map tiles load from OpenStreetMap (no API key needed).

---

# HRMS_CCTV — Release Notes (2026-10-02, Build 4: Ten-Requirements Implementation Round)

This build implements the operator's 10 requested features/fixes on top of Build 3
(PostgreSQL). **Database migration required** (`bunx prisma migrate deploy`) — it drops
the retired QrToken table and adds per-device historical-sync fields.

### 1. Bulk Employee Import (Excel/CSV) — Employee Directory
- New **Bulk Import** button beside Add Employee opens a wizard: download the
  **demo Excel (.xlsx)** or **CSV template** (14 columns, 3 demo rows, built-in
  Instructions sheet), upload your filled file, preview parsed rows,
  **Validate only** (dry run) or **Import** with a per-row report
  (created / skipped-duplicate / error). Auto-generates employee codes,
  matches Branch/Department/Designation/Shift names, max 500 rows/batch,
  fully audit-logged.

### 2. Linked employee's photo as the user's profile picture
- Any user tagged with an employee now shows that employee's photo as their
  account avatar in the app header.

### 3. Attachments with leave applications
- Both the HR Apply-Leave dialog and the employee portal dialog accept a
  supporting document (PDF/image, ≤ 2 MB). Leave types flagged
  "Attachment required" enforce it. Approvers/owners download attachments via
  the paperclip icon (audit-logged); attachment bytes never ride with list
  payloads.

### 4. Leave without a substitute
- Employees with no available colleague can submit leave WITHOUT a substitute —
  the request skips the substitute-acceptance step and goes straight to the
  first approver (manager/HR); it is never blocked or stranded.
- Substitute eligibility relaxed: colleagues from other departments/branches
  (and lower grades) are now eligible (shown as informational notes); only
  genuine blockers (substitute on leave / scheduled off) disqualify.
- Settings → Leave → "Recommend substitute" is now advisory (a portal nudge),
  never a hard requirement.

### 5. Self-Service Portal button visibility controls
- New **Settings → Self-Service Portal** tab: show/hide Geo Check-In,
  Check Out, Apply Leave, Submit Expense, Request Loan, Request Advance,
  Request Goods and Submit Resignation. Hiding removes the quick-action button
  and the in-tab request button for every portal user (existing records stay
  visible).

### 6. Document viewing icon (popup) — Employee 360° → Documents
- New Eye icon on every uploaded document opens a popup viewer: images render
  inline, PDFs embed, other types offer download. Permission-gated and
  audit-logged separately from downloads.

### 7. User email edit fixed
- Editing an existing user's email in Settings → Users & Security now actually
  saves (it was silently dropped before). Format- and duplicate-checked.

### 8. ADMS: sync & pull OLD attendance data
- New **History** icon per device (ADMS Devices tab) opens "Sync Old Attendance
  Data": choose **CHECK** (re-upload all unsent records — recommended,
  universally supported) or **DATA QUERY ATTLOG** with a date range (newer
  firmwares). The server temporarily widens that device's ingest window
  (60 min) so old punches are accepted instead of rejected as out-of-window;
  re-uploaded records are deduplicated automatically. Active windows show a
  pulsing indicator and can be closed early.

### 9. Device integration instructions moved into a popup
- The always-visible "Device configuration — official ZKTeco Push SDK / ADMS"
  block (incl. the gateway reachability **Test from this PC** button and
  compatibility list) moved behind an **Instructions** icon button on the
  ADMS Devices tab — same content, opens on click.

### 10. QR attendance removed completely
- The QR Attendance tab, rotating-token generation/check-in/check-out routes,
  the QrToken database table, the portal QR quick action + dialog, the
  "Combine with QR" geo-fence setting, search entries, seeds and API docs are
  all removed. Geo-fence check-in/out and a new plain self check-out
  (GPS-optional) replace it. MFA enrollment QR codes and camera QR launch
  targets are unrelated features and remain.

### Upgrade notes
```bash
bun install
bun run db:generate
bunx prisma migrate deploy        # 1_requirements_round_20261002
```
Verification: `tsc --noEmit` clean · `eslint` clean · permission lint OK
(355 actions) · production build green.

---

# HRMS_CCTV — Release Notes (2026-10-01, Build 3: SQLite → PostgreSQL)

This build supersedes the 2026-09-30 photo-fix build (Build 2) and migrates the
application database from **SQLite to PostgreSQL**. The Build 2 photo fixes are
unchanged and included. **Production cutover is NOT performed** — this archive
contains the migrated code, the data-migration utility, and the cutover/rollback
runbooks; the actual switch happens on the operator's host with
`docs/postgresql-cutover.md`.

> **Read before first start:**
>
> ```bash
> # 1) install PostgreSQL 16/17 + postgresql-client, create role + database
> # 2) point .env DATABASE_URL at PostgreSQL (see DEPLOYMENT-GUIDE.md errata)
> bun install
> bun run db:generate
> bun run db:deploy                 # applies the single PG baseline migration
> # 3) bring your existing SQLite data across (reads prisma/db/custom.db
> #    READ-ONLY; refuses production-looking names without the flag):
> DATABASE_URL="postgresql://…/hrm_production" bun run db:migrate-sqlite --allow-production
> ```
>
> The shipped `prisma/db/custom.db` is the untouched SQLite source (kept as the
> migration input + rollback anchor). New empty installs use
> `bash scripts/setup-and-seed.sh` instead.

---

## What changed (headline) — the database engine

- **Prisma provider**: `prisma/schema.prisma` → `postgresql`. The 12 historical
  SQLite migrations were initially archived read-only under `prisma/migrations_sqlite/`
  and later removed from the deliverable (audit L-6 — the pre-cutover git
  history preserves them); the active history is the single baseline
  `prisma/migrations/0_init_postgresql/migration.sql`.
- **db client**: `src/lib/db.ts` no longer anchors SQLite `file:` URLs — it
  trusts `DATABASE_URL` verbatim.
- **readiness probe**: `src/app/api/readyz/route.ts` uses `information_schema`
  instead of `sqlite_master`.
- **Case-insensitive search parity**: 16 user-facing `contains` call sites
  gained `mode:"insensitive"` (compiles to `ILIKE`) so lowercase searches
  (`emp-0024`, `tasnim`) behave exactly as they did on SQLite —
  `src/hrm-server/routes/employees.ts`, `src/hrm-server/routes/search.ts`,
  `src/hrm-server/routes/reports.ts`, `src/hrm-server/routes/inventory.ts`.
- **Backup subsystem**: `scripts/backup.sh` is now `pg_dump --format=custom`
  (still openssl AES-256 + SHA-256 manifest + offsite hook + 14-day retention +
  failure alerting); `scripts/restore-drill.sh` restores via `pg_restore` into
  a disposable scratch database and verifies payroll totals. Runbooks:
  `docs/postgresql-backup-restore.md` + `docs/BACKUP_RESTORE.md` (rewritten).
- **systemd**: `deploy/hrm.service` starts `After=postgresql.service`; the
  nightly SQLite VACUUM units are REMOVED (PostgreSQL autovacuum replaces
  them).
- **Tests**: `tests/preload.ts` targets an isolated PostgreSQL `hrm_test`
  database via `TEST_DATABASE_URL` and refuses production-looking URLs.
- **Data migration utility**: `scripts/migrate-sqlite-to-postgres.ts` —
  topological table order from the live FK graph, orphan pre-flight, per-table
  transactions, and full row-by-row reconciliation with checksums. Flags:
  `--fresh` (truncate + reimport), `--dry-run`,
  `--allow-production` (deliberate human gate).
- **25 pre-existing type errors fixed** so `bun run build` passes clean (the
  vendor archive never built clean; surgical type-level fixes only, no runtime
  change). Lint brought to zero as well.
- **CI**: `.github/workflows/ci.yml` (8-stage gate, PostgreSQL service) —
  same stages as local `bun run ci`.
- **New docs**: `docs/postgresql-migration-audit.md` (pre-migration audit),
  `docs/postgresql-migration-report.md` (execution report + evidence),
  `docs/postgresql-cutover.md`, `docs/postgresql-rollback.md`.

## What did NOT change

- All Build 2 photo fixes (512px full-square face-biased crop + 96px thumb,
  lightbox, create-dialog picker, directory server-side search).
- Business logic, permissions, vendor multi-tenancy, ZKTeco ADMS protocol,
  camera integrations, payroll/AIT math — untouched.
- `prisma/db/custom.db` (SQLite source) is byte-identical to the vendor
  archive; `.env` now ships with PostgreSQL URLs (was `file:./db/custom.db`).

## Verification (2026-10-01)

- **Reconciliation**: 99/99 tables match row-for-row (canonical checksums);
  14 FK constraints, 0 violations; 2,111 rows migrated in 0.31 s.
- **Quality gates**: `tsc --noEmit` 0 errors; lint clean; `bun run build`
  passes (standalone output); `bun test` 488 pass / 2 pre-existing MFA crypto
  failures (identical on the SQLite baseline).
- **ZKTeco on PostgreSQL**: 12/12 protocol steps PASS; unknown device → 404;
  wrong comm key → 401; 10 parallel duplicate ATTLOG posts → exactly 1 stored
  event (idempotent ingestion).
- **Backup/restore drills (×2)**: encrypted pg_dump → checksum → decrypt →
  pg_restore into scratch DB → 100 tables, payroll totals 0 mismatches →
  scratch dropped, source untouched.
- **Staging browser smoke E2E (15/15)** over the migrated copy of the real
  data on a production standalone build: login with migrated password hash;
  dashboard KPIs; directory + case-insensitive search parity; photo pipeline
  dual-write (512 full square + 96 thumb); lightbox; attendance (1,237
  migrated rows); payroll; settings backup runbook text; DB-level assertions.
  Re-running the migration `--fresh` afterwards leaves staging identical to
  the SQLite source (repeatable by construction).
- Full evidence: `docs/postgresql-migration-report.md`.

## Upgrade paths

| Starting point | Action |
|---|---|
| Existing data on SQLite (this vendor archive) | Follow the header block: `db:deploy` then `db:migrate-sqlite --allow-production` against your real database. Keep `prisma/db/custom.db` untouched as the rollback anchor for 30 days. |
| Fresh install, dummy data | `bash scripts/setup-and-seed.sh` (creates the dev PostgreSQL database, applies migrations, seeds). |
| Build 2 photo-fix users | Nothing extra: the photo pipeline is unchanged; run the engine migration above. Photos uploaded before Build 2 still need the one-time re-upload (see Build 2 notes below). |

## Previously fixed (Build 2, 2026-09-30) — photo quality

The v1 crop pipeline stored a 200×200 centre sliver as "the photo" (the
"fisheye zoom" on nose/mouth). The current pipeline crops the **largest
inscribed square** with **face-biased vertical placement**, then emits a
512×512 `photoUrl` and a 96×96 `photoThumb` from that single crop (server-side
caps 2 MB / 300 KB; thumb column nullable with fallback). Photos uploaded
before Build 2 keep the old crop — re-upload once via *Change Photo*.

## Previously fixed (Build 1, 2026-09-29) — three vendor-reported bugs

1. **Photo view** — avatar hover overlay is now a view (eye) icon; click opens
   a lightbox with the full stored photo (fitted, captioned) and a
   "Change Photo" action for editors.
2. **Photo on create** — the Create Employee dialog has a photo picker as its
   first field (circular preview, Choose/Change/Remove) riding the atomic
   `employees.createWithStructure` payload.
3. **Directory search by ID/email** — `Column.searchValue` exposes hidden
   fields to the filter and the directory uses the debounced server-side `q`
   search (`personalEmail` added to the OR-clause).


---

## SaaS Platform Layer (2026-10-03)

Adds the commercial layer around the existing multi-tenant HRM — the HRM itself
is untouched apart from additive entitlement guards:

- **Public website** (`/`, `/features/*`, `/pricing`, `/about`, `/contact`, `/faq`,
  `/register`, `/registration-status`, `/legal/*`): premium SaaS marketing site,
  server-rendered, database-backed pricing, SEO (per-page metadata, sitemap,
  robots), no fake statistics anywhere.
- **Registration system**: public form → SaaSRegistration row (PENDING) with a
  printable Application ID (HRM-YYYY-NNNNNN); public status lookup by ID+email;
  duplicate/weak-password guards; honeypot + rate limiting.
- **SaaS Owner Control Panel** (`/owner`, separate session store/cookie/RBAC/audit):
  dashboard (real-data KPIs + charts), registration review/approve/reject,
  transactional tenant provisioning, tenants (suspend/reactivate/change
  plan/extend/overrides), plans editor, subscriptions, renewal calendar,
  manual billing (invoices + payments), inquiries inbox, owner users, audit log,
  platform settings.
- **Entitlement engine** (server-side): plan feature gates + capacity limits
  (employees/users/branches/departments/devices/storage/tracking) enforced in the
  /api/hrm dispatcher and targeted create paths; read-only lockout for
  EXPIRED/SUSPENDED/CANCELLED; LEGACY mode keeps pre-SaaS tenants fully working.
- **Tenant-side**: `/app` (moved from `/` — SPA internals unchanged), new
  Subscription & Usage view, entitlement-aware navigation, read-only banner,
  registration link on the login view; auth payloads now carry a subscription
  snapshot.
- **Database**: 12 new Saas* models (plans, subscriptions + events, registrations,
  overrides, owner users/sessions, platform audit, settings, inquiries,
  invoices, payments); migration 5_saas_platform_20261003 — purely additive,
  verified on a fresh database.
- **Seeds**: 5 plans, owner super-admin (env-configurable, refuses weak
  passwords in production), demo registrations (isDemo), demo subscriptions.
- **Tests**: 18 new SaaS unit tests (749 total, all passing) + scripts/saas-smoke.py
  end-to-end harness (51 checks: registration → approval → provisioning →
  sign-in → enforcement → billing).

# Owner Console MFA, Password Recovery, Platform Gateway, Onboarding Wizard + CSP/Hydration Fix (2026-10-04, Build 8)

Implements every remaining owner-console limitation plus the requested UX gaps.
**Database migration required** (`bunx prisma migrate deploy` — migration
`6_owner_mfa_recovery_20261004`, purely additive: 4 columns on `SaaSOwnerUser`,
new `SaaSOwnerMfaSecret` table, `kind` column on `SaaSOwnerSession`).

### 1. CRITICAL FIX — production hydration was broken by the nonce CSP
- **Root cause found during verification**: the M-10 CSP used per-request
  nonce + `'strict-dynamic'`, but Next 16.3.8 + Turbopack **standalone builds
  never stamped the nonce** onto the bootstrap or RSC flight-payload
  `<script>` tags. Under that policy nonce-less scripts are blocked even from
  `'self'` → after `bun run start` every page rendered server-side with ZERO
  interactivity (the dev server stamped nonces, so the gap was invisible in
  dev). 
- **Fix**: `src/proxy.ts` → `src/proxy.ts` (Next 16 convention) with a
  hash-based policy that works everywhere: `script-src 'self' 'unsafe-inline'`
  (+ `'unsafe-eval'` dev-only). The App Router requires executable inline
  scripts (RSC flight payload), so a strict nonce policy cannot ship on this
  framework version; XSS defense leans on React escaping + C-07 output
  encoding + httpOnly cookies + CSRF echoes, and the CSP still hardens
  connect/img/frame/base/form/object. Restore the strict policy when Next
  fixes nonce stamping in standalone output (documented in `proxy.ts`).
- **Also found + fixed**: the pre-paint theme script was being blocked by the
  old CSP (theme flash before hydration). It now lives in
  `src/lib/prepaint-script.ts` as the single source of truth, and `/owner`
  surfaces get their own theme branch (default DARK — previously the owner
  pages had NO theme class at all, so shadcn inputs rendered light-theme
  near-black text on the dark card: the reported "typed email unreadable" bug).

### 2. Owner console TOTP MFA (the `security.ownerMfaRequired` gap — closed)
- Full second-factor lifecycle on the platform plane, mirroring the tenant
  discipline: encrypted secrets (AES-256-GCM, `HRM_MFA_KEY`), replay-protected
  TOTP verification, 10 single-use recovery codes (sha-256 hashed), 5-minute
  MFA_PENDING / 10-minute ENROLL_PENDING pre-auth challenge sessions that
  authorize NOTHING until promoted.
- Login flow: enrolled owners get the TOTP step (with recovery-code fallback);
  when the platform policy requires MFA and an owner never enrolled, the
  password-verified session routes them through a forced first-login
  enrollment wizard (QR + manual key) — never a lockout.
- Self-service from Settings → My Account: enroll (password-confirmed QR),
  disable (password + current code), recovery codes shown exactly once.
- Super-admin rescue: Owner Users gains an MFA column + "reset MFA" action
  (SUPER_ADMIN only, audited, burns the target's sessions) for lost devices.

### 3. Owner password recovery (the "no forgot password" gap — closed)
- `/owner/forgot-password` + `/owner/reset-password` pages; `owner.auth.password.forgot`
  / `.reset` public actions. Tokens are 32-byte randoms stored as sha-256
  hashes, single-use, 60-minute expiry, per-IP throttled, and the response is
  enumeration-safe (identical for known/unknown emails).
- Completing a reset burns every active owner session. In dev without a
  gateway the link is echoed on the server console; production requires the
  platform gateway (below).

### 4. Platform email/SMS gateway (the "not wired to a gateway" gap — closed)
- New `src/hrm-server/saas/notify.ts`: platform-owned SMTP + SMS gateway
  configuration (SaaSSetting group `gateway`) — deliberately NOT reusing
  tenant gateway credentials. Same mechanics + H-10 SSRF guards as the tenant
  stack (https-only public-host SMS URLs validated at save AND send time,
  CRLF-safe From display names), same SENT/FAILED/SKIPPED contract — an
  unconfigured channel skips transparently and never breaks a workflow.
- Settings → Platform Gateway card: full SMTP + SMS config with masked
  secrets (blank = keep stored value) and a test-send button.
- Wired notifications: new registration applications + contact inquiries →
  owner team (permission-filtered); approval/rejection → the applicant;
  subscription expiry reminders (communication.notifyOnExpiryDays) → owners +
  tenant admin via a new date-guarded platform daily job on the scheduler
  (per vendor+endDate+days dedupe so each notice fires exactly once).
- Console-visible feed: every attempt (sent/skipped/failed) lands in the
  audit log and the new notifications bell in the console header.

### 5. Onboarding wizard (the "post-approval checklist" gap — closed)
- New `onboarding.status` / `onboarding.dismiss` tenant RPCs compute a live
  checklist from real DB rows: branch, department, designation, first
  employee, shift, invite a colleague (recommended), enable MFA (recommended).
- Dashboard widget for VENDOR_OWNER / HR_ADMIN: progress bar, per-step links
  straight into the completing module, dismiss persists per vendor
  (HrSetting group `onboarding`), auto-hides when everything is done.

### 6. UX gaps — password eye toggles, owner theme, users, overrides, legal
- **Eye toggles**: every password field on `/owner/login` (+ forgot/reset) and
  all five password fields on the `/app` sign-in card (credentials, reset,
  expiry) now has a show/hide eye button.
- **Owner console dark/light**: `owner_theme` storage (default dark, separate
  from `hrm_theme`/`site_theme`), pre-paint branch, Sun/Moon toggle in the
  console header and on all auth pages, and a full `light:` re-skin of the
  shell + every console page (479 utility variants). The typed-input
  readability bug is fixed by the theme class + explicit input colors.
- **Owner Users**: MFA column + super-admin reset (above).
- **Tenant overrides dialog**: module keys now carry friendly labels +
  tooltips + a legend explaining (plan)/ON/off semantics — the documented
  "keys use HRM module keys" limitation is now properly surfaced in the UI.
- **Legal pages**: full structured Terms of Service (13 sections) and Privacy
  Policy (10 sections) with clearly marked `[BRACKETED]` placeholders for
  counsel (entity, jurisdiction, retention windows, transfer mechanism) and a
  factual cookie/localStorage table (the three theme keys + both session
  cookies).

### 7. Demo seed salary-payout fix — verified present
- The pre-existing gap (paid payroll run failing payout validation) is fixed
  additively in `seed.ts` via `isSalaryPayoutAccount` + `salaryPayoutMethod`
  seeding — confirmed in the shipped seed; no action needed.

### Verification
- TypeScript clean, ESLint clean (0 problems), **759/759 unit tests** (49 new
  assertions in `tests/unit/owner-mfa-recovery.test.ts`: MFA challenge
  non-authorization, TOTP replay rejection, single-use recovery codes, forced
  enrollment policy, self-enroll/disable, full reset round-trip + enumeration
  safety, gateway masking/keep-secret/SKIPPED/SSRF).
- Production build clean; standalone server verified in-browser: pre-paint
  dark (no flash), eye toggles, sign-in → MFA challenge → TOTP → dashboard,
  recovery-code login, forgot → planted-token reset → new-password login,
  notifications bell, gateway settings cards, console light mode (computed
  colors verified), onboarding widget on a freshly provisioned tenant
  (step navigation + dismissal), legal pages.
- `saas-smoke.py`: **51/51 PASS** (run on a clean DB; the script is not
  idempotent — reset residue with `scripts/reset-smoke-residue.ts` between runs).

# Owner Login Fix + Public Website Light/Dark Theme (2026-10-03, Build 7)

Two user-reported items: the owner console login page rendered blank, and the
public website had no light-mode option.

### 1. Blank `/owner/login` — fixed (route-group restructure)
- **Root cause**: `src/app/owner/layout.tsx` wrapped EVERY `/owner/*` route —
  including `/owner/login` — in `OwnerShell`. For an unauthenticated visitor the
  shell calls `owner.auth.me`, fails, and `return null`s while redirecting to
  `/owner/login` (where the visitor already is). The login form (children) was
  never rendered → white page.
- **Fix**: console pages moved into the `src/app/owner/(console)/` route group
  whose layout applies `OwnerShell`; `/owner/login` now sits OUTSIDE the group
  and renders under the metadata-only `/owner` layout. URLs are unchanged
  (`/owner`, `/owner/audit`, … all resolve exactly as before).
- The unauthenticated redirect (`/owner` → `/owner/login`) still works — verified
  in-browser; owner sign-in verified end-to-end (login → dashboard).
- Removed the dead Moon/Sun button in `OwnerShell` (it toggled state but styled
  nothing — misleading UI).

### 2. Public website dark/light theme
- **Infrastructure**: new `@custom-variant light (&:is(:root:not(.dark) *))` in
  globals.css (+ `color-scheme` for both modes) — the site stays dark-first
  (the shipped design is untouched) and every public surface gained explicit
  `light:` re-skin utilities.
- **Preference model**: `site_theme` localStorage key (deliberately separate
  from the HRM app's `hrm_theme`), falling back to the OS `prefers-color-scheme`.
  The root layout's pre-paint script now resolves per-surface: `/app` keeps
  `hrm_theme`, `/owner` is always-dark chrome, everything else follows
  `site_theme` — applied before first paint (no flash).
- **Toggle**: Sun/Moon button in the public header (desktop + mobile),
  hydration-safe icon, persists across reloads and client-side navigations
  (`SiteThemeSync` re-asserts the class when arriving from `/app`).
- **Coverage**: header (incl. mega-menu + mobile drawer), hero (the product
  mockup intentionally stays dark in both themes — it depicts the application,
  like a screenshot), value props, capability strip, feature grids, device
  spotlight, security sections, how-it-works, CTA bands, pricing cards,
  register form (all 4 steps), contact form, status tracker, FAQ, about,
  legal pages. The footer intentionally stays dark in both themes (anchors the
  page). shadcn components (selects, inputs, toasts) theme via the existing
  CSS variables automatically.
- `SectionHeading`'s unused `tone` prop removed (superseded by the variant).

### Verification
- `tsc --noEmit` clean, `eslint .` clean (0 problems).
- Unit tests: 749/749 pass.
- Production build clean; `scripts/saas-smoke.py`: **51/51 pass** (routes,
  registration → approval → provisioning → enforcement → billing → audit →
  RBAC → plane separation) — includes GET `/owner` and `/owner/login` after the
  restructure.
- In-browser: login form renders & owner sign-in works; theme toggles both
  ways, persists across reload + client nav; light mode pixel-verified on
  landing/pricing/register/FAQ/feature pages; `/app` unaffected.
