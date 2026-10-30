-- Phase R3 / LVE-107 — gender-restricted leave eligibility.
-- Additive only: one nullable column; null (the default) = no restriction,
-- so every existing leave type keeps its exact current behavior.
ALTER TABLE "LeaveType" ADD COLUMN "genderRestriction" TEXT;

-- Backfill the statutory types so the gate is real from day one:
-- maternity leave is FEMALE-only, paternity leave is MALE-only (BLA structure).
UPDATE "LeaveType" SET "genderRestriction" = 'FEMALE' WHERE "code" IN ('MATERNITY', 'MAT', 'ML');
UPDATE "LeaveType" SET "genderRestriction" = 'MALE' WHERE "code" IN ('PATERNITY', 'PAT', 'PL');
