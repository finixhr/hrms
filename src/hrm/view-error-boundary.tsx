"use client"
// ============ View error boundary (2026-10-12) ============
// Last line of defence around the lazily-loaded module views. Previously any
// error thrown while rendering/mounting a view (including a transient
// chunk-load failure) propagated all the way up and unmounted the ENTIRE
// workspace — the "portal randomly crashes, refresh fixes it" report.
//
// Behaviour:
//   · chunk-load errors → trigger healStaleChunk() (guarded reload) and show
//     a restoring state while the reload lands;
//   · any other error → an inline, contained error card with Retry (remount
//     the view) and Reload buttons. The sidebar, header and navigation stay
//     alive, so one broken view never takes the whole portal down.
import { Component, type ReactNode } from "react"
import { AlertTriangle, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { LoadingRows } from "./shared/ui-kit"
import { isChunkLoadError, healStaleChunk } from "./chunk-recovery"

type Props = { children: ReactNode }
type State = { error: Error | null }

export class ViewErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error) {
    // stale chunk (dev recompile / server restart / new deploy) — self-heal
    // exactly like the manual refresh users had to perform, but automatic
    if (isChunkLoadError(error)) healStaleChunk()
  }

  reset = () => this.setState({ error: null })

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    // transient chunk failure — a guarded reload is (or was) in flight
    if (isChunkLoadError(error)) {
      return (
        <div className="space-y-3 py-8">
          <p className="text-sm text-muted-foreground flex items-center gap-2">
            <RefreshCw className="h-4 w-4 animate-spin" />
            A newer version of the app is available — restoring…
          </p>
          <LoadingRows rows={6} />
        </div>
      )
    }

    // genuine view error — contained, with manual recovery affordances
    return (
      <div className="rounded-xl border border-rose-200 dark:border-rose-900 bg-rose-50/70 dark:bg-rose-950/30 p-6 space-y-4">
        <div className="flex items-start gap-3">
          <div className="h-9 w-9 rounded-lg bg-rose-100 dark:bg-rose-900/60 flex items-center justify-center shrink-0">
            <AlertTriangle className="h-4.5 w-4.5 text-rose-600 dark:text-rose-400" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-rose-800 dark:text-rose-200">This page hit an unexpected error</p>
            <p className="text-xs text-rose-700/80 dark:text-rose-300/80 mt-1 break-words">
              {error.message || "Unknown error"}
            </p>
            <p className="text-xs text-muted-foreground mt-2">
              The rest of the workspace is unaffected — retry the page, reload the app, or pick another module from the sidebar.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 pl-12">
          <Button size="sm" variant="outline" className="h-8 text-xs" onClick={this.reset}>
            <RefreshCw className="h-3.5 w-3.5 mr-1" /> Retry
          </Button>
          <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => window.location.reload()}>
            Reload app
          </Button>
        </div>
      </div>
    )
  }
}
