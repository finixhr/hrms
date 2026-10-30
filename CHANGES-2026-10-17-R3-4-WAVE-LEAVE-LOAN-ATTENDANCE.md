# CHANGES — 2026-10-17 · Wave R3-4 (Leave Money, Loan Recovery & Attendance Integrity)

Round-3 full-system audit → implementation plan Wave **R3-4**: the leave
money-path the engine forgot, the loan lifecycle gaps that silently
under-recover, the attendance integrity drift, AIT on settlement income, and
the database hygiene item. 20 findings closed: LVE-001/002/005/006/007 +
LVE-003/004/008/009/013 (leave), LOA-001/002 + ADV-001/002 (loan & advance),
PAY-010b + EXIT-011 (settlement tax & schema), ATT-303/310 (+ re-verified
pre-R3-4 remnants ATT-304/305/306/308/311, LOA-005, WF-001), and the
`10_/11_/12_*` migration-naming P3018 bug. Evidence and file:line citations
live in `the audit working papers (round-3 leave/loan findings)`, `3-c-attendance-tracking.md`,
`3-a-exit-gratuity.md` and `3-b-payslip-bonus.md`.

**NO schema/migration changes** (comment-only edits in schema.prisma;
migration DIRECTORIES renamed — see the operator note at the bottom).
17 files modified, 3 new source files (`src/hrm-server/leave-math.ts`,
`src/hrm-server/loan-math.ts`, the R3-4 test suite) + the
`tests/unit/r3-4-wave-leave-loan-attendance.test.ts` sandbox harness (outside the tree).

---

## LVE-001 (High) — unpaid (LWP) leave is no longer silently paid by payroll

**Was:** `applyLeaveDecision` wrote attendance `LEAVE` rows regardless of the
type's `paid` flag, and `calculateRun`'s switch counted every `LEAVE` day as a
payable day — every unpaid-leave day was paid at full daily rate. Perversely,
*CANCELLING* an approved unpaid leave was financially better than keeping it
(cancellation flipped the rows to ABSENT, which payroll then deducted).

**Now**:
- `applyLeaveDecision` (src/hrm-server/routes/leave.ts) writes **`LEAVE_UNPAID`** rows for
  full days of a `paid=false` type (half-day requests keep the historical
  HALF_DAY row); the synthetic remarks marker keeps working for cancel-restore.
- `calculateRun` (payroll.ts): `case "LEAVE_UNPAID"` counts the day as leave
  (reporting) **and** as an absence (pay) — it flows into
  `absenceDeduction` exactly like the audit recommends. The payslip breakdown
  line surfaces it (`Absence (Xd, incl. Yd unpaid leave)`) and
  `breakdownJson.attendance.unpaidLeaveDays` records the split.
- Reports/analytics: `LEAVE_UNPAID` joins the leave bucket everywhere LEAVE is
  reported (dashboard today card, attendance overview KPIs + CSV) and is
  excluded from present/per-day counts like LEAVE (src/hrm-server/routes/reports.ts).
- Attendance.status is a free string column — **no migration needed**; the
  schema comment documents the new vocabulary member.

## LVE-002 (High) — ONE canonical "available balance" formula; carried days spendable

**Was:** four disagreeing formulas coexisted — the enforcement paths
(`leaveRequests.apply` tx check, `leaveBalances.list`, `ess.leave`, the v1
public API) computed spendable from `entitled` ALONE (carried-forward days
were unspendable after the rollover), while the admin AI-assist context, the
quick-actions sheet and the self-check invariant added `carriedForward` on top
(double-counting after a recompute folded the carry into entitled).

**Now** (new `src/hrm-server/leave-math.ts`):
- `spendableDays(b) = entitled + carriedForward − used − pending` — THE
  formula, consumed by: the apply-time H-9 locked check, `leaveBalances.list`,
  `ess.leave` (both remaining formulas), `leave.encash`, the exit settlement
  encashment, the v1 public API tx check, and the fiscal-year carry computation.
- `leaveBalances.recompute` no longer folds carry into entitled —
  `entitledFloor(defaultDays, used+pending, carriedForward)` resets entitled
  to the type's default, floored so spendable never goes negative on an
  over-committed ledger (the admin/quick-actions/self-check consumers that add
  carriedForward are now CORRECT because entitled no longer contains the carry).
- The rollover job keeps `entitled = defaultDays, carriedForward = carry`
  storage (Design B) and now subtracts `pending` from the carryable remainder
  (an in-flight reservation no longer carries into the new year as unused).
- The Balances tab helper text states the formula.

## LVE-005 (High) — encashment reservation is transactional; the finalize hook resolves the exact approval

