"use client"
// ============ /owner/media — Media Library 2.0 (Wave 2 WP-Q) ============
// Full owner-console media manager over the upgraded owner.cms.media.* API:
// folder tree sidebar (derived from folder paths), search + tag filter chips,
// grid/list toggle, detail drawer (metadata editors, copy media:<id>/URL,
// variant previews, usage list, guarded delete), duplicate-aware upload and
// the content-hashing backfill banner (submits the MEDIA_BACKFILL job and
// polls the dedupe report). The Website Studio's built-in picker keeps
// working unchanged — every response field it reads is still there.
import { useEffect, useMemo, useRef, useState } from "react"
import {
  AlertTriangle, Check, ChevronDown, ChevronRight, Copy, FileImage, Folder, Hash,
  Image as ImageIcon, Layers, LayoutGrid, List as ListIcon, Loader2, Move, RefreshCw,
  Search, Tag, Trash2, Upload,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { useOwnerApi, ownerRpc } from "@/saas/owner/client"
import { ErrorBanner, Loading, PageHeader, fmtDateTime } from "@/saas/owner/ui"
import { cn } from "@/lib/utils"

// ------------------------------ types ------------------------------

type MediaItem = {
  id: string; name: string; mimeType: string; size: number; createdAt: string; preview: string | null
  folder: string; tags: string[]; alt: string | null
  width: number | null; height: number | null; sizeBytes: number | null
  seoFilename: string | null; hasVariants: boolean; variantCount: number
  hashed: boolean; storage: string; url: string
}

type ListResponse = {
  media: MediaItem[]
  total: number; page: number; pageSize: number; hasMore: boolean
  folders: { folder: string; count: number }[]
  tags: { tag: string; count: number }[]
}

type MediaVariantView = { kind: string; width: number; mime: string; dataUrl: string }

type MediaDetail = MediaItem & { sha256: string | null; variants: MediaVariantView[] }

type UsageRef = { surface: string; id: string | null; label: string; detail?: string }

type DedupeReport = {
  totalMedia: number; pendingBackfill: number
  duplicateGroupCount: number
  duplicateGroups: { sha256: string; count: number; items: { id: string; name: string; folder: string; createdAt: string }[] }[]
  lastBackfillJob: { id: string; status: string; progress: number; total: number; createdAt: string; finishedAt: string | null; error: string | null } | null
}

const PAGE_SIZE = 60

// ------------------------------ helpers ------------------------------

function fmtBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "—"
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

function fmtDims(m: { width: number | null; height: number | null }): string {
  return m.width && m.height ? `${m.width}×${m.height}` : "—"
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement("textarea")
    ta.value = text
    ta.style.position = "fixed"
    ta.style.opacity = "0"
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand("copy")
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error("Could not read the file"))
    reader.readAsDataURL(file)
  })
}

type FolderNode = { path: string; label: string; count: number; children: FolderNode[] }

/** Derive the folder tree from the flat {path, count} facet list. */
function buildFolderTree(folders: { folder: string; count: number }[], total: number): FolderNode[] {
  const root: FolderNode = { path: "", label: "All media", count: total, children: [] }
  let rootNode: FolderNode | null = null
  for (const f of folders) {
    if (!f.folder) {
      rootNode = { path: "", label: "(Root)", count: f.count, children: [] }
      continue
    }
    let node = root
    let path = ""
    for (const seg of f.folder.split("/")) {
      path = path ? `${path}/${seg}` : seg
      let child = node.children.find((c) => c.label === seg && c.path === path)
      if (!child) {
        child = { path, label: seg, count: 0, children: [] }
        node.children.push(child)
      }
      node = child
    }
    node.count += f.count
  }
  const sortTree = (n: FolderNode) => {
    n.children.sort((a, b) => a.label.localeCompare(b.label))
    n.children.forEach(sortTree)
  }
  sortTree(root)
  if (rootNode && rootNode.count > 0) root.children.unshift(rootNode)
  return root.children
}

// ------------------------------ page ------------------------------

