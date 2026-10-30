// ============ Reusable Approval Workflow Engine (spec §3.3) ============
// One configurable engine reused across Leave, Loan, Advance, Expense, Payroll,
// HR Letters and Resignation. Supports steps, approver role, specific approver,
// sequence, department/branch scope routing, amount thresholds, required/optional
// steps, delegation and rejection behavior.
//
// REMEDIATION (audit H-4 / M-1 / §L-missing-features):
//  - H-4: amount-threshold steps are AUTO-SKIPPED at submission and at each
//    advance (with an AUTO action row for the audit trail). No threshold step
//    ever waits for a human, and canActOnStep is strictly role/scope-based —
//    an EMPLOYEE can never act on any step, below threshold or otherwise.
//  - M-1: every state transition is a conditional updateMany (check-and-set)
//    executed inside a transaction — two concurrent approvers cannot
//    double-advance a step.
//  - §L: approval delegation. An ACTIVE ApprovalDelegate row lets toUserId act
//    on behalf of fromUserId (who must satisfy the step's role/scope rules);
//    the action row records "(delegate of …)".
import { db } from "@/lib/db"
import type { Prisma } from "@prisma/client"
import type { Ctx } from "./types"
import { ROLE_LABELS } from "./types"
import { Deny } from "./rbac"
import { audit, notify } from "./audit"
import { j, today } from "./utils"

export type ProcessType =
  | "LEAVE" | "LOAN" | "ADVANCE" | "EXPENSE" | "PAYROLL" | "LETTER"
  | "RESIGNATION" | "PROMOTION" | "TRANSFER" | "SALARY_REVISION"
  | "OVERTIME" // HRM-014 — overtime approval workflow
  | "ENCASHMENT" // §L — leave encashment requests
  | "GOODS_REQUISITION" // §9 — employee goods requisition workflow
  | "PURCHASE" // §8 — purchase request (shortage / manual) workflow
  | "ASSET_ISSUE" // WP-L — stock item issued to an employee as a tracked asset (stock deducts on final approval)
  | "MASTER_REQUEST" // Request to add missing Item, Category, or Unit
  | "BONUS" // PAY-006 (R3-2) — escalated bonus approval (≥ bonusApproval.escalationThreshold)
  | "COMMISSION_RULE" // Commission rule creation/edit authorization workflow
  | "COMMISSION_IMPORT" // Bulk commission threshold import authorization workflow

type FinalizeHook = (ctx: Ctx, req: ApprovalRequestView, decision: "APPROVED" | "REJECTED") => Promise<void>
const finalizeHooks = new Map<string, FinalizeHook>()

export function registerFinalize(processType: string, hook: FinalizeHook) {
  finalizeHooks.set(processType, hook)
}

export type StepView = {
  id: string
  sequence: number
  name: string
  approverRole?: string | null
  approverUserId?: string | null
  departmentScope: boolean
  branchScope: boolean
  amountThreshold?: number | null
  required: boolean
  rejectBehavior: string
}

export type ApprovalRequestView = {
  id: string
  processType: string
  entityType: string
  entityId: string
  entityRef?: string | null
  requestedBy: string
  currentStep: number
  status: string
  payload: any
  createdAt: Date
}

async function getSteps(workflowId: string): Promise<StepView[]> {
  const steps = await db.approvalStep.findMany({ where: { workflowId }, orderBy: { sequence: "asc" } })
  return steps.map((s) => ({
    id: s.id,
    sequence: s.sequence,
    name: s.name,
    approverRole: s.approverRole,
    approverUserId: s.approverUserId,
    departmentScope: s.departmentScope,
    branchScope: s.branchScope,
    amountThreshold: s.amountThreshold,
    required: s.required,
    rejectBehavior: s.rejectBehavior,
  }))
}

async function getWorkflow(vendorId: string, processType: ProcessType) {
  const wf = await db.approvalWorkflow.findFirst({ where: { vendorId, processType, active: true } })
  if (!wf) throw new Deny(`No approval workflow configured for ${processType}. Configure it in Settings → Approval Workflows.`)
  return wf
}

/** H-4 — a step is auto-skippable when the amount is strictly below its threshold. */
function isThresholdSkippable(step: StepView | undefined, amount: number | null): boolean {
  return !!step && step.amountThreshold != null && amount != null && amount < step.amountThreshold
}

