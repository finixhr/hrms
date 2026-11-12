-- Employee company transfer: each employment in a company is its own Employee row,
-- linked by CompanyTransfer. Adds nullable columns and one new table; no existing
-- row changes. Sorts before the reserved M4 name 9_wave9zzb, so M4 stays an in-order append.
ALTER TABLE "Employee" ADD COLUMN "serviceStartDate" TEXT;
ALTER TABLE "Employee" ADD COLUMN "transferredOutDate" TEXT;
ALTER TABLE "Employee" ADD COLUMN "transferredToEmployeeId" TEXT;

CREATE TABLE "CompanyTransfer" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "fromEmployeeId" TEXT NOT NULL,
    "toEmployeeId" TEXT,
    "fromCompanyId" TEXT NOT NULL,
    "toCompanyId" TEXT NOT NULL,
    "fromBranchId" TEXT,
    "toBranchId" TEXT NOT NULL,
    "fromDepartmentId" TEXT,
    "toDepartmentId" TEXT,
    "fromDesignationId" TEXT,
    "toDesignationId" TEXT,
    "fromShiftId" TEXT,
    "toShiftId" TEXT,
    "fromManagerId" TEXT,
    "toManagerId" TEXT,
    "fromCode" TEXT NOT NULL,
    "toCode" TEXT NOT NULL,
    "requestedEffectiveDate" TEXT NOT NULL,
    "effectiveDate" TEXT NOT NULL,
    "reason" TEXT,
    "carryLeaveBalances" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT,
    "requestedByName" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "applyError" TEXT,
    "sourceSnapshotJson" TEXT NOT NULL DEFAULT '{}',
    "resultJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyTransfer_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CompanyTransfer_vendorId_status_effectiveDate_idx" ON "CompanyTransfer"("vendorId", "status", "effectiveDate");
CREATE INDEX "CompanyTransfer_fromEmployeeId_idx" ON "CompanyTransfer"("fromEmployeeId");
CREATE INDEX "CompanyTransfer_toEmployeeId_idx" ON "CompanyTransfer"("toEmployeeId");
CREATE INDEX "CompanyTransfer_fromCompanyId_idx" ON "CompanyTransfer"("fromCompanyId");
CREATE INDEX "CompanyTransfer_toCompanyId_idx" ON "CompanyTransfer"("toCompanyId");

ALTER TABLE "CompanyTransfer" ADD CONSTRAINT "CompanyTransfer_fromEmployeeId_fkey" FOREIGN KEY ("fromEmployeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CompanyTransfer" ADD CONSTRAINT "CompanyTransfer_toEmployeeId_fkey" FOREIGN KEY ("toEmployeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CompanyTransfer" ADD CONSTRAINT "CompanyTransfer_fromCompanyId_fkey" FOREIGN KEY ("fromCompanyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CompanyTransfer" ADD CONSTRAINT "CompanyTransfer_toCompanyId_fkey" FOREIGN KEY ("toCompanyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
