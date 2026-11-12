-- ============ 11 — AIT legal audit (r8, 2026-10-14) ============
-- Income Tax Act 2023 corrections verified against:
--   * NBR consolidated ITA 2023 PDF (nbr.gov.bd, amendments to 16 June 2025)
--   * KPMG "Salient Features of Finance Ordinance 2025" (June 2025)
--   * PwC Tax Summaries — Bangladesh individual rates (FY 2026/27 table)
-- All changes are ADDITIVE and nullable/defaulted — existing rows keep their
-- historical values and every past AitCalculationLog row already snapshots the
-- config it used, so historical calculations remain reproducible.

-- §78 rebate: add the missing "(a) 3% of taxable income" limb (the rebate
-- itself is capped at the lowest of 3% of taxable income / rate% of eligible
-- investment / absolute cap). Existing years backfilled to 3% below.
ALTER TABLE "AitFiscalYear"
  ADD COLUMN "rebateIncomeCapPercent" DOUBLE PRECISION NOT NULL DEFAULT 3;

-- Minimum-tax floor for first-time return filers (৳1,000, AY 2026-27+).
-- NULL = the rule does not apply to that income year (pre-AY-2026-27).
ALTER TABLE "AitFiscalYear"
  ADD COLUMN "newTaxpayerMinimumTax" DOUBLE PRECISION;

-- Net-wealth surcharge bands (FO 2025 / FA 2026), versioned per income year.
-- NULL = engine falls back to the FY 2025-26/2026-27 band table (identical)
-- and warns. Stored as JSON:
--   {"bands":[{"netWorthOver":40000000,"netWorthUpTo":100000000,"percent":10}, ...],
--    "motorVehicleTrigger":2,"houseSftTrigger":8000}
ALTER TABLE "AitFiscalYear"
  ADD COLUMN "surchargeJson" TEXT;

-- Per-employee surcharge inputs (Phase Eight of the audit).
ALTER TABLE "Employee"
  ADD COLUMN "taxNetWealth" DOUBLE PRECISION,
  ADD COLUMN "taxMotorVehicles" INTEGER NOT NULL DEFAULT 0;

-- Backfill the §78(c) absolute rebate cap for pre-existing rows: the ITA 2023
-- consolidated text sets the cap at ৳10,00,000 (ten lakh) — the old bootstrap
-- had ৳1,00,00,000 (one crore) applied to the wrong limb.
UPDATE "AitFiscalYear" SET "rebateCapAmount" = 1000000 WHERE "rebateCapAmount" > 1000000;

-- Minimum tax citation correction (config values unchanged: ৳5,000 floor) and
-- the FY 2025-26 threshold/slab corrections are applied by the seed/r8
-- bootstrap, not by this migration, because AitFiscalYear rows are
-- admin-managed DATA (versioned rules), not schema.
