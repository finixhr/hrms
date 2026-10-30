/// <reference types="bun-types" />
// ============ Unit tests — mobile ↔ server API contract (T-17) ============
// The 2026-10-30 engineering audit (API_CONTRACT_AUDIT.md §2) found that 23 of
// the 39 RPC actions the mobile app called DID NOT EXIST server-side — every
// leave application, MFA login, check-in, support ticket and home-screen
// number was broken at the contract level, and nothing noticed because no
// test tied the two sides together. This file makes that drift class
// impossible to reintroduce silently:
//
//   (a) it PARSES the mobile app's source (mobile/app + mobile/src) for every
//       rpc()/useFetch() action reference and asserts each one is registered
//       on the server — a missing action fails here before it can ship;
//   (b) it pins the payload FIELD NAMES the app depends on (leaveApply
//       fromDate/toDate — was startDate/endDate; geoCheckin latitude/
//       longitude + clientEventId; push token REQUIRED on unregister);
//   (c) it pins the permission classification: the employee-plane family
//       must stay self-scoped (no HR permission tuple), and the HR-gated
//       screens' actions must keep their perm tuples;
//   (d) it validates the Modules hub's permission map against the registry
//       so the hub can never gate by an invented permission string.
//
// Response-shape coverage (notifications.list bare array, ess.* envelopes)
// lives in the DB-backed suites (r8-ess-inbox-tasks, phase3-wsd-mobile); this
// file keeps its assertions schema/registry-level so it also runs standalone.
import "./_testdb" // first — DB env bootstrap before any module graph
import { describe, test, expect } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import "@/hrm-server/routes/router" // registers every action (side effect)
import { routes } from "@/hrm-server/routes/registry"
import { S } from "@/hrm-server/validation"
import { ROLE_TEMPLATES } from "@/hrm-server/types"
// M3 (T-12) — the offline outbox's closed action union: a structured action
// reference the rpc() scanner cannot see. outbox-core.ts is dependency-free
// by design, so it is importable here directly.
import { OUTBOX_ACTIONS } from "../../mobile/src/lib/outbox-core"

// ---------------------------------------------------------------------------
// (a) Extract every RPC action the mobile app references, straight from source
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dir, "..", "..")
const MOBILE_DIRS = ["mobile/app", "mobile/src"].map((d) => join(REPO_ROOT, d))

function collectSourceFiles(dir: string, out: string[]): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (name === "node_modules" || name === ".expo" || name === ".DS_Store") continue
    const p = join(dir, name)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) collectSourceFiles(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
}

/** Scan source for `rpc(` / `useFetch(` first-string arguments, tolerating
 *  (possibly multi-line) generic type parameters. A small balanced-bracket
 *  scanner beats a single regex — `rpc<{ rows: Ticket[] }>("…")` etc. */
function extractRpcActions(src: string): Set<string> {
  const out = new Set<string>()
  const callRe = /\b(?:rpc|useFetch)\b/g
  let m: RegExpExecArray | null
  while ((m = callRe.exec(src))) {
    let i = m.index + m[0].length
    if (src[i] === "<") {
      // skip a balanced generic parameter list (runaway-capped)
      let depth = 0
      const cap = i + 500
      for (; i < src.length && i < cap; i++) {
        if (src[i] === "<") depth++
        else if (src[i] === ">") {
          depth--
          if (depth === 0) {
            i++
            break
          }
        }
      }
    }
    while (i < src.length && /\s/.test(src[i])) i++
    if (src[i] !== "(") continue
    i++
    while (i < src.length && /\s/.test(src[i])) i++
    const quote = src[i]
    if (quote !== '"' && quote !== "'") continue
    const end = src.indexOf(quote, i + 1)
    if (end === -1) continue
    const action = src.slice(i + 1, end)
    // action-shaped strings only: "module.verb[.sub…]" — skips i18n keys etc.
    if (/^[a-z][a-zA-Z0-9]*\.[a-zA-Z0-9_.]+$/.test(action)) out.add(action)
  }
  return out
}

const mobileFiles: string[] = []
for (const d of MOBILE_DIRS) collectSourceFiles(d, mobileFiles)
const mobileActions = new Set<string>()
for (const f of mobileFiles) {
  for (const a of extractRpcActions(readFileSync(f, "utf8"))) mobileActions.add(a)
}
// Fold the outbox's structured action references into the referenced set so
// the registry cross-check keeps covering the offline queue (M3).
for (const a of OUTBOX_ACTIONS) mobileActions.add(a)

