// Auth state — Zustand store with persist via expo-secure-store
// Handles login, MFA, logout and token management

import { create } from "zustand";
import { rpc, saveToken, clearToken, ApiError } from "./api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: string;
  vendorId: string;
}

interface AuthState {
  user: AuthUser | null;
  token: string | null;
  mfaPending: boolean;
  mfaTempToken: string | null;
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
  mfaTempToken: null,
  isLoading: false,
  error: null,

  login: async (email, password) => {
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
    const { mfaTempToken } = get();
    if (!mfaTempToken) throw new Error("No MFA session");
    set({ isLoading: true, error: null });
    try {
      const res = await rpc<{ token: string; user: AuthUser }>(
        "auth.mfa.verify",
        { token: mfaTempToken, code },
        { skipAuth: true },
      );
      await saveToken(res.token);
      set({
        user: res.user,
        token: res.token,
        mfaPending: false,
        mfaTempToken: null,
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
      // Best-effort: unregister push token before clearing auth
      await rpc("push.unregisterDevice", {}).catch(() => null);
    } finally {
      await clearToken();
      set({
        user: null,
        token: null,
        mfaPending: false,
        mfaTempToken: null,
        isLoading: false,
        error: null,
      });
    }
  },

  setUser: (user, token) => set({ user, token }),
  clearError: () => set({ error: null }),
}));
