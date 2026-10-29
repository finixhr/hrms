"use client"
// ============ SiteCursor — premium pointer engine v3 ==========================
// Five owner-selectable designs (CursorConfig.style):
//   aurora         — liquid gradient orb + trailing light + velocity squash/stretch
//   comet          — bright core followed by a playful particle ribbon (PLATFORM DEFAULT)
//   classic        — minimal dot + glass ring
//   aurora-trail   — subtle multi-hue gradient ribbon, fading along the chain (Wave 11 §12)
//   magnetic-spark — lightweight fading sparks that flare along movement (Wave 11 §12)
//
// PERFORMANCE CONTRACT (v2 — fixes the "site feels slower" regressions):
//   · the rAF loop SLEEPS: once the pointer has been idle (~200ms), all lerps
//     have converged and the last ripple finished, the loop stops entirely —
//     zero main-thread wakeups while the visitor reads the page. Any pointer /
//     scroll event wakes it instantly.
//   · every per-frame style write goes through a diff cache — converged values
//     are never re-written, so there are no style-invalidation storms.
//   · motion is transform/opacity ONLY. Glows are pre-rendered gradient layers
//     whose opacity animates (compositor-only); box-shadow colors are never
//     animated and backdrop-filter is gone entirely.
//   · hover resolution is coalesced: pointerover merely records a target; the
//     closest() resolution runs once inside the next animation frame.
//
// Activation gates (any failure => native cursor, spec §13–§15):
//   · owner enablement (CMS config, Owner Console → Website Studio → Cursor)
//   · matchMedia("(pointer: fine) and (hover: hover)")
//   · NOT matchMedia("(prefers-reduced-motion: reduce)")
//   · no touch pointer ever observed (hybrid devices fall back mid-session)
//
// Owner-configurable feel — colors (primary/accent hex, theme-adapted), glow
// 0–100, trail intensity 0–100 (velocity squash, tail length, particle count),
// pull strength 0–10 (magnetic multiplier; 5 = designed feel). Everything except
// `enabled` / `style` hot-applies without rebuilding the engine.
//
// Data-attribute API (spec §17):
//   <a data-cursor="link"> <button data-cursor="button">
//   <div data-cursor="magnetic" data-magnetic-strength="6">
//   <Link data-cursor="view" data-cursor-label="OPEN">
//   <div data-cursor="card">            (subtle ≤1.5° tilt + gentle follower)
//   <input>… auto text mode             (native caret, custom cursor hides)
//   <section data-cursor-zone="native"> (opt-out for dense admin surfaces)
import { useEffect, useRef } from "react"
import type { CursorConfig } from "../content-types"
import "./cursor.css"

type Mode = "default" | "link" | "card" | "button" | "magnetic" | "view" | "text" | "disabled"

const FINE_QUERY = "(pointer: fine) and (hover: hover)"
const REDUCED_QUERY = "(prefers-reduced-motion: reduce)"

const INTERACTIVE_SELECTOR =
  'a[href], [role="link"], button, [role="button"], summary, [role="tab"], [role="option"]'
const TEXT_SELECTOR =
  'textarea, select, input:not([type]), input:not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="reset"]):not([type="file"]):not([type="range"]):not([type="color"]):not([type="image"]), [contenteditable="true"], [contenteditable=""]'
const DISABLED_SELECTOR = '[data-cursor-zone="native"], [data-cursor="disabled"]'

const RING_RATE = 15 // follower inertia: higher = snappier (~180ms settle)
const TILT_MAX_DEG = 1.5 // spec §5: extremely subtle
const TILT_LERP = 0.16
const BUTTON_PULL = 3 // px — plain buttons base pull (scaled by pullStrength)
const MAG_CAP = 14 // px — absolute ceiling for any magnetic pull
const RESET_MS = 320
const TRAIL_N = 12 // comet particle + aurora-trail ribbon pool (shown count scales with trail)
const SPARK_N = 14 // magnetic-spark pool — deliberately small ("lightweight")
const IDLE_MS = 200 // loop sleeps after this much pointer inactivity
const RIPPLE_SETTLE_MS = 420 // must outlast the 220ms ripple animation

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}

function el<T extends HTMLElement>(tag: string, cls: string, parent: HTMLElement): T {
  const node = document.createElement(tag)
  node.className = cls
  parent.appendChild(node)
  return node as T
}

// ---- config → CSS custom properties ------------------------------------------
function hexToTriplet(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex)
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

