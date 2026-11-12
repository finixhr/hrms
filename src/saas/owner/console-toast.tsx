"use client"
// ============ Shared owner-console inline toast (UXD-6, P2 wave 2026-11-09) ============
// Extracted from the support page's local hook: the same inline-toast
// discipline (zero blocking browser alert() dialogs) is now shared by every
// owner console page — the settings page previously threw modal alert()s on
// failed gateway/password/logo saves while the support page in the same
// console advertised this calmer pattern.
import { useCallback, useEffect, useState } from "react"
import { CheckCircle2, XCircle } from "lucide-react"
import { cn } from "@/lib/utils"

/** Inline toast (the P2 billing discipline — zero browser alerts). */
function Toast({ tone, children }: { tone: "ok" | "err"; children: React.ReactNode }) {
  return (
    <div className={cn("flex items-start gap-2 rounded-xl border p-3 text-sm",
      tone === "ok"
        ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-200 light:text-emerald-700"
        : "border-rose-400/40 bg-rose-500/10 text-rose-200 light:text-rose-700")} role="status">
      {tone === "ok" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
      <span className="whitespace-pre-wrap">{children}</span>
    </div>
  )
}

/** Inline toast for an owner console page: `const { notify, node } =
 *  useConsoleToast()` — render {node} near the top of the page and call
 *  notify("ok" | "err", text). Auto-dismisses after 6 seconds. */
export function useConsoleToast() {
  const [toast, setToast] = useState<{ tone: "ok" | "err"; text: string } | null>(null)
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 6_000)
    return () => clearTimeout(t)
  }, [toast])
  const notify = useCallback((tone: "ok" | "err", text: string) => setToast({ tone, text }), [])
  const node = toast ? <Toast tone={toast.tone}>{toast.text}</Toast> : null
  return { notify, node }
}
