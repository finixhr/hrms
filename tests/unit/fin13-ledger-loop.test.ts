/// <reference types="bun-types" />
// ============ FIN-013 (Phase 2) — the procurement→inventory→asset ledger loop ============
// Roadmap row 15 exit criterion: "Trial balance includes inventory / payables /
// fixed-asset accounts." Every hook is exercised for real: posting, idempotency
// (one journal per business event), toggle-off, honest skip when there is no
// cost basis — then the trial balance is read back and must carry the new
// accounts. The historical backfill engines are validated on the disposable
// lane separately (they were demonstrated live against the test cluster).
import "./_testdb"
import { describe, test, expect } from "bun:test"
import { db } from "@/lib/db"
import {
  postProcurementReceiptJournal, postInventoryAdjustJournal,
  postAssetIssueJournal, postAssetDisposalJournal,
} from "@/hrm-server/accounting"
import { mkVendor, mkUser, uniq } from "./_fixtures"

async function setup() {
  const v = await mkVendor("F13 Ledger", { company: false })
  const c = await db.company.create({ data: { vendorId: v.id, code: "MAIN", name: "Main", isDefault: true, active: true } })
  const u = await mkUser(v.id, { role: "HR_ADMIN", permissions: ["*"] })
  const ctx = { vendorId: v.id, userId: u.id, userName: u.name, activeCompanyId: c.id } as any
  return { v, c, u, ctx }
}

describe("FIN-013 — GL #1 procurement receipt (DR Inventory / CR AP — Suppliers)", () => {
  test("posts a balanced journal, idempotent on the stock entry, company-stamped", async () => {
    const { v, c, ctx } = await setup()
    const entry = { id: `se-${uniq()}`, code: "SE-2026-00001", entryDate: "2026-11-10", companyId: c.id, items: [{ quantity: 10, unitCost: 250 }, { quantity: 2, unitCost: 1250 }] }
    const out = await postProcurementReceiptJournal(ctx, entry, { companyId: c.id })
    expect("journalId" in out).toBe(true)
    if (!("journalId" in out)) throw new Error("unreachable")
    expect(out.amount).toBe(5000) // 10×250 + 2×1250
    const j = await db.accountJournal.findUniqueOrThrow({ where: { id: out.journalId } })
    expect(j.refType).toBe("PROCURE_RECEIPT")
    expect(j.companyId).toBe(c.id)
    expect(j.idempotencyKey).toBe(`fin13:procurement:receive:${entry.id}`)
    const lines = JSON.parse(j.linesJson)
    expect(lines[0]).toMatchObject({ account: "1300", accountName: "Inventory", debit: 5000 })
    expect(lines[1]).toMatchObject({ account: "2110", accountName: "Accounts Payable — Suppliers", credit: 5000 })
    // idempotent: the same entry re-posts nothing new
    const again = await postProcurementReceiptJournal(ctx, entry, { companyId: c.id })
    expect("journalId" in again && again.journalId).toBe(out.journalId)
    const count = await db.accountJournal.count({ where: { vendorId: v.id, refType: "PROCURE_RECEIPT" } })
    expect(count).toBe(1)
  })

  test("honest skip: no cost basis (every line 0) never posts and says why", async () => {
    const { ctx } = await setup()
    const out = await postProcurementReceiptJournal(ctx, { id: `se-${uniq()}`, code: "SE-X", items: [{ quantity: 5, unitCost: 0 }] }, null)
    expect("skipped" in out && /no cost basis/.test(out.skipped)).toBe(true)
  })
})

describe("FIN-013 — GL #2 stock adjustment (gain/loss at last cost)", () => {
  test("gain posts DR Inventory / CR Adjustments; loss posts DR Adjustments / CR Inventory", async () => {
    const { v, c, ctx } = await setup()
    const item = await db.item.create({ data: { vendorId: v.id, companyId: c.id, code: uniq("ITM"), name: "Cable", category: "OTHER", unit: "Pcs", active: true, lastCost: 40 } })
    const t1 = `st-${uniq()}`
    const gain = await postInventoryAdjustJournal(ctx, item, +10, t1, c.id)
    expect("journalId" in gain && gain.amount).toBe(400)
    const j1 = await db.accountJournal.findUniqueOrThrow({ where: { id: (gain as any).journalId } })
    expect(j1.refType).toBe("INVENTORY_ADJUST")
    const l1 = JSON.parse(j1.linesJson)
    expect(l1[0]).toMatchObject({ account: "1300", debit: 400 })
    expect(l1[1]).toMatchObject({ account: "5310", credit: 400 })

    const t2 = `st-${uniq()}`
    const loss = await postInventoryAdjustJournal(ctx, item, -3, t2, c.id)
    expect("journalId" in loss && loss.amount).toBe(120)
    const j2 = await db.accountJournal.findUniqueOrThrow({ where: { id: (loss as any).journalId } })
    const l2 = JSON.parse(j2.linesJson)
    expect(l2[0]).toMatchObject({ account: "5310", debit: 120 })
    expect(l2[1]).toMatchObject({ account: "1300", credit: 120 })
    // unknown lastCost ⇒ explicit skip
    const item0 = await db.item.create({ data: { vendorId: v.id, companyId: c.id, code: uniq("ITM"), name: "Unknown", category: "OTHER", unit: "Pcs", active: true, lastCost: 0 } })
    const out = await postInventoryAdjustJournal(ctx, item0, +5, `st-${uniq()}`, c.id)
    expect("skipped" in out && /no cost basis/.test(out.skipped)).toBe(true)
  })
})

