// ============ Wave 10 INFRASTRUCTURE verification (no DB required) ============
// Standalone runner for the PURE-function regressions of the Wave 10 round
// (mirrors tests/unit/wave10-infra.test.ts assertions). Unlike the bun-test
// suite it does NOT need the isolated test PostgreSQL database — the modules
// under test construct their PrismaClient lazily and never query on these
// paths — so it can gate packaging on any machine:
//   DATABASE_URL=postgresql://x:x@127.0.0.1:5432/x bun run scripts/verify-wave10.ts
import crypto from "crypto"
import {
  supportPermissionsFor, supportAccessActionAllowed, SUPPORT_WRITE_CATALOG, SUPPORT_ALWAYS_ACTIONS,
} from "../src/hrm-server/saas/support-access"
import { epsXHash } from "../src/hrm-server/saas/payments/eps"
import { mapTrxStatus } from "../src/hrm-server/saas/payments/paystation"
import { PAYMENT_PROVIDER_IDS, getPaymentProvider } from "../src/hrm-server/saas/payments/registry"
import { sigv4Sign, sigv4UriEncode, parseObjectKey, cloudinarySignature, cloudinaryDeliverySignature } from "../src/hrm-server/saas/storage"
import { generateOtpCode } from "../src/hrm-server/saas/otp"
import { tenantSmsProviderId } from "../src/hrm-server/gateway"
import { MODULES } from "../src/hrm-server/types"

let failures = 0
let checks = 0
function ok(name: string, cond: boolean) {
  checks++
  if (!cond) {
    failures++
    console.error(`  ✗ ${name}`)
  }
}
function eq(name: string, actual: unknown, expected: unknown) {
  ok(name, actual === expected)
  if (actual !== expected) console.error(`      expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`)
}

const RO = { accessMode: "READ_ONLY" as const, scope: [] as string[] }
const CW = (scope: string[]) => ({ accessMode: "CONTROLLED_WRITE" as const, scope })

console.log("§2 support-access policy")
{
  const perms = supportPermissionsFor("READ_ONLY", [])
  eq("read surface = every module *.view", perms.size, MODULES.length)
  for (const m of MODULES) ok(`has ${m}.view`, perms.has(`${m}.view`))
  ok("no mutating verb on read-only", Array.from(perms).every((p) => p.endsWith(".view")))

  const cw = supportPermissionsFor("CONTROLLED_WRITE", ["attendance.edit", "jobs.manage"])
  ok("scoped grant attendance.edit", cw.has("attendance.edit"))
  ok("scoped grant jobs.manage", cw.has("jobs.manage"))
  ok("catalog entry NOT in scope stays out", !cw.has("attendance.create"))
  ok("never-catalogued verb stays out", !cw.has("payroll.edit"))

  for (const banned of ["payroll.", "users.", "settings.", "billing.", "employees.", "approvals."]) {
    ok(`catalog bans ${banned}*`, !Array.from(SUPPORT_WRITE_CATALOG).some((c) => c.startsWith(banned)))
  }

  ok("view passes (read-only)", supportAccessActionAllowed({ action: "employees.list", permModule: "employees", permVerb: "view", ...RO }).allowed)
  ok("pay refused outside scope", !supportAccessActionAllowed({ action: "payroll.runs.pay", permModule: "payroll", permVerb: "pay", ...CW(["attendance.edit"]) }).allowed)
  ok("scoped edit passes", supportAccessActionAllowed({ action: "attendance.edit", permModule: "attendance", permVerb: "edit", ...CW(["attendance.edit"]) }).allowed)
  ok("read-only never mutates (scope smuggling)", !supportAccessActionAllowed({ action: "attendance.edit", permModule: "attendance", permVerb: "edit", accessMode: "READ_ONLY", scope: ["attendance.edit"] }).allowed)
  ok("export hard-denied even if smuggled into scope", !supportAccessActionAllowed({ action: "employees.export", permModule: "employees", permVerb: "export", ...CW(["employees.export" as never]) }).allowed)
  eq("auth.me always-allowed", SUPPORT_ALWAYS_ACTIONS.has("auth.me"), true)
  eq("auth.supportExit always-allowed", SUPPORT_ALWAYS_ACTIONS.has("auth.supportExit"), true)
  ok("MFA enroll refused", !supportAccessActionAllowed({ action: "auth.mfa.enroll", ...RO }).allowed)
  ok("self-scoped ess.profile refused", !supportAccessActionAllowed({ action: "ess.profile", ...RO }).allowed)
}

