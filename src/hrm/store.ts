"use client"
// ============ Global SPA store (zustand) ============
import { create } from "zustand"
import { rpc, setMemoryBearer, saveCsrfToken, purgeLegacyWebStorage, setLookupScopeProvider, clearLookupCache } from "./api"
import { applyCompanyTitle } from "./i18n"

/** FIN-030 (Phase 3) — publish the active-company context. The audit found the
 *  desktop shell (and any embedding surface) had ZERO multi-company context:
 *  switching companies left the tab title and the shell with no indication of
 *  whose books are open. The store now announces every company-context change
 *  in TWO observer-friendly channels:
 *    · a `finix:company-switched` DOM CustomEvent carrying
 *      { companyId, companyName, allCompaniesMode } — the integration contract
 *      for embedding shells (the Tauri desktop window mirrors it into its
 *      title bar) and for the FIN-030 desktop smoke spec;
 *    · the document title gains the active company segment via
 *      applyCompanyTitle() — visible in every shell (browser tab, PWA,
 *      desktop webview) without any bridge.
 *  Called at the end of init/adoptSession/switchCompany and on logout. Pure
 *  DOM side effects, never fatal (SSR/private-mode safe). */
function publishCompanyContext(s: Pick<HrmState, "companies" | "activeCompanyId" | "allCompaniesMode">) {
  if (typeof window === "undefined") return
  const active = s.companies.find((c) => c.companyId === s.activeCompanyId) || null
  const companyName = s.allCompaniesMode ? "All Companies" : active?.name || null
  try {
    applyCompanyTitle(companyName)
    window.dispatchEvent(new CustomEvent("finix:company-switched", {
      detail: { companyId: s.activeCompanyId ?? null, companyName, allCompaniesMode: s.allCompaniesMode === true },
    }))
  } catch { /* SSR / private mode — best-effort context, never fatal */ }
}

/** FORENSIC AUDIT 2026-11-10, FIN-004 (Phase 1) — the view remount key.
 *  switchCompany deliberately keeps the user on the SAME view, and the old
 *  app-shell key (view+params only) let React REUSE the mounted instance
 *  with Company A's data still on screen under Company B. The key now carries
 *  the ACTIVE COMPANY so every mounted view remounts (fresh hooks, fresh
 *  queries) on every switch — including to/from All Companies mode. Pure on
 *  purpose: unit-testable without React. */
export function viewRemountKey(
  view: { key: string; params?: unknown },
  activeCompanyId: string | null,
  allCompaniesMode: boolean,
): string {
  return `${view.key}:${JSON.stringify(view.params || {})}@${activeCompanyId ?? "all"}${allCompaniesMode ? ":all-mode" : ""}`
}

export type SessionUser = {
  id: string
  name: string
  email?: string
  role: string
  roleLabel: string
  employeeId?: string | null
  branchId?: string | null
  departmentId?: string | null
  /** R2 — the linked employee's photo (data URL); shown as this user's avatar. */
  employeePhotoUrl?: string | null
  permissions: string[]
}

export type NavTarget = { key: string; params?: Record<string, unknown> }

