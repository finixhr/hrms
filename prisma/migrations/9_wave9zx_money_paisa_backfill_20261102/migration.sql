-- Phase 4 (FIN-082 structural fix) — the Float→paisa money storage collapse,
-- step 1: backfill every NULL integer-paisa shadow from its Float column.
--
-- Context: since H-09/H-8 money is dual-written (Float column + lossless
-- integer paisa shadow, <field>Paisa = ROUND(<field> * 100)). Rows written
-- before the dual-write helpers existed (and the dev seed's historical bulk
-- corpus) carry NULL paisa columns — the FIN-082 nightly reconciliation
-- honestly reported them as "unbackfilled". Phase 4 makes the paisa side the
-- SINGLE AUTHORITATIVE source for reads and repairs, which requires the
-- shadows to be complete first. This migration is the one-time completion:
--
--   · every NULL <field>Paisa with a non-NULL <field> becomes
--     ROUND(<field>::numeric * 100) — exactly the paisaOf() convention
--     pinned by tests/unit/h09-paisa-golden.test.ts
--   · rows where BOTH sides are NULL stay NULL (a genuinely absent amount)
--   · no DDL, no schema.prisma change (the paisa columns stay optional at
--     the Prisma level so test fixtures and third-party tooling that write
--     Float-only rows keep working — the nightly enforcer in
--     jobs.ts reconcileFloatPaisa self-heals anything they write)
--   · idempotent: re-running matches zero rows
--
-- The ROUND is computed in NUMERIC (not float8) so the cast is exact: the
-- double-precision expansion of e.g. 1234.56 → 123455.9999… rounds to the
-- same integer JS Math.round produces (paisaOf), for every |value| < 2^53/100.
-- NOTE: this file keeps semicolons OUT of comment text so naive statement
-- splitters (including ops runbooks) chunk it correctly.

-- 1) SalaryStructure — the 10 component fields + gross (11 shadows)
UPDATE "SalaryStructure" SET "basicPaisa"           = ROUND("basic"::numeric * 100)           WHERE "basicPaisa" IS NULL AND "basic" IS NOT NULL;
UPDATE "SalaryStructure" SET "houseRentPaisa"       = ROUND("houseRent"::numeric * 100)       WHERE "houseRentPaisa" IS NULL AND "houseRent" IS NOT NULL;
UPDATE "SalaryStructure" SET "medicalPaisa"         = ROUND("medical"::numeric * 100)         WHERE "medicalPaisa" IS NULL AND "medical" IS NOT NULL;
UPDATE "SalaryStructure" SET "conveyancePaisa"      = ROUND("conveyance"::numeric * 100)      WHERE "conveyancePaisa" IS NULL AND "conveyance" IS NOT NULL;
UPDATE "SalaryStructure" SET "foodPaisa"            = ROUND("food"::numeric * 100)            WHERE "foodPaisa" IS NULL AND "food" IS NOT NULL;
UPDATE "SalaryStructure" SET "mobileAllowPaisa"     = ROUND("mobileAllow"::numeric * 100)     WHERE "mobileAllowPaisa" IS NULL AND "mobileAllow" IS NOT NULL;
UPDATE "SalaryStructure" SET "internetAllowPaisa"   = ROUND("internetAllow"::numeric * 100)   WHERE "internetAllowPaisa" IS NULL AND "internetAllow" IS NOT NULL;
UPDATE "SalaryStructure" SET "attendanceAllowPaisa" = ROUND("attendanceAllow"::numeric * 100) WHERE "attendanceAllowPaisa" IS NULL AND "attendanceAllow" IS NOT NULL;
UPDATE "SalaryStructure" SET "otherAllowancePaisa"  = ROUND("otherAllowance"::numeric * 100)  WHERE "otherAllowancePaisa" IS NULL AND "otherAllowance" IS NOT NULL;
UPDATE "SalaryStructure" SET "grossPaisa"           = ROUND("gross"::numeric * 100)           WHERE "grossPaisa" IS NULL AND "gross" IS NOT NULL;

