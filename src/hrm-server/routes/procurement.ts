// ============ Procurement routes — Requisition & Purchase (spec §7–§9) ============
// Goods Requisition lifecycle:
//   DRAFT → PENDING_APPROVAL (GOODS_REQUISITION workflow)
//     → final approval re-validates stock in real time:
//         all available  → ISSUED immediately (transactional FIFO deduction)
//         shortage        → PURCHASE_REQUIRED + auto Purchase Request for the
//                           shortfall (quotations → approval → stock entry)
//   stock entry posts → recheckRequisitionsForStock() → STOCK_AVAILABLE
//     → "Issue goods" → ISSUED
//   employee confirms receipt → COMPLETED (or disputes → RECEIPT_DISPUTED)
// Purchase lifecycle:
//   DRAFT → (collect quotations → QUOTATION_COLLECTION) → PENDING_APPROVAL
//     → APPROVED → PENDING_STOCK_ENTRY → STOCK_ENTERED
import { db } from "@/lib/db"
import { route } from "./registry"
import { Deny, assertEmployeeVisible } from "../rbac"
import { audit, notify } from "../audit"
import { submitForApproval, actOnRequest } from "../approval"
import { nextFormattedSeq } from "../utils"

const REQ_VIEW = ["procurement", "view"] as [string, string]
const REQ_EDIT = ["procurement", "create"] as [string, string]
const REQ_APPROVE = ["procurement", "approve"] as [string, string]

// Requisition states that still have open (un-issued) quantity
const _OPEN_REQ: string[] = ["PENDING_APPROVAL", "APPROVED", "PENDING_STOCK", "PURCHASE_REQUIRED", "PENDING_PURCHASE", "STOCK_AVAILABLE"]

async function nextCode(vendorId: string, prefix: "GR" | "PR", model: "goodsRequisition" | "purchaseRequest") {
  const year = new Date().getFullYear()
  const existing = await (db as any)[model].findMany({ where: { vendorId }, select: { code: true } })
  let n = 1
  const used = new Set(existing.map((r: any) => r.code))
  while (used.has(`${prefix}-${year}-${String(n).padStart(5, "0")}`)) n++
  return `${prefix}-${year}-${String(n).padStart(5, "0")}`
}

async function reqHistory(
  vendorId: string,
  requisitionId: string, action: string, note?: string,
  by?: { userId?: string | null; userName?: string | null },
  fromStatus?: string | null, toStatus?: string | null,
) {
  const meta = [fromStatus, toStatus].filter(Boolean).length === 2 ? `${fromStatus} → ${toStatus}` : null
  await db.goodsRequisitionHistory.create({
    data: {
      vendorId, // DB-02 (R5) — history rows carry their tenant
      requisitionId, action,
      note: [note, meta].filter(Boolean).join(" — ") || null,
      byUserId: by?.userId || null, byUserName: by?.userName || null,
    },
  })
}

/** Free stock (quantity − reserved) for an item across all warehouses.
 *  PRC-01 (R5) — vendor-scoped like every other read (cross-tenant rows used
 *  to ride along and get matched by globally-unique ids in memory). */
async function availableOfMap(vendorId: string): Promise<Map<string, number>> {
  const levels = await db.stockLevel.findMany({ where: { vendorId }, select: { itemId: true, quantity: true, reserved: true } })
  const m = new Map<string, number>()
  for (const l of levels) m.set(l.itemId, (m.get(l.itemId) || 0) + (l.quantity - l.reserved))
  return m
}

/** Decorate requisition rows with the names, live availability and UI aliases.
 *  PRC-01 (R5) — every decorator fetch is vendor-scoped (the old unscoped
 *  findMany pulled cross-tenant rows into memory and matched them by
 *  globally-unique ids — a hygiene violation of the structural discipline). */
async function decorateRequisitions(rows: any[]) {
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)
  const vendorId = rows[0].vendorId
  const [items, emps, branches, deps, levels, prs, histories] = await Promise.all([
    db.goodsRequisitionItem.findMany({ where: { vendorId, requisitionId: { in: ids } } }),
    db.employee.findMany({ where: { vendorId }, select: { id: true, fullName: true, code: true } }),
    db.branch.findMany({ where: { vendorId }, select: { id: true, name: true } }),
    db.department.findMany({ where: { vendorId }, select: { id: true, name: true } }),
    db.stockLevel.findMany({ where: { vendorId }, select: { itemId: true, quantity: true, reserved: true } }),
    db.purchaseRequest.findMany({ where: { vendorId, requisitionId: { in: ids } } }),
    db.goodsRequisitionHistory.findMany({ where: { vendorId, requisitionId: { in: ids } } }),
  ])
  const itemIds = [...new Set(items.map((i) => i.itemId).filter(Boolean))] as string[]
  const itemRows = itemIds.length ? await db.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, name: true, unit: true } }) : []
  const availableOf = (itemId: string | null) => {
    if (!itemId) return null
    return levels.filter((l) => l.itemId === itemId).reduce((s, l) => s + (l.quantity - l.reserved), 0)
  }
  return rows.map((r) => {
    const lines = items.filter((i) => i.requisitionId === r.id).map((i) => {
      const live = availableOf(i.itemId)
      const pendingQty = Math.max(0, i.quantity - i.issuedQuantity)
      return {
        ...i,
        unit: itemRows.find((x) => x.id === i.itemId)?.unit || "Pcs",
        available: live,
        liveAvailableQty: live == null ? "—" : live,
        shortageQty: live == null ? 0 : Math.max(0, pendingQty - live),
        issuedQty: i.issuedQuantity || 0,
        pendingQty,
      }
    })
    const linked = prs.filter((p) => p.requisitionId === r.id)
    const hist = histories.filter((h) => h.requisitionId === r.id).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    return {
      ...r,
      // UI aliases (verified procurement view contract)
      reqNo: r.code, requestDate: r.createdAt, requiredDate: r.neededBy,
      submittedAt: hist.find((h) => h.action === "SUBMITTED")?.createdAt || null,
      employeeName: emps.find((e) => e.id === r.employeeId)?.fullName || "—",
      employeeCode: emps.find((e) => e.id === r.employeeId)?.code || "",
      branchName: branches.find((b) => b.id === r.branchId)?.name || "",
      departmentName: deps.find((d) => d.id === r.departmentId)?.name || "",
      itemCount: lines.length,
      totalQty: lines.reduce((s, l) => s + l.quantity, 0),
      totalShortage: lines.reduce((s, l) => s + l.shortageQty, 0),
      items: lines,
      purchaseRequests: linked.map((p) => ({ ...p, reqNo: p.code, remarks: p.purpose })),
      history: hist.map((h) => ({ ...h, userName: h.byUserName })),
    }
  })
}

// ---------- requisitions ----------

route("requisitions.list", {
  perm: REQ_VIEW,
  handler: async (ctx, p) => {
    // EMPLOYEE role: own requisitions only (self-enforced server-side)
    const selfOnly = ctx.role === "EMPLOYEE" || !ctx.permissions.has("procurement.view")
    const where: any = selfOnly ? { vendorId: ctx.vendorId, employeeId: ctx.employeeId || "none" } : { vendorId: ctx.vendorId }
    if (p?.status) where.status = p.status
    if (p?.priority) where.priority = p.priority
    if (p?.branchId) where.branchId = p.branchId
    if (p?.departmentId) where.departmentId = p.departmentId
    if (p?.employeeId) where.employeeId = p.employeeId
    if (p?.fromDate || p?.toDate) {
      where.createdAt = {}
      if (p?.fromDate) where.createdAt.gte = new Date(p.fromDate + "T00:00:00")
      if (p?.toDate) where.createdAt.lte = new Date(p.toDate + "T23:59:59")
    }
    const rows = await db.goodsRequisition.findMany({ where, orderBy: { createdAt: "desc" }, take: 500 })
    const decorated = await decorateRequisitions(rows)
    // item-level filters (post-decoration — needs item names)
    if (p?.itemName) {
      const q = String(p.itemName).toLowerCase()
      return decorated.filter((r: any) => r.items.some((i: any) => i.itemName.toLowerCase().includes(q)))
    }
    return decorated
  },
})

  // INTENTIONALLY_SELF_SCOPED (M-02): returns only requisitions the caller created
