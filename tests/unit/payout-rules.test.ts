/// <reference types="bun-types" />
// ============ Unit tests — salary payout rules (2026-10 round §42–§47, §78, §81) ============
// The threshold matrix from the requirements: 9,000 / 10,000 / 10,001 / 15,000
// against a ৳10,000 ceiling with all methods enabled.
import { test, expect, describe } from "bun:test"
import { validatePayout, PAYOUT_METHODS, type PayoutSettings, type ResolvedPayout } from "@/hrm-server/payout"

const SETTINGS: PayoutSettings = {
  bankEnabled: true, cashEnabled: true, mfsEnabled: true,
  maxCashMfsSalary: 10_000, thresholdBasis: "GROSS",
}

const bankAccount = (over: Partial<ResolvedPayout["account"]> = {}): NonNullable<ResolvedPayout["account"]> => ({
  id: "acc1", bank: "BRAC Bank", branch: "Gulshan", holderName: "Rahim Miah",
  accountNumber: "1701204578412003", routingNumber: "060330204",
  mfsProvider: null, mfsNumber: null, ...over,
})
const mfsAccount = bankAccount({ accountNumber: null, routingNumber: null, bank: null, branch: null, mfsProvider: "BKASH", mfsNumber: "01712345678" })

describe("payout threshold matrix (§45 / §81)", () => {
  test("salary 9,000 → BANK ✓ CASH ✓ MFS ✓", () => {
    for (const method of PAYOUT_METHODS) {
      const payout: ResolvedPayout = { method, account: method === "CASH" ? null : method === "MFS" ? mfsAccount : bankAccount() }
      const v = validatePayout(payout, 9_000, SETTINGS)
      expect(v.ok).toBe(true)
      expect(v.reasons).toHaveLength(0)
    }
  })

  test("salary exactly 10,000 (== threshold) → still allowed (<= semantics)", () => {
    for (const method of PAYOUT_METHODS) {
      const payout: ResolvedPayout = { method, account: method === "CASH" ? null : method === "MFS" ? mfsAccount : bankAccount() }
      expect(validatePayout(payout, 10_000, SETTINGS).ok).toBe(true)
    }
  })

  test("salary 10,001 → CASH ✗ MFS ✗ BANK ✓ (bank-only above the ceiling)", () => {
    expect(validatePayout({ method: "CASH", account: null }, 10_001, SETTINGS).ok).toBe(false)
    expect(validatePayout({ method: "MFS", account: mfsAccount }, 10_001, SETTINGS).ok).toBe(false)
    expect(validatePayout({ method: "BANK", account: bankAccount() }, 10_001, SETTINGS).ok).toBe(true)
  })

  test("salary 15,000 → CASH ✗ MFS ✗ BANK ✓ with actionable messages (§87)", () => {
    const cash = validatePayout({ method: "CASH", account: null }, 15_000, SETTINGS)
    expect(cash.ok).toBe(false)
    expect(cash.reasons[0]).toContain("not allowed above ৳10,000")
    const mfs = validatePayout({ method: "MFS", account: mfsAccount }, 15_000, SETTINGS)
    expect(mfs.ok).toBe(false)
    expect(mfs.reasons[0]).toContain("MFS payout is not allowed above")
    const bank = validatePayout({ method: "BANK", account: bankAccount() }, 15_000, SETTINGS)
    expect(bank.ok).toBe(true)
  })
})

describe("method enablement + account requirements (§43–§44)", () => {
  test("cash disabled blocks cash payout below the ceiling", () => {
    const v = validatePayout({ method: "CASH", account: null }, 5_000, { ...SETTINGS, cashEnabled: false })
    expect(v.ok).toBe(false)
    expect(v.reasons[0]).toContain("Cash payout is disabled")
  })

  test("bank payout without an account number is rejected (§87 message)", () => {
    const v = validatePayout({ method: "BANK", account: bankAccount({ accountNumber: null }) }, 5_000, SETTINGS)
    expect(v.ok).toBe(false)
    expect(v.reasons[0]).toContain("Bank account information is required for Bank payout")
  })

  test("MFS payout without an MFS number is rejected", () => {
    const v = validatePayout({ method: "MFS", account: bankAccount({ accountNumber: null, routingNumber: null, bank: null, branch: null, mfsProvider: "BKASH", mfsNumber: null }) }, 5_000, SETTINGS)
    expect(v.ok).toBe(false)
    expect(v.reasons[0]).toContain("MFS account number is required")
  })

  test("mfs disabled blocks MFS even below the ceiling", () => {
    const v = validatePayout({ method: "MFS", account: mfsAccount }, 5_000, { ...SETTINGS, mfsEnabled: false })
    expect(v.ok).toBe(false)
    expect(v.reasons[0]).toContain("MFS payout is disabled")
  })
})

describe("legacy employees (unconfigured method, §84 backfill semantics)", () => {
  test("null method + small salary → treated as CASH and allowed (backward compatible)", () => {
    const v = validatePayout({ method: null, account: null }, 8_000, SETTINGS)
    expect(v.ok).toBe(true)
    expect(v.method).toBe("CASH")
    expect(v.warnings).toContain("Payout method is not configured")
  })

  test("null method + salary above the ceiling → BLOCKED until configured (§78)", () => {
    const v = validatePayout({ method: null, account: null }, 15_000, SETTINGS)
    expect(v.ok).toBe(false)
    expect(v.reasons[0]).toContain("Payout method must be configured")
  })

  test("null method + cash disabled → blocked with a clear reason", () => {
    const v = validatePayout({ method: null, account: null }, 5_000, { ...SETTINGS, cashEnabled: false })
    expect(v.ok).toBe(false)
    expect(v.reasons[0]).toContain("Cash payout is disabled")
  })
})

describe("threshold basis (§45)", () => {
  test("NET basis compares against the net salary", () => {
    const netSettings = { ...SETTINGS, thresholdBasis: "NET" as const }
    // gross 15,000 but net 9,500 → MFS allowed under NET basis
    expect(validatePayout({ method: "MFS", account: mfsAccount }, 9_500, netSettings).ok).toBe(true)
    expect(validatePayout({ method: "MFS", account: mfsAccount }, 11_000, netSettings).ok).toBe(false)
  })
})