/** Resolve the users who should act on a step (for notifications), excluding the requester. */
async function notifyStepApprovers(ctx: Ctx, step: StepView | undefined, req: ApprovalRequestView) {
  if (!step) return
  const targets = new Set<string>()
  if (step.approverUserId) {
    targets.add(step.approverUserId)
  } else if (step.approverRole) {
    const users = await db.user.findMany({ where: { vendorId: ctx.vendorId, role: step.approverRole, status: "ACTIVE" } })
    for (const u of users) {
      if (step.departmentScope || step.branchScope) {
        const empId = (req.payload as any)?.employeeId
        if (empId) {
          const emp = await db.employee.findFirst({ where: { id: empId, vendorId: ctx.vendorId } })
          if (!emp) continue
          if (step.departmentScope && emp.departmentId && u.departmentId !== emp.departmentId) continue
          if (step.branchScope && emp.branchId && u.branchId !== emp.branchId) continue
        }
      }
      targets.add(u.id)
    }
  }
  for (const uid of targets) {
    if (uid === req.requestedBy) continue
    await notify(ctx.vendorId, { userId: uid }, "Approval Needed",
      `${req.entityRef || title(req.processType)} is waiting for your approval at step "${step.name}". Open the Approval Queue to act.`,
      req.processType, "approvals")
  }
}

function title(s: string): string {
  return s.charAt(0) + s.slice(1).toLowerCase()
}

/** §L — active delegations TO a user (they act on the delegator's behalf). */
async function activeDelegations(vendorId: string, toUserId: string) {
  const t = today()
  return db.approvalDelegate.findMany({
    where: { vendorId, toUserId, active: true, startDate: { lte: t }, endDate: { gte: t } },
  })
}

/** Does USER (by row) satisfy a step's routing rules? Shared by direct + delegated acting. */
async function userMatchesStep(user: { id: string; role: string; departmentId?: string | null; branchId?: string | null },
  ctx: { vendorId: string },
  step: StepView, req: ApprovalRequestView): Promise<boolean> {
  if (step.approverUserId) return user.id === step.approverUserId
  if (step.approverRole) {
    if (user.role !== step.approverRole) return false
    if (step.departmentScope || step.branchScope) {
      const empId = (req.payload as any)?.employeeId
      if (!empId) return true
      const emp = await db.employee.findFirst({ where: { id: empId, vendorId: ctx.vendorId } })
      if (!emp) return false
      if (step.departmentScope && emp.departmentId && user.departmentId !== emp.departmentId) return false
      if (step.branchScope && emp.branchId && user.branchId !== emp.branchId) return false
    }
    return true
  }
  return false
}

/** SOP-1 (this audit) — Has any OTHER user (not the requester, not AUTO) recorded
 *  a human APPROVE action on a step BEFORE the current step?
 *
 *  Purpose: lift the Separation-of-Duties (SoD) block once a different human has
 *  approved a prior step. The SoD rule's intent is "no single-person approval of
 *  their own request" — once another human has approved, the request is no
 *  longer single-person, so the submitter may act on subsequent steps.
 *
 *  AUTO-skip actions (userName="AUTO (threshold)") do NOT count — they are
 *  automated, not a human approval.
 *
 *  This fixes the reported bug: HR_ADMIN submits payroll → Owner approves step 1
 *  → request moves to step 2 (HR_ADMIN) → HR_ADMIN is blocked by SoD because
 *  requestedBy is still HR_ADMIN. With this fix, the prior Owner approval lifts
 *  the SoD block and HR_ADMIN can act on step 2.
 */
async function hasPriorHumanApprovalByOtherUser(
  requestId: string,
  currentStep: number,
  requesterUserId: string,
): Promise<boolean> {
  const actions = await db.approvalAction.findMany({
    where: { requestId, step: { lt: currentStep }, action: "APPROVE" },
    select: { userId: true, userName: true },
  })
  return actions.some((a) => a.userId && a.userId !== requesterUserId && a.userName !== "AUTO (threshold)")
}

/** Can the given user act on the given step? Server-side routing resolution.
 * Rules:
 *  1. Separation of duties — the requester can never approve their own request
 *     on the FIRST step (no other human has approved yet). Once a different
 *     human has approved a prior step (SOP-1), the SoD block is lifted because
 *     the request is no longer single-person approved.
 *  2. HR Admin and Vendor Owner are super-approvers: they may act on any step
 *     (still audited per action), so an organization is never blocked when a
 *     workflow step's role has no active user.
 *  3. Otherwise: specific approver user, or matching role with optional
 *     department/branch scope refinement.
 *  4. Delegation (§L): an ACTIVE delegate may act where their delegator could.
 *  NOTE (H-4): amount thresholds NO LONGER grant act rights here — below-
 *  threshold steps are auto-skipped at submission time instead.
 */
