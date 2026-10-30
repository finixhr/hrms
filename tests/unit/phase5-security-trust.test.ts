/// <reference types="bun-types" />
// ============ Phase 5 P4 — Security & Trust console ===========================
// Covers the P4 delivery (owner.security.* + owner.audit.overview in
// src/hrm-server/saas/security-console.ts):
//   1. owner.security.overview — the team census (MFA adoption, lockouts,
//      suspended, with-failures) moving by exactly the seeded owner-user
//      deltas (before/after DIFF — immune to other suites' rows sharing the
//      unit-test database); the login windows (24h/7d/30d attempts +
//      failures + MFA successes + distinct IPs) as exact DIFFs around seeded
//      LoginAuditLog rows; the failure-reason mix exactness; the
//      offending-IP workbench (threshold, ordering, exclusions — sub-threshold
//      IPs and out-of-window rows never list); the plane split; the
//      live-session census (expired rows never count); internal rate/adoption
//      consistency; and the 6-week trend contract.
//   2. owner.security.sessions — the governance grid: expired rows never
//      surface, kind + band chips narrow IN SQL, pre-auth challenges sort
//      first then soonest expiry, owner identity rides the JOIN, pageSize-2
//      pagination walks the set without duplicates.
//   3. owner.audit.overview — the volume windows as DIFFs, the 6-week trend
//      contract, the action / entity / actor mixes matching the database's
//      own top-8 group-by truth (exact order), and the retention horizon vs
//      the SEC-16 policy (including auditRetentionDays() env parsing).
import "./_testdb"
import { ownerSessionTokenHash } from "@/hrm-server/saas/owner-auth"
import { sessionTokenHash } from "@/hrm-server/auth"
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { db } from "@/lib/db"
import { uniq } from "./_fixtures"
import { ownerRoutes } from "@/hrm-server/saas/owner-routes"
// side-effect imports — owner.security.* + owner.audit.overview self-register
// into ownerRoutes exactly like the /api/owner dispatcher imports them
import "@/hrm-server/saas/security-console"
import { OFFENDER_MIN_FAILURES, auditRetentionDays } from "@/hrm-server/saas/security-console"
import type { OwnerCtx } from "@/hrm-server/saas/owner-auth"

let ctx: OwnerCtx

const call = async (action: string, payload: any) => {
  const def = ownerRoutes[action]
  if (!def) throw new Error(`unknown owner action: ${action}`)
  const parsed = def.schema ? def.schema.parse(payload) : payload
  return (def.handler as any)(ctx, parsed)
}

const DAY = 86_400_000
const dAgo = (days: number) => new Date(Date.now() - days * DAY)
const dAhead = (days: number) => new Date(Date.now() + days * DAY)
const hAgo = (h: number) => new Date(Date.now() - h * 3_600_000)
const hAhead = (h: number) => new Date(Date.now() + h * 3_600_000)

beforeAll(() => {
  ctx = {
    ownerId: "p4-owner-" + uniq("o"),
    name: "P4 Security Owner",
    email: "p4-owner@test.example",
    roleKey: "SUPER_ADMIN",
    permissions: new Set(["audit.view"]),
  } as OwnerCtx
})

