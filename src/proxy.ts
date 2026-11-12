// ============ Content-Security-Policy (revised 2026-10-04) ============
// History:
//   · pre-M-10: script-src 'unsafe-inline' (a full XSS escape hatch).
//   · M-10: per-request nonce + 'strict-dynamic'. Correct in theory, but it
//     SILENTLY BROKE production hydration on Next 16.3.8 + Turbopack
//     standalone: the server never stamped the nonce onto its bootstrap or
//     flight-payload <script> tags (inline self.__next_f.push chunks), and
//     under a nonce/strict-dynamic policy nonce-less scripts are blocked even
//     from 'self'. The dev server stamped nonces, so the gap only appeared
//     with `bun run start` — every page rendered server-side with zero
//     interactivity.
//   · Now: script-src 'self' 'unsafe-inline'. Rationale, honestly: the App
//     Router REQUIRES executable inline scripts (RSC flight payload) and this
//     Next/Turbopack build provides no working nonce channel in standalone
//     output, so a script-src without 'unsafe-inline' cannot ship. XSS defense
//     therefore leans on the primary layers: React's contextual escaping,
//     C-07 output encoding at every manual sink, httpOnly session cookies,
//     CSRF token echoes, and the CSP still hardens everything else
//     (connect-src 'self' blocks exfiltration to foreign origins; img-src,
//     frame-ancestors, base-uri, form-action and object restrictions stay).
//     When Next fixes nonce stamping in Turbopack standalone builds, restore
//     the strict policy: 'self' 'nonce-…' 'strict-dynamic' 'sha256-…'.
//
// The device plane (/iclock/*, /ISAPI/*) is plain ADMS/ISAPI protocol
// traffic — the matcher excludes it (no browser headers, no CSP).
import { NextRequest, NextResponse } from "next/server"

export function proxy(req: NextRequest) {
  const isDev = process.env.NODE_ENV === "development"
  // LAN-ACCESS FIX — only send upgrade-insecure-requests when the request
  // actually arrived over HTTPS. On a plain-HTTP LAN deployment (no Caddy/TLS
  // in front, http://<server-ip>:3000) that directive would rewrite every
  // http:// asset and fetch URL to https:// in the browser — and with no TLS
  // listener on that port the JS chunks fail to load, leaving the app frozen
  // on the server-rendered "Loading…" screen. Behind the TLS-terminating
  // proxy (Caddy) x-forwarded-proto is "https" and the directive is kept.
  const proto = (req.headers.get("x-forwarded-proto") || "").split(",")[0].trim().toLowerCase()
  const isHttps = proto ? proto === "https" : req.nextUrl.protocol === "https:"
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self' blob:",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    ...(!isDev && isHttps ? ["upgrade-insecure-requests"] : []),
  ].join("; ")

  const res = NextResponse.next()
  res.headers.set("Content-Security-Policy", csp)
  return res
}

export const config = {
  matcher: [
    // every app route EXCEPT the device plane (plain protocol, no CSP) and
    // Next internals
    "/((?!iclock|ISAPI|_next/static|_next/image|favicon.ico|logo.svg|robots.txt).*)",
  ],
}
