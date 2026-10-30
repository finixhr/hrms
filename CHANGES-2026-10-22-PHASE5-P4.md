# Phase 5 — P4 Security & Trust (2026-10-22): security posture, session governance, audit analytics

The Security & Trust slice of the SaaS Owner Panel roadmap, delivered as P4
on top of the P3 baseline (Phase 4 remediation + P0 observability + P1
lifecycle & quotas + P2 revenue & collections + P3 growth & engagement).
The Administration group was the last nav section still entirely
old-generation: the audit page was a bare 64-line paged table, the login
audit a flat list whose reason-mix was post-processed from the 500 newest
failure rows in JavaScript, and owner sessions — the most security-sensitive
table on the platform — had NO governance surface at all. P4 answers all
three with a new Security Console plus rebuilt audit surfaces, on the
P0/P1/P2/P3 design system. **No schema migrations, no new dependencies, no
env changes** — everything rides existing tables (`LoginAuditLog`,
`SaaSAuditLog`, `SaaSOwnerUser`, `SaaSOwnerSession`) and indexes; the
long-standing `owner.audit.list` and `owner.loginaudit.list` actions stay
untouched and compatible.

## What shipped

### 1. `owner.security.overview` — the platform security posture

One round trip answering EVERY number with a FIXED set of ~14 grouped
aggregates (fleet-size independent — no per-tenant fan-out, no take-capped
lists, no JS post-processing):

- **Team census** — owner users total / active / suspended, MFA enrolled +
  adoption % (the exact ratio, null when there are no users — never a
  fabrication), accounts locked RIGHT NOW (`lockedUntil > now()` — an
  expired lock never reads as locked), and accounts carrying failed-login
  counters. One `SaaSOwnerUser` scan, FILTER clauses.
- **Login windows** — attempts + failures for 24h / 7d / 30d in one
  `LoginAuditLog` scan (FILTER clauses), failure rates per window (null
  when nothing attempted), MFA-verified successes in 30d and the MFA share
  of successes (null when nothing succeeded), and distinct source IPs in
  30d.
- **Failure-reason mix** — 30d failures grouped by `failureReason` IN SQL
  (the legacy handler's take-500-then-count-in-JS approach is superseded on
  this surface; unrecorded reasons fold into an explicit UNKNOWN bucket),
  worst-first.
- **Offending-IP workbench** — IPs with ≥ `OFFENDER_MIN_FAILURES` (3)
  failed attempts in the trailing 30 days, failures-first with successes
  and last-seen riding each row so a busy shared NAT is visibly
  distinguishable from a pure attacker. Sub-threshold IPs, success-only
  IPs and out-of-window rows never list. Capped at 10.
- **Session census** — LIVE owner sessions only (`expiresAt > now()` —
  expired rows never count): full vs pre-auth challenge
  (`MFA_PENDING` / `ENROLL_PENDING`), expiring within 24h, distinct IPs,
  distinct owners.
- **Audit activity** — platform audit events 24h / 7d / 30d, the
  `NOTIFICATION_*` share, distinct actors in 30d, and the top-8 action and
  entity mixes.
- **Retention horizons** — the oldest retained row vs its sweep policy for
  all three logs: `SaaSAuditLog` (SEC-16: default 730 days, explicit
  `HRM_SAAS_AUDIT_RETENTION_DAYS=0` disables — parsed by the exported
  `auditRetentionDays()` exactly like `sweepSaasAuditRetention` in jobs.ts,
  no falsy-`||` trap), owner-plane `LoginAuditLog` (fixed 180 days), and
  tenant-plane rows (per-tenant configurable, default 180 — the default is
  what the response reports).
- **6-week trend** — attempts vs failures per calendar week (Monday-start
  UTC), folded into an always-six-weeks array.
- **Policy snapshot** — the enforcement knobs the login flow reads right
  now: owner MFA required, lockout threshold → minutes, owner session
  lifetime, and the offender signal floor.

### 2. `owner.security.sessions` — the live-session governance grid