route("requisitions.mine", {
  handler: async (ctx) => {
    if (!ctx.employeeId) throw new Deny("No employee record is linked to this account", 403)
    const rows = await db.goodsRequisition.findMany({
      where: { vendorId: ctx.vendorId, employeeId: ctx.employeeId },
      orderBy: { createdAt: "desc" }, take: 100,
    })
    return decorateRequisitions(rows)
  },
})

/** Light item picker for requisition dialogs (catalogue items, active only). */
route("requisitions.itemOptions", {
  // M-02 — the item catalogue is procurement data: gate like every other
  // requisition read action.
  perm: ["procurement", "view"],
  handler: async (ctx) => {
    const items = await db.item.findMany({
      where: { vendorId: ctx.vendorId, active: true },
      orderBy: { name: "asc" }, take: 500,
      select: { id: true, name: true, code: true, category: true, unit: true },
    })
    return items
  },
})

route("requisitions.get", {
  perm: REQ_VIEW,
  handler: async (ctx, p) => {
    const row = await db.goodsRequisition.findFirst({ where: { id: p?.id, vendorId: ctx.vendorId } })
    if (!row) throw new Deny("Requisition not found", 404)
    if (ctx.role === "EMPLOYEE" && row.employeeId !== ctx.employeeId) throw new Deny("Not your requisition", 403)
    const [decorated] = await decorateRequisitions([row])
    const stockEntries = await db.stockEntry.findMany({
      where: { vendorId: ctx.vendorId }, select: { id: true, code: true, purchaseId: true, entryDate: true },
    })
    return {
      ...decorated,
      linkedStockEntries: stockEntries.filter((s) => decorated.purchaseRequests.some((pr: any) => pr.id === s.purchaseId)),
    }
  },
})

route("requisitions.create", {
  perm: REQ_EDIT,
  handler: async (ctx, p) => {
    const items: any[] = Array.isArray(p?.items) ? p.items : []
    if (items.length === 0) throw new Deny("Add at least one item", 400)
    for (const it of items) {
      if (!it?.itemName || !(Number(it.quantity) > 0)) throw new Deny("Every item needs a name and a positive quantity", 400)
    }
    const submitNow = p?.submit === true
    // EMPLOYEE can only request for themselves
    let employeeId = ctx.employeeId
    if (p?.employeeId && ctx.role !== "EMPLOYEE") {
      const emp = await assertEmployeeVisible(ctx, p.employeeId)
      employeeId = emp.id
    }
    if (!employeeId) throw new Deny("No employee record is linked to this account — ask HR to request on your behalf", 403)
    // M-14 — idempotency guard: a double-clicked submit creates exactly ONE
    // requisition. Same requester + same first item + same purpose within the
    // duplicate window is rejected with the existing code (409).
    if (employeeId && items.length) {
      const recent = await db.goodsRequisition.findFirst({
        where: {
          vendorId: ctx.vendorId, employeeId,
          createdAt: { gte: new Date(Date.now() - 90_000) },
          status: { in: ["DRAFT", "PENDING_APPROVAL"] },
        },
        orderBy: { createdAt: "desc" },
      })
      if (recent) {
        const recentItems = await db.goodsRequisitionItem.findMany({ where: { vendorId: ctx.vendorId, requisitionId: recent.id } })
        const sameFirst = recentItems[0]?.itemName === String(items[0].itemName).trim()
          && Number(recentItems[0]?.quantity) === Number(items[0].quantity)
        const samePurpose = (recent.purpose || null) === (p?.purpose || null)
        if (sameFirst && samePurpose) {
          throw new Deny(`An identical requisition (${recent.code}) was just created — no duplicate created`, 409)
        }
      }
    }
    const emp = await db.employee.findUnique({ where: { id: employeeId } })

    const code = await nextCode(ctx.vendorId, "GR", "goodsRequisition")
    const rec = await db.$transaction(async (tx) => {
      const r = await tx.goodsRequisition.create({
        data: {
          vendorId: ctx.vendorId, code, employeeId,
          branchId: emp?.branchId || null, departmentId: emp?.departmentId || null,
          priority: ["URGENT", "NORMAL", "LOW"].includes(p?.priority) ? p.priority : "NORMAL",
          neededBy: p?.requiredDate || p?.neededBy || null, purpose: p?.purpose || null,
          status: submitNow ? "PENDING_APPROVAL" : "DRAFT",
        },
      })
      await tx.goodsRequisitionItem.createMany({
        data: items.map((it) => ({
          vendorId: ctx.vendorId, // DB-02 (R5)
          requisitionId: r.id, itemId: it.itemId || null, itemName: String(it.itemName).trim(),
          specification: it.specification || null, quantity: Number(it.quantity),
          remarks: it.remarks || null,
        })),
      })
      await tx.goodsRequisitionHistory.create({
        data: {
          vendorId: ctx.vendorId, // DB-02 (R5)
          requisitionId: r.id, action: "CREATED",
          note: `${items.length} item(s) — ${submitNow ? "submitted for approval" : "saved as draft"}`,
          byUserId: ctx.userId, byUserName: ctx.userName,
        },
      })
      return r
    })

    if (submitNow) {
      // SoD escape: the requesting HR user is recorded as "requisitioner:<user>"
      // so they can still APPROVE it (the creator is not the requester).
      const approvalId = await submitForApproval(ctx, "GOODS_REQUISITION", "GoodsRequisition", rec.id,
        `Goods requisition ${code} (${items.length} item${items.length > 1 ? "s" : ""})`,
        { employeeId, requisitioner: `requisitioner:${ctx.userId}` })
      await db.goodsRequisition.update({ where: { id: rec.id }, data: { approvalRequestId: approvalId } })
    }
    await audit(ctx, "requisitions.create", "GoodsRequisition", rec.id, `Created ${code} — ${items.length} item(s)`)
    return { id: rec.id, code, reqNo: code, status: submitNow ? "PENDING_APPROVAL" : "DRAFT" }
  },
})

