# CHANGES — 2026-10-24 · Wave 10 — INFRASTRUCTURE ROUND (master prompt completion)

**Source:** the "MASTER IMPLEMENTATION PROMPT — FINIX HR INFRASTRUCTURE,
PAYMENTS, STORAGE, SMS & SECURE SUPPORT ACCESS" (10 phases, 12 non-negotiable
rules). The previous session laid the migration + several module skeletons;
this delivery completes, wires and tests the entire round end-to-end on the
R1–R7 tree.

**Verification (this build):** `tsc --noEmit` EXIT 0 · `prisma validate` ✓ ·
generated Prisma Client carries all four new delegates · **zero schema
drift** for the new tables (schema DDL diffed column-by-column against
migration `9_wave9zp`) · **120/120 Wave 10 pure-function assertions green**
(`scripts/verify-wave10.ts`; the same matrix ships as
`tests/unit/wave10-infra.test.ts` for the DB-backed CI lane).

---

## Phase 1 — repository audit (continued-session recovery)

The frozen session left: migration `9_wave9zp` (4 tables + 1 index),
`saas/support-access.ts` + `support-access-routes.ts`, the `/api/support-access/enter`
endpoint and the `src/hrm-server/sms/` module family — all present but
**unwired** (no schema models → typecheck broken; no dispatcher imports; no
console UI; Paystation/EPS absent). This round closes every gap:

| Gap found | Closed by |
|---|---|
| 4 Prisma models missing from schema.prisma (code referenced `db.saasSupportAccessSession`/`db.saasSmsMessage` → build broken) | schema models added to match the migration SQL **byte-for-byte** (drift-diff verified) + `@@index([provider, sessionId])` on SaaSPayment |
| Paystation + EPS adapters missing (registry had 3 of the 5 required gateways) | new `paystation.ts` + `eps.ts`, registry/credentials/settle/IPN wiring |
| Support access dead code — not reachable from either plane | full wiring list below |
| Storage + OTP tables unused (no service code) | new `saas/storage.ts` + `saas/otp.ts` services |
| SMS journal pipeline never called | both send planes funneled through `sendSmsJournaled` |
| No owner-console surfaces | `/owner/support` page + Settings→Payments/Storage/Gateway upgrades |

## Phase 2 — Time-Limited Support Access (master prompt §2)

**Security model** — a THIRD session plane (own cookie `saas_support_session`,
own table, own CSRF) that never merges with either existing plane:

- **One-time 60-second enter capability** is the only owner→tenant bridge
  (`owner.supportAccess.start` mints it after `support.access` — and
  `support.manage` additionally for CONTROLLED_WRITE; burned on first use,
  operator-bound, throttled 30/10min/IP, never persisted in plaintext —
  only its sha256).
- **Server-side expiry on every request**: `/api/hrm/route.ts` resolves the
  support cookie as a FALLBACK identity when no tenant session exists;
  `resolveSupportCtx()` enforces status + expiry per call, lazily expires
  stale rows (audited), and throttles lastSeen stamps.
- **Deny-by-default action policy at the dispatcher**, before normal RBAC,
  for EVERY action a support context attempts: READ_ONLY = `*.view` across
  all modules; CONTROLLED_WRITE = only the explicitly scoped
  `SUPPORT_WRITE_CATALOG` (attendance corrections, device troubleshooting,
  job-queue recovery); internally-authorized self-scoped routes
  (`ess.*`, `tracking.*`…) refused outright (they require a real employee
  identity); hard-deny verbs (export/reveal/purge/pay/approve/…) refuse
  even if smuggled into scope; alt-perm dual-verb routes must satisfy the
  policy on BOTH paths. Refusals audit `SUPPORT_ACCESS_DENIED` on the
  platform plane.
- **The synthetic `SUPPORT` RoleKey** matches no special-cased role
  anywhere → every in-handler role check denies by default.
- **Lifecycle**: end/revoke with conditional updates (concurrent exits
  settle once), full history with filters, platform policy editor
  (enable, default/max minutes, ticket-required-for-write, concurrency cap),
  daily sweeper in `platformDailyJobs`.
- **Tenant-side UX**: `auth.me` rides `supportSession` (operator, tenant,
  mode, expiry) → persistent countdown banner in the app shell
  (UX only — the server clock is the boundary) with one-click
  `auth.supportExit` (audited END + cookie clear).
- Owner console: new **Support Access** page (`/owner/support`) — overview
  KPIs, tenant-search start form with scope checkboxes, live board with
  per-second countdowns + End/Revoke, filterable history, policy editor.
  Nav entry gated by the new `support.access` owner permission
  (SUPPORT_MANAGER template: `support.access`; ADMINISTRATOR: both;
  version-gated role backfill bumps `roles.permsVersion`).

