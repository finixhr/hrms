-- DBD-2 (P2 wave, 2026-11-09) — six foreign-key columns lacked index coverage.
-- Additive only: CREATE INDEX IF NOT EXISTS, safe to replay on a database that
-- already received them through prisma db push (fresh scratch replays simply
-- create them once).
--   SaaSPayment.invoiceId           — settlement and billing sweeps query payments by invoice
--   SaaSInvoice.subscriptionId      — sweeps resolve invoices by subscription
--   Employee.designationId          — designation filtering scans the employee table
--   SaaSSubscription.vendorId       — console filters resolve a tenant's subscription
--   SaaSRegistration.planId         — approval flows join registrations to plans
--   CommissionThreshold.importId    — import replay/journal lookups join on the batch FK
CREATE INDEX IF NOT EXISTS "SaaSPayment_invoiceId_idx" ON "SaaSPayment"("invoiceId");
CREATE INDEX IF NOT EXISTS "SaaSInvoice_subscriptionId_idx" ON "SaaSInvoice"("subscriptionId");
CREATE INDEX IF NOT EXISTS "Employee_designationId_idx" ON "Employee"("designationId");
CREATE INDEX IF NOT EXISTS "SaaSSubscription_vendorId_idx" ON "SaaSSubscription"("vendorId");
CREATE INDEX IF NOT EXISTS "SaaSRegistration_planId_idx" ON "SaaSRegistration"("planId");
CREATE INDEX IF NOT EXISTS "CommissionThreshold_importId_idx" ON "CommissionThreshold"("importId");
