-- KPI PERFORMANCE SYSTEM REDESIGN (2026-11 master prompt)
-- Company → Department → KpiTemplate → KpiIndicator architecture with
-- indicator-level target snapshots (KpiAssignmentIndicator), achievements
-- (KpiAchievement), bulk import batches (KpiBatch), a first-class approval
-- history (KpiApprovalAction) and revision archive (KpiRevision).
-- Legacy KpiTemplate.itemsJson / KpiAssignment.resultsJson are KEPT as mirrors
-- for the pre-redesign routes (mobile/ESS compat) and backfilled into the new
-- normalized tables below. Additive DDL + idempotent backfills guarded by
-- row-existence checks. Matches prisma/schema.prisma exactly.

-- ============ 1. ALTER KpiTemplate ============
ALTER TABLE "KpiTemplate" ADD COLUMN "description" TEXT;
ALTER TABLE "KpiTemplate" ADD COLUMN "periodType" TEXT NOT NULL DEFAULT 'MONTHLY';
ALTER TABLE "KpiTemplate" ADD COLUMN "createdBy" TEXT;
ALTER TABLE "KpiTemplate" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "KpiTemplate" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "KpiTemplate" ALTER COLUMN "updatedAt" DROP DEFAULT;
CREATE INDEX "KpiTemplate_vendorId_departmentId_idx" ON "KpiTemplate"("vendorId", "departmentId");
-- ONE template per (vendor, company, department). Postgres treats NULLs as
-- distinct so the pre-redesign legacy rows (departmentId NULL) never collide.
CREATE UNIQUE INDEX "KpiTemplate_vendorId_companyId_departmentId_key" ON "KpiTemplate"("vendorId", "companyId", "departmentId");

-- ============ 2. ALTER KpiAssignment ============
ALTER TABLE "KpiAssignment" ADD COLUMN "periodStart" TEXT;
ALTER TABLE "KpiAssignment" ADD COLUMN "periodEnd" TEXT;
ALTER TABLE "KpiAssignment" ADD COLUMN "batchId" TEXT;
ALTER TABLE "KpiAssignment" ADD COLUMN "remarks" TEXT;
ALTER TABLE "KpiAssignment" ADD COLUMN "createdBy" TEXT;
ALTER TABLE "KpiAssignment" ADD COLUMN "submittedAt" TIMESTAMP(3);
ALTER TABLE "KpiAssignment" ADD COLUMN "decidedBy" TEXT;
ALTER TABLE "KpiAssignment" ADD COLUMN "decidedAt" TIMESTAMP(3);
ALTER TABLE "KpiAssignment" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "KpiAssignment" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "KpiAssignment" ALTER COLUMN "updatedAt" DROP DEFAULT;
-- one target assignment per (vendor, employee, period) — verified 0 duplicates
-- in existing data before this constraint was created.
CREATE UNIQUE INDEX "KpiAssignment_vendorId_employeeId_periodLabel_key" ON "KpiAssignment"("vendorId", "employeeId", "periodLabel");
CREATE INDEX "KpiAssignment_vendorId_periodLabel_idx" ON "KpiAssignment"("vendorId", "periodLabel");
CREATE INDEX "KpiAssignment_batchId_idx" ON "KpiAssignment"("batchId");

-- ============ 3. CREATE KpiIndicator ============
CREATE TABLE "KpiIndicator" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "source" TEXT NOT NULL DEFAULT 'CUSTOM',
    "builtinKey" TEXT,
    "unit" TEXT NOT NULL DEFAULT 'PERCENT',
    "unitLabel" TEXT,
    "direction" TEXT NOT NULL DEFAULT 'HIGHER_IS_BETTER',
    "defaultTarget" DOUBLE PRECISION,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KpiIndicator_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "KpiIndicator_vendorId_templateId_idx" ON "KpiIndicator"("vendorId", "templateId");
CREATE INDEX "KpiIndicator_templateId_active_idx" ON "KpiIndicator"("templateId", "active");
ALTER TABLE "KpiIndicator" ADD CONSTRAINT "KpiIndicator_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "KpiTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============ 4. CREATE KpiBatch ============
CREATE TABLE "KpiBatch" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "companyId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'TARGET',
    "templateId" TEXT,
    "departmentId" TEXT,
    "periodLabel" TEXT NOT NULL,
    "dueDate" TEXT,
    "totalEmployees" INTEGER NOT NULL DEFAULT 0,
    "validCount" INTEGER NOT NULL DEFAULT 0,
    "invalidCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,

    CONSTRAINT "KpiBatch_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "KpiBatch_vendorId_kind_status_idx" ON "KpiBatch"("vendorId", "kind", "status");
