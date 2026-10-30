"use client"
// ============ In-app selfie capture + framing guidance (Selfie Attendance G1) ============
// Rysenova-parity upgrade for the selfie punch. Before this module the ESS
// portal handed the whole capture to the OS: a hidden <input type="file"
// capture="user"> opened the native camera app / file picker, so there was
//
//   - no in-page preview, no framing guide, no "face not detected / too dark /
//     move closer" feedback,
//   - no capture-quality signal for the server (an admin could not tell a
//     crisp, well-lit selfie from a black frame),
//   - inconsistent UX across browsers (iOS Safari vs desktop webcam).
//
// This module owns the capture UX with a three-tier ladder so NO browser is
// left without a working path:
//
//   Tier A  LIVE_CAMERA   getUserMedia + in-page preview + live framing
//                         guidance + auto/manual shutter. Requires a secure
//                         context (HTTPS or localhost) — see the
//                         Permissions-Policy note in next.config.ts.
//   Tier B  FILE_PICKER   the ORIGINAL hidden-input path (capture="user").
//                         Used when getUserMedia is unavailable/insecure.
//   Tier C  FILE_PICKER   permission denied / no camera → the same fallback
//                         plus an explicit, actionable explanation.
//
// The server contract is UNCHANGED: the dialog resolves a `data:image/jpeg`
// base64 data URL which the ESS portal sends as `selfieDataUrl`. The only
// addition is optional `selfieQuality` metadata (see CaptureQuality) — the
// server stores it as evidence provenance and NEVER uses it to decide
// verification status (§27: a selfie is EVIDENCE, never identity proof).
//
// Everything above the component is PURE (no DOM, no React) so the grading
// rules can be unit-tested and reviewed independently of the camera.
import { useCallback, useEffect, useRef, useState } from "react"
import { Camera, Loader2, RefreshCw, ShieldCheck, Upload, X } from "lucide-react"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"

// ================================================================ pure engine

/** How the bytes reaching the server were produced. */
export type CaptureMethod = "LIVE_CAMERA" | "FILE_PICKER"

/** Per-capture provenance + quality. Sent as `selfieQuality` (optional). */
export type CaptureQuality = {
  score: number // 0–100 overall capture quality
  method: CaptureMethod
  /** null = the runtime could not decide (no FaceDetector, or fallback path) */
  faceDetected: boolean | null
  faceRatio: number | null // face box area ÷ frame area (0–1)
  brightness: number // mean luma, 0–1
  sharpness: number // normalised variance-of-Laplacian, 0–1
  width: number
  height: number
  bytesApprox: number // decoded JPEG size estimate (base64 length × ¾)
}

export type SelfieResult = { dataUrl: string; quality: CaptureQuality }

/** Thresholds are exported so tests and reviewers can see the exact rules. */
export const QUALITY_THRESHOLDS = {
  /** Below this the face occupies too little of the frame → "move closer". */
  minFaceRatio: 0.05,
  /** Above this the face is cropped → "move back". */
  maxFaceRatio: 0.8,
  /** Ideal face coverage used for scoring (selfie framing). */
  idealFaceRatio: 0.22,
  /** Darker than this → "too dark". */
  minBrightness: 0.22,
  /** Brighter than this → blown out. */
  maxBrightness: 0.93,
  /** Ideal mean luma (mid-grey). */
  idealBrightness: 0.55,
  /** Blurrier than this → "hold still". */
  minSharpness: 0.22,
  /** A frame this good is a "ready" frame (drives auto-capture). */
  readyScore: 72,
} as const

export type FrameMetrics = { brightness: number; sharpness: number; contrast: number }

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return n < 0 ? 0 : n > 1 ? 1 : n
}

/** 3-decimal rounding — metadata is diagnostics, not measurement science. */
export function round3(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0
}
/**
 * Grayscale frame metrics. `gray` is row-major, one byte per pixel.
 *
 * brightness  mean luma / 255.
 * sharpness   variance-of-Laplacian (the standard focus measure) mapped to
 *             0–1 via sqrt/30 — a crisp portrait scores ~0.5–1.0, a blurred
 *             or hand-shaken frame ~0.05–0.2, a flat dark frame ~0.
 * contrast    luma standard deviation / 255 (0 = a flat frame with no content).
 */
