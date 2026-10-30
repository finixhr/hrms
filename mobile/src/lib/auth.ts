// Auth state — Zustand store with persist via expo-secure-store
<<<<<<< HEAD
// Handles login, MFA, logout and token management.
//
// CONTRACT (src/hrm-server/routes/auth.ts + src/hrm-server/auth.ts):
//   auth.login { email, password }
//     → { token, id, user, vendor, mfaEnrollSuggested }                      (plain login)
//     → { token: null, user, vendor, mfaRequired: true, mfaToken }           (MFA challenge)
//     → { token: null, user, vendor, mfaEnrollmentRequired: true, enrollToken } (forced enrollment)
//   auth.mfa.verify { mfaToken, code } → { token, user, vendor }
//   auth.me {} → { user: { id, name, email, role, roleLabel, employeeId,
//                          permissions[], ... }, vendor, csrfToken, ... }

import { create } from "zustand";
import { rpc, saveToken, clearToken, ApiError } from "./api";
import { unregisterPushNotifications } from "./push";
=======
// Handles login, MFA, logout and token management

import { create } from "zustand";
import { rpc, saveToken, clearToken, ApiError } from "./api";
>>>>>>> origin/main

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: string;
<<<<<<< HEAD
  roleLabel?: string;
  employeeId?: string | null;
  vendorId?: string;
  permissions?: string[];
=======
  vendorId: string;
>>>>>>> origin/main
}

interface AuthState {
  user: AuthUser | null;
  token: string | null;
  mfaPending: boolean;
<<<<<<< HEAD
  mfaToken: string | null;
  mfaEnrollmentRequired: boolean;
=======
  mfaTempToken: string | null;
>>>>>>> origin/main
  isLoading: boolean;
  error: string | null;

  login: (email: string, password: string) => Promise<{ mfaRequired: boolean }>;
  verifyMfa: (code: string) => Promise<void>;
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
<<<<<<< HEAD
  mfaToken: null,
  mfaEnrollmentRequired: false,
=======
  mfaTempToken: null,
>>>>>>> origin/main
  isLoading: false,
  error: null,

  login: async (email, password) => {
<<<<<<< HEAD
    set({ isLoading: true, error: null, mfaEnrollmentRequired: false });
    try {
      const res = await rpc<{
        token?: string | null;
        mfaRequired?: boolean;
        mfaToken?: string;
        mfaEnrollmentRequired?: boolean;
        user?: AuthUser;
      }>("auth.login", { email, password }, { skipAuth: true });

      // Forced first-login MFA enrollment (unenrolled user on an MFA-required
      // role — VENDOR_OWNER / HR_ADMIN default). The enrollment wizard is not
      // implemented natively yet: block honestly and direct to the web portal.
      if (res.mfaEnrollmentRequired) {
        set({
          mfaPending: false,
          mfaToken: null,
          mfaEnrollmentRequired: true,
          isLoading: false,
          error:
            "Multi-factor authentication setup is required for your account before signing in. " +
            "Please complete the one-time setup in the Finix HR web portal, then sign in again.",
        });
        return { mfaRequired: false };
      }

      // MFA challenge — the server field is `mfaToken` (short-lived PREAUTH
      // session carrier; expires after 5 minutes).
      if (res.mfaRequired && res.mfaToken) {
        set({ mfaPending: true, mfaToken: res.mfaToken, isLoading: false });
=======
    set({ isLoading: true, error: null });
    try {
      const res = await rpc<{
        token?: string;
        mfaRequired?: boolean;
        tempToken?: string;
        user?: AuthUser;
      }>("auth.login", { email, password }, { skipAuth: true });

      if (res.mfaRequired && res.tempToken) {
        set({ mfaPending: true, mfaTempToken: res.tempToken, isLoading: false });
>>>>>>> origin/main
        return { mfaRequired: true };
      }

      if (res.token && res.user) {
        await saveToken(res.token);
        set({ user: res.user, token: res.token, isLoading: false });
        return { mfaRequired: false };
      }

      throw new Error("Unexpected login response");
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Login failed";
      set({ isLoading: false, error: msg });
      throw err;
    }
  },

  verifyMfa: async (code) => {
<<<<<<< HEAD
    const { mfaToken } = get();
    if (!mfaToken) throw new Error("No MFA session");
    set({ isLoading: true, error: null });
    try {
      // The server reads { mfaToken, code, useRecovery } — NOT { token }.
      const res = await rpc<{ token: string; user: AuthUser }>(
        "auth.mfa.verify",
        { mfaToken, code },
=======
    const { mfaTempToken } = get();
    if (!mfaTempToken) throw new Error("No MFA session");
    set({ isLoading: true, error: null });
    try {
      const res = await rpc<{ token: string; user: AuthUser }>(
        "auth.mfa.verify",
        { token: mfaTempToken, code },
>>>>>>> origin/main
        { skipAuth: true },
      );
      await saveToken(res.token);
      set({
        user: res.user,
        token: res.token,
        mfaPending: false,
<<<<<<< HEAD
        mfaToken: null,
=======
        mfaTempToken: null,
>>>>>>> origin/main
        isLoading: false,
      });
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "MFA verification failed";
      set({ isLoading: false, error: msg });
      throw err;
    }
  },

  logout: async () => {
    set({ isLoading: true });
    try {
<<<<<<< HEAD
      // Best-effort: unregister the push token before clearing auth. Sends the
      // REQUIRED { token } field (was: empty payload → always 400 → swallowed).
      await unregisterPushNotifications().catch(() => null);
=======
      // Best-effort: unregister push token before clearing auth
      await rpc("push.unregisterDevice", {}).catch(() => null);
>>>>>>> origin/main
    } finally {
      await clearToken();
      set({
        user: null,
        token: null,
        mfaPending: false,
<<<<<<< HEAD
        mfaToken: null,
        mfaEnrollmentRequired: false,
=======
        mfaTempToken: null,
>>>>>>> origin/main
        isLoading: false,
        error: null,
      });
    }
  },

  setUser: (user, token) => set({ user, token }),
  clearError: () => set({ error: null }),
}));
