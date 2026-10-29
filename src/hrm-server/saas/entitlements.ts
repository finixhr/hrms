// ============ Subscription entitlement engine (server-side enforcement) ============
// ONE resolve per vendor, used by three consumers:
//   1. the /api/hrm dispatcher (module feature gates + read-only lockout)
//   2. targeted capacity guards in tenant routes (employees/branches/users/…)
//   3. the auth.me payload (so the SPA can hide gated modules + show usage)
//
// DESIGN RULES (master prompt §11, §41, §42):
//   - Server-side only. The client hides UI as convenience; THIS is the boundary.
//   - Never trust client-supplied plan/subscription state — always re-read here.
//   - LEGACY MODE: a vendor with NO subscription row (every pre-SaaS deployment)
//     gets full access with no limits. The platform must never brick an
//     existing customer because the SaaS layer shipped after their data did.
//   - Overrides: SaaSTenantOverride.featureToggles can force a module on/off
//     for ONE tenant regardless of plan. Audited on write (owner routes).
import { db } from "@/lib/db"
import { j } from "../utils"
import { cacheGetJson, cacheSetJson, cacheDel } from "../cache"
import { READONLY_STATUSES, LOCKED_STATUSES, type FeatureKey, type LimitKey } from "./constants"

export type ResolvedEntitlements = {
  mode: "SUBSCRIBED" | "LEGACY"
  status: string // subscription status or "LEGACY"
  planId: string | null
  planName: string | null
  billingCycle: string | null
  startDate: Date | null
  endDate: Date | null
  daysRemaining: number | null
  features: Record<string, boolean> // FEATURE_KEYS → enabled
  limits: Partial<Record<LimitKey, number | null>> // null = unlimited
  overrides: Record<string, boolean> // module keys explicitly overridden
  storageGbOverride: number | null
  readonly: boolean
  /** FULL lock (master prompt Part F §10): PENDING_PAYMENT tenants lose the
   *  HR modules entirely — reads included. Only auth/billing/subscription/
   *  support surfaces stay reachable (see the /api/hrm dispatcher gate). */
  locked: boolean
}

/** HRM module key → feature key whose plan flag gates it.
 *  Modules NOT listed here are core (available to every operating tenant) —
 *  but still individually controllable through per-tenant overrides (see
 *  featureBlocked: an explicit override wins for ANY module key in
 *  TENANT_MODULES, core or gated).
 *  geofence module is gated by the GEOFENCE feature; tracking by TRACKING.
 *  Note "attendance" is intentionally absent — attendance itself is core;
 *  only the advanced tracking/geofence surfaces are plan-gated. */
export const MODULE_FEATURE_GATES: Record<string, FeatureKey> = {
  payroll: "PAYROLL",
  payslip: "PAYROLL",
  loans: "PAYROLL",
  advances: "PAYROLL",
  expenses: "PAYROLL",
  bonus: "PAYROLL",
  accounting: "PAYROLL",
  ait: "AIT",
  inventory: "INVENTORY",
  procurement: "PROCUREMENT",
  performance: "PERFORMANCE",
  kpi: "PERFORMANCE",
  camera: "CAMERA",
  tracking: "TRACKING",
  geofence: "GEOFENCE",
  ess: "ESS",
  // 2026-10 module-consistency round — ADVANCED_REPORTS used to be a dead plan
  // flag (a column + a toggle with nothing gated). It now gates the analytics
  // module; the basic "reports" module stays core so every operating tenant
  // keeps standard reporting.
  analytics: "ADVANCED_REPORTS",
  // ---- Wave 2 (2026-10-08) ----
  assets: "INVENTORY", // WP-K — the asset register rides the inventory feature
  fieldforce: "FIELD_FORCE", // WP-M — premium field force feature
  // ---- Wave R3-3 (SUB-101) — the apiAccess plan flag was a dead entitlement:
  // sold in the plan catalog, resolved into features.API, read by NOTHING.
  // Gating the integrations module makes key/webhook administration (and
  // therefore the whole public REST surface, which authenticateApiKey now
  // checks too) a real plan differentiator. LEGACY tenants pass untouched.
  integrations: "API",
}

