// ============ Wave 10 (2026-10-24) — Support Access enter endpoint ============
// GET /api/support-access/enter?token=<one-time capability>
//
// The ONLY bridge between the owner plane and a tenant workspace:
//   1. the caller must hold a live OWNER session (saas_owner_session cookie —
//      getOwnerFromToken, FULL kind only), AND
//   2. the 256-bit one-time enter token must match an UNCONSUMED PENDING
//      SaasSupportAccessSession requested by THAT SAME owner within the last
//      60 seconds (enterTokenHash, burned on use).
// On success the server mints the support-session token, sets the HttpOnly
// `saas_support_session` cookie scoped to the session's remaining lifetime
// and redirects to /app. Every other outcome is a plain-text terminal page —
// there is nothing to enumerate or retry (throttled per IP).
//
// This is a GET on purpose: the owner console opens it in a new tab; the
// capability is one-time, single-operator-bound, 60-second-lived and NEVER
// logged — it cannot be replayed, shared or bookmarked.
import { NextRequest, NextResponse } from "next/server"
import { getOwnerFromToken } from "@/hrm-server/saas/owner-auth"
import { consumeEnterToken, supportCookieStr, throttleSupportEnter } from "@/hrm-server/saas/support-access"
import { resolveClientIp } from "@/hrm-server/security"

export const dynamic = "force-dynamic"

function isHttpsReq(req: NextRequest): boolean {
  const xf = (req.headers.get("x-forwarded-proto") || "").split(",")[0].trim().toLowerCase()
  if (xf) return xf === "https"
  try {
    return new URL(req.url).protocol === "https:"
  } catch {
    return true
  }
}

function terminalPage(title: string, detail: string, status: number): NextResponse {
  const safeTitle = title.replace(/[<>&]/g, "")
  const safeDetail = detail.replace(/[<>&]/g, "")
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${safeTitle}</title>` +
    `<meta name="robots" content="noindex,nofollow">` +
    `<style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}` +
    `.card{max-width:520px;padding:32px 36px;border:1px solid #334155;border-radius:12px;background:#1e293b}` +
    `h1{font-size:18px;margin:0 0 12px}p{font-size:14px;line-height:1.6;color:#94a3b8;margin:0}code{color:#fbbf24}</style></head>` +
    `<body><div class="card"><h1>${safeTitle}</h1><p>${safeDetail}</p></div></body></html>`
  return new NextResponse(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
  })
}

export async function GET(req: NextRequest) {
  const ip = resolveClientIp(req)
  if (await throttleSupportEnter(ip)) {
    return terminalPage("Too many attempts", "This endpoint is rate-limited. Wait a few minutes and start a fresh support session from the Owner Console.", 429)
  }

  const url = new URL(req.url)
  const token = url.searchParams.get("token") || ""

  // 1. a live FULL owner session is mandatory (belt) — the capability token
  //    alone (suspenders) is never sufficient on this endpoint.
  const ownerToken = req.cookies.get("saas_owner_session")?.value || null
  const owner = await getOwnerFromToken(ownerToken)
  if (!owner) {
    return terminalPage("Owner sign-in required", "Open this link from the Finix HR Owner Console while signed in as an authorized support operator.", 401)
  }

  // 2. exchange the one-time capability for the support-session cookie.
  const res = await consumeEnterToken(token, owner.ownerId, ip || undefined, req.headers.get("user-agent") || undefined)
  if (!res.ok) {
    const messages: Record<number, string> = {
      400: "The support link is malformed. Start a fresh session from the Owner Console.",
      403: "This support link was issued to a different owner account.",
      410: "This support link has already been used or has expired (60-second validity). Start a fresh session from the Owner Console.",
    }
    return terminalPage("Support link unavailable", messages[res.code] || "Start a fresh support session from the Owner Console.", res.code)
  }

  // 3. activate: set the HttpOnly support cookie scoped to the session's
  //    remaining lifetime, then land in the tenant workspace where the
  //    persistent SUPPORT ACCESS banner is waiting.
  const out = NextResponse.redirect(new URL("/app?support=active", url.origin), 302)
  out.headers.append("Set-Cookie", supportCookieStr(res.sessionToken, res.maxAgeSeconds, isHttpsReq(req)))
  out.headers.append("Cache-Control", "no-store")
  out.headers.append("X-Robots-Tag", "noindex")
  // Defense in depth: the SPA must never proxy/cache a support-authenticated
  // document for a different viewer.
  out.headers.append("Vary", "Cookie")
  return out
}

// HEAD reports reachability only — it never consumes the one-time capability.
export async function HEAD() {
  return new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } })
}
