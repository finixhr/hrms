// ============ MOB-2/3/6 (Phase 3 WS-D) — v1 list-endpoint helpers ==============
// Cursor pagination + delta sync (updatedSince) + ETag/304 for the public
// REST API. Until Phase 3 every list route was page/pageSize-only (offset
// pagination), attendance hard-truncated at 500 rows with a misleading
// `truncated` flag, and no client could ask "what changed since X" or get a
// cheap 304 on an unchanged page.
//
// CONTRACT RULES (behavior compatibility):
//   * page/pageSize mode is UNCHANGED — existing clients keep working.
//   * cursor mode is OPT-IN via ?cursor= — stable (createdAt, id) keyset
//     pagination with a `nextCursor` + `hasMore` meta.
//   * updatedSince=ISO is an OPT-IN filter on updatedAt (delta sync).
//   * ETag: every list response carries a weak ETag; If-None-Match with a
//     matching value short-circuits to 304 Not Modified.
import { NextRequest, NextResponse } from "next/server"
import crypto from "crypto"

export type ListParams = {
  page: number
  pageSize: number
  cursor: string | null
  updatedSince: Date | null
  cursorMode: boolean
}

/** Parse the shared list params (page mode + opt-in cursor/delta modes).
 *  Cursor mode activates on PARAMETER PRESENCE — `?cursor=` (empty value) is
 *  the natural first page for clients that always send the field. */
export function parseListParams(req: NextRequest): ListParams {
  const sp = req.nextUrl.searchParams
  const page = Math.max(1, Math.trunc(Number(sp.get("page")) || 1) || 1)
  const pageSizeRaw = Math.trunc(Number(sp.get("pageSize")) || 50) || 50
  const pageSize = Math.min(100, Math.max(1, pageSizeRaw))
  const cursorPresent = sp.has("cursor")
  const cursor = sp.get("cursor") || null
  const updatedSinceRaw = sp.get("updatedSince")
  let updatedSince: Date | null = null
  if (updatedSinceRaw) {
    const t = Date.parse(updatedSinceRaw)
    if (Number.isFinite(t)) updatedSince = new Date(t)
  }
  return { page, pageSize, cursor, updatedSince, cursorMode: cursorPresent }
}

export type KeysetCursor = { c: string; id: string } // createdAt ISO + row id

/** Decode a client-supplied cursor; null when malformed (callers treat a bad
 *  cursor as a fresh first page — never a 500). */
export function decodeCursor(raw: string | null): KeysetCursor | null {
  if (!raw) return null
  try {
    const v = JSON.parse(Buffer.from(raw, "base64").toString("utf8"))
    if (typeof v?.c === "string" && typeof v?.id === "string") return { c: v.c, id: v.id }
    return null
  } catch {
    return null
  }
}

export function encodeCursor(row: { createdAt: Date | string; id: string }): string {
  const c = row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt)
  return Buffer.from(JSON.stringify({ c, id: row.id })).toString("base64")
}

/** Prisma where-fragment for keyset pagination under `orderBy: createdAt DESC,
 *  id DESC`: strictly older than the cursor pair (lexicographic on the sort
 *  key). Pass the decoded cursor; merge into the route's existing where. */
export function keysetWhere(cursor: KeysetCursor): Record<string, unknown> {
  return {
    OR: [
      { createdAt: { lt: cursor.c } },
      { createdAt: cursor.c, id: { lt: cursor.id } },
    ],
  }
}

/** Weak ETag for a response payload (sha256 of the serialized JSON). */
export function etagFor(payload: unknown): string {
  const hash = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 27)
  return `W/"${hash}"`
}

/** True when the request's If-None-Match satisfies the computed ETag. */
export function ifNoneMatchSatisfied(req: NextRequest, etag: string): boolean {
  const inm = req.headers.get("if-none-match")
  if (!inm) return false
  // weak-compare: strip W/ prefixes and quotes, allow lists and *
  const candidates = inm.split(",").map((v) => v.trim().replace(/^W\//, ""))
  return candidates.includes("*") || candidates.includes(etag.replace(/^W\//, ""))
}

/** Attach ETag + Cache-Control headers to an apiOk response. */
export function withETag(res: NextResponse, etag: string): NextResponse {
  res.headers.set("ETag", etag)
  res.headers.set("Cache-Control", "private, no-cache")
  return res
}

/** Build the 304 Not Modified response (ETag header only, no body). */
export function notModified(etag: string): NextResponse {
  return new NextResponse(null, {
    status: 304,
    headers: { ETag: etag, "Cache-Control": "private, no-cache" },
  })
}
