/// <reference types="bun-types" />
// ============ AUDIT M-5 (2026-11-07) — no-perm route inventory ratchet ============
// The 2026-11-07 security audit (finding M-5) found that tenant isolation is
// purely application-level and that a large set of non-public actions carry
// NO `def.perm` and do their own authorization inside the handler — the
// dispatcher's permission gate never runs for them, so the ONLY thing between
// a caller and another tenant's data is the handler's own where-clauses.
// The audit counted 56 such actions; the registry has since grown and this
// test counts 85 live no-perm spellings (4 of them T-20 aliases that share
// their canonical's RouteDef object — both spellings are live RPC surface,
// so both are inventoried).
//
// THE RATCHET: every registered action is partitioned into
//   (a) `public: true`                     — pre-auth surface (auth.login, …)
//   (b) non-public WITH `def.perm`         — dispatcher-gated
//   (c) non-public WITHOUT `def.perm       — the audit's class: must EITHER
//                                            contain a SANCTIONED in-handler
//                                            authorization marker in its
//                                            handler source, OR be listed in
//                                            the IDENTITY_INHERENT_ALLOWLIST
//                                            below with a justification.
// A NEW no-perm route that neither carries one of the sanctioned markers nor
// is consciously allowlisted FAILS this test at review time — the exact
// drift class M-5 described (hand-written checks accumulating silently).
//
// SANCTIONED MARKERS are case-sensitive substrings of `def.handler.toString()`
// (Bun returns the TRANSPILED source, which preserves identifier names):
// the shared scope/identity helpers (assertEmployeeVisible, employeeScopeFilter,
// companyWhere, …), the rbac helpers used in-handler (require(ctx/can(ctx),
// SaaS gates (requireFeature/requireCapacity) and direct ctx.employeeId /
// ctx.userId identity comparisons. NOTE for reviewers: the repo's OTHER
// self-identity helpers — requireSelf(ctx) [ess.ts], resolveSelfActor /
// resolveCheckActor [tracking.ts/attendance.ts], notifScope(ctx)
// [communication.ts] — are deliberately NOT in the marker list (the audit's
// list is authoritative); every route that relies on them is in the
// allowlist below with the helper named in its justification. Adding a
// marker is allowed but must keep the allowlist in sync.
//
// KNOWN LIMITATIONS (documented, accepted):
//   * Thin wrapper handlers (`handler: (ctx,p) => someFn(ctx, p.id)`) expose
//     only the wrapper's source — a marker inside someFn is invisible. Every
//     current group-(c) wrapper was traced to its callee during curation
//     (2026-11-07); the allowlist names the callee where relevant.
//   * Markers are textual: e.g. `can(ctx` also matches `scan(ctx…`. The
//     ratchet's job is to force a HUMAN to look at every new no-perm route,
//     not to prove authorization — that is what the per-entry review recorded
//     in the allowlist comments is for.
import { describe, test, expect } from "bun:test"
import "@/hrm-server/routes/router" // side-effect import — registers every action
import { routes, routeAliases } from "@/hrm-server/routes/registry"

const SANCTIONED_MARKERS: readonly string[] = [
  "assertEmployeeVisible",
  "assertDecisionEmployeeCompany",
  "assertCompanyRecord",
  "assertTenant(",
  "assertSelf",
  "employeeScopeFilter",
  "scopedEmployeeWhere",
  "scopedEmployeeRelationWhere",
  "companyWhere(",
  "requireFeature",
  "requireCapacity",
  "ctx.employeeId ===",
  "ctx.userId ===",
  "assertCompany(",
  "can(ctx",
  "require(ctx",
  "assertOrgAnchorBelongsToCompany",
]

