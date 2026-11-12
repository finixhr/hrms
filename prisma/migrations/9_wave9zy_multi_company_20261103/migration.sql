-- =====================================================================
-- MULTI-COMPANY FOUNDATION (2026-11-03) — Phase L of the master prompt
-- "FINIX HR — Enterprise Multi-Company Management Architecture".
--
-- Vendor remains the TENANT. Company becomes a child of Vendor: the
-- independently managed operating unit for HR/payroll/accounting data.
--
-- Strategy: EXPAND → BACKFILL → ENFORCE (idempotent, additive, safe):
--   1. EXPAND   — new tables (Company, CompanySetting, UserCompanyAccess),
--                 nullable companyId columns everywhere, Session.activeCompanyId.
--   2. BACKFILL — one default Company per existing Vendor (identity copied
--                 from Vendor + its HrSetting general group); every scoped
--                 record assigned to its vendor's default company; one
--                 UserCompanyAccess row per existing User (role preserved);
--                 NOT NULL not enforced (additive-only; new writes always
--                 carry companyId from the server context).
--   3. ENFORCE  — company-level unique constraints (Branch/Department/
--                 Designation/Employee/CostCenter code, AccountingPeriod
--                 name, ApprovalWorkflow processType) replace the vendor-
--                 level ones; FK constraints; indexes; partial unique
--                 indexes (one default company per vendor, one active
--                 UserCompanyAccess per user+company).
--
-- Data preservation: no ids, timestamps, money amounts, approval states,
-- audit logs, paid payroll or posted journals are touched. Only nullable
-- companyId columns are populated. Rollback = restore pre-migration backup
-- (the migration never drops or rewrites existing data).
-- Re-runnable: every backfill statement is idempotent (WHERE companyId IS NULL
-- / NOT EXISTS guards).
-- =====================================================================


-- =====================================================================
-- 1. EXPAND — new tables + nullable columns
-- =====================================================================

-- Drop the vendor-level unique constraints FIRST (before backfill, so
-- company-level codes can later be reused across companies; the company-level
-- twins are created in step 3 after the backfill).

DROP INDEX "ApprovalWorkflow_vendorId_processType_key";
DROP INDEX "LeaveType_vendorId_code_key";
DROP INDEX "PayrollRun_vendorId_periodYear_periodMonth_periodWeek_runType_adjustSeq_key";
DROP INDEX "ItemCategory_vendorId_name_key";

DROP INDEX "Branch_vendorId_code_key";

DROP INDEX "Department_vendorId_code_key";

DROP INDEX "Designation_vendorId_code_key";

DROP INDEX "Employee_vendorId_code_key";

DROP INDEX "AccountingPeriod_vendorId_name_key";

DROP INDEX "CostCenter_vendorId_code_key";

CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legalName" TEXT,
    "shortName" TEXT,
    "registrationNumber" TEXT,
    "taxIdentificationNumber" TEXT,
    "binVatReg" TEXT,
    "logoUrl" TEXT,
    "website" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "alternatePhone" TEXT,
    "address" TEXT,
    "city" TEXT,
    "district" TEXT,
    "country" TEXT NOT NULL DEFAULT 'Bangladesh',
    "currency" TEXT NOT NULL DEFAULT 'BDT',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Dhaka',
    "dateFormat" TEXT NOT NULL DEFAULT 'DD/MM/YYYY',
    "fiscalYearStart" TEXT NOT NULL DEFAULT 'July',
    "signatoryName" TEXT,
    "signatoryDesignation" TEXT,
    "signatureUrl" TEXT,
    "sealUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CompanySetting" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "group" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanySetting_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserCompanyAccess" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "employeeId" TEXT,
    "branchScope" TEXT,
    "departmentScope" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "grantedById" TEXT,
    "grantedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserCompanyAccess_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Session" ADD COLUMN     "activeCompanyId" TEXT;

ALTER TABLE "CompanyEvent" ADD COLUMN     "companyId" TEXT;

ALTER TABLE "ApprovalWorkflow" ADD COLUMN     "companyId" TEXT;

ALTER TABLE "ApprovalRequest" ADD COLUMN     "companyId" TEXT;

ALTER TABLE "Holiday" ADD COLUMN     "companyId" TEXT;

