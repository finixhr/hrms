// ============ Wave 2 WP-M — Field Force Management routes ============
// Visit locations (client/site master data), daily visit plans (one plan per
// employee per day), GPS-validated visit check-in/out from the ESS portal,
// the admin planning board and the compliance report. The daily sweep that
// materializes MISSED visits for past-window plan items lives in jobs.ts
// (fieldforceMissedSweep) — it is NOT reimplemented here.
//
// Conventions (mirroring routes/tracking.ts + routes/attendance.ts):
//   - Every query is vendorId-scoped (H-10 tenant isolation); cross-tenant
//     ids surface as 404.
//   - Admin routes declare perm: ["fieldforce", view|edit|delete] — the
//     dispatcher enforces the module permission AND the FIELD_FORCE plan
//     feature gate before the handler runs.
//   - Employee self-service routes (fieldforce.myday / visit.checkin /
//     visit.checkout) are INTENTIONALLY_SELF_SCOPED (M-02), exactly like the
//     attendance geo punch routes: they carry NO dispatcher-level perm (the
//     EMPLOYEE role holds no fieldforce.* permission) — the handler derives
//     the acting employee from the authenticated session and enforces
//     own-record-only. The FIELD_FORCE feature gate (+ the read-only
//     lockout for the mutating ones) is applied in-handler via the shared
//     entitlements helpers because the "fieldforce" prefix is not in the
//     dispatcher's SAAS_ACTION_PREFIX_MODULE map (that file is frozen for
//     this work package).
//   - GPS distance is ALWAYS computed server-side with the shared haversine
//     helper from ../geo (the same math the geo-fence attendance check-in
//     uses, §22 — the client's "inside" claim is never trusted).
//
// OUT-OF-RADIUS CHECK-IN RULE (documented DECISION — no settings
// infrastructure exists for this module and the settings surface is frozen
// for Wave 2): a check-in whose server-computed distance exceeds the
// location radius is REJECTED when the employee supplies no justification
// note (strict path), and ACCEPTED-WITH-FLAG when a note IS provided: the
// distance and radius are recorded in the visit remarks
// ("[OUT-OF-RADIUS …]") and the response carries outOfRadius=true so the
// admin timeline and the ESS card surface the flag.
import { db } from "@/lib/db"
import { bumpStorageRollup } from "../saas/entitlements"
import { route } from "./registry"
import { Deny, employeeScopeFilter, assertEmployeeVisible } from "../rbac"
import { audit } from "../audit"
import { getSettings } from "../settings"
import { haversineM } from "../geo"
import { validateSelfieDataUrl } from "../uploads"
import { rateLimitDistributed, RATE_LIMITS } from "../rate-limit"
import { requireFeature, requireSelfieStorage, resolveEntitlements, featureBlocked, MODULE_FEATURE_GATES } from "../saas/entitlements"
import { today, addDays, fromZonedWall, daysBetween, pct, titleCase, tzOffsetHours } from "../utils"
import { z } from "zod"

// ---------------------------------------------------------------- helpers

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

/** FormDialog clients submit "" for untouched optional string fields —
 *  normalize to null so optional columns store clean nulls. */
function normStr(v?: string | null): string | null {
  if (v == null) return null
  const t = v.trim()
  return t === "" ? null : t.slice(0, 2000)
}

/** Feature gate for the SELF-SCOPED read route (myday) — mirrors the
 *  dispatcher's view-route semantics: plan gate applies, read-only lockout
 *  does NOT (data stays visible on an expired subscription). */
async function requireFieldForceFeature(vendorId: string): Promise<void> {
  const ent = await resolveEntitlements(vendorId)
  if (featureBlocked(ent, "fieldforce")) {
    const gate = MODULE_FEATURE_GATES.fieldforce
    throw new Deny(`${gate} is not included in your ${ent.planName || "current"} plan. Contact your platform administrator to upgrade.`, 403)
  }
}

/** H-04/H-05 — resolve the acting employee for visit self-service actions,
 *  mirroring resolveCheckActor in attendance.ts: EMPLOYEE callers act
 *  strictly for themselves; staff acting on behalf of a DIFFERENT employee
 *  need fieldforce.edit AND the target must be inside their visibility
 *  scope (assertEmployeeVisible), with the on-behalf fact audit-logged. */
async function resolveVisitActor(ctx: any, p: { employeeId?: string }, action: string): Promise<string> {
  if (ctx.role === "EMPLOYEE") {
    if (p.employeeId && p.employeeId !== ctx.employeeId) throw new Deny("You can only record visits for yourself")
    if (!ctx.employeeId) throw new Deny("No employee profile linked to your account", 400)
    return ctx.employeeId
  }
  const employeeId = p.employeeId || ctx.employeeId
  if (!employeeId) throw new Deny("No employee profile linked to your account", 400)
  if (employeeId !== ctx.employeeId) {
    // staff acting for someone else — privileged path
    if (!ctx.permissions.has("fieldforce.edit")) {
      throw new Deny("Recording a visit for another employee requires the fieldforce.edit permission")
    }
    const target = await assertEmployeeVisible(ctx, employeeId)
    await audit(ctx, action, "Visit", null,
      `${action} performed on behalf of ${target.fullName} (${target.code}) by ${ctx.userName} [${ctx.role}] — note: GPS coordinates are those of the recording device`)
  }
  return employeeId
}

/** M-14 — photo-proof throttle (same preset as the attendance selfie path):
 *  visit check-in photos are the same abuse surface as punch selfies. */
async function guardVisitPhotoRate(employeeId: string) {
  const preset = RATE_LIMITS.selfie
  // SCL-21 (Phase 3 WS-B) — Redis bucket first when configured (cluster-wide)
  const r = await rateLimitDistributed(`selfie:${employeeId}`, preset.limit, preset.windowMs)
  if (!r.ok) throw new Deny(`Too many photo uploads — retry in ${r.retryAfterSec}s`, 429)
}

/** Store an inline visit photo as a private AttendanceProof row (the exact
 *  pattern the attendance geo punch uses — byte-sniffed via
 *  validateSelfieDataUrl, sha-256 hashed, retention-stamped) and return its
 *  id. Visit.checkInPhotoId references this row. */
async function storeVisitPhoto(
  vendorId: string, employeeId: string, p: any, retentionDays: number
): Promise<string | null> {
  if (!p.photoDataUrl) return null
  await guardVisitPhotoRate(employeeId)
  const check = validateSelfieDataUrl(String(p.photoDataUrl))
  if (!check.ok) throw new Deny(check.reason, 400)
  // SUB-106 (R3-5) — visit photos are AttendanceProof rows: the same STORAGE
  // consumer as punch selfies, metered before the row is written (LEGACY
  // tenants have no quota configured and pass untouched).
  await requireSelfieStorage(vendorId, p.photoDataUrl)
  const m = /^data:([^;]+);base64,([\s\S]+)$/.exec(String(p.photoDataUrl))
  if (!m) throw new Deny("Photo must be a base64 data URL", 400)
  const bytes = Buffer.from(m[2], "base64")
  const { createHash } = await import("node:crypto")
  let qualityJson = "{}"
  if (p.photoQuality && typeof p.photoQuality === "object") {
    try { qualityJson = JSON.stringify(p.photoQuality).slice(0, 2000) } catch { /* keep {} */ }
  }
  const proof = await db.attendanceProof.create({
    data: {
      vendorId, employeeId, attendanceEventId: null,
      proofType: "VISIT_PHOTO",
      storageKey: `proof/${vendorId}/${employeeId}/${Date.now()}`,
      mimeType: check.mime,
      fileHash: createHash("sha256").update(bytes).digest("hex"),
      byteSize: bytes.byteLength,
      data: m[2],
      capturedAt: new Date(),
      latitude: p.lat ?? null, longitude: p.lng ?? null, accuracyM: p.accuracy ?? null,
      deviceId: null,
      verificationStatus: "EVIDENCE",
      qualityJson,
      retentionUntil: retentionDays > 0 ? new Date(Date.now() + retentionDays * 86_400_000) : null,
    },
  })
  // MOD-5 (Phase 2 WS6) — inline proof bytes bump (best-effort)
  await bumpStorageRollup(vendorId, m[2].length).catch(() => {})
  return proof.id
}

