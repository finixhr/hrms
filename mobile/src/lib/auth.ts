// Auth state — Zustand store with persist via expo-secure-store
// Handles login, MFA, first-login MFA enrollment, logout and token management.
//
// CONTRACT (src/hrm-server/routes/auth.ts + src/hrm-server/auth.ts):
//   auth.login { email, password }
//     → { token, id, user, vendor, mfaEnrollSuggested }                      (plain login)
//     → { token: null, user, vendor, mfaRequired: true, mfaToken }           (MFA challenge)
//     → { token: null, user, vendor, mfaEnrollmentRequired: true, enrollToken } (forced enrollment)
//   auth.mfa.verify { mfaToken, code } → { token, user, vendor }
//   auth.mfa.enroll.start { enrollToken } → { secret, qrDataUrl, uri }        (T-14)
//   auth.mfa.enroll.enable { enrollToken, code } → { token, user, recoveryCodes } (T-14 — codes shown exactly once)
//   auth.me {} → { user: { id, name, email, role, roleLabel, employeeId,
//                          permissions[], ... }, vendor, csrfToken, ... }

import { create } from "zustand";
import { rpc, saveToken, clearToken, ApiError, onUnauthorized } from "./api";
import { unregisterPushNotifications } from "./push";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: string;
  roleLabel?: string;
  employeeId?: string | null;
  vendorId?: string;
  permissions?: string[];
}

// MULTI-COMPANY (2026-11-03) — the session's company context. The ACTIVE
// company is server-validated on every request (Session.activeCompanyId +
// UserCompanyAccess); the app never sends a companyId for authorization —
// this is display/context state only. ESS users' company is fixed by their
// employment record (resolveActiveCompany server-side).
export interface CompanyContext {
  activeCompanyId: string | null;
  companies: { companyId: string; code: string; name: string; role: string; isDefault: boolean }[];
}

// The server's first-login enrollment response for auth.mfa.enroll.start.
// qrDataUrl is a 220px PNG data-URL rendered directly by <Image source={{uri}}>.
export interface MfaEnrollStartResult {
  secret: string;
  qrDataUrl: string;
  uri: string;
}

interface AuthState {
  user: AuthUser | null;
  token: string | null;
  mfaPending: boolean;
  mfaToken: string | null;
  mfaEnrollmentRequired: boolean;
  /** 15-minute PREAUTH capability issued after the password verified
   *  (auth.login → mfaEnrollmentRequired). Holds NO API rights (C-1); it only
   *  authorizes the enrollment exchange itself. */
  enrollToken: string | null;
  isLoading: boolean;
  error: string | null;