ALTER TABLE "Branch" ADD COLUMN     "companyId" TEXT;

ALTER TABLE "Department" ADD COLUMN     "companyId" TEXT;

ALTER TABLE "Designation" ADD COLUMN     "companyId" TEXT;

ALTER TABLE "Shift" ADD COLUMN     "companyId" TEXT;

ALTER TABLE "Employee" ADD COLUMN     "companyId" TEXT;

ALTER TABLE "AttendanceDevice" ADD COLUMN     "companyId" TEXT;

ALTER TABLE "GeoFence" ADD COLUMN     "companyId" TEXT;

ALTER TABLE "AttendancePolicy" ADD COLUMN     "companyId" TEXT;

ALTER TABLE "LeaveType" ADD COLUMN     "companyId" TEXT;

ALTER TABLE "PayrollRun" ADD COLUMN     "companyId" TEXT;

ALTER TABLE "TaxRuleSet" ADD COLUMN     "companyId" TEXT;

ALTER TABLE "SalaryTemplate" ADD COLUMN     "companyId" TEXT;

ALTER TABLE "AccountJournal" ADD COLUMN     "companyId" TEXT;

ALTER TABLE "ReviewCycle" ADD COLUMN     "companyId" TEXT;

ALTER TABLE "KpiTemplate" ADD COLUMN     "companyId" TEXT;

ALTER TABLE "WorkforceSnapshot" ADD COLUMN     "companyId" TEXT;

ALTER TABLE "Task" ADD COLUMN     "companyId" TEXT;

ALTER TABLE "LetterTemplate" ADD COLUMN     "companyId" TEXT;

ALTER TABLE "CommissionRule" ADD COLUMN     "companyId" TEXT;

ALTER TABLE "Announcement" ADD COLUMN     "companyId" TEXT;

ALTER TABLE "AitFiscalYear" ADD COLUMN     "companyId" TEXT;

ALTER TABLE "Supplier" ADD COLUMN     "companyId" TEXT;

ALTER TABLE "Warehouse" ADD COLUMN     "companyId" TEXT;

ALTER TABLE "Item" ADD COLUMN     "companyId" TEXT;

ALTER TABLE "ItemCategory" ADD COLUMN     "companyId" TEXT;

ALTER TABLE "GoodsRequisition" ADD COLUMN     "companyId" TEXT;

ALTER TABLE "PurchaseRequest" ADD COLUMN     "companyId" TEXT;

ALTER TABLE "Camera" ADD COLUMN     "companyId" TEXT;

ALTER TABLE "Asset" ADD COLUMN     "companyId" TEXT;

ALTER TABLE "VisitLocation" ADD COLUMN     "companyId" TEXT;

ALTER TABLE "JobOpening" ADD COLUMN     "companyId" TEXT;

ALTER TABLE "ReportTemplate" ADD COLUMN     "companyId" TEXT;

ALTER TABLE "AccountingPeriod" ADD COLUMN     "companyId" TEXT;

ALTER TABLE "CostCenter" ADD COLUMN     "companyId" TEXT;

ALTER TABLE "Budget" ADD COLUMN     "companyId" TEXT;

INSERT INTO "Company" (
  "id", "vendorId", "code", "name", "legalName", "logoUrl",
  "email", "phone", "address",
  "signatoryName", "signatoryDesignation", "signatureUrl", "sealUrl",
  "active", "isDefault", "createdAt", "updatedAt"
)
SELECT
  'mc_' || v."id",
  v."id",
  'MAIN',
  v."name",
  v."legalName",
  v."logoUrl",
  v."email",
  v."phone",
  v."address",
  (SELECT s."value" FROM "HrSetting" s WHERE s."vendorId" = v."id" AND s."group" = 'general' AND s."key" = 'signatoryName'),
  (SELECT s."value" FROM "HrSetting" s WHERE s."vendorId" = v."id" AND s."group" = 'general' AND s."key" = 'signatoryDesignation'),
  (SELECT s."value" FROM "HrSetting" s WHERE s."vendorId" = v."id" AND s."group" = 'general' AND s."key" = 'signatureUrl'),
  (SELECT s."value" FROM "HrSetting" s WHERE s."vendorId" = v."id" AND s."group" = 'general' AND s."key" = 'sealUrl'),
  true, true, NOW(), NOW()