export function computeFrameMetrics(gray: Uint8ClampedArray | number[], w: number, h: number): FrameMetrics {
  const n = Math.max(1, w * h)
  let sum = 0
  for (let i = 0; i < n; i++) sum += gray[i] || 0
  const mean = sum / n

  let sq = 0
  for (let i = 0; i < n; i++) {
    const d = (gray[i] || 0) - mean
    sq += d * d
  }
  const stdDev = Math.sqrt(sq / n)

  // 4-neighbour Laplacian, skipping the 1px border (keeps the kernel in-bounds)
  let lapSum = 0
  let lapCount = 0
  if (w > 2 && h > 2) {
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x
        const lap = 4 * (gray[i] || 0) - (gray[i - 1] || 0) - (gray[i + 1] || 0) - (gray[i - w] || 0) - (gray[i + w] || 0)
        lapSum += lap * lap
        lapCount++
      }
    }
  }
  const lapVar = lapCount ? lapSum / lapCount : 0

  return {
    brightness: clamp01(mean / 255),
    sharpness: clamp01(Math.sqrt(lapVar) / 30),
    contrast: clamp01(stdDev / 255),
  }
}

/** RGBA pixels → grayscale luma, one byte per pixel. */
export function toGrayscale(rgba: Uint8ClampedArray | number[], pixelCount: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixelCount)
  for (let i = 0; i < pixelCount; i++) {
    const o = i * 4
    // ITU-R BT.601 luma (what the eye perceives)
    out[i] = 0.299 * (rgba[o] || 0) + 0.587 * (rgba[o + 1] || 0) + 0.114 * (rgba[o + 2] || 0)
  }
  return out
}

/** Rough decoded byte count from a base64 data URL (no atob in the hot path). */
export function approxBytesFromDataUrl(dataUrl: string): number {
  const comma = dataUrl.indexOf(",")
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding)
}

/** Longest-edge downscale maths, shared by every capture tier. */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const longest = Math.max(width, height, 1)
  if (longest <= max) return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) }
  const scale = max / longest
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

export type CaptureTier = "LIVE_CAMERA" | "FILE_PICKER"

/** Which capture tier this runtime supports. */
export function detectCaptureTier(): CaptureTier {
  if (typeof window === "undefined" || typeof navigator === "undefined") return "FILE_PICKER"
  // getUserMedia is gated on a secure context — http://LAN-IP is NOT secure,
  // so the LAN-access dev flow must fall back to the file picker.
  if (!window.isSecureContext) return "FILE_PICKER"
  if (!navigator.mediaDevices?.getUserMedia) return "FILE_PICKER"
  return "LIVE_CAMERA"
}

export type FrameVerdict = {
  /** true = framing/light/focus all acceptable — the shutter is safe to fire. */
  ready: boolean
  /** 0–100 overall quality for THIS frame. */
  score: number
  /** Ordered, operator-facing hints. Empty when `ready`. */
  guidance: string[]
  /** The single most important hint, or "Perfect — hold still" when ready. */
  primary: string
}
/**
 * The framing-guidance rules. Pure and deterministic — the dialog and the
 * unit tests grade frames through this one function.
 *
 * `faceDetected === null` means "unknown" (the runtime has no FaceDetector, or
 * the frame came from the file-picker fallback). Unknown is scored neutrally
 * and never produces face guidance, so a browser without the FaceDetector API
 * is not punished for a capability it lacks.
 */
