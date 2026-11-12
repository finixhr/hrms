-- FIN-017 (Phase 2): employee-child relation migration (audit finding FIN-017).
-- The company gating of every employee-child model (50 of them) ran through
-- scopedEmployeeWhere's MATERIALIZED employee-id IN-lists: for large tenants
-- (5k-50k employees) every list query carried thousands to tens of thousands
-- of bind parameters — slower queries, PgBouncer pressure, and a march toward
-- Postgres' ~32k single-statement parameter limit, past which queries FAIL.
--
-- This migration establishes the physical relations the relation-filter
-- variant (scopedEmployeeRelationWhere) needs:
--   · FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT
--     ON UPDATE CASCADE for the 47 models that carried the column without the
--     constraint (LeaveRequest/Loan/PayrollEntry already had it — their
--     pattern is followed exactly). RESTRICT = archive-first semantics: an
--     employee with history cannot be hard-deleted at the DB layer.
--   · NOT VALID + VALIDATE: the constraint is added without a full-table
--     lock, then validated (the orphan pre-flight below guarantees VALIDATE
--     passes).
--   · (vendorId, employeeId) indexes for the six tables that had NO
--     employeeId-serving index (User, AttendanceCorrection,
--     CommunicationRecipient, InventoryItemSerial, GoodsReceiptConfirmation,
--     OnboardingTask) — the relation JOIN and the FK checks need a probe path.
--
-- ORPHAN PRE-FLIGHT (fail-fast, never silent): rows whose employeeId points
-- at a missing Employee are already invisible to every scoped query today
-- (the scope only ever contains live employees); a migration must not
-- silently keep them, and must not delete them. The pre-flight REFUSES to
-- run with a pointed message; repair the orphans first (typically: the
-- employee was hard-deleted historically — decide per row, then re-run).
DO $$
DECLARE
  t text;
  orphans bigint;
BEGIN
  FOREACH t IN ARRAY ARRAY['User','Notification','ShiftAssignment','FamilyMember','Education','Referee','PreviousEmployment','BankAccount','EmployeeDocument','EmployeeHistory','Promotion','Transfer','SalaryRevision','Attendance','AttendanceDeviceUser','AttendanceRawEvent','AttendanceCorrection','AttendanceEvent','AttendanceProof','EmployeeConsent','EmployeeDevice','TrackingPoint','EmployeeTrackingState','LeaveBalance','SalaryStructure','Bonus','Deduction','Advance','ExpenseClaim','PerformanceReview','KpiAssignment','KpiAchievement','KpiApprovalAction','HrLetter','Resignation','CommissionCalculationLog','LetterRequest','CommunicationRecipient','PfEnrollment','PfContribution','AitCalculationLog','InventoryItemSerial','GoodsReceiptConfirmation','AssetAssignment','VisitPlan','Visit','OnboardingTask'] LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I c WHERE c.%I IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Employee" e WHERE e."id" = c.%I)',
      t, 'employeeId', 'employeeId'
    ) INTO orphans;
    IF orphans > 0 THEN
      RAISE EXCEPTION 'FIN-017 pre-flight: % orphaned employeeId rows in % reference missing Employee rows — repair them before migrating (never deleted silently by this migration)', orphans, t;
    END IF;
  END LOOP;
END $$;


-- User
ALTER TABLE "User" ADD CONSTRAINT "User_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "User" VALIDATE CONSTRAINT "User_employeeId_fkey";

-- Notification
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "Notification" VALIDATE CONSTRAINT "Notification_employeeId_fkey";

-- ShiftAssignment
ALTER TABLE "ShiftAssignment" ADD CONSTRAINT "ShiftAssignment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ShiftAssignment" VALIDATE CONSTRAINT "ShiftAssignment_employeeId_fkey";

-- FamilyMember
ALTER TABLE "FamilyMember" ADD CONSTRAINT "FamilyMember_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "FamilyMember" VALIDATE CONSTRAINT "FamilyMember_employeeId_fkey";

-- Education
ALTER TABLE "Education" ADD CONSTRAINT "Education_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "Education" VALIDATE CONSTRAINT "Education_employeeId_fkey";

-- Referee
ALTER TABLE "Referee" ADD CONSTRAINT "Referee_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "Referee" VALIDATE CONSTRAINT "Referee_employeeId_fkey";

-- PreviousEmployment
ALTER TABLE "PreviousEmployment" ADD CONSTRAINT "PreviousEmployment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "PreviousEmployment" VALIDATE CONSTRAINT "PreviousEmployment_employeeId_fkey";

-- BankAccount
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "BankAccount" VALIDATE CONSTRAINT "BankAccount_employeeId_fkey";