FROM "Vendor" v
WHERE NOT EXISTS (SELECT 1 FROM "Company" c WHERE c."vendorId" = v."id");

-- 2.2 Assign every scoped record of a vendor to that vendor's default
--     company (only rows still unassigned — idempotent).

UPDATE "Branch" SET "companyId" = (SELECT c."id" FROM "Company" c WHERE c."vendorId" = "Branch"."vendorId" AND c."isDefault" = true LIMIT 1) WHERE "companyId" IS NULL;
UPDATE "Department" SET "companyId" = (SELECT c."id" FROM "Company" c WHERE c."vendorId" = "Department"."vendorId" AND c."isDefault" = true LIMIT 1) WHERE "companyId" IS NULL;
UPDATE "Designation" SET "companyId" = (SELECT c."id" FROM "Company" c WHERE c."vendorId" = "Designation"."vendorId" AND c."isDefault" = true LIMIT 1) WHERE "companyId" IS NULL;
UPDATE "Shift" SET "companyId" = (SELECT c."id" FROM "Company" c WHERE c."vendorId" = "Shift"."vendorId" AND c."isDefault" = true LIMIT 1) WHERE "companyId" IS NULL;
UPDATE "Holiday" SET "companyId" = (SELECT c."id" FROM "Company" c WHERE c."vendorId" = "Holiday"."vendorId" AND c."isDefault" = true LIMIT 1) WHERE "companyId" IS NULL;
UPDATE "GeoFence" SET "companyId" = (SELECT c."id" FROM "Company" c WHERE c."vendorId" = "GeoFence"."vendorId" AND c."isDefault" = true LIMIT 1) WHERE "companyId" IS NULL;
UPDATE "AttendancePolicy" SET "companyId" = (SELECT c."id" FROM "Company" c WHERE c."vendorId" = "AttendancePolicy"."vendorId" AND c."isDefault" = true LIMIT 1) WHERE "companyId" IS NULL;
UPDATE "LeaveType" SET "companyId" = (SELECT c."id" FROM "Company" c WHERE c."vendorId" = "LeaveType"."vendorId" AND c."isDefault" = true LIMIT 1) WHERE "companyId" IS NULL;
UPDATE "CompanyEvent" SET "companyId" = (SELECT c."id" FROM "Company" c WHERE c."vendorId" = "CompanyEvent"."vendorId" AND c."isDefault" = true LIMIT 1) WHERE "companyId" IS NULL;
UPDATE "LetterTemplate" SET "companyId" = (SELECT c."id" FROM "Company" c WHERE c."vendorId" = "LetterTemplate"."vendorId" AND c."isDefault" = true LIMIT 1) WHERE "companyId" IS NULL;
UPDATE "Employee" SET "companyId" = (SELECT c."id" FROM "Company" c WHERE c."vendorId" = "Employee"."vendorId" AND c."isDefault" = true LIMIT 1) WHERE "companyId" IS NULL;
UPDATE "SalaryTemplate" SET "companyId" = (SELECT c."id" FROM "Company" c WHERE c."vendorId" = "SalaryTemplate"."vendorId" AND c."isDefault" = true LIMIT 1) WHERE "companyId" IS NULL;
UPDATE "TaxRuleSet" SET "companyId" = (SELECT c."id" FROM "Company" c WHERE c."vendorId" = "TaxRuleSet"."vendorId" AND c."isDefault" = true LIMIT 1) WHERE "companyId" IS NULL;
UPDATE "AitFiscalYear" SET "companyId" = (SELECT c."id" FROM "Company" c WHERE c."vendorId" = "AitFiscalYear"."vendorId" AND c."isDefault" = true LIMIT 1) WHERE "companyId" IS NULL;
UPDATE "CommissionRule" SET "companyId" = (SELECT c."id" FROM "Company" c WHERE c."vendorId" = "CommissionRule"."vendorId" AND c."isDefault" = true LIMIT 1) WHERE "companyId" IS NULL;
UPDATE "PayrollRun" SET "companyId" = (SELECT c."id" FROM "Company" c WHERE c."vendorId" = "PayrollRun"."vendorId" AND c."isDefault" = true LIMIT 1) WHERE "companyId" IS NULL;
UPDATE "AccountJournal" SET "companyId" = (SELECT c."id" FROM "Company" c WHERE c."vendorId" = "AccountJournal"."vendorId" AND c."isDefault" = true LIMIT 1) WHERE "companyId" IS NULL;
UPDATE "AccountingPeriod" SET "companyId" = (SELECT c."id" FROM "Company" c WHERE c."vendorId" = "AccountingPeriod"."vendorId" AND c."isDefault" = true LIMIT 1) WHERE "companyId" IS NULL;
UPDATE "CostCenter" SET "companyId" = (SELECT c."id" FROM "Company" c WHERE c."vendorId" = "CostCenter"."vendorId" AND c."isDefault" = true LIMIT 1) WHERE "companyId" IS NULL;
UPDATE "Budget" SET "companyId" = (SELECT c."id" FROM "Company" c WHERE c."vendorId" = "Budget"."vendorId" AND c."isDefault" = true LIMIT 1) WHERE "companyId" IS NULL;
UPDATE "Supplier" SET "companyId" = (SELECT c."id" FROM "Company" c WHERE c."vendorId" = "Supplier"."vendorId" AND c."isDefault" = true LIMIT 1) WHERE "companyId" IS NULL;
UPDATE "Warehouse" SET "companyId" = (SELECT c."id" FROM "Company" c WHERE c."vendorId" = "Warehouse"."vendorId" AND c."isDefault" = true LIMIT 1) WHERE "companyId" IS NULL;
UPDATE "Item" SET "companyId" = (SELECT c."id" FROM "Company" c WHERE c."vendorId" = "Item"."vendorId" AND c."isDefault" = true LIMIT 1) WHERE "companyId" IS NULL;
UPDATE "ItemCategory" SET "companyId" = (SELECT c."id" FROM "Company" c WHERE c."vendorId" = "ItemCategory"."vendorId" AND c."isDefault" = true LIMIT 1) WHERE "companyId" IS NULL;
UPDATE "Asset" SET "companyId" = (SELECT c."id" FROM "Company" c WHERE c."vendorId" = "Asset"."vendorId" AND c."isDefault" = true LIMIT 1) WHERE "companyId" IS NULL;
UPDATE "VisitLocation" SET "companyId" = (SELECT c."id" FROM "Company" c WHERE c."vendorId" = "VisitLocation"."vendorId" AND c."isDefault" = true LIMIT 1) WHERE "companyId" IS NULL;
UPDATE "JobOpening" SET "companyId" = (SELECT c."id" FROM "Company" c WHERE c."vendorId" = "JobOpening"."vendorId" AND c."isDefault" = true LIMIT 1) WHERE "companyId" IS NULL;
UPDATE "ReviewCycle" SET "companyId" = (SELECT c."id" FROM "Company" c WHERE c."vendorId" = "ReviewCycle"."vendorId" AND c."isDefault" = true LIMIT 1) WHERE "companyId" IS NULL;
UPDATE "KpiTemplate" SET "companyId" = (SELECT c."id" FROM "Company" c WHERE c."vendorId" = "KpiTemplate"."vendorId" AND c."isDefault" = true LIMIT 1) WHERE "companyId" IS NULL;
UPDATE "AttendanceDevice" SET "companyId" = (SELECT c."id" FROM "Company" c WHERE c."vendorId" = "AttendanceDevice"."vendorId" AND c."isDefault" = true LIMIT 1) WHERE "companyId" IS NULL;
UPDATE "Camera" SET "companyId" = (SELECT c."id" FROM "Company" c WHERE c."vendorId" = "Camera"."vendorId" AND c."isDefault" = true LIMIT 1) WHERE "companyId" IS NULL;
UPDATE "ApprovalWorkflow" SET "companyId" = (SELECT c."id" FROM "Company" c WHERE c."vendorId" = "ApprovalWorkflow"."vendorId" AND c."isDefault" = true LIMIT 1) WHERE "companyId" IS NULL;
UPDATE "ApprovalRequest" SET "companyId" = (SELECT w."companyId" FROM "ApprovalWorkflow" w WHERE w."id" = "ApprovalRequest"."workflowId") WHERE "companyId" IS NULL;
UPDATE "ReportTemplate" SET "companyId" = (SELECT c."id" FROM "Company" c WHERE c."vendorId" = "ReportTemplate"."vendorId" AND c."isDefault" = true LIMIT 1) WHERE "companyId" IS NULL;
UPDATE "GoodsRequisition" SET "companyId" = (SELECT c."id" FROM "Company" c WHERE c."vendorId" = "GoodsRequisition"."vendorId" AND c."isDefault" = true LIMIT 1) WHERE "companyId" IS NULL;
UPDATE "PurchaseRequest" SET "companyId" = (SELECT c."id" FROM "Company" c WHERE c."vendorId" = "PurchaseRequest"."vendorId" AND c."isDefault" = true LIMIT 1) WHERE "companyId" IS NULL;
UPDATE "Task" SET "companyId" = (SELECT c."id" FROM "Company" c WHERE c."vendorId" = "Task"."vendorId" AND c."isDefault" = true LIMIT 1) WHERE "companyId" IS NULL;
UPDATE "WorkforceSnapshot" SET "companyId" = (SELECT c."id" FROM "Company" c WHERE c."vendorId" = "WorkforceSnapshot"."vendorId" AND c."isDefault" = true LIMIT 1) WHERE "companyId" IS NULL;
UPDATE "Announcement" SET "companyId" = (SELECT c."id" FROM "Company" c WHERE c."vendorId" = "Announcement"."vendorId" AND c."isDefault" = true LIMIT 1) WHERE "companyId" IS NULL;