type LocRef = { name: string; lat: number; lng: number; radiusM: number }

/** Decorate visit rows for timeline consumption: location name join + the
 *  server-recomputed check-in distance / out-of-radius flag (never a
 *  client-claimed value). */
function decorateVisits(visits: any[], locations: Map<string, LocRef>) {
  return visits.map((v) => {
    const loc = locations.get(v.locationId)
    let distanceM: number | null = null
    if (loc && v.checkInLat != null && v.checkInLng != null) {
      distanceM = Math.round(haversineM(v.checkInLat, v.checkInLng, loc.lat, loc.lng))
    }
    return {
      ...v,
      locationName: loc?.name ?? "—",
      distanceM,
      outOfRadius: distanceM != null && loc != null && distanceM > loc.radiusM,
    }
  })
}

/** Day window for a business date in the deployment zone (utils.ts — never
 *  the server-local zone, which may be UTC in containerized deployments). */
function dayRange(date: string): { start: Date; end: Date } {
  return { start: fromZonedWall(`${date}T00:00:00`), end: fromZonedWall(`${addDays(date, 1)}T00:00:00`) }
}

// ============================================================ LOCATIONS

// ---- R9 (2026-10-12): forward geocoding proxy for the visit-location map
// picker (and any future address search). Server-side proxy avoids browser
// CORS/UA restrictions, enforces a hard timeout, and memoizes results for
// 10 minutes. Permission-gated to fieldforce.view (it's a location-picker
// aid, not a data export).
const geoCache = new Map<string, { at: number; rows: { label: string; lat: number; lng: number }[] }>()
const GEO_TTL = 10 * 60 * 1000
route("fieldforce.geo.search", {
  perm: ["fieldforce", "view"],
  schema: z.object({ q: z.string().trim().min(3).max(200) }).strict(),
  handler: async (_ctx, p) => {
    const q = p.q.trim()
    const cacheKey = q.toLowerCase()
    const hit = geoCache.get(cacheKey)
    if (hit && Date.now() - hit.at < GEO_TTL) return { results: hit.rows }
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 6000)
    try {
      const url = new URL("https://nominatim.openstreetmap.org/search")
      url.searchParams.set("q", q)
      url.searchParams.set("format", "jsonv2")
      url.searchParams.set("limit", "6")
      url.searchParams.set("addressdetails", "0")
      const res = await fetch(url, {
        signal: ctl.signal,
        headers: {
          // Nominatim usage policy requires a identifying UA
          "User-Agent": "FinixHR/1.0 (visit-location-picker)",
          "Accept-Language": "en, bn",
        },
      })
      if (!res.ok) throw new Deny("Address search is temporarily unavailable (upstream " + res.status + ")", 502)
      const raw: any[] = await res.json()
      const rows = (Array.isArray(raw) ? raw : []).slice(0, 6).map((r) => ({
        label: String(r.display_name || "").slice(0, 200),
        lat: Number(Number(r.lat).toFixed(7)),
        lng: Number(Number(r.lon).toFixed(7)),
      })).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng))
      geoCache.set(cacheKey, { at: Date.now(), rows })
      return { results: rows }
    } catch (e: any) {
      if (e instanceof Deny) throw e
      throw new Deny("Address search timed out — type coordinates directly or click the map", 504)
    } finally {
      clearTimeout(timer)
    }
  },
})

route("fieldforce.locations.list", {
  perm: ["fieldforce", "view"],
  schema: z.object({ includeInactive: z.boolean().optional() }).strict(),
  handler: async (ctx, p) => {
    const locations = await db.visitLocation.findMany({
      where: { vendorId: ctx.vendorId, ...(p.includeInactive ? {} : { active: true }) },
      orderBy: { name: "asc" },
    })
    return { locations }
  },
})

route("fieldforce.locations.save", {
  perm: ["fieldforce", "edit"],
  schema: z.object({
    id: z.string().min(1).optional(),
    name: z.string().trim().min(1).max(120),
    address: z.string().max(300).optional(),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    radiusM: z.number().int().min(10).max(5000),
    contactName: z.string().max(120).optional(),
    contactPhone: z.string().max(40).optional(),
    note: z.string().max(2000).optional(),
    active: z.boolean().optional(),
  }).strict(),
  handler: async (ctx, p) => {
    const name = p.name.trim()
    // friendly duplicate-name guard (the compound unique [vendorId, name]
    // would otherwise surface as a generic P2002 message)
    const dupe = await db.visitLocation.findFirst({ where: { vendorId: ctx.vendorId, name } })
    if (dupe && dupe.id !== p.id) throw new Deny(`A visit location named “${name}” already exists`, 400)
    const data = {
      name,
      address: normStr(p.address),
      lat: p.lat,
      lng: p.lng,
      radiusM: p.radiusM,
      contactName: normStr(p.contactName),
      contactPhone: normStr(p.contactPhone),
      note: normStr(p.note),
      active: p.active ?? true,
    }
    if (p.id) {
      const existing = await db.visitLocation.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
      if (!existing) throw new Deny("Visit location not found", 404)
      const updated = await db.visitLocation.update({ where: { id: p.id }, data })
      await audit(ctx, "fieldforce.locations.save", "VisitLocation", updated.id,
        `${data.active === false ? "Disabled" : "Updated"} visit location ${updated.name} (${updated.lat.toFixed(5)}, ${updated.lng.toFixed(5)}, r=${updated.radiusM}m)`,
        {
          oldValue: { name: existing.name, lat: existing.lat, lng: existing.lng, radiusM: existing.radiusM, active: existing.active },
          newValue: { name: updated.name, lat: updated.lat, lng: updated.lng, radiusM: updated.radiusM, active: updated.active },
        })
      return updated
    }
    const created = await db.visitLocation.create({ data: { vendorId: ctx.vendorId, ...data } })
    await audit(ctx, "fieldforce.locations.save", "VisitLocation", created.id,
      `Created visit location ${created.name} (${created.lat.toFixed(5)}, ${created.lng.toFixed(5)}, r=${created.radiusM}m)`)
    return created
  },
})

route("fieldforce.locations.delete", {
  perm: ["fieldforce", "delete"],
  schema: z.object({ id: z.string().min(1) }).strict(),
  handler: async (ctx, p) => {
    const existing = await db.visitLocation.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!existing) throw new Deny("Visit location not found", 404)
    // soft delete: historical plans/visits keep their references
    await db.visitLocation.update({ where: { id: p.id }, data: { active: false } })
    await audit(ctx, "fieldforce.locations.delete", "VisitLocation", p.id,
      `Disabled (soft-deleted) visit location ${existing.name}`)
    return { ok: true }
  },
})

