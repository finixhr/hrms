-- =====================================================================
-- Wave 4 (2026-10-08) — WP-A: saved report templates + scheduled email
-- delivery. ReportTemplate = a pinned report key + filters + schedule +
-- recipients; ReportDeliveryLog records every automated send (SENT/FAILED/
-- SKIPPED — same contract as the gateway). Plain String FK columns, H-10
-- vendor scoping via composite indexes. Sorts after 9_wave3_b_… by design
-- (wave3 < wave4 lexicographically under every collation).
-- =====================================================================

CREATE TABLE "ReportTemplate" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "reportKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filtersJson" TEXT NOT NULL DEFAULT '{}',
    "format" TEXT NOT NULL DEFAULT 'XLSX',
    "schedule" TEXT NOT NULL DEFAULT 'OFF',
    "recipientsJson" TEXT NOT NULL DEFAULT '[]',
    "lastRunAt" TIMESTAMP,
    "lastStatus" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReportTemplate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ReportTemplate_vendorId_name_key" ON "ReportTemplate" ("vendorId", "name");
CREATE INDEX "ReportTemplate_vendorId_active_idx" ON "ReportTemplate" ("vendorId", "active");
CREATE INDEX "ReportTemplate_vendorId_schedule_idx" ON "ReportTemplate" ("vendorId", "schedule");

CREATE TABLE "ReportDeliveryLog" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "templateName" TEXT NOT NULL,
    "reportKey" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "detail" TEXT,
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "rows" INTEGER,
    "startedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReportDeliveryLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ReportDeliveryLog_vendorId_startedAt_idx" ON "ReportDeliveryLog" ("vendorId", "startedAt");
CREATE INDEX "ReportDeliveryLog_vendorId_templateId_idx" ON "ReportDeliveryLog" ("vendorId", "templateId");
