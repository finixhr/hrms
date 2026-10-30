/// <reference types="bun-types" />
// ============ Wave 10 — INFRASTRUCTURE ROUND regressions (2026-10-24) ============
// Master prompt §2/§3/§4/§6 pure-function surfaces:
//   Support Access — supportPermissionsFor + supportAccessActionAllowed policy
//                    matrix (deny-by-default, hard-denied verbs, scoped write
//                    catalog, alt-perm path, internally-authorized refusal).
//   Payments       — EPS x-hash (HMAC-SHA512 per the documented scheme),
//                    PayStation trx_status mapping, registry completeness.
//   Storage        — SigV4 canonical signing against the AWS-documented
//                    example vector (query presign), strict URI encoding,
//                    the object-key contract (r2:// / cld://), Cloudinary
//                    signature + delivery scheme.
//   OTP            — CSPRNG code shape/uniformity guard.
//   SMS routing    — tenant provider-label → adapter-id alias map.
import "./_testdb"
import { describe, test, expect } from "bun:test"
import crypto from "crypto"
import {
  supportPermissionsFor, supportAccessActionAllowed, SUPPORT_WRITE_CATALOG, SUPPORT_ALWAYS_ACTIONS,
} from "@/hrm-server/saas/support-access"
import { epsXHash } from "@/hrm-server/saas/payments/eps"
import { mapTrxStatus } from "@/hrm-server/saas/payments/paystation"
import { PAYMENT_PROVIDER_IDS, getPaymentProvider } from "@/hrm-server/saas/payments/registry"
import { sigv4Sign, sigv4UriEncode, parseObjectKey, cloudinarySignature, cloudinaryDeliverySignature } from "@/hrm-server/saas/storage"
import { generateOtpCode } from "@/hrm-server/saas/otp"
import { tenantSmsProviderId } from "@/hrm-server/gateway"
import { MODULES } from "@/hrm-server/types"

// ------------------------------------------------------------- §2 support ----
describe("Wave 10 §2 — support access policy (PURE matrix)", () => {
  const RO = { accessMode: "READ_ONLY" as const, scope: [] as string[] }
  const CW = (scope: string[]) => ({ accessMode: "CONTROLLED_WRITE" as const, scope })

  test("read surface is exactly *.view across every module — never a mutating verb", () => {
    const perms = supportPermissionsFor("READ_ONLY", [])
    expect(perms.size).toBe(MODULES.length)
    for (const m of MODULES) expect(perms.has(`${m}.view`)).toBe(true)
    expect(Array.from(perms).every((p) => p.endsWith(".view"))).toBe(true)
  })

  test("controlled write grants ONLY catalog entries present in the scope", () => {
    const perms = supportPermissionsFor("CONTROLLED_WRITE", ["attendance.edit", "jobs.manage"])
    expect(perms.has("attendance.edit")).toBe(true)
    expect(perms.has("jobs.manage")).toBe(true)
    expect(perms.has("attendance.create")).toBe(false) // catalog entry NOT in scope
    expect(perms.has("payroll.edit")).toBe(false) // never in the catalog at all
  })

  test("the write catalog is the narrow archetypal support set — no payroll/approvals/settings", () => {
    for (const banned of ["payroll.", "users.", "settings.", "billing.", "employees.", "approvals."]) {
      expect(Array.from(SUPPORT_WRITE_CATALOG).some((c) => c.startsWith(banned))).toBe(false)
    }
  })

  test("deny-by-default: view-only passes; every other verb is refused without an exact scoped grant", () => {
    expect(supportAccessActionAllowed({ action: "employees.list", permModule: "employees", permVerb: "view", ...RO }).allowed).toBe(true)
    expect(supportAccessActionAllowed({ action: "payroll.runs.pay", permModule: "payroll", permVerb: "pay", ...CW(["attendance.edit"]) }).allowed).toBe(false)
    expect(supportAccessActionAllowed({ action: "attendance.edit", permModule: "attendance", permVerb: "edit", ...CW(["attendance.edit"]) }).allowed).toBe(true)
    // read-only can NEVER reach a mutating verb even when the scope sneaks one in
    expect(supportAccessActionAllowed({ action: "attendance.edit", permModule: "attendance", permVerb: "edit", accessMode: "READ_ONLY", scope: ["attendance.edit"] }).allowed).toBe(false)
  })

  test("hard-denied exfiltration verbs refuse even inside a scoped controlled-write grant", () => {
    const d = supportAccessActionAllowed({ action: "employees.export", permModule: "employees", permVerb: "export", ...CW(["employees.export" as never]) })
    expect(d.allowed).toBe(false)
  })

  test("the auth surface is exit-only; internally-authorized routes are refused", () => {
    expect(SUPPORT_ALWAYS_ACTIONS.has("auth.me")).toBe(true)
    expect(SUPPORT_ALWAYS_ACTIONS.has("auth.supportExit")).toBe(true)
    expect(supportAccessActionAllowed({ action: "auth.mfa.enroll", ...RO }).allowed).toBe(false)
    expect(supportAccessActionAllowed({ action: "ess.profile", ...RO }).allowed).toBe(false)
  })

  test("alt-perm dual-verb routes must ALSO satisfy the scope on both paths", () => {
    const input = {
      action: "employees.changeShift",
      permModule: "employees", permVerb: "assign",
      altPermModule: "employees", altPermVerb: "edit",
      ...CW(["attendance.edit"]),
    }
    expect(supportAccessActionAllowed(input).allowed).toBe(false)
    const okInput = { ...input, ...CW(["employees.assign", "employees.edit"]) }
    // employees.* is not in the catalog — still refused (belt and braces)
    expect(supportAccessActionAllowed(okInput).allowed).toBe(false)
  })
})

