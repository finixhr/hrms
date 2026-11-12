/// <reference types="bun-types" />
// ============ FIN-020 (Phase 3) — golden cost-basis fixture ==================
// The audit: "~20 money-semantics fields remain Float (inventory/procurement/
// assets periphery), outside the paisa integer system." Exit criterion:
// "Weighted-cost math exact to the paisa (golden fixture)."
//
// The fixture pins the GL cost-basis math (the audit's "weighted-cost" family:
// receipt valuation Σ qty×cost, last-cost adjust valuation, property-issue
// valuation, disposal carrying value) to EXACT paisa with values chosen to
// drift under float — plus the writer stamping (every periphery row carries
// its *Paisa shadow from the moment it is written) and the stampPaisa
// helper's invariants.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor } from "./_fixtures"
import {
  postProcurementReceiptJournal,
  postInventoryAdjustJournal,
  postAssetIssueJournal,
  postAssetDisposalJournal,
} from "@/hrm-server/accounting"
import { stampPaisa, STOCK_ENTRY_ITEM_MONEY_FIELDS, ASSET_MONEY_FIELDS } from "@/hrm-server/money"
import { saveStockEntry, postStockEntry } from "@/hrm-server/routes/inventory"

let vendor: any, companyId: string, warehouseId: string, itemId: string
const TODAY = new Date().toISOString().slice(0, 10)
const CTX = () => ({ vendorId: vendor.id, userId: null, userName: "FIN-020 fixture", ip: null, activeCompanyId: companyId })

beforeAll(async () => {
  vendor = await mkVendor("FIN-020 Vendor", { company: false })
  const c = await db.company.create({ data: { vendorId: vendor.id, code: "F20", name: "Fin20 Co", isDefault: true, active: true } })
  companyId = c.id
  const wh = await db.warehouse.create({ data: { vendorId: vendor.id, companyId, name: "Fin20 WH" } as any })
  warehouseId = wh.id
  const item = await db.item.create({ data: { vendorId: vendor.id, companyId, code: "ITM-F20", name: "Fixture Item", unit: "Pcs", lastCost: 33.33, lastCostPaisa: 3333n } as any })
  itemId = item.id
})

describe("FIN-020 golden cost-basis math (exact to the paisa)", () => {
  test("G1: receipt valuation — 3 × Tk 33.33 = Tk 99.99 exactly (float drift trap)", async () => {
    // float would compute 3 × 33.33 = 99.98999999999998…
    const out = await postProcurementReceiptJournal(CTX() as any, {
      id: "gl1", code: "SE-F20-1", entryDate: TODAY, companyId,
      items: [{ quantity: 3, unitCost: 33.33 }],
    })
    expect(out).toHaveProperty("journalId")
    expect((out as any).amount).toBe(99.99) // EXACT — no float epsilon
    // the shadow basis is preferred when present:
    const out2 = await postProcurementReceiptJournal(CTX() as any, {
      id: "gl1b", code: "SE-F20-1b", entryDate: TODAY, companyId,
      items: [{ quantity: 3, unitCost: 0 /* ignored */, unitCostPaisa: 3333n }],
    })
    expect((out2 as any).amount).toBe(99.99)
  })

  test("G2: last-cost adjust valuation — 3 × Tk 0.10 = Tk 0.30 exactly (0.1×3 float trap)", async () => {
    const out = await postInventoryAdjustJournal(CTX() as any, { id: itemId, name: "Fixture Item", lastCost: 0.1, companyId }, 3, `adj-${Date.now()}`)
    // float 0.1 × 3 = 0.30000000000000004; the paisa path yields exactly 0.30
    expect((out as any).amount).toBe(0.3)
    // shadow-preferred basis:
    const out2 = await postInventoryAdjustJournal(CTX() as any, { id: itemId, name: "Fixture Item", lastCostPaisa: 10n, companyId }, 3, `adj2-${Date.now()}`)
    expect((out2 as any).amount).toBe(0.3)
  })

  test("G3: property-issue valuation — 7 × Tk 11.13 = Tk 77.91 exactly", async () => {
    const out = await postAssetIssueJournal(CTX() as any, { item: { id: itemId, name: "Fixture Item", companyId }, qty: 7, unitCost: 11.13, requestId: `rq-${Date.now()}` })
    expect((out as any).amount).toBe(77.91)
    const out2 = await postAssetIssueJournal(CTX() as any, { item: { id: itemId, name: "Fixture Item", companyId }, qty: 7, unitCost: 0, unitCostPaisa: 1113n, requestId: `rq2-${Date.now()}` })
    expect((out2 as any).amount).toBe(77.91)
  })

  test("G4: disposal carrying value — Tk 1234.56 exactly", async () => {
    const out = await postAssetDisposalJournal(CTX() as any, { id: `asset-${Date.now()}`, code: "AST-F20", purchaseCost: 1234.56, companyId }, "RETIRE")
    expect((out as any).amount).toBe(1234.56)
    const out2 = await postAssetDisposalJournal(CTX() as any, { id: `asset2-${Date.now()}`, code: "AST-F20b", purchaseCostPaisa: 123456n, companyId }, "LOSE")
    expect((out2 as any).amount).toBe(1234.56)
  })
})

