# CHANGES — 2026-10-17 · Wave R3-2 (Exit Chain, Payroll Highs & Lost Regressions)

Round-3 full-system audit → implementation plan Wave **R3-2**: the exit money
chain completed end-to-end, the bonus/commission approval exposure the user
reported, and the six round-2 fixes the v3 branch had lost, re-ported.
Evidence and file:line citations live in
`the audit working papers (round-3 exit/gratuity findings)`, `3-b-payslip-bonus.md`,
`3-c…`, `3e-saas-rbac.md`; the plan is in `FinixHR_Full_System_Audit_Report.pdf`
(Wave R3-2).

---

## EXIT-005 (High) — Final salary on the payroll convention, netted against payroll

**Was:** `finalSalary = round(gross/26 × calendar-day-of-LWD-month)` — a
Jan-31 LWD paid 31/26 ≈ 119% of the monthly gross, Feb-28 paid 108%;
absences were never deducted; and if the final month's payroll had already
run, the same month was paid twice.

**Now:** pure, unit-tested `computeFinalSalary()` (src/hrm-server/routes/exit.ts):
- payable **working days 1→LWD** per the shift's weekly-off/holiday calendar
  (`gross × daysUptoLwd / monthWorkingDays`) — the same basis `calculateRun` uses
- **absences deducted** at the monthly daily rate (ABSENT = 1, HALF_DAY = 0.5,
  missing records count only when neither weekly-off nor holiday; the window
  starts at the joining date for mid-month joiners)
- **netted against payroll gross already PAID for the LWD month** (monthly and
  weekly runs alike), floored at 0
- the full basis is recorded in `computationJson.finalSalaryBasis` and shown on
  the settlement card; `settlements.pay` re-checks the netting and refuses to
  pay if payroll for the LWD month was disbursed **after** the calculation
  ("recalculate first" instead of double-paying)

## EXIT-006 (High) — Loan/advance ledgers closed when the settlement recovers them

**Was:** `settlements.pay` credited 1150/1155 in the journal but the loan
stayed `ACTIVE` and the advance `RECOVERING` with the same `outstanding` —
future EMI scheduling, due reports and re-hire payroll kept seeing them.

**Now:** inside the pay transaction, exactly the rows the calculation included
(`loanIds` / `advanceIds` persisted in `computationJson`; legacy computations
fall back to the live ACTIVE/RECOVERING set capped at the recorded dues):
- loans → `CLOSED`, `outstanding: 0`, open installments → `PAID`, plus an
  `employeeHistory` event with the settlement linkage
- advances → `RECOVERED`, `outstanding: 0`, `deducted` increased, history event

## EXIT-007 (High) — Provident Fund settled through the exit flow

**Was:** the retire/terminate dialog promised "provident fund settlement" but
`exit.ts` never read `pfEnrollment`/`pfContribution`; payouts were unlinked
manual bookkeeping with no accounting entry.

**Now:** `settlements.calculate` computes the PF balance (employee share +
employer share per policy) as a **`pfSettlement`** component in gross and
net; at pay, the enrollment is `CLOSED`, a withdrawal `PfContribution` row
(negative movement, source `WITHDRAWAL`, settlement-linked note) is written,
and the journal posts the PF portion as a **liability discharge**
(debit 2150 PF Payable) instead of salary expense (6100 carries only the rest).
Settings → Payroll → Provident Fund gained `settleAtExit` and
`includeEmployerAtExit` toggles. The settlement card shows the PF line with
the employee/employer split.

## EXIT-008 (High) — BD statutory notice matrix; the decided value is stored

**Was:** required notice was hardcoded 7 (probationary) / 30 (everyone) at
acceptance and recomputed again at settlement; the Settings → Employee
default was silently discarded.

**Now:** pure, unit-tested `resolveRequiredNoticeDays()`:
- PROBATIONARY → 7 days
- **worker matrix ON** (new Settings → Employee toggle
  `workerNoticeMatrix`, BLA §80/81): monthly-rated workers →
  **120 days ≥5 years' service / 60 days <5**
- staff/contract convention → the tenant's `defaultNoticePeriodDays`
The decided value is persisted on the resignation and the settlement reads
**that**; the matrix only recomputes as a fallback for legacy records.

