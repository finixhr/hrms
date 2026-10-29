// ============ Stock Inventory routes — items, warehouses, stock levels ============
// Spec §16: stock quantities NEVER move without a corresponding
// StockTransaction row (previousQty/newQty captured). All mutations happen
// inside database transactions so concurrent operations cannot corrupt
// quantities or produce partial updates.
import { db } from "@/lib/db"
import { z } from "zod"
import { route } from "./registry"
import { Deny, can, assertEmployeeVisible } from "../rbac"
import { submitForApproval, type ApprovalRequestView } from "../approval"
import type { Ctx } from "../types"
import { audit, notify } from "../audit"
import { safePayload } from "../security"
import { nextFormattedSeq, today } from "../utils"
import { id, textOpt } from "../validation"

const ITEM_CATEGORIES = ["IT", "FURNITURE", "STATIONERY", "ELECTRICAL", "OTHER"]

// ---------- items ----------

route("inventory.items.list", {
  perm: ["inventory", "view"],
  handler: async (ctx, p) => {
    const where: any = { vendorId: ctx.vendorId }
    if (p?.category) where.category = p.category
    if (p?.active === false) where.active = false
    if (p?.q) where.name = { contains: p.q, mode: "insensitive" } // ILIKE — preserves SQLite search behavior on PG
    const [items, levels, pendingIssue] = await Promise.all([
      db.item.findMany({ where, orderBy: { name: "asc" } }),
      db.stockLevel.findMany({ where: { vendorId: ctx.vendorId } }),
      pendingIssueQtyByItem(ctx.vendorId),
    ])
    return items.map((it) => {
      const mine = levels.filter((l) => l.itemId === it.id)
      const onHand = mine.reduce((s, l) => s + l.quantity, 0)
      const reserved = mine.reduce((s, l) => s + l.reserved, 0)
      const available = onHand - reserved
      const pendingQty = pendingIssue.get(it.id) || 0
      return {
        ...it,
        onHand,
        reserved,
        available,
        // asset-issue requests waiting for approval count as unavailable —
        // the requester is already counting on that stock
        pendingIssue: pendingQty,
        issueable: Math.max(0, available - pendingQty),
        byWarehouse: mine.filter((l) => l.quantity > 0 || l.reserved > 0),
      }
    })
  },
})

async function nextItemCode(vendorId: string): Promise<string> {
  const key = `${vendorId}:item-code`
  const counter = await db.sequenceCounter.findUnique({ where: { key } })
  if (!counter) {
    const items = await db.item.findMany({
      where: { vendorId, code: { startsWith: "ITM-" } },
      select: { code: true },
    })
    let maxNum = 0
    for (const it of items) {
      const num = parseInt(it.code.replace(/^ITM-/, ""), 10)
      if (!isNaN(num) && num > maxNum) maxNum = num
    }
    await db.sequenceCounter.upsert({
      where: { key },
      create: { key, value: maxNum },
      update: { value: { set: maxNum } },
    })
  }

  for (let attempt = 0; attempt < 10; attempt++) {
    const code = await nextFormattedSeq(vendorId, "item-code", (n) => `ITM-${String(n).padStart(4, "0")}`)
    const dupe = await db.item.findFirst({ where: { vendorId, code } })
    if (!dupe) return code
  }
  throw new Deny("Could not allocate a unique item code — try again", 500)
}

route("inventory.items.nextCode", {
  perm: ["inventory", "view"],
  handler: async (ctx) => {
    const key = `${ctx.vendorId}:item-code`
    const counter = await db.sequenceCounter.findUnique({ where: { key } })
    let currentVal = counter?.value ?? 0
    if (!counter) {
      const items = await db.item.findMany({
        where: { vendorId: ctx.vendorId, code: { startsWith: "ITM-" } },
        select: { code: true },
      })
      for (const it of items) {
        const num = parseInt(it.code.replace(/^ITM-/, ""), 10)
        if (!isNaN(num) && num > currentVal) currentVal = num
      }
    }
    return { nextCode: `ITM-${String(currentVal + 1).padStart(4, "0")}` }
  },
})

route("inventory.items.save", {
  perm: ["inventory", "edit"],
  handler: async (ctx, p) => {
    const data = safePayload<any>(
      p,
      [
        "code", "name", "category", "unit", "lastCost", "reorderLevel", "active",
        "brandModel", "serialImei", "purchaseDate", "hasWarranty", "warrantyExpiry", "isReturnable",
      ],
      { numericFields: ["lastCost", "reorderLevel"], boolFields: ["active", "hasWarranty", "isReturnable"] }
    )
    if (!data.name) throw new Deny("Item name is required")
    if (!data.category) data.category = "OTHER"
    if (p.unitCost !== undefined && (p.lastCost === undefined || p.lastCost === null)) {
      data.lastCost = Number(p.unitCost || 0)
    }
    if (!data.hasWarranty) {
      data.warrantyExpiry = null
    }

    let rec
    if (p.id) {
      const existing = await db.item.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
      if (!existing) throw new Deny("Item not found", 404)
      // Item code is locked for entry — preserve existing code
      const { code: _ignored, ...updateData } = data
      rec = await db.item.update({ where: { id: p.id }, data: updateData })
      await audit(ctx, "inventory.items.update", "Item", rec.id, `Updated item ${rec.name}`, { oldValue: existing, newValue: updateData })
    } else {
      // Item code is auto-generated and locked for entry
      const code = await nextItemCode(ctx.vendorId)
      rec = await db.item.create({ data: { ...data, code, vendorId: ctx.vendorId } })
      await audit(ctx, "inventory.items.create", "Item", rec.id, `Created item ${rec.name} (${code})`)
    }
    return rec
  },
})

route("inventory.items.delete", {
  perm: ["inventory", "edit"],
  handler: async (ctx, p) => {
    const existing = await db.item.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!existing) throw new Deny("Item not found", 404)
    const used = await db.stockLevel.count({ where: { itemId: existing.id, quantity: { not: 0 } } })
    const inTx = await db.stockTransaction.count({ where: { itemId: existing.id } })
    if (used > 0) throw new Deny("Item still has stock on hand — adjust stock to zero first")
    if (inTx > 0) throw new Deny("Item has transaction history — deactivate it instead of deleting (audit integrity, §21)")
    await db.item.delete({ where: { id: existing.id } })
    await audit(ctx, "inventory.items.delete", "Item", existing.id, `Deleted item ${existing.name}`)
    return { ok: true }
  },
})

// ---------- categories ----------

const DEFAULT_CATEGORIES = [
  { name: "IT", description: "Computer, Laptop & IT Equipment" },
  { name: "FURNITURE", description: "Desk, Chair & Office Furniture" },
  { name: "STATIONERY", description: "Paper, Pens & Stationery Supplies" },
  { name: "ELECTRICAL", description: "Electrical, Lights & Appliances" },
  { name: "OTHER", description: "General & Miscellaneous Items" },
]

route("inventory.categories.list", {
  perm: ["inventory", "view"],
  handler: async (ctx) => {
    let list = await db.itemCategory.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { name: "asc" } })
    if (list.length === 0) {
      for (const def of DEFAULT_CATEGORIES) {
        await db.itemCategory.create({
          data: { vendorId: ctx.vendorId, name: def.name, description: def.description, active: true },
        })
      }
      list = await db.itemCategory.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { name: "asc" } })
    }
    const items = await db.item.findMany({ where: { vendorId: ctx.vendorId }, select: { category: true } })
    const counts = new Map<string, number>()
    for (const it of items) {
      if (it.category) counts.set(it.category.toUpperCase(), (counts.get(it.category.toUpperCase()) || 0) + 1)
    }
    return list.map((c) => ({
      ...c,
      itemCount: counts.get(c.name.toUpperCase()) || 0,
    }))
  },
})

route("inventory.categories.save", {
  perm: ["inventory", "edit"],
  handler: async (ctx, p) => {
    const data = safePayload<any>(p, ["name", "description", "active"], { boolFields: ["active"] })
    if (!data.name?.trim()) throw new Deny("Category name is required")
    data.name = data.name.trim()
    const dupe = await db.itemCategory.findFirst({
      where: { vendorId: ctx.vendorId, name: { equals: data.name, mode: "insensitive" }, ...(p.id ? { id: { not: p.id } } : {}) },
    })
    if (dupe) throw new Deny(`Category "${data.name}" already exists`)
    let rec
    if (p.id) {
      const existing = await db.itemCategory.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
      if (!existing) throw new Deny("Category not found", 404)
      rec = await db.itemCategory.update({ where: { id: p.id }, data })
      await audit(ctx, "inventory.categories.update", "ItemCategory", rec.id, `Updated category ${rec.name}`)
    } else {
      rec = await db.itemCategory.create({ data: { ...data, vendorId: ctx.vendorId } })
      await audit(ctx, "inventory.categories.create", "ItemCategory", rec.id, `Created category ${rec.name}`)
    }
    return rec
  },
})

