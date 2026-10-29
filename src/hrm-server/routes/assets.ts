// ============ Wave 2 WP-K — Employee Asset Management routes ============
// Company assets (laptops, SIMs, ID cards, vehicles…) with a full lifecycle:
// register → assign → return → repair/retire/lose, one ACTIVE assignment per
// asset (enforced by the status=ASSIGNED invariant), every transition writes
// an append-only AssetEvent row and an audit log entry.
//
// Conventions (H-10 tenant isolation): every query is scoped by vendorId;
// cross-tenant ids resolve to 404. Asset codes are auto-generated (AST-0001)
// via the race-safe SequenceCounter and are LOCKED — clients may preview the
// next code (assets.nextCode) but can never set or edit one.
import { db } from "@/lib/db"
import { z } from "zod"
import { route } from "./registry"
import { Deny, assertEmployeeVisible } from "../rbac"
import { audit } from "../audit"
import { addDays, today } from "../utils"
import { isoDate, id } from "../validation"
import type { Ctx } from "../types"

const ASSET_CATEGORIES = [
  "LAPTOP", "DESKTOP", "MOBILE", "SIM", "ID_CARD", "ACCESS_CARD",
  "MONITOR", "VEHICLE", "FURNITURE", "OTHER",
] as const
const ASSET_CONDITIONS = ["NEW", "GOOD", "FAIR", "DAMAGED"] as const
const ASSET_STATUSES = ["IN_STOCK", "ASSIGNED", "RETURNED", "REPAIR", "RETIRED", "LOST"] as const
/** Statuses an asset can be assigned from — RETURNED counts as "back on the
 *  shelf" (re-issueable) exactly like IN_STOCK. */
const ASSIGNABLE_STATUSES: string[] = ["IN_STOCK", "RETURNED"]

// ---------- FormDialog-tolerant zod primitives (M-01) ----------
// FormDialog submits EVERY field: untouched text/number inputs arrive as ""
// and untouched selects as "". These normalize that reality instead of 400-ing
// (same pattern as validation.ts's internal dateOpt/numOpt/idBlankOpt).

/** "" (blank FormDialog field) → null; anything else passes through. */
const blankAsNull = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), schema)

/** Optional ISO date: blank → null (explicit clear on edit). */
const dateOpt = blankAsNull(isoDate.nullish())
/** Optional id (untouched select): blank → null. */
const idBlankOpt = blankAsNull(id.nullish())
/** Optional non-negative number: blank → null, numeric strings coerced. */
const numOpt = z.preprocess(
  (v) => {
    if (typeof v === "string") return v.trim() === "" ? null : Number(v)
    return v ?? null
  },
  z.number().finite().min(0).nullish(),
)
/** Optional enum (untouched select): blank → null. */
const enumOpt = <T extends readonly [string, ...string[]]>(values: T) =>
  blankAsNull(z.enum(values).nullish())
/** Optional text. */
const textOpt = (max = 500) => z.string().max(max).nullish()

type AssetRow = {
  id: string; vendorId: string; code: string; name: string; category: string
  brandModel: string | null; serialImei: string | null; purchaseDate: string | null
  purchaseCost: number | null; warrantyExpiry: string | null; condition: string
  status: string; branchId: string | null; locationNote: string | null
  sourceItemId: string | null; notes: string | null
  createdAt: Date; updatedAt: Date
}

/** Tenant-scoped asset fetch — cross-tenant ids are plain 404s (H-10). */
async function getAsset(ctx: Ctx, assetId: string): Promise<AssetRow> {
  const asset = await db.asset.findFirst({ where: { id: assetId, vendorId: ctx.vendorId } })
  if (!asset) throw new Deny("Asset not found", 404)
  return asset as AssetRow
}

/** Writable-asset payload shared by create/update. `code` and `status` are
 *  deliberately ABSENT: codes are server-generated and status only moves via
 *  the lifecycle actions (assign/return/repair/retire/lose) — the strict
 *  schema rejects any client attempt to smuggle them in. */
const assetFieldsSchema = {
  name: z.string().min(1).max(200),
  category: z.enum(ASSET_CATEGORIES),
  brandModel: textOpt(200),
  serialImei: textOpt(200),
  purchaseDate: dateOpt,
  purchaseCost: numOpt,
  warrantyExpiry: dateOpt,
  condition: enumOpt(ASSET_CONDITIONS),
  branchId: idBlankOpt,
  locationNote: textOpt(300),
  notes: textOpt(2000),
}

