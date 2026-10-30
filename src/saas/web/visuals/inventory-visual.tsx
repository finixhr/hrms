"use client"
// ============ Visual 11 · Inventory & Procurement ============
// Requisition workflow strip, stock-level cards with reorder status, purchase
// orders, warehouse capacity meters, a low-stock alert and the stock-movement
// feed. BDT amounts and quantities are internally consistent.
import {
  AlertTriangle, ArrowLeftRight, Boxes, Check, ClipboardCheck, Package, ShoppingCart, Warehouse,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Chip, Meter, Panel, StatusDot, WindowChrome } from "./chrome"
import type { ChipTone } from "./chrome"

/* ---------- data ---------- */
type Stage = { label: string; meta: string; state: "done" | "active" | "todo" }
const STAGES: Stage[] = [
  { label: "Requested", meta: "REQ-0289 · 10-08", state: "done" },
  { label: "Approved", meta: "10-10", state: "done" },
  { label: "PO issued", meta: "PO-0092", state: "active" },
  { label: "Received", meta: "pending GRN", state: "todo" },
  { label: "Stocked", meta: "auto", state: "todo" },
]

const STOCK: { item: string; wh: string; qty: number; reorder: number; health: number; tone: ChipTone; status: string }[] = [
  { item: "A4 paper ream", wh: "WH-Gulshan", qty: 240, reorder: 100, health: 86, tone: "emerald", status: "OK" },
  { item: "Toner HP 26A", wh: "WH-Gulshan", qty: 12, reorder: 20, health: 18, tone: "amber", status: "LOW" },
  { item: "Office chair", wh: "WH-Uttara", qty: 45, reorder: 15, health: 72, tone: "emerald", status: "OK" },
  { item: "LAN cable · box", wh: "WH-Dhanmondi", qty: 60, reorder: 200, health: 12, tone: "rose", status: "OUT" },
  { item: "ID card blanks", wh: "WH-Gulshan", qty: 900, reorder: 250, health: 90, tone: "emerald", status: "OK" },
]

const POS: { po: string; supplier: string; amount: string; status: string; tone: ChipTone }[] = [
  { po: "PO-2026-0091", supplier: "Meghna Office Supplies", amount: "৳ 184,500", status: "Received", tone: "emerald" },
  { po: "PO-2026-0092", supplier: "Ryans Computers", amount: "৳ 96,200", status: "Approved", tone: "indigo" },
  { po: "PO-2026-0093", supplier: "BD Office Solutions", amount: "৳ 42,800", status: "Pending", tone: "amber" },
]

const WAREHOUSES: { name: string; pct: number; tone: ChipTone }[] = [
  { name: "WH-Gulshan · 3,200 ft²", pct: 78, tone: "indigo" },
  { name: "WH-Uttara · 1,800 ft²", pct: 52, tone: "cyan" },
  { name: "WH-Dhanmondi · 900 ft²", pct: 91, tone: "amber" },
]

const MOVEMENTS: { time: string; kind: string; ref: string; text: string; tone: ChipTone }[] = [
  { time: "09:40", kind: "ISSUE", ref: "I-4821", text: "6 chairs → Accounts dept", tone: "indigo" },
  { time: "08:55", kind: "RECEIPT", ref: "R-0912", text: "+100 A4 reams (PO-0091)", tone: "emerald" },
  { time: "Yesterday", kind: "ADJUST", ref: "A-0344", text: "+3 toners · cycle count", tone: "amber" },
  { time: "Mon", kind: "ISSUE", ref: "I-4820", text: "2 toners → Uttara branch", tone: "indigo" },
]

const REQUISITION_ITEMS: { item: string; qty: number; est: string }[] = [
  { item: "Toner HP 26A", qty: 20, est: "৳ 36,000" },
  { item: "LAN cable · box", qty: 4, est: "৳ 12,400" },
  { item: "ID card blanks", qty: 500, est: "৳ 9,500" },
]

