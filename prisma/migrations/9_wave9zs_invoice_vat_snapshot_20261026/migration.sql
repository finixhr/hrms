-- AlterTable: Add VAT snapshot columns to SaaSInvoice
ALTER TABLE "SaaSInvoice" ADD COLUMN "vatRatePercent" DECIMAL(5, 2) NOT NULL DEFAULT 5.00;
ALTER TABLE "SaaSInvoice" ADD COLUMN "netAmount" DECIMAL(12, 2) NOT NULL DEFAULT 0.00;
ALTER TABLE "SaaSInvoice" ADD COLUMN "vatAmount" DECIMAL(12, 2) NOT NULL DEFAULT 0.00;

-- Backfill existing rows with 5.00% VAT inclusive calculation
UPDATE "SaaSInvoice"
SET
  "netAmount" = ROUND("amount" / 1.05, 2),
  "vatAmount" = "amount" - ROUND("amount" / 1.05, 2)
WHERE "amount" > 0;