// ============================================================ PLANS

route("fieldforce.plan.get", {
  perm: ["fieldforce", "view"],
  schema: z.object({
    date: z.string().regex(ISO_DATE),
    employeeId: z.string().min(1).nullish(), // R7 (2026-10-12) — the Reports/Board tabs send null for "all"
  }).strict(),
  handler: async (ctx, p) => {
    // explicit employeeId must be inside the caller's visibility scope;
    // without one, a caller with a linked employee profile reads their own
    const employeeId = p.employeeId
      ? (await assertEmployeeVisible(ctx, p.employeeId)).id
      : ctx.employeeId
    if (!employeeId) throw new Deny("employeeId is required (or sign in with a linked employee profile)", 400)
    const plan = await db.visitPlan.findUnique({
      where: { vendorId_employeeId_date: { vendorId: ctx.vendorId, employeeId, date: p.date } },
    })
    const items = plan
      ? await db.visitPlanItem.findMany({ where: { vendorId: ctx.vendorId, planId: plan.id }, orderBy: { createdAt: "asc" } })
      : []
    // visits linked to the day's plan items (includes the sweep's MISSED
    // rows for past dates) + ad-hoc visits made that day
    const itemIds = items.map((i) => i.id)
    const linkedVisits = itemIds.length
      ? await db.visit.findMany({ where: { vendorId: ctx.vendorId, planItemId: { in: itemIds } } })
      : []
    const { start, end } = dayRange(p.date)
    const adHocVisits = await db.visit.findMany({
      where: { vendorId: ctx.vendorId, employeeId, planItemId: null, checkInAt: { gte: start, lt: end } },
    })
    const visits = [...linkedVisits, ...adHocVisits]
      .sort((a, b) => new Date(a.checkInAt).getTime() - new Date(b.checkInAt).getTime())
    const locationIds = [...new Set([...items.map((i) => i.locationId), ...visits.map((v) => v.locationId)])]
    const locRows = locationIds.length
      ? await db.visitLocation.findMany({ where: { vendorId: ctx.vendorId, id: { in: locationIds } } })
      : []
    const fullLocs = new Map(locRows.map((l) => [l.id, l]))
    const locMap = new Map(locRows.map((l) => [l.id, { name: l.name, lat: l.lat, lng: l.lng, radiusM: l.radiusM } as LocRef]))
    return {
      plan,
      employeeId,
      date: p.date,
      items: items.map((i) => {
        const loc = fullLocs.get(i.locationId)
        const visit = linkedVisits.find((v) => v.planItemId === i.id) ?? null
        let distanceM: number | null = null
        if (loc && visit && visit.checkInLat != null && visit.checkInLng != null) {
          distanceM = Math.round(haversineM(visit.checkInLat, visit.checkInLng, loc.lat, loc.lng))
        }
        return {
          ...i,
          locationName: loc?.name ?? "—",
          locationAddress: loc?.address ?? null,
          locationLat: loc?.lat ?? null,
          locationLng: loc?.lng ?? null,
          locationActive: loc?.active ?? null,
          radiusM: loc?.radiusM ?? null,
          visit: visit
            ? {
                id: visit.id, status: visit.status, checkInAt: visit.checkInAt, checkOutAt: visit.checkOutAt,
                durationMin: visit.durationMin, remarks: visit.remarks,
                distanceM,
                outOfRadius: distanceM != null && loc != null && distanceM > loc.radiusM,
              }
            : null,
        }
      }),
      visits: decorateVisits(visits, locMap),
    }
  },
})

route("fieldforce.plan.save", {
  perm: ["fieldforce", "edit"],
  schema: z.object({
    employeeId: z.string().min(1),
    date: z.string().regex(ISO_DATE),
    note: z.string().max(2000).optional(),
    items: z.array(z.object({
      id: z.string().min(1).optional(),
      locationId: z.string().min(1),
      plannedFrom: z.string().regex(HHMM).optional(),
      plannedTo: z.string().regex(HHMM).optional(),
      tasks: z.string().max(4000).optional(),
    }).strict()).max(50),
  }).strict(),
  handler: async (ctx, p) => {
    // employee must exist in the caller's tenant AND visibility scope
    const emp = await assertEmployeeVisible(ctx, p.employeeId)
    // every referenced location must exist in this tenant (cross-tenant ids → 404)
    const locationIds: string[] = [...new Set<string>(p.items.map((i: any) => i.locationId as string))]
    const locations = locationIds.length
      ? await db.visitLocation.findMany({ where: { vendorId: ctx.vendorId, id: { in: locationIds } } })
      : []
    const locNames = new Map(locations.map((l) => [l.id, l.name]))
    for (const id of locationIds) {
      if (!locNames.has(id)) throw new Deny("Visit location not found", 404)
    }
    // planned window sanity (HH:MM strings compare lexicographically)
    for (const i of p.items) {
      if (i.plannedFrom && i.plannedTo && i.plannedFrom > i.plannedTo) {
        throw new Deny(`Planned window is inverted for ${locNames.get(i.locationId) ?? "an item"} (${i.plannedFrom} is after ${i.plannedTo})`, 400)
      }
    }
    // nothing to create when the day has no items and no plan exists yet
    const existingPlan = await db.visitPlan.findUnique({
      where: { vendorId_employeeId_date: { vendorId: ctx.vendorId, employeeId: p.employeeId, date: p.date } },
    })
    if (!existingPlan && p.items.length === 0) return { ok: true, plan: null }
    // upsert the plan (unique [vendorId, employeeId, date])
    const plan = await db.visitPlan.upsert({
      where: { vendorId_employeeId_date: { vendorId: ctx.vendorId, employeeId: p.employeeId, date: p.date } },
      create: { vendorId: ctx.vendorId, employeeId: p.employeeId, date: p.date, note: normStr(p.note) },
      update: { note: normStr(p.note) },
    })
    // diff-sync the items: keep/update items whose id is present (and
    // belongs to THIS plan — a foreign item id is a 404, not a silent
    // overwrite), create the new ones, delete the dropped ones. Existing
    // Visit rows keep their denormalized data (locationId, times) when an
    // item is deleted.
    const existingItems = await db.visitPlanItem.findMany({ where: { vendorId: ctx.vendorId, planId: plan.id } })
    const existingMap = new Map(existingItems.map((i) => [i.id, i]))
    const keepIds = new Set<string>()
    for (const item of p.items) {
      if (item.id) {
        const ex = existingMap.get(item.id)
        if (!ex || ex.planId !== plan.id) throw new Deny("Plan item not found", 404)
        keepIds.add(item.id)
        await db.visitPlanItem.update({
          where: { id: item.id },
          data: {
            locationId: item.locationId,
            plannedFrom: normStr(item.plannedFrom),
            plannedTo: normStr(item.plannedTo),
            tasks: normStr(item.tasks),
          },
        })
      } else {
        const created = await db.visitPlanItem.create({
          data: {
            vendorId: ctx.vendorId, planId: plan.id, locationId: item.locationId,
            plannedFrom: normStr(item.plannedFrom), plannedTo: normStr(item.plannedTo), tasks: normStr(item.tasks),
          },
        })
        keepIds.add(created.id)
      }
    }
    for (const ex of existingItems) {
      if (!keepIds.has(ex.id)) {
        await db.visitPlanItem.delete({ where: { id: ex.id } })
      }
    }
    await audit(ctx, "fieldforce.plan.save", "VisitPlan", plan.id,
      `Saved visit plan for ${emp.fullName} (${emp.code}) on ${p.date}: ${p.items.length} item(s) — ${p.items.map((i: any) => locNames.get(i.locationId) ?? "?").join(", ") || "no locations"}`,
      { newValue: { employeeId: p.employeeId, date: p.date, items: p.items.length, note: normStr(p.note) } })
    return { ok: true, plan }
  },
})

