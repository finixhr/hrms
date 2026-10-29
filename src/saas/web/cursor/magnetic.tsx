// ============ <Magnetic> — declarative wrapper for the cursor engine ========
// Zero-runtime sugar: the SiteCursor engine already auto-detects
// [data-cursor="magnetic"] targets, so this component simply stamps the
// attribute (SSR-friendly, no JS of its own). Use it to wrap CTAs you want
// to feel gently pulled toward the pointer.
//
//   <Magnetic strength={6}><button>Get Started</button></Magnetic>
//
// `strength` = base pixel displacement (default 6). The effective pull is
// strength × (owner pullStrength / 5), capped at 14px — see custom-cursor.tsx.
// Plain buttons already receive a 3px whisper from the engine.
import type { HTMLAttributes, ReactNode } from "react"

export function Magnetic({
  children,
  strength = 6,
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { children: ReactNode; strength?: number }) {
  return (
    <div data-cursor="magnetic" data-magnetic-strength={strength} className={className} {...rest}>
      {children}
    </div>
  )
}
