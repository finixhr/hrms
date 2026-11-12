-- PRE-EXISTING DRIFT REPAIR (found while verifying the P0 wave with the
-- project's own schema-drift gate, 2026-11-09): the 2026-11-07 KPI Performance
-- System redesign changed KpiAssignment.status's schema default to
-- 'PENDING_APPROVAL' without shipping the matching migration — exactly the
-- "schema edited, migration forgotten" class check-schema-drift.ts exists to
-- catch (every `prisma migrate deploy` database would disagree with the
-- schema). One additive ALTER restores chain/schema parity; not a P0 audit
-- finding itself, but the drift gate must be green on the remediated tree.

ALTER TABLE "KpiAssignment" ALTER COLUMN "status" SET DEFAULT 'PENDING_APPROVAL';