// ----------------------------------------------------------------------------
describe("P4 — owner.security.overview (team census + login windows + reasons + offenders)", () => {
  const TAG = uniq("p4ov")
  const ownerEmails = [`${TAG}-a@test.local`, `${TAG}-b@test.local`, `${TAG}-c@test.local`, `${TAG}-d@test.local`]
  const loginEmail = `${uniq("lu")}@test.local`
<<<<<<< HEAD
  // Deterministic, collision-proof IPs (documentation ranges, fixed slots
  // ≥ 201 — outside every random 10–209 range used elsewhere in the suite).
  // These were previously Math.random()-drawn from THREE shared ranges, so a
  // same-range collision (p ≈ 1/200 per pair) could merge fixtures and fail
  // the ordering/exclusion assertions — a latent flake, not a server bug.
  const IP_A = "203.0.113.201"
  const IP_B = "198.51.100.201"
  const IP_C = "192.0.2.201"
  const IP_D = "203.0.113.202"
  const IP_E = "198.51.100.202"
  const IP_F = "192.0.2.202"
=======
  // collision-proof IPs (documentation ranges, uniq per run)
  const IP_A = `203.0.113.${Math.floor(Math.random() * 200) + 10}`
  const IP_B = `198.51.100.${Math.floor(Math.random() * 200) + 10}`
  const IP_C = `192.0.2.${Math.floor(Math.random() * 200) + 10}`
  const IP_D = `203.0.113.${Math.floor(Math.random() * 200) + 10}`
  const IP_E = `198.51.100.${Math.floor(Math.random() * 200) + 10}`
  const IP_F = `192.0.2.${Math.floor(Math.random() * 200) + 10}`
>>>>>>> origin/main
  let ownerA: string, ownerB: string

  beforeAll(async () => {
    // ---- the team: MFA-on / MFA-off+failures / locked-now / suspended -------
    ownerA = (await db.saasOwnerUser.create({
      data: { email: ownerEmails[0], name: `${TAG} Alice`, passwordHash: "x", roleKey: "SALES_MANAGER", status: "ACTIVE", mfaEnrolled: true } as any,
    })).id
    ownerB = (await db.saasOwnerUser.create({
      data: { email: ownerEmails[1], name: `${TAG} Bob`, passwordHash: "x", roleKey: "SALES_MANAGER", status: "ACTIVE", mfaEnrolled: false, failedLoginCount: 2 } as any,
    })).id
    await db.saasOwnerUser.create({
      data: { email: ownerEmails[2], name: `${TAG} Cara`, passwordHash: "x", roleKey: "SALES_MANAGER", status: "ACTIVE", mfaEnrolled: true, lockedUntil: new Date(Date.now() + 15 * 60_000) } as any,
    })
    await db.saasOwnerUser.create({
      data: { email: ownerEmails[3], name: `${TAG} Dan`, passwordHash: "x", roleKey: "SALES_MANAGER", status: "SUSPENDED", mfaEnrolled: false } as any,
    })

    // ---- login attempts (window + reason + offender fixtures) ----------------
    // IP A — pure attacker: 5 INVALID_CREDENTIALS failures 10h ago (24h window)
    for (let i = 0; i < 5; i++) {
      await db.loginAuditLog.create({ data: { plane: "TENANT", email: loginEmail, success: false, failureReason: "INVALID_CREDENTIALS", ip: IP_A, createdAt: hAgo(10) } as any })
    }
    // IP B — mixed traffic: 4 RATE_LIMITED failures 3d ago + 6 successes 2d ago (OWNER plane)
    for (let i = 0; i < 4; i++) {
      await db.loginAuditLog.create({ data: { plane: "OWNER", email: loginEmail, success: false, failureReason: "RATE_LIMITED", ip: IP_B, createdAt: dAgo(3) } as any })
    }
    for (let i = 0; i < 6; i++) {
      await db.loginAuditLog.create({ data: { plane: "OWNER", email: loginEmail, success: true, ip: IP_B, createdAt: dAgo(2) } as any })
    }
    // IP C — sub-threshold: 2 LOCKED_OUT failures 5d ago (never lists)
    for (let i = 0; i < 2; i++) {
      await db.loginAuditLog.create({ data: { plane: "TENANT", email: loginEmail, success: false, failureReason: "LOCKED_OUT", ip: IP_C, createdAt: dAgo(5) } as any })
    }
    // IP D — clean MFA user: 5 successful MFA logins 20h ago (24h window)
    for (let i = 0; i < 5; i++) {
      await db.loginAuditLog.create({ data: { plane: "TENANT", email: loginEmail, success: true, mfaUsed: true, ip: IP_D, createdAt: hAgo(20) } as any })
    }
    // IP E — out of window: 3 failures 40d ago (never counts anywhere)
    for (let i = 0; i < 3; i++) {
      await db.loginAuditLog.create({ data: { plane: "TENANT", email: loginEmail, success: false, failureReason: "INVALID_CREDENTIALS", ip: IP_E, createdAt: dAgo(40) } as any })
    }
    // IP F — one unrecorded-reason failure 6d ago (UNKNOWN bucket)
    await db.loginAuditLog.create({ data: { plane: "TENANT", email: loginEmail, success: false, ip: IP_F, createdAt: dAgo(6) } as any })
  })

  afterAll(async () => {
    await db.loginAuditLog.deleteMany({ where: { email: loginEmail } })
    await db.saasOwnerUser.deleteMany({ where: { email: { in: ownerEmails } } })
  })

  test("team census: MFA adoption, lockouts, suspended, with-failures (DB truth, full-table)", async () => {
    const o = await call("owner.security.overview", {})
    const [total, active, suspended, enrolled, locked, withFail] = await Promise.all([
      db.saasOwnerUser.count(),
      db.saasOwnerUser.count({ where: { status: "ACTIVE" } }),
      db.saasOwnerUser.count({ where: { status: "SUSPENDED" } }),
      db.saasOwnerUser.count({ where: { mfaEnrolled: true } }),
      db.saasOwnerUser.count({ where: { lockedUntil: { gt: new Date() } } }),
      db.saasOwnerUser.count({ where: { failedLoginCount: { gt: 0 } } }),
    ])
    expect(o.team.total).toBe(total)
    expect(o.team.active).toBe(active)
    expect(o.team.suspended).toBe(suspended)
    expect(o.team.mfaEnrolled).toBe(enrolled)
    expect(o.team.lockedNow).toBe(locked)
    expect(o.team.withFailures).toBe(withFail)
    // the fixtures are in there: 4 owners, 2 enrolled, 1 locked, 1 suspended
    expect(o.team.total).toBeGreaterThanOrEqual(4)
    expect(o.team.mfaEnrolled).toBeGreaterThanOrEqual(2)
    expect(o.team.lockedNow).toBeGreaterThanOrEqual(1)
    expect(o.team.suspended).toBeGreaterThanOrEqual(1)
    // adoption is the exact ratio, never a fabrication
    if (total > 0) {
      expect(o.team.mfaAdoptionPct).toBe(Math.round((enrolled / total) * 100))
    } else {
      expect(o.team.mfaAdoptionPct).toBeNull()
    }
  })

  test("login windows: attempts + failures + MFA + distinct IPs move by the exact seeded deltas (DIFF)", async () => {
    // DIFF discipline: everything BEFORE this seed was captured by the
    // previous call; seed a known mini-set, then measure the move.
    const before = await call("owner.security.overview", {})
    const ipG = `192.0.2.${Math.floor(Math.random() * 200) + 10}`
    // 2 failures + 1 success in 24h; 1 more success 3d ago (MFA); 1 old row out of window
    await db.loginAuditLog.create({ data: { plane: "TENANT", email: loginEmail, success: false, failureReason: "INVALID_CREDENTIALS", ip: ipG, createdAt: hAgo(1) } as any })
    await db.loginAuditLog.create({ data: { plane: "TENANT", email: loginEmail, success: false, failureReason: "INVALID_CREDENTIALS", ip: ipG, createdAt: hAgo(2) } as any })
    await db.loginAuditLog.create({ data: { plane: "OWNER", email: loginEmail, success: true, mfaUsed: true, ip: ipG, createdAt: hAgo(3) } as any })
    await db.loginAuditLog.create({ data: { plane: "OWNER", email: loginEmail, success: true, mfaUsed: true, ip: ipG, createdAt: dAgo(3) } as any })
    await db.loginAuditLog.create({ data: { plane: "TENANT", email: loginEmail, success: true, ip: ipG, createdAt: dAgo(40) } as any })
    const after = await call("owner.security.overview", {})
    expect(after.logins.attempts24h - before.logins.attempts24h).toBe(3)   // 2 failures + 1 success
    expect(after.logins.failures24h - before.logins.failures24h).toBe(2)
    expect(after.logins.attempts7d - before.logins.attempts7d).toBe(4)     // + the 3d-ago success
    expect(after.logins.failures7d - before.logins.failures7d).toBe(2)
    expect(after.logins.attempts30d - before.logins.attempts30d).toBe(4)
    expect(after.logins.failures30d - before.logins.failures30d).toBe(2)
    expect(after.logins.mfaLogins30d - before.logins.mfaLogins30d).toBe(2) // only successful MFA rows
    expect(after.logins.distinctIps30d - before.logins.distinctIps30d).toBe(1) // the 40d row's IP is out of window
    // the big beforeAll fixtures are already inside the captured baseline
    expect(before.logins.failures30d).toBeGreaterThanOrEqual(12) // 5 IP A + 4 IP B + 2 IP C + 1 IP F
    expect(after.logins.failures30d).toBeGreaterThanOrEqual(before.logins.failures30d + 2)
    // internal rate consistency (whatever the shared DB holds)
    if (after.logins.attempts24h > 0) {
      expect(after.logins.failureRate24h).toBe(Math.round((after.logins.failures24h / after.logins.attempts24h) * 1000) / 10)
    } else {
      expect(after.logins.failureRate24h).toBeNull()
    }
    // plane split: TENANT + OWNER always both present
    const planes = new Map(after.logins.planes.map((p: any) => [p.plane, p]))
    expect(planes.has("TENANT")).toBe(true)
    expect(planes.has("OWNER")).toBe(true)
  })

  test("failure-reason mix: every seeded reason counts, successes never do (DB truth)", async () => {
    const o = await call("owner.security.overview", {})
    const truth = await db.loginAuditLog.groupBy({
      by: ["failureReason"],
      _count: { _all: true },
      where: { success: false, createdAt: { gte: dAgo(30) } },
    })
    const truthOf = (reason: string | null) =>
      Number(truth.find((r: any) => r.failureReason === reason)?._count?._all || 0)
    // every truth row surfaces (null → UNKNOWN), counts exact
    for (const r of truth) {
      const key = r.failureReason || "UNKNOWN"
      const found = o.failureReasons.find((x: any) => x.reason === key)
      expect(found, `reason ${key} missing from the mix`).toBeTruthy()
      expect(found.count).toBe(Number(r._count?._all || 0))
    }
    // the fixtures: INVALID_CREDENTIALS ≥ 5 (IP A), RATE_LIMITED ≥ 4 (IP B),
    // LOCKED_OUT ≥ 2 (IP C), UNKNOWN ≥ 1 (IP F) — the 40d rows contribute 0
    expect(o.failureReasons.find((x: any) => x.reason === "INVALID_CREDENTIALS")?.count || 0)
      .toBeGreaterThanOrEqual(5)
    expect(o.failureReasons.find((x: any) => x.reason === "RATE_LIMITED")?.count || 0)
      .toBeGreaterThanOrEqual(4)
    expect(o.failureReasons.find((x: any) => x.reason === "LOCKED_OUT")?.count || 0)
      .toBeGreaterThanOrEqual(2)
    expect(o.failureReasons.find((x: any) => x.reason === "UNKNOWN")?.count || 0)
      .toBeGreaterThanOrEqual(1)
    // sorted worst-first
    for (let i = 1; i < o.failureReasons.length; i++) {
      expect(o.failureReasons[i - 1].count).toBeGreaterThanOrEqual(o.failureReasons[i].count)
    }
    // the successful rows never leak into the mix
    const totalMixed = o.failureReasons.reduce((s: number, r: any) => s + r.count, 0)
    expect(totalMixed).toBe(truth.reduce((s, r) => s + Number(r._count?._all || 0), 0))
  })

  test("offending IPs: threshold + ordering + exclusions (sub-threshold, out-of-window, success-only never list)", async () => {
    const o = await call("owner.security.overview", {})
    expect(OFFENDER_MIN_FAILURES).toBe(3)
    const find = (ip: string) => o.offendingIps.find((x: any) => x.ip === ip)
    // IP A: 5 failures, 0 successes — pure attacker, listed
    const a = find(IP_A)
    expect(a, `IP A (${IP_A}) should list`).toBeTruthy()
    expect(a.failures).toBeGreaterThanOrEqual(5)
    // IP B: 4 failures + 6 successes — mixed traffic, listed
    const b = find(IP_B)
    expect(b, `IP B (${IP_B}) should list`).toBeTruthy()
    expect(b.failures).toBeGreaterThanOrEqual(4)
    expect(b.successes).toBeGreaterThanOrEqual(6)
    // worst-first between our two
    expect(o.offendingIps.indexOf(a)).toBeLessThan(o.offendingIps.indexOf(b))
    // IP C: 2 failures — never lists
    expect(find(IP_C)).toBeUndefined()
    // IP D: 5 successes, 0 failures — never lists
    expect(find(IP_D)).toBeUndefined()
    // IP E: failures are 40d old — never lists
    expect(find(IP_E)).toBeUndefined()
    // capped at 10
    expect(o.offendingIps.length).toBeLessThanOrEqual(10)
    // every listed IP meets the floor
    for (const x of o.offendingIps) expect(x.failures).toBeGreaterThanOrEqual(OFFENDER_MIN_FAILURES)
  })

  test("session census: live rows only — expired never count (DIFF)", async () => {
    const before = await call("owner.security.overview", {})
    const sessEmail = `${uniq("se")}@test.local`
    const u = await db.saasOwnerUser.create({
      data: { email: sessEmail, name: `${TAG} Session Host`, passwordHash: "x", roleKey: "SALES_MANAGER", status: "ACTIVE", mfaEnrolled: false } as any,
    })
    const mkSess = (over: Record<string, unknown>) => {
      const ovId = uniq("p4ovsess")
      return db.saasOwnerSession.create({ data: { id: ovId, tokenHash: ownerSessionTokenHash(ovId), ownerId: u.id, csrfToken: uniq("csrf"), ...over } as any })
    }
    await mkSess({ kind: "FULL", expiresAt: dAhead(6), lastSeenAt: hAgo(0.1), createdAt: hAgo(1), ip: `203.0.113.${Math.floor(Math.random() * 200) + 10}` })   // LATER band
    await mkSess({ kind: "FULL", expiresAt: hAhead(2), lastSeenAt: hAgo(1), createdAt: hAgo(2) })   // EXPIRING_24H
    await mkSess({ kind: "FULL", expiresAt: hAhead(0.5), lastSeenAt: hAgo(3), createdAt: hAgo(3) }) // EXPIRING_1H
    await mkSess({ kind: "MFA_PENDING", expiresAt: hAhead(1 / 6), lastSeenAt: hAgo(0.2), createdAt: hAgo(0.2) }) // pre-auth
    await mkSess({ kind: "FULL", expiresAt: hAgo(1), lastSeenAt: hAgo(2), createdAt: hAgo(3) })     // EXPIRED — never counts
    const after = await call("owner.security.overview", {})
    expect(after.sessions.live - before.sessions.live).toBe(4)
    expect(after.sessions.full - before.sessions.full).toBe(3)
    expect(after.sessions.pending - before.sessions.pending).toBe(1)
    expect(after.sessions.expiring24h - before.sessions.expiring24h).toBe(3) // 2h + 30m + 10m, NOT the 6d one, NOT the expired one
    expect(after.sessions.owners - before.sessions.owners).toBe(1)
    // cleanup the DIFF set here so later tests start clean
    await db.saasOwnerSession.deleteMany({ where: { ownerId: u.id } })
    await db.saasOwnerUser.delete({ where: { id: u.id } })
  })

  test("6-week trend: always six ascending weeks, sums move by the seeded deltas", async () => {
    const before = await call("owner.security.overview", {})
    const ipH = `198.51.100.${Math.floor(Math.random() * 200) + 10}`
    // 3 attempts (2 failed) well inside the current week's range — the
    // Monday-start bucketing absorbs them wherever "now" falls in the week
    await db.loginAuditLog.create({ data: { plane: "TENANT", email: loginEmail, success: true, ip: ipH, createdAt: hAgo(1) } as any })
    await db.loginAuditLog.create({ data: { plane: "TENANT", email: loginEmail, success: false, failureReason: "RATE_LIMITED", ip: ipH, createdAt: hAgo(1.1) } as any })
    await db.loginAuditLog.create({ data: { plane: "TENANT", email: loginEmail, success: false, failureReason: "RATE_LIMITED", ip: ipH, createdAt: hAgo(1.2) } as any })
    const after = await call("owner.security.overview", {})
    expect(after.trend.length).toBe(6)
    for (let i = 1; i < 6; i++) {
      expect(new Date(after.trend[i].weekStart).getTime()).toBeGreaterThan(new Date(after.trend[i - 1].weekStart).getTime())
    }
    const sum = (arr: any[], k: string) => arr.reduce((s: number, w: any) => s + w[k], 0)
    expect(sum(after.trend, "attempts") - sum(before.trend, "attempts")).toBe(3)
    expect(sum(after.trend, "failures") - sum(before.trend, "failures")).toBe(2)
    // per-week internal consistency: attempts ≥ failures everywhere
    for (const w of after.trend) expect(w.attempts).toBeGreaterThanOrEqual(w.failures)
  })

  test("retention horizons + policy snapshot ride the response", async () => {
    const o = await call("owner.security.overview", {})
    // SEC-16 default policy is 730 days unless the env overrides
    expect(o.retention.auditPolicyDays).toBe(auditRetentionDays())
    // our 40d-old login fixtures make the tenant-plane horizon at least 40d
    expect(o.retention.loginTenantOldestDays == null || o.retention.loginTenantOldestDays >= 40).toBe(true)
    expect(o.retention.loginOwnerPolicyDays).toBe(180)
    expect(o.retention.loginTenantPolicyDays).toBe(180)
    // policy knobs echo the settings the login flow reads
    expect(typeof o.policy.ownerMfaRequired).toBe("boolean")
    expect(o.policy.lockoutThreshold).toBeGreaterThanOrEqual(1)
    expect(o.policy.lockoutMinutes).toBeGreaterThanOrEqual(1)
    expect(o.policy.sessionDays).toBeGreaterThanOrEqual(1)
    expect(o.policy.offenderMinFailures).toBe(OFFENDER_MIN_FAILURES)
  })
})

