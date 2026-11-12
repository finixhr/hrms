// ============ FIN-036 (Phase 3) — perf trend engine unit tests ============
// The trend gate's verdict logic is pure and unit-tested here so the lane
// is verifiable WITHOUT k6 hardware (the sandbox/CI runners that lack the
// binary still prove the gate's math; the nightly lane exercises the real
// path against staging).
import { describe, expect, test } from "bun:test"
import { evaluateTrend, p95OfSummary } from "../../scripts/perf-trend.mjs"

const budgets = {
  "payroll-preflight": { p95_ms: 1200 },
  "payroll-run-payment": { p95_ms: 800 },
  "leave-approval": { p95_ms: 800 },
}

const run = (p95s: [number, number, number][]) => p95s.map((p: [number, number, number], i: number) => ({
  ts: `2026-11-${10 + i}T00:30:00Z`,
  label: `nightly-${i}`,
  scenarios: {
    "payroll-preflight": { p95_ms: p[0] },
    "payroll-run-payment": { p95_ms: p[1] },
    "leave-approval": { p95_ms: p[2] },
  },
}))

describe("FIN-036 evaluateTrend", () => {
  test("empty history passes with nothing to alert on", () => {
    const r = evaluateTrend([], { budgets })
    expect(r.verdict).toBe("pass")
  })

  test("a single sample passes (no baseline to regress against)", () => {
    const r = evaluateTrend(run([[600, 400, 300]]), { budgets })
    expect(r.verdict).toBe("pass")
  })

  test("under budget, within regression window → pass", () => {
    const hist = run([[500, 400, 300], [510, 410, 310], [520, 420, 320], [560, 460, 350]]) // last +~9-13% vs medians, all < 15%
    const r = evaluateTrend(hist, { budgets })
    expect(r.verdict).toBe("pass")
  })

  test("slow drift under the absolute budget but >15% over median → FAIL (trend alert)", () => {
    const hist = run([[500, 400, 300], [510, 400, 300], [505, 400, 300], [610, 400, 300]]) // median ~507, latest 610 = +20%
    const r = evaluateTrend(hist, { budgets })
    expect(r.verdict).toBe("fail")
    expect((r.failures ?? []).some((f) => f.includes("regressed"))).toBe(true)
    // ...but NOT an absolute breach:
    expect((r.failures ?? []).some((f) => f.includes("exceeds the 1200ms budget"))).toBe(false)
  })

  test("absolute breach over the scenario budget → FAIL", () => {
    const hist = run([[500, 400, 300], [510, 400, 300], [505, 400, 300], [1300, 400, 300]])
    const r = evaluateTrend(hist, { budgets })
    expect(r.verdict).toBe("fail")
    expect((r.failures ?? []).some((f) => f.includes("exceeds the 1200ms budget"))).toBe(true)
  })

  test("improving trend never fires (latest well under median)", () => {
    const hist = run([[500, 400, 300], [510, 400, 300], [505, 400, 300], [300, 250, 200]])
    const r = evaluateTrend(hist, { budgets })
    expect(r.verdict).toBe("pass")
  })

  test("regression window is configurable (PERF_TREND_REGRESSION_PCT)", () => {
    const hist = run([[500, 400, 300], [510, 400, 300], [505, 400, 300], [610, 400, 300]]) // +20%
    expect(evaluateTrend(hist, { budgets, regressionPct: 15 }).verdict).toBe("fail")
    expect(evaluateTrend(hist, { budgets, regressionPct: 30 }).verdict).toBe("pass")
  })

  test("minSamples guards the median (2 prior samples → n/a at default 3)", () => {
    const hist = run([[500, 400, 300], [610, 400, 300]]) // only 1 prior sample
    const r = evaluateTrend(hist, { budgets })
    expect(r.verdict).toBe("pass") // cannot judge trend on a single prior point
    expect((r.rows ?? []).find((x) => x.scenario === "payroll-preflight")?.median).toBeNull()
  })

  test("missing scenario in the latest run → FAIL (loudly, never silently)", () => {
    const hist = run([[500, 400, 300], [510, 400, 300], [505, 400, 300]])
    hist[2].scenarios["payroll-run-payment"] = undefined as any
    const r = evaluateTrend(hist, { budgets })
    expect(r.verdict).toBe("fail")
    expect((r.failures ?? []).some((f) => f.includes("no p95 recorded"))).toBe(true)
  })
})

describe("FIN-036 p95OfSummary", () => {
  test("reads http_req_duration p(95) from a k6 summary export", () => {
    expect(p95OfSummary({ metrics: { http_req_duration: { "p(95)": 412.5 } } })).toBe(412.5)
  })
  test("null on malformed summaries", () => {
    expect(p95OfSummary({})).toBeNull()
    expect(p95OfSummary({ metrics: { http_req_duration: {} } })).toBeNull()
  })
})