// ---------- next code (preview — does NOT consume a sequence number) ----------

route("assets.nextCode", {
  perm: ["assets", "create"],
  schema: z.object({}).strict(),
  handler: async (ctx) => {
    // PEEK, not allocate: opening the create dialog and cancelling must not
    // burn numbers. Read the current counter, then scan past any codes that
    // already exist (guards manually seeded AST- rows outside the counter).
    const seq = await db.sequenceCounter.findUnique({ where: { key: `${ctx.vendorId}:asset-code` } })
    const used = new Set(
      (await db.asset.findMany({ where: { vendorId: ctx.vendorId }, select: { code: true } })).map((a) => a.code),
    )
    let n = (seq?.value || 0) + 1
    while (used.has(`AST-${String(n).padStart(4, "0")}`)) n++
    return { code: `AST-${String(n).padStart(4, "0")}` }
  },
})

// ---------- list (filters + pagination + current assignment) ----------

const listSchema = z.object({
  category: enumOpt(ASSET_CATEGORIES),
  status: enumOpt(ASSET_STATUSES),
  branchId: idBlankOpt,
  employeeId: idBlankOpt,
  /** Assets whose warranty expires on/before this ISO date (nulls excluded). */
  warrantyExpiringBefore: dateOpt,
  q: textOpt(100),
  /** "warranty" → nearest warranty expiry first; default → code asc. */
  sortBy: enumOpt(["warranty", "code", "recent"] as const),
  page: z.number().int().min(1).nullish(),
  pageSize: z.number().int().min(1).max(200).nullish(),
}).strict()

route("assets.list", {
  perm: ["assets", "view"],
  schema: listSchema,
  handler: async (ctx, p) => {
    const v = p as z.infer<typeof listSchema>
    const where: Record<string, unknown> = { vendorId: ctx.vendorId }
    if (v.category) where.category = v.category
    if (v.status) where.status = v.status
    if (v.branchId) where.branchId = v.branchId
    if (v.warrantyExpiringBefore) where.warrantyExpiry = { not: null, lte: v.warrantyExpiringBefore }
    if (v.q) {
      where.OR = [
        { name: { contains: v.q, mode: "insensitive" } },
        { code: { contains: v.q, mode: "insensitive" } },
        { serialImei: { contains: v.q, mode: "insensitive" } },
        { brandModel: { contains: v.q, mode: "insensitive" } },
      ]
    }
    if (v.employeeId) {
      // employeeId filter = assets with an OUTSTANDING assignment to them
      const assignments = await db.assetAssignment.findMany({
        where: { vendorId: ctx.vendorId, employeeId: v.employeeId, returnedAt: null },
        select: { assetId: true },
      })
      where.id = { in: assignments.map((a) => a.assetId) }
    }
    const page = v.page || 1
    const pageSize = v.pageSize || 50
    const orderBy: Record<string, string>[] =
      v.sortBy === "warranty" ? [{ warrantyExpiry: "asc" }, { code: "asc" }]
      : v.sortBy === "recent" ? [{ createdAt: "desc" }]
      : [{ code: "asc" }]

    const [rows, total] = await Promise.all([
      db.asset.findMany({ where, orderBy, skip: (page - 1) * pageSize, take: pageSize }),
      db.asset.count({ where }),
    ])

    // current (outstanding) assignment + employee identity + branch names
    const assetIds = rows.map((a) => a.id)
    const outstanding = assetIds.length
      ? await db.assetAssignment.findMany({ where: { vendorId: ctx.vendorId, assetId: { in: assetIds }, returnedAt: null } })
      : []
    const empIds = [...new Set(outstanding.map((o) => o.employeeId))]
    const [employees, branches] = await Promise.all([
      empIds.length
        ? db.employee.findMany({ where: { vendorId: ctx.vendorId, id: { in: empIds } }, select: { id: true, code: true, fullName: true } })
        : Promise.resolve<{ id: string; code: string; fullName: string }[]>([]),
      db.branch.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } }),
    ])

    return {
      assets: rows.map((a) => {
        const cur = outstanding.find((o) => o.assetId === a.id) || null
        const emp = cur ? employees.find((e) => e.id === cur.employeeId) : undefined
        return {
          ...a,
          branchName: branches.find((b) => b.id === a.branchId)?.name || null,
          currentAssignment: cur ? {
            id: cur.id,
            employeeId: cur.employeeId,
            employeeName: emp?.fullName || "—",
            employeeCode: emp?.code || null,
            assignedAt: cur.assignedAt,
            dueAt: cur.dueAt,
            conditionOut: cur.conditionOut,
            note: cur.note,
          } : null,
        }
      }),
      total,
      page,
      pageSize,
    }
  },
})