// ----------------------------------------------------------------------------
describe("P4 — owner.security.sessions (the governance grid)", () => {
  const TAG = uniq("p4sg")
  const email1 = `${TAG}-host1@test.local`
  const email2 = `${TAG}-host2@test.local`
  let u1: string, u2: string
  const sessIds: string[] = []

  const mkSess = (ownerId: string, over: Record<string, unknown>) => {
    const id = uniq("p4sess")
    sessIds.push(id)
    return db.saasOwnerSession.create({ data: { id, tokenHash: sessionTokenHash(id), ownerId, csrfToken: uniq("csrf"), ...over } as any })
  }

  beforeAll(async () => {
    u1 = (await db.saasOwnerUser.create({
      data: { email: email1, name: `${TAG} Host One`, passwordHash: "x", roleKey: "SALES_MANAGER", status: "ACTIVE", mfaEnrolled: true } as any,
    })).id
    u2 = (await db.saasOwnerUser.create({
      data: { email: email2, name: `${TAG} Host Two`, passwordHash: "x", roleKey: "ADMINISTRATOR", status: "SUSPENDED", mfaEnrolled: false } as any,
    })).id
    // 4 live sessions (search-isolated by owner email) + 1 expired that must never surface
    await mkSess(u1, { kind: "MFA_PENDING", expiresAt: hAhead(1 / 6), lastSeenAt: hAgo(0.2), createdAt: hAgo(0.2), ip: "203.0.113.7" })
    await mkSess(u1, { kind: "FULL", expiresAt: hAhead(0.5), lastSeenAt: hAgo(3), createdAt: hAgo(4), ip: "203.0.113.8" })
    await mkSess(u1, { kind: "FULL", expiresAt: hAhead(2), lastSeenAt: hAgo(1), createdAt: hAgo(5), ip: "203.0.113.9" })
    await mkSess(u2, { kind: "FULL", expiresAt: dAhead(6), lastSeenAt: hAgo(0.1), createdAt: hAgo(6), ip: "203.0.113.10" })
    await mkSess(u2, { kind: "FULL", expiresAt: hAgo(1), lastSeenAt: hAgo(2), createdAt: hAgo(3) }) // expired
  })

  afterAll(async () => {
    await db.saasOwnerSession.deleteMany({ where: { id: { in: sessIds } } })
    await db.saasOwnerUser.deleteMany({ where: { email: { in: [email1, email2] } } })
  })

  test("search isolates our owner; expired rows never surface; identity rides the JOIN", async () => {
    const r = await call("owner.security.sessions", { search: TAG, page: 1, pageSize: 25 })
    expect(r.total).toBe(4) // the expired one is gone
    const byEmail = new Map<string, any>(r.rows.map((x: any) => [x.ownerEmail as string, x]))
    expect(byEmail.get(email1)!.ownerName).toBe(`${TAG} Host One`)
    expect(byEmail.get(email1)!.ownerMfa).toBe(true)
    expect(byEmail.get(email2)!.ownerStatus).toBe("SUSPENDED")
    expect(byEmail.get(email2)!.ownerRole).toBe("ADMINISTRATOR")
    // the CSRF token never crosses the boundary
    for (const row of r.rows as any[]) expect(row.csrfToken).toBeUndefined()
  })

  test("pre-auth challenges sort first, then full sessions by soonest expiry", async () => {
    const r = await call("owner.security.sessions", { search: TAG, page: 1, pageSize: 25 })
    expect(r.rows[0].kind).toBe("MFA_PENDING")
    expect(r.rows[1].kind).toBe("FULL")
    // soonest-expiry among the FULL rows: the 30-minute one, then 2h, then 6d
    expect(r.rows[1].expiresInMinutes).toBeLessThanOrEqual(30)
    expect(r.rows[2].expiresInMinutes).toBeGreaterThan(60)
    expect(r.rows[2].expiresInMinutes).toBeLessThanOrEqual(120)
    expect(r.rows[3].expiresInMinutes).toBeGreaterThan(120)
    // bands computed IN SQL
    expect(r.rows[0].band).toBe("EXPIRING_1H")
    expect(r.rows[1].band).toBe("EXPIRING_1H")
    expect(r.rows[2].band).toBe("EXPIRING_24H")
    expect(r.rows[3].band).toBe("LATER")
    // freshness rides the row
    expect(r.rows[0].idleMinutes).toBeLessThanOrEqual(60)
  })

  test("kind chips narrow IN SQL — no cross-kind leak", async () => {
    const full = await call("owner.security.sessions", { search: TAG, kind: "FULL", page: 1, pageSize: 25 })
    expect(full.total).toBe(3)
    for (const row of full.rows) expect(row.kind).toBe("FULL")
    const pending = await call("owner.security.sessions", { search: TAG, kind: "PENDING", page: 1, pageSize: 25 })
    expect(pending.total).toBe(1)
    expect(pending.rows[0].kind).toBe("MFA_PENDING")
  })

  test("band chips narrow IN SQL — exact boundary behavior", async () => {
    const h1 = await call("owner.security.sessions", { search: TAG, band: "EXPIRING_1H", page: 1, pageSize: 25 })
    expect(h1.total).toBe(2) // the 10-minute pre-auth + the 30-minute full
    for (const row of h1.rows) expect(row.band).toBe("EXPIRING_1H")
    const h24 = await call("owner.security.sessions", { search: TAG, band: "EXPIRING_24H", page: 1, pageSize: 25 })
    expect(h24.total).toBe(1) // the 2-hour one only — NOT the <1h rows
    expect(h24.rows[0].band).toBe("EXPIRING_24H")
    const later = await call("owner.security.sessions", { search: TAG, band: "LATER", page: 1, pageSize: 25 })
    expect(later.total).toBe(1)
    expect(later.rows[0].band).toBe("LATER")
  })

  test("pageSize-2 pagination walks the whole set with no duplicates", async () => {
    const seen: string[] = []
    const pages = Math.ceil(4 / 2)
    for (let p = 1; p <= pages; p++) {
      const r = await call("owner.security.sessions", { search: TAG, page: p, pageSize: 2 })
      for (const row of r.rows) seen.push(row.id)
    }
    expect(seen.length).toBe(4)
    expect(new Set(seen).size).toBe(4)
  })
})