CREATE INDEX "KpiBatch_companyId_idx" ON "KpiBatch"("companyId");
CREATE INDEX "KpiBatch_vendorId_periodLabel_idx" ON "KpiBatch"("vendorId", "periodLabel");
ALTER TABLE "KpiBatch" ADD CONSTRAINT "KpiBatch_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============ 5. CREATE KpiAssignmentIndicator ============
CREATE TABLE "KpiAssignmentIndicator" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "indicatorId" TEXT,
    "name" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'CUSTOM',
    "builtinKey" TEXT,
    "unit" TEXT NOT NULL DEFAULT 'PERCENT',
    "unitLabel" TEXT,
    "direction" TEXT NOT NULL DEFAULT 'HIGHER_IS_BETTER',
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "targetValue" DOUBLE PRECISION,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "KpiAssignmentIndicator_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "KpiAssignmentIndicator_assignmentId_idx" ON "KpiAssignmentIndicator"("assignmentId");
CREATE INDEX "KpiAssignmentIndicator_vendorId_indicatorId_idx" ON "KpiAssignmentIndicator"("vendorId", "indicatorId");
ALTER TABLE "KpiAssignmentIndicator" ADD CONSTRAINT "KpiAssignmentIndicator_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "KpiAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============ 6. CREATE KpiAchievement ============
CREATE TABLE "KpiAchievement" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "indicatorRowId" TEXT NOT NULL,
    "indicatorId" TEXT,
    "indicatorName" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'PERCENT',
    "direction" TEXT NOT NULL DEFAULT 'HIGHER_IS_BETTER',
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "targetValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "actualValue" DOUBLE PRECISION,
    "achievementPct" DOUBLE PRECISION,
    "score" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    "reportedDate" TEXT,
    "remarks" TEXT,
    "evidenceName" TEXT,
    "batchId" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "submittedBy" TEXT,
    "submittedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KpiAchievement_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "KpiAchievement_indicatorRowId_revision_key" ON "KpiAchievement"("indicatorRowId", "revision");
CREATE INDEX "KpiAchievement_vendorId_employeeId_status_idx" ON "KpiAchievement"("vendorId", "employeeId", "status");
CREATE INDEX "KpiAchievement_vendorId_status_idx" ON "KpiAchievement"("vendorId", "status");
CREATE INDEX "KpiAchievement_assignmentId_idx" ON "KpiAchievement"("assignmentId");
CREATE INDEX "KpiAchievement_batchId_idx" ON "KpiAchievement"("batchId");
ALTER TABLE "KpiAchievement" ADD CONSTRAINT "KpiAchievement_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "KpiAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============ 7. CREATE KpiApprovalAction ============
CREATE TABLE "KpiApprovalAction" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "batchId" TEXT,
    "employeeId" TEXT,
    "action" TEXT NOT NULL,
    "comment" TEXT,
    "actorId" TEXT,
    "actorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KpiApprovalAction_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "KpiApprovalAction_vendorId_entityType_entityId_idx" ON "KpiApprovalAction"("vendorId", "entityType", "entityId");
CREATE INDEX "KpiApprovalAction_vendorId_employeeId_idx" ON "KpiApprovalAction"("vendorId", "employeeId");
CREATE INDEX "KpiApprovalAction_batchId_idx" ON "KpiApprovalAction"("batchId");

-- ============ 8. CREATE KpiRevision ============
CREATE TABLE "KpiRevision" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "snapshotJson" TEXT NOT NULL,
    "changeSummary" TEXT,
    "changedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KpiRevision_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "KpiRevision_vendorId_entityType_entityId_idx" ON "KpiRevision"("vendorId", "entityType", "entityId");
CREATE INDEX "KpiRevision_entityId_idx" ON "KpiRevision"("entityId");

