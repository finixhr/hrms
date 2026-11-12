// ============ Accounting Integration (spec §10.4) ============
// HR must NOT create a parallel financial system — every posting goes through
// this journal adapter into the vendor ERP chart of accounts.
//
// REMEDIATION:
//  - M-4: one-sided entries are rejected; imbalances beyond ৳0.50 are rejected;
//    sub-tolerance rounding is applied to a COPY of the caller's lines (the
//    caller's array is never mutated).
//  - H-3: supports transaction-scoped clients and a unique idempotency key so
//    money-critical postings (payroll payment) are single-shot at the DB level.

import { db } from "@/lib/db"
import { audit } from "./audit"
import { Deny } from "./rbac"
import { withPostingGuard } from "./period-close-lock"
import { toPaisa, takaOf } from "./money"

export type JournalLine = { account: string; accountName: string; debit?: number; credit?: number }

/** M-4 — pure validation: returns balanced (copied) lines or throws. Unit-tested.
 *  H-9 (step 5) — tolerance tightened from ৳0.50 to ৳0.00: debit and credit
 *  sides must balance to the paisa (integer comparison, immune to float
 *  representation noise). Sub-paisa float noise is still absorbed into the
 *  last line on the COPY so callers never see a reject from 1e-12 drift. */
export function validateAndBalanceLines(lines: JournalLine[]): JournalLine[] {
  const copy: JournalLine[] = (lines || []).map((l) => ({ ...l }))
  if (!copy.length) throw new Deny("Journal entry has no lines", 400)
  const d = copy.reduce((s, l) => s + (Number(l.debit) || 0), 0)
  const c = copy.reduce((s, l) => s + (Number(l.credit) || 0), 0)
  if (d <= 0 && c <= 0) throw new Deny("Journal entry has neither a debit nor a credit side", 400)
  if (d <= 0 || c <= 0) throw new Deny("Journal entry is one-sided — both debit and credit sides are required", 400)
  // L-5 - the balance check is EXACT integer arithmetic on paisa-rounded line
  // values (the old code summed raw floats first, so sub-paisa drift could
  // accumulate before the rounding check, and the "plug" patch masked it).
  // Each line is normalized to its paisa value up front; the sums are then
  // integers and compare exactly.
  for (const l of copy) {
    if (l.debit != null) l.debit = Math.round((Number(l.debit) || 0) * 100) / 100
    if (l.credit != null) l.credit = Math.round((Number(l.credit) || 0) * 100) / 100
  }
  const dP = copy.reduce((s, l) => s + Math.round((Number(l.debit) || 0) * 100), 0)
  const cP = copy.reduce((s, l) => s + Math.round((Number(l.credit) || 0) * 100), 0)
  if (dP !== cP) {
    throw new Deny(`Journal entry is unbalanced by Tk ${(Math.abs(dP - cP) / 100).toFixed(2)} (H-9: tolerance is Tk 0.00 - entries must balance to the paisa)`, 400)
  }
  return copy
}

