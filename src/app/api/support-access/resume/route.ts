// ============ 2026-10-25 — Support Access RE-ENTRY endpoint (master prompt §5) =
// GET /api/support-access/resume?session=<sessionId>
//
// Lets an authorized support agent RE-ENTER their own still-ACTIVE support
// session after accidentally closing the browser tab — WITHOUT creating a
// duplicate session, WITHOUT a new tenant request, and WITHOUT extending the
// original expiry. The initial activation link stays single-use; re-entry is
// a separate, authenticated operation:
//   1. the caller must hold a live FULL owner session (verified here — the
//      agent's authentication + MFA are already satisfied by that session);
//   2. resumeSupportSession() validates session status, expiry and operator
//      binding, then ROTATES the session token (a fresh cookie is set; any
//      stale cookie from the closed tab is invalidated by the rotation);
//   3. the SAME session id, expiry, approved module scope and audit history
//      remain intact — a SUPPORT_ACCESS_RESUMED audit row records the
//      re-entry.
import { NextRequest, NextResponse } from "next/server"
import { getOwnerFromToken } from "@/hrm-server/saas/owner-auth"
import { resumeSupportSession, supportCookieStr } from "@/hrm-server/saas/support-access"
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
  const url = new URL(req.url)
  const sessionId = url.searchParams.get("session") || ""

  // 1. a live FULL owner session is mandatory — this is an authenticated
  //    operation, never a bare link (a bookmarked URL is useless without it).
  const ownerToken = req.cookies.get("saas_owner_session")?.value || null
  const owner = await getOwnerFromToken(ownerToken)
  if (!owner) {
    return terminalPage("Owner sign-in required", "Open this link from the Finix HR Owner Console while signed in as the authorized support agent.", 401)
  }

  // 2. validate + rotate — same session, same expiry, audited re-entry.
  const res = await resumeSupportSession(
    sessionId,
    { id: owner.ownerId, name: owner.name, roleKey: owner.roleKey, ip: ip || undefined },
    ip || undefined,
    req.headers.get("user-agent") || undefined,
  )
  if (!res.ok) {
    const messages: Record<number, string> = {
      400: "The re-entry link is malformed. Use the Owner Console → Support board.",
      403: "This session belongs to a different support agent.",
      404: "This session no longer exists.",
      409: "This session has ended — start a fresh session or ask the tenant for a new live-support request.",
      410: "This session has expired. Request a new live-support authorization from the tenant.",
    }
    return terminalPage("Session unavailable", messages[res.code] || res.error || "The session cannot be resumed.", res.code)
  }

  // 3. re-enter: fresh cookie for the SAME session, redirect to the tenant
  //    workspace where the persistent SUPPORT ACCESS banner is waiting.
  const out = NextResponse.redirect(new URL("/app?support=reentered", url.origin), 302)
  out.headers.append("Set-Cookie", supportCookieStr(res.sessionToken, res.maxAgeSeconds, isHttpsReq(req)))
  out.headers.append("Cache-Control", "no-store")
  out.headers.append("X-Robots-Tag", "noindex")
  out.headers.append("Vary", "Cookie")
  return out
}
