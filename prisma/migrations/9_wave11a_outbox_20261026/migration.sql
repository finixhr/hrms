-- Wave 11 (2026-10-26 scalability round, master prompt §4) — transactional outbox.
-- Fully additive: one new table, two indexes, zero column changes, zero data
-- changes. Matches prisma/schema.prisma model OutboxEvent exactly (verify with
-- `bun run check:migrations` / `prisma migrate diff` before deploying).

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "vendorId" TEXT,
    "payloadJson" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OutboxEvent_status_nextAttemptAt_createdAt_idx" ON "OutboxEvent"("status", "nextAttemptAt", "createdAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_type_vendorId_idx" ON "OutboxEvent"("type", "vendorId");
