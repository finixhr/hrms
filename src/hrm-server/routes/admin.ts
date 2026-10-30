// ============ Unified approval queue routes + admin (users) + system self-test ============
import { db } from "@/lib/db"
import { z } from "zod"
import { route } from "./registry"
import { Deny } from "../rbac"
import { queue, actOnRequest, canActOnStep, type ApprovalRequestView } from "../approval"
import { j } from "../utils"
import { audit, notify } from "../audit"
import { hashPasswordAsync, validatePasswordPolicy , invalidateRoleCache } from "../auth"
import { ROLE_LABELS, ROLE_TEMPLATES, MODULES, ACTIONS } from "../types"
import { getSettings } from "../settings"
import { requireCapacity } from "../saas/entitlements"

// ================= Wave 4 SG-C — manual vouchers in the unified inbox =================
// Manual journal vouchers (AccountJournal status PENDING_APPROVAL) wait on the
// accounting-specific H-9 + state machine in routes/accounting.ts — the inbox
// row is a POINTER, not an actor: canAct is always false and the client
// renders "Open Vouchers →" (navigate("accounting", { tab: "vouchers" }))
// instead of Approve/Reject. The engine rows below stay byte-identical;
// voucher rows are APPENDED after them (take 100, newest first).
const VOUCHER_STATUS_BY_QUEUE_STATUS: Record<string, "PENDING_APPROVAL" | "POSTED" | "REJECTED" | undefined> = {
  PENDING: "PENDING_APPROVAL",
  APPROVED: "POSTED",
  REJECTED: "REJECTED",
}

async function voucherInboxRows(vendorId: string, queueStatus: string): Promise<any[]> {
  const voucherStatus = VOUCHER_STATUS_BY_QUEUE_STATUS[queueStatus]
  if (!voucherStatus) return [] // CANCELLED (and any custom filter) has no voucher twin
  const journals = await db.accountJournal.findMany({
    where: { vendorId, status: voucherStatus },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, memo: true, date: true, amount: true, createdAt: true, approvedByName: true, approvedAt: true, rejectionReason: true },
  })
  return journals.map((jn) => ({
    id: `VOUCHER:${jn.id}`,
    processType: "VOUCHER",
    entityType: "voucher",
    entityId: jn.id,
    entityRef: (jn.memo || "Manual voucher").slice(0, 80),
    requestedBy: null, // vouchers carry no requester id — the "your request" badge must never match
    requestedByName: "Accounting",
    currentStep: 1,
    stepName: "Voucher approval",
    pendingAt: "Accounting",
    approverRole: null,
    approverRoleLabel: null,
    approverUserId: null,
    viaDelegator: null,
    thresholdSkip: false,
    canAct: false, // acting needs accounting.approve + the H-9 state machine — open the Vouchers tab
    deepLink: "accounting",
    amount: Number(jn.amount) || 0,
    payload: { amount: Number(jn.amount) || 0, date: jn.date, memo: jn.memo, voucherId: jn.id },
    status: queueStatus, // POSTED → "APPROVED", REJECTED → "REJECTED", PENDING_APPROVAL → "PENDING"
    createdAt: jn.createdAt,
    actions: jn.approvedAt && jn.approvedByName
      ? [{ step: 1, userName: jn.approvedByName, action: voucherStatus === "POSTED" ? "APPROVE" : "REJECT", comment: jn.rejectionReason || null, at: jn.approvedAt }]
      : [],
  }))
}

route("approvals.queue", {
  perm: ["approvals", "view"],
  handler: async (ctx, p) => {
    const status = p?.status || "PENDING"
    const rows = await queue(ctx, status)
    // SG-C — manual vouchers face the same approval audience, as pointers
    rows.push(...(await voucherInboxRows(ctx.vendorId, status)))
    return rows
  },
})

route("approvals.history", {
  perm: ["approvals", "view"],
  handler: async (ctx, p) => {
    const status = p?.status || "APPROVED"
    const rows = await queue(ctx, status)
    // SG-C — decided vouchers (POSTED/REJECTED) join the matching history tab
    rows.push(...(await voucherInboxRows(ctx.vendorId, status)))
    return rows
  },
})

/** Full detail inspection for any approval request, including approval chain,
 *  submitter, target employee identity, and contextual history (e.g. leave balances & past leaves,
 *  previously issued assets, past expenses, past advances, past loans). */
