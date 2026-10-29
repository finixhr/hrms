-- AlterTable
ALTER TABLE "User" ADD COLUMN     "designPreference" TEXT;

-- AlterTable
ALTER TABLE "SaaSPlan" ADD COLUMN     "billingMode" TEXT NOT NULL DEFAULT 'RECURRING',
ADD COLUMN     "customForVendorId" TEXT,
ADD COLUMN     "isCustom" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "oneTimeValidityDays" INTEGER;

-- AlterTable
ALTER TABLE "SaaSSubscription" ADD COLUMN     "billingMode" TEXT NOT NULL DEFAULT 'RECURRING',
ALTER COLUMN "endDate" DROP NOT NULL;

-- AlterTable
ALTER TABLE "SaaSOwnerUser" ADD COLUMN     "designPreference" TEXT;

-- AlterTable
ALTER TABLE "SaaSInvoice" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'TERM',
ADD COLUMN     "upgradePlanId" TEXT;

-- AlterTable
ALTER TABLE "SaasSupportAccessSession" ADD COLUMN     "approvedModulesJson" TEXT NOT NULL DEFAULT '[]',
ADD COLUMN     "liveRequestId" TEXT;

-- CreateTable
CREATE TABLE "SaasSupportTicket" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'GENERAL',
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "requesterUserId" TEXT NOT NULL,
    "requesterName" TEXT NOT NULL,
    "assigneeOwnerId" TEXT,
    "assigneeName" TEXT,
    "firstResponseAt" TIMESTAMP(3),
    "lastMessageAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "closedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaasSupportTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaasSupportMessage" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "authorRole" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "attachmentsJson" TEXT NOT NULL DEFAULT '[]',
    "internalNote" BOOLEAN NOT NULL DEFAULT false,
    "readByTenantAt" TIMESTAMP(3),
    "readBySupportAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaasSupportMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaasLiveSupportRequest" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "ticketId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'GENERAL',
    "modulesJson" TEXT NOT NULL DEFAULT '[]',
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "contextNote" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
    "requestedByUserId" TEXT NOT NULL,
    "requestedByName" TEXT NOT NULL,
    "reviewedByOwnerId" TEXT,
    "reviewedByName" TEXT,
    "reviewNote" TEXT,
    "approvedModulesJson" TEXT,
    "approvedMinutes" INTEGER,
    "approvedAgentOwnerId" TEXT,
    "approvedAgentName" TEXT,
    "activatedSessionId" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaasLiveSupportRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebAuthnCredential" (
    "id" TEXT NOT NULL,
    "plane" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "vendorId" TEXT,
    "credentialId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT,
    "deviceName" TEXT NOT NULL DEFAULT 'Passkey',
    "backupEligible" BOOLEAN NOT NULL DEFAULT false,
    "backupState" BOOLEAN NOT NULL DEFAULT false,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebAuthnCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebAuthnChallenge" (
    "id" TEXT NOT NULL,
    "plane" TEXT NOT NULL,
    "userId" TEXT,
    "challenge" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebAuthnChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SaasSupportTicket_number_key" ON "SaasSupportTicket"("number");

-- CreateIndex
CREATE INDEX "SaasSupportTicket_vendorId_status_updatedAt_idx" ON "SaasSupportTicket"("vendorId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "SaasSupportTicket_status_priority_createdAt_idx" ON "SaasSupportTicket"("status", "priority", "createdAt");

-- CreateIndex
CREATE INDEX "SaasSupportTicket_assigneeOwnerId_idx" ON "SaasSupportTicket"("assigneeOwnerId");

-- CreateIndex
CREATE INDEX "SaasSupportMessage_ticketId_createdAt_idx" ON "SaasSupportMessage"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "SaasLiveSupportRequest_vendorId_status_createdAt_idx" ON "SaasLiveSupportRequest"("vendorId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "SaasLiveSupportRequest_status_priority_createdAt_idx" ON "SaasLiveSupportRequest"("status", "priority", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebAuthnCredential_credentialId_key" ON "WebAuthnCredential"("credentialId");

-- CreateIndex
CREATE INDEX "WebAuthnCredential_plane_userId_idx" ON "WebAuthnCredential"("plane", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "WebAuthnCredential_plane_userId_credentialId_key" ON "WebAuthnCredential"("plane", "userId", "credentialId");

-- CreateIndex
CREATE INDEX "WebAuthnChallenge_plane_userId_expiresAt_idx" ON "WebAuthnChallenge"("plane", "userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "SaasSupportAccessSession_liveRequestId_key" ON "SaasSupportAccessSession"("liveRequestId");

-- AddForeignKey
ALTER TABLE "SaasSupportMessage" ADD CONSTRAINT "SaasSupportMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "SaasSupportTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

