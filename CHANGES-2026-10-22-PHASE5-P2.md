# Phase 5 — P2 Revenue & Collections (2026-10-22): money KPIs, aging, payment stream, dunning workbench

The Revenue & Collections slice of the SaaS Owner Panel roadmap, delivered as P2
on top of the P1 baseline (Phase 4 remediation + P0 observability + P1
lifecycle & quotas). The billing console was the last old-generation surface in
the panel — a flat invoice table whose "mark paid" flow ran through
`window.prompt`. P2 rebuilds it to the P0/P1 console standard. **No schema
migrations, no new dependencies, no env changes** — everything rides the
existing `SaaSInvoice` / `SaaSPayment` tables, the dunning engine, and the
long-standing `owner.invoices.create` / `owner.invoices.markPaid` mutations
(which stay untouched and compatible — the Analytics page's dunning queue and
the tenant Billing view are unaffected).

## What shipped

### 1. `owner.billing.overview` — money KPIs, aging, trend, mixes

One round trip answering EVERY number with a FIXED set of 9 grouped
aggregates (invoice-count independent — the fleet.ts discipline applied from
birth):

- **Money KPIs** — billed MTD + trailing 30d (FILTER-clause sums over one
  scan), collected MTD + 30d, the 30-day collection rate (null when nothing
  billed — never a fabricated 0%), and avg days-to-pay over settled invoices
  paid in the last 90 days.
- **Outstanding / overdue** — open (PENDING) count + amount and the overdue
  (PENDING past due) count + amount, counts and sums in one scan.
- **Aging strip** — one `CASE`-bucket query over PENDING invoices: not-yet-due
  / 1–15 / 16–30 / 31–60 / 61–90 / 90+ days past due, each with count AND
  amount. Every bucket always present in the response (zero when empty).
- **6-month trend** — billed by issuance month and collected by settlement
  month (`date_trunc('month', …)`, UTC), folded into an always-six-months
  array ending at the current month; zero months stay zero, never fabricated.
- **Method / provider / status mixes** — settled payments by recorded method
  (BANK/CASH/MFS/CARD), by provider (MANUAL vs SSLCOMMERZ/BKASH/NAGAD), and
  invoices by status — each `{key, count, amount}`, amount-sorted.

### 2. `owner.billing.invoices` — the workbench grid

Paged in SQL with the **collection band AND days-overdue computed IN SQL**
(one `CASE` over status + dueAt vs now), so the band chips filter and the
severity-first sort never materialize the invoice table:

- Bands: `OVERDUE_90` / `OVERDUE_61_90` / `OVERDUE_31_60` / `OVERDUE_16_30` /
  `OVERDUE_1_15` / `DUE_SOON` (due ≤ 7d) / `CURRENT` — plus the terminal
  statuses (`PAID` / `FAILED` / `REFUNDED` / `CANCELLED`) as their own bands.
- **Severity-first ordering**: worst overdue first, then due-soon, current,
  settled, closed; within a band, most days overdue first, then newest
  issued. A stable `id` tiebreak keeps pagination deterministic.
- **Chip filters** (All / Overdue / Due ≤ 7d / Current / Settled / Closed)
  map to `band IN (…)` sets evaluated IN SQL; the status select is a plain SQL
  equality; search matches invoice number OR tenant name (JOIN to `Vendor`)
  as SQL WHERE — never JS post-filtering.

### 3. `owner.billing.payments` — the fleet-wide payment stream

The first owner surface reading `SaaSPayment` across tenants: manual and
gateway rows side by side (JOIN invoice for the number + vendor for the
name), paged in SQL, `createdAt DESC`, method + provider filters as SQL
WHERE, and search matching invoice number, tenant name, or either
transaction reference (manual `transactionId` / gateway `providerTxnId`).

### 4. `owner.billing.collections` — the dunning workbench

- Overdue **PENDING** invoices only (future-due and settled never appear),
  worst-first: days-overdue computed IN SQL (`EXTRACT(DAY FROM now() −
  dueAt)`), then oldest-issued.
- **Per-invoice reminder state rides the row**: `remindersSent` /
  `lastReminderAt` from the same `SaaSSetting` group `"dunning"`
  `inv:<invoiceId>` counters the automatic daily pass reads — ONE query
  restricted to the returned page (the dunning.ts counter discipline).