-- 2) PayrollEntry — the 12 per-entry money fields
UPDATE "PayrollEntry" SET "grossPaisa"            = ROUND("gross"::numeric * 100)            WHERE "grossPaisa" IS NULL AND "gross" IS NOT NULL;
UPDATE "PayrollEntry" SET "otAmountPaisa"         = ROUND("otAmount"::numeric * 100)         WHERE "otAmountPaisa" IS NULL AND "otAmount" IS NOT NULL;
UPDATE "PayrollEntry" SET "bonusPaisa"            = ROUND("bonus"::numeric * 100)            WHERE "bonusPaisa" IS NULL AND "bonus" IS NOT NULL;
UPDATE "PayrollEntry" SET "commissionPaisa"       = ROUND("commission"::numeric * 100)       WHERE "commissionPaisa" IS NULL AND "commission" IS NOT NULL;
UPDATE "PayrollEntry" SET "absenceDeductionPaisa" = ROUND("absenceDeduction"::numeric * 100) WHERE "absenceDeductionPaisa" IS NULL AND "absenceDeduction" IS NOT NULL;
UPDATE "PayrollEntry" SET "lateDeductionPaisa"    = ROUND("lateDeduction"::numeric * 100)    WHERE "lateDeductionPaisa" IS NULL AND "lateDeduction" IS NOT NULL;
UPDATE "PayrollEntry" SET "loanDeductionPaisa"    = ROUND("loanDeduction"::numeric * 100)    WHERE "loanDeductionPaisa" IS NULL AND "loanDeduction" IS NOT NULL;
UPDATE "PayrollEntry" SET "advanceDeductionPaisa"  = ROUND("advanceDeduction"::numeric * 100) WHERE "advanceDeductionPaisa" IS NULL AND "advanceDeduction" IS NOT NULL;
UPDATE "PayrollEntry" SET "otherDeductionPaisa"   = ROUND("otherDeduction"::numeric * 100)   WHERE "otherDeductionPaisa" IS NULL AND "otherDeduction" IS NOT NULL;
UPDATE "PayrollEntry" SET "guarantorDeductionPaisa" = ROUND("guarantorDeduction"::numeric * 100) WHERE "guarantorDeductionPaisa" IS NULL AND "guarantorDeduction" IS NOT NULL;
UPDATE "PayrollEntry" SET "aitPaisa"              = ROUND("ait"::numeric * 100)              WHERE "aitPaisa" IS NULL AND "ait" IS NOT NULL;
UPDATE "PayrollEntry" SET "netPaisa"              = ROUND("net"::numeric * 100)              WHERE "netPaisa" IS NULL AND "net" IS NOT NULL;

-- 3) PayrollRun — the 6 run totals
UPDATE "PayrollRun" SET "totalGrossPaisa"     = ROUND("totalGross"::numeric * 100)     WHERE "totalGrossPaisa" IS NULL AND "totalGross" IS NOT NULL;
UPDATE "PayrollRun" SET "totalOtPaisa"        = ROUND("totalOt"::numeric * 100)        WHERE "totalOtPaisa" IS NULL AND "totalOt" IS NOT NULL;
UPDATE "PayrollRun" SET "totalBonusPaisa"     = ROUND("totalBonus"::numeric * 100)     WHERE "totalBonusPaisa" IS NULL AND "totalBonus" IS NOT NULL;
UPDATE "PayrollRun" SET "totalDeductionPaisa" = ROUND("totalDeduction"::numeric * 100) WHERE "totalDeductionPaisa" IS NULL AND "totalDeduction" IS NOT NULL;
UPDATE "PayrollRun" SET "totalAitPaisa"       = ROUND("totalAit"::numeric * 100)       WHERE "totalAitPaisa" IS NULL AND "totalAit" IS NOT NULL;
UPDATE "PayrollRun" SET "totalNetPaisa"       = ROUND("totalNet"::numeric * 100)       WHERE "totalNetPaisa" IS NULL AND "totalNet" IS NOT NULL;