// ----------------------------------------------------------------------------
describe("P4 — owner.audit.overview (volume windows, trend, mixes, retention)", () => {
  const TAG = uniq("p4au")
  const ACTION_MAIN = `P4_${TAG}_MAIN`
  const ACTION_OTHER = `P4_${TAG}_OTHER`
  const ACTION_NOTIF = `NOTIFICATION_P4_${TAG}`
  const ACTION_ANCIENT = `P4_${TAG}_ANCIENT`
  const ENTITY = `P4${TAG}Entity`
  const ACTOR = `P4 ${TAG} Alice`

  beforeAll(async () => {
    const mk = (action: string, days: number, entity = ENTITY) =>
      db.saasAuditLog.create({
        data: { actorName: ACTOR, action, entity, summary: `${TAG} fixture ${action}`, createdAt: dAgo(days) } as any,
      })
    await mk(ACTION_MAIN, 2) // in 7d + 30d
    await mk(ACTION_MAIN, 2)
    await mk(ACTION_MAIN, 5)
    await mk(ACTION_OTHER, 0.2) // ~5h ago → inside 24h
    await mk(ACTION_OTHER, 0.3)
    await mk(ACTION_NOTIF, 3) // a system-notification row
    await mk(ACTION_ANCIENT, 40) // outside every window, oldest-row candidate
  })

  afterAll(async () => {
    await db.saasAuditLog.deleteMany({ where: { action: { startsWith: `P4_${TAG}` } } })
    await db.saasAuditLog.deleteMany({ where: { action: ACTION_NOTIF } })
  })

  test("volume windows move by the exact seeded deltas (DIFF)", async () => {
    const before = await call("owner.audit.overview", {})
    await db.saasAuditLog.create({ data: { actorName: ACTOR, action: `${ACTION_MAIN}_X`, entity: ENTITY, summary: "diff row", createdAt: hAgo(1) } as any })
    await db.saasAuditLog.create({ data: { actorName: ACTOR, action: ACTION_NOTIF, entity: ENTITY, summary: "diff notif", createdAt: hAgo(2) } as any })
    await db.saasAuditLog.create({ data: { actorName: ACTOR, action: ACTION_MAIN, entity: ENTITY, summary: "diff old", createdAt: dAgo(40) } as any })
    const after = await call("owner.audit.overview", {})
    expect(after.events24h - before.events24h).toBe(2)
    expect(after.events7d - before.events7d).toBe(2)
    expect(after.events30d - before.events30d).toBe(2)
    expect(after.notifications30d - before.notifications30d).toBe(1)
    expect(after.actors30d - before.actors30d).toBe(0) // Alice already counted
    // the beforeAll fixtures are already inside the captured baseline
    expect(before.events30d).toBeGreaterThanOrEqual(6)
    expect(after.events30d).toBeGreaterThanOrEqual(before.events30d + 2)
  })

  test("action / entity / actor mixes equal the database's own top-8 truth (exact order)", async () => {
    const o = await call("owner.audit.overview", {})
    const d30 = dAgo(30)
    const [actions, entities, actors] = await Promise.all([
      db.saasAuditLog.groupBy({ by: ["action"], _count: { _all: true }, where: { createdAt: { gte: d30 } }, orderBy: { _count: { action: "desc" } }, take: 8 } as any),
      db.saasAuditLog.groupBy({ by: ["entity"], _count: { _all: true }, where: { createdAt: { gte: d30 } }, orderBy: { _count: { entity: "desc" } }, take: 8 } as any),
      db.saasAuditLog.groupBy({ by: ["actorName"], _count: { _all: true }, where: { createdAt: { gte: d30 } }, orderBy: { _count: { actorName: "desc" } }, take: 8 } as any),
    ])
    expect(o.topActions.map((x: any) => [x.action, x.count])).toEqual(actions.map((r: any) => [r.action, Number(r._count?._all || 0)]))
    expect(o.topEntities.map((x: any) => [x.entity, x.count])).toEqual(entities.map((r: any) => [r.entity, Number(r._count?._all || 0)]))
    expect(o.topActors.map((x: any) => [x.actorName, x.count])).toEqual(actors.map((r: any) => [r.actorName, Number(r._count?._all || 0)]))
    // our fixtures ride the mixes when they make the cut (3 MAIN rows seeded)
    const main = o.topActions.find((x: any) => x.action === ACTION_MAIN)
    if (main) expect(main.count).toBeGreaterThanOrEqual(3)
  })

  test("6-week trend: always six ascending weeks, sums include the in-window fixtures", async () => {
    const o = await call("owner.audit.overview", {})
    expect(o.trend.length).toBe(6)
    for (let i = 1; i < 6; i++) {
      expect(new Date(o.trend[i].weekStart).getTime()).toBeGreaterThan(new Date(o.trend[i - 1].weekStart).getTime())
    }
    const sum = o.trend.reduce((s: number, w: any) => s + w.events, 0)
    // the 42d window includes all 8 in-window beforeAll fixtures + the 2 DIFF rows
    expect(sum).toBeGreaterThanOrEqual(8)
  })

  test("retention horizon: oldest row age + the SEC-16 policy (env parsing)", async () => {
    const o = await call("owner.audit.overview", {})
    // our 40d-old fixture makes the horizon at least 40 days
    expect(o.retention.oldestDays).toBeGreaterThanOrEqual(40)
    // and it agrees with the database's own MIN()
    const oldestAgg = await db.saasAuditLog.aggregate({ _min: { createdAt: true } })
    const truthAge = Math.max(0, Math.floor((Date.now() - new Date(oldestAgg._min?.createdAt || Date.now()).getTime()) / DAY))
    expect(Math.abs(o.retention.oldestDays - truthAge)).toBeLessThanOrEqual(1)
    // the exported env parser: default, explicit override, explicit disable
    const saved = process.env.HRM_SAAS_AUDIT_RETENTION_DAYS
    try {
      delete process.env.HRM_SAAS_AUDIT_RETENTION_DAYS
      expect(auditRetentionDays()).toBe(730)
      process.env.HRM_SAAS_AUDIT_RETENTION_DAYS = "365"
      expect(auditRetentionDays()).toBe(365)
      process.env.HRM_SAAS_AUDIT_RETENTION_DAYS = "0"
      expect(auditRetentionDays()).toBeNull()
      process.env.HRM_SAAS_AUDIT_RETENTION_DAYS = "not-a-number"
      expect(auditRetentionDays()).toBeNull()
    } finally {
      if (saved === undefined) delete process.env.HRM_SAAS_AUDIT_RETENTION_DAYS
      else process.env.HRM_SAAS_AUDIT_RETENTION_DAYS = saved
    }
    // and the action echoes the same policy
    expect(o.retention.policyDays).toBe(auditRetentionDays())
  })
})
