"use client"
// ============ Storage trend chart (code-split from storage/page.tsx) ============
// PRF-13 (P2 wave, 2026-11-09) — recharts stays out of the storage console's
// first-load JS; the page next/dynamic-imports this module (ssr off).
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts"

export function StorageTrendChart({ trend }: { trend: { month: string; totalBytes: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={trend.map((t) => ({ month: t.month, gb: +(t.totalBytes / 1024 ** 3).toFixed(3) }))}>
        <defs>
          <linearGradient id="storageTrendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#6366f1" stopOpacity={0.5} />
            <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
        <XAxis dataKey="month" stroke="#64748b" fontSize={11} />
        <YAxis stroke="#64748b" fontSize={11} unit=" GB" />
        <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 12, color: "#e2e8f0" }}
          formatter={(v) => [`${Number(v).toFixed(2)} GB`, "Consumed"]} />
        <Area type="monotone" dataKey="gb" name="Consumed" stroke="#6366f1" fill="url(#storageTrendFill)" strokeWidth={2} />
      </AreaChart>
    </ResponsiveContainer>
  )
}
