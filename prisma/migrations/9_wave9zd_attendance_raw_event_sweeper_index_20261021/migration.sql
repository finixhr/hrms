-- SCL-3 (Phase 1, index half) — sweeper query index.
--
-- sweepOnce() (gateway.ts) runs every 15 s and queries
--   findMany({ where: { processingStatus: { in: ['RECEIVED','FAILED'] } },
--              orderBy: { eventTime: 'asc' }, take: 1000 })
-- with NO vendorId — a deployment-wide pass. The existing
-- (vendorId, processingStatus) index has vendorId as its leading column and
-- cannot serve a processingStatus-only predicate, so every sweep was a
-- sequential scan over the whole raw-event table (the fastest-growing table
-- in the system). The same index also serves recoverStaleClaims' PROCESSING
-- scan and the FAILED/OUT_OF_WINDOW updateMany filters.
--
-- The FULL SCL-3 fix (per-vendor fair paging so one tenant's backfill cannot
-- starve the others) is Phase 2 work; this index is the Phase 1 half that
-- makes the existing query hit an index at all.

CREATE INDEX "AttendanceRawEvent_processingStatus_eventTime_idx"
  ON "AttendanceRawEvent"("processingStatus", "eventTime");