console.log("§3 payments adapters")
{
  for (const id of ["sslcommerz", "bkash", "nagad", "paystation", "eps"]) {
    eq(`registry has ${id}`, PAYMENT_PROVIDER_IDS.includes(id), true)
    eq(`resolver id ${id}`, getPaymentProvider(id)?.id ?? null, id)
  }
  eq("unknown gateway null", getPaymentProvider("unknown-gateway"), null)
  eq("map success", mapTrxStatus("success"), "PAID")
  eq("map Success (case)", mapTrxStatus("Success"), "PAID")
  eq("map processing", mapTrxStatus("processing"), "PENDING")
  eq("map failed", mapTrxStatus("failed"), "FAILED")
  eq("map refund → FAILED", mapTrxStatus("refund"), "FAILED")
  eq("map cancelled", mapTrxStatus("cancelled"), "CANCELLED")
  eq("map empty → PENDING", mapTrxStatus(""), "PENDING")
  const key = "FHZxyzeps56789gfhg678ygu876o="
  eq("eps x-hash = base64(HMAC-SHA512(key, data))", epsXHash(key, "user@example.com"),
    crypto.createHmac("sha512", key).update("user@example.com", "utf8").digest("base64"))
  ok("eps x-hash payload-sensitive", epsXHash("key", "a") !== epsXHash("key", "b"))
}

