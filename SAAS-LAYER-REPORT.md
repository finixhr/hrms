# SaaS Platform Layer — Technical Report

Added: 2026-10-03 · Build target: the existing Multi-Tenant HRM (Next.js 16 / React 19 / Prisma 6 / PostgreSQL)

This is the report required by the master prompt §66. The HRM application itself
was NOT rebuilt, replaced or simplified — every change is additive. The diff
touches the existing tenant code in exactly one class of way: server-side
entitlement guards, each of which is a no-op for pre-SaaS (LEGACY) tenants.

---

## A. What was built

1. **Public SaaS website** — premium marketing site (hero with product mockup,
   value props, feature catalog, device-integration spotlight, security section,
   how-it-works, CTA), dynamic database-backed pricing, about/FAQ/contact/legal
   pages, full SEO (per-page metadata, OpenGraph, sitemap.xml, robots.txt).
2. **Customer registration system** — public form (organization, administrator,
   scale, requirements, plan preference), platform-side review workflow, public
   status tracker, contact/sales inquiries.
3. **Subscription management** — plans with prices, capacity limits and module
   entitlements; one current subscription per tenant with append-only history;
   renewals calendar; manual billing (invoices + recorded payments) that is
   payment-gateway-ready.
4. **SaaS Owner Control Panel** (`/owner`) — completely separate plane: own
   sessions, own cookie, own RBAC, own audit log. Dashboard with real-data KPIs
   and charts, registration approval (transactional tenant provisioning),
   tenant lifecycle, plan editor, subscription operations, billing, inquiries,
   owner users, audit, platform settings.
5. **Entitlement engine** — server-side enforcement of plan features and
   capacity limits for every tenant request, plus read-only lockout for
   expired/suspended subscriptions.
6. **Tenant-side integration** — HRM moved from `/` to `/app` (SPA internals
   untouched), Subscription & Usage view, entitlement-aware navigation and
   read-only banner, registration link on the login view.

## B. New routes

| Route | Type | Purpose |
|---|---|---|
| `/` | public | landing page (marketing) |
| `/features` + `/features/[slug]` (10 pages) | public | feature catalog |
| `/pricing` | public, dynamic | plans from DB (monthly/yearly toggle) |
| `/about`, `/contact`, `/faq` | public | marketing / inquiry form |
| `/register` | public | registration application form |
| `/registration-status` | public, NOINDEX | application tracker (ID + email) |
| `/login` | public | redirect to `/app` (full sign-in incl. MFA lives in the app) |
| `/legal/privacy`, `/legal/terms` | public | honest placeholders |
| `/app` | tenant SPA | the existing HRM (moved from `/`), NOINDEX |
| `/owner`, `/owner/login`, `/owner/registrations`, `/owner/tenants`, `/owner/tenants/[id]`, `/owner/plans`, `/owner/subscriptions`, `/owner/renewals`, `/owner/billing`, `/owner/inquiries`, `/owner/users`, `/owner/audit`, `/owner/settings` | owner console | NOINDEX, separate plane |
| `/sitemap.xml`, `/robots.txt` | public | SEO; private surfaces excluded |
| `/api/saas` (POST) | public API | `public.plans`, `public.register`, `public.registrationStatus`, `public.contact` |
| `/api/owner` (POST) | owner API | 40+ `owner.*` actions (auth, dashboard, registrations, tenants, plans, subscriptions, renewals, invoices, inquiries, users, audit, settings) |
| `/api/hrm` | tenant API | **unchanged contract**; one new read-only action `subscription.overview` |

Unchanged: `/iclock/*`, `/ISAPI/*` (device plane), `/api/health|metrics|readyz`,
`/api/integrations/zkteco`.

## C. New database models (12, migration `5_saas_platform_20261003`)

`SaasPlan` (table `SaaSPlan`), `SaasSubscription` (unique per vendor), `SaasSubscriptionEvent`
(append-only history), `SaasRegistration`, `SaasTenantOverride` (per-tenant feature/storage
overrides), `SaasOwnerUser`, `SaasOwnerSession`, `SaasAuditLog`, `SaasSetting`,
`SaasContactInquiry`, `SaasInvoice`, `SaasPayment` + back-relation
`Vendor.saasSubscriptions`. The migration is purely additive (12 CREATE TABLE +
indexes + FKs, zero drops) and was verified against a fresh database and against
a database containing seeded HRM data.

## D. New APIs / RPC actions

- `/api/saas`: `public.plans`, `public.register`, `public.registrationStatus`,
  `public.contact` — zod-validated, per-IP rate limit (30/5 min), registration
  honeypot, no tenant data reachable.