export async function postJournal(
  // FIN-013 (Phase 2): widened from { userId: string; userName: string; … } —
  // the four loop hooks pass the route Ctx whose userId/userName are
  // optional; postJournal only reads vendorId (required) and forwards to
  // audit(), whose ctx was already nullable. FIN-019: activeCompanyId rides
  // the same ctx so journal-posting audit rows carry the company stamp.
  ctx: { userId?: string | null; userName?: string | null; vendorId: string; ip?: string; activeCompanyId?: string | null; allCompaniesMode?: boolean },
  refType: string,
  refId: string | null,
  date: string,
  memo: string,
  lines: JournalLine[],
  amount: number,
  opts?: { tx?: any; idempotencyKey?: string; companyId?: string | null }
): Promise<string> {
  const balanced = validateAndBalanceLines(lines) // M-4 — validates on a copy
  // H-3 — idempotency backstop: return the existing posting instead of double-posting
  if (opts?.idempotencyKey) {
    const existing = await (opts?.tx || db).accountJournal.findFirst({ where: { idempotencyKey: opts.idempotencyKey } })
    if (existing) return existing.id
  }
  // FIN-028 (Phase 3) — every journal write now runs under the period-close
  // × posting mutual-exclusion guard: the (vendor, date) advisory lock is
  // taken inside the transaction, the closed-period state is re-checked
  // INSIDE the lock, and the create happens on the guarded client. With a
  // caller tx the lock holds until the CALLER's business write commits; a
  // concurrent periods.close of a covering range waits for this posting,
  // and a posting that starts after a close is refused (409). This
  // supersedes the Wave-4 "auto journals skip the period gate" exemption —
  // closed means closed for system postings too.
  const journal = await withPostingGuard(
    ctx.vendorId,
    (date || "").slice(0, 10) || new Date().toISOString().slice(0, 10),
    { companyId: opts?.companyId ?? null, tx: opts?.tx },
    async (client) =>
      await client.accountJournal.create({
        data: {
          vendorId: ctx.vendorId, companyId: opts?.companyId || null, refType, refId, idempotencyKey: opts?.idempotencyKey || null,
          date, memo, linesJson: JSON.stringify(balanced), amount, source: "HRM",
        },
      }),
  )
  await audit(ctx, `accounting.post.${refType.toLowerCase()}`, "AccountJournal", journal.id, `${memo} — ৳${amount.toFixed(0)}`)
  return journal.id
}

// ---- chart constants live in the client-safe shared module (WP-F) ----
export { ACCOUNTS, JOURNAL_ROLE_KEYS, DEFAULT_ACCOUNT_MAPPING } from "../hrm/accounting-chart"
export type { JournalRole } from "../hrm/accounting-chart"
import { ACCOUNTS, DEFAULT_ACCOUNT_MAPPING, JOURNAL_ROLE_KEYS } from "../hrm/accounting-chart"
import type { JournalRole } from "../hrm/accounting-chart"

// ==================== FIN-013 (Phase 2) — the procurement→inventory→asset ledger loop ====================
// The audit found the three modules never posted to the GL: the chain ran
// entirely off-ledger. These four hooks close the loop at the exact state
// transitions the modules already record (the GL event matrix lives in
// docs/runbooks/fin-013-ledger-posting.md):
//   · goods received on a purchase     → DR Inventory / CR Accounts Payable — Suppliers
//   · manual stock adjustment          → DR/CR Inventory vs Inventory Adjustments (gain/loss)
//   · stock issued as company property → DR Fixed Assets / CR Inventory
//   · asset retired or lost            → DR Asset Disposal Loss / CR Fixed Assets
// Every posting is toggle-gated per domain (settings → accounting), mapped
// through the SAME tenant-editable account mapping as payroll, idempotent
// (one posting per business event, H-3 key), company-stamped, and — where the
// hook site is already transactional — atomic with the stock/asset mutation.
// Deliberately NOT posted (matrix §"no posting", with rationale): transfers
// (same-account location moves, zero net GL), plain manual stock entries with
// no purchase link (no counterparty event to book), direct asset
// registrations (no supplier/invoice in the module), and requisition issues
// (consumption booking needs a cost-center decision the module does not
// carry — follow-up, documented in the runbook).

export type PostingOutcome = { journalId: string; amount: number } | { skipped: string }

/** FIN-013 toggle readers — undefined reads as ON (settings written before
 *  Phase 2 lack the keys; the loop posts unless the vendor opts out). */
export function autoPostProcurementJournal(settings: any): boolean {
  return settings?.accounting?.autoPostProcurement !== false
}
export function autoPostInventoryAdjustJournal(settings: any): boolean {
  return settings?.accounting?.autoPostInventory !== false
}
export function autoPostAssetJournal(settings: any): boolean {
  return settings?.accounting?.autoPostAssets !== false
}

