// ============ /owner console shell (route group) ============
// Everything in this group (dashboard, tenants, plans, billing, …) renders
// inside the session-gated OwnerShell. /owner/login lives OUTSIDE the group so
// the sign-in form itself is never blanked by the auth gate.
import { OwnerShell } from "@/saas/owner/shell"

export default function OwnerConsoleLayout({ children }: { children: React.ReactNode }) {
  return <OwnerShell>{children}</OwnerShell>
}