route("fieldforce.plan.delete", {
  perm: ["fieldforce", "delete"],
  schema: z.object({ id: z.string().min(1) }).strict(),
  handler: async (ctx, p) => {
    const plan = await db.visitPlan.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!plan) throw new Deny("Visit plan not found", 404)
    await db.visitPlanItem.deleteMany({ where: { vendorId: ctx.vendorId, planId: plan.id } })
    await db.visitPlan.delete({ where: { id: plan.id } })
    await audit(ctx, "fieldforce.plan.delete", "VisitPlan", plan.id,
      `Deleted visit plan for employee ${plan.employeeId} on ${plan.date}`)
    return { ok: true }
  },
})

// ============================================================ VISITS (self-service)

// INTENTIONALLY_SELF_SCOPED (M-02): employee check-in — identity derives from
// the session; the GPS distance to the location is computed SERVER-SIDE with
// the shared haversine helper (../geo), never from a client claim.
route("fieldforce.visit.checkin", {
  schema: z.object({
    employeeId: z.string().min(1).optional(), // staff acting on behalf only
    locationId: z.string().min(1),
    planItemId: z.string().min(1).optional(),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    accuracy: z.number().min(0).max(100000).optional(),
    photoId: z.string().min(1).optional(),   // reference to an existing proof row
    photoDataUrl: z.string().max(3_000_000).optional(), // inline photo (byte-sniffed server-side)
    photoQuality: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
    remarks: z.string().max(2000).optional(),
  }).strict(),
  handler: async (ctx, p) => {
    // self-scoped route: apply the FIELD_FORCE feature gate + read-only
    // lockout in-handler (mirrors the dispatcher's mutating-route semantics)
    await requireFeature(ctx.vendorId, "FIELD_FORCE")
    const employeeId = await resolveVisitActor(ctx, p, "fieldforce.visit.checkin")
    const emp = await db.employee.findFirst({ where: { id: employeeId, vendorId: ctx.vendorId } })
    if (!emp) throw new Deny("Employee not found", 404)

    const loc = await db.visitLocation.findFirst({ where: { id: p.locationId, vendorId: ctx.vendorId } })
    if (!loc) throw new Deny("Visit location not found", 404)
    if (!loc.active) throw new Deny(`${loc.name} is disabled — contact your supervisor`, 400)

    // plan item (optional): must belong to the acting employee's plan for
    // TODAY (a past item is already handled by the missed-visit sweep; a
    // future item cannot be checked into yet)
    let planItemId: string | null = null
    if (p.planItemId) {
      const item = await db.visitPlanItem.findFirst({ where: { id: p.planItemId, vendorId: ctx.vendorId } })
      if (!item) throw new Deny("Plan item not found", 404)
      const plan = await db.visitPlan.findFirst({ where: { id: item.planId, vendorId: ctx.vendorId } })
      if (!plan || plan.employeeId !== employeeId) throw new Deny("Plan item not found", 404)
      if (plan.date !== today()) {
        throw new Deny(`That visit is planned for ${plan.date} — plan items can only be checked into on their planned day`, 400)
      }
      const existingVisit = await db.visit.findFirst({ where: { vendorId: ctx.vendorId, planItemId: item.id } })
      if (existingVisit) {
        throw new Deny(`A visit record already exists for this plan item (${titleCase(existingVisit.status)})`, 400)
      }
      planItemId = item.id
    }

    // one open visit at a time — check out before starting the next one
    const open = await db.visit.findFirst({
      where: { vendorId: ctx.vendorId, employeeId, status: "CHECKED_IN", checkOutAt: null },
    })
    if (open) {
      const openLoc = await db.visitLocation.findFirst({ where: { id: open.locationId, vendorId: ctx.vendorId } })
      throw new Deny(`You still have an open visit at ${openLoc?.name ?? "a location"} — check out there first`, 400)
    }

    // ---- SERVER-SIDE geo validation (§22): same haversine math as the
    // geo-fence attendance check-in; the client's distance/inside claim is
    // never consulted. See the OUT-OF-RADIUS rule in the header comment.
    const distanceM = Math.round(haversineM(p.lat, p.lng, loc.lat, loc.lng))
    const outOfRadius = distanceM > loc.radiusM
    let remarks = normStr(p.remarks)
    if (outOfRadius && !remarks) {
      // STRICT path: outside the radius with no justification → reject. The
      // message tells the employee exactly how to proceed (retry inside, or
      // supply a note to check in flagged).
      throw new Deny(
        `You are ${distanceM}m from ${loc.name} (allowed ${loc.radiusM}m). Move inside the allowed radius, or add a note explaining why you are checking in from outside — the visit will be flagged for review.`,
        400,
      )
    }
    if (outOfRadius) {
      // FLEXIBLE path: accepted with the mandatory note; the flag is durable
      // in the remarks so the timeline/report can surface it.
      remarks = `[OUT-OF-RADIUS ${distanceM}m / allowed ${loc.radiusM}m] ${remarks}`
    }

    // optional photo proof: an inline data URL is byte-sniffed and stored as
    // a private AttendanceProof row (same pipeline as attendance selfies);
    // an explicit photoId must reference the employee's own proof row.
    let photoId: string | null = null
    if (p.photoDataUrl) {
      const settings = await getSettings(ctx.vendorId)
      photoId = await storeVisitPhoto(ctx.vendorId, employeeId, p, Number((settings as any).tracking?.retentionDays ?? 90))
    } else if (p.photoId) {
      const proof = await db.attendanceProof.findFirst({ where: { id: p.photoId, vendorId: ctx.vendorId, employeeId } })
      if (!proof) throw new Deny("Photo proof not found", 404)
      photoId = proof.id
    }

    const visit = await db.visit.create({
      data: {
        vendorId: ctx.vendorId,
        planItemId,
        employeeId,
        locationId: loc.id,
        checkInAt: new Date(),
        checkInLat: p.lat,
        checkInLng: p.lng,
        checkInAccuracy: p.accuracy ?? null,
        checkInPhotoId: photoId,
        status: "CHECKED_IN",
        remarks,
      },
    })
    await audit(ctx, "fieldforce.visit.checkin", "Visit", visit.id,
      `Visit check-in by ${emp.fullName} (${emp.code}) at ${loc.name}${planItemId ? " (planned item)" : " (ad-hoc)"} — ${distanceM}m from center (radius ${loc.radiusM}m)${outOfRadius ? " — OUT OF RADIUS (flagged, note required)" : ""}${photoId ? " · photo proof attached" : ""}`)
    return {
      visit,
      locationName: loc.name,
      distanceM,
      outOfRadius,
      photoId,
    }
  },
})