// ---------- create ----------

const createSchema = z.object(assetFieldsSchema).strict()

route("assets.create", {
  perm: ["assets", "create"],
  schema: createSchema,
  handler: async (ctx, p) => {
    const v = p as z.infer<typeof createSchema>
    if (v.branchId) {
      const branch = await db.branch.findFirst({ where: { id: v.branchId, vendorId: ctx.vendorId } })
      if (!branch) throw new Deny("Branch not found", 404)
    }
    // null-normalized writable fields (blank FormDialog inputs → null)
    const data = {
      name: v.name, category: v.category,
      brandModel: v.brandModel ?? null, serialImei: v.serialImei ?? null,
      purchaseDate: v.purchaseDate ?? null, purchaseCost: v.purchaseCost ?? null,
      warrantyExpiry: v.warrantyExpiry ?? null, condition: v.condition || "NEW",
      branchId: v.branchId ?? null, locationNote: v.locationNote ?? null, notes: v.notes ?? null,
    }
    // Locked sequential code — allocated with the race-safe counter, retried on
    // a unique collision (manually seeded AST- rows outside the counter).
    const { nextFormattedSeq } = await import("../utils")
    let rec: AssetRow | null = null
    for (let attempt = 0; attempt < 5 && !rec; attempt++) {
      const code = await nextFormattedSeq(ctx.vendorId, "asset-code", (n) => `AST-${String(n).padStart(4, "0")}`)
      try {
        rec = (await db.asset.create({ data: { ...data, vendorId: ctx.vendorId, code, status: "IN_STOCK" } })) as AssetRow
      } catch (e: unknown) {
        const prismaCode = (e as { code?: string })?.code
        if (prismaCode === "P2002" && attempt < 4) continue // code taken — next number
        throw e
      }
    }
    if (!rec) throw new Deny("Could not allocate an asset code — try again", 500)
    await audit(ctx, "assets.create", "Asset", rec.id,
      `Registered asset ${rec.code} — ${rec.name} (${rec.category})`,
      { newValue: { code: rec.code, name: rec.name, category: rec.category } })
    return rec
  },
})

// ---------- update (code + status are NOT writable — see schema) ----------

const updateSchema = z.object({ id: id, ...assetFieldsSchema }).strict()

route("assets.update", {
  perm: ["assets", "edit"],
  schema: updateSchema,
  handler: async (ctx, p) => {
    const v = p as z.infer<typeof updateSchema>
    const existing = await getAsset(ctx, v.id)
    if (v.branchId) {
      const branch = await db.branch.findFirst({ where: { id: v.branchId, vendorId: ctx.vendorId } })
      if (!branch) throw new Deny("Branch not found", 404)
    }
    // undefined = "field not submitted" → unchanged; null = explicit clear.
    const set = <T>(val: T | null | undefined, fallback: T | null): T | null | undefined =>
      val === undefined ? fallback : val
    const rec = (await db.asset.update({
      where: { id: existing.id },
      data: {
        name: v.name ?? existing.name,
        category: v.category ?? existing.category,
        brandModel: set(v.brandModel, existing.brandModel),
        serialImei: set(v.serialImei, existing.serialImei),
        purchaseDate: set(v.purchaseDate, existing.purchaseDate),
        purchaseCost: set(v.purchaseCost, existing.purchaseCost),
        warrantyExpiry: set(v.warrantyExpiry, existing.warrantyExpiry),
        condition: v.condition ?? existing.condition,
        branchId: set(v.branchId, existing.branchId),
        locationNote: set(v.locationNote, existing.locationNote),
        notes: set(v.notes, existing.notes),
      },
    })) as AssetRow
    await audit(ctx, "assets.update", "Asset", rec.id, `Updated asset ${rec.code} — ${rec.name}`, {
      oldValue: { name: existing.name, category: existing.category, condition: existing.condition, branchId: existing.branchId, warrantyExpiry: existing.warrantyExpiry, serialImei: existing.serialImei },
      newValue: { name: rec.name, category: rec.category, condition: rec.condition, branchId: rec.branchId, warrantyExpiry: rec.warrantyExpiry, serialImei: rec.serialImei },
    })
    return rec
  },
})

// ---------- assign (IN_STOCK/RETURNED → ASSIGNED; one active assignment) ----------

