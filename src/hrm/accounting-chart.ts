// ============ Accounting chart constants (client-safe — WP-F) ============
// NO server imports here (no db/audit/rbac): this module is imported by BOTH
// the server accounting adapter and client views (Settings → Payroll →
// Accounting). Single source of truth for the chart + role defaults.

export const ACCOUNTS: Record<string, string> = {
  // ---- assets ----
  "1010": "Cash on Hand",
  "1150": "Employee Loan Receivable",
  "1155": "Employee Advances",
  "1200": "Bank Accounts",
  "1210": "MFS Wallets (bKash/Nagad)",
  // FIN-013 (Phase 2, 2026-11-10) — the procurement→inventory→asset loop
  // posts to the ledger. Inventory (goods received on purchases), Fixed
  // Assets (stock issued as company property) and the periphery accounts
  // the loop needs: supplier payables at receipt, adjustment gain/loss, and
  // disposal loss. Same 4-digit chart family, same client-safe module.
  "1300": "Inventory",
  "1400": "Fixed Assets — Company Property",
  // ---- liabilities ----
  "2100": "Salaries Payable",
  "2105": "AIT Payable",
  "2150": "Provident Fund Payable",
  "2110": "Accounts Payable — Suppliers",
  // ---- expenses / contra ----
  "5100": "Salary & Wages Expense",
  "5110": "Overtime Expense",
  "5120": "Bonus & Commission Expense",
  "5150": "PF Employer Expense",
  "5290": "Salary Deductions Recovered",
  "5300": "Employee Expense / Reimbursement",
  "5310": "Inventory Adjustments (gain/loss)",
  "6100": "Final Settlement Expense",
  "6200": "Asset Disposal Loss",
}

export const JOURNAL_ROLE_KEYS = [
  "salaryExpense", "otExpense", "bonusExpense", "pfEmployerExpense",
  "aitPayable", "pfPayable", "salariesPayable", "loanReceivable", "advances",
  "deductionsRecovered", "bank", "cash", "mfs",
  // FIN-013 (Phase 2) — the procurement→inventory→asset loop roles
  "inventoryAsset", "supplierPayable", "fixedAssets", "stockAdjustment", "assetDisposalLoss",
] as const
export type JournalRole = (typeof JOURNAL_ROLE_KEYS)[number]

export const DEFAULT_ACCOUNT_MAPPING: Record<JournalRole, string> = {
  salaryExpense: "5100",
  otExpense: "5110",
  bonusExpense: "5120",
  pfEmployerExpense: "5150",
  aitPayable: "2105",
  pfPayable: "2150",
  salariesPayable: "2100",
  loanReceivable: "1150",
  advances: "1155",
  deductionsRecovered: "5290",
  bank: "1200",
  cash: "1010",
  mfs: "1210",
  // FIN-013 (Phase 2)
  inventoryAsset: "1300",
  supplierPayable: "2110",
  fixedAssets: "1400",
  stockAdjustment: "5310",
  assetDisposalLoss: "6200",
}
