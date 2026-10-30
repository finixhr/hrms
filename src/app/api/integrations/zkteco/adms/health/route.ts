// ============ ADMS gateway health check (spec §34) ============
// GET /api/integrations/zkteco/adms/health — lean by default; detailed queue
// counts require the explicit env opt-in ZKTECO_ADMS_HEALTH_DETAILED=true
// (audit Low fix: the unauthenticated endpoint no longer discloses DB health,
// queue depth and device counts to anonymous callers).
import { db } from "@/lib/db"
import { sweepOnce } from "@/hrm-server/zkteco/gateway"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET() {
  const detailed = process.env.ZKTECO_ADMS_HEALTH_DETAILED === "true"
  const res: Record<string, unknown> = {
    service: "zkteco-attendance-gateway",
    timestamp: new Date().toISOString(),
  }
  if (!detailed) {
    try {
      await db.$queryRaw`SELECT 1`
      res.status = "healthy"
      return Response.json(res, { status: 200 })
    } catch {
      res.status = "unhealthy"
      return Response.json(res, { status: 503 })
    }
  }
  try {
    await db.$queryRaw`SELECT 1`
    res.database = "healthy"
  } catch {
    res.database = "unhealthy"
    res.status = "degraded"
  }
  try {
    // queue: pending/failed events across all tenants (counts only)
    const received = await db.attendanceRawEvent.count({ where: { processingStatus: "RECEIVED" } })
    const failed = await db.attendanceRawEvent.count({ where: { processingStatus: "FAILED" } })
    res.queue = failed > 50 ? "degraded" : "healthy"
    res.queueCounts = { received, failed }
  } catch {
    res.queue = "unknown"
  }
  res.hrmApi = "healthy" // same process — the HRM dispatcher IS this service
  try {
    const devices = await db.attendanceDevice.count({ where: { enabled: true } })
    res.enabledDevices = devices
  } catch { /* ignore */ }
  res.status = res.status || (res.database === "healthy" ? "healthy" : "unhealthy")
  return Response.json(res, { status: res.status === "healthy" ? 200 : 503 })
}

// allow ops to nudge a sweep via the health endpoint (no body needed).
// M-7 — the POST is destructive-ish (forces a sweep across all tenants): it
// requires the shared ops token from HRM_INTERNAL_TOKEN, so an anonymous
// internet caller cannot use it as a free compute trigger.
export async function POST(req: Request) {
  const expected = process.env.HRM_INTERNAL_TOKEN
  if (!expected) {
    return Response.json({ ok: false, error: "Sweep trigger disabled — set HRM_INTERNAL_TOKEN to enable it" }, { status: 503 })
  }
  const presented = req.headers.get("x-internal-token") || ""
  if (presented !== expected) {
    return Response.json({ ok: false, error: "Invalid internal token" }, { status: 401 })
  }
  const r = await sweepOnce()
  return Response.json({ ok: true, swept: r })
}
