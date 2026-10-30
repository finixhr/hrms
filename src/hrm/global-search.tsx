"use client"
// ============ Global Search — navbar trigger + command palette ============
// Additive feature. Static navigation (menus/sub-menus/page tabs) is matched
// client-side from search-index.ts (no database round-trip); employees and
// tasks come from the tenant-scoped, permission-checked `search.global` RPC
// with a debounce. Keyboard: Ctrl/Cmd+K or "/" opens; ↑/↓ move; Enter opens;
// Esc / outside-click closes (Dialog + cmdk behavior).
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import {
  Search, Loader2, ListChecks, CornerDownLeft, UserRound,
} from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  Command, CommandInput, CommandList, CommandGroup, CommandItem, } from "@/components/ui/command"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { useHrm } from "./store"
import { rpc } from "./api"
import { searchStatic } from "./search-index"
import { hiddenModulesOf } from "./module-map"
import { NAV } from "./nav"
import { tr, useLang } from "./i18n"

type EmpHit = {
  id: string; code: string; fullName: string; mobile?: string | null; email?: string | null
  designationName?: string | null; departmentName?: string | null; branchName?: string | null
}
type TaskHit = {
  id: string; title: string; status: string; priority: string; dueDate?: string | null; assigneeName?: string | null
}

const NAV_ICONS: Record<string, any> = Object.fromEntries(NAV.flatMap((g) => g.items.map((it) => [it.key, it.icon])))
const DEBOUNCE_MS = 220
const REMOTE_MIN = 2

// platform probe as a snapshot — hydration-safe (server renders false) and
// lint-clean (no setState-in-effect); the value is stable for the session
const subscribeNoop = () => () => {}
const getIsMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)
const getIsMacServer = () => false

/** Navbar trigger + palette owner. Rendered once in the app-shell header. */
export function GlobalSearch() {
  const [open, setOpen] = useState(false)
  const lang = useLang()
  const isMac = useSyncExternalStore(subscribeNoop, getIsMac, getIsMacServer)

// Global hotkeys: Ctrl/Cmd+K always; plain "/" when not typing in a field
useEffect(() => {
  const onKey = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null
    const tag = target?.tagName

    const typing =
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      target?.isContentEditable

    // Normalize the key safely. Optional chaining prevents
    // runtime errors if e.key is unexpectedly undefined.
    const key = e.key?.toLowerCase()

    if (key === "k" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      setOpen((o) => !o)
    } else if (
      key === "/" &&
      !typing &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey
    ) {
      e.preventDefault()
      setOpen(true)
    }
  }

  window.addEventListener("keydown", onKey)

  return () => {
    window.removeEventListener("keydown", onKey)
  }
}, [])

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label={tr("Search", lang)}
        className="group hidden sm:flex items-center gap-2 h-8 w-44 md:w-60 rounded-md border bg-muted/50 px-2.5 text-left text-muted-foreground hover:bg-background hover:border-primary/40 transition-colors hrm-focus"
      >
        <Search className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="text-xs flex-1 truncate">{tr("Search employees, tasks, menus…", lang)}</span>
        <kbd className="hrm-kbd hidden md:inline-flex">
          {isMac ? "⌘" : "Ctrl"} K
        </kbd>
      </button>
      <button
        onClick={() => setOpen(true)}
        aria-label={tr("Search", lang)}
        className="sm:hidden h-8 w-8 rounded-md hover:bg-accent hover:text-accent-foreground flex items-center justify-center transition-colors hrm-focus"
      >
        <Search className="h-4 w-4 text-muted-foreground" aria-hidden />
      </button>
      <SearchPalette open={open} onOpenChange={setOpen} />
    </>
  )
}

function SearchPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const lang = useLang()
  const user = useHrm((s) => s.user)
  const settings = useHrm((s) => s.settings)
  const navigate = useHrm((s) => s.navigate)
  const can = useHrm((s) => s.can)

  const [query, setQuery] = useState("")
  const [employees, setEmployees] = useState<EmpHit[]>([])
  const [tasks, setTasks] = useState<TaskHit[]>([])
  const [remoteLoading, setRemoteLoading] = useState(false)
  const [remoteError, setRemoteError] = useState<string | null>(null)
  const seq = useRef(0)

  // reset when the palette closes
  useEffect(() => {
    if (!open) {
      setQuery(""); setEmployees([]); setTasks([]); setRemoteError(null); setRemoteLoading(false)
      seq.current++
    }
  }, [open])

  // static search (menus + tabs) — synchronous, client-side only
  const staticOpts = useMemo(() => ({
    can,
    hasEmployeeId: !!user?.employeeId,
    isEmployeeOnly: user?.role === "EMPLOYEE",
    // M-21 — shared resolver (reads modules.disabled, legacy modules.enabled
    // as back-compat — the old code read ONLY the legacy key, so modules
    // hidden by an admin after the rename stayed searchable)
    hiddenModules: hiddenModulesOf(settings),
  }), [can, user, settings])
  const staticHits = useMemo(
    () => searchStatic(query, staticOpts, 8),
    [query, staticOpts],
  )
  const showStatic = query.trim().length >= 1

  // debounced remote search (employees + tasks) with a stale-response guard
  useEffect(() => {
    if (!open) return
    const q = query.trim()
    if (q.length < REMOTE_MIN) { setEmployees([]); setTasks([]); setRemoteLoading(false); setRemoteError(null); return }
    const mySeq = ++seq.current
    setRemoteLoading(true)
    const t = setTimeout(async () => {
      try {
        const d = await rpc<{ employees: EmpHit[]; tasks: TaskHit[] }>("search.global", { q })
        if (seq.current !== mySeq) return // a newer keystroke already answered
        setEmployees(d?.employees || [])
        setTasks(d?.tasks || [])
        setRemoteError(null)
      } catch (e: any) {
        if (seq.current !== mySeq) return
        setEmployees([]); setTasks([]); setRemoteError(e?.message || "Search failed")
      } finally {
        if (seq.current === mySeq) setRemoteLoading(false)
      }
    }, DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query, open])

  const go = useCallback(
    (view: string, params?: Record<string, unknown>) => {
      onOpenChange(false)
      navigate(view, params)
    },
    [navigate, onOpenChange],
  )

  const hasAny =
    (showStatic && (staticHits.menus.length > 0 || staticHits.tabs.length > 0)) ||
    employees.length > 0 || tasks.length > 0
  const q = query.trim()
  const remoteActive = q.length >= REMOTE_MIN

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="sr-only">
          <DialogTitle>{tr("Search", lang)}</DialogTitle>
          <DialogDescription>{tr("Search employees, tasks, menus…", lang)}</DialogDescription>
        </DialogHeader>
        <Command shouldFilter={false} aria-label={tr("Search", lang)} className="[&_[cmdk-group-heading]]:px-3">
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={tr("Search employees, tasks, menus…", lang)}
            aria-label={tr("Search", lang)}
            autoComplete="off" spellCheck={false}
          />
          <CommandList className="max-h-[70vh]">
            {/* ---------- MENUS ---------- */}
            {showStatic && staticHits.menus.length > 0 && (
              <CommandGroup heading={tr("Menus", lang)}>
                {staticHits.menus.map((m) => (
                  <SearchRow key={`m-${m.view}`} icon={NAV_ICONS[m.view] || Search} label={m.label} hint={m.parent}
                    onSelect={() => go(m.view)} />
                ))}
              </CommandGroup>
            )}
            {/* ---------- TABS ---------- */}
            {showStatic && staticHits.tabs.length > 0 && (
              <CommandGroup heading={tr("Tabs", lang)}>
                {staticHits.tabs.map((t) => (
                  <SearchRow key={`t-${t.view}-${t.tab}`} icon={NAV_ICONS[t.view] || Search} label={t.label} hint={t.parent}
                    onSelect={() => go(t.view, { tab: t.tab, ...(t.tpl ? { tpl: t.tpl } : {}) })} />
                ))}
              </CommandGroup>
            )}
            {/* ---------- EMPLOYEES ---------- */}
            {remoteActive && (employees.length > 0 || remoteLoading) && (
              <CommandGroup heading={tr("Employees", lang)}>
                {employees.map((e) => (
                  <CommandItem key={e.id} value={`emp-${e.id}`} onSelect={() => go("employees", { employeeId: e.id })}>
                    <Avatar className="h-7 w-7">
                      <AvatarFallback className="bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 text-[10px] font-bold">
                        {(e.fullName || "?").split(" ").map((x) => x[0]).slice(0, 2).join("").toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{e.fullName}</p>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                        {e.code}
                        {e.designationName ? ` · ${e.designationName}` : ""}
                        {e.departmentName ? ` · ${e.departmentName}` : ""}
                        {e.mobile ? ` · ${e.mobile}` : ""}
                      </p>
                    </div>
                    <UserRound className="h-3.5 w-3.5 text-slate-300 dark:text-slate-600" aria-hidden />
                  </CommandItem>
                ))}
                {employees.length === 0 && remoteLoading && <LoadingRow label={tr("Employees", lang)} lang={lang} />}
              </CommandGroup>
            )}
            {/* ---------- TASKS ---------- */}
            {remoteActive && (tasks.length > 0 || remoteLoading) && (
              <CommandGroup heading={tr("Tasks", lang)}>
                {tasks.map((t) => (
                  <CommandItem key={t.id} value={`task-${t.id}`} onSelect={() => go("tasks", { taskId: t.id })}>
                    <ListChecks className="h-4 w-4 text-slate-400" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{t.title}</p>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                        {t.assigneeName ? `${tr("Tasks", lang)} · ${t.assigneeName}` : tr("Tasks", lang)}
                        {t.status ? ` · ${t.status.replaceAll("_", " ").toLowerCase()}` : ""}
                      </p>
                    </div>
                    <CornerDownLeft className="h-3 w-3 text-slate-300 dark:text-slate-600" aria-hidden />
                  </CommandItem>
                ))}
                {tasks.length === 0 && remoteLoading && <LoadingRow label={tr("Tasks", lang)} lang={lang} />}
              </CommandGroup>
            )}
            {/* ---------- states: error / empty / hint ---------- */}
            {remoteError && remoteActive && (
              <p className="px-4 py-6 text-center text-sm text-rose-600 dark:text-rose-400" role="alert">
                {remoteError}
              </p>
            )}
            {!remoteError && !hasAny && q.length >= REMOTE_MIN && !remoteLoading && (
              <p className="px-4 py-6 text-center text-sm text-slate-500 dark:text-slate-400">
                {tr("No results found", lang)} — &ldquo;{q}&rdquo;
              </p>
            )}
            {!remoteError && !hasAny && q.length > 0 && q.length < REMOTE_MIN && (
              <p className="px-4 py-6 text-center text-xs text-slate-400 dark:text-slate-500">
                {tr("Keep typing to search employees and tasks…", lang)}
              </p>
            )}
            {q.length === 0 && (
              <div className="px-4 py-6 space-y-1.5 text-center">
                <p className="text-xs text-slate-400 dark:text-slate-500">
                  {tr("Menus", lang)} · {tr("Tabs", lang)} · {tr("Employees", lang)} · {tr("Tasks", lang)}
                </p>
                <p className="text-[11px] text-slate-400 dark:text-slate-600">
                  <kbd className="rounded border border-slate-200 dark:border-slate-700 px-1 py-0.5">↑</kbd>{" "}
                  <kbd className="rounded border border-slate-200 dark:border-slate-700 px-1 py-0.5">↓</kbd> · {" "}
                  <kbd className="rounded border border-slate-200 dark:border-slate-700 px-1 py-0.5">{tr("Search", lang)}</kbd> · {" "}
                  <kbd className="rounded border border-slate-200 dark:border-slate-700 px-1 py-0.5">Esc</kbd>
                </p>
              </div>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}

function SearchRow({ icon: Icon, label, hint, onSelect }: { icon: any; label: string; hint?: string; onSelect: () => void }) {
  return (
    <CommandItem value={`${label}-${hint || ""}`} onSelect={onSelect}>
      <Icon className="h-4 w-4 text-slate-400" aria-hidden />
      <span className="text-sm font-medium truncate">{label}</span>
      {hint && <span className="text-[11px] text-slate-400 dark:text-slate-500 truncate ml-1">— {hint}</span>}
    </CommandItem>
  )
}

function LoadingRow({ label, lang }: { label: string; lang: string }) {
  return (
    <div className="flex items-center gap-2 px-2 py-2.5 text-xs text-slate-400" aria-live="polite">
      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      {tr("Searching…", lang as any)} {label}
    </div>
  )
}