route("requisitions.update", {
  perm: REQ_EDIT,
  handler: async (ctx, p) => {
    const rec = await db.goodsRequisition.findFirst({ where: { id: p?.id, vendorId: ctx.vendorId } })
    if (!rec) throw new Deny("Requisition not found", 404)
    if (ctx.role === "EMPLOYEE" && rec.employeeId !== ctx.employeeId) throw new Deny("Not your requisition", 403)
    if (!["DRAFT", "RETURNED"].includes(rec.status)) throw new Deny(`Only DRAFT or RETURNED requisitions can be edited (current: ${rec.status})`, 400)
    const items: any[] = Array.isArray(p?.items) ? p.items : []
    if (items.length === 0) throw new Deny("Add at least one item", 400)
    // M-03 — update + submit is ONE backend action: the client used to chain
    // requisitions.update → requisitions.submit; a failure between the two
    // silently lost the submit half. p.submit sequences the submission on the
    // freshly-written rows within this same handler (approval request is
    // created post-commit, matching the requisitions.create pattern).
    const submitNow = p?.submit === true
    await db.$transaction(async (tx) => {
      await tx.goodsRequisition.update({
        where: { id: rec.id },
        data: {
          priority: ["URGENT", "NORMAL", "LOW"].includes(p?.priority) ? p.priority : rec.priority,
          neededBy: p?.requiredDate || p?.neededBy || null, purpose: p?.purpose || null,
        },
      })
      await tx.goodsRequisitionItem.deleteMany({ where: { requisitionId: rec.id } })
      await tx.goodsRequisitionItem.createMany({
        data: items.map((it) => ({
          vendorId: ctx.vendorId, // DB-02 (R5)
          requisitionId: rec.id, itemId: it.itemId || null, itemName: String(it.itemName).trim(),
          specification: it.specification || null, quantity: Number(it.quantity), remarks: it.remarks || null,
        })),
      })
    })
    if (submitNow) {
      const approvalId = await submitForApproval(ctx, "GOODS_REQUISITION", "GoodsRequisition", rec.id,
        `Goods requisition ${rec.code} (${items.length} item(s))`, { employeeId: rec.employeeId, requisitioner: `requisitioner:${ctx.userId}` })
      await db.goodsRequisition.update({ where: { id: rec.id }, data: { status: "PENDING_APPROVAL", approvalRequestId: approvalId } })
    }
    await reqHistory(ctx.vendorId, rec.id, submitNow ? "SUBMITTED" : "UPDATED", submitNow ? "Edited and submitted for approval" : "Edited before submission", ctx)
    await audit(ctx, "requisitions.update", "GoodsRequisition", rec.id, submitNow ? `Updated and submitted ${rec.code}` : `Updated ${rec.code}`)
    return submitNow ? { updated: true, submitted: true, status: "PENDING_APPROVAL" } : { updated: true }
  },
})

route("requisitions.submit", {
  perm: REQ_EDIT,
  handler: async (ctx, p) => {
    const rec = await db.goodsRequisition.findFirst({ where: { id: p?.id, vendorId: ctx.vendorId } })
    if (!rec) throw new Deny("Requisition not found", 404)
    if (ctx.role === "EMPLOYEE" && rec.employeeId !== ctx.employeeId) throw new Deny("Not your requisition", 403)
    if (!["DRAFT", "RETURNED"].includes(rec.status)) throw new Deny(`Cannot submit from status ${rec.status}`, 400)
    const items = await db.goodsRequisitionItem.findMany({ where: { vendorId: ctx.vendorId, requisitionId: rec.id } })
    if (items.length === 0) throw new Deny("Add at least one item before submitting", 400)
    const approvalId = await submitForApproval(ctx, "GOODS_REQUISITION", "GoodsRequisition", rec.id,
      `Goods requisition ${rec.code} (${items.length} item(s))`, { employeeId: rec.employeeId, requisitioner: `requisitioner:${ctx.userId}` })
    await db.goodsRequisition.update({ where: { id: rec.id }, data: { status: "PENDING_APPROVAL", approvalRequestId: approvalId } })
    await reqHistory(ctx.vendorId, rec.id, "SUBMITTED", "Submitted for approval", ctx)
    await audit(ctx, "requisitions.submit", "GoodsRequisition", rec.id, `Submitted ${rec.code}`)
    return { submitted: true, status: "PENDING_APPROVAL" }
  },
})

/** Approve / Reject / Return a PENDING requisition (per-step, engine-driven). */
route("requisitions.action", {
  perm: REQ_APPROVE,
  handler: async (ctx, p) => {
    const rec = await db.goodsRequisition.findFirst({ where: { id: p?.id, vendorId: ctx.vendorId } })
    if (!rec) throw new Deny("Requisition not found", 404)
    const decision = String(p?.decision || "").toUpperCase()
    if (!["APPROVE", "REJECT", "RETURN"].includes(decision)) throw new Deny("decision must be APPROVE, REJECT or RETURN", 400)
    const comment = p?.comment ? String(p.comment) : undefined

    if (decision === "RETURN") {
      if (rec.status !== "PENDING_APPROVAL") throw new Deny(`Only requisitions awaiting approval can be returned (current: ${rec.status})`, 400)
      if (!rec.approvalRequestId) throw new Deny("No approval request is linked to this requisition", 400)
      const arId = rec.approvalRequestId // L-32 — explicit, no non-null assertion
      // cancel the in-flight approval request (engine has no RETURN — this is the
      // procurement-specific "return for correction" path)
      await db.$transaction(async (tx) => {
        await tx.approvalRequest.updateMany({ where: { id: arId, status: "PENDING" }, data: { status: "CANCELLED", completedAt: new Date() } })
        await tx.approvalAction.create({
          data: { vendorId: ctx.vendorId, requestId: arId, step: 1, userId: ctx.userId, userName: ctx.userName, action: "CANCEL", comment: comment || "Returned for correction" },
        })
      })
      await db.goodsRequisition.update({ where: { id: rec.id }, data: { status: "RETURNED", decisionNote: comment || null } })
      await reqHistory(ctx.vendorId, rec.id, "RETURNED", comment || "Returned for correction", ctx, "PENDING_APPROVAL", "RETURNED")
      await notify(ctx.vendorId, { employeeId: rec.employeeId }, "Requisition Returned",
        `Your goods requisition ${rec.code} was returned for correction${comment ? `: ${comment}` : ""}.`, "GOODS_REQUISITION", "ess")
      return { status: "RETURNED" }
    }

    if (rec.status !== "PENDING_APPROVAL") throw new Deny(`Requisition is not awaiting approval (current: ${rec.status})`, 400)
    if (!rec.approvalRequestId) throw new Deny("No approval request is linked to this requisition", 400)
    const res = await actOnRequest(ctx, rec.approvalRequestId, decision === "APPROVE" ? "APPROVE" : "REJECT", comment)
    const after = await db.goodsRequisition.findUnique({ where: { id: rec.id } })
    return { status: after?.status || (res as any).status, approvalStatus: (res as any).status }
  },
})

// ---------- stock issue (FIFO across warehouses) ----------