const assignSchema = z.object({
  assetId: id,
  employeeId: id,
  dueAt: dateOpt,
  conditionOut: enumOpt(ASSET_CONDITIONS),
  note: textOpt(1000),
}).strict()

route("assets.assign", {
  perm: ["assets", "assign"],
  schema: assignSchema,
  handler: async (ctx, p) => assignAsset(ctx, p as z.infer<typeof assignSchema>),
})

/** Assign an asset to an employee — exported for reuse by sibling modules. */
export async function assignAsset(ctx: Ctx, p: z.infer<typeof assignSchema>) {
  const asset = await getAsset(ctx, p.assetId)
  if (!ASSIGNABLE_STATUSES.includes(asset.status)) {
    throw new Deny(`Asset ${asset.code} cannot be assigned while its status is ${asset.status} — only IN_STOCK or RETURNED assets are assignable`, 400)
  }
  // H-04/H-05 — the employee must belong to this tenant AND the caller's scope
  const emp = await assertEmployeeVisible(ctx, p.employeeId)
  if (!["ACTIVE", "PROBATION"].includes(emp.status)) {
    throw new Deny(`${emp.fullName} is ${emp.status} — assets can only be assigned to ACTIVE or PROBATION employees`, 400)
  }
  const note = (p.note || "").trim() || null
  const conditionOut = p.conditionOut || asset.condition
  const assignment = await db.$transaction(async (tx) => {
    // check-and-set: exactly one concurrent assign wins (the status invariant
    // "ASSIGNED implies one outstanding assignment" holds under races)
    const claimed = await tx.asset.updateMany({
      where: { id: asset.id, vendorId: ctx.vendorId, status: { in: ASSIGNABLE_STATUSES } },
      data: { status: "ASSIGNED" },
    })
    if (claimed.count === 0) {
      throw new Deny(`Asset ${asset.code} was just assigned or changed state by someone else — refresh and try again`, 409)
    }
    const created = await tx.assetAssignment.create({
      data: {
        vendorId: ctx.vendorId, assetId: asset.id, employeeId: emp.id,
        dueAt: p.dueAt ? new Date(p.dueAt + "T00:00:00Z") : null,
        conditionOut, note, issuedById: ctx.userId,
      },
    })
    await tx.assetEvent.create({
      data: {
        vendorId: ctx.vendorId, assetId: asset.id, type: "ASSIGN",
        actorId: ctx.userId, actorName: ctx.userName,
        snapshotJson: JSON.stringify({
          assignmentId: created.id,
          employee: { id: emp.id, name: emp.fullName, code: emp.code },
          conditionOut, note, dueAt: p.dueAt || null,
        }).slice(0, 4000),
        note,
      },
    })
    return created
  })
  await audit(ctx, "assets.assign", "Asset", asset.id,
    `Assigned ${asset.code} (${asset.name}) to ${emp.fullName}`,
    { newValue: { assignmentId: assignment.id, employeeId: emp.id, conditionOut, dueAt: p.dueAt || null } })
  return { assignment, asset: { id: asset.id, code: asset.code, status: "ASSIGNED" } }
}

// ---------- return (close the outstanding assignment) ----------

const returnSchema = z.object({
  assignmentId: idBlankOpt,
  assetId: idBlankOpt,
  conditionIn: enumOpt(ASSET_CONDITIONS),
  note: textOpt(1000),
}).refine((p) => !!p.assignmentId || !!p.assetId, { message: "Provide either assignmentId or assetId" })

route("assets.return", {
  perm: ["assets", "assign"],
  schema: returnSchema,
  handler: async (ctx, p) => returnAssetAssignment(ctx, p as z.infer<typeof returnSchema>),
})

/**
 * Close an outstanding AssetAssignment. Shared verbatim by the exit-clearance
 * "Mark Returned" action (WP-L) so both paths enforce the same invariants.
 * Asset status: ASSIGNED → RETURNED (back on the shelf, re-assignable).
 * Assets in REPAIR/LOST/RETIRED keep their lifecycle state — only the
 * assignment ledger closes.
 */
