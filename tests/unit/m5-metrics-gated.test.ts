/// <reference types="bun-types" />
// ============ M-5 — /api/metrics fails CLOSED without HRM_INTERNAL_TOKEN ============
// Regression (audit M-5): when HRM_INTERNAL_TOKEN was unset the metrics
// endpoint served employee/user/device/camera counts and job-queue depth to
// ANYONE (the token check was skipped entirely). Fix: 503 when unconfigured.
import { describe, expect, it } from "bun:test"
import "./_testdb" // DB env first — the route module imports db
import { NextRequest } from "next/server"
import { GET } from "@/app/api/metrics/route"

function mkReq(headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost:3000/api/metrics", { headers })
}

describe("M-5 — /api/metrics is fail-closed", () => {
  const prev = process.env.HRM_INTERNAL_TOKEN

  it("returns 503 (not the metrics) when HRM_INTERNAL_TOKEN is unset", async () => {
    delete process.env.HRM_INTERNAL_TOKEN
    const res = await GET(mkReq())
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body?.error).toContain("disabled")
  })

  it("returns 401 for a wrong token when configured", async () => {
    process.env.HRM_INTERNAL_TOKEN = "t".repeat(32)
    const res = await GET(mkReq({ "x-internal-token": "wrong" }))
    expect(res.status).toBe(401)
  })

  it("serves metrics only with the correct token", async () => {
    process.env.HRM_INTERNAL_TOKEN = "t".repeat(32)
    const res = await GET(mkReq({ "x-internal-token": "t".repeat(32) }))
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("hrm_uptime_seconds")
  })

  it("after the token is unset again, the endpoint closes once more (no caching of the open state)", async () => {
    delete process.env.HRM_INTERNAL_TOKEN
    const res = await GET(mkReq({ "x-internal-token": "anything" }))
    expect(res.status).toBe(503)
    // restore for other suites
    if (prev) process.env.HRM_INTERNAL_TOKEN = prev
  })
})
