// ============ WP-Q — media pipeline helpers + MEDIA_BACKFILL runner ============
// Shared by the owner.cms.media.* upload/list/backfill paths (cms-routes.ts)
// so the job runner and the interactive pipeline hash/measure EXACTLY the
// same way. This module deliberately imports only the db client + the
// upload-sniff helpers — no route-table side effects — so jobs.ts can lazy-
// import it without pulling the owner dispatcher into the worker lane.
//
// Design rules (WP-Q brief):
//   - sha256 over the DECODED payload (node:crypto) — content-addressed
//     duplicate detection, never the client-declared metadata
//   - width/height from a small PURE-TS header reader (PNG/JPEG/GIF/WebP/ICO);
//     SVG → null (vector, no intrinsic raster size worth trusting)
//   - honest failure: anything undecodable/unparseable returns null — no
//     guessed dimensions, no fake hashes
//   - backfill NEVER touches existing data/variantsJson — it only fills the
//     additive enrichment columns (sha256/width/height/sizeBytes)
import { createHash } from "node:crypto"
import { db } from "@/lib/db"
import { decodeBase64Payload, sniffMime } from "../uploads"

// ------------------------------ hashing ------------------------------

export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex")
}

// ------------------------------ byte sniff ------------------------------
// Raster formats reuse the shared magic-byte sniffer (uploads.ts, M-37); the
// two text/container formats the CMS allowlist adds (SVG, ICO) get their own
// signature checks. Returns the NORMALIZED mime we store, or null when the
// bytes match nothing in the allowlist.

export function sniffMediaMime(buf: Buffer): string | null {
  const raster = sniffMime(buf) // image/png | image/jpeg | image/webp
  if (raster) return raster
  if (buf.length >= 6 && buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) {
    return "image/x-icon" // ICO: reserved(0) type(1) — the vnd.microsoft/ico aliases normalize here
  }
  const head = buf.subarray(0, 1024).toString("utf8").trimStart() // trims BOM + whitespace
  if (head.startsWith("<") && /<svg[\s>]/i.test(head)) return "image/svg+xml"
  return null
}

/** Decode a stored media payload. Data URLs decode to their bytes; absolute
 * URLs (S3/CDN storage) return null — they are not locally hashable. */
export function decodeMediaData(data: string): Buffer | null {
  if (typeof data !== "string" || data === "" ) return null
  if (/^https?:\/\//i.test(data)) return null
  const buf = decodeBase64Payload(data)
  return buf && buf.length > 0 ? buf : null
}

// ------------------------------ pure-TS image size reader ------------------------------

export type ImageSize = { width: number; height: number }

/** Parse PNG/JPEG/GIF/WebP/ICO headers for the intrinsic pixel size.
 * SVG (and anything unrecognized) → null. Pure TS — no dependency. */
export function readImageSize(mime: string, buf: Buffer): ImageSize | null {
  try {
    if (mime === "image/png") {
      // 8-byte signature + IHDR chunk: length(4) "IHDR"(4) then width/height (BE u32 each)
      if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
      }
      return null
    }
    if (mime === "image/jpeg") {
      if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
      let off = 2
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) { off++; continue } // resync to a marker (rare, tolerated)
        const marker = buf[off + 1]
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue } // standalone markers, no length
        const len = buf.readUInt16BE(off + 2)
        // SOF0..SOF15 carry the frame dimensions (DHT/JPG/DAC excluded)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          if (off + 9 > buf.length) return null
          return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) }
        }
        off += 2 + len
      }
      return null
    }
    if (mime === "image/gif") {
      if (buf.length >= 10 && buf.toString("latin1", 0, 4) === "GIF8") {
        return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
      }
      return null
    }
    if (mime === "image/webp") {
      if (buf.length >= 30 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") {
        const chunk = buf.toString("latin1", 12, 16)
        if (chunk === "VP8 ") {
          // lossy: 3-byte frame tag + 3-byte sync code, then 14-bit LE width/height
          return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
        }
        if (chunk === "VP8L") {
          // lossless: signature byte, then 14-bit (dim-1) pairs packed LE
          const bits = buf.readUInt32LE(21)
          return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
        }
        if (chunk === "VP8X") {
          // extended: flags(1) reserved(3) canvas-w-1(3 LE) canvas-h-1(3 LE)
          const w = (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1
          const h = (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1
          return { width: w, height: h }
        }
      }
      return null
    }
    if (mime === "image/x-icon") {
      // 6-byte header (reserved 0, type 1) then 16-byte directory entries:
      // first entry's width/height bytes (0 means 256)
      if (buf.length >= 8 && buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) {
        return { width: buf[6] === 0 ? 256 : buf[6], height: buf[7] === 0 ? 256 : buf[7] }
      }
      return null
    }
    return null // SVG + unknown → no dimensions
  } catch {
    return null
  }
}

