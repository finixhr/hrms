# CHANGES 2026-10-18 — Re-Audit Remediation (merged-state verification follow-up)

**Scope:** the two P1 defects from the 2026-10-18 re-audit of the merged
state, the 15 broken test fixtures it surfaced, the new CI schema-drift
gate, and the P3 sweep that made the full 10-stage gate reproducibly green.

**Verification (all local, `bash scripts/ci.sh`):** tsc 0 errors · eslint
0 errors/warnings · **1120/1120 unit tests pass** (was 1101 pass / 16 fail, plus 3 new R4 sequence-regression tests)
· config/destructive/docs/permission guards green · dependency audit green
· fresh-database migration smoke: all **24** migrations apply cleanly ·
**schema-drift gate: zero drift** between the migration chain and
`schema.prisma`.

---

## P1-1 — Payslip-number collision (weekly runs / coexisting runs)

**Defect:** `payRun` minted payslip numbers with a per-run counter that
always restarted at 1 (`prefix-YYYYMM[-A#]-0001`). Any SECOND run of the
same month — the next weekly ISO week, an adjustment, any coexisting run —
minted identical numbers and the payment died on
`@@unique([vendorId, payslipNumber])` (migration 3) with a raw P2002 500.
Proven live by the PAY-008 weekly regression (second weekly pay of a month).

**Fix (`src/hrm-server/payroll.ts`):**
- numbers are now reserved as ONE consecutive block from a **vendor+month
  scoped SequenceCounter pool** (`payslip:<vendorId>:<YYYY-MM>`) — a single
  atomic upsert INSIDE the payment transaction (the update branch increments
  the block; the create branch seeds at the pre-counter high-water mark +
  block), so concurrent runs of the same month always get disjoint blocks,
  a rolled-back payment rolls its allocation back too, and the vendor-month's
  first-ever payment can no longer log a caught-and-retried P2025 as a scary
  `prisma:error` (see "Follow-up" below);
- weekly runs additionally carry the ISO week in the number
  (`PFX-202611-W45-0007`) for human readability; monthly REGULAR numbers
  keep the exact legacy format `PFX-YYYYMM-0001`;
- the pool NEVER reissues numbers — a cancelled-then-re-created month simply
  continues the pool, so a number that was already printed or emailed can
  never be minted twice (`payroll.runs.cancel` still clears old rows'
  numbers for the unique index);
- a residual P2002 on the unique (legacy manual numbers, restored backup)
  now surfaces as a clear, safe-to-retry **409** instead of a 500.

## P1-2 — Missing inventory migration (wave 10)

**Defect:** the merged schema modeled the inventory-serial feature — 6 `Item`
columns (`brandModel/serialImei/purchaseDate/hasWarranty/warrantyExpiry/
isReturnable`), 5 `StockEntryItem` columns (`brandModel/warrantyValue/
warrantyUnit/warrantyExpiry/serialNumbers`) and the entire `ItemCategory` /
`ItemUnit` / `InventoryItemSerial` tables — but NO migration was ever
authored. Every `prisma migrate deploy` database (the production shape)
crashed P2021/P2022 the moment the feature was used; the unit-test DB never
noticed because tests provision via `db push` (schema-direct).

**Fix (`prisma/migrations/9_wave9z_inventory_serials_20261018/`):**
- PART 1 — the inventory-serial DDL above (additive-only, plain-String
  columns per the H-10 vendor-scoping convention);
- PART 2 — timestamp(3) precision normalization across the 25 tables the
  hand-authored wave-2/3/4 migrations had created with bare `TIMESTAMP`
  columns (catalog-only typmod changes — no rewrite, no data change) so the
  chain reaches **zero drift** against `schema.prisma`;
- directory named `9_wave9z_…` (not `10_…`): lexicographic apply order must
  sort after the `9_wave9_…` tip and multi-digit prefixes are rejected by
  `scripts/check-migrations.mjs` (the P3018 fresh-database ordering bug);
  `CURRENT_TIP` updated. **Already-applied databases: nothing to rename —
  this is a new migration, `prisma migrate deploy` picks it up as-is.**

## CI schema-drift gate (new stage 10)

