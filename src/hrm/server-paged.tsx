// ============ Server-paged list hook (Phase 5 P6 WS-B) ============
// The M-11 follow-up: leave/finance/payroll lists gained the MOD-16 optional
// pagination contract ({ items, total, page, pageSize } when page/pageSize is
// passed). This hook drives those endpoints from the tenant SPA — one source
// of truth for page state, the honest total, and the Prev/Next controls, so
// every full-list view converts without re-implementing the plumbing.
//
// Response shape tolerance: the hook accepts BOTH the paged envelope
// ({ items, total, page, pageSize }) and a bare array (an endpoint temporarily
// answered in legacy mode) — rows fall back gracefully, total falls back to
// the row count, and the controls hide when everything fits one page.
import { useCallback, useEffect, useMemo, useState } from "react"
import { useApi } from "./api"

export type PagedEnvelope<T> = {
  items: T[]
  total: number
  page: number
  pageSize: number
}

export function isPagedEnvelope<T>(d: unknown): d is PagedEnvelope<T> {
  return !!d && typeof d === "object" && Array.isArray((d as PagedEnvelope<T>).items)
}

/** Drive a MOD-16 paged RPC action. `baseParams` are the filters (status,
 *  employeeId, year…); the hook appends page/pageSize and refetches on any
 *  change (the useApi payload-key contract). Filter changes rewind to page 1
 *  (the P5 discipline). */
export function useServerPagedList<T = any>(
  action: string,
  baseParams: Record<string, unknown> | undefined,
  pageSize = 50,
) {
  const [page, setPage] = useState(1)
  const baseKey = JSON.stringify(baseParams || {})
  // filters changing always rewinds to the first page — otherwise a stale
  // page number (e.g. page 5 of a now-1-page result) renders an empty table
  useEffect(() => { setPage(1) }, [baseKey])
  const { data, loading, error, reload } = useApi<T[] | PagedEnvelope<T>>(action, {
    ...(baseParams || {}),
    page,
    pageSize,
  })
  const paged = isPagedEnvelope<T>(data)
  const rows: T[] = paged ? data.items : (data as T[]) || []
  const total = paged ? data.total : rows.length
  const maxPage = Math.max(1, Math.ceil(total / pageSize))
  const resetPage = useCallback(() => setPage(1), [])
  return useMemo(
    () => ({
      rows, total, page, pageSize, maxPage,
      paged, loading, error, reload,
      /** the full paged envelope (items/total/page/pageSize + any handler
       *  extras like `summary`), or null when the endpoint answered in
       *  legacy bare-array mode */
      envelope: paged ? (data as PagedEnvelope<T> & Record<string, unknown>) : null,
      setPage,
      /** reset helper for filter changes (call alongside setting the filter) */
      resetPage,
    }),
    [data, rows, total, page, pageSize, maxPage, paged, loading, error, reload, resetPage],
  )
}

/** The P5-style Prev / page x of y / Next controls (tenant-SPA skin). */
export function PagedControls(props: {
  page: number
  maxPage: number
  total: number
  pageSize: number
  onPage: (p: number) => void
  loading?: boolean
}) {
  if (props.total <= props.pageSize) return null
  const from = (props.page - 1) * props.pageSize + 1
  const to = Math.min(props.total, props.page * props.pageSize)
  return (
    <div className="flex items-center justify-between gap-2 pt-1">
      <span className="text-[11px] text-muted-foreground">
        {from.toLocaleString()}–{to.toLocaleString()} of {props.total.toLocaleString()}
      </span>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          disabled={props.page <= 1 || props.loading}
          onClick={() => props.onPage(props.page - 1)}
          className="h-7 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 text-xs text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Previous
        </button>
        <span className="text-[11px] text-muted-foreground tabular-nums px-0.5">
          page {props.page} / {props.maxPage}
        </span>
        <button
          type="button"
          disabled={props.page >= props.maxPage || props.loading}
          onClick={() => props.onPage(props.page + 1)}
          className="h-7 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 text-xs text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Next
        </button>
      </div>
    </div>
  )
}
