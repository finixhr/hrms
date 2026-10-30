-- Phase R6 / EMP-13 + DB-02 follow-up — directory search coverage + retention.
--
-- EMP-13: the trigram GIN indexes (migration 9_wave9zf) cover name+code only;
-- the directory search also ILIKE-matches mobile / altMobile / both email
-- addresses, which forced sequential scans at scale. Same raw-SQL pattern as
-- 9_wave9zf (pg_trgm has no Prisma datamodel syntax — allow-listed in the
-- schema-drift gate alongside the first two).
CREATE INDEX "Employee_mobile_trgm_idx" ON "Employee" USING gin ("mobile" gin_trgm_ops);
CREATE INDEX "Employee_altMobile_trgm_idx" ON "Employee" USING gin ("altMobile" gin_trgm_ops);
CREATE INDEX "Employee_officialEmail_trgm_idx" ON "Employee" USING gin ("officialEmail" gin_trgm_ops);
CREATE INDEX "Employee_personalEmail_trgm_idx" ON "Employee" USING gin ("personalEmail" gin_trgm_ops);

-- DB-06: the refresh-token retention sweep deletes on expiresAt; without this
-- index the purge seq-scans ApiRefreshToken (rows were never purged at all
-- before — the sweep ships with this migration in jobs.ts).
CREATE INDEX "ApiRefreshToken_expiresAt_idx" ON "ApiRefreshToken"("expiresAt");
