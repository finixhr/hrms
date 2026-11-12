// ============ /owner — NOINDEX metadata only ============
// The session-gated OwnerShell is applied by the (console) route group layout,
// NOT here. /owner/login must render WITHOUT the shell: the shell calls
// owner.auth.me on mount and returns null while unauthenticated, which used to
// blank out the login page for every signed-out visitor (white page bug).
import type { Metadata } from "next"

export const metadata: Metadata = {
  title: { default: "Owner Console", template: "%s · Owner Console" },
  robots: { index: false, follow: false },
}

export default function OwnerLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
