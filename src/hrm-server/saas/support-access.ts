// ============ Phase 2 (Wave 10, 2026-10-24) — Time-Limited Support Access ============
// Secure, audited, time-boxed owner→tenant support sessions.
//
// SECURITY MODEL (mirrors the two existing session planes — tenant Session and
// SaasOwnerSession — and NEVER crosses them):
//   - A support session is a THIRD, separate plane: its own cookie
//     (`saas_support_session`), its own table (SaasSupportAccessSession), its
//     own CSRF token. A tenant token can never authorize an owner action and
//     an owner token can never open a tenant workspace — a support ENTER TOKEN
//     (one-time, 60-second capability, minted only for an authenticated,
//     permission-checked owner operator) is the ONLY bridge, and it burns on
//     first use.
//   - Only the sha256 hash of every token is stored (enterTokenHash /
//     sessionTokenHash), identical to Session.tokenHash discipline.
//   - Expiry is enforced SERVER-SIDE on every /api/hrm request via
//     resolveSupportCtx(); the banner countdown is UX, never the boundary.
//     No renewal exists: a second authorization mints a fresh session.
//   - The effective tenant context NEVER receives the tenant admin's role or
//     unrestricted permissions: ctx.role is the synthetic "SUPPORT" value
//     (matches no special-cased role anywhere in the codebase → deny-by-
//     default in every in-handler role check), and ctx.permissions is the
//     intersection of the policy scope with a hard, code-level deny-list.
//   - HARD DENY (regardless of access mode or scope — master prompt §2.3):
//       payroll/bonus/expense approval + payment release, payslip generation,
//       user/role administration, auth & MFA surfaces, settings editing,
//       billing/subscription mutations, destructive ops (purge/delete),
//       bulk-PII + reveal + every export/download (support reads on screen;
//       existing per-handler audit rows still record sensitive reads), and
//       all internally-authorized self-scoped routes (ess.*/tracking.* etc.
//     require a real employee identity the support session never has).
//
// Audit: every lifecycle transition (REQUESTED, STARTED, ENDED, REVOKED,
// EXPIRED, DENIED) lands in SaasAuditLog via saasAudit() with the operator,
// tenant, session id and reason — never tokens or credentials.
import crypto from "crypto"
import { db } from "@/lib/db"
import { saasAudit, type SaasAuditActor } from "./audit"
import { MODULES, type Ctx, type RoleKey } from "../types"
import { rateLimit } from "../security"

export const SUPPORT_COOKIE = "saas_support_session"

export type SupportAccessMode = "READ_ONLY" | "CONTROLLED_WRITE"
export type SupportSessionStatus = "PENDING" | "ACTIVE" | "ENDED" | "EXPIRED" | "REVOKED"

// ---------------- policy configuration (SaaSSetting group "supportAccess") ----

export type SupportAccessPolicy = {
  enabled: boolean
  defaultMinutes: number
  maxMinutes: number
  requireTicketForWrite: boolean
  maxConcurrentActive: number
}

const POLICY_DEFAULTS: SupportAccessPolicy = {
  enabled: true,
  defaultMinutes: 15,
  maxMinutes: 30,
  requireTicketForWrite: false,
  maxConcurrentActive: 10,
}

const POLICY_MINUTES_MIN = 5

/** Read the platform support-access policy (SaaSSetting group "supportAccess").
 *  Unknown/partial rows fall back per-key to the safe defaults. */
export async function getSupportAccessPolicy(): Promise<SupportAccessPolicy> {
  try {
    const rows = await db.saasSetting.findMany({ where: { group: "supportAccess" } })
    const map = new Map(rows.map((r) => [r.key, r.value]))
    const num = (key: keyof SupportAccessPolicy, min: number, max: number, dflt: number) => {
      const raw = Number(map.get(key))
      if (!Number.isFinite(raw)) return dflt
      return Math.min(max, Math.max(min, Math.trunc(raw)))
    }
    return {
      enabled: map.get("enabled") !== "false",
      defaultMinutes: num("defaultMinutes", POLICY_MINUTES_MIN, 240, POLICY_DEFAULTS.defaultMinutes),
      maxMinutes: num("maxMinutes", POLICY_DEFAULTS.defaultMinutes, 240, POLICY_DEFAULTS.maxMinutes),
      requireTicketForWrite: map.get("requireTicketForWrite") === "true",
      maxConcurrentActive: num("maxConcurrentActive", 1, 100, POLICY_DEFAULTS.maxConcurrentActive),
    }
  } catch {
    return { ...POLICY_DEFAULTS }
  }
}