export async function canActOnStep(ctx: Ctx, step: StepView, req: ApprovalRequestView): Promise<{ ok: boolean; viaDelegator?: string }> {
  // SOP-1 — SoD check is lifted once a different human has approved a prior step.
  // This is the FIX for the reported bug where HR_ADMIN submits payroll, Owner
  // approves step 1, request moves to step 2 (HR_ADMIN), but HR_ADMIN is still
  // blocked by SoD because requestedBy is still HR_ADMIN.
  if (ctx.userId === req.requestedBy) {
    const priorHumanApproval = await hasPriorHumanApprovalByOtherUser(req.id, req.currentStep, req.requestedBy)
    if (!priorHumanApproval) return { ok: false }
    // else: fall through — a different human has approved a prior step, SoD is satisfied
  }

  if (ctx.role === "HR_ADMIN" || ctx.role === "VENDOR_OWNER") {
    // L-8 — chain-of-custody SoD: a super-approver who already acted on an
    // EARLIER step of this request may not take every remaining step when
    // another active approver exists in the vendor (the one-person completion
    // path the audit flagged). Sole-admin vendors keep the SOP-1 lift.
    const actedEarlier = await db.approvalAction.findFirst({
      where: { requestId: req.id, step: { lt: req.currentStep }, userId: ctx.userId, action: "APPROVE" },
      select: { id: true },
    })
    if (actedEarlier) {
      const others = await db.user.findMany({
        where: { vendorId: ctx.vendorId, status: "ACTIVE", id: { not: ctx.userId } },
        select: { role: true, permissions: true },
      })
      const hasOtherApprover = others.some((u) =>
        u.role === "HR_ADMIN" || u.role === "VENDOR_OWNER"
        || String(u.permissions || "").includes("approvals.approve"))
      if (hasOtherApprover) return { ok: false }
    }
    return { ok: true }
  }

  const selfUser = await db.user.findUnique({ where: { id: ctx.userId } })
  if (selfUser && selfUser.status === "ACTIVE" && await userMatchesStep(selfUser, ctx, step, req)) return { ok: true }

  // §L — delegated authority
  for (const d of await activeDelegations(ctx.vendorId, ctx.userId)) {
    if (d.fromUserId === req.requestedBy) continue // delegating your own requester role changes nothing
    const fromUser = await db.user.findFirst({ where: { id: d.fromUserId, vendorId: ctx.vendorId, status: "ACTIVE" } })
    if (fromUser && await userMatchesStep(fromUser, ctx, step, req)) {
      return { ok: true, viaDelegator: fromUser.name }
    }
  }
  return { ok: false }
}

/**
 * H-4 — resolve the request's next position after skipping threshold-exempt
 * steps. Returns the sequence the request should rest on, plus the AUTO action
 * rows to record for every skipped step. Returns status "APPROVED" when the
 * chain runs off the end.
 */
function resolveAfterSkip(fromSeq: number, steps: StepView[], amount: number | null): {
  restSeq: number | null
  autoActions: { step: number; comment: string }[]
} {
  let seq = fromSeq
  const autoActions: { step: number; comment: string }[] = []
  // skip the starting step itself when it is threshold-exempt (submission case)
  let step = steps.find((s) => s.sequence === seq)
  while (isThresholdSkippable(step, amount)) {
    autoActions.push({
      step: seq,
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): convert to an explicit null check
      comment: `Auto-approved: amount below step threshold of ${step!.amountThreshold}`,
    })
    seq = (steps.find((s) => s.sequence > seq)?.sequence) ?? Number.MAX_SAFE_INTEGER
    if (seq === Number.MAX_SAFE_INTEGER) return { restSeq: null, autoActions }
    step = steps.find((s) => s.sequence === seq)
  }
  return { restSeq: seq, autoActions }
}

/** Submit an entity for approval through its process workflow. */
/** H-14 — Phase 1 of submitForApproval: pure STATE writes only (approval
 *  request + auto-skip audit rows). Safe to call inside a db.$transaction —
 *  pass the transaction client as `tx`. No notifications, no audit-log writes
 *  (those run via announceApprovalRequest AFTER the transaction commits, so a
 *  rollback never leaves phantom notifications or approval rows behind). */