-- ============ 9. BACKFILL — template indicators from itemsJson ============
-- Legacy free-text units map to the typed vocabulary ("%" → PERCENT, anything
-- else → CUSTOM with the original label preserved). Direction heuristic: names
-- describing time/error/defect metrics are LOWER_IS_BETTER (documented and
-- editable afterwards).
INSERT INTO "KpiIndicator" ("id", "vendorId", "templateId", "name", "source", "unit", "unitLabel", "direction", "defaultTarget", "weight", "sortOrder", "active", "createdAt", "updatedAt")
SELECT
  'kpiind_m_' || t."id" || '_' || arr.idx,
  t."vendorId", t."id",
  COALESCE(NULLIF(trim(it->>'name'), ''), 'Indicator'),
  'CUSTOM',
  CASE WHEN (it->>'unit') = '%' THEN 'PERCENT' ELSE 'CUSTOM' END,
  CASE WHEN (it->>'unit') = '%' OR (it->>'unit') IS NULL THEN NULL ELSE it->>'unit' END,
  CASE WHEN COALESCE(it->>'name','') ~* '(response time|processing time|error rate|defect|turnaround|delay)' THEN 'LOWER_IS_BETTER' ELSE 'HIGHER_IS_BETTER' END,
  CASE WHEN it->>'target' IS NULL OR it->>'target' = '' THEN NULL ELSE (it->>'target')::double precision END,
  COALESCE((it->>'weight')::double precision, 0),
  arr.idx::int,
  true, now(), now()
FROM "KpiTemplate" t
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t."itemsJson"::jsonb) = 'array' THEN t."itemsJson"::jsonb ELSE '[]'::jsonb END)
  WITH ORDINALITY AS arr(it, idx)
WHERE jsonb_typeof(t."itemsJson"::jsonb) = 'array'
  AND jsonb_array_length(t."itemsJson"::jsonb) > 0
  AND NOT EXISTS (SELECT 1 FROM "KpiIndicator" ki WHERE ki."templateId" = t."id");

-- ============ 10. BACKFILL — assignment indicator snapshots from resultsJson ============
INSERT INTO "KpiAssignmentIndicator" ("id", "vendorId", "assignmentId", "indicatorId", "name", "source", "unit", "unitLabel", "direction", "weight", "targetValue", "sortOrder")
SELECT
  'kpiassignind_m_' || a."id" || '_' || arr.idx,
  a."vendorId", a."id",
  ki."id",
  COALESCE(NULLIF(trim(it->>'name'), ''), 'Indicator'),
  'CUSTOM',
  CASE WHEN (it->>'unit') = '%' THEN 'PERCENT' ELSE 'CUSTOM' END,
  CASE WHEN (it->>'unit') = '%' OR (it->>'unit') IS NULL THEN NULL ELSE it->>'unit' END,
  COALESCE(ki."direction", 'HIGHER_IS_BETTER'),
  COALESCE((it->>'weight')::double precision, ki."weight", 0),
  CASE WHEN it->>'target' IS NULL OR it->>'target' = '' THEN NULL ELSE (it->>'target')::double precision END,
  arr.idx::int
FROM "KpiAssignment" a
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(a."resultsJson"::jsonb) = 'array' THEN a."resultsJson"::jsonb ELSE '[]'::jsonb END)
  WITH ORDINALITY AS arr(it, idx)
LEFT JOIN LATERAL (
  SELECT ki.* FROM "KpiIndicator" ki
  WHERE ki."templateId" = a."templateId"
    AND ki."name" = COALESCE(NULLIF(trim(it->>'name'), ''), 'Indicator')
  ORDER BY ki."sortOrder" ASC LIMIT 1
) ki ON true
WHERE jsonb_typeof(a."resultsJson"::jsonb) = 'array'
  AND jsonb_array_length(a."resultsJson"::jsonb) > 0
  AND NOT EXISTS (SELECT 1 FROM "KpiAssignmentIndicator" x WHERE x."assignmentId" = a."id");