export async function saveSupportAccessPolicy(patch: Partial<SupportAccessPolicy>): Promise<void> {
  const entries: [string, string][] = []
  if (patch.enabled !== undefined) entries.push(["enabled", patch.enabled ? "true" : "false"])
  if (patch.defaultMinutes !== undefined) entries.push(["defaultMinutes", String(Math.trunc(patch.defaultMinutes))])
  if (patch.maxMinutes !== undefined) entries.push(["maxMinutes", String(Math.trunc(patch.maxMinutes))])
  if (patch.requireTicketForWrite !== undefined) entries.push(["requireTicketForWrite", patch.requireTicketForWrite ? "true" : "false"])
  if (patch.maxConcurrentActive !== undefined) entries.push(["maxConcurrentActive", String(Math.trunc(patch.maxConcurrentActive))])
  for (const [key, value] of entries) {
    await db.saasSetting.upsert({
      where: { group_key: { group: "supportAccess", key } },
      create: { group: "supportAccess", key, value },
      update: { value },
    })
  }
}

// ---------------- the action policy (PURE — unit-tested) ----------------------

/** Actions a support context may always reach (session bootstrap + exit). */
export const SUPPORT_ALWAYS_ACTIONS: ReadonlySet<string> = new Set(["auth.me", "auth.supportExit"])

/** Controlled-write catalog: the ONLY mutating module.action pairs a
 *  CONTROLLED_WRITE authorization may include in its scope. Deliberately
 *  narrow (master prompt §2.3: "narrowly scoped and explicitly authorized"):
 *  attendance corrections, device troubleshooting, and background-job
 *  recovery are the archetypal support interventions. Everything else —
 *  payroll, approvals, users, settings, billing, deletions — is hard-denied
 *  at the policy layer and CANNOT be granted by any scope. */
export const SUPPORT_WRITE_CATALOG: ReadonlySet<string> = new Set([
  "attendance.create", // manual punch entry / correction
  "attendance.edit", // attendance corrections
  "attendance.process", // reprocess/rebuild daily attendance
  "devices.edit", // device configuration troubleshooting
  "devices.process", // device command queue operations
  "jobs.manage", // BgJob retry/cancel/recover (Job Queue Center)
])

/** Verbs that are NEVER granted to a support context, in any mode or scope. */
const SUPPORT_DENIED_VERBS: ReadonlySet<string> = new Set([
  "export", "download", "generate", "reveal", "pii", "purge", "delete",
  "pay", "approve", "reject", "upload", "create", "edit", "process", "calculate",
  "assign", "manage", "verify", "import", "schedule", "launch", "assign",
])

/** Effective permission set for one support authorization.
 *  2026-10-25 (master prompt §4.3): `viewModules` — when a session carries an
 *  approved module scope (tenant-initiated Live Support Access), the read
 *  surface is LIMITED to those modules instead of every module; the RBAC
 *  check in the dispatcher then rejects every out-of-scope module with 403. */
export function supportPermissionsFor(accessMode: SupportAccessMode, scope: string[], viewModules?: string[]): Set<string> {
  const perms = new Set<string>()
  // read surface: *.view across every tenant module — or ONLY the approved
  // modules for module-scoped sessions (server-side field masking + per-row
  // audit still apply inside each handler)
  const viewSurface = viewModules && viewModules.length > 0 ? viewModules : MODULES
  for (const m of viewSurface) perms.add(`${m}.view`)
  if (accessMode === "CONTROLLED_WRITE") {
    for (const entry of scope) {
      if (SUPPORT_WRITE_CATALOG.has(entry)) perms.add(entry)
    }
  }
  return perms
}

export type SupportPolicyDecision = { allowed: boolean; reason?: string }

/** The per-request support policy gate (PURE — unit-tested). `def` carries the
 *  route's permission requirement (module + verb); internally-authorized
 *  routes (no perm) are denied because they enforce a self-identity the
 *  support context never holds. */
