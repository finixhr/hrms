-- Phase 3 (FIN-048) — KPI assignment-level score + rating columns.
-- Fully additive: the overall score/rating move from a mislabeled per-item
-- field inside resultsJson to real KpiAssignment columns; scoreBasisJson
-- records the normalization basis when configured weights do not sum to 100.
-- Matches prisma/schema.prisma exactly.

-- AlterTable
ALTER TABLE "KpiAssignment" ADD COLUMN "totalScore" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "KpiAssignment" ADD COLUMN "rating" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "KpiAssignment" ADD COLUMN "scoreBasisJson" TEXT;
