// ============ Salary payout resolution & validation (2026-10 round §42–§47, §78) ============
// Built ON the existing BankAccount foundation — no duplicate table.
//
// Model:
//   Employee.salaryPayoutMethod       BANK | CASH | MFS (null = unconfigured legacy)
//   Employee.salaryPayoutAccountId    designated account id (BANK/MFS)
//   BankAccount.isSalaryPayoutAccount exactly-one designation flag
//
// Resolution (§47 — never findFirst() blindly):
//   1. designated account (salaryPayoutAccountId) — must exist + match method
//   2. fallback: the account flagged isSalaryPayoutAccount
//   3. legacy fallback: exactly-one-account employee → that account
//   CASH never needs an account.
//
// Threshold rule (§45): salary <= maxCashMfsSalary → BANK/CASH/MFS allowed
// per settings; salary > threshold → BANK ONLY. Enforced server-side at
// employee create/edit, structure change, payout-account save, payroll
// calculate, payroll pay and salary export — never frontend-only.
import { db } from "@/lib/db"
import { getSettings } from "./settings"
import { Deny } from "./rbac"
import { readPiiTextStrict, piiTextForStorage } from "./pii-field"

export type PayoutMethod = "BANK" | "CASH" | "MFS"
export const PAYOUT_METHODS: PayoutMethod[] = ["BANK", "CASH", "MFS"]
export const MFS_PROVIDERS = ["BKASH", "NAGAD", "ROCKET", "OTHER"]

export type PayoutSettings = {
  bankEnabled: boolean
  cashEnabled: boolean
  mfsEnabled: boolean
  /** salaries above this are BANK-only */
  maxCashMfsSalary: number
  /** basis the threshold compares against (default GROSS, §45) */
  thresholdBasis: "GROSS" | "NET"
}

export function payoutSettings(s: Awaited<ReturnType<typeof getSettings>>): PayoutSettings {
  const p = (s as any).payout ?? {}
  return {
    bankEnabled: p.bankEnabled !== false,
    cashEnabled: p.cashEnabled !== false,
    mfsEnabled: p.mfsEnabled !== false,
    maxCashMfsSalary: Number(p.maxCashMfsSalary ?? 10000),
    thresholdBasis: p.thresholdBasis === "NET" ? "NET" : "GROSS",
  }
}

export type ResolvedPayout = {
  method: PayoutMethod | null // null = unconfigured
  account: {
    id: string
    bank: string | null
    branch: string | null
    holderName: string | null
    accountNumber: string | null
    routingNumber: string | null
    mfsProvider: string | null
    mfsNumber: string | null
  } | null
  /** why resolution fell back / stopped — surfaced to admins */
  note?: string
}

/** Resolve the employee's ONE effective salary payout account/method (§47). */
export async function resolveSalaryPayout(employeeId: string): Promise<ResolvedPayout> {
  const emp = await db.employee.findUnique({ where: { id: employeeId } })
  if (!emp) return { method: null, account: null, note: "Employee not found" }
  const method = (emp as any).salaryPayoutMethod as PayoutMethod | null

  if (!method || method === "CASH") {
    // CASH (or legacy unconfigured) → no account required
    return { method: method === "CASH" ? "CASH" : null, account: null, note: method ? undefined : "Payout method not configured" }
  }

  // BANK / MFS → resolve the designated account, never findFirst() luck
  const accounts = await db.bankAccount.findMany({ where: { employeeId } })
  const byId = new Map(accounts.map((a) => [a.id, a]))
  const designatedId = (emp as any).salaryPayoutAccountId as string | null
  let chosen = designatedId ? byId.get(designatedId) : undefined
  if (!chosen) chosen = accounts.find((a: any) => a.isSalaryPayoutAccount === true)
  if (!chosen && accounts.length === 1) chosen = accounts[0] // legacy single-account fallback
  if (!chosen) {
    return {
      method,
      account: null,
      note: `Payout method is ${method} but no bank/MFS account is designated — configure Salary & Payout`,
    }
  }
  // F28 (P6) — account/MFS numbers are encrypted at rest. STRICT decrypt: the
  // disbursement paths (salary export, payslip, §78 preflight) must never
  // silently operate on a value they could not read — a rotated-away key
  // surfaces as an operator-actionable error, not a blank bank file.
  const dec = (v: string | null | undefined, what: string) => readPiiTextStrict(v, what)
  return {
    method,
    account: {
      id: chosen.id,
      bank: (chosen as any).bank ?? null,
      branch: (chosen as any).branch ?? null,
      holderName: (chosen as any).holderName ?? null,
      accountNumber: dec((chosen as any).accountNumber, "bank account number"),
      routingNumber: (chosen as any).routingNumber ?? null,
      mfsProvider: (chosen as any).mfsProvider ?? null,
      mfsNumber: dec((chosen as any).mfsNumber, "MFS number"),
    },
  }
}

