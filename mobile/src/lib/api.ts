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
  // FIN-021 (Phase 2, 2026-11-10) — fail-fast, never a silent plaintext
  // fallback: an unconfigured build used to quietly talk to
  // http://localhost:4055 (bearer tokens, PII and selfie uploads over plain
  // http on the wrong host). It now errors AT STARTUP with the operator
  // action. Loopback remains allowed for the dev profile (strict-HTTPS in
  // assertApiConfiguration below).
  if (!extra?.apiBaseUrl) {
    throw new ApiError(
      "UNCONFIGURED_BASE_URL",
      "API base URL is not configured — set EXPO_PUBLIC_API_BASE_URL (EAS profile env) or app.json extra.apiBaseUrl. The app refuses to fall back to a plaintext localhost default (FIN-021).",
      0,
    );
  }
  return extra.apiBaseUrl;
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
// MOB-1 (2026-11-09 P1 wave) — session-expiry notifications
//
// rpc() used to clear only the SecureStore token on a 401: the zustand user
// object stayed set, so the login guard in app/_layout.tsx never fired and
// every screen kept showing per-call errors until a manual sign-out or cold
// start. api.ts CANNOT import the auth store directly (auth.ts → api.ts is
// already a dependency edge; importing back would be circular), so — exactly
// like the web app's "hrm:unauthorized" CustomEvent (src/hrm/api.ts dispatch
// + src/hrm/store.ts listener) — the RPC layer exposes a tiny listener
// registry and the auth layer (auth.ts) subscribes and resets its FULL state
// (user, token, company, MFA scratch fields). Resetting `user` makes the
// _layout.tsx guard route to /(auth)/login immediately.
// ---------------------------------------------------------------------------

type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();

/** Subscribe to session-expiry (HTTP 401) events from rpc(). Returns an
 *  unsubscribe function (unused by auth.ts today — the subscription lives
 *  for the app's lifetime — but kept symmetric with addEventListener). */
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener);
  return () => {
    unauthorizedListeners.delete(listener);
  };
}

/** Fire-and-forget: one broken listener must never block the others, nor the
 *  ApiError the original caller is still waiting on. */