// Colors arrive as owner-chosen hex. On light surfaces they are darkened in JS
// (deterministic, no color-mix dependency) so the cursor stays crisp in both
// themes; the engine root carries the result as "r g b" triplets.
function applyCursorVars(root: HTMLElement, cfg: CursorConfig, dark: boolean): void {
  const p = hexToTriplet(cfg.primaryColor) ?? [129, 140, 248]
  const a = hexToTriplet(cfg.accentColor) ?? [167, 139, 250]
  const k = dark ? 1 : 0.6
  const mix = (c: [number, number, number]) =>
    `${Math.round(clamp(c[0] * k, 0, 255))} ${Math.round(clamp(c[1] * k, 0, 255))} ${Math.round(clamp(c[2] * k, 0, 255))}`
  root.style.setProperty("--fxc-primary", mix(p))
  root.style.setProperty("--fxc-accent", mix(a))
  root.style.setProperty("--fxc-glow", (clamp(cfg.glow, 0, 100) / 100).toFixed(2))
  root.style.setProperty("--fxc-trail", (clamp(cfg.trailIntensity, 0, 100) / 100).toFixed(2))
}

// ---- diff-cached style writes -------------------------------------------------
// Setting the identical string twice is usually cheap, but across ~15 elements
// × 60fps it adds up to real style-recalc churn on low-end hardware. The cache
// guarantees we only touch the CSSOM when a value actually changed.
const writeCache = new WeakMap<HTMLElement, Record<string, string>>()
function write(node: HTMLElement, prop: string, value: string): void {
  let bag = writeCache.get(node)
  if (!bag) {
    bag = {}
    writeCache.set(node, bag)
  }
  if (bag[prop] === value) return
  bag[prop] = value
  node.style.setProperty(prop, value)
}