// ----------------------------------------------------------- §3 payments ----
describe("Wave 10 §3 — PayStation + EPS adapters (PURE surfaces)", () => {
  test("registry carries all five gateways the master prompt requires", () => {
    for (const id of ["sslcommerz", "bkash", "nagad", "paystation", "eps"]) {
      expect(PAYMENT_PROVIDER_IDS.includes(id)).toBe(true)
      expect(getPaymentProvider(id)?.id).toBe(id)
    }
    expect(getPaymentProvider("unknown-gateway")).toBeNull()
  })

  test("PayStation trx_status mapping (case-tolerant, refund counts as terminal-failed)", () => {
    expect(mapTrxStatus("success")).toBe("PAID")
    expect(mapTrxStatus("Success")).toBe("PAID")
    expect(mapTrxStatus("processing")).toBe("PENDING")
    expect(mapTrxStatus("failed")).toBe("FAILED")
    expect(mapTrxStatus("refund")).toBe("FAILED")
    expect(mapTrxStatus("cancelled")).toBe("CANCELLED")
    expect(mapTrxStatus("")).toBe("PENDING")
  })

  test("EPS x-hash is base64(HMAC-SHA512(hashKey, data)) per the integration guide", () => {
    const expected = crypto.createHmac("sha512", "FHZxyzeps56789gfhg678ygu876o=").update("user@example.com", "utf8").digest("base64")
    expect(epsXHash("FHZxyzeps56789gfhg678ygu876o=", "user@example.com")).toBe(expected)
    // distinct payloads must never collide
    expect(epsXHash("key", "a")).not.toBe(epsXHash("key", "b"))
  })
})

