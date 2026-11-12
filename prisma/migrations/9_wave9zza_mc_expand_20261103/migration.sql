-- =====================================================================
-- M1 — MULTI-COMPANY EXPAND (2026-11-03, Wave 1 / Release R1)
-- The five S1–S4b columns from the approved W1 register (Wave Plan §2.4).
--
-- EXPAND-ONLY CONTRACT:
--   S1  AuditLog.companyId                    nullable TEXT (stamped W4+/M3b)
--   S2  BgJob.companyId                       nullable TEXT (stamped W4+/M3b)
--   S3  AttendancePolicyAssignment.companyId  nullable TEXT (stamped W4)
--   S4a UserCompanyAccess.permissions         TEXT NOT NULL DEFAULT '[]'
--   S4b UserCompanyAccess.excludedPermissions TEXT NOT NULL DEFAULT '[]'
--
-- No data changes beyond the DEFAULT '[]' fill on existing rows; NO
-- constraints, NO foreign keys, NO unique indexes, NO index builds
-- (companyId indexes are built CONCURRENTLY by M3b; enforcement is M4/W6).
-- Derived-baseline permission model: S4a/S4b hold deliberate deltas only —
-- User.permissions remains the single inherited source; nothing is copied.
-- Nothing in W1 stamps the new columns except the R-26 boot assertion reads
-- their existence.
--
-- Idempotent by construction (ADD COLUMN IF NOT EXISTS) — safe to re-run.
-- =====================================================================

-- S1 — AuditLog.companyId (attribution stamped by W4+ writers / M3b backfill)
ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "companyId" TEXT;

-- S2 — BgJob.companyId (attribution stamped by W4+ writers / M3b backfill)
ALTER TABLE "BgJob" ADD COLUMN IF NOT EXISTS "companyId" TEXT;

-- S3 — AttendancePolicyAssignment.companyId (stamped by W4 policy scoping)
ALTER TABLE "AttendancePolicyAssignment" ADD COLUMN IF NOT EXISTS "companyId" TEXT;

-- S4a — UserCompanyAccess.permissions (per-company delta grants; '[]' = none;
-- interpreted from W3/R-14 under the derived-baseline model)
ALTER TABLE "UserCompanyAccess" ADD COLUMN IF NOT EXISTS "permissions" TEXT NOT NULL DEFAULT '[]';

-- S4b — UserCompanyAccess.excludedPermissions (per-company delta exclusions;
-- '[]' = none; interpreted from W3/R-14)
ALTER TABLE "UserCompanyAccess" ADD COLUMN IF NOT EXISTS "excludedPermissions" TEXT NOT NULL DEFAULT '[]';