// INTENTIONALLY_SELF_SCOPED (M-02): employee check-out — only the employee's
// own OPEN visit (any date: a forgotten checkout stays open until closed).
// durationMin is computed server-side from the stored instants.
route("fieldforce.visit.checkout", {
  schema: z.object({
    employeeId: z.string().min(1).optional(), // staff acting on behalf only
    visitId: z.string().min(1),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    accuracy: z.number().min(0).max(100000).optional(),
    remarks: z.string().max(2000).optional(),
  }).strict(),
  handler: async (ctx, p) => {
    await requireFeature(ctx.vendorId, "FIELD_FORCE")
    const employeeId = await resolveVisitActor(ctx, p, "fieldforce.visit.checkout")
    const visit = await db.visit.findFirst({ where: { id: p.visitId, vendorId: ctx.vendorId } })
    if (!visit) throw new Deny("Visit not found", 404)
    if (visit.employeeId !== employeeId) throw new Deny("You can only check out your own visits", 403)
    if (visit.checkOutAt || visit.status !== "CHECKED_IN") {
      throw new Deny("This visit is already closed", 400)
    }
    const now = new Date()
    const durationMin = Math.max(0, Math.round((now.getTime() - new Date(visit.checkInAt).getTime()) / 60_000))
    const note = normStr(p.remarks)
    const remarks = visit.remarks && note ? `${visit.remarks} · ${note}` : (visit.remarks ?? note)
    const updated = await db.visit.update({
      where: { id: visit.id },
      data: {
        checkOutAt: now,
        checkOutLat: p.lat ?? null,
        checkOutLng: p.lng ?? null,
        durationMin,
        status: "COMPLETED",
        remarks,
      },
    })
    const loc = await db.visitLocation.findFirst({ where: { id: visit.locationId, vendorId: ctx.vendorId } })
    const emp = await db.employee.findFirst({ where: { id: employeeId, vendorId: ctx.vendorId } })
    await audit(ctx, "fieldforce.visit.checkout", "Visit", updated.id,
      `Visit check-out by ${emp?.fullName ?? employeeId} at ${loc?.name ?? "a location"} — duration ${durationMin}m${note ? ` · note: ${note}` : ""}`)
    return { visit: updated, locationName: loc?.name ?? "—", durationMin }
  },
})

// INTENTIONALLY_SELF_SCOPED (M-02): the ESS "My Visits" day view — today's
// plan + per-item visit state + the employee's currently open visit (any
// date, so a forgotten checkout stays actionable) + the active location
// list for ad-hoc check-ins.
route("fieldforce.myday", {
  schema: z.object({}).strict(),
  handler: async (ctx) => {
    await requireFieldForceFeature(ctx.vendorId)
    if (!ctx.employeeId) throw new Deny("No employee profile linked to your account", 400)
    const date = today()
    const plan = await db.visitPlan.findUnique({
      where: { vendorId_employeeId_date: { vendorId: ctx.vendorId, employeeId: ctx.employeeId, date } },
    })
    const items = plan
      ? await db.visitPlanItem.findMany({ where: { vendorId: ctx.vendorId, planId: plan.id }, orderBy: { createdAt: "asc" } })
      : []
    const itemIds = items.map((i) => i.id)
    const visits = itemIds.length
      ? await db.visit.findMany({ where: { vendorId: ctx.vendorId, planItemId: { in: itemIds } } })
      : []
    const { start, end } = dayRange(date)
    const adHoc = await db.visit.findMany({
      where: { vendorId: ctx.vendorId, employeeId: ctx.employeeId, planItemId: null, checkInAt: { gte: start, lt: end } },
    })
    const todayVisits = [...visits, ...adHoc].sort((a, b) => new Date(a.checkInAt).getTime() - new Date(b.checkInAt).getTime())
    const openVisit = await db.visit.findFirst({
      where: { vendorId: ctx.vendorId, employeeId: ctx.employeeId, status: "CHECKED_IN", checkOutAt: null },
      orderBy: { checkInAt: "desc" },
    })
    const locationIds = [...new Set([
      ...items.map((i) => i.locationId),
      ...todayVisits.map((v) => v.locationId),
      ...(openVisit ? [openVisit.locationId] : []),
    ])]
    const locRows = locationIds.length
      ? await db.visitLocation.findMany({ where: { vendorId: ctx.vendorId, id: { in: locationIds } } })
      : []
    const locMap = new Map(locRows.map((l) => [l.id, l]))
    const activeLocations = await db.visitLocation.findMany({
      where: { vendorId: ctx.vendorId, active: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, address: true, lat: true, lng: true, radiusM: true, contactName: true, contactPhone: true },
    })
    return {
      date,
      plan,
      items: items.map((i) => {
        const loc = locMap.get(i.locationId)
        const visit = visits.find((v) => v.planItemId === i.id) ?? null
        return {
          ...i,
          locationName: loc?.name ?? "—",
          locationAddress: loc?.address ?? null,
          locationLat: loc?.lat ?? null,
          locationLng: loc?.lng ?? null,
          radiusM: loc?.radiusM ?? null,
          distanceM: loc && visit && visit.checkInLat != null && visit.checkInLng != null
            ? Math.round(haversineM(visit.checkInLat, visit.checkInLng, loc.lat, loc.lng))
            : null,
          visit,
        }
      }),
      visits: decorateVisits(todayVisits, new Map(locRows.map((l) => [l.id, { name: l.name, lat: l.lat, lng: l.lng, radiusM: l.radiusM } as LocRef]))),
      openVisit: openVisit ? { ...decorateVisits([openVisit], new Map(locRows.map((l) => [l.id, { name: l.name, lat: l.lat, lng: l.lng, radiusM: l.radiusM } as LocRef])))[0] } : null,
      locations: activeLocations,
    }
  },
})

// ============================================================ BOARD + REPORT

