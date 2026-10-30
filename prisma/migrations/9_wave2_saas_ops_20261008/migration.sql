-- =====================================================================
-- Wave 2 (2026-10-08) — SaaS operations: payment gateway records (WP-I),
-- backup & DR runs (WP-R), CMS media library 2.0 fields (WP-Q).
-- Additive-only.
-- =====================================================================

-- ================= WP-I — online payment gateway sessions (additive) =================
-- SaasPayment already exists (manual payment records); extend it for gateway
-- checkout sessions. IPN replay protection: one row per provider txn id.
ALTER TABLE "SaaSPayment" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'MANUAL';
ALTER TABLE "SaaSPayment" ADD COLUMN "providerTxnId" TEXT;
ALTER TABLE "SaaSPayment" ADD COLUMN "sessionId" TEXT;
ALTER TABLE "SaaSPayment" ADD COLUMN "failureReason" TEXT;
ALTER TABLE "SaaSPayment" ADD COLUMN "refundedAt" TIMESTAMP;
ALTER TABLE "SaaSPayment" ADD COLUMN "metaJson" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "SaaSPayment" ADD COLUMN "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE UNIQUE INDEX "SaaSPayment_provider_providerTxnId_key" ON "SaaSPayment" ("provider", "providerTxnId");
CREATE INDEX "SaaSPayment_vendorId_status_idx" ON "SaaSPayment" ("vendorId", "status");

-- ================= WP-R — backup & restore-drill run register =================
CREATE TABLE "SaasBackupRun" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'MANUAL',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP,
    "sizeBytes" INTEGER,
    "checksum" TEXT,
    "locationType" TEXT NOT NULL DEFAULT 'LOCAL',
    "locationPath" TEXT,
    "retentionKept" INTEGER,
    "error" TEXT,
    "reportJson" TEXT,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SaasBackupRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SaasBackupRun_type_startedAt_idx" ON "SaasBackupRun" ("type", "startedAt");

-- ================= WP-Q — CMS media library 2.0 (additive fields) =================
ALTER TABLE "SaaSCmsMedia" ADD COLUMN "folder" TEXT NOT NULL DEFAULT '';
ALTER TABLE "SaaSCmsMedia" ADD COLUMN "tags" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "SaaSCmsMedia" ADD COLUMN "alt" TEXT;
ALTER TABLE "SaaSCmsMedia" ADD COLUMN "width" INTEGER;
ALTER TABLE "SaaSCmsMedia" ADD COLUMN "height" INTEGER;
ALTER TABLE "SaaSCmsMedia" ADD COLUMN "sizeBytes" INTEGER;
ALTER TABLE "SaaSCmsMedia" ADD COLUMN "sha256" TEXT;
ALTER TABLE "SaaSCmsMedia" ADD COLUMN "seoFilename" TEXT;
ALTER TABLE "SaaSCmsMedia" ADD COLUMN "variantsJson" TEXT;
CREATE INDEX "SaaSCmsMedia_sha256_idx" ON "SaaSCmsMedia" ("sha256");
CREATE INDEX "SaaSCmsMedia_folder_idx" ON "SaaSCmsMedia" ("folder");