route("inventory.categories.delete", {
  perm: ["inventory", "edit"],
  handler: async (ctx, p) => {
    const existing = await db.itemCategory.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!existing) throw new Deny("Category not found", 404)
    const inUse = await db.item.count({
      where: { vendorId: ctx.vendorId, category: { equals: existing.name, mode: "insensitive" } },
    })
    if (inUse > 0) throw new Deny(`Category "${existing.name}" is used by ${inUse} item(s) — deactivate it instead`)
    await db.itemCategory.delete({ where: { id: existing.id } })
    await audit(ctx, "inventory.categories.delete", "ItemCategory", existing.id, `Deleted category ${existing.name}`)
    return { ok: true }
  },
})

// ---------- units ----------

const DEFAULT_UNITS = [
  { name: "Pieces", symbol: "Pcs" },
  { name: "Box", symbol: "Box" },
  { name: "Packet", symbol: "Pkt" },
  { name: "Ream", symbol: "Ream" },
  { name: "Kilogram", symbol: "Kg" },
  { name: "Gram", symbol: "g" },
  { name: "Meter", symbol: "m" },
  { name: "Roll", symbol: "Roll" },
  { name: "Set", symbol: "Set" },
  { name: "Pair", symbol: "Pair" },
  { name: "Litre", symbol: "Ltr" },
  { name: "Dozen", symbol: "Dzn" },
]

route("inventory.units.list", {
  perm: ["inventory", "view"],
  handler: async (ctx) => {
    let list = await db.itemUnit.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { name: "asc" } })
    if (list.length === 0) {
      for (const def of DEFAULT_UNITS) {
        await db.itemUnit.create({
          data: { vendorId: ctx.vendorId, name: def.name, symbol: def.symbol, active: true },
        })
      }
      list = await db.itemUnit.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { name: "asc" } })
    }
    const items = await db.item.findMany({ where: { vendorId: ctx.vendorId }, select: { unit: true } })
    const counts = new Map<string, number>()
    for (const it of items) {
      if (it.unit) counts.set(it.unit.toLowerCase(), (counts.get(it.unit.toLowerCase()) || 0) + 1)
    }
    return list.map((u) => ({
      ...u,
      itemCount: counts.get(u.name.toLowerCase()) || (u.symbol ? counts.get(u.symbol.toLowerCase()) || 0 : 0),
    }))
  },
})

route("inventory.units.save", {
  perm: ["inventory", "edit"],
  handler: async (ctx, p) => {
    const data = safePayload<any>(p, ["name", "symbol", "active"], { boolFields: ["active"] })
    if (!data.name?.trim()) throw new Deny("Unit name is required")
    data.name = data.name.trim()
    if (data.symbol) data.symbol = data.symbol.trim()
    const dupe = await db.itemUnit.findFirst({
      where: { vendorId: ctx.vendorId, name: { equals: data.name, mode: "insensitive" }, ...(p.id ? { id: { not: p.id } } : {}) },
    })
    if (dupe) throw new Deny(`Unit "${data.name}" already exists`)
    let rec
    if (p.id) {
      const existing = await db.itemUnit.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
      if (!existing) throw new Deny("Unit not found", 404)
      rec = await db.itemUnit.update({ where: { id: p.id }, data })
      await audit(ctx, "inventory.units.update", "ItemUnit", rec.id, `Updated unit ${rec.name}`)
    } else {
      rec = await db.itemUnit.create({ data: { ...data, vendorId: ctx.vendorId } })
      await audit(ctx, "inventory.units.create", "ItemUnit", rec.id, `Created unit ${rec.name}`)
    }
    return rec
  },
})

route("inventory.units.delete", {
  perm: ["inventory", "edit"],
  handler: async (ctx, p) => {
    const existing = await db.itemUnit.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!existing) throw new Deny("Unit not found", 404)
    const orConditions: any[] = [{ unit: { equals: existing.name, mode: "insensitive" } }]
    if (existing.symbol) {
      orConditions.push({ unit: { equals: existing.symbol, mode: "insensitive" } })
    }
    const inUse = await db.item.count({
      where: {
        vendorId: ctx.vendorId,
        OR: orConditions,
      },
    })
    if (inUse > 0) throw new Deny(`Unit "${existing.name}" is used by ${inUse} item(s) — deactivate it instead`)
    await db.itemUnit.delete({ where: { id: existing.id } })
    await audit(ctx, "inventory.units.delete", "ItemUnit", existing.id, `Deleted unit ${existing.name}`)
    return { ok: true }
  },
})

// ---------- warehouses ----------

route("inventory.warehouses.list", {
  perm: ["inventory", "view"],
  handler: async (ctx) => {
    return db.warehouse.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { name: "asc" } })
  },
})

route("inventory.warehouses.save", {
  perm: ["inventory", "edit"],
  handler: async (ctx, p) => {
    const data = safePayload<any>(p, ["name", "code", "branchId", "address", "active"], { boolFields: ["active"] })
    if (!data.name) throw new Deny("Warehouse name is required")
    let rec
    if (p.id) {
      const existing = await db.warehouse.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
      if (!existing) throw new Deny("Warehouse not found", 404)
      rec = await db.warehouse.update({ where: { id: p.id }, data })
      await audit(ctx, "inventory.warehouses.update", "Warehouse", rec.id, `Updated warehouse ${rec.name}`)
    } else {
      rec = await db.warehouse.create({ data: { ...data, vendorId: ctx.vendorId } })
      await audit(ctx, "inventory.warehouses.create", "Warehouse", rec.id, `Created warehouse ${rec.name}`)
    }
    return rec
  },
})

// ---------- suppliers ----------

route("inventory.suppliers.list", {
  perm: ["inventory", "view"],
  handler: async (ctx) => {
    return db.supplier.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { name: "asc" } })
  },
})

route("inventory.suppliers.save", {
  perm: ["inventory", "edit"],
  handler: async (ctx, p) => {
    const data = safePayload<any>(p, ["name", "contactPerson", "mobile", "email", "address", "tin", "active"], { boolFields: ["active"] })
    if (!data.name) throw new Deny("Supplier name is required")
    let rec
    if (p.id) {
      const existing = await db.supplier.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
      if (!existing) throw new Deny("Supplier not found", 404)
      rec = await db.supplier.update({ where: { id: p.id }, data })
      await audit(ctx, "inventory.suppliers.update", "Supplier", rec.id, `Updated supplier ${rec.name}`)
    } else {
      rec = await db.supplier.create({ data: { ...data, vendorId: ctx.vendorId } })
      await audit(ctx, "inventory.suppliers.create", "Supplier", rec.id, `Created supplier ${rec.name}`)
    }
    return rec
  },
})

// ---------- stock overview (the dashboard the HRM opens first) ----------