export async function returnAssetAssignment(ctx: Ctx, p: z.infer<typeof returnSchema>, via = "assets.return") {
  const assignment = p.assignmentId
    ? await db.assetAssignment.findFirst({ where: { id: p.assignmentId, vendorId: ctx.vendorId } })
    : await db.assetAssignment.findFirst({ where: { assetId: p.assetId || "", vendorId: ctx.vendorId, returnedAt: null } }) // null assetId → no match → the 404 below (kept behavior-identical without a non-null assertion)
  if (!assignment) throw new Deny("Active assignment not found", 404)
  if (assignment.returnedAt) throw new Deny("This assignment is already returned", 400)
  const asset = await getAsset(ctx, assignment.assetId)
  const note = (p.note || "").trim() || null
  const mergedNote = [assignment.note, note].filter(Boolean).join(" | ") || null

  await db.$transaction(async (tx) => {
    // check-and-set on the assignment — a double-return race loses cleanly
    const claimed = await tx.assetAssignment.updateMany({
      where: { id: assignment.id, vendorId: ctx.vendorId, returnedAt: null },
      data: { returnedAt: new Date(), conditionIn: p.conditionIn || null, note: mergedNote },
    })
    if (claimed.count === 0) throw new Deny("This assignment was just returned by someone else — refresh and try again", 409)
    // only a live ASSIGNED asset flips back to the shelf
    await tx.asset.updateMany({
      where: { id: asset.id, vendorId: ctx.vendorId, status: "ASSIGNED" },
      data: { status: "RETURNED", condition: p.conditionIn || asset.condition },
    })
    await tx.inventoryItemSerial.updateMany({
      where: { vendorId: ctx.vendorId, assetId: asset.id },
      data: { status: "AVAILABLE", employeeId: null },
    })
    await tx.assetEvent.create({
      data: {
        vendorId: ctx.vendorId, assetId: asset.id, type: "RETURN",
        actorId: ctx.userId, actorName: ctx.userName,
        snapshotJson: JSON.stringify({
          assignmentId: assignment.id, employeeId: assignment.employeeId,
          conditionIn: p.conditionIn || null, note,
        }).slice(0, 4000),
        note,
      },
    })
  })
  await audit(ctx, via, "Asset", asset.id,
    `Returned ${asset.code} (${asset.name})${p.conditionIn ? ` — condition ${p.conditionIn}` : ""}${via !== "assets.return" ? " (via exit clearance)" : ""}`,
    { newValue: { assignmentId: assignment.id, conditionIn: p.conditionIn || null } })
  return { ok: true, assetId: asset.id }
}

// ---------- transfer (reassign from current holder to another employee) ----------

const transferSchema = z.object({
  assetId: id,
  toEmployeeId: id,
  conditionIn: enumOpt(ASSET_CONDITIONS),
  conditionOut: enumOpt(ASSET_CONDITIONS),
  dueAt: dateOpt,
  note: textOpt(1000),
}).strict()

