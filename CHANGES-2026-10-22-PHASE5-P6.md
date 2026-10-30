# Phase 5 — P6 PII, Pagination & Push (2026-10-22): the three future-work items

The sixth slice of the post-capstone program, delivered as **P6** on top of
the P5 baseline (Phase 4 remediation + P0 observability + P1 lifecycle/quotas
+ P2 revenue + P3 growth + P4 security + P5 tenants/subscriptions). This
phase implements the three items the tracker explicitly parked as
**future work**: at-rest PII encryption (F28), server-side pagination for the
full-list tenant UIs (the M-11 note), and the mobile push channel
(punches/approvals). **One additive migration** (the `PushSubscription`
table); no changes to existing tables, no new dependencies, no env changes
required (two OPTIONAL per-context key overrides are documented).

---

## WS-A — At-rest PII encryption (audit F28)

**The gap (F28):** `BankAccount.accountNumber` / `mfsNumber` and
`EmployeeDocument.docNumber` / `fileData` were stored in PLAINTEXT — masking
was API-layer only, so a database dump alone exposed every bank account,
NID/passport number and document FILE. The AES-256-GCM + HKDF-SHA256 scheme
that already protected MFA secrets, camera credentials, device comm keys,
webhook secrets, AI keys, comms secrets and payment credentials now covers
employee PII under its own context.

### The envelope (src/hrm-server/pii-field.ts — NEW)

- Context `pii::v1`, SEC-13 per-context override **`HRM_PII_KEY`** (falls
  back to `HRM_MFA_KEY` — existing single-key deployments behave identically).
- **`enc::<ivHex>.<tagHex>.<encHex>`** — small text (account/MFS/document
  numbers). Same envelope shape as the M-20 comm-key format.
- **`encf::<ivB64>.<tagB64>.<dataB64>`** — file payloads (base64 document
  bytes). Base64 transport so a 2 MB document stores as ≈ 2.7 MB instead of
  ≈ 5.3 MB under hex; same key derivation, same AES-256-GCM.
- **Read policy (the comm-key discipline):** legacy plaintext rows pass
  through every read path until rotated (upgrade-safe); `readPiiText` → null
  on an undecryptable value (display paths degrade to "—"); the STRICT
  variants (`readPiiTextStrict` / `readPiiFileStrict`) THROW with an
  operator-actionable message — a salary export must never silently emit a
  missing account number, a document download must never serve garbage bytes.
- **Write policy — fail-closed** when no deployment key is configured and a
  value is being written (same as MFA enrollment, setCommKey, comms secrets).
  `piiTextForStorage` passes ALREADY-ENCRYPTED kept values through untouched,
  so the payout merge path (which keeps stored ciphertexts when the client
  sends blanks) can never double-encrypt.

### The boundaries

- **`employees.banks.*`** — create/update encrypt `accountNumber`/`mfsNumber`
  at the storage boundary; list/create/update answers the C-05 mask
  (`•••• 1234`) with the REAL last-4 (decrypt-then-mask — the mask always
  shows the true digits, for encrypted AND legacy rows).
- **`employees.docs.*`** — `docNumber` encrypted; `fileData` encrypted
  (`encf::`); `docs.download` / `docs.view` decrypt at the egress boundary
  (STRICT); the create/update responses no longer echo file bytes.
- **`employees.get`** — maskedBanks and the identity-number projection
  (FLD-102/103 full/mask/none tiers) decrypt BEFORE projecting; the
  docs-with-file existence probe is untouched.
- **`employees.create` / `employees.update`** — the identity-document write
  paths (NID/passport/birth-reg numbers) encrypt at the storage boundary;
  an unrelated edit never re-encrypts or corrupts the kept number.
- **`payout.ts`** — `resolveSalaryPayout` / `resolveSalaryPayouts` (the §78
  preflight, salary export, payslip) decrypt STRICTLY;
  `applyPayoutSelection` encrypts at the final write with no
  double-encryption of kept values.
