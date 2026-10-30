// ============ Central RPC API dispatcher ============
// POST /api/hrm  { action, payload }
// Enforces: content-type → origin allowlist → session → CSRF token (cookie path)
//           → vendor tenant → module.action permission → handler.
// UI button hiding is convenience only — THIS is the security boundary.
//
// C-4 (CSRF) — three layered defenses for every request:
//   1. Content-Type must be application/json (a no-cors form/text-plain POST is dropped).
//   2. Origin/Referer (when present) must match the deployment host allowlist.
//   3. Cookie-authenticated calls must echo the session's CSRF token in
//      X-CSRF-Token. The Bearer fallback is exempt by construction: a custom
//      header cannot be sent cross-site without a CORS preflight, and the token
//      itself is unreadable to foreign origins. Capability tokens carried in
//      the payload (mfaToken/pwToken) are likewise exempt — knowledge of the
//      256-bit capability IS the authentication, and it is not ambient.
import { NextRequest, NextResponse } from "next/server"
import { getCtxFromToken, logout as doLogout, sessionCookieStr, clearCookieStr } from "@/hrm-server/auth"
import { getRoute } from "@/hrm-server/routes/router"
import type { RouteDef } from "@/hrm-server/routes/registry"
import { require, Deny } from "@/hrm-server/rbac"
import { captureError } from "@/hrm-server/telemetry"
import { isOriginAllowed, refererHost, safeEqual, rateLimit, resolveClientIp, authThrottleKeys } from "@/hrm-server/security"
import { observeRpc } from "@/hrm-server/metrics"
import { resolveEntitlements, featureBlocked, MODULE_FEATURE_GATES } from "@/hrm-server/saas/entitlements"
// Wave 10 (2026-10-24) — Time-Limited Support Access: the THIRD session plane
// (saas_support_session cookie) resolves here as a fallback when no tenant
// session is presented, and every action it reaches is policy-gated by
// supportAccessActionAllowed (deny-by-default; READ_ONLY = *.view only,
// CONTROLLED_WRITE = the explicitly scoped SUPPORT_WRITE_CATALOG).
import { resolveSupportCtx, supportAccessActionAllowed, supportClearCookieStr, SUPPORT_COOKIE } from "@/hrm-server/saas/support-access"
import { saasAudit } from "@/hrm-server/saas/audit"

// ---- SaaS entitlement helpers (platform layer, see the enforcement block) ----
// Maps internally-authorized action prefixes (routes that carry no def.perm
// because they enforce identity in-handler, e.g. ess.*) to their module key
// so the feature gate still applies to them.
// SUB-107 (Wave R3-5) — "leaveRequests" is mapped to the (core) leave module
// so the Owner Console's per-tenant Leave Management override controls the
// whole self-service leave surface too; the plan-level ESS feature is
// enforced in-handler on the employee path (leave.ts leaveRequests.apply).
// Exported for the route-inventory regression tests (tests/unit/r3-5-*).
export const SAAS_ACTION_PREFIX_MODULE: Record<string, string> = {
  ess: "ess",
  tracking: "tracking",
  geofences: "geofence",
  leaveRequests: "leave",
}
function saasActionModule(action: string): string | null {
  const prefix = action.split(".")[0]
  return SAAS_ACTION_PREFIX_MODULE[prefix] || null
}

// Actions that must keep working while a subscription is EXPIRED/SUSPENDED/
// CANCELLED (read-only mode): identity, session, notifications, the tenant's
// own subscription view, global search, and pure reads.
const SAAS_READONLY_EXEMPT_PREFIXES = [
  "auth.", "subscription.", "notifications.", "search.global", "jobs.get",
  "push.", "support.",
  "ess.dashboard", "ess.profile", "ess.attendance", "ess.payroll",
  "ess.colleagues", "ess.loans", "ess.tasks", "ess.performance",
  "ess.documents", "ess.wishes",
  "billing.overview", "billing.invoices", "billing.payments", "billing.plans",
  "billing.payments.", "billing.pay.", "billing.receipt", "billing.events",
  "billing.paymentInstructions", "billing.planChangeRequest",
]