export default function OwnerMediaPage() {
  // filters
  const [folder, setFolder] = useState<string | null>(null) // null = All media, "" = root, "a/b" = folder
  const [tag, setTag] = useState<string | null>(null)
  const [qInput, setQInput] = useState("")
  const [q, setQ] = useState("")
  const [page, setPage] = useState(1)
  const [view, setView] = useState<"grid" | "list">("grid")

  // debounce the search box (350 ms) so typing does not hammer the API
  useEffect(() => {
    const t = setTimeout(() => { setQ(qInput.trim()); setPage(1) }, 350)
    return () => clearTimeout(t)
  }, [qInput])

  const listPayload = useMemo(() => {
    const p: Record<string, unknown> = { page, pageSize: PAGE_SIZE }
    if (folder !== null) p.folder = folder
    if (tag) p.tag = tag
    if (q) p.q = q
    return p
  }, [folder, tag, q, page])

  const list = useOwnerApi<ListResponse>("owner.cms.media.list", listPayload, [listPayload])
  const me = useOwnerApi<{ owner: { permissions: string[] } }>("owner.auth.me", {})
  const canManage = useMemo(() => !!me.data?.owner?.permissions?.includes("cms.manage"), [me.data])

  // dedupe report (pollable while the backfill job runs)
  const [dedupe, setDedupe] = useState<DedupeReport | null>(null)
  const [dedupeErr, setDedupeErr] = useState<string | null>(null)
  const [polling, setPolling] = useState(false)
  const [backfillBusy, setBackfillBusy] = useState(false)

  const fetchDedupe = async () => {
    try {
      setDedupe(await ownerRpc<DedupeReport>("owner.cms.media.dedupeReport"))
      setDedupeErr(null)
    } catch (e: unknown) {
      setDedupeErr((e as Error)?.message || "Could not load the library health report")
    }
  }
  useEffect(() => { void fetchDedupe() }, [])

  // poll the dedupe report while the MEDIA_BACKFILL job is in flight — the
  // report re-queries the pending count AND carries the job's progress
  const jobStatus = dedupe?.lastBackfillJob?.status
  useEffect(() => {
    if (!polling) return
    const t = setInterval(() => { void fetchDedupe() }, 3000)
    return () => clearInterval(t)
  }, [polling])
  // stop polling + reload the library as soon as the job leaves the active set
  useEffect(() => {
    if (polling && jobStatus && jobStatus !== "PENDING" && jobStatus !== "RUNNING") {
      setPolling(false)
      void list.reload()
    }
  }, [jobStatus, polling])

  const runBackfill = async () => {
    setBackfillBusy(true)
    try {
      const res = await ownerRpc<{ jobId: string | null; alreadyRunning?: boolean; skipped?: string }>("owner.cms.media.backfill", {})
      if (res.jobId || res.skipped) await fetchDedupe()
      if (res.jobId) setPolling(true)
    } catch (e: unknown) {
      setDedupeErr((e as Error)?.message || "Could not submit the enrichment job")
    } finally {
      setBackfillBusy(false)
    }
  }

  // upload
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploadBusy, setUploadBusy] = useState(false)
  const [uploadErr, setUploadErr] = useState<string | null>(null)
  const [dupNotice, setDupNotice] = useState<{ existingId: string; existingName: string; uploadedName: string } | null>(null)

  // detail drawer
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const upload = async (file: File) => {
    setUploadBusy(true); setUploadErr(null); setDupNotice(null)
    try {
      const dataUrl = await readAsDataUrl(file)
      const res = await ownerRpc<{ duplicate?: boolean; existingId?: string; existingName?: string }>("owner.cms.media.upload", {
        name: file.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 80) || "image",
        dataUrl,
        folder: folder ?? "",
      })
      if (res.duplicate && res.existingId && res.existingName) {
        setDupNotice({ existingId: res.existingId, existingName: res.existingName, uploadedName: file.name })
      }
      await list.reload()
      void fetchDedupe()
    } catch (e: unknown) {
      setUploadErr((e as Error)?.message || "Upload failed")
    } finally {
      setUploadBusy(false)
    }
  }

  const job = dedupe?.lastBackfillJob
  const jobActive = job ? job.status === "PENDING" || job.status === "RUNNING" : false
  const folders = list.data?.folders ?? []
  const tagFacets = list.data?.tags ?? []
  const tree = useMemo(() => buildFolderTree(folders, list.data?.total ?? 0), [folders, list.data?.total])
  const media = list.data?.media ?? []

  return (
    <div className="space-y-5">
      <PageHeader
        title="Media Library"
        sub="Every image the public website renders — logos, favicons, page and client imagery. PNG/JPEG/WebP/SVG/ICO up to 400 KB; duplicates are detected by content hash and rejected."
        actions={canManage ? (
          <>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml,image/x-icon,image/vnd.microsoft.icon,image/ico"
              className="hidden"
              aria-label="Upload an image to the media library"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = "" }}
            />
            <Button size="sm" onClick={() => fileRef.current?.click()} disabled={uploadBusy}
              className="h-9 bg-gradient-to-r from-blue-600 to-violet-600 text-white light:text-slate-900 hover:from-blue-500 hover:to-violet-500">
              {uploadBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} Upload image
            </Button>
          </>
        ) : null}
      />

      {/* backfill banner — legacy rows that predate content hashing */}
      {(dedupe?.pendingBackfill ?? 0) > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl border border-amber-400/30 bg-amber-500/10 p-4">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
          <p className="min-w-0 flex-1 text-sm text-amber-200 light:text-amber-800">
            <span className="font-bold">{dedupe?.pendingBackfill} media item{dedupe?.pendingBackfill === 1 ? "" : "s"}</span>{" "}
            predate content hashing — duplicate detection and dimensions are missing for {dedupe?.pendingBackfill === 1 ? "it" : "them"}.
          </p>
          {canManage && !jobActive && (
            <Button size="sm" onClick={runBackfill} disabled={backfillBusy}
              className="h-9 border border-amber-400/40 bg-amber-500/20 text-amber-200 light:text-amber-900 hover:bg-amber-500/30">
              {backfillBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Hash className="h-3.5 w-3.5" />} Run the enrichment job
            </Button>
          )}
          {jobActive && (
            <span className="flex items-center gap-2 text-xs text-amber-200 light:text-amber-800">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Enriching {job ? `${job.progress}/${job.total || dedupe?.pendingBackfill}` : "…"} — refreshing every 3 s
            </span>
          )}
        </div>
      )}
      {polling && !jobActive && (
        <div className="flex items-center gap-2 rounded-2xl border border-emerald-400/30 bg-emerald-500/10 p-4 text-sm text-emerald-300 light:text-emerald-700">
          <Check className="h-4 w-4" /> Enrichment job finished — library reloaded.
        </div>
      )}
      {job && (job.status === "FAILED" || job.status === "DEAD") && (
        <div className="rounded-2xl border border-rose-400/30 bg-rose-500/10 p-4 text-sm text-rose-300 light:text-rose-700">
          The last enrichment job ended <span className="font-bold">{job.status}</span>
          {job.error ? ` — ${job.error}` : "."} You can try running it again.
        </div>
      )}

      {/* duplicate warning — the server rejected an identical upload */}
      {dupNotice && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-amber-400/30 bg-amber-500/10 p-4">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
          <p className="min-w-0 flex-1 text-sm text-amber-200 light:text-amber-800">
            “{dupNotice.uploadedName}” <span className="font-bold">already exists as “{dupNotice.existingName}”</span> — identical content, the upload was rejected.
          </p>
          <Button size="sm" variant="outline" onClick={() => { setSelectedId(dupNotice.existingId); setDupNotice(null) }}
            className="h-8 border-amber-400/40 text-amber-200 light:text-amber-800 hover:bg-amber-500/10">Show it →</Button>
          <Button size="sm" variant="ghost" onClick={() => setDupNotice(null)} className="h-8 text-slate-500">Dismiss</Button>
        </div>
      )}

      {uploadErr && <ErrorBanner message={uploadErr} />}
      {list.error && <ErrorBanner message={list.error} />}

      <div className="grid gap-4 lg:grid-cols-[230px_minmax(0,1fr)]">
        {/* ---------------- sidebar: folder tree + library health ---------------- */}
        <aside className="space-y-4">
          <nav aria-label="Media folders" className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-white p-3 light:shadow-sm">
            <p className="mb-2 px-1 text-[10px] font-bold uppercase tracking-widest text-slate-500">Folders</p>
            <div className="max-h-72 overflow-y-auto scroll-thin pr-1">
              <FolderTree nodes={tree} selected={folder} onSelect={(path) => { setFolder(path); setPage(1) }} />
            </div>
          </nav>

          {/* library health — from the dedupe report */}
          <section className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-white p-3 light:shadow-sm">
            <p className="mb-2 px-1 text-[10px] font-bold uppercase tracking-widest text-slate-500">Library health</p>
            {dedupeErr && <p className="px-1 text-[11px] text-red-400 light:text-red-600">{dedupeErr}</p>}
            <div className="space-y-1.5 px-1 text-[12px]">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-slate-400 light:text-slate-600"><FileImage className="h-3.5 w-3.5" /> Items</span>
                <span className="font-bold tabular-nums text-white light:text-slate-900">{dedupe?.totalMedia ?? "—"}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-slate-400 light:text-slate-600"><Hash className="h-3.5 w-3.5" /> Unhashed</span>
                <span className={cn("font-bold tabular-nums", (dedupe?.pendingBackfill ?? 0) > 0 ? "text-amber-400 light:text-amber-700" : "text-white light:text-slate-900")}>
                  {dedupe?.pendingBackfill ?? "—"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-slate-400 light:text-slate-600"><Layers className="h-3.5 w-3.5" /> Duplicate groups</span>
                <span className={cn("font-bold tabular-nums", (dedupe?.duplicateGroupCount ?? 0) > 0 ? "text-amber-400 light:text-amber-700" : "text-white light:text-slate-900")}>
                  {dedupe?.duplicateGroupCount ?? "—"}
                </span>
              </div>
            </div>
            {(dedupe?.duplicateGroups.length ?? 0) > 0 && (
              <Collapsible className="mt-2">
                <CollapsibleTrigger className="flex w-full items-center gap-1 rounded-lg px-1 py-1 text-left text-[11px] font-semibold text-slate-400 light:text-slate-600 hover:bg-white/5 light:hover:bg-slate-100">
                  <ChevronRight className="h-3 w-3 transition-transform data-[state=open]:rotate-90" /> Show duplicate groups
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="mt-1 max-h-64 space-y-1.5 overflow-y-auto scroll-thin px-1">
                    {dedupe?.duplicateGroups.map((g) => (
                      <div key={g.sha256} className="rounded-lg border border-white/10 light:border-slate-200 p-2">
                        <p className="truncate font-mono text-[10px] text-slate-500" title={g.sha256}>sha256 {g.sha256.slice(0, 16)}…</p>
                        {g.items.map((it) => (
                          <button key={it.id} type="button" onClick={() => setSelectedId(it.id)}
                            className="mt-0.5 flex w-full items-center justify-between gap-2 rounded px-1 py-0.5 text-left text-[11px] text-slate-300 light:text-slate-700 hover:bg-white/5 light:hover:bg-slate-100">
                            <span className="truncate">{it.name}</span>
                            <span className="shrink-0 text-[10px] text-slate-500">{it.folder || "(root)"}</span>
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )}
          </section>
        </aside>

        {/* ---------------- main: toolbar + grid/list ---------------- */}
        <section className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1 sm:max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
              <Input
                value={qInput}
                onChange={(e) => setQInput(e.target.value)}
                placeholder="Search name, alt text, filename…"
                aria-label="Search media"
                className="h-9 pl-9 border-white/10 light:border-slate-200 bg-white/5 light:bg-white text-white light:text-slate-900"
              />
            </div>
            <div className="flex items-center rounded-lg border border-white/10 light:border-slate-200 p-0.5" role="group" aria-label="View mode">
              <button type="button" aria-label="Grid view" aria-pressed={view === "grid"} onClick={() => setView("grid")}
                className={cn("rounded-md p-1.5", view === "grid" ? "bg-white/10 text-white light:bg-slate-200 light:text-slate-900" : "text-slate-500 hover:text-white light:hover:text-slate-900")}>
                <LayoutGrid className="h-4 w-4" />
              </button>
              <button type="button" aria-label="List view" aria-pressed={view === "list"} onClick={() => setView("list")}
                className={cn("rounded-md p-1.5", view === "list" ? "bg-white/10 text-white light:bg-slate-200 light:text-slate-900" : "text-slate-500 hover:text-white light:hover:text-slate-900")}>
                <ListIcon className="h-4 w-4" />
              </button>
            </div>
            <Button size="sm" variant="outline" onClick={() => { void list.reload(); void fetchDedupe() }} disabled={list.loading}
              className="h-9 border-white/10 light:border-slate-300 bg-white/5 light:bg-white text-white light:text-slate-900">
              {list.loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Refresh
            </Button>
          </div>

          {/* tag filter chips */}
          {tagFacets.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <Tag className="h-3 w-3 text-slate-500" aria-hidden />
              {tagFacets.map((t) => (
                <button key={t.tag} type="button" aria-pressed={tag === t.tag} onClick={() => { setTag(tag === t.tag ? null : t.tag); setPage(1) }}
                  className={cn(
                    "rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition-colors",
                    tag === t.tag
                      ? "border-indigo-400/50 bg-indigo-500/20 text-indigo-200 light:border-indigo-400 light:bg-indigo-100 light:text-indigo-800"
                      : "border-white/10 light:border-slate-200 text-slate-400 light:text-slate-600 hover:border-indigo-400/40 hover:text-indigo-200 light:hover:text-indigo-700"
                  )}>
                  {t.tag} <span className="tabular-nums opacity-60">{t.count}</span>
                </button>
              ))}
              {tag && (
                <button type="button" onClick={() => { setTag(null); setPage(1) }} className="text-[11px] text-slate-500 hover:text-red-400 light:hover:text-red-600">
                  clear
                </button>
              )}
            </div>
          )}

          {list.loading && !list.data ? (
            <Loading label="Loading media…" />
          ) : media.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/10 light:border-slate-300 p-10 text-center">
              <ImageIcon className="mx-auto h-8 w-8 text-slate-500" />
              <p className="mt-2 text-sm font-semibold text-white light:text-slate-900">No media here yet</p>
              <p className="mt-1 text-xs text-slate-500">
                {q || tag || folder !== null
                  ? "Nothing matches the current filters — clear them or upload a new image."
                  : "Upload your first image; the Website Studio pickers and media:<id> references use this library."}
              </p>
            </div>
          ) : view === "grid" ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
              {media.map((m) => <MediaCard key={m.id} m={m} onOpen={() => setSelectedId(m.id)} />)}
            </div>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-white light:shadow-sm">
              {media.map((m, i) => <MediaRow key={m.id} m={m} onOpen={() => setSelectedId(m.id)} last={i === media.length - 1} />)}
            </div>
          )}

          {/* pagination */}
          {list.data && list.data.total > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <p className="text-[11px] text-slate-500">
                {list.data.total} item{list.data.total === 1 ? "" : "s"} · page {list.data.page}
                {list.data.total > list.data.pageSize ? ` of ${Math.ceil(list.data.total / list.data.pageSize)}` : ""}
                {folder !== null ? ` · folder ${folder || "(root)"}` : ""}
                {tag ? ` · tag “${tag}”` : ""}
              </p>
              {list.data.total > list.data.pageSize && (
                <div className="flex items-center gap-1.5">
                  <Button size="sm" variant="outline" disabled={page <= 1 || list.loading} onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="h-8 border-white/10 light:border-slate-300 bg-white/5 light:bg-white text-white light:text-slate-900">Previous</Button>
                  <Button size="sm" variant="outline" disabled={!list.data.hasMore || list.loading} onClick={() => setPage((p) => p + 1)}
                    className="h-8 border-white/10 light:border-slate-300 bg-white/5 light:bg-white text-white light:text-slate-900">Next</Button>
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      {/* detail drawer */}
      <MediaDetailDrawer
        mediaId={selectedId}
        folders={folders.map((f) => f.folder).filter(Boolean)}
        canManage={canManage}
        onClose={() => setSelectedId(null)}
        onSaved={() => { void list.reload(); void fetchDedupe() }}
        onDeleted={() => { setSelectedId(null); void list.reload(); void fetchDedupe() }}
      />
    </div>
  )
}

// ------------------------------ folder tree ------------------------------

function FolderTree({ nodes, selected, onSelect, depth = 0 }: {
  nodes: FolderNode[]
  selected: string | null
  onSelect: (path: string | null) => void
  depth?: number
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  return (
    <ul className="space-y-0.5">
      {nodes.map((n) => {
        const hasChildren = n.children.length > 0
        const isSelected = selected === n.path
        const open = expanded[n.path] ?? depth < 1
        return (
          <li key={`${n.path}/${n.label}`}>
            <div className="flex items-center">
              {hasChildren ? (
                <button type="button" aria-label={open ? `Collapse ${n.label}` : `Expand ${n.label}`} onClick={() => setExpanded((e) => ({ ...e, [n.path]: !open }))}
                  className="rounded p-0.5 text-slate-500 hover:bg-white/5 light:hover:bg-slate-100 hover:text-white light:hover:text-slate-900">
                  {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                </button>
              ) : (
                <span className="w-[18px] shrink-0" aria-hidden />
              )}
              <button type="button" onClick={() => onSelect(n.path)}
                aria-current={isSelected ? "true" : undefined}
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] font-medium transition-colors",
                  isSelected
                    ? "bg-gradient-to-r from-blue-600/90 to-violet-600/90 text-white light:text-slate-900"
                    : "text-slate-400 light:text-slate-600 hover:bg-white/5 light:hover:bg-slate-100 hover:text-white light:hover:text-slate-900"
                )}>
                {n.label === "(Root)" ? <ImageIcon className="h-3.5 w-3.5 shrink-0" /> : <Folder className="h-3.5 w-3.5 shrink-0" />}
                <span className="truncate">{n.label}</span>
                <span className="ml-auto shrink-0 tabular-nums text-[10px] text-slate-500">{n.count}</span>
              </button>
            </div>
            {hasChildren && open && (
              <div className="ml-3 border-l border-white/10 light:border-slate-200 pl-1">
                <FolderTree nodes={n.children} selected={selected} onSelect={onSelect} depth={depth + 1} />
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

// ------------------------------ grid card / list row ------------------------------

function MediaCard({ m, onOpen }: { m: MediaItem; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} aria-label={`Open ${m.name} details`}
      className="group overflow-hidden rounded-xl border border-white/10 light:border-slate-200 bg-white/[0.02] light:bg-slate-50 text-left transition-colors hover:border-indigo-400/40 light:hover:border-indigo-500/50">
      <div className="flex h-28 items-center justify-center bg-slate-900/60 light:bg-white">
        {m.preview ? (
          <img src={m.preview} alt={m.alt ?? m.name} loading="lazy" className="h-full w-full object-contain p-2" />
        ) : (
          <span className="px-2 text-center text-[10px] text-slate-500">{m.mimeType}</span>
        )}
      </div>
      <div className="p-2">
        <p className="truncate text-[11px] font-semibold text-white light:text-slate-900">{m.name}</p>
        <p className="mt-0.5 truncate text-[10px] text-slate-500">
          {fmtDims(m)} · {fmtBytes(m.sizeBytes ?? m.size)}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {m.folder && <span className="max-w-[90px] truncate rounded-full border border-white/10 light:border-slate-200 px-1.5 py-px text-[9px] text-slate-400 light:text-slate-600">{m.folder}</span>}
          {m.hasVariants && (
            <span className="inline-flex items-center gap-0.5 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-1.5 py-px text-[9px] font-semibold text-emerald-300 light:text-emerald-700">
              <Layers className="h-2.5 w-2.5" /> {m.variantCount}
            </span>
          )}
          {!m.hashed && (
            <span className="inline-flex items-center rounded-full border border-amber-400/30 bg-amber-500/10 px-1.5 py-px text-[9px] font-semibold text-amber-300 light:text-amber-700" title="Pre-dates content hashing — run the enrichment job">
              <Hash className="h-2.5 w-2.5" />
            </span>
          )}
          {m.storage === "external" && <span className="rounded-full border border-sky-400/30 bg-sky-500/10 px-1.5 py-px text-[9px] text-sky-300 light:text-sky-700">s3</span>}
        </div>
      </div>
    </button>
  )
}

function MediaRow({ m, onOpen, last }: { m: MediaItem; onOpen: () => void; last: boolean }) {
  return (
    <button type="button" onClick={onOpen} aria-label={`Open ${m.name} details`}
      className={cn("flex w-full items-center gap-3 p-2.5 text-left transition-colors hover:bg-white/[0.04] light:hover:bg-slate-100", !last && "border-b border-white/5 light:border-slate-100")}>
      <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-slate-900/60 light:bg-white">
        {m.preview ? <img src={m.preview} alt={m.alt ?? m.name} loading="lazy" className="h-full w-full object-contain p-1" /> : <ImageIcon className="h-4 w-4 text-slate-500" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] font-semibold text-white light:text-slate-900">{m.name}</span>
        <span className="block truncate text-[10px] text-slate-500">
          {fmtDims(m)} · {fmtBytes(m.sizeBytes ?? m.size)} · {m.mimeType.replace("image/", "")}
        </span>
      </span>
      <span className="hidden w-28 shrink-0 truncate text-right text-[10px] text-slate-500 sm:block">{m.folder || "(root)"}</span>
      {m.hasVariants && (
        <span className="hidden items-center gap-0.5 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-1.5 py-px text-[9px] font-semibold text-emerald-300 light:text-emerald-700 sm:inline-flex">
          <Layers className="h-2.5 w-2.5" /> {m.variantCount}
        </span>
      )}
      <span className="shrink-0 text-[10px] tabular-nums text-slate-500">{new Date(m.createdAt).toLocaleDateString()}</span>
    </button>
  )
}

// ------------------------------ detail drawer ------------------------------

function MediaDetailDrawer({ mediaId, folders, canManage, onClose, onSaved, onDeleted }: {
  mediaId: string | null
  folders: string[]
  canManage: boolean
  onClose: () => void
  onSaved: () => void
  onDeleted: () => void
}) {
  const open = mediaId != null
  const [detail, setDetail] = useState<MediaDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [usage, setUsage] = useState<UsageRef[] | null>(null)

  // editor drafts (initialized per load; each saved individually via media.update)
  const [nameDraft, setNameDraft] = useState("")
  const [altDraft, setAltDraft] = useState("")
  const [tagsDraft, setTagsDraft] = useState("")
  const [folderDraft, setFolderDraft] = useState<string>("__keep")
  const [newFolder, setNewFolder] = useState("")
  const [newFolderMode, setNewFolderMode] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [savedNote, setSavedNote] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [deleteErr, setDeleteErr] = useState<string | null>(null)

  const load = async (id: string) => {
    setLoading(true); setError(null); setDeleteErr(null); setSavedNote(null); setUsage(null)
    try {
      const res = await ownerRpc<{ media: MediaDetail }>("owner.cms.media.get", { id })
      setDetail(res.media)
      setNameDraft(res.media.name)
      setAltDraft(res.media.alt ?? "")
      setTagsDraft(res.media.tags.join(", "))
      setFolderDraft("__keep")
      setNewFolder("")
      setNewFolderMode(false)
      ownerRpc<{ usage: UsageRef[] }>("owner.cms.media.usage", { id })
        .then((u) => setUsage(u.usage))
        .catch(() => setUsage([]))
    } catch (e: unknown) {
      setError((e as Error)?.message || "Could not load the media item")
      setDetail(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { if (mediaId) void load(mediaId) }, [mediaId])

  const refresh = async () => {
    if (mediaId) await load(mediaId)
    onSaved()
  }

  const save = async (label: string, payload: Record<string, unknown>) => {
    if (!mediaId) return
    setBusy(label); setSavedNote(null); setError(null)
    try {
      await ownerRpc("owner.cms.media.update", { id: mediaId, ...payload })
      setSavedNote(`${label} saved`)
      setTimeout(() => setSavedNote(null), 4000)
      await refresh()
    } catch (e: unknown) {
      setError((e as Error)?.message || `Could not save ${label.toLowerCase()}`)
    } finally {
      setBusy(null)
    }
  }

  const copy = async (label: string, text: string) => {
    const ok = await copyText(text)
    if (ok) {
      setCopied(label)
      setTimeout(() => setCopied(null), 2000)
    }
  }

  const remove = async () => {
    if (!mediaId || !detail) return
    setDeleteErr(null)
    if (usage && usage.length > 0) return // guarded — the button is disabled; belt-and-braces
    if (!window.confirm(`Delete “${detail.name}”? This cannot be undone.`)) return
    setBusy("delete")
    try {
      await ownerRpc("owner.cms.media.delete", { id: mediaId })
      onDeleted()
    } catch (e: unknown) {
      setDeleteErr((e as Error)?.message || "Delete failed")
    } finally {
      setBusy(null)
    }
  }

  const usageCount = usage?.length ?? 0

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <SheetContent side="right" className="w-full overflow-y-auto scroll-thin border-white/10 light:border-slate-200 bg-slate-950 light:bg-slate-50 sm:max-w-lg">
        <SheetHeader className="pb-0">
          <SheetTitle className="text-white light:text-slate-900">Media details</SheetTitle>
        </SheetHeader>
        <div className="space-y-4 px-4 pb-6">
          {loading && <Loading label="Loading media…" />}
          {error && <p className="rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-300 light:text-red-600">{error}</p>}
          {savedNote && <p className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 p-3 text-sm text-emerald-300 light:text-emerald-700">{savedNote}</p>}

          {detail && (
            <>
              {/* preview */}
              <div className="flex items-center justify-center overflow-hidden rounded-xl border border-white/10 light:border-slate-200 bg-slate-900/60 light:bg-white p-3">
                <img src={detail.url} alt={detail.alt ?? detail.name} className="max-h-56 w-auto object-contain" />
              </div>

              {/* copy references */}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => copy("reference", `media:${detail.id}`)}
                  className="h-8 border-white/10 light:border-slate-300 bg-white/5 light:bg-white text-white light:text-slate-900">
                  {copied === "reference" ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />} Copy media:&lt;id&gt;
                </Button>
                <Button size="sm" variant="outline" onClick={() => copy("url", detail.url)}
                  className="h-8 border-white/10 light:border-slate-300 bg-white/5 light:bg-white text-white light:text-slate-900">
                  {copied === "url" ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />} Copy {detail.storage === "external" ? "public URL" : "data URL"}
                </Button>
                {detail.sha256 && (
                  <Button size="sm" variant="outline" onClick={() => copy("sha", detail.sha256 ?? "")} title={detail.sha256 ?? undefined}
                    className="h-8 border-white/10 light:border-slate-300 bg-white/5 light:bg-white text-white light:text-slate-900">
                    {copied === "sha" ? <Check className="h-3 w-3 text-emerald-400" /> : <Hash className="h-3 w-3" />} sha256 {detail.sha256.slice(0, 8)}…
                  </Button>
                )}
              </div>

              {/* editable metadata */}
              {canManage && (
                <div className="space-y-3 rounded-xl border border-white/10 light:border-slate-200 bg-white/[0.02] light:bg-slate-50 p-3">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Metadata</p>
                  <div>
                    <Label htmlFor="media-name" className="text-xs text-slate-400 light:text-slate-600">Name</Label>
                    <div className="mt-1 flex gap-2">
                      <Input id="media-name" value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} maxLength={160}
                        className="h-9 border-white/10 light:border-slate-200 bg-white/5 light:bg-white text-white light:text-slate-900" />
                      <Button size="sm" disabled={busy !== null || !nameDraft.trim() || nameDraft === detail.name} onClick={() => save("Name", { name: nameDraft.trim() })}
                        className="h-9 shrink-0 bg-white/10 light:bg-slate-900 text-white light:text-white hover:bg-white/20 light:hover:bg-slate-800">
                        {busy === "Name" ? <Loader2 className="h-3 w-3 animate-spin" /> : "Rename"}
                      </Button>
                    </div>
                    <p className="mt-1 text-[10px] text-slate-500">Renaming regenerates the SEO filename in this folder.</p>
                  </div>
                  <div>
                    <Label htmlFor="media-alt" className="text-xs text-slate-400 light:text-slate-600">Alt text (accessibility & SEO)</Label>
                    <div className="mt-1 flex gap-2">
                      <Input id="media-alt" value={altDraft} onChange={(e) => setAltDraft(e.target.value)} maxLength={500} placeholder="Describe the image…"
                        className="h-9 border-white/10 light:border-slate-200 bg-white/5 light:bg-white text-white light:text-slate-900" />
                      <Button size="sm" disabled={busy !== null || altDraft === (detail.alt ?? "")} onClick={() => save("Alt text", { alt: altDraft })}
                        className="h-9 shrink-0 bg-white/10 light:bg-slate-900 text-white light:text-white hover:bg-white/20 light:hover:bg-slate-800">
                        {busy === "Alt text" ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
                      </Button>
                    </div>
                  </div>
                  <div>
                    <Label htmlFor="media-tags" className="text-xs text-slate-400 light:text-slate-600">Tags (comma-separated)</Label>
                    <div className="mt-1 flex gap-2">
                      <Input id="media-tags" value={tagsDraft} onChange={(e) => setTagsDraft(e.target.value)} placeholder="logo, marketing"
                        className="h-9 border-white/10 light:border-slate-200 bg-white/5 light:bg-white text-white light:text-slate-900" />
                      <Button size="sm" disabled={busy !== null} onClick={() => save("Tags", { tags: tagsDraft.split(",").map((t) => t.trim()).filter(Boolean) })}
                        className="h-9 shrink-0 bg-white/10 light:bg-slate-900 text-white light:text-white hover:bg-white/20 light:hover:bg-slate-800">
                        {busy === "Tags" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Tag className="h-3 w-3" />}
                      </Button>
                    </div>
                    <p className="mt-1 text-[10px] text-slate-500">Lowercase letters, digits, spaces and dashes; up to 12 tags.</p>
                  </div>
                  <div>
                    <Label className="text-xs text-slate-400 light:text-slate-600">Folder</Label>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {newFolderMode ? (
                        <>
                          <Input value={newFolder} onChange={(e) => setNewFolder(e.target.value)} placeholder="marketing/2026" aria-label="New folder path"
                            className="h-9 w-44 border-white/10 light:border-slate-200 bg-white/5 light:bg-white text-white light:text-slate-900" />
                          <Button size="sm" disabled={busy !== null || !newFolder.trim()} onClick={() => save("Folder", { folder: newFolder })}
                            className="h-9 shrink-0 bg-white/10 light:bg-slate-900 text-white light:text-white hover:bg-white/20 light:hover:bg-slate-800">
                            {busy === "Folder" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Move className="h-3 w-3" />} Move
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setNewFolderMode(false)} className="h-9 text-slate-500">Cancel</Button>
                        </>
                      ) : (
                        <>
                          <div className="w-44">
                            <Select value={folderDraft} onValueChange={(v) => setFolderDraft(v)} disabled={busy !== null}>
                              <SelectTrigger className="h-9 border-white/10 light:border-slate-200 bg-white/5 light:bg-white text-white light:text-slate-900" aria-label="Move to folder">
                                <SelectValue placeholder={detail.folder || "(root)"} />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="__keep">— keep: {detail.folder || "(root)"} —</SelectItem>
                                <SelectItem value="">(root)</SelectItem>
                                {folders.map((f) => <SelectItem key={f} value={f}>{f}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          </div>
                          <Button size="sm" disabled={busy !== null || folderDraft === "__keep"} onClick={() => save("Folder", { folder: folderDraft })}
                            className="h-9 shrink-0 bg-white/10 light:bg-slate-900 text-white light:text-white hover:bg-white/20 light:hover:bg-slate-800">
                            {busy === "Folder" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Move className="h-3 w-3" />} Move
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => { setNewFolderMode(true); setFolderDraft("__keep") }} className="h-9 text-slate-500">New folder…</Button>
                        </>
                      )}
                    </div>
                    <p className="mt-1 text-[10px] text-slate-500">Paths like “marketing/2026” — up to 6 levels. Moving keeps the media:&lt;id&gt; reference intact.</p>
                  </div>
                </div>
              )}

              {/* read-only metadata */}
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl border border-white/10 light:border-slate-200 bg-white/[0.02] light:bg-slate-50 p-3 text-[11px]">
                <Meta label="MIME type" value={detail.mimeType} />
                <Meta label="Uploaded" value={fmtDateTime(detail.createdAt)} />
                <Meta label="Dimensions" value={fmtDims(detail)} />
                <Meta label="Size" value={`${fmtBytes(detail.sizeBytes ?? detail.size)}${detail.sizeBytes != null && detail.sizeBytes !== detail.size ? ` (legacy ${fmtBytes(detail.size)})` : ""}`} />
                <Meta label="SEO filename" value={detail.seoFilename ?? "—"} mono />
                <Meta label="Storage" value={detail.storage === "external" ? "S3-compatible (public URL)" : "Local (inline data URL)"} />
                <Meta label="Content hash" value={detail.sha256 ? `${detail.sha256.slice(0, 16)}…` : "pending backfill"} mono />
                <Meta label="Folder" value={detail.folder || "(root)"} />
              </dl>

              {/* variants */}
              <div className="rounded-xl border border-white/10 light:border-slate-200 bg-white/[0.02] light:bg-slate-50 p-3">
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Optimized variants</p>
                {detail.variants.length > 0 ? (
                  <div className="mt-2 flex gap-2 overflow-x-auto scroll-thin pb-1">
                    {detail.variants.map((v, i) => (
                      <div key={`${v.kind}-${v.width}-${i}`} className="shrink-0 text-center">
                        <div className="flex h-20 w-28 items-center justify-center overflow-hidden rounded-lg border border-white/10 light:border-slate-200 bg-slate-900/60 light:bg-white">
                          <img src={v.dataUrl} alt={`${v.kind} ${v.width}px variant`} loading="lazy" className="h-full w-full object-contain p-1" />
                        </div>
                        <p className="mt-1 text-[10px] font-semibold text-slate-400 light:text-slate-600">{v.kind.toUpperCase()} · {v.width}w</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
                    No stored variants. AVIF/WebP renditions are generated at upload time for raster images wider than 480 px
                    (SVG, ICO and small images are served as-is). Re-upload the image to regenerate them.
                  </p>
                )}
              </div>

              {/* usage */}
              <div className="rounded-xl border border-white/10 light:border-slate-200 bg-white/[0.02] light:bg-slate-50 p-3">
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                  Usage {usage === null ? "" : `(${usageCount} surface${usageCount === 1 ? "" : "s"})`}
                </p>
                {usage === null ? (
                  <p className="mt-1.5 text-[11px] text-slate-500">Scanning CMS surfaces…</p>
                ) : usage.length === 0 ? (
                  <p className="mt-1.5 text-[11px] text-slate-500">Not referenced by any CMS surface — safe to delete.</p>
                ) : (
                  <ul className="mt-1.5 max-h-44 space-y-1 overflow-y-auto scroll-thin">
                    {usage.map((u, i) => (
                      <li key={`${u.surface}-${u.id ?? i}`} className="rounded-lg border border-white/10 light:border-slate-200 px-2 py-1.5 text-[11px]">
                        <span className="font-semibold text-white light:text-slate-900">{u.label}</span>
                        {u.detail && <span className="ml-1 text-slate-500">· {u.detail}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* delete */}
              {canManage && (
                <div className="space-y-2">
                  {deleteErr && <p className="rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-300 light:text-red-600">{deleteErr}</p>}
                  <Button size="sm" variant="outline" disabled={busy !== null || usage === null || usage.length > 0} onClick={remove}
                    title={usage && usage.length > 0 ? `Referenced by ${usage.length} surface(s) — remove those references first` : "Delete this media item"}
                    className="h-9 w-full border-red-400/30 bg-red-500/10 text-red-400 light:text-red-600 hover:bg-red-500/20">
                    {busy === "delete" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />} Delete media
                  </Button>
                  {usage && usage.length > 0 && (
                    <p className="text-center text-[10px] text-amber-400 light:text-amber-700">
                      Deletion is guarded — this image is referenced by {usage.length} surface(s) listed above.
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function Meta({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-slate-500">{label}</dt>
      <dd className={cn("truncate font-semibold text-white light:text-slate-900", mono && "font-mono text-[10px]")} title={value}>{value}</dd>
    </div>
  )
}
