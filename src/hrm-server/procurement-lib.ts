// ============ Goods Requisition & Procurement — shared domain helpers ============
// Pure functions + shared constants used by the routes and the approval-engine
// finalize hooks. Kept free of side effects so the math is unit-testable
// (tests/unit/procurement-stock.test.ts).
import type { Ctx } from "./types"
import { db } from "@/lib/db"

// Item categories from the module spec §1 (requestable office goods).
export const ITEM_CATEGORIES = [
  { value: "IT_EQUIPMENT", label: "Computer / Laptop / IT Accessories" },
  { value: "FURNITURE", label: "Desk / Chair / Cabinet" },
  { value: "STATIONERY", label: "Stationery / Office Supplies" },
  { value: "ELECTRICAL", label: "Electrical / Other Office Items" },
  { value: "OTHER", label: "Custom / Other" },
] as const

export const ITEM_UNITS = ["Pcs", "Box", "Set", "Pack", "Unit", "Ltr", "Kg"] as const

export const REQ_STATUSES = [
  "DRAFT", "SUBMITTED", "PENDING_APPROVAL", "PENDING_STOCK", "STOCK_AVAILABLE",
  "PARTIALLY_FULFILLED", "ISSUED", "PENDING_RECEIPT_CONFIRMATION", "COMPLETED",
  "REJECTED", "RETURNED", "CANCELLED", "RECEIPT_DISPUTED", "ON_HOLD",
] as const

export const PR_STATUSES = [
  "DRAFT", "QUOTATION_COLLECTION", "PENDING_APPROVAL", "APPROVED",
  "PENDING_STOCK_ENTRY", "COMPLETED", "REJECTED", "CANCELLED",
] as const

export function reqStatusMeta(s: string): { label: string; tone: string } {
  const map: Record<string, { label: string; tone: string }> = {
    DRAFT: { label: "Draft", tone: "slate" },
    SUBMITTED: { label: "Submitted", tone: "sky" },
    PENDING_APPROVAL: { label: "Pending Approval", tone: "amber" },
    PENDING_STOCK: { label: "Pending Stock / Purchase", tone: "violet" },
    STOCK_AVAILABLE: { label: "Stock Available — Final Approval", tone: "cyan" },
    PARTIALLY_FULFILLED: { label: "Partially Fulfilled", tone: "orange" },
    ISSUED: { label: "Issued — Awaiting Confirmation", tone: "emerald" },
    PENDING_RECEIPT_CONFIRMATION: { label: "Awaiting Receipt Confirmation", tone: "teal" },
    COMPLETED: { label: "Completed", tone: "emerald" },
    REJECTED: { label: "Rejected", tone: "rose" },
    RETURNED: { label: "Returned for Correction", tone: "amber" },
    CANCELLED: { label: "Cancelled", tone: "slate" },
    RECEIPT_DISPUTED: { label: "Receipt Disputed", tone: "rose" },
    ON_HOLD: { label: "On Hold", tone: "slate" },
  }
  return map[s] || { label: s, tone: "slate" }
}

export function prStatusMeta(s: string): { label: string; tone: string } {
  const map: Record<string, { label: string; tone: string }> = {
    DRAFT: { label: "Draft", tone: "slate" },
    QUOTATION_COLLECTION: { label: "Quotation Collection", tone: "sky" },
    PENDING_APPROVAL: { label: "Pending Purchase Approval", tone: "amber" },
    APPROVED: { label: "Approved — Pending Stock Entry", tone: "violet" },
    PENDING_STOCK_ENTRY: { label: "Pending Stock Entry", tone: "violet" },
    COMPLETED: { label: "Completed", tone: "emerald" },
    REJECTED: { label: "Rejected", tone: "rose" },
    CANCELLED: { label: "Cancelled", tone: "slate" },
  }
  return map[s] || { label: s, tone: "slate" }
}

/** Spec §4 — shortage math. Only the shortage needs procurement. */
export function computeShortage(requested: number, available: number): number {
  return Math.max(0, Math.round((requested - Math.max(0, available)) * 100) / 100)
}

/** Remaining quantity = approved − issued so far. */
export function computeRemaining(approved: number | null | undefined, requested: number, issued: number): number {
  const target = approved != null ? approved : requested
  return Math.max(0, Math.round((target - issued) * 100) / 100)
}

