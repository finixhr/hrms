// ============ Wave 2 WP-E — Accounting module (tenant-side) routes ============
// Manual journal vouchers, chart of accounts browser, per-account ledger,
// trial balance and a payroll-centric statement — every report computed from
// AccountJournal.linesJson server-side (the browser never aggregates money).
//
// Conventions:
//  - H-10 tenant isolation: every query is scoped by ctx.vendorId; a
//    cross-tenant journal id is a plain 404.
//  - H-9 money invariant: every manual voucher passes validateAndBalanceLines()
//    (imported from ../accounting) — debit and credit totals must balance to
//    the PAISA (integer comparison) or the post is refused with a Deny. The
//    same gate re-runs on reversal vouchers. postJournal() itself validates
//    again on its copy, so nothing reaches the DB unbalanced.
//  - Money history is append-only: voiding a manual voucher posts a REVERSAL
//    voucher with flipped lines (idempotency key JV-REVERSAL:{id} — a second
//    void is a no-op answer, never a second reversal). Rows are never deleted
//    or mutated.
//  - SOURCE NOTE: postJournal() hardcodes source "HRM" and is frozen this
//    wave. Manual vouchers (and their reversals) carry source "MANUAL", so
//    voucher.post performs the SAME insert postJournal would — validate →
//    balance on a copy → create with idempotency key — with source "MANUAL".
//    Nothing bypasses H-9; the create semantics are identical.
//  - Reads are not audited; voucher.post and journal.delete (void) are.
//  - WAVE 4 "Accounting Depth": accounting periods (soft lock — CLOSED
//    ranges refuse new manual-voucher writes via assertPeriodOpen; auto
//    journals skip the check), cost centers (optional tag on manual
//    vouchers), a direct-method cash flow statement and budgets with
//    variance. Every new aggregation stays paisa-int and H-10-scoped.
import { db } from "@/lib/db"
import { Prisma } from "@prisma/client"
import { z } from "zod"
import { route } from "./registry"
import { Deny } from "../rbac"
import { audit } from "../audit"
import { getSettings } from "../settings"
import { j, today } from "../utils"
import { webhookEmit } from "../webhooks"
import { flag, isoDate, textOpt } from "../validation"
import { resolveEntitlements } from "../saas/entitlements"
import {
  ACCOUNTS, JOURNAL_ROLE_KEYS, DEFAULT_ACCOUNT_MAPPING,
  validateAndBalanceLines, resolveAccountMapping, autoPostPayrollJournal,
  type JournalLine,
} from "../accounting"

// ---------- chart sections (prefix-derived, matches accounting-chart.ts) ----------
const groupOf = (code: string) =>
  code.startsWith("1") ? "ASSETS" : code.startsWith("2") ? "LIABILITIES" : "EXPENSES"
const normalSideOf = (code: string) =>
  groupOf(code) === "LIABILITIES" ? "credit" : "debit"

const ROLE_LABELS: Record<string, string> = {
  salaryExpense: "Salary & Wages Expense", otExpense: "Overtime Expense", bonusExpense: "Bonus & Commission Expense",
  pfEmployerExpense: "PF Employer Expense", aitPayable: "AIT Payable", pfPayable: "Provident Fund Payable",
  salariesPayable: "Salaries Payable", loanReceivable: "Employee Loan Receivable", advances: "Employee Advances",
  deductionsRecovered: "Salary Deductions Recovered", bank: "Bank Accounts (payout)", cash: "Cash on Hand (payout)",
  mfs: "MFS Wallets (payout)",
}

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100

/** L-28 discipline — every full-history sweep is bounded. Journals are
 *  structurally few (payroll runs + loans + expenses + manual vouchers), but
 *  a runaway tenant must never pull an unbounded table into memory. */
const JOURNAL_SWEEP_CEILING = 20_000

/** Shared date-range sanity for the report actions. */
function assertRange(from?: string | null, to?: string | null) {
  if (from && to && from > to) {
    throw new Deny(`Invalid date range — "from" (${from}) is after "to" (${to})`, 400)
  }
}

/** Parse a journal's lines defensively (corrupt JSON → empty, never a crash). */
function linesOf(jr: { linesJson: string }): JournalLine[] {
  return j<JournalLine[]>(jr.linesJson, [])
}

/** Fresh idempotency key for a manual voucher insert (single-shot marker —
 *  the key exists for traceability + the unique constraint, not dedup). */
