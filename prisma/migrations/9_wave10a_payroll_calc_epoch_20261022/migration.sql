-- Phase 4 WS-B (MON-7) — PayrollRun.calcEpoch: calculation claim fencing.
-- Additive only: one integer column with a default; no backfill, no data change.
ALTER TABLE "PayrollRun" ADD COLUMN "calcEpoch" INTEGER NOT NULL DEFAULT 0;