export function supportAccessActionAllowed(input: {
  action: string
  permModule?: string
  permVerb?: string
  altPermModule?: string
  altPermVerb?: string
  accessMode: SupportAccessMode
  scope: string[]
}): SupportPolicyDecision {
  const { action, accessMode, scope } = input
  if (SUPPORT_ALWAYS_ACTIONS.has(action)) return { allowed: true }

  // The auth surface is exit-only for support: no password changes, no MFA
  // enrollment, no session manipulation on the tenant plane.
  if (action.startsWith("auth.")) {
    return { allowed: false, reason: "the authentication surface is not available to support sessions" }
  }

  // Internally-authorized routes (ess.*, tracking.*, leaveRequests.*, …)
  // enforce a real employee identity in-handler; the support context has
  // none → deny-by-default.
  if (!input.permModule || !input.permVerb) {
    return { allowed: false, reason: "self-scoped routes are not available to support sessions" }
  }

  const verb = input.permVerb
  // Hard deny: every mutating/exfiltrating verb is rejected outright unless it
  // is an explicitly scoped controlled-write action (checked below). "view"
  // is the only verb granted unconditionally.
  if (verb !== "view") {
    const key = `${input.permModule}.${verb}`
    if (accessMode !== "CONTROLLED_WRITE" || !SUPPORT_WRITE_CATALOG.has(key) || !scope.includes(key)) {
      return {
        allowed: false,
        reason: SUPPORT_DENIED_VERBS.has(verb)
          ? `"${key}" is prohibited for support access`
          : `"${key}" is outside the authorized support scope`,
      }
    }
    // alt permission paths must ALSO satisfy the policy when present
    if (input.altPermVerb && input.altPermVerb !== "view") {
      const altKey = `${input.altPermModule}.${input.altPermVerb}`
      if (!SUPPORT_WRITE_CATALOG.has(altKey) || !scope.includes(altKey)) {
        return { allowed: false, reason: `alternative permission "${altKey}" is outside the authorized support scope` }
      }
    }
    return { allowed: true }
  }

  // view-only: allowed across all modules (handlers still enforce field
  // masking, row visibility and audit).
  return { allowed: true }
}

// ---------------- token helpers ----------------

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex")
}

function newToken(): string {
  return crypto.randomBytes(32).toString("hex")
}

// ---------------- session lifecycle ----------------

export type StartSupportSessionInput = {
  vendorId: string
  reason: string
  ticketRef?: string | null
  accessMode: SupportAccessMode
  minutes?: number
  scope?: string[]
}

export type StartSupportSessionResult =
  | { ok: true; sessionId: string; enterToken: string; enterUrl: string; expiresAt: Date }
  | { ok: false; error: string; code: number }

/** Owner-console entry point: validate the authorization, create the PENDING
 *  session row and mint the one-time enter capability (60s TTL). The caller
 *  has ALREADY been permission-checked (support.access; CONTROLLED_WRITE
 *  additionally requires support.manage — the "additional approval for
 *  sensitive access" requirement). */
export async function startSupportSession(
  actor: SaasAuditActor & { id: string; name: string; roleKey?: string },
  input: StartSupportSessionInput,
): Promise<StartSupportSessionResult> {
  const policy = await getSupportAccessPolicy()
  if (!policy.enabled) {
    return { ok: false, error: "Support access is disabled by platform policy.", code: 403 }
  }

  const reason = String(input.reason || "").trim()
  if (reason.length < 10) {
    return { ok: false, error: "A support reason of at least 10 characters is required.", code: 400 }
  }
  if (input.accessMode === "CONTROLLED_WRITE" && policy.requireTicketForWrite && !String(input.ticketRef || "").trim()) {
    return { ok: false, error: "A ticket / reference number is required for controlled-write access.", code: 400 }
  }

  const minutes = Math.trunc(Number(input.minutes || policy.defaultMinutes))
  if (!Number.isFinite(minutes) || minutes < POLICY_MINUTES_MIN || minutes > policy.maxMinutes) {
    return { ok: false, error: `Duration must be between ${POLICY_MINUTES_MIN} and ${policy.maxMinutes} minutes.`, code: 400 }
  }

  const scope = (input.scope || []).filter((s) => SUPPORT_WRITE_CATALOG.has(s))
  if (input.accessMode === "CONTROLLED_WRITE" && scope.length === 0) {
    return { ok: false, error: "Controlled-write access requires at least one authorized action from the catalog.", code: 400 }
  }
  if (input.accessMode === "READ_ONLY" && scope.length > 0) {
    return { ok: false, error: "Read-only access cannot carry a write scope.", code: 400 }
  }

  const vendor = await db.vendor.findUnique({ where: { id: input.vendorId }, select: { id: true, name: true, active: true } })
  if (!vendor) return { ok: false, error: "Tenant not found.", code: 404 }

  // one live support session per operator (must exit before starting another)
  const existingMine = await db.saasSupportAccessSession.findFirst({
    where: { operatorOwnerId: actor.id, status: "ACTIVE", expiresAt: { gt: new Date() } },
    select: { id: true },
  })
  if (existingMine) {
    return { ok: false, error: "You already have an active support session — exit it before starting another.", code: 409 }
  }

  // platform-wide concurrency cap
  const activeCount = await db.saasSupportAccessSession.count({
    where: { status: "ACTIVE", expiresAt: { gt: new Date() } },
  })
  if (activeCount >= policy.maxConcurrentActive) {
    return { ok: false, error: "Too many concurrent support sessions are active platform-wide — try again shortly.", code: 429 }
  }

  const enterToken = newToken()
  const now = new Date()
  const row = await db.saasSupportAccessSession.create({
    data: {
      targetVendorId: vendor.id,
      targetVendorName: vendor.name,
      operatorOwnerId: actor.id,
      operatorName: actor.name,
      operatorRoleKey: String(actor.roleKey || ""),
      reason,
      ticketRef: String(input.ticketRef || "").trim() || null,
      accessMode: input.accessMode,
      scopeJson: JSON.stringify(scope),
      status: "PENDING",
      enterTokenHash: sha256(enterToken),
      enterExpiresAt: new Date(now.getTime() + 60_000),
      requestedMinutes: minutes,
      ip: actor.ip || null,
    },
  })

  await saasAudit(actor, "SUPPORT_ACCESS_REQUESTED", "SaasSupportAccessSession", row.id,
    `Support access requested for tenant "${vendor.name}" (${input.accessMode}, ${minutes} min): ${reason.slice(0, 160)}`,
    { vendorId: vendor.id, metadata: { accessMode: input.accessMode, minutes, ticketRef: input.ticketRef || null, scope } })

  return {
    ok: true,
    sessionId: row.id,
    enterToken,
    enterUrl: `/api/support-access/enter?token=${enterToken}`,
    expiresAt: new Date(now.getTime() + minutes * 60_000),
  }
}