-- 2.3 One UserCompanyAccess row per existing User (their tenant role carries
--     over as the company role; the FIRST company becomes their default).
--     Users with existing access rows are skipped (idempotent).
INSERT INTO "UserCompanyAccess" (
  "id", "vendorId", "userId", "companyId", "role", "active", "isDefault",
  "grantedByName", "createdAt", "updatedAt"
)
SELECT
  'mca_' || u."id",
  u."vendorId",
  u."id",
  c."id",
  u."role",
  true,
  true,
  'system migration',
  NOW(), NOW()
FROM "User" u
JOIN "Company" c ON c."vendorId" = u."vendorId" AND c."isDefault" = true
WHERE NOT EXISTS (
  SELECT 1 FROM "UserCompanyAccess" a
  WHERE a."userId" = u."id" AND a."companyId" = c."id"
);

-- 2.4 Verification (fails loudly if any scoped record is still unassigned —
--     expand/backfill must be complete before constraints are enforced).
DO $$
DECLARE
  missing_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO missing_count FROM "Employee" WHERE "companyId" IS NULL;
  IF missing_count > 0 THEN
    RAISE EXCEPTION 'multi-company backfill incomplete: % employees have no company', missing_count;
  END IF;
END $$;


-- =====================================================================
-- 3. ENFORCE — company-level uniques, FK constraints, indexes
-- =====================================================================

