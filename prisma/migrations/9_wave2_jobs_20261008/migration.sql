-- =====================================================================
-- Wave 2 — WP-A: production-grade job queue (2026-10-08)
-- Additive-only: new columns on BgJob + indexes for the priority-aware
-- claim scan. Existing rows keep their meaning (defaults backfill).
-- Statuses gain CANCELLED and DEAD (string column — no constraint to alter).
-- =====================================================================

-- Priority (lower = sooner; 0 highest, 9 lowest; default 5 = normal).
ALTER TABLE "BgJob" ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 5;

-- Deferred execution: NULL = immediately eligible.
ALTER TABLE "BgJob" ADD COLUMN "scheduledFor" TIMESTAMP;

-- Retry bookkeeping: attempts counts COMPLETED executions; maxAttempts is
-- the total attempt budget before the job is dead-lettered (DEAD).
ALTER TABLE "BgJob" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BgJob" ADD COLUMN "maxAttempts" INTEGER NOT NULL DEFAULT 3;

-- Cooperative cancellation marker (set by jobs.cancel; checked between
-- chunks by long-running handlers).
ALTER TABLE "BgJob" ADD COLUMN "cancelledAt" TIMESTAMP;

-- When the last failure happened (for backoff computation + observability).
ALTER TABLE "BgJob" ADD COLUMN "lastErrorAt" TIMESTAMP;

-- Append-only attempt history (JSON array of
-- {startedAt, finishedAt, error?, durationMs}).
ALTER TABLE "BgJob" ADD COLUMN "runLogJson" TEXT;

-- The priority-aware claim scan used by drainJobs().
CREATE INDEX "BgJob_status_priority_createdAt_idx" ON "BgJob" ("status", "priority", "createdAt");

-- Per-type filtering in the Job Center (vendor + type + status).
CREATE INDEX "BgJob_vendorId_type_status_idx" ON "BgJob" ("vendorId", "type", "status");

-- =====================================================================
-- Wave 2 — WP-F: payroll payout confirmation + run cancellation (additive)
-- =====================================================================
ALTER TABLE "PayrollRun" ADD COLUMN "payoutConfirmedAt" TIMESTAMP;
ALTER TABLE "PayrollRun" ADD COLUMN "payoutJournalId" TEXT;
ALTER TABLE "PayrollRun" ADD COLUMN "cancelledAt" TIMESTAMP;

-- Wave 2 — WP-G: preflight auto-exclusion record on PayrollRun
ALTER TABLE "PayrollRun" ADD COLUMN "excludedJson" TEXT;