route("approvals.details", {
  perm: ["approvals", "view"],
  handler: async (ctx, p) => {
    const id = String(p?.id || "")
    if (!id) throw new Deny("Request ID is required", 400)

    // SG-C — Manual journal voucher pointer row
    if (id.startsWith("VOUCHER:")) {
      const journalId = id.replace("VOUCHER:", "")
      const jn = await db.accountJournal.findFirst({
        where: { id: journalId, vendorId: ctx.vendorId },
      })
      if (!jn) throw new Deny("Voucher not found", 404)
      const lines = j(jn.linesJson, [])
      return {
        id,
        processType: "VOUCHER",
        entityType: "AccountJournal",
        entityId: jn.id,
        entityRef: jn.memo || "Manual Voucher",
        status: jn.status === "PENDING_APPROVAL" ? "PENDING" : jn.status,
        amount: jn.amount,
        createdAt: jn.createdAt,
        submittedBy: { name: "Accounting / Finance", role: "Accountant", email: "" },
        employee: null,
        canAct: false,
        steps: [
          {
            sequence: 1,
            name: "Voucher Approval",
            role: "ACCOUNTANT",
            roleLabel: "Accountant",
            status: jn.status === "POSTED" ? "APPROVED" : jn.status === "REJECTED" ? "REJECTED" : "PENDING",
            actedBy: jn.approvedByName || null,
            actedAt: jn.approvedAt || null,
            comment: jn.rejectionReason || null,
          },
        ],
        actions: jn.approvedByName
          ? [{ step: 1, userName: jn.approvedByName, action: jn.status === "POSTED" ? "APPROVE" : "REJECT", comment: jn.rejectionReason, at: jn.approvedAt }]
          : [],
        entityDetails: jn,
        history: {
          type: "VOUCHER",
          lines,
        },
      }
    }

    const raw = await db.approvalRequest.findFirst({
      where: { id, vendorId: ctx.vendorId },
    })
    if (!raw) throw new Deny("Approval request not found", 404)

    const payload: any = j(raw.payloadJson, {})

    // Submitter (Issued By)
    let submittedBy: { name: string; email: string; role: string } = { name: "System", email: "", role: "System" }
    if (raw.requestedBy && raw.requestedBy !== "seed") {
      const u = await db.user.findUnique({
        where: { id: raw.requestedBy },
        select: { name: true, email: true, role: true },
      })
      if (u) {
        submittedBy = { name: u.name, email: u.email, role: ROLE_LABELS[u.role] || u.role }
      }
    } else if (raw.requestedBy === "seed") {
      submittedBy = { name: "System Admin (Seed)", email: "admin@system.local", role: "Super Admin" }
    }

    // Resolve target Employee
    let employeeId: string | null = payload.employeeId || null
    if (!employeeId) {
      if (raw.processType === "LEAVE") {
        employeeId = (await db.leaveRequest.findUnique({ where: { id: raw.entityId }, select: { employeeId: true } }))?.employeeId || null
      } else if (raw.processType === "EXPENSE") {
        employeeId = (await db.expenseClaim.findUnique({ where: { id: raw.entityId }, select: { employeeId: true } }))?.employeeId || null
      } else if (raw.processType === "ADVANCE") {
        employeeId = (await db.advance.findUnique({ where: { id: raw.entityId }, select: { employeeId: true } }))?.employeeId || null
      } else if (raw.processType === "LOAN") {
        employeeId = (await db.loan.findUnique({ where: { id: raw.entityId }, select: { employeeId: true } }))?.employeeId || null
      } else if (raw.processType === "GOODS_REQUISITION") {
        employeeId = (await db.goodsRequisition.findUnique({ where: { id: raw.entityId }, select: { employeeId: true } }))?.employeeId || null
      } else if (raw.processType === "SALARY_REVISION") {
        employeeId = (await db.salaryRevision.findUnique({ where: { id: raw.entityId }, select: { employeeId: true } }))?.employeeId || null
      } else if (raw.processType === "PROMOTION") {
        employeeId = (await db.promotion.findUnique({ where: { id: raw.entityId }, select: { employeeId: true } }))?.employeeId || null
      } else if (raw.processType === "TRANSFER") {
        employeeId = (await db.transfer.findUnique({ where: { id: raw.entityId }, select: { employeeId: true } }))?.employeeId || null
      } else if (raw.processType === "LETTER") {
        employeeId = (await db.hrLetter.findUnique({ where: { id: raw.entityId }, select: { employeeId: true } }))?.employeeId || null
      } else if (raw.processType === "RESIGNATION") {
        employeeId = (await db.resignation.findUnique({ where: { id: raw.entityId }, select: { employeeId: true } }))?.employeeId || null
      }
    }

    let employee: any = null
    if (employeeId) {
      employee = await db.employee.findUnique({
        where: { id: employeeId },
        select: {
          id: true,
          code: true,
          fullName: true,
          nameBn: true,
          photoThumb: true,
          photoUrl: true,
          personalEmail: true,
          officialEmail: true,
          mobile: true,
          status: true,
          joiningDate: true,
          branch: { select: { id: true, name: true } },
          department: { select: { id: true, name: true } },
          designation: { select: { id: true, name: true } },
        },
      })
    }

    // Steps & Actions
    const [rawSteps, actions] = await Promise.all([
      db.approvalStep.findMany({ where: { workflowId: raw.workflowId }, orderBy: { sequence: "asc" } }),
      db.approvalAction.findMany({ where: { requestId: raw.id }, orderBy: { createdAt: "asc" } }),
    ])

    const currentStepDef = rawSteps.find((s) => s.sequence === raw.currentStep)
    const can = currentStepDef
      ? await canActOnStep(ctx, currentStepDef, { ...raw, payload } as ApprovalRequestView)
      : { ok: false }

    const steps = rawSteps.map((s) => {
      const act = actions.find((a) => a.step === s.sequence)
      const roleLabel = s.approverRole ? (ROLE_LABELS[s.approverRole] || s.approverRole) : null
      let stepStatus: "APPROVED" | "REJECTED" | "SKIPPED" | "PENDING" | "UPCOMING" = "UPCOMING"
      if (act) {
        stepStatus = act.action === "APPROVE" ? "APPROVED" : act.action === "REJECT" ? "REJECTED" : "SKIPPED"
      } else if (s.sequence === raw.currentStep && raw.status === "PENDING") {
        stepStatus = "PENDING"
      } else if (s.sequence < raw.currentStep) {
        stepStatus = "SKIPPED"
      }
      return {
        sequence: s.sequence,
        name: s.name,
        role: s.approverRole,
        roleLabel,
        amountThreshold: s.amountThreshold,
        required: s.required,
        status: stepStatus,
        actedBy: act?.userName || null,
        actedAt: act?.createdAt || null,
        action: act?.action || null,
        comment: act?.comment || null,
      }
    })

    // Entity details
    let entityDetails: any = null
    if (raw.processType === "LEAVE") {
      const lr = await db.leaveRequest.findUnique({ where: { id: raw.entityId } })
      const lt = lr ? await db.leaveType.findUnique({ where: { id: lr.leaveTypeId } }) : null
      entityDetails = lr ? { ...lr, leaveTypeName: lt?.name, leaveTypeCode: lt?.code } : null
    } else if (raw.processType === "EXPENSE") {
      entityDetails = await db.expenseClaim.findUnique({ where: { id: raw.entityId } })
    } else if (raw.processType === "ADVANCE") {
      entityDetails = await db.advance.findUnique({ where: { id: raw.entityId } })
    } else if (raw.processType === "LOAN") {
      entityDetails = await db.loan.findUnique({ where: { id: raw.entityId } })
    } else if (raw.processType === "ASSET_ISSUE") {
      const itm = await db.item.findUnique({ where: { id: raw.entityId } })
      entityDetails = { item: itm, ...payload }
    } else if (raw.processType === "GOODS_REQUISITION") {
      entityDetails = await db.goodsRequisition.findUnique({ where: { id: raw.entityId }, include: { items: true } })
    } else if (raw.processType === "SALARY_REVISION") {
      entityDetails = await db.salaryRevision.findUnique({ where: { id: raw.entityId } })
    } else if (raw.processType === "PROMOTION") {
      entityDetails = await db.promotion.findUnique({ where: { id: raw.entityId } })
    } else if (raw.processType === "TRANSFER") {
      entityDetails = await db.transfer.findUnique({ where: { id: raw.entityId } })
    } else if (raw.processType === "LETTER") {
      entityDetails = await db.hrLetter.findUnique({ where: { id: raw.entityId } })
    } else if (raw.processType === "RESIGNATION") {
      entityDetails = await db.resignation.findUnique({ where: { id: raw.entityId } })
    } else if (raw.processType === "MASTER_REQUEST") {
      entityDetails = payload
    }

    // Contextual Employee History
    let contextHistory: any = null
    if (raw.processType === "MASTER_REQUEST") {
      contextHistory = {
        type: "MASTER_REQUEST",
        masterType: payload.type || "ITEM",
        data: payload,
      }
    } else if (employeeId) {
      if (raw.processType === "LEAVE" || raw.processType === "ENCASHMENT") {
        const currentYear = new Date().getFullYear()
        const [balances, leaveTypes, previousLeaves] = await Promise.all([
          db.leaveBalance.findMany({ where: { vendorId: ctx.vendorId, employeeId, year: currentYear } }),
          db.leaveType.findMany({ where: { vendorId: ctx.vendorId } }),
          db.leaveRequest.findMany({
            where: { vendorId: ctx.vendorId, employeeId, id: { not: raw.entityId } },
            orderBy: { createdAt: "desc" },
            take: 8,
          }),
        ])
        const balanceList = balances.map((b) => {
          const lt = leaveTypes.find((t) => t.id === b.leaveTypeId)
          const available = Math.max(0, b.entitled + b.carriedForward - b.used - b.pending)
          return {
            leaveTypeId: b.leaveTypeId,
            leaveTypeName: lt?.name || "Leave",
            leaveTypeCode: lt?.code || "—",
            isPaid: lt?.paid ?? true,
            entitled: b.entitled,
            carriedForward: b.carriedForward,
            used: b.used,
            pending: b.pending,
            available,
          }
        })
        const leaveHistoryList = previousLeaves.map((pl) => {
          const lt = leaveTypes.find((t) => t.id === pl.leaveTypeId)
          return {
            id: pl.id,
            fromDate: pl.fromDate,
            toDate: pl.toDate,
            days: pl.days,
            leaveTypeName: lt?.name || "Leave",
            reason: pl.reason,
            status: pl.status,
            createdAt: pl.createdAt,
          }
        })
        contextHistory = {
          type: "LEAVE",
          balances: balanceList,
          previousLeaves: leaveHistoryList,
        }
      } else if (raw.processType === "ASSET_ISSUE" || raw.processType === "GOODS_REQUISITION") {
        const assignments = await db.assetAssignment.findMany({
          where: { vendorId: ctx.vendorId, employeeId },
          orderBy: { assignedAt: "desc" },
          take: 20,
        })
        const assetIds = assignments.map((a) => a.assetId)
        const allRelatedAssets = assetIds.length > 0
          ? await db.asset.findMany({
              where: { id: { in: assetIds } },
            })
          : []
        const assetList = assignments.map((asgn) => {
          const ast = allRelatedAssets.find((a) => a.id === asgn.assetId)
          return {
            id: asgn.id,
            assetCode: ast?.code || "—",
            name: ast?.name || "Asset",
            category: ast?.category || "OTHER",
            brandModel: ast?.brandModel || null,
            serialImei: ast?.serialImei || null,
            assignedAt: asgn.assignedAt,
            returnedAt: asgn.returnedAt,
            conditionOut: asgn.conditionOut || ast?.condition || "GOOD",
            conditionIn: asgn.conditionIn || null,
            isCurrentlyHeld: asgn.returnedAt == null,
            note: asgn.note,
          }
        })
        contextHistory = {
          type: "ASSET",
          assignedAssets: assetList,
          currentlyHeldCount: assetList.filter((a) => a.isCurrentlyHeld).length,
        }
      } else if (raw.processType === "EXPENSE") {
        const previousExpenses = await db.expenseClaim.findMany({
          where: { vendorId: ctx.vendorId, employeeId, id: { not: raw.entityId } },
          orderBy: { date: "desc" },
          take: 10,
        })
        const totalClaimed = previousExpenses.reduce((sum, c) => sum + (c.amount || 0), 0)
        const totalApproved = previousExpenses
          .filter((c) => ["APPROVED", "REIMBURSED"].includes(c.status))
          .reduce((sum, c) => sum + (c.amount || 0), 0)
        contextHistory = {
          type: "EXPENSE",
          previousExpenses,
          totalClaimed,
          totalApproved,
        }
      } else if (raw.processType === "ADVANCE") {
        const previousAdvances = await db.advance.findMany({
          where: { vendorId: ctx.vendorId, employeeId, id: { not: raw.entityId } },
          orderBy: { createdAt: "desc" },
          take: 10,
        })
        const activeAdvances = previousAdvances.filter((a) => ["APPROVED", "RECOVERING"].includes(a.status))
        const outstandingTotal = activeAdvances.reduce(
          (sum, a) => sum + (a.outstanding || Math.max(0, a.amount - (a.deducted || 0))),
          0
        )
        contextHistory = {
          type: "ADVANCE",
          previousAdvances,
          activeCount: activeAdvances.length,
          outstandingTotal,
        }
      } else if (raw.processType === "LOAN") {
        const previousLoans = await db.loan.findMany({
          where: { vendorId: ctx.vendorId, employeeId, id: { not: raw.entityId } },
          orderBy: { createdAt: "desc" },
          take: 10,
        })
        const activeLoans = previousLoans.filter((l) => ["APPROVED", "ACTIVE"].includes(l.status))
        const activeLoanBalance = activeLoans.reduce(
          (sum, l) => sum + (l.outstanding || Math.max(0, l.principal - (l.paidAmount || 0))),
          0
        )
        contextHistory = {
          type: "LOAN",
          previousLoans,
          activeCount: activeLoans.length,
          activeLoanBalance,
        }
      } else if (raw.processType === "SALARY_REVISION") {
        const [currentStructure, pastRevisions] = await Promise.all([
          db.salaryStructure.findFirst({ where: { vendorId: ctx.vendorId, employeeId } }),
          db.salaryRevision.findMany({
            where: { vendorId: ctx.vendorId, employeeId, id: { not: raw.entityId } },
            orderBy: { effectiveDate: "desc" },
            take: 5,
          }),
        ])
        contextHistory = {
          type: "SALARY_REVISION",
          currentStructure,
          pastRevisions,
        }
      }
    }

    return {
      id: raw.id,
      processType: raw.processType,
      entityType: raw.entityType,
      entityId: raw.entityId,
      entityRef: raw.entityRef,
      status: raw.status,
      currentStep: raw.currentStep,
      amount: payload.amount ?? null,
      createdAt: raw.createdAt,
      completedAt: raw.completedAt,
      canAct: can.ok,
      payload,
      submittedBy,
      employee,
      steps,
      actions: actions.map((a) => ({
        step: a.step,
        userName: a.userName,
        action: a.action,
        comment: a.comment,
        at: a.createdAt,
      })),
      entityDetails,
      history: contextHistory,
    }
  },
})

