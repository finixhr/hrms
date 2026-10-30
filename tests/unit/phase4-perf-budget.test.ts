/// <reference types="bun-types" />
// ============ Phase 4 WS-E — performance budgets as a CI gate (§11.1) ============
// Two hard gates, both through the PRODUCTION action handlers (the route
// registry — the same code the /api/hrm dispatcher runs):
//
//  (1) QUERY-COUNT CAPS per critical action (HRM_QUERY_COUNT=1 → tests/
//      _perf-env.ts instruments the shared db singleton; zero overhead
//      otherwise). A cap breach = a query fan-out crept back in (the exact
//      N+1 class the audit found at auth.me, employees.list and
//      attendance.summary). Counts include cold-cache first calls.
//
//  (2) p95 LATENCY BUDGETS + regression gate vs the committed baseline
//      (tests/perf-baseline.json): a build fails when an action's p95 exceeds
//      its budget OR regresses past max(baseline + 15%, baseline + 30ms).
//      Deliberate performance changes refresh the baseline:
//        HRM_PERF_BASELINE_UPDATE=1 bun test tests/unit/phase4-perf-budget.test.ts
//
// The NIGHTLY lane (HRM_PERF_PROFILE=nightly) raises the iteration counts and
// runs against the scale fixture:
//   bun run scripts/seed-scale.ts --employees 5000 --vendors 100000
//   HRM_PERF_PROFILE=nightly bun test tests/unit/phase4-perf-budget.test.ts
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import * as fs from "fs"
import * as path from "path"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, makeCtx } from "./_fixtures"
// the master router populates the registry via side-effect imports — the same
// module the production dispatcher loads
import "@/hrm-server/routes/router"
import { getRoute } from "@/hrm-server/routes/registry"
import { instrumentQueries, queryCount, resetQueryCount } from "../_perf-env"
import type { Ctx } from "@/hrm-server/types"

const NIGHTLY = process.env.HRM_PERF_PROFILE === "nightly"
const ITERATIONS = NIGHTLY ? 200 : 40
const BASELINE_FILE = path.join(import.meta.dir, "..", "perf-baseline.json")
const BASELINE_UPDATE = process.env.HRM_PERF_BASELINE_UPDATE === "1"

type Profiled = {
  action: string
  budgetMs: number
  queryCap: number
  payload?: any
  note?: string
}

// The caps mirror the audit's fan-out findings; the budgets are generous
// walls for the unit-test database (the nightly lane is where scale bites).
const PROFILED: Profiled[] = [
  {
    action: "auth.me", budgetMs: 400, queryCap: 15,
    note: "current warm shape: session+user+vendor+payload+role+photo; the audit's ≤2-reads ideal stays tracked — this cap is the fan-out tripwire",
  },
  { action: "employees.list", budgetMs: 600, queryCap: 12, payload: { page: 1, pageSize: 25 } },
  { action: "attendance.summary", budgetMs: 800, queryCap: 8, payload: { month: 7, year: 2026 } },
  { action: "payroll.runs.list", budgetMs: 400, queryCap: 8 },
]

let ctx: Ctx

async function callAction(action: string, payload: any) {
  const def = getRoute(action)
  if (!def) throw new Error(`unknown action: ${action}`)
  const parsed = def.schema ? def.schema.parse(payload ?? {}) : (payload ?? {})
  return (def.handler as any)(ctx, parsed)
}

function pct(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

beforeAll(async () => {
  const vendor = await mkVendor("P4 Perf Vendor")
  const u = await mkUser(vendor.id, { role: "HR_ADMIN", name: "Perf Admin" })
  ctx = makeCtx(u, ["*"])
  // a page of employees so the list action has real work
  for (let i = 0; i < 30; i++) await mkEmployee(vendor.id, { fullName: `Perf Emp ${i}` })
  // a run so payroll.runs.list has rows
  await db.payrollRun.create({ data: {
    vendorId: vendor.id, periodMonth: 7, periodYear: 2026, periodWeek: 0,
    frequency: "MONTHLY", runType: "REGULAR", status: "CALCULATED", adjustSeq: 0, createdBy: u.id,
  } })
  await instrumentQueries()
})

describe("Phase 4 perf budget — query-count caps (hard CI gate)", () => {
  for (const prof of PROFILED) {
    test(`${prof.action} <= ${prof.queryCap} queries per call${prof.note ? ` (${prof.note})` : ""}`, async () => {
      resetQueryCount()
      await callAction(prof.action, prof.payload)
      const n = queryCount()
      expect(n).toBeLessThanOrEqual(prof.queryCap)
    })
  }
  test("caps are measured with instrumentation actually active (non-zero count sanity)", async () => {
    resetQueryCount()
    await callAction("payroll.runs.list", undefined)
    expect(queryCount()).toBeGreaterThanOrEqual(1)
  })
})

describe("Phase 4 perf budget — p95 budgets + 15% baseline regression gate", () => {
  test("every profiled action meets its p95 budget AND stays within 15% of the baseline", async () => {
    const baseline: Record<string, number> = fs.existsSync(BASELINE_FILE)
      ? JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"))
      : {}
    const measured: Record<string, number> = {}
    const failures: string[] = []

    for (const prof of PROFILED) {
      // warmup (schema parse, plan cache, module lazy-imports)
      await callAction(prof.action, prof.payload)
      const samples: number[] = []
      for (let i = 0; i < ITERATIONS; i++) {
        const t0 = performance.now()
        await callAction(prof.action, prof.payload)
        samples.push(performance.now() - t0)
      }
      samples.sort((a, b) => a - b)
      const p95 = pct(samples, 95)
      measured[prof.action] = Math.round(p95 * 10) / 10

      if (p95 > prof.budgetMs) {
        failures.push(`${prof.action}: p95 ${p95.toFixed(1)}ms exceeds the ${prof.budgetMs}ms budget`)
      }
      if (!BASELINE_UPDATE && baseline[prof.action] != null) {
        const allowed = Math.max(baseline[prof.action] * 1.15, baseline[prof.action] + 30)
        if (p95 > allowed) {
          failures.push(`${prof.action}: p95 ${p95.toFixed(1)}ms regressed past the baseline (${baseline[prof.action]}ms +15%/+30ms = ${allowed.toFixed(1)}ms allowed) — if the change is deliberate, refresh with HRM_PERF_BASELINE_UPDATE=1`)
        }
      }
    }

    if (BASELINE_UPDATE) {
      fs.writeFileSync(BASELINE_FILE, JSON.stringify(measured, null, 2) + "\n")
      console.log(`[perf] BASELINE UPDATED ${BASELINE_FILE}`)
      return
    }
    expect(failures).toEqual([])
    console.log(`[perf] p95 (${NIGHTLY ? "nightly" : "ci"} profile, n=${ITERATIONS}): ` +
      PROFILED.map((p) => `${p.action}=${measured[p.action]}ms`).join(" · "))
  }, 120_000)
})