export function gradeFrame(input: {
  faceDetected: boolean | null
  faceRatio?: number | null
  brightness: number
  sharpness: number
}): FrameVerdict {
  const T = QUALITY_THRESHOLDS
  const guidance: string[] = []

  // ---- face term (45%) ----
  let faceTerm: number
  if (input.faceDetected === null) {
    faceTerm = 0.7 // unknown — neutral, neither rewarded nor punished
  } else if (!input.faceDetected) {
    faceTerm = 0
    guidance.push("No face detected — face the camera")
  } else {
    const ratio = input.faceRatio ?? T.idealFaceRatio
    if (ratio < T.minFaceRatio) {
      faceTerm = 0.35
      guidance.push("Move closer to the camera")
    } else if (ratio > T.maxFaceRatio) {
      faceTerm = 0.35
      guidance.push("Move back a little — your face is cropped")
    } else {
      // 1.0 at the ideal coverage, decaying linearly toward the extremes
      const dist = Math.abs(ratio - T.idealFaceRatio) / Math.max(0.01, T.maxFaceRatio - T.minFaceRatio)
      faceTerm = clamp01(1 - dist * 1.6)
    }
  }

  // ---- brightness term (25%) ----
  let brightTerm: number
  if (input.brightness < T.minBrightness) {
    brightTerm = clamp01(input.brightness / T.minBrightness) * 0.4
    guidance.push("Too dark — move to better light")
  } else if (input.brightness > T.maxBrightness) {
    brightTerm = 0.4
    guidance.push("Too bright — avoid pointing at a light source")
  } else {
    const dist = Math.abs(input.brightness - T.idealBrightness) / (T.maxBrightness - T.minBrightness)
    brightTerm = clamp01(1 - dist * 1.4)
  }

  // ---- focus term (30%) ----
  let sharpTerm: number
  if (input.sharpness < T.minSharpness) {
    sharpTerm = clamp01(input.sharpness / T.minSharpness) * 0.35
    guidance.push("Hold still — the image is blurry")
  } else {
    sharpTerm = clamp01(input.sharpness)
  }

  const score = Math.round(100 * clamp01(0.45 * faceTerm + 0.25 * brightTerm + 0.3 * sharpTerm))
  const ready = guidance.length === 0 && score >= QUALITY_THRESHOLDS.readyScore
  return { ready, score, guidance, primary: guidance[0] || "Perfect — hold still" }
}

// ================================================================ the dialog

/** Analysis frame size — small on purpose: the guidance loop runs ~4×/s on a
 *  phone and a 160px frame is plenty for luma/Laplacian/face-box statistics. */
const ANALYSIS_EDGE = 160
const ANALYSIS_INTERVAL_MS = 250
/** Consecutive "ready" frames required before hands-free capture fires. */
const AUTO_CAPTURE_STREAK = 3
/** H-11 — the fallback picker must always settle (OS pickers can fire neither
 *  `change` nor `cancel`). */
const PICKER_TIMEOUT_MS = 90_000

export type SelfieCaptureDialogProps = {
  open: boolean
  title?: string
  hint?: string
  /** The captured selfie + provenance/quality metadata. */
  onCaptured: (result: SelfieResult) => void
  /** Dismissed without capturing. Callers must treat this as "no selfie" and
   *  surface it as a cancellation — never as a silent success. */
  onCancel: () => void
  /** Longest-edge downscale target. 640 keeps the payload well under the
   *  server's 2 MB decoded cap (matching the historical client behaviour). */
  maxEdge?: number
  jpegQuality?: number
  /** Offer the hands-free shutter (fires once the frame is good for ~0.75s). */
  autoCapture?: boolean
}

