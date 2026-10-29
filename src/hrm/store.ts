"use client"
// ============ Global SPA store (zustand) ============
import { create } from "zustand"
import { rpc, setMemoryBearer, saveCsrfToken, purgeLegacyWebStorage } from "./api"

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
   *  ESS quick actions and module visibility visually reverted until reload). */
  saveSettingsGroup: (group: string, values: Record<string, unknown>) => Promise<any>
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

  init: async () => {
    try {
      const data = await rpc("auth.me")
      const role = data.user.role
      let initialView: NavTarget = { key: role === "EMPLOYEE" ? "ess" : "dashboard" }
      let initialToast: { text: string; kind: "ok" | "err" } | null = null

      if (typeof window !== "undefined") {
        const search = new URLSearchParams(window.location.search)
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
        authLoading: false,
        view: initialView,
        toastMsg: initialToast,
      })
      get().refreshUnread()
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
      view: { key: data.user.role === "EMPLOYEE" ? "ess" : "dashboard" },
    })
    get().refreshUnread()
  },

  logout: async () => {
    try { await rpc("auth.logout") } catch { /* ignore */ }
    // H-08 — drop the memory bearer + CSRF and scrub any legacy localStorage
    // values so nothing survives the session on this device.
    setMemoryBearer(null)
    saveCsrfToken(null)
    purgeLegacyWebStorage()
    // M-15 — FULL reset: settings (vendor localization etc.) must not leak
    // into the next login's UI, and the cached date format goes too.
    try { localStorage.removeItem("hrm_date_format") } catch { /* private mode */ }
    set({ user: null, vendor: null, settings: null, subscription: null, view: { key: "dashboard" }, unread: 0, authLoading: false, supportSession: null })
  },

  exitSupport: async () => {
    try { await rpc("auth.supportExit") } catch { /* the cookie clears server-side on success; a failure still re-bootstraps */ }
    // the support plane has no login of its own — re-bootstrap: with the
    // cookie cleared auth.me resolves nothing and the login screen shows.
    await get().init()
  },

  navigate: (key, params) => set({ view: { key, params } }),

  can: (module, action) => {
    const u = get().user
    if (!u) return false
    if (u.role === "EMPLOYEE") {
      // employees: self-service only
      return (module === "ess" || module === "calendar" || module === "notifications" || module === "announcements") && (action === "view" || (module === "ess" && ["create", "edit", "download"].includes(action)))
    }
    return u.permissions.includes(`${module}.${action}`)
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
  saveSettingsGroup: async (group, values) => {
    const data = await rpc<any>("settings.save", { group, values })
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
