# CHANGES — 2026-10-17 · Wave R3-1 (Critical Money-Path Fixes)

Round-3 full-system audit → implementation plan Wave **R3-1**: the five
**Critical** findings that directly move or block employee money. Evidence and
file:line citations live in `the audit working papers (round-3 exit/gratuity findings)`
and `3-b-payslip-bonus.md`; the plan and severity register are in
`FinixHR_Full_System_Audit_Report.pdf` (Wave R3-1).

---

## EXIT-001 (Critical) — Gratuity is now part of the final settlement

**Was:** gratuity existed only as an advisory report (`reports.ts` "Gratuity
Provision (BLA)") and a UI promise in the retire/terminate dialog. The exit
engine never computed, stored, displayed, journaled or paid it — every eligible
exiting employee was under-settled by their entire statutory entitlement
(BD Labour Act §96: 30 days' wages per completed year after 5 years'
continuous service).

**Now:**
- New shared engine `src/hrm-server/gratuity.ts` (pure, unit-tested):
  - `completedMonthsBetween()` — calendar-anniversary service months
  - `computeGratuity()` — BLA formula `(wage ÷ divisor) × daysPerYear × completedYears`
    with eligibility threshold (default 5y; **4y6m+ rounds up** per the 2018
    amendment), wage basis BASIC/GROSS, divisor 30 (BLA) / 26 (factory), flat cap
- New Settings group **`gratuity`** (`settings.ts`, BLA defaults
  `{enabled: true, eligibilityYears: 5, daysPerYear: 30, wageBasis: "BASIC",
  divisor: 30, capAmount: 0}` — automatically savable via SETTINGS_SAVE_GROUPS)
- `settlements.calculate` (src/hrm-server/routes/exit.ts): computes gratuity from
  `joiningDate → LWD`, adds `gratuity / gratuityYears / gratuityEligible /
  gratuityCapped` to `computationJson`, includes the amount in **gross** and
  **netPayable**, and therefore in the CRIT-4-balanced pay journal (debit 6100
  Final Settlement Expense)
- The advisory **Gratuity Provision report now uses the same shared engine**
  (reports.ts) — the "Eligible (5y)" flag and amount can never disagree with
  the money the settlement pays
- Exit settlement card (`src/hrm/views/exit.tsx`) shows the Gratuity line with the
  `(6y × 30 days' basic)` annotation

## EXIT-002 (Critical) — Post-LWD settlement deadlock removed

**Was:** the daily closure sweep flips the resignation to `COMPLETED` on the
LWD, but `settlements.calculate` required `NOTICE_PERIOD | ACCEPTED` — the
normal HR sequence ("let the employee finish, then settle") was impossible:
final-month attendance/OT only exists at/after the LWD, by which time
calculation was permanently denied.

**Now:**
- `settlements.calculate` accepts **COMPLETED** resignations whose settlement
  has not been PAID (recalculable); a COMPLETED + PAID exit is closed with a
  clear Deny
- `exit.assets.clearWithDeduction` likewise accepts COMPLETED exits (asset
  recovery with deduction stays possible until the settlement is paid)
- `tests/unit/r3-1-wave-criticals.test.ts` PART B: calculates a settlement on
  a COMPLETED resignation the day after the LWD (dispatcher-driven)

## EXIT-003 (Critical) — Notice-pay direction corrected

**Was:** the shortfall in notice was ALWAYS deducted from the employee — an
immediate termination ("Waived") had a full 30 days' pay deducted from the
final settlement even though the company released them.

**Now:** pure, unit-tested **direction matrix** `resolveNoticeComponent()` in
src/hrm-server/routes/exit.ts:

| Exit | Notice mode | Unserved days → |
|---|---|---|
| RESIGNATION | SHORT / BUYOUT | employee owes (deduction, as before) |
| TERMINATION / RETIREMENT | any | **company owes → `noticePay` in gross** |
| any | WAIVED / EARLY_RELEASE | **company owes → `noticePay` in gross** |
| any | full notice served | nothing |

- `settlements.calculate` uses `res.servedDays` (stored at acceptance) with
  date-math fallback, writes `noticePay` (payable) or `noticeBuyout`
  (deduction) accordingly, and keeps the journal balanced (noticePay rides
  gross → debit 6100 / credit 2100 via netPayable)
- Settlement card shows "Notice Pay (N days unserved)" as a payable line
- Note: the full BLA 60/120-day worker notice matrix and decided-notice-days
  storage remain Wave R3-2 (EXIT-008/010); requiredNotice stays 7/30 here

## (+ EXIT-004, High — brought forward) — Employee status vocabulary

The two write sites rewritten by this wave no longer write the internal
exit-type nouns (`RESIGNATION/TERMINATION/RETIREMENT`) onto
`employee.status`: new `exitStatusForEmployee()` maps to the real vocabulary
(`RESIGNED/TERMINATED/RETIRED`) in `settlements.pay` and the jobs.ts closure
sweep. Reporting, filters, badges, the terminate re-entry guard and the
shipped h6 test (`expect(emp?.status).toBe("RESIGNED")`) all see exited
employees again.

## PAY-001 (Critical) — Adjustment runs pay TRUE DELTAS

**Was:** `createAdjustmentRun` minted a DRAFT ADJUSTMENT run but
`calculateRun` recomputed the FULL month — Calculate → Submit → Pay Now
through the intended UI re-disbursed a complete second payroll (gross, OT,
bonus, AIT, net) with only the payslip numbers (`-A1`) differing.

**Now:**
- New pure, unit-tested `applyAdjustmentDeltas()` (payroll.ts): after the
  ordinary recompute, every entry is transformed into the **correction**
  (recomputed − PAID source run):
  - **Earnings + AIT are deltas** (recomputed − source). The AIT delta composes
    cleanly because the §86(4) year-to-date actuals exclude the same-period
    source run — unchanged data yields a zero delta
  - **Ledger-driven components are NOT subtracted** (they self-manage through
    status transitions): bonuses/manual deductions consumed by the source run
    are PAID (the recompute only sees new ones), loan/advance installments
    already recovered are excluded (the recompute only sees what is still due)
  - **Negative net is a legitimate recovery** — no M-5 zero-clamp on corrections
  - Entry stores `adjustEntryId` (source link) and a payslip-compatible
    correction breakdown (`adjustment` envelope + signed delta lines + a
    warning on negative nets)
- `calculateRun` (ADJUSTMENT path): validates the source run is PAID, applies
  the transform, recomputes all run totals as deltas, refreshes the paisa
  shadows. Approval payload/label carries "Adjustment #n (delta ৳…)"
- `payRun` (ADJUSTMENT path): journal lines go through the new
  **`normalizeJournalSides()`** (accounting.ts — negative debit flips to
  credit and vice versa, zero lines dropped; balance preserved by
  construction), the plug line is no longer zero-clamped, an all-zero
  correction posts nothing, the memo says "delta ৳…", the **source entries are
  marked `status: "ADJUSTED"`** (schema vocabulary finally used), and
  employees get a "Payroll Adjustment Processed" notification instead of a
  second "Salary Processed" credit message
- Payroll run detail view (`src/hrm/views/payroll.tsx`) shows an amber explainer:
  entries are corrections vs the paid source run; totals are deltas

## PAY-002 (Critical) — Rogue runTypes can no longer pay a second month

**Was:** `payroll.runs.create` accepted `runType: BONUS | FINAL_SETTLEMENT`
(and ADJUSTMENT); the calculation engine ignores runType and pays a FULL
month, and the duplicate-run check keyed by runType — an authenticated caller
could double-disburse any paid month.

**Now:**
- `validation.ts payrollCreate.runType` = `z.enum(["REGULAR"]).nullish()`
- Handler guard (belt-and-braces): any non-REGULAR runType gets a 400 with
  guidance (adjustments → Create Adjustment Run on a paid run; bonuses → the
  regular monthly run; final settlements → Exit Management)
- Duplicate-run check and create are now unconditionally REGULAR
- API.md updated

---

## Files changed (13 + 2 new)

| File | Change |
|---|---|
| `src/hrm-server/gratuity.ts` | **NEW** — shared BLA gratuity engine (pure) |
| `src/hrm-server/settings.ts` | + `gratuity` settings group + defaults |
| `src/hrm-server/routes/exit.ts` | + `exitStatusForEmployee`, `resolveNoticeComponent`; settlement gate (EXIT-002); gratuity + notice direction in compute; journal comment; clearWithDeduction COMPLETED scope; pay-path status vocabulary |
| `src/hrm-server/jobs.ts` | closure sweep status vocabulary (EXIT-004) |
| `src/hrm-server/routes/reports.ts` | gratuity report uses the shared engine |
| `src/hrm-server/payroll.ts` | + `applyAdjustmentDeltas`; calculateRun ADJUSTMENT delta path; submit/payRun adjustment-aware (journal sides, memo, source ADJUSTED marking, notification) |
| `src/hrm-server/accounting.ts` | + `normalizeJournalSides()` |
| `src/hrm-server/validation.ts` | payrollCreate runType → REGULAR only |
| `src/hrm-server/routes/payroll.ts` | runs.create runType guard + REGULAR-only dup check |
| `src/hrm/views/exit.tsx` | SettlementCard gratuity + notice-pay lines |
| `src/hrm/views/payroll.tsx` | adjustment delta explainer |
| `src/hrm/API.md` | runs.create / calculate / pay semantics |
| `tests/unit/r3-1-wave-criticals.test.ts` | **NEW** — 24 tests: pure engine tests + dispatcher/engine integration (needs the unit-test PostgreSQL) |

No schema/migration changes (gratuity config lives in HrSetting JSON;
deltas/status links use existing PayrollEntry columns).

## Verification

- `npx tsc --noEmit` → **0 errors**
- `npx prisma validate` → valid
- `node scripts/check-migrations.mjs` → OK
- ESLint on all changed files → **0 new errors** (remaining hits are the
  project's pre-existing react-hooks / non-null-assertion baseline)
- Pure-function suite (sandbox harness, 54 assertions incl. all engine +
  schema-gate tests above): **54/54 PASS**
- DB-integration tests (PART B: dispatcher-driven exit calculations, engine
  delta runs, runType gates) require the isolated unit-test PostgreSQL —
  run `bun test tests/unit/r3-1-wave-criticals.test.ts` on a machine with
  PostgreSQL (same harness as the existing suite)

## Deferred (by design, later waves)

- EXIT-005 final-salary convention; EXIT-006 loan/advance closure at pay;
  EXIT-007 PF settlement; EXIT-008/010 notice matrix + decided days;
  EXIT-009 clearance gate → Wave R3-2
- PAY-003 bonus-PAID precision; PAY-004 commission SoD + UI; PAY-005 bonus
  preflight; PAY-006 total/aggregate approval → Wave R3-2