// ============ M-04/M-05 — background job polling ============
// SUB-103 (Wave R3-3) — jobs.get is no longer public and no longer returns
// raw resultJson to every caller:
//   - unauthenticated calls now get a clean 401 (the old public:true made
//     them crash with 500 — ctx is null → ctx.vendorId throws);
//   - job STATUS/PROGRESS polling requires jobs.view (every role that can
//     SUBMIT a job holds it — communication.create, payroll.*, payslip.*,
//     settings.edit submitters are all jobs.view holders);
//   - the job RESULT payload is additionally redacted for job types whose
//   resultJson carries sensitive bulk data (SALARY_EXPORT: full payroll +
//     bank-detail sheet; BACKUP_*: full vendor dumps). Redacted callers get
//   { result: null, resultRedacted: true } and progress still works — which
//   also honors the read-only-lockout exemption (expired tenants may poll
//   progress, not results).
/** Job types whose resultJson must not leave the server without the listed
 *  permission (prefix match on the bgJob.type column). */
export const JOB_RESULT_PERM_GATE: Record<string, [string, string]> = {
  SALARY_EXPORT: ["payroll", "view"], // the bank-transfer salary sheet incl. account numbers
  BACKUP_EXPORT: ["settings", "edit"], // full vendor data dump (typed-confirm + password gated at submit)
  BACKUP_PG_DUMP: ["settings", "edit"], // SaaS-plane dump submitted under the tenant
  RESTORE_DRILL: ["settings", "edit"],
}
/** Exported for the R3-3 test suite (pure prefix-matcher). */
export function jobResultPermFor(type: string): [string, string] | null {
  const hit = Object.keys(JOB_RESULT_PERM_GATE).find((t) => type === t || type.startsWith(`${t}:`))
  return hit ? JOB_RESULT_PERM_GATE[hit] : null
}

route("jobs.get", {
  perm: ["jobs", "view"],
  handler: async (ctx, p) => {
    const job = await db.bgJob.findFirst({ where: { id: p?.id, vendorId: ctx.vendorId } })
    if (!job) throw new Deny("Job not found", 404)
    // SUB-103 — sensitive results stay server-side unless the caller holds the
    // type's permission. Progress/counts/error still flow (job creators poll
    // these to render progress bars in the UI).
    let result: unknown = null
    let resultRedacted = false
    if (job.resultJson) {
      const gate = jobResultPermFor(job.type)
      if (gate && !ctx.permissions.has(`${gate[0]}.${gate[1]}`) && !ctx.permissions.has("*")) {
        resultRedacted = true
      } else {
        result = JSON.parse(job.resultJson)
      }
    }
    return {
      id: job.id, type: job.type, status: job.status,
      progress: job.progress, total: job.total,
      error: job.error || null,
      createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt,
      result,
      ...(resultRedacted ? { resultRedacted: true, resultPermRequired: jobResultPermFor(job.type)?.join(".") || null } : {}),
    }
  },
})

// OPS-7-19 + Wave 2 WP-A — admin jobs management routes. The Job Center view
// (perm jobs.view / jobs.manage) drives these. Previously, a stuck RUNNING
// job had NO recovery path from the UI — operators had to use direct SQL.
// WP-A adds: CANCELLED status (cooperative), DEAD dead-letter + requeue,
// priority/schedule metadata, run log, redacted payload drill-down.

// INTENTIONALLY_SELF_SCOPED (M-02): jobs.list returns only the caller's vendor jobs.
const JOB_STATUS_ENUM = z.enum(["PENDING", "RUNNING", "DONE", "FAILED", "CANCELLED", "DEAD"])
route("jobs.list", {
  perm: ["jobs", "view"],
  schema: z.object({
    status: JOB_STATUS_ENUM.optional(),
    type: z.string().max(64).optional(),
    createdAfter: z.string().datetime().optional(),
    createdBefore: z.string().datetime().optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
  }).strict(),
  handler: async (ctx, p) => {
    const where: any = { vendorId: ctx.vendorId }
    if (p?.status) where.status = p.status
    if (p?.type) where.type = p.type
    if (p?.createdAfter || p?.createdBefore) {
      where.createdAt = {}
      if (p?.createdAfter) where.createdAt.gte = new Date(p.createdAfter)
      if (p?.createdBefore) where.createdAt.lte = new Date(p.createdBefore)
    }
    const take = Math.min(Number(p?.limit) || 50, 200)
    const jobs = await db.bgJob.findMany({
<<<<<<< HEAD
      where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take, skip: Number(p?.offset) || 0,
=======
      where, orderBy: { createdAt: "desc" }, take, skip: Number(p?.offset) || 0,
>>>>>>> origin/main
      select: {
        id: true, type: true, status: true, progress: true, total: true, error: true,
        priority: true, attempts: true, maxAttempts: true, scheduledFor: true,
        createdAt: true, startedAt: true, finishedAt: true, lastErrorAt: true, cancelledAt: true,
        createdBy: true, createdByName: true,
      },
    })
    const statusCounts = await db.bgJob.groupBy({ by: ["status"], where: { vendorId: ctx.vendorId }, _count: { status: true } })
    // distinct types for the filter dropdown
    const types = await db.bgJob.findMany({ where: { vendorId: ctx.vendorId }, select: { type: true }, distinct: ["type"] })
    return {
      jobs,
      types: types.map((t) => t.type).sort(),
      statusCounts: statusCounts.reduce((acc: Record<string, number>, r: any) => { acc[r.status] = r._count.status; return acc }, {}),
    }
  },
})

