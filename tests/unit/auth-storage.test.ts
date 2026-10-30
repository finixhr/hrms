/// <reference types="bun-types" />
// ============ H-08 regression: auth tokens never touch localStorage ============
// The httpOnly cookie is the sole persistent transport. The bearer fallback is
// memory-only with a 5-minute TTL; CSRF echoes are memory-only. Legacy
// localStorage values are scrubbed on logout / unauthorized / login.
import { describe, test, expect, beforeAll, afterAll } from "bun:test"

// ---- stub a minimal browser environment BEFORE importing the client modules ----
const store = new Map<string, string>()
const writes: Array<[string, string]> = []
const fetchCalls: Array<{ headers: Record<string, string>; body: any }> = []
let nextResponse: { ok: boolean; data?: any; code?: number; error?: string } = { ok: true, data: {} }

beforeAll(() => {
  ;(globalThis as any).CustomEvent ||= class CustomEventMock { type: string; constructor(type: string) { this.type = type } }
  ;(globalThis as any).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, String(v)); writes.push([k, String(v)]) },
      removeItem: (k: string) => { store.delete(k) },
    },
    dispatchEvent: () => true,
    addEventListener: () => { /* no-op */ },
    open: () => null,
  }
})

afterAll(() => {
  delete (globalThis as any).window
})

// import AFTER the window stub exists (dynamic import inside beforeAll is not
// needed — module bodies only check typeof window at load)
import { rpc, setMemoryBearer, saveCsrfToken, purgeLegacyWebStorage, TOKEN_KEY, CSRF_KEY } from "@/hrm/api"
import { useHrm } from "@/hrm/store"

beforeAll(() => {
  ;(globalThis as any).fetch = async (_url: string, init: any) => {
    fetchCalls.push({ headers: init.headers, body: JSON.parse(init.body) })
    const res = nextResponse
    return {
      ok: res.ok, status: res.ok ? 200 : res.code || 500,
      json: async () => res,
    } as any
  }
})

const lastCall = () => fetchCalls[fetchCalls.length - 1]

describe("H-08 login flow", () => {
  test("after login, localStorage contains NO hrm_token (and nothing is ever written)", async () => {
    nextResponse = {
      ok: true,
      data: {
        token: "T123SECRET",
        csrfToken: "CSRF1",
        user: { id: "u1", name: "U", role: "HR_ADMIN", roleLabel: "HR Admin", permissions: [] },
        vendor: { id: "v1", name: "V", code: "V" },
      },
    }
    await useHrm.getState().login("user@test.local", "pw12345")
    expect(useHrm.getState().user?.id).toBe("u1")
    // no token was ever written to localStorage
    expect(writes.filter(([k]) => k === TOKEN_KEY)).toEqual([])
    expect(store.has(TOKEN_KEY)).toBe(false)
    expect(store.has(CSRF_KEY)).toBe(false)
  })

  test("rpc sends the memory bearer (5-min TTL) — never reads localStorage", async () => {
    nextResponse = { ok: true, data: {} }
    await rpc("notifications.unreadCount")
    expect(lastCall().headers.Authorization).toBe("Bearer T123SECRET")
    // csrf echo comes from memory
    expect(lastCall().headers["X-CSRF-Token"]).toBe("CSRF1")
  })

  test("after the 5-minute TTL the bearer is gone — cookie-only transport", async () => {
    setMemoryBearer("T123SECRET", -1) // already expired
    await rpc("notifications.unreadCount")
    expect(lastCall().headers.Authorization).toBeUndefined()
  })

  test("logout scrubs memory tokens AND legacy localStorage values", async () => {
    // simulate residue from a pre-remediation build
    store.set(TOKEN_KEY, "LEGACYTOKEN")
    store.set(CSRF_KEY, "LEGACYCSRF")
    nextResponse = { ok: true, data: { loggedOut: true } }
    await useHrm.getState().logout()
    expect(store.has(TOKEN_KEY)).toBe(false)
    expect(store.has(CSRF_KEY)).toBe(false)
    // subsequent rpc calls carry no bearer and no csrf
    nextResponse = { ok: true, data: {} }
    await rpc("notifications.unreadCount")
    expect(lastCall().headers.Authorization).toBeUndefined()
    expect(lastCall().headers["X-CSRF-Token"]).toBeUndefined()
  })

  test("a 401 response clears the memory bearer + csrf and dispatches hrm:unauthorized", async () => {
    setMemoryBearer("T123SECRET")
    saveCsrfToken("CSRF1")
    store.set(TOKEN_KEY, "LEGACYTOKEN") // residue to scrub
    nextResponse = { ok: false, code: 401, error: "Authentication required" }
    await expect(rpc("employees.list")).rejects.toThrow(/authentication/i)
    // memory cleared: next call carries nothing
    nextResponse = { ok: true, data: {} }
    await rpc("employees.list")
    expect(lastCall().headers.Authorization).toBeUndefined()
    expect(lastCall().headers["X-CSRF-Token"]).toBeUndefined()
    // legacy storage scrubbed too
    expect(store.has(TOKEN_KEY)).toBe(false)
  })

  test("purgeLegacyWebStorage removes both legacy keys", () => {
    store.set(TOKEN_KEY, "x")
    store.set(CSRF_KEY, "y")
    purgeLegacyWebStorage()
    expect(store.size).toBe(0)
  })

  test("auth.me response refreshes the memory CSRF token (tab-focus bootstrap)", async () => {
    saveCsrfToken(null)
    nextResponse = { ok: true, data: { csrfToken: "CSRF-REFRESHED" } }
    await rpc("auth.me")
    nextResponse = { ok: true, data: {} }
    await rpc("notifications.unreadCount")
    expect(lastCall().headers["X-CSRF-Token"]).toBe("CSRF-REFRESHED")
    expect(store.has(CSRF_KEY)).toBe(false) // still never persisted
  })
})
