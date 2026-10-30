"use client"
// ============ Map canvas — Leaflet wrapper (2026-10 round §60) ============
// Provider-abstracted map layer: Leaflet + OpenStreetMap tiles (no API key,
// no vendor lock-in). Loaded CLIENT-ONLY via dynamic import — Leaflet touches
// window at import time, so the component never renders during SSR. Tiles are
// NOT stored in the database; only geographic data (lat/lng/radius) persists.
import { useEffect, useRef, useState } from "react"
import type * as LeafletType from "leaflet"

/** V5-001: Sanitize popup HTML at the Leaflet sink.
 *  Strips dangerous tags/attrs while keeping safe display markup. */
function sanitizePopup(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/on\w+\s*=/gi, "data-blocked=")
    .replace(/javascript\s*:/gi, "")
    .replace(/href\s*=\s*["']?\s*javascript/gi, "href=\"#\"")
}

export type MapMarker = {
  id: string
  latitude: number
  longitude: number
  /** HTML for the marker pin (styled divIcon) */
  html?: string
  /** popup content (HTML string) */
  popup?: string
  /** polyline group id — points with the same group are connected in order */
  lineGroup?: string
  /** circle overlay (geo-fence) */
  circle?: { radiusM: number; color?: string; fillColor?: string }
  onClick?: () => void
}

export type MapCanvasProps = {
  center?: [number, number]
  zoom?: number
  markers?: MapMarker[]
  /** editable circle (geo-fence editor): center + radius callback */
  editableCircle?: { latitude: number; longitude: number; radiusM: number } | null
  onCircleChange?: (pos: { latitude: number; longitude: number; radiusM: number }) => void
  /** click-to-place (editor) */
  onMapClick?: (pos: { latitude: number; longitude: number }) => void
  /** 2026-10-13 — auto-fit the viewport to these [lat,lng] points whenever the
   * set changes (hit-map viewer). Single point → center + zoom 15. */
  fitTo?: [number, number][]
  className?: string
  style?: React.CSSProperties
}

const STATUS_COLORS: Record<string, string> = {
  TRACKING: "#059669",
  GPS_DISABLED: "#dc2626",
  LOW_ACCURACY: "#d97706",
  LOW_BATTERY: "#ea580c",
  OFFLINE: "#64748b",
  OFFLINE_AFTER_LOW_BATTERY: "#475569",
  // L-11 - POWER_OFF_UNCONFIRMED removed: never assigned by the evidence-based
  // status engine; dead color-map entries implied states the system cannot produce.
  OUTSIDE_GEOFENCE: "#e11d48",
  SUSPICIOUS: "#9333ea",
  NOT_TRACKING: "#94a3b8",
}

export function statusColor(status?: string | null): string {
  return STATUS_COLORS[status ?? ""] ?? "#0d9488"
}