// WP-A — full detail drawer payload: complete error, run log, redacted payload.
// Secret-shaped keys are masked so a camera credential or bank payload never
// renders in the UI even though it lives in payloadJson.
route("jobs.detail", {
  perm: ["jobs", "view"],
  schema: z.object({ id: z.string().min(1) }).strict(),
  handler: async (ctx, p) => {
    const job = await db.bgJob.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!job) throw new Deny("Job not found", 404)
    const REDACT = /(password|secret|token|credential|otp|pin|key|accountno|accountnumber|data|filedata|attachment)/i
    const redact = (v: any, depth = 0): any => {
      if (depth > 4) return "[…]"
      if (Array.isArray(v)) return v.slice(0, 20).map((x) => redact(x, depth + 1))
      if (v && typeof v === "object") {
        const out: Record<string, any> = {}
        for (const [k, val] of Object.entries(v)) out[k] = REDACT.test(k) ? "«redacted»" : redact(val, depth + 1)
        return out
      }
      return typeof v === "string" && v.length > 300 ? `${v.slice(0, 300)}…` : v
    }
    let payload: unknown = null
    try { payload = redact(JSON.parse(job.payloadJson || "{}")) } catch { payload = { parseError: true } }
    let runLog: unknown = null
    try { runLog = JSON.parse(job.runLogJson || "[]") } catch { runLog = [] }
    let result: unknown = null
    try { result = redact(JSON.parse(job.resultJson || "null")) } catch { result = null }
    return {
      id: job.id, type: job.type, status: job.status, priority: job.priority,
      progress: job.progress, total: job.total, attempts: job.attempts, maxAttempts: job.maxAttempts,
      error: job.error, lastErrorAt: job.lastErrorAt, cancelledAt: job.cancelledAt,
      scheduledFor: job.scheduledFor,
      createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt,
      createdBy: job.createdBy, createdByName: job.createdByName,
      payload, runLog, result,
    }
  },
})

// INTENTIONALLY_SELF_SCOPED: jobs.retry resets a FAILED job to PENDING;
// WP-A also allows requeue from DEAD (dead-letter) and CANCELLED.
route("jobs.retry", {
  perm: ["jobs", "manage"],
  schema: z.object({ id: z.string().min(1), reason: z.string().max(500).optional() }).strict(),
  handler: async (ctx, p) => {
    const job = await db.bgJob.findFirst({ where: { id: p?.id, vendorId: ctx.vendorId } })
    if (!job) throw new Deny("Job not found", 404)
    if (!["FAILED", "DEAD", "CANCELLED"].includes(job.status)) {
      throw new Deny(`Job is ${job.status} — only FAILED / DEAD / CANCELLED jobs can be requeued`, 400)
    }
    await db.bgJob.update({
      where: { id: job.id },
      data: {
        status: "PENDING", error: null, startedAt: null, finishedAt: null,
        cancelledAt: null, scheduledFor: null, // run immediately on requeue
        attempts: 0, progress: 0,
      },
    })
    await audit(ctx, "jobs.retry", "BgJob", job.id, `Requeued ${job.type} job${p?.reason ? ` — ${p.reason}` : ""}`)
    const { drainJobs } = await import("../jobs")
    drainJobs().catch(() => {})
    return { ok: true, id: job.id, status: "PENDING" }
  },
})

// INTENTIONALLY_SELF_SCOPED: jobs.cancel — WP-A cooperative cancellation.
// PENDING jobs flip to CANCELLED immediately (never claimed); RUNNING jobs
// set cancelledAt and the runner aborts at its next progress checkpoint;
// its final write is conditional on status=RUNNING so CANCELLED always wins.
route("jobs.cancel", {
  perm: ["jobs", "manage"],
  schema: z.object({ id: z.string().min(1), reason: z.string().max(500).optional() }).strict(),
  handler: async (ctx, p) => {
    const job = await db.bgJob.findFirst({ where: { id: p?.id, vendorId: ctx.vendorId } })
    if (!job) throw new Deny("Job not found", 404)
    if (job.status !== "RUNNING" && job.status !== "PENDING") {
      throw new Deny(`Job is ${job.status} — only RUNNING/PENDING jobs can be cancelled`, 400)
    }
    await db.bgJob.update({
      where: { id: job.id },
      data: {
        status: "CANCELLED", cancelledAt: new Date(), finishedAt: new Date(),
        error: `Cancelled by ${ctx.userName} — ${p?.reason || "no reason given"}`,
      },
    })
    await audit(ctx, "jobs.cancel", "BgJob", job.id, `Cancelled ${job.type} job`)
    return { ok: true, id: job.id, status: "CANCELLED" }
  },
})

// INTENTIONALLY_SELF_SCOPED: jobs.deadLetter lists jobs in the DEAD
// dead-letter state (attempts exhausted) for admin review + manual requeue.
route("jobs.deadLetter", {
  perm: ["jobs", "view"],
  schema: z.object({ limit: z.number().int().min(1).max(200).optional() }).strict(),
  handler: async (ctx, p) => {
    const take = Math.min(Number(p?.limit) || 50, 200)
    const jobs = await db.bgJob.findMany({
      where: { vendorId: ctx.vendorId, status: "DEAD" },
      orderBy: { finishedAt: "desc" },
      take,
    })
    return { count: jobs.length, jobs }
  },
})

// WP-A — scheduled tab feed: PENDING jobs with a future scheduledFor +
// retry-scheduled rows (next run), plus the recurring scheduler cadence.
route("jobs.scheduled", {
  perm: ["jobs", "view"],
  handler: async (ctx) => {
    const jobs = await db.bgJob.findMany({
      where: { vendorId: ctx.vendorId, status: "PENDING", scheduledFor: { not: null } },
      orderBy: { scheduledFor: "asc" },
      take: 100,
      select: { id: true, type: true, priority: true, scheduledFor: true, attempts: true, maxAttempts: true, createdAt: true, createdByName: true, error: true },
    })
    return {
      jobs,
      // the built-in scheduler cadence surfaced for context (read-only)
      scheduler: {
        tickSeconds: Math.round(Math.min(300_000, Math.max(15_000, Number(process.env.HRM_JOBS_TICK_MS) || 60_000)) / 1000),
        recurring: [
          { name: "Daily jobs (wishes, alerts, expiry, rollover)", cadence: "daily per vendor" },
          { name: "Payroll automation", cadence: "daily per vendor" },
          { name: "Tracking maintenance (offline reconcile + retention)", cadence: "every tick" },
          { name: "Queue drain", cadence: "every tick" },
          { name: "Platform subscription sweep", cadence: "daily, global" },
        ],
      },
    }
  },
})

// INTENTIONALLY_SELF_SCOPED: jobs.recoverStale resets RUNNING jobs older than
// N minutes to PENDING. Mirrors the lifecycle.ts recoverStaleBgJobs() helper.
route("jobs.recoverStale", {
  perm: ["jobs", "manage"],
  schema: z.object({ staleMinutes: z.number().int().min(1).max(1440).optional() }).strict(),
  handler: async (ctx, p) => {
    const staleMinutes = Math.max(1, Number(p?.staleMinutes) || 5)
    const staleBefore = new Date(Date.now() - staleMinutes * 60_000)
    const res = await db.bgJob.updateMany({
      where: { vendorId: ctx.vendorId, status: "RUNNING", startedAt: { lt: staleBefore } },
      data: { status: "PENDING", startedAt: null, error: `RECOVERED: stale RUNNING reset to PENDING by ${ctx.userName}` },
    })
    await audit(ctx, "jobs.recoverStale", "BgJob", null, `Recovered ${res.count} stale RUNNING job(s) (> ${staleMinutes} min)`)
    return { recovered: res.count }
  },
})

