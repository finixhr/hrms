/// <reference types="bun-types" />
// ============ Unit tests — AIT progressive slab engine (audit §I gap) ============
import { test, expect, describe } from "bun:test"
import { computeSlabTax, BD_DEFAULT_SLABS } from "@/hrm-server/ait"

describe("computeSlabTax", () => {
  test("income below the tax-free threshold pays zero", () => {
    const { tax } = computeSlabTax(300000, 350000, BD_DEFAULT_SLABS)
    expect(tax).toBe(0)
  })

  test("single-slab income is taxed at that slab's rate", () => {
    // taxable = 400000 - 350000 = 50000 over the threshold
    // BD default bands: 0-100k @5%, 100k-300k @10%
    const { tax, lines } = computeSlabTax(400000, 350000, BD_DEFAULT_SLABS)
    expect(lines).toHaveLength(1)
    expect(lines[0].rate).toBe(5)
    expect(tax).toBe(2500) // 50000 × 5%
  })

  test("multi-slab income is progressively banded", () => {
    // taxable = 100000 + 200000 = 300000 → 100k@5% + 200k@10% = 25000
    const { tax, lines } = computeSlabTax(650000, 350000, BD_DEFAULT_SLABS)
    expect(lines).toHaveLength(2)
    expect(tax).toBe(25000)
  })

  test("top band applies without ceiling", () => {
    const { tax } = computeSlabTax(5350000, 350000, BD_DEFAULT_SLABS)
    // 100k@5 + 200k@10 + 200k@15 + 300k@20 + 400k@25 + 4.8M@30 = 2,880,000... compute:
    const expected = 100000 * 0.05 + 200000 * 0.10 + 200000 * 0.15 + 300000 * 0.20 + 400000 * 0.25 + (5350000 - 350000 - 1200000) * 0.30
    expect(tax).toBe(Math.round(expected))
  })

  test("negative annual income clamps to zero taxable", () => {
    const { tax } = computeSlabTax(-50, 350000, BD_DEFAULT_SLABS)
    expect(tax).toBe(0)
  })
})