route("inventory.stock.overview", {
  perm: ["inventory", "view"],
  handler: async (ctx) => {
    const [items, levels, warehouses, txs, pendingIssue] = await Promise.all([
      db.item.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { name: "asc" } }),
      db.stockLevel.findMany({ where: { vendorId: ctx.vendorId } }),
      db.warehouse.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { name: "asc" } }),
      db.stockTransaction.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { createdAt: "desc" }, take: 500 }),
      pendingIssueQtyByItem(ctx.vendorId),
    ])
    const itemMap = new Map(items.map((i) => [i.id, i]))
    const warehouseMap = new Map(warehouses.map((w) => [w.id, w]))
    const overview = items.map((it) => {
      const mine = levels.filter((l) => l.itemId === it.id)
      const onHand = mine.reduce((s, l) => s + l.quantity, 0)
      const reserved = mine.reduce((s, l) => s + l.reserved, 0)
      const available = onHand - reserved
      const pendingQty = pendingIssue.get(it.id) || 0
      return {
        ...it,
        onHand, reserved, available,
        pendingIssue: pendingQty,
        issueable: Math.max(0, available - pendingQty),
        low: onHand <= it.reorderLevel,
        byWarehouse: mine.filter((l) => l.quantity > 0 || l.reserved > 0).map((l) => {
          const wh = warehouseMap.get(l.warehouseId)
          return {
            warehouseId: l.warehouseId,
            warehouseName: wh?.name || "Warehouse",
            quantity: l.quantity,
            reserved: l.reserved,
            available: Math.max(0, l.quantity - l.reserved),
          }
        }),
      }
    })
    return {
      items: overview,
      levels,
      warehouses,
      transactions: txs.map((t) => {
        const it = itemMap.get(t.itemId)
        const wh = warehouseMap.get(t.warehouseId)
        const prevQty = t.balanceAfter != null ? Math.round((t.balanceAfter - t.quantity) * 1000) / 1000 : null
        return {
          ...t,
          type: t.kind,
          itemName: it?.name || "—",
          itemCode: it?.code || "",
          itemUnit: it?.unit || "Pcs",
          itemCategory: it?.category || "—",
          warehouseName: wh?.name || "—",
          previousQty: prevQty,
          newQty: t.balanceAfter,
          referenceType: t.refType,
          referenceNo: t.refId,
          userName: t.byUserName || "system",
          remarks: t.note,
        }
      }),
      summary: {
        itemCount: items.length,
        totalOnHand: overview.reduce((s, i) => s + i.onHand, 0),
        totalValue: overview.reduce((s, i) => s + i.onHand * i.lastCost, 0),
        lowStock: overview.filter((i) => i.low && i.active).length,
        entryCount: txs.filter((t) => t.kind === "ENTRY").length,
        issueCount: txs.filter((t) => t.kind === "ISSUE").length,
      },
    }
  },
})

// ---------- stock transactions ledger ----------

route("inventory.transactions.list", {
  perm: ["inventory", "view"],
  handler: async (ctx, p) => {
    const where: any = { vendorId: ctx.vendorId }
    const k = p?.kind || p?.type
    if (k) {
      if (k === "TRANSFER") {
        where.kind = { in: ["TRANSFER_IN", "TRANSFER_OUT"] }
      } else {
        where.kind = k
      }
    }
    if (p?.itemId) where.itemId = p.itemId
    if (p?.warehouseId) where.warehouseId = p.warehouseId
    if (p?.referenceType || p?.refType) where.refType = p.referenceType || p.refType
    const [txs, items, warehouses] = await Promise.all([
      db.stockTransaction.findMany({ where, orderBy: { createdAt: "desc" }, take: Number(p?.limit || 500) }),
      db.item.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, code: true, name: true, unit: true, category: true } }),
      db.warehouse.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } }),
    ])
    const itemMap = new Map(items.map((i) => [i.id, i]))
    const warehouseMap = new Map(warehouses.map((w) => [w.id, w]))
    return txs.map((t) => {
      const it = itemMap.get(t.itemId)
      const wh = warehouseMap.get(t.warehouseId)
      const prevQty = t.balanceAfter != null ? Math.round((t.balanceAfter - t.quantity) * 1000) / 1000 : null
      return {
        ...t,
        type: t.kind,
        itemName: it?.name || "—",
        itemCode: it?.code || "",
        itemUnit: it?.unit || "Pcs",
        itemCategory: it?.category || "—",
        warehouseName: wh?.name || "—",
        previousQty: prevQty,
        newQty: t.balanceAfter,
        referenceType: t.refType,
        referenceNo: t.refId,
        userName: t.byUserName || "system",
        remarks: t.note,
      }
    })
  },
})

// ---------- stock entries (goods receipt) ----------

route("inventory.stock.entries.list", {
  perm: ["inventory", "view"],
  handler: async (ctx, p) => {
    const where: any = { vendorId: ctx.vendorId }
    if (p?.status) where.status = p.status
    if (p?.purchaseId || p?.purchaseRequestId) where.purchaseId = p.purchaseId || p.purchaseRequestId
    const entries = await db.stockEntry.findMany({ where, orderBy: { createdAt: "desc" }, include: { items: true }, take: 200 })
    const [, suppliers, warehouses, prs] = await Promise.all([
      db.item.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true, unit: true } }),
      db.supplier.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } }),
      db.warehouse.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } }),
      db.purchaseRequest.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, code: true } }),
    ])
    return entries.map((e) => ({
      ...e,
      // UI aliases (verified inventory view contract)
      entryNo: e.code,
      receivedDate: e.entryDate,
      postedByName: e.byUserName,
      itemCount: (e.items as any[]).length,
      totalCost: (e.items as any[]).reduce((s, i) => s + i.quantity * i.unitCost, 0),
      supplierName: suppliers.find((s) => s.id === e.supplierId)?.name || "—",
      warehouseName: warehouses.find((w) => w.id === e.warehouseId)?.name || "—",
      purchaseReqNo: prs.find((pr) => pr.id === e.purchaseId)?.code || null,
      items: (e.items as any[]).map((i) => ({ ...i })),
    }))
  },
})

route("inventory.stock.entries.save", {
  perm: ["inventory", "create"],
  handler: async (ctx, p) => saveStockEntry(ctx, p),
})

export function calcWarrantyExpiry(baseDateStr: string, value?: number | null, unit?: string | null): string | null {
  if (!value || value <= 0) return null
  const d = new Date(baseDateStr ? `${baseDateStr}T00:00:00` : new Date())
  if (isNaN(d.getTime())) return null
  const u = (unit || "MONTHS").toUpperCase()
  if (u === "DAYS") {
    d.setDate(d.getDate() + Number(value))
  } else if (u === "YEARS") {
    d.setFullYear(d.getFullYear() + Number(value))
  } else {
    d.setMonth(d.getMonth() + Number(value))
  }
  return d.toISOString().slice(0, 10)
}

/** Create a DRAFT stock entry (goods receipt) — internal, shared with the
 *  procurement module's one-click receive. */
