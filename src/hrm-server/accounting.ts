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
  ctx: { userId: string; userName: string; vendorId: string; ip?: string },
  refType: string,
  refId: string | null,
  date: string,
  memo: string,
  lines: JournalLine[],
  amount: number,
  opts?: { tx?: any; idempotencyKey?: string }
): Promise<string> {
  const client = opts?.tx || db
  const balanced = validateAndBalanceLines(lines) // M-4 — validates on a copy
  // H-3 — idempotency backstop: return the existing posting instead of double-posting
  if (opts?.idempotencyKey) {
    const existing = await client.accountJournal.findFirst({ where: { idempotencyKey: opts.idempotencyKey } })
    if (existing) return existing.id
  }
  const journal = await client.accountJournal.create({
    data: {
      vendorId: ctx.vendorId, refType, refId, idempotencyKey: opts?.idempotencyKey || null,
      date, memo, linesJson: JSON.stringify(balanced), amount, source: "HRM",
    },
  })
  await audit(ctx, `accounting.post.${refType.toLowerCase()}`, "AccountJournal", journal.id, `${memo} — ৳${amount.toFixed(0)}`)
  return journal.id
}

// ---- chart constants live in the client-safe shared module (WP-F) ----
export { ACCOUNTS, JOURNAL_ROLE_KEYS, DEFAULT_ACCOUNT_MAPPING } from "../hrm/accounting-chart"
export type { JournalRole } from "../hrm/accounting-chart"
import { ACCOUNTS, DEFAULT_ACCOUNT_MAPPING, JOURNAL_ROLE_KEYS } from "../hrm/accounting-chart"
import type { JournalRole } from "../hrm/accounting-chart"

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