/** Issue every line of an approved/stock-available requisition from inventory. */
export async function issueRequisition(ctx: any, requisitionId: string) {
  const rec = await db.goodsRequisition.findFirst({ where: { id: requisitionId, vendorId: ctx.vendorId } })
  if (!rec) throw new Deny("Requisition not found", 404)
  if (!["APPROVED", "STOCK_AVAILABLE", "PURCHASE_REQUIRED", "PENDING_STOCK"].includes(rec.status)) {
    throw new Deny(`Cannot issue goods from status ${rec.status}`, 400)
  }
  const lines = await db.goodsRequisitionItem.findMany({ where: { vendorId: ctx.vendorId, requisitionId: rec.id } })
  const levels = await db.stockLevel.findMany({ where: { vendorId: ctx.vendorId } })
  const warehouses = await db.warehouse.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { name: "asc" } })

  // pre-check: every line must be fully coverable
  const remainingOf = (itemId: string) => levels.filter((l) => l.itemId === itemId).reduce((s, l) => s + (l.quantity - l.reserved), 0)
  for (const l of lines) {
    const pending = l.quantity - l.issuedQuantity
    if (pending <= 0) continue
    if (!l.itemId) throw new Deny(`"${l.itemName}" is a catalogue-less item — receive it through a purchase first (spec §9)`)
    const free = remainingOf(l.itemId)
    if (free < pending) throw new Deny(`Shortage for "${l.itemName}": need ${pending}, available ${free}. Receive stock or wait for the purchase.`)
  }

  const issuedLines: { itemName: string; quantity: number }[] = []
  await db.$transaction(async (tx) => {
    const claimed = await tx.goodsRequisition.updateMany({
      where: { id: rec.id, status: { in: ["APPROVED", "STOCK_AVAILABLE", "PURCHASE_REQUIRED", "PENDING_STOCK"] } },
      data: { status: "ISSUED" },
    })
    if (claimed.count === 0) throw new Deny("Requisition was just issued by someone else — refresh the list")

    for (const line of lines) {
      let pending = line.quantity - line.issuedQuantity
      if (pending <= 0) continue
      // FIFO: deduct across warehouses in stable order until the line is filled
      for (const wh of warehouses) {
        if (pending <= 0) break
        const itemId = line.itemId // L-32 — explicit null check, no assertion
        if (!itemId) continue
        const level = await tx.stockLevel.findUnique({ where: { itemId_warehouseId: { itemId, warehouseId: wh.id } } })
        if (!level) continue
        const free = level.quantity - level.reserved
        if (free <= 0) continue
        const take = Math.min(free, pending)
        const newQty = level.quantity - take
        await tx.stockLevel.update({ where: { id: level.id }, data: { quantity: newQty } })
        await tx.stockTransaction.create({
          data: {
            vendorId: ctx.vendorId, itemId, warehouseId: wh.id,
            kind: "ISSUE", quantity: -take, balanceAfter: newQty,
            refType: "GOODS_REQUISITION", refId: rec.id, note: `Issued on ${rec.code}`,
            byUserId: ctx.userId, byUserName: ctx.userName,
          },
        })
        pending -= take
      }
      const issuedQty = line.quantity - line.issuedQuantity
      await tx.goodsRequisitionItem.update({ where: { id: line.id }, data: { issuedQuantity: line.quantity } })
      issuedLines.push({ itemName: line.itemName, quantity: issuedQty })

      // If item is returnable, issue it as a tracked company asset assigned to the requesting employee
      if (line.itemId && rec.employeeId && issuedQty > 0) {
        const itemRec = await tx.item.findUnique({ where: { id: line.itemId } })
        if (itemRec?.isReturnable) {
          for (let k = 0; k < issuedQty; k++) {
            const availableSerial = await tx.inventoryItemSerial.findFirst({
              where: { vendorId: ctx.vendorId, itemId: itemRec.id, status: "AVAILABLE" },
            })
            const astCode = await nextFormattedSeq(ctx.vendorId, "asset-code", (n) => `AST-${String(n).padStart(4, "0")}`)
            const asset = await tx.asset.create({
              data: {
                vendorId: ctx.vendorId,
                code: astCode,
                name: itemRec.name,
                category: itemRec.category || "OTHER",
                brandModel: availableSerial?.brandModel || itemRec.brandModel,
                serialImei: availableSerial?.serialNumber || itemRec.serialImei,
                purchaseDate: availableSerial?.purchaseDate || itemRec.purchaseDate,
                warrantyExpiry: availableSerial?.warrantyExpiry || itemRec.warrantyExpiry,
                purchaseCost: (availableSerial?.unitCost && availableSerial.unitCost > 0) ? availableSerial.unitCost : (itemRec.lastCost > 0 ? itemRec.lastCost : null),
                condition: "NEW",
                status: "ASSIGNED",
                sourceItemId: itemRec.id,
                notes: `Issued via Goods Requisition ${rec.code} (Returnable Company Asset)`,
              },
            })
            if (availableSerial) {
              await tx.inventoryItemSerial.update({
                where: { id: availableSerial.id },
                data: { status: "ISSUED", assetId: asset.id, employeeId: rec.employeeId },
              })
            }
            const assignment = await tx.assetAssignment.create({
              data: {
                vendorId: ctx.vendorId,
                assetId: asset.id,
                employeeId: rec.employeeId,
                conditionOut: "NEW",
                note: `Issued via Goods Requisition ${rec.code}`,
                issuedById: ctx.userId,
              },
            })
            await tx.assetEvent.create({
              data: {
                vendorId: ctx.vendorId,
                assetId: asset.id,
                type: "ASSIGN",
                actorId: ctx.userId,
                actorName: ctx.userName,
                snapshotJson: JSON.stringify({
                  assignmentId: assignment.id,
                  employeeId: rec.employeeId,
                  source: `requisition:${rec.code}`,
                }).slice(0, 4000),
                note: `Issued via Goods Requisition ${rec.code}`,
              },
            })
          }
        }
      }
    }
  })

  await reqHistory(ctx.vendorId, rec.id, "ISSUED", `${issuedLines.length} item(s) issued from stock`, ctx)
  await audit(ctx, "requisitions.issue", "GoodsRequisition", rec.id, `Issued goods on ${rec.code} — ${issuedLines.length} line(s) deducted`)
  await notify(ctx.vendorId, { employeeId: rec.employeeId }, "Goods Issued — Please Confirm Receipt",
    `Your goods requisition ${rec.code} has been issued. Open My Self-Service → My Requisitions to confirm receipt.`, "GOODS_REQUISITION", "ess")
  return { issuedLines, status: "ISSUED" }
}

route("requisitions.issue", {
  perm: REQ_APPROVE,
  handler: async (ctx, p) => issueRequisition(ctx, String(p?.id || "")),
})

// ---------- employee receipt confirmation ----------

  // INTENTIONALLY_SELF_SCOPED (M-02): handler verifies the caller is the recorded receiver before confirming receipt
route("requisitions.receive", {
  handler: async (ctx, p) => {
    if (!ctx.employeeId) throw new Deny("No employee record is linked to this account", 403)
    const rec = await db.goodsRequisition.findFirst({ where: { id: p?.id, vendorId: ctx.vendorId } })
    if (!rec) throw new Deny("Requisition not found", 404)
    if (rec.employeeId !== ctx.employeeId && ctx.role !== "EMPLOYEE") {
      // HR confirming on behalf is allowed (procurement approve); employees only for themselves
      if (!ctx.permissions.has("procurement.approve")) throw new Deny("Not your requisition", 403)
    } else if (rec.employeeId !== ctx.employeeId) {
      throw new Deny("Not your requisition", 403)
    }
    if (rec.status !== "ISSUED" && rec.status !== "PENDING_RECEIPT_CONFIRMATION") {
      throw new Deny(`Receipt can only be confirmed after issue (current: ${rec.status})`, 400)
    }
    const decision = String(p?.decision || "CONFIRM").toUpperCase() === "DISPUTE" ? "DISPUTE" : "CONFIRM"
    if (decision === "CONFIRM") {
      await db.goodsRequisition.update({ where: { id: rec.id }, data: { status: "COMPLETED" } })
      await reqHistory(ctx.vendorId, rec.id, "RECEIVED", p?.remark || "Receipt confirmed by employee", ctx, "ISSUED", "COMPLETED")
      await audit(ctx, "requisitions.receive", "GoodsRequisition", rec.id, `Receipt confirmed for ${rec.code}`)
      return { status: "COMPLETED" }
    }
    await db.goodsRequisition.update({ where: { id: rec.id }, data: { status: "RECEIPT_DISPUTED" } })
    await reqHistory(ctx.vendorId, rec.id, "DISPUTED", p?.remark || "Receipt disputed by employee", ctx, "ISSUED", "RECEIPT_DISPUTED")
    await audit(ctx, "requisitions.receive", "GoodsRequisition", rec.id, `Receipt DISPUTED for ${rec.code}`)
    await notify(ctx.vendorId, { role: "HR_ADMIN" }, "Goods Receipt Disputed",
      `Employee disputed receipt of requisition ${rec.code}${p?.remark ? `: ${p.remark}` : ""}.`, "GOODS_REQUISITION", "procurement")
    return { status: "RECEIPT_DISPUTED" }
  },
})

