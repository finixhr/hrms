// ============ Security & Trust console (Phase 5 P4) ===========================
// The security slice of the SaaS Owner Panel: platform security posture over
// the three existing audit-grade data planes —
//   - LoginAuditLog  (R16: EVERY login attempt on both planes, success and
//                     failure, with failure reason / MFA usage / IP / device)
//   - SaasAuditLog   (§32: the append-only platform forensic trail)
//   - SaasOwnerUser + SaasOwnerSession (the platform team: MFA enrollment,
//                     lockout state, live sessions incl. pre-auth challenges)
// None of these surfaces had an owner-facing posture view: the audit page was
// a bare paged table, the login audit a flat list, and sessions had NO
// governance surface at all. P4 answers them with fixed-set SQL aggregates
// and SQL-paged grids, in the P0/P1/P2/P3 console tradition.
//
// SCALE DISCIPLINE (fleet.ts / lifecycle-console.ts / billing-console.ts /
// growth-console.ts, applied from birth):
//   - owner.security.overview answers EVERY number with a FIXED set of ~14
//     grouped aggregates (FILTER-clause window counts, group-bys, MIN()
//     retention horizons) — fleet-size independent, no per-tenant fan-out,
//     no take-capped lists (the old loginaudit handler post-processed the
//     500 newest failure rows in JS to build the reason mix — that is gone
//     from this surface; the legacy action stays untouched for compat).
//   - owner.security.sessions pages in SQL with the expiry band computed IN
//     SQL (EXTRACT(EPOCH …) minute arithmetic + a CASE), so the band chips
//     filter and the pre-auth-first sort never materialize the session
//     table. Owner identity arrives via one JOIN. The per-session CSRF
//     token is NEVER selected — it never leaves the server.
//   - owner.audit.overview is the analytics companion for the rebuilt
//     platform audit page: volume windows + a 6-week trend + action /
//     entity / actor mixes, all fixed-set group-bys over the [createdAt]
//     index. The long-standing owner.audit.list action stays untouched.
//
// HONESTY RULES (the P1/P2/P3 discipline):
//   - Rates are NULL when their denominator is zero (a fabricated 0% failure
//     rate on an empty log is a lie; null renders as "—").
//   - Window counts are honest zeros; the 6-week trend is ALWAYS six weeks.
//   - Every count crosses the Prisma boundary ::int, every fraction ::float8
//     — no BigInt in JSON (H-09).
//   - The offending-IP workbench lists only IPs with ≥ OFFENDER_MIN_FAILURES
//     failed attempts in 30 days, failures-first — successes ride the row so
//     a busy shared NAT is visibly distinguishable from a pure attacker.
import { z } from "zod"
import { db } from "@/lib/db"
import { ownerAction } from "./owner-routes"
import { getSaasSettings } from "./settings"

const DAY_MS = 86_400_000

/** An IP becomes listable with this many FAILED attempts in the trailing
 *  30 days (the brute-force / credential-stuffing signal floor). */
export const OFFENDER_MIN_FAILURES = 3

/** R16 retention: owner-plane login rows keep a fixed 180-day window
 *  (jobs.ts sweeps them); tenant-plane rows default to 180 days, then the
 *  per-tenant loginAudit.retentionDays setting takes over. */
export const LOGIN_AUDIT_OWNER_RETENTION_DAYS = 180
export const LOGIN_AUDIT_TENANT_DEFAULT_DAYS = 180

/** SEC-16: SaaSAuditLog retention — 730 days (2 years) by default; an
 *  EXPLICIT HRM_SAAS_AUDIT_RETENTION_DAYS=0 (or negative) DISABLES the
 *  sweep. Parsed exactly like sweepSaasAuditRetention (jobs.ts) — no falsy
 *  `|| default` trap. */
export function auditRetentionDays(): number | null {
  const raw = process.env.HRM_SAAS_AUDIT_RETENTION_DAYS
  const days = raw != null && String(raw).trim() !== "" ? Number(raw) : 730
  if (!Number.isFinite(days) || days <= 0) return null // disabled
  return days
}

