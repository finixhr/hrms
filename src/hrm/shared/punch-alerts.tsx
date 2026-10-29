"use client"
// ============ Real-time punch alerts (2026-10-07) ============
// App-wide, non-intrusive toast whenever an employee punches on an attendance
// device, or checks in/out by geo-fence or selfie. Mounted once in the app
// shell, so it works on every page (not only Attendance → Daily).
//
// Who sees it is decided SERVER-SIDE by attendance.punchAlerts: alerts must be
// enabled in HR Settings → Communications → Wishes & Notifications → Punch
// Alerts, and the user must hold the configured permission. Branch/department
// managers only hear about employees in their own scope.
//
// Polling is visibility-aware (a hidden tab makes no requests), the interval
// comes from the tenant setting, and each user can mute alerts for their own
// browser (bell toggle on Attendance → Daily; same preference key).
import { useEffect, useRef } from "react"
import { toast as renderToast } from "@/hooks/use-toast"
import { rpc } from "../api"
import { useHrm } from "../store"

export const PUNCH_ALERT_MUTE_KEY = "hrm_att_live_toasts"
export const PUNCH_ALERT_MUTE_EVENT = "hrm:punch-alerts-mute"

type PunchEvent = {
  id: string
  name: string
  code: string
  type: "CHECK_IN" | "CHECK_OUT" | "PUNCH"
  source: "DEVICE" | "GEOFENCE" | "SELFIE"
  occurredAt: string
}
type Feed = { enabled: boolean; pollSeconds: number; cursor: string; events: PunchEvent[] }

export function punchAlertsMuted(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(PUNCH_ALERT_MUTE_KEY) === "0"
  } catch {
    return false // storage unavailable (private mode) — alerts stay on
  }
}

export function setPunchAlertsMuted(muted: boolean) {
  try {
    window.localStorage.setItem(PUNCH_ALERT_MUTE_KEY, muted ? "0" : "1")
  } catch { /* private mode — preference lasts for this page only */ }
  window.dispatchEvent(new CustomEvent(PUNCH_ALERT_MUTE_EVENT, { detail: { muted } }))
}

const SOURCE_LABEL: Record<PunchEvent["source"], string> = {
  DEVICE: "Device",
  GEOFENCE: "Geo-fence",
  SELFIE: "Selfie",
}

function verb(t: PunchEvent["type"]): string {
  return t === "CHECK_OUT" ? "checked out" : t === "PUNCH" ? "punched" : "checked in"
}

function clock(iso: string): string {
  const d = new Date(iso)
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""
}

export function PunchAlerts() {
  const user = useHrm((s) => s.user)
  const cursorRef = useRef<string | null>(null)

  useEffect(() => {
    if (!user) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let delayMs = 15_000
    let disabled = false
    cursorRef.current = null

    const schedule = () => {
      if (cancelled) return
      timer = setTimeout(tick, delayMs)
    }

    const tick = async () => {
      if (cancelled) return
      // hidden tab / muted browser → no request; the next visible tick
      // resumes from the cursor (bounded server-side to recent punches)
      if (document.visibilityState !== "visible" || punchAlertsMuted()) return schedule()
      try {
        const res = await rpc<Feed>("attendance.punchAlerts", cursorRef.current ? { after: cursorRef.current } : {})
        if (cancelled) return
        delayMs = Math.min(120, Math.max(10, res.pollSeconds || 15)) * 1000
        if (!res.enabled) {
          // not enabled for this tenant/user — check again rarely (settings
          // or role can change) without generating steady traffic
          disabled = true
          delayMs = 5 * 60_000
          cursorRef.current = null
          return schedule()
        }
        disabled = false
        const first = cursorRef.current == null
        cursorRef.current = res.cursor
        if (!first && res.events.length) show(res.events)
      } catch {
        // best-effort — never disturb the user; back off a little
        delayMs = Math.min(delayMs * 2, 120_000)
      }
      schedule()
    }

    const onVisible = () => {
      if (document.visibilityState === "visible" && !disabled && timer) {
        clearTimeout(timer)
        timer = null
        void tick()
      }
    }
    const onMute = () => {
      // unmuting starts from "now" — punches recorded while muted are not replayed
      cursorRef.current = null
    }

    void tick()
    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener(PUNCH_ALERT_MUTE_EVENT, onMute)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener(PUNCH_ALERT_MUTE_EVENT, onMute)
    }
  }, [user])

  return null
}

function show(events: PunchEvent[]) {
  if (events.length === 1) {
    const e = events[0]
    renderToast({
      title: `${e.name} ${verb(e.type)}`,
      description: `${e.code ? `${e.code} · ` : ""}${clock(e.occurredAt)} · ${SOURCE_LABEL[e.source]}`,
    })
    return
  }
  if (events.length <= 3) {
    renderToast({
      title: `${events.length} new punches`,
      description: events.map((e) => `${e.name} ${verb(e.type)} ${clock(e.occurredAt)} (${SOURCE_LABEL[e.source]})`).join(" · "),
    })
    return
  }
  const bySource = events.reduce<Record<string, number>>((acc, e) => {
    acc[SOURCE_LABEL[e.source]] = (acc[SOURCE_LABEL[e.source]] || 0) + 1
    return acc
  }, {})
  renderToast({
    title: `${events.length} new punches recorded`,
    description: Object.entries(bySource).map(([k, n]) => `${n} via ${k}`).join(" · "),
  })
}