CREATE INDEX "Company_vendorId_active_idx" ON "Company"("vendorId", "active");

CREATE INDEX "Company_vendorId_isDefault_idx" ON "Company"("vendorId", "isDefault");

CREATE UNIQUE INDEX "Company_vendorId_code_key" ON "Company"("vendorId", "code");

CREATE INDEX "CompanySetting_vendorId_idx" ON "CompanySetting"("vendorId");

CREATE INDEX "CompanySetting_companyId_idx" ON "CompanySetting"("companyId");

CREATE UNIQUE INDEX "CompanySetting_companyId_group_key_key" ON "CompanySetting"("companyId", "group", "key");

CREATE INDEX "UserCompanyAccess_vendorId_userId_active_idx" ON "UserCompanyAccess"("vendorId", "userId", "active");

CREATE INDEX "UserCompanyAccess_companyId_idx" ON "UserCompanyAccess"("companyId");

CREATE INDEX "UserCompanyAccess_userId_isDefault_idx" ON "UserCompanyAccess"("userId", "isDefault");

CREATE INDEX "Session_activeCompanyId_idx" ON "Session"("activeCompanyId");

CREATE INDEX "CompanyEvent_companyId_idx" ON "CompanyEvent"("companyId");

CREATE INDEX "ApprovalWorkflow_companyId_idx" ON "ApprovalWorkflow"("companyId");