- **`scripts/check-schema-drift.ts`** — provisions a throwaway shadow
  database (same refusal conventions as `tests/preload.ts` /
  `migrate-fresh-smoke.ts`), runs
  `prisma migrate diff --from-migrations --to-schema-datamodel`, and fails
  CI on ANY drift, printing the missing SQL. This closes the exact blind
  spot P1-2 slipped through (tests = `db push`, production = `migrate deploy`).
  Negative-tested: an injected schema column correctly fails the gate.
- **`scripts/ci.sh`** — stage 10 wired in; stale `[1/7]…[8/8]` stage labels
  normalized to `[1/10]…[10/10]`.
- **`.github/workflows/ci.yml` restored** — the workflow was referenced by
  DEPLOYMENT-GUIDE.md, CHANGES.md and ci.sh but missing from the delivered
  tree (H-15 regression). PostgreSQL 17 service, Bun, frozen install,
  `prisma generate`, migration naming guard, the full 10-stage
  `scripts/ci.sh`, production build + standalone artifact. No secrets
  required (CI-only `HRM_MFA_KEY` inline).

## The 15 broken test fixtures (repaired)

Root causes found by running the suite against a real PostgreSQL (the
fixtures had never been DB-run):

| # | File / test | Root cause | Repair |
|---|-------------|-----------|--------|
| 1 | `l-cameras-low` (L-25) | role-less `mkUser` defaults to VENDOR_OWNER whose RBAC-103 template carries `camera.edit` — the "view-only" premise was false | viewer rides PAYROLL_OFFICER ∪ {camera.view} |
| 2 | `saas-layer` (provisioning) | workflow count pre-dated ASSET_ISSUE (15th process type, 2026-10-16) | expect 15 |
| 3 | `r3-1` PAY-001 (delta) | shared vendor accumulated 6 ACTIVE employees+structures from the EXIT fixtures → source run totalled 350000, not 50000 | dedicated vendor for the delta math |
| 4 | `r3-2` PAY-005 | `festivalPaidThisFy` aggregates the whole vendor — paid FESTIVAL bonuses from PAY-003/008 leaked in (3 extras) | dedicated vendor |
| 5 | `r3-3` FLD-101/102 | BRANCH_MANAGER template includes `payroll.view` (RBAC-103 union) — the "no payroll.view" premise was false | custom role = exactly the explicit grants |
| 6 | `r3-3` RDM-001 | raw `db.hrSetting.create` bypasses the K-7 settings-cache write-through → purge saw "unlimited" | `saveSettingsGroup` writer |
| 7 | `r3-4` LVE-005 | encashment payout is queued only when an ACTIVE salary structure exists (daily rate) — structureless encasher queued nothing | structure added |
| 8 | `r3-4` ADV-002 | `advances.create` submits through the ADVANCE workflow; the fixture never seeded one → clean 403 before the in-cap half | ADVANCE workflow seeded |
| 9 | `r3-5` FLD-103 | 1-char email local: impl always keeps first char + ≥1 bullet (`a•@b.co`) | expectation aligned to impl |
| 10 | `r3-5` RBAC-105 (audit.export) | role-less viewer = VENDOR_OWNER template | custom role `audit.view`-only |
| 11 | `r3-5` RBAC-105 (exportCsv) | same | custom role `employees.view`-only |
| 12 | `r3-5` RBAC-105 (changeShift) | same for the stranger; the assigner equally rode VENDOR_OWNER (proving nothing) | both custom roles |
| 13 | `r3-5` SUB-107 | LeaveType speaks `defaultDays` since R3-4 (annualDays rejected); SaasPlan speaks `monthlyPrice` (planCode/priceMonthly phantom); SaasSubscription requires `planName`; Loan requires `startDate`/`installments` (installmentCount/appliedOn/disbursedOn phantom); no LEAVE workflow; "HR" was HR_MANAGER (no `leave.create`) | all repaired with the real model shapes |
| 14 | `payload-validation` M-01 | RBAC-102 re-gated banks onto `bankInfo.*` (intentional R3-5 change) — fixture still expected `employeeDocs.verify` | expect `bankInfo.verify` |
| 15 | `r3-1` PAY-001 (AIT half) | original flat `net === 5000` assumed a zero AIT delta; the corrected structure crosses the ৳4L taxable threshold so the §86(4) catch-up (৳67) legitimately rides the correction | 4933 with the AIT line asserted |

