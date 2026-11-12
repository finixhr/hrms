-- Phase 5 P6 (WS-C) — Web Push subscriptions (RFC 8030/8291)
-- Additive only: one new table, zero changes to existing tables.

-- CreateTable: PushSubscription (per-browser/device push endpoint, owned by a user)
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'web',
    "lastSuccessAt" TIMESTAMP(3),
    "lastErrorAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");
CREATE INDEX "PushSubscription_vendorId_userId_idx" ON "PushSubscription"("vendorId", "userId");
CREATE INDEX "PushSubscription_vendorId_idx" ON "PushSubscription"("vendorId");