export type ConsumeEnterResult =
  | { ok: true; sessionToken: string; maxAgeSeconds: number }
  | { ok: false; code: number }

/** Exchange the one-time enter capability for the live support-session cookie
 *  token. Called ONLY by /api/support-access/enter after the caller's owner
 *  session was verified (belt and suspenders: the capability is bound to the
 *  operator who requested it AND expires in 60 seconds). */
export async function consumeEnterToken(enterToken: string, ownerOwnerId: string, ip?: string, userAgent?: string): Promise<ConsumeEnterResult> {
  if (!enterToken || enterToken.length > 200) return { ok: false, code: 400 }
  const row = await db.saasSupportAccessSession.findUnique({ where: { enterTokenHash: sha256(enterToken) } })
  if (!row || row.status !== "PENDING" || !row.enterExpiresAt || row.enterExpiresAt < new Date()) {
    return { ok: false, code: 410 }
  }
  if (row.operatorOwnerId !== ownerOwnerId) {
    await saasAudit(null, "SUPPORT_ACCESS_ENTER_MISMATCH", "SaasSupportAccessSession", row.id,
      "Enter capability presented by a different owner account — denied.",
      { vendorId: row.targetVendorId })
    return { ok: false, code: 403 }
  }

  const sessionToken = newToken()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + row.requestedMinutes * 60_000)

  // Burn the enter capability and activate — conditional update so a
  // double-click / concurrent use of the same link settles exactly once.
  const claimed = await db.saasSupportAccessSession.updateMany({
    where: { id: row.id, status: "PENDING" },
    data: {
      status: "ACTIVE",
      enterTokenHash: null,
      enterExpiresAt: null,
      sessionTokenHash: sha256(sessionToken),
      csrfToken: newToken().slice(0, 32),
      startedAt: now,
      expiresAt,
      lastSeenAt: now,
      ip: ip || row.ip,
      userAgent: userAgent ? userAgent.slice(0, 250) : null,
    },
  })
  if (claimed.count === 0) return { ok: false, code: 410 }

  // tenant-initiated live-support request: APPROVED → ACTIVE on activation
  if (row.liveRequestId) {
    await db.saasLiveSupportRequest.updateMany({
      where: { id: row.liveRequestId, status: "APPROVED" },
      data: { status: "ACTIVE" },
    }).catch(() => {})
  }

  await saasAudit(
    { id: row.operatorOwnerId, name: row.operatorName, ip },
    "SUPPORT_ACCESS_STARTED", "SaasSupportAccessSession", row.id,
    `Support session started for tenant "${row.targetVendorName}" (${row.accessMode}) — expires ${expiresAt.toISOString()}`,
    { vendorId: row.targetVendorId, metadata: { accessMode: row.accessMode, expiresAt: expiresAt.toISOString() } },
  )

  return { ok: true, sessionToken, maxAgeSeconds: Math.max(30, Math.floor((expiresAt.getTime() - now.getTime()) / 1000)) }
}