## Phase 3 — Payment gateway depth (master prompt §3)

All five Bangladeshi gateways the prompt requires are now registered behind
the WP-I abstraction (SSLCommerz, bKash tokenized checkout, Nagad Payment
Init v3 — existing; **PayStation** + **EPS** — new this round):

- **`paystation.ts`** — Hosted Checkout per paystation.com.bd docs:
  `POST /initiate-payment` (invoice_number = OUR payment-row id → the verify
  response echoes OUR reference = merchantTxnId cross-check), status via
  `POST /transaction-status` with the merchantId HEADER, and the JSON IPN
  (invoice_number/trx_status/trx_id) treated as UNTRUSTED — every callback
  AND IPN is re-confirmed through the credential-gated status API before
  settlement. Sandbox/live bases switch on the credential `mode`.
- **`eps.ts`** — EPS engine per the official integration guide:
  `POST /v1/Auth/GetToken` (x-hash = base64(HMAC-SHA512(hashKey, username))),
  `POST /v1/EPSEngine/InitializeEPS` (x-hash over the merchantTransactionId +
  Bearer; ProductList built from the invoice), completion authority =
  `GET /v1/EPSEngine/CheckMerchantTransactionStatus` with in-memory bearer
  caching + one 401 retry. The merchant portal's IPN may strip our query
  string and post only ITS session reference — `handleIpn` resolves our
  payment row through the new `@@index([provider, sessionId])`
  (migration 9_wave9zp's documented purpose) and re-verifies the resolved
  row server-side; `/api/payments/ipn` now accepts ref-less IPNs by adopting
  the adapter's verified merchantTxnId.
- Credentials: AES-256-GCM under the dedicated `saas-payments::v1` context,
  masked round-trips (blank secret = keep existing), per-provider zod
  schemas; settle maps both providers into the CARD method bucket.
- Owner console: Settings → **Payments** tab — a card per gateway
  (enabled toggle, sandbox/live, credential fields with has*Secret hints,
  per-provider integration hints).

## Phase 4 — Cloud object storage (master prompt §4)

New `saas/storage.ts` — provider-independent abstraction behind ONE
interface, two adapters:

- **Cloudflare R2** — S3-compatible with **pure-TS SigV4** (no AWS SDK):
  header-signed PUT/DELETE + time-boxed presigned GETs
  (`sigv4Sign`, validated against an independently-written reference
  implementation of the documented algorithm across a unicode/multi-segment
  case matrix); public delivery via optional custom-domain base URL.
- **Cloudinary** — signed upload (`/auto/upload`, sha1 API signature),
  tamper-proof `s--…--` signed delivery URLs, signed destroy.
- Credentials in SaaSSetting group "storage" under the SEPARATE
  `saas-storage::v1` crypto context; masked console reads; enabling requires
  `HRM_MFA_KEY` (same rule as payments).
- **Every object journaled** in `StorageObject` (content sha256, size, sniffed
  mime, logical owner ref, FAILED+lastError on provider errors) — the console
  stats strip aggregates it.
- **Avatar offload live**: `employees.updatePhoto` now offloads photo
  data-URLs to the ACTIVE provider when configured and stores the https URL
  (every existing reader already handles https; on provider error the row
  keeps the data URL — zero-breakage fallback). `offloadDataUrl()` is the
  integration point for the remaining binary surfaces (employee documents,
  CMS media) — same contract, config-gated.
- Owner console: Settings → **Storage** tab — both provider cards, ACTIVATE
  one provider, DEACTIVATE, live probe test (store → signed URL → delete,
  timed + audited), object stats by kind.

## Phase 5 — Managed PostgreSQL evaluation (master prompt §5)

`docs/managed-postgres-evaluation.md` — full workload-profile comparison of
Supabase vs Neon (cold-start vs always-on for the 24×7 ADMS device lane,
pooling, PITR, BD→Singapore latency class, cost curves, Neon branching for
CI), a recommendation (stay self-managed through beta → Supabase Pro SG on
the first ops scare → Neon branches for CI), and the connection-string /
pool tuning (`?pgbouncer=true&connection_limit=10`, direct URL for
`migrate deploy`, sslmode, statement_timeout) that applies to all paths.
The platform is provider-independent by construction (binary payloads now
leave the DB via §4; the migration chain is vanilla DDL).

## Phase 6 — SMS gateway + OTP (master prompt §6)

- **Both send planes now funnel through the journaled pipeline**
  (`sendSmsJournaled`): platform (`sendPlatformSms` — expiry notices, tests)
  and tenant (`gateway.sendSms` with the new `tenantSmsProviderId` alias map
  so settings that say "SSL Wireless" route to the structured adapter while
  every legacy label keeps the generic-URL behavior; SSLWireless tenants no
  longer need a URL template — the adapter owns the base URL).
- **Gateway settings gained `smsProvider`** (none | sslwireless |
  generichttp) end-to-end: type, whitelist writer, zod schema, console
  select (label swaps to api_token/sid wording for SSLWireless).
- **New OTP service** (`saas/otp.ts`): CSPRNG 6-digit codes with rejection
  sampling (uniformity test-guarded), stored ONLY as sha256(code+salt),
  5-minute TTL, 5-attempt cap with constant-time compare, single-use
  conditional consumption (concurrent verifies can't both win), issue rate
  limits (3/10min per number, 20/10min per IP), prior live codes voided per
  (identifier, purpose), OTP sends NEVER retried by the pipeline, 24h-row
  hygiene sweeper in daily jobs.
- Owner console: **Send test OTP** + SMS journal strip (24h sent/failed/
  skipped + active providers) in the Gateway tab; `owner.sms.journal`
  drill-down action (masked — OTP rows never stored a body).

## Phases 7–10 — console, security, schema, validation

- Console: everything above plus the billing analytics label map now knows
  PAYSTATION/EPS.
- Security invariants held (the 12 non-negotiables): additive-only migration,
  no Prisma enums, tenant ownership on tenant-plane rows (vendorId on
  StorageObject/SaasSmsMessage/SaasOtpCode), unique idempotency keys
  (enterTokenHash/sessionTokenHash unique; objectKey unique), tokens hashed
  at rest, secrets encrypted under dedicated contexts and never returned
  decrypted, provider params never trusted (server-to-server verification
  everywhere), plain-HTTP legacy gateways rejected, SSRF guards preserved
  inside the generic adapter.
- Schema: migration `9_wave9zp_infra_support_payments_storage_sms_20261024`
  (pre-existing from the frozen session) now fully backed by schema.prisma
  with a verified zero-drift DDL diff; the drift gate (`check-schema-drift`)
  and fresh-DB smoke keep guarding it in CI.
- Tests: `tests/unit/wave10-infra.test.ts` (DB-lane, mirrors the standalone
  runner) + `scripts/verify-wave10.ts` (no-DB gate, 120 assertions) —
  policy matrix, EPS x-hash vector, PayStation status mapping, registry
  completeness, SigV4 reference-agreement matrix, key contract, Cloudinary
  signatures, OTP generator uniformity, provider-label routing.

## Files touched (this round)

**New:** `saas/payments/paystation.ts`, `saas/payments/eps.ts`,
`saas/storage.ts`, `saas/otp.ts`, `src/saas/owner/integrations-panel.tsx`,
`src/hrm/support-banner.tsx`, `app/owner/(console)/support/page.tsx`,
`tests/unit/wave10-infra.test.ts`, `scripts/verify-wave10.ts`,
`docs/managed-postgres-evaluation.md`.

**Modified:** `prisma/schema.prisma` (4 models + 1 index),
`saas/payments/{registry,credentials,settle}.ts`,
`app/api/payments/ipn/route.ts`, `hrm-server/types.ts`, `hrm-server/routes/auth.ts`,
`app/api/hrm/route.ts` (support fallback + policy gate + exit hook),
`app/api/owner/route.ts`, `saas/constants.ts`, `saas/owner-roles.ts`,
`hrm-server/jobs.ts`, `hrm-server/gateway.ts`, `hrm-server/delivery.ts`,
`saas/notify.ts`, `saas/owner-routes.ts`, `hrm-server/routes/employees.ts`
(avatar offload), `app/owner/(console)/settings/page.tsx`,
`saas/owner/shell.tsx`, `app/owner/(console)/billing/page.tsx`,
`src/hrm/store.ts`, `src/hrm/app-shell.tsx`.

## Hot-apply notes

1. Replace the changed source files; `bun install` (no new dependencies —
   SigV4 + HMAC are node:crypto).
2. `DATABASE_URL=… bun run db:deploy` — one additive migration
   (`9_wave9zp`), safe on live data, no backfills beyond its own.
3. `bun run typecheck` (EXIT 0) + `bun run scripts/verify-wave10.ts` (120/120)
   + the full CI when convenient (the new test file rides the existing lane).
4. Optional feature activation — everything is config-gated and OFF until
   the owner turns it on: Owner Console → Settings → **Payments**
   (per-gateway credentials), **Storage** (R2/Cloudinary + Activate + Run
   test), **Gateway** (SMS provider select + OTP test), and the **Support
   Access** page (policy, then first session). `HRM_MFA_KEY` must be set
   before storing any gateway/storage credential.
