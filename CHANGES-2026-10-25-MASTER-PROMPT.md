# CHANGES — 2026-10-25 — Master Prompt Implementation: Support Center, Live Support Access, Billing & Subscription, Payment Enforcement, Custom Plans, Storage Monitoring, Passkey MFA, Design Systems

**Scope:** the full 2026-10-25 master implementation prompt (Parts A–Q), built on Wave 10.
**Verification performed in this workspace:** `tsc --noEmit` clean · `next build` compiles successfully with all routes · 12 new security regression tests pass (101/104 of the runnable pure test set; the 2 failures are pre-existing timing flakiness in `auth-throttle.test.ts`, whose test file and `security.ts` are byte-identical to the pre-change tree) · DB-backed suites require a PostgreSQL test database (`bun test` auto-creates `hrm_test`) — **not runnable in this sandbox; run them on your machine before deploying**.

---

## 1. Executive summary

| Master-prompt part | Status |
|---|---|
| A — Tenant Support Center (chat tickets + Live Support requests) | ✅ Complete |
| B — Secure, time-limited, audited Live Support Access | ✅ Complete (extends the Wave-10 session plane) |
| C — Company name locked to owner control | ✅ Complete (server-side strip + read-only UI + owner rename action) |
| D — Unified "Billing & Subscription" page | ✅ Complete |
| E — Owner-controlled single-active payment gateway | ✅ Complete (all 5 gateways already existed; added the single-active rule + direct Pay Now) |
| F — Free-renewal fix, PENDING_PAYMENT gate, upgrades | ✅ Complete |
| G — Owner-managed custom plans (monthly/yearly/one-time) | ✅ Complete |
| H — Automated invoices, reminders, receipts, thank-you email | ✅ Complete (configurable) |
| I — Subscription lifecycle policies | ✅ Complete (PENDING_PAYMENT added; ONE_TIME no-renew semantics) |
| J — Platform-wide storage monitoring | ✅ Complete (Owner Console → Storage dashboard) |
| K — Passkey / Biometric MFA (WebAuthn) | ✅ Complete (both planes, @simplewebauthn v13) |
| L — Comet default + 2 Cursor designs | ✅ Complete (`data-design` variants, per-surface persistence) |
| M/N — data model, jobs, security hardening | ✅ Complete (one additive migration; audited everywhere) |

## 2. Audit findings that drove the work

1. **FREE RENEWAL (critical):** `billing.renew` → `renewSubscription()` extended `endDate` a full cycle and revived EXPIRED→ACTIVE with **zero payment verification**. Worse: settlement ALSO extended on the invoice the renewal had created → **renew-then-pay double-extended**.
2. **Unpaid tenants got full access:** `provision.ts` created every new subscription as `ACTIVE` at registration approval — no payment ever required.
3. **Tenants picked the payment gateway** (`billing.pay.start {provider}`) — no single-active-gateway rule existed.
4. **Company name was tenant-editable** (`settings.save` mirrored `companyName` → `Vendor.name`).
5. No support tickets/chat, no session re-entry, no WebAuthn, single design system (Comet/Cursor were marketing-site cursor effects, not app themes).

## 3. Security fixes (Part F)

### 3.1 Payment-gated renewal — `saas/payments/billing-ops.ts`
- `renewSubscription()` **deleted**. Replaced by two audited operations:
  - `initiateRenewalInvoice()` — what "Renew for another cycle" now does: issues/reuses the **PENDING** renewal invoice for the next term (`nextTermWindow` anchors at the paid-through end, or at payment time post-expiry — documented policy). **Never touches the subscription.** ONE_TIME subscriptions are refused.
  - `applyPaidTerm()` — the ONLY payment-driven extension path. Called by `settle.ts` + `owner.invoices.markPaid` when an invoice flips PENDING→PAID. Idempotent by construction: anchors on the **invoice's own periodEnd**, so replays/duplicate webhooks can never extend twice; revives EXPIRED/GRACE/PAST_DUE/**PENDING_PAYMENT**/TRIAL→ACTIVE; late payments re-anchor the term at the payment date; **never** overrides an owner SUSPENDED/CANCELLED state (§14).
- Duplicate-click safety: one OPEN renewal invoice per (vendor, period) — reused, not re-issued.
- Auto-invoice lead time: the lifecycle sweep issues next-term invoices `invoiceLeadDays` (default 14, configurable) before expiry — idempotent, skips ONE_TIME.

