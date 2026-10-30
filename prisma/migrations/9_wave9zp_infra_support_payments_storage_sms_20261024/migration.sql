-- Wave 10 — INFRASTRUCTURE ROUND (2026-10-24)
-- Forward-only, additive migration. No existing column is altered and no
-- data is rewritten: four new tables (Support Access sessions, SMS delivery
-- journal, OTP verifiers, cloud-storage object metadata) plus one index on
-- SaaSPayment for provider-session lookup (the EPS adapter resolves payment
-- rows by the session reference its merchant-portal IPN carries).
--
-- Non-negotiables honored (master prompt §9): unique transaction/idempotency
-- keys, explicit status columns (string unions — this schema uses NO Prisma
-- enums by convention), tenant ownership (vendorId) on tenant-plane rows,
-- consistent timestamps, and preserved referential integrity. No applied
-- migration is edited; production data is untouched.

-- ---- Phase 2 — Support Access sessions --------------------------------------
-- CreateTable
CREATE TABLE "SaasSupportAccessSession" (
    "id" TEXT NOT NULL,
    "targetVendorId" TEXT NOT NULL,
    "targetVendorName" TEXT NOT NULL,
    "operatorOwnerId" TEXT NOT NULL,
    "operatorName" TEXT NOT NULL,
    "operatorRoleKey" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "ticketRef" TEXT,
    "accessMode" TEXT NOT NULL DEFAULT 'READ_ONLY',
    "scopeJson" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "enterTokenHash" TEXT,
    "enterExpiresAt" TIMESTAMP(3),
    "sessionTokenHash" TEXT,
    "csrfToken" TEXT,
    "requestedMinutes" INTEGER NOT NULL DEFAULT 15,
    "startedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "endedReason" TEXT,
    "endedById" TEXT,
    "endedByName" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaasSupportAccessSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SaasSupportAccessSession_enterTokenHash_key" ON "SaasSupportAccessSession"("enterTokenHash");
-- CreateIndex
CREATE UNIQUE INDEX "SaasSupportAccessSession_sessionTokenHash_key" ON "SaasSupportAccessSession"("sessionTokenHash");
-- CreateIndex
CREATE INDEX "SaasSupportAccessSession_targetVendorId_createdAt_idx" ON "SaasSupportAccessSession"("targetVendorId", "createdAt");
-- CreateIndex
CREATE INDEX "SaasSupportAccessSession_operatorOwnerId_createdAt_idx" ON "SaasSupportAccessSession"("operatorOwnerId", "createdAt");
-- CreateIndex
CREATE INDEX "SaasSupportAccessSession_status_expiresAt_idx" ON "SaasSupportAccessSession"("status", "expiresAt");

-- ---- Phase 6 — SMS delivery journal -----------------------------------------
-- CreateTable
CREATE TABLE "SaasSmsMessage" (
    "id" TEXT NOT NULL,
    "plane" TEXT NOT NULL DEFAULT 'TENANT',
    "vendorId" TEXT,
    "toPhone" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "templateKey" TEXT,
    "bodyLength" INTEGER NOT NULL DEFAULT 0,
    "bodyPreview" TEXT,
    "provider" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "statusDetail" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaasSmsMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SaasSmsMessage_vendorId_createdAt_idx" ON "SaasSmsMessage"("vendorId", "createdAt");
-- CreateIndex
CREATE INDEX "SaasSmsMessage_plane_status_createdAt_idx" ON "SaasSmsMessage"("plane", "status", "createdAt");
-- CreateIndex
CREATE INDEX "SaasSmsMessage_provider_providerMessageId_idx" ON "SaasSmsMessage"("provider", "providerMessageId");

-- ---- Phase 6 — OTP verifiers --------------------------------------------------
-- CreateTable
CREATE TABLE "SaasOtpCode" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'SMS',
    "purpose" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "salt" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "consumedAt" TIMESTAMP(3),
    "vendorId" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaasOtpCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SaasOtpCode_identifier_purpose_createdAt_idx" ON "SaasOtpCode"("identifier", "purpose", "createdAt");
-- CreateIndex
CREATE INDEX "SaasOtpCode_expiresAt_idx" ON "SaasOtpCode"("expiresAt");

-- ---- Phase 4 — cloud object storage metadata ---------------------------------
-- CreateTable
CREATE TABLE "StorageObject" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "sha256" TEXT,
    "status" TEXT NOT NULL DEFAULT 'STORED',
    "refTable" TEXT,
    "refId" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorageObject_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StorageObject_objectKey_key" ON "StorageObject"("objectKey");
-- CreateIndex
CREATE INDEX "StorageObject_vendorId_kind_idx" ON "StorageObject"("vendorId", "kind");
-- CreateIndex
CREATE INDEX "StorageObject_status_idx" ON "StorageObject"("status");

-- ---- Phase 3 — provider-session lookup for gateway adapters (EPS IPN) -------
-- CreateIndex
CREATE INDEX "SaaSPayment_provider_sessionId_idx" ON "SaaSPayment"("provider", "sessionId");
