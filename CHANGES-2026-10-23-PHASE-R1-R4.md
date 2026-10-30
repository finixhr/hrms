# CHANGES — 2026-10-23 · Remediation Phases R1–R4 (audit roadmap execution)

**Source:** `Finix_HR_Complete_Code_Audit_and_Tenant_Side_Upgrade_Roadmap.pdf`
(2026-10-22, 158 findings) — this delivery executes the first four phases of
the seven-phase remediation roadmap end-to-end: **R1 hotfix wave, R2 payroll &
money correctness, R3 attendance/leave engines, R4 reporting & analytics
accuracy.**

**Verification (this build):** full 13-stage CI gate **EXIT 0** — 1,531/1,531
unit tests (1,472 baseline + 59 new) + 6 perf budgets green, zero schema
drift, `bun run build` EXIT 0, tsc/eslint clean, permission registry 566
actions all gated. `next` upgraded 16.3.6 → **16.4.2** (GHSA-2464-fhr4-w9xw +
GHSA-673q-mjm6-r5xr — two critical unauthenticated-RCE advisories against
≤16.4.0).

---

## Phase R1 — hotfix wave (10 findings)

| ID | Fix | Files |
|----|-----|-------|
| **DB-01** (Critical, customer-reported) | Backup export rebuilt as a **DMMF-driven inventory** (`backup-export.ts`): every schema model auto-classifies into vendor-scoped / parent-scoped / key-prefix / explicitly-excluded. Child tables (FamilyMember, BankAccount, LoanInstallment, TaxSlab, ApprovalStep/Action, CommunicationRecipient, the 5 procurement/stock item tables…) export through their parent's vendor-scoped ID set — **never an unscoped cross-tenant query**. The broken `typeof db[t] !== "function"` classifier (true for every Prisma delegate → genuine errors misclassified as "model missing") is gone; a real delegate-presence check plus **loud failure** for anything unclassified makes a silent skip structurally impossible. `excludedModels` rides the result with reasons. | `src/hrm-server/backup-export.ts` (new), `jobs.ts` |
| **FIN-01** | ESS loan/advance requests un-dead: `loanCreate`/`advanceCreate` schemas no longer demand `employeeId` (ESS submits self-scope through `resolveRequester`, which still enforces own-record-only for the EMPLOYEE role). | `validation.ts` |
| **ESS-01** | ESS "Request Attendance Correction" works for the EMPLOYEE persona: M-02 dual-perm in-handler gate (`ess.create` OR `attendance.create`) + SUB-107 ESS feature gate on the self path. | `routes/attendance.ts` |
| **ESS-03** | `ess.performance` returns **FINAL reviews only** — DRAFT ratings/comments/strengths/goals are invisible until the finalize-then-notify design hands them over. | `routes/ess.ts` |
| **ESS-04** | "Finalized reviews" stat compares against the written status `"FINAL"` (was the non-existent `"FINALIZED"` → permanently 0). | `views/ess.tsx` |
| **EMP-01** | Salary Revision card renders the real model fields (`previousSalary`/`newSalary`/`increaseAmount` — was `oldGross`/`newGross` → "Tk 0 to Tk 0" on every row); promotions rows now carry the decorated `departmentName`. | `views/employees.tsx`, `routes/employees.ts` |
| **RPT-02** | Salary-export totals row is **built from the column map** — BANK/MFS/CASH/ALL can never drift out of alignment again (BANK previously printed the net total under "Routing Number", ALL was 11 items on 12 columns). | `salary-export.ts` |
| **RPT-09** | Salary-export CSV download carries the UTF-8 BOM (Bangla names garbled in Excel on the module's most-exported file). | `views/payroll.tsx` |
| **LVE-117** | Encashment cap renders in **days** (`cap 15d`) — the engine's unit (was `৳15`). | `views/settings.tsx` |
| **REC-04** | Offer email includes `offer.notes` (the old ternary rendered an empty line whenever notes existed). | `routes/ats.ts` |

Pre-R1: the P6 baseline's 2 order-dependent suite failures were root-caused and
fixed — a **real R16 handler bug** (loginaudit tally counters overrode the
outcome filter and counted out-of-window rows) and a **pollution-fragile P2
assertion** (absolute avg-days constant → DB-truth comparison).

## Phase R2 — payroll & money correctness (9 findings)

| ID | Fix |
|----|-----|
| **PAY-01** | Guarantor fallback **restores the borrower's net symmetrically**: `restoreBorrowerNet()` reconstructs the unclamped net from the entry's paisa columns + the breakdown's full deduction list (repeat-offender/early-leave/PF lines live only in the breakdown). A positive-net borrower gets the moved amount back (previously underpaid by exactly the moved amount, payslip lines stopped summing); a clamped-৳0 borrower never receives a phantom payout. Run totals net the transfer; the line-cut (recovery-floor-capped lines) is handled exactly. |
| **PAY-03** | `salaryTemplates.apply` writes the **complete structure**: gross includes custom components, paisa dual-write via the shared `structurePaisa` helper (was Float-only), and a SalaryRevision history row lands like every other structure change. |
| **PAY-04** | `attendanceBonusFullMonth` is **enforced by the engine**: any absence forfeits the attendance allowance (the absence proration's share is deducted first — never double-deducted), surfaced as an itemized payslip line, wired into the payslip identity + run totals + the adjustment-delta engine. Weekly runs prorate. |
| **PAY-06** | Run `totalDeduction` is complete: guarantor withholdings (regular runs) and the repeat-offender/early-leave/PF/attendance-bonus deltas (adjustment runs) are included — totalDeduction and totalNet now reconcile. |
| **FIN-02** | **One reimbursement model**: approval sets `APPROVED` and posts NO journal; the register's `reimbursements.mark` performs the payout and posts the single balanced cash journal (5300/1010 — real chart accounts; the old 6300/1100 codes existed in no chart). The action was also permission-orphaned (`expenses.edit` — a verb no role template carries); it now correctly rides `expenses.pay`. |
| **FIN-03** | The configurable loan policy (counting loans + advances **jointly**) is the single source of truth for concurrent-credit limits; the hardcoded "max 2 active loans / max 2 recovering advances" overrides are removed. |
| **EXT-01** | Exit settlement AIT withholds the **full remaining §86 liability** (`remainingEstimate` — added to the AIT engine and its result type): a settlement is the employee's final payment of the income year; the old `netMonthlyAit` read carried only the 1/monthsRemaining catch-up slice and systematically under-withheld. |
| **EXT-02** | **Negative settlements complete**: the owed amount posts as a Cash-on-Hand debit (collected at clearance) and the Salaries-Payable credit only rides positive nets — the journal balances by construction for every sign of net (previously one-sided/invalid → the case was stranded APPROVED forever). Audit + employee notice state the owed direction honestly. |
| **PAY-13** | The recovery plan budgets the **same arrears-aware due** as the engine's LOA-001 rule (current EMI + up to `loanArrearsMax` missed EMIs) — the plan and the actual run deduction can no longer disagree for a borrower in arrears. |

## Phase R3 — attendance & leave engines (18 findings)

**Leave (LVE-101..108):**
- **LVE-101** zero-working-day check runs **before** the half-day floor (weekend-only "half-day" requests are refused instead of burning 0.5 days).
- **LVE-102** cancelling approved UNPAID leave also restores/removes the `LEAVE_UNPAID` attendance rows (payroll no longer keeps treating the days as unpaid absence after cancellation).
- **LVE-103** the overlap guard re-checks **inside the transaction**, after the balance-row `FOR UPDATE` lock — two concurrent applications for the same dates can never both commit (the outside-tx check raced).
- **LVE-104** **one fiscal leave-year keying end-to-end**: new `leaveYearOf()` (fiscal-year start month, July default; a January request charges the leave year that started the previous July) across apply / cancel / finalize hook / encashment / exit settlement / the v1 public API / the rollover job's accrual pass. The rollover no longer reads an 18-month-old ledger.
- **LVE-105** `carryForwardExpiryMonths` is **enforced** (`carriedForwardSpendable()` inside the canonical `spendableDays()`): carried days past their expiry window stop counting, with the stored value untouched for provenance.
- **LVE-106** `PRO_RATA` accrual is real: joining-date-prorated quotas (`proRatedEntitlement()`) on the lazy balance creation, the monthly accrual cap and the rollover's opening rows (previously PRO_RATA silently behaved as ANNUAL — a November joiner opened with the full quota).
- **LVE-107** gender-restricted leave types: new `LeaveType.genderRestriction` column (additive migration `9_wave9zk`, backfilled MATERNITY→FEMALE / PATERNITY→MALE), enforced at apply, editable in Settings → Leave (seed updated).
- **LVE-108** v1 public API policy parity: the waiting-period, backdate-window, probation per-request cap, optional-holiday limit and the gender gate now match the in-app path (the file header finally tells the truth).

**Attendance (ATT-002..011):**
- **ATT-002** cross-midnight checkout: every portal path (plain self-checkout, geo-fence) resolves the open check-in within a 24h lookback (`findOpenCheckIn`) — a day-shift employee who works past midnight can check out after 00:00; the row is flagged in remarks for the register.
- **ATT-003** the overnight branch applies the **same vendor policies** as the day branch (grace precedence `shift ?? policy ?? 10`, early-leave threshold, statutory 2h/day OT cap) through the shared `calcOvernight(shift, in, out, policy)`.
- **ATT-004** the biometric rebuild path: `otApproved=false` when OT approval is required (payroll must never treat null as approved — previously device OT was silently paid), preserved-when-approved on update, the vendor half-day threshold instead of a hardcoded 4h, and the same policy bundle on both branches.
- **ATT-005** geo-fence validity windows **wrap midnight** (21:00–07:00 was rejecting every minute of the day); the policy-schedule check fixed identically.
- **ATT-006** a branch-specific holiday suppresses the absent sweep/alert **only for that branch** — the sweep is extracted into the exported, unit-tested `sweepAttendanceAlerts()` and always evaluates per employee.
- **ATT-007** `attendance.today` resolves HOLIDAY **per employee branch** (no more tenant-wide HOLIDAY painting).
- **ATT-008** **per-date shift resolution** for rotating employees everywhere: shared `resolveShiftAssignmentForDate()` drives the payroll OT tiers and the OT register (three engines previously answered "which shift did they work on date X" three different ways).
- **ATT-009** the OT register's holiday tier is **branch-aware** (parity with the payroll engine's `holidaysOf(branchId)`).
- **ATT-010** mixed-employee overtime submissions are **refused** (one approval, one employee — previously approving person A silently approved person B's OT).
- **ATT-011** shift references are vendor-scoped: `resolveShift` fetches `{id, vendorId}` and `rosters.assign` validates the target shift belongs to the tenant (a foreign-tenant shift id used to be accepted silently).

## Phase R4 — reporting & analytics accuracy (12 findings + 8 new reports)

- **RPT-01** upcoming birthdays use **real next-occurrence date arithmetic** (the old month-day tuple filter required `dob-md ≥ today` AND `≤ today` — provably always empty; the `+=1231` wrap broke year boundaries). Feb-29 celebrates Feb-28 in non-leap years; the response carries the actual upcoming date + days-until.
- **RPT-03** headcount trend counts exits **in their exit month** (resignation LWD, else status-update month — headcountMovement parity). The old code added the **all-time terminated count to every historical month**, understating all past months whenever any termination existed. Fixed in both `dashboard.stats` and `analytics.all`.
- **RPT-04** filter honesty: the **Employee filter is applied** by every report fed through `scopedEmployees()` (~80% of the catalog — previously silently ignored), and the **Loans/Advances status filters are read** (the advances report now also *offers* its status filter; expenses adds the new APPROVED status).
- **RPT-05** festival-bonus "gross" is the **full structure gross** (was a 4-component sum that omitted conveyance/food/mobile/internet/attendance allowances and disagreed with the gratuity report).
- **RPT-06** field-force visits use **real calendar month bounds** (`new Date("YYYY-MM-31T…")` rolled into the next month for every month shorter than 31 days — up to 3 days of leakage for 7 months of the year).
- **RPT-07** the payroll register selects a **payable REGULAR run, newest calcEpoch first** — a CANCELLED or ADJUSTMENT run can no longer be rendered as the month's payroll.
- **RPT-08** turnover is the **trailing-12-month annualized rate** (exits in window ÷ average headcount) with its computation exposed as `turnoverDetail` (was all-time exits ÷ current directory size).
- **RPT-10** the AI NL catalogue covers **every registered report** (47/47 keys — was 13); `aiStatusCatalogueCheck()` is exported and CI-tested so a new report can never silently miss its NL entry. LLM-suggested status values are **validated against the report's own vocabulary** (an invented status previously returned an unfiltered report).
- **RPT-11** **one canonical attendance-rate definition** (`rateCountedStatus` + `attendanceRatePct`, employee-day basis, LEAVE/HOLIDAY/WEEKLY_OFF never attended, 100% ceiling) drives the dashboard, the analytics trend (previously counted leave/holidays as attended over records) and the attendance overview.
- **RPT-12** batched payout resolution on the three N+1 hot paths (`payroll.payout.status`, payout confirm, salary export) — ~10–15k round-trips saved at 5,000 employees via the already-existing `resolveSalaryPayouts()`.
- **PERF-01** `dashboard.stats` slim projection (no more full-roster base64 photo loads) + per-widget avatar hydration for only the displayed rows.
- **RPT-23** **eight new enterprise-standard reports** through the existing factory (PII gating, CSV twins, scheduling and AI rendering inherited): `attritionRate`, `ageBands`, `tenureBands`, `diversityOverTime`, `absenteeismTrend`, `otCost` (tier-aware taka), `holidayCalendar` (+ a subscribable **.ics export**), `payslipDistribution` (run audit: totals, method splits, payslip-number integrity).

**UI/UX pass (reports workspace):** gradient-tiled sidebar with live report
count, active-state gradient + icon chips, gradient generate button, 9-year
year selector (was ±2), ICS download affordance, catalog entries + chart hints
for all eight new reports.

## New tests (59)

| File | Covers |
|------|--------|
| `tests/unit/r1-hotfixes.test.ts` (8) | DB-01 classification + payload + isolation, FIN-01, ESS-01, ESS-03 |
| `tests/unit/salary-export-shape.test.ts` (+9 RPT-02) | column-count parity + per-header sum alignment, all four variants |
| `tests/unit/r2-money-correctness.test.ts` (9) | PAY-01 both directions, PAY-04, PAY-03, FIN-02, FIN-03, EXT-02, PAY-13 |
| `tests/unit/r3-engines.test.ts` (21) | ATT-002..011, LVE-101/102/104/105/106/107 |
| `tests/unit/r4-reporting.test.ts` (12) | RPT-01/03/04/05/06/07/08/10/11 + all 8 RPT-23 reports + ICS |

## Schema / migrations

- `9_wave9zk_leave_type_gender_restriction_20261023` — additive nullable
  column + statutory backfill (LVE-107). **Zero changes to existing tables.**
- Fresh-database migration smoke and the schema-drift gate both pass.

## Hot-apply notes

- Replace the changed source files, run `bun install` (next 16.4.2), then
  `bun run db:deploy` (one additive migration — safe on live data), then
  restart. No data backfills are required beyond the migration's own.
- The next/next-image RCE patches (16.4.2) are reason enough to deploy this
  build promptly on any internet-facing installation.