export async function saveStockEntry(ctx: any, p: any) {
    if (!Array.isArray(p.items) || !p.items.length) throw new Deny("A stock entry needs at least one item line")
    if (!p.warehouseId) throw new Deny("Select the receiving warehouse")
    const warehouse = await db.warehouse.findFirst({ where: { id: p.warehouseId, vendorId: ctx.vendorId } })
    if (!warehouse) throw new Deny("Warehouse not found", 404)
    const items: {
      itemId: string
      itemName: string
      brandModel: string | null
      quantity: number
      unitCost: number
      warrantyValue: number | null
      warrantyUnit: string | null
      warrantyExpiry: string | null
      serialNumbers: string | null
      remarks: string | null
    }[] = []
    const baseDate = p.entryDate || p.receivedDate || today()
    for (const i of p.items) {
      const itemId = String(i.itemId || "")
      if (!itemId) throw new Deny("Every line needs an item")
      const quantity = Number(i.quantity)
      const unitCost = Number(i.unitCost || 0)
      if (!(quantity > 0)) throw new Deny("Received quantity must be positive")
      if (unitCost < 0) throw new Deny("Unit cost cannot be negative")
      const exists = await db.item.findFirst({ where: { id: itemId, vendorId: ctx.vendorId } })
      if (!exists) throw new Deny("One of the items does not exist in this inventory")

      const warrantyVal = i.warrantyValue != null && i.warrantyValue !== "" ? Number(i.warrantyValue) : null
      const warrantyUnit = i.warrantyUnit ? String(i.warrantyUnit).toUpperCase() : null
      const warrantyExpiry = i.warrantyExpiry || (warrantyVal ? calcWarrantyExpiry(baseDate, warrantyVal, warrantyUnit) : null)

      let serialsJson: string | null = null
      if (Array.isArray(i.serials)) {
        const cleanSerials = i.serials.map((s: any) => String(s || "").trim()).filter(Boolean)
        if (cleanSerials.length > 0) serialsJson = JSON.stringify(cleanSerials)
      } else if (typeof i.serialNumbers === "string" && i.serialNumbers.trim()) {
        try {
          const parsed = JSON.parse(i.serialNumbers)
          if (Array.isArray(parsed)) serialsJson = JSON.stringify(parsed.map((s: any) => String(s || "").trim()).filter(Boolean))
          else serialsJson = JSON.stringify([String(i.serialNumbers).trim()])
        } catch {
          serialsJson = JSON.stringify(i.serialNumbers.split(/[\n,]+/).map((s: string) => s.trim()).filter(Boolean))
        }
      }

      items.push({
        itemId,
        itemName: i.itemName || exists.name,
        brandModel: i.brandModel ? String(i.brandModel).trim() : null,
        quantity,
        unitCost,
        warrantyValue: warrantyVal,
        warrantyUnit,
        warrantyExpiry,
        serialNumbers: serialsJson,
        remarks: i.remarks || null,
      })
    }
    let pr: any = null
    if (p.purchaseId || p.purchaseRequestId) {
      pr = await db.purchaseRequest.findFirst({ where: { id: p.purchaseId || p.purchaseRequestId, vendorId: ctx.vendorId } })
      if (!pr) throw new Deny("Linked purchase request not found", 404)
      if (pr.status === "STOCK_ENTERED") throw new Deny("This purchase request already has its stock entered")
    }
    // entry code: SE-YYYY-NNNNN — with collision retry (manually seeded entries
    // may exist outside the sequence counter; the retry keeps saves working)
    let rec: any = null
    for (let attempt = 0; attempt < 5 && !rec; attempt++) {
      const code = await nextFormattedSeq(ctx.vendorId, "stock-entry", (n) => `SE-${new Date().getFullYear()}-${String(n).padStart(5, "0")}`)
      try {
        rec = await db.stockEntry.create({
          data: {
            vendorId: ctx.vendorId, code,
            purchaseId: pr?.id || null, supplierId: p.supplierId || null,
            invoiceNo: p.invoiceNo || null,
            warehouseId: p.warehouseId, entryDate: p.entryDate || p.receivedDate || today(),
            remarks: p.remarks || null, status: "DRAFT",
            byUserId: ctx.userId, byUserName: ctx.userName,
            items: { create: items.map((it) => ({ vendorId: ctx.vendorId, ...it })) },
          },
          include: { items: true },
        })
      } catch (e: any) {
        if (String(e?.code) === "P2002" && attempt < 4) continue // code taken — try the next number
        throw e
      }
    }
    // a draft entry parks the purchase in PENDING_STOCK_ENTRY until it is posted
    if (pr && ["APPROVED", "QUOTATION_COLLECTION"].includes(pr.status)) {
      await db.purchaseRequest.update({ where: { id: pr.id }, data: { status: "PENDING_STOCK_ENTRY" } }).catch(() => {})
    }
    await audit(ctx, "inventory.stock.entries.save", "StockEntry", rec.id, `Created stock entry ${rec.code} (${items.length} lines, DRAFT)`)
    return { ...rec, entryNo: rec.code }
}

route("inventory.stock.entries.post", {
  perm: ["inventory", "approve"],
  handler: async (ctx, p) => postStockEntry(ctx, p.id),
})

/** POST a DRAFT stock entry: quantities increase HERE and ONLY here (plus
 *  manual adjust below). Transactional: level update + StockTransaction rows +
 *  linked purchase-request/requisition re-evaluation are all-or-nothing. */
export async function postStockEntry(ctx: any, id: string) {
    const rec = await db.stockEntry.findFirst({ where: { id, vendorId: ctx.vendorId }, include: { items: true } })
    if (!rec) throw new Deny("Stock entry not found", 404)
    if (rec.status === "POSTED") throw new Deny("Entry is already posted — stock entries are immutable once posted")

    await db.$transaction(async (tx) => {
      // check-and-set: exactly one concurrent post wins
      const claimed = await tx.stockEntry.updateMany({ where: { id: rec.id, status: "DRAFT" }, data: { status: "POSTED", postedAt: new Date(), byUserId: ctx.userId, byUserName: ctx.userName } })
      if (claimed.count === 0) throw new Deny("Entry was already posted by someone else — refresh the list")

      for (const line of rec.items as any[]) {
        const level = await tx.stockLevel.upsert({
          where: { itemId_warehouseId: { itemId: line.itemId, warehouseId: rec.warehouseId } },
          create: { vendorId: ctx.vendorId, itemId: line.itemId, warehouseId: rec.warehouseId, quantity: 0 },
          update: {},
        })
        await tx.stockLevel.update({ where: { id: level.id }, data: { quantity: { increment: line.quantity } } })
        await tx.stockTransaction.create({
          data: {
            vendorId: ctx.vendorId, itemId: line.itemId, warehouseId: rec.warehouseId,
            kind: "ENTRY", quantity: line.quantity, balanceAfter: level.quantity + line.quantity,
            unitCost: line.unitCost, refType: "STOCK_ENTRY", refId: rec.id, note: `Posted ${rec.code}`,
            byUserId: ctx.userId, byUserName: ctx.userName,
          },
        })
        // keep item cost fresh (moving average is overkill — last cost is the HRM norm)
        if (line.unitCost > 0) await tx.item.update({ where: { id: line.itemId }, data: { lastCost: line.unitCost } })

        // Create tracked item serials in the AVAILABLE pool
        if (line.serialNumbers) {
          let serials: string[] = []
          try {
            const parsed = JSON.parse(line.serialNumbers)
            if (Array.isArray(parsed)) serials = parsed
          } catch {
            serials = String(line.serialNumbers).split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)
          }
          for (const sn of serials) {
            if (!sn) continue
            await tx.inventoryItemSerial.upsert({
              where: {
                vendorId_itemId_serialNumber: {
                  vendorId: ctx.vendorId,
                  itemId: line.itemId,
                  serialNumber: sn,
                },
              },
              create: {
                vendorId: ctx.vendorId,
                itemId: line.itemId,
                warehouseId: rec.warehouseId,
                stockEntryId: rec.id,
                serialNumber: sn,
                brandModel: line.brandModel || null,
                warrantyValue: line.warrantyValue,
                warrantyUnit: line.warrantyUnit,
                warrantyExpiry: line.warrantyExpiry,
                purchaseDate: rec.entryDate || today(),
                unitCost: line.unitCost,
                status: "AVAILABLE",
              },
              update: {
                warehouseId: rec.warehouseId,
                stockEntryId: rec.id,
                brandModel: line.brandModel || null,
                warrantyValue: line.warrantyValue,
                warrantyUnit: line.warrantyUnit,
                warrantyExpiry: line.warrantyExpiry,
                purchaseDate: rec.entryDate || today(),
                unitCost: line.unitCost,
                status: "AVAILABLE",
              },
            })
          }
        }
      }
    })

    // after-commit ripple effects — purchase request status + requisition re-check
    if (rec.purchaseId) {
      await db.purchaseRequest.update({ where: { id: rec.purchaseId }, data: { status: "STOCK_ENTERED" } }).catch(() => {})
      const pr = await db.purchaseRequest.findFirst({ where: { id: rec.purchaseId }, select: { code: true } })
      await notify(ctx.vendorId, { role: "HR_ADMIN" }, "Stock Entry Posted",
        `Stock entry ${rec.code} for purchase request ${pr?.code || ""} is now in inventory — linked requisitions were re-checked.`, "INVENTORY", "inventory")
    }
    await audit(ctx, "inventory.stock.entries.post", "StockEntry", rec.id, `Posted stock entry ${rec.code} — stock increased for ${(rec.items as any[]).length} item(s)`)

    // re-evaluate linked goods requisitions (stock may now be available — spec §9)
    const { recheckRequisitionsForStock } = await import("./procurement")
    await recheckRequisitionsForStock(ctx, (rec.items as any[]).map((i) => i.itemId))

    return { ok: true, status: "POSTED" }
}

// ---------- manual adjustment (with full audit trail — §16) ----------