/**
 * MON-4 (Phase 1) — BATCH resolver for the pay-time §78 preflight.
 * resolveSalaryPayout costs 2 queries per employee (employee row + bank
 * accounts), so validating a run employee-by-employee burned 2N round-trips
 * BEFORE the payment transaction — and the old loop silently stopped at the
 * first 500 entries, leaving everyone beyond #500 completely unvalidated.
 * This variant resolves an ENTIRE run with exactly 2 queries (employees +
 * bank accounts) and the identical §47 three-step resolution in memory.
 * Returns a Map keyed by employeeId. Employees not found map to a
 * "not found" note, same as the single form.
 */
export async function resolveSalaryPayouts(employeeIds: string[]): Promise<Map<string, ResolvedPayout>> {
  const out = new Map<string, ResolvedPayout>()
  if (!employeeIds.length) return out
  const [emps, accounts] = await Promise.all([
    db.employee.findMany({
      where: { id: { in: employeeIds } },
      select: { id: true, fullName: true, code: true, salaryPayoutMethod: true, salaryPayoutAccountId: true },
    }),
    db.bankAccount.findMany({ where: { employeeId: { in: employeeIds } } }),
  ])
  const byEmp = new Map<string, typeof accounts>()
  for (const a of accounts) {
    const list = byEmp.get(a.employeeId) || []
    list.push(a)
    byEmp.set(a.employeeId, list)
  }
  for (const emp of emps) {
    const method = (emp as any).salaryPayoutMethod as PayoutMethod | null
    if (!method || method === "CASH") {
      out.set(emp.id, { method: method === "CASH" ? "CASH" : null, account: null, note: method ? undefined : "Payout method not configured" })
      continue
    }
    const list = byEmp.get(emp.id) || []
    const byId = new Map(list.map((a) => [a.id, a]))
    const designatedId = (emp as any).salaryPayoutAccountId as string | null
    let chosen: any = designatedId ? byId.get(designatedId) : undefined
    if (!chosen) chosen = list.find((a: any) => a.isSalaryPayoutAccount === true)
    if (!chosen && list.length === 1) chosen = list[0]
    if (!chosen) {
      out.set(emp.id, {
        method,
        account: null,
        note: `Payout method is ${method} but no bank/MFS account is designated — configure Salary & Payout`,
      })
      continue
    }
    out.set(emp.id, {
      method,
      account: {
        id: chosen.id,
        bank: chosen.bank ?? null,
        branch: chosen.branch ?? null,
        holderName: chosen.holderName ?? null,
        // F28 (P6) — strict decrypt for the disbursement paths (same rule as
        // the single-employee resolver above).
        accountNumber: readPiiTextStrict(chosen.accountNumber, "bank account number"),
        routingNumber: chosen.routingNumber ?? null,
        mfsProvider: chosen.mfsProvider ?? null,
        mfsNumber: readPiiTextStrict(chosen.mfsNumber, "MFS number"),
      },
    })
  }
  // employees requested but not found (deleted mid-flight) — same note as the single form
  for (const id of employeeIds) {
    if (!out.has(id)) out.set(id, { method: null, account: null, note: "Employee not found" })
  }
  return out
}

/** Employee code/name for a preflight violation message (kept out of the
 *  resolver Map above so it stays a pure §47 resolution). */
export async function payoutViolationLabel(employeeId: string): Promise<string> {
  const emp = await db.employee.findUnique({ where: { id: employeeId }, select: { code: true, fullName: true } })
  return `${emp?.fullName ?? employeeId} (${emp?.code ?? "?"})`
}