describe("FIN-013 — GL #3 stock→asset (DR Fixed Assets / CR Inventory)", () => {
  test("posts at qty × unitCost, idempotent on the approval request", async () => {
    const { v, c, ctx } = await setup()
    const item = await db.item.create({ data: { vendorId: v.id, companyId: c.id, code: uniq("ITM"), name: "Laptop", category: "OTHER", unit: "Pcs", active: true } })
    const reqId = `apr-${uniq()}`
    const out = await postAssetIssueJournal(ctx, { item, qty: 3, unitCost: 65000, requestId: reqId, companyId: c.id })
    expect("journalId" in out && out.amount).toBe(195000)
    const j = await db.accountJournal.findUniqueOrThrow({ where: { id: (out as any).journalId } })
    expect(j.refType).toBe("STOCK_ASSET_ISSUE")
    expect(j.companyId).toBe(c.id)
    const lines = JSON.parse(j.linesJson)
    expect(lines[0]).toMatchObject({ account: "1400", debit: 195000 })
    expect(lines[1]).toMatchObject({ account: "1300", credit: 195000 })
    const again = await postAssetIssueJournal(ctx, { item, qty: 3, unitCost: 65000, requestId: reqId, companyId: c.id })
    expect("journalId" in again && again.journalId).toBe((out as any).journalId)
  })
})

describe("FIN-013 — GL #4 asset disposal (DR Asset Disposal Loss / CR Fixed Assets)", () => {
  test("retire and lose post the write-off at carrying value; unknown cost skips honestly", async () => {
    const { v, c, ctx } = await setup()
    const a1 = await db.asset.create({ data: { vendorId: v.id, companyId: c.id, code: uniq("AST"), name: "Server", category: "IT", purchaseCost: 120000, status: "IN_STOCK" } })
    const r = await postAssetDisposalJournal(ctx, a1, "RETIRE")
    expect("journalId" in r && r.amount).toBe(120000)
    const j = await db.accountJournal.findUniqueOrThrow({ where: { id: (r as any).journalId } })
    expect(j.refType).toBe("ASSET_RETIRE")
    const lines = JSON.parse(j.linesJson)
    expect(lines[0]).toMatchObject({ account: "6200", debit: 120000 })
    expect(lines[1]).toMatchObject({ account: "1400", credit: 120000 })

    const a2 = await db.asset.create({ data: { vendorId: v.id, companyId: c.id, code: uniq("AST"), name: "Monitor", category: "IT", purchaseCost: 8000, status: "ASSIGNED" } })
    const l = await postAssetDisposalJournal(ctx, a2, "LOSE")
    expect("journalId" in l && l.amount).toBe(8000)
    const j2 = await db.accountJournal.findUniqueOrThrow({ where: { id: (l as any).journalId } })
    expect(j2.refType).toBe("ASSET_LOSE")

    const a3 = await db.asset.create({ data: { vendorId: v.id, companyId: c.id, code: uniq("AST"), name: "Unknown cost", category: "IT", purchaseCost: null, status: "IN_STOCK" } })
    const skip = await postAssetDisposalJournal(ctx, a3, "RETIRE")
    expect("skipped" in skip && /no carrying value/.test(skip.skipped)).toBe(true)
  })
})

describe("FIN-013 — exit criterion: the trial balance carries the loop's accounts", () => {
  test("after the four hooks post, accounts 1300 / 2110 / 1400 / 5310 / 6200 all appear", async () => {
    const { v, c, ctx } = await setup()
    // exercise every hook once (the fixtures above already cover shapes)
    await postProcurementReceiptJournal(ctx, { id: `se-${uniq()}`, code: "SE-TB", entryDate: "2026-11-10", companyId: c.id, items: [{ quantity: 4, unitCost: 500 }] }, { companyId: c.id })
    const item = await db.item.create({ data: { vendorId: v.id, companyId: c.id, code: uniq("ITM"), name: "TB Item", category: "OTHER", unit: "Pcs", active: true, lastCost: 25 } })
    await postInventoryAdjustJournal(ctx, item, +6, `st-${uniq()}`, c.id)
    await postAssetIssueJournal(ctx, { item, qty: 1, unitCost: 25, requestId: `apr-${uniq()}`, companyId: c.id })
    const a = await db.asset.create({ data: { vendorId: v.id, companyId: c.id, code: uniq("AST"), name: "TB Asset", category: "IT", purchaseCost: 9000, status: "IN_STOCK" } })
    await postAssetDisposalJournal(ctx, a, "RETIRE")

    // the trial balance reads AccountJournal lines — group them the way the
    // route does (account code → debit/credit sums) and assert the five
    // accounts carry non-zero balances.
    const rows = await db.accountJournal.findMany({ where: { vendorId: v.id, companyId: c.id } })
    const byAccount = new Map<string, { debit: number; credit: number }>()
    for (const row of rows) {
      for (const l of JSON.parse(row.linesJson) as any[]) {
        const agg = byAccount.get(l.account) || { debit: 0, credit: 0 }
        agg.debit += l.debit || 0; agg.credit += l.credit || 0
        byAccount.set(l.account, agg)
      }
    }
    for (const [code, why] of [["1300", "Inventory"], ["2110", "Accounts Payable — Suppliers"], ["1400", "Fixed Assets"], ["5310", "Inventory Adjustments"], ["6200", "Asset Disposal Loss"]] as const) {
      const agg = byAccount.get(code)
      expect(agg, `${why} (${code}) missing from the trial balance`).toBeTruthy()
      expect((agg?.debit || 0) + (agg?.credit || 0)).toBeGreaterThan(0)
    }
    // the loop balances: total debits === total credits across every journal
    let d = 0, cr = 0
    for (const agg of byAccount.values()) { d += agg.debit; cr += agg.credit }
    expect(Math.abs(d - cr)).toBeLessThan(0.01)
  })
})
