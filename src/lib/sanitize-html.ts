// ============ HTML escaping + whitelist sanitizer (H-1, GAP-312) ============
// No server imports, so a page block can use the same sanitizer as the letter
// and rich-text paths instead of a weaker copy. src/hrm-server/security.ts
// re-exports these names.

/** Escape a value for safe interpolation into HTML text content or quoted attributes. */
export function escapeHtml(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/** Escape a URL destined for a quoted attribute (src="…"): blocks attribute breakout. */
export function escapeAttrUrl(url: unknown): string {
  const s = String(url ?? "").trim()
  // only allow http(s) and data: image URLs (logos/photos are data-URLs or https links)
  if (!/^(https?:\/\/|data:image\/)/i.test(s)) return ""
  return escapeHtml(s)
}

const ALLOWED_TAGS = new Set([
  "p", "br", "b", "strong", "i", "em", "u", "s", "sub", "sup", "span", "div",
  "ul", "ol", "li", "blockquote", "pre", "code",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "table", "thead", "tbody", "tr", "td", "th", "caption", "colgroup", "col",
  "img", "hr", "a", "font", "center", "small", "big",
])
const ALLOWED_ATTRS = new Set([
  "align", "valign", "width", "height", "border", "cellpadding", "cellspacing",
  "colspan", "rowspan", "src", "alt", "title", "href", "target", "color", "face", "size",
  "bgcolor", "dir", "lang",
])
// SEC-10 (2026-11-09, P2 wave) — style/class/id were removed from the
// allowlist: owner-authored HTML rendered through dangerouslySetInnerHTML
// could use them to inject arbitrary CSS overlays (position:fixed click
// hijackers, full-viewport opaque layers) and hijack page structure. Legacy
// presentational attributes (align/width/height/bgcolor/color…) stay — they
// carry formatting for letter bodies without a CSS escape hatch.
// Target=_blank links additionally get a server-added rel="noopener
// noreferrer" (see sanitizeHtml) so CMS-authored links can never degrade
// into a reverse tabnabbing primitive.

/**
 * Whitelist sanitizer for admin-authored rich content (letter bodies).
 * Removes every tag/attribute outside the safe set, all on* handlers,
 * javascript:/vbscript: URLs and <script>/<style>/<iframe> blocks.
 * Mirrors H-1: letter bodies keep their formatting, lose their attack surface.
 */
export function sanitizeHtml(html: string): string {
  if (!html) return ""
  let out = String(html)
  // drop dangerous whole-block elements including their content
  out = out.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
  out = out.replace(/<style\b[\s\S]*?<\/style\s*>/gi, "")
  out = out.replace(/<(iframe|object|embed|form|meta|link|base|svg|math)\b[\s\S]*?<\/\1\s*>/gi, "")
  out = out.replace(/<(iframe|object|embed|form|meta|link|base|input|textarea|select|button)\b[^>]*\/?>/gi, "")
  // neutralize stray closers for removed blocks
  out = out.replace(/<\/(script|style|iframe|object|embed|svg|math)\s*>/gi, "")
  // filter remaining tags
  out = out.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g, (m, rawTag, rawAttrs) => {
    const tag = String(rawTag).toLowerCase()
    if (!ALLOWED_TAGS.has(tag)) return ""
    const closing = m.startsWith("</")
    if (closing) return `</${tag}>`
    let attrs = ""
    const attrRe = /([a-zA-Z][a-zA-Z0-9:-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g
    let am: RegExpExecArray | null
    while ((am = attrRe.exec(String(rawAttrs))) !== null) {
      const name = String(am[1]).toLowerCase()
      if (!ALLOWED_ATTRS.has(name)) continue
      if (/^on/i.test(name)) continue // belt & braces (never in the allow set anyway)
      const value = String(am[3] ?? am[4] ?? am[5] ?? "")
      if ((name === "href" || name === "src") && !/^(https?:\/\/|data:image\/|#)/i.test(value.trim())) continue
      attrs += ` ${name}="${escapeHtml(value)}"`
    }
    if (tag === "img" && !/\bsrc=/.test(attrs)) return "" // an img without a safe src is noise
    // SEC-10 — a link that opens a new browsing context ALWAYS carries
    // rel="noopener noreferrer": the allowlist drops any author-supplied
    // rel above, so this is the only rel that can reach the DOM.
    if (tag === "a" && /\starget=["']?_blank/i.test(attrs)) {
      attrs += ' rel="noopener noreferrer"'
    }
    return `<${tag}${attrs}>`
  })
  return out
}
