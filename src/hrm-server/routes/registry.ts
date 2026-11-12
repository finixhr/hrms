// ============ Route registry: action → handler + permission + zod schema ============
// Every action is enforced server-side: session → tenant → permission → scope
// → (M-01) payload schema validation BEFORE the handler runs.
import type { Ctx } from "../types"
import type { ZodType } from "zod"
import { loggerFor } from "@/hrm-server/log"
const log = loggerFor("routes:registry")

export type Handler = (ctx: Ctx, payload: any, req?: Request) => Promise<unknown>
export type RouteDef = {
  perm?: [string, string]
  /** RBAC-105 (re-audit 2026-10-18 repair) — ALTERNATIVE permission the
   *  dispatcher accepts INSTEAD of `perm`. Use only when an action is
   *  deliberately dual-verb (e.g. employees.changeShift accepts
   *  employees.assign OR employees.edit, so tenants can delegate roster
   *  assignment without profile-edit rights). The FIRST verb (`perm`)
   *  remains the one the registry lints, the mutating/read-only-lockout
   *  classifier and the UI affordances read — keep it the stronger/
   *  canonical verb. `altPerm` only widens the dispatcher gate; handlers
   *  keep their own in-handler checks for defense in depth. */
  altPerm?: [string, string]
  handler: Handler
  public?: boolean
  /** M-01 — Zod schema for the payload. When present, the dispatcher
   *  validates the payload and passes the TYPED, STRIPPED object to the
   *  handler. Fields not in the schema are dropped (whitelist behavior). */
  schema?: ZodType<any, any>
  /** SUB-002 (re-ported R3-2) — explicit read-only-lockout classification.
   *  EXPIRED / SUSPENDED / CANCELLED tenants are locked read-only by the
   *  dispatcher. The default classification is deny-by-default (an action is
   *  mutating unless its head is in the dispatcher's READ_HEADS allowlist,
   *  its perm verb is view/export/download, or its prefix is exempt).
   *  Set this flag only to OVERRIDE that heuristic:
   *    mutating: true  → always treated as a mutation (belt-and-braces)
   *    mutating: false → a pure read that stays available while locked out */
  mutating?: boolean
}

export const routes: Record<string, RouteDef> = {}

// ============ R-01 (W1) — registry collision guard ============
// SEC-06 found that `routes[action] = def` silently OVERWRITES: the
// company-scoped `shifts.*` CRUD-macro registrations (organization.ts:162)
// were shadowed by the later legacy vendor-scoped handlers (:321-392), and
// nothing ever complained. From W1 the registry refuses silent shadowing:
// registering an action name that already carries a DIFFERENT definition
// throws at module-load time (fail-closed — a broken module graph must
// never boot silently).
//
// The four audited SEC-06 shadow registrations were a NAMED, load-time-logged
// exemption while their removal was planned as W4/R-16.
// AUDIT L-2 (2026-11-07) — W4/R-16 landed: the dead CRUD-macro `shifts.*`
// registrations were deleted from organization.ts (the explicit company-
// scoped handlers there are the ONLY shifts.* registration) and the
// exemption list below is EMPTY — no boot warning fires and any NEW
// collision is fatal again. The mechanism + loud warning stay armed for
// future drift; entries may only be re-added with an audit-trail comment.
export const KNOWN_SHADOW_REGISTRATIONS: ReadonlySet<string> = new Set([])

export function route(action: string, def: RouteDef) {
  const existing = routes[action]
  if (existing !== undefined && existing !== def) {
    if (process.env.NODE_ENV !== "production") {
      // In development mode (Next.js HMR / Fast Refresh), editing a route file
      // re-evaluates the module in-process with a new definition object reference.
      routes[action] = def
      return
    }
    if (KNOWN_SHADOW_REGISTRATIONS.has(action)) {
      // Audited shadow — loud, not fatal: the later registration wins, but
      // the collision is on record at every boot until the exemption entry
      // is removed. AUDIT L-2 (2026-11-07) — the list has been EMPTY since
      // the last SEC-06/W4-R-16 shadows were deleted; any NEW entry must
      // carry its own audit trail and removal plan.
      log.warn(
        `[registry] SHADOW registration (exempt): "${action}" is re-registered with a different definition — the previous definition is OVERWRITTEN. Remove this shadowing or drop the exemption entry.`,
      )
    } else {
      throw new Error(
        `[registry] collision: action "${action}" is already registered with a different definition (R-01 guard; silent shadowing is not allowed)`,
      )
    }
  }
  routes[action] = def
}

// T-20 (2026-10-31) — alias → canonical map. Every entry is a DEPRECATED
// flat name's prefixed twin (see API_CONTRACT_AUDIT.md §5.1): the canonical
// registration stays the flat name (the web SPA's live call sites), the
// alias gives new consumers the module-prefixed spelling that matches every
// other route family (`attendance.*`, `leaveRequests.*`, …). Aliases share
// the canonical's RouteDef OBJECT — same handler, perm, schema and lockout
// classification — so the two spellings can never drift apart.
export const routeAliases: Record<string, string> = {}

/** Register `action` as a prefixed alias of the already-registered
 * `target` (e.g. alias("performance.reviews.list", "reviews.list")).
 * Loud failures: an unknown target or a colliding action name throws at
 * module-load time — a broken alias must never boot silently. */
export function alias(action: string, target: string) {
  const def = routes[target]
  if (!def) throw new Error(`[registry] alias target not registered: "${target}" (for alias "${action}")`)
  if (Object.prototype.hasOwnProperty.call(routes, action) && routes[action] !== def) {
    if (process.env.NODE_ENV !== "production") {
      routes[action] = def
      routeAliases[action] = target
      return
    }
    throw new Error(`[registry] alias collision: "${action}" is already registered with a different definition`)
  }
  routes[action] = def
  routeAliases[action] = target
}

export function getRoute(action: string): RouteDef | undefined {
  return routes[action]
}

/** True when `action` is a deprecated-alias spelling (the flat canonical
 * name keeps working — removal would need its own coordinated migration). */
export function isRouteAlias(action: string): boolean {
  return Object.prototype.hasOwnProperty.call(routeAliases, action)
}