CREATE UNIQUE INDEX "ApprovalWorkflow_companyId_processType_key" ON "ApprovalWorkflow"("companyId", "processType");

CREATE INDEX "Holiday_companyId_idx" ON "Holiday"("companyId");

CREATE INDEX "Branch_companyId_idx" ON "Branch"("companyId");

CREATE UNIQUE INDEX "Branch_companyId_code_key" ON "Branch"("companyId", "code");

CREATE INDEX "Department_companyId_idx" ON "Department"("companyId");

CREATE UNIQUE INDEX "Department_companyId_code_key" ON "Department"("companyId", "code");

CREATE INDEX "Designation_companyId_idx" ON "Designation"("companyId");

CREATE UNIQUE INDEX "Designation_companyId_code_key" ON "Designation"("companyId", "code");

CREATE INDEX "Shift_companyId_idx" ON "Shift"("companyId");

CREATE INDEX "Employee_companyId_idx" ON "Employee"("companyId");

CREATE UNIQUE INDEX "Employee_companyId_code_key" ON "Employee"("companyId", "code");

CREATE INDEX "AttendanceDevice_companyId_idx" ON "AttendanceDevice"("companyId");

CREATE INDEX "GeoFence_companyId_idx" ON "GeoFence"("companyId");

CREATE INDEX "AttendancePolicy_companyId_idx" ON "AttendancePolicy"("companyId");

CREATE INDEX "LeaveType_companyId_idx" ON "LeaveType"("companyId");

CREATE INDEX "PayrollRun_companyId_idx" ON "PayrollRun"("companyId");

CREATE INDEX "TaxRuleSet_companyId_idx" ON "TaxRuleSet"("companyId");

CREATE INDEX "SalaryTemplate_companyId_idx" ON "SalaryTemplate"("companyId");

CREATE INDEX "AccountJournal_companyId_idx" ON "AccountJournal"("companyId");

CREATE INDEX "ReviewCycle_companyId_idx" ON "ReviewCycle"("companyId");

CREATE INDEX "KpiTemplate_companyId_idx" ON "KpiTemplate"("companyId");

CREATE INDEX "WorkforceSnapshot_companyId_idx" ON "WorkforceSnapshot"("companyId");

CREATE INDEX "Task_companyId_idx" ON "Task"("companyId");

CREATE INDEX "LetterTemplate_companyId_idx" ON "LetterTemplate"("companyId");

CREATE INDEX "CommissionRule_companyId_idx" ON "CommissionRule"("companyId");

CREATE INDEX "Announcement_companyId_idx" ON "Announcement"("companyId");

CREATE INDEX "AitFiscalYear_companyId_idx" ON "AitFiscalYear"("companyId");

CREATE INDEX "Supplier_companyId_idx" ON "Supplier"("companyId");

CREATE INDEX "Warehouse_companyId_idx" ON "Warehouse"("companyId");

CREATE INDEX "Item_companyId_idx" ON "Item"("companyId");

CREATE INDEX "ItemCategory_companyId_idx" ON "ItemCategory"("companyId");

CREATE INDEX "GoodsRequisition_companyId_idx" ON "GoodsRequisition"("companyId");

CREATE INDEX "PurchaseRequest_companyId_idx" ON "PurchaseRequest"("companyId");

CREATE INDEX "Camera_companyId_idx" ON "Camera"("companyId");

CREATE INDEX "Asset_companyId_idx" ON "Asset"("companyId");

CREATE INDEX "VisitLocation_companyId_idx" ON "VisitLocation"("companyId");

-- VisitLocation: name uniqueness moves from vendor level to COMPANY level
-- (two companies may share a location name). Safe after the backfill — every
-- existing row carries its vendor's default company and vendor-unique names
-- remain unique within that company. NULL companyId rows (created between
-- expand and enforce, none in this single-transaction migration) are treated
-- as distinct by PostgreSQL's NULLS DISTINCT default.
DROP INDEX IF EXISTS "VisitLocation_vendorId_name_key";
CREATE UNIQUE INDEX "VisitLocation_companyId_name_key" ON "VisitLocation"("companyId", "name");

CREATE INDEX "JobOpening_companyId_idx" ON "JobOpening"("companyId");

CREATE INDEX "ReportTemplate_companyId_idx" ON "ReportTemplate"("companyId");

