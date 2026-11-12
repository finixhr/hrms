/*
  Warnings:

  - You are about to drop the `_archived_LeaveRequest` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `_archived_Loan` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `_archived_PayrollEntry` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
DROP TABLE "_archived_LeaveRequest";

-- DropTable
DROP TABLE "_archived_Loan";

-- DropTable
DROP TABLE "_archived_PayrollEntry";

-- CreateTable
CREATE TABLE "SaaSPlan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tagline" TEXT,
    "description" TEXT,
    "monthlyPrice" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "yearlyPrice" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'BDT',
    "employeeLimit" INTEGER,
    "userLimit" INTEGER,
    "branchLimit" INTEGER,
    "departmentLimit" INTEGER,
    "deviceLimit" INTEGER,
    "storageGb" INTEGER,
    "trackingEmployeeLimit" INTEGER,
    "payrollEnabled" BOOLEAN NOT NULL DEFAULT false,
    "aitEnabled" BOOLEAN NOT NULL DEFAULT false,
    "inventoryEnabled" BOOLEAN NOT NULL DEFAULT false,
    "procurementEnabled" BOOLEAN NOT NULL DEFAULT false,
    "performanceEnabled" BOOLEAN NOT NULL DEFAULT false,
    "essEnabled" BOOLEAN NOT NULL DEFAULT true,
    "cameraEnabled" BOOLEAN NOT NULL DEFAULT false,
    "trackingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "geofenceEnabled" BOOLEAN NOT NULL DEFAULT false,
    "apiAccess" BOOLEAN NOT NULL DEFAULT false,
    "advancedReports" BOOLEAN NOT NULL DEFAULT false,
    "supportLevel" TEXT NOT NULL DEFAULT 'STANDARD',
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "isTrialPlan" BOOLEAN NOT NULL DEFAULT false,
    "badge" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaaSPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaaSSubscription" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "planName" TEXT NOT NULL,
    "billingCycle" TEXT NOT NULL DEFAULT 'MONTHLY',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "startDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endDate" TIMESTAMP(3) NOT NULL,
    "gracePeriodDays" INTEGER NOT NULL DEFAULT 0,
    "priceAtCreation" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "currencySnapshot" TEXT NOT NULL DEFAULT 'BDT',
    "notes" TEXT,
    "createdBy" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaaSSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaaSSubscriptionEvent" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "fromSnapshot" TEXT DEFAULT '{}',
    "toSnapshot" TEXT DEFAULT '{}',
    "note" TEXT,
    "actorId" TEXT,
    "actorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaaSSubscriptionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaaSRegistration" (
    "id" TEXT NOT NULL,
    "applicationNumber" TEXT NOT NULL,
    "organizationName" TEXT NOT NULL,
    "organizationType" TEXT,
    "industry" TEXT,
    "website" TEXT,
    "address" TEXT,
    "city" TEXT,
    "country" TEXT NOT NULL DEFAULT 'Bangladesh',
    "contactNumber" TEXT,
    "officialEmail" TEXT NOT NULL,
    "adminName" TEXT NOT NULL,
    "adminDesignation" TEXT,
    "adminEmail" TEXT NOT NULL,
    "adminPhone" TEXT,
    "adminPasswordHash" TEXT NOT NULL,
    "employeeCount" INTEGER NOT NULL DEFAULT 0,
    "branchCount" INTEGER NOT NULL DEFAULT 1,
    "deviceCount" INTEGER NOT NULL DEFAULT 0,
    "requestedModules" TEXT NOT NULL DEFAULT '[]',
    "planId" TEXT,
    "planName" TEXT,
    "billingCycle" TEXT NOT NULL DEFAULT 'MONTHLY',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "internalNote" TEXT,
    "reviewNote" TEXT,
    "rejectionReason" TEXT,
    "reviewedById" TEXT,
    "reviewedByName" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "requestedInfoAt" TIMESTAMP(3),
    "approvedVendorId" TEXT,
    "subscriptionId" TEXT,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'WEBSITE',
    "submitIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaaSRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaaSTenantOverride" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "featureToggles" TEXT NOT NULL DEFAULT '{}',
    "storageGbOverride" INTEGER,
    "note" TEXT,
    "updatedById" TEXT,
    "updatedByName" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaaSTenantOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaaSOwnerUser" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "roleKey" TEXT NOT NULL DEFAULT 'ADMINISTRATOR',
    "permissions" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastLoginAt" TIMESTAMP(3),
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaaSOwnerUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaaSOwnerSession" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "csrfToken" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaaSOwnerSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaaSAuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "actorName" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "vendorId" TEXT,
    "summary" TEXT NOT NULL,
    "metadata" TEXT DEFAULT '{}',
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaaSAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaaSSetting" (
    "id" TEXT NOT NULL,
    "group" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaaSSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaaSContactInquiry" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "company" TEXT,
    "inquiryType" TEXT NOT NULL DEFAULT 'SALES',
    "organizationSize" TEXT,
    "modulesRequested" TEXT NOT NULL DEFAULT '[]',
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "handledById" TEXT,
    "handledByName" TEXT,
    "handleNote" TEXT,
    "handledAt" TIMESTAMP(3),
    "submitIp" TEXT,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaaSContactInquiry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaaSInvoice" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "number" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BDT',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "paymentMethod" TEXT,
    "transactionId" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaaSInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaaSPayment" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BDT',
    "method" TEXT,
    "transactionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PAID',
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedById" TEXT,
    "recordedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaaSPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SaaSPlan_active_isPublic_sortOrder_idx" ON "SaaSPlan"("active", "isPublic", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "SaaSSubscription_vendorId_key" ON "SaaSSubscription"("vendorId");

-- CreateIndex
CREATE INDEX "SaaSSubscription_status_endDate_idx" ON "SaaSSubscription"("status", "endDate");

-- CreateIndex
CREATE INDEX "SaaSSubscription_planId_idx" ON "SaaSSubscription"("planId");

-- CreateIndex
CREATE INDEX "SaaSSubscriptionEvent_vendorId_createdAt_idx" ON "SaaSSubscriptionEvent"("vendorId", "createdAt");

-- CreateIndex
CREATE INDEX "SaaSSubscriptionEvent_subscriptionId_idx" ON "SaaSSubscriptionEvent"("subscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "SaaSRegistration_applicationNumber_key" ON "SaaSRegistration"("applicationNumber");

-- CreateIndex
CREATE INDEX "SaaSRegistration_status_createdAt_idx" ON "SaaSRegistration"("status", "createdAt");

-- CreateIndex
CREATE INDEX "SaaSRegistration_adminEmail_idx" ON "SaaSRegistration"("adminEmail");

-- CreateIndex
CREATE INDEX "SaaSRegistration_officialEmail_idx" ON "SaaSRegistration"("officialEmail");

-- CreateIndex
CREATE UNIQUE INDEX "SaaSTenantOverride_vendorId_key" ON "SaaSTenantOverride"("vendorId");

-- CreateIndex
CREATE INDEX "SaaSTenantOverride_vendorId_idx" ON "SaaSTenantOverride"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "SaaSOwnerUser_email_key" ON "SaaSOwnerUser"("email");

-- CreateIndex
CREATE INDEX "SaaSOwnerUser_status_idx" ON "SaaSOwnerUser"("status");

-- CreateIndex
CREATE INDEX "SaaSOwnerSession_ownerId_idx" ON "SaaSOwnerSession"("ownerId");

-- CreateIndex
CREATE INDEX "SaaSAuditLog_createdAt_idx" ON "SaaSAuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "SaaSAuditLog_entity_entityId_idx" ON "SaaSAuditLog"("entity", "entityId");

-- CreateIndex
CREATE INDEX "SaaSAuditLog_vendorId_createdAt_idx" ON "SaaSAuditLog"("vendorId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SaaSSetting_group_key_key" ON "SaaSSetting"("group", "key");

-- CreateIndex
CREATE INDEX "SaaSContactInquiry_status_createdAt_idx" ON "SaaSContactInquiry"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SaaSInvoice_number_key" ON "SaaSInvoice"("number");

-- CreateIndex
CREATE INDEX "SaaSInvoice_vendorId_status_idx" ON "SaaSInvoice"("vendorId", "status");

-- CreateIndex
CREATE INDEX "SaaSPayment_vendorId_idx" ON "SaaSPayment"("vendorId");

-- AddForeignKey
ALTER TABLE "SaaSSubscription" ADD CONSTRAINT "SaaSSubscription_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaaSSubscription" ADD CONSTRAINT "SaaSSubscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SaaSPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaaSSubscriptionEvent" ADD CONSTRAINT "SaaSSubscriptionEvent_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "SaaSSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaaSRegistration" ADD CONSTRAINT "SaaSRegistration_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SaaSPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaaSOwnerSession" ADD CONSTRAINT "SaaSOwnerSession_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "SaaSOwnerUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaaSInvoice" ADD CONSTRAINT "SaaSInvoice_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "SaaSSubscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaaSPayment" ADD CONSTRAINT "SaaSPayment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SaaSInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
