-- ============ 10 — Widen every *Paisa money shadow column INT4 → BIGINT ============
-- 2026-10-13. payroll.calculate failed with:
--   ConnectorError ... ConversionError("Unable to fit integer value '5003650000'
--   into an INT4 (32-bit signed integer).")
-- on prisma.payrollRun.update — totalGrossPaisa = 5,003,650,000 (a ~Tk 50M
-- monthly payroll in paisa) exceeds the PostgreSQL INTEGER ceiling of
-- 2,147,483,647 (~Tk 21.47M). The same ceiling applies to every other paisa
-- shadow column (per-employee totals, salary-structure components), so ALL of
-- them are widened in one migration. INTEGER → BIGINT is a pure widening:
-- values are preserved as-is, no USING cast is required, and every existing
-- writer (paisaOf/structurePaisa/P in the payroll engine) is updated in the
-- same release to emit JS bigint values.
--
-- Read paths: the RPC dispatcher now JSON-encodes bigint as Number (all app
-- paisa values are far below 2^53, so the conversion is lossless).

-- SalaryStructure — per-component paisa shadows
ALTER TABLE "SalaryStructure" ALTER COLUMN "basicPaisa" TYPE BIGINT;
ALTER TABLE "SalaryStructure" ALTER COLUMN "houseRentPaisa" TYPE BIGINT;
ALTER TABLE "SalaryStructure" ALTER COLUMN "medicalPaisa" TYPE BIGINT;
ALTER TABLE "SalaryStructure" ALTER COLUMN "conveyancePaisa" TYPE BIGINT;
ALTER TABLE "SalaryStructure" ALTER COLUMN "foodPaisa" TYPE BIGINT;
ALTER TABLE "SalaryStructure" ALTER COLUMN "mobileAllowPaisa" TYPE BIGINT;
ALTER TABLE "SalaryStructure" ALTER COLUMN "internetAllowPaisa" TYPE BIGINT;
ALTER TABLE "SalaryStructure" ALTER COLUMN "attendanceAllowPaisa" TYPE BIGINT;
ALTER TABLE "SalaryStructure" ALTER COLUMN "otherAllowancePaisa" TYPE BIGINT;
ALTER TABLE "SalaryStructure" ALTER COLUMN "grossPaisa" TYPE BIGINT;

-- PayrollRun — run-total paisa shadows (the columns that overflowed)
ALTER TABLE "PayrollRun" ALTER COLUMN "totalGrossPaisa" TYPE BIGINT;
ALTER TABLE "PayrollRun" ALTER COLUMN "totalOtPaisa" TYPE BIGINT;
ALTER TABLE "PayrollRun" ALTER COLUMN "totalBonusPaisa" TYPE BIGINT;
ALTER TABLE "PayrollRun" ALTER COLUMN "totalDeductionPaisa" TYPE BIGINT;
ALTER TABLE "PayrollRun" ALTER COLUMN "totalAitPaisa" TYPE BIGINT;
ALTER TABLE "PayrollRun" ALTER COLUMN "totalNetPaisa" TYPE BIGINT;

-- PayrollEntry — per-employee paisa shadows
ALTER TABLE "PayrollEntry" ALTER COLUMN "grossPaisa" TYPE BIGINT;
ALTER TABLE "PayrollEntry" ALTER COLUMN "otAmountPaisa" TYPE BIGINT;
ALTER TABLE "PayrollEntry" ALTER COLUMN "bonusPaisa" TYPE BIGINT;
ALTER TABLE "PayrollEntry" ALTER COLUMN "commissionPaisa" TYPE BIGINT;
ALTER TABLE "PayrollEntry" ALTER COLUMN "absenceDeductionPaisa" TYPE BIGINT;
ALTER TABLE "PayrollEntry" ALTER COLUMN "lateDeductionPaisa" TYPE BIGINT;
ALTER TABLE "PayrollEntry" ALTER COLUMN "loanDeductionPaisa" TYPE BIGINT;
ALTER TABLE "PayrollEntry" ALTER COLUMN "advanceDeductionPaisa" TYPE BIGINT;
ALTER TABLE "PayrollEntry" ALTER COLUMN "otherDeductionPaisa" TYPE BIGINT;
ALTER TABLE "PayrollEntry" ALTER COLUMN "aitPaisa" TYPE BIGINT;
ALTER TABLE "PayrollEntry" ALTER COLUMN "netPaisa" TYPE BIGINT;
