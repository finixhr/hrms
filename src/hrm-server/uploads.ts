// ============ Server-side upload validation (M-37) ============
// Audit M-37: employee document uploads had NO server-side size or type
// validation — the 2 MB cap lived only in the client (employees.tsx), and the
// dispatcher's 8 MB body cap merely bounded the damage. This module enforces,
// on the SERVER, per-file:
//   - decoded size ≤ 2 MB (matches the documented client limit)
//   - base64 decodability
//   - a magic-byte MIME sniff against the allowlist
//     (JPEG / PNG / WebP / PDF — exactly what the viewer and the client picker
//     accept), so a renamed executable or arbitrary binary cannot be stored
//     and later served as a "document".
//
// The sniff is intentionally byte-level (NOT the client-controlled filename),
// which also closes the MIME half of L-29 for employee documents; leave
// attachments adopt the same helper in the L-29 batch.
const MAX_DOC_BYTES = 2 * 1024 * 1024

const MAGIC: [string, number[]][] = [
  ["image/jpeg", [0xff, 0xd8, 0xff]],
  ["image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ["application/pdf", [0x25, 0x50, 0x44, 0x46, 0x2d]], // %PDF-
  ["image/webp", [0x52, 0x49, 0x46, 0x46]], // RIFF....WEBP
]

export type UploadCheck = { ok: true; mime: string; bytes: number } | { ok: false; reason: string }

/** Sniff the MIME type from magic bytes (null when unknown). */
export function sniffMime(buf: Buffer): string | null {
  for (const [mime, sig] of MAGIC) {
    if (sig.every((b, i) => buf[i] === b)) {
      if (mime === "image/webp") {
        // RIFF container: bytes 8..12 must spell WEBP
        return buf.slice(8, 12).toString("latin1") === "WEBP" ? "image/webp" : null
      }
      return mime
    }
  }
  return null
}

/**
 * Validate an employee-document upload (raw base64, exactly what the client
 * sends in `fileData`). Empty/null is VALID (metadata-only rows are allowed —
 * the UI lets users register document details before uploading the file).
 */
export function validateEmployeeDoc(fileData: unknown): UploadCheck {
  if (fileData == null || fileData === "") return { ok: true, mime: "", bytes: 0 }
  if (typeof fileData !== "string") return { ok: false, reason: "fileData must be a base64 string" }
  const cleaned = fileData.replace(/^data:[^;]+;base64,/, "").trim()
  if (cleaned === "") return { ok: true, mime: "", bytes: 0 }
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(cleaned)) return { ok: false, reason: "fileData is not valid base64" }
  let buf: Buffer
  try {
    buf = Buffer.from(cleaned, "base64")
  } catch {
    return { ok: false, reason: "fileData is not valid base64" }
  }
  if (buf.length === 0) return { ok: false, reason: "fileData decodes to an empty file" }
  if (buf.length > MAX_DOC_BYTES) {
    return { ok: false, reason: `File too large — ${Math.round(buf.length / 1024)} KB decoded, the limit is 2048 KB` }
  }
  const mime = sniffMime(buf)
  if (!mime) {
    return { ok: false, reason: "Unsupported file type — allowed: JPG, PNG, WebP, PDF" }
  }
  return { ok: true, mime, bytes: buf.length }
}

/** Decode a possibly-data-URL-prefixed base64 payload (shared by the L-29
 *  serve-side sniff helpers). Returns null when undecodable. */
export function decodeBase64Payload(raw: string): Buffer | null {
  const cleaned = raw.replace(/^data:[^;]+;base64,/, "").trim()
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(cleaned)) return null
  try {
    return Buffer.from(cleaned, "base64")
  } catch {
    return null
  }
}

/** L-29 — leave-application supporting documents (R3): same byte-level
 *  validation as employee docs (2 MB + JPEG/PNG/WebP/PDF allowlist). The
 *  client dialog said "PDF/image, max 2 MB" but the server previously
 *  accepted ANY base64 payload. */
export function validateLeaveAttachment(attachmentData: unknown): UploadCheck {
  if (attachmentData == null || attachmentData === "") return { ok: true, mime: "", bytes: 0 }
  if (typeof attachmentData !== "string") return { ok: false, reason: "attachmentData must be a base64 string" }
  const buf = decodeBase64Payload(attachmentData)
  if (!buf || buf.length === 0) return { ok: false, reason: "attachmentData is not valid base64" }
  if (buf.length > MAX_DOC_BYTES) {
    return { ok: false, reason: `Attachment too large — ${Math.round(buf.length / 1024)} KB decoded, the limit is 2048 KB` }
  }
  const mime = sniffMime(buf)
  if (!mime) return { ok: false, reason: "Unsupported attachment type — allowed: JPG, PNG, WebP, PDF" }
  return { ok: true, mime, bytes: buf.length }
}

/** L-29 — selfie proofs: the geo check-in/out path previously trusted the
 *  data-URL PREFIX ("data:image/jpeg;base64,…") — the decoded bytes were
 *  never inspected, so a renamed executable rode along as a "selfie".
 *  Returns the SNIFFED mime (never the declared one). */
const SELFIE_MIME = new Set(["image/jpeg", "image/png", "image/webp"])
export function validateSelfieDataUrl(dataUrl: string): { ok: true; mime: string; bytes: number } | { ok: false; reason: string } {
  const buf = decodeBase64Payload(dataUrl)
  if (!buf || buf.length === 0) return { ok: false, reason: "Selfie must be a base64 data URL" }
  if (buf.length > MAX_DOC_BYTES) return { ok: false, reason: "Selfie image is too large (max 2 MB)" }
  const sniffed = sniffMime(buf)
  if (!sniffed || !SELFIE_MIME.has(sniffed)) {
    return { ok: false, reason: "Selfie must be a real JPEG, PNG or WebP image (the file content does not match)" }
  }
  return { ok: true, mime: sniffed, bytes: buf.length }
}
