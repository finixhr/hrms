"use client"
// ============ SUPPORT ACCESS banner (Wave 10 — master prompt §2) ============
// Persistent, unmissable banner rendered whenever this workspace was opened
// through a Time-Limited Support session (the third session plane):
//   - WHO is in (operator + tenant), WHICH mode (read-only / controlled write)
//   - a live countdown (UX ONLY — the server enforces the expiry on EVERY
//     request through resolveSupportCtx; this clock can never grant time)
//   - a one-click EXIT that ends the session server-side (audited) and
//     clears the saas_support_session cookie
// Auto-hides (re-bootstraps the app) when the countdown hits zero so the
// operator is never left staring at a dead session.
import { useEffect, useState } from "react"
import { Eye, LogOut, ShieldAlert, Timer } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useHrm } from "@/hrm/store"

function fmtLeft(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

export function SupportBanner() {
  const supportSession = useHrm((s) => s.supportSession)
  const exitSupport = useHrm((s) => s.exitSupport)
  const [left, setLeft] = useState<number | null>(null)
  const [exiting, setExiting] = useState(false)

  useEffect(() => {
    if (!supportSession) return
    const end = new Date(supportSession.expiresAt).getTime()
    const tick = () => {
      const ms = end - Date.now()
      setLeft(ms)
      if (ms <= 0) {
        // the session is server-side dead — bootstrap back to the login screen
        void exitSupport()
      }
    }
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [supportSession?.id, supportSession?.expiresAt])

  if (!supportSession) return null
  const danger = left != null && left < 120_000

  return (
    <div
      role="alert"
      aria-label="Platform support session active"
      className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-3 py-2 sm:px-4 ${danger
        ? "border-red-900 bg-red-950/95 text-red-100"
        : "border-amber-900 bg-gradient-to-r from-amber-950 to-orange-950 text-amber-100"}`}
    >
      <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-black uppercase tracking-[0.14em]">
        <ShieldAlert className="h-3.5 w-3.5" /> Support access
      </span>
      <span className="text-xs font-semibold">
        {supportSession.operatorName} · {supportSession.tenantName}
      </span>
      <span className="flex items-center gap-1 rounded-full bg-black/30 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide">
        <Eye className="h-3 w-3" />
        {supportSession.accessMode === "CONTROLLED_WRITE" ? "Controlled write (scoped)" : "Read-only"}
      </span>
      <span className={`flex items-center gap-1 text-xs font-bold tabular-nums ${danger ? "text-red-200" : "text-amber-200"}`}>
        <Timer className="h-3.5 w-3.5" />
        {left == null ? "—" : fmtLeft(left)}
      </span>
      <span className="hidden md:inline text-[10px] text-amber-200/70">
        Every action is audited; the session hard-expires server-side regardless of this clock.
      </span>
      <Button
        size="sm"
        variant="outline"
        disabled={exiting}
        onClick={async () => { setExiting(true); await exitSupport(); setExiting(false) }}
        className="ml-auto h-7 shrink-0 border-amber-400/40 bg-black/20 text-[11px] font-bold text-amber-100 hover:bg-black/40 hover:text-white"
      >
        <LogOut className="h-3 w-3" /> Exit support session
      </Button>
    </div>
  )
}