route("assets.transfer", {
  perm: ["assets", "assign"],
  schema: transferSchema,
  handler: async (ctx, p) => {
    const v = p as z.infer<typeof transferSchema>
    const asset = await getAsset(ctx, v.assetId)
    if (["REPAIR", "RETIRED", "LOST"].includes(asset.status)) {
      throw new Deny(`Cannot transfer asset while status is ${asset.status}`, 400)
    }

    const toEmp = await assertEmployeeVisible(ctx, v.toEmployeeId)
    if (!["ACTIVE", "PROBATION"].includes(toEmp.status)) {
      throw new Deny(`${toEmp.fullName} is ${toEmp.status} — assets can only be assigned to ACTIVE or PROBATION employees`, 400)
    }

    const activeAssignment = await db.assetAssignment.findFirst({
      where: { assetId: asset.id, vendorId: ctx.vendorId, returnedAt: null },
    })

    if (activeAssignment && activeAssignment.employeeId === toEmp.id) {
      throw new Deny(`Asset is already assigned to ${toEmp.fullName}`, 400)
    }

    let fromEmpName = "Shelf"
    if (activeAssignment) {
      const fromEmp = await db.employee.findUnique({
        where: { id: activeAssignment.employeeId },
        select: { fullName: true, code: true },
      })
      if (fromEmp) fromEmpName = `${fromEmp.fullName}${fromEmp.code ? ` (${fromEmp.code})` : ""}`
    }

    const note = (v.note || "").trim() || null
    const conditionOut = v.conditionOut || v.conditionIn || asset.condition

    const result = await db.$transaction(async (tx) => {
      if (activeAssignment) {
        await tx.assetAssignment.update({
          where: { id: activeAssignment.id },
          data: {
            returnedAt: new Date(),
            conditionIn: v.conditionIn || asset.condition,
            note: [activeAssignment.note, `Transferred to ${toEmp.fullName}`, note].filter(Boolean).join(" | "),
          },
        })
      }

      await tx.asset.update({
        where: { id: asset.id },
        data: {
          status: "ASSIGNED",
          condition: conditionOut,
        },
      })

      const newAssignment = await tx.assetAssignment.create({
        data: {
          vendorId: ctx.vendorId,
          assetId: asset.id,
          employeeId: toEmp.id,
          dueAt: v.dueAt ? new Date(v.dueAt + "T00:00:00Z") : null,
          conditionOut,
          note: [activeAssignment ? `Transferred from ${fromEmpName}` : null, note].filter(Boolean).join(" | "),
          issuedById: ctx.userId,
        },
      })

      await tx.inventoryItemSerial.updateMany({
        where: { vendorId: ctx.vendorId, assetId: asset.id },
        data: { status: "ISSUED", employeeId: toEmp.id },
      })

      await tx.assetEvent.create({
        data: {
          vendorId: ctx.vendorId,
          assetId: asset.id,
          type: "TRANSFER",
          actorId: ctx.userId,
          actorName: ctx.userName,
          snapshotJson: JSON.stringify({
            from: fromEmpName,
            to: { id: toEmp.id, name: toEmp.fullName, code: toEmp.code },
            conditionOut,
            conditionIn: v.conditionIn || null,
            note,
          }).slice(0, 4000),
          note: `Transferred from ${fromEmpName} to ${toEmp.fullName}${note ? ` · ${note}` : ""}`,
        },
      })

      return newAssignment
    })

    await audit(
      ctx,
      "assets.transfer",
      "Asset",
      asset.id,
      `Transferred ${asset.code} (${asset.name}) from ${fromEmpName} to ${toEmp.fullName}${note ? ` — ${note}` : ""}`,
      { newValue: { toEmployeeId: toEmp.id, assignmentId: result.id } }
    )

    return { ok: true, asset: { id: asset.id, code: asset.code, status: "ASSIGNED" }, assignment: result }
  },
})

// ---------- repair / retire / lose lifecycle ----------

const transitionSchema = z.object({ id: id, note: textOpt(1000) }).strict()

/**
 * REPAIR is a two-way toggle: IN_STOCK/RETURNED → REPAIR ("sent for repair"),
 * REPAIR → IN_STOCK ("repaired, back on the shelf"). Assigned assets must be
 * returned first (the assignment ledger stays truthful).
 */
route("assets.repair", {
  perm: ["assets", "edit"],
  schema: transitionSchema,
  handler: async (ctx, p) => {
    const v = p as z.infer<typeof transitionSchema>
    const asset = await getAsset(ctx, v.id)
    const note = (v.note || "").trim() || null
    const toStatus = asset.status === "REPAIR" ? "IN_STOCK" : "REPAIR"
    if (asset.status === "ASSIGNED") throw new Deny(`${asset.code} is currently assigned — return it before sending it for repair`, 400)
    if (["RETIRED", "LOST"].includes(asset.status)) throw new Deny(`${asset.code} is ${asset.status} and cannot be sent for repair`, 400)
    await db.$transaction(async (tx) => {
      const claimed = await tx.asset.updateMany({
        where: { id: asset.id, vendorId: ctx.vendorId, status: asset.status },
        data: { status: toStatus },
      })
      if (claimed.count === 0) throw new Deny(`${asset.code} changed state concurrently — refresh and try again`, 409)
      await tx.assetEvent.create({
        data: {
          vendorId: ctx.vendorId, assetId: asset.id, type: "REPAIR",
          actorId: ctx.userId, actorName: ctx.userName,
          snapshotJson: JSON.stringify({ from: asset.status, to: toStatus }).slice(0, 4000),
          note,
        },
      })
    })
    await audit(ctx, "assets.repair", "Asset", asset.id,
      toStatus === "REPAIR" ? `${asset.code} sent for repair${note ? ` — ${note}` : ""}` : `${asset.code} repaired — back in stock${note ? ` — ${note}` : ""}`,
      { oldValue: { status: asset.status }, newValue: { status: toStatus } })
    return { status: toStatus }
  },
})