export default function MapCanvas(props: MapCanvasProps) {
  const ref = useRef<HTMLDivElement>(null)
  const mapRef = useRef<LeafletType.Map | null>(null)
  const LRef = useRef<typeof LeafletType | null>(null)
  const layerRef = useRef<LeafletType.LayerGroup | null>(null)
  const circleRef = useRef<LeafletType.Circle | null>(null)
  const markerRefs = useRef<LeafletType.Marker[]>([])
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cbRef = useRef(props)
<<<<<<< HEAD
  // T-11 — ref writes belong to effects, not render. This runs after every
  // commit and BEFORE the map effect below (declaration order), so the
  // long-lived Leaflet instance always reads fresh props without
  // re-initializing on every prop change (the "latest props ref" pattern,
  // effect-flavored).
  useEffect(() => {
    cbRef.current = props
  })
=======
  cbRef.current = props
>>>>>>> origin/main

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const L = (await import("leaflet")).default
        await import("leaflet/dist/leaflet.css")
        if (cancelled || !ref.current || mapRef.current) return
        const map = L.map(ref.current, { center: props.center ?? [23.8103, 90.4125], zoom: props.zoom ?? 13, scrollWheelZoom: true })
        // L-14 — tile source is configurable (NEXT_PUBLIC_MAP_TILES_URL) so
        // privacy-sensitive or air-gapped deployments can point at an internal
        // tile server instead of the public OSM CDN (which receives viewer
        // IPs). Default remains OpenStreetMap with attribution preserved.
        const tileUrl = process.env.NEXT_PUBLIC_MAP_TILES_URL || "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        L.tileLayer(tileUrl, {
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        }).addTo(map)
        map.on("click", (e) => {
          cbRef.current.onMapClick?.({ latitude: e.latlng.lat, longitude: e.latlng.lng })
        })
        mapRef.current = map
        LRef.current = L
        layerRef.current = L.layerGroup().addTo(map)
        setReady(true)
      } catch {
        setError("Map failed to load — check your network connection to OpenStreetMap tiles.")
      }
    })()
    return () => {
      cancelled = true
      mapRef.current?.remove()
      mapRef.current = null
    }
  }, [])

  // render markers + lines + circles
  useEffect(() => {
    const L = LRef.current
    const map = mapRef.current
    const layer = layerRef.current
    if (!ready || !L || !map || !layer) return
    layer.clearLayers()
    markerRefs.current = []
    const lines = new Map<string, [number, number][]>()
    for (const m of props.markers ?? []) {
      if (m.lineGroup) {
        const arr = lines.get(m.lineGroup) ?? []
        arr.push([m.latitude, m.longitude])
        lines.set(m.lineGroup, arr)
      }
    }
    for (const m of props.markers ?? []) {
      if (m.circle) {
        L.circle([m.latitude, m.longitude], {
          radius: m.circle.radiusM,
          color: m.circle.color ?? "#0d9488",
          weight: 2,
          fillOpacity: 0.08,
          fillColor: m.circle.fillColor ?? "#0d9488",
        }).addTo(layer)
      }
      const icon = L.divIcon({
        className: "",
        html: m.html ?? `<div style="width:14px;height:14px;border-radius:50%;background:${statusColor()};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)"></div>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      })
      const marker = L.marker([m.latitude, m.longitude], { icon }).addTo(layer)
      if (m.popup) marker.bindPopup(sanitizePopup(m.popup), { maxWidth: 320 })
      if (m.onClick) marker.on("click", () => { m.onClick?.() })
      markerRefs.current.push(marker)
    }
    for (const pts of lines.values()) {
      if (pts.length > 1) L.polyline(pts, { color: "#0d9488", weight: 3, opacity: 0.7, dashArray: "6 6" }).addTo(layer)
    }
  }, [ready, props.markers])

  // 2026-10-13 — fit the viewport to the fitTo point set (hit-map viewer).
  // Keyed on the rounded coordinates so the effect only re-runs when the
  // SET changes, not on every parent render.
  const fitKey = (props.fitTo ?? []).map((p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).join("|")
  useEffect(() => {
    const L = LRef.current
    const map = mapRef.current
    if (!ready || !L || !map) return
    const pts = props.fitTo ?? []
    if (!pts.length) return
    if (pts.length === 1) { map.setView(pts[0], 15); return }
    map.fitBounds(L.latLngBounds(pts.map((p) => L.latLng(p[0], p[1]))), { padding: [32, 32] })
  }, [ready, fitKey])

  // editable circle (geo-fence editor): center marker draggable + radius circle
  // H-13 — while the user is dragging the center pin, this effect must NEVER
  // tear down and recreate the marker. The old version re-ran on every drag
  // tick (the parent round-tripped each coordinate through React state, the
  // effect deps changed, the cleanup removed the very marker being dragged),
  // making fence positioning by drag effectively unusable. Drag ticks now move
  // the circle directly and the parent state syncs ONCE on dragend.
  const isDraggingRef = useRef(false)
  useEffect(() => {
    const L = LRef.current
    const map = mapRef.current
    if (!ready || !L || !map) return
    if (isDraggingRef.current) return // mid-drag: keep the live marker
    circleRef.current?.remove()
    circleRef.current = null
    if (!props.editableCircle) return
    const { latitude, longitude, radiusM } = props.editableCircle
    const circle = L.circle([latitude, longitude], { radius: radiusM, color: "#059669", weight: 2, fillOpacity: 0.12 }).addTo(map)
    circleRef.current = circle
    const centerIcon = L.divIcon({
      className: "",
      html: `<div style="width:18px;height:18px;border-radius:50%;background:#059669;border:3px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.5);cursor:move"></div>`,
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    })
    const center = L.marker([latitude, longitude], { icon: centerIcon, draggable: true }).addTo(map)
    center.on("dragstart", () => { isDraggingRef.current = true })
    center.on("drag", (e: any) => {
      // visual-only during the drag: move the circle, do NOT round-trip the
      // coordinate through parent state (that is what recreated the marker)
      const ll = e.target.getLatLng()
      circle.setLatLng(ll)
    })
    center.on("dragend", (e: any) => {
      isDraggingRef.current = false
      const ll = e.target.getLatLng()
      cbRef.current.onCircleChange?.({ latitude: ll.lat, longitude: ll.lng, radiusM })
    })
    return () => {
      circle.remove()
      center.remove()
    }
  }, [ready, props.editableCircle?.latitude, props.editableCircle?.longitude, props.editableCircle?.radiusM])

  if (error) {
    return (
      <div className={`flex items-center justify-center h-full bg-slate-100 dark:bg-slate-800 rounded-lg text-sm text-slate-500 ${props.className ?? ""}`} style={{ minHeight: 240, ...props.style }}>
        {error}
      </div>
    )
  }
  return <div ref={ref} className={`rounded-lg overflow-hidden z-0 ${props.className ?? ""}`} style={{ height: 420, ...props.style }} />
}