async function postingSettings(vendorId: string) {
  const { getSettings } = await import("./settings")
  return getSettings(vendorId)
}

/** GL #1 — goods received on a purchase (procurement.receiveStock, after the
 *  stock entry posts). Amount = Σ lines qty × unitCost (the same basis the
 *  StockEntryItem rows and the moving-average "last cost" maintenance use).
 *  FIN-020 (Phase 3): the amount is computed in INTEGER PAISA — each line
 *  prefers the writer-stamped *Paisa shadow, falls back to paisaOf(Float),
 *  and rounds ONCE (qty × paisa); the journal's legacy Float amount derives
 *  from the exact paisa total, so float drift can never reach the GL. */
export async function postProcurementReceiptJournal(
  ctx: { userId?: string | null; userName?: string | null; vendorId: string; ip?: string; activeCompanyId?: string | null },
  entry: { id: string; code: string; entryDate?: string | null; purchaseId?: string | null; companyId?: string | null; items?: { quantity: number; unitCost: number; unitCostPaisa?: bigint | null }[] },
  pr?: { companyId?: string | null } | null,
  opts?: { tx?: any },
): Promise<PostingOutcome> {
  const amountPaisa = (entry.items || []).reduce((s, it) => {
    const up = it.unitCostPaisa != null ? BigInt(it.unitCostPaisa) : toPaisa(Number(it.unitCost) || 0)
    return s + BigInt(Math.round((Number(it.quantity) || 0) * Number(up)))
  }, 0n)
  if (!(amountPaisa > 0n)) return { skipped: "no cost basis (every line cost 0 or unknown)" }
  const amount = takaOf(amountPaisa)
  const settings = await postingSettings(ctx.vendorId)
  if (!autoPostProcurementJournal(settings)) return { skipped: "off (settings → accounting → autoPostProcurement)" }
  const am = resolveAccountMapping(settings)
  const date = (entry.entryDate || "").slice(0, 10) || new Date().toISOString().slice(0, 10)
  const journalId = await postJournal(
    ctx, "PROCURE_RECEIPT", entry.id, date,
    `Goods received on purchase — stock entry ${entry.code} (FIN-013: DR Inventory / CR Accounts Payable — Suppliers)`,
    [
      roleLine(am, "inventoryAsset", amount, "debit"),
      roleLine(am, "supplierPayable", amount, "credit"),
    ],
    amount,
    { idempotencyKey: `fin13:procurement:receive:${entry.id}`, companyId: entry.companyId || pr?.companyId || ctx.activeCompanyId || null, ...opts },
  )
  return { journalId, amount }
}

/** GL #2 — manual stock adjustment (inventory.stock.adjust, after the
 *  StockTransaction row commits). Gain: DR Inventory / CR Adjustments; loss:
 *  DR Adjustments / CR Inventory. Valued at the item's maintained last cost.
 *  FIN-020 (Phase 3): the valuation prefers the lastCostPaisa shadow and
 *  computes |delta| × basis in paisa with a single rounding; the Float
 *  journal amount derives from the exact paisa product. */