CREATE INDEX "AccountingPeriod_companyId_idx" ON "AccountingPeriod"("companyId");

CREATE UNIQUE INDEX "AccountingPeriod_companyId_name_key" ON "AccountingPeriod"("companyId", "name");

CREATE INDEX "CostCenter_companyId_idx" ON "CostCenter"("companyId");

CREATE UNIQUE INDEX "CostCenter_companyId_code_key" ON "CostCenter"("companyId", "code");

CREATE INDEX "Budget_companyId_idx" ON "Budget"("companyId");

ALTER TABLE "Company" ADD CONSTRAINT "Company_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CompanySetting" ADD CONSTRAINT "CompanySetting_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserCompanyAccess" ADD CONSTRAINT "UserCompanyAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserCompanyAccess" ADD CONSTRAINT "UserCompanyAccess_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CompanyEvent" ADD CONSTRAINT "CompanyEvent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ApprovalWorkflow" ADD CONSTRAINT "ApprovalWorkflow_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Holiday" ADD CONSTRAINT "Holiday_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Branch" ADD CONSTRAINT "Branch_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Department" ADD CONSTRAINT "Department_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Designation" ADD CONSTRAINT "Designation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Shift" ADD CONSTRAINT "Shift_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Employee" ADD CONSTRAINT "Employee_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AttendanceDevice" ADD CONSTRAINT "AttendanceDevice_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "GeoFence" ADD CONSTRAINT "GeoFence_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AttendancePolicy" ADD CONSTRAINT "AttendancePolicy_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveType" ADD CONSTRAINT "LeaveType_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TaxRuleSet" ADD CONSTRAINT "TaxRuleSet_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SalaryTemplate" ADD CONSTRAINT "SalaryTemplate_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AccountJournal" ADD CONSTRAINT "AccountJournal_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ReviewCycle" ADD CONSTRAINT "ReviewCycle_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "KpiTemplate" ADD CONSTRAINT "KpiTemplate_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WorkforceSnapshot" ADD CONSTRAINT "WorkforceSnapshot_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Task" ADD CONSTRAINT "Task_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LetterTemplate" ADD CONSTRAINT "LetterTemplate_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CommissionRule" ADD CONSTRAINT "CommissionRule_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Announcement" ADD CONSTRAINT "Announcement_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AitFiscalYear" ADD CONSTRAINT "AitFiscalYear_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Warehouse" ADD CONSTRAINT "Warehouse_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Item" ADD CONSTRAINT "Item_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ItemCategory" ADD CONSTRAINT "ItemCategory_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "GoodsRequisition" ADD CONSTRAINT "GoodsRequisition_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PurchaseRequest" ADD CONSTRAINT "PurchaseRequest_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Camera" ADD CONSTRAINT "Camera_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Asset" ADD CONSTRAINT "Asset_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "VisitLocation" ADD CONSTRAINT "VisitLocation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "JobOpening" ADD CONSTRAINT "JobOpening_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ReportTemplate" ADD CONSTRAINT "ReportTemplate_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AccountingPeriod" ADD CONSTRAINT "AccountingPeriod_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CostCenter" ADD CONSTRAINT "CostCenter_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Budget" ADD CONSTRAINT "Budget_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Partial unique indexes (beyond Prisma's declarative power):
-- exactly ONE default company per vendor; ONE active access per user+company.
CREATE INDEX "ApprovalRequest_companyId_idx" ON "ApprovalRequest"("companyId");
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "PayrollRun_companyId_periodYear_periodMonth_periodWeek_runType_adjustSeq_key" ON "PayrollRun"("companyId", "periodYear", "periodMonth", "periodWeek", "runType", "adjustSeq");
CREATE UNIQUE INDEX "LeaveType_companyId_code_key" ON "LeaveType"("companyId", "code");
CREATE UNIQUE INDEX "ItemCategory_companyId_name_key" ON "ItemCategory"("companyId", "name");
CREATE UNIQUE INDEX "Company_vendorId_isDefault_key" ON "Company" ("vendorId") WHERE "isDefault" = true;
CREATE UNIQUE INDEX "UserCompanyAccess_user_company_active_key" ON "UserCompanyAccess" ("userId", "companyId") WHERE "active" = true;