/** Resolve the support cookie token into a tenant-plane Ctx, or null. Enforces
 *  status + expiry server-side on EVERY call, transitions stale ACTIVE rows
 *  to EXPIRED (audited), and throttles the lastSeenAt stamp to one write per
 *  minute (same discipline as the tenant session plane). */
export async function resolveSupportCtx(token: string | null | undefined, ip?: string): Promise<Ctx | null> {
  if (!token) return null
  if (token.length > 200) return null
  const row = await db.saasSupportAccessSession.findUnique({ where: { sessionTokenHash: sha256(token) } })
  if (!row || row.status !== "ACTIVE" || !row.expiresAt) return null

  const now = new Date()
  if (row.expiresAt < now) {
    await db.saasSupportAccessSession.updateMany({
      where: { id: row.id, status: "ACTIVE" },
      data: { status: "EXPIRED", endedAt: now, endedReason: "expired", sessionTokenHash: null },
    })
    await saasAudit(
      { id: row.operatorOwnerId, name: row.operatorName },
      "SUPPORT_ACCESS_EXPIRED", "SaasSupportAccessSession", row.id,
      `Support session for tenant "${row.targetVendorName}" expired.`,
      { vendorId: row.targetVendorId },
    )
    return null
  }

  if (!row.lastSeenAt || now.getTime() - row.lastSeenAt.getTime() > 60_000) {
    await db.saasSupportAccessSession.update({ where: { id: row.id }, data: { lastSeenAt: now } }).catch(() => {})
  }

  const scope = (() => {
    try { return JSON.parse(row.scopeJson || "[]") as string[] } catch { return [] as string[] }
  })()
  const approvedModules = (() => {
    try { return JSON.parse(row.approvedModulesJson || "[]") as string[] } catch { return [] as string[] }
  })()
  const accessMode = (row.accessMode === "CONTROLLED_WRITE" ? "CONTROLLED_WRITE" : "READ_ONLY") as SupportAccessMode

  const ctx: Ctx = {
    userId: `support:${row.operatorOwnerId}`,
    userName: `${row.operatorName} (Support)`,
    vendorId: row.targetVendorId,
    role: "SUPPORT" as RoleKey, // matches no special-cased role → deny-by-default in every in-handler role check
    permissions: supportPermissionsFor(accessMode, scope, approvedModules.length ? approvedModules : undefined),
    ip,
    csrfToken: row.csrfToken || undefined,
    supportSession: {
      id: row.id,
      tenantName: row.targetVendorName,
      operatorName: row.operatorName,
      accessMode,
      expiresAt: row.expiresAt.toISOString(),
      modules: approvedModules,
      requestId: row.liveRequestId || undefined,
    },
  }
  return ctx
}

/** End (operator exit / admin revoke / expiry) — conditional from ACTIVE so
 *  concurrent exits settle once. Returns the ended row id or null. */
export async function endSupportSession(
  sessionId: string,
  by: SaasAuditActor & { id?: string; name?: string },
  finalStatus: "ENDED" | "REVOKED",
  reason: string,
): Promise<{ ended: boolean; vendorId?: string; tenantName?: string }> {
  const now = new Date()
  const ended = await db.saasSupportAccessSession.updateMany({
    where: { id: sessionId, status: "ACTIVE" },
    data: {
      status: finalStatus,
      endedAt: now,
      endedReason: reason.slice(0, 200),
      endedById: by.id || null,
      endedByName: by.name || null,
      sessionTokenHash: null,
    },
  })
  if (ended.count === 0) return { ended: false }
  const row = await db.saasSupportAccessSession.findUnique({ where: { id: sessionId }, select: { targetVendorId: true, targetVendorName: true, liveRequestId: true } })
  await saasAudit(by, finalStatus === "REVOKED" ? "SUPPORT_ACCESS_REVOKED" : "SUPPORT_ACCESS_ENDED",
    "SaasSupportAccessSession", sessionId,
    `Support session for tenant "${row?.targetVendorName || sessionId}" ${finalStatus === "REVOKED" ? "revoked" : "ended"}: ${reason.slice(0, 160)}`,
    { vendorId: row?.targetVendorId })
  // tenant-initiated live-support request: ACTIVE → COMPLETED/REVOKED/EXPIRED
  if (row?.liveRequestId) {
    const reqStatus = finalStatus === "REVOKED" ? "REVOKED" : reason === "expired" ? "EXPIRED" : "COMPLETED"
    await db.saasLiveSupportRequest.updateMany({
      where: { id: row.liveRequestId, status: "ACTIVE" },
      data: { status: reqStatus, resolvedAt: new Date() },
    }).catch(() => {})
  }
  return { ended: true, vendorId: row?.targetVendorId, tenantName: row?.targetVendorName }
}

