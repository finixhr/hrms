/// <reference types="bun-types" />
// ============ H-7 regression: auth throttles keyed on spoofable XFF ============
// X-Forwarded-For is client-spoofable. Under untrusted-proxy mode (default),
// a rotating-XFF spray must still hit the per-email throttle and must NOT
// affect a second user. No shared global "unknown-ip" bucket may exist.
import { describe, test, expect } from "bun:test"
import { resolveClientIp, authThrottleKeys, identityThrottleKey, rateLimit } from "@/hrm-server/security"

const reqWith = (ip: string | null) => ({ headers: { get: (name: string) => (name === "x-forwarded-for" ? ip : null) } })

describe("resolveClientIp (H-7)", () => {
  test("UNTRUSTED mode (default): XFF is ignored — returns null even when present", () => {
    expect(resolveClientIp(reqWith("1.2.3.4"), false)).toBeNull()
    expect(resolveClientIp(reqWith("1.2.3.4, 10.0.0.1"), false)).toBeNull()
  })
  test("TRUSTED mode (HRM_TRUST_PROXY=1): first XFF value is honored", () => {
    expect(resolveClientIp(reqWith("1.2.3.4"), true)).toBe("1.2.3.4")
    expect(resolveClientIp(reqWith("1.2.3.4, 10.0.0.1"), true)).toBe("1.2.3.4")
  })
  test("missing header returns null in both modes", () => {
    expect(resolveClientIp(reqWith(null), true)).toBeNull()
    expect(resolveClientIp(undefined, true)).toBeNull()
  })
  test("empty / whitespace XFF values resolve to null", () => {
    expect(resolveClientIp(reqWith("  "), true)).toBeNull()
    expect(resolveClientIp(reqWith(","), true)).toBeNull()
  })
})

describe("authThrottleKeys (H-7)", () => {
  test("unknown IP → a single EMAIL-bound key (no global bucket, no IP component)", () => {
    const keys = authThrottleKeys("victim@test.local", null)
    expect(keys).toEqual(["auth:email:victim@test.local"])
  })
  test("known IP → (ip,email) key + per-IP global cap", () => {
    const keys = authThrottleKeys("victim@test.local", "9.9.9.9")
    expect(keys[0]).toBe("auth:ip:9.9.9.9:victim@test.local")
    expect(keys[1]).toBe("authip:9.9.9.9")
  })
  test("email is normalized to lowercase + capped at 80 chars", () => {
    const keys = authThrottleKeys("MiXeD@TEST.local", null)
    expect(keys[0]).toBe("auth:email:mixed@test.local")
  })
})

describe("identityThrottleKey (H-7)", () => {
  test("falls back to the email when the IP is unknown", () => {
    expect(identityThrottleKey("reset", "A@B.c", null)).toBe("reset:email:a@b.c")
    expect(identityThrottleKey("forgot", "A@B.c", null)).toBe("forgot:email:a@b.c")
  })
  test("uses the real IP when known", () => {
    expect(identityThrottleKey("reset", "a@b.c", "5.5.5.5")).toBe("reset:5.5.5.5")
  })
})

describe("H-7 — rotating-XFF spray attack (untrusted mode)", () => {
  // Simulates the dispatcher's throttle decision for 12 login attempts at the
  // same email, each carrying a DIFFERENT spoofed X-Forwarded-For value.
  test("spray hits the per-email throttle regardless of XFF rotation", async () => {
    const email = "spray-victim@test.local"
    let blockedAt: number | null = null
    for (let i = 1; i <= 12; i++) {
      const ip = resolveClientIp(reqWith(`10.0.${i}.${i}`), false) // untrusted → null
      const [key] = authThrottleKeys(email, ip)
      if (await rateLimit(key, 10, 60_000)) { blockedAt = i; break }
    }
    expect(blockedAt).toBe(11) // 10 attempts allowed, 11th blocked
  })

  test("a SECOND user is unaffected by the first user's throttle", async () => {
    const victim = "second-victim2@test.local"
    const other = "bystander@test.local"
    // exhaust the victim's bucket with a spoofed spray
    for (let i = 0; i < 12; i++) {
      const ip = resolveClientIp(reqWith(`10.2.${i}.${i}`), false)
      const [key] = authThrottleKeys(victim, ip)
      await rateLimit(key, 10, 60_000)
    }
    // the bystander's bucket is independent and still empty
    const [bystanderKey] = authThrottleKeys(other, resolveClientIp(reqWith("66.66.66.66"), false))
    expect(await rateLimit(bystanderKey, 10, 60_000)).toBe(false)
  })

  test("the old shared global unknown-ip bucket key no longer exists in generated keys", () => {
    // the deployment-wide "authip:unknown-ip" bucket would throttle everyone together
    const keys = authThrottleKeys("anyone@test.local", null)
    expect(keys).not.toContain("authip:unknown-ip")
    expect(keys.join(",")).not.toMatch(/unknown-ip/)
  })
})
