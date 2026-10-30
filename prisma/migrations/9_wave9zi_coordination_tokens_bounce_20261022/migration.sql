-- Phase 3 (this audit) — WS-B / WS-D / WS-E coordination + mobile tokens + bounce list
-- Additive only: three new tables, zero changes to existing tables.

-- CreateTable: CoordinationLock (SCL-21 — distributed locks, Postgres fallback backend)
CREATE TABLE "CoordinationLock" (
    "key" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoordinationLock_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "CoordinationLock_expiresAt_idx" ON "CoordinationLock"("expiresAt");

-- CreateTable: ApiRefreshToken (MOB-1 — mobile/client refresh tokens, rotation families)
CREATE TABLE "ApiRefreshToken" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "scopesJson" TEXT NOT NULL DEFAULT '[]',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiRefreshToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ApiRefreshToken_tokenHash_key" ON "ApiRefreshToken"("tokenHash");
CREATE INDEX "ApiRefreshToken_familyId_idx" ON "ApiRefreshToken"("familyId");
CREATE INDEX "ApiRefreshToken_userId_idx" ON "ApiRefreshToken"("userId");
CREATE INDEX "ApiRefreshToken_vendorId_idx" ON "ApiRefreshToken"("vendorId");

-- CreateTable: CampaignBounce (OPS-5 — bounce suppression list for campaigns)
CREATE TABLE "CampaignBounce" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "bounceCount" INTEGER NOT NULL DEFAULT 1,
    "reason" TEXT,
    "lastBounceAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignBounce_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CampaignBounce_channel_address_key" ON "CampaignBounce"("channel", "address");
CREATE INDEX "CampaignBounce_channel_lastBounceAt_idx" ON "CampaignBounce"("channel", "lastBounceAt");
