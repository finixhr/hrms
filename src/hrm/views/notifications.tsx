"use client"
// ============ Notification Center ============
// In-app notification inbox: unread dots, click-to-read + navigate, type filters.
// P6 WS-C — plus the Web Push device card: enable/test/remove THIS browser's
// push subscription (punches + approvals arrive as native notifications).
import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Bell, Plane, Wallet, Clock, ListChecks, Landmark, FileText, Cake, Megaphone,
  LogOut, Receipt, Target, CheckCheck, RefreshCw, Inbox, ChevronRight, ShieldCheck,
  Smartphone, BellRing, Send, Trash2, Loader2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useHrm } from "../store"
import { useApi, rpc } from "../api"
import { PageHeader, fmtDateTime, titleCase } from "../shared/ui-kit"

const TYPE_ICONS: Record<string, any> = {
  LEAVE: Plane, PAYROLL: Wallet, ATTENDANCE: Clock, TASK: ListChecks, LOAN: Landmark,
  DOC: FileText, LETTER: FileText, WISH: Cake, ANNOUNCEMENT: Megaphone, EXIT: LogOut,
  SYSTEM: Bell, EXPENSE: Receipt, KPI: Target,
}
const TYPE_TONES: Record<string, string> = {
  LEAVE: "bg-orange-50 dark:bg-orange-950/50 text-orange-600",
  PAYROLL: "bg-emerald-50 dark:bg-emerald-950/50 text-emerald-600",
  ATTENDANCE: "bg-teal-50 dark:bg-teal-950/50 text-teal-600",
  TASK: "bg-violet-50 dark:bg-violet-950/50 text-violet-600",
  LOAN: "bg-amber-50 dark:bg-amber-950/50 text-amber-600",
  DOC: "bg-slate-100 dark:bg-slate-800 text-slate-500",
  LETTER: "bg-teal-50 dark:bg-teal-950/50 text-teal-600",
  WISH: "bg-pink-50 dark:bg-pink-950/50 text-pink-500",
  ANNOUNCEMENT: "bg-amber-50 dark:bg-amber-950/50 text-amber-600",
  EXIT: "bg-rose-50 dark:bg-rose-950/50 text-rose-600",
  SYSTEM: "bg-slate-100 dark:bg-slate-800 text-slate-500",
  EXPENSE: "bg-amber-50 dark:bg-amber-950/50 text-amber-600",
  KPI: "bg-violet-50 dark:bg-violet-950/50 text-violet-600",
}