/** HRM module key → limit key checked when CREATING records in that module.
 *  Capacity applies to create paths only — existing records stay usable even
 *  at/over limit (never bricks data the customer already owns).
 *
 *  Wave 2 WP-C (2026-10-08) — this map is now LIVE (it was an empty record
 *  since the SaaS layer shipped). It is the authoritative action → LimitKey
 *  registry, used by:
 *    1. `requireCreateCapacity()` — the shared create-path guard (called by
 *       the routes listed below);
 *    2. `usageSnapshot` projections (subscription.usage / UsagePanel);
 *    3. the create-time pre-check RPC so forms can warn before submit.
 *  The direct requireCapacity() calls in the routes stay (same keys, verified
 *  aligned): employees.create ×2 + bulk import (employees.ts), users create
 *  (admin.ts), branches/departments create (organization.ts CRUD factory),
 *  devices create + enable (devices.ts), tracking.start (tracking.ts),
 *  STORAGE on leave attachments + employee documents. */
export const MODULE_CAPACITY_ON_CREATE: Record<string, { limit: LimitKey; label: string; actions: string[] }> = {
  employees: {
    limit: "EMPLOYEES", label: "Active employees",
    actions: ["employees.create", "employees.save", "employees.bulkImport"],
  },
  users: {
    limit: "USERS", label: "Application users",
    actions: ["users.create", "users.save"],
  },
  organization: {
    limit: "BRANCHES", label: "Branches",
    actions: ["branches.create"],
  },
  departments: {
    limit: "DEPARTMENTS", label: "Departments",
    actions: ["departments.create"],
  },
  devices: {
    limit: "DEVICES", label: "Attendance devices",
    actions: ["devices.save", "devices.setEnabled"],
  },
  tracking: {
    limit: "TRACKING_EMPLOYEES", label: "Live-tracking employees",
    actions: ["tracking.start"],
  },
  documents: {
    limit: "STORAGE", label: "Storage quota",
    actions: ["employees.docSave", "leave.apply", "selfie.checkin"],
  },
}

/** Reverse index: RPC action → the LimitKey its create path enforces
 *  (derived, never hand-copied). Used by the capacity pre-check RPC. */
export const CAPACITY_BY_ACTION: Record<string, LimitKey> = Object.fromEntries(
  Object.entries(MODULE_CAPACITY_ON_CREATE).flatMap(([, v]) => v.actions.map((a) => [a, v.limit]))
)

/** WP-C — create-path capacity guard keyed by RPC action name. Routes keep
 *  their direct requireCapacity() calls (identical keys); this helper exists
 *  so new create paths have ONE obvious entry point and the Job Center /
 *  pre-check RPC can answer "would this action be blocked?" */
export async function requireCreateCapacity(vendorId: string, action: string, incoming = 1): Promise<void> {
  const limitKey = CAPACITY_BY_ACTION[action]
  if (!limitKey) return // action not capacity-gated
  await requireCapacity(vendorId, limitKey, incoming)
}

// ---- per-request memo (the dispatcher resolves once, routes reuse) ----------
let memoCache = new Map<string, { at: number; value: ResolvedEntitlements }>()
const MEMO_TTL_MS = 10_000 // cross-request cache: auth.me + dispatcher + guards share one resolve
// SCL-17 (Phase 2 WS5) — bounded entitlements memo: stale-first then
// oldest-inserted eviction past the cap (10 s TTL → at most one miss per
// vendor per window; the cap keeps the heap flat at 100K tenants)
const MEMO_CACHE_MAX = 10_000
function capMemoCache(): void {
  if (memoCache.size < MEMO_CACHE_MAX) return
  const now = Date.now()
  for (const [k, v] of memoCache) {
    if (now - v.at >= MEMO_TTL_MS) memoCache.delete(k)
    if (memoCache.size <= MEMO_CACHE_MAX / 2) return
  }
  while (memoCache.size >= MEMO_CACHE_MAX) {
    const first = memoCache.keys().next().value
    if (first == null) return
    memoCache.delete(first)
  }
}

export function invalidateEntitlements(vendorId?: string) {
  if (vendorId) {
    memoCache.delete(vendorId)
    // SCL-23 (Wave 11 §2) — cross-instance invalidation: the Redis DEL is
    // visible to EVERY app instance immediately, so a payment settled on
    // instance A unlocks the tenant on instance B without waiting out the
    // 10 s window. Fire-and-forget: on a Redis outage the entries self-
    // expire within the same 10 s TTL (identical staleness ceiling as the
    // pre-existing single-instance memo).
    void cacheDel(`ent:${vendorId}`)
  } else {
    memoCache = new Map()
    // No cheap way to DEL-all on Redis without SCAN; the ≤10 s TTL bounds
    // fleet-wide staleness by construction (this branch is emergencies/tests).
  }
}

