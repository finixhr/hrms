-- FIN-020 (Phase 3) — the inventory/procurement/assets periphery joins the
-- paisa integer system (the audit's "~20 money-semantics fields remain Float,
-- outside the paisa integer system"; roadmap: "Paisa-ize peripheral money
-- fields (inventory costs first)"). Same convention as the core chain
-- (9_wave9zzaj): every Float money column keeps its representation and is
-- shadowed by a lossless BigInt *Paisa column, backfilled here once, stamped
-- by every writer from now on (money.ts stampPaisa) and preferred by the GL
-- cost-basis math (accounting.ts). Idempotent: the backfills replay as no-ops.

-- ---- Item ----
ALTER TABLE "Item" ADD COLUMN "lastCostPaisa" BIGINT;
UPDATE "Item" SET "lastCostPaisa" = ROUND("lastCost" * 100) WHERE "lastCostPaisa" IS NULL AND "lastCost" IS NOT NULL;

-- ---- StockTransaction ----
ALTER TABLE "StockTransaction" ADD COLUMN "unitCostPaisa" BIGINT;
UPDATE "StockTransaction" SET "unitCostPaisa" = ROUND("unitCost" * 100) WHERE "unitCostPaisa" IS NULL AND "unitCost" IS NOT NULL;

-- ---- StockEntryItem ----
ALTER TABLE "StockEntryItem" ADD COLUMN "unitCostPaisa" BIGINT;
ALTER TABLE "StockEntryItem" ADD COLUMN "warrantyValuePaisa" BIGINT;
UPDATE "StockEntryItem" SET "unitCostPaisa" = ROUND("unitCost" * 100) WHERE "unitCostPaisa" IS NULL AND "unitCost" IS NOT NULL;
UPDATE "StockEntryItem" SET "warrantyValuePaisa" = ROUND("warrantyValue" * 100) WHERE "warrantyValuePaisa" IS NULL AND "warrantyValue" IS NOT NULL;

-- ---- InventoryItemSerial ----
ALTER TABLE "InventoryItemSerial" ADD COLUMN "unitCostPaisa" BIGINT;
ALTER TABLE "InventoryItemSerial" ADD COLUMN "warrantyValuePaisa" BIGINT;
UPDATE "InventoryItemSerial" SET "unitCostPaisa" = ROUND("unitCost" * 100) WHERE "unitCostPaisa" IS NULL AND "unitCost" IS NOT NULL;
UPDATE "InventoryItemSerial" SET "warrantyValuePaisa" = ROUND("warrantyValue" * 100) WHERE "warrantyValuePaisa" IS NULL AND "warrantyValue" IS NOT NULL;

-- ---- PurchaseRequest / items ----
ALTER TABLE "PurchaseRequest" ADD COLUMN "totalValuePaisa" BIGINT;
UPDATE "PurchaseRequest" SET "totalValuePaisa" = ROUND("totalValue" * 100) WHERE "totalValuePaisa" IS NULL AND "totalValue" IS NOT NULL;
ALTER TABLE "PurchaseRequestItem" ADD COLUMN "estimatedUnitPricePaisa" BIGINT;
UPDATE "PurchaseRequestItem" SET "estimatedUnitPricePaisa" = ROUND("estimatedUnitPrice" * 100) WHERE "estimatedUnitPricePaisa" IS NULL AND "estimatedUnitPrice" IS NOT NULL;

-- ---- PurchaseQuotation / items ----
ALTER TABLE "PurchaseQuotation" ADD COLUMN "totalPaisa" BIGINT;
ALTER TABLE "PurchaseQuotation" ADD COLUMN "deliveryChargePaisa" BIGINT;
UPDATE "PurchaseQuotation" SET "totalPaisa" = ROUND("total" * 100) WHERE "totalPaisa" IS NULL AND "total" IS NOT NULL;
UPDATE "PurchaseQuotation" SET "deliveryChargePaisa" = ROUND("deliveryCharge" * 100) WHERE "deliveryChargePaisa" IS NULL AND "deliveryCharge" IS NOT NULL;
ALTER TABLE "PurchaseQuotationItem" ADD COLUMN "unitPricePaisa" BIGINT;
ALTER TABLE "PurchaseQuotationItem" ADD COLUMN "discountPaisa" BIGINT;
ALTER TABLE "PurchaseQuotationItem" ADD COLUMN "vatTaxPaisa" BIGINT;
UPDATE "PurchaseQuotationItem" SET "unitPricePaisa" = ROUND("unitPrice" * 100) WHERE "unitPricePaisa" IS NULL AND "unitPrice" IS NOT NULL;
UPDATE "PurchaseQuotationItem" SET "discountPaisa" = ROUND("discount" * 100) WHERE "discountPaisa" IS NULL AND "discount" IS NOT NULL;
UPDATE "PurchaseQuotationItem" SET "vatTaxPaisa" = ROUND("vatTax" * 100) WHERE "vatTaxPaisa" IS NULL AND "vatTax" IS NOT NULL;

-- ---- Asset ----
ALTER TABLE "Asset" ADD COLUMN "purchaseCostPaisa" BIGINT;
UPDATE "Asset" SET "purchaseCostPaisa" = ROUND("purchaseCost" * 100) WHERE "purchaseCostPaisa" IS NULL AND "purchaseCost" IS NOT NULL;
