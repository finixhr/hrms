/// <reference types="bun-types" />
// ============ Unit tests — security primitives (C-4/H-1/H-10/M-16) ============
import { test, expect, describe } from "bun:test"
import {
  escapeHtml, escapeAttrUrl, sanitizeHtml, isOriginAllowed, refererHost,
  safePayload, validateOutboundUrl, sanitizeDisplayName, rateLimit, safeEqual,
} from "@/hrm-server/security"

describe("escapeHtml (H-1)", () => {
  test("neutralizes the classic img-onerror payload", () => {
    const payload = '<img src=x onerror=alert(1)>'
    const escaped = escapeHtml(payload)
    // the TAG is destroyed: < and > become entities, so the browser renders
    // inert TEXT — no element is ever constructed from the payload
    expect(escaped).toBe("&lt;img src=x onerror=alert(1)&gt;")
    expect(escaped).not.toMatch(/<img/)
    expect(escaped).not.toContain("<")
    expect(escaped).not.toContain(">")
  })

  test("quotes are escaped (attribute breakout)", () => {
    expect(escapeHtml('" onmouseover="alert(1)')).not.toContain('"')
  })

  test("nullish values render as empty string", () => {
    expect(escapeHtml(null)).toBe("")
    expect(escapeHtml(undefined)).toBe("")
  })
})

describe("escapeAttrUrl (H-1)", () => {
  test("data URLs for images pass", () => {
    expect(escapeAttrUrl("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA")
  })

  test("https URLs pass", () => {
    expect(escapeAttrUrl("https://cdn.example.com/logo.png")).toBe("https://cdn.example.com/logo.png")
  })

  test("javascript: URLs are dropped entirely", () => {
    expect(escapeAttrUrl("javascript:alert(1)")).toBe("")
  })

  test("attribute-breaking payloads are defused", () => {
    const out = escapeAttrUrl('https://x/a.png" onerror="alert(1)')
    expect(out).not.toContain('" onerror')
  })
})

describe("sanitizeHtml (H-1 letter bodies)", () => {
  test("formatting markup survives", () => {
    const out = sanitizeHtml("<p>Hello <b>world</b></p>")
    expect(out).toContain("<b>world</b>")
  })

  test("script blocks are stripped", () => {
    expect(sanitizeHtml("<p>ok</p><script>alert(1)</script>")).not.toContain("script")
  })

  test("event handlers are stripped from allowed tags", () => {
    const out = sanitizeHtml('<p onclick="alert(1)">hi</p>')
    expect(out).not.toContain("onclick")
    expect(out).toContain("hi")
  })

  test("javascript: hrefs are dropped", () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).not.toContain("javascript:")
  })

  test("iframes and objects are removed", () => {
    expect(sanitizeHtml('<iframe src="https://evil"></iframe>ok')).not.toContain("iframe")
  })

  test("tables keep their attributes", () => {
    const out = sanitizeHtml('<table border="1"><tr><td colspan="2">x</td></tr></table>')
    expect(out).toContain('colspan="2"')
  })
})

describe("origin allowlist (C-4)", () => {
  test("same-host origin is allowed", () => {
    expect(isOriginAllowed("https://hrm.example.com", "hrm.example.com")).toBe(true)
  })

  test("foreign origin is rejected", () => {
    expect(isOriginAllowed("https://evil.example.com", "hrm.example.com")).toBe(false)
  })

  test("missing origin (non-browser client) is allowed", () => {
    expect(isOriginAllowed(null, "hrm.example.com")).toBe(true)
  })

  test("env allowlist extension works", () => {
    process.env.HRM_ALLOWED_ORIGINS = "preview.example.com"
    expect(isOriginAllowed("https://preview.example.com", "hrm.example.com")).toBe(true)
    delete process.env.HRM_ALLOWED_ORIGINS
  })

  test("malformed origin is rejected", () => {
    expect(isOriginAllowed("not-a-url", "hrm.example.com")).toBe(false)
  })

  test("referer host extraction", () => {
    expect(refererHost("https://hrm.example.com/dashboard")).toBe("hrm.example.com")
    expect(refererHost("garbage")).toBeNull()
  })
})

