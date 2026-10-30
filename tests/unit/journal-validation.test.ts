/// <reference types="bun-types" />
// ============ Unit tests — accounting journal validation (audit M-4) ============
// H-9 (step 5) — tolerance is ৳0.00: entries must balance to the paisa.
// Sub-paisa float noise is absorbed; paisa-level imbalance is rejected.
import { test, expect, describe } from "bun:test"
import { validateAndBalanceLines } from "@/hrm-server/accounting"

describe("validateAndBalanceLines (M-4 / H-9 zero tolerance)", () => {
  test("balanced entry passes and is returned as a copy", () => {
    const lines = [
      { account: "5100", accountName: "Salary", debit: 100 },
      { account: "2100", accountName: "Payable", credit: 100 },
    ]
    const out = validateAndBalanceLines(lines)
    expect(out).toHaveLength(2)
    expect(out[0]).not.toBe(lines[0]) // copy, never the caller's array
    expect(out[0].debit).toBe(100)
  })

  test("paisa-precision balanced entry passes (100.25 vs 60.25 + 40)", () => {
    const out = validateAndBalanceLines([
      { account: "5100", accountName: "Salary", debit: 100.25 },
      { account: "2100", accountName: "Payable", credit: 60.25 },
      { account: "2150", accountName: "PF", credit: 40 },
    ])
    expect(out[0].debit).toBe(100.25)
  })

  test("sub-paisa float noise is paisa-normalized, not plug-patched (L-5)", () => {
    // 0.4 paisa of float noise: each line normalizes to its paisa value
    // (100.004 → 100.00), so the sums are exact integers and the entry
    // balances with NO reject and NO plug mutation of the counter-line
    const lines = [
      { account: "5100", accountName: "Salary", debit: 100.004 },
      { account: "2100", accountName: "Payable", credit: 100 },
    ]
    const out = validateAndBalanceLines(lines)
    expect(out[0].debit).toBe(100) // normalized to the paisa
    expect(out[1].credit).toBe(100) // untouched — nothing to plug
    expect(lines[1].credit).toBe(100) // caller's array untouched
    expect(lines[0].debit).toBe(100.004) // caller's array untouched
  })

  test("H-9: imbalance that used to pass the ৳0.50 tolerance is now REJECTED", () => {
    // 30 paisa — previously auto-balanced under the 0.50 tolerance
    const lines = [
      { account: "5100", accountName: "Salary", debit: 100.30 },
      { account: "2100", accountName: "Payable", credit: 100 },
    ]
    expect(() => validateAndBalanceLines(lines)).toThrow(/unbalanced/)
  })

  test("imbalance of whole taka is rejected", () => {
    const lines = [
      { account: "5100", accountName: "Salary", debit: 100 },
      { account: "2100", accountName: "Payable", credit: 90 },
    ]
    expect(() => validateAndBalanceLines(lines)).toThrow(/unbalanced/)
  })

  test("one-sided entries are rejected (debit only)", () => {
    expect(() => validateAndBalanceLines([{ account: "5100", accountName: "Salary", debit: 100 }]))
      .toThrow(/one-sided/)
  })

  test("one-sided entries are rejected (credit only)", () => {
    expect(() => validateAndBalanceLines([{ account: "2100", accountName: "Payable", credit: 100 }]))
      .toThrow(/one-sided/)
  })

  test("empty line sets are rejected", () => {
    expect(() => validateAndBalanceLines([])).toThrow(/no lines/)
  })
})
