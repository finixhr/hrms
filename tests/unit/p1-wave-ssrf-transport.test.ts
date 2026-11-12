/// <reference types="bun-types" />
// ============ P1 wave (2026-11-09) — SSRF/transport hardening regression tests ============
// Audit Chapter 16, Table 7 (SEC-8, SEC-14):
//   SEC-8  the SSLCommerz / PayStation / EPS base-URL overrides now run
//          through the shared validateOutboundUrl SSRF guard (bKash/Nagad
//          already did), and SSLCommerz's validationserverAPI authentication
//          moved from the query string to a POST form body (the endpoint
//          accepts both — verified against the live sandbox 2026-11-09; the
//          tran_id validator rejects POST and keeps the guarded GET form).
//   SEC-14 the SSLWireless SMS send now rides the pinned SSRF transport
//          (resolveOutboundUrl + pinnedFetch, no redirects) instead of a raw
//          fetch on an admin-overridable base URL.
import { describe, test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sslwirelessProvider } from "@/hrm-server/sms/sslwireless"

const src = (p: string) => readFileSync(join(process.cwd(), "src", p), "utf8")

// ---------- SEC-14: the pinned transport is actually enforced on the send path ----------
describe("P1/SEC-14 — SSLWireless send rides the pinned SSRF transport", () => {
  test("an internal-host base URL is refused before any connection (resolveOutboundUrl rejection)", async () => {
    const r = await sslwirelessProvider.send("8801712345678", "p1 test", {
      provider: "sslwireless",
      apiKey: "token",
      senderId: "SID",
      apiUrl: "https://127.0.0.1",
      method: "POST",
    })
    expect(r.status).toBe("FAILED")
    expect(r.detail).toMatch(/Blocked gateway URL/i)
  })

  test("a non-https base URL is refused by the shared guard", async () => {
    const r = await sslwirelessProvider.send("8801712345678", "p1 test", {
      provider: "sslwireless",
      apiKey: "token",
      senderId: "SID",
      apiUrl: "http://smsplus.sslwireless.com",
      method: "POST",
    })
    expect(r.status).toBe("FAILED")
    expect(r.detail).toMatch(/Blocked gateway URL/i)
  })

  test("an unresolvable public host is refused (DNS resolution is part of the guard)", async () => {
    const r = await sslwirelessProvider.send("8801712345678", "p1 test", {
      provider: "sslwireless",
      apiKey: "token",
      senderId: "SID",
      apiUrl: "https://nonexistent-host-p1-wave-xyz.invalid",
      method: "POST",
    })
    expect(r.status).toBe("FAILED")
    expect(r.detail).toMatch(/Blocked gateway URL|Could not resolve/i)
  })

  test("the source uses the pinned transport and no raw fetch remains on the send path", () => {
    const s = src("hrm-server/sms/sslwireless.ts")
    expect(s).toContain("resolveOutboundUrl(")
    expect(s).toContain("pinnedFetch(")
    expect(s).toContain("redirectRefusal(")
    // the old raw `await fetch(` must be gone from the send path
    expect(s).not.toMatch(/await fetch\(/)
  })
})

// ---------- SEC-8: the three ungated payment providers run the override guard ----------
describe("P1/SEC-8 — payment provider base-URL overrides run the SSRF guard", () => {
  const providers: [string, string][] = [
    ["SSLCommerz", "hrm-server/saas/payments/sslcommerz.ts"],
    ["PayStation", "hrm-server/saas/payments/paystation.ts"],
    ["EPS", "hrm-server/saas/payments/eps.ts"],
  ]
  for (const [label, path] of providers) {
    test(`${label} validates baseUrlOverride through validateOutboundUrl`, () => {
      const s = src(path)
      expect(s).toContain("validateOutboundUrl(")
      // the guard sits inside the base-URL resolver and throws the provider
      // error bKash/Nagad already use
      expect(s).toMatch(/baseUrlOverride blocked/)
      // an override must never bypass the guard: the guarded branch must run
      // BEFORE any return of the raw override
      const baseFn = s.slice(s.indexOf("baseUrlOverride"))
      expect(baseFn.indexOf("validateOutboundUrl")).toBeLessThan(baseFn.indexOf("return cfg.baseUrlOverride"))
    })
  }

  test("SSLCommerz credentials leave the URL: validationserverAPI is now a POST form call", () => {
    const s = src("hrm-server/saas/payments/sslcommerz.ts")
    // the val_id validator posts its credentials in the form body
    expect(s).toMatch(/postForm\(`\$\{base\(creds\)\}\/validator\/api\/validationserverAPI\.php`/)
    // the ONLY remaining query-string credential use is the tran_id validator
    // (documented GET-only — POST returns a 500 there, verified 2026-11-09):
    // no store_passwd interpolation may appear before that function begins
    const tranIdFnAt = s.indexOf("async function validateByTranId")
    expect(s.slice(0, tranIdFnAt)).not.toMatch(/store_passwd=\$\{/);
  })

  test("the five-provider SSRF contract: bKash, Nagad, SSLCommerz, PayStation and EPS all guard the override", () => {
    for (const p of ["bkash.ts", "nagad.ts", "sslcommerz.ts", "paystation.ts", "eps.ts"]) {
      expect(src(join("hrm-server", "saas", "payments", p))).toContain("validateOutboundUrl(")
    }
  })
})
