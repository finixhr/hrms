-- =====================================================================
-- Selfie Attendance gap round (G1–G4) — 2026-10-03
-- Closes the schema gap for the in-app selfie capture surface, device
-- binding (G2) and explicit consent records (G3). Additive-only: no
-- column is dropped or narrowed, existing rows keep their meaning.
-- Applied on top of 3_audit_remediation_20261002.
-- =====================================================================

-- ---- G1: capture-provenance metadata on AttendanceProof ----------------
-- qualityJson holds the in-app camera capture report ({score, method,
-- faceDetected, faceRatio, brightness, sharpness, width, height,
-- bytesApprox}). It is EVIDENCE METADATA ONLY: reviewers see it as
-- context and it NEVER flips verificationStatus (§27 — a selfie is proof
-- of presence, not an identity check). Backfilled to '{}' for existing
-- proofs (they were captured through the legacy file-picker path, which
-- reported no quality signals).
ALTER TABLE "AttendanceProof" ADD COLUMN "qualityJson" TEXT NOT NULL DEFAULT '{}';

-- ---- G3: explicit consent records --------------------------------------
-- One row per accepted policy version; the exact agreed TEXT is hashed
-- (textHash) so a later policy edit cannot retro-fit consent. Consent
-- NEVER blocks a punch (§27): a missing acknowledgment is surfaced for HR
-- follow-up only. re-consent = a NEW row, never an overwrite.
CREATE TABLE "EmployeeConsent" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'SELFIE_ATTENDANCE',
    "version" TEXT NOT NULL,
    "textHash" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL DEFAULT 'ESS_PORTAL',
    "ip" TEXT,
    "userAgent" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeConsent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EmployeeConsent_vendorId_employeeId_purpose_version_key"
    ON "EmployeeConsent"("vendorId", "employeeId", "purpose", "version");
CREATE INDEX "EmployeeConsent_vendorId_employeeId_purpose_idx"
    ON "EmployeeConsent"("vendorId", "employeeId", "purpose");
CREATE INDEX "EmployeeConsent_vendorId_acceptedAt_idx"
    ON "EmployeeConsent"("vendorId", "acceptedAt");

-- ---- G2: employee ↔ device enrollment registry -------------------------
-- A mobile punch carries deviceId; DEVICE_MISMATCH already flags a change
-- mid-day, but without an enrollment concept there was no "register this
-- phone", no device cap and no admin revoke. Enforcement is driven by the
-- AttendanceMethod policy config `deviceBinding` (OFF / ADVISORY / STRICT).
-- keyHash is the sha-256 of a server-issued enrolment secret (never the
-- raw device id) so a cloned deviceId alone cannot impersonate the phone.
CREATE TABLE "EmployeeDevice" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "label" TEXT,
    "platform" TEXT,
    "userAgent" TEXT,
    "keyHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enrolledIp" TEXT,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "lastSeenIp" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "revokeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeDevice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EmployeeDevice_vendorId_employeeId_deviceId_key"
    ON "EmployeeDevice"("vendorId", "employeeId", "deviceId");
CREATE INDEX "EmployeeDevice_vendorId_employeeId_status_idx"
    ON "EmployeeDevice"("vendorId", "employeeId", "status");
CREATE INDEX "EmployeeDevice_vendorId_deviceId_idx"
    ON "EmployeeDevice"("vendorId", "deviceId");