export default function NotificationsView() {
  const { can, navigate, refreshUnread, toast } = useHrm()
  const allowed = can("notifications", "view")
  const { data, loading, error, reload } = useApi<any[]>(allowed ? "notifications.list" : null)
  const [filter, setFilter] = useState<"ALL" | "UNREAD" | string>("ALL")
  const [busy, setBusy] = useState(false)

  const items = data || []
  const unreadCount = items.filter((n) => !n.readAt).length
  const types = useMemo(() => [...new Set(items.map((n) => n.type))], [items])

  const filtered = useMemo(() => {
    if (filter === "ALL") return items
    if (filter === "UNREAD") return items.filter((n) => !n.readAt)
    return items.filter((n) => n.type === filter)
  }, [items, filter])

  if (!allowed) {
    return (
      <div className="rounded-xl border bg-white dark:bg-slate-900 p-8 text-center">
        <ShieldCheck className="h-8 w-8 text-slate-300 mx-auto mb-2" />
        <p className="text-sm font-medium text-slate-600 dark:text-slate-300">Notifications are not available.</p>
      </div>
    )
  }

  const open = async (n: any) => {
    try {
      if (!n.readAt) {
        await rpc("notifications.read", { id: n.id })
        refreshUnread()
        reload()
      }
      if (n.link) navigate(n.link)
    } catch (e: any) {
      toast(e.message || "Could not mark as read", "err")
    }
  }

  const markAll = async () => {
    setBusy(true)
    try {
      await rpc("notifications.read", { all: true })
      toast("All notifications marked read")
      await refreshUnread()
      reload()
    } catch (e: any) { toast(e.message, "err") } finally { setBusy(false) }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Notification Center"
        subtitle={`${items.length} notification${items.length === 1 ? "" : "s"} · ${unreadCount} unread`}
        actions={
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="outline" className="h-8 text-xs bg-white dark:bg-slate-900" onClick={() => { reload(); refreshUnread() }}>
              <RefreshCw className="h-3.5 w-3.5 mr-1 text-emerald-600" /> Refresh
            </Button>
            {unreadCount > 0 && (
              <Button size="sm" className="h-8 text-xs " onClick={markAll} disabled={busy}>
                <CheckCheck className="h-3.5 w-3.5 mr-1" /> {busy ? "Working…" : "Mark all read"}
              </Button>
            )}
          </div>
        }
      />

      {/* filter chips */}
      <PushSettingsCard onToast={toast} />

      <div className="flex flex-wrap gap-1.5">
        <Chip active={filter === "ALL"} onClick={() => setFilter("ALL")} label="All" count={items.length} />
        <Chip active={filter === "UNREAD"} onClick={() => setFilter("UNREAD")} label="Unread" count={unreadCount} />
        {types.map((t) => (
          <Chip key={t} active={filter === t} onClick={() => setFilter(t)} label={titleCase(t)}
            count={items.filter((n) => n.type === t).length} icon={TYPE_ICONS[t]} />
        ))}
      </div>

      {loading && <div className="rounded-xl border bg-white dark:bg-slate-900 p-6 text-center text-sm text-slate-400">Loading notifications…</div>}
      {error && <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{error}</div>}

      {!loading && !error && filtered.length === 0 && (
        <div className="rounded-xl border border-dashed bg-white dark:bg-slate-900">
          <div className="py-14 text-center">
            <Inbox className="h-10 w-10 text-slate-300 dark:text-slate-600 mx-auto mb-3" />
            <p className="text-sm font-medium text-slate-500 dark:text-slate-400">
              {filter === "UNREAD" ? "You're all caught up" : "No notifications"}
            </p>
            <p className="text-xs text-slate-400 mt-1">
              {filter === "UNREAD" ? "Unread items will appear here as HR events happen." : "Try a different filter."}
            </p>
          </div>
        </div>
      )}

      <div className="space-y-2 max-h-[70vh] overflow-y-auto pr-1">
        {filtered.map((n) => {
          const Icon = TYPE_ICONS[n.type] || Bell
          const tone = TYPE_TONES[n.type] || "bg-slate-100 dark:bg-slate-800 text-slate-500"
          const unread = !n.readAt
          return (
            <button key={n.id} onClick={() => open(n)}
              className={`w-full text-left rounded-xl border p-3.5 flex items-start gap-3 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/60 ${unread ? "border-emerald-200 dark:border-emerald-900 bg-white dark:bg-slate-900" : "border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/60 opacity-75"}`}>
              <span className={`h-9 w-9 rounded-lg flex items-center justify-center shrink-0 ${tone}`}>
                <Icon className="h-4.5 w-4.5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className={`text-sm truncate ${unread ? "font-bold text-slate-800 dark:text-slate-100" : "font-medium text-slate-600 dark:text-slate-300"}`}>{n.title}</p>
                  {unread && <span className="h-2 w-2 rounded-full bg-emerald-500 shrink-0" title="unread" />}
                  {n.type && <Badge variant="outline" className="text-[9px] ml-auto shrink-0 hidden sm:inline-flex">{titleCase(n.type)}</Badge>}
                </div>
                <p className={`text-xs mt-0.5 break-words ${unread ? "text-slate-600 dark:text-slate-300" : "text-slate-400"}`}>{n.message}</p>
                <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-1 tabular-nums">{fmtDateTime(n.createdAt)}{n.link ? " · tap to open" : ""}</p>
              </div>
              {n.link && <ChevronRight className="h-4 w-4 text-slate-300 shrink-0 mt-1.5" />}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function Chip({ active, onClick, label, count, icon: Icon }: { active: boolean; onClick: () => void; label: string; count: number; icon?: any }) {
  return (
    <button onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${active ? "bg-primary text-primary-foreground" : "bg-white dark:bg-slate-900 border text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"}`}>
      {Icon && <Icon className="h-3.5 w-3.5" />}
      {label}
      <span className={`text-[10px] font-bold tabular-nums rounded-full px-1.5 ${active ? "bg-white/20" : "bg-slate-100 dark:bg-slate-800"}`}>{count}</span>
    </button>
  )
}

// ================= P6 WS-C — Web Push device card =================
function PushSettingsCard({ onToast }: { onToast: (msg: string, kind?: "ok" | "err") => void }) {
  const { data: keyInfo } = useApi<any>("push.publicKey")
  const { data: listData, reload } = useApi<any>("push.list")
  const [busy, setBusy] = useState<"" | "enable" | "test" | "remove">("")
  const [permission, setPermission] = useState<string>("default")

  const supported = typeof window !== "undefined"
    && "serviceWorker" in navigator
    && "PushManager" in window
    && "Notification" in window

  useEffect(() => {
    if (typeof window !== "undefined" && "Notification" in window) setPermission(Notification.permission)
  }, [])

  const devices: any[] = listData?.items || []

  const enable = useCallback(async () => {
    if (!supported) return
    setBusy("enable")
    try {
      const perm = await Notification.requestPermission()
      setPermission(perm)
      if (perm !== "granted") throw new Error("Notification permission was not granted")
      const key = await rpc<any>("push.publicKey")
      if (!key?.publicKey) throw new Error("Push is not configured on this deployment (HRM_MFA_KEY / HRM_PUSH_KEY)")
      const reg = await navigator.serviceWorker.ready
      // applicationServerKey accepts base64url; normalize padding for browsers
      // that demand strict base64
      const b64 = key.publicKey.replace(/-/g, "+").replace(/_/g, "/")
      const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4)
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: padded,
      })
      const json = sub.toJSON() as any
      await rpc("push.subscribe", {
        endpoint: json.endpoint,
        keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
        platform: "pwa",
      })
      onToast("Push notifications enabled on this device")
      reload()
    } catch (e: any) {
      onToast(e?.message || "Could not enable push notifications", "err")
    } finally {
      setBusy("")
    }
  }, [supported, onToast, reload])

  const test = useCallback(async () => {
    setBusy("test")
    try {
      const r = await rpc<any>("push.test")
      onToast(r?.sent ? `Test push sent to ${r.sent} device(s)` : "No registered device to send to")
    } catch (e: any) {
      onToast(e?.message || "Test push failed", "err")
    } finally {
      setBusy("")
    }
  }, [onToast])

  const remove = useCallback(async (id: string) => {
    setBusy("remove")
    try {
      await rpc("push.unsubscribe", { id })
      onToast("Device removed")
      reload()
    } catch (e: any) {
      onToast(e?.message || "Could not remove the device", "err")
    } finally {
      setBusy("")
    }
  }, [onToast, reload])

  if (!supported) return null

  return (
    <div className="rounded-xl border border-teal-200 dark:border-teal-900 bg-gradient-to-r from-teal-50/70 to-cyan-50/50 dark:from-teal-950/40 dark:to-cyan-950/30 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <span className="h-9 w-9 rounded-lg bg-teal-100 dark:bg-teal-900/60 text-teal-600 dark:text-teal-300 flex items-center justify-center shrink-0">
            <BellRing className="h-4.5 w-4.5" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Push notifications</p>
            <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">
              Punch confirmations and approval decisions delivered to this device — even with the app closed.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {permission === "granted" && devices.length > 0 ? (
            <>
              <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 text-[10px]">
                <Smartphone className="h-3 w-3 mr-1" /> enabled on {devices.length} device{devices.length === 1 ? "" : "s"}
              </Badge>
              <Button size="sm" variant="outline" className="h-8 text-xs bg-white dark:bg-slate-900" onClick={test} disabled={!!busy}>
                {busy === "test" ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Send className="h-3.5 w-3.5 mr-1 text-teal-600" />}
                Send test push
              </Button>
            </>
          ) : (
            <Button size="sm" className="h-8 text-xs bg-teal-600 hover:bg-teal-700 text-white" onClick={enable} disabled={busy === "enable"}>
              {busy === "enable" ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <BellRing className="h-3.5 w-3.5 mr-1" />}
              Enable on this device
            </Button>
          )}
        </div>
      </div>
      {permission === "denied" && (
        <p className="text-[11px] text-amber-700 dark:text-amber-400 mt-2">
          Notification permission is blocked for this site — re-enable it in your browser&apos;s site settings to use push.
        </p>
      )}
      {devices.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {devices.map((d: any) => {
            let host = d.endpoint
            try { host = new URL(d.endpoint).host } catch { /* keep raw */ }
            return (
              <div key={d.id} className="flex items-center gap-2 rounded-lg bg-white/70 dark:bg-slate-900/60 border border-teal-100 dark:border-teal-900/50 px-3 py-1.5">
                <Smartphone className="h-3.5 w-3.5 text-teal-600 shrink-0" />
                <span className="text-xs text-slate-700 dark:text-slate-300 truncate">{host}</span>
                <span className="text-[10px] text-slate-400 ml-auto shrink-0">
                  {d.lastErrorAt ? `last error ${fmtDateTime(d.lastErrorAt)}` : d.lastSuccessAt ? `ok ${fmtDateTime(d.lastSuccessAt)}` : fmtDateTime(d.createdAt)}
                </span>
                <button type="button" onClick={() => remove(d.id)} disabled={busy === "remove"}
                  className="h-6 w-6 rounded-md inline-flex items-center justify-center text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/50 transition-colors shrink-0" title="Remove this device">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            )
          })}
        </div>
      )}
      {keyInfo && keyInfo.enabled === false && (
        <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-2">
          Push is not configured on this deployment yet — set HRM_MFA_KEY (or HRM_PUSH_KEY) and reload.
        </p>
      )}
    </div>
  )
}
