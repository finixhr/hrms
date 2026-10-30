-- =====================================================================
-- Wave 4 (2026-10-08) — WP-C: tenant public REST API + webhooks.
--   ApiKey — hashed bearer keys for /api/v1/* (prefix shown, sha256 stored,
--     scoped to the vendor, revocable, last-used tracked).
--   WebhookEndpoint — tenant outbound webhooks (URL + events + HMAC secret,
--     encrypted at rest by the caller via the M-36 crypto-field machinery).
--   WebhookDelivery — per-attempt delivery log with response status and
--     exponential-backoff retry bookkeeping driven by the jobs tick.
-- Sorts after 9_wave4_b_….
-- =====================================================================

CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "scopesJson" TEXT NOT NULL DEFAULT '[]',
    "lastUsedAt" TIMESTAMP,
    "revokedAt" TIMESTAMP,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ApiKey_vendorId_prefix_key" ON "ApiKey" ("vendorId", "prefix");
CREATE INDEX "ApiKey_vendorId_revokedAt_idx" ON "ApiKey" ("vendorId", "revokedAt");

CREATE TABLE "WebhookEndpoint" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "eventsJson" TEXT NOT NULL DEFAULT '[]',
    "secret" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "lastStatus" TEXT,
    "lastDeliveredAt" TIMESTAMP,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WebhookEndpoint_vendorId_active_idx" ON "WebhookEndpoint" ("vendorId", "active");

CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "responseStatus" INTEGER,
    "responseBody" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP,
    "deliveredAt" TIMESTAMP,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WebhookDelivery_vendorId_status_idx" ON "WebhookDelivery" ("vendorId", "status");
CREATE INDEX "WebhookDelivery_status_nextAttemptAt_idx" ON "WebhookDelivery" ("status", "nextAttemptAt");
CREATE INDEX "WebhookDelivery_vendorId_createdAt_idx" ON "WebhookDelivery" ("vendorId", "createdAt");