export type PayoutValidation = {
  ok: boolean
  method: PayoutMethod | null
  reasons: string[] // user-actionable messages (§87)
  warnings: string[]
}

/**
 * Validate one employee's payout configuration against the salary and the
 * vendor payout settings. `salary` defaults to gross (thresholdBasis GROSS).
 *
 * Semantics for legacy employees (method = null): treated as CASH *only* when
 * the salary is within the cash/MFS threshold; above it the check fails with
 * a configure-payout message (§78: payment must not proceed until corrected).
 */
export function validatePayout(
  payout: ResolvedPayout,
  salary: number,
  settings: PayoutSettings
): PayoutValidation {
  const reasons: string[] = []
  const warnings: string[] = []
  const overThreshold = salary > settings.maxCashMfsSalary

  if (payout.method == null) {
    warnings.push("Payout method is not configured")
    if (overThreshold) {
      reasons.push(
        `Payout method must be configured (Bank only) for salaries above ৳${settings.maxCashMfsSalary.toLocaleString("en-IN")}`
      )
      return { ok: false, method: null, reasons, warnings }
    }
    if (!settings.cashEnabled) {
      reasons.push("Cash payout is disabled in Payroll → Payout Settings")
      return { ok: false, method: null, reasons, warnings }
    }
    return { ok: true, method: "CASH", reasons, warnings }
  }

  // method explicitly configured
  switch (payout.method) {
    case "BANK":
      if (!settings.bankEnabled) reasons.push("Bank payout is disabled in Payroll → Payout Settings")
      if (!payout.account?.accountNumber) reasons.push("Bank account information is required for Bank payout")
      break
    case "MFS":
      if (!settings.mfsEnabled) reasons.push("MFS payout is disabled in Payroll → Payout Settings")
      if (overThreshold) reasons.push(`MFS payout is not allowed above ৳${settings.maxCashMfsSalary.toLocaleString("en-IN")}`)
      if (!payout.account?.mfsNumber) reasons.push("MFS account number is required for MFS payout")
      break
    case "CASH":
      if (!settings.cashEnabled) reasons.push("Cash payout is disabled in Payroll → Payout Settings")
      if (overThreshold) reasons.push(`Cash payout is not allowed above ৳${settings.maxCashMfsSalary.toLocaleString("en-IN")}`)
      break
  }
  return { ok: reasons.length === 0, method: payout.method, reasons, warnings }
}

/** Convenience: resolve + validate in one call. */
export async function checkEmployeePayout(employeeId: string, salary: number): Promise<PayoutValidation> {
  const settings = await getSettings(employeeId ? await vendorOfEmployee(employeeId) : "")
  const payout = await resolveSalaryPayout(employeeId)
  return validatePayout(payout, salary, payoutSettings(settings))
}

async function vendorOfEmployee(employeeId: string): Promise<string> {
  const emp = await db.employee.findUnique({ where: { id: employeeId }, select: { vendorId: true } })
  if (!emp) throw new Deny("Employee not found", 404)
  return emp.vendorId
}

/**
 * Server-side enforcement for payout-account writes (employee create/edit,
 * payout account save). Rejects an invalid method+salary combination and
 * enforces exactly-one designated account.
 *
 * `vendorId` MUST be supplied by the caller (from the request Ctx) — the
 * employee row may have been created INSIDE the caller's uncommitted
 * $transaction (createWithStructure), so reading it back through the
 * non-transaction `db` client here returns null. That was the root cause of
 * the "Employee not found" error on every Create Employee submission: the
 * settings cache is global and only needs the vendor id, never the employee
 * row itself.
 */