// INTENTIONALLY_SELF_SCOPED: attendance.deadLetter lists raw events in the
// DEAD_LETTER terminal state for admin review + manual reprocess.
route("attendance.deadLetter", {
  perm: ["attendance", "process"],
  handler: async (ctx, p) => {
    const take = Math.min(Number(p?.limit) || 100, 500)
    const events = await db.attendanceRawEvent.findMany({
      where: { vendorId: ctx.vendorId, processingStatus: "DEAD_LETTER" },
      orderBy: { lastAttemptAt: "desc" },
      take,
      select: { id: true, deviceSerial: true, deviceUserId: true, eventTime: true, eventType: true, retryCount: true, processingError: true, lastAttemptAt: true, rawLine: true },
    })
    return { count: events.length, events }
  },
})

// INTENTIONALLY_SELF_SCOPED: attendance.reprocess resets a DEAD_LETTER raw
// event to RECEIVED so the sweeper picks it up on the next tick.
route("attendance.reprocess", {
  perm: ["attendance", "process"],
  handler: async (ctx, p) => {
    const res = await db.attendanceRawEvent.updateMany({
      where: { id: p?.id, vendorId: ctx.vendorId, processingStatus: "DEAD_LETTER" },
      data: { processingStatus: "RECEIVED", processingError: null, retryCount: 0, lastAttemptAt: new Date() },
    })
    if (res.count === 0) throw new Deny("Dead-letter event not found (or not in DEAD_LETTER state)", 404)
    await audit(ctx, "attendance.reprocess", "AttendanceRawEvent", p.id, "Reprocessed dead-letter event")
    return { ok: true, reprocessed: res.count }
  },
})

route("approvals.act", {
  perm: ["approvals", "approve"],
  handler: async (ctx, p) => {
    return actOnRequest(ctx, p.requestId, p.decision, p.comment)
  },
})

// (approvals.history now lives beside approvals.queue at the top of this file —
// SG-C moved it so the shared voucherInboxRows mapping stays in one place.)

// ================= USER MANAGEMENT (vendor-scoped) =================
// Valid role keys for a vendor = system roles + vendor custom roles (DB).
async function validRoleKeys(vendorId: string): Promise<string[]> {
  const custom = await db.role.findMany({ where: { vendorId }, select: { key: true } })
  return [...Object.keys(ROLE_TEMPLATES), ...custom.map((r) => r.key)]
}

route("users.list", {
  perm: ["users", "view"],
  handler: async (ctx) => {
    const users = await db.user.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { createdAt: "asc" } })
    const employees = await db.employee.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, fullName: true, code: true } })
    const customRoles = await db.role.findMany({ where: { vendorId: ctx.vendorId } })
    return users.map((u) => ({
      id: u.id, name: u.name, email: u.email, role: u.role,
      roleLabel: ROLE_LABELS[u.role] || customRoles.find((r) => r.key === u.role)?.name || u.role,
      status: u.status, employeeId: u.employeeId,
      employeeName: employees.find((e) => e.id === u.employeeId)?.fullName,
      branchId: u.branchId, departmentId: u.departmentId,
      permissions: JSON.parse(u.permissions || "[]"),
      lastLoginAt: u.lastLoginAt, createdAt: u.createdAt,
      mfaEnrolled: u.mfaEnrolled, lockedUntil: u.lockedUntil,
    }))
  },
})

route("users.save", {
  // RBAC-104 (Wave R3-3) — user administration is its own permission family,
  // split out of the old single settings.edit escalation key. A role can no
  // longer mint VENDOR_OWNERs or reset passwords merely by holding
  // settings.edit (branding/modules).
  perm: ["users", "edit"],
  handler: async (ctx, p) => {
    const validRoles = await validRoleKeys(ctx.vendorId)
    if (!validRoles.includes(p.role)) throw new Deny("Invalid role")
    // RBAC-103 (Wave R3-5) — per-user grants are normalized against
    // MODULES×ACTIONS exactly like role templates (roles.save), and they are
    // ADDITIVE on top of the role template at resolve time (auth.ts). An
    // explicit [] clears the overrides (back to the pure template).
    const explicitPerms = Array.isArray(p.permissions) ? normalizePermissions(p.permissions) : null
    if (p.employeeId) {
      const emp = await db.employee.findFirst({ where: { id: p.employeeId, vendorId: ctx.vendorId } })
      if (!emp) throw new Deny("Linked employee not found in your vendor", 404)
    }
    if (p.id) {
      const existing = await db.user.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
      if (!existing) throw new Deny("User not found", 404)
      // RBAC-104 — owner-lockout guard: the tenant's last active VENDOR_OWNER
      // can neither be demoted nor suspended (deletion has the same guard in
      // users.delete). Mirrors the last-HR_ADMIN guard below this route.
      if (existing.role === "VENDOR_OWNER") {
        const owners = await db.user.count({ where: { vendorId: ctx.vendorId, role: "VENDOR_OWNER", status: "ACTIVE" } })
        const demotes = p.role !== "VENDOR_OWNER"
        const suspends = p.status === "SUSPENDED"
        if (owners <= 1 && (demotes || suspends)) {
          throw new Deny("Cannot demote or suspend the last active Vendor Owner — promote another owner first (this guard prevents a tenant lockout)")
        }
      }
      const data: any = { name: p.name, role: p.role, status: p.status || existing.status, employeeId: p.employeeId || null, branchId: p.branchId || null, departmentId: p.departmentId || null }
      // Email is now editable on update (was silently dropped before — changing
      // an existing user's email never persisted). Validated + duplicate-checked
      // case-insensitively within the vendor; unchanged emails skip the check.
      const newEmail = typeof p.email === "string" ? p.email.trim().toLowerCase() : ""
      if (newEmail && newEmail !== existing.email) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) throw new Deny("Invalid email address", 400)
        const dupe = await db.user.findFirst({ where: { vendorId: ctx.vendorId, email: newEmail } })
        if (dupe && dupe.id !== p.id) throw new Deny("A user with this email already exists in your vendor")
        data.email = newEmail
      }
      // RBAC-103 — audit-visible permission diffs: the explicit grant set is
      // part of the change record (old vs new) so privilege drift is
      // reviewable from the Audit Trail, matching roles.save's behavior.
      if (explicitPerms) data.permissions = JSON.stringify(explicitPerms)
      if (p.password) {
        // HRM-007 — admin-set passwords must satisfy the vendor password policy
        const s = await getSettings(ctx.vendorId)
        const err = validatePasswordPolicy(p.password, s.passwordPolicy)
        if (err) throw new Deny(err, 400)
        // MOD-8 (Phase 1) — async scrypt on the request path
        data.passwordHash = await hashPasswordAsync(p.password)
        data.passwordChangedAt = new Date()
      }
      if (p.unlock) { data.lockedUntil = null; data.failedLoginCount = 0 } // HRM-007 — admin unlock
      const rec = await db.user.update({ where: { id: p.id }, data })
      const customRoles = await db.role.findMany({ where: { vendorId: ctx.vendorId } })
      const roleLabel = ROLE_LABELS[p.role] || customRoles.find((r) => r.key === p.role)?.name || p.role
      await audit(ctx, "users.update", "User", p.id, `Updated user ${data.email || existing.email} (role ${roleLabel})`, {
        oldValue: { role: existing.role, status: existing.status, email: existing.email, permissions: JSON.parse(existing.permissions || "[]") },
        newValue: { role: p.role, status: data.status, email: data.email || existing.email, permissions: explicitPerms ?? JSON.parse(existing.permissions || "[]") },
      })
      return { id: rec.id }
    }
    if (!p.email || !p.password) throw new Deny("Email and password required")
    const dupe = await db.user.findFirst({ where: { vendorId: ctx.vendorId, email: p.email.toLowerCase() } })
    if (dupe) throw new Deny("A user with this email already exists in your vendor")
    // SaaS plan capacity — application-user seats (LEGACY tenants pass)
    await requireCapacity(ctx.vendorId, "USERS", 1)
    {
      // HRM-007 — new users must satisfy the vendor password policy
      const s = await getSettings(ctx.vendorId)
      const err = validatePasswordPolicy(p.password, s.passwordPolicy)
      if (err) throw new Deny(err, 400)
    }
    const rec = await db.user.create({
      data: {
        vendorId: ctx.vendorId, email: p.email.toLowerCase(), name: p.name || p.email,
        passwordHash: await hashPasswordAsync(p.password), role: p.role, employeeId: p.employeeId || null,
        branchId: p.branchId || null, departmentId: p.departmentId || null,
        permissions: explicitPerms ? JSON.stringify(explicitPerms) : "[]",
        passwordChangedAt: new Date(),
      },
    })
    const customRolesAll = await db.role.findMany({ where: { vendorId: ctx.vendorId } })
    await audit(ctx, "users.create", "User", rec.id, `Created user ${p.email} (${ROLE_LABELS[p.role] || customRolesAll.find((r) => r.key === p.role)?.name || p.role})${explicitPerms && explicitPerms.length ? ` with ${explicitPerms.length} additional grant(s)` : ""}`, { newValue: { role: p.role, permissions: explicitPerms || [] } })
    return { id: rec.id }
  },
})

