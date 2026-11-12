-- Phase 3 (FIN-010) — exit cancellation & reinstatement.
-- Fully additive: three nullable columns on "Resignation" for the audited
-- cancellation decision (who, when, why). The CANCELLED status/closureStatus
-- values ride the existing String columns (vocabulary comments updated in
-- schema.prisma). Zero data changes. Matches prisma/schema.prisma exactly
-- (verify with `bun run check:migrations` / `prisma migrate diff`).

-- AlterTable
ALTER TABLE "Resignation" ADD COLUMN "cancelledAt" TIMESTAMP(3);
ALTER TABLE "Resignation" ADD COLUMN "cancelledBy" TEXT;
ALTER TABLE "Resignation" ADD COLUMN "cancelReason" TEXT;
