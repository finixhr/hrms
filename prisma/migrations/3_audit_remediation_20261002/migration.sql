-- ============ Audit remediation round (Phases 3-4) — 2026-10-02 ============
-- M-6  : identity uniques backing the app-level employee dedup
-- M-13 : payslip numbers unique per vendor (with historical renumbering)
--
-- ⚠ BEFORE DEPLOYING: this migration FAILS LOUDLY if your Employee data
--   already contains duplicate (vendorId, officialEmail) or (vendorId, mobile)
--   pairs — that is deliberate (silently skipping the constraint would
--   recreate the finding). Check first and fix any duplicates:
--     bun run scripts/check-employee-identity-uniques.ts
--   (dry-run report only; tells you exactly which rows collide.)

-- ---- M-13 step 1: renumber duplicate payslip numbers --------------------
-- Multiple runs of one period used to mint the same number (per-run counter).
-- Keep the FIRST occurrence verbatim; later duplicates get a -Rn suffix so the
-- unique index below can exist and future numbers (which now carry a run
-- discriminator) never collide. Idempotent: a second run finds no duplicates.
--
-- ORDER BY "id" only: PayrollEntry has NO createdAt column (audit follow-up
-- 2026-10-03 — the original draft ordered by "createdAt" and failed with
-- SQLSTATE 42703 on every fresh database: P3009 at the customer). Prisma
-- cuid() ids are timestamp-prefixed and lexicographically monotonic, so
-- "lowest id" preserves the "first occurrence" semantics deterministically.
UPDATE "PayrollEntry" pe
SET "payslipNumber" = pe."payslipNumber" || '-R' || dupe.rn
FROM (
  SELECT "id", ROW_NUMBER() OVER (
    PARTITION BY "vendorId", "payslipNumber"
    ORDER BY "id"
  ) AS rn
  FROM "PayrollEntry"
  WHERE "payslipNumber" IS NOT NULL
) dupe
WHERE pe."id" = dupe."id" AND dupe.rn > 1;

-- ---- M-13 step 2: unique payslip number per vendor ----------------------
-- NULL payslipNumbers (excluded/manual entries) are exempt (NULLs distinct).
CREATE UNIQUE INDEX "PayrollEntry_vendorId_payslipNumber_key"
  ON "PayrollEntry"("vendorId", "payslipNumber");

-- ---- M-6: identity uniques on Employee ----------------------------------
-- Backs the dedup the bulk importer and the manual create path already
-- perform at the application level; closes the check-then-create race.
-- Empty strings are normalized to NULL by both write paths, and PostgreSQL
-- treats NULLs as distinct, so employees without a mobile/email are exempt.
CREATE UNIQUE INDEX "Employee_vendorId_officialEmail_key"
  ON "Employee"("vendorId", "officialEmail");
CREATE UNIQUE INDEX "Employee_vendorId_mobile_key"
  ON "Employee"("vendorId", "mobile");