route("requisitions.cancel", {
  perm: REQ_EDIT,
  handler: async (ctx, p) => {
    const rec = await db.goodsRequisition.findFirst({ where: { id: p?.id, vendorId: ctx.vendorId } })
    if (!rec) throw new Deny("Requisition not found", 404)
    if (ctx.role === "EMPLOYEE" && rec.employeeId !== ctx.employeeId) throw new Deny("Not your requisition", 403)
    if (["ISSUED", "COMPLETED", "CANCELLED"].includes(rec.status)) throw new Deny(`Cannot cancel from status ${rec.status}`, 400)
    await db.$transaction(async (tx) => {
      // cancel the in-flight approval request, if any
      if (rec.approvalRequestId) {
        await tx.approvalRequest.updateMany({ where: { id: rec.approvalRequestId, status: "PENDING" }, data: { status: "CANCELLED", completedAt: new Date() } })
      }
      // cancel linked open purchase requests created for the shortfall
      const openPRs = await tx.purchaseRequest.findMany({
        where: { vendorId: ctx.vendorId, requisitionId: rec.id, status: { in: ["DRAFT", "PENDING_APPROVAL", "APPROVED", "QUOTATION_COLLECTION", "PENDING_STOCK_ENTRY"] } },
      })
      for (const pr of openPRs) {
        await tx.purchaseRequest.update({ where: { id: pr.id }, data: { status: "CANCELLED" } })
      }
      await tx.goodsRequisition.update({ where: { id: rec.id }, data: { status: "CANCELLED" } })
    })
    await reqHistory(ctx.vendorId, rec.id, "CANCELLED", p?.reason || "Cancelled", ctx)
    await audit(ctx, "requisitions.cancel", "GoodsRequisition", rec.id, `Cancelled ${rec.code}`)
    return { cancelled: true }
  },
})

// ---------- purchase requests ----------

async function decoratePurchases(rows: any[]) {
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)
  const [items, quotes, reqs, emps] = await Promise.all([
    db.purchaseRequestItem.findMany({ where: { purchaseId: { in: ids } } }),
    db.purchaseQuotation.findMany({ where: { purchaseId: { in: ids } } }),
    db.goodsRequisition.findMany({ where: { vendorId: rows[0].vendorId }, select: { id: true, code: true, employeeId: true } }),
    db.employee.findMany({ where: { vendorId: rows[0].vendorId }, select: { id: true, fullName: true } }), // R2a-002/D1-001: scoped to tenant
  ])
  const itemIds = [...new Set(items.map((i) => i.itemId).filter(Boolean))] as string[]
  const itemRows = itemIds.length ? await db.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, unit: true } }) : []
  return rows.map((r) => {
    const linkedReq = reqs.find((q) => q.id === r.requisitionId)
    const myQuotes = quotes.filter((q) => q.purchaseId === r.id)
    const lines = items.filter((i) => i.purchaseId === r.id).map((i) => ({
      ...i, purchaseQty: i.quantity, unit: itemRows.find((x) => x.id === i.itemId)?.unit || "Pcs",
    }))
    return {
      ...r,
      // UI aliases (verified purchase view contract)
      reqNo: r.code,
      goodsReqNo: linkedReq?.code || "",
      employeeName: emps.find((e) => e.id === (linkedReq?.employeeId || r.requestedBy))?.fullName || "—",
      remarks: r.purpose || "",
      items: lines,
      quotationCount: myQuotes.length,
      totalAmount: r.totalValue,
      quotations: myQuotes.map((q) => ({
        ...q,
        totalAmount: q.total,
        quotationDate: q.quotationDate || q.createdAt?.toISOString?.().slice(0, 10) || null,
      })),
      selectedQuotationId: myQuotes.find((q) => q.status === "SELECTED")?.id || null,
    }
  })
}

route("purchase.list", {
  perm: REQ_VIEW,
  handler: async (ctx, p) => {
    const where: any = { vendorId: ctx.vendorId }
    if (p?.status) where.status = p.status
    if (p?.requisitionId) where.requisitionId = p.requisitionId
    const rows = await db.purchaseRequest.findMany({ where, orderBy: { createdAt: "desc" }, take: 500 })
    return decoratePurchases(rows)
  },
})

// legacy plural alias (older UI calls)
route("purchases.list", {
  perm: REQ_VIEW,
  handler: async (ctx, p) => {
    const where: any = { vendorId: ctx.vendorId }
    if (p?.status) where.status = p.status
    const rows = await db.purchaseRequest.findMany({ where, orderBy: { createdAt: "desc" }, take: 500 })
    return decoratePurchases(rows)
  },
})

route("purchase.get", {
  perm: REQ_VIEW,
  handler: async (ctx, p) => {
    const row = await db.purchaseRequest.findFirst({ where: { id: p?.id, vendorId: ctx.vendorId } })
    if (!row) throw new Deny("Purchase request not found", 404)
    const [decorated] = await decoratePurchases([row])
    const entries = await db.stockEntry.findMany({ where: { vendorId: ctx.vendorId, purchaseId: row.id } })
    return { ...decorated, stockEntries: entries.map((e) => ({ ...e, entryNo: e.code })) }
  },
})

route("purchases.get", {
  perm: REQ_VIEW,
  handler: async (ctx, p) => {
    const row = await db.purchaseRequest.findFirst({ where: { id: p?.id, vendorId: ctx.vendorId } })
    if (!row) throw new Deny("Purchase request not found", 404)
    const [decorated] = await decoratePurchases([row])
    return decorated
  },
})

route("purchase.create", {
  perm: REQ_EDIT,
  handler: async (ctx, p) => {
    const items: any[] = Array.isArray(p?.items) ? p.items : []
    if (items.length === 0) throw new Deny("Add at least one item", 400)
    for (const it of items) {
      if (!it?.itemName || !(Number(it.quantity) > 0)) throw new Deny("Every item needs a name and a positive quantity", 400)
    }
    let requestedBy = ctx.employeeId
    if (p?.requestedBy && ctx.role !== "EMPLOYEE") {
      const emp = await assertEmployeeVisible(ctx, p.requestedBy)
      requestedBy = emp.id
    }
    if (!requestedBy) throw new Deny("A requesting employee is required", 400)
    if (p?.requisitionId) {
      const req = await db.goodsRequisition.findFirst({ where: { id: p.requisitionId, vendorId: ctx.vendorId } })
      if (!req) throw new Deny("Linked requisition not found", 404)
    }
    const code = await nextCode(ctx.vendorId, "PR", "purchaseRequest")
    const submitNow = p?.submit === true
    const rec = await db.$transaction(async (tx) => {
      const r = await tx.purchaseRequest.create({
        data: {
          vendorId: ctx.vendorId, code, requisitionId: p?.requisitionId || null, requestedBy,
          purpose: p?.purpose || null, status: submitNow ? "PENDING_APPROVAL" : "DRAFT",
        },
      })
      await tx.purchaseRequestItem.createMany({
        data: items.map((it) => ({
          vendorId: ctx.vendorId, // DB-02 (R5)
          purchaseId: r.id, itemId: it.itemId || null, itemName: String(it.itemName).trim(),
          specification: it.specification || null, quantity: Number(it.quantity),
          estimatedUnitPrice: Number(it.estimatedUnitPrice) || 0, remarks: it.remarks || null,
        })),
      })
      return r
    })
    if (submitNow) {
      const approvalId = await submitForApproval(ctx, "PURCHASE", "PurchaseRequest", rec.id,
        `Purchase request ${code} (${items.length} item(s))`, { purchaser: `purchaser:${ctx.userId}` })
      await db.purchaseRequest.update({ where: { id: rec.id }, data: { approvalRequestId: approvalId } })
    }
    await audit(ctx, "purchase.create", "PurchaseRequest", rec.id, `Created ${code} — ${items.length} item(s)`)
    return { id: rec.id, code, reqNo: code, status: rec.status }
  },
})

