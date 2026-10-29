// ============ Wave 10 (2026-10-24) — Cloud Object Storage abstraction ============
// Master prompt §4: centralized cloud object storage so binary payloads
// (employee avatars, documents, CMS media) stop living as base64 text inside
// PostgreSQL and move to a proper object store behind the platform.
//
// TWO providers behind ONE interface (provider-independent abstraction — the
// non-negotiable): Cloudflare R2 (S3-compatible, zero egress fees) and
// Cloudinary (built-in image optimization). Either is configured, enabled and
// live-tested from the Owner Console (Integrations → Storage).
//
// SECURITY MODEL:
//   - Credentials are stored ONLY in SaaSSetting group "storage" rows,
//     AES-256-GCM encrypted with the platform field crypto under the SEPARATE
//     context "saas-storage::v1" (a breach of the payments/MFA/camera key
//     material exposes nothing here and vice versa).
//   - The owner UI reads booleans and non-secret config only — a decrypted
//     secret NEVER leaves this module's stack frame (same masking contract as
//     saas/payments/credentials.ts).
//   - Reads that must not be public go through signedUrl() — R2 presigned GETs
//     (time-boxed) or Cloudinary signed delivery URLs; nothing sensitive is
//     ever addressed by a guessable public URL.
//   - Every stored object is journaled in StorageObject (content sha256, size,
//     mime, logical owner ref) — the console's storage panel and the tenant
//     storage-quota rollup read from it.
//   - Uploads are size-capped and the mime sniffed server-side BEFORE the PUT
//     (never trust a client-declared content type).
//
// OBJECT KEY CONTRACT (the URL is DERIVED from the key, never stored):
//   r2:        "r2://{bucket}/{objectKey}"      → publicUrl = publicBaseUrl/objectKey (when a
//                custom domain/public bucket is configured); signedUrl = presigned GET (TTL)
//   cloudinary: "cld://{resourceType}/{publicId}.{format}" → res.cloudinary.com delivery URL
//                (signed with the s--…-- scheme for tamper-proof delivery)
import crypto from "crypto"
import { z } from "zod"
import { db } from "@/lib/db"
import { encryptField, decryptField, fieldKeyConfigured } from "../crypto-field"
import { ownerAction } from "./owner-routes"
import { saasAudit } from "./audit"
import { sniffMime } from "../uploads"

export const STORAGE_CRYPTO_CONTEXT = "saas-storage::v1"
const GROUP = "storage"

// ---------------- provider credential shapes ----------------

export type R2Creds = {
  accountId: string // Cloudflare account id — hosts <id>.r2.cloudflarestorage.com
  accessKeyId: string
  secretAccessKey: string // secret
  bucket: string
  /** Optional public origin (Cloudflare Worker route / custom domain / R2
   *  public bucket) — when set, publicUrl() serves the object from it. */
  publicBaseUrl?: string
}
export type CloudinaryCreds = {
  cloudName: string
  apiKey: string
  apiSecret: string // secret
  /** Optional sub-folder under the cloud (defaults to "finixhr"). */
  folder?: string
}
export type AnyStorageCreds = R2Creds | CloudinaryCreds

const SECRET_FIELDS: Record<string, string[]> = {
  r2: ["secretAccessKey"],
  cloudinary: ["apiSecret"],
}

export const STORAGE_PROVIDER_LABELS: Record<string, string> = {
  r2: "Cloudflare R2",
  cloudinary: "Cloudinary",
}

export type StoredUpload = {
  objectKey: string
  url: string | null // public delivery URL (null when the bucket is private and no public base is set)
  signedUrl: string | null // time-limited signed URL right after the store
  sizeBytes: number
  sha256: string
  provider: string
}

// ---------------- config read/write (SaaSSetting group "storage") ----------------

type CredsCacheEntry = { at: number; enabled: boolean; creds: AnyStorageCreds | null }
const credsCache = new Map<string, CredsCacheEntry>()
const CREDS_TTL_MS = 10_000

export function invalidateStorageCredentials() {
  credsCache.clear()
}

