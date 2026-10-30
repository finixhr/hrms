-- =====================================================================
-- Wave 2 (2026-10-08) — new modules: Asset Management (WP-K/L),
-- Field Force (WP-M), Recruitment + public Careers (WP-P).
-- Additive-only. Plain String FK columns (no Prisma relations) consistent
-- with the H-10 vendor-scoping convention used across the codebase.
-- =====================================================================

-- ================= WP-K — Employee Asset Management =================
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'OTHER',
    "brandModel" TEXT,
    "serialImei" TEXT,
    "purchaseDate" TEXT,
    "purchaseCost" DOUBLE PRECISION,
    "warrantyExpiry" TEXT,
    "condition" TEXT NOT NULL DEFAULT 'NEW',
    "status" TEXT NOT NULL DEFAULT 'IN_STOCK',
    "branchId" TEXT,
    "locationNote" TEXT,
    "sourceItemId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP NOT NULL,
    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Asset_vendorId_id_key" ON "Asset" ("vendorId", "id");
CREATE UNIQUE INDEX "Asset_vendorId_code_key" ON "Asset" ("vendorId", "code");
CREATE INDEX "Asset_vendorId_status_idx" ON "Asset" ("vendorId", "status");
CREATE INDEX "Asset_vendorId_category_idx" ON "Asset" ("vendorId", "category");
CREATE INDEX "Asset_vendorId_branchId_idx" ON "Asset" ("vendorId", "branchId");
CREATE INDEX "Asset_vendorId_warrantyExpiry_idx" ON "Asset" ("vendorId", "warrantyExpiry");

CREATE TABLE "AssetAssignment" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMP,
    "returnedAt" TIMESTAMP,
    "conditionOut" TEXT,
    "conditionIn" TEXT,
    "note" TEXT,
    "issuedById" TEXT,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AssetAssignment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AssetAssignment_vendorId_id_key" ON "AssetAssignment" ("vendorId", "id");
CREATE INDEX "AssetAssignment_vendorId_assetId_idx" ON "AssetAssignment" ("vendorId", "assetId");
CREATE INDEX "AssetAssignment_vendorId_employeeId_idx" ON "AssetAssignment" ("vendorId", "employeeId");
CREATE INDEX "AssetAssignment_vendorId_returnedAt_idx" ON "AssetAssignment" ("vendorId", "returnedAt");

CREATE TABLE "AssetEvent" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actorId" TEXT,
    "actorName" TEXT,
    "snapshotJson" TEXT NOT NULL DEFAULT '{}',
    "note" TEXT,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AssetEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AssetEvent_vendorId_id_key" ON "AssetEvent" ("vendorId", "id");
CREATE INDEX "AssetEvent_vendorId_assetId_createdAt_idx" ON "AssetEvent" ("vendorId", "assetId", "createdAt");

-- ================= WP-M — Field Force Management =================
CREATE TABLE "VisitLocation" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "radiusM" INTEGER NOT NULL DEFAULT 150,
    "contactName" TEXT,
    "contactPhone" TEXT,
    "note" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VisitLocation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "VisitLocation_vendorId_id_key" ON "VisitLocation" ("vendorId", "id");
CREATE UNIQUE INDEX "VisitLocation_vendorId_name_key" ON "VisitLocation" ("vendorId", "name");
CREATE INDEX "VisitLocation_vendorId_active_idx" ON "VisitLocation" ("vendorId", "active");

CREATE TABLE "VisitPlan" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VisitPlan_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "VisitPlan_vendorId_id_key" ON "VisitPlan" ("vendorId", "id");
CREATE UNIQUE INDEX "VisitPlan_vendorId_employeeId_date_key" ON "VisitPlan" ("vendorId", "employeeId", "date");
CREATE INDEX "VisitPlan_vendorId_date_idx" ON "VisitPlan" ("vendorId", "date");

CREATE TABLE "VisitPlanItem" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "plannedFrom" TEXT,
    "plannedTo" TEXT,
    "tasks" TEXT,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VisitPlanItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "VisitPlanItem_vendorId_id_key" ON "VisitPlanItem" ("vendorId", "id");
CREATE INDEX "VisitPlanItem_vendorId_planId_idx" ON "VisitPlanItem" ("vendorId", "planId");

CREATE TABLE "Visit" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "planItemId" TEXT,
    "employeeId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "checkInAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkInLat" DOUBLE PRECISION,
    "checkInLng" DOUBLE PRECISION,
    "checkInAccuracy" DOUBLE PRECISION,
    "checkInPhotoId" TEXT,
    "checkOutAt" TIMESTAMP,
    "checkOutLat" DOUBLE PRECISION,
    "checkOutLng" DOUBLE PRECISION,
    "durationMin" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'CHECKED_IN',
    "remarks" TEXT,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Visit_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Visit_vendorId_id_key" ON "Visit" ("vendorId", "id");
CREATE INDEX "Visit_vendorId_employeeId_checkInAt_idx" ON "Visit" ("vendorId", "employeeId", "checkInAt");
CREATE INDEX "Visit_vendorId_locationId_idx" ON "Visit" ("vendorId", "locationId");
CREATE INDEX "Visit_vendorId_status_idx" ON "Visit" ("vendorId", "status");

-- ================= WP-P — Recruitment + public Careers =================
CREATE TABLE "JobOpening" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "departmentId" TEXT,
    "branchId" TEXT,
    "employmentType" TEXT NOT NULL DEFAULT 'FULL_TIME',
    "description" TEXT,
    "requirements" TEXT,
    "openings" INTEGER NOT NULL DEFAULT 1,
    "salaryRange" TEXT,
    "deadline" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP NOT NULL,
    CONSTRAINT "JobOpening_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "JobOpening_vendorId_id_key" ON "JobOpening" ("vendorId", "id");
CREATE INDEX "JobOpening_vendorId_status_idx" ON "JobOpening" ("vendorId", "status");
CREATE INDEX "JobOpening_vendorId_isPublic_idx" ON "JobOpening" ("vendorId", "isPublic");

CREATE TABLE "JobApplication" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "openingId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "expectedSalary" DOUBLE PRECISION,
    "coverNote" TEXT,
    "cvFileId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'WEBSITE',
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "notes" TEXT,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP NOT NULL,
    CONSTRAINT "JobApplication_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "JobApplication_vendorId_id_key" ON "JobApplication" ("vendorId", "id");
CREATE INDEX "JobApplication_vendorId_openingId_idx" ON "JobApplication" ("vendorId", "openingId");
CREATE INDEX "JobApplication_vendorId_status_idx" ON "JobApplication" ("vendorId", "status");
CREATE INDEX "JobApplication_vendorId_createdAt_idx" ON "JobApplication" ("vendorId", "createdAt");

-- ================= WP-M — FIELD_FORCE plan feature flag =================
ALTER TABLE "SaaSPlan" ADD COLUMN "fieldForceEnabled" BOOLEAN NOT NULL DEFAULT false;