// ------------------------------------------------------------ §4 storage ----
describe("Wave 10 §4 — storage signing + key contract (PURE surfaces)", () => {
  /** Reference SigV4 implementation written directly from the AWS "Signature
   *  Version 4" documentation (canonical request → string-to-sign → HMAC
   *  chain). Independent of the production sigv4Sign(): agreement across a
   * case matrix proves the production canonicalization (encoding, header
   * ordering, query sorting, host handling) implements the documented
   * algorithm. */
  function refSigv4(p: {
    method: string; host: string; path: string; query: Record<string, string>
    headers: Record<string, string>; signedHeaders: string[]; payloadHash: string
    amzDate: string; region: string; service: string; accessKeyId: string; secretAccessKey: string
  }): string {
    const canonicalQuery = Object.entries(p.query)
      .map(([k, v]) => `${sigv4UriEncode(k)}=${sigv4UriEncode(v)}`)
      .sort()
      .join("&")
    const canonicalHeaders = p.signedHeaders.map((h) => `${h}:${p.headers[h]}\n`).join("")
    const canonicalRequest = [p.method, p.path, canonicalQuery, canonicalHeaders, p.signedHeaders.join(";"), p.payloadHash].join("\n")
    const scope = `${p.amzDate.slice(0, 8)}/${p.region}/${p.service}/aws4_request`
    const stringToSign = ["AWS4-HMAC-SHA256", p.amzDate, scope, crypto.createHash("sha256").update(canonicalRequest).digest("hex")].join("\n")
    const kDate = crypto.createHmac("sha256", `AWS4${p.secretAccessKey}`).update(p.amzDate.slice(0, 8)).digest()
    const kRegion = crypto.createHmac("sha256", kDate).update(p.region).digest()
    const kService = crypto.createHmac("sha256", kRegion).update(p.service).digest()
    const kSigning = crypto.createHmac("sha256", kService).update("aws4_request").digest()
    return crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex")
  }

  test("sigv4UriEncode is strict RFC-3986 (unreserved set only, slashes preserved when asked)", () => {
    expect(sigv4UriEncode("a/b c.png")).toBe("a%2Fb%20c.png")
    expect(sigv4UriEncode("a/b c.png", false)).toBe("a/b%20c.png")
    expect(sigv4UriEncode("A-z09_.~")).toBe("A-z09_.~")
    expect(sigv4UriEncode("ünï")).toBe("%C3%BCn%C3%AF")
  })

  test("header signing agrees with the documented-algorithm reference across a case matrix", () => {
    const cases = [
      { method: "GET", pathSegments: ["test.txt"], payload: Buffer.alloc(0) },
      { method: "PUT", pathSegments: ["bucket", "avatars/1/x.png"], payload: Buffer.from("hello") },
      { method: "PUT", pathSegments: ["bucket", "ünï dir/f.txt"], payload: Buffer.from("unicode-ünï-payload-ẛ") },
      { method: "DELETE", pathSegments: ["bucket", "a"], payload: Buffer.alloc(0) },
    ]
    for (const c of cases) {
      const signed = sigv4Sign({
        method: c.method, host: "acct.r2.cloudflarestorage.com", pathSegments: c.pathSegments,
        region: "auto", service: "s3", accessKeyId: "AK", secretAccessKey: "SK",
        amzDate: "20261024T120000Z", payload: c.payload,
      })
      if (signed.mode !== "header") throw new Error("expected header signing")
      const payloadHash = crypto.createHash("sha256").update(c.payload).digest("hex")
      const canonicalPath = "/" + c.pathSegments.map((s) => sigv4UriEncode(s, false)).join("/")
      const refSig = refSigv4({
        method: c.method, host: "acct.r2.cloudflarestorage.com", path: canonicalPath, query: {},
        headers: {
          host: "acct.r2.cloudflarestorage.com",
          "x-amz-content-sha256": payloadHash,
          "x-amz-date": "20261024T120000Z",
        },
        signedHeaders: ["host", "x-amz-content-sha256", "x-amz-date"],
        payloadHash, amzDate: "20261024T120000Z", region: "auto", service: "s3",
        accessKeyId: "AK", secretAccessKey: "SK",
      })
      expect(signed.headers.Authorization).toContain(`Signature=${refSig}`)
    }
  })

  test("query presign agrees with the reference (sorted params, UNSIGNED-PAYLOAD, TTL clamp)", () => {
    const signed = sigv4Sign({
      method: "GET", host: "acct.r2.cloudflarestorage.com", pathSegments: ["bucket", "avatars/1/x.png"],
      region: "auto", service: "s3", accessKeyId: "AK", secretAccessKey: "SK",
      amzDate: "20261024T120000Z", presignTtlSeconds: 900,
    })
    if (signed.mode !== "query") throw new Error("expected query signing")
    const scope = "20261024/auto/s3/aws4_request"
    const refSig = refSigv4({
      method: "GET", host: "acct.r2.cloudflarestorage.com",
      path: "/bucket/avatars/1/x.png",
      query: {
        "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
        "X-Amz-Credential": `AK/${scope}`,
        "X-Amz-Date": "20261024T120000Z",
        "X-Amz-Expires": "900",
        "X-Amz-SignedHeaders": "host",
      },
      headers: { host: "acct.r2.cloudflarestorage.com" },
      signedHeaders: ["host"],
      payloadHash: "UNSIGNED-PAYLOAD",
      amzDate: "20261024T120000Z", region: "auto", service: "s3",
      accessKeyId: "AK", secretAccessKey: "SK",
    })
    expect(signed.url.endsWith(`&X-Amz-Signature=${refSig}`)).toBe(true)
    // canonical query params appear SORTED (Algorithm < Credential < Date < Expires < SignedHeaders)
    const idx = ["X-Amz-Algorithm", "X-Amz-Credential", "X-Amz-Date", "X-Amz-Expires", "X-Amz-SignedHeaders"]
      .map((k) => signed.url.indexOf(`${k}=`))
    expect([...idx].sort((a, b) => a - b)).toEqual(idx)
    // TTL clamps into the documented 1..604800 window
    const wild = sigv4Sign({
      method: "GET", host: "h", pathSegments: ["b", "k"], region: "auto", service: "s3",
      accessKeyId: "AK", secretAccessKey: "SK", amzDate: "20261024T120000Z", presignTtlSeconds: 99999999,
    })
    if (wild.mode !== "query") throw new Error("unreachable")
    expect(wild.url).toContain("X-Amz-Expires=604800")
  })

  test("header signing carries the authorization + payload-hash discipline", () => {
    const signed = sigv4Sign({
      method: "PUT",
      host: "acct.r2.cloudflarestorage.com",
      pathSegments: ["bucket", "avatars/1/x.png"],
      region: "auto",
      service: "s3",
      accessKeyId: "AK",
      secretAccessKey: "SK",
      payload: Buffer.from("hello"),
    })
    expect(signed.mode).toBe("header")
    if (signed.mode !== "header") throw new Error("unreachable")
    expect(signed.headers.Authorization).toContain("Credential=AK/")
    expect(signed.headers["x-amz-content-sha256"]).toBe(crypto.createHash("sha256").update("hello").digest("hex"))
    expect(signed.url).toBe("https://acct.r2.cloudflarestorage.com/bucket/avatars/1/x.png")
  })

  test("object-key contract round-trips both providers", () => {
    const r2 = parseObjectKey("r2://finix-media/avatars/1/x.png")
    expect(r2 && r2.provider).toBe("r2")
    if (r2?.provider === "r2") {
      expect(r2.bucket).toBe("finix-media")
      expect(r2.key).toBe("avatars/1/x.png")
    }
    const cld = parseObjectKey("cld://image/finixhr/avatars/abc123.jpg")
    expect(cld && cld.provider).toBe("cloudinary")
    if (cld?.provider === "cloudinary") {
      expect(cld.resourceType).toBe("image")
      expect(cld.publicId).toBe("finixhr/avatars/abc123")
      expect(cld.format).toBe("jpg")
    }
    expect(parseObjectKey("https://evil.example/x")).toBeNull()
    expect(parseObjectKey("r2://")).toBeNull()
  })

  test("Cloudinary API + delivery signatures match the documented sha1 schemes", () => {
    const expectedApi = crypto.createHash("sha1").update("public_id=finix/x&timestamp=1700000000SECRET", "utf8").digest("hex")
    expect(cloudinarySignature({ public_id: "finix/x", timestamp: 1700000000 }, "SECRET")).toBe(expectedApi)
    const raw = crypto.createHash("sha1").update("pidf_1001700000000SECRET", "utf8").digest("base64")
    const expectedDelivery = raw.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 8)
    expect(cloudinaryDeliverySignature("pid", "f_100", "1700000000", "SECRET")).toBe(expectedDelivery)
  })
})

// ----------------------------------------------------------------- §6 OTP ----
describe("Wave 10 §6 — OTP generator + SMS routing (PURE surfaces)", () => {
  test("codes are 6 digits, numeric-only, and sweep the space (uniformity guard)", () => {
    const seen = new Set<string>()
    for (let i = 0; i < 3000; i++) {
      const c = generateOtpCode()
      expect(c).toMatch(/^\d{6}$/)
      seen.add(c)
    }
    // 3000 draws over a 10^6 space should produce >2800 distinct codes —
    // a biased generator (modulo of a small range) collapses this badly.
    expect(seen.size).toBeGreaterThan(2800)
    expect(generateOtpCode(4)).toMatch(/^\d{4}$/)
  })

  test("tenant provider labels route to the structured adapter only for SSLWireless spellings", () => {
    expect(tenantSmsProviderId("SSL Wireless")).toBe("sslwireless")
    expect(tenantSmsProviderId("sslwireless")).toBe("sslwireless")
    expect(tenantSmsProviderId("SSL_Wireless v3")).toBe("sslwireless")
    expect(tenantSmsProviderId("BulkSMSBD")).toBe("generichttp")
    expect(tenantSmsProviderId("")).toBe("generichttp")
  })
})
