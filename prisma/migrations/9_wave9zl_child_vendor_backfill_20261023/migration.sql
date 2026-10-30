-- Phase R5 / DB-02 — child tables carry their tenant explicitly.
-- The 15 child models (family/education/referee/prev-employment/bank children
-- of Employee; TaxSlab under TaxRuleSet; LoanInstallment under Loan;
-- ApprovalStep under ApprovalWorkflow; ApprovalAction under ApprovalRequest;
-- CommunicationRecipient under CommunicationLog; the five procurement/stock
-- line items) previously relied on 100% application discipline for isolation.
-- This migration stamps every child row with its vendor, backfilling from the
-- parent, then makes the column NOT NULL and swaps the child-scoped indexes
-- for tenant-scoped ones (plus three structural uniques that make cross-tenant
-- writes collide):
--   ApprovalStep  (vendorId, workflowId, sequence)
--   LoanInstallment (vendorId, loanId, no)     [widened from (loanId, no)]
--   TaxSlab       (vendorId, ruleSetId, minIncome)
-- Order matters on databases WITH existing rows: add nullable → backfill →
-- SET NOT NULL. An orphan child (parent row missing) leaves vendorId NULL and
-- the SET NOT NULL fails LOUDLY — the intended behavior (never silently
-- mis-scope); on a fresh database every step is a no-op over empty tables.

-- AlterTable (step 1: nullable add)
ALTER TABLE "ApprovalAction" ADD COLUMN "vendorId" TEXT;
ALTER TABLE "ApprovalStep" ADD COLUMN "vendorId" TEXT;
ALTER TABLE "BankAccount" ADD COLUMN "vendorId" TEXT;
ALTER TABLE "CommunicationRecipient" ADD COLUMN "vendorId" TEXT;
ALTER TABLE "Education" ADD COLUMN "vendorId" TEXT;
ALTER TABLE "FamilyMember" ADD COLUMN "vendorId" TEXT;
ALTER TABLE "GoodsRequisitionHistory" ADD COLUMN "vendorId" TEXT;
ALTER TABLE "GoodsRequisitionItem" ADD COLUMN "vendorId" TEXT;
ALTER TABLE "LoanInstallment" ADD COLUMN "vendorId" TEXT;
ALTER TABLE "PreviousEmployment" ADD COLUMN "vendorId" TEXT;
ALTER TABLE "PurchaseQuotationItem" ADD COLUMN "vendorId" TEXT;
ALTER TABLE "PurchaseRequestItem" ADD COLUMN "vendorId" TEXT;
ALTER TABLE "Referee" ADD COLUMN "vendorId" TEXT;
ALTER TABLE "StockEntryItem" ADD COLUMN "vendorId" TEXT;
ALTER TABLE "TaxSlab" ADD COLUMN "vendorId" TEXT;

-- Backfill (step 2): vendorId from the parent row. FK columns match the
-- Prisma relation declarations; global cuid ids make parent matches exact.
UPDATE "ApprovalAction" c SET "vendorId" = p."vendorId" FROM "ApprovalRequest" p WHERE c."requestId" = p."id";
UPDATE "ApprovalStep" c SET "vendorId" = p."vendorId" FROM "ApprovalWorkflow" p WHERE c."workflowId" = p."id";
UPDATE "BankAccount" c SET "vendorId" = p."vendorId" FROM "Employee" p WHERE c."employeeId" = p."id";
UPDATE "CommunicationRecipient" c SET "vendorId" = p."vendorId" FROM "CommunicationLog" p WHERE c."logId" = p."id";
UPDATE "Education" c SET "vendorId" = p."vendorId" FROM "Employee" p WHERE c."employeeId" = p."id";
UPDATE "FamilyMember" c SET "vendorId" = p."vendorId" FROM "Employee" p WHERE c."employeeId" = p."id";
UPDATE "GoodsRequisitionHistory" c SET "vendorId" = p."vendorId" FROM "GoodsRequisition" p WHERE c."requisitionId" = p."id";
UPDATE "GoodsRequisitionItem" c SET "vendorId" = p."vendorId" FROM "GoodsRequisition" p WHERE c."requisitionId" = p."id";
UPDATE "LoanInstallment" c SET "vendorId" = p."vendorId" FROM "Loan" p WHERE c."loanId" = p."id";
UPDATE "PreviousEmployment" c SET "vendorId" = p."vendorId" FROM "Employee" p WHERE c."employeeId" = p."id";
UPDATE "PurchaseQuotationItem" c SET "vendorId" = p."vendorId" FROM "PurchaseQuotation" p WHERE c."quotationId" = p."id";
UPDATE "PurchaseRequestItem" c SET "vendorId" = p."vendorId" FROM "PurchaseRequest" p WHERE c."purchaseId" = p."id";
UPDATE "Referee" c SET "vendorId" = p."vendorId" FROM "Employee" p WHERE c."employeeId" = p."id";
UPDATE "StockEntryItem" c SET "vendorId" = p."vendorId" FROM "StockEntry" p WHERE c."entryId" = p."id";
UPDATE "TaxSlab" c SET "vendorId" = p."vendorId" FROM "TaxRuleSet" p WHERE c."ruleSetId" = p."id";