- `/api/owner`: `owner.auth.login/logout/me`, `owner.dashboard.overview`,
  `owner.registrations.{list,get,review,approve,reject,reopen}`,
  `owner.tenants.{list,get,suspend,reactivate,setOverride}`,
  `owner.subscriptions.{list,changePlan,extend,cycle,grace,cancel}`,
  `owner.renewals.list`, `owner.invoices.{list,create,markPaid}`,
  `owner.inquiries.{list,handle}`, `owner.users.{list,save}`,
  `owner.plans.{list,save,duplicate,toggle,forApproval}`,
  `owner.audit.list`, `owner.settings.{get,save}`.
- `/api/hrm`: one addition — `subscription.overview` (any session of the vendor).

## E. New owner permissions (granular, dot-namespaced)

`dashboard.view`, `registrations.{view,manage,approve,reject}`, `tenants.{view,manage}`,
`plans.{view,manage}`, `subscriptions.{view,manage}`, `billing.{view,manage}`,
`inquiries.{view,manage}`, `users.{view,manage}`, `audit.view`, `settings.{view,manage}` —
with 5 role templates (SUPER_ADMIN, ADMINISTRATOR, SALES_MANAGER, BILLING_MANAGER,
SUPPORT_MANAGER). The vocabulary is deliberately separate from tenant RBAC
(`owner.*` style keys; no import shared with `../types`).

## F. Subscription / entitlement architecture

- `resolveEntitlements(vendorId)` (10 s memo) merges plan entitlements with the
  tenant override and resolves the subscription state → `{ mode, status,
  features, limits, overrides, readonly }`.
- **LEGACY mode**: vendors without a subscription row (all pre-SaaS deployments)
  get full access and no limits — the SaaS layer can never brick an existing
  customer. Overrides still apply (they exist precisely for that).
- Enforcement points:
  1. `/api/hrm` dispatcher — module feature gate (`MODULE_FEATURE_GATES`) and
     read-only lockout (mutating verbs blocked; views/exports/downloads and the
     auth/notification/subscription surfaces always work).
  2. Targeted capacity guards: `employees.create` + `createWithStructure`
     (seats), `employees.updatePhoto` + employee-doc uploads + leave attachments
     (storage), branch/department create (organization CRUD factory),
     `users.save` create branch (user seats), `devices.save` create (device
     seats), `tracking.start` (tracking seats).
- Read-only statuses: EXPIRED, SUSPENDED, CANCELLED → workspace stays fully
  readable, data is never deleted; PAST_DUE/GRACE_PERIOD keep the tenant writable.
- Client hiding is convenience only — the server is the boundary.

## G. Registration workflow

Visitor → `/register` (zod + honeypot + duplicate guards; admin password hashed
with scrypt at submit time) → `SaasRegistration` (PENDING, Application ID
`HRM-YYYY-NNNNNN` from a reserved platform sequence) → owner review
(UNDER_REVIEW / REQUEST_INFO / internal + shared notes) → **approve**: ONE
transaction creates vendor + VENDOR_OWNER admin (the password chosen at
registration) + password policy + 14 approval workflows + 8 statutory BD leave
types + subscription (price snapshot, cycle-computed end date, optional trial
window) — or **reject** (reason required, record retained, re-openable).
Applicant tracks status at `/registration-status` (safe projection only).

## H. Tenant onboarding after approval

The provisioned admin signs in at `/app` with the registration password. On
approval the workspace already contains statutory configuration (BD leave types,
AIT FY 2025-26 via idempotent bootstrap, 14 single-step approval workflows) and
the full tenant-admin permission set, so a one-person HR team is immediately
functional. First sign-in walks MFA enrollment for VENDOR_OWNER (the app's
existing first-login wizard). A polished multi-step onboarding checklist inside
the app is a future enhancement — the required foundation (provisioned
defaults + permission set) is in place.

## I. Security controls

- **Plane separation**: owner sessions live in `SaasOwnerSession` behind cookie
  `saas_owner_session`; tenant sessions stay in `Session` behind `hrm_session`.
  Lookups never cross (verified by unit test + smoke test): a tenant token gets
  401 on `/api/owner` and vice versa.
- Tenant isolation unchanged: every query stays vendor-scoped; cross-tenant ids
  resolve to 404.
- CSRF: owner API requires the `X-CSRF-Token` echo for cookie-authenticated
  calls (Bearer exempt, same construction as the tenant API).
- Registration surface: strict content-type, body cap, per-IP rate limit,
  honeypot, zod whitelist; status lookup requires ID + matching email and never
  exposes internal notes/reviewer identity.
- Owner RBAC enforced per action in the dispatcher before handlers run.
- Public pages carry no tenant data; pricing reads only the plan table.
- SEO boundary: public INDEXABLE; `/app`, `/owner`, `/api/*`, `/iclock`,
  `/ISAPI`, `/registration-status` NOINDEX/robots-disallowed.

