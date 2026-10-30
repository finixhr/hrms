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
import { rpc, saveToken, clearToken, ApiError } from "./api";
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
  setUser: (user: AuthUser, token: string) => void;
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
  clearError: () => set({ error: null }),
}));