// ------------------------------ naming / normalization ------------------------------

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/ico": "ico",
  "image/gif": "gif",
}

/** Slugify a display name into an SEO-friendly filename (with the mime's
 * extension). Always non-empty; uniqueness is resolved per folder by the
 * caller. */
export function slugifySeoFilename(name: string, mime: string): string {
  const base = String(name || "")
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
  const ext = EXT_BY_MIME[mime] ?? "bin"
  return `${base || "image"}.${ext}`
}

/** Normalize a folder path: trimmed, no leading/trailing slash, collapsed
 * slashes, ≤ 6 segments of ≤ 60 chars. Invalid segments are dropped ("" = root). */
export function normalizeFolder(raw: unknown): string {
  const s = String(raw ?? "").trim().replace(/\\/g, "/")
  if (!s) return ""
  const segments = s.split("/").map((seg) => seg.trim().slice(0, 60).replace(/[/]+/g, "")).filter(Boolean)
  return segments.slice(0, 6).join("/")
}

/** Tags are slug-style so the LIKE-backed tag filter stays exact: lowercase
 * letters/digits/spaces/dashes only, ≤ 40 chars, max 12, deduped. */
export function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of raw) {
    const tag = String(t ?? "").toLowerCase().replace(/[^a-z0-9 -]+/g, "").replace(/\s+/g, " ").trim().slice(0, 40)
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    out.push(tag)
    if (out.length >= 12) break
  }
  return out
}

// ------------------------------ MEDIA_BACKFILL runner ------------------------------

/** WP-Q backfill: iterate SaasCmsMedia rows that predate content hashing
 * (sha256 IS NULL) in batches of 20 and fill ONLY the enrichment columns
 * (sha256, width, height, sizeBytes) using the exact upload-path helpers.
 * Existing data/variantsJson are never touched. Rows whose payload is stored
 * externally (absolute URL — S3 mode rows uploaded before hashing landed, or
 * hand-edited rows) cannot be hashed locally and are counted as `skipped`
 * honestly rather than faked. Returns {processed, total, skipped}. */
export async function backfillMedia(progress: (n: number) => Promise<void>): Promise<{ processed: number; total: number; skipped: number }> {
  const total = await db.saasCmsMedia.count({ where: { sha256: null } })
  let processed = 0
  let skipped = 0
  await progress(0)
  // Keyset pagination on (createdAt, id): processed rows leave the sha256-null
  // filter as they are updated, so a monotonic cursor guarantees termination
  // even when some rows are skipped (externally-stored payloads stay null).
  let after: { createdAt: Date; id: string } | null = null
  for (;;) {
    const where: { sha256: null } & Record<string, unknown> = { sha256: null }
    if (after) where.OR = [{ createdAt: { gt: after.createdAt } }, { createdAt: after.createdAt, id: { gt: after.id } }]
    const rows = await db.saasCmsMedia.findMany({
      where: where as never,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 20,
      select: { id: true, data: true, mimeType: true, createdAt: true },
    })
    if (rows.length === 0) break
    for (const r of rows) {
      const buf = decodeMediaData(r.data)
      if (!buf) {
        skipped++
        continue
      }
      const sniffed = sniffMediaMime(buf)
      const dims = sniffed ? readImageSize(sniffed, buf) : null
      await db.saasCmsMedia.update({
        where: { id: r.id },
        data: { sha256: sha256Hex(buf), width: dims?.width ?? null, height: dims?.height ?? null, sizeBytes: buf.length },
      })
      processed++
    }
    const last = rows[rows.length - 1]
    after = { createdAt: last.createdAt, id: last.id }
    await progress(processed) // cooperative-cancellation checkpoint between batches
  }
  return { processed, total, skipped }
}