export async function getStorageProviderConfig(providerId: string): Promise<{
  enabled: boolean
  configured: boolean
  creds: AnyStorageCreds | null
}> {
  const hit = credsCache.get(providerId)
  if (hit && Date.now() - hit.at < CREDS_TTL_MS) {
    return { enabled: hit.enabled, configured: !!hit.creds, creds: hit.creds }
  }
  const [credRow, enabledRow] = await Promise.all([
    db.saasSetting.findUnique({ where: { group_key: { group: GROUP, key: `credentials:${providerId}` } } }),
    db.saasSetting.findUnique({ where: { group_key: { group: GROUP, key: `enabled:${providerId}` } } }),
  ])
  let enabled = !!credRow
  if (enabledRow) {
    try {
      enabled = JSON.parse(enabledRow.value) === true
    } catch {
      enabled = enabledRow.value === "true"
    }
  }
  let creds: AnyStorageCreds | null = null
  if (credRow?.value && fieldKeyConfigured()) {
    try {
      const plain = decryptField(credRow.value, STORAGE_CRYPTO_CONTEXT)
      const parsed = JSON.parse(plain)
      if (parsed && typeof parsed === "object") creds = parsed as AnyStorageCreds
    } catch (e) {
      console.error(`[storage] credential decrypt failed for ${providerId}:`, e instanceof Error ? e.message : e)
    }
  }
  credsCache.set(providerId, { at: Date.now(), enabled, creds })
  return { enabled, configured: !!creds, creds }
}

/** The ACTIVE provider (SaaSSetting storage.active) — the one storeUpload()
 *  routes to. Null when storage is off (the app keeps base64 behavior). */
export async function getActiveStorage(): Promise<{ id: "r2" | "cloudinary"; creds: AnyStorageCreds } | null> {
  const activeRow = await db.saasSetting.findUnique({ where: { group_key: { group: GROUP, key: "active" } } })
  const active = String(activeRow?.value || "").toLowerCase()
  if (active !== "r2" && active !== "cloudinary") return null
  const cfg = await getStorageProviderConfig(active)
  if (!cfg.enabled || !cfg.configured || !cfg.creds) return null
  return { id: active, creds: cfg.creds }
}

export async function storageConfigured(): Promise<boolean> {
  return (await getActiveStorage()) !== null
}

// ---------------- AWS SigV4 (pure node:crypto — no AWS SDK dependency) ---------

function sha256Hex(data: string | Buffer | NodeJS.ArrayBufferView): string {
  return crypto.createHash("sha256").update(data).digest("hex")
}

function hmac(key: crypto.BinaryLike, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest()
}

/** Strict RFC-3986 URI-encode (the SigV4 canonical form keeps ONLY
 *  unreserved chars; slashes are encoded when part of a key, preserved
 *  where the caller needs path separators). PURE (unit-tested). */