/* ---------- workflow strip ---------- */
function Workflow() {
  return (
    <div className="overflow-x-auto rounded-xl border border-white/10 bg-white/[0.03] p-2.5 light:border-slate-200 light:bg-white light:shadow-sm">
      <div className="flex min-w-[440px] items-center">
        {STAGES.map((s, i) => (
          <div key={s.label} className={cn("flex items-center", i < STAGES.length - 1 && "flex-1")}>
            <div className="flex items-center gap-2">
              <span className={cn(
                "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[9px] font-bold",
                s.state === "done" && "border-emerald-400/50 bg-emerald-400/15 text-emerald-300 light:text-emerald-600",
                s.state === "active" && "border-cyan-400/60 bg-cyan-500/20 text-cyan-300 ring-2 ring-cyan-400/30 light:text-cyan-600",
                s.state === "todo" && "border-white/15 text-slate-500 light:border-slate-300",
              )}>
                {s.state === "done" ? <Check className="h-3 w-3" /> : s.state === "active" ? <StatusDot tone="cyan" pulse /> : i + 1}
              </span>
              <div className="whitespace-nowrap">
                <p className={cn("text-[10px] font-bold", s.state === "todo" ? "text-slate-500" : "text-white light:text-slate-900")}>{s.label}</p>
                <p className="text-[8px] text-slate-500">{s.meta}</p>
              </div>
            </div>
            {i < STAGES.length - 1 && (
              <span className={cn("mx-2 h-px flex-1", s.state === "done" ? "bg-emerald-400/40" : "bg-white/10 light:bg-slate-200")} />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

/* ---------- the visual ---------- */
export function InventoryVisual() {
  return (
    <WindowChrome
      title={<>finixhr.app — Inventory &amp; Procurement
        <span className="ml-2 inline-flex items-center gap-1 text-cyan-300 light:text-cyan-600">
          <StatusDot tone="cyan" pulse /> REQ-0289 in progress
        </span>
      </>}
      glow="bg-cyan-600/20"
    >
      <div className="space-y-3">
        <Workflow />

        <div className="grid gap-3 lg:grid-cols-[1.25fr_250px]">
          <div className="min-w-0 space-y-3">
            {/* stock cards */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3">
              {STOCK.map((s) => (
                <div key={s.item} className={cn(
                  "rounded-xl border p-2.5",
                  s.tone === "rose"
                    ? "border-rose-400/30 bg-rose-500/[0.06] light:border-rose-500/30 light:bg-rose-500/5"
                    : s.tone === "amber"
                      ? "border-amber-400/30 bg-amber-500/[0.06] light:border-amber-500/30 light:bg-amber-500/5"
                      : "border-white/10 bg-white/[0.03] light:border-slate-200 light:bg-white light:shadow-sm",
                )}>
                  <p className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-widest text-slate-500">
                    <Package className="h-3 w-3" /> {s.wh}
                  </p>
                  <p className="mt-1 truncate text-[11px] font-bold text-white light:text-slate-900">{s.item}</p>
                  <p className="mt-0.5 text-[13px] font-bold tabular-nums text-white light:text-slate-900">
                    {s.qty}
                    <span className="text-[9px] font-medium text-slate-500"> in stock · reorder {s.reorder}</span>
                  </p>
                  <Meter value={s.health} tone={s.tone} className="mt-1.5" />
                  <div className="mt-1.5 flex items-center justify-between">
                    <Chip tone={s.tone}>{s.status}</Chip>
                    <span className="text-[8px] text-slate-500">health {s.health}%</span>
                  </div>
                </div>
              ))}
              {/* low-stock alert as the 6th cell */}
              <div className="flex flex-col justify-center rounded-xl border border-amber-400/30 bg-amber-500/[0.08] p-2.5 light:border-amber-500/40 light:bg-amber-500/10">
                <p className="flex items-center gap-1.5 text-[11px] font-bold text-amber-300 light:text-amber-700">
                  <AlertTriangle className="h-3.5 w-3.5" /> Low stock · 2 items
                </p>
                <p className="mt-1 text-[9px] leading-relaxed text-slate-500">
                  Toner HP 26A and LAN cable fell below reorder point.
                </p>
                <span className="mt-2 inline-flex items-center gap-1 self-start rounded-lg bg-amber-500/20 px-2 py-1 text-[9px] font-bold text-amber-200 light:text-amber-700">
                  <ShoppingCart className="h-3 w-3" /> Auto-draft PO ready
                </span>
              </div>
            </div>

            {/* purchase orders */}
            <Panel title="Purchase orders · October" icon={ShoppingCart} action={<Chip tone="slate">3 open</Chip>}>
              <ul className="space-y-1.5">
                {POS.map((p) => (
                  <li key={p.po} className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-2 py-1.5 light:bg-slate-50">
                    <span className="shrink-0 font-mono text-[10px] font-bold text-indigo-300 light:text-indigo-600">{p.po}</span>
                    <span className="min-w-0 flex-1 truncate text-[10px] font-medium text-slate-300 light:text-slate-700">{p.supplier}</span>
                    <span className="shrink-0 text-[10px] font-bold tabular-nums text-white light:text-slate-900">{p.amount}</span>
                    <Chip tone={p.tone}>{p.status}</Chip>
                  </li>
                ))}
              </ul>
            </Panel>

            {/* requisition line items */}
            <Panel title="REQ-0289 · line items · requested by Gulshan HQ" icon={ClipboardCheck} action={<Chip tone="cyan">budget ৳ 100,000</Chip>}>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[380px] text-left text-[10px]">
                  <thead>
                    <tr className="text-[9px] uppercase tracking-wider text-slate-500">
                      <th className="pb-1.5 font-semibold">Item</th>
                      <th className="pb-1.5 text-right font-semibold">Qty</th>
                      <th className="pb-1.5 text-right font-semibold">Est. cost</th>
                      <th className="pb-1.5 text-right font-semibold">Stock after</th>
                    </tr>
                  </thead>
                  <tbody>
                    {REQUISITION_ITEMS.map((r) => (
                      <tr key={r.item} className="border-t border-white/5 light:border-slate-100">
                        <td className="py-1.5 font-medium text-slate-200 light:text-slate-800">{r.item}</td>
                        <td className="py-1.5 text-right tabular-nums text-slate-300 light:text-slate-700">{r.qty}</td>
                        <td className="py-1.5 text-right font-bold tabular-nums text-slate-200 light:text-slate-800">{r.est}</td>
                        <td className="py-1.5 text-right tabular-nums text-emerald-300 light:text-emerald-700">{r.qty * 3}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>

          {/* right rail */}
          <div className="min-w-0 space-y-3">
            <Panel title="Warehouse capacity" icon={Warehouse}>
              <div className="space-y-2.5">
                {WAREHOUSES.map((w) => (
                  <div key={w.name}>
                    <p className="mb-1 flex justify-between text-[9px]">
                      <span className="text-slate-400 light:text-slate-600">{w.name}</span>
                      <span className="font-bold tabular-nums text-slate-200 light:text-slate-800">{w.pct}%</span>
                    </p>
                    <Meter value={w.pct} tone={w.tone} />
                  </div>
                ))}
              </div>
            </Panel>

            <Panel title="Stock movements" icon={ArrowLeftRight}>
              <ul className="space-y-1.5">
                {MOVEMENTS.map((m) => (
                  <li key={m.ref} className="flex items-center gap-2">
                    <span className="shrink-0 font-mono text-[8px] text-slate-500">{m.time}</span>
                    <Chip tone={m.tone}>{m.kind}</Chip>
                    <span className="min-w-0 flex-1 truncate text-[9px] text-slate-300 light:text-slate-600">{m.text}</span>
                    <span className="shrink-0 font-mono text-[8px] text-slate-500">{m.ref}</span>
                  </li>
                ))}
              </ul>
            </Panel>

            <Panel title="Requisition audit" icon={ClipboardCheck}>
              <ul className="space-y-1 text-[9px] text-slate-500">
                <li className="flex gap-1.5"><Check className="h-3 w-3 shrink-0 text-emerald-400 light:text-emerald-600" /> REQ-0289 approved by Branch Manager · 10-10</li>
                <li className="flex gap-1.5"><Boxes className="h-3 w-3 shrink-0 text-indigo-300 light:text-indigo-600" /> PO-0092 issued to Ryans Computers · budget ৳ 100,000</li>
                <li className="flex gap-1.5"><ClipboardCheck className="h-3 w-3 shrink-0 text-amber-400 light:text-amber-600" /> GRN pending — items land in WH-Gulshan</li>
              </ul>
            </Panel>
          </div>
        </div>
      </div>
    </WindowChrome>
  )
}
