import * as React from "react"

// Standard shadcn/ui companion hook for ui/sidebar.tsx. Restored during the
// 2026-09-30 gate pass: the file was missing from the vendor distribution,
// which broke `next build`'s type check (the sidebar component itself is not
// imported by any view, but Next type-checks every file in the project).
const MOBILE_BREAKPOINT = 768

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    mql.addEventListener("change", onChange)
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return !!isMobile
}