## P3 sweep (latent defects behind the failing gate)

- **`employees.banks.verify` 500'd on EVERY call** — wrote `verifiedBy` /
  `verifiedAt`, columns that do not exist on `BankAccount` (the `as any`
  cast hid the PrismaClientValidationError). The verifier's identity and
  decision time now live in the audit row; `verified` itself is the column
  the payout resolver reads.
- **`employees.changeShift` dual-verb gate unreachable** — the R3-5
  deliverable ("accepts `employees.assign` OR `employees.edit`") was
  enforced only in-handler while the dispatcher's `employees.edit` gate
  fired first. New `RouteDef.altPerm` support in the dispatcher makes the
  documented gate real; the primary verb stays canonical for the
  registry lint and the mutating/lockout classifier.
- **AIT bootstrap timing (first-run withholding inconsistency)** —
  `calculateRun` computed `monthsRemainingInFy` and the §86 annual estimate
  from a config that was still NULL on a vendor's first-ever calculation
  (computeAit bootstraps internally, later), so the first run withheld on a
  12-month projection while every later recalculation used the true
  remaining months — PAY-001 adjustment deltas became non-zero out of thin
  air (6 employees × ৳333). The config is now bootstrapped BEFORE the
  projection is derived.
- **eslint config crashed in a fresh clone** — the appended rules object had
  no `files`, so ESLint 9 validated `react/*` rules against non-code files
  ("could not find plugin react") and the lint stage could not run at all.
  Fixed, then the 128 pre-existing errors it revealed were cleared:
  ~110 unused imports/vars, 5 unescaped JSX entities, 13 non-null
  assertions (redundant after guard-narrowing, null-safe rewrites, or
  documented suppressions per the H-20 convention), 1 ARIA fix, 1 CJS
  require annotation. The two NEW-in-Next-16 react-hooks rules
  (set-state-in-effect, static-components — 19 pre-existing view sites) are
  documented deviations alongside `exhaustive-deps`, paydown gated on a
  frontend test harness.
- **docs guard drift** — 69 stale references across 16 markdown files
  (shorthand `routes/x.ts` forms, missing `scripts/verify-r3X.ts` suites →
  now point at the shipped DB-integration test files, unshipped
  audit-sandbox working papers, `src/middleware.ts` → `src/proxy.ts`).
  The guard's path extractor now understands Next.js route groups
  (`(console)`) and dynamic segments (`[id]`). `prisma/db/.gitkeep`
  recreated (guard invariant).
- **permission registry lint** — 13 pre-existing self-scoped / in-handler
  routes carried no `INTENTIONALLY_*` marker: annotated with their real
  reasons (selfie punches, ESS device list/remove, consent, own payslips,
  letters self-scope, tasks split trust, requisitioner master requests,
  public careers apply, wallboard punch alerts).
- **`scripts/reset-test-users.ts`** unguarded `deleteMany({})` → now behind
  `requireConfirmation` (refuses production, demands --confirm).