## EXIT-009 (High) — Settlement money cannot move before the clearance is CLEARED

**Was:** `settlements.approve` required only CALCULATED; `settlements.pay`
only APPROVED — HR could pay while the employee still held assets.

**Now:** both routes (and pay re-checks after approval, since the checklist is
editable) refuse with an **itemized denial** — department + pending item
names — and a hint that dues the settlement itself recovers count as settled.
The exit case dialog shows a clearance status banner above the settlement
card.

## EXIT-010 (High) — Backdated resignation letters can no longer dodge the buyout

**Was:** a self-submitting employee could date the letter 30+ days before the
LWD while submitting it days before, manufacturing "served" notice
(`served >= 30` → FULL, zero buyout recovery).

**Now:** notice is served from `max(resignationDate, submissionDate)`
(pure `effectiveNoticeStart()`, unit-tested) — in acceptance math and the
settlement's fallback. The employee-stated date is kept as metadata and the
history event names the effective start.

## EXIT-012 (Medium) — Encashment subtracts pending reservations

Exit encashment now uses `entitled − used − pending` (the leave module's own
availability formula) so in-flight leave/encashment requests cannot be both
encashed in the settlement and consumed later.

## EXIT-013 (Medium) — Settlement OT on the payroll convention

Pure, unit-tested `computeSettlementOt()`: Settings → OT rates (shift
multipliers still win), the `maxOtHoursPerMonth` cap across the final month,
and the `roundToMinutes` step — previously hardcoded 1.5/2/2 with no cap and
no rounding.

## PAY-003 (High) — payRun marks ONLY the bonuses an entry actually included

**Was:** a blanket period-matched `updateMany` flipped EVERY APPROVED bonus
of the period to PAID — including rows approved between calculate and pay
whose money was never in any entry (silently lost).

**Now:** `calculateRun` records the exact included rows on each entry
(`breakdownJson.bonusLines`); `payRun` marks only those, and **warns** at pay
time (audit + response `excludedApprovedBonuses`) when APPROVED period bonuses
exist outside every entry. Legacy entries keep the old fallback.

## PAY-004 (High) — Commission engine: SoD, dedup, deterministic rules + UI

**Was:** `commissions.calculate` created bonuses **without `createdBy`**
(the SoD guard in `bonuses.approve` was vacuous — the same user could create
and approve), had no duplicate/period dedup, and picked rules in DB order.

**Now:** `createdBy` stamped (creator can never approve), zod-validated input
(month/year bounds, `salesAmount > 0`, ≤500 rows, per-row employee scope),
**period + rule dedup** (re-running the wizard cannot mint a second payable
row) plus the 90-second accidental double-submit guard, and pure
`orderCommissionRules()` — most-specific scope first (branch+designation >
branch > designation > global, ties on createdAt ASC). The tenant portal
finally gets the UI: **Commission Rules** (list/create/edit/delete with
validated rates) and a **Calculate Commissions** wizard
(month/year + per-employee sales rows + created/skipped report) in
Payroll → Bonuses & Commission.

## PAY-005 (High) — Preflight shows the bonus/commission exposure

`payroll.preflight` now returns a `bonusExposure` block: APPROVED
count/sum/byType that will ride the run, PENDING bonuses that will be MISSED
(with a top-10 warning list), commission totals, **festival bonuses already
paid this fiscal year** per employee, the payroll baseline and the exposure
% — with an amber warning past Settings → Payroll → Bonus Approval →
`exposureWarnPct` (default 25%). The preflight dialog renders it as a
two-card panel. `submitRunForApproval` also carries the bonus composition
into the approval request (label + payload), so the second gate sees it too.

## PAY-006 (High) — Total/aggregate bonus approval with escalation

- New `bonuses.approveBulk` {ids[], decision} → returns the aggregate BDT +
  per-type breakdown computed **before** anything is actioned; creator rows
  are skipped (SoD).
- The UI's **Bulk Approve** dialog shows the selected rows, the TOTAL
  exposure, and requires **typing APPROVE/REJECT** before acting.