route("fieldforce.board", {
  perm: ["fieldforce", "view"],
  schema: z.object({ date: z.string().regex(ISO_DATE) }).strict(),
  handler: async (ctx, p) => {
    // employees inside the caller's visibility scope (branch/dept managers
    // see their own slice; unscoped roles see the whole tenant)
    const emps = await db.employee.findMany({
      where: employeeScopeFilter(ctx),
      select: { id: true, code: true, fullName: true, designationId: true, photoThumb: true },
    })
    const empMap = new Map(emps.map((e) => [e.id, e]))
    const scopedIds = emps.map((e) => e.id)
    const plans = await db.visitPlan.findMany({
      where: { vendorId: ctx.vendorId, date: p.date, employeeId: { in: scopedIds } },
    })
    const planIds = plans.map((pl) => pl.id)
    const items = planIds.length
      ? await db.visitPlanItem.findMany({ where: { vendorId: ctx.vendorId, planId: { in: planIds } } })
      : []
    const itemIds = items.map((i) => i.id)
    // visits linked to the day's plan items (includes the sweep's MISSED
    // rows for past dates) + ad-hoc visits made that day
    const { start, end } = dayRange(p.date)
    const visits = await db.visit.findMany({
      where: {
        vendorId: ctx.vendorId,
        employeeId: { in: scopedIds },
        OR: [
          ...(itemIds.length ? [{ planItemId: { in: itemIds } }] : []),
          { planItemId: null, checkInAt: { gte: start, lt: end } },
        ],
      },
    })
    const designationIds = [...new Set(emps.map((e) => e.designationId).filter(Boolean))] as string[]
    const designations = designationIds.length
      ? await db.designation.findMany({ where: { vendorId: ctx.vendorId, id: { in: designationIds } }, select: { id: true, name: true } })
      : []
    const desigMap = new Map(designations.map((d) => [d.id, d.name]))
    type Row = {
      employeeId: string; code: string; fullName: string; designation: string; photoThumb: string | null
      planned: number; checkedIn: number; completed: number; missed: number; cancelled: number; adHoc: number
      lastActivityAt: Date | null
    }
    const rows = new Map<string, Row>()
    const rowFor = (id: string): Row => {
      let r = rows.get(id)
      if (!r) {
        const e = empMap.get(id)
        r = {
          employeeId: id, code: e?.code ?? "—", fullName: e?.fullName ?? "—",
          designation: e?.designationId ? (desigMap.get(e.designationId) ?? "—") : "—",
          photoThumb: e?.photoThumb ?? null,
          planned: 0, checkedIn: 0, completed: 0, missed: 0, cancelled: 0, adHoc: 0, lastActivityAt: null,
        }
        rows.set(id, r)
      }
      return r
    }
    for (const pl of plans) rowFor(pl.employeeId)
    for (const item of items) {
      const plan = plans.find((pl) => pl.id === item.planId)
      if (plan) rowFor(plan.employeeId).planned++
    }
    for (const v of visits) {
      const row = rowFor(v.employeeId)
      if (v.planItemId == null) row.adHoc++
      if (v.status === "CHECKED_IN") row.checkedIn++
      else if (v.status === "COMPLETED") row.completed++
      else if (v.status === "MISSED") row.missed++
      else if (v.status === "CANCELLED") row.cancelled++
      const at = new Date(v.checkInAt)
      if (!row.lastActivityAt || at > row.lastActivityAt) row.lastActivityAt = at
    }
    return {
      date: p.date,
      rows: [...rows.values()].sort((a, b) => a.fullName.localeCompare(b.fullName)),
      totals: {
        employees: rows.size,
        planned: items.length,
        checkedIn: visits.filter((v) => v.status === "CHECKED_IN").length,
        completed: visits.filter((v) => v.status === "COMPLETED").length,
        missed: visits.filter((v) => v.status === "MISSED").length,
      },
    }
  },
})

route("fieldforce.report", {
  perm: ["fieldforce", "view"],
  schema: z.object({
    from: z.string().regex(ISO_DATE),
    to: z.string().regex(ISO_DATE),
    employeeId: z.string().min(1).nullish(), // R7 (2026-10-12) — the Reports tab default "all" sends null (was 400 on every load)
  }).strict(),
  handler: async (ctx, p) => {
    if (p.from > p.to) throw new Deny("The report start date must be on or before the end date", 400)
    if (daysBetween(p.from, p.to) > 366) throw new Deny("Report range is capped at 366 days", 400)
    // scope: one explicitly-named employee (must be visible) or the caller's
    // whole visibility slice
    const empWhere: Record<string, unknown> = p.employeeId
      ? { vendorId: ctx.vendorId, id: (await assertEmployeeVisible(ctx, p.employeeId)).id }
      : employeeScopeFilter(ctx)
    const emps = await db.employee.findMany({
      where: empWhere as any,
      select: { id: true, code: true, fullName: true, designationId: true },
    })
    const empMap = new Map(emps.map((e) => [e.id, e]))
    const scopedIds = emps.map((e) => e.id)
    // planned items: plans whose business date falls inside the range
    const plans = await db.visitPlan.findMany({
      where: { vendorId: ctx.vendorId, employeeId: { in: scopedIds }, date: { gte: p.from, lte: p.to } },
      select: { id: true, employeeId: true },
    })
    const planEmp = new Map(plans.map((pl) => [pl.id, pl.employeeId]))
    const items = plans.length
      ? await db.visitPlanItem.findMany({ where: { vendorId: ctx.vendorId, planId: { in: plans.map((pl) => pl.id) } } })
      : []
    // visits: check-in instants inside the deployment-zone day range
    const start = fromZonedWall(`${p.from}T00:00:00`)
    const end = fromZonedWall(`${addDays(p.to, 1)}T00:00:00`)
    const visits = await db.visit.findMany({
      where: { vendorId: ctx.vendorId, employeeId: { in: scopedIds }, checkInAt: { gte: start, lt: end } },
    })
    type Bucket = { planned: number; completed: number; missed: number; adHoc: number; locations: Set<string>; durations: number[] }
    const perEmployee = new Map<string, Bucket>()
    const bucket = (id: string): Bucket => {
      let b = perEmployee.get(id)
      if (!b) {
        b = { planned: 0, completed: 0, missed: 0, adHoc: 0, locations: new Set<string>(), durations: [] }
        perEmployee.set(id, b)
      }
      return b
    }
    for (const item of items) {
      const empId = planEmp.get(item.planId)
      if (empId) bucket(empId).planned++
    }
    for (const v of visits) {
      const b = bucket(v.employeeId)
      if (v.planItemId == null) b.adHoc++
      if (v.status === "COMPLETED") b.completed++
      else if (v.status === "MISSED") b.missed++
      if (v.status === "CHECKED_IN" || v.status === "COMPLETED") b.locations.add(v.locationId)
      if (v.status === "COMPLETED" && v.durationMin != null) b.durations.push(v.durationMin)
    }
    const designationIds = [...new Set(emps.map((e) => e.designationId).filter(Boolean))] as string[]
    const designations = designationIds.length
      ? await db.designation.findMany({ where: { vendorId: ctx.vendorId, id: { in: designationIds } }, select: { id: true, name: true } })
      : []
    const desigMap = new Map(designations.map((d) => [d.id, d.name]))
    const rows = [...perEmployee.entries()]
      .map(([id, b]) => {
        const e = empMap.get(id)
        return {
          employeeId: id,
          code: e?.code ?? "—",
          fullName: e?.fullName ?? "—",
          designation: e?.designationId ? (desigMap.get(e.designationId) ?? "—") : "—",
          planned: b.planned,
          completed: b.completed,
          missed: b.missed,
          adHoc: b.adHoc,
          coverage: b.locations.size,
          avgDurationMin: b.durations.length ? Math.round(b.durations.reduce((s, d) => s + d, 0) / b.durations.length) : null,
          compliancePct: pct(b.completed, b.planned),
        }
      })
      .sort((a, b) => a.fullName.localeCompare(b.fullName))
    const totalPlanned = items.length
    const totalCompletedPlanned = visits.filter((v) => v.status === "COMPLETED" && v.planItemId != null).length
    const totalCompleted = visits.filter((v) => v.status === "COMPLETED").length
    const totalMissed = visits.filter((v) => v.status === "MISSED").length
    const durations = visits.filter((v) => v.status === "COMPLETED" && v.durationMin != null).map((v) => v.durationMin as number)
    const coverageLocations = new Set(visits.filter((v) => v.status === "CHECKED_IN" || v.status === "COMPLETED").map((v) => v.locationId))
    return {
      from: p.from,
      to: p.to,
      employeeId: p.employeeId ?? null,
      summary: {
        employees: perEmployee.size,
        planned: totalPlanned,
        completed: totalCompleted,
        completedPlanned: totalCompletedPlanned,
        missed: totalMissed,
        compliancePct: pct(totalCompletedPlanned, totalPlanned),
        coverage: coverageLocations.size,
        avgDurationMin: durations.length ? Math.round(durations.reduce((s, d) => s + d, 0) / durations.length) : null,
      },
      rows,
    }
  },
})