route("inventory.stock.adjust", {
  perm: ["inventory", "edit"],
  handler: async (ctx, p) => {
    const itemId = String(p.itemId || "")
    const delta = Number(p.delta)
    if (!itemId) throw new Deny("Item is required")
    if (!Number.isFinite(delta) || delta === 0) throw new Deny("Adjustment delta must be a non-zero number")
    const item = await db.item.findFirst({ where: { id: itemId, vendorId: ctx.vendorId } })
    if (!item) throw new Deny("Item not found", 404)
    if (!p.warehouseId) throw new Deny("Select the warehouse to adjust")
    if (!p.remarks || String(p.remarks).trim().length < 3) throw new Deny("An adjustment reason is required (audit trail)")

    const result = await db.$transaction(async (tx) => {
      const level = await tx.stockLevel.upsert({
        where: { itemId_warehouseId: { itemId, warehouseId: p.warehouseId } },
        create: { vendorId: ctx.vendorId, itemId, warehouseId: p.warehouseId, quantity: 0 },
        update: {},
      })
      const newQty = level.quantity + delta
      if (newQty < 0) throw new Deny(`Adjustment would make stock negative (${level.quantity} + ${delta}) — not allowed (§23)`)
      // R2a-006 — use atomic increment instead of absolute write
      await tx.stockLevel.update({ where: { id: level.id }, data: { quantity: { increment: delta } } })
      const afterLevel = await tx.stockLevel.findUnique({ where: { id: level.id } })
      const balanceAfter = afterLevel?.quantity ?? newQty
      const t = await tx.stockTransaction.create({
        data: {
          vendorId: ctx.vendorId, itemId, warehouseId: p.warehouseId,
          kind: "ADJUST", quantity: delta, balanceAfter,
          refType: "MANUAL", note: p.remarks, byUserId: ctx.userId, byUserName: ctx.userName,
        },
      })
      return t
    })
    await audit(ctx, "inventory.stock.adjust", "StockTransaction", result.id, `Adjusted ${item.name} by ${delta > 0 ? "+" : ""}${delta} — ${p.remarks}`)
    return result
  },
})

// ---------- stock transfer between warehouses ----------

route("inventory.stock.transfer", {
  perm: ["inventory", "edit"],
  handler: async (ctx, p) => {
    const itemId = String(p.itemId || "")
    const fromWarehouseId = String(p.fromWarehouseId || "")
    const toWarehouseId = String(p.toWarehouseId || "")
    const quantity = Number(p.quantity)
    const remarks = p.remarks ? String(p.remarks).trim() : ""
    const serialNumbers: string[] = Array.isArray(p.serialNumbers) ? p.serialNumbers.map(String) : []

    if (!itemId) throw new Deny("Item is required")
    if (!fromWarehouseId) throw new Deny("Source warehouse is required")
    if (!toWarehouseId) throw new Deny("Destination warehouse is required")
    if (fromWarehouseId === toWarehouseId) throw new Deny("Source and destination warehouses must be different")
    if (!Number.isFinite(quantity) || quantity <= 0) throw new Deny("Transfer quantity must be greater than 0")

    const [item, fromWh, toWh] = await Promise.all([
      db.item.findFirst({ where: { id: itemId, vendorId: ctx.vendorId } }),
      db.warehouse.findFirst({ where: { id: fromWarehouseId, vendorId: ctx.vendorId } }),
      db.warehouse.findFirst({ where: { id: toWarehouseId, vendorId: ctx.vendorId } }),
    ])
    if (!item) throw new Deny("Item not found", 404)
    if (!fromWh) throw new Deny("Source warehouse not found", 404)
    if (!toWh) throw new Deny("Destination warehouse not found", 404)

    const result = await db.$transaction(async (tx) => {
      const fromLevel = await tx.stockLevel.findUnique({
        where: { itemId_warehouseId: { itemId, warehouseId: fromWarehouseId } },
      })
      const available = (fromLevel?.quantity || 0) - (fromLevel?.reserved || 0)
      if (available < quantity) {
        throw new Deny(`Insufficient available stock in ${fromWh.name} (available: ${available}, requested: ${quantity})`)
      }

      const toLevel = await tx.stockLevel.upsert({
        where: { itemId_warehouseId: { itemId, warehouseId: toWarehouseId } },
        create: { vendorId: ctx.vendorId, itemId, warehouseId: toWarehouseId, quantity: 0 },
        update: {},
      })

      // R2a-005 — use atomic increment/decrement instead of read-then-write
      // absolute values to prevent a TOCTOU race where two concurrent transfers
      // from the same warehouse could both pass the availability check but only
      // the DB constraint catches the double-spend.
      await tx.stockLevel.update({
        where: { id: fromLevel?.id || "" },
        data: { quantity: { decrement: quantity } },
      })
      await tx.stockLevel.update({
        where: { id: toLevel.id },
        data: { quantity: { increment: quantity } },
      })

      // Re-read the updated quantities for the transaction log
      const fromAfter = await tx.stockLevel.findUnique({ where: { id: fromLevel?.id || "" } })
      const toAfter = await tx.stockLevel.findUnique({ where: { id: toLevel.id } })
      const fromNewQty = fromAfter?.quantity ?? (fromLevel?.quantity || 0) - quantity
      const toNewQty = toAfter?.quantity ?? toLevel.quantity + quantity

      const transferRef = `TRF-${Date.now().toString(36).toUpperCase()}`

      const txOut = await tx.stockTransaction.create({
        data: {
          vendorId: ctx.vendorId,
          itemId,
          warehouseId: fromWarehouseId,
          kind: "TRANSFER_OUT",
          quantity: -quantity,
          unitCost: item.lastCost || 0,
          balanceAfter: fromNewQty,
          refType: "TRANSFER",
          refId: transferRef,
          note: `Transfer to ${toWh.name}${remarks ? ` · ${remarks}` : ""}`,
          byUserId: ctx.userId,
          byUserName: ctx.userName,
        },
      })

      const txIn = await tx.stockTransaction.create({
        data: {
          vendorId: ctx.vendorId,
          itemId,
          warehouseId: toWarehouseId,
          kind: "TRANSFER_IN",
          quantity: quantity,
          unitCost: item.lastCost || 0,
          balanceAfter: toNewQty,
          refType: "TRANSFER",
          refId: transferRef,
          note: `Transfer from ${fromWh.name}${remarks ? ` · ${remarks}` : ""}`,
          byUserId: ctx.userId,
          byUserName: ctx.userName,
        },
      })

      if (serialNumbers.length > 0) {
        await tx.inventoryItemSerial.updateMany({
          where: {
            vendorId: ctx.vendorId,
            itemId,
            serialNumber: { in: serialNumbers },
            warehouseId: fromWarehouseId,
          },
          data: { warehouseId: toWarehouseId },
        })
      }

      return { transferRef, txOut, txIn }
    })

    await audit(
      ctx,
      "inventory.stock.transfer",
      "StockTransaction",
      result.txOut.id,
      `Transferred ${quantity} ${item.unit} of ${item.name} from ${fromWh.name} to ${toWh.name}${remarks ? ` (${remarks})` : ""}`
    )

    return {
      ok: true,
      transferRef: result.transferRef,
      transferredQty: quantity,
      fromWarehouse: fromWh.name,
      toWarehouse: toWh.name,
    }
  },
})

// ---------- WP-L — issue an inventory item to an employee as a tracked asset ----------

/** Best-effort inventory-category → asset-category mapping (keyword-assisted). */
function mapAssetCategory(itemCategory: string | null, itemName: string): string {
  const cat = (itemCategory || "OTHER").toUpperCase()
  const name = (itemName || "").toLowerCase()
  if (cat === "FURNITURE") return "FURNITURE"
  if (/phone|mobile|handset|tab(?:let)?\b/.test(name)) return "MOBILE"
  if (cat === "IT") {
    if (/laptop|notebook|macbook/.test(name)) return "LAPTOP"
    if (/desktop|tower|pc\b|imac|workstation/.test(name)) return "DESKTOP"
    if (/monitor|screen|display/.test(name)) return "MONITOR"
    if (/sim\b|data pack|data card/.test(name)) return "SIM"
    return "OTHER"
  }
  if (/id card/.test(name)) return "ID_CARD"
  if (/access card|rfid|proximity/.test(name)) return "ACCESS_CARD"
  if (/vehicle|motorcycle|scooter|van|pickup|\bcar\b/.test(name)) return "VEHICLE"
  return "OTHER"
}

/** WP-L (2026-10 approval flow) — qty sitting in PENDING ASSET_ISSUE approval
 *  requests, summed per itemId. Pending requests RESERVE nothing on
 *  StockLevel (the ledger only moves at final approval), but their qty counts
 *  as unavailable for further issues — the requester is already counting on
 *  that stock. A corrupt payload is skipped, never allowed to break listings. */
export async function pendingIssueQtyByItem(vendorId: string): Promise<Map<string, number>> {
  const pending = await db.approvalRequest.findMany({
    where: { vendorId, processType: "ASSET_ISSUE", status: "PENDING" },
    select: { payloadJson: true },
  })
  const out = new Map<string, number>()
  for (const r of pending) {
    try {
      const payload = JSON.parse(r.payloadJson || "{}") as { itemId?: string; qty?: number }
      if (!payload.itemId) continue
      out.set(payload.itemId, (out.get(payload.itemId) || 0) + Math.max(0, Number(payload.qty) || 0))
    } catch { /* skip */ }
  }
  return out
}