- Bonuses at/above the new `bonusApproval.escalationThreshold`
  (Settings → Payroll → Bonus Approval, default ৳50,000) are routed through
  the new **BONUS approval workflow** (Settings → Approval Workflows, seeded by
  `scripts/seed-approval-workflows.ts`) instead of direct approval — the
  finalize hook lands the decision back on the bonus row. Tenants without a
  BONUS workflow fall back to direct approval, audited.
- `bonuses.list` flags escalated rows ("Awaiting owner approval" badge).

## PAY-008 (Medium) — Weekly runs no longer strand bonus fractions

**Was:** weekly runs prorated bonuses by the week fraction, but the first
paid week flipped the whole bonus to PAID — the remaining 60–80% was never
paid on the weekly cadence.

**Now:** a bonus rides the first run that includes the employee at its
**full remaining amount** (`amount − what PAID entries of the period already
disbursed`, tracked via `bonusLines`); a bonus only becomes `PAID` when the
cumulative disbursement covers it, otherwise it parks at `IN_PAYROLL` and a
later run of the period pays the remainder. `payroll.runs.cancel` reverts
both states.

## PAY-010 (Medium) — Settlement bonuses marked PAID

`settlements.pay` marks the consumed APPROVED bonuses `PAID` with the
settlement as `runId` — the same money can no longer be re-paid by a later
payroll run for a matching period.

## PAY-007 + PAY-012 (High/Medium) — ESS payslip self-service + payslip scope

- New self-scoped **`ess.payroll.html`** route (requireSelf + own-entry
  check) — My Payslips View/Print works out of the box for the EMPLOYEE role
  instead of 403-ing on `payslip.download`.
- `payslips.html` / `payslips.email` now enforce employee-visibility scope
  (`assertEmployeeVisible`) — a scoped manager can no longer fetch any
  tenant payslip by id.

## PAY-011 (Medium) — Commission rule numbers validated

`commissionRules.save` rejects rate ≤ 0, percent > 100, negative
minSales/cap (previously silently produced no bonus or nonsense).

## Re-ported round-2 regressions (lost in the v3 branch)

- **ATT-005 / ATT-002** — `overnight.ts` engine + the `computeAttendance`
  overnight branch: EVERY punch path (manual mark, portal self check-out,
  geo-fence, selfie) now scores a 22:00→06:00 shift as 480 minutes instead of
  0 (previously only the ZKTeco device path did). ESS checkout past midnight
  works.
- **ATT-302** — `attendance.otApprove` enforces employee scope again
  (branch/department managers cannot approve OT for foreign-branch employees).
- **SUB-005** — `devices.setEnabled` re-checks the DEVICES capacity when a
  device is re-enabled (off/on no longer bypasses the seat cap).
- **SUB-104 / RouteDef.mutating** — read-only lockout classification is
  deny-by-default: `READ_HEADS` allowlist + the `mutating` flag on RouteDef
  replace the old ~31-verb heuristic that let ~75 mutating actions
  (`attendance.mark`, `payroll.adjustmentCreate`, `approvals.act`, …)
  through to EXPIRED/SUSPENDED tenants; billing read prefixes are exempt.
- **M-14 (devices)** — `devices.mappings` / `devices.commLogs` scope to the
  caller's devices for branch managers (filtered and unfiltered lists).
- **HRM-001** — `letters.download` self-scope re-ported: ESS employees
  download their own ISSUED letters; holders keep the manager path with the
  sensitive-letter reason audit.

---

## Files changed (20 modified + 4 new)