// ============================================================ HISTORY + LOCATION HIT MAP
// 2026-10-13 — Field Force → History → Employee: one row per (employee,
// business date) plan inside a date range (ad-hoc-visit days appear too),
// each carrying a "View Location Hit Map" action. The hit map itself
// (fieldforce.hitmap) assembles the day's GPS trace (TrackingPoint), the
// recorded visits with their durations, the planned stops and the derived
// stoppages (stationary clusters in the trace), so the admin can replay a
// field employee's whole day on one map.

/** Deployment-zone calendar date of an instant (utils' fixed-offset zone). */
function localDateOf(at: Date): string {
  const shifted = new Date(at.getTime() + tzOffsetHours() * 3600_000)
  return shifted.toISOString().slice(0, 10)
}

/** Pure stoppage detector over a time-ordered GPS trace — exported for tests.
 * Consecutive points that stay within `anchorRadiusM` of the cluster's FIRST
 * point form a cluster; a cluster spanning at least `minDurationSec` is a
 * stoppage (the employee was stationary there). The anchor never drifts, so
 * GPS accuracy wobble cannot silently stretch a cluster, and a genuine
 * departure (point beyond the radius) closes it immediately. */
export function detectTrackStoppages(
  points: { latitude: number; longitude: number; timestamp: Date }[],
  opts: { anchorRadiusM?: number; minDurationSec?: number } = {},
): { lat: number; lng: number; from: Date; to: Date; durationMin: number; pointCount: number }[] {
  const anchorRadiusM = opts.anchorRadiusM ?? 75
  const minDurationSec = opts.minDurationSec ?? 180
  const stops: { lat: number; lng: number; from: Date; to: Date; durationMin: number; pointCount: number }[] = []
  let cluster: { latitude: number; longitude: number; timestamp: Date }[] = []
  const flush = () => {
    if (cluster.length >= 2) {
      const spanSec = (cluster[cluster.length - 1].timestamp.getTime() - cluster[0].timestamp.getTime()) / 1000
      if (spanSec >= minDurationSec) {
        const lat = cluster.reduce((s, q) => s + q.latitude, 0) / cluster.length
        const lng = cluster.reduce((s, q) => s + q.longitude, 0) / cluster.length
        stops.push({
          lat, lng,
          from: cluster[0].timestamp,
          to: cluster[cluster.length - 1].timestamp,
          durationMin: Math.round(spanSec / 60),
          pointCount: cluster.length,
        })
      }
    }
    cluster = []
  }
  for (const p of points) {
    if (cluster.length === 0) { cluster = [p]; continue }
    if (haversineM(cluster[0].latitude, cluster[0].longitude, p.latitude, p.longitude) <= anchorRadiusM) {
      cluster.push(p)
    } else {
      flush()
      cluster = [p]
    }
  }
  flush()
  return stops
}

// INTENTIONALLY_SELF_SCOPED via employeeScopeFilter/assertEmployeeVisible:
// branch/dept managers see their own slice, staff roles the whole tenant.
route("fieldforce.history", {
  perm: ["fieldforce", "view"],
  schema: z.object({
    from: z.string().regex(ISO_DATE),
    to: z.string().regex(ISO_DATE),
    employeeId: z.string().min(1).nullish(), // null = every employee in scope
  }).strict(),
  handler: async (ctx, p) => {
    if (p.from > p.to) throw new Deny("The history start date must be on or before the end date", 400)
    if (daysBetween(p.from, p.to) > 366) throw new Deny("History range is capped at 366 days", 400)
    const empWhere: Record<string, unknown> = p.employeeId
      ? { vendorId: ctx.vendorId, id: (await assertEmployeeVisible(ctx, p.employeeId)).id }
      : employeeScopeFilter(ctx)
    const emps = await db.employee.findMany({
      where: empWhere as any,
      select: { id: true, code: true, fullName: true, designationId: true },
    })
    const empMap = new Map(emps.map((e) => [e.id, e]))
    const scopedIds = emps.map((e) => e.id)
    if (!scopedIds.length) {
      return { from: p.from, to: p.to, rows: [], summary: { employees: 0, planned: 0, completed: 0, missed: 0, adHoc: 0, gpsPings: 0, days: 0 } }
    }
    const plans = await db.visitPlan.findMany({
      where: { vendorId: ctx.vendorId, employeeId: { in: scopedIds }, date: { gte: p.from, lte: p.to } },
    })
    const planIds = plans.map((pl) => pl.id)
    const items = planIds.length
      ? await db.visitPlanItem.findMany({ where: { vendorId: ctx.vendorId, planId: { in: planIds } } })
      : []
    const start = fromZonedWall(`${p.from}T00:00:00`)
    const end = fromZonedWall(`${addDays(p.to, 1)}T00:00:00`)
    const visits = await db.visit.findMany({
      where: { vendorId: ctx.vendorId, employeeId: { in: scopedIds }, checkInAt: { gte: start, lt: end } },
    })

    // one row per (employee, business date) — plans first, then ad-hoc days
    type Row = {
      employeeId: string; code: string; fullName: string; designation: string; date: string
      planId: string | null; planned: number; completed: number; missed: number; adHoc: number; open: number
      gpsPings: number; lastActivityAt: Date | null
    }
    const rows = new Map<string, Row>()
    const rowFor = (employeeId: string, date: string): Row => {
      const key = `${employeeId}:${date}`
      let r = rows.get(key)
      if (!r) {
        const e = empMap.get(employeeId)
        r = {
          employeeId, code: e?.code ?? "—", fullName: e?.fullName ?? "—",
          designation: e?.designationId ?? "", date, planId: null,
          planned: 0, completed: 0, missed: 0, adHoc: 0, open: 0, gpsPings: 0, lastActivityAt: null,
        }
        rows.set(key, r)
      }
      return r
    }
    const planById = new Map(plans.map((pl) => [pl.id, pl]))
    const planIdByItemId = new Map(items.map((i) => [i.id, i.planId]))
    for (const pl of plans) { const r = rowFor(pl.employeeId, pl.date); r.planId = pl.id }
    for (const item of items) {
      const pl = planById.get(item.planId)
      if (pl) rowFor(pl.employeeId, pl.date).planned++
    }
    for (const v of visits) {
      // linked visits land on their plan's business date; ad-hoc visits on
      // the deployment-zone date of the check-in
      const linkedPlanId = v.planItemId ? planIdByItemId.get(v.planItemId) : undefined
      const date = linkedPlanId ? (planById.get(linkedPlanId)?.date ?? localDateOf(new Date(v.checkInAt))) : localDateOf(new Date(v.checkInAt))
      if (date < p.from || date > p.to) continue
      const row = rowFor(v.employeeId, date)
      if (v.planItemId == null) row.adHoc++
      if (v.status === "COMPLETED") row.completed++
      else if (v.status === "MISSED") row.missed++
      else if (v.status === "CHECKED_IN") row.open++
      const at = new Date(v.checkInAt)
      if (!row.lastActivityAt || at > row.lastActivityAt) row.lastActivityAt = at
    }

    // GPS ping counts per (employee, local date) — ONE grouped query over the
    // range (index: vendorId+timestamp), bucketed in the deployment zone.
    try {
      const raw = await db.$queryRawUnsafe<Array<{ employeeId: string; d: string; c: bigint | number }>>(
        `SELECT "employeeId", to_char("timestamp" + ($3 * interval '1 hour'), 'YYYY-MM-DD') AS "d", count(*) AS "c"
         FROM "TrackingPoint"
         WHERE "vendorId" = $1 AND "timestamp" >= $2 AND "timestamp" < $4
         GROUP BY "employeeId", to_char("timestamp" + ($3 * interval '1 hour'), 'YYYY-MM-DD')`,
        ctx.vendorId, start, tzOffsetHours(), end
      )
      for (const r of raw) {
        const row = rows.get(`${r.employeeId}:${r.d}`)
        if (row) row.gpsPings = Number(r.c)
      }
    } catch { /* ping counts are a bonus — the rows stay usable without them */ }

    const out = [...rows.values()]
      .sort((a, b) => b.date.localeCompare(a.date) || a.fullName.localeCompare(b.fullName))
      .slice(0, 500) // hard cap — a 366-day × whole-tenant range is a scroll, not a report
    const designationIds = [...new Set(out.map((r) => r.designation).filter(Boolean))] as string[]
    const designations = designationIds.length
      ? await db.designation.findMany({ where: { vendorId: ctx.vendorId, id: { in: designationIds } }, select: { id: true, name: true } })
      : []
    const desigMap = new Map(designations.map((d) => [d.id, d.name]))
    for (const r of out) r.designation = r.designation ? (desigMap.get(r.designation) ?? "—") : "—"
    return {
      from: p.from,
      to: p.to,
      employeeId: p.employeeId ?? null,
      rows: out,
      summary: {
        employees: new Set(out.map((r) => r.employeeId)).size,
        days: new Set(out.map((r) => r.date)).size,
        planned: out.reduce((s, r) => s + r.planned, 0),
        completed: out.reduce((s, r) => s + r.completed, 0),
        missed: out.reduce((s, r) => s + r.missed, 0),
        adHoc: out.reduce((s, r) => s + r.adHoc, 0),
        gpsPings: out.reduce((s, r) => s + r.gpsPings, 0),
      },
    }
  },
})