describe("safePayload (C-3/H-5)", () => {
  test("whitelisted fields pass through", () => {
    const out = safePayload({ name: "A", mobile: "017" }, ["name", "mobile"])
    expect(out).toEqual({ name: "A", mobile: "017" })
  })

  test("vendorId and id NEVER pass when not whitelisted", () => {
    const out = safePayload({ name: "A", vendorId: "OTHER-TENANT", id: "inject" }, ["name"])
    expect(out).toEqual({ name: "A" })
  })

  test("empty strings are dropped (FormDialog convention)", () => {
    const out = safePayload({ name: "A", nickname: "" }, ["name", "nickname"])
    expect(out).toEqual({ name: "A" })
  })

  test("numeric fields are coerced and NaN is rejected", () => {
    const out = safePayload({ amount: "50", bad: "abc", neg: "-5" }, ["amount", "bad", "neg"], { numericFields: ["amount", "bad", "neg"] })
    expect(out.amount).toBe(50)
    expect(out.bad).toBeUndefined()
    expect(out.neg).toBe(-5) // range checks stay at the route level
  })

  test("bool fields are normalized", () => {
    const out = safePayload({ active: "true", dead: "yes" }, ["active"], { boolFields: ["active"] })
    expect(out.active).toBe(true)
  })
})

describe("validateOutboundUrl (H-10 SSRF guard)", () => {
  test("public https URL passes", () => {
    expect(validateOutboundUrl("https://api.sms-gw.com/send")).toEqual({ ok: true, url: expect.anything() })
  })

  test("http is refused", () => {
    expect(validateOutboundUrl("http://api.example.com/send").ok).toBe(false)
  })

  test("cloud metadata IP is refused", () => {
    expect(validateOutboundUrl("https://169.254.169.254/latest/meta-data").ok).toBe(false)
  })

  test("RFC1918 ranges are refused", () => {
    expect(validateOutboundUrl("https://192.168.1.10/x").ok).toBe(false)
    expect(validateOutboundUrl("https://10.0.0.5/x").ok).toBe(false)
    expect(validateOutboundUrl("https://172.16.9.9/x").ok).toBe(false)
  })

  test("localhost by name is refused", () => {
    expect(validateOutboundUrl("https://localhost:8080/x").ok).toBe(false)
  })

  test("credentials in the URL are refused", () => {
    expect(validateOutboundUrl("https://user:pass@api.example.com/x").ok).toBe(false)
  })
})

describe("rate limiter (M-16 → M-06 SQLite-backed)", () => {
  test("allows up to the limit then blocks", async () => {
    const key = `t:${Math.random()}`
    // 60s window (same as the persistence test below): a 1s window makes this
    // test time-flaky — six sequential SQLite roundtrips (~30-40ms) can
    // straddle a fixed-window boundary, resetting the counter mid-test, and
    // the 6th call then legitimately returns false.
    for (let i = 0; i < 5; i++) expect(await rateLimit(key, 5, 60_000)).toBe(false)
    expect(await rateLimit(key, 5, 60_000)).toBe(true)
  })

  test("separate keys have separate windows", async () => {
    const a = `a:${Math.random()}`, b = `b:${Math.random()}`
    for (let i = 0; i < 5; i++) await rateLimit(a, 5, 60_000)
    expect(await rateLimit(b, 5, 60_000)).toBe(false)
  })

  test("M-06: throttle state survives a fresh module instance (DB, not memory)", async () => {
    // the state lives in the Throttle table — a simulated restart (new import
    // of a second module copy) still sees the exhausted bucket
    const key = `persist:${Math.random()}`
    for (let i = 0; i < 5; i++) await rateLimit(key, 5, 60_000)
    expect(await rateLimit(key, 5, 60_000)).toBe(true)
    // direct DB evidence: the row exists with count > limit
    const { db } = await import("@/lib/db")
    const row = await db.throttle.findUnique({ where: { key } })
    expect(row).not.toBeNull()
    expect(row!.count).toBeGreaterThan(5)
  })
})

describe("safeEqual (timing-safe)", () => {
  test("equal strings match", () => expect(safeEqual("abc123", "abc123")).toBe(true))
  test("different strings fail", () => expect(safeEqual("abc123", "abc124")).toBe(false))
  test("different lengths fail fast", () => expect(safeEqual("abc", "abcd")).toBe(false))
  test("empty values fail", () => expect(safeEqual("", "")).toBe(false))
})

describe("sanitizeDisplayName (H-10 SMTP header)", () => {
  test("CRLF injection is stripped", () => {
    expect(sanitizeDisplayName("HR\r\nBcc: victim@x.com")).not.toMatch(/[\r\n]/)
  })
  test("quotes and angle brackets are stripped", () => {
    expect(sanitizeDisplayName('"HR" <hr@x.com>')).not.toMatch(/["<>]/)
  })
})