export async function createApprovalRequest(
  ctx: Ctx,
  processType: ProcessType,
  entityType: string,
  entityId: string,
  entityRef: string,
  payload: Record<string, unknown> = {},
  tx?: Prisma.TransactionClient
): Promise<{ id: string; restSeq: number; entityRef: string }> {
  const d = tx ?? db
  const wf = await getWorkflow(ctx.vendorId, processType)
  const steps = await getSteps(wf.id)
  if (!steps.length) throw new Deny(`Workflow for ${processType} has no steps`)

  const amount = (payload as any)?.amount ?? null
  // H-4 — start past any threshold-exempt leading steps
  const { restSeq, autoActions } = resolveAfterSkip(1, steps, amount)
  if (restSeq === null) {
    throw new Deny(`Workflow for ${processType} fully auto-passes at this amount — configure at least one human step above the threshold`, 400)
  }

  const req = await d.approvalRequest.create({
    data: {
      vendorId: ctx.vendorId,
      workflowId: wf.id,
      processType,
      entityType,
      entityId,
      entityRef,
      requestedBy: ctx.userId,
      currentStep: restSeq,
      status: "PENDING",
      payloadJson: JSON.stringify(payload),
    },
  })
  // audit trail for every auto-skipped threshold step (H-4)
  for (const a of autoActions) {
    await d.approvalAction.create({
      // DB-02 (R5) — approval actions carry their tenant (matches the request).
      data: { vendorId: req.vendorId, requestId: req.id, step: a.step, userId: null, userName: "AUTO (threshold)", action: "APPROVE", comment: a.comment },
    })
  }
  return { id: req.id, restSeq, entityRef }
}

/** H-14 — Phase 2 of submitForApproval: audit trail + approver notification.
 *  Must run AFTER the caller's transaction commits (uses `db`, not `tx`). */
export async function announceApprovalRequest(
  ctx: Ctx,
  processType: ProcessType,
  entityType: string,
  entityId: string,
  approvalId: string,
  restSeq: number,
  entityRef: string,
  payload: Record<string, unknown> = {},
  createdAt?: Date
) {
  await audit(ctx, `${processType.toLowerCase()}.submit`, entityType, entityId, `Submitted for approval: ${entityRef}`)
  // Tell the resting step's approver(s) their action is needed
  const wf = await getWorkflow(ctx.vendorId, processType)
  const steps = await getSteps(wf.id)
  await notifyStepApprovers(ctx, steps.find((s) => s.sequence === restSeq), {
    id: approvalId, processType, entityType, entityId, entityRef,
    requestedBy: ctx.userId, currentStep: restSeq, status: "PENDING",
    payload, createdAt: createdAt || new Date(),
  })
}

export async function submitForApproval(
  ctx: Ctx,
  processType: ProcessType,
  entityType: string,
  entityId: string,
  entityRef: string,
  payload: Record<string, unknown> = {}
): Promise<string> {
  const { id, restSeq } = await createApprovalRequest(ctx, processType, entityType, entityId, entityRef, payload)
  await announceApprovalRequest(ctx, processType, entityType, entityId, id, restSeq, entityRef, payload)
  return id
}

/** Advance engine: approve current step, auto-skip threshold-exempt steps,
 * finalize when done. M-1: the transition is a conditional (check-and-set)
 * update inside a transaction, so concurrent approvals cannot double-advance. */
/** M-9 — run a finalize hook with ONE retry. Returns null on success, or the
 *  error detail after a loud failure (audit row + HR-admin notification). The
 *  hooks are idempotent (each claims its entity with a conditional status
 *  update), so the retry is safe. */