route("purchase.submit", {
  perm: REQ_EDIT,
  handler: async (ctx, p) => {
    const rec = await db.purchaseRequest.findFirst({ where: { id: p?.id, vendorId: ctx.vendorId } })
    if (!rec) throw new Deny("Purchase request not found", 404)
    if (!["DRAFT", "QUOTATION_COLLECTION"].includes(rec.status)) throw new Deny(`Cannot submit from status ${rec.status}`, 400)
    const approvalId = await submitForApproval(ctx, "PURCHASE", "PurchaseRequest", rec.id,
      `Purchase request ${rec.code}`, { purchaser: `purchaser:${ctx.userId}` })
    await db.purchaseRequest.update({ where: { id: rec.id }, data: { status: "PENDING_APPROVAL", approvalRequestId: approvalId } })
    await audit(ctx, "purchase.submit", "PurchaseRequest", rec.id, `Submitted ${rec.code}`)
    return { submitted: true, status: "PENDING_APPROVAL" }
  },
})

route("purchase.action", {
  perm: REQ_APPROVE,
  handler: async (ctx, p) => {
    const rec = await db.purchaseRequest.findFirst({ where: { id: p?.id, vendorId: ctx.vendorId } })
    if (!rec) throw new Deny("Purchase request not found", 404)
    if (rec.status !== "PENDING_APPROVAL") throw new Deny(`Purchase request is not awaiting approval (current: ${rec.status})`, 400)
    if (!rec.approvalRequestId) throw new Deny("No approval request is linked to this purchase", 400)
    const decision = String(p?.decision || "").toUpperCase() === "REJECT" ? "REJECT" : "APPROVE"
    const res = await actOnRequest(ctx, rec.approvalRequestId, decision, p?.comment ? String(p.comment) : undefined)
    const after = await db.purchaseRequest.findUnique({ where: { id: rec.id } })
    return { status: after?.status || (res as any).status, approvalStatus: (res as any).status }
  },
})

route("purchase.cancel", {
  perm: REQ_EDIT,
  handler: async (ctx, p) => {
    const rec = await db.purchaseRequest.findFirst({ where: { id: p?.id, vendorId: ctx.vendorId } })
    if (!rec) throw new Deny("Purchase request not found", 404)
    if (["STOCK_ENTERED", "CANCELLED"].includes(rec.status)) throw new Deny(`Cannot cancel from status ${rec.status}`, 400)
    await db.$transaction(async (tx) => {
      const arId = rec.approvalRequestId // L-32 — explicit, no non-null assertion
      if (arId) {
        await tx.approvalRequest.updateMany({ where: { id: arId, status: "PENDING" }, data: { status: "CANCELLED", completedAt: new Date() } })
      }
      await tx.purchaseRequest.update({ where: { id: rec.id }, data: { status: "CANCELLED" } })
    })
    await audit(ctx, "purchase.cancel", "PurchaseRequest", rec.id, `Cancelled ${rec.code}`)
    return { cancelled: true }
  },
})

// ---------- quotations ----------

route("purchase.quotations.add", {
  perm: REQ_EDIT,
  handler: async (ctx, p) => {
    const pr = await db.purchaseRequest.findFirst({ where: { id: p?.purchaseId || p?.id, vendorId: ctx.vendorId } })
    if (!pr) throw new Deny("Purchase request not found", 404)
    if (!["DRAFT", "QUOTATION_COLLECTION", "APPROVED"].includes(pr.status)) {
      throw new Deny(`Quotations can only be added while collecting (current: ${pr.status})`, 400)
    }
    const supplierId = p?.supplierId || null
    let supplierName = String(p?.supplierName || "").trim()
    if (supplierId) {
      const supplier = await db.supplier.findFirst({ where: { id: supplierId, vendorId: ctx.vendorId } })
      if (!supplier) throw new Deny("Supplier not found", 404)
      supplierName = supplier.name
    }
    if (!supplierName) throw new Deny("Pick a supplier or type a name", 400)
    const items: any[] = Array.isArray(p?.items) ? p.items : []
    if (items.length === 0) throw new Deny("Add at least one quoted item", 400)
    const itemsTotal = items.reduce((s, it) =>
      s + Math.max(0, Number(it.quantity) * Number(it.unitPrice || 0) - Number(it.discount || 0) + Number(it.vatTax || 0)), 0)
    const deliveryCharge = Math.max(0, Number(p?.deliveryCharge || 0))
    const total = Math.round((itemsTotal + deliveryCharge) * 100) / 100

    const rec = await db.$transaction(async (tx) => {
      const q = await tx.purchaseQuotation.create({
        data: {
          vendorId: ctx.vendorId, purchaseId: pr.id, supplierId: supplierId || "",
          supplierName,
          quotationNo: p?.quotationNo || null, quotationDate: p?.quotationDate || null,
          total, deliveryTime: p?.deliveryTime || null, paymentTerms: p?.paymentTerms || null,
          deliveryCharge, notes: p?.notes || null,
        },
      })
      await tx.purchaseQuotationItem.createMany({
        data: items.map((it) => ({
          vendorId: ctx.vendorId, // DB-02 (R5)
          quotationId: q.id, itemId: it.itemId || null, itemName: String(it.itemName).trim(),
          quantity: Number(it.quantity) || 1, unitPrice: Number(it.unitPrice) || 0,
          discount: Number(it.discount) || 0, vatTax: Number(it.vatTax) || 0,
        })),
      })
      // collecting quotations moves an approved PR into the collection stage
      if (pr.status === "APPROVED") {
        await tx.purchaseRequest.update({ where: { id: pr.id }, data: { status: "QUOTATION_COLLECTION" } })
      }
      return q
    })
    await audit(ctx, "purchase.quotations.add", "PurchaseQuotation", rec.id,
      `Quotation from ${supplierName} for ${pr.code} — ৳${total.toLocaleString("en-IN")}`)
    return { id: rec.id }
  },
})

route("purchase.quotations.select", {
  perm: REQ_EDIT,
  handler: async (ctx, p) => {
    const q = await db.purchaseQuotation.findFirst({ where: { id: p?.id, vendorId: ctx.vendorId } })
    if (!q) throw new Deny("Quotation not found", 404)
    if (q.status !== "SUBMITTED") throw new Deny(`Quotation already ${q.status}`, 400)
    const pr = await db.purchaseRequest.findUnique({ where: { id: q.purchaseId } })
    if (!pr || pr.vendorId !== ctx.vendorId) throw new Deny("Purchase request not found", 404)
    if (!["DRAFT", "QUOTATION_COLLECTION", "APPROVED"].includes(pr.status)) {
      throw new Deny(`Quotations can only be selected while the purchase is open (current: ${pr.status})`, 400)
    }
    await db.$transaction([
      db.purchaseQuotation.updateMany({ where: { purchaseId: q.purchaseId, status: "SUBMITTED" }, data: { status: "REJECTED" } }),
      db.purchaseQuotation.update({ where: { id: q.id }, data: { status: "SELECTED" } }),
      db.purchaseRequest.update({ where: { id: q.purchaseId }, data: { supplierId: q.supplierId || null, totalValue: q.total } }),
    ])
    await audit(ctx, "purchase.quotations.select", "PurchaseQuotation", q.id, `Selected ${q.supplierName}'s quotation for ${pr.code}`)
    return { selected: true }
  },
})

