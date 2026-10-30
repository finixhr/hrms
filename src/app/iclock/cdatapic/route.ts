// ============ ADMS endpoint: /iclock/cdatapic (punch photo upload) ============
// On devices with cameras (SpeedFace V5L, SenseFace 3A, ProFace X TI), the
// terminal can upload a snapshot taken at the moment of each punch. The device
// posts the binary JPEG/PNG body with query params:
//   ?SN=<serial>&pin=<user_pin>&stime=<YYYY-MM-DD HH:MM:SS>&index=<seq>
// Server ACKs with `OK\n`. Photo persistence is opt-in via ADMS_PHOTO_FUN=true.
//
// H-13 hardening (path traversal):
//   - `pin` is validated against ^[0-9A-Za-z_-]{1,32}$ BEFORE any use —
//     traversal payloads (../, %2e%2e%2f, absolute paths) get 400.
//   - Files are stored under a SERVER-GENERATED random name (UUID); the pin
//     lives in metadata (comm log) only, never in the filesystem path.
//   - The final path is resolved and asserted to stay INSIDE the photo root.
//   - Only real JPEG/PNG magic-byte images are persisted.
//
// H-12: body capped at 2 MB, enforced BEFORE the body is read.
//
// Path is HARD-CODED in ZKTeco firmware — cannot be reconfigured.
import { NextRequest } from "next/server"
import { resolveDevice, snRateLimited, rateLimited, logComm, recordPunchPhoto, GATEWAY_ENV, bodyCapExceeded, BODY_CAP_PHOTO, deviceClientIp } from "@/hrm-server/zkteco/gateway"
import { ackOk, admsError, isValidPhotoPin, punchPhotoDir, isImageMagic } from "@/hrm-server/zkteco/adapter"
import { writeFile, mkdir } from "fs/promises"
import { join } from "path"
import { randomUUID } from "crypto"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const BASE = "/iclock/cdatapic"
const PHOTO_ROOT = join(process.cwd(), "storage", "punch-photos")

// SEC-4 (Phase 1) — trust-gated client IP from the shared device-plane helper:
// X-Forwarded-For is only honored behind a configured trusted proxy
// (HRM_TRUST_PROXY=1); the old unconditional read let any direct caller mint
// fresh per-IP rate buckets and fake audit IPs.
function clientIp(req: NextRequest): string {
  return deviceClientIp(req)
}

function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } })
}