**Was:** `leave.encash` read `remaining` outside any transaction, submitted the
approval and incremented `pending` as two separate awaits (two concurrent calls
both passed and both reserved — the exact H-9 anti-pattern), and
`applyEncashmentDecision` resolved the approval by `entityId`-only lookup —
with two open encashments on one balance, finalizing #2 could apply #1's
payload or double-convert. The pending→used conversion was an absolute write
from a stale read.

**Now** (src/hrm-server/routes/leave.ts + src/hrm-server/routes/hooks.ts):
- `leave.encash` wraps check + `createApprovalRequest` + reservation in ONE
  `$transaction` with `SELECT … FOR UPDATE` on the balance row (H-14 shape,
  mirroring `leaveRequests.apply`); announce/audit stay post-commit.
- `applyEncashmentDecision(ctx, balanceId, decision, approvalId?)` resolves the
  approval BY ID (hooks.ts forwards `req.id`); the entityId-only lookups
  remain as legacy fallbacks.
- Both conversion and release use **guarded atomic decrements**
  (`updateMany WHERE pending >= days`), clamping instead of going negative.

## LVE-006 (Medium) — `encashmentCap` is DAYS on BOTH encashment paths

**Was:** the ESS path read the cap as DAYS, the exit settlement read the SAME
column as TAKA (`amount > cap → amount = cap`: a 15-day cap truncated the
payout to ৳15). Whatever HR configured, one path enforced the wrong limit.

