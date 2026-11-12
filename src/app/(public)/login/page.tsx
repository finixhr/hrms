// ============ /login — redirect into the HRM application ============
// The full sign-in experience (MFA enrollment/verify, expired-password flow)
// lives inside the application shell — duplicating it here would fork those
// flows. /login therefore hands off to /app where the complete LoginView runs.
import { redirect } from "next/navigation"

// PRF-11 (P2 wave, 2026-11-09) — force-dynamic removed: content reads
// through unstable_cache with tag invalidation (owner CMS saves call
// invalidateCmsCache → revalidateTag), so the page is statically rendered
// and revalidated instead of querying the database on every pageview.

export default function LoginPage() {
  redirect("/app")
}