// The actions the employee core depends on. If the app stops referencing one
// of these, either a feature regressed or the extraction scanner drifted —
// both deserve a loud failure, not a silent shrug.
const MOBILE_CRITICAL_ACTIONS = [
  // auth rail
  "auth.login", "auth.mfa.verify", "auth.me",
  // auth rail — first-login MFA enrollment wizard (T-14)
  "auth.mfa.enroll.start", "auth.mfa.enroll.enable",
  // home + notifications
  "ess.dashboard", "notifications.list",
  // attendance (today/week + policy + geo check-in/out + fallback)
  "ess.attendance", "tracking.status",
  "attendance.geofence.checkin", "attendance.geofence.checkout", "attendance.selfCheckout",
  // leave
  "ess.leave", "leaveRequests.apply",
  // ESS surfaces
  "ess.payroll", "ess.payroll.html", "ess.documents", "ess.expenses",
  "ess.performance", "ess.tasks", "ess.colleagues",
  // comms + support
  "announcements.list", "support.tickets", "support.ticket.create",
  // HR-gated (permission-checked screens)
  "recruitment.openings.list", "recruitment.applications.list",
  "reports.templates.list", "reports.attendanceOverview",
  // device plane
  "push.registerDevice", "push.unregisterDevice", "tracking.location",
]

// Employee-plane actions: enforced self-scope in-handler (requireSelf /
// notifScope / resolveSelfActor). Most carry NO permission tuple; the few
// that do (ess.colleagues, ess.loans → ess.view) must only require verbs the
// DEFAULT employee role template already includes — otherwise plain
// employees would be locked out of their own data surface.
const SELF_SCOPED_EMPLOYEE_ACTIONS = [
  "ess.dashboard", "ess.attendance", "ess.leave", "ess.payroll", "ess.payroll.html",
  "ess.documents", "ess.expenses", "ess.performance", "ess.tasks", "ess.colleagues",
  "notifications.list", "announcements.list", "tracking.status", "tracking.location",
  "attendance.geofence.checkin", "attendance.geofence.checkout", "attendance.selfCheckout",
  "leaveRequests.apply", "push.registerDevice", "push.unregisterDevice",
]

// ---------------------------------------------------------------------------
// (a) registry membership
// ---------------------------------------------------------------------------