The first owner surface over `SaaSOwnerSession` JOINed to the owner
identity. SQL-paged with the expiry band and idle minutes computed IN SQL
(`EXTRACT(EPOCH …)` minute arithmetic + a CASE: EXPIRING_1H / EXPIRING_24H
/ LATER), so the band chips filter and the sort never materialize the
session table:

- **Live rows only** — `expiresAt > now()` is a hard condition; expired
  sessions never surface.
- **Pre-auth challenges first** — `MFA_PENDING` / `ENROLL_PENDING` (the
  potentially-stuck attack surface) sort before full sessions, then
  soonest expiry, then owner name, then id (a stable tiebreak).
- **Owner identity rides the JOIN** — name, email, role key, status and
  MFA enrollment per row.
- **Chips + search are SQL WHERE conditions** — kind (All / Full /
  Pre-auth), expiry band (exact boundary semantics: EXPIRING_24H is
  [1h, 24h), never the <1h rows), and owner name/email search.
- **The per-session CSRF token is never selected** — it never leaves the
  server (grep-verified by the test suite).

### 3. `owner.audit.overview` — analytics for the rebuilt audit page

The analytics companion for the platform audit page, all fixed-set
group-bys over the `SaaSAuditLog` [createdAt] index: volume windows (24h /
7d / 30d), the `NOTIFICATION_*` share, distinct actors, the top-8 action /
entity / actor mixes, a 6-week volume trend (always six weeks), and the
retention horizon vs the SEC-16 policy.

### 4. NEW `/owner/security` — the Security & Trust console

Built on the P0/P1/P2/P3 design system (rose→red gradient header, 4 KPI
cards, 60s auto-refresh, dark + light modes):

- **Posture tab** — MFA adoption KPI (emerald at 100%, amber below, honest
  dash when there are no users), failed-logins-24h KPI (red tone when
  non-zero, rate + 7d context), live-sessions KPI (full / pre-auth /
  expiring split), audit-events-30d KPI; an alerts rail (locked accounts /
  stuck pre-auth challenges / suspended accounts) with a calm all-clear
  chip when everything is healthy; the 6-week attempts-vs-failures chart;
  the failure-reason mix with a 7d-vs-30d rate delta chip; the
  offending-IP workbench (pure-attacker vs mixed-traffic signal chips);
  the login lens (attempts / failures / rate / distinct IPs / MFA share +
  per-plane tiles); retention horizons (age vs policy, red when a horizon
  exceeds its policy, amber when a sweep is disabled); and the
  active-policies card (MFA required, lockout threshold→minutes, session
  lifetime, offender floor).
- **Sessions tab** — the governance grid: owner (name/email + suspended /
  no-MFA flags), role label, kind chip (Full / MFA pending / Enroll
  pending), created, last-seen freshness, expires-in countdown + band
  chip, IP, and a light UA-derived device hint. Kind + band chips, owner
  search, pagination. Read-only — session revocation is deliberately NOT
  invented here (no such owner action exists; P4 keeps every mutation
  untouched, the P2/P3 discipline).

### 5. REBUILT `/owner/audit` — "Platform Audit"

The bare 64-line table becomes a full console (amber→orange gradient
header): 4 KPIs (events 24h with 7d/30d context, active actors 30d, oldest
record age, retention policy state), a 6-week volume chart, top-actions /
entities-touched / most-active-actors mix panels, and the forensic grid
riding the untouched `owner.audit.list` (entity select + search +
pagination, status-chip action column, monospace IP). 60s auto-refresh.

### 6. REBUILT `/owner/loginaudit` — "Login Audit"

The flat list becomes a console (sky→blue gradient header): 4 KPIs from
the response's own counters (attempts / succeeded / failed + rate /
failure-mix summary within the CURRENT filter window), a failure-reason
legend chip rail, the full filter set (search, plane, outcome, device,
browser), device icons + UA tooltips, and a deep link to the Security
Console. 60s auto-refresh. Rides the untouched `owner.loginaudit.list`.

### 7. Nav — a dedicated Security & Governance group