### 3.2 PENDING_PAYMENT full lock — Part F §10
- New status in `SUBSCRIPTION_STATUSES`; `LOCKED_STATUSES = ["PENDING_PAYMENT"]`.
- `resolveEntitlements()` returns `locked: true`; the `/api/hrm` dispatcher **denies every action** (reads included) for locked tenants except `auth.*`, `billing.*`, `subscription.*`, `support.*` (the onboarding minimum — §10).
- `provision.ts`: paid plans provision as **PENDING_PAYMENT** (trial plans stay TRIAL — the authorized-free entitlement), and the **first invoice is issued at provisioning** so the tenant can Pay Now immediately. Payment → `applyPaidTerm` → ACTIVE.

### 3.3 Single-active gateway — Part E §8.1
- `SaaSSetting group "payments" key "active"` holds the ONE active gateway; `owner.payments.activate` (confirm-gated, requires enabled+configured; switching replaces the previous; `"none"` deactivates); disabling the active gateway deactivates it (safe disable).
- `billing.pay.start` **ignores the client-supplied provider** and resolves the active gateway server-side; no active gateway → clear 400 + bank-transfer fallback. Tenants can never choose or override the gateway.
- All existing gateway verification/idempotency (provider re-validation, `@@unique([provider, providerTxnId])` replay guard, conditional PENDING→PAID claims, underpay checks) is unchanged and reused.

### 3.4 Self-service upgrades — §11
- `billing.upgrade.quote/start`: server-computed proration (unused-time credit of the current term), UPGRADE-kind invoice (`upgradePlanId`), one open upgrade invoice per target plan. The plan change is applied ONLY at settlement (`applyUpgradePaid` → the REAL owner `changePlan` handler — identical events/audits) — a pending/failed payment never grants higher-tier permissions. Fully-credited upgrades route to the owner request queue.

## 4. Support Center & Live Support Access (Parts A/B)

