// ============ /login — redirect into the HRM application ============
// The full sign-in experience (MFA enrollment/verify, expired-password flow)
// lives inside the application shell — duplicating it here would fork those
// flows. /login therefore hands off to /app where the complete LoginView runs.
import { redirect } from "next/navigation"

export const dynamic = "force-dynamic"

export default function LoginPage() {
  redirect("/app")
}
