"use client"
// ============ Camera Manager — dashboard charts (lazy-loaded) ============
// Phase 7.1: mirrors the DashboardCharts pattern — recharts stays out of
// the first-paint bundle. Loaded dynamically from dashboard.tsx only when
// the user has camera.view permission AND cameras exist.
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts"

const STATUS_COLORS: Record<string, string> = {
  ONLINE: "#10b981",   // emerald-500
  OFFLINE: "#f43f5e",  // rose-500
  UNKNOWN: "#f59e0b",  // amber-500
}

const BRAND_COLORS: Record<string, string> = {
  HIKVISION: "#3b82f6",  // blue-500
  DAHUA: "#22c55e",      // green-500
  EZVIZ: "#f97316",      // orange-500
  IMOU: "#ef4444",       // red-500
}

type Counts = { ONLINE: number; OFFLINE: number; UNKNOWN: number; total: number }

type BrandCount = { brand: string; count: number }

export function CameraDashboardCharts({
  counts,
  byBrand,
}: {
  counts: Counts
  byBrand: BrandCount[]
}) {
  const pieData = [
    { name: "Online", value: counts.ONLINE, color: STATUS_COLORS.ONLINE },
    { name: "Offline", value: counts.OFFLINE, color: STATUS_COLORS.OFFLINE },
    { name: "Unknown", value: counts.UNKNOWN, color: STATUS_COLORS.UNKNOWN },
  ].filter((d) => d.value > 0)

  return (
    <div className="grid sm:grid-cols-2 gap-4">
      {/* Status PieChart */}
      <div className="rounded-xl border bg-white p-4">
        <h3 className="text-sm font-medium text-slate-700 mb-3">Camera Status</h3>
        {pieData.length === 0 ? (
          <div className="h-[200px] flex items-center justify-center text-sm text-slate-400">No cameras</div>
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70} label>
                {pieData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Per-brand BarChart */}
      <div className="rounded-xl border bg-white p-4">
        <h3 className="text-sm font-medium text-slate-700 mb-3">By Brand</h3>
        {byBrand.length === 0 ? (
          <div className="h-[200px] flex items-center justify-center text-sm text-slate-400">No cameras</div>
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={byBrand}>
              <XAxis dataKey="brand" tick={{ fontSize: 11 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                {byBrand.map((entry, i) => (
                  <Cell key={i} fill={BRAND_COLORS[entry.brand] || "#94a3b8"} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}