interface HrmState {
  user: SessionUser | null
  vendor: { id: string; name: string; code: string; logoUrl?: string | null } | null
  settings: any | null
  /** SaaS layer — server-resolved subscription snapshot (auth.me/login payload).
 *  null = layer unavailable; mode "LEGACY" = tenant predates the SaaS layer
 *  (no limits, all modules). Used by the shell to hide gated modules. */
  subscription: {
    mode: "SUBSCRIBED" | "LEGACY"
    status: string
    planName: string | null
    billingCycle: string | null
    endDate: string | null
    daysRemaining: number | null
    readonly: boolean
    locked?: boolean
    features: Record<string, boolean> | null
    limits: Record<string, number | null> | null
    /** Per-tenant module overrides (moduleKey → forced on/off) set from the
     *  SaaS Owner Console. Mirrors server-side featureBlocked() precedence:
     *  an explicit override beats the plan feature flag for ANY module. */
    overrides?: Record<string, boolean> | null
    usage?: any
  } | null
  authLoading: boolean
  view: NavTarget
  unread: number
  toastMsg: { text: string; kind: "ok" | "err" } | null
  /** Wave 10 (2026-10-24) — facts of the live Time-Limited Support session
   *  (third plane), when this workspace was opened through a support link.
   *  Drives the persistent SUPPORT ACCESS banner + auth.supportExit. Null on
   *  normal tenant sessions. */
  supportSession: {
    id: string
    tenantName: string
    operatorName: string
    accessMode: "READ_ONLY" | "CONTROLLED_WRITE"
    expiresAt: string
  } | null
  /** MULTI-COMPANY (2026-11-03) — the session's accessible companies and the
   *  server-validated ACTIVE company (auth.me/login payload; switching goes
   *  through companies.activate and re-bootstraps so company data, settings
   *  and permissions all refresh — never client-only state). */
  companies: { companyId: string; code: string; name: string; role: string; isDefault: boolean }[]
  activeCompanyId: string | null
  /** TRUE while the session operates in the All Companies consolidated
   *  REPORTING context (read-only; requires the companies.consolidated
   *  permission, re-validated server-side on every request). */
  allCompaniesMode: boolean
  /** Switch the session's active company (server-validated + audited).
   *  Pass null to enter the All Companies consolidated reporting context
   *  (authorized users only — the server enforces the permission). */
  switchCompany: (companyId: string | null) => Promise<void>
  init: () => Promise<void>
  login: (email: string, password: string) => Promise<void>
  /** Adopt a fully-formed session payload (token + user + vendor + settings).
   * Used by the normal login flow AND the MFA verify step (HRM-006) so both
   * store the token through the exact same code path. */
  adoptSession: (data: { token: string; user: SessionUser; vendor?: any; settings?: any; subscription?: any }) => void
  logout: () => Promise<void>
  /** Wave 10 — end the support session from the banner (auth.supportExit);
   *  the server clears the cookie + ends the row (audited), then the SPA
   *  re-bootstraps to the login screen. */
  exitSupport: () => Promise<void>
  navigate: (key: string, params?: Record<string, unknown>) => void
  can: (module: string, action: string) => boolean
  refreshUnread: () => Promise<void>
  toast: (text: string, kind?: "ok" | "err") => void
  /** H-12 — save a settings group through the API and merge the response
   *  back into the store in one shared code path. Every settings.save caller
   *  must use this instead of a bare rpc() so the persisted state is also the
   *  VISIBLE state (the old bare calls left the store stale — payout toggles,
   *  ESS quick actions and module visibility visually reverted until reload).
   *  `action` (BC-FIX): domain-scoped save routes (e.g. bonuses.savePolicy for
   *  the bonusPolicy group) ride the SAME merge-back path while keeping their
   *  own permission gate. */
  saveSettingsGroup: (group: string, values: Record<string, unknown>, action?: string) => Promise<any>
}

