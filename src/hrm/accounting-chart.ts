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
  // ---- liabilities ----
  "2100": "Salaries Payable",
  "2105": "AIT Payable",
  "2150": "Provident Fund Payable",
  // ---- expenses / contra ----
  "5100": "Salary & Wages Expense",
  "5110": "Overtime Expense",
  "5120": "Bonus & Commission Expense",
  "5150": "PF Employer Expense",
  "5290": "Salary Deductions Recovered",
  "5300": "Employee Expense / Reimbursement",
  "6100": "Final Settlement Expense",
}

export const JOURNAL_ROLE_KEYS = [
  "salaryExpense", "otExpense", "bonusExpense", "pfEmployerExpense",
  "aitPayable", "pfPayable", "salariesPayable", "loanReceivable", "advances",
  "deductionsRecovered", "bank", "cash", "mfs",
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
}