export async function resolveEntitlements(vendorId: string): Promise<ResolvedEntitlements> {
  const hit = memoCache.get(vendorId)
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.value

  // SCL-23 (Wave 11 §2) — L2: the cluster-wide Redis share of the SAME 10 s
  // window. On N-instance deployments this collapses the per-instance memo
  // misses into ONE DB resolve per vendor per window fleet-wide. Miss-safe
  // by contract: no Redis / outage / cold key ⇒ null ⇒ fall through to
  // Postgres exactly as before. Postgres stays authoritative — the cached
  // payload is the same re-derivable projection the memo always held.
  const shared = await cacheGetJson<ResolvedEntitlements>(`ent:${vendorId}`).catch(() => null)
  if (shared) {
    // JSON round-trip revival (Dates arrive as ISO strings)
    shared.startDate = shared.startDate ? new Date(shared.startDate) : null
    shared.endDate = shared.endDate ? new Date(shared.endDate) : null
    capMemoCache(); memoCache.set(vendorId, { at: Date.now(), value: shared })
    return shared
  }

  const [sub, override] = await Promise.all([
    db.saasSubscription.findUnique({ where: { vendorId }, include: { plan: true } }),
    db.saasTenantOverride.findUnique({ where: { vendorId } }),
  ])

  const toggles: Record<string, boolean> = j(override?.featureToggles || "{}", {})
  const storageGbOverride = override?.storageGbOverride ?? null

  let value: ResolvedEntitlements
  if (!sub) {
    // LEGACY MODE — see header comment. Full access, no limits, never locked.
    value = {
      mode: "LEGACY",
      status: "LEGACY",
      planId: null, planName: null, billingCycle: null,
      startDate: null, endDate: null, daysRemaining: null,
      features: Object.fromEntries(["PAYROLL", "AIT", "INVENTORY", "PROCUREMENT", "PERFORMANCE", "ESS", "CAMERA", "TRACKING", "GEOFENCE", "API", "ADVANCED_REPORTS", "FIELD_FORCE"].map((k) => [k, true])),
      limits: {},
      overrides: toggles,
      storageGbOverride,
      readonly: false,
      locked: false,
    }
  } else {
    const plan = sub.plan
    const end = sub.endDate ? sub.endDate.getTime() : 0
    const daysRemaining = end > 0 ? Math.ceil((end - Date.now()) / 86400000) : null
    const features: Record<string, boolean> = {
      PAYROLL: plan.payrollEnabled,
      AIT: plan.aitEnabled,
      INVENTORY: plan.inventoryEnabled,
      PROCUREMENT: plan.procurementEnabled,
      PERFORMANCE: plan.performanceEnabled,
      ESS: plan.essEnabled,
      CAMERA: plan.cameraEnabled,
      TRACKING: plan.trackingEnabled,
      GEOFENCE: plan.geofenceEnabled,
      API: plan.apiAccess,
      ADVANCED_REPORTS: plan.advancedReports,
      FIELD_FORCE: plan.fieldForceEnabled,
    }
    // apply per-tenant overrides on top of plan values
    for (const mod of Object.keys(MODULE_FEATURE_GATES)) {
      const fk = MODULE_FEATURE_GATES[mod]
      if (typeof toggles[mod] === "boolean") features[fk] = toggles[mod]
    }
    const limits: Partial<Record<LimitKey, number | null>> = {
      EMPLOYEES: plan.employeeLimit,
      USERS: plan.userLimit,
      BRANCHES: plan.branchLimit,
      DEPARTMENTS: plan.departmentLimit,
      DEVICES: plan.deviceLimit,
      STORAGE: storageGbOverride != null ? storageGbOverride : plan.storageGb,
      TRACKING_EMPLOYEES: plan.trackingEmployeeLimit,
    }
    value = {
      mode: "SUBSCRIBED",
      status: sub.status,
      planId: plan.id,
      planName: sub.planName || plan.name,
      billingCycle: sub.billingCycle,
      startDate: sub.startDate,
      endDate: sub.endDate,
      daysRemaining,
      features,
      limits,
      overrides: toggles,
      storageGbOverride,
      readonly: READONLY_STATUSES.includes(sub.status),
      locked: LOCKED_STATUSES.includes(sub.status),
    }
  }
  capMemoCache(); memoCache.set(vendorId, { at: Date.now(), value })
  // L2 write-through — TTL identical to the memo window (10 s): a LONGER
  // Redis TTL would extend the staleness ceiling beyond the pre-existing
  // contract; a shorter one would just cost extra DB resolves. Locked /
  // readonly / expired states ride the SAME short window, so the L2 can
  // never keep a tenant locked out (or granted in) longer than the memo
  // already could.
  void cacheSetJson(`ent:${vendorId}`, value, MEMO_TTL_MS / 1000).catch(() => {})
  return value
}