/** age in whole days between `since` and now (null for an empty table) */
const ageDays = (oldest: Date | null | undefined): number | null =>
  oldest ? Math.max(0, Math.floor((Date.now() - new Date(oldest).getTime()) / DAY_MS)) : null

const SESSIONS_PAGE = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(120).optional(),
  kind: z.enum(["ALL", "FULL", "PENDING"]).default("ALL"),
  band: z.enum(["ALL", "EXPIRING_1H", "EXPIRING_24H", "LATER"]).default("ALL"),
}).passthrough()

// ---- 1. overview — the platform security posture ----------------------------
// One response, ~14 fixed aggregates: team census (MFA adoption + lockouts),
// login windows (24h / 7d / 30d, both planes), the failure-reason mix, the
// offending-IP workbench, the live-session census, audit activity, retention
// horizons and the 6-week attempts-vs-failures trend.
ownerAction("owner.security.overview", {
  perm: "audit.view",
  handler: async () => {
    const now = new Date()
    const d24h = new Date(now.getTime() - DAY_MS)
    const d7d = new Date(now.getTime() - 7 * DAY_MS)
    const d30d = new Date(now.getTime() - 30 * DAY_MS)

    const [
      teamRows,
      loginWindowRows,
      planeRows,
      reasonRows,
      offenderRows,
      sessionRows,
      auditWindowRows,
      auditActionRows,
      auditEntityRows,
      auditOldestRows,
      loginOldestRows,
      weekRows,
    ] = await Promise.all([
      // one SaaSOwnerUser scan: the team census (MFA, lockouts, status)
      db.$queryRawUnsafe<Array<{
        total: number; active: number; suspended: number
        mfaEnrolled: number; lockedNow: number; withFailures: number
      }>>(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE "status" = 'ACTIVE')::int AS active,
                COUNT(*) FILTER (WHERE "status" = 'SUSPENDED')::int AS suspended,
                COUNT(*) FILTER (WHERE "mfaEnrolled")::int AS "mfaEnrolled",
                COUNT(*) FILTER (WHERE "lockedUntil" IS NOT NULL AND "lockedUntil" > now())::int AS "lockedNow",
                COUNT(*) FILTER (WHERE "failedLoginCount" > 0)::int AS "withFailures"
         FROM "SaaSOwnerUser"`,
      ),
      // one LoginAuditLog scan: attempts/failures per window + MFA + IPs
      db.$queryRawUnsafe<Array<{
        attempts24h: number; failures24h: number
        attempts7d: number; failures7d: number
        attempts30d: number; failures30d: number
        mfaLogins30d: number; distinctIps30d: number
      }>>(
        `SELECT COUNT(*) FILTER (WHERE "createdAt" >= $1)::int AS "attempts24h",
                COUNT(*) FILTER (WHERE "createdAt" >= $1 AND "success" = false)::int AS "failures24h",
                COUNT(*) FILTER (WHERE "createdAt" >= $2)::int AS "attempts7d",
                COUNT(*) FILTER (WHERE "createdAt" >= $2 AND "success" = false)::int AS "failures7d",
                COUNT(*) FILTER (WHERE "createdAt" >= $3)::int AS "attempts30d",
                COUNT(*) FILTER (WHERE "createdAt" >= $3 AND "success" = false)::int AS "failures30d",
                COUNT(*) FILTER (WHERE "createdAt" >= $3 AND "success" = true AND "mfaUsed")::int AS "mfaLogins30d",
                COUNT(DISTINCT "ip") FILTER (WHERE "createdAt" >= $3)::int AS "distinctIps30d"
         FROM "LoginAuditLog"`,
        d24h, d7d, d30d,
      ),
      // attempts + failures per plane (30d) — every plane that exists surfaces
      db.$queryRawUnsafe<Array<{ plane: string; attempts: number; failures: number }>>(
        `SELECT "plane", COUNT(*)::int AS attempts,
                COUNT(*) FILTER (WHERE "success" = false)::int AS failures
         FROM "LoginAuditLog" WHERE "createdAt" >= $1 GROUP BY 1`,
        d30d,
      ),
      // failure-reason mix (30d) — computed in SQL, not a JS scan of 500 rows
      db.$queryRawUnsafe<Array<{ reason: string | null; c: number }>>(
        `SELECT "failureReason" AS reason, COUNT(*)::int AS c
         FROM "LoginAuditLog"
         WHERE "success" = false AND "createdAt" >= $1
         GROUP BY 1 ORDER BY 2 DESC`,
        d30d,
      ),
      // offending-IP workbench (30d): ≥ OFFENDER_MIN_FAILURES failures, worst-first
      db.$queryRawUnsafe<Array<{
        ip: string; failures: number; successes: number; lastSeen: Date
      }>>(
        `SELECT "ip",
                COUNT(*) FILTER (WHERE "success" = false)::int AS failures,
                COUNT(*) FILTER (WHERE "success" = true)::int AS successes,
                MAX("createdAt") AS "lastSeen"
         FROM "LoginAuditLog"
         WHERE "createdAt" >= $1 AND "ip" IS NOT NULL
         GROUP BY 1
         HAVING COUNT(*) FILTER (WHERE "success" = false) >= $2
         ORDER BY failures DESC, "lastSeen" DESC
         LIMIT 10`,
        d30d, OFFENDER_MIN_FAILURES,
      ),
      // one SaaSOwnerSession scan: the LIVE census (expired rows never count)
      db.$queryRawUnsafe<Array<{
        live: number; full: number; pending: number
        expiring24h: number; distinctIps: number; owners: number
      }>>(
        `SELECT COUNT(*)::int AS live,
                COUNT(*) FILTER (WHERE "kind" = 'FULL')::int AS full,
                COUNT(*) FILTER (WHERE "kind" <> 'FULL')::int AS pending,
                COUNT(*) FILTER (WHERE "expiresAt" < now() + interval '24 hours')::int AS "expiring24h",
                COUNT(DISTINCT "ip")::int AS "distinctIps",
                COUNT(DISTINCT "ownerId")::int AS owners
         FROM "SaaSOwnerSession" WHERE "expiresAt" > now()`,
      ),
      // one SaaSAuditLog scan: volume windows + notification share + actors
      db.$queryRawUnsafe<Array<{
        events24h: number; events7d: number; events30d: number
        notifications30d: number; actors30d: number
      }>>(
        `SELECT COUNT(*) FILTER (WHERE "createdAt" >= now() - interval '24 hours')::int AS "events24h",
                COUNT(*) FILTER (WHERE "createdAt" >= now() - interval '7 days')::int AS "events7d",
                COUNT(*) FILTER (WHERE "createdAt" >= now() - interval '30 days')::int AS "events30d",
                COUNT(*) FILTER (WHERE "createdAt" >= now() - interval '30 days' AND "action" LIKE 'NOTIFICATION_%')::int AS "notifications30d",
                COUNT(DISTINCT "actorName") FILTER (WHERE "createdAt" >= now() - interval '30 days')::int AS "actors30d"
         FROM "SaaSAuditLog"`,
      ),
      // audit action mix (30d, top 8)
      db.$queryRawUnsafe<Array<{ action: string; c: number }>>(
        `SELECT "action", COUNT(*)::int AS c FROM "SaaSAuditLog"
         WHERE "createdAt" >= $1 GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
        d30d,
      ),
      // audit entity mix (30d, top 8)
      db.$queryRawUnsafe<Array<{ entity: string; c: number }>>(
        `SELECT "entity", COUNT(*)::int AS c FROM "SaaSAuditLog"
         WHERE "createdAt" >= $1 GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
        d30d,
      ),
      // retention horizons — the oldest rows vs the sweep policies
      db.$queryRawUnsafe<Array<{ oldest: Date | null }>>(
        `SELECT MIN("createdAt") AS oldest FROM "SaaSAuditLog"`,
      ),
      db.$queryRawUnsafe<Array<{ plane: string; oldest: Date | null }>>(
        `SELECT "plane", MIN("createdAt") AS oldest FROM "LoginAuditLog" GROUP BY 1`,
      ),
      // 6-week attempts-vs-failures trend (all planes, Monday-start weeks)
      db.$queryRawUnsafe<Array<{ w: string; attempts: number; failures: number }>>(
        `SELECT to_char(date_trunc('week', "createdAt"), 'YYYY-MM-DD') AS w,
                COUNT(*)::int AS attempts,
                COUNT(*) FILTER (WHERE "success" = false)::int AS failures
         FROM "LoginAuditLog" WHERE "createdAt" >= $1 GROUP BY 1`,
        new Date(now.getTime() - 42 * DAY_MS),
      ),
    ])

    // ---- folds: fixed sets, honest nulls -------------------------------------
    const team = teamRows[0] || { total: 0, active: 0, suspended: 0, mfaEnrolled: 0, lockedNow: 0, withFailures: 0 }
    const win = loginWindowRows[0] || {
      attempts24h: 0, failures24h: 0, attempts7d: 0, failures7d: 0,
      attempts30d: 0, failures30d: 0, mfaLogins30d: 0, distinctIps30d: 0,
    }
    const sessions = sessionRows[0] || { live: 0, full: 0, pending: 0, expiring24h: 0, distinctIps: 0, owners: 0 }
    const auditWin = auditWindowRows[0] || { events24h: 0, events7d: 0, events30d: 0, notifications30d: 0, actors30d: 0 }

    const rate = (failures: number, attempts: number) =>
      attempts > 0 ? Math.round((failures / attempts) * 1000) / 10 : null

    const successes30d = Math.max(0, win.attempts30d - win.failures30d)
    const mfaShare30d = successes30d > 0
      ? Math.round((win.mfaLogins30d / successes30d) * 1000) / 10
      : null

    // plane split — TENANT + OWNER always present (zeros honest)
    const planeOf = new Map(planeRows.map((r) => [r.plane, r]))
    const planes = (["TENANT", "OWNER"] as const).map((plane) => {
      const r = planeOf.get(plane)
      return {
        plane,
        attempts: Number(r?.attempts || 0),
        failures: Number(r?.failures || 0),
      }
    })

    // 6 calendar weeks ending at the current one — ALWAYS six
    const weekMs = 7 * DAY_MS
    const thisWeekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    thisWeekStart.setUTCDate(thisWeekStart.getUTCDate() - ((thisWeekStart.getUTCDay() + 6) % 7)) // Monday
    const weekOf = new Map(weekRows.map((r) => [r.w, r]))
    const trend: { weekStart: string; attempts: number; failures: number }[] = []
    for (let i = 5; i >= 0; i--) {
      const ws = new Date(thisWeekStart.getTime() - i * weekMs)
      const key = ws.toISOString().slice(0, 10)
      const r = weekOf.get(key)
      trend.push({
        weekStart: key,
        attempts: r ? Number(r.attempts || 0) : 0,
        failures: r ? Number(r.failures || 0) : 0,
      })
    }

    // retention horizons vs policy
    const auditOldest = ageDays(auditOldestRows[0]?.oldest)
    const loginOldestOf = new Map(loginOldestRows.map((r) => [r.plane, ageDays(r.oldest)]))

    const settings = await getSaasSettings()

    return {
      generatedAt: new Date().toISOString(),
      team: {
        total: team.total,
        active: team.active,
        suspended: team.suspended,
        mfaEnrolled: team.mfaEnrolled,
        mfaAdoptionPct: team.total > 0 ? Math.round((team.mfaEnrolled / team.total) * 100) : null,
        lockedNow: team.lockedNow,
        withFailures: team.withFailures,
      },
      logins: {
        attempts24h: win.attempts24h, failures24h: win.failures24h, failureRate24h: rate(win.failures24h, win.attempts24h),
        attempts7d: win.attempts7d, failures7d: win.failures7d, failureRate7d: rate(win.failures7d, win.attempts7d),
        attempts30d: win.attempts30d, failures30d: win.failures30d, failureRate30d: rate(win.failures30d, win.attempts30d),
        mfaLogins30d: win.mfaLogins30d,
        mfaShare30d, // null when nothing succeeded — never a fabricated 0%
        distinctIps30d: win.distinctIps30d,
        planes,
      },
      failureReasons: reasonRows.map((r) => ({
        reason: r.reason || "UNKNOWN",
        count: Number(r.c || 0),
      })),
      offendingIps: offenderRows.map((r) => ({
        ip: r.ip,
        failures: Number(r.failures || 0),
        successes: Number(r.successes || 0),
        lastSeen: r.lastSeen,
      })),
      sessions: {
        live: sessions.live,
        full: sessions.full,
        pending: sessions.pending,
        expiring24h: sessions.expiring24h,
        distinctIps: sessions.distinctIps,
        owners: sessions.owners,
      },
      audit: {
        events24h: auditWin.events24h,
        events7d: auditWin.events7d,
        events30d: auditWin.events30d,
        notifications30d: auditWin.notifications30d,
        actors30d: auditWin.actors30d,
        topActions: auditActionRows.map((r) => ({ action: r.action, count: Number(r.c || 0) })),
        topEntities: auditEntityRows.map((r) => ({ entity: r.entity, count: Number(r.c || 0) })),
      },
      retention: {
        auditPolicyDays: auditRetentionDays(), // null = sweep disabled
        auditOldestDays: auditOldest, // null = empty trail
        loginOwnerPolicyDays: LOGIN_AUDIT_OWNER_RETENTION_DAYS,
        loginOwnerOldestDays: loginOldestOf.get("OWNER") ?? null,
        loginTenantPolicyDays: LOGIN_AUDIT_TENANT_DEFAULT_DAYS, // per-tenant configurable default
        loginTenantOldestDays: loginOldestOf.get("TENANT") ?? null,
      },
      trend,
      policy: {
        ownerMfaRequired: settings.security.ownerMfaRequired,
        sessionDays: settings.security.sessionDays,
        lockoutThreshold: settings.security.lockoutThreshold,
        lockoutMinutes: settings.security.lockoutMinutes,
        offenderMinFailures: OFFENDER_MIN_FAILURES,
      },
    }
  },
})

// ---- 2. sessions — the live-session governance grid, paged in SQL -----------
// Pre-auth challenges (MFA_PENDING / ENROLL_PENDING) surface FIRST — they are
// the potentially-stuck attack surface — then full sessions by soonest
// expiry. The expiry band and idle minutes are computed IN SQL; the CSRF
// token is never selected. Live rows only (expiresAt > now).
ownerAction("owner.security.sessions", {
  perm: "audit.view",
  schema: SESSIONS_PAGE,
  handler: async (_ctx, p) => {
    const params: unknown[] = []
    const conds: string[] = [`s."expiresAt" > now()`]
    if (p.search) {
      const q = `%${p.search.toLowerCase()}%`
      // the wrapped select exposes ownerName / ownerEmail at the top level
      // (the growth-console discipline: filter the WRAPPED row, never the
      // inner JOIN aliases)
      conds.push(`(LOWER(s."ownerName") LIKE $${params.push(q)} OR LOWER(s."ownerEmail") LIKE $${params.push(q)})`)
    }
    if (p.kind === "FULL") conds.push(`s."kind" = 'FULL'`)
    if (p.kind === "PENDING") conds.push(`s."kind" IN ('MFA_PENDING', 'ENROLL_PENDING')`)
    if (p.band !== "ALL") {
      // static enum value — no user input interpolated
      const bandSql = p.band === "EXPIRING_1H"
        ? `s."expiresAt" < now() + interval '1 hour'`
        : p.band === "EXPIRING_24H"
          ? `s."expiresAt" >= now() + interval '1 hour' AND s."expiresAt" < now() + interval '24 hours'`
          : `s."expiresAt" >= now() + interval '24 hours'`
      conds.push(bandSql)
    }
    const whereSql = `WHERE ${conds.join(" AND ")}`

    const offset = (p.page - 1) * p.pageSize
    const limitIdx = params.length + 1
    const offsetIdx = params.length + 2
    params.push(p.pageSize, offset)

    const INNER = `SELECT s."id", s."kind", s."createdAt", s."lastSeenAt", s."expiresAt", s."ip", s."userAgent",
                          u."name" AS "ownerName", u."email" AS "ownerEmail",
                          u."roleKey" AS "ownerRole", u."status" AS "ownerStatus", u."mfaEnrolled" AS "ownerMfa",
                          EXTRACT(EPOCH FROM (s."expiresAt" - now())) / 60.0::float8 AS "expiresInMinutes",
                          EXTRACT(EPOCH FROM (now() - s."lastSeenAt")) / 60.0::float8 AS "idleMinutes",
                          CASE WHEN s."expiresAt" < now() + interval '1 hour' THEN 'EXPIRING_1H'
                               WHEN s."expiresAt" < now() + interval '24 hours' THEN 'EXPIRING_24H'
                               ELSE 'LATER' END AS "band"
                   FROM "SaaSOwnerSession" s
                   JOIN "SaaSOwnerUser" u ON u."id" = s."ownerId"`

    const [countRows, rows] = await Promise.all([
      db.$queryRawUnsafe<Array<{ c: number }>>(
        `SELECT COUNT(*)::int AS c FROM (${INNER}) s ${whereSql}`,
        ...params.slice(0, -2),
      ),
      db.$queryRawUnsafe<Array<{
        id: string; kind: string; createdAt: Date; lastSeenAt: Date; expiresAt: Date
        ip: string | null; userAgent: string | null
        ownerName: string; ownerEmail: string; ownerRole: string
        ownerStatus: string; ownerMfa: boolean
        expiresInMinutes: number; idleMinutes: number; band: string
      }>>(
        `SELECT s."id", s."kind", s."createdAt", s."lastSeenAt", s."expiresAt", s."ip", s."userAgent",
                s."ownerName", s."ownerEmail", s."ownerRole", s."ownerStatus", s."ownerMfa",
                s."expiresInMinutes", s."idleMinutes", s."band"
         FROM (${INNER}) s ${whereSql}
         ORDER BY (s."kind" = 'FULL') ASC,           -- pre-auth challenges first
                  s."expiresInMinutes" ASC,           -- then soonest expiry
                  s."ownerName" ASC, s."id" ASC
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        ...params,
      ),
    ])

    return {
      total: Number(countRows[0]?.c || 0),
      page: p.page,
      pageSize: p.pageSize,
      rows: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        createdAt: r.createdAt,
        lastSeenAt: r.lastSeenAt,
        expiresAt: r.expiresAt,
        ip: r.ip,
        userAgent: r.userAgent,
        ownerName: r.ownerName,
        ownerEmail: r.ownerEmail,
        ownerRole: r.ownerRole,
        ownerStatus: r.ownerStatus,
        ownerMfa: r.ownerMfa,
        expiresInMinutes: Math.round(Number(r.expiresInMinutes || 0)),
        idleMinutes: Math.round(Number(r.idleMinutes || 0)),
        band: r.band,
      })),
    }
  },
})

