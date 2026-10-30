/// <reference types="bun-types" />
// ============ Shared /api/hrm boundary-test helpers (remediation round) ============
// The audit's #1 systemic failure was controls unit-tested in isolation but
// never wired into call sites. Every remediation regression test therefore
// drives the REAL dispatcher (POST /api/hrm) with a NextRequest — the same
// path production traffic takes. Import postHrm from here; never call engines
// directly in remediation tests.
import "./_testdb" // first — sets DATABASE_URL before db.ts is constructed
import { NextRequest } from "next/server"
import { POST } from "@/app/api/hrm/route"
import { db } from "@/lib/db"
import { sessionTokenHash,  newToken } from "@/hrm-server/auth"

/** Drive the dispatcher exactly like production traffic (content-type + origin
 *  rules included). Supports the Bearer fallback and the cookie+CSRF path. */
export async function postHrm(
  action: string,
  payload: unknown,
  opts: { bearer?: string; cookie?: string; csrf?: string } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`
  if (opts.cookie) headers.cookie = `hrm_session=${opts.cookie}`
  if (opts.csrf) headers["x-csrf-token"] = opts.csrf
  const req = new NextRequest("http://localhost:3000/api/hrm", {
    method: "POST",
    headers,
    body: JSON.stringify({ action, payload: { ...(payload as object) } }),
  })
  const res = await POST(req)
  const body = await res.json()
  return { status: res.status, body }
}

/** Mint a PREAUTH session row the way the login path does
 *  (mfaToken: 5 min at auth.ts:111 — pwToken: 10 min at auth.ts:92). */
export async function mkPreauthSession(userId: string, minutes: number) {
  const id = newToken()
  await db.session.create({
    data: {
      id, tokenHash: sessionTokenHash(id), userId, kind: "PREAUTH",
      csrfToken: newToken(),
      expiresAt: new Date(Date.now() + minutes * 60_000),
      ip: "127.0.0.1", lastSeenAt: new Date(),
    },
  })
  return id
}

/** RFC 6238 code generator for tests (server hotp() is private by design —
 *  tests must not import engine internals; they compute the expected code the
 *  same way an authenticator app does and drive the HTTP boundary). */
import crypto from "crypto"
export function totpNow(secretBase32: string, driftSteps = 0): string {
  const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
  const clean = secretBase32.replace(/=+$/g, "").replace(/\s+/g, "").toUpperCase()
  let bits = 0, value = 0
  const bytes: number[] = []
  for (const ch of clean) {
    const idx = B32.indexOf(ch)
    if (idx === -1) continue
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8 }
  }
  const secret = Buffer.from(bytes)
  const counter = Math.floor(Date.now() / 1000 / 30) + driftSteps
  const buf = Buffer.alloc(8)
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0)
  buf.writeUInt32BE(counter % 2 ** 32, 4)
  const hmac = crypto.createHmac("sha1", secret).update(buf).digest()
  const offset = hmac[hmac.length - 1] & 0xf
  const code = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff)
  return String(code % 10 ** 6).padStart(6, "0")
}
