-- =====================================================================
-- Wave 3 (2026-10-08) — WP-C: tenant plan-change requests.
-- SaasPlanChangeRequest — submitted by tenants whose roles lack
-- billing.manage, decided from the owner console. Plain String FK columns
-- (no Prisma relations) consistent with the H-10 vendor-scoping convention
-- used across the codebase. Sorts after 9_wave3_a_… by design.
-- =====================================================================

CREATE TABLE "SaasPlanChangeRequest" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "requestedPlanId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT,
    "requestedByName" TEXT,
    "decidedById" TEXT,
    "decidedByName" TEXT,
    "decidedAt" TIMESTAMP,
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SaasPlanChangeRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SaasPlanChangeRequest_vendorId_id_key" ON "SaasPlanChangeRequest" ("vendorId", "id");
CREATE INDEX "SaasPlanChangeRequest_vendorId_status_idx" ON "SaasPlanChangeRequest" ("vendorId", "status");
CREATE INDEX "SaasPlanChangeRequest_status_createdAt_idx" ON "SaasPlanChangeRequest" ("status", "createdAt");