| File | Change |
|---|---|
| `src/hrm-server/routes/exit.ts` | + `resolveRequiredNoticeDays`, `effectiveNoticeStart`, `computeFinalSalary`, `computeSettlementOt` (pure, unit-tested); settlement rewrite (EXIT-005/007/008/010/012/013 + basis persistence); `assertClearanceCleared` gate (EXIT-009); pay-path ledger closure EXIT-006/PAY-010/PF journal split |
| `src/hrm-server/payroll.ts` | `bonusPaidSoFarForPeriod`; bonusLines + remaining-based inclusion (PAY-003/008); precise PAID/IN_PAYROLL marking; excluded-bonus warning; approval payload composition (PAY-005) |
| `src/hrm-server/routes/payroll.ts` | `applyBonusDecision` + `escalateBonusApproval` (PAY-006); `bonuses.approveBulk`; escalated flag on list; preflight `bonusExposure` (PAY-005); payslips scope (PAY-012) |
| `src/hrm-server/routes/ess.ts` | + `ess.payroll.html` self-scoped payslip route (PAY-007) |
| `src/hrm-server/routes/roadmap.ts` | `orderCommissionRules` (pure); commission validation + SoD + dedup (PAY-004/011) |
| `src/hrm-server/routes/payout.ts` | cancel reverts IN_PAYROLL bonuses too |
| `src/hrm-server/routes/attendance.ts` | overnight branch (ATT-005 re-port); `otApprove` scope (ATT-302) |
| `src/hrm-server/routes/devices.ts` | setEnabled capacity (SUB-005); mappings/commLogs scoping (M-14) |
| `src/hrm-server/routes/letters.ts` | `letters.download` self-scope (HRM-001 re-port) |
| `src/hrm-server/routes/registry.ts` | `mutating?: boolean` on RouteDef (SUB-002/SUB-104) |
| `src/app/api/hrm/route.ts` | inverted READ_HEADS lockout classifier + billing read exemptions |
| `src/hrm-server/overnight.ts` | **NEW** — shared cross-midnight shift engine (re-port) |
| `src/hrm-server/settings.ts` | pf.settleAtExit/includeEmployerAtExit; `bonusApproval` group; employeeSettings.workerNoticeMatrix |
| `src/hrm-server/approval.ts` | ProcessType += "BONUS" |
| `src/hrm-server/routes/hooks.ts` | BONUS finalize hook registration |
| `scripts/seed-approval-workflows.ts` | BONUS workflow default (Finance review → Owner) |
| `src/hrm/views/payroll.tsx` | bulk-approve dialog (typed confirm + aggregate), escalation badges, commission rules UI + calculate wizard, preflight bonus-exposure panel |
| `src/hrm/views/exit.tsx` | PF settlement line, final-salary basis note, clearance banner (EXIT-009) |
| `src/hrm/views/ess.tsx` | My Payslips calls the self-scoped `ess.payroll.html` |
| `src/hrm/views/settings.tsx` | Bonus Approval group; PF at-exit toggles; worker notice matrix toggle; BONUS in PROCESS_TYPES |
| `src/hrm/API.md` | new/changed routes documented |
| `tests/unit/r3-2-wave-exit-payroll.test.ts` | **NEW** — 26 tests: pure engine suites + dispatcher/engine scenarios |
| `tests/unit/r3-1-wave-criticals.test.ts` | EXIT-002 fixture seeds final-month attendance (R3-2 convention); unused import cleanup |

No schema/migration changes (all linkage rides existing JSON columns and the
Bonus/PayrollEntry status vocabularies; `IN_PAYROLL` was already in the
schema comment vocabulary and is now actually used).

## Verification

- `tsc --noEmit` → **0 errors**
- `prisma validate` → valid (no schema changes)
- ESLint on all changed files → **0 new errors** (remaining hits are the
  project's pre-existing react-hooks / non-null-assertion baseline)
- Pure-function sandbox harness (tests/unit/r3-2-wave-exit-payroll.test.ts): **37/37 PASS**
- R3-1 harness re-run (regression): **54/54 PASS**
- `scripts/check-migrations.mjs` → **pre-existing FAILs**: the user's own
  `10_/11_/12_*_20261014/15` migrations violate the `9_wave<N>_` naming
  convention the checker enforces (P3018 fresh-database ordering). No
  migrations were added by R3-1/R3-2; renaming them is a database-stream
  decision for Wave R3-4.
- DB-integration tests (`bun test tests/unit/r3-2-wave-exit-payroll.test.ts`)
  require the isolated unit-test PostgreSQL — same harness as the existing
  suite; run on a machine with PostgreSQL

## Deferred (by design, later waves)

- AIT withholding on settlement income (PAY-010's tax-treatment half) and
  the §86 settlement computation → R3-3/R3-4 (tax engine integration)
- Leave money correctness workstream (LVE-001/002/005/006) → R3-2
  continuation (separate leave.ts pass to keep this wave reviewable)
- Field-level permission system (FLD-101/102) → R3-5