// ---- 3. audit overview — analytics for the rebuilt platform audit page ------
// Volume windows, the 6-week trend, the action / entity / actor mixes and the
// retention horizon — all fixed-set group-bys over the SaaSAuditLog
// [createdAt] index. owner.audit.list stays untouched for compatibility.
ownerAction("owner.audit.overview", {
  perm: "audit.view",
  handler: async () => {
    const now = new Date()
    const d30d = new Date(now.getTime() - 30 * DAY_MS)

    const [windowRows, actionRows, entityRows, actorRows, oldestRows, weekRows] = await Promise.all([
      db.$queryRawUnsafe<Array<{
        events24h: number; events7d: number; events30d: number
        notifications30d: number; actors30d: number
      }>>(
        `SELECT COUNT(*) FILTER (WHERE "createdAt" >= now() - interval '24 hours')::int AS "events24h",
                COUNT(*) FILTER (WHERE "createdAt" >= now() - interval '7 days')::int AS "events7d",
                COUNT(*) FILTER (WHERE "createdAt" >= now() - interval '30 days')::int AS "events30d",
                COUNT(*) FILTER (WHERE "createdAt" >= now() - interval '30 days' AND "action" LIKE 'NOTIFICATION_%')::int AS "notifications30d",
                COUNT(DISTINCT "actorName") FILTER (WHERE "createdAt" >= now() - interval '30 days')::int AS "actors30d"
         FROM "SaaSAuditLog"`,
      ),
      db.$queryRawUnsafe<Array<{ action: string; c: number }>>(
        `SELECT "action", COUNT(*)::int AS c FROM "SaaSAuditLog"
         WHERE "createdAt" >= $1 GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
        d30d,
      ),
      db.$queryRawUnsafe<Array<{ entity: string; c: number }>>(
        `SELECT "entity", COUNT(*)::int AS c FROM "SaaSAuditLog"
         WHERE "createdAt" >= $1 GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
        d30d,
      ),
      db.$queryRawUnsafe<Array<{ actorName: string; c: number }>>(
        `SELECT "actorName", COUNT(*)::int AS c FROM "SaaSAuditLog"
         WHERE "createdAt" >= $1 GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
        d30d,
      ),
      db.$queryRawUnsafe<Array<{ oldest: Date | null }>>(
        `SELECT MIN("createdAt") AS oldest FROM "SaaSAuditLog"`,
      ),
      db.$queryRawUnsafe<Array<{ w: string; c: number }>>(
        `SELECT to_char(date_trunc('week', "createdAt"), 'YYYY-MM-DD') AS w, COUNT(*)::int AS c
         FROM "SaaSAuditLog" WHERE "createdAt" >= $1 GROUP BY 1`,
        new Date(now.getTime() - 42 * DAY_MS),
      ),
    ])

    const win = windowRows[0] || { events24h: 0, events7d: 0, events30d: 0, notifications30d: 0, actors30d: 0 }

    // 6 calendar weeks ending at the current one — ALWAYS six
    const weekMs = 7 * DAY_MS
    const thisWeekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    thisWeekStart.setUTCDate(thisWeekStart.getUTCDate() - ((thisWeekStart.getUTCDay() + 6) % 7)) // Monday
    const weekOf = new Map(weekRows.map((r) => [r.w, Number(r.c || 0)]))
    const trend: { weekStart: string; events: number }[] = []
    for (let i = 5; i >= 0; i--) {
      const ws = new Date(thisWeekStart.getTime() - i * weekMs)
      const key = ws.toISOString().slice(0, 10)
      trend.push({ weekStart: key, events: weekOf.get(key) || 0 })
    }

    return {
      generatedAt: new Date().toISOString(),
      events24h: win.events24h,
      events7d: win.events7d,
      events30d: win.events30d,
      notifications30d: win.notifications30d,
      actors30d: win.actors30d,
      trend,
      topActions: actionRows.map((r) => ({ action: r.action, count: Number(r.c || 0) })),
      topEntities: entityRows.map((r) => ({ entity: r.entity, count: Number(r.c || 0) })),
      topActors: actorRows.map((r) => ({ actorName: r.actorName, count: Number(r.c || 0) })),
      retention: {
        policyDays: auditRetentionDays(), // null = sweep disabled
        oldestDays: ageDays(oldestRows[0]?.oldest), // null = empty trail
      },
    }
  },
})