/** End the session resolved from a live support cookie (tenant-side exit). */
export async function exitSupportSession(
  ctx: Ctx,
  reason = "operator exit",
): Promise<{ ended: boolean }> {
  const s = ctx.supportSession
  if (!s) return { ended: false }
  const res = await endSupportSession(s.id, { id: ctx.userId, name: ctx.userName }, "ENDED", reason)
  return { ended: res.ended }
}

/** Daily/tick sweeper: transition every stale ACTIVE row to EXPIRED (bounded
 *  batch) with one audit row each. Called from platformDailyJobs. */
export async function sweepExpiredSupportSessions(maxBatch = 100): Promise<number> {
  const stale = await db.saasSupportAccessSession.findMany({
    where: { status: "ACTIVE", expiresAt: { lt: new Date() } },
    select: { id: true, targetVendorId: true, targetVendorName: true, operatorOwnerId: true, operatorName: true },
    take: maxBatch,
  })
  let n = 0
  for (const row of stale) {
    const res = await endSupportSession(row.id, { id: row.operatorOwnerId, name: row.operatorName }, "ENDED", "expired")
    // endSupportSession writes the ENDED audit; relabel semantics: sweep uses
    // EXPIRED status for the row itself.
    if (res.ended) {
      await db.saasSupportAccessSession.update({ where: { id: row.id }, data: { status: "EXPIRED", endedReason: "expired" } }).catch(() => {})
      n++
    }
  }
  return n
}

/** Rate limiter for the public enter endpoint (same DB-backed buckets as the
 *  rest of the platform). */
export async function throttleSupportEnter(ip: string | null): Promise<boolean> {
  const key = ip ? `support-enter:ip:${ip}` : "support-enter:global"
  return rateLimit(key, 30, 10 * 60_000)
}

// ---------------- cookie serialization ----------------

export function supportCookieStr(token: string, maxAgeSeconds: number, https = true): string {
  const attrs = https ? "Path=/; HttpOnly; SameSite=Lax; Secure" : "Path=/; HttpOnly; SameSite=Lax"
  return `${SUPPORT_COOKIE}=${token}; Max-Age=${maxAgeSeconds}; ${attrs}`
}

export function supportClearCookieStr(https = true): string {
  const attrs = https ? "Path=/; HttpOnly; SameSite=Lax; Secure" : "Path=/; HttpOnly; SameSite=Lax"
  return `${SUPPORT_COOKIE}=; Max-Age=0; ${attrs}`
}

/** The banner payload returned by auth.me while a support session is active. */
export type SupportBannerInfo = {
  sessionId: string
  tenantName: string
  operatorName: string
  accessMode: SupportAccessMode
  expiresAt: string
  /** approved module scope (tenant-initiated sessions; empty = full read) */
  modules?: string[]
  /** originating live-support request id (tenant-initiated sessions) */
  requestId?: string
}

// ================= 2026-10-25 — RE-ENTRY (master prompt §5) ==================
// If a support agent closes the browser tab of an active session, they must
// be able to RE-ENTER the same still-active session from the Owner Panel
// without a duplicate session, without extending the expiry, and without a
// second tenant request. The initial activation link stays single-use;
// resumption is a SEPARATE, authenticated operation:
//   1. the agent holds a live FULL owner session (verified by the API route
//      before calling this) — authentication + MFA already satisfied;
//   2. the session row must be ACTIVE, unexpired, and bound to THIS operator
//      (operatorOwnerId match — no other owner can hijack the session);
//   3. a fresh session cookie token is minted and the stored hash ROTATED
//      (single token: any stale cookie from the closed tab is invalidated);
//   4. the session id, original expiry, approved scope and audit history are
//      untouched — only a SUPPORT_ACCESS_RESUMED audit row is appended.
export type ResumeResult =
  | { ok: true; sessionToken: string; maxAgeSeconds: number; expiresAt: Date; vendorId: string }
  | { ok: false; code: number; error: string }

