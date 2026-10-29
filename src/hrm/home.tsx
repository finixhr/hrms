"use client"
// Client shell for the app root (moved out of src/app/page.tsx so the page
// file can stay a server component and force per-request rendering — see
// page.tsx for why that is required).
import { useEffect } from "react"
import { Loader2 } from "lucide-react"
import { useHrm } from "@/hrm/store"
import { LoginView } from "@/hrm/views/login"
import { AppShell } from "@/hrm/app-shell"
import { isChunkLoadError, healStaleChunk } from "@/hrm/chunk-recovery"

export function HomeClient() {
  const { user, authLoading, init } = useHrm()

  useEffect(() => {
    init()
  }, [init])

  // One-time startup sweep: unregister stale service worker & purge CacheStorage
  // so browsers never serve obsolete cached chunks of forms or dialogs.
  useEffect(() => {
    if (typeof window === "undefined") return
    if ("serviceWorker" in navigator && process.env.NODE_ENV !== "production") {
      navigator.serviceWorker.getRegistrations().then((regs) => {
        for (const reg of regs) reg.unregister()
      }).catch(() => {})
    }
    if ("caches" in window) {
      caches.keys().then((keys) => {
        for (const key of keys) {
          if (key === "finix-ess-v1" || process.env.NODE_ENV !== "production") {
            caches.delete(key).catch(() => {})
          }
        }
      }).catch(() => {})
    }
  }, [])

  // CHUNK-ERROR FIX (2026-10-12) — global safety net for chunk-load failures
  // that never pass through React (a bare import() inside an event handler, a
  // script preload, a router-level lazy fetch). Both capture-phase "error"
  // events (resource/script load failures) and unhandled promise rejections
  // (failed dynamic import()) funnel into the SAME guarded one-shot reload,
  // replacing the old behaviour where the portal silently died until the user
  // manually refreshed.
  useEffect(() => {
    const onErr = (e: ErrorEvent) => {
      if (isChunkLoadError(e.error ?? e.message)) healStaleChunk()
    }
    const onRej = (e: PromiseRejectionEvent) => {
      if (isChunkLoadError(e.reason)) healStaleChunk()
    }
    window.addEventListener("error", onErr, true)
    window.addEventListener("unhandledrejection", onRej)
    return () => {
      window.removeEventListener("error", onErr, true)
      window.removeEventListener("unhandledrejection", onRej)
    }
  }, [])

  if (authLoading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-slate-50 dark:bg-slate-950">
        <Loader2 className="h-6 w-6 text-emerald-600 animate-spin" />
        <p className="text-sm text-slate-500">Loading Finix HR…</p>
      </div>
    )
  }

  if (!user) return <LoginView />
  return <AppShell />
}