## J. Migrations

`prisma/migrations/5_saas_platform_20261003` — additive only. Verified:
`DROP DATABASE` → `prisma migrate deploy` applies 0–5 cleanly (fresh DB), and
the full demo seed (which wipes + reseeds existing HRM data) runs to completion.
Non-destructive by construction; no existing table is altered or dropped.

## K. Tests

- `tests/unit/saas-layer.test.ts` — 18 tests: entitlement modes, overrides,
  readonly states, capacity math + messages, unlimited limits, cycle math,
  registration status flow, platform sequences, owner/tenant plane separation,
  owner lockout, transactional provisioning (full assertions on vendor/admin/
  workflows/leave types/policy/subscription) + clean-failure case, settings
  whitelist. Suite total: **749 passing**.
- `scripts/saas-smoke.py` — 51-check end-to-end harness against the production
  build (registration → status → owner login → dashboard → approve → provisioned
  admin sign-in through the REAL MFA flow (computed TOTP) → plan enforcement →
  suspend/reactivate → renewals → audit → owner RBAC → billing → contact).
  Final run: **51/51**.

## L. Remaining limitations (honest)

1. Online payment is NOT implemented — billing is manual (invoices + recorded
   payments). The schema (invoices/payments/methods/transaction ids) is
   gateway-ready; no fake payment confirmation exists anywhere.
2. Owner-side outbound email/SMS is not wired to a gateway; the platform layer
   deliberately does not duplicate the tenant-level gateway stack. Owner
   notifications are visible in the console (and communication toggles are
   stored for when a platform gateway is configured).
3. Owner MFA is a stored setting (`security.ownerMfaRequired`) — TOTP
   enforcement for owner accounts is not yet implemented (tenant MFA is fully
   implemented and unchanged).
4. In-app onboarding wizard (post-approval checklist) is not built; approval
   provisions a fully-configured workspace instead.
5. Legal pages are honest placeholders — the operator's counsel must finalize.
6. `SaaSTenantOverride` storage override is enforced; per-module override keys
   use HRM module keys (documented in the owner UI).
7. The demo seed required a fix to configure salary payout designations (a
   pre-existing gap: the paid payroll run failed payout validation without
   it). Fixed additively in `seed.ts` with `isSalaryPayoutAccount` +
   `salaryPayoutMethod` seeding.

## M. How to run locally

```bash
# 1. PostgreSQL (see DEPLOYMENT-GUIDE.md; the URL below matches .env)
export DATABASE_URL="postgresql://hrm_user:PASSWORD@127.0.0.1:5432/hrm"

# 2. install + migrate + generate
bun install
bunx prisma migrate deploy
bunx prisma generate

# 3. seed (full demo incl. SaaS layer)
bun run seed            # or: HRM_SEED_KEEP_DATA=1 for add-only

# 4. run
bun run dev             # development
bun run build && bun start   # production (standalone)
```

## N. Creating the first SaaS Owner account

Set these in `.env` **before** seeding (production refuses weak defaults):

```bash
HRM_SAAS_OWNER_EMAIL="owner@yourdomain.com"
HRM_SAAS_OWNER_NAME="Platform Owner"
HRM_SAAS_OWNER_PASSWORD="at-least-12-characters"   # REQUIRED in production
bun run seed:saas       # standalone; bun run seed / seed:owner also create it
```

Dev default (non-production only): `owner@finixhr.local` / `SaasOwner@2026` —
change immediately. If the password is missing/weak the seed prints a refusal
and skips the account — nothing is half-created.

## O. Creating / editing subscription plans

Owner console → **Plans** (requires `plans.manage`). Every field is editable:
prices (monthly/yearly), currency, all capacity limits (empty = unlimited),
11 module entitlement toggles, support level, storefront visibility, badge,
sort order, trial flag. Duplicate creates an inactive hidden draft. The public
pricing page reflects changes immediately (it reads the table, nothing cached).

## P. Approving a customer

Owner console → **Registration Applications** → open an application → *Review &
decision*: mark under review / request information (both audited), then
**Approve & provision** — choose the plan explicitly at approval time, pick the
cycle, optionally set a trial window. One transaction provisions the tenant;
on any failure nothing is created. Rejecting requires a reason and keeps the
record (re-openable).

## Q. Testing the complete flow

```bash
# start the production build on a port
PORT=3100 bun start
# 51-check lifecycle harness (assumes a freshly seeded DB)
python3 scripts/saas-smoke.py http://127.0.0.1:3100
```

Unit tests: `bun test tests/unit` (749 passing). Typecheck: `bun run typecheck`.
Lint: `bun run lint` (clean). Build: `bun run build` (clean; one pre-existing
Turbopack warning in instrumentation.ts, untouched).
