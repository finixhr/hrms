"use client"
// ============ RichTextEditor (R6, 2026-10-12) ============
// A dependency-free rich-text editor for Job Opening description/requirements
// fields (and any future long-form field). Built on a controlled
// contentEditable surface (document.execCommand — deprecated but universally
// implemented and adequate for B/I/U/lists/links/headings).
//
// SECURITY MODEL — the editor NEVER trusts its own content:
//   1. On every change the markup is passed through sanitizeRichText() (a
//      strict whitelist: p, br, strong/b, em/i, u, s, ul/ol/li, a[href http(s)
//      only], h3/h4, blockquote) — everything else (scripts, event handlers,
//      styles, images, iframes…) is stripped BEFORE the value leaves the
//      component, so callers only ever store clean markup.
//   2. The SERVER repeats the same sanitization on save
//      (routes/recruitment.ts sanitizeRichText server-side twin) — a crafted
//      client bypassing the editor still cannot persist XSS.
//   3. Rendering sites use renderRichText() which re-sanitizes before
//      dangerouslySetInnerHTML.
import { useCallback, useEffect, useRef, useState } from "react"
import {
  Bold, Italic, Underline, Strikethrough, List, ListOrdered, Link2, Unlink,
  Heading3, Quote, Undo2, Redo2, Eraser,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

// ---------- sanitizer (shared client/server contract) ----------
const ALLOWED_TAGS = new Set(["P", "BR", "STRONG", "B", "EM", "I", "U", "S", "UL", "OL", "LI", "A", "H3", "H4", "BLOCKQUOTE"])

/** Whitelist-based HTML sanitizer for user-authored rich text.
 *  - keeps only the formatting tags above;
 *  - keeps ONLY the href attribute on <a> (http/https/mailto), adds
 *    rel="noopener noreferrer" + target="_blank";
 *  - strips every other attribute (style, class, on*, src, data-…);
 *  - unwraps disallowed tags (keeps their inner text, drops the markup). */
export function sanitizeRichText(html: string): string {
  if (typeof window === "undefined" || !html) return sanitizeRichTextString(html)
  // DOMParser path (browser): precise and idempotent
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html")
  clean(doc.body)
  return doc.body.innerHTML
}

/** Pure-string fallback sanitizer (server / SSR). Same contract as above. */
export function sanitizeRichTextString(html: string): string {
  if (!html) return ""
  let out = String(html)
  // drop script/style/iframe/object/embed blocks entirely (with content)
  out = out.replace(/<script[\s\S]*?<\/script>/gi, "")
  out = out.replace(/<style[\s\S]*?<\/style>/gi, "")
  out = out.replace(/<(iframe|object|embed|form|svg|math|template)[\s\S]*?<\/\1>/gi, "")
  // strip comments
  out = out.replace(/<!--[\s\S]*?-->/g, "")
  // remove every attribute except safe anchors; drop tags not in the whitelist
  out = out.replace(/<\s*(\/?)\s*([a-zA-Z0-9-]+)((?:\s+[^<>]*)?)>/g, (_m, slash, rawTag, attrs) => {
    const t = String(rawTag).toUpperCase()
    if (!ALLOWED_TAGS.has(t)) return ""
    const norm = t === "B" ? "strong" : t === "I" ? "em" : String(rawTag).toLowerCase() // canonical lowercase, b/i normalized
    if (slash) return `</${norm}>`
    if (t === "A") {
      const href = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(String(attrs))
      const raw = href ? (href[2] ?? href[3] ?? href[4] ?? "") : ""
      const safe = /^(https?:|mailto:)/i.test(raw) ? raw : ""
      return safe ? `<a href="${safe.replace(/"/g, "&quot;")}" target="_blank" rel="noopener noreferrer">` : "<a>"
    }
    return `<${norm}>`
  })
  return out
}

function clean(node: Element) {
  for (const child of Array.from(node.children)) {
    const tag = child.tagName
    if (!ALLOWED_TAGS.has(tag)) {
      // unwrap: hoist children in place, keep the text
      const parent = child.parentNode
      if (!parent) continue
      while (child.firstChild) parent.insertBefore(child.firstChild, child)
      parent.removeChild(child)
      continue
    }
    // anchors: keep ONLY a safe href (http/https/mailto), harden with
    // target=_blank rel=noopener; everything else loses all attributes
    if (tag === "A") {
      const rawHref = child.getAttribute("href") || ""
      const safe = /^(https?:|mailto:)/i.test(rawHref.trim()) ? rawHref.trim() : null
      for (const a of Array.from(child.attributes)) child.removeAttribute(a.name)
      if (safe) {
        child.setAttribute("href", safe)
        child.setAttribute("target", "_blank")
        child.setAttribute("rel", "noopener noreferrer")
      }
    } else {
      for (const a of Array.from(child.attributes)) child.removeAttribute(a.name)
    }
    clean(child)
  }
}

/** Re-sanitize + render helper for dangerouslySetInnerHTML consumers. */
export function renderRichText(html: string | null | undefined): string {
  return sanitizeRichTextString(String(html || ""))
}

// ---------- the editor ----------
export function RichTextEditor({
  value,
  onChange,
  placeholder,
  minHeight = 180,
  disabled,
}: {
  value: string
  onChange: (html: string) => void
  placeholder?: string
  minHeight?: number
  disabled?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [focused, setFocused] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkText, setLinkText] = useState("https://")

  // sync external → DOM (skip while typing: the DOM is the source of truth
  // during composition, external resets only when the value differs after
  // sanitization round-trips)
  useEffect(() => {
    const el = ref.current
    if (!el || !focused) {
      if (el && el.innerHTML !== value) el.innerHTML = value || ""
    }
  }, [value, focused])

  const push = useCallback(() => {
    const el = ref.current
    if (!el) return
    onChange(sanitizeRichText(el.innerHTML))
  }, [onChange])

  const cmd = (command: string, arg?: string) => {
    const el = ref.current
    if (!el || disabled) return
    el.focus()
    document.execCommand(command, false, arg)
    push()
  }

  const toggleLink = () => {
    const el = ref.current
    if (!el || disabled) return
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed && sel.toString().trim()) {
      // has a selection — the inline input applies to it
      setLinkOpen(true)
    } else {
      // no selection — unwrap any link in the current position
      document.execCommand("unlink")
      push()
    }
    void el
  }

  const applyLink = () => {
    const url = linkText.trim()
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) {
      cmd("createLink", url)
    } else {
      // nothing valid — just close
    }
    setLinkOpen(false)
    setLinkText("https://")
  }

  const Btn = ({ icon: Icon, title, onClick, active }: { icon: any; title: string; onClick: () => void; active?: boolean }) => (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} // keep the selection
      onClick={onClick}
      className={cn(
        "inline-flex h-7 w-7 items-center justify-center rounded text-slate-500 transition-colors",
        "hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-800 dark:hover:text-slate-100",
        active && "bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100",
        disabled && "opacity-40 pointer-events-none",
      )}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  )

  return (
    <div className={cn("rounded-md border border-input bg-transparent text-sm shadow-sm", focused && "ring-1 ring-ring")}>
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-0.5 border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/60 rounded-t-md px-1 py-1">
        <Btn icon={Bold} title="Bold (Ctrl+B)" onClick={() => cmd("bold")} />
        <Btn icon={Italic} title="Italic (Ctrl+I)" onClick={() => cmd("italic")} />
        <Btn icon={Underline} title="Underline (Ctrl+U)" onClick={() => cmd("underline")} />
        <Btn icon={Strikethrough} title="Strikethrough" onClick={() => cmd("strikeThrough")} />
        <span className="mx-1 h-4 w-px bg-slate-200 dark:bg-slate-700" />
        <Btn icon={List} title="Bullet list" onClick={() => cmd("insertUnorderedList")} />
        <Btn icon={ListOrdered} title="Numbered list" onClick={() => cmd("insertOrderedList")} />
        <Btn icon={Heading3} title="Section heading" onClick={() => cmd("formatBlock", "<h3>")} />
        <Btn icon={Quote} title="Quote" onClick={() => cmd("formatBlock", "<blockquote>")} />
        <span className="mx-1 h-4 w-px bg-slate-200 dark:bg-slate-700" />
        <Btn icon={Link2} title="Insert link (select text first)" onClick={toggleLink} />
        <Btn icon={Unlink} title="Remove link" onClick={() => cmd("unlink")} />
        <span className="mx-1 h-4 w-px bg-slate-200 dark:bg-slate-700" />
        <Btn icon={Undo2} title="Undo" onClick={() => cmd("undo")} />
        <Btn icon={Redo2} title="Redo" onClick={() => cmd("redo")} />
        <Btn icon={Eraser} title="Clear formatting" onClick={() => { cmd("removeFormat"); cmd("formatBlock", "<p>") }} />
      </div>

      {linkOpen && (
        <div className="flex items-center gap-1.5 border-b border-slate-200 dark:border-slate-800 px-2 py-1.5 bg-amber-50/60 dark:bg-amber-950/20">
          <Input
            autoFocus
            value={linkText}
            onChange={(e) => setLinkText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyLink() } if (e.key === "Escape") setLinkOpen(false) }}
            placeholder="https://example.com/careers"
            className="h-7 text-xs"
          />
          <Button type="button" size="sm" className="h-7 px-2 text-xs" onClick={applyLink}>Apply</Button>
          <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setLinkOpen(false)}>Cancel</Button>
        </div>
      )}

      {/* editable surface */}
      <div
        ref={ref}
        contentEditable={!disabled}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        tabIndex={0}
        data-placeholder={placeholder}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); push() }}
        onInput={push}
        onKeyDown={(e) => {
          // plain-text paste — formatting comes from the toolbar only
          if (e.key === "v" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
            // allow the default paste; sanitization happens in onInput/push
          }
        }}
        onPaste={(e) => {
          e.preventDefault()
          const text = e.clipboardData.getData("text/plain")
          document.execCommand("insertText", false, text)
        }}
        className={cn(
          "rich-text-surface prose prose-sm max-w-none dark:prose-invert",
          "px-3 py-2 focus:outline-none",
          "[&:empty]:before:content-[attr(data-placeholder)] [&:empty]:before:text-slate-400",
        )}
        style={{ minHeight }}
      />

      {/* hidden hint */}
      <p className="px-3 py-1.5 text-[10px] text-slate-400 border-t border-slate-100 dark:border-slate-800/60">
        Formatting: bold, italic, underline, lists, quotes, headings and links. Pasted content is inserted as plain text; unsafe markup is stripped automatically.
      </p>
    </div>
  )
}
