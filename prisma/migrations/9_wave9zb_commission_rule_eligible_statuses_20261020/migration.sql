-- AlterTable
ALTER TABLE "CommissionRule" ADD COLUMN     "eligibleStatuses" TEXT NOT NULL DEFAULT '["ACTIVE","PROBATION"]',
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "CommissionThreshold" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "CommissionThresholdImport" ALTER COLUMN "updatedAt" DROP DEFAULT;