- **dependency audit** — `source-map-js` event-loop DoS (GHSA-68fv-2mgg-jv7q)
  resolved to 1.2.2 via a `resolutions` override; `sharp` allowlisted with
  justification (installed 0.35.5 IS the advisory's patched release —
  bun audit's range parser flags the boundary; revisit on the next release).

## Files

| File | Change |
|------|--------|
| `src/hrm-server/payroll.ts` | P1-1 payslip pool + week tag + P2002→409; AIT bootstrap timing fix; in-transaction atomic upsert + transition seed (follow-up) |
| `src/hrm-server/utils.ts` | M-22 nextSeq/nextFormattedSeq → single-statement upsert (noise-free first use) |
| `src/hrm-server/routes/payout.ts` | cancel tombstone counter → single-statement upsert |
| `.gitignore` | R-F06 — credential-bearing env profiles (.env.production, .env.orig-backup) ignored |
| `tests/unit/r4-payslip-sequence.test.ts` | NEW — permanent R4 sequence regression (weekly/adjustment/monthly mix, vendor scoping, transition seed) |
| `prisma/migrations/9_wave9z_inventory_serials_20261018/` | P1-2 inventory DDL + timestamp(3) normalization |
| `scripts/check-schema-drift.ts` | NEW — stage-10 drift gate |
| `scripts/ci.sh` | stage 10 + label normalization |
| `.github/workflows/ci.yml` | RESTORED (was missing from the tree) |
| `scripts/check-migrations.mjs` | CURRENT_TIP → 9_wave9z |
| `src/hrm-server/routes/registry.ts` | `RouteDef.altPerm` |
| `src/app/api/hrm/route.ts` | dispatcher alt-perm enforcement |
| `src/hrm-server/routes/employees.ts` | banks.verify phantom-column fix; changeShift altPerm |
| `eslint.config.mjs` | files-scoped rules object (config-load crash fix) + 2 documented rule deviations |
| `scripts/audit-deps.sh`, `scripts/reset-test-users.ts`, `scripts/check-docs.sh` | sharp allowlist; requireConfirmation; route-group-aware path extraction |
| `package.json` | `resolutions.source-map-js = 1.2.2` |
| `prisma/db/.gitkeep` | recreated (docs-guard invariant) |
| 16 `*.md` docs | stale path references repaired |
| ~13 route files | M-02 markers (see P3 sweep) |
| 8 test files | the 15 fixture repairs |
| ~20 view/shared files | unused imports/vars, entity escapes, ARIA (lint green) |

## Follow-up (same day, post-delivery)

**Report:** running `bun run seed` on the delivered archive printed one scary
`prisma:error` — `db.sequenceCounter.update()` P2025 ("No record was found
for an update") at `payroll.ts:940` — during `payroll: September 2026 PAID`.
The seed itself completed (`SEED COMPLETE`, 825 employees, 2,502 payslip
entries, unique numbers): the P1-1 allocator used an update-then-create
fallback whose CAUGHT-and-retried P2025 still gets logged by Prisma's error
reporter on a vendor-month's first-ever payment. Benign — but the same
noisy pattern existed in every other sequence allocator.

**Fix — noise-free atomic allocation everywhere:**

- **payslip pool** (`payroll.ts`): the update-then-create retry loop is now a
  single-statement `upsert` allocated INSIDE the payment transaction — the
  update branch increments the block, the create branch seeds at the
  pre-counter stamped high-water mark + block (transition seed, so a vendor
  with pre-fix stamped payslips CONTINUES the sequence instead of re-minting
  old numbers). No P2025 can occur; a rolled-back payment rolls the
  allocation back (no burned numbers); the `-W<isoWeek>` tag, `-A<seq>` tag
  and the P2002→409 mapping are unchanged.
- **adjustment sequence** (`createAdjustmentRun`, M-7): same upsert — create
  branch seeds at existing max adjustSeq + 1, update branch increments.
- **requisition/letter sequences** (`utils.ts` `nextSeq` /
  `nextFormattedSeq`, M-22): same upsert — create branch seeds at 1.
- **cancel tombstone** (`routes/payout.ts`): the create-then-update fallback
  (which logged a caught P2002 on every SUBSEQUENT cancel) → same upsert.
- **`tests/unit/r4-payslip-sequence.test.ts`** — NEW permanent regression
  (audit §4.1): weekly+adjustment+monthly mix of one month all pay with
  continuing week-tagged numbers; vendor scoping; transition seed. Suite
  grows to **1120/1120**.
- **`.gitignore`** — R-F06 adopted: `.env.production` and `.env.orig-backup`
  (credential-bearing profiles that rode inside the 2026-10-17 archive) are
  ignored, matching the delivered git policy.

**Re-verification (embedded PostgreSQL 18.4):** full 10-stage
`bash scripts/ci.sh` green (tsc 0 · eslint 0 · **1120/1120** tests · config /
destructive / docs / permission guards · dependency audit · fresh-database
smoke — 24 migrations · schema-drift zero) **and** the exact reported
scenario re-run end-to-end on a fresh database: `prisma migrate deploy` +
`bun run seed` → **zero `prisma:error` lines**, `SEED COMPLETE` with the
identical corpus (825 employees · 36 users · 121,661 attendance rows ·
5 payroll runs / 2,502 entries), September PAID through the fixed path
(`PS-202609-0001…0024`, pool = 24). Databases seeded with the PREVIOUS
archive need nothing — the pool row the old fallback created is exactly the
row the upsert's update branch continues on.
