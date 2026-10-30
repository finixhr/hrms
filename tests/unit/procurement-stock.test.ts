// ============ Unit tests — procurement stock math + payload sanitization ============
// Covers the pure helpers in src/hrm-server/procurement-lib.ts used by the
// stock gate, purchase requests and quotations (module spec §4/§5/§6/§23).
import { describe, expect, test } from "bun:test"
import {
  computeShortage, computeRemaining, quotationLineTotal,
  sanitizeRequisitionItems, parseSerials, reqStatusMeta, prStatusMeta,
} from "../../src/hrm-server/procurement-lib"

describe("computeShortage (spec §4 — only the shortage needs procurement)", () => {
  test("full availability → no shortage", () => {
    expect(computeShortage(5, 5)).toBe(0)
    expect(computeShortage(5, 9)).toBe(0)
  })
  test("unavailable → full shortage", () => {
    expect(computeShortage(5, 0)).toBe(5)
  })
  test("partial availability → remaining shortage (spec example: 5 requested, 2 available → 3)", () => {
    expect(computeShortage(5, 2)).toBe(3)
    expect(computeShortage(10, 6)).toBe(4)
  })
  test("negative available is clamped", () => {
    expect(computeShortage(3, -4)).toBe(3)
  })
  test("rounding — fractional quantities settle to 2 decimals", () => {
    expect(computeShortage(10.005, 3.5)).toBeCloseTo(6.51, 1)
  })
})

describe("computeRemaining (approved vs issued)", () => {
  test("nothing issued → remaining is the approved target", () => {
    expect(computeRemaining(null, 5, 0)).toBe(5)
    expect(computeRemaining(3, 5, 0)).toBe(3)
  })
  test("partially issued (partial mode §15)", () => {
    expect(computeRemaining(10, 10, 6)).toBe(4)
  })
  test("fully issued → zero", () => {
    expect(computeRemaining(10, 10, 10)).toBe(0)
    expect(computeRemaining(10, 10, 12)).toBe(0) // never negative
  })
})

describe("quotationLineTotal (spec §6 — qty × unitPrice − discount + VAT)", () => {
  test("plain line", () => {
    expect(quotationLineTotal(2, 5000, 0, 0)).toBe(10000)
  })
  test("discount and VAT applied", () => {
    expect(quotationLineTotal(2, 5000, 1000, 500)).toBe(9500)
  })
  test("never negative", () => {
    expect(quotationLineTotal(1, 100, 500, 0)).toBe(0)
  })
})

describe("sanitizeRequisitionItems (spec §23 — server-side validation)", () => {
  test("valid lines pass through with normalization", () => {
    const out = sanitizeRequisitionItems([
      { itemName: "Laptop", itemCategory: "IT_EQUIPMENT", itemId: "i1", specification: "i5", unit: "Pcs", quantityRequested: 2 },
      { name: "A4 Paper", qty: 3 }, // legacy field names from the client
    ])
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ itemName: "Laptop", itemId: "i1", quantityRequested: 2, unit: "Pcs" })
    expect(out[1]).toMatchObject({ itemName: "A4 Paper", itemId: null, quantityRequested: 3, unit: "Pcs" })
  })
  test("unknown category falls back to OTHER", () => {
    const out = sanitizeRequisitionItems([{ itemName: "X", itemCategory: "WEIRD", quantityRequested: 1 }])
    expect(out[0].itemCategory).toBe("OTHER")
  })
  test("zero / negative quantity is rejected (spec §23: requested quantity must be > 0)", () => {
    expect(() => sanitizeRequisitionItems([{ itemName: "X", quantityRequested: 0 }])).toThrow()
    expect(() => sanitizeRequisitionItems([{ itemName: "X", quantityRequested: -2 }])).toThrow()
    expect(() => sanitizeRequisitionItems([{ itemName: "X", quantityRequested: "abc" }])).toThrow()
  })
  test("empty list is rejected", () => {
    expect(() => sanitizeRequisitionItems([])).toThrow()
    expect(() => sanitizeRequisitionItems(undefined)).toThrow()
  })
  test("lines without a name are skipped, long text is trimmed", () => {
    const out = sanitizeRequisitionItems([
      { quantityRequested: 1 },
      { itemName: "Y".repeat(300), quantityRequested: 1 },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].itemName.length).toBeLessThanOrEqual(120)
  })
})

describe("parseSerials (serialized assets, spec §8)", () => {
  test("comma-separated string", () => {
    expect(parseSerials("SN-001, SN-002,,")).toEqual(["SN-001", "SN-002"])
  })
  test("newline-separated string", () => {
    expect(parseSerials("SN-001\nSN-002\n ")).toEqual(["SN-001", "SN-002"])
  })
  test("array passthrough + empty input", () => {
    expect(parseSerials(["A", " B "])).toEqual(["A", "B"])
    expect(parseSerials("")).toEqual([])
    expect(parseSerials(null)).toEqual([])
  })
})

describe("status metadata (UI tone + label)", () => {
  test("every requisition status resolves to a friendly label", () => {
    for (const s of ["DRAFT", "PENDING_APPROVAL", "PENDING_STOCK", "STOCK_AVAILABLE", "PARTIALLY_FULFILLED", "PENDING_RECEIPT_CONFIRMATION", "COMPLETED", "REJECTED", "RETURNED", "CANCELLED", "RECEIPT_DISPUTED"]) {
      const m = reqStatusMeta(s)
      expect(m.label).not.toBe(s)
      expect(m.tone).toBeTruthy()
    }
  })
  test("unknown statuses degrade gracefully", () => {
    expect(reqStatusMeta("SOMETHING").label).toBe("SOMETHING")
    expect(prStatusMeta("SOMETHING").label).toBe("SOMETHING")
  })
  test("purchase request statuses", () => {
    expect(prStatusMeta("QUOTATION_COLLECTION").label).toBe("Quotation Collection")
    expect(prStatusMeta("PENDING_STOCK_ENTRY").label).toBe("Pending Stock Entry")
  })
})