  login: (email: string, password: string) => Promise<{ mfaRequired: boolean; enrollmentRequired: boolean }>;
  verifyMfa: (code: string) => Promise<void>;
  /** T-14 — fetch the QR + TOTP secret for the pending enrollment. */
  startMfaEnrollment: () => Promise<MfaEnrollStartResult>;
  /** T-14 — verify the first code and finish enrollment. Returns the recovery
   *  codes: the server shows them EXACTLY once, so the caller must render them
   *  before finishing. */
  completeMfaEnrollment: (code: string) => Promise<string[]>;
  logout: () => Promise<void>;
  /** MOB-1 (2026-11-09 P1 wave) — full auth-state reset on session expiry
   *  (HTTP 401 seen by rpc()). Unlike logout() there is no server call to
   *  attempt (the session is already dead) and no push unregistration (that
   *  request would itself 401; the token re-registers on next login). */
  expireSession: () => void;
  setUser: (user: AuthUser, token: string) => void;
  /** MULTI-COMPANY — server-validated active company + accessible companies
   *  (auth payload `company`). Display/context only; authorization is always
   *  server-side. */
  company: CompanyContext | null;
  /** Switch the session's active company (server-validated via
   *  companies.activate; manager users only — ESS company is fixed by
   *  employment). After switching, callers should re-fetch their screens. */
  switchCompany: (companyId: string) => Promise<void>;
  setCompany: (company: CompanyContext | null) => void;
  clearError: () => void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useAuthStore = create<AuthState>()((set, get) => ({
  user: null,
  token: null,
  mfaPending: false,
  mfaToken: null,
  mfaEnrollmentRequired: false,
  enrollToken: null,
  isLoading: false,
  error: null,

  login: async (email, password) => {
    set({ isLoading: true, error: null, mfaEnrollmentRequired: false, enrollToken: null });
    try {
      const res = await rpc<{
        token?: string | null;
        mfaRequired?: boolean;
        mfaToken?: string;
        mfaEnrollmentRequired?: boolean;
        enrollToken?: string;
        user?: AuthUser;
      }>("auth.login", { email, password }, { skipAuth: true });

      // Forced first-login MFA enrollment (unenrolled user on an MFA-required
      // role — VENDOR_OWNER / HR_ADMIN default). T-14: instead of blocking, keep
      // the 15-minute enrollToken and hand the user to the native enrollment
      // wizard (app/(auth)/mfa-enroll). The token is a PREAUTH capability with
      // no API rights — losing it costs nothing but a re-login.
      if (res.mfaEnrollmentRequired && res.enrollToken) {
        set({
          mfaPending: false,
          mfaToken: null,
          mfaEnrollmentRequired: true,
          enrollToken: res.enrollToken,
          isLoading: false,
          error: null,
        });
        return { mfaRequired: false, enrollmentRequired: true };
      }

      // MFA challenge — the server field is `mfaToken` (short-lived PREAUTH
      // session carrier; expires after 5 minutes).
      if (res.mfaRequired && res.mfaToken) {
        set({ mfaPending: true, mfaToken: res.mfaToken, isLoading: false });
        return { mfaRequired: true, enrollmentRequired: false };
      }

      if (res.token && res.user) {
        await saveToken(res.token);
        set({ user: res.user, token: res.token, isLoading: false });
        return { mfaRequired: false, enrollmentRequired: false };
      }

      throw new Error("Unexpected login response");
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Login failed";
      set({ isLoading: false, error: msg });
      throw err;
    }
  },

  verifyMfa: async (code) => {
    const { mfaToken } = get();
    if (!mfaToken) throw new Error("No MFA session");
    set({ isLoading: true, error: null });
    try {
      // The server reads { mfaToken, code, useRecovery } — NOT { token }.
      const res = await rpc<{ token: string; user: AuthUser }>(
        "auth.mfa.verify",
        { mfaToken, code },
        { skipAuth: true },
      );
      await saveToken(res.token);
      set({
        user: res.user,
        token: res.token,
        mfaPending: false,
        mfaToken: null,
        isLoading: false,
      });
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "MFA verification failed";
      set({ isLoading: false, error: msg });
      throw err;
    }
  },

  startMfaEnrollment: async () => {
    const { enrollToken } = get();
    if (!enrollToken) throw new Error("No enrollment session — sign in again");
    set({ isLoading: true, error: null });
    try {
      // Server: auth.mfa.enroll.start { enrollToken } → { secret, qrDataUrl, uri }.
      // The QR is a 220px PNG data-URL — RN <Image> renders data URIs natively.
      const res = await rpc<MfaEnrollStartResult>(
        "auth.mfa.enroll.start",
        { enrollToken },
        { skipAuth: true },
      );
      set({ isLoading: false });
      return res;
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Could not start MFA enrollment";
      set({ isLoading: false, error: msg });
      throw err;
    }
  },

  completeMfaEnrollment: async (code) => {
    const { enrollToken } = get();
    if (!enrollToken) throw new Error("No enrollment session — sign in again");
    set({ isLoading: true, error: null });
    try {
      // Server: auth.mfa.enroll.enable { enrollToken, code } → full session +
      // recoveryCodes. No success is reported before this response arrives.
      const res = await rpc<{ token: string; user: AuthUser; recoveryCodes: string[] }>(
        "auth.mfa.enroll.enable",
        { enrollToken, code },
        { skipAuth: true },
      );
      await saveToken(res.token);
      set({
        user: res.user,
        token: res.token,
        mfaEnrollmentRequired: false,
        enrollToken: null,
        isLoading: false,
      });
      // Recovery codes are returned EXACTLY once — the wizard must show them.
      return res.recoveryCodes ?? [];
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "MFA enrollment failed";
      set({ isLoading: false, error: msg });
      throw err;
    }
  },

  logout: async () => {
    set({ isLoading: true });
    try {
      // Best-effort: unregister the push token before clearing auth. Sends the
      // REQUIRED { token } field (was: empty payload → always 400 → swallowed).
      await unregisterPushNotifications().catch(() => null);
    } finally {
      await clearToken();
      set({
        user: null,
        token: null,
        mfaPending: false,
        mfaToken: null,
        mfaEnrollmentRequired: false,
        enrollToken: null,
        isLoading: false,
        error: null,
      });
    }
  },

  setUser: (user, token) => set({ user, token }),
  expireSession: () => {
    // MOB-1 (2026-11-09 P1 wave) — reset EVERY auth field: user, token,
    // company context and all MFA scratch state. `user` flipping null is
    // what the guard in app/_layout.tsx watches — the app lands on
    // /(auth)/login immediately instead of looping per-call 401 errors with
    // a cleared token but a stale user object.
    set({
      user: null,
      token: null,
      company: null,
      mfaPending: false,
      mfaToken: null,
      mfaEnrollmentRequired: false,
      enrollToken: null,
      isLoading: false,
      error: null,
    });
    // Belt-and-braces: rpc() already cleared the secure store before
    // notifying, but a failed delete there must not leave a zombie token
    // that resurrects the dead session on the next cold start.
    clearToken().catch(() => {});
  },
  company: null,
  setCompany: (company) => set({ company }),
  switchCompany: async (companyId) => {
    await rpc("companies.activate", { companyId });
    // refresh the context from the server's own resolution
    const me = await rpc<{ user: AuthUser; company?: CompanyContext }>("auth.me", {});
    set({
      user: me.user ?? get().user,
      company: me.company ?? { activeCompanyId: companyId, companies: get().company?.companies ?? [] },
    });
  },
  clearError: () => set({ error: null }),
}));

// ---------------------------------------------------------------------------
// MOB-1 (2026-11-09 P1 wave) — session-expiry wiring (web precedent:
// src/hrm/store.ts listens for the "hrm:unauthorized" event dispatched by
// src/hrm/api.ts). api.ts cannot import this store (auth.ts → api.ts is
// already a dependency edge — importing back would be circular), so it
// exposes onUnauthorized() and we subscribe here at module scope: a 401
// anywhere in the app resets the whole auth state and the _layout.tsx guard
// routes to login. auth.ts is imported by the root layout, so the
// subscription is registered at app boot, before any rpc() can fire.
// ---------------------------------------------------------------------------

onUnauthorized(() => {
  const s = useAuthStore.getState();
  // Login-flow 401s (wrong password on auth.login, expired mfaToken) reach
  // this listener too — only tear down state when a session actually
  // existed, so the login form / MFA wizard keeps its scratch state.
  if (!s.user && !s.token) return;
  s.expireSession();
});
