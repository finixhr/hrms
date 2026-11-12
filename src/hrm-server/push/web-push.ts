// ============ Web Push transport (RFC 8030 / 8291 / 8292) — Phase 5 P6 WS-C ============
// In-house implementation of the Web Push protocol on Node's crypto — ZERO
// new dependencies (the platform's supply-chain rule since Phase 1):
//
//   · RFC 8291 — message encryption for push ("aes128gcm" content coding):
//     ECDH on P-256 with the subscription's p256dh key + auth secret, the
//     "WebPush: info" context binding BOTH public keys, HKDF-derived
//     AES-128-GCM CEK (16) + nonce (12), body = salt(16) || rs(4=4096) ||
//     keyid-len(1) || ephemeral-public(65) || ciphertext.
//   · RFC 8292 — VAPID: an ES256 (P-256 ECDSA) JWT proving the sender's
//     identity to the push service; Authorization: vapid t=<jwt>, k=<b64url
//     public key>. The JWS signature is raw r||s (IEEE P1363), which Node
//     signs natively via dsaEncoding: "ieee-p1363".
//
// Everything is verifiable offline: the RFC 8291 receiver side (ECDH with
// the subscription's OWN private key) is implemented in the test suite to
// prove the derivation round-trips exactly, and the VAPID JWT's signature is
// verified against the signing public key with Node's own verifier.
import crypto from "crypto"

// ---------- base64url helpers ----------

export function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function b64urlToBuf(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4))
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64")
}

// ---------- VAPID keypairs (RFC 8292 §3) ----------

export type VapidKeyPair = {
  /** base64url(uncompressed 65-byte public key: 0x04 || X || Y) */
  publicKey: string
  /** base64url(32-byte private scalar) */
  privateKey: string
}

/** Generate a fresh P-256 VAPID keypair (server-side, once per vendor). */
export function generateVapidKeyPair(): VapidKeyPair {
  const ecdh = crypto.createECDH("prime256v1")
  ecdh.generateKeys()
  return {
    publicKey: b64url(Buffer.from(ecdh.getPublicKey())),
    privateKey: b64url(ecdh.getPrivateKey()),
  }
}

/**
 * Sign the VAPID JWT (ES256) for an audience. `audience` is the push
 * service's ORIGIN (scheme://host[:port]); `subject` is a mailto: or https:
 * contact REQUIRED by the RFC.
 */
export function signVapidJwt(opts: {
  privateKeyB64url: string
  publicKeyB64url: string
  audience: string
  subject: string
  expirationSeconds?: number
}): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })))
  const expires = Math.floor(Date.now() / 1000) + (opts.expirationSeconds ?? 12 * 60 * 60)
  const payload = b64url(Buffer.from(JSON.stringify({
    aud: opts.audience,
    exp: expires,
    sub: opts.subject,
  })))
  const signingInput = `${header}.${payload}`
  const pub = b64urlToBuf(opts.publicKeyB64url)
  const keyObject = crypto.createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: b64url(pub.subarray(1, 33)),
      y: b64url(pub.subarray(33, 65)),
      d: opts.privateKeyB64url,
    },
    format: "jwk",
  })
  const sig = crypto.sign("sha256", Buffer.from(signingInput), { key: keyObject, dsaEncoding: "ieee-p1363" })
  return `${signingInput}.${b64url(sig)}`
}

/** Verify a VAPID JWT (test/offline verification of our own signing). */
export function verifyVapidJwt(jwt: string, publicKeyB64url: string): { ok: boolean; payload?: Record<string, unknown> } {
  try {
    const [h, p, s] = jwt.split(".")
    if (!h || !p || !s) return { ok: false }
    const header = JSON.parse(b64urlToBuf(h).toString("utf8"))
    if (header.alg !== "ES256") return { ok: false }
    const pub = b64urlToBuf(publicKeyB64url)
    const keyObject = crypto.createPublicKey({
      key: { kty: "EC", crv: "P-256", x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)) },
      format: "jwk",
    })
    const ok = crypto.verify("sha256", Buffer.from(`${h}.${p}`), { key: keyObject, dsaEncoding: "ieee-p1363" }, b64urlToBuf(s))
    if (!ok) return { ok: false }
    return { ok: true, payload: JSON.parse(b64urlToBuf(p).toString("utf8")) }
  } catch {
    return { ok: false }
  }
}

// ---------- RFC 8291 message encryption (aes128gcm content coding) ----------

export type PushSubscriptionKeys = {
  endpoint: string
  /** base64url subscription public key (uncompressed P-256 point, 65 bytes) */
  p256dh: string
  /** base64url 16-byte auth secret */
  auth: string
}

export type EncodedPush = {
  /** the raw binary body (salt||rs||keyid||ciphertext) */
  body: Buffer
  /** the Content-Encoding header value */
  contentEncoding: "aes128gcm"
}

/**
 * Encrypt a UTF-8 payload for ONE subscription per RFC 8291 §3.1:
 *
 *   ikm      = ECDH(ephemeral_server_private, ua_public)          (32 bytes)
 *   prk_key  = HKDF(salt = ua_auth_secret, ikm,
 *                   info = "WebPush: info"||0x00||ua_public||as_public, 32)
 *   cek      = HKDF(salt = 0^16, prk_key,
 *                   info = "Content-Encoding: aes128gcm"||0x00, 16)
 *   nonce    = HKDF(salt = 0^16, prk_key,
 *                   info = "Content-Encoding: nonce"||0x00, 12)
 *   ct       = AES-128-GCM(cek, nonce, plaintext || 0x02 || padding)
 *   body     = salt(16) || rs(4 = 4096, BE) || idlen(1 = 65)
 *              || as_public(65) || ct
 *
 * (crypto.hkdfSync(digest, ikm, salt, info, len) IS extract-then-expand,
 * so the three HKDF lines map directly.)
 */
