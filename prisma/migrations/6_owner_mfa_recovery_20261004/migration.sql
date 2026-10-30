-- Owner console MFA (TOTP) + self-service password recovery + pre-auth session kinds
-- Purely additive: no drops, no renames. Mirrors the tenant MFA discipline
-- (UserMfaSecret shape) on the platform plane, with strict table separation.

-- AlterTable: SaaSOwnerUser — MFA flag + password-reset token columns
ALTER TABLE "SaaSOwnerUser" ADD COLUMN "mfaEnrolled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SaaSOwnerUser" ADD COLUMN "passwordResetToken" TEXT;
ALTER TABLE "SaaSOwnerUser" ADD COLUMN "passwordResetExpiresAt" TIMESTAMP(3);
ALTER TABLE "SaaSOwnerUser" ADD COLUMN "passwordResetRequestedAt" TIMESTAMP(3);

-- CreateTable: owner TOTP secrets (encrypted at rest, plane-isolated)
CREATE TABLE "SaaSOwnerMfaSecret" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "secretEnc" TEXT NOT NULL,
    "recoveryCodesHash" TEXT NOT NULL DEFAULT '[]',
    "lastUsedCounter" INTEGER,
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaaSOwnerMfaSecret_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SaaSOwnerMfaSecret_ownerId_key" ON "SaaSOwnerMfaSecret"("ownerId");
CREATE INDEX "SaaSOwnerMfaSecret_ownerId_idx" ON "SaaSOwnerMfaSecret"("ownerId");

-- AddForeignKey (cascade: deleting an owner user drops their MFA secret)
ALTER TABLE "SaaSOwnerMfaSecret" ADD CONSTRAINT "SaaSOwnerMfaSecret_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "SaaSOwnerUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: SaaSOwnerSession — pre-auth challenge kinds (FULL | MFA_PENDING | ENROLL_PENDING)
ALTER TABLE "SaaSOwnerSession" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'FULL';