function newVoucherKey(): string {
  return `JV:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

/** SaaS read-only lockout, enforced IN-HANDLER for this module's money posts.
 *  The dispatcher's MUTATING_VERBS list (frozen this wave) does not include
 *  the verb "post", so accounting.voucher.post would slip past the generic
 *  EXPIRED/SUSPENDED lockout — a money mutation must never be writable while
 *  a subscription is locked. (accounting.journal.delete IS caught there via
 *  "delete"; this guard is the belt-and-braces for the posting path.) */
async function assertNotReadonly(vendorId: string) {
  const ent = await resolveEntitlements(vendorId)
  if (ent.readonly) {
    throw new Deny(
      `Your subscription is ${ent.status === "SUSPENDED" ? "suspended" : "expired"}${ent.planName ? ` (${ent.planName})` : ""}. The workspace is read-only until it is renewed — journal postings are blocked.`,
      403,
    )
  }
}

// ================= WAVE 4 — ACCOUNTING DEPTH (local helpers) =================
// House rule: shared modules are frozen — the FormDialog-tolerant primitives
// validation.ts keeps module-private are re-declared locally (same shape).

/** ""/blank string → null (untouched FormDialog selects arrive as ""). */
const blankToNull = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), schema)
/** Optional id: blank → null (selects), otherwise a bounded string. */
const idBlankOpt = blankToNull(z.string().min(1).max(64).nullish())

// ---------- ACC-01 (R6) — SQL-side statement aggregation ---------------------
// Journal lines live in linesJson; every statement used to haul up to 20,001
// journal rows into the app and aggregate in memory, failing PERMANENTLY past
// the ceiling. The projections below push the line math into Postgres:
// jsonb_to_recordset expands the lines, ROUND(x * 100) reproduces the exact
// per-line paisa rounding the app-side Math.round did (journal lines carry
// positive money figures), and the GROUP BY does the summing. The 20,000-row
// cliff is gone — the statements work at any history size.

/** Per-account paisa aggregation over POSTED journals (optional date window).
 *  Returns a Map<account, { debitP, creditP }> of INTEGER paisa. */
async function journalAccountAggSQL(
  vendorId: string,
  opts: { from?: string | null; to?: string | null } = {},
): Promise<Map<string, { debitP: number; creditP: number }>> {
  const rows = await db.$queryRaw<Array<{ account: string; debitP: bigint; creditP: bigint }>>`
    SELECT l."account" AS account,
           SUM(ROUND(COALESCE(l."debit", 0)::numeric * 100))::bigint AS "debitP",
           SUM(ROUND(COALESCE(l."credit", 0)::numeric * 100))::bigint AS "creditP"
    FROM "AccountJournal" j,
         jsonb_to_recordset(j."linesJson"::jsonb) AS l("account" text, "accountName" text, "debit" numeric, "credit" numeric)
    WHERE j."vendorId" = ${vendorId}
      AND j."status" = 'POSTED'
      ${opts.from != null ? Prisma.sql`AND j."date" >= ${opts.from}` : Prisma.empty}
      ${opts.to != null ? Prisma.sql`AND j."date" <= ${opts.to}` : Prisma.empty}
    GROUP BY l."account"`
  const out = new Map<string, { debitP: number; creditP: number }>()
  for (const r of rows) out.set(r.account, { debitP: Number(r.debitP), creditP: Number(r.creditP) })
  return out
}

/** ACC-03 (R6) — the stats block as SQL aggregates (FILTER clauses), incl. the
 *  unbalanced-invariant monitor as a per-journal grouped subquery count. */
async function journalStatsSQL(vendorId: string): Promise<{
  total: number; thisMonth: number; thisMonthAmountP: number; manualVouchers: number
  pendingApproval: number; drafts: number; unbalanced: number; byRefType: Record<string, number>
}> {
  const monthStart = `${today().slice(0, 7)}-01`
  const [cards, byRefTypeRows, unbalancedRows] = await Promise.all([
    db.$queryRaw<Array<{ total: number; this_month: number; this_month_amount_p: bigint | null; manual_vouchers: number; pending_approval: number; drafts: number }>>`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE j."date" >= ${monthStart} AND j."status" = 'POSTED')::int AS this_month,
             SUM(ROUND(j."amount"::numeric * 100)) FILTER (WHERE j."date" >= ${monthStart} AND j."status" = 'POSTED')::bigint AS this_month_amount_p,
             COUNT(*) FILTER (WHERE j."refType" = 'JOURNAL_VOUCHER')::int AS manual_vouchers,
             COUNT(*) FILTER (WHERE j."refType" = 'JOURNAL_VOUCHER' AND j."status" = 'PENDING_APPROVAL')::int AS pending_approval,
             COUNT(*) FILTER (WHERE j."refType" = 'JOURNAL_VOUCHER' AND j."status" = 'DRAFT')::int AS drafts
      FROM "AccountJournal" j WHERE j."vendorId" = ${vendorId}`,
    db.$queryRaw<Array<{ refType: string; c: number }>>`
      SELECT "refType", COUNT(*)::int AS c FROM "AccountJournal" WHERE "vendorId" = ${vendorId} GROUP BY "refType"`,
    db.$queryRaw<Array<{ c: number }>>`
      SELECT COUNT(*)::int AS c FROM (
        SELECT SUM(ROUND(COALESCE(l."debit", 0)::numeric * 100)) AS d,
               SUM(ROUND(COALESCE(l."credit", 0)::numeric * 100)) AS c_per
        FROM "AccountJournal" j,
             jsonb_to_recordset(j."linesJson"::jsonb) AS l("account" text, "accountName" text, "debit" numeric, "credit" numeric)
        WHERE j."vendorId" = ${vendorId}
        GROUP BY j."id"
      ) t WHERE t.d <> t.c_per`,
  ])
  const byRefType: Record<string, number> = {}
  for (const r of byRefTypeRows) byRefType[r.refType] = Number(r.c)
  const card = cards[0]
  return {
    total: Number(card?.total ?? 0),
    thisMonth: Number(card?.this_month ?? 0),
    thisMonthAmountP: Number(card?.this_month_amount_p ?? 0),
    manualVouchers: Number(card?.manual_vouchers ?? 0),
    pendingApproval: Number(card?.pending_approval ?? 0),
    drafts: Number(card?.drafts ?? 0),
    unbalanced: Number(unbalancedRows[0]?.c ?? 0),
    byRefType,
  }
}

/** ACC-01 (R6) — cash-flow machinery, SQL-side. Q1: per-journal cash paisa for
 *  every cash-touching journal (date <= to); the app splits opening (< from)
 *  from net (>= from) and counts touched. Q2: counterpart movement per account
 *  over the in-range cash-touching journals only. */
async function cashFlowSQL(
  vendorId: string,
  from: string,
  to: string,
): Promise<{ openingP: number; netP: number; touched: number; flows: Map<string, number> }> {
  const [cashRows, counterpartRows] = await Promise.all([
    db.$queryRaw<Array<{ id: string; date: string; cash_p: bigint }>>`
      SELECT j."id" AS id, j."date" AS date,
             (SUM(ROUND(COALESCE(l."debit", 0)::numeric * 100)) - SUM(ROUND(COALESCE(l."credit", 0)::numeric * 100)))::bigint AS cash_p
      FROM "AccountJournal" j,
           jsonb_to_recordset(j."linesJson"::jsonb) AS l("account" text, "accountName" text, "debit" numeric, "credit" numeric)
      WHERE j."vendorId" = ${vendorId}
        AND j."status" = 'POSTED'
        AND j."date" <= ${to}
        AND l."account" IN ('1010', '1200', '1210')
      GROUP BY j."id", j."date"`,
    db.$queryRaw<Array<{ account: string; effect_p: bigint }>>`
      SELECT l."account" AS account,
             (SUM(ROUND(COALESCE(l."credit", 0)::numeric * 100)) - SUM(ROUND(COALESCE(l."debit", 0)::numeric * 100)))::bigint AS effect_p
      FROM "AccountJournal" j,
           jsonb_to_recordset(j."linesJson"::jsonb) AS l("account" text, "accountName" text, "debit" numeric, "credit" numeric)
      WHERE j."vendorId" = ${vendorId}
        AND j."status" = 'POSTED'
        AND j."date" >= ${from}
        AND j."date" <= ${to}
        AND l."account" NOT IN ('1010', '1200', '1210')
        AND j."id" IN (
          SELECT j2."id" FROM "AccountJournal" j2,
               jsonb_to_recordset(j2."linesJson"::jsonb) AS c("account" text, "accountName" text, "debit" numeric, "credit" numeric)
          WHERE j2."vendorId" = ${vendorId}
            AND j2."status" = 'POSTED'
            AND j2."date" >= ${from}
            AND j2."date" <= ${to}
            AND c."account" IN ('1010', '1200', '1210')
        )
      GROUP BY l."account"`,
  ])
  let openingP = 0
  let netP = 0
  let touched = 0
  for (const r of cashRows) {
    const cashP = Number(r.cash_p)
    if (r.date < from) { openingP += cashP; continue }
    netP += cashP
    touched++
  }
  const flows = new Map<string, number>()
  for (const r of counterpartRows) flows.set(r.account, Number(r.effect_p))
  return { openingP, netP, touched, flows }
}

/** Period soft-lock (Wave 4): manual voucher writes are refused inside any
 *  CLOSED accounting period (startDate ≤ date ≤ endDate). Auto-generated
 *  journals (payroll, payouts, loans, expenses, settlements) skip this gate —
 *  they are system postings. This NEVER relaxes the H-9 balance gate; it only
 *  refuses the write earlier, with a reopen-or-redate instruction. */
async function assertPeriodOpen(vendorId: string, date: string) {
  const closed = await db.accountingPeriod.findFirst({
    where: { vendorId, status: "CLOSED", startDate: { lte: date }, endDate: { gte: date } },
    select: { name: true },
  })
  if (closed) {
    throw new Deny(`Date falls in closed period ${closed.name}. Reopen the period or use a different date.`, 400)
  }
}

/** Resolve + vendor-scope an optional cost-center tag for a manual voucher
 *  (H-10: a foreign-tenant id reads as plain "unknown", never a leak). */
async function resolveCostCenterId(vendorId: string, costCenterId?: string | null): Promise<string | null> {
  if (!costCenterId) return null
  const cc = await db.costCenter.findFirst({ where: { id: costCenterId, vendorId }, select: { id: true } })
  if (!cc) throw new Deny("Unknown cost center — pick one from your workspace’s cost center list.", 400)
  return cc.id
}

// ================= CHART OF ACCOUNTS =================
route("accounting.coa", {
  perm: ["accounting", "view"],
  schema: z.object({}).strict(),
  handler: async (ctx) => {
    const settings = await getSettings(ctx.vendorId)
    const mapping = resolveAccountMapping(settings)
    const roles = JOURNAL_ROLE_KEYS.map((role) => ({
      role,
      label: ROLE_LABELS[role] || role,
      account: mapping[role],
      isDefault: mapping[role] === DEFAULT_ACCOUNT_MAPPING[role],
    }))
    const accounts = Object.entries(ACCOUNTS).map(([code, name]) => ({
      code,
      name,
      group: groupOf(code),
      normalSide: normalSideOf(code),
      roles: roles.filter((r) => r.account === code),
    }))
    return { accounts, roles, autoPost: autoPostPayrollJournal(settings) }
  },
})

// ================= MANUAL VOUCHER ENTRY =================
const voucherLineSchema = z.object({
  account: z.string().refine((a) => !!ACCOUNTS[a], {
    message: "Unknown account code — pick one from the chart of accounts",
  }),
  debit: z.number().finite().min(0).nullish(),
  credit: z.number().finite().min(0).nullish(),
}).strict()

// ================= WAVE 3 WP-B — VOUCHER APPROVAL WORKFLOW =================
// Manual vouchers can travel DRAFT → PENDING_APPROVAL → POSTED/REJECTED.
// Auto-generated journals (payroll, payouts, loans, expenses, settlements)
// keep their auto-POSTED semantics — nothing below touches them. Only DRAFT
// rows are editable; POSTED history stays immutable (corrections are
// reversal vouchers, exactly as before); REJECTED rows keep their lines for
// the audit trail. Every transition is audited and re-runs the H-9 gate.
const VOUCHER_STATUSES = ["DRAFT", "PENDING_APPROVAL", "POSTED", "REJECTED"] as const

/** Vendor-scoped voucher fetch with workflow-state assertions (H-10: a
 *  cross-tenant id is a plain 404, same as every other read here). */
async function loadVoucher(ctx: any, id: string, want: readonly string[]) {
  const journal = await db.accountJournal.findFirst({ where: { id, vendorId: ctx.vendorId } })
  if (!journal) throw new Deny("Voucher not found for your workspace.", 404)
  if (journal.refType !== "JOURNAL_VOUCHER") {
    throw new Deny("Only manual journal vouchers follow the approval workflow — system journals are auto-POSTED.", 400)
  }
  if (!want.includes(journal.status)) {
    throw new Deny(`This voucher is ${journal.status.replace("_", " ")} — only ${want.join(" / ").replace(/_/g, " ")} vouchers accept this action.`, 400)
  }
  return journal
}

route("accounting.voucher.save", {
  perm: ["accounting", "create"],
  schema: z.object({
    id: z.string().trim().min(1).max(64).nullish(), // present = update an existing DRAFT
    date: isoDate,
    memo: z.string().min(3).max(500),
    note: textOpt(500),
    // Wave 4 — optional cost-center tag (validated against the vendor's list)
    costCenterId: idBlankOpt,
    lines: z.array(voucherLineSchema).min(2).max(30),
  }).strict(),
  handler: async (ctx, p) => {
    await assertNotReadonly(ctx.vendorId)
    // Wave 4 — period soft-lock: ONE check covers BOTH paths below (create and
    // update) because both persist p.date, and this route is manual-vouchers-
    // only (refType is the fixed literal JOURNAL_VOUCHER).
    await assertPeriodOpen(ctx.vendorId, p.date)
    const costCenterId = await resolveCostCenterId(ctx.vendorId, p.costCenterId)
    // H-9 — validate + balance on a COPY before anything is persisted; a
    // DRAFT is never stored unbalanced either (the gate is unconditional).
    const lines: JournalLine[] = p.lines.map((l: { account: string; debit?: number | null; credit?: number | null }) => ({
      account: l.account,
      accountName: ACCOUNTS[l.account] || l.account,
      ...(l.debit != null ? { debit: l.debit } : {}),
      ...(l.credit != null ? { credit: l.credit } : {}),
    }))
    const balanced = validateAndBalanceLines(lines)
    const amount = balanced.reduce((s, l) => s + (Number(l.debit) || 0), 0)
    const memo = p.note ? `${p.memo} — ${p.note}` : p.memo

    if (p.id) {
      const existing = await loadVoucher(ctx, p.id, ["DRAFT"])
      const journal = await db.accountJournal.update({
        where: { id: existing.id },
        data: { date: p.date, memo, linesJson: JSON.stringify(balanced), amount, costCenterId },
      })
      await audit(ctx, "accounting.voucher.save", "AccountJournal", journal.id,
        `Draft voucher updated — ${balanced.length} lines, ৳${amount.toFixed(2)} — ${memo.slice(0, 200)}`)
      return { journalId: journal.id, amount, lines: balanced.length, status: journal.status }
    }

    const journal = await db.accountJournal.create({
      data: {
        vendorId: ctx.vendorId,
        refType: "JOURNAL_VOUCHER",
        refId: null,
        idempotencyKey: newVoucherKey(),
        date: p.date,
        memo,
        linesJson: JSON.stringify(balanced),
        amount,
        source: "MANUAL",
        status: "DRAFT",
        costCenterId,
      },
    })
    await audit(ctx, "accounting.voucher.save", "AccountJournal", journal.id,
      `Draft voucher saved — ${balanced.length} lines, ৳${amount.toFixed(2)} — ${memo.slice(0, 200)}`)
    return { journalId: journal.id, amount, lines: balanced.length, status: "DRAFT" }
  },
})

route("accounting.voucher.submit", {
  perm: ["accounting", "create"],
  schema: z.object({ id: z.string().min(1) }).strict(),
  handler: async (ctx, p) => {
    await assertNotReadonly(ctx.vendorId)
    const journal = await loadVoucher(ctx, p.id, ["DRAFT"])
    // Wave 4 — a closed period locks its pending queue too: submitting moves
    // the voucher toward the ledger, so its date must sit in an OPEN period.
    await assertPeriodOpen(ctx.vendorId, journal.date)
    // H-9 re-check on the STORED lines (corrupt JSON or a raced edit can't
    // smuggle an unbalanced voucher into the approval queue).
    validateAndBalanceLines(linesOf(journal))
    const updated = await db.accountJournal.update({
      where: { id: journal.id },
      data: { status: "PENDING_APPROVAL" },
    })
    await audit(ctx, "accounting.voucher.submit", "AccountJournal", journal.id,
      `Voucher submitted for approval — ৳${journal.amount.toFixed(2)} — ${journal.memo.slice(0, 200)}`)
    return { journalId: updated.id, status: updated.status }
  },
})

route("accounting.voucher.approve", {
  perm: ["accounting", "approve"],
  schema: z.object({
    id: z.string().min(1),
    note: textOpt(500),
  }).strict(),
  handler: async (ctx, p) => {
    await assertNotReadonly(ctx.vendorId)
    const journal = await loadVoucher(ctx, p.id, ["PENDING_APPROVAL"])
    // Wave 4 — approving POSTS the voucher into the ledger: its date must not
    // fall inside a CLOSED period (auto journals never reach this handler —
    // loadVoucher refuses every non-JOURNAL_VOUCHER refType).
    await assertPeriodOpen(ctx.vendorId, journal.date)
    // H-9 — the approve-time gate, exactly like voucher.post's post-time gate:
    // whatever is in linesJson must still balance to the paisa.
    const balanced = validateAndBalanceLines(linesOf(journal))
    const amount = balanced.reduce((s, l) => s + (Number(l.debit) || 0), 0)
    const updated = await db.accountJournal.update({
      where: { id: journal.id },
      data: {
        status: "POSTED",
        approvedById: ctx.userId,
        approvedByName: ctx.userName,
        approvedAt: new Date(),
        ...(p.note ? { memo: `${journal.memo} — approved: ${p.note}` } : {}),
      },
    })
    await audit(ctx, "accounting.voucher.approve", "AccountJournal", journal.id,
      `Voucher APPROVED and posted to the ledger — ${balanced.length} lines, ৳${amount.toFixed(2)} — by ${ctx.userName}${p.note ? ` (note: ${p.note.slice(0, 200)})` : ""}`)
    return { journalId: updated.id, status: updated.status, amount }
  },
})

route("accounting.voucher.reject", {
  perm: ["accounting", "approve"],
  schema: z.object({
    id: z.string().min(1),
    reason: z.string().trim().min(3).max(500),
  }).strict(),
  handler: async (ctx, p) => {
    await assertNotReadonly(ctx.vendorId)
    const journal = await loadVoucher(ctx, p.id, ["PENDING_APPROVAL"])
    const updated = await db.accountJournal.update({
      where: { id: journal.id },
      data: {
        status: "REJECTED",
        rejectionReason: p.reason,
        approvedById: ctx.userId,
        approvedByName: ctx.userName,
        approvedAt: new Date(),
      },
    })
    await audit(ctx, "accounting.voucher.reject", "AccountJournal", journal.id,
      `Voucher REJECTED — ৳${journal.amount.toFixed(2)} — by ${ctx.userName}. Reason: ${p.reason.slice(0, 200)}`)
    return { journalId: updated.id, status: updated.status }
  },
})

route("accounting.voucher.post", {
  perm: ["accounting", "create"],
  schema: z.object({
    date: isoDate,
    memo: z.string().min(3).max(500),
    // refType is accepted for forward-compat but a manual voucher is ALWAYS
    // stored as JOURNAL_VOUCHER (the only literal the schema admits).
    refType: z.literal("JOURNAL_VOUCHER").optional(),
    note: textOpt(500),
    // Wave 4 — optional cost-center tag (validated against the vendor's list)
    costCenterId: idBlankOpt,
    lines: z.array(voucherLineSchema).min(2).max(30),
  }).strict(),
  handler: async (ctx, p) => {
    await assertNotReadonly(ctx.vendorId)
    // Wave 4 — period soft-lock on the classic direct-post path (manual only).
    await assertPeriodOpen(ctx.vendorId, p.date)
    const costCenterId = await resolveCostCenterId(ctx.vendorId, p.costCenterId)
    const lines: JournalLine[] = p.lines.map((l: { account: string; debit?: number | null; credit?: number | null }) => ({
      account: l.account,
      accountName: ACCOUNTS[l.account] || l.account,
      ...(l.debit != null ? { debit: l.debit } : {}),
      ...(l.credit != null ? { credit: l.credit } : {}),
    }))
    // H-9 — THE money invariant: debit = credit to the paisa or Deny.
    // validateAndBalanceLines works on a COPY (caller lines are never mutated)
    // and normalizes each amount to 2dp before the integer comparison.
    const balanced = validateAndBalanceLines(lines)
    const amount = balanced.reduce((s, l) => s + (Number(l.debit) || 0), 0)
    const memo = p.note ? `${p.memo} — ${p.note}` : p.memo
    // Same create semantics postJournal uses, with source "MANUAL" (see header).
    const journal = await db.accountJournal.create({
      data: {
        vendorId: ctx.vendorId,
        refType: "JOURNAL_VOUCHER",
        refId: null,
        idempotencyKey: newVoucherKey(),
        date: p.date,
        memo,
        linesJson: JSON.stringify(balanced),
        amount,
        source: "MANUAL",
        costCenterId,
      },
    })
    await audit(ctx, "accounting.voucher.post", "AccountJournal", journal.id,
      `Manual journal voucher posted — ${balanced.length} lines, ৳${amount.toFixed(2)} — ${memo.slice(0, 200)}`)
    // Wave 4 WP-C — outbound webhook (fire-and-forget, delivery-log-backed)
    void webhookEmit(ctx.vendorId, "voucher.posted", {
      id: journal.id, date: journal.date, amount, memo: memo.slice(0, 200), lines: balanced.length,
    })
    return { journalId: journal.id, amount, lines: balanced.length }
  },
})

// ================= VOUCHERS / JOURNALS LIST =================
// Thin wrapper over the SAME query pattern reports.ts journals.list uses
// (re-queried here — the other route's handler is NOT imported), for ALL
// refTypes incl. JOURNAL_VOUCHER. The Accounting view and the Payroll →
// Journals tab therefore always show identical rows.
route("accounting.vouchers.list", {
  perm: ["accounting", "view"],
  schema: z.object({
    refType: textOpt(50),
    status: z.enum(VOUCHER_STATUSES).nullish(), // Wave 3 WP-B — workflow filter; absent = ALL statuses
    // Wave 4 — optional cost-center filter (manual vouchers carry the tag)
    costCenterId: z.string().trim().min(1).max(64).nullish(),
    from: isoDate.nullish(),
    to: isoDate.nullish(),
    limit: z.number().int().min(1).max(300).nullish(),
    offset: z.number().int().min(0).nullish(),
  }).strict(),
  handler: async (ctx, p) => {
    const where: any = { vendorId: ctx.vendorId }
    if (p?.refType) where.refType = p.refType
    if (p?.status) where.status = p.status
    if (p?.costCenterId) where.costCenterId = p.costCenterId
    if (p?.from || p?.to) {
      where.date = {}
      if (p?.from) where.date.gte = p.from
      if (p?.to) where.date.lte = p.to
    }
    const take = Math.min(Number(p?.limit) || 100, 300)
    const [list, total, refTypes, statusCounts] = await Promise.all([
      db.accountJournal.findMany({
        where, orderBy: [{ date: "desc" }, { createdAt: "desc" }],
        take, skip: Number(p?.offset) || 0,
      }),
      db.accountJournal.count({ where }),
      db.accountJournal.findMany({ where: { vendorId: ctx.vendorId }, select: { refType: true }, distinct: ["refType"] }),
      db.accountJournal.groupBy({ by: ["status"], where: { vendorId: ctx.vendorId }, _count: { _all: true } }),
    ])
    return {
      journals: list.map((jr) => ({ ...jr, lines: linesOf(jr) })),
      total,
      refTypes: refTypes.map((r) => r.refType).sort(),
      // Wave 3 WP-B — per-status counts for the queue chips (all statuses, no
      // refType/date filter: the badges describe the whole workflow, not the
      // current view — matches how queues behave in ERP systems).
      statusCounts: Object.fromEntries(statusCounts.map((r) => [r.status, r._count._all])),
    }
  },
})

// ================= ACCOUNT LEDGER =================
// Chronological line-level ledger for ONE account: every journal line hitting
// it, running balance, opening balance (all lines strictly before `from`) and
// closing. Balances are debit-positive signed numbers.
route("accounting.ledger", {
  perm: ["accounting", "view"],
  schema: z.object({
    account: z.string().refine((a) => !!ACCOUNTS[a], { message: "Unknown account code — pick one from the chart of accounts" }),
    from: isoDate.nullish(),
    to: isoDate.nullish(),
  }).strict(),
  handler: async (ctx, p) => {
    assertRange(p.from, p.to)
    // Opening balance needs everything BEFORE `from`, so the sweep reads the
    // full history up to `to` (bounded by JOURNAL_SWEEP_CEILING, L-28).
    // Wave 3 WP-B — only POSTED journals hit the ledger: drafts and pending
    // approvals are not money yet (existing rows are POSTED by default, so
    // pre-wave-3 behavior is unchanged).
    const where: any = { vendorId: ctx.vendorId, status: "POSTED" }
    if (p.to) where.date = { lte: p.to }
    const journals = await db.accountJournal.findMany({
      where,
      orderBy: [{ date: "asc" }, { createdAt: "asc" }],
      select: { id: true, date: true, refType: true, memo: true, linesJson: true },
      take: JOURNAL_SWEEP_CEILING + 1,
    })
    if (journals.length > JOURNAL_SWEEP_CEILING) {
      throw new Deny(`This tenant has more than ${JOURNAL_SWEEP_CEILING} journals — narrow the ledger "to" date and export per year.`, 400)
    }
    let openingP = 0 // paisa
    let runP = 0 // paisa — running balance accumulator (H-9-style integer math)
    const lines: { journalId: string; date: string; refType: string; memo: string; debit: number; credit: number; balance: number }[] = []
    for (const jr of journals) {
      for (const l of linesOf(jr)) {
        if (l.account !== p.account) continue
        const d = Math.round((Number(l.debit) || 0) * 100)
        const c = Math.round((Number(l.credit) || 0) * 100)
        runP += d - c
        if (p.from && jr.date < p.from) { openingP = runP; continue }
        lines.push({
          journalId: jr.id, date: jr.date, refType: jr.refType, memo: jr.memo,
          debit: d / 100, credit: c / 100, balance: runP / 100,
        })
      }
    }
    return {
      account: p.account,
      accountName: ACCOUNTS[p.account],
      normalSide: normalSideOf(p.account),
      opening: openingP / 100,
      lines,
      closing: runP / 100,
      count: lines.length,
    }
  },
})

// ================= TRIAL BALANCE =================
route("accounting.trialBalance", {
  perm: ["accounting", "view"],
  schema: z.object({
    from: isoDate.nullish(),
    to: isoDate.nullish(),
  }).strict(),
  handler: async (ctx, p) => {
    assertRange(p.from, p.to)
    // ACC-01 (R6) — SQL-side line projection (the in-memory sweep and its
    // 20,000-journal cliff are gone; every figure below is paisa-exact and
    // identical to the app-side math it replaced).
    const where: any = { vendorId: ctx.vendorId, status: "POSTED" }
    if (p.from || p.to) {
      where.date = {}
      if (p.from) where.date.gte = p.from
      if (p.to) where.date.lte = p.to
    }
    const [agg, journalCount] = await Promise.all([
      journalAccountAggSQL(ctx.vendorId, { from: p.from ?? null, to: p.to ?? null }),
      db.accountJournal.count({ where }),
    ])
    let gDr = 0
    let gCr = 0
    for (const a of agg.values()) { gDr += a.debitP; gCr += a.creditP }
    const rows = [...agg.entries()]
      .sort((x, y) => x[0].localeCompare(y[0]))
      .map(([code, a]) => ({
        code,
        name: ACCOUNTS[code] || code,
        totalDebit: a.debitP / 100,
        totalCredit: a.creditP / 100,
        balanceDr: Math.max(0, a.debitP - a.creditP) / 100,
        balanceCr: Math.max(0, a.creditP - a.debitP) / 100,
      }))
    let balanceDrSum = 0
    let balanceCrSum = 0
    for (const r of rows) { balanceDrSum += Math.round(r.balanceDr * 100); balanceCrSum += Math.round(r.balanceCr * 100) }
    const totals = {
      debit: gDr / 100,
      credit: gCr / 100,
      balanceDr: balanceDrSum / 100,
      balanceCr: balanceCrSum / 100,
    }
    // Balanced by construction (every journal passed H-9 at post time) — if
    // this ever breaks, say so LOUDLY instead of showing a quietly wrong sheet.
    const balanced = gDr === gCr
    return {
      from: p.from || null,
      to: p.to || null,
      journalCount,
      rows,
      totals,
      balanced,
      warning: balanced ? null
        : `Grand debit (৳${(gDr / 100).toFixed(2)}) does not equal grand credit (৳${(gCr / 100).toFixed(2)}) — the H-9 invariant is violated. Contact support immediately.`,
    }
  },
})

// ================= INCOME STATEMENT (payroll-centric) =================
// The HRM chart has NO revenue accounts, so this is honestly labelled a
// "Payroll-Centric Statement": net expenses recognized (5xxx/6xxx, where
// 5290 recoveries are contra-expense credits), the payables section
// (accrued vs settled), asset movements, and a double-entry check that must
// be zero.
const EXPENSE_CODES = ["5100", "5110", "5120", "5150", "5290", "5300", "6100"]
const LIABILITY_CODES = ["2100", "2105", "2150"]
const ASSET_CODES = ["1010", "1150", "1155", "1200", "1210"]

route("accounting.incomeStatement", {
  perm: ["accounting", "view"],
  schema: z.object({
    from: isoDate.nullish(),
    to: isoDate.nullish(),
  }).strict(),
  handler: async (ctx, p) => {
    assertRange(p.from, p.to)
    // Wave 3 WP-B — POSTED journals only (see the ledger note above).
    const where: any = { vendorId: ctx.vendorId, status: "POSTED" }
    if (p.from || p.to) {
      where.date = {}
      if (p.from) where.date.gte = p.from
      if (p.to) where.date.lte = p.to
    }
    const journals = await db.accountJournal.findMany({
      where, select: { linesJson: true }, take: JOURNAL_SWEEP_CEILING + 1,
    })
    if (journals.length > JOURNAL_SWEEP_CEILING) {
      throw new Deny(`This tenant has more than ${JOURNAL_SWEEP_CEILING} journals — narrow the date range.`, 400)
    }
    // paisa-int aggregation per account
    const agg = new Map<string, { debit: number; credit: number }>()
    for (const jr of journals) {
      for (const l of linesOf(jr)) {
        const a = agg.get(l.account) || { debit: 0, credit: 0 }
        a.debit += Math.round((Number(l.debit) || 0) * 100)
        a.credit += Math.round((Number(l.credit) || 0) * 100)
        agg.set(l.account, a)
      }
    }
    const get = (code: string) => agg.get(code) || { debit: 0, credit: 0 }
    const section = (codes: string[]) => codes
      .filter((c) => { const a = get(c); return a.debit !== 0 || a.credit !== 0 })
      .map((c) => {
        const a = get(c)
        return {
          code: c, name: ACCOUNTS[c] || c,
          debit: a.debit / 100, credit: a.credit / 100,
          net: (a.debit - a.credit) / 100, // debit-positive convention
        }
      })
    const sumP = (codes: string[], pick: "debit" | "credit" | "net") =>
      codes.reduce((s, c) => {
        const a = get(c)
        const v = pick === "net" ? a.debit - a.credit : a[pick]
        return s + v
      }, 0) / 100

    const expenses = section(EXPENSE_CODES)
    const totalExpenses = sumP(EXPENSE_CODES, "net") // Dr − Cr (5290 credits reduce it)
    const recoveredSettled = section(LIABILITY_CODES).map((r) => ({
      ...r,
      net: -r.net, // liability Δ is credit-positive (Cr − Dr)
    }))
    const recoveredTotals = {
      accrued: sumP(LIABILITY_CODES, "credit"),
      settled: sumP(LIABILITY_CODES, "debit"),
    }
    const netLiabilities = round2(recoveredTotals.accrued - recoveredTotals.settled)
    const assetMovements = section(ASSET_CODES)
    const assetTotals = {
      debit: sumP(ASSET_CODES, "debit"),
      credit: sumP(ASSET_CODES, "credit"),
      net: sumP(ASSET_CODES, "net"),
    }
    // Double-entry identity over this chart: Σ(Dr−Cr) over ALL accounts = 0
    // → assets Δ − payables Δ + expenses = 0. Surfaced as a verification line.
    const check = round2(assetTotals.net - netLiabilities + totalExpenses)
    return {
      title: "Payroll-Centric Statement",
      scopeNote: "the Finix HR chart is HRM-scoped (payroll assets, payables and expenses — no revenue accounts), so this is NOT a full income statement. Expenses are shown net of recovered deductions (5290); the Recovered / Settled section tracks payable accruals vs settlements; Asset movements show where the money went.",
      from: p.from || null,
      to: p.to || null,
      journalCount: journals.length,
      expenses,
      totalExpenses: round2(totalExpenses),
      recoveredSettled,
      recoveredTotals,
      assetMovements,
      assetTotals,
      netMovement: {
        totalExpenses: round2(totalExpenses),
        netLiabilities,
        netAssets: round2(assetTotals.net),
        net: round2(totalExpenses - netLiabilities), // cost actually funded in the period
        check,
        balanced: check === 0,
      },
    }
  },
})

// ================= VOID A MANUAL VOUCHER (reversal, never a delete) =================
route("accounting.journal.delete", {
  perm: ["accounting", "delete"],
  schema: z.object({
    id: z.string().min(1),
    reason: z.string().min(3).max(500),
  }).strict(),
  handler: async (ctx, p) => {
    const journal = await db.accountJournal.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!journal) throw new Deny("Journal not found", 404)
    if (journal.refType !== "JOURNAL_VOUCHER") {
      throw new Deny("Only manual journal vouchers can be voided — payroll, payout, loan and expense journals are immutable system postings. Post a correcting manual voucher instead.", 400)
    }
    // Wave 3 WP-B — only POSTED vouchers are voided via reversal. A DRAFT or
    // PENDING_APPROVAL voucher was never money: edit the draft, or reject the
    // pending one. A REJECTED voucher needs no reversal at all.
    if (journal.status !== "POSTED") {
      throw new Deny(`This voucher is ${journal.status.replace("_", " ")} — only POSTED vouchers are voided via reversal. ${journal.status === "DRAFT" ? "Edit the draft and resubmit it instead." : journal.status === "PENDING_APPROVAL" ? "Reject it instead — a rejection leaves no ledger trace." : "Rejected vouchers never reached the ledger."}`, 400)
    }
    // Idempotent double-void guard: the reversal carries JV-REVERSAL:{id}, so a
    // second void returns the existing answer instead of posting again.
    const existing = await db.accountJournal.findFirst({
      where: { vendorId: ctx.vendorId, idempotencyKey: `JV-REVERSAL:${journal.id}` },
    })
    if (existing) {
      return { ok: true, alreadyVoided: true, reversalJournalId: existing.id }
    }
    const originalLines = linesOf(journal)
    // flip every side; zero-amount lines drop out naturally (same pattern as
    // payroll.runs.cancel's PAYROLL_REVERSAL)
    const flipped = originalLines
      .map((l) => ({ account: l.account, accountName: l.accountName, debit: l.credit, credit: l.debit }))
      .filter((l) => (Number(l.debit) || 0) > 0 || (Number(l.credit) || 0) > 0)
    if (!flipped.length) throw new Deny("This voucher has no lines to reverse — contact support", 400)
    // Wave 4 — the reversal is a manual voucher dated TODAY: it too must land
    // in an OPEN period (a closed month stays closed — reopen it to void).
    await assertPeriodOpen(ctx.vendorId, today())
    // H-9 — the reversal passes the SAME balancing gate (it balances by
    // symmetry, but the gate is unconditional: no code path skips it).
    const balanced = validateAndBalanceLines(flipped)
    const reversal = await db.accountJournal.create({
      data: {
        vendorId: ctx.vendorId,
        refType: "JOURNAL_VOUCHER",
        refId: journal.id, // traceability: reversal → the voucher it neutralizes
        idempotencyKey: `JV-REVERSAL:${journal.id}`,
        date: today(),
        memo: `REVERSAL — ${p.reason}`,
        linesJson: JSON.stringify(balanced),
        amount: journal.amount,
        source: "MANUAL",
        // Wave 4 — carry the original's cost-center tag so a void nets to zero
        // in cost-center reporting too.
        costCenterId: journal.costCenterId,
      },
    })
    await audit(ctx, "accounting.journal.delete", "AccountJournal", journal.id,
      `Voided manual voucher ${journal.id} (৳${journal.amount.toFixed(2)}, "${journal.memo.slice(0, 120)}") — reversal ${reversal.id} posted with flipped lines. Reason: ${p.reason}`,
      { reason: p.reason })
    return { ok: true, alreadyVoided: false, reversalJournalId: reversal.id }
  },
})

// ================= MODULE STATS (header cards) =================
route("accounting.stats", {
  perm: ["accounting", "view"],
  schema: z.object({}).strict(),
  handler: async (ctx) => {
    // ACC-03 (R6) — every card (including the "unbalanced" invariant monitor,
    // which must always be 0: H-9 is enforced at post time) computes SQL-side
    // via FILTER aggregates; the dashboard no longer sweeps the journal table.
    const st = await journalStatsSQL(ctx.vendorId)
    return {
      total: st.total,
      byRefType: st.byRefType,
      thisMonth: st.thisMonth,
      thisMonthAmount: st.thisMonthAmountP / 100,
      manualVouchers: st.manualVouchers,
      unbalanced: st.unbalanced,
      // Wave 3 WP-B — workflow queue counts for the header cards
      pendingApproval: st.pendingApproval,
      drafts: st.drafts,
    }
  },
})

// ================= WAVE 3 WP-F — BALANCE SHEET =================
// Statement of position as of a date: ASSETS / LIABILITIES / EQUITY over the
// vendor's chart of accounts (prefix-derived sections, matches the trial
// balance conventions). The Finix chart is HRM-scoped and carries no explicit
// equity/revenue accounts, so EQUITY is presented as Retained Earnings
// (revenues − expenses recognized up to the as-of date — with this chart,
// typically an accumulated deficit, honestly labelled). The accounting
// identity A = L + E is CHECKED and an unbalanced difference is surfaced as
// its own row — never hidden, never fudged.
route("accounting.balanceSheet", {
  perm: ["accounting", "view"],
  schema: z.object({ asOf: isoDate.nullish() }).strict(),
  handler: async (ctx, p) => {
    const asOf = p.asOf || today()
    // ACC-01 (R6) — SQL-side line projection over the full history up to the
    // as-of date (no row haul, no 20,000-journal cliff).
    const agg = await journalAccountAggSQL(ctx.vendorId, { to: asOf })
    // Prefix-derived classification over EVERY account the journals actually
    // touch (the chart is extensible — unknown codes still classify):
    //   1xxx ASSETS (debit-positive) · 2xxx LIABILITIES (credit-positive)
    //   3xxx EQUITY (credit-positive) · 4xxx REVENUE (credit-positive)
    //   anything else = EXPENSE (debit-positive, feeds Retained Earnings)
    const sectionOf = (code: string) =>
      code.startsWith("1") ? "ASSETS" : code.startsWith("2") ? "LIABILITIES" : code.startsWith("3") ? "EQUITY" : code.startsWith("4") ? "REVENUE" : "EXPENSES"
    const signedBalance = (code: string, a: { debitP: number; creditP: number }) => {
      const s = sectionOf(code)
      return s === "ASSETS" || s === "EXPENSES" ? a.debitP - a.creditP : a.creditP - a.debitP
    }
    const sections: Record<string, { code: string; name: string; amount: number }[]> = { ASSETS: [], LIABILITIES: [], EQUITY: [], REVENUE: [], EXPENSES: [] }
    for (const [code, a] of [...agg.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
      if (a.debitP === 0 && a.creditP === 0) continue
      sections[sectionOf(code)].push({ code, name: ACCOUNTS[code] || code, amount: signedBalance(code, a) / 100 })
    }
    const sumOf = (list: { amount: number }[]) => list.reduce((sP, r) => sP + Math.round(r.amount * 100), 0) / 100
    const totalAssets = sumOf(sections.ASSETS)
    const totalLiabilities = sumOf(sections.LIABILITIES)
    const totalRevenue = sumOf(sections.REVENUE)
    const totalExpenses = sumOf(sections.EXPENSES)
    // Retained Earnings = cumulative revenue − expenses up to the as-of date
    // (an accumulated deficit shows negative, as it should).
    const retainedEarnings = round2(totalRevenue - totalExpenses)
    const totalEquity = round2(sumOf(sections.EQUITY) + retainedEarnings)
    // A = L + E check — paisa-exact; a non-zero difference gets its own row.
    const diffP = Math.round(totalAssets * 100) - Math.round((totalLiabilities + totalEquity) * 100)
    const difference = diffP / 100
    return {
      asOf,
      journalCount: await db.accountJournal.count({ where: { vendorId: ctx.vendorId, status: "POSTED", date: { lte: asOf } } }),
      assets: sections.ASSETS,
      liabilities: sections.LIABILITIES,
      equity: sections.EQUITY,
      revenue: sections.REVENUE,
      expenses: sections.EXPENSES,
      retainedEarnings,
      totalAssets,
      totalLiabilities,
      totalEquity,
      difference,
      balanced: diffP === 0,
      scopeNote: "Position over the Finix HR chart of accounts (HRM-scoped: payroll assets, payables and expenses — no external capital accounts). Equity is presented as Retained Earnings (revenues minus expenses to date); a negative figure is an accumulated deficit, honestly labelled.",
    }
  },
})

// ================= WAVE 4 — ACCOUNTING PERIODS (soft lock) =================
// Named date ranges (FY2026-Q1, October 2026…). A CLOSED period refuses NEW
// manual-voucher writes inside its range (assertPeriodOpen above); money
// already posted stays untouched — closing is a lock, never an edit. Reopen is
// allowed and documented (audit PERIOD_REOPEN; the closedBy* fields keep the
// LAST closer so the trail survives close→reopen round-trips).
route("accounting.periods.list", {
  perm: ["accounting", "view"],
  schema: z.object({}).strict(),
  handler: async (ctx) => {
    const periods = await db.accountingPeriod.findMany({
      where: { vendorId: ctx.vendorId },
      orderBy: [{ startDate: "desc" }, { name: "asc" }],
    })
    // Per-period journal count (ALL statuses — it describes period activity,
    // not posted money; the count query is vendor-scoped like every read).
    const counts = await Promise.all(periods.map((p) =>
      db.accountJournal.count({ where: { vendorId: ctx.vendorId, date: { gte: p.startDate, lte: p.endDate } } }),
    ))
    return {
      periods: periods.map((p, i) => ({
        id: p.id,
        name: p.name,
        startDate: p.startDate,
        endDate: p.endDate,
        status: p.status,
        closedById: p.closedById,
        closedByName: p.closedByName,
        closedAt: p.closedAt,
        journalCount: counts[i],
      })),
    }
  },
})

route("accounting.periods.save", {
  perm: ["accounting", "edit"],
  schema: z.object({
    id: idBlankOpt, // present = update (OPEN periods only)
    name: z.string().trim().min(3).max(60),
    startDate: isoDate,
    endDate: isoDate,
  }).strict(),
  handler: async (ctx, p) => {
    if (p.startDate >= p.endDate) {
      throw new Deny(`Invalid period — start (${p.startDate}) must be before end (${p.endDate}).`, 400)
    }
    // name is unique per vendor (@@unique([vendorId, name])); a rename must
    // not collide with a DIFFERENT period's name.
    const clash = await db.accountingPeriod.findFirst({
      where: { vendorId: ctx.vendorId, name: p.name, ...(p.id ? { id: { not: p.id } } : {}) },
      select: { id: true },
    })
    if (clash) {
      throw new Deny(`A period named "${p.name}" already exists — period names are unique per workspace.`, 400)
    }
    if (p.id) {
      const existing = await db.accountingPeriod.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
      if (!existing) throw new Deny("Period not found for your workspace.", 404)
      if (existing.status === "CLOSED") {
        throw new Deny(`Period ${existing.name} is CLOSED — reopen it before editing its name or dates.`, 400)
      }
      const updated = await db.accountingPeriod.update({
        where: { id: existing.id },
        data: { name: p.name, startDate: p.startDate, endDate: p.endDate },
      })
      await audit(ctx, "PERIOD_SAVE", "AccountingPeriod", updated.id,
        `Period updated — ${p.name} (${p.startDate} → ${p.endDate})`,
        { oldValue: { name: existing.name, startDate: existing.startDate, endDate: existing.endDate }, newValue: { name: p.name, startDate: p.startDate, endDate: p.endDate } })
      return { periodId: updated.id }
    }
    const created = await db.accountingPeriod.create({
      data: { vendorId: ctx.vendorId, name: p.name, startDate: p.startDate, endDate: p.endDate },
    })
    await audit(ctx, "PERIOD_SAVE", "AccountingPeriod", created.id,
      `Period created — ${p.name} (${p.startDate} → ${p.endDate})`)
    return { periodId: created.id }
  },
})

route("accounting.periods.close", {
  // Deliberately the STRICTER gate: closing locks a date range for every
  // manual-voucher writer in the tenant, so it sits with the approvers.
  perm: ["accounting", "approve"],
  schema: z.object({ id: z.string().min(1), reason: textOpt(500) }).strict(),
  handler: async (ctx, p) => {
    // Dispatcher verb list has no "close" — the readonly lockout is enforced
    // in-hand here, same belt-and-braces as the money paths.
    await assertNotReadonly(ctx.vendorId)
    const period = await db.accountingPeriod.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!period) throw new Deny("Period not found for your workspace.", 404)
    if (period.status === "CLOSED") throw new Deny(`Period ${period.name} is already closed.`, 400)
    const updated = await db.accountingPeriod.update({
      where: { id: period.id },
      data: { status: "CLOSED", closedById: ctx.userId, closedByName: ctx.userName, closedAt: new Date() },
    })
    await audit(ctx, "PERIOD_CLOSE", "AccountingPeriod", updated.id,
      `Period CLOSED — ${period.name} (${period.startDate} → ${period.endDate}); manual voucher writes in the range are now refused.${p.reason ? ` Reason: ${p.reason.slice(0, 200)}` : ""}`,
      { reason: p.reason || undefined })
    return { periodId: updated.id, status: updated.status }
  },
})

route("accounting.periods.reopen", {
  perm: ["accounting", "approve"],
  schema: z.object({ id: z.string().min(1), reason: textOpt(500) }).strict(),
  handler: async (ctx, p) => {
    await assertNotReadonly(ctx.vendorId)
    const period = await db.accountingPeriod.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!period) throw new Deny("Period not found for your workspace.", 404)
    if (period.status !== "CLOSED") throw new Deny(`Period ${period.name} is already open.`, 400)
    const updated = await db.accountingPeriod.update({
      where: { id: period.id },
      data: { status: "OPEN" }, // closedBy* fields intentionally KEPT = last closer
    })
    await audit(ctx, "PERIOD_REOPEN", "AccountingPeriod", updated.id,
      `Period REOPENED — ${period.name} (${period.startDate} → ${period.endDate}); manual voucher writes are accepted again. Last closed by ${period.closedByName || "unknown"}.${p.reason ? ` Reason: ${p.reason.slice(0, 200)}` : ""}`,
      { reason: p.reason || undefined })
    return { periodId: updated.id, status: updated.status }
  },
})

// ================= WAVE 4 — COST CENTERS =================
// A flat vendor-defined list (code + name + active). Manual vouchers may carry
// ONE tag; budgets may be scoped by one. Deleting refuses while POSTED money
// references the center — ledger history must never orphan its tags.
route("accounting.costCenters.list", {
  perm: ["accounting", "view"],
  schema: z.object({}).strict(),
  handler: async (ctx) => {
    const costCenters = await db.costCenter.findMany({
      where: { vendorId: ctx.vendorId },
      orderBy: [{ code: "asc" }, { name: "asc" }],
    })
    return { costCenters }
  },
})

route("accounting.costCenters.save", {
  perm: ["accounting", "edit"],
  schema: z.object({
    id: idBlankOpt,
    code: z.string().trim().min(1).max(20),
    name: z.string().trim().min(1).max(120),
    active: flag,
  }).strict(),
  handler: async (ctx, p) => {
    // Upsert by code (unique per vendor): with an id, a code change must not
    // collide with a DIFFERENT center; without an id, an existing code UPDATES.
    // 2026-10-08 fix (CHANGES §9): the guard previously ran for the no-id case
    // too (`clash.id !== p.id` with p.id undefined is always true), which made
    // the documented upsert path unreachable — saving an existing code without
    // its id always threw "already in use" instead of updating. The clash probe
    // now ONLY looks for a collision with a DIFFERENT center (rename case).
    const clash = p.id
      ? await db.costCenter.findFirst({ where: { vendorId: ctx.vendorId, code: p.code, id: { not: p.id } }, select: { id: true } })
      : null
    if (clash) {
      throw new Deny(`Cost center code ${p.code} is already in use — codes are unique per workspace.`, 400)
    }
    const existing = p.id
      ? await db.costCenter.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
      : await db.costCenter.findFirst({ where: { vendorId: ctx.vendorId, code: p.code } })
    if (p.id && !existing) throw new Deny("Cost center not found for your workspace.", 404)
    if (existing) {
      const updated = await db.costCenter.update({
        where: { id: existing.id },
        data: { code: p.code, name: p.name, ...(p.active != null ? { active: p.active } : {}) },
      })
      await audit(ctx, "COST_CENTER_SAVE", "CostCenter", updated.id,
        `Cost center updated — ${p.code} ${p.name}${updated.active ? "" : " (inactive)"}`,
        { oldValue: { code: existing.code, name: existing.name, active: existing.active }, newValue: { code: p.code, name: p.name, active: updated.active } })
      return { costCenterId: updated.id }
    }
    const created = await db.costCenter.create({
      data: { vendorId: ctx.vendorId, code: p.code, name: p.name, ...(p.active != null ? { active: p.active } : {}) },
    })
    await audit(ctx, "COST_CENTER_SAVE", "CostCenter", created.id, `Cost center created — ${p.code} ${p.name}`)
    return { costCenterId: created.id }
  },
})

route("accounting.costCenters.delete", {
  perm: ["accounting", "edit"],
  schema: z.object({ id: z.string().min(1), reason: textOpt(500) }).strict(),
  handler: async (ctx, p) => {
    const cc = await db.costCenter.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!cc) throw new Deny("Cost center not found for your workspace.", 404)
    // Soft-refuse while POSTED money references the tag (count is POSTED-only:
    // drafts/pending vouchers can be re-tagged, posted history cannot).
    const postedRefs = await db.accountJournal.count({
      where: { vendorId: ctx.vendorId, costCenterId: cc.id, status: "POSTED" },
    })
    if (postedRefs > 0) {
      throw new Deny(
        `Cost center ${cc.code} — ${cc.name} is referenced by ${postedRefs} POSTED journal${postedRefs === 1 ? "" : "s"} — it cannot be deleted while posted money carries the tag. Deactivate it instead (new vouchers then stop offering it).`,
        400,
      )
    }
    // Untag the remaining non-POSTED vouchers so nothing references a deleted id.
    await db.accountJournal.updateMany({
      where: { vendorId: ctx.vendorId, costCenterId: cc.id, status: { not: "POSTED" } },
      data: { costCenterId: null },
    })
    await db.costCenter.delete({ where: { id: cc.id } })
    await audit(ctx, "COST_CENTER_DELETE", "CostCenter", cc.id,
      `Cost center deleted — ${cc.code} ${cc.name}. Reason: ${(p.reason || "not given").slice(0, 200)}`,
      { reason: p.reason || undefined })
    return { ok: true }
  },
})

// ================= WAVE 4 — CASH FLOW (direct method, pragmatic) =================
// "Cash" = 1010 Cash on Hand + 1200 Bank Accounts + 1210 MFS Wallets
// (debit-normal). For every POSTED journal in [from, to] that touches a cash
// account, the NON-cash lines are the flow counterpart: their (credit − debit)
// equals the journal's cash movement by double-entry. Counterpart lines are
// grouped by the counterpart account's GROUP: REVENUE → operating receipts,
// EXPENSES → operating payments, non-cash ASSETS → employee lending (net),
// LIABILITIES → financing (net); the chart carries no EQUITY accounts, and any
// empty section drops out. Opening = signed cash balance of POSTED journals
// dated BEFORE `from`. Internal cash↔cash transfers net to zero and leave no
// counterpart rows — exactly what a direct-method statement wants.
route("accounting.cashFlow", {
  perm: ["accounting", "view"],
  schema: z.object({ from: isoDate, to: isoDate }).strict(),
  handler: async (ctx, p) => {
    assertRange(p.from, p.to)
    // ACC-01 (R6) — the whole statement computes SQL-side (per-journal cash
    // paisa for cash-touching journals + grouped counterpart movement); no
    // row haul, no 20,000-journal cliff, identical per-line paisa math.
    const { openingP, netP, touched, flows } = await cashFlowSQL(ctx.vendorId, p.from, p.to)
    const sectionOf = (code: string) =>
      code.startsWith("1") ? "ASSETS" : code.startsWith("2") ? "LIABILITIES" : code.startsWith("3") ? "EQUITY" : code.startsWith("4") ? "REVENUE" : "EXPENSES"
    const SECTION_DEFS: { key: string; group: string; label: string }[] = [
      { key: "operating_receipts", group: "REVENUE", label: "Operating Receipts" },
      { key: "operating_payments", group: "EXPENSES", label: "Operating Payments" },
      { key: "employee_lending", group: "ASSETS", label: "Employee Lending (net)" },
      { key: "financing", group: "LIABILITIES", label: "Financing (net)" },
      { key: "equity", group: "EQUITY", label: "Equity (net)" },
    ]
    const sections: { key: string; label: string; items: { code: string; name: string; amount: number }[]; total: number }[] = []
    let sectionsTotalP = 0
    for (const def of SECTION_DEFS) {
      const items = [...flows.entries()]
        .filter(([code, amountP]) => amountP !== 0 && sectionOf(code) === def.group)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([code, amountP]) => ({ code, name: ACCOUNTS[code] || code, amount: amountP / 100 }))
      if (!items.length) continue // EQUITY (and any empty section) drops out
      const totalP = items.reduce((s, r) => s + Math.round(r.amount * 100), 0)
      sectionsTotalP += totalP
      sections.push({ key: def.key, label: def.label, items, total: totalP / 100 })
    }
    // Guard — counterpart sections must explain the cash movement to the paisa
    // (double-entry). If they ever do not, surface it loudly like the balance
    // sheet's UNBALANCED row instead of showing a quietly wrong statement.
    const diffP = netP - sectionsTotalP
    return {
      title: "Cash Flow Statement (Direct Method)",
      scopeNote: "Cash = Cash on Hand (1010) + Bank Accounts (1200) + MFS Wallets (1210). Every cash movement is explained by its non-cash counterpart lines, grouped into operating receipts/payments, employee lending and financing; internal cash-to-cash transfers net to zero. With this HRM chart there are no revenue or equity accounts, so receipts and equity sections appear only when such lines exist.",
      from: p.from,
      to: p.to,
      journalCount: touched,
      opening: openingP / 100,
      sections,
      netChange: netP / 100,
      closing: (openingP + netP) / 100,
      balanced: diffP === 0,
      difference: diffP / 100,
    }
  },
})

// ================= WAVE 4 — BUDGETS (with variance) =================
// Budget lines: account (+ optional period, + optional cost center) → amount.
// Actuals are recomputed from POSTED journal lines (Σ|net| per line, paisa-int)
// scoped by the row's period date-range and/or cost center tag; variance =
// budget − actual (negative = OVER budget, shown red client-side).
route("accounting.budgets.list", {
  perm: ["accounting", "view"],
  schema: z.object({ periodId: idBlankOpt }).strict(),
  handler: async (ctx, p) => {
    const budgets = await db.budget.findMany({
      where: { vendorId: ctx.vendorId, ...(p.periodId ? { periodId: p.periodId } : {}) },
      orderBy: [{ accountCode: "asc" }, { createdAt: "asc" }],
    })
    const [periods, costCenters] = await Promise.all([
      db.accountingPeriod.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { startDate: "desc" } }),
      db.costCenter.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { code: "asc" } }),
    ])
    const periodById = new Map(periods.map((x) => [x.id, x]))
    const ccById = new Map(costCenters.map((x) => [x.id, x]))
    // ACC-01 (R6) — actuals compute SQL-side per filter shape (memoised as
    // before): ABS(ROUND(debit*100) − ROUND(credit*100)) summed per matching
    // line. The bounded sweep and its 20,000-journal failure are gone.
    const memo = new Map<string, number>()
    const actualFor = async (accountCode: string, costCenterId: string | null, from?: string, to?: string): Promise<number> => {
      const key = `${accountCode}|${costCenterId || "-"}|${from || ""}|${to || ""}`
      const hit = memo.get(key)
      if (hit != null) return hit
      const rows = await db.$queryRaw<Array<{ p: bigint | null }>>`
        SELECT COALESCE(SUM(ABS(ROUND(COALESCE(l."debit", 0)::numeric * 100) - ROUND(COALESCE(l."credit", 0)::numeric * 100))), 0)::bigint AS p
        FROM "AccountJournal" j,
             jsonb_to_recordset(j."linesJson"::jsonb) AS l("account" text, "accountName" text, "debit" numeric, "credit" numeric)
        WHERE j."vendorId" = ${ctx.vendorId}
          AND j."status" = 'POSTED'
          AND l."account" = ${accountCode}
          ${costCenterId ? Prisma.sql`AND j."costCenterId" = ${costCenterId}` : Prisma.empty}
          ${from ? Prisma.sql`AND j."date" >= ${from}` : Prisma.empty}
          ${to ? Prisma.sql`AND j."date" <= ${to}` : Prisma.empty}`
      const sumP = Number(rows[0]?.p ?? 0)
      memo.set(key, sumP)
      return sumP
    }
    const rows = await Promise.all(budgets.map(async (b) => {
      const period = b.periodId ? periodById.get(b.periodId) : undefined
      const cc = b.costCenterId ? ccById.get(b.costCenterId) : undefined
      const budgetP = Math.round((Number(b.amount) || 0) * 100)
      const actualP = await actualFor(b.accountCode, b.costCenterId ?? null, period?.startDate, period?.endDate)
      const varianceP = budgetP - actualP
      return {
        id: b.id,
        accountCode: b.accountCode,
        accountName: ACCOUNTS[b.accountCode] || b.accountCode,
        periodId: b.periodId ?? null,
        periodName: period?.name ?? null,
        costCenterId: b.costCenterId ?? null,
        costCenterName: cc ? `${cc.code} — ${cc.name}` : null,
        budget: budgetP / 100,
        actual: actualP / 100,
        variance: varianceP / 100,
        // variance as % of budget (negative = over); null when budget is 0
        pct: budgetP > 0 ? Math.round((varianceP / budgetP) * 10_000) / 100 : null,
        notes: b.notes ?? null,
        createdByName: b.createdByName ?? null,
      }
    }))
    return {
      rows,
      // pickers for the client form (vendor-scoped, same data — no extra calls)
      periods: periods.map((x) => ({ id: x.id, name: x.name, startDate: x.startDate, endDate: x.endDate, status: x.status })),
      costCenters: costCenters.map((x) => ({ id: x.id, code: x.code, name: x.name, active: x.active })),
      totals: {
        budget: rows.reduce((s, r) => s + Math.round(r.budget * 100), 0) / 100,
        actual: rows.reduce((s, r) => s + Math.round(r.actual * 100), 0) / 100,
      },
    }
  },
})

route("accounting.budgets.save", {
  perm: ["accounting", "edit"],
  schema: z.object({
    id: idBlankOpt, // present = update
    periodId: idBlankOpt,
    costCenterId: idBlankOpt,
    accountCode: z.string().refine((a) => !!ACCOUNTS[a], {
      message: "Unknown account code — pick one from the chart of accounts",
    }),
    amount: z.number().finite().min(0),
    notes: textOpt(500),
  }).strict(),
  handler: async (ctx, p) => {
    // Optional refs must belong to THIS vendor (H-10) or be null.
    if (p.periodId) {
      const period = await db.accountingPeriod.findFirst({ where: { id: p.periodId, vendorId: ctx.vendorId }, select: { id: true } })
      if (!period) throw new Deny("Unknown accounting period for your workspace.", 400)
    }
    if (p.costCenterId) {
      const cc = await db.costCenter.findFirst({ where: { id: p.costCenterId, vendorId: ctx.vendorId }, select: { id: true } })
      if (!cc) throw new Deny("Unknown cost center for your workspace.", 400)
    }
    if (p.id) {
      const existing = await db.budget.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
      if (!existing) throw new Deny("Budget line not found for your workspace.", 404)
      const updated = await db.budget.update({
        where: { id: existing.id },
        data: {
          periodId: p.periodId ?? null,
          costCenterId: p.costCenterId ?? null,
          accountCode: p.accountCode,
          amount: p.amount,
          notes: p.notes ?? null,
        },
      })
      await audit(ctx, "BUDGET_SAVE", "Budget", updated.id,
        `Budget line updated — ${ACCOUNTS[p.accountCode] || p.accountCode} ৳${p.amount.toFixed(2)}${p.periodId ? " (period-scoped)" : ""}${p.costCenterId ? " (cost-center-scoped)" : ""}`,
        { oldValue: { accountCode: existing.accountCode, amount: existing.amount, periodId: existing.periodId, costCenterId: existing.costCenterId } })
      return { budgetId: updated.id }
    }
    const created = await db.budget.create({
      data: {
        vendorId: ctx.vendorId,
        periodId: p.periodId ?? null,
        costCenterId: p.costCenterId ?? null,
        accountCode: p.accountCode,
        amount: p.amount,
        notes: p.notes ?? null,
        createdById: ctx.userId,
        createdByName: ctx.userName,
      },
    })
    await audit(ctx, "BUDGET_SAVE", "Budget", created.id,
      `Budget line saved — ${ACCOUNTS[p.accountCode] || p.accountCode} ৳${p.amount.toFixed(2)}${p.periodId ? " (period-scoped)" : ""}${p.costCenterId ? " (cost-center-scoped)" : ""}`)
    return { budgetId: created.id }
  },
})

route("accounting.budgets.delete", {
  perm: ["accounting", "edit"],
  schema: z.object({ id: z.string().min(1), reason: textOpt(500) }).strict(),
  handler: async (ctx, p) => {
    const existing = await db.budget.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!existing) throw new Deny("Budget line not found for your workspace.", 404)
    await db.budget.delete({ where: { id: existing.id } })
    await audit(ctx, "BUDGET_DELETE", "Budget", existing.id,
      `Budget line deleted — ${ACCOUNTS[existing.accountCode] || existing.accountCode} ৳${(Number(existing.amount) || 0).toFixed(2)}. Reason: ${(p.reason || "not given").slice(0, 200)}`,
      { reason: p.reason || undefined })
    return { ok: true }
  },
})