export function SelfieCaptureDialog({
  open, title = "Selfie check-in", hint, onCaptured, onCancel,
  maxEdge = 640, jpegQuality = 0.82, autoCapture = true,
}: SelfieCaptureDialogProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const analysisRef = useRef<HTMLCanvasElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const timerRef = useRef<number>(0)
  const streakRef = useRef(0)
  const settleRef = useRef(false)
  const pickerSettleRef = useRef<((v: SelfieResult | null) => void) | null>(null)

  const [tier, setTier] = useState<CaptureTier>("LIVE_CAMERA")
  const [phase, setPhase] = useState<"starting" | "live" | "fallback" | "denied">("starting")
  const [facing, setFacing] = useState<"user" | "environment">("user")
  const [verdict, setVerdict] = useState<FrameVerdict | null>(null)
  const [handsFree, setHandsFree] = useState(autoCapture)
  const [shooting, setShooting] = useState(false)
  const [note, setNote] = useState<string | null>(hint ?? null)

  /** Release every camera resource. Safe to call repeatedly. */
  const stopAll = useCallback(() => {
    if (timerRef.current) { window.clearTimeout(timerRef.current); timerRef.current = 0 }
    const stream = streamRef.current
    streamRef.current = null
    if (stream) for (const track of stream.getTracks()) { try { track.stop() } catch { /* already ended */ } }
    const v = videoRef.current
    if (v) { try { v.srcObject = null } catch { /* ignore */ } }
    streakRef.current = 0
  }, [])

  /** Analyse one video frame and update the guidance overlay. */
  const analyseOnce = useCallback(async (): Promise<FrameVerdict | null> => {
    const video = videoRef.current
    const canvas = analysisRef.current
    if (!video || !canvas || !video.videoWidth) return null
    const size = fitWithin(video.videoWidth, video.videoHeight, ANALYSIS_EDGE)
    canvas.width = size.width
    canvas.height = size.height
    const ctx = canvas.getContext("2d", { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(video, 0, 0, size.width, size.height)

    let metrics: FrameMetrics
    try {
      const data = ctx.getImageData(0, 0, size.width, size.height)
      metrics = computeFrameMetrics(toGrayscale(data.data, size.width * size.height), size.width, size.height)
    } catch {
      // A tainted/failed read must not kill the preview — guidance just pauses.
      return null
    }

    // FaceDetector is a progressive-enhancement API (Chromium behind a flag /
    // Android WebView). Absent ⇒ faceDetected stays null and the guidance
    // degrades to light + focus only.
    let faceDetected: boolean | null = null
    let faceRatio: number | null = null
    const Detector = (globalThis as any).FaceDetector
    if (typeof Detector === "function") {
      try {
        const faces = await new Detector({ fastMode: true, maxDetectedFaces: 1 }).detect(canvas)
        if (Array.isArray(faces)) {
          faceDetected = faces.length > 0
          const box = faces[0]?.boundingBox
          faceRatio = box ? (box.width * box.height) / (size.width * size.height) : null
        }
      } catch { /* detector unavailable for this source — keep null */ }
    }

    const v = gradeFrame({ faceDetected, faceRatio, brightness: metrics.brightness, sharpness: metrics.sharpness })
    setVerdict(v)
    return v
  }, [])

  /** Measure a rendered canvas (the frame that will actually be uploaded). */
  const measureCanvas = (source: HTMLCanvasElement): { brightness: number; sharpness: number; score: number } | null => {
    try {
      const small = fitWithin(source.width, source.height, ANALYSIS_EDGE)
      const probe = document.createElement("canvas")
      probe.width = small.width
      probe.height = small.height
      const pctx = probe.getContext("2d", { willReadFrequently: true })
      if (!pctx) return null
      pctx.drawImage(source, 0, 0, small.width, small.height)
      const d = pctx.getImageData(0, 0, small.width, small.height)
      const m = computeFrameMetrics(toGrayscale(d.data, small.width * small.height), small.width, small.height)
      const v = gradeFrame({ faceDetected: null, brightness: m.brightness, sharpness: m.sharpness })
      return { brightness: round3(m.brightness), sharpness: round3(m.sharpness), score: v.score }
    } catch {
      // metrics are best-effort provenance, never blocking
      return null
    }
  }

  /** Fire the shutter: downscale the live preview and resolve the caller. */
  const shoot = useCallback(() => {
    const video = videoRef.current
    if (!video || !video.videoWidth || settleRef.current) return
    setShooting(true)
    try {
      const size = fitWithin(video.videoWidth, video.videoHeight, maxEdge)
      const canvas = document.createElement("canvas")
      canvas.width = size.width
      canvas.height = size.height
      const ctx = canvas.getContext("2d")
      if (!ctx) { setNote("Could not read the camera frame — try again"); setShooting(false); return }
      // mirror the preview so the saved selfie matches the framed image
      if (facing === "user") { ctx.translate(size.width, 0); ctx.scale(-1, 1) }
      ctx.drawImage(video, 0, 0, size.width, size.height)
      const dataUrl = canvas.toDataURL("image/jpeg", jpegQuality)

      // Re-derive the metrics from the SAVED frame (not the analysis frame) so
      // the metadata describes the exact bytes the server receives.
      const measured = measureCanvas(canvas)
      const faceUnknown = !verdict || verdict.guidance.some((g) => /face/i.test(g)) ? false : true
      const quality: CaptureQuality = {
        score: measured?.score ?? verdict?.score ?? 0,
        method: "LIVE_CAMERA",
        faceDetected: verdict ? faceUnknown : null,
        faceRatio: null,
        brightness: measured?.brightness ?? 0,
        sharpness: measured?.sharpness ?? 0,
        width: size.width,
        height: size.height,
        bytesApprox: approxBytesFromDataUrl(dataUrl),
      }

      settleRef.current = true
      stopAll()
      onCaptured({ dataUrl, quality })
    } finally {
      setShooting(false)
    }
  }, [facing, jpegQuality, maxEdge, measureCanvas, onCaptured, stopAll, verdict])

  // The guidance loop outlives individual renders — read the toggle from a ref
  // so flipping "Hands-free" never restarts the camera stream.
  const handsFreeRef = useRef(handsFree)
  useEffect(() => { handsFreeRef.current = handsFree }, [handsFree])

  /** Start (or restart) the live preview for the requested camera. */
  const startCamera = useCallback(async (mode: "user" | "environment") => {
    stopAll()
    setPhase("starting")
    setVerdict(null)
    setNote(hint ?? null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: mode, width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: false,
      })
      streamRef.current = stream
      const video = videoRef.current
      if (!video) { stopAll(); return }
      video.srcObject = stream
      try { await video.play() } catch { /* autoplay rejection — the loop still reads frames */ }
      setPhase("live")

      // Self-scheduling loop (setTimeout, not rAF: ~4fps is plenty for
      // guidance and it keeps ticking when the tab is not painting).
      const tick = async () => {
        if (!streamRef.current) return
        const v = await analyseOnce()
        if (handsFreeRef.current && v?.ready) {
          streakRef.current += 1
          if (streakRef.current >= AUTO_CAPTURE_STREAK) { shoot(); return }
        } else {
          streakRef.current = 0
        }
        timerRef.current = window.setTimeout(tick, ANALYSIS_INTERVAL_MS)
      }
      timerRef.current = window.setTimeout(tick, ANALYSIS_INTERVAL_MS)
    } catch (e: any) {
      const name = String(e?.name || "")
      if (name === "NotAllowedError" || name === "SecurityError") {
        setPhase("denied")
        setNote("Camera access was blocked. Allow the camera for this site, or upload a photo instead.")
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        setPhase("fallback")
        setNote("No camera was found on this device — upload a photo instead.")
      } else {
        setPhase("fallback")
        setNote(`${e?.message || "The camera could not be started"} — upload a photo instead.`)
      }
    }
  }, [analyseOnce, hint, shoot, stopAll])

  // Reset per open/close. Opening: pick the tier and start the camera.
  // Closing: tear every resource down — a live track left running keeps the
  // phone's camera LED on and drains the battery.
  useEffect(() => {
    if (!open) { settleRef.current = true; stopAll(); return }
    settleRef.current = false
    pickerSettleRef.current = null
    const t = detectCaptureTier()
    setTier(t)
    if (t === "LIVE_CAMERA") {
      void startCamera("user")
    } else {
      // Tier B (no secure context / no getUserMedia) — the picker is the only
      // path, so land directly on the fallback explanation.
      setPhase("fallback")
      setNote(hint ?? "Upload a photo for your attendance proof.")
    }
    return () => { stopAll() }
     
  }, [open])

  // H-11 — the picker promise must settle on EVERY outcome. Cancelling the OS
  // picker fires `cancel` (and NO `change`); some browsers fire neither, so a
  // 90s safety timeout covers them. Everything settles exactly once.
  const openPicker = useCallback((): Promise<SelfieResult | null> => {
    return new Promise((resolve) => {
      const input = fileRef.current
      let settled = false
      let timer = 0
      const finish = (v: SelfieResult | null) => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        input?.removeEventListener("cancel", onCancel)
        pickerSettleRef.current = null
        resolve(v)
      }
      const onCancel = () => finish(null)
      timer = window.setTimeout(() => finish(null), PICKER_TIMEOUT_MS)
      pickerSettleRef.current = finish
      input?.addEventListener("cancel", onCancel)
      input?.click()
    })
  }, [])

  const onFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = "" // allow re-picking the same file
    const settle = pickerSettleRef.current
    if (!file) { settle?.(null); return }
    try {
      const result = await processImageFile(file, maxEdge, jpegQuality)
      settle?.(result)
    } catch {
      setNote("Could not read that image — pick another file, or retry the camera.")
      settle?.(null)
    }
  }

  const switchCamera = useCallback(() => {
    const next = facing === "user" ? "environment" : "user"
    setFacing(next)
    void startCamera(next)
  }, [facing, startCamera])

  const dismiss = () => { settleRef.current = true; stopAll(); onCancel() }

  const showLive = tier === "LIVE_CAMERA" && (phase === "live" || phase === "starting")
  const pct = verdict?.score ?? 0
  const ringColor = verdict?.ready ? "#10b981" : pct >= 45 ? "#f59e0b" : "#f43f5e"

  /** Hand a picker result back to the caller (shared by the three upload buttons). */
  const usePicked = async () => {
    const r = await openPicker()
    if (!r) return
    settleRef.current = true
    stopAll()
    onCaptured(r)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) dismiss() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">{title}</DialogTitle>
          <DialogDescription className="text-xs">
            Your photo is stored privately as attendance evidence and is only visible to
            authorised HR staff. It is never used for facial recognition or identity verification.
          </DialogDescription>
        </DialogHeader>

        {/* ---- preview / guidance stage ---- */}
        <div className="relative w-full overflow-hidden rounded-xl bg-slate-900" style={{ aspectRatio: "4 / 3" }}>
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            className={`h-full w-full object-cover ${facing === "user" ? "-scale-x-100" : ""} ${showLive ? "" : "opacity-0"}`}
          />
          {/* hidden analysis surface — never shown, read ~4×/s for guidance */}
          <canvas ref={analysisRef} className="hidden" />

          {/* framing guide (the "AI framing" oval). Solid + green once good. */}
          {showLive && (
            <svg viewBox="0 0 100 75" className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
              <ellipse
                cx="50" cy="37" rx="21" ry="28"
                fill="none"
                stroke={verdict?.ready ? "#34d399" : "rgba(255,255,255,.65)"}
                strokeWidth="0.7"
                strokeDasharray={verdict?.ready ? "0" : "3 2"}
              />
            </svg>
          )}

          {/* live quality score */}
          {showLive && (
            <div
              className="absolute right-2 top-2 flex h-9 w-9 items-center justify-center rounded-full text-[11px] font-bold text-white shadow"
              style={{ background: ringColor }}
              title="Capture quality"
            >
              {pct}
            </div>
          )}

          {/* starting overlay */}
          {phase === "starting" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/90">
              <Loader2 className="h-6 w-6 animate-spin" />
              <p className="text-xs">Starting the camera…</p>
            </div>
          )}

          {/* denial / fallback explanation sits ON the stage so it is unmissable */}
          {(phase === "denied" || phase === "fallback") && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-5 text-center text-white/90">
              <Camera className="h-7 w-7 opacity-70" />
              <p className="text-xs leading-relaxed">{note}</p>
              <Button size="sm" variant="secondary" onClick={usePicked}>
                <Upload className="mr-1.5 h-3.5 w-3.5" /> Upload a photo
              </Button>
              {phase === "denied" && (
                <Button size="sm" variant="ghost" className="text-white/80 hover:text-white" onClick={() => startCamera(facing)}>
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> I allowed it — retry
                </Button>
              )}
            </div>
          )}

          {/* guidance banner */}
          {phase === "live" && verdict && (
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-3 py-2">
              <p className={`text-[12px] font-medium ${verdict.ready ? "text-emerald-300" : "text-amber-200"}`}>
                {verdict.primary}
              </p>
              {verdict.guidance.length > 1 && (
                <p className="text-[11px] text-white/70">{verdict.guidance.slice(1).join(" · ")}</p>
              )}
            </div>
          )}
        </div>

        {/* provenance line — tells the operator exactly what is recorded */}
        <div className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-[11px] text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
          <span>
            {tier === "LIVE_CAMERA" ? "Live camera · " : "Photo upload · "}
            downscaled to ≤{maxEdge}px JPEG. Capture quality is recorded for HR review only —
            it never marks your punch as verified or unverified.
          </span>
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="sm" onClick={dismiss}>
              <X className="mr-1 h-3.5 w-3.5" /> Cancel
            </Button>
            {phase === "live" && (
              <Button variant="ghost" size="sm" onClick={switchCamera} title="Switch camera">
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            )}
            {phase === "live" && (
              <Button
                variant={handsFree ? "secondary" : "ghost"} size="sm"
                onClick={() => setHandsFree((v) => !v)}
                title="Auto-capture once the framing, light and focus are good"
              >
                Hands-free
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {phase === "live" && (
              <Button variant="outline" size="sm" onClick={usePicked}>
                <Upload className="mr-1.5 h-3.5 w-3.5" /> Upload
              </Button>
            )}
            <Button size="sm" disabled={!showLive || shooting || phase === "starting"} onClick={shoot}>
              {shooting ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Camera className="mr-1.5 h-3.5 w-3.5" /> Capture</>}
            </Button>
          </div>
        </DialogFooter>

        {/* Tier B/C — the original hidden-input path (capture="user" = front camera) */}
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          capture="user"
          className="hidden"
          onChange={onFilePicked}
        />
      </DialogContent>
    </Dialog>
  )
}

