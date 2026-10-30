"use client"
// ============ Employee Self-Service Portal (spec §15) ============
// The EMPLOYEE-role home (also reachable by HR users with a linked employeeId).
// Own attendance, leave, payslips, loans, expenses, tasks, performance,
// documents, resignation + wishes + geo check-in quick actions.
// 2026-10 round §26–§28: selfie attendance capture when the method policy
// requires it (camera input → client downscale → server-side private proof).
import { useEffect, useState, useSyncExternalStore } from "react"
import {
  CalendarCheck, Plane, Wallet, Landmark, Receipt, ListChecks, FileText,
  LogOut, Cake, Sparkles, MapPin, Clock, Bell, TrendingUp, ShieldCheck, Printer,
  Camera,
  Plus, Send, MessageSquare, CheckCircle2, XCircle, Banknote, Timer, BadgeCheck, Loader2,
  ChevronRight, AlertTriangle, Download, Eye, Package, FileSpreadsheet, BadgeCheck as CertCheck, Paperclip,
  Smartphone, WifiOff, RefreshCw, UserCog, MonitorSmartphone, BriefcaseBusiness, Megaphone, Pin,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"
import { Card, CardContent } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { useHrm } from "../store"
import { useApi, rpc } from "../api"
import { useI18n } from "../i18n"
import {
  PageHeader, StatCard, StatusBadge, fmtMoney, fmtDate, fmtDateTime, titleCase, SectionCard,
  EmptyState, LoadingRows, ErrorBanner, RatingStars, minutesHHMM, KV, openPrintWindow, esc, FieldError, isExpired } from "../shared/ui-kit"
import { DataTable, type Column } from "../shared/data-table"
import { FormDialog, ConfirmDialog, type FieldDef } from "../shared/form-dialog"
import { GoodsRequisitionDialog } from "../shared/goods-requisition-dialog"
// Selfie Attendance G1 — the in-app camera capture dialog + framing guidance
// (replaces the raw OS file-picker path; the payload contract is unchanged).
import { SelfieCaptureDialog, type SelfieResult } from "../shared/selfie-capture"

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
const TASK_STATUSES = ["TODO", "IN_PROGRESS", "ON_HOLD", "COMPLETED", "CANCELLED"]
const LOAN_TYPES = ["PERSONAL", "HOUSING", "MEDICAL", "EMERGENCY", "OTHER"]
const EXPENSE_CATEGORIES = ["TRAVEL", "FOOD", "MEDICAL", "OFFICE", "TRANSPORT", "CLIENT", "OTHER"]
const RESIGN_FLOW = ["SUBMITTED", "UNDER_REVIEW", "MANAGER_APPROVED", "HR_REVIEW", "MANAGEMENT_REVIEW", "NOTICE_PERIOD", "COMPLETED"]

// V4-011: use Dhaka-timezone today to avoid date drift after 18:00 UTC
function today(): string { return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Dhaka" }) }
function plusDays(iso: string, n: number): string { const d = new Date(iso + "T00:00:00"); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10) }
function initials(name?: string): string {
  if (!name) return "?"
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join("").toUpperCase()
}

/** Open server-rendered print-ready HTML (payslip / letter) in a new window. */
async function openHtmlWindow(action: string, payload: Record<string, unknown>, print: boolean, toast: (t: string, k?: "ok" | "err") => void) {
  try {
    const res = await rpc<{ html: string }>(action, payload)
    const w = openPrintWindow(res.html, { print })
    if (!w) { toast("Popup blocked — allow popups to view this document", "err"); return }
  } catch (e: any) {
    toast(e.message || "Could not open document", "err")
  }
}

/** R5 — per-tab gate for the vendor admin's Self-Service Portal visibility
 * controls (Settings → Self-Service Portal). `portalOn(key)` returns true
 * unless the admin explicitly switched that action OFF. */
function usePortalAction(key: string): boolean {
  const cfg = useHrm((s) => s.settings?.essPortal) as Record<string, boolean | undefined> | undefined
  return !(cfg && cfg[key] === false)
}

/** Wave 4 (SG-D) — hydration-safe online/offline subscription. An external
 *  browser-event store read through useSyncExternalStore (no setState inside
 *  effects); the server snapshot assumes online. */
function useIsOnline(): boolean {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener("online", cb)
      window.addEventListener("offline", cb)
      return () => {
        window.removeEventListener("online", cb)
        window.removeEventListener("offline", cb)
      }
    },
    () => navigator.onLine,
    () => true,
  )
}

/** Wave 4 (SG-D) — offline-queue-aware RPC for the ESS punch endpoints.
 *  While the device is offline the service worker (public/sw.js) stores the
 *  POST in IndexedDB and answers with a synthetic 202 { ok, queued, queuedAt }
 *  envelope whose `data` passthrough the shared rpc() wrapper resolves — so a
 *  `queued` marker on the result means "saved on-device, will sync". */
async function rpcMaybeQueued<T = any>(
  action: string,
  payload?: Record<string, unknown>,
): Promise<T & { queued?: boolean; queuedAt?: string }> {
  const res = await rpc<T & { queued?: boolean; queuedAt?: string }>(action, payload)
  // degenerate safety net: an envelope without the data passthrough resolves
  // to undefined — treat that as queued rather than crashing on res.fence
  return res ?? ({ queued: true } as T & { queued?: boolean; queuedAt?: string })
}