-- EmployeeDocument
ALTER TABLE "EmployeeDocument" ADD CONSTRAINT "EmployeeDocument_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "EmployeeDocument" VALIDATE CONSTRAINT "EmployeeDocument_employeeId_fkey";

-- EmployeeHistory
ALTER TABLE "EmployeeHistory" ADD CONSTRAINT "EmployeeHistory_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "EmployeeHistory" VALIDATE CONSTRAINT "EmployeeHistory_employeeId_fkey";

-- Promotion
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "Promotion" VALIDATE CONSTRAINT "Promotion_employeeId_fkey";

-- Transfer
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "Transfer" VALIDATE CONSTRAINT "Transfer_employeeId_fkey";

-- SalaryRevision
ALTER TABLE "SalaryRevision" ADD CONSTRAINT "SalaryRevision_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "SalaryRevision" VALIDATE CONSTRAINT "SalaryRevision_employeeId_fkey";

-- Attendance
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "Attendance" VALIDATE CONSTRAINT "Attendance_employeeId_fkey";

-- AttendanceDeviceUser
ALTER TABLE "AttendanceDeviceUser" ADD CONSTRAINT "AttendanceDeviceUser_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "AttendanceDeviceUser" VALIDATE CONSTRAINT "AttendanceDeviceUser_employeeId_fkey";

-- AttendanceRawEvent
ALTER TABLE "AttendanceRawEvent" ADD CONSTRAINT "AttendanceRawEvent_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "AttendanceRawEvent" VALIDATE CONSTRAINT "AttendanceRawEvent_employeeId_fkey";

-- AttendanceCorrection
ALTER TABLE "AttendanceCorrection" ADD CONSTRAINT "AttendanceCorrection_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "AttendanceCorrection" VALIDATE CONSTRAINT "AttendanceCorrection_employeeId_fkey";

-- AttendanceEvent
ALTER TABLE "AttendanceEvent" ADD CONSTRAINT "AttendanceEvent_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "AttendanceEvent" VALIDATE CONSTRAINT "AttendanceEvent_employeeId_fkey";

-- AttendanceProof
ALTER TABLE "AttendanceProof" ADD CONSTRAINT "AttendanceProof_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "AttendanceProof" VALIDATE CONSTRAINT "AttendanceProof_employeeId_fkey";

-- EmployeeConsent
ALTER TABLE "EmployeeConsent" ADD CONSTRAINT "EmployeeConsent_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "EmployeeConsent" VALIDATE CONSTRAINT "EmployeeConsent_employeeId_fkey";

-- EmployeeDevice
ALTER TABLE "EmployeeDevice" ADD CONSTRAINT "EmployeeDevice_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "EmployeeDevice" VALIDATE CONSTRAINT "EmployeeDevice_employeeId_fkey";

-- TrackingPoint
ALTER TABLE "TrackingPoint" ADD CONSTRAINT "TrackingPoint_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "TrackingPoint" VALIDATE CONSTRAINT "TrackingPoint_employeeId_fkey";

-- EmployeeTrackingState
ALTER TABLE "EmployeeTrackingState" ADD CONSTRAINT "EmployeeTrackingState_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "EmployeeTrackingState" VALIDATE CONSTRAINT "EmployeeTrackingState_employeeId_fkey";

-- LeaveBalance
ALTER TABLE "LeaveBalance" ADD CONSTRAINT "LeaveBalance_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "LeaveBalance" VALIDATE CONSTRAINT "LeaveBalance_employeeId_fkey";

-- SalaryStructure
ALTER TABLE "SalaryStructure" ADD CONSTRAINT "SalaryStructure_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "SalaryStructure" VALIDATE CONSTRAINT "SalaryStructure_employeeId_fkey";

-- Bonus
ALTER TABLE "Bonus" ADD CONSTRAINT "Bonus_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "Bonus" VALIDATE CONSTRAINT "Bonus_employeeId_fkey";

-- Deduction
ALTER TABLE "Deduction" ADD CONSTRAINT "Deduction_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "Deduction" VALIDATE CONSTRAINT "Deduction_employeeId_fkey";

-- Advance
ALTER TABLE "Advance" ADD CONSTRAINT "Advance_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "Advance" VALIDATE CONSTRAINT "Advance_employeeId_fkey";

-- ExpenseClaim
ALTER TABLE "ExpenseClaim" ADD CONSTRAINT "ExpenseClaim_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ExpenseClaim" VALIDATE CONSTRAINT "ExpenseClaim_employeeId_fkey";

-- PerformanceReview
ALTER TABLE "PerformanceReview" ADD CONSTRAINT "PerformanceReview_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "PerformanceReview" VALIDATE CONSTRAINT "PerformanceReview_employeeId_fkey";