**Now**: new `encashableDaysFor(spendable, capDays)` in leave-math.ts is the
single derivation (ESS denial + exit settlement days); the schema comment and
the Settings label now say days ("Encashment cap (days) — caps encashment
requests AND the exit-settlement payout at N days per type").

## LVE-007 (Medium) — the ESS leave-encashment workflow is reachable

**Was:** the route, the ENCASHMENT approval workflow and the finalize hook all
existed — but NO view ever called `leave.encash`. A configured-but-dead
capability: long-tenured employees could not encash accrued leave while
employed.

**Now**: "Encash" action on the Leave view → Balances tab (HR, for
encashment-eligible types; `leaveBalances.list` now returns
`encashmentAllowed`), and "Request encashment" on the ESS portal → My Leave
balance cards (self-scoped). Both submit through the same audited route; the
payout rides payroll as an ENCASHMENT bonus once approved.

## LVE-003/004/008/009/013 (leave pass, landed with this wave) — verified + kept

Waiting-period & probation-cap enforcement (LVE-003), the overlap guard
including APPROVED requests (LVE-004, also ported to the v1 public API),
the recompute on `leave.edit` with per-employee transactions (LVE-008, now
with the carry-preserving floor), cancel-as-conditional-claim with punch
restore + PENDING-guarded approval cancellation (LVE-009), and the v1
public-API leave requests submitting through the approval engine with a real
H-9 reservation (LVE-013) — all re-verified by the R3-4 test suite.

## LOA-001 (Medium) — missed installments budget as arrears; OVERDUE finally exists

**Was:** calc, pay-time recovery and the guarantor pass all matched
installments by `dueMonth === currentMonth` only — a missed EMI (no run,
borrower excluded, deduction off that month, weekly proration shortfall) was
deferred to NEVER, and nothing ever wrote the `OVERDUE` status five readers
already consumed.

**Now**:
- New pure `dueInstallmentsFor(inst, monthPrefix, arrearsMax)` +
  `dueAmountFor` (src/hrm-server/loan-math.ts): the CURRENT period's unpaid
  EMI always budgets, plus up to `settings.payroll.loanArrearsMax` (default 3)
  most-recent MISSED installments (oldest-first). 0 = historical behaviour.
  Consumed by the calc loop, the guarantor fallback pass AND the pay-time
  ledger recovery — budget == ledger by construction.
- The pay-time recovery switched to **atomic increments**
  (`paidAmount: { increment: pay }`, status from the returned row) so a
  concurrent manual repayment can no longer be lost by a stale absolute write.
- New daily sweep `loanOverdueSweep` (jobs.ts, exported + tested): past-due
  unpaid PENDING installments are marked OVERDUE (PARTIAL keeps its stronger
  signal) and HR gets a one-per-day digest notification.

## LOA-002 (Medium) — manual installment payment is race-safe and posts to the GL

**Was:** `loans.recordInstallment` did read-then-write absolute updates on the
installment AND loan rows (concurrent payroll recovery or a second clerk could
double-count or lose a payment) and posted NO journal — the loan receivable
account (1150) was overstated by every manually-repaid installment.

**Now** (src/hrm-server/routes/finance.ts): guarded conditional claims
(`WHERE paidAmount = <read value>`, 0 rows → **409 retry**), atomic increments,
loan-level reconciliation from the authoritative installment sum on a lost
race, and a **`LOAN_RECOVERY` journal** (Dr 1100 Cash & Bank / Cr 1150 Loan
Receivable) with an idempotency key
(`LOAN_RECOVERY:{installmentId}:{from}:{amount}`) so a retry cannot double-post.
The audit row carries the journal id (or a visible reconciliation warning).

## ADV-001/PAY-009 (Medium) — minimum take-home floor for loan/advance recovery

**Was:** the borrower's entire net could be consumed by EMI + advance recovery
(the only guard was the post-hoc clamp-to-zero; the guarantor path HAD a 25%-of-
net cap, the borrower had nothing).

**Now**: `settings.payroll.recoveryMaxPctOfNet` (default **50%**) drives the
new pure `applyRecoveryFloor()` (loan-math.ts) inside `calculateRun`: the
borrower's OWN loan+advance recovery can never exceed that share of the
pre-recovery net; the excess is deferred (loan arrears re-budget it next run,
advances simply run longer), surfaced in the payslip warnings AND
`breakdownJson.recoveryDeferred`.

## ADV-002 (Low) — advance-vs-salary cap

`advances.create` refuses an advance beyond
`settings.payroll.advanceMaxPctOfMonthlyGross` (default 100%) of the
borrow's monthly gross when an ACTIVE salary structure exists — a festival
advance can no longer be 10× salary against a credit-light employee.

## PAY-010b (Medium) — AIT withheld on the salary-like components of a final settlement

**Was:** the settlement disbursed final salary + OT + leave encashment + bonus
+ notice pay with **zero** AIT withholding — the same money paid inside a
payroll run was taxed at the §86 average rate, so the AIT module's views and
the settlement disagreed (the exit journal had no AIT line at all).

**Now** (src/hrm-server/routes/exit.ts):
- `settlements.calculate` runs the salary-like components through the SAME
  `computeAit` engine (ytd ACTUALS from PAID runs of the income year before the
  LWD month + this payment + previous-employer income; §86(4) TDS already
  withheld credited; months-to-FY-end from the LWD). Gratuity (BLA §96
  statutory exemption) and the PF refund (the employee's own money) are never
  withheld.
- The computation records `settlementAit` + `aitDetail`
  (rule set, average rate, ytd basis); `netPayable`/`totalDeductions` reflect it.
- `settlements.pay` posts the withheld AIT to **2105 AIT Payable** (the same
  account payroll's own AIT line uses); the Salaries Payable credit carries it
  out of the employee's net — the journal stays balanced by construction.
- The exit settlement UI shows the "AIT Withheld" line. Toggle:
  `settings.ait.settlementWithholding` (default on; best-effort — an AIT config
  problem never blocks the settlement).

## EXIT-011 (Medium) — settlements.calculate finally has an input schema

**Was:** `otherDeductions` arrived unvalidated (schema-less action); a
NEGATIVE value inflated netPayable (more "deductions" = more pay).

**Now**: `S.settlementCalculate` (validation.ts): `resignationId` id +
`otherDeductions: number().finite().min(0).max(1e9).optional()`.

## ATT-303 (Medium) — the daily sweep materializes the ABSENT rows reports read

**Was:** a no-show day produced NO Attendance row — the absent report, the
monthly register, the long-absence alert and analytics (which count stored
ABSENT rows) reported ≈0 absentees while payroll re-derived absence
independently: two sources of truth.

**Now**: exported `materializeAbsentDay()` (jobs.ts) runs inside the daily
jobs — for yesterday, for every ACTIVE/PROBATION employee with no record
(the alert block's data is reused), respecting weekly-offs, holidays, joining
date, LEAVE/LEAVE_UNPAID rows and punches (a unique-key race lets the punch
win). HR gets a digest notification; payroll's own missing-day loop remains as
defense-in-depth. Idempotent.

## WF-001 (Medium) — pending approvals remind and escalate

The daily `approvalReminderSweep` (jobs.ts): requests resting longer than
`settings.approvals.reminderDays` (default 3) produce a once-a-day digest to
HR admins (top 5 with age); at twice the window the tenant owner is
escalated too. Marketing's "auto-escalation" claim finally has an engine
behind it (per-request spam was deliberately avoided).

## ATT-310 (Info) — selfie punches keep their provenance

Selfie check-in/out rows store `source: "SELFIE"` (was mislabeled
`"GEOFENCE"` with a dead ternary); the schema comment documents the new
source vocabulary member.

## Pre-R3-4 remnants re-verified by the test suite

ATT-304 (out-only corrections approvable), ATT-305/PAY-017 (attendance
period lock + `overridePaidLock`), ATT-306 (daily OT ceiling + comp-off
accrual), ATT-308 (grace parity), ATT-311 (bounded bulkMark), LOA-005 (loan
type enum).

---

## Migration directory renames — OPERATOR NOTE (P3018 fresh-database bug)

The user's own `10_loan_guarantor_control_20261014`, `11_ait_legal_audit_20261014`
and `12_present_address_fields_20261015` folders sort BETWEEN `1_…` and `2_…`
in Prisma's lexicographic apply order — every FRESH database fails (P3018:
migration 10 runs before migration 5 creates its tables). Renamed in place:

| Old | New |
|---|---|
| `10_loan_guarantor_control_20261014` | `9_wave7_loan_guarantor_control_20261014` |
| `11_ait_legal_audit_20261014` | `9_wave8_ait_legal_audit_20261014` |
| `12_present_address_fields_20261015` | `9_wave9_present_address_fields_20261015` |

`scripts/check-migrations.mjs` passes again (tip advanced to
`9_wave9_present_address_fields_20261015`; the guard's docs now explain the
rename).

**ALREADY-APPLIED DATABASES** (staging/production): rename the tracking rows
too, or `prisma migrate deploy` will try to re-run the renamed migrations and
fail:

```sql
UPDATE _prisma_migrations SET name='9_wave7_loan_guarantor_control_20261014' WHERE name='10_loan_guarantor_control_20261014';
UPDATE _prisma_migrations SET name='9_wave8_ait_legal_audit_20261014'      WHERE name='11_ait_legal_audit_20261014';
UPDATE _prisma_migrations SET name='9_wave9_present_address_fields_20261015' WHERE name='12_present_address_fields_20261015';
```

Run after a backup, before the next `migrate deploy`. Fresh databases need
nothing.

## Files touched

```
src/hrm-server/leave-math.ts            (NEW — spendableDays / entitledFloor / encashableDaysFor)
src/hrm-server/loan-math.ts             (NEW — dueInstallmentsFor / dueAmountFor / applyRecoveryFloor)
src/hrm-server/routes/leave.ts           (LVE-001/002/005/006/007/008)
src/hrm-server/routes/hooks.ts           (LVE-005 — forwards the approval id)
src/hrm-server/payroll.ts               (LVE-001 + LOA-001 arrears + ADV-001 floor, atomic recovery)
src/hrm-server/routes/exit.ts            (LVE-002/006 + PAY-010b + EXIT-011)
src/hrm-server/routes/finance.ts         (LOA-002 + ADV-002)
src/hrm-server/routes/ess.ts             (LVE-002)
src/hrm-server/routes/attendance.ts      (ATT-310 + remnant type fixes)
src/hrm-server/routes/reports.ts         (LEAVE_UNPAID buckets)
src/hrm-server/jobs.ts                   (ATT-303 + LOA-001 sweep + WF-001 + rollover carry)
src/hrm-server/validation.ts             (S.settlementCalculate)
src/app/api/v1/leave-requests/route.ts   (LVE-002 spendable)
src/hrm/views/leave.tsx                  (LVE-007 Balances encash action)
src/hrm/views/ess.tsx                    (LVE-007 ESS encash dialog)
src/hrm/views/exit.tsx                  (PAY-010b AIT line)
src/hrm/views/settings.tsx               (LVE-006 label)
prisma/schema.prisma                     (comments only)
prisma/migrations/9_wave7|8|9_*         (renamed from 10_/11_/12_*)
scripts/check-migrations.mjs            (tip + docs)
tests/unit/r3-4-wave-leave-loan-attendance.test.ts (NEW — 21 tests)
tests/unit/r3-4-wave-leave-loan-attendance.test.ts                   (NEW harness, outside the tree)
```

## Verification

- `tsc --noEmit` — **0 errors**
- `prisma validate` — **valid** (no schema changes)
- `node scripts/check-migrations.mjs` — **OK** (23 migrations, order verified)
- `eslint` — **0 errors** on every changed file (pre-existing react-hooks
  baseline elsewhere untouched; 4 latent errors in the v1 leave route from the
  interrupted session were fixed)
- `bun run tests/unit/r3-4-wave-leave-loan-attendance.test.ts` — **44/44 PASS** (pure PART A)
- Regression: `verify-r31` **54/54** · `verify-r32` **37/37** · `verify-r33`
  **66/66** PASS
- DB-integration tests shipped in `tests/unit/r3-4-wave-leave-loan-attendance.test.ts`
  (dispatcher + engine scenarios: LWP attendance, encashment approval-id
  resolution, carry-spendable apply, OVERDUE sweep, ABSENT materialization,
  settlement schema, advance cap, manual-repayment journal) — run with the
  isolated unit-test PostgreSQL (`bun test tests/unit/r3-4-…`).