/** Quotation line total: qty × unitPrice − discount + VAT (spec §6). */
export function quotationLineTotal(qty: number, unitPrice: number, discount: number, vatAmount: number): number {
  return Math.max(0, Math.round(((Number(qty) || 0) * (Number(unitPrice) || 0) - (Number(discount) || 0) + (Number(vatAmount) || 0)) * 100) / 100)
}

/** Sanitize + validate a requisition item list coming from the client. */
export function sanitizeRequisitionItems(raw: unknown): {
  itemCategory: string; itemId: string | null; itemName: string; specification: string | null
  unit: string; quantityRequested: number
}[] {
  const arr = Array.isArray(raw) ? raw : []
  const out: {
    itemCategory: string; itemId: string | null; itemName: string; specification: string | null
    unit: string; quantityRequested: number
  }[] = []
  for (const it of arr) {
    const qty = Number((it as any)?.quantityRequested ?? (it as any)?.qty)
    const name = String((it as any)?.itemName || (it as any)?.name || "").trim()
    if (!name) continue
    if (!Number.isFinite(qty) || qty <= 0) {
      throw Object.assign(new Error(`Requested quantity for "${name}" must be greater than 0`), { code: 400 })
    }
    const cat = String((it as any)?.itemCategory || "OTHER")
    out.push({
      itemCategory: (ITEM_CATEGORIES as readonly { value: string }[]).some((c) => c.value === cat) ? cat : "OTHER",
      itemId: (it as any)?.itemId ? String((it as any).itemId) : null,
      itemName: name.slice(0, 120),
      specification: (it as any)?.specification ? String((it as any).specification).slice(0, 500) : null,
      unit: String((it as any)?.unit || "Pcs").slice(0, 12),
      quantityRequested: qty,
    })
  }
  if (!out.length) {
    throw Object.assign(new Error("A requisition needs at least one item with a name and a quantity greater than 0"), { code: 400 })
  }
  return out
}

/** Parse a serials payload (comma / newline separated string or array). */
export function parseSerials(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean)
  if (typeof raw === "string") {
    return raw.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)
  }
  return []
}

/** Append a status-history event (spec §3: user, datetime, action,
 * comment, previous status → new status — every action is recorded). */
export async function logReqEvent(
  vendorId: string,
  requisitionId: string,
  fromStatus: string | null | undefined,
  toStatus: string,
  action: string,
  ctx?: { userId?: string | null; userName?: string | null },
  comment?: string | null,
) {
  const meta = [fromStatus, toStatus].filter(Boolean).length === 2 ? `${fromStatus} → ${toStatus}` : null
  await db.goodsRequisitionHistory.create({
    data: {
      vendorId, // DB-02 (R5)
      requisitionId,
      action,
      note: [comment, meta].filter(Boolean).join(" — ") || null,
      byUserId: ctx?.userId || null,
      byUserName: ctx?.userName || null,
    },
  })
}

/** Available quantity for an item across the vendor's warehouses (or one
 * warehouse when given). Used by the stock gate and the detail view. */
export async function availableQty(vendorId: string, itemId: string, warehouseId?: string | null): Promise<number> {
  const rows = await db.stockLevel.findMany({
    where: warehouseId
      ? { vendorId, itemId, warehouseId }
      : { vendorId, itemId },
  })
  return Math.round(rows.reduce((s, r) => s + (r.quantity || 0), 0) * 100) / 100
}

/** Document numbers — GR-2026-00001 / PR-2026-00001 / SE-2026-00001 / SI-2026-00001. */
export async function nextDocNo(vendorId: string, scope: "GR" | "PR" | "SE" | "SI"): Promise<string> {
  const { nextFormattedSeq } = await import("./utils")
  const year = new Date().getFullYear()
  return nextFormattedSeq(vendorId, `${scope}-${year}`, (n) => `${scope}-${year}-${String(n).padStart(5, "0")}`)
}

/** Requisition scope filter — employees see only their own requests (spec §20). */
export function requisitionScopeFilter(ctx: Ctx): Record<string, unknown> {
  const f: Record<string, unknown> = { vendorId: ctx.vendorId }
  if (ctx.role === "EMPLOYEE" && ctx.employeeId) f.employeeId = ctx.employeeId
  if (ctx.role === "BRANCH_MANAGER" && ctx.branchId) f.branchId = ctx.branchId
  return f
}
