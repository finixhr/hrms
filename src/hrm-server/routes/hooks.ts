// ============ Approval finalize hooks — THE integration seam ============
// The reusable approval engine calls these when a request is fully approved or
// rejected. This is what makes Leave/Loan/Advance/Expense/Payroll/Letter/
// Resignation/Promotion/Transfer/SalaryRevision flow through ONE engine.
import { registerFinalize } from "../approval"
import { applyLeaveDecision, applyEncashmentDecision } from "./leave"
import { applyLoanDecision, applyAdvanceDecision, applyExpenseDecision } from "./finance"
import { applyPayrollDecision, applyBonusDecision } from "./payroll"
import { applyLetterDecision } from "./letters"
import { applyResignationDecision } from "./exit"
import { applyPromotion, applyTransfer, applySalaryRevision } from "./lifecycle"
import { applyGoodsRequisitionDecision, applyPurchaseDecision } from "./procurement"
import { applyAssetIssueDecision, applyMasterRequestDecision } from "./inventory"

let registered = false

export function registerAllHooks() {
  if (registered) return
  registered = true
  registerFinalize("LEAVE", async (ctx, req, decision) => {
    await applyLeaveDecision(ctx, req.entityId, decision)
  })
  registerFinalize("LOAN", async (ctx, req, decision) => {
    await applyLoanDecision(ctx, req.entityId, decision)
  })
  registerFinalize("ADVANCE", async (ctx, req, decision) => {
    await applyAdvanceDecision(ctx, req.entityId, decision)
  })
  registerFinalize("EXPENSE", async (ctx, req, decision) => {
    await applyExpenseDecision(ctx, req.entityId, decision)
  })
  registerFinalize("PAYROLL", async (ctx, req, decision) => {
    await applyPayrollDecision(ctx, req.entityId, decision)
  })
  registerFinalize("LETTER", async (ctx, req, decision) => {
    await applyLetterDecision(ctx, req.entityId, decision)
  })
  registerFinalize("RESIGNATION", async (ctx, req, decision) => {
    await applyResignationDecision(ctx, req.entityId, decision)
  })
  registerFinalize("PROMOTION", async (ctx, req, decision) => {
    await applyPromotion(req.entityId, ctx.userId, ctx.vendorId, decision)
  })
  registerFinalize("TRANSFER", async (ctx, req, decision) => {
    await applyTransfer(req.entityId, ctx.userId, ctx.vendorId, decision)
  })
  registerFinalize("SALARY_REVISION", async (ctx, req, decision) => {
    await applySalaryRevision(req.entityId, ctx.userId, ctx.vendorId, decision)
  })
  // §L — leave encashment workflow rides the same engine
  registerFinalize("ENCASHMENT", async (ctx, req, decision) => {
    // LVE-005 (R3-4) — forward the APPROVAL REQUEST ID: with two encashment
    // requests open on the same balance row, the old entityId-only lookup in
    // applyEncashmentDecision could apply the wrong payload (or re-apply one
    // twice). The hook now resolves the exact request the engine finalized.
    await applyEncashmentDecision(ctx, req.entityId, decision, req.id)
  })
  // §7–§9 — goods requisition + purchase request workflows
  registerFinalize("GOODS_REQUISITION", async (ctx, req, decision) => {
    await applyGoodsRequisitionDecision(ctx, req.entityId, decision)
  })
  registerFinalize("PURCHASE", async (ctx, req, decision) => {
    await applyPurchaseDecision(ctx, req.entityId, decision)
  })
  // WP-L — issuing an inventory item as a tracked asset: the stock OUT +
  // Asset + AssetAssignment rows happen HERE (on final approval), not at
  // submission, so pending requests reserve nothing on the ledger.
  registerFinalize("ASSET_ISSUE", async (ctx, req, decision) => {
    await applyAssetIssueDecision(ctx, req, decision)
  })
  // WP-M — missing Item / Category / Unit request workflow: creates the item,
  // category, or unit in the database on approval.
  registerFinalize("MASTER_REQUEST", async (ctx, req, decision) => {
    await applyMasterRequestDecision(ctx, req, decision)
  })
  // PAY-006 (R3-2) — escalated bonus approval: the owner/finance gate for
  // bonuses at/above the escalation threshold lands back on the Bonus row.
  registerFinalize("BONUS", async (ctx, req, decision) => {
    await applyBonusDecision(ctx, req.entityId, decision)
  })
  // Commission Rule Setup — approval workflow finalize hooks
  registerFinalize("COMMISSION_RULE", async (ctx, req, decision) => {
    const { applyCommissionRuleDecision } = await import("./commissions")
    await applyCommissionRuleDecision(ctx, req.entityId, decision)
  })
  registerFinalize("COMMISSION_IMPORT", async (ctx, req, decision) => {
    const { applyCommissionImportDecision } = await import("./commissions")
    await applyCommissionImportDecision(ctx, req.entityId, decision)
  })
}


