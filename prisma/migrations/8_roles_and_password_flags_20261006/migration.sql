-- Owner-console Roles & Permissions management + first-login forced password
-- change flag. Purely additive: no drops, no renames, no data mutations —
-- existing production rows keep their defaults (mustChangePassword=false keeps
-- every current login behavior unchanged).

-- AlterTable: "User" — first-login forced password rotation flag (employee
-- self-service onboarding / admin password reset both set it; changePassword
-- clears it). Independent of the 90-day expiry policy so forced rotation
-- works even when password expiry is disabled for the tenant.
ALTER TABLE "User" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable: owner-console role definitions (Owner Console → Roles &
-- Permissions). The 5 built-in template roles are seeded lazily by the app on
-- first access (isSystem=true); custom roles are isSystem=false.
CREATE TABLE "SaaSOwnerRole" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "permissions" TEXT NOT NULL DEFAULT '[]',
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaaSOwnerRole_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SaaSOwnerRole_key_key" ON "SaaSOwnerRole"("key");
CREATE INDEX "SaaSOwnerRole_active_idx" ON "SaaSOwnerRole"("active");