export async function resumeSupportSession(
  sessionId: string,
  operator: { id: string; name: string; roleKey?: string; ip?: string },
  ip?: string,
  userAgent?: string,
): Promise<ResumeResult> {
  if (!sessionId) return { ok: false, code: 400, error: "Session id required." }
  const row = await db.saasSupportAccessSession.findUnique({ where: { id: sessionId } })
  if (!row) return { ok: false, code: 404, error: "Support session not found." }
  if (row.status !== "ACTIVE") {
    return {
      ok: false,
      code: row.status === "EXPIRED" ? 410 : 409,
      error: `This session is ${row.status.toLowerCase()}${row.endedReason ? ` (${row.endedReason})` : ""}. ${row.status === "EXPIRED" ? "Request a new live-support authorization from the tenant or start a fresh owner-initiated session." : ""}`.trim(),
    }
  }
  if (!row.expiresAt || row.expiresAt < new Date()) {
    // stale row the sweeper has not touched yet — expire it now
    await db.saasSupportAccessSession.updateMany({
      where: { id: row.id, status: "ACTIVE" },
      data: { status: "EXPIRED", endedAt: new Date(), endedReason: "expired", sessionTokenHash: null },
    })
    return { ok: false, code: 410, error: "This session has expired. Request a new live-support authorization." }
  }
  if (row.operatorOwnerId !== operator.id) {
    await saasAudit(operator, "SUPPORT_ACCESS_RESUME_DENIED", "SaasSupportAccessSession", row.id,
      `Re-entry attempted by a different owner account ("${operator.name}") — denied.`,
      { vendorId: row.targetVendorId })
    return { ok: false, code: 403, error: "This session belongs to a different support agent." }
  }

  // rotate the session token — the single-token design invalidates any stale
  // cookie while preserving the session row, expiry and scope.
  const sessionToken = newToken()
  const now = new Date()
  const claimed = await db.saasSupportAccessSession.updateMany({
    where: { id: row.id, status: "ACTIVE" },
    data: {
      sessionTokenHash: sha256(sessionToken),
      csrfToken: newToken().slice(0, 32),
      lastSeenAt: now,
      ip: ip || row.ip,
      userAgent: userAgent ? userAgent.slice(0, 250) : row.userAgent,
    },
  })
  if (claimed.count === 0) {
    return { ok: false, code: 409, error: "This session just ended — refresh the support board." }
  }

  await saasAudit(operator, "SUPPORT_ACCESS_RESUMED", "SaasSupportAccessSession", row.id,
    `Support session re-entered by "${operator.name}" — same session, same expiry (${row.expiresAt.toISOString()}), token rotated.`,
    { vendorId: row.targetVendorId, metadata: { expiresAt: row.expiresAt.toISOString(), reentry: true } })

  return {
    ok: true,
    sessionToken,
    maxAgeSeconds: Math.max(30, Math.floor((row.expiresAt.getTime() - now.getTime()) / 1000)),
    expiresAt: row.expiresAt,
    vendorId: row.targetVendorId,
  }
}

// ============ 2026-10-25 — Live Support Access request review (Part B §4.1) ===

export type ReviewLiveRequestResult =
  | { ok: true; sessionId: string; enterToken: string; enterUrl: string; expiresAt: Date }
  | { ok: false; code: number; error: string }

/** APPROVE a tenant-submitted live-support request: record the approval
 *  (modules ∩ requested, agent, minutes), create the PENDING session bound
 *  to the approved scope, and mint the one-time activation link for the
 *  APPROVED AGENT (who must consume it with their own authenticated owner
 *  session). The session only becomes ACTIVE when the agent opens the link. */
