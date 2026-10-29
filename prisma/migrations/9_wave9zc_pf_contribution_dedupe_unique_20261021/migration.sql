-- MON-3 (Phase 1) — PfContribution import idempotency.
--
-- PF import (pf.import.execute) previously inserted one row per CSV line with
-- no idempotency key and no transaction: a retry after a partial failure, or a
-- double upload, duplicated every row — and because exit settlement PF payout
-- sums ALL contribution rows, duplicates converted directly into overpayment
-- at an employee's exit (real money, wrong direction).
--
-- The new unique key is (vendorId, employeeId, periodYear, periodMonth,
-- source, noteHash). A plain `note` column cannot back a unique constraint in
-- Postgres (NULLs are distinct, and multiple rows legitimately carry the same
-- text), so a computed noteHash column is introduced:
--   noteHash = sha256(note)                    — MANUAL / OPENING / WITHDRAWAL
--   noteHash = sha256(note || '|run:' || runId) — PAYROLL (the multiple weekly
--               runs of one month each write their own row; folding the runId
--               in keeps them from colliding on the identical note text)
--
-- Order of operations (a later step depends on every earlier one):
--   1. ADD COLUMN noteHash (default '' so the NOT NULL add is instant)
--   2. backfill noteHash from each row's note/runId (Postgres 13+ built-in
--      sha256; bit-for-bit the same digest src/hrm-server/pf-import.ts
--      pfNoteHash() computes)
--   3. dedupe: for every (vendor, employee, period, source, noteHash) group,
--      keep the EARLIEST createdAt row and delete the rest (this is the
--      "backfill dedupe first" prerequisite — the unique index cannot be
--      created on top of duplicates)
--   4. CREATE UNIQUE INDEX with the exact name Prisma generates for the
--      @@unique directive, so `prisma migrate diff` sees no drift.

-- 1) column
ALTER TABLE "PfContribution" ADD COLUMN "noteHash" TEXT NOT NULL DEFAULT '';

-- 2) backfill
UPDATE "PfContribution" SET "noteHash" = CASE
  WHEN "source" = 'PAYROLL'
    THEN encode(sha256((COALESCE("note", '') || '|run:' || COALESCE("runId", ''))::bytea), 'hex')
  ELSE encode(sha256(COALESCE("note", '')::bytea), 'hex')
END;

-- 3) dedupe (keep the earliest row per new-unique group; deterministic
--    id tiebreak so the deleted set is stable across replays)
DELETE FROM "PfContribution" dup
USING "PfContribution" keep
WHERE dup."id" <> keep."id"
  AND dup."vendorId" = keep."vendorId"
  AND dup."employeeId" = keep."employeeId"
  AND dup."periodYear" = keep."periodYear"
  AND dup."periodMonth" = keep."periodMonth"
  AND dup."source" = keep."source"
  AND dup."noteHash" = keep."noteHash"
  AND (dup."createdAt" > keep."createdAt"
       OR (dup."createdAt" = keep."createdAt" AND dup."id" > keep."id"));

-- 4) unique index. NOTE: the fully-expanded Prisma name
--    (PfContribution_vendorId_employeeId_periodYear_periodMonth_source_
--    noteHash_key) exceeds PostgreSQL's 63-char identifier limit, so PG would
--    silently truncate it to a DIFFERENT name than `prisma migrate diff`
--    expects (schema-drift gate). Use Prisma's own truncated form verbatim —
--    it is what the generator produces for this @@unique.
CREATE UNIQUE INDEX "PfContribution_vendorId_employeeId_periodYear_periodMonth_s_key"
  ON "PfContribution"("vendorId", "employeeId", "periodYear", "periodMonth", "source", "noteHash");
