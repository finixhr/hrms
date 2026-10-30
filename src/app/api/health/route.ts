// ============ /api/health — lean liveness probe (audit M-10-rec) ============
// Unauthenticated by design (load balancers must reach it), but deliberately
// LEAN: no counts, no versions, no addresses — just process + DB status.
// Detailed diagnostics remain behind authenticated admin routes.
import { NextResponse } from "next/server"
import { db } from "@/lib/db"

export const dynamic = "force-dynamic"

export async function GET() {
  const startedAt = Date.now()
  try {
    await db.$queryRaw`SELECT 1`
    return NextResponse.json(
      { ok: true, db: "up", uptimeSec: Math.round(process.uptime()) },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    )
  } catch {
    return NextResponse.json(
      { ok: false, db: "down", uptimeSec: Math.round(process.uptime()), tookMs: Date.now() - startedAt },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    )
  }
}
