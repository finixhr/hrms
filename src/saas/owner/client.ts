"use client"
// ============ Owner console API client ============
// POST /api/owner { action, payload } — cookie-authenticated with the
// saas_owner_session httpOnly cookie; mutating calls echo the session's CSRF
// token (X-CSRF-Token), mirroring the tenant RPC discipline.
let ownerCsrf: string | null = null

export function saveOwnerCsrf(token?: string | null) {
  ownerCsrf = token || null
}

export class OwnerApiError extends Error {
  code?: number
  entitlement?: any
  constructor(message: string, code?: number, entitlement?: any) {
    super(message)
    this.name = "OwnerApiError"
    this.code = code
    this.entitlement = entitlement
  }
}

export async function ownerRpc<T = any>(action: string, payload?: Record<string, unknown>): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (ownerCsrf) headers["X-CSRF-Token"] = ownerCsrf
  const res = await fetch("/api/owner", {
    method: "POST",
    headers,
    body: JSON.stringify({ action, payload: payload || {} }),
  })
  let data: any
  try {
    data = await res.json()
  } catch {
    throw new OwnerApiError(`Unexpected server response (${res.status})`, res.status)
  }
  // actions that establish a session (their response carries the fresh CSRF
  // token the console must echo on subsequent mutating calls)
  const SESSION_ACTIONS = new Set([
    "owner.auth.login",
    "owner.auth.login.mfa",
    "owner.auth.mfa.enroll.complete",
    "owner.auth.me",
  ])
  if (SESSION_ACTIONS.has(action)) {
    if (data?.ok && data?.csrfToken) saveOwnerCsrf(data.csrfToken)
  }
  if (!res.ok || !data?.ok) {
    throw new OwnerApiError(data?.error || `Request failed (${res.status})`, res.status, data?.entitlement)
  }
  return data as T
}

/** Small data hook with loading/error state + reload(). */
import { useCallback, useEffect, useState } from "react"

export function useOwnerApi<T = any>(action: string | null, payload?: Record<string, unknown>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(!!action)
  const [error, setError] = useState<string | null>(null)

<<<<<<< HEAD
  // T-11 — the React Compiler's hook rules require dependency lists of
  // simple expressions: no inline JSON.stringify() calls, no spreads. The
  // serialized payload stays the cache key (stable across renders even when
  // the payload object identity changes); the spread deps become one
  // serialized key that merely TRIGGERS the effect — load() does the work.
  const payloadKey = JSON.stringify(payload || {})
  const extraKey = JSON.stringify(deps)
=======
>>>>>>> origin/main
  const load = useCallback(async () => {
    if (!action) return
    setLoading(true)
    setError(null)
    try {
      const d = await ownerRpc<T>(action, payload || {})
      setData(d)
    } catch (e: any) {
      setError(e?.message || "Request failed")
    } finally {
      setLoading(false)
    }
<<<<<<< HEAD

  }, [action, payloadKey, extraKey])
=======
     
  }, [action, JSON.stringify(payload || {}), ...deps])
>>>>>>> origin/main

  useEffect(() => { load() }, [load])
  return { data, loading, error, reload: load, setData }
}