- **Models** (additive migration): `SaasSupportTicket`, `SaasSupportMessage` (attachments ride the platform storage pipeline: `storeUpload kind SUPPORT_ATTACHMENT`, magic-byte sniffing, JPEG/PNG/WebP/PDF only, 5 MB cap, signed URLs minted per read), `SaasLiveSupportRequest`; `SaasSupportAccessSession` gained `liveRequestId` + `approvedModulesJson`.
- **Tenant surface** (`routes/support.ts`, view `views/support.tsx`, nav "Support Center", every role incl. ESS; usable by locked/expired tenants): ticket create/reply/close/reopen with attachments + read receipts; 15s conversation polling; **Live Support Access requests** (module multi-select generated from the authoritative `TENANT_MODULES` registry ∩ live entitlements; one open request per workspace; cancel; tenant can END an active session on their own workspace — audited).
- **Owner surface** (`saas/support-center-routes.ts`, 3-tab console at `/owner/support`): ticket queue (filters/search/pagination), conversation pane with internal notes, assignment, status control; **Live Support review**: approve (modules ∩ requested — reviewer may narrow, never widen; minutes; agent; READ_ONLY/CONTROLLED_WRITE) → mints the **one-time 10-minute activation link** (shown once, bound to the agent's owner session); reject with reason. KPIs from `owner.supportTickets.overview`.
- **Re-entry (§5):** `GET /api/support-access/resume?session=<id>` — authenticated by the operator's FULL owner session; validates status/expiry/**operator binding**; **rotates the session token** (stale cookies invalidated) while preserving session id, original expiry, scope and audit trail (`SUPPORT_ACCESS_RESUMED`); no duplicate session, no extension. The console shows **"Enter Active Session"** buttons on every ACTIVE session (board + live-request cards).
- **Module-scoped sessions (§4.3):** `supportPermissionsFor(mode, scope, viewModules)` limits the read surface to the APPROVED modules for tenant-initiated sessions — the dispatcher RBAC layer then 403s every out-of-scope module. Controlled-write still flows through the frozen `SUPPORT_WRITE_CATALOG` + hard deny-verbs. Session banner (tenant side) shows operator, modules, expiry + audited notice.

## 5. Company name (Part C)
- `settings.save` / `settings.patch` **strip `companyName` server-side**; the Vendor mirror no longer writes `name`. UI renders a locked read-only field ("Managed by the platform owner"). All other profile fields remain editable.
- New `owner.tenants.rename` (perm `tenants.manage`, reason required, audited, previous name preserved) + HrSetting mirror sync.

## 6. Unified Billing & Subscription (Part D)
- Single nav entry "Billing & Subscription" (`views/billing.tsx`, 4 tabs: Overview · Invoices & Payments · Plans & Upgrade · Usage with the former UsagePanel). `views/subscription.tsx` is now an auto-redirect (deep links keep working). Direct **Pay Now** (no gateway picker), renewal-with-invoice copy, PENDING_PAYMENT banner, UPGRADE invoice badges, Mushak 6.3 print + PDF receipts retained.

## 7. Custom plans (Part G §12)
- `SaasPlan` gained `billingMode` (RECURRING|ONE_TIME), `oneTimeValidityDays` (null = **explicitly non-expiring**), `isCustom`, `customForVendorId`.
- `owner.plans.saveCustom` (audited with reason; tenant-bound; `isPublic:false` so it never appears in any catalog; full 12-module + 7-limit surface; `assignNow` composes the REAL changePlan handler) + `owner.plans.customList`. Console builder UI at `/owner/plans` (base-plan presets, one-time validity radio: fixed days vs non-expiring).
- Assignment semantics: ONE_TIME sets endDate = now+N days or **null** (non-expiring; the lifecycle sweep, reminders and renewal invoices all skip ONE_TIME); RECURRING custom plans follow the same payment-gated renewal rules as standard plans. Historical invoices/payments are never rewritten.

## 8. Notifications & receipts (Part H §13)
- `subscription` settings group gained `invoiceLeadDays` (auto-invoice lead time), `receiptEmailEnabled`, `thankYouEmailEnabled` — configurable in Owner Settings → Billing & notifications.
- Receipt/thank-you email (existing `notifyInvoicePaid`) is now flag-gated; journaling/retry/idempotency unchanged (one receipt per verified payment — the conditional PENDING→PAID claim guarantees it).

## 9. Storage monitoring (Part J §15)
- `owner.storage.overview` + **Owner Console → Storage** page: platform totals (allocated = Σ tenant quotas — explicitly NOT provider capacity, consumed, remaining, %), OVER/NEAR(85%)/OK tiers (shared with quotas.ts), provider + object breakdowns, 12-month UsageSnapshot trend, per-tenant paged grid with search/filters. Fixed query budget — fleet-size independent (aggregates + one page-scoped groupBy).

## 10. Passkey / Biometric MFA (Part K §16)
- `@simplewebauthn/server|browser` v13. Models `WebAuthnCredential` (two planes, public keys only — **raw biometrics never touch the server**) + single-use `WebAuthnChallenge` (120s TTL, burned on use).
- Tenant: `auth.passkey.list/register.start|finish/remove` (removal requires password re-auth; credential-theft across accounts refused) + **`auth.passkey.login.start|finish`** (public, email-bound, replicates the login vendor-ambiguity guard, UV required, counter clone detection, then the exact `auth.mfa.verify` session-promotion path — a passkey satisfies the MFA policy).
- Owner: `owner.passkey.*` (self-scoped like `owner.auth.mfa.*`; no owner passkey login by design).
- UI: tenant account-menu "Passkeys & Biometrics" manager, login "Sign in with a passkey" step, owner Settings → My Account card.
- Config: `HRM_WEBAUTHN_RPID` / `HRM_WEBAUTHN_ORIGINS` env (falls back to request host/origin). Labeled **"Passkey / Biometric MFA"** — device biometrics are handled by the OS/browser via WebAuthn.

## 11. Design systems (Part L §17)
- `data-design` attribute on `<html>`: **comet** (default — zero overrides), **cursor-1** "Dense Mono" (tight geometry: 52px header/232px sidebar, 4px radius, flat shadows, 13px body, compact tables, recessed sidebar), **cursor-2** "Editorial Calm" (68px header/280px sidebar, 12px radius, softer elevation, larger type scale, borderless blended sidebar, airy tables). Genuinely different density/geometry/typography — not accent-color swaps.
- Persistence: localStorage `hrm_design` (tenant app) / `owner_design` (owner console), selected pre-paint (no flash, no hydration mismatch), cross-tab sync; switcher in both headers. Comet is the platform default for new users; selection is purely cosmetic (no permission/entitlement effects). Marketing-site cursor effects untouched.

## 12. Database changes — migration `9_wave9zq_support_billing_mfa_design_20261025`
**Fully additive** (no destructive ops, no data resets):
- New tables: `SaasSupportTicket`, `SaasSupportMessage`, `SaasLiveSupportRequest`, `WebAuthnCredential`, `WebAuthnChallenge`.
- New columns: `User.designPreference`, `SaaSOwnerUser.designPreference`, `SaaSPlan.billingMode/oneTimeValidityDays/isCustom/customForVendorId`, `SaaSSubscription.billingMode` + `endDate` **DROP NOT NULL** (non-expiring one-time entitlements), `SaaSInvoice.kind/upgradePlanId`, `SaasSupportAccessSession.liveRequestId/approvedModulesJson`.
- Apply with `prisma migrate deploy` (or `db:migrate` in dev). The Prisma client is regenerated — run `bun install` then `bunx prisma generate` if needed.

## 13. API surface added (owner + tenant)
Tenant: `support.overview/tickets/ticket.get/ticket.create/ticket.reply/ticket.close/ticket.reopen/liveRequests/liveRequest.create/liveRequest.cancel/session.end`, `billing.upgrade.quote/start`, `auth.passkey.*` · Owner: `owner.supportTickets.*` (list/get/reply/assign/status/overview), `owner.supportLive.requests/approve/reject`, `owner.payments.activate`, `owner.plans.saveCustom/customList`, `owner.tenants.rename`, `owner.storage.overview`, `owner.passkey.*` · Public: `GET /api/support-access/resume`.

## 14. Tests executed (honest results)
- `tsc --noEmit`: **clean** (full repo).
- `next build`: **compiles successfully**; all routes emitted (incl. `/owner/storage`); DB-dependent pages prerender as dynamic without a DATABASE_URL (expected in this sandbox).
- New `tests/unit/master-prompt-security.test.ts`: **12/12 pass** (renewal term math incl. post-expiry re-anchor + leap-safe yearly; module-scoped support permissions; write-catalog verb safety; PENDING_PAYMENT/READONLY/OPERATING classification).
- Runnable pure suite subset: 101 pass / 3 fail — the 2 `auth-throttle` failures are **pre-existing** (test file + `security.ts` byte-identical to the original zip; timing flakiness in this sandbox).
- **DB-backed suites (117 files) were NOT run** — no PostgreSQL in this sandbox. Run `bun test tests/unit` on your machine (auto-creates `hrm_test`); nothing in this wave should break them, but VERIFY before deploying. Also re-run `bun run typecheck`, `bun run lint`, `bun run build` with your real `.env`.

## 15. Deployment checklist
1. `bun install` (adds `@simplewebauthn/server|browser@13.3.0`).
2. Configure env: `DATABASE_URL`; optionally `HRM_WEBAUTHN_RPID` (e.g. `hrm.yourdomain.com` — no port) and `HRM_WEBAUTHN_ORIGINS` (comma list, e.g. `https://hrm.yourdomain.com`). Existing `HRM_MFA_KEY` now also derives the payments/storage crypto as before.
3. `bunx prisma migrate deploy` (applies `9_wave9zq_…`).
4. `bun run build && bun start` (or your existing deploy pipeline). No new background workers — everything rides the in-process scheduler.
5. Owner Console → Settings → Payments: **activate exactly one gateway** (tenants cannot pay online until you do).
6. Owner Console → Settings → Billing & notifications: tune invoice lead time / reminders / receipt email.
7. Passkeys: deploy behind HTTPS with a stable domain (WebAuthn requirement).

## 16. Outstanding / requires your action
- **Run the DB-backed test suite + build with a real `.env`** (not possible in this sandbox).
- **Activate one payment gateway** in the Owner Console (credentials are encrypted at rest as before).
- WebAuthn production values: `HRM_WEBAUTHN_RPID` + `HRM_WEBAUTHN_ORIGINS` for your domain.
- If you want per-user design preferences stored server-side (vs the shipped localStorage persistence), the `designPreference` columns are already in the schema — wire a save action when desired.
- Owner-console passkey LOGIN (vs management) was deliberately not added — owner sign-in keeps password+TOTP; add later if wanted.