// FULL-LOCK allowlist (PENDING_PAYMENT tenants — master prompt Part F §10):
// the minimum surface a brand-new tenant needs to complete onboarding, pay,
// and ask for help. Everything else — HR reads included — is denied.
// (The public /api/payments/return|ipn completion routes live OUTSIDE this
// dispatcher, so gateway verification is unaffected.)
const SAAS_LOCKED_EXEMPT_PREFIXES = [
  "auth.",           // login/logout/MFA/me/session — account functions
  "billing.",        // invoices, pay now, receipts, plan catalog, upgrades
  "subscription.",   // subscription status + usage read
  "support.",        // Support Center: tickets + Live Support Access requests
]

// ---- SUB-002/SUB-104 (re-ported R3-2) — read-only lockout classification ----
// The old verb-allowlist heuristic (~31 mutating heads) let ~75 mutating
// actions through to EXPIRED/SUSPENDED tenants (attendance.mark,
// payroll.adjustmentCreate, employees.hardDelete, approvals.act,
// loans.recordInstallment, inventory.stock.adjust, settings.patch, …)
// because their head matched no verb. The classification is now INVERTED:
// an action is MUTATING unless one of these holds —
//   1. its prefix is in SAAS_READONLY_EXEMPT_PREFIXES,
//   2. def.mutating === false (explicit per-route rescue for a pure read),
//   3. its perm verb is view / export / download,
//   4. its action head is in READ_HEADS below.
// READ_HEADS was derived from the full route inventory (every unique head
// individually classified); every head NOT listed is treated as a mutation
// for lockout purposes. Misclassifications are safe: a missed read only
// annoys a locked-out tenant (recoverable), while a missed write breaks the
// lockout (the audited bug class).
const READ_HEADS = new Set([
  // universal reads
  "get", "list", "view", "mine", "search", "options", "detail", "status",
  "history", "summary", "stats", "overview", "all", "pending", "today",
  "preview", "validate", "preflight", "print", "html", "download", "export",
  // domain read heads (inventory-derived)
  "dashboard", "profile", "colleagues", "documents", "expenses", "leave",
  "payroll", "attendance", "performance", "loans", "resignation", "wishes",
  "global", "data", "organogram", "scheduled", "results", "reconciliation",
  "ledger", "trialBalance", "incomeStatement", "balanceSheet", "cashFlow",
  "coa", "policy", "me", "templates", "invoices", "payments", "plans",
  "paymentInstructions", "receipt", "planChangeRequests", "usage", "board",
  "myday", "live", "liveFeed", "location", "mappings", "commLogs",
  "syncStats", "unknownUsers", "eventDetail", "entries", "reversals",
  "itemOptions", "recipients", "queue", "nextCode", "certificate",
  "myCertificates", "effective", "attendanceHistory", "attendanceOverview",
  "attendanceOverviewCsv", "salary", "cv", "letter", "reports", "punchAlerts",
  "attachment", "anomalies", "resumeScreen", "reportAsk", "otPending",
  "events", "options",
])
function saasIsMutating(action: string, def: RouteDef): boolean {
  if (SAAS_READONLY_EXEMPT_PREFIXES.some((p) => action.startsWith(p))) return false
  // explicit per-route classification beats every heuristic
  if (def.mutating === true) return true
  if (def.mutating === false) return false
  // view-only permission verbs are reads by definition
  if (def.perm && ["view", "export", "download"].includes(def.perm[1])) return false
  // deny-by-default: only the allowlisted read heads pass
  const head = action.split(".").pop() || action
  return !READ_HEADS.has(head)
}

export const dynamic = "force-dynamic"

/** M-14 — request-body cap enforced BEFORE req.json(): the dispatcher
 *  previously read and JSON-parsed arbitrarily large bodies (multi-MB base64
 *  buffers decoded before any route-level check could reject them — the edge
 *  proxy's cap is bypassed on direct :3000 access). 8 MB is generous headroom
 *  over the largest legitimate payload (leave attachments ~3 MB data-URL +
 *  envelope). */