export async function POST(req: NextRequest) {
  const t0 = Date.now()
  const ip = clientIp(req)
  if (!GATEWAY_ENV.enabled()) return text(admsError("ADMS gateway disabled"), 503)
  if (rateLimited(ip)) return text(admsError("rate limit exceeded"), 429)

  const sn = req.nextUrl.searchParams.get("SN")
  if (sn && snRateLimited(sn)) return text(admsError("device rate limit exceeded"), 429)
  // C-03 — authentication = pre-registered SN + comm key (ZKTeco firmware
  // sends it as the `pushcommkey` query param). Keyless devices only pass
  // when the vendor admin setting Allow Keyless Devices is enabled
  // (Settings → Devices); otherwise they are rejected with 401.
  const auth = await resolveDevice(sn, req.nextUrl.searchParams.get("pushcommkey"), { endpointProtocol: "ADMS" })
  if (!auth.ok) {
    await logComm({
      vendorId: auth.vendorId || "UNKNOWN", serial: sn || "—", endpoint: BASE, requestType: "REJECTED",
      httpStatus: auth.code, ok: false, error: auth.reason, ip,
    })
    return text(admsError(auth.reason), auth.code)
  }

  // H-13 — validate the pin BEFORE it is used anywhere (400 on traversal)
  const pin = req.nextUrl.searchParams.get("pin") || ""
  if (!isValidPhotoPin(pin)) {
    await logComm({
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): convert to an explicit null check
      vendorId: auth.device.vendorId, deviceId: auth.device.id, serial: sn!, endpoint: BASE,
      requestType: "REJECTED", httpStatus: 400, ok: false,
      error: `INVALID_PIN: ${String(pin).slice(0, 40)}`, ip,
    })
    return text(admsError("invalid pin"), 400)
  }
  const stime = req.nextUrl.searchParams.get("stime") || new Date().toISOString().slice(0, 19).replace("T", " ")

  // H-12 — 2 MB cap enforced BEFORE the body is read.
  if (bodyCapExceeded(req, BODY_CAP_PHOTO)) {
    await logComm({
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): convert to an explicit null check
      vendorId: auth.device.vendorId, deviceId: auth.device.id, serial: sn!, endpoint: BASE,
      requestType: "REJECTED", httpStatus: 413, ok: false,
      error: `BODY_TOO_LARGE: content-length > ${BODY_CAP_PHOTO} bytes (or missing)`, ip,
    })
    return text(admsError("request body too large"), 413)
  }

  // Read the raw binary body. Could be image/jpeg, image/png, or multipart.
  let buf: Buffer
  try {
    buf = Buffer.from(await req.arrayBuffer())
  } catch {
    return text(admsError("unreadable body"), 400)
  }
  if (buf.length === 0) return text(admsError("empty body"), 400)

  // Persist the photo to disk if photo persistence is enabled.
  if (GATEWAY_ENV.photoFun()) {
    // H-13 — server-generated random filename; pin NEVER touches the path.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): convert to an explicit null check
    const dir = punchPhotoDir(PHOTO_ROOT, sn!)
    if (!dir) {
      await logComm({
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): convert to an explicit null check
        vendorId: auth.device.vendorId, deviceId: auth.device.id, serial: sn!, endpoint: BASE,
        requestType: "REJECTED", httpStatus: 400, ok: false, error: "PATH_ESCAPE: resolved dir outside photo root", ip,
      })
      return text(admsError("invalid SN"), 400)
    }
    // H-13 — only real images are persisted (magic-byte sniff)
    if (!isImageMagic(buf)) {
      await logComm({
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): convert to an explicit null check
        vendorId: auth.device.vendorId, deviceId: auth.device.id, serial: sn!, endpoint: BASE,
        requestType: "REJECTED", httpStatus: 400, ok: false,
        error: `NOT_AN_IMAGE: bytes=${buf.length} magic=${buf.subarray(0, 4).toString("hex")}`, ip,
      })
      return text(admsError("body is not a JPEG/PNG image"), 400)
    }
    try {
      await mkdir(dir, { recursive: true })
      const ext = buf[0] === 0x89 ? ".png" : ".jpg"
      const filename = `${randomUUID()}${ext}` // server-generated — pin in metadata only
      // MED-18 (this audit) — encrypt punch photos at rest with AES-256-GCM
      // under a "punch-photos::v1" context derived from HRM_MFA_KEY. The
      // previous code wrote plaintext face snapshots to disk — biometric PII
      // in clear. Photos are auto-purged after ADMS_PHOTO_RETENTION_DAYS
      // (default 30) by the sweeper (added in jobs.ts runTick()).
      try {
        const { encryptField } = await import("@/hrm-server/crypto-field")
        const enc = encryptField(buf.toString("base64"), "punch-photos::v1")
        await writeFile(join(dir, filename + ".enc"), Buffer.from(enc, "utf8"))
      } catch (e: any) {
        // R4-002 — encryption must NOT fail open to plaintext: biometric face
        // snapshots are sensitive PII (GDPR/PDPA).  If HRM_MFA_KEY is missing
        // or the crypto fails we skip persistence entirely and warn loudly so
        // the operator knows photos are not being stored.
        if (process.env.NODE_ENV !== "test") {
          console.warn("[zkteco] punch photo encryption failed — photo NOT persisted (fix: set HRM_MFA_KEY):", e?.message || e)
        }
        // Do NOT write plaintext fallback.
      }
    } catch (e) {
      // Photo persistence failure must NOT fail the ACK — the device will
      // retry uploads indefinitely otherwise. Log and move on.
      console.error("[zkteco] photo persist failed", e)
    }
  }

  await recordPunchPhoto(auth.device, pin, stime, buf)
  await logComm({
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): convert to an explicit null check
    vendorId: auth.device.vendorId, deviceId: auth.device.id, serial: sn!, endpoint: BASE,
    requestType: "ATTPHOTO", httpStatus: 200, eventCount: 1,
    durationMs: Date.now() - t0, error: `PIN=${pin} STIME=${stime} bytes=${buf.length}`, ip,
  })
  return text(ackOk())
}
