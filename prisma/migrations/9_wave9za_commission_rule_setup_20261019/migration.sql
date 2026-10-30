-- =====================================================================
-- Wave 10b (2026-10-19) — Commission Rule Setup feature
--
-- Adds comprehensive commission calculation rules, approved thresholds,
-- bulk threshold imports, and calculation audit logs.
-- =====================================================================

-- AlterTable
ALTER TABLE "CommissionRule" ADD COLUMN     "approvalRequestId" TEXT,
ADD COLUMN     "approvedBy" TEXT,
ADD COLUMN     "calculationPeriod" TEXT NOT NULL DEFAULT 'MONTHLY',
ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "departmentId" TEXT,
ADD COLUMN     "distributionMethod" TEXT,
ADD COLUMN     "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "effectiveTo" TIMESTAMP(3),
ADD COLUMN     "flatMethod" TEXT,
ADD COLUMN     "minServicePeriodUnit" TEXT NOT NULL DEFAULT 'MONTHS',
ADD COLUMN     "minServicePeriodValue" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "percentMethod" TEXT,
ADD COLUMN     "requireBranchTarget" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "requireDeptTarget" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "requireEmpTarget" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "requireTotalTarget" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "CommissionThreshold" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "targetName" TEXT,
    "thresholdAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'APPROVED',
    "importId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommissionThreshold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionThresholdImport" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "validRows" INTEGER NOT NULL DEFAULT 0,
    "invalidRows" INTEGER NOT NULL DEFAULT 0,
    "rowsJson" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "approvalRequestId" TEXT,
    "uploadedBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "actedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommissionThresholdImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionCalculationLog" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "ruleName" TEXT NOT NULL,
    "ruleVersion" INTEGER NOT NULL DEFAULT 1,
    "periodMonth" INTEGER,
    "periodYear" INTEGER NOT NULL,
    "calculationPeriod" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "employeeName" TEXT NOT NULL,
    "employeeCode" TEXT,
    "eligibleRevenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "targetRevenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "targetTypeApplied" TEXT,
    "basis" TEXT NOT NULL,
    "calculationMethod" TEXT NOT NULL,
    "rate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "distributionMethod" TEXT,
    "baseCalculatedAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "capApplied" BOOLEAN NOT NULL DEFAULT false,
    "capAmount" DOUBLE PRECISION,
    "finalCommissionAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "bonusId" TEXT,
    "payrollEntryId" TEXT,
    "calculatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommissionCalculationLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommissionThreshold_vendorId_ruleId_idx" ON "CommissionThreshold"("vendorId", "ruleId");

-- CreateIndex
CREATE INDEX "CommissionThreshold_ruleId_targetType_targetId_idx" ON "CommissionThreshold"("ruleId", "targetType", "targetId");

-- CreateIndex
CREATE INDEX "CommissionThreshold_vendorId_status_idx" ON "CommissionThreshold"("vendorId", "status");

-- CreateIndex
CREATE INDEX "CommissionThresholdImport_vendorId_ruleId_idx" ON "CommissionThresholdImport"("vendorId", "ruleId");

-- CreateIndex
CREATE INDEX "CommissionThresholdImport_vendorId_status_idx" ON "CommissionThresholdImport"("vendorId", "status");

-- CreateIndex
CREATE INDEX "CommissionCalculationLog_vendorId_ruleId_idx" ON "CommissionCalculationLog"("vendorId", "ruleId");

-- CreateIndex
CREATE INDEX "CommissionCalculationLog_vendorId_employeeId_periodYear_per_idx" ON "CommissionCalculationLog"("vendorId", "employeeId", "periodYear", "periodMonth");

-- CreateIndex
CREATE INDEX "CommissionCalculationLog_vendorId_bonusId_idx" ON "CommissionCalculationLog"("vendorId", "bonusId");

-- CreateIndex
CREATE INDEX "CommissionRule_vendorId_active_idx" ON "CommissionRule"("vendorId", "active");

-- CreateIndex
CREATE INDEX "CommissionRule_vendorId_calculationPeriod_idx" ON "CommissionRule"("vendorId", "calculationPeriod");

-- AddForeignKey
ALTER TABLE "CommissionThreshold" ADD CONSTRAINT "CommissionThreshold_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "CommissionRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionThreshold" ADD CONSTRAINT "CommissionThreshold_importId_fkey" FOREIGN KEY ("importId") REFERENCES "CommissionThresholdImport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionThresholdImport" ADD CONSTRAINT "CommissionThresholdImport_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "CommissionRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
