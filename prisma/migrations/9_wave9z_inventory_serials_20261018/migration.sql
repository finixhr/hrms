-- =====================================================================
-- Wave 10 (2026-10-18) — inventory serial tracking + schema-drift repair
-- (Re-audit 2026-10-18 remediation: P1-2 missing inventory migration)
--
-- PART 1 — Inventory serial tracking. The merged-state schema.prisma
-- already models the inventory-serial feature (routes + views read/write
-- these columns), but NO migration was ever authored: every fresh database
-- (and any production database deployed via `prisma migrate deploy`) was
-- missing 6 Item columns, 5 StockEntryItem columns and the entire
-- ItemCategory / ItemUnit / InventoryItemSerial tables (P2021/P2022 at
-- runtime). Additive-only; plain String columns follow the H-10 vendor-
-- scoping convention (no cross-table FKs on purpose).
--
-- PART 2 — Timestamp precision normalization (re-audit P3 drift class).
-- The hand-authored wave-2/3/4 migrations created several tables with
-- bare `TIMESTAMP` columns while the Prisma schema maps DateTime to
-- TIMESTAMP(3). `prisma migrate diff` (migrations -> schema) therefore
-- reported a standing drift on ~25 tables, which would have made the new
-- CI schema-drift gate (scripts/check-schema-drift.ts) permanently red.
-- These ALTERs are catalog-only typmod changes on 8-byte timestamps
-- (no table rewrite, no data change, no semantic difference beyond
-- millisecond display precision) and bring the migration chain to
-- ZERO drift against schema.prisma.
--
-- NAMING NOTE: the directory is 9_wave9z_ (not 10_): lexicographic
-- apply order requires sorting AFTER the 9_wave9_ tip, and multi-digit
-- prefixes (10_) are rejected by scripts/check-migrations.mjs (the P3018
-- fresh-database ordering bug). "wave9z" = the wave-10 content under the
-- exhausted single-digit prefix space.
-- =====================================================================

-- ================= PART 1 — inventory serial tracking =================
-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "brandModel" TEXT,
ADD COLUMN     "hasWarranty" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isReturnable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "purchaseDate" TEXT,
ADD COLUMN     "serialImei" TEXT,
ADD COLUMN     "warrantyExpiry" TEXT;

-- AlterTable
ALTER TABLE "StockEntryItem" ADD COLUMN     "brandModel" TEXT,
ADD COLUMN     "serialNumbers" TEXT,
ADD COLUMN     "warrantyExpiry" TEXT,
ADD COLUMN     "warrantyUnit" TEXT,
ADD COLUMN     "warrantyValue" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "ItemCategory" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ItemCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemUnit" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ItemUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryItemSerial" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "warehouseId" TEXT,
    "stockEntryId" TEXT,
    "serialNumber" TEXT NOT NULL,
    "brandModel" TEXT,
    "warrantyValue" DOUBLE PRECISION,
    "warrantyUnit" TEXT,
    "warrantyExpiry" TEXT,
    "purchaseDate" TEXT,
    "unitCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "assetId" TEXT,
    "employeeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryItemSerial_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ItemCategory_vendorId_idx" ON "ItemCategory"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "ItemCategory_vendorId_name_key" ON "ItemCategory"("vendorId", "name");

-- CreateIndex
CREATE INDEX "ItemUnit_vendorId_idx" ON "ItemUnit"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "ItemUnit_vendorId_name_key" ON "ItemUnit"("vendorId", "name");

-- CreateIndex
CREATE INDEX "InventoryItemSerial_vendorId_itemId_status_idx" ON "InventoryItemSerial"("vendorId", "itemId", "status");

-- CreateIndex
CREATE INDEX "InventoryItemSerial_vendorId_status_idx" ON "InventoryItemSerial"("vendorId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryItemSerial_vendorId_itemId_serialNumber_key" ON "InventoryItemSerial"("vendorId", "itemId", "serialNumber");

-- ============ PART 2 — timestamp(3) precision normalization ============
-- AlterTable
ALTER TABLE "AccountJournal" ALTER COLUMN "approvedAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "AccountingPeriod" ALTER COLUMN "closedAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ApiKey" ALTER COLUMN "lastUsedAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "revokedAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Asset" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "AssetAssignment" ALTER COLUMN "assignedAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "dueAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "returnedAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "AssetEvent" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "BgJob" ALTER COLUMN "scheduledFor" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "cancelledAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "lastErrorAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Budget" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "CostCenter" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "JobApplication" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "JobInterview" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "JobOpening" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "OfferLetter" ALTER COLUMN "sentAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "decidedAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "OnboardingTask" ALTER COLUMN "doneAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PayrollRun" ALTER COLUMN "payoutConfirmedAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "cancelledAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ReportDeliveryLog" ALTER COLUMN "startedAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ReportTemplate" ALTER COLUMN "lastRunAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SaaSPayment" ALTER COLUMN "refundedAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SaasBackupRun" ALTER COLUMN "startedAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "finishedAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SaasPlanChangeRequest" ALTER COLUMN "decidedAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Visit" ALTER COLUMN "checkInAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "checkOutAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "VisitLocation" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "VisitPlan" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "VisitPlanItem" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "WebhookDelivery" ALTER COLUMN "nextAttemptAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "deliveredAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "WebhookEndpoint" ALTER COLUMN "lastDeliveredAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3);