async function runFinalizeHook(ctx: Ctx, raw: any, hook: FinalizeHook, decision: "APPROVED" | "REJECTED"): Promise<string | null> {
  const reqView: ApprovalRequestView = {
    id: raw.id,
    processType: raw.processType,
    entityType: raw.entityType,
    entityId: raw.entityId,
    entityRef: raw.entityRef,
    requestedBy: raw.requestedBy,
    currentStep: raw.currentStep,
    status: decision,
    payload: raw.payload ?? j(raw.payloadJson, {}),
    createdAt: raw.createdAt,
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await hook(ctx, reqView, decision)
      return null
    } catch (e: any) {
      if (attempt === 2) {
        const detail = String(e?.message || e).slice(0, 300)
        try {
          await audit(ctx, `${raw.processType.toLowerCase()}.finalizeError`, raw.entityType, raw.entityId,
            `FINALIZE HOOK FAILED after retry — ${raw.entityType} ${raw.entityRef || raw.entityId} is ${decision} but its automated follow-up did not complete: ${detail}`)
        } catch { /* audit must never mask the original result */ }
        try {
          await notify(ctx.vendorId, { role: "HR_ADMIN" }, "Approval follow-up failed",
            `Request ${raw.entityRef || raw.entityId} (${raw.processType}) was ${decision} but the automated follow-up failed: ${detail}. Please review the record manually.`, "SYSTEM", "approvals")
        } catch { /* notification is best-effort */ }
        return detail
      }
    }
  }
  return null
}