-- KpiAssignment
ALTER TABLE "KpiAssignment" ADD CONSTRAINT "KpiAssignment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "KpiAssignment" VALIDATE CONSTRAINT "KpiAssignment_employeeId_fkey";

-- KpiAchievement
ALTER TABLE "KpiAchievement" ADD CONSTRAINT "KpiAchievement_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "KpiAchievement" VALIDATE CONSTRAINT "KpiAchievement_employeeId_fkey";

-- KpiApprovalAction
ALTER TABLE "KpiApprovalAction" ADD CONSTRAINT "KpiApprovalAction_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "KpiApprovalAction" VALIDATE CONSTRAINT "KpiApprovalAction_employeeId_fkey";

-- HrLetter
ALTER TABLE "HrLetter" ADD CONSTRAINT "HrLetter_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "HrLetter" VALIDATE CONSTRAINT "HrLetter_employeeId_fkey";

-- Resignation
ALTER TABLE "Resignation" ADD CONSTRAINT "Resignation_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "Resignation" VALIDATE CONSTRAINT "Resignation_employeeId_fkey";

-- CommissionCalculationLog
ALTER TABLE "CommissionCalculationLog" ADD CONSTRAINT "CommissionCalculationLog_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "CommissionCalculationLog" VALIDATE CONSTRAINT "CommissionCalculationLog_employeeId_fkey";

-- LetterRequest
ALTER TABLE "LetterRequest" ADD CONSTRAINT "LetterRequest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "LetterRequest" VALIDATE CONSTRAINT "LetterRequest_employeeId_fkey";

-- CommunicationRecipient
ALTER TABLE "CommunicationRecipient" ADD CONSTRAINT "CommunicationRecipient_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "CommunicationRecipient" VALIDATE CONSTRAINT "CommunicationRecipient_employeeId_fkey";

-- PfEnrollment
ALTER TABLE "PfEnrollment" ADD CONSTRAINT "PfEnrollment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "PfEnrollment" VALIDATE CONSTRAINT "PfEnrollment_employeeId_fkey";

-- PfContribution
ALTER TABLE "PfContribution" ADD CONSTRAINT "PfContribution_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "PfContribution" VALIDATE CONSTRAINT "PfContribution_employeeId_fkey";

-- AitCalculationLog
ALTER TABLE "AitCalculationLog" ADD CONSTRAINT "AitCalculationLog_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "AitCalculationLog" VALIDATE CONSTRAINT "AitCalculationLog_employeeId_fkey";

-- InventoryItemSerial
ALTER TABLE "InventoryItemSerial" ADD CONSTRAINT "InventoryItemSerial_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "InventoryItemSerial" VALIDATE CONSTRAINT "InventoryItemSerial_employeeId_fkey";

-- GoodsReceiptConfirmation
ALTER TABLE "GoodsReceiptConfirmation" ADD CONSTRAINT "GoodsReceiptConfirmation_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "GoodsReceiptConfirmation" VALIDATE CONSTRAINT "GoodsReceiptConfirmation_employeeId_fkey";

-- AssetAssignment
ALTER TABLE "AssetAssignment" ADD CONSTRAINT "AssetAssignment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "AssetAssignment" VALIDATE CONSTRAINT "AssetAssignment_employeeId_fkey";

-- VisitPlan
ALTER TABLE "VisitPlan" ADD CONSTRAINT "VisitPlan_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "VisitPlan" VALIDATE CONSTRAINT "VisitPlan_employeeId_fkey";

-- Visit
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "Visit" VALIDATE CONSTRAINT "Visit_employeeId_fkey";

-- OnboardingTask
ALTER TABLE "OnboardingTask" ADD CONSTRAINT "OnboardingTask_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "OnboardingTask" VALIDATE CONSTRAINT "OnboardingTask_employeeId_fkey";

CREATE INDEX "User_vendorId_employeeId_idx" ON "User"("vendorId", "employeeId");

CREATE INDEX "AttendanceCorrection_vendorId_employeeId_idx" ON "AttendanceCorrection"("vendorId", "employeeId");

CREATE INDEX "CommunicationRecipient_vendorId_employeeId_idx" ON "CommunicationRecipient"("vendorId", "employeeId");

CREATE INDEX "InventoryItemSerial_vendorId_employeeId_idx" ON "InventoryItemSerial"("vendorId", "employeeId");

CREATE INDEX "GoodsReceiptConfirmation_vendorId_employeeId_idx" ON "GoodsReceiptConfirmation"("vendorId", "employeeId");

CREATE INDEX "OnboardingTask_vendorId_employeeId_idx" ON "OnboardingTask"("vendorId", "employeeId");
