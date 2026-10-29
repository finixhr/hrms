-- =====================================================================
-- Wave 4 (2026-10-08) — WP-B: accounting depth.
--   AccountingPeriod — soft period closing: manual voucher writes are
--     refused for dates inside a CLOSED period (posted history untouched).
--   CostCenter — vendor-scoped cost center register; AccountJournal gains
--     an optional costCenterId tag for reporting dimensions.
--   Budget — amount ceiling per account code (optionally per cost center
--     and period) with variance computed against posted journals.
-- Additive-only; all new columns nullable/defaulted so existing rows and
-- auto-generated journals are unaffected. Sorts after 9_wave4_a_….
-- =====================================================================

CREATE TABLE "AccountingPeriod" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" TEXT NOT NULL,
    "endDate" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "closedById" TEXT,
    "closedByName" TEXT,
    "closedAt" TIMESTAMP,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AccountingPeriod_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AccountingPeriod_vendorId_name_key" ON "AccountingPeriod" ("vendorId", "name");
CREATE INDEX "AccountingPeriod_vendorId_startDate_idx" ON "AccountingPeriod" ("vendorId", "startDate");

CREATE TABLE "CostCenter" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CostCenter_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CostCenter_vendorId_code_key" ON "CostCenter" ("vendorId", "code");

CREATE TABLE "Budget" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "periodId" TEXT,
    "costCenterId" TEXT,
    "accountCode" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "notes" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Budget_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Budget_vendorId_periodId_idx" ON "Budget" ("vendorId", "periodId");
CREATE INDEX "Budget_vendorId_accountCode_idx" ON "Budget" ("vendorId", "accountCode");

-- Optional cost-center tag on manual vouchers (NULL = unassigned, which is
-- every pre-existing and auto-generated journal).
ALTER TABLE "AccountJournal" ADD COLUMN "costCenterId" TEXT;
CREATE INDEX "AccountJournal_vendorId_costCenterId_idx" ON "AccountJournal" ("vendorId", "costCenterId");