function notifyUnauthorized(): void {
  for (const listener of unauthorizedListeners) {
    try {
      listener();
    } catch {
      /* a listener's own bug must not break session recovery */
    }
  }
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

// ---------------------------------------------------------------------------
// MOB-2 (2026-11-09 P1 wave) — per-request timeouts.
//
// A hung socket used to leave spinners forever because no AbortController
// existed anywhere in the app. Every rpc() call now carries a hard deadline:
// 20s for ordinary JSON round-trips, 30s for large bodies (base64 selfie
// uploads) — callers pass UPLOAD_TIMEOUT_MS via rpc(opts). A timeout throws
// ApiError("TIMEOUT", …, 0): status 0 is the app's existing "no HTTP
// response" convention, so offline.ts/outbox-core classify it as a retryable
// network failure (backoff, photo kept in memory) — the right outcome for a
// request that never got an answer.
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 20_000;
/** Large-body requests (selfie uploads) get a longer deadline. */
export const UPLOAD_TIMEOUT_MS = 30_000;

/** Runs `fn` under a hard abort deadline. The signal covers the WHOLE
 *  exchange — fetch AND the response body read — so a server that sends
 *  headers and then stalls can't hang the caller either. */
async function withTimeout<T>(timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } catch (err) {
    if (controller.signal.aborted) {
      // The deadline fired — surface a human-readable timeout instead of an
      // opaque AbortError. Genuine network failures (fetch TypeError) fall
      // through unchanged so existing offline handling keeps working.
      throw new ApiError(
        "TIMEOUT",
        `Request timed out after ${Math.round(timeoutMs / 1000)}s — check your connection and try again.`,
        0,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// MOB-2 (2026-11-09 P1 wave) — TLS certificate pinning scaffold.
//
// HONEST SCOPE — what is ENFORCED today (pure JS, no new native deps):
//   · per-request AbortController timeouts (above) — enforced;
//   · strict HTTPS, no fallback, for any host with pins configured —
//     enforced: rpc() refuses to attach the Bearer token / send PII over
//     plain http to a pinned host (fail closed, never downgrades);
//   · SPKI hash format validation — enforced, so a malformed operator hash
//     fails loudly on the first request instead of silently never matching.
// What is CONFIGURED but NOT yet cryptographically verified:
//   React Native's fetch/XHR never exposes the peer certificate to JS, so a
//   real SPKI-pin comparison requires a native module (e.g. react-native-
//   ssl-pinning or a small Expo config plugin) — impossible as a pure-JS
//   change with the current dependency set (expo-network has no pinning
//   API). The hashes are resolved, validated and keyed per host at ONE
//   choke point (assertTransportSecurity below) so wiring that module later
//   is a single-site change. Until then, a rogue user-installed CA is NOT
//   blocked by this layer — the enforced mitigations are the OS TLS stack,
//   strict-HTTPS and the timeouts above.
//
// OPERATORS — fill pins for the two production hosts:
//   · oms.finixhr.com          (production)
//   · staging-oms.finixhr.com  (staging / EAS preview profile)
// Sources (env wins over app.json, so EAS profiles can differ):
//   · app.json → expo.extra.tlsPins:
//       { "oms.finixhr.com": ["sha256/<base64 SPKI>", "sha256/<backup SPKI>"] }
//   · env (EAS build profile "env" / EAS secrets / CI):
//       EXPO_PUBLIC_TLS_PINS="oms.finixhr.com=sha256/A,sha256/B;staging-oms.finixhr.com=sha256/C"
// Pin the CURRENT leaf SPKI plus at least one backup (intermediate or
// next-key) so a planned certificate rotation doesn't brick the app.
// ---------------------------------------------------------------------------

type TlsPinMap = Record<string, string[]>;

/** `sha256/` + 44 chars of base64 (a SHA-256 digest) — the standard SPKI
 *  pin format ("pin-sha256" without the prefix, as used by pinning libs). */
const PIN_FORMAT = /^sha256\/[A-Za-z0-9+/=]{44}$/;

function resolveTlsPins(): TlsPinMap {
  const fromEnv = process.env.EXPO_PUBLIC_TLS_PINS;
  if (fromEnv) {
    // "host=sha256/A,sha256/B;host2=sha256/C" — tolerant of whitespace and
    // trailing separators so CI env-var typos degrade to "no pins" for the
    // malformed entry rather than crashing config resolution.
    const map: TlsPinMap = {};
    for (const entry of fromEnv.split(";")) {
      const eq = entry.indexOf("=");
      if (eq <= 0) continue;
      const host = entry.slice(0, eq).trim();
      const hashes = entry
        .slice(eq + 1)
        .split(",")
        .map((h) => h.trim())
        .filter(Boolean);
      if (host && hashes.length > 0) map[host] = hashes;
    }
    return map;
  }
  const extra = Constants.expoConfig?.extra as { tlsPins?: TlsPinMap } | undefined;
  return extra?.tlsPins ?? {};
}

/** Pre-send transport gate — see the honesty notes above for exactly what is
 *  enforced vs configured. No-op unless pins are configured for the target
 *  host (dev/localhost is unaffected). */
function assertTransportSecurity(base: string): void {
  // Regex parse instead of `new URL` — Hermes does not ship a full WHATWG
  // URL implementation, and we only need scheme + host here.
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]+)/.exec(base);
  if (!m) {
    throw new ApiError("BAD_BASE_URL", `Invalid API base URL: "${base}"`, 0);
  }
  const scheme = m[1].toLowerCase();
  const host = m[2].split(":")[0].toLowerCase(); // strip :port

  const pins = resolveTlsPins()[host];
  if (!pins || pins.length === 0) return;

  for (const pin of pins) {
    if (!PIN_FORMAT.test(pin)) {
      // Fail loudly on operator error BEFORE any credential leaves the device.
      throw new ApiError(
        "PIN_CONFIG_ERROR",
        `Malformed TLS pin for ${host}: "${pin}" — expected sha256/<44-char base64>`,
        0,
      );
    }
  }
  if (scheme !== "https") {
    // Bearer tokens, PII and selfie uploads must never ride plain http once
    // the host is pinned — fail CLOSED, no http fallback.
    throw new ApiError(
      "INSECURE_TRANSPORT",
      `Refusing to send credentials over ${scheme} to pinned host ${host}`,
      0,
    );
  }
  // Pins are well-formed and the transport is https. The hash comparison
  // itself awaits the native pinning module (see honesty notes above) — the
  // resolved map is the single place to hand these hashes to it.
}

// ==================== FIN-021 (Phase 2) — startup fail-fast ====================
// The audit found the mobile transport quietly weakened by two defaults:
//   1. an unconfigured build fell back to plaintext http://localhost:4055
//      (fixed above in getBaseUrl);
//   2. TLS pinning existed but nothing REQUIRED it — tlsPins shipped as {}
//      and no profile asked for pins, so the strongest transport setting in
//      the app was effectively off. The eas.json production + preview
//      profiles now set EXPO_PUBLIC_REQUIRE_PINS=1, which makes THIS
//      assertion fail at startup (import time — the app entry imports this
//      module before the first RPC) until the operator fills pins for the
//      configured host via EXPO_PUBLIC_TLS_PINS (EAS secrets) or app.json
//      extra.tlsPins. "The production profile pins" is therefore true BY
//      CONSTRUCTION: a pinless production build cannot start.
// Strict-HTTPS rides the same check: only loopback may be non-https.
export function assertApiConfiguration(): { baseUrl: string; pinsRequired: boolean } {
  const baseUrl = getBaseUrl();
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]+)/.exec(baseUrl);
  const scheme = (m?.[1] ?? "").toLowerCase();
  const host = (m?.[2] ?? "").split(":")[0].toLowerCase();
  const isLoopback = host === "localhost" || host === "127.0.0.1";
  if (scheme !== "https" && !isLoopback) {
    throw new ApiError(
      "INSECURE_BASE_URL",
      `API base URL must be https (got "${scheme}://") — FIN-021 strict transport. Loopback is the only non-https exception (dev profile).`,
      0,
    );
  }
  const pinsRequired = process.env.EXPO_PUBLIC_REQUIRE_PINS === "1";
  if (pinsRequired) {
    if (isLoopback) {
      throw new ApiError(
        "PINNING_REQUIRED",
        `EXPO_PUBLIC_REQUIRE_PINS=1 but the configured base URL is loopback (${baseUrl}) — production profiles must point at the pinned host, not localhost.`,
        0,
      );
    }
    const pinsByHost = resolveTlsPins();
    const pins = pinsByHost[host];
    if (!pins || pins.length === 0) {
      throw new ApiError(
        "PINNING_REQUIRED",
        `EXPO_PUBLIC_REQUIRE_PINS=1: no TLS pins resolved for ${host}. Fill EXPO_PUBLIC_TLS_PINS (EAS secrets) or app.json extra.tlsPins — the operator notes at the top of this file list the two production hosts.`,
        0,
      );
    }
  }
  return { baseUrl, pinsRequired };
}

