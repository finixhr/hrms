import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { PREPAINT_SCRIPT } from "@/lib/prepaint-script";

// Wave 4 (SG-D) — PWA installability: the browser chrome follows the brand
// emerald (matches --hrm-primary in globals.css and the manifest theme_color;
// the (public) route group keeps its own light/dark split).
export const viewport: Viewport = {
  themeColor: "#059669",
};

export async function generateMetadata(): Promise<Metadata> {
  // Identity (name + favicon) comes from the Website CMS when available;
  // falls back to the self-hosted /logo.svg. Used by /app and /owner — the
  // public route group overrides with richer SEO metadata.
  let siteName = "Finix HR"
  let faviconUrl = "/logo.svg"
  try {
    const { getSiteSettings } = await import("@/hrm-server/saas/cms")
    const { identity } = await getSiteSettings()
    siteName = identity.siteName || siteName
    if (identity.faviconUrl) faviconUrl = identity.faviconUrl
  } catch {
    // DB unavailable at build/boot — defaults above keep rendering alive
  }
  return {
    // Wave 4 (SG-D) — PWA manifest for the ESS offline install (public/manifest.webmanifest)
    manifest: "/manifest.webmanifest",
    title: {
      default: `${siteName} — Workforce Management Platform`,
      template: `%s · ${siteName}`,
    },
    description: `${siteName} — multi-tenant HRM & workforce platform: employees, attendance, leave, payroll & AIT, loans, performance, exit and accounting.`,
    keywords: ["HRM", "HR software", "Workforce platform", "Payroll", "Attendance", "Live tracking", siteName],
    authors: [{ name: siteName }],
    icons: {
      // L-01 — self-hosted logo instead of the CDN favicon (no third-party
      // dependency + consistent with the CSP img-src policy). When the owner
      // uploads a favicon in the Website Studio it is served as a data URL.
      icon: faviconUrl,
    },
    openGraph: {
      title: `${siteName} — Workforce Management Platform`,
      description: "Multi-tenant HRM & Workforce platform",
      siteName,
      type: "website",
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* M-30 — pre-hydration theme script: applies the stored theme
            preference BEFORE first paint so dark-mode users never see a flash.
            Runs synchronously in <head>, before any renderable content.
            Three surfaces, three rules:
              · /app      → HRM app theme (localStorage hrm_theme; app-shell
                            re-syncs post-hydration with the tenant default)
              · /owner    → owner console (localStorage owner_theme, DEFAULT
                            DARK — previously the class was never applied, so
                            shadcn inputs rendered light-theme (near-black)
                            text on the dark card = unreadable typed values)
              · otherwise → public website (localStorage site_theme, falling
                            back to the OS prefers-color-scheme) */}
        <script
          dangerouslySetInnerHTML={{
            // shared constant — the CSP middleware hashes THIS string and
            // allows it via 'sha256-…' (nonce+strict-dynamic would otherwise
            // block it, causing a theme flash before hydration re-applies)
            __html: PREPAINT_SCRIPT,
          }}
        />
      </head>
      <body
        // suppressHydrationWarning: browser extensions (font-size adjusters,
        // dark-mode injectors, etc.) mutate <body> attributes before React
        // hydrates — e.g. style="-webkit-text-size-adjust:75%" — which is a
        // harmless attribute mismatch, not an app defect.
        suppressHydrationWarning
        className={`${GeistSans.variable} ${GeistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