-- Not-null (step 3): fails loudly on orphaned children (see header).
ALTER TABLE "ApprovalAction" ALTER COLUMN "vendorId" SET NOT NULL;
ALTER TABLE "ApprovalStep" ALTER COLUMN "vendorId" SET NOT NULL;
ALTER TABLE "BankAccount" ALTER COLUMN "vendorId" SET NOT NULL;
ALTER TABLE "CommunicationRecipient" ALTER COLUMN "vendorId" SET NOT NULL;
ALTER TABLE "Education" ALTER COLUMN "vendorId" SET NOT NULL;
ALTER TABLE "FamilyMember" ALTER COLUMN "vendorId" SET NOT NULL;
ALTER TABLE "GoodsRequisitionHistory" ALTER COLUMN "vendorId" SET NOT NULL;
ALTER TABLE "GoodsRequisitionItem" ALTER COLUMN "vendorId" SET NOT NULL;
ALTER TABLE "LoanInstallment" ALTER COLUMN "vendorId" SET NOT NULL;
ALTER TABLE "PreviousEmployment" ALTER COLUMN "vendorId" SET NOT NULL;
ALTER TABLE "PurchaseQuotationItem" ALTER COLUMN "vendorId" SET NOT NULL;
ALTER TABLE "PurchaseRequestItem" ALTER COLUMN "vendorId" SET NOT NULL;
ALTER TABLE "Referee" ALTER COLUMN "vendorId" SET NOT NULL;
ALTER TABLE "StockEntryItem" ALTER COLUMN "vendorId" SET NOT NULL;
ALTER TABLE "TaxSlab" ALTER COLUMN "vendorId" SET NOT NULL;

-- DropIndex (step 4): child-scoped predecessors, canonical names
DROP INDEX "ApprovalAction_requestId_idx";
DROP INDEX "ApprovalStep_workflowId_idx";
DROP INDEX "BankAccount_employeeId_idx";
DROP INDEX "BankAccount_employeeId_isSalaryPayoutAccount_idx";
DROP INDEX "CommunicationRecipient_logId_idx";
DROP INDEX "Education_employeeId_idx";
DROP INDEX "FamilyMember_employeeId_idx";
DROP INDEX "GoodsRequisitionHistory_requisitionId_createdAt_idx";
DROP INDEX "GoodsRequisitionItem_requisitionId_idx";
DROP INDEX "LoanInstallment_loanId_no_key";
DROP INDEX "PreviousEmployment_employeeId_idx";
DROP INDEX "PurchaseQuotationItem_quotationId_idx";
DROP INDEX "PurchaseRequestItem_purchaseId_idx";
DROP INDEX "Referee_employeeId_idx";
DROP INDEX "StockEntryItem_entryId_idx";
DROP INDEX "TaxSlab_ruleSetId_idx";

-- CreateIndex (step 5): tenant-scoped replacements + structural uniques
CREATE INDEX "ApprovalAction_vendorId_requestId_idx" ON "ApprovalAction"("vendorId", "requestId");
CREATE INDEX "ApprovalStep_vendorId_workflowId_idx" ON "ApprovalStep"("vendorId", "workflowId");
CREATE UNIQUE INDEX "ApprovalStep_vendorId_workflowId_sequence_key" ON "ApprovalStep"("vendorId", "workflowId", "sequence");
CREATE INDEX "BankAccount_vendorId_employeeId_idx" ON "BankAccount"("vendorId", "employeeId");
CREATE INDEX "BankAccount_vendorId_employeeId_isSalaryPayoutAccount_idx" ON "BankAccount"("vendorId", "employeeId", "isSalaryPayoutAccount");
CREATE INDEX "CommunicationRecipient_vendorId_logId_idx" ON "CommunicationRecipient"("vendorId", "logId");
CREATE INDEX "Education_vendorId_employeeId_idx" ON "Education"("vendorId", "employeeId");
CREATE INDEX "FamilyMember_vendorId_employeeId_idx" ON "FamilyMember"("vendorId", "employeeId");
CREATE INDEX "GoodsRequisitionHistory_vendorId_requisitionId_createdAt_idx" ON "GoodsRequisitionHistory"("vendorId", "requisitionId", "createdAt");
CREATE INDEX "GoodsRequisitionItem_vendorId_requisitionId_idx" ON "GoodsRequisitionItem"("vendorId", "requisitionId");
CREATE INDEX "LoanInstallment_vendorId_loanId_idx" ON "LoanInstallment"("vendorId", "loanId");
CREATE UNIQUE INDEX "LoanInstallment_vendorId_loanId_no_key" ON "LoanInstallment"("vendorId", "loanId", "no");
CREATE INDEX "PreviousEmployment_vendorId_employeeId_idx" ON "PreviousEmployment"("vendorId", "employeeId");
CREATE INDEX "PurchaseQuotationItem_vendorId_quotationId_idx" ON "PurchaseQuotationItem"("vendorId", "quotationId");
CREATE INDEX "PurchaseRequestItem_vendorId_purchaseId_idx" ON "PurchaseRequestItem"("vendorId", "purchaseId");
CREATE INDEX "Referee_vendorId_employeeId_idx" ON "Referee"("vendorId", "employeeId");
CREATE INDEX "StockEntryItem_vendorId_entryId_idx" ON "StockEntryItem"("vendorId", "entryId");
CREATE INDEX "TaxSlab_vendorId_ruleSetId_idx" ON "TaxSlab"("vendorId", "ruleSetId");
CREATE UNIQUE INDEX "TaxSlab_vendorId_ruleSetId_minIncome_key" ON "TaxSlab"("vendorId", "ruleSetId", "minIncome");
