// ============ Audit trail (spec §3.4) & Notification engine (spec §12.3) ============
import { db } from "@/lib/db"
import { queuePushToUser } from "./push/push-service"
import { sendMobilePushToUser } from "./push/mobile-push"

// ---- BigInt-safe snapshot serialization (2026-10-22 hotfix) ----------------
// The H-09 paisa shadow columns are Prisma BigInt (Int overflowed at
// totalGrossPaisa = 5,003,650,000 — see schema.prisma), so a raw Prisma row
// from any money table carries JS BigInt values, which JSON.stringify
// REFUSES to serialize. Until this guard, such snapshots crashed inside
// audit()'s best-effort catch and the forensic row was silently DROPPED
// (observed live: salaryStructures.update via routes/payroll.ts — the
// mutation succeeded, its audit trail did not exist). BigInt is serialized
// as a decimal string at the one boundary every snapshot crosses; every
// current and future call site is safe by default.
export function auditJson(v: unknown): string | null {
  if (v == null) return null
  const s = JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x))
  return s == null ? null : s.slice(0, 4000)
}

export async function audit(
  ctx: { userId?: string | null; userName?: string | null; vendorId: string; ip?: string } | null,
  action: string,
  entity: string,
  entityId: string | null | undefined,
  summary: string,
  opts: { oldValue?: unknown; newValue?: unknown; reason?: string } = {}
) {
  try {
    await db.auditLog.create({
      data: {
        vendorId: ctx?.vendorId || "SYSTEM",
        userId: ctx?.userId,
        userName: ctx?.userName,
        action,
        entity,
        entityId: entityId || null,
        summary,
        oldValue: auditJson(opts.oldValue),
        newValue: auditJson(opts.newValue),
        ip: ctx?.ip,
        reason: opts.reason,
      },
    })
  } catch (e) {
    console.error("audit failed", e)
  }
}

/**
 * STRICT audit — Phase 3 deliverable for the Camera Manager. Identical
 * signature to audit(), but THROWS on failure instead of swallow-and-log.
 * Rationale (Camera Manager §10): a missing forensic row for "who launched
 * this camera" or "who deleted this camera" is unacceptable — best-effort
 * audit on those actions would let a malicious actor cover their tracks by
 * inducing an audit-write failure (DB disconnect, throttle, etc.). For
 * edit/create, the existing best-effort audit() is fine — those operations
 * are reversible and don't carry the same forensic weight.
 *
 * Use for: camera.launch, camera.delete, camera.credential.rotate (and any
 * future action where the audit row is itself part of the security posture).
 * Still use audit() for: camera.create, camera.update, camera.restore.
 */
export async function auditStrict(
  ctx: { userId?: string | null; userName?: string | null; vendorId: string; ip?: string } | null,
  action: string,
  entity: string,
  entityId: string | null | undefined,
  summary: string,
  opts: { oldValue?: unknown; newValue?: unknown; reason?: string } = {}
): Promise<void> {
  await db.auditLog.create({
    data: {
      vendorId: ctx?.vendorId || "SYSTEM",
      userId: ctx?.userId,
      userName: ctx?.userName,
      action,
      entity,
      entityId: entityId || null,
      summary,
      oldValue: auditJson(opts.oldValue),
      newValue: auditJson(opts.newValue),
      ip: ctx?.ip,
      reason: opts.reason,
    },
  })
  // No try/catch — a thrown Prisma error propagates to the caller, which
  // the route-layer error mapper (src/app/api/hrm/route.ts:42-59 clientError)
  // turns into a 500. The mutation that this audit row describes is NOT
  // rolled back — but the audit row exists, so the action is forensically
  // visible. If you need atomicity (audit + mutation in one tx), wrap the
  // call site in a Prisma $transaction — do NOT silently swallow here.
}