console.log("§4 storage signing + key contract")
{
  eq("strict URI encode", sigv4UriEncode("a/b c.png"), "a%2Fb%20c.png")
  eq("slash-preserving encode", sigv4UriEncode("a/b c.png", false), "a/b%20c.png")
  eq("unreserved untouched", sigv4UriEncode("A-z09_.~"), "A-z09_.~")
  eq("utf8 percent-encoded", sigv4UriEncode("ünï"), "%C3%BCn%C3%AF")

  // Reference implementation straight from the AWS SigV4 documentation —
  // agreement across the matrix proves the production canonicalization.
  const refSigv4 = (p: {
    method: string; host: string; path: string; query: Record<string, string>
    headers: Record<string, string>; signedHeaders: string[]; payloadHash: string
    amzDate: string; region: string; service: string; accessKeyId: string; secretAccessKey: string
  }): string => {
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

  const matrix = [
    { method: "GET", pathSegments: ["test.txt"], payload: Buffer.alloc(0) },
    { method: "PUT", pathSegments: ["bucket", "avatars/1/x.png"], payload: Buffer.from("hello") },
    { method: "PUT", pathSegments: ["bucket", "ünï dir/f.txt"], payload: Buffer.from("unicode-ünï-payload") },
    { method: "DELETE", pathSegments: ["bucket", "a"], payload: Buffer.alloc(0) },
  ]
  for (const c of matrix) {
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
      headers: { host: "acct.r2.cloudflarestorage.com", "x-amz-content-sha256": payloadHash, "x-amz-date": "20261024T120000Z" },
      signedHeaders: ["host", "x-amz-content-sha256", "x-amz-date"],
      payloadHash, amzDate: "20261024T120000Z", region: "auto", service: "s3",
      accessKeyId: "AK", secretAccessKey: "SK",
    })
    ok(`header matrix ${c.method} ${c.pathSegments.join("/")} matches reference`, signed.headers.Authorization.includes(`Signature=${refSig}`))
  }

  const q = sigv4Sign({
    method: "GET", host: "acct.r2.cloudflarestorage.com", pathSegments: ["bucket", "avatars/1/x.png"],
    region: "auto", service: "s3", accessKeyId: "AK", secretAccessKey: "SK",
    amzDate: "20261024T120000Z", presignTtlSeconds: 900,
  })
  if (q.mode !== "query") throw new Error("expected query signing")
  const refQ = refSigv4({
    method: "GET", host: "acct.r2.cloudflarestorage.com", path: "/bucket/avatars/1/x.png",
    query: {
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": "AK/20261024/auto/s3/aws4_request",
      "X-Amz-Date": "20261024T120000Z",
      "X-Amz-Expires": "900",
      "X-Amz-SignedHeaders": "host",
    },
    headers: { host: "acct.r2.cloudflarestorage.com" }, signedHeaders: ["host"],
    payloadHash: "UNSIGNED-PAYLOAD", amzDate: "20261024T120000Z", region: "auto", service: "s3",
    accessKeyId: "AK", secretAccessKey: "SK",
  })
  eq("presign matches reference", q.url.endsWith(`&X-Amz-Signature=${refQ}`), true)
  const order = ["X-Amz-Algorithm", "X-Amz-Credential", "X-Amz-Date", "X-Amz-Expires", "X-Amz-SignedHeaders"].map((k) => q.url.indexOf(`${k}=`))
  ok("presign params sorted", JSON.stringify([...order].sort((a, b) => a - b)) === JSON.stringify(order))
  const wild = sigv4Sign({
    method: "GET", host: "h", pathSegments: ["b", "k"], region: "auto", service: "s3",
    accessKeyId: "AK", secretAccessKey: "SK", amzDate: "20261024T120000Z", presignTtlSeconds: 99999999,
  })
  if (wild.mode !== "query") throw new Error("unreachable")
  ok("presign TTL clamped to 604800", wild.url.includes("X-Amz-Expires=604800"))

  const put = sigv4Sign({
    method: "PUT",
    host: "acct.r2.cloudflarestorage.com",
    pathSegments: ["bucket", "avatars/1/x.png"],
    region: "auto",
    service: "s3",
    accessKeyId: "AK",
    secretAccessKey: "SK",
    payload: Buffer.from("hello"),
  })
  if (put.mode !== "header") throw new Error("expected header signing")
  eq("payload hash = sha256(body)", put.headers["x-amz-content-sha256"], crypto.createHash("sha256").update("hello").digest("hex"))
  eq("header URL", put.url, "https://acct.r2.cloudflarestorage.com/bucket/avatars/1/x.png")

  const r2 = parseObjectKey("r2://finix-media/avatars/1/x.png")
  ok("r2 key parses", !!r2 && r2.provider === "r2")
  if (r2?.provider === "r2") {
    eq("r2 bucket", r2.bucket, "finix-media")
    eq("r2 key", r2.key, "avatars/1/x.png")
  }
  const cld = parseObjectKey("cld://image/finixhr/avatars/abc123.jpg")
  ok("cld key parses", !!cld && cld.provider === "cloudinary")
  if (cld?.provider === "cloudinary") {
    eq("cld resourceType", cld.resourceType, "image")
    eq("cld publicId", cld.publicId, "finixhr/avatars/abc123")
    eq("cld format", cld.format, "jpg")
  }
  eq("foreign scheme rejected", parseObjectKey("https://evil.example/x"), null)
  eq("malformed r2 rejected", parseObjectKey("r2://"), null)

  eq("cloudinary API signature",
    cloudinarySignature({ public_id: "finix/x", timestamp: 1700000000 }, "SECRET"),
    crypto.createHash("sha1").update("public_id=finix/x&timestamp=1700000000SECRET", "utf8").digest("hex"))
  const rawB64 = crypto.createHash("sha1").update("pidf_1001700000000SECRET", "utf8").digest("base64")
  eq("cloudinary delivery signature (base64url[:8])",
    cloudinaryDeliverySignature("pid", "f_100", "1700000000", "SECRET"),
    rawB64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 8))
}

console.log("§6 OTP + SMS routing")
{
  const seen = new Set<string>()
  let shapeOk = true
  for (let i = 0; i < 3000; i++) {
    const c = generateOtpCode()
    if (!/^\d{6}$/.test(c)) shapeOk = false
    seen.add(c)
  }
  ok("3000 codes are 6-digit numeric", shapeOk)
  ok("distinct-code count > 2800 (uniformity guard)", seen.size > 2800)
  ok("4-digit variant shape", /^\d{4}$/.test(generateOtpCode(4)))

  eq("label 'SSL Wireless' → adapter", tenantSmsProviderId("SSL Wireless"), "sslwireless")
  eq("label 'sslwireless' → adapter", tenantSmsProviderId("sslwireless"), "sslwireless")
  eq("label 'SSL_Wireless v3' → adapter", tenantSmsProviderId("SSL_Wireless v3"), "sslwireless")
  eq("label 'BulkSMSBD' → generic", tenantSmsProviderId("BulkSMSBD"), "generichttp")
  eq("empty label → generic", tenantSmsProviderId(""), "generichttp")
}

console.log(`\n${checks} assertions, ${failures} failure(s)`)
if (failures > 0) {
  process.exit(1)
}
console.log("Wave 10 pure-function verification PASSED")