export function SiteCursor({ config }: { config: CursorConfig }) {
  const cfg = useRef(config)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const labelRef = useRef<HTMLSpanElement | null>(null)
  const enabled = config.enabled
  const style = config.style

  // Live config sync — colors / glow / trail / pull / label hot-apply without
  // tearing the engine down (only `enabled` and `style` rebuild it below).
  useEffect(() => {
    cfg.current = config
    const root = rootRef.current
    if (root) applyCursorVars(root, config, document.documentElement.classList.contains("dark"))
    if (labelRef.current) labelRef.current.textContent = config.viewLabel || "VIEW"
  }, [config])

  useEffect(() => {
    if (!enabled) return
    const fineMq = window.matchMedia(FINE_QUERY)
    const reducedMq = window.matchMedia(REDUCED_QUERY)
    if (!fineMq.matches || reducedMq.matches) return // native fallback, no DOM built

    const docEl = document.documentElement
    const isDark = () => docEl.classList.contains("dark")

    // ---- engine DOM (imperative: immune to React re-renders) ----
    const root = el<HTMLDivElement>("div", "fx-cursor", document.body)
    root.setAttribute("aria-hidden", "true")
    root.dataset.mode = "default"
    root.dataset.design = style
    root.dataset.speed = "idle"
    root.dataset.hidden = "1"
    rootRef.current = root
    applyCursorVars(root, cfg.current, isDark())

    // 1:1 core dot (every design)
    const core = el("div", "fx-core", root)
    el("div", "fx-core-inner", core)
    // lerped follower (wrapper: per-frame translate + velocity squash)
    const follow = el("div", "fx-follow", root)

    let tail: HTMLElement | null = null // aurora only
    let trail: HTMLElement[] = [] // comet + aurora-trail (ribbon)
    let sparks: HTMLElement[] = [] // magnetic-spark only
    if (style === "aurora") {
      el("div", "fx-orb-glow", follow)
      el("div", "fx-orb", follow)
      tail = el("div", "fx-tail", root)
      el("div", "fx-tail-inner", tail)
    } else if (style === "comet") {
      el("div", "fx-ring-glow", follow)
      el("div", "fx-ring", follow)
      const layer = el("div", "fx-trail-layer", root)
      trail = Array.from({ length: TRAIL_N }, () => el("div", "fx-trail", layer))
    } else if (style === "aurora-trail") {
      // Wave 11 §12 "Aurora Trail" — subtle gradient ribbon. Same chained-
      // follow mechanics as comet (one shared loop below), but the segments
      // render as multi-hue gradient bars that fade along the chain — the
      // per-index look lives entirely in CSS (.fx-ribbon + --fx-i).
      el("div", "fx-ring-glow", follow)
      el("div", "fx-ring", follow)
      const layer = el("div", "fx-trail-layer fx-ribbon-layer", root)
      trail = Array.from({ length: TRAIL_N }, (_, i) => {
        const seg = el("div", "fx-ribbon", layer)
        seg.style.setProperty("--fx-i", String(i))
        return seg
      })
    } else if (style === "magnetic-spark") {
      // Wave 11 §12 "Magnetic Spark" — lightweight fading particle trail.
      // Sparks SPAWN along movement, drift briefly and die (physics state in
      // the loop below); nothing is chained, so the trail is sparse and airy
      // rather than a persistent ribbon. Pool stays small by design.
      el("div", "fx-ring-glow", follow)
      el("div", "fx-ring", follow)
      const layer = el("div", "fx-trail-layer fx-spark-layer", root)
      sparks = Array.from({ length: SPARK_N }, () => el("div", "fx-spark", layer))
    } else {
      el("div", "fx-ring-glow", follow)
      el("div", "fx-ring", follow)
    }

    const view = el("div", "fx-view", root)
    const viewInner = el("div", "fx-view-inner", view)
    const label = el<HTMLSpanElement>("span", "fx-view-label", viewInner)
    label.textContent = cfg.current.viewLabel || "VIEW"
    labelRef.current = label

    // ---- mutable engine state (plain locals — no React state, ever) ----
    let raf = 0
    let last = performance.now()
    let mx = -100
    let my = -100
    let pmx = -100
    let pmy = -100
    let rx = -100
    let ry = -100
    let tx = -100
    let ty = -100
    const trailX = new Float32Array(TRAIL_N).fill(-100)
    const trailY = new Float32Array(TRAIL_N).fill(-100)
    // magnetic-spark physics pool (x, y, vx, vy px/ms; born = timestamp, 0 = free)
    const sparkX = new Float32Array(SPARK_N)
    const sparkY = new Float32Array(SPARK_N)
    const sparkVX = new Float32Array(SPARK_N)
    const sparkVY = new Float32Array(SPARK_N)
    const sparkBorn = new Float64Array(SPARK_N)
    let sparkCursor = 0 // round-robin allocation (overwriting the oldest live spark is fine visually)
    let lastSparkSpawn = 0
    let smoothSpeed = 0
    let angle = 0
    let stretch = 0
    let mode: Mode = "default"
    let hidden = true
    let running = false
    let lastActivity = 0
    let lastRippleAt = 0
    let pendingTarget: Element | null = null
    let rectsDirty = false

    // magnetic / tilt targets
    let magEl: HTMLElement | null = null
    let magRect: DOMRect | null = null
    let magStrength = 0
    let magTimer = 0
    let tiltEl: HTMLElement | null = null
    let tiltRect: DOMRect | null = null
    let tiltX = 0
    let tiltY = 0
    let tiltTimer = 0

    const setMode = (next: Mode) => {
      if (next === mode) return
      mode = next
      root.dataset.mode = next
    }

    // ---- element release helpers (soft snap-back, transition-safe) ----
    const releaseMagnetic = () => {
      const node = magEl
      if (!node) return
      magEl = null
      magRect = null
      clearTimeout(magTimer)
      node.style.transition = `transform ${RESET_MS}ms cubic-bezier(0.22, 0.61, 0.36, 1)`
      write(node, "transform", "")
      node.classList.remove("fx-magnetic")
      const clear = () => {
        // only strip styles if the engine has not re-claimed the element
        if (magEl !== node) node.style.transition = ""
      }
      magTimer = window.setTimeout(clear, RESET_MS + 40)
    }

    const releaseTilt = () => {
      const node = tiltEl
      if (!node) return
      tiltEl = null
      tiltRect = null
      clearTimeout(tiltTimer)
      node.style.transition = `transform ${RESET_MS}ms cubic-bezier(0.22, 0.61, 0.36, 1)`
      write(node, "transform", "")
      node.classList.remove("fx-tilt")
      const clear = () => {
        if (tiltEl !== node) node.style.transition = ""
      }
      tiltTimer = window.setTimeout(clear, RESET_MS + 40)
    }

    const applyViewLabel = (node: HTMLElement) => {
      const custom = node.getAttribute("data-cursor-label")
      const text = custom || cfg.current.viewLabel || "VIEW"
      if (labelRef.current) labelRef.current.textContent = text
    }

    // ---- hover resolution (delegated, closest-wins, innermost-first) ----
    const resolve = (target: Element): void => {
      if (target.closest(DISABLED_SELECTOR)) {
        releaseMagnetic()
        releaseTilt()
        setMode("disabled")
        return
      }
      const textEl = target.closest(TEXT_SELECTOR)
      if (textEl) {
        releaseMagnetic()
        releaseTilt()
        setMode("text")
        return
      }
      const interactive = target.closest<HTMLElement>(INTERACTIVE_SELECTOR)
      if (interactive) {
        const explicit = interactive.getAttribute("data-cursor")
        if (explicit === "magnetic") {
          releaseTilt()
          if (magEl !== interactive) {
            releaseMagnetic()
            magEl = interactive
            magRect = interactive.getBoundingClientRect()
            magStrength = Number(interactive.dataset.magneticStrength) || 6
            interactive.classList.add("fx-magnetic")
            interactive.style.transition = "none"
          }
          setMode("magnetic")
          return
        }
        if (explicit === "view") {
          releaseMagnetic()
          releaseTilt()
          if (cfg.current.viewLabels) {
            applyViewLabel(interactive)
            setMode("view")
          } else {
            setMode("link")
          }
          return
        }
        if (explicit === "card") {
          // clickable card (e.g. homepage feature tiles): gentle follower + tilt
          releaseMagnetic()
          if (tiltEl !== interactive) {
            releaseTilt()
            tiltEl = interactive
            tiltRect = interactive.getBoundingClientRect()
            interactive.classList.add("fx-tilt")
            interactive.style.transition = "none"
          }
          setMode("card")
          return
        }
        // plain link / button — buttons get a whisper of magnetic pull
        releaseTilt()
        if (interactive.tagName === "A" || interactive.getAttribute("role") === "link") {
          releaseMagnetic()
          setMode("link")
        } else {
          if (magEl !== interactive) {
            releaseMagnetic()
            magEl = interactive
            magRect = interactive.getBoundingClientRect()
            magStrength = BUTTON_PULL
            interactive.classList.add("fx-magnetic")
            interactive.style.transition = "none"
          }
          setMode("button")
        }
        return
      }
      // non-interactive containers carrying an explicit data-cursor
      const container = target.closest<HTMLElement>("[data-cursor]")
      const attr = container?.getAttribute("data-cursor") ?? ""
      if (container && (attr === "view" || attr === "magnetic" || attr === "card" || attr === "text")) {
        if (attr === "text") {
          releaseMagnetic()
          releaseTilt()
          setMode("text")
          return
        }
        if (attr === "view") {
          releaseMagnetic()
          releaseTilt()
          if (cfg.current.viewLabels) {
            applyViewLabel(container)
            setMode("view")
          } else {
            setMode("link")
          }
          return
        }
        if (attr === "magnetic") {
          releaseTilt()
          if (magEl !== container) {
            releaseMagnetic()
            magEl = container
            magRect = container.getBoundingClientRect()
            magStrength = Number(container.dataset.magneticStrength) || 6
            container.classList.add("fx-magnetic")
            container.style.transition = "none"
          }
          setMode("magnetic")
          return
        }
        // card: gentle follower + subtle tilt while the pointer explores it
        releaseMagnetic()
        if (tiltEl !== container) {
          releaseTilt()
          tiltEl = container
          tiltRect = container.getBoundingClientRect()
          container.classList.add("fx-tilt")
          container.style.transition = "none"
        }
        setMode("card")
        return
      }
      releaseMagnetic()
      releaseTilt()
      setMode("default")
    }

    // ---- the single rAF loop (self-sleeping) ----
    const tick = (now: number) => {
      if (!running) return
      const dt = clamp(now - last, 1, 48) / 1000
      last = now

      // coalesced hover resolution (one closest() pass per frame, max)
      if (pendingTarget) {
        const target = pendingTarget
        pendingTarget = null
        resolve(target)
      }

      if (rectsDirty) {
        rectsDirty = false
        if (magEl) magRect = magEl.getBoundingClientRect()
        if (tiltEl) tiltRect = tiltEl.getBoundingClientRect()
      }

      // ---- velocity (drives squash/stretch + speed glow) ----
      const vx = mx - pmx
      const vy = my - pmy
      pmx = mx
      pmy = my
      const speed = Math.hypot(vx, vy)
      smoothSpeed += (speed - smoothSpeed) * clamp(dt * 9, 0, 1)
      if (speed > 0.9) {
        const target = Math.atan2(vy, vx)
        let d = target - angle
        if (d > Math.PI) d -= Math.PI * 2
        else if (d < -Math.PI) d += Math.PI * 2
        angle += d * clamp(dt * 14, 0, 1)
      }

      const trailScale = clamp(cfg.current.trailIntensity, 0, 100) / 100
      const maxStretch =
        style === "aurora" || style === "aurora-trail" ? 0.4 :
        style === "comet" || style === "magnetic-spark" ? 0.24 : 0.16
      const targetStretch = clamp(smoothSpeed / 24, 0, 1) * maxStretch * (0.3 + 0.7 * trailScale)
      stretch += (targetStretch - stretch) * clamp(dt * 10, 0, 1)

      // speed state drives the CSS glow layers (opacity-only transitions)
      const moving = smoothSpeed > 2.4
      if (moving !== (root.dataset.speed === "move")) {
        root.dataset.speed = moving ? "move" : "idle"
      }

      // ---- core: 1:1 with the pointer ----
      write(core, "transform", `translate3d(${mx.toFixed(2)}px, ${my.toFixed(2)}px, 0)`)

      // ---- follower: lerp + squash/stretch along the movement vector ----
      const ease = 1 - Math.exp(-dt * RING_RATE)
      rx += (mx - rx) * ease
      ry += (my - ry) * ease
      const f = `translate3d(${rx.toFixed(2)}px, ${ry.toFixed(2)}px, 0) rotate(${angle.toFixed(3)}rad) scale(${(1 + stretch).toFixed(3)}, ${(1 - stretch * 0.62).toFixed(3)})`
      write(follow, "transform", f)
      write(view, "transform", `translate3d(${rx.toFixed(2)}px, ${ry.toFixed(2)}px, 0)`)

      let settled = Math.abs(mx - rx) + Math.abs(my - ry) < 0.4 && smoothSpeed < 0.5 && stretch < 0.01

      // ---- aurora: trailing light blob (slower lerp = fluid tail) ----
      if (tail) {
        const rate = 15 - 7.5 * trailScale
        const te = 1 - Math.exp(-dt * rate)
        tx += (mx - tx) * te
        ty += (my - ty) * te
        write(
          tail,
          "transform",
          `translate3d(${tx.toFixed(2)}px, ${ty.toFixed(2)}px, 0) rotate(${angle.toFixed(3)}rad) scale(${(1 + stretch * 1.5).toFixed(3)}, ${(1 - stretch * 0.9).toFixed(3)})`,
        )
        settled = settled && Math.abs(mx - tx) + Math.abs(my - ty) < 1
      }

      // ---- comet + aurora-trail: chained segments (each chases the one before) ----
      if (trail.length) {
        const active = trailScale < 0.04 ? 0 : Math.max(3, Math.round(TRAIL_N * clamp(trailScale, 0.25, 1)))
        for (let i = 0; i < TRAIL_N; i++) {
          const node = trail[i]
          if (i >= active) {
            if (node.dataset.off !== "1") node.dataset.off = "1"
            continue
          }
          if (node.dataset.off === "1") {
            // reactivating: snap next to its parent particle so no stale streak
            delete node.dataset.off
            trailX[i] = i === 0 ? mx : trailX[i - 1]
            trailY[i] = i === 0 ? my : trailY[i - 1]
          }
          const tX = i === 0 ? mx : trailX[i - 1]
          const tY = i === 0 ? my : trailY[i - 1]
          const pe = 1 - Math.exp(-dt * (16 * Math.pow(0.78, i)))
          trailX[i] += (tX - trailX[i]) * pe
          trailY[i] += (tY - trailY[i]) * pe
          write(node, "transform", `translate3d(${trailX[i].toFixed(2)}px, ${trailY[i].toFixed(2)}px, 0)`)
          if (Math.abs(tX - trailX[i]) + Math.abs(tY - trailY[i]) > 1) settled = false
        }
      }

      // ---- magnetic-spark: spawn + integrate + fade (Wave 11 §12) ----
      // Lightweight by construction: ≤14 pooled sparks, only alive while the
      // pointer moves, every spark dies within 240–500ms (trail-scaled), and
      // the loop only writes transform/opacity (compositor-only). The pool
      // fully empties shortly after the pointer rests, so the idle-sleep
      // contract is preserved.
      if (sparks.length) {
        const lifeMs = 240 + 260 * trailScale
        const spawnGapMs = Math.max(16, 48 - 26 * trailScale)
        if (speed > 5 && now - lastSparkSpawn > spawnGapMs) {
          lastSparkSpawn = now
          const i = sparkCursor
          sparkCursor = (sparkCursor + 1) % SPARK_N
          sparkX[i] = mx
          sparkY[i] = my
          // velocities in px/ms: inherit a fraction of the pointer motion for
          // directional flow + a small random ember burst
          sparkVX[i] = vx * 0.0075 + (Math.random() - 0.5) * 0.06
          sparkVY[i] = vy * 0.0075 + (Math.random() - 0.5) * 0.06
          sparkBorn[i] = now
        }
        let alive = 0
        for (let i = 0; i < SPARK_N; i++) {
          const node = sparks[i]
          const born = sparkBorn[i]
          const age = born ? now - born : Infinity
          if (age >= lifeMs) {
            sparkBorn[i] = 0
            write(node, "opacity", "0")
            continue
          }
          alive++
          // integrate: gentle drift + exponential damping
          const damp = Math.exp(-dt * 3.2)
          sparkVX[i] *= damp
          sparkVY[i] *= damp
          sparkX[i] += sparkVX[i] * dt
          sparkY[i] += sparkVY[i] * dt
          const t = age / lifeMs
          const alpha = (1 - t) * (1 - t) // quadratic ease-out fade
          write(node, "transform", `translate3d(${sparkX[i].toFixed(2)}px, ${sparkY[i].toFixed(2)}px, 0) scale(${(0.45 + 0.55 * alpha).toFixed(3)})`)
          write(node, "opacity", alpha.toFixed(3))
        }
        settled = settled && alive === 0
      }

      // ---- magnetic pull (transform-only, capped, owner-scaled) ----
      if (magEl && magRect && cfg.current.magnetic) {
        const mult = clamp(cfg.current.pullStrength, 0, 10) / 5
        const strength = Math.min(magStrength * mult, MAG_CAP)
        if (strength >= 0.05) {
          const cx = magRect.left + magRect.width / 2
          const cy = magRect.top + magRect.height / 2
          const nx = clamp((mx - cx) / Math.max(magRect.width / 2, 1), -1, 1)
          const ny = clamp((my - cy) / Math.max(magRect.height / 2, 1), -1, 1)
          write(magEl, "transform", `translate3d(${(nx * strength).toFixed(2)}px, ${(ny * strength).toFixed(2)}px, 0)`)
        } else {
          write(magEl, "transform", "")
        }
      }

      // ---- card tilt (≤1.5°, lerped, preserves the site's -2px hover lift) ----
      if (tiltEl && tiltRect && cfg.current.tilt) {
        const cx = tiltRect.left + tiltRect.width / 2
        const cy = tiltRect.top + tiltRect.height / 2
        const nx = clamp((mx - cx) / Math.max(tiltRect.width / 2, 1), -1, 1)
        const ny = clamp((my - cy) / Math.max(tiltRect.height / 2, 1), -1, 1)
        tiltX += (ny * -TILT_MAX_DEG - tiltX) * TILT_LERP
        tiltY += (nx * TILT_MAX_DEG - tiltY) * TILT_LERP
        write(
          tiltEl,
          "transform",
          `perspective(800px) rotateX(${tiltX.toFixed(3)}deg) rotateY(${tiltY.toFixed(3)}deg) translateY(-2px)`,
        )
      }

      // ---- idle sleep: THE performance fix (loop fully stops) ----
      if (
        now - lastActivity > IDLE_MS &&
        now - lastRippleAt > RIPPLE_SETTLE_MS &&
        settled &&
        !pendingTarget
      ) {
        running = false
        raf = 0
        return
      }
      raf = requestAnimationFrame(tick)
    }

    const startLoop = () => {
      if (!running) {
        running = true
        last = performance.now()
        raf = requestAnimationFrame(tick)
      }
    }

    // ---- pointer events (all passive; no layout reads on pointermove) ----
    const onMove = (e: PointerEvent) => {
      lastActivity = performance.now()
      mx = e.clientX
      my = e.clientY
      if (hidden) {
        hidden = false
        pmx = mx
        pmy = my
        rx = mx
        ry = my
        tx = mx
        ty = my
        trailX.fill(mx)
        trailY.fill(my)
        delete root.dataset.hidden
      }
      startLoop()
    }

    const onOver = (e: PointerEvent) => {
      if (e.pointerType === "touch") return
      const target = e.target
      if (target instanceof Element) {
        pendingTarget = target // resolved once, next frame
        lastActivity = performance.now()
        startLoop()
      }
    }

    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "touch") {
        deactivate() // hybrid device touched the screen — go native for good
        return
      }
      if (e.button !== 0) return
      lastActivity = performance.now()
      root.dataset.pressed = "1"
      if (cfg.current.ripple && mode !== "text" && mode !== "disabled" && performance.now() - lastRippleAt > 90) {
        lastRippleAt = performance.now()
        const ripple = el("div", "fx-ripple", root)
        ripple.style.left = `${e.clientX}px`
        ripple.style.top = `${e.clientY}px`
        ripple.addEventListener("animationend", () => ripple.remove(), { once: true })
        setTimeout(() => ripple.remove(), 600) // safety net
      }
    }

    const onUp = () => {
      delete root.dataset.pressed
    }

    const onLeave = () => {
      hidden = true
      root.dataset.hidden = "1"
      releaseMagnetic()
      releaseTilt()
    }

    const onVisibility = () => {
      if (document.hidden) {
        running = false
        cancelAnimationFrame(raf)
        raf = 0
      } else {
        startLoop() // sleeps again immediately if the pointer stayed idle
      }
    }

    const onScrollOrResize = () => {
      rectsDirty = true
      if (magEl || tiltEl) startLoop() // re-measure + re-place next frame
    }

    const onFineChange = (e: MediaQueryListEvent) => {
      if (!e.matches) deactivate()
    }
    const onReducedChange = (e: MediaQueryListEvent) => {
      if (e.matches) deactivate()
    }

    // theme flips (next-themes toggles .dark on <html>) recolor the cursor live
    const themeObs = new MutationObserver(() => applyCursorVars(root, cfg.current, isDark()))
    themeObs.observe(docEl, { attributes: true, attributeFilter: ["class"] })

    let deactivated = false
    const deactivate = () => {
      if (deactivated) return
      deactivated = true
      cleanup()
    }

    const attach = () => {
      docEl.classList.add("fx-on")
      window.addEventListener("pointermove", onMove, { passive: true })
      document.addEventListener("pointerover", onOver, { passive: true })
      window.addEventListener("pointerdown", onDown, { passive: true })
      window.addEventListener("pointerup", onUp, { passive: true })
      window.addEventListener("pointercancel", onUp, { passive: true })
      document.documentElement.addEventListener("pointerleave", onLeave)
      window.addEventListener("blur", onLeave)
      document.addEventListener("visibilitychange", onVisibility)
      window.addEventListener("scroll", onScrollOrResize, { passive: true })
      window.addEventListener("resize", onScrollOrResize, { passive: true })
      fineMq.addEventListener?.("change", onFineChange)
      reducedMq.addEventListener?.("change", onReducedChange)
    }

    const cleanup = () => {
      docEl.classList.remove("fx-on")
      window.removeEventListener("pointermove", onMove)
      document.removeEventListener("pointerover", onOver)
      window.removeEventListener("pointerdown", onDown)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onUp)
      document.documentElement.removeEventListener("pointerleave", onLeave)
      window.removeEventListener("blur", onLeave)
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("scroll", onScrollOrResize)
      window.removeEventListener("resize", onScrollOrResize)
      fineMq.removeEventListener?.("change", onFineChange)
      reducedMq.removeEventListener?.("change", onReducedChange)
      themeObs.disconnect()
      running = false
      cancelAnimationFrame(raf)
      clearTimeout(magTimer)
      clearTimeout(tiltTimer)
      if (magEl) {
        magEl.style.transition = ""
        write(magEl, "transform", "")
        magEl.classList.remove("fx-magnetic")
      }
      if (tiltEl) {
        tiltEl.style.transition = ""
        write(tiltEl, "transform", "")
        tiltEl.classList.remove("fx-tilt")
      }
      if (rootRef.current === root) rootRef.current = null
      if (labelRef.current === label) labelRef.current = null
      root.remove()
    }

    attach()
    return cleanup
  }, [enabled, style])

  return null // the engine DOM is created imperatively — nothing to hydrate
}