// FIN-021 — runs once at import (startup): an unconfigured, insecure or
// pinless production build fails BEFORE the first credential leaves the device.
assertApiConfiguration();

export interface RpcOptions {
  /** Skip attaching the Bearer token (login / MFA / enrollment calls). */
  skipAuth?: boolean;
  /** MOB-2 — per-request timeout override in ms. Defaults to 20s
   *  (DEFAULT_TIMEOUT_MS); large bodies pass UPLOAD_TIMEOUT_MS (30s). */
  timeoutMs?: number;
}

export async function rpc<T = unknown>(
  action: string,
  payload?: unknown,
  opts?: RpcOptions,
): Promise<T> {
  const base = getBaseUrl();
  // MOB-2 — transport gate BEFORE the token is even read: pinned hosts must
  // be https with well-formed hashes. No-op unless pins are configured.
  assertTransportSecurity(base);
  const token = opts?.skipAuth ? null : await getToken();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // Custom header exempts native requests from CSRF checks on the server
    "X-Requested-With": "XMLHttpRequest",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  // MOB-2 — hard deadline on the WHOLE request (headers + body): a hung
  // socket now surfaces as ApiError("TIMEOUT") instead of an eternal
  // spinner. Ordinary calls get 20s; uploads pass UPLOAD_TIMEOUT_MS (30s).
  const body = await withTimeout(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS, async (signal) => {
    const res = await fetch(`${base}/api/hrm`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action, payload }),
      signal,
    });

    if (res.status === 401) {
      // MOB-1 (2026-11-09 P1 wave) — a 401 must reset the WHOLE auth state,
      // not just the token: previously the zustand user object stayed set,
      // the login guard never fired, and every screen showed per-call errors
      // until a manual sign-out. clearToken() is best-effort so a SecureStore
      // hiccup cannot swallow the session-reset notification (the listener
      // in auth.ts also clears the store-side token; the guard then routes
      // to login).
      try {
        await clearToken();
      } catch {
        /* best-effort — listeners still reset the in-memory session */
      }
      notifyUnauthorized();
      throw new ApiError("UNAUTHORIZED", "Session expired. Please log in again.", 401);
    }

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new ApiError("PARSE_ERROR", "Invalid server response", res.status);
    }

    if (!res.ok) {
      // Server error body is { ok: false, error: <human message>, code: <http> }
      // — the actionable text (policy denials, sequence guards, quota
      // reasons) lives in `error`. M3: display THAT, not a generic "Request
      // failed (N)" — employees must see "This attendance requires a
      // selfie", not "(400)".
      const b = parsed as { error?: string; message?: string };
      throw new ApiError(
        b?.error ? `HTTP_${res.status}` : "SERVER_ERROR",
        b?.error ?? b?.message ?? `Request failed (${res.status})`,
        res.status,
      );
    }

    return parsed as T;
  });

  return body;
}
