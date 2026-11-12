-- FORENSIC AUDIT 2026-11-10, FIN-012 (Phase 1): the inventory transfer path
-- documented a "DB constraint" that catches negative stock after a TOCTOU
-- double-spend — but no such constraint ever existed (the schema has no CHECK,
-- and no migration added one). This migration establishes the real backstop:
--
--   1. DATA REPAIR FIRST: clamp any existing negative quantities/reserved to
--      0 (a negative StockLevel row is bookkeeping damage from the race this
--      migration closes; keeping it would make the constraint un-addable and
--      every later movement wrong). The repair is idempotent.
--   2. CHECK constraints: quantity >= 0 and reserved >= 0 on "StockLevel".
--      Application-level conditional updates (inventory.ts transfers) remain
--      the primary, user-friendly guard; this is the database-level last line
--      of defense for every OTHER current or future writer.
--
-- Prisma's schema DSL cannot express CHECK constraints, so this constraint
-- lives only in SQL migrations — `prisma db push` (used by the unit-test
-- bootstrap) does NOT create it; `prisma migrate deploy` (the release path,
-- verified by check-release-artifact + the container entrypoint) does. The
-- regression tests for FIN-012 therefore assert the CONDITIONAL-UPDATE
-- semantics (which hold on both paths), not the constraint itself.

-- 1. repair pre-existing negatives (idempotent)
UPDATE "StockLevel" SET "quantity" = 0 WHERE "quantity" < 0;
UPDATE "StockLevel" SET "reserved" = 0 WHERE "reserved" < 0;

-- 2. the constraints
ALTER TABLE "StockLevel" ADD CONSTRAINT "stock_level_quantity_nonneg" CHECK ("quantity" >= 0) NOT VALID;
ALTER TABLE "StockLevel" ADD CONSTRAINT "stock_level_reserved_nonneg" CHECK ("reserved" >= 0) NOT VALID;

-- NOT VALID above means existing rows were not re-scanned inside the lock;
-- validate them now (the repair in step 1 guarantees they pass).
ALTER TABLE "StockLevel" VALIDATE CONSTRAINT "stock_level_quantity_nonneg";
ALTER TABLE "StockLevel" VALIDATE CONSTRAINT "stock_level_reserved_nonneg";