export async function actOnRequest(
  ctx: Ctx,
  requestId: string,
  decision: "APPROVE" | "REJECT",
  comment?: string
) {
  const raw = await db.approvalRequest.findFirst({ where: { id: requestId, vendorId: ctx.vendorId } })
  if (!raw) throw new Deny("Approval request not found", 404)
  if (raw.status !== "PENDING") throw new Deny(`Request already ${raw.status.toLowerCase()}`)

  const req: ApprovalRequestView = {
    id: raw.id, processType: raw.processType, entityType: raw.entityType, entityId: raw.entityId,
    entityRef: raw.entityRef, requestedBy: raw.requestedBy, currentStep: raw.currentStep,
    status: raw.status, payload: j(raw.payloadJson, {}), createdAt: raw.createdAt,
  }
  const steps = await getSteps(raw.workflowId)
  const step = steps.find((s) => s.sequence === raw.currentStep)
  if (!step) throw new Deny("Workflow step misconfigured")
  const amount = (req.payload as any)?.amount ?? null

  // Separation of duties (SOP-1 fix): the requester cannot act on their own
  // request UNLESS a different human has already approved a prior step. This
  // preserves the SoD intent (no single-person approval) while fixing the
  // multi-step workflow where, e.g., HR_ADMIN submits payroll, Owner approves
  // step 1, request moves to step 2 (HR_ADMIN) — the prior Owner approval
  // lifts the SoD block so HR_ADMIN can complete step 2.
  if (ctx.userId === raw.requestedBy) {
    const priorHumanApproval = await hasPriorHumanApprovalByOtherUser(raw.id, raw.currentStep, raw.requestedBy)
    if (!priorHumanApproval) {
      throw new Deny("You cannot approve or reject your own request on the first step (separation of duties) — another approver must act first")
    }
  }

  // H-4 — strict, role/scope/delegation-based authorization. Thresholds no
  // longer bypass this check in any form.
  const can = await canActOnStep(ctx, step, req)
  if (!can.ok) {
    throw new Deny(`You are not authorized to act on step "${step.name}" of this request`)
  }
  const actingName = can.viaDelegator ? `${ctx.userName} (delegate of ${can.viaDelegator})` : ctx.userName

  // Optional steps may be skipped by a REJECT, but a rejection on a required
  // step rejects the whole request.
  const rejectAdvances = decision === "REJECT" && !step.required && step.amountThreshold == null

  const transition = await db.$transaction(async (tx) => {
    if (rejectAdvances) {
      // treat as skip → advance to next human step (auto-skipping thresholds)
      const nextSeq = steps.find((s) => s.sequence > raw.currentStep)?.sequence ?? null
      const { restSeq, autoActions } = nextSeq == null ? { restSeq: null, autoActions: [] as any[] } : resolveAfterSkip(nextSeq, steps, amount)
      const claimed = await tx.approvalRequest.updateMany({
        where: { id: raw.id, status: "PENDING", currentStep: raw.currentStep },
        data: restSeq == null
          ? { status: "APPROVED", completedAt: new Date(), currentStep: raw.currentStep }
          : { currentStep: restSeq },
      })
      if (claimed.count === 0) return { conflicted: true as const }
      await tx.approvalAction.create({
        data: { vendorId: raw.vendorId, requestId: raw.id, step: raw.currentStep, userId: ctx.userId, userName: actingName, action: "SKIP", comment },
      })
      for (const a of autoActions) {
        await tx.approvalAction.create({
          data: { vendorId: raw.vendorId, requestId: raw.id, step: a.step, userId: null, userName: "AUTO (threshold)", action: "APPROVE", comment: a.comment },
        })
      }
      return { conflicted: false as const, status: restSeq == null ? "APPROVED" : "PENDING", restSeq, autoActions }
    }

    if (decision === "REJECT") {
      const claimed = await tx.approvalRequest.updateMany({
        where: { id: raw.id, status: "PENDING", currentStep: raw.currentStep },
        data: { status: "REJECTED", completedAt: new Date() },
      })
      if (claimed.count === 0) return { conflicted: true as const }
      await tx.approvalAction.create({
        data: { vendorId: raw.vendorId, requestId: raw.id, step: raw.currentStep, userId: ctx.userId, userName: actingName, action: "REJECT", comment },
      })
      return { conflicted: false as const, status: "REJECTED" as const }
    }

    // APPROVE — advance past threshold-exempt follow-on steps (H-4)
    const nextSeq = steps.find((s) => s.sequence > raw.currentStep)?.sequence ?? null
    const { restSeq, autoActions } = nextSeq == null ? { restSeq: null, autoActions: [] as any[] } : resolveAfterSkip(nextSeq, steps, amount)
    const claimed = await tx.approvalRequest.updateMany({
      where: { id: raw.id, status: "PENDING", currentStep: raw.currentStep },
      data: restSeq == null
        ? { status: "APPROVED", completedAt: new Date() }
        : { currentStep: restSeq },
    })
    if (claimed.count === 0) return { conflicted: true as const }
    await tx.approvalAction.create({
      data: { vendorId: raw.vendorId, requestId: raw.id, step: raw.currentStep, userId: ctx.userId, userName: actingName, action: "APPROVE", comment },
    })
    for (const a of autoActions) {
      await tx.approvalAction.create({
        data: { vendorId: raw.vendorId, requestId: raw.id, step: a.step, userId: null, userName: "AUTO (threshold)", action: "APPROVE", comment: a.comment },
      })
    }
    return { conflicted: false as const, status: (restSeq == null ? "APPROVED" : "PENDING") as "APPROVED" | "PENDING", restSeq, autoActions }
  })

  if (transition.conflicted) {
    throw new Deny("This request was already actioned by someone else — refresh the queue.", 409)
  }

  // ---- post-transaction side effects ----
  // M-9 — finalize hooks run post-commit with ONE retry; a second failure is
  // never silent (the audit's forensic gap): an audit row + HR-admin
  // notification are written and the response carries finalizeWarning, so the
  // entity stuck in PENDING is visible and actionable instead of orphaned.
  if (transition.status === "APPROVED") {
    await audit(ctx, `${raw.processType.toLowerCase()}.approve`, raw.entityType, raw.entityId,
      `Fully approved${comment ? ": " + comment : ""}`)
    const hook = finalizeHooks.get(raw.processType)
    const finalizeError = hook ? await runFinalizeHook(ctx, raw, hook, "APPROVED") : null
    await notify(ctx.vendorId, { userId: raw.requestedBy }, "Request Approved",
      `Your ${raw.processType.toLowerCase()} request (${raw.entityRef}) is fully approved.`, raw.processType)
    return finalizeError ? { status: "APPROVED", finalizeWarning: finalizeError } : { status: "APPROVED" }
  }
  if (transition.status === "REJECTED") {
    await audit(ctx, `${raw.processType.toLowerCase()}.reject`, raw.entityType, raw.entityId,
      `Rejected at step "${step.name}"${comment ? ": " + comment : ""}`)
    const hook = finalizeHooks.get(raw.processType)
    const finalizeError = hook ? await runFinalizeHook(ctx, raw, hook, "REJECTED") : null
    await notify(ctx.vendorId, { userId: raw.requestedBy }, "Request Rejected",
      `Your ${raw.processType.toLowerCase()} request (${raw.entityRef}) was rejected at "${step.name}".`, raw.processType)
    return finalizeError ? { status: "REJECTED", finalizeWarning: finalizeError } : { status: "REJECTED" }
  }
  // advanced to a later step
  await notify(ctx.vendorId, { userId: raw.requestedBy }, "Approval Progress",
    `Your ${raw.processType.toLowerCase()} request (${raw.entityRef}) advanced to "${steps.find((s) => s.sequence === transition.restSeq)?.name}".`, raw.processType)
  await notifyStepApprovers(ctx, steps.find((s) => s.sequence === transition.restSeq), req)
  return { status: "PENDING", advancedTo: steps.find((s) => s.sequence === transition.restSeq)?.name }
}

