-- Phase 4 WS-D — per-tenant usage metering for billing.
-- Additive only: the monthly UsageSnapshot series (billing-grade usage per
-- tenant; the daily platform pass keeps the current month fresh in ONE
-- set-based upsert, and the last write of a month is its frozen record).

-- CreateTable: UsageSnapshot
CREATE TABLE "UsageSnapshot" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "periodYear" INTEGER NOT NULL,
    "periodMonth" INTEGER NOT NULL,
    "employeesTotal" INTEGER NOT NULL DEFAULT 0,
    "employeesPayroll" INTEGER NOT NULL DEFAULT 0,
    "portalUsers" INTEGER NOT NULL DEFAULT 0,
    "devicesEnrolled" INTEGER NOT NULL DEFAULT 0,
    "storageBytes" BIGINT NOT NULL DEFAULT 0,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UsageSnapshot_vendorId_periodYear_periodMonth_key" ON "UsageSnapshot"("vendorId", "periodYear", "periodMonth");
CREATE INDEX "UsageSnapshot_periodYear_periodMonth_idx" ON "UsageSnapshot"("periodYear", "periodMonth");
