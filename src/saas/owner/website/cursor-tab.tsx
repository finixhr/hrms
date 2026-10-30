"use client"
// ============ Website Studio → Cursor tab (v3) ================================
// Owner control for the public site's cursor system. Five premium designs
// (aurora / comet / classic / aurora-trail / magnetic-spark) with live CSS
// previews, owner-picked colors, pull-strength / trail / glow sliders and
// per-effect toggles. Everything saves through owner.cms.cursor.save
// (zod-validated, audited) and goes live on the very next public request — no
// rebuild. COMET is the platform default (Wave 11 §12). The engine additionally
// self-checks pointer/reduced-motion on each visitor's device, so these flags
// only ever ADD polish; they can never force the cursor onto touch users.
// The cursor itself runs ONLY on the public website — never in this console
// or the tenant HRM app.
import { useEffect, useState } from "react"
import type { CSSProperties } from "react"
import { Gem, MousePointerClick, Sparkles, Zap } from "lucide-react"
import { useOwnerApi, ownerRpc } from "@/saas/owner/client"
import { ErrorBanner, Loading } from "@/saas/owner/ui"
import type { CursorConfig, CursorStyle } from "@/saas/web/content-types"
import { WCard, WField, WToggle, inputCls, SuccessNote, ErrorNote } from "./ui"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import "./cursor-demo.css"

const DEFAULTS: CursorConfig = {
  enabled: true,
  // Wave 11 §12 — Comet is the platform default effect for the public site.
  style: "comet",
  primaryColor: "#818cf8",
  accentColor: "#a78bfa",
  pullStrength: 5,
  trailIntensity: 65,
  glow: 65,
  magnetic: true,
  tilt: true,
  ripple: true,
  viewLabels: true,
  viewLabel: "VIEW",
}

const STYLES: { id: CursorStyle; name: string; desc: string }[] = [
  {
    id: "comet",
    name: "Comet",
    desc: "Bright core followed by a playful particle ribbon — the most eye-catching in motion. Platform default.",
  },
  {
    id: "aurora-trail",
    name: "Aurora Trail",
    desc: "Subtle multi-hue gradient ribbon that flows behind the pointer, each segment fading as it settles. Calm, premium, continuous.",
  },
  {
    id: "magnetic-spark",
    name: "Magnetic Spark",
    desc: "Lightweight sparks flare along your movement and fade within a few hundred milliseconds. Lively yet airy.",
  },
  {
    id: "aurora",
    name: "Aurora",
    desc: "Liquid gradient orb with a trailing light. It stretches with velocity for a fluid, futuristic feel.",
  },
  {
    id: "classic",
    name: "Classic",
    desc: "Minimal dot + glass ring. Quiet, precise, editorial — the most restrained option.",
  },
]

const COLOR_PRESETS: { name: string; primary: string; accent: string }[] = [
  { name: "Indigo Dusk", primary: "#818cf8", accent: "#a78bfa" },
  { name: "Neon Violet", primary: "#c084fc", accent: "#f0abfc" },
  { name: "Ocean", primary: "#38bdf8", accent: "#22d3ee" },
  { name: "Emerald", primary: "#34d399", accent: "#a3e635" },
  { name: "Sunset", primary: "#fb923c", accent: "#f472b6" },
  { name: "Mono", primary: "#e2e8f0", accent: "#94a3b8" },
]

function demoVars(f: CursorConfig): CSSProperties {
  return {
    "--demo-primary": f.primaryColor,
    "--demo-accent": f.accentColor,
  } as CSSProperties
}

