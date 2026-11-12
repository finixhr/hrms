-- Phase 3 — enterprise report delivery: retry-with-backoff columns on
-- ReportTemplate + the PDF format value (rides the existing String column).
-- Fully additive; matches prisma/schema.prisma exactly.

-- AlterTable
ALTER TABLE "ReportTemplate" ADD COLUMN "retryCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ReportTemplate" ADD COLUMN "nextRetryAt" TIMESTAMP(3);