export async function postInventoryAdjustJournal(
  ctx: { userId?: string | null; userName?: string | null; vendorId: string; ip?: string; activeCompanyId?: string | null },
  item: { id: string; name: string; lastCost?: number | null; lastCostPaisa?: bigint | null; companyId?: string | null },
  delta: number,
  stockTxId: string,
  companyId?: string | null,
): Promise<PostingOutcome> {
  const basisPaisa = item.lastCostPaisa != null ? BigInt(item.lastCostPaisa) : toPaisa(Number(item.lastCost) || 0)
  const amountPaisa = BigInt(Math.round(Math.abs(delta) * Number(basisPaisa)))
  if (!(amountPaisa > 0n)) return { skipped: `no cost basis (item lastCost ${takaOf(basisPaisa) || "unknown"})` }
  const amount = takaOf(amountPaisa)
  const settings = await postingSettings(ctx.vendorId)
  if (!autoPostInventoryAdjustJournal(settings)) return { skipped: "off (settings → accounting → autoPostInventory)" }
  const am = resolveAccountMapping(settings)
  const gain = delta > 0
  const journalId = await postJournal(
    ctx, "INVENTORY_ADJUST", stockTxId, new Date().toISOString().slice(0, 10),
    `Stock adjustment ${gain ? "gain" : "loss"} — ${item.name} ×${Math.abs(delta)} @ ${(amount / Math.abs(delta)).toFixed(2)} (FIN-013)`,
    gain
      ? [roleLine(am, "inventoryAsset", amount, "debit"), roleLine(am, "stockAdjustment", amount, "credit")]
      : [roleLine(am, "stockAdjustment", amount, "debit"), roleLine(am, "inventoryAsset", amount, "credit")],
    amount,
    { idempotencyKey: `fin13:adjust:${stockTxId}`, companyId: companyId || item.companyId || ctx.activeCompanyId || null },
  )
  return { journalId, amount }
}

/** GL #3 — stock issued as company property (executeAssetIssue, inside the
 *  same transaction as the stock decrement). DR Fixed Assets / CR Inventory.
 *  FIN-020 (Phase 3): qty × unit cost computed in paisa (shadow-preferred,
 *  single rounding); the Float journal amount derives from the exact paisa. */
export async function postAssetIssueJournal(
  ctx: { userId?: string | null; userName?: string | null; vendorId: string; ip?: string; activeCompanyId?: string | null },
  args: { item: { id: string; name: string; companyId?: string | null }; qty: number; unitCost: number; unitCostPaisa?: bigint | null; requestId?: string | null; companyId?: string | null },
  opts?: { tx?: any },
): Promise<PostingOutcome> {
  const up = args.unitCostPaisa != null ? BigInt(args.unitCostPaisa) : toPaisa(Number(args.unitCost) || 0)
  const amountPaisa = BigInt(Math.round((Number(args.qty) || 0) * Number(up)))
  if (!(amountPaisa > 0n)) return { skipped: "no cost basis (unitCost unknown)" }
  const amount = takaOf(amountPaisa)
  const settings = await postingSettings(ctx.vendorId)
  if (!autoPostAssetJournal(settings)) return { skipped: "off (settings → accounting → autoPostAssets)" }
  const am = resolveAccountMapping(settings)
  const journalId = await postJournal(
    ctx, "STOCK_ASSET_ISSUE", args.requestId || args.item.id, new Date().toISOString().slice(0, 10),
    `Stock issued as company property — ${args.item.name} ×${args.qty} (FIN-013: DR Fixed Assets / CR Inventory)`,
    [
      roleLine(am, "fixedAssets", amount, "debit"),
      roleLine(am, "inventoryAsset", amount, "credit"),
    ],
    amount,
    { idempotencyKey: `fin13:assetissue:${args.requestId || args.item.id}`, companyId: args.companyId || args.item.companyId || ctx.activeCompanyId || null, ...opts },
  )
  return { journalId, amount }
}

/** GL #4 — asset retired or lost (assets.retire / assets.lose, inside the
 *  same transaction as the status change). Carrying value = purchaseCost (no
 *  depreciation module — documented in the runbook). DR Asset Disposal Loss /
 *  CR Fixed Assets. FIN-020 (Phase 3): the carrying value prefers the
 *  purchaseCostPaisa shadow; the Float journal amount derives from it. */
