-- =====================================================================
-- Wave 3 (2026-10-08) — WP-B: manual voucher approval workflow.
-- AccountJournal += status/approval columns. Additive-only; existing rows
-- keep the default 'POSTED' so auto-generated journals (payroll, loans,
-- expenses…) are unaffected. Named 9_wave3_a_… so it sorts AFTER
-- 9_wave2_saas_ops_20261008 under every collation (a `2026…` timestamp
-- prefix would sort between 1_… and 2_… and re-create the P3018 bug).
-- =====================================================================

ALTER TABLE "AccountJournal" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'POSTED';
ALTER TABLE "AccountJournal" ADD COLUMN "approvedById" TEXT;
ALTER TABLE "AccountJournal" ADD COLUMN "approvedByName" TEXT;
ALTER TABLE "AccountJournal" ADD COLUMN "approvedAt" TIMESTAMP;
ALTER TABLE "AccountJournal" ADD COLUMN "rejectionReason" TEXT;
CREATE INDEX "AccountJournal_vendorId_status_idx" ON "AccountJournal" ("vendorId", "status");