- **`ess.profile`** — the employee's OWN bank rows decrypt (self-scope).
- **`seed.ts`** — demo PII encrypts at seed time when a key is configured.
- **Storage quota honesty** — `requireCapacity` still gates on the incoming
  payload, but the `bumpStorageRollup` delta and the docs.delete rollback
  now count the STORED (encrypted) length, so the quota tracks actual
  database bytes; the nightly `reconcileStorageRollups` pass (which reads
  `LENGTH(fileData)`) converges on the same truth.
- **Audit safety unchanged** — `auditDiff`/`auditPIIScrub` redact the PII
  keys BY NAME regardless of value format (ciphertext never enters an audit
  row; the fact that a value changed is still auditable).
- **Rotation** — `scripts/encrypt-secrets-at-rest.ts` gains the F28 section:
  bank/MFS numbers, document numbers and document FILES are re-wrapped in
  one pass (dry-run default, `--apply` gated, `--allow-production` on prod,
  idempotent by prefix, storage rollup corrected per wrapped file).

## WS-B — Server-side pagination for full-list tenant UIs (the M-11 note)

**The gap:** the photo-column memory killer was fixed long ago, but six list
actions still shipped WHOLE tables to the browser and decorated them with
the FULL tenant directory: `loans.list` (plus one installments query PER
LOAN — N+1), `advances.list`, `expenses.list`, `resignations.list` (all
clearances + all settlements + all outstanding assets), `leaveBalances.list`
(employees × types for the year) and `payroll.entries` (every entry of a
10K-employee run, with `employees.find()` THREE TIMES PER ROW for
branch/department/designation names).

### The contract (the MOD-16 shape, now uniform)

- **Legacy callers keep the exact full-array contract** (no page/pageSize →
  bare array, `{ run, entries }` for payroll.entries).
- **Paged callers** (`page`/`pageSize` present, clamped 1..500) get
  `{ items, total, page, pageSize, summary }` — plus `run`/`entries` kept in
  sync on payroll.entries for compatibility.
- **`q` search** — employee name/code matched IN SQL (the SCL-10 discipline:
  the employee set is resolved once, then INTERSECTED with the caller's
  branch/department scope), so search finds rows beyond the loaded page.
- **Page-scoped decoration** — names resolve from the PAGE's ids via ONE
  `whereIn` + Map lookups; installments batched per page; exit
  clearances/settlements/assets scoped to the page's resignation/employee
  ids; the payroll per-row triple-`.find()` scans are gone.
- **`summary` — the KPI strip's cohort truth** (the P5 renewals discipline):
  set-based groupBy/aggregate over the caller's SCOPE (independent of table
  filters and pagination):
  - loans: status mix + ACTIVE outstanding sum
  - advances: status mix + RECOVERING outstanding sum
  - expenses: status mix + this-month reimbursed (approvedAmount) + total claimed
  - resignations: notice/completed counts + pending settlements (DRAFT/CALCULATED/APPROVED attached to a scoped resignation)
  - payroll.entries: run-scoped loan/advance/guarantor recovery sums + the PF employee share (from the breakdown JSON, one bounded pass)
- **applyEmployeeSearch helper** (rbac.ts) — the shared q∩scope intersection
  (`{ in: [...] }` ∩ matched set; single id kept only when it matches; the
  `__none__` sentinel when nothing can match).

### The UI

- NEW **`src/hrm/server-paged.tsx`** — `useServerPagedList` (drives any
  MOD-16 action: page state, filter changes rewind to page 1, envelope
  tolerance for legacy answers, `envelope` exposure for `summary`) +
  `PagedControls` (the P5-style Previous/page x of y/Next strip with an
  honest "N–M of T" counter).
- **Loans** (both tabs), **Expenses**, **Exit**, **Leave → Balances**,
  **Payroll → Run Detail** — all six surfaces now ride server-side
  pagination + SQL search (`DataTable onSearch`), with their KPI cards
  reading the set-based `summary` (page-scoped fallbacks keep the cards
  honest if the envelope is absent).
- **Employee quick-actions sheet** — the leave/loans/advances panels ride
  the `employeeId` filter server-side (the old load-all-then-filter-client
  pattern hauled every employee's rows to show ONE employee's).

## WS-C — Mobile push notifications (punches & approvals)

