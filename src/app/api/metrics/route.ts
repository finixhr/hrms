// OPS-R8 (this audit) + Phase 1 WS "Metrics foundation" — Prometheus-compatible
// metrics endpoint.
//
// Returns route-timing, scheduler-tick and queue gauges for LB/monitoring.
// Auth-gated by the HRM_INTERNAL_TOKEN header (same as ADMS health POST) so
// the public cannot scrape internal state; the endpoint FAILS CLOSED when no
// token is configured.
//
// OPS-4 (Phase 1) — the scrape itself no longer runs any unbounded query: the
// OLD version executed ~10 COUNT(*) per scrape (the most expensive endpoint
// on the platform at scale). All DB-derived numbers are served from a 30 s
// TTL cache maintained by hrm-server/metrics; the timing rings are in-memory.

import { NextRequest, NextResponse } from "next/server"
import { safeEqual } from "@/hrm-server/security"
import { renderPrometheus } from "@/hrm-server/metrics"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(req: NextRequest) {
  const expected = process.env.HRM_INTERNAL_TOKEN || ""
  if (!expected) {
    // M-5 — fail CLOSED: with no token configured there is nothing to
    // authenticate the request against.
    return NextResponse.json(
      { ok: false, error: "Metrics endpoint disabled — HRM_INTERNAL_TOKEN is not configured" },
      { status: 503 },
    )
  }
  const presented = req.headers.get("x-internal-token") || req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || ""
  if (!safeEqual(presented, expected)) {
    return NextResponse.json({ ok: false, error: "Invalid internal token" }, { status: 401 })
  }

  let body: string
  try {
    body = await renderPrometheus()
  } catch (e: any) {
    body = `# HELP hrm_metrics_error Metrics collection error\n# TYPE hrm_metrics_error gauge\nhrm_metrics_error{reason="${String(e?.message || e).slice(0, 100).replace(/"/g, "'")}"} 1\n`
  }

  return new NextResponse(body, {
    status: 200,
    headers: {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
      "cache-control": "no-store",
    },
  })
}
