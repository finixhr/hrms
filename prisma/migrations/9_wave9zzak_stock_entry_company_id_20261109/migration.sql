-- MULTI-COMPANY (2026-11-09) — add companyId to StockEntry so inventory
-- stock entries are properly scoped to the active company in multi-company
-- tenants. Nullable + no-action on delete matches the GoodsRequisition /
-- PurchaseRequest pattern used throughout the procurement module.

ALTER TABLE "StockEntry" ADD COLUMN "companyId" TEXT;

-- Backfill: assign every existing StockEntry to the vendor's default company
-- (the same strategy used for GoodsRequisition / PurchaseRequest in migration
-- 9_wave9zy). Single-company tenants have exactly one default company so this
-- is deterministic; multi-company tenants haven't had stock entries yet.
UPDATE "StockEntry" se
SET "companyId" = c.id
FROM "Company" c
WHERE c."vendorId" = se."vendorId"
  AND c."isDefault" = true
  AND se."companyId" IS NULL;

-- FK constraint (Restrict — cannot delete a company that owns stock entries)
ALTER TABLE "StockEntry"
  ADD CONSTRAINT "StockEntry_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Index to support company-scoped list queries
CREATE INDEX "StockEntry_companyId_idx" ON "StockEntry"("companyId");