**The gap:** v1.1 delivered tokens, delta sync, ETag and OpenAPI 3.1 — but
no push channel: a punch or an approval decision was invisible until the
user opened the app.

### The transport (in-house, ZERO new dependencies)

- **`src/hrm-server/push/web-push.ts`** — RFC 8291 (aes128gcm content
  coding: ECDH P-256 + the "WebPush: info" context binding BOTH public keys,
  HKDF-derived CEK/nonce, `salt‖rs=4096‖idlen=65‖ephemeral‖ct` body) and
  RFC 8292 (VAPID ES256 JWT, `Authorization: vapid t=…, k=…`, JWS raw r||s
  via Node's `dsaEncoding: "ieee-p1363"`). The test suite implements the
  RFC 8291 RECEIVER side (ECDH with the subscription's own private key) and
  decrypts what actually goes over the wire — spec-exact, not
  self-consistent; the VAPID JWT is verified with Node's own verifier.
- **`sendWebPush`** never throws: network/protocol failures return
  `{ ok, status, gone }`; **404/410 = gone** (the subscription is deleted);
  5s timeout per send.

### The service (src/hrm-server/push/push-service.ts — NEW)

- **VAPID keys per vendor** in `HrSetting` group `push`: `publicKey` plain
  (every client needs it to subscribe), `privateKey` **encrypted at rest**
  under `push::v1` (SEC-13 override **`HRM_PUSH_KEY`**, fail-closed without
  a deployment key — no keypair is minted that cannot be stored securely).
  Lazy generation on first subscribe; stable across calls.
- **Dispatch rail hooked into `notify()`/`notifyMany()`** — every in-app
  notification ALSO pushes to the target user's devices: Approval Needed /
  Request Approved / Rejected / Approval Progress (the whole approval
  engine), substitute assignments, task assignments, letters, bonus
  approvals, HR broadcasts — all ride the same rail with ZERO call-site
  changes. Fire-and-forget with an in-process tracking set + a 100-in-flight
  backpressure cap; a push failure NEVER fails the business action that
  triggered it; gone subscriptions self-delete; transient failures record
  `lastError` on the row and heal on the next success.
- **Punch confirmations** — `attendance.geofence.checkin`,
  `attendance.geofence.checkout`, `attendance.selfie.checkin` and
  `attendance.selfCheckout` now notify the puncher ("Punch recorded —
  Geo-fence check-in at 09:02 — HQ. Day status: Present."), which lands
  in-app AND on-device through the same rail.
- **The `PushSubscription` table** (additive migration
  `9_wave9zj_push_subscriptions_20261022`) — one row per browser/device
  (endpoint globally unique; re-subscribe upserts), owned by
  (vendorId, userId); indexes for the dispatch walk.

### The surfaces

- **RPC** (`src/hrm-server/routes/push.ts`, all INTENTIONALLY_SELF_SCOPED —
  ownership enforced in every where-clause): `push.publicKey` (lazy
  keypair, returns the public key + enabled flag), `push.subscribe`,
  `push.list`, `push.unsubscribe` (another user's id is a silent no-op),
  `push.test` (audited). Registered in the master router; `push.*` added to
  the read-only-lockout exempt prefixes (personal devices are not tenant
  data).
- **v1 REST** — `GET/POST /api/v1/push/subscriptions` +
  `DELETE /api/v1/push/subscriptions/{id}` under the new **`push:write`**
  scope (SCOPE_CATALOG + OpenAPI 3.1 contract + the generated TypeScript
  client, which now also supports DELETE endpoints). The subscription's raw
  keys NEVER come back on reads; a user only ever sees their own devices.
- **Service worker** (`public/sw.js`, CACHE `finix-ess-v3`) — `push` event
  handler (JSON payload `{ title, body, url, tag }`, deduplicating tag,
  device icon/badge) + `notificationclick` (focus an open app window and
  deep-link it via the payload's `url`, open one only when none exists).
- **UI** — the Notification Center gains a **Push notifications card**:
  enable-on-this-device (permission → `pushManager.subscribe` with the VAPID
  key → `push.subscribe`), a per-device list with last-success/error state,
  a Send-test-push button and per-device removal; honest states for
  permission-blocked and deployment-not-configured.

---

## Compatibility & deployment

- **One additive migration** — `9_wave9zj_push_subscriptions_20261022`
  (CREATE TABLE + indexes only; fresh-database smoke green, zero drift).
  Existing deployments run `prisma migrate deploy` (or `db:push`).
- **Legacy rows stay readable everywhere** — pre-P6 plaintext PII passes
  through every read path until the one-shot rotation script re-wraps it;
  legacy list callers keep the full-array contract.
- **No new dependencies; no required env changes.** OPTIONAL:
  `HRM_PII_KEY` / `HRM_PUSH_KEY` (SEC-13 per-context overrides, documented
  in `.env.example`). Without them everything keys off `HRM_MFA_KEY`
  exactly as before.
- **PII writes are fail-closed** — a deployment WITHOUT a key cannot store
  NEW bank account numbers / document numbers / document files (the same
  rule as MFA enrollment and comm keys). Set `HRM_MFA_KEY` (or
  `HRM_PII_KEY`) — see the error message, which says exactly that.
- **Hot-apply:** overlay extract + `prisma migrate deploy` + restart, or
  apply the changed files listed below.

## Files changed

- NEW `src/hrm-server/pii-field.ts` · NEW `src/hrm-server/push/web-push.ts` ·
  NEW `src/hrm-server/push/push-service.ts` · NEW `src/hrm-server/routes/push.ts` ·
  NEW `src/hrm/server-paged.tsx` · NEW `src/app/api/v1/push/subscriptions/route.ts` ·
  NEW `src/app/api/v1/push/subscriptions/[id]/route.ts` ·
  NEW `prisma/migrations/9_wave9zj_push_subscriptions_20261022/`
- MOD `src/hrm-server/crypto-field.ts` (pii::v1 + push::v1 contexts) ·
  `src/hrm-server/routes/employees.ts` · `src/hrm-server/routes/ess.ts` ·
  `src/hrm-server/routes/finance.ts` · `src/hrm-server/routes/exit.ts` ·
  `src/hrm-server/routes/leave.ts` · `src/hrm-server/routes/payroll.ts` ·
  `src/hrm-server/routes/attendance.ts` · `src/hrm-server/routes/router.ts` ·
  `src/hrm-server/payout.ts` · `src/hrm-server/audit.ts` (notify push rail) ·
  `src/hrm-server/rbac.ts` (applyEmployeeSearch) · `src/hrm-server/seed.ts` ·
  `src/app/api/hrm/route.ts` (readonly-exempt prefix) ·
  `src/app/api/v1/_tokens.ts` (push:write) ·
  `src/api-contract/openapi-v1.ts` + regenerated `src/api-client/index.ts` ·
  `scripts/encrypt-secrets-at-rest.ts` (F28 section) ·
  `scripts/gen-api-client.ts` (DELETE support) · `public/sw.js` (v3) ·
  `prisma/schema.prisma` (PushSubscription) · `.env.example`
- UI MOD: `src/hrm/views/loans.tsx` · `expenses.tsx` · `exit.tsx` ·
  `leave.tsx` (Balances) · `payroll.tsx` (Run Detail) ·
  `employee-quick-actions-sheet.tsx` · `notifications.tsx` (push card)
- Tests: `tests/unit/phase5-p6-pii-encryption.test.ts` (18) ·
  `tests/unit/phase5-p6-list-pagination.test.ts` (8) ·
  `tests/unit/phase5-p6-web-push.test.ts` (17) — plus 5 pre-existing suites
  updated for the at-rest-encryption truth (raw rows assert the enc::
  marker + decrypt through the production read path; the MOD-5 rollup test
  counts stored bytes).

## Gate

`DATABASE_URL=… bun run scripts/ci.sh` → **ALL 13 STAGES GREEN,
1472/1472 unit tests (1429 + 43 new)**, tsc clean, lint clean (0 errors),
fresh-database migration smoke green, zero schema drift, perf budgets green
(auth.me p95 within budget). Production build compiles (32/32 pages).

**Re-gate after hot-apply:** `bun run ci` needs `DATABASE_URL` exported.