// ================================================================ fallback codec

/**
 * Tier B/C — turn a picked image file into the same SelfieResult the live
 * camera produces, so the server sees ONE payload shape regardless of how the
 * bytes were obtained. `faceDetected` is null here (detection is not run on
 * uploaded photos): this tier's quality is light + focus only.
 */
export async function processImageFile(file: File, maxEdge = 640, jpegQuality = 0.82): Promise<SelfieResult> {
  const bitmapUrl = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error("Could not decode that image"))
      el.src = bitmapUrl
    })
    const size = fitWithin(img.naturalWidth || img.width, img.naturalHeight || img.height, maxEdge)
    const canvas = document.createElement("canvas")
    canvas.width = size.width
    canvas.height = size.height
    const ctx = canvas.getContext("2d", { willReadFrequently: true })
    if (!ctx) throw new Error("no canvas")
    ctx.drawImage(img, 0, 0, size.width, size.height)
    const dataUrl = canvas.toDataURL("image/jpeg", jpegQuality)

    const quality: CaptureQuality = {
      score: 0, method: "FILE_PICKER", faceDetected: null, faceRatio: null,
      brightness: 0, sharpness: 0, width: size.width, height: size.height,
      bytesApprox: approxBytesFromDataUrl(dataUrl),
    }
    try {
      const small = fitWithin(size.width, size.height, ANALYSIS_EDGE)
      const probe = document.createElement("canvas")
      probe.width = small.width
      probe.height = small.height
      const pctx = probe.getContext("2d", { willReadFrequently: true })
      if (pctx) {
        pctx.drawImage(canvas, 0, 0, small.width, small.height)
        const d = pctx.getImageData(0, 0, small.width, small.height)
        const m = computeFrameMetrics(toGrayscale(d.data, small.width * small.height), small.width, small.height)
        const v = gradeFrame({ faceDetected: null, brightness: m.brightness, sharpness: m.sharpness })
        quality.score = v.score
        quality.brightness = round3(m.brightness)
        quality.sharpness = round3(m.sharpness)
      }
    } catch { /* metrics are best-effort provenance */ }

    return { dataUrl, quality }
  } finally {
    URL.revokeObjectURL(bitmapUrl)
  }
}