describe("T-17 · every mobile-referenced action exists in the server registry", () => {
  test("the source scan found a meaningful action set (scanner sanity)", () => {
    // The employee core alone references ~29 actions; if the scanner suddenly
    // finds fewer than that, the extraction itself broke.
    expect(mobileActions.size).toBeGreaterThanOrEqual(MOBILE_CRITICAL_ACTIONS.length)
    expect(mobileFiles.length).toBeGreaterThan(10)
  })

  test("the offline outbox's closed action union only carries registered actions (M3)", () => {
    // The outbox is a NEW way for the app to reach the server — via
    // rpcAdapter(action, …) with a variable. This pin keeps the union
    // honest: an action that is not server-registered (or not one of the
    // idempotent punch routes) can never enter the offline queue.
    for (const a of OUTBOX_ACTIONS) {
      expect(routes[a], `outbox action "${a}" must be a registered server action`).toBeTruthy()
    }
    expect(OUTBOX_ACTIONS).toEqual([
      "attendance.geofence.checkin",
      "attendance.geofence.checkout",
    ])
  })

  test("no mobile rpc()/useFetch() target is missing from the registry", () => {
    const missing = [...mobileActions].filter((a) => !routes[a])
    expect(
      missing,
      `mobile references actions that are NOT registered server-side (the exact ` +
        `API_CONTRACT_AUDIT §2 failure class): ${missing.join(", ")}`,
    ).toEqual([])
  })

  test("the critical employee-plane actions are all referenced by the app", () => {
    const dropped = MOBILE_CRITICAL_ACTIONS.filter((a) => !mobileActions.has(a))
    expect(
      dropped,
      `the app no longer references these critical actions (feature regression or ` +
        `scanner drift): ${dropped.join(", ")}`,
    ).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// (c) permission classification pins
// ---------------------------------------------------------------------------

describe("T-17 · employee-plane actions stay callable by the default employee role", () => {
  const employeePerms = new Set<string>(ROLE_TEMPLATES.EMPLOYEE)

  for (const action of SELF_SCOPED_EMPLOYEE_ACTIONS) {
    test(`"${action}" is registered (self-scoped or gated only by employee-template perms)`, () => {
      expect(routes[action], `${action} must exist`).toBeTruthy()
      const perm = routes[action]!.perm
      if (!perm) return // pure self-scope — nothing further to prove
      const verb = perm.join(".")
      expect(
        employeePerms.has(verb),
        `${action} requires "${verb}" which the DEFAULT employee role template does ` +
          `not include — plain employees would be locked out of their own data ` +
          `surface (ROLE_TEMPLATES.EMPLOYEE in src/hrm-server/types.ts)`,
      ).toBe(true)
    })
  }

  test("auth.login / auth.mfa.verify remain public credential-exchange actions", () => {
    expect(routes["auth.login"]!.public).toBe(true)
    expect(routes["auth.mfa.verify"]!.public).toBe(true)
  })

  test("T-14 · first-login MFA enrollment actions are public, capability-gated exchanges", () => {
    // These are INTENTIONALLY_PUBLIC (M-02): the enrollToken capability
    // (proof of password) IS the authentication — exactly like auth.mfa.verify.
    // The behavioral contract (start provisions a secret; enable refuses a
    // wrong code, refuses already-enrolled accounts, promotes to a full
    // session, returns recovery codes exactly once) is pinned in
    // tests/unit/h1-mfa-enrollment.test.ts against the real /api/hrm boundary.
    expect(routes["auth.mfa.enroll.start"]!.public).toBe(true)
    expect(routes["auth.mfa.enroll.enable"]!.public).toBe(true)
    // The wizard must actually reference both actions (scanner-checked), and
    // the login hand-off must exist — the app cannot regress to the T-02
    // "go to the web portal" dead end without failing the critical-action pin.
    expect(mobileActions.has("auth.mfa.enroll.start")).toBe(true)
    expect(mobileActions.has("auth.mfa.enroll.enable")).toBe(true)
  })
})

describe("T-17 · HR-gated mobile actions keep their permission tuples", () => {
  test("support stays open to every role (basic(\"support\") is in all templates)", () => {
    expect(routes["support.tickets"]!.perm).toEqual(["support", "view"])
    expect(routes["support.ticket.create"]!.perm).toEqual(["support", "view"])
  })

  test("reports / recruitment screens are HR-gated server-side", () => {
    expect(routes["reports.templates.list"]!.perm).toEqual(["reports", "view"])
    expect(routes["reports.attendanceOverview"]!.perm).toEqual(["attendance", "view"])
    expect(routes["recruitment.openings.list"]!.perm).toEqual(["recruitment", "view"])
    expect(routes["recruitment.applications.list"]!.perm).toEqual(["recruitment", "view"])
  })
})

// ---------------------------------------------------------------------------
// (b) payload field-name pins
// ---------------------------------------------------------------------------

describe("T-17 · payload field names the mobile app depends on", () => {
  test("leaveRequests.apply is wired to S.leaveApply with fromDate/toDate (was startDate/endDate)", () => {
    expect(routes["leaveRequests.apply"]!.schema).toBe(S.leaveApply)
    const shape = Object.keys((S.leaveApply as any).shape)
    expect(shape).toContain("leaveTypeId")
    expect(shape).toContain("fromDate")
    expect(shape).toContain("toDate")
    expect(shape).not.toContain("startDate")
    expect(shape).not.toContain("endDate")
  })

  test("geo check-in/out require latitude/longitude and accept clientEventId (idempotency)", () => {
    for (const action of ["attendance.geofence.checkin", "attendance.geofence.checkout"]) {
      const shape = Object.keys((routes[action]!.schema as any).shape)
      expect(shape, `${action} schema fields`).toContain("latitude")
      expect(shape, `${action} schema fields`).toContain("longitude")
      expect(shape, `${action} schema fields`).toContain("clientEventId")
    }
    expect(routes["attendance.geofence.checkin"]!.schema).toBe(S.geoCheckin)
    expect(routes["attendance.geofence.checkout"]!.schema).toBe(S.geoCheckout)
    expect(routes["attendance.selfCheckout"]!.schema).toBe(S.selfCheckout)
  })

  test("M3 · punch schemas accept the offline-outbox fields (offlineCapture + clientTimestamp)", () => {
    for (const action of ["attendance.geofence.checkin", "attendance.geofence.checkout", "attendance.selfie.checkin"]) {
      const shape = Object.keys((routes[action]!.schema as any).shape)
      expect(shape, `${action} must accept offlineCapture (outbox replay marker)`).toContain("offlineCapture")
      expect(shape, `${action} must accept clientTimestamp (preserved device capture time)`).toContain("clientTimestamp")
    }
  })

  test("M3 · selfie.checkin requires the photo and accepts the mobile capture payload", () => {
    const schema: any = routes["attendance.selfie.checkin"]!.schema
    const shape = Object.keys(schema.shape)
    // the photo IS the punch — the mobile capture sheet resolves exactly this
    expect(shape).toContain("selfieDataUrl")
    expect(shape).toContain("selfieQuality")
    expect(shape).toContain("clientEventId")
    // GPS is best-effort for a selfie punch (mobile attaches it when available)
    expect(shape).toContain("latitude")
    expect(shape).toContain("longitude")
    // a selfieDataUrl-less payload must fail validation (32-char minimum)
    const bad = schema.safeParse({ clientEventId: "x", clientTimestamp: new Date().toISOString() })
    expect(bad.success).toBe(false)
    // a minimal valid payload (tiny JPEG data-URL) passes with GPS omitted
    const ok = schema.safeParse({
      selfieDataUrl: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD//9k=",
      clientEventId: "evt-1",
      clientTimestamp: new Date().toISOString(),
      offlineCapture: false,
    })
    expect(ok.success).toBe(true)
  })

  test("support.ticket.create accepts the mobile form fields (subject/category/priority/message)", () => {
    const schema: any = routes["support.ticket.create"]!.schema
    const shape = Object.keys(schema.shape)
    expect(shape).toContain("subject")
    expect(shape).toContain("category")
    expect(shape).toContain("priority")
    expect(shape).toContain("message")
    // the mobile form sends the NORMAL enum member (MEDIUM does not exist)
    expect(schema.shape.priority.safeParse("NORMAL").success).toBe(true)
    expect(schema.shape.priority.safeParse("MEDIUM").success).toBe(false)
  })

  test("push register/unregister REQUIRE the token field (empty-payload bug pin)", () => {
    // The old logout sent {} to push.unregisterDevice — schema validation
    // rejected it and the error was swallowed, so devices kept receiving
    // tenant pushes after sign-out. Both actions must keep requiring token.
    for (const action of ["push.registerDevice", "push.unregisterDevice"]) {
      const schema: any = routes[action]!.schema
      expect(
        schema.safeParse({}).success,
        `${action} must reject an empty payload (token is required)`,
      ).toBe(false)
      expect(
        schema.safeParse({ token: "ExponentPushToken[abcdefghijklmnopqrst]" }).success,
        `${action} must accept a bare token payload`,
      ).toBe(true)
    }
  })

  test("push.registerDevice platform enum is expo/fcm/apns — NOT android/ios", () => {
    const schema: any = routes["push.registerDevice"]!.schema
    expect(schema.shape.platform.safeParse("expo").success).toBe(true)
    expect(schema.shape.platform.safeParse("android").success).toBe(false)
    expect(schema.shape.platform.safeParse("ios").success).toBe(false)
  })

  test("T-15 · the EAS push projectId is configured in app.json (non-placeholder)", () => {
    // Remote Expo push tokens are minted AGAINST the EAS project — without
    // extra.eas.projectId, getExpoPushTokenAsync cannot produce a working
    // remote token and every registered device would be dead weight in
    // DeviceToken. The release line linked @finixhr/finix-hr (EAS build
    // 30e4a348 completed against it — docs/RELEASE-STATUS.md §4.4); this pin
    // keeps the manifest wired so a refactor cannot silently drop it.
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "mobile/app.json"), "utf8"))
    const projectId = manifest?.expo?.extra?.eas?.projectId
    expect(typeof projectId).toBe("string")
    expect(projectId!.length).toBeGreaterThanOrEqual(30) // UUID shape
    expect(projectId).not.toMatch(/YOUR_|PLACEHOLDER|CHANGEME/i)
    // push.ts must resolve that same manifest path (and fail closed without it)
    const pushSrc = readFileSync(join(REPO_ROOT, "mobile/src/lib/push.ts"), "utf8")
    expect(pushSrc).toContain("expoConfig?.extra")   // manifest path resolution
    expect(pushSrc).toContain("eas?.projectId")      // the nested EAS key
    expect(pushSrc).toContain("EXPO_PUBLIC_EAS_PROJECT_ID")
  })
})

// ---------------------------------------------------------------------------
// (d) the Modules hub gates only by REAL registry permissions
// ---------------------------------------------------------------------------

describe("T-17 · mobile Modules hub permission map is registry-real", () => {
  test("every perm the hub gates by is a permission some server action actually requires", () => {
    const hubSrc = readFileSync(join(REPO_ROOT, "mobile/app/(tabs)/modules.tsx"), "utf8")
    const gatedPerms = [...hubSrc.matchAll(/perm: "([a-z]+\.[a-z]+)"/g)].map((m) => m[1]!)
    expect(gatedPerms.length).toBeGreaterThanOrEqual(20) // 23 today — sanity floor

    const registryPerms = new Set<string>()
    for (const def of Object.values(routes)) {
      if (def.perm) registryPerms.add(def.perm.join("."))
      if (def.altPerm) registryPerms.add(def.altPerm.join("."))
    }
    const invented = gatedPerms.filter((p) => !registryPerms.has(p))
    expect(
      invented,
      `the Modules hub gates by permissions NO server action requires (typos or ` +
        `invented verbs — employees would lose visible modules for no reason): ` +
        `${invented.join(", ")}`,
    ).toEqual([])
  })
})