route("assets.retire", {
  perm: ["assets", "edit"],
  schema: transitionSchema,
  handler: async (ctx, p) => {
    const v = p as z.infer<typeof transitionSchema>
    const asset = await getAsset(ctx, v.id)
    const note = (v.note || "").trim() || null
    if (asset.status === "ASSIGNED") throw new Deny(`${asset.code} is currently assigned — return it (or clear it with a deduction during exit) before retiring`, 400)
    if (["RETIRED", "LOST"].includes(asset.status)) throw new Deny(`${asset.code} is already ${asset.status}`, 400)
    await db.$transaction(async (tx) => {
      const claimed = await tx.asset.updateMany({
        where: { id: asset.id, vendorId: ctx.vendorId, status: asset.status },
        data: { status: "RETIRED" },
      })
      if (claimed.count === 0) throw new Deny(`${asset.code} changed state concurrently — refresh and try again`, 409)
      await tx.assetEvent.create({
        data: {
          vendorId: ctx.vendorId, assetId: asset.id, type: "RETIRE",
          actorId: ctx.userId, actorName: ctx.userName,
          snapshotJson: JSON.stringify({ from: asset.status, to: "RETIRED" }).slice(0, 4000),
          note,
        },
      })
    })
    await audit(ctx, "assets.retire", "Asset", asset.id, `${asset.code} retired${note ? ` — ${note}` : ""}`,
      { oldValue: { status: asset.status }, newValue: { status: "RETIRED" } })
    return { status: "RETIRED" }
  },
})

route("assets.lose", {
  perm: ["assets", "edit"],
  schema: transitionSchema,
  handler: async (ctx, p) => {
    const v = p as z.infer<typeof transitionSchema>
    const asset = await getAsset(ctx, v.id)
    const note = (v.note || "").trim() || null
    if (["RETIRED", "LOST"].includes(asset.status)) throw new Deny(`${asset.code} is already ${asset.status}`, 400)
    // Losing an ASSIGNED asset is allowed — the assignment stays OUTSTANDING so
    // exit clearance still blocks until it is returned or cleared with a
    // deduction (the recovery path, WP-L).
    await db.$transaction(async (tx) => {
      const claimed = await tx.asset.updateMany({
        where: { id: asset.id, vendorId: ctx.vendorId, status: asset.status },
        data: { status: "LOST" },
      })
      if (claimed.count === 0) throw new Deny(`${asset.code} changed state concurrently — refresh and try again`, 409)
      await tx.assetEvent.create({
        data: {
          vendorId: ctx.vendorId, assetId: asset.id, type: "LOSE",
          actorId: ctx.userId, actorName: ctx.userName,
          snapshotJson: JSON.stringify({ from: asset.status, to: "LOST" }).slice(0, 4000),
          note,
        },
      })
    })
    await audit(ctx, "assets.lose", "Asset", asset.id, `${asset.code} marked lost${note ? ` — ${note}` : ""}`,
      { oldValue: { status: asset.status }, newValue: { status: "LOST" } })
    return { status: "LOST" }
  },
})

// ---------- note (append a NOTE event without touching status) ----------

route("assets.note", {
  perm: ["assets", "edit"],
  schema: z.object({ assetId: id, note: z.string().min(1).max(1000) }).strict(),
  handler: async (ctx, p) => {
    const v = p as { assetId: string; note: string }
    const asset = await getAsset(ctx, v.assetId)
    const note = v.note.trim()
    await db.assetEvent.create({
      data: {
        vendorId: ctx.vendorId, assetId: asset.id, type: "NOTE",
        actorId: ctx.userId, actorName: ctx.userName,
        snapshotJson: JSON.stringify({ status: asset.status }).slice(0, 4000),
        note,
      },
    })
    await audit(ctx, "assets.note", "Asset", asset.id, `Note on ${asset.code}: ${note.slice(0, 160)}`)
    return { ok: true }
  },
})

// ---------- history (append-only timeline) ----------

