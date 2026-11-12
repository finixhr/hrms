-- CreateIndex
-- Prevents duplicate active term invoices for the same subscription period
CREATE UNIQUE INDEX "SaaSInvoice_sub_term_period_unique" 
ON "SaaSInvoice"("subscriptionId", "periodStart", "periodEnd") 
WHERE "subscriptionId" IS NOT NULL AND "kind" = 'TERM' AND "status" != 'CANCELLED';