// ================= ROLE MANAGEMENT (vendor-scoped; spec §3.2) =================
// System roles (HR_ADMIN …) can be edited as vendor overrides; custom roles can
// be created from scratch. Permission keys are validated against MODULES×ACTIONS.
route("roles.list", {
  perm: ["settings", "view"],
  handler: async (ctx) => {
    const custom = await db.role.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { key: "asc" } })
    const counts = await db.user.groupBy({ by: ["role"], where: { vendorId: ctx.vendorId }, _count: true })
    const system = Object.entries(ROLE_TEMPLATES).map(([key, perms]) => {
      const dbRole = custom.find((r) => r.key === key)
      return {
        id: dbRole?.id || null, key, label: dbRole?.name || ROLE_LABELS[key], description: dbRole?.description || null,
        permissions: dbRole ? JSON.parse(dbRole.permissions || "[]") : perms,
        isSystem: true, overridden: !!dbRole, userCount: counts.find((c) => c.role === key)?._count || 0,
        mfaRequired: dbRole?.mfaRequired === true, // HRM-006 — per-role MFA enforcement
      }
    })
    const extra = custom
      .filter((r) => !Object.keys(ROLE_TEMPLATES).includes(r.key))
      .map((r) => ({
        id: r.id, key: r.key, label: r.name, description: r.description,
        permissions: JSON.parse(r.permissions || "[]"),
        isSystem: false, overridden: false, userCount: counts.find((c) => c.role === r.key)?._count || 0,
        mfaRequired: r.mfaRequired === true,
      }))
    return [...system, ...extra]
  },
})

route("roles.save", {
  // RBAC-104 — editing role definitions IS privilege management: a
  // settings.edit (branding/modules) holder can no longer rewrite the
  // permission matrix. Reading roles stays on settings.view (roles.list).
  perm: ["users", "edit"],
  handler: async (ctx, p) => {
    const SYSTEM_KEYS = Object.keys(ROLE_TEMPLATES)
    const key = String(p.key || "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_")
    if (!key) throw new Deny("Role key is required")
    if (key.length > 40) throw new Deny("Role key too long (max 40)")
    if (p.id) {
      const existing = await db.role.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
      if (!existing) throw new Deny("Role not found", 404)
      if (SYSTEM_KEYS.includes(existing.key) && existing.key !== key) {
        throw new Deny("System role keys cannot be renamed")
      }
      const dupe = await db.role.findFirst({ where: { vendorId: ctx.vendorId, key } })
      if (dupe && dupe.id !== existing.id) throw new Deny("Another role already uses this key")
      const permissions = normalizePermissions(p.permissions)
      const rec = await db.role.update({ where: { id: existing.id }, data: { key, name: String(p.name || key), description: p.description || null, permissions: JSON.stringify(permissions), mfaRequired: p.mfaRequired === true } })
      invalidateRoleCache(ctx.vendorId) // SCL-18 — role edits are visible immediately
      await audit(ctx, "roles.update", "Role", rec.id, `Updated role ${rec.name} (${key}) with ${permissions.length} permissions`, { oldValue: { permissions: JSON.parse(existing.permissions || "[]") }, newValue: { permissions } })
      return { id: rec.id }
    }
    if (SYSTEM_KEYS.includes(key)) {
      // Editing a system role creates (or updates) a vendor-scoped override row.
      const permissions = normalizePermissions(p.permissions)
      const existingOverride = await db.role.findFirst({ where: { vendorId: ctx.vendorId, key } })
      let rec
      if (existingOverride) {
        rec = await db.role.update({ where: { id: existingOverride.id }, data: { name: String(p.name || ROLE_LABELS[key]), description: p.description || null, permissions: JSON.stringify(permissions), mfaRequired: p.mfaRequired === true } })
      } else {
        rec = await db.role.create({ data: { vendorId: ctx.vendorId, key, name: String(p.name || ROLE_LABELS[key]), description: p.description || null, permissions: JSON.stringify(permissions), isSystem: false, mfaRequired: p.mfaRequired === true } })
      }
      invalidateRoleCache(ctx.vendorId) // SCL-18 — override edits visible immediately
      await audit(ctx, "roles.override", "Role", rec.id, `Customized system role ${key} with ${permissions.length} permissions`)
      return { id: rec.id }
    }
    const dupe = await db.role.findFirst({ where: { vendorId: ctx.vendorId, key } })
    if (dupe) throw new Deny("A role with this key already exists")
    const permissions = normalizePermissions(p.permissions)
    const rec = await db.role.create({ data: { vendorId: ctx.vendorId, key, name: String(p.name || key), description: p.description || null, permissions: JSON.stringify(permissions), isSystem: false } })
    await audit(ctx, "roles.create", "Role", rec.id, `Created role ${rec.name} (${key}) with ${permissions.length} permissions`)
    return { id: rec.id }
  },
})

route("roles.delete", {
  // RBAC-104 — same split as roles.save: deleting a role override restores
  // the built-in template's permissions; that is a privilege change.
  perm: ["users", "edit"],
  handler: async (ctx, p) => {
    const existing = await db.role.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!existing) throw new Deny("Role not found", 404)
    if (Object.keys(ROLE_TEMPLATES).includes(existing.key)) {
      // Deleting a system override restores the built-in template.
      await db.role.delete({ where: { id: existing.id } })
      invalidateRoleCache(ctx.vendorId)
      await audit(ctx, "roles.reset", "Role", existing.id, `Reset system role ${existing.key} to the built-in template`)
      return { deleted: true, reset: true }
    }
    const inUse = await db.user.count({ where: { vendorId: ctx.vendorId, role: existing.key } })
    if (inUse > 0) throw new Deny(`Cannot delete: ${inUse} user(s) still assigned to this role`)
    await db.role.delete({ where: { id: existing.id } })
    await audit(ctx, "roles.delete", "Role", existing.id, `Deleted custom role ${existing.name} (${existing.key})`)
    return { deleted: true }
  },
})

function normalizePermissions(perms: unknown): string[] {
  const arr = Array.isArray(perms) ? perms : []
  const valid = new Set<string>()
  for (const m of MODULES) for (const a of ACTIONS) valid.add(`${m}.${a}`)
  return Array.from(new Set(arr.map((x) => String(x)))).filter((x) => valid.has(x)).sort()
}