// ---------- one-click receive: stock entry created AND posted ----------

route("purchase.receiveStock", {
  perm: ["inventory", "approve"],
  handler: async (ctx, p) => {
    const pr = await db.purchaseRequest.findFirst({ where: { id: p?.id, vendorId: ctx.vendorId } })
    if (!pr) throw new Deny("Purchase request not found", 404)
    if (!["APPROVED", "QUOTATION_COLLECTION", "PENDING_STOCK_ENTRY"].includes(pr.status)) {
      throw new Deny(`Stock can only be received after approval (current: ${pr.status})`, 400)
    }
    const lines = await db.purchaseRequestItem.findMany({ where: { purchaseId: pr.id } })
    if (!lines.length) throw new Deny("This purchase request has no item lines", 400)

    // selected quotation pricing (if any) — fallback to the estimated price
    const selected = await db.purchaseQuotation.findFirst({ where: { purchaseId: pr.id, status: "SELECTED" }, include: { items: true } })
    const priceOf = (line: any) => {
      const quoted = selected?.items.find((qi) => (line.itemId && qi.itemId === line.itemId) || qi.itemName === line.itemName)
      return quoted ? quoted.unitPrice : (line.estimatedUnitPrice || 0)
    }
    // catalogue-less lines need an Item record before stock can exist
    const entryItems: { itemId: string; itemName: string; quantity: number; unitCost: number; remarks: string | null }[] = []
    for (const line of lines) {
      let itemId = line.itemId
      if (!itemId) {
        const existing = await db.item.findFirst({ where: { vendorId: ctx.vendorId, name: line.itemName } })
        if (existing) itemId = existing.id
        else {
          const code = await nextItemCode(ctx.vendorId)
          const created = await db.item.create({
            data: { vendorId: ctx.vendorId, code, name: line.itemName, category: "OTHER", unit: "Pcs", active: true },
          })
          itemId = created.id
        }
      }
      entryItems.push({ itemId, itemName: line.itemName, quantity: line.quantity, unitCost: priceOf(line), remarks: line.remarks })
    }

    const { saveStockEntry, postStockEntry } = await import("./inventory")
    const entry = await saveStockEntry(ctx, {
      purchaseId: pr.id, warehouseId: p?.warehouseId, supplierId: pr.supplierId || null,
      invoiceNo: p?.invoiceNo || null, entryDate: p?.receivedDate || p?.invoiceDate || null,
      remarks: `Received on purchase ${pr.code}`, items: entryItems,
    })
    await postStockEntry(ctx, entry.id)
    return { entryNo: entry.code, id: entry.id, status: "STOCK_ENTERED" }
  },
})

async function nextItemCode(vendorId: string) {
  const items = await db.item.findMany({ where: { vendorId }, select: { code: true } })
  let n = 1
  const used = new Set(items.map((i) => i.code))
  while (used.has(`ITM-${String(n).padStart(4, "0")}`)) n++
  return `ITM-${String(n).padStart(4, "0")}`
}

// ---------- shortage auto-PR + stock arrival re-check ----------

/** Create (and leave as DRAFT) a purchase request covering a requisition's shortfall. */
async function createShortagePurchase(ctx: any, rec: any, lines: any[], availableOf: Map<string, number>) {
  const shortLines = lines
    .map((l) => {
      const pending = l.quantity - l.issuedQuantity
      const free = l.itemId ? (availableOf.get(l.itemId) ?? 0) : 0
      const need = Math.max(0, pending - Math.max(0, free))
      return need > 0 ? { ...l, need } : null
    })
    .filter(Boolean) as any[]
  if (shortLines.length === 0) return null

  const code = await nextCode(ctx.vendorId, "PR", "purchaseRequest")
  const pr = await db.$transaction(async (tx) => {
    const r = await tx.purchaseRequest.create({
      data: {
        vendorId: ctx.vendorId, code, requisitionId: rec.id, requestedBy: rec.employeeId,
        purpose: `Shortage purchase for requisition ${rec.code}`,
        status: "DRAFT",
      },
    })
    await tx.purchaseRequestItem.createMany({
      data: shortLines.map((l) => ({
        vendorId: ctx.vendorId, // DB-02 (R5)
        purchaseId: r.id, itemId: l.itemId || null, itemName: l.itemName, specification: l.specification || null,
        quantity: l.need, remarks: `shortfall of ${l.quantity}`,
      })),
    })
    return r
  })
  await audit(ctx, "purchase.create", "PurchaseRequest", pr.id, `Auto-created shortage purchase ${code} for ${rec.code}`)
  await notify(ctx.vendorId, { role: "HR_ADMIN" }, "Shortage Purchase Needed",
    `Requisition ${rec.code} has a stock shortage — purchase request ${code} was created as a draft. Collect quotations and submit it for approval.`,
    "PURCHASE", "procurement")
  return pr
}

/** Called by inventory posting — re-evaluate waiting requisitions for the items
 *  that just arrived. Fully-coverable requisitions move to STOCK_AVAILABLE. */
export async function recheckRequisitionsForStock(ctx: any, itemIds: string[]) {
  if (!itemIds.length) return
  const waiting = await db.goodsRequisition.findMany({
    where: { vendorId: ctx.vendorId, status: { in: ["PENDING_STOCK", "PURCHASE_REQUIRED", "PENDING_PURCHASE"] } },
    take: 200,
  })
  if (!waiting.length) return
  const levels = await db.stockLevel.findMany({ where: { vendorId: ctx.vendorId }, select: { itemId: true, quantity: true, reserved: true } })
  const availableOf = new Map<string, number>()
  for (const l of levels) availableOf.set(l.itemId, (availableOf.get(l.itemId) || 0) + (l.quantity - l.reserved))

  const lines = await db.goodsRequisitionItem.findMany({ where: { vendorId: ctx.vendorId, requisitionId: { in: waiting.map((w) => w.id) } } })
  for (const rec of waiting) {
    const mine = lines.filter((l) => l.requisitionId === rec.id)
    if (!mine.some((l) => l.itemId && itemIds.includes(l.itemId))) continue
    const fullyCovered = mine.every((l) => {
      const pending = l.quantity - l.issuedQuantity
      if (pending <= 0) return true
      if (!l.itemId) return false
      return (availableOf.get(l.itemId) || 0) >= pending
    })
    if (!fullyCovered) continue
    await db.goodsRequisition.update({ where: { id: rec.id }, data: { status: "STOCK_AVAILABLE" } })
    await reqHistory(ctx.vendorId, rec.id, "STOCK_CHECK", "Purchased stock arrived — all items now available", ctx, rec.status, "STOCK_AVAILABLE")
    await notify(ctx.vendorId, { employeeId: rec.employeeId }, "Your Goods Are Ready",
      `All items of requisition ${rec.code} are now in stock — they will be issued to you.`, "GOODS_REQUISITION", "ess")
    await notify(ctx.vendorId, { role: "HR_ADMIN" }, "Requisition Ready to Issue",
      `Requisition ${rec.code} is fully coverable from stock — issue the goods when convenient.`, "GOODS_REQUISITION", "procurement")
  }
}

