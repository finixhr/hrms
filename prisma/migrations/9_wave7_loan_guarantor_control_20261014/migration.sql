-- ============ 11 — Loan & Advance guarantor fallback + payroll control ============
-- 2026-10-14. Business rule: a loan/advance installment deducts from the
-- BORROWER's salary; when the borrower has no payable salary in a period
-- (absent the whole period, or off the payroll entirely), the installment
-- moves to the designated GUARANTOR's salary (capped at a % of the
-- guarantor's net pay — Payroll → Loan & Advance Control).
--
-- 1) Advance.guarantorId / guarantorStatus — salary advances get the same
--    guarantor concept loans already have (spec §10.1). Advances are created
--    by HR, so the designation is effective immediately (AGREED); loans keep
--    their ESS consent gate. Nullable + backfill-free: existing rows simply
--    have no guarantor and keep the historical recovery behavior.
-- 2) PayrollEntry.guarantorDeduction (+ paisa shadow) — the amount recovered
--    from THIS employee's salary as a guarantor this period. Separate from
--    loanDeduction/advanceDeduction (the employee's OWN loans) so payRun
--    recovers the right borrower ledgers and payslips itemise the line.
--    The borrower-side detail (loanId/advanceId/installmentId/amount) rides
--    in breakdownJson.guarantorRecoveries; the money path records exact
--    reversal entries in recoveryJson exactly like own-loan recoveries.

ALTER TABLE "Advance" ADD COLUMN "guarantorId" TEXT;
ALTER TABLE "Advance" ADD COLUMN "guarantorStatus" TEXT;
CREATE INDEX "Advance_vendorId_guarantorId_guarantorStatus_idx" ON "Advance"("vendorId", "guarantorId", "guarantorStatus");

ALTER TABLE "PayrollEntry" ADD COLUMN "guarantorDeduction" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "PayrollEntry" ADD COLUMN "guarantorDeductionPaisa" BIGINT;