route("inventory.items.availableSerials", {
  perm: ["inventory", "view"],
  handler: async (ctx, p) => {
    const itemId = String(p?.itemId || "")
    if (!itemId) return []
    const where: any = { vendorId: ctx.vendorId, itemId, status: "AVAILABLE" }
    if (p?.warehouseId) where.warehouseId = String(p.warehouseId)
    return await db.inventoryItemSerial.findMany({
      where,
      orderBy: { serialNumber: "asc" },
    })
  },
})

const issueAsAssetSchema = z.object({
  itemId: id,
  employeeId: id,
  // units to issue in ONE request (each unit becomes its own tracked asset);
  // validated against issueable stock (on hand − reserved − pending approval)
  qty: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? 1 : Number(v)),
    z.number().int().min(1).max(999),
  ),
  selectedSerials: z.array(z.string()).optional(),
  conditionOut: z.enum(["NEW", "GOOD", "FAIR", "DAMAGED"]).nullish(),
  note: textOpt(1000),
}).strict()

// INTENTIONALLY_SELF_SCOPED (M-02) — dual-perm route: perm [inventory, edit] rides the def below (the long WP-L comment pushes it past the lint window); the asset-assign half is asserted in-handler.
route("inventory.issueAsAsset", {
  // WP-L — ONE action needs BOTH permissions: the inventory edit to move
  // stock AND the asset assign authority to create the handover. The route
  // perm carries the inventory half (SaaS module gate = INVENTORY, which also
  // covers the assets module); the asset half is asserted inside.
  //
  // 2026-10-16 — this route no longer moves stock. It VALIDATES the request
  // against issueable stock and submits an ASSET_ISSUE approval request; the
  // stock OUT + Asset + Assignment rows happen in the finalize hook ONLY when
  // the workflow fully approves (applyAssetIssueDecision → executeAssetIssue).
  perm: ["inventory", "edit"],
  schema: issueAsAssetSchema,
  handler: async (ctx, p) => {
    const v = p as z.infer<typeof issueAsAssetSchema>
    if (!can(ctx, "assets", "assign")) {
      throw new Deny("Permission denied: assets.assign is also required to issue items as assets")
    }
    const qty = v.qty
    const item = await db.item.findFirst({ where: { id: v.itemId, vendorId: ctx.vendorId } })
    if (!item) throw new Deny("Item not found", 404)
    // H-04/H-05 + ACTIVE/PROBATION — same employee rules as assets.assign
    const emp = await assertEmployeeVisible(ctx, v.employeeId)
    if (!["ACTIVE", "PROBATION"].includes(emp.status)) {
      throw new Deny(`${emp.fullName} is ${emp.status} — assets can only be assigned to ACTIVE or PROBATION employees`, 400)
    }

    // Availability gate at submission time (the same gate re-runs at approval
    // time): on hand − reserved − qty pending approval, across warehouses —
    // the same basis the overview's "available" column reports.
    const [levels, pendingIssue] = await Promise.all([
      db.stockLevel.findMany({ where: { vendorId: ctx.vendorId, itemId: item.id } }),
      pendingIssueQtyByItem(ctx.vendorId),
    ])
    const onHand = levels.reduce((s, l) => s + l.quantity, 0)
    const reserved = levels.reduce((s, l) => s + l.reserved, 0)
    const pendingQty = pendingIssue.get(item.id) || 0
    const issueable = Math.max(0, onHand - reserved - pendingQty)
    if (qty > issueable) {
      throw new Deny(
        `Cannot request ${qty} ${item.unit} of "${item.name}" — only ${issueable} issueable now ` +
        `(${onHand} on hand − ${reserved} reserved − ${pendingQty} pending approval).`,
        400,
      )
    }

    // Existing tenants may predate this workflow type — bootstrap the same
    // default seed-owner provisions (one Owner step) instead of hard-failing.
    await ensureAssetIssueWorkflow(ctx)

    const approvalId = await submitForApproval(ctx, "ASSET_ISSUE", "Item", item.id,
      `Asset issue — ${item.name} ×${qty} to ${emp.fullName}`,
      {
        itemId: item.id, itemName: item.name, itemCode: item.code, unit: item.unit,
        employeeId: emp.id, employeeName: emp.fullName, employeeCode: emp.code,
        qty, unitCost: item.lastCost,
        selectedSerials: v.selectedSerials || [],
        // engine amount → threshold auto-pass + queue Amount column
        amount: Math.round(qty * (item.lastCost || 0)),
        conditionOut: v.conditionOut || "NEW",
        note: (v.note || "").trim() || null,
      })
    await audit(ctx, "inventory.issueAsAsset", "Item", item.id,
      `Submitted asset issue request — ${qty} × "${item.name}" to ${emp.fullName} (stock deducts on final approval)`,
      { newValue: { itemId: item.id, employeeId: emp.id, qty, approvalRequestId: approvalId, selectedSerials: v.selectedSerials } })
    return { approvalId, status: "PENDING_APPROVAL", issueable: Math.max(0, issueable - qty) }
  },
})

/** Existing tenants may predate the ASSET_ISSUE workflow type. Rather than
 *  blocking submissions with "No approval workflow configured", provision the
 *  same single Owner step seed-owner.ts would have created (the owner is a
 *  super-approver anyway) — fully editable afterwards in Settings → Approval
 *  Workflows. */
async function ensureAssetIssueWorkflow(ctx: Ctx) {
  const existing = await db.approvalWorkflow.findFirst({ where: { vendorId: ctx.vendorId, processType: "ASSET_ISSUE", active: true } })
  if (existing) return
  try {
    const wf = await db.approvalWorkflow.create({
      data: { vendorId: ctx.vendorId, processType: "ASSET_ISSUE", name: "Asset Issue Approval", active: true },
    })
    await db.approvalStep.create({
      data: { vendorId: ctx.vendorId, workflowId: wf.id, sequence: 1, name: "Owner Approval", approverRole: "VENDOR_OWNER", required: true },
    })
    await audit(ctx, "inventory.assetIssue.workflowBootstrap", "ApprovalWorkflow", wf.id,
      "Auto-created the default Asset Issue approval workflow (Owner step) — adjust steps in Settings → Approval Workflows")
  } catch (e: unknown) {
    // lost a create race against a concurrent submission — the winner's
    // workflow serves this request too
    if ((e as { code?: string })?.code !== "P2002") throw e
  }
}

/** The transactional issue itself — stock OUT + StockTransaction + one tracked
 *  asset (auto AST- code) per unit + AssetAssignment + AssetEvent. Runs ONLY
 *  from the ASSET_ISSUE finalize hook, i.e. after final approval. The whole
 *  unit batch is retried when a generated AST- code collides. */