const BODY_CAP_BYTES = 8 * 1024 * 1024

/** LAN-ACCESS FIX — true when the request reached this server over HTTPS,
 * either directly or through the TLS-terminating proxy (Caddy sets
 * X-Forwarded-Proto). Direct plain-HTTP LAN access (http://<server-ip>:3000)
 * returns false, which makes the session cookie drop its Secure/Partitioned
 * attributes — otherwise browsers refuse to store it and every reload bounces
 * the user back to the login screen. Unknown/absent indicators default to
 * secure=true so real HTTPS deployments never regress. */
function isHttpsReq(req: NextRequest): boolean {
  const xf = (req.headers.get("x-forwarded-proto") || "").split(",")[0].trim().toLowerCase()
  if (xf) return xf === "https"
  try {
    return new URL(req.url).protocol === "https:"
  } catch {
    return true
  }
}

/** M-10 — map raw error objects to safe, actionable client messages. */
function clientError(e: any, action: string): { message: string; code: number } {
  const ref = `${action || "unknown"}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  // Prisma error codes are STRINGS ("P2002"); controlled app codes are NUMBERS.
  // Collapsing both into one string field turned every numeric 4xx into a
  // truthy "prismaCode" and misreported it as a 500 (e.g. wrong password).
  const prismaCode = typeof e?.code === "string" ? e.code : ""
  if (prismaCode === "P2002") return { message: "Duplicate: a record with the same unique value already exists. Refresh and try again.", code: 400 }
  if (prismaCode === "P2025") return { message: "The record was changed or removed by someone else. Refresh and try again.", code: 404 }
  if (prismaCode === "P2003") return { message: "This record is referenced elsewhere and cannot be removed. Remove the references first.", code: 400 }
  if (e instanceof Deny) return { message: e.message, code: e.code || 403 }
  // Controlled application errors carry a numeric code + human message (auth, validation…)
  if (typeof e?.message === "string" && Number.isFinite(e?.code) && e.code >= 400 && e.code < 500) {
    return { message: e.message, code: e.code }
  }
  // Everything else is an unexpected failure — never leak Prisma internals/stacks
  console.error(`[hrm] action=${action} ref=${ref} failed:`, e)
  // Wave 4 A5 — optional telemetry capture (no-op unless TELEMETRY_DSN is set)
  captureError(e, { action })
  return { message: `Unexpected server error (ref ${ref}). The issue was logged — try again or contact support if it persists.`, code: 500 }
}

export async function POST(req: NextRequest) {
  let action = ""
  // Phase 1 WS Metrics — per-request timing for the p50/p95 gauges. `failed`
  // marks the catch path (4xx/5xx); early returns inside the try are all
  // dispatcher-level rejections (415/413/403/401/404/400), which the family
  // "_dispatch" bucket (or the parsed action's family once known) absorbs.
  const t0 = Date.now()
  let failed = false
  try {
    // ---- C-4 layer 1: strict content-type (no-cors/text-plain CSRF carriers die here)
    const contentType = (req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase()
    if (contentType !== "application/json") {
      return NextResponse.json({ ok: false, error: "Unsupported content type — application/json required", code: 415 }, { status: 415 })
    }

    // M-14 — body cap BEFORE buffering/parsing (content-length pre-check; the
    // post-read length check below catches lying/missing headers)
    const contentLength = Number(req.headers.get("content-length") || 0)
    if (contentLength > BODY_CAP_BYTES) {
      return NextResponse.json({ ok: false, error: "Request body too large", code: 413 }, { status: 413 })
    }

    const bodyText = await req.text()
    if (bodyText.length > BODY_CAP_BYTES) {
      return NextResponse.json({ ok: false, error: "Request body too large", code: 413 }, { status: 413 })
    }
    let body: any
    try {
      body = bodyText ? JSON.parse(bodyText) : {}
    } catch {
      return NextResponse.json({ ok: false, error: "Malformed JSON body", code: 400 }, { status: 400 })
    }
    action = body.action || ""
    const payload = body.payload || {}
    const def = getRoute(action)
    if (!def) {
      return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 404 })
    }

    // ---- C-4 layer 2: origin allowlist (browsers always send Origin or Referer on cross-site POSTs)
    const reqHost = req.headers.get("host")
    const origin = req.headers.get("origin")
    const originHost = origin ? (() => { try { return new URL(origin).host } catch { return "\u0000invalid" } })() : refererHost(req.headers.get("referer"))
    if (originHost && !isOriginAllowed(origin, reqHost) && originHost !== reqHost && !(process.env.HRM_ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).includes(originHost)) {
      return NextResponse.json({ ok: false, error: "Cross-origin request blocked", code: 403 }, { status: 403 })
    }

    // session token: Bearer header takes precedence for non-ambient API clients (mobile/desktop).
    // httpOnly cookie is used for web browser sessions (ambient credentials).
    const authHeader = req.headers.get("authorization") || ""
    const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : null
    const cookieToken = req.cookies.get("hrm_session")?.value || null
    const isBearerAuth = !!bearer
    const token = bearer || cookieToken || undefined
    // H-7 — client IP via the shared resolver: X-Forwarded-For is only honored
    // behind a configured trusted proxy (HRM_TRUST_PROXY=1). Otherwise null and
    // auth throttles fall back to email-bound keys (see authThrottleKeys).
    const ip = resolveClientIp(req) || undefined
    let ctx = await getCtxFromToken(token, ip)
    // ---- Wave 10 (2026-10-24) — Support-session fallback (THIRD plane) ----
    // A live time-limited support session authorizes tenant-plane reads
    // WITHOUT a tenant login: resolveSupportCtx enforces status + expiry
    // server-side on every call and never grants the tenant admin's role.
    // The planes never merge: a real tenant session ALWAYS wins, and the
    // support cookie is IGNORED entirely once one exists.
    if (!ctx) {
      const supportToken = req.cookies.get(SUPPORT_COOKIE)?.value || null
      ctx = await resolveSupportCtx(supportToken, ip)
    }

    // ---- M-16/H-7 — throttle unauthenticated auth-surface actions.
    // Per (ip, email) at 10/min stops targeted brute force while keeping
    // distinct users behind one NAT/proxy independent. When the IP is unknown
    // (untrusted XFF), the bucket is keyed on the EMAIL ALONE — a rotating
    // spoofed X-Forwarded-For cannot mint fresh buckets. The old shared global
    // "unknown-ip" bucket (60/min for the whole deployment) is REMOVED: it
    // throttled every user together and was a spoofable DoS amplifier.
    // ---- M-1 — identity for throttling: the email when the action carries
    // one, otherwise the capability/session token the action itself is gated
    // on (mfaToken / pwToken / enrollToken / the session token). NEVER a
    // shared deployment-wide bucket: keying capability flows on the empty
    // email meant 11 unauthenticated auth.mfa.verify calls locked the
    // second-factor step for EVERY user at once.
    if (def.public && action.startsWith("auth.")) {
      const emailKey = String(payload?.email || "").toLowerCase().slice(0, 80)
      const capability = String(payload?.mfaToken || payload?.pwToken || payload?.enrollToken || "")
      const identity = emailKey
        || (capability ? `cap:${capability.slice(0, 24)}` : "")
        || (token ? `sess:${token.slice(0, 24)}` : "")
      if (identity) {
        const keys = authThrottleKeys(identity, ip ?? null)
        if (await rateLimit(keys[0], 10, 60_000) || (keys.length > 1 && await rateLimit(keys[1], 60, 60_000))) {
          return NextResponse.json({ ok: false, error: "Too many attempts — wait a minute and try again", code: 429 }, { status: 429 })
        }
      }
      // No identity material at all (e.g. auth.password.policy with a blank
      // email, auth.logout with no cookie/bearer): nothing to protect — the
      // handler performs at most one indexed read and mutates nothing, and a
      // shared bucket here would re-create the M-1 DoS.
    }

    // ---- C-4 layer 3: CSRF token for ambient (cookie) authentication.
    // Bearer headers and payload capability tokens (mfaToken/pwToken) are exempt.
    // Two more exemptions, both security-neutral:
    //   - A cookie that resolves to NO live session holds no ambient authority —
    //     there is nothing to forge — so it is treated as absent (the request
    //     proceeds unauthenticated) instead of hard-failing. Without this, a
    //     stale httpOnly cookie (replaced DB, idle-timeout sweep, admin session
    //     revocation) blocks auth.login until it expires: an unrecoverable
    //     lockout, since JavaScript cannot clear an httpOnly cookie.
    //   - auth.login carrying a password re-establishes identity with a PRIMARY
    //     credential (a CSRF attacker does not know it). The login-CSRF variant
    //     (cross-site POST of the attacker's own credentials) is already blocked
    //     by layers 1–2: no-cors forms cannot send application/json, and a
    //     cross-origin fetch triggers a CORS preflight this server never grants.
    const carriesCapability = !!(payload && (payload.mfaToken || payload.pwToken))
    const carriesPrimaryCredential = action === "auth.login" && typeof payload?.password === "string" && payload.password !== ""
    // H-08 — auth.me is CSRF-exempt: it is a read-only identity introspection
    // used to BOOTSTRAP the (memory-only) CSRF token after a hard reload, so
    // requiring the echo here would deadlock the app. A cross-site forced POST
    // of auth.me gains nothing: the action mutates nothing and its response is
    // unreadable cross-origin (this server never grants CORS reads).
    const isCsrfBootstrap = action === "auth.me"
    // When authenticated via ambient cookie (not Bearer header), CSRF token in X-CSRF-Token is mandatory.
    if (!isBearerAuth && cookieToken && !carriesCapability && !carriesPrimaryCredential && !isCsrfBootstrap && ctx) {
      const presented = req.headers.get("x-csrf-token") || ""
      if (!ctx.csrfToken || !safeEqual(presented, ctx.csrfToken)) {
        return NextResponse.json({ ok: false, error: "Missing or invalid CSRF token — reload the page and try again", code: 403 }, { status: 403 })
      }
    }

    if (action === "auth.logout" && token) {
      await doLogout(token)
      const out = NextResponse.json({ ok: true, data: { loggedOut: true } })
      out.headers.append("Set-Cookie", clearCookieStr(isHttpsReq(req)))
      return out
    }

    if (!def.public && !ctx) {
      return NextResponse.json({ ok: false, error: "Authentication required", code: 401 }, { status: 401 })
    }

    // ---- Wave 10 (2026-10-24) — Support-session policy gate (runs for EVERY
    // action a support context attempts, BEFORE the normal RBAC layer):
    // deny-by-default against the support action policy — *.view read surface
    // + the explicitly scoped SUPPORT_WRITE_CATALOG only; internally-authorized
    // routes (no def.perm — ess.*, tracking.* …) are refused because they
    // enforce a self-identity the support context never holds. Denials are
    // audited on the platform plane (SUPPORT_ACCESS_DENIED) so the Owner
    // Console drill-down shows every refused reach.
    if (ctx?.supportSession) {
      // ctx.permissions = {module}.view (read surface) + the scoped
      // SUPPORT_WRITE_CATALOG entries — the policy wants the WRITE scope.
      const writeScope = Array.from(ctx.permissions).filter((p) => !p.endsWith(".view"))
      const decision = supportAccessActionAllowed({
        action,
        permModule: def.perm?.[0],
        permVerb: def.perm?.[1],
        altPermModule: def.altPerm?.[0],
        altPermVerb: def.altPerm?.[1],
        accessMode: ctx.supportSession.accessMode,
        scope: writeScope,
      })
      if (!decision.allowed) {
        await saasAudit(
          { id: ctx.userId, name: ctx.userName, ip },
          "SUPPORT_ACCESS_DENIED", "SaasSupportAccessSession", ctx.supportSession.id,
          `Support action "${action}" refused: ${decision.reason || "outside the authorized support scope"}`,
          { vendorId: ctx.vendorId, metadata: { action, reason: decision.reason || null } },
        ).catch(() => {})
        return NextResponse.json({ ok: false, error: decision.reason || "This action is outside the authorized support scope.", code: 403 }, { status: 403 })
      }
    }

    // permission enforcement (server-side, per action)
    if (def.perm && ctx) {
      try {
        require(ctx, def.perm[0], def.perm[1])
      } catch (e: any) {
        // RBAC-105 (re-audit 2026-10-18 repair) — dual-verb actions accept
        // their documented ALTERNATIVE permission (e.g. changeShift:
        // employees.assign OR employees.edit). The alt gate is exactly as
        // strict as the primary verb; without it the in-handler acceptance
        // was unreachable through this boundary (dispatcher 403 first).
        if (def.altPerm) {
          try {
            require(ctx, def.altPerm[0], def.altPerm[1])
          } catch {
            return NextResponse.json({ ok: false, error: e.message, code: 403 }, { status: 403 })
          }
        } else {
          return NextResponse.json({ ok: false, error: e.message, code: 403 }, { status: 403 })
        }
      }
    }

    // ---- SaaS platform entitlement enforcement (server-side, per request) ----
    // Two layers, resolved ONCE per request from the vendor's subscription:
    //   1. MODULE FEATURE GATE — a plan (or owner override) that does not
    //      include a module blocks every action of that module with an
    //      actionable upgrade message. UI hiding is convenience only.
    //   2. READ-ONLY LOCKOUT — EXPIRED / SUSPENDED / CANCELLED subscriptions
    //      keep the workspace fully readable (data is never destroyed) but
    //      block every mutating action until renewed.
    //   3. FULL LOCK (2026-10-25, master prompt Part F §10) — PENDING_PAYMENT
    //      tenants (a paid plan provisioned but never paid) lose the HR
    //      modules ENTIRELY: reads included. Only auth / billing /
    //      subscription / support surfaces stay reachable — the minimum the
    //      tenant needs to complete onboarding, pay, or ask for help.
    // LEGACY MODE: vendors without a subscription row (pre-SaaS deployments)
    // pass both layers untouched — adding the SaaS layer never bricks an
    // existing customer.
    if (ctx) {
      const ent = await resolveEntitlements(ctx.vendorId)
      // 0. FULL LOCK — unpaid provisioned tenants: deny EVERYTHING except the
      //    onboarding-critical surfaces (server-side; UI hiding is cosmetic).
      if (ent.locked && !SAAS_LOCKED_EXEMPT_PREFIXES.some((p) => action.startsWith(p))) {
        return NextResponse.json({
          ok: false,
          error: `Your subscription payment is pending${ent.planName ? ` (${ent.planName})` : ""}. Complete the payment from Billing & Subscription to unlock your workspace — meanwhile only billing, account and support functions are available.`,
          code: 403,
          entitlement: { status: ent.status, plan: ent.planName, locked: true, paymentRequired: true },
        }, { status: 403 })
      }
      // 1. feature gate — module key from the route's perm, or from the
      //    action prefix for internally-authorized routes (ess.*, tracking.*).
      const gateModule = def.perm ? def.perm[0] : saasActionModule(action)
      if (gateModule) {
        if (featureBlocked(ent, gateModule)) {
          const gate = MODULE_FEATURE_GATES[gateModule]
          return NextResponse.json({
            ok: false,
            error: `${gate} is not included in your ${ent.planName || "current"} plan. Contact your platform administrator to upgrade.`,
            code: 403,
            entitlement: { feature: gate, plan: ent.planName, upgradeRequired: true },
          }, { status: 403 })
        }
      }
      // 2. read-only lockout — mutating verbs only; views/exports/downloads and
      //    the auth/subscription surfaces always work.
      if (ent.readonly && saasIsMutating(action, def)) {
        return NextResponse.json({
          ok: false,
          error: `Your subscription is ${ent.status === "SUSPENDED" ? "suspended" : "expired"}${ent.planName ? ` (${ent.planName})` : ""}. The workspace is read-only until it is renewed — contact your platform administrator.`,
          code: 403,
          entitlement: { status: ent.status, plan: ent.planName, readonly: true, renewalRequired: true },
        }, { status: 403 })
      }
    }

    // ---- M-01: schema validation BEFORE the handler runs ----
    // When a route declares a zod schema the payload is validated and
    // replaced by the typed, stripped object (unknown fields dropped /
    // rejected per schema strictness). A validation failure is a clean 400.
    // (Support sessions run the same schemas — the policy gate above already
    // narrowed their reachable actions; validation protects them equally.)
    let handlerPayload = payload
    if (def.schema) {
      const parsed = def.schema.safeParse(payload)
      if (!parsed.success) {
        const issue = parsed.error.issues?.[0]
        const path = issue?.path?.length ? ` at "${issue.path.join(".")}"` : ""
        return NextResponse.json({
          ok: false,
          error: `Invalid payload${path}: ${issue?.message || "validation failed"}`,
          code: 400,
        }, { status: 400 })
      }
      handlerPayload = parsed.data
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): convert to an explicit null check
    const data = await def.handler(ctx!, handlerPayload, req)
    // 2026-10-13 — bigint-safe JSON encoding: Prisma BIGINT columns (the
    // *Paisa money shadows widened in migration 9_wave6) make JSON.stringify throw
    // "Do not know how to serialize a BigInt". Every app bigint is far below
    // 2^53, so encoding as a plain Number is lossless. Handlers keep working
    // with raw Prisma rows; only the wire format converts.
    const res = new NextResponse(
      JSON.stringify({ ok: true, data }, (_k, v) => (typeof v === "bigint" ? Number(v) : v)),
      { headers: { "content-type": "application/json" } }
    )
    // Session-issuing auth actions: auth.login, auth.mfa.verify,
    // auth.mfa.enroll.enable and auth.passkey.login.finish all mint a FULL
    // session whose id is returned in the JSON payload. EVERY one of them must
    // also set the httpOnly cookie - it is the sole persistent auth transport
    // (H-08: the SPA keeps only a 5-minute memory bearer). Previously only
    // auth.login set it, so after MFA verification the app ran on the memory
    // bearer alone; at its expiry (or on the first tab-focus auth.me / reload,
    // which authenticate cookie-only) every call 401'd and the user was bounced
    // back to the login screen with "Your session has ended". The passkey
    // login (routes/passkeys.ts) mirrors auth.mfa.verify's promote path.
    if ((action === "auth.login" || action === "auth.mfa.verify" || action === "auth.mfa.enroll.enable" || action === "auth.passkey.login.finish") && (data as any)?.token) {
      // Hardened session cookie (see auth.ts: sessionCookieStr) — survives
      // cross-site/embedded preview contexts. Over plain HTTP the Secure/
      // Partitioned attributes are dropped (browsers would reject the cookie
      // entirely) so LAN deployments keep working.
      res.headers.append("Set-Cookie", sessionCookieStr((data as any).token, isHttpsReq(req)))
    }
    if (action === "auth.logout") {
      res.headers.append("Set-Cookie", clearCookieStr(isHttpsReq(req)))
    }
    // Wave 10 — the support-session exit clears the THIRD plane's cookie
    // (same dispatcher-owned Set-Cookie discipline as auth.logout above).
    if (action === "auth.supportExit" && (data as any)?.supportExited) {
      res.headers.append("Set-Cookie", supportClearCookieStr(isHttpsReq(req)))
    }
    return res
  } catch (e: any) {
    failed = true
    const mapped = clientError(e, action)
    if (e instanceof Deny) {
      return NextResponse.json({ ok: false, error: mapped.message, code: mapped.code }, { status: mapped.code || 403 })
    }
    return NextResponse.json({ ok: false, error: mapped.message, code: mapped.code }, { status: mapped.code || 500 })
  } finally {
    observeRpc(action, Date.now() - t0, !failed)
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, data: { service: "Finix HR HRM", version: "1.0.0" } })
}