The old Administration group is split: **Security & Governance** (Security
Console, Platform Audit, Login Audit, Owner Users, Roles & Permissions) and
**Administration** (Media Library, System Health, Backup & Recovery,
Platform Settings). The security surfaces — previously buried mid-list —
now head their own section, mirroring the P3 Growth & Engagement group.

## Files

- NEW `src/hrm-server/saas/security-console.ts` — the three actions
  (self-registering side-effect module, the fleet/lifecycle/billing/growth
  pattern) + the exported `OFFENDER_MIN_FAILURES`,
  `LOGIN_AUDIT_OWNER_RETENTION_DAYS`, `LOGIN_AUDIT_TENANT_DEFAULT_DAYS`
  and `auditRetentionDays()` policy helpers.
- NEW `src/app/owner/(console)/security/page.tsx` — the console.
- REBUILT `src/app/owner/(console)/audit/page.tsx`.
- REBUILT `src/app/owner/(console)/loginaudit/page.tsx`.
- MOD `src/app/api/owner/route.ts` — the side-effect import.
- MOD `src/saas/owner/shell.tsx` — the nav split + ShieldAlert icon.
- NEW `tests/unit/phase5-security-trust.test.ts` — 16 tests.

## Tests (16 new)

`tests/unit/phase5-security-trust.test.ts`:

- **Team census** — every counter vs full-table DB truth (same filters,
  independently written); adoption = the exact ratio; the four fixtures
  (MFA-on / MFA-off-with-failures / locked-now / suspended) all surface.
- **Login windows** — attempts / failures / MFA successes / distinct IPs
  as exact before→after DIFFs around a seeded mini-set (the shared-DB
  immunity discipline); the beforeAll fixture mass verified inside the
  baseline; internal rate consistency; TENANT + OWNER always both present
  in the plane split.
- **Failure-reason mix** — every DB truth row surfaces with the exact
  count (null → UNKNOWN), worst-first ordering, and the successful rows
  never leak (total mix = total truth).
- **Offending IPs** — threshold (2-failure and success-only IPs never
  list), 40d-old rows never list, worst-first between fixtures, the
  10-row cap, and every listed IP ≥ the floor.
- **Session census** — live/full/pending/expiring-24h/owners as exact
  DIFFs; the expired fixture counts nowhere.
- **6-week trend** — always six ascending weeks, sums move by the exact
  seeded deltas, per-week attempts ≥ failures.
- **Retention** — horizons + policy echo, and `auditRetentionDays()`
  env parsing (default 730 / explicit 365 / explicit 0 → null /
  garbage → null, env restored in finally).
- **Sessions grid** — search isolation, expired never surfaces, identity
  rides the JOIN, CSRF never crosses the boundary, pre-auth-first +
  soonest-expiry ordering with exact band values, kind chips narrow in
  SQL, band chips exact at the boundaries (the 2h row is EXPIRING_24H,
  NOT the <1h rows), pageSize-2 pagination without duplicates.
- **Audit overview** — volume windows as exact DIFFs, the three mixes
  equal the database's own top-8 group-by truth in exact order, the
  6-week contract, and the oldest-row age vs the DB's own MIN() within
  ±1 day.

## Verification (2026-10-22)

- `bunx tsc --noEmit` — 0 errors.
- `bun run lint` — 0 errors (4 pre-existing org-chart warnings).
- `DATABASE_URL=…hrm_test bash scripts/ci.sh` — **ALL 13 STAGES GREEN,
  EXIT 0**: 1416 unit tests (1400 + 16) + 6 perf, zero unexpected
  failures, fresh-database migration smoke clean, zero schema drift, perf
  budgets green.
- `bun run build` — compiles; `/owner/security`, `/owner/audit` and
  `/owner/loginaudit` all prerender as static routes.

## Hot-apply (existing installs)

Extract over the existing workspace (the overlay convention of every prior
delivery), then restart `bun run dev`. Only 7 files changed vs P3 —
`security-console.ts` (NEW), `security/page.tsx` (NEW),
`phase5-security-trust.test.ts` (NEW), plus the rebuilt `audit/page.tsx`
and `loginaudit/page.tsx`, the route side-effect import, and the nav
split. No migrations, no env changes, no new dependencies.