-- ============ 11. BACKFILL — achievements from resultsJson actuals ============
-- Achievement status follows the LEGACY assignment status (read BEFORE §13
-- rewrites it): REVIEWED/APPROVED rows had their results reviewed → APPROVED;
-- SUBMITTED rows were awaiting review → PENDING_APPROVAL.
INSERT INTO "KpiAchievement" ("id", "vendorId", "assignmentId", "employeeId", "indicatorRowId", "indicatorId", "indicatorName", "unit", "direction", "weight", "targetValue", "actualValue", "achievementPct", "score", "status", "submittedAt", "decidedAt", "revision", "createdAt", "updatedAt")
SELECT
  'kpiach_m_' || a."id" || '_' || arr.idx,
  a."vendorId", a."id", a."employeeId",
  ai."id", ai."indicatorId", ai."name", ai."unit", ai."direction",
  COALESCE(ai."weight", 0), COALESCE(ai."targetValue", 0),
  (it->>'actual')::double precision,
  CASE WHEN it->>'achievementPct' IS NULL OR it->>'achievementPct' = '' THEN NULL ELSE (it->>'achievementPct')::double precision END,
  CASE WHEN it->>'score' IS NULL OR it->>'score' = '' THEN NULL ELSE (it->>'score')::double precision END,
  CASE WHEN a."status" IN ('REVIEWED','APPROVED') THEN 'APPROVED' ELSE 'PENDING_APPROVAL' END,
  a."updatedAt",
  CASE WHEN a."status" IN ('REVIEWED','APPROVED') THEN a."updatedAt" ELSE NULL END,
  1, now(), now()
FROM "KpiAssignment" a
JOIN "KpiAssignmentIndicator" ai ON ai."assignmentId" = a."id"
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(a."resultsJson"::jsonb) = 'array' THEN a."resultsJson"::jsonb ELSE '[]'::jsonb END)
  WITH ORDINALITY AS arr(it, idx)
WHERE jsonb_typeof(a."resultsJson"::jsonb) = 'array'
  AND jsonb_array_length(a."resultsJson"::jsonb) > 0
  AND ai."sortOrder" = arr.idx::int
  AND it->>'actual' IS NOT NULL AND it->>'actual' != ''
  AND NOT EXISTS (SELECT 1 FROM "KpiAchievement" x WHERE x."assignmentId" = a."id");

-- ============ 12. BACKFILL — resolve period windows from periodLabel ============
UPDATE "KpiAssignment" SET
  "periodStart" = CASE
    WHEN "periodLabel" ~ '^\d{4}-Q[1-4]$' THEN to_char(make_date(substring("periodLabel" from 1 for 4)::int, (substring("periodLabel" from 7 for 1)::int - 1) * 3 + 1, 1), 'YYYY-MM-DD')
    WHEN "periodLabel" ~ '^\d{4}-\d{2}$' THEN to_char(make_date(substring("periodLabel" from 1 for 4)::int, substring("periodLabel" from 6 for 2)::int, 1), 'YYYY-MM-DD')
    WHEN "periodLabel" ~ '^\d{4}$' THEN to_char(make_date("periodLabel"::int, 1, 1), 'YYYY-MM-DD')
    ELSE "periodStart" END,
  "periodEnd" = CASE
    WHEN "periodLabel" ~ '^\d{4}-Q[1-4]$' THEN to_char((make_date(substring("periodLabel" from 1 for 4)::int, substring("periodLabel" from 7 for 1)::int * 3, 1) + interval '1 month - 1 day')::date, 'YYYY-MM-DD')
    WHEN "periodLabel" ~ '^\d{4}-\d{2}$' THEN to_char((make_date(substring("periodLabel" from 1 for 4)::int, substring("periodLabel" from 6 for 2)::int, 1) + interval '1 month - 1 day')::date, 'YYYY-MM-DD')
    WHEN "periodLabel" ~ '^\d{4}$' THEN to_char(make_date("periodLabel"::int, 12, 31), 'YYYY-MM-DD')
    ELSE "periodEnd" END
WHERE "periodStart" IS NULL AND "periodEnd" IS NULL;

-- ============ 13. BACKFILL — submission metadata + status vocabulary ============
UPDATE "KpiAssignment" SET
  "submittedAt" = CASE WHEN "status" IN ('SUBMITTED','REVIEWED','APPROVED') THEN "updatedAt" ELSE NULL END
WHERE "submittedAt" IS NULL;

UPDATE "KpiAssignment" SET
  "status" = CASE
    WHEN "status" IN ('PENDING','IN_PROGRESS','DRAFT') THEN 'PENDING_APPROVAL'
    ELSE 'APPROVED' -- SUBMITTED | REVIEWED | APPROVED — targets had taken effect
  END;
