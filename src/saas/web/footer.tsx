// ============ Public site footer (server component, CMS-driven) ============
// Deliberately dark in BOTH themes: the deep slate footer anchors the page
// under the light theme the same way it closes the dark one (no `light:`
// overrides on purpose — links and text are tuned for this surface).
import Link from "next/link"
import { Sparkles } from "lucide-react"
import type { FooterConfig, SiteIdentity } from "./content-types"

// Complete literal class strings — Tailwind's scanner only emits CSS for class
// names it can read verbatim in source, so a dynamically interpolated
// `lg:grid-cols-[1.4fr_repeat(${n},1fr)]` would never be generated (the footer
// then stacks vertically on desktop and becomes far too tall).
const GROUP_COL_CLASS: Record<number, string> = {
  0: "lg:grid-cols-1",
  1: "lg:grid-cols-[1.4fr_1fr]",
  2: "lg:grid-cols-[1.4fr_1fr_1fr]",
  3: "lg:grid-cols-[1.4fr_1fr_1fr_1fr]",
  4: "lg:grid-cols-[1.4fr_1fr_1fr_1fr_1fr]",
  5: "lg:grid-cols-[1.4fr_1fr_1fr_1fr_1fr_1fr]",
}

export function SiteFooter({ footer, identity }: { footer: FooterConfig; identity: SiteIdentity }) {
  const groupCols = Math.min(footer.groups.length, 5)
  return (
    <footer className="border-t border-white/10 bg-slate-950">
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6">
        <div
          className={`grid gap-8 sm:grid-cols-2 lg:gap-10 ${
            GROUP_COL_CLASS[groupCols] ?? GROUP_COL_CLASS[1]
          }`}
        >
          <div>
            <div className="flex items-center gap-2.5">
              {identity.logoUrl && identity.logoUrl !== "/logo.svg" ? (
                <img src={identity.logoUrl} alt={identity.siteName} className="h-8 w-8 rounded-lg object-contain" />
              ) : (
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 via-indigo-500 to-violet-500">
                  <Sparkles className="h-4 w-4 text-white" />
                </span>
              )}
              <span className="text-[15px] font-bold tracking-tight text-white">{identity.siteName}</span>
            </div>
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-slate-400">
              {identity.tagline}. A multi-tenant HR operations platform for organizations in {identity.country} and beyond —
              people, attendance, tracking, payroll, leave, performance, inventory and security in one workspace.
            </p>
            {identity.supportEmail && (
              <p className="mt-4 text-xs text-slate-500">
                Operated by {identity.company}. Support: <a href={`mailto:${identity.supportEmail}`} className="hover:text-slate-300">{identity.supportEmail}</a>
              </p>
            )}
          </div>
          {footer.groups.map((g) => (
            <div key={g.title}>
              <p className="text-xs font-bold uppercase tracking-widest text-slate-500">{g.title}</p>
              <ul className="mt-4 space-y-2.5">
                {g.links.map((l) => (
                  <li key={l.href + l.label}>
                    <Link href={l.href} className="text-sm text-slate-400 transition-colors hover:text-white">
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-10 border-t border-white/5 pt-6">
          {footer.note && <p className="text-xs leading-relaxed text-slate-500">{footer.note}</p>}
          <p className="mt-3 text-xs text-slate-500">
            © {new Date().getFullYear()} {identity.company}. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  )
}