// ---- Feature gate (used by the dispatcher, per route module) -----------------
/** 2026-10 module-consistency round — EVERY tenant module is controllable from
 *  the SaaS Owner Console: an explicit per-tenant override (SaaSTenantOverride
 *  .featureToggles) wins for ANY module key in TENANT_MODULES, core or
 *  plan-gated. Previously overrides were ignored for modules without a plan
 *  feature gate, so core modules could never be turned off for one tenant. */
export function featureBlocked(ent: ResolvedEntitlements, module: string): boolean {
  // 1. explicit per-tenant override beats everything (both directions)
  if (typeof ent.overrides[module] === "boolean") return !ent.overrides[module]
  // 2. plan feature gate (LEGACY tenants have no plan flags — all features on)
  const gate = MODULE_FEATURE_GATES[module]
  if (!gate) return false
  if (ent.mode === "LEGACY") return false
  return !ent.features[gate]
}

// ---- Capacity guard (used by targeted create paths) --------------------------
export type UsageSnapshot = {
  employees: number
  users: number
  branches: number
  departments: number
  devices: number
  trackingEmployees: number
  storageUsedBytes: number
}

/** Live usage counts. Storage is computed from the actual payload columns the
 *  app stores (data URLs / base64) — see storageUsedBytes for the exact list. */
export async function usageSnapshot(vendorId: string): Promise<UsageSnapshot> {
  const [employees, users, branches, departments, devices, tracking, storage] = await Promise.all([
    // active headcount against the plan: anyone still employed (excludes
    // RESIGNED/TERMINATED/RETIRED/INACTIVE leavers; SUSPENDED stays counted —
    // they still occupy a seat).
    db.employee.count({ where: { vendorId, status: { notIn: ["RESIGNED", "TERMINATED", "RETIRED", "INACTIVE"] } } }),
    db.user.count({ where: { vendorId, status: "ACTIVE" } }),
    db.branch.count({ where: { vendorId } }),
    db.department.count({ where: { vendorId } }),
    db.attendanceDevice.count({ where: { vendorId, enabled: true } }),
    db.employeeTrackingState.count({ where: { vendorId, trackingEnabled: true } }),
    storageUsedBytes(vendorId),
  ])
  return { employees, users, branches, departments, devices, trackingEmployees: tracking, storageUsedBytes: storage }
}

// ---- MOD-5 (Phase 2 WS6): storage rollup ----
// The four SUM(LENGTH(...)) scans over the tenant's inline payload columns
// used to run on EVERY upload authorization (and per vendor on the owner
// console). The rollup row is the read path now; write paths bump it
// best-effort via bumpStorageRollup() and the nightly set-based
// reconcileStorageRollups() heals any drift. Live computation remains as
// the seed/fallback for vendors without a rollup row yet.

/** Live byte total (the four inline-payload consumers) — used to seed the
 *  rollup and by the nightly reconciliation as the source of truth.
 *  MOD-5 note: the original expression LENGTH(photoUrl) + LENGTH(photoThumb)
 *  evaluated to NULL whenever photoThumb was NULL (every photo uploaded
 *  before thumbnails existed, and all photoUrl-only API callers), so those
 *  employees' photos contributed ZERO bytes to the quota. Per-column
 *  COALESCE makes the total the TRUE stored-byte figure. */
export async function storageUsedBytesLive(vendorId: string): Promise<number> {
  const rows = await db.$queryRaw<Array<{ total: bigint }>>`
    SELECT COALESCE(SUM(COALESCE(LENGTH("photoUrl"), 0) + COALESCE(LENGTH("photoThumb"), 0)), 0) AS total
    FROM "Employee" WHERE "vendorId" = ${vendorId}
    UNION ALL
    SELECT COALESCE(SUM(LENGTH("fileData")), 0) FROM "EmployeeDocument" WHERE "vendorId" = ${vendorId}
    UNION ALL
    SELECT COALESCE(SUM(LENGTH("attachmentData")), 0) FROM "LeaveRequest" WHERE "vendorId" = ${vendorId}
    UNION ALL
    SELECT COALESCE(SUM(LENGTH("data")), 0) FROM "AttendanceProof" WHERE "vendorId" = ${vendorId}
  `
  // Each SELECT returns one row; sum the per-source totals.
  const total = rows.reduce((acc, r) => acc + Number(r.total || 0), 0)
  return total
}

