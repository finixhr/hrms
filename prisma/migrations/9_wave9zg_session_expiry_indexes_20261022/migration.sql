-- SCL-19 (Phase 2 WS5) — indexes for the daily expired-session purge.
--
-- Session rows were never purged (only user-cascade deletes removed them),
-- so expired FULL + PREAUTH sessions accumulated unboundedly. The platform
-- daily job now runs one fleet-wide deleteMany on expiresAt per day; these
-- indexes keep that delete an index-range scan instead of a full-table scan.

CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");
CREATE INDEX "SaaSOwnerSession_expiresAt_idx" ON "SaaSOwnerSession"("expiresAt");
