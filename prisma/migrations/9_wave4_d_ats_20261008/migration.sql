-- =====================================================================
-- Wave 4 (2026-10-08) — WP-D: recruitment ATS depth.
--   JobInterview — scheduled interviews per application with outcome.
--   OfferLetter — offer records with salary breakdown, printable via the
--     existing letters/ReportShell machinery.
--   OnboardingTask — post-hire checklist items (mirrors the Wave-2
--     onboarding module's shape so the two interoperate).
-- Sorts after 9_wave4_c_….
-- =====================================================================

CREATE TABLE "JobInterview" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "round" TEXT NOT NULL DEFAULT 'R1',
    "mode" TEXT NOT NULL DEFAULT 'ONSITE',
    "scheduledAt" TEXT NOT NULL,
    "durationMin" INTEGER,
    "interviewerId" TEXT,
    "interviewerName" TEXT,
    "location" TEXT,
    "link" TEXT,
    "notes" TEXT,
    "outcome" TEXT,
    "score" DOUBLE PRECISION,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JobInterview_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "JobInterview_vendorId_applicationId_idx" ON "JobInterview" ("vendorId", "applicationId");
CREATE INDEX "JobInterview_vendorId_scheduledAt_idx" ON "JobInterview" ("vendorId", "scheduledAt");

CREATE TABLE "OfferLetter" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "grade" TEXT,
    "department" TEXT,
    "joiningDate" TEXT,
    "basicSalary" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "houseRent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "medical" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "transport" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "otherAllowance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "sentAt" TIMESTAMP,
    "decidedAt" TIMESTAMP,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OfferLetter_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OfferLetter_vendorId_applicationId_idx" ON "OfferLetter" ("vendorId", "applicationId");
CREATE INDEX "OfferLetter_vendorId_status_idx" ON "OfferLetter" ("vendorId", "status");

CREATE TABLE "OnboardingTask" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "applicationId" TEXT,
    "employeeId" TEXT,
    "title" TEXT NOT NULL,
    "assigneeId" TEXT,
    "assigneeName" TEXT,
    "dueDate" TEXT,
    "doneAt" TIMESTAMP,
    "doneById" TEXT,
    "doneByName" TEXT,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OnboardingTask_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OnboardingTask_vendorId_applicationId_idx" ON "OnboardingTask" ("vendorId", "applicationId");
CREATE INDEX "OnboardingTask_vendorId_doneAt_idx" ON "OnboardingTask" ("vendorId", "doneAt");