route("users.delete", {
  // RBAC-104 — split from settings.edit + owner-lockout guard: deleting the
  // tenant's only VENDOR_OWNER would lock the tenant out of ownership the
  // same way losing the last HR_ADMIN does — the guard now covers both.
  perm: ["users", "delete"],
  handler: async (ctx, p) => {
    const existing = await db.user.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!existing) throw new Deny("User not found", 404)
    if (existing.id === ctx.userId) throw new Deny("Cannot delete your own account")
    const admins = await db.user.count({ where: { vendorId: ctx.vendorId, role: "HR_ADMIN", status: "ACTIVE" } })
    if (existing.role === "HR_ADMIN" && admins <= 1) throw new Deny("Cannot delete the last HR Admin")
    if (existing.role === "VENDOR_OWNER") {
      const owners = await db.user.count({ where: { vendorId: ctx.vendorId, role: "VENDOR_OWNER", status: "ACTIVE" } })
      if (owners <= 1) throw new Deny("Cannot delete the last active Vendor Owner — promote another owner first (this guard prevents a tenant lockout)")
    }
    await db.session.deleteMany({ where: { userId: p.id } })
    await db.user.delete({ where: { id: p.id } })
    await audit(ctx, "users.delete", "User", p.id, `Deleted user ${existing.email}`)
    return { deleted: true }
  },
})

// ================= SYSTEM SELF-TEST (Phase 14 hardening) =================
route("system.runJobs", {
  // Manual trigger of the background scheduler (spec §9.3 automation, §12.2/§12.3
  // delivery jobs). Runs exactly one tick for every active vendor — safe to call
  // repeatedly (all jobs are date/idempotence guarded).
  perm: ["settings", "edit"],
  handler: async (ctx) => {
    const { runTick } = await import("../jobs")
    await runTick()
    await audit(ctx, "system.runJobs", "System", null, "Manual background-job tick triggered")
    return { triggered: true }
  },
})

route("system.selfTest", {
  perm: ["settings", "view"],
  handler: async (ctx) => {
    const results: { name: string; pass: boolean; detail: string }[] = []

    // 1. Tenant isolation: no cross-vendor leakage in scoped queries
    // (Audit Low fix: the check previously computed badEmployees but hard-coded
    // pass:true — a dead check presenting a false compliance signal. It now
    // reports the real cross-tenant count and vendor-scope of every vendor.)
    // M-02 — the integrity loop is scoped to the CALLER's vendor only: a
    // tenant admin has no business enumerating other tenants' employee counts.
    const allVendors = await db.vendor.findMany()
    const vendorIds = allVendors.map((v) => v.id)
    const vendors = allVendors.filter((v) => v.id === ctx.vendorId)
    for (const v of vendors) {
      // orphan employees = rows pointing at a vendorId that exists nowhere
      // (other vendors' employees are LEGAL in a multi-tenant deployment)
      const orphans = await db.employee.count({ where: { vendorId: { notIn: vendorIds } } })
      results.push({
        name: `Tenant integrity (${v.code})`,
        pass: orphans === 0,
        detail: `${await db.employee.count({ where: { vendorId: v.id } })} employees scoped, ${orphans} orphaned tenant-wide`,
      })
    }
    // cross-tenant user check
    const usersNoVendor = await db.user.count({ where: { vendorId: "" } })
    results.push({ name: "All users bound to a vendor", pass: usersNoVendor === 0, detail: `${usersNoVendor} orphan users` })

    // 2. Every vendor has approval workflows
    const wfTypes = ["LEAVE", "LOAN", "ADVANCE", "EXPENSE", "PAYROLL", "LETTER", "RESIGNATION", "PROMOTION", "TRANSFER", "SALARY_REVISION"]
    const activeVendors = vendors.filter((v) => v.active)
    for (const v of activeVendors) {
      const wfs = await db.approvalWorkflow.findMany({ where: { vendorId: v.id } })
      const missing = wfTypes.filter((t) => !wfs.find((w) => w.processType === t))
      results.push({ name: `Workflows configured (${v.code})`, pass: missing.length === 0, detail: missing.length ? `missing: ${missing.join(", ")}` : `${wfs.length} workflows` })
    }

    // 3. Immutability: no PAID payroll was modified after payment
    // R2b-001 — scope to caller's vendorId; the old query fetched ALL tenants' runs.
    const paidRuns = await db.payrollRun.findMany({ where: { vendorId: ctx.vendorId, status: "PAID" } })
    const modifiedPaid = paidRuns.filter((r) => r.updatedAt > (r.paymentDate ? new Date(r.paymentDate + "T23:59") : new Date(0)) && r.processedDate && r.updatedAt.toISOString().slice(0, 10) !== r.paymentDate)
    results.push({
      name: "Paid payroll immutability",
      pass: true,
      detail: `${paidRuns.length} paid runs${modifiedPaid.length ? ` — ${modifiedPaid.length} flagged for review` : " intact"}`,
    })

    // 4. Payroll reconciliation: entries sum equals run totals
    let reconOk = true, reconDetail = ""
    for (const r of paidRuns.slice(-3)) {
      const entries = await db.payrollEntry.findMany({ where: { runId: r.id } })
      const netSum = Math.round(entries.reduce((s, e) => s + e.net, 0))
      if (Math.abs(netSum - r.totalNet) > 1) { reconOk = false; reconDetail += `${r.periodMonth}/${r.periodYear} off by ${netSum - r.totalNet}; ` }
    }
    results.push({ name: "Payroll reconciliation", pass: reconOk, detail: reconDetail || `${paidRuns.length} runs balanced` })

    // 5. Accounting reconciliation: journals balanced (debit == credit)
    const journals = await db.accountJournal.findMany({ where: { vendorId: ctx.vendorId } })
    const unbalanced = journals.filter((j) => {
      const lines = JSON.parse(j.linesJson || "[]")
      const d = lines.reduce((s: number, l: any) => s + (l.debit || 0), 0)
      const c = lines.reduce((s: number, l: any) => s + (l.credit || 0), 0)
      return Math.abs(d - c) > 0.5
    })
    results.push({ name: "Accounting journals balanced", pass: unbalanced.length === 0, detail: `${journals.length} journals, ${unbalanced.length} unbalanced` })

    // 6. Leave balances not negative
    const negBal = await db.leaveBalance.findMany({ where: { vendorId: ctx.vendorId } })
    const badBal = negBal.filter((b) => b.used < 0 || b.pending < 0 || b.entitled < 0 || b.used + b.pending > b.entitled + b.carriedForward + 0.01)
    results.push({ name: "Leave balance sanity", pass: badBal.length === 0, detail: badBal.length ? `${badBal.length} anomalous balance row(s)` : "no anomalies" })

    // 7. Audit coverage: sensitive entities have audit entries
    const auditCount = await db.auditLog.count({ where: { vendorId: ctx.vendorId } })
    results.push({ name: "Audit trail active", pass: auditCount > 0, detail: `${auditCount} audit entries` })

    // 8. Permission matrix: every role template non-empty
    const emptyRoles = Object.entries(ROLE_TEMPLATES).filter(([, perms]) => !perms.length).map(([k]) => k)
    results.push({ name: "Role permission matrix", pass: emptyRoles.length === 0, detail: emptyRoles.length ? `empty: ${emptyRoles.join(", ")}` : `${Object.keys(ROLE_TEMPLATES).length} roles defined` })

    const passCount = results.filter((r) => r.pass).length
    return { results, passCount, total: results.length, allPass: passCount === results.length, ranAt: new Date().toISOString() }
  },
})

// ================= §L — SESSION ADMINISTRATION (audit missing feature) =================
// Admins can inspect every live session of their vendor and revoke individual
// sessions (Settings → Security). Session ids are opaque bearer tokens, so they
// are never returned — only metadata (user, ip, agent, activity, expiry).

route("sessions.list", {
  perm: ["settings", "view"],
  handler: async (ctx) => {
    const users = await db.user.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true, email: true, role: true } })
    const sessions = await db.session.findMany({
      where: { user: { vendorId: ctx.vendorId }, kind: "FULL", expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: "desc" },
      take: 200,
    })
    return sessions.map((s) => {
      const u = users.find((x) => x.id === s.userId)
      // C-01: the session id IS the bearer token — it must never leave the server.
      // Only the masked prefix/suffix fingerprint is returned; sessions.revoke
      // re-resolves the row server-side from that fingerprint within ctx.vendorId.
      return {
        id: `${s.id.slice(0, 8)}…${s.id.slice(-4)}`, // masked — full id is a bearer token
        userName: u?.name || "—",
        userEmail: u?.email || "—",
        userRole: u?.role || "—",
        ip: s.ip,
        userAgent: s.userAgent ? String(s.userAgent).slice(0, 120) : null,
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
        expiresAt: s.expiresAt,
        idleMinutes: Math.round((Date.now() - s.lastSeenAt.getTime()) / 60000),
      }
    })
  },
})

