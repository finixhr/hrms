// Server component wrapper for the app root.
//
// AUDIT L-10 (2026-11-07) — corrected stale documentation: this comment used
// to describe a nonce-based CSP "in src/middleware.ts", a file that does not
// exist. The live CSP is set by src/proxy.ts (see its header for the current
// 'unsafe-inline' workaround and the M-9 tracking note). The ORIGINAL fix this
// file carried is still valid and still required: this page must render
// per-request (force-dynamic), never statically prerendered, so the auth shell
// reads live cookies/headers on every request instead of serving a stale
// prerendered shell from the production build.
export const dynamic = "force-dynamic"

import { HomeClient } from "@/hrm/home"

export default function Home() {
  return <HomeClient />
}

// The HRM application is a private surface: never indexed (§62).
export const metadata = {
  title: "Sign in · HR Workspace",
  robots: { index: false, follow: false },
}