export const useHrm = create<HrmState>((set, get) => ({
  user: null,
  vendor: null,
  settings: null,
  subscription: null,
  authLoading: true,
  view: { key: "dashboard" },
  unread: 0,
  toastMsg: null,
  supportSession: null,
  companies: [],
  activeCompanyId: null,
  allCompaniesMode: false,

  init: async () => {
    try {
      const data = await rpc("auth.me")
      const role = data.user.role
      let initialView: NavTarget = { key: role === "EMPLOYEE" ? "ess" : "dashboard" }
      let initialToast: { text: string; kind: "ok" | "err" } | null = null

      if (typeof window !== "undefined") {
        const search = new URLSearchParams(window.location.search)
        // FIN-007 (Phase 1) — module deep links: the mobile launcher and push
        // notifications open `${base}/app?view=<key>`; the shell resolves the
        // key to the initial view after auth. Unknown keys fall back to the
        // role default (the app-shell renders VIEWS[view.key] || dashboard),
        // so a stale link can never 404 — the SPA has exactly one route.
        // Employees are always pinned to self-service regardless of the link.
        const viewParam = search.get("view")
        if (viewParam && /^[a-z0-9-]{1,32}$/i.test(viewParam) && role !== "EMPLOYEE") {
          initialView = { key: viewParam }
        }
        const billingParam = search.get("billing")
        if (billingParam) {
          if (billingParam === "paid") {
            initialToast = { text: "Payment completed successfully! Your subscription is active.", kind: "ok" }
            if (role !== "EMPLOYEE") initialView = { key: "billing", params: { tab: "overview" } }
          } else if (billingParam === "failed") {
            initialToast = { text: "Payment could not be completed. Please check your payment history or try again.", kind: "err" }
            if (role !== "EMPLOYEE") initialView = { key: "billing", params: { tab: "payments" } }
          } else if (billingParam === "pending") {
            initialToast = { text: "Payment verification is pending from the gateway. Please refresh in a moment.", kind: "ok" }
            if (role !== "EMPLOYEE") initialView = { key: "billing", params: { tab: "payments" } }
          } else if (billingParam === "cancelled") {
            initialToast = { text: "Payment checkout was cancelled.", kind: "err" }
            if (role !== "EMPLOYEE") initialView = { key: "billing", params: { tab: "overview" } }
          }
          try {
            const cleanUrl = window.location.pathname + (window.location.hash || "")
            window.history.replaceState({}, document.title, cleanUrl)
          } catch { /* ignore */ }
        } else if ((data.subscription?.status === "PENDING_PAYMENT" || data.subscription?.locked) && role !== "EMPLOYEE") {
          initialView = { key: "billing", params: { tab: "overview" } }
        }
      }

      set({
        user: data.user,
        vendor: data.vendor,
        settings: data.settings,
        subscription: data.subscription ?? null,
        supportSession: (data as any).supportSession ?? null,
        companies: (data as any).company?.companies ?? [],
        activeCompanyId: (data as any).company?.activeCompanyId ?? null,
        allCompaniesMode: (data as any).company?.allCompaniesMode === true,
        authLoading: false,
        view: initialView,
        toastMsg: initialToast,
      })
      get().refreshUnread()
      // FIN-030 — announce the company context this session booted with
      publishCompanyContext(get())
    } catch {
      // no valid session (cookie rejected/expired) — H-08: clear ALL auth
      // residue: memory bearer + CSRF, plus legacy localStorage values.
      setMemoryBearer(null)
      saveCsrfToken(null)
      purgeLegacyWebStorage()
      set({ user: null, vendor: null, authLoading: false, supportSession: null })
    }
  },

  login: async (email, password) => {
    const data = await rpc("auth.login", { email, password })
    // MFA-required and password-expired responses carry no token — the login
    // view handles those steps itself and finishes via adoptSession().
    if (!data || !data.token) {
      throw new Error("Additional verification is required to complete sign-in")
    }
    get().adoptSession(data)
  },

  adoptSession: (data) => {
    // H-08 — the token lives ONLY in memory (5-minute TTL fallback for
    // cookie-blocked embedded contexts). It is NEVER written to localStorage;
    // the httpOnly cookie is the sole persistent transport. Any legacy
    // localStorage values are scrubbed.
    setMemoryBearer(data.token || null)
    saveCsrfToken((data as any).csrfToken)
    purgeLegacyWebStorage()
    set({
      user: data.user, vendor: data.vendor || null, settings: data.settings || null,
      subscription: (data as any).subscription ?? null,
      supportSession: (data as any).supportSession ?? null,
      companies: (data as any).company?.companies ?? [],
      activeCompanyId: (data as any).company?.activeCompanyId ?? null,
      allCompaniesMode: (data as any).company?.allCompaniesMode === true,
      view: { key: data.user.role === "EMPLOYEE" ? "ess" : "dashboard" },
    })
    get().refreshUnread()
    // FIN-030 — a fresh sign-in lands with its company context
    publishCompanyContext(get())
  },

  logout: async () => {
    try { await rpc("auth.logout") } catch { /* ignore */ }
    // H-08 — drop the memory bearer + CSRF and scrub any legacy localStorage
    // values so nothing survives the session on this device.
    setMemoryBearer(null)
    saveCsrfToken(null)
    purgeLegacyWebStorage()
    // FIN-014 (Phase 1) — the lookup caches die with the session: a different
    // user logging in on the same tab must never replay the previous
    // session's company-scoped directories.
    clearLookupCache()
    // M-15 — FULL reset: settings (vendor localization etc.) must not leak
    // into the next login's UI, and the cached date format goes too.
    try { localStorage.removeItem("hrm_date_format") } catch { /* private mode */ }
    set({ user: null, vendor: null, settings: null, subscription: null, view: { key: "dashboard" }, unread: 0, authLoading: false, supportSession: null, companies: [], activeCompanyId: null, allCompaniesMode: false })
    // FIN-030 — the workspace is closed: clear the title's company segment and
    // publish the empty context (the desktop title bar returns to the base)
    publishCompanyContext(get())
  },

  exitSupport: async () => {
    try { await rpc("auth.supportExit") } catch { /* the cookie clears server-side on success; a failure still re-bootstraps */ }
    // the support plane has no login of its own — re-bootstrap: with the
    // cookie cleared auth.me resolves nothing and the login screen shows.
    await get().init()
  },

  // MULTI-COMPANY — switch the ACTIVE company. The server validates access
  //  (companies.activate writes Session.activeCompanyId, audited) and the
  //  store re-bootstraps through init(): fresh auth.me returns the new
  //  company's settings + permissions, every view REMOUNTS with the new
  //  context (the app-shell remount key carries the company — FIN-004), and
  //  the shared lookup caches are company-keyed and cleared on every switch
  //  (FIN-014) — no stale data from the previous company can survive.
  switchCompany: async (companyId) => {
    try {
      await rpc("companies.activate", companyId ? { companyId } : { allCompanies: true })
    } catch (e: any) {
      get().toast(String(e?.message || "Could not switch company"), "err")
      return
    }
    // FIN-014 (Phase 1) — drop every cached lookup BEFORE the re-bootstrap so
    // pickers mounted under the new company refetch instead of replaying the
    // old company's directory (belt and braces: the cache keys are scoped too).
    clearLookupCache()
    const prev = get().view
    await get().init()
    // keep the user on their current view when it still applies; ESS users
    // stay in self-service
    const s = get()
    if (s.user && s.user.role !== "EMPLOYEE" && prev.key !== "login") {
      useHrm.setState({ view: prev })
    }
    get().toast(companyId ? "Switched company — workspace refreshed" : "All Companies view — read-only consolidated reporting", "ok")
    // FIN-030 — announce the new company context (event + title segment)
    publishCompanyContext(get())
  },

  navigate: (key, params) => set({ view: { key, params } }),

  can: (module, action) => {
    const u = get().user
    if (!u) return false
    if (u.role === "EMPLOYEE") {
      // employees: self-service only
      return (module === "ess" || module === "calendar" || module === "notifications" || module === "announcements") && (action === "view" || (module === "ess" && ["create", "edit", "download"].includes(action)))
    }
    // FORENSIC AUDIT 2026-11-10 (Phase 1, discovered by the FIN-004 e2e lane):
    // the server's can() (rbac.ts) has ALWAYS honored the "*" wildcard — the
    // client mirror here matched only literal "module.action" strings, so a
    // wildcard-permission user (e.g. the e2e bootstrap owner) passed every
    // SERVER check while the SPA rendered them a nearly empty navigation.
    // The two can()s share one semantic now (the codebase's own
    // "one implementation, no drift" discipline — cf. R-03's scope-filter
    // reunification).
    return u.permissions.includes("*") || u.permissions.includes(`${module}.${action}`)
  },

  refreshUnread: async () => {
    try {
      const d = await rpc("notifications.unreadCount")
      set({ unread: d.count })
    } catch { /* ignore */ }
  },

  toast: (text, kind = "ok") => set({ toastMsg: { text, kind } }),

  // H-12 — one shared save path: rpc + store merge-back. settings.save returns
  // the FULL settings object (getSettings); merging it refreshes payout
  // toggles, ESS portal visibility, module visibility and localization in
  // every live consumer without a reload.
  saveSettingsGroup: async (group, values, action) => {
    const data = await rpc<any>(action || "settings.save", { group, values })
    set({ settings: { ...(get().settings || {}), ...data } })
    return data
  },
}))