export async function approveLiveSupportRequest(
  reviewer: SaasAuditActor & { id: string; name: string },
  input: {
    requestId: string
    modules: string[]
    minutes?: number
    accessMode?: SupportAccessMode
    agentOwnerId: string
    agentName: string
    note?: string
    origin?: string
  },
): Promise<ReviewLiveRequestResult> {
  const req = await db.saasLiveSupportRequest.findUnique({ where: { id: input.requestId } })
  if (!req) return { ok: false, code: 404, error: "Live-support request not found." }
  if (req.status !== "PENDING_REVIEW") {
    return { ok: false, code: 409, error: `This request is already ${req.status.toLowerCase().replace("_", " ")}.` }
  }
  const requested = (() => {
    try { return JSON.parse(req.modulesJson || "[]") as string[] } catch { return [] as string[] }
  })()
  // approved modules must be a SUBSET of the requested modules (§4.1 — the
  // reviewer may narrow, never widen, the tenant-authorized scope)
  const approved = [...new Set(input.modules)].filter((m) => requested.includes(m))
  if (approved.length === 0) {
    return { ok: false, code: 400, error: "Approve at least one of the requested modules." }
  }
  const policy = await getSupportAccessPolicy()
  if (!policy.enabled) return { ok: false, code: 403, error: "Support access is disabled by platform policy." }
  const minutes = Math.trunc(Number(input.minutes || policy.defaultMinutes))
  if (!Number.isFinite(minutes) || minutes < POLICY_MINUTES_MIN || minutes > policy.maxMinutes) {
    return { ok: false, code: 400, error: `Duration must be between ${POLICY_MINUTES_MIN} and ${policy.maxMinutes} minutes.` }
  }
  const accessMode: SupportAccessMode = input.accessMode === "CONTROLLED_WRITE" ? "CONTROLLED_WRITE" : "READ_ONLY"
  if (accessMode === "CONTROLLED_WRITE" && policy.requireTicketForWrite && !req.ticketId) {
    return { ok: false, code: 400, error: "Controlled-write access requires a linked ticket (platform policy)." }
  }

  // one live session per operator + platform concurrency caps still apply
  const existingMine = await db.saasSupportAccessSession.findFirst({
    where: { operatorOwnerId: input.agentOwnerId, status: "ACTIVE", expiresAt: { gt: new Date() } },
    select: { id: true },
  })
  if (existingMine) {
    return { ok: false, code: 409, error: "The selected agent already has an active support session — it must end first." }
  }

  const vendor = await db.vendor.findUnique({ where: { id: req.vendorId }, select: { id: true, name: true } })
  if (!vendor) return { ok: false, code: 404, error: "Tenant not found." }

  const enterToken = newToken()
  const now = new Date()
  const session = await db.saasSupportAccessSession.create({
    data: {
      targetVendorId: vendor.id,
      targetVendorName: vendor.name,
      operatorOwnerId: input.agentOwnerId,
      operatorName: input.agentName,
      operatorRoleKey: "SUPPORT_AGENT",
      reason: `[Live Support ${req.id.slice(-8)}] ${req.title}`.slice(0, 300),
      ticketRef: req.ticketId || null,
      liveRequestId: req.id,
      approvedModulesJson: JSON.stringify(approved),
      accessMode,
      scopeJson: "[]", // controlled-write scope stays owner-granted separately (SUPPORT_WRITE_CATALOG)
      status: "PENDING",
      enterTokenHash: sha256(enterToken),
      enterExpiresAt: new Date(now.getTime() + 10 * 60_000), // activation window: 10 minutes
      requestedMinutes: minutes,
      ip: reviewer.ip || null,
    },
  })

  await db.saasLiveSupportRequest.update({
    where: { id: req.id },
    data: {
      status: "APPROVED",
      reviewedByOwnerId: reviewer.id,
      reviewedByName: reviewer.name,
      reviewedAt: now,
      reviewNote: input.note || null,
      approvedModulesJson: JSON.stringify(approved),
      approvedMinutes: minutes,
      approvedAgentOwnerId: input.agentOwnerId,
      approvedAgentName: input.agentName,
      activatedSessionId: session.id,
    },
  })

  await saasAudit(reviewer, "LIVE_SUPPORT_APPROVED", "SaasLiveSupportRequest", req.id,
    `Live Support Access approved for agent "${input.agentName}": modules [${approved.join(", ")}], ${minutes} min, ${accessMode}` +
      (input.note ? ` — ${input.note.slice(0, 160)}` : ""),
    { vendorId: req.vendorId, metadata: { modules: approved, minutes, accessMode, agent: input.agentName, sessionId: session.id } })

  return {
    ok: true,
    sessionId: session.id,
    enterToken,
    enterUrl: `/api/support-access/enter?token=${enterToken}`,
    expiresAt: new Date(now.getTime() + 10 * 60_000),
  }
}

/** REJECT a tenant-submitted live-support request (audited, with reason). */
export async function rejectLiveSupportRequest(
  reviewer: SaasAuditActor & { id: string; name: string },
  requestId: string,
  reason: string,
): Promise<{ ok: boolean; error?: string }> {
  const req = await db.saasLiveSupportRequest.findUnique({ where: { id: requestId } })
  if (!req) return { ok: false, error: "Live-support request not found." }
  if (req.status !== "PENDING_REVIEW") {
    return { ok: false, error: `This request is already ${req.status.toLowerCase().replace("_", " ")}.` }
  }
  if (!reason || reason.trim().length < 5) {
    return { ok: false, error: "A rejection reason of at least 5 characters is required." }
  }
  await db.saasLiveSupportRequest.update({
    where: { id: req.id },
    data: {
      status: "REJECTED",
      reviewedByOwnerId: reviewer.id,
      reviewedByName: reviewer.name,
      reviewedAt: new Date(),
      reviewNote: reason.trim().slice(0, 1000),
      resolvedAt: new Date(),
    },
  })
  await saasAudit(reviewer, "LIVE_SUPPORT_REJECTED", "SaasLiveSupportRequest", req.id,
    `Live Support Access request rejected: ${reason.trim().slice(0, 160)}`,
    { vendorId: req.vendorId })
  return { ok: true }
}
