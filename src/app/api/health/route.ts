// ============ /api/health — lean liveness probe (audit M-10-rec) ============
// Unauthenticated by design (load balancers must reach it), but deliberately
// LEAN: no counts, no versions, no addresses — just process + DB status.
// Detailed diagnostics remain behind authenticated admin routes.
//
// FIN-032 (Phase 2) — the `product` marker: the Finix HR desktop shell
// verifies a configured server BEFORE navigating its native window there
// (no address bar → a phishing clone inside the trusted app frame). The
// shell fetches GET /api/health and requires `ok: true` AND
// `product === "finix-hr"` — a constant string, no information leak — plus
// permissive CORS on this one route so the check is readable cross-origin
// from the shell's webview origin (tauri://localhost / http://tauri.localhost).
// An attacker's look-alike server that never runs Finix HR fails the check.
import { NextResponse } from "next/server"
import { db } from "@/lib/db"

export const dynamic = "force-dynamic"

const PRODUCT = "finix-hr"

const HEADERS = {
  "Cache-Control": "no-store",
  // FIN-032 — let the desktop shell (and only read-only probes like it)
  // read this unauthenticated liveness payload cross-origin.
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD",
  "Access-Control-Allow-Headers": "content-type",
}

export async function GET() {
  const startedAt = Date.now()
  try {
    await db.$queryRaw`SELECT 1`
    return NextResponse.json(
      { ok: true, product: PRODUCT, db: "up", uptimeSec: Math.round(process.uptime()) },
      { status: 200, headers: HEADERS },
    )
  } catch {
    return NextResponse.json(
      { ok: false, product: PRODUCT, db: "down", uptimeSec: Math.round(process.uptime()), tookMs: Date.now() - startedAt },
      { status: 503, headers: HEADERS },
    )
  }
}
