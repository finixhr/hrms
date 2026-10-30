// ============ Loan / advance recovery math — pure helpers (LOA-001, ADV-001, R3-4) ============
// Extracted from calculateRun so the arrears-budgeting and the take-home
// floor have ONE canonical, unit-testable implementation each — the calc
// path, the guarantor fallback pass and the pay-time ledger recovery all
// select the same "due" set, and the payslip warning math is provable
// without a database.
//
// Pure by design: no db, no settings — unit-testable without PostgreSQL.

export type InstallmentLike = {
  id: string
  no?: number
  dueDate: string
  amount: number
  paidAmount: number
  status?: string
}

/** LOA-001 — the installments a payroll run BUDGETS for a loan: the CURRENT
 *  period's unpaid installment ALWAYS budgets, plus up to `arrearsMax` of the
 *  most-recent MISSED installments (older EMIs first, newest arrears nearest
 *  the current one — a cap of 2 picks Aug+Jul arrears for a Sept period, not
 *  June+Jul). arrearsMax 0 = the historical current-month-only behaviour.
 *  Callers pre-filter by status where the data source requires it (the calc
 *  path pre-fetches PENDING/OVERDUE/PARTIAL only). Rows come back in
 *  schedule (no) order, oldest first. */
export function dueInstallmentsFor(inst: InstallmentLike[], monthPrefix: string, arrearsMax: number): InstallmentLike[] {
  const max = Math.max(0, Math.floor(Number(arrearsMax) || 0))
  const unpaidDue = inst.filter((i) => i.dueDate.slice(0, 7) <= monthPrefix && i.paidAmount < i.amount)
  const current = unpaidDue.filter((i) => i.dueDate.slice(0, 7) === monthPrefix)
  if (max <= 0) return current // historical behaviour: this period's EMI only
  const older = unpaidDue.filter((i) => i.dueDate.slice(0, 7) < monthPrefix)
  const olderPicked = older.length > max ? older.slice(older.length - max) : older
  return [...olderPicked, ...current]
}

/** The taka a run budgets for the selected due set (weekly runs prorate). */
export function dueAmountFor(inst: InstallmentLike[], fraction = 1): number {
  return inst.reduce((s, i) => s + (i.amount - i.paidAmount), 0) * (Number(fraction) || 1)
}

/** ADV-001/PAY-009 — the borrower's minimum take-home floor: the OWN loan +
 *  advance recovery can never exceed `floorPct`% of the pre-recovery net.
 *  The excess is deferred (loan arrears re-budget it next run; an advance
 *  simply runs longer). Returns the clamped deductions + the deferred amount
 *  so the payslip breakdown can surface both. floorPct 0 = disabled. */
export function applyRecoveryFloor(
  loanDeduction: number,
  advanceDeduction: number,
  preRecoveryNet: number,
  floorPct: number,
): { loanDeduction: number; advanceDeduction: number; deferred: number; capped: boolean } {
  const pct = Math.min(100, Math.max(0, Math.floor(Number(floorPct) || 0)))
  const loan = Math.max(0, Number(loanDeduction) || 0)
  const adv = Math.max(0, Number(advanceDeduction) || 0)
  if (pct <= 0 || loan + adv <= 0) {
    return { loanDeduction: loan, advanceDeduction: adv, deferred: 0, capped: false }
  }
  const cap = Math.max(0, Math.floor((Number(preRecoveryNet) || 0) * pct / 100))
  const recovery = loan + adv
  if (recovery <= cap) {
    return { loanDeduction: loan, advanceDeduction: adv, deferred: 0, capped: false }
  }
  const excess = recovery - cap
  // loan first (arrears budgeting picks the shortfall up next run), then advance
  const cutLoan = Math.min(loan, excess)
  const cutAdv = Math.min(adv, excess - cutLoan)
  return { loanDeduction: loan - cutLoan, advanceDeduction: adv - cutAdv, deferred: excess, capped: true }
}

/** MON-9 (Phase 4) — the integer-paisa twin of applyRecoveryFloor, with
 *  IDENTICAL semantics: pct floors to a whole percent (Math.floor of the
 *  settings value), the cap is a mathematical FLOOR of the pre-recovery net
 *  share (never rounds a deduction budget UP), loan is cut before advance.
 *  Pure bigint in/out — the payroll engine's only recovery-floor boundary. */
export function applyRecoveryFloorPaisa(
  loanDeductionP: bigint,
  advanceDeductionP: bigint,
  preRecoveryNetP: bigint,
  floorPct: number,
): { loanDeductionP: bigint; advanceDeductionP: bigint; deferredP: bigint; capped: boolean } {
  const pct = Math.min(100, Math.max(0, Math.floor(Number(floorPct) || 0)))
  const loan = loanDeductionP > 0n ? loanDeductionP : 0n
  const adv = advanceDeductionP > 0n ? advanceDeductionP : 0n
  if (pct <= 0 || loan + adv <= 0n) {
    return { loanDeductionP: loan, advanceDeductionP: adv, deferredP: 0n, capped: false }
  }
  const net = preRecoveryNetP > 0n ? preRecoveryNetP : 0n
  const cap = (net * BigInt(pct)) / 100n // floor: bigint division truncates; net ≥ 0, pct ≥ 0 → mathematical floor
  const recovery = loan + adv
  if (recovery <= cap) {
    return { loanDeductionP: loan, advanceDeductionP: adv, deferredP: 0n, capped: false }
  }
  const excess = recovery - cap
  // loan first (arrears budgeting picks the shortfall up next run), then advance
  const cutLoan = loan < excess ? loan : excess
  const cutAdv = adv < (excess - cutLoan) ? adv : (excess - cutLoan)
  return { loanDeductionP: loan - cutLoan, advanceDeductionP: adv - cutAdv, deferredP: excess, capped: true }
}
