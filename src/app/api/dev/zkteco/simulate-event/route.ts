// ============ DEV-ONLY ZKTeco device simulator ============
// POST /api/dev/zkteco/simulate-event
// NEVER exposed in production (gated by NODE_ENV + ZKTECO_SIMULATOR_ENABLED).
// Lets developers test the full device-facing flow against /iclock/cdata using
// the exact same HTTP wire format a real ZKTeco SpeedFace/SenseFace terminal
// sends — so you can validate the gateway end-to-end without a physical device.
//
// Body:
//   { sn, pin, eventTime?: "YYYY-MM-DD HH:MM:SS", status?: 0..5|254|255,
//     verifyMode?: 1|3|4, workCode?: string, count?: number, mode?: "invalid"|"operlog"|"userinfo", key?: string }
import { NextRequest } from "next/server"
import { simulatorEnabled } from "@/hrm-server/zkteco/gateway"
import { getCtxFromToken } from "@/hrm-server/auth"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/** M-7 — the simulator injects synthetic attendance data: it requires an
 *  authenticated session holding devices.process, and only ever runs outside
 *  production (simulatorEnabled already enforces NODE_ENV + the opt-in). */
async function requireProcessPerm(req: NextRequest): Promise<Response | null> {
  if (process.env.NODE_ENV === "production") {
    return Response.json({ ok: false, error: "Simulator disabled (production)" }, { status: 404 })
  }
  const bearer = (req.headers.get("authorization") || "").toLowerCase().startsWith("bearer ")
    ? (req.headers.get("authorization") || "").slice(7).trim() : null
  const token = req.cookies.get("hrm_session")?.value || bearer || undefined
  const ctx = await getCtxFromToken(token)
  if (!ctx || !(ctx.permissions.has("devices.process") || ctx.permissions.has("*"))) {
    return Response.json({ ok: false, error: "devices.process permission required" }, { status: 403 })
  }
  return null
}

export async function POST(req: NextRequest) {
  if (!simulatorEnabled()) {
    return Response.json({ ok: false, error: "Simulator disabled (production)" }, { status: 404 })
  }
  const denied = await requireProcessPerm(req)
  if (denied) return denied
  let p: any
  try { p = await req.json() } catch {
    return Response.json({ ok: false, error: "JSON body required" }, { status: 400 })
  }

  const sn = String(p.sn || "")
  const key = p.key || null
  if (!sn) return Response.json({ ok: false, error: "sn is required" }, { status: 400 })

  const count = Math.min(Number(p.count || 1), 50)
  const now = new Date()
  const baseTime = p.eventTime
    ? p.eventTime
    : `${now.toISOString().slice(0, 10)} ${now.toTimeString().slice(0, 8)}`
  const lines: string[] = []

  if (p.mode === "invalid") {
    lines.push("this-is-not,a-valid,attlog,line")
  } else if (p.mode === "operlog") {
    // Simulate an OPERLOG push (power-on event)
    lines.push(`OPERLOG\t1\t${baseTime}\t1`)
  } else if (p.mode === "userinfo") {
    // Simulate a USERINFO roster push
    lines.push(`USERINFO\t${p.pin || 1}\t${p.name || "Test User"}\t0\t0\t0\t0\t0\t1`)
  } else {
    for (let i = 0; i < count; i++) {
      const d = new Date(baseTime.replace(" ", "T") + (baseTime.includes("Z") ? "" : "Z"))
      d.setSeconds(d.getSeconds() + i * 60)
      const t = d.toISOString().slice(0, 19).replace("T", " ")
      const status = p.status != null ? p.status : 0
      const verify = p.verifyMode ?? 3 // face
      lines.push([String(p.pin), String(verify), t, String(status), p.workCode || 0, 0, 0].join("\t"))
    }
  }

  // Build the exact URL + body a real device would send to /iclock/cdata
  const url = new URL("/iclock/cdata", req.nextUrl.origin)
  url.searchParams.set("SN", sn)
  if (key) url.searchParams.set("pushcommkey", String(key))

  const t0 = Date.now()
  const upstream = await fetch(url, {
    method: "POST",
    headers: { "content-type": "text/plain; charset=utf-8" },
    body: lines.join("\n"),
  })
  const responseText = await upstream.text()
  const elapsed = Date.now() - t0

  return Response.json({
    ok: upstream.ok,
    httpStatus: upstream.status,
    response: responseText,
    elapsedMs: elapsed,
    sentTo: url.toString(),
    lines: lines.length,
    body: lines.join("\n"),
  })
}

// ─── Handshake simulator: GET /api/dev/zkteco/simulate-event?mode=handshake&sn=...&key=... ───
// Triggers the device's initial handshake GET to /iclock/cdata so devs can
// see the full options text the server returns.
export async function GET(req: NextRequest) {
  if (!simulatorEnabled()) {
    return Response.json({ ok: false, error: "Simulator disabled (production)" }, { status: 404 })
  }
  const sn = req.nextUrl.searchParams.get("sn")
  const key = req.nextUrl.searchParams.get("key")
  if (!sn) return Response.json({ ok: false, error: "?sn= is required" }, { status: 400 })

  const url = new URL("/iclock/cdata", req.nextUrl.origin)
  url.searchParams.set("SN", sn)
  url.searchParams.set("options", "all")
  url.searchParams.set("pushver", "3.1.3")
  url.searchParams.set("language", "en")
  url.searchParams.set("FW", "Ver 6.60 Sep 4 2024")
  if (key) url.searchParams.set("pushcommkey", key)

  const t0 = Date.now()
  const upstream = await fetch(url)
  const text = await upstream.text()
  return Response.json({
    ok: upstream.ok,
    httpStatus: upstream.status,
    response: text,
    elapsedMs: Date.now() - t0,
    sentTo: url.toString(),
  })
}