// ---------- M-13 — PII-minimal audit snapshots ----------
// The audit trail used to store FULL-ROW oldValue/newValue payloads, dragging
// taxTin, raw addresses and family-member details into a table every HR role
// can read. auditDiff stores ONLY the changed fields, minus an explicit PII
// exclusion list — enough to answer "what changed?" without republishing the
// employee's whole biodata.
//
// Phase 3 addition (Camera Manager §10): "encryptedPayload" added to the PII
// exclusion set so camera credential blobs never leak into audit rows even
// if a future dev forgets to strip them at the route layer. Belt-and-braces
// defense — the camera credential routes also explicitly omit the field
// from their audit snapshots, but a generic exclusion here is the safety net.
const AUDIT_PII_EXCLUDE = new Set([
  "taxTin", "taxCategory", "declaredInvestment",
  "presentAddress", "permanentAddress", "division", "district", "city", "postCode",
  "presentDivision", "presentDistrict", "presentCity", "presentPostCode",
  "fatherName", "motherName", "spouseName", "dob", "placeOfBirth",
  "personalEmail", "mobile", "altMobile", "emergencyName", "emergencyRelation", "emergencyMobile",
  "nameOnDoc", "docNumber", "accountNumber", "routingNumber", "mfsNumber",
  "attachmentData", "fileData",
  // ---- Camera Manager §10 — credential blobs never enter audit rows ----
  "encryptedPayload", "appKey", "appSecret", "appId", "verificationCode", "commKey", "commKeyHash", "commKeySalt",
])

/** Diff two row snapshots for the audit trail: changed keys only, PII keys
 *  masked as "[redacted]" (the fact that they changed is auditable; the new
 *  value is not). Returns null when nothing changed. */
export function auditDiff(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined
): { oldValue: Record<string, unknown>; newValue: Record<string, unknown> } | null {
  if (!before || !after) return null
  const outOld: Record<string, unknown> = {}
  const outNew: Record<string, unknown> = {}
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const k of keys) {
    const a = before[k], b = after[k]
    const same = a === b || (a == null && b == null) ||
      (typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 1e-9)
    if (same) continue
    if (AUDIT_PII_EXCLUDE.has(k)) {
      outOld[k] = "[redacted]"
      outNew[k] = "[redacted]"
    } else {
      outOld[k] = a ?? null
      outNew[k] = b ?? null
    }
  }
  if (!Object.keys(outNew).length) return null
  return { oldValue: outOld, newValue: outNew }
}

/** M-13 — PII scrub for DELETE snapshots: a deleted row's audit trail keeps
 *  identifiers and non-PII fields only; PII columns (taxTin, addresses,
 *  family details, account numbers…) are dropped rather than republished. */
export function auditPIIScrub<T extends Record<string, unknown>>(row: T | null | undefined): Record<string, unknown> | null {
  if (!row) return null
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    if (AUDIT_PII_EXCLUDE.has(k)) continue // dropped entirely on deletes
    out[k] = v
  }
  return out
}

export type NotifyTarget =
  | { userId: string }
  | { employeeId: string }
  | { role: string }
  | { broadcast: true }

export async function notify(
  vendorId: string,
  target: NotifyTarget,
  title: string,
  message: string,
  type: string,
  link?: string
) {
  let userId: string | null = null
  let employeeId: string | null = null
  if ("userId" in target) userId = target.userId
  else if ("employeeId" in target) {
    employeeId = target.employeeId
    const u = await db.user.findFirst({ where: { vendorId, employeeId: target.employeeId } })
    if (u) userId = u.id
  } else if ("role" in target) {
    const users = await db.user.findMany({ where: { vendorId, role: target.role, status: "ACTIVE" } })
    await Promise.all(users.map((u) =>
      db.notification.create({ data: { vendorId, userId: u.id, title, message, type, link } })
    ))
    // P6 WS-C — role broadcasts push to every addressed user's devices (web + mobile)
    for (const u of users) {
      queuePushToUser(vendorId, u.id, { title, body: message, url: link || undefined, tag: `${type}-${u.id}` })
      // Phase 3 — Expo mobile push (fire-and-forget, never throws)
      sendMobilePushToUser(vendorId, u.id, { title, body: message }).catch(() => {})
    }
    return
  }
  await db.notification.create({ data: { vendorId, userId, employeeId, title, message, type, link } })
  // P6 WS-C — the push rail: every in-app notification ALSO pushes to the
  // target user's registered devices (web + mobile, fire-and-forget, never throws here).
  if (userId) {
    queuePushToUser(vendorId, userId, { title, body: message, url: link || undefined, tag: `${type}-${userId}` })
    // Phase 3 — Expo mobile push
    sendMobilePushToUser(vendorId, userId, { title, body: message }).catch(() => {})
  }
}

export async function notifyMany(
  vendorId: string,
  targets: NotifyTarget[],
  title: string,
  message: string,
  type: string,
  link?: string
) {
  await Promise.all(targets.map((t) => notify(vendorId, t, title, message, type, link)))
}
