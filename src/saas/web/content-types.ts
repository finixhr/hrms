// ============ Website CMS shared types (server + client safe) ============
// Pure types only — no imports from src/hrm-server (client boundary rule).
// Server resolver: src/hrm-server/saas/cms.ts. Owner console writes these
// shapes through owner.cms.* actions; public server components render them.

// ---- Site identity / branding ------------------------------------------------
export type SiteIdentity = {
  siteName: string
  tagline: string
  description: string
  company: string
  country: string
  supportEmail: string
  supportPhone: string
  address: string
  logoUrl: string // data URL or static path ("/logo.svg")
  faviconUrl: string
  navCtaLabel: string
  navCtaHref: string
  navSignInLabel: string
  navSignInHref: string
}

// ---- SEO defaults -------------------------------------------------------------
export type SiteSeo = {
  metaTitle: string
  metaDescription: string
  keywords: string[]
  ogTitle: string
  ogDescription: string
}

// ---- Contact info -------------------------------------------------------------
export type SiteContact = {
  heading: string
  sub: string
  phone: string
  email: string
  address: string
  hours: string
  showForm: boolean
}

// ---- Navigation ----------------------------------------------------------------
export type NavChild = { label: string; href: string; desc?: string }
export type NavItem = { label: string; href: string; children?: NavChild[] }
export type SiteNav = NavItem[]

// ---- Footer ---------------------------------------------------------------------
export type FooterLink = { label: string; href: string }
export type FooterGroup = { title: string; links: FooterLink[] }
export type FooterConfig = { groups: FooterGroup[]; note: string }

// ---- Cursor effect (Owner Console → Website Studio → Cursor) ---------------------
// Controls the premium custom pointer on the public website. Five designs:
//   aurora        — a liquid gradient orb with a light tail and velocity stretch
//   comet         — a bright core followed by a playful particle trail
//   classic       — the minimal dot + glass ring
//   aurora-trail  — a subtle multi-hue gradient RIBBON that flows behind the
//                   pointer, each segment fading as it settles (Wave 11 §12
//                   "Aurora Trail")
//   magnetic-spark — lightweight fading sparks that flare along movement and
//                   die within a few hundred milliseconds (Wave 11 §12
//                   "Magnetic Spark")
// COMET is the platform default style (Wave 11 §12 — "Make Comet the default
// effect for the public marketing website"). The engine
// (src/saas/web/cursor/) additionally self-disables on touch devices and
// prefers-reduced-motion regardless of these flags.
export type CursorStyle = "aurora" | "comet" | "classic" | "aurora-trail" | "magnetic-spark"

export type CursorConfig = {
  enabled: boolean // master switch — false = native cursor everywhere
  style: CursorStyle // which premium design renders on the public site
  primaryColor: string // hex — core dot / ring / orb fill (theme-adaptive)
  accentColor: string // hex — glow, trail particles, hover highlights
  pullStrength: number // 0–10 magnetic pull multiplier (5 = default feel)
  trailIntensity: number // 0–100 movement trail / velocity response strength
  glow: number // 0–100 overall glow intensity
  magnetic: boolean // CTAs/buttons gently pulled toward the pointer
  tilt: boolean // feature/pricing cards tilt ≤1.5° with pointer position
  ripple: boolean // subtle click feedback ring (220ms)
  viewLabels: boolean // "VIEW" morph over large clickable visuals
  viewLabel: string // badge text, 1–8 chars (default "VIEW")
}

// ---- Page builder blocks ------------------------------------------------------
export type CmsBlockType =
  | "hero"
  | "stats"
  | "value-props"
  | "features"
  | "feature-demo"
  | "how-it-works"
  | "clients"
  | "testimonials"
  | "cta"
  | "faq"
  | "pricing"
  | "contact-form"
  | "text"
  | "text-image"
  | "cards"
  | "logos"
  | "custom-html"

export type CmsBlock = {
  id: string
  type: CmsBlockType
  visible: boolean
  data: Record<string, unknown>
}

export type CmsPageRecord = {
  id: string
  slug: string
  title: string
  pageType: string // HOME | SYSTEM | CUSTOM
  status: string // DRAFT | PUBLISHED
  visible: boolean
  sortOrder: number
  showInNav: boolean
  navLabel: string | null
  seoTitle: string | null
  seoDesc: string | null
  blocks: CmsBlock[]
  isSystem: boolean
  updatedAt: string
}

// ---- Features ---------------------------------------------------------------------
export type FeatureContent = {
  problem: string[]
  solution: string[]
  capabilities: { title: string; items: string[] }[]
  workflow: { title: string; body: string }[]
  security: string[]
  cta: { primary: string; secondary: string }
}

export type FeatureRecord = {
  id: string
  slug: string
  title: string
  navLabel: string
  headline: string
  sub: string
  visual: string | null
  icon: string
  accent: string
  sortOrder: number
  visible: boolean
  showOnHome: boolean
  content: FeatureContent
  updatedAt: string
}

// ---- Valued clients ------------------------------------------------------------------
export type ClientMetric = { label: string; value: string }
export type ClientRecord = {
  id: string
  name: string
  industry: string
  description: string
  story: string | null
  quote: string | null
  personName: string | null
  personRole: string | null
  metrics: ClientMetric[]
  logoText: string | null
  logoColor: string
  logoUrl: string | null
  website: string | null
  featured: boolean
  visible: boolean
  sortOrder: number
  updatedAt: string
}

// ---- Testimonials -----------------------------------------------------------------------
export type TestimonialRecord = {
  id: string
  clientName: string
  personName: string
  personRole: string
  quote: string
  rating: number
  visible: boolean
  sortOrder: number
  updatedAt: string
}

// ---- Media -------------------------------------------------------------------------------
export type MediaRecord = {
  id: string
  name: string
  mimeType: string
  size: number
  data: string
  createdAt: string
}
