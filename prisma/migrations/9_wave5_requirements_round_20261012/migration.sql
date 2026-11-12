-- Requirements round (2026-10-12) — additive migration, safe on existing data:
--   R1  PayrollEntry.recoveryJson (cancel/recreate payroll ledger reversal)
--   R11 Vendor.marketingOptOut + SaasCampaign + SaasCampaignRecipient + SaasCommunicationTemplate
--   R12 SaasInvoice.registrationId (accept-application invoices)
--   R15 SaasExpiryNotice (expiry notice log with dedupe + retry)
--   R16 LoginAuditLog (login attempt audit trail)
-- No existing column is dropped or narrowed; every new column is nullable or
-- defaulted, so the migration is backward compatible with running app versions.

-- R1: exact recovery ledger snapshot for paid entries (null = never paid)
ALTER TABLE "PayrollEntry" ADD COLUMN "recoveryJson" TEXT;

-- R11: tenant marketing consent (transactional notices unaffected)
ALTER TABLE "Vendor" ADD COLUMN "marketingOptOut" BOOLEAN NOT NULL DEFAULT false;

-- R12: link accept-application invoices to the registration
ALTER TABLE "SaaSInvoice" ADD COLUMN "registrationId" TEXT;

-- R16: login audit trail
CREATE TABLE "LoginAuditLog" (
    "id" TEXT NOT NULL,
    "plane" TEXT NOT NULL DEFAULT 'TENANT',
    "email" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL DEFAULT false,
    "failureReason" TEXT,
    "userId" TEXT,
    "userName" TEXT,
    "vendorId" TEXT,
    "vendorName" TEXT,
    "role" TEXT,
    "mfaUsed" BOOLEAN NOT NULL DEFAULT false,
    "ip" TEXT,
    "userAgent" TEXT,
    "browser" TEXT,
    "os" TEXT,
    "deviceType" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LoginAuditLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "LoginAuditLog_vendorId_createdAt_idx" ON "LoginAuditLog"("vendorId", "createdAt");
CREATE INDEX "LoginAuditLog_userId_createdAt_idx" ON "LoginAuditLog"("userId", "createdAt");
CREATE INDEX "LoginAuditLog_email_createdAt_idx" ON "LoginAuditLog"("email", "createdAt");
CREATE INDEX "LoginAuditLog_success_createdAt_idx" ON "LoginAuditLog"("success", "createdAt");

-- R11: owner-plane marketing campaigns
CREATE TABLE "SaaSCampaign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'MARKETING',
    "channel" TEXT NOT NULL DEFAULT 'EMAIL',
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "audienceType" TEXT NOT NULL DEFAULT 'ALL',
    "audienceIds" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "scheduledFor" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "totalRecipients" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "templateId" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SaaSCampaign_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SaaSCampaign_status_scheduledFor_idx" ON "SaaSCampaign"("status", "scheduledFor");
CREATE INDEX "SaaSCampaign_createdAt_idx" ON "SaaSCampaign"("createdAt");

CREATE TABLE "SaaSCampaignRecipient" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "vendorName" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SaaSCampaignRecipient_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SaaSCampaignRecipient_campaignId_vendorId_key" ON "SaaSCampaignRecipient"("campaignId", "vendorId");
CREATE INDEX "SaaSCampaignRecipient_campaignId_status_idx" ON "SaaSCampaignRecipient"("campaignId", "status");
ALTER TABLE "SaaSCampaignRecipient" ADD CONSTRAINT "SaaSCampaignRecipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "SaaSCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SaasCommunicationTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'MARKETING',
    "channel" TEXT NOT NULL DEFAULT 'EMAIL',
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SaasCommunicationTemplate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SaasCommunicationTemplate_kind_active_idx" ON "SaasCommunicationTemplate"("kind", "active");

-- R15: expiry notice log (dedupe key: vendor + kind + refDate + daysOffset + channel)
CREATE TABLE "SaasExpiryNotice" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "refDate" TEXT NOT NULL,
    "daysOffset" INTEGER NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SENT',
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "detail" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SaasExpiryNotice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SaasExpiryNotice_vendorId_kind_refDate_daysOffset_channel_key" ON "SaasExpiryNotice"("vendorId", "kind", "refDate", "daysOffset", "channel");
CREATE INDEX "SaasExpiryNotice_vendorId_sentAt_idx" ON "SaasExpiryNotice"("vendorId", "sentAt");
CREATE INDEX "SaasExpiryNotice_status_sentAt_idx" ON "SaasExpiryNotice"("status", "sentAt");
