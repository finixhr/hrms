// API client for Finix HR mobile app
// All requests go to POST /api/hrm with { action, payload }
// Bearer token stored in expo-secure-store

import * as SecureStore from "expo-secure-store";
import Constants from "expo-constants";

const TOKEN_KEY = "finixhr_auth_token";

export function getBaseUrl(): string {
  // EXPO_PUBLIC_ prefix exposes env var to client bundle
  if (process.env.EXPO_PUBLIC_API_BASE_URL) {
    return process.env.EXPO_PUBLIC_API_BASE_URL;
  }
  // Fallback to app.json extra
  const extra = Constants.expoConfig?.extra as { apiBaseUrl?: string } | undefined;
  return extra?.apiBaseUrl ?? "http://localhost:4055";
}

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

export async function saveToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function getToken(): Promise<string | null> {
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export async function clearToken(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}

// ---------------------------------------------------------------------------
// Core RPC caller
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function rpc<T = unknown>(
  action: string,
  payload?: unknown,
  opts?: { skipAuth?: boolean },
): Promise<T> {
  const base = getBaseUrl();
  const token = opts?.skipAuth ? null : await getToken();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // Custom header exempts native requests from CSRF checks on the server
    "X-Requested-With": "XMLHttpRequest",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${base}/api/hrm`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action, payload }),
  });

  if (res.status === 401) {
    // Clear stale token and force re-login
    await clearToken();
    throw new ApiError("UNAUTHORIZED", "Session expired. Please log in again.", 401);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ApiError("PARSE_ERROR", "Invalid server response", res.status);
  }

  if (!res.ok) {
    const b = body as { error?: string; message?: string };
    throw new ApiError(
      b?.error ?? "SERVER_ERROR",
      b?.message ?? `Request failed (${res.status})`,
      res.status,
    );
  }

  return body as T;
}