export default function EssView() {
  const { user, can, toast } = useHrm()
  // ---- Wave 4 (SG-D): Bangla labels + PWA offline attendance queue ----
  const { t } = useI18n()
  const online = useIsOnline()
  // pending punches stored by /sw.js while offline (mirrored from the
  // worker's postMessages — never read during render)
  const [queueCount, setQueueCount] = useState(0)
  const allowed = can("ess", "view")
  const { data: profile, loading, error, reload: reloadProfile } = useApi<any>(allowed ? "ess.profile" : null)
  const { data: dash, reload: reloadDash } = useApi<any>(allowed ? "ess.dashboard" : null)
  const { data: wishData } = useApi<any>(allowed ? "ess.wishes" : null)
  // R5 — vendor admin's visibility controls for the portal quick actions
  // (Settings → Self-Service Portal). Missing group = all visible (defaults).
  const portalCfg = useHrm((s) => s.settings?.essPortal) || {}
  const portalOn = (k: string) => portalCfg[k] !== false

  // M-23 — search deep links pre-select the tab (palette entries carry params)
  const presetTab = useHrm((s) => (s.view?.key === "ess" && (s.view?.params as any)?.tab)) as string | undefined
  const [tab, setTab] = useState(presetTab || "attendance")
  const [autoDialog, setAutoDialog] = useState<string | null>(null)
  const [geoBusy, setGeoBusy] = useState(false)
  const [outBusy, setOutBusy] = useState(false)
  // §28 selfie check-in busy state + effective method-policy cache (fetched
  // once per mount; the button hides itself when the policy forbids it)
  const [selfieBusy, setSelfieBusy] = useState(false)
  // Selfie Attendance G1 — combined "Selfie + Geo" quick action busy state
  // (declared with the other hooks: BEFORE the early returns — the old
  // placement after `if (!profile) return null` broke the Rules of Hooks)
  const [selfieGeoBusy, setSelfieGeoBusy] = useState(false)
  const [selfieAllowed, setSelfieAllowed] = useState(false)
  // Selfie Attendance G1 — selfie capture now runs in the in-app camera dialog
  // (live preview + framing guidance + quality score). `captureSelfie()` keeps
  // the exact same call shape the punch handlers used before: it resolves a
  // SelfieResult (or null when the employee cancels / refuses the camera).
  const [selfieAsk, setSelfieAsk] = useState<{
    resolve: (r: SelfieResult | null) => void
    title: string
    hint?: string
  } | null>(null)
  const captureSelfie = (title = "Selfie check-in", hint?: string): Promise<SelfieResult | null> =>
    new Promise((resolve) => setSelfieAsk({ resolve, title, hint }))
  const settleSelfie = (r: SelfieResult | null) => {
    selfieAsk?.resolve(r)
    setSelfieAsk(null)
  }

  /** Ask the server (tracking.status) whether the employee's effective
   *  ATTENDANCE_METHOD policy requires a selfie — the client never decides. */
  const selfieRequired = async (): Promise<boolean> => {
    try {
      const s = await rpc<any>("tracking.status", {})
      return !!s?.attendanceMethods?.selfieRequired
    } catch { return false }
  }

  // §28 — is a selfie (with or without GPS) an allowed check-in method for
  // this employee? Drives the quick-action visibility. The server's
  // no-method-policy fallback is permissive (legacy parity — see
  // tracking.status), so a vendor who never configured an ATTENDANCE_METHOD
  // policy still gets the selfie buttons; when a policy EXISTS and forbids
  // selfie, the buttons hide. Silent on any error (no linked employee
  // profile / RPC failure) → buttons stay hidden (that account can't punch).
  useEffect(() => {
    if (!allowed) return
    let alive = true
    rpc<any>("tracking.status", {})
      .then((s) => {
        if (!alive) return
        const methods: string[] = s?.attendanceMethods?.methods || []
        setSelfieAllowed(methods.includes("SELFIE") || methods.includes("GEOFENCE_SELFIE"))
      })
      .catch(() => { /* policy unavailable → keep the buttons hidden */ })
    return () => { alive = false }
  }, [allowed])

  // ---- Wave 4 (SG-D): service-worker wiring (offline attendance queue) ----
  // One mount effect: register /sw.js (ESS view ONLY — never app-wide),
  // mirror the pending-queue count from the worker's postMessages
  // (queue-count / sync-done / sync-rejected) and nudge a flush whenever
  // connectivity returns. The listeners only postMessage and update the
  // mirrored count — an external event subscription, not a render-path write.
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return
    if (process.env.NODE_ENV !== "production") {
      navigator.serviceWorker.getRegistrations().then((regs) => {
        for (const r of regs) r.unregister()
      })
      if ("caches" in window) {
        caches.keys().then((ks) => ks.forEach((k) => caches.delete(k)))
      }
      return
    }
    const sw = navigator.serviceWorker
    const ask = () => sw.controller?.postMessage({ type: "query-queue" })
    const onMessage = (e: MessageEvent) => {
      const d = e.data || {}
      if (d.type === "queue-count") setQueueCount(Number(d.count) || 0)
      else if (d.type === "sync-done") setQueueCount(Number(d.remaining) || 0)
      else if (d.type === "sync-rejected") ask()
    }
    const onControllerChange = () => ask()
    const onOnline = () => sw.controller?.postMessage({ type: "flush-offline" })
    sw.addEventListener("message", onMessage)
    sw.addEventListener("controllerchange", onControllerChange)
    window.addEventListener("online", onOnline)
    sw.register("/sw.js").catch(() => {
      /* offline queue unavailable (insecure context / blocked) — the portal keeps working online-only */
    })
    ask()
    return () => {
      sw.removeEventListener("message", onMessage)
      sw.removeEventListener("controllerchange", onControllerChange)
      window.removeEventListener("online", onOnline)
    }
  }, [])

  const emp = profile?.employee
  const selfEdit = can("ess", "create")
  const selfDl = can("ess", "download") || can("payslip", "download") || can("letters", "download")

  if (!allowed) {
    return (
      <div className="rounded-xl border bg-white dark:bg-slate-900 p-8 text-center">
        <ShieldCheck className="h-8 w-8 text-slate-300 mx-auto mb-2" />
        <p className="text-sm font-medium text-slate-600 dark:text-slate-300">Employee Self-Service is not available for your account.</p>
      </div>
    )
  }
  if (loading) {
    return <div className="space-y-4">
      <div className="h-24 bg-slate-100 dark:bg-slate-800 rounded-xl animate-pulse" />
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-24 bg-slate-100 dark:bg-slate-800 rounded-xl animate-pulse" />)}</div>
    </div>
  }
  if (error) return <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{error}</div>
  if (!profile || !emp) return null

  // ---------- quick actions ----------
  /** One bounded GPS attempt. Resolves with the fix, or null on any
   *  failure/timeout — callers decide whether GPS was mandatory. */
  const getPosition = (opts: { timeout: number; highAccuracy: boolean }): Promise<GeolocationPosition | null> =>
    new Promise((resolve) => {
      if (!navigator.geolocation) { resolve(null); return }
      navigator.geolocation.getCurrentPosition(resolve, () => resolve(null),
        { enableHighAccuracy: opts.highAccuracy, timeout: opts.timeout, maximumAge: 30000 })
    })

  /** Mobile-hardened GPS: secure-context gate (mobile browsers silently block
   *  geolocation on plain HTTP — the old code misreported that as "permission
   *  denied"), then a long high-accuracy attempt, then one fast network-loc
   *  retry (cold GPS locks indoors routinely exceed 15s; a network fix lands
   *  in seconds). Distinguishes permission-denied from no-fix. */
  const getReliablePosition = async (): Promise<{ pos: GeolocationPosition | null; secure: boolean; permissionDenied: boolean }> => {
    if (typeof window !== "undefined" && window.isSecureContext === false) return { pos: null, secure: false, permissionDenied: false }
    if (!navigator.geolocation) return { pos: null, secure: true, permissionDenied: false }
    const denied = await new Promise<boolean>((resolve) => {
      try {
        (navigator as any).permissions?.query({ name: "geolocation" })
          .then((st: any) => resolve(st.state === "denied"))
          .catch(() => resolve(false))
      } catch { resolve(false) }
    })
    if (denied) return { pos: null, secure: true, permissionDenied: true }
    const pos = await getPosition({ timeout: 20000, highAccuracy: true })
      ?? await getPosition({ timeout: 10000, highAccuracy: false })
    return { pos, secure: true, permissionDenied: false }
  }

  const geoCheckIn = async () => {
    const { pos, secure, permissionDenied } = await getReliablePosition()
    if (!secure) {
      toast("Geo check-in needs a secure (HTTPS) connection — open this page over HTTPS or use Selfie Check-In", "err")
      return
    }
    if (permissionDenied) {
      toast("Location permission denied — allow location in your browser settings, or use Selfie Check-In", "err")
      return
    }
    setGeoBusy(true)
    try {
      if (!pos) {
        toast("Could not get your location — move near a window or outdoors and retry, or use Selfie Check-In", "err")
        return
      }
      // 2026-10 round §26–§28: when the effective ATTENDANCE_METHOD policy
      // requires a selfie, capture it BEFORE the check-in call (the server
      // rejects a missing proof with a clear message).
      // Selfie Attendance G1: capture now happens in the in-app camera dialog
      // (framing guidance + live preview). The payload keys are UNCHANGED —
      // `selfieDataUrl` — with optional `selfieQuality` provenance added.
      let shot: SelfieResult | null = null
      if (await selfieRequired()) {
        shot = await captureSelfie("Selfie check-in", "Your attendance policy requires a selfie to check in.")
        if (!shot) { toast("A selfie is required for check-in — capture was cancelled", "err"); return }
      }
      const res = await rpcMaybeQueued("attendance.geofence.checkin", {
        latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracyM: Math.round(pos.coords.accuracy || 0),
        deviceInfo: navigator.userAgent.slice(0, 60),
        ...(shot ? { selfieDataUrl: shot.dataUrl, selfieQuality: shot.quality } : {}),
      })
      if (res?.queued) {
        // Wave 4 — the service worker stored this punch on-device; it replays on sync
        toast(t("Saved offline — will sync when you reconnect"))
        return
      }
      toast(`Checked in at ${res.fence || res.branch || "your branch"}${res.distance != null ? ` (${res.distance}m from center)` : ""} — ${titleCase(res.status)}`)
      reloadDash()
      setAutoDialog(null)
      setTab("attendance")
    } catch (e: any) {
      const msg = String(e.message || "Geo check-in failed")
      // actionable advice on the two most common mobile failures
      toast(/accuracy/i.test(msg) ? `${msg} — move near a window or outdoors and retry` : msg, "err")
    } finally { setGeoBusy(false) }
  }

  // §28 — selfie check-in: best-effort GPS (never blocks), selfie REQUIRED.
  // Visible only when the admin's method policy actually allows it — a dead
  // button that always 403s would just generate support tickets.
  const selfieCheckIn = async () => {
    setSelfieBusy(true)
    try {
      // capture first — the selfie IS the punch; GPS below is best-effort
      const shot = await captureSelfie("Selfie check-in", "Your selfie is the proof of presence for this punch.")
      if (!shot) { toast("Selfie check-in cancelled", "err"); return }
      // best-effort GPS: 8s cap so a cold GPS never stalls the punch —
      // the server treats selfie-without-GPS as the pure SELFIE method.
      const pos = await getPosition({ timeout: 8000, highAccuracy: false })
      const res = await rpcMaybeQueued("attendance.selfie.checkin", {
        selfieDataUrl: shot.dataUrl,
        selfieQuality: shot.quality,
        ...(pos ? { latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracyM: Math.round(pos.coords.accuracy || 0) } : {}),
        deviceInfo: navigator.userAgent.slice(0, 60),
        clientTimestamp: new Date().toISOString(),
        gpsStatus: pos ? "OK" : "UNAVAILABLE",
      })
      if (res?.queued) {
        // Wave 4 — the service worker stored this punch on-device; it replays on sync
        toast(t("Saved offline — will sync when you reconnect"))
        return
      }
      toast(`Checked in${res.fence ? ` at ${res.fence}${res.distance != null ? ` (${res.distance}m from center)` : ""}` : " — selfie proof recorded"} — ${titleCase(res.status)}`)
      reloadDash()
      setAutoDialog(null)
      setTab("attendance")
    } catch (e: any) {
      toast(e.message || "Selfie check-in failed", "err")
    } finally { setSelfieBusy(false) }
  }

  const checkOut = async () => {
    setOutBusy(true)
    try {
      // §26–§28: selfie also applies to check-out when the policy requires it
      let shot: SelfieResult | null = null
      if (await selfieRequired()) {
        shot = await captureSelfie("Selfie check-out", "Your attendance policy requires a selfie to check out.")
        if (!shot) { toast("A selfie is required for check-out — capture was cancelled", "err"); setOutBusy(false); return }
      }
      // prefer a geo-fenced checkout (GPS-validated); fall back to plain checkout
      if (navigator.geolocation) {
        await new Promise<void>((resolve) => {
          navigator.geolocation.getCurrentPosition(
            async (pos) => {
              try {
                const res = await rpcMaybeQueued("attendance.geofence.checkout", {
                  latitude: pos.coords.latitude, longitude: pos.coords.longitude,
                  accuracyM: Math.round(pos.coords.accuracy || 0),
                  deviceInfo: navigator.userAgent.slice(0, 60),
                  ...(shot ? { selfieDataUrl: shot.dataUrl, selfieQuality: shot.quality } : {}),
                })
                if (res?.queued) {
                  // Wave 4 — the service worker stored this punch on-device; it replays on sync
                  toast(t("Saved offline — will sync when you reconnect"))
                  resolve()
                  return
                }
                toast(`Checked out at ${res.fence || res.branch || "your branch"} — ${titleCase(res.status)}${res.overtimeMinutes ? ` · ${minutesHHMM(res.overtimeMinutes)} OT` : ""}`)
                resolve()
              } catch (e: any) {
                toast(e.message || "Geo check-out failed", "err")
                resolve()
              }
            },
            async () => {
              // location denied/unavailable — plain check-out without GPS
              try {
                const res = await rpc("attendance.selfCheckout", {})
                toast(`Checked out — ${titleCase(res.status)}${res.overtimeMinutes ? ` · ${minutesHHMM(res.overtimeMinutes)} OT` : ""}`)
              } catch (e: any) { toast(e.message || "Check-out failed", "err") }
              resolve()
            },
            { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 },
          )
        })
      } else {
        const res = await rpc("attendance.selfCheckout", {})
        toast(`Checked out — ${titleCase(res.status)}${res.overtimeMinutes ? ` · ${minutesHHMM(res.overtimeMinutes)} OT` : ""}`)
      }
      reloadDash()
      setTab("attendance")
    } finally { setOutBusy(false) }
  }

  // Selfie Attendance G1 — combined "Selfie + Geo" quick action. This is the
  // Rysenova-style punch: the employee ALWAYS captures a selfie AND the
  // browser takes a real GPS fix (20s high-accuracy + fast network retry —
  // same hardened path as geoCheckIn). The server records the punch as the
  // GEOFENCE_SELFIE method, validates the fence best-effort (outside →
  // REVIEW, never a silent accept) and stores the private selfie proof.
  // (busy state lives with the other hooks above)
  const selfieGeoCheckIn = async () => {
    const { pos, secure, permissionDenied } = await getReliablePosition()
    if (!secure) {
      toast("Selfie + Geo check-in needs a secure (HTTPS) connection — open this page over HTTPS, or use Selfie Check-In", "err")
      return
    }
    if (permissionDenied) {
      toast("Location permission denied — allow location in your browser settings, or use Selfie Check-In", "err")
      return
    }
    if (!pos) {
      toast("Could not get your location — move near a window or outdoors and retry, or use Selfie Check-In", "err")
      return
    }
    setSelfieGeoBusy(true)
    try {
      const shot = await captureSelfie("Selfie + Geo check-in", "Your selfie is the proof of presence; your GPS position is validated against your branch geo-fence.")
      if (!shot) { toast("Selfie + Geo check-in cancelled", "err"); return }
      const res = await rpcMaybeQueued("attendance.selfie.checkin", {
        selfieDataUrl: shot.dataUrl,
        selfieQuality: shot.quality,
        latitude: pos.coords.latitude, longitude: pos.coords.longitude,
        accuracyM: Math.round(pos.coords.accuracy || 0),
        deviceInfo: navigator.userAgent.slice(0, 60),
        clientTimestamp: new Date().toISOString(),
        gpsStatus: "OK",
      })
      if (res?.queued) {
        // Wave 4 — the service worker stored this punch on-device; it replays on sync
        toast(t("Saved offline — will sync when you reconnect"))
        return
      }
      toast(`Checked in${res.fence ? ` at ${res.fence}${res.distance != null ? ` (${res.distance}m from center)` : ""}` : " — selfie proof recorded"} — ${titleCase(res.status)}`)
      reloadDash()
      setAutoDialog(null)
      setTab("attendance")
    } catch (e: any) {
      const msg = String(e.message || "Selfie + Geo check-in failed")
      toast(/accuracy/i.test(msg) ? `${msg} — move near a window or outdoors and retry` : msg, "err")
    } finally { setSelfieGeoBusy(false) }
  }

  /** Wave 4 (SG-D) — ask the service worker to replay the offline punch
   *  queue now (the "Sync now" button). */
  const flushQueue = () => {
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      navigator.serviceWorker.controller?.postMessage({ type: "flush-offline" })
    }
  }

  const quickActions: { label: string; icon: any; onClick: () => void; busy?: boolean; primary?: boolean }[] = [
    ...(portalOn("showGeoCheckIn") ? [{ label: "Geo Check-In", icon: MapPin, onClick: geoCheckIn, busy: geoBusy, primary: true }] : []),
    ...(portalOn("showSelfieGeoCheckIn") && selfieAllowed ? [{ label: "Selfie + Geo Check-In", icon: BadgeCheck, onClick: selfieGeoCheckIn, busy: selfieGeoBusy, primary: true }] : []),
    ...(portalOn("showSelfieCheckIn") && selfieAllowed ? [{ label: "Selfie Check-In", icon: Camera, onClick: selfieCheckIn, busy: selfieBusy }] : []),
    ...(portalOn("showCheckOut") ? [{ label: "Check Out", icon: Clock, onClick: checkOut, busy: outBusy }] : []),
    ...(portalOn("showApplyLeave") ? [{ label: "Apply Leave", icon: Plane, onClick: () => { setTab("leave"); setAutoDialog("leave") } }] : []),
    ...(portalOn("showExpenseClaim") ? [{ label: "Submit Expense", icon: Receipt, onClick: () => { setTab("expenses"); setAutoDialog("expense") } }] : []),
    ...(portalOn("showLoanRequest") ? [{ label: "Request Loan", icon: Landmark, onClick: () => { setTab("loans"); setAutoDialog("loan") } }] : []),
    ...(portalOn("showGoodsRequest") ? [{ label: "Request Goods", icon: Package, onClick: () => { setTab("goods"); setAutoDialog("goods") } }] : []),
    ...(portalOn("showResignation") ? [{ label: "Submit Resignation", icon: LogOut, onClick: () => { setTab("resignation"); setAutoDialog("resignation") } }] : []),
  ]

  const TABS: { key: string; label: string }[] = [
    { key: "inbox", label: "My Inbox" },
    { key: "profile", label: "My Profile" },
    { key: "attendance", label: "My Attendance" },
    { key: "visits", label: "My Visits" },
    { key: "leave", label: "My Leave" },
    { key: "payroll", label: "My Payslips" },
    { key: "loans", label: "My Loans" },
    { key: "expenses", label: "My Expenses" },
    { key: "assets", label: "My Assets" },
    { key: "tasks", label: "My Tasks" },
    { key: "performance", label: "My Performance" },
    { key: "documents", label: "My Documents" },
    { key: "interviews", label: "My Interviews" },
    { key: "goods", label: "My Requisitions" },
    { key: "taxcert", label: "My AIT/Tax Certificate" },
    { key: "resignation", label: "My Resignation" },
  ]

  return (
    <div className="space-y-5">
      {/* Selfie Attendance G1 — the ONE in-app capture surface (live camera +
          framing guidance + upload fallback). Mounted once and driven by
          captureSelfie(); it replaces the old hidden file input. */}
      <SelfieCaptureDialog
        open={!!selfieAsk}
        title={selfieAsk?.title || "Selfie check-in"}
        hint={selfieAsk?.hint}
        onCaptured={(r) => settleSelfie(r)}
        onCancel={() => settleSelfie(null)}
      />

      {/* ---------- Wave 4 (SG-D): offline attendance-queue indicator (PWA) ---------- */}
      {(!online || queueCount > 0) && (
        <div role="status" aria-live="polite"
          className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2 text-xs sm:text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300">
          <WifiOff className="h-4 w-4 shrink-0" aria-hidden />
          <span className="font-medium">
            {!online ? t("Offline — check-ins will be saved locally") : t("Offline check-ins pending sync")}
          </span>
          {queueCount > 0 && (
            <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-semibold tabular-nums border-amber-300 text-amber-800 dark:border-amber-700 dark:text-amber-300">
              {queueCount}
            </Badge>
          )}
          {queueCount > 0 && (
            <Button size="sm" variant="outline" onClick={flushQueue}
              className="ml-auto h-7 text-[11px] border-amber-300 text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-900/60">
              <RefreshCw className="h-3 w-3 mr-1" /> {t("Sync now")} ({queueCount})
            </Button>
          )}
        </div>
      )}

      <PageHeader
        title={t("My Self-Service Portal")}
        subtitle={`${user?.role === "EMPLOYEE" ? "Employee portal" : "Self-service"} · ${profile.grossSalary ? `Gross ${fmtMoney(profile.grossSalary)}` : "No active salary structure"}`}
        actions={
          <div className="flex flex-wrap gap-1.5">
            {quickActions.map((a) => (
              <Button key={a.label} size="sm" variant={a.primary ? "default" : "outline"} disabled={a.busy}
                onClick={a.onClick}
                className={a.primary ? "h-8 text-xs " : "h-8 text-xs bg-white dark:bg-slate-900"}>
                <a.icon className="h-3.5 w-3.5 mr-1 text-emerald-600" /> {a.busy ? t("Working…") : t(a.label)}
              </Button>
            ))}
          </div>
        }
      />

      {/* ---------- header card ---------- */}
      <Card className="overflow-hidden border-slate-200 dark:border-slate-800">
        <div className="h-1.5 bg-gradient-to-r from-emerald-500 via-teal-500 to-emerald-600" />
        <CardContent className="p-4 sm:p-5">
          <div className="flex flex-col sm:flex-row sm:items-center gap-4">
            <Avatar className="h-16 w-16 border-2 border-emerald-100 dark:border-emerald-900">
              {emp.photoUrl && <AvatarImage src={emp.photoUrl} alt={emp.fullName} />}
              <AvatarFallback className="bg-primary text-primary-foreground text-xl font-bold">{initials(emp.preferredName || emp.fullName)}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-bold text-slate-900 dark:text-slate-50">{emp.fullName}</h2>
                <StatusBadge status={emp.status} />
                {emp.employmentType && <Badge variant="outline" className="text-[10px]">{titleCase(emp.employmentType)}</Badge>}
              </div>
              <p className="text-sm text-slate-600 dark:text-slate-300 mt-0.5">
                {emp.designationName || "—"}{emp.departmentName ? ` · ${emp.departmentName}` : ""}{emp.branchName ? ` · ${emp.branchName}` : ""}
              </p>
              <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5 text-xs text-slate-500">
                <span>Code <b className="text-slate-700 dark:text-slate-200">{emp.code}</b></span>
                <span>Joined <b className="text-slate-700 dark:text-slate-200">{fmtDate(emp.joiningDate)}</b></span>
                {profile.grossSalary && <span>Gross salary <b className="text-emerald-700 dark:text-emerald-400">{fmtMoney(profile.grossSalary)}</b></span>}
                {emp.managerName && <span>Reports to <b className="text-slate-700 dark:text-slate-200">{emp.managerName}</b></span>}
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-2 gap-2 text-center">
                <div className="rounded-lg bg-emerald-50 dark:bg-emerald-950/50 px-4 py-2">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-400">Casual Left</p>
                  <p className="text-xl font-bold text-emerald-700 dark:text-emerald-300 tabular-nums">{dash?.casualRemaining ?? "—"}</p>
                </div>
                <div className="rounded-lg bg-teal-50 dark:bg-teal-950/50 px-4 py-2">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-teal-700 dark:text-teal-400">Open Tasks</p>
                  <p className="text-xl font-bold text-teal-700 dark:text-teal-300 tabular-nums">{dash?.openTasks ?? "—"}</p>
                </div>
              </div>
              {/* ESS-02 (R7) — direct access to the self-service profile editor */}
              <Button size="sm" variant="outline" className="h-8 text-xs border-emerald-200 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800 dark:border-emerald-800 dark:text-emerald-400 dark:hover:bg-emerald-950/50" onClick={() => setTab("profile")}>
                <UserCog className="h-3.5 w-3.5 mr-1.5" /> Edit My Profile
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ---------- wishes ---------- */}
      {(wishData?.wishes || []).length > 0 && (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {(wishData.wishes as any[]).map((w, i) => (
            <div key={i} className={`rounded-xl border p-4 flex items-start gap-3 ${w.kind === "BIRTHDAY" ? "bg-pink-50 dark:bg-pink-950/40 border-pink-200 dark:border-pink-900" : "bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900"}`}>
              {w.kind === "BIRTHDAY" ? <Cake className="h-5 w-5 text-pink-500 shrink-0 mt-0.5" /> : <Sparkles className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />}
              <div className="min-w-0">
                <p className="text-sm font-bold text-slate-800 dark:text-slate-100">
                  {w.kind === "BIRTHDAY" ? `🎂 Happy Birthday, ${w.name}!` : `🎉 Happy Work Anniversary, ${w.name}!`}
                </p>
                <p className="text-xs text-slate-600 dark:text-slate-300 mt-1">{w.message}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ---------- stat cards ---------- */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <StatCard label="Present this month" value={dash?.attendance?.present ?? "—"} sub={`Late ${dash?.attendance?.late ?? 0} · OT ${minutesHHMM(dash?.attendance?.overtimeMinutes || 0)}`} icon={CalendarCheck} tone="emerald" onClick={() => setTab("attendance")} />
        <StatCard label="Casual leave remaining" value={dash?.casualRemaining ?? "—"} sub="this year" icon={Plane} tone="sky" onClick={() => setTab("leave")} />
        <StatCard label="Open tasks" value={dash?.openTasks ?? "—"} sub="assigned to me" icon={ListChecks} tone="violet" onClick={() => setTab("tasks")} />
        <StatCard label="Unread notifications" value={dash?.unreadNotifications ?? "—"} sub="real-time alerts" icon={Bell} tone="rose" onClick={() => setTab("inbox")} />
        <StatCard label="Loan outstanding" value={fmtMoney((dash?.outstandingLoans || 0) + (dash?.outstandingAdvances || 0))} sub={`${dash?.activeLoans || 0} active · advances ${fmtMoney(dash?.outstandingAdvances || 0)}`} icon={Landmark} tone="amber" onClick={() => setTab("loans")} />
        <StatCard label="Pending expenses" value={dash?.pendingExpenses ?? "—"} sub="claims awaiting approval" icon={Receipt} tone="slate" onClick={() => setTab("expenses")} />
      </div>

      {/* ---------- section tabs (local strip for quick-action navigation) ---------- */}
      <div className="flex flex-wrap gap-1 bg-slate-100 dark:bg-slate-800 p-1 rounded-xl">
        {TABS.map((tb) => (
          <button key={tb.key} onClick={() => setTab(tb.key)}
            className={`px-3 py-1.5 rounded-lg text-xs sm:text-sm font-medium transition-colors ${tab === tb.key ? "bg-white dark:bg-slate-900 text-emerald-700 dark:text-emerald-300 shadow-sm" : "text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100"}`}>
            {t(tb.label)}
          </button>
        ))}
      </div>

      {tab === "inbox" && <MyInboxTab onDeepLink={(t2) => setTab(t2)} />}
      {tab === "profile" && <MyProfileTab onSaved={() => { void reloadProfile() }} />}
      {tab === "attendance" && <MyAttendanceTab empId={emp.id} autoDialog={autoDialog} onConsume={() => setAutoDialog(null)} />}
      {tab === "attendance" && <MyDevicesSection />}
      {tab === "attendance" && <ConsentBanner />}
      {tab === "visits" && <MyVisitsTab />}
      {tab === "leave" && <MyLeaveTab autoDialog={autoDialog} onConsume={() => setAutoDialog(null)} />}
      {tab === "payroll" && <MyPayslipsTab canView={selfDl} />}
      {tab === "loans" && <MyLoansTab autoDialog={autoDialog} onConsume={() => setAutoDialog(null)} canEdit={selfEdit} />}
      {tab === "expenses" && <MyExpensesTab autoDialog={autoDialog} onConsume={() => setAutoDialog(null)} canEdit={selfEdit} />}
      {tab === "assets" && <MyAssetsTab />}
      {tab === "tasks" && <MyTasksTab />}
      {tab === "performance" && <MyPerformanceTab />}
      {tab === "documents" && <MyDocumentsTab canView={selfDl} />}
      {tab === "interviews" && <MyInterviewsTab />}
      {tab === "goods" && <MyGoodsTab autoDialog={autoDialog} onConsume={() => setAutoDialog(null)} />}
      {tab === "taxcert" && <MyTaxCertTab />}
      {tab === "resignation" && <MyResignationTab autoDialog={autoDialog} onConsume={() => setAutoDialog(null)} />}

    </div>
  )
}

// ================= MY INBOX (R8 — data-driven notifications) =================
/** notification.type → ESS tab the reader most likely wants. Unknown types
 *  stay in the inbox (nothing worse than a dead-end tap). */
const INBOX_LINK_TABS: Record<string, string> = {
  LEAVE: "leave", LEAVE_BALANCE: "leave",
  LOAN: "loans", EXPENSE: "expenses", PETTY_CASH: "expenses",
  TASK: "tasks", ANNOUNCEMENT: "inbox",
  EXIT: "resignation", EXIT_SETTLEMENT: "resignation",
  PAYROLL: "payroll", PAYSPIP: "payroll",
  ATTENDANCE: "attendance", OVERTIME: "attendance",
  PERFORMANCE: "performance", DOCUMENT: "documents",
  GOODS: "goods", REQUISITION: "goods",
}

// ================= MY PROFILE (ESS-02 R7 — self-service edit) =================
/** Whitelisted self-edit: photo, preferred name, phones, personal email,
 *  present address and emergency contact. Employment/org/bank/identity stay
 *  HR-only (the server whitelist is the source of truth — this form can only
 *  send what it allows). */
function MyProfileTab({ onSaved }: { onSaved: () => void }) {
  const { t } = useI18n()
  const { toast } = useHrm()
  const { data, loading } = useApi<any>("ess.profile")
  const emp = data?.employee
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState<Record<string, string>>({})
  const [photo, setPhoto] = useState<{ photoUrl: string; photoThumb: string } | null>(null)
  const [photoName, setPhotoName] = useState("")

  // hydrate once when the profile lands
  useEffect(() => {
    if (!emp) return
    setForm({
      preferredName: emp.preferredName || "",
      mobile: emp.mobile || "",
      altMobile: emp.altMobile || "",
      personalEmail: emp.personalEmail || "",
      presentAddress: emp.presentAddress || "",
      presentDivision: emp.presentDivision || "",
      presentDistrict: emp.presentDistrict || "",
      presentCity: emp.presentCity || "",
      presentPostCode: emp.presentPostCode || "",
      emergencyName: emp.emergencyName || "",
      emergencyRelation: emp.emergencyRelation || "",
      emergencyMobile: emp.emergencyMobile || "",
    })
  }, [emp?.id])

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const onPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const { processEmployeePhoto } = await import("../shared/photo")
      const processed = await processEmployeePhoto(file)
      setPhoto(processed)
      setPhotoName(file.name)
      toast("Photo ready — save to apply", "ok")
    } catch (err: any) {
      toast(err?.message || "Could not process the photo", "err")
    }
  }

  const save = async () => {
    setBusy(true)
    try {
      const payload: Record<string, unknown> = { ...form }
      if (photo) { payload.photoUrl = photo.photoUrl; payload.photoThumb = photo.photoThumb }
      const res = await rpc<any>("ess.profile.update", payload)
      toast(`Profile updated${res?.updated?.length ? ` (${res.updated.join(", ")})` : ""} — HR has been notified`, "ok")
      setPhoto(null); setPhotoName("")
      onSaved()
    } catch (e: any) {
      toast(e.message || "Could not save", "err")
    } finally { setBusy(false) }
  }

  if (loading || !emp) return <div className="rounded-xl border bg-white dark:bg-slate-900 p-6 text-center text-sm text-slate-400">Loading your profile…</div>

  const field = (k: string, label: string, opts: { type?: string; placeholder?: string } = {}) => (
    <div>
      <label className="text-[11px] font-medium text-slate-500 dark:text-slate-400">{t(label)}</label>
      <input
        type={opts.type || "text"}
        value={form[k] || ""}
        onChange={set(k)}
        placeholder={opts.placeholder}
        className="mt-1 w-full h-9 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 text-sm text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500"
      />
    </div>
  )

  return (
    <div className="space-y-4">
      {/* photo card */}
      <SectionCard title={t("Profile Photo")}>
        <div className="flex items-center gap-4">
          <Avatar className="h-20 w-20 border-2 border-emerald-100 dark:border-emerald-900">
            {(photo?.photoUrl || emp.photoUrl) && <AvatarImage src={photo?.photoUrl || emp.photoUrl} alt={emp.fullName} />}
            <AvatarFallback className="bg-primary text-primary-foreground text-2xl font-bold">{initials(emp.preferredName || emp.fullName)}</AvatarFallback>
          </Avatar>
          <div className="flex-1">
            <label className="inline-flex items-center gap-2 h-9 px-4 rounded-lg bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white text-xs font-semibold cursor-pointer shadow-sm shadow-emerald-600/20 transition-all">
              <Camera className="h-3.5 w-3.5" /> {photo ? "Choose another photo" : "Choose new photo"}
              <input type="file" accept="image/*" className="hidden" onChange={onPhoto} />
            </label>
            <p className="text-[11px] text-slate-400 mt-1.5">
              {photo ? `Ready: ${photoName} — click Save below to apply` : "Square crop, auto-resized (512px + 96px thumbnail). Changes are audited and notify HR."}
            </p>
          </div>
        </div>
      </SectionCard>

      <SectionCard title={t("Contact & Personal Details")} description={t("Keep your own contact details current — changes notify HR.")}>
        <div className="grid sm:grid-cols-2 gap-4">
          {field("preferredName", "Preferred name")}
          {field("personalEmail", "Personal email", { type: "email", placeholder: "you@example.com" })}
          {field("mobile", "Mobile", { placeholder: "01XXXXXXXXX" })}
          {field("altMobile", "Alternate mobile")}
        </div>
      </SectionCard>

      <SectionCard title={t("Present Address")}>
        <div className="grid sm:grid-cols-2 gap-4">
          <div className="sm:col-span-2">{field("presentAddress", "Street address")}</div>
          {field("presentDivision", "Division")}
          {field("presentDistrict", "District")}
          {field("presentCity", "City / Thana")}
          {field("presentPostCode", "Post code")}
        </div>
      </SectionCard>

      <SectionCard title={t("Emergency Contact")}>
        <div className="grid sm:grid-cols-3 gap-4">
          {field("emergencyName", "Contact name")}
          {field("emergencyRelation", "Relation")}
          {field("emergencyMobile", "Contact mobile")}
        </div>
      </SectionCard>

      <div className="flex items-center justify-end gap-3 pb-2">
        <p className="text-[11px] text-slate-400 mr-auto hidden sm:block">Employment, organization, bank and identity details are maintained by HR.</p>
        <Button size="sm" className="bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white shadow-sm shadow-emerald-600/20" disabled={busy} onClick={save}>
          {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-1.5" />} {t("Save My Profile")}
        </Button>
      </div>
    </div>
  )
}

// ================= MY ASSETS (ESS-06 R7) =================
function MyAssetsTab() {
  const { t } = useI18n()
  const { data, loading, error } = useApi<any>("ess.myAssets")
  const rows: any[] = data?.assignments || []
  const outstanding = rows.filter((r) => r.outstanding)
  const overdue = rows.filter((r) => r.overdue)

  const columns: Column<any>[] = [
    {
      key: "assetName", label: "Asset", sortValue: (r) => r.assetName,
      render: (r) => (
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{r.assetName}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">{r.assetCode} · {titleCase(r.category)}{r.brandModel ? ` · ${r.brandModel}` : ""}</p>
        </div>
      ),
    },
    { key: "assignedAt", label: "Assigned", sortValue: (r) => r.assignedAt, render: (r) => <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300">{fmtDate(r.assignedAt?.slice?.(0, 10) || r.assignedAt)}</span> },
    {
      key: "dueAt", label: "Due", render: (r) => r.dueAt
        ? <span className={`text-xs tabular-nums ${r.overdue ? "text-rose-600 font-semibold" : "text-slate-600 dark:text-slate-300"}`}>{fmtDate(r.dueAt?.slice?.(0, 10) || r.dueAt)}{r.overdue ? " · overdue" : ""}</span>
        : <span className="text-xs text-slate-400">—</span>,
    },
    {
      key: "status", label: "Status", render: (r) => r.returnedAt
        ? <Badge variant="outline" className="text-[10px] text-slate-500">Returned {fmtDate(r.returnedAt?.slice?.(0, 10) || r.returnedAt)}</Badge>
        : <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400 text-[10px]">With me</Badge>,
    },
  ]

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Currently holding" value={outstanding.length} icon={MonitorSmartphone} tone="emerald" />
        <StatCard label="Overdue for return" value={overdue.length} icon={AlertTriangle} tone={overdue.length ? "rose" : "slate"} />
        <StatCard label="Total assignments" value={rows.length} icon={Package} tone="teal" />
      </div>
      <SectionCard title={t("My Assets")} description={t("Company equipment assigned to you. Return it to HR or your asset manager — unreturned assets block your exit clearance.")}>
        <DataTable columns={columns} rows={rows} loading={loading} error={error} pageSize={10}
          searchPlaceholder="Search assets…" emptyTitle="No assets assigned" emptyHint="Company equipment (laptop, phone, access card…) assigned to you will appear here." />
      </SectionCard>
    </div>
  )
}

// ================= MY INTERVIEWS (REC-01 R7 — interviewer surface) =================
function MyInterviewsTab() {
  const { t } = useI18n()
  const { data, loading, error } = useApi<any[]>("ats.interviews.mine")
  const rows: any[] = data || []
  const upcoming = rows.filter((r) => !r.outcome && new Date(r.scheduledAt) >= new Date())
  const pendingOutcome = rows.filter((r) => !r.outcome && new Date(r.scheduledAt) < new Date())

  const columns: Column<any>[] = [
    {
      key: "applicantName", label: "Candidate", sortValue: (r) => r.applicantName || "",
      render: (r) => (
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{r.applicantName || "—"}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">{r.openingTitle || "—"}</p>
          <p className="text-[10px] text-slate-400 font-mono mt-0.5">{r.applicantEmailMasked || "—"} · {r.applicantPhoneMasked || "—"}</p>
        </div>
      ),
    },
    { key: "round", label: "Round", render: (r) => <Badge variant="outline" className="text-[10px]">{r.round}</Badge> },
    { key: "mode", label: "Mode", render: (r) => <span className="text-xs text-slate-600 dark:text-slate-300">{titleCase(r.mode)}</span> },
    { key: "scheduledAt", label: "Scheduled", sortValue: (r) => r.scheduledAt, render: (r) => <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300">{fmtDateTime(r.scheduledAt)}</span> },
    {
      key: "outcome", label: "Outcome", render: (r) => r.outcome
        ? <Badge className={`text-[10px] ${r.outcome === "PASSED" ? "bg-emerald-100 text-emerald-700" : r.outcome === "FAILED" ? "bg-rose-100 text-rose-700" : "bg-slate-100 text-slate-600"}`}>{titleCase(r.outcome)}</Badge>
        : <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-200">Pending</Badge>,
    },
    {
      key: "where", label: "", align: "right", render: (r) => (
        <div className="flex items-center gap-2">
          {r.link && <a href={r.link} target="_blank" rel="noreferrer" className="text-xs text-emerald-600 hover:underline font-medium">Join</a>}
          {r.location && <span className="text-[11px] text-slate-400">{r.location}</span>}
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Upcoming" value={upcoming.length} icon={BriefcaseBusiness} tone="emerald" />
        <StatCard label="Awaiting outcome" value={pendingOutcome.length} icon={Timer} tone={pendingOutcome.length ? "amber" : "slate"} />
        <StatCard label="Total" value={rows.length} icon={ListChecks} tone="teal" />
      </div>
      <SectionCard title={t("My Interviews")} description={t("Interviews where you are the named interviewer. Candidate contact details stay with the recruiting team; record outcomes from the Recruitment view.")}>
        <DataTable columns={columns} rows={rows} loading={loading} error={error} pageSize={10}
          searchPlaceholder="Search candidates…" emptyTitle="No interviews assigned" emptyHint="When the recruiting team schedules you as an interviewer, the interviews appear here." />
      </SectionCard>
    </div>
  )
}

function MyInboxTab({ onDeepLink }: { onDeepLink: (tab: string) => void }) {
  const { t } = useI18n()
  const { toast } = useHrm()
  const { data, loading, error, reload } = useApi<any[]>("notifications.list")
  const [onlyUnread, setOnlyUnread] = useState(false)
  const [marking, setMarking] = useState<string | null>(null)

  const all: any[] = data || []
  const rows = onlyUnread ? all.filter((n) => !n.readAt) : all
  const unread = all.filter((n) => !n.readAt).length

  const open = async (n: any) => {
    if (!n.readAt) {
      setMarking(n.id)
      try { await rpc("notifications.read", { id: n.id }); await reload() } catch { /* non-fatal */ } finally { setMarking(null) }
    }
    const want = INBOX_LINK_TABS[String(n.type || "").toUpperCase()]
    if (want && want !== "inbox") onDeepLink(want)
  }

  const markAll = async () => {
    setMarking("all")
    try { await rpc("notifications.read", { all: true }); await reload(); toast(`${unread} notification${unread === 1 ? "" : "s"} marked read`, "ok") }
    catch (e: any) { toast(e.message || "Could not update notifications", "err") }
    finally { setMarking(null) }
  }

  const columns: Column<any>[] = [
    {
      key: "title", label: "Notification", sortValue: (n) => n.title,
      render: (n) => (
        <div className="min-w-0 max-w-[520px]">
          <p className={`text-sm ${n.readAt ? "text-slate-500 dark:text-slate-400" : "font-semibold text-slate-800 dark:text-slate-100"}`}>
            {!n.readAt && <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-rose-500 align-middle" aria-label="unread" />}
            {n.title}
          </p>
          <p className={`text-xs ${n.readAt ? "text-slate-400 dark:text-slate-500" : "text-slate-600 dark:text-slate-300"} line-clamp-2`}>{n.message}</p>
          <div className="mt-1 flex items-center gap-1.5">
            <Badge variant="outline" className="h-4 px-1.5 text-[9px] font-semibold tracking-wide text-slate-400">{n.type}</Badge>
            {INBOX_LINK_TABS[String(n.type || "").toUpperCase()] && INBOX_LINK_TABS[String(n.type || "").toUpperCase()] !== "inbox" && (
              <Badge variant="outline" className="h-4 px-1.5 text-[9px] font-semibold tracking-wide text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800">tap to open</Badge>
            )}
          </div>
        </div>
      ),
    },
    { key: "createdAt", label: "Received", align: "right", sortValue: (n) => n.createdAt, render: (n) => <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">{fmtDateTime(n.createdAt)}</span> },
    {
      key: "actions", label: "", align: "right",
      render: (n) => !n.readAt ? (
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={marking === n.id} onClick={() => open(n)}>
          {marking === n.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
        </Button>
      ) : (
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-slate-400" onClick={() => open(n)} title={INBOX_LINK_TABS[String(n.type || "").toUpperCase()] ? "Open related section" : undefined}>
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      ),
    },
  ]

  return (
    <>
    <SectionCard title={<span>My Inbox <span className="text-slate-400 font-normal">· live notifications for you · {unread} unread</span></span>}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant={onlyUnread ? "default" : "outline"} className="h-8 text-xs" onClick={() => setOnlyUnread(!onlyUnread)}>
          {onlyUnread ? t("Unread only") : t("All notifications")}
        </Button>
        <Button size="sm" variant="outline" className="h-8 text-xs" disabled={!unread || marking === "all"} onClick={markAll}>
          {marking === "all" ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5 mr-1" />}
          {t("Mark all read")}
        </Button>
      </div>
      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        error={error}
        emptyTitle={onlyUnread ? "You are all caught up" : "No notifications yet"}
        emptyHint={onlyUnread ? "Unread alerts appear here the moment something needs your attention — leave decisions, payslips, task updates, announcements." : "Leave decisions, loan updates, task assignments, payslips and company announcements will land here in real time."}
      />
    </SectionCard>
    {/* COM-02 (R7) — the notice board: audience-filtered announcements with
        read tracking. Opening a notice marks it read (receipts power HR's
        read stats). */}
    <MyNoticesCard />
    </>
  )
}

/** COM-02 (R7) — company notices with read receipts (ESS reading surface). */
function MyNoticesCard() {
  const { t } = useI18n()
  const { data, loading } = useApi<any[]>("announcements.list")
  const notices: any[] = data || []
  const [expanded, setExpanded] = useState<string | null>(null)
  const unread = notices.filter((n) => !n.readAt)

  const openNotice = async (n: any) => {
    setExpanded(expanded === n.id ? null : n.id)
    if (!n.readAt) {
      try { await rpc("announcements.read", { id: n.id }) } catch { /* non-fatal */ }
    }
  }

  if (loading) return null
  return (
    <SectionCard title={<span>Company Notices <span className="text-slate-400 font-normal">· {unread.length ? `${unread.length} unread` : "all read"}</span></span>} description={t("Official announcements addressed to you. Opening a notice confirms you have read it.")}>
      {notices.length === 0 && <EmptyState icon={Megaphone} title="No notices right now" hint="Company announcements addressed to you will appear here." />}
      <div className="space-y-2">
        {notices.map((n) => (
          <button key={n.id} onClick={() => openNotice(n)}
            className={`w-full text-left rounded-xl border p-3.5 transition-all hover:shadow-sm ${n.readAt ? "border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60" : "border-emerald-200 dark:border-emerald-900/60 bg-gradient-to-r from-emerald-50/80 to-teal-50/40 dark:from-emerald-950/40 dark:to-teal-950/20"}`}>
            <div className="flex items-start gap-3">
              <div className={`mt-0.5 h-8 w-8 shrink-0 rounded-lg flex items-center justify-center ${n.pinned ? "bg-amber-100 text-amber-600 dark:bg-amber-950 dark:text-amber-400" : "bg-emerald-100 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400"}`}>
                {n.pinned ? <Pin className="h-4 w-4" /> : <Megaphone className="h-4 w-4" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className={`text-sm ${n.readAt ? "font-medium text-slate-700 dark:text-slate-200" : "font-semibold text-slate-900 dark:text-white"}`}>{n.title}</p>
                  {n.pinned && <Badge className="bg-amber-100 text-amber-700 text-[9px]">Pinned</Badge>}
                  {!n.readAt && <span className="inline-block h-2 w-2 rounded-full bg-rose-500" aria-label="unread" />}
                </div>
                <p className="text-[11px] text-slate-400 mt-0.5">{fmtDateTime(n.publishedAt || n.createdAt)}{n.readAt ? " · read" : ""}</p>
                {expanded === n.id && <p className="text-xs text-slate-600 dark:text-slate-300 mt-2 whitespace-pre-wrap leading-relaxed">{n.body}</p>}
              </div>
              <ChevronRight className={`h-4 w-4 text-slate-300 mt-1 transition-transform ${expanded === n.id ? "rotate-90" : ""}`} />
            </div>
          </button>
        ))}
      </div>
    </SectionCard>
  )
}

// ================= MY ATTENDANCE =================
function MyAttendanceTab({ empId, autoDialog, onConsume }: { empId: string; autoDialog: string | null; onConsume: () => void }) {
  const { can } = useHrm()
  const { t } = useI18n()
  const now = new Date()
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [year, setYear] = useState(now.getFullYear())
  const { data, loading, error, reload } = useApi<any>("ess.attendance", { month, year })
  const [corrOpen, setCorrOpen] = useState(false)
  const canEdit = can("ess", "create") || can("attendance", "create")

  const records = data?.records || []
  const summary = data?.summary || {}
  const todayRec = data?.today

  const corrFields: FieldDef[] = [
    { name: "date", label: "Date", type: "date", required: true, defaultValue: today() },
    { name: "requestedIn", label: "Corrected Check-In", type: "time", help: "Leave blank to keep as-is" },
    { name: "requestedOut", label: "Corrected Check-Out", type: "time" },
    { name: "reason", label: "Reason", type: "textarea", rows: 3, required: true, span: 2, placeholder: "e.g. Device failed to register my check-in" },
  ]

  const columns: Column<any>[] = [
    { key: "date", label: "Date", sortValue: (r) => r.date, render: (r) => <span className="text-xs font-medium tabular-nums text-slate-700 dark:text-slate-200">{fmtDate(r.date)}</span> },
    { key: "status", label: "Status", render: (r) => <StatusBadge status={r.status} /> },
    { key: "checkIn", label: "Check In", render: (r) => <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300">{r.checkIn || "—"}</span> },
    { key: "checkOut", label: "Check Out", render: (r) => <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300">{r.checkOut || "—"}</span> },
    { key: "workingMinutes", label: "Working", align: "right", render: (r) => <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300">{minutesHHMM(r.workingMinutes)}</span> },
    { key: "lateMinutes", label: "Late", align: "right", render: (r) => <span className={`text-xs tabular-nums ${r.lateMinutes ? "text-amber-600 font-medium" : "text-slate-400"}`}>{r.lateMinutes ? `${r.lateMinutes}m` : "—"}</span> },
    { key: "overtimeMinutes", label: "OT", align: "right", render: (r) => <span className={`text-xs tabular-nums ${r.overtimeMinutes ? "text-emerald-600 font-medium" : "text-slate-400"}`}>{minutesHHMM(r.overtimeMinutes)}</span> },
    { key: "source", label: "Source", render: (r) => <Badge variant="outline" className="text-[10px]">{titleCase(r.source)}</Badge> },
  ]

  return (
    <div className="space-y-4">
      {/* month selector + today */}
      <div className="grid lg:grid-cols-3 gap-4">
        <SectionCard title={t("Period")} className="lg:col-span-2">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={String(month)} onValueChange={(v) => setMonth(Number(v))}>
              <SelectTrigger className="w-[150px] h-9"><SelectValue /></SelectTrigger>
              <SelectContent>{MONTHS.map((m, i) => <SelectItem key={m} value={String(i + 1)}>{m}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
              <SelectTrigger className="w-[110px] h-9"><SelectValue /></SelectTrigger>
              <SelectContent>{[year + 1, year, year - 1, year - 2].map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}</SelectContent>
            </Select>
            {canEdit && (
              <Button size="sm" className="ml-auto h-9 text-xs " onClick={() => setCorrOpen(true)}>
                <AlertTriangle className="h-3.5 w-3.5 mr-1" /> {t("Request Correction")}
              </Button>
            )}
          </div>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mt-4">
            <Chip label="Present" value={summary.present} tone="emerald" />
            <Chip label="Absent" value={summary.absent} tone="rose" />
            <Chip label="Late" value={summary.late} tone="amber" />
            <Chip label="On Leave" value={summary.leave} tone="orange" />
            <Chip label="Overtime" value={minutesHHMM(summary.overtimeMinutes)} tone="teal" />
            <Chip label="Working" value={minutesHHMM(summary.workingMinutes)} tone="slate" />
          </div>
        </SectionCard>
        <SectionCard title={t("Today")}>
          {todayRec ? (
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2"><StatusBadge status={todayRec.status} /><span className="text-xs text-slate-400">{titleCase(todayRec.source)}</span></div>
              <KV items={[["Check In", <span key="i" className="tabular-nums">{todayRec.checkIn || "—"}</span>], ["Check Out", <span key="o" className="tabular-nums">{todayRec.checkOut || "—"}</span>]]} />
              {todayRec.remarks && <p className="text-xs text-slate-500">{todayRec.remarks}</p>}
            </div>
          ) : (
            <EmptyState icon={Clock} title="Not checked in yet" hint="Use Geo Check-In above when you arrive at your branch." />
          )}
        </SectionCard>
      </div>

      <DataTable columns={columns} rows={records} loading={loading} error={error} pageSize={15} searchable
        searchPlaceholder="Search date / status…" emptyTitle="No attendance records" emptyHint="Records appear once attendance is marked for you." />

      <FormDialog open={corrOpen || autoDialog === "correction"} onOpenChange={(v) => { if (!v) { setCorrOpen(false); onConsume(); reload() } }}
        title="Request Attendance Correction" description="HR reviews corrections; the decision is audit-logged."
        fields={corrFields}
        onSubmit={async (v) => { await rpc("attendance.corrections.request", { employeeId: empId, ...v }) }} />
    </div>
  )
}

function Chip({ label, value, tone }: { label: string; value: any; tone: string }) {
  const tones: Record<string, string> = {
    emerald: "bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300",
    rose: "bg-rose-50 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300",
    amber: "bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300",
    orange: "bg-orange-50 dark:bg-orange-950/50 text-orange-700 dark:text-orange-300",
    teal: "bg-teal-50 dark:bg-teal-950/50 text-teal-700 dark:text-teal-300",
    slate: "bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300",
  }
  return (
    <div className={`rounded-lg p-2.5 ${tones[tone]}`}>
      <p className="text-[10px] font-medium uppercase tracking-wide opacity-80">{label}</p>
      <p className="text-base font-bold tabular-nums">{value ?? 0}</p>
    </div>
  )
}

// ================= MY LEAVE =================
function MyLeaveTab({ autoDialog, onConsume }: { autoDialog: string | null; onConsume: () => void }) {
  const { can, toast } = useHrm()
  const { t } = useI18n()
  const { data, loading, error, reload } = useApi<any>("ess.leave")
  const [applyOpen, setApplyOpen] = useState(false)
  const [subTarget, setSubTarget] = useState<any>(null)
  // LVE-007 (R3-4) — ESS encashment entry point: the leave.encash route,
  // ENCASHMENT approval workflow and finalize hook all existed but nothing
  // in the UI ever called them — long-tenured employees can now request an
  // in-service payout of accrued leave (the days reserve as PENDING until
  // the request is decided; the payout rides payroll as a bonus).
  const [encashTarget, setEncashTarget] = useState<any | null>(null)
  const [encashDays, setEncashDays] = useState("")
  const [encashBusy, setEncashBusy] = useState(false)
  const canEdit = can("ess", "create")
  // R5 — hide the in-tab Apply Leave button when the admin disabled it
  const canApplyLeave = usePortalAction("showApplyLeave")
  const balances = data?.balances || []
  const types = data?.types || []
  const requests = data?.requests || []
  const substituteRequests = data?.substituteRequests || []

  const encashable = (b: any) => {
    const tp = types.find((x: any) => x.id === b.leaveTypeId)
    return !!tp?.encashmentAllowed && b.remaining > 0
  }

  const submitEncash = async () => {
    if (!encashTarget) return
    const days = Number(encashDays)
    if (!(days > 0)) { toast("Enter the number of days to encash", "err"); return }
    setEncashBusy(true)
    try {
      await rpc("leave.encash", { leaveTypeId: encashTarget.leaveTypeId, days })
      toast(`Encashment request for ${days} day(s) of ${encashTarget.typeName} submitted for approval`)
      setEncashTarget(null); setEncashDays("")
      reload()
    } catch (e: any) {
      toast(e.message, "err")
    } finally {
      setEncashBusy(false)
    }
  }

  const respond = async (id: string, decision: "ACCEPTED" | "DECLINED") => {
    try {
      await rpc("leaveRequests.substitute.respond", { id, decision })
      toast(`Substitute assignment ${decision.toLowerCase()}`)
      reload()
    } catch (e: any) { toast(e.message, "err") }
  }

  const columns: Column<any>[] = [
    { key: "typeName", label: "Type", render: (r) => <span className="text-xs font-medium text-slate-700 dark:text-slate-200">{r.typeName || "—"}</span> },
    { key: "fromDate", label: "From", render: (r) => <span className="text-xs tabular-nums">{fmtDate(r.fromDate)}</span> },
    { key: "toDate", label: "To", render: (r) => <span className="text-xs tabular-nums">{fmtDate(r.toDate)}</span> },
    { key: "days", label: "Days", align: "right", render: (r) => <span className="text-xs font-bold tabular-nums">{r.days}</span> },
    { key: "substituteStatus", label: "Substitute", render: (r) => r.substituteStatus ? <StatusBadge status={r.substituteStatus} /> : <span className="text-xs text-slate-400">—</span> },
    {
      // R3 — supporting-document download (audit-logged)
      key: "attachment", label: "File",
      render: (r) => r.attachment?.name ? (
        <Button size="icon" variant="ghost" className="h-7 w-7 text-emerald-600 hover:text-emerald-700" title={`Download attachment — ${r.attachment.name}`}
          onClick={async () => {
            try {
              const res = await rpc<any>("leaveRequests.attachment", { id: r.id })
              const a = document.createElement("a")
              a.href = `data:application/octet-stream;base64,${res.fileData}`
              a.download = res.fileName || "attachment"
              a.click()
            } catch (e: any) {
              toast(e?.message || "Could not download attachment", "err")
            }
          }}>
          <Paperclip className="h-3.5 w-3.5" />
        </Button>
      ) : <span className="text-xs text-slate-400">—</span>,
    },
    { key: "status", label: "Status", render: (r) => <StatusBadge status={r.status} /> },
    { key: "reason", label: "Reason", render: (r) => <span className="text-xs text-slate-500 line-clamp-1 max-w-[220px]">{r.reason || "—"}</span> },
    {
      key: "actions", label: "", align: "right", render: (r) => canEdit && ["PENDING", "APPROVED"].includes(r.status) && (
        <Button size="sm" variant="outline" className="h-7 text-[10px]" onClick={async () => {
          try { await rpc("leaveRequests.cancel", { id: r.id }); toast("Leave request cancelled"); reload() } catch (e: any) { toast(e.message, "err") }
        }}>Cancel</Button>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      {/* balances */}
      <SectionCard title={t("Leave Balances (this year)")} actions={canEdit && canApplyLeave && (
        <Button size="sm" className="h-8 text-xs " onClick={() => setApplyOpen(true)}>
          <Plus className="h-3.5 w-3.5 mr-1" /> {t("Apply Leave")}
        </Button>
      )}>
        {balances.length === 0 ? (
          <EmptyState icon={Plane} title="No leave balances yet" hint="Balances are created when HR computes them for the year." />
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {balances.map((b: any) => {
              const pct = b.entitled > 0 ? Math.min(100, Math.round(((b.used + b.pending) / b.entitled) * 100)) : 0
              return (
                <div key={b.id} className="rounded-xl border p-3.5">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{b.typeName || "Leave"}</p>
                    <span className={`text-sm font-bold tabular-nums ${b.remaining > 0 ? "text-emerald-700 dark:text-emerald-400" : "text-rose-600"}`}>{b.remaining}</span>
                  </div>
                  <Progress value={pct} className="h-2 mb-2" />
                  <div className="flex justify-between text-[11px] text-slate-500">
                    <span>Entitled {b.entitled}</span><span>Used {b.used}</span><span>Pending {b.pending}</span><span className="font-medium text-slate-700 dark:text-slate-300">Left {b.remaining}</span>
                  </div>
                  {canEdit && encashable(b) && (
                    <Button size="sm" variant="outline" className="h-7 mt-2 w-full text-[11px]" onClick={() => { setEncashTarget(b); setEncashDays("") }}>
                      Request encashment
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </SectionCard>

      {/* pending substitute requests */}
      {substituteRequests.length > 0 && (
        <SectionCard title={t("Substitute Assignments Awaiting Your Response")}>
          <div className="space-y-2">
            {substituteRequests.map((s: any) => (
              <div key={s.id} className="flex flex-col sm:flex-row sm:items-center gap-2 rounded-xl border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 p-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Leave {fmtDate(s.fromDate)} → {fmtDate(s.toDate)} ({s.days}d)</p>
                  <p className="text-xs text-slate-500 line-clamp-1">{s.reason || "No reason provided"}</p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button size="sm" className="h-8 text-xs " onClick={() => respond(s.id, "ACCEPTED")}>
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Accept
                  </Button>
                  <Button size="sm" variant="outline" className="h-8 text-xs text-rose-600 border-rose-200 hover:bg-rose-50" onClick={() => setSubTarget(s)}>
                    <XCircle className="h-3.5 w-3.5 mr-1" /> Decline
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      <DataTable columns={columns} rows={requests} loading={loading} error={error} pageSize={10}
        searchPlaceholder="Search my leave…" emptyTitle="No leave requests" emptyHint="Apply for leave using the button above." />

      <ApplyLeaveDialog open={(applyOpen && canApplyLeave) || (autoDialog === "leave" && canApplyLeave)} onOpenChange={(v) => { if (!v) { setApplyOpen(false); onConsume(); reload() } }} types={types} />
      {/* LVE-007 — ESS encashment request dialog */}
      <Dialog open={!!encashTarget} onOpenChange={(v) => { if (!v) { setEncashTarget(null); setEncashDays("") } }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Request leave encashment</DialogTitle>
            <DialogDescription>
              {encashTarget?.typeName} — {encashTarget?.remaining} day(s) available. The days are reserved until the request is decided; once approved, the payout is added to your next payroll as a bonus.
            </DialogDescription>
          </DialogHeader>
          <div>
            <Label htmlFor="ess-encash-days">Days to encash</Label>
            <Input id="ess-encash-days" type="number" min={0.5} step={0.5} value={encashDays} onChange={(e) => setEncashDays(e.target.value)} placeholder="e.g. 5" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setEncashTarget(null); setEncashDays("") }} disabled={encashBusy}>Cancel</Button>
            <Button onClick={submitEncash} disabled={encashBusy || !(Number(encashDays) > 0)}>Submit for approval</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog open={!!subTarget} onOpenChange={(v) => { if (!v) setSubTarget(null) }} title="Decline substitute assignment"
        message={`Decline being substitute for the leave ${fmtDate(subTarget?.fromDate)} → ${fmtDate(subTarget?.toDate)}?`}
        confirmLabel="Decline" danger requireReason
        onConfirm={async (reason) => { await rpc("leaveRequests.substitute.respond", { id: subTarget.id, decision: "DECLINED", comment: reason }); reload() }} />
    </div>
  )
}

function ApplyLeaveDialog({ open, onOpenChange, types }: { open: boolean; onOpenChange: (v: boolean) => void; types: any[] }) {
  const toast = useHrm((s) => s.toast)
  // R4 — "Recommend substitute" policy nudge (Settings → Leave). Advisory
  // only: submission without a substitute is always allowed.
  const recommendSubstitute = useHrm((s) => s.settings?.leave?.requireSubstitute) === true
  const [values, setValues] = useState<Record<string, any>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // R3 — optional supporting document (PDF / image, ≤ 2 MB, stored base64)
  const [attachment, setAttachment] = useState<{ name: string; data: string } | null>(null)
  const datesReady = !!values.fromDate && !!values.toDate && values.fromDate <= values.toDate
  const { data: subs } = useApi<any[]>(datesReady ? "leaveRequests.substituteOptions" : null, datesReady ? { fromDate: values.fromDate, toDate: values.toDate } : undefined)

  const onAttachmentFile = (f: File | null) => {
    if (!f) { setAttachment(null); return }
    if (f.size > 2 * 1024 * 1024) { setError("Attachment too large (max 2 MB)"); return }
    const reader = new FileReader()
    reader.onload = () => setAttachment({ name: f.name, data: String(reader.result).split(",")[1] || "" })
    reader.readAsDataURL(f)
  }

  useEffect(() => {
    if (open) { setValues({ fromDate: today(), toDate: today(), halfDay: false }); setAttachment(null); setError(null) }
  }, [open])

  const set = (n: string, v: any) => setValues((s) => ({ ...s, [n]: v }))
  const subOptions = (subs || []).filter((s) => s.eligible)
  const selectedType = types.find((t: any) => t.id === values.leaveTypeId)
  const needsAttachment = !!selectedType?.requiresAttachment

  const submit = async () => {
    if (!values.leaveTypeId) { setError("Leave type is required"); return }
    if (!datesReady) { setError("Invalid date range"); return }
    if (!values.reason || !values.reason.trim()) { setError("Reason is required"); return }
    if (needsAttachment && !attachment) { setError("This leave type requires a supporting document — attach a file"); return }
    setBusy(true)
    try {
      await rpc("leaveRequests.apply", {
        leaveTypeId: values.leaveTypeId, fromDate: values.fromDate, toDate: values.toDate,
        reason: values.reason, contactNumber: (values.contactNumber || "").trim() || undefined,
        halfDay: !!values.halfDay, substituteEmployeeId: values.substituteEmployeeId || undefined,
        attachmentName: attachment?.name || undefined,
        attachmentData: attachment?.data || undefined,
      })
      toast("Leave request submitted")
      onOpenChange(false)
    } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">Apply for Leave</DialogTitle>
          <p className="text-xs text-slate-500">Balance, probation and backdate rules are validated by the server.</p>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 py-2">
          <div className="sm:col-span-2 space-y-1.5">
            <Label className="text-xs font-medium">Leave Type <span className="text-rose-500">*</span></Label>
            <Select value={values.leaveTypeId || ""} onValueChange={(v) => set("leaveTypeId", v)}>
              <SelectTrigger className="h-9"><SelectValue placeholder="Select type…" /></SelectTrigger>
              <SelectContent>
                {types.filter((t) => t.active).map((t) => (
                  <SelectItem key={t.id} value={t.id}>{t.name}{t.paid ? "" : " (unpaid)"}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">From <span className="text-rose-500">*</span></Label>
            <Input type="date" value={values.fromDate || ""} onChange={(e) => set("fromDate", e.target.value)} className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">To <span className="text-rose-500">*</span></Label>
            <Input type="date" value={values.toDate || ""} onChange={(e) => set("toDate", e.target.value)} className="h-9" />
          </div>
          <div className="sm:col-span-2 space-y-1.5">
            <Label className="text-xs font-medium">Reason <span className="text-rose-500">*</span></Label>
            <Textarea rows={3} value={values.reason || ""} onChange={(e) => set("reason", e.target.value)} placeholder="Why do you need this leave?" />
          </div>
          <div className="sm:col-span-2 space-y-1.5">
            <Label className="text-xs font-medium">Contact Number During Leave</Label>
            <Input type="tel" value={values.contactNumber || ""} onChange={(e) => set("contactNumber", e.target.value)} placeholder="e.g. +880 1712-345678" className="h-9" />
            <p className="text-[10px] text-slate-500 dark:text-slate-400">Where HR / your manager can reach you while on leave.</p>
          </div>
          <div className="sm:col-span-2 space-y-1.5">
            <div className="flex items-center gap-2 pt-1">
              <Switch id="halfDay" checked={!!values.halfDay} onCheckedChange={(c) => set("halfDay", c)} />
              <Label htmlFor="halfDay" className="text-xs font-medium">Half day</Label>
            </div>
          </div>
          <div className="sm:col-span-2 space-y-1.5">
            <Label className="text-xs font-medium">Substitute (optional)</Label>
            {datesReady ? (
              <Select value={values.substituteEmployeeId || "NONE"} onValueChange={(v) => set("substituteEmployeeId", v === "NONE" ? undefined : v)}>
                <SelectTrigger className="h-9"><SelectValue placeholder={subOptions.length ? "Choose a colleague…" : "No eligible substitutes"} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="NONE">— None —</SelectItem>
                  {subOptions.map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.fullName} ({s.code}){s.sameDepartment ? " · same dept" : s.sameBranch ? " · same branch" : ""}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <p className="text-[11px] text-slate-500 dark:text-slate-400">Select valid dates to load eligible substitutes…</p>
            )}
            {(subs || []).length > 0 && <p className="text-[11px] text-slate-500 dark:text-slate-400">{subOptions.length} eligible of {(subs || []).length} colleagues — colleagues from other departments are eligible too</p>}
            {!values.substituteEmployeeId && (
              <p className={`text-[10px] leading-relaxed ${recommendSubstitute ? "text-amber-600 dark:text-amber-400" : "text-slate-500 dark:text-slate-400"}`}>
                {recommendSubstitute
                  ? "Your HR policy recommends naming a substitute. No available colleague? You can still submit without one — the request will go directly to your manager / HR for approval."
                  : "No eligible colleague? You may submit without a substitute — the request goes directly to your manager / HR for approval."}
              </p>
            )}
          </div>
          {/* R3 — supporting document (optional; enforced when the leave type requires one) */}
          <div className="sm:col-span-2 space-y-1.5">
            <Label className="text-xs font-medium">
              Attachment (supporting document)
              {needsAttachment && <span className="text-rose-500"> *</span>}
            </Label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="file"
                accept="image/*,application/pdf"
                className="block w-full text-xs text-slate-500 dark:text-slate-400
                  file:mr-3 file:rounded-md file:border-0 file:bg-emerald-50 dark:file:bg-emerald-950
                  file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-emerald-700 dark:file:text-emerald-300
                  hover:file:bg-emerald-100 dark:hover:file:bg-emerald-900"
                onChange={(e) => onAttachmentFile(e.target.files?.[0] || null)}
              />
              {attachment && (
                <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 dark:bg-emerald-950/50 px-2 py-1 text-[11px] text-emerald-700 dark:text-emerald-300">
                  {attachment.name}
                  <button type="button" className="text-rose-500 hover:text-rose-700" onClick={() => setAttachment(null)}>×</button>
                </span>
              )}
            </div>
            <p className="text-[10px] text-slate-500 dark:text-slate-400">
              PDF or image, max 2 MB{needsAttachment ? " — required for this leave type." : " — optional; required for some leave types (e.g. sick leave medical certificate)."}
            </p>
          </div>
        </div>
        {/* M-9 — announced to screen readers (role=alert) */}
              {error && <FieldError message={error} />}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "Submitting…" : "Submit Request"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ================= MY PAYSLIPS =================
function MyPayslipsTab({ canView }: { canView: boolean }) {
  const toast = useHrm((s) => s.toast)
  const { data, loading, error } = useApi<any>("ess.payroll")
  const payslips = data?.payslips || []
  const totalGross = payslips.reduce((s: number, p: any) => s + (p.gross || 0), 0)
  const totalNet = payslips.reduce((s: number, p: any) => s + (p.net || 0), 0)

  const columns: Column<any>[] = [
    { key: "payslipNumber", label: "Payslip #", render: (p) => <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">{p.payslipNumber || "—"}</span> },
    { key: "period", label: "Period", render: (p) => <span className="text-xs text-slate-600 dark:text-slate-300">{p.period}</span> },
    { key: "paidOn", label: "Paid On", render: (p) => <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300">{fmtDate(p.paidOn)}</span> },
    { key: "gross", label: "Gross", align: "right", render: (p) => <span className="text-xs font-medium tabular-nums">{fmtMoney(p.gross)}</span> },
    { key: "ait", label: "AIT", align: "right", render: (p) => <span className="text-xs tabular-nums text-slate-500">{fmtMoney(p.ait)}</span> },
    { key: "net", label: "Net Pay", align: "right", render: (p) => <span className="text-xs font-bold tabular-nums text-emerald-700 dark:text-emerald-400">{fmtMoney(p.net)}</span> },
    {
      key: "actions", label: "", align: "right", render: (p) => canView && (
        <div className="flex gap-1">
          <Button size="sm" variant="outline" className="h-7 text-[10px]" onClick={() => openHtmlWindow("ess.payroll.html", { entryId: p.entryId }, false, toast)}>
            <Eye className="h-3 w-3 mr-1" /> View
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-[10px]" onClick={() => openHtmlWindow("ess.payroll.html", { entryId: p.entryId }, true, toast)}>
            <Printer className="h-3 w-3 mr-1" /> Print
          </Button>
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Payslips issued" value={payslips.length} icon={Wallet} tone="emerald" />
        <StatCard label="Total gross earned" value={fmtMoney(totalGross)} icon={Banknote} tone="amber" />
        <StatCard label="Total net received" value={fmtMoney(totalNet)} icon={TrendingUp} tone="teal" />
        <StatCard label="Total AIT deducted" value={fmtMoney(data?.totalAit)} icon={Receipt} tone="slate" sub="tax withheld to date" />
      </div>
      <DataTable columns={columns} rows={payslips} loading={loading} error={error} pageSize={12}
        searchPlaceholder="Search payslips…" emptyTitle="No payslips yet" emptyHint="Payslips appear here after payroll is paid." />
    </div>
  )
}

// ================= MY LOANS =================
function MyLoansTab({ autoDialog, onConsume, canEdit }: { autoDialog: string | null; onConsume: () => void; canEdit: boolean }) {
  const { data, loading, error, reload } = useApi<any>("ess.loans")
  const { data: colleagues, loading: colleaguesLoading } = useApi<any[]>(canEdit ? "ess.colleagues" : null)
  const toast = useHrm((s) => s.toast)
  const { t } = useI18n()
  const [loanOpen, setLoanOpen] = useState(false)
  const [advOpen, setAdvOpen] = useState(false)
  const [consentBusy, setConsentBusy] = useState<string | null>(null)
  const [declineTarget, setDeclineTarget] = useState<any>(null)
  // R5 — loan / advance request buttons respect the portal visibility controls
  const canRequestLoan = usePortalAction("showLoanRequest")
  const canRequestAdvance = usePortalAction("showAdvanceRequest")

  const loans = data?.loans || []
  const advances = data?.advances || []
  const guaranteeRequests = data?.guaranteeRequests || []
  const outstanding = loans.reduce((s: number, l: any) => s + (l.outstanding || 0), 0) + advances.reduce((s: number, a: any) => s + (a.outstanding || 0), 0)

  const guarantorOpts = (colleagues || []).map((c: any) => ({
    value: c.id,
    label: `${c.fullName}${c.designationName ? ` · ${c.designationName}` : ""}${c.sameBranch ? " (same branch)" : ""}`,
  }))

  const loanFields: FieldDef[] = [
    { name: "type", label: "Loan Type", type: "select", options: LOAN_TYPES.map((t) => ({ value: t, label: titleCase(t) })), defaultValue: "PERSONAL" },
    { name: "principal", label: "Amount (৳)", type: "number", min: 500, required: true },
    { name: "installments", label: "Installments (months)", type: "number", min: 1, max: 24, defaultValue: 6, required: true },
    { name: "guarantorId", label: "Guarantor", type: "select", required: true, span: 2, options: guarantorOpts,
      placeholder: colleaguesLoading ? "Loading colleagues…" : "Choose a colleague…",
      help: "After you submit, your guarantor must agree in their self-service portal before the loan goes for approval." },
    { name: "startDate", label: "Start Date", type: "date", defaultValue: today() },
    { name: "purpose", label: "Purpose", type: "textarea", rows: 2, span: 2 },
  ]
  const advFields: FieldDef[] = [
    { name: "amount", label: "Advance Amount (৳)", type: "number", min: 100, required: true },
    { name: "reason", label: "Reason", type: "textarea", rows: 2, span: 2, required: true },
    { name: "recoveryDate", label: "Recovery Date", type: "date" },
    { name: "installments", label: "Recovery Installments", type: "number", min: 1, max: 6, defaultValue: 1 },
  ]

  const instColumns: Column<any>[] = [
    { key: "no", label: "#", align: "right", render: (i) => <span className="text-xs tabular-nums">{i.no}</span> },
    { key: "dueDate", label: "Due Date", render: (i) => <span className="text-xs tabular-nums">{fmtDate(i.dueDate)}</span> },
    { key: "amount", label: "Amount", align: "right", render: (i) => <span className="text-xs tabular-nums">{fmtMoney(i.amount)}</span> },
    { key: "paidAmount", label: "Paid", align: "right", render: (i) => <span className="text-xs tabular-nums text-emerald-700 dark:text-emerald-400">{fmtMoney(i.paidAmount)}</span> },
    { key: "status", label: "Status", render: (i) => <StatusBadge status={i.status} /> },
  ]

  const advColumns: Column<any>[] = [
    { key: "amount", label: "Amount", align: "right", render: (a) => <span className="text-xs font-semibold tabular-nums">{fmtMoney(a.amount)}</span> },
    { key: "reason", label: "Reason", render: (a) => <span className="text-xs text-slate-500 line-clamp-1 max-w-[200px]">{a.reason || "—"}</span> },
    { key: "requestDate", label: "Requested", render: (a) => <span className="text-xs tabular-nums">{fmtDate(a.requestDate)}</span> },
    { key: "recoveryDate", label: "Recovery By", render: (a) => <span className="text-xs tabular-nums">{fmtDate(a.recoveryDate)}</span> },
    { key: "installments", label: "Installments", align: "right", render: (a) => <span className="text-xs tabular-nums">{a.installments}</span> },
    { key: "outstanding", label: "Outstanding", align: "right", render: (a) => <span className="text-xs tabular-nums text-amber-600">{fmtMoney(a.outstanding)}</span> },
    { key: "status", label: "Status", render: (a) => <StatusBadge status={a.status} /> },
  ]

  const respondGuarantor = async (loanId: string, decision: "AGREE" | "DECLINE", note?: string) => {
    setConsentBusy(loanId)
    try {
      await rpc("loans.guarantorRespond", { loanId, decision, note: note || undefined })
      toast(decision === "AGREE" ? "You agreed to guarantee this loan — it is now submitted for approval" : "Guarantor consent declined — the loan request was rejected")
      reload()
    } catch (e: any) {
      toast(e.message || "Could not record your response", "err")
    } finally {
      setConsentBusy(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Active loans" value={loans.filter((l: any) => ["PENDING", "ACTIVE"].includes(l.status)).length} icon={Landmark} tone="emerald" />
        <StatCard label="Total outstanding" value={fmtMoney(outstanding)} icon={Wallet} tone="amber" />
        <StatCard label="Advances" value={advances.length} sub={`${advances.filter((a: any) => a.status === "RECOVERING").length} recovering`} icon={Banknote} tone="teal" />
        <StatCard label="Requests pending" value={[...loans, ...advances].filter((x: any) => x.status === "PENDING").length} icon={Timer} tone="slate" />
      </div>

      {canEdit && (canRequestLoan || canRequestAdvance) && (
        <div className="flex flex-wrap gap-2">
          {canRequestLoan && (
            <Button size="sm" className="h-8 text-xs " onClick={() => setLoanOpen(true)}>
              <Plus className="h-3.5 w-3.5 mr-1" /> Request Loan
            </Button>
          )}
          {canRequestAdvance && (
            <Button size="sm" variant="outline" className="h-8 text-xs bg-white dark:bg-slate-900" onClick={() => setAdvOpen(true)}>
              <Plus className="h-3.5 w-3.5 mr-1 text-emerald-600" /> Request Advance
            </Button>
          )}
        </div>
      )}

      {/* ---------- guarantor consent requests ---------- */}
      {guaranteeRequests.length > 0 && (
        <SectionCard title={t("Guarantor Consent Needed — colleagues named you as guarantor")}>
          <div className="space-y-2">
            {guaranteeRequests.map((g: any) => (
              <div key={g.id} className="flex flex-col sm:flex-row sm:items-center gap-2 rounded-xl border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 p-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                    {g.requesterName} — {titleCase(g.type || "PERSONAL")} loan of {fmtMoney(g.principal)}
                  </p>
                  <p className="text-xs text-slate-500">
                    {g.installments} installments of ~{fmtMoney(g.installmentAmount)} · starts {fmtDate(g.startDate)}
                    {g.purpose ? ` · ${g.purpose}` : ""}
                  </p>
                  <p className="text-[11px] text-amber-700 dark:text-amber-300 mt-0.5">
                    By agreeing you confirm you consent to act as guarantor of this loan.
                  </p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button size="sm" className="h-8 text-xs "
                    disabled={consentBusy === g.id}
                    onClick={() => { respondGuarantor(g.id, "AGREE") }}>
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> {consentBusy === g.id ? "Working…" : "Agree to Guarantee"}
                  </Button>
                  <Button size="sm" variant="outline" className="h-8 text-xs text-rose-600 border-rose-200 hover:bg-rose-50"
                    disabled={consentBusy === g.id} onClick={() => setDeclineTarget(g)}>
                    <XCircle className="h-3.5 w-3.5 mr-1" /> Decline
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {loans.length === 0 ? (
        <div className="rounded-xl border border-dashed"><EmptyState icon={Landmark} title="No loans" hint="Request a loan — it goes through the approval workflow." /></div>
      ) : (
        <div className="grid lg:grid-cols-2 gap-4">
          {loans.map((l: any) => {
            const nextDue = (l.installments || []).find((i: any) => i.status !== "PAID")
            const awaitingGuarantor = l.status === "PENDING" && l.guarantorStatus === "PENDING"
            return (
              <SectionCard key={l.id} title={`${titleCase(l.type)} Loan — ${fmtMoney(l.principal)}`} actions={<StatusBadge status={l.status} />}>
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs mb-3">
                  <KV items={[
                    ["Installments", `${l.installments} × ~${fmtMoney(l.installmentAmount)}`],
                    ["Paid", fmtMoney(l.paidAmount)],
                    ["Outstanding", <b key="o" className={l.outstanding > 0 ? "text-amber-600" : "text-emerald-600"}>{fmtMoney(l.outstanding)}</b>],
                    ["Next due", nextDue ? fmtDate(nextDue.dueDate) : "—"],
                    ...(l.guarantorName ? ([["Guarantor", (
                      <span key="g" className="inline-flex items-center gap-1.5 flex-wrap">
                        {l.guarantorName}
                        {l.guarantorStatus ? <StatusBadge status={l.guarantorStatus} /> : null}
                      </span>
                    )]] as [string, React.ReactNode][]) : []),
                  ]} />
                </div>
                {awaitingGuarantor && (
                  <p className="text-[11px] text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded-md px-2.5 py-1.5 mb-3">
                    Waiting for {l.guarantorName} to consent as guarantor before the approval workflow starts.
                  </p>
                )}
                {(l.installments || []).length > 0 && (
                  <div className="max-h-56 overflow-y-auto">
                    <DataTable columns={instColumns} rows={l.installments} pageSize={12} searchable={false} dense />
                  </div>
                )}
              </SectionCard>
            )
          })}
        </div>
      )}

      <SectionCard title={t("Salary Advances")}>
        <DataTable columns={advColumns} rows={advances} loading={loading} error={error} pageSize={10}
          searchPlaceholder="Search advances…" emptyTitle="No advances" emptyHint="Advances are recovered from payroll." />
      </SectionCard>

      <FormDialog open={loanOpen || autoDialog === "loan"} onOpenChange={(v) => { if (!v) { setLoanOpen(false); onConsume(); reload() } }}
        title="Request Loan" description="Your guarantor must consent in their portal first; the loan then goes through the approval workflow. Installments are recovered from payroll."
        fields={loanFields}
        onSubmit={async (v) => { await rpc("loans.create", { ...v, guarantorId: v.guarantorId || undefined }) }} />
      <FormDialog open={advOpen || autoDialog === "advance"} onOpenChange={(v) => { if (!v) { setAdvOpen(false); onConsume(); reload() } }}
        title="Request Salary Advance" description="Short-term advance recovered from upcoming payroll."
        fields={advFields}
        onSubmit={async (v) => { await rpc("advances.create", v) }} />

      <ConfirmDialog open={!!declineTarget} onOpenChange={(v) => { if (!v) setDeclineTarget(null) }}
        title="Decline guarantor consent"
        message={declineTarget
          ? `Decline to act as guarantor for ${declineTarget.requesterName}'s loan of ${fmtMoney(declineTarget.principal)}? The loan request will be rejected.`
          : ""}
        confirmLabel="Decline" danger requireReason
        onConfirm={async (reason) => { await respondGuarantor(declineTarget.id, "DECLINE", reason) }} />
    </div>
  )
}

// ================= MY EXPENSES =================
function MyExpensesTab({ autoDialog, onConsume, canEdit }: { autoDialog: string | null; onConsume: () => void; canEdit: boolean }) {
  const { data, loading, error, reload } = useApi<any[]>("ess.expenses")
  const [open, setOpen] = useState(false)
  // R5 — expense claim button respects the portal visibility controls
  const canSubmitExpense = usePortalAction("showExpenseClaim")

  const claims = data || []
  const pending = claims.filter((c) => c.status === "PENDING")
  const reimbursed = claims.filter((c) => c.status === "REIMBURSED")

  const columns: Column<any>[] = [
    { key: "title", label: "Claim", render: (c) => (<div><p className="text-sm font-medium text-slate-800 dark:text-slate-100">{c.title}</p><p className="text-[11px] text-slate-500 dark:text-slate-400">{titleCase(c.category)}{c.receiptName ? " · receipt attached" : ""}</p></div>) },
    { key: "amount", label: "Amount", align: "right", render: (c) => <span className="text-xs font-semibold tabular-nums">{fmtMoney(c.amount)}</span> },
    { key: "date", label: "Date", render: (c) => <span className="text-xs tabular-nums">{fmtDate(c.date)}</span> },
    { key: "paymentMethod", label: "Method", render: (c) => <Badge variant="outline" className="text-[10px]">{titleCase(c.paymentMethod)}</Badge> },
    { key: "status", label: "Status", render: (c) => <StatusBadge status={c.status} /> },
    { key: "reimbursementDate", label: "Reimbursed On", render: (c) => <span className="text-xs tabular-nums text-slate-500">{fmtDate(c.reimbursementDate)}</span> },
    { key: "description", label: "Description", render: (c) => <span className="text-xs text-slate-500 line-clamp-1 max-w-[220px]">{c.description || "—"}</span> },
  ]

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Total claims" value={claims.length} icon={Receipt} tone="emerald" />
        <StatCard label="Pending" value={pending.length} sub={fmtMoney(pending.reduce((s, c) => s + c.amount, 0))} icon={Timer} tone="amber" />
        <StatCard label="Reimbursed" value={reimbursed.length} sub={fmtMoney(reimbursed.reduce((s, c) => s + c.amount, 0))} icon={BadgeCheck} tone="teal" />
        <StatCard label="Rejected" value={claims.filter((c) => c.status === "REJECTED").length} icon={XCircle} tone="rose" />
      </div>
      {canEdit && canSubmitExpense && (
        <Button size="sm" className="h-8 text-xs " onClick={() => setOpen(true)}>
          <Plus className="h-3.5 w-3.5 mr-1" /> Submit Expense Claim
        </Button>
      )}
      <DataTable columns={columns} rows={claims} loading={loading} error={error} pageSize={10}
        searchPlaceholder="Search my claims…" emptyTitle="No expense claims" emptyHint="Submit a claim with an optional receipt attachment." />

      <ExpenseDialog open={(open || autoDialog === "expense") && canSubmitExpense} onOpenChange={(v) => { if (!v) { setOpen(false); onConsume(); reload() } }} />
    </div>
  )
}

function ExpenseDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [file, setFile] = useState<{ name: string; data: string } | null>(null)
  const [values, setValues] = useState<Record<string, any>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const toast = useHrm((s) => s.toast)

  useEffect(() => {
    if (open) { setFile(null); setError(null); setValues({ category: "TRAVEL", paymentMethod: "BANK", date: today() }) }
  }, [open])

  const onFile = (f: File | null) => {
    if (!f) return setFile(null)
    if (f.size > 2 * 1024 * 1024) { setError("Receipt too large (max 2 MB)"); return }
    const reader = new FileReader()
    reader.onload = () => setFile({ name: f.name, data: String(reader.result).split(",")[1] || "" })
    reader.readAsDataURL(f)
  }

  const submit = async () => {
    if (!values.title) { setError("Title is required"); return }
    if (!(Number(values.amount) > 0)) { setError("Amount must be positive"); return }
    if (!values.date) { setError("Date is required"); return }
    setBusy(true)
    try {
      await rpc("expenses.create", {
        category: values.category, title: values.title, amount: Number(values.amount), date: values.date,
        description: values.description || undefined, projectRef: values.projectRef || undefined,
        paymentMethod: values.paymentMethod, receiptName: file?.name, receiptData: file?.data,
      })
      toast("Expense claim submitted")
      onOpenChange(false)
    } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }

  const set = (n: string, v: any) => setValues((s) => ({ ...s, [n]: v }))

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">Submit Expense Claim</DialogTitle>
          <p className="text-xs text-slate-500">Claims go through the expense approval workflow before reimbursement.</p>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 py-2">
          <div className="sm:col-span-2 space-y-1.5">
            <Label className="text-xs font-medium">Title <span className="text-rose-500">*</span></Label>
            <Input value={values.title || ""} onChange={(e) => set("title", e.target.value)} className="h-9" placeholder="e.g. Client visit transport" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Category</Label>
            <Select value={values.category || "TRAVEL"} onValueChange={(v) => set("category", v)}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>{EXPENSE_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{titleCase(c)}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Amount (৳) <span className="text-rose-500">*</span></Label>
            <Input type="number" min={1} value={values.amount || ""} onChange={(e) => set("amount", e.target.value)} className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Date <span className="text-rose-500">*</span></Label>
            <Input type="date" value={values.date || ""} onChange={(e) => set("date", e.target.value)} className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Payment Method</Label>
            <Select value={values.paymentMethod || "BANK"} onValueChange={(v) => set("paymentMethod", v)}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>{["BANK", "CASH", "MFS"].map((m) => <SelectItem key={m} value={m}>{titleCase(m)}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Project Ref (optional)</Label>
            <Input value={values.projectRef || ""} onChange={(e) => set("projectRef", e.target.value)} className="h-9" />
          </div>
          <div className="sm:col-span-2 space-y-1.5">
            <Label className="text-xs font-medium">Description</Label>
            <Textarea rows={2} value={values.description || ""} onChange={(e) => set("description", e.target.value)} />
          </div>
          <div className="sm:col-span-2 space-y-1.5">
            <Label className="text-xs font-medium">Receipt (optional, max 2 MB)</Label>
            <Input type="file" accept="image/*,.pdf" onChange={(e) => onFile(e.target.files?.[0] || null)} className="h-9 text-xs" />
            {file && <p className="text-[11px] text-emerald-600">✓ {file.name}</p>}
          </div>
        </div>
        {/* M-9 — announced to screen readers (role=alert) */}
              {error && <FieldError message={error} />}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "Submitting…" : "Submit Claim"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ================= MY TASKS =================
function MyTasksTab() {
  const { can, toast } = useHrm()
  const { data, loading, error, reload } = useApi<any[]>("ess.tasks")
  const [commentText, setCommentText] = useState<Record<string, string>>({})
  const canEdit = can("ess", "edit") || can("tasks", "edit")

  const saveTask = async (t: any, patch: Record<string, unknown>) => {
    try {
      await rpc("tasks.save", { id: t.id, title: t.title, assigneeId: t.assigneeId, ...patch })
      toast("Task updated")
      reload()
    } catch (e: any) { toast(e.message, "err") }
  }

  const sendComment = async (t: any) => {
    const text = (commentText[t.id] || "").trim()
    if (!text) return
    try {
      await rpc("tasks.comment", { taskId: t.id, text })
      setCommentText((s) => ({ ...s, [t.id]: "" }))
      toast("Comment added")
      reload()
    } catch (e: any) { toast(e.message, "err") }
  }

  const tasks = data || []

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Total tasks" value={tasks.length} icon={ListChecks} tone="emerald" />
        <StatCard label="In progress" value={tasks.filter((t) => t.status === "IN_PROGRESS").length} icon={Timer} tone="amber" />
        <StatCard label="Overdue" value={tasks.filter((t) => t.dueDate && t.dueDate < today() && !["COMPLETED", "CANCELLED"].includes(t.status)).length} icon={AlertTriangle} tone="rose" />
        <StatCard label="Completed" value={tasks.filter((t) => t.status === "COMPLETED").length} icon={BadgeCheck} tone="teal" />
      </div>

      {loading && <div className="rounded-xl border bg-white dark:bg-slate-900 p-6 text-center text-sm text-slate-400">Loading tasks…</div>}
      {error && <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{error}</div>}
      {!loading && !error && tasks.length === 0 && (
        <div className="rounded-xl border border-dashed"><EmptyState icon={ListChecks} title="No tasks assigned" hint="HR / your manager can assign tasks with checklists and due dates." /></div>
      )}

      <div className="grid lg:grid-cols-2 gap-4">
        {tasks.map((t) => {
          const overdue = t.dueDate && t.dueDate < today() && !["COMPLETED", "CANCELLED"].includes(t.status)
          const checklist: any[] = t.checklist || []
          const doneCount = checklist.filter((c) => c.done).length
          return (
            <Card key={t.id} className={overdue ? "border-rose-200 dark:border-rose-900" : ""}>
              <CardContent className="p-4 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t.title}</p>
                    {t.description && <p className="text-xs text-slate-500 mt-0.5 line-clamp-2">{t.description}</p>}
                  </div>
                  <StatusBadge status={t.status} />
                </div>
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                  {t.priority && <Badge variant="outline" className={`text-[10px] ${t.priority === "URGENT" || t.priority === "HIGH" ? "border-rose-200 text-rose-600" : ""}`}>{titleCase(t.priority)}</Badge>}
                  {t.dueDate && <span className={overdue ? "text-rose-600 font-medium" : ""}>Due {fmtDate(t.dueDate)}</span>}
                  {t.scope && <span>· {titleCase(t.scope)} scope</span>}
                </div>

                {/* progress */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-[11px] text-slate-500">
                    <span>Progress</span><span className="font-bold tabular-nums">{t.progress || 0}%</span>
                  </div>
                  <Progress value={t.progress || 0} className="h-2" />
                  {canEdit && (
                    <div className="flex items-center gap-2 pt-1">
                      <Select value={t.status || "TODO"} onValueChange={(v) => saveTask(t, { status: v })}>
                        <SelectTrigger className="h-8 w-[150px] text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>{TASK_STATUSES.map((s) => <SelectItem key={s} value={s}>{titleCase(s)}</SelectItem>)}</SelectContent>
                      </Select>
                      <Input type="number" min={0} max={100} defaultValue={t.progress || 0} className="h-8 w-20 text-xs"
                        onBlur={(e) => { const v = Math.max(0, Math.min(100, Number(e.target.value) || 0)); if (v !== (t.progress || 0)) saveTask(t, { progress: v }) }}
                        title="Update progress %" />
                    </div>
                  )}
                </div>

                {/* checklist */}
                {checklist.length > 0 && (
                  <div className="rounded-lg bg-slate-50 dark:bg-slate-800/60 p-2.5 space-y-1">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Checklist ({doneCount}/{checklist.length})</p>
                    {checklist.map((c, i) => (
                      <button key={i} disabled={!canEdit} onClick={() => saveTask(t, { checklist: checklist.map((x, j) => j === i ? { ...x, done: !x.done } : x) })}
                        className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300 w-full text-left">
                        <span className={`h-3.5 w-3.5 rounded border flex items-center justify-center shrink-0 ${c.done ? "bg-primary border-primary" : "border-slate-300 dark:border-slate-600"}`}>
                          {c.done && <CheckCircle2 className="h-2.5 w-2.5 text-white" />}
                        </span>
                        <span className={c.done ? "line-through text-slate-400" : ""}>{c.text}</span>
                      </button>
                    ))}
                  </div>
                )}

                {/* comments */}
                <div className="space-y-1.5">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 flex items-center gap-1"><MessageSquare className="h-3 w-3" /> Comments ({(t.comments || []).length})</p>
                  <div className="max-h-28 overflow-y-auto space-y-1">
                    {(t.comments || []).map((c: any, i: number) => (
                      <div key={i} className="text-xs rounded-lg bg-slate-50 dark:bg-slate-800/60 px-2.5 py-1.5">
                        <b className="text-slate-700 dark:text-slate-200">{c.userName}</b>
                        <span className="text-slate-400 ml-1.5">{fmtDateTime(c.at)}</span>
                        <p className="text-slate-600 dark:text-slate-300">{c.text}</p>
                      </div>
                    ))}
                    {(t.comments || []).length === 0 && <p className="text-[11px] text-slate-500 dark:text-slate-400 px-1">No comments yet.</p>}
                  </div>
                  <div className="flex gap-1.5">
                    <Input value={commentText[t.id] || ""} onChange={(e) => setCommentText((s) => ({ ...s, [t.id]: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === "Enter") sendComment(t) }}
                      placeholder="Write a comment…" className="h-8 text-xs" />
                    <Button aria-label="Send" size="icon" className="h-8 w-8  shrink-0" onClick={() => sendComment(t)}>
                      <Send className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}

// ================= MY PERFORMANCE =================
function MyPerformanceTab() {
  const { toast } = useHrm()
  const { data, loading, error, reload } = useApi<any>("ess.performance")
  const reviews = data?.reviews || []
  const kpis = data?.kpis || []
  // ESS-05 (R7) — acknowledgment flow: comments + acknowledge on SUBMITTED
  const [ackComments, setAckComments] = useState<Record<string, string>>({})
  const [ackBusy, setAckBusy] = useState<string | null>(null)
  // PRF-01 (R7) — self-assessment on the open review
  const [selfBusy, setSelfBusy] = useState<string | null>(null)
  const [selfRatings, setSelfRatings] = useState<Record<string, Record<string, number>>>({})
  const [selfComments, setSelfComments] = useState<Record<string, string>>({})

  const acknowledge = async (r: any) => {
    setAckBusy(r.id)
    try {
      await rpc("reviews.acknowledge", { id: r.id, comments: ackComments[r.id] || undefined })
      toast("Review acknowledged — thank you. HR can now finalize it.", "ok")
      setAckComments((c) => ({ ...c, [r.id]: "" }))
      await reload()
    } catch (e: any) { toast(e.message || "Could not acknowledge", "err") }
    finally { setAckBusy(null) }
  }

  const saveSelfAssessment = async (r: any) => {
    setSelfBusy(r.id)
    try {
      await rpc("ess.reviewSelf", { id: r.id, ratings: selfRatings[r.id] || {}, comments: selfComments[r.id] || undefined })
      toast("Self-assessment submitted — HR has been notified", "ok")
      await reload()
    } catch (e: any) { toast(e.message || "Could not submit", "err") }
    finally { setSelfBusy(null) }
  }

  const kpiColumns: Column<any>[] = [
    { key: "name", label: "KPI", render: (r) => <span className="text-xs font-medium text-slate-700 dark:text-slate-200">{r.name}</span> },
    { key: "target", label: "Target", align: "right", render: (r) => <span className="text-xs tabular-nums">{r.target}{r.unit ? ` ${r.unit}` : ""}</span> },
    { key: "weight", label: "Weight", align: "right", render: (r) => <span className="text-xs tabular-nums text-slate-500">{r.weight}%</span> },
    { key: "actual", label: "Actual", align: "right", render: (r) => <span className="text-xs tabular-nums font-medium">{r.actual ?? "—"}</span> },
    { key: "achievementPct", label: "Achievement", align: "right", render: (r) => (
      <span className={`text-xs font-bold tabular-nums ${(r.achievementPct || 0) >= 100 ? "text-emerald-600" : (r.achievementPct || 0) >= 70 ? "text-amber-600" : "text-rose-600"}`}>{r.achievementPct ?? 0}%</span>
    ) },
    { key: "rating", label: "Rating", align: "right", render: (r) => <span className="text-xs tabular-nums">{r.rating ?? "—"}</span> },
  ]

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Reviews" value={reviews.length} icon={TrendingUp} tone="emerald" />
        <StatCard label="Average rating" value={reviews.length ? (reviews.reduce((s: number, r: any) => s + (r.overallRating || 0), 0) / reviews.length).toFixed(1) : "—"} icon={Sparkles} tone="amber" />
        <StatCard label="KPI assignments" value={kpis.length} icon={BadgeCheck} tone="teal" />
        {/* ESS-04 — the server writes "FINAL" (schema: DRAFT | SUBMITTED | ACKNOWLEDGED | FINAL);
            the old "FINALIZED" literal made this stat permanently 0. */}
        <StatCard label="Finalized reviews" value={reviews.filter((r: any) => r.status === "FINAL").length} icon={ShieldCheck} tone="slate" />
      </div>

      {reviews.length === 0 && kpis.length === 0 && !loading && (
        <div className="rounded-xl border border-dashed"><EmptyState icon={TrendingUp} title="No performance records yet" hint="Your reviews and KPI assignments will appear here." /></div>
      )}

      {reviews.length > 0 && (
        <div className="grid lg:grid-cols-2 gap-4">
          {reviews.map((r: any) => (
            <SectionCard key={r.id} title={r.cycleName || "Review"} actions={<div className="flex items-center gap-2"><RatingStars value={r.overallRating || 0} /><StatusBadge status={r.status} /></div>}>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2">
                {Object.entries(r.ratings || {}).map(([area, val]) => (
                  <div key={area} className="text-xs">
                    <p className="text-slate-500 capitalize">{titleCase(area)}</p>
                    <RatingStars value={Number(val) || 0} />
                  </div>
                ))}
              </div>
              {(r.managerComments || r.strengths || r.goals) && (
                <div className="mt-3 pt-3 border-t space-y-1.5 text-xs">
                  {r.managerComments && <p><span className="text-slate-400">Manager: </span><span className="text-slate-600 dark:text-slate-300">{r.managerComments}</span></p>}
                  {r.strengths && <p><span className="text-slate-400">Strengths: </span><span className="text-slate-600 dark:text-slate-300">{r.strengths}</span></p>}
                  {r.goals && <p><span className="text-slate-400">Goals: </span><span className="text-slate-600 dark:text-slate-300">{r.goals}</span></p>}
                </div>
              )}
              {r.status !== "FINAL" && (
                <div className="mt-3 pt-3 border-t space-y-3">
                  {/* ESS-05 (R7) — acknowledge the submitted review with your own comments */}
                  {r.status === "SUBMITTED" && (
                    <div className="rounded-xl border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50/60 dark:bg-emerald-950/30 p-3 space-y-2">
                      <p className="text-xs font-semibold text-emerald-800 dark:text-emerald-300">This review awaits your acknowledgment</p>
                      <textarea
                        value={ackComments[r.id] || ""}
                        onChange={(e) => setAckComments((c) => ({ ...c, [r.id]: e.target.value }))}
                        placeholder="Your comments (optional) — they are recorded with the review and visible to HR"
                        rows={2}
                        className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                      />
                      <Button size="sm" className="bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white h-8 text-xs" disabled={ackBusy === r.id} onClick={() => acknowledge(r)}>
                        {ackBusy === r.id ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />} Acknowledge this review
                      </Button>
                    </div>
                  )}
                  {r.status === "ACKNOWLEDGED" && (
                    <p className="text-[11px] text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5" /> Acknowledged — awaiting HR finalization{r.employeeComments ? " (your comments are attached)" : ""}.</p>
                  )}
                  {/* PRF-01 (R7) — self-assessment: rate yourself on the same areas */}
                  <details className="rounded-xl border border-slate-200 dark:border-slate-800">
                    <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white">
                      {r.inputs?.self ? "Update my self-assessment" : "Rate myself (self-assessment)"}
                      {r.inputs?.self && <Badge className="ml-2 bg-emerald-100 text-emerald-700 text-[9px]">submitted</Badge>}
                    </summary>
                    <div className="px-3 pb-3 space-y-2.5 border-t pt-3">
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2">
                        {Object.keys(r.ratings || {}).length === 0 && ["Attendance", "Productivity", "Quality", "Teamwork", "Communication", "Target Achievement"].map((a) => a.toLowerCase().replace(/\s+/g, "")).map((a) => (
                          <div key={a} className="text-xs">
                            <p className="text-slate-500 capitalize">{a.replace(/([A-Z])/g, " $1")}</p>
                            <select
                              value={selfRatings[r.id]?.[a] ?? ""}
                              onChange={(e) => setSelfRatings((m) => ({ ...m, [r.id]: { ...(m[r.id] || {}), [a]: Number(e.target.value) } }))}
                              className="mt-1 w-full h-8 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 text-xs"
                            >
                              <option value="">—</option>
                              {[1, 2, 3, 4, 5].map((v) => <option key={v} value={v}>{v}</option>)}
                            </select>
                          </div>
                        ))}
                        {Object.entries(r.ratings || {}).map(([area]) => (
                          <div key={area} className="text-xs">
                            <p className="text-slate-500 capitalize">{titleCase(area)}</p>
                            <select
                              value={selfRatings[r.id]?.[area] ?? r.inputs?.self?.ratings?.[area] ?? ""}
                              onChange={(e) => setSelfRatings((m) => ({ ...m, [r.id]: { ...(m[r.id] || {}), [area]: Number(e.target.value) } }))}
                              className="mt-1 w-full h-8 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 text-xs"
                            >
                              <option value="">—</option>
                              {[1, 2, 3, 4, 5].map((v) => <option key={v} value={v}>{v}</option>)}
                            </select>
                          </div>
                        ))}
                      </div>
                      <textarea
                        value={selfComments[r.id] ?? r.inputs?.self?.comments ?? ""}
                        onChange={(e) => setSelfComments((m) => ({ ...m, [r.id]: e.target.value }))}
                        placeholder="My reflections — achievements, challenges, goals for the next cycle…"
                        rows={2}
                        className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                      />
                      <Button size="sm" variant="outline" className="h-8 text-xs border-emerald-200 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-400" disabled={selfBusy === r.id} onClick={() => saveSelfAssessment(r)}>
                        {selfBusy === r.id ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Send className="h-3.5 w-3.5 mr-1.5" />} Submit self-assessment
                      </Button>
                    </div>
                  </details>
                </div>
              )}
            </SectionCard>
          ))}
        </div>
      )}

      {kpis.map((k: any) => (
        <SectionCard key={k.id} title={`KPI — ${k.periodLabel || k.templateName || "Assignment"}`} actions={<StatusBadge status={k.status} />}>
          <DataTable columns={kpiColumns} rows={k.results || []} pageSize={10} searchable={false} dense />
        </SectionCard>
      ))}
      {loading && <div className="rounded-xl border bg-white dark:bg-slate-900 p-6 text-center text-sm text-slate-400">Loading performance data…</div>}
      {error && <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{error}</div>}
    </div>
  )
}

// ================= MY DOCUMENTS =================
function MyDocumentsTab({ canView }: { canView: boolean }) {
  const toast = useHrm((s) => s.toast)
  const { t } = useI18n()
  const { data, loading, error } = useApi<any>("ess.documents")
  const docs = data?.docs || []
  const letters = data?.letters || []
  // LTR-01 (R7) — employee-initiated letter requests
  const { data: reqData, reload: reloadReqs } = useApi<any[]>("ess.letterRequests")
  const [reqType, setReqType] = useState("SALARY_CERT")
  const [reqReason, setReqReason] = useState("")
  const [reqBusy, setReqBusy] = useState(false)
  const requests: any[] = reqData || []

  const submitRequest = async () => {
    setReqBusy(true)
    try {
      await rpc("ess.letterRequests", { type: reqType, reason: reqReason || undefined })
      toast("Request submitted — HR has been notified", "ok")
      setReqReason("")
      await reloadReqs()
    } catch (e: any) { toast(e.message || "Could not submit request", "err") }
    finally { setReqBusy(false) }
  }

  const docColumns: Column<any>[] = [
    { key: "title", label: "Document", render: (d) => (<div><p className="text-sm font-medium text-slate-800 dark:text-slate-100">{d.title}</p><p className="text-[11px] text-slate-500 dark:text-slate-400">{titleCase(d.docType)}</p></div>) },
    { key: "status", label: "Status", render: (d) => <StatusBadge status={d.status} /> },
    { key: "verified", label: "Verified", render: (d) => d.verified ? <Badge className="bg-emerald-100 text-emerald-700 text-[10px]">✓ Verified</Badge> : <Badge variant="outline" className="text-[10px]">Pending</Badge> },
    { key: "expiryDate", label: "Expiry", render: (d) => d.expiryDate ? <span className={`text-xs tabular-nums ${isExpired(d.expiryDate) ? "text-rose-600 font-medium" : "text-slate-600 dark:text-slate-300"}`}>{fmtDate(d.expiryDate)}</span> : <span className="text-xs text-slate-400">—</span> },
  ]

  const letterColumns: Column<any>[] = [
    { key: "letterNumber", label: "Ref #", render: (l) => <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">{l.letterNumber}</span> },
    { key: "type", label: "Letter", render: (l) => (<div><p className="text-sm font-medium text-slate-800 dark:text-slate-100">{titleCase(l.type)}</p><p className="text-[11px] text-slate-500 dark:text-slate-400 line-clamp-1 max-w-[280px]">{l.subject}</p></div>) },
    { key: "issuedAt", label: "Issued", render: (l) => <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300">{fmtDateTime(l.issuedAt)}</span> },
    { key: "deliveryMethod", label: "Delivery", render: (l) => <Badge variant="outline" className="text-[10px]">{titleCase(l.deliveryMethod)}</Badge> },
    {
      key: "actions", label: "", align: "right", render: (l) => canView && (
        <Button size="sm" variant="outline" className="h-7 text-[10px]" onClick={() => openHtmlWindow("letters.download", { id: l.id }, false, toast)}>
          <Download className="h-3 w-3 mr-1" /> View / Print
        </Button>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <SectionCard title={t("My Documents")}>
        <DataTable columns={docColumns} rows={docs} loading={loading} error={error} pageSize={10}
          searchPlaceholder="Search documents…" emptyTitle="No documents on file" emptyHint="Documents uploaded by HR appear here." />
      </SectionCard>
      <SectionCard title={t("Issued Letters")}>
        <DataTable columns={letterColumns} rows={letters} pageSize={10}
          searchPlaceholder="Search letters…" emptyTitle="No issued letters" emptyHint="HR letters issued to you (experience, salary certificate…) appear here." />
      </SectionCard>
      {/* LTR-01 (R7) — request a letter through the system; HR approves and
          the letter lands in Issued Letters above */}
      <SectionCard title={t("Request a Letter")} description={t("Ask HR for a salary certificate, experience letter, employment certificate or NOC — no paperwork needed.")}>
        <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
          <div className="flex-1">
            <label className="text-[11px] font-medium text-slate-500 dark:text-slate-400">{t("Letter type")}</label>
            <select value={reqType} onChange={(e) => setReqType(e.target.value)}
              className="mt-1 w-full h-9 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50">
              <option value="SALARY_CERT">Salary Certificate</option>
              <option value="EXPERIENCE">Experience Letter</option>
              <option value="EMPLOYMENT_CERT">Employment Certificate</option>
              <option value="NOC">No Objection Certificate (NOC)</option>
            </select>
          </div>
          <div className="flex-[2]">
            <label className="text-[11px] font-medium text-slate-500 dark:text-slate-400">{t("Reason / notes (optional)")}</label>
            <input value={reqReason} onChange={(e) => setReqReason(e.target.value)} placeholder="e.g. required by the bank for a home-loan application"
              className="mt-1 w-full h-9 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 text-sm text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/50" />
          </div>
          <Button size="sm" className="h-9 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white text-xs shadow-sm shadow-emerald-600/20" disabled={reqBusy} onClick={submitRequest}>
            {reqBusy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Send className="h-3.5 w-3.5 mr-1.5" />} {t("Submit Request")}
          </Button>
        </div>
        {requests.length > 0 && (
          <div className="mt-4 space-y-2">
            {requests.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 px-3.5 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{titleCase(r.type.replace(/_/g, " ").toLowerCase())}</p>
                  <p className="text-[11px] text-slate-400">Requested {fmtDate(r.createdAt?.slice?.(0, 10) || r.createdAt)}{r.reason ? ` · ${r.reason}` : ""}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {r.letterNumber && <span className="text-[11px] font-mono text-slate-400">{r.letterNumber}</span>}
                  {r.status === "PENDING" && <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-200">Pending</Badge>}
                  {r.status === "FULFILLED" && <Badge className="bg-emerald-100 text-emerald-700 text-[10px]">Approved</Badge>}
                  {r.status === "REJECTED" && <Badge className="bg-rose-100 text-rose-700 text-[10px]">Rejected</Badge>}
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  )
}

// ================= MY RESIGNATION =================
function MyResignationTab({ autoDialog, onConsume }: { autoDialog: string | null; onConsume: () => void }) {
  const { can, toast } = useHrm()
  const { t } = useI18n()
  const { data, loading, error, reload } = useApi<any>("ess.resignation")
  const [open, setOpen] = useState(false)
  const [withdraw, setWithdraw] = useState(false)
  const canEdit = can("ess", "create")
  // R5 — resignation submission respects the portal visibility controls
  const canSubmitResignation = usePortalAction("showResignation")

  const res = data?.resignation
  const clearance = data?.clearance
  const settlement = data?.settlement

  const fields: FieldDef[] = [
    { name: "resignationDate", label: "Resignation Date", type: "date", required: true, defaultValue: today() },
    { name: "proposedLwd", label: "Proposed Last Working Day", type: "date", required: true, defaultValue: plusDays(today(), 30), help: "30-day notice is standard; short notice may require buyout" },
    { name: "reason", label: "Reason", type: "textarea", rows: 3, required: true, span: 2 },
    { name: "remarks", label: "Remarks", type: "textarea", rows: 2, span: 2 },
  ]

  if (loading) return <div className="rounded-xl border bg-white dark:bg-slate-900 p-6 text-center text-sm text-slate-400">Loading…</div>
  if (error) return <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{error}</div>

  if (!res) {
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-dashed">
          <EmptyState icon={LogOut} title="No resignation on file" hint="You can submit a resignation letter here — it goes through review, notice period, clearance and final settlement." />
        </div>
        {canEdit && canSubmitResignation && (
          <div className="flex justify-center">
            <Button size="sm" className="h-9 text-xs bg-rose-600 hover:bg-rose-700 text-white" onClick={() => setOpen(true)}>
              <LogOut className="h-4 w-4 mr-1.5" /> Submit Resignation
            </Button>
          </div>
        )}
        <FormDialog open={(open || (autoDialog === "resignation" && data === null)) && canSubmitResignation} onOpenChange={(v) => { if (!v) { setOpen(false); onConsume(); reload() } }}
          title="Submit Resignation" description="Your manager and HR will be notified. You may withdraw until management review."
          fields={fields} submitLabel="Submit"
          onSubmit={async (v) => { await rpc("resignations.submit", v) }} />
      </div>
    )
  }

  const stageIdx = RESIGN_FLOW.indexOf(res.status)
  const checklist: any[] = clearance?.checklist || []
  const totalItems = checklist.reduce((s, d) => s + (d.items || []).length, 0)
  const clearedItems = checklist.reduce((s, d) => s + (d.items || []).filter((i: any) => i.cleared).length, 0)
  const comput = settlement?.computation
  const canWithdraw = !["ACCEPTED", "COMPLETED", "WITHDRAWN", "REJECTED"].includes(res.status)

  return (
    <div className="space-y-4">
      {/* status timeline */}
      <SectionCard title={t("Resignation Status")} actions={<StatusBadge status={res.status} />}>
        <div className="flex flex-wrap items-center gap-1 mb-4">
          {RESIGN_FLOW.map((st, i) => (
            <div key={st} className="flex items-center">
              <span className={`px-2.5 py-1 rounded-lg text-[10px] font-medium ${i < stageIdx ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" : i === stageIdx ? "bg-primary text-primary-foreground" : "bg-slate-100 text-slate-400 dark:bg-slate-800"}`}>
                {titleCase(st)}
              </span>
              {i < RESIGN_FLOW.length - 1 && <ChevronRight className="h-3 w-3 text-slate-300 mx-0.5" />}
            </div>
          ))}
        </div>
        <KV items={[
          ["Submitted", fmtDate(res.submissionDate)],
          ["Resignation date", fmtDate(res.resignationDate)],
          ["Last working day", fmtDate(res.actualLwd || res.proposedLwd)],
          ["Notice mode", <Badge key="nm" variant="outline" className="text-[10px]">{titleCase(res.noticeMode)}</Badge>],
          ["Notice served", `${res.servedDays || 0} / ${res.noticeDays || 30} days`],
          ["Reason", <span key="r" className="text-xs">{res.reason}</span>],
        ]} />
        {res.remarks && <p className="text-xs text-slate-500 mt-3">Remarks: {res.remarks}</p>}
        {canEdit && canWithdraw && (
          <Button size="sm" variant="outline" className="h-8 text-xs mt-4 text-rose-600 border-rose-200 hover:bg-rose-50" onClick={() => setWithdraw(true)}>
            <XCircle className="h-3.5 w-3.5 mr-1" /> Withdraw Resignation
          </Button>
        )}
      </SectionCard>

      {/* clearance progress */}
      {clearance && (
        <SectionCard title={t("Exit Clearance")} actions={<StatusBadge status={clearance.status} />}>
          <div className="space-y-2 mb-3">
            <div className="flex items-center justify-between text-xs text-slate-500">
              <span>Checklist progress</span><span className="font-bold tabular-nums text-slate-700 dark:text-slate-200">{clearedItems}/{totalItems} cleared</span>
            </div>
            <Progress value={totalItems ? Math.round((clearedItems / totalItems) * 100) : 0} className="h-2" />
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {checklist.map((d: any, i: number) => {
              const done = (d.items || []).filter((x: any) => x.cleared).length
              return (
                <div key={i} className="rounded-lg border p-2.5">
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">{d.department}</p>
                    {done === (d.items || []).length ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : <Timer className="h-3.5 w-3.5 text-amber-500" />}
                  </div>
                  <p className="text-[10px] text-slate-500 dark:text-slate-400">{done}/{(d.items || []).length} items cleared</p>
                </div>
              )
            })}
          </div>
        </SectionCard>
      )}

      {/* settlement */}
      {comput && (
        <SectionCard title={t("Final Settlement Computation")} actions={
          <div className="flex items-center gap-2">
            <StatusBadge status={settlement?.status} />
            {/* EXT-04 (R7) — printable F&F statement (own record; APPROVED/PAID) */}
            {["APPROVED", "PAID"].includes(settlement?.status) && (
              <Button size="sm" variant="outline" className="h-7 text-[10px] border-emerald-200 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-400" onClick={() => openHtmlWindow("settlements.html", { id: settlement.id }, false, toast)}>
                <Printer className="h-3 w-3 mr-1" /> Print F&F
              </Button>
            )}
          </div>
        }>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-3">
            <KV items={[
              ["Final salary (to LWD)", fmtMoney(comput.finalSalary)],
              ["Overtime amount", `${fmtMoney(comput.otAmount)} (${comput.otMinutes || 0}m)`],
              ["Leave encashment", `${fmtMoney(comput.leaveEncashment)} (${comput.encashableDays || 0}d)`],
              ["Bonus due", fmtMoney(comput.bonusDue)],
              ["Gross payable", <b key="g">{fmtMoney(comput.gross)}</b>],
            ]} />
            <KV items={[
              ["Loan due", fmtMoney(comput.loanDue)],
              ["Advance due", fmtMoney(comput.advanceDue)],
              ["Notice buyout", `${fmtMoney(comput.noticeBuyout)}${comput.shortNoticeDays ? ` (${comput.shortNoticeDays}d short)` : ""}`],
              ["Other deductions", fmtMoney(comput.otherDeductions)],
              ["Net payable", <b key="n" className="text-emerald-700 dark:text-emerald-400">{fmtMoney(comput.netPayable)}</b>],
            ]} />
          </div>
        </SectionCard>
      )}

      <ConfirmDialog open={withdraw} onOpenChange={setWithdraw} title="Withdraw resignation"
        message="Withdraw your resignation? The approval request will be cancelled. This is audit-logged."
        confirmLabel="Withdraw" danger requireReason
        onConfirm={async () => {
          await rpc("resignations.withdraw", { id: res.id })
          toast("Resignation withdrawn")
          reload()
        }} />
    </div>
  )
}

// ================= MY REQUISITIONS (goods self-service) =================
function MyGoodsTab({ autoDialog, onConsume }: { autoDialog: string | null; onConsume: () => void }) {
  const toast = useHrm((s) => s.toast)
  const { data, loading, error, reload } = useApi<any[]>("requisitions.mine", {})
  const [createOpen, setCreateOpen] = useState(false)
  const [editRec, setEditRec] = useState<any>(null)
  const [detail, setDetail] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<any>(null) // { requisition, decision }
  // R5 — goods request button respects the portal visibility controls
  const canRequestGoods = usePortalAction("showGoodsRequest")

  const runReceive = async () => {
    if (!confirm) return
    try {
      const _res = await rpc("requisitions.receive", { id: confirm.requisition.id, decision: confirm.decision, remark: confirm.remark || undefined })
      toast(confirm.decision === "CONFIRM" ? `Receipt confirmed — ${confirm.requisition.reqNo} completed` : `Receipt disputed — HR has been notified`, "ok")
      setConfirm(null)
      reload()
    } catch (e: any) { toast(e.message, "err") }
  }

  const columns: Column<any>[] = [
    { key: "reqNo", label: "Requisition", sortValue: (r) => r.reqNo, render: (r) => (
      <div>
        <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">{r.reqNo || r.code}</p>
        <p className="text-[11px] text-slate-500">{fmtDate(r.requestDate || r.createdAt)} · {r.priority === "URGENT" ? "🔴 Urgent" : "Normal"}</p>
      </div>
    ) },
    { key: "items", label: "Items", align: "right", sortValue: (r) => r.itemCount, render: (r) => (
      <span className="text-xs"><b>{r.itemCount}</b> line(s) · {r.totalQty} qty</span>
    ) },
    { key: "purpose", label: "Purpose", render: (r) => <span className="text-xs text-slate-600 dark:text-slate-300 line-clamp-1 max-w-48 inline-block">{r.purpose || "—"}</span> },
    { key: "status", label: "Status", render: (r) => <StatusBadge status={r.status} /> },
    { key: "actions", label: "", align: "right", render: (r) => (
      <div className="flex gap-1 justify-end">
        {["DRAFT", "RETURNED"].includes(r.status) && (
          <Button size="sm" variant="outline" className="h-7 text-[11px] bg-white dark:bg-slate-900" onClick={() => setEditRec(r)}>
            <FileText className="h-3 w-3 mr-1" /> Edit
          </Button>
        )}
        {r.status === "ISSUED" && (
          <>
            <Button size="sm" className="h-7 text-[11px] "
              onClick={() => setConfirm({ requisition: r, decision: "CONFIRM", remark: "" })}>
              <CheckCircle2 className="h-3 w-3 mr-1" /> Confirm receipt
            </Button>
            <Button size="sm" variant="outline" className="h-7 text-[11px] text-rose-600 border-rose-200 hover:bg-rose-50 dark:border-rose-900"
              onClick={() => setConfirm({ requisition: r, decision: "DISPUTE", remark: "" })}>
              <AlertTriangle className="h-3 w-3 mr-1" /> Dispute
            </Button>
          </>
        )}
        <Button size="sm" variant="outline" className="h-7 text-[11px] bg-white dark:bg-slate-900" onClick={() => setDetail(r.id)}>
          <Eye className="h-3 w-3 mr-1" /> View
        </Button>
      </div>
    ) },
  ]

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Request office goods, follow the approval + stock flow and confirm receipt once issued. Every action is recorded in the requisition history.
        </p>
        {canRequestGoods && (
          <Button size="sm" className="h-8 text-xs  shrink-0" onClick={() => setCreateOpen(true)}>
            <Package className="h-3.5 w-3.5 mr-1" /> Request goods
          </Button>
        )}
      </div>
      <DataTable columns={columns} rows={data ?? undefined} loading={loading} error={error} pageSize={10} csvName="my-requisitions"
        searchPlaceholder="Search requisition…" emptyTitle="No requisitions yet" emptyHint="Request office goods — approvals and stock are checked automatically." />

      <GoodsRequisitionDialog
        open={(createOpen || autoDialog === "goods") && canRequestGoods}
        onOpenChange={(v) => { setCreateOpen(false); if (!v) onConsume(); if (v) reload() }}
        onSaved={reload} />
      {editRec && (
        <GoodsRequisitionDialog open onOpenChange={(v) => { setEditRec(null); if (v) reload() }} initial={editRec} onSaved={reload} />
      )}
      {detail && <MyReqDetail id={detail} onClose={() => { setDetail(null); reload() }} />}
      {confirm && (
        <Dialog open onOpenChange={() => setConfirm(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-base">{confirm.decision === "CONFIRM" ? "Confirm goods receipt" : "Report a receipt problem"}</DialogTitle>
              <DialogDescription className="text-xs">
                {confirm.decision === "CONFIRM"
                  ? `Confirm that all items of ${confirm.requisition.reqNo} were received in good condition. The requisition will be completed.`
                  : `Tell us what went wrong with ${confirm.requisition.reqNo} — HR/store will be notified and the requisition will be marked as disputed.`}
              </DialogDescription>
            </DialogHeader>
            <Textarea
              placeholder={confirm.decision === "CONFIRM" ? "Optional remark…" : "Describe the problem (damaged / missing items…) — required for a dispute"}
              value={confirm.remark}
              onChange={(e) => setConfirm((c: any) => ({ ...c, remark: e.target.value }))}
              className="text-sm" rows={3} />
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setConfirm(null)}>Cancel</Button>
              <Button onClick={runReceive} className={confirm.decision === "CONFIRM" ? "" : "bg-rose-600 hover:bg-rose-700 text-white"}>
                {confirm.decision === "CONFIRM" ? "Confirm receipt" : "Submit dispute"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

function MyReqDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const [data, setData] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    ;(async () => {
      try { setData(await rpc("requisitions.get", { id })) } catch (e: any) { setError(e.message) }
    })()
  }, [id])
  if (error) return <Dialog open onOpenChange={onClose}><DialogContent className="sm:max-w-lg"><p className="text-sm text-rose-600">{error}</p></DialogContent></Dialog>
  if (!data) return <Dialog open onOpenChange={onClose}><DialogContent className="sm:max-w-xl"><LoadingRows rows={5} /></DialogContent></Dialog>
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">{data.reqNo || data.code} <StatusBadge status={data.status} /></DialogTitle>
          <DialogDescription className="text-xs">
            Requested {fmtDate(data.requestDate || data.createdAt)}{data.requiredDate ? ` · needed by ${fmtDate(data.requiredDate)}` : ""}{data.purpose ? ` · ${data.purpose}` : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-xl border overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800">
              <tr>
                <th className="text-left p-2 uppercase text-[10px]">Item</th>
                <th className="text-right p-2 uppercase text-[10px]">Requested</th>
                <th className="text-right p-2 uppercase text-[10px]">Issued</th>
              </tr>
            </thead>
            <tbody>
              {(data.items || []).map((l: any) => (
                <tr key={l.id} className="border-t dark:border-slate-800">
                  <td className="p-2">
                    <p className="font-medium">{l.itemName}</p>
                    {l.specification && <p className="text-[10px] text-slate-500">{l.specification}</p>}
                  </td>
                  <td className="p-2 text-right tabular-nums">{l.quantity} {l.unit}</td>
                  <td className="p-2 text-right tabular-nums">{l.issuedQty || l.issuedQuantity || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {(data.history || []).length > 0 && (
          <div className="space-y-1.5 max-h-56 overflow-y-auto">
            {data.history.map((h: any, i: number) => (
              <div key={i} className="flex items-start gap-2 text-[11px]">
                <span className="text-slate-400 tabular-nums shrink-0">{fmtDateTime(h.createdAt)}</span>
                <span className="font-medium shrink-0">{h.userName || h.byUserName}</span>
                <span className="text-slate-600 dark:text-slate-300">{h.action}{h.note ? ` — ${h.note}` : ""}</span>
              </div>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ================= MY AIT / TAX CERTIFICATE (self-service, fix #7) =================
// C-07 — exported pure builder (unit-testable): every interpolation is escaped
// so stored values can never break out of text/attribute context in print output.
export function buildMyTaxCertHtml(c: any): string {
  const rows = (c.result?.lines || []).map((l: any) =>
    `<tr><td style="padding:6px 10px;border-bottom:1px solid #e2e8f0">${esc(l.label)}${l.ref ? ` <span style="color:#64748b">(${esc(l.ref)})</span>` : ""}</td><td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;text-align:right;font-variant-numeric:tabular-nums">${esc(l.display ?? fmtMoney(l.value))}</td></tr>`
  ).join("")
  const slabs = (c.result?.slabLines || []).map((s: any) =>
    `<tr><td style="padding:4px 10px;border-bottom:1px solid #e2e8f0">${esc(s.slabLabel)}</td><td style="padding:4px 10px;border-bottom:1px solid #e2e8f0;text-align:right">${esc(s.rate)}%</td><td style="padding:4px 10px;border-bottom:1px solid #e2e8f0;text-align:right">${esc(fmtMoney(s.amount))}</td><td style="padding:4px 10px;border-bottom:1px solid #e2e8f0;text-align:right">${esc(fmtMoney(s.tax))}</td></tr>`
  ).join("")
  const disclaimers = c.disclaimer || {}
  return `
  <html><head><title>TDS Certificate — ${esc(c.employee?.name)}</title>
  <style>body{font-family:ui-sans-serif,system-ui,'Noto Sans Bengali',sans-serif;padding:32px;color:#0f172a}
  h1{font-size:20px;margin:0} h2{font-size:14px;margin:16px 0 6px}
  table{width:100%;border-collapse:collapse;font-size:12px}
  .meta td{padding:3px 10px 3px 0;font-size:12px}
  .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #059669;padding-bottom:12px}
  .disc{margin-top:24px;padding:10px 12px;border:1px solid #f59e0b;background:#fffbeb;font-size:11px;color:#92400e}
  .sign{margin-top:48px;display:flex;justify-content:flex-end}
  .sign div{border-top:1px solid #334155;padding-top:6px;font-size:12px;text-align:center}
  </style></head><body>
  <div class="head">
    <div>
      <h1>${esc(c.company?.name || "")}</h1>
      <p style="font-size:12px;margin:2px 0">${esc(c.company?.address || "")}${c.company?.phone ? " · " + esc(c.company.phone) : ""}</p>
      <p style="font-size:11px;color:#475569;margin:2px 0">TIN: ${esc(c.company?.tin || "—")}</p>
    </div>
    <div style="text-align:right">
      <h1 style="color:#059669">TDS Certificate</h1>
      <p style="font-size:12px;margin:2px 0">Salary Tax Slip / মাসিক কর কর্তন সনদ</p>
      <p style="font-size:11px;color:#475569;margin:2px 0">${esc(c.fiscalYear?.label)} · AY ${esc(c.fiscalYear?.assessmentYear)}</p>
    </div>
  </div>
  <h2>Employee / কর্মী</h2>
  <table class="meta">
    <tr><td><b>${esc(c.employee?.name)}</b> (${esc(c.employee?.code)})</td><td>Designation: ${esc(c.employee?.designation || "—")}</td></tr>
    <tr><td>TIN: ${esc(c.employee?.tin || "—")}</td><td>Mobile: ${esc(c.employee?.mobile || "—")}</td></tr>
  </table>
  <h2>Calculation — ${esc(c.fiscalYear?.tdsSectionRef)}</h2>
  <table>${rows}</table>
  ${slabs ? `<h2>Slab-wise tax — First Schedule (Part A)</h2><table><tr><th align="left" style="padding:4px 10px">Slab</th><th align="right" style="padding:4px 10px">Rate</th><th align="right" style="padding:4px 10px">Amount</th><th align="right" style="padding:4px 10px">Tax</th></tr>${slabs}</table>` : ""}
  <table class="meta" style="margin-top:14px">
    <tr><td><b>TDS this month:</b> ${esc(fmtMoney(c.tdsThisMonth))}${c.tdsThisMonthIsEstimate ? " <span style=\"color:#64748b\">(estimated — no payroll posted yet)</span>" : ""}</td><td><b>TDS year-to-date:</b> ${esc(fmtMoney(c.tdsYtd))} (${esc(c.monthsCovered || 0)} month(s))</td></tr>
  </table>
  <div class="disc">
    <b>Disclaimer / দাবিত্যাগ:</b> ${esc(disclaimers.bn || "")}<br/>${esc(disclaimers.en || "")}
  </div>
  <div class="sign"><div>${esc(c.company?.signatoryName || "Authorized Signatory")}<br><span style="color:#64748b">${esc(c.company?.signatoryDesignation || "")}</span></div></div>
  </body></html>`
}

function MyTaxCertTab() {
  const toast = useHrm((s) => s.toast)
  const { data, loading, error } = useApi<any>("ait.myCertificates", {})
  const [printing, setPrinting] = useState<string | null>(null)

  const printCert = async (fiscalYearId: string) => {
    setPrinting(fiscalYearId)
    try {
      const c = await rpc<any>("ait.myCertificate.print", { fiscalYearId })
      const html = buildMyTaxCertHtml(c)
      const w = openPrintWindow(html)
      if (!w) toast("Popup blocked — allow popups to print the certificate", "err")
    } catch (e: any) {
      toast(e.message || "Could not load the certificate", "err")
    } finally { setPrinting(null) }
  }

  if (loading) return <LoadingRows rows={4} />
  if (error) return <ErrorBanner message={error} />
  const certs: any[] = data?.certificates || []
  if (!certs.length) {
    return <EmptyState title="No tax certificates yet" hint="Certificates appear once a fiscal-year tax configuration is active and salary TDS is being processed." icon={CertCheck} />
  }
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-900 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-300">
        {data?.disclaimer?.bn || "এই হিসাবটি আয়কর আইন ২০২৩-এর ধারা ৮৬ অনুযায়ী মাসিক উৎসে কর কর্তনের (AIT/TDS) একটি নির্দেশক হিসাব মাত্র।"}
        <br />
        {data?.disclaimer?.en || "This is an indicative calculation of monthly tax withheld at source (AIT/TDS) under Section 86 of the Income Tax Act 2023."}
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        {certs.map((c) => (
          <Card key={c.fiscalYearId} className="border-slate-200 dark:border-slate-800">
            <CardContent className="p-4 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <FileSpreadsheet className="h-4 w-4 text-emerald-600" />
                  <div>
                    <p className="text-sm font-bold text-slate-800 dark:text-slate-100">{c.label}</p>
                    <p className="text-[11px] text-slate-500">Income year {c.incomeYear} · Assessment year {c.assessmentYear}{c.active ? " · active" : ""}</p>
                  </div>
                </div>
                <StatusBadge status={c.tdsDeducted > 0 ? "DEDUCTED" : "NO_TDS"} />
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-lg bg-slate-50 dark:bg-slate-800/60 px-2.5 py-1.5">
                  <p className="text-[10px] uppercase text-slate-500">TDS deducted (FY)</p>
                  <p className="font-bold tabular-nums text-emerald-700 dark:text-emerald-400">{fmtMoney(c.tdsDeducted)}</p>
                  <p className="text-[10px] text-slate-400">{c.monthsCovered} month(s) covered</p>
                </div>
                <div className="rounded-lg bg-slate-50 dark:bg-slate-800/60 px-2.5 py-1.5">
                  <p className="text-[10px] uppercase text-slate-500">Estimated annual tax</p>
                  <p className="font-bold tabular-nums text-slate-700 dark:text-slate-200">{fmtMoney(c.estimatedAnnualTax)}</p>
                  <p className="text-[10px] text-slate-400">avg rate {Number(c.averageRatePercent || 0).toFixed(2)}% · TDS {fmtMoney(c.monthlyTds)}/mo</p>
                </div>
              </div>
              {(c.warnings || []).length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {(c.warnings as any[]).slice(0, 3).map((w, i) => (
                    <Badge key={i} className="bg-amber-100 text-amber-700 text-[9px]" title={w.message}>{w.code}</Badge>
                  ))}
                </div>
              )}
              <Button size="sm" className="h-8 w-full text-xs " disabled={printing === c.fiscalYearId}
                onClick={() => printCert(c.fiscalYearId)}>
                <Printer className="h-3.5 w-3.5 mr-1.5" /> {printing === c.fiscalYearId ? "Preparing…" : "View / print certificate"}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}

// ================= MY DEVICES (Selfie Attendance G2 — device binding) =================
// The employee-side registry of the devices they punch from. "Register this
// device" enrols the CURRENT browser/phone (stable local id + platform + UA);
// the server issues an enrolment key ONCE and parks the row in PENDING until
// an administrator approves it (Attendance → Devices). Cap: 3 devices; the
// 4th enrolment auto-revokes the oldest. A device row NEVER blocks a punch
// unless the admin's ATTENDANCE_METHOD policy sets deviceBinding=STRICT.
function MyDevicesSection() {
  const { toast } = useHrm()
  const { data, loading, reload } = useApi<any>("attendance.myDevices.list")
  const [busy, setBusy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState<any | null>(null)
  const [enrollKey, setEnrollKey] = useState<{ key: string; message: string } | null>(null)

  const devices: any[] = data?.devices || []

  /** Stable per-browser device id. localStorage keeps it across sessions;
   * a new id would just look like a new device (flagged DEVICE_MISMATCH). */
  const deviceId = (): string => {
    try {
      let id = window.localStorage.getItem("hrm_device_id")
      if (!id) {
        id = (crypto.randomUUID?.() || `dev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`)
        window.localStorage.setItem("hrm_device_id", id)
      }
      return id
    } catch { return `dev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` }
  }

  const platform = (): "ANDROID" | "IOS" | "WEB" => {
    const ua = navigator.userAgent || ""
    if (/android/i.test(ua)) return "ANDROID"
    if (/iphone|ipad|ipod/i.test(ua)) return "IOS"
    return "WEB"
  }

  const enroll = async () => {
    setBusy(true)
    try {
      const res = await rpc<any>("attendance.myDevices.enroll", {
        deviceId: deviceId(),
        label: `${platform() === "WEB" ? "This browser" : "This phone"} — My Portal`,
        platform: platform(),
        userAgent: navigator.userAgent.slice(0, 200),
      })
      if (res.enrollKey) setEnrollKey({ key: res.enrollKey, message: res.message || "Device registered — save the key now; it is not shown again." })
      else toast(res.message || "This device is already registered and approved")
      reload()
    } catch (e: any) { toast(e.message || "Could not register this device", "err") } finally { setBusy(false) }
  }

  const remove = async (d: any) => {
    setBusy(true)
    try {
      await rpc("attendance.myDevices.remove", { id: d.id })
      toast("Device removed")
      reload()
    } catch (e: any) { toast(e.message || "Could not remove the device", "err") } finally { setBusy(false); setConfirmRemove(null) }
  }

  const statusTone = (s: string) =>
    s === "ACTIVE" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
    : s === "PENDING" ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
    : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"

  return (
    <SectionCard title={
      <span className="flex items-center gap-1.5"><Smartphone className="h-4 w-4 text-emerald-600" /> My Devices</span>
    }>
      <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
        Devices registered for your attendance punches. An administrator approves each registration; strict device
        binding (if your policy enables it) only accepts punches from an approved device.
      </p>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <Button size="sm" className="h-8 text-xs " disabled={busy} onClick={enroll}>
          <Smartphone className="h-3.5 w-3.5 mr-1" /> {busy ? "Registering…" : "Register This Device"}
        </Button>
        <span className="text-[11px] text-slate-400">Max 3 devices — registering a 4th replaces the oldest.</span>
      </div>
      {loading ? <LoadingRows rows={2} /> : devices.length === 0 ? (
        <EmptyState icon={Smartphone} title="No devices registered"
          hint="Register the phone/browser you punch from. Until an administrator approves it, strict device-binding policies treat punches from it as unverified." />
      ) : (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800">
          {devices.map((d) => (
            <div key={d.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <Smartphone className="h-4 w-4 text-slate-400 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-slate-800 dark:text-slate-100 truncate">{d.label || d.deviceId.slice(0, 16)}</p>
                <p className="text-[11px] text-slate-400 truncate">
                  {titleCase(d.platform || "unknown")} · enrolled {fmtDate(d.enrolledAt)}
                  {d.lastSeenAt ? ` · last seen ${fmtDate(d.lastSeenAt)}` : ""}
                  {d.revokedAt && d.revokeReason ? ` · ${d.revokeReason}` : ""}
                </p>
              </div>
              <Badge className={`text-[10px] ${statusTone(d.status)}`}>
                {d.status === "PENDING" ? "Awaiting approval" : d.status === "ACTIVE" ? "Approved" : "Removed"}
              </Badge>
              {d.status !== "REVOKED" && (
                <Button size="sm" variant="outline" className="h-7 text-xs text-rose-600 hover:text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-900/20" disabled={busy} onClick={() => setConfirmRemove(d)}>
                  Remove
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
      <ConfirmDialog open={!!confirmRemove} onOpenChange={(v: boolean) => !v && setConfirmRemove(null)}
        title="Remove this device?" message="Punches from it will no longer be attributed to a registered device. You can re-register it at any time."
        confirmLabel="Remove device" danger onConfirm={() => remove(confirmRemove)} />
      <Dialog open={!!enrollKey} onOpenChange={(o: boolean) => !o && setEnrollKey(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Smartphone className="h-4 w-4 text-emerald-600" /> Device registered</DialogTitle>
            <DialogDescription>{enrollKey?.message}</DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-800 p-3">
            <p className="text-[10px] uppercase font-semibold text-amber-700 dark:text-amber-300 mb-1">Enrolment key — shown once</p>
            <p className="font-mono text-xs break-all text-slate-800 dark:text-slate-100 select-all">{enrollKey?.key}</p>
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => { try { navigator.clipboard?.writeText(enrollKey?.key || "") ; toast("Key copied") } catch { toast("Copy failed — select the key manually", "err") } }}>Copy key</Button>
            <Button size="sm" onClick={() => setEnrollKey(null)}>Done</Button>
          </div>
        </DialogContent>
      </Dialog>
    </SectionCard>
  )
}

// ================= CONSENT BANNER (Selfie Attendance G3 — privacy consent) =================
// Shows the vendor's selfie-attendance consent text when enabled AND not yet
// acknowledged on the current policy version. Acknowledgment is recorded as
// a versioned EmployeeConsent row (time + IP). Consent NEVER blocks a punch
// (§27): a missing acknowledgment is surfaced for HR follow-up only.
function ConsentBanner() {
  const { toast } = useHrm()
  const { data, reload } = useApi<any>("attendance.consent.status")
  const [busy, setBusy] = useState(false)

  if (!data?.enabled || data?.accepted) return null

  const accept = async () => {
    setBusy(true)
    try {
      await rpc("attendance.consent.accept", { version: data.version, userAgent: navigator.userAgent.slice(0, 200) })
      toast("Thank you — your acknowledgment was recorded")
      reload()
    } catch (e: any) { toast(e.message || "Could not record your acknowledgment", "err") } finally { setBusy(false) }
  }

  return (
    <SectionCard title={
      <span className="flex items-center gap-1.5"><ShieldCheck className="h-4 w-4 text-amber-600" /> Selfie Attendance — Privacy Notice</span>
    }>
      <div className="rounded-xl border border-amber-200 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-800 p-4">
        <div className="flex items-start gap-3">
          <ShieldCheck className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1 space-y-2">
            <p className="text-[10px] uppercase font-semibold text-amber-700 dark:text-amber-300">
              Policy version {data.version || "1"} · acknowledgment recorded with time and IP
            </p>
            <p className="text-sm text-slate-700 dark:text-slate-200 whitespace-pre-wrap">{data.text || "Your organization captures a selfie as attendance evidence. It is stored privately, access is permission-gated and audit-logged."}</p>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              You can keep punching without acknowledging — the notice simply stays visible and HR is flagged for follow-up.
            </p>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button size="sm" className="h-8 text-xs " disabled={busy} onClick={accept}>
                <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> {busy ? "Recording…" : "I Acknowledge"}
              </Button>
              {data.acceptedAt && <span className="text-[11px] text-slate-400">Previously accepted {fmtDate(data.acceptedAt)} on version {data.version}</span>}
            </div>
          </div>
        </div>
      </div>
    </SectionCard>
  )
}

// ================= MY VISITS (Field Force — Wave 2 WP-M) =================
// Today's field-visit plan + GPS check-in/out. The SERVER computes the
// distance to each location (never the browser — same rule as geo-fence
// attendance): outside the allowed radius a check-in is rejected unless a
// justification note is supplied, in which case the visit is accepted with an
// out-of-radius flag. Optional photo proof rides the same private-proof
// pipeline as selfie attendance (SelfieCaptureDialog → byte-sniffed
// AttendanceProof row). Plan tasks are informational; completion is the
// check-out (duration + remarks), which is what the admin timeline shows.
function MyVisitsTab() {
  const { toast } = useHrm()
  const { t } = useI18n()
  const { data, loading, error, reload } = useApi<any>("fieldforce.myday", {})
  const [busyIn, setBusyIn] = useState(false)
  const [busyOut, setBusyOut] = useState(false)
  // check-in dialog state
  const [target, setTarget] = useState<{ planItemId?: string; locationId: string; name: string; radiusM?: number | null } | null>(null)
  const [checkinOpen, setCheckinOpen] = useState(false)
  const [remarks, setRemarks] = useState("")
  const [noteRequired, setNoteRequired] = useState(false)
  const [checkinError, setCheckinError] = useState<string | null>(null)
  // optional photo proof — own SelfieCaptureDialog instance (the shared
  // captureSelfie() lives inside the EssView closure; mounting a second
  // dialog keeps this addition surgical)
  const [photoAskOpen, setPhotoAskOpen] = useState(false)
  const [photo, setPhoto] = useState<SelfieResult | null>(null)
  // ad-hoc + check-out state
  const [adHocLocation, setAdHocLocation] = useState("")
  const [outNote, setOutNote] = useState("")

  /** One bounded GPS attempt — same contract as the quick-action helper in
   *  EssView. Local copy so this tab does not restructure existing code. */
  const getPosition = (opts: { timeout: number; highAccuracy: boolean }): Promise<GeolocationPosition | null> =>
    new Promise((resolve) => {
      if (!navigator.geolocation) { resolve(null); return }
      navigator.geolocation.getCurrentPosition(resolve, () => resolve(null),
        { enableHighAccuracy: opts.highAccuracy, timeout: opts.timeout, maximumAge: 30000 })
    })

  /** Mobile-hardened GPS — the same ladder as the geo check-in quick action
   *  (secure-context gate → permission check → 20s high-accuracy fix → fast
   *  network-loc retry). */
  const getReliablePosition = async (): Promise<{ pos: GeolocationPosition | null; secure: boolean; permissionDenied: boolean }> => {
    if (typeof window !== "undefined" && window.isSecureContext === false) return { pos: null, secure: false, permissionDenied: false }
    if (!navigator.geolocation) return { pos: null, secure: true, permissionDenied: false }
    const denied = await new Promise<boolean>((resolve) => {
      try {
        (navigator as any).permissions?.query({ name: "geolocation" })
          .then((st: any) => resolve(st.state === "denied"))
          .catch(() => resolve(false))
      } catch { resolve(false) }
    })
    if (denied) return { pos: null, secure: true, permissionDenied: true }
    const pos = await getPosition({ timeout: 20000, highAccuracy: true })
      ?? await getPosition({ timeout: 10000, highAccuracy: false })
    return { pos, secure: true, permissionDenied: false }
  }

  const openCheckin = (t: { planItemId?: string; locationId: string; name: string; radiusM?: number | null }) => {
    setTarget(t)
    setRemarks("")
    setNoteRequired(false)
    setCheckinError(null)
    setPhoto(null)
    setCheckinOpen(true)
  }
  const closeCheckin = () => {
    setCheckinOpen(false)
    setTarget(null)
    setRemarks("")
    setNoteRequired(false)
    setCheckinError(null)
    setPhoto(null)
  }

  const submitCheckIn = async () => {
    if (!target) return
    if (noteRequired && !remarks.trim()) {
      setCheckinError("A note is required to check in from outside the allowed radius — explain why you are not at the location.")
      return
    }
    const { pos, secure, permissionDenied } = await getReliablePosition()
    if (!secure) { setCheckinError("Visit check-in needs a secure (HTTPS) connection — open this page over HTTPS."); return }
    if (permissionDenied) { setCheckinError("Location permission denied — allow location in your browser settings and retry."); return }
    if (!pos) { setCheckinError("Could not get your location — move near a window or outdoors and retry."); return }
    setBusyIn(true)
    setCheckinError(null)
    try {
      const res = await rpc("fieldforce.visit.checkin", {
        locationId: target.locationId,
        ...(target.planItemId ? { planItemId: target.planItemId } : {}),
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: Math.round(pos.coords.accuracy || 0),
        remarks: remarks.trim() || undefined,
        ...(photo ? { photoDataUrl: photo.dataUrl, photoQuality: photo.quality } : {}),
      })
      toast(`Checked in at ${res.locationName}${res.distanceM != null ? ` (${res.distanceM}m from center)` : ""}${res.outOfRadius ? " — flagged out of radius for review" : ""}`)
      closeCheckin()
      reload()
    } catch (e: any) {
      const msg = String(e?.message || "Check-in failed")
      setCheckinError(msg)
      // the server's strict out-of-radius rejection asks for a note — the
      // retry (below) then submits it and the visit lands flagged
      if (/Move inside the allowed radius/.test(msg)) setNoteRequired(true)
    } finally { setBusyIn(false) }
  }

  const doCheckOut = async () => {
    const open = data?.openVisit
    if (!open) return
    setBusyOut(true)
    try {
      // best-effort GPS for the check-out coordinates (optional in the schema)
      const pos = await getPosition({ timeout: 12000, highAccuracy: true })
      const res = await rpc("fieldforce.visit.checkout", {
        visitId: open.id,
        ...(pos ? { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: Math.round(pos.coords.accuracy || 0) } : {}),
        remarks: outNote.trim() || undefined,
      })
      toast(`Checked out of ${res.locationName} — visit duration ${res.durationMin}m`)
      setOutNote("")
      reload()
    } catch (e: any) {
      toast(String(e?.message || "Check-out failed"), "err")
    } finally { setBusyOut(false) }
  }

  if (loading) return <LoadingRows rows={4} />
  if (error) {
    // vendors without the Field Force module get a graceful, quiet surface
    if (/not included in your/i.test(error)) {
      return (
        <SectionCard title={t("My Visits")}>
          <EmptyState icon={MapPin} title="Field visits are not enabled for your organization"
            hint="When your organization activates the Field Force module, your daily visit plan and GPS check-in appear here." />
        </SectionCard>
      )
    }
    return <ErrorBanner message={error} />
  }

  const items: any[] = data?.items ?? []
  const locations: any[] = data?.locations ?? []
  const visits: any[] = data?.visits ?? []
  const openVisit: any = data?.openVisit ?? null
  const fmtTime = (d: any) => d ? new Date(d).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "—"

  return (
    <div className="space-y-4">
      {/* open visit — the active check-in the employee must close */}
      {openVisit && (
        <SectionCard title={<span className="flex items-center gap-1.5"><Timer className="h-4 w-4 text-emerald-600" /> Current Visit</span>}>
          <div className="rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-bold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
                  <MapPin className="h-4 w-4 text-emerald-600 shrink-0" /> {openVisit.locationName}
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 tabular-nums">
                  Checked in at {fmtTime(openVisit.checkInAt)}
                  {openVisit.checkInLat != null ? ` · ${openVisit.checkInLat.toFixed(4)}, ${openVisit.checkInLng?.toFixed(4)}` : ""}
                  {openVisit.outOfRadius ? " · out of radius" : ""}
                </p>
                {openVisit.remarks && <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 italic">{openVisit.remarks}</p>}
              </div>
              <div className="flex flex-col gap-2 min-w-[220px] flex-1 sm:max-w-xs">
                <Input value={outNote} onChange={(e) => setOutNote(e.target.value)} placeholder="Completion note (optional) — what did you finish?"
                  className="h-9 text-xs" aria-label="Visit completion note" />
                <Button size="sm" className="h-9 text-xs" onClick={doCheckOut} disabled={busyOut}>
                  {busyOut ? "Checking out…" : <><Clock className="h-3.5 w-3.5 mr-1.5" /> Check Out</>}
                </Button>
              </div>
            </div>
          </div>
        </SectionCard>
      )}

      {/* today's plan */}
      <SectionCard title={<span>Today&apos;s Visit Plan <span className="text-slate-400 font-normal">· {fmtDate(data?.date)}</span></span>}>
        {items.length === 0 ? (
          <EmptyState icon={MapPin} title="No visits planned for today"
            hint="Your supervisor assigns the day's route — planned stops with time windows and tasks appear here." />
        ) : (
          <div className="space-y-2">
            {items.map((item: any) => (
              <div key={item.id} className={`rounded-lg border px-3 py-2.5 ${item.visit?.status === "MISSED" ? "border-rose-200 dark:border-rose-900 bg-rose-50/50 dark:bg-rose-950/20" : "border-slate-200 dark:border-slate-800"}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <MapPin className="h-3.5 w-3.5 text-teal-600 shrink-0" />
                  <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{item.locationName}</p>
                  {item.plannedFrom && (
                    <span className="text-[11px] tabular-nums text-slate-500 dark:text-slate-400">{item.plannedFrom}{item.plannedTo ? `–${item.plannedTo}` : ""}</span>
                  )}
                  <span className="ml-auto flex items-center gap-1.5">
                    {item.visit?.outOfRadius && (
                      <Badge variant="outline" className="text-[10px] text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-800">
                        <AlertTriangle className="h-3 w-3 mr-1" /> out of radius
                      </Badge>
                    )}
                    {item.visit ? (
                      <Badge variant="secondary" className={`text-[10px] font-medium ${item.visit.status === "COMPLETED" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" : item.visit.status === "MISSED" ? "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300" : "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300"}`}>
                        {titleCase(item.visit.status)}
                      </Badge>
                    ) : (
                      <Button size="sm" className="h-7 px-2.5 text-xs" disabled={!!openVisit}
                        title={openVisit ? "Check out of your current visit first" : `Check in at ${item.locationName}`}
                        onClick={() => openCheckin({ planItemId: item.id, locationId: item.locationId, name: item.locationName, radiusM: item.radiusM })}>
                        <MapPin className="h-3.5 w-3.5 mr-1" /> Check In
                      </Button>
                    )}
                  </span>
                </div>
                {item.locationAddress && <p className="text-[11px] text-slate-400 mt-0.5 truncate">{item.locationAddress}</p>}
                {item.tasks && (
                  <ul className="mt-1.5 space-y-0.5">
                    {String(item.tasks).split(/\r?\n/).filter(Boolean).map((t: string, i: number) => (
                      <li key={i} className="text-[11px] text-slate-500 dark:text-slate-400 flex items-start gap-1.5">
                        <CheckCircle2 className={`h-3 w-3 mt-0.5 shrink-0 ${item.visit?.status === "COMPLETED" ? "text-emerald-500" : "text-slate-300 dark:text-slate-600"}`} />
                        <span className="min-w-0">{t}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {item.visit && (
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1.5 tabular-nums">
                    Check-in {fmtTime(item.visit.checkInAt)}
                    {item.visit.checkOutAt ? ` · check-out ${fmtTime(item.visit.checkOutAt)} · ${minutesHHMM(item.visit.durationMin || 0)}` : ""}
                    {item.visit.distanceM != null ? ` · ${item.visit.distanceM}m from center` : ""}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      {/* ad-hoc check-in */}
      {locations.length > 0 && (
        <SectionCard title="Ad-hoc Check-In">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[220px] flex-1">
              <Label className="text-xs text-slate-500">Visiting somewhere unplanned?</Label>
              <Select value={adHocLocation || "none"} onValueChange={(v) => setAdHocLocation(v === "none" ? "" : v)}>
                <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="Pick a location…" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— Pick a location —</SelectItem>
                  {locations.map((l: any) => (
                    <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button size="sm" className="h-9 text-xs" disabled={!adHocLocation || !!openVisit || busyIn}
              title={openVisit ? "Check out of your current visit first" : undefined}
              onClick={() => {
                const loc = locations.find((l: any) => l.id === adHocLocation)
                if (loc) openCheckin({ locationId: loc.id, name: loc.name, radiusM: loc.radiusM })
              }}>
              <MapPin className="h-3.5 w-3.5 mr-1" /> Check In
            </Button>
          </div>
          <p className="text-[11px] text-slate-400 mt-2">
            Ad-hoc visits appear on your supervisor&apos;s timeline alongside the planned route.
          </p>
        </SectionCard>
      )}

      {/* today's activity (timeline) */}
      {visits.length > 0 && (
        <SectionCard title={<span>Today&apos;s Activity <span className="text-slate-400 font-normal">· {visits.length} visit{visits.length !== 1 ? "s" : ""}</span></span>}>
          <div className="space-y-1.5">
            {visits.map((v: any) => (
              <div key={v.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600 dark:text-slate-300 rounded-lg border border-slate-100 dark:border-slate-800 px-3 py-2">
                <span className="font-medium">{v.locationName}</span>
                <Badge variant="outline" className="text-[10px]">{v.planItemId ? "planned" : "ad-hoc"}</Badge>
                <span className="tabular-nums text-slate-500 dark:text-slate-400">
                  {fmtTime(v.checkInAt)} → {v.checkOutAt ? fmtTime(v.checkOutAt) : "…"}
                  {v.durationMin != null ? ` (${minutesHHMM(v.durationMin)})` : ""}
                  {v.distanceM != null ? ` · ${v.distanceM}m` : ""}
                </span>
                {v.outOfRadius && (
                  <Badge variant="outline" className="text-[10px] text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-800">
                    <AlertTriangle className="h-3 w-3 mr-1" /> out of radius
                  </Badge>
                )}
                <span className="ml-auto">
                  <Badge variant="secondary" className={`text-[10px] font-medium ${v.status === "COMPLETED" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" : v.status === "MISSED" ? "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300" : "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300"}`}>
                    {titleCase(v.status)}
                  </Badge>
                </span>
                {v.remarks && <p className="basis-full text-[11px] text-slate-400 italic truncate">{v.remarks}</p>}
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {/* visit check-in dialog */}
      <Dialog open={checkinOpen} onOpenChange={(v) => { if (!v && !busyIn) closeCheckin() }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-1.5"><MapPin className="h-4 w-4 text-teal-600" /> Check In — {target?.name}</DialogTitle>
            <DialogDescription>
              Your GPS position is verified against the location&apos;s allowed radius on the server.
              {target?.radiusM ? ` Allowed radius: ${Math.round(target.radiusM)}m around the mapped point.` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {/* optional photo proof */}
            <div className="flex items-center gap-3">
              {photo ? (
                <>
                  <img src={photo.dataUrl} alt="Visit photo proof preview" className="h-16 w-16 rounded-lg object-cover border" />
                  <Button variant="ghost" size="sm" className="text-xs text-rose-600 hover:text-rose-700 hover:bg-rose-500/10" onClick={() => setPhoto(null)}>
                    Remove photo
                  </Button>
                </>
              ) : (
                <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setPhotoAskOpen(true)}>
                  <Camera className="h-3.5 w-3.5 mr-1.5" /> Attach Photo Proof
                </Button>
              )}
              <p className="text-[11px] text-slate-400">Optional — stored privately like selfie attendance.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="visit-remarks" className={`text-xs font-medium ${noteRequired ? "text-amber-700 dark:text-amber-400" : "text-slate-600 dark:text-slate-300"}`}>
                {noteRequired ? "Reason (required — you are outside the allowed radius)" : "Note (optional)"}
              </Label>
              <Textarea id="visit-remarks" rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)}
                placeholder={noteRequired ? "e.g. Client asked to meet at the nearby office instead" : "Anything your supervisor should know about this visit"} />
              {noteRequired && (
                <p className="text-[11px] text-amber-600 dark:text-amber-400">
                  The visit will be recorded with an out-of-radius flag for your supervisor to review.
                </p>
              )}
            </div>
            <FieldError message={checkinError} />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => closeCheckin()} disabled={busyIn}>Cancel</Button>
            <Button onClick={submitCheckIn} disabled={busyIn || (noteRequired && !remarks.trim())}>
              {busyIn ? "Checking in…" : "Check In"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* photo capture — same in-app camera dialog the punch flow uses */}
      <SelfieCaptureDialog
        open={photoAskOpen}
        title="Visit photo proof"
        hint="Optional — a photo of the site confirms your presence; it is stored privately."
        onCaptured={(r) => { setPhoto(r); setPhotoAskOpen(false) }}
        onCancel={() => setPhotoAskOpen(false)}
      />
    </div>
  )
}