/** Storage used by this vendor — ONE indexed rollup read (MOD-5). A missing
 *  row (first boot after the migration) is computed live and seeded so the
 *  next read is O(1). */
export async function storageUsedBytes(vendorId: string): Promise<number> {
  const row = await db.usageRollup.findUnique({ where: { vendorId } }).catch(() => null)
  if (row) return Number(row.storageBytes)
  const live = await storageUsedBytesLive(vendorId)
  await db.usageRollup.upsert({
    where: { vendorId },
    create: { vendorId, storageBytes: live },
    update: { storageBytes: live, reconciledAt: new Date() },
  }).catch(() => {})
  return live
}

/** Best-effort incremental bump for storage write paths (photo save, document
 *  upload/replace/delete, leave attachment, selfie proof, employee-delete
 *  cascades). Never throws — the nightly reconciliation is the correctness
 *  backstop, so a missed or double-counted bump self-heals within a day. */
export async function bumpStorageRollup(vendorId: string, deltaBytes: number): Promise<void> {
  if (!Number.isFinite(deltaBytes) || deltaBytes === 0) return
  try {
    await db.usageRollup.upsert({
      where: { vendorId },
      create: { vendorId, storageBytes: deltaBytes > 0 ? deltaBytes : 0 },
      update: { storageBytes: { increment: deltaBytes } },
    })
  } catch { /* best-effort — nightly reconcile heals */ }
}

/** Nightly set-based reconciliation: recompute every vendor's true byte total
 *  in ONE statement and correct the rollups (self-healing for any missed or
 *  double-counted incremental bump). Returns the number of vendors whose
 *  rollup changed. */
export async function reconcileStorageRollups(): Promise<number> {
  const res = await db.$executeRaw`
    INSERT INTO "UsageRollup" ("vendorId", "storageBytes", "reconciledAt", "updatedAt")
    SELECT v."id",
           COALESCE(s.total, 0),
           now(),
           now()
    FROM "Vendor" v
    LEFT JOIN (
      SELECT "vendorId", SUM(bytes) AS total FROM (
        SELECT "vendorId", SUM(COALESCE(LENGTH("photoUrl"), 0) + COALESCE(LENGTH("photoThumb"), 0)) AS bytes FROM "Employee" GROUP BY 1
        UNION ALL
        SELECT "vendorId", SUM(LENGTH("fileData")) AS bytes FROM "EmployeeDocument" GROUP BY 1
        UNION ALL
        SELECT "vendorId", SUM(LENGTH("attachmentData")) AS bytes FROM "LeaveRequest" GROUP BY 1
        UNION ALL
        SELECT "vendorId", SUM(LENGTH("data")) AS bytes FROM "AttendanceProof" GROUP BY 1
      ) u GROUP BY 1
    ) s ON s."vendorId" = v."id"
    ON CONFLICT ("vendorId") DO UPDATE
      SET "storageBytes" = EXCLUDED."storageBytes",
          "reconciledAt" = now(),
          "updatedAt" = now()
      WHERE "UsageRollup"."storageBytes" IS DISTINCT FROM EXCLUDED."storageBytes"`
  return Number(res || 0)
}

export class EntitlementError extends Error {
  code: number
  limitKey?: LimitKey
  used?: number
  cap?: number | null
  constructor(message: string, opts: { code?: number; limitKey?: LimitKey; used?: number; cap?: number | null } = {}) {
    super(message)
    this.name = "EntitlementError"
    this.code = opts.code || 403
    this.limitKey = opts.limitKey
    this.used = opts.used
    this.cap = opts.cap
  }
}

/** Server-side capacity check for a CREATE path.
 *  @param incoming how many NEW units this operation wants to add (default 1).
 *  LEGACY tenants have no limits configured → always passes (empty limits map). */
