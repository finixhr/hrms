-- =====================================================================
-- MULTI-COMPANY — All Companies reporting mode (2026-11-03, master
-- prompt Part D). Additive, single column:
--   Session.allCompaniesMode Boolean NOT NULL DEFAULT false
--
-- TRUE while a session operates in the explicitly authorized consolidated
-- REPORTING context (cross-company dashboards / group analytics). The flag
-- is re-validated against the live companies.consolidated permission on
-- every request (auth.ts) and mutating business operations stay denied in
-- this mode (dispatcher company gate), so it can never widen CRUD access.
--
-- Idempotent by construction (ADD COLUMN IF NOT EXISTS). No data changes.
-- =====================================================================

ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "allCompaniesMode" BOOLEAN NOT NULL DEFAULT false;