async function executeAssetIssue(ctx: Ctx, req: {
  requestId?: string
  itemId: string
  employeeId: string
  qty: number
  conditionOut?: string | null
  note?: string | null
  selectedSerials?: string[]
}) {
  const qty = Math.max(1, Math.floor(Number(req.qty) || 1))
  const item = await db.item.findFirst({ where: { id: req.itemId, vendorId: ctx.vendorId } })
  if (!item) throw new Deny("Item not found", 404)
  const emp = await db.employee.findFirst({ where: { id: req.employeeId, vendorId: ctx.vendorId } })
  if (!emp) throw new Deny("Employee not found", 404)
  if (!["ACTIVE", "PROBATION"].includes(emp.status)) {
    throw new Deny(`${emp.fullName} is ${emp.status} — assets can only be assigned to ACTIVE or PROBATION employees`)
  }

  // Last availability gate — stock may have moved while the request waited.
  // NOTE: by hook time the approved request itself is no longer PENDING, so
  // pendingIssueQtyByItem already reports only OTHER requests' quantities.
  const [levels, pendingIssue] = await Promise.all([
    db.stockLevel.findMany({ where: { vendorId: ctx.vendorId, itemId: item.id } }),
    pendingIssueQtyByItem(ctx.vendorId),
  ])
  const onHand = levels.reduce((s, l) => s + l.quantity, 0)
  const reserved = levels.reduce((s, l) => s + l.reserved, 0)
  const pendingOther = pendingIssue.get(item.id) || 0
  const issueable = Math.max(0, onHand - reserved - pendingOther)
  if (qty > issueable) {
    throw new Deny(
      `Insufficient stock for "${item.name}" at approval time — ${qty} needed, ${issueable} issueable ` +
      `(${onHand} on hand − ${reserved} reserved − ${pendingOther} pending elsewhere). Receive stock or reject a pending request.`,
    )
  }

  // Primary warehouse: the one holding the largest quantity of this item
  // (ties → earliest level row); with no levels at all, the tenant's first
  // active warehouse (a 0-quantity level is created there and the
  // insufficient-stock check below fires inside the transaction).
  const sorted = [...levels].sort((a, b) => b.quantity - a.quantity || a.id.localeCompare(b.id))
  let warehouseId = sorted[0]?.warehouseId
  if (!warehouseId) {
    const wh = await db.warehouse.findFirst({ where: { vendorId: ctx.vendorId, active: true }, orderBy: { name: "asc" } })
    if (!wh) throw new Deny("No active warehouse to issue from — create a warehouse first", 400)
    warehouseId = wh.id
  }

  const note = (req.note || "").trim() || null
  const conditionOut = req.conditionOut || "NEW"
  const category = mapAssetCategory(item.category, item.name)

  let out: { codes: string[]; assetIds: string[]; assignmentIds: string[]; balanceAfter: number; warehouseId: string } | null = null
  for (let attempt = 0; attempt < 5 && !out; attempt++) {
    const codes: string[] = []
    for (let i = 0; i < qty; i++) {
      codes.push(await nextFormattedSeq(ctx.vendorId, "asset-code", (n) => `AST-${String(n).padStart(4, "0")}`))
    }
    try {
      out = await db.$transaction(async (tx) => {
        // conditional stock decrement — a concurrent movement racing past the
        // pre-read loses cleanly here (check-and-set, §16 discipline)
        const level = await tx.stockLevel.upsert({
          where: { itemId_warehouseId: { itemId: item.id, warehouseId } },
          create: { vendorId: ctx.vendorId, itemId: item.id, warehouseId, quantity: 0 },
          update: {},
        })
        const claimed = await tx.stockLevel.updateMany({
          where: { id: level.id, quantity: { gte: qty } },
          data: { quantity: { decrement: qty } },
        })
        if (claimed.count === 0) {
          throw new Deny(`Insufficient stock for "${item.name}" in the primary warehouse — ${qty} needed, ${level.quantity} on hand.`, 400)
        }
        const after = await tx.stockLevel.findUnique({ where: { id: level.id } })
        await tx.stockTransaction.create({
          data: {
            vendorId: ctx.vendorId, itemId: item.id, warehouseId,
            kind: "ISSUE", quantity: -qty, balanceAfter: after?.quantity ?? 0,
            unitCost: item.lastCost, refType: "ASSET_ISSUE", refId: req.requestId || null,
            note: `Issued as assets ${codes[0]}${qty > 1 ? `–${codes[codes.length - 1]} (${qty} units)` : ""} to ${emp.fullName}`,
            byUserId: ctx.userId, byUserName: ctx.userName,
          },
        })
        // one tracked asset + handover + lifecycle event PER UNIT
        const assetIds: string[] = []
        const assignmentIds: string[] = []
        const selectedSerials = (req.selectedSerials || []) as string[]
        for (let idx = 0; idx < codes.length; idx++) {
          const code = codes[idx]
          const assignedSerial = selectedSerials[idx] || null
          let serialRec: any = null
          if (assignedSerial) {
            serialRec = await tx.inventoryItemSerial.findFirst({
              where: { vendorId: ctx.vendorId, itemId: item.id, serialNumber: assignedSerial, status: "AVAILABLE" },
            })
          } else {
            serialRec = await tx.inventoryItemSerial.findFirst({
              where: { vendorId: ctx.vendorId, itemId: item.id, status: "AVAILABLE" },
            })
          }
          const asset = await tx.asset.create({
            data: {
              vendorId: ctx.vendorId, code, name: item.name, category,
              brandModel: serialRec?.brandModel || item.brandModel,
              serialImei: assignedSerial || serialRec?.serialNumber || item.serialImei,
              purchaseDate: serialRec?.purchaseDate || item.purchaseDate,
              warrantyExpiry: serialRec?.warrantyExpiry || item.warrantyExpiry,
              purchaseCost: (serialRec?.unitCost && serialRec.unitCost > 0) ? serialRec.unitCost : (item.lastCost > 0 ? item.lastCost : null),
              condition: conditionOut, status: "ASSIGNED",
              sourceItemId: item.id,
              notes: `Issued from inventory item ${item.code || item.name}`,
            },
          })
          if (serialRec) {
            await tx.inventoryItemSerial.update({
              where: { id: serialRec.id },
              data: { status: "ISSUED", assetId: asset.id, employeeId: emp.id },
            })
          }
          const assignment = await tx.assetAssignment.create({
            data: {
              vendorId: ctx.vendorId, assetId: asset.id, employeeId: emp.id,
              conditionOut, note, issuedById: ctx.userId,
            },
          })
          await tx.assetEvent.create({
            data: {
              vendorId: ctx.vendorId, assetId: asset.id, type: "ASSIGN",
              actorId: ctx.userId, actorName: ctx.userName,
              snapshotJson: JSON.stringify({
                assignmentId: assignment.id,
                employee: { id: emp.id, name: emp.fullName, code: emp.code },
                conditionOut, note, source: `inventory:${item.name}`,
                serialImei: assignedSerial || serialRec?.serialNumber || item.serialImei,
              }).slice(0, 4000),
              note,
            },
          })
          assetIds.push(asset.id)
          assignmentIds.push(assignment.id)
        }
        return { codes, assetIds, assignmentIds, balanceAfter: after?.quantity ?? 0, warehouseId }
      })
    } catch (e: unknown) {
      const prismaCode = (e as { code?: string })?.code
      if (prismaCode === "P2002" && attempt < 4) continue // AST- code taken — regenerate the batch
      throw e
    }
  }
  if (!out) throw new Deny("Could not allocate asset codes — try again", 500)
  return { ...out, itemName: item.name, employeeName: emp.fullName, qty }
}

/** ASSET_ISSUE finalize hook — executes (or skips) the stock movement when the
 *  workflow reaches a final decision. APPROVED → stock OUT + tracked assets
 *  assigned. REJECTED → nothing moves (the engine already notifies the
 *  requester). A failure here is LOUD by design (engine M-9: audit row +
 *  HR-admin notification) — a stuck request must be visible, never silent. */
export async function applyAssetIssueDecision(ctx: Ctx, req: ApprovalRequestView | any, decision: "APPROVED" | "REJECTED"): Promise<void> {
  if (decision !== "APPROVED") return
  let payload = (req.payload || {}) as {
    itemId?: string
    employeeId?: string
    qty?: number
    conditionOut?: string | null
    note?: string | null
    selectedSerials?: string[]
  }
  if (!payload.itemId && req.payloadJson) {
    try {
      payload = typeof req.payloadJson === "string" ? JSON.parse(req.payloadJson) : req.payloadJson
    } catch { /* skip */ }
  }
  if (!payload.itemId || !payload.employeeId) {
    throw new Deny("Asset issue request payload is incomplete — cannot execute the approved issue")
  }
  const out = await executeAssetIssue(ctx, {
    requestId: req.id,
    itemId: payload.itemId,
    employeeId: payload.employeeId,
    qty: Number(payload.qty) || 1,
    conditionOut: payload.conditionOut,
    note: payload.note,
    selectedSerials: payload.selectedSerials || [],
  })
  const codeLabel = out.codes.length === 1 ? out.codes[0] : `${out.codes[0]}–${out.codes[out.codes.length - 1]}`
  await audit(ctx, "inventory.assetIssue.approve", "Asset", out.assetIds[0],
    `Approved asset issue — ${out.qty} × "${out.itemName}" issued as ${codeLabel} to ${out.employeeName} — ${out.qty} unit(s) OUT (${out.balanceAfter} left)`,
    { newValue: { assetIds: out.assetIds, employeeId: payload.employeeId, itemId: payload.itemId, qty: out.qty, warehouseId: out.warehouseId, approvalRequestId: req.id } })
  await notify(ctx.vendorId, { employeeId: payload.employeeId }, "Company Asset Issued",
    `A company asset (${out.itemName} — ${codeLabel}) has been issued to you from inventory${out.qty > 1 ? ` (${out.qty} units)` : ""}. Return it to HR when leaving or on request.`, "ASSET", "ess")
}

