-- Phase R7 feature parity — AnnouncementRead (COM-02), LetterRequest (LTR-01),
-- letter verification codes (LTR-02), rehire linkage (EXT-05), consecutive-day
-- leave caps (LVE-113) and multi-reviewer input (PRF-01). All additive.

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN "priorEmployeeId" TEXT;
ALTER TABLE "HrLetter" ADD COLUMN "verificationCode" TEXT;
ALTER TABLE "LeaveType" ADD COLUMN "maxConsecutiveDays" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PerformanceReview" ADD COLUMN "inputsJson" TEXT NOT NULL DEFAULT '{}';

-- CreateTable (COM-02)
CREATE TABLE "AnnouncementRead" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "announcementId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnnouncementRead_pkey" PRIMARY KEY ("id")
);

-- CreateTable (LTR-01)
CREATE TABLE "LetterRequest" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "letterId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LetterRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Employee_vendorId_priorEmployeeId_idx" ON "Employee"("vendorId", "priorEmployeeId");
CREATE INDEX "HrLetter_vendorId_verificationCode_idx" ON "HrLetter"("vendorId", "verificationCode");
CREATE INDEX "AnnouncementRead_vendorId_announcementId_idx" ON "AnnouncementRead"("vendorId", "announcementId");
CREATE UNIQUE INDEX "AnnouncementRead_vendorId_announcementId_userId_key" ON "AnnouncementRead"("vendorId", "announcementId", "userId");
CREATE INDEX "LetterRequest_vendorId_status_idx" ON "LetterRequest"("vendorId", "status");
CREATE INDEX "LetterRequest_vendorId_employeeId_idx" ON "LetterRequest"("vendorId", "employeeId");
