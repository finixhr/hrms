-- Phase 3 (FIN-077 structural fix) — the monthly workforce snapshot series.
-- Fully additive: one new table + unique per (vendor, year, month) + a range
-- index, zero column changes, zero data changes. Matches prisma/schema.prisma
-- model WorkforceSnapshot exactly (verify with `bun run check:migrations`).

-- CreateTable: WorkforceSnapshot
CREATE TABLE "WorkforceSnapshot" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "periodYear" INTEGER NOT NULL,
    "periodMonth" INTEGER NOT NULL,
    "headcountTotal" INTEGER NOT NULL DEFAULT 0,
    "headcountActive" INTEGER NOT NULL DEFAULT 0,
    "newJoiners" INTEGER NOT NULL DEFAULT 0,
    "exits" INTEGER NOT NULL DEFAULT 0,
    "avgTenureMonths" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkforceSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkforceSnapshot_vendorId_periodYear_periodMonth_key" ON "WorkforceSnapshot"("vendorId", "periodYear", "periodMonth");
CREATE INDEX "WorkforceSnapshot_vendorId_periodYear_periodMonth_idx" ON "WorkforceSnapshot"("vendorId", "periodYear", "periodMonth");