export function CursorTab() {
  const { data, loading, error } = useOwnerApi<{ settings: { cursor?: Partial<CursorConfig> } }>(
    "owner.cms.settings.get",
    {},
  )
  const [form, setForm] = useState<CursorConfig | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    // merge over code defaults: a DB row only exists after the first save
    if (data) setForm({ ...DEFAULTS, ...data.settings?.cursor })
  }, [data])

  if (loading) return <Loading />
  if (error) return <ErrorBanner message={error} />
  if (!form) return null

  const save = async () => {
    setBusy(true); setMsg(null); setErr(null)
    try {
      await ownerRpc("owner.cms.cursor.save", { cursor: form })
      setMsg("Cursor settings saved — the effect updates on the public site immediately.")
      setTimeout(() => setMsg(null), 5000)
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed")
    } finally {
      setBusy(false)
    }
  }

  const applyPreset = (preset: "playful" | "balanced" | "executive" | "off") => {
    if (preset === "off") {
      setForm({ ...form, enabled: false })
      return
    }
    const base = { ...form, enabled: true, magnetic: true, tilt: true, ripple: true, viewLabels: true }
    if (preset === "playful") {
      setForm({ ...base, style: "aurora", pullStrength: 6, trailIntensity: 85, glow: 75 })
    } else if (preset === "balanced") {
      setForm({ ...base, style: "comet", pullStrength: 5, trailIntensity: 55, glow: 55 })
    } else {
      setForm({ ...base, style: "classic", pullStrength: 4, trailIntensity: 25, glow: 40 })
    }
  }

  return (
    <div className="space-y-4">
      <SuccessNote msg={msg} />
      <ErrorNote msg={err} />

      <WCard
        title="Cursor design"
        desc="Pick the pointer your visitors get on the public website. Previews animate live and re-tint with your chosen colors below. This console and the HRM app always keep the native cursor."
        onSave={save}
        busy={busy}
      >
        <WToggle
          label="Enable custom cursor"
          checked={form.enabled}
          onChange={(v) => setForm({ ...form, enabled: v })}
        />
        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => applyPreset("playful")}
            className="gap-1.5 border-white/15 bg-white/5 text-slate-200 hover:bg-white/10 light:border-slate-300 light:bg-white light:text-slate-700 light:hover:bg-slate-100"
          >
            <Sparkles className="h-3.5 w-3.5" /> Playful
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => applyPreset("balanced")}
            className="gap-1.5 border-white/15 bg-white/5 text-slate-200 hover:bg-white/10 light:border-slate-300 light:bg-white light:text-slate-700 light:hover:bg-slate-100"
          >
            <Zap className="h-3.5 w-3.5" /> Balanced
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => applyPreset("executive")}
            className="gap-1.5 border-white/15 bg-white/5 text-slate-200 hover:bg-white/10 light:border-slate-300 light:bg-white light:text-slate-700 light:hover:bg-slate-100"
          >
            <Gem className="h-3.5 w-3.5" /> Executive
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => applyPreset("off")}
            className="gap-1.5 border-white/15 bg-white/5 text-slate-400 hover:bg-white/10 light:border-slate-300 light:bg-white light:text-slate-500 light:hover:bg-slate-100"
          >
            <MousePointerClick className="h-3.5 w-3.5" /> Native cursor (off)
          </Button>
        </div>
        <div className="grid gap-3 pt-2 sm:grid-cols-3">
          {STYLES.map((s) => {
            const selected = form.style === s.id
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setForm({ ...form, style: s.id })}
                aria-pressed={selected}
                className={`rounded-xl border p-3 text-left transition ${
                  selected
                    ? "border-indigo-400/70 bg-indigo-500/10 ring-1 ring-indigo-400/50 light:border-indigo-500 light:bg-indigo-50"
                    : "border-white/10 bg-white/[0.03] hover:border-white/25 light:border-slate-200 light:bg-white light:hover:border-slate-300"
                }`}
              >
                <div className="demo-stage" style={demoVars(form)}>
                  {s.id === "aurora" && (
                    <>
                      <span className="demo-tail" />
                      <span className="demo-orb" />
                    </>
                  )}
                  {s.id === "comet" && (
                    <>
                      <span className="demo-trail d4" />
                      <span className="demo-trail d3" />
                      <span className="demo-trail d2" />
                      <span className="demo-trail d1" />
                      <span className="demo-core" />
                    </>
                  )}
                  {s.id === "aurora-trail" && (
                    <>
                      <span className="demo-ribbon r3" />
                      <span className="demo-ribbon r2" />
                      <span className="demo-ribbon r1" />
                      <span className="demo-dot" />
                    </>
                  )}
                  {s.id === "magnetic-spark" && (
                    <>
                      <span className="demo-spark s3" />
                      <span className="demo-spark s2" />
                      <span className="demo-spark s1" />
                      <span className="demo-dot" />
                    </>
                  )}
                  {s.id === "classic" && (
                    <>
                      <span className="demo-ring" />
                      <span className="demo-dot" />
                    </>
                  )}
                </div>
                <div className="mt-2.5 flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-100 light:text-slate-800">{s.name}</span>
                  {selected && (
                    <span className="rounded-full bg-indigo-500/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-indigo-300 light:bg-indigo-100 light:text-indigo-600">
                      Active
                    </span>
                  )}
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-slate-400 light:text-slate-500">{s.desc}</p>
              </button>
            )
          })}
        </div>
      </WCard>

      <WCard
        title="Colors & feel"
        desc="Your brand, your motion signature. Colors auto-adapt to the site's light and dark themes."
        onSave={save}
        busy={busy}
      >
        <WField
          label="Cursor colors"
          hint="Primary drives the core dot, ring and orb fill. Accent drives the glow, trail particles and hover highlights."
        >
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2">
              <input
                type="color"
                value={form.primaryColor}
                onChange={(e) => setForm({ ...form, primaryColor: e.target.value })}
                className="h-8 w-10 cursor-pointer rounded border border-white/15 bg-transparent p-0.5 light:border-slate-300"
                aria-label="Primary cursor color"
              />
              <span className="text-xs text-slate-400 light:text-slate-500">Primary</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="color"
                value={form.accentColor}
                onChange={(e) => setForm({ ...form, accentColor: e.target.value })}
                className="h-8 w-10 cursor-pointer rounded border border-white/15 bg-transparent p-0.5 light:border-slate-300"
                aria-label="Accent cursor color"
              />
              <span className="text-xs text-slate-400 light:text-slate-500">Accent</span>
            </label>
            <div className="flex flex-wrap gap-1.5">
              {COLOR_PRESETS.map((p) => {
                const selected =
                  form.primaryColor.toLowerCase() === p.primary && form.accentColor.toLowerCase() === p.accent
                return (
                  <button
                    key={p.name}
                    type="button"
                    title={p.name}
                    aria-label={`${p.name} color preset`}
                    onClick={() => setForm({ ...form, primaryColor: p.primary, accentColor: p.accent })}
                    className={`h-7 w-7 rounded-full border transition hover:scale-110 ${
                      selected ? "border-white ring-2 ring-indigo-400 light:border-slate-400" : "border-white/20 light:border-slate-300"
                    }`}
                    style={{ background: `linear-gradient(135deg, ${p.primary}, ${p.accent})` }}
                  />
                )
              })}
            </div>
          </div>
        </WField>

        <WField label="Magnetic pull strength" hint="How far CTAs and buttons drift toward the pointer. 0 disables the drift; 5 is the designed feel; 10 is strong.">
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={0}
              max={10}
              step={1}
              value={form.pullStrength}
              onChange={(e) => setForm({ ...form, pullStrength: Number(e.target.value) })}
              className="h-1.5 w-44 cursor-pointer accent-indigo-500"
              aria-label="Magnetic pull strength"
            />
            <span className="w-8 rounded bg-white/10 px-1.5 py-0.5 text-center text-xs font-semibold tabular-nums text-slate-200 light:bg-slate-100 light:text-slate-700">
              {form.pullStrength}
            </span>
          </div>
        </WField>

        <WField label="Movement trail" hint="Velocity response: orb squash amount, aurora tail length and comet particle count. 0 = calm, 100 = dramatic.">
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={form.trailIntensity}
              onChange={(e) => setForm({ ...form, trailIntensity: Number(e.target.value) })}
              className="h-1.5 w-44 cursor-pointer accent-indigo-500"
              aria-label="Movement trail intensity"
            />
            <span className="w-8 rounded bg-white/10 px-1.5 py-0.5 text-center text-xs font-semibold tabular-nums text-slate-200 light:bg-slate-100 light:text-slate-700">
              {form.trailIntensity}
            </span>
          </div>
        </WField>

        <WField label="Glow intensity" hint="Strength of the ambient glow around the pointer and its highlight layers.">
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={form.glow}
              onChange={(e) => setForm({ ...form, glow: Number(e.target.value) })}
              className="h-1.5 w-44 cursor-pointer accent-indigo-500"
              aria-label="Glow intensity"
            />
            <span className="w-8 rounded bg-white/10 px-1.5 py-0.5 text-center text-xs font-semibold tabular-nums text-slate-200 light:bg-slate-100 light:text-slate-700">
              {form.glow}
            </span>
          </div>
        </WField>

        <div className="grid gap-2 border-t border-white/10 pt-3 sm:grid-cols-2 light:border-slate-200">
          <WToggle
            label="Magnetic CTAs & buttons"
            checked={form.magnetic}
            onChange={(v) => setForm({ ...form, magnetic: v })}
          />
          <WToggle
            label="Card tilt (feature & pricing)"
            checked={form.tilt}
            onChange={(v) => setForm({ ...form, tilt: v })}
          />
          <WToggle
            label="Click ripple feedback"
            checked={form.ripple}
            onChange={(v) => setForm({ ...form, ripple: v })}
          />
          <WToggle
            label="“VIEW” badge on visuals"
            checked={form.viewLabels}
            onChange={(v) => setForm({ ...form, viewLabels: v })}
          />
        </div>
        <WField label="Badge text" hint="Shown inside the cursor over large clickable visuals (1–8 characters, e.g. VIEW or OPEN).">
          <Input
            value={form.viewLabel}
            onChange={(e) => setForm({ ...form, viewLabel: e.target.value.slice(0, 8).toUpperCase() })}
            className={`${inputCls} w-28 text-center tracking-widest`}
            placeholder="VIEW"
            maxLength={8}
          />
        </WField>
      </WCard>

      <WCard
        title="How it behaves for visitors"
        desc="What your tenants and prospects actually experience."
      >
        <ul className="space-y-2 text-[12px] leading-relaxed text-slate-400 light:text-slate-600">
          <li className="flex gap-2">
            <MousePointerClick className="mt-0.5 h-3.5 w-3.5 shrink-0 text-indigo-300 light:text-indigo-500" />
            The pointer becomes a glowing design that stretches with movement speed, brightens over links, and expands over buttons — with a magnetic drift on primary CTAs.
          </li>
          <li className="flex gap-2">
            <MousePointerClick className="mt-0.5 h-3.5 w-3.5 shrink-0 text-indigo-300 light:text-indigo-500" />
            Feature and pricing cards tilt up to 1.5° as the pointer explores them; text fields switch back to the native caret; dense areas are untouched.
          </li>
          <li className="flex gap-2">
            <MousePointerClick className="mt-0.5 h-3.5 w-3.5 shrink-0 text-indigo-300 light:text-indigo-500" />
            The animation loop fully sleeps when the pointer rests, so the effect adds visual polish without costing page performance.
          </li>
          <li className="flex gap-2">
            <MousePointerClick className="mt-0.5 h-3.5 w-3.5 shrink-0 text-indigo-300 light:text-indigo-500" />
            Touch devices, tablets and prefers-reduced-motion visitors always get the standard browser cursor — no configuration needed.
          </li>
        </ul>
      </WCard>
    </div>
  )
}
