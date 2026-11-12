-- SCL-3 full (Phase 2 WS2) — per-vendor fair sweeper paging index.
--
-- sweepOnce() (gateway.ts) now pages pending events PER VENDOR:
--   findMany({ where: { vendorId, processingStatus: { in: [...] } },
--              orderBy: { eventTime: 'asc' }, take: perVendorSlice })
-- behind a recursive skip-scan over DISTINCT pending vendorIds. The Phase 1
-- (processingStatus, eventTime) index serves the global status scans, but
-- the per-vendor page needs (vendorId, processingStatus, eventTime) so a
-- vendor with a large backfill reads its slice straight off the index
-- instead of sorting its whole pending set on every 15 s pass.

CREATE INDEX "AttendanceRawEvent_vendorId_processingStatus_eventTime_idx"
  ON "AttendanceRawEvent"("vendorId", "processingStatus", "eventTime");