export function sigv4UriEncode(value: string, encodeSlash = true): string {
  let out = ""
  for (const ch of Buffer.from(value, "utf8").toString("utf8")) {
    if (/[A-Za-z0-9\-_.~]/.test(ch)) {
      out += ch
    } else if (ch === "/" && !encodeSlash) {
      out += "/"
    } else {
      const bytes = Buffer.from(ch, "utf8")
      for (const b of bytes) out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`
    }
  }
  return out
}

export type SigV4Parts = {
  method: string
  host: string
  /** Raw (unencoded) path segments after the host — e.g. ["bucket", "a/b.png"]. */
  pathSegments: string[]
  region: string
  service: string
  accessKeyId: string
  secretAccessKey: string
  payload?: Buffer
  amzDate?: string
  presignTtlSeconds?: number
  /** Include x-amz-content-sha256 among the SIGNED headers (default true —
   *  the AWS SDK convention and required by many S3 deployments). The AWS
   *  docs' classic example vector signs host;x-amz-date only, so the option
   *  exists for fidelity testing + endpoints that reject the extra header.
   *  The payload hash ALWAYS occupies the canonical request's 6th line. */
  includeContentSha256Header?: boolean
}

export type SigV4Result =
  | { mode: "header"; url: string; headers: Record<string, string>; amzDate: string }
  | { mode: "query"; url: string }

/** Build a SigV4-signed request (header signing for uploads) or a presigned
 *  URL (query signing, UNSIGNED-PAYLOAD) for S3-compatible endpoints.
 *  PURE (unit-tested) — performs no I/O. */
export function sigv4Sign(parts: SigV4Parts): SigV4Result {
  const now = parts.amzDate ? new Date(parts.amzDate) : new Date()
  const amzDate = parts.amzDate || `${now.toISOString().slice(0, 10).replace(/-/g, "")}T${now.toISOString().slice(11, 19).replace(/:/g, "")}Z`
  const date = amzDate.slice(0, 8)
  const region = parts.region
  const service = parts.service
  // canonical URI: every segment individually encoded, "/" separators kept
  // canonical URI: every segment individually encoded ("/" inside a segment
  // stays literal per the S3 key semantics), segments joined with "/" 
  const canonicalUri = "/" + parts.pathSegments.map((s) => sigv4UriEncode(s, false)).join("/")
  const payloadHash = parts.presignTtlSeconds ? "UNSIGNED-PAYLOAD" : sha256Hex(parts.payload || Buffer.alloc(0))
  const port = parts.host.includes(":") ? parts.host.split(":")[1] : ""
  const canonicalHost = port && port !== "443" ? parts.host : parts.host.split(":")[0]

  const signedHeaders = parts.presignTtlSeconds
    ? "host"
    : parts.includeContentSha256Header === false
      ? `host;x-amz-date`
      : `host;x-amz-content-sha256;x-amz-date`
  const canonicalHeaders = parts.presignTtlSeconds
    ? `host:${canonicalHost}\n`
    : parts.includeContentSha256Header === false
      ? `host:${canonicalHost}\nx-amz-date:${amzDate}\n`
      : `host:${canonicalHost}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`

  const scope = `${date}/${region}/${service}/aws4_request`
  let canonicalQuery = ""
  let url = `https://${parts.host}${canonicalUri}`

  if (parts.presignTtlSeconds) {
    const q = new Map<string, string>([
      ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
      ["X-Amz-Credential", `${parts.accessKeyId}/${scope}`],
      ["X-Amz-Date", amzDate],
      ["X-Amz-Expires", String(Math.min(Math.max(1, parts.presignTtlSeconds), 604800))],
      ["X-Amz-SignedHeaders", signedHeaders],
    ])
    const pairs = Array.from(q.entries()).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${sigv4UriEncode(k)}=${sigv4UriEncode(v)}`)
    canonicalQuery = pairs.join("&")
    url = `${url}?${canonicalQuery}`
  }

  const canonicalRequest = [
    parts.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n")

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n")

  const kDate = hmac(`AWS4${parts.secretAccessKey}`, date)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, service)
  const kSigning = hmac(kService, "aws4_request")
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex")

  if (parts.presignTtlSeconds) {
    return { mode: "query", url: `${url}&X-Amz-Signature=${signature}` }
  }
  const headers: Record<string, string> = {
    Host: canonicalHost,
    "x-amz-date": amzDate,
    Authorization: `AWS4-HMAC-SHA256 Credential=${parts.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
  if (parts.includeContentSha256Header !== false) {
    headers["x-amz-content-sha256"] = payloadHash
  }
  return {
    mode: "header",
    url,
    amzDate,
    headers,
  }
}

// ---------------- Cloudinary helpers (signed upload + signed delivery) --------

/** Cloudinary API signature: sha1 of sorted "k=v" pairs joined by & plus the
 *  api_secret. PURE (unit-tested). */
export function cloudinarySignature(params: Record<string, string | number>, apiSecret: string): string {
  const toSign = Array.from(Object.entries(params))
    .filter(([k]) => k !== "file" && k !== "api_key")
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&") + apiSecret
  return crypto.createHash("sha1").update(toSign, "utf8").digest("hex")
}

/** Cloudinary signed delivery URL component (the documented s--…-- scheme):
 *  base64url(sha1(publicId + transformation + timestamp + apiSecret))[:8].
 *  PURE (unit-tested). */
export function cloudinaryDeliverySignature(publicId: string, transformation: string, timestamp: string, apiSecret: string): string {
  const toSign = `${publicId}${transformation}${timestamp}${apiSecret}`
  return crypto.createHash("sha1").update(toSign, "utf8").digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 8)
}

// ---------------- key contract ----------------

export type ParsedObjectKey =
  | { provider: "r2"; bucket: string; key: string }
  | { provider: "cloudinary"; resourceType: string; publicId: string; format: string }
  | null

export function parseObjectKey(objectKey: string): ParsedObjectKey {
  if (objectKey.startsWith("r2://")) {
    const rest = objectKey.slice(5)
    const slash = rest.indexOf("/")
    if (slash <= 0) return null
    return { provider: "r2", bucket: rest.slice(0, slash), key: rest.slice(slash + 1) }
  }
  if (objectKey.startsWith("cld://")) {
    const rest = objectKey.slice(6)
    const slash = rest.indexOf("/")
    if (slash <= 0) return null
    const resourceType = rest.slice(0, slash)
    const publicIdWithExt = rest.slice(slash + 1)
    const dot = publicIdWithExt.lastIndexOf(".")
    if (dot <= 0) return { provider: "cloudinary", resourceType, publicId: publicIdWithExt, format: "" }
    return { provider: "cloudinary", resourceType, publicId: publicIdWithExt.slice(0, dot), format: publicIdWithExt.slice(dot + 1) }
  }
  return null
}

// ---------------- provider operations ----------------

async function r2Put(creds: R2Creds, key: string, buf: Buffer, contentType: string): Promise<{ objectKey: string; etag: string | null }> {
  const host = `${creds.accountId}.r2.cloudflarestorage.com`
  const signed = sigv4Sign({
    method: "PUT",
    host,
    pathSegments: [creds.bucket, key],
    region: "auto",
    service: "s3",
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    payload: buf,
  })
  if (signed.mode !== "header") throw new Error("internal: expected header signing")
  const res = await fetch(signed.url, {
    method: "PUT",
    headers: { ...signed.headers, "Content-Type": contentType, "Content-Length": String(buf.length) },
    body: new Uint8Array(buf),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`R2 PUT failed (HTTP ${res.status}): ${text.slice(0, 200)}`)
  }
  return { objectKey: `r2://${creds.bucket}/${key}`, etag: res.headers.get("etag") }
}

async function r2SignedGet(creds: R2Creds, bucket: string, key: string, ttlSeconds: number): Promise<string> {
  const host = `${creds.accountId}.r2.cloudflarestorage.com`
  const signed = sigv4Sign({
    method: "GET",
    host,
    pathSegments: [bucket, key],
    region: "auto",
    service: "s3",
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    presignTtlSeconds: ttlSeconds,
  })
  if (signed.mode !== "query") throw new Error("internal: expected query signing")
  return signed.url
}

async function r2Delete(creds: R2Creds, bucket: string, key: string): Promise<void> {
  const host = `${creds.accountId}.r2.cloudflarestorage.com`
  const signed = sigv4Sign({
    method: "DELETE",
    host,
    pathSegments: [bucket, key],
    region: "auto",
    service: "s3",
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    payload: Buffer.alloc(0),
  })
  if (signed.mode !== "header") throw new Error("internal: expected header signing")
  const res = await fetch(signed.url, { method: "DELETE", headers: signed.headers, signal: AbortSignal.timeout(15_000) })
  // 204 = gone; 404 = already gone (idempotent)
  if (!res.ok && res.status !== 404) {
    throw new Error(`R2 DELETE failed (HTTP ${res.status})`)
  }
}

async function cloudinaryPut(creds: CloudinaryCreds, keyHint: string, buf: Buffer, mime: string): Promise<{ objectKey: string; url: string }> {
  const folder = (creds.folder || "finixhr").replace(/\/+$/, "")
  const publicId = `${folder}/${keyHint.replace(/[^a-zA-Z0-9/_\-]/g, "-")}`
  const timestamp = Math.floor(Date.now() / 1000)
  const signature = cloudinarySignature({ public_id: publicId, timestamp }, creds.apiSecret)
  const form = new FormData()
  form.append("file", new Blob([new Uint8Array(buf)], { type: mime }), keyHint)
  form.append("api_key", creds.apiKey)
  form.append("timestamp", String(timestamp))
  form.append("public_id", publicId)
  form.append("signature", signature)
  const res = await fetch(`https://api.cloudinary.com/v1_1/${creds.cloudName}/auto/upload`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  let json: any = null
  try {
    json = JSON.parse(text)
  } catch {
    /* handled below */
  }
  if (!res.ok || !json?.public_id || !json?.secure_url) {
    throw new Error(`Cloudinary upload failed (HTTP ${res.status}): ${String(json?.error?.message || text).slice(0, 200)}`)
  }
  // resource_type (image/raw/video/auto) + format ride the response; the key
  // encodes both so delivery URLs are fully derivable.
  const resourceType = String(json.resource_type || "image")
  const format = String(json.format || "")
  const withExt = format ? `${json.public_id}.${format}` : String(json.public_id)
  return { objectKey: `cld://${resourceType}/${withExt}`, url: String(json.secure_url) }
}

// ---------------- the storage service ----------------

export type StoreUploadInput = {
  vendorId: string
  kind: "AVATAR" | "EMPLOYEE_DOC" | "CMS_MEDIA" | "LETTER_PDF" | "EXPORT" | "SUPPORT_ATTACHMENT"
  buf: Buffer
  /** Server-side sniffed mime wins over any client-declared value. */
  declaredMime?: string
  maxBytes?: number
  refTable?: string
  refId?: string
  /** Stable key hint (employee id / media hash) — becomes part of the key. */
  keyHint?: string
}

/** Store one object on the ACTIVE provider. Journaled in StorageObject
 *  (STORED on success, FAILED + lastError on a provider error). Throws on
 *  misconfiguration/validation; provider failures mark the row and throw. */
export async function storeUpload(input: StoreUploadInput): Promise<StoredUpload> {
  const active = await getActiveStorage()
  if (!active) {
    throw Object.assign(new Error("Cloud storage is not configured on this platform (the Owner Console → Integrations → Storage panel configures it)."), { code: 400 })
  }
  if (!input.buf || input.buf.length === 0) {
    throw Object.assign(new Error("Empty upload payload."), { code: 400 })
  }
  const maxBytes = input.maxBytes || 5 * 1024 * 1024
  if (input.buf.length > maxBytes) {
    throw Object.assign(new Error(`Upload too large — ${Math.round(input.buf.length / 1024)} KB decoded, the limit is ${Math.round(maxBytes / 1024)} KB.`), { code: 400 })
  }
  const sniffed = sniffMime(input.buf)
  const mime = sniffed || (String(input.declaredMime || "").match(/^[\w.+-]+\/[\w.+-]+$/) ? String(input.declaredMime) : null)
  if (!mime) {
    throw Object.assign(new Error("Unsupported or undetectable file type."), { code: 400 })
  }
  const sha = crypto.createHash("sha256").update(input.buf).digest("hex")
  const keyHint = (input.keyHint || crypto.randomBytes(10).toString("hex")).replace(/[^a-zA-Z0-9/_\-]/g, "-").slice(0, 120)
  const objectKeyHint = `${input.kind.toLowerCase()}/${input.vendorId}/${keyHint}`

  let objectKey: string
  let publicUrl: string | null = null
  if (active.id === "r2") {
    const creds = active.creds as R2Creds
    const put = await r2Put(creds, objectKeyHint, input.buf, mime)
    objectKey = put.objectKey
    if (creds.publicBaseUrl) {
      publicUrl = `${String(creds.publicBaseUrl).replace(/\/+$/, "")}/${objectKeyHint}`
    }
  } else {
    const creds = active.creds as CloudinaryCreds
    const put = await cloudinaryPut(creds, `${objectKeyHint}`, input.buf, mime)
    objectKey = put.objectKey
    publicUrl = put.url
  }

  await db.storageObject.create({
    data: {
      vendorId: input.vendorId,
      kind: input.kind,
      objectKey,
      provider: active.id,
      mimeType: mime,
      sizeBytes: BigInt(input.buf.length),
      sha256: sha,
      status: "STORED",
      refTable: input.refTable || null,
      refId: input.refId || null,
    },
  }).catch(async (e) => {
    console.error("[storage] journal write failed:", e instanceof Error ? e.message : e)
  })

  return {
    objectKey,
    url: publicUrl,
    signedUrl: await signedObjectUrl(objectKey, 900),
    sizeBytes: input.buf.length,
    sha256: sha,
    provider: active.id,
  }
}

/** Time-limited signed read URL for one stored object (R2 presigned GET /
 *  Cloudinary signed delivery). Null when the key cannot be resolved to the
 *  configured provider. */
export async function signedObjectUrl(objectKey: string, ttlSeconds = 900): Promise<string | null> {
  const parsed = parseObjectKey(objectKey)
  if (!parsed) return null
  if (parsed.provider === "r2") {
    const cfg = await getStorageProviderConfig("r2")
    if (!cfg.creds) return null
    return r2SignedGet(cfg.creds as R2Creds, parsed.bucket, parsed.key, ttlSeconds)
  }
  const cfg = await getStorageProviderConfig("cloudinary")
  if (!cfg.creds) return null
  const creds = cfg.creds as CloudinaryCreds
  const timestamp = String(Math.floor(Date.now() / 1000))
  const sig = cloudinaryDeliverySignature(`${parsed.publicId}${parsed.format ? "." + parsed.format : ""}`, "", timestamp, creds.apiSecret)
  const ext = parsed.format ? `.${parsed.format}` : ""
  return `https://res.cloudinary.com/${creds.cloudName}/${parsed.resourceType}/upload/s--${sig}--/${parsed.publicId}${ext}`
}

/** Best-effort delete (idempotent; journal rows are kept for audit). */
export async function deleteStoredObject(objectKey: string): Promise<boolean> {
  const parsed = parseObjectKey(objectKey)
  if (!parsed) return false
  try {
    if (parsed.provider === "r2") {
      const cfg = await getStorageProviderConfig("r2")
      if (!cfg.creds) return false
      await r2Delete(cfg.creds as R2Creds, parsed.bucket, parsed.key)
    } else {
      const cfg = await getStorageProviderConfig("cloudinary")
      if (!cfg.creds) return false
      const creds = cfg.creds as CloudinaryCreds
      const timestamp = Math.floor(Date.now() / 1000)
      const signature = cloudinarySignature({ public_id: parsed.publicId, timestamp }, creds.apiSecret)
      const res = await fetch(`https://api.cloudinary.com/v1_1/${creds.cloudName}/${parsed.resourceType}/destroy`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ public_id: parsed.publicId, timestamp: String(timestamp), api_key: creds.apiKey, signature }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) return false
    }
    await db.storageObject.updateMany({ where: { objectKey }, data: { status: "FAILED", lastError: "deleted by request" } })
    return true
  } catch (e) {
    console.error("[storage] delete failed:", e instanceof Error ? e.message : e)
    return false
  }
}

/** Offload a base64 data-URL payload to the bucket and return the https URL
 *  (or the original string unchanged when storage is off / payload is already
 *  a URL). Used by the avatar/document routes — the DB column keeps a plain
 *  https URL that every existing reader already handles. */
export async function offloadDataUrl(
  vendorId: string,
  kind: StoreUploadInput["kind"],
  dataUrl: string,
  opts: { keyHint?: string; maxBytes?: number; refTable?: string; refId?: string } = {},
): Promise<string> {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) return dataUrl // URL or empty → unchanged
  if (!(await storageConfigured())) return dataUrl // storage off → historical base64 behavior
  const buf = Buffer.from(dataUrl.replace(/^data:[^;]+;base64,/, ""), "base64")
  const stored = await storeUpload({
    vendorId,
    kind,
    buf,
    declaredMime: (dataUrl.match(/^data:([^;]+);/) || [])[1],
    maxBytes: opts.maxBytes,
    keyHint: opts.keyHint,
    refTable: opts.refTable,
    refId: opts.refId,
  })
  return stored.url || dataUrl // private bucket without a public base → keep local
}

// ---------------- console stats ----------------

export async function storageStats(): Promise<{
  objects: number
  storedBytes: number
  failed: number
  last7d: { uploads: number; failures: number }
  byKind: { kind: string; count: number; bytes: number }[]
}> {
  const since7 = new Date(Date.now() - 7 * 86400000)
  const [objects, failed, uploads, failures, byKind] = await Promise.all([
    db.storageObject.aggregate({ _count: { _all: true }, _sum: { sizeBytes: true }, where: { status: "STORED" } }),
    db.storageObject.count({ where: { status: "FAILED" } }),
    db.storageObject.count({ where: { createdAt: { gte: since7 }, status: "STORED" } }),
    db.storageObject.count({ where: { createdAt: { gte: since7 }, status: "FAILED" } }),
    db.storageObject.groupBy({ by: ["kind"], where: { status: "STORED" }, _count: { _all: true }, _sum: { sizeBytes: true } }),
  ])
  return {
    objects: Number(objects._count?._all || 0),
    storedBytes: Number(objects._sum?.sizeBytes || 0),
    failed,
    last7d: { uploads, failures },
    byKind: byKind.map((r) => ({ kind: r.kind, count: Number(r._count?._all || 0), bytes: Number(r._sum?.sizeBytes || 0) })),
  }
}

// ---------------- owner console actions (self-registered) ----------------

function maskStorageConfig(providerId: string, cfg: { enabled: boolean; configured: boolean; creds: AnyStorageCreds | null }) {
  const secrets = SECRET_FIELDS[providerId] || []
  const c: any = cfg.creds || {}
  const masked: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(c)) {
    if (secrets.includes(k)) masked[`has${k.charAt(0).toUpperCase()}${k.slice(1)}`] = !!v
    else masked[k] = v
  }
  return {
    id: providerId,
    label: STORAGE_PROVIDER_LABELS[providerId] || providerId,
    enabled: cfg.enabled,
    configured: cfg.configured,
    credentials: masked,
  }
}

const credsSchemas: Record<string, z.ZodType<any, any>> = {
  r2: z.object({
    accountId: z.string().trim().max(80).optional(),
    accessKeyId: z.string().trim().max(120).optional(),
    secretAccessKey: z.string().max(200).optional(), // empty = keep existing
    bucket: z.string().trim().max(120).optional(),
    publicBaseUrl: z.string().trim().max(300).optional(),
  }),
  cloudinary: z.object({
    cloudName: z.string().trim().max(120).optional(),
    apiKey: z.string().trim().max(120).optional(),
    apiSecret: z.string().max(200).optional(), // empty = keep existing
    folder: z.string().trim().max(120).optional(),
  }),
}

ownerAction("owner.storage.get", {
  perm: "settings.view",
  handler: async () => {
    const providers = []
    for (const id of Object.keys(STORAGE_PROVIDER_LABELS)) {
      providers.push(maskStorageConfig(id, await getStorageProviderConfig(id)))
    }
    const activeRow = await db.saasSetting.findUnique({ where: { group_key: { group: GROUP, key: "active" } } })
    return {
      providers,
      active: activeRow?.value || null,
      encryptionKeyConfigured: fieldKeyConfigured(),
      stats: await storageStats().catch(() => null),
    }
  },
})

ownerAction("owner.storage.save", {
  perm: "settings.manage",
  schema: z.object({
    provider: z.enum(["r2", "cloudinary"]),
    enabled: z.boolean().optional(),
    active: z.boolean().optional(),
    credentials: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
  handler: async (ctx, p) => {
    if (p.active && !fieldKeyConfigured()) {
      throw Object.assign(new Error("Server encryption key (HRM_MFA_KEY) is not configured — storage credentials cannot be stored."), { code: 500 })
    }
    const schema = credsSchemas[p.provider]
    if (!schema) throw Object.assign(new Error(`Unknown storage provider: ${p.provider}`), { code: 400 })
    const cur = await getStorageProviderConfig(p.provider)
    const merged: Record<string, string> = { ...(cur.creds as any) }
    if (p.credentials) {
      const parsed = schema.safeParse(p.credentials)
      if (!parsed.success) {
        const issue = parsed.error.issues?.[0]
        throw Object.assign(new Error(`Invalid credentials: ${issue?.path?.join(".") || ""} ${issue?.message || ""}`), { code: 400 })
      }
      for (const [k, v] of Object.entries(parsed.data)) {
        if (v === undefined) continue
        const asStr = String(v ?? "")
        const isSecret = (SECRET_FIELDS[p.provider] || []).includes(k)
        if (isSecret && asStr === "") continue // keep existing secret
        if (asStr === "" && !isSecret) {
          delete merged[k]
          continue
        }
        merged[k] = asStr
      }
    }
    if (Object.keys(merged).length > 0) {
      if (!fieldKeyConfigured()) {
        throw Object.assign(new Error("Server encryption key (HRM_MFA_KEY) is not configured — storage credentials cannot be stored. Configure the deployment key first."), { code: 500 })
      }
      const encrypted = encryptField(JSON.stringify(merged), STORAGE_CRYPTO_CONTEXT)
      await db.saasSetting.upsert({
        where: { group_key: { group: GROUP, key: `credentials:${p.provider}` } },
        create: { group: GROUP, key: `credentials:${p.provider}`, value: encrypted },
        update: { value: encrypted },
      })
    }
    if (p.enabled !== undefined) {
      await db.saasSetting.upsert({
        where: { group_key: { group: GROUP, key: `enabled:${p.provider}` } },
        create: { group: GROUP, key: `enabled:${p.provider}`, value: JSON.stringify(p.enabled) },
        update: { value: JSON.stringify(p.enabled) },
      })
    }
    // activating REQUIRES configured + enabled credentials (belt: getActiveStorage re-checks anyway)
    if (p.active) {
      const after = await getStorageProviderConfig(p.provider)
      if (!after.configured) {
        throw Object.assign(new Error("Cannot activate a provider without complete credentials."), { code: 400 })
      }
      await db.saasSetting.upsert({
        where: { group_key: { group: GROUP, key: "active" } },
        create: { group: GROUP, key: "active", value: p.provider },
        update: { value: p.provider },
      })
    } else if (p.active === false) {
      await db.saasSetting.upsert({
        where: { group_key: { group: GROUP, key: "active" } },
        create: { group: GROUP, key: "active", value: "" },
        update: { value: "" },
      })
    }
    invalidateStorageCredentials()
    const after = await getStorageProviderConfig(p.provider)
    await saasAudit(ctx, "STORAGE_PROVIDER_SETTINGS_CHANGED", "SaaSSetting", null,
      `Storage provider "${p.provider}" settings updated (enabled: ${after.enabled ? "yes" : "no"}${p.active ? ", ACTIVATED" : ""})`,
      { metadata: { provider: p.provider, before: maskStorageConfig(p.provider, cur), after: maskStorageConfig(p.provider, after) } })
    return { provider: maskStorageConfig(p.provider, after) }
  },
})

ownerAction("owner.storage.test", {
  perm: "settings.manage",
  handler: async (ctx) => {
    const active = await getActiveStorage()
    if (!active) {
      throw Object.assign(new Error("No active storage provider — configure and activate one first (Integrations → Storage)."), { code: 400 })
    }
    const probe = Buffer.from(`finix-hr storage probe ${new Date().toISOString()}`, "utf8")
    const t0 = Date.now()
    try {
      const stored = await storeUpload({
        vendorId: "platform",
        kind: "CMS_MEDIA",
        buf: probe,
        declaredMime: "text/plain",
        keyHint: `probe-${Date.now()}`,
        maxBytes: 64 * 1024,
        refTable: "StorageProbe",
      })
      const signed = await signedObjectUrl(stored.objectKey, 300)
      await deleteStoredObject(stored.objectKey)
      const ms = Date.now() - t0
      await saasAudit(ctx, "STORAGE_PROVIDER_TESTED", "SaaSSetting", null,
        `Storage provider "${active.id}" live test passed in ${ms} ms (probe stored, signed and deleted).`,
        { metadata: { provider: active.id, ms, objectKey: stored.objectKey } })
      return { ok: true, provider: active.id, ms, objectKey: stored.objectKey, publicUrl: stored.url, signedUrlReachable: !!signed }
    } catch (e: any) {
      await saasAudit(ctx, "STORAGE_PROVIDER_TEST_FAILED", "SaaSSetting", null,
        `Storage provider "${active.id}" live test FAILED: ${String(e?.message || e).slice(0, 200)}`,
        { metadata: { provider: active.id } })
      throw Object.assign(new Error(`Storage test failed: ${String(e?.message || e).slice(0, 250)}`), { code: 400 })
    }
  },
})