// ----------------------------------------------------------------------------
// IDENTITY_INHERENT ALLOWLIST — every entry was READ and verified on
// 2026-11-07 (TASK 4-e curation). One-line justification each. Entries may
// only be REMOVED when the action gains a perm/marker; adding an entry
// requires the same human review (why is this route safe without a perm?).
// ----------------------------------------------------------------------------
const IDENTITY_INHERENT_ALLOWLIST: Record<string, string> = {
  // --- AIT self-service (ait.ts) — ctx.employeeId-gated, own certificates ---
  "ait.myCertificates": "gates on ctx.employeeId; payrollEntry reads filtered by the caller's own employeeId (M-02 comment at ait.ts:1031)",
  "ait.myCertificate.print": "certificateData(ctx, ctx.employeeId, { forSelf: true }) — the caller's OWN AIT certificate only",
  // --- announcements / notifications (communication.ts) ---
  "announcements.read": "own read receipt only: EMPLOYEE callers may only mark notices visible to them (audience check vs own branch/dept/designation/person); other roles are authenticated tenant readers",
  "notifications.list": "notifScope(ctx) where-filter (userId OR userless-own-employeeId) — own notifications only",
  "notifications.read": "updateMany carries notifScope(ctx) — own notifications only (M-02, regression-tested in ungated-actions.test.ts)",
  "notifications.unreadCount": "notifScope(ctx) count — own unread badge only",
  // --- ATS self-service (ats.ts) ---
  "ats.interviews.mine": "interviewerId = ctx.userId where-clause; candidate contact details masked (M-02 / REC-01 R7)",
  // --- attendance self-service (attendance.ts / tracking.ts) ---
  "attendance.consent.accept": "writes only the caller's own EmployeeConsent row — compound unique (vendorId, ctx.employeeId, purpose, version)",
  "attendance.consent.status": "reads only the caller's own EmployeeConsent row (same compound key)",
  "attendance.multipleCheckin.validate": "read-only dry-run; resolveSelfActor (tracking.ts) enforces own-record-only",
  "attendance.myDevices.enroll": "registers THE caller's own device — identity from session, compound unique (vendorId, ctx.employeeId, deviceId)",
  "attendance.myDevices.list": "own employeeDevice rows only (vendorId + ctx.employeeId where)",
  "attendance.myDevices.remove": "row matched to (id, vendorId, ctx.employeeId) before the update",
  "attendance.selfCheckout": "resolveCheckActor: EMPLOYEE acts only for themself; staff-on-behalf needs attendance.edit + assertEmployeeVisible (attendance.ts:794)",
  "attendance.selfie.checkin": "resolveCheckActor own-record identity + ATTENDANCE_METHOD policy gate",
  // --- auth session hygiene (auth.ts / passkeys.ts) — identity = the session ---
  "auth.me": "read-only introspection of the caller's own user/vendor rows (ctx.userId / ctx.vendorId fixed by the dispatcher)",
  "auth.mfa.disable": "strips the CALLER's own MFA; password + fresh TOTP both required (L-1/L-8-parity)",
  "auth.mfa.enable": "completes the CALLER's own enrollment — candidate secret is bound to ctx.userId by auth.mfa.start",
  "auth.mfa.start": "begins the CALLER's own TOTP enrollment; candidate secret stored under ctx.userId only",
  "auth.mfa.status": "reads the caller's own MFA state (userId unique lookups)",
  "auth.passkey.list": "listPasskeys(ctx.userId) — own credentials only",
  "auth.passkey.register.finish": "challenge bound to ctx.userId by register.start; upsert under (plane, ctx.userId, credentialId)",
  "auth.passkey.register.start": "attestation options generated for ctx.userId; excludeCredentials scoped to the caller's own credentials",
  "auth.passkey.remove": "credential matched to (id, plane, ctx.userId) + password re-check before delete",
  "auth.supportExit": "ends ONLY the calling support context (ctx.supportSession guard → 403 otherwise; Wave 10)",
  // --- ESS self-service (ess.ts + mirrors in letters/performance.ts) ---
  "ess.attendance": "requireSelf(ctx): own attendance rows only",
  "ess.dashboard": "requireSelf(ctx): own aggregates only",
  "ess.documents": "requireSelf(ctx): own documents/letters only",
  "ess.expenses": "requireSelf(ctx): own expense claims only",
  "ess.leave": "requireSelf(ctx): own leave balances/requests only",
  "ess.letterRequests": "ctx.employeeId-gated; creates/lists the caller's OWN letter requests, whitelisted types only (letters.ts:389)",
  "ess.myAssets": "requireSelf(ctx): own asset assignments, read-only (ESS-06 R7)",
  "ess.payroll": "requireSelf(ctx): own payslip entries only",
  "ess.payroll.html": "requireSelf(ctx) + employmentChainIds-scoped entry lookup — the caller's OWN payslip HTML (PAY-007)",
  "ess.payroll.pdf": "requireSelf(ctx) + employmentChainIds-scoped entry lookup — the caller's OWN payslip PDF download (UXD-3, P2 wave; same self-scope as ess.payroll.html)",
  "ess.performance": "requireSelf(ctx): own reviews/KPIs only, DRAFT reviews excluded (ESS-03)",
  "ess.profile": "requireSelf(ctx): own profile only",
  "ess.resignation": "requireSelf(ctx): own resignation only",
  "ess.reviewSelf": "findFirst({ id, vendorId, employeeId: ctx.employeeId }) — the employee rates THEMSELF (PRF-01 R7)",
  "ess.tasks": "requireSelf(ctx): own tasks only",
  "ess.wishes": "requireSelf(ctx): own birthday/anniversary events",
  // --- field force self-service (fieldforce.ts) ---
  "fieldforce.myday": "ctx.employeeId compound-key plan lookup — the caller's own My-Visits day view, read-only",
  // --- performance tasks (performance.ts; T-20 aliases share the def) ---
  "tasks.list": "EMPLOYEE callers (or anyone without tasks.view) are forced to assigneeId = ctx.employeeId — own tasks only",
  "tasks.save": "R8 split trust: assignee may touch only SELF_FIELDS on their own task; everything else needs tasks.create/edit in-handler",
  "tasks.comment": "comment rights: the assignee (rec.assigneeId === ctx.employeeId) or a tasks.edit holder",
  "performance.tasks.list": "T-20 alias of tasks.list — same RouteDef object, same in-handler scoping",
  "performance.tasks.save": "T-20 alias of tasks.save — same RouteDef object, same in-handler scoping",
  "performance.tasks.comment": "T-20 alias of tasks.comment — same RouteDef object, same in-handler scoping",
  // --- push channel (push.ts) — user convenience, own devices only ---
  "push.publicKey": "reads the vendor's PUBLIC VAPID key (RFC 8292 — public by design); no tenant data",
  "push.subscribe": "registerPushSubscription(vendorId, ctx.userId, …) — ownership forced server-side",
  "push.list": "listPushSubscriptions(vendorId, ctx.userId) — own devices only",
  "push.unsubscribe": "removePushSubscription(vendorId, ctx.userId, …) — own subscription only",
  "push.test": "sendTestPush(vendorId, ctx.userId) — own devices only",
  "push.registerDevice": "upsert under (ctx.userId, token) — the caller's own mobile device token",
  "push.unregisterDevice": "deleteMany({ userId: ctx.userId, token }) — own token only",
  // --- procurement self-service (procurement.ts) ---
  "requisitions.mine": "own requisitions only (vendorId + ctx.employeeId where)",
  "requisitions.receive": "handler verifies rec.employeeId === ctx.employeeId (HR-on-behalf additionally needs procurement.approve)",
  // --- exit self-service (exit.ts) ---
  "resignations.withdraw": "own = ctx.employeeId === rec.employeeId; anyone else needs exit.approve (M-02 comment at exit.ts:432)",
  // --- tracking self-service (tracking.ts) ---
  "tracking.location": "resolveSelfActor — employee identity derives from the session; the payload can never target another employee (M-02, tracking.ts:217)",
  "tracking.status": "resolveSelfActor — the caller's own-record status contract (M-02, tracking.ts:239)",
  // --- wishes (communication.ts) ---
  "wishes.today": "EMPLOYEE callers see only their own events; the tenant-wide board needs employees.view (H-03)",
}