export const INVENTORY_ITEM_CATEGORIES = ITEM_CATEGORIES

// ================= WP-M: MISSING ITEM / CATEGORY / UNIT REQUESTS =================
export async function ensureMasterRequestWorkflow(ctx: Ctx) {
  const existing = await db.approvalWorkflow.findFirst({
    where: { vendorId: ctx.vendorId, processType: "MASTER_REQUEST", active: true },
  })
  if (existing) return existing
  try {
    const wf = await db.approvalWorkflow.create({
      data: {
        vendorId: ctx.vendorId,
        processType: "MASTER_REQUEST",
        name: "Master Data Request Approval (Item / Category / Unit)",
        active: true,
      },
    })
    await db.approvalStep.create({
      data: {
        vendorId: ctx.vendorId,
        workflowId: wf.id,
        sequence: 1,
        name: "HR Admin / Owner Approval",
        approverRole: "HR_ADMIN",
        required: true,
      },
    })
    return wf
  } catch (e: unknown) {
    if ((e as { code?: string })?.code !== "P2002") throw e
    return await db.approvalWorkflow.findFirst({
      where: { vendorId: ctx.vendorId, processType: "MASTER_REQUEST", active: true },
    })
  }
}

export async function applyMasterRequestDecision(ctx: Ctx, req: ApprovalRequestView | any, decision: "APPROVED" | "REJECTED"): Promise<void> {
  let payload: Record<string, any> = {}
  if (req.payload && typeof req.payload === "object" && Object.keys(req.payload).length > 0) {
    payload = req.payload
  } else if (req.payloadJson) {
    try {
      payload = typeof req.payloadJson === "string" ? JSON.parse(req.payloadJson) : req.payloadJson
    } catch {
      payload = {}
    }
  }

  const targetType = String(payload.type || "ITEM").toUpperCase()
  const requester = req.requestedBy

  if (decision !== "APPROVED") {
    if (requester) {
      await notify(ctx.vendorId, { userId: requester }, "Request Rejected",
        `Your request to add ${targetType.toLowerCase()} "${payload.name || req.entityRef}" was rejected.`,
        "APPROVAL", "ess")
    }
    return
  }

  // Finalize APPROVED request: create the actual record in the database
  if (targetType === "ITEM") {
    const itemName = payload.name
      ? String(payload.name).trim()
      : (req.entityRef?.replace(/^Request to add (?:Item|item):\s*/i, "") || "").trim()
    if (!itemName || itemName.toLowerCase() === "undefined") {
      throw new Error("Master request payload is missing item name")
    }
    const code = await nextItemCode(ctx.vendorId)
    const item = await db.item.create({
      data: {
        vendorId: ctx.vendorId,
        code,
        name: itemName,
        category: String(payload.category || "OTHER").trim(),
        unit: String(payload.unit || "Pcs").trim(),
        lastCost: Number(payload.unitCost || payload.lastCost || 0),
        reorderLevel: Number(payload.reorderLevel || 0),
        brandModel: payload.brandModel ? String(payload.brandModel).trim() : null,
        hasWarranty: !!payload.hasWarranty,
        isReturnable: !!payload.isReturnable,
        active: true,
      },
    })
    await audit(ctx, "inventory.masterRequest.approved", "Item", item.id,
      `Approved request: created new item "${item.name}" (${item.code})`)
  } else if (targetType === "CATEGORY") {
    const catName = payload.name
      ? String(payload.name).trim()
      : (req.entityRef?.replace(/^Request to add (?:Category|category):\s*/i, "") || "").trim()
    if (!catName || catName.toLowerCase() === "undefined") {
      throw new Error("Master request payload is missing category name")
    }
    const cat = await db.itemCategory.create({
      data: {
        vendorId: ctx.vendorId,
        name: catName,
        description: payload.description ? String(payload.description).trim() : null,
        active: true,
      },
    })
    await audit(ctx, "inventory.masterRequest.approved", "ItemCategory", cat.id,
      `Approved request: created new category "${cat.name}"`)
  } else if (targetType === "UNIT") {
    const unitName = payload.name
      ? String(payload.name).trim()
      : (req.entityRef?.replace(/^Request to add (?:Unit|unit):\s*/i, "") || "").trim()
    if (!unitName || unitName.toLowerCase() === "undefined") {
      throw new Error("Master request payload is missing unit name")
    }
    const u = await db.itemUnit.create({
      data: {
        vendorId: ctx.vendorId,
        name: unitName,
        symbol: payload.symbol ? String(payload.symbol).trim() : null,
        active: true,
      },
    })
    await audit(ctx, "inventory.masterRequest.approved", "ItemUnit", u.id,
      `Approved request: created new unit "${u.name}" (${u.symbol || ""})`)
  }

  if (requester) {
    await notify(ctx.vendorId, { userId: requester }, "Request Approved",
      `Your request to add ${targetType.toLowerCase()} "${payload.name || req.entityRef}" was approved and is now active in the system!`,
      "APPROVAL", "ess")
  }
}

// INTENTIONALLY_SELF_SCOPED (M-02): requisitioners may propose missing items/units — the handler gates on procurement.create | inventory.view | ess.view and stamps the requester.
route("inventory.masterRequest.create", {
  handler: async (ctx, p) => {
    if (!can(ctx, "procurement", "create") && !can(ctx, "inventory", "view") && !can(ctx, "ess", "view")) {
      throw new Deny("You do not have permission to submit missing item requests", 403)
    }

    const type = String(p?.type || "ITEM").toUpperCase()
    if (!["ITEM", "CATEGORY", "UNIT"].includes(type)) {
      throw new Deny("Invalid request type. Must be ITEM, CATEGORY, or UNIT", 400)
    }
    const name = String(p?.name || "").trim()
    if (!name) throw new Deny(`${type === "ITEM" ? "Item" : type === "CATEGORY" ? "Category" : "Unit"} name is required`, 400)

    await ensureMasterRequestWorkflow(ctx)

    if (type === "ITEM") {
      const exists = await db.item.findFirst({
        where: { vendorId: ctx.vendorId, name: { equals: name, mode: "insensitive" } },
      })
      if (exists) throw new Deny(`An item with name "${name}" already exists (${exists.code})`, 400)
    } else if (type === "CATEGORY") {
      const exists = await db.itemCategory.findFirst({
        where: { vendorId: ctx.vendorId, name: { equals: name, mode: "insensitive" } },
      })
      if (exists) throw new Deny(`A category with name "${name}" already exists`, 400)
    } else if (type === "UNIT") {
      const exists = await db.itemUnit.findFirst({
        where: { vendorId: ctx.vendorId, name: { equals: name, mode: "insensitive" } },
      })
      if (exists) throw new Deny(`A unit with name "${name}" already exists`, 400)
    }

    const payload = {
      type,
      name,
      category: p?.category ? String(p.category).trim() : "OTHER",
      unit: p?.unit ? String(p.unit).trim() : "Pcs",
      unitCost: p?.unitCost ? Number(p.unitCost) : 0,
      reorderLevel: p?.reorderLevel ? Number(p.reorderLevel) : 0,
      brandModel: p?.brandModel ? String(p.brandModel).trim() : null,
      hasWarranty: !!p?.hasWarranty,
      isReturnable: !!p?.isReturnable,
      description: p?.description ? String(p.description).trim() : null,
      symbol: p?.symbol ? String(p.symbol).trim() : null,
      remarks: p?.remarks ? String(p.remarks).trim() : null,
      employeeId: ctx.employeeId || null,
      requestedByName: ctx.userName,
    }

    const typeLabel = type === "ITEM" ? "Item" : type === "CATEGORY" ? "Category" : "Unit"
    const approvalId = await submitForApproval(
      ctx,
      "MASTER_REQUEST",
      type === "ITEM" ? "Item" : type === "CATEGORY" ? "ItemCategory" : "ItemUnit",
      `MR-${Date.now()}`,
      `Request to add ${typeLabel}: ${name}`,
      payload,
    )

    await audit(ctx, "inventory.masterRequest.submit", "ApprovalRequest", approvalId,
      `Submitted request to add missing ${typeLabel}: "${name}"`)

    return {
      approvalId,
      success: true,
      message: `Request to add ${typeLabel.toLowerCase()} "${name}" submitted for approval`,
    }
  },
})

