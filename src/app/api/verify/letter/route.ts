// LTR-02 (R7) — PUBLIC letter verification endpoint (no login).
// A third party holding a printed letter enters its verification code and
// gets the letter's verifiable facts: issuing company, letter number,
// employee name, letter type and issue date. Invalid codes reveal nothing
// beyond "not found". The code itself is a 12-hex-char HMAC-derived value
// (≈2.8e14 space) — brute force is infeasible; a light per-IP rate limit
// keeps the endpoint polite anyway.
import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { letterCodeMatches, letterCodePrefix } from "@/hrm-server/routes/letters"
import { rateLimit } from "@/hrm-server/rate-limit"
import { resolveClientIp } from "@/hrm-server/security"

export const dynamic = "force-dynamic"

const CODE_SHAPE = /^[0-9A-Fa-f]{4}-?[0-9A-Fa-f]{4}-?[0-9A-Fa-f]{4}$/

export async function GET(req: NextRequest) {
  // Per-IP politeness guard (the code space makes brute force moot).
  // GAP-311 — through the shared trust gate: a raw X-Forwarded-For let a caller
  // rotate buckets at will.
  const ip = resolveClientIp(req) || "local"
  const rl = rateLimit(`letter-verify:${ip}`, 30, 60_000)
  if (!rl.ok) {
    return NextResponse.json({ valid: false, error: "Too many attempts — try again in a minute" }, { status: 429 })
  }

  const url = new URL(req.url)
  const code = (url.searchParams.get("code") || "").trim()
  if (!code || !CODE_SHAPE.test(code)) {
    return NextResponse.json({ valid: false, error: "Enter the 12-character verification code printed on the letter (e.g. A1B2-C3D4-E5F6)" }, { status: 400 })
  }

  // SEC-4 (P0 audit wave, 2026-11-09) — INDEXED PREFIX PROBE instead of the
  // old bounded 5,000-row scan. The stored code is an HMAC over vendor+row,
  // so the (vendorId, verificationCode) index can never serve this public
  // (vendor-less) query — the old route loaded up to 5,000 ISSUED letters with
  // no orderBy and timing-safe-compared each row; past the cap, genuine codes
  // 404'd at arbitrary times (banks could not verify real letters) and every
  // hit was a full scan. The deterministic first-8-hex-character prefix
  // (HrLetter.verificationCodePrefix, indexed, backfilled by 9_wave9zzag)
  // resolves the candidate set through an index equality; the timing-safe
  // compare stays for the FULL code against the (handful of) candidates.
  const prefix = letterCodePrefix(code)
  if (prefix.length < 8) {
    return NextResponse.json({ valid: false, error: "Enter the 12-character verification code printed on the letter (e.g. A1B2-C3D4-E5F6)" }, { status: 400 })
  }
  const candidates = await db.hrLetter.findMany({
    where: { status: "ISSUED", verificationCode: { not: null }, verificationCodePrefix: prefix },
    select: { id: true, vendorId: true, letterNumber: true, verificationCode: true, type: true, issuedAt: true, employeeId: true },
    take: 16,
  })
  const hit = candidates.find((l) => letterCodeMatches(l.verificationCode, code))
  if (!hit) {
    return NextResponse.json({ valid: false, error: "No issued letter matches this verification code" }, { status: 404 })
  }

  const [vendor, emp] = await Promise.all([
    db.vendor.findUnique({ where: { id: hit.vendorId }, select: { name: true } }),
    db.employee.findUnique({ where: { id: hit.employeeId }, select: { fullName: true, code: true } }),
  ])
  return NextResponse.json({
    valid: true,
    company: vendor?.name || "—",
    letterNumber: hit.letterNumber,
    employeeName: emp?.fullName || "—",
    employeeCode: emp?.code || null,
    type: hit.type,
    issuedAt: hit.issuedAt,
  })
}