// ----------------------------------------------------------------------------
// Enumeration + partition
// ----------------------------------------------------------------------------
const allActions = Object.keys(routes).sort()
const publicActions = allActions.filter((a) => routes[a]?.public === true)
const permActions = allActions.filter((a) => routes[a]?.public !== true && !!routes[a]?.perm)
const noPermActions = allActions.filter((a) => routes[a]?.public !== true && !routes[a]?.perm)

function matchedMarkers(action: string): string[] {
  const def = routes[action]
  if (!def) return []
  const src = def.handler.toString()
  return SANCTIONED_MARKERS.filter((m) => src.includes(m))
}

const markerMatched = noPermActions.filter((a) => matchedMarkers(a).length > 0)
const allowlisted = noPermActions.filter((a) => a in IDENTITY_INHERENT_ALLOWLIST)

describe("AUDIT M-5 — no-perm route inventory ratchet", () => {
  test("the registry is fully populated (router side-effect import worked)", () => {
    expect(allActions.length).toBeGreaterThan(700) // 775 on 2026-11-07 incl. 42 aliases
    expect(Object.keys(routeAliases).length).toBeGreaterThan(0)
  })

  test("partition summary is printed for the reviewer (counts as of 2026-11-07)", () => {
    // Informational — the ratchet assertions live below. The counts move as
    // routes are added/gated; the printed line makes every CI run show the
    // current no-perm surface size.
    console.log(
      `[M-5] total=${allActions.length} public=${publicActions.length} perm=${permActions.length} ` +
      `no-perm=${noPermActions.length} (marker-matched=${markerMatched.length}, allowlisted=${allowlisted.length})`,
    )
    expect(noPermActions.length).toBeGreaterThan(0) // parse sanity — partition isn't broken
  })

  test("every no-perm action is either marker-matched or on the identity-inherent allowlist", () => {
    const unaccounted = noPermActions.filter(
      (a) => matchedMarkers(a).length === 0 && !(a in IDENTITY_INHERENT_ALLOWLIST),
    )
    const msg = unaccounted.length
      ? `\nNEW no-perm route(s) without in-handler authorization evidence (AUDIT M-5 ratchet):\n` +
        unaccounted.map((a) => `  - ${a}: no sanctioned marker in handler source and no allowlist entry`).join("\n") +
        `\nEither add a sanctioned in-handler check (assertEmployeeVisible / require(ctx …) / …), ` +
        `give the route a def.perm, or allowlist it with a justification after review.\n`
      : ""
    expect(msg).toBe("")
  })

  test("every marker-matched action is NOT also allowlisted (one source of truth per action)", () => {
    const both = markerMatched.filter((a) => a in IDENTITY_INHERENT_ALLOWLIST)
    const msg = both.length
      ? `allowlist entries that now ALSO match a sanctioned marker (remove the allowlist entry — ` +
        `the marker is the better evidence):\n${both.map((a) => `  - ${a}`).join("\n")}\n`
      : ""
    expect(msg).toBe("")
  })

  test("the allowlist is not stale — every entry is still a registered no-perm action", () => {
    const stale: string[] = []
    for (const a of Object.keys(IDENTITY_INHERENT_ALLOWLIST)) {
      const def = routes[a]
      if (!def) stale.push(`  - ${a}: no longer registered — delete the entry`)
      else if (def.public) stale.push(`  - ${a}: now public — delete the entry`)
      else if (def.perm) stale.push(`  - ${a}: now carries perm [${def.perm.join(",")}] — delete the entry`)
    }
    const msg = stale.length
      ? `stale IDENTITY_INHERENT_ALLOWLIST entries (the route was gated/removed/renamed since curation):\n${stale.join("\n")}\n`
      : ""
    expect(msg).toBe("")
  })
})