export function encryptPushPayload(payload: string, sub: PushSubscriptionKeys): EncodedPush {
  const uaPublic = b64urlToBuf(sub.p256dh)
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
    throw new Error("Invalid subscription p256dh key (expected a 65-byte uncompressed P-256 point)")
  }
  const authSecret = b64urlToBuf(sub.auth)
  if (authSecret.length !== 16) {
    throw new Error("Invalid subscription auth secret (expected 16 bytes)")
  }

  // ephemeral server key agreement
  const eph = crypto.createECDH("prime256v1")
  eph.generateKeys()
  const asPublic = Buffer.from(eph.getPublicKey()) // 65 bytes uncompressed
  const ikm = eph.computeSecret(uaPublic)

  // HKDF 1 — the "WebPush: info" context binds the derivation to BOTH keys
  const webPushInfo = Buffer.concat([
    Buffer.from("WebPush: info\0"),
    uaPublic,
    asPublic,
  ])
  const prkKey = Buffer.from(crypto.hkdfSync("sha256", ikm, authSecret, webPushInfo, 32))

  // HKDF 2/3 — the content-coding keys (salt = 16 zero bytes per the RFC)
  const zeroSalt = Buffer.alloc(16)
  const cek = Buffer.from(crypto.hkdfSync("sha256", prkKey, zeroSalt, Buffer.from("Content-Encoding: aes128gcm\0"), 16))
  const nonce = Buffer.from(crypto.hkdfSync("sha256", prkKey, zeroSalt, Buffer.from("Content-Encoding: nonce\0"), 12))

  // plaintext || delimiter 0x02 || zero padding (none)
  const plaintext = Buffer.concat([Buffer.from(payload, "utf8"), Buffer.from([0x02])])
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])

  const salt = crypto.randomBytes(16)
  const rs = Buffer.alloc(4)
  rs.writeUInt32BE(4096)
  const idlen = Buffer.from([asPublic.length])

  return {
    body: Buffer.concat([salt, rs, idlen, asPublic, ciphertext]),
    contentEncoding: "aes128gcm",
  }
}

// ---------- the POST ----------

export type SendWebPushOptions = {
  vapidPublicKey: string
  vapidPrivateKey: string
  /** RFC-mandatory contact (mailto: or https:) */
  vapidSubject?: string
  ttlSeconds?: number
  urgency?: "very-low" | "low" | "normal" | "high"
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export type SendWebPushResult = {
  ok: boolean
  status: number
  /** 404/410 → the subscription is GONE (the caller must delete the row) */
  gone: boolean
  error?: string
}

/**
 * Push one payload to one subscription. Never throws — network/protocol
 * failures come back as { ok: false, status } so dispatch can decide
 * (delete the row on gone, keep it otherwise).
 */
export async function sendWebPush(payload: string, sub: PushSubscriptionKeys, opts: SendWebPushOptions): Promise<SendWebPushResult> {
  let encoded: EncodedPush
  try {
    encoded = encryptPushPayload(payload, sub)
  } catch (e: any) {
    return { ok: false, status: 0, gone: false, error: `encrypt: ${e?.message || e}` }
  }
  // VAPID audience = the push service's origin
  let audience: string
  try {
    const u = new URL(sub.endpoint)
    audience = `${u.protocol}//${u.host}`
  } catch {
    return { ok: false, status: 0, gone: false, error: "invalid endpoint URL" }
  }
  let authorization: string
  try {
    const jwt = signVapidJwt({
      privateKeyB64url: opts.vapidPrivateKey,
      publicKeyB64url: opts.vapidPublicKey,
      audience,
      subject: opts.vapidSubject || "mailto:admin@finix-hr.local",
    })
    authorization = `vapid t=${jwt}, k=${opts.vapidPublicKey}`
  } catch (e: any) {
    return { ok: false, status: 0, gone: false, error: `vapid: ${e?.message || e}` }
  }

  const doFetch = opts.fetchImpl || (typeof fetch === "function" ? fetch : undefined)
  if (!doFetch) return { ok: false, status: 0, gone: false, error: "no fetch implementation" }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000)
  try {
    const res = await doFetch(sub.endpoint, {
      method: "POST",
      headers: {
        "Content-Encoding": encoded.contentEncoding,
        "Content-Type": "application/octet-stream",
        "TTL": String(opts.ttlSeconds ?? 24 * 60 * 60),
        "Urgency": opts.urgency || "normal",
        "Authorization": authorization,
      },
      // Uint8Array view of the body — Buffer is a Uint8Array but the DOM
      // BodyInit typing wants the base type (bun/node accept both)
      body: new Uint8Array(encoded.body),
      signal: controller.signal,
    })
    const gone = res.status === 404 || res.status === 410
    return { ok: res.status >= 200 && res.status < 300, status: res.status, gone }
  } catch (e: any) {
    return { ok: false, status: 0, gone: false, error: `network: ${e?.name === "AbortError" ? "timeout" : e?.message || e}` }
  } finally {
    clearTimeout(timer)
  }
}
