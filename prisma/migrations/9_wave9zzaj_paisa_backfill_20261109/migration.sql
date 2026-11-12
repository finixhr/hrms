-- DBD-1 (P2 wave, 2026-11-09) — complete the paisa migration's DATA phase:
-- every legacy row that predates the H-09 dual-write engine gets its paisa
-- shadows backfilled from the Float columns (the same repair rule the nightly
-- reconcileFloatPaisa job applies, now applied once at migration time so the
-- migration chain delivers paisa-complete databases). Idempotent: the WHERE
-- clauses make replays no-ops.
--
-- After this migration every row of SalaryStructure / PayrollRun /
-- PayrollEntry carries authoritative paisa; withAuthoritativeMoney reads and
-- the nightly invariant enforcer then hold the invariant. The NOT NULL
-- constraint flip (and Float retirement) is the documented follow-up: it
-- requires migrating ~150 direct legacy writers first (see the P2 report).

-- ---- SalaryStructure (10 pairs) ----
UPDATE "SalaryStructure" SET "basicPaisa" = ROUND("basic" * 100) WHERE "basicPaisa" IS NULL AND "basic" IS NOT NULL;
UPDATE "SalaryStructure" SET "houseRentPaisa" = ROUND("houseRent" * 100) WHERE "houseRentPaisa" IS NULL AND "houseRent" IS NOT NULL;
UPDATE "SalaryStructure" SET "medicalPaisa" = ROUND("medical" * 100) WHERE "medicalPaisa" IS NULL AND "medical" IS NOT NULL;
UPDATE "SalaryStructure" SET "conveyancePaisa" = ROUND("conveyance" * 100) WHERE "conveyancePaisa" IS NULL AND "conveyance" IS NOT NULL;
UPDATE "SalaryStructure" SET "foodPaisa" = ROUND("food" * 100) WHERE "foodPaisa" IS NULL AND "food" IS NOT NULL;
UPDATE "SalaryStructure" SET "mobileAllowPaisa" = ROUND("mobileAllow" * 100) WHERE "mobileAllowPaisa" IS NULL AND "mobileAllow" IS NOT NULL;
UPDATE "SalaryStructure" SET "internetAllowPaisa" = ROUND("internetAllow" * 100) WHERE "internetAllowPaisa" IS NULL AND "internetAllow" IS NOT NULL;
UPDATE "SalaryStructure" SET "attendanceAllowPaisa" = ROUND("attendanceAllow" * 100) WHERE "attendanceAllowPaisa" IS NULL AND "attendanceAllow" IS NOT NULL;
UPDATE "SalaryStructure" SET "otherAllowancePaisa" = ROUND("otherAllowance" * 100) WHERE "otherAllowancePaisa" IS NULL AND "otherAllowance" IS NOT NULL;
UPDATE "SalaryStructure" SET "grossPaisa" = ROUND("gross" * 100) WHERE "grossPaisa" IS NULL AND "gross" IS NOT NULL;

-- ---- PayrollRun (6 pairs) ----
UPDATE "PayrollRun" SET "totalGrossPaisa" = ROUND("totalGross" * 100) WHERE "totalGrossPaisa" IS NULL AND "totalGross" IS NOT NULL;
UPDATE "PayrollRun" SET "totalOtPaisa" = ROUND("totalOt" * 100) WHERE "totalOtPaisa" IS NULL AND "totalOt" IS NOT NULL;
UPDATE "PayrollRun" SET "totalBonusPaisa" = ROUND("totalBonus" * 100) WHERE "totalBonusPaisa" IS NULL AND "totalBonus" IS NOT NULL;
UPDATE "PayrollRun" SET "totalDeductionPaisa" = ROUND("totalDeduction" * 100) WHERE "totalDeductionPaisa" IS NULL AND "totalDeduction" IS NOT NULL;
UPDATE "PayrollRun" SET "totalAitPaisa" = ROUND("totalAit" * 100) WHERE "totalAitPaisa" IS NULL AND "totalAit" IS NOT NULL;
UPDATE "PayrollRun" SET "totalNetPaisa" = ROUND("totalNet" * 100) WHERE "totalNetPaisa" IS NULL AND "totalNet" IS NOT NULL;

-- ---- PayrollEntry (12 pairs) ----
UPDATE "PayrollEntry" SET "grossPaisa" = ROUND("gross" * 100) WHERE "grossPaisa" IS NULL AND "gross" IS NOT NULL;
UPDATE "PayrollEntry" SET "otAmountPaisa" = ROUND("otAmount" * 100) WHERE "otAmountPaisa" IS NULL AND "otAmount" IS NOT NULL;
UPDATE "PayrollEntry" SET "bonusPaisa" = ROUND("bonus" * 100) WHERE "bonusPaisa" IS NULL AND "bonus" IS NOT NULL;
UPDATE "PayrollEntry" SET "commissionPaisa" = ROUND("commission" * 100) WHERE "commissionPaisa" IS NULL AND "commission" IS NOT NULL;
UPDATE "PayrollEntry" SET "absenceDeductionPaisa" = ROUND("absenceDeduction" * 100) WHERE "absenceDeductionPaisa" IS NULL AND "absenceDeduction" IS NOT NULL;
UPDATE "PayrollEntry" SET "lateDeductionPaisa" = ROUND("lateDeduction" * 100) WHERE "lateDeductionPaisa" IS NULL AND "lateDeduction" IS NOT NULL;
UPDATE "PayrollEntry" SET "loanDeductionPaisa" = ROUND("loanDeduction" * 100) WHERE "loanDeductionPaisa" IS NULL AND "loanDeduction" IS NOT NULL;
UPDATE "PayrollEntry" SET "advanceDeductionPaisa" = ROUND("advanceDeduction" * 100) WHERE "advanceDeductionPaisa" IS NULL AND "advanceDeduction" IS NOT NULL;
UPDATE "PayrollEntry" SET "otherDeductionPaisa" = ROUND("otherDeduction" * 100) WHERE "otherDeductionPaisa" IS NULL AND "otherDeduction" IS NOT NULL;
UPDATE "PayrollEntry" SET "guarantorDeductionPaisa" = ROUND("guarantorDeduction" * 100) WHERE "guarantorDeductionPaisa" IS NULL AND "guarantorDeduction" IS NOT NULL;
UPDATE "PayrollEntry" SET "aitPaisa" = ROUND("ait" * 100) WHERE "aitPaisa" IS NULL AND "ait" IS NOT NULL;
UPDATE "PayrollEntry" SET "netPaisa" = ROUND("net" * 100) WHERE "netPaisa" IS NULL AND "net" IS NOT NULL;