export async function applyPayoutSelection(
  tx: any,
  employeeId: string,
  vendorId: string,
  method: PayoutMethod | null,
  salary: number,
  accountInput: {
    bank?: string | null
    branch?: string | null
    holderName?: string | null
    accountNumber?: string | null
    routingNumber?: string | null
    mfsProvider?: string | null
    mfsNumber?: string | null
  } | null
): Promise<{ method: PayoutMethod | null; accountId: string | null }> {
  // Read vendor settings via the NON-tx client (settings cache is global)
  const settings = payoutSettings(await getSettings(vendorId))

  // Validate the requested method against the salary BEFORE writing anything
  const probe: ResolvedPayout = {
    method,
    account:
      method === "BANK" || method === "MFS"
        ? {
            id: "probe", bank: accountInput?.bank ?? null, branch: accountInput?.branch ?? null,
            holderName: accountInput?.holderName ?? null, accountNumber: accountInput?.accountNumber ?? null,
            routingNumber: accountInput?.routingNumber ?? null, mfsProvider: accountInput?.mfsProvider ?? null,
            mfsNumber: accountInput?.mfsNumber ?? null,
          }
        : null,
  }
  const v = validatePayout(probe, salary, settings)
  if (!v.ok) throw new Deny(v.reasons.join("; "), 400)

  // Exactly-one designated account: clear all flags first, then set the new one
  await tx.bankAccount.updateMany({ where: { employeeId }, data: { isSalaryPayoutAccount: false } })

  let accountId: string | null = null
  if ((method === "BANK" || method === "MFS") && accountInput) {
    // Upsert on the existing designated/solo account; create when none exists.
    // MERGE semantics for updates: a blank/omitted field KEEPS the stored
    // value (the edit dialog deliberately leaves masked fields blank —
    // overwriting with null would corrupt the account on unrelated edits).
    const existing = await tx.bankAccount.findMany({ where: { employeeId } })
    const target: any =
      existing.find((a: any) => a.isSalaryPayoutAccount) ??
      (existing.length === 1 ? existing[0] : existing.find((a: any) => (method === "BANK" ? a.paymentMethod === "BANK" : a.paymentMethod === "MFS")))
    const keep = (v: string | null | undefined, old: string | null): string | null =>
      v != null && String(v).trim() !== "" ? String(v).trim() : (old ?? null)
    const data = {
      holderName: keep(accountInput.holderName, target?.holderName ?? null),
      bank: method === "BANK" ? keep(accountInput.bank, target?.bank ?? null) : null,
      branch: method === "BANK" ? keep(accountInput.branch, target?.branch ?? null) : null,
      accountNumber: method === "BANK" ? keep(accountInput.accountNumber, target?.accountNumber ?? null) : null,
      routingNumber: method === "BANK" ? keep(accountInput.routingNumber, target?.routingNumber ?? null) : null,
      mfsProvider: method === "MFS" ? (accountInput.mfsProvider ?? target?.mfsProvider ?? "OTHER") : null,
      mfsNumber: method === "MFS" ? keep(accountInput.mfsNumber, target?.mfsNumber ?? null) : null,
      paymentMethod: method,
      isSalaryPayoutAccount: true,
    }
    // validate AFTER the merge: a kept existing account number satisfies the
    // "account required" rule even when the client sent it blank (masked)
    const revalidated = validatePayout(
      { method, account: { id: "probe", accountNumber: data.accountNumber, mfsNumber: data.mfsNumber, bank: data.bank, branch: data.branch, holderName: data.holderName, routingNumber: data.routingNumber, mfsProvider: data.mfsProvider } },
      salary, settings
    )
    if (!revalidated.ok) throw new Deny(revalidated.reasons.join("; "), 400)
    // F28 (P6) — encrypt at the storage boundary. piiTextForStorage passes
    // ALREADY-encrypted kept values through untouched (the merge above may
    // have kept a stored ciphertext when the client sent the field blank —
    // the edit dialog deliberately leaves masked fields blank), so this can
    // never double-encrypt. Fails closed when a NEW plaintext value is being
    // stored and no deployment key is configured.
    data.accountNumber = method === "BANK" ? piiTextForStorage(data.accountNumber) : null
    data.mfsNumber = method === "MFS" ? piiTextForStorage(data.mfsNumber) : null
    if (target) {
      const updated = await tx.bankAccount.update({ where: { id: target.id }, data })
      accountId = updated.id
    } else {
      const created = await tx.bankAccount.create({ data: { vendorId, employeeId, ...data } })
      accountId = created.id
    }
  }
  await tx.employee.update({
    where: { id: employeeId },
    data: { salaryPayoutMethod: method, salaryPayoutAccountId: accountId },
  })
  return { method, accountId }
}