// Session-loss recovery: when any RPC call comes back 401 mid-session (cookie
// rejected by an embedded context, session deleted/expired server-side), return
// the user to the login screen with a clear message instead of leaving every
// view stuck on a raw "Authentication required" error banner.
if (typeof window !== "undefined") {
  window.addEventListener("hrm:unauthorized", () => {
    const s = useHrm.getState()
    if (s.user) {
      s.toast("Your session has ended — please sign in again.", "err")
      useHrm.setState({ user: null, vendor: null, view: { key: "dashboard" }, unread: 0, authLoading: false })
    }
    // H-08 — memory tokens were already cleared by rpc(); scrub legacy
    // localStorage values here too so nothing survives on this device.
    setMemoryBearer(null)
    saveCsrfToken(null)
    purgeLegacyWebStorage()
    // M-15 — full store reset including settings + cached date format
    try { localStorage.removeItem("hrm_date_format") } catch { /* private mode */ }
    useHrm.setState({ user: null, vendor: null, settings: null, subscription: null, view: { key: "dashboard" }, unread: 0, authLoading: false })
  })

  // H-08 — silent refresh on tab focus: re-runs the cookie-authenticated
  // auth.me round-trip which re-mints the memory CSRF token and re-arms the
  // 5-minute memory bearer window for embedded contexts. Never persists.
  window.addEventListener("focus", () => {
    const s = useHrm.getState()
    if (s.user && !s.authLoading) {
      rpc("auth.me").then((data: any) => {
        if (data?.csrfToken) saveCsrfToken(data.csrfToken)
      }).catch(() => { /* session gone — the 401 path handles it */ })
    }
  })
}

// FORENSIC AUDIT 2026-11-10, FIN-014 (Phase 1) — the shared lookup caches
// (api.ts useLookup/useEmployeeDirectory) are keyed by the ACTIVE COMPANY.
// The store owns that context, so it registers itself as the scope provider
// (api.ts deliberately never imports the store — the import graph stays
// acyclic). Return values: the active company id, "ALL-COMPANIES" in the
// consolidated mode, or null while the session's company context is still
// unresolved (boot/login) — null disables caching entirely.
setLookupScopeProvider(() => {
  const s = useHrm.getState()
  return s.activeCompanyId ?? (s.allCompaniesMode ? "ALL-COMPANIES" : null)
})