/** Approval-engine finalize hook: requisition fully approved / rejected. */
export async function applyGoodsRequisitionDecision(ctx: any, requisitionId: string, decision: "APPROVED" | "REJECTED") {
  const rec = await db.goodsRequisition.findFirst({ where: { id: requisitionId, vendorId: ctx.vendorId } })
  if (!rec) return
  if (decision === "REJECTED") {
    await db.goodsRequisition.update({ where: { id: rec.id }, data: { status: "REJECTED" } })
    await reqHistory(ctx.vendorId, rec.id, "REJECTED", "Rejected in approval workflow", ctx, "PENDING_APPROVAL", "REJECTED")
    return
  }
  // final approval → real-time stock re-validation
  const lines = await db.goodsRequisitionItem.findMany({ where: { vendorId: ctx.vendorId, requisitionId: rec.id } })
  const availableOf = await availableOfMap(ctx.vendorId)
  const fullyCovered = lines.every((l) => {
    const pending = l.quantity - l.issuedQuantity
    if (pending <= 0) return true
    if (!l.itemId) return false
    return (availableOf.get(l.itemId) || 0) >= pending
  })

  if (fullyCovered) {
    // everything on the shelf — issue immediately (transactional FIFO)
    await db.goodsRequisition.update({ where: { id: rec.id }, data: { status: "APPROVED" } })
    await reqHistory(ctx.vendorId, rec.id, "APPROVED", "Approved — stock available", ctx, "PENDING_APPROVAL", "APPROVED")
    await issueRequisition(ctx, rec.id)
  } else {
    // shortage — auto-create the shortfall purchase request, keep the requisition open
    await db.goodsRequisition.update({ where: { id: rec.id }, data: { status: "APPROVED" } })
    await reqHistory(ctx.vendorId, rec.id, "APPROVED", "Approved with shortage — purchase required", ctx, "PENDING_APPROVAL", "APPROVED")
    const pr = await createShortagePurchase(ctx, rec, lines, availableOf)
    await db.goodsRequisition.update({ where: { id: rec.id }, data: { status: "PURCHASE_REQUIRED" } })
    await reqHistory(ctx.vendorId, rec.id, "STOCK_CHECK", pr ? `Shortage purchase ${pr.code} created as draft` : "Shortage detected", ctx, "APPROVED", "PURCHASE_REQUIRED")
    await notify(ctx.vendorId, { employeeId: rec.employeeId }, "Requisition Approved — Purchase in Progress",
      `Your goods requisition ${rec.code} was approved, but some items are out of stock. A purchase request${pr ? ` (${pr.code})` : ""} was created to cover the shortage.`, "GOODS_REQUISITION", "ess")
  }
}

/** Approval-engine finalize hook: purchase request fully approved / rejected. */
export async function applyPurchaseDecision(ctx: any, purchaseId: string, decision: "APPROVED" | "REJECTED") {
  const rec = await db.purchaseRequest.findFirst({ where: { id: purchaseId, vendorId: ctx.vendorId } })
  if (!rec) return
  if (decision === "REJECTED") {
    await db.purchaseRequest.update({ where: { id: rec.id }, data: { status: "REJECTED" } })
    return
  }
  await db.purchaseRequest.update({ where: { id: rec.id }, data: { status: "APPROVED" } })
  await notify(ctx.vendorId, { role: "HR_ADMIN" }, "Purchase Approved",
    `Purchase request ${rec.code} is approved — collect quotations (if not yet) and receive the stock when it arrives.`, "PURCHASE", "procurement")
}

// legacy aliases used by older UI code paths
/** L-32 — paydown: dispatch to the canonical route WITHOUT a non-null
 *  assertion; an unregistered route name surfaces a 500 that names it. */
async function aliasDispatch(action: string, ctx: any, p: any) {
  const target = (await import("./registry")).getRoute(action)
  if (!target) throw new Deny(`Route ${action} is not registered`, 500)
  return target.handler(ctx, p)
}
route("purchases.create", {
  perm: REQ_EDIT,
  handler: async (ctx, p) => {
    const r = await aliasDispatch("purchase.create", ctx, p)
    return r
  },
})
route("purchases.submit", {
  perm: REQ_EDIT,
  handler: async (ctx, p) => {
    const r = await aliasDispatch("purchase.submit", ctx, p)
    return r
  },
})
route("purchases.cancel", {
  perm: REQ_EDIT,
  handler: async (ctx, p) => {
    const r = await aliasDispatch("purchase.cancel", ctx, p)
    return r
  },
})
route("purchases.quotations.add", {
  perm: REQ_EDIT,
  handler: async (ctx, p) => {
    const r = await aliasDispatch("purchase.quotations.add", ctx, p)
    return r
  },
})
route("purchases.quotations.select", {
  perm: REQ_EDIT,
  handler: async (ctx, p) => {
    const r = await aliasDispatch("purchase.quotations.select", ctx, p)
    return r
  },
})

// ---------- reports ----------

route("procurement.reports", {
  perm: REQ_VIEW,
  handler: async (ctx, p) => {
    const kind = p?.kind || "requisitions"
    if (kind === "requisitions") {
      const rows = await db.goodsRequisition.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { createdAt: "desc" }, take: 500 })
      return { columns: ["Requisition", "Employee", "Branch", "Priority", "Status", "Items", "Created"], rows: (await decorateRequisitions(rows)).map((r: any) => [r.code, r.employeeName, r.branchName || "—", r.priority, r.status, String(r.itemCount), new Date(r.createdAt).toISOString().slice(0, 10)]) }
    }
    if (kind === "pendingStages") {
      const pending = await db.approvalRequest.findMany({ where: { vendorId: ctx.vendorId, status: "PENDING", processType: { in: ["GOODS_REQUISITION", "PURCHASE"] } }, orderBy: { createdAt: "asc" }, take: 200 })
      return { columns: ["Request", "Process", "Requested By", "Current Step", "Stage", "Waiting Since"], rows: pending.map((r: any) => [r.entityRef, r.processType, r.requestedBy || "—", r.currentStep || "—", `${r.currentStep ?? "?"}/${r.totalSteps ?? "?"}`, new Date(r.updatedAt || r.createdAt).toISOString().slice(0, 10)]) }
    }
    if (kind === "purchaseRequirements") {
      const rows = await db.purchaseRequest.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { createdAt: "desc" }, take: 500 })
      const decorated = await decoratePurchases(rows)
      return { columns: ["PR", "For", "Status", "Value", "Created"], rows: decorated.map((r: any) => [r.code, r.employeeName, r.status, `৳${(r.totalValue || 0).toLocaleString("en-IN")}`, new Date(r.createdAt).toISOString().slice(0, 10)]) }
    }
    if (kind === "stockIssues") {
      const txs = await db.stockTransaction.findMany({ where: { vendorId: ctx.vendorId, kind: "ISSUE" }, orderBy: { createdAt: "desc" }, take: 500 })
      const [items, whs, reqs] = await Promise.all([
        db.item.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true, unit: true } }), // R2a-002: scoped
        db.warehouse.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } }), // R2a-002: scoped
        db.goodsRequisition.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, code: true } }),
      ])
      return {
        columns: ["Date", "Requisition", "Item", "Warehouse", "Qty", "Issued By"],
        rows: txs.filter((t) => t.refType === "GOODS_REQUISITION").map((t) => [
          new Date(t.createdAt).toISOString().slice(0, 10),
          reqs.find((r) => r.id === t.refId)?.code || "—",
          items.find((i) => i.id === t.itemId)?.name || "—",
          whs.find((w) => w.id === t.warehouseId)?.name || "—",
          `${Math.abs(t.quantity)} ${items.find((i) => i.id === t.itemId)?.unit || ""}`,
          t.byUserName || "—",
        ]),
      }
    }
    throw new Deny("Unknown report kind", 400)
  },
})