/** The day replay: GPS trace + visits + planned stops + derived stoppages. */
route("fieldforce.hitmap", {
  perm: ["fieldforce", "view"],
  schema: z.object({
    employeeId: z.string().min(1),
    date: z.string().regex(ISO_DATE),
  }).strict(),
  handler: async (ctx, p) => {
    const emp = await assertEmployeeVisible(ctx, p.employeeId)
    const { start, end } = dayRange(p.date)

    const plan = await db.visitPlan.findUnique({
      where: { vendorId_employeeId_date: { vendorId: ctx.vendorId, employeeId: emp.id, date: p.date } },
    })
    const items = plan
      ? await db.visitPlanItem.findMany({ where: { vendorId: ctx.vendorId, planId: plan.id }, orderBy: { createdAt: "asc" } })
      : []
    const itemIds = items.map((i) => i.id)
    const linkedVisits = itemIds.length
      ? await db.visit.findMany({ where: { vendorId: ctx.vendorId, planItemId: { in: itemIds } } })
      : []
    const adHocVisits = await db.visit.findMany({
      where: { vendorId: ctx.vendorId, employeeId: emp.id, planItemId: null, checkInAt: { gte: start, lt: end } },
    })
    const visits = [...linkedVisits, ...adHocVisits]
      .sort((a, b) => new Date(a.checkInAt).getTime() - new Date(b.checkInAt).getTime())
    const locationIds = [...new Set([...items.map((i) => i.locationId), ...visits.map((v) => v.locationId)])]
    const locRows = locationIds.length
      ? await db.visitLocation.findMany({ where: { vendorId: ctx.vendorId, id: { in: locationIds } } })
      : []
    const fullLocs = new Map(locRows.map((l) => [l.id, l]))
    const locMap = new Map(locRows.map((l) => [l.id, { name: l.name, lat: l.lat, lng: l.lng, radiusM: l.radiusM } as LocRef]))

    // planned stops (in plan order) with their recorded visit, if any
    const planned = items.map((i) => {
      const loc = fullLocs.get(i.locationId)
      const visit = linkedVisits.find((v) => v.planItemId === i.id) ?? null
      let distanceM: number | null = null
      if (loc && visit && visit.checkInLat != null && visit.checkInLng != null) {
        distanceM = Math.round(haversineM(visit.checkInLat, visit.checkInLng, loc.lat, loc.lng))
      }
      return {
        id: i.id, locationId: i.locationId, locationName: loc?.name ?? "—",
        plannedFrom: i.plannedFrom, plannedTo: i.plannedTo, tasks: i.tasks,
        lat: loc?.lat ?? null, lng: loc?.lng ?? null, radiusM: loc?.radiusM ?? null,
        visitStatus: visit?.status ?? "PLANNED",
        checkInAt: visit?.checkInAt ?? null, checkOutAt: visit?.checkOutAt ?? null,
        durationMin: visit?.durationMin ?? null,
        distanceM, outOfRadius: distanceM != null && loc != null && distanceM > loc.radiusM,
      }
    })

    // GPS trace (full fetch for distance/stops; downsampled copy for the wire)
    const trackRows = await db.trackingPoint.findMany({
      where: { vendorId: ctx.vendorId, employeeId: emp.id, timestamp: { gte: start, lt: end } },
      orderBy: { timestamp: "asc" },
      select: { latitude: true, longitude: true, timestamp: true, accuracyM: true, batteryPercentage: true },
    })
    let trackKm = 0
    for (let i = 1; i < trackRows.length; i++) {
      trackKm += haversineM(trackRows[i - 1].latitude, trackRows[i - 1].longitude, trackRows[i].latitude, trackRows[i].longitude)
    }
    trackKm = Math.round((trackKm / 1000) * 100) / 100
    const MAX_WIRE_POINTS = 600
    const stride = Math.max(1, Math.ceil(trackRows.length / MAX_WIRE_POINTS))
    const track = (stride === 1 ? trackRows : trackRows.filter((_, i) => i % stride === 0 || i === trackRows.length - 1))
      .map((t) => ({
        lat: t.latitude, lng: t.longitude, at: t.timestamp.toISOString(),
        acc: t.accuracyM ?? null, batt: t.batteryPercentage ?? null,
      }))

    // derived stoppages from the FULL trace, minus any time span already
    // covered by a recorded visit (those are labelled stops on the map)
    const visitSpans = visits
      .filter((v) => v.checkInAt && v.checkOutAt)
      .map((v) => ({ from: new Date(v.checkInAt).getTime(), to: new Date(v.checkOutAt as Date).getTime() }))
    const stops = detectTrackStoppages(
      trackRows.map((t) => ({ latitude: t.latitude, longitude: t.longitude, timestamp: t.timestamp }))
    )
      .filter((s) => {
        const sf = s.from.getTime(), st = s.to.getTime()
        return !visitSpans.some((v) => sf < v.to && st > v.from) // interval overlap
      })
      .map((s) => ({ ...s, from: s.from.toISOString(), to: s.to.toISOString() }))

    return {
      employee: { id: emp.id, code: emp.code, fullName: emp.fullName },
      date: p.date,
      planId: plan?.id ?? null,
      planned,
      visits: decorateVisits(visits, locMap),
      track,
      trackStride: stride,
      totalPings: trackRows.length,
      trackKm,
      stops,
      summary: {
        planned: items.length,
        completed: visits.filter((v) => v.status === "COMPLETED" && v.planItemId != null).length,
        missed: visits.filter((v) => v.status === "MISSED").length,
        adHoc: visits.filter((v) => v.planItemId == null).length,
        totalPings: trackRows.length,
        trackKm,
        stops: stops.length,
      },
    }
  },
})