- The cadence constant is imported from the engine itself (`CADENCE_DAYS`,
  newly exported) so the console can never drift from dunning.ts.
- Sending rides the **existing** `owner.dunning.remind` (perm
  `billing.manage`): audited, cadence-bypassing by design, identical
  machinery to the automatic pass. Nothing about the engine changed.

### 5. Rebuilt `/owner/billing` — "Revenue & Collections"

Matching the P0/P1 console design system (gradient-icon page header —
emerald→teal Wallet, dark + light-mode variants everywhere):

- 4 money KPI cards (Billed MTD / Collected MTD / Outstanding / Overdue) with
  honest sub-lines (trailing 30d, collection rate, open-invoice count, avg
  days-to-pay; Overdue goes red only when something is actually past due).
- The 6-tile aging strip, tone-graded amber → red.
- A 6-month billed-vs-collected grouped bar chart (pure CSS bars, per-month
  tooltips) + method-mix and provider-mix bar panels.
- Three tabs — **Invoices** (chips + status select + search + severity-first
  table + pagination), **Payments** (filters + search + newest-first
  stream), **Collections** (policy banner + worst-first workbench + inline
  Remind button with busy state).
- **Record payment is a proper dialog now** — method select, transaction
  reference input, invoice summary card, explicit consequences note —
  replacing the old double `window.prompt`. The New-invoice dialog gained a
  due-date and notes field, amount bounds, and the same visual language.
- Result toasts (success/error) with the console's inline-toast convention;
  60 s auto-refresh of the overview + the active tab; nav label updated to
  "Revenue & Collections".

## Files

- NEW `src/hrm-server/saas/billing-console.ts` (owner.billing.* — 4 actions)
- NEW `tests/unit/phase5-revenue-collections.test.ts` (16 tests)
- REBUILT `src/app/owner/(console)/billing/page.tsx`
- MOD `src/hrm-server/saas/dunning.ts` (export CADENCE_DAYS — behavior
  unchanged)
- MOD `src/app/api/owner/route.ts` (side-effect import)
- MOD `src/saas/owner/shell.tsx` (nav label)

## Tests (16 new)

`tests/unit/phase5-revenue-collections.test.ts`:

- overview: every money KPI vs the database's own truth (full-table,
  independently-written Prisma aggregates with the same filters); sane
  collection-rate / avg-days-to-pay contracts; aging buckets exact at the
  boundaries (100.5d → 90+, 20.5d → 16–30, future → current) vs a JS
  re-bucketing of the table; the trend always six ascending calendar months
  ending now; method + provider mixes move by EXACTLY the seeded payment
  deltas (before/after DIFF — immune to other suites' rows).
- invoices: band exactness across all 8 bands with exact day counts
  (fractional-day fixtures keep `EXTRACT(DAY)` deterministic), severity-first
  ordering, the OVERDUE / SETTLED chips and the status filter narrowing IN
  SQL, pageSize-3 pagination walking the whole set with no duplicates, and
  number-search isolating a single row.
- payments: newest-first with joined invoice number + tenant name, method /
  provider filters narrowing IN SQL, search matching a gateway transaction
  reference.
- collections: only overdue PENDING invoices surface (future-due + PAID
  never leak), worst-first with exact day counts, the seeded dunning counter
  state riding the row verbatim, and a real manual send
  (`owner.dunning.remind`) incrementing the counter the workbench reads.

## Verification (2026-10-22)

- `bash scripts/ci.sh` — **ALL 13 STAGES GREEN, 1386/1386** (1370 + 16 new;
  0 unexpected failures, migrations apply cleanly, zero schema drift, perf
  budgets green: auth.me p95 17.7ms / employees.list 10.9ms /
  attendance.summary 4.7ms / payroll.runs.list 1.2ms)
- `bunx tsc --noEmit` — 0 errors
- `bun run build` — compiles cleanly; `/owner/billing` prerenders as static
  content
- No migrations, no env changes, no new dependencies

## Hot-apply (existing installs)

Extract over the workspace (same overlay convention as every prior
delivery), or apply just the 6 files listed above and restart `bun run dev`.
The old `/owner/billing` page and `owner.invoices.list` action are fully
replaced/superseded but the action remains available for compatibility.