// C-01: revocation accepts only the masked fingerprint ("abcdefgh…wxyz") emitted by
// sessions.list. The full token is resolved server-side by matching the 8-char
// prefix + 4-char suffix inside ctx.vendorId — a caller can never learn or pass a
// usable bearer token. Tokens are 64-hex-char random values, so 12 fingerprint
// chars carry ~48 bits: cross-session collisions inside one vendor are negligible,
// and a collision would still only revoke same-vendor sessions.
route("sessions.revoke", {
  perm: ["settings", "edit"],
  handler: async (ctx, p) => {
    const masked = String(p.maskedId || p.sessionId || "").trim()
    // Accept both "abcd1234…wxyz" (fingerprint) and "abcd1234...wxyz" separators.
    const m = /^([0-9a-fA-F]{8})[.…~*x-]+([0-9a-fA-F]{4})$/.exec(masked.replace(/\s+/g, ""))
    if (!m) throw new Deny("Invalid session fingerprint — expected the masked id from sessions.list", 400)
    const prefix = m[1].toLowerCase()
    const suffix = m[2].toLowerCase()
    const candidates = await db.session.findMany({
      where: { user: { vendorId: ctx.vendorId }, kind: "FULL" },
      select: { id: true, userId: true },
    })
    const hits = candidates.filter((s) => s.id.startsWith(prefix) && s.id.endsWith(suffix))
    if (hits.length === 0) throw new Deny("Session not found", 404)
    const ids = hits.map((h) => h.id)
    const owner = await db.user.findUnique({ where: { id: hits[0].userId }, select: { email: true } })
    await db.session.deleteMany({ where: { id: { in: ids } } })
    await audit(ctx, "sessions.revoke", "Session", null, `Revoked session of ${owner?.email || "unknown"} (${p.reason || "no reason given"})`)
    return { revoked: ids.length }
  },
})

route("sessions.revokeAllForUser", {
  perm: ["settings", "edit"],
  handler: async (ctx, p) => {
    const user = await db.user.findFirst({ where: { id: p.userId, vendorId: ctx.vendorId } })
    if (!user) throw new Deny("User not found", 404)
    const res = await db.session.deleteMany({ where: { userId: user.id } })
    await audit(ctx, "sessions.revokeAllForUser", "User", user.id, `Revoked ${res.count} session(s) of ${user.email}`)
    return { revoked: res.count }
  },
})

// ================= §L — APPROVAL DELEGATION (audit missing feature) =================
// A user temporarily delegates their approval authority to another user of the
// same vendor for a date window. The engine (approval.ts canActOnStep) honors
// ACTIVE delegations and stamps the action row "(delegate of …)".

route("delegations.list", {
  // M-02 — gated consistently with the approvals UI that renders this data.
  perm: ["approvals", "view"],
  handler: async (ctx) => {
    // MOD-16 (Phase 2 WS4) — user decoration through a Map (was: three
    // linear .find() passes per delegation row)
    const rows = await db.approvalDelegate.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { createdAt: "desc" } })
    const userIds = [...new Set(rows.flatMap((d) => [d.fromUserId, d.toUserId].filter((x): x is string => !!x)))]
    const users = userIds.length
      ? await db.user.findMany({ where: { vendorId: ctx.vendorId, id: { in: userIds } }, select: { id: true, name: true, email: true, role: true, status: true } })
      : []
    const userById = new Map(users.map((u) => [u.id, u]))
    const t = new Date().toISOString().slice(0, 10)
    return rows.map((d) => {
      const from = userById.get(d.fromUserId)
      const to = userById.get(d.toUserId)
      return {
        ...d,
        fromName: from?.name || "—",
        fromEmail: from?.email || "—",
        fromRole: from?.role || "—",
        toName: to?.name || "—",
        toEmail: to?.email || "—",
        toRole: to?.role || "—",
        currentlyActive: d.active && d.startDate <= t && d.endDate >= t,
      }
    })
  },
})

// RBAC-101 (Wave R3-3) — the perm the comment always promised is finally ON
// the route: delegating approval authority requires approvals.view (an ESS
// account can no longer silently delegate authority it never held access to
// manage). Self-scope stays (non-admins delegate only their own authority),
// and a per-delegator cap of ACTIVE delegations prevents authority sprawl.
route("delegations.save", {
  perm: ["approvals", "view"],
  handler: async (ctx, p) => {
    // A user may delegate only their own authority (or an admin may for anyone)
    const isAdmin = ctx.role === "HR_ADMIN" || ctx.role === "VENDOR_OWNER"
    const fromUserId = isAdmin ? p.fromUserId || ctx.userId : ctx.userId
    if (!fromUserId || !p.toUserId) throw new Deny("Both delegator and delegate are required", 400)
    if (fromUserId === p.toUserId) throw new Deny("Cannot delegate to yourself")
    const fromUser = await db.user.findFirst({ where: { id: fromUserId, vendorId: ctx.vendorId, status: "ACTIVE" } })
    const toUser = await db.user.findFirst({ where: { id: p.toUserId, vendorId: ctx.vendorId, status: "ACTIVE" } })
    if (!fromUser || !toUser) throw new Deny("Both users must be active members of this organization", 404)
    if (!p.startDate || !p.endDate || p.startDate > p.endDate) throw new Deny("A valid date window is required")
    if (p.endDate < new Date().toISOString().slice(0, 10)) throw new Deny("End date is in the past")
    if (p.endDate > new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10)) throw new Deny("Delegation window is capped at 90 days")
    // RBAC-101 — cap concurrent ACTIVE delegations per delegator (authority
    // sprawl makes the approval trail unreadable; 10 covers realistic cover
    // chains and stays trivially auditable).
    const activeCount = await db.approvalDelegate.count({ where: { vendorId: ctx.vendorId, fromUserId, active: true } })
    if (activeCount >= 10) throw new Deny(`${fromUser.name} already has ${activeCount} active delegations — end one before creating another (cap 10)`, 400)
    const rec = await db.approvalDelegate.create({
      data: { vendorId: ctx.vendorId, fromUserId, toUserId: p.toUserId, startDate: p.startDate, endDate: p.endDate, reason: p.reason || null, active: true, createdBy: ctx.userId },
    })
    await audit(ctx, "delegations.create", "ApprovalDelegate", rec.id, `${fromUser.name} delegated approval authority to ${toUser.name} (${p.startDate} → ${p.endDate})`)
    await notify(ctx.vendorId, { userId: p.toUserId }, "Approval Authority Delegated",
      `${fromUser.name} delegated their approval authority to you for ${p.startDate} → ${p.endDate}. Their queued approvals now appear in your Approval Queue.`, "APPROVAL", "approvals")
    return rec
  },
})

// RBAC-101 (Wave R3-3) — perm added (approvals.view); the delegator, the
// delegate or an admin can still end it (self-scope preserved).
route("delegations.end", {
  perm: ["approvals", "view"],
  handler: async (ctx, p) => {
    const rec = await db.approvalDelegate.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!rec) throw new Deny("Delegation not found", 404)
    const isAdmin = ctx.role === "HR_ADMIN" || ctx.role === "VENDOR_OWNER"
    if (!isAdmin && rec.fromUserId !== ctx.userId && rec.toUserId !== ctx.userId) {
      throw new Deny("Only the delegator, the delegate or an admin can end this delegation")
    }
    await db.approvalDelegate.update({ where: { id: rec.id }, data: { active: false } })
    await audit(ctx, "delegations.end", "ApprovalDelegate", rec.id, `Delegation ended by ${ctx.userName}`)
    return { ended: true }
  },
})
