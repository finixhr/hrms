// Server component wrapper for the app root.
//
// PRODUCTION-HYDRATION FIX — the nonce-based CSP (src/middleware.ts) can only
// stamp its per-request nonce onto Next's bootstrap scripts when the page is
// rendered per-request. This page used to be a "use client" file, which made
// it statically prerenderable: the production build then served HTML whose
// <script> tags carried NO nonce, while the CSP demanded
// script-src 'nonce-…' 'strict-dynamic' — every bootstrap script (including
// the inline RSC payload) was blocked and the app froze forever on the
// server-rendered "Loading Finix HR…" screen. Forcing
// dynamic rendering keeps the nonce flow intact in production; the page
// itself is a tiny auth shell, so nothing is lost by not prerendering it.
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
