"use client"
// ============ Feature-visual registry ============
// Maps the CMS feature slugs to lazily-loaded visual simulations. Every chunk
// ships with a skeleton that matches the app-window footprint, and ssr:false
// keeps recharts out of the server bundle entirely.
import dynamic from "next/dynamic"
import type { ComponentType } from "react"
import { cn } from "@/lib/utils"

function Skeleton() {
  return (
    <div className="animate-pulse overflow-hidden rounded-2xl border border-white/15 bg-slate-900/95 shadow-2xl shadow-black/50 light:border-slate-200 light:bg-white light:shadow-xl light:shadow-slate-900/10">
      <div className="flex items-center gap-1.5 border-b border-white/10 bg-white/[0.03] px-3 py-2 light:border-slate-200 light:bg-slate-50">
        <span className="h-2.5 w-2.5 rounded-full bg-white/10 light:bg-slate-200" />
        <span className="h-2.5 w-2.5 rounded-full bg-white/10 light:bg-slate-200" />
        <span className="h-2.5 w-2.5 rounded-full bg-white/10 light:bg-slate-200" />
        <span className="ml-2 h-5 w-40 rounded-md bg-white/5 light:bg-slate-100" />
      </div>
      <div className="space-y-2 p-3 sm:p-4">
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4 sm:gap-3">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-16 rounded-xl bg-white/[0.04] light:bg-slate-100" />)}
        </div>
        <div className="grid gap-2 sm:gap-3 lg:grid-cols-3">
          <div className="h-40 rounded-xl bg-white/[0.04] light:bg-slate-100 lg:col-span-2" />
          <div className="h-40 rounded-xl bg-white/[0.04] light:bg-slate-100" />
        </div>
        <div className="h-24 rounded-xl bg-white/[0.04] light:bg-slate-100" />
      </div>
    </div>
  )
}

export const VISUAL_COMPONENTS: Record<string, ComponentType> = {
  dashboard: dynamic(() => import("./dashboard-visual").then((m) => m.DashboardVisual), { loading: Skeleton, ssr: false }),
  employee: dynamic(() => import("./employee-visual").then((m) => m.EmployeeVisual), { loading: Skeleton, ssr: false }),
  attendance: dynamic(() => import("./attendance-visual").then((m) => m.AttendanceVisual), { loading: Skeleton, ssr: false }),
  tracking: dynamic(() => import("./tracking-visual").then((m) => m.TrackingVisual), { loading: Skeleton, ssr: false }),
  payroll: dynamic(() => import("./payroll-visual").then((m) => m.PayrollVisual), { loading: Skeleton, ssr: false }),
  leave: dynamic(() => import("./leave-visual").then((m) => m.LeaveVisual), { loading: Skeleton, ssr: false }),
  device: dynamic(() => import("./device-visual").then((m) => m.DeviceVisual), { loading: Skeleton, ssr: false }),
  performance: dynamic(() => import("./performance-visual").then((m) => m.PerformanceVisual), { loading: Skeleton, ssr: false }),
  inventory: dynamic(() => import("./inventory-visual").then((m) => m.InventoryVisual), { loading: Skeleton, ssr: false }),
  security: dynamic(() => import("./security-visual").then((m) => m.SecurityVisual), { loading: Skeleton, ssr: false }),
  reports: dynamic(() => import("./reports-visual").then((m) => m.ReportsVisual), { loading: Skeleton, ssr: false }),
  camera: dynamic(() => import("./camera-visual").then((m) => m.CameraVisual), { loading: Skeleton, ssr: false }),
  // 2026-10 module-consistency round — visuals for the new feature pages
  letters: dynamic(() => import("./letters-visual").then((m) => m.LettersVisual), { loading: Skeleton, ssr: false }),
  communication: dynamic(() => import("./communication-visual").then((m) => m.CommunicationVisual), { loading: Skeleton, ssr: false }),
  tasks: dynamic(() => import("./tasks-visual").then((m) => m.TasksVisual), { loading: Skeleton, ssr: false }),
  exit: dynamic(() => import("./exit-visual").then((m) => m.ExitVisual), { loading: Skeleton, ssr: false }),
  calendar: dynamic(() => import("./calendar-visual").then((m) => m.CalendarVisual), { loading: Skeleton, ssr: false }),
  // Wave 2 WP-P — recruitment pipeline + public careers page
  recruitment: dynamic(() => import("./recruitment-visual").then((m) => m.RecruitmentVisual), { loading: Skeleton, ssr: false }),
}

export function FeatureVisual({ visual, className }: { visual: string | null; className?: string }) {
  const Component = visual ? VISUAL_COMPONENTS[visual] : undefined
  if (!Component) return null
  return (
    <div className={cn("w-full", className)}>
      <Component />
    </div>
  )
}