/** Unified approval queue with resolved "who can act now" flags.
 *  MOD-3 (Phase 2 WS4) — the queue used to issue 3-6 queries PER pending
 *  request (getSteps + approvalAction + canActOnStep internals) on every UI
 *  poll: 1,500-3,500 queries at 500 pending requests. Workflow steps and
 *  action histories are now fetched in TWO set queries for the whole queue;
 *  canActOnStep stays per-request (it is live permission logic — SoD,
 *  delegation, threshold context — deliberately untouched). */
export async function queue(ctx: Ctx, status = "PENDING") {
  const raws = await db.approvalRequest.findMany({
    where: { vendorId: ctx.vendorId, status },
    orderBy: { createdAt: "desc" },
  })
  // MOD-3 — set-based prefetch: every distinct workflow's steps + every
  // request's action history, grouped by key
  const workflowIds = [...new Set(raws.map((r) => r.workflowId).filter((x): x is string => !!x))]
  const allSteps = workflowIds.length
    ? await db.approvalStep.findMany({ where: { workflowId: { in: workflowIds } }, orderBy: { sequence: "asc" } })
    : []
  const stepsByWorkflow = new Map<string, StepView[]>()
  for (const st of allSteps) {
    const list = stepsByWorkflow.get(st.workflowId)
    if (list) list.push(st as unknown as StepView)
    else stepsByWorkflow.set(st.workflowId, [st as unknown as StepView])
  }
  const requestIds = raws.map((r) => r.id)
  const allActions = requestIds.length
    ? await db.approvalAction.findMany({ where: { requestId: { in: requestIds } }, orderBy: { createdAt: "asc" } })
    : []
  const actionsByRequest = new Map<string, typeof allActions>()
  for (const a of allActions) {
    const list = actionsByRequest.get(a.requestId)
    if (list) list.push(a)
    else actionsByRequest.set(a.requestId, [a])
  }
  const out: any[] = []
  for (const raw of raws) {
    const steps = stepsByWorkflow.get(raw.workflowId) || []
    const step = steps.find((s) => s.sequence === raw.currentStep)
    const payload = j(raw.payloadJson, {})
    const amount = (payload as any)?.amount ?? null
    const thresholdSkip = isThresholdSkippable(step, amount)
    // Display matches enforcement (H-4): canAct is strictly role/scope based.
    const can = step ? await canActOnStep(ctx, step, { ...raw, payload } as ApprovalRequestView) : { ok: false }
    const actions = actionsByRequest.get(raw.id) || []
    // SOP-1 (this audit) — expose approverRole + human-readable label so the UI
    // can show "pending at HR Admin" / "pending at Vendor Owner" etc. Previously
    // the UI had only `stepName` (a free-form text the admin sets when creating
    // the workflow) — that led to confusion when the step name was generic like
    // "Finance / Accounting Approval" while the actual role was PAYROLL_OFFICER.
    const approverRole = step?.approverRole || null
    const approverRoleLabel = approverRole ? (ROLE_LABELS[approverRole] || approverRole) : null
    const approverUserId = step?.approverUserId || null
    out.push({
      id: raw.id,
      processType: raw.processType,
      entityType: raw.entityType,
      entityId: raw.entityId,
      entityRef: raw.entityRef,
      requestedBy: raw.requestedBy,
      currentStep: raw.currentStep,
      stepName: step?.name || "—",
      approverRole,
      approverRoleLabel,
      approverUserId,
      pendingAt: approverRoleLabel || step?.name || "—",
      canAct: can.ok,
      viaDelegator: (can as any).viaDelegator,
      thresholdSkip,
      amount,
      payload,
      status: raw.status,
      createdAt: raw.createdAt,
      actions: actions.map((a) => ({ step: a.step, userName: a.userName, action: a.action, comment: a.comment, at: a.createdAt })),
    })
  }
  return out
}

export async function workflowsWithSteps(vendorId: string) {
  const wfs = await db.approvalWorkflow.findMany({ where: { vendorId }, orderBy: { processType: "asc" } })
  const out: any[] = []
  for (const wf of wfs) {
    const steps = await db.approvalStep.findMany({ where: { workflowId: wf.id }, orderBy: { sequence: "asc" } })
    out.push({ ...wf, steps })
  }
  return out
}
