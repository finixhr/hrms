/// <reference types="bun-types" />
// ============ FIN-027 (Phase 2) — the AI fetch honors the SSRF contract ============
// The audit: endpoint validation happened only at SETTINGS-SAVE time; a saved
// public HTTPS URL could 302-redirect to an internal host (fetch follows
// redirects by default) or rebind DNS at call time — the request carries the
// stored API key as Bearer and candidate text. webhooks.ts and integrations.ts
// already honored the contract; ai.ts did not. These tests pin:
//   · save-time validation still rejects private/http endpoints;
//   · the LLM fetch NEVER follows a redirect (3xx → readable error);
//   · the send-time resolver blocks private-space and rebinding targets.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { mkVendor, mkUser, mkSession, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { llmFetch } from "@/hrm-server/routes/ai"
import { resolveOutboundUrl, validateOutboundUrl } from "@/hrm-server/security"

let v: any
let ownerToken: string

beforeAll(async () => {
  v = await mkVendor(uniq("fin027"))
  const owner = await mkUser(v.id, { role: "VENDOR_OWNER", name: "FIN-027 Owner" })
  ownerToken = await mkSession(owner.id)
})

describe("FIN-027 — save-time endpoint validation", () => {
  test("ai.settings.save rejects private/internal base URLs", async () => {
    for (const bad of ["http://169.254.169.254/v1", "https://localhost/v1", "https://10.0.0.5/v1", "http://metadata.google.internal/v1"]) {
      const r = await postHrm("ai.settings.save", { baseUrl: bad }, { bearer: ownerToken })
      expect(r.status).toBe(400)
      expect(String(r.body.error || "")).toContain("rejected")
    }
  })
  test("ai.settings.save rejects non-https and credential-carrying URLs", async () => {
    const r = await postHrm("ai.settings.save", { baseUrl: "http://example.com/v1" }, { bearer: ownerToken })
    expect(r.status).toBe(400)
    const r2 = await postHrm("ai.settings.save", { baseUrl: "https://user:pass@example.com/v1" }, { bearer: ownerToken })
    expect(r2.status).toBe(400)
  })
})

describe("FIN-027 — the LLM fetch never follows redirects", () => {
  test("a 302 from the provider is a READABLE ERROR, not a hop", async () => {
    // a local plain-HTTP server that always 302s (llmFetch itself carries no
    // https policy — the resolver below does; here we pin the redirect rule)
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:9/private" } })
      },
    })
    try {
      let err: any = null
      try {
        await llmFetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, { method: "POST" })
      } catch (e) { err = e }
      expect(err).toBeTruthy()
      expect(String(err.message)).toContain("302")
      expect(String(err.message)).toContain("must not redirect")
      expect(String(err.message)).toContain("/private")
    } finally {
      server.stop(true)
    }
  })
})

describe("FIN-027 — send-time resolution (DNS rebinding / private space)", () => {
  test("resolveOutboundUrl rejects loopback, link-local and private ranges by NAME and literal", async () => {
    for (const bad of ["https://localhost/v1", "https://127.0.0.1/v1", "https://169.254.169.254/v1", "https://10.1.2.3/v1", "https://[::1]/v1"]) {
      const check = await resolveOutboundUrl(bad)
      expect(check.ok).toBe(false)
    }
  })
  test("a public literal passes the string layer (the save-time contract)", () => {
    const ok = validateOutboundUrl("https://api.openai.com/v1")
    expect(ok.ok).toBe(true)
  })
})