route("assets.history", {
  perm: ["assets", "view"],
  schema: z.object({ assetId: id }).strict(),
  handler: async (ctx, p) => {
    const v = p as { assetId: string }
    const asset = await getAsset(ctx, v.assetId)
    const events = await db.assetEvent.findMany({
      where: { vendorId: ctx.vendorId, assetId: asset.id },
      orderBy: { createdAt: "desc" }, take: 200,
    })
    // resolve employee names embedded in ASSIGN snapshots + current handover
    const empIds: string[] = []
    for (const e of events) {
      try {
        const snap = JSON.parse(e.snapshotJson || "{}") as { employee?: { id?: string } }
        if (snap.employee?.id) empIds.push(snap.employee.id)
      } catch { /* snapshot stays raw on parse failure */ }
    }
    const [current, branch] = await Promise.all([
      db.assetAssignment.findFirst({ where: { vendorId: ctx.vendorId, assetId: asset.id, returnedAt: null } }),
      asset.branchId
        ? db.branch.findFirst({ where: { id: asset.branchId, vendorId: ctx.vendorId }, select: { name: true } })
        : Promise.resolve(null),
    ])
    if (current) empIds.push(current.employeeId)
    const employees = empIds.length
      ? await db.employee.findMany({ where: { vendorId: ctx.vendorId, id: { in: [...new Set(empIds)] } }, select: { id: true, fullName: true, code: true } })
      : []
    const curEmp = current ? employees.find((x) => x.id === current.employeeId) : undefined
    return {
      asset: {
        ...asset,
        branchName: branch?.name || null,
        currentAssignment: current ? {
          id: current.id,
          employeeId: current.employeeId,
          employeeName: curEmp?.fullName || "—",
          employeeCode: curEmp?.code || null,
          assignedAt: current.assignedAt,
          dueAt: current.dueAt,
          conditionOut: current.conditionOut,
          note: current.note,
        } : null,
      },
      events: events.map((e) => {
        let snapshot: Record<string, unknown> = {}
        try { snapshot = JSON.parse(e.snapshotJson || "{}") as Record<string, unknown> } catch { /* keep {} */ }
        const empRef = (snapshot.employee as { id?: string } | undefined)?.id
        const emp = empRef ? employees.find((x) => x.id === empRef) : undefined
        return { ...e, snapshot, employeeName: emp?.fullName || null, employeeCode: emp?.code || null }
      }),
    }
  },
})

// ---------- stats (view stat cards + dashboard widgets) ----------

route("assets.stats", {
  perm: ["assets", "view"],
  schema: z.object({}).strict(),
  handler: async (ctx) => {
    const t = today()
    const horizon = addDays(t, 30)
    const [total, byStatusRows, byCategoryRows, outstanding, warrantySoon, warrantyExpired] = await Promise.all([
      db.asset.count({ where: { vendorId: ctx.vendorId } }),
      db.asset.groupBy({ by: ["status"], where: { vendorId: ctx.vendorId }, _count: { _all: true } }),
      db.asset.groupBy({ by: ["category"], where: { vendorId: ctx.vendorId }, _count: { _all: true } }),
      db.assetAssignment.count({ where: { vendorId: ctx.vendorId, returnedAt: null } }),
      // same 30-day lead + exclusion set as assetWarrantyReminders (jobs.ts)
      db.asset.count({ where: { vendorId: ctx.vendorId, warrantyExpiry: { not: null, gte: t, lte: horizon }, status: { notIn: ["RETIRED", "LOST"] } } }),
      db.asset.count({ where: { vendorId: ctx.vendorId, warrantyExpiry: { not: null, lt: t }, status: { notIn: ["RETIRED", "LOST"] } } }),
    ])
    const byStatus: Record<string, number> = {}
    for (const r of byStatusRows) byStatus[r.status] = r._count._all
    const byCategory: Record<string, number> = {}
    for (const r of byCategoryRows) byCategory[r.category] = r._count._all
    return { total, byStatus, byCategory, outstandingAssignments: outstanding, warrantyExpiringSoon: warrantySoon, warrantyDays: 30, warrantyExpired, asOf: t }
  },
})

// ---------- delete (audit-integrity guarded) ----------

route("assets.delete", {
  perm: ["assets", "delete"],
  schema: z.object({ id: id }).strict(),
  handler: async (ctx, p) => {
    const v = p as { id: string }
    const asset = await getAsset(ctx, v.id)
    if (asset.status === "ASSIGNED") throw new Deny(`${asset.code} is currently assigned — return it before deleting`, 400)
    const assignments = await db.assetAssignment.count({ where: { vendorId: ctx.vendorId, assetId: asset.id } })
    if (assignments > 0) throw new Deny(`${asset.code} has assignment history — retire it instead of deleting (audit integrity)`)
    await db.$transaction(async (tx) => {
      // the asset's own timeline goes with it; the AuditLog rows remain
      await tx.assetEvent.deleteMany({ where: { vendorId: ctx.vendorId, assetId: asset.id } })
      await tx.asset.delete({ where: { id: asset.id } })
    })
    await audit(ctx, "assets.delete", "Asset", asset.id, `Deleted asset ${asset.code} — ${asset.name} (no assignment history)`, { oldValue: { code: asset.code, name: asset.name, category: asset.category, status: asset.status } })
    return { ok: true }
  },
})