export async function postAssetDisposalJournal(
  ctx: { userId?: string | null; userName?: string | null; vendorId: string; ip?: string; activeCompanyId?: string | null },
  asset: { id: string; code: string; purchaseCost?: number | null; purchaseCostPaisa?: bigint | null; companyId?: string | null },
  kind: "RETIRE" | "LOSE",
  opts?: { tx?: any },
): Promise<PostingOutcome> {
  const amountPaisa = asset.purchaseCostPaisa != null ? BigInt(asset.purchaseCostPaisa) : toPaisa(Number(asset.purchaseCost) || 0)
  if (!(amountPaisa > 0n)) return { skipped: "no carrying value (purchaseCost unknown — nothing to write off)" }
  const amount = takaOf(amountPaisa)
  const settings = await postingSettings(ctx.vendorId)
  if (!autoPostAssetJournal(settings)) return { skipped: "off (settings → accounting → autoPostAssets)" }
  const am = resolveAccountMapping(settings)
  const journalId = await postJournal(
    ctx, kind === "RETIRE" ? "ASSET_RETIRE" : "ASSET_LOSE", asset.id, new Date().toISOString().slice(0, 10),
    `Asset ${kind === "RETIRE" ? "retired" : "marked lost"} — ${asset.code} @ carrying ${amount.toFixed(2)} (FIN-013: DR Asset Disposal Loss / CR Fixed Assets)`,
    [
      roleLine(am, "assetDisposalLoss", amount, "debit"),
      roleLine(am, "fixedAssets", amount, "credit"),
    ],
    amount,
    { idempotencyKey: `fin13:asset:${kind.toLowerCase()}:${asset.id}`, companyId: asset.companyId || ctx.activeCompanyId || null, ...opts },
  )
  return { journalId, amount }
}

export type AccountMapping = Record<JournalRole, string>

/** Resolve the effective role→code mapping from vendor settings (HrSetting
 *  group "accounting" → { autoPost?: boolean, accountMapping?: {...} }).
 *  Unknown/invalid codes fall back to the default chart — a half-edited
 *  mapping can never break a money posting. */
export function resolveAccountMapping(settings: any): AccountMapping {
  const out = { ...DEFAULT_ACCOUNT_MAPPING }
  const stored = settings?.accounting?.accountMapping
  if (stored && typeof stored === "object") {
    for (const role of JOURNAL_ROLE_KEYS) {
      const code = String((stored as Record<string, unknown>)[role] ?? "")
      if (code && ACCOUNTS[code]) out[role] = code
    }
  }
  return out
}

/** "Auto-post payroll to accounting" toggle (default ON = historical
 *  behaviour). When OFF, payRun skips the accrual journal entirely — the
 *  vendor runs the journal manually from their own books. */
export function autoPostPayrollJournal(settings: any): boolean {
  return settings?.accounting?.autoPost !== false
}

/** Build one journal line for a role using the effective mapping. */
export function roleLine(mapping: AccountMapping, role: JournalRole, amount: number, side: "debit" | "credit"): JournalLine {
  const code = mapping[role]
  const line: JournalLine = { account: code, accountName: ACCOUNTS[code] || code }
  if (side === "debit") line.debit = amount
  else line.credit = amount
  return line
}

/** PAY-001 (R3-1) — normalize the SIDES of a journal whose amounts may be
 *  negative (adjustment runs carry DELTAS: a correction that reduces an
 *  expense is a credit, a recovered net is a debit). Accounting convention:
 *  a negative debit line flips to a positive credit line and vice versa;
 *  zero lines are dropped. Flipping every negative line preserves the debit
 *  = credit balance exactly (each flip moves the line's absolute value from
 *  one side to the other), so a balanced delta journal stays balanced. */
export function normalizeJournalSides(lines: JournalLine[]): JournalLine[] {
  const out: JournalLine[] = []
  for (const l of lines || []) {
    const d = Math.round((Number(l.debit) || 0) * 100) / 100
    const c = Math.round((Number(l.credit) || 0) * 100) / 100
    if (d === 0 && c === 0) continue
    if (d < 0) out.push({ account: l.account, accountName: l.accountName, credit: -d })
    else if (c < 0) out.push({ account: l.account, accountName: l.accountName, debit: -c })
    else if (d !== 0) out.push({ account: l.account, accountName: l.accountName, debit: d })
    else out.push({ account: l.account, accountName: l.accountName, credit: c })
  }
  return out
}