describe("FIN-020 writer stamping (the periphery dual-write)", () => {
  test("W1: saveStockEntry + postStockEntry stamp every shadow they write", async () => {
    const entry = await saveStockEntry(CTX() as any, {
      warehouseId,
      items: [{
        itemId, itemName: "Fixture Item", quantity: 3, unitCost: 33.33,
        warrantyValue: 500.5, warrantyUnit: "MONTHS", warrantyExpiry: "2027-01-01",
        serialNumbers: JSON.stringify(["SN-F20-001"]),
      }],
    })
    // draft StockEntryItem rows carry the shadows at CREATE time
    const draftItem = await db.stockEntryItem.findFirstOrThrow({ where: { entryId: entry.id } })
    expect(draftItem.unitCostPaisa).toBe(3333n)
    expect(draftItem.warrantyValuePaisa).toBe(50050n)

    await postStockEntry(CTX() as any, entry.id)
    // the posting stamps the transaction + the item's maintained last cost…
    const tx = await db.stockTransaction.findFirstOrThrow({ where: { refId: entry.id, refType: "STOCK_ENTRY" } })
    expect(tx.unitCostPaisa).toBe(3333n)
    const item = await db.item.findUniqueOrThrow({ where: { id: itemId } })
    expect(item.lastCostPaisa).toBe(3333n)
    // …and the tracked serial
    const serial = await db.inventoryItemSerial.findFirstOrThrow({ where: { itemId } })
    expect(serial.unitCostPaisa).toBe(3333n)
    expect(serial.warrantyValuePaisa).toBe(50050n)
  })
})

describe("FIN-020 stampPaisa (pure invariants)", () => {
  test("nulls are skipped (a null warrantyValue leaves the shadow null)", () => {
    expect(stampPaisa(STOCK_ENTRY_ITEM_MONEY_FIELDS, { unitCost: 33.33, warrantyValue: null })).toEqual({ unitCostPaisa: 3333n })
  })
  test("the dual-write invariant: toPaisa(takaOf(p)) === p for every stamped value", () => {
    const stamped = stampPaisa(STOCK_ENTRY_ITEM_MONEY_FIELDS, { unitCost: 33.33, warrantyValue: 500.5 })
    expect(stamped.unitCostPaisa).toBe(3333n)
    expect(stamped.warrantyValuePaisa).toBe(50050n)
  })
  test("ASSET_MONEY_FIELDS stamps only purchaseCost", () => {
    expect(stampPaisa(ASSET_MONEY_FIELDS, { purchaseCost: 1234.56 })).toEqual({ purchaseCostPaisa: 123456n })
    expect(stampPaisa(ASSET_MONEY_FIELDS, { purchaseCost: null })).toEqual({})
  })
})
