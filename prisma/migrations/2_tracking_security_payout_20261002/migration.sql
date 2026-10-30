-- 20261002_tracking_security_payout — Live Tracking + Secure Geo-Fence/Selfie
-- Attendance + Multiple Check-In + Salary Payout & Dynamic Salary Export round.
--
-- ADDITIVE ONLY (requirements §83): no existing table is dropped or restructured;
-- historical rows are never converted or rewritten.
--
-- New tables:
--   GeoFence                  reusable fence entity (Branch geofence fields stay
--                             as legacy defaults; active branch fences are
--                             backfilled below so admins don't recreate them)
--   AttendancePolicy          dynamic policy engine (TRACKING / MANDATORY_GPS /
--                             MULTIPLE_CHECKIN / ATTENDANCE_METHOD) with schedule
--   AttendancePolicyAssignment scope-based assignment (EMPLOYEE > DEPARTMENT >
--                             BRANCH > ALL_EMPLOYEES priority, resolved server-side)
--   AttendancePolicyGeoFence  policy ↔ fence many-to-many
--   AttendanceEvent           immutable normalized event layer (append-only)
--   AttendanceProof           private selfie evidence (audited access route)
--   TrackingPoint             append-only location telemetry history
--   EmployeeTrackingState     current-state row per tracked employee (live map)
--
-- Altered tables:
--   Employee               + salaryPayoutMethod / salaryPayoutAccountId
--   BankAccount            + isSalaryPayoutAccount (exactly-one designation;
--                          isPrimary is NOT treated as payout designation)
--   AttendanceRawEvent     + attendanceEventId (punch → event provenance link)

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "salaryPayoutAccountId" TEXT,
ADD COLUMN     "salaryPayoutMethod" TEXT;

-- AlterTable
ALTER TABLE "BankAccount" ADD COLUMN     "isSalaryPayoutAccount" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "AttendanceRawEvent" ADD COLUMN     "attendanceEventId" TEXT;

-- CreateTable
CREATE TABLE "GeoFence" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "branchId" TEXT,
    "type" TEXT NOT NULL DEFAULT 'CIRCLE',
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "radiusM" DOUBLE PRECISION NOT NULL DEFAULT 150,
    "geometryJson" TEXT NOT NULL DEFAULT '{}',
    "startTime" TEXT,
    "endTime" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "migratedFromBranch" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GeoFence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendancePolicy" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "policyType" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "startDate" TEXT,
    "endDate" TEXT,
    "startTime" TEXT,
    "endTime" TEXT,
    "daysOfWeek" TEXT NOT NULL DEFAULT 'SUNDAY,MONDAY,TUESDAY,WEDNESDAY,THURSDAY',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Dhaka',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "configJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttendancePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendancePolicyAssignment" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendancePolicyAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendancePolicyGeoFence" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "geoFenceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendancePolicyGeoFence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceEvent" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "attendanceMethod" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'WEB',
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clientTimestamp" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "accuracyM" DOUBLE PRECISION,
    "altitude" DOUBLE PRECISION,
    "speed" DOUBLE PRECISION,
    "heading" DOUBLE PRECISION,
    "batteryPercentage" INTEGER,
    "isCharging" BOOLEAN,
    "gpsStatus" TEXT,
    "networkStatus" TEXT,
    "geoFenceId" TEXT,
    "distanceFromGeoFenceM" DOUBLE PRECISION,
    "locationIntegrityStatus" TEXT,
    "deviceId" TEXT,
    "mobileSessionId" TEXT,
    "selfieProofId" TEXT,
    "attendanceId" TEXT,
    "policyId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACCEPTED',
    "reviewStatus" TEXT NOT NULL DEFAULT 'NONE',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reason" TEXT,
    "flagsJson" TEXT NOT NULL DEFAULT '{}',
    "clientEventId" TEXT,
    "rawEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceProof" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "attendanceEventId" TEXT,
    "proofType" TEXT NOT NULL DEFAULT 'SELFIE',
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'image/jpeg',
    "fileHash" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL DEFAULT 0,
    "data" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "accuracyM" DOUBLE PRECISION,
    "deviceId" TEXT,
    "verificationStatus" TEXT NOT NULL DEFAULT 'EVIDENCE',
    "retentionUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceProof_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackingPoint" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "deviceId" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "clientTimestamp" TEXT,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "accuracyM" DOUBLE PRECISION,
    "altitude" DOUBLE PRECISION,
    "speed" DOUBLE PRECISION,
    "heading" DOUBLE PRECISION,
    "batteryPercentage" INTEGER,
    "isCharging" BOOLEAN,
    "gpsStatus" TEXT,
    "networkStatus" TEXT,
    "trackingSessionId" TEXT,
    "locationIntegrityStatus" TEXT,
    "clientEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackingPoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeTrackingState" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "deviceId" TEXT,
    "trackingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "trackingStatus" TEXT NOT NULL DEFAULT 'OFFLINE',
    "lastSeenAt" TIMESTAMP(3),
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "accuracyM" DOUBLE PRECISION,
    "batteryPercentage" INTEGER,
    "isCharging" BOOLEAN,
    "gpsStatus" TEXT,
    "networkStatus" TEXT,
    "geoFenceId" TEXT,
    "insideGeoFence" BOOLEAN,
    "lastEventId" TEXT,
    "lastPolicyId" TEXT,
    "sessionStartedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeTrackingState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GeoFence_vendorId_active_idx" ON "GeoFence"("vendorId", "active");

-- CreateIndex
CREATE INDEX "GeoFence_vendorId_branchId_idx" ON "GeoFence"("vendorId", "branchId");

-- CreateIndex
CREATE INDEX "AttendancePolicy_vendorId_policyType_active_idx" ON "AttendancePolicy"("vendorId", "policyType", "active");

-- CreateIndex
CREATE INDEX "AttendancePolicyAssignment_vendorId_scopeType_scopeId_idx" ON "AttendancePolicyAssignment"("vendorId", "scopeType", "scopeId");

-- CreateIndex
CREATE INDEX "AttendancePolicyAssignment_vendorId_policyId_idx" ON "AttendancePolicyAssignment"("vendorId", "policyId");

-- CreateIndex
CREATE INDEX "AttendancePolicyGeoFence_vendorId_geoFenceId_idx" ON "AttendancePolicyGeoFence"("vendorId", "geoFenceId");

-- CreateIndex
CREATE UNIQUE INDEX "AttendancePolicyGeoFence_policyId_geoFenceId_key" ON "AttendancePolicyGeoFence"("policyId", "geoFenceId");

-- CreateIndex
CREATE INDEX "AttendanceEvent_vendorId_employeeId_occurredAt_idx" ON "AttendanceEvent"("vendorId", "employeeId", "occurredAt");

-- CreateIndex
CREATE INDEX "AttendanceEvent_vendorId_occurredAt_idx" ON "AttendanceEvent"("vendorId", "occurredAt");

-- CreateIndex
CREATE INDEX "AttendanceEvent_vendorId_employeeId_eventType_idx" ON "AttendanceEvent"("vendorId", "employeeId", "eventType");

-- CreateIndex
CREATE INDEX "AttendanceEvent_vendorId_status_reviewStatus_idx" ON "AttendanceEvent"("vendorId", "status", "reviewStatus");

-- CreateIndex
CREATE INDEX "AttendanceEvent_vendorId_locationIntegrityStatus_idx" ON "AttendanceEvent"("vendorId", "locationIntegrityStatus");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceEvent_vendorId_clientEventId_key" ON "AttendanceEvent"("vendorId", "clientEventId");

-- CreateIndex
CREATE INDEX "AttendanceProof_vendorId_employeeId_capturedAt_idx" ON "AttendanceProof"("vendorId", "employeeId", "capturedAt");

-- CreateIndex
CREATE INDEX "AttendanceProof_vendorId_retentionUntil_idx" ON "AttendanceProof"("vendorId", "retentionUntil");

-- CreateIndex
CREATE INDEX "TrackingPoint_vendorId_employeeId_timestamp_idx" ON "TrackingPoint"("vendorId", "employeeId", "timestamp");

-- CreateIndex
CREATE INDEX "TrackingPoint_vendorId_timestamp_idx" ON "TrackingPoint"("vendorId", "timestamp");

-- CreateIndex
CREATE INDEX "TrackingPoint_deviceId_timestamp_idx" ON "TrackingPoint"("deviceId", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "TrackingPoint_vendorId_clientEventId_key" ON "TrackingPoint"("vendorId", "clientEventId");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeTrackingState_employeeId_key" ON "EmployeeTrackingState"("employeeId");

-- CreateIndex
CREATE INDEX "EmployeeTrackingState_vendorId_trackingStatus_idx" ON "EmployeeTrackingState"("vendorId", "trackingStatus");

-- CreateIndex
CREATE INDEX "EmployeeTrackingState_vendorId_trackingEnabled_idx" ON "EmployeeTrackingState"("vendorId", "trackingEnabled");

-- CreateIndex
CREATE INDEX "BankAccount_employeeId_isSalaryPayoutAccount_idx" ON "BankAccount"("employeeId", "isSalaryPayoutAccount");

-- AddForeignKey
ALTER TABLE "AttendancePolicyAssignment" ADD CONSTRAINT "AttendancePolicyAssignment_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "AttendancePolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendancePolicyGeoFence" ADD CONSTRAINT "AttendancePolicyGeoFence_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "AttendancePolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendancePolicyGeoFence" ADD CONSTRAINT "AttendancePolicyGeoFence_geoFenceId_fkey" FOREIGN KEY ("geoFenceId") REFERENCES "GeoFence"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================ DATA MIGRATION (requirements §84) ============================

-- Backfill 1 — payout designation for legacy bank accounts: an employee with
-- EXACTLY ONE account gets it designated as the salary payout account (the
-- isPrimary row when several exist stays undesignated — admins choose via the
-- new Salary & Payout UI; multi-account employees are never auto-picked).
UPDATE "BankAccount" ba SET "isSalaryPayoutAccount" = true
WHERE (
  SELECT COUNT(*) FROM "BankAccount" b2 WHERE b2."employeeId" = ba."employeeId"
) = 1;

-- Backfill 2 — employee payout method from the designated account (BANK/MFS/CASH
-- only; OTHER accounts leave the method unconfigured).
UPDATE "Employee" e
SET "salaryPayoutMethod" = ba."paymentMethod",
    "salaryPayoutAccountId" = ba."id"
FROM "BankAccount" ba
WHERE ba."employeeId" = e."id"
  AND ba."isSalaryPayoutAccount" = true
  AND ba."paymentMethod" IN ('BANK', 'MFS', 'CASH');

-- Backfill 3 — existing Branch geo-fences become first-class GeoFence rows
-- (requirements §69: existing configured branches keep working; no manual
-- recreation required). Branch fields themselves remain untouched.
INSERT INTO "GeoFence" ("id", "vendorId", "name", "branchId", "type", "latitude", "longitude",
                        "radiusM", "geometryJson", "startTime", "endTime", "active",
                        "migratedFromBranch", "createdAt", "updatedAt")
SELECT md5(random()::text || clock_timestamp()::text),
       b."vendorId",
       b."name" || ' — branch fence',
       b."id",
       'CIRCLE',
       b."latitude",
       b."longitude",
       b."geofenceRadius",
       '{}',
       b."geofenceStartTime",
       b."geofenceEndTime",
       true,
       true,
       now(),
       now()
FROM "Branch" b
WHERE b."geofenceActive" = true
  AND b."latitude" IS NOT NULL
  AND b."longitude" IS NOT NULL
  AND b."geofenceRadius" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "GeoFence" g WHERE g."branchId" = b."id");