export async function requireCapacity(
  vendorId: string,
  limitKey: LimitKey,
  incoming: number = 1,
  opts: { extraUsed?: number } = {}
): Promise<void> {
  const ent = await resolveEntitlements(vendorId)
  if (ent.readonly) {
    throw new EntitlementError(
      `Your subscription is ${ent.status === "SUSPENDED" ? "suspended" : "expired"}. The workspace is read-only until the subscription is renewed — contact your platform administrator.`,
      { code: 403 }
    )
  }
  const cap = ent.limits[limitKey]
  if (cap == null) return // unlimited / not configured for this plan
  const usage = await usageSnapshot(vendorId)
  const used =
    limitKey === "STORAGE"
      ? usage.storageUsedBytes + (opts.extraUsed || 0)
      : limitKey === "EMPLOYEES" ? usage.employees
      : limitKey === "USERS" ? usage.users
      : limitKey === "BRANCHES" ? usage.branches
      : limitKey === "DEPARTMENTS" ? usage.departments
      : limitKey === "DEVICES" ? usage.devices
      : limitKey === "TRACKING_EMPLOYEES" ? usage.trackingEmployees
      : 0
  const capBytes = limitKey === "STORAGE" ? cap * 1024 * 1024 * 1024 : cap
  if (used + incoming > capBytes) {
    const planLabel = ent.planName || "your current plan"
    if (limitKey === "STORAGE") {
      throw new EntitlementError(
        `Storage quota reached: your ${planLabel} plan includes ${cap} GB and ${(used / 1024 / 1024 / 1024).toFixed(2)} GB is in use. Delete unused documents or upgrade your plan.`,
        { code: 403, limitKey, used, cap }
      )
    }
    const label =
      limitKey === "EMPLOYEES" ? "active employees"
      : limitKey === "USERS" ? "users"
      : limitKey === "BRANCHES" ? "branches"
      : limitKey === "DEPARTMENTS" ? "departments"
      : limitKey === "DEVICES" ? "attendance devices"
      : limitKey === "TRACKING_EMPLOYEES" ? "live-tracking employees"
      : String(limitKey).toLowerCase()
    throw new EntitlementError(
      `Your ${planLabel} plan allows ${cap} ${label}. You currently have ${used}. Upgrade your plan to add more.`,
      { code: 403, limitKey, used, cap }
    )
  }
}

/** Feature requirement for a mutating module action (dispatcher-level gate is
 *  featureBlocked(); this variant throws the rich upgrade message for direct
 *  use inside handlers that need a specific feature beyond the module map). */
export async function requireFeature(vendorId: string, feature: FeatureKey): Promise<void> {
  const ent = await resolveEntitlements(vendorId)
  if (ent.readonly) {
    throw new EntitlementError(
      `Your subscription is ${ent.status === "SUSPENDED" ? "suspended" : "expired"}. The workspace is read-only until it is renewed.`,
      { code: 403 }
    )
  }
  if (ent.mode === "LEGACY") return
  if (!ent.features[feature]) {
    throw new EntitlementError(
      `${feature} is not included in your ${ent.planName || "current"} plan. Contact your platform administrator to upgrade.`,
      { code: 403 }
    )
  }
}

/** SUB-106 (Wave R3-5) — storage-metered selfie/photo write guard.
 *  Selfie proofs (attendance punches, periodic checks, field-force visit
 *  photos) are the fastest-growing STORAGE consumer and were the one unmetered
 *  inflow: the capacity registry lists "selfie.checkin" under STORAGE but no
 *  route enforced it. Mirrors the leave-attachment pattern (leave.ts):
 *  the incoming base64 payload length is counted as extraUsed against the
 *  plan quota BEFORE any database row is written, so a quota rejection leaves
 *  nothing behind (no orphan punch rows). LEGACY tenants pass untouched. */
export async function requireSelfieStorage(vendorId: string, photoDataUrl: unknown): Promise<void> {
  const extra = typeof photoDataUrl === "string" ? photoDataUrl.length : 0
  if (extra === 0) return // no payload → no storage consumed → nothing to meter
  await requireCapacity(vendorId, "STORAGE", 0, { extraUsed: extra })
}

/** Read-only lockout for mutating actions (dispatcher-level). */
export function readonlyBlocked(ent: ResolvedEntitlements): boolean {
  return ent.readonly
}

/** Public (marketing/SPA) projection of entitlements — no secrets, no ids that
 *  could be used for enumeration. Attached to auth.me / login payloads. */
export function publicEntitlements(ent: ResolvedEntitlements) {
  return {
    mode: ent.mode,
    status: ent.status,
    planName: ent.planName,
    billingCycle: ent.billingCycle,
    endDate: ent.endDate,
    daysRemaining: ent.daysRemaining,
    readonly: ent.readonly,
    locked: ent.locked,
    features: ent.mode === "SUBSCRIBED" ? ent.features : null,
    limits: ent.mode === "SUBSCRIBED" ? ent.limits : null,
  }
}
